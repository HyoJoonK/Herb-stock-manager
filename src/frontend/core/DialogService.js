/**
 * @file DialogService.js
 * @description 앱 공용 알림/확인 대화상자 및 토스트 알림 서비스.
 *
 * Electron에서 네이티브 alert/confirm은 닫힌 뒤 렌더러가 키보드 포커스를
 * 되찾지 못하는 버그(캐럿 소실, 입력 무반응)가 있어 앱 내 DOM 모달로 대체합니다.
 *
 * 특징:
 *  - 대화상자가 겹쳐 호출되어도 순차 실행 체인(Promise chain)으로 하나씩 표시
 *  - 닫힌 뒤 이전 포커스 위치를 복원해 키보드 워크플로우가 끊기지 않음
 *  - QuickSearchEngine 등 비모듈 스크립트 호환을 위해 window.showAlert /
 *    window.showConfirm 전역 함수도 함께 노출
 */

const { escapeHtml } = require('./utils');

class DialogService {
  /**
   * @param {object} deps 의존성
   * @param {function(): object} deps.getSearchEngine 포커스 복원용 QuickSearchEngine 게터
   *        (생성 시점에는 엔진이 없을 수 있어 게터로 지연 참조)
   */
  constructor({ getSearchEngine }) {
    this.getSearchEngine = getSearchEngine;

    /** 대화상자가 겹쳐 호출되는 상황을 방지하기 위한 순차 실행 체인 */
    this._dialogChain = Promise.resolve();

    // 비모듈 스크립트(QuickSearchEngine)에서도 사용할 수 있도록 전역 노출
    window.showAlert = (message, title) => this.showAlert(message, title);
    window.showConfirm = (message, title) => this.showConfirm(message, title);
  }

  /**
   * 대화상자를 엽니다. (내부 공통 구현)
   * @param {{message: string, title?: string, isConfirm: boolean}} options
   * @returns {Promise<boolean>} 확인 시 true, 취소/Esc 시 false
   */
  open({ message, title, isConfirm }) {
    const run = () => new Promise((resolve) => {
      const overlay = document.getElementById('appDialogModal');
      const okBtn = document.getElementById('btnAppDialogOk');
      const cancelBtn = document.getElementById('btnAppDialogCancel');

      document.getElementById('appDialogTitle').textContent = title || (isConfirm ? '확인' : '알림');
      document.getElementById('appDialogMessage').textContent = message;
      cancelBtn.style.display = isConfirm ? '' : 'none';

      const prevFocused = document.activeElement;

      const close = (result) => {
        overlay.classList.remove('show');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKeyDown, true);

        // 대화상자를 열기 전 포커스 위치 복원 (닫힌 뒤 입력 흐름이 끊기지 않도록)
        const searchEngine = this.getSearchEngine();
        if (prevFocused && prevFocused !== document.body && document.contains(prevFocused) && typeof prevFocused.focus === 'function') {
          prevFocused.focus();
        } else if (searchEngine && searchEngine.state === 'search' && !document.querySelector('.modal-overlay.show, .popup-overlay.show')) {
          searchEngine.setFocusState('search');
        }
        resolve(result);
      };

      const onOk = () => close(true);
      const onCancel = () => close(false);

      // 다른 모달 위에 겹쳐 뜰 수 있으므로 캡처 단계에서 가로채,
      // 전역 모달 키 핸들러(Enter 저장 / Esc 닫기 / Tab 트랩)가 아래쪽 모달에 반응하지 않게 함
      const onKeyDown = (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          // Tab/방향키로 취소 버튼에 포커스를 둔 상태의 Enter는 취소로 처리
          close(document.activeElement !== cancelBtn);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(false);
        } else if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          if (isConfirm) {
            (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
          }
        }
      };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKeyDown, true);

      overlay.classList.add('show');
      okBtn.focus();
    });

    const request = this._dialogChain.then(run);
    this._dialogChain = request.then(() => {}, () => {});
    return request;
  }

  /**
   * 네이티브 alert() 대체. 확인 버튼을 누를 때까지 대기합니다.
   * @param {string} message 알림 메시지
   * @param {string} [title] 제목
   * @returns {Promise<void>}
   */
  showAlert(message, title) {
    return this.open({ message, title, isConfirm: false }).then(() => {});
  }

  /**
   * 네이티브 confirm() 대체.
   * @param {string} message 확인 메시지
   * @param {string} [title] 제목
   * @returns {Promise<boolean>} 확인 시 true, 취소/Esc 시 false
   */
  showConfirm(message, title) {
    return this.open({ message, title, isConfirm: true });
  }

  /**
   * 우하단 토스트 알림을 표시합니다. 선두 이모지는 SF 아이콘으로 치환됩니다.
   * @param {string} message 표시할 메시지
   * @param {boolean} [isError=false] 오류 스타일 여부
   */
  showToast(message, isError = false) {
    const toast = document.getElementById('toastMessage');

    // 선두 이모지 → SF Symbols 아이콘 클래스 매핑
    const emojiToSfMap = {
      '⚠️': 'warning',
      '🟢': 'circle-green',
      '🔴': 'circle',
      '⚙️': 'gear',
      '⚙': 'gear',
      '📝': 'memo',
      '✏️': 'pencil',
      '✏': 'pencil',
      '🗑️': 'trash',
      '🗑': 'trash',
      '💾': 'save',
      '🔄': 'refresh',
      '🎉': 'party',
      '📥': 'import',
      '📤': 'export',
      '⚖️': 'scale',
      '⚖': 'scale',
      '✨': 'sparkles',
      'ℹ️': 'info',
      'ℹ': 'info',
      '⚡': 'bolt',
      '✅': 'checkmark'
    };

    // 메시지에 약재명/에러 메시지 등 사용자 유래 문자열이 섞일 수 있으므로 항상 이스케이프 후 삽입
    let formattedMessage = escapeHtml(message);

    // 선두 이모지를 스타일 아이콘 span으로 치환
    for (const [emoji, iconName] of Object.entries(emojiToSfMap)) {
      if (message.startsWith(emoji)) {
        let iconHtml = `<span class="sf-icon sf-icon-${iconName}"></span>`;
        // 상태별 색상 커스터마이징
        if (iconName === 'circle') {
          iconHtml = `<span class="sf-icon sf-icon-circle" style="color: var(--color-accent);"></span>`;
        } else if (iconName === 'circle-green') {
          iconHtml = `<span class="sf-icon sf-icon-circle-green" style="color: var(--color-primary);"></span>`;
        } else if (iconName === 'warning') {
          iconHtml = `<span class="sf-icon sf-icon-warning" style="color: #ffcc00;"></span>`;
        }

        const restOfMessage = message.slice(emoji.length).trim();
        formattedMessage = `${iconHtml} ${escapeHtml(restOfMessage)}`;
        break;
      }
    }

    toast.innerHTML = formattedMessage;
    if (isError) {
      toast.classList.add('toast-error');
    } else {
      toast.classList.remove('toast-error');
    }
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }
}

module.exports = DialogService;
