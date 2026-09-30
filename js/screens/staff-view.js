// スタッフ別（1人分の月の勤務・実働時間・チェック結果）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const KIND_TEXT = { off: '休', paid: '有' };
  const KIND_LABELS = { off: '通常休', paid: '有給' };

  // 表示中のスタッフ
  let staffId = null;

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1 + delta, 1)).slice(0, 7);
  }

  function mdw(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${m}/${d}(${U.WEEKDAYS[K.calc.weekdayOf(dateStr)]})`;
  }

  function md(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${m}/${d}`;
  }

  function rangeText(r) {
    return `${U.formatTime(U.fromMinutes(r.start))}-${U.formatTime(U.fromMinutes(r.end))}`;
  }

  // スタッフを選ぶ <select>：表示中の店舗の、在籍中の人と、その月にこの店舗のシフトがある人
  function staffSelect(candidates, selectedId) {
    return el(
      'select',
      {
        id: 'staff-view-select',
        class: 'field__input staff-select',
        'aria-label': 'スタッフ',
        onchange: (event) => {
          staffId = event.currentTarget.value;
          K.app.rerender();
        },
      },
      candidates.map((m) =>
        el('option', { value: m.id, selected: m.id === selectedId }, `${m.name}（${U.ROLE_SHORT[m.role]}${m.active ? '' : '・在籍なし'}）`)
      )
    );
  }

  function stat(label, value, note) {
    return el(
      'div',
      { class: `stat${note ? ' is-warn' : ''}` },
      el('span', { class: 'stat__label' }, label),
      el('span', { class: 'stat__value' }, value),
      note ? el('span', { class: 'stat__note' }, note) : null
    );
  }

  function dayRow(member, r, closed, issues) {
    let main;
    let sub = '';
    let cls = 'blank';
    if (r.shift && (r.shift.kind === 'work' || r.shift.kind === 'business')) {
      const p = r.day ? r.day.pattern : K.storage.getPattern(r.shift.patternId);
      cls = r.shift.kind;
      main = el(
        'span',
        { class: `cell cell--${r.shift.kind} staff-day__cell`, style: p ? { '--pattern-color': p.color } : null },
        r.shift.kind === 'business' ? el('span', { class: 'cell__tag' }, '社') : null,
        p ? p.label : '?'
      );
      const parts = [];
      if (r.day) {
        parts.push(`${U.formatTime(p.start)}〜${U.formatTime(p.end)}`);
        if (r.day.breaks.length) parts.push(`休憩 ${r.day.breaks.map(rangeText).join('、')}`);
        const biz = r.day.business.filter((b) => !b.skipped);
        if (biz.length) parts.push(`社用 ${biz.map(rangeText).join('、')}`);
      }
      sub = parts.join('　');
    } else if (r.shift) {
      cls = r.shift.kind;
      main = el('span', { class: `cell cell--${r.shift.kind} staff-day__cell` }, KIND_TEXT[r.shift.kind]);
      sub = KIND_LABELS[r.shift.kind];
    } else if (closed) {
      cls = 'closed';
      main = el('span', { class: 'cell cell--closed staff-day__cell' }, '定休');
    } else {
      main = el('span', { class: 'cell cell--blank staff-day__cell' }, '');
      sub = '未入力';
    }

    const w = K.calc.weekdayOf(r.date);
    const holiday = K.holidays.holidayName(r.date);
    return el(
      'li',
      null,
      el(
        'button',
        {
          type: 'button',
          class: `staff-day staff-day--${cls}${issues ? ' has-issue' : ''}`,
          onclick: () => K.app.navigate('day', { date: r.date, storeId: K.app.state.storeId }),
        },
        el('span', { class: `staff-day__date${w === 0 || holiday ? ' is-sun' : w === 6 ? ' is-sat' : ''}` }, mdw(r.date)),
        main,
        el(
          'span',
          { class: 'staff-day__info' },
          sub ? el('span', { class: 'staff-day__sub' }, sub) : null,
          issues ? el('span', { class: 'staff-day__issue' }, `△ ${issues.join('、')}`) : null
        ),
        el('span', { class: 'staff-day__hours' }, r.minutes ? U.formatHours(r.minutes) : '')
      )
    );
  }

  function render(container) {
    const month = K.app.state.month;
    const store = K.app.currentStore();
    const candidates = K.calc.rosterStaff(store.id, month);

    const toolbar = el(
      'div',
      { class: 'roster-toolbar' },
      el(
        'div',
        { class: 'month-nav' },
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => K.app.setMonth(shiftMonth(month, -1)) }, '◀'),
        el('h2', { class: 'month-nav__label' }, `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`),
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => K.app.setMonth(shiftMonth(month, 1)) }, '▶')
      )
    );

    if (candidates.length === 0) {
      container.append(toolbar, el('p', { class: 'empty-row' }, `${store.name}のスタッフがまだ登録されていません。`));
      return;
    }

    if (!candidates.some((m) => m.id === staffId)) staffId = candidates[0].id;
    const member = candidates.find((m) => m.id === staffId);
    const home = K.storage.getStore(member.storeId);
    toolbar.append(staffSelect(candidates, member.id));

    // 表示中の店舗での勤務だけを数える
    const detail = K.calc.staffMonthDetail(member, month, store.id);
    const checks = K.storage.getChecks();
    const result = K.rules.checkMonth(store.id, month);
    const myIssues = result.issues.filter((i) => i.staffId === member.id && i.type !== 'blank');
    const offShort = result.offShort.get(member.id);
    const t = detail.totals;

    const stats = el(
      'div',
      { class: 'stats' },
      stat('出勤', `${t.work}日`),
      stat('社用', `${t.business}日`),
      stat('休', `${t.off}日`, offShort ? `目安${offShort.target}日` : null),
      stat('有', `${t.paid}日`),
      stat('未入力', `${t.blank}日`),
      stat('実働', U.formatHours(t.minutes))
    );

    const weeks = el(
      'section',
      { class: 'card day-card' },
      el('h3', { class: 'card__title' }, '週ごとの実働（月曜〜日曜）'),
      el(
        'ul',
        { class: 'week-list' },
        detail.weeks.map((w) => {
          const over = checks.hoursCheckEnabled && w.minutes > checks.weeklyHoursLimit * 60;
          return el(
            'li',
            { class: `week-item${over ? ' is-warn' : ''}` },
            el('span', null, `${md(w.start)}〜${md(w.end)}`),
            el('span', { class: 'week-item__hours' }, `${over ? '△ ' : ''}${U.formatHours(w.minutes)}`)
          );
        })
      ),
      el('p', { class: 'hint' }, '月をまたぐ週は、前後の月の分も含めた7日分です。')
    );

    const issueCard = el(
      'section',
      { class: 'card day-card' },
      el('h3', { class: 'card__title' }, 'このスタッフのチェック結果'),
      myIssues.length
        ? el(
            'ul',
            { class: 'check-list' },
            myIssues.map((i) =>
              el(
                'li',
                null,
                el(
                  'div',
                  { class: 'check-item' },
                  el('span', { class: 'check-item__date' }, K.rules.TYPE_LABELS[i.type]),
                  el('span', { class: 'check-item__text' }, i.message)
                )
              )
            )
          )
        : el('p', { class: 'hint' }, '問題は見つかりませんでした。')
    );

    container.append(
      toolbar,
      el(
        'p',
        { class: 'day-summary' },
        el('span', { class: 'day-summary__counts' }, member.name),
        `${store.name}での勤務・${U.ROLE_LABELS[member.role]}${member.title ? `・${member.title}` : ''}${home && home.id !== store.id ? `（現在は${home.name}の所属）` : ''}`
      ),
      stats,
      el(
        'div',
        { class: 'stack' },
        el(
          'section',
          { class: 'card day-card' },
          el('h3', { class: 'card__title' }, '毎日の勤務'),
          el('p', { class: 'hint' }, '行をタップすると、その日の1日の詳細を開きます。'),
          el(
            'ul',
            { class: 'staff-days' },
            detail.rows.map((r) => dayRow(member, r, K.calc.isStoreClosed(store, r.date), result.cells.get(`${member.id}|${r.date}`)))
          )
        ),
        weeks,
        issueCard
      )
    );
  }

  K.screens = K.screens || {};
  K.screens.staff = { render };
})();
