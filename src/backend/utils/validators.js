/**
 * @file validators.js
 * @description 계층 공통 유효성 검사 유틸리티.
 * 재고/처방/프리셋 등 수량이 오가는 모든 경로에서 동일한 검증 규칙을 공유합니다.
 */

/**
 * 값이 유한한 양수인지 검증하고 숫자로 변환해 반환합니다. (0/음수/NaN/Infinity 차단)
 * 검증 실패 시 사용자에게 그대로 보여줄 수 있는 한국어 메시지로 예외를 던집니다.
 * @param {*} value 검증할 값
 * @param {string} label 오류 메시지에 표시할 값의 명칭 (예: '소모량', '입고량')
 * @returns {number} 검증을 통과한 숫자 값
 * @throws {Error} 양수가 아닌 경우
 */
function assertPositiveAmount(value, label = '수량') {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label}은(는) 0보다 큰 숫자여야 합니다. (입력값: ${value})`);
  }
  return num;
}

module.exports = { assertPositiveAmount };
