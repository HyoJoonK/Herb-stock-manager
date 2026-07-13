/**
 * @file main.js
 * @description Electron 메인 프로세스 진입점.
 * 어플리케이션 윈도우 생성 및 노드 통합 환경 설정.
 */

const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: "약재 재고 관리 시스템 (Herb Stock)",
    webPreferences: {
      // 렌더러에서 직접 DB 연동 모듈을 불러오기 위해 NodeIntegration을 활성화합니다.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // index.html 로드 (userDataPath를 쿼리 파라미터로 전달하여 렌더러에서 참조할 수 있도록 함)
  const userDataPath = app.getPath("userData");
  win.loadFile(path.join(__dirname, "frontend/index.html"), {
    query: { userDataPath },
  });

  // 메뉴바 숨김 (조제 전용 키보드 동선 집중)
  win.setMenuBarVisibility(false);

  // 개발자 도구 (필요시 활성화)
  // win.webContents.openDevTools();
}

// 싱글 인스턴스 잠금 요청 (중복 실행 방지)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // 두 번째 인스턴스가 실행을 시도할 때 기존 윈도우가 있다면 포커싱하고, 없다면 새로 생성합니다.
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length === 0) {
      createWindow();
    } else {
      const win = allWindows[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  // macOS가 아닐 경우 프로세스 완전히 종료
  if (process.platform !== "darwin") {
    app.quit();
  }
});
