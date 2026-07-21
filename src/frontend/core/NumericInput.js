/**
 * @file NumericInput.js
 * @description 숫자 입력 필드 공용 편의 기능 (문서 전역 이벤트 위임 방식).
 *
 * 대상: type="number" 또는 class="numeric-input"인 모든 input 요소.
 *  1. 실시간 입력 필터링: data-numeric-type="decimal"은 숫자+마침표만,
 *     "integer"는 숫자만 허용
 *  2. 선두의 의미 없는 0 제거 (예: '007' → '7', '00.5' → '0.5')
 *  3. blur 시 최종 정리 후 change 이벤트 전파 (마침표로 끝나는 값 정제 포함)
 *  4. 포커스 시 전체 선택 (기존 값을 쉽게 덮어쓸 수 있도록)
 *
 * 동적으로 추가되는 입력 필드에도 자동 적용되도록 document 레벨에서 위임합니다.
 */

class NumericInput {
  /** 문서 전역 리스너를 등록합니다. (앱 구동 시 1회 호출) */
  static init() {
    /** 선두의 의미 없는 0을 제거합니다. */
    function stripLeadingZeros(valueStr) {
      if (typeof valueStr !== 'string' || valueStr === '') return valueStr;

      const isNegative = valueStr.startsWith('-');
      let numStr = isNegative ? valueStr.slice(1) : valueStr;

      if (/^0+$/.test(numStr)) {
        numStr = '0';
      } else if (/^0{2,}\./.test(numStr)) {
        numStr = numStr.replace(/^0+/, '0');
      } else if (/^0+[1-9]/.test(numStr)) {
        numStr = numStr.replace(/^0+/, '');
      }

      return isNegative ? '-' + numStr : numStr;
    }

    /** 이 기능의 적용 대상 입력 필드인지 검사합니다. */
    function isNumericInput(target) {
      return target && target.tagName === 'INPUT' &&
        (target.type === 'number' || target.classList.contains('numeric-input'));
    }

    /** data-numeric-type 선언에 따라 허용 문자만 남깁니다. */
    function sanitizeValue(target, val) {
      if (target.type === 'number') return val;

      const numericType = target.getAttribute('data-numeric-type');
      if (numericType === 'decimal') {
        // 숫자와 마침표(.)만 허용
        let cleaned = val.replace(/[^0-9.]/g, '');
        // 마침표가 여러 개 있으면 첫 번째 것만 유지
        const dotIndex = cleaned.indexOf('.');
        if (dotIndex !== -1) {
          cleaned = cleaned.slice(0, dotIndex + 1) + cleaned.slice(dotIndex + 1).replace(/\./g, '');
        }
        return cleaned;
      } else if (numericType === 'integer') {
        // 숫자만 허용
        return val.replace(/[^0-9]/g, '');
      }
      return val;
    }

    // 1. 실시간 입력(input) 시 필터링 및 선두 0 제거
    document.addEventListener('input', (e) => {
      if (isNumericInput(e.target)) {
        let val = e.target.value;
        val = sanitizeValue(e.target, val);
        const cleaned = stripLeadingZeros(val);
        if (e.target.value !== cleaned) {
          e.target.value = cleaned;
        }
      }
    });

    // 2. 포커스 해제(blur) 시 최종 선두 0 정리 및 변경 이벤트 전파
    document.addEventListener('blur', (e) => {
      if (isNumericInput(e.target)) {
        let val = e.target.value;
        val = sanitizeValue(e.target, val);

        // 소수점 입력창인데 마침표로 끝나는 경우 정제
        if (e.target.type !== 'number' && e.target.getAttribute('data-numeric-type') === 'decimal') {
          if (val === '.') val = '';
          else if (val.endsWith('.')) val = val.slice(0, -1);
        }

        const cleaned = stripLeadingZeros(val);
        if (e.target.value !== cleaned) {
          e.target.value = cleaned;
          e.target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, true); // blur 이벤트는 버블링되지 않으므로 캡처링 단계에서 캐치

    // 3. 포커스 시 전체 선택 (기존 0 또는 숫자를 쉽게 덮어쓸 수 있도록 지원)
    document.addEventListener('focus', (e) => {
      if (isNumericInput(e.target)) {
        const initialVal = e.target.value;
        setTimeout(() => {
          // 사용자가 지연 포커스 전에 이미 타이핑을 시작하여 값이 달라졌다면 선택을 스킵합니다.
          if (document.activeElement === e.target && e.target.value === initialVal && e.target.select) {
            e.target.select();
          }
        }, 0); // 마우스 클릭 이벤트 완료 후 실행을 위한 0ms 지연
      }
    }, true); // focus 이벤트는 버블링되지 않으므로 캡처링 단계에서 캐치
  }
}

module.exports = NumericInput;
