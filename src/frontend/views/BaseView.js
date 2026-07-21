/**
 * @file BaseView.js
 * @description 모든 View 클래스의 공통 기반.
 *
 * View 계층의 규약:
 *  - 각 View는 자신의 화면 영역(DOM)과 그 영역의 이벤트 바인딩만 소유합니다.
 *  - 공유 상태는 this.state(AppState), 데이터 접근은 this.manager(InventoryManager),
 *    사용자 알림은 this.dialogs(DialogService)를 사용합니다.
 *  - 다른 View의 화면 갱신이 필요하면 this.app을 통해 해당 View의 공개 메서드를
 *    호출합니다. (예: this.app.medicineList.render())
 *  - 이벤트 바인딩은 bindEvents()에 모아 App.init()에서 1회 호출됩니다.
 */

class BaseView {
  /**
   * @param {object} app App 코디네이터 (모든 View/컴포넌트/서비스의 소유자)
   */
  constructor(app) {
    this.app = app;
  }

  /** InventoryManager (백엔드 Facade) */
  get manager() { return this.app.manager; }

  /** AppState (공유 UI 상태) */
  get state() { return this.app.state; }

  /** DialogService (알림/확인/토스트) */
  get dialogs() { return this.app.dialogs; }

  /** QuickSearchEngine (키보드 내비게이션 엔진) */
  get searchEngine() { return this.app.searchEngine; }

  /** EventBus (뷰 간 이벤트) */
  get bus() { return this.app.bus; }

  /**
   * document.getElementById 단축 헬퍼.
   * @param {string} id 요소 id
   * @returns {HTMLElement|null}
   */
  $(id) {
    return document.getElementById(id);
  }
}

module.exports = BaseView;
