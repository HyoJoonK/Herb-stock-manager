/**
 * @file main.js
 * @description Electron 메인 프로세스 진입점.
 *
 * v1.8.0 객체지향 재구성 이후 이 파일은 앱 수명주기와 IPC 등록만 담당합니다.
 * 실제 구현 위치:
 *  - main/WindowManager.js : 스플래시/메인 윈도우 생성·수명 관리·렌더러 상태 전송
 *  - main/UpdateManager.js : electron-updater 자동 업데이트 흐름 (기동/수동/정기 체크)
 *
 * 등록된 IPC 채널:
 *  - 'get-app-version' (handle) : 현재 앱 버전 반환
 *  - 'check-for-updates-manual' (on) : 사용자가 수동으로 업데이트 확인 트리거
 */

const { app, BrowserWindow, ipcMain } = require('electron');

const WindowManager = require('./main/WindowManager');
const UpdateManager = require('./main/UpdateManager');

// 윈도우/업데이트 관리자 조립 (UpdateManager는 WindowManager를 통해 화면을 제어)
const windowManager = new WindowManager();
const updateManager = new UpdateManager(windowManager);

// ---- IPC 통신 설정 ----------------------------------------------------------

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.on('check-for-updates-manual', () => {
  updateManager.checkManually();
});

// ---- 앱 수명주기 ------------------------------------------------------------

// 싱글 인스턴스 잠금 요청 (중복 실행 방지)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 두 번째 인스턴스가 실행을 시도할 때 기존 윈도우가 있다면 포커싱하고, 없다면 새로 생성합니다.
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length === 0) {
      windowManager.createSplashWindow();
      updateManager.start();
    } else {
      const win = allWindows[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // 기동 순서: 스플래시 → 업데이트 체크 → (완료/타임아웃 시) 메인 윈도우
    windowManager.createSplashWindow();
    updateManager.start();

    app.on('activate', () => {
      // macOS Dock 아이콘 클릭 등으로 재활성화 시 윈도우가 없으면 재생성
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager.createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  // macOS가 아닐 경우 프로세스 완전히 종료
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
