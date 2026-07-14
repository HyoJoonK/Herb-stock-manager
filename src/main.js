/**
 * @file main.js
 * @description Electron 메인 프로세스 진입점.
 * 어플리케이션 윈도우 생성 및 노드 통합 환경 설정.
 */

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");

// 윈도우 OS 화면 배율 설정을 무시하고 기본 UI 배율(100%)로 강제 고정합니다.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: "약재 재고 관리 시스템 (Herb Stock)",
    icon: path.join(__dirname, "assets/icon.png"),
    webPreferences: {
      // 렌더러에서 직접 DB 연동 모듈을 불러오기 위해 NodeIntegration을 활성화합니다.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // index.html 로드 (userDataPath 및 버전을 쿼리 파라미터로 전달하여 렌더러에서 참조할 수 있도록 함)
  const userDataPath = app.getPath("userData");
  win.loadFile(path.join(__dirname, "frontend/index.html"), {
    query: { userDataPath, version: app.getVersion() },
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
    
    // 앱 초기 로딩 속도 최적화를 위해, UI가 완전히 그려진 5초 후 백그라운드 업데이트 확인을 실행합니다.
    setTimeout(() => {
      setupAutoUpdater();
    }, 5000);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

let isManualCheck = false;

function setupAutoUpdater() {
  if (!app.isPackaged) {
    return;
  }

  // 업데이트 다운로드가 완료되었을 때
  autoUpdater.on("update-downloaded", (info) => {
    dialog.showMessageBox({
      type: "info",
      title: "업데이트 준비 완료",
      message: `새로운 버전(${info.version})이 다운로드되었습니다. 어플리케이션을 재시작하여 업데이트를 적용하시겠습니까?`,
      buttons: ["지금 재시작", "나중에"],
      defaultId: 0,
      cancelId: 1
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  // 업데이트가 없을 때 (최신 버전일 때)
  autoUpdater.on("update-not-available", (info) => {
    if (isManualCheck) {
      dialog.showMessageBox({
        type: "info",
        title: "업데이트 확인",
        message: `현재 최신 버전(v${app.getVersion()})을 사용하고 있습니다.`
      });
      isManualCheck = false;
    }
  });

  // 에러 발생 시
  autoUpdater.on("error", (err) => {
    if (isManualCheck) {
      dialog.showMessageBox({
        type: "error",
        title: "업데이트 확인 실패",
        message: `업데이트를 확인하는 중 오류가 발생했습니다: ${err.message}`
      });
      isManualCheck = false;
    }
  });

  // 업데이트 자동 확인 실행
  autoUpdater.checkForUpdatesAndNotify();
}

// 수동 업데이트 확인 IPC 리스너 등록
ipcMain.on("manual-check-for-update", () => {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: "info",
      title: "업데이트 확인",
      message: "개발 모드에서는 업데이트를 확인할 수 없습니다."
    });
    return;
  }
  isManualCheck = true;
  autoUpdater.checkForUpdates();
});

app.on("window-all-closed", () => {
  // macOS가 아닐 경우 프로세스 완전히 종료
  if (process.platform !== "darwin") {
    app.quit();
  }
});
