/**
 * @file StockLogRepository.js
 * @description stock_logs(재고 변동 이력) 테이블의 조회 전담 Repository.
 *
 * 로그 유형: 'IN'(입고) / 'CONSUME'(처방 소모) / 'WASTE'(폐기) / 'ADJUST'(수동 보정)
 * 이 테이블은 SmartPredictor의 소모량 분석 원천 데이터이기도 합니다.
 * 로그의 생성(입고/소모/폐기)은 재고 수량 변경과 원자적으로 묶여야 하므로
 * services/StockService.js가 담당합니다.
 */

const BaseRepository = require('./BaseRepository');

class StockLogRepository extends BaseRepository {
  /**
   * 특정 약재의 재고 변동 이력을 최신순으로 반환합니다.
   * @param {string} medicineId 약재 UUID
   * @returns {Array<object>}
   */
  getByMedicine(medicineId) {
    return this.db.prepare(`
      SELECT l.*, m.name as medicine_name
      FROM stock_logs l
      JOIN medicines m ON l.medicine_id = m.id
      WHERE l.medicine_id = ?
      ORDER BY l.timestamp DESC, l.rowid DESC
    `).all(String(medicineId));
  }

  /**
   * 전체 재고 변동 이력을 최신순으로 반환합니다.
   * @returns {Array<object>}
   */
  getAll() {
    return this.db.prepare(`
      SELECT l.*, m.name as medicine_name
      FROM stock_logs l
      JOIN medicines m ON l.medicine_id = m.id
      ORDER BY l.timestamp DESC, l.rowid DESC
    `).all();
  }

  /**
   * 특정 처방전이 실제로 차감했던 약재별 소모량을 집계합니다.
   * 처방 항목(amount)이 아닌 실제 차감 로그(CONSUME)를 기준으로 집계해야
   * 소모 이후의 항목 수정/관리 방식 전환에도 정확한 복원이 보장됩니다.
   * (CONSUME 로그의 quantity는 음수이므로 -quantity 합산 = 실제 소모 g수)
   * @param {string} prescriptionId 처방 UUID
   * @returns {Array<{medicine_id: string, grams: number}>}
   */
  getConsumedGramsByPrescription(prescriptionId) {
    return this.db.prepare(`
      SELECT medicine_id, SUM(-quantity) AS grams
      FROM stock_logs
      WHERE prescription_id = ? AND type = 'CONSUME'
      GROUP BY medicine_id
    `).all(String(prescriptionId));
  }
}

module.exports = StockLogRepository;
