/**
 * @file main.js
 * @description Electron 메인 프로세스 진입점.
 * 어플리케이션 윈도우 생성 및 노드 통합 환경 설정.
 */

const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");

let mainWindow = null;
let splashWindow = null;
let isManualCheck = false;
let isStartupCheck = true;
let startupTimeout = null;

// 렌더러에 업데이트 상태를 전달하는 헬퍼 함수
function sendStatusToWindow(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send("update-status", status, data);
  }
}

// 스플래시 화면에 업데이트 상태를 전달하는 헬퍼 함수
function sendStatusToSplash(status, data = {}) {
  if (splashWindow && !splashWindow.isDestroyed() && splashWindow.webContents) {
    splashWindow.webContents.send("update-status", status, data);
  }
}

// 5초 타임아웃 시작 (업데이트 서버 지연 방지용 Fallback)
function startStartupTimeout() {
  startupTimeout = setTimeout(() => {
    console.log("업데이트 체크 타임아웃 도달. 메인 윈도우를 바로 띄웁니다.");
    if (isStartupCheck) {
      launchMainWindow();
      isStartupCheck = false;
    }
  }, 5000);
}

function clearStartupTimeout() {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
}

// 스플래시 윈도우 생성 함수
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400,        // 본체 너비에 완전히 일치시킴
    height: 300,       // 본체 높이에 완전히 일치시킴
    useContentSize: true, // OS 스케일링으로 인한 왜곡 방지 및 정확한 해상도 매칭
    frame: false,      // 프레임 없는 윈도우
    transparent: true, // rounded-corners 투명화 지원
    alwaysOnTop: true, // 기동 시 화면 맨 앞 노출
    resizable: false,
    center: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, "frontend/splash.html"));

  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
  });

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

// 메인 윈도우 런칭 및 스플래시 종료 처리
function launchMainWindow() {
  if (mainWindow) return;
  clearStartupTimeout();
  createWindow();
}

function checkAutoUpdate() {
  // 개발 환경 모드 시뮬레이션
  if (!app.isPackaged) {
    console.log("개발 모드에서는 자동 업데이트를 시뮬레이션합니다.");
    setTimeout(() => {
      sendStatusToSplash("checking", { message: "최신 버전 정보 조회 중..." });
    }, 200);

    setTimeout(() => {
      sendStatusToSplash("not-available", { message: "최신 버전입니다. 프로그램을 실행합니다..." });
    }, 1200);

    setTimeout(() => {
      launchMainWindow();
      isStartupCheck = false;
    }, 1800);
    return;
  }

  // 업데이트 다운로드 완료 시 핸들러
  autoUpdater.on("update-downloaded", (info) => {
    isManualCheck = false;
    clearStartupTimeout();

    if (isStartupCheck) {
      sendStatusToSplash("downloaded", {
        message: `새 버전(${info.version}) 다운로드 완료. 프로그램을 재시작합니다.`,
        version: info.version
      });
      // 다운로드 완료 상태 확인 시 0.8초 후 즉시 설치 및 재기동
      setTimeout(() => {
        autoUpdater.quitAndInstall();
      }, 800);
    } else {
      sendStatusToWindow("downloaded", {
        message: `새 버전(${info.version}) 다운로드 완료.`,
        version: info.version
      });

      dialog.showMessageBox({
        type: "info",
        title: "업데이트 준비 완료",
        message: `새로운 버전(${info.version})이 다운로드되었습니다. 지금 재시작하여 업데이트를 설치하시겠습니까?`,
        buttons: ["재시작 및 설치", "나중에"],
        defaultId: 0,
        cancelId: 1,
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on("checking-for-update", () => {
    if (isStartupCheck) {
      sendStatusToSplash("checking", { message: "최신 버전 정보 조회 중..." });
    } else if (isManualCheck) {
      sendStatusToWindow("checking", { message: "최신 버전 정보 조회 중..." });
    }
  });

  autoUpdater.on("update-available", (info) => {
    clearStartupTimeout();
    if (isStartupCheck) {
      sendStatusToSplash("available", {
        message: `새로운 버전(${info.version}) 발견. 업데이트 다운로드 중...`,
        version: info.version
      });
    } else {
      sendStatusToWindow("available", {
        message: `새로운 버전(${info.version}) 발견. 업데이트 다운로드 중...`,
        version: info.version
      });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    isManualCheck = false;
    clearStartupTimeout();

    if (isStartupCheck) {
      sendStatusToSplash("not-available", {
        message: `현재 최신 버전(${info.version})을 사용하고 있습니다.`,
        version: info.version
      });
      setTimeout(() => {
        launchMainWindow();
        isStartupCheck = false;
      }, 500);
    } else {
      sendStatusToWindow("not-available", {
        message: `현재 최신 버전(${info.version})을 사용하고 있습니다.`,
        version: info.version
      });
    }
  });

  autoUpdater.on("error", (err) => {
    isManualCheck = false;
    clearStartupTimeout();

    const errMsg = err ? err.message : "";
    if (isStartupCheck) {
      sendStatusToSplash("error", {
        message: `업데이트 확인 중 오류 발생. 프로그램을 시작합니다.`,
        error: errMsg
      });
      setTimeout(() => {
        launchMainWindow();
        isStartupCheck = false;
      }, 500);
    } else {
      sendStatusToWindow("error", {
        message: `업데이트 확인 중 오류 발생.`,
        error: errMsg
      });
    }
  });

  autoUpdater.on("download-progress", (progressObj) => {
    if (isStartupCheck) {
      sendStatusToSplash("downloading", {
        message: `다운로드 진행 중... (${progressObj.percent.toFixed(1)}%)`,
        percent: progressObj.percent
      });
    } else {
      sendStatusToWindow("downloading", {
        message: `다운로드 진행 중... (${progressObj.percent.toFixed(1)}%)`,
        percent: progressObj.percent
      });
    }
  });

  // 초기 기동 시 업데이트 체크 개시
  isStartupCheck = true;
  startStartupTimeout();
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error("초기 자동 업데이트 체크 오류:", err);
    launchMainWindow();
    isStartupCheck = false;
  });

  // 이후 3시간마다 백그라운드 정기 체크
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error("정기 자동 업데이트 체크 오류:", err);
    });
  }, 3 * 60 * 60 * 1000);
}

// IPC 통신 설정
ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

ipcMain.on("check-for-updates-manual", () => {
  if (!app.isPackaged) {
    sendStatusToWindow("error", { message: "개발 모드에서는 업데이트를 체크할 수 없습니다." });
    return;
  }
  isManualCheck = true;
  autoUpdater.checkForUpdates().catch((err) => {
    sendStatusToWindow("error", { message: `업데이트 체크 실패: ${err.message}` });
    isManualCheck = false;
  });
});

function createWindow() {
  // 애플리케이션의 상단 메뉴 전체 제거 (Alt 키로 인한 포커스 유실 원천 차단)
  Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: "약재 재고 관리 시스템 (Herb Stock)",
    icon: path.join(__dirname, "assets/icon.png"),
    show: false, // 렌더러가 완전히 준비되기 전에 빈 창이 노출되지 않도록 함
    autoHideMenuBar: true, // Windows/Linux에서 Alt 키가 눌려도 메뉴바 포커스 방지
    webPreferences: {
      // 렌더러에서 직접 DB 연동 모듈을 불러오기 위해 NodeIntegration을 활성화합니다.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow = win;

  win.on("closed", () => {
    mainWindow = null;
  });

  // index.html 로드 (userDataPath를 쿼리 파라미터로 전달하여 렌더러에서 참조할 수 있도록 함)
  const userDataPath = app.getPath("userData");
  win.loadFile(path.join(__dirname, "frontend/index.html"), {
    query: { userDataPath },
  });

  // 윈도우가 화면에 보일 준비가 완료되었을 때만 표시
  win.once("ready-to-show", () => {
    win.show();
    // 메인 화면 노출 시 로딩 스플래시 화면 종료
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
  });

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
      createSplashWindow();
      checkAutoUpdate();
    } else {
      const win = allWindows[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createSplashWindow();
    checkAutoUpdate();

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
