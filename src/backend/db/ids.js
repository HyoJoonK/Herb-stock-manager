/**
 * @file ids.js
 * @description 식별자(ID) 관련 공통 상수 및 생성 유틸리티.
 *
 * v1.7.0에서 모든 엔티티의 기본 키가 정수(AUTOINCREMENT)에서 UUID(TEXT)로 전환되었습니다.
 * 이 모듈은 그 전환 규칙의 "단일 정의 지점"입니다:
 *  - 신규 레코드: crypto.randomUUID()로 생성한 무작위 v4 UUID
 *  - 구버전 정수 ID 레코드: `LEGACY_UUID_PREFIX + 12자리 16진수` 형태의 결정적(deterministic) UUID
 *    → 로컬 SQLite와 원격 Supabase가 각자 독립적으로 마이그레이션해도
 *      같은 레코드는 반드시 같은 UUID를 갖게 되어 동기화 대응 관계가 유지됩니다.
 *
 * 이 상수들을 다른 곳에 중복 정의하지 마세요. 값이 어긋나면 로컬-원격 ID 매핑이 깨집니다.
 */

const crypto = require('crypto');

/**
 * 기본 카테고리('미분류')의 고정 UUID.
 * 구 스키마의 id=1을 결정적 변환한 값과 동일하며, 앱 전역에서 삭제/수정이 금지됩니다.
 */
const DEFAULT_CATEGORY_ID = '00000000-0000-4000-8000-000000000001';

/**
 * 정수 ID → 결정적 UUID 변환 접두사.
 * 로컬 마이그레이션(Database.js)과 원격 마이그레이션(supabase_triggers.sql)이
 * 동일한 규칙을 공유하기 위한 값입니다.
 */
const LEGACY_UUID_PREFIX = '00000000-0000-4000-8000-';

/**
 * 새 레코드용 무작위 UUID(v4)를 생성합니다.
 * @returns {string} UUID 문자열
 */
function newUuid() {
  return crypto.randomUUID();
}

module.exports = {
  DEFAULT_CATEGORY_ID,
  LEGACY_UUID_PREFIX,
  newUuid
};
