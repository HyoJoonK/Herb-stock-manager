/**
 * @file ConflictResolver.js
 * @description Last-Write-Wins(LWW) 충돌 판정 전담 클래스.
 *
 * 로컬과 원격이 같은 레코드를 서로 다르게 수정했을 때, updated_at 타임스탬프가
 * 더 최신인 쪽을 채택하는 것이 이 앱의 충돌 해소 정책입니다.
 *
 * 판정의 정확성은 두 가지에 의존합니다:
 *  1. 로컬 시간 문자열을 반드시 UTC로 해석 (TimeService.localTimeMs)
 *  2. 기록 시점에 시계 보정된 타임스탬프 사용 (TimeService.getAdjustedSqliteTime)
 */

class ConflictResolver {
  /**
   * @param {object} db better-sqlite3 원시 연결
   * @param {object} time TimeService
   */
  constructor(db, time) {
    this.db = db;
    this.time = time;
  }

  /**
   * 로컬 데이터의 updated_at과 원격 데이터의 updated_at을 비교하여
   * 원격 데이터로 덮어써야 하는지 판정합니다.
   *
   * true를 반환하는 경우:
   *  - 원격이 더 최신인 경우
   *  - 로컬에 해당 레코드가 없는 경우 (신규 다운로드)
   *  - 비교 자체가 불가능한 경우 (안전하게 원격 우선)
   *
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   * @param {string} remoteUpdatedAt 원격 updated_at 타임스탬프 (ISO 8601 형식)
   * @returns {boolean} 원격 데이터로 덮어써야 하면 true
   */
  shouldOverwriteWithRemote(table, id, remoteUpdatedAt) {
    if (!remoteUpdatedAt) return true;
    try {
      const local = this.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id);
      if (!local || !local.updated_at) return true;
      return this.time.remoteTimeMs(remoteUpdatedAt) > this.time.localTimeMs(local.updated_at);
    } catch (e) {
      console.warn(`[Sync Check] 타임스탬프 비교 오류, 기본 덮어쓰기 진행 (${table}, ID: ${id}):`, e);
      return true;
    }
  }
}

module.exports = ConflictResolver;
