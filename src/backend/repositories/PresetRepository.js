/**
 * @file PresetRepository.js
 * @description prescription_presets / prescription_preset_items 테이블 CRUD 전담 Repository.
 *
 * 프리셋은 "자주 쓰는 처방 조합"의 저장본으로, 재고에 영향을 주지 않습니다.
 * (프리셋을 불러와 실제 처방으로 저장하는 순간에만 PrescriptionService가 재고를 차감)
 *
 * 원격 동기화 특이사항: 프리셋의 하위 항목은 개별 upsert가 아니라
 * REPLACE_PRESET_ITEMS 액션(전체 삭제 후 재삽입)으로 통째로 교체됩니다.
 * → sync.syncPresetToSupabase()가 UPSERT + REPLACE 두 작업을 큐에 등록합니다.
 */

const BaseRepository = require('./BaseRepository');
const { newUuid } = require('../db/ids');
const { assertPositiveAmount } = require('../utils/validators');

class PresetRepository extends BaseRepository {
  /**
   * 전체 프리셋 목록(항목 수 포함)을 최신순으로 반환합니다.
   * @returns {Array<object>}
   */
  getAll() {
    return this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM prescription_preset_items ppi WHERE ppi.preset_id = p.id) as total_items
      FROM prescription_presets p
      ORDER BY p.created_at DESC, p.rowid DESC
    `).all();
  }

  /**
   * 프리셋 헤더와 포함 약재 목록(약재명/단위 조인)을 함께 반환합니다.
   * @param {string} presetId 프리셋 UUID
   * @returns {object} 프리셋 상세 ({...헤더, items: [...]})
   */
  getDetails(presetId) {
    const prId = String(presetId);
    const preset = this.db.prepare('SELECT * FROM prescription_presets WHERE id = ?').get(prId);
    if (!preset) throw new Error('처방 프리셋 정보를 찾을 수 없습니다.');

    const items = this.db.prepare(`
      SELECT ppi.medicine_id, ppi.amount, m.name as medicine_name, m.unit
      FROM prescription_preset_items ppi
      JOIN medicines m ON ppi.medicine_id = m.id
      WHERE ppi.preset_id = ?
    `).all(prId);

    return {
      ...preset,
      items
    };
  }

  /**
   * 프리셋을 생성합니다.
   * @param {string} presetName 프리셋 이름 (필수)
   * @param {string} note 메모
   * @param {Array<{medicineId: string, amount: number}>} items 포함 약재 (1개 이상 필수)
   * @returns {string} 생성된 프리셋 UUID
   */
  add(presetName, note, items) {
    if (!presetName || presetName.trim() === '') {
      throw new Error('프리셋 이름을 입력해 주세요.');
    }
    if (!items || items.length === 0) {
      throw new Error('프리셋에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      assertPositiveAmount(item.amount, '약재 소모량');
    }

    const presetId = newUuid();
    this.db.transaction(() => {
      const nowTime = this.now();
      this.db.prepare(`
        INSERT INTO prescription_presets (id, preset_name, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(presetId, presetName.trim(), note || '', nowTime, nowTime);

      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_preset_items (id, preset_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), presetId, String(item.medicineId), item.amount);
      }
    })();

    if (this.sync.supabase) {
      this.sync.syncPresetToSupabase(presetId).catch(err => console.error('[Supabase Sync Error] addPreset sync:', err));
    }

    return presetId;
  }

  /**
   * 프리셋을 수정합니다. 하위 항목은 전량 삭제 후 재삽입 방식으로 교체합니다.
   * @param {string} presetId 프리셋 UUID
   * @param {string} presetName 새 이름
   * @param {string} note 새 메모
   * @param {Array<{medicineId: string, amount: number}>} items 새 약재 목록
   * @returns {string} 프리셋 UUID
   */
  update(presetId, presetName, note, items) {
    const prId = String(presetId);
    if (!presetName || presetName.trim() === '') {
      throw new Error('프리셋 이름을 입력해 주세요.');
    }
    if (!items || items.length === 0) {
      throw new Error('프리셋에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      assertPositiveAmount(item.amount, '약재 소모량');
    }

    this.db.transaction(() => {
      const nowTime = this.now();
      // 1. prescription_presets 헤더 업데이트
      this.db.prepare(`
        UPDATE prescription_presets
        SET preset_name = ?, note = ?, updated_at = ?
        WHERE id = ?
      `).run(presetName.trim(), note || '', nowTime, prId);

      // 2. 기존 prescription_preset_items 전량 삭제
      this.db.prepare('DELETE FROM prescription_preset_items WHERE preset_id = ?').run(prId);

      // 3. 신규 prescription_preset_items 삽입
      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_preset_items (id, preset_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), prId, String(item.medicineId), item.amount);
      }
    })();

    if (this.sync.supabase) {
      this.sync.syncPresetToSupabase(prId).catch(err => console.error('[Supabase Sync Error] updatePreset sync:', err));
    }

    return prId;
  }

  /**
   * 프리셋을 삭제합니다. 하위 항목은 FK ON DELETE CASCADE로 자동 삭제됩니다.
   * @param {string} presetId 프리셋 UUID
   * @returns {boolean}
   */
  delete(presetId) {
    const prId = String(presetId);
    this.db.transaction(() => {
      this.recordDeleted('prescription_presets', prId);
      // 외래 키 ON DELETE CASCADE 제약에 의해 prescription_preset_items는 자동 삭제됨
      this.db.prepare('DELETE FROM prescription_presets WHERE id = ?').run(prId);
    })();

    if (this.sync.supabase) {
      this.sync.syncDeletedToSupabase('prescription_presets', prId).catch(err => console.error('[Supabase Sync Error] deletePreset sync:', err));
    }
    return true;
  }
}

module.exports = PresetRepository;
