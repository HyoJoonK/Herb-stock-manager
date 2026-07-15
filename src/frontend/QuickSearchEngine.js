/**
 * @file QuickSearchEngine.js
 * @description 초성 검색, 4대 탭바 글로벌 단축키, Shift 복수 선택 및 탭별 분기 핸들링을 포함하는 키보드 내비게이션 엔진.
 */

class QuickSearchEngine {
  /**
   * @param {object} elements UI DOM 엘리먼트 참조 객체
   * @param {object} callbacks 주요 동작에 따른 콜백 함수 객체
   */
  constructor(elements, callbacks) {
    this.elements = {
      searchInput: elements.searchInput,          // 검색 input
      categoryTabs: elements.categoryTabs,        // 카테고리 탭 영역
      listContainer: elements.listContainer,      // 약재 리스트 컨테이너
      popupContainer: elements.popupContainer,    // g수 입력 팝업
      popupInput: elements.popupInput             // g수 입력 input
    };

    this.callbacks = {
      onFilter: callbacks.onFilter,                     // 필터링 콜백
      onAddToPrescription: callbacks.onAddToPrescription, // 처방 추가 콜백
      getCurrentListItems: callbacks.getCurrentListItems, // 현재 목록 DOM 배열 획득 콜백
      onTabChange: callbacks.onTabChange,               // 탭 변경 콜백 (Alt+1~4 대응)
      onInquiryMed: callbacks.onInquiryMed,             // 조회 탭 엔터 콜백
      onAddToBatch: callbacks.onAddToBatch,             // 일괄 작업 탭 엔터 콜백
      onEditMed: callbacks.onEditMed,                   // 약재 정보 수정 모달 콜백
      onSelectionChange: callbacks.onSelectionChange    // 다중 선택 상태 변경 콜백 (전달되는 인자는 Set<number> 타입입니다)
    };

    // 포커스 상태: 'search' | 'category' | 'list' | 'popup'
    this.state = 'search';
    
    // 카테고리 탭 탐색용 인덱스
    this.currentCategoryIndex = 0;
    
    // 약재 목록 탐색용 인덱스
    this.currentListIndex = -1;
    
    // Shift 다중 선택용 마지막 선택된 인덱스
    this.lastSelectedIndex = -1;
    
    // 복수 선택된 약재 ID 목록 (Set)
    this.selectedIds = new Set();

    // 현재 활성화된 탭 인덱스 (0: 조회, 1: 처방, 2: 발주, 3: 일괄작업)
    this.activeTab = 0;

    // 한국어 초성 매칭용 헬퍼 상수
    this.CHOSUNG_LIST = [
      'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
    ];

    this.init();
  }

  /**
   * 이벤트 초기화 및 글로벌 단축키 바인딩
   */
  init() {
    // 키보드 이벤트 리스너
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    
    // 팝업 열렸을 때 input 포커스 아웃 방어
    this.elements.popupInput.addEventListener('blur', () => {
      if (this.state === 'popup') {
        setTimeout(() => this.elements.popupInput.focus(), 10);
      }
    });

    // 윈도우 전체에 포커스가 다시 들어왔을 때 포커스 복구 안전장치
    window.addEventListener('focus', () => {
      // 모달이나 팝업창이 없는 기본 상태이면서 검색창에 포커스가 없는 경우 검색창으로 포커스 강제
      const activeModal = document.querySelector('.modal-overlay.show, .popup-overlay.show');
      if (!activeModal && this.state === 'search' && document.activeElement !== this.elements.searchInput) {
        this.elements.searchInput.focus();
      }
    });
    
    this.setFocusState('search');
  }

  /**
   * 실시간 검색어 입력 등 상태 리셋이 필요할 때 호출하는 public 메서드.
   * renderer.js의 통합 input 이벤트 리스너에서 직접 호출됩니다.
   */
  resetSearchState() {
    this.state = 'search';
    this.currentListIndex = -1;
    this.lastSelectedIndex = -1;
    this.selectedIds.clear();
    this.callbacks.onSelectionChange(this.selectedIds);
  }


  /**
   * 한국어 초성 추출 헬퍼
   */
  getChoseong(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i) - 44032;
      if (code >= 0 && code <= 11172) {
        result += this.CHOSUNG_LIST[Math.floor(code / 588)];
      } else {
        result += str[i];
      }
    }
    return result;
  }

  /**
   * 검색어 매칭 (초성 검색 지원)
   */
  match(medName, query) {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) return true;

    const cleanMedName = medName.toLowerCase();
    const isChoseongOnly = /^[ㄱ-ㅎ\s]+$/.test(cleanQuery);

    if (isChoseongOnly) {
      const medChoseong = this.getChoseong(cleanMedName);
      return medChoseong.includes(cleanQuery);
    } else {
      return cleanMedName.includes(cleanQuery);
    }
  }

  /**
   * 글로벌 키 입력 인터셉터 및 포커스 상태 기계
   */
  handleKeyDown(e) {
    // 모달창(.modal-overlay.show) 또는 팝업(.popup-overlay.show)이 활성화되어 있는 동안에는 키보드 인터셉트 비활성화
    // 단, 소모량 입력 팝업(#quantityPopup) 자체의 입력 제어를 위해 #quantityPopup은 예외로 둡니다.
    const activeModal = document.querySelector('.modal-overlay.show, .popup-overlay.show:not(#quantityPopup)');
    if (activeModal) {
      return;
    }

    const key = e.key;

    // 우측 메인 패널(.right-main-panel) 내부 입력 칸에 포커스가 있는 경우의 단축키 처리
    const activeElement = document.activeElement;
    const isFocusedInRightPanel = activeElement && activeElement.closest('.right-main-panel');

    if (isFocusedInRightPanel) {
      // 1. 글로벌 단축키 Alt + 1~4 (메인 탭 메뉴 강제 이동)는 우측 패널에서도 여전히 동작
      if (e.altKey && ['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        const tabIndex = parseInt(key) - 1;
        this.activeTab = tabIndex;
        this.callbacks.onTabChange(tabIndex);
        this.setFocusState('search');
        return;
      }
      // 2. 글로벌 단축키 Ctrl+F / Cmd+F (검색창 이동 및 전체선택)도 동작
      if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'f') {
        e.preventDefault();
        this.setFocusState('search');
        return;
      }
      // 3. / 키 입력 시 검색창으로 복귀 (단, 입력필드 등에서 / 가 적히지 않도록 preventDefault)
      if (key === '/') {
        e.preventDefault();
        this.setFocusState('search');
        return;
      }
      // 4. ESC 키 입력 시 검색창으로 복귀
      if (key === 'Escape') {
        e.preventDefault();
        this.setFocusState('search');
        return;
      }
      // 그 외의 키(Tab, Enter, 방향키 등)는 우측 패널 내부 동작(Tab 이동, 인풋 입력 등)을 위해 가로채지 않고 패스
      return;
    }

    // ----------------------------------------------------
    // 글로벌 약재 수정 모달 단축키 (Insert, E, 한글 ㄷ)
    // ----------------------------------------------------
    const isInsertKey = e.code === 'Insert' || key.toLowerCase() === 'insert';
    const isEKey = e.code === 'KeyE' || key.toLowerCase() === 'e' || key === 'ㄷ' || key === 'ㄸ';

    // E/ㄷ 키는 오직 약재 리스트 탐색 상태(this.state === 'list')일 때만 약재 정보 수정을 활성화하고,
    // Insert 키는 검색란 입력 중이든 리스트 탐색 중이든 언제든 활성화시킵니다.
    const canTriggerEdit = isInsertKey || (isEKey && this.state === 'list');

    if (canTriggerEdit) {
      if (this.activeTab === 0 || this.activeTab === 3) {
        const items = this.callbacks.getCurrentListItems();
        let targetIndex = this.currentListIndex;
        if (targetIndex === -1 && items.length > 0) {
          targetIndex = 0; // 디폴트 첫 번째 아이템 선택
        }
        
        if (targetIndex >= 0 && targetIndex < items.length) {
          e.preventDefault();
          e.stopPropagation();
          
          // 검색 입력란 포커스를 강제 해제하여 IME 입력 및 input 이벤트가 추가 발생하여 검색 상태가 리셋되는 현상 방어
          if (this.elements.searchInput && document.activeElement === this.elements.searchInput) {
            this.elements.searchInput.blur();
          }

          const selectedItem = items[targetIndex];
          const medicineId = parseInt(selectedItem.dataset.id);
          if (this.callbacks.onEditMed) {
            this.callbacks.onEditMed(medicineId);
          }
          return;
        }
      }
    }

    // ----------------------------------------------------
    // 글로벌 단축키 1: Alt + 1~4 (메인 탭 메뉴 강제 이동)
    // ----------------------------------------------------
    if (e.altKey && ['1', '2', '3', '4'].includes(key)) {
      e.preventDefault();
      const tabIndex = parseInt(key) - 1;
      this.activeTab = tabIndex;
      this.callbacks.onTabChange(tabIndex);
      this.setFocusState('search');
      return;
    }

    // 발주 예측 탭(Alt+3, 인덱스 2)인 경우 단축키 차단
    if (this.activeTab === 2) {
      return;
    }

    // ----------------------------------------------------
    // 글로벌 단축키 2: Ctrl+F / Cmd+F (검색창 이동 및 전체선택)
    // ----------------------------------------------------
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'f') {
      e.preventDefault();
      this.setFocusState('search');
      return;
    }

    // ----------------------------------------------------
    // 글로벌 단축키 3: / (검색창 리턴)
    // ----------------------------------------------------
    if (key === '/' && this.state !== 'search' && this.state !== 'popup') {
      // Input창이나 Textarea가 활성화되지 않은 상태인지 이중 체크
      if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        this.setFocusState('search');
        return;
      }
    }

    // ----------------------------------------------------
    // 상태별 키 분기 처리
    // ----------------------------------------------------
    switch (this.state) {
      case 'search':
        this.handleSearchState(e);
        break;
      case 'category':
        this.handleCategoryState(e);
        break;
      case 'list':
        this.handleListState(e);
        break;
      case 'popup':
        this.handlePopupState(e);
        break;
    }
  }

  /**
   * 1단계: 검색창 상태의 키 핸들링
   */
  handleSearchState(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      this.setFocusState('category');
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.setFocusState('list');
    }
  }

  /**
   * 2단계: 카테고리 탭 상태의 키 핸들링
   */
  handleCategoryState(e) {
    const tabs = this.getCategoryElements();
    if (tabs.length === 0) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.currentCategoryIndex = (this.currentCategoryIndex + 1) % tabs.length;
      this.updateActiveCategory();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.currentCategoryIndex = (this.currentCategoryIndex - 1 + tabs.length) % tabs.length;
      this.updateActiveCategory();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.setFocusState('list');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.setFocusState('search');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.setFocusState('search');
    }
  }

  /**
   * 3단계: 약재 목록 상태의 키 핸들링 (Shift 다중 선택 및 탭별 Enter 제어 분기)
   */
  handleListState(e) {
    const items = this.callbacks.getCurrentListItems();
    if (items.length === 0) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setFocusState('search');
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const prevIndex = this.currentListIndex;
      this.currentListIndex = (this.currentListIndex + 1) % items.length;
      
      // Shift 키 누르고 방향키 조작 시 복수 선택 처리
      if (e.shiftKey) {
        this.handleShiftSelection(prevIndex, this.currentListIndex, items);
      } else {
        // 단일 선택으로 환원
        this.selectedIds.clear();
        const activeItem = items[this.currentListIndex];
        if (activeItem) {
          this.selectedIds.add(parseInt(activeItem.dataset.id));
        }
        this.lastSelectedIndex = this.currentListIndex;
        this.callbacks.onSelectionChange(this.selectedIds);
      }
      this.updateActiveListItem(items);

    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = this.currentListIndex;
      if (this.currentListIndex <= 0) {
        this.setFocusState('category');
      } else {
        this.currentListIndex = this.currentListIndex - 1;
        
        if (e.shiftKey) {
          this.handleShiftSelection(prevIndex, this.currentListIndex, items);
        } else {
          this.selectedIds.clear();
          const activeItem = items[this.currentListIndex];
          if (activeItem) {
            this.selectedIds.add(parseInt(activeItem.dataset.id));
          }
          this.lastSelectedIndex = this.currentListIndex;
          this.callbacks.onSelectionChange(this.selectedIds);
        }
        this.updateActiveListItem(items);
      }

    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.currentListIndex >= 0 && this.currentListIndex < items.length) {
        const selectedItem = items[this.currentListIndex];
        const medicineId = parseInt(selectedItem.dataset.id);
        
        // 메인 탭바 활성화 상태(this.activeTab)에 따라 분기
        if (this.activeTab === 0) {
          // [조회] 탭: 우측에 상세 정보 및 그래프 표시 콜백 트리거
          this.callbacks.onInquiryMed(medicineId);
        } else if (this.activeTab === 1) {
          // [처방] 탭: g수 입력 팝업 띄우기 (Shift 다중 선택 혹은 Shift+Enter 시 팝업 생략)
          if (this.selectedIds.size > 1 || e.shiftKey) {
            if (this.selectedIds.size > 1) {
              this.selectedIds.forEach(id => this.callbacks.onAddToPrescription(id, 10));
            } else {
              this.callbacks.onAddToPrescription(medicineId, 10);
            }
            this.selectedIds.clear();
            this.callbacks.onSelectionChange(this.selectedIds);
          } else {
            this.openQuantityPopup(selectedItem);
          }
        } else if (this.activeTab === 3) {
          // [일괄 작업] 탭: 우측 테이블에 복수 또는 단일 약재 추가
          if (this.selectedIds.size > 1) {
            // 다중 선택된 모든 ID를 추가
            this.selectedIds.forEach(id => this.callbacks.onAddToBatch(id));
          } else {
            this.callbacks.onAddToBatch(medicineId);
          }
          this.selectedIds.clear();
          this.callbacks.onSelectionChange(this.selectedIds);
        }
      }

    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.setFocusState('search');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        this.setFocusState('category');
      } else {
        this.setFocusState('search');
      }
    }
  }

  /**
   * Shift 키 조작을 통한 다중 선택 연산 및 이벤트 핸들링
   * @param {number} startIdx 
   * @param {number} endIdx 
   * @param {HTMLElement[]} items 
   */
  handleShiftSelection(startIdx, endIdx, items) {
    if (this.lastSelectedIndex === -1) {
      this.lastSelectedIndex = startIdx;
    }
    
    const anchor = this.lastSelectedIndex;
    const min = Math.min(anchor, endIdx);
    const max = Math.max(anchor, endIdx);

    // 현재 쿼리 뷰에 매칭되는 아이템들을 범위 선택
    this.selectedIds.clear();
    for (let i = min; i <= max; i++) {
      if (items[i]) {
        this.selectedIds.add(parseInt(items[i].dataset.id));
      }
    }
    this.callbacks.onSelectionChange(this.selectedIds);
  }

  /**
   * 마우스 클릭 시 단일/복수 선택 처리기 (Shift 클릭 바인딩용)
   * @param {MouseEvent} e 
   * @param {HTMLElement} clickedItem 
   */
  handleMouseClickSelection(e, clickedItem) {
    const items = this.callbacks.getCurrentListItems();
    const clickIdx = items.indexOf(clickedItem);
    if (clickIdx === -1) return;

    this.currentListIndex = clickIdx;

    if (e.shiftKey && this.lastSelectedIndex !== -1) {
      // Shift 클릭 다중 선택
      this.handleShiftSelection(this.lastSelectedIndex, clickIdx, items);
    } else {
      // 단일 선택
      this.selectedIds.clear();
      this.selectedIds.add(parseInt(clickedItem.dataset.id));
      this.lastSelectedIndex = clickIdx;
      this.callbacks.onSelectionChange(this.selectedIds);
    }
    
    this.setFocusState('list');
  }

  /**
   * 4단계: g수 입력 팝업 상태의 키 핸들링
   */
  handlePopupState(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = parseFloat(this.elements.popupInput.value);
      if (isNaN(val) || val <= 0) {
        alert('올바른 소모 g수를 입력해 주세요.');
        this.elements.popupInput.select();
        return;
      }
      
      const medicineId = parseInt(this.elements.popupContainer.dataset.medicineId);
      this.callbacks.onAddToPrescription(medicineId, val);
      
      this.closeQuantityPopup();
      this.setFocusState('search');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.closeQuantityPopup();
      this.setFocusState('list');
    }
  }

  /**
   * 포커스 상태 전환 및 그에 따른 UI 연출 처리
   */
  setFocusState(newState) {
    this.state = newState;
    
    // 전체 포커스 클래스 제거
    document.querySelectorAll('.keyboard-focused').forEach(el => el.classList.remove('keyboard-focused'));

    if (newState === 'search' && this.elements.searchInput) {
      this.elements.searchInput.classList.add('keyboard-focused');
      
      // 한글 IME composition 버퍼 초기화를 위해 value 재할당
      const val = this.elements.searchInput.value;
      this.elements.searchInput.value = '';
      this.elements.searchInput.value = val;

      this.elements.searchInput.focus();
      this.elements.searchInput.select();
      
      // 모달 닫힘 등으로 브라우저가 포커스를 바디로 강제 초기화하는 현상을 방어하기 위한 비동기 지연 포커스 안전장치
      setTimeout(() => {
        if (this.state === 'search' && this.elements.searchInput && document.activeElement !== this.elements.searchInput) {
          const innerVal = this.elements.searchInput.value;
          this.elements.searchInput.value = '';
          this.elements.searchInput.value = innerVal;
          this.elements.searchInput.focus();
          this.elements.searchInput.select();
        }
      }, 50);

      this.currentListIndex = -1;
      this.clearActiveListItems();
    } else if (newState === 'category') {
      const tabs = this.getCategoryElements();
      if (tabs.length > 0) {
        tabs[this.currentCategoryIndex].classList.add('keyboard-focused');
        tabs[this.currentCategoryIndex].scrollIntoView({ block: 'nearest' });
      }
      this.currentListIndex = -1;
      this.clearActiveListItems();
    } else if (newState === 'list') {
      const items = this.callbacks.getCurrentListItems();
      if (items.length > 0) {
        if (this.currentListIndex === -1) this.currentListIndex = 0;
        this.updateActiveListItem(items);
      }
    } else if (newState === 'popup') {
      this.elements.popupInput.focus();
      this.elements.popupInput.select();
    }
  }

  /**
   * 카테고리 실시간 변경 스타일 갱신 및 필터 트리거
   */
  updateActiveCategory() {
    const tabs = this.getCategoryElements();
    tabs.forEach(tab => tab.classList.remove('keyboard-focused', 'active'));
    
    const activeTab = tabs[this.currentCategoryIndex];
    if (activeTab) {
      activeTab.classList.add('keyboard-focused', 'active');
      activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      
      const categoryId = activeTab.dataset.categoryId || '전체';
      this.callbacks.onFilter(categoryId);
    }
  }

  /**
   * 약재 목록 탐색 시 active 표시 및 스크롤 자동 이동 보정
   */
  updateActiveListItem(items) {
    this.clearActiveListItems();
    
    // 키보드 탐색 포커스 표시
    const activeItem = items[this.currentListIndex];
    if (activeItem) {
      activeItem.classList.add('keyboard-focused');
      activeItem.scrollIntoView({
        behavior: 'instant',
        block: 'nearest'
      });
    }

    // 복수 선택 및 단일 선택된 아이템들 비주얼 적용
    items.forEach(item => {
      const id = parseInt(item.dataset.id);
      if (this.selectedIds.has(id)) {
        item.classList.add('active', 'multi-selected');
      } else {
        item.classList.remove('active', 'multi-selected');
      }
    });
  }

  clearActiveListItems() {
    const items = this.callbacks.getCurrentListItems();
    items.forEach(item => item.classList.remove('keyboard-focused', 'active', 'multi-selected'));
  }

  /**
   * g수 입력 팝업 띄우기
   */
  openQuantityPopup(item) {
    const medicineId = item.dataset.id;
    const medicineName = item.querySelector('.med-name').textContent;
    const stockInfo = item.querySelector('.med-stock').textContent;

    this.elements.popupContainer.dataset.medicineId = medicineId;
    this.elements.popupContainer.querySelector('.popup-med-name').textContent = medicineName;
    this.elements.popupContainer.querySelector('.popup-med-stock').textContent = stockInfo;
    
    this.elements.popupInput.value = '10';
    
    this.elements.popupContainer.classList.add('show');
    this.setFocusState('popup');
  }

  closeQuantityPopup() {
    this.elements.popupContainer.classList.remove('show');
    this.elements.popupInput.blur();
  }

  getCategoryElements() {
    return Array.from(this.elements.categoryTabs.querySelectorAll('.category-tab'));
  }
}

if (typeof window !== 'undefined') {
  window.QuickSearchEngine = QuickSearchEngine;
}
if (typeof module !== 'undefined') {
  module.exports = QuickSearchEngine;
}
