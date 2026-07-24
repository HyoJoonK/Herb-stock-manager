/**
 * @file splash.js
 * @description 스플래시 화면 업데이트 상태 표시 스크립트.
 * (CSP script-src 'self' 정책 준수를 위해 splash.html의 인라인 스크립트에서 분리)
 */

const { ipcRenderer } = require('electron');
const statusText = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');

// 0~100% 범위의 상태값에 맞춰 프로그레스 바를 제어합니다.
function setProgress(percent) {
  progressBar.style.width = percent + '%';
}

ipcRenderer.on('update-status', (event, status, data) => {
  switch (status) {
    case 'checking':
      statusText.textContent = data.message || '업데이트 확인 중...';
      setProgress(15);
      break;
    case 'available':
      statusText.textContent = data.message || '새 업데이트 다운로드 준비 중...';
      setProgress(30);
      break;
    case 'downloading': {
      const percent = data.percent || 0;
      statusText.textContent = data.message || `업데이트 다운로드 중... (${percent.toFixed(1)}%)`;
      // 다운로드 진행률을 30% ~ 90% 사이의 바 길이로 매핑하여 표시
      setProgress(30 + (percent * 0.6));
      break;
    }
    case 'downloaded':
      statusText.textContent = data.message || '다운로드 완료. 프로그램 업데이트 설치 중...';
      setProgress(100);
      break;
    case 'not-available':
      statusText.textContent = data.message || '최신 버전입니다. 프로그램을 실행합니다...';
      setProgress(100);
      break;
    case 'error':
      statusText.textContent = data.message || '최신 버전 정보를 읽을 수 없습니다. 실행합니다...';
      setProgress(100);
      break;
    case 'starting':
      statusText.textContent = data.message || '재고 관리 화면을 불러오는 중...';
      setProgress(100);
      break;
  }
});
