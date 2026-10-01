// 集計（「この店舗」＝ヘッダーで選んだ店舗だけの集計 ／「店舗の比較」＝全店舗を並べる）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  // 表示するもの：'store'（この店舗）/ 'compare'（店舗の比較）
  let mode = 'store';

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1 + delta, 1)).slice(0, 7);
  }

  function countDays(check) {
    const flags = [...check.dates.values()];
    return { short: flags.filter((f) => f.short).length, over: flags.filter((f) => f.over).length };
  }

  function stat(label, value, warn) {
    return el('div', { class: `stat${warn ? ' is-warn' : ''}` }, el('span', { class: 'stat__label' }, label), el('span', { class: 'stat__value' }, value));
  }

  // ---- この店舗 ----

  function storeCard(store, summary, check) {
    const days = countDays(check);
    const c = summary.staffCount;
    return el(
      'section',
      { class: 'card store-card', style: { '--store-color': store.color } },
      el('h3', { class: 'card__title' }, `${store.name}の月の集計`),
      el(
        'div',
        { class: 'stats stats--card' },
        stat('在籍スタッフ', `${c.total}人`),
        stat('（St／As）', `${c.stylist}／${c.assistant}人`),
        stat('営業日', `${summary.openDays}日`),
        stat('延べ出勤人数', `${summary.personDays}人`),
        stat('月間勤務時間', U.formatHours(summary.totalMinutes)),
        stat('1日平均 St', `${summary.avgStylist}人`),
        stat('1日平均 As', `${summary.avgAssistant}人`),
        stat('延べ社用', `${summary.businessDays}日`),
        stat('延べ有給', `${summary.paidDays}日`),
        stat('人員不足の日', `${days.short}日`, days.short > 0),
        stat('人員過多の日', `${days.over}日`, days.over > 0)
      ),
      el(
        'p',
        { class: 'hint' },
        '延べ出勤人数・1日平均は通常勤務（予約を受けられる人）。月間勤務時間は通常勤務と社用の実働時間の合計です。この店舗での勤務だけを数えます。'
      )
    );
  }

  function staffTable(store, month, check) {
    const staff = K.calc.rosterStaff(store.id, month);
    if (!staff.length) return el('p', { class: 'hint' }, `${store.name}のスタッフはいません。`);
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table' },
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            ['スタッフ', '出勤', '社用', '休', '有', '未入力', '実働'].map((h, i) => el('th', { scope: 'col', class: i === 0 ? 'is-left' : null }, h))
          )
        ),
        el(
          'tbody',
          null,
          staff.map((m) => {
            const d = K.calc.staffMonthDetail(m, month, store.id);
            const short = check.offShort.get(m.id);
            return el(
              'tr',
              null,
              el('th', { scope: 'row', class: 'is-left' }, m.name, ' ', el('span', { class: `role-badge role-badge--${m.role}` }, U.ROLE_SHORT[m.role])),
              el('td', null, String(d.totals.work)),
              el('td', null, String(d.totals.business)),
              el('td', { class: short ? 'is-short' : null, title: short ? `目安${short.target}日` : null }, `${d.totals.off}${short ? '△' : ''}`),
              el('td', null, String(d.totals.paid)),
              el('td', { class: d.totals.blank ? 'is-muted' : null }, String(d.totals.blank)),
              el('td', null, U.formatHours(d.totals.minutes))
            );
          })
        )
      )
    );
  }

  function renderStore(container, month) {
    const store = K.app.currentStore();
    const summary = K.calc.storeMonthSummary(store.id, month);
    const check = K.rules.checkMonth(store.id, month);
    container.append(
      el(
        'div',
        { class: 'stack' },
        storeCard(store, summary, check),
        el(
          'section',
          { class: 'card day-card store-card', style: { '--store-color': store.color } },
          el('h3', { class: 'card__title' }, `${store.name}のスタッフ別`),
          staffTable(store, month, check)
        )
      )
    );
  }

  // ---- 店舗の比較（店舗がいくつあっても、すべて横に並べる。狭い画面では横にスクロール） ----

  // 店舗ごとの数字を横に並べた表
  function metricsTable(stores, summaries, checks) {
    const days = checks.map(countDays);
    const rows = [
      ['在籍スタッフ', (i) => `${summaries[i].staffCount.total}人`],
      ['　スタイリスト', (i) => `${summaries[i].staffCount.stylist}人`],
      ['　アシスタント', (i) => `${summaries[i].staffCount.assistant}人`],
      ['営業日', (i) => `${summaries[i].openDays}日`],
      ['延べ出勤人数', (i) => `${summaries[i].personDays}人`],
      ['月間勤務時間', (i) => U.formatHours(summaries[i].totalMinutes)],
      ['1日平均 St', (i) => `${summaries[i].avgStylist}人`],
      ['1日平均 As', (i) => `${summaries[i].avgAssistant}人`],
      ['1日平均 計', (i) => `${summaries[i].avgTotal}人`],
      ['延べ社用', (i) => `${summaries[i].businessDays}日`],
      ['延べ有給', (i) => `${summaries[i].paidDays}日`],
      ['人員不足の日', (i) => `${days[i].short}日`, (i) => days[i].short > 0],
      ['人員過多の日', (i) => `${days[i].over}日`, (i) => days[i].over > 0],
    ];
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table metrics-table' },
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            el('th', { scope: 'col', class: 'is-left' }, '項目'),
            stores.map((s) => el('th', { scope: 'col', class: 'compare-table__store', style: { '--store-color': s.color } }, s.name))
          )
        ),
        el(
          'tbody',
          null,
          rows.map(([label, value, warn]) =>
            el(
              'tr',
              null,
              el('th', { scope: 'row', class: 'is-left' }, label),
              stores.map((s, i) => el('td', { class: warn && warn(i) ? 'is-short' : null }, value(i)))
            )
          )
        )
      )
    );
  }

  // 日付ごとに各店舗の St／As／計を並べる
  function compareTable(stores, month, summaries, checks) {
    const dates = K.calc.monthDates(month);
    const marks = (flag) => (flag ? `${flag.short ? '△' : ''}${flag.over ? '＋' : ''}` : '');
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table compare-table' },
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            el('th', { scope: 'col', rowspan: '2', class: 'is-left' }, '日付'),
            stores.map((s) => el('th', { scope: 'colgroup', colspan: '3', class: 'compare-table__store', style: { '--store-color': s.color } }, s.name))
          ),
          el('tr', null, stores.flatMap(() => ['St', 'As', '計'].map((h) => el('th', { scope: 'col' }, h))))
        ),
        el(
          'tbody',
          null,
          dates.map((date, i) => {
            const w = K.calc.weekdayOf(date);
            const holiday = K.holidays.holidayName(date);
            const [, m, d] = date.split('-').map(Number);
            return el(
              'tr',
              null,
              el('th', { scope: 'row', class: `is-left${w === 0 || holiday ? ' is-sun' : w === 6 ? ' is-sat' : ''}` }, `${m}/${d}(${holiday ? '祝' : U.WEEKDAYS[w]})`),
              // 店舗ごとに3つ（St・As・計）のマスを並べる（定休日は1つにまとめる）
              stores.flatMap((s, si) => {
                const day = summaries[si].days[i];
                if (day.closed) return [el('td', { colspan: '3', class: 'is-muted compare-table__closed' }, '定休')];
                const flag = checks[si].dates.get(date);
                const cls = (short, over) => (short ? 'is-short' : over ? 'is-over' : null);
                return [
                  el('td', { class: flag ? cls(flag.short && flag.shortSt, flag.over && flag.overSt) : null }, String(day.counts.stylist)),
                  el('td', { class: flag ? cls(flag.short && flag.shortAs, flag.over && flag.overAs) : null }, String(day.counts.assistant)),
                  el('td', { class: 'compare-table__total' }, String(day.counts.total), marks(flag) ? el('span', { class: 'roster__mark' }, marks(flag)) : null),
                ];
              })
            );
          })
        )
      )
    );
  }

  function renderCompare(container, month) {
    const stores = K.storage.getStores();
    const summaries = stores.map((s) => K.calc.storeMonthSummary(s.id, month));
    const checks = stores.map((s) => K.rules.checkMonth(s.id, month));
    container.append(
      el(
        'div',
        { class: 'stack' },
        el(
          'section',
          { class: 'card day-card' },
          el('h3', { class: 'card__title' }, '店舗ごとの月の集計'),
          metricsTable(stores, summaries, checks),
          el('p', { class: 'hint' }, 'それぞれの店舗での勤務だけを数えています。')
        ),
        el(
          'section',
          { class: 'card day-card' },
          el('h3', { class: 'card__title' }, '日ごとの通常勤務の人数'),
          el('p', { class: 'hint' }, '△＝人員不足、＋＝人員過多（必要人数の設定による）。'),
          compareTable(stores, month, summaries, checks)
        )
      )
    );
  }

  function render(container) {
    const month = K.app.state.month;
    const store = K.app.currentStore();

    container.append(
      el(
        'div',
        { class: 'roster-toolbar' },
        el(
          'div',
          { class: 'month-nav' },
          el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => K.app.setMonth(shiftMonth(month, -1)) }, '◀'),
          el('h2', { class: 'month-nav__label' }, `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`),
          el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => K.app.setMonth(shiftMonth(month, 1)) }, '▶')
        ),
        el(
          'div',
          { class: 'segment segment--compact summary-mode', role: 'group', 'aria-label': '集計の種類' },
          [
            ['store', `この店舗（${store.name}）`],
            ['compare', '店舗の比較'],
          ].map(([key, label]) =>
            el(
              'button',
              {
                type: 'button',
                class: `segment__btn${mode === key ? ' is-selected' : ''}`,
                'aria-pressed': String(mode === key),
                onclick: () => {
                  mode = key;
                  K.app.rerender();
                },
              },
              label
            )
          )
        )
      )
    );

    if (mode === 'compare') renderCompare(container, month);
    else renderStore(container, month);
  }

  K.screens = K.screens || {};
  K.screens.summary = { render };
})();
