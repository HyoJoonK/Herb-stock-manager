/**
 * @file InventoryManager.js
 * @description 한의원 약재 재고 관리 데이터베이스 스키마 및 핵심 비즈니스 로직 구현 (SQLite 및 Supabase 클라우드 동기화 지원)
 */

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  throw new Error('better-sqlite3 패키지를 로드할 수 없습니다. 프로그램 구동을 위해서는 SQLite 인프라가 필수적입니다.');
}

let createClient;
try {
  const supabaseSdk = require('@supabase/supabase-js');
  createClient = supabaseSdk.createClient;
} catch (e) {
  console.warn('@supabase/supabase-js 패키지를 로드할 수 없습니다. 클라우드 동기화가 불가능합니다.');
}

class InventoryManager {
  /**
   * @param {string} dbPath 데이터베이스 파일 경로
   */
  constructor(dbPath = 'herb_inventory.db') {
    this.dbPath = dbPath;
    this.db = null;
    this.supabase = null; // Supabase 클라이언트 인스턴스
    this.clockOffset = 0;
    
    this.initDb();
  }

  /**
   * 데이터베이스 초기화 및 테이블 생성
   */
  initDb() {
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS medicines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          category_id INTEGER NOT NULL DEFAULT 1,
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
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prescription_name TEXT NOT NULL,
          patient_name TEXT NOT NULL,
          total_items INTEGER NOT NULL,
          note TEXT,
          is_deducted INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();

      // 만약 기존 테이블이 존재하여 note, is_deducted 컬럼이 없는 경우를 위한 안전장치 마이그레이션 실행
      try {
        this.db.prepare('ALTER TABLE prescriptions ADD COLUMN note TEXT').run();
      } catch (e) {
        // 이미 note 컬럼이 존재할 시 무시
      }

      try {
        this.db.prepare('ALTER TABLE prescriptions ADD COLUMN is_deducted INTEGER NOT NULL DEFAULT 1').run();
      } catch (e) {
        // 이미 is_deducted 컬럼이 존재할 시 무시
      }

      try {
        this.db.prepare('ALTER TABLE medicines ADD COLUMN memo TEXT').run();
      } catch (e) {
        // 이미 memo 컬럼이 존재할 시 무시
      }

      try {
        this.db.prepare('ALTER TABLE medicines ADD COLUMN is_presence_only INTEGER NOT NULL DEFAULT 0').run();
      } catch (e) {
        // 이미 is_presence_only 컬럼이 존재할 시 무시
      }

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          medicine_id INTEGER NOT NULL,
          medicine_name TEXT NOT NULL,
          message TEXT NOT NULL,
          is_read INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS stock_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          medicine_id INTEGER NOT NULL,
          type TEXT CHECK(type IN ('IN', 'CONSUME', 'WASTE', 'ADJUST')) NOT NULL,
          quantity REAL NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          prescription_id INTEGER,
          note TEXT,
          FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE,
          FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE SET NULL
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS prescription_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prescription_id INTEGER NOT NULL,
          medicine_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
          FOREIGN KEY(medicine_id) REFERENCES medicines(id)
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS medicine_aliases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          medicine_id INTEGER NOT NULL,
          alias TEXT UNIQUE NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
        )
      `).run();

      const exists = this.db.prepare('SELECT id FROM categories WHERE id = 1').get();
      if (!exists) {
        this.db.prepare("INSERT INTO categories (id, name) VALUES (1, '미분류')").run();
      }

      // Supabase 동기화 지원을 위한 삭제이력 테이블 생성 및 시간 컬럼 추가
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS deleted_records (
          table_name TEXT NOT NULL,
          record_id INTEGER NOT NULL,
          deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (table_name, record_id)
        )
      `).run();

      const tablesToMigration = ['categories', 'medicines', 'prescriptions'];
      tablesToMigration.forEach(table => {
        try {
          this.db.prepare(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`).run();
          this.db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE updated_at = ''`).run();
        } catch (e) {
          // 이미 컬럼이 존재할 시 무시
        }
      });

    } catch (err) {
      console.error('SQLite 초기화 실패:', err);
      throw err;
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
   * Supabase 클라이언트를 초기화하고 자동 동기화를 시작합니다.
   * @param {string} url Supabase Project URL
   * @param {string} key Supabase Anon Key
   * @returns {Promise<boolean>} 연결 성공 여부
   */
  async setupSupabase(url, key) {
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

      return true;
    } catch (err) {
      console.error('Supabase 연결 및 최초 동기화 설정 실패:', err);
      this.supabase = null;
      throw err;
    }
  }

  /**
   * Supabase 서버 시간과 로컬 클라이언트 시간 간의 오프셋(차이)을 계산합니다.
   */
  async calculateClockOffset(url, key) {
    this.clockOffset = 0;
    try {
      const start = Date.now();
      const res = await fetch(`${url}/rest/v1/?apikey=${key}`, { method: 'HEAD' });
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
   * 로컬 데이터의 updated_at과 원격 데이터의 updated_at을 비교하여 원격 데이터가 더 최신인지 확인합니다.
   * @param {string} table 테이블 이름
   * @param {number} id 레코드 ID
   * @param {string} remoteUpdatedAt 원격 updated_at 타임스탬프 (ISO 8601 형식)
   * @returns {boolean} 원격 데이터가 더 최신이거나 로컬 데이터가 없어서 덮어써야 하는 경우 true
   */
  shouldOverwriteWithRemote(table, id, remoteUpdatedAt) {
    if (!remoteUpdatedAt) return true;
    try {
      const local = this.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id);
      if (!local || !local.updated_at) return true;

      let localVal = local.updated_at.toString().trim();
      if (!localVal.includes('T') && localVal.includes(' ')) {
        localVal = localVal.replace(' ', 'T');
      }
      if (!localVal.endsWith('Z') && !localVal.includes('+')) {
        localVal += 'Z';
      }
      
      const localTime = new Date(localVal).getTime();
      const remoteTime = new Date(remoteUpdatedAt).getTime();
      
      return remoteTime > localTime;
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
   * 실시간 변경 데이터 처리 및 SQLite 반영
   */
  async handleRealtimeChange(payload) {
    const { table, eventType, new: newRow, old: oldRow } = payload;
    console.log(`[Supabase Realtime] 변경 감지 - 테이블: ${table}, 이벤트: ${eventType}`);

    try {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (table === 'categories') {
          if (this.shouldOverwriteWithRemote('categories', newRow.id, newRow.updated_at)) {
            const sqliteTime = this.formatToSqliteTime(newRow.updated_at);
            this.db.prepare(`
              INSERT INTO categories (id, name, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
            `).run(newRow.id, newRow.name, sqliteTime);
          }
        } else if (table === 'medicines') {
          if (this.shouldOverwriteWithRemote('medicines', newRow.id, newRow.updated_at)) {
            const sqliteTime = this.formatToSqliteTime(newRow.updated_at);
            this.db.prepare(`
              INSERT INTO medicines (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                category_id=excluded.category_id,
                pack_size=excluded.pack_size,
                unopened_packs=excluded.unopened_packs,
                opened_pack_remain=excluded.opened_pack_remain,
                safety_stock=excluded.safety_stock,
                unit=excluded.unit,
                memo=excluded.memo,
                is_presence_only=excluded.is_presence_only,
                updated_at=excluded.updated_at
            `).run(newRow.id, newRow.name, newRow.category_id, newRow.pack_size, newRow.unopened_packs, newRow.opened_pack_remain, newRow.safety_stock, newRow.unit, newRow.memo, newRow.is_presence_only, sqliteTime);
          }
        } else if (table === 'prescriptions') {
          if (this.shouldOverwriteWithRemote('prescriptions', newRow.id, newRow.updated_at)) {
            const cTime = this.formatToSqliteTime(newRow.created_at);
            const uTime = this.formatToSqliteTime(newRow.updated_at);
            this.db.prepare(`
              INSERT INTO prescriptions (id, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                prescription_name=excluded.prescription_name,
                patient_name=excluded.patient_name,
                total_items=excluded.total_items,
                note=excluded.note,
                is_deducted=excluded.is_deducted,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at
            `).run(newRow.id, newRow.prescription_name, newRow.patient_name, newRow.total_items, newRow.note, newRow.is_deducted, cTime, uTime);
          }
        } else if (table === 'prescription_items') {
          this.db.prepare(`
            INSERT INTO prescription_items (id, prescription_id, medicine_id, amount)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              prescription_id=excluded.prescription_id,
              medicine_id=excluded.medicine_id,
              amount=excluded.amount
          `).run(newRow.id, newRow.prescription_id, newRow.medicine_id, newRow.amount);
        } else if (table === 'stock_logs') {
          const sTime = this.formatToSqliteTime(newRow.timestamp);
          this.db.prepare(`
            INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              medicine_id=excluded.medicine_id,
              type=excluded.type,
              quantity=excluded.quantity,
              timestamp=excluded.timestamp,
              prescription_id=excluded.prescription_id,
              note=excluded.note
          `).run(newRow.id, newRow.medicine_id, newRow.type, newRow.quantity, sTime, newRow.prescription_id, newRow.note);
        } else if (table === 'medicine_aliases') {
          if (this.shouldOverwriteWithRemote('medicine_aliases', newRow.id, newRow.updated_at)) {
            const sqliteTime = this.formatToSqliteTime(newRow.updated_at);
            this.db.prepare(`
              INSERT INTO medicine_aliases (id, medicine_id, alias, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                medicine_id=excluded.medicine_id,
                alias=excluded.alias,
                updated_at=excluded.updated_at
            `).run(newRow.id, newRow.medicine_id, newRow.alias, sqliteTime);
          }
        }
      } else if (eventType === 'DELETE') {
        const deletedId = oldRow.id;
        if (table === 'categories') {
          this.db.prepare('DELETE FROM categories WHERE id = ?').run(deletedId);
        } else if (table === 'medicines') {
          this.db.prepare('DELETE FROM medicines WHERE id = ?').run(deletedId);
        } else if (table === 'prescriptions') {
          this.db.prepare('DELETE FROM prescriptions WHERE id = ?').run(deletedId);
        } else if (table === 'prescription_items') {
          this.db.prepare('DELETE FROM prescription_items WHERE id = ?').run(deletedId);
        } else if (table === 'stock_logs') {
          this.db.prepare('DELETE FROM stock_logs WHERE id = ?').run(deletedId);
        } else if (table === 'medicine_aliases') {
          this.db.prepare('DELETE FROM medicine_aliases WHERE id = ?').run(deletedId);
        }
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
      this.db.prepare('INSERT OR IGNORE INTO deleted_records (table_name, record_id) VALUES (?, ?)').run(table, id);
    } catch (e) {
      console.error('삭제 이력 기록 실패:', e);
    }
  }

  /**
   * 백그라운드로 특정 테이블의 특정 데이터를 Supabase에 Upsert (비동기)
   */
  async syncItemToSupabase(table, id) {
    if (!this.supabase) return;
    const recId = Number(id);

    try {
      let data = null;
      if (table === 'categories') {
        data = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(recId);
      } else if (table === 'medicines') {
        data = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(recId);
      } else if (table === 'prescriptions') {
        data = this.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(recId);
      } else if (table === 'stock_logs') {
        data = this.db.prepare('SELECT * FROM stock_logs WHERE id = ?').get(recId);
      } else if (table === 'medicine_aliases') {
        data = this.db.prepare('SELECT * FROM medicine_aliases WHERE id = ?').get(recId);
      }

      if (!data) return;

      const payload = { ...data };
      if (payload.updated_at) {
        payload.updated_at = this.parseSqliteTime(payload.updated_at);
      }
      if (payload.created_at) {
        payload.created_at = this.parseSqliteTime(payload.created_at);
      }
      if (payload.timestamp) {
        payload.timestamp = this.parseSqliteTime(payload.timestamp);
      }

      const { error } = await this.supabase.from(table).upsert(payload);
      if (error) throw error;
      console.log(`[Supabase Sync] ${table} (ID: ${recId}) 업로드 성공.`);
    } catch (err) {
      console.error(`[Supabase Sync] ${table} (ID: ${recId}) 업로드 실패:`, err.message);
    }
  }

  /**
   * 백그라운드로 삭제 이력을 Supabase에 전송 (비동기)
   */
  async syncDeletedToSupabase(table, id) {
    if (!this.supabase) return;
    const recId = Number(id);

    try {
      const { error } = await this.supabase.from(table).delete().eq('id', recId);
      if (error) throw error;
      
      this.db.prepare('DELETE FROM deleted_records WHERE table_name = ? AND record_id = ?').run(table, recId);
      console.log(`[Supabase Sync] ${table} (ID: ${recId}) 삭제 동기화 완료.`);
    } catch (err) {
      console.error(`[Supabase Sync] ${table} (ID: ${recId}) 삭제 동기화 실패:`, err.message);
    }
  }

  /**
   * 처방전 생성 시 처방과 처방 아이템을 한꺼번에 동기화
   */
  async syncPrescriptionToSupabase(prescId) {
    if (!this.supabase) return;
    const pId = Number(prescId);

    try {
      await this.syncItemToSupabase('prescriptions', pId);

      const items = this.db.prepare('SELECT * FROM prescription_items WHERE prescription_id = ?').all(pId);
      if (items && items.length > 0) {
        const { error } = await this.supabase.from('prescription_items').upsert(items);
        if (error) throw error;
      }
      console.log(`[Supabase Sync] 처방전 ${pId} 및 하위 항목 동기화 완료.`);
    } catch (err) {
      console.error(`[Supabase Sync] 처방전 ${pId} 동기화 실패:`, err.message);
    }
  }

  /**
   * 전체 양방향 동기화 작업 (Last-Write-Wins 타임스탬프 비교 기반) - 벌크(Bulk) 처리 최적화 적용
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
          const transaction = this.db.transaction(() => {
            const allowedTables = ['categories', 'medicines', 'prescriptions', 'prescription_items', 'stock_logs', 'medicine_aliases'];
            for (const row of remoteDeleted) {
              if (allowedTables.includes(row.table_name)) {
                this.db.prepare(`DELETE FROM ${row.table_name} WHERE id = ?`).run(row.record_id);
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
        await this.syncDeletedToSupabase(row.table_name, row.record_id);
      }

      // 2. categories 동기화
      const localCats = this.db.prepare('SELECT * FROM categories').all();
      const { data: remoteCats, error: errCats } = await this.supabase.from('categories').select('*');
      if (errCats) throw errCats;

      const remoteCatsMap = new Map(remoteCats.map(c => [c.id, c]));

      const catsToRemote = [];
      for (const lc of localCats) {
        const rc = remoteCatsMap.get(lc.id);
        const localTime = new Date(this.parseSqliteTime(lc.updated_at)).getTime();
        
        if (!rc || localTime > new Date(rc.updated_at).getTime()) {
          catsToRemote.push({
            id: lc.id,
            name: lc.name,
            updated_at: this.parseSqliteTime(lc.updated_at)
          });
        }
      }
      if (catsToRemote.length > 0) {
        const { error: upsertErr } = await this.supabase.from('categories').upsert(catsToRemote);
        if (upsertErr) throw upsertErr;
        console.log(`[Supabase Sync] categories ${catsToRemote.length}건 업로드 성공.`);
      }

      const localCatsMap = new Map(localCats.map(c => [c.id, c]));
      const catsToLocal = [];
      for (const rc of remoteCats) {
        const lc = localCatsMap.get(rc.id);
        const remoteTime = new Date(rc.updated_at).getTime();

        if (!lc || remoteTime > new Date(lc.updated_at).getTime()) {
          catsToLocal.push(rc);
        }
      }
      if (catsToLocal.length > 0) {
        const transaction = this.db.transaction(() => {
          const stmt = this.db.prepare(`
            INSERT INTO categories (id, name, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
          `);
          for (const rc of catsToLocal) {
            const sqliteTime = this.formatToSqliteTime(rc.updated_at);
            stmt.run(rc.id, rc.name, sqliteTime);
          }
        });
        transaction();
        console.log(`[Supabase Sync] categories ${catsToLocal.length}건 다운로드 적용 완료.`);
      }

      // 3. medicines 동기화
      const localMeds = this.db.prepare('SELECT * FROM medicines').all();
      const { data: remoteMeds, error: errMeds } = await this.supabase.from('medicines').select('*');
      if (errMeds) throw errMeds;

      const remoteMedsMap = new Map(remoteMeds.map(m => [m.id, m]));

      const medsToRemote = [];
      for (const lm of localMeds) {
        const rm = remoteMedsMap.get(lm.id);
        const localTime = new Date(this.parseSqliteTime(lm.updated_at)).getTime();

        if (!rm || localTime > new Date(rm.updated_at).getTime()) {
          medsToRemote.push({
            id: lm.id,
            name: lm.name,
            category_id: lm.category_id,
            pack_size: lm.pack_size,
            unopened_packs: lm.unopened_packs,
            opened_pack_remain: lm.opened_pack_remain,
            safety_stock: lm.safety_stock,
            unit: lm.unit,
            memo: lm.memo,
            is_presence_only: lm.is_presence_only,
            updated_at: this.parseSqliteTime(lm.updated_at)
          });
        }
      }
      if (medsToRemote.length > 0) {
        const { error: upsertErr } = await this.supabase.from('medicines').upsert(medsToRemote);
        if (upsertErr) throw upsertErr;
        console.log(`[Supabase Sync] medicines ${medsToRemote.length}건 업로드 성공.`);
      }

      const localMedsMap = new Map(localMeds.map(m => [m.id, m]));
      const medsToLocal = [];
      for (const rm of remoteMeds) {
        const lm = localMedsMap.get(rm.id);
        const remoteTime = new Date(rm.updated_at).getTime();

        if (!lm || remoteTime > new Date(lm.updated_at).getTime()) {
          medsToLocal.push(rm);
        }
      }
      if (medsToLocal.length > 0) {
        const transaction = this.db.transaction(() => {
          const stmt = this.db.prepare(`
            INSERT INTO medicines (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              category_id=excluded.category_id,
              pack_size=excluded.pack_size,
              unopened_packs=excluded.unopened_packs,
              opened_pack_remain=excluded.opened_pack_remain,
              safety_stock=excluded.safety_stock,
              unit=excluded.unit,
              memo=excluded.memo,
              is_presence_only=excluded.is_presence_only,
              updated_at=excluded.updated_at
          `);
          for (const rm of medsToLocal) {
            const sqliteTime = this.formatToSqliteTime(rm.updated_at);
            stmt.run(rm.id, rm.name, rm.category_id, rm.pack_size, rm.unopened_packs, rm.opened_pack_remain, rm.safety_stock, rm.unit, rm.memo, rm.is_presence_only, sqliteTime);
          }
        });
        transaction();
        console.log(`[Supabase Sync] medicines ${medsToLocal.length}건 다운로드 적용 완료.`);
      }

      // 4. prescriptions 및 prescription_items 동기화
      const localPrescs = this.db.prepare('SELECT * FROM prescriptions').all();
      const { data: remotePrescs, error: errPrescs } = await this.supabase.from('prescriptions').select('*');
      if (errPrescs) throw errPrescs;

      const remotePrescsMap = new Map(remotePrescs.map(p => [p.id, p]));

      const prescsToRemote = [];
      const prescItemsToRemote = [];
      for (const lp of localPrescs) {
        const rp = remotePrescsMap.get(lp.id);
        const localTime = new Date(this.parseSqliteTime(lp.updated_at)).getTime();

        if (!rp || localTime > new Date(rp.updated_at).getTime()) {
          prescsToRemote.push({
            id: lp.id,
            prescription_name: lp.prescription_name,
            patient_name: lp.patient_name,
            total_items: lp.total_items,
            note: lp.note,
            is_deducted: lp.is_deducted,
            created_at: this.parseSqliteTime(lp.created_at),
            updated_at: this.parseSqliteTime(lp.updated_at)
          });
          
          const items = this.db.prepare('SELECT * FROM prescription_items WHERE prescription_id = ?').all(lp.id);
          if (items && items.length > 0) {
            prescItemsToRemote.push(...items);
          }
        }
      }
      if (prescsToRemote.length > 0) {
        const { error: insErr } = await this.supabase.from('prescriptions').upsert(prescsToRemote);
        if (insErr) throw insErr;
        console.log(`[Supabase Sync] prescriptions ${prescsToRemote.length}건 업로드 성공.`);
      }
      if (prescItemsToRemote.length > 0) {
        const { error: insErr } = await this.supabase.from('prescription_items').upsert(prescItemsToRemote);
        if (insErr) throw insErr;
        console.log(`[Supabase Sync] prescription_items ${prescItemsToRemote.length}건 업로드 성공.`);
      }

      const localPrescsMap = new Map(localPrescs.map(p => [p.id, p]));
      const prescsToLocal = [];
      for (const rp of remotePrescs) {
        const lp = localPrescsMap.get(rp.id);
        const remoteTime = new Date(rp.updated_at).getTime();

        if (!lp || remoteTime > new Date(this.parseSqliteTime(lp.updated_at)).getTime()) {
          prescsToLocal.push(rp);
        }
      }
      if (prescsToLocal.length > 0) {
        const transaction = this.db.transaction(() => {
          const stmt = this.db.prepare(`
            INSERT INTO prescriptions (id, prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              prescription_name=excluded.prescription_name,
              patient_name=excluded.patient_name,
              total_items=excluded.total_items,
              note=excluded.note,
              is_deducted=excluded.is_deducted,
              created_at=excluded.created_at,
              updated_at=excluded.updated_at
          `);
          for (const rp of prescsToLocal) {
            const cTime = this.formatToSqliteTime(rp.created_at);
            const uTime = this.formatToSqliteTime(rp.updated_at);
            stmt.run(rp.id, rp.prescription_name, rp.patient_name, rp.total_items, rp.note, rp.is_deducted, cTime, uTime);
          }
        });
        transaction();

        const ids = prescsToLocal.map(p => p.id);
        const { data: rItems, error: rItemsErr } = await this.supabase.from('prescription_items').select('*').in('prescription_id', ids);
        if (!rItemsErr && rItems && rItems.length > 0) {
          const itemTx = this.db.transaction(() => {
            const itemStmt = this.db.prepare(`
              INSERT INTO prescription_items (id, prescription_id, medicine_id, amount)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                prescription_id=excluded.prescription_id,
                medicine_id=excluded.medicine_id,
                amount=excluded.amount
            `);
            for (const rit of rItems) {
              itemStmt.run(rit.id, rit.prescription_id, rit.medicine_id, rit.amount);
            }
          });
          itemTx();
        }
        console.log(`[Supabase Sync] prescriptions ${prescsToLocal.length}건 및 하위 품목 다운로드 완료.`);
      }

      // 5. stock_logs 동기화
      const localLogs = this.db.prepare('SELECT * FROM stock_logs').all();
      const { data: remoteLogs, error: errLogs } = await this.supabase.from('stock_logs').select('*');
      if (errLogs) throw errLogs;

      const remoteLogsMap = new Map(remoteLogs.map(l => [l.id, l]));

      const logsToRemote = [];
      for (const ll of localLogs) {
        const rl = remoteLogsMap.get(ll.id);
        if (!rl) {
          logsToRemote.push({
            id: ll.id,
            medicine_id: ll.medicine_id,
            type: ll.type,
            quantity: ll.quantity,
            timestamp: this.parseSqliteTime(ll.timestamp),
            prescription_id: ll.prescription_id,
            note: ll.note
          });
        }
      }
      if (logsToRemote.length > 0) {
        const { error: insErr } = await this.supabase.from('stock_logs').insert(logsToRemote);
        if (insErr) throw insErr;
        console.log(`[Supabase Sync] stock_logs ${logsToRemote.length}건 업로드 성공.`);
      }

      const localLogsMap = new Map(localLogs.map(l => [l.id, l]));
      const logsToLocal = [];
      for (const rl of remoteLogs) {
        const ll = localLogsMap.get(rl.id);
        if (!ll) {
          logsToLocal.push(rl);
        }
      }
      if (logsToLocal.length > 0) {
        const transaction = this.db.transaction(() => {
          const stmt = this.db.prepare(`
            INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const rl of logsToLocal) {
            const sTime = this.formatToSqliteTime(rl.timestamp);
            stmt.run(rl.id, rl.medicine_id, rl.type, rl.quantity, sTime, rl.prescription_id, rl.note);
          }
        });
        transaction();
        console.log(`[Supabase Sync] stock_logs ${logsToLocal.length}건 다운로드 완료.`);
      }

      // 5.5. medicine_aliases 동기화
      const localAliases = this.db.prepare('SELECT * FROM medicine_aliases').all();
      const { data: remoteAliases, error: errAliases } = await this.supabase.from('medicine_aliases').select('*');
      if (errAliases) throw errAliases;

      const remoteAliasesMap = new Map(remoteAliases.map(a => [a.id, a]));

      const aliasesToRemote = [];
      for (const la of localAliases) {
        const ra = remoteAliasesMap.get(la.id);
        const localTime = new Date(this.parseSqliteTime(la.updated_at)).getTime();

        if (!ra || localTime > new Date(ra.updated_at).getTime()) {
          aliasesToRemote.push({
            id: la.id,
            medicine_id: la.medicine_id,
            alias: la.alias,
            updated_at: this.parseSqliteTime(la.updated_at)
          });
        }
      }
      if (aliasesToRemote.length > 0) {
        const { error: upsertErr } = await this.supabase.from('medicine_aliases').upsert(aliasesToRemote);
        if (upsertErr) throw upsertErr;
        console.log(`[Supabase Sync] medicine_aliases ${aliasesToRemote.length}건 업로드 성공.`);
      }

      const localAliasesMap = new Map(localAliases.map(a => [a.id, a]));
      const aliasesToLocal = [];
      for (const ra of remoteAliases) {
        const la = localAliasesMap.get(ra.id);
        const remoteTime = new Date(ra.updated_at).getTime();

        if (!la || remoteTime > new Date(la.updated_at).getTime()) {
          aliasesToLocal.push(ra);
        }
      }
      if (aliasesToLocal.length > 0) {
        const transaction = this.db.transaction(() => {
          const stmt = this.db.prepare(`
            INSERT INTO medicine_aliases (id, medicine_id, alias, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              medicine_id=excluded.medicine_id,
              alias=excluded.alias,
              updated_at=excluded.updated_at
          `);
          for (const ra of aliasesToLocal) {
            const sqliteTime = this.formatToSqliteTime(ra.updated_at);
            stmt.run(ra.id, ra.medicine_id, ra.alias, sqliteTime);
          }
        });
        transaction();
        console.log(`[Supabase Sync] medicine_aliases ${aliasesToLocal.length}건 다운로드 적용 완료.`);
      }

      console.log('[Supabase Sync] 양방향 전체 벌크 동기화 완료!');
    } catch (err) {
      console.error('[Supabase Sync] 동기화 오류 발생:', err);
    }
  }

  // ==========================================
  // 카테고리 관리 API
  // ==========================================

  addCategory(name) {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('카테고리명은 비어둘 수 없습니다.');

    try {
      const exists = this.db.prepare('SELECT id FROM categories WHERE name = ?').get(cleanName);
      if (exists) return exists.id;

      const stmt = this.db.prepare("INSERT INTO categories (name, updated_at) VALUES (?, ?)");
      const result = stmt.run(cleanName, this.getAdjustedSqliteTime());
      const newId = result.lastInsertRowid;
      
      this.syncItemToSupabase('categories', newId).catch(err => console.error('[Supabase Sync Error] categories:', err));
      
      return newId;
    } catch (err) {
      throw err;
    }
  }

  updateCategory(categoryId, name) {
    const catId = Number(categoryId);
    if (catId === 1) throw new Error('기본 카테고리는 수정할 수 없습니다.');

    const cleanName = name.trim();
    if (!cleanName) throw new Error('카테고리명은 비어둘 수 없습니다.');

    try {
      const exists = this.db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(cleanName, catId);
      if (exists) throw new Error('이미 존재하는 카테고리명입니다.');

      this.db.prepare("UPDATE categories SET name = ?, updated_at = ? WHERE id = ?").run(cleanName, this.getAdjustedSqliteTime(), catId);

      this.syncItemToSupabase('categories', catId).catch(err => console.error('[Supabase Sync Error] update categories:', err));
    } catch (err) {
      throw err;
    }
  }

  deleteCategory(categoryId) {
    const catId = Number(categoryId);
    if (catId === 1) throw new Error('기본 카테고리는 삭제할 수 없습니다.');

    try {
      const medicineIds = this.db.prepare('SELECT id FROM medicines WHERE category_id = ?').all(catId).map(row => row.id);

      this.db.transaction(() => {
        this.recordDeleted('categories', catId);
        this.db.prepare('DELETE FROM categories WHERE id = ?').run(catId);
        this.db.prepare("UPDATE medicines SET category_id = 1, updated_at = ? WHERE category_id = ?").run(this.getAdjustedSqliteTime(), catId);
      })();

      this.syncDeletedToSupabase('categories', catId).catch(err => console.error('[Supabase Sync Error] delete categories:', err));
      
      for (const medId of medicineIds) {
        this.syncItemToSupabase('medicines', medId).catch(err => console.error('[Supabase Sync Error] update medicines after category delete:', err));
      }
    } catch (err) {
      throw err;
    }
  }

  getAllCategories() {
    return this.db.prepare('SELECT * FROM categories ORDER BY id ASC').all();
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
    `).get(medicineId);

    if (!med) {
      throw new Error(`약재 ID ${medicineId}를 찾을 수 없습니다.`);
    }

    const stockInfo = this.calculateStockInfo(med);
    const aliases = this.db.prepare('SELECT alias FROM medicine_aliases WHERE medicine_id = ?').all(medicineId).map(row => row.alias);

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

    const catId = Number(category_id || 1);

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

    let newId = 0;
    const insertedAliasIds = [];

    const transaction = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO medicines (name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, memo, is_presence_only, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
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
      newId = result.lastInsertRowid;

      if (aliases && aliases.length > 0) {
        const aliasStmt = this.db.prepare(`
          INSERT INTO medicine_aliases (medicine_id, alias, updated_at)
          VALUES (?, ?, ?)
        `);
        for (const alias of aliases) {
          const cleanAlias = alias.trim();
          if (!cleanAlias) continue;
          const res = aliasStmt.run(newId, cleanAlias, this.getAdjustedSqliteTime());
          insertedAliasIds.push(res.lastInsertRowid);
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
    const medId = Number(medicineId);
    
    const execute = (med) => {
      const oldTotal = (med.unopened_packs * med.pack_size) + med.opened_pack_remain;

      const name = updateData.name !== undefined ? updateData.name : med.name;
      const category_id = updateData.category_id !== undefined ? Number(updateData.category_id) : med.category_id;
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
      let loss = 0;
      if (is_presence_only === 0 && med.is_presence_only === 0) {
        loss = ((unopened_packs - med.unopened_packs) * pack_size) + (opened_pack_remain - med.opened_pack_remain);
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
    let insertedLogId = 0;
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
        const resLog = this.db.prepare(`
          INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, note)
          VALUES (?, 'ADJUST', ?, ?, ?)
        `).run(medId, loss, this.getAdjustedSqliteTime(), `수동 데이터 보정 (오차: ${loss > 0 ? '+' : ''}${loss}g)`);
        insertedLogId = resLog.lastInsertRowid;
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
          INSERT INTO medicine_aliases (medicine_id, alias, updated_at)
          VALUES (?, ?, ?)
        `);
        for (const alias of toInsert) {
          const res = insertStmt.run(medId, alias, this.getAdjustedSqliteTime());
          insertedAliasIds.push(res.lastInsertRowid);
        }
      }
    });

    try {
      transaction();

      // medicines 업로드가 완료된 후 외래 키 참조 관계에 있는 stock_logs와 medicine_aliases를 동기화하여 에러를 방지합니다.
      this.syncItemToSupabase('medicines', medId)
        .then(() => {
          if (insertedLogId > 0) {
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
    try {
      const itemIds = this.db.prepare('SELECT id FROM prescription_items WHERE medicine_id = ?').all(medicineId).map(row => row.id);
      const logIds = this.db.prepare('SELECT id FROM stock_logs WHERE medicine_id = ?').all(medicineId).map(row => row.id);
      const aliasIds = this.db.prepare('SELECT id FROM medicine_aliases WHERE medicine_id = ?').all(medicineId).map(row => row.id);

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
        this.recordDeleted('medicines', medicineId);

        this.db.prepare('DELETE FROM prescription_items WHERE medicine_id = ?').run(medicineId);
        this.db.prepare('DELETE FROM stock_logs WHERE medicine_id = ?').run(medicineId);
        this.db.prepare('DELETE FROM medicine_aliases WHERE medicine_id = ?').run(medicineId);
        this.db.prepare('DELETE FROM medicines WHERE id = ?').run(medicineId);
      })();

      for (const itemId of itemIds) {
        this.syncDeletedToSupabase('prescription_items', itemId).catch(err => console.error('[Supabase Sync Error] delete prescription_items:', err));
      }
      for (const logId of logIds) {
        this.syncDeletedToSupabase('stock_logs', logId).catch(err => console.error('[Supabase Sync Error] delete stock_logs:', err));
      }
      for (const aliasId of aliasIds) {
        this.syncDeletedToSupabase('medicine_aliases', aliasId).catch(err => console.error('[Supabase Sync Error] delete medicine_aliases:', err));
      }
      this.syncDeletedToSupabase('medicines', medicineId).catch(err => console.error('[Supabase Sync Error] delete medicines:', err));

      return true;
    } catch (err) {
      throw err;
    }
  }

  /**
   * 처방전 취소 및 삭제 (재고 자동 롤백 포함)
   */
  deletePrescription(prescriptionId) {
    const pId = Number(prescriptionId);
    try {
      const items = this.db.prepare('SELECT id, medicine_id, amount FROM prescription_items WHERE prescription_id = ?').all(pId);
      const logs = this.db.prepare('SELECT id FROM stock_logs WHERE prescription_id = ?').all(pId);

      this.db.transaction(() => {
        for (const item of items) {
          const med = this.db.prepare('SELECT unopened_packs, opened_pack_remain, pack_size, is_presence_only FROM medicines WHERE id = ?').get(item.medicine_id);
          if (med) {
            if (med.is_presence_only === 1) {
              continue; // 단순 유무 관리 약재는 롤백하지 않음
            }
            let newRemain = med.opened_pack_remain + item.amount;
            let newPacks = med.unopened_packs;
            if (newRemain >= med.pack_size) {
              const extraPacks = Math.floor(newRemain / med.pack_size);
              newPacks += extraPacks;
              newRemain = newRemain % med.pack_size;
            }
            this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ? WHERE id = ?')
              .run(newPacks, newRemain, this.getAdjustedSqliteTime(), item.medicine_id);
          }
        }

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
            // 원격 삭제 및 트리거 처리가 완료되어 Supabase 재고 복원이 끝난 후, 최종 medicines 상태를 로컬 정보로 업로드
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
    } catch (err) {
      throw err;
    }
  }

  /**
   * 처방 정보 및 포함 약재 목록/수량 전면 수정 (재고 복원 및 재소모)
   */
  updatePrescriptionWithItems(prescriptionId, prescriptionName, patientName, items, note = '', isDeducted = true) {
    const pId = Number(prescriptionId);
    if (!items || items.length === 0) {
      throw new Error('처방전에 약재가 포함되어야 합니다.');
    }

    try {
      const presc = this.db.prepare('SELECT is_deducted FROM prescriptions WHERE id = ?').get(pId);
      const wasDeducted = presc ? presc.is_deducted === 1 : false;

      const oldItems = this.db.prepare('SELECT id, medicine_id, amount FROM prescription_items WHERE prescription_id = ?').all(pId);
      const oldLogs = this.db.prepare('SELECT id FROM stock_logs WHERE prescription_id = ?').all(pId);

      const newLogIdsToSync = [];
      const deductedVal = isDeducted ? 1 : 0;

      this.db.transaction(() => {
        // 기존에 차감되었던 처방전인 경우에만 기존 재고 복원 수행
        if (wasDeducted) {
          for (const oldItem of oldItems) {
            const med = this.db.prepare('SELECT unopened_packs, opened_pack_remain, pack_size FROM medicines WHERE id = ?').get(oldItem.medicine_id);
            if (med) {
              let newRemain = med.opened_pack_remain + oldItem.amount;
              let newPacks = med.unopened_packs;
              if (newRemain >= med.pack_size) {
                const extraPacks = Math.floor(newRemain / med.pack_size);
                newPacks += extraPacks;
                newRemain = newRemain % med.pack_size;
              }
              this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ? WHERE id = ?')
                .run(newPacks, newRemain, this.getAdjustedSqliteTime(), oldItem.medicine_id);
            }
          }
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
          INSERT INTO prescription_items (prescription_id, medicine_id, amount)
          VALUES (?, ?, ?)
        `);

        for (const item of items) {
          itemStmt.run(pId, item.medicineId, item.amount);
          if (isDeducted) {
            const logId = this.consumeStockLocally(item.medicineId, item.amount, pId, `${prescriptionName} 처방 (${patientName})`);
            if (logId > 0) {
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
              medIdsToSync.add(item.medicineId);
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
    } catch (err) {
      throw err;
    }
  }

  // ==========================================
  // 기존 재고 제어 비즈니스 로직
  // ==========================================

  /**
   * 트랜잭션을 시작하지 않는 순수 로컬 SQLite 차감 메서드 (중첩 트랜잭션 방지용)
   */
  consumeStockLocally(medicineId, consumeGrams, prescriptionId = null, note = '') {
    const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId);
    if (!med) throw new Error('약재를 찾을 수 없습니다.');

    // 단순 유무 관리 약재는 처방 시 실제 재고를 차감하지는 않으나, 처방 내역 자체는 변동량 0으로 기록합니다.
    if (med.is_presence_only === 1) {
      const resLog = this.db.prepare(`
        INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, prescription_id, note)
        VALUES (?, 'CONSUME', 0, ?, ?, ?)
      `).run(medicineId, this.getAdjustedSqliteTime(), prescriptionId, note || '처방 소모');
      return resLog.lastInsertRowid;
    }

    const { unopened_packs, pack_size, opened_pack_remain } = med;
    const totalStock = (unopened_packs * pack_size) + opened_pack_remain;

    if (totalStock < consumeGrams) {
      throw new Error(`재고가 부족합니다. (필요: ${consumeGrams}g, 현재: ${totalStock}g)`);
    }

    let currentRemain = opened_pack_remain;
    let currentUnopened = unopened_packs;
    let needed = consumeGrams;

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
          medicineId,
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
    `).run(currentUnopened, currentRemain, this.getAdjustedSqliteTime(), medicineId);

    const resLog = this.db.prepare(`
      INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, prescription_id, note)
      VALUES (?, 'CONSUME', ?, ?, ?, ?)
    `).run(medicineId, -consumeGrams, this.getAdjustedSqliteTime(), prescriptionId, note || '처방 소모');
    
    return resLog.lastInsertRowid;
  }

  consumeStock(medicineId, consumeGrams, prescriptionId = null, note = '') {
    if (consumeGrams <= 0) {
      throw new Error('소모량은 0보다 커야 합니다.');
    }

    let logId = 0;
    const transaction = this.db.transaction(() => {
      logId = this.consumeStockLocally(medicineId, consumeGrams, prescriptionId, note);
    });
    transaction();

    if (logId > 0) {
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
    let logId = 0;
    const transaction = this.db.transaction(() => {
      const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId);
      if (!med) throw new Error('약재를 찾을 수 없습니다.');

      if (type === 'IN') {
        const packs = Math.floor(quantity / med.pack_size);
        const remain = quantity % med.pack_size;
        
        let newPacks = med.unopened_packs + packs;
        let newRemain = med.opened_pack_remain + remain;
        if (newRemain >= med.pack_size) {
          newPacks += 1;
          newRemain -= med.pack_size;
        }
        
        this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ?, updated_at = ? WHERE id = ?')
          .run(newPacks, newRemain, this.getAdjustedSqliteTime(), medicineId);

        const resLog = this.db.prepare('INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, note) VALUES (?, ?, ?, ?, ?)')
          .run(medicineId, type, quantity, this.getAdjustedSqliteTime(), note);
        logId = resLog.lastInsertRowid;
      } else if (type === 'WASTE') {
        logId = this.consumeStockLocally(medicineId, Math.abs(quantity), null, note || '재고 폐기');
      }
    });
    transaction();

    if (logId > 0) {
      this.syncItemToSupabase('stock_logs', logId).catch(err => console.error('[Supabase Sync Error] stock_logs:', err));
    }
    this.syncItemToSupabase('medicines', medicineId).catch(err => console.error('[Supabase Sync Error] medicines:', err));
  }

  addPrescription(prescriptionName, patientName, items, note = '', isDeducted = true) {
    if (!items || items.length === 0) {
      throw new Error('처방전에 약재가 포함되어야 합니다.');
    }

    let pId = 0;
    const logIdsToSync = [];
    const deductedVal = isDeducted ? 1 : 0;

    const transaction = this.db.transaction(() => {
      const nowTime = this.getAdjustedSqliteTime();
      const stmt = this.db.prepare(`
        INSERT INTO prescriptions (prescription_name, patient_name, total_items, note, is_deducted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const res = stmt.run(prescriptionName, patientName, items.length, note, deductedVal, nowTime, nowTime);
      pId = res.lastInsertRowid;

      const itemStmt = this.db.prepare(`
        INSERT INTO prescription_items (prescription_id, medicine_id, amount)
        VALUES (?, ?, ?)
      `);

      for (const item of items) {
        itemStmt.run(pId, item.medicineId, item.amount);
        if (isDeducted) {
          const logId = this.consumeStockLocally(item.medicineId, item.amount, pId, `${prescriptionName} 처방 (${patientName})`);
          if (logId > 0) {
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
          // stock_logs 업로드 완료로 Supabase 트리거가 돌고 난 후, 최종 medicines 업로드
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
    const pId = Number(prescriptionId);
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
    const medId = Number(medicineId);
    return this.db.prepare(`
      SELECT l.*, m.name as medicine_name 
      FROM stock_logs l
      JOIN medicines m ON l.medicine_id = m.id
      WHERE l.medicine_id = ?
      ORDER BY l.timestamp DESC, l.id DESC
    `).all(medId);
  }

  getAllLogs() {
    return this.db.prepare(`
      SELECT l.*, m.name as medicine_name 
      FROM stock_logs l
      JOIN medicines m ON l.medicine_id = m.id
      ORDER BY l.timestamp DESC, l.id DESC
    `).all();
  }

  getAllPrescriptions() {
    return this.db.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC, id DESC').all();
  }

  searchPrescriptions(query) {
    if (!query || query.trim() === '') {
      return this.getAllPrescriptions();
    }
    const likeQuery = `%${query.trim()}%`;
    return this.db.prepare(`
      SELECT DISTINCT p.* 
      FROM prescriptions p
      LEFT JOIN prescription_items pi ON p.id = pi.prescription_id
      LEFT JOIN medicines m ON pi.medicine_id = m.id
      WHERE p.prescription_name LIKE ?
         OR p.patient_name LIKE ?
         OR m.name LIKE ?
      ORDER BY p.created_at DESC, p.id DESC
    `).all(likeQuery, likeQuery, likeQuery);
  }

  deductPrescriptionStock(prescriptionId) {
    const pId = Number(prescriptionId);
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
        const logId = this.consumeStockLocally(item.medicine_id, item.amount, pId, `${presc.prescription_name} 처방 (${presc.patient_name})`);
        if (logId > 0) {
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
}

if (typeof module !== 'undefined') {
  module.exports = InventoryManager;
}
