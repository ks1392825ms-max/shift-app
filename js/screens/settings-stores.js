// 設定 > 店舗（名前・営業時間・定休日）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  // 編集中の店舗ID（null なら閉じている）
  let editingId = null;

  function summaryCard(store) {
    const closed = store.closedWeekdays.length ? store.closedWeekdays.map((w) => U.WEEKDAYS[w]).join('・') + '曜' : 'なし';

    return el(
      'section',
      { class: 'card store-card', style: { '--store-color': store.color } },
      el(
        'div',
        { class: 'card__head' },
        el('h2', { class: 'card__title' }, store.name),
        el(
          'button',
          {
            type: 'button',
            class: 'text-btn',
            onclick: () => {
              editingId = store.id;
              K.app.rerender();
            },
          },
          '編集'
        )
      ),
      el(
        'dl',
        { class: 'info-list' },
        el('dt', null, '営業時間'),
        el('dd', null, `${U.formatTime(store.open)} 〜 ${U.formatTime(store.close)}`),
        el('dt', null, '定休日'),
        el('dd', null, closed)
      )
    );
  }

  function editForm(store) {
    const closedWeekdays = new Set(store.closedWeekdays);

    const nameInput = el('input', {
      id: 'store-name',
      class: 'field__input',
      type: 'text',
      maxlength: '10',
      value: store.name,
    });
    const openSelect = U.timeSelect({ id: 'store-open', value: store.open });
    const closeSelect = U.timeSelect({ id: 'store-close', value: store.close });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    const weekdayButtons = U.WEEKDAYS.map((label, w) =>
      el(
        'button',
        {
          type: 'button',
          class: `day-toggle${closedWeekdays.has(w) ? ' is-selected' : ''}`,
          'aria-pressed': String(closedWeekdays.has(w)),
          'aria-label': `${label}曜日`,
          onclick: (event) => {
            if (closedWeekdays.has(w)) closedWeekdays.delete(w);
            else closedWeekdays.add(w);
            const on = closedWeekdays.has(w);
            event.currentTarget.classList.toggle('is-selected', on);
            event.currentTarget.setAttribute('aria-pressed', String(on));
          },
        },
        label
      )
    );

    function close() {
      editingId = null;
      K.app.rerender();
    }

    function onSubmit(event) {
      event.preventDefault();
      try {
        K.storage.updateStore(store.id, {
          name: nameInput.value,
          open: openSelect.value,
          close: closeSelect.value,
          closedWeekdays: [...closedWeekdays],
        });
        K.app.toast('保存しました');
        close();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    return el(
      'form',
      { class: 'card store-card', style: { '--store-color': store.color }, novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, `${store.name}を編集`),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'store-name' }, '店舗名'), nameInput),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'store-open' }, '営業時間'),
        el('div', { class: 'time-range' }, openSelect, el('span', { class: 'time-range__sep' }, '〜'), closeSelect)
      ),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '定休日（毎週）'),
        el('div', { class: 'day-toggles', role: 'group', 'aria-label': '定休日' }, weekdayButtons)
      ),
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, '保存する'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, 'キャンセル')
      )
    );
  }

  function render(container) {
    container.append(
      el('p', { class: 'hint' }, '営業時間は時間帯別の人数に、定休日はシフト表に使います。'),
      el(
        'div',
        { class: 'stack' },
        K.storage.getStores().map((store) => (store.id === editingId ? editForm(store) : summaryCard(store)))
      )
    );
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.stores = { render };
})();
