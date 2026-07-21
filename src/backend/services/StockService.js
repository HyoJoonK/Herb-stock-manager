/**
 * @file StockService.js
 * @description 재고 증감 비즈니스 로직 전담 서비스.
 *
 * 이 서비스가 소유한 핵심 규칙:
 *  - 소모(consume): 개봉 팩 잔량 → 부족하면 미개봉 팩을 자동 개봉하는 차감 알고리즘.
 *    새 팩 개봉 시 사용자에게 잔량 재확인 알림을 적재합니다.
 *  - 입고(IN): 입고량을 팩 규격으로 나눠 팩 수/잔량에 분배하고, 잔량이 규격을 넘으면 팩으로 승격.
 *  - 폐기(WASTE): 소모와 동일한 차감 알고리즘을 사용하되 로그 유형만 다릅니다.
 *  - 복원(restore): 처방 취소/수정 시 실제 CONSUME 로그 집계 기준으로 재고를 되돌립니다.
 *
 * 트랜잭션 규약: 이름이 *Locally로 끝나는 메서드는 트랜잭션을 시작하지 않는 순수 로컬
 * 연산으로, 상위 호출자(PrescriptionService 등)의 트랜잭션 안에서 사용됩니다.
 * (better-sqlite3는 중첩 트랜잭션을 지원하지 않으므로 이 구분이 필수입니다)
 */

const { newUuid } = require('../db/ids');
const { assertPositiveAmount } = require('../utils/validators');

class StockService {
  /**
   * @param {object} deps 의존성 주입
   * @param {object} deps.db better-sqlite3 원시 연결
   * @param {object} deps.time TimeService
   * @param {object} deps.sync 동기화 트리거 제공자 (SyncEngine)
   * @param {object} deps.medicines MedicineRepository
   * @param {object} deps.notifications NotificationRepository
   */
  constructor({ db, time, sync, medicines, notifications }) {
    this.db = db;
    this.time = time;
    this.sync = sync;
    this.medicines = medicines;
    this.notifications = notifications;
  }

  /** 시계 보정된 현재 SQLite 시간 문자열 */
  now() {
    return this.time.getAdjustedSqliteTime();
  }

  /**
   * 트랜잭션을 시작하지 않는 순수 로컬 SQLite 차감 메서드 (중첩 트랜잭션 방지용).
   *
   * 차감 알고리즘:
   *  1) 개봉 팩 잔량으로 충당 가능하면 잔량만 차감
   *  2) 부족하면 잔량을 모두 소진하고, 부족분을 채울 만큼 미개봉 팩을 개봉
   *     → 이때 새 팩 개봉 알림을 적재 (실제 잔량 재확인 유도)
   *  3) 단순 유무 관리 약재는 재고를 차감하지 않되, 처방 내역 추적을 위해
   *     변동량 0의 CONSUME 로그는 남깁니다.
   *
   * @param {string} medicineId 약재 UUID
   * @param {number} consumeGrams 소모량 (양수)
   * @param {string|null} prescriptionId 연관 처방 UUID (처방 소모가 아니면 null)
   * @param {string} note 로그 메모
   * @returns {string|null} 생성된 stock_logs 레코드의 UUID
   */
  consumeStockLocally(medicineId, consumeGrams, prescriptionId = null, note = '') {
    const grams = assertPositiveAmount(consumeGrams, '소모량');

    const medId = String(medicineId);
    const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medId);
    if (!med) throw new Error('약재를 찾을 수 없습니다.');

    // 단순 유무 관리 약재는 처방 시 실제 재고를 차감하지는 않으나, 처방 내역 자체는 변동량 0으로 기록합니다.
    if (med.is_presence_only === 1) {
      const logId = newUuid();
      this.db.prepare(`
        INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
        VALUES (?, ?, 'CONSUME', 0, ?, ?, ?)
      `).run(logId, medId, this.now(), prescriptionId, note || '처방 소모');
      return logId;
    }

    const { unopened_packs, pack_size, opened_pack_remain } = med;
    const totalStock = (unopened_packs * pack_size) + opened_pack_remain;

    if (totalStock < grams) {
      throw new Error(`재고가 부족합니다. (필요: ${grams}g, 현재: ${totalStock}g)`);
    }

    let currentRemain = opened_pack_remain;
    let currentUnopened = unopened_packs;
    let needed = grams;

    if (currentRemain >= needed) {
      // 1단계: 개봉 잔량만으로 충당
      currentRemain -= needed;
      needed = 0;
    } else {
      // 2단계: 잔량 소진 후 미개봉 팩 개봉
      needed -= currentRemain;
      currentRemain = 0;

      const packsToOpen = Math.ceil(needed / pack_size);
      if (currentUnopened < packsToOpen) {
        // 총 재고 검사를 통과했다면 이 분기는 도달 불가 — 도달 시 DB 정합성 문제
        throw new Error('데이터 정합성 이상: 총 재고가 필요한데 팩 개수가 모자랍니다.');
      }

      currentUnopened -= packsToOpen;
      currentRemain = (packsToOpen * pack_size) - needed;
      needed = 0;

      // 새 팩 개봉 알림 적재 (알림 실패는 차감을 막지 않음 — Repository가 예외를 삼킴)
      this.notifications.add(
        medId,
        med.name,
        `${med.name} 약재의 개봉 잔량을 다 사용하고 새 팩(${packsToOpen}개)을 개봉했습니다. 새 팩을 뜯으셨다면 실제 잔량을 다시 한번 기록(보정)해보세요.`
      );
    }

    this.db.prepare(`
      UPDATE medicines
      SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ?
      WHERE id = ?
    `).run(currentUnopened, currentRemain, this.now(), medId);

    const logId = newUuid();
    this.db.prepare(`
      INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
      VALUES (?, ?, 'CONSUME', ?, ?, ?, ?)
    `).run(logId, medId, -grams, this.now(), prescriptionId, note || '처방 소모');

    return logId;
  }

  /**
   * 단건 재고 소모 (트랜잭션 + 원격 동기화 트리거 포함 공개 API).
   * @param {string} medicineId 약재 UUID
   * @param {number} consumeGrams 소모량
   * @param {string|null} prescriptionId 연관 처방 UUID
   * @param {string} note 로그 메모
   * @returns {boolean}
   */
  consumeStock(medicineId, consumeGrams, prescriptionId = null, note = '') {
    let logId = null;
    const transaction = this.db.transaction(() => {
      logId = this.consumeStockLocally(medicineId, consumeGrams, prescriptionId, note);
    });
    transaction();

    if (logId) {
      this.sync.syncItemToSupabase('stock_logs', logId).catch(err => console.error('[Supabase Sync Error] stock_logs:', err));
    }
    this.sync.syncItemToSupabase('medicines', medicineId).catch(err => console.error('[Supabase Sync Error] medicines:', err));

    return true;
  }

  /**
   * 실사(실제 보유량) 기준으로 재고를 단순 보정합니다.
   * 내부적으로 updateMedicine을 사용하므로 총량 차이는 ADJUST 로그로 자동 기록됩니다.
   * @param {string} medicineId 약재 UUID
   * @param {number} realPacks 실제 미개봉 팩 수
   * @param {number} realRemain 실제 개봉 팩 잔량
   * @returns {number} 기록된 오차(loss)
   */
  adjustStock(medicineId, realPacks, realRemain) {
    return this.medicines.update(medicineId, {
      unopened_packs: realPacks,
      opened_pack_remain: realRemain
    });
  }

  /**
   * 입고(IN)/폐기(WASTE) 로그를 기록하고 재고를 갱신합니다.
   *  - IN: 입고량을 팩 규격으로 나눠 팩/잔량에 분배. 잔량이 규격을 넘으면 팩으로 승격.
   *  - WASTE: 소모와 동일한 차감 알고리즘 적용 (로그 유형만 다름).
   * @param {string} medicineId 약재 UUID
   * @param {'IN'|'WASTE'} type 로그 유형
   * @param {number} quantity 수량 (g)
   * @param {string} note 로그 메모
   */
  addStockLog(medicineId, type, quantity, note = '') {
    const medId = String(medicineId);
    let logId = null;
    const transaction = this.db.transaction(() => {
      const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medId);
      if (!med) throw new Error('약재를 찾을 수 없습니다.');

      if (type === 'IN') {
        const inQty = assertPositiveAmount(quantity, '입고량');
        const packs = Math.floor(inQty / med.pack_size);
        const remain = inQty % med.pack_size;

        let newPacks = med.unopened_packs + packs;
        let newRemain = med.opened_pack_remain + remain;
        // 기존 잔량 + 입고 잔량이 한 팩 규격을 넘으면 팩으로 승격
        if (newRemain >= med.pack_size) {
          newPacks += 1;
          newRemain -= med.pack_size;
        }

        this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ? WHERE id = ?')
          .run(newPacks, newRemain, this.now(), medId);

        logId = newUuid();
        this.db.prepare('INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, note) VALUES (?, ?, ?, ?, ?, ?)')
          .run(logId, medId, type, inQty, this.now(), note);
      } else if (type === 'WASTE') {
        logId = this.consumeStockLocally(medId, Math.abs(Number(quantity)), null, note || '재고 폐기');
      } else {
        throw new Error(`지원하지 않는 재고 로그 유형입니다: ${type}`);
      }
    });
    transaction();

    if (logId) {
      this.sync.syncItemToSupabase('stock_logs', logId).catch(err => console.error('[Supabase Sync Error] stock_logs:', err));
    }
    this.sync.syncItemToSupabase('medicines', medId).catch(err => console.error('[Supabase Sync Error] medicines:', err));
  }

  /**
   * 소모 로그 집계를 바탕으로 약재 재고를 복원합니다. (트랜잭션 내부 사용 전용)
   * 단순 유무 관리 약재(현재 기준)와 소모량 0(차감 없던 항목)은 복원하지 않습니다.
   * 복원으로 잔량이 팩 규격을 넘으면 미개봉 팩으로 승격시킵니다.
   * @param {Array<{medicine_id: string, grams: number}>} consumedRows
   *        StockLogRepository.getConsumedGramsByPrescription()의 결과
   */
  restoreConsumedStockLocally(consumedRows) {
    for (const row of consumedRows) {
      const grams = Number(row.grams);
      if (!Number.isFinite(grams) || grams <= 0) continue;

      const med = this.db.prepare('SELECT unopened_packs, opened_pack_remain, pack_size, is_presence_only FROM medicines WHERE id = ?').get(row.medicine_id);
      if (!med || med.is_presence_only === 1) continue;

      let newRemain = med.opened_pack_remain + grams;
      let newPacks = med.unopened_packs;
      if (newRemain >= med.pack_size) {
        const extraPacks = Math.floor(newRemain / med.pack_size);
        newPacks += extraPacks;
        newRemain = newRemain % med.pack_size;
      }
      this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ? WHERE id = ?')
        .run(newPacks, newRemain, this.now(), row.medicine_id);
    }
  }
}

module.exports = StockService;
