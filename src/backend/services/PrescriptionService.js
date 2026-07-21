/**
 * @file PrescriptionService.js
 * @description 처방(조제)의 생성/수정/삭제/차감 트랜잭션 비즈니스 로직 전담 서비스.
 *
 * 처방은 "헤더(prescriptions) + 항목(prescription_items) + 재고 차감(CONSUME 로그)"이
 * 원자적으로 묶여야 하는 도메인입니다. 이 서비스가 소유한 핵심 규칙:
 *
 *  - 생성: 항목 삽입과 재고 차감을 하나의 트랜잭션으로 처리 (is_deducted=false면 차감 보류)
 *  - 수정: 기존 차감분을 실제 CONSUME 로그 집계 기준으로 복원 → 항목 교체 → 재차감
 *  - 삭제: 실제 CONSUME 로그 집계 기준으로 재고 복원 후 관련 레코드 일괄 삭제
 *  - 후차감: 미차감 처방을 나중에 차감 (중복 차감 방지 검사 포함)
 *
 * 복원이 처방 항목(amount)이 아닌 "실제 차감 로그" 기준인 이유:
 * 차감 후 약재의 관리 방식(계량 ↔ 유무)이 바뀌거나 항목이 수정된 경우에도
 * 실제로 빠져나간 양만 정확히 되돌리기 위함입니다.
 *
 * 원격 동기화는 모두 트랜잭션 커밋 후 비동기로 트리거되며,
 * FK 참조 순서(하위 삭제 → 헤더 → 로그 → 약재 최종 상태)를 지키는 체인으로 구성됩니다.
 */

const { newUuid } = require('../db/ids');
const { assertPositiveAmount } = require('../utils/validators');

class PrescriptionService {
  /**
   * @param {object} deps 의존성 주입
   * @param {object} deps.db better-sqlite3 원시 연결
   * @param {object} deps.time TimeService
   * @param {object} deps.sync 동기화 트리거 제공자 (SyncEngine)
   * @param {object} deps.stock StockService (차감/복원 알고리즘 공급자)
   * @param {object} deps.stockLogs StockLogRepository (CONSUME 로그 집계)
   */
  constructor({ db, time, sync, stock, stockLogs }) {
    this.db = db;
    this.time = time;
    this.sync = sync;
    this.stock = stock;
    this.stockLogs = stockLogs;
  }

  /** 시계 보정된 현재 SQLite 시간 문자열 */
  now() {
    return this.time.getAdjustedSqliteTime();
  }

  /**
   * 처방을 생성하고 (isDeducted=true면) 재고를 차감합니다.
   * @param {string|null} prescriptionName 처방명 (예: '원외탕전')
   * @param {string} patientName 환자명
   * @param {Array<{medicineId: string, amount: number}>} items 포함 약재 (1개 이상 필수)
   * @param {string} note 메모
   * @param {boolean} isDeducted 재고 즉시 차감 여부
   * @returns {string} 생성된 처방 UUID
   */
  add(prescriptionName, patientName, items, note = '', isDeducted = true) {
    if (!items || items.length === 0) {
      throw new Error('처방전에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      assertPositiveAmount(item.amount, '약재 소모량');
    }

    const pId = newUuid();
    const logIdsToSync = [];
    const deductedVal = isDeducted ? 1 : 0;

    const transaction = this.db.transaction(() => {
      const nowTime = this.now();
      this.db.prepare(`
        INSERT INTO prescriptions (id, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pId, prescriptionName, patientName, items.length, note, deductedVal, nowTime, nowTime);

      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_items (id, prescription_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), pId, String(item.medicineId), item.amount);
        if (isDeducted) {
          const displayPrescName = prescriptionName ? `${prescriptionName} 처방` : '처방';
          const logId = this.stock.consumeStockLocally(item.medicineId, item.amount, pId, `${displayPrescName} (${patientName})`);
          if (logId) {
            logIdsToSync.push(logId);
          }
        }
      }
    });
    transaction();

    // Supabase 순차 동기화 체인 구동: 처방+항목 → 로그 → 약재 최종 상태 (FK 참조 순서)
    if (this.sync.supabase) {
      this.sync.syncPrescriptionToSupabase(pId)
        .then(() => {
          // 처방전 및 아이템 업로드 완료 후, stock_logs 순차 업로드
          const logPromises = logIdsToSync.map(logId =>
            this.sync.syncItemToSupabase('stock_logs', logId)
              .catch(err => console.error('[Supabase Sync Error] stock_logs:', err))
          );
          return Promise.all(logPromises);
        })
        .then(() => {
          // stock_logs 업로드 완료 후, 최종 medicines 업로드
          const medPromises = items.map(item =>
            this.sync.syncItemToSupabase('medicines', item.medicineId)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 동기화 전체 프로세스 오류:', err);
        });
    }

    return pId;
  }

  /**
   * 처방 정보 및 포함 약재 목록/수량을 전면 수정합니다.
   * 기존에 차감되었던 처방이면 실제 CONSUME 로그 기준으로 재고를 복원한 뒤
   * 새 항목 기준으로 재차감합니다.
   * @param {string} prescriptionId 처방 UUID
   * @param {string|null} prescriptionName 처방명
   * @param {string} patientName 환자명
   * @param {Array<{medicineId: string, amount: number}>} items 새 약재 목록
   * @param {string} note 메모
   * @param {boolean} isDeducted 수정 후 차감 상태
   * @returns {boolean}
   */
  updateWithItems(prescriptionId, prescriptionName, patientName, items, note = '', isDeducted = true) {
    const pId = String(prescriptionId);
    if (!items || items.length === 0) {
      throw new Error('처방전에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      assertPositiveAmount(item.amount, '약재 소모량');
    }

    const presc = this.db.prepare('SELECT is_deducted FROM prescriptions WHERE id = ?').get(pId);
    const wasDeducted = presc ? presc.is_deducted === 1 : false;

    // 트랜잭션 전에 기존 상태(항목/로그/실차감량)를 확보해 둡니다 (복원 및 원격 삭제 동기화용)
    const oldItems = this.db.prepare('SELECT id, medicine_id, amount FROM prescription_items WHERE prescription_id = ?').all(pId);
    const oldLogs = this.db.prepare('SELECT id FROM stock_logs WHERE prescription_id = ?').all(pId);
    const consumedRows = wasDeducted ? this.stockLogs.getConsumedGramsByPrescription(pId) : [];

    const newLogIdsToSync = [];
    const deductedVal = isDeducted ? 1 : 0;

    this.db.transaction(() => {
      // 기존에 차감되었던 처방전인 경우, 실제 CONSUME 로그 집계 기준으로 재고 복원
      if (wasDeducted) {
        this.stock.restoreConsumedStockLocally(consumedRows);
      }

      // 삭제 이력 기록 (원격 삭제 전파용 tombstone)
      for (const oldItem of oldItems) {
        this.recordDeleted('prescription_items', oldItem.id);
      }
      for (const oldLog of oldLogs) {
        this.recordDeleted('stock_logs', oldLog.id);
      }

      // 기존 항목 삭제
      this.db.prepare('DELETE FROM prescription_items WHERE prescription_id = ?').run(pId);
      this.db.prepare('DELETE FROM stock_logs WHERE prescription_id = ?').run(pId);

      // 처방 테이블 정보 갱신
      this.db.prepare(`
        UPDATE prescriptions
        SET prescription_name = ?, patient_name = ?, total_items = ?, note = ?, is_deducted = ?, updated_at = ?
        WHERE id = ?
      `).run(prescriptionName, patientName, items.length, note, deductedVal, this.now(), pId);

      // 새 항목 삽입 및 재소모
      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_items (id, prescription_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), pId, String(item.medicineId), item.amount);
        if (isDeducted) {
          const displayPrescName = prescriptionName ? `${prescriptionName} 처방` : '처방';
          const logId = this.stock.consumeStockLocally(item.medicineId, item.amount, pId, `${displayPrescName} (${patientName})`);
          if (logId) {
            newLogIdsToSync.push(logId);
          }
        }
      }
    })();

    // Supabase 비동기 동기화 처리 (순차 제어 체인)
    if (this.sync.supabase) {
      const deleteOldPromises = [
        ...oldItems.map(oldItem =>
          this.sync.syncDeletedToSupabase('prescription_items', oldItem.id)
            .catch(err => console.error('[Supabase Sync Error] delete old prescription_items:', err))
        ),
        ...oldLogs.map(oldLog =>
          this.sync.syncDeletedToSupabase('stock_logs', oldLog.id)
            .catch(err => console.error('[Supabase Sync Error] delete old stock_logs:', err))
        )
      ];

      Promise.all(deleteOldPromises)
        .then(() => this.sync.syncPrescriptionToSupabase(pId))
        .then(() => {
          const logPromises = newLogIdsToSync.map(logId =>
            this.sync.syncItemToSupabase('stock_logs', logId)
              .catch(err => console.error('[Supabase Sync Error] stock_logs:', err))
          );
          return Promise.all(logPromises);
        })
        .then(() => {
          // 복원/재차감으로 상태가 바뀐 모든 약재(기존+신규)의 최종 상태를 업로드
          const medIdsToSync = new Set();
          for (const oldItem of oldItems) {
            medIdsToSync.add(oldItem.medicine_id);
          }
          for (const item of items) {
            medIdsToSync.add(String(item.medicineId));
          }
          const medPromises = Array.from(medIdsToSync).map(medId =>
            this.sync.syncItemToSupabase('medicines', medId)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 업데이트 동기화 전체 프로세스 오류:', err);
        });
    }

    return true;
  }

  /**
   * 처방을 취소/삭제합니다 (재고 자동 롤백 포함).
   * 롤백은 처방 항목(amount)이 아닌 실제 CONSUME 로그(stock_logs) 집계 기준으로 수행합니다.
   * @param {string} prescriptionId 처방 UUID
   * @returns {boolean}
   */
  delete(prescriptionId) {
    const pId = String(prescriptionId);
    const items = this.db.prepare('SELECT id, medicine_id, amount FROM prescription_items WHERE prescription_id = ?').all(pId);
    const logs = this.db.prepare('SELECT id FROM stock_logs WHERE prescription_id = ?').all(pId);
    const consumedRows = this.stockLogs.getConsumedGramsByPrescription(pId);

    this.db.transaction(() => {
      this.stock.restoreConsumedStockLocally(consumedRows);

      this.recordDeleted('prescriptions', pId);
      for (const item of items) {
        this.recordDeleted('prescription_items', item.id);
      }
      for (const log of logs) {
        this.recordDeleted('stock_logs', log.id);
      }

      this.db.prepare('DELETE FROM prescription_items WHERE prescription_id = ?').run(pId);
      this.db.prepare('DELETE FROM stock_logs WHERE prescription_id = ?').run(pId);
      this.db.prepare('DELETE FROM prescriptions WHERE id = ?').run(pId);
    })();

    if (this.sync.supabase) {
      // 하위 항목들(items, logs)을 먼저 Supabase에서 삭제 동기화
      const deleteSubPromises = [
        ...items.map(item =>
          this.sync.syncDeletedToSupabase('prescription_items', item.id)
            .catch(err => console.error('[Supabase Sync Error] delete prescription_items:', err))
        ),
        ...logs.map(log =>
          this.sync.syncDeletedToSupabase('stock_logs', log.id)
            .catch(err => console.error('[Supabase Sync Error] delete stock_logs:', err))
        )
      ];

      Promise.all(deleteSubPromises)
        .then(() => {
          // 하위 항목 삭제 완료 후, 처방전 자체 삭제 동기화 진행
          return this.sync.syncDeletedToSupabase('prescriptions', pId)
            .catch(err => console.error('[Supabase Sync Error] delete prescriptions:', err));
        })
        .then(() => {
          // 원격 삭제가 완료된 후, 복원된 최종 medicines 상태를 로컬 정보로 업로드
          const medPromises = items.map(item =>
            this.sync.syncItemToSupabase('medicines', item.medicine_id)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 삭제 동기화 전체 프로세스 오류:', err);
        });
    }

    return true;
  }

  /**
   * 미차감 처방의 재고를 나중에 차감합니다. 이미 차감된 처방은 거부됩니다.
   * @param {string} prescriptionId 처방 UUID
   * @returns {boolean}
   */
  deductStock(prescriptionId) {
    const pId = String(prescriptionId);
    const presc = this.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(pId);
    if (!presc) {
      throw new Error('해당 처방전을 찾을 수 없습니다.');
    }
    if (presc.is_deducted === 1) {
      throw new Error('이미 재고가 차감된 처방전입니다.');
    }

    const items = this.db.prepare('SELECT * FROM prescription_items WHERE prescription_id = ?').all(pId);
    const logIdsToSync = [];

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE prescriptions
        SET is_deducted = 1, updated_at = ?
        WHERE id = ?
      `).run(this.now(), pId);

      for (const item of items) {
        const displayPrescName = presc.prescription_name ? `${presc.prescription_name} 처방` : '처방';
        const logId = this.stock.consumeStockLocally(item.medicine_id, item.amount, pId, `${displayPrescName} (${presc.patient_name})`);
        if (logId) {
          logIdsToSync.push(logId);
        }
      }
    });
    transaction();

    // Supabase 동기화 (처방 → 로그 → 약재 순서)
    if (this.sync.supabase) {
      this.sync.syncPrescriptionToSupabase(pId)
        .then(() => {
          const logPromises = logIdsToSync.map(logId =>
            this.sync.syncItemToSupabase('stock_logs', logId)
              .catch(err => console.error('[Supabase Sync Error] stock_logs:', err))
          );
          return Promise.all(logPromises);
        })
        .then(() => {
          const medPromises = items.map(item =>
            this.sync.syncItemToSupabase('medicines', item.medicine_id)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 재고차감 동기화 실패:', err);
        });
    }

    return true;
  }

  /**
   * 삭제된 레코드 ID를 tombstone 테이블에 기록합니다.
   * (BaseRepository와 동일한 규약 — 서비스 계층에서도 삭제 시 필수 호출)
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   */
  recordDeleted(table, id) {
    try {
      this.db.prepare('INSERT OR IGNORE INTO deleted_records (table_name, record_id) VALUES (?, ?)').run(table, String(id));
    } catch (e) {
      console.error('삭제 이력 기록 실패:', e);
    }
  }
}

module.exports = PrescriptionService;
