/**
 * @file PredictView.js
 * @description [발주 예측] 탭 View — SmartPredictor 기반 원클릭 발주 리스트.
 *
 * 리드 타임/분석 기간 파라미터를 조정하면 즉시 재계산하며,
 * '동적 안전재고 갱신' 버튼으로 제안값을 실제 DB에 반영할 수 있습니다.
 */

const BaseView = require('./BaseView');
const { escapeHtml } = require('../core/utils');

class PredictView extends BaseView {
  /** SmartPredictor 인스턴스 (App이 소유) */
  get predictor() { return this.app.predictor; }

  /** 발주 필요 리스트 테이블을 렌더링합니다. */
  render() {
    const empty = this.$('predictEmpty');
    const wrapper = this.$('predictTableWrapper');
    const tbody = this.$('predictBody');
    tbody.innerHTML = '';

    const leadTime = parseInt(this.$('predLeadTime').value) || 7;
    const analysisDays = parseInt(this.$('predAnalysisDays').value) || 30;

    const reorderList = this.predictor.getReorderList(leadTime, analysisDays);

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

  /** 파라미터 변경 및 안전재고 갱신 버튼 이벤트를 바인딩합니다. */
  bindEvents() {
    this.$('predLeadTime').addEventListener('change', () => this.render());
    this.$('predAnalysisDays').addEventListener('change', () => this.render());
    this.$('btnSyncPredictor').addEventListener('click', () => {
      const leadTime = parseInt(this.$('predLeadTime').value) || 7;
      const analysisDays = parseInt(this.$('predAnalysisDays').value) || 30;

      try {
        this.predictor.updateSafetyStocksToSuggested(leadTime, analysisDays);
        this.dialogs.showToast(`🔄 동적 안전재고 갱신 완료 (분석: ${analysisDays}일 / 리드: ${leadTime}일)`);
        this.render();
        this.app.medicineList.render();
      } catch (err) {
        this.dialogs.showAlert(`갱신 실패: ${err.message}`);
      }
    });
  }
}

module.exports = PredictView;
