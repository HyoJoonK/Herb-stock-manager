/**
 * @file CategoryRepository.js
 * @description categories 테이블 CRUD 전담 Repository.
 *
 * 불변 규칙: 기본 카테고리('미분류', DEFAULT_CATEGORY_ID)는 수정/삭제할 수 없습니다.
 * 카테고리 삭제 시 소속 약재들은 기본 카테고리로 재배정됩니다.
 */

const BaseRepository = require('./BaseRepository');
const { DEFAULT_CATEGORY_ID, newUuid } = require('../db/ids');

class CategoryRepository extends BaseRepository {
  /**
   * 카테고리를 추가합니다. 같은 이름이 이미 있으면 기존 카테고리의 ID를 반환합니다(멱등).
   * @param {string} name 카테고리명
   * @returns {string} 카테고리 UUID
   */
  add(name) {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('카테고리명은 비어둘 수 없습니다.');

    const exists = this.db.prepare('SELECT id FROM categories WHERE name = ?').get(cleanName);
    if (exists) return exists.id;

    const newId = newUuid();
    this.db.prepare('INSERT INTO categories (id, name, updated_at) VALUES (?, ?, ?)')
      .run(newId, cleanName, this.now());

    this.sync.syncItemToSupabase('categories', newId).catch(err => console.error('[Supabase Sync Error] categories:', err));

    return newId;
  }

  /**
   * 카테고리명을 변경합니다. 기본 카테고리와 중복 이름은 거부됩니다.
   * @param {string} categoryId 카테고리 UUID
   * @param {string} name 새 카테고리명
   */
  update(categoryId, name) {
    const catId = String(categoryId);
    if (catId === DEFAULT_CATEGORY_ID) throw new Error('기본 카테고리는 수정할 수 없습니다.');

    const cleanName = name.trim();
    if (!cleanName) throw new Error('카테고리명은 비어둘 수 없습니다.');

    const exists = this.db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(cleanName, catId);
    if (exists) throw new Error('이미 존재하는 카테고리명입니다.');

    this.db.prepare('UPDATE categories SET name = ?, updated_at = ? WHERE id = ?').run(cleanName, this.now(), catId);

    this.sync.syncItemToSupabase('categories', catId).catch(err => console.error('[Supabase Sync Error] update categories:', err));
  }

  /**
   * 카테고리를 삭제하고 소속 약재를 기본 카테고리('미분류')로 재배정합니다.
   * 삭제는 tombstone 기록 후 원격 삭제 동기화가 큐에 등록되며,
   * 재배정된 약재들도 개별 업로드 대상으로 등록됩니다.
   * @param {string} categoryId 카테고리 UUID
   */
  delete(categoryId) {
    const catId = String(categoryId);
    if (catId === DEFAULT_CATEGORY_ID) throw new Error('기본 카테고리는 삭제할 수 없습니다.');

    // 재배정 대상 약재 ID를 삭제 전에 확보해 둡니다 (동기화 트리거용)
    const medicineIds = this.db.prepare('SELECT id FROM medicines WHERE category_id = ?').all(catId).map(row => row.id);

    this.db.transaction(() => {
      this.recordDeleted('categories', catId);
      this.db.prepare('DELETE FROM categories WHERE id = ?').run(catId);
      this.db.prepare('UPDATE medicines SET category_id = ?, updated_at = ? WHERE category_id = ?')
        .run(DEFAULT_CATEGORY_ID, this.now(), catId);
    })();

    this.sync.syncDeletedToSupabase('categories', catId).catch(err => console.error('[Supabase Sync Error] delete categories:', err));

    for (const medId of medicineIds) {
      this.sync.syncItemToSupabase('medicines', medId).catch(err => console.error('[Supabase Sync Error] update medicines after category delete:', err));
    }
  }

  /**
   * 전체 카테고리 목록을 반환합니다. 기본 카테고리가 항상 첫 번째로 정렬됩니다.
   * @returns {Array<object>}
   */
  getAll() {
    return this.db.prepare(`
      SELECT * FROM categories
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, name ASC
    `).all(DEFAULT_CATEGORY_ID);
  }
}

module.exports = CategoryRepository;
