# Changelog

이 프로젝트의 주요 변경 사항을 버전별로 기록합니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)를 참고하며, 버전 관리는 [Semantic Versioning](https://semver.org/lang/ko/)을 따릅니다.

## [Unreleased]

### Changed

- **기동 로딩 표시를 스플래시 유지 방식에서 스켈레톤 UI 방식으로 교체** (`src/frontend/index.html`, `src/frontend/style.css`, `src/main/WindowManager.js`, `src/frontend/renderer.js`, `src/frontend/splash.js`)
  - v1.8.1의 "렌더러 초기화 완료까지 스플래시 유지" 방식은 초기화가 느린 환경에서 스플래시가 수 초간 남아 기동이 늦어 보이는 단점이 있었습니다.
  - 메인 윈도우를 다시 첫 페인트(`ready-to-show`) 시점에 바로 노출하되, 조회 탭 좌측의 카테고리 탭·약재 목록 자리에 `index.html` 내장 스켈레톤 고스트를 표시합니다. `App.init`의 첫 렌더링이 컨테이너 innerHTML을 교체하면서 스켈레톤은 자동 제거됩니다.
  - 고스트는 실제 항목과 동일한 클래스 구조(`.medicine-item`/`.category-tab`/`.med-name`/`.med-stock`/`.status-badge`)에 텍스트 자리 바(`.skeleton-bar`, em 단위)와 투명 배지(`.skeleton-badge`)를 넣은 방식이라, 크기·간격이 실물 CSS에서 그대로 산출되어 화면 배율·폰트 변경에도 항상 실물과 일치합니다.
  - shimmer는 transform 기반 애니메이션이라 초기화(DB 로드)로 메인 스레드가 바쁜 동안에도 움직임이 유지됩니다.
  - 이에 따라 `renderer-init-complete` IPC와 스플래시의 데이터 로딩 진행률(60~95% 점진 상승, `ready` 100% 표시)을 제거하고, 스플래시는 업데이트 체크 전용으로 단순화했습니다. `UpdateManager.start()` 멱등화 수정은 그대로 유지됩니다.

## [1.8.1] - 2026-07-24

윈도우 저사양 환경의 기동 UX 개선(데이터 로딩 완료 후 창 노출)과 자동 업데이트 리스너 중복 등록 수정을 담은 패치 릴리스입니다.

### Fixed

- **저사양 Windows 환경에서 창이 뜬 뒤 4~5초간 데이터 없는 빈 화면이 보이던 문제** (`src/main/WindowManager.js`, `src/frontend/renderer.js`)
  - 기존에는 `ready-to-show`(첫 페인트) 이벤트로 메인 윈도우를 노출했는데, 이 이벤트는 렌더러의 DB 로드·첫 렌더링(`App.init`)이 실행되기 **전**에 발화하므로 초기화가 느린 환경(백신 실시간 검사·느린 디스크 등)에서 빈 스켈레톤 UI가 수 초간 노출되었습니다.
  - 렌더러가 초기화 완료 시 `renderer-init-complete` IPC 신호를 보내고, 메인 프로세스는 이 신호를 받은 뒤에만 창을 표시합니다. 그동안 스플래시가 유지되며, 신호 유실 대비 15초 타임아웃 안전장치를 두었습니다. init 중 오류가 나도 신호는 전송되어 창이 영영 숨겨지지 않습니다.

- **`UpdateManager.start()` 재호출 시 autoUpdater 리스너·정기 체크가 중복 등록되던 문제** (`src/main/UpdateManager.js`, `src/main.js`)
  - macOS에서 모든 창을 닫은 채 두 번째 인스턴스를 실행하면 `second-instance` 경로가 `start()`를 다시 호출해 이벤트 리스너 6종과 3시간 주기 체크가 이중 등록되었습니다(다운로드 완료 대화상자 중복 표시 등).
  - `start()`를 멱등하게 변경: 리스너 등록(`registerAutoUpdaterEvents()`)과 정기 체크 `setInterval`은 최초 1회만 수행하고, 재호출 시에는 기동 체크(스플래시 → 메인 윈도우 흐름)만 다시 실행합니다. 기동 타임아웃도 재호출 전에 정리해 잔여 타이머를 방지합니다.

### Changed

- **스플래시 진행률 표시 재조정** (`src/frontend/splash.js`, `src/main/WindowManager.js`)
  - 기존에는 업데이트 확인 완료 시점에 진행률이 100%가 되어, 이후 데이터 로딩 대기 동안 "100%인데 멈춰 있는" 오해를 일으켰습니다.
  - 새 배분: 업데이트 확인 중 15% → 최신 버전 확인/확인 오류 45% → 데이터 로딩(`starting`) 60%에서 95%까지 점진 상승(200ms 간격, 남은 거리 비례 감속) → 로딩 완료(`ready`) 시 100%를 채우고 200ms 뒤 메인 윈도우로 전환. 100%는 실제 종착점(로딩 완료·업데이트 설치 직전)에서만 표시됩니다.
  - 메인 윈도우 로드 시작 시 스플래시에 "재고 데이터를 불러오는 중..." 상태가 표시됩니다. (기존 splash.js의 미사용 `starting` 상태 활용)

## [1.8.0] - 2026-07-21

기능 변경 없이 코드베이스 전체를 객체지향 구조로 재구성한 리팩터링 릴리스입니다. 모든 공개 API·화면 동작·데이터 스키마는 v1.7.2와 동일하며, 단위 테스트 27개가 전 과정에서 통과 상태로 유지되었습니다.

### Changed (구조 — 백엔드)

- **`InventoryManager`(2,419줄)의 God Class 해체 → 계층형 구조로 분리**
  - `src/backend/db/`: `Database.js`(SQLite 연결·스키마·레거시 UUID 마이그레이션), `TimeService.js`(시간 파싱·clock offset 보정), `ids.js`(UUID 생성·ID 규칙 상수의 단일 정의 지점)
  - `src/backend/repositories/`: 테이블별 CRUD 전담 Repository 7종 — `BaseRepository`(공통 tombstone/타임스탬프 헬퍼), `CategoryRepository`, `MedicineRepository`, `PrescriptionRepository`, `PresetRepository`, `StockLogRepository`, `NotificationRepository`
  - `src/backend/services/`: 트랜잭션 단위 비즈니스 로직 — `StockService`(소모·팩 자동 개봉·입고 분배·폐기·복원 알고리즘), `PrescriptionService`(처방 생성·수정·삭제·후차감과 재고 롤백). 기존 `SmartPredictor`·`CSVHandler`도 이 디렉터리로 이동했습니다.
  - `src/backend/sync/`: Supabase 동기화 서브시스템 5종 — `SyncEngine`(오케스트레이터), `TableMapper`(동기화 테이블 선언의 **단일 등록 지점**), `ConflictResolver`(Last-Write-Wins 판정), `SyncQueue`(오프라인 안전 대기열·재시도·dead-letter), `RealtimeSubscriber`(실시간 수신·로컬 반영)
  - `InventoryManager.js`는 기존 공개 API 시그니처를 100% 유지하는 421줄 Facade로 축소되었습니다. 렌더러·테스트·CSV 흐름(`manager.supabase` 일시 차단 패턴 포함)은 수정 없이 그대로 동작합니다.
  - 효과: 과거 "동기화 테이블 추가 시 세 곳(`syncAll`/`handleRealtimeChange`/`syncItemToSupabaseDirect`)을 모두 고쳐야 하는" 산탄총 수정이 사라지고, `TableMapper`의 선언 한 곳만 갱신하면 됩니다.

### Changed (구조 — 프런트엔드)

- **`renderer.js`(3,443줄)의 절차적 스크립트 해체 → App 코디네이터 + 계층 구조**
  - `src/frontend/core/`: `AppState`(전역 `let` 상태 변수 15개를 단일 소유 클래스로 통합), `EventBus`(원격 변경 알림용 pub/sub), `DialogService`(공용 알림/확인/토스트), `NumericInput`(숫자 입력 정제), `ModalKeyboard`(Esc/Enter/Tab 트랩/방향키), `utils`(escapeHtml·KST 시간 포맷)
  - `src/frontend/views/`: `BaseView` + 화면 영역별 View 6종 — `MedicineListView`(3개 탭 공용 약재 목록·카테고리 탭), `InquiryView`(상세·차트·로그), `PrescriptionView`(작성·이력·프리셋·편집 모드·패널 확장), `PredictView`(발주 예측), `BatchView`(일괄 편집), `NotificationView`(알림함)
  - `src/frontend/components/`: `MedicineModal`, `CategoryModal`, `PrescriptionDetailModal`, `SettingsModal`(Supabase 설정+업데이트 UI), `ContextMenu`, `UsageChart`
  - `App.js`: DB 초기화, `QuickSearchEngine` 콜백 연결, 탭 전환(`switchTab`), CSV 가져오기/내보내기를 조립하는 코디네이터
  - `renderer.js`는 부트스트랩 전용 진입점(39줄)으로 축소되었고, `index.html`의 `QuickSearchEngine` script 태그를 제거하고 `require` 기반 모듈 로드로 통일했습니다.

### Changed (구조 — 메인 프로세스)

- **`main.js`(333줄) 분리** → `src/main/WindowManager.js`(스플래시/메인 윈도우 생성·수명·렌더러 상태 전송), `src/main/UpdateManager.js`(자동 업데이트 흐름: 기동/수동/정기 체크, 5초 타임아웃 Fallback). `main.js`는 앱 수명주기 + IPC 등록만 담당하는 73줄 진입점이 되었습니다.

## [1.7.2] - 2026-07-21

### Added

- **처방 탭 상/하 카드 세로 확장 토글** (`src/frontend/index.html`, `src/frontend/renderer.js`, `src/frontend/style.css`, `src/frontend/sf-icons.css`, `src/frontend/svg/chevron.up.svg`, `src/frontend/svg/chevron.down.svg`)
  - 처방 조제 작성(상단)·처방 완료 이력(하단) 카드 헤더에 확장 버튼을 추가했고, 헤더 빈 영역 더블클릭으로도 토글됩니다.
  - 상단 확장 시 하단 카드는 헤더만 남고 작성 카드가 그 위까지 세로로 확장되며(늘어난 공간은 약재 리스트만 차지), 하단 확장은 그 반대로 동작합니다.
  - 확장 상태는 다음 상호작용 시 자동으로 기본 분할로 복원됩니다: 처방 저장/재고 차감/프리셋 저장 완료, 이력에서 처방·프리셋 수정 진입, 프리셋 적용, 헤더만 남은 카드의 탭(모드) 버튼 클릭, 헤더만 남은 이력 카드에서 검색 입력, 작성 카드가 접힌 상태에서 약재 추가.

- **"불러오기" 모달에 기존 환자 처방 통합** (`src/frontend/index.html`, `src/frontend/renderer.js`, `src/frontend/style.css`, `src/backend/InventoryManager.js`)
  - "프리셋 불러오기" 버튼을 "불러오기"로 바꾸고, 모달에서 프리셋과 과거 환자 처방을 함께 불러올 수 있습니다. 프리셋 섹션이 항상 상단에 우선 노출됩니다.
  - 환자 처방은 검색어가 없으면 최근 5건만 표시하고, 검색(환자명·처방명·메모·약재명) 시 최대 30건까지 SQL `LIMIT`으로 조회해 대량 이력에서도 성능이 유지됩니다. 30건 초과 시 검색어 구체화 안내 행을 표시합니다.
  - 환자 처방 적용 시 약재 목록과 함께 환자명·처방명·메모도 작성 폼에 복원됩니다.
  - 모달의 삭제 열은 제거하고 적용 버튼을 마지막 열로 옮겼습니다. 프리셋 삭제는 '등록된 프리셋 목록' 탭에서, 처방 삭제는 처방 완료 이력에서 수행합니다.
  - `InventoryManager.searchPrescriptions`가 처방 메모도 검색하며 선택적 `limit` 인자를 받습니다. 최근 N건 조회용 `getRecentPrescriptions(limit)`를 신설했습니다.
- **처방 기록 상세조회 모달에 "처방 수정" 버튼 추가** (`src/frontend/index.html`, `src/frontend/renderer.js`)
  - 재고 차감 실행 버튼 오른쪽에 배치되며, 클릭 시 모달을 닫고 해당 처방의 수정 모드로 바로 진입합니다.

### Changed

- **처방 바구니(추가된 약재 리스트)를 2열 그리드로 개편** (`src/frontend/index.html`, `src/frontend/renderer.js`, `src/frontend/style.css`)
  - 규격 컬럼을 제거하고 약재명·소모량 입력·제거 버튼만 남긴 칸을 좌→우, 위→아래 순서(a1 b1 a2 b2 …)로 채워 한 화면에 두 배의 약재를 표시합니다.
  - 가독성 보조: 두 열 사이 중앙 세로 구분선, 행 단위 줄무늬 배경, 긴 약재명 말줄임 처리, 카드 헤더에 "추가된 약재 N종" 실시간 표기를 추가했습니다.

## [1.7.1] - 2026-07-21

### Fixed

- **네이티브 `alert`/`confirm` 대화상자로 인한 키보드 입력 먹통 버그 수정** (`src/frontend/renderer.js`, `src/frontend/QuickSearchEngine.js`, `src/frontend/index.html`, `src/frontend/style.css`)
  - Electron은 네이티브 `alert()`/`confirm()`을 닫은 뒤 렌더러가 키보드 포커스를 되찾지 못하는 알려진 버그가 있어, 대화상자를 한 번이라도 띄운 직후 검색창을 포함한 모든 입력 요소에서 캐럿이 사라지고 타이핑이 반영되지 않는 현상(윈도우/맥 공통)이 간헐적으로 발생했습니다.
  - 코드 전반의 `alert`/`confirm` 호출 47곳을 기존 모달 스타일을 재사용한 공용 대화상자(`showAlert`/`showConfirm`)로 교체했습니다. 대화상자를 열기 전 포커스 위치를 기억했다가 닫힐 때 그대로 복원하며, Enter(확인)·Esc(취소)·Tab/방향키(확인·취소 전환) 등 기존 키보드 워크플로우를 그대로 유지합니다.
  - 처방 조제 g수 입력 팝업을 **Esc로 닫을 때**, 팝업의 blur 방어 로직(10ms 지연 재포커스)이 상태 전환 순서 문제로 인해 이미 닫혀 투명해진(`opacity:0`) input에 포커스를 되돌려 놓아 같은 증상(캐럿 소실, 입력 무반응)을 유발하던 레이스 컨디션도 함께 수정했습니다.

## [1.7.0] - 2026-07-21

코드 리뷰(2026-07-21)에서 발견된 이슈들을 일괄 수정한 보안/정합성 중심 릴리스입니다. 각 항목은 리뷰 이슈 번호(#N) 기준으로 분리해 기록합니다.

### Security

- **#1 저장형 XSS → 원격 코드 실행(RCE) 차단** (`src/frontend/renderer.js`, `src/frontend/index.html`, `src/frontend/splash.html`)
  - `escapeHtml()` 헬퍼를 신설하고, `innerHTML` 템플릿에 삽입되던 모든 사용자 유래 문자열(약재명·이명·카테고리명·환자명·처방명·프리셋명·메모·비고·단위·알림 메시지·토스트 메시지 등 20여 곳)을 전부 이스케이프 처리했습니다. 기존에는 약재명 등에 `<img onerror=...>` 형태의 HTML을 넣으면 Node 권한으로 임의 코드가 실행될 수 있었고, Supabase 공유 DB를 통해 다른 PC로도 전파될 수 있었습니다.
  - 알림 카드의 인라인 `onclick` 핸들러(약재명이 스크립트 문자열로 직접 조립되던 구조)를 제거하고 `data-*` 속성 + 이벤트 위임 방식으로 교체했습니다.
  - `index.html`에 CSP(Content-Security-Policy) 메타 태그를 추가했습니다: 스크립트는 로컬 파일(`'self'`)만 허용, 외부 연결은 Supabase용 `https:`/`wss:`만 허용.
  - `splash.html`의 인라인 스크립트를 `splash.js`로 분리하고 동일하게 CSP를 적용했습니다.
- **#7 Supabase API 키 URL 노출 제거** (`src/backend/InventoryManager.js` `calculateClockOffset`)
  - 서버 시간 동기화 요청 시 `?apikey=...` 쿼리 파라미터로 전송하던 anon key를 `apikey` HTTP 헤더로 옮겼습니다. (프록시/서버 접근 로그에 키가 남는 문제 방지)
- **#10 CSV 수식 인젝션(Formula Injection) 방어** (`src/backend/CSVHandler.js` `exportToCSV`)
  - 내보내기 셀 값이 `=`, `+`, `-`, `@`, 탭/CR로 시작하면 어퍼스트로피(`'`)를 앞에 붙여 Excel 등 스프레드시트에서 수식으로 실행되지 않도록 했습니다.

### Changed (Breaking — 데이터 스키마)

- **#5 모든 엔티티 기본 키를 정수(AUTOINCREMENT)에서 UUID로 전환**
  - 배경: 여러 PC가 오프라인 상태에서 각자 데이터를 생성하면 같은 정수 ID가 중복 발급되어, 동기화 시 서로의 레코드를 덮어쓰거나 무관한 레코드가 삭제될 수 있었습니다.
  - `src/backend/InventoryManager.js`: 신규 레코드는 `crypto.randomUUID()`로 생성. 기존 정수 ID는 앱 최초 구동 시 `'00000000-0000-4000-8000-' + 12자리 16진수(구 ID)` 형태의 **결정적 UUID**로 자동 마이그레이션됩니다(categories, medicines, prescriptions, prescription_items, stock_logs, medicine_aliases, prescription_presets, prescription_preset_items, notifications의 참조 컬럼, deleted_records, sync_queue 전부).
  - 기본 카테고리 '미분류'는 고정 UUID `00000000-0000-4000-8000-000000000001`을 사용합니다(구 id=1의 변환값과 동일).
  - `supabase_triggers.sql`: 신규 서버는 UUID 스키마로 생성되고, 기존 BIGINT 서버는 동일한 결정적 변환 규칙의 idempotent 마이그레이션 블록으로 변환됩니다(외래 키 제약 자동 해제/재생성 포함). **로컬과 서버가 각자 마이그레이션해도 같은 레코드는 같은 UUID를 갖게 되어 동기화 대응 관계가 유지됩니다.**
  - UI: 내부 식별자가 UUID로 바뀌면서 의미가 없어진 "처방 ID"/"프리셋 ID" 표시 컬럼을 처방 이력·프리셋 목록 테이블에서 제거하고 나머지 컬럼(처방명/환자명/일시 등)이 공간을 채우도록 정리했습니다. 조제/프리셋 수정 모드 제목도 `#번호` 대신 처방명·환자명/프리셋명을 표시합니다.

### Fixed

- **#3 동기화 LWW(Last-Write-Wins) 비교의 시간대 버그** (`src/backend/InventoryManager.js`)
  - categories/medicines/medicine_aliases의 원격→로컬 비교에서 로컬 `updated_at`(UTC 저장값)을 `new Date('YYYY-MM-DD HH:mm:ss')`로 파싱해 **로컬 시간대(KST)로 잘못 해석**하던 문제를 수정했습니다. KST 환경에서는 로컬 레코드가 실제보다 9시간 최신으로 취급되어 원격 변경이 무시되었습니다.
  - 모든 시간 비교를 `localTimeMs()`/`remoteTimeMs()` 공통 헬퍼로 통일해 로컬 값은 항상 UTC로 해석합니다. DB 저장은 UTC, 화면 표시는 KST라는 기존 원칙은 그대로 유지됩니다(UI의 `formatUTCToKSTString` 변경 없음).
- **#4 삭제된 프리셋 부활 버그** (`src/backend/InventoryManager.js` `syncAll`)
  - 원격 삭제 이력 적용 화이트리스트에 `prescription_presets`/`prescription_preset_items`가 빠져 있어, 다른 기기에서 삭제한 프리셋이 전체 동기화 시 로컬에 남았다가 서버로 재업로드(부활)되던 문제를 수정했습니다. 화이트리스트를 동기화 테이블 설정(`SYNC_TABLES`)에서 자동 파생하도록 바꿔 같은 유형의 누락이 재발하지 않도록 했습니다.
- **#6 팩 규격 변경 시 재고 오차(ADJUST) 계산 오류** (`src/backend/InventoryManager.js` `updateMedicine`)
  - 오차를 `(팩수 차이 × 새 규격) + 잔량 차이`로 계산해 규격 변경 시 잘못된 보정 로그가 남던 것을, `(변경 후 팩수 × 변경 후 규격 + 변경 후 잔량) − (변경 전 팩수 × 변경 전 규격 + 변경 전 잔량)` 즉 실제 총 보유량의 차이로 수정했습니다. 규격 변경으로 인한 총량 변화가 정확히 오차로 기록되고, 잔량이 규격 델타에 침범당하는 문제가 사라집니다. 사용되지 않던 `oldTotal` 죽은 코드도 제거했습니다.
- **#8 동기화 큐 오류 처리 개선** (`src/backend/InventoryManager.js` `processSyncQueue`)
  - 네트워크 오류 판별을 개선했습니다: PostgREST SQLSTATE 코드(예: `23505`)가 있으면 데이터성 오류로 분류하고, HTTP 5xx/408/429·fetch `TypeError`·소켓 계열 메시지만 네트워크 장애로 재시도합니다. 기존에는 일반 JS 예외도 네트워크 장애로 오판해 30초마다 무한 재시도했습니다.
  - 데이터성 오류로 실패한 작업을 **즉시 삭제(묵살)하지 않고** `retry_count`를 증가시키며 최대 5회 재시도 후, 신설된 `sync_failures` 테이블(dead-letter)로 이동해 실패 이력을 보존합니다. `getSyncFailures()`로 조회할 수 있습니다.
- **#9 소모/입고량 유효성 검증 추가** (`src/backend/InventoryManager.js`)
  - `assertPositiveAmount()` 공통 검증을 신설하여 `consumeStockLocally`, `addStockLog`(IN), `addPrescription`, `updatePrescriptionWithItems`, `addPreset`, `updatePreset`의 모든 수량 입력에서 0·음수·NaN을 차단합니다. 기존에는 음수 소모량이 들어오면 재고가 오히려 증가하면서 CONSUME 로그가 남을 수 있었습니다. `addStockLog`에 미지원 로그 유형 방어도 추가했습니다.
- **#12 처방 삭제/수정 시 재고 복원 로직 정확도 개선** (`src/backend/InventoryManager.js`)
  - 복원 기준을 처방 항목(`prescription_items.amount`)에서 **실제 차감 로그(`stock_logs`의 CONSUME 집계, SQL `SUM(-quantity)`)**로 변경했습니다(`getConsumedGramsByPrescription` + `restoreConsumedStockLocally`).
  - 이로써 (a) 미차감 처방 삭제 시 재고가 부풀던 경로 차단, (b) 단순 유무 관리 약재(차감 로그 0g)가 복원 과정에서 오염되던 문제 해결, (c) 소모 이후 관리 방식이 전환된 약재도 실제 차감량 기준으로 정확히 복원됩니다.

### Refactored

- **#13 동기화 엔진 테이블 설정 기반 재구성** (`src/backend/InventoryManager.js`)
  - 테이블별로 거의 동일하게 반복되던 실시간 반영(`handleRealtimeChange`)·개별 업로드(`syncItemToSupabaseDirect`)·전체 동기화(`syncAll`) 코드를, 컬럼 목록/시간 컬럼/LWW 여부/부모-자식 관계를 선언하는 `SYNC_TABLES` 메타데이터와 공통 루프(`applyRemoteRow`, `localRowToPayload`, `getUpsertStmt`)로 통합했습니다. 동기화 엔진 코드가 절반 이하로 줄었고, "테이블 하나 빠뜨리는" 유형의 버그(#4)가 구조적으로 재발하지 않습니다.
- **#15 무의미한 `try { ... } catch (err) { throw err; }` 래퍼 제거**
  - `addCategory`, `updateCategory`, `deleteCategory`, `deleteMedicine`, `deletePrescription`, `updatePrescriptionWithItems` 등의 no-op try/catch를 제거했습니다. (UNIQUE 제약 메시지 변환 등 실제 처리가 있는 catch는 유지)

### Added

- **#14 단위 테스트 도입** (`tests/`, `npm test`)
  - Node 내장 테스트 러너(`node:test`) 기반 27개 테스트를 추가했습니다: 팩 개봉/소모/입고 분배 연산, 오차(loss) 계산(규격 변경 포함), 처방 삭제·수정 롤백(미차감/단순 유무 관리 케이스 포함), 수량 유효성 검증, 프리셋 CRUD, **레거시 정수 ID → UUID 마이그레이션 검증**, LWW 시간대 비교(#3 회귀 방지), CSV 파싱/수식 인젝션 방어(#10).
  - 실행: `npm test` (better-sqlite3가 현재 Node ABI로 빌드되어 있어야 하며, Electron용으로 빌드된 상태라면 `npm rebuild better-sqlite3` 후 실행)

## [1.6.4] - 2026-07-19
### Fixed
- 약재 삭제 시 처방 프리셋 항목(prescription_preset_items) 연관 레코드가 삭제/동기화되지 않던 버그 수정
- 약재 삭제 실패 시 사용자에게 토스트로 오류를 알리도록 프론트엔드 에러 처리 추가

## [1.6.3] - 2026-07-17
### Fixed
- UI 버그 수정

## [1.6.2] - 2026-07-17
### Changed
- 세부 UI/동작 미세조정 및 테스트

## [1.6.1] - 2026-07-17
### Changed
- 스플래시 로딩 화면 최적화

## [1.6.0] - 2026-07-17
### Added
- 처방 프리셋(자주 쓰는 처방 조합 저장/재사용) 기능
### Changed
- 앱 아이콘 변경, 전반적인 UI 개선, DB 최적화

## [1.5.0] - 2026-07-16
### Added
- 처방 기능 이원화(원외탕전/원내탕전 등 구분)
- 약재 단순 재고 기능 추가
- 재고 알람(알림) 기능 추가
- 약재 메모 기능 추가

## [1.4.8] - 2026-07-16
### Added
- 약재 이명(별칭) 등록 기능

## [1.4.7] - 2026-07-15
### Fixed
- 입력기(IME) 버그 수정

## [1.4.6] - 2026-07-15
### Fixed
- 입력기 한/영 전환 문제 수정

## [1.4.5] - 2026-07-15
### Fixed
- 버그 수정

## [1.4.4] - 2026-07-15
### Fixed
- 버그 수정

## [1.4.3] - 2026-07-15
### Fixed
- 버그 수정

## [1.4.2] - 2026-07-15
### Fixed
- 버그 수정

## [1.4.1] - 2026-07-15
### Changed
- 입력 흐름 개선
### Fixed
- 버그 수정

## [1.4.0] - 2026-07-15
### Changed
- 단축키 체계 재정비
### Fixed
- 버그 수정

## [1.3.5] - 2026-07-14
### Added
- 카테고리 수정 기능
### Changed
- DB 작업 개선

## [1.3.4] - 2026-07-14
### Changed
- DB 최적화

## [1.3.3] - 2026-07-14
### Changed
- 성능 개선, 스케일링 최적화

## [1.3.2] - 2026-07-14
### Fixed
- 버그 수정

## [1.3.1] - 2026-07-14
### Fixed
- 오탈자 수정

## [1.3.0] - 2026-07-14
### Added
- 신규 업데이트 기능 추가

## [1.2.7] - 2026-07-14
### Fixed
- 이전 변경 롤백

## [1.2.6] - 2026-07-14
### Fixed
- 핫픽스

## [1.2.5] - 2026-07-14
### Fixed
- 업데이터 서명 문제 수정

## [1.2.4] - 2026-07-14
### Changed
- 성능 개선

## [1.2.3] - 2026-07-14
### Fixed
- 업데이터 버그 수정

## [1.2.2] - 2026-07-14
### Changed
- 업데이트 기능 테스트

## [1.2.1] - 2026-07-14
### Added
- 버전 확인 기능

## [1.2.0] - 2026-07-14
### Added
- 자동 업데이트(`electron-updater`) 기능 도입

## [1.1.0] - 2026-07-14
### Added
- 처방전 검색 기능
### Fixed
- DB 버그 수정

## [1.0.0] - 2026-07-14
### Changed
- 최초 정식 배포 버전, 코드 최적화

## [0.9.3] - 2026-07-14
### Added
- 앱 아이콘 설정
### Changed
- DB 최적화

## [0.9.2] - 2026-07-13
### Added
- 처방 수정/삭제 기능

### Changed
- DB 최적화

## [0.9.1] - 2026-07-13
### Changed
- 최적화 및 버그 수정

## [0.9.0] - 2026-07-13
### Added
- DB 클라우드화(Supabase 연동 시작)
### Changed
- 성능 최적화

## [0.1.0] - 2026-07-10
### Added
- 프로젝트 초기 구성 및 GitHub Actions 빌드/배포 워크플로우 도입
- Windows/macOS CI 빌드 환경(node-gyp, MSVC 설정 등) 안정화
