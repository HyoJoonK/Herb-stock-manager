# AGENTS.md

이 문서는 이 저장소에서 작업하는 AI 코딩 에이전트(및 신규 기여자)를 위한 기술 참조 문서입니다. 사용자 대상 설명은 [README.md](README.md), 버전 이력은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 프로젝트 개요

**HerbStockManager**는 한의원의 약재(한약재) 재고를 관리하는 Electron 데스크톱 앱입니다. 핵심 설계 목표는 **키보드만으로 처리하는 초고속 조제 워크플로우**이며, 로컬 SQLite를 단일 진실 공급원(source of truth)으로 사용하되 Supabase를 통한 선택적 클라우드 동기화를 지원합니다.

- 패키지명: `herb-stock-manager` (`package.json`)
- 진입점: [`src/main.js`](src/main.js)
- Node 통합 렌더러 (`nodeIntegration: true`, `contextIsolation: false`) — 렌더러 프로세스가 백엔드 모듈(`require`)을 직접 호출합니다. 이는 일반적인 Electron 보안 모범 사례(contextIsolation 활성화 + preload/IPC 분리)와 다르므로, 렌더러 코드는 신뢰할 수 있는 로컬 콘텐츠만 로드한다는 전제 하에 동작합니다.

## 아키텍처 개요

```
┌──────────────────────────────┐
│         Main Process         │
│         src/main.js          │
│  - BrowserWindow 생성/관리     │
│  - 스플래시 화면 + 자동 업데이트 │
│  - IPC: get-app-version,      │
│    check-for-updates-manual   │
└──────────────┬────────────────┘
               │ loadFile (nodeIntegration)
┌──────────────▼────────────────┐
│      Renderer Process         │
│   src/frontend/renderer.js    │
│  - UI 렌더링, 이벤트 핸들링      │
│  - InventoryManager 직접 호출   │
│  - QuickSearchEngine (키보드)  │
└──────────────┬────────────────┘
               │ require() 직접 호출
┌──────────────▼────────────────┐
│         Backend 모듈           │
│  src/backend/                 │
│  - InventoryManager.js        │ ← SQLite 스키마 + CRUD + Supabase 동기화
│  - SmartPredictor.js          │ ← 소모량 분석 → 안전재고/발주 예측
│  - CSVHandler.js              │ ← CSV 가져오기/내보내기
└──────────────┬────────────────┘
               │ better-sqlite3 (동기 API)
        ┌──────▼──────┐        선택적 양방향 동기화        ┌────────────────┐
        │   SQLite     │ ◄─────────────────────────────► │ Supabase       │
        │ (로컬 파일)   │   (동기화 큐 + Realtime 구독)      │ (Postgres)     │
        └──────────────┘                                  └────────────────┘
```

렌더러가 `InventoryManager`를 직접 `new`하여 사용하므로, 메인 프로세스와 렌더러 프로세스 사이에 데이터 관련 IPC는 없습니다. `main.js`의 IPC는 오직 **자동 업데이트 상태 전달**과 **앱 버전 조회**에만 쓰입니다.

## 핵심 모듈

### `src/main.js` — Electron 메인 프로세스
- 스플래시 윈도우(`splash.html`, 프레임 없음/투명) → 업데이트 체크 → 메인 윈도우(`index.html`) 순서로 기동.
- `electron-updater` 기반 자동 업데이트: 기동 시 1회 체크 + 3시간마다 백그라운드 체크. 개발 모드(`!app.isPackaged`)에서는 실제 서버 호출 없이 타임라인을 시뮬레이션합니다.
- 5초 타임아웃(`startStartupTimeout`)으로 업데이트 서버 응답 지연 시에도 메인 윈도우를 강제 노출.
- 싱글 인스턴스 락(`requestSingleInstanceLock`)으로 중복 실행 방지.
- 등록된 IPC 채널:
  - `get-app-version` (handle): 현재 앱 버전 반환
  - `check-for-updates-manual` (on): 사용자가 수동으로 업데이트 확인을 트리거

### `src/backend/InventoryManager.js` — DB 스키마 및 핵심 비즈니스 로직
가장 크고 중요한 모듈입니다. `better-sqlite3`(동기 API)를 사용하며, 생성자에서 스키마를 생성/마이그레이션합니다.

**주요 테이블**
| 테이블 | 역할 |
|---|---|
| `categories` | 약재 분류. `id=1`은 항상 존재하는 기본 카테고리('미분류')이며 삭제/이름 변경 불가 |
| `medicines` | 약재 마스터. `unopened_packs`(미개봉 팩 수) + `opened_pack_remain`(개봉 팩 잔량)으로 재고 표현. `is_presence_only`는 계량 없이 '있음/없음'만 관리하는 약재용 |
| `medicine_aliases` | 약재 이명(별칭). 검색 시 원 약재명과 함께 매칭 |
| `prescriptions` | 처방(조제) 헤더. `is_deducted`로 재고 차감 여부 추적 |
| `prescription_items` | 처방에 포함된 약재별 사용량 |
| `prescription_presets` / `prescription_preset_items` | 자주 쓰는 처방 조합 프리셋 (마스터/상세) |
| `stock_logs` | 재고 변동 이력 (`IN`/`CONSUME`/`WASTE`/`ADJUST`). `SmartPredictor`의 소모량 분석 원천 데이터 |
| `notifications` | 안전 재고 미달 등 알림함 |
| `deleted_records` | 로컬 삭제 이력. Supabase 동기화 시 원격에도 삭제를 전파하기 위한 tombstone 테이블 |
| `sync_queue` | Supabase 업로드 대기열 (`UPSERT`/`DELETE`/`REPLACE_PRESET_ITEMS`) |

스키마 변경은 `initDb()` 내부에서 `ALTER TABLE ... ADD COLUMN`을 `try/catch`로 감싸 **멱등적으로(idempotent)** 적용합니다(이미 컬럼이 있으면 예외를 무시). 새 컬럼을 추가할 때는 이 패턴을 따르세요 — 별도의 마이그레이션 파일/버전 관리 시스템은 없습니다.

**동기화 엔진 (Supabase 하이브리드 캐시/동기화 모델)**
- `setupSupabase(url, key)`: 연결 테스트 → 서버-로컬 시계 오프셋 계산(`calculateClockOffset`) → 전체 벌크 동기화(`syncAll`) → Realtime 구독(`subscribeRealtime`) → 대기 중인 큐 처리.
- **Last-Write-Wins**: 모든 동기화 대상 테이블(`categories`, `medicines`, `prescriptions`, `medicine_aliases`, `prescription_presets`)은 `updated_at` 타임스탬프를 비교해 더 최신인 쪽을 채택합니다 (`shouldOverwriteWithRemote`).
- **시계 보정**: 클라이언트-서버 시계가 어긋나면 Last-Write-Wins 판정이 틀어지므로, HTTP 응답 헤더의 `Date`와 RTT(왕복시간)를 이용해 `clockOffset`을 계산하고 `getAdjustedSqliteTime()`으로 보정된 타임스탬프를 기록합니다.
- **동기화 큐 (`sync_queue` 테이블)**: 즉시 네트워크 호출 대신 SQLite에 작업을 큐잉(`enqueueSync`)한 뒤 `processSyncQueue()`가 순차 처리합니다. 네트워크 오류로 판단되면(`isNetworkError`) 30초 후 재시도를 예약하고(`scheduleSyncRetry`) 큐 처리를 중단하며, 그 외 오류는 복구 불가로 간주해 해당 큐 항목을 스킵합니다.
- **오프라인 대응**: 브라우저 `online` 이벤트를 구독해 온라인 전환 시 자동으로 큐를 재처리합니다.
- **Realtime**: `postgres_changes` 구독으로 원격 변경을 수신하면 `handleRealtimeChange`가 로컬 SQLite에 즉시 반영하고, 등록된 콜백(`onDataChange`)으로 렌더러 UI 갱신을 트리거합니다.
- **CSV 대량 가져오기 시 동기화 최적화**: `CSVHandler.importFromCSV`는 가져오기 도중 `dbManager.supabase`를 일시적으로 `null`로 바꿔 개별 upsert를 막고, 트랜잭션 완료 후 `syncAll()`로 일괄 동기화합니다.

**주요 공개 API** (렌더러에서 직접 호출)
- 카테고리: `addCategory`, `updateCategory`, `deleteCategory`, `getAllCategories`
- 약재: `addMedicine`, `updateMedicine`, `deleteMedicine`, `getAllMedicines`, `getTotalStock`, `calculateStockInfo`
- 재고 변동: `consumeStock` / `consumeStockLocally`, `adjustStock`, `addStockLog`, `getLogsByMedicine`, `getAllLogs`
- 처방: `addPrescription`, `updatePrescriptionWithItems`, `deletePrescription`, `deductPrescriptionStock`, `getPrescriptionDetails`, `getAllPrescriptions`, `searchPrescriptions`
- 프리셋: `addPreset`, `updatePreset`, `deletePreset`, `getAllPresets`, `getPresetDetails`
- 알림: `getNotifications`, `markNotificationAsRead`, `deleteNotification`
- 클라우드: `setupSupabase`, `syncAll`, `onDataChange`

### `src/backend/SmartPredictor.js` — 통계 기반 재고 예측
`stock_logs`의 `CONSUME` 로그를 기간별(기본 30일)로 집계해 일평균 소모량을 계산하고, 이를 기반으로:
- `getSafetyStockSuggestions(leadTimeDays, analysisDays)`: `제안 안전재고 = 일평균 소모량 × 리드타임(일)`, 단 최소 하한은 `min(500g, 팩 규격)`.
- `updateSafetyStocksToSuggested(...)`: 위 제안값을 `medicines.safety_stock`에 실제 반영(트랜잭션 처리 + Supabase 동기화 트리거).
- `getReorderList(leadTimeDays, analysisDays)`: 현재 재고가 안전 재고 미만인 약재만 필터링해 `부족분 + 다음달 예상 소모량(일평균×30)`을 팩 단위로 올림 처리한 발주 제안 리스트 생성.

### `src/backend/CSVHandler.js` — CSV 가져오기/내보내기
- `parseCSV`: RFC 4180 준수 파서 (따옴표 이스케이프, 셀 내 개행/쉼표 처리)를 직접 구현. 외부 CSV 파싱 라이브러리에 의존하지 않습니다.
- `cleanNumber`: 한글/영문 단위가 섞인 숫자 문자열(예: `"500g"`)에서 숫자만 방어적으로 추출.
- `importFromCSV`: 헤더 자동 판별(첫 행에 `약재명`/`카테고리` 등 키워드 포함 여부로 판단) → 카테고리 동적 생성 → 약재명 중복 스킵 → 유효성 완화 규칙(빈 값에 기본값 적용) 적용 후 트랜잭션으로 일괄 삽입.
- `exportToCSV`: `getAllMedicines()` 결과를 CSV 문자열로 직렬화(쉼표/따옴표/개행 포함 값은 자동 이스케이프).

### `src/frontend/QuickSearchEngine.js` — 키보드 내비게이션 엔진
마우스 없이 전체 조작이 가능하도록 하는 포커스 상태 머신입니다.
- 포커스 상태: `search` → `category` → `list` → `popup` 를 순회.
- 한글 초성 검색 지원(`CHOSUNG_LIST`).
- 4대 탭(조회/처방/발주/일괄작업) 간 전역 단축키(Alt+1~4) 및 탭별 엔터 키 분기 처리(`onInquiryMed`, `onAddToBatch` 등).
- Shift 다중 선택 시 `selectedIds`(Set<number>) 및 `lastSelectedIndex`로 범위 선택 관리.
- 생성자에 `elements`(DOM 참조)와 `callbacks`(동작 콜백)을 주입받는 구조 — UI 프레임워크에 의존하지 않는 순수 JS 클래스입니다.

### `src/frontend/renderer.js`
메인 UI 로직(약 3,100줄). `electron`의 `ipcRenderer`를 사용해 앱 버전 조회 및 업데이트 상태 이벤트(`update-status`)만 수신하며, 나머지 데이터 작업은 `InventoryManager`/`SmartPredictor`/`CSVHandler`를 직접 호출합니다.

## 개발/빌드 워크플로우

```bash
npm install       # 의존성 설치 (better-sqlite3 네이티브 빌드 포함)
npm start         # electron . 실행 (개발 모드, 자동 업데이트 시뮬레이션)
npm run dist      # electron-builder로 배포 패키지 생성 (dist/)
```

### CI/CD ([`.github/workflows/build.yml`](.github/workflows/build.yml))
- 트리거: `main`/`master` push, `v*` 태그 push, 수동 실행(`workflow_dispatch`)
- 매트릭스: `windows-latest`, `macos-latest`
- `better-sqlite3`의 네이티브 컴파일 문제를 피하기 위해 `npm ci --ignore-scripts` 후 `node node_modules/electron/install.js`로 Electron 바이너리만 별도 다운로드
- macOS는 `--mac --arm64`, Windows는 `--win --x64`로 빌드
- 빌드 아티팩트를 모아 `package.json`의 `version`을 태그로 GitHub Release 생성 (`softprops/action-gh-release`)

### 버전 관리 규칙
- `package.json`의 `version`이 유일한 버전 소스입니다. 릴리스마다 이 값을 올리고, 대응하는 Git 태그(`vX.Y.Z`)와 [CHANGELOG.md](CHANGELOG.md) 항목을 추가하는 것이 이 저장소의 관례입니다 (커밋 이력 참고).

## 작업 시 유의 사항 (에이전트용)

1. **스키마 변경 시**: `InventoryManager.initDb()`에 `ALTER TABLE ... ADD COLUMN`을 `try/catch`로 추가하는 기존 패턴을 따르세요. 별도 마이그레이션 러너가 없습니다.
2. **동기화 대상 테이블을 수정/추가할 경우**: `syncAll()`(전체 동기화), `handleRealtimeChange()`(실시간 반영), `syncItemToSupabaseDirect()`(개별 업로드) 세 곳 모두에 대응 로직을 추가해야 합니다. 하나만 갱신하면 로컬-원격 데이터가 불일치할 수 있습니다.
3. **`updated_at` 타임스탬프**: 직접 `datetime('now')`를 쓰지 말고 `getAdjustedSqliteTime()`(clock-offset 보정)을 사용하세요. Last-Write-Wins 동기화의 정확성이 이 값에 의존합니다.
4. **삭제 처리**: 동기화 대상 레코드를 삭제할 때는 `recordDeleted()`로 tombstone을 남기고 `syncDeletedToSupabase()`(큐 등록)를 호출해야 원격에도 삭제가 전파됩니다.
5. **렌더러-백엔드 경계**: 이 프로젝트는 `nodeIntegration: true` 구조이므로 렌더러에서 백엔드 모듈을 직접 `require`합니다. 새로운 백엔드 기능도 이 패턴(직접 호출)을 유지하면 됩니다 — IPC 채널을 추가할 필요는 없습니다(자동 업데이트 관련 기능 제외).
6. **CSV 가져오기 로직 변경 시**: 대량 삽입 중 Supabase 동기화를 일시 차단하고 완료 후 `syncAll()`을 호출하는 성능 최적화 패턴(`CSVHandler.importFromCSV`)을 유지하세요.
7. **커밋 메시지**: 이 저장소는 한국어 커밋 메시지를 사용합니다 (`처방 프리셋 기능 구현`, `버그 수정` 등). 기존 관례를 따르세요.
