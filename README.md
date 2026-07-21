# HerbStockManager (약재 재고 관리 시스템)

한의원 전용 약재 재고 관리 데스크톱 프로그램입니다. 키보드만으로 전체 워크플로우(검색 → 처방 구성 → 재고 차감)를 초고속으로 처리할 수 있도록 설계되었으며, SQLite 로컬 저장소와 Supabase 클라우드를 결합한 하이브리드 동기화를 지원합니다.

- **런타임**: Electron 31 (Node 통합 렌더러)
- **로컬 DB**: SQLite (`better-sqlite3`)
- **클라우드 동기화**: Supabase (Postgres + Realtime, 선택 사항)
- **배포**: `electron-builder` (macOS `dmg`/`zip`, Windows `nsis`), GitHub Actions로 자동 빌드/릴리스

기술적인 구조와 내부 동작 원리는 [AGENTS.md](AGENTS.md)를, 버전별 변경 이력은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 주요 기능

- **약재 재고 관리**: 미개봉 팩 수 + 개봉 팩 잔량 기반 실시간 총 재고 계산, 안전 재고 미달 알림
- **처방 조제**: 처방(원외탕전/원내탕전 등) 구성 시 약재별 사용량 입력 → 재고 자동 차감, 수정/삭제 시 재고 원복
- **처방 프리셋**: 자주 쓰는 처방 조합을 저장해 두고 한 번에 불러와 구성
- **초고속 키보드 내비게이션**: 초성 검색, 탭 간 단축키(Alt+1~4), Shift 다중 선택 등 마우스 없이 전체 작업 가능 (`QuickSearchEngine`)
- **스마트 발주 예측**: 최근 조제 로그 기반 일평균 소모량을 계산해 동적 안전 재고 및 발주 필요 리스트 제안 (`SmartPredictor`)
- **CSV 가져오기/내보내기**: 약재 마스터 데이터 대량 등록 및 백업
- **약재 이명(별칭) 등록**: 같은 약재를 여러 이름으로 검색 가능
- **재고 메모, 재고 단순 조정, 재고 변동 로그, 알림함**
- **하이브리드 클라우드 동기화**: Supabase 연결 시 로컬 SQLite ↔ 원격 Postgres 양방향 동기화, 오프라인 큐잉 후 온라인 복귀 시 자동 재전송
- **자동 업데이트**: `electron-updater` 기반 스플래시 화면 업데이트 체크 및 백그라운드 업데이트

## 빠른 시작

### 요구 사항

- Node.js 22 이상
- macOS 또는 Windows (배포 대상 플랫폼)

### 설치 및 실행

```bash
npm install
npm start
```

`npm start`는 Electron 앱을 개발 모드로 실행합니다. 개발 모드에서는 자동 업데이트 체크가 시뮬레이션되며 실제 서버에 접속하지 않습니다.

### 테스트

```bash
npm test
```

Node 내장 테스트 러너(`node:test`)로 재고 연산/처방 롤백/스키마 마이그레이션/CSV 처리 단위 테스트를 실행합니다. `better-sqlite3`가 Electron용 ABI로 빌드되어 있어 로드 오류가 나는 경우 `npm rebuild better-sqlite3` 후 다시 실행하세요.

### 데이터 저장 위치

로컬 SQLite 데이터베이스는 Electron의 `userData` 경로(예: macOS `~/Library/Application Support/HerbStockManager`)에 저장됩니다.

### 클라우드 동기화 설정 (선택)

앱 내 설정 화면에서 Supabase Project URL과 Anon Key를 입력하면 자동으로 초기 동기화와 실시간 구독이 시작됩니다. 값을 비워두면 로컬 단독(SQLite-only) 모드로 동작합니다.

서버 스키마(테이블/트리거/실시간 구독)는 프로젝트에 포함된 `supabase_triggers.sql`을 Supabase SQL Editor에서 실행해 준비합니다. 이 스크립트는 빈 데이터베이스와 기존 데이터베이스 모두에서 안전하게 재실행할 수 있도록(idempotent) 작성되어 있습니다.

## v1.7.0 업그레이드 안내 (중요)

v1.7.0부터 모든 데이터의 내부 식별자(ID)가 정수에서 **UUID**로 바뀌었습니다. 사용자가 알아야 할 사항:

1. **로컬 데이터는 자동 변환됩니다.** v1.7.0을 처음 실행하면 기존 SQLite 데이터베이스가 자동으로 UUID 스키마로 마이그레이션됩니다. 별도 조작은 필요 없지만, 만약을 위해 업데이트 전에 CSV 내보내기로 백업해 두는 것을 권장합니다.
2. **Supabase를 사용 중이라면 `supabase_triggers.sql`을 반드시 다시 실행해야 합니다.** Supabase SQL Editor에서 최신 스크립트를 실행하면 서버 데이터도 같은 규칙으로 UUID로 변환됩니다. 로컬과 서버가 각각 변환되어도 같은 데이터는 같은 UUID를 갖도록 설계되어 있어 동기화가 그대로 이어집니다. 서버 스크립트를 실행하기 전까지는 클라우드 동기화가 실패할 수 있습니다(로컬 사용은 정상).
3. **여러 PC에서 사용하는 경우 모든 PC를 v1.7.0으로 함께 업데이트하세요.** 구버전(정수 ID)과 신버전(UUID)이 같은 Supabase 서버에 섞여 접속하면 동기화가 실패합니다.
4. 처방 이력과 프리셋 목록에서 내부 번호(`처방 ID`/`프리셋 ID`) 컬럼이 사라졌습니다. UUID는 사람이 읽는 값이 아니므로 처방명/환자명/일시로 목록을 식별합니다.
5. UUID 전환으로, 여러 PC가 오프라인 상태에서 동시에 약재/처방을 등록해도 더 이상 서로의 데이터를 덮어쓰지 않습니다.

이 밖에 v1.7.0은 보안 강화(입력값 HTML 이스케이프, CSP 적용, CSV 수식 인젝션 방어), 동기화 정합성 수정(시간대 비교 버그, 삭제된 프리셋 부활 버그, 동기화 실패 이력 보존), 재고 보정/복원 정확도 개선을 포함합니다. 상세 내역은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 빌드 및 배포

```bash
npm run dist
```

`electron-builder` 설정(`package.json`의 `build` 필드)에 따라 `dist/` 디렉터리에 플랫폼별 설치 파일이 생성됩니다.

- macOS: `dmg`, `zip` (arm64)
- Windows: `nsis` (x64), 아티팩트명 `HerbStockManager-Setup-{version}.exe`

`main` 브랜치 push 또는 `v*` 태그 push 시 [`.github/workflows/build.yml`](.github/workflows/build.yml)이 macOS/Windows 빌드를 수행하고 `package.json`의 `version`을 기준으로 GitHub Release를 생성합니다. `better-sqlite3`의 네이티브 컴파일 이슈를 피하기 위해 `npm ci --ignore-scripts` 후 Electron 바이너리를 별도로 내려받는 방식을 사용합니다.

## 프로젝트 구조

v1.8.0부터 코드베이스가 객체지향 계층 구조로 재구성되었습니다. (기능·데이터 호환성은 이전 버전과 동일)

```
src/
├── main.js                   # Electron 메인 프로세스 진입점 (앱 수명주기 + IPC 등록)
├── main/
│   ├── WindowManager.js      # 스플래시/메인 윈도우 생성·수명 관리
│   └── UpdateManager.js      # electron-updater 자동 업데이트 흐름
├── backend/
│   ├── InventoryManager.js   # 백엔드 Facade — 기존 공개 API 유지, 하위 계층에 위임
│   ├── db/
│   │   ├── Database.js       # SQLite 연결, 스키마 생성, 레거시(정수 ID)→UUID 마이그레이션
│   │   ├── TimeService.js    # 시간 파싱/포맷, 서버-로컬 시계 보정(clock offset)
│   │   └── ids.js            # UUID 생성 및 ID 규칙 상수 (단일 정의 지점)
│   ├── repositories/         # 테이블별 CRUD (Base·Category·Medicine·Prescription·Preset·StockLog·Notification)
│   ├── services/
│   │   ├── StockService.js         # 재고 소모/입고/폐기/복원 알고리즘
│   │   ├── PrescriptionService.js  # 처방 생성·수정·삭제·후차감 트랜잭션
│   │   ├── SmartPredictor.js       # 소모량 분석 기반 안전 재고/발주 예측
│   │   └── CSVHandler.js           # CSV 가져오기/내보내기
│   ├── sync/                 # Supabase 동기화 서브시스템
│   │   ├── SyncEngine.js           # 연결 수립·전체 동기화 오케스트레이션
│   │   ├── TableMapper.js          # 동기화 테이블 선언의 단일 등록 지점
│   │   ├── ConflictResolver.js     # Last-Write-Wins 충돌 판정
│   │   ├── SyncQueue.js            # 오프라인 안전 업로드 대기열 (재시도/실패 이력)
│   │   └── RealtimeSubscriber.js   # 실시간 원격 변경 수신 → 로컬 반영
│   └── utils/validators.js   # 공통 유효성 검사
└── frontend/
    ├── index.html / style.css     # 메인 UI 마크업/스타일
    ├── renderer.js                # 렌더러 진입점 (부트스트랩 전용)
    ├── App.js                     # 렌더러 코디네이터 (조립, 탭 전환, CSV 액션)
    ├── core/                      # AppState / EventBus / DialogService / NumericInput / ModalKeyboard / utils
    ├── views/                     # 탭·영역별 View (MedicineList·Inquiry·Prescription·Predict·Batch·Notification)
    ├── components/                # 모달·컨텍스트 메뉴·사용량 차트 컴포넌트
    ├── QuickSearchEngine.js       # 키보드 내비게이션 / 초성 검색 엔진
    ├── splash.html / splash.js    # 기동 시 업데이트 체크 스플래시 화면
    └── svg/                       # 아이콘 리소스
tests/                        # node:test 단위 테스트 (npm test)
supabase_triggers.sql         # Supabase 스키마/트리거/마이그레이션 스크립트 (SQL Editor에서 실행)
```

## 기여

이 저장소는 개인/소규모 운영 프로젝트로, 버그나 개선 제안은 이슈로 남겨주세요. PR을 보낼 경우:

1. 관련 기능 영역(재고/처방/동기화/UI)을 명확히 하여 커밋 메시지를 작성합니다.
2. `package.json`의 `version`을 변경 단위에 맞게 올리고 [CHANGELOG.md](CHANGELOG.md)에 항목을 추가합니다.
3. 가능하다면 `npm start`로 실제 동작을 확인한 뒤 제출합니다.
