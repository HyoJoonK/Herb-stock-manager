/**
 * @file MedicineModal.js
 * @description 약재 수동 추가/우클릭 수정 공유 모달 컴포넌트.
 *
 * 하나의 모달 DOM(editMedicineModal)을 추가/수정 두 모드로 재사용합니다.
 *  - 추가 모드: editMedId가 빈 값
 *  - 수정 모드: editMedId에 대상 UUID, 약재명은 읽기전용
 * '단순 유무 관리' 라디오 전환 시 계량 관련 입력 필드를 숨기고 기본값을 정규화합니다.
 */

const { escapeHtml } = require('../core/utils');

class MedicineModal {
  /**
   * @param {object} app App 코디네이터 (manager/dialogs/뷰 참조용)
   */
  constructor(app) {
    this.app = app;
  }

  get manager() { return this.app.manager; }
  get state() { return this.app.state; }
  get dialogs() { return this.app.dialogs; }

  /** 모달 관련 이벤트(라디오 전환, 저장/취소, 수동추가 버튼)를 바인딩합니다. */
  bindEvents() {
    // 약재 관리 방식 라디오 버튼 변경 이벤트 바인딩
    const radioWeight = document.getElementById('editMedTypeWeight');
    const radioPresence = document.getElementById('editMedTypePresence');
    if (radioWeight && radioPresence) {
      radioWeight.addEventListener('change', () => this.toggleMedTypeFields(false));
      radioPresence.addEventListener('change', () => this.toggleMedTypeFields(true));
    }

    // 약재 추가/수정 모달 취소/저장
    document.getElementById('btnEditMedCancel').addEventListener('click', () => {
      document.getElementById('editMedicineModal').classList.remove('show');
      this.state.contextTargetMedId = null;
      if (this.app.searchEngine) {
        this.app.searchEngine.setFocusState('search');
      }
    });
    document.getElementById('btnEditMedSave').addEventListener('click', () => this.handleSave());

    // DB 추가하기 버튼 연동 (각 탭마다 있는 수동추가 단추 통합 제어)
    document.querySelectorAll('.btn-med-add').forEach(btn => {
      btn.addEventListener('click', () => this.openAdd());
    });
  }

  /** 새 약재 수동 추가 모드로 모달을 엽니다. */
  openAdd() {
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
    this.toggleMedTypeFields(false);

    // 카테고리 셀렉트박스 바인딩
    const select = document.getElementById('editMedCategorySelect');
    select.innerHTML = '';
    this.manager.getAllCategories().forEach(c => {
      select.innerHTML += `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`;
    });

    modal.classList.add('show');

    // 브라우저 렌더링 사이클 지연 포커싱으로 포커스 유실 방지
    setTimeout(() => {
      document.getElementById('editMedName').focus();
    }, 50);
  }

  /**
   * 기존 약재 수정 모드로 모달을 엽니다.
   * @param {string} medId 수정 대상 약재 UUID
   */
  openEdit(medId) {
    const modal = document.getElementById('editMedicineModal');
    document.getElementById('editModalHeader').innerHTML = '<span class="sf-icon sf-icon-pencil"></span> 약재 정보 수정';

    const med = this.manager.getAllMedicines().find(m => m.id === medId);
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
      this.toggleMedTypeFields(true);
    } else {
      document.getElementById('editMedTypeWeight').checked = true;
      this.toggleMedTypeFields(false);
    }

    const select = document.getElementById('editMedCategorySelect');
    select.innerHTML = '';
    this.manager.getAllCategories().forEach(c => {
      select.innerHTML += `<option value="${escapeHtml(c.id)}" ${med.category_id == c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`;
    });

    modal.classList.add('show');

    // 브라우저 렌더링 사이클 지연 포커싱으로 포커스 유실 방지
    setTimeout(() => {
      document.getElementById('editMedUnopened').focus();
    }, 50);
  }

  /** 모달 입력값을 검증 후 저장(추가/수정)합니다. */
  handleSave() {
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
      this.dialogs.showAlert('약재명을 입력해 주세요.');
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
        this.dialogs.showAlert('팩 규격을 올바르게 입력해 주세요.');
        return;
      }
      if (remain > packSize) {
        this.dialogs.showAlert(`개봉 잔량(${remain}g)은 팩 규격(${packSize}g)을 초과할 수 없습니다.`);
        return;
      }
    }

    try {
      if (idStr) {
        // 수정 모드
        const medId = idStr;
        const loss = this.manager.updateMedicine(medId, {
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
          this.dialogs.showToast(`✏️ "${name}" 약재 데이터 수정 완료 (단순 유무 관리)`);
        } else {
          this.dialogs.showToast(`✏️ "${name}" 약재 데이터 수정 완료 (오차 보정: ${loss > 0 ? '+' : ''}${loss}g)`);
        }

        // 조회 탭에서 해당 약재를 보고 있었다면 상세 정보도 갱신
        if (this.state.currentInquiryMedId === medId) {
          this.app.inquiry.showDetails(medId);
        }
      } else {
        // 추가 모드
        this.manager.addMedicine({
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
        this.dialogs.showToast(`✨ 새 약재 "${name}"이(가) 등록되었습니다.`);
      }

      document.getElementById('editMedicineModal').classList.remove('show');
      this.app.medicineList.render();
      this.app.predict.render();
      if (this.app.searchEngine) {
        this.app.searchEngine.setFocusState('search');
      }
    } catch (err) {
      this.dialogs.showAlert(`저장 실패: ${err.message}`);
    }
  }

  /**
   * '단순 유무 관리' 토글 시 모달 내 입력 필드 노출/기본값을 제어합니다.
   * @param {boolean} isPresence 단순 유무 관리 여부
   */
  toggleMedTypeFields(isPresence) {
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
}

module.exports = MedicineModal;
