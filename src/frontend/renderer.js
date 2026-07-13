/**
 * @file renderer.js
 * @description UI 컴포넌트 이벤트 연결, 4대 탭 바인딩, Canvas 차트 드로잉, 
 * 다중 카테고리, Shift 복수 선택, 우클릭 수정 및 일괄 변경 제어 구현.
 */

// 글로벌 상태 객체
let dbManager;
let csvHandler;
let predictor;
let searchEngine;

// 상태 변수
let currentTab = 'inquiry'; // 'inquiry' | 'prescription' | 'predict' | 'batch'
let currentInquiryMedId = null; // 현재 조회 중인 약재 ID
let currentPrescriptionItems = []; // 처방 바구니 [{ id, name, pack_size, amount }]
let batchEditItems = new Map(); // 일괄 편집 대상 약재 맵 (id => medData)
let contextTargetMedId = null; // 우클릭 대상 약재 ID

// 브라우저 vs Electron (Node.js) 감지
const isElectron = typeof require !== 'undefined' && typeof process !== 'undefined';

function initDatabase() {
  if (isElectron) {
    try {
      const path = require('path');
      const InventoryManager = require('../backend/InventoryManager');
      const CSVHandler = require('../backend/CSVHandler');
      const SmartPredictor = require('../backend/SmartPredictor');

      // URL 쿼리 파라미터에서 userDataPath 파싱 (Electron userData 폴더 반영)
      const urlParams = new URLSearchParams(window.location.search);
      const userDataPath = urlParams.get('userDataPath');
      
      let dbPath;
      if (userDataPath) {
        dbPath = path.join(userDataPath, 'herb_inventory.db');
      } else {
        dbPath = path.join(process.cwd(), 'herb_inventory.db');
      }

      dbManager = new InventoryManager(dbPath);
      csvHandler = CSVHandler;
      predictor = new SmartPredictor(dbManager);
      
      // 실시간 데이터 변경 감지 콜백 바인딩
      if (typeof dbManager.onDataChange === 'function') {
        dbManager.onDataChange(() => {
          console.log('🔔 Supabase Realtime: 원격 데이터 변경 감지, 화면을 갱신합니다.');
          renderMedicineList();
          const viewPrescTable = document.getElementById('prescriptionHistoryBody');
          if (viewPrescTable) renderPrescriptionHistory();
        });
      }
      
      if (dbManager.isMock) {
        showToast('⚠️ SQLite 초기화 실패로 로컬 백업(Mock JSON) 모드로 가동되었습니다.', true);
      } else {
        // 구동 시 Supabase 자동 연결 및 백그라운드 동기화 수행
        const savedUrl = localStorage.getItem('supabase_url');
        const savedKey = localStorage.getItem('supabase_key');
        if (savedUrl && savedKey) {
          dbManager.setupSupabase(savedUrl, savedKey)
            .then(success => {
              if (success) {
                showToast('🟢 Supabase 공유 DB 동기화가 활성화되었습니다.');
                renderMedicineList();
                const viewPrescTable = document.getElementById('prescriptionHistoryBody');
                if (viewPrescTable) renderPrescriptionHistory();
              } else {
                showToast('⚠️ Supabase 연결 실패: 로컬 단독 모드로 구동됩니다.', true);
              }
            })
            .catch(e => {
              console.error('Supabase 자동 연결 실패:', e);
              showToast('⚠️ Supabase 자동 연결 실패: ' + e.message, true);
            });
        } else {
          showToast('⚡ Electron SQLite 모드가 가동되었습니다.');
        }
      }
    } catch (e) {
      console.error('Node.js 백엔드 로드 실패, Web Mock 모드로 전환합니다:', e);
      setupWebMock();
    }
  } else {
    setupWebMock();
  }
}

function setupWebMock() {
  dbManager = new window.InventoryManager();
  csvHandler = window.CSVHandler;
  predictor = new window.SmartPredictor(dbManager);
  
  // 브라우저용 Mock 데모 카테고리 및 약재 초기 시드 적재
  dbManager.mockData.categories = [
    { id: 1, name: '미분류' },
    { id: 2, name: '보혈약' },
    { id: 3, name: '보기약' },
    { id: 4, name: '해표약' }
  ];
  dbManager.mockData.medicines = [
    { id: 1, name: '당귀', category_id: 2, pack_size: 500, unopened_packs: 5, opened_pack_remain: 120, safety_stock: 1500, unit: 'g' },
    { id: 2, name: '감초', category_id: 3, pack_size: 600, unopened_packs: 3, opened_pack_remain: 450, safety_stock: 1200, unit: 'g' },
    { id: 3, name: '갈근', category_id: 4, pack_size: 500, unopened_packs: 1, opened_pack_remain: 50, safety_stock: 1000, unit: 'g' },
    { id: 4, name: '숙지황', category_id: 2, pack_size: 500, unopened_packs: 8, opened_pack_remain: 350, safety_stock: 2000, unit: 'g' },
    { id: 5, name: '황기', category_id: 3, pack_size: 500, unopened_packs: 0, opened_pack_remain: 200, safety_stock: 1000, unit: 'g' }
  ];
  
  // 최근 30일 간의 소모 이력 시뮬레이션용 시드 적재 (Canvas 사용량 그래프 가시화용)
  const now = new Date();
  for (let d = 1; d <= 20; d++) {
    // 2~3일에 한 번씩 10~50g 사이의 조제 소모 발생 기록
    if (d % 2 === 0) {
      dbManager.mockData.stock_logs.push({
        id: dbManager.mockData.stock_logs.length + 1,
        medicine_id: 1, // 당귀 소모로그 집중 생성
        type: 'CONSUME',
        quantity: -Math.floor(10 + Math.random() * 40),
        timestamp: new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19),
        note: '조제 소모'
      });
      dbManager.mockData.stock_logs.push({
        id: dbManager.mockData.stock_logs.length + 1,
        medicine_id: 2, // 감초
        type: 'CONSUME',
        quantity: -Math.floor(5 + Math.random() * 20),
        timestamp: new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19),
        note: '조제 소모'
      });
    }
  }

  showToast('🌿 브라우저 하이브리드 데모 데이터가 구동되었습니다.');
}

// ----------------------------------------------------
// UI 렌더링 엔진
// ----------------------------------------------------

/**
 * 카테고리 동적 탭 렌더링
 * @param {HTMLElement} container 
 */
function renderCategoryTabs(container) {
  if (!container) return;
  
  const categories = dbManager.getAllCategories();
  
  // 현재 카테고리 탭들의 포커스 상태 유지를 위해 선택 정보 수집
  const activeTab = container.querySelector('.category-tab.active');
  const activeCategoryId = activeTab ? activeTab.dataset.categoryId : '전체';

  let html = `<button class="category-tab ${activeCategoryId === '전체' ? 'active' : ''}" data-category-id="전체">전체</button>`;
  categories.forEach(cat => {
    html += `<button class="category-tab ${activeCategoryId == cat.id ? 'active' : ''}" data-category-id="${cat.id}">${cat.name}</button>`;
  });
  // 카테고리 동적 추가 + 단추 추가
  html += `<button class="category-add-btn" id="btnCategoryModalOpen">➕ 카테고리 추가</button>`;
  
  container.innerHTML = html;
}

/**
 * 활성 탭에 맞춰 약재 리스트 렌더링
 */
function renderMedicineList() {
  let listContainerId, searchInputId, categoryContainerId;
  
  if (currentTab === 'inquiry') {
    listContainerId = 'inquiryMedicineList';
    searchInputId = 'inquirySearchInput';
    categoryContainerId = 'inquiryCategoryContainer';
  } else if (currentTab === 'prescription') {
    listContainerId = 'prescriptionMedicineList';
    searchInputId = 'prescriptionSearchInput';
    categoryContainerId = 'prescriptionCategoryContainer';
  } else if (currentTab === 'batch') {
    listContainerId = 'batchMedicineList';
    searchInputId = 'batchSearchInput';
    categoryContainerId = 'batchCategoryContainer';
  } else {
    return; // 발주 예측 탭은 좌측 목록 없음
  }

  const listContainer = document.getElementById(listContainerId);
  const searchInput = document.getElementById(searchInputId);
  const categoryContainer = document.getElementById(categoryContainerId);

  if (!listContainer) return;

  const searchQuery = searchInput ? searchInput.value : '';
  const activeTab = categoryContainer ? categoryContainer.querySelector('.category-tab.active') : null;
  const categoryFilter = activeTab ? activeTab.dataset.categoryId : '전체';

  const medicines = dbManager.getAllMedicines();
  
  // 필터링 처리
  const filtered = medicines.filter(med => {
    // 1. 카테고리 필터
    if (categoryFilter !== '전체' && med.category_id != categoryFilter) {
      return false;
    }
    // 2. 검색어 매칭
    if (searchQuery) {
      return searchEngine.match(med.name, searchQuery);
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
    const isMultiSelected = searchEngine.selectedIds.has(med.id);
    item.className = `medicine-item ${isUnderSafety ? 'warning-border' : ''} ${isMultiSelected ? 'multi-selected' : ''}`;
    item.dataset.id = med.id;
    item.dataset.packSize = med.pack_size;

    const statusBadge = isUnderSafety 
      ? `<span class="status-badge status-warning">재고부족 (안전: ${med.safety_stock}g)</span>`
      : `<span class="status-badge status-normal">적정</span>`;

    item.innerHTML = `
      <div class="med-info">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="med-name">${med.name}</span>
          <span class="status-badge" style="background:#f1f4f2; color:var(--color-text-muted);">${med.category_name}</span>
        </div>
        <div class="med-stock">${med.formatted_stock}</div>
      </div>
      <div style="text-align: right; display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
        ${statusBadge}
        <span style="font-size:10px; color:var(--color-text-muted);">규격: ${med.pack_size}${med.unit}</span>
      </div>
    `;

    // 마우스 이벤트 연결 (Shift 다중 선택 연동)
    item.addEventListener('click', (e) => {
      searchEngine.handleMouseClickSelection(e, item);
      
      // 조회 탭에서는 단순 1회 클릭 시에도 정보 조회가 실시간 연동되면 UX 상 매우 좋습니다.
      if (currentTab === 'inquiry') {
        inquiryMedicineDetails(med.id);
      }
    });

    // 마우스 더블클릭 이벤트 연결 (엔터 키와 똑같은 기능 수행)
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      
      // 더블클릭한 아이템 선택 상태 동기화
      searchEngine.selectedIds.clear();
      searchEngine.selectedIds.add(med.id);
      searchEngine.lastSelectedIndex = filtered.indexOf(med);
      searchEngine.currentListIndex = filtered.indexOf(med);
      searchEngine.callbacks.onSelectionChange(searchEngine.selectedIds);
      
      const items = Array.from(listContainer.querySelectorAll('.medicine-item'));
      searchEngine.updateActiveListItem(items);

      // 탭별 타겟 기능 트리거
      if (currentTab === 'inquiry') {
        inquiryMedicineDetails(med.id);
      } else if (currentTab === 'prescription') {
        searchEngine.openQuantityPopup(item);
      } else if (currentTab === 'batch') {
        addMedToBatch(med.id);
      }
    });

    // 마우스 우클릭 (Context Menu) 수정 모달 트리거
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextTargetMedId = med.id;
      showContextMenu(e.pageX, e.pageY);
    });

    listContainer.appendChild(item);
  });
}

// ----------------------------------------------------
// 1. [조회] 탭: 상세정보, Canvas 사용량 그래프, 개별 로그 테이블
// ----------------------------------------------------

/**
 * 특정 약재 상세 조회 렌더링
 * @param {number} medId 
 */
function inquiryMedicineDetails(medId) {
  currentInquiryMedId = medId;
  const detailEmpty = document.getElementById('inquiryDetailEmpty');
  const detailContent = document.getElementById('inquiryDetailContent');

  try {
    const info = dbManager.getTotalStock(medId);
    
    document.getElementById('detName').textContent = info.name;
    document.getElementById('detCategory').textContent = info.categoryName;
    document.getElementById('detPackSize').textContent = `${info.pack_size}${info.unit}`;
    document.getElementById('detTotalStock').textContent = info.formatted;
    document.getElementById('detSafetyStock').textContent = `${info.safety_stock}${info.unit}`;
    document.getElementById('detUnit').textContent = info.unit;

    detailEmpty.style.display = 'none';
    detailContent.style.display = 'block';

    // Canvas 사용량 차트 드로잉
    drawUsageChart('usageChart', medId);
    
    // 개별 변경 로그 렌더링
    renderInquiryLogs(medId);
  } catch (err) {
    console.error('상세 정보 조회 실패:', err);
    showToast('약재 정보를 조회할 수 없습니다.', true);
  }
}

/**
 * 최근 30일 조제 소모 추이 꺾은선 차트 드로잉 (바닐라 Canvas API 구현)
 * @param {string} canvasId 
 * @param {number} medId 
 */
function drawUsageChart(canvasId, medId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  // Canvas 해상도 선명화 처리
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  // 1. 데이터 소스 획득 (최근 30일간의 CONSUME 로그)
  const logs = dbManager.getLogsByMedicine(medId).filter(l => l.type === 'CONSUME');
  
  // 날짜별 소모량 절대값 합산
  const consumptionMap = new Map();
  logs.forEach(log => {
    const dateStr = log.timestamp.split(' ')[0]; // YYYY-MM-DD
    const qty = Math.abs(log.quantity);
    consumptionMap.set(dateStr, (consumptionMap.get(dateStr) || 0) + qty);
  });

  // 최근 10일(또는 7일) 날짜 라벨 배열 생성하여 가독성 좋은 미니 그래프 구축
  const dayCount = 10;
  const labels = [];
  const data = [];
  const now = new Date();
  
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    labels.push(d.getDate() + '일');
    data.push(consumptionMap.get(dateStr) || 0);
  }

  // 2. 그리기 연산 수행
  ctx.clearRect(0, 0, width, height);

  const paddingLeft = 35;
  const paddingRight = 15;
  const paddingTop = 15;
  const paddingBottom = 25;
  
  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  // Y축 최댓값 설정
  const maxVal = Math.max(...data, 10); // 최소 10g 기준 격자
  const roundMax = Math.ceil(maxVal / 10) * 10;

  // 격자선 (수평선 3개)
  ctx.strokeStyle = '#e9ecef';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7770';
  ctx.font = '9px sans-serif';
  
  for (let i = 0; i <= 3; i++) {
    const y = paddingTop + chartHeight - (chartHeight * (i / 3));
    const val = (roundMax * (i / 3)).toFixed(0);
    
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(width - paddingRight, y);
    ctx.stroke();

    // Y축 수치 텍스트
    ctx.fillText(val + 'g', 5, y + 3);
  }

  // 데이터 좌표 계산 및 드로잉
  const points = data.map((val, idx) => {
    const x = paddingLeft + (chartWidth * (idx / (dayCount - 1)));
    const y = paddingTop + chartHeight - (chartHeight * (val / roundMax));
    return { x, y };
  });

  // 꺾은선 그리기
  ctx.strokeStyle = '#386641'; // 세이지 그린 색상
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((p, idx) => {
    if (idx === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  // 점(Dot) 및 x축 라벨 그리기
  points.forEach((p, idx) => {
    ctx.fillStyle = '#52b788';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // X축 일자 텍스트
    ctx.fillStyle = '#6b7770';
    ctx.textAlign = 'center';
    ctx.fillText(labels[idx], p.x, height - 10);
  });
}

/**
 * 특정 약재 변경 내역 로그 테이블 출력
 */
function renderInquiryLogs(medId) {
  const wrapper = document.getElementById('inquiryLogsWrapper');
  const empty = document.getElementById('inquiryLogsEmpty');
  const tbody = document.getElementById('inquiryLogsBody');
  tbody.innerHTML = '';

  const logs = dbManager.getLogsByMedicine(medId);

  if (logs.length === 0) {
    wrapper.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  wrapper.style.display = 'block';
  empty.style.display = 'none';

  logs.forEach(log => {
    const tr = document.createElement('tr');
    
    // 구분별 컬러 배지화
    let typeBadge = '';
    if (log.type === 'CONSUME') typeBadge = '<span class="status-badge" style="background:#e8f0fe; color:#1a73e8;">소모</span>';
    else if (log.type === 'IN') typeBadge = '<span class="status-badge status-normal">입고</span>';
    else if (log.type === 'ADJUST') typeBadge = '<span class="status-badge" style="background:#fff3cd; color:#856404;">조정</span>';
    else if (log.type === 'WASTE') typeBadge = '<span class="status-badge status-warning">폐기</span>';

    const qtyFormatted = log.quantity > 0 ? `+${log.quantity}g` : `${log.quantity}g`;

    tr.innerHTML = `
      <td>${typeBadge}</td>
      <td style="font-weight:700; color:${log.quantity > 0 ? 'var(--color-primary)' : 'var(--color-accent)'}">${qtyFormatted}</td>
      <td style="color:var(--color-text-muted);">${log.timestamp.slice(5, 16)}</td>
      <td style="font-size:11px;">${log.note || ''}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------
// 2. [처방] 탭: 작성기 및 완료 기록 테이블
// ----------------------------------------------------

function renderPrescription() {
  const tbody = document.getElementById('prescriptionBody');
  const empty = document.getElementById('prescriptionEmpty');
  const wrapper = document.getElementById('prescriptionTableWrapper');
  tbody.innerHTML = '';

  if (currentPrescriptionItems.length === 0) {
    empty.style.display = 'flex';
    if (wrapper) wrapper.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  if (wrapper) wrapper.style.display = 'block';

  currentPrescriptionItems.forEach((item, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:700; color:var(--color-primary);">${item.name}</td>
      <td style="color:var(--color-text-muted);">${item.pack_size}g 기준</td>
      <td>
        <input type="number" value="${item.amount}" min="0.1" step="0.1" 
               style="width: 70px; padding: 4px; border: 1px solid var(--color-border); border-radius: 4px; text-align: center;"
               onchange="updatePrescriptionItemAmount(${index}, this.value)"> g
      </td>
      <td style="text-align: center;">
        <span class="presc-remove" onclick="removePrescriptionItem(${index})" style="cursor:pointer;">❌</span>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.updatePrescriptionItemAmount = function(index, value) {
  const val = parseFloat(value);
  if (!isNaN(val) && val > 0) {
    currentPrescriptionItems[index].amount = val;
  }
};

window.removePrescriptionItem = function(index) {
  currentPrescriptionItems.splice(index, 1);
  renderPrescription();
};

/**
 * 과거 전체 처방 기록 완료 이력 렌더링
 */
function renderPastPrescriptions() {
  const wrapper = document.getElementById('pastPrescriptionsWrapper');
  const empty = document.getElementById('pastPrescriptionsEmpty');
  const tbody = document.getElementById('pastPrescriptionsBody');
  tbody.innerHTML = '';

  const list = dbManager.getAllPrescriptions();

  if (list.length === 0) {
    wrapper.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  wrapper.style.display = 'block';
  empty.style.display = 'none';

  list.forEach(p => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td style="font-weight:600; color:var(--color-text-muted);">#${p.id}</td>
      <td style="font-weight:700; color:var(--color-primary);">${p.prescription_name}</td>
      <td>${p.patient_name}</td>
      <td style="text-align:center;">${p.total_items}종</td>
      <td style="color:var(--color-text-muted); font-size:11px;">${p.created_at}</td>
    `;
    
    // 행 클릭 시 과거 처방 세부 품목 상세 모달 로드
    tr.addEventListener('click', () => {
      openPrescriptionDetailModal(p.id);
    });

    tbody.appendChild(tr);
  });
}

/**
 * 처방 완료 이력 상세 정보 조회 모달 오픈
 * @param {number} prescId 
 */
function openPrescriptionDetailModal(prescId) {
  try {
    const detail = dbManager.getPrescriptionDetails(prescId);
    
    document.getElementById('viewPrescName').textContent = detail.prescription_name;
    document.getElementById('viewPrescPatient').textContent = detail.patient_name;
    document.getElementById('viewPrescDate').textContent = detail.created_at;
    document.getElementById('viewPrescNote').textContent = detail.note || '메모 없음';
    
    const tbody = document.getElementById('viewPrescItemsBody');
    tbody.innerHTML = '';
    
    detail.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight:700; color:var(--color-primary);">${item.medicine_name}</td>
        <td style="text-align:right; font-weight:600;">${item.amount}${item.unit}</td>
      `;
      tbody.appendChild(tr);
    });
    
    document.getElementById('prescriptionDetailModal').classList.add('show');
  } catch (err) {
    alert(`처방전 상세정보를 불러오지 못했습니다: ${err.message}`);
  }
}

// ----------------------------------------------------
// 3. [발주 예측] 탭: 원클릭 시스템 렌더링
// ----------------------------------------------------

function renderPredictView() {
  const empty = document.getElementById('predictEmpty');
  const wrapper = document.getElementById('predictTableWrapper');
  const tbody = document.getElementById('predictBody');
  tbody.innerHTML = '';

  const leadTime = parseInt(document.getElementById('predLeadTime').value) || 7;
  const analysisDays = parseInt(document.getElementById('predAnalysisDays').value) || 30;

  const reorderList = predictor.getReorderList(leadTime, analysisDays);

  if (reorderList.length === 0) {
    wrapper.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  wrapper.style.display = 'block';
  empty.style.display = 'none';

  reorderList.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:700; color:var(--color-primary);">${item.name}</td>
      <td><span class="status-badge" style="background:#f1f4f2; color:var(--color-text-muted);">${item.category}</span></td>
      <td>${item.packSize}${item.unit}</td>
      <td style="font-weight:600;">${item.currentStock}${item.unit}</td>
      <td style="color:var(--color-text-muted);">${item.safetyStock}${item.unit}</td>
      <td style="color:var(--color-accent); font-weight:700;">-${item.deficit}${item.unit}</td>
      <td>${item.nextMonthEstimate}${item.unit}</td>
      <td style="font-weight:700; color:var(--color-primary);">+${item.orderQuantityGrams}${item.unit}</td>
      <td style="font-weight:700; background:#f5fdf7; color:var(--color-primary);">📦 ${item.orderPacks}봉지</td>
    `;
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------
// 4. [일괄 작업] 탭: 데이터 편집기 렌더링 및 처리
// ----------------------------------------------------

/**
 * 일괄 작업 편집기에 약재 행 추가
 */
function addMedToBatch(medId) {
  const med = dbManager.getAllMedicines().find(m => m.id === medId);
  if (!med) return;

  if (batchEditItems.has(medId)) {
    showToast(`이미 추가된 약재입니다: ${med.name}`, true);
    return;
  }

  // 변경 추적용 복사본 보존
  batchEditItems.set(medId, {
    id: med.id,
    name: med.name,
    category_id: med.category_id,
    pack_size: med.pack_size,
    unopened_packs: med.unopened_packs,
    opened_pack_remain: med.opened_pack_remain,
    safety_stock: med.safety_stock,
    unit: med.unit
  });

  renderBatchTable();
}

/**
 * 일괄 작업 편집기 테이블 렌더링
 */
function renderBatchTable() {
  const empty = document.getElementById('batchEmpty');
  const wrapper = document.getElementById('batchTableWrapper');
  const tbody = document.getElementById('batchTableBody');
  tbody.innerHTML = '';

  if (batchEditItems.size === 0) {
    wrapper.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  wrapper.style.display = 'block';
  empty.style.display = 'none';

  const categories = dbManager.getAllCategories();

  batchEditItems.forEach((item, id) => {
    const tr = document.createElement('tr');
    tr.dataset.id = id;

    // 카테고리 드롭다운 옵션 태그 생성
    let catOptions = '';
    categories.forEach(c => {
      catOptions += `<option value="${c.id}" ${item.category_id == c.id ? 'selected' : ''}>${c.name}</option>`;
    });

    tr.innerHTML = `
      <td style="font-weight:700; color:var(--color-primary);">${item.name}</td>
      <td>
        <select class="batch-cat" style="padding: 2px 4px; border:1px solid var(--color-border); border-radius:4px; font-size:11px;">
          ${catOptions}
        </select>
      </td>
      <td><input type="number" class="batch-pack" value="${item.pack_size}" min="1" step="0.1"></td>
      <td><input type="number" class="batch-unopened" value="${item.unopened_packs}" min="0"></td>
      <td><input type="number" class="batch-remain" value="${item.opened_pack_remain}" min="0" step="0.1"></td>
      <td><input type="number" class="batch-safety" value="${item.safety_stock}" min="0" step="10"></td>
      <td><input type="text" class="batch-unit" value="${item.unit}" style="width:40px;"></td>
      <td>
        <span style="cursor:pointer;" onclick="removeBatchItem(${id})">❌</span>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.removeBatchItem = function(id) {
  batchEditItems.delete(id);
  renderBatchTable();
};

/**
 * 일괄 작업 내용 DB 일괄 업데이트 실행
 */
function saveBatchChanges() {
  const tbody = document.getElementById('batchTableBody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  if (rows.length === 0) return;

  let successCount = 0;
  let hasError = false;

  for (const row of rows) {
    const id = parseInt(row.dataset.id);
    const category_id = parseInt(row.querySelector('.batch-cat').value);
    const pack_size = parseFloat(row.querySelector('.batch-pack').value);
    const unopened_packs = parseInt(row.querySelector('.batch-unopened').value) || 0;
    const opened_pack_remain = parseFloat(row.querySelector('.batch-remain').value) || 0;
    const safety_stock = parseFloat(row.querySelector('.batch-safety').value) || 0;
    const unit = row.querySelector('.batch-unit').value.trim() || 'g';

    if (isNaN(pack_size) || pack_size <= 0) {
      alert('팩 규격은 0보다 커야 합니다.');
      hasError = true;
      break;
    }
    if (opened_pack_remain > pack_size) {
      alert('개봉 잔량은 팩 규격을 초과할 수 없습니다.');
      hasError = true;
      break;
    }

    try {
      // DB UPDATE 실행 (내부에서 오차 자동 계산하여 ADJUST 로그 적재)
      dbManager.updateMedicine(id, {
        category_id,
        pack_size,
        unopened_packs,
        opened_pack_remain,
        safety_stock,
        unit
      });
      successCount++;
    } catch (err) {
      console.error(err);
      alert(`저장 중 에러 발생: ${err.message}`);
      hasError = true;
      break;
    }
  }

  if (!hasError) {
    showToast(`💾 총 ${successCount}건의 약재 데이터가 일괄 수정 및 동기화되었습니다.`);
    batchEditItems.clear();
    renderBatchTable();
    renderMedicineList();
  }
}

// ----------------------------------------------------
// 카테고리 동적 추가 모달 제어
// ----------------------------------------------------
function handleAddCategorySave() {
  const input = document.getElementById('newCategoryName');
  const name = input.value.trim();
  if (!name) {
    alert('카테고리명을 입력해 주세요.');
    return;
  }

  try {
    const newId = dbManager.addCategory(name);
    showToast(`✨ 새 카테고리 "${name}"이(가) 등록되었습니다.`);
    
    // 모달 닫기
    document.getElementById('addCategoryModal').classList.remove('show');
    input.value = '';

    // 각 탭별 카테고리 컨테이너 리렌더링
    const containers = ['inquiryCategoryContainer', 'prescriptionCategoryContainer', 'batchCategoryContainer'];
    containers.forEach(cId => {
      const el = document.getElementById(cId);
      if (el) {
        renderCategoryTabs(el);
      }
    });

    renderMedicineList();
  } catch (err) {
    alert(`카테고리 등록 실패: ${err.message}`);
  }
}

// ----------------------------------------------------
// 약재 수동 추가 및 우클릭 수정 폼 제어 (모달 공유)
// ----------------------------------------------------
function openAddMedicineModal() {
  const modal = document.getElementById('editMedicineModal');
  document.getElementById('editModalHeader').textContent = '새로운 약재 수동 추가';
  document.getElementById('editMedId').value = '';
  document.getElementById('editMedName').value = '';
  document.getElementById('editMedName').readOnly = false;
  document.getElementById('editMedPackSize').value = '500';
  document.getElementById('editMedUnopened').value = '0';
  document.getElementById('editMedRemain').value = '0';
  document.getElementById('editMedSafety').value = '500';
  document.getElementById('editMedUnit').value = 'g';

  // 카테고리 셀렉트박스 바인딩
  const select = document.getElementById('editMedCategorySelect');
  select.innerHTML = '';
  dbManager.getAllCategories().forEach(c => {
    select.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });

  modal.classList.add('show');
  
  // 브라우저 렌더링 사이클 지연 포커싱으로 포커스 유실 방지
  setTimeout(() => {
    document.getElementById('editMedName').focus();
  }, 50);
}

function openEditMedicineModal(medId) {
  const modal = document.getElementById('editMedicineModal');
  document.getElementById('editModalHeader').textContent = '✏️ 약재 정보 수정';
  
  const med = dbManager.getAllMedicines().find(m => m.id === medId);
  if (!med) return;

  document.getElementById('editMedId').value = med.id;
  document.getElementById('editMedName').value = med.name;
  document.getElementById('editMedName').readOnly = true; // 약재명은 SQLite UNIQUE 제약 및 오작동 차단을 위해 읽기전용 처리
  document.getElementById('editMedPackSize').value = med.pack_size;
  document.getElementById('editMedUnopened').value = med.unopened_packs;
  document.getElementById('editMedRemain').value = med.opened_pack_remain;
  document.getElementById('editMedSafety').value = med.safety_stock;
  document.getElementById('editMedUnit').value = med.unit;

  const select = document.getElementById('editMedCategorySelect');
  select.innerHTML = '';
  dbManager.getAllCategories().forEach(c => {
    select.innerHTML += `<option value="${c.id}" ${med.category_id == c.id ? 'selected' : ''}>${c.name}</option>`;
  });

  modal.classList.add('show');
  
  // 브라우저 렌더링 사이클 지연 포커싱으로 포커스 유실 방지
  setTimeout(() => {
    document.getElementById('editMedPackSize').focus();
  }, 50);
}

function handleEditMedSave() {
  const idStr = document.getElementById('editMedId').value;
  const name = document.getElementById('editMedName').value.trim();
  const category_id = parseInt(document.getElementById('editMedCategorySelect').value);
  const packSize = parseFloat(document.getElementById('editMedPackSize').value);
  const unopened = parseInt(document.getElementById('editMedUnopened').value) || 0;
  const remain = parseFloat(document.getElementById('editMedRemain').value) || 0;
  const safety = parseFloat(document.getElementById('editMedSafety').value) || 0;
  const unit = document.getElementById('editMedUnit').value.trim() || 'g';

  if (!name) {
    alert('약재명을 입력해 주세요.');
    return;
  }
  if (isNaN(packSize) || packSize <= 0) {
    alert('팩 규격을 올바르게 입력해 주세요.');
    return;
  }
  if (remain > packSize) {
    alert(`개봉 잔량(${remain}g)은 팩 규격(${packSize}g)을 초과할 수 없습니다.`);
    return;
  }

  try {
    if (idStr) {
      // 수정 모드
      const medId = parseInt(idStr);
      const loss = dbManager.updateMedicine(medId, {
        category_id,
        pack_size: packSize,
        unopened_packs: unopened,
        opened_pack_remain: remain,
        safety_stock: safety,
        unit
      });

      showToast(`✏️ "${name}" 약재 데이터 수정 완료 (오차 보정: ${loss > 0 ? '+' : ''}${loss}g)`);
      if (currentInquiryMedId === medId) {
        inquiryMedicineDetails(medId);
      }
    } else {
      // 추가 모드
      dbManager.addMedicine({
        name,
        category_id,
        pack_size: packSize,
        unopened_packs: unopened,
        opened_pack_remain: remain,
        safety_stock: safety,
        unit
      });
      showToast(`✨ 새 약재 "${name}"이(가) 등록되었습니다.`);
    }

    document.getElementById('editMedicineModal').classList.remove('show');
    renderMedicineList();
    renderPredictView();
  } catch (err) {
    alert(`저장 실패: ${err.message}`);
  }
}

// ----------------------------------------------------
// 마우스 우클릭 커스텀 컨텍스트 메뉴 제어
// ----------------------------------------------------
function showContextMenu(x, y) {
  const menu = document.getElementById('medContextMenu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = 'flex';
  
  // 다른 곳 클릭 시 메뉴 숨기기 위해 글로벌 리스너 연결
  const hideMenu = () => {
    menu.style.display = 'none';
    document.removeEventListener('click', hideMenu);
  };
  // 살짝 지연시켜서 즉시 닫히지 않게 처리
  setTimeout(() => document.addEventListener('click', hideMenu), 50);
}

// ----------------------------------------------------
// Toast 알림 전송기
// ----------------------------------------------------
function showToast(message, isError = false) {
  const toast = document.getElementById('toastMessage');
  toast.textContent = message;
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

// ----------------------------------------------------
// DOM 로드 및 이벤트 통합 바인딩
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initDatabase();

  const searchInput = document.getElementById('inquirySearchInput'); // 초기 포커스 대행
  const mainTabs = document.getElementById('mainTabs');

  // 3개 탭 검색창에 실시간 검색(Filter) 및 포커스 상태 동기화 바인딩
  ['inquirySearchInput', 'prescriptionSearchInput', 'batchSearchInput'].forEach(id => {
    const inputEl = document.getElementById(id);
    if (inputEl) {
      inputEl.addEventListener('input', () => {
        searchEngine.state = 'search';
        searchEngine.currentListIndex = -1;
        searchEngine.lastSelectedIndex = -1;
        searchEngine.selectedIds.clear();
        searchEngine.callbacks.onSelectionChange(searchEngine.selectedIds);
        renderMedicineList();
      });
      inputEl.addEventListener('focus', () => {
        if (searchEngine.state !== 'search') {
          searchEngine.setFocusState('search');
        }
      });
    }
  });

  // 처방 기록 상세조회 모달 닫기 바인딩
  const btnViewPrescClose = document.getElementById('btnViewPrescClose');
  if (btnViewPrescClose) {
    btnViewPrescClose.addEventListener('click', () => {
      document.getElementById('prescriptionDetailModal').classList.remove('show');
    });
  }

  // 검색 엔진 초기화
  searchEngine = new QuickSearchEngine({
    searchInput: searchInput, 
    categoryTabs: document.getElementById('inquiryCategoryContainer'), // 초기 바인딩
    listContainer: document.getElementById('inquiryMedicineList'),     // 초기 바인딩
    popupContainer: document.getElementById('quantityPopup'),
    popupInput: document.getElementById('popupQuantityInput')
  }, {
    onFilter: () => {
      renderMedicineList();
    },
    onAddToPrescription: (medId, amount) => {
      const med = dbManager.getAllMedicines().find(m => m.id === medId);
      if (!med) return;
      
      const exists = currentPrescriptionItems.find(item => item.id === medId);
      if (exists) {
        exists.amount += amount;
      } else {
        currentPrescriptionItems.push({
          id: medId,
          name: med.name,
          pack_size: med.pack_size,
          amount: amount
        });
      }
      renderPrescription();
      showToast(`✅ "${med.name}" ${amount}g 이 처방전에 추가되었습니다.`);
    },
    getCurrentListItems: () => {
      let listContainerId = 'inquiryMedicineList';
      if (currentTab === 'prescription') listContainerId = 'prescriptionMedicineList';
      else if (currentTab === 'batch') listContainerId = 'batchMedicineList';
      
      const el = document.getElementById(listContainerId);
      return el ? Array.from(el.querySelectorAll('.medicine-item')) : [];
    },
    onTabChange: (tabIdx) => {
      const buttons = Array.from(mainTabs.querySelectorAll('.tab-btn'));
      if (buttons[tabIdx]) {
        switchTab(buttons[tabIdx].dataset.tab);
      }
    },
    onInquiryMed: (medId) => {
      inquiryMedicineDetails(medId);
    },
    onAddToBatch: (medId) => {
      addMedToBatch(medId);
    },
    onSelectionChange: (selectedIds) => {
      // 복수 선택 상태 스타일을 렌더링에 동기화 반영
      const items = searchEngine.callbacks.getCurrentListItems();
      items.forEach(item => {
        const id = parseInt(item.dataset.id);
        if (selectedIds.has(id)) {
          item.classList.add('active', 'multi-selected');
        } else {
          item.classList.remove('multi-selected');
        }
      });
    }
  });

  // ----------------------------------------------------
  // 메인 탭바 뷰 스위칭 핵심 로직
  // ----------------------------------------------------
  function switchTab(tabName) {
    currentTab = tabName;
    searchEngine.selectedIds.clear();
    searchEngine.callbacks.onSelectionChange(searchEngine.selectedIds);

    // activeTab 인덱스 동기화 (Alt 단축키 및 엔터 기능 연동용)
    const tabNames = ['inquiry', 'prescription', 'predict', 'batch'];
    const tabIndex = tabNames.indexOf(tabName);
    if (tabIndex !== -1) {
      searchEngine.activeTab = tabIndex;
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

      searchEngine.elements.searchInput = sInput;
      searchEngine.elements.categoryTabs = cContainer;
      searchEngine.elements.listContainer = lContainer;

      // 동적 카테고리 생성 바인딩
      renderCategoryTabs(cContainer);
      renderMedicineList();
      
      // 검색창 강제 포커싱
      searchEngine.setFocusState('search');
    }

    // 4. 탭 전용 화면 렌더링 갱신
    if (tabName === 'prescription') {
      renderPrescription();
      renderPastPrescriptions();
    } else if (tabName === 'predict') {
      renderPredictView();
    } else if (tabName === 'batch') {
      renderBatchTable();
    }
  }

  // 마우스 클릭 탭 스위칭 바인딩
  mainTabs.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-btn')) {
      switchTab(e.target.dataset.tab);
    }
  });

  // 설정 버튼 클릭 바인딩 (Supabase 공유 설정 모달 연동)
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
      
      settingsModal.classList.add('show');
    });

    btnSettingsCancel.addEventListener('click', () => {
      settingsModal.classList.remove('show');
    });

    btnSettingsSave.addEventListener('click', () => {
      const url = settingsSupabaseUrl.value.trim();
      const key = settingsSupabaseKey.value.trim();

      localStorage.setItem('supabase_url', url);
      localStorage.setItem('supabase_key', key);

      settingsModal.classList.remove('show');

      if (url && key) {
        showToast('⚙️ 설정이 저장되었습니다. 데이터베이스 공유 동기화를 시도합니다.');
        // dbManager에 설정 전송하여 Supabase 동기화 인프라 재구축
        if (dbManager && typeof dbManager.setupSupabase === 'function') {
          dbManager.setupSupabase(url, key)
            .then(success => {
              if (success) {
                showToast('🟢 Supabase 클라우드 데이터베이스와 성공적으로 연결 및 동기화되었습니다.');
                // 동기화 후 목록 갱신
                renderMedicineList();
                // 처방 탭의 loadAllPrescriptions 또는 처방 목록도 갱신해야 할 수 있음
                const viewPrescTable = document.getElementById('prescriptionHistoryBody');
                if (viewPrescTable) {
                  // 처방 이력이 있으면 갱신
                  renderPrescriptionHistory();
                }
              } else {
                showToast('🔴 Supabase 연결에 실패했습니다. 설정을 다시 확인해주세요.', true);
              }
            })
            .catch(err => {
              console.error(err);
              showToast('🔴 Supabase 연결 오류: ' + err.message, true);
            });
        }
      } else {
        showToast('⚙️ 설정을 해제했습니다. 로컬 단독 모드로 작동합니다.');
        if (dbManager && typeof dbManager.setupSupabase === 'function') {
          dbManager.setupSupabase('', ''); // 연결 해제
        }
      }
    });
  }

  // 카테고리 클릭 및 동적 모달 트리거 바인딩 (이벤트 위임)
  document.addEventListener('click', (e) => {
    // 1. 카테고리 탭 클릭 시 필터링 변경
    if (e.target.classList.contains('category-tab')) {
      const parent = e.target.parentElement;
      const tabs = Array.from(parent.querySelectorAll('.category-tab'));
      searchEngine.currentCategoryIndex = tabs.indexOf(e.target);
      
      tabs.forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');

      renderMedicineList();
      searchEngine.setFocusState('category');
    }

    // 2. 동적 카테고리 추가 "+" 버튼
    if (e.target.id === 'btnCategoryModalOpen') {
      document.getElementById('addCategoryModal').classList.add('show');
      setTimeout(() => {
        document.getElementById('newCategoryName').focus();
      }, 50);
    }
  });

  // ----------------------------------------------------
  // 모달 제어 리스너 바인딩
  // ----------------------------------------------------
  
  // 카테고리 생성 취소/저장
  document.getElementById('btnCategoryCancel').addEventListener('click', () => {
    document.getElementById('addCategoryModal').classList.remove('show');
    document.getElementById('newCategoryName').value = '';
  });
  document.getElementById('btnCategorySave').addEventListener('click', handleAddCategorySave);

  // 약재 추가/수정 모달 취소/저장
  document.getElementById('btnEditMedCancel').addEventListener('click', () => {
    document.getElementById('editMedicineModal').classList.remove('show');
  });
  document.getElementById('btnEditMedSave').addEventListener('click', handleEditMedSave);

  // DB 추가하기 버튼 연동 (각 탭마다 있는 수동추가 단추 통합 제어)
  document.querySelectorAll('.btn-med-add').forEach(btn => {
    btn.addEventListener('click', openAddMedicineModal);
  });

  // ----------------------------------------------------
  // 우클릭 컨텍스트 메뉴 액션 연동
  // ----------------------------------------------------
  document.getElementById('ctxMenuEdit').addEventListener('click', () => {
    if (contextTargetMedId !== null) {
      openEditMedicineModal(contextTargetMedId);
    }
  });

  document.getElementById('ctxMenuDelete').addEventListener('click', () => {
    if (contextTargetMedId !== null) {
      const med = dbManager.getAllMedicines().find(m => m.id === contextTargetMedId);
      if (confirm(`⚠️ 정말로 "${med.name}" 약재를 삭제하시겠습니까? 관련 입출고 로그 및 처방 내역 연쇄 정보가 모두 영구 유실됩니다.`)) {
        dbManager.deleteMedicine(contextTargetMedId);
        showToast(`🗑️ "${med.name}" 약재 데이터가 영구 삭제되었습니다.`, true);
        
        if (currentInquiryMedId === contextTargetMedId) {
          document.getElementById('inquiryDetailEmpty').style.display = 'flex';
          document.getElementById('inquiryDetailContent').style.display = 'none';
          document.getElementById('inquiryLogsEmpty').style.display = 'flex';
          document.getElementById('inquiryLogsWrapper').style.display = 'none';
        }
        
        renderMedicineList();
        renderPredictView();
      }
    }
  });

  // ----------------------------------------------------
  // [처방] 조제 제출 처리
  // ----------------------------------------------------
  document.getElementById('btnCompletePrescription').addEventListener('click', () => {
    const prescName = document.getElementById('prescriptionName').value.trim();
    const patName = document.getElementById('patientName').value.trim();
    const prescNote = document.getElementById('prescriptionNote').value.trim();

    if (!prescName || !patName) {
      alert('처방명과 환자명을 입력해 주세요.');
      return;
    }
    if (currentPrescriptionItems.length === 0) {
      alert('처방전에 추가된 약재가 없습니다.');
      return;
    }

    try {
      const items = currentPrescriptionItems.map(item => ({
        medicineId: item.id,
        amount: item.amount
      }));

      dbManager.addPrescription(prescName, patName, items, prescNote);

      showToast(`🎉 "${prescName}" 조제 완료 및 실시간 재고 차감 처리되었습니다.`);
      currentPrescriptionItems = [];
      document.getElementById('prescriptionName').value = '';
      document.getElementById('patientName').value = '';
      document.getElementById('prescriptionNote').value = '';
      renderPrescription();
      renderMedicineList();
      renderPastPrescriptions();
    } catch (err) {
      alert(`조제 처리 실패: ${err.message}`);
      showToast('재고 부족으로 조제 불가', true);
    }
  });

  // ----------------------------------------------------
  // [발주 예측] 제어 바인딩
  // ----------------------------------------------------
  document.getElementById('predLeadTime').addEventListener('change', renderPredictView);
  document.getElementById('predAnalysisDays').addEventListener('change', renderPredictView);
  document.getElementById('btnSyncPredictor').addEventListener('click', () => {
    const leadTime = parseInt(document.getElementById('predLeadTime').value) || 7;
    const analysisDays = parseInt(document.getElementById('predAnalysisDays').value) || 30;
    
    try {
      predictor.updateSafetyStocksToSuggested(leadTime, analysisDays);
      showToast(`🔄 동적 안전재고 갱신 완료 (분석: ${analysisDays}일 / 리드: ${leadTime}일)`);
      renderPredictView();
      renderMedicineList();
    } catch (err) {
      alert(`갱신 실패: ${err.message}`);
    }
  });

  // ----------------------------------------------------
  // [일괄 작업] 제어 바인딩
  // ----------------------------------------------------
  document.getElementById('btnBatchClear').addEventListener('click', () => {
    batchEditItems.clear();
    renderBatchTable();
  });
  document.getElementById('btnBatchSave').addEventListener('click', saveBatchChanges);

  // ----------------------------------------------------
  // CSV 입출력 (모든 탭 공유 액션 통합)
  // ----------------------------------------------------
  
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
    reader.onload = function(evt) {
      const arrayBuffer = evt.target.result;
      let text = '';
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
          alert('파일 인코딩을 해석할 수 없습니다. UTF-8 또는 EUC-KR 형식이어야 합니다.');
          return;
        }
      }

      try {
        const result = csvHandler.importFromCSV(text, dbManager);
        let msg = `성공: ${result.successCount}건, 건너뜀: ${result.skipCount}건`;
        if (result.errors.length > 0) {
          console.warn('CSV 로드 경고:', result.errors);
          showToast(`CSV 임포트 완료 - 에러로그 확인 필요`, true);
        } else {
          showToast(`📥 CSV 임포트 성공! (${msg})`);
        }

        renderMedicineList();
        renderPredictView();
      } catch (err) {
        alert(`CSV 파싱 실패: ${err.message}`);
      }
      e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
  });

  // 익스포트 연결
  document.querySelectorAll('.btn-csv-export').forEach(btn => {
    btn.addEventListener('click', () => {
      try {
        const csvContent = csvHandler.exportToCSV(dbManager);
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `한의원약재재고_${new Date().toISOString().slice(0,10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('📤 CSV 파일로 재고 정보가 내보내졌습니다.');
      } catch (err) {
        alert(`CSV 내보내기 실패: ${err.message}`);
      }
    });
  });

  // ----------------------------------------------------
  // 모달 키보드 편의성 연동 (Esc로 닫기, Tab 키 포커스 가두기)
  // ----------------------------------------------------
  document.addEventListener('keydown', (e) => {
    // 1. Esc 키로 모든 모달 닫기
    if (e.key === 'Escape') {
      const modals = ['editMedicineModal', 'addCategoryModal', 'prescriptionDetailModal', 'quantityPopup'];
      modals.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.classList.contains('show')) {
          el.classList.remove('show');
          if (id === 'addCategoryModal') document.getElementById('newCategoryName').value = '';
          if (id === 'quantityPopup') document.getElementById('popupQuantityInput').value = '';
        }
      });
      if (typeof hideContextMenu === 'function') {
        hideContextMenu();
      }
    }

    // 2. Tab / Shift+Tab 포커스 트랩 (Focus Trap)
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
  });

  // 초기 로딩 탭 실행
  switchTab('inquiry');
});
