/**
 * @file CategoryModal.js
 * @description 카테고리 추가/수정 모달 컴포넌트.
 *
 * 추가(addCategoryModal)와 수정(editCategoryModal)은 서로 다른 모달 DOM을 사용합니다.
 * 저장 성공 시 3개 탭(조회/처방/일괄작업)의 카테고리 탭바를 모두 다시 그립니다.
 */

class CategoryModal {
  /**
   * @param {object} app App 코디네이터
   */
  constructor(app) {
    this.app = app;
  }

  get manager() { return this.app.manager; }
  get state() { return this.app.state; }
  get dialogs() { return this.app.dialogs; }

  /** 모달 저장/취소 버튼 이벤트를 바인딩합니다. */
  bindEvents() {
    // 카테고리 생성 취소/저장
    document.getElementById('btnCategoryCancel').addEventListener('click', () => {
      document.getElementById('addCategoryModal').classList.remove('show');
      document.getElementById('newCategoryName').value = '';
    });
    document.getElementById('btnCategorySave').addEventListener('click', () => this.handleAddSave());

    // 카테고리 수정 취소/저장
    document.getElementById('btnEditCategoryCancel').addEventListener('click', () => {
      document.getElementById('editCategoryModal').classList.remove('show');
      document.getElementById('editCategoryName').value = '';
      this.state.contextTargetCategoryId = null;
    });
    document.getElementById('btnEditCategorySave').addEventListener('click', () => this.handleEditSave());
  }

  /** 카테고리 추가 모달을 엽니다. */
  openAdd() {
    document.getElementById('addCategoryModal').classList.add('show');
    setTimeout(() => {
      document.getElementById('newCategoryName').focus();
    }, 50);
  }

  /**
   * 카테고리 수정 모달을 대상 카테고리 정보로 채워 엽니다.
   * @param {object} category 수정할 카테고리 행 객체
   */
  openEdit(category) {
    document.getElementById('editCategoryId').value = category.id;
    document.getElementById('editCategoryName').value = category.name;
    document.getElementById('editCategoryModal').classList.add('show');
    setTimeout(() => {
      document.getElementById('editCategoryName').focus();
    }, 50);
  }

  /** 새 카테고리를 저장하고 관련 UI를 갱신합니다. */
  handleAddSave() {
    const input = document.getElementById('newCategoryName');
    const name = input.value.trim();
    if (!name) {
      this.dialogs.showAlert('카테고리명을 입력해 주세요.');
      return;
    }

    try {
      this.manager.addCategory(name);
      this.dialogs.showToast(`✨ 새 카테고리 "${name}"이(가) 등록되었습니다.`);

      // 모달 닫기
      document.getElementById('addCategoryModal').classList.remove('show');
      input.value = '';

      // 각 탭별 카테고리 컨테이너 및 약재 목록 리렌더링
      this.app.medicineList.refreshCategoryTabs();
      this.app.medicineList.render();
    } catch (err) {
      this.dialogs.showAlert(`카테고리 등록 실패: ${err.message}`);
    }
  }

  /** 카테고리명 변경을 저장하고 관련 UI를 갱신합니다. */
  handleEditSave() {
    const idStr = document.getElementById('editCategoryId').value;
    const input = document.getElementById('editCategoryName');
    const name = input.value.trim();

    if (!name) {
      this.dialogs.showAlert('카테고리명을 입력해 주세요.');
      return;
    }
    if (!idStr) return;

    try {
      this.manager.updateCategory(idStr, name);
      this.dialogs.showToast(`✨ 카테고리가 "${name}"(으)로 수정되었습니다.`);

      // 모달 닫기
      document.getElementById('editCategoryModal').classList.remove('show');
      input.value = '';
      this.state.contextTargetCategoryId = null;

      // 각 탭별 카테고리 컨테이너 및 약재 목록 리렌더링
      this.app.medicineList.refreshCategoryTabs();
      this.app.medicineList.render();
    } catch (err) {
      this.dialogs.showAlert(`카테고리 수정 실패: ${err.message}`);
    }
  }
}

module.exports = CategoryModal;
