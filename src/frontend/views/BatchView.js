/**
 * @file BatchView.js
 * @description [일괄 작업] 탭 View — 여러 약재를 표에 모아 한 번에 편집/저장.
 *
 * 좌측 목록(MedicineListView)에서 Enter/더블클릭으로 약재를 표에 추가하고,
 * 규격/팩 수/잔량/안전재고/단위/카테고리를 일괄 수정한 뒤 저장합니다.
 * 편집 중 데이터는 state.batchEditItems(Map)에 복사본으로 보관됩니다.
 */

const BaseView = require('./BaseView');
const { escapeHtml } = require('../core/utils');

class BatchView extends BaseView {
  /**
   * 일괄 작업 편집기에 약재 행을 추가합니다. (중복 추가 방지)
   * @param {string} medId 약재 UUID
   */
  addMedicine(medId) {
    const med = this.manager.getAllMedicines().find(m => m.id === medId);
    if (!med) return;

    if (this.state.batchEditItems.has(medId)) {
      this.dialogs.showToast(`이미 추가된 약재입니다: ${med.name}`, true);
      return;
    }

    // 변경 추적용 복사본 보존
    this.state.batchEditItems.set(medId, {
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

    this.render();
  }

  /** 일괄 작업 편집기 테이블을 렌더링합니다. */
  render() {
    const empty = this.$('batchEmpty');
    const wrapper = this.$('batchTableWrapper');
    const tbody = this.$('batchTableBody');
    tbody.innerHTML = '';

    if (this.state.batchEditItems.size === 0) {
      wrapper.style.display = 'none';
      empty.style.display = 'flex';
      return;
    }

    wrapper.style.display = 'block';
    empty.style.display = 'none';

    const categories = this.manager.getAllCategories();

    this.state.batchEditItems.forEach((item, id) => {
      const tr = document.createElement('tr');
      tr.dataset.id = id;

      // 카테고리 드롭다운 옵션 태그 생성
      let catOptions = '';
      categories.forEach(c => {
        catOptions += `<option value="${escapeHtml(c.id)}" ${item.category_id == c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`;
      });

      // 단순 유무 관리 약재는 수치 입력 대신 체크박스 UI 노출
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

  /** 편집 표의 내용을 검증 후 DB에 일괄 반영합니다. */
  save() {
    const tbody = this.$('batchTableBody');
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
          this.dialogs.showAlert(`"${row.cells[0].textContent}"의 팩 규격은 0보다 커야 합니다.`);
          return;
        }
        if (opened_pack_remain > pack_size) {
          this.dialogs.showAlert(`"${row.cells[0].textContent}"의 개봉 잔량은 팩 규격을 초과할 수 없습니다.`);
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
        this.manager.updateMedicine(id, {
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
        this.dialogs.showAlert(`"${row.cells[0].textContent}" 저장 중 에러 발생: ${err.message}`);
        hasError = true;
        break;
      }
    }

    if (!hasError) {
      this.dialogs.showToast(`💾 총 ${successCount}건의 약재 데이터가 일괄 수정 및 동기화되었습니다.`);
      this.state.batchEditItems.clear();
      this.render();
      this.app.medicineList.render();
    }
  }

  /** 편집 표(행 제거, 방향키 이동)와 하단 버튼 이벤트를 바인딩합니다. */
  bindEvents() {
    const batchTbody = this.$('batchTableBody');
    if (batchTbody) {
      // 행 제거 버튼 (이벤트 위임)
      batchTbody.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.batch-remove-btn');
        if (removeBtn) {
          const tr = removeBtn.closest('tr');
          this.state.batchEditItems.delete(tr.dataset.id);
          this.render();
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

    // 하단 액션 버튼 (전체 비우기 / 일괄 저장)
    this.$('btnBatchClear').addEventListener('click', () => {
      this.state.batchEditItems.clear();
      this.render();
    });
    this.$('btnBatchSave').addEventListener('click', () => this.save());
  }
}

module.exports = BatchView;
