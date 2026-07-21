/**
 * @file SyncQueue.js
 * @description Supabase 업로드 대기열(sync_queue 테이블) 관리 전담 클래스.
 *
 * 동작 원리 (오프라인 우선 설계):
 *  - 데이터 변경 시 즉시 네트워크 호출 대신 SQLite 큐에 작업을 등록(enqueue)합니다.
 *    → 오프라인이어도 로컬 작업이 절대 유실되지 않습니다.
 *  - process()가 큐를 순차 처리하며, 오류 유형에 따라 다르게 대응합니다:
 *      · 네트워크/서버 장애(isNetworkError): 큐를 그대로 유지하고 30초 후 재시도 예약
 *      · 데이터성 오류(FK 위반 등): retry_count 증가, MAX_SYNC_RETRIES회 도달 시
 *        sync_failures(dead-letter) 테이블로 이동해 이력을 보존 (묵살 방지)
 *  - 브라우저 online 이벤트 발생 시 SyncEngine이 process()를 자동 재호출합니다.
 *
 * 실제 업로드 실행은 executor(SyncEngine)의 Direct 메서드에 위임합니다.
 */

// 동기화 큐 항목의 비네트워크 오류 최대 재시도 횟수 (초과 시 sync_failures로 이동)
const MAX_SYNC_RETRIES = 5;

class SyncQueue {
  /**
   * @param {object} deps 의존성 주입
   * @param {object} deps.db better-sqlite3 원시 연결
   * @param {object} deps.time TimeService
   * @param {object} deps.executor 업로드 실행자 (SyncEngine).
   *        syncItemToSupabaseDirect / syncDeletedToSupabaseDirect / syncPresetItemsDirect
   *        메서드와 supabase(연결 상태) 프로퍼티를 제공해야 합니다.
   */
  constructor({ db, time, executor }) {
    this.db = db;
    this.time = time;
    this.executor = executor;

    /** 큐 처리 중복 실행 방지 플래그 */
    this.isProcessing = false;
    /** 네트워크 장애 재시도 타이머 핸들 */
    this.retryTimer = null;
  }

  /**
   * 동기화 작업을 로컬 SQLite 큐에 등록하고 즉시 처리를 트리거합니다.
   * 같은 (테이블, 레코드, 액션) 조합이 이미 있으면 등록 시간과 재시도 횟수만 갱신합니다.
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   * @param {'UPSERT'|'DELETE'|'REPLACE_PRESET_ITEMS'} action 작업 유형
   */
  enqueue(table, id, action) {
    const recId = String(id);
    try {
      this.db.prepare(`
        INSERT INTO sync_queue (table_name, record_id, action, retry_count, created_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(table_name, record_id, action)
        DO UPDATE SET created_at = excluded.created_at, retry_count = 0
      `).run(table, recId, action, this.time.getAdjustedSqliteTime());

      console.log(`[Sync Queue] 큐 등록 완료: ${action} - ${table} (ID: ${recId})`);

      this.process().catch(err => {
        console.error('[Sync Queue] 큐 실행 오류:', err);
      });
    } catch (e) {
      console.error('[Sync Queue] 큐 삽입 실패:', e);
    }
  }

  /**
   * 오류가 일시적 네트워크/서버 장애인지(재시도 가치가 있는지) 판별합니다.
   * @param {Error} err 발생한 오류
   * @returns {boolean} 네트워크성 장애면 true
   */
  isNetworkError(err) {
    if (!err) return false;
    // PostgREST가 반환하는 SQLSTATE 코드(예: 23505)는 데이터성 오류이므로 네트워크 장애가 아님
    if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return false;
    const status = typeof err.status === 'number' ? err.status : null;
    if (status !== null) {
      return status >= 500 || status === 429 || status === 408;
    }
    if (err instanceof TypeError) return true; // fetch 실패
    const msg = String(err.message || '');
    return /fetch|network|timeout|socket|abort|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg);
  }

  /**
   * SQLite 큐에 대기 중인 동기화 작업을 순차적으로 꺼내 Supabase에 업로드합니다.
   * (오류 대응 정책은 파일 상단 주석 참고)
   */
  async process() {
    if (this.isProcessing) return;
    if (!this.executor.supabase) {
      console.log('[Sync Queue] Supabase 연결이 설정되어 있지 않아 큐 처리를 보류합니다.');
      return;
    }

    // 브라우저 환경이고 오프라인 상태이면 중단 (online 이벤트에서 자동 재개)
    if (typeof window !== 'undefined' && typeof window.navigator !== 'undefined' && !window.navigator.onLine) {
      console.log('[Sync Queue] 네트워크 오프라인 상태이므로 큐 처리를 중단합니다.');
      return;
    }

    this.isProcessing = true;
    console.log('[Sync Queue] 큐 처리를 시작합니다...');

    try {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }

      while (true) {
        const tasks = this.db.prepare('SELECT * FROM sync_queue ORDER BY id ASC').all();
        if (tasks.length === 0) {
          console.log('[Sync Queue] 모든 동기화 작업이 성공적으로 처리되었습니다.');
          break;
        }

        let maxSeenId = 0;
        for (const task of tasks) {
          const { id, table_name, record_id, action } = task;
          maxSeenId = id;
          console.log(`[Sync Queue] 작업 처리 중 - ID: ${id}, 액션: ${action}, 테이블: ${table_name}, 레코드ID: ${record_id}`);

          try {
            if (action === 'UPSERT') {
              await this.executor.syncItemToSupabaseDirect(table_name, record_id);
            } else if (action === 'DELETE') {
              await this.executor.syncDeletedToSupabaseDirect(table_name, record_id);
            } else if (action === 'REPLACE_PRESET_ITEMS') {
              await this.executor.syncPresetItemsDirect(record_id);
            }

            // 성공적으로 처리되면 큐에서 삭제
            this.db.prepare('DELETE FROM sync_queue WHERE id = ?').run(id);
          } catch (taskErr) {
            console.error(`[Sync Queue] 작업 처리 실패 (테이블: ${table_name}, ID: ${record_id}):`, taskErr.message);

            if (this.isNetworkError(taskErr)) {
              console.log('[Sync Queue] 네트워크 장애로 간주하여 큐 처리를 일시 정지하고 재시도 스케줄을 잡습니다.');
              this.scheduleRetry();
              return;
            }

            const retryCount = (task.retry_count || 0) + 1;
            if (retryCount >= MAX_SYNC_RETRIES) {
              console.error(`[Sync Queue] ${MAX_SYNC_RETRIES}회 연속 실패로 작업을 실패 이력(sync_failures)으로 이동합니다: ${action} ${table_name} (${record_id})`);
              this.db.prepare(`
                INSERT INTO sync_failures (table_name, record_id, action, error, failed_at)
                VALUES (?, ?, ?, ?, ?)
              `).run(table_name, record_id, action, String(taskErr.message || taskErr), this.time.getAdjustedSqliteTime());
              this.db.prepare('DELETE FROM sync_queue WHERE id = ?').run(id);
            } else {
              console.warn(`[Sync Queue] 데이터성 오류로 재시도 대기 상태로 전환합니다. (${retryCount}/${MAX_SYNC_RETRIES})`);
              this.db.prepare('UPDATE sync_queue SET retry_count = ? WHERE id = ?').run(retryCount, id);
            }
          }
        }

        // 처리 도중 새로 등록된 작업만 이어서 처리 (실패 잔류 작업으로 인한 무한 루프 방지)
        const hasNew = this.db.prepare('SELECT 1 FROM sync_queue WHERE id > ? LIMIT 1').get(maxSeenId);
        if (!hasNew) break;
      }

      // 재시도 대기 중인 작업이 남아 있으면 재시도 예약
      const pending = this.db.prepare('SELECT 1 FROM sync_queue LIMIT 1').get();
      if (pending) {
        this.scheduleRetry();
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 동기화 재시도 타이머를 설정합니다. (30초 후, 중복 예약 방지)
   */
  scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      console.log('[Sync Queue] 예정된 동기화 재시도를 실행합니다...');
      this.process().catch(err => console.error('[Sync Queue] 재시도 실행 오류:', err));
    }, 30000);
  }

  /**
   * 재시도 한도 초과로 포기된 동기화 실패 이력을 조회합니다. (진단용)
   * @returns {Array<object>}
   */
  getFailures() {
    return this.db.prepare('SELECT * FROM sync_failures ORDER BY failed_at DESC, id DESC').all();
  }
}

module.exports = SyncQueue;
module.exports.MAX_SYNC_RETRIES = MAX_SYNC_RETRIES;
