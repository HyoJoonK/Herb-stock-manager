/**
 * @file Database.js
 * @description SQLite 연결 관리, 스키마 생성, 레거시(정수 ID) → UUID 마이그레이션 전담 클래스.
 *
 * 이 클래스는 "데이터베이스가 사용 가능한 상태인가"만 책임집니다.
 * CRUD는 repositories/, 비즈니스 로직은 services/, 클라우드 동기화는 sync/ 계층의 책임입니다.
 *
 * 스키마 변경 규칙 (마이그레이션 러너가 따로 없는 프로젝트입니다):
 *  - 새 컬럼 추가: createSchema() 안에서 `ALTER TABLE ... ADD COLUMN`을 try/catch로 감싸
 *    멱등적으로(이미 있으면 예외 무시) 적용하는 기존 패턴을 따르세요.
 *  - 새 테이블 추가: `CREATE TABLE IF NOT EXISTS` 사용.
 *  - 동기화 대상 테이블을 추가/변경할 때는 sync/TableMapper.js의 SYNC_TABLES 선언도
 *    함께 갱신해야 합니다. (그곳이 동기화 관련 유일한 등록 지점입니다)
 */

let Sqlite;
try {
  Sqlite = require('better-sqlite3');
} catch (e) {
  throw new Error('better-sqlite3 패키지를 로드할 수 없습니다. 프로그램 구동을 위해서는 SQLite 인프라가 필수적입니다.');
}

const { DEFAULT_CATEGORY_ID, LEGACY_UUID_PREFIX } = require('./ids');

class Database {
  /**
   * 연결을 열고, 필요 시 레거시 마이그레이션을 수행한 뒤, 전체 스키마를 보장합니다.
   * 생성자가 끝나면 DB는 즉시 사용 가능한 상태입니다.
   * @param {string} dbPath 데이터베이스 파일 경로 (':memory:' 허용 — 테스트용)
   */
  constructor(dbPath = 'herb_inventory.db') {
    this.dbPath = dbPath;

    /**
     * better-sqlite3 원시 연결 핸들.
     * repositories/services/sync 계층이 prepare()/transaction()에 직접 사용합니다.
     * @type {import('better-sqlite3').Database}
     */
    this.conn = null;

    try {
      this.conn = new Sqlite(dbPath);
      // WAL 모드: 읽기-쓰기 동시성 향상 (데스크톱 앱의 UI 응답성 확보)
      this.conn.pragma('journal_mode = WAL');
      this.conn.pragma('foreign_keys = ON');

      // 구 버전(정수 ID) 데이터베이스 감지 시 UUID 스키마로 먼저 변환한 뒤 스키마를 생성
      this.migrateLegacyIntegerIds();
      this.createSchema();
    } catch (err) {
      console.error('SQLite 초기화 실패:', err);
      throw err;
    }
  }

  /**
   * 전체 테이블 스키마를 생성하고 기본 데이터(기본 카테고리)를 시드합니다.
   * 모든 구문이 멱등적이므로 매 실행 시 안전하게 재호출됩니다.
   */
  createSchema() {
    // 약재 분류. id는 UUID이며 DEFAULT_CATEGORY_ID('미분류')는 항상 존재해야 합니다.
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    // 약재 마스터. 재고는 unopened_packs(미개봉 팩 수) + opened_pack_remain(개봉 팩 잔량)으로 표현.
    // is_presence_only=1이면 계량 없이 '있음/없음'만 관리하는 약재입니다.
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS medicines (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        category_id TEXT NOT NULL DEFAULT '${DEFAULT_CATEGORY_ID}',
        pack_size REAL NOT NULL,
        unopened_packs INTEGER NOT NULL DEFAULT 0,
        opened_pack_remain REAL NOT NULL DEFAULT 0,
        safety_stock REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT 'g',
        memo TEXT,
        is_presence_only INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK(pack_size > 0),
        CHECK(unopened_packs >= 0),
        CHECK(opened_pack_remain >= 0),
        CHECK(safety_stock >= 0),
        FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET DEFAULT
      )
    `).run();

    // 처방(조제) 헤더. is_deducted로 재고 차감 여부를 추적합니다.
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS prescriptions (
        id TEXT PRIMARY KEY,
        prescription_name TEXT,
        patient_name TEXT NOT NULL,
        total_items INTEGER NOT NULL,
        note TEXT,
        is_deducted INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    // 알림함 (로컬 전용 — 동기화하지 않으므로 정수 AUTOINCREMENT ID 유지)
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medicine_id TEXT NOT NULL,
        medicine_name TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
      )
    `).run();

    // 재고 변동 이력. SmartPredictor의 소모량 분석 원천 데이터이기도 합니다.
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS stock_logs (
        id TEXT PRIMARY KEY,
        medicine_id TEXT NOT NULL,
        type TEXT CHECK(type IN ('IN', 'CONSUME', 'WASTE', 'ADJUST')) NOT NULL,
        quantity REAL NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        prescription_id TEXT,
        note TEXT,
        FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE,
        FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE SET NULL
      )
    `).run();

    // 처방에 포함된 약재별 사용량 (처방 헤더의 자식 테이블)
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS prescription_items (
        id TEXT PRIMARY KEY,
        prescription_id TEXT NOT NULL,
        medicine_id TEXT NOT NULL,
        amount REAL NOT NULL,
        FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
        FOREIGN KEY(medicine_id) REFERENCES medicines(id)
      )
    `).run();

    // 약재 이명(별칭). 검색 시 원 약재명과 함께 매칭됩니다.
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS medicine_aliases (
        id TEXT PRIMARY KEY,
        medicine_id TEXT NOT NULL,
        alias TEXT UNIQUE NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
      )
    `).run();

    // 로컬 삭제 이력(tombstone). Supabase 동기화 시 원격에도 삭제를 전파하기 위한 테이블.
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS deleted_records (
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (table_name, record_id)
      )
    `).run();

    // 처방 프리셋 마스터 (자주 쓰는 처방 조합)
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS prescription_presets (
        id TEXT PRIMARY KEY,
        preset_name TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    // 처방 프리셋 상세 약재
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS prescription_preset_items (
        id TEXT PRIMARY KEY,
        preset_id TEXT NOT NULL,
        medicine_id TEXT NOT NULL,
        amount REAL NOT NULL,
        FOREIGN KEY(preset_id) REFERENCES prescription_presets(id) ON DELETE CASCADE,
        FOREIGN KEY(medicine_id) REFERENCES medicines(id)
      )
    `).run();

    // Supabase 업로드 대기열. retry_count는 비네트워크(데이터성) 오류의 재시도 횟수입니다.
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('UPSERT', 'DELETE', 'REPLACE_PRESET_ITEMS')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(table_name, record_id, action)
      )
    `).run();

    // 최대 재시도 초과로 포기한 동기화 작업 보관 테이블 (묵살 방지용 dead-letter)
    this.conn.prepare(`
      CREATE TABLE IF NOT EXISTS sync_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        action TEXT NOT NULL,
        error TEXT,
        failed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    // 기본 카테고리('미분류') 시드 — 항상 존재해야 하는 불변 레코드
    const exists = this.conn.prepare('SELECT id FROM categories WHERE id = ?').get(DEFAULT_CATEGORY_ID);
    if (!exists) {
      this.conn.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(DEFAULT_CATEGORY_ID, '미분류');
    }
  }

  /**
   * 구 버전(정수 AUTOINCREMENT ID) 스키마를 UUID(TEXT) 스키마로 안전하게 마이그레이션합니다.
   * 정수 ID는 'LEGACY_UUID_PREFIX + 12자리 hex' 형태의 결정적 UUID로 변환되어
   * 원격 Supabase 마이그레이션(supabase_triggers.sql) 결과와 동일한 ID 대응 관계를 유지합니다.
   *
   * 처리 순서: 테이블별로 (1) _v2 테이블 생성 → (2) 변환 복사 → (3) 구 테이블 DROP → (4) RENAME.
   * 전체가 하나의 트랜잭션이며, 외래 키 검사는 잠시 꺼두었다가 마지막에 정합성만 확인합니다.
   */
  migrateLegacyIntegerIds() {
    const tableExists = (name) =>
      !!this.conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

    if (!tableExists('medicines')) return; // 신규 설치 DB — 마이그레이션 불필요

    const idCol = this.conn.pragma('table_info(medicines)').find(c => c.name === 'id');
    if (!idCol || !/INT/i.test(idCol.type || '')) return; // 이미 UUID 스키마

    console.log('[Migration] 구 버전(정수 ID) 데이터베이스를 감지했습니다. UUID 스키마로 마이그레이션합니다...');

    // 1단계: 구 버전 간 컬럼 격차 보정 (아주 오래된 DB에도 아래 복사 쿼리가 동작하도록)
    const safeAlters = [
      'ALTER TABLE prescriptions ADD COLUMN note TEXT',
      'ALTER TABLE prescriptions ADD COLUMN is_deducted INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE medicines ADD COLUMN memo TEXT',
      'ALTER TABLE medicines ADD COLUMN is_presence_only INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE categories ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE medicines ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE prescriptions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''"
    ];
    for (const sql of safeAlters) {
      try {
        this.conn.prepare(sql).run();
      } catch (e) {
        // 이미 컬럼이 존재할 시 무시 (멱등 적용 패턴)
      }
    }
    for (const table of ['categories', 'medicines', 'prescriptions']) {
      try {
        this.conn.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE updated_at = ''`).run();
      } catch (e) {
        // updated_at 컬럼이 없는 예외 상황 무시
      }
    }

    // 정수 ID → 결정적 UUID 변환 SQL 표현식 (NULL 허용 컬럼 대응)
    const uuidExpr = (col) =>
      `CASE WHEN ${col} IS NULL THEN NULL ELSE '${LEGACY_UUID_PREFIX}' || printf('%012x', ${col}) END`;

    this.conn.pragma('foreign_keys = OFF');
    try {
      const migrate = this.conn.transaction(() => {
        // categories
        this.conn.prepare(`
          CREATE TABLE categories_v2 (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();
        this.conn.prepare(`
          INSERT INTO categories_v2 (id, name, updated_at)
          SELECT ${uuidExpr('id')}, name, updated_at FROM categories
        `).run();
        this.conn.prepare('DROP TABLE categories').run();
        this.conn.prepare('ALTER TABLE categories_v2 RENAME TO categories').run();

        // medicines
        this.conn.prepare(`
          CREATE TABLE medicines_v2 (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            category_id TEXT NOT NULL DEFAULT '${DEFAULT_CATEGORY_ID}',
            pack_size REAL NOT NULL,
            unopened_packs INTEGER NOT NULL DEFAULT 0,
            opened_pack_remain REAL NOT NULL DEFAULT 0,
            safety_stock REAL NOT NULL DEFAULT 0,
            unit TEXT NOT NULL DEFAULT 'g',
            memo TEXT,
            is_presence_only INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK(pack_size > 0),
            CHECK(unopened_packs >= 0),
            CHECK(opened_pack_remain >= 0),
            CHECK(safety_stock >= 0),
            FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET DEFAULT
          )
        `).run();
        this.conn.prepare(`
          INSERT INTO medicines_v2 (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at)
          SELECT ${uuidExpr('id')}, name, ${uuidExpr('category_id')}, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at
          FROM medicines
        `).run();
        this.conn.prepare('DROP TABLE medicines').run();
        this.conn.prepare('ALTER TABLE medicines_v2 RENAME TO medicines').run();

        // prescriptions (prescription_name의 구 NOT NULL 제약도 이 재생성으로 함께 해소)
        this.conn.prepare(`
          CREATE TABLE prescriptions_v2 (
            id TEXT PRIMARY KEY,
            prescription_name TEXT,
            patient_name TEXT NOT NULL,
            total_items INTEGER NOT NULL,
            note TEXT,
            is_deducted INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();
        this.conn.prepare(`
          INSERT INTO prescriptions_v2 (id, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at)
          SELECT ${uuidExpr('id')}, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at
          FROM prescriptions
        `).run();
        this.conn.prepare('DROP TABLE prescriptions').run();
        this.conn.prepare('ALTER TABLE prescriptions_v2 RENAME TO prescriptions').run();

        // prescription_items
        if (tableExists('prescription_items')) {
          this.conn.prepare(`
            CREATE TABLE prescription_items_v2 (
              id TEXT PRIMARY KEY,
              prescription_id TEXT NOT NULL,
              medicine_id TEXT NOT NULL,
              amount REAL NOT NULL,
              FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
              FOREIGN KEY(medicine_id) REFERENCES medicines(id)
            )
          `).run();
          this.conn.prepare(`
            INSERT INTO prescription_items_v2 (id, prescription_id, medicine_id, amount)
            SELECT ${uuidExpr('id')}, ${uuidExpr('prescription_id')}, ${uuidExpr('medicine_id')}, amount
            FROM prescription_items
          `).run();
          this.conn.prepare('DROP TABLE prescription_items').run();
          this.conn.prepare('ALTER TABLE prescription_items_v2 RENAME TO prescription_items').run();
        }

        // stock_logs
        if (tableExists('stock_logs')) {
          this.conn.prepare(`
            CREATE TABLE stock_logs_v2 (
              id TEXT PRIMARY KEY,
              medicine_id TEXT NOT NULL,
              type TEXT CHECK(type IN ('IN', 'CONSUME', 'WASTE', 'ADJUST')) NOT NULL,
              quantity REAL NOT NULL,
              timestamp TEXT NOT NULL DEFAULT (datetime('now')),
              prescription_id TEXT,
              note TEXT,
              FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE,
              FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE SET NULL
            )
          `).run();
          this.conn.prepare(`
            INSERT INTO stock_logs_v2 (id, medicine_id, type, quantity, timestamp, prescription_id, note)
            SELECT ${uuidExpr('id')}, ${uuidExpr('medicine_id')}, type, quantity, timestamp, ${uuidExpr('prescription_id')}, note
            FROM stock_logs
          `).run();
          this.conn.prepare('DROP TABLE stock_logs').run();
          this.conn.prepare('ALTER TABLE stock_logs_v2 RENAME TO stock_logs').run();
        }

        // medicine_aliases
        if (tableExists('medicine_aliases')) {
          this.conn.prepare(`
            CREATE TABLE medicine_aliases_v2 (
              id TEXT PRIMARY KEY,
              medicine_id TEXT NOT NULL,
              alias TEXT UNIQUE NOT NULL,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
            )
          `).run();
          this.conn.prepare(`
            INSERT INTO medicine_aliases_v2 (id, medicine_id, alias, updated_at)
            SELECT ${uuidExpr('id')}, ${uuidExpr('medicine_id')}, alias, updated_at
            FROM medicine_aliases
          `).run();
          this.conn.prepare('DROP TABLE medicine_aliases').run();
          this.conn.prepare('ALTER TABLE medicine_aliases_v2 RENAME TO medicine_aliases').run();
        }

        // prescription_presets
        if (tableExists('prescription_presets')) {
          this.conn.prepare(`
            CREATE TABLE prescription_presets_v2 (
              id TEXT PRIMARY KEY,
              preset_name TEXT NOT NULL,
              note TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `).run();
          this.conn.prepare(`
            INSERT INTO prescription_presets_v2 (id, preset_name, note, created_at, updated_at)
            SELECT ${uuidExpr('id')}, preset_name, note, created_at, updated_at
            FROM prescription_presets
          `).run();
          this.conn.prepare('DROP TABLE prescription_presets').run();
          this.conn.prepare('ALTER TABLE prescription_presets_v2 RENAME TO prescription_presets').run();
        }

        // prescription_preset_items
        if (tableExists('prescription_preset_items')) {
          this.conn.prepare(`
            CREATE TABLE prescription_preset_items_v2 (
              id TEXT PRIMARY KEY,
              preset_id TEXT NOT NULL,
              medicine_id TEXT NOT NULL,
              amount REAL NOT NULL,
              FOREIGN KEY(preset_id) REFERENCES prescription_presets(id) ON DELETE CASCADE,
              FOREIGN KEY(medicine_id) REFERENCES medicines(id)
            )
          `).run();
          this.conn.prepare(`
            INSERT INTO prescription_preset_items_v2 (id, preset_id, medicine_id, amount)
            SELECT ${uuidExpr('id')}, ${uuidExpr('preset_id')}, ${uuidExpr('medicine_id')}, amount
            FROM prescription_preset_items
          `).run();
          this.conn.prepare('DROP TABLE prescription_preset_items').run();
          this.conn.prepare('ALTER TABLE prescription_preset_items_v2 RENAME TO prescription_preset_items').run();
        }

        // notifications (로컬 전용: 자체 id는 정수 유지, medicine_id 참조만 UUID로 변환)
        if (tableExists('notifications')) {
          this.conn.prepare(`
            CREATE TABLE notifications_v2 (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              medicine_id TEXT NOT NULL,
              medicine_name TEXT NOT NULL,
              message TEXT NOT NULL,
              is_read INTEGER DEFAULT 0,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
            )
          `).run();
          this.conn.prepare(`
            INSERT INTO notifications_v2 (id, medicine_id, medicine_name, message, is_read, created_at)
            SELECT id, ${uuidExpr('medicine_id')}, medicine_name, message, is_read, created_at
            FROM notifications
          `).run();
          this.conn.prepare('DROP TABLE notifications').run();
          this.conn.prepare('ALTER TABLE notifications_v2 RENAME TO notifications').run();
        }

        // deleted_records (record_id를 결정적 UUID로 변환)
        if (tableExists('deleted_records')) {
          this.conn.prepare(`
            CREATE TABLE deleted_records_v2 (
              table_name TEXT NOT NULL,
              record_id TEXT NOT NULL,
              deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (table_name, record_id)
            )
          `).run();
          this.conn.prepare(`
            INSERT OR IGNORE INTO deleted_records_v2 (table_name, record_id, deleted_at)
            SELECT table_name, ${uuidExpr('record_id')}, deleted_at FROM deleted_records
          `).run();
          this.conn.prepare('DROP TABLE deleted_records').run();
          this.conn.prepare('ALTER TABLE deleted_records_v2 RENAME TO deleted_records').run();
        }

        // sync_queue (record_id 변환 + retry_count 컬럼 도입)
        if (tableExists('sync_queue')) {
          this.conn.prepare(`
            CREATE TABLE sync_queue_v2 (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              table_name TEXT NOT NULL,
              record_id TEXT NOT NULL,
              action TEXT NOT NULL CHECK(action IN ('UPSERT', 'DELETE', 'REPLACE_PRESET_ITEMS')),
              retry_count INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(table_name, record_id, action)
            )
          `).run();
          this.conn.prepare(`
            INSERT OR IGNORE INTO sync_queue_v2 (id, table_name, record_id, action, created_at)
            SELECT id, table_name, ${uuidExpr('record_id')}, action, created_at FROM sync_queue
          `).run();
          this.conn.prepare('DROP TABLE sync_queue').run();
          this.conn.prepare('ALTER TABLE sync_queue_v2 RENAME TO sync_queue').run();
        }
      });
      migrate();

      const fkIssues = this.conn.pragma('foreign_key_check');
      if (fkIssues && fkIssues.length > 0) {
        console.warn('[Migration] 외래 키 정합성 경고:', fkIssues);
      }
      console.log('[Migration] UUID 스키마 마이그레이션 완료.');
    } finally {
      this.conn.pragma('foreign_keys = ON');
    }
  }
}

module.exports = Database;
