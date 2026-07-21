/**
 * @file PrescriptionDetailModal.js
 * @description 처방 완료 이력 상세 조회 모달 컴포넌트.
 *
 * 미차감 처방인 경우 '재고 차감 실행' 버튼을 노출하고,
 * '처방 수정' 버튼으로 PrescriptionView의 편집 모드로 진입할 수 있습니다.
 */

const { escapeHtml, formatUTCToKSTString } = require('../core/utils');

class PrescriptionDetailModal {
  /**
   * @param {object} app App 코디네이터
   */
  constructor(app) {
    this.app = app;
  }

  get manager() { return this.app.manager; }
  get state() { return this.app.state; }
  get dialogs() { return this.app.dialogs; }

  /** 닫기/수정 진입 버튼 이벤트를 바인딩합니다. */
  bindEvents() {
    // 처방 기록 상세조회 모달 닫기 바인딩
    const btnViewPrescClose = document.getElementById('btnViewPrescClose');
    if (btnViewPrescClose) {
      btnViewPrescClose.addEventListener('click', () => {
        document.getElementById('prescriptionDetailModal').classList.remove('show');
      });
    }

    // 처방 기록 상세조회 모달 → 처방 수정 모드 진입 바인딩
    const btnEditPrescriptionDetail = document.getElementById('btnEditPrescriptionDetail');
    if (btnEditPrescriptionDetail) {
      btnEditPrescriptionDetail.addEventListener('click', () => {
        if (this.state.currentDetailPrescId === null) return;
        document.getElementById('prescriptionDetailModal').classList.remove('show');
        this.app.prescription.enterPrescriptionEditMode(this.state.currentDetailPrescId);
      });
    }
  }

  /**
   * 처방 상세 정보를 채워 모달을 엽니다.
   * @param {string} prescId 처방 UUID
   */
  open(prescId) {
    try {
      const detail = this.manager.getPrescriptionDetails(prescId);
      this.state.currentDetailPrescId = prescId;

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

        // 미차감 처방에 한해 즉시 차감 실행 핸들러 연결 (열 때마다 대상 처방으로 갱신)
        deductBtn.onclick = async () => {
          const prescNameDisplay = detail.prescription_name || '(이름 없음)';
          if (await this.dialogs.showConfirm(`"${prescNameDisplay}" 처방의 약재 재고 차감을 실행하시겠습니까?\n이 작업은 되돌릴 수 없으며 중복 실행할 수 없습니다.`)) {
            try {
              this.manager.deductPrescriptionStock(prescId);
              this.dialogs.showToast('🎉 재고 차감이 성공적으로 완료되었습니다.');
              document.getElementById('prescriptionDetailModal').classList.remove('show');
              this.app.medicineList.render();
              this.app.prescription.renderPastPrescriptions();
              this.app.predict.render();
              this.app.notifications.render();
            } catch (err) {
              this.dialogs.showAlert(`재고 차감 실패: ${err.message}`);
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
      this.dialogs.showAlert(`처방전 상세정보를 불러오지 못했습니다: ${err.message}`);
    }
  }
}

module.exports = PrescriptionDetailModal;
