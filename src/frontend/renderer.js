/**
 * @file renderer.js
 * @description UI 컴포넌트 이벤트 연결, 4대 탭 바인딩, Canvas 차트 드로잉, 
 * 다중 카테고리, Shift 복수 선택, 우클릭 수정 및 일괄 변경 제어 구현.
 */

// 고해상도(DPI) 화면 배율에 따른 내부 콘텐츠 줌 레벨 조정 (윈도우 환경 전용)
try {
  const { webFrame } = require('electron');
  const isWindows = process.platform === 'win32';
  if (isWindows && window.devicePixelRatio > 1.5) {
    // 윈도우 OS 화면 배율이 150%(devicePixelRatio > 1.5)를 넘을 경우,
    // UI의 크기를 80% 수준으로 소폭 축소시켜 적절한 여백과 가독성을 확보합니다.
    // 맥북 레티나 디스플레이 등 타 OS 고해상도 환경은 영향을 받지 않습니다.
    webFrame.setZoomFactor(0.8);
  }
} catch (e) {
  console.error("화면 배율(DPI) 조정 실패:", e);
}

// 기본 카테고리('미분류') 고정 UUID (백엔드 상수와 동일)
const DEFAULT_CATEGORY_ID = require('../backend/InventoryManager').DEFAULT_CATEGORY_ID;

/**
 * 사용자 입력 데이터를 innerHTML 템플릿에 안전하게 삽입하기 위한 HTML 이스케이프 헬퍼.
 * 약재명/환자명/메모 등 모든 사용자 유래 문자열은 반드시 이 함수를 거쳐야 합니다. (XSS 방지)
 */
function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
let contextTargetPrescId = null; // 우클릭 대상 처방 ID
let contextTargetCategoryId = null; // 우클릭 대상 카테고리 ID
let isPrescriptionEditMode = false; // 처방 수정 모드 활성화 여부
let currentEditingPrescId = null; // 현재 수정 중인 처방 ID
let isPresetEditMode = false; // 프리셋 수정 모드 활성화 여부
let currentEditingPresetId = null; // 현재 수정 중인 프리셋 ID
let contextTargetPresetId = null; // 우클릭 대상 프리셋 ID
let currentPrescMode = 'prescription'; // 'prescription' | 'preset'
let currentHistoryTab = 'history'; // 'history' | 'presets'

/**
 * UTC 기반의 시간 문자열(예: 'YYYY-MM-DD HH:mm:ss' 또는 ISO 8601 형식)을
 * 한국 시간대(KST, UTC+9)의 Date 객체로 변환합니다.
 * @param {string|Date} [utcTime]
 * @returns {Date} KST 기준의 Date 객체
 */
function parseUTCToKST(utcTime) {
  if (!utcTime) return new Date();
  
  if (utcTime instanceof Date) {
    return utcTime;
  }

  let formatted = utcTime.toString().trim();
  if (formatted.indexOf('T') === -1) {
    formatted = formatted.replace(' ', 'T');
  }
  if (!formatted.endsWith('Z') && !formatted.includes('+')) {
    formatted += 'Z';
  }
  
  const date = new Date(formatted);
  if (isNaN(date.getTime())) return new Date();
  return date;
}

/**
 * UTC 기반 시간 문자열을 한국 시간대 'YYYY-MM-DD HH:mm:ss' 형식으로 포맷팅합니다.
 * 인자가 없거나 falsy할 경우 현재 시간(KST) 문자열을 반환합니다.
 * @param {string} [utcTimeStr]
 * @returns {string} 'YYYY-MM-DD HH:mm:ss'
 */
function formatUTCToKSTString(utcTimeStr) {
  if (!utcTimeStr) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
  
  const date = parseUTCToKST(utcTimeStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function initDatabase() {
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
        const viewPrescTable = document.getElementById('pastPrescriptionsBody');
        if (viewPrescTable) renderPastPrescriptions();
      });
    }
    
    // 구동 시 Supabase 자동 연결 및 백그라운드 동기화 수행
    const savedUrl = localStorage.getItem('supabase_url');
    const savedKey = localStorage.getItem('supabase_key');
    if (savedUrl && savedKey) {
      dbManager.setupSupabase(savedUrl, savedKey)
        .then(success => {
          if (success) {
            showToast('🟢 Supabase 공유 DB 동기화가 활성화되었습니다.');
            renderMedicineList();
            const viewPrescTable = document.getElementById('pastPrescriptionsBody');
            if (viewPrescTable) renderPastPrescriptions();
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
  } catch (e) {
    console.error('데이터베이스 초기화 실패:', e);
    showToast('⚠️ 데이터베이스 초기화 실패: ' + e.message, true);
  }
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
    html += `<button class="category-tab ${activeCategoryId == cat.id ? 'active' : ''}" data-category-id="${escapeHtml(cat.id)}">${escapeHtml(cat.name)}</button>`;
  });
  // 카테고리 동적 추가 + 단추 추가
  html += `<button class="category-add-btn" id="btnCategoryModalOpen">➕ 카테고리 추가</button>`;
  
  container.innerHTML = html;
}

/**
 * 활성 탭에 맞춰 약재 리스트 렌더링
 */
function renderMedicineList(categoryFilter = null) {
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
  
  let targetCategory = categoryFilter;
  if (!targetCategory) {
    const activeTab = categoryContainer ? categoryContainer.querySelector('.category-tab.active') : null;
    targetCategory = activeTab ? activeTab.dataset.categoryId : '전체';
  }

  const medicines = dbManager.getAllMedicines();
  
  // 필터링 처리
  const filtered = medicines.filter(med => {
    // 1. 카테고리 필터
    if (targetCategory !== '전체' && med.category_id != targetCategory) {
      return false;
    }
    // 2. 검색어 매칭 (이명까지 포함)
    if (searchQuery) {
      return searchEngine.match(med.name, searchQuery, med.aliases);
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
      showContextMenu('medContextMenu', e.pageX, e.pageY);
    });

    listContainer.appendChild(item);
  });

  if (searchEngine && searchEngine.state === 'list') {
    const items = Array.from(listContainer.querySelectorAll('.medicine-item'));
    searchEngine.updateActiveListItem(items);
  }
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
    document.getElementById('detAliases').textContent = info.aliases && info.aliases.length > 0 ? info.aliases.join(', ') : '-';
    document.getElementById('detCategory').textContent = info.categoryName;
    document.getElementById('detPackSize').textContent = `${info.pack_size}${info.unit}`;
    document.getElementById('detTotalStock').textContent = info.formatted;
    document.getElementById('detSafetyStock').textContent = `${info.safety_stock}${info.unit}`;
    document.getElementById('detUnit').textContent = info.unit;
    document.getElementById('detMemo').value = info.memo || '';

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
  
  // Canvas 해상도 선명화 처리 (크기 변화 시에만 GPU 메모리 재할당)
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const expectedWidth = rect.width * dpr;
  const expectedHeight = rect.height * dpr;
  if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
    canvas.width = expectedWidth;
    canvas.height = expectedHeight;
    ctx.scale(dpr, dpr);
  }

  const width = rect.width;
  const height = rect.height;

  // 1. 데이터 소스 획득 (최근 30일간의 CONSUME 로그)
  const logs = dbManager.getLogsByMedicine(medId).filter(l => l.type === 'CONSUME');
  
  // 날짜별 소모량 절대값 합산
  const consumptionMap = new Map();
  logs.forEach(log => {
    const kstStr = formatUTCToKSTString(log.timestamp);
    const dateStr = kstStr.split(' ')[0]; // KST 기준 YYYY-MM-DD
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
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
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

    let qtyFormatted = '';
    let colorStyle = 'var(--color-text-main)';
    if (log.quantity === 0) {
      qtyFormatted = '-';
    } else {
      qtyFormatted = log.quantity > 0 ? `+${log.quantity}g` : `${log.quantity}g`;
      colorStyle = log.quantity > 0 ? 'var(--color-primary)' : 'var(--color-accent)';
    }

    tr.innerHTML = `
      <td>${typeBadge}</td>
      <td style="font-weight:700; color:${colorStyle}">${escapeHtml(qtyFormatted)}</td>
      <td style="color:var(--color-text-muted);">${formatUTCToKSTString(log.timestamp).slice(5, 16)}</td>
      <td style="font-size:11px;">${escapeHtml(log.note || '')}</td>
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
    tr.dataset.index = index; // 인덱스를 dataset으로 설정
    tr.innerHTML = `
      <td style="font-weight:700; color:var(--color-primary);">${escapeHtml(item.name)}</td>
      <td style="color:var(--color-text-muted);">${escapeHtml(item.pack_size)}g 기준</td>
      <td>
        <input type="text" value="${escapeHtml(item.amount)}"
               class="presc-item-amount-input numeric-input" data-numeric-type="decimal"
               style="width: 70px; padding: 4px; border: 1px solid var(--color-border); border-radius: 4px; text-align: center;"> g
      </td>
      <td style="text-align: center;">
        <span class="presc-remove-btn" style="cursor:pointer;"><span class="sf-icon sf-icon-xmark"></span></span>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/**
 * 과거 전체 처방 기록 완료 이력 렌더링
 */
function renderPastPrescriptions() {
  const wrapper = document.getElementById('pastPrescriptionsWrapper');
  const empty = document.getElementById('pastPrescriptionsEmpty');
  const tbody = document.getElementById('pastPrescriptionsBody');
  tbody.innerHTML = '';

  const searchInput = document.getElementById('pastPrescriptionsSearch');
  const searchQuery = searchInput ? searchInput.value.trim() : '';

  const list = searchQuery !== '' 
    ? dbManager.searchPrescriptions(searchQuery)
    : dbManager.getAllPrescriptions();

  if (list.length === 0) {
    wrapper.style.display = 'none';
    empty.style.display = currentHistoryTab === 'history' ? 'flex' : 'none';
    return;
  }

  empty.style.display = 'none';
  wrapper.style.display = currentHistoryTab === 'history' ? 'block' : 'none';

  list.forEach(p => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    const statusHtml = p.is_deducted === 1
      ? '<span style="color:#2ecc71; font-weight:bold;">차감 완료</span>'
      : '<span style="color:#e67e22; font-weight:bold;">미차감</span>';

    tr.innerHTML = `
      <td style="font-weight:700; color:var(--color-primary);">${escapeHtml(p.prescription_name || '(이름 없음)')}</td>
      <td>${escapeHtml(p.patient_name)}</td>
      <td style="text-align:center;">${escapeHtml(p.total_items)}종</td>
      <td style="color:var(--color-text-muted); font-size:11px;">${formatUTCToKSTString(p.created_at)}</td>
      <td style="text-align:center; font-size:11px;">${statusHtml}</td>
    `;
    
    // 행 클릭 시 과거 처방 세부 품목 상세 모달 로드
    tr.addEventListener('click', () => {
      openPrescriptionDetailModal(p.id);
    });

    // 마우스 우클릭 (Context Menu) 처방 편집/삭제 트리거
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextTargetPrescId = p.id;
      
      const deductItem = document.getElementById('ctxPrescDeduct');
      if (deductItem) {
        if (p.is_deducted === 1) {
          deductItem.style.display = 'none';
        } else {
          deductItem.style.display = 'block';
        }
      }
      
      showContextMenu('prescContextMenu', e.pageX, e.pageY);
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
    
    document.getElementById('viewPrescName').textContent = detail.prescription_name || '(이름 없음)';
    document.getElementById('viewPrescPatient').textContent = detail.patient_name;
    document.getElementById('viewPrescDate').textContent = formatUTCToKSTString(detail.created_at);
    document.getElementById('viewPrescNote').textContent = detail.note || '메모 없음';
    
    const isDeducted = detail.is_deducted === 1;
    const statusEl = document.getElementById('viewPrescStatus');
    const deductBtn = document.getElementById('btnDeductPrescriptionDetail');

    if (isDeducted) {
      statusEl.textContent = '차감 완료';
      statusEl.style.color = '#2ecc71';
      deductBtn.style.display = 'none';
    } else {
      statusEl.textContent = '미차감';
      statusEl.style.color = '#e67e22';
      deductBtn.style.display = 'inline-block';
      
      deductBtn.onclick = () => {
        const prescNameDisplay = detail.prescription_name || '(이름 없음)';
        if (confirm(`"${prescNameDisplay}" 처방의 약재 재고 차감을 실행하시겠습니까?\n이 작업은 되돌릴 수 없으며 중복 실행할 수 없습니다.`)) {
          try {
            dbManager.deductPrescriptionStock(prescId);
            showToast('🎉 재고 차감이 성공적으로 완료되었습니다.');
            document.getElementById('prescriptionDetailModal').classList.remove('show');
            renderMedicineList();
            renderPastPrescriptions();
            renderPredictView();
            renderNotifications();
          } catch (err) {
            alert(`재고 차감 실패: ${err.message}`);
          }
        }
      };
    }

    const tbody = document.getElementById('viewPrescItemsBody');
    tbody.innerHTML = '';
    
    detail.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight:700; color:var(--color-primary);">${escapeHtml(item.medicine_name)}</td>
        <td style="text-align:right; font-weight:600;">${escapeHtml(item.amount)}${escapeHtml(item.unit)}</td>
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
    const unitHtml = escapeHtml(item.unit);
    tr.innerHTML = `
      <td style="font-weight:700; color:var(--color-primary);">${escapeHtml(item.name)}</td>
      <td><span class="status-badge" style="background:#f1f4f2; color:var(--color-text-muted);">${escapeHtml(item.category)}</span></td>
      <td>${escapeHtml(item.packSize)}${unitHtml}</td>
      <td style="font-weight:600;">${escapeHtml(item.currentStock)}${unitHtml}</td>
      <td style="color:var(--color-text-muted);">${escapeHtml(item.safetyStock)}${unitHtml}</td>
      <td style="color:var(--color-accent); font-weight:700;">-${escapeHtml(item.deficit)}${unitHtml}</td>
      <td>${escapeHtml(item.nextMonthEstimate)}${unitHtml}</td>
      <td style="font-weight:700; color:var(--color-primary);">+${escapeHtml(item.orderQuantityGrams)}${unitHtml}</td>
      <td style="font-weight:700; background:#f5fdf7; color:var(--color-primary);"><span class="sf-icon sf-icon-box"></span> ${escapeHtml(item.orderPacks)}봉지</td>
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
    unit: med.unit,
    is_presence_only: med.is_presence_only
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
      catOptions += `<option value="${escapeHtml(c.id)}" ${item.category_id == c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`;
    });

    let checkUI = '';
    if (item.is_presence_only === 1) {
      const isChecked = item.unopened_packs > 0;
      checkUI = `
        <td style="color:var(--color-text-muted); text-align:center;">-</td>
        <td colspan="2" style="text-align: center; font-weight: bold;">
          <label style="display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-weight:normal; font-size:11px;">
            <input type="checkbox" class="batch-presence-checkbox" ${isChecked ? 'checked' : ''} style="transform: scale(1.1); cursor:pointer;">
            재고 있음
          </label>
        </td>
        <td style="color:var(--color-text-muted); text-align:center;">-</td>
      `;
    } else {
      checkUI = `
        <td><input type="text" class="batch-pack numeric-input" data-numeric-type="decimal" value="${escapeHtml(item.pack_size)}"></td>
        <td><input type="text" class="batch-unopened numeric-input" data-numeric-type="integer" value="${escapeHtml(item.unopened_packs)}"></td>
        <td><input type="text" class="batch-remain numeric-input" data-numeric-type="decimal" value="${escapeHtml(item.opened_pack_remain)}"></td>
        <td><input type="text" class="batch-safety numeric-input" data-numeric-type="decimal" value="${escapeHtml(item.safety_stock)}"></td>
      `;
    }

    tr.innerHTML = `
      <td style="font-weight:700; color:var(--color-primary);">${escapeHtml(item.name)}</td>
      <td>
        <select class="batch-cat" style="padding: 2px 4px; border:1px solid var(--color-border); border-radius:4px; font-size:11px;">
          ${catOptions}
        </select>
      </td>
      ${checkUI}
      <td><input type="text" class="batch-unit" value="${escapeHtml(item.unit)}" style="width:40px;" ${item.is_presence_only === 1 ? 'disabled style="background:var(--bg-primary); color:var(--color-text-muted); text-align:center;"' : ''}></td>
      <td>
        <span class="batch-remove-btn" style="cursor:pointer;"><span class="sf-icon sf-icon-xmark"></span></span>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/**
 * 일괄 작업 내용 DB 일괄 업데이트 실행
 */
function saveBatchChanges() {
  const tbody = document.getElementById('batchTableBody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  if (rows.length === 0) return;

  // 1. 유효성 사전 검사 (동작 원자성 확보)
  for (const row of rows) {
    const checkbox = row.querySelector('.batch-presence-checkbox');
    const isPresenceOnly = !!checkbox;

    if (!isPresenceOnly) {
      const pack_size = parseFloat(row.querySelector('.batch-pack').value);
      const opened_pack_remain = parseFloat(row.querySelector('.batch-remain').value) || 0;

      if (isNaN(pack_size) || pack_size <= 0) {
        alert(`"${row.cells[0].textContent}"의 팩 규격은 0보다 커야 합니다.`);
        return;
      }
      if (opened_pack_remain > pack_size) {
        alert(`"${row.cells[0].textContent}"의 개봉 잔량은 팩 규격을 초과할 수 없습니다.`);
        return;
      }
    }
  }

  // 2. 실제 데이터 반영
  let successCount = 0;
  let hasError = false;

  for (const row of rows) {
    const id = row.dataset.id;
    const category_id = row.querySelector('.batch-cat').value;
    
    const checkbox = row.querySelector('.batch-presence-checkbox');
    const isPresenceOnly = !!checkbox;

    let pack_size = 500;
    let unopened_packs = 0;
    let opened_pack_remain = 0;
    let safety_stock = 0;
    let unit = 'g';

    if (isPresenceOnly) {
      unopened_packs = checkbox.checked ? 1 : 0;
    } else {
      pack_size = parseFloat(row.querySelector('.batch-pack').value);
      unopened_packs = parseInt(row.querySelector('.batch-unopened').value) || 0;
      opened_pack_remain = parseFloat(row.querySelector('.batch-remain').value) || 0;
      safety_stock = parseFloat(row.querySelector('.batch-safety').value) || 0;
      unit = row.querySelector('.batch-unit').value.trim() || 'g';
    }

    try {
      dbManager.updateMedicine(id, {
        category_id,
        pack_size,
        unopened_packs,
        opened_pack_remain,
        safety_stock,
        unit,
        is_presence_only: isPresenceOnly ? 1 : 0
      });
      successCount++;
    } catch (err) {
      console.error(err);
      alert(`"${row.cells[0].textContent}" 저장 중 에러 발생: ${err.message}`);
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

function handleEditCategorySave() {
  const idStr = document.getElementById('editCategoryId').value;
  const input = document.getElementById('editCategoryName');
  const name = input.value.trim();

  if (!name) {
    alert('카테고리명을 입력해 주세요.');
    return;
  }
  if (!idStr) return;

  try {
    dbManager.updateCategory(idStr, name);
    showToast(`✨ 카테고리가 "${name}"(으)로 수정되었습니다.`);

    // 모달 닫기
    document.getElementById('editCategoryModal').classList.remove('show');
    input.value = '';
    contextTargetCategoryId = null;

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
    alert(`카테고리 수정 실패: ${err.message}`);
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
  document.getElementById('editMedAliases').value = '';
  document.getElementById('editMedPackSize').value = '500';
  document.getElementById('editMedUnopened').value = '0';
  document.getElementById('editMedRemain').value = '0';
  document.getElementById('editMedSafety').value = '500';
  document.getElementById('editMedUnit').value = 'g';

  // 재고 관리 방식 라디오 초기화
  document.getElementById('editMedTypeWeight').checked = true;
  toggleMedTypeFields(false);

  // 카테고리 셀렉트박스 바인딩
  const select = document.getElementById('editMedCategorySelect');
  select.innerHTML = '';
  dbManager.getAllCategories().forEach(c => {
    select.innerHTML += `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`;
  });

  modal.classList.add('show');
  
  // 브라우저 렌더링 사이클 지연 포커싱으로 포커스 유실 방지
  setTimeout(() => {
    document.getElementById('editMedName').focus();
  }, 50);
}

function openEditMedicineModal(medId) {
  const modal = document.getElementById('editMedicineModal');
  document.getElementById('editModalHeader').innerHTML = '<span class="sf-icon sf-icon-pencil"></span> 약재 정보 수정';
  
  const med = dbManager.getAllMedicines().find(m => m.id === medId);
  if (!med) return;

  document.getElementById('editMedId').value = med.id;
  document.getElementById('editMedName').value = med.name;
  document.getElementById('editMedName').readOnly = true; // 약재명은 SQLite UNIQUE 제약 및 오작동 차단을 위해 읽기전용 처리
  document.getElementById('editMedAliases').value = med.aliases ? med.aliases.join(', ') : '';
  document.getElementById('editMedPackSize').value = med.pack_size;
  document.getElementById('editMedUnopened').value = med.unopened_packs;
  document.getElementById('editMedRemain').value = med.opened_pack_remain;
  document.getElementById('editMedSafety').value = med.safety_stock;
  document.getElementById('editMedUnit').value = med.unit;

  // 재고 관리 방식 라디오 바인딩 및 필드 제어
  if (med.is_presence_only === 1) {
    document.getElementById('editMedTypePresence').checked = true;
    toggleMedTypeFields(true);
  } else {
    document.getElementById('editMedTypeWeight').checked = true;
    toggleMedTypeFields(false);
  }

  const select = document.getElementById('editMedCategorySelect');
  select.innerHTML = '';
  dbManager.getAllCategories().forEach(c => {
    select.innerHTML += `<option value="${escapeHtml(c.id)}" ${med.category_id == c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`;
  });

  modal.classList.add('show');
  
  // 브라우저 렌더링 사이클 지연 포커싱으로 포커스 유실 방지
  setTimeout(() => {
    document.getElementById('editMedUnopened').focus();
  }, 50);
}

function handleEditMedSave() {
  const idStr = document.getElementById('editMedId').value;
  const name = document.getElementById('editMedName').value.trim();
  const aliasesStr = document.getElementById('editMedAliases').value;
  const aliases = aliasesStr ? aliasesStr.split(',').map(a => a.trim()).filter(Boolean) : [];
  const category_id = document.getElementById('editMedCategorySelect').value;
  
  const is_presence_only = parseInt(document.querySelector('input[name="editMedCheckType"]:checked').value);
  let packSize = parseFloat(document.getElementById('editMedPackSize').value);
  let unopened = parseInt(document.getElementById('editMedUnopened').value) || 0;
  let remain = parseFloat(document.getElementById('editMedRemain').value) || 0;
  let safety = parseFloat(document.getElementById('editMedSafety').value) || 0;
  let unit = document.getElementById('editMedUnit').value.trim() || 'g';

  if (!name) {
    alert('약재명을 입력해 주세요.');
    return;
  }

  // 단순 유무 관리인 경우 가상의 값으로 세팅 및 정규화
  if (is_presence_only === 1) {
    packSize = 500;
    unopened = unopened > 0 ? 1 : 0;
    remain = 0;
    safety = 0;
    unit = 'g';
  } else {
    if (isNaN(packSize) || packSize <= 0) {
      alert('팩 규격을 올바르게 입력해 주세요.');
      return;
    }
    if (remain > packSize) {
      alert(`개봉 잔량(${remain}g)은 팩 규격(${packSize}g)을 초과할 수 없습니다.`);
      return;
    }
  }

  try {
    if (idStr) {
      // 수정 모드
      const medId = idStr;
      const loss = dbManager.updateMedicine(medId, {
        category_id,
        pack_size: packSize,
        unopened_packs: unopened,
        opened_pack_remain: remain,
        safety_stock: safety,
        unit,
        aliases,
        is_presence_only
      });

      if (is_presence_only === 1) {
        showToast(`✏️ "${name}" 약재 데이터 수정 완료 (단순 유무 관리)`);
      } else {
        showToast(`✏️ "${name}" 약재 데이터 수정 완료 (오차 보정: ${loss > 0 ? '+' : ''}${loss}g)`);
      }
      
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
        unit,
        aliases,
        is_presence_only
      });
      showToast(`✨ 새 약재 "${name}"이(가) 등록되었습니다.`);
    }

    document.getElementById('editMedicineModal').classList.remove('show');
    renderMedicineList();
    renderPredictView();
    if (searchEngine) {
      searchEngine.setFocusState('search');
    }
  } catch (err) {
    alert(`저장 실패: ${err.message}`);
  }
}

// ----------------------------------------------------
// 마우스 우클릭 커스텀 컨텍스트 메뉴 제어
// ----------------------------------------------------
function showContextMenu(menuElementId, x, y) {
  const menu = document.getElementById(menuElementId);
  menu.style.display = 'flex';
  
  // 화면 경계 이탈을 방지하기 위해 너비/높이 획득 후 보정
  const menuWidth = menu.offsetWidth || 140;
  const menuHeight = menu.offsetHeight || 80;
  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;

  if (x + menuWidth > windowWidth) {
    x = windowWidth - menuWidth - 10;
  }
  if (y + menuHeight > windowHeight) {
    y = windowHeight - menuHeight - 10;
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  
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
  
  // Map emojis to their SF Symbols class
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

  // Find the leading emoji (if any) and replace it with a styled span
  for (const [emoji, iconName] of Object.entries(emojiToSfMap)) {
    if (message.startsWith(emoji)) {
      let iconHtml = `<span class="sf-icon sf-icon-${iconName}"></span>`;
      // Color customizations for specific statuses
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


// ----------------------------------------------------
/**
 * 단순 유무 관리 토글 시 모달 내 입력 필드를 제어하는 헬퍼 함수
 */
function toggleMedTypeFields(isPresence) {
  const packSizeEl = document.getElementById('editMedPackSize');
  const unopenedEl = document.getElementById('editMedUnopened');
  const remainEl = document.getElementById('editMedRemain');
  const safetyEl = document.getElementById('editMedSafety');
  const unitEl = document.getElementById('editMedUnit');
  const unopenedLabel = document.querySelector('label[for="editMedUnopened"]');

  const packSizeGroup = packSizeEl.closest('.input-group');
  const remainGroup = remainEl.closest('.input-group');
  const safetyGroup = safetyEl.closest('.input-group');
  const unitGroup = unitEl.closest('.input-group');

  if (isPresence) {
    packSizeEl.value = '500';
    remainEl.value = '0';
    safetyEl.value = '0';
    unitEl.value = 'g';
    
    if (packSizeGroup) packSizeGroup.style.display = 'none';
    if (remainGroup) remainGroup.style.display = 'none';
    if (safetyGroup) safetyGroup.style.display = 'none';
    if (unitGroup) unitGroup.style.display = 'none';
    
    if (unopenedLabel) {
      unopenedLabel.textContent = '재고 상태 (1: 있음, 0: 없음)';
    }
  } else {
    if (packSizeGroup) packSizeGroup.style.display = 'flex';
    if (remainGroup) remainGroup.style.display = 'flex';
    if (safetyGroup) safetyGroup.style.display = 'flex';
    if (unitGroup) unitGroup.style.display = 'flex';
    
    // 단순 유무 관리로 변경되면서 0으로 초기화되었던 안전 재고를 기본값 500으로 복원
    if (safetyEl.value === '0' || !safetyEl.value) {
      safetyEl.value = '500';
    }
    // 팩 규격도 비어 있거나 0이면 500으로 복원
    if (packSizeEl.value === '0' || packSizeEl.value === '1' || !packSizeEl.value) {
      packSizeEl.value = '500';
    }

    if (unopenedLabel) {
      unopenedLabel.textContent = '미개봉 팩(봉지) 수';
    }
  }
}

// DOM 로드 및 이벤트 통합 바인딩
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initDatabase();

  // 약재 상세 메모 자동 저장 리스너 추가
  const detMemo = document.getElementById('detMemo');
  if (detMemo) {
    detMemo.addEventListener('blur', () => {
      if (currentInquiryMedId) {
        const val = detMemo.value;
        try {
          dbManager.updateMedicine(currentInquiryMedId, { memo: val });
          showToast('📝 메모가 저장되었습니다.');
        } catch (err) {
          console.error('메모 자동 저장 실패:', err);
          showToast('메모 저장에 실패했습니다.', true);
        }
      }
    });
  }

  // 약재 관리 방식 라디오 버튼 변경 이벤트 바인딩
  const radioWeight = document.getElementById('editMedTypeWeight');
  const radioPresence = document.getElementById('editMedTypePresence');
  if (radioWeight && radioPresence) {
    radioWeight.addEventListener('change', () => toggleMedTypeFields(false));
    radioPresence.addEventListener('change', () => toggleMedTypeFields(true));
  }

  // 처방 바구니 테이블 이벤트 위임 바인딩
  const prescTbody = document.getElementById('prescriptionBody');
  if (prescTbody) {
    prescTbody.addEventListener('change', (e) => {
      if (e.target.classList.contains('presc-item-amount-input')) {
        const tr = e.target.closest('tr');
        const index = parseInt(tr.dataset.index);
        const val = parseFloat(e.target.value);
        if (!isNaN(val) && val > 0) {
          currentPrescriptionItems[index].amount = val;
        }
      }
    });
    prescTbody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('presc-item-amount-input')) {
        e.preventDefault();
        const tr = e.target.closest('tr');
        const index = parseInt(tr.dataset.index);
        const val = parseFloat(e.target.value);
        if (!isNaN(val) && val > 0) {
          currentPrescriptionItems[index].amount = val;
        }
        if (currentPrescMode === 'preset') {
          const savePresetBtn = document.getElementById('btnSavePreset');
          if (savePresetBtn) savePresetBtn.click();
        } else {
          const completeBtn = document.getElementById('btnDeductStock');
          if (completeBtn) completeBtn.click();
        }
      }
    });
    prescTbody.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.presc-remove-btn');
      if (removeBtn) {
        const tr = removeBtn.closest('tr');
        const index = parseInt(tr.dataset.index);
        currentPrescriptionItems.splice(index, 1);
        renderPrescription();
      }
    });
  }

  // 일괄 작업 편집 테이블 이벤트 위임 바인딩
  const batchTbody = document.getElementById('batchTableBody');
  if (batchTbody) {
    batchTbody.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.batch-remove-btn');
      if (removeBtn) {
        const tr = removeBtn.closest('tr');
        batchEditItems.delete(tr.dataset.id);
        renderBatchTable();
      }
    });

    // 방향키 상하좌우를 통한 셀(입력창) 간 포커스 그리드 이동 구현
    batchTbody.addEventListener('keydown', (e) => {
      const target = e.target;
      if (!['INPUT', 'SELECT'].includes(target.tagName)) return;

      const key = e.key;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;

      const tr = target.closest('tr');
      if (!tr) return;

      // 현재 tr 안의 활성 입력 및 선택 요소 리스트
      const inputs = Array.from(tr.querySelectorAll('input:not([type="hidden"]), select'));
      const colIndex = inputs.indexOf(target);

      if (key === 'ArrowLeft') {
        if (colIndex > 0) {
          e.preventDefault();
          inputs[colIndex - 1].focus();
          if (inputs[colIndex - 1].select) inputs[colIndex - 1].select();
        }
      } else if (key === 'ArrowRight') {
        if (colIndex < inputs.length - 1) {
          e.preventDefault();
          inputs[colIndex + 1].focus();
          if (inputs[colIndex + 1].select) inputs[colIndex + 1].select();
        }
      } else if (key === 'ArrowUp') {
        const prevTr = tr.previousElementSibling;
        if (prevTr) {
          e.preventDefault();
          const prevInputs = Array.from(prevTr.querySelectorAll('input:not([type="hidden"]), select'));
          if (prevInputs[colIndex]) {
            prevInputs[colIndex].focus();
            if (prevInputs[colIndex].select) prevInputs[colIndex].select();
          }
        }
      } else if (key === 'ArrowDown') {
        const nextTr = tr.nextElementSibling;
        if (nextTr) {
          e.preventDefault();
          const nextInputs = Array.from(nextTr.querySelectorAll('input:not([type="hidden"]), select'));
          if (nextInputs[colIndex]) {
            nextInputs[colIndex].focus();
            if (nextInputs[colIndex].select) nextInputs[colIndex].select();
          }
        }
      }
    });
  }

  const searchInput = document.getElementById('inquirySearchInput'); // 초기 포커스 대행
  const mainTabs = document.getElementById('mainTabs');

  // 3개 탭 검색창에 실시간 검색(Filter) 및 포커스 상태 동기화 바인딩
  ['inquirySearchInput', 'prescriptionSearchInput', 'batchSearchInput'].forEach(id => {
    const inputEl = document.getElementById(id);
    if (inputEl) {
      inputEl.addEventListener('input', () => {
        // QuickSearchEngine의 공용 상태 리셋 메서드를 명시적으로 호출합니다.
        searchEngine.resetSearchState();
        renderMedicineList();
      });
      inputEl.addEventListener('focus', () => {
        if (searchEngine.state !== 'search') {
          searchEngine.setFocusState('search');
        }
      });
    }
  });

  // 과거 처방 완료 이력 및 프리셋 실시간 검색 바인딩
  const pastPrescSearch = document.getElementById('pastPrescriptionsSearch');
  if (pastPrescSearch) {
    pastPrescSearch.addEventListener('input', () => {
      if (currentHistoryTab === 'history') {
        renderPastPrescriptions();
      } else {
        renderPresetsHistoryList();
      }
    });
  }

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
    onFilter: (categoryId) => {
      renderMedicineList(categoryId);
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
    onEditMed: (medId) => {
      openEditMedicineModal(medId);
    },
    onSelectionChange: (selectedIds) => {
      // 복수 선택 상태 스타일을 렌더링에 동기화 반영
      const items = searchEngine.callbacks.getCurrentListItems();
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
    } else {
      if (document.activeElement) {
        document.activeElement.blur();
      }
    }

    // 4. 탭 전용 화면 렌더링 갱신
    if (tabName === 'prescription') {
      renderPrescription();
      setHistoryTab(currentHistoryTab);
    } else if (tabName === 'predict') {
      renderPredictView();
    } else if (tabName === 'batch') {
      renderBatchTable();
    }
  }

  // ----------------------------------------------------
  // 처방전 조제 수정 모드 제어 함수
  // ----------------------------------------------------
  function setPrescMode(mode) {
    currentPrescMode = mode;
    
    const btnPresc = document.getElementById('btnModePrescription');
    const btnPreset = document.getElementById('btnModePreset');
    const groupPatient = document.getElementById('groupPatientName');
    const groupPresetLoad = document.getElementById('groupOpenPresetLoad');
    const labelPrescName = document.getElementById('labelPrescriptionName');
    const inputPrescName = document.getElementById('prescriptionName');
    
    const labelNote = document.getElementById('labelPrescriptionNote');
    const noteInput = document.getElementById('prescriptionNote');
    
    const prescActions = document.getElementById('prescriptionActionRow');
    const presetActions = document.getElementById('presetActionRow');
    
    if (mode === 'prescription') {
      btnPresc.classList.add('active');
      btnPreset.classList.remove('active');
      groupPatient.style.display = 'flex';
      groupPresetLoad.style.display = 'flex';
      labelPrescName.textContent = '처방명';
      inputPrescName.placeholder = '예: 감기약 (선택)';
      labelNote.textContent = '처방 메모';
      noteInput.placeholder = '예: 하루 3회 복용, 식후 30분 따뜻하게 복용';
      prescActions.style.display = 'flex';
      presetActions.style.display = 'none';
    } else {
      btnPresc.classList.remove('active');
      btnPreset.classList.add('active');
      groupPatient.style.display = 'none';
      groupPresetLoad.style.display = 'none';
      labelPrescName.textContent = '처방명 (프리셋 이름)';
      inputPrescName.placeholder = '예: 감기약';
      labelNote.textContent = '프리셋 메모';
      noteInput.placeholder = '예: 감기 기본 처방, 식후 30분 복용';
      prescActions.style.display = 'none';
      presetActions.style.display = 'flex';
    }
    
    // 모드 변경 시 깔끔한 시작을 위해 입력 필드 및 바구니 리셋
    document.getElementById('prescriptionName').value = '';
    document.getElementById('patientName').value = '';
    document.getElementById('prescriptionNote').value = '';
    currentPrescriptionItems = [];
    renderPrescription();
  }

  function enterPrescriptionEditMode(prescId) {
    if (isPresetEditMode) {
      exitPresetEditMode();
    }
    try {
      const detail = dbManager.getPrescriptionDetails(prescId);
      isPrescriptionEditMode = true;
      currentEditingPrescId = prescId;

      // 1. UI 탭 전환
      switchTab('prescription');

      // 2. 제목 변경 및 강조 스타일링 추가 (모드 스위처 숨기고 편집 타이틀 표시)
      document.querySelector('.presc-mode-switcher').style.display = 'none';
      const titleEl = document.getElementById('prescriptionCardTitle');
      titleEl.style.display = 'block';
      titleEl.innerHTML = `<span class="sf-icon sf-icon-memo"></span> 조제 수정 (${escapeHtml(detail.prescription_name || detail.patient_name)})`;
      document.getElementById('prescriptionCard').classList.add('edit-mode-highlight');

      // 편집 시에는 항상 환자 처방 모드 필드로 강제 표시 (불러오기 버튼은 감춤)
      document.getElementById('groupPatientName').style.display = 'flex';
      document.getElementById('groupPrescriptionName').style.display = 'flex';
      document.getElementById('groupOpenPresetLoad').style.display = 'none';
      document.getElementById('labelPrescriptionName').textContent = '처방명';
      document.getElementById('prescriptionName').placeholder = '예: 감기약 (선택)';
      document.getElementById('labelPrescriptionNote').textContent = '처방 메모';
      document.getElementById('prescriptionNote').placeholder = '예: 하루 3회 복용, 식후 30분 따뜻하게 복용';
      document.getElementById('prescriptionActionRow').style.display = 'flex';
      document.getElementById('presetActionRow').style.display = 'none';

      // 3. 수정 취소 버튼 표시 및 버튼 텍스트/스타일 변경
      document.getElementById('btnCancelEditPrescription').style.display = 'flex';
      
      const saveBtn = document.getElementById('btnSaveOnlyPrescription');
      saveBtn.className = 'btn btn-secondary';
      saveBtn.style.flex = '1';
      saveBtn.innerHTML = '<span class="sf-icon sf-icon-save"></span> 수정 저장';
      
      const isAlreadyDeducted = detail.is_deducted === 1;
      const deductBtn = document.getElementById('btnDeductStock');
      deductBtn.className = 'btn btn-primary';
      deductBtn.style.flex = '2';
      deductBtn.style.display = 'flex';
      deductBtn.innerHTML = isAlreadyDeducted ? '<span class="sf-icon sf-icon-box"></span> 재고 갱신' : '<span class="sf-icon sf-icon-box"></span> 재고 차감';

      // 4. 입력 필드 값 적재
      document.getElementById('prescriptionName').value = detail.prescription_name || '';
      document.getElementById('patientName').value = detail.patient_name;
      document.getElementById('prescriptionNote').value = detail.note || '';

      // 5. 처방 바구니 복원
      currentPrescriptionItems = detail.items.map(item => {
        const med = dbManager.getAllMedicines().find(m => m.id === item.medicine_id);
        return {
          id: item.medicine_id,
          name: item.medicine_name,
          pack_size: med ? med.pack_size : 500,
          amount: item.amount
        };
      });

      renderPrescription();
    } catch (err) {
      alert(`처방 데이터를 불러오지 못했습니다: ${err.message}`);
    }
  }

  function exitPrescriptionEditMode() {
    isPrescriptionEditMode = false;
    currentEditingPrescId = null;

    // 1. 제목 및 스타일링 원복 (모드 스위처 보이고 타이틀 숨김)
    document.querySelector('.presc-mode-switcher').style.display = 'flex';
    document.getElementById('prescriptionCardTitle').style.display = 'none';
    document.getElementById('prescriptionCard').classList.remove('edit-mode-highlight');

    // 2. 취소 버튼 숨기기 및 완료 버튼 텍스트/스타일 원복
    document.getElementById('btnCancelEditPrescription').style.display = 'none';
    
    const saveBtn = document.getElementById('btnSaveOnlyPrescription');
    saveBtn.className = 'btn btn-primary';
    saveBtn.style.flex = '2';
    saveBtn.innerHTML = '<span class="sf-icon sf-icon-save"></span> 처방 저장';
    
    const deductBtn = document.getElementById('btnDeductStock');
    deductBtn.className = 'btn btn-secondary';
    deductBtn.style.flex = '1';
    deductBtn.style.display = 'none';
    deductBtn.innerHTML = '<span class="sf-icon sf-icon-box"></span> 재고 차감';

    // 스위처 상태 리셋 (처방 모드로 전환 및 필드 리셋)
    setPrescMode('prescription');
  }

  function enterPresetEditMode(presetId) {
    if (isPrescriptionEditMode) {
      exitPrescriptionEditMode();
    }
    try {
      const detail = dbManager.getPresetDetails(presetId);
      isPresetEditMode = true;
      currentEditingPresetId = presetId;

      // 1. UI 탭 전환
      switchTab('prescription');

      // 2. 프리셋 모드로 설정
      setPrescMode('preset');

      // 3. 제목 변경 및 강조 스타일링 추가 (모드 스위처 숨기고 편집 타이틀 표시)
      document.querySelector('.presc-mode-switcher').style.display = 'none';
      const titleEl = document.getElementById('prescriptionCardTitle');
      titleEl.style.display = 'block';
      titleEl.innerHTML = `<span class="sf-icon sf-icon-pencil"></span> 프리셋 수정 (${escapeHtml(detail.preset_name)})`;
      document.getElementById('prescriptionCard').classList.add('edit-mode-highlight');

      // 4. 취소 버튼 노출 및 저장 버튼 스타일 조정
      document.getElementById('btnCancelEditPreset').style.display = 'flex';
      const saveBtn = document.getElementById('btnSavePreset');
      saveBtn.style.width = 'auto';
      saveBtn.style.flex = '2';
      saveBtn.innerHTML = '<span class="sf-icon sf-icon-save"></span> 수정 저장';

      // 5. 프리셋 데이터 채워넣기
      document.getElementById('prescriptionName').value = detail.preset_name;
      document.getElementById('prescriptionNote').value = detail.note || '';

      currentPrescriptionItems = detail.items.map(item => {
        const med = dbManager.getAllMedicines().find(m => m.id === item.medicine_id);
        return {
          id: item.medicine_id,
          name: item.medicine_name,
          pack_size: med ? med.pack_size : 500,
          amount: item.amount
        };
      });

      renderPrescription();
    } catch (err) {
      alert(`프리셋 데이터를 불러오지 못했습니다: ${err.message}`);
    }
  }

  function exitPresetEditMode() {
    isPresetEditMode = false;
    currentEditingPresetId = null;

    // 1. 제목 및 스타일링 원복 (모드 스위처 보이고 타이틀 숨김)
    document.querySelector('.presc-mode-switcher').style.display = 'flex';
    document.getElementById('prescriptionCardTitle').style.display = 'none';
    document.getElementById('prescriptionCard').classList.remove('edit-mode-highlight');

    // 2. 취소 버튼 숨기기 및 완료 버튼 텍스트/스타일 원복
    document.getElementById('btnCancelEditPreset').style.display = 'none';
    
    const saveBtn = document.getElementById('btnSavePreset');
    saveBtn.style.width = '100%';
    saveBtn.style.flex = 'none';
    saveBtn.innerHTML = '<span class="sf-icon sf-icon-star"></span> 처방 프리셋 저장';

    // 스위처 상태 리셋 (처방 모드로 전환 및 필드 리셋)
    setPrescMode('prescription');
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

    btnSettingsSave.addEventListener('click', () => {
      let url = settingsSupabaseUrl.value.trim();
      const key = settingsSupabaseKey.value.trim();

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
                const viewPrescTable = document.getElementById('pastPrescriptionsBody');
                if (viewPrescTable) {
                  // 처방 이력이 있으면 갱신
                  renderPastPrescriptions();
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

  // 카테고리 수정 취소/저장
  document.getElementById('btnEditCategoryCancel').addEventListener('click', () => {
    document.getElementById('editCategoryModal').classList.remove('show');
    document.getElementById('editCategoryName').value = '';
    contextTargetCategoryId = null;
  });
  document.getElementById('btnEditCategorySave').addEventListener('click', handleEditCategorySave);

  // 약재 추가/수정 모달 취소/저장
  document.getElementById('btnEditMedCancel').addEventListener('click', () => {
    document.getElementById('editMedicineModal').classList.remove('show');
    contextTargetMedId = null;
    if (searchEngine) {
      searchEngine.setFocusState('search');
    }
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
      contextTargetMedId = null;
    }
  });

  document.getElementById('ctxMenuDelete').addEventListener('click', () => {
    if (contextTargetMedId !== null) {
      const med = dbManager.getAllMedicines().find(m => m.id === contextTargetMedId);
      if (confirm(`⚠️ 정말로 "${med.name}" 약재를 삭제하시겠습니까? 관련 입출고 로그, 처방 내역 및 프리셋 구성 정보가 모두 영구 유실됩니다.`)) {
        try {
          dbManager.deleteMedicine(contextTargetMedId);
        } catch (err) {
          showToast(`⚠️ 약재 삭제 실패: ${err.message}`, true);
          contextTargetMedId = null;
          return;
        }
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
      contextTargetMedId = null;
    }
  });

  // ----------------------------------------------------
  // 처방 우클릭 컨텍스트 메뉴 액션 연동
  // ----------------------------------------------------
  document.getElementById('ctxPrescEdit').addEventListener('click', () => {
    if (contextTargetPrescId !== null) {
      enterPrescriptionEditMode(contextTargetPrescId);
      contextTargetPrescId = null;
    }
  });

  document.getElementById('ctxPrescDeduct').addEventListener('click', () => {
    if (contextTargetPrescId !== null) {
      const detail = dbManager.getPrescriptionDetails(contextTargetPrescId);
      if (detail.is_deducted === 1) {
        showToast('ℹ️ 이미 재고가 차감된 처방전입니다.');
        contextTargetPrescId = null;
        return;
      }
      if (confirm(`"${detail.prescription_name}" 처방의 약재 재고 차감을 실행하시겠습니까?\n이 작업은 되돌릴 수 없으며 중복 실행할 수 없습니다.`)) {
        try {
          dbManager.deductPrescriptionStock(contextTargetPrescId);
          showToast('🎉 재고 차감이 성공적으로 완료되었습니다.');
          renderMedicineList();
          renderPastPrescriptions();
          renderPredictView();
          renderNotifications();
        } catch (err) {
          alert(`재고 차감 실패: ${err.message}`);
        }
      }
      contextTargetPrescId = null;
    }
  });

  document.getElementById('ctxPrescDelete').addEventListener('click', () => {
    if (contextTargetPrescId !== null) {
      const detail = dbManager.getPrescriptionDetails(contextTargetPrescId);
      if (confirm(`⚠️ 정말로 처방전 (${detail.prescription_name || '(이름 없음)'} - ${detail.patient_name})을 삭제하시겠습니까? 소모된 약재 재고가 모두 자동으로 복원됩니다.`)) {
        try {
          dbManager.deletePrescription(contextTargetPrescId);
          showToast(`🗑️ 처방 내역이 삭제되고 재고가 복원되었습니다.`, true);
          
          if (isPrescriptionEditMode && contextTargetPrescId === currentEditingPrescId) {
            exitPrescriptionEditMode();
          }

          renderPastPrescriptions();
          renderMedicineList();
          renderPredictView();
        } catch (err) {
          alert(`처방 삭제 실패: ${err.message}`);
        }
      }
      contextTargetPrescId = null;
    }
  });

  // ----------------------------------------------------
  // 카테고리 우클릭 컨텍스트 메뉴 액션 연동
  // ----------------------------------------------------
  document.getElementById('ctxCategoryEdit').addEventListener('click', () => {
    if (contextTargetCategoryId !== null) {
      const cat = dbManager.getAllCategories().find(c => c.id === contextTargetCategoryId);
      if (cat) {
        document.getElementById('editCategoryId').value = cat.id;
        document.getElementById('editCategoryName').value = cat.name;
        document.getElementById('editCategoryModal').classList.add('show');
        setTimeout(() => {
          document.getElementById('editCategoryName').focus();
        }, 50);
      }
    }
  });

  document.getElementById('ctxCategoryDelete').addEventListener('click', () => {
    if (contextTargetCategoryId !== null) {
      const cat = dbManager.getAllCategories().find(c => c.id === contextTargetCategoryId);
      if (cat) {
        if (confirm(`⚠️ 정말로 "${cat.name}" 카테고리를 삭제하시겠습니까?\n카테고리가 삭제되면 이 카테고리에 속한 약재들은 모두 '미분류' 카테고리로 이동됩니다.`)) {
          try {
            dbManager.deleteCategory(contextTargetCategoryId);
            showToast(`🗑️ "${cat.name}" 카테고리가 삭제되었습니다.`, true);

            // UI 갱신
            const containers = ['inquiryCategoryContainer', 'prescriptionCategoryContainer', 'batchCategoryContainer'];
            containers.forEach(cId => {
              const el = document.getElementById(cId);
              if (el) renderCategoryTabs(el);
            });
            renderMedicineList();
          } catch (err) {
            alert(`카테고리 삭제 실패: ${err.message}`);
          }
        }
      }
      contextTargetCategoryId = null;
    }
  });

  // ----------------------------------------------------
  // 프리셋 우클릭 컨텍스트 메뉴 액션 연동
  // ----------------------------------------------------
  document.getElementById('ctxPresetEdit').addEventListener('click', () => {
    if (contextTargetPresetId !== null) {
      enterPresetEditMode(contextTargetPresetId);
      contextTargetPresetId = null;
    }
  });

  document.getElementById('ctxPresetDelete').addEventListener('click', () => {
    if (contextTargetPresetId !== null) {
      const id = contextTargetPresetId;
      const preset = dbManager.getAllPresets().find(pr => String(pr.id) === String(id));
      if (confirm(`⚠️ 정말로 "${preset.preset_name}" 프리셋을 삭제하시겠습니까?`)) {
        try {
          dbManager.deletePreset(id);
          showToast('🗑️ 프리셋이 삭제되었습니다.', true);
          
          if (isPresetEditMode && id === currentEditingPresetId) {
            exitPresetEditMode();
          }

          renderPresetsHistoryList();
          if (document.getElementById('presetLoadModal').classList.contains('show')) {
            renderPresetListModal();
          }
        } catch (err) {
          alert(`프리셋 삭제 실패: ${err.message}`);
        }
      }
      contextTargetPresetId = null;
    }
  });

  document.getElementById('btnCancelEditPreset').addEventListener('click', () => {
    exitPresetEditMode();
  });

  // 카테고리 탭 우클릭 감지 (이벤트 위임)
  document.addEventListener('contextmenu', (e) => {
    if (e.target.classList.contains('category-tab')) {
      const catId = e.target.dataset.categoryId;
      if (catId === '전체') return; // '전체' 탭은 수정/삭제 불가

      if (catId === DEFAULT_CATEGORY_ID) {
        e.preventDefault();
        showToast('ℹ️ 기본 카테고리는 수정하거나 삭제할 수 없습니다.');
        return;
      }

      e.preventDefault();
      contextTargetCategoryId = catId;
      showContextMenu('categoryContextMenu', e.pageX, e.pageY);
    }
  });

  // 수정 취소 버튼
  document.getElementById('btnCancelEditPrescription').addEventListener('click', () => {
    exitPrescriptionEditMode();
  });

  // ----------------------------------------------------
  // [처방] 조제 제출 및 수정 완료 처리
  // ----------------------------------------------------
  function processPrescriptionSubmit(isDeduct) {
    const prescName = document.getElementById('prescriptionName').value.trim() || null;
    const patName = document.getElementById('patientName').value.trim();
    const prescNote = document.getElementById('prescriptionNote').value.trim();

    if (!patName) {
      alert('환자명을 입력해 주세요.');
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

      if (isPrescriptionEditMode && currentEditingPrescId !== null) {
        dbManager.updatePrescriptionWithItems(currentEditingPrescId, prescName, patName, items, prescNote, isDeduct);
        if (isDeduct) {
          showToast(`🎉 처방전 수정 완료 및 실시간 재고 갱신 처리되었습니다.`);
        } else {
          showToast(`🎉 처방전 수정 완료 및 정보 저장 처리되었습니다. (재고 미차감)`);
        }
        exitPrescriptionEditMode();
      } else {
        dbManager.addPrescription(prescName, patName, items, prescNote, isDeduct);
        const nameDisplay = prescName ? `"${prescName}" ` : '';
        if (isDeduct) {
          showToast(`🎉 ${nameDisplay}조제 완료 및 실시간 재고 차감 처리되었습니다.`);
        } else {
          showToast(`🎉 ${nameDisplay}처방이 저장되었습니다. (재고 미차감)`);
        }
      }

      currentPrescriptionItems = [];
      document.getElementById('prescriptionName').value = '';
      document.getElementById('patientName').value = '';
      document.getElementById('prescriptionNote').value = '';
      renderPrescription();
      renderMedicineList();
      renderPastPrescriptions();
      renderPredictView(); // 발주 예측도 실시간 업데이트
      renderNotifications(); // 알림 배지 및 리스트 동적 갱신
    } catch (err) {
      alert(`조제 처리 실패: ${err.message}`);
      showToast('재고 부족 등으로 조제 실패', true);
    }
  }

  document.getElementById('btnSaveOnlyPrescription').addEventListener('click', () => {
    processPrescriptionSubmit(false);
  });

  document.getElementById('btnDeductStock').addEventListener('click', () => {
    processPrescriptionSubmit(true);
  });

  // ----------------------------------------------------
  // [처방 프리셋] 이벤트 바인딩 및 함수
  // ----------------------------------------------------
  document.getElementById('btnModePrescription').addEventListener('click', () => {
    setPrescMode('prescription');
  });

  document.getElementById('btnModePreset').addEventListener('click', () => {
    setPrescMode('preset');
  });

  document.getElementById('btnSavePreset').addEventListener('click', () => {
    const presetName = document.getElementById('prescriptionName').value.trim();
    const note = document.getElementById('prescriptionNote').value.trim();

    if (!presetName) {
      alert('프리셋 처방명을 입력해 주세요.');
      return;
    }
    if (currentPrescriptionItems.length === 0) {
      alert('프리셋에 추가할 약재가 없습니다.');
      return;
    }

    try {
      const items = currentPrescriptionItems.map(item => ({
        medicineId: item.id,
        amount: item.amount
      }));

      if (isPresetEditMode && currentEditingPresetId !== null) {
        dbManager.updatePreset(currentEditingPresetId, presetName, note, items);
        showToast(`⭐ 프리셋 "${presetName}"이 수정되었습니다.`);
        exitPresetEditMode();
      } else {
        dbManager.addPreset(presetName, note, items);
        showToast(`⭐ 프리셋 "${presetName}"이 저장되었습니다.`);
        setPrescMode('prescription');
      }

      if (currentHistoryTab === 'presets') {
        renderPresetsHistoryList();
      }
    } catch (err) {
      alert(`프리셋 저장 실패: ${err.message}`);
    }
  });

  document.getElementById('btnOpenPresetLoad').addEventListener('click', () => {
    document.getElementById('presetLoadModal').classList.add('show');
    document.getElementById('presetSearchInput').value = '';
    renderPresetListModal();
  });

  document.getElementById('btnPresetLoadClose').addEventListener('click', () => {
    document.getElementById('presetLoadModal').classList.remove('show');
  });

  document.getElementById('presetSearchInput').addEventListener('input', () => {
    renderPresetListModal();
  });

  function renderPresetListModal() {
    const tbody = document.getElementById('presetListBody');
    const empty = document.getElementById('presetListEmpty');
    const searchQuery = document.getElementById('presetSearchInput').value.trim().toLowerCase();
    
    tbody.innerHTML = '';
    
    let presets = dbManager.getAllPresets();
    if (searchQuery) {
      presets = presets.filter(p => 
        p.preset_name.toLowerCase().includes(searchQuery) || 
        (p.note && p.note.toLowerCase().includes(searchQuery))
      );
    }
    
    if (presets.length === 0) {
      empty.style.display = 'flex';
      return;
    }
    
    empty.style.display = 'none';
    presets.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 700; color: var(--color-primary);">${escapeHtml(p.preset_name)}</td>
        <td style="font-style: italic; color: var(--color-text-muted); font-size: 11px;">${escapeHtml(p.note || '-')}</td>
        <td style="text-align: center;">
          <button class="btn-load-preset" data-id="${escapeHtml(p.id)}">적용</button>
        </td>
        <td style="text-align: center;">
          <button class="btn-delete-preset" data-id="${escapeHtml(p.id)}"><span class="sf-icon sf-icon-trash"></span></button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    
    // 불러오기 이벤트 연결
    tbody.querySelectorAll('.btn-load-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        loadPresetToBasket(id);
      });
    });
    
    // 삭제 이벤트 연결
    tbody.querySelectorAll('.btn-delete-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const preset = presets.find(p => String(p.id) === String(id));
        if (confirm(`"${preset.preset_name}" 프리셋을 삭제하시겠습니까?`)) {
          try {
            dbManager.deletePreset(id);
            showToast('프리셋이 삭제되었습니다.');
            renderPresetListModal();
            if (currentHistoryTab === 'presets') {
              renderPresetsHistoryList();
            }
          } catch (err) {
            alert(`프리셋 삭제 실패: ${err.message}`);
          }
        }
      });
    });
  }

  function loadPresetToBasket(presetId) {
    if (currentPrescriptionItems.length > 0) {
      if (!confirm('현재 작성 중인 처방전 약재 목록을 지우고 프리셋을 불러오시겠습니까?')) {
        return;
      }
    }

    try {
      const detail = dbManager.getPresetDetails(presetId);
      
      currentPrescriptionItems = detail.items.map(item => {
        const med = dbManager.getAllMedicines().find(m => m.id === item.medicine_id);
        return {
          id: item.medicine_id,
          name: item.medicine_name,
          pack_size: med ? med.pack_size : 500,
          amount: item.amount
        };
      });

      if (detail.note) {
        document.getElementById('prescriptionNote').value = detail.note;
      }
      
      renderPrescription();
      document.getElementById('presetLoadModal').classList.remove('show');
      showToast(`⭐ "${detail.preset_name}" 프리셋을 적용했습니다.`);
    } catch (err) {
      alert(`프리셋 로드 실패: ${err.message}`);
    }
  }

  // ----------------------------------------------------
  // [처방 완료 이력 & 프리셋 목록 탭 전환] 이벤트 바인딩 및 함수
  // ----------------------------------------------------
  document.getElementById('btnTabHistory').addEventListener('click', () => {
    setHistoryTab('history');
  });

  document.getElementById('btnTabPresets').addEventListener('click', () => {
    setHistoryTab('presets');
  });

  function setHistoryTab(tab) {
    currentHistoryTab = tab;
    
    const btnHistory = document.getElementById('btnTabHistory');
    const btnPresets = document.getElementById('btnTabPresets');
    
    const wrapperHistory = document.getElementById('pastPrescriptionsWrapper');
    const emptyHistory = document.getElementById('pastPrescriptionsEmpty');
    const wrapperPresets = document.getElementById('presetsHistoryWrapper');
    const emptyPresets = document.getElementById('presetsHistoryEmpty');
    
    const searchInput = document.getElementById('pastPrescriptionsSearch');
    
    if (tab === 'history') {
      btnHistory.classList.add('active');
      btnPresets.classList.remove('active');
      
      wrapperHistory.style.display = 'block';
      emptyHistory.style.display = 'none'; // renderPastPrescriptions will toggle this properly
      wrapperPresets.style.display = 'none';
      emptyPresets.style.display = 'none';
      
      searchInput.placeholder = '처방명, 환자명, 약재명 검색...';
      renderPastPrescriptions();
    } else {
      btnHistory.classList.remove('active');
      btnPresets.classList.add('active');
      
      wrapperHistory.style.display = 'none';
      emptyHistory.style.display = 'none';
      wrapperPresets.style.display = 'block';
      emptyPresets.style.display = 'none'; // renderPresetsHistoryList will toggle this properly
      
      searchInput.placeholder = '프리셋명, 메모 검색...';
      renderPresetsHistoryList();
    }
  }

  function renderPresetsHistoryList() {
    const tbody = document.getElementById('presetsHistoryBody');
    const empty = document.getElementById('presetsHistoryEmpty');
    const wrapper = document.getElementById('presetsHistoryWrapper');
    const searchQuery = document.getElementById('pastPrescriptionsSearch').value.trim().toLowerCase();
    
    tbody.innerHTML = '';
    
    let presets = dbManager.getAllPresets();
    if (searchQuery) {
      presets = presets.filter(p => 
        p.preset_name.toLowerCase().includes(searchQuery) || 
        (p.note && p.note.toLowerCase().includes(searchQuery))
      );
    }
    
    if (presets.length === 0) {
      wrapper.style.display = 'none';
      empty.style.display = currentHistoryTab === 'presets' ? 'flex' : 'none';
      return;
    }
    
    empty.style.display = 'none';
    wrapper.style.display = currentHistoryTab === 'presets' ? 'block' : 'none';
    
    presets.forEach(p => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td style="font-weight:700; color:var(--color-primary);">${escapeHtml(p.preset_name)}</td>
        <td style="font-style: italic; color:var(--color-text-muted); font-size:11px;">${escapeHtml(p.note || '-')}</td>
        <td style="text-align:center;">${escapeHtml(p.total_items)}종</td>
        <td style="color:var(--color-text-muted); font-size:11px;">${formatUTCToKSTString(p.created_at)}</td>
        <td style="text-align:center; display: flex; gap: 6px; justify-content: center; align-items: center; height: 100%;">
          <button class="btn btn-secondary btn-apply-preset-hist" data-id="${escapeHtml(p.id)}" style="padding: 2px 8px; font-size: 11px;">적용</button>
          <button class="btn btn-primary btn-delete-preset-hist" data-id="${escapeHtml(p.id)}" style="padding: 2px 8px; font-size: 11px; background: #e74c3c; border-color: #e74c3c;">삭제</button>
        </td>
      `;
      
      // 행 클릭 시 프리셋 상세 정보 모달 오픈
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openPresetDetailModal(p.id);
      });

      // 마우스 우클릭 (Context Menu) 프리셋 편집/삭제 트리거
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextTargetPresetId = p.id;
        showContextMenu('presetContextMenu', e.pageX, e.pageY);
      });
      
      tbody.appendChild(tr);
    });
    
    // 적용 버튼 바인딩
    tbody.querySelectorAll('.btn-apply-preset-hist').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        loadPresetToBasket(id);
      });
    });
    
    // 삭제 버튼 바인딩
    tbody.querySelectorAll('.btn-delete-preset-hist').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const preset = presets.find(pr => String(pr.id) === String(id));
        if (confirm(`"${preset.preset_name}" 프리셋을 삭제하시겠습니까?`)) {
          try {
            dbManager.deletePreset(id);
            showToast('프리셋이 삭제되었습니다.');
            renderPresetsHistoryList();
            // 불러오기 모달도 열려있으면 리스트 리프레시
            if (document.getElementById('presetLoadModal').classList.contains('show')) {
              renderPresetListModal();
            }
          } catch (err) {
            alert(`프리셋 삭제 실패: ${err.message}`);
          }
        }
      });
    });
  }

  function openPresetDetailModal(presetId) {
    try {
      const detail = dbManager.getPresetDetails(presetId);
      
      document.getElementById('viewPresetDetailName').textContent = detail.preset_name;
      document.getElementById('viewPresetDetailDate').textContent = formatUTCToKSTString(detail.created_at);
      document.getElementById('viewPresetDetailNote').textContent = detail.note || '메모 없음';
      
      const tbody = document.getElementById('viewPresetDetailItemsBody');
      tbody.innerHTML = '';
      
      detail.items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${escapeHtml(item.medicine_name)}</td>
          <td style="text-align: right; font-weight: bold;">${escapeHtml(item.amount)}${escapeHtml(item.unit)}</td>
        `;
        tbody.appendChild(tr);
      });
      
      const applyBtn = document.getElementById('btnPresetDetailApply');
      applyBtn.onclick = () => {
        loadPresetToBasket(presetId);
        document.getElementById('presetDetailModal').classList.remove('show');
      };
      
      document.getElementById('presetDetailModal').classList.add('show');
    } catch (err) {
      alert(`프리셋 데이터를 불러오지 못했습니다: ${err.message}`);
    }
  }

  document.getElementById('btnPresetDetailClose').addEventListener('click', () => {
    document.getElementById('presetDetailModal').classList.remove('show');
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
        link.setAttribute('download', `한의원약재재고_${formatUTCToKSTString().slice(0,10)}.csv`);
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
  // 모달 키보드 편의성 연동 (Esc로 닫기, Tab 키 포커스 가두기, Enter로 저장)
  // ----------------------------------------------------
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

  // 업데이트 기능 초기화
  initUpdateFeatures();

  // 숫자 입력 필드 선두 0 제거기 및 편의성 기능 초기화
  initNumberInputZeroStripper();

  // 알림 시스템 초기화 및 바인딩
  initNotificationEvents();
  renderNotifications();

  // 초기 로딩 탭 실행
  switchTab('inquiry');
});

/**
 * 자동 업데이트 UI 기능 초기화 및 메인 프로세스 IPC 이벤트 핸들러 바인딩.
 */
function initUpdateFeatures() {
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

/**
 * 모든 type="number" 및 class="numeric-input" 입력 필드에서 숫자가 아닌 값을 필터링하고,
 * 선두의 의미 없는 0을 제거하며, 포커스 시 자동으로 전체 선택되도록 돕는 편의성 기능 초기화.
 */
function initNumberInputZeroStripper() {
  function stripLeadingZeros(valueStr) {
    if (typeof valueStr !== 'string' || valueStr === '') return valueStr;

    const isNegative = valueStr.startsWith('-');
    let numStr = isNegative ? valueStr.slice(1) : valueStr;

    if (/^0+$/.test(numStr)) {
      numStr = '0';
    } else if (/^0{2,}\./.test(numStr)) {
      numStr = numStr.replace(/^0+/, '0');
    } else if (/^0+[1-9]/.test(numStr)) {
      numStr = numStr.replace(/^0+/, '');
    }

    return isNegative ? '-' + numStr : numStr;
  }

  function isNumericInput(target) {
    return target && target.tagName === 'INPUT' && 
      (target.type === 'number' || target.classList.contains('numeric-input'));
  }

  function sanitizeValue(target, val) {
    if (target.type === 'number') return val;
    
    const numericType = target.getAttribute('data-numeric-type');
    if (numericType === 'decimal') {
      // 숫자와 마침표(.)만 허용
      let cleaned = val.replace(/[^0-9.]/g, '');
      // 마침표가 여러 개 있으면 첫 번째 것만 유지
      const dotIndex = cleaned.indexOf('.');
      if (dotIndex !== -1) {
        cleaned = cleaned.slice(0, dotIndex + 1) + cleaned.slice(dotIndex + 1).replace(/\./g, '');
      }
      return cleaned;
    } else if (numericType === 'integer') {
      // 숫자만 허용
      return val.replace(/[^0-9]/g, '');
    }
    return val;
  }

  // 1. 실시간 입력(input) 시 필터링 및 선두 0 제거
  document.addEventListener('input', (e) => {
    if (isNumericInput(e.target)) {
      let val = e.target.value;
      val = sanitizeValue(e.target, val);
      const cleaned = stripLeadingZeros(val);
      if (e.target.value !== cleaned) {
        e.target.value = cleaned;
      }
    }
  });

  // 2. 포커스 해제(blur) 시 최종 선두 0 정리 및 변경 이벤트 전파
  document.addEventListener('blur', (e) => {
    if (isNumericInput(e.target)) {
      let val = e.target.value;
      val = sanitizeValue(e.target, val);
      
      // 소수점 입력창인데 마침표로 끝나는 경우 정제
      if (e.target.type !== 'number' && e.target.getAttribute('data-numeric-type') === 'decimal') {
        if (val === '.') val = '';
        else if (val.endsWith('.')) val = val.slice(0, -1);
      }

      const cleaned = stripLeadingZeros(val);
      if (e.target.value !== cleaned) {
        e.target.value = cleaned;
        e.target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, true); // blur 이벤트는 버블링되지 않으므로 캡처링 단계에서 캐치

  // 3. 포커스 시 전체 선택 (기존 0 또는 숫자를 쉽게 덮어쓸 수 있도록 지원)
  document.addEventListener('focus', (e) => {
    if (isNumericInput(e.target)) {
      const initialVal = e.target.value;
      setTimeout(() => {
        // 사용자가 지연 포커스 전에 이미 타이핑을 시작하여 값이 달라졌다면 선택을 스킵합니다.
        if (document.activeElement === e.target && e.target.value === initialVal && e.target.select) {
          e.target.select();
        }
      }, 0); // 마우스 클릭 이벤트 완료 후 실행을 위한 0ms 지연
    }
  }, true); // focus 이벤트는 버블링되지 않으므로 캡처링 단계에서 캐치
}

// ----------------------------------------------------
// 알림 시스템 제어 및 UI 렌더링
// ----------------------------------------------------
function renderNotifications() {
  const badge = document.getElementById('notificationBadge');
  const container = document.getElementById('notificationListContainer');
  const emptyState = document.getElementById('notificationEmptyState');
  
  if (!container) return;
  container.innerHTML = '';

  const list = dbManager.getNotifications();
  const unreadCount = list.filter(n => n.is_read === 0).length;

  // 배지 수량 갱신
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  if (list.length === 0) {
    emptyState.style.display = 'flex';
    container.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  container.style.display = 'flex';

  list.forEach(n => {
    const card = document.createElement('div');
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '5px';
    card.style.padding = '10px';
    card.style.borderRadius = 'var(--radius-sm)';
    card.style.border = '1px solid var(--color-border)';
    
    if (n.is_read === 0) {
      card.style.backgroundColor = 'rgba(45, 90, 39, 0.03)';
      card.style.borderColor = 'rgba(45, 90, 39, 0.15)';
    } else {
      card.style.backgroundColor = 'var(--bg-card)';
    }
    
    const timeStr = formatUTCToKSTString(n.created_at);

    // 버튼 구성 (inline onclick 제거: CSP 및 XSS 방어를 위해 data-속성 + 이벤트 위임 방식 사용)
    let actionButtons = '';
    if (n.is_read === 0) {
      actionButtons += `<button class="btn btn-primary noti-action" data-action="adjust" data-noti-id="${n.id}" data-med-id="${escapeHtml(n.medicine_id)}" style="font-size: 11px; padding: 4px 10px; height: 26px; display: inline-flex; align-items: center; justify-content: center;"><span class="sf-icon sf-icon-scale"></span> 잔량 보정</button>`;
      actionButtons += `<button class="btn noti-action" data-action="read" data-noti-id="${n.id}" style="font-size: 11px; padding: 4px 10px; height: 26px; border: 1px solid var(--color-border); background: var(--bg-card); display: inline-flex; align-items: center; justify-content: center;">읽음</button>`;
    }
    actionButtons += `<button class="btn noti-action" data-action="delete" data-noti-id="${n.id}" style="font-size: 11px; padding: 4px 10px; height: 26px; color: var(--color-accent); border: 1px solid var(--color-border); background: var(--bg-card); display: inline-flex; align-items: center; justify-content: center;">삭제</button>`;

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="color: var(--color-text-muted); font-size: 10px;">${timeStr}</span>
        ${n.is_read === 0 ? '<span style="background: var(--color-accent); color: white; border-radius: 4px; padding: 1px 4px; font-size: 9px; font-weight: bold;">NEW</span>' : ''}
      </div>
      <div style="font-size: 12.5px; line-height: 1.45; color: var(--color-text-main); font-weight: ${n.is_read === 0 ? '600' : 'normal'}; word-break: keep-all; margin: 2px 0 4px 0;">
        ${escapeHtml(n.message)}
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;">
        ${actionButtons}
      </div>
    `;
    container.appendChild(card);
  });
}

window.openNotificationAdjustModal = function(e, notiId, medId) {
  if (e) e.stopPropagation();
  const modal = document.getElementById('adjustNotificationRemainModal');
  const med = dbManager.getAllMedicines().find(m => String(m.id) === String(medId));

  if (!med) {
    alert('해당 약재를 찾을 수 없습니다.');
    return;
  }

  // 잔량 보정 창이 뜰 때 알림 팝오버 닫기
  const popover = document.getElementById('notificationPopover');
  if (popover) popover.style.display = 'none';

  document.getElementById('adjNotificationId').value = notiId;
  document.getElementById('adjNotificationMedId').value = med.id;
  document.getElementById('adjNotificationMedNameLabel').textContent = `약재명: ${med.name} (규격: ${med.pack_size}${med.unit})`;
  
  document.getElementById('adjNotificationPacks').value = med.unopened_packs;
  document.getElementById('adjNotificationRemain').value = med.opened_pack_remain;
  
  modal.classList.add('show');
};

window.readNotification = function(e, notiId) {
  if (e) e.stopPropagation();
  try {
    dbManager.markNotificationAsRead(notiId);
    renderNotifications();
  } catch (err) {
    alert(`알림 업데이트 실패: ${err.message}`);
  }
};

window.deleteNotification = function(e, notiId) {
  if (e) e.stopPropagation();
  try {
    dbManager.deleteNotification(notiId);
    renderNotifications();
  } catch (err) {
    alert(`알림 삭제 실패: ${err.message}`);
  }
};

function initNotificationEvents() {
  const btnNoti = document.getElementById('btnNotifications');
  const popoverNoti = document.getElementById('notificationPopover');
  const btnCloseNoti = document.getElementById('btnNotificationClose');

  // 알림 카드 액션 버튼 이벤트 위임 (inline onclick 대체)
  const notiListContainer = document.getElementById('notificationListContainer');
  if (notiListContainer) {
    notiListContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.noti-action');
      if (!btn) return;
      e.stopPropagation();

      const action = btn.dataset.action;
      const notiId = parseInt(btn.dataset.notiId);
      if (action === 'adjust') {
        window.openNotificationAdjustModal(null, notiId, btn.dataset.medId);
      } else if (action === 'read') {
        window.readNotification(null, notiId);
      } else if (action === 'delete') {
        window.deleteNotification(null, notiId);
      }
    });
  }

  if (btnNoti && popoverNoti) {
    btnNoti.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = popoverNoti.style.display === 'block';
      if (isVisible) {
        popoverNoti.style.display = 'none';
      } else {
        renderNotifications();
        popoverNoti.style.display = 'block';
      }
    });
  }

  if (btnCloseNoti && popoverNoti) {
    btnCloseNoti.addEventListener('click', (e) => {
      e.stopPropagation();
      popoverNoti.style.display = 'none';
    });
  }

  // 팝오버 외부 클릭 감지하여 닫기
  document.addEventListener('click', (e) => {
    if (popoverNoti && popoverNoti.style.display === 'block') {
      if (!popoverNoti.contains(e.target) && !btnNoti.contains(e.target)) {
        popoverNoti.style.display = 'none';
      }
    }
  });

  const btnAdjCancel = document.getElementById('btnAdjNotificationCancel');
  const btnAdjSave = document.getElementById('btnAdjNotificationSave');
  const modalAdj = document.getElementById('adjustNotificationRemainModal');

  if (btnAdjCancel && modalAdj) {
    btnAdjCancel.addEventListener('click', () => {
      modalAdj.classList.remove('show');
    });
  }

  if (btnAdjSave && modalAdj) {
    btnAdjSave.addEventListener('click', () => {
      const notiId = parseInt(document.getElementById('adjNotificationId').value);
      const medId = document.getElementById('adjNotificationMedId').value;
      const packs = parseInt(document.getElementById('adjNotificationPacks').value) || 0;
      const remain = parseFloat(document.getElementById('adjNotificationRemain').value) || 0;

      if (packs < 0 || remain < 0) {
        alert('팩 개수 및 잔량은 0보다 작을 수 없습니다.');
        return;
      }

      try {
        dbManager.adjustStock(medId, packs, remain);
        dbManager.markNotificationAsRead(notiId);
        
        showToast('⚖️ 약재 잔량이 성공적으로 보정되었습니다.');
        modalAdj.classList.remove('show');
        
        renderNotifications();
        renderMedicineList();
        renderPastPrescriptions();
        renderPredictView();
      } catch (err) {
        alert(`잔량 보정 실패: ${err.message}`);
      }
    });
  }
}
