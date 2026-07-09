/**
 * @file CSVHandler.js
 * @description CSV 가져오기 및 내보내기 핵심 비즈니스 로직.
 * 2차 변경: 동적 카테고리 테이블 연동 및 헤더 자동 판별, 유효성 완화 규칙 결합
 */

let fs;
try {
  fs = require('fs');
} catch (e) {
  // 브라우저/렌더러 환경 대응
}

class CSVHandler {
  /**
   * 숫자가 들어가야 하는 컬럼에 한글/영어 단위 문자가 섞여 있을 때 숫자를 추출해내는 방어적 유효성 가공기
   */
  static cleanNumber(value) {
    if (value === undefined || value === null || value === '') {
      return 0;
    }
    if (typeof value === 'number') {
      return value;
    }

    let cleaned = value.toString().replace(/[^0-9.]/g, '');
    const dots = cleaned.split('.');
    if (dots.length > 2) {
      cleaned = dots[0] + '.' + dots.slice(1).join('');
    }

    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  /**
   * CSV 텍스트 한 행을 파싱하는 RFC 4180 준수 파서
   */
  static parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  /**
   * CSV 원본 데이터를 파싱하여 약재 마스터 DB에 적재 (카테고리 ID 연동)
   * @param {string} csvContent 
   * @param {InventoryManager} dbManager 
   */
  static importFromCSV(csvContent, dbManager) {
    const lines = csvContent.split(/\r?\n/);
    if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
      return { successCount: 0, skipCount: 0, errors: ['불러올 데이터가 없습니다.'] };
    }

    // 첫 번째 줄이 헤더인지 판단 (약재명, 카테고리 등 주요 키워드 매칭)
    const firstLineColumns = this.parseCSVLine(lines[0]);
    const headerKeywords = ['약재명', '약재', '이름', 'name', '카테고리', '규격', '단위', '잔량', '재고'];
    const isHeader = firstLineColumns.some(col => 
      headerKeywords.some(keyword => col.toLowerCase().includes(keyword))
    );

    let successCount = 0;
    let skipCount = 0;
    const errors = [];
    const insertedNames = new Set();

    // 기존 DB 약재명 캐싱
    try {
      const existingMedicines = dbManager.getAllMedicines();
      existingMedicines.forEach(m => insertedNames.add(m.name));
    } catch (e) {
      console.warn('기존 약재 목록 로딩 실패, 중복 필터링은 런타임에 의존합니다.', e);
    }

    const startIndex = isHeader ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const columns = this.parseCSVLine(line);

      // A 컬럼: 약재명 - 필수
      const name = columns[0] ? columns[0].trim() : '';
      if (!name) {
        errors.push(`행 ${i + 1} [약재명 누락]: 약재명이 비어 있어 행을 건너뛰었습니다.`);
        skipCount++;
        continue;
      }

      if (insertedNames.has(name)) {
        errors.push(`행 ${i + 1} [중복 스킵]: 약재명 "${name}"은(는) 이미 등록되어 있어 무시되었습니다.`);
        skipCount++;
        continue;
      }

      // B 컬럼: 카테고리 - 없으면 '미분류'
      const categoryName = (columns[1] ? columns[1].trim() : '') || '미분류';
      
      // 카테고리 DB 동적 추가 및 ID 획득
      let categoryId = 1;
      try {
        categoryId = dbManager.addCategory(categoryName);
      } catch (catErr) {
        console.warn(`카테고리 "${categoryName}" 등록 실패, 미분류(ID 1)로 대체합니다.`, catErr);
      }

      // C 컬럼: 팩 규격 - 없거나 0 이하면 기본 규격 500g 적용
      const rawPackSize = columns[2] ? columns[2].trim() : '';
      let packSize = this.cleanNumber(rawPackSize);
      if (packSize <= 0) {
        packSize = 500;
      }

      // D 컬럼: 미개봉 팩 수
      const rawUnopened = columns[3] ? columns[3].trim() : '';
      const unopenedPacks = rawUnopened === '' ? 0 : Math.floor(this.cleanNumber(rawUnopened));

      // E 컬럼: 개봉 팩 잔량
      const rawRemain = columns[4] ? columns[4].trim() : '';
      let openedPackRemain = rawRemain === '' ? 0 : this.cleanNumber(rawRemain);

      // 잔량이 규격을 초과하면 팩 규격으로 강제 조정
      if (openedPackRemain > packSize) {
        openedPackRemain = packSize;
      }

      // F 컬럼: 안전 재고 수준 - 없으면 기본값 1000g
      const rawSafety = columns[5] ? columns[5].trim() : '';
      const safetyStock = rawSafety === '' ? 1000 : this.cleanNumber(rawSafety);

      // G 컬럼: 표시 단위
      const unit = (columns[6] ? columns[6].trim() : '') || 'g';

      try {
        dbManager.addMedicine({
          name,
          category_id: categoryId,
          pack_size: packSize,
          unopened_packs: unopenedPacks,
          opened_pack_remain: openedPackRemain,
          safety_stock: safetyStock,
          unit
        });

        insertedNames.add(name);
        successCount++;
      } catch (err) {
        errors.push(`행 ${i + 1} [DB 오류]: ${err.message}`);
        skipCount++;
      }
    }

    return {
      successCount,
      skipCount,
      errors
    };
  }

  /**
   * DB에 적재된 약재 목록을 가져와 CSV 규격 문자열로 생성
   */
  static exportToCSV(dbManager) {
    const medicines = dbManager.getAllMedicines();
    const header = ['약재명', '카테고리', '팩 규격', '미개봉 팩 수', '개봉 팩 잔량', '안전 재고 수준', '표시 단위'];
    const lines = [header.join(',')];

    medicines.forEach(m => {
      const escape = (val) => {
        const str = (val === undefined || val === null) ? '' : val.toString();
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const row = [
        escape(m.name),
        escape(m.category_name), // 2차 변경: category_name 사용
        m.pack_size,
        m.unopened_packs,
        m.opened_pack_remain,
        m.safety_stock,
        escape(m.unit)
      ];
      lines.push(row.join(','));
    });

    return lines.join('\n');
  }

  static importFromFilePath(filePath, dbManager) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`파일이 존재하지 않습니다: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return this.importFromCSV(content, dbManager);
  }

  static exportToFilePath(filePath, dbManager) {
    const csvContent = this.exportToCSV(dbManager);
    fs.writeFileSync(filePath, csvContent, 'utf-8');
    return true;
  }
}

if (typeof module !== 'undefined') {
  module.exports = CSVHandler;
}
