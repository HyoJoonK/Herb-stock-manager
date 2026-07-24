/**
 * @file WindowManager.js
 * @description 스플래시/메인 윈도우의 생성과 수명 관리를 전담하는 클래스.
 *
 * 기동 흐름: 스플래시 윈도우(프레임 없음/투명) → 업데이트 체크(UpdateManager)
 *            → 메인 윈도우 로드 → 렌더러 초기화 완료(IPC 'renderer-init-complete')
 *            → 메인 윈도우 노출과 동시에 스플래시 종료
 *
 * 렌더러와의 통신 채널(웹콘텐츠 send)도 이 클래스가 소유합니다.
 * (어느 윈도우가 살아있는지에 대한 판단과 전송을 한 곳에서 처리)
 */

const { BrowserWindow, Menu, app, ipcMain } = require('electron');
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
      show: false, // 렌더러 초기화(DB 로드 + 첫 렌더링) 완료 신호 수신 전까지 숨김 유지
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

    // 렌더러의 초기화 완료(DB 로드 + 첫 렌더링) 신호를 받은 뒤에만 윈도우를 노출합니다.
    // ready-to-show는 첫 페인트(빈 스켈레톤 UI) 시점에 발화하므로 그 기준으로 노출하면
    // 저사양 환경에서 데이터 없는 화면이 수 초간 보이게 됩니다. (renderer.js가 신호 송신)
    let shown = false;
    const showWhenReady = () => {
      if (shown) return;
      shown = true;
      clearTimeout(fallbackTimer);
      ipcMain.removeListener('renderer-init-complete', showWhenReady);
      if (win.isDestroyed()) return;

      const reveal = () => {
        if (!win.isDestroyed()) {
          win.show();
        }
        // 메인 화면 노출 시 로딩 스플래시 화면 종료
        if (this.splashWindow && !this.splashWindow.isDestroyed()) {
          this.splashWindow.close();
        }
      };

      // 스플래시가 떠 있으면 100% 완료 상태를 잠깐(200ms) 보여준 뒤 전환합니다.
      // (빠른 기기에서 진행률 바가 60%대에서 끊긴 채 넘어가는 오해 방지)
      if (this.splashWindow && !this.splashWindow.isDestroyed()) {
        this.sendStatusToSplash('ready', { message: '준비 완료! 프로그램을 시작합니다.' });
        setTimeout(reveal, 200);
      } else {
        reveal();
      }
    };
    ipcMain.once('renderer-init-complete', showWhenReady);

    // 안전장치: 렌더러가 신호를 보내지 못하는 예외 상황(스크립트 오류 등)에도
    // 윈도우가 영영 숨겨지지 않도록 15초 후 강제 표시합니다.
    const fallbackTimer = setTimeout(() => {
      console.warn('렌더러 초기화 완료 신호 타임아웃(15초). 메인 윈도우를 강제 표시합니다.');
      showWhenReady();
    }, 15000);

    win.on('closed', () => {
      clearTimeout(fallbackTimer);
      ipcMain.removeListener('renderer-init-complete', showWhenReady);
    });

    // index.html 로드 (userDataPath를 쿼리 파라미터로 전달하여 렌더러에서 참조할 수 있도록 함)
    const userDataPath = app.getPath('userData');
    win.loadFile(path.join(__dirname, '../frontend/index.html'), {
      query: { userDataPath },
    });

    // 메인 화면을 로드하는 동안 스플래시에 진행 상태 표시
    this.sendStatusToSplash('starting', { message: '재고 데이터를 불러오는 중...' });

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
