/**
 * @file SyncEngine.js
 * @description Supabase 하이브리드 클라우드 동기화의 오케스트레이터(조율자).
 *
 * 구성 요소와 역할 분담:
 *  - TableMapper:        테이블 선언(컬럼/시간/충돌 정책)과 행 변환 — 단일 등록 지점
 *  - ConflictResolver:   Last-Write-Wins 타임스탬프 판정
 *  - SyncQueue:          오프라인 안전 업로드 대기열 (재시도/실패 이력 포함)
 *  - RealtimeSubscriber: 원격 변경 실시간 수신 → 로컬 반영
 *  - SyncEngine(본 클래스): 연결 수립, 전체 동기화(syncAll), 개별 업로드 실행,
 *                          위 구성 요소들의 조립과 수명 관리
 *
 * 연결 수립 순서 (setupSupabase):
 *  연결 테스트 → 시계 오프셋 계산 → 전체 벌크 동기화 → Realtime 구독 → 대기 큐 처리
 *
 * Repository/Service 계층은 이 엔진의 트리거 메서드(syncItemToSupabase 등)만 호출하며,
 * supabase가 null이면(미연결/CSV 대량 가져오기 중 일시 차단) 큐 처리가 자동 보류됩니다.
 */

let createClient;
try {
  const supabaseSdk = require('@supabase/supabase-js');
  createClient = supabaseSdk.createClient;
} catch (e) {
  console.warn('@supabase/supabase-js 패키지를 로드할 수 없습니다. 클라우드 동기화가 불가능합니다.');
}

const TableMapper = require('./TableMapper');
const ConflictResolver = require('./ConflictResolver');
const SyncQueue = require('./SyncQueue');
const RealtimeSubscriber = require('./RealtimeSubscriber');

class SyncEngine {
  /**
   * @param {object} deps 의존성 주입
   * @param {object} deps.db better-sqlite3 원시 연결
   * @param {object} deps.time TimeService (시계 보정 소유)
   */
  constructor({ db, time }) {
    this.db = db;
    this.time = time;

    /** Supabase 클라이언트. null이면 로컬 단독(SQLite-only) 모드 */
    this.supabase = null;

    /** 실시간 변경 수신 시 렌더러 UI를 갱신하기 위한 콜백 */
    this.onDataChangeCallback = null;

    // 하위 구성 요소 조립
    this.mapper = new TableMapper(db, time);
    this.resolver = new ConflictResolver(db, time);
    this.queue = new SyncQueue({ db, time, executor: this });
    this.realtime = new RealtimeSubscriber({
      db,
      mapper: this.mapper,
      resolver: this.resolver,
      // 콜백은 나중에 등록될 수 있으므로 게터로 전달 (등록 시점 역전 대응)
      onChange: () => this.onDataChangeCallback
    });

    // 브라우저 온라인 전환 감지 → 대기 큐 자동 재처리
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        console.log('[Sync Queue] 인터넷 연결이 감지되었습니다. 동기화 큐를 처리합니다...');
        this.processSyncQueue().catch(err => console.error('[Sync Queue] 온라인 전환 동기화 중 오류:', err));
      });
    }
  }

  /**
   * 실시간 변경 콜백을 등록합니다. (렌더러가 UI 갱신 함수를 등록)
   * @param {function(): void} callback
   */
  onDataChange(callback) {
    this.onDataChangeCallback = callback;
  }

  /**
   * Supabase 클라이언트를 초기화하고 자동 동기화를 시작합니다.
   * url/key가 비어 있으면 연결을 해제하고 로컬 단독 모드로 전환합니다.
   * @param {string} url Supabase Project URL (스킴/도메인 생략 시 자동 보정)
   * @param {string} key Supabase Anon Key
   * @returns {Promise<boolean>} 연결 성공 여부
   */
  async setupSupabase(url, key) {
    // URL 관용 입력 보정: 'abcd' → 'https://abcd.supabase.co', 'x.co' → 'https://x.co'
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

    // 빈 값 → 연결 해제 (로컬 단독 모드)
    if (!url || !key) {
      this.realtime.unsubscribe(this.supabase);
      this.supabase = null;
      this.time.reset();
      console.log('Supabase 설정이 해제되었습니다. 로컬 단독 SQLite 모드로 전환합니다.');
      return true;
    }

    if (!createClient) {
      console.error('Supabase SDK가 로드되지 않아 설정을 활성화할 수 없습니다.');
      return false;
    }

    try {
      // 연결 테스트: 가벼운 SELECT로 URL/키 유효성 검증
      const client = createClient(url, key);
      const { error } = await client.from('categories').select('id').limit(1);
      if (error) {
        throw error;
      }

      this.supabase = client;
      console.log('Supabase 클라우드 데이터베이스와 정상 연결되었습니다.');

      // Clock Skew Offset 계산 (LWW 판정 정확성 확보)
      await this.time.calculateClockOffset(url, key);

      await this.syncAll();
      this.realtime.subscribe(this.supabase);
      this.processSyncQueue().catch(err => console.error('[Sync Queue] 최초 구동 시 큐 처리 오류:', err));

      return true;
    } catch (err) {
      console.error('Supabase 연결 및 최초 동기화 설정 실패:', err);
      this.supabase = null;
      throw err;
    }
  }

  // ==========================================================================
  // 개별 업로드 실행부 (SyncQueue가 호출하는 executor 인터페이스)
  // ==========================================================================

  /**
   * Supabase에 특정 레코드를 직접 Upsert합니다. (실패 시 에러 전파 — 큐가 재시도 판단)
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   */
  async syncItemToSupabaseDirect(table, id) {
    if (!this.supabase) throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
    if (!this.mapper.has(table)) throw new Error(`동기화 대상이 아닌 테이블입니다: ${table}`);

    const data = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(String(id));
    if (!data) {
      console.warn(`[Supabase Sync Direct] ${table} (ID: ${id}) 데이터가 로컬에 존재하지 않아 업로드를 스킵합니다.`);
      return;
    }

    const payload = this.mapper.localRowToPayload(table, data);
    const { error } = await this.supabase.from(table).upsert(payload);
    if (error) {
      throw error;
    }
    console.log(`[Supabase Sync Direct] ${table} (ID: ${id}) 업로드 성공.`);
  }

  /**
   * Supabase에서 특정 레코드를 직접 삭제하고, 성공 시 로컬 tombstone도 정리합니다.
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
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
   * 원격 Supabase의 처방 프리셋 하위 아이템을 로컬 기준으로 전체 교체합니다.
   * (프리셋 항목은 개별 upsert 대신 삭제 후 재삽입 방식)
   * @param {string} prId 프리셋 UUID
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

  // ==========================================================================
  // 동기화 트리거 (Repository/Service 계층이 호출하는 공개 인터페이스)
  // ==========================================================================

  /**
   * 동기화 작업을 큐에 등록합니다. (하위 호환용 공개 메서드)
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   * @param {'UPSERT'|'DELETE'|'REPLACE_PRESET_ITEMS'} action 작업 유형
   */
  enqueueSync(table, id, action) {
    this.queue.enqueue(table, id, action);
  }

  /** 대기 중인 동기화 큐를 처리합니다. */
  async processSyncQueue() {
    return this.queue.process();
  }

  /** 오류의 네트워크성 여부 판별 → SyncQueue.isNetworkError */
  isNetworkError(err) {
    return this.queue.isNetworkError(err);
  }

  /** 재시도 한도 초과 실패 이력 조회 (진단용) → SyncQueue.getFailures */
  getSyncFailures() {
    return this.queue.getFailures();
  }

  /**
   * 특정 레코드의 Upsert를 큐에 등록합니다. (백그라운드 업로드)
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   */
  async syncItemToSupabase(table, id) {
    this.queue.enqueue(table, id, 'UPSERT');
  }

  /**
   * 특정 레코드의 원격 삭제를 큐에 등록합니다. (백그라운드 삭제 전파)
   * @param {string} table 테이블 이름
   * @param {string} id 레코드 ID
   */
  async syncDeletedToSupabase(table, id) {
    this.queue.enqueue(table, id, 'DELETE');
  }

  /**
   * 처방 헤더와 하위 항목 전체의 Upsert를 큐에 등록합니다.
   * @param {string} prescId 처방 UUID
   */
  async syncPrescriptionToSupabase(prescId) {
    this.queue.enqueue('prescriptions', prescId, 'UPSERT');

    const items = this.db.prepare('SELECT * FROM prescription_items WHERE prescription_id = ?').all(String(prescId));
    for (const item of items) {
      this.queue.enqueue('prescription_items', item.id, 'UPSERT');
    }
  }

  /**
   * 프리셋 헤더 Upsert + 하위 항목 전체 교체 작업을 큐에 등록합니다. (오프라인에도 안전)
   * @param {string} presetId 프리셋 UUID
   */
  async syncPresetToSupabase(presetId) {
    if (!this.supabase) return;
    const prId = String(presetId);

    this.queue.enqueue('prescription_presets', prId, 'UPSERT');
    this.queue.enqueue('prescription_presets', prId, 'REPLACE_PRESET_ITEMS');
  }

  // ==========================================================================
  // 전체 양방향 동기화
  // ==========================================================================

  /**
   * 전체 양방향 동기화 (Last-Write-Wins 타임스탬프 비교 기반).
   * TableMapper의 테이블 선언을 순회하는 공통 루프로 처리하여 테이블 누락형 버그를 방지합니다.
   *
   * 처리 순서:
   *  1-1. 서버의 삭제 이력(deleted_records)을 다운로드해 로컬에 반영
   *  1-2. 로컬의 삭제 이력을 서버에 전파
   *  2.   FK 순서(부모 → 자식)대로 테이블별 업로드/다운로드
   *       - lww: updated_at 비교 승자만 전송/반영
   *       - insertOnly(불변 이력): 없는 쪽에만 삽입
   *       - children: 부모와 함께 자식 행도 묶어서 처리
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
          const allowedTables = this.mapper.tableNames;
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

      // 2. 테이블 선언 기반 공통 동기화 루프
      for (const table of this.mapper.tableOrder) {
        const cfg = this.mapper.getConfig(table);
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
            shouldUpload = !remoteRow; // 불변 이력: 원격에 없을 때만
          } else if (cfg.lww) {
            shouldUpload = !remoteRow || this.time.localTimeMs(localRow.updated_at) > this.time.remoteTimeMs(remoteRow.updated_at);
          } else {
            shouldUpload = !remoteRow;
          }

          if (shouldUpload) {
            toRemote.push(this.mapper.localRowToPayload(table, localRow));
            // 부모가 업로드 대상이면 자식 행도 함께 업로드
            if (cfg.children) {
              const childRows = this.db.prepare(`SELECT * FROM ${cfg.children.table} WHERE ${cfg.children.fk} = ?`).all(localRow.id);
              childRowsToRemote.push(...childRows.map(cr => this.mapper.localRowToPayload(cfg.children.table, cr)));
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
            shouldDownload = !localRow || this.time.remoteTimeMs(remoteRow.updated_at) > this.time.localTimeMs(localRow.updated_at);
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
              this.mapper.applyRemoteRow(table, remoteRow);
            }
          });
          transaction();

          // 부모가 다운로드되었으면 그 자식 행들도 함께 다운로드
          if (cfg.children) {
            const parentIds = toLocal.map(r => r.id);
            const { data: childRows, error: childErr } = await this.supabase
              .from(cfg.children.table)
              .select('*')
              .in(cfg.children.fk, parentIds);
            if (!childErr && childRows && childRows.length > 0) {
              const childTx = this.db.transaction(() => {
                for (const childRow of childRows) {
                  this.mapper.applyRemoteRow(cfg.children.table, childRow);
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
}

module.exports = SyncEngine;
