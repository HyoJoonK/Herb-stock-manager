/**
 * @file ModalKeyboard.js
 * @description 모달 공용 키보드 편의 기능 (문서 전역 keydown 위임).
 *
 *  1. Esc: 열려 있는 모든 모달/팝업/컨텍스트 메뉴 닫기
 *  2. Enter: 활성 모달의 기본(저장/확인) 버튼 클릭 (TEXTAREA 제외)
 *  3. Tab / Shift+Tab: 모달 내부로 포커스 가두기 (Focus Trap)
 *  4. ↑/↓: 모달 내 포커스 가능한 요소 간 순환 이동
 *
 * 참고: 공용 알림/확인 대화상자(DialogService)는 캡처 단계에서 키를 가로채므로
 * 이 핸들러보다 항상 우선합니다.
 */

class ModalKeyboard {
  /**
   * 문서 전역 keydown 리스너를 등록합니다. (앱 구동 시 1회 호출)
   * @param {object} deps 의존성
   * @param {function(): object} deps.getSearchEngine 포커스 복원용 QuickSearchEngine 게터
   */
  static init({ getSearchEngine }) {
    document.addEventListener('keydown', (e) => {
      if (e.isComposing) return;

      // 1. Esc 키로 모든 모달 닫기
      if (e.key === 'Escape') {
        let closedMedModal = false;
        const modals = ['editMedicineModal', 'addCategoryModal', 'editCategoryModal', 'prescriptionDetailModal', 'quantityPopup', 'settingsModal', 'presetLoadModal', 'presetDetailModal'];
        modals.forEach(id => {
          const el = document.getElementById(id);
          if (el && el.classList.contains('show')) {
            el.classList.remove('show');
            if (id === 'editMedicineModal') closedMedModal = true;
            if (id === 'addCategoryModal') document.getElementById('newCategoryName').value = '';
            if (id === 'editCategoryModal') document.getElementById('editCategoryName').value = '';
            if (id === 'quantityPopup') document.getElementById('popupQuantityInput').value = '';
          }
        });
        const medCtx = document.getElementById('medContextMenu');
        const prescCtx = document.getElementById('prescContextMenu');
        const presetCtx = document.getElementById('presetContextMenu');
        if (medCtx) medCtx.style.display = 'none';
        if (prescCtx) prescCtx.style.display = 'none';
        if (presetCtx) presetCtx.style.display = 'none';

        const searchEngine = getSearchEngine();
        if (closedMedModal && searchEngine) {
          searchEngine.setFocusState('search');
        }
      }

      // 2. 모달 활성화 시 Enter 입력 처리 (저장/확인)
      if (e.key === 'Enter') {
        const activeModal = document.querySelector('.modal-overlay.show');
        if (activeModal && document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          const saveBtn = activeModal.querySelector('.btn-primary, #btnViewPrescClose');
          if (saveBtn) {
            saveBtn.click();
          }
        }
      }

      // 3. Tab / Shift+Tab 포커스 트랩 (Focus Trap)
      if (e.key === 'Tab') {
        const activeModal = Array.from(document.querySelectorAll('.modal-overlay.show, .popup-overlay.show'))[0];
        if (activeModal) {
          const focusableElements = Array.from(activeModal.querySelectorAll('input:not([type="hidden"]), select, textarea, button, [tabindex="0"]'));
          if (focusableElements.length > 0) {
            const firstEl = focusableElements[0];
            const lastEl = focusableElements[focusableElements.length - 1];

            // 현재 활성 포커스된 엘리먼트가 모달 내부에 위치해 있는지 검사
            const isFocusInside = focusableElements.includes(document.activeElement);

            if (!isFocusInside) {
              // 포커스가 모달 내부에 없으면 무조건 첫 번째 인풋으로 강제 포커싱
              firstEl.focus();
              e.preventDefault();
            } else if (e.shiftKey) {
              // Shift + Tab: 첫 요소에서 뒤로가면 마지막 요소로
              if (document.activeElement === firstEl) {
                lastEl.focus();
                e.preventDefault();
              }
            } else {
              // Tab: 마지막 요소에서 넘어가면 첫 요소로
              if (document.activeElement === lastEl) {
                firstEl.focus();
                e.preventDefault();
              }
            }
          }
        }
      }

      // 4. 모달 내 방향키 상하 이동 (포커스 이동)
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const activeModal = Array.from(document.querySelectorAll('.modal-overlay.show, .popup-overlay.show'))[0];
        if (activeModal) {
          const activeEl = document.activeElement;
          // SELECT와 TEXTAREA를 제외한 요소(INPUT, BUTTON 등)에서 방향키로 이동
          if (activeEl && activeEl.tagName !== 'SELECT' && activeEl.tagName !== 'TEXTAREA') {
            const focusableElements = Array.from(activeModal.querySelectorAll('input:not([type="hidden"]), select, textarea, button, [tabindex="0"]'));
            if (focusableElements.length > 0) {
              const idx = focusableElements.indexOf(activeEl);
              if (idx !== -1) {
                e.preventDefault();
                let targetIdx;
                if (e.key === 'ArrowDown') {
                  targetIdx = (idx + 1) % focusableElements.length;
                } else {
                  targetIdx = (idx - 1 + focusableElements.length) % focusableElements.length;
                }
                const nextEl = focusableElements[targetIdx];
                nextEl.focus();
                if (nextEl.tagName === 'INPUT' && typeof nextEl.select === 'function') {
                  nextEl.select();
                }
              }
            }
          }
        }
      }
    });
  }
}

module.exports = ModalKeyboard;
