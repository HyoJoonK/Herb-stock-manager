/**
 * @file MedicineRepository.js
 * @description medicines / medicine_aliases 테이블 CRUD 전담 Repository.
 *
 * 재고 표현 방식: 총 재고 = (미개봉 팩 수 × 팩 규격) + 개봉 팩 잔량
 * is_presence_only=1 약재는 계량 없이 '있음/없음'(unopened_packs 1/0)만 관리합니다.
 *
 * updateMedicine의 오차(loss) 기록: 수량/규격을 수동 변경하면 변경 전후 총량 차이가
 * ADJUST 유형의 stock_logs로 자동 기록됩니다. (재고 실사 보정 이력 추적용)
 */

const BaseRepository = require('./BaseRepository');
const { DEFAULT_CATEGORY_ID, newUuid } = require('../db/ids');

class MedicineRepository extends BaseRepository {
  /**
   * 약재 데이터를 바탕으로 총 재고량 및 출력용 문자열을 계산하는 인메모리 헬퍼.
   * DB 접근 없이 순수 계산만 수행합니다.
   * @param {object} med 약재 행 객체
   * @returns {{totalStock: number, formatted: string}}
   */
  calculateStockInfo(med) {
    const { unopened_packs, pack_size, opened_pack_remain, unit, is_presence_only } = med;

    // 단순 유무 관리 약재: 팩 수 1 이상이면 '있음'으로 간주하고 팩 규격을 명목 재고로 사용
    if (is_presence_only === 1) {
      const totalStock = unopened_packs > 0 ? pack_size : 0;
      const formatted = unopened_packs > 0 ? '재고 있음' : '재고 없음';
      return {
        totalStock,
        formatted
      };
    }

    const totalStock = (unopened_packs * pack_size) + opened_pack_remain;
    const comma = (num) => Math.round(num * 100) / 100;

    let formatted = `총 ${comma(totalStock)}${unit}`;
    if (unopened_packs > 0 || opened_pack_remain > 0) {
      formatted += ` (${unopened_packs}봉지 + ${comma(opened_pack_remain)}${unit} 남음)`;
    } else {
      formatted += ` (재고 없음)`;
    }

    return {
      totalStock,
      formatted
    };
  }

  /**
   * 단일 약재의 재고 상세 정보(별칭 포함)를 조회합니다.
   * @param {string} medicineId 약재 UUID
   * @returns {object} 재고/규격/카테고리/별칭이 합쳐진 상세 정보
   */
  getTotalStock(medicineId) {
    const med = this.db.prepare(`
      SELECT m.*, c.name as category_name
      FROM medicines m
      LEFT JOIN categories c ON m.category_id = c.id
      WHERE m.id = ?
    `).get(String(medicineId));

    if (!med) {
      throw new Error(`약재 ID ${medicineId}를 찾을 수 없습니다.`);
    }

    const stockInfo = this.calculateStockInfo(med);
    const aliases = this.db.prepare('SELECT alias FROM medicine_aliases WHERE medicine_id = ?').all(med.id).map(row => row.alias);

    return {
      totalStock: stockInfo.totalStock,
      formatted: stockInfo.formatted,
      unopened_packs: med.unopened_packs,
      opened_pack_remain: med.opened_pack_remain,
      pack_size: med.pack_size,
      unit: med.unit,
      name: med.name,
      category_id: med.category_id,
      categoryName: med.category_name || '미분류',
      safety_stock: med.safety_stock,
      aliases,
      memo: med.memo,
      is_presence_only: med.is_presence_only
    };
  }

  /**
   * 약재를 등록합니다. 별칭이 함께 주어지면 트랜잭션으로 일괄 삽입합니다.
   * 별칭은 (1) 기존 약재명과 (2) 다른 약재의 별칭과 중복될 수 없습니다.
   * @param {object} data 약재 필드 (name, pack_size 필수)
   * @returns {string} 생성된 약재 UUID
   */
  add(data) {
    const { name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, aliases, memo, is_presence_only } = data;
    if (!name || !pack_size || pack_size <= 0) {
      throw new Error('약재명과 유효한 팩 규격은 필수입니다.');
    }

    const catId = category_id ? String(category_id) : DEFAULT_CATEGORY_ID;

    // 이명 중복 및 유효성 검사 (트랜잭션 진입 전에 미리 걸러 불필요한 롤백 방지)
    if (aliases && aliases.length > 0) {
      for (const alias of aliases) {
        const cleanAlias = alias.trim();
        if (!cleanAlias) continue;

        // 1. 기존 약재 이름과 중복되는지 검사
        const dupName = this.db.prepare('SELECT id FROM medicines WHERE name = ?').get(cleanAlias);
        if (dupName) {
          throw new Error(`별칭 "${cleanAlias}"은(는) 이미 존재하는 약재명입니다.`);
        }
        // 2. 기존 다른 약재의 이명과 중복되는지 검사
        const dupAlias = this.db.prepare('SELECT id FROM medicine_aliases WHERE alias = ?').get(cleanAlias);
        if (dupAlias) {
          throw new Error(`별칭 "${cleanAlias}"은(는) 이미 다른 약재의 별칭으로 사용 중입니다.`);
        }
      }
    }

    const newId = newUuid();
    const insertedAliasIds = [];

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO medicines (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId,
        name,
        catId,
        Number(pack_size),
        Number(unopened_packs || 0),
        Number(opened_pack_remain || 0),
        Number(safety_stock || 0),
        unit || 'g',
        memo || null,
        Number(is_presence_only || 0),
        this.now()
      );

      if (aliases && aliases.length > 0) {
        const aliasStmt = this.db.prepare(`
          INSERT INTO medicine_aliases (id, medicine_id, alias, updated_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const alias of aliases) {
          const cleanAlias = alias.trim();
          if (!cleanAlias) continue;
          const aliasId = newUuid();
          aliasStmt.run(aliasId, newId, cleanAlias, this.now());
          insertedAliasIds.push(aliasId);
        }
      }
    });

    try {
      transaction();

      // medicines 업로드가 완료된 후 외래 키 참조 관계에 있는 medicine_aliases를 동기화하여 에러를 방지합니다.
      this.sync.syncItemToSupabase('medicines', newId)
        .then(() => {
          for (const aliasId of insertedAliasIds) {
            this.sync.syncItemToSupabase('medicine_aliases', aliasId).catch(err => console.error('[Supabase Sync Error] medicine_aliases:', err));
          }
        })
        .catch(err => console.error('[Supabase Sync Error] medicines:', err));

      return newId;
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        throw new Error(`이미 존재하는 약재명 또는 별칭입니다.`);
      }
      throw err;
    }
  }

  /**
   * 약재 정보를 부분 수정합니다. (전달된 필드만 반영)
   * 계량 관리 약재의 수량/규격이 바뀌면 총량 차이(loss)를 ADJUST 로그로 기록합니다.
   * aliases 필드가 주어지면 기존 별칭과 비교해 추가/삭제 차분만 반영합니다.
   * @param {string} medicineId 약재 UUID
   * @param {object} updateData 변경할 필드들
   * @returns {number} 기록된 재고 오차(loss, g단위). 오차가 없으면 0
   */
  update(medicineId, updateData) {
    const medId = String(medicineId);

    // 현재 값과 변경 요청 값을 병합하고 오차(loss)를 계산하는 내부 헬퍼
    const execute = (med) => {
      const name = updateData.name !== undefined ? updateData.name : med.name;
      const category_id = updateData.category_id !== undefined ? String(updateData.category_id) : med.category_id;
      const pack_size = updateData.pack_size !== undefined ? Number(updateData.pack_size) : med.pack_size;
      const unopened_packs = updateData.unopened_packs !== undefined ? Number(updateData.unopened_packs) : med.unopened_packs;
      const opened_pack_remain = updateData.opened_pack_remain !== undefined ? Number(updateData.opened_pack_remain) : med.opened_pack_remain;
      const safety_stock = updateData.safety_stock !== undefined ? Number(updateData.safety_stock) : med.safety_stock;
      const unit = updateData.unit !== undefined ? updateData.unit : med.unit;
      const memo = updateData.memo !== undefined ? updateData.memo : med.memo;
      const is_presence_only = updateData.is_presence_only !== undefined ? Number(updateData.is_presence_only) : med.is_presence_only;

      if (pack_size <= 0) throw new Error('팩 규격은 0보다 커야 합니다.');
      if (opened_pack_remain > pack_size) throw new Error('개봉 잔량은 팩 규격을 초과할 수 없습니다.');

      // 단순 유무 관리 약재는 재고 오차(loss)를 계산하지 않습니다 (오차 로그가 불필요하므로).
      // 오차는 "변경 후 총량 - 변경 전 총량"이며, 각 총량은 해당 시점의 팩 규격으로 계산합니다.
      // 팩 규격만 바꿔도 실제 총 보유량이 달라지므로 그 차이가 그대로 보정 오차로 기록됩니다.
      let loss = 0;
      if (is_presence_only === 0 && med.is_presence_only === 0) {
        const oldTotal = (med.unopened_packs * med.pack_size) + med.opened_pack_remain;
        const newTotal = (unopened_packs * pack_size) + opened_pack_remain;
        loss = Math.round((newTotal - oldTotal) * 100) / 100;
      }

      return {
        name,
        category_id,
        pack_size,
        unopened_packs,
        opened_pack_remain,
        safety_stock,
        unit,
        memo,
        is_presence_only,
        loss
      };
    };

    let loss = 0;
    let insertedLogId = null;
    const insertedAliasIds = [];
    const deletedAliasIds = [];

    const transaction = this.db.transaction(() => {
      const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medId);
      if (!med) throw new Error('약재를 찾을 수 없습니다.');

      const updated = execute(med);
      loss = updated.loss;

      this.db.prepare(`
        UPDATE medicines
        SET name = ?, category_id = ?, pack_size = ?, unopened_packs = ?, opened_pack_remain = ?, safety_stock = ?, unit = ?, memo = ?, is_presence_only = ?, updated_at = ?
        WHERE id = ?
      `).run(
        updated.name,
        updated.category_id,
        updated.pack_size,
        updated.unopened_packs,
        updated.opened_pack_remain,
        updated.safety_stock,
        updated.unit,
        updated.memo,
        updated.is_presence_only,
        this.now(),
        medId
      );

      // 오차가 있으면 수동 보정 이력을 ADJUST 로그로 남깁니다.
      if (loss !== 0) {
        insertedLogId = newUuid();
        this.db.prepare(`
          INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, note)
          VALUES (?, ?, 'ADJUST', ?, ?, ?)
        `).run(insertedLogId, medId, loss, this.now(), `수동 데이터 보정 (오차: ${loss > 0 ? '+' : ''}${loss}g)`);
      }

      // 이명(Aliases) 업데이트 로직: 기존 별칭과의 차분(추가/삭제)만 반영
      if (updateData.aliases !== undefined) {
        const oldAliases = this.db.prepare('SELECT id, alias FROM medicine_aliases WHERE medicine_id = ?').all(medId);
        const oldAliasesMap = new Map(oldAliases.map(a => [a.alias, a.id]));
        const newAliases = updateData.aliases.map(a => a.trim()).filter(Boolean);

        // 중복성 검증
        for (const alias of newAliases) {
          if (alias === updated.name) continue; // 본인 약재명과 같은 건 무시

          const dupName = this.db.prepare('SELECT id FROM medicines WHERE name = ? AND id != ?').get(alias, medId);
          if (dupName) {
            throw new Error(`별칭 "${alias}"은(는) 이미 존재하는 약재명입니다.`);
          }

          const dupAlias = this.db.prepare('SELECT id FROM medicine_aliases WHERE alias = ? AND medicine_id != ?').get(alias, medId);
          if (dupAlias) {
            throw new Error(`별칭 "${alias}"은(는) 이미 다른 약재의 별칭으로 사용 중입니다.`);
          }
        }

        const toDelete = oldAliases.filter(a => !newAliases.includes(a.alias));
        const toInsert = newAliases.filter(a => !oldAliasesMap.has(a));

        for (const a of toDelete) {
          this.recordDeleted('medicine_aliases', a.id);
          this.db.prepare('DELETE FROM medicine_aliases WHERE id = ?').run(a.id);
          deletedAliasIds.push(a.id);
        }

        const insertStmt = this.db.prepare(`
          INSERT INTO medicine_aliases (id, medicine_id, alias, updated_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const alias of toInsert) {
          const aliasId = newUuid();
          insertStmt.run(aliasId, medId, alias, this.now());
          insertedAliasIds.push(aliasId);
        }
      }
    });

    try {
      transaction();

      // medicines 업로드가 완료된 후 외래 키 참조 관계에 있는 stock_logs와 medicine_aliases를 동기화하여 에러를 방지합니다.
      this.sync.syncItemToSupabase('medicines', medId)
        .then(() => {
          if (insertedLogId) {
            this.sync.syncItemToSupabase('stock_logs', insertedLogId).catch(err => console.error('[Supabase Sync Error] stock_logs:', err));
          }
          for (const id of insertedAliasIds) {
            this.sync.syncItemToSupabase('medicine_aliases', id).catch(err => console.error('[Supabase Sync Error] medicine_aliases:', err));
          }
        })
        .catch(err => console.error('[Supabase Sync Error] medicines:', err));

      for (const id of deletedAliasIds) {
        this.sync.syncDeletedToSupabase('medicine_aliases', id).catch(err => console.error('[Supabase Sync Error] delete medicine_aliases:', err));
      }

      return loss;
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        throw new Error(`이미 존재하는 약재명 또는 별칭입니다.`);
      }
      throw err;
    }
  }

  /**
   * 약재와 그에 연결된 모든 하위 레코드(처방 항목/재고 로그/별칭/프리셋 항목)를 삭제합니다.
   * 모든 삭제는 tombstone으로 기록되며, 원격 삭제는 하위 항목 → 약재 본체 순서로
   * 동기화됩니다 (외래 키 참조 순서 보장).
   * @param {string} medicineId 약재 UUID
   * @returns {boolean} 성공 여부
   */
  delete(medicineId) {
    const medId = String(medicineId);
    // 삭제 전에 하위 레코드 ID들을 미리 확보 (원격 삭제 동기화용)
    const itemIds = this.db.prepare('SELECT id FROM prescription_items WHERE medicine_id = ?').all(medId).map(row => row.id);
    const logIds = this.db.prepare('SELECT id FROM stock_logs WHERE medicine_id = ?').all(medId).map(row => row.id);
    const aliasIds = this.db.prepare('SELECT id FROM medicine_aliases WHERE medicine_id = ?').all(medId).map(row => row.id);
    const presetItemIds = this.db.prepare('SELECT id FROM prescription_preset_items WHERE medicine_id = ?').all(medId).map(row => row.id);

    this.db.transaction(() => {
      for (const itemId of itemIds) {
        this.recordDeleted('prescription_items', itemId);
      }
      for (const logId of logIds) {
        this.recordDeleted('stock_logs', logId);
      }
      for (const aliasId of aliasIds) {
        this.recordDeleted('medicine_aliases', aliasId);
      }
      for (const presetItemId of presetItemIds) {
        this.recordDeleted('prescription_preset_items', presetItemId);
      }
      this.recordDeleted('medicines', medId);

      this.db.prepare('DELETE FROM prescription_items WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM stock_logs WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM medicine_aliases WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM prescription_preset_items WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
    })();

    // 하위 항목의 원격 삭제를 먼저 등록한 뒤 약재 본체 삭제를 등록 (FK 참조 순서)
    const deleteSubPromises = [
      ...itemIds.map(itemId =>
        this.sync.syncDeletedToSupabase('prescription_items', itemId)
          .catch(err => console.error('[Supabase Sync Error] delete prescription_items:', err))
      ),
      ...logIds.map(logId =>
        this.sync.syncDeletedToSupabase('stock_logs', logId)
          .catch(err => console.error('[Supabase Sync Error] delete stock_logs:', err))
      ),
      ...aliasIds.map(aliasId =>
        this.sync.syncDeletedToSupabase('medicine_aliases', aliasId)
          .catch(err => console.error('[Supabase Sync Error] delete medicine_aliases:', err))
      ),
      ...presetItemIds.map(presetItemId =>
        this.sync.syncDeletedToSupabase('prescription_preset_items', presetItemId)
          .catch(err => console.error('[Supabase Sync Error] delete prescription_preset_items:', err))
      )
    ];

    Promise.all(deleteSubPromises)
      .then(() => {
        this.sync.syncDeletedToSupabase('medicines', medId)
          .catch(err => console.error('[Supabase Sync Error] delete medicines:', err));
      });

    return true;
  }

  /**
   * 전체 약재 목록을 카테고리명/별칭/계산된 재고 정보와 함께 반환합니다.
   * @returns {Array<object>}
   */
  getAll() {
    const list = this.db.prepare(`
      SELECT m.*, c.name as category_name, GROUP_CONCAT(a.alias, ',') as aliases_str
      FROM medicines m
      LEFT JOIN categories c ON m.category_id = c.id
      LEFT JOIN medicine_aliases a ON m.id = a.medicine_id
      GROUP BY m.id
      ORDER BY m.name ASC
    `).all();
    return list.map(m => {
      const stockInfo = this.calculateStockInfo(m);
      return {
        ...m,
        total_stock: stockInfo.totalStock,
        formatted_stock: stockInfo.formatted,
        category_name: m.category_name || '미분류',
        aliases: m.aliases_str ? m.aliases_str.split(',') : []
      };
    });
  }
}

module.exports = MedicineRepository;
