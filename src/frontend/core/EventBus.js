/**
 * @file EventBus.js
 * @description View/컴포넌트 간 통신을 위한 최소 관찰자(pub/sub) 구현.
 *
 * 직접 참조가 자연스러운 곳(예: App이 소유한 View 메서드 호출)은 직접 호출하고,
 * 발신자가 수신자를 몰라야 하는 곳(예: Supabase Realtime 원격 변경 알림)에만
 * 이벤트를 사용합니다.
 *
 * 현재 사용 중인 이벤트:
 *  - 'remote-data-changed': Supabase Realtime으로 원격 변경이 로컬 DB에 반영됨
 *    → 구독자(App)가 관련 화면을 다시 그림
 */

class EventBus {
  constructor() {
    /** 이벤트명 → 리스너 Set 매핑 */
    this._listeners = new Map();
  }

  /**
   * 이벤트 리스너를 등록합니다.
   * @param {string} event 이벤트 이름
   * @param {Function} handler 리스너 함수
   * @returns {Function} 등록 해제 함수 (호출 시 off와 동일)
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /**
   * 이벤트 리스너를 해제합니다.
   * @param {string} event 이벤트 이름
   * @param {Function} handler 등록했던 리스너 함수
   */
  off(event, handler) {
    const set = this._listeners.get(event);
    if (set) set.delete(handler);
  }

  /**
   * 이벤트를 발행합니다. 리스너 하나의 예외가 다른 리스너 실행을 막지 않습니다.
   * @param {string} event 이벤트 이름
   * @param {*} [payload] 리스너에 전달할 데이터
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] '${event}' 리스너 실행 중 오류:`, err);
      }
    }
  }
}

module.exports = EventBus;
