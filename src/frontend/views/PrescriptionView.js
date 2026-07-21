/**
 * @file PrescriptionView.js
 * @description [처방] 탭 View — 처방/프리셋 작성, 이력, 불러오기, 편집 모드.
 *
 * 이 탭은 상/하 두 카드로 구성됩니다:
 *  - 상단 작성 카드: 처방 바구니(2열 그리드), 환자 처방/프리셋 작성 모드 스위처,
 *    처방·프리셋 편집 모드, 저장/차감 액션
 *  - 하단 이력 카드: 처방 완료 이력 ↔ 프리셋 목록 탭, 검색, 상세/불러오기
 *
 * 상태 소유:
 *  - 공유 상태(state): 처방 바구니, 작성 모드, 이력 탭, 편집 모드/대상 ID
 *  - 뷰 로컬 상태(this.panelExpand): 상/하 카드 세로 확장 ('default'|'top'|'bottom')
 */

const BaseView = require('./BaseView');
const ContextMenu = require('../components/ContextMenu');
const { escapeHtml, formatUTCToKSTString } = require('../core/utils');

// 불러오기 모달의 환자 처방 렌더링 상한 (전체 이력 로드로 인한 성능 저하 방지)
const LOAD_MODAL_RECENT_PRESC = 5;  // 검색어 없을 때 노출할 최근 처방 건수
const LOAD_MODAL_MAX_PRESC = 30;    // 검색 시 렌더링할 최대 처방 건수

class PrescriptionView extends BaseView {
  constructor(app) {
    super(app);

    /**
     * [뷰 로컬] 상/하 카드 세로 확장 상태
     * 'top'    : 작성 카드가 이력 카드 헤더 위까지 확장 (이력 카드는 헤더만 노출)
     * 'bottom' : 이력 카드가 작성 카드 헤더 아래까지 확장 (작성 카드는 헤더만 노출)
     */
    this.panelExpand = 'default';
  }

  // ==========================================================================
  // 처방 바구니 (작성 카드)
  // ==========================================================================

  /** 처방 바구니 2열 그리드를 렌더링합니다. */
  renderBasket() {
    const grid = this.$('prescriptionBody');
    const empty = this.$('prescriptionEmpty');
    const wrapper = this.$('prescriptionTableWrapper');
    grid.innerHTML = '';

    const items = this.state.currentPrescriptionItems;

    // 헤더 우측 도움말에 현재 담긴 약재 수 표기 (가독성 보조)
    const helper = this.$('prescriptionHelperText');
    if (helper) {
      helper.textContent = items.length > 0
        ? `추가된 약재 ${items.length}종 · 목록에서 Enter 시 소모량 입력 팝업 노출`
        : '목록에서 Enter 시 소모량 입력 팝업 노출';
    }

    if (items.length === 0) {
      empty.style.display = 'flex';
      if (wrapper) wrapper.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    if (wrapper) wrapper.style.display = 'block';

    // 2열 그리드: 항목은 위에서부터 좌→우 순서(a1 b1 a2 b2 …)로 채워짐
    items.forEach((item, index) => {
      const cell = document.createElement('div');
      cell.className = 'presc-grid-cell';
      cell.dataset.index = index; // 인덱스를 dataset으로 설정
      cell.innerHTML = `
        <span class="presc-cell-name">${escapeHtml(item.name)}</span>
        <span class="presc-cell-amount">
          <input type="text" value="${escapeHtml(item.amount)}"
                 class="presc-item-amount-input numeric-input" data-numeric-type="decimal"> g
        </span>
        <span class="presc-remove-btn" title="제거"><span class="sf-icon sf-icon-xmark"></span></span>
      `;
      grid.appendChild(cell);
    });
  }

  /**
   * 좌측 목록에서 선택한 약재를 바구니에 추가합니다. (QuickSearchEngine 콜백)
   * 이미 담긴 약재면 수량을 누적합니다.
   * @param {string} medId 약재 UUID
   * @param {number} amount 소모량(g)
   */
  addToBasket(medId, amount) {
    const med = this.manager.getAllMedicines().find(m => m.id === medId);
    if (!med) return;

    const exists = this.state.currentPrescriptionItems.find(item => item.id === medId);
    if (exists) {
      exists.amount += amount;
    } else {
      this.state.currentPrescriptionItems.push({
        id: medId,
        name: med.name,
        pack_size: med.pack_size,
        amount: amount
      });
    }
    // 작성 카드가 헤더만 남은 상태에서 약재를 추가하면 바구니가 보이도록 복원
    if (this.panelExpand === 'bottom') this.resetPanelExpand();
    this.renderBasket();
    this.dialogs.showToast(`✅ "${med.name}" ${amount}g 이 처방전에 추가되었습니다.`);
  }

  // ==========================================================================
  // 상/하 카드 세로 확장 제어
  // ==========================================================================

  /**
   * 확장 상태를 적용하고 토글 버튼 아이콘/툴팁을 갱신합니다.
   * @param {'default'|'top'|'bottom'} stateValue
   */
  setPanelExpand(stateValue) {
    this.panelExpand = stateValue;
    const panel = document.querySelector('#view-prescription .right-main-panel');
    if (!panel) return;
    panel.classList.toggle('expand-top', stateValue === 'top');
    panel.classList.toggle('expand-bottom', stateValue === 'bottom');

    // 토글 버튼 아이콘/툴팁을 현재 상태에 맞게 갱신
    const btnTop = this.$('btnExpandTop');
    const btnBottom = this.$('btnExpandBottom');
    if (btnTop) {
      btnTop.innerHTML = stateValue === 'top'
        ? '<span class="sf-icon sf-icon-chevron-up"></span>'
        : '<span class="sf-icon sf-icon-chevron-down"></span>';
      btnTop.title = stateValue === 'top'
        ? '기본 크기로 복원 (헤더 더블클릭)'
        : '작성 영역 세로 확장 (헤더 더블클릭)';
    }
    if (btnBottom) {
      btnBottom.innerHTML = stateValue === 'bottom'
        ? '<span class="sf-icon sf-icon-chevron-down"></span>'
        : '<span class="sf-icon sf-icon-chevron-up"></span>';
      btnBottom.title = stateValue === 'bottom'
        ? '기본 크기로 복원 (헤더 더블클릭)'
        : '목록 영역 세로 확장 (헤더 더블클릭)';
    }
  }

  /** 같은 방향이면 기본으로, 다르면 해당 방향으로 확장 상태를 토글합니다. */
  togglePanelExpand(which) {
    this.setPanelExpand(this.panelExpand === which ? 'default' : which);
  }

  /** 확장 상태를 기본 분할로 복원합니다. */
  resetPanelExpand() {
    if (this.panelExpand !== 'default') this.setPanelExpand('default');
  }

  // ==========================================================================
  // 처방 완료 이력 (하단 카드 - history 탭)
  // ==========================================================================

  /** 과거 전체 처방 기록 완료 이력을 렌더링합니다. */
  renderPastPrescriptions() {
    const wrapper = this.$('pastPrescriptionsWrapper');
    const empty = this.$('pastPrescriptionsEmpty');
    const tbody = this.$('pastPrescriptionsBody');
    tbody.innerHTML = '';

    const searchInput = this.$('pastPrescriptionsSearch');
    const searchQuery = searchInput ? searchInput.value.trim() : '';

    const list = searchQuery !== ''
      ? this.manager.searchPrescriptions(searchQuery)
      : this.manager.getAllPrescriptions();

    if (list.length === 0) {
      wrapper.style.display = 'none';
      empty.style.display = this.state.currentHistoryTab === 'history' ? 'flex' : 'none';
      return;
    }

    empty.style.display = 'none';
    wrapper.style.display = this.state.currentHistoryTab === 'history' ? 'block' : 'none';

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
        this.app.prescriptionDetailModal.open(p.id);
      });

      // 마우스 우클릭 (Context Menu) 처방 편집/삭제 트리거
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.state.contextTargetPrescId = p.id;

        const deductItem = this.$('ctxPrescDeduct');
        if (deductItem) {
          if (p.is_deducted === 1) {
            deductItem.style.display = 'none';
          } else {
            deductItem.style.display = 'block';
          }
        }

        ContextMenu.show('prescContextMenu', e.pageX, e.pageY);
      });

      tbody.appendChild(tr);
    });
  }

  // ==========================================================================
  // 이력/프리셋 탭 전환 (하단 카드)
  // ==========================================================================

  /**
   * 하단 이력 카드의 활성 탭을 전환합니다.
   * @param {'history'|'presets'} tab
   */
  setHistoryTab(tab) {
    this.state.currentHistoryTab = tab;

    const btnHistory = this.$('btnTabHistory');
    const btnPresets = this.$('btnTabPresets');

    const wrapperHistory = this.$('pastPrescriptionsWrapper');
    const emptyHistory = this.$('pastPrescriptionsEmpty');
    const wrapperPresets = this.$('presetsHistoryWrapper');
    const emptyPresets = this.$('presetsHistoryEmpty');

    const searchInput = this.$('pastPrescriptionsSearch');

    if (tab === 'history') {
      btnHistory.classList.add('active');
      btnPresets.classList.remove('active');

      wrapperHistory.style.display = 'block';
      emptyHistory.style.display = 'none'; // renderPastPrescriptions가 적절히 토글
      wrapperPresets.style.display = 'none';
      emptyPresets.style.display = 'none';

      searchInput.placeholder = '처방명, 환자명, 약재명, 메모 검색...';
      this.renderPastPrescriptions();
    } else {
      btnHistory.classList.remove('active');
      btnPresets.classList.add('active');

      wrapperHistory.style.display = 'none';
      emptyHistory.style.display = 'none';
      wrapperPresets.style.display = 'block';
      emptyPresets.style.display = 'none'; // renderPresetsHistoryList가 적절히 토글

      searchInput.placeholder = '프리셋명, 메모 검색...';
      this.renderPresetsHistoryList();
    }
  }

  /** 등록된 프리셋 목록(하단 카드 - presets 탭)을 렌더링합니다. */
  renderPresetsHistoryList() {
    const tbody = this.$('presetsHistoryBody');
    const empty = this.$('presetsHistoryEmpty');
    const wrapper = this.$('presetsHistoryWrapper');
    const searchQuery = this.$('pastPrescriptionsSearch').value.trim().toLowerCase();

    tbody.innerHTML = '';

    let presets = this.manager.getAllPresets();
    if (searchQuery) {
      presets = presets.filter(p =>
        p.preset_name.toLowerCase().includes(searchQuery) ||
        (p.note && p.note.toLowerCase().includes(searchQuery))
      );
    }

    if (presets.length === 0) {
      wrapper.style.display = 'none';
      empty.style.display = this.state.currentHistoryTab === 'presets' ? 'flex' : 'none';
      return;
    }

    empty.style.display = 'none';
    wrapper.style.display = this.state.currentHistoryTab === 'presets' ? 'block' : 'none';

    presets.forEach(p => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td style="font-weight:700; color:var(--color-primary);">${escapeHtml(p.preset_name)}</td>
        <td style="font-style: italic; color:var(--color-text-muted); font-size:11px;">${escapeHtml(p.note || '-')}</td>
        <td style="text-align:center;">${escapeHtml(p.total_items)}종</td>
        <td style="color:var(--color-text-muted); font-size:11px;">${formatUTCToKSTString(p.created_at)}</td>
        <td style="text-align:center;">
          <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
            <button class="btn btn-secondary btn-apply-preset-hist" data-id="${escapeHtml(p.id)}" style="padding: 2px 8px; font-size: 11px;">적용</button>
            <button class="btn btn-primary btn-delete-preset-hist" data-id="${escapeHtml(p.id)}" style="padding: 2px 8px; font-size: 11px; background: #e74c3c; border-color: #e74c3c;">삭제</button>
          </div>
        </td>
      `;

      // 행 클릭 시 프리셋 상세 정보 모달 오픈
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.openPresetDetailModal(p.id);
      });

      // 마우스 우클릭 (Context Menu) 프리셋 편집/삭제 트리거
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.state.contextTargetPresetId = p.id;
        ContextMenu.show('presetContextMenu', e.pageX, e.pageY);
      });

      tbody.appendChild(tr);
    });

    // 적용 버튼 바인딩
    tbody.querySelectorAll('.btn-apply-preset-hist').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        this.loadPresetToBasket(id);
      });
    });

    // 삭제 버튼 바인딩
    tbody.querySelectorAll('.btn-delete-preset-hist').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const preset = presets.find(pr => String(pr.id) === String(id));
        if (await this.dialogs.showConfirm(`"${preset.preset_name}" 프리셋을 삭제하시겠습니까?`)) {
          try {
            this.manager.deletePreset(id);
            this.dialogs.showToast('프리셋이 삭제되었습니다.');
            this.renderPresetsHistoryList();
            // 불러오기 모달도 열려있으면 리스트 리프레시
            if (this.$('presetLoadModal').classList.contains('show')) {
              this.renderPresetListModal();
            }
          } catch (err) {
            this.dialogs.showAlert(`프리셋 삭제 실패: ${err.message}`);
          }
        }
      });
    });
  }

  /**
   * 프리셋 상세 정보 모달을 엽니다.
   * @param {string} presetId 프리셋 UUID
   */
  openPresetDetailModal(presetId) {
    try {
      const detail = this.manager.getPresetDetails(presetId);

      this.$('viewPresetDetailName').textContent = detail.preset_name;
      this.$('viewPresetDetailDate').textContent = formatUTCToKSTString(detail.created_at);
      this.$('viewPresetDetailNote').textContent = detail.note || '메모 없음';

      const tbody = this.$('viewPresetDetailItemsBody');
      tbody.innerHTML = '';

      detail.items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${escapeHtml(item.medicine_name)}</td>
          <td style="text-align: right; font-weight: bold;">${escapeHtml(item.amount)}${escapeHtml(item.unit)}</td>
        `;
        tbody.appendChild(tr);
      });

      const applyBtn = this.$('btnPresetDetailApply');
      applyBtn.onclick = () => {
        this.loadPresetToBasket(presetId);
        this.$('presetDetailModal').classList.remove('show');
      };

      this.$('presetDetailModal').classList.add('show');
    } catch (err) {
      this.dialogs.showAlert(`프리셋 데이터를 불러오지 못했습니다: ${err.message}`);
    }
  }

  // ==========================================================================
  // 불러오기 모달 (프리셋 + 과거 환자 처방)
  // ==========================================================================

  /** 불러오기 모달의 프리셋/환자 처방 통합 목록을 렌더링합니다. */
  renderPresetListModal() {
    const tbody = this.$('presetListBody');
    const empty = this.$('presetListEmpty');
    const rawQuery = this.$('presetSearchInput').value.trim();
    const searchQuery = rawQuery.toLowerCase();

    tbody.innerHTML = '';

    // 1. 프리셋: 항상 상단 우선 노출
    let presets = this.manager.getAllPresets();
    if (searchQuery) {
      presets = presets.filter(p =>
        p.preset_name.toLowerCase().includes(searchQuery) ||
        (p.note && p.note.toLowerCase().includes(searchQuery))
      );
    }

    // 2. 환자 처방: 검색어 없으면 최근 N건만, 검색 시 최대 M건까지 (SQL LIMIT)
    let prescriptions = [];
    let prescHasMore = false;
    if (searchQuery) {
      const found = this.manager.searchPrescriptions(rawQuery, LOAD_MODAL_MAX_PRESC + 1);
      prescHasMore = found.length > LOAD_MODAL_MAX_PRESC;
      prescriptions = found.slice(0, LOAD_MODAL_MAX_PRESC);
    } else {
      prescriptions = this.manager.getRecentPrescriptions(LOAD_MODAL_RECENT_PRESC);
    }

    if (presets.length === 0 && prescriptions.length === 0) {
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';

    const addSectionRow = (html) => {
      const tr = document.createElement('tr');
      tr.className = 'load-section-row';
      tr.innerHTML = `<td colspan="3">${html}</td>`;
      tbody.appendChild(tr);
    };

    if (presets.length > 0) {
      addSectionRow('<span class="sf-icon sf-icon-star"></span> 프리셋');
      presets.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 700; color: var(--color-primary);">${escapeHtml(p.preset_name)}</td>
          <td style="font-style: italic; color: var(--color-text-muted); font-size: 11px;">${escapeHtml(p.note || '-')}</td>
          <td style="text-align: center;">
            <button class="btn-load-preset" data-id="${escapeHtml(p.id)}">적용</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    if (prescriptions.length > 0) {
      addSectionRow(searchQuery
        ? '<span class="sf-icon sf-icon-scroll"></span> 환자 처방'
        : `<span class="sf-icon sf-icon-scroll"></span> 환자 처방 — 최근 ${prescriptions.length}건 (환자명·처방명·메모로 검색해 더 찾기)`);
      prescriptions.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 700; color: var(--color-primary);">${escapeHtml(p.prescription_name || '(이름 없음)')}</td>
          <td style="color: var(--color-text-muted); font-size: 11px;">${escapeHtml(p.patient_name)} · ${formatUTCToKSTString(p.created_at).slice(0, 10)}</td>
          <td style="text-align: center;">
            <button class="btn-load-preset btn-load-presc" data-id="${escapeHtml(p.id)}">적용</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
      if (prescHasMore) {
        addSectionRow(`결과가 ${LOAD_MODAL_MAX_PRESC}건을 초과합니다 — 검색어를 더 구체적으로 입력해 주세요.`);
      }
    }

    // 적용 이벤트 연결 (프리셋 / 환자 처방 분기)
    // 프리셋 삭제는 '등록된 프리셋 목록' 탭에서 수행
    tbody.querySelectorAll('.btn-load-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (btn.classList.contains('btn-load-presc')) {
          this.loadPrescriptionToBasket(id);
        } else {
          this.loadPresetToBasket(id);
        }
      });
    });
  }

  /**
   * 과거 환자 처방을 작성 바구니로 불러옵니다. (환자명/처방명/메모까지 복원)
   * @param {string} prescId 처방 UUID
   */
  async loadPrescriptionToBasket(prescId) {
    if (this.state.currentPrescriptionItems.length > 0) {
      if (!(await this.dialogs.showConfirm('현재 작성 중인 처방전 약재 목록을 지우고 선택한 처방을 불러오시겠습니까?'))) {
        return;
      }
    }

    try {
      const detail = this.manager.getPrescriptionDetails(prescId);

      this.state.currentPrescriptionItems = detail.items.map(item => {
        const med = this.manager.getAllMedicines().find(m => m.id === item.medicine_id);
        return {
          id: item.medicine_id,
          name: item.medicine_name,
          pack_size: med ? med.pack_size : 500,
          amount: item.amount
        };
      });

      this.$('patientName').value = detail.patient_name || '';
      this.$('prescriptionName').value = detail.prescription_name || '';
      this.$('prescriptionNote').value = detail.note || '';

      this.resetPanelExpand(); // 처방 적용 시 작성 카드가 보이도록 기본 분할로 복원
      this.renderBasket();
      this.$('presetLoadModal').classList.remove('show');
      this.dialogs.showToast(`📋 "${detail.prescription_name || detail.patient_name}" 처방을 불러왔습니다.`);
    } catch (err) {
      this.dialogs.showAlert(`처방 로드 실패: ${err.message}`);
    }
  }

  /**
   * 프리셋을 작성 바구니로 불러옵니다.
   * @param {string} presetId 프리셋 UUID
   */
  async loadPresetToBasket(presetId) {
    if (this.state.currentPrescriptionItems.length > 0) {
      if (!(await this.dialogs.showConfirm('현재 작성 중인 처방전 약재 목록을 지우고 프리셋을 불러오시겠습니까?'))) {
        return;
      }
    }

    try {
      const detail = this.manager.getPresetDetails(presetId);

      this.state.currentPrescriptionItems = detail.items.map(item => {
        const med = this.manager.getAllMedicines().find(m => m.id === item.medicine_id);
        return {
          id: item.medicine_id,
          name: item.medicine_name,
          pack_size: med ? med.pack_size : 500,
          amount: item.amount
        };
      });

      if (detail.note) {
        this.$('prescriptionNote').value = detail.note;
      }

      this.resetPanelExpand(); // 프리셋 적용 시 작성 카드가 보이도록 기본 분할로 복원
      this.renderBasket();
      this.$('presetLoadModal').classList.remove('show');
      this.dialogs.showToast(`⭐ "${detail.preset_name}" 프리셋을 적용했습니다.`);
    } catch (err) {
      this.dialogs.showAlert(`프리셋 로드 실패: ${err.message}`);
    }
  }

  // ==========================================================================
  // 작성 모드 스위처 (환자 처방 ↔ 프리셋) 및 편집 모드
  // ==========================================================================

  /**
   * 작성 카드의 모드를 전환하고 입력 필드/바구니를 리셋합니다.
   * @param {'prescription'|'preset'} mode
   */
  setPrescMode(mode) {
    this.state.currentPrescMode = mode;

    const btnPresc = this.$('btnModePrescription');
    const btnPreset = this.$('btnModePreset');
    const groupPatient = this.$('groupPatientName');
    const groupPresetLoad = this.$('groupOpenPresetLoad');
    const labelPrescName = this.$('labelPrescriptionName');
    const inputPrescName = this.$('prescriptionName');

    const labelNote = this.$('labelPrescriptionNote');
    const noteInput = this.$('prescriptionNote');

    const prescActions = this.$('prescriptionActionRow');
    const presetActions = this.$('presetActionRow');

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
    this.$('prescriptionName').value = '';
    this.$('patientName').value = '';
    this.$('prescriptionNote').value = '';
    this.state.currentPrescriptionItems = [];
    this.renderBasket();
  }

  /**
   * 기존 처방을 편집 모드로 불러옵니다. (재고 복원/재차감은 저장 시 수행)
   * @param {string} prescId 편집할 처방 UUID
   */
  enterPrescriptionEditMode(prescId) {
    if (this.state.isPresetEditMode) {
      this.exitPresetEditMode();
    }
    try {
      const detail = this.manager.getPrescriptionDetails(prescId);
      this.state.isPrescriptionEditMode = true;
      this.state.currentEditingPrescId = prescId;

      // 1. UI 탭 전환 (확장 상태였다면 기본 분할로 복원)
      this.resetPanelExpand();
      this.app.switchTab('prescription');

      // 2. 제목 변경 및 강조 스타일링 추가 (모드 스위처 숨기고 편집 타이틀 표시)
      document.querySelector('.presc-mode-switcher').style.display = 'none';
      const titleEl = this.$('prescriptionCardTitle');
      titleEl.style.display = 'block';
      titleEl.innerHTML = `<span class="sf-icon sf-icon-memo"></span> 조제 수정 (${escapeHtml(detail.prescription_name || detail.patient_name)})`;
      this.$('prescriptionCard').classList.add('edit-mode-highlight');

      // 편집 시에는 항상 환자 처방 모드 필드로 강제 표시 (불러오기 버튼은 감춤)
      this.$('groupPatientName').style.display = 'flex';
      this.$('groupPrescriptionName').style.display = 'flex';
      this.$('groupOpenPresetLoad').style.display = 'none';
      this.$('labelPrescriptionName').textContent = '처방명';
      this.$('prescriptionName').placeholder = '예: 감기약 (선택)';
      this.$('labelPrescriptionNote').textContent = '처방 메모';
      this.$('prescriptionNote').placeholder = '예: 하루 3회 복용, 식후 30분 따뜻하게 복용';
      this.$('prescriptionActionRow').style.display = 'flex';
      this.$('presetActionRow').style.display = 'none';

      // 3. 수정 취소 버튼 표시 및 버튼 텍스트/스타일 변경
      this.$('btnCancelEditPrescription').style.display = 'flex';

      const saveBtn = this.$('btnSaveOnlyPrescription');
      saveBtn.className = 'btn btn-secondary';
      saveBtn.style.flex = '1';
      saveBtn.innerHTML = '<span class="sf-icon sf-icon-save"></span> 수정 저장';

      const isAlreadyDeducted = detail.is_deducted === 1;
      const deductBtn = this.$('btnDeductStock');
      deductBtn.className = 'btn btn-primary';
      deductBtn.style.flex = '2';
      deductBtn.style.display = 'flex';
      deductBtn.innerHTML = isAlreadyDeducted ? '<span class="sf-icon sf-icon-box"></span> 재고 갱신' : '<span class="sf-icon sf-icon-box"></span> 재고 차감';

      // 4. 입력 필드 값 적재
      this.$('prescriptionName').value = detail.prescription_name || '';
      this.$('patientName').value = detail.patient_name;
      this.$('prescriptionNote').value = detail.note || '';

      // 5. 처방 바구니 복원
      this.state.currentPrescriptionItems = detail.items.map(item => {
        const med = this.manager.getAllMedicines().find(m => m.id === item.medicine_id);
        return {
          id: item.medicine_id,
          name: item.medicine_name,
          pack_size: med ? med.pack_size : 500,
          amount: item.amount
        };
      });

      this.renderBasket();
    } catch (err) {
      this.dialogs.showAlert(`처방 데이터를 불러오지 못했습니다: ${err.message}`);
    }
  }

  /** 처방 편집 모드를 종료하고 UI를 원복합니다. */
  exitPrescriptionEditMode() {
    this.state.isPrescriptionEditMode = false;
    this.state.currentEditingPrescId = null;

    // 1. 제목 및 스타일링 원복 (모드 스위처 보이고 타이틀 숨김)
    document.querySelector('.presc-mode-switcher').style.display = 'flex';
    this.$('prescriptionCardTitle').style.display = 'none';
    this.$('prescriptionCard').classList.remove('edit-mode-highlight');

    // 2. 취소 버튼 숨기기 및 완료 버튼 텍스트/스타일 원복
    this.$('btnCancelEditPrescription').style.display = 'none';

    const saveBtn = this.$('btnSaveOnlyPrescription');
    saveBtn.className = 'btn btn-primary';
    saveBtn.style.flex = '2';
    saveBtn.innerHTML = '<span class="sf-icon sf-icon-save"></span> 처방 저장';

    const deductBtn = this.$('btnDeductStock');
    deductBtn.className = 'btn btn-secondary';
    deductBtn.style.flex = '1';
    deductBtn.style.display = 'none';
    deductBtn.innerHTML = '<span class="sf-icon sf-icon-box"></span> 재고 차감';

    // 스위처 상태 리셋 (처방 모드로 전환 및 필드 리셋)
    this.setPrescMode('prescription');
  }

  /**
   * 기존 프리셋을 편집 모드로 불러옵니다.
   * @param {string} presetId 편집할 프리셋 UUID
   */
  enterPresetEditMode(presetId) {
    if (this.state.isPrescriptionEditMode) {
      this.exitPrescriptionEditMode();
    }
    try {
      const detail = this.manager.getPresetDetails(presetId);
      this.state.isPresetEditMode = true;
      this.state.currentEditingPresetId = presetId;

      // 1. UI 탭 전환 (확장 상태였다면 기본 분할로 복원)
      this.resetPanelExpand();
      this.app.switchTab('prescription');

      // 2. 프리셋 모드로 설정
      this.setPrescMode('preset');

      // 3. 제목 변경 및 강조 스타일링 추가 (모드 스위처 숨기고 편집 타이틀 표시)
      document.querySelector('.presc-mode-switcher').style.display = 'none';
      const titleEl = this.$('prescriptionCardTitle');
      titleEl.style.display = 'block';
      titleEl.innerHTML = `<span class="sf-icon sf-icon-pencil"></span> 프리셋 수정 (${escapeHtml(detail.preset_name)})`;
      this.$('prescriptionCard').classList.add('edit-mode-highlight');

      // 4. 취소 버튼 노출 및 저장 버튼 스타일 조정
      this.$('btnCancelEditPreset').style.display = 'flex';
      const saveBtn = this.$('btnSavePreset');
      saveBtn.style.width = 'auto';
      saveBtn.style.flex = '2';
      saveBtn.innerHTML = '<span class="sf-icon sf-icon-save"></span> 수정 저장';

      // 5. 프리셋 데이터 채워넣기
      this.$('prescriptionName').value = detail.preset_name;
      this.$('prescriptionNote').value = detail.note || '';

      this.state.currentPrescriptionItems = detail.items.map(item => {
        const med = this.manager.getAllMedicines().find(m => m.id === item.medicine_id);
        return {
          id: item.medicine_id,
          name: item.medicine_name,
          pack_size: med ? med.pack_size : 500,
          amount: item.amount
        };
      });

      this.renderBasket();
    } catch (err) {
      this.dialogs.showAlert(`프리셋 데이터를 불러오지 못했습니다: ${err.message}`);
    }
  }

  /** 프리셋 편집 모드를 종료하고 UI를 원복합니다. */
  exitPresetEditMode() {
    this.state.isPresetEditMode = false;
    this.state.currentEditingPresetId = null;

    // 1. 제목 및 스타일링 원복 (모드 스위처 보이고 타이틀 숨김)
    document.querySelector('.presc-mode-switcher').style.display = 'flex';
    this.$('prescriptionCardTitle').style.display = 'none';
    this.$('prescriptionCard').classList.remove('edit-mode-highlight');

    // 2. 취소 버튼 숨기기 및 완료 버튼 텍스트/스타일 원복
    this.$('btnCancelEditPreset').style.display = 'none';

    const saveBtn = this.$('btnSavePreset');
    saveBtn.style.width = '100%';
    saveBtn.style.flex = 'none';
    saveBtn.innerHTML = '<span class="sf-icon sf-icon-star"></span> 처방 프리셋 저장';

    // 스위처 상태 리셋 (처방 모드로 전환 및 필드 리셋)
    this.setPrescMode('prescription');
  }

  // ==========================================================================
  // 조제 제출 (신규 저장 / 수정 저장, 차감 여부 분기)
  // ==========================================================================

  /**
   * 작성 카드의 입력을 검증하고 처방을 저장(또는 수정)합니다.
   * @param {boolean} isDeduct 저장과 동시에 재고를 차감할지 여부
   */
  processSubmit(isDeduct) {
    const prescName = this.$('prescriptionName').value.trim() || null;
    const patName = this.$('patientName').value.trim();
    const prescNote = this.$('prescriptionNote').value.trim();

    if (!patName) {
      this.dialogs.showAlert('환자명을 입력해 주세요.');
      return;
    }
    if (this.state.currentPrescriptionItems.length === 0) {
      this.dialogs.showAlert('처방전에 추가된 약재가 없습니다.');
      return;
    }

    try {
      const items = this.state.currentPrescriptionItems.map(item => ({
        medicineId: item.id,
        amount: item.amount
      }));

      if (this.state.isPrescriptionEditMode && this.state.currentEditingPrescId !== null) {
        this.manager.updatePrescriptionWithItems(this.state.currentEditingPrescId, prescName, patName, items, prescNote, isDeduct);
        if (isDeduct) {
          this.dialogs.showToast(`🎉 처방전 수정 완료 및 실시간 재고 갱신 처리되었습니다.`);
        } else {
          this.dialogs.showToast(`🎉 처방전 수정 완료 및 정보 저장 처리되었습니다. (재고 미차감)`);
        }
        this.exitPrescriptionEditMode();
      } else {
        this.manager.addPrescription(prescName, patName, items, prescNote, isDeduct);
        const nameDisplay = prescName ? `"${prescName}" ` : '';
        if (isDeduct) {
          this.dialogs.showToast(`🎉 ${nameDisplay}조제 완료 및 실시간 재고 차감 처리되었습니다.`);
        } else {
          this.dialogs.showToast(`🎉 ${nameDisplay}처방이 저장되었습니다. (재고 미차감)`);
        }
      }

      this.state.currentPrescriptionItems = [];
      this.$('prescriptionName').value = '';
      this.$('patientName').value = '';
      this.$('prescriptionNote').value = '';
      this.resetPanelExpand(); // 저장 완료 시 확장 상태를 기본 분할로 복원
      this.renderBasket();
      this.app.medicineList.render();
      this.renderPastPrescriptions();
      this.app.predict.render(); // 발주 예측도 실시간 업데이트
      this.app.notifications.render(); // 알림 배지 및 리스트 동적 갱신
    } catch (err) {
      this.dialogs.showAlert(`조제 처리 실패: ${err.message}`);
      this.dialogs.showToast('재고 부족 등으로 조제 실패', true);
    }
  }

  // ==========================================================================
  // 이벤트 바인딩
  // ==========================================================================

  /** [처방] 탭 전체 이벤트를 바인딩합니다. (App.init에서 1회 호출) */
  bindEvents() {
    // -- 처방 바구니 그리드 (이벤트 위임: 수량 변경 / Enter 제출 / 항목 제거) ----
    const prescTbody = this.$('prescriptionBody');
    if (prescTbody) {
      prescTbody.addEventListener('change', (e) => {
        if (e.target.classList.contains('presc-item-amount-input')) {
          const cell = e.target.closest('.presc-grid-cell');
          const index = parseInt(cell.dataset.index);
          const val = parseFloat(e.target.value);
          if (!isNaN(val) && val > 0) {
            this.state.currentPrescriptionItems[index].amount = val;
          }
        }
      });
      prescTbody.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('presc-item-amount-input')) {
          e.preventDefault();
          const cell = e.target.closest('.presc-grid-cell');
          const index = parseInt(cell.dataset.index);
          const val = parseFloat(e.target.value);
          if (!isNaN(val) && val > 0) {
            this.state.currentPrescriptionItems[index].amount = val;
          }
          // 현재 모드의 기본 저장 액션을 그대로 트리거 (버튼 상태와 100% 일치 보장)
          if (this.state.currentPrescMode === 'preset') {
            const savePresetBtn = this.$('btnSavePreset');
            if (savePresetBtn) savePresetBtn.click();
          } else {
            const completeBtn = this.$('btnDeductStock');
            if (completeBtn) completeBtn.click();
          }
        }
      });
      prescTbody.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.presc-remove-btn');
        if (removeBtn) {
          const cell = removeBtn.closest('.presc-grid-cell');
          const index = parseInt(cell.dataset.index);
          this.state.currentPrescriptionItems.splice(index, 1);
          this.renderBasket();
        }
      });
    }

    // -- 이력/프리셋 실시간 검색 ---------------------------------------------
    const pastPrescSearch = this.$('pastPrescriptionsSearch');
    if (pastPrescSearch) {
      pastPrescSearch.addEventListener('input', () => {
        // 이력 카드가 헤더만 남은 상태에서 검색하면 결과가 보이도록 복원
        if (this.panelExpand === 'top') this.resetPanelExpand();
        if (this.state.currentHistoryTab === 'history') {
          this.renderPastPrescriptions();
        } else {
          this.renderPresetsHistoryList();
        }
      });
    }

    // -- 처방 우클릭 컨텍스트 메뉴 액션 --------------------------------------
    this.$('ctxPrescEdit').addEventListener('click', () => {
      if (this.state.contextTargetPrescId !== null) {
        this.enterPrescriptionEditMode(this.state.contextTargetPrescId);
        this.state.contextTargetPrescId = null;
      }
    });

    this.$('ctxPrescDeduct').addEventListener('click', async () => {
      if (this.state.contextTargetPrescId !== null) {
        const detail = this.manager.getPrescriptionDetails(this.state.contextTargetPrescId);
        if (detail.is_deducted === 1) {
          this.dialogs.showToast('ℹ️ 이미 재고가 차감된 처방전입니다.');
          this.state.contextTargetPrescId = null;
          return;
        }
        if (await this.dialogs.showConfirm(`"${detail.prescription_name}" 처방의 약재 재고 차감을 실행하시겠습니까?\n이 작업은 되돌릴 수 없으며 중복 실행할 수 없습니다.`)) {
          try {
            this.manager.deductPrescriptionStock(this.state.contextTargetPrescId);
            this.dialogs.showToast('🎉 재고 차감이 성공적으로 완료되었습니다.');
            this.app.medicineList.render();
            this.renderPastPrescriptions();
            this.app.predict.render();
            this.app.notifications.render();
          } catch (err) {
            this.dialogs.showAlert(`재고 차감 실패: ${err.message}`);
          }
        }
        this.state.contextTargetPrescId = null;
      }
    });

    this.$('ctxPrescDelete').addEventListener('click', async () => {
      if (this.state.contextTargetPrescId !== null) {
        const detail = this.manager.getPrescriptionDetails(this.state.contextTargetPrescId);
        if (await this.dialogs.showConfirm(`⚠️ 정말로 처방전 (${detail.prescription_name || '(이름 없음)'} - ${detail.patient_name})을 삭제하시겠습니까? 소모된 약재 재고가 모두 자동으로 복원됩니다.`)) {
          try {
            this.manager.deletePrescription(this.state.contextTargetPrescId);
            this.dialogs.showToast(`🗑️ 처방 내역이 삭제되고 재고가 복원되었습니다.`, true);

            // 삭제한 처방을 편집 중이었다면 편집 모드도 종료
            if (this.state.isPrescriptionEditMode && this.state.contextTargetPrescId === this.state.currentEditingPrescId) {
              this.exitPrescriptionEditMode();
            }

            this.renderPastPrescriptions();
            this.app.medicineList.render();
            this.app.predict.render();
          } catch (err) {
            this.dialogs.showAlert(`처방 삭제 실패: ${err.message}`);
          }
        }
        this.state.contextTargetPrescId = null;
      }
    });

    // -- 프리셋 우클릭 컨텍스트 메뉴 액션 ------------------------------------
    this.$('ctxPresetEdit').addEventListener('click', () => {
      if (this.state.contextTargetPresetId !== null) {
        this.enterPresetEditMode(this.state.contextTargetPresetId);
        this.state.contextTargetPresetId = null;
      }
    });

    this.$('ctxPresetDelete').addEventListener('click', async () => {
      if (this.state.contextTargetPresetId !== null) {
        const id = this.state.contextTargetPresetId;
        const preset = this.manager.getAllPresets().find(pr => String(pr.id) === String(id));
        if (await this.dialogs.showConfirm(`⚠️ 정말로 "${preset.preset_name}" 프리셋을 삭제하시겠습니까?`)) {
          try {
            this.manager.deletePreset(id);
            this.dialogs.showToast('🗑️ 프리셋이 삭제되었습니다.', true);

            // 삭제한 프리셋을 편집 중이었다면 편집 모드도 종료
            if (this.state.isPresetEditMode && id === this.state.currentEditingPresetId) {
              this.exitPresetEditMode();
            }

            this.renderPresetsHistoryList();
            if (this.$('presetLoadModal').classList.contains('show')) {
              this.renderPresetListModal();
            }
          } catch (err) {
            this.dialogs.showAlert(`프리셋 삭제 실패: ${err.message}`);
          }
        }
        this.state.contextTargetPresetId = null;
      }
    });

    // -- 편집 모드 취소 버튼 -------------------------------------------------
    this.$('btnCancelEditPreset').addEventListener('click', () => {
      this.exitPresetEditMode();
    });

    this.$('btnCancelEditPrescription').addEventListener('click', () => {
      this.exitPrescriptionEditMode();
    });

    // -- 조제 제출 버튼 (저장만 / 저장+차감) ---------------------------------
    this.$('btnSaveOnlyPrescription').addEventListener('click', () => {
      this.processSubmit(false);
    });

    this.$('btnDeductStock').addEventListener('click', () => {
      this.processSubmit(true);
    });

    // -- 작성 모드 스위처 ----------------------------------------------------
    this.$('btnModePrescription').addEventListener('click', () => {
      // 작성 카드가 헤더만 남은 상태에서 모드를 고르면 작성 영역이 보이도록 복원
      if (this.panelExpand === 'bottom') this.resetPanelExpand();
      this.setPrescMode('prescription');
    });

    this.$('btnModePreset').addEventListener('click', () => {
      if (this.panelExpand === 'bottom') this.resetPanelExpand();
      this.setPrescMode('preset');
    });

    // -- 프리셋 저장 (신규/수정 분기) ----------------------------------------
    this.$('btnSavePreset').addEventListener('click', () => {
      const presetName = this.$('prescriptionName').value.trim();
      const note = this.$('prescriptionNote').value.trim();

      if (!presetName) {
        this.dialogs.showAlert('프리셋 처방명을 입력해 주세요.');
        return;
      }
      if (this.state.currentPrescriptionItems.length === 0) {
        this.dialogs.showAlert('프리셋에 추가할 약재가 없습니다.');
        return;
      }

      try {
        const items = this.state.currentPrescriptionItems.map(item => ({
          medicineId: item.id,
          amount: item.amount
        }));

        if (this.state.isPresetEditMode && this.state.currentEditingPresetId !== null) {
          this.manager.updatePreset(this.state.currentEditingPresetId, presetName, note, items);
          this.dialogs.showToast(`⭐ 프리셋 "${presetName}"이 수정되었습니다.`);
          this.exitPresetEditMode();
        } else {
          this.manager.addPreset(presetName, note, items);
          this.dialogs.showToast(`⭐ 프리셋 "${presetName}"이 저장되었습니다.`);
          this.setPrescMode('prescription');
        }
        this.resetPanelExpand(); // 저장 완료 시 확장 상태를 기본 분할로 복원

        if (this.state.currentHistoryTab === 'presets') {
          this.renderPresetsHistoryList();
        }
      } catch (err) {
        this.dialogs.showAlert(`프리셋 저장 실패: ${err.message}`);
      }
    });

    // -- 불러오기 모달 -------------------------------------------------------
    this.$('btnOpenPresetLoad').addEventListener('click', () => {
      this.$('presetLoadModal').classList.add('show');
      this.$('presetSearchInput').value = '';
      this.renderPresetListModal();
    });

    this.$('btnPresetLoadClose').addEventListener('click', () => {
      this.$('presetLoadModal').classList.remove('show');
    });

    this.$('presetSearchInput').addEventListener('input', () => {
      this.renderPresetListModal();
    });

    // -- 이력/프리셋 탭 전환 -------------------------------------------------
    this.$('btnTabHistory').addEventListener('click', () => {
      // 이력 카드가 헤더만 남은 상태에서 탭을 고르면 목록이 보이도록 복원
      if (this.panelExpand === 'top') this.resetPanelExpand();
      this.setHistoryTab('history');
    });

    this.$('btnTabPresets').addEventListener('click', () => {
      if (this.panelExpand === 'top') this.resetPanelExpand();
      this.setHistoryTab('presets');
    });

    // -- 상/하 카드 세로 확장 토글 (버튼 클릭 + 헤더 더블클릭) ---------------
    this.$('btnExpandTop').addEventListener('click', () => {
      this.togglePanelExpand('top');
    });

    this.$('btnExpandBottom').addEventListener('click', () => {
      this.togglePanelExpand('bottom');
    });

    const bindExpandHeaderDblClick = (headerId, which) => {
      const header = this.$(headerId);
      if (!header) return;
      header.addEventListener('dblclick', (e) => {
        // 헤더 안의 버튼/입력창 더블클릭은 확장 토글로 취급하지 않음
        if (e.target.closest('button, input')) return;
        this.togglePanelExpand(which);
      });
    };
    bindExpandHeaderDblClick('prescriptionCardHeader', 'top');
    bindExpandHeaderDblClick('historyCardHeader', 'bottom');

    // -- 프리셋 상세 모달 닫기 -----------------------------------------------
    this.$('btnPresetDetailClose').addEventListener('click', () => {
      this.$('presetDetailModal').classList.remove('show');
    });
  }
}

module.exports = PrescriptionView;
