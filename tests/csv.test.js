/**
 * @file csv.test.js
 * @description CSVHandler 파싱/정제/수식 인젝션 방어 단위 테스트 (node:test)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const CSVHandler = require('../src/backend/services/CSVHandler');
const InventoryManager = require('../src/backend/InventoryManager');

// ---------------------------------------------------------------------------
// parseCSV / cleanNumber
// ---------------------------------------------------------------------------

test('parseCSV는 RFC 4180 인용부호와 셀 내 개행/쉼표를 처리한다', () => {
  const rows = CSVHandler.parseCSV('a,"b,1","c\n2"\r\nd,e,f');
  assert.deepEqual(rows, [['a', 'b,1', 'c\n2'], ['d', 'e', 'f']]);
});

test('parseCSV는 이스케이프된 큰따옴표를 복원한다', () => {
  const rows = CSVHandler.parseCSV('"say ""hi""",x');
  assert.deepEqual(rows, [['say "hi"', 'x']]);
});

test('cleanNumber는 단위 문자가 섞인 값에서 숫자를 추출한다', () => {
  assert.equal(CSVHandler.cleanNumber('500g'), 500);
  assert.equal(CSVHandler.cleanNumber('1.5kg'), 1.5);
  assert.equal(CSVHandler.cleanNumber(''), 0);
  assert.equal(CSVHandler.cleanNumber('abc'), 0);
  assert.equal(CSVHandler.cleanNumber(300), 300);
});

// ---------------------------------------------------------------------------
// exportToCSV 수식 인젝션 방어 (#10)
// ---------------------------------------------------------------------------

test('내보내기 셀이 수식 문자로 시작하면 어퍼스트로피로 무력화된다 (#10)', () => {
  const m = new InventoryManager(':memory:');
  m.addMedicine({ name: '=HYPERLINK("http://evil")', pack_size: 500 });
  m.addMedicine({ name: '+SUM(A1:A9)', pack_size: 500 });
  m.addMedicine({ name: '감초', pack_size: 500 });

  const csv = CSVHandler.exportToCSV(m);
  const lines = csv.split('\n');

  const formulaLine = lines.find(l => l.includes('HYPERLINK'));
  assert.ok(formulaLine.startsWith(`"'=HYPERLINK(`));

  const plusLine = lines.find(l => l.includes('SUM'));
  assert.ok(plusLine.startsWith(`'+SUM(`));

  const normalLine = lines.find(l => l.startsWith('감초'));
  assert.ok(normalLine); // 일반 셀은 변형 없음
});

// ---------------------------------------------------------------------------
// importFromCSV 왕복
// ---------------------------------------------------------------------------

test('CSV 임포트는 카테고리를 동적 생성하고 약재를 적재한다', () => {
  const m = new InventoryManager(':memory:');
  const csv = [
    '약재명,카테고리,팩 규격,미개봉 팩 수,개봉 팩 잔량,안전 재고 수준,표시 단위',
    '감초,보약,500,2,100,500,g',
    '당귀,,300,1,0,,g'
  ].join('\n');

  const result = CSVHandler.importFromCSV(csv, m);
  assert.equal(result.successCount, 2);
  assert.equal(result.skipCount, 0);

  const meds = m.getAllMedicines();
  const gamcho = meds.find(x => x.name === '감초');
  assert.equal(gamcho.category_name, '보약');
  assert.equal(gamcho.total_stock, 1100);

  const danggui = meds.find(x => x.name === '당귀');
  assert.equal(danggui.category_id, InventoryManager.DEFAULT_CATEGORY_ID);
});

test('중복 약재명은 건너뛰고 에러 목록에 기록된다', () => {
  const m = new InventoryManager(':memory:');
  m.addMedicine({ name: '감초', pack_size: 500 });

  const result = CSVHandler.importFromCSV('감초,,500', m);
  assert.equal(result.successCount, 0);
  assert.equal(result.skipCount, 1);
  assert.match(result.errors[0], /중복/);
});
