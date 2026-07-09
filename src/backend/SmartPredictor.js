/**
 * @file SmartPredictor.js
 * @description 통계 기반 동적 안전 재고 예측 엔진.
 * 일평균 조제 소모량을 분석하여 최적의 안전 재고량을 제안하고 발주 리스트를 생성합니다.
 */

class SmartPredictor {
  /**
   * @param {InventoryManager} dbManager 
   */
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  /**
   * 특정 기간(일) 동안 각 약재별로 일평균 조제 소모량을 계산합니다.
   * 대상: stock_logs 테이블에서 type = 'CONSUME'인 로그
   * @param {number} analysisDays 분석 기간 (기본값 30일, 30~90일 권장)
   * @returns {Map<number, number>} Map (medicineId => 일평균 소모 g수)
   */
  calculateDailyAverageConsumption(analysisDays = 30) {
    const dailyAverages = new Map();
    const currentMedicines = this.dbManager.getAllMedicines();
    
    // 기본적으로 모든 약재의 일평균 소모량을 0으로 초기화
    currentMedicines.forEach(m => dailyAverages.set(m.id, 0));

    if (this.dbManager.isMock) {
      // Mock 데이터 분석 처리
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - (analysisDays * 24 * 60 * 60 * 1000));
      
      const consumeLogs = this.dbManager.mockData.stock_logs.filter(log => {
        if (log.type !== 'CONSUME') return false;
        const logDate = new Date(log.timestamp.replace(' ', 'T'));
        return logDate >= cutoffTime;
      });

      // 약재별 소모 총량 계산
      const totals = {};
      consumeLogs.forEach(log => {
        // 소모량은 로그에 음수로 찍히므로 절대값 적용
        const qty = Math.abs(log.quantity);
        totals[log.medicine_id] = (totals[log.medicine_id] || 0) + qty;
      });

      // 일평균 소모량 산출
      Object.keys(totals).forEach(medId => {
        const id = parseInt(medId);
        dailyAverages.set(id, totals[id] / analysisDays);
      });
    } else {
      // SQLite 데이터베이스 쿼리 실행
      // 현재 날짜 기준 analysisDays일 전부터의 CONSUME 로그 집계
      const query = `
        SELECT medicine_id, SUM(ABS(quantity)) as total_consumed
        FROM stock_logs
        WHERE type = 'CONSUME'
          AND timestamp >= datetime('now', '-' || ? || ' days', 'localtime')
        GROUP BY medicine_id
      `;
      try {
        const rows = this.dbManager.db.prepare(query).all(analysisDays);
        rows.forEach(row => {
          dailyAverages.set(row.medicine_id, row.total_consumed / analysisDays);
        });
      } catch (err) {
        console.error('SQLite 소모량 조회 실패:', err);
      }
    }

    return dailyAverages;
  }

  /**
   * 약재별 배송 리드 타임(주문 후 도착까지 걸리는 기간)을 기준으로 최소 보유 필요량(동적 안전 재고)을 제안합니다.
   * 계산 공식: safety_stock_suggested = 일평균 소모량 * leadTimeDays
   * @param {number} leadTimeDays 배송 리드 타임 (일 단위, 기본값 7일)
   * @param {number} analysisDays 소모량 분석 기준 일수 (기본값 30일)
   * @returns {array} 제안 정보 리스트
   */
  getSafetyStockSuggestions(leadTimeDays = 7, analysisDays = 30) {
    const dailyAverages = this.calculateDailyAverageConsumption(analysisDays);
    const medicines = this.dbManager.getAllMedicines();

    return medicines.map(med => {
      const dailyAvg = dailyAverages.get(med.id) || 0;
      // 동적 안전 재고 제안값 (소수점 첫째자리 반올림)
      const suggestedSafetyStock = Math.round(dailyAvg * leadTimeDays * 10) / 10;
      
      return {
        medicineId: med.id,
        name: med.name,
        category: med.category,
        currentSafetyStock: med.safety_stock,
        suggestedSafetyStock: suggestedSafetyStock,
        dailyAverage: Math.round(dailyAvg * 100) / 100,
        unit: med.unit
      };
    });
  }

  /**
   * 제안된 동적 안전 재고량으로 DB 마스터 테이블(medicines)의 safety_stock을 갱신합니다.
   * @param {number} leadTimeDays 
   * @param {number} analysisDays 
   * @returns {boolean} 성공 여부
   */
  updateSafetyStocksToSuggested(leadTimeDays = 7, analysisDays = 30) {
    const suggestions = this.getSafetyStockSuggestions(leadTimeDays, analysisDays);

    if (this.dbManager.isMock) {
      suggestions.forEach(s => {
        const med = this.dbManager.mockData.medicines.find(m => m.id === s.medicineId);
        if (med) {
          med.safety_stock = s.suggestedSafetyStock;
        }
      });
      return true;
    } else {
      const transaction = this.dbManager.db.transaction(() => {
        const stmt = this.dbManager.db.prepare('UPDATE medicines SET safety_stock = ? WHERE id = ?');
        suggestions.forEach(s => {
          stmt.run(s.suggestedSafetyStock, s.medicineId);
        });
      });
      transaction();
      return true;
    }
  }

  /**
   * current_stock < safety_stock 상태인 약재들만 필터링하여
   * "부족한 총량 + 다음 달 예상 소모량(일평균 * 30)"을 합산한 '원클릭 발주 필요 리스트' 생성
   * @param {number} leadTimeDays 안전 재고 계산용 리드 타임
   * @param {number} analysisDays 소모량 분석 기준 일수
   * @returns {array} 발주 제안 목록
   */
  getReorderList(leadTimeDays = 7, analysisDays = 30) {
    const dailyAverages = this.calculateDailyAverageConsumption(analysisDays);
    const medicines = this.dbManager.getAllMedicines();
    const reorderList = [];

    medicines.forEach(med => {
      const dailyAvg = dailyAverages.get(med.id) || 0;
      
      // 현재 실시간 총 재고량
      const stockInfo = this.dbManager.getTotalStock(med.id);
      const currentStock = stockInfo.totalStock;
      
      // 안전 재고 기준량 (현재 DB 설정값 기준)
      const safetyStock = med.safety_stock;

      // 재고가 안전 재고 미만인 경우 발주 리스트에 추가
      if (currentStock < safetyStock) {
        // 1. 부족한 총량
        const deficit = Math.max(0, safetyStock - currentStock);
        
        // 2. 다음 달 예상 소모량 = 일평균 소모량 * 30일
        const nextMonthEstimate = dailyAvg * 30;

        // 3. 발주 필요량 = 부족한 총량 + 다음 달 예상 소모량
        const orderQuantityGrams = deficit + nextMonthEstimate;

        // 4. 포장 규격(pack_size)을 고려한 필요 팩(봉지) 수 계산 (올림 처리)
        const orderPacks = Math.ceil(orderQuantityGrams / med.pack_size);
        
        // 최종 제안 발주량 (팩 수 * 팩 규격)
        const recommendedOrderGrams = orderPacks * med.pack_size;

        reorderList.push({
          medicineId: med.id,
          name: med.name,
          category: med.category_name,
          packSize: med.pack_size,
          unit: med.unit,
          currentStock: Math.round(currentStock * 10) / 10,
          formattedStock: stockInfo.formatted,
          safetyStock: safetyStock,
          deficit: Math.round(deficit * 10) / 10,
          nextMonthEstimate: Math.round(nextMonthEstimate * 10) / 10,
          orderQuantityGrams: Math.round(orderQuantityGrams * 10) / 10,
          orderPacks: orderPacks,
          recommendedOrderGrams: recommendedOrderGrams
        });
      }
    });

    return reorderList;
  }
}

module.exports = SmartPredictor;
