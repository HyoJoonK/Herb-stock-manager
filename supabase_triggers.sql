-- [SQL 1] 클라이언트의 재고 임의 덮어쓰기 방어 트리거
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


-- [SQL 2] stock_logs 삽입 시 실시간 델타 연산 트리거
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
  -- Row Locking 및 현재 재고 조회
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
AFTER INSERT ON stock_logs
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
