/**
 * @file InventoryManager.js
 * @description 한의원 약재 재고 관리 데이터베이스 스키마 및 핵심 비즈니스 로직 구현 (SQLite 및 Supabase 클라우드 동기화 지원)
 *
 * v1.7.0: 모든 엔티티 기본 키를 UUID(TEXT)로 전환했습니다.
 *  - 신규 레코드: crypto.randomUUID()
 *  - 기존 정수 ID 레코드: '00000000-0000-4000-8000-' + 12자리 16진수(구 ID) 형태의 결정적 UUID로 변환
 *    (로컬 SQLite와 원격 Supabase가 각자 마이그레이션해도 같은 레코드가 같은 UUID를 갖도록 보장)
 */

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  throw new Error('better-sqlite3 패키지를 로드할 수 없습니다. 프로그램 구동을 위해서는 SQLite 인프라가 필수적입니다.');
}

const crypto = require('crypto');

let createClient;
try {
  const supabaseSdk = require('@supabase/supabase-js');
  createClient = supabaseSdk.createClient;
} catch (e) {
  console.warn('@supabase/supabase-js 패키지를 로드할 수 없습니다. 클라우드 동기화가 불가능합니다.');
}

// 기본 카테고리('미분류')의 고정 UUID. 구 스키마의 id=1을 결정적 변환한 값과 동일합니다.
const DEFAULT_CATEGORY_ID = '00000000-0000-4000-8000-000000000001';

// 정수 ID → 결정적 UUID 변환 접두사 (로컬/원격 마이그레이션 공통 규칙)
const LEGACY_UUID_PREFIX = '00000000-0000-4000-8000-';

// 동기화 큐 항목의 비네트워크 오류 최대 재시도 횟수 (초과 시 sync_failures로 이동)
const MAX_SYNC_RETRIES = 5;

function newUuid() {
  return crypto.randomUUID();
}

/**
 * 동기화 대상 테이블 메타데이터.
 * 컬럼 목록/시간 컬럼/LWW 여부/부모-자식 관계를 선언하면 업서트 SQL, 실시간 반영,
 * 전체 동기화 루프가 모두 이 설정에서 파생됩니다. (테이블 누락형 버그 방지)
 */
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

// 외래 키 참조 순서(부모 → 자식)를 보장하는 전체 동기화 순회 순서
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

class InventoryManager {
  /**
   * @param {string} dbPath 데이터베이스 파일 경로
   */
  constructor(dbPath = 'herb_inventory.db') {
    this.dbPath = dbPath;
    this.db = null;
    this.supabase = null; // Supabase 클라이언트 인스턴스
    this.clockOffset = 0;

    // 동기화 큐 상태 필드 초기화
    this.isProcessingSync = false;
    this.syncRetryTimer = null;

    // 동기화 업서트 구문 캐시
    this._upsertStmtCache = new Map();

    this.initDb();

    // 브라우저 온라인 전환 감지 리스너 등록
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        console.log('[Sync Queue] 인터넷 연결이 감지되었습니다. 동기화 큐를 처리합니다...');
        this.processSyncQueue().catch(err => console.error('[Sync Queue] 온라인 전환 동기화 중 오류:', err));
      });
    }
  }

  get defaultCategoryId() {
    return DEFAULT_CATEGORY_ID;
  }

  /**
   * 데이터베이스 초기화, 레거시(정수 ID) 마이그레이션 및 테이블 생성
   */
  initDb() {
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');

      // 구 버전(정수 ID) 데이터베이스 감지 시 UUID 스키마로 마이그레이션
      this.migrateLegacyIntegerIds();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();

      this.db.prepare(`
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

      this.db.prepare(`
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

      this.db.prepare(`
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

      this.db.prepare(`
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

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS prescription_items (
          id TEXT PRIMARY KEY,
          prescription_id TEXT NOT NULL,
          medicine_id TEXT NOT NULL,
          amount REAL NOT NULL,
          FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
          FOREIGN KEY(medicine_id) REFERENCES medicines(id)
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS medicine_aliases (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL,
          alias TEXT UNIQUE NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
        )
      `).run();

      // Supabase 동기화 지원을 위한 삭제이력 테이블
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS deleted_records (
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (table_name, record_id)
        )
      `).run();

      // 처방전 프리셋 마스터 테이블
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS prescription_presets (
          id TEXT PRIMARY KEY,
          preset_name TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();

      // 처방전 프리셋 상세 약재 테이블
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS prescription_preset_items (
          id TEXT PRIMARY KEY,
          preset_id TEXT NOT NULL,
          medicine_id TEXT NOT NULL,
          amount REAL NOT NULL,
          FOREIGN KEY(preset_id) REFERENCES prescription_presets(id) ON DELETE CASCADE,
          FOREIGN KEY(medicine_id) REFERENCES medicines(id)
        )
      `).run();

      // Supabase 동기화 큐 테이블 (retry_count: 비네트워크 오류 재시도 횟수)
      this.db.prepare(`
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
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS sync_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          action TEXT NOT NULL,
          error TEXT,
          failed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();

      const exists = this.db.prepare('SELECT id FROM categories WHERE id = ?').get(DEFAULT_CATEGORY_ID);
      if (!exists) {
        this.db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(DEFAULT_CATEGORY_ID, '미분류');
      }
    } catch (err) {
      console.error('SQLite 초기화 실패:', err);
      throw err;
    }
  }

  /**
   * 구 버전(정수 AUTOINCREMENT ID) 스키마를 UUID(TEXT) 스키마로 안전하게 마이그레이션합니다.
   * 정수 ID는 '00000000-0000-4000-8000-<12자리 hex>' 형태의 결정적 UUID로 변환되어
   * 원격 Supabase 마이그레이션 결과와 동일한 ID 대응 관계를 유지합니다.
   */
  migrateLegacyIntegerIds() {
    const tableExists = (name) =>
      !!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

    if (!tableExists('medicines')) return; // 신규 설치 DB

    const idCol = this.db.pragma('table_info(medicines)').find(c => c.name === 'id');
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
        this.db.prepare(sql).run();
      } catch (e) {
        // 이미 컬럼이 존재할 시 무시
      }
    }
    for (const table of ['categories', 'medicines', 'prescriptions']) {
      try {
        this.db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE updated_at = ''`).run();
      } catch (e) {
        // updated_at 컬럼이 없는 예외 상황 무시
      }
    }

    // 정수 ID → 결정적 UUID 변환 SQL 표현식 (NULL 허용 컬럼 대응)
    const uuidExpr = (col) =>
      `CASE WHEN ${col} IS NULL THEN NULL ELSE '${LEGACY_UUID_PREFIX}' || printf('%012x', ${col}) END`;

    this.db.pragma('foreign_keys = OFF');
    try {
      const migrate = this.db.transaction(() => {
        // categories
        this.db.prepare(`
          CREATE TABLE categories_v2 (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();
        this.db.prepare(`
          INSERT INTO categories_v2 (id, name, updated_at)
          SELECT ${uuidExpr('id')}, name, updated_at FROM categories
        `).run();
        this.db.prepare('DROP TABLE categories').run();
        this.db.prepare('ALTER TABLE categories_v2 RENAME TO categories').run();

        // medicines
        this.db.prepare(`
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
        this.db.prepare(`
          INSERT INTO medicines_v2 (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at)
          SELECT ${uuidExpr('id')}, name, ${uuidExpr('category_id')}, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at
          FROM medicines
        `).run();
        this.db.prepare('DROP TABLE medicines').run();
        this.db.prepare('ALTER TABLE medicines_v2 RENAME TO medicines').run();

        // prescriptions (prescription_name의 구 NOT NULL 제약도 이 재생성으로 함께 해소)
        this.db.prepare(`
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
        this.db.prepare(`
          INSERT INTO prescriptions_v2 (id, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at)
          SELECT ${uuidExpr('id')}, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at
          FROM prescriptions
        `).run();
        this.db.prepare('DROP TABLE prescriptions').run();
        this.db.prepare('ALTER TABLE prescriptions_v2 RENAME TO prescriptions').run();

        // prescription_items
        if (tableExists('prescription_items')) {
          this.db.prepare(`
            CREATE TABLE prescription_items_v2 (
              id TEXT PRIMARY KEY,
              prescription_id TEXT NOT NULL,
              medicine_id TEXT NOT NULL,
              amount REAL NOT NULL,
              FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
              FOREIGN KEY(medicine_id) REFERENCES medicines(id)
            )
          `).run();
          this.db.prepare(`
            INSERT INTO prescription_items_v2 (id, prescription_id, medicine_id, amount)
            SELECT ${uuidExpr('id')}, ${uuidExpr('prescription_id')}, ${uuidExpr('medicine_id')}, amount
            FROM prescription_items
          `).run();
          this.db.prepare('DROP TABLE prescription_items').run();
          this.db.prepare('ALTER TABLE prescription_items_v2 RENAME TO prescription_items').run();
        }

        // stock_logs
        if (tableExists('stock_logs')) {
          this.db.prepare(`
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
          this.db.prepare(`
            INSERT INTO stock_logs_v2 (id, medicine_id, type, quantity, timestamp, prescription_id, note)
            SELECT ${uuidExpr('id')}, ${uuidExpr('medicine_id')}, type, quantity, timestamp, ${uuidExpr('prescription_id')}, note
            FROM stock_logs
          `).run();
          this.db.prepare('DROP TABLE stock_logs').run();
          this.db.prepare('ALTER TABLE stock_logs_v2 RENAME TO stock_logs').run();
        }

        // medicine_aliases
        if (tableExists('medicine_aliases')) {
          this.db.prepare(`
            CREATE TABLE medicine_aliases_v2 (
              id TEXT PRIMARY KEY,
              medicine_id TEXT NOT NULL,
              alias TEXT UNIQUE NOT NULL,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
            )
          `).run();
          this.db.prepare(`
            INSERT INTO medicine_aliases_v2 (id, medicine_id, alias, updated_at)
            SELECT ${uuidExpr('id')}, ${uuidExpr('medicine_id')}, alias, updated_at
            FROM medicine_aliases
          `).run();
          this.db.prepare('DROP TABLE medicine_aliases').run();
          this.db.prepare('ALTER TABLE medicine_aliases_v2 RENAME TO medicine_aliases').run();
        }

        // prescription_presets
        if (tableExists('prescription_presets')) {
          this.db.prepare(`
            CREATE TABLE prescription_presets_v2 (
              id TEXT PRIMARY KEY,
              preset_name TEXT NOT NULL,
              note TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `).run();
          this.db.prepare(`
            INSERT INTO prescription_presets_v2 (id, preset_name, note, created_at, updated_at)
            SELECT ${uuidExpr('id')}, preset_name, note, created_at, updated_at
            FROM prescription_presets
          `).run();
          this.db.prepare('DROP TABLE prescription_presets').run();
          this.db.prepare('ALTER TABLE prescription_presets_v2 RENAME TO prescription_presets').run();
        }

        // prescription_preset_items
        if (tableExists('prescription_preset_items')) {
          this.db.prepare(`
            CREATE TABLE prescription_preset_items_v2 (
              id TEXT PRIMARY KEY,
              preset_id TEXT NOT NULL,
              medicine_id TEXT NOT NULL,
              amount REAL NOT NULL,
              FOREIGN KEY(preset_id) REFERENCES prescription_presets(id) ON DELETE CASCADE,
              FOREIGN KEY(medicine_id) REFERENCES medicines(id)
            )
          `).run();
          this.db.prepare(`
            INSERT INTO prescription_preset_items_v2 (id, preset_id, medicine_id, amount)
            SELECT ${uuidExpr('id')}, ${uuidExpr('preset_id')}, ${uuidExpr('medicine_id')}, amount
            FROM prescription_preset_items
          `).run();
          this.db.prepare('DROP TABLE prescription_preset_items').run();
          this.db.prepare('ALTER TABLE prescription_preset_items_v2 RENAME TO prescription_preset_items').run();
        }

        // notifications (로컬 전용: 자체 id는 정수 유지, medicine_id 참조만 UUID로 변환)
        if (tableExists('notifications')) {
          this.db.prepare(`
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
          this.db.prepare(`
            INSERT INTO notifications_v2 (id, medicine_id, medicine_name, message, is_read, created_at)
            SELECT id, ${uuidExpr('medicine_id')}, medicine_name, message, is_read, created_at
            FROM notifications
          `).run();
          this.db.prepare('DROP TABLE notifications').run();
          this.db.prepare('ALTER TABLE notifications_v2 RENAME TO notifications').run();
        }

        // deleted_records (record_id를 결정적 UUID로 변환)
        if (tableExists('deleted_records')) {
          this.db.prepare(`
            CREATE TABLE deleted_records_v2 (
              table_name TEXT NOT NULL,
              record_id TEXT NOT NULL,
              deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (table_name, record_id)
            )
          `).run();
          this.db.prepare(`
            INSERT OR IGNORE INTO deleted_records_v2 (table_name, record_id, deleted_at)
            SELECT table_name, ${uuidExpr('record_id')}, deleted_at FROM deleted_records
          `).run();
          this.db.prepare('DROP TABLE deleted_records').run();
          this.db.prepare('ALTER TABLE deleted_records_v2 RENAME TO deleted_records').run();
        }

        // sync_queue (record_id 변환 + retry_count 컬럼 도입)
        if (tableExists('sync_queue')) {
          this.db.prepare(`
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
          this.db.prepare(`
            INSERT OR IGNORE INTO sync_queue_v2 (id, table_name, record_id, action, created_at)
            SELECT id, table_name, ${uuidExpr('record_id')}, action, created_at FROM sync_queue
          `).run();
          this.db.prepare('DROP TABLE sync_queue').run();
          this.db.prepare('ALTER TABLE sync_queue_v2 RENAME TO sync_queue').run();
        }
      });
      migrate();

      const fkIssues = this.db.pragma('foreign_key_check');
      if (fkIssues && fkIssues.length > 0) {
        console.warn('[Migration] 외래 키 정합성 경고:', fkIssues);
      }
      console.log('[Migration] UUID 스키마 마이그레이션 완료.');
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  // ==========================================
  // Supabase 동기화 핵심 엔진 (하이브리드 캐시/동기화 모델)
  // ==========================================

  /**
   * SQLite 날짜 포맷('YYYY-MM-DD HH:mm:ss')을 ISO8601 형식으로 안전하게 변환
   */
  parseSqliteTime(timeStr) {
    if (!timeStr) return new Date().toISOString();
    try {
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
   * ISO8601 또는 원격 날짜 포맷을 로컬 SQLite 날짜 포맷('YYYY-MM-DD HH:mm:ss')으로 안전하게 변환
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
   * DB는 항상 UTC로 저장하므로 반드시 parseSqliteTime을 거쳐 UTC로 해석해야 합니다.
   * (new Date('YYYY-MM-DD HH:mm:ss')는 로컬 시간대로 해석되어 KST 환경에서 9시간 오차가 발생)
   */
  localTimeMs(sqliteTimeStr) {
    return new Date(this.parseSqliteTime(sqliteTimeStr)).getTime();
  }

  /**
   * 원격(ISO8601) 시간 문자열을 epoch(ms)로 변환합니다.
   */
  remoteTimeMs(isoTimeStr) {
    const t = new Date(isoTimeStr || 0).getTime();
    return isNaN(t) ? 0 : t;
  }

  /**
   * Supabase 클라이언트를 초기화하고 자동 동기화를 시작합니다.
   * @param {string} url Supabase Project URL
   * @param {string} key Supabase Anon Key
   * @returns {Promise<boolean>} 연결 성공 여부
   */
  async setupSupabase(url, key) {
    if (url) {
      url = url.trim();
      if (!/^https?:\/\//i.test(url)) {
        if (!url.includes('.')) {
          url = `https://${url}.supabase.co`;
        } else {
          url = `https://${url}`;
        }
      }
    }

    if (!url || !key) {
      if (this.realtimeChannel) {
        this.supabase.removeChannel(this.realtimeChannel);
        this.realtimeChannel = null;
      }
      this.supabase = null;
      this.clockOffset = 0;
      console.log('Supabase 설정이 해제되었습니다. 로컬 단독 SQLite 모드로 전환합니다.');
      return true;
    }

    if (!createClient) {
      console.error('Supabase SDK가 로드되지 않아 설정을 활성화할 수 없습니다.');
      return false;
    }

    try {
      const client = createClient(url, key);
      const { error } = await client.from('categories').select('id').limit(1);
      if (error) {
        throw error;
      }

      this.supabase = client;
      console.log('Supabase 클라우드 데이터베이스와 정상 연결되었습니다.');

      // Clock Skew Offset 계산
      await this.calculateClockOffset(url, key);

      await this.syncAll();
      this.subscribeRealtime();
      this.processSyncQueue().catch(err => console.error('[Sync Queue] 최초 구동 시 큐 처리 오류:', err));

      return true;
    } catch (err) {
      console.error('Supabase 연결 및 최초 동기화 설정 실패:', err);
      this.supabase = null;
      throw err;
    }
  }

  /**
   * Supabase 서버 시간과 로컬 클라이언트 시간 간의 오프셋(차이)을 계산합니다.
   * API 키는 URL 쿼리가 아닌 요청 헤더로 전달합니다. (프록시/서버 로그 노출 방지)
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
        // RTT(왕복시간)의 절반을 더하여 지연 보정
        const adjustedServerTime = serverTime + (rtt / 2);
        this.clockOffset = adjustedServerTime - Date.now();
        console.log(`[Clock Sync] Supabase 서버와 시간 동기화 완료. Offset: ${this.clockOffset}ms`);
      }
    } catch (err) {
      console.warn('[Clock Sync] Supabase 서버 시간 동기화 실패 (기본값 0ms 사용):', err);
    }
  }

  /**
   * 보정된 시간을 SQLite YYYY-MM-DD HH:mm:ss 형식의 UTC 시간으로 반환합니다.
   */
  getAdjustedSqliteTime() {
    const adjustedMs = Date.now() + (this.clockOffset || 0);
    const d = new Date(adjustedMs);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  /**
   * 실시간 변경 콜백 등록
   */
  onDataChange(callback) {
    this.onDataChangeCallback = callback;
  }

  /**
   * 테이블 설정 기반의 로컬 업서트 구문을 생성/캐시합니다.
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
   */
  applyRemoteRow(table, row) {
    const cfg = SYNC_TABLES[table];
    const values = cfg.columns.map(col => {
      if (cfg.timeColumns.includes(col)) {
        return this.formatToSqliteTime(row[col]);
      }
      return row[col] === undefined ? null : row[col];
    });
    this.getUpsertStmt(table).run(...values);
  }

  /**
   * 로컬 행을 Supabase 업로드용 payload로 변환합니다. (시간 컬럼은 ISO8601로 변환)
   */
  localRowToPayload(table, row) {
    const cfg = SYNC_TABLES[table];
    const payload = {};
    for (const col of cfg.columns) {
      payload[col] = cfg.timeColumns.includes(col)
        ? this.parseSqliteTime(row[col])
        : (row[col] === undefined ? null : row[col]);
    }
    return payload;
  }

  /**
   * 로컬 데이터의 updated_at과 원격 데이터의 updated_at을 비교하여 원격 데이터가 더 최신인지 확인합니다.
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   * @param {string} remoteUpdatedAt 원격 updated_at 타임스탬프 (ISO 8601 형식)
   * @returns {boolean} 원격 데이터가 더 최신이거나 로컬 데이터가 없어서 덮어써야 하는 경우 true
   */
  shouldOverwriteWithRemote(table, id, remoteUpdatedAt) {
    if (!remoteUpdatedAt) return true;
    try {
      const local = this.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id);
      if (!local || !local.updated_at) return true;
      return this.remoteTimeMs(remoteUpdatedAt) > this.localTimeMs(local.updated_at);
    } catch (e) {
      console.warn(`[Sync Check] 타임스탬프 비교 오류, 기본 덮어쓰기 진행 (${table}, ID: ${id}):`, e);
      return true;
    }
  }

  /**
   * Supabase Realtime 웹소켓 채널 구독 시작
   */
  subscribeRealtime() {
    if (!this.supabase) return;

    if (this.realtimeChannel) {
      this.supabase.removeChannel(this.realtimeChannel);
    }

    console.log('[Supabase Realtime] 실시간 DB 변경 구독을 시작합니다...');

    this.realtimeChannel = this.supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public' },
        (payload) => {
          this.handleRealtimeChange(payload).catch(err => {
            console.error('[Supabase Realtime] 변경 반영 중 오류:', err);
          });
        }
      )
      .subscribe((status) => {
        console.log(`[Supabase Realtime] 채널 구독 상태: ${status}`);
      });
  }

  /**
   * 실시간 변경 데이터 처리 및 SQLite 반영 (테이블 설정 기반 공통 처리)
   */
  async handleRealtimeChange(payload) {
    const { table, eventType, new: newRow, old: oldRow } = payload;
    const cfg = SYNC_TABLES[table];
    if (!cfg) return; // deleted_records 등 동기화 대상 외 테이블은 무시

    console.log(`[Supabase Realtime] 변경 감지 - 테이블: ${table}, 이벤트: ${eventType}`);

    try {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (!cfg.lww || this.shouldOverwriteWithRemote(table, newRow.id, newRow.updated_at)) {
          this.applyRemoteRow(table, newRow);
        }
      } else if (eventType === 'DELETE') {
        this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(oldRow.id);
      }

      if (typeof this.onDataChangeCallback === 'function') {
        this.onDataChangeCallback();
      }
    } catch (err) {
      console.error(`[Supabase Realtime] SQLite 반영 실패 (${table}):`, err);
    }
  }

  /**
   * 로컬 SQLite의 updated_at 타임스탬프를 현재 시간으로 갱신하는 헬퍼 함수
   */
  updateUpdatedAt(table, id) {
    try {
      this.db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(this.getAdjustedSqliteTime(), id);
    } catch (e) {
      console.error(`${table}의 updated_at 갱신 실패:`, e);
    }
  }

  /**
   * 로컬에서 삭제된 아이템 ID를 deleted_records 테이블에 기록
   */
  recordDeleted(table, id) {
    try {
      this.db.prepare('INSERT OR IGNORE INTO deleted_records (table_name, record_id) VALUES (?, ?)').run(table, String(id));
    } catch (e) {
      console.error('삭제 이력 기록 실패:', e);
    }
  }

  /**
   * Supabase에 직접 특정 데이터를 Upsert (에러 전파)
   */
  async syncItemToSupabaseDirect(table, id) {
    if (!this.supabase) throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
    if (!SYNC_TABLES[table]) throw new Error(`동기화 대상이 아닌 테이블입니다: ${table}`);

    const data = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(String(id));
    if (!data) {
      console.warn(`[Supabase Sync Direct] ${table} (ID: ${id}) 데이터가 로컬에 존재하지 않아 업로드를 스킵합니다.`);
      return;
    }

    const payload = this.localRowToPayload(table, data);
    const { error } = await this.supabase.from(table).upsert(payload);
    if (error) {
      throw error;
    }
    console.log(`[Supabase Sync Direct] ${table} (ID: ${id}) 업로드 성공.`);
  }

  /**
   * Supabase에 직접 삭제 이력을 전송 (에러 전파)
   */
  async syncDeletedToSupabaseDirect(table, id) {
    if (!this.supabase) throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
    const recId = String(id);

    const { error } = await this.supabase.from(table).delete().eq('id', recId);
    if (error) {
      throw error;
    }

    this.db.prepare('DELETE FROM deleted_records WHERE table_name = ? AND record_id = ?').run(table, recId);
    console.log(`[Supabase Sync Direct] ${table} (ID: ${recId}) 삭제 동기화 완료.`);
  }

  /**
   * 원격 Supabase의 처방 프리셋 하위 아이템 교체 (에러 전파)
   */
  async syncPresetItemsDirect(prId) {
    if (!this.supabase) throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
    const { error } = await this.supabase.from('prescription_preset_items').delete().eq('preset_id', String(prId));
    if (error) throw error;

    const items = this.db.prepare('SELECT * FROM prescription_preset_items WHERE preset_id = ?').all(String(prId));
    if (items && items.length > 0) {
      const { error: insError } = await this.supabase.from('prescription_preset_items').insert(items);
      if (insError) throw insError;
    }
    console.log(`[Supabase Sync Direct] 처방 프리셋 ${prId} 하위 항목 동기화 완료.`);
  }

  /**
   * 동기화 작업을 로컬 SQLite 큐에 등록하고 처리를 트리거합니다.
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   * @param {string} action 'UPSERT' 또는 'DELETE' 또는 'REPLACE_PRESET_ITEMS'
   */
  enqueueSync(table, id, action) {
    const recId = String(id);
    try {
      this.db.prepare(`
        INSERT INTO sync_queue (table_name, record_id, action, retry_count, created_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(table_name, record_id, action)
        DO UPDATE SET created_at = excluded.created_at, retry_count = 0
      `).run(table, recId, action, this.getAdjustedSqliteTime());

      console.log(`[Sync Queue] 큐 등록 완료: ${action} - ${table} (ID: ${recId})`);

      this.processSyncQueue().catch(err => {
        console.error('[Sync Queue] 큐 실행 오류:', err);
      });
    } catch (e) {
      console.error('[Sync Queue] 큐 삽입 실패:', e);
    }
  }

  /**
   * 오류가 일시적 네트워크/서버 장애인지(재시도 가치가 있는지) 판별합니다.
   */
  isNetworkError(err) {
    if (!err) return false;
    // PostgREST가 반환하는 SQLSTATE 코드(예: 23505)는 데이터성 오류이므로 네트워크 장애가 아님
    if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return false;
    const status = typeof err.status === 'number' ? err.status : null;
    if (status !== null) {
      return status >= 500 || status === 429 || status === 408;
    }
    if (err instanceof TypeError) return true; // fetch 실패
    const msg = String(err.message || '');
    return /fetch|network|timeout|socket|abort|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg);
  }

  /**
   * SQLite 큐에 대기 중인 동기화 작업을 순차적으로 꺼내 Supabase에 업로드합니다.
   * - 네트워크/서버 장애: 큐를 그대로 유지하고 30초 후 재시도
   * - 데이터성 오류: retry_count를 증가시키고 다음 실행에서 재시도,
   *   MAX_SYNC_RETRIES회 도달 시 sync_failures 테이블로 이동해 이력을 보존 (묵살 방지)
   */
  async processSyncQueue() {
    if (this.isProcessingSync) return;
    if (!this.supabase) {
      console.log('[Sync Queue] Supabase 연결이 설정되어 있지 않아 큐 처리를 보류합니다.');
      return;
    }

    // 브라우저 환경이고 오프라인 상태이면 중단
    if (typeof window !== 'undefined' && typeof window.navigator !== 'undefined' && !window.navigator.onLine) {
      console.log('[Sync Queue] 네트워크 오프라인 상태이므로 큐 처리를 중단합니다.');
      return;
    }

    this.isProcessingSync = true;
    console.log('[Sync Queue] 큐 처리를 시작합니다...');

    try {
      if (this.syncRetryTimer) {
        clearTimeout(this.syncRetryTimer);
        this.syncRetryTimer = null;
      }

      while (true) {
        const tasks = this.db.prepare('SELECT * FROM sync_queue ORDER BY id ASC').all();
        if (tasks.length === 0) {
          console.log('[Sync Queue] 모든 동기화 작업이 성공적으로 처리되었습니다.');
          break;
        }

        let maxSeenId = 0;
        for (const task of tasks) {
          const { id, table_name, record_id, action } = task;
          maxSeenId = id;
          console.log(`[Sync Queue] 작업 처리 중 - ID: ${id}, 액션: ${action}, 테이블: ${table_name}, 레코드ID: ${record_id}`);

          try {
            if (action === 'UPSERT') {
              await this.syncItemToSupabaseDirect(table_name, record_id);
            } else if (action === 'DELETE') {
              await this.syncDeletedToSupabaseDirect(table_name, record_id);
            } else if (action === 'REPLACE_PRESET_ITEMS') {
              await this.syncPresetItemsDirect(record_id);
            }

            // 성공적으로 처리되면 큐에서 삭제
            this.db.prepare('DELETE FROM sync_queue WHERE id = ?').run(id);
          } catch (taskErr) {
            console.error(`[Sync Queue] 작업 처리 실패 (테이블: ${table_name}, ID: ${record_id}):`, taskErr.message);

            if (this.isNetworkError(taskErr)) {
              console.log('[Sync Queue] 네트워크 장애로 간주하여 큐 처리를 일시 정지하고 재시도 스케줄을 잡습니다.');
              this.scheduleSyncRetry();
              return;
            }

            const retryCount = (task.retry_count || 0) + 1;
            if (retryCount >= MAX_SYNC_RETRIES) {
              console.error(`[Sync Queue] ${MAX_SYNC_RETRIES}회 연속 실패로 작업을 실패 이력(sync_failures)으로 이동합니다: ${action} ${table_name} (${record_id})`);
              this.db.prepare(`
                INSERT INTO sync_failures (table_name, record_id, action, error, failed_at)
                VALUES (?, ?, ?, ?, ?)
              `).run(table_name, record_id, action, String(taskErr.message || taskErr), this.getAdjustedSqliteTime());
              this.db.prepare('DELETE FROM sync_queue WHERE id = ?').run(id);
            } else {
              console.warn(`[Sync Queue] 데이터성 오류로 재시도 대기 상태로 전환합니다. (${retryCount}/${MAX_SYNC_RETRIES})`);
              this.db.prepare('UPDATE sync_queue SET retry_count = ? WHERE id = ?').run(retryCount, id);
            }
          }
        }

        // 처리 도중 새로 등록된 작업만 이어서 처리 (실패 잔류 작업으로 인한 무한 루프 방지)
        const hasNew = this.db.prepare('SELECT 1 FROM sync_queue WHERE id > ? LIMIT 1').get(maxSeenId);
        if (!hasNew) break;
      }

      // 재시도 대기 중인 작업이 남아 있으면 재시도 예약
      const pending = this.db.prepare('SELECT 1 FROM sync_queue LIMIT 1').get();
      if (pending) {
        this.scheduleSyncRetry();
      }
    } finally {
      this.isProcessingSync = false;
    }
  }

  /**
   * 재시도 한도 초과로 포기된 동기화 실패 이력 조회 (진단용)
   */
  getSyncFailures() {
    return this.db.prepare('SELECT * FROM sync_failures ORDER BY failed_at DESC, id DESC').all();
  }

  /**
   * 동기화 재시도 타이머를 설정합니다. (30초 후)
   */
  scheduleSyncRetry() {
    if (this.syncRetryTimer) return;
    this.syncRetryTimer = setTimeout(() => {
      this.syncRetryTimer = null;
      console.log('[Sync Queue] 예정된 동기화 재시도를 실행합니다...');
      this.processSyncQueue().catch(err => console.error('[Sync Queue] 재시도 실행 오류:', err));
    }, 30000);
  }

  /**
   * 백그라운드로 특정 테이블의 특정 데이터를 Supabase에 Upsert (동기화 큐 이용)
   */
  async syncItemToSupabase(table, id) {
    this.enqueueSync(table, id, 'UPSERT');
  }

  /**
   * 백그라운드로 삭제 이력을 Supabase에 전송 (동기화 큐 이용)
   */
  async syncDeletedToSupabase(table, id) {
    this.enqueueSync(table, id, 'DELETE');
  }

  /**
   * 처방전 생성 시 처방과 처방 아이템을 한꺼번에 동기화 (동기화 큐 이용)
   */
  async syncPrescriptionToSupabase(prescId) {
    this.enqueueSync('prescriptions', prescId, 'UPSERT');

    const items = this.db.prepare('SELECT * FROM prescription_items WHERE prescription_id = ?').all(String(prescId));
    for (const item of items) {
      this.enqueueSync('prescription_items', item.id, 'UPSERT');
    }
  }

  /**
   * 전체 양방향 동기화 작업 (Last-Write-Wins 타임스탬프 비교 기반)
   * SYNC_TABLES 설정을 순회하는 공통 루프로 처리하여 테이블 누락형 버그를 방지합니다.
   */
  async syncAll() {
    if (!this.supabase) return;
    console.log('[Supabase Sync] 양방향 전체 동기화를 시작합니다 (벌크 최적화)...');

    try {
      // 1-1. 서버의 삭제 이력을 다운로드하여 로컬에 반영
      try {
        const { data: remoteDeleted, error: errDeleted } = await this.supabase
          .from('deleted_records')
          .select('*');

        if (errDeleted) {
          console.warn('[Supabase Sync] 서버 삭제 이력 조회 실패:', errDeleted.message);
        } else if (remoteDeleted && remoteDeleted.length > 0) {
          const allowedTables = Object.keys(SYNC_TABLES);
          const transaction = this.db.transaction(() => {
            for (const row of remoteDeleted) {
              if (allowedTables.includes(row.table_name)) {
                this.db.prepare(`DELETE FROM ${row.table_name} WHERE id = ?`).run(String(row.record_id));
              }
            }
          });
          transaction();
          console.log(`[Supabase Sync] 서버 삭제 이력 반영 완료 (${remoteDeleted.length}건 적용).`);
        }
      } catch (e) {
        console.error('[Supabase Sync] 서버 삭제 이력 로컬 반영 중 오류:', e);
      }

      // 1-2. 로컬의 삭제 이력을 서버에 동기화
      const deletedList = this.db.prepare('SELECT * FROM deleted_records').all();
      for (const row of deletedList) {
        await this.syncDeletedToSupabaseDirect(row.table_name, row.record_id);
      }

      // 2. 테이블 설정 기반 공통 동기화 루프
      for (const table of SYNC_TABLE_ORDER) {
        const cfg = SYNC_TABLES[table];
        if (cfg.syncWithParent) continue; // 부모 테이블 동기화 시 함께 처리됨

        const localRows = this.db.prepare(`SELECT * FROM ${table}`).all();
        const { data: remoteRows, error: remoteErr } = await this.supabase.from(table).select('*');
        if (remoteErr) throw remoteErr;

        const remoteMap = new Map(remoteRows.map(r => [r.id, r]));
        const localMap = new Map(localRows.map(r => [r.id, r]));

        // 2-1. 업로드 (로컬 → 원격)
        const toRemote = [];
        const childRowsToRemote = [];
        for (const localRow of localRows) {
          const remoteRow = remoteMap.get(localRow.id);
          let shouldUpload;
          if (cfg.insertOnly) {
            shouldUpload = !remoteRow;
          } else if (cfg.lww) {
            shouldUpload = !remoteRow || this.localTimeMs(localRow.updated_at) > this.remoteTimeMs(remoteRow.updated_at);
          } else {
            shouldUpload = !remoteRow;
          }

          if (shouldUpload) {
            toRemote.push(this.localRowToPayload(table, localRow));
            if (cfg.children) {
              const childRows = this.db.prepare(`SELECT * FROM ${cfg.children.table} WHERE ${cfg.children.fk} = ?`).all(localRow.id);
              childRowsToRemote.push(...childRows.map(cr => this.localRowToPayload(cfg.children.table, cr)));
            }
          }
        }
        if (toRemote.length > 0) {
          const { error: upErr } = cfg.insertOnly
            ? await this.supabase.from(table).insert(toRemote)
            : await this.supabase.from(table).upsert(toRemote);
          if (upErr) throw upErr;
          console.log(`[Supabase Sync] ${table} ${toRemote.length}건 업로드 성공.`);
        }
        if (childRowsToRemote.length > 0) {
          const { error: childErr } = await this.supabase.from(cfg.children.table).upsert(childRowsToRemote);
          if (childErr) throw childErr;
          console.log(`[Supabase Sync] ${cfg.children.table} ${childRowsToRemote.length}건 업로드 성공.`);
        }

        // 2-2. 다운로드 (원격 → 로컬)
        const toLocal = [];
        for (const remoteRow of remoteRows) {
          const localRow = localMap.get(remoteRow.id);
          let shouldDownload;
          if (cfg.insertOnly) {
            shouldDownload = !localRow;
          } else if (cfg.lww) {
            shouldDownload = !localRow || this.remoteTimeMs(remoteRow.updated_at) > this.localTimeMs(localRow.updated_at);
          } else {
            shouldDownload = !localRow;
          }
          if (shouldDownload) {
            toLocal.push(remoteRow);
          }
        }
        if (toLocal.length > 0) {
          const transaction = this.db.transaction(() => {
            for (const remoteRow of toLocal) {
              this.applyRemoteRow(table, remoteRow);
            }
          });
          transaction();

          if (cfg.children) {
            const parentIds = toLocal.map(r => r.id);
            const { data: childRows, error: childErr } = await this.supabase
              .from(cfg.children.table)
              .select('*')
              .in(cfg.children.fk, parentIds);
            if (!childErr && childRows && childRows.length > 0) {
              const childTx = this.db.transaction(() => {
                for (const childRow of childRows) {
                  this.applyRemoteRow(cfg.children.table, childRow);
                }
              });
              childTx();
            }
          }
          console.log(`[Supabase Sync] ${table} ${toLocal.length}건 다운로드 적용 완료.`);
        }
      }

      console.log('[Supabase Sync] 양방향 전체 벌크 동기화 완료!');
    } catch (err) {
      console.error('[Supabase Sync] 동기화 오류 발생:', err);
    }
  }

  // ==========================================
  // 공통 유효성 검사 헬퍼
  // ==========================================

  /**
   * 유한한 양수인지 검증하고 숫자로 반환합니다. (0/음수/NaN 차단)
   */
  assertPositiveAmount(value, label = '수량') {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`${label}은(는) 0보다 큰 숫자여야 합니다. (입력값: ${value})`);
    }
    return num;
  }

  // ==========================================
  // 카테고리 관리 API
  // ==========================================

  addCategory(name) {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('카테고리명은 비어둘 수 없습니다.');

    const exists = this.db.prepare('SELECT id FROM categories WHERE name = ?').get(cleanName);
    if (exists) return exists.id;

    const newId = newUuid();
    this.db.prepare('INSERT INTO categories (id, name, updated_at) VALUES (?, ?, ?)')
      .run(newId, cleanName, this.getAdjustedSqliteTime());

    this.syncItemToSupabase('categories', newId).catch(err => console.error('[Supabase Sync Error] categories:', err));

    return newId;
  }

  updateCategory(categoryId, name) {
    const catId = String(categoryId);
    if (catId === DEFAULT_CATEGORY_ID) throw new Error('기본 카테고리는 수정할 수 없습니다.');

    const cleanName = name.trim();
    if (!cleanName) throw new Error('카테고리명은 비어둘 수 없습니다.');

    const exists = this.db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(cleanName, catId);
    if (exists) throw new Error('이미 존재하는 카테고리명입니다.');

    this.db.prepare('UPDATE categories SET name = ?, updated_at = ? WHERE id = ?').run(cleanName, this.getAdjustedSqliteTime(), catId);

    this.syncItemToSupabase('categories', catId).catch(err => console.error('[Supabase Sync Error] update categories:', err));
  }

  deleteCategory(categoryId) {
    const catId = String(categoryId);
    if (catId === DEFAULT_CATEGORY_ID) throw new Error('기본 카테고리는 삭제할 수 없습니다.');

    const medicineIds = this.db.prepare('SELECT id FROM medicines WHERE category_id = ?').all(catId).map(row => row.id);

    this.db.transaction(() => {
      this.recordDeleted('categories', catId);
      this.db.prepare('DELETE FROM categories WHERE id = ?').run(catId);
      this.db.prepare('UPDATE medicines SET category_id = ?, updated_at = ? WHERE category_id = ?')
        .run(DEFAULT_CATEGORY_ID, this.getAdjustedSqliteTime(), catId);
    })();

    this.syncDeletedToSupabase('categories', catId).catch(err => console.error('[Supabase Sync Error] delete categories:', err));

    for (const medId of medicineIds) {
      this.syncItemToSupabase('medicines', medId).catch(err => console.error('[Supabase Sync Error] update medicines after category delete:', err));
    }
  }

  getAllCategories() {
    return this.db.prepare(`
      SELECT * FROM categories
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, name ASC
    `).all(DEFAULT_CATEGORY_ID);
  }

  // ==========================================
  // 약재 관리 API
  // ==========================================

  /**
   * 약재 데이터를 바탕으로 총 재고량 및 출력 포맷을 계산하는 인메모리 헬퍼 함수
   * @param {object} med 약재 객체
   */
  calculateStockInfo(med) {
    const { unopened_packs, pack_size, opened_pack_remain, unit, is_presence_only } = med;

    if (is_presence_only === 1) {
      const totalStock = unopened_packs > 0 ? pack_size : 0;
      const formatted = unopened_packs > 0 ? '재고 있음' : '재고 없음';
      return {
        totalStock,
        formatted
      };
    }

    const totalStock = (unopened_packs * pack_size) + opened_pack_remain;
    const comma = (num) => Math.round(num * 100) / 100;

    let formatted = `총 ${comma(totalStock)}${unit}`;
    if (unopened_packs > 0 || opened_pack_remain > 0) {
      formatted += ` (${unopened_packs}봉지 + ${comma(opened_pack_remain)}${unit} 남음)`;
    } else {
      formatted += ` (재고 없음)`;
    }

    return {
      totalStock,
      formatted
    };
  }

  getTotalStock(medicineId) {
    const med = this.db.prepare(`
      SELECT m.*, c.name as category_name
      FROM medicines m
      LEFT JOIN categories c ON m.category_id = c.id
      WHERE m.id = ?
    `).get(String(medicineId));

    if (!med) {
      throw new Error(`약재 ID ${medicineId}를 찾을 수 없습니다.`);
    }

    const stockInfo = this.calculateStockInfo(med);
    const aliases = this.db.prepare('SELECT alias FROM medicine_aliases WHERE medicine_id = ?').all(med.id).map(row => row.alias);

    return {
      totalStock: stockInfo.totalStock,
      formatted: stockInfo.formatted,
      unopened_packs: med.unopened_packs,
      opened_pack_remain: med.opened_pack_remain,
      pack_size: med.pack_size,
      unit: med.unit,
      name: med.name,
      category_id: med.category_id,
      categoryName: med.category_name || '미분류',
      safety_stock: med.safety_stock,
      aliases,
      memo: med.memo,
      is_presence_only: med.is_presence_only
    };
  }

  addMedicine(data) {
    const { name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, aliases, memo, is_presence_only } = data;
    if (!name || !pack_size || pack_size <= 0) {
      throw new Error('약재명과 유효한 팩 규격은 필수입니다.');
    }

    const catId = category_id ? String(category_id) : DEFAULT_CATEGORY_ID;

    // 이명 중복 및 유효성 검사
    if (aliases && aliases.length > 0) {
      for (const alias of aliases) {
        const cleanAlias = alias.trim();
        if (!cleanAlias) continue;

        // 1. 기존 약재 이름과 중복되는지 검사
        const dupName = this.db.prepare('SELECT id FROM medicines WHERE name = ?').get(cleanAlias);
        if (dupName) {
          throw new Error(`별칭 "${cleanAlias}"은(는) 이미 존재하는 약재명입니다.`);
        }
        // 2. 기존 다른 약재의 이명과 중복되는지 검사
        const dupAlias = this.db.prepare('SELECT id FROM medicine_aliases WHERE alias = ?').get(cleanAlias);
        if (dupAlias) {
          throw new Error(`별칭 "${cleanAlias}"은(는) 이미 다른 약재의 별칭으로 사용 중입니다.`);
        }
      }
    }

    const newId = newUuid();
    const insertedAliasIds = [];

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO medicines (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId,
        name,
        catId,
        Number(pack_size),
        Number(unopened_packs || 0),
        Number(opened_pack_remain || 0),
        Number(safety_stock || 0),
        unit || 'g',
        memo || null,
        Number(is_presence_only || 0),
        this.getAdjustedSqliteTime()
      );

      if (aliases && aliases.length > 0) {
        const aliasStmt = this.db.prepare(`
          INSERT INTO medicine_aliases (id, medicine_id, alias, updated_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const alias of aliases) {
          const cleanAlias = alias.trim();
          if (!cleanAlias) continue;
          const aliasId = newUuid();
          aliasStmt.run(aliasId, newId, cleanAlias, this.getAdjustedSqliteTime());
          insertedAliasIds.push(aliasId);
        }
      }
    });

    try {
      transaction();

      // medicines 업로드가 완료된 후 외래 키 참조 관계에 있는 medicine_aliases를 동기화하여 에러를 방지합니다.
      this.syncItemToSupabase('medicines', newId)
        .then(() => {
          for (const aliasId of insertedAliasIds) {
            this.syncItemToSupabase('medicine_aliases', aliasId).catch(err => console.error('[Supabase Sync Error] medicine_aliases:', err));
          }
        })
        .catch(err => console.error('[Supabase Sync Error] medicines:', err));

      return newId;
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        throw new Error(`이미 존재하는 약재명 또는 별칭입니다.`);
      }
      throw err;
    }
  }

  updateMedicine(medicineId, updateData) {
    const medId = String(medicineId);

    const execute = (med) => {
      const name = updateData.name !== undefined ? updateData.name : med.name;
      const category_id = updateData.category_id !== undefined ? String(updateData.category_id) : med.category_id;
      const pack_size = updateData.pack_size !== undefined ? Number(updateData.pack_size) : med.pack_size;
      const unopened_packs = updateData.unopened_packs !== undefined ? Number(updateData.unopened_packs) : med.unopened_packs;
      const opened_pack_remain = updateData.opened_pack_remain !== undefined ? Number(updateData.opened_pack_remain) : med.opened_pack_remain;
      const safety_stock = updateData.safety_stock !== undefined ? Number(updateData.safety_stock) : med.safety_stock;
      const unit = updateData.unit !== undefined ? updateData.unit : med.unit;
      const memo = updateData.memo !== undefined ? updateData.memo : med.memo;
      const is_presence_only = updateData.is_presence_only !== undefined ? Number(updateData.is_presence_only) : med.is_presence_only;

      if (pack_size <= 0) throw new Error('팩 규격은 0보다 커야 합니다.');
      if (opened_pack_remain > pack_size) throw new Error('개봉 잔량은 팩 규격을 초과할 수 없습니다.');

      // 단순 유무 관리 약재는 재고 오차(loss)를 계산하지 않습니다 (오차 로그가 불필요하므로).
      // 오차는 "변경 후 총량 - 변경 전 총량"이며, 각 총량은 해당 시점의 팩 규격으로 계산합니다.
      // 팩 규격만 바꿔도 실제 총 보유량이 달라지므로 그 차이가 그대로 보정 오차로 기록됩니다.
      let loss = 0;
      if (is_presence_only === 0 && med.is_presence_only === 0) {
        const oldTotal = (med.unopened_packs * med.pack_size) + med.opened_pack_remain;
        const newTotal = (unopened_packs * pack_size) + opened_pack_remain;
        loss = Math.round((newTotal - oldTotal) * 100) / 100;
      }

      return {
        name,
        category_id,
        pack_size,
        unopened_packs,
        opened_pack_remain,
        safety_stock,
        unit,
        memo,
        is_presence_only,
        loss
      };
    };

    let loss = 0;
    let insertedLogId = null;
    const insertedAliasIds = [];
    const deletedAliasIds = [];

    const transaction = this.db.transaction(() => {
      const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medId);
      if (!med) throw new Error('약재를 찾을 수 없습니다.');

      const updated = execute(med);
      loss = updated.loss;

      this.db.prepare(`
        UPDATE medicines
        SET name = ?, category_id = ?, pack_size = ?, unopened_packs = ?, opened_pack_remain = ?, safety_stock = ?, unit = ?, memo = ?, is_presence_only = ?, updated_at = ?
        WHERE id = ?
      `).run(
        updated.name,
        updated.category_id,
        updated.pack_size,
        updated.unopened_packs,
        updated.opened_pack_remain,
        updated.safety_stock,
        updated.unit,
        updated.memo,
        updated.is_presence_only,
        this.getAdjustedSqliteTime(),
        medId
      );

      if (loss !== 0) {
        insertedLogId = newUuid();
        this.db.prepare(`
          INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, note)
          VALUES (?, ?, 'ADJUST', ?, ?, ?)
        `).run(insertedLogId, medId, loss, this.getAdjustedSqliteTime(), `수동 데이터 보정 (오차: ${loss > 0 ? '+' : ''}${loss}g)`);
      }

      // 이명(Aliases) 업데이트 로직
      if (updateData.aliases !== undefined) {
        const oldAliases = this.db.prepare('SELECT id, alias FROM medicine_aliases WHERE medicine_id = ?').all(medId);
        const oldAliasesMap = new Map(oldAliases.map(a => [a.alias, a.id]));
        const newAliases = updateData.aliases.map(a => a.trim()).filter(Boolean);

        // 중복성 검증
        for (const alias of newAliases) {
          if (alias === updated.name) continue; // 본인 약재명과 같은 건 무시

          const dupName = this.db.prepare('SELECT id FROM medicines WHERE name = ? AND id != ?').get(alias, medId);
          if (dupName) {
            throw new Error(`별칭 "${alias}"은(는) 이미 존재하는 약재명입니다.`);
          }

          const dupAlias = this.db.prepare('SELECT id FROM medicine_aliases WHERE alias = ? AND medicine_id != ?').get(alias, medId);
          if (dupAlias) {
            throw new Error(`별칭 "${alias}"은(는) 이미 다른 약재의 별칭으로 사용 중입니다.`);
          }
        }

        const toDelete = oldAliases.filter(a => !newAliases.includes(a.alias));
        const toInsert = newAliases.filter(a => !oldAliasesMap.has(a));

        for (const a of toDelete) {
          this.recordDeleted('medicine_aliases', a.id);
          this.db.prepare('DELETE FROM medicine_aliases WHERE id = ?').run(a.id);
          deletedAliasIds.push(a.id);
        }

        const insertStmt = this.db.prepare(`
          INSERT INTO medicine_aliases (id, medicine_id, alias, updated_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const alias of toInsert) {
          const aliasId = newUuid();
          insertStmt.run(aliasId, medId, alias, this.getAdjustedSqliteTime());
          insertedAliasIds.push(aliasId);
        }
      }
    });

    try {
      transaction();

      // medicines 업로드가 완료된 후 외래 키 참조 관계에 있는 stock_logs와 medicine_aliases를 동기화하여 에러를 방지합니다.
      this.syncItemToSupabase('medicines', medId)
        .then(() => {
          if (insertedLogId) {
            this.syncItemToSupabase('stock_logs', insertedLogId).catch(err => console.error('[Supabase Sync Error] stock_logs:', err));
          }
          for (const id of insertedAliasIds) {
            this.syncItemToSupabase('medicine_aliases', id).catch(err => console.error('[Supabase Sync Error] medicine_aliases:', err));
          }
        })
        .catch(err => console.error('[Supabase Sync Error] medicines:', err));

      for (const id of deletedAliasIds) {
        this.syncDeletedToSupabase('medicine_aliases', id).catch(err => console.error('[Supabase Sync Error] delete medicine_aliases:', err));
      }

      return loss;
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        throw new Error(`이미 존재하는 약재명 또는 별칭입니다.`);
      }
      throw err;
    }
  }

  deleteMedicine(medicineId) {
    const medId = String(medicineId);
    const itemIds = this.db.prepare('SELECT id FROM prescription_items WHERE medicine_id = ?').all(medId).map(row => row.id);
    const logIds = this.db.prepare('SELECT id FROM stock_logs WHERE medicine_id = ?').all(medId).map(row => row.id);
    const aliasIds = this.db.prepare('SELECT id FROM medicine_aliases WHERE medicine_id = ?').all(medId).map(row => row.id);
    const presetItemIds = this.db.prepare('SELECT id FROM prescription_preset_items WHERE medicine_id = ?').all(medId).map(row => row.id);

    this.db.transaction(() => {
      for (const itemId of itemIds) {
        this.recordDeleted('prescription_items', itemId);
      }
      for (const logId of logIds) {
        this.recordDeleted('stock_logs', logId);
      }
      for (const aliasId of aliasIds) {
        this.recordDeleted('medicine_aliases', aliasId);
      }
      for (const presetItemId of presetItemIds) {
        this.recordDeleted('prescription_preset_items', presetItemId);
      }
      this.recordDeleted('medicines', medId);

      this.db.prepare('DELETE FROM prescription_items WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM stock_logs WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM medicine_aliases WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM prescription_preset_items WHERE medicine_id = ?').run(medId);
      this.db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
    })();

    const deleteSubPromises = [
      ...itemIds.map(itemId =>
        this.syncDeletedToSupabase('prescription_items', itemId)
          .catch(err => console.error('[Supabase Sync Error] delete prescription_items:', err))
      ),
      ...logIds.map(logId =>
        this.syncDeletedToSupabase('stock_logs', logId)
          .catch(err => console.error('[Supabase Sync Error] delete stock_logs:', err))
      ),
      ...aliasIds.map(aliasId =>
        this.syncDeletedToSupabase('medicine_aliases', aliasId)
          .catch(err => console.error('[Supabase Sync Error] delete medicine_aliases:', err))
      ),
      ...presetItemIds.map(presetItemId =>
        this.syncDeletedToSupabase('prescription_preset_items', presetItemId)
          .catch(err => console.error('[Supabase Sync Error] delete prescription_preset_items:', err))
      )
    ];

    Promise.all(deleteSubPromises)
      .then(() => {
        this.syncDeletedToSupabase('medicines', medId)
          .catch(err => console.error('[Supabase Sync Error] delete medicines:', err));
      });

    return true;
  }

  /**
   * 특정 처방전이 실제로 차감했던 약재별 소모량을 stock_logs 기준으로 집계합니다.
   * 처방 항목(amount)이 아닌 실제 차감 로그를 기준으로 복원해야
   * 소모 이후의 항목 수정/관리 방식 전환에도 정확한 복원이 보장됩니다.
   */
  getConsumedGramsByPrescription(prescriptionId) {
    return this.db.prepare(`
      SELECT medicine_id, SUM(-quantity) AS grams
      FROM stock_logs
      WHERE prescription_id = ? AND type = 'CONSUME'
      GROUP BY medicine_id
    `).all(String(prescriptionId));
  }

  /**
   * 소모 로그 집계를 바탕으로 약재 재고를 복원합니다. (트랜잭션 내부 사용 전용)
   * 단순 유무 관리 약재(현재 기준)와 소모량 0(차감 없던 항목)은 복원하지 않습니다.
   */
  restoreConsumedStockLocally(consumedRows) {
    for (const row of consumedRows) {
      const grams = Number(row.grams);
      if (!Number.isFinite(grams) || grams <= 0) continue;

      const med = this.db.prepare('SELECT unopened_packs, opened_pack_remain, pack_size, is_presence_only FROM medicines WHERE id = ?').get(row.medicine_id);
      if (!med || med.is_presence_only === 1) continue;

      let newRemain = med.opened_pack_remain + grams;
      let newPacks = med.unopened_packs;
      if (newRemain >= med.pack_size) {
        const extraPacks = Math.floor(newRemain / med.pack_size);
        newPacks += extraPacks;
        newRemain = newRemain % med.pack_size;
      }
      this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ? WHERE id = ?')
        .run(newPacks, newRemain, this.getAdjustedSqliteTime(), row.medicine_id);
    }
  }

  /**
   * 처방전 취소 및 삭제 (재고 자동 롤백 포함)
   * 롤백은 처방 항목(amount)이 아닌 실제 CONSUME 로그(stock_logs) 집계 기준으로 수행합니다.
   */
  deletePrescription(prescriptionId) {
    const pId = String(prescriptionId);
    const items = this.db.prepare('SELECT id, medicine_id, amount FROM prescription_items WHERE prescription_id = ?').all(pId);
    const logs = this.db.prepare('SELECT id FROM stock_logs WHERE prescription_id = ?').all(pId);
    const consumedRows = this.getConsumedGramsByPrescription(pId);

    this.db.transaction(() => {
      this.restoreConsumedStockLocally(consumedRows);

      this.recordDeleted('prescriptions', pId);
      for (const item of items) {
        this.recordDeleted('prescription_items', item.id);
      }
      for (const log of logs) {
        this.recordDeleted('stock_logs', log.id);
      }

      this.db.prepare('DELETE FROM prescription_items WHERE prescription_id = ?').run(pId);
      this.db.prepare('DELETE FROM stock_logs WHERE prescription_id = ?').run(pId);
      this.db.prepare('DELETE FROM prescriptions WHERE id = ?').run(pId);
    })();

    if (this.supabase) {
      // 하위 항목들(items, logs)을 먼저 Supabase에서 삭제 동기화
      const deleteSubPromises = [
        ...items.map(item =>
          this.syncDeletedToSupabase('prescription_items', item.id)
            .catch(err => console.error('[Supabase Sync Error] delete prescription_items:', err))
        ),
        ...logs.map(log =>
          this.syncDeletedToSupabase('stock_logs', log.id)
            .catch(err => console.error('[Supabase Sync Error] delete stock_logs:', err))
        )
      ];

      Promise.all(deleteSubPromises)
        .then(() => {
          // 하위 항목 삭제 완료 후, 처방전 자체 삭제 동기화 진행
          return this.syncDeletedToSupabase('prescriptions', pId)
            .catch(err => console.error('[Supabase Sync Error] delete prescriptions:', err));
        })
        .then(() => {
          // 원격 삭제가 완료된 후, 복원된 최종 medicines 상태를 로컬 정보로 업로드
          const medPromises = items.map(item =>
            this.syncItemToSupabase('medicines', item.medicine_id)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 삭제 동기화 전체 프로세스 오류:', err);
        });
    }

    return true;
  }

  /**
   * 처방 정보 및 포함 약재 목록/수량 전면 수정 (재고 복원 및 재소모)
   */
  updatePrescriptionWithItems(prescriptionId, prescriptionName, patientName, items, note = '', isDeducted = true) {
    const pId = String(prescriptionId);
    if (!items || items.length === 0) {
      throw new Error('처방전에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      this.assertPositiveAmount(item.amount, '약재 소모량');
    }

    const presc = this.db.prepare('SELECT is_deducted FROM prescriptions WHERE id = ?').get(pId);
    const wasDeducted = presc ? presc.is_deducted === 1 : false;

    const oldItems = this.db.prepare('SELECT id, medicine_id, amount FROM prescription_items WHERE prescription_id = ?').all(pId);
    const oldLogs = this.db.prepare('SELECT id FROM stock_logs WHERE prescription_id = ?').all(pId);
    const consumedRows = wasDeducted ? this.getConsumedGramsByPrescription(pId) : [];

    const newLogIdsToSync = [];
    const deductedVal = isDeducted ? 1 : 0;

    this.db.transaction(() => {
      // 기존에 차감되었던 처방전인 경우, 실제 CONSUME 로그 집계 기준으로 재고 복원
      if (wasDeducted) {
        this.restoreConsumedStockLocally(consumedRows);
      }

      // 삭제 이력 기록
      for (const oldItem of oldItems) {
        this.recordDeleted('prescription_items', oldItem.id);
      }
      for (const oldLog of oldLogs) {
        this.recordDeleted('stock_logs', oldLog.id);
      }

      // 기존 항목 삭제
      this.db.prepare('DELETE FROM prescription_items WHERE prescription_id = ?').run(pId);
      this.db.prepare('DELETE FROM stock_logs WHERE prescription_id = ?').run(pId);

      // 처방 테이블 정보 갱신
      this.db.prepare(`
        UPDATE prescriptions
        SET prescription_name = ?, patient_name = ?, total_items = ?, note = ?, is_deducted = ?, updated_at = ?
        WHERE id = ?
      `).run(prescriptionName, patientName, items.length, note, deductedVal, this.getAdjustedSqliteTime(), pId);

      // 새 항목 삽입 및 재소모
      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_items (id, prescription_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), pId, String(item.medicineId), item.amount);
        if (isDeducted) {
          const displayPrescName = prescriptionName ? `${prescriptionName} 처방` : '처방';
          const logId = this.consumeStockLocally(item.medicineId, item.amount, pId, `${displayPrescName} (${patientName})`);
          if (logId) {
            newLogIdsToSync.push(logId);
          }
        }
      }
    })();

    // Supabase 비동기 동기화 처리 (순차 제어 체인)
    if (this.supabase) {
      const deleteOldPromises = [
        ...oldItems.map(oldItem =>
          this.syncDeletedToSupabase('prescription_items', oldItem.id)
            .catch(err => console.error('[Supabase Sync Error] delete old prescription_items:', err))
        ),
        ...oldLogs.map(oldLog =>
          this.syncDeletedToSupabase('stock_logs', oldLog.id)
            .catch(err => console.error('[Supabase Sync Error] delete old stock_logs:', err))
        )
      ];

      Promise.all(deleteOldPromises)
        .then(() => this.syncPrescriptionToSupabase(pId))
        .then(() => {
          const logPromises = newLogIdsToSync.map(logId =>
            this.syncItemToSupabase('stock_logs', logId)
              .catch(err => console.error('[Supabase Sync Error] stock_logs:', err))
          );
          return Promise.all(logPromises);
        })
        .then(() => {
          const medIdsToSync = new Set();
          for (const oldItem of oldItems) {
            medIdsToSync.add(oldItem.medicine_id);
          }
          for (const item of items) {
            medIdsToSync.add(String(item.medicineId));
          }
          const medPromises = Array.from(medIdsToSync).map(medId =>
            this.syncItemToSupabase('medicines', medId)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 업데이트 동기화 전체 프로세스 오류:', err);
        });
    }

    return true;
  }

  // ==========================================
  // 기존 재고 제어 비즈니스 로직
  // ==========================================

  /**
   * 트랜잭션을 시작하지 않는 순수 로컬 SQLite 차감 메서드 (중첩 트랜잭션 방지용)
   * @returns {string|null} 생성된 stock_logs 레코드의 UUID
   */
  consumeStockLocally(medicineId, consumeGrams, prescriptionId = null, note = '') {
    const grams = this.assertPositiveAmount(consumeGrams, '소모량');

    const medId = String(medicineId);
    const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medId);
    if (!med) throw new Error('약재를 찾을 수 없습니다.');

    // 단순 유무 관리 약재는 처방 시 실제 재고를 차감하지는 않으나, 처방 내역 자체는 변동량 0으로 기록합니다.
    if (med.is_presence_only === 1) {
      const logId = newUuid();
      this.db.prepare(`
        INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
        VALUES (?, ?, 'CONSUME', 0, ?, ?, ?)
      `).run(logId, medId, this.getAdjustedSqliteTime(), prescriptionId, note || '처방 소모');
      return logId;
    }

    const { unopened_packs, pack_size, opened_pack_remain } = med;
    const totalStock = (unopened_packs * pack_size) + opened_pack_remain;

    if (totalStock < grams) {
      throw new Error(`재고가 부족합니다. (필요: ${grams}g, 현재: ${totalStock}g)`);
    }

    let currentRemain = opened_pack_remain;
    let currentUnopened = unopened_packs;
    let needed = grams;

    if (currentRemain >= needed) {
      currentRemain -= needed;
      needed = 0;
    } else {
      needed -= currentRemain;
      currentRemain = 0;

      const packsToOpen = Math.ceil(needed / pack_size);
      if (currentUnopened < packsToOpen) {
        throw new Error('데이터 정합성 이상: 총 재고가 필요한데 팩 개수가 모자랍니다.');
      }

      currentUnopened -= packsToOpen;
      currentRemain = (packsToOpen * pack_size) - needed;
      needed = 0;

      // 새 팩 개봉 알림 적재
      try {
        this.db.prepare(`
          INSERT INTO notifications (medicine_id, medicine_name, message, is_read, created_at)
          VALUES (?, ?, ?, 0, ?)
        `).run(
          medId,
          med.name,
          `${med.name} 약재의 개봉 잔량을 다 사용하고 새 팩(${packsToOpen}개)을 개봉했습니다. 새 팩을 뜯으셨다면 실제 잔량을 다시 한번 기록(보정)해보세요.`,
          this.getAdjustedSqliteTime()
        );
      } catch (err) {
        console.error('[Notification Insert Error]', err);
      }
    }

    this.db.prepare(`
      UPDATE medicines
      SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ?
      WHERE id = ?
    `).run(currentUnopened, currentRemain, this.getAdjustedSqliteTime(), medId);

    const logId = newUuid();
    this.db.prepare(`
      INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
      VALUES (?, ?, 'CONSUME', ?, ?, ?, ?)
    `).run(logId, medId, -grams, this.getAdjustedSqliteTime(), prescriptionId, note || '처방 소모');

    return logId;
  }

  consumeStock(medicineId, consumeGrams, prescriptionId = null, note = '') {
    let logId = null;
    const transaction = this.db.transaction(() => {
      logId = this.consumeStockLocally(medicineId, consumeGrams, prescriptionId, note);
    });
    transaction();

    if (logId) {
      this.syncItemToSupabase('stock_logs', logId).catch(err => console.error('[Supabase Sync Error] stock_logs:', err));
    }
    this.syncItemToSupabase('medicines', medicineId).catch(err => console.error('[Supabase Sync Error] medicines:', err));

    return true;
  }

  adjustStock(medicineId, realPacks, realRemain) {
    return this.updateMedicine(medicineId, {
      unopened_packs: realPacks,
      opened_pack_remain: realRemain
    });
  }

  addStockLog(medicineId, type, quantity, note = '') {
    const medId = String(medicineId);
    let logId = null;
    const transaction = this.db.transaction(() => {
      const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medId);
      if (!med) throw new Error('약재를 찾을 수 없습니다.');

      if (type === 'IN') {
        const inQty = this.assertPositiveAmount(quantity, '입고량');
        const packs = Math.floor(inQty / med.pack_size);
        const remain = inQty % med.pack_size;

        let newPacks = med.unopened_packs + packs;
        let newRemain = med.opened_pack_remain + remain;
        if (newRemain >= med.pack_size) {
          newPacks += 1;
          newRemain -= med.pack_size;
        }

        this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ? WHERE id = ?')
          .run(newPacks, newRemain, this.getAdjustedSqliteTime(), medId);

        logId = newUuid();
        this.db.prepare('INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, note) VALUES (?, ?, ?, ?, ?, ?)')
          .run(logId, medId, type, inQty, this.getAdjustedSqliteTime(), note);
      } else if (type === 'WASTE') {
        logId = this.consumeStockLocally(medId, Math.abs(Number(quantity)), null, note || '재고 폐기');
      } else {
        throw new Error(`지원하지 않는 재고 로그 유형입니다: ${type}`);
      }
    });
    transaction();

    if (logId) {
      this.syncItemToSupabase('stock_logs', logId).catch(err => console.error('[Supabase Sync Error] stock_logs:', err));
    }
    this.syncItemToSupabase('medicines', medId).catch(err => console.error('[Supabase Sync Error] medicines:', err));
  }

  addPrescription(prescriptionName, patientName, items, note = '', isDeducted = true) {
    if (!items || items.length === 0) {
      throw new Error('처방전에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      this.assertPositiveAmount(item.amount, '약재 소모량');
    }

    const pId = newUuid();
    const logIdsToSync = [];
    const deductedVal = isDeducted ? 1 : 0;

    const transaction = this.db.transaction(() => {
      const nowTime = this.getAdjustedSqliteTime();
      this.db.prepare(`
        INSERT INTO prescriptions (id, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pId, prescriptionName, patientName, items.length, note, deductedVal, nowTime, nowTime);

      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_items (id, prescription_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), pId, String(item.medicineId), item.amount);
        if (isDeducted) {
          const displayPrescName = prescriptionName ? `${prescriptionName} 처방` : '처방';
          const logId = this.consumeStockLocally(item.medicineId, item.amount, pId, `${displayPrescName} (${patientName})`);
          if (logId) {
            logIdsToSync.push(logId);
          }
        }
      }
    });
    transaction();

    // Supabase 순차 동기화 체인 구동
    if (this.supabase) {
      this.syncPrescriptionToSupabase(pId)
        .then(() => {
          // 처방전 및 아이템 업로드 완료 후, stock_logs 순차 업로드
          const logPromises = logIdsToSync.map(logId =>
            this.syncItemToSupabase('stock_logs', logId)
              .catch(err => console.error('[Supabase Sync Error] stock_logs:', err))
          );
          return Promise.all(logPromises);
        })
        .then(() => {
          // stock_logs 업로드 완료 후, 최종 medicines 업로드
          const medPromises = items.map(item =>
            this.syncItemToSupabase('medicines', item.medicineId)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 동기화 전체 프로세스 오류:', err);
        });
    }

    return pId;
  }

  getPrescriptionDetails(prescriptionId) {
    const pId = String(prescriptionId);
    const prescription = this.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(pId);
    if (!prescription) throw new Error('처방전 정보를 찾을 수 없습니다.');

    const items = this.db.prepare(`
      SELECT pi.medicine_id, pi.amount, m.name as medicine_name, m.unit
      FROM prescription_items pi
      JOIN medicines m ON pi.medicine_id = m.id
      WHERE pi.prescription_id = ?
    `).all(pId);

    return {
      ...prescription,
      items
    };
  }

  getAllMedicines() {
    const list = this.db.prepare(`
      SELECT m.*, c.name as category_name, GROUP_CONCAT(a.alias, ',') as aliases_str
      FROM medicines m
      LEFT JOIN categories c ON m.category_id = c.id
      LEFT JOIN medicine_aliases a ON m.id = a.medicine_id
      GROUP BY m.id
      ORDER BY m.name ASC
    `).all();
    return list.map(m => {
      const stockInfo = this.calculateStockInfo(m);
      return {
        ...m,
        total_stock: stockInfo.totalStock,
        formatted_stock: stockInfo.formatted,
        category_name: m.category_name || '미분류',
        aliases: m.aliases_str ? m.aliases_str.split(',') : []
      };
    });
  }

  getLogsByMedicine(medicineId) {
    return this.db.prepare(`
      SELECT l.*, m.name as medicine_name
      FROM stock_logs l
      JOIN medicines m ON l.medicine_id = m.id
      WHERE l.medicine_id = ?
      ORDER BY l.timestamp DESC, l.rowid DESC
    `).all(String(medicineId));
  }

  getAllLogs() {
    return this.db.prepare(`
      SELECT l.*, m.name as medicine_name
      FROM stock_logs l
      JOIN medicines m ON l.medicine_id = m.id
      ORDER BY l.timestamp DESC, l.rowid DESC
    `).all();
  }

  getAllPrescriptions() {
    return this.db.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC, rowid DESC').all();
  }

  /**
   * 최근 처방 N건만 조회 (불러오기 모달 등 전체 로드가 불필요한 화면용)
   */
  getRecentPrescriptions(limit = 5) {
    return this.db.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
  }

  /**
   * 처방 검색 (처방명/환자명/메모/포함 약재명)
   * @param {number} limit 0이면 무제한, 양수면 해당 건수까지만 반환
   */
  searchPrescriptions(query, limit = 0) {
    if (!query || query.trim() === '') {
      return limit > 0 ? this.getRecentPrescriptions(limit) : this.getAllPrescriptions();
    }
    const likeQuery = `%${query.trim()}%`;
    const params = [likeQuery, likeQuery, likeQuery, likeQuery];
    let sql = `
      SELECT DISTINCT p.*
      FROM prescriptions p
      LEFT JOIN prescription_items pi ON p.id = pi.prescription_id
      LEFT JOIN medicines m ON pi.medicine_id = m.id
      WHERE p.prescription_name LIKE ?
         OR p.patient_name LIKE ?
         OR p.note LIKE ?
         OR m.name LIKE ?
      ORDER BY p.created_at DESC
    `;
    if (limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    return this.db.prepare(sql).all(...params);
  }

  deductPrescriptionStock(prescriptionId) {
    const pId = String(prescriptionId);
    const presc = this.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(pId);
    if (!presc) {
      throw new Error('해당 처방전을 찾을 수 없습니다.');
    }
    if (presc.is_deducted === 1) {
      throw new Error('이미 재고가 차감된 처방전입니다.');
    }

    const items = this.db.prepare('SELECT * FROM prescription_items WHERE prescription_id = ?').all(pId);
    const logIdsToSync = [];

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE prescriptions
        SET is_deducted = 1, updated_at = ?
        WHERE id = ?
      `).run(this.getAdjustedSqliteTime(), pId);

      for (const item of items) {
        const displayPrescName = presc.prescription_name ? `${presc.prescription_name} 처방` : '처방';
        const logId = this.consumeStockLocally(item.medicine_id, item.amount, pId, `${displayPrescName} (${presc.patient_name})`);
        if (logId) {
          logIdsToSync.push(logId);
        }
      }
    });
    transaction();

    // Supabase 동기화
    if (this.supabase) {
      this.syncPrescriptionToSupabase(pId)
        .then(() => {
          const logPromises = logIdsToSync.map(logId =>
            this.syncItemToSupabase('stock_logs', logId)
              .catch(err => console.error('[Supabase Sync Error] stock_logs:', err))
          );
          return Promise.all(logPromises);
        })
        .then(() => {
          const medPromises = items.map(item =>
            this.syncItemToSupabase('medicines', item.medicine_id)
              .catch(err => console.error('[Supabase Sync Error] medicines:', err))
          );
          return Promise.all(medPromises);
        })
        .catch(err => {
          console.error('[Supabase Sync Error] 처방 재고차감 동기화 실패:', err);
        });
    }

    return true;
  }

  getNotifications() {
    return this.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC, id DESC').all();
  }

  markNotificationAsRead(id) {
    this.db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(id);
    return true;
  }

  deleteNotification(id) {
    this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
    return true;
  }

  // ==========================================
  // 처방 프리셋 관리 API
  // ==========================================

  getAllPresets() {
    return this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM prescription_preset_items ppi WHERE ppi.preset_id = p.id) as total_items
      FROM prescription_presets p
      ORDER BY p.created_at DESC, p.rowid DESC
    `).all();
  }

  getPresetDetails(presetId) {
    const prId = String(presetId);
    const preset = this.db.prepare('SELECT * FROM prescription_presets WHERE id = ?').get(prId);
    if (!preset) throw new Error('처방 프리셋 정보를 찾을 수 없습니다.');

    const items = this.db.prepare(`
      SELECT ppi.medicine_id, ppi.amount, m.name as medicine_name, m.unit
      FROM prescription_preset_items ppi
      JOIN medicines m ON ppi.medicine_id = m.id
      WHERE ppi.preset_id = ?
    `).all(prId);

    return {
      ...preset,
      items
    };
  }

  addPreset(presetName, note, items) {
    if (!presetName || presetName.trim() === '') {
      throw new Error('프리셋 이름을 입력해 주세요.');
    }
    if (!items || items.length === 0) {
      throw new Error('프리셋에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      this.assertPositiveAmount(item.amount, '약재 소모량');
    }

    const presetId = newUuid();
    this.db.transaction(() => {
      const nowTime = this.getAdjustedSqliteTime();
      this.db.prepare(`
        INSERT INTO prescription_presets (id, preset_name, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(presetId, presetName.trim(), note || '', nowTime, nowTime);

      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_preset_items (id, preset_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), presetId, String(item.medicineId), item.amount);
      }
    })();

    if (this.supabase) {
      this.syncPresetToSupabase(presetId).catch(err => console.error('[Supabase Sync Error] addPreset sync:', err));
    }

    return presetId;
  }

  updatePreset(presetId, presetName, note, items) {
    const prId = String(presetId);
    if (!presetName || presetName.trim() === '') {
      throw new Error('프리셋 이름을 입력해 주세요.');
    }
    if (!items || items.length === 0) {
      throw new Error('프리셋에 약재가 포함되어야 합니다.');
    }
    for (const item of items) {
      this.assertPositiveAmount(item.amount, '약재 소모량');
    }

    this.db.transaction(() => {
      const nowTime = this.getAdjustedSqliteTime();
      // 1. prescription_presets 업데이트
      this.db.prepare(`
        UPDATE prescription_presets
        SET preset_name = ?, note = ?, updated_at = ?
        WHERE id = ?
      `).run(presetName.trim(), note || '', nowTime, prId);

      // 2. 기존 prescription_preset_items 삭제
      this.db.prepare('DELETE FROM prescription_preset_items WHERE preset_id = ?').run(prId);

      // 3. 신규 prescription_preset_items 삽입
      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_preset_items (id, preset_id, medicine_id, amount)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(newUuid(), prId, String(item.medicineId), item.amount);
      }
    })();

    if (this.supabase) {
      this.syncPresetToSupabase(prId).catch(err => console.error('[Supabase Sync Error] updatePreset sync:', err));
    }

    return prId;
  }

  deletePreset(presetId) {
    const prId = String(presetId);
    this.db.transaction(() => {
      this.recordDeleted('prescription_presets', prId);
      // 외래 키 ON DELETE CASCADE 제약에 의해 prescription_preset_items는 자동 삭제됨
      this.db.prepare('DELETE FROM prescription_presets WHERE id = ?').run(prId);
    })();

    if (this.supabase) {
      this.syncDeletedToSupabase('prescription_presets', prId).catch(err => console.error('[Supabase Sync Error] deletePreset sync:', err));
    }
    return true;
  }

  async syncPresetToSupabase(presetId) {
    if (!this.supabase) return;
    const prId = String(presetId);

    // 프리셋 마스터 업서트 후, 하위 항목 전체 교체 작업을 큐에 등록 (오프라인에도 안전)
    this.enqueueSync('prescription_presets', prId, 'UPSERT');
    this.enqueueSync('prescription_presets', prId, 'REPLACE_PRESET_ITEMS');
  }
}

InventoryManager.DEFAULT_CATEGORY_ID = DEFAULT_CATEGORY_ID;
InventoryManager.LEGACY_UUID_PREFIX = LEGACY_UUID_PREFIX;

if (typeof module !== 'undefined') {
  module.exports = InventoryManager;
}
