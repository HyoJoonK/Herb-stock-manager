/**
 * @file NotificationView.js
 * @description 알림함(팝오버) View — 알림 목록/배지, 읽음/삭제, 잔량 보정 모달.
 *
 * 알림의 주 발생원은 재고 소모 중 새 팩 개봉 안내이며,
 * '잔량 보정' 액션으로 실제 보유량을 즉시 기록(adjustStock)할 수 있습니다.
 */

const BaseView = require('./BaseView');
const { escapeHtml, formatUTCToKSTString } = require('../core/utils');

class NotificationView extends BaseView {
  /** 알림 배지 수량과 알림 카드 목록을 렌더링합니다. */
  render() {
    const badge = this.$('notificationBadge');
    const container = this.$('notificationListContainer');
    const emptyState = this.$('notificationEmptyState');

    if (!container) return;
    container.innerHTML = '';

    const list = this.manager.getNotifications();
    const unreadCount = list.filter(n => n.is_read === 0).length;

    // 배지 수량 갱신
    if (unreadCount > 0) {
      badge.textContent = unreadCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }

    if (list.length === 0) {
      emptyState.style.display = 'flex';
      container.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    container.style.display = 'flex';

    list.forEach(n => {
      const card = document.createElement('div');
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.gap = '5px';
      card.style.padding = '10px';
      card.style.borderRadius = 'var(--radius-sm)';
      card.style.border = '1px solid var(--color-border)';

      if (n.is_read === 0) {
        card.style.backgroundColor = 'rgba(45, 90, 39, 0.03)';
        card.style.borderColor = 'rgba(45, 90, 39, 0.15)';
      } else {
        card.style.backgroundColor = 'var(--bg-card)';
      }

      const timeStr = formatUTCToKSTString(n.created_at);

      // 버튼 구성 (inline onclick 제거: CSP 및 XSS 방어를 위해 data-속성 + 이벤트 위임 방식 사용)
      let actionButtons = '';
      if (n.is_read === 0) {
        actionButtons += `<button class="btn btn-primary noti-action" data-action="adjust" data-noti-id="${n.id}" data-med-id="${escapeHtml(n.medicine_id)}" style="font-size: 11px; padding: 4px 10px; height: 26px; display: inline-flex; align-items: center; justify-content: center;"><span class="sf-icon sf-icon-scale"></span> 잔량 보정</button>`;
        actionButtons += `<button class="btn noti-action" data-action="read" data-noti-id="${n.id}" style="font-size: 11px; padding: 4px 10px; height: 26px; border: 1px solid var(--color-border); background: var(--bg-card); display: inline-flex; align-items: center; justify-content: center;">읽음</button>`;
      }
      actionButtons += `<button class="btn noti-action" data-action="delete" data-noti-id="${n.id}" style="font-size: 11px; padding: 4px 10px; height: 26px; color: var(--color-accent); border: 1px solid var(--color-border); background: var(--bg-card); display: inline-flex; align-items: center; justify-content: center;">삭제</button>`;

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: var(--color-text-muted); font-size: 10px;">${timeStr}</span>
          ${n.is_read === 0 ? '<span style="background: var(--color-accent); color: white; border-radius: 4px; padding: 1px 4px; font-size: 9px; font-weight: bold;">NEW</span>' : ''}
        </div>
        <div style="font-size: 12.5px; line-height: 1.45; color: var(--color-text-main); font-weight: ${n.is_read === 0 ? '600' : 'normal'}; word-break: keep-all; margin: 2px 0 4px 0;">
          ${escapeHtml(n.message)}
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;">
          ${actionButtons}
        </div>
      `;
      container.appendChild(card);
    });
  }

  /**
   * 알림에서 넘어온 잔량 보정 모달을 엽니다.
   * @param {number} notiId 알림 ID
   * @param {string} medId 약재 UUID
   */
  openAdjustModal(notiId, medId) {
    const modal = this.$('adjustNotificationRemainModal');
    const med = this.manager.getAllMedicines().find(m => String(m.id) === String(medId));

    if (!med) {
      this.dialogs.showAlert('해당 약재를 찾을 수 없습니다.');
      return;
    }

    // 잔량 보정 창이 뜰 때 알림 팝오버 닫기
    const popover = this.$('notificationPopover');
    if (popover) popover.style.display = 'none';

    this.$('adjNotificationId').value = notiId;
    this.$('adjNotificationMedId').value = med.id;
    this.$('adjNotificationMedNameLabel').textContent = `약재명: ${med.name} (규격: ${med.pack_size}${med.unit})`;

    this.$('adjNotificationPacks').value = med.unopened_packs;
    this.$('adjNotificationRemain').value = med.opened_pack_remain;

    modal.classList.add('show');
  }

  /**
   * 알림을 읽음 처리하고 목록을 갱신합니다.
   * @param {number} notiId 알림 ID
   */
  markAsRead(notiId) {
    try {
      this.manager.markNotificationAsRead(notiId);
      this.render();
    } catch (err) {
      this.dialogs.showAlert(`알림 업데이트 실패: ${err.message}`);
    }
  }

  /**
   * 알림을 삭제하고 목록을 갱신합니다.
   * @param {number} notiId 알림 ID
   */
  delete(notiId) {
    try {
      this.manager.deleteNotification(notiId);
      this.render();
    } catch (err) {
      this.dialogs.showAlert(`알림 삭제 실패: ${err.message}`);
    }
  }

  /** 알림 버튼/팝오버/액션/잔량 보정 모달 이벤트를 바인딩합니다. */
  bindEvents() {
    const btnNoti = this.$('btnNotifications');
    const popoverNoti = this.$('notificationPopover');
    const btnCloseNoti = this.$('btnNotificationClose');

    // 알림 카드 액션 버튼 이벤트 위임 (inline onclick 대체)
    const notiListContainer = this.$('notificationListContainer');
    if (notiListContainer) {
      notiListContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.noti-action');
        if (!btn) return;
        e.stopPropagation();

        const action = btn.dataset.action;
        const notiId = parseInt(btn.dataset.notiId);
        if (action === 'adjust') {
          this.openAdjustModal(notiId, btn.dataset.medId);
        } else if (action === 'read') {
          this.markAsRead(notiId);
        } else if (action === 'delete') {
          this.delete(notiId);
        }
      });
    }

    if (btnNoti && popoverNoti) {
      btnNoti.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = popoverNoti.style.display === 'block';
        if (isVisible) {
          popoverNoti.style.display = 'none';
        } else {
          this.render();
          popoverNoti.style.display = 'block';
        }
      });
    }

    if (btnCloseNoti && popoverNoti) {
      btnCloseNoti.addEventListener('click', (e) => {
        e.stopPropagation();
        popoverNoti.style.display = 'none';
      });
    }

    // 팝오버 외부 클릭 감지하여 닫기
    document.addEventListener('click', (e) => {
      if (popoverNoti && popoverNoti.style.display === 'block') {
        if (!popoverNoti.contains(e.target) && !btnNoti.contains(e.target)) {
          popoverNoti.style.display = 'none';
        }
      }
    });

    // 잔량 보정 모달 저장/취소
    const btnAdjCancel = this.$('btnAdjNotificationCancel');
    const btnAdjSave = this.$('btnAdjNotificationSave');
    const modalAdj = this.$('adjustNotificationRemainModal');

    if (btnAdjCancel && modalAdj) {
      btnAdjCancel.addEventListener('click', () => {
        modalAdj.classList.remove('show');
      });
    }

    if (btnAdjSave && modalAdj) {
      btnAdjSave.addEventListener('click', () => {
        const notiId = parseInt(this.$('adjNotificationId').value);
        const medId = this.$('adjNotificationMedId').value;
        const packs = parseInt(this.$('adjNotificationPacks').value) || 0;
        const remain = parseFloat(this.$('adjNotificationRemain').value) || 0;

        if (packs < 0 || remain < 0) {
          this.dialogs.showAlert('팩 개수 및 잔량은 0보다 작을 수 없습니다.');
          return;
        }

        try {
          this.manager.adjustStock(medId, packs, remain);
          this.manager.markNotificationAsRead(notiId);

          this.dialogs.showToast('⚖️ 약재 잔량이 성공적으로 보정되었습니다.');
          modalAdj.classList.remove('show');

          this.render();
          this.app.medicineList.render();
          this.app.prescription.renderPastPrescriptions();
          this.app.predict.render();
        } catch (err) {
          this.dialogs.showAlert(`잔량 보정 실패: ${err.message}`);
        }
      });
    }
  }
}

module.exports = NotificationView;
