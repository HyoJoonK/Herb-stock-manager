/**
 * @file InventoryManager.js
 * @description 한의원 약재 재고 관리 데이터베이스 스키마 및 핵심 비즈니스 로직 구현 (SQLite 및 Supabase 클라우드 동기화 지원)
 *
 * v1.7.0: 모든 엔티티 기본 키를 UUID(TEXT)로 전환했습니다.
 *  - 신규 레코드: crypto.randomUUID()
 *  - 기존 정수 ID 레코드: '00000000-0000-4000-8000-' + 12자리 16진수(구 ID) 형태의 결정적 UUID로 변환
 *    (로컬 SQLite와 원격 Supabase가 각자 마이그레이션해도 같은 레코드가 같은 UUID를 갖도록 보장)
 */

// 객체지향 분리 구조: 연결/스키마/마이그레이션은 db/Database.js,
// 시간 파싱 및 시계 보정은 db/TimeService.js, ID 규칙은 db/ids.js가 전담합니다.
const AppDatabase = require('./db/Database');
const TimeService = require('./db/TimeService');
const { DEFAULT_CATEGORY_ID, LEGACY_UUID_PREFIX, newUuid } = require('./db/ids');
const { assertPositiveAmount } = require('./utils/validators');

// Repository 계층 (테이블별 CRUD)
const CategoryRepository = require('./repositories/CategoryRepository');
const MedicineRepository = require('./repositories/MedicineRepository');
const PrescriptionRepository = require('./repositories/PrescriptionRepository');
const PresetRepository = require('./repositories/PresetRepository');
const StockLogRepository = require('./repositories/StockLogRepository');
const NotificationRepository = require('./repositories/NotificationRepository');

// Service 계층 (트랜잭션 단위 비즈니스 로직)
const StockService = require('./services/StockService');
const PrescriptionService = require('./services/PrescriptionService');

let createClient;
try {
  const supabaseSdk = require('@supabase/supabase-js');
  createClient = supabaseSdk.createClient;
} catch (e) {
  console.warn('@supabase/supabase-js 패키지를 로드할 수 없습니다. 클라우드 동기화가 불가능합니다.');
}

// 동기화 큐 항목의 비네트워크 오류 최대 재시도 횟수 (초과 시 sync_failures로 이동)
const MAX_SYNC_RETRIES = 5;

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

    // 연결/스키마/레거시 마이그레이션은 AppDatabase 생성자에서 모두 완료됩니다.
    this.appDb = new AppDatabase(dbPath);

    /**
     * better-sqlite3 원시 연결 핸들 (하위 호환용 공개 프로퍼티).
     * 기존 호출부(테스트, CSVHandler, SmartPredictor)가 manager.db를 직접 참조합니다.
     */
    this.db = this.appDb.conn;

    // 시간 파싱/시계 보정 전담 서비스
    this.time = new TimeService();

    this.supabase = null; // Supabase 클라이언트 인스턴스

    // 동기화 큐 상태 필드 초기화
    this.isProcessingSync = false;
    this.syncRetryTimer = null;

    // 동기화 업서트 구문 캐시
    this._upsertStmtCache = new Map();

    // ---- Repository / Service 계층 조립 (의존성 주입) --------------------------
    // sync에 facade 자신(this)을 주입: 하위 계층은 syncItemToSupabase 등
    // 동기화 트리거 인터페이스만 알면 되고, 실제 구현 위치는 알 필요가 없습니다.
    const ctx = { db: this.db, time: this.time, sync: this };

    /** categories 테이블 CRUD */
    this.categoryRepo = new CategoryRepository(ctx);
    /** medicines / medicine_aliases 테이블 CRUD */
    this.medicineRepo = new MedicineRepository(ctx);
    /** prescriptions / prescription_items 조회 */
    this.prescriptionRepo = new PrescriptionRepository(ctx);
    /** prescription_presets / prescription_preset_items CRUD */
    this.presetRepo = new PresetRepository(ctx);
    /** stock_logs 조회 및 소모량 집계 */
    this.stockLogRepo = new StockLogRepository(ctx);
    /** notifications(알림함) CRUD */
    this.notificationRepo = new NotificationRepository(ctx);

    /** 재고 증감 비즈니스 로직 (소모/입고/폐기/복원) */
    this.stockService = new StockService({
      ...ctx,
      medicines: this.medicineRepo,
      notifications: this.notificationRepo
    });
    /** 처방 생성/수정/삭제/차감 트랜잭션 로직 */
    this.prescriptionService = new PrescriptionService({
      ...ctx,
      stock: this.stockService,
      stockLogs: this.stockLogRepo
    });

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
   * 시계 보정 오프셋(ms). 실제 상태는 TimeService가 소유하며 여기서는 프록시만 제공합니다.
   * (하위 호환: 기존 코드가 manager.clockOffset을 직접 읽는 경우 대응)
   */
  get clockOffset() {
    return this.time.clockOffset;
  }

  set clockOffset(value) {
    this.time.clockOffset = value;
  }

  // ==========================================
  // Supabase 동기화 핵심 엔진 (하이브리드 캐시/동기화 모델)
  // ==========================================

  // -- 시간 관련 메서드는 TimeService에 위임합니다 (하위 호환용 프록시) ------------

  /** SQLite 날짜 포맷을 ISO8601 형식으로 변환 → TimeService.parseSqliteTime */
  parseSqliteTime(timeStr) {
    return this.time.parseSqliteTime(timeStr);
  }

  /** ISO8601을 SQLite 날짜 포맷으로 변환 → TimeService.formatToSqliteTime */
  formatToSqliteTime(isoTimeStr) {
    return this.time.formatToSqliteTime(isoTimeStr);
  }

  /** 로컬 SQLite UTC 시간 문자열 → epoch(ms) → TimeService.localTimeMs */
  localTimeMs(sqliteTimeStr) {
    return this.time.localTimeMs(sqliteTimeStr);
  }

  /** 원격 ISO8601 시간 문자열 → epoch(ms) → TimeService.remoteTimeMs */
  remoteTimeMs(isoTimeStr) {
    return this.time.remoteTimeMs(isoTimeStr);
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

  /** 서버-로컬 시계 오프셋 계산 → TimeService.calculateClockOffset */
  async calculateClockOffset(url, key) {
    return this.time.calculateClockOffset(url, key);
  }

  /** 시계 보정된 현재 SQLite 시간 문자열 → TimeService.getAdjustedSqliteTime */
  getAdjustedSqliteTime() {
    return this.time.getAdjustedSqliteTime();
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

  // ==========================================================================
  // 이하 메서드는 모두 Repository / Service 계층으로의 위임(delegation)입니다.
  // InventoryManager는 하위 호환용 Facade로서 기존 공개 API 시그니처를 그대로
  // 유지하며, 실제 구현은 각 담당 클래스에 있습니다. (Strangler Fig 패턴)
  // ==========================================================================

  /** 유한한 양수 검증 → utils/validators.assertPositiveAmount */
  assertPositiveAmount(value, label = '수량') {
    return assertPositiveAmount(value, label);
  }

  // -- 카테고리 관리 API → CategoryRepository ---------------------------------

  addCategory(name) {
    return this.categoryRepo.add(name);
  }

  updateCategory(categoryId, name) {
    return this.categoryRepo.update(categoryId, name);
  }

  deleteCategory(categoryId) {
    return this.categoryRepo.delete(categoryId);
  }

  getAllCategories() {
    return this.categoryRepo.getAll();
  }

  // -- 약재 관리 API → MedicineRepository -------------------------------------

  /** 약재 객체 기반 총 재고/표시 문자열 계산 (인메모리) */
  calculateStockInfo(med) {
    return this.medicineRepo.calculateStockInfo(med);
  }

  getTotalStock(medicineId) {
    return this.medicineRepo.getTotalStock(medicineId);
  }

  addMedicine(data) {
    return this.medicineRepo.add(data);
  }

  updateMedicine(medicineId, updateData) {
    return this.medicineRepo.update(medicineId, updateData);
  }

  deleteMedicine(medicineId) {
    return this.medicineRepo.delete(medicineId);
  }

  getAllMedicines() {
    return this.medicineRepo.getAll();
  }

  // -- 재고 증감 API → StockService -------------------------------------------

  /** 트랜잭션 없는 순수 로컬 차감 (상위 트랜잭션 내부 사용 전용) */
  consumeStockLocally(medicineId, consumeGrams, prescriptionId = null, note = '') {
    return this.stockService.consumeStockLocally(medicineId, consumeGrams, prescriptionId, note);
  }

  consumeStock(medicineId, consumeGrams, prescriptionId = null, note = '') {
    return this.stockService.consumeStock(medicineId, consumeGrams, prescriptionId, note);
  }

  adjustStock(medicineId, realPacks, realRemain) {
    return this.stockService.adjustStock(medicineId, realPacks, realRemain);
  }

  addStockLog(medicineId, type, quantity, note = '') {
    return this.stockService.addStockLog(medicineId, type, quantity, note);
  }

  /** 처방별 실제 차감량 집계 → StockLogRepository */
  getConsumedGramsByPrescription(prescriptionId) {
    return this.stockLogRepo.getConsumedGramsByPrescription(prescriptionId);
  }

  /** CONSUME 로그 집계 기반 재고 복원 (트랜잭션 내부 사용 전용) */
  restoreConsumedStockLocally(consumedRows) {
    return this.stockService.restoreConsumedStockLocally(consumedRows);
  }

  getLogsByMedicine(medicineId) {
    return this.stockLogRepo.getByMedicine(medicineId);
  }

  getAllLogs() {
    return this.stockLogRepo.getAll();
  }

  // -- 처방 관리 API → PrescriptionService / PrescriptionRepository ------------

  addPrescription(prescriptionName, patientName, items, note = '', isDeducted = true) {
    return this.prescriptionService.add(prescriptionName, patientName, items, note, isDeducted);
  }

  updatePrescriptionWithItems(prescriptionId, prescriptionName, patientName, items, note = '', isDeducted = true) {
    return this.prescriptionService.updateWithItems(prescriptionId, prescriptionName, patientName, items, note, isDeducted);
  }

  deletePrescription(prescriptionId) {
    return this.prescriptionService.delete(prescriptionId);
  }

  deductPrescriptionStock(prescriptionId) {
    return this.prescriptionService.deductStock(prescriptionId);
  }

  getPrescriptionDetails(prescriptionId) {
    return this.prescriptionRepo.getDetails(prescriptionId);
  }

  getAllPrescriptions() {
    return this.prescriptionRepo.getAll();
  }

  getRecentPrescriptions(limit = 5) {
    return this.prescriptionRepo.getRecent(limit);
  }

  searchPrescriptions(query, limit = 0) {
    return this.prescriptionRepo.search(query, limit);
  }

  // -- 알림함 API → NotificationRepository ------------------------------------

  getNotifications() {
    return this.notificationRepo.getAll();
  }

  markNotificationAsRead(id) {
    return this.notificationRepo.markAsRead(id);
  }

  deleteNotification(id) {
    return this.notificationRepo.delete(id);
  }

  // -- 처방 프리셋 관리 API → PresetRepository --------------------------------

  getAllPresets() {
    return this.presetRepo.getAll();
  }

  getPresetDetails(presetId) {
    return this.presetRepo.getDetails(presetId);
  }

  addPreset(presetName, note, items) {
    return this.presetRepo.add(presetName, note, items);
  }

  updatePreset(presetId, presetName, note, items) {
    return this.presetRepo.update(presetId, presetName, note, items);
  }

  deletePreset(presetId) {
    return this.presetRepo.delete(presetId);
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
