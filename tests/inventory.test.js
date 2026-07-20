/**
 * @file inventory.test.js
 * @description InventoryManager 핵심 재고 연산/롤백/마이그레이션 단위 테스트 (node:test)
 *
 * 실행: npm test  (better-sqlite3가 현재 Node ABI로 빌드되어 있어야 합니다)
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');
const InventoryManager = require('../src/backend/InventoryManager');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createManager() {
  return new InventoryManager(':memory:');
}

function addBasicMedicine(m, overrides = {}) {
  return m.addMedicine({
    name: overrides.name || '감초',
    pack_size: overrides.pack_size !== undefined ? overrides.pack_size : 500,
    unopened_packs: overrides.unopened_packs !== undefined ? overrides.unopened_packs : 2,
    opened_pack_remain: overrides.opened_pack_remain !== undefined ? overrides.opened_pack_remain : 100,
    safety_stock: 500,
    unit: 'g',
    is_presence_only: overrides.is_presence_only || 0
  });
}

// ---------------------------------------------------------------------------
// 스키마 / UUID 기본
// ---------------------------------------------------------------------------

test('신규 DB는 UUID 스키마로 생성되고 기본 카테고리는 고정 UUID를 갖는다', () => {
  const m = createManager();
  const cats = m.getAllCategories();
  assert.equal(cats.length, 1);
  assert.equal(cats[0].id, InventoryManager.DEFAULT_CATEGORY_ID);
  assert.equal(cats[0].name, '미분류');

  const medId = addBasicMedicine(m);
  assert.match(medId, UUID_RE);
  assert.equal(m.getTotalStock(medId).totalStock, 2 * 500 + 100);
});

test('addCategory는 UUID를 반환하고 기본 카테고리 수정/삭제는 차단된다', () => {
  const m = createManager();
  const catId = m.addCategory('보약');
  assert.match(catId, UUID_RE);
  assert.throws(() => m.updateCategory(InventoryManager.DEFAULT_CATEGORY_ID, '변경'), /기본 카테고리/);
  assert.throws(() => m.deleteCategory(InventoryManager.DEFAULT_CATEGORY_ID), /기본 카테고리/);
});

// ---------------------------------------------------------------------------
// 소모(consume) 및 팩 개봉 연산
// ---------------------------------------------------------------------------

test('개봉 잔량 내에서 소모하면 잔량만 감소한다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 2팩(500g) + 100g
  m.consumeStock(medId, 40);
  const info = m.getTotalStock(medId);
  assert.equal(info.opened_pack_remain, 60);
  assert.equal(info.unopened_packs, 2);
});

test('잔량 초과 소모 시 새 팩을 개봉하고 알림이 생성된다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 2팩 + 100g
  m.consumeStock(medId, 300); // 100g 소진 후 1팩 개봉, 잔량 300g
  const info = m.getTotalStock(medId);
  assert.equal(info.unopened_packs, 1);
  assert.equal(info.opened_pack_remain, 300);

  const notis = m.getNotifications();
  assert.equal(notis.length, 1);
  assert.match(notis[0].message, /새 팩/);
});

test('총 재고를 초과하는 소모는 거부된다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 총 1100g
  assert.throws(() => m.consumeStock(medId, 1101), /재고가 부족/);
});

test('소모량 0/음수/비수치는 거부된다 (#9)', () => {
  const m = createManager();
  const medId = addBasicMedicine(m);
  assert.throws(() => m.consumeStock(medId, 0), /0보다 큰 숫자/);
  assert.throws(() => m.consumeStock(medId, -10), /0보다 큰 숫자/);
  assert.throws(() => m.consumeStock(medId, 'abc'), /0보다 큰 숫자/);
});

// ---------------------------------------------------------------------------
// 입고(addStockLog IN) 분배
// ---------------------------------------------------------------------------

test('입고량은 팩/잔량으로 올바르게 분배된다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m, { unopened_packs: 0, opened_pack_remain: 0 });
  m.addStockLog(medId, 'IN', 1200); // 500g 규격 → 2팩 + 200g
  const info = m.getTotalStock(medId);
  assert.equal(info.unopened_packs, 2);
  assert.equal(info.opened_pack_remain, 200);
});

test('입고 후 잔량이 규격을 넘으면 팩으로 승격된다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m, { unopened_packs: 0, opened_pack_remain: 400 });
  m.addStockLog(medId, 'IN', 200); // 400 + 200 = 600 → 1팩 + 100g
  const info = m.getTotalStock(medId);
  assert.equal(info.unopened_packs, 1);
  assert.equal(info.opened_pack_remain, 100);
});

test('입고량 0 이하와 미지원 로그 유형은 거부된다 (#9)', () => {
  const m = createManager();
  const medId = addBasicMedicine(m);
  assert.throws(() => m.addStockLog(medId, 'IN', 0), /0보다 큰 숫자/);
  assert.throws(() => m.addStockLog(medId, 'IN', -100), /0보다 큰 숫자/);
  assert.throws(() => m.addStockLog(medId, 'HACK', 10), /지원하지 않는/);
});

// ---------------------------------------------------------------------------
// updateMedicine 오차(loss) 계산 (#6)
// ---------------------------------------------------------------------------

test('수량만 변경 시 오차는 총량 차이와 같다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 2팩(500) + 100 = 1100g
  const loss = m.updateMedicine(medId, { unopened_packs: 1, opened_pack_remain: 50 }); // 550g
  assert.equal(loss, 550 - 1100);
});

test('팩 규격 변경 시 오차는 변경 전/후 각각의 규격으로 계산된다 (#6)', () => {
  const m = createManager();
  const medId = addBasicMedicine(m, { unopened_packs: 2, opened_pack_remain: 0 }); // 2×500 = 1000g
  const loss = m.updateMedicine(medId, { pack_size: 300 }); // 2×300 = 600g
  assert.equal(loss, 600 - 1000);

  const adjustLogs = m.getLogsByMedicine(medId).filter(l => l.type === 'ADJUST');
  assert.equal(adjustLogs.length, 1);
  assert.equal(adjustLogs[0].quantity, -400);
});

test('변경 사항이 실질적으로 없으면 ADJUST 로그가 생기지 않는다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m);
  const loss = m.updateMedicine(medId, { safety_stock: 900 });
  assert.equal(loss, 0);
  assert.equal(m.getLogsByMedicine(medId).filter(l => l.type === 'ADJUST').length, 0);
});

// ---------------------------------------------------------------------------
// 처방 생성/삭제/수정 롤백 (#12)
// ---------------------------------------------------------------------------

test('처방 삭제 시 실제 차감된 만큼 재고가 복원된다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 1100g
  const pId = m.addPrescription('감기약', '홍길동', [{ medicineId: medId, amount: 300 }]);
  assert.match(pId, UUID_RE);
  assert.equal(m.getTotalStock(medId).totalStock, 800);

  m.deletePrescription(pId);
  assert.equal(m.getTotalStock(medId).totalStock, 1100);
  assert.equal(m.getAllPrescriptions().length, 0);
});

test('미차감 처방 삭제 시 재고가 부풀지 않는다 (#12)', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 1100g
  const pId = m.addPrescription('감기약', '홍길동', [{ medicineId: medId, amount: 300 }], '', false);
  assert.equal(m.getTotalStock(medId).totalStock, 1100); // 미차감

  m.deletePrescription(pId);
  assert.equal(m.getTotalStock(medId).totalStock, 1100); // 복원 없음
});

test('단순 유무 관리 약재는 처방 삭제 시 재고가 오염되지 않는다 (#12)', () => {
  const m = createManager();
  const medId = addBasicMedicine(m, { name: '노루궁뎅이', is_presence_only: 1, unopened_packs: 1, opened_pack_remain: 0 });
  const pId = m.addPrescription(null, '홍길동', [{ medicineId: medId, amount: 50 }]);

  m.deletePrescription(pId);
  const info = m.getTotalStock(medId);
  assert.equal(info.unopened_packs, 1);
  assert.equal(info.opened_pack_remain, 0);
});

test('처방 수정 시 기존 차감이 복원된 후 새 수량으로 재차감된다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 1100g
  const pId = m.addPrescription('감기약', '홍길동', [{ medicineId: medId, amount: 300 }]);
  assert.equal(m.getTotalStock(medId).totalStock, 800);

  m.updatePrescriptionWithItems(pId, '감기약', '홍길동', [{ medicineId: medId, amount: 100 }], '', true);
  assert.equal(m.getTotalStock(medId).totalStock, 1000);

  const detail = m.getPrescriptionDetails(pId);
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].amount, 100);
});

test('처방/프리셋 항목의 0 이하 수량은 거부된다 (#9)', () => {
  const m = createManager();
  const medId = addBasicMedicine(m);
  assert.throws(() => m.addPrescription(null, '홍길동', [{ medicineId: medId, amount: 0 }]), /0보다 큰 숫자/);
  assert.throws(() => m.addPrescription(null, '홍길동', [{ medicineId: medId, amount: -5 }]), /0보다 큰 숫자/);
  assert.throws(() => m.addPreset('프리셋', '', [{ medicineId: medId, amount: 0 }]), /0보다 큰 숫자/);
});

test('미차감 처방을 나중에 차감할 수 있고 중복 차감은 거부된다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m); // 1100g
  const pId = m.addPrescription('보약', '홍길동', [{ medicineId: medId, amount: 200 }], '', false);
  assert.equal(m.getTotalStock(medId).totalStock, 1100);

  m.deductPrescriptionStock(pId);
  assert.equal(m.getTotalStock(medId).totalStock, 900);
  assert.throws(() => m.deductPrescriptionStock(pId), /이미 재고가 차감/);
});

// ---------------------------------------------------------------------------
// 프리셋 CRUD
// ---------------------------------------------------------------------------

test('프리셋 생성/수정/삭제가 UUID 기반으로 동작한다', () => {
  const m = createManager();
  const medId = addBasicMedicine(m);
  const presetId = m.addPreset('감기 기본', '메모', [{ medicineId: medId, amount: 10 }]);
  assert.match(presetId, UUID_RE);

  m.updatePreset(presetId, '감기 기본2', '메모2', [{ medicineId: medId, amount: 20 }]);
  const detail = m.getPresetDetails(presetId);
  assert.equal(detail.preset_name, '감기 기본2');
  assert.equal(detail.items[0].amount, 20);

  m.deletePreset(presetId);
  assert.equal(m.getAllPresets().length, 0);
});

// ---------------------------------------------------------------------------
// 레거시(정수 ID) → UUID 마이그레이션 (#5)
// ---------------------------------------------------------------------------

function buildLegacyDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE medicines (
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE prescriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_name TEXT,
      patient_name TEXT NOT NULL,
      total_items INTEGER NOT NULL,
      note TEXT,
      is_deducted INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE prescription_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id INTEGER NOT NULL,
      medicine_id INTEGER NOT NULL,
      amount REAL NOT NULL
    );
    CREATE TABLE stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medicine_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      prescription_id INTEGER,
      note TEXT
    );
    CREATE TABLE medicine_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medicine_id INTEGER NOT NULL,
      alias TEXT UNIQUE NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE deleted_records (
      table_name TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (table_name, record_id)
    );
  `);
  db.prepare("INSERT INTO categories (id, name) VALUES (1, '미분류')").run();
  db.prepare("INSERT INTO categories (id, name) VALUES (2, '보약')").run();
  db.prepare("INSERT INTO medicines (id, name, category_id, pack_size, unopened_packs, opened_pack_remain) VALUES (1, '감초', 2, 500, 2, 100)").run();
  db.prepare("INSERT INTO medicines (id, name, category_id, pack_size) VALUES (2, '당귀', 1, 300)").run();
  db.prepare("INSERT INTO medicine_aliases (id, medicine_id, alias) VALUES (1, 1, '국로')").run();
  db.prepare("INSERT INTO prescriptions (id, prescription_name, patient_name, total_items) VALUES (1, '감기약', '홍길동', 1)").run();
  db.prepare("INSERT INTO prescription_items (id, prescription_id, medicine_id, amount) VALUES (1, 1, 1, 300)").run();
  db.prepare("INSERT INTO stock_logs (id, medicine_id, type, quantity, prescription_id) VALUES (1, 1, 'CONSUME', -300, 1)").run();
  db.prepare("INSERT INTO deleted_records (table_name, record_id) VALUES ('medicines', 99)").run();
  db.close();
}

test('레거시 정수 ID DB가 결정적 UUID로 마이그레이션된다 (#5)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herb-migration-'));
  const dbPath = path.join(tmpDir, 'legacy.db');
  buildLegacyDb(dbPath);

  const m = new InventoryManager(dbPath);
  const P = InventoryManager.LEGACY_UUID_PREFIX;

  // 기본 카테고리(구 id=1)는 고정 UUID로 변환
  const cats = m.getAllCategories();
  assert.equal(cats.find(c => c.name === '미분류').id, InventoryManager.DEFAULT_CATEGORY_ID);
  assert.equal(cats.find(c => c.name === '보약').id, `${P}000000000002`);

  // 약재와 외래 키 대응 유지
  const meds = m.getAllMedicines();
  const gamcho = meds.find(x => x.name === '감초');
  assert.equal(gamcho.id, `${P}000000000001`);
  assert.equal(gamcho.category_id, `${P}000000000002`);
  assert.deepEqual(gamcho.aliases, ['국로']);
  assert.equal(gamcho.total_stock, 2 * 500 + 100);

  // 처방/항목/로그 대응 유지
  const detail = m.getPrescriptionDetails(`${P}000000000001`);
  assert.equal(detail.patient_name, '홍길동');
  assert.equal(detail.items[0].medicine_id, `${P}000000000001`);

  const logs = m.getLogsByMedicine(gamcho.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].prescription_id, `${P}000000000001`);

  // 삭제 이력 record_id도 변환
  const deleted = m.db.prepare('SELECT * FROM deleted_records').all();
  assert.equal(deleted[0].record_id, `${P}000000000063`); // 99 = 0x63

  // 마이그레이션 후 정상 동작 (처방 삭제 롤백)
  m.deletePrescription(detail.id);
  assert.equal(m.getTotalStock(gamcho.id).totalStock, 1400); // 1100 + 300 복원

  m.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 동기화 LWW 시간 비교 (#3)
// ---------------------------------------------------------------------------

test('LWW 비교는 로컬 시간을 UTC로 해석한다 (#3)', () => {
  const m = createManager();
  const medId = addBasicMedicine(m);

  // 로컬 updated_at을 UTC 기준 과거로 고정
  m.db.prepare("UPDATE medicines SET updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(medId);

  // 원격이 1초 더 최신(UTC) → 덮어써야 함
  assert.equal(m.shouldOverwriteWithRemote('medicines', medId, '2026-01-01T00:00:01Z'), true);
  // 원격이 1초 과거 → 유지
  assert.equal(m.shouldOverwriteWithRemote('medicines', medId, '2025-12-31T23:59:59Z'), false);
  // KST(+9h) 오프셋 함정: 로컬 'YYYY-MM-DD HH:mm:ss'를 로컬 시간으로 잘못 해석하면
  // 아래 비교(원격 +1분)가 false가 된다.
  assert.equal(m.shouldOverwriteWithRemote('medicines', medId, '2026-01-01T00:01:00Z'), true);
});
