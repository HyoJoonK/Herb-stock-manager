/**
 * @file NotificationRepository.js
 * @description notifications(알림함) 테이블 CRUD 전담 Repository.
 *
 * 알림은 로컬 전용 데이터입니다 (Supabase 동기화 대상이 아니므로 정수 ID를 유지).
 * 현재 알림 발생원: 소모 중 새 팩 개봉 안내 (StockService가 add()를 호출)
 */

const BaseRepository = require('./BaseRepository');

class NotificationRepository extends BaseRepository {
  /**
   * 알림을 추가합니다. 알림 실패가 본 작업(재고 차감 등)을 막으면 안 되므로
   * 예외를 삼키고 콘솔에만 기록합니다.
   * @param {string} medicineId 관련 약재 UUID
   * @param {string} medicineName 약재명 (알림 목록 표시용 비정규화 컬럼)
   * @param {string} message 알림 본문
   */
  add(medicineId, medicineName, message) {
    try {
      this.db.prepare(`
        INSERT INTO notifications (medicine_id, medicine_name, message, is_read, created_at)
        VALUES (?, ?, ?, 0, ?)
      `).run(String(medicineId), medicineName, message, this.now());
    } catch (err) {
      console.error('[Notification Insert Error]', err);
    }
  }

  /**
   * 전체 알림을 최신순으로 반환합니다.
   * @returns {Array<object>}
   */
  getAll() {
    return this.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC, id DESC').all();
  }

  /**
   * 알림을 읽음 상태로 표시합니다.
   * @param {number} id 알림 ID (정수)
   * @returns {boolean}
   */
  markAsRead(id) {
    this.db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(id);
    return true;
  }

  /**
   * 알림을 삭제합니다.
   * @param {number} id 알림 ID (정수)
   * @returns {boolean}
   */
  delete(id) {
    this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
    return true;
  }
}

module.exports = NotificationRepository;
