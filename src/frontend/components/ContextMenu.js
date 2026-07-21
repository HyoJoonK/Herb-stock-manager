/**
 * @file ContextMenu.js
 * @description 마우스 우클릭 커스텀 컨텍스트 메뉴의 표시/위치 보정 공용 컴포넌트.
 *
 * 메뉴의 "표시"만 담당합니다. 각 메뉴 항목의 동작(수정/삭제 등)은
 * 해당 도메인의 View(MedicineListView, PrescriptionView 등)가 바인딩합니다.
 */

class ContextMenu {
  /**
   * 지정 좌표에 컨텍스트 메뉴를 표시합니다. 화면 경계를 벗어나면 위치를 보정하고,
   * 바깥 클릭 시 자동으로 닫히도록 1회성 전역 리스너를 연결합니다.
   * @param {string} menuElementId 메뉴 요소의 DOM id
   * @param {number} x 표시할 페이지 X 좌표
   * @param {number} y 표시할 페이지 Y 좌표
   */
  static show(menuElementId, x, y) {
    const menu = document.getElementById(menuElementId);
    menu.style.display = 'flex';

    // 화면 경계 이탈을 방지하기 위해 너비/높이 획득 후 보정
    const menuWidth = menu.offsetWidth || 140;
    const menuHeight = menu.offsetHeight || 80;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    if (x + menuWidth > windowWidth) {
      x = windowWidth - menuWidth - 10;
    }
    if (y + menuHeight > windowHeight) {
      y = windowHeight - menuHeight - 10;
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    // 다른 곳 클릭 시 메뉴 숨기기 위해 글로벌 리스너 연결
    const hideMenu = () => {
      menu.style.display = 'none';
      document.removeEventListener('click', hideMenu);
    };
    // 살짝 지연시켜서 즉시 닫히지 않게 처리
    setTimeout(() => document.addEventListener('click', hideMenu), 50);
  }
}

module.exports = ContextMenu;
