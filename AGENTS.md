# AGENTS.md

이 문서는 이 저장소에서 작업하는 AI 코딩 에이전트(및 신규 기여자)를 위한 기술 참조 문서입니다. 사용자 대상 설명은 [README.md](README.md), 버전 이력은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 프로젝트 개요

**HerbStockManager**는 한의원의 약재(한약재) 재고를 관리하는 Electron 데스크톱 앱입니다. 핵심 설계 목표는 **키보드만으로 처리하는 초고속 조제 워크플로우**이며, 로컬 SQLite를 단일 진실 공급원(source of truth)으로 사용하되 Supabase를 통한 선택적 클라우드 동기화를 지원합니다.

- 패키지명: `herb-stock-manager` (`package.json`)
- 진입점: [`src/main.js`](src/main.js)
- Node 통합 렌더러 (`nodeIntegration: true`, `contextIsolation: false`) — 렌더러 프로세스가 백엔드 모듈(`require`)을 직접 호출합니다. 이는 일반적인 Electron 보안 모범 사례(contextIsolation 활성화 + preload/IPC 분리)와 다르므로, 렌더러 코드는 신뢰할 수 있는 로컬 콘텐츠만 로드한다는 전제 하에 동작합니다.

v1.8.0에서 코드베이스 전체가 객체지향 계층 구조로 재구성되었습니다. 기능·공개 API·데이터 스키마는 이전과 동일합니다.

## 아키텍처 개요

```
┌───────────────────────────────────────────────┐
│                Main Process                    │
│  src/main.js            ← 앱 수명주기 + IPC 등록  │
│  src/main/WindowManager ← 스플래시/메인 윈도우     │
│  src/main/UpdateManager ← 자동 업데이트 흐름       │
└──────────────────┬────────────────────────────┘
                   │ loadFile (nodeIntegration)
┌──────────────────▼────────────────────────────┐
│              Renderer Process                  │
│  renderer.js  ← 부트스트랩 진입점                 │
│  App.js       ← 조립자 (탭 전환, CSV, 검색엔진 연결)│
│  core/        ← AppState·EventBus·DialogService │
│               ·NumericInput·ModalKeyboard·utils │
│  views/       ← MedicineList·Inquiry·Prescription│
│               ·Predict·Batch·Notification       │
│  components/  ← 모달 4종·ContextMenu·UsageChart  │
│  QuickSearchEngine.js ← 키보드 내비게이션 엔진     │
└──────────────────┬────────────────────────────┘
                   │ require() 직접 호출
┌──────────────────▼────────────────────────────┐
│         Backend (src/backend/)                 │
│  InventoryManager.js ← Facade (공개 API 유지)    │
│    ├─ db/            ← Database·TimeService·ids │
│    ├─ repositories/  ← 테이블별 CRUD 7종          │
│    ├─ services/      ← StockService·Prescription │
│    │                   Service·SmartPredictor·   │
│    │                   CSVHandler                │
│    └─ sync/          ← SyncEngine·TableMapper·   │
│                        ConflictResolver·SyncQueue│
│                        ·RealtimeSubscriber       │
└──────────────────┬────────────────────────────┘
                   │ better-sqlite3 (동기 API)
        ┌──────────▼──┐      선택적 양방향 동기화     ┌────────────────┐
        │   SQLite     │ ◄──────────────────────► │ Supabase       │
        │ (로컬 파일)   │  (동기화 큐 + Realtime 구독) │ (Postgres)     │
        └──────────────┘                           └────────────────┘
```

렌더러가 `InventoryManager`를 직접 `new`하여 사용하므로, 메인 프로세스와 렌더러 프로세스 사이에 데이터 관련 IPC는 없습니다. IPC는 오직 **자동 업데이트 상태 전달**(`update-status`, `check-for-updates-manual`)과 **앱 버전 조회**(`get-app-version`)에만 쓰입니다.

## 백엔드 구조 (`src/backend/`)

### `InventoryManager.js` — Facade

백엔드 객체 그래프 전체를 조립하고, 기존 공개 API 시그니처를 그대로 유지하는 위임 전용 클래스입니다(Strangler Fig 패턴). 렌더러와 테스트는 이 Facade만 호출하면 되고, 새 백엔드 코드를 작성할 때는 담당 Repository/Service를 직접 사용하는 것을 권장합니다.

하위 호환 프로퍼티: `manager.db`(better-sqlite3 원시 연결), `manager.supabase`(get/set — CSVHandler의 대량 가져오기 중 일시 차단 패턴 지원), `manager.clockOffset`, 정적 상수 `DEFAULT_CATEGORY_ID`/`LEGACY_UUID_PREFIX`.

### `db/` — 인프라 계층

| 파일 | 책임 |
|---|---|
| `Database.js` | SQLite 연결(WAL, FK ON), 전체 스키마 생성(`createSchema`), 레거시 정수 ID → UUID 마이그레이션(`migrateLegacyIntegerIds`) |
| `TimeService.js` | SQLite↔ISO8601 시간 변환, epoch 변환, 서버-로컬 시계 오프셋 계산(`calculateClockOffset`), 보정된 현재 시간(`getAdjustedSqliteTime`) |
| `ids.js` | `newUuid()`, `DEFAULT_CATEGORY_ID`, `LEGACY_UUID_PREFIX` — ID 규칙의 단일 정의 지점 |

### `repositories/` — 테이블별 CRUD

`BaseRepository`가 공통 의존성(ctx: db/time/sync)과 헬퍼(`now()`, `recordDeleted()`, `touch()`)를 제공하고, 각 Repository는 담당 테이블의 SQL만 소유합니다.

| Repository | 담당 테이블 |
|---|---|
| `CategoryRepository` | `categories` (+ 삭제 시 소속 약재 기본 카테고리 재배정) |
| `MedicineRepository` | `medicines`, `medicine_aliases` (+ 수정 시 오차 ADJUST 로그) |
| `PrescriptionRepository` | `prescriptions`, `prescription_items` **조회 전용** (쓰기는 PrescriptionService) |
| `PresetRepository` | `prescription_presets`, `prescription_preset_items` |
| `StockLogRepository` | `stock_logs` 조회 + 처방별 실차감량 집계 |
| `NotificationRepository` | `notifications` (로컬 전용, 동기화 안 함) |

### `services/` — 트랜잭션 단위 비즈니스 로직

- `StockService`: 소모(개봉 잔량 → 부족 시 미개봉 팩 자동 개봉 + 알림), 입고 분배, 폐기, CONSUME 로그 기준 재고 복원. `*Locally` 접미사 메서드는 트랜잭션을 시작하지 않는 순수 연산으로, 상위 트랜잭션 안에서 사용됩니다(중첩 트랜잭션 방지).
- `PrescriptionService`: 처방 생성/수정/삭제/후차감. 수정·삭제 시 복원은 처방 항목(amount)이 아닌 **실제 CONSUME 로그 집계** 기준입니다.
- `SmartPredictor`: `stock_logs`의 CONSUME 로그를 기간별(기본 30일)로 집계해 일평균 소모량 계산 → 안전 재고 제안(`getSafetyStockSuggestions`), 실제 반영(`updateSafetyStocksToSuggested`), 발주 리스트(`getReorderList`).
- `CSVHandler`: RFC 4180 준수 자체 파서, 헤더 자동 판별, 유효성 완화 규칙, 수식 인젝션 방어. 대량 가져오기 중 `dbManager.supabase`를 일시적으로 `null`로 바꿔 개별 upsert를 막고, 완료 후 `syncAll()`로 일괄 동기화합니다.

### `sync/` — Supabase 동기화 서브시스템

- `SyncEngine`: 오케스트레이터. `setupSupabase(url, key)` = 연결 테스트 → 시계 오프셋 계산 → `syncAll()` → Realtime 구독 → 대기 큐 처리. 개별 업로드 실행부(`syncItemToSupabaseDirect` 등)와 트리거 인터페이스(`syncItemToSupabase`, `syncDeletedToSupabase`, `syncPrescriptionToSupabase`, `syncPresetToSupabase`)를 제공합니다.
- `TableMapper`: **동기화 테이블 선언의 단일 등록 지점.** 테이블별 컬럼/시간 컬럼/충돌 정책(lww·insertOnly)/부모-자식 관계를 `SYNC_TABLES`에 선언하면 전체 동기화 루프, 실시간 반영, 개별 업로드가 모두 여기서 파생됩니다.
- `ConflictResolver`: Last-Write-Wins 판정(`shouldOverwriteWithRemote`) — `updated_at`을 UTC 기준으로 비교합니다.
- `SyncQueue`: 즉시 네트워크 호출 대신 SQLite `sync_queue`에 큐잉 후 순차 처리. 네트워크 장애는 30초 후 재시도, 데이터성 오류는 `retry_count` 5회 초과 시 `sync_failures`(dead-letter)로 이동해 이력을 보존합니다. 브라우저 `online` 이벤트 시 자동 재처리.
- `RealtimeSubscriber`: `postgres_changes` 구독 → LWW 판정 후 로컬 반영 → `onDataChange` 콜백으로 렌더러 UI 갱신 트리거.

### 주요 테이블

| 테이블 | 역할 |
|---|---|
| `categories` | 약재 분류. `DEFAULT_CATEGORY_ID`('미분류')는 항상 존재하며 삭제/이름 변경 불가 |
| `medicines` | 약재 마스터. `unopened_packs` + `opened_pack_remain`으로 재고 표현. `is_presence_only`는 '있음/없음'만 관리 |
| `medicine_aliases` | 약재 이명(별칭). 검색 시 원 약재명과 함께 매칭 |
| `prescriptions` / `prescription_items` | 처방 헤더(`is_deducted`로 차감 여부 추적) / 약재별 사용량 |
| `prescription_presets` / `prescription_preset_items` | 처방 프리셋 마스터/상세 |
| `stock_logs` | 재고 변동 이력 (`IN`/`CONSUME`/`WASTE`/`ADJUST`). SmartPredictor의 원천 데이터 |
| `notifications` | 알림함 (로컬 전용) |
| `deleted_records` | 삭제 tombstone (원격 삭제 전파용) |
| `sync_queue` / `sync_failures` | 업로드 대기열 / 재시도 초과 실패 이력 |

## 프런트엔드 구조 (`src/frontend/`)

- `renderer.js`: 부트스트랩 전용 진입점 (DPI 보정 + `new App().init()`). `index.html`은 이 파일 하나만 script 태그로 로드하며, 나머지는 `require`로 조립됩니다.
- `App.js`: 코디네이터. DB 초기화(`initDatabase`), View/컴포넌트 조립, `QuickSearchEngine` 콜백 연결, 메인 탭 전환(`switchTab`), CSV 가져오기/내보내기. View들은 `this.app`을 통해 서로의 공개 메서드를 호출합니다(예: `this.app.medicineList.render()`).
- `core/`
  - `AppState`: 구 전역 `let` 변수 15개(현재 탭, 처방 바구니, 편집 모드, 컨텍스트 대상 등)의 단일 소유자
  - `EventBus`: pub/sub. 현재 `'remote-data-changed'`(Realtime 원격 변경 → 화면 갱신)에 사용
  - `DialogService`: 공용 알림/확인 대화상자(네이티브 alert/confirm의 포커스 버그 대체) + 토스트. `window.showAlert`/`window.showConfirm` 전역도 노출(QuickSearchEngine 호환)
  - `NumericInput` / `ModalKeyboard`: 문서 전역 위임 방식의 숫자 입력 정제 / 모달 키보드 제어(Esc·Enter·Tab 트랩·방향키)
- `views/`: `BaseView`(app 참조 + `$()` 헬퍼) 기반 6종 — `MedicineListView`(조회/처방/일괄 3개 탭 공용 좌측 목록·카테고리 탭), `InquiryView`, `PrescriptionView`(작성·이력·프리셋·편집 모드·패널 확장), `PredictView`, `BatchView`, `NotificationView`. 각 View는 자기 영역의 렌더링과 이벤트 바인딩(`bindEvents`)만 소유합니다.
- `components/`: `MedicineModal`, `CategoryModal`, `PrescriptionDetailModal`, `SettingsModal`(Supabase 설정 + 업데이트 UI — 렌더러에서 유일하게 IPC 사용), `ContextMenu`(표시/위치 보정만; 액션은 각 View가 바인딩), `UsageChart`(바닐라 Canvas)
- `QuickSearchEngine.js`: 키보드 내비게이션 포커스 상태 머신(`search` → `category` → `list` → `popup`), 한글 초성 검색, Alt+1~4 탭 전환, Shift 다중 선택. 생성자에 `elements`(DOM 참조)와 `callbacks`(동작 콜백)를 주입받는 UI 프레임워크 비의존 클래스 — 변경 없이 유지되었습니다.

## 메인 프로세스 구조 (`src/main.js`, `src/main/`)

- `main.js`: 싱글 인스턴스 락, 앱 수명주기, IPC 등록만 담당.
- `WindowManager`: 스플래시(프레임 없음/투명)·메인 윈도우 생성과 수명, 렌더러 상태 전송(`sendStatusToWindow`/`sendStatusToSplash`). 메인 윈도우는 `ready-to-show`(첫 페인트) 시 노출하며, 렌더러 초기화(`App.init`)가 끝나 첫 렌더링이 될 때까지는 `index.html`에 내장된 스켈레톤 UI가 목록 자리를 표시합니다(첫 렌더링이 innerHTML을 교체하며 자동 제거).
- `UpdateManager`: `electron-updater` 흐름 — 기동 시 1회 체크(+5초 타임아웃 Fallback으로 메인 윈도우 강제 노출), 수동 체크, 3시간 주기 백그라운드 체크. 개발 모드(`!app.isPackaged`)에서는 타임라인만 시뮬레이션.

## 개발/빌드 워크플로우

```bash
npm install       # 의존성 설치 (better-sqlite3 네이티브 빌드 포함)
npm start         # electron . 실행 (개발 모드, 자동 업데이트 시뮬레이션)
npm test          # node:test 단위 테스트 (Node ABI 필요 — 오류 시 npm rebuild better-sqlite3)
npm run dist      # electron-builder로 배포 패키지 생성 (dist/)
```

참고: `better-sqlite3`는 Electron ABI와 Node ABI가 다릅니다. `npm test`가 ABI 오류로 실패하면 `npm rebuild better-sqlite3`(Node용), `npm start`가 실패하면 `npx electron-builder install-app-deps`(Electron용)로 재빌드하세요.

### CI/CD ([`.github/workflows/build.yml`](.github/workflows/build.yml))
- 트리거: `main`/`master` push, `v*` 태그 push, 수동 실행(`workflow_dispatch`)
- 매트릭스: `windows-latest`, `macos-latest`
- `better-sqlite3`의 네이티브 컴파일 문제를 피하기 위해 `npm ci --ignore-scripts` 후 `node node_modules/electron/install.js`로 Electron 바이너리만 별도 다운로드
- macOS는 `--mac --arm64`, Windows는 `--win --x64`로 빌드
- 빌드 아티팩트를 모아 `package.json`의 `version`을 태그로 GitHub Release 생성 (`softprops/action-gh-release`)

### 버전 관리 규칙
- `package.json`의 `version`이 유일한 버전 소스입니다. 릴리스마다 이 값을 올리고, 대응하는 Git 태그(`vX.Y.Z`)와 [CHANGELOG.md](CHANGELOG.md) 항목을 추가하는 것이 이 저장소의 관례입니다.

## 작업 시 유의 사항 (에이전트용)

1. **스키마 변경 시**: `db/Database.js`의 `createSchema()`에 `CREATE TABLE IF NOT EXISTS` 또는 try/catch로 감싼 `ALTER TABLE ... ADD COLUMN`(멱등 패턴)을 추가하세요. 별도 마이그레이션 러너가 없습니다.
2. **동기화 대상 테이블을 추가/변경할 경우**: `sync/TableMapper.js`의 `SYNC_TABLES` 선언과 `SYNC_TABLE_ORDER`(FK 부모→자식 순서)만 갱신하면 전체 동기화·실시간 반영·개별 업로드가 모두 따라옵니다. (구버전처럼 세 곳을 따로 고칠 필요 없음)
3. **`updated_at` 타임스탬프**: 직접 `datetime('now')`를 쓰지 말고 `TimeService.getAdjustedSqliteTime()`(Repository/Service에서는 `this.now()`)을 사용하세요. Last-Write-Wins 동기화의 정확성이 이 값에 의존합니다.
4. **삭제 처리**: 동기화 대상 레코드를 삭제할 때는 `recordDeleted()`(BaseRepository 헬퍼)로 tombstone을 남기고 `sync.syncDeletedToSupabase()`를 호출해야 원격에도 삭제가 전파됩니다.
5. **새 백엔드 기능**: 담당 Repository/Service에 구현하고, 렌더러가 쓸 공개 API라면 `InventoryManager` Facade에 위임 메서드를 추가하세요. Facade의 기존 메서드 시그니처는 하위 호환을 위해 유지합니다.
6. **새 프런트엔드 기능**: 해당 영역의 View/컴포넌트에 구현하고 이벤트는 그 클래스의 `bindEvents()`에 바인딩하세요. 둘 이상의 View가 공유하는 상태는 `core/AppState.js`에, 뷰 로컬 UI 상태는 해당 View 필드에 둡니다. 다른 View 갱신은 `this.app.<view>.<method>()`로 호출합니다.
7. **트랜잭션 규약**: 상위 트랜잭션 안에서 재고 연산이 필요하면 `StockService`의 `*Locally` 메서드를 사용하세요. better-sqlite3는 중첩 트랜잭션을 지원하지 않습니다.
8. **CSV 가져오기 로직 변경 시**: 대량 삽입 중 `manager.supabase = null`로 개별 동기화를 차단하고 완료 후 `syncAll()`을 호출하는 성능 최적화 패턴을 유지하세요.
9. **커밋 메시지**: 이 저장소는 한국어 커밋 메시지를 사용합니다 (`처방 프리셋 기능 구현`, `버그 수정` 등). 기존 관례를 따르세요.
