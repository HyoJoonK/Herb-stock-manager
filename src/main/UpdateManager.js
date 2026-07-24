/**
 * @file UpdateManager.js
 * @description electron-updater 기반 자동 업데이트 흐름 전담 클래스.
 *
 * 동작 시나리오:
 *  - 기동 체크(isStartupCheck): 스플래시 화면에 상태를 표시하며,
 *    최신이면 메인 윈도우 진입, 새 버전이면 다운로드 후 즉시 재시작 설치
 *  - 5초 타임아웃: 업데이트 서버 응답이 늦어도 메인 윈도우를 강제 노출 (기동 지연 방지)
 *  - 수동 체크(isManualCheck): 설정 모달의 '업데이트 확인' 버튼 → 메인 윈도우에 상태 표시
 *  - 정기 체크: 3시간마다 백그라운드 확인, 다운로드 완료 시 재시작 여부를 대화상자로 질의
 *  - 개발 모드(!app.isPackaged): 실제 서버 호출 없이 기동 타임라인만 시뮬레이션
 *
 * start()는 멱등합니다: autoUpdater 이벤트 리스너와 3시간 정기 체크는 최초 1회만
 * 등록되고, 재호출 시(second-instance 경로 등)에는 기동 체크만 다시 수행합니다.
 */

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

class UpdateManager {
  /**
   * @param {object} windowManager WindowManager (상태 전달 및 메인 윈도우 기동)
   */
  constructor(windowManager) {
    this.windows = windowManager;

    /** 수동 업데이트 확인 진행 중 여부 */
    this.isManualCheck = false;
    /** 기동 시 최초 체크 단계 여부 (스플래시 표시 중) */
    this.isStartupCheck = true;
    /** 기동 타임아웃 핸들 */
    this.startupTimeout = null;
    /** autoUpdater 리스너·정기 체크 등록 완료 여부 (start 재호출 시 중복 등록 방지) */
    this.initialized = false;
  }

  /** 5초 타임아웃 시작 (업데이트 서버 지연 방지용 Fallback) */
  startStartupTimeout() {
    this.startupTimeout = setTimeout(() => {
      console.log('업데이트 체크 타임아웃 도달. 메인 윈도우를 바로 띄웁니다.');
      if (this.isStartupCheck) {
        this.windows.launchMainWindow();
        this.isStartupCheck = false;
      }
    }, 5000);
  }

  /** 기동 타임아웃을 해제합니다. */
  clearStartupTimeout() {
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
  }

  /**
   * 자동 업데이트 체크를 시작합니다. (앱 기동 시 1회 호출)
   * 이벤트 핸들러 등록 → 기동 체크 → 3시간 주기 백그라운드 체크 순서로 구성됩니다.
   */
  start() {
    // 개발 환경 모드 시뮬레이션 (실제 서버 접속 없음)
    if (!app.isPackaged) {
      console.log('개발 모드에서는 자동 업데이트를 시뮬레이션합니다.');
      setTimeout(() => {
        this.windows.sendStatusToSplash('checking', { message: '최신 버전 정보 조회 중...' });
      }, 200);

      setTimeout(() => {
        this.windows.sendStatusToSplash('not-available', { message: '최신 버전입니다. 프로그램을 실행합니다...' });
      }, 1200);

      setTimeout(() => {
        this.windows.launchMainWindow();
        this.isStartupCheck = false;
      }, 1800);
      return;
    }

    // autoUpdater 이벤트 리스너와 3시간 정기 체크는 최초 1회만 등록합니다.
    // (second-instance 경로에서 start()가 재호출되어도 중복 등록되지 않도록)
    if (!this.initialized) {
      this.initialized = true;
      this.registerAutoUpdaterEvents();

      // 이후 3시간마다 백그라운드 정기 체크
      setInterval(() => {
        autoUpdater.checkForUpdatesAndNotify().catch((err) => {
          console.error('정기 자동 업데이트 체크 오류:', err);
        });
      }, 3 * 60 * 60 * 1000);
    }

    // 기동 체크 개시 (재호출 시에도 스플래시 → 메인 윈도우 흐름을 동일하게 수행)
    this.isStartupCheck = true;
    this.clearStartupTimeout();
    this.startStartupTimeout();
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('초기 자동 업데이트 체크 오류:', err);
      this.windows.launchMainWindow();
      this.isStartupCheck = false;
    });
  }

  /** autoUpdater 이벤트 핸들러 일괄 등록. (start()에서 최초 1회만 호출됩니다) */
  registerAutoUpdaterEvents() {
    // 업데이트 다운로드 완료 시 핸들러
    autoUpdater.on('update-downloaded', (info) => {
      this.isManualCheck = false;
      this.clearStartupTimeout();

      if (this.isStartupCheck) {
        this.windows.sendStatusToSplash('downloaded', {
          message: `새 버전(${info.version}) 다운로드 완료. 프로그램을 재시작합니다.`,
          version: info.version
        });
        // 다운로드 완료 상태 확인 시 0.8초 후 즉시 설치 및 재기동
        setTimeout(() => {
          autoUpdater.quitAndInstall();
        }, 800);
      } else {
        this.windows.sendStatusToWindow('downloaded', {
          message: `새 버전(${info.version}) 다운로드 완료.`,
          version: info.version
        });

        dialog.showMessageBox({
          type: 'info',
          title: '업데이트 준비 완료',
          message: `새로운 버전(${info.version})이 다운로드되었습니다. 지금 재시작하여 업데이트를 설치하시겠습니까?`,
          buttons: ['재시작 및 설치', '나중에'],
          defaultId: 0,
          cancelId: 1,
        }).then((result) => {
          if (result.response === 0) {
            autoUpdater.quitAndInstall();
          }
        });
      }
    });

    autoUpdater.on('checking-for-update', () => {
      if (this.isStartupCheck) {
        this.windows.sendStatusToSplash('checking', { message: '최신 버전 정보 조회 중...' });
      } else if (this.isManualCheck) {
        this.windows.sendStatusToWindow('checking', { message: '최신 버전 정보 조회 중...' });
      }
    });

    autoUpdater.on('update-available', (info) => {
      this.clearStartupTimeout();
      if (this.isStartupCheck) {
        this.windows.sendStatusToSplash('available', {
          message: `새로운 버전(${info.version}) 발견. 업데이트 다운로드 중...`,
          version: info.version
        });
      } else {
        this.windows.sendStatusToWindow('available', {
          message: `새로운 버전(${info.version}) 발견. 업데이트 다운로드 중...`,
          version: info.version
        });
      }
    });

    autoUpdater.on('update-not-available', (info) => {
      this.isManualCheck = false;
      this.clearStartupTimeout();

      if (this.isStartupCheck) {
        this.windows.sendStatusToSplash('not-available', {
          message: `현재 최신 버전(${info.version})을 사용하고 있습니다.`,
          version: info.version
        });
        setTimeout(() => {
          this.windows.launchMainWindow();
          this.isStartupCheck = false;
        }, 500);
      } else {
        this.windows.sendStatusToWindow('not-available', {
          message: `현재 최신 버전(${info.version})을 사용하고 있습니다.`,
          version: info.version
        });
      }
    });

    autoUpdater.on('error', (err) => {
      this.isManualCheck = false;
      this.clearStartupTimeout();

      const errMsg = err ? err.message : '';
      if (this.isStartupCheck) {
        this.windows.sendStatusToSplash('error', {
          message: `업데이트 확인 중 오류 발생. 프로그램을 시작합니다.`,
          error: errMsg
        });
        setTimeout(() => {
          this.windows.launchMainWindow();
          this.isStartupCheck = false;
        }, 500);
      } else {
        this.windows.sendStatusToWindow('error', {
          message: `업데이트 확인 중 오류 발생.`,
          error: errMsg
        });
      }
    });

    autoUpdater.on('download-progress', (progressObj) => {
      if (this.isStartupCheck) {
        this.windows.sendStatusToSplash('downloading', {
          message: `다운로드 진행 중... (${progressObj.percent.toFixed(1)}%)`,
          percent: progressObj.percent
        });
      } else {
        this.windows.sendStatusToWindow('downloading', {
          message: `다운로드 진행 중... (${progressObj.percent.toFixed(1)}%)`,
          percent: progressObj.percent
        });
      }
    });

  }

  /**
   * 사용자 요청에 의한 수동 업데이트 확인. (IPC 'check-for-updates-manual')
   * 개발 모드에서는 오류 안내만 표시합니다.
   */
  checkManually() {
    if (!app.isPackaged) {
      this.windows.sendStatusToWindow('error', { message: '개발 모드에서는 업데이트를 체크할 수 없습니다.' });
      return;
    }
    this.isManualCheck = true;
    autoUpdater.checkForUpdates().catch((err) => {
      this.windows.sendStatusToWindow('error', { message: `업데이트 체크 실패: ${err.message}` });
      this.isManualCheck = false;
    });
  }
}

module.exports = UpdateManager;
