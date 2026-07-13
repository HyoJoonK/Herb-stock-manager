-- [SQL 1] 클라이언트의 재고 임의 덮어쓰기 방어 트리거
-- 대안 A 선택에 의해 주석 처리되었습니다. (클라이언트 JS에서 연산한 최종 재고 수치가 
-- Supabase medicines 테이블에 Upsert될 수 있도록 허용합니다.)
/*
CREATE OR REPLACE FUNCTION protect_medicine_stock_on_update()
RETURNS TRIGGER AS $$
BEGIN
  -- PG 내부의 stock_logs 연동 갱신을 제외한 클라이언트 직접 수정은 
  -- 기존 재고량(OLD)을 보존하도록 제약합니다.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  NEW.unopened_packs := OLD.unopened_packs;
  NEW.opened_pack_remain := OLD.opened_pack_remain;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_medicine_stock ON medicines;
CREATE TRIGGER trg_protect_medicine_stock
BEFORE UPDATE ON medicines
FOR EACH ROW
EXECUTE FUNCTION protect_medicine_stock_on_update();
*/



-- [SQL 2] stock_logs 삽입 및 갱신(덮어쓰기) 시 실시간 델타 연산 트리거
CREATE OR REPLACE FUNCTION sync_medicine_stock_on_log_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_pack_size REAL;
  v_unopened INT;
  v_remain REAL;
  v_delta REAL;
  v_abs_delta REAL;
  v_needed_packs INT;
  v_extra_packs INT;
BEGIN
  -- 1. 만약 UPDATE(덮어쓰기)이고 이전 레코드와 medicine_id 또는 quantity가 달라질 수 있으므로 OLD 데이터 롤백 적용
  IF TG_OP = 'UPDATE' THEN
    SELECT pack_size, unopened_packs, opened_pack_remain 
    INTO v_pack_size, v_unopened, v_remain
    FROM medicines
    WHERE id = OLD.medicine_id
    FOR UPDATE;

    IF FOUND THEN
      -- 기존 변동분을 롤백 (더했던 것은 빼고, 뺐던 것은 더함)
      v_remain := v_remain - OLD.quantity;
      IF v_remain >= v_pack_size THEN
        v_extra_packs := floor(v_remain / v_pack_size);
        v_unopened := v_unopened + v_extra_packs;
        v_remain := v_remain - (v_extra_packs * v_pack_size);
      ELSIF v_remain < 0 THEN
        v_needed_packs := ceil(abs(v_remain) / v_pack_size);
        v_unopened := v_unopened - v_needed_packs;
        v_remain := v_remain + (v_needed_packs * v_pack_size);
        IF v_unopened < 0 THEN
          v_unopened := 0;
          v_remain := 0;
        END IF;
      END IF;

      UPDATE medicines 
      SET unopened_packs = v_unopened,
          opened_pack_remain = v_remain,
          updated_at = timezone('UTC'::text, now())
      WHERE id = OLD.medicine_id;
    END IF;
  END IF;

  -- 2. NEW 레코드의 재고 변동분 적용 (INSERT 및 UPDATE 공통)
  SELECT pack_size, unopened_packs, opened_pack_remain 
  INTO v_pack_size, v_unopened, v_remain
  FROM medicines
  WHERE id = NEW.medicine_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_delta := NEW.quantity;

  IF v_delta > 0 THEN
    -- 입고/증가 반영
    v_remain := v_remain + v_delta;
    IF v_remain >= v_pack_size THEN
      v_extra_packs := floor(v_remain / v_pack_size);
      v_unopened := v_unopened + v_extra_packs;
      v_remain := v_remain - (v_extra_packs * v_pack_size);
    END IF;
  ELSE
    -- 소모/감소 반영 (미개봉 팩 차감 로직 자동 수행)
    v_abs_delta := abs(v_delta);
    v_remain := v_remain - v_abs_delta;
    
    IF v_remain < 0 THEN
      v_needed_packs := ceil(abs(v_remain) / v_pack_size);
      v_unopened := v_unopened - v_needed_packs;
      v_remain := v_remain + (v_needed_packs * v_pack_size);
      
      IF v_unopened < 0 THEN
        v_unopened := 0;
        v_remain := 0;
      END IF;
    END IF;
  END IF;

  -- medicines 테이블의 실재고 원자적 반영
  UPDATE medicines 
  SET unopened_packs = v_unopened,
      opened_pack_remain = v_remain,
      updated_at = timezone('UTC'::text, now())
  WHERE id = NEW.medicine_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_medicine_stock ON stock_logs;
CREATE TRIGGER trg_sync_medicine_stock
AFTER INSERT OR UPDATE ON stock_logs
FOR EACH ROW
EXECUTE FUNCTION sync_medicine_stock_on_log_insert();



-- [SQL 3] stock_logs 삭제 시 실시간 델타 역연산 트리거 (처방 삭제/취소 시 재고 복원용)
CREATE OR REPLACE FUNCTION sync_medicine_stock_on_log_delete()
RETURNS TRIGGER AS $$
DECLARE
  v_pack_size REAL;
  v_unopened INT;
  v_remain REAL;
  v_delta REAL;
  v_abs_delta REAL;
  v_needed_packs INT;
  v_extra_packs INT;
BEGIN
  -- Row Locking 및 현재 재고 조회
  SELECT pack_size, unopened_packs, opened_pack_remain 
  INTO v_pack_size, v_unopened, v_remain
  FROM medicines
  WHERE id = OLD.medicine_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  -- 삭제된 로그의 수량을 반대로 적용 (즉, -delta)
  v_delta := -OLD.quantity;

  IF v_delta > 0 THEN
    -- 복원/증가 반영
    v_remain := v_remain + v_delta;
    IF v_remain >= v_pack_size THEN
      v_extra_packs := floor(v_remain / v_pack_size);
      v_unopened := v_unopened + v_extra_packs;
      v_remain := v_remain - (v_extra_packs * v_pack_size);
    END IF;
  ELSE
    -- 감소 반영
    v_abs_delta := abs(v_delta);
    v_remain := v_remain - v_abs_delta;
    
    IF v_remain < 0 THEN
      v_needed_packs := ceil(abs(v_remain) / v_pack_size);
      v_unopened := v_unopened - v_needed_packs;
      v_remain := v_remain + (v_needed_packs * v_pack_size);
      
      IF v_unopened < 0 THEN
        v_unopened := 0;
        v_remain := 0;
      END IF;
    END IF;
  END IF;

  -- medicines 테이블의 실재고 원자적 반영
  UPDATE medicines 
  SET unopened_packs = v_unopened,
      opened_pack_remain = v_remain,
      updated_at = timezone('UTC'::text, now())
  WHERE id = OLD.medicine_id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_medicine_stock_delete ON stock_logs;
CREATE TRIGGER trg_sync_medicine_stock_delete
AFTER DELETE ON stock_logs
FOR EACH ROW
EXECUTE FUNCTION sync_medicine_stock_on_log_delete();



-- [SQL 4] 각 테이블의 updated_at 자동 갱신 트리거 (Supabase 대시보드 수정 및 API 수정 지원)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  -- 클라이언트가 명시적으로 다르게 업데이트하지 않는 한 현재 UTC 시각으로 자동 갱신
  IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
    NEW.updated_at := timezone('UTC'::text, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- medicines 테이블
DROP TRIGGER IF EXISTS trg_update_medicines_updated_at ON medicines;
CREATE TRIGGER trg_update_medicines_updated_at
BEFORE UPDATE ON medicines
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- categories 테이블
DROP TRIGGER IF EXISTS trg_update_categories_updated_at ON categories;
CREATE TRIGGER trg_update_categories_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- prescriptions 테이블
DROP TRIGGER IF EXISTS trg_update_prescriptions_updated_at ON prescriptions;
CREATE TRIGGER trg_update_prescriptions_updated_at
BEFORE UPDATE ON prescriptions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();



-- [SQL 5] 실시간 DB 변경 구독(Replication) 활성화 SQL
-- 이 구문을 Supabase SQL Editor에서 실행해야 웹소켓을 통한 실시간 데이터 수신이 가능해집니다.
ALTER PUBLICATION supabase_realtime ADD TABLE categories;
ALTER PUBLICATION supabase_realtime ADD TABLE medicines;
ALTER PUBLICATION supabase_realtime ADD TABLE prescriptions;
ALTER PUBLICATION supabase_realtime ADD TABLE prescription_items;
ALTER PUBLICATION supabase_realtime ADD TABLE stock_logs;

