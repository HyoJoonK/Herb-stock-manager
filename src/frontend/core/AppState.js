/**
 * @file AppState.js
 * @description 렌더러 전역에서 공유되는 UI 상태의 단일 소유자.
 *
 * 과거 renderer.js에 흩어져 있던 전역 let 변수 15개를 이 클래스로 모았습니다.
 * View들은 생성자에서 주입받은 동일한 AppState 인스턴스를 읽고 쓰며,
 * "이 상태를 누가 바꾸는가"를 추적할 때 이 파일 하나만 보면 됩니다.
 *
 * 뷰 내부에서만 쓰이는 상태(예: 처방 패널 확장 상태)는 해당 View가 소유하고,
 * 두 개 이상의 View/컴포넌트가 공유하는 상태만 이곳에 둡니다.
 */

class AppState {
  constructor() {
    /** 현재 활성 탭: 'inquiry' | 'prescription' | 'predict' | 'batch' */
    this.currentTab = 'inquiry';

    /** [조회 탭] 현재 조회 중인 약재 ID (null이면 미선택) */
    this.currentInquiryMedId = null;

    /** [처방 탭] 처방 바구니 [{ id, name, pack_size, amount }] */
    this.currentPrescriptionItems = [];

    /** [일괄작업 탭] 편집 대상 약재 맵 (id => medData 복사본) */
    this.batchEditItems = new Map();

    // -- 우클릭 컨텍스트 메뉴 대상 추적 --------------------------------------
    /** 우클릭 대상 약재 ID */
    this.contextTargetMedId = null;
    /** 우클릭 대상 처방 ID */
    this.contextTargetPrescId = null;
    /** 우클릭 대상 카테고리 ID */
    this.contextTargetCategoryId = null;
    /** 우클릭 대상 프리셋 ID */
    this.contextTargetPresetId = null;

    /** 처방 상세조회 모달에 표시 중인 처방 ID */
    this.currentDetailPrescId = null;

    // -- 처방/프리셋 편집 모드 -----------------------------------------------
    /** 처방 수정 모드 활성화 여부 */
    this.isPrescriptionEditMode = false;
    /** 현재 수정 중인 처방 ID */
    this.currentEditingPrescId = null;
    /** 프리셋 수정 모드 활성화 여부 */
    this.isPresetEditMode = false;
    /** 현재 수정 중인 프리셋 ID */
    this.currentEditingPresetId = null;

    /** [처방 탭] 작성 모드: 'prescription'(환자 처방) | 'preset'(프리셋 작성) */
    this.currentPrescMode = 'prescription';

    /** [처방 탭] 하단 이력 카드의 활성 탭: 'history'(처방 이력) | 'presets'(프리셋 목록) */
    this.currentHistoryTab = 'history';
  }
}

module.exports = AppState;
