/**
 * @file MedicineListView.js
 * @description 좌측 약재 목록 + 카테고리 탭바 공용 View.
 *
 * 조회/처방/일괄작업 3개 탭이 같은 구조의 약재 목록 패널을 가지므로,
 * 이 View 하나가 state.currentTab에 따라 대상 컨테이너를 골라 렌더링합니다.
 *
 * 소유 영역:
 *  - 약재 목록 렌더링 (검색어/카테고리 필터, 다중 선택 상태 반영)
 *  - 카테고리 탭바 렌더링 및 클릭/우클릭 처리
 *  - 3개 탭 검색창의 실시간 검색 바인딩
 *  - 약재 우클릭 컨텍스트 메뉴 액션 (수정/삭제)
 */

const BaseView = require('./BaseView');
const ContextMenu = require('../components/ContextMenu');
const { escapeHtml } = require('../core/utils');
const { DEFAULT_CATEGORY_ID } = require('../../backend/db/ids');

class MedicineListView extends BaseView {
  /**
   * 카테고리 동적 탭을 렌더링합니다. (기존 활성 탭 선택 상태 유지)
   * @param {HTMLElement} container 카테고리 탭 컨테이너
   */
  renderCategoryTabs(container) {
    if (!container) return;

    const categories = this.manager.getAllCategories();

    // 현재 카테고리 탭들의 포커스 상태 유지를 위해 선택 정보 수집
    const activeTab = container.querySelector('.category-tab.active');
    const activeCategoryId = activeTab ? activeTab.dataset.categoryId : '전체';

    let html = `<button class="category-tab ${activeCategoryId === '전체' ? 'active' : ''}" data-category-id="전체">전체</button>`;
    categories.forEach(cat => {
      html += `<button class="category-tab ${activeCategoryId == cat.id ? 'active' : ''}" data-category-id="${escapeHtml(cat.id)}">${escapeHtml(cat.name)}</button>`;
    });
    // 카테고리 동적 추가 + 단추 추가
    html += `<button class="category-add-btn" id="btnCategoryModalOpen">➕ 카테고리 추가</button>`;

    container.innerHTML = html;
  }

  /** 3개 탭의 카테고리 탭바를 모두 다시 그립니다. (카테고리 추가/수정/삭제 후 호출) */
  refreshCategoryTabs() {
    const containers = ['inquiryCategoryContainer', 'prescriptionCategoryContainer', 'batchCategoryContainer'];
    containers.forEach(cId => {
      const el = this.$(cId);
      if (el) {
        this.renderCategoryTabs(el);
      }
    });
  }

  /**
   * 활성 탭에 맞춰 약재 리스트를 렌더링합니다.
   * @param {string|null} categoryFilter 강제 적용할 카테고리 ID (null이면 활성 탭 기준)
   */
  render(categoryFilter = null) {
    let listContainerId, searchInputId, categoryContainerId;

    if (this.state.currentTab === 'inquiry') {
      listContainerId = 'inquiryMedicineList';
      searchInputId = 'inquirySearchInput';
      categoryContainerId = 'inquiryCategoryContainer';
    } else if (this.state.currentTab === 'prescription') {
      listContainerId = 'prescriptionMedicineList';
      searchInputId = 'prescriptionSearchInput';
      categoryContainerId = 'prescriptionCategoryContainer';
    } else if (this.state.currentTab === 'batch') {
      listContainerId = 'batchMedicineList';
      searchInputId = 'batchSearchInput';
      categoryContainerId = 'batchCategoryContainer';
    } else {
      return; // 발주 예측 탭은 좌측 목록 없음
    }

    const listContainer = this.$(listContainerId);
    const searchInput = this.$(searchInputId);
    const categoryContainer = this.$(categoryContainerId);

    if (!listContainer) return;

    const searchQuery = searchInput ? searchInput.value : '';

    let targetCategory = categoryFilter;
    if (!targetCategory) {
      const activeTab = categoryContainer ? categoryContainer.querySelector('.category-tab.active') : null;
      targetCategory = activeTab ? activeTab.dataset.categoryId : '전체';
    }

    const medicines = this.manager.getAllMedicines();

    // 필터링 처리
    const filtered = medicines.filter(med => {
      // 1. 카테고리 필터
      if (targetCategory !== '전체' && med.category_id != targetCategory) {
        return false;
      }
      // 2. 검색어 매칭 (이명까지 포함, 초성 검색 지원)
      if (searchQuery) {
        return this.searchEngine.match(med.name, searchQuery, med.aliases);
      }
      return true;
    });

    listContainer.innerHTML = '';

    if (filtered.length === 0) {
      listContainer.innerHTML = `<div class="empty-state">검색 결과가 없습니다.</div>`;
      return;
    }

    filtered.forEach(med => {
      const isUnderSafety = med.total_stock < med.safety_stock;
      const item = document.createElement('div');

      // 다중 선택 상태 반영
      const isMultiSelected = this.searchEngine.selectedIds.has(med.id);
      item.className = `medicine-item ${isUnderSafety ? 'warning-border' : ''} ${isMultiSelected ? 'multi-selected' : ''}`;
      item.dataset.id = med.id;
      item.dataset.packSize = med.pack_size;

      const statusBadge = isUnderSafety
        ? `<span class="status-badge status-warning">재고부족 (안전: ${escapeHtml(med.safety_stock)}g)</span>`
        : `<span class="status-badge status-normal">적정</span>`;

      const aliasText = med.aliases && med.aliases.length > 0 ? ` <span class="med-aliases" style="font-size:11px; color:var(--color-text-muted); font-weight:normal;">(${escapeHtml(med.aliases.join(', '))})</span>` : '';
      item.innerHTML = `
        <div class="med-info">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="med-name">${escapeHtml(med.name)}${aliasText}</span>
            <span class="status-badge" style="background:#f1f4f2; color:var(--color-text-muted);">${escapeHtml(med.category_name)}</span>
          </div>
          <div class="med-stock">${escapeHtml(med.formatted_stock)}</div>
        </div>
        <div style="text-align: right; display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
          ${statusBadge}
          <span style="font-size:10px; color:var(--color-text-muted);">규격: ${escapeHtml(med.pack_size)}${escapeHtml(med.unit)}</span>
        </div>
      `;

      // 마우스 이벤트 연결 (Shift 다중 선택 연동)
      item.addEventListener('click', (e) => {
        this.searchEngine.handleMouseClickSelection(e, item);

        // 조회 탭에서는 단순 1회 클릭 시에도 정보 조회가 실시간 연동되면 UX 상 매우 좋습니다.
        if (this.state.currentTab === 'inquiry') {
          this.app.inquiry.showDetails(med.id);
        }
      });

      // 마우스 더블클릭 이벤트 연결 (엔터 키와 똑같은 기능 수행)
      item.addEventListener('dblclick', (e) => {
        e.preventDefault();

        // 더블클릭한 아이템 선택 상태 동기화
        this.searchEngine.selectedIds.clear();
        this.searchEngine.selectedIds.add(med.id);
        this.searchEngine.lastSelectedIndex = filtered.indexOf(med);
        this.searchEngine.currentListIndex = filtered.indexOf(med);
        this.searchEngine.callbacks.onSelectionChange(this.searchEngine.selectedIds);

        const items = Array.from(listContainer.querySelectorAll('.medicine-item'));
        this.searchEngine.updateActiveListItem(items);

        // 탭별 타겟 기능 트리거
        if (this.state.currentTab === 'inquiry') {
          this.app.inquiry.showDetails(med.id);
        } else if (this.state.currentTab === 'prescription') {
          this.searchEngine.openQuantityPopup(item);
        } else if (this.state.currentTab === 'batch') {
          this.app.batch.addMedicine(med.id);
        }
      });

      // 마우스 우클릭 (Context Menu) 수정 모달 트리거
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.state.contextTargetMedId = med.id;
        ContextMenu.show('medContextMenu', e.pageX, e.pageY);
      });

      listContainer.appendChild(item);
    });

    if (this.searchEngine && this.searchEngine.state === 'list') {
      const items = Array.from(listContainer.querySelectorAll('.medicine-item'));
      this.searchEngine.updateActiveListItem(items);
    }
  }

  /** 검색창/카테고리/컨텍스트 메뉴 관련 이벤트를 바인딩합니다. */
  bindEvents() {
    // 3개 탭 검색창에 실시간 검색(Filter) 및 포커스 상태 동기화 바인딩
    ['inquirySearchInput', 'prescriptionSearchInput', 'batchSearchInput'].forEach(id => {
      const inputEl = this.$(id);
      if (inputEl) {
        inputEl.addEventListener('input', () => {
          // QuickSearchEngine의 공용 상태 리셋 메서드를 명시적으로 호출합니다.
          this.searchEngine.resetSearchState();
          this.render();
        });
        inputEl.addEventListener('focus', () => {
          if (this.searchEngine.state !== 'search') {
            this.searchEngine.setFocusState('search');
          }
        });
      }
    });

    // 카테고리 클릭 및 동적 모달 트리거 바인딩 (이벤트 위임)
    document.addEventListener('click', (e) => {
      // 1. 카테고리 탭 클릭 시 필터링 변경
      if (e.target.classList.contains('category-tab')) {
        const parent = e.target.parentElement;
        const tabs = Array.from(parent.querySelectorAll('.category-tab'));
        this.searchEngine.currentCategoryIndex = tabs.indexOf(e.target);

        tabs.forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');

        this.render();
        this.searchEngine.setFocusState('category');
      }

      // 2. 동적 카테고리 추가 "+" 버튼
      if (e.target.id === 'btnCategoryModalOpen') {
        this.app.categoryModal.openAdd();
      }
    });

    // 카테고리 탭 우클릭 감지 (이벤트 위임)
    document.addEventListener('contextmenu', (e) => {
      if (e.target.classList.contains('category-tab')) {
        const catId = e.target.dataset.categoryId;
        if (catId === '전체') return; // '전체' 탭은 수정/삭제 불가

        if (catId === DEFAULT_CATEGORY_ID) {
          e.preventDefault();
          this.dialogs.showToast('ℹ️ 기본 카테고리는 수정하거나 삭제할 수 없습니다.');
          return;
        }

        e.preventDefault();
        this.state.contextTargetCategoryId = catId;
        ContextMenu.show('categoryContextMenu', e.pageX, e.pageY);
      }
    });

    // -- 약재 우클릭 컨텍스트 메뉴 액션 --------------------------------------
    this.$('ctxMenuEdit').addEventListener('click', () => {
      if (this.state.contextTargetMedId !== null) {
        this.app.medicineModal.openEdit(this.state.contextTargetMedId);
        this.state.contextTargetMedId = null;
      }
    });

    this.$('ctxMenuDelete').addEventListener('click', async () => {
      if (this.state.contextTargetMedId !== null) {
        const med = this.manager.getAllMedicines().find(m => m.id === this.state.contextTargetMedId);
        if (await this.dialogs.showConfirm(`⚠️ 정말로 "${med.name}" 약재를 삭제하시겠습니까? 관련 입출고 로그, 처방 내역 및 프리셋 구성 정보가 모두 영구 유실됩니다.`)) {
          try {
            this.manager.deleteMedicine(this.state.contextTargetMedId);
          } catch (err) {
            this.dialogs.showToast(`⚠️ 약재 삭제 실패: ${err.message}`, true);
            this.state.contextTargetMedId = null;
            return;
          }
          this.dialogs.showToast(`🗑️ "${med.name}" 약재 데이터가 영구 삭제되었습니다.`, true);

          // 조회 탭에서 삭제된 약재를 보고 있었다면 상세 패널 비우기
          if (this.state.currentInquiryMedId === this.state.contextTargetMedId) {
            this.app.inquiry.clearDetails();
          }

          this.render();
          this.app.predict.render();
        }
        this.state.contextTargetMedId = null;
      }
    });

    // -- 카테고리 우클릭 컨텍스트 메뉴 액션 ----------------------------------
    this.$('ctxCategoryEdit').addEventListener('click', () => {
      if (this.state.contextTargetCategoryId !== null) {
        const cat = this.manager.getAllCategories().find(c => c.id === this.state.contextTargetCategoryId);
        if (cat) {
          this.app.categoryModal.openEdit(cat);
        }
      }
    });

    this.$('ctxCategoryDelete').addEventListener('click', async () => {
      if (this.state.contextTargetCategoryId !== null) {
        const cat = this.manager.getAllCategories().find(c => c.id === this.state.contextTargetCategoryId);
        if (cat) {
          if (await this.dialogs.showConfirm(`⚠️ 정말로 "${cat.name}" 카테고리를 삭제하시겠습니까?\n카테고리가 삭제되면 이 카테고리에 속한 약재들은 모두 '미분류' 카테고리로 이동됩니다.`)) {
            try {
              this.manager.deleteCategory(this.state.contextTargetCategoryId);
              this.dialogs.showToast(`🗑️ "${cat.name}" 카테고리가 삭제되었습니다.`, true);

              // UI 갱신
              this.refreshCategoryTabs();
              this.render();
            } catch (err) {
              this.dialogs.showAlert(`카테고리 삭제 실패: ${err.message}`);
            }
          }
        }
        this.state.contextTargetCategoryId = null;
      }
    });
  }
}

module.exports = MedicineListView;
