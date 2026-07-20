-- =========================================================================
-- [Supabase 데이터베이스 통합 스키마 및 트리거 스크립트] (v1.7.0 / UUID 기본 키)
-- =========================================================================
-- * 목적:
--   이 스크립트는 아무 테이블이 없는 빈 Supabase 데이터베이스나,
--   이미 테이블이 존재하고 사용 중인 기존 데이터베이스(정수 ID 스키마 포함) 모두에서
--   에러 없이 안전하게 실행(Idempotent)될 수 있도록 설계되었습니다.
--
--   v1.7.0부터 모든 테이블의 기본 키는 UUID입니다.
--   - 신규 서버: 테이블이 UUID 기본 키로 생성됩니다.
--   - 기존(정수 BIGINT ID) 서버: 아래 마이그레이션 블록이 정수 ID를
--     '00000000-0000-4000-8000-' || 12자리 16진수(구 ID) 형태의 "결정적 UUID"로 변환합니다.
--     로컬 SQLite 클라이언트도 같은 규칙으로 마이그레이션하므로,
--     양쪽이 독립적으로 마이그레이션해도 같은 레코드는 같은 UUID를 갖습니다.
--
-- * AI 작성 가이드라인 (향후 작업 시 준수할 사항):
--   1. 테이블 생성은 'CREATE TABLE IF NOT EXISTS' 구문을 사용하여 최상단에 배치합니다.
--   2. 이미 존재하는 테이블의 스키마를 덮어쓰거나 무효화하지 않아야 합니다.
--   3. 외래 키(Foreign Key) 참조 관계를 고려하여 테이블 생성 순서를 유지해야 합니다.
--      (categories -> medicines -> prescriptions -> prescription_items, stock_logs, medicine_aliases -> presets)
--   4. 기본 데이터(categories의 '미분류')는 'ON CONFLICT DO NOTHING'을 사용하여 중복 삽입을 방지합니다.
--   5. 트리거 및 함수는 'CREATE OR REPLACE' 및 'DROP TRIGGER IF EXISTS'를 사용해 안전하게 덮어쓰도록 합니다.
--   6. 실시간 구독(Replication) 활성화 구문은 테이블 존재 여부를 체크하여 조건부 실행하도록 구성합니다.
--   7. 스키마 변경 마이그레이션은 information_schema/pg_catalog로 현재 상태를 검사한 뒤
--      필요한 경우에만 실행되는 DO 블록으로 작성합니다.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. 테이블 정의 (존재하지 않는 경우에만 UUID 스키마로 생성)
-- -------------------------------------------------------------------------

-- [1] categories 테이블
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- [2] medicines 테이블
CREATE TABLE IF NOT EXISTS medicines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  category_id UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid NOT NULL REFERENCES categories(id) ON DELETE SET DEFAULT,
  pack_size REAL NOT NULL CHECK(pack_size > 0),
  unopened_packs INTEGER DEFAULT 0 NOT NULL CHECK(unopened_packs >= 0),
  opened_pack_remain REAL DEFAULT 0 NOT NULL CHECK(opened_pack_remain >= 0),
  safety_stock REAL DEFAULT 0 NOT NULL CHECK(safety_stock >= 0),
  unit TEXT DEFAULT 'g' NOT NULL,
  memo TEXT,
  is_presence_only INTEGER DEFAULT 0 NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- medicines 테이블에 memo 컬럼 안전 마이그레이션 추가
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medicines' AND column_name = 'memo'
  ) THEN
    ALTER TABLE medicines ADD COLUMN memo TEXT;
  END IF;
END $$;

-- medicines 테이블에 is_presence_only 컬럼 안전 마이그레이션 추가
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medicines' AND column_name = 'is_presence_only'
  ) THEN
    ALTER TABLE medicines ADD COLUMN is_presence_only INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- [3] prescriptions 테이블
CREATE TABLE IF NOT EXISTS prescriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_name TEXT,
  patient_name TEXT NOT NULL,
  total_items INTEGER NOT NULL,
  note TEXT,
  is_deducted INTEGER DEFAULT 1 NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- prescriptions 테이블에 is_deducted 컬럼 안전 마이그레이션 추가
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prescriptions' AND column_name = 'is_deducted'
  ) THEN
    ALTER TABLE prescriptions ADD COLUMN is_deducted INTEGER NOT NULL DEFAULT 1;
  END IF;
END $$;

-- prescriptions 테이블의 prescription_name 컬럼 NOT NULL 제약조건 안전 제거
DO $$
BEGIN
  ALTER TABLE prescriptions ALTER COLUMN prescription_name DROP NOT NULL;
EXCEPTION
  WHEN OTHERS THEN
    NULL; -- 컬럼이 없는 등의 예외 무시
END $$;

-- [4] prescription_items 테이블
CREATE TABLE IF NOT EXISTS prescription_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE CASCADE NOT NULL,
  medicine_id UUID REFERENCES medicines(id) NOT NULL,
  amount REAL NOT NULL
);

-- [5] stock_logs 테이블
CREATE TABLE IF NOT EXISTS stock_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id UUID REFERENCES medicines(id) ON DELETE CASCADE NOT NULL,
  type TEXT CHECK(type IN ('IN', 'CONSUME', 'WASTE', 'ADJUST')) NOT NULL,
  quantity REAL NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  note TEXT
);

-- [6] medicine_aliases 테이블
CREATE TABLE IF NOT EXISTS medicine_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id UUID REFERENCES medicines(id) ON DELETE CASCADE NOT NULL,
  alias TEXT UNIQUE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- [7] prescription_presets 테이블 (처방전 프리셋 마스터)
CREATE TABLE IF NOT EXISTS prescription_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preset_name TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- [8] prescription_preset_items 테이블 (처방전 프리셋 약재 상세)
CREATE TABLE IF NOT EXISTS prescription_preset_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preset_id UUID REFERENCES prescription_presets(id) ON DELETE CASCADE NOT NULL,
  medicine_id UUID REFERENCES medicines(id) NOT NULL,
  amount REAL NOT NULL
);

-- [9] deleted_records 테이블 (서버 삭제 이력 보관용)
CREATE TABLE IF NOT EXISTS deleted_records (
  table_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  deleted_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  PRIMARY KEY (table_name, record_id)
);


-- -------------------------------------------------------------------------
-- 2. [v1.7.0 마이그레이션] 정수(BIGINT) ID → 결정적 UUID 변환
-- -------------------------------------------------------------------------
-- 기존 정수 ID 스키마 서버에서만 실행됩니다. (신규/이미 변환된 서버에서는 아무 것도 하지 않음)
-- 변환 규칙: id N  →  ('00000000-0000-4000-8000-' || lpad(to_hex(N), 12, '0'))::uuid
-- 로컬 SQLite 클라이언트(앱 v1.7.0)와 동일한 규칙이므로 레코드 대응 관계가 보존됩니다.

DO $$
DECLARE
  fk RECORD;
  needs_migration BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medicines' AND column_name = 'id' AND data_type = 'bigint'
  ) INTO needs_migration;

  IF NOT needs_migration THEN
    RETURN;
  END IF;

  RAISE NOTICE '[Migration] 정수 ID 스키마를 감지했습니다. UUID로 변환합니다...';

  -- 2-1. 대상 테이블 간의 모든 외래 키 제약을 이름과 무관하게 제거
  FOR fk IN
    SELECT conname, conrelid::regclass::text AS tbl
    FROM pg_constraint
    WHERE contype = 'f'
      AND connamespace = 'public'::regnamespace
      AND conrelid::regclass::text IN ('medicines', 'prescription_items', 'stock_logs', 'medicine_aliases', 'prescription_preset_items')
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.tbl, fk.conname);
  END LOOP;

  -- 2-2. IDENTITY 속성 제거 (타입 변경 전 필수) 및 기존 DEFAULT 제거
  ALTER TABLE categories ALTER COLUMN id DROP IDENTITY IF EXISTS;
  ALTER TABLE medicines ALTER COLUMN id DROP IDENTITY IF EXISTS;
  ALTER TABLE medicines ALTER COLUMN category_id DROP DEFAULT;
  ALTER TABLE prescriptions ALTER COLUMN id DROP IDENTITY IF EXISTS;
  ALTER TABLE prescription_items ALTER COLUMN id DROP IDENTITY IF EXISTS;
  ALTER TABLE stock_logs ALTER COLUMN id DROP IDENTITY IF EXISTS;
  ALTER TABLE medicine_aliases ALTER COLUMN id DROP IDENTITY IF EXISTS;

  -- 2-3. 기본 키 및 외래 키 컬럼 타입 변환 (결정적 UUID)
  ALTER TABLE categories ALTER COLUMN id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;

  ALTER TABLE medicines ALTER COLUMN id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;
  ALTER TABLE medicines ALTER COLUMN category_id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(category_id), 12, '0'))::uuid;

  ALTER TABLE prescriptions ALTER COLUMN id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;

  ALTER TABLE prescription_items ALTER COLUMN id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;
  ALTER TABLE prescription_items ALTER COLUMN prescription_id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(prescription_id), 12, '0'))::uuid;
  ALTER TABLE prescription_items ALTER COLUMN medicine_id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(medicine_id), 12, '0'))::uuid;

  ALTER TABLE stock_logs ALTER COLUMN id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;
  ALTER TABLE stock_logs ALTER COLUMN medicine_id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(medicine_id), 12, '0'))::uuid;
  ALTER TABLE stock_logs ALTER COLUMN prescription_id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(prescription_id), 12, '0'))::uuid;

  ALTER TABLE medicine_aliases ALTER COLUMN id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;
  ALTER TABLE medicine_aliases ALTER COLUMN medicine_id TYPE uuid
    USING ('00000000-0000-4000-8000-' || lpad(to_hex(medicine_id), 12, '0'))::uuid;

  -- 프리셋 테이블은 구 버전에 없을 수 있으므로 존재+타입 검사 후 변환
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prescription_presets' AND column_name = 'id' AND data_type = 'bigint'
  ) THEN
    ALTER TABLE prescription_presets ALTER COLUMN id DROP IDENTITY IF EXISTS;
    ALTER TABLE prescription_presets ALTER COLUMN id TYPE uuid
      USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;
    ALTER TABLE prescription_presets ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prescription_preset_items' AND column_name = 'id' AND data_type = 'bigint'
  ) THEN
    ALTER TABLE prescription_preset_items ALTER COLUMN id DROP IDENTITY IF EXISTS;
    ALTER TABLE prescription_preset_items ALTER COLUMN id TYPE uuid
      USING ('00000000-0000-4000-8000-' || lpad(to_hex(id), 12, '0'))::uuid;
    ALTER TABLE prescription_preset_items ALTER COLUMN preset_id TYPE uuid
      USING ('00000000-0000-4000-8000-' || lpad(to_hex(preset_id), 12, '0'))::uuid;
    ALTER TABLE prescription_preset_items ALTER COLUMN medicine_id TYPE uuid
      USING ('00000000-0000-4000-8000-' || lpad(to_hex(medicine_id), 12, '0'))::uuid;
    ALTER TABLE prescription_preset_items ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'deleted_records' AND column_name = 'record_id' AND data_type = 'bigint'
  ) THEN
    ALTER TABLE deleted_records ALTER COLUMN record_id TYPE uuid
      USING ('00000000-0000-4000-8000-' || lpad(to_hex(record_id), 12, '0'))::uuid;
  END IF;

  -- 2-4. 신규 기본값(gen_random_uuid) 및 category_id 기본값 설정
  ALTER TABLE categories ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE medicines ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE medicines ALTER COLUMN category_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
  ALTER TABLE prescriptions ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE prescription_items ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE stock_logs ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE medicine_aliases ALTER COLUMN id SET DEFAULT gen_random_uuid();

  RAISE NOTICE '[Migration] UUID 변환 완료.';
END $$;

-- 2-5. 외래 키 제약 재생성 (신규 생성 서버는 인라인 제약이 이미 있으므로 존재 검사 후 추가)
DO $$
BEGIN
  IF to_regclass('public.medicines') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'medicines_category_id_fkey'
  ) THEN
    ALTER TABLE medicines ADD CONSTRAINT medicines_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET DEFAULT;
  END IF;

  IF to_regclass('public.prescription_items') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prescription_items_prescription_id_fkey'
  ) THEN
    ALTER TABLE prescription_items ADD CONSTRAINT prescription_items_prescription_id_fkey
      FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.prescription_items') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prescription_items_medicine_id_fkey'
  ) THEN
    ALTER TABLE prescription_items ADD CONSTRAINT prescription_items_medicine_id_fkey
      FOREIGN KEY (medicine_id) REFERENCES medicines(id);
  END IF;

  IF to_regclass('public.stock_logs') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_logs_medicine_id_fkey'
  ) THEN
    ALTER TABLE stock_logs ADD CONSTRAINT stock_logs_medicine_id_fkey
      FOREIGN KEY (medicine_id) REFERENCES medicines(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.stock_logs') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_logs_prescription_id_fkey'
  ) THEN
    ALTER TABLE stock_logs ADD CONSTRAINT stock_logs_prescription_id_fkey
      FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.medicine_aliases') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'medicine_aliases_medicine_id_fkey'
  ) THEN
    ALTER TABLE medicine_aliases ADD CONSTRAINT medicine_aliases_medicine_id_fkey
      FOREIGN KEY (medicine_id) REFERENCES medicines(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.prescription_preset_items') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prescription_preset_items_preset_id_fkey'
  ) THEN
    ALTER TABLE prescription_preset_items ADD CONSTRAINT prescription_preset_items_preset_id_fkey
      FOREIGN KEY (preset_id) REFERENCES prescription_presets(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.prescription_preset_items') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prescription_preset_items_medicine_id_fkey'
  ) THEN
    ALTER TABLE prescription_preset_items ADD CONSTRAINT prescription_preset_items_medicine_id_fkey
      FOREIGN KEY (medicine_id) REFERENCES medicines(id);
  END IF;
END $$;

-- 2-6. 기본 카테고리 (미분류, 고정 UUID) 삽입
-- 마이그레이션된 서버는 id=1이 위 규칙에 의해 아래 UUID로 변환되어 이미 존재하므로 충돌 시 무시됩니다.
INSERT INTO categories (id, name)
VALUES ('00000000-0000-4000-8000-000000000001'::uuid, '미분류')
ON CONFLICT DO NOTHING;


-- -------------------------------------------------------------------------
-- 3. 트리거 및 함수 정의
-- -------------------------------------------------------------------------

-- [이중 차감 방지] 과거 버전에서 생성되었을 수 있는 stock_logs 실시간 재고 연산 트리거/함수를 완전히 제거합니다.
-- (클라이언트 JS에서 연산한 최종 재고 수치를 그대로 사용하는 '대안 A' 정책 유지)
DROP TRIGGER IF EXISTS trg_sync_medicine_stock ON stock_logs;
DROP FUNCTION IF EXISTS sync_medicine_stock_on_log_insert();

DROP TRIGGER IF EXISTS trg_sync_medicine_stock_delete ON stock_logs;
DROP FUNCTION IF EXISTS sync_medicine_stock_on_log_delete();

DROP TRIGGER IF EXISTS trg_protect_medicine_stock ON medicines;
DROP FUNCTION IF EXISTS protect_medicine_stock_on_update();


-- [SQL 1] 각 테이블의 updated_at 자동 갱신 트리거 (Supabase 대시보드 수정 및 API 수정 지원)
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

-- medicine_aliases 테이블
DROP TRIGGER IF EXISTS trg_update_medicine_aliases_updated_at ON medicine_aliases;
CREATE TRIGGER trg_update_medicine_aliases_updated_at
BEFORE UPDATE ON medicine_aliases
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- prescription_presets 테이블
DROP TRIGGER IF EXISTS trg_update_prescription_presets_updated_at ON prescription_presets;
CREATE TRIGGER trg_update_prescription_presets_updated_at
BEFORE UPDATE ON prescription_presets
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


-- [SQL 2] 서버 삭제 이력 기록 트리거 함수 및 트리거 정의
CREATE OR REPLACE FUNCTION log_deleted_record()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO deleted_records (table_name, record_id)
  VALUES (TG_TABLE_NAME, OLD.id)
  ON CONFLICT (table_name, record_id)
  DO UPDATE SET deleted_at = timezone('UTC'::text, now());
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- 각 테이블에 대한 삭제 감지 트리거 등록
DROP TRIGGER IF EXISTS trg_log_delete_categories ON categories;
CREATE TRIGGER trg_log_delete_categories
AFTER DELETE ON categories
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();

DROP TRIGGER IF EXISTS trg_log_delete_medicines ON medicines;
CREATE TRIGGER trg_log_delete_medicines
AFTER DELETE ON medicines
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();

DROP TRIGGER IF EXISTS trg_log_delete_prescriptions ON prescriptions;
CREATE TRIGGER trg_log_delete_prescriptions
AFTER DELETE ON prescriptions
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();

DROP TRIGGER IF EXISTS trg_log_delete_prescription_items ON prescription_items;
CREATE TRIGGER trg_log_delete_prescription_items
AFTER DELETE ON prescription_items
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();

DROP TRIGGER IF EXISTS trg_log_delete_stock_logs ON stock_logs;
CREATE TRIGGER trg_log_delete_stock_logs
AFTER DELETE ON stock_logs
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();

DROP TRIGGER IF EXISTS trg_log_delete_medicine_aliases ON medicine_aliases;
CREATE TRIGGER trg_log_delete_medicine_aliases
AFTER DELETE ON medicine_aliases
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();

DROP TRIGGER IF EXISTS trg_log_delete_prescription_presets ON prescription_presets;
CREATE TRIGGER trg_log_delete_prescription_presets
AFTER DELETE ON prescription_presets
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();

DROP TRIGGER IF EXISTS trg_log_delete_prescription_preset_items ON prescription_preset_items;
CREATE TRIGGER trg_log_delete_prescription_preset_items
AFTER DELETE ON prescription_preset_items
FOR EACH ROW EXECUTE FUNCTION log_deleted_record();


-- -------------------------------------------------------------------------
-- 4. 실시간 DB 변경 구독(Replication) 활성화
-- -------------------------------------------------------------------------
-- 이 구문을 Supabase SQL Editor에서 실행해야 웹소켓을 통한 실시간 데이터 수신이 가능해집니다.
DO $$
DECLARE
  t TEXT;
  tables_to_add TEXT[] := ARRAY['categories', 'medicines', 'prescriptions', 'prescription_items', 'stock_logs', 'medicine_aliases', 'prescription_presets', 'prescription_preset_items', 'deleted_records'];
BEGIN
  -- supabase_realtime publication이 없으면 생성
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY tables_to_add LOOP
    -- 테이블이 존재하고, publication에 등록되어 있지 않은 경우에만 추가
    IF to_regclass(t) IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pg_publication_rel pr
         JOIN pg_publication p ON p.oid = pr.prpubid
         JOIN pg_class c ON c.oid = pr.prrelid
         WHERE p.pubname = 'supabase_realtime' AND c.relname = t
       ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;
