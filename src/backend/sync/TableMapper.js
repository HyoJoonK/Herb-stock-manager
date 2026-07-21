/**
 * @file TableMapper.js
 * @description 동기화 대상 테이블의 "단일 등록 지점(single registration point)".
 *
 * 테이블별 컬럼 목록/시간 컬럼/충돌 정책/부모-자식 관계를 SYNC_TABLES에 한 번만 선언하면,
 * 다음 세 경로가 모두 이 선언에서 파생됩니다:
 *  1. 전체 동기화(SyncEngine.syncAll)의 업로드/다운로드 루프
 *  2. 실시간 변경 반영(RealtimeSubscriber)의 로컬 업서트
 *  3. 개별 업로드(SyncEngine.syncItemToSupabaseDirect)의 payload 변환
 *
 * → 새 동기화 테이블을 추가할 때는 SYNC_TABLES와 SYNC_TABLE_ORDER에만 항목을 추가하면
 *   됩니다. 과거처럼 세 곳(syncAll/handleRealtimeChange/syncItemToSupabaseDirect)을
 *   일일이 고칠 필요가 없으며, 누락형 동기화 버그가 구조적으로 방지됩니다.
 *
 * 선언 속성 설명:
 *  - columns: 로컬-원격이 공유하는 컬럼 목록 (id 필수 포함)
 *  - timeColumns: 시간 변환(SQLite ↔ ISO8601)이 필요한 컬럼
 *  - lww: true면 updated_at 비교(Last-Write-Wins)로 충돌 해소
 *  - insertOnly: true면 불변 이력 데이터 (수정 없음, 없는 쪽에만 삽입)
 *  - children: 부모 업로드/다운로드 시 함께 처리할 자식 테이블 선언
 *  - syncWithParent: true면 부모 테이블 동기화 흐름에서 함께 처리 (독립 순회 제외)
 */

/** 동기화 대상 테이블 메타데이터 선언부 */
const SYNC_TABLES = {
  categories: {
    columns: ['id', 'name', 'updated_at'],
    timeColumns: ['updated_at'],
    lww: true
  },
  medicines: {
    columns: ['id', 'name', 'category_id', 'pack_size', 'unopened_packs', 'opened_pack_remain', 'safety_stock', 'unit', 'memo', 'is_presence_only', 'updated_at'],
    timeColumns: ['updated_at'],
    lww: true
  },
  medicine_aliases: {
    columns: ['id', 'medicine_id', 'alias', 'updated_at'],
    timeColumns: ['updated_at'],
    lww: true
  },
  prescriptions: {
    columns: ['id', 'prescription_name', 'patient_name', 'total_items', 'note', 'is_deducted', 'created_at', 'updated_at'],
    timeColumns: ['created_at', 'updated_at'],
    lww: true,
    children: { table: 'prescription_items', fk: 'prescription_id' }
  },
  prescription_items: {
    columns: ['id', 'prescription_id', 'medicine_id', 'amount'],
    timeColumns: [],
    lww: false,
    syncWithParent: true
  },
  stock_logs: {
    columns: ['id', 'medicine_id', 'type', 'quantity', 'timestamp', 'prescription_id', 'note'],
    timeColumns: ['timestamp'],
    lww: false,
    insertOnly: true
  },
  prescription_presets: {
    columns: ['id', 'preset_name', 'note', 'created_at', 'updated_at'],
    timeColumns: ['created_at', 'updated_at'],
    lww: true,
    children: { table: 'prescription_preset_items', fk: 'preset_id' }
  },
  prescription_preset_items: {
    columns: ['id', 'preset_id', 'medicine_id', 'amount'],
    timeColumns: [],
    lww: false,
    syncWithParent: true
  }
};

/** 외래 키 참조 순서(부모 → 자식)를 보장하는 전체 동기화 순회 순서 */
const SYNC_TABLE_ORDER = [
  'categories',
  'medicines',
  'medicine_aliases',
  'prescriptions',
  'prescription_items',
  'stock_logs',
  'prescription_presets',
  'prescription_preset_items'
];

class TableMapper {
  /**
   * @param {object} db better-sqlite3 원시 연결
   * @param {object} time TimeService (시간 컬럼 변환용)
   */
  constructor(db, time) {
    this.db = db;
    this.time = time;
    /** 테이블별 로컬 업서트 prepared statement 캐시 */
    this._upsertStmtCache = new Map();
  }

  /**
   * 테이블 설정을 반환합니다. 동기화 대상이 아니면 undefined.
   * @param {string} table 테이블 이름
   * @returns {object|undefined}
   */
  getConfig(table) {
    return SYNC_TABLES[table];
  }

  /**
   * 동기화 대상 테이블인지 여부를 반환합니다.
   * @param {string} table 테이블 이름
   * @returns {boolean}
   */
  has(table) {
    return Object.prototype.hasOwnProperty.call(SYNC_TABLES, table);
  }

  /** 동기화 대상 테이블 이름 목록 */
  get tableNames() {
    return Object.keys(SYNC_TABLES);
  }

  /** FK 참조 순서가 보장된 전체 동기화 순회 순서 */
  get tableOrder() {
    return SYNC_TABLE_ORDER;
  }

  /**
   * 테이블 설정 기반의 로컬 업서트 구문을 생성/캐시합니다.
   * (INSERT ... ON CONFLICT(id) DO UPDATE — 원격 행을 로컬에 반영할 때 사용)
   * @param {string} table 테이블 이름
   * @returns {object} better-sqlite3 prepared statement
   */
  getUpsertStmt(table) {
    if (this._upsertStmtCache.has(table)) {
      return this._upsertStmtCache.get(table);
    }
    const cfg = SYNC_TABLES[table];
    const cols = cfg.columns;
    const placeholders = cols.map(() => '?').join(', ');
    const updates = cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(', ');
    const stmt = this.db.prepare(`
      INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updates}
    `);
    this._upsertStmtCache.set(table, stmt);
    return stmt;
  }

  /**
   * 원격 행 하나를 로컬 SQLite에 업서트합니다. (시간 컬럼은 SQLite 포맷으로 변환)
   * @param {string} table 테이블 이름
   * @param {object} row 원격(Postgres) 행 객체
   */
  applyRemoteRow(table, row) {
    const cfg = SYNC_TABLES[table];
    const values = cfg.columns.map(col => {
      if (cfg.timeColumns.includes(col)) {
        return this.time.formatToSqliteTime(row[col]);
      }
      return row[col] === undefined ? null : row[col];
    });
    this.getUpsertStmt(table).run(...values);
  }

  /**
   * 로컬 행을 Supabase 업로드용 payload로 변환합니다. (시간 컬럼은 ISO8601로 변환)
   * @param {string} table 테이블 이름
   * @param {object} row 로컬 SQLite 행 객체
   * @returns {object} 업로드 payload
   */
  localRowToPayload(table, row) {
    const cfg = SYNC_TABLES[table];
    const payload = {};
    for (const col of cfg.columns) {
      payload[col] = cfg.timeColumns.includes(col)
        ? this.time.parseSqliteTime(row[col])
        : (row[col] === undefined ? null : row[col]);
    }
    return payload;
  }
}

module.exports = TableMapper;
module.exports.SYNC_TABLES = SYNC_TABLES;
module.exports.SYNC_TABLE_ORDER = SYNC_TABLE_ORDER;
