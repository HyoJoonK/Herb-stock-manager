/**
 * @file WindowManager.js
 * @description 스플래시/메인 윈도우의 생성과 수명 관리를 전담하는 클래스.
 *
 * 기동 흐름: 스플래시 윈도우(프레임 없음/투명) → 업데이트 체크(UpdateManager)
 *            → 메인 윈도우 노출과 동시에 스플래시 종료
 *
 * 렌더러와의 통신 채널(웹콘텐츠 send)도 이 클래스가 소유합니다.
 * (어느 윈도우가 살아있는지에 대한 판단과 전송을 한 곳에서 처리)
 */

const { BrowserWindow, Menu, app } = require('electron');
const path = require('path');

class WindowManager {
  constructor() {
    /** 메인 윈도우 핸들 (닫히면 null) */
    this.mainWindow = null;
    /** 스플래시 윈도우 핸들 (닫히면 null) */
    this.splashWindow = null;
  }

  /**
   * 렌더러(메인 윈도우)에 업데이트 상태를 전달합니다.
   * @param {string} status 상태 코드 ('checking'|'available'|... )
   * @param {object} [data] 부가 데이터 (message, version 등)
   */
  sendStatusToWindow(status, data = {}) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
      this.mainWindow.webContents.send('update-status', status, data);
    }
  }

  /**
   * 스플래시 화면에 업데이트 상태를 전달합니다.
   * @param {string} status 상태 코드
   * @param {object} [data] 부가 데이터
   */
  sendStatusToSplash(status, data = {}) {
    if (this.splashWindow && !this.splashWindow.isDestroyed() && this.splashWindow.webContents) {
      this.splashWindow.webContents.send('update-status', status, data);
    }
  }

  /** 기동 시 표시할 스플래시 윈도우를 생성합니다. */
  createSplashWindow() {
    this.splashWindow = new BrowserWindow({
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

    this.splashWindow.loadFile(path.join(__dirname, '../frontend/splash.html'));

    this.splashWindow.once('ready-to-show', () => {
      this.splashWindow.show();
    });

    this.splashWindow.on('closed', () => {
      this.splashWindow = null;
    });
  }

  /**
   * 메인 윈도우를 생성합니다. 노출 준비가 끝나면 스플래시를 닫습니다.
   * userDataPath를 쿼리 파라미터로 전달해 렌더러가 DB 저장 위치를 알 수 있게 합니다.
   */
  createMainWindow() {
    // 애플리케이션의 상단 메뉴 전체 제거 (Alt 키로 인한 포커스 유실 원천 차단)
    Menu.setApplicationMenu(null);

    const win = new BrowserWindow({
      width: 1280,
      height: 850,
      minWidth: 1024,
      minHeight: 700,
      title: '약재 재고 관리 시스템 (Herb Stock)',
      icon: path.join(__dirname, '../assets/icon.png'),
      show: false, // 렌더러가 완전히 준비되기 전에 빈 창이 노출되지 않도록 함
      autoHideMenuBar: true, // Windows/Linux에서 Alt 키가 눌려도 메뉴바 포커스 방지
      webPreferences: {
        // 렌더러에서 직접 DB 연동 모듈을 불러오기 위해 NodeIntegration을 활성화합니다.
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    this.mainWindow = win;

    win.on('closed', () => {
      this.mainWindow = null;
    });

    // index.html 로드 (userDataPath를 쿼리 파라미터로 전달하여 렌더러에서 참조할 수 있도록 함)
    const userDataPath = app.getPath('userData');
    win.loadFile(path.join(__dirname, '../frontend/index.html'), {
      query: { userDataPath },
    });

    // 윈도우가 화면에 보일 준비가 완료되었을 때만 표시
    win.once('ready-to-show', () => {
      win.show();
      // 메인 화면 노출 시 로딩 스플래시 화면 종료
      if (this.splashWindow && !this.splashWindow.isDestroyed()) {
        this.splashWindow.close();
      }
    });

    // 개발자 도구 (필요시 활성화)
    // win.webContents.openDevTools();
  }

  /** 메인 윈도우가 없을 때만 새로 생성합니다. (중복 생성 가드) */
  launchMainWindow() {
    if (this.mainWindow) return;
    this.createMainWindow();
  }
}

module.exports = WindowManager;
