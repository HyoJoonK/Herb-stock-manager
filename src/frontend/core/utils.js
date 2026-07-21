/**
 * @file utils.js
 * @description 렌더러 전역에서 공유하는 순수 유틸리티 함수 모음.
 * DOM/상태에 의존하지 않는 함수만 이곳에 둡니다.
 */

/**
 * 사용자 입력 데이터를 innerHTML 템플릿에 안전하게 삽입하기 위한 HTML 이스케이프 헬퍼.
 * 약재명/환자명/메모 등 모든 사용자 유래 문자열은 반드시 이 함수를 거쳐야 합니다. (XSS 방지)
 * @param {*} value 이스케이프할 값
 * @returns {string} 이스케이프된 문자열
 */
function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * UTC 기반의 시간 문자열(예: 'YYYY-MM-DD HH:mm:ss' 또는 ISO 8601 형식)을
 * 한국 시간대(KST, UTC+9)의 Date 객체로 변환합니다.
 * @param {string|Date} [utcTime]
 * @returns {Date} KST 기준의 Date 객체
 */
function parseUTCToKST(utcTime) {
  if (!utcTime) return new Date();

  if (utcTime instanceof Date) {
    return utcTime;
  }

  let formatted = utcTime.toString().trim();
  if (formatted.indexOf('T') === -1) {
    formatted = formatted.replace(' ', 'T');
  }
  if (!formatted.endsWith('Z') && !formatted.includes('+')) {
    formatted += 'Z';
  }

  const date = new Date(formatted);
  if (isNaN(date.getTime())) return new Date();
  return date;
}

/**
 * UTC 기반 시간 문자열을 한국 시간대 'YYYY-MM-DD HH:mm:ss' 형식으로 포맷팅합니다.
 * 인자가 없거나 falsy할 경우 현재 시간(KST) 문자열을 반환합니다.
 * @param {string} [utcTimeStr]
 * @returns {string} 'YYYY-MM-DD HH:mm:ss'
 */
function formatUTCToKSTString(utcTimeStr) {
  if (!utcTimeStr) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  const date = parseUTCToKST(utcTimeStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

module.exports = { escapeHtml, parseUTCToKST, formatUTCToKSTString };
