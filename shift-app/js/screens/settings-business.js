// 設定 > 毎週の社用（例：チーフ 毎週水曜 14:00〜16:00）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  // 開いているフォーム（null / 'new' / 社用時間ID）
  let formTarget = null;

  function openForm(target) {
    formTarget = target;
    K.app.rerender();
    window.scrollTo(0, 0);
  }

  function closeForm() {
    formTarget = null;
    K.app.rerender();
  }

  function periodLabel(bt) {
    if (!bt.validFrom && !bt.validTo) return '期間の指定なし';
    const f = bt.validFrom ? U.formatDateLabel(bt.validFrom) : '';
    const t = bt.validTo ? U.formatDateLabel(bt.validTo) : '';
    return `${f}〜${t}`;
  }

  function businessForm(bt) {
    const isNew = !bt;
    // 選べるのは、ヘッダーで選んだ店舗のスタッフだけ
    const stores = [K.app.currentStore()];
    const state = { weekday: bt ? bt.weekday : 3 };

    const staffSelect = el(
      'select',
      { id: 'biz-staff', class: 'field__input', disabled: !isNew },
      el('option', { value: '' }, '選んでください'),
      stores.map((s) =>
        el(
          'optgroup',
          { label: s.name },
          K.storage.getStaff({ storeId: s.id }).map((m) => el('option', { value: m.id, selected: bt && bt.staffId === m.id }, `${m.name}（${U.ROLE_SHORT[m.role]}${m.title ? `・${m.title}` : ''}）`))
        )
      )
    );
    // 在籍していない人の分を編集するとき
    if (bt && !staffSelect.querySelector(`option[value="${bt.staffId}"]`)) {
      const m = K.storage.getStaffMember(bt.staffId);
      staffSelect.append(el('option', { value: bt.staffId, selected: true }, m ? m.name : '（削除されたスタッフ）'));
    }

    const weekdayButtons = U.WEEKDAYS.map((label, w) =>
      el(
        'button',
        {
          type: 'button',
          class: `day-toggle${state.weekday === w ? ' is-selected' : ''}`,
          'aria-pressed': String(state.weekday === w),
          'aria-label': `${label}曜日`,
          onclick: (event) => {
            state.weekday = w;
            for (const b of weekdayButtons) {
              const on = b === event.currentTarget;
              b.classList.toggle('is-selected', on);
              b.setAttribute('aria-pressed', String(on));
            }
          },
        },
        label
      )
    );

    const startSelect = U.timeSelect({ id: 'biz-start', value: bt ? bt.start : '14:00', from: 0, to: 23 * 60 + 30 });
    const endSelect = U.timeSelect({ id: 'biz-end', value: bt ? bt.end : '16:00', from: 30, to: 24 * 60 });
    const fromInput = el('input', { id: 'biz-from', class: 'field__input', type: 'date', value: bt ? bt.validFrom : '' });
    const toInput = el('input', { id: 'biz-to', class: 'field__input', type: 'date', value: bt ? bt.validTo : '' });
    const noteInput = el('input', { id: 'biz-note', class: 'field__input', type: 'text', maxlength: '20', placeholder: '例：店長会議', value: bt ? bt.note : '' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }

    function onSubmit(event) {
      event.preventDefault();
      const fields = {
        type: 'weekly',
        staffId: staffSelect.value,
        weekday: state.weekday,
        start: startSelect.value,
        end: endSelect.value,
        validFrom: fromInput.value,
        validTo: toInput.value,
        note: noteInput.value,
      };
      try {
        if (isNew) {
          K.storage.addBusinessTime(fields);
          K.app.toast('追加しました');
        } else {
          K.storage.updateBusinessTime(bt.id, fields);
          K.app.toast('保存しました');
        }
        closeForm();
      } catch (err) {
        showError(err.message);
      }
    }

    function onDelete() {
      if (!window.confirm('この毎週の社用時間を削除しますか？\n（これまでの日の分も含めて、なくなります）')) return;
      try {
        K.storage.deleteBusinessTime(bt.id);
        K.app.toast('削除しました');
        closeForm();
      } catch (err) {
        showError(err.message);
      }
    }

    return el(
      'form',
      { class: 'card', novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, isNew ? '毎週の社用時間を追加' : '毎週の社用時間を編集'),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'biz-staff' }, 'スタッフ'), staffSelect),
      el('div', { class: 'field' }, el('p', { class: 'field__label' }, '曜日'), el('div', { class: 'day-toggles', role: 'group', 'aria-label': '曜日' }, weekdayButtons)),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'biz-start' }, '時間'),
        el('div', { class: 'time-range' }, startSelect, el('span', { class: 'time-range__sep' }, '〜'), endSelect),
        el('p', { class: 'field__note' }, 'その日の勤務時間と重なる部分だけ反映します。休みの日は無視します。')
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'biz-from' }, '有効期間（任意）'),
        el('div', { class: 'time-range' }, fromInput, el('span', { class: 'time-range__sep' }, '〜'), toInput),
        el('p', { class: 'field__note' }, '空欄なら期限なし。')
      ),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'biz-note' }, 'メモ（任意）'), noteInput),
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? '追加する' : '保存する'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeForm }, 'キャンセル'),
        isNew ? null : el('button', { type: 'button', class: 'btn btn--danger', onclick: onDelete }, 'この社用時間を削除')
      )
    );
  }

  function row(bt) {
    const m = K.storage.getStaffMember(bt.staffId);
    const store = m ? K.storage.getStore(m.storeId) : null;
    return el(
      'li',
      null,
      el(
        'button',
        { type: 'button', class: 'pattern-row', onclick: () => openForm(bt.id) },
        el('span', { class: 'biz-row__day' }, `${U.WEEKDAYS[bt.weekday]}`),
        el(
          'span',
          { class: 'pattern-row__main' },
          el(
            'span',
            { class: 'pattern-row__time' },
            `${m ? m.name : '（削除されたスタッフ）'}　${U.formatTime(bt.start)}〜${U.formatTime(bt.end)}`
          ),
          el(
            'span',
            { class: 'pattern-row__sub' },
            [store ? store.name : null, `毎週${U.WEEKDAYS[bt.weekday]}曜`, periodLabel(bt), bt.note || null].filter(Boolean).join('・')
          )
        ),
        el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')
      )
    );
  }

  function render(container) {
    const editing = formTarget && formTarget !== 'new' ? K.storage.getBusinessTimes({ type: 'weekly' }).find((b) => b.id === formTarget) : null;
    if (formTarget === 'new' || editing) {
      container.append(businessForm(editing));
      return;
    }

    // 削除されたスタッフの分は出さない
    const list = K.storage.getBusinessTimes({ type: 'weekly' }).filter((b) => {
      const m = K.storage.getStaffMember(b.staffId);
      // 削除されたスタッフと、ほかの店舗のスタッフの分は出さない
      return m && !m.deleted && m.storeId === K.app.currentStore().id;
    });

    container.append(
      el(
        'div',
        { class: 'toolbar' },
        el('p', { class: 'hint hint--inline' }, '毎週決まった社用時間です。この時間は予約可能人数から除きます。'),
        el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => openForm('new') }, '＋ 追加')
      ),
      list.length
        ? el('ul', { class: 'list-card' }, list.map(row))
        : el('p', { class: 'empty-row' }, 'まだ登録されていません。日付を指定した社用時間は、シフト表の「1日の詳細」で登録します。')
    );
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.business = { render };
})();
