/**
 * @file RealtimeSubscriber.js
 * @description Supabase Realtime(postgres_changes) 웹소켓 구독 전담 클래스.
 *
 * 다른 PC에서 발생한 원격 변경을 실시간으로 수신해 로컬 SQLite에 즉시 반영하고,
 * 등록된 onChange 콜백으로 렌더러 UI 갱신을 트리거합니다.
 *
 * 반영 규칙:
 *  - INSERT/UPDATE: LWW 대상 테이블이면 ConflictResolver로 판정 후 승자만 반영,
 *    비-LWW 테이블은 무조건 반영
 *  - DELETE: 로컬에서도 해당 레코드 삭제
 *  - 동기화 대상 외 테이블(deleted_records 등)의 이벤트는 무시
 */

class RealtimeSubscriber {
  /**
   * @param {object} deps 의존성 주입
   * @param {object} deps.db better-sqlite3 원시 연결
   * @param {object} deps.mapper TableMapper (원격 행 → 로컬 업서트)
   * @param {object} deps.resolver ConflictResolver (LWW 판정)
   * @param {function(): void} deps.onChange 로컬 반영 후 호출할 UI 갱신 콜백 게터
   */
  constructor({ db, mapper, resolver, onChange }) {
    this.db = db;
    this.mapper = mapper;
    this.resolver = resolver;
    this.onChange = onChange;

    /** 현재 구독 중인 Realtime 채널 핸들 */
    this.channel = null;
  }

  /**
   * Realtime 채널 구독을 시작합니다. 기존 구독이 있으면 해제 후 재구독합니다.
   * @param {object} supabase Supabase 클라이언트
   */
  subscribe(supabase) {
    if (!supabase) return;

    if (this.channel) {
      supabase.removeChannel(this.channel);
    }

    console.log('[Supabase Realtime] 실시간 DB 변경 구독을 시작합니다...');

    this.channel = supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public' },
        (payload) => {
          this.handleChange(payload).catch(err => {
            console.error('[Supabase Realtime] 변경 반영 중 오류:', err);
          });
        }
      )
      .subscribe((status) => {
        console.log(`[Supabase Realtime] 채널 구독 상태: ${status}`);
      });
  }

  /**
   * 구독을 해제합니다. (Supabase 연결 해제 시 호출)
   * @param {object} supabase Supabase 클라이언트
   */
  unsubscribe(supabase) {
    if (this.channel && supabase) {
      supabase.removeChannel(this.channel);
    }
    this.channel = null;
  }

  /**
   * 실시간 변경 payload를 로컬 SQLite에 반영합니다. (테이블 설정 기반 공통 처리)
   * @param {object} payload postgres_changes 이벤트 payload
   */
  async handleChange(payload) {
    const { table, eventType, new: newRow, old: oldRow } = payload;
    const cfg = this.mapper.getConfig(table);
    if (!cfg) return; // deleted_records 등 동기화 대상 외 테이블은 무시

    console.log(`[Supabase Realtime] 변경 감지 - 테이블: ${table}, 이벤트: ${eventType}`);

    try {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        // LWW 테이블은 타임스탬프 판정 승자만 반영, 비-LWW 테이블은 무조건 반영
        if (!cfg.lww || this.resolver.shouldOverwriteWithRemote(table, newRow.id, newRow.updated_at)) {
          this.mapper.applyRemoteRow(table, newRow);
        }
      } else if (eventType === 'DELETE') {
        this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(oldRow.id);
      }

      // UI 갱신 트리거 (렌더러가 등록한 콜백)
      const callback = this.onChange();
      if (typeof callback === 'function') {
        callback();
      }
    } catch (err) {
      console.error(`[Supabase Realtime] SQLite 반영 실패 (${table}):`, err);
    }
  }
}

module.exports = RealtimeSubscriber;
