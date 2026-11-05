// 幹部の画面（共有モードで、幹部として登録された人＝managers/{メール} があるとき）
// ・担当店舗の希望休・有給の申請を一覧で見て、受付期間（オーナーが選ぶ。初めは25日〜月末・翌月分）だけ、承認・却下・申請中に戻すことができる
//   変えられるのは「申請中」のものと、自分が判断したものだけ（自分の申請・ほかの幹部やオーナーが判断したものは変えられない）
// ・担当店舗の判断の履歴を見る
// ・担当店舗の確定・公開済みのシフト（公開用の写し）を見る（作成中のシフト・担当外の店舗は読めない）
// 読み書きの決まりは Firestore のルールでも強制している（画面のボタンは、その決まりに合わせて出し分けるだけ）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const R = () => K.requests;

  const ROLE_LABELS = { owner: 'オーナー', manager: '幹部' };
  const STATUS_SHORT = { pending: '申請中', approved: '承認', rejected: '却下', cancelled: '取り消し済み', '': '（新規）' };
  const KIND_LABELS = { wish: '希望休', paid: '有給', change: '変更申請' };

  let view = null;

  function reset(params) {
    view = {
      email: params.email,
      manager: params.manager,
      account: params.account || null,
      loading: true,
      ctx: null, // { stores（担当店舗）, staff（担当店舗のスタッフ）, settings }
      storeId: null,
      month: R().requestWindow().month,
      tab: 'wish', // wish / paid / log / roster
      data: null, // { wishRequests, wishCounts, paidRequests, quotas, logs }
      message: null,
      pub: null, // { loading, rosters, month, storeId, error }
    };
    load();
  }

  function backend() {
    return K.app.cloudBackend();
  }

  function show(ok, text) {
    view.message = { ok, text };
    K.app.rerender();
  }

  async function load() {
    try {
      view.ctx = await backend().loadManagerContext(view.manager);
      R().usePeriodSettings(view.ctx.settings); // オーナーが選んだ受付期間
      view.storeId = view.ctx.stores.length ? view.ctx.stores[0].id : null;
      await loadRequests();
    } catch (err) {
      view.message = { ok: false, text: `読み込めませんでした（${err.message}）` };
    }
    view.loading = false;
    K.app.rerender();
  }

  async function loadRequests() {
    view.data = await backend().loadManagerRequests(view.ctx.stores.map((s) => s.id), view.month);
  }

  async function reload(text) {
    try {
      await loadRequests();
      show(true, text);
    } catch (err) {
      show(false, `読み込めませんでした（${err.message}）`);
    }
  }

  function shortDate(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${U.WEEKDAYS[K.calc.weekdayOf(date)]}）`;
  }

  function stamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function staffName(id) {
    const m = view.ctx.staff.find((s) => s.id === id);
    return m ? m.name : '（不明なスタッフ）';
  }

  function decidedText(r) {
    if (!r.decidedBy) return null;
    const who = r.decidedBy === view.email ? 'あなた' : r.decidedBy;
    return `判断：${ROLE_LABELS[r.decidedRole] || ''} ${who} ${stamp(r.decidedAt)}`.trim();
  }

  // この申請を幹部（自分）が変えられるか：{ ok, why }
  function canChange(r) {
    if (r.status === 'cancelled') return { ok: false, why: '取り消し済み' };
    if (r.reflectedAt) return { ok: false, why: 'シフト表に反映済み' };
    if (view.account && view.account.staffIds.includes(r.staffId)) return { ok: false, why: R().isSelfWish(r, view.email) ? '自分で登録（確定）' : '自分の申請（オーナーが判断します）' };
    const w = R().requestWindow();
    if (!w.open || r.month !== w.month) return { ok: false, why: '受付期間外のため、変更はオーナーだけです' };
    if (r.status === 'pending') return { ok: true };
    if (r.decidedRole === 'manager' && r.decidedBy === view.email) return { ok: true };
    return { ok: false, why: r.decidedRole === 'owner' ? 'オーナーが判断済み（変更できません）' : 'ほかの幹部が判断済み（変更できません）' };
  }

  function decideButtons(kind, r) {
    const c = canChange(r);
    if (!c.ok) return [el('span', { class: 'req-decision__by' }, c.why)];
    const act = (status, label) =>
      el(
        'button',
        {
          type: 'button',
          class: `btn btn--small ${status === 'approved' ? 'btn--primary' : 'btn--ghost'}`,
          onclick: async () => {
            let reason = '';
            if (status === 'rejected') {
              reason = window.prompt('却下の理由を入れてください（50文字以内・スタッフにも表示されます）', '');
              if (reason === null) return;
            }
            try {
              await R().decide(kind, r, { status, reason, email: view.email, role: 'manager' });
              const done = { approved: '承認しました。', rejected: '却下しました。', pending: '申請中に戻しました。' }[status];
              await reload(`${staffName(r.staffId)}さんの${shortDate(r.date)}を${done}`);
            } catch (err) {
              show(false, err.code === 'permission-denied' ? 'この申請は変更できません（担当外・自分の申請・ほかの人の判断・受付期間外のいずれか）。画面を読み込み直してください。' : err.message);
            }
          },
        },
        label
      );
    return [
      r.status !== 'approved' ? act('approved', '承認') : null,
      r.status !== 'rejected' ? act('rejected', '却下') : null,
      r.status !== 'pending' ? act('pending', '申請中に戻す') : null,
    ].filter(Boolean);
  }

  function decisionItem(kind, r) {
    return el(
      'li',
      { class: 'req-holiday-item req-decision', 'data-id': r.id },
      el('span', null, shortDate(r.date)),
      r.originalDate ? el('span', { class: 'detail-item__note' }, `（${shortDate(r.originalDate)}から変更）`) : null,
      el('span', { class: `req-status req-status--${r.status}` }, R().STATUS_LABELS[r.status] || r.status),
      decidedText(r) ? el('span', { class: 'req-decision__by' }, decidedText(r)) : null,
      ...decideButtons(kind, r),
      r.note ? el('span', { class: 'detail-item__note' }, `備考：${r.note}`) : null,
      r.status === 'rejected' && r.reason ? el('span', { class: 'req-reason' }, `却下の理由：${r.reason}`) : null
    );
  }

  // ---- 部品 ----
  function storeChips() {
    return el(
      'div',
      { class: 'req-choices' },
      view.ctx.stores.map((s) =>
        el(
          'button',
          {
            type: 'button',
            class: `req-choice${s.id === view.storeId ? ' is-selected' : ''}`,
            style: { '--store-color': s.color },
            'aria-pressed': String(s.id === view.storeId),
            onclick: () => {
              view.storeId = s.id;
              view.message = null;
              K.app.rerender();
            },
          },
          s.name
        )
      )
    );
  }

  function monthNav() {
    const move = async (delta) => {
      const [y, m] = view.month.split('-').map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      view.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      view.message = null;
      await reload('');
      view.message = null;
      K.app.rerender();
    };
    return el(
      'div',
      { class: 'month-nav' },
      el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => move(-1) }, '◀'),
      el('h2', { class: 'month-nav__label' }, R().monthLabel(view.month)),
      el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => move(1) }, '▶')
    );
  }

  function tabs() {
    const pend = (list) => list.filter((r) => r.storeId === view.storeId && r.status === 'pending').length;
    return el(
      'div',
      { class: 'segment segment--compact req-tabs mgr-tabs', role: 'tablist', 'aria-label': '幹部の画面の切り替え' },
      [
        ['wish', '希望休', pend(view.data.wishRequests)],
        ['days', '日付ごと', 0],
        ['paid', '有給', pend(view.data.paidRequests)],
        ['change', '変更申請', pend(view.data.changeRequests || [])],
        ['log', '履歴', 0],
        ['roster', '確定シフト', 0],
      ].map(([key, label, n]) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `segment__btn${view.tab === key ? ' is-selected' : ''}`,
            'aria-selected': String(view.tab === key),
            onclick: () => {
              view.tab = key;
              view.message = null;
              if (key === 'roster' && !view.pub) loadPublished();
              K.app.rerender();
            },
          },
          label,
          n ? el('span', { class: 'req-badge' }, String(n)) : null
        )
      )
    );
  }

  // ---- 希望休（スタッフ別） ----
  function wishView() {
    const staff = view.ctx.staff.filter((m) => m.storeId === view.storeId && m.active !== false);
    if (!staff.length) return el('p', { class: 'empty-row' }, 'この店舗のスタッフがいません。');
    const rows = staff.map((m) => {
      const list = view.data.wishRequests.filter((w) => w.staffId === m.id).sort((a, b) => a.date.localeCompare(b.date));
      const counted = view.data.wishCounts.some((c) => c.staffId === m.id);
      const quota = view.data.quotas.find((q) => q.staffId === m.id);
      const limit = R().limitFor(view.ctx.settings, quota);
      return el(
        'tr',
        null,
        el('th', { scope: 'row', class: 'is-left' }, m.name, m.title ? el('span', { class: 'title-badge' }, ` ${m.title}`) : null),
        el(
          'td',
          { class: 'is-left' },
          list.length ? el('ul', { class: 'req-holiday-list' }, list.map((w) => decisionItem('wish', w))) : counted ? '希望なし' : el('span', { class: 'req-unsent' }, '未提出')
        ),
        el('td', null, `${list.length}／${limit}日`)
      );
    });
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table req-table' },
        el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'is-left' }, 'スタッフ'), el('th', { scope: 'col', class: 'is-left' }, '希望休と判断'), el('th', { scope: 'col' }, '日数／上限'))),
        el('tbody', null, rows)
      )
    );
  }

  // ---- 日付ごと（見るだけ）：縦に日付、横にスタッフ名と状態 ----
  function daysView() {
    const mine = (list) => (list || []).filter((r) => r.storeId === view.storeId && r.month === view.month);
    return K.dayList.render({
      month: view.month,
      store: view.ctx.stores.find((s) => s.id === view.storeId),
      staff: view.ctx.staff.filter((m) => m.storeId === view.storeId),
      nameOf: staffName,
      wishes: mine(view.data.wishRequests),
      paid: mine(view.data.paidRequests),
      bdays: mine(view.data.businessDays),
    });
  }

  // ---- 有給 ----
  function paidView() {
    const list = view.data.paidRequests.filter((r) => r.storeId === view.storeId).sort((a, b) => a.date.localeCompare(b.date));
    if (!list.length) return el('p', { class: 'empty-row' }, `${R().monthLabel(view.month)}の有給申請はありません。`);
    return el(
      'ul',
      { class: 'req-log-list' },
      list.map((r) => el('li', { class: 'req-log-item' }, el('strong', null, staffName(r.staffId)), el('ul', { class: 'req-holiday-list' }, decisionItem('paid', r))))
    );
  }

  // ---- 変更申請（担当店舗。判断だけ。シフト表への反映はオーナー） ----
  function changeView() {
    const list = (view.data.changeRequests || []).filter((c) => c.storeId === view.storeId).sort((a, b) => a.date.localeCompare(b.date));
    const head = el('p', { class: 'hint hint--left' }, '承認済みの希望休・有給の取り消し・日付の変更の申請です。承認すると、オーナーがシフト表に反映します。');
    if (!list.length) return el('div', null, head, el('p', { class: 'empty-row' }, `${R().monthLabel(view.month)}の変更申請はありません。`));
    return el(
      'div',
      null,
      head,
      el(
        'ul',
        { class: 'req-log-list' },
        list.map((c) =>
          el(
            'li',
            { class: 'req-log-item' },
            el('strong', null, staffName(c.staffId)),
            el(
              'ul',
              { class: 'req-holiday-list' },
              el(
                'li',
                { class: 'req-holiday-item req-decision', 'data-id': c.id },
                el('span', null, R().changeText(c)),
                el('span', { class: `req-status req-status--${c.status}` }, R().STATUS_LABELS[c.status] || c.status),
                decidedText(c) ? el('span', { class: 'req-decision__by' }, decidedText(c)) : null,
                ...decideButtons('change', c),
                c.note ? el('span', { class: 'detail-item__note' }, `理由：${c.note}`) : null,
                c.status === 'rejected' && c.reason ? el('span', { class: 'req-reason' }, `却下の理由：${c.reason}`) : null,
                c.status === 'approved' ? el('span', { class: 'req-reason' }, c.reflectedAt ? 'オーナーがシフト表に反映しました。' : 'オーナーの反映待ち') : null
              )
            )
          )
        )
      )
    );
  }

  // ---- 判断の履歴 ----
  function logView() {
    const logs = view.data.logs.filter((l) => l.storeId === view.storeId).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    if (!logs.length) return el('p', { class: 'empty-row' }, `${R().monthLabel(view.month)}の判断の履歴はありません。`);
    return el(
      'ul',
      { class: 'req-log-list' },
      logs.map((l) =>
        el(
          'li',
          { class: 'req-log-item' },
          el('span', { class: 'req-log-item__time' }, stamp(l.at)),
          ' ',
          `${staffName(l.staffId)}　${KIND_LABELS[l.kind] || ''} ${l.date ? shortDate(l.date) : ''}　${l.from === l.to ? l.note || '変更' : `${STATUS_SHORT[l.from] || l.from} → ${STATUS_SHORT[l.to] || l.to}`}`,
          el('span', { class: 'req-decision__by' }, `　${ROLE_LABELS[l.role] || ''} ${l.by === view.email ? 'あなた' : l.by}`),
          l.reason ? el('span', { class: 'req-reason' }, `理由：${l.reason}`) : null
        )
      )
    );
  }

  // ---- 確定シフト（担当店舗・確定済みの写しだけ） ----
  function rosterMonths() {
    const thisMonth = R().todayJst().slice(0, 7);
    return [thisMonth, R().nextMonthOf(thisMonth)];
  }

  async function loadPublished() {
    view.pub = { loading: true, rosters: [], month: null, storeId: null, error: null };
    K.app.rerender();
    try {
      const months = rosterMonths();
      const rosters = await backend().loadManagerPublishedRosters(view.ctx.stores.map((s) => s.id), months);
      const first = months.find((m) => rosters.some((r) => r.month === m)) || months[0];
      const firstStore = (rosters.find((r) => r.month === first) || {}).storeId || null;
      view.pub = { loading: false, rosters, month: first, storeId: firstStore, error: null };
    } catch (err) {
      view.pub = { loading: false, rosters: [], month: null, storeId: null, error: `確定シフトを読み込めませんでした（${err.message}）` };
    }
    K.app.rerender();
  }

  // 確定シフトの表：管理者のシフト表と同じ見た目（見るだけ・押しても何も変わらない）
  // 中身は公開用の写しだけ（勤務パターンの色は写しにないので、勤務のマスは1色）
  const PUB_WORK_COLOR = '#64748b';
  // 「9:00〜18:00」→「9-18」（分があるときは「9:30-18」）。管理者のシフト表のマスと同じくらいの幅にする
  function shortRange(t) {
    return String(t || '').replace(/:00/g, '').replace('〜', '-');
  }

  function pubCell(cell, closed) {
    if (!cell) return closed ? { cls: 'cell--closed', text: '定休', label: '定休日' } : { cls: 'cell--blank', text: '', label: '空欄' };
    if (cell.k === 'work') return { cls: 'cell--work', text: shortRange(cell.t), label: `勤務 ${cell.t}` };
    if (cell.k === 'business') return { cls: 'cell--business', text: [el('span', { class: 'cell__tag' }, '社'), shortRange(cell.t)], label: `社用 ${cell.t}` };
    if (cell.k === 'closed') return { cls: 'cell--closed', text: cell.t || '定休', label: cell.t === '休業' ? '臨時休業' : '定休日' };
    if (cell.k === 'off') return { cls: 'cell--off', text: '休', label: '休み' };
    return { cls: 'cell--blank', text: '', label: '空欄' };
  }

  function pubRoster(roster) {
    const today = U.todayStr();
    const head = el(
      'thead',
      null,
      el(
        'tr',
        null,
        el('th', { class: 'roster__corner', scope: 'col' }, '日付'),
        roster.staff.map((m) =>
          el(
            'th',
            { class: 'roster__staff', scope: 'col' },
            el('span', { class: 'roster__staff-name' }, m.name),
            el(
              'span',
              { class: 'roster__staff-meta' },
              m.role ? el('span', { class: `role-badge role-badge--${m.role === 'St' ? 'stylist' : 'assistant'}` }, m.role) : null,
              m.title ? el('span', { class: 'roster__staff-title' }, m.title) : null
            )
          )
        ),
        el('th', { class: 'roster__count roster__count--st roster__count-head', scope: 'col', title: 'スタイリスト' }, 'St'),
        el('th', { class: 'roster__count roster__count--as roster__count-head', scope: 'col', title: 'アシスタント' }, 'As'),
        el('th', { class: 'roster__count roster__count--total roster__count-head', scope: 'col', title: '合計' }, '計')
      )
    );
    const rows = roster.days.map((d) => {
      const w = K.calc.weekdayOf(d.date);
      const closedAll = Boolean(d.closed);
      const classes = ['roster__row'];
      if (w === 0 || d.holiday) classes.push('is-sun');
      if (w === 6 && !d.holiday) classes.push('is-sat');
      if (closedAll) classes.push('is-closed');
      if (d.date === today) classes.push('is-today');
      // 出勤の人数（勤務のマスだけ。社用・休みは数えない）
      let st = 0;
      let as = 0;
      for (const m of roster.staff) {
        const c = d.cells[m.id];
        if (!c || c.k !== 'work') continue;
        if (m.role === 'St') st++;
        else if (m.role === 'As') as++;
      }
      const closedTag = closedAll ? Object.values(d.cells).find((c) => c && c.k === 'closed' && c.t) : null;
      return el(
        'tr',
        { class: classes.join(' '), 'data-date': d.date },
        el(
          'th',
          { class: 'roster__date', scope: 'row' },
          el(
            'span',
            { class: 'roster__date-btn roster__date-btn--static' },
            el('span', { class: 'roster__day' }, String(Number(d.date.slice(8)))),
            el('span', { class: 'roster__wd' }, d.holiday ? '祝' : U.WEEKDAYS[w]),
            d.holiday ? el('span', { class: 'roster__closed-tag roster__holiday-tag' }, d.holiday) : null,
            closedAll ? el('span', { class: 'roster__closed-tag' }, closedTag ? closedTag.t : '定休') : null,
            d.hours ? el('span', { class: 'roster__closed-tag roster__special-tag', title: `特別営業時間 ${d.hours}` }, '特別') : null
          )
        ),
        roster.staff.map((m) => {
          const c = pubCell(d.cells[m.id], closedAll);
          return el(
            'td',
            { class: 'roster__cell' },
            el('span', { class: `cell cell--static ${c.cls}`, style: { '--pattern-color': PUB_WORK_COLOR }, role: 'img', 'aria-label': `${shortDate(d.date)} ${m.name}：${c.label}`, title: c.label }, c.text)
          );
        }),
        el('td', { class: 'roster__count roster__count--st' }, String(st)),
        el('td', { class: 'roster__count roster__count--as' }, String(as)),
        el('td', { class: 'roster__count roster__count--total' }, String(st + as))
      );
    });
    return el(
      'div',
      { class: 'roster-wrap manager-roster' },
      el(
        'table',
        { class: 'roster req-pub-table', style: { '--store-color': roster.storeColor || 'var(--border)' } },
        el('caption', { class: 'visually-hidden' }, `${roster.storeName} ${R().monthLabel(roster.month)} の確定シフト`),
        head,
        el('tbody', null, rows)
      )
    );
  }

  function rosterView() {
    const p = view.pub;
    if (!p || p.loading) return el('p', { class: 'hint' }, '読み込んでいます…');
    if (p.error) return el('p', { class: 'form-error' }, p.error);
    const months = rosterMonths();
    const inMonth = p.rosters.filter((r) => r.month === p.month).sort((a, b) => (a.storeName || '').localeCompare(b.storeName || ''));
    const roster = inMonth.find((r) => r.storeId === p.storeId) || inMonth[0] || null;
    const parts = [
      el('p', { class: 'hint hint--left' }, '確定・公開済みのシフトだけを表示します（作成中のシフトは表示されません）。'),
      el(
        'div',
        { class: 'segment segment--compact req-mode', role: 'group', 'aria-label': '表示する月' },
        months.map((m) =>
          el(
            'button',
            {
              type: 'button',
              class: `segment__btn${p.month === m ? ' is-selected' : ''}`,
              'aria-pressed': String(p.month === m),
              onclick: () => {
                p.month = m;
                p.storeId = (p.rosters.find((r) => r.month === m) || {}).storeId || null;
                K.app.rerender();
              },
            },
            R().monthLabel(m)
          )
        )
      ),
    ];
    if (!inMonth.length) {
      parts.push(el('p', { class: 'empty-row' }, `${R().monthLabel(p.month)}に確定したシフトは、まだありません。`));
      return el('div', null, parts);
    }
    parts.push(
      el(
        'div',
        { class: 'req-choices' },
        inMonth.map((r) =>
          el(
            'button',
            {
              type: 'button',
              class: `req-choice${roster && r.storeId === roster.storeId ? ' is-selected' : ''}`,
              style: { '--store-color': r.storeColor },
              'aria-pressed': String(Boolean(roster && r.storeId === roster.storeId)),
              onclick: () => {
                p.storeId = r.storeId;
                K.app.rerender();
              },
            },
            r.storeName
          )
        )
      )
    );
    parts.push(pubRoster(roster));
    return el('div', null, parts);
  }

  // 申請中の件数（選んでいる店舗・表示している月）：判断が必要なもの
  function pendingCount() {
    if (!view.data) return 0;
    const pend = (list) => (list || []).filter((r) => r.storeId === view.storeId && r.status === 'pending').length;
    return pend(view.data.wishRequests) + pend(view.data.paidRequests) + pend(view.data.changeRequests);
  }

  // いちばん上の「あいさつ」：幹部の画面・担当店舗・受付の状況・申請中の件数（スタッフも兼ねる人は「自分の申請へ」）
  function hero() {
    const w = R().requestWindow();
    const stores = view.ctx ? view.ctx.stores : [];
    const n = pendingCount();
    return el(
      'section',
      { class: 'req-hero mgr-hero' },
      el('p', { class: 'req-hero__eyebrow' }, '幹部'),
      el('h2', { class: 'req-hero__name' }, '幹部の画面'),
      stores.length ? el('p', { class: 'req-hero__store' }, `担当：${stores.map((x) => x.name).join('・')}`) : null,
      el(
        'p',
        { class: `req-hero__window${w.open ? ' is-open' : ''}` },
        el('span', { class: 'req-hero__badge' }, w.open ? '受付中' : '受付期間外'),
        el('span', null, w.open ? `${R().monthLabel(w.month)}分・${R().untilText(w)}判断できます` : `判断・変更はオーナーだけ（${R().monthLabel(w.opensFor)}分は${Number(w.opensOn.slice(5, 7))}月${Number(w.opensOn.slice(8, 10))}日から）`)
      ),
      view.data
        ? el('p', { class: `mgr-hero__pending${n ? ' has-pending' : ''}` }, el('span', { class: 'mgr-hero__count' }, String(n)), el('span', null, n ? '件が判断待ち' : '件：判断待ちはありません'), el('span', { class: 'mgr-hero__month' }, `${R().monthLabel(view.month)}分`))
        : null,
      view.account ? el('button', { type: 'button', class: 'btn btn--ghost btn--small req-hero__back', onclick: () => K.app.navigate('request', { email: view.email, account: view.account, manager: view.manager }) }, '自分の休み・社用を入れる') : null
    );
  }

  // いちばん下の「アカウント・この端末の設定」（スタッフの画面と同じ形。ふだんは閉じておく）
  function accountSection() {
    const user = K.app.cloudUser();
    return el(
      'details',
      { class: 'req-account' },
      el('summary', { class: 'req-account__summary' }, el('span', { class: 'req-account__title' }, 'アカウント・この端末の設定'), el('span', { class: 'req-account__hint' }, '簡単ログイン・パスワード・ログアウト')),
      el(
        'div',
        { class: 'req-account__body' },
        el('p', { class: 'hint hint--left req-account__who' }, `${view.email} でログインしています（幹部）。担当店舗の申請を、受付期間（${R().periodLabel()}）に判断できます。`),
        // 簡単ログイン（この端末のロック）の設定
        K.quickLock && user ? K.quickLock.card(user, K.app.rerender) : null,
        K.loginUI && user ? K.loginUI.passwordCard(user) : null,
        el('button', { type: 'button', class: 'btn btn--ghost btn--block', onclick: () => K.app.cloudActions.signOut() }, 'ログアウト')
      )
    );
  }

  function render(container, params) {
    if (!view || view.email !== params.email) reset(params);
    if (view.loading) {
      container.append(hero(), el('p', { class: 'hint' }, '読み込んでいます…'), accountSection());
      return;
    }
    if (!view.ctx || !view.ctx.stores.length || !view.data) {
      container.append(hero(), el('p', { class: 'form-error' }, (view.message && view.message.text) || '担当店舗が見つかりませんでした。オーナーに連絡してください。'), accountSection());
      return;
    }
    const w = R().requestWindow();
    const parts = [hero(), tabs()];
    if (view.tab !== 'roster') {
      // 担当が2店舗以上の人だけ、店舗を選ぶ
      if (view.ctx.stores.length > 1) parts.push(el('div', { class: 'mgr-stores' }, storeChips()));
      // 月の切り替えと、受付の説明を1か所に
      parts.push(
        el(
          'div',
          { class: 'mgr-bar' },
          monthNav(),
          el('p', { class: 'hint mgr-bar__hint' }, w.open ? (view.month === w.month ? `この月の分を判断できます（${R().untilText(w)}）。` : `判断できるのは${R().monthLabel(w.month)}分だけです（この月は見るだけ）。`) : `今は受付期間外です。判断・変更はオーナーだけができます（${R().monthLabel(w.opensFor)}分は${Number(w.opensOn.slice(5, 7))}月${Number(w.opensOn.slice(8, 10))}日から）。`)
        )
      );
    }
    if (view.message && view.message.text) parts.push(el('p', { class: view.message.ok ? 'sync__result' : 'form-error', role: 'status' }, view.message.text));
    parts.push(el('section', { class: 'card req-card mgr-body' }, view.tab === 'wish' ? wishView() : view.tab === 'days' ? daysView() : view.tab === 'paid' ? paidView() : view.tab === 'change' ? changeView() : view.tab === 'log' ? logView() : rosterView()));
    parts.push(accountSection());
    container.append(...parts.filter(Boolean));
  }

  K.screens = K.screens || {};
  K.screens.manager = { render, reset: () => (view = null) };
})();
