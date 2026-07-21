/**
 * @file InventoryManager.js
 * @description 백엔드 전체를 조립하고 기존 공개 API를 유지하는 Facade(정면) 클래스.
 *
 * v1.8.0 객체지향 재구성 이후 이 클래스는 직접 구현을 갖지 않습니다.
 * 실제 구현 위치:
 *  - 연결/스키마/마이그레이션:  db/Database.js
 *  - 시간 파싱/시계 보정:       db/TimeService.js
 *  - ID(UUID) 규칙:            db/ids.js
 *  - 테이블별 CRUD:            repositories/*.js
 *  - 재고 증감 알고리즘:        services/StockService.js
 *  - 처방 트랜잭션 로직:        services/PrescriptionService.js
 *  - Supabase 동기화:          sync/SyncEngine.js (+ TableMapper/ConflictResolver/SyncQueue/RealtimeSubscriber)
 *
 * Facade를 유지하는 이유 (Strangler Fig 패턴):
 *  렌더러와 테스트가 기존 공개 API(addMedicine, consumeStock, setupSupabase 등)를
 *  그대로 호출할 수 있어, 내부 구조 개편이 호출부에 전혀 영향을 주지 않습니다.
 *  새 코드를 작성할 때는 가급적 담당 Repository/Service를 직접 사용하되,
 *  렌더러에서는 이 Facade를 통해 접근하는 것이 무난합니다.
 *
 * v1.7.0: 모든 엔티티 기본 키가 UUID(TEXT)입니다. (규칙은 db/ids.js 참고)
 */

const AppDatabase = require('./db/Database');
const TimeService = require('./db/TimeService');
const { DEFAULT_CATEGORY_ID, LEGACY_UUID_PREFIX } = require('./db/ids');
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

// 동기화 서브시스템 오케스트레이터
const SyncEngine = require('./sync/SyncEngine');

class InventoryManager {
  /**
   * 백엔드 객체 그래프 전체를 조립합니다.
   * 생성 순서: DB 연결 → 시간 서비스 → 동기화 엔진 → Repository → Service
   * @param {string} dbPath 데이터베이스 파일 경로 (':memory:' 허용 — 테스트용)
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

    // Supabase 동기화 엔진 (연결 전에는 로컬 단독 모드로 대기)
    this.syncEngine = new SyncEngine({ db: this.db, time: this.time });

    // ---- Repository / Service 계층 조립 (의존성 주입) --------------------------
    // 하위 계층은 syncEngine의 트리거 인터페이스(syncItemToSupabase 등)만 사용합니다.
    const ctx = { db: this.db, time: this.time, sync: this.syncEngine };

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
  }

  // ==========================================================================
  // 상태 프록시 (하위 호환)
  // ==========================================================================

  /** 기본 카테고리('미분류')의 고정 UUID */
  get defaultCategoryId() {
    return DEFAULT_CATEGORY_ID;
  }

  /**
   * Supabase 클라이언트 프록시. 실제 상태는 SyncEngine이 소유합니다.
   * CSVHandler가 대량 가져오기 중 `manager.supabase = null`로 개별 동기화를
   * 일시 차단하는 기존 패턴이 이 setter를 통해 그대로 동작합니다.
   */
  get supabase() {
    return this.syncEngine.supabase;
  }

  set supabase(client) {
    this.syncEngine.supabase = client;
  }

  /**
   * 시계 보정 오프셋(ms) 프록시. 실제 상태는 TimeService가 소유합니다.
   */
  get clockOffset() {
    return this.time.clockOffset;
  }

  set clockOffset(value) {
    this.time.clockOffset = value;
  }

  // ==========================================================================
  // 시간 관련 API → TimeService
  // ==========================================================================

  /** SQLite 날짜 포맷을 ISO8601 형식으로 변환 */
  parseSqliteTime(timeStr) {
    return this.time.parseSqliteTime(timeStr);
  }

  /** ISO8601을 SQLite 날짜 포맷으로 변환 */
  formatToSqliteTime(isoTimeStr) {
    return this.time.formatToSqliteTime(isoTimeStr);
  }

  /** 로컬 SQLite UTC 시간 문자열 → epoch(ms) */
  localTimeMs(sqliteTimeStr) {
    return this.time.localTimeMs(sqliteTimeStr);
  }

  /** 원격 ISO8601 시간 문자열 → epoch(ms) */
  remoteTimeMs(isoTimeStr) {
    return this.time.remoteTimeMs(isoTimeStr);
  }

  /** 서버-로컬 시계 오프셋 계산 */
  async calculateClockOffset(url, key) {
    return this.time.calculateClockOffset(url, key);
  }

  /** 시계 보정된 현재 SQLite 시간 문자열 */
  getAdjustedSqliteTime() {
    return this.time.getAdjustedSqliteTime();
  }

  // ==========================================================================
  // Supabase 동기화 API → SyncEngine
  // ==========================================================================

  /** Supabase 연결 수립 및 자동 동기화 시작 (빈 값이면 연결 해제) */
  async setupSupabase(url, key) {
    return this.syncEngine.setupSupabase(url, key);
  }

  /** 실시간 변경 수신 시 호출할 UI 갱신 콜백 등록 */
  onDataChange(callback) {
    this.syncEngine.onDataChange(callback);
  }

  /** 전체 양방향 동기화 (LWW 기반 벌크 업로드/다운로드) */
  async syncAll() {
    return this.syncEngine.syncAll();
  }

  /** 대기 중인 동기화 큐 처리 */
  async processSyncQueue() {
    return this.syncEngine.processSyncQueue();
  }

  /** 동기화 작업 큐 등록 */
  enqueueSync(table, id, action) {
    this.syncEngine.enqueueSync(table, id, action);
  }

  /** 특정 레코드 Upsert를 큐에 등록 (백그라운드 업로드) */
  async syncItemToSupabase(table, id) {
    return this.syncEngine.syncItemToSupabase(table, id);
  }

  /** 특정 레코드의 원격 삭제를 큐에 등록 */
  async syncDeletedToSupabase(table, id) {
    return this.syncEngine.syncDeletedToSupabase(table, id);
  }

  /** 처방 헤더+항목 전체 Upsert를 큐에 등록 */
  async syncPrescriptionToSupabase(prescId) {
    return this.syncEngine.syncPrescriptionToSupabase(prescId);
  }

  /** 프리셋 헤더 Upsert + 하위 항목 전체 교체를 큐에 등록 */
  async syncPresetToSupabase(presetId) {
    return this.syncEngine.syncPresetToSupabase(presetId);
  }

  /** LWW 판정: 원격 데이터로 덮어써야 하는지 → ConflictResolver */
  shouldOverwriteWithRemote(table, id, remoteUpdatedAt) {
    return this.syncEngine.resolver.shouldOverwriteWithRemote(table, id, remoteUpdatedAt);
  }

  /** 오류의 네트워크성 여부 판별 → SyncQueue */
  isNetworkError(err) {
    return this.syncEngine.isNetworkError(err);
  }

  /** 재시도 한도 초과 동기화 실패 이력 조회 (진단용) */
  getSyncFailures() {
    return this.syncEngine.getSyncFailures();
  }

  /** 삭제 tombstone 기록 (원격 삭제 전파용) */
  recordDeleted(table, id) {
    this.categoryRepo.recordDeleted(table, id);
  }

  /** 특정 레코드의 updated_at을 보정된 현재 시간으로 갱신 */
  updateUpdatedAt(table, id) {
    this.categoryRepo.touch(table, id);
  }

  // ==========================================================================
  // 공통 유효성 검사 → utils/validators
  // ==========================================================================

  /** 유한한 양수 검증 (0/음수/NaN 차단) */
  assertPositiveAmount(value, label = '수량') {
    return assertPositiveAmount(value, label);
  }

  // ==========================================================================
  // 카테고리 관리 API → CategoryRepository
  // ==========================================================================

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

  // ==========================================================================
  // 약재 관리 API → MedicineRepository
  // ==========================================================================

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

  // ==========================================================================
  // 재고 증감 API → StockService / StockLogRepository
  // ==========================================================================

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

  /** 처방별 실제 차감량 집계 */
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

  // ==========================================================================
  // 처방 관리 API → PrescriptionService / PrescriptionRepository
  // ==========================================================================

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

  // ==========================================================================
  // 알림함 API → NotificationRepository
  // ==========================================================================

  getNotifications() {
    return this.notificationRepo.getAll();
  }

  markNotificationAsRead(id) {
    return this.notificationRepo.markAsRead(id);
  }

  deleteNotification(id) {
    return this.notificationRepo.delete(id);
  }

  // ==========================================================================
  // 처방 프리셋 관리 API → PresetRepository
  // ==========================================================================

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
}

// 정적 상수 (하위 호환: 테스트와 외부 코드가 클래스 정적 멤버로 참조)
InventoryManager.DEFAULT_CATEGORY_ID = DEFAULT_CATEGORY_ID;
InventoryManager.LEGACY_UUID_PREFIX = LEGACY_UUID_PREFIX;

if (typeof module !== 'undefined') {
  module.exports = InventoryManager;
}
