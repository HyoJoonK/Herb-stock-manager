/**
 * @file PrescriptionRepository.js
 * @description prescriptions / prescription_items 테이블의 조회 전담 Repository.
 *
 * 처방의 생성/수정/삭제/차감은 재고 연산과 얽혀 있으므로
 * services/PrescriptionService.js가 담당합니다. 이 Repository는 읽기 전용 조회만 제공합니다.
 */

const BaseRepository = require('./BaseRepository');

class PrescriptionRepository extends BaseRepository {
  /**
   * 처방 헤더와 포함 약재 목록(약재명/단위 조인)을 함께 반환합니다.
   * @param {string} prescriptionId 처방 UUID
   * @returns {object} 처방 상세 ({...헤더, items: [...]})
   */
  getDetails(prescriptionId) {
    const pId = String(prescriptionId);
    const prescription = this.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(pId);
    if (!prescription) throw new Error('처방전 정보를 찾을 수 없습니다.');

    const items = this.db.prepare(`
      SELECT pi.medicine_id, pi.amount, m.name as medicine_name, m.unit
      FROM prescription_items pi
      JOIN medicines m ON pi.medicine_id = m.id
      WHERE pi.prescription_id = ?
    `).all(pId);

    return {
      ...prescription,
      items
    };
  }

  /**
   * 전체 처방 목록을 최신순으로 반환합니다.
   * @returns {Array<object>}
   */
  getAll() {
    return this.db.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC, rowid DESC').all();
  }

  /**
   * 최근 처방 N건만 조회합니다. (불러오기 모달 등 전체 로드가 불필요한 화면용)
   * @param {number} limit 최대 건수
   * @returns {Array<object>}
   */
  getRecent(limit = 5) {
    return this.db.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
  }

  /**
   * 처방을 검색합니다. 검색 대상: 처방명/환자명/메모/포함 약재명.
   * @param {string} query 검색어 (비어 있으면 최근/전체 목록 반환)
   * @param {number} limit 0이면 무제한, 양수면 해당 건수까지만 반환
   * @returns {Array<object>}
   */
  search(query, limit = 0) {
    if (!query || query.trim() === '') {
      return limit > 0 ? this.getRecent(limit) : this.getAll();
    }
    const likeQuery = `%${query.trim()}%`;
    const params = [likeQuery, likeQuery, likeQuery, likeQuery];
    let sql = `
      SELECT DISTINCT p.*
      FROM prescriptions p
      LEFT JOIN prescription_items pi ON p.id = pi.prescription_id
      LEFT JOIN medicines m ON pi.medicine_id = m.id
      WHERE p.prescription_name LIKE ?
         OR p.patient_name LIKE ?
         OR p.note LIKE ?
         OR m.name LIKE ?
      ORDER BY p.created_at DESC
    `;
    if (limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    return this.db.prepare(sql).all(...params);
  }
}

module.exports = PrescriptionRepository;
