/**
 * @file BaseRepository.js
 * @description 모든 Repository의 공통 기반 클래스.
 *
 * Repository 계층의 규약:
 *  - 각 Repository는 담당 테이블에 대한 CRUD(SQL)만 소유합니다.
 *    비즈니스 규칙(재고 차감 연쇄, 처방 롤백 등)은 services/ 계층의 책임입니다.
 *  - 타임스탬프는 반드시 this.now()(시계 보정된 시간)로 기록합니다.
 *  - 동기화 대상 레코드를 삭제할 때는 this.recordDeleted()로 tombstone을 남기고,
 *    this.sync.syncDeletedToSupabase()를 호출해 원격 삭제를 큐에 등록해야 합니다.
 *
 * 의존성 주입(ctx) 구조:
 *  - db:   better-sqlite3 원시 연결 (동기 API)
 *  - time: TimeService 인스턴스 (시계 보정)
 *  - sync: 동기화 트리거 제공자. syncItemToSupabase / syncDeletedToSupabase /
 *          syncPrescriptionToSupabase / syncPresetToSupabase / enqueueSync / syncAll
 *          메서드와 supabase(연결 상태) 프로퍼티를 제공합니다.
 *          (실체는 SyncEngine이며, 생성 순서상 InventoryManager가 주입합니다)
 */

class BaseRepository {
  /**
   * @param {{db: object, time: object, sync: object}} ctx 공유 의존성 컨텍스트
   */
  constructor(ctx) {
    /** better-sqlite3 원시 연결 핸들 */
    this.db = ctx.db;
    /** TimeService — 시계 보정된 타임스탬프 공급자 */
    this.time = ctx.time;
    /** 동기화 트리거 제공자 (SyncEngine 또는 이를 위임하는 객체) */
    this.sync = ctx.sync;
  }

  /**
   * 시계 보정된 현재 시간(SQLite 'YYYY-MM-DD HH:mm:ss' UTC 포맷)을 반환합니다.
   * updated_at/timestamp 기록 시 항상 이 값을 사용하세요.
   * @returns {string}
   */
  now() {
    return this.time.getAdjustedSqliteTime();
  }

  /**
   * 로컬에서 삭제된 레코드 ID를 deleted_records(tombstone) 테이블에 기록합니다.
   * Supabase 동기화 시 원격에도 삭제를 전파하기 위한 필수 절차입니다.
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

  /**
   * 특정 레코드의 updated_at을 시계 보정된 현재 시간으로 갱신합니다.
   * (LWW 동기화 판정용 타임스탬프 터치 헬퍼)
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   */
  touch(table, id) {
    try {
      this.db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(this.now(), id);
    } catch (e) {
      console.error(`${table}의 updated_at 갱신 실패:`, e);
    }
  }
}

module.exports = BaseRepository;
