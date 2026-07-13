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
   * RFC 4180 규격을 엄격히 준수하여 전체 CSV 텍스트를 2차원 배열로 파싱합니다.
   * 셀 내부에 개행 문자(\n)나 쉼표(,)가 큰따옴표(")로 감싸진 경우를 올바르게 처리합니다.
   */
  static parseCSV(csvContent) {
    const result = [];
    let row = [];
    let current = '';
    let inQuotes = false;

    if (!csvContent) return result;

    for (let i = 0; i < csvContent.length; i++) {
      const char = csvContent[i];
      const nextChar = csvContent[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(current.trim());
        current = '';
      } else if ((char === '\r' || char === '\n') && !inQuotes) {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        row.push(current.trim());
        result.push(row);
        row = [];
        current = '';
      } else {
        current += char;
      }
    }

    if (current || row.length > 0) {
      row.push(current.trim());
      result.push(row);
    }

    return result.filter(r => r.length > 0 && (r.length > 1 || r[0] !== ''));
  }

  /**
   * CSV 원본 데이터를 파싱하여 약재 마스터 DB에 적재 (카테고리 ID 연동)
   * @param {string} csvContent 
   * @param {InventoryManager} dbManager 
   */
  static importFromCSV(csvContent, dbManager) {
    const rows = this.parseCSV(csvContent);
    if (rows.length === 0) {
      return { successCount: 0, skipCount: 0, errors: ['불러올 데이터가 없습니다.'] };
    }

    const firstRow = rows[0];
    const headerKeywords = ['약재명', '약재', '이름', 'name', '카테고리', '규격', '단위', '잔량', '재고'];
    const isHeader = firstRow.some(col => 
      headerKeywords.some(keyword => col.toLowerCase().includes(keyword))
    );

    let successCount = 0;
    let tempSuccessCount = 0; // 트랜잭션 롤백 시 카운트 오염을 방지하기 위한 임시 카운터
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

    // 성능 최적화: Supabase 동기화 임시 비활성화 및 로컬 SQLite 트랜잭션 사용
    const originalSupabase = dbManager.supabase;
    dbManager.supabase = null; // 대량 적재 도중 비동기 개별 업로드 방지

    const executeImport = () => {
      for (let i = startIndex; i < rows.length; i++) {
        const columns = rows[i];
        if (columns.length === 0 || (columns.length === 1 && !columns[0])) continue;

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

        // F 컬럼: 안전 재고 수준 - 없으면 기본값 500g
        const rawSafety = columns[5] ? columns[5].trim() : '';
        const safetyStock = rawSafety === '' ? 500 : this.cleanNumber(rawSafety);

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
          tempSuccessCount++;
        } catch (err) {
          errors.push(`행 ${i + 1} [DB 오류]: ${err.message}`);
          skipCount++;
        }
      }
    };

    if (dbManager.isMock) {
      executeImport();
      successCount = tempSuccessCount;
    } else {
      try {
        const transaction = dbManager.db.transaction(executeImport);
        transaction();
        successCount = tempSuccessCount; // 트랜잭션이 성공적으로 끝났을 때만 successCount 할당
      } catch (err) {
        errors.push(`대량 적재 중 심각한 트랜잭션 오류: ${err.message}`);
        successCount = 0; // 오류 시 롤백되므로 성공 수 0으로 초기화
      }
    }

    // Supabase 복원 및 일괄 동기화 실행
    dbManager.supabase = originalSupabase;
    if (dbManager.supabase && successCount > 0) {
      dbManager.syncAll().catch(syncErr => {
        console.error('CSV 임포트 후 일괄 동기화 실패:', syncErr);
      });
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
}

if (typeof module !== 'undefined') {
  module.exports = CSVHandler;
}
