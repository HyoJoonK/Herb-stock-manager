/**
 * @file UsageChart.js
 * @description 최근 조제 소모 추이 꺾은선 차트 컴포넌트 (바닐라 Canvas API 구현).
 *
 * 외부 차트 라이브러리 없이 직접 그립니다. 고해상도(DPI) 디스플레이에서
 * 선명하게 보이도록 devicePixelRatio 기반 해상도 보정을 수행합니다.
 */

const { formatUTCToKSTString } = require('../core/utils');

class UsageChart {
  /**
   * @param {object} manager InventoryManager (로그 데이터 소스)
   */
  constructor(manager) {
    this.manager = manager;
  }

  /**
   * 특정 약재의 최근 10일 일별 소모량을 캔버스에 그립니다.
   * @param {string} canvasId 캔버스 요소의 DOM id
   * @param {string} medId 약재 UUID
   */
  draw(canvasId, medId) {
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

    // 1. 데이터 소스 획득 (CONSUME 로그를 KST 날짜별로 합산)
    const logs = this.manager.getLogsByMedicine(medId).filter(l => l.type === 'CONSUME');

    // 날짜별 소모량 절대값 합산
    const consumptionMap = new Map();
    logs.forEach(log => {
      const kstStr = formatUTCToKSTString(log.timestamp);
      const dateStr = kstStr.split(' ')[0]; // KST 기준 YYYY-MM-DD
      const qty = Math.abs(log.quantity);
      consumptionMap.set(dateStr, (consumptionMap.get(dateStr) || 0) + qty);
    });

    // 최근 10일 날짜 라벨 배열 생성하여 가독성 좋은 미니 그래프 구축
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
}

module.exports = UsageChart;
