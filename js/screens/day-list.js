// 「日付ごと」の一覧（幹部の画面・オーナーの申請の画面で共通）：縦に日付と曜日、横にその日に申請したスタッフの名前と状態
// 見るだけ（判断のボタンは「希望休」タブなど）。取り消し済みの申請は出さない
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const WISH_LABELS = { pending: '申請中', approved: '休み', rejected: '非承認' };
  const PAID_LABELS = { pending: '有給・申請中', approved: '有給・承認', rejected: '有給・非承認' };
  // 並べる順：休むことが決まったもの → 申請中 → 社用 → 非承認
  const ORDER = { 'wish-approved': 0, 'paid-approved': 1, 'wish-pending': 2, 'paid-pending': 3, business: 4, 'wish-rejected': 5, 'paid-rejected': 6 };

  // その日の項目：{ key（色の種類）, staffId, name, label, title（読み上げ・ツールチップ用の説明） }
  function itemsOf(date, { wishes, paid, bdays, nameOf, staffOrder }) {
    const list = [];
    for (const w of wishes) {
      if (w.date !== date || !WISH_LABELS[w.status]) continue;
      list.push({ key: `wish-${w.status}`, staffId: w.staffId, label: WISH_LABELS[w.status], title: `希望休・${WISH_LABELS[w.status]}` });
    }
    for (const r of paid) {
      if (r.date !== date || !PAID_LABELS[r.status]) continue;
      list.push({ key: `paid-${r.status}`, staffId: r.staffId, label: PAID_LABELS[r.status], title: PAID_LABELS[r.status] });
    }
    for (const b of bdays) {
      if (b.date !== date || b.status !== 'approved') continue;
      const time = b.start && b.end ? ` ${Number(b.start.slice(0, 2))}${b.start.endsWith(':30') ? ':30' : ''}-${Number(b.end.slice(0, 2))}${b.end.endsWith(':30') ? ':30' : ''}` : '';
      list.push({ key: 'business', staffId: b.staffId, label: `社用${time}`, title: `社用${time ? `（${U.formatTime(b.start)}〜${U.formatTime(b.end)}）` : 'で不在'}：${b.what}${b.detail ? ` ${b.detail}` : ''}`, timed: Boolean(time) });
    }
    for (const x of list) x.name = nameOf(x.staffId);
    const pos = (id) => (staffOrder.has(id) ? staffOrder.get(id) : 9999);
    return list.sort((a, b) => ORDER[a.key] - ORDER[b.key] || pos(a.staffId) - pos(b.staffId));
  }

  function legend() {
    const chip = (key, text) => el('li', { class: `day-chip day-chip--${key}` }, text);
    return el(
      'ul',
      { class: 'day-legend', 'aria-label': '色の見方' },
      chip('wish-pending', '申請中'),
      chip('wish-approved', '承認'),
      chip('wish-rejected', '非承認'),
      chip('paid-approved', '有給'),
      chip('business', '社用で不在')
    );
  }

  // params：{ month, store, staff（並び順に使うスタッフ一覧）, nameOf(staffId), wishes, paid, bdays }
  function render({ month, store, staff, nameOf, wishes, paid, bdays }) {
    const staffOrder = new Map((staff || []).map((m, i) => [m.id, i]));
    const src = { wishes: wishes || [], paid: paid || [], bdays: bdays || [], nameOf, staffOrder };
    const rows = K.calc.monthDates(month).map((date) => {
      const w = K.calc.weekdayOf(date);
      const holiday = K.holidays.holidayName(date);
      const closed = store && K.calc.isStoreClosed(store, date);
      const items = itemsOf(date, src);
      // 休む人数：非承認を除いた人（同じ人は1人と数える）
      const off = new Set(items.filter((x) => !x.key.endsWith('rejected')).map((x) => x.staffId)).size;
      const cls = ['day-list__row', w === 6 ? 'is-sat' : '', w === 0 || holiday ? 'is-sun' : '', closed ? 'is-closed' : '', items.length ? 'has-items' : ''].filter(Boolean).join(' ');
      return el(
        'tr',
        { class: cls, 'data-date': date },
        el(
          'th',
          { scope: 'row', class: 'day-list__date' },
          el('span', { class: 'day-list__md' }, `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`),
          el('span', { class: 'day-list__wd' }, U.WEEKDAYS[w]),
          holiday ? el('span', { class: 'day-list__holiday' }, '祝') : null,
          off ? el('span', { class: 'day-list__count' }, `${off}人`) : null
        ),
        el(
          'td',
          { class: 'day-list__items' },
          closed ? el('span', { class: 'day-list__closed' }, K.calc.closedPeriodOf(store, date) ? '臨時休業' : '定休') : null,
          items.length
            ? el(
                'ul',
                { class: 'day-list__chips' },
                items.map((x) =>
                  el(
                    'li',
                    { class: `day-chip day-chip--${x.key}`, title: x.title },
                    el('span', { class: 'day-chip__name' }, x.name),
                    el('span', { class: 'day-chip__st' }, x.label),
                    x.key === 'business' ? el('span', { class: 'visually-hidden' }, `（${x.title}）`) : null
                  )
                )
              )
            : closed
              ? null
              : el('span', { class: 'day-list__none', 'aria-label': '申請なし' }, '—')
        )
      );
    });
    const total = rows.filter((r) => r.classList.contains('has-items')).length;
    return el(
      'div',
      { class: 'day-list-wrap' },
      el('p', { class: 'hint hint--left' }, `${K.requests.monthLabel(month)}の希望休・有給・社用で不在を、日付ごとに並べています（見るだけ・判断は「希望休」「有給」のタブ）。申請がある日：${total}日`),
      legend(),
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'data-table day-list' },
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, '日付'), el('th', { scope: 'col', class: 'is-left' }, 'スタッフと状態'))),
          el('tbody', null, rows)
        )
      )
    );
  }

  // ---- カレンダーの形（11/8〜）：月のカレンダーの各日に、休む人の名前を色つきで。日を押すと、その日のくわしい内容が下に出る ----
  let selected = null; // 押した日（"2026-12-09"）
  function calendar({ month, store, staff, nameOf, wishes, paid, bdays, onSelect }) {
    const staffOrder = new Map((staff || []).map((m, i) => [m.id, i]));
    const src = { wishes: wishes || [], paid: paid || [], bdays: bdays || [], nameOf, staffOrder };
    const dates = K.calc.monthDates(month);
    if (!selected || !selected.startsWith(month)) selected = null;
    const lead = K.calc.weekdayOf(dates[0]);
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(el('div', { class: 'cal__cell is-empty', 'aria-hidden': 'true' }));
    for (const date of dates) {
      const w = K.calc.weekdayOf(date);
      const holiday = K.holidays.holidayName(date);
      const closed = store && K.calc.isStoreClosed(store, date);
      const items = itemsOf(date, src).filter((x) => !x.key.endsWith('rejected'));
      const cls = ['cal__cell', w === 6 ? 'is-sat' : '', w === 0 || holiday ? 'is-sun' : '', closed ? 'is-closed' : '', date === selected ? 'is-selected' : '', items.length ? 'has-items' : ''].filter(Boolean).join(' ');
      cells.push(
        el(
          'button',
          {
            type: 'button',
            class: cls,
            'data-date': date,
            'aria-label': `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日（${U.WEEKDAYS[w]}）${closed ? ' 定休' : ''} 休む人${items.length}人`,
            'aria-pressed': String(date === selected),
            onclick: () => {
              selected = selected === date ? null : date;
              if (onSelect) onSelect(selected);
              K.app.rerender();
            },
          },
          el('span', { class: 'cal__day' }, String(Number(date.slice(8, 10)))),
          closed ? el('span', { class: 'cal__closed' }, '定休') : null,
          el(
            'span',
            { class: 'cal__names' },
            items.slice(0, 3).map((x) => el('span', { class: `cal__name day-chip--${x.key}` }, x.name.length > 4 ? x.name.slice(0, 4) : x.name)),
            items.length > 3 ? el('span', { class: 'cal__more' }, `+${items.length - 3}`) : null
          )
        )
      );
    }
    const legend = el(
      'ul',
      { class: 'day-legend', 'aria-label': '色の見方' },
      [['wish-approved', '休み'], ['paid-approved', '有給'], ['wish-pending', '申請中'], ['business', '社用'], ['wish-rejected', '非承認']].map(([k, t]) => el('li', { class: `day-chip day-chip--${k}` }, t))
    );
    let detail;
    if (selected) {
      const all = itemsOf(selected, src);
      const w = K.calc.weekdayOf(selected);
      detail = el(
        'div',
        { class: 'cal-detail', role: 'region', 'aria-live': 'polite' },
        el('p', { class: 'cal-detail__head' }, `${Number(selected.slice(5, 7))}/${Number(selected.slice(8, 10))}（${U.WEEKDAYS[w]}）`, el('span', null, all.length ? `　${new Set(all.filter((x) => !x.key.endsWith('rejected')).map((x) => x.staffId)).size}人が休み・社用` : '　申請はありません')),
        all.length
          ? el('ul', { class: 'day-list__chips' }, all.map((x) => el('li', { class: `day-chip day-chip--${x.key}`, title: x.title }, el('span', { class: 'day-chip__name' }, x.name), el('span', { class: 'day-chip__st' }, x.label))))
          : null
      );
    } else {
      detail = el('p', { class: 'cal-detail cal-detail--hint' }, '日を押すと、その日の内容が出ます。');
    }
    return el(
      'div',
      { class: 'cal-wrap' },
      legend,
      el('div', { class: 'cal', role: 'group', 'aria-label': `${K.requests.monthLabel(month)}のカレンダー` }, ['日', '月', '火', '水', '木', '金', '土'].map((d, i) => el('div', { class: `cal__wd${i === 0 ? ' is-sun' : i === 6 ? ' is-sat' : ''}`, 'aria-hidden': 'true' }, d)), cells),
      detail
    );
  }

  K.dayList = { render, itemsOf, calendar };
})();
