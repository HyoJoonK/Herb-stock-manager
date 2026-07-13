/**
 * @file InventoryManager.js
 * @description 한의원 약재 재고 관리 데이터베이스 스키마 및 핵심 비즈니스 로직 구현 (SQLite/Mock 하이브리드 지원 및 Supabase 클라우드 동기화 추가)
 * 4차 변경: Supabase 백그라운드 양방향 동기화 및 팝업 설정 연동
 */

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('better-sqlite3 패키지를 로드할 수 없습니다. 메모리 내장 Mock DB 모드로 대체 구동합니다.');
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
    this.isMock = !Database;
    this.db = null;
    this.supabase = null; // Supabase 클라이언트 인스턴스
    
    this.mockData = {
      categories: [
        { id: 1, name: '미분류' }
      ],
      medicines: [],
      stock_logs: [],
      prescriptions: [],
      prescription_items: []
    };
    
    // SQLite 파일 경로를 바탕으로 모의 데이터 백업 경로 생성
    this.mockPath = this.dbPath.replace(/\.db$/, '') + '_mock.json';
    
    this.initDb();
  }

  /**
   * Mock 데이터를 로컬 JSON 파일에 저장
   */
  saveMockData() {
    if (this.isMock) {
      try {
        const fs = require('fs');
        fs.writeFileSync(this.mockPath, JSON.stringify(this.mockData, null, 2), 'utf8');
      } catch (err) {
        console.error('Mock 데이터 저장 실패:', err);
      }
    }
  }

  /**
   * 데이터베이스 초기화 및 테이블 생성
   */
  initDb() {
    if (!this.isMock) {
      try {
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
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
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
            CHECK(pack_size > 0),
            CHECK(unopened_packs >= 0),
            CHECK(opened_pack_remain >= 0),
            CHECK(safety_stock >= 0),
            FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET DEFAULT
          )
        `).run();

        // prescriptions 스키마 변경: note TEXT 컬럼 탑재 (메모 기능 지원)
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS prescriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prescription_name TEXT NOT NULL,
            patient_name TEXT NOT NULL,
            total_items INTEGER NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
          )
        `).run();

        // 만약 기존 테이블이 존재하여 note 컬럼이 없는 경우를 위한 안전장치 마이그레이션 실행
        try {
          this.db.prepare('ALTER TABLE prescriptions ADD COLUMN note TEXT').run();
        } catch (e) {
          // 이미 note 컬럼이 존재할 시 무시
        }

        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS stock_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            medicine_id INTEGER NOT NULL,
            type TEXT CHECK(type IN ('IN', 'CONSUME', 'WASTE', 'ADJUST')) NOT NULL,
            quantity REAL NOT NULL,
            timestamp TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
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

        const exists = this.db.prepare('SELECT id FROM categories WHERE id = 1').get();
        if (!exists) {
          this.db.prepare("INSERT INTO categories (id, name) VALUES (1, '미분류')").run();
        }

        // 4차 변경: Supabase 동기화 지원을 위한 삭제이력 테이블 생성 및 시간 컬럼 추가
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS deleted_records (
            table_name TEXT NOT NULL,
            record_id INTEGER NOT NULL,
            deleted_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
            PRIMARY KEY (table_name, record_id)
          )
        `).run();

        const tablesToMigration = ['categories', 'medicines', 'prescriptions'];
        tablesToMigration.forEach(table => {
          try {
            this.db.prepare(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`).run();
            this.db.prepare(`UPDATE ${table} SET updated_at = datetime('now', 'utc') WHERE updated_at = ''`).run();
          } catch (e) {
            // 이미 컬럼이 존재할 시 무시
          }
        });

      } catch (err) {
        console.error('SQLite 초기화 실패, Mock 모드로 강제 전환합니다:', err);
        this.isMock = true;
      }
    }

    if (this.isMock) {
      try {
        const fs = require('fs');
        if (fs.existsSync(this.mockPath)) {
          const data = fs.readFileSync(this.mockPath, 'utf8');
          this.mockData = JSON.parse(data);
          console.log('기존 Mock 백업 데이터베이스를 로드했습니다:', this.mockPath);
        } else {
          this.saveMockData();
        }
      } catch (err) {
        console.error('Mock 데이터 로드 중 오류 발생:', err);
      }
      console.log('3차 Mock 데이터베이스가 초기화되었습니다.');
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
      // 시간 문자열 뒤에 Z가 없으면 UTC 기준으로 해석하도록 접미사 Z 강제 결합
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
      // UTC 날짜 형식을 'YYYY-MM-DD HH:mm:ss' 형태로 원복 변환
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
      console.log('Supabase 설정이 해제되었습니다. 로컬 단독 SQLite 모드로 전환합니다.');
      return true;
    }

    if (!createClient) {
      console.error('Supabase SDK가 로드되지 않아 설정을 활성화할 수 없습니다.');
      return false;
    }

    try {
      const client = createClient(url, key);
      // 간단한 테이블 조회 쿼리로 네트워크 및 API Key 작동 확인 (Connection Ping)
      const { error } = await client.from('categories').select('id').limit(1);
      if (error) {
        throw error;
      }

      this.supabase = client;
      console.log('Supabase 클라우드 데이터베이스와 정상 연결되었습니다.');
      
      // 첫 번째 전체 동기화 시도를 대기하여 런타임 오류(예: 날짜 변환 등)를 즉각 캐치
      await this.syncAll();

      // 실시간 웹소켓 구독 가동
      this.subscribeRealtime();

      return true;
    } catch (err) {
      console.error('Supabase 연결 및 최초 동기화 설정 실패:', err);
      this.supabase = null;
      throw err; // 상위 렌더러로 오류를 던져 상세 오류가 화면에 보이도록 함
    }
  }

  /**
   * 실시간 변경 콜백 등록
   */
  onDataChange(callback) {
    this.onDataChangeCallback = callback;
  }

  /**
   * Supabase Realtime 웹소켓 채널 구독 시작
   */
  subscribeRealtime() {
    if (!this.supabase || this.isMock) return;

    // 기존 구독이 있다면 먼저 해제
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

    if (this.isMock) return;

    try {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (table === 'categories') {
          const sqliteTime = this.formatToSqliteTime(newRow.updated_at);
          this.db.prepare('INSERT OR REPLACE INTO categories (id, name, updated_at) VALUES (?, ?, ?)')
            .run(newRow.id, newRow.name, sqliteTime);
        } else if (table === 'medicines') {
          const sqliteTime = this.formatToSqliteTime(newRow.updated_at);
          this.db.prepare(`
            INSERT OR REPLACE INTO medicines (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(newRow.id, newRow.name, newRow.category_id, newRow.pack_size, newRow.unopened_packs, newRow.opened_pack_remain, newRow.safety_stock, newRow.unit, sqliteTime);
        } else if (table === 'prescriptions') {
          const cTime = this.formatToSqliteTime(newRow.created_at);
          const uTime = this.formatToSqliteTime(newRow.updated_at);
          this.db.prepare(`
            INSERT OR REPLACE INTO prescriptions (id, prescription_name, patient_name, total_items, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(newRow.id, newRow.prescription_name, newRow.patient_name, newRow.total_items, newRow.note, cTime, uTime);
        } else if (table === 'prescription_items') {
          this.db.prepare(`
            INSERT OR REPLACE INTO prescription_items (id, prescription_id, medicine_id, amount)
            VALUES (?, ?, ?, ?)
          `).run(newRow.id, newRow.prescription_id, newRow.medicine_id, newRow.amount);
        } else if (table === 'stock_logs') {
          const sTime = this.formatToSqliteTime(newRow.timestamp);
          this.db.prepare(`
            INSERT OR REPLACE INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(newRow.id, newRow.medicine_id, newRow.type, newRow.quantity, sTime, newRow.prescription_id, newRow.note);
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
        }
      }

      // UI 갱신 유도 콜백 실행
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
    if (this.isMock) return;
    try {
      this.db.prepare(`UPDATE ${table} SET updated_at = datetime('now', 'utc') WHERE id = ?`).run(id);
    } catch (e) {
      console.error(`${table}의 updated_at 갱신 실패:`, e);
    }
  }

  /**
   * 로컬에서 삭제된 아이템 ID를 deleted_records 테이블에 기록
   */
  recordDeleted(table, id) {
    if (this.isMock) return;
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
    if (!this.supabase || this.isMock) return;
    const recId = Number(id);

    try {
      // 로컬 SQLite에서 해당 레코드 가져오기
      let data = null;
      if (table === 'categories') {
        data = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(recId);
      } else if (table === 'medicines') {
        data = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(recId);
      } else if (table === 'prescriptions') {
        data = this.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(recId);
      } else if (table === 'stock_logs') {
        data = this.db.prepare('SELECT * FROM stock_logs WHERE id = ?').get(recId);
      }

      if (!data) return;

      // PostgreSQL 타임스탬프 형식에 부합하도록 updated_at 또는 created_at 포맷 변경
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
    if (!this.supabase || this.isMock) return;
    const recId = Number(id);

    try {
      const { error } = await this.supabase.from(table).delete().eq('id', recId);
      if (error) throw error;
      
      // Supabase 반영 성공 시 로컬 deleted_records에서 제거
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
    if (!this.supabase || this.isMock) return;
    const pId = Number(prescId);

    try {
      // 1. prescriptions 테이블 행 업로드
      await this.syncItemToSupabase('prescriptions', pId);

      // 2. prescription_items 목록 가져와 업로드
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
   * 전체 양방향 동기화 작업 (Last-Write-Wins 타임스탬프 비교 기반)
   */
  async syncAll() {
    if (!this.supabase || this.isMock) return;
    console.log('[Supabase Sync] 양방향 전체 동기화를 시작합니다...');

    try {
      // ==========================================
      // 1. 삭제 이력 동기화
      // ==========================================
      const deletedList = this.db.prepare('SELECT * FROM deleted_records').all();
      for (const row of deletedList) {
        await this.syncDeletedToSupabase(row.table_name, row.record_id);
      }

      // ==========================================
      // 2. categories 동기화
      // ==========================================
      const localCats = this.db.prepare('SELECT * FROM categories').all();
      const { data: remoteCats, error: errCats } = await this.supabase.from('categories').select('*');
      if (errCats) throw errCats;

      const remoteCatsMap = new Map(remoteCats.map(c => [c.id, c]));

      // 로컬 -> 원격
      for (const lc of localCats) {
        const rc = remoteCatsMap.get(lc.id);
        const localTime = new Date(lc.updated_at).getTime();
        
        if (!rc || localTime > new Date(rc.updated_at).getTime()) {
          const payload = {
            id: lc.id,
            name: lc.name,
            updated_at: this.parseSqliteTime(lc.updated_at)
          };
          await this.supabase.from('categories').upsert(payload);
        }
      }

      // 원격 -> 로컬
      const localCatsMap = new Map(localCats.map(c => [c.id, c]));
      for (const rc of remoteCats) {
        const lc = localCatsMap.get(rc.id);
        const remoteTime = new Date(rc.updated_at).getTime();

        if (!lc || remoteTime > new Date(lc.updated_at).getTime()) {
          const sqliteTime = this.formatToSqliteTime(rc.updated_at);
          this.db.prepare('INSERT OR REPLACE INTO categories (id, name, updated_at) VALUES (?, ?, ?)')
            .run(rc.id, rc.name, sqliteTime);
        }
      }

      // ==========================================
      // 3. medicines 동기화
      // ==========================================
      const localMeds = this.db.prepare('SELECT * FROM medicines').all();
      const { data: remoteMeds, error: errMeds } = await this.supabase.from('medicines').select('*');
      if (errMeds) throw errMeds;

      const remoteMedsMap = new Map(remoteMeds.map(m => [m.id, m]));

      // 로컬 -> 원격
      for (const lm of localMeds) {
        const rm = remoteMedsMap.get(lm.id);
        const localTime = new Date(lm.updated_at).getTime();

        if (!rm || localTime > new Date(rm.updated_at).getTime()) {
          const payload = {
            id: lm.id,
            name: lm.name,
            category_id: lm.category_id,
            pack_size: lm.pack_size,
            unopened_packs: lm.unopened_packs,
            opened_pack_remain: lm.opened_pack_remain,
            safety_stock: lm.safety_stock,
            unit: lm.unit,
            updated_at: this.parseSqliteTime(lm.updated_at)
          };
          await this.supabase.from('medicines').upsert(payload);
        }
      }

      // 원격 -> 로컬
      const localMedsMap = new Map(localMeds.map(m => [m.id, m]));
      for (const rm of remoteMeds) {
        const lm = localMedsMap.get(rm.id);
        const remoteTime = new Date(rm.updated_at).getTime();

        if (!lm || remoteTime > new Date(lm.updated_at).getTime()) {
          const sqliteTime = this.formatToSqliteTime(rm.updated_at);
          this.db.prepare(`
            INSERT OR REPLACE INTO medicines (id, name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(rm.id, rm.name, rm.category_id, rm.pack_size, rm.unopened_packs, rm.opened_pack_remain, rm.safety_stock, rm.unit, sqliteTime);
        }
      }

      // ==========================================
      // 4. prescriptions 및 prescription_items 동기화
      // ==========================================
      const localPrescs = this.db.prepare('SELECT * FROM prescriptions').all();
      const { data: remotePrescs, error: errPrescs } = await this.supabase.from('prescriptions').select('*');
      if (errPrescs) throw errPrescs;

      const remotePrescsMap = new Map(remotePrescs.map(p => [p.id, p]));

      // 로컬 -> 원격
      for (const lp of localPrescs) {
        const rp = remotePrescsMap.get(lp.id);
        if (!rp) {
          const payload = {
            id: lp.id,
            prescription_name: lp.prescription_name,
            patient_name: lp.patient_name,
            total_items: lp.total_items,
            note: lp.note,
            created_at: this.parseSqliteTime(lp.created_at),
            updated_at: this.parseSqliteTime(lp.updated_at)
          };
          await this.supabase.from('prescriptions').insert(payload);
          
          // 동반되는 prescription_items도 업로드
          const items = this.db.prepare('SELECT * FROM prescription_items WHERE prescription_id = ?').all(lp.id);
          if (items && items.length > 0) {
            await this.supabase.from('prescription_items').upsert(items);
          }
        }
      }

      // 원격 -> 로컬
      const localPrescsMap = new Map(localPrescs.map(p => [p.id, p]));
      for (const rp of remotePrescs) {
        const lp = localPrescsMap.get(rp.id);
        if (!lp) {
          const cTime = this.formatToSqliteTime(rp.created_at);
          const uTime = this.formatToSqliteTime(rp.updated_at);
          this.db.prepare(`
            INSERT INTO prescriptions (id, prescription_name, patient_name, total_items, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(rp.id, rp.prescription_name, rp.patient_name, rp.total_items, rp.note, cTime, uTime);

          // 원격에서 prescription_items 내려받아 저장
          const { data: rItems } = await this.supabase.from('prescription_items').select('*').eq('prescription_id', rp.id);
          if (rItems && rItems.length > 0) {
            const insItem = this.db.prepare(`
              INSERT OR REPLACE INTO prescription_items (id, prescription_id, medicine_id, amount)
              VALUES (?, ?, ?, ?)
            `);
            for (const rit of rItems) {
              insItem.run(rit.id, rit.prescription_id, rit.medicine_id, rit.amount);
            }
          }
        }
      }

      // ==========================================
      // 5. stock_logs 동기화
      // ==========================================
      const localLogs = this.db.prepare('SELECT * FROM stock_logs').all();
      const { data: remoteLogs, error: errLogs } = await this.supabase.from('stock_logs').select('*');
      if (errLogs) throw errLogs;

      const remoteLogsMap = new Map(remoteLogs.map(l => [l.id, l]));

      // 로컬 -> 원격
      for (const ll of localLogs) {
        const rl = remoteLogsMap.get(ll.id);
        if (!rl) {
          const payload = {
            id: ll.id,
            medicine_id: ll.medicine_id,
            type: ll.type,
            quantity: ll.quantity,
            timestamp: this.parseSqliteTime(ll.timestamp),
            prescription_id: ll.prescription_id,
            note: ll.note
          };
          await this.supabase.from('stock_logs').insert(payload);
        }
      }

      // 원격 -> 로컬
      const localLogsMap = new Map(localLogs.map(l => [l.id, l]));
      for (const rl of remoteLogs) {
        const ll = localLogsMap.get(rl.id);
        if (!ll) {
          const sTime = this.formatToSqliteTime(rl.timestamp);
          this.db.prepare(`
            INSERT INTO stock_logs (id, medicine_id, type, quantity, timestamp, prescription_id, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(rl.id, rl.medicine_id, rl.type, rl.quantity, sTime, rl.prescription_id, rl.note);
        }
      }

      console.log('[Supabase Sync] 양방향 동기화 완료!');
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

    if (this.isMock) {
      const exists = this.mockData.categories.find(c => c.name === cleanName);
      if (exists) return exists.id;

      const id = this.mockData.categories.length > 0 ? Math.max(...this.mockData.categories.map(c => c.id)) + 1 : 1;
      this.mockData.categories.push({ id, name: cleanName });
      this.saveMockData();
      return id;
    } else {
      try {
        const exists = this.db.prepare('SELECT id FROM categories WHERE name = ?').get(cleanName);
        if (exists) return exists.id;

        const stmt = this.db.prepare('INSERT INTO categories (name) VALUES (?)');
        const result = stmt.run(cleanName);
        const newId = result.lastInsertRowid;
        
        // Supabase 동기화
        this.updateUpdatedAt('categories', newId);
        this.syncItemToSupabase('categories', newId);
        
        return newId;
      } catch (err) {
        throw err;
      }
    }
  }

  getAllCategories() {
    if (this.isMock) {
      return [...this.mockData.categories];
    } else {
      return this.db.prepare('SELECT * FROM categories ORDER BY id ASC').all();
    }
  }

  // ==========================================
  // 약재 관리 API
  // ==========================================

  /**
   * 약재 데이터를 바탕으로 총 재고량 및 출력 포맷을 계산하는 인메모리 헬퍼 함수 (DB 조회 비방식)
   * @param {object} med 약재 객체
   */
  calculateStockInfo(med) {
    const { unopened_packs, pack_size, opened_pack_remain, unit } = med;
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
    let med;
    let categoryName = '미분류';

    if (this.isMock) {
      med = this.mockData.medicines.find(m => m.id === medicineId);
      if (med) {
        const cat = this.mockData.categories.find(c => c.id === med.category_id);
        if (cat) categoryName = cat.name;
      }
    } else {
      med = this.db.prepare(`
        SELECT m.*, c.name as category_name 
        FROM medicines m
        LEFT JOIN categories c ON m.category_id = c.id
        WHERE m.id = ?
      `).get(medicineId);
      if (med) categoryName = med.category_name || '미분류';
    }

    if (!med) {
      throw new Error(`약재 ID ${medicineId}를 찾을 수 없습니다.`);
    }

    const stockInfo = this.calculateStockInfo(med);

    return {
      totalStock: stockInfo.totalStock,
      formatted: stockInfo.formatted,
      unopened_packs: med.unopened_packs,
      opened_pack_remain: med.opened_pack_remain,
      pack_size: med.pack_size,
      unit: med.unit,
      name: med.name,
      category_id: med.category_id,
      categoryName,
      safety_stock: med.safety_stock // UI 상세 보기 누락 해결
    };
  }

  addMedicine(data) {
    const { name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit } = data;
    if (!name || !pack_size || pack_size <= 0) {
      throw new Error('약재명과 유효한 팩 규격은 필수입니다.');
    }

    const catId = Number(category_id || 1);

    if (this.isMock) {
      const exists = this.mockData.medicines.some(m => m.name === name);
      if (exists) throw new Error(`이미 존재하는 약재명입니다: ${name}`);

      const id = this.mockData.medicines.length > 0 ? Math.max(...this.mockData.medicines.map(m => m.id)) + 1 : 1;
      const newMed = {
        id,
        name,
        category_id: catId,
        pack_size: Number(pack_size),
        unopened_packs: Number(unopened_packs || 0),
        opened_pack_remain: Number(opened_pack_remain || 0),
        safety_stock: Number(safety_stock || 0),
        unit: unit || 'g'
      };
      this.mockData.medicines.push(newMed);
      this.saveMockData();
      return id;
    } else {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO medicines (name, category_id, pack_size, unopened_packs, opened_pack_remain, safety_stock, unit)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
          name,
          catId,
          Number(pack_size),
          Number(unopened_packs || 0),
          Number(opened_pack_remain || 0),
          Number(safety_stock || 0),
          unit || 'g'
        );
        const newId = result.lastInsertRowid;
        
        // Supabase 동기화
        this.updateUpdatedAt('medicines', newId);
        this.syncItemToSupabase('medicines', newId);

        return newId;
      } catch (err) {
        if (err.message.includes('UNIQUE')) {
          throw new Error(`이미 존재하는 약재명입니다: ${name}`);
        }
        throw err;
      }
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

      if (pack_size <= 0) throw new Error('팩 규격은 0보다 커야 합니다.');
      if (opened_pack_remain > pack_size) throw new Error('개봉 잔량은 팩 규격을 초과할 수 없습니다.');

      const newTotal = (unopened_packs * pack_size) + opened_pack_remain;
      const loss = newTotal - oldTotal;

      return {
        name,
        category_id,
        pack_size,
        unopened_packs,
        opened_pack_remain,
        safety_stock,
        unit,
        loss
      };
    };

    if (this.isMock) {
      const idx = this.mockData.medicines.findIndex(m => m.id === medId);
      if (idx === -1) throw new Error('약재를 찾을 수 없습니다.');

      const prevMed = this.mockData.medicines[idx];
      const updated = execute(prevMed);

      this.mockData.medicines[idx] = {
        ...prevMed,
        name: updated.name,
        category_id: updated.category_id,
        pack_size: updated.pack_size,
        unopened_packs: updated.unopened_packs,
        opened_pack_remain: updated.opened_pack_remain,
        safety_stock: updated.safety_stock,
        unit: updated.unit
      };

      if (updated.loss !== 0) {
        const logId = this.mockData.stock_logs.length + 1;
        this.mockData.stock_logs.push({
          id: logId,
          medicine_id: medId,
          type: 'ADJUST',
          quantity: updated.loss,
          timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
          note: `수동 데이터 보정 (오차: ${updated.loss > 0 ? '+' : ''}${updated.loss}g)`
        });
      }
      this.saveMockData();
      return updated.loss;
    } else {
      let loss = 0;
      let insertedLogId = 0;
      const transaction = this.db.transaction(() => {
        const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medId);
        if (!med) throw new Error('약재를 찾을 수 없습니다.');

        const updated = execute(med);
        loss = updated.loss;

        this.db.prepare(`
          UPDATE medicines 
          SET name = ?, category_id = ?, pack_size = ?, unopened_packs = ?, opened_pack_remain = ?, safety_stock = ?, unit = ?
          WHERE id = ?
        `).run(
          updated.name,
          updated.category_id,
          updated.pack_size,
          updated.unopened_packs,
          updated.opened_pack_remain,
          updated.safety_stock,
          updated.unit,
          medId
        );

        if (loss !== 0) {
          const resLog = this.db.prepare(`
            INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, note)
            VALUES (?, 'ADJUST', ?, datetime('now', 'utc'), ?)
          `).run(medId, loss, `수동 데이터 보정 (오차: ${loss > 0 ? '+' : ''}${loss}g)`);
          insertedLogId = resLog.lastInsertRowid;
        }
      });

      transaction();

      // Supabase 동기화 트리거
      this.updateUpdatedAt('medicines', medId);
      this.syncItemToSupabase('medicines', medId);
      if (insertedLogId > 0) {
        this.syncItemToSupabase('stock_logs', insertedLogId);
      }

      return loss;
    }
  }

  deleteMedicine(medicineId) {
    if (this.isMock) {
      const idx = this.mockData.medicines.findIndex(m => m.id === medicineId);
      if (idx === -1) throw new Error('삭제할 약재를 찾을 수 없습니다.');
      this.mockData.medicines.splice(idx, 1);
      this.mockData.stock_logs = this.mockData.stock_logs.filter(l => l.medicine_id !== medicineId);
      this.mockData.prescription_items = this.mockData.prescription_items.filter(i => i.medicine_id !== medicineId);
      this.saveMockData();
      return true;
    } else {
      try {
        this.recordDeleted('medicines', medicineId);
        this.db.prepare('DELETE FROM medicines WHERE id = ?').run(medicineId);
        this.syncDeletedToSupabase('medicines', medicineId);
        return true;
      } catch (err) {
        throw err;
      }
    }
  }

  // ==========================================
  // 기존 재고 제어 비즈니스 로직
  // ==========================================

  consumeStock(medicineId, consumeGrams, prescriptionId = null, note = '') {
    if (consumeGrams <= 0) {
      throw new Error('소모량은 0보다 커야 합니다.');
    }

    const execute = (med) => {
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
      }

      return {
        unopened_packs: currentUnopened,
        opened_pack_remain: currentRemain
      };
    };

    if (this.isMock) {
      const idx = this.mockData.medicines.findIndex(m => m.id === medicineId);
      if (idx === -1) throw new Error('약재를 찾을 수 없습니다.');
      
      const newStock = execute(this.mockData.medicines[idx]);
      
      this.mockData.medicines[idx].unopened_packs = newStock.unopened_packs;
      this.mockData.medicines[idx].opened_pack_remain = newStock.opened_pack_remain;
      
      const newLogId = this.mockData.stock_logs.length + 1;
      this.mockData.stock_logs.push({
        id: newLogId,
        medicine_id: medicineId,
        type: 'CONSUME',
        quantity: -consumeGrams,
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        prescription_id: prescriptionId,
        note: note || '처방 소모'
      });
      this.saveMockData();
      return true;
    } else {
      let logId = 0;
      const transaction = this.db.transaction(() => {
        const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId);
        if (!med) throw new Error('약재를 찾을 수 없습니다.');

        const newStock = execute(med);

        this.db.prepare(`
          UPDATE medicines 
          SET unopened_packs = ?, opened_pack_remain = ?
          WHERE id = ?
        `).run(newStock.unopened_packs, newStock.opened_pack_remain, medicineId);

        const resLog = this.db.prepare(`
          INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, prescription_id, note)
          VALUES (?, 'CONSUME', ?, datetime('now', 'utc'), ?, ?)
        `).run(medicineId, -consumeGrams, prescriptionId, note || '처방 소모');
        logId = resLog.lastInsertRowid;
      });

      transaction();

      // Supabase 동기화 트리거 (비동기)
      this.updateUpdatedAt('medicines', medicineId);
      this.syncItemToSupabase('medicines', medicineId);
      if (logId > 0) {
        this.syncItemToSupabase('stock_logs', logId);
      }

      return true;
    }
  }

  adjustStock(medicineId, realPacks, realRemain) {
    return this.updateMedicine(medicineId, {
      unopened_packs: realPacks,
      opened_pack_remain: realRemain
    });
  }

  addStockLog(medicineId, type, quantity, note = '') {
    if (this.isMock) {
      const idx = this.mockData.medicines.findIndex(m => m.id === medicineId);
      if (idx === -1) throw new Error('약재를 찾을 수 없습니다.');
      
      if (type === 'IN') {
        const med = this.mockData.medicines[idx];
        const packs = Math.floor(quantity / med.pack_size);
        const remain = quantity % med.pack_size;
        
        med.unopened_packs += packs;
        med.opened_pack_remain += remain;
        if (med.opened_pack_remain >= med.pack_size) {
          med.unopened_packs += 1;
          med.opened_pack_remain -= med.pack_size;
        }
      } else if (type === 'WASTE') {
        this.consumeStock(medicineId, Math.abs(quantity), null, note || '재고 폐기');
        return;
      }

      const logId = this.mockData.stock_logs.length + 1;
      this.mockData.stock_logs.push({
        id: logId,
        medicine_id: medicineId,
        type,
        quantity,
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        note
      });
      this.saveMockData();
    } else {
      let logId = 0;
      let needMedUpdate = false;
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
          
          this.db.prepare('UPDATE medicines SET unopened_packs = ?, opened_pack_remain = ? WHERE id = ?')
            .run(newPacks, newRemain, medicineId);
          needMedUpdate = true;
        } else if (type === 'WASTE') {
          this.consumeStock(medicineId, Math.abs(quantity), null, note || '재고 폐기');
          return;
        }

        const resLog = this.db.prepare('INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, note) VALUES (?, ?, ?, datetime(\'now\', \'utc\'), ?)')
          .run(medicineId, type, quantity, note);
        logId = resLog.lastInsertRowid;
      });
      transaction();

      // Supabase 동기화 트리거
      if (needMedUpdate) {
        this.updateUpdatedAt('medicines', medicineId);
        this.syncItemToSupabase('medicines', medicineId);
      }
      if (logId > 0) {
        this.syncItemToSupabase('stock_logs', logId);
      }
    }
  }

  /**
   * 처방전 추가 (메모 note 지원 보강)
   */
  addPrescription(prescriptionName, patientName, items, note = '') {
    if (!items || items.length === 0) {
      throw new Error('처방전에 약재가 포함되어야 합니다.');
    }

    if (this.isMock) {
      const pId = this.mockData.prescriptions.length + 1;
      const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
      
      this.mockData.prescriptions.push({
        id: pId,
        prescription_name: prescriptionName,
        patient_name: patientName,
        total_items: items.length,
        note: note,
        created_at: createdAt
      });

      items.forEach(item => {
        const itemId = this.mockData.prescription_items.length + 1;
        this.mockData.prescription_items.push({
          id: itemId,
          prescription_id: pId,
          medicine_id: item.medicineId,
          amount: item.amount
        });
        
        this.consumeStock(item.medicineId, item.amount, pId, `${prescriptionName} 처방 (${patientName})`);
      });

      this.saveMockData();
      return pId;
    } else {
      let pId = 0;
      const transaction = this.db.transaction(() => {
        const stmt = this.db.prepare(`
          INSERT INTO prescriptions (prescription_name, patient_name, total_items, note, created_at)
          VALUES (?, ?, ?, ?, datetime('now', 'utc'))
        `);
        const res = stmt.run(prescriptionName, patientName, items.length, note);
        pId = res.lastInsertRowid;

        const itemStmt = this.db.prepare(`
          INSERT INTO prescription_items (prescription_id, medicine_id, amount)
          VALUES (?, ?, ?)
        `);

        for (const item of items) {
          itemStmt.run(pId, item.medicineId, item.amount);
          this.consumeStock(item.medicineId, item.amount, pId, `${prescriptionName} 처방 (${patientName})`);
        }
      });
      transaction();

      // Supabase 동기화 트리거
      this.updateUpdatedAt('prescriptions', pId);
      this.syncPrescriptionToSupabase(pId);

      return pId;
    }
  }

  /**
   * 특정 처방전 완료 기록의 세부 정보 및 소모된 약재 목록 가져오기 (신설)
   * @param {number} prescriptionId 
   */
  getPrescriptionDetails(prescriptionId) {
    const pId = Number(prescriptionId);
    
    if (this.isMock) {
      const prescription = this.mockData.prescriptions.find(p => p.id === pId);
      if (!prescription) throw new Error('처방전 정보를 찾을 수 없습니다.');

      const items = this.mockData.prescription_items
        .filter(item => item.prescription_id === pId)
        .map(item => {
          const med = this.mockData.medicines.find(m => m.id === item.medicine_id);
          return {
            medicine_id: item.medicine_id,
            medicine_name: med ? med.name : '알수없음',
            amount: item.amount,
            unit: med ? med.unit : 'g'
          };
        });

      return {
        ...prescription,
        items
      };
    } else {
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
  }

  getAllMedicines() {
    if (this.isMock) {
      return this.mockData.medicines.map(m => {
        const cat = this.mockData.categories.find(c => c.id === m.category_id);
        const categoryName = cat ? cat.name : '미분류';
        const stockInfo = this.calculateStockInfo(m);
        return {
          ...m,
          total_stock: stockInfo.totalStock,
          formatted_stock: stockInfo.formatted,
          category_name: categoryName
        };
      });
    } else {
      const list = this.db.prepare(`
        SELECT m.*, c.name as category_name 
        FROM medicines m
        LEFT JOIN categories c ON m.category_id = c.id
        ORDER BY m.name ASC
      `).all();
      return list.map(m => {
        const stockInfo = this.calculateStockInfo(m);
        return {
          ...m,
          total_stock: stockInfo.totalStock,
          formatted_stock: stockInfo.formatted,
          category_name: m.category_name || '미분류'
        };
      });
    }
  }

  getLogsByMedicine(medicineId) {
    const medId = Number(medicineId);
    if (this.isMock) {
      return this.mockData.stock_logs
        .filter(l => l.medicine_id === medId)
        .reverse()
        .map(l => ({
          ...l,
          medicine_name: this.mockData.medicines.find(m => m.id === medId)?.name || '알수없음'
        }));
    } else {
      return this.db.prepare(`
        SELECT l.*, m.name as medicine_name 
        FROM stock_logs l
        JOIN medicines m ON l.medicine_id = m.id
        WHERE l.medicine_id = ?
        ORDER BY l.timestamp DESC, l.id DESC
      `).all(medId);
    }
  }

  getAllLogs() {
    if (this.isMock) {
      return [...this.mockData.stock_logs].reverse().map(log => {
        const med = this.mockData.medicines.find(m => m.id === log.medicine_id);
        return {
          ...log,
          medicine_name: med ? med.name : '알수없음'
        };
      });
    } else {
      return this.db.prepare(`
        SELECT l.*, m.name as medicine_name 
        FROM stock_logs l
        JOIN medicines m ON l.medicine_id = m.id
        ORDER BY l.timestamp DESC, l.id DESC
      `).all();
    }
  }

  getAllPrescriptions() {
    if (this.isMock) {
      return [...this.mockData.prescriptions].reverse();
    } else {
      return this.db.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC, id DESC').all();
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = InventoryManager;
}
