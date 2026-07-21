/**
 * @file SettingsModal.js
 * @description 설정 모달(Supabase 공유 설정 + 자동 업데이트 확인) 컴포넌트.
 *
 * 역할:
 *  - Supabase URL/Key를 localStorage에 저장하고 InventoryManager에 연결/해제 지시
 *  - 앱 버전 표시 (메인 프로세스 IPC 'get-app-version')
 *  - 수동 업데이트 확인 트리거 및 상태 표시 (IPC 'check-for-updates-manual' / 'update-status')
 *
 * 렌더러에서 유일하게 Electron IPC를 사용하는 곳입니다.
 * (데이터 작업은 IPC 없이 백엔드 모듈을 직접 호출하는 구조)
 */

class SettingsModal {
  /**
   * @param {object} app App 코디네이터
   */
  constructor(app) {
    this.app = app;
  }

  get manager() { return this.app.manager; }
  get dialogs() { return this.app.dialogs; }

  /** 설정 모달 열기/저장/취소 및 업데이트 UI 이벤트를 바인딩합니다. */
  bindEvents() {
    const btnSettings = document.getElementById('btnSettings');
    const settingsModal = document.getElementById('settingsModal');
    const settingsSupabaseUrl = document.getElementById('settingsSupabaseUrl');
    const settingsSupabaseKey = document.getElementById('settingsSupabaseKey');
    const btnSettingsCancel = document.getElementById('btnSettingsCancel');
    const btnSettingsSave = document.getElementById('btnSettingsSave');

    if (btnSettings && settingsModal) {
      btnSettings.addEventListener('click', () => {
        // localStorage에서 기존 설정 정보 복원
        const savedUrl = localStorage.getItem('supabase_url') || '';
        const savedKey = localStorage.getItem('supabase_key') || '';
        settingsSupabaseUrl.value = savedUrl;
        settingsSupabaseKey.value = savedKey;

        // 앱 버전 조회 및 표시
        const { ipcRenderer } = require('electron');
        ipcRenderer.invoke('get-app-version')
          .then((ver) => {
            const appVersionText = document.getElementById('appVersionText');
            if (appVersionText) appVersionText.textContent = `v${ver}`;
          })
          .catch((err) => {
            console.error('버전 정보 조회 실패:', err);
            const appVersionText = document.getElementById('appVersionText');
            if (appVersionText) appVersionText.textContent = 'v1.2.7';
          });

        // 모달이 열릴 때 상태 텍스트 초기화
        const updateStatusText = document.getElementById('updateStatusText');
        if (updateStatusText) {
          updateStatusText.textContent = '최신 릴리즈 버전을 확인하고 업데이트할 수 있습니다.';
          updateStatusText.style.color = 'var(--color-text-muted)';
        }

        settingsModal.classList.add('show');
      });

      btnSettingsCancel.addEventListener('click', () => {
        settingsModal.classList.remove('show');
      });

      btnSettingsSave.addEventListener('click', () => this.handleSave());
    }

    this.initUpdateFeatures();
  }

  /** Supabase 설정을 저장하고 연결(또는 해제)을 수행합니다. */
  handleSave() {
    const settingsModal = document.getElementById('settingsModal');
    let url = document.getElementById('settingsSupabaseUrl').value.trim();
    const key = document.getElementById('settingsSupabaseKey').value.trim();

    // URL 관용 입력 보정 (백엔드 setupSupabase와 동일 규칙으로 저장 값도 정규화)
    if (url) {
      if (!/^https?:\/\//i.test(url)) {
        if (!url.includes('.')) {
          url = `https://${url}.supabase.co`;
        } else {
          url = `https://${url}`;
        }
      }
    }

    localStorage.setItem('supabase_url', url);
    localStorage.setItem('supabase_key', key);

    settingsModal.classList.remove('show');

    if (url && key) {
      this.dialogs.showToast('⚙️ 설정이 저장되었습니다. 데이터베이스 공유 동기화를 시도합니다.');
      // dbManager에 설정 전송하여 Supabase 동기화 인프라 재구축
      if (this.manager && typeof this.manager.setupSupabase === 'function') {
        this.manager.setupSupabase(url, key)
          .then(success => {
            if (success) {
              this.dialogs.showToast('🟢 Supabase 클라우드 데이터베이스와 성공적으로 연결 및 동기화되었습니다.');
              // 동기화 후 목록 갱신
              this.app.medicineList.render();
              // 처방 이력이 있으면 갱신
              const viewPrescTable = document.getElementById('pastPrescriptionsBody');
              if (viewPrescTable) {
                this.app.prescription.renderPastPrescriptions();
              }
            } else {
              this.dialogs.showToast('🔴 Supabase 연결에 실패했습니다. 설정을 다시 확인해주세요.', true);
            }
          })
          .catch(err => {
            console.error(err);
            this.dialogs.showToast('🔴 Supabase 연결 오류: ' + err.message, true);
          });
      }
    } else {
      this.dialogs.showToast('⚙️ 설정을 해제했습니다. 로컬 단독 모드로 작동합니다.');
      if (this.manager && typeof this.manager.setupSupabase === 'function') {
        this.manager.setupSupabase('', ''); // 연결 해제
      }
    }
  }

  /**
   * 자동 업데이트 UI 기능 초기화 및 메인 프로세스 IPC 이벤트 핸들러 바인딩.
   */
  initUpdateFeatures() {
    const { ipcRenderer } = require('electron');
    const btnCheckUpdate = document.getElementById('btnCheckUpdate');
    const updateStatusText = document.getElementById('updateStatusText');

    if (!btnCheckUpdate || !updateStatusText) return;

    // 업데이트 확인 버튼 클릭 이벤트
    btnCheckUpdate.addEventListener('click', () => {
      btnCheckUpdate.disabled = true;
      btnCheckUpdate.innerHTML = '<span class="sf-icon sf-icon-hourglass"></span> 확인 중...';
      updateStatusText.textContent = '최신 업데이트 정보를 조회하는 중입니다...';
      updateStatusText.style.color = 'var(--color-text-main)';

      ipcRenderer.send('check-for-updates-manual');
    });

    // 메인 프로세스로부터의 업데이트 상태 채널 리스너
    ipcRenderer.on('update-status', (event, status, data) => {
      switch (status) {
        case 'checking':
          updateStatusText.textContent = data.message || '최신 버전 정보 조회 중...';
          updateStatusText.style.color = 'var(--color-text-main)';
          break;
        case 'available':
          updateStatusText.textContent = data.message || '새로운 업데이트 버전이 발견되었습니다.';
          updateStatusText.style.color = 'var(--color-primary-light)';
          break;
        case 'not-available':
          updateStatusText.textContent = data.message || '현재 최신 버전을 사용하고 있습니다.';
          updateStatusText.style.color = 'var(--color-text-main)';
          btnCheckUpdate.disabled = false;
          btnCheckUpdate.innerHTML = '<span class="sf-icon sf-icon-refresh"></span> 업데이트 확인';
          break;
        case 'downloading':
          updateStatusText.textContent = data.message || '업데이트 다운로드 진행 중...';
          updateStatusText.style.color = 'var(--color-primary-light)';
          break;
        case 'downloaded':
          updateStatusText.textContent = data.message || '다운로드 완료. 즉시 설치할 수 있습니다.';
          updateStatusText.style.color = 'var(--color-primary)';
          btnCheckUpdate.disabled = false;
          btnCheckUpdate.innerHTML = '<span class="sf-icon sf-icon-refresh"></span> 업데이트 확인';
          break;
        case 'error':
          updateStatusText.textContent = (data.message || '업데이트 확인 실패.') + (data.error ? ` (${data.error})` : '');
          updateStatusText.style.color = 'var(--color-accent)';
          btnCheckUpdate.disabled = false;
          btnCheckUpdate.innerHTML = '<span class="sf-icon sf-icon-refresh"></span> 업데이트 확인';
          break;
        default:
          break;
      }
    });
  }
}

module.exports = SettingsModal;
