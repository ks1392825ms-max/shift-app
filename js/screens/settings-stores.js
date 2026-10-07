// 設定 > 店舗（追加・名前・営業時間・定休日・色・並び順・削除と元に戻す）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  // 開いているフォーム（null / 'new' / 店舗ID）
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

  function move(id, direction) {
    try {
      K.storage.moveStore(id, direction);
      K.app.rerender();
    } catch (err) {
      K.app.toast(err.message);
    }
  }

  function summaryCard(store, index, count) {
    const closedParts = [
      store.closedWeekdays.length ? store.closedWeekdays.map((w) => U.WEEKDAYS[w]).join('・') + '曜' : null,
      ...(store.closedNthWeekdays || []).map((x) => `${x.weeks.map((n) => `第${n}`).join('・')}${U.WEEKDAYS[x.weekday]}曜`),
    ].filter(Boolean);
    const closed = closedParts.length ? closedParts.join('、') : 'なし';
    const staffCount = K.storage.getStaff({ storeId: store.id }).length;
    const isCurrent = store.id === K.app.state.storeId;

    return el(
      'section',
      { class: 'card store-card', style: { '--store-color': store.color } },
      el(
        'div',
        { class: 'card__head' },
        el(
          'h2',
          { class: 'card__title' },
          store.name,
          isCurrent ? el('span', { class: 'current-badge' }, '表示中') : null
        ),
        el(
          'div',
          { class: 'store-card__actions' },
          U.moveButtons({ name: store.name, index, count, onMove: (direction) => move(store.id, direction) }),
          el('button', { type: 'button', class: 'text-btn', onclick: () => openForm(store.id) }, '編集')
        )
      ),
      el(
        'dl',
        { class: 'info-list' },
        el('dt', null, '営業時間'),
        el('dd', null, `${U.formatTime(store.open)} 〜 ${U.formatTime(store.close)}`),
        el('dt', null, '定休日'),
        el('dd', null, closed),
        el('dt', null, '在籍スタッフ'),
        el('dd', null, `${staffCount}人`)
      ),
      isCurrent
        ? null
        : el(
            'button',
            { type: 'button', class: 'btn btn--ghost btn--small store-card__show', onclick: () => K.app.setStore(store.id) },
            `${store.name}を表示する`
          )
    );
  }

  // 追加・編集の共通フォーム（store が null なら追加）
  function storeForm(store) {
    const isNew = !store;
    const base = store || { name: '', open: '09:00', close: '20:00', closedWeekdays: [], color: null };
    const closedWeekdays = new Set(base.closedWeekdays);
    let color = base.color;

    const nameInput = el('input', {
      id: 'store-name',
      class: 'field__input',
      type: 'text',
      maxlength: '10',
      placeholder: '例：店舗C、駅前店',
      value: base.name,
    });
    const openSelect = U.timeSelect({ id: 'store-open', value: base.open });
    const closeSelect = U.timeSelect({ id: 'store-close', value: base.close });
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

    // 第○週の○曜日の定休日（例：第1・第3火曜）。曜日ごとに第1〜第5週を選ぶ
    const nthClosed = new Map((base.closedNthWeekdays || []).map((x) => [x.weekday, new Set(x.weeks)]));
    const nthGrid = el(
      'div',
      { class: 'nth-grid', role: 'group', 'aria-label': '第○週の定休日' },
      [1, 2, 3, 4, 5, 6, 0].map((w) =>
        el(
          'div',
          { class: `nth-grid__row${w === 0 ? ' is-sun' : w === 6 ? ' is-sat' : ''}` },
          el('span', { class: 'nth-grid__day' }, U.WEEKDAYS[w]),
          [1, 2, 3, 4, 5].map((n) => {
            const on = Boolean(nthClosed.get(w) && nthClosed.get(w).has(n));
            return el(
              'button',
              {
                type: 'button',
                class: `nth-toggle${on ? ' is-selected' : ''}`,
                'aria-pressed': String(on),
                'aria-label': `第${n}${U.WEEKDAYS[w]}曜日`,
                onclick: (event) => {
                  if (!nthClosed.has(w)) nthClosed.set(w, new Set());
                  const set = nthClosed.get(w);
                  if (set.has(n)) set.delete(n);
                  else set.add(n);
                  event.currentTarget.classList.toggle('is-selected', set.has(n));
                  event.currentTarget.setAttribute('aria-pressed', String(set.has(n)));
                },
              },
              `第${n}`
            );
          })
        )
      )
    );

    // 色（追加のときは、選ばなければ自動で使われていない色にする）
    const colors = K.defaults.storeColors;
    const swatches = el(
      'div',
      { class: 'swatches', role: 'group', 'aria-label': '店舗の色' },
      (color && !colors.includes(color) ? [color, ...colors] : colors).map((c, i) =>
        el('button', {
          type: 'button',
          class: `swatch${c === color ? ' is-selected' : ''}`,
          style: { '--swatch-color': c },
          'aria-label': `色${i + 1}`,
          'aria-pressed': String(c === color),
          onclick: (event) => {
            color = c;
            for (const b of swatches.children) {
              const on = b === event.currentTarget;
              b.classList.toggle('is-selected', on);
              b.setAttribute('aria-pressed', String(on));
            }
          },
        })
      )
    );

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }

    function onSubmit(event) {
      event.preventDefault();
      const fields = {
        name: nameInput.value,
        open: openSelect.value,
        close: closeSelect.value,
        closedWeekdays: [...closedWeekdays],
        closedNthWeekdays: [...nthClosed].filter(([, weeks]) => weeks.size).map(([weekday, weeks]) => ({ weekday, weeks: [...weeks] })),
        color,
      };
      try {
        if (isNew) {
          const added = K.storage.addStore(fields);
          K.app.toast(`${added.name}を追加しました`);
          formTarget = null;
          // 追加した店舗を表示して、続けてスタッフを登録できるようにする
          K.app.setStore(added.id);
        } else {
          K.storage.updateStore(store.id, fields);
          K.app.toast('保存しました');
          closeForm();
        }
      } catch (err) {
        showError(err.message);
      }
    }

    function onDelete() {
      const message =
        `${store.name}を削除しますか？\n` +
        'この店舗のシフト・集計などの記録は消えずに残り、「削除した店舗」から元に戻せます。';
      if (!window.confirm(message)) return;
      try {
        K.storage.deleteStore(store.id);
        K.app.toast('削除しました');
        formTarget = null;
        K.app.rerender();
      } catch (err) {
        showError(err.message);
      }
    }

    setTimeout(() => nameInput.focus(), 0);

    return el(
      'form',
      { class: 'card store-card', style: { '--store-color': color || 'var(--border)' }, novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, isNew ? '店舗を追加' : `${store.name}を編集`),
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
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '定休日（第○週の○曜日）'),
        nthGrid,
        el('p', { class: 'field__note' }, '例：第1・第3火曜が休みなら、「火」の行の「第1」「第3」を選びます。毎週の定休日にした曜日は、ここでは選ばなくて大丈夫です。')
      ),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, isNew ? '色（選ばなければ自動）' : '色'),
        swatches
      ),
      isNew
        ? el(
            'p',
            { class: 'field__note' },
            '追加した店舗は、専用のスタッフ・シフト・集計・必要人数・チェックの基準を持ちます。追加したあと、その店舗の表示に切り替わります。'
          )
        : null,
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? '追加する' : '保存する'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeForm }, 'キャンセル'),
        isNew ? null : el('button', { type: 'button', class: 'btn btn--danger', onclick: onDelete }, 'この店舗を削除')
      )
    );
  }

  function deletedSection() {
    const deleted = K.storage.getDeletedStores();
    if (!deleted.length) return null;
    return el(
      'section',
      { class: 'store-group store-group--inactive' },
      el('div', { class: 'store-group__head' }, el('h2', { class: 'store-group__title' }, '削除した店舗')),
      el(
        'ul',
        { class: 'list-card' },
        deleted.map((s) =>
          el(
            'li',
            { class: 'staff-row is-inactive' },
            el('div', { class: 'staff-row__main' }, el('div', { class: 'staff-row__name' }, s.name)),
            el(
              'button',
              {
                type: 'button',
                class: 'text-btn',
                onclick: () => {
                  try {
                    K.storage.restoreStore(s.id);
                    K.app.toast(`${s.name}を元に戻しました`);
                    K.app.rerender();
                  } catch (err) {
                    K.app.toast(err.message);
                  }
                },
              },
              '元に戻す'
            )
          )
        )
      )
    );
  }

  function render(container) {
    const editing = formTarget && formTarget !== 'new' ? K.storage.getStore(formTarget) : null;
    if (formTarget === 'new' || (editing && !editing.deleted)) {
      container.append(storeForm(formTarget === 'new' ? null : editing));
      return;
    }

    const stores = K.storage.getStores();
    const parts = [
      el(
        'div',
        { class: 'toolbar' },
        el('p', { class: 'hint hint--inline' }, '店舗ごとに営業時間・定休日を設定します。並び順は、画面上部の店舗の切り替えの順番です。'),
        el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => openForm('new') }, '＋ 店舗を追加')
      ),
      el('div', { class: 'stack' }, stores.map((s, i) => summaryCard(s, i, stores.length))),
      deletedSection(),
    ];
    container.append(...parts.filter(Boolean));
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.stores = { render };
})();
