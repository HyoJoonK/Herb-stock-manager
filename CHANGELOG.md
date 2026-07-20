# Changelog

이 프로젝트의 주요 변경 사항을 버전별로 기록합니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)를 참고하며, 버전 관리는 [Semantic Versioning](https://semver.org/lang/ko/)을 따릅니다.

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
