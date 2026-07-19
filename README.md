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

### 데이터 저장 위치

로컬 SQLite 데이터베이스는 Electron의 `userData` 경로(예: macOS `~/Library/Application Support/HerbStockManager`)에 저장됩니다.

### 클라우드 동기화 설정 (선택)

앱 내 설정 화면에서 Supabase Project URL과 Anon Key를 입력하면 자동으로 초기 동기화와 실시간 구독이 시작됩니다. 값을 비워두면 로컬 단독(SQLite-only) 모드로 동작합니다.

## 빌드 및 배포

```bash
npm run dist
```

`electron-builder` 설정(`package.json`의 `build` 필드)에 따라 `dist/` 디렉터리에 플랫폼별 설치 파일이 생성됩니다.

- macOS: `dmg`, `zip` (arm64)
- Windows: `nsis` (x64), 아티팩트명 `HerbStockManager-Setup-{version}.exe`

`main` 브랜치 push 또는 `v*` 태그 push 시 [`.github/workflows/build.yml`](.github/workflows/build.yml)이 macOS/Windows 빌드를 수행하고 `package.json`의 `version`을 기준으로 GitHub Release를 생성합니다. `better-sqlite3`의 네이티브 컴파일 이슈를 피하기 위해 `npm ci --ignore-scripts` 후 Electron 바이너리를 별도로 내려받는 방식을 사용합니다.

## 프로젝트 구조

```
src/
├── main.js                  # Electron 메인 프로세스 (윈도우 생성, 자동 업데이트, IPC)
├── backend/
│   ├── InventoryManager.js  # SQLite 스키마, 재고/처방 CRUD, Supabase 동기화 엔진
│   ├── SmartPredictor.js    # 소모량 분석 기반 안전 재고/발주 예측
│   └── CSVHandler.js        # CSV 가져오기/내보내기
└── frontend/
    ├── index.html / renderer.js / style.css  # 메인 UI 및 렌더러 로직
    ├── splash.html           # 기동 시 업데이트 체크 스플래시 화면
    ├── QuickSearchEngine.js  # 키보드 내비게이션 / 초성 검색 엔진
    └── svg/                  # 아이콘 리소스
```

## 기여

이 저장소는 개인/소규모 운영 프로젝트로, 버그나 개선 제안은 이슈로 남겨주세요. PR을 보낼 경우:

1. 관련 기능 영역(재고/처방/동기화/UI)을 명확히 하여 커밋 메시지를 작성합니다.
2. `package.json`의 `version`을 변경 단위에 맞게 올리고 [CHANGELOG.md](CHANGELOG.md)에 항목을 추가합니다.
3. 가능하다면 `npm start`로 실제 동작을 확인한 뒤 제출합니다.
