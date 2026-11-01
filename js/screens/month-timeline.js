// 月のタイムライン：1か月分の、30分ごとの人数（St・As）を、日ごとに並べて見る（見るだけ。データは変えない）
// 人数の数え方は「1日の詳細」と同じ（K.calc.slotCounts。休憩・社用中・戦力外の人は数えない）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1 + delta, 1)).slice(0, 7);
  }

  function hm(minutes) {
    return U.formatTime(U.fromMinutes(minutes));
  }

  function toolbar(month, store) {
    return el(
      'div',
      { class: 'roster-toolbar' },
      el('button', { type: 'button', class: 'text-btn day-back', onclick: () => K.app.navigate('roster') }, '‹ シフト表'),
      el(
        'div',
        { class: 'month-nav' },
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => K.app.setMonth(shiftMonth(month, -1)) }, '◀'),
        el('h2', { class: 'month-nav__label' }, `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`),
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => K.app.setMonth(shiftMonth(month, 1)) }, '▶')
      ),
      el('span', { class: 'store-tag', style: { '--store-color': store.color } }, store.name)
    );
  }

  // 1か月分の人数を計算する
  // 戻り値：{ from, to, max, days: [{ date, weekday, holiday, state: 'open'|'closed'|'blank', closedLabel, result, slots: Map(分→slot), short }] }
  function monthData(store, month) {
    const staff = K.calc.rosterStaff(store.id, month);
    const map = K.calc.shiftMap(month, store.id);
    let from = Infinity;
    let to = -Infinity;
    let max = 0;
    const days = K.calc.monthDates(month).map((date) => {
      const result = K.calc.slotCounts(staff, map, date, store);
      const entered = staff.some((m) => map.has(`${m.id}|${date}`));
      const closed = K.calc.isStoreClosed(store, date);
      const period = closed ? K.calc.closedPeriodOf(store, date) : null;
      const day = {
        date,
        weekday: K.calc.weekdayOf(date),
        holiday: K.holidays.holidayName(date),
        closedLabel: closed ? (period ? `臨時休業${period.note ? `（${period.note}）` : ''}` : '定休日') : '',
        result,
        slots: new Map(),
        short: 0,
      };
      // 定休日・臨時休業で勤務の人がいない日、まだ誰も入力していない日は、人数の行を出さない
      if (closed && !result.days.length) day.state = 'closed';
      else if (!entered) day.state = 'blank';
      else {
        day.state = 'open';
        from = Math.min(from, result.from);
        to = Math.max(to, result.to);
        for (const s of result.slots) {
          day.slots.set(U.toMinutes(s.start), s);
          max = Math.max(max, s.total);
          if (s.shortSt || s.shortAs) day.short += 1;
        }
      }
      return day;
    });
    if (from === Infinity) {
      from = U.toMinutes(K.calc.hoursOf(store, `${month}-01`).open);
      to = U.toMinutes(K.calc.hoursOf(store, `${month}-01`).close);
    }
    return { from, to, max, days };
  }

  // マスの説明（押したときに画面の下に出す）
  function slotText(day, slot) {
    const d = Number(day.date.slice(8));
    const wd = day.holiday ? '祝' : U.WEEKDAYS[day.weekday];
    let text = `${d}日（${wd}）${slot.start}〜${slot.end}　St ${slot.stylist}人・As ${slot.assistant}人`;
    if (slot.req) text += `（必要 St ${slot.req.stMin}・As ${slot.req.asMin}）`;
    const short = [];
    if (slot.shortSt) short.push(`St が${slot.req.stMin - slot.stylist}人`);
    if (slot.shortAs) short.push(`As が${slot.req.asMin - slot.assistant}人`);
    if (short.length) text += `　${short.join('・')}足りません`;
    if (slot.excluded.length) text += `　休憩・社用など：${slot.excluded.length}人`;
    return text;
  }

  // 色の濃さ（0〜4）：その月のいちばん多い人数を4とする
  function level(total, max) {
    if (!total || !max) return 0;
    return Math.max(1, Math.round((total / max) * 4));
  }

  function table(store, month, data) {
    const times = [];
    for (let t = data.from; t + K.calc.SLOT_MINUTES <= data.to; t += K.calc.SLOT_MINUTES) times.push(t);
    const span = times.length + 2;

    const head = el(
      'tr',
      null,
      el('th', { class: 'mtl-date', scope: 'col' }, '日付'),
      el('th', { class: 'mtl-role', scope: 'col' }, el('span', { class: 'visually-hidden' }, '区分')),
      times.map((t) => el('th', { class: `mtl-time${t % 60 === 0 ? ' is-hour' : ''}`, scope: 'col', 'aria-label': hm(t) }, t % 60 === 0 ? String(t / 60) : '')),
      el('th', { class: 'mtl-short', scope: 'col' }, '不足')
    );

    const dateCell = (day, rowspan) => {
      const d = Number(day.date.slice(8));
      const wd = day.holiday ? '祝' : U.WEEKDAYS[day.weekday];
      return el(
        'th',
        { class: 'mtl-date', scope: 'row', rowspan: rowspan ? String(rowspan) : null },
        el(
          'button',
          {
            type: 'button',
            class: 'mtl-date__btn',
            'aria-label': `${d}日（${wd}）の1日の詳細を開く`,
            onclick: () => K.app.navigate('day', { date: day.date, storeId: store.id, from: 'monthTimeline' }),
          },
          el('span', { class: 'mtl-date__day' }, String(d)),
          el('span', { class: 'mtl-date__wd' }, wd)
        )
      );
    };

    const rows = [];
    for (const day of data.days) {
      const dayCls = day.weekday === 0 || day.holiday ? ' is-sun' : day.weekday === 6 ? ' is-sat' : '';
      if (day.state !== 'open') {
        rows.push(
          el(
            'tr',
            { class: `mtl-row mtl-row--${day.state}${dayCls}`, 'data-date': day.date },
            dateCell(day),
            el('td', { class: 'mtl-note', colspan: String(span) }, day.state === 'closed' ? day.closedLabel : 'まだ入力されていません')
          )
        );
        continue;
      }
      const cells = (role) =>
        times.map((t) => {
          const s = day.slots.get(t);
          if (!s) return el('td', { class: 'mtl-cell is-out' });
          const short = role === 'stylist' ? s.shortSt : s.shortAs;
          return el(
            'td',
            {
              class: `mtl-cell lv-${level(s.total, data.max)}${short ? ' is-short' : ''}`,
              'data-time': String(t),
              title: slotText(day, s),
            },
            String(s[role])
          );
        });
      rows.push(
        el(
          'tr',
          { class: `mtl-row mtl-row--st${dayCls}${day.closedLabel ? ' is-closed-day' : ''}`, 'data-date': day.date },
          dateCell(day, 2),
          el('th', { class: 'mtl-role', scope: 'row' }, 'St'),
          cells('stylist'),
          el('td', { class: `mtl-short${day.short ? ' has-short' : ''}`, rowspan: '2' }, day.short ? `不足${day.short}` : '')
        ),
        el('tr', { class: `mtl-row mtl-row--as${dayCls}`, 'data-date': day.date }, el('th', { class: 'mtl-role', scope: 'row' }, 'As'), cells('assistant'))
      );
    }

    const tableEl = el('table', { class: 'mtl' }, el('thead', null, head), el('tbody', null, rows));
    // マスを押すと、その時間の人数と必要人数を画面の下に出す
    tableEl.addEventListener('click', (event) => {
      const td = event.target.closest('td.mtl-cell[data-time]');
      if (!td) return;
      const day = data.days.find((d) => d.date === td.parentElement.dataset.date);
      const slot = day && day.slots.get(Number(td.dataset.time));
      if (slot) K.app.toast(slotText(day, slot), 5000);
    });
    return tableEl;
  }

  function render(container) {
    const store = K.app.currentStore();
    const month = K.app.state.month;
    const data = monthData(store, month);
    const shortDays = data.days.filter((d) => d.short).length;
    const shortSlots = data.days.reduce((n, d) => n + d.short, 0);
    const hasOpen = data.days.some((d) => d.state === 'open');

    container.append(
      toolbar(month, store),
      el(
        'section',
        { class: 'card mtl-card' },
        el('h3', { class: 'card__title' }, '月のタイムライン（30分ごとの人数）'),
        el(
          'p',
          { class: `mtl-summary${shortSlots ? ' has-short' : ''}` },
          hasOpen ? (shortSlots ? `不足のある日 ${shortDays}日・不足の枠 ${shortSlots}か所` : '必要人数に足りない時間はありません') : 'この月は、まだ勤務が入力されていません'
        ),
        el(
          'p',
          { class: 'mtl-legend' },
          el('span', { class: 'mtl-key lv-2' }),
          '色の濃さ＝その時間の人数（St＋As）',
          el('span', { class: 'mtl-key is-short' }),
          '赤＝必要人数に足りない',
          el('span', { class: 'mtl-legend__note' }, '休憩・社用中の人は数えません。日付を押すとその日の詳細、マスを押すと人数の内訳')
        ),
        el('div', { class: 'mtl-wrap' }, table(store, month, data))
      )
    );
  }

  K.screens = K.screens || {};
  K.screens.monthTimeline = { render };
})();
