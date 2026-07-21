/**
 * @file App.js
 * @description 렌더러 애플리케이션 코디네이터(조립자).
 *
 * 역할:
 *  1. 백엔드 서비스 초기화 (InventoryManager / SmartPredictor / CSVHandler)
 *  2. core(상태/버스/대화상자) + View + 컴포넌트 객체 그래프 조립
 *  3. QuickSearchEngine 생성 및 콜백 연결 (키보드 워크플로우 ↔ View 연동)
 *  4. 메인 탭바 전환(switchTab)과 CSV 가져오기/내보내기 등 전역 액션
 *
 * View/컴포넌트는 생성자에서 받은 app(this)을 통해 서로의 공개 메서드를 호출합니다.
 * 예: this.app.medicineList.render(), this.app.prescription.renderPastPrescriptions()
 */

const path = require('path');
const InventoryManager = require('../backend/InventoryManager');
const CSVHandler = require('../backend/services/CSVHandler');
const SmartPredictor = require('../backend/services/SmartPredictor');

const AppState = require('./core/AppState');
const EventBus = require('./core/EventBus');
const DialogService = require('./core/DialogService');
const NumericInput = require('./core/NumericInput');
const ModalKeyboard = require('./core/ModalKeyboard');

const MedicineListView = require('./views/MedicineListView');
const InquiryView = require('./views/InquiryView');
const PrescriptionView = require('./views/PrescriptionView');
const PredictView = require('./views/PredictView');
const BatchView = require('./views/BatchView');
const NotificationView = require('./views/NotificationView');

const QuickSearchEngine = require('./QuickSearchEngine');

const MedicineModal = require('./components/MedicineModal');
const CategoryModal = require('./components/CategoryModal');
const PrescriptionDetailModal = require('./components/PrescriptionDetailModal');
const SettingsModal = require('./components/SettingsModal');

class App {
  constructor() {
    /** 공유 UI 상태 (구 renderer.js의 전역 let 변수들) */
    this.state = new AppState();

    /** 뷰 간 이벤트 버스 (원격 변경 알림 등) */
    this.bus = new EventBus();

    /** 알림/확인/토스트 (window.showAlert/showConfirm 전역도 여기서 노출) */
    this.dialogs = new DialogService({ getSearchEngine: () => this.searchEngine });

    /** 백엔드 서비스 (init에서 채워짐) */
    this.manager = null;
    this.predictor = null;
    this.csvHandler = null;

    /** 키보드 내비게이션 엔진 (init에서 생성) */
    this.searchEngine = null;
  }

  /**
   * 앱을 구동합니다. (DOMContentLoaded 이후 1회 호출)
   * 순서: DB 초기화 → 객체 그래프 조립 → 검색 엔진 → 이벤트 바인딩 → 첫 탭 렌더링
   */
  init() {
    this.initDatabase();

    // ---- View / 컴포넌트 조립 ------------------------------------------------
    /** 좌측 약재 목록 + 카테고리 탭 (조회/처방/일괄 3개 탭 공용) */
    this.medicineList = new MedicineListView(this);
    /** [조회] 탭 우측 상세 패널 */
    this.inquiry = new InquiryView(this);
    /** [처방] 탭 (작성/이력/프리셋/편집 모드) */
    this.prescription = new PrescriptionView(this);
    /** [발주 예측] 탭 */
    this.predict = new PredictView(this);
    /** [일괄 작업] 탭 */
    this.batch = new BatchView(this);
    /** 알림함 팝오버 */
    this.notifications = new NotificationView(this);

    /** 약재 추가/수정 모달 */
    this.medicineModal = new MedicineModal(this);
    /** 카테고리 추가/수정 모달 */
    this.categoryModal = new CategoryModal(this);
    /** 처방 이력 상세 모달 */
    this.prescriptionDetailModal = new PrescriptionDetailModal(this);
    /** 설정(Supabase/업데이트) 모달 */
    this.settingsModal = new SettingsModal(this);

    // ---- 키보드 내비게이션 엔진 ----------------------------------------------
    this.initSearchEngine();

    // ---- 이벤트 바인딩 (각 View/컴포넌트가 자기 영역을 바인딩) -----------------
    this.medicineList.bindEvents();
    this.inquiry.bindEvents();
    this.prescription.bindEvents();
    this.predict.bindEvents();
    this.batch.bindEvents();
    this.notifications.bindEvents();
    this.medicineModal.bindEvents();
    this.categoryModal.bindEvents();
    this.prescriptionDetailModal.bindEvents();
    this.settingsModal.bindEvents();
    this.bindTabBar();
    this.bindCsvActions();

    // 전역 편의 기능 (숫자 입력 정제, 모달 키보드 제어)
    NumericInput.init();
    ModalKeyboard.init({ getSearchEngine: () => this.searchEngine });

    // 원격(Realtime) 변경 수신 시 관련 화면 갱신
    this.bus.on('remote-data-changed', () => {
      console.log('🔔 Supabase Realtime: 원격 데이터 변경 감지, 화면을 갱신합니다.');
      this.medicineList.render();
      const viewPrescTable = document.getElementById('pastPrescriptionsBody');
      if (viewPrescTable) this.prescription.renderPastPrescriptions();
    });

    // 알림 배지 초기 렌더링 및 초기 탭 진입
    this.notifications.render();
    this.switchTab('inquiry');
  }

  /**
   * SQLite 데이터베이스와 백엔드 서비스를 초기화하고,
   * 저장된 Supabase 설정이 있으면 자동 연결을 시도합니다.
   */
  initDatabase() {
    try {
      // URL 쿼리 파라미터에서 userDataPath 파싱 (Electron userData 폴더 반영)
      const urlParams = new URLSearchParams(window.location.search);
      const userDataPath = urlParams.get('userDataPath');

      let dbPath;
      if (userDataPath) {
        dbPath = path.join(userDataPath, 'herb_inventory.db');
      } else {
        dbPath = path.join(process.cwd(), 'herb_inventory.db');
      }

      this.manager = new InventoryManager(dbPath);
      this.csvHandler = CSVHandler;
      this.predictor = new SmartPredictor(this.manager);

      // 실시간 데이터 변경 감지 콜백 바인딩 → EventBus로 발행
      if (typeof this.manager.onDataChange === 'function') {
        this.manager.onDataChange(() => {
          this.bus.emit('remote-data-changed');
        });
      }

      // 구동 시 Supabase 자동 연결 및 백그라운드 동기화 수행
      const savedUrl = localStorage.getItem('supabase_url');
      const savedKey = localStorage.getItem('supabase_key');
      if (savedUrl && savedKey) {
        this.manager.setupSupabase(savedUrl, savedKey)
          .then(success => {
            if (success) {
              this.dialogs.showToast('🟢 Supabase 공유 DB 동기화가 활성화되었습니다.');
              this.medicineList.render();
              const viewPrescTable = document.getElementById('pastPrescriptionsBody');
              if (viewPrescTable) this.prescription.renderPastPrescriptions();
            } else {
              this.dialogs.showToast('⚠️ Supabase 연결 실패: 로컬 단독 모드로 구동됩니다.', true);
            }
          })
          .catch(e => {
            console.error('Supabase 자동 연결 실패:', e);
            this.dialogs.showToast('⚠️ Supabase 자동 연결 실패: ' + e.message, true);
          });
      } else {
        this.dialogs.showToast('⚡ Electron SQLite 모드가 가동되었습니다.');
      }
    } catch (e) {
      console.error('데이터베이스 초기화 실패:', e);
      this.dialogs.showToast('⚠️ 데이터베이스 초기화 실패: ' + e.message, true);
    }
  }

  /**
   * QuickSearchEngine을 생성하고 View들과 콜백으로 연결합니다.
   * (엔진은 UI 프레임워크 비의존 — elements와 callbacks만 주입받는 순수 클래스)
   */
  initSearchEngine() {
    const mainTabs = document.getElementById('mainTabs');

    this.searchEngine = new QuickSearchEngine({
      searchInput: document.getElementById('inquirySearchInput'),
      categoryTabs: document.getElementById('inquiryCategoryContainer'), // 초기 바인딩
      listContainer: document.getElementById('inquiryMedicineList'),     // 초기 바인딩
      popupContainer: document.getElementById('quantityPopup'),
      popupInput: document.getElementById('popupQuantityInput')
    }, {
      onFilter: (categoryId) => {
        this.medicineList.render(categoryId);
      },
      onAddToPrescription: (medId, amount) => {
        this.prescription.addToBasket(medId, amount);
      },
      getCurrentListItems: () => {
        let listContainerId = 'inquiryMedicineList';
        if (this.state.currentTab === 'prescription') listContainerId = 'prescriptionMedicineList';
        else if (this.state.currentTab === 'batch') listContainerId = 'batchMedicineList';

        const el = document.getElementById(listContainerId);
        return el ? Array.from(el.querySelectorAll('.medicine-item')) : [];
      },
      onTabChange: (tabIdx) => {
        const buttons = Array.from(mainTabs.querySelectorAll('.tab-btn'));
        if (buttons[tabIdx]) {
          this.switchTab(buttons[tabIdx].dataset.tab);
        }
      },
      onInquiryMed: (medId) => {
        this.inquiry.showDetails(medId);
      },
      onAddToBatch: (medId) => {
        this.batch.addMedicine(medId);
      },
      onEditMed: (medId) => {
        this.medicineModal.openEdit(medId);
      },
      onSelectionChange: (selectedIds) => {
        // 복수 선택 상태 스타일을 렌더링에 동기화 반영
        const items = this.searchEngine.callbacks.getCurrentListItems();
        items.forEach(item => {
          const id = item.dataset.id;
          if (selectedIds.has(id)) {
            item.classList.add('active', 'multi-selected');
          } else {
            item.classList.remove('active', 'multi-selected');
          }
        });
      }
    });
  }

  /**
   * 메인 탭바 뷰 스위칭 핵심 로직.
   * 탭 버튼/콘텐츠 노출을 갱신하고, 검색 엔진의 대상 DOM을 새 탭으로 재바인딩합니다.
   * @param {'inquiry'|'prescription'|'predict'|'batch'} tabName
   */
  switchTab(tabName) {
    const mainTabs = document.getElementById('mainTabs');
    this.state.currentTab = tabName;
    this.searchEngine.selectedIds.clear();
    this.searchEngine.callbacks.onSelectionChange(this.searchEngine.selectedIds);

    // activeTab 인덱스 동기화 (Alt 단축키 및 엔터 기능 연동용)
    const tabNames = ['inquiry', 'prescription', 'predict', 'batch'];
    const tabIndex = tabNames.indexOf(tabName);
    if (tabIndex !== -1) {
      this.searchEngine.activeTab = tabIndex;
    }

    // 1. 탭 버튼 스타일 갱신
    mainTabs.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // 2. 콘텐츠 뷰 노출 제어
    document.querySelectorAll('.tab-content-view').forEach(view => {
      view.classList.toggle('active', view.id === `view-${tabName}`);
    });

    // 3. 탭별 검색창 및 리스트 정보 검색 엔진에 바인딩 갱신
    let sInputId, cContainerId, lContainerId;
    if (tabName === 'inquiry') {
      sInputId = 'inquirySearchInput';
      cContainerId = 'inquiryCategoryContainer';
      lContainerId = 'inquiryMedicineList';
    } else if (tabName === 'prescription') {
      sInputId = 'prescriptionSearchInput';
      cContainerId = 'prescriptionCategoryContainer';
      lContainerId = 'prescriptionMedicineList';
    } else if (tabName === 'batch') {
      sInputId = 'batchSearchInput';
      cContainerId = 'batchCategoryContainer';
      lContainerId = 'batchMedicineList';
    }

    if (sInputId) {
      const sInput = document.getElementById(sInputId);
      const cContainer = document.getElementById(cContainerId);
      const lContainer = document.getElementById(lContainerId);

      this.searchEngine.elements.searchInput = sInput;
      this.searchEngine.elements.categoryTabs = cContainer;
      this.searchEngine.elements.listContainer = lContainer;

      // 동적 카테고리 생성 바인딩
      this.medicineList.renderCategoryTabs(cContainer);
      this.medicineList.render();

      // 검색창 강제 포커싱
      this.searchEngine.setFocusState('search');
    } else {
      if (document.activeElement) {
        document.activeElement.blur();
      }
    }

    // 4. 탭 전용 화면 렌더링 갱신
    if (tabName === 'prescription') {
      this.prescription.renderBasket();
      this.prescription.setHistoryTab(this.state.currentHistoryTab);
    } else if (tabName === 'predict') {
      this.predict.render();
    } else if (tabName === 'batch') {
      this.batch.render();
    }
  }

  /** 메인 탭바 클릭 스위칭을 바인딩합니다. */
  bindTabBar() {
    const mainTabs = document.getElementById('mainTabs');
    mainTabs.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-btn')) {
        this.switchTab(e.target.dataset.tab);
      }
    });
  }

  /** CSV 가져오기/내보내기 버튼(모든 탭 공유 액션)을 바인딩합니다. */
  bindCsvActions() {
    // 임포트 연결
    document.querySelectorAll('.btn-csv-import').forEach(btn => {
      btn.addEventListener('click', () => {
        const fileInput = document.querySelector('.csv-file-input');
        fileInput.click();
      });
    });

    document.querySelector('.csv-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (evt) => {
        const arrayBuffer = evt.target.result;
        let text = '';
        // 한국 환경 특성상 UTF-8 우선, 실패 시 EUC-KR 순서로 디코딩을 시도합니다.
        try {
          const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
          text = utf8Decoder.decode(arrayBuffer);
        } catch (err) {
          console.warn('UTF-8 디코딩 실패, EUC-KR로 대체 시도합니다.', err);
          try {
            const eucKrDecoder = new TextDecoder('euc-kr');
            text = eucKrDecoder.decode(arrayBuffer);
          } catch (eucErr) {
            console.error('EUC-KR 디코딩 실패:', eucErr);
            this.dialogs.showAlert('파일 인코딩을 해석할 수 없습니다. UTF-8 또는 EUC-KR 형식이어야 합니다.');
            return;
          }
        }

        try {
          const result = this.csvHandler.importFromCSV(text, this.manager);
          const msg = `성공: ${result.successCount}건, 건너뜀: ${result.skipCount}건`;
          if (result.errors.length > 0) {
            console.warn('CSV 로드 경고:', result.errors);
            this.dialogs.showToast(`CSV 임포트 완료 - 에러로그 확인 필요`, true);
          } else {
            this.dialogs.showToast(`📥 CSV 임포트 성공! (${msg})`);
          }

          this.medicineList.render();
          this.predict.render();
        } catch (err) {
          this.dialogs.showAlert(`CSV 파싱 실패: ${err.message}`);
        }
        e.target.value = '';
      };
      reader.readAsArrayBuffer(file);
    });

    // 익스포트 연결
    document.querySelectorAll('.btn-csv-export').forEach(btn => {
      btn.addEventListener('click', () => {
        try {
          const { formatUTCToKSTString } = require('./core/utils');
          const csvContent = this.csvHandler.exportToCSV(this.manager);
          // UTF-8 BOM을 붙여 Excel에서 한글이 깨지지 않도록 처리
          const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', `한의원약재재고_${formatUTCToKSTString().slice(0, 10)}.csv`);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          this.dialogs.showToast('📤 CSV 파일로 재고 정보가 내보내졌습니다.');
        } catch (err) {
          this.dialogs.showAlert(`CSV 내보내기 실패: ${err.message}`);
        }
      });
    });
  }
}

module.exports = App;
