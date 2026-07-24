/**
 * @file renderer.js
 * @description 렌더러 프로세스 진입점.
 *
 * v1.8.0 객체지향 재구성 이후 이 파일은 부트스트랩만 담당합니다.
 * 실제 구현 위치:
 *  - App.js                : 애플리케이션 조립자 (탭 전환, CSV, 검색 엔진 연결)
 *  - core/                 : AppState(공유 상태) / EventBus / DialogService /
 *                            NumericInput / ModalKeyboard / utils
 *  - views/                : 탭별 View (MedicineList/Inquiry/Prescription/Predict/
 *                            Batch/Notification)
 *  - components/           : 모달·컨텍스트 메뉴·차트 컴포넌트
 *  - QuickSearchEngine.js  : 키보드 내비게이션 엔진 (App.js가 require로 로드)
 */

// 고해상도(DPI) 화면 배율에 따른 내부 콘텐츠 줌 레벨 조정 (윈도우 환경 전용)
try {
  const { webFrame } = require('electron');
  const isWindows = process.platform === 'win32';
  if (isWindows && window.devicePixelRatio > 1.5) {
    // 윈도우 OS 화면 배율이 150%(devicePixelRatio > 1.5)를 넘을 경우,
    // UI의 크기를 80% 수준으로 소폭 축소시켜 적절한 여백과 가독성을 확보합니다.
    // 맥북 레티나 디스플레이 등 타 OS 고해상도 환경은 영향을 받지 않습니다.
    webFrame.setZoomFactor(0.8);
  }
} catch (e) {
  console.error("화면 배율(DPI) 조정 실패:", e);
}

const App = require('./App');

// DOM 로드 완료 후 애플리케이션 구동
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  try {
    app.init();
  } finally {
    // 초기화(DB 로드 + 첫 렌더링) 완료를 메인 프로세스에 알려 메인 윈도우를 노출시킵니다.
    // init 중 오류가 나더라도 신호를 보내 윈도우가 영영 숨겨지는 것을 방지합니다.
    // (WindowManager가 이 신호 수신 전까지 스플래시를 유지)
    try {
      require('electron').ipcRenderer.send('renderer-init-complete');
    } catch (e) {
      console.error('초기화 완료 신호 전송 실패:', e);
    }
  }

  // 디버깅/콘솔 접근용 전역 노출 (선택적 편의 기능)
  window.app = app;
});
