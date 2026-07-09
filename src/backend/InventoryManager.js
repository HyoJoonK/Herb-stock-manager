/**
 * @file InventoryManager.js
 * @description 한의원 약재 재고 관리 데이터베이스 스키마 및 핵심 비즈니스 로직 구현 (SQLite/Mock 하이브리드 지원)
 * 3차 변경: 처방 테이블 note(메모) 필드 추가, 처방전 상세 정보 조회 및 과거이력 조회 기능 보강
 */

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('better-sqlite3 패키지를 로드할 수 없습니다. 메모리 내장 Mock DB 모드로 대체 구동합니다.');
}

class InventoryManager {
  /**
   * @param {string} dbPath 데이터베이스 파일 경로
   */
  constructor(dbPath = 'herb_inventory.db') {
    this.dbPath = dbPath;
    this.isMock = !Database;
    this.db = null;
    
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
        this.db.pragma('foreign_keys = ON');

        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
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
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
            timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
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
        return result.lastInsertRowid;
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
      formatted,
      unopened_packs,
      opened_pack_remain,
      pack_size,
      unit,
      name: med.name,
      category_id: med.category_id,
      categoryName
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
        return result.lastInsertRowid;
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
          this.db.prepare(`
            INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, note)
            VALUES (?, 'ADJUST', ?, datetime('now', 'localtime'), ?)
          `).run(medId, loss, `수동 데이터 보정 (오차: ${loss > 0 ? '+' : ''}${loss}g)`);
        }
      });

      transaction();
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
        this.db.prepare('DELETE FROM medicines WHERE id = ?').run(medicineId);
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
      const transaction = this.db.transaction(() => {
        const med = this.db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId);
        if (!med) throw new Error('약재를 찾을 수 없습니다.');

        const newStock = execute(med);

        this.db.prepare(`
          UPDATE medicines 
          SET unopened_packs = ?, opened_pack_remain = ?
          WHERE id = ?
        `).run(newStock.unopened_packs, newStock.opened_pack_remain, medicineId);

        this.db.prepare(`
          INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, prescription_id, note)
          VALUES (?, 'CONSUME', ?, datetime('now', 'localtime'), ?, ?)
        `).run(medicineId, -consumeGrams, prescriptionId, note || '처방 소모');
      });

      transaction();
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
        } else if (type === 'WASTE') {
          this.consumeStock(medicineId, Math.abs(quantity), null, note || '재고 폐기');
          return;
        }

        this.db.prepare('INSERT INTO stock_logs (medicine_id, type, quantity, timestamp, note) VALUES (?, ?, ?, datetime(\'now\', \'localtime\'), ?)')
          .run(medicineId, type, quantity, note);
      });
      transaction();
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
          VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
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
        const stockInfo = this.getTotalStock(m.id);
        return {
          ...m,
          total_stock: stockInfo.totalStock,
          formatted_stock: stockInfo.formatted,
          category_name: stockInfo.categoryName
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
        const stockInfo = this.getTotalStock(m.id);
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
