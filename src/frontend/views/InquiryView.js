/**
 * @file InquiryView.js
 * @description [조회] 탭 View — 약재 상세 정보, 사용량 차트, 변경 로그 테이블.
 *
 * 좌측 약재 목록은 MedicineListView가 담당하고,
 * 이 View는 우측 상세 패널(정보/차트/로그/메모)만 소유합니다.
 */

const BaseView = require('./BaseView');
const UsageChart = require('../components/UsageChart');
const { escapeHtml, formatUTCToKSTString } = require('../core/utils');

class InquiryView extends BaseView {
  constructor(app) {
    super(app);
    /** 사용량 차트 드로잉 컴포넌트 (manager 준비 후 지연 생성) */
    this._chart = null;
  }

  /** UsageChart 지연 초기화 (App.initDatabase 이후 접근 보장) */
  get chart() {
    if (!this._chart) {
      this._chart = new UsageChart(this.manager);
    }
    return this._chart;
  }

  /**
   * 특정 약재의 상세 정보를 렌더링합니다. (정보 필드 + 차트 + 로그)
   * @param {string} medId 약재 UUID
   */
  showDetails(medId) {
    this.state.currentInquiryMedId = medId;
    const detailEmpty = this.$('inquiryDetailEmpty');
    const detailContent = this.$('inquiryDetailContent');

    try {
      const info = this.manager.getTotalStock(medId);

      this.$('detName').textContent = info.name;
      this.$('detAliases').textContent = info.aliases && info.aliases.length > 0 ? info.aliases.join(', ') : '-';
      this.$('detCategory').textContent = info.categoryName;
      this.$('detPackSize').textContent = `${info.pack_size}${info.unit}`;
      this.$('detTotalStock').textContent = info.formatted;
      this.$('detSafetyStock').textContent = `${info.safety_stock}${info.unit}`;
      this.$('detUnit').textContent = info.unit;
      this.$('detMemo').value = info.memo || '';

      detailEmpty.style.display = 'none';
      detailContent.style.display = 'block';

      // Canvas 사용량 차트 드로잉
      this.chart.draw('usageChart', medId);

      // 개별 변경 로그 렌더링
      this.renderLogs(medId);
    } catch (err) {
      console.error('상세 정보 조회 실패:', err);
      this.dialogs.showToast('약재 정보를 조회할 수 없습니다.', true);
    }
  }

  /** 상세 패널을 빈 상태로 되돌립니다. (조회 중이던 약재가 삭제된 경우) */
  clearDetails() {
    this.$('inquiryDetailEmpty').style.display = 'flex';
    this.$('inquiryDetailContent').style.display = 'none';
    this.$('inquiryLogsEmpty').style.display = 'flex';
    this.$('inquiryLogsWrapper').style.display = 'none';
  }

  /**
   * 특정 약재의 변경 내역 로그 테이블을 렌더링합니다.
   * @param {string} medId 약재 UUID
   */
  renderLogs(medId) {
    const wrapper = this.$('inquiryLogsWrapper');
    const empty = this.$('inquiryLogsEmpty');
    const tbody = this.$('inquiryLogsBody');
    tbody.innerHTML = '';

    const logs = this.manager.getLogsByMedicine(medId);

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

  /** 상세 패널 이벤트(메모 자동 저장)를 바인딩합니다. */
  bindEvents() {
    // 약재 상세 메모 자동 저장 리스너
    const detMemo = this.$('detMemo');
    if (detMemo) {
      detMemo.addEventListener('blur', () => {
        if (this.state.currentInquiryMedId) {
          const val = detMemo.value;
          try {
            this.manager.updateMedicine(this.state.currentInquiryMedId, { memo: val });
            this.dialogs.showToast('📝 메모가 저장되었습니다.');
          } catch (err) {
            console.error('메모 자동 저장 실패:', err);
            this.dialogs.showToast('메모 저장에 실패했습니다.', true);
          }
        }
      });
    }
  }
}

module.exports = InquiryView;
