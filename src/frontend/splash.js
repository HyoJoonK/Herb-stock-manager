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

/**
 * 진행률을 cap까지 서서히 차오르게 하는 타이머.
 * DB 로딩('starting')처럼 소요 시간을 알 수 없는 구간에서 바가 멈춰 보이지 않도록,
 * 남은 거리에 비례해 점점 느려지며 전진합니다. (cap 도달 전 스플래시가 닫히는 게 정상 흐름)
 */
let creepTimer = null;

function startCreep(from, cap) {
  stopCreep();
  let current = from;
  setProgress(current);
  creepTimer = setInterval(() => {
    current += Math.max(0.2, (cap - current) * 0.06);
    if (current >= cap) {
      current = cap;
      stopCreep();
    }
    setProgress(current);
  }, 200);
}

function stopCreep() {
  if (creepTimer) {
    clearInterval(creepTimer);
    creepTimer = null;
  }
}

// 진행률 배분: 업데이트 확인(0~45%) → 데이터 로딩(60~95%) → 100%는 실제 종착점
// (업데이트 설치 직전)에만 사용합니다. 메인 윈도우 노출 준비가 끝나면 스플래시가
// 닫히므로, 대기 중에 바가 100%로 가득 찬 채 멈춰 보이는 오해를 방지합니다.
ipcRenderer.on('update-status', (event, status, data) => {
  stopCreep();
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
      setProgress(45);
      break;
    case 'error':
      statusText.textContent = data.message || '최신 버전 정보를 읽을 수 없습니다. 실행합니다...';
      setProgress(45);
      break;
    case 'starting':
      statusText.textContent = data.message || '재고 관리 화면을 불러오는 중...';
      startCreep(60, 95);
      break;
    case 'ready':
      // 로딩 완료: 100%를 빠르게 채워 잠깐 보여준 뒤 메인 윈도우로 전환됩니다.
      // (WindowManager가 이 상태 전송 후 200ms 뒤에 스플래시를 닫음)
      statusText.textContent = data.message || '준비 완료! 프로그램을 시작합니다.';
      progressBar.style.transition = 'width 0.1s ease-out';
      setProgress(100);
      break;
  }
});
