/**
 * @file TimeService.js
 * @description 시간 파싱/포맷 변환과 서버-클라이언트 시계 보정(clock offset)을 전담하는 서비스.
 *
 * 이 앱의 클라우드 동기화는 Last-Write-Wins(updated_at 비교) 방식이므로,
 * "정확한 시간"이 데이터 정합성의 근간입니다. 시간 관련 책임을 이 클래스 한 곳에 모아
 * 다음 두 가지 사고를 구조적으로 방지합니다:
 *
 *  1. 시간대 해석 오류: SQLite에 저장되는 'YYYY-MM-DD HH:mm:ss' 문자열은 항상 UTC입니다.
 *     `new Date('YYYY-MM-DD HH:mm:ss')`는 이를 로컬 시간대로 해석해 KST 환경에서
 *     9시간 오차가 발생하므로, 반드시 parseSqliteTime()을 거쳐 UTC로 해석해야 합니다.
 *  2. 시계 어긋남(clock skew): 클라이언트 PC의 시계가 서버와 다르면 LWW 판정이 뒤집힙니다.
 *     calculateClockOffset()이 HTTP Date 헤더와 RTT(왕복시간)로 오프셋을 계산하고,
 *     이후 모든 타임스탬프 기록은 getAdjustedSqliteTime()으로 보정된 값을 사용합니다.
 *
 * 규칙: DB에 updated_at/timestamp를 기록할 때 직접 `datetime('now')`를 쓰지 말고
 *       반드시 이 서비스의 getAdjustedSqliteTime()을 사용하세요.
 */

class TimeService {
  constructor() {
    /**
     * 서버 시간 - 로컬 시간 차이(ms). Supabase 연결 시 calculateClockOffset()이 갱신하며,
     * 연결 해제 시 0으로 리셋됩니다.
     * @type {number}
     */
    this.clockOffset = 0;
  }

  /**
   * SQLite 날짜 포맷('YYYY-MM-DD HH:mm:ss', UTC)을 ISO8601 문자열로 안전하게 변환합니다.
   * 파싱 불가능한 값이 들어오면 현재 시각을 반환합니다(동기화 흐름이 멈추지 않도록 방어).
   * @param {string} timeStr SQLite 시간 문자열
   * @returns {string} ISO8601 (UTC, 'Z' 접미사) 문자열
   */
  parseSqliteTime(timeStr) {
    if (!timeStr) return new Date().toISOString();
    try {
      // 'YYYY-MM-DD HH:mm:ss' → 'YYYY-MM-DDTHH:mm:ssZ' : 명시적 UTC 마킹이 핵심
      let formatted = timeStr.toString().trim().replace(' ', 'T');
      if (!formatted.endsWith('Z') && !formatted.includes('+')) {
        formatted += 'Z';
      }
      const d = new Date(formatted);
      return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    } catch (e) {
      return new Date().toISOString();
    }
  }

  /**
   * ISO8601 또는 원격(Postgres) 날짜 포맷을 로컬 SQLite 포맷('YYYY-MM-DD HH:mm:ss')으로 변환합니다.
   * 밀리초/시간대 표기를 잘라내고 초 단위까지만 유지합니다.
   * @param {string} isoTimeStr ISO8601 시간 문자열
   * @returns {string} SQLite 시간 문자열
   */
  formatToSqliteTime(isoTimeStr) {
    if (!isoTimeStr) return new Date().toISOString().replace('T', ' ').substring(0, 19);
    try {
      const formatted = isoTimeStr.toString().trim().replace('T', ' ');
      const parts = formatted.split('.');
      if (parts[0]) {
        return parts[0].substring(0, 19);
      }
      return formatted.substring(0, 19);
    } catch (e) {
      return new Date().toISOString().replace('T', ' ').substring(0, 19);
    }
  }

  /**
   * 로컬 SQLite에 저장된 UTC 시간 문자열을 epoch(ms)로 변환합니다.
   * DB는 항상 UTC로 저장하므로 반드시 parseSqliteTime을 거쳐 UTC로 해석합니다.
   * (LWW 비교의 로컬 측 값이 이 함수를 통해 계산됩니다.)
   * @param {string} sqliteTimeStr SQLite 시간 문자열
   * @returns {number} epoch 밀리초
   */
  localTimeMs(sqliteTimeStr) {
    return new Date(this.parseSqliteTime(sqliteTimeStr)).getTime();
  }

  /**
   * 원격(ISO8601) 시간 문자열을 epoch(ms)로 변환합니다.
   * 파싱 실패 시 0을 반환해 "원격이 더 오래됨"으로 안전하게 판정되도록 합니다.
   * @param {string} isoTimeStr ISO8601 시간 문자열
   * @returns {number} epoch 밀리초
   */
  remoteTimeMs(isoTimeStr) {
    const t = new Date(isoTimeStr || 0).getTime();
    return isNaN(t) ? 0 : t;
  }

  /**
   * Supabase 서버 시간과 로컬 클라이언트 시간 간의 오프셋을 계산해 this.clockOffset에 저장합니다.
   * HEAD 요청의 응답 헤더 'Date'와 RTT의 절반을 이용해 네트워크 지연을 보정합니다.
   * API 키는 URL 쿼리가 아닌 요청 헤더로 전달합니다(프록시/서버 로그 노출 방지).
   * 실패해도 예외를 던지지 않고 오프셋 0(보정 없음)으로 동작합니다.
   * @param {string} url Supabase Project URL
   * @param {string} key Supabase Anon Key
   */
  async calculateClockOffset(url, key) {
    this.clockOffset = 0;
    try {
      const start = Date.now();
      const res = await fetch(`${url}/rest/v1/`, {
        method: 'HEAD',
        headers: { apikey: key }
      });
      const serverDateStr = res.headers.get('date');
      if (serverDateStr) {
        const serverTime = new Date(serverDateStr).getTime();
        const rtt = Date.now() - start;
        // Date 헤더는 응답 생성 시점이므로 RTT의 절반을 더해 전송 지연을 보정
        const adjustedServerTime = serverTime + (rtt / 2);
        this.clockOffset = adjustedServerTime - Date.now();
        console.log(`[Clock Sync] Supabase 서버와 시간 동기화 완료. Offset: ${this.clockOffset}ms`);
      }
    } catch (err) {
      console.warn('[Clock Sync] Supabase 서버 시간 동기화 실패 (기본값 0ms 사용):', err);
    }
  }

  /**
   * 시계 오프셋이 보정된 현재 시간을 SQLite 'YYYY-MM-DD HH:mm:ss' 형식(UTC)으로 반환합니다.
   * 모든 로컬 타임스탬프 기록은 이 값을 사용해야 LWW 판정이 서버 기준으로 일관됩니다.
   * @returns {string} 보정된 SQLite 시간 문자열
   */
  getAdjustedSqliteTime() {
    const adjustedMs = Date.now() + (this.clockOffset || 0);
    const d = new Date(adjustedMs);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  /**
   * 시계 보정 상태를 초기화합니다. (Supabase 연결 해제 시 호출)
   */
  reset() {
    this.clockOffset = 0;
  }
}

module.exports = TimeService;
