// 設定 > 店舗（追加・名前・営業時間・定休日・臨時休業・色・並び順・削除と元に戻す）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  // 開いているフォーム（null / 'new' / 店舗ID）
  let formTarget = null;
  // 臨時休業の追加欄を開いている店舗のID と、結果の知らせ { storeId, ok, text }
  let periodTarget = null;
  let periodMessage = null;

  // "2026-12-29" → "2026/12/29(火)"
  function dateText(date) {
    const [y, m, d] = date.split('-').map(Number);
    return `${y}/${m}/${d}(${U.WEEKDAYS[K.calc.weekdayOf(date)]})`;
  }

  // ---- 営業日・営業時間（カレンダー・曜日ごとの営業時間・特別営業時間）----
  let calTarget = null; // 開いている店舗のID
  const calMonths = new Map(); // 店舗ID → 表示中の月
  let dayPanel = null; // 日付を押したときの小さな画面 { storeId, date }

  function notify(storeId, ok, text) {
    periodMessage = { storeId, ok, text };
  }

  function workedText(worked) {
    return worked ? `この日には、すでに勤務が${worked}件入っています（変えていません。必要ならシフト表で直してください）。` : '';
  }

  function shiftMonthStr(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + delta, 1));
    return t.toISOString().slice(0, 7);
  }

  // 毎週・第○週の定休日か（臨時休業は含めない）
  function isRegularClosed(store, date) {
    return K.calc.isStoreClosed({ ...store, closedPeriods: [] }, date);
  }

  function run(storeId, fn) {
    try {
      const text = fn();
      if (text) notify(storeId, true, text);
    } catch (err) {
      notify(storeId, false, err.message);
    }
    K.app.rerender();
  }

  function calendarSection(store) {
    const month = calMonths.get(store.id) || K.app.state.month;
    const dates = K.calc.monthDates(month);
    const [y, m] = month.split('-').map(Number);
    const setMonth = (delta) => {
      calMonths.set(store.id, shiftMonthStr(month, delta));
      dayPanel = null;
      K.app.rerender();
    };
    // 曜日を押す：その月のその曜日（定休日を除く）がすべて休業なら戻す。そうでなければ、すべて休業にする
    const toggleWeekday = (w) => {
      const targets = dates.filter((d) => K.calc.weekdayOf(d) === w && !isRegularClosed(store, d));
      if (!targets.length) {
        notify(store.id, false, `${m}月の${U.WEEKDAYS[w]}曜日は、毎週の定休日です（「編集」で変えます）。`);
        K.app.rerender();
        return;
      }
      const allClosed = targets.every((d) => K.calc.closedPeriodOf(store, d));
      run(store.id, () => {
        const r = K.storage.setClosedWeekdayInMonth(store.id, month, w, !allClosed);
        return allClosed
          ? `${m}月の${U.WEEKDAYS[w]}曜日（${r.count}日）を通常営業に戻しました。`
          : `${m}月の${U.WEEKDAYS[w]}曜日（${r.count}日）を休業にしました。${workedText(r.worked)}`;
      });
    };
    const lead = K.calc.weekdayOf(dates[0]);
    const cells = [
      ...Array.from({ length: lead }, () => el('span', { class: 'store-cal__blank', 'aria-hidden': 'true' })),
      ...dates.map((d) => {
        const w = K.calc.weekdayOf(d);
        const holiday = K.holidays.holidayName(d);
        const regular = isRegularClosed(store, d);
        const period = K.calc.closedPeriodOf(store, d);
        const hours = K.calc.hoursOf(store, d);
        const tag = regular ? '定休' : period ? '休業' : hours.special ? '特別' : '';
        const cls = ['store-cal__day', w === 0 || holiday ? 'is-sun' : w === 6 ? 'is-sat' : '', regular ? 'is-regular' : '', period ? 'is-closed' : '', !period && hours.special ? 'is-special' : '', dayPanel && dayPanel.storeId === store.id && dayPanel.date === d ? 'is-selected' : '']
          .filter(Boolean)
          .join(' ');
        return el(
          'button',
          {
            type: 'button',
            class: cls,
            'data-date': d,
            disabled: regular,
            title: regular ? '毎週の定休日（「編集」で変えます）' : holiday || null,
            'aria-label': `${Number(d.slice(8, 10))}日${tag ? `（${tag}）` : ''}`,
            onclick: () => {
              dayPanel = dayPanel && dayPanel.storeId === store.id && dayPanel.date === d ? null : { storeId: store.id, date: d };
              periodMessage = null;
              K.app.rerender();
            },
          },
          el('span', { class: 'store-cal__num' }, String(Number(d.slice(8, 10)))),
          tag ? el('span', { class: 'store-cal__tag' }, tag) : null
        );
      }),
    ];
    return el(
      'div',
      { class: 'store-cal' },
      el(
        'div',
        { class: 'store-cal__head' },
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => setMonth(-1) }, '◀'),
        el('span', { class: 'store-cal__month' }, `${y}年${m}月`),
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => setMonth(1) }, '▶')
      ),
      el(
        'div',
        { class: 'store-cal__grid', role: 'group', 'aria-label': `${y}年${m}月の営業日` },
        U.WEEKDAYS.map((label, w) =>
          el('button', { type: 'button', class: `store-cal__wd${w === 0 ? ' is-sun' : w === 6 ? ' is-sat' : ''}`, 'data-weekday': String(w), 'aria-label': `${m}月の${label}曜日をまとめて休業にする・戻す`, onclick: () => toggleWeekday(w) }, label)
        ),
        cells
      ),
      el('p', { class: 'hint hint--left' }, '曜日を押すと、この月のその曜日をまとめて休業にします（もう一度押すと戻します）。日付を押すと、その日を「通常営業・休業・特別営業時間」から選べます。毎月ずっと同じ曜日が休みなら、「編集」の定休日（毎週）を使ってください。'),
      dayPanel && dayPanel.storeId === store.id && dates.includes(dayPanel.date) ? dayPanelView(store, dayPanel.date) : null
    );
  }

  // 日付を押したときの小さな画面：通常営業／休業／特別営業時間
  function dayPanelView(store, date) {
    const period = K.calc.closedPeriodOf(store, date);
    const hours = K.calc.hoursOf(store, date);
    const state = period ? '休業' : hours.special ? `特別営業時間 ${U.formatTime(hours.open)}〜${U.formatTime(hours.close)}` : `通常営業 ${U.formatTime(hours.open)}〜${U.formatTime(hours.close)}`;
    const openSel = U.timeSelect({ id: `special-open-${store.id}`, value: hours.open });
    const closeSel = U.timeSelect({ id: `special-close-${store.id}`, value: hours.close });
    const noteInput = el('input', { id: `day-note-${store.id}`, class: 'field__input', type: 'text', maxlength: '20', placeholder: 'メモ（任意）例：年末年始・棚卸し', value: (period && period.note) || hours.note || '' });
    const close = () => {
      dayPanel = null;
    };
    return el(
      'div',
      { class: 'store-cal__panel' },
      el('p', { class: 'store-cal__panel-title' }, `${dateText(date)}　今：${state}`),
      noteInput,
      el(
        'div',
        { class: 'actions actions--tight' },
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', 'data-act': 'normal', onclick: () => run(store.id, () => {
          if (period) K.storage.setClosedDay(store.id, date, false);
          if (hours.special) K.storage.removeSpecialHours(store.id, date);
          close();
          return `${dateText(date)}を通常営業にしました。`;
        }) }, '通常営業'),
        el('button', { type: 'button', class: 'btn btn--primary btn--small', 'data-act': 'closed', onclick: () => run(store.id, () => {
          const r = K.storage.setClosedDay(store.id, date, true, noteInput.value);
          close();
          return `${dateText(date)}を休業にしました。${workedText(r.worked)}`;
        }) }, '休業にする')
      ),
      el('div', { class: 'time-range' }, openSel, el('span', { class: 'time-range__sep' }, '〜'), closeSel),
      el(
        'div',
        { class: 'actions actions--tight' },
        el('button', { type: 'button', class: 'btn btn--primary btn--small', 'data-act': 'special', onclick: () => run(store.id, () => {
          K.storage.setSpecialHours(store.id, date, { open: openSel.value, close: closeSel.value, note: noteInput.value });
          close();
          return `${dateText(date)}を特別営業時間（${U.formatTime(openSel.value)}〜${U.formatTime(closeSel.value)}）にしました。この時間の外の必要人数は数えません。`;
        }) }, '特別営業時間にする'),
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => { close(); K.app.rerender(); } }, 'やめる')
      )
    );
  }

  // 曜日ごとの営業時間
  function weekHoursSection(store) {
    const wh = store.weekHours || {};
    const sels = U.WEEKDAYS.map((label, w) => {
      const h = wh[String(w)] || { open: store.open, close: store.close };
      return { open: U.timeSelect({ id: `wh-open-${store.id}-${w}`, value: h.open }), close: U.timeSelect({ id: `wh-close-${store.id}-${w}`, value: h.close }) };
    });
    const copy = (from, toList) => {
      for (const w of toList) {
        sels[w].open.value = sels[from].open.value;
        sels[w].close.value = sels[from].close.value;
      }
    };
    const save = () => run(store.id, () => {
      K.storage.setWeekHours(store.id, Object.fromEntries(sels.map((x, w) => [String(w), { open: x.open.value, close: x.close.value }])));
      return '曜日ごとの営業時間を保存しました。この時間の外の必要人数は数えません。';
    });
    const reset = () => {
      if (!window.confirm('曜日ごとの営業時間をやめて、共通の営業時間（「編集」の営業時間）に戻しますか？')) return;
      run(store.id, () => {
        K.storage.setWeekHours(store.id, {});
        return '共通の営業時間に戻しました。';
      });
    };
    const has = Object.keys(wh).length > 0;
    return el(
      'div',
      { class: 'store-hours' },
      el('p', { class: 'field__label' }, '曜日ごとの営業時間'),
      el('p', { class: 'hint hint--left' }, has ? '保存した曜日ごとの営業時間を使っています。営業時間の外の必要人数は数えず、外にはみ出した勤務はチェックで知らせます。' : `まだ曜日ごとには分けていません（全曜日 ${U.formatTime(store.open)}〜${U.formatTime(store.close)}）。曜日ごとに変えて「保存」を押すと使います。`),
      el(
        'div',
        { class: 'store-hours__rows' },
        U.WEEKDAYS.map((label, w) =>
          el('div', { class: `store-hours__row${w === 0 ? ' is-sun' : w === 6 ? ' is-sat' : ''}` }, el('span', { class: 'store-hours__wd' }, label), sels[w].open, el('span', { class: 'time-range__sep' }, '〜'), sels[w].close)
        )
      ),
      el(
        'div',
        { class: 'actions actions--tight' },
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => copy(1, [2, 3, 4, 5]) }, '月曜の時間を平日（火〜金）に入れる'),
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => copy(6, [0]) }, '土曜の時間を日曜に入れる')
      ),
      el(
        'div',
        { class: 'actions actions--tight' },
        el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: save }, '曜日ごとの営業時間を保存'),
        has ? el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: reset }, '共通の営業時間に戻す') : null
      )
    );
  }

  // 特別営業時間の一覧
  function specialSection(store) {
    const list = Array.isArray(store.specialHours) ? store.specialHours : [];
    return el(
      'div',
      { class: 'store-special' },
      el('p', { class: 'field__label' }, '特別営業時間'),
      list.length
        ? el(
            'ul',
            { class: 'detail-list store-special__list' },
            list.map((h) =>
              el(
                'li',
                { class: 'detail-item' },
                el('span', { class: 'detail-item__text' }, `${dateText(h.date)} ${U.formatTime(h.open)}〜${U.formatTime(h.close)}`, h.note ? el('span', { class: 'detail-item__note' }, h.note) : null),
                el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => {
                  if (!window.confirm(`${dateText(h.date)}の特別営業時間を削除しますか？`)) return;
                  run(store.id, () => {
                    K.storage.removeSpecialHours(store.id, h.date);
                    return '特別営業時間を削除しました。';
                  });
                } }, '削除')
              )
            )
          )
        : el('p', { class: 'hint hint--left' }, 'なし（カレンダーで日付を押して「特別営業時間にする」で追加します）')
    );
  }

  // 店舗のカードの「営業日・営業時間」：閉じているときは件数だけ
  function scheduleBox(store) {
    const periods = Array.isArray(store.closedPeriods) ? store.closedPeriods : [];
    const specials = Array.isArray(store.specialHours) ? store.specialHours : [];
    const open = calTarget === store.id;
    const toggle = el(
      'button',
      { type: 'button', class: 'btn btn--ghost btn--small store-schedule__toggle', 'aria-expanded': String(open), onclick: () => { calTarget = open ? null : store.id; dayPanel = null; periodMessage = null; K.app.rerender(); } },
      open ? '営業日・営業時間を閉じる' : '営業日・営業時間を設定（カレンダー）'
    );
    const msg = periodMessage && periodMessage.storeId === store.id ? periodMessage : null;
    const message = msg ? el('p', { class: msg.ok ? 'sync__result' : 'form-error', role: 'alert' }, msg.text) : null;
    if (!open) {
      return el(
        'div',
        { class: 'store-schedule' },
        el('p', { class: 'hint hint--left' }, `臨時休業 ${periods.length}件・特別営業時間 ${specials.length}件${store.weekHours && Object.keys(store.weekHours).length ? '・曜日ごとの営業時間あり' : ''}`),
        toggle,
        message
      );
    }
    return el('div', { class: 'store-schedule is-open' }, toggle, message, calendarSection(store), weekHoursSection(store), specialSection(store), periodSection(store));
  }

  // 臨時休業（期間）：一覧・削除・追加。入れた期間だけ休業にする（毎年くり返さない）
  function periodSection(store) {
    const list = Array.isArray(store.closedPeriods) ? store.closedPeriods : [];
    const remove = (p) => {
      if (!window.confirm(`${store.name}の臨時休業（${dateText(p.start)}〜${dateText(p.end)}）を削除しますか？\nシフトは変わりません。`)) return;
      try {
        K.storage.removeClosedPeriod(store.id, p.id);
        periodMessage = { storeId: store.id, ok: true, text: '臨時休業を削除しました。' };
      } catch (err) {
        periodMessage = { storeId: store.id, ok: false, text: err.message };
      }
      K.app.rerender();
    };
    const parts = [
      el('p', { class: 'field__label store-periods__title' }, '臨時休業（年末年始など）'),
      list.length
        ? el(
            'ul',
            { class: 'detail-list store-periods' },
            list.map((p) =>
              el(
                'li',
                { class: 'detail-item' },
                el('span', { class: 'detail-item__text' }, `${dateText(p.start)}〜${dateText(p.end)}`, p.note ? el('span', { class: 'detail-item__note' }, p.note) : null),
                el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => remove(p) }, '削除')
              )
            )
          )
        : el('p', { class: 'hint hint--left' }, 'なし（定休日のほかに休む期間があれば追加してください）'),
    ];
    if (periodTarget === store.id) {
      const startInput = el('input', { id: `period-start-${store.id}`, class: 'field__input req-date-input', type: 'date', 'aria-label': '休業の開始日' });
      const endInput = el('input', { id: `period-end-${store.id}`, class: 'field__input req-date-input', type: 'date', 'aria-label': '休業の終了日' });
      const noteInput = el('input', { id: `period-note-${store.id}`, class: 'field__input', type: 'text', maxlength: '20', placeholder: 'メモ（任意）例：年末年始' });
      // 開始日を選んだら、終了日が空ならその日を入れておく
      startInput.addEventListener('change', () => {
        if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value;
      });
      const add = () => {
        try {
          const { worked } = K.storage.addClosedPeriod(store.id, { start: startInput.value, end: endInput.value || startInput.value, note: noteInput.value });
          periodTarget = null;
          periodMessage = {
            storeId: store.id,
            ok: true,
            text: worked
              ? `臨時休業を追加しました。この期間には、すでに勤務が${worked}件入っています（変えていません。必要ならシフト表で直してください）。`
              : '臨時休業を追加しました。AIシフト作成は、この期間に勤務を入れません。',
          };
        } catch (err) {
          periodMessage = { storeId: store.id, ok: false, text: err.message };
        }
        K.app.rerender();
      };
      parts.push(
        el(
          'div',
          { class: 'store-periods__form' },
          el('div', { class: 'time-range' }, startInput, el('span', { class: 'time-range__sep' }, '〜'), endInput),
          noteInput,
          el('p', { class: 'hint hint--left' }, '開始日と終了日を含めて休業にします。その期間だけで、毎年くり返しません。'),
          el(
            'div',
            { class: 'actions actions--tight' },
            el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: add }, '追加する'),
            el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => { periodTarget = null; periodMessage = null; K.app.rerender(); } }, 'やめる')
          )
        )
      );
    } else {
      parts.push(el('button', { type: 'button', class: 'btn btn--ghost btn--small store-periods__add', onclick: () => { periodTarget = store.id; periodMessage = null; K.app.rerender(); } }, '＋ 臨時休業を追加'));
    }
    return el('div', { class: 'store-periods-box' }, parts);
  }

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
      scheduleBox(store),
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
