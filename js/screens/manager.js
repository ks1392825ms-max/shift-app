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
      tab: 'paid', // paid / calendar / self / roster（11/8〜 幹部が承認するのは有給だけ。希望休は申請したらそのまま確定）
      self: { mode: 'off', draft: [], bizDate: null, bizKind: 'day', start: '13:00', end: '15:00', what: '', detail: '' },
      data: null, // { wishRequests, wishCounts, paidRequests, quotas, logs }
      message: null,
      pub: null, // { loading, rosters, month, storeId, error }
      att: null, // 11/12〜 集計表用の名簿 { loading, list, error }
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
          class: `btn ${status === 'approved' ? 'btn--primary' : status === 'rejected' ? 'btn--ghost' : 'text-btn'} mgr-decide mgr-decide--${status}`,
          onclick: async () => {
            let reason = '';
            if (status === 'rejected') {
              reason = window.prompt('非承認の理由を入れてください（50文字以内・スタッフにも表示されます）', '');
              if (reason === null) return;
            }
            try {
              await R().decide(kind, r, { status, reason, email: view.email, role: 'manager' });
              const done = { approved: '承認しました。', rejected: '非承認にしました。', pending: '申請中に戻しました。' }[status];
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
      r.status !== 'rejected' ? act('rejected', '非承認') : null,
      r.status !== 'pending' ? act('pending', '判断を戻す') : null,
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
    const pend = (list) => (list || []).filter((r) => r.status === 'pending').length;
    const list = [
      ['paid', '有給', pend(view.data.paidRequests) + pend(view.data.changeRequests)],
      ['calendar', 'カレンダー', 0],
      ['attendance', '勤怠', 0],
      view.account ? ['self', '自分の休み・社用', 0] : null,
      ['roster', '確定シフト', 0],
    ].filter(Boolean);
    return el(
      'div',
      { class: 'segment segment--compact req-tabs mgr-tabs', role: 'tablist', 'aria-label': '幹部の画面の切り替え' },
      list.map(([key, label, n]) =>
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

  // 「？ 使い方」：押したときだけ、短い説明を出す
  function help(text) {
    return el('details', { class: 'mgr-help' }, el('summary', null, el('span', { class: 'mgr-help__q', 'aria-hidden': 'true' }, '？'), '使い方'), el('p', null, text));
  }

  // 有給のカード：名前・日付・状態・ボタン
  function paidCard(kind, r) {
    return el(
      'li',
      { class: `mgr-card mgr-card--${r.status}`, 'data-id': r.id },
      el(
        'div',
        { class: 'mgr-card__main' },
        el('span', { class: 'mgr-card__name' }, staffName(r.staffId)),
        el('span', { class: 'mgr-card__date' }, kind === 'change' ? R().changeText(r) : shortDate(r.date)),
        el('span', { class: `mgr-chip mgr-chip--${r.status}` }, r.status === 'rejected' ? '非承認' : R().statusText(r))
      ),
      r.note ? el('p', { class: 'mgr-card__note' }, `${kind === 'change' ? '理由' : '備考'}：${r.note}`) : null,
      r.status === 'rejected' && r.reason ? el('p', { class: 'mgr-card__note' }, `非承認の理由：${r.reason}`) : null,
      kind === 'change' && r.status === 'approved' ? el('p', { class: 'mgr-card__note' }, r.reflectedAt ? 'オーナーがシフト表に反映しました。' : 'オーナーの反映待ち') : null,
      el('div', { class: 'mgr-card__actions' }, ...decideButtons(kind, r))
    );
  }

  function paidView() {
    const mine = (list) => (list || []).filter((r) => r.storeId === view.storeId).sort((a, b) => a.date.localeCompare(b.date));
    const paid = mine(view.data.paidRequests);
    const changes = mine(view.data.changeRequests);
    const waiting = paid.filter((r) => r.status === 'pending');
    const done = paid.filter((r) => r.status !== 'pending');
    const waitingChanges = changes.filter((c) => c.status === 'pending');
    return el(
      'div',
      { class: 'mgr-paid' },
      el('h3', { class: 'mgr-sec' }, `判断待ち`, el('span', { class: 'mgr-sec__n' }, `${waiting.length}件`)),
      waiting.length ? el('ul', { class: 'mgr-cards' }, waiting.map((r) => paidCard('paid', r))) : el('p', { class: 'mgr-empty' }, '✓ 判断待ちの有給はありません'),
      changes.length
        ? el('div', null, el('h3', { class: 'mgr-sec' }, '変更申請', el('span', { class: 'mgr-sec__n' }, `${waitingChanges.length}件 判断待ち`)), el('ul', { class: 'mgr-cards' }, changes.map((c) => paidCard('change', c))))
        : null,
      done.length ? el('div', null, el('h3', { class: 'mgr-sec mgr-sec--sub' }, '判断済み', el('span', { class: 'mgr-sec__n' }, `${done.length}件`)), el('ul', { class: 'mgr-cards' }, done.map((r) => paidCard('paid', r)))) : null,
      el('details', { class: 'mgr-log' }, el('summary', null, '判断の履歴を見る'), logView()),
      help('スタッフの有給を「承認」か「非承認」にします（非承認は理由が必要で、スタッフにも表示されます）。判断できるのは受付期間の間・翌月分だけです。期間の外の変更はオーナーだけです。希望休は、スタッフが申請したらそのまま確定するので、判断はいりません。')
    );
  }

  // カレンダー：その月の休み・有給・社用（見るだけ）
  function calendarView() {
    const mine = (list) => (list || []).filter((r) => r.storeId === view.storeId && r.month === view.month);
    return el(
      'div',
      null,
      K.dayList.calendar({
        month: view.month,
        store: view.ctx.stores.find((s) => s.id === view.storeId),
        staff: view.ctx.staff.filter((m) => m.storeId === view.storeId),
        nameOf: staffName,
        wishes: mine(view.data.wishRequests),
        paid: mine(view.data.paidRequests),
        bdays: mine(view.data.businessDays),
      }),
      help('その月に、だれが休み・有給・社用かをカレンダーで見られます（見るだけ）。日を押すと、その日の内容が下に出ます。')
    );
  }

  // ---- 自分の休み・社用（幹部がスタッフとしても登録されているとき） ----
  function selfMember() {
    if (!view.account || !view.account.staffIds.length) return null;
    return view.ctx.staff.find((m) => view.account.staffIds.includes(m.id)) || null;
  }

  function selfView() {
    const me = selfMember();
    const w = R().requestWindow();
    if (!me) return el('p', { class: 'mgr-empty' }, 'スタッフとしての登録が見つかりません。オーナーに確認してください。');
    const month = w.month;
    if (view.month !== month) {
      return el('div', { class: 'mgr-self' }, el('p', { class: 'mgr-empty' }, `自分の休み・社用は、受付中の月（${R().monthLabel(month)}）に入れます。`), el('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: async () => { view.month = month; await reload(''); view.message = null; K.app.rerender(); } }, `${R().monthLabel(month)}に切り替える`));
    }
    const store = view.ctx.stores.find((s) => s.id === me.storeId) || view.ctx.stores[0];
    const st = view.self;
    const wishes = (view.data.wishRequests || []).filter((x) => x.staffId === me.id && x.month === month);
    const bdays = (view.data.businessDays || []).filter((x) => x.staffId === me.id && x.month === month);
    const paid = (view.data.paidRequests || []).filter((x) => x.staffId === me.id && x.month === month && x.status !== 'rejected');
    const quota = (view.data.quotas || []).find((q) => q.staffId === me.id && q.month === month);
    const limit = R().limitFor(view.ctx.settings, quota);
    const used = wishes.length;
    const left = Math.max(0, limit - used - st.draft.length);
    const editable = w.open;
    const say = (ok, text) => { view.message = { ok, text }; K.app.rerender(); };
    const onDay = (date) => {
      if (!editable) return say(false, `今は受付期間外です。${R().closedText(w)}`);
      const err = R().checkDate(store, month, date);
      if (err) return say(false, err);
      if (wishes.some((x) => x.date === date)) return say(false, 'この日は休みを登録済みです（取り消すときは、下の一覧の「取り消す」）。');
      if (bdays.some((x) => x.date === date)) return say(false, 'この日は社用を登録済みです（取り消すときは、下の一覧の「取り消す」）。');
      if (paid.some((x) => x.date === date)) return say(false, 'この日は有給を申請しています。');
      view.message = null;
      if (st.mode === 'off') {
        if (st.draft.includes(date)) st.draft = st.draft.filter((d) => d !== date);
        else if (left <= 0) return say(false, R().limitMessage(limit));
        else st.draft = [...st.draft, date].sort();
      } else {
        st.bizDate = st.bizDate === date ? null : date;
      }
      K.app.rerender();
    };
    // 自分のカレンダー
    const dates = K.calc.monthDates(month);
    const lead = K.calc.weekdayOf(dates[0]);
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(el('div', { class: 'cal__cell is-empty', 'aria-hidden': 'true' }));
    for (const date of dates) {
      const wd = K.calc.weekdayOf(date);
      const closed = K.calc.isStoreClosed(store, date);
      const b = bdays.find((x) => x.date === date);
      const mark = wishes.some((x) => x.date === date)
        ? ['off', '休み']
        : b
          ? ['biz', b.start ? `社 ${Number(b.start.slice(0, 2))}-${Number(b.end.slice(0, 2))}` : '社用']
          : paid.some((x) => x.date === date)
            ? ['paid', '有給']
            : st.draft.includes(date)
              ? ['draft', '選択']
              : st.bizDate === date
                ? ['draft', '社用?']
                : null;
      cells.push(
        el(
          'button',
          { type: 'button', class: `cal__cell self-cell${wd === 6 ? ' is-sat' : ''}${wd === 0 || K.holidays.holidayName(date) ? ' is-sun' : ''}${closed ? ' is-closed' : ''}${mark ? ` has-${mark[0]}` : ''}${editable ? '' : ' is-locked'}`, 'data-date': date, onclick: () => onDay(date) },
          el('span', { class: 'cal__day' }, String(Number(date.slice(8, 10)))),
          closed ? el('span', { class: 'cal__closed' }, '定休') : mark ? el('span', { class: `self-mark self-mark--${mark[0]}` }, mark[1]) : null
        )
      );
    }
    const run = async (fn, done) => {
      try {
        await fn();
        st.draft = [];
        st.bizDate = null;
        await reload(done);
      } catch (err) {
        say(false, err.message);
      }
    };
    // 社用の入力（日を選んだとき）
    let bizForm = null;
    if (st.mode === 'biz' && st.bizDate) {
      const whatSel = el('select', { class: 'field__input', id: 'self-what', onchange: (e) => (st.what = e.currentTarget.value) }, el('option', { value: '' }, '内容を選ぶ'), K.records.BUSINESS_WHATS.map((x) => el('option', { value: x, selected: st.what === x }, x)));
      const detail = el('input', { class: 'field__input', id: 'self-detail', maxlength: '30', placeholder: '詳細（なくてもよい）', value: st.detail, oninput: (e) => (st.detail = e.currentTarget.value) });
      const kind = el(
        'div',
        { class: 'segment segment--compact self-kind', role: 'group', 'aria-label': '社用の長さ' },
        [['day', '1日まるごと'], ['time', '時間で入れる']].map(([k, t]) => el('button', { type: 'button', class: `segment__btn${st.bizKind === k ? ' is-selected' : ''}`, 'aria-pressed': String(st.bizKind === k), onclick: () => { st.bizKind = k; K.app.rerender(); } }, t))
      );
      bizForm = el(
        'div',
        { class: 'self-form' },
        el('p', { class: 'self-form__head' }, `${shortDate(st.bizDate)}の社用`),
        kind,
        st.bizKind === 'time'
          ? el('div', { class: 'self-times' }, K.wheel.button({ value: st.start, from: '06:00', to: '23:30', step: 30, label: '開始', onchange: (v) => (st.start = v) }), el('span', null, '〜'), K.wheel.button({ value: st.end, from: '06:30', to: '23:30', step: 30, label: '終了', onchange: (v) => (st.end = v) }))
          : null,
        whatSel,
        detail,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--primary btn--block',
            onclick: () => {
              if (!st.what) return say(false, '社用の内容を選んでください。');
              const timed = st.bizKind === 'time';
              return run(() => R().registerBusinessDay({ staffId: me.id, storeId: me.storeId, date: st.bizDate, what: st.what, detail: st.detail, store, email: view.email, existing: bdays, wishes, paid, start: timed ? st.start : undefined, end: timed ? st.end : undefined }), `${shortDate(st.bizDate)}に社用を登録しました（確定）。`);
            },
          },
          '社用を登録（その場で確定）'
        )
      );
    }
    // 登録済みの一覧（取り消せる）
    const items = [
      ...wishes.map((x) => ({ date: x.date, text: '休み', fn: () => R().removeSelfWish(x, { email: view.email }), can: R().isSelfWish(x, view.email) })),
      ...bdays.map((x) => ({ date: x.date, text: `社用${x.start ? `（${U.formatTime(x.start)}〜${U.formatTime(x.end)}）` : '（1日）'} ${x.what}${x.detail ? ` ${x.detail}` : ''}`, fn: () => R().removeBusinessDay(x), can: true })),
      ...paid.map((x) => ({ date: x.date, text: `有給（${R().statusText(x)}・オーナーが承認）`, fn: null, can: false })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    return el(
      'div',
      { class: 'mgr-self' },
      el('div', { class: 'segment self-mode', role: 'group', 'aria-label': '入れるもの' }, [['off', '休み'], ['biz', '社用']].map(([k, t]) => el('button', { type: 'button', class: `segment__btn${st.mode === k ? ' is-selected' : ''}`, 'aria-pressed': String(st.mode === k), onclick: () => { st.mode = k; st.draft = []; st.bizDate = null; view.message = null; K.app.rerender(); } }, t))),
      el('p', { class: 'self-guide' }, editable ? (st.mode === 'off' ? `休みにする日を押す（あと${left}日）` : '社用の日を押す') : `受付期間外です（${R().closedText(w)}）`),
      el('div', { class: `cal self-cal${editable ? '' : ' is-locked'}` }, ['日', '月', '火', '水', '木', '金', '土'].map((d, i) => el('div', { class: `cal__wd${i === 0 ? ' is-sun' : i === 6 ? ' is-sat' : ''}`, 'aria-hidden': 'true' }, d)), cells),
      st.mode === 'off' && editable
        ? el('button', { type: 'button', class: 'btn btn--primary btn--block self-send', disabled: !st.draft.length, onclick: () => run(() => R().saveSelfWishes({ staffId: me.id, storeId: me.storeId, month, draft: st.draft, saved: wishes, limit, store, email: view.email }), `休みを${st.draft.length}日登録しました（確定）。`) }, st.draft.length ? `休みを登録（${st.draft.length}日・その場で確定）` : '日を選んでください')
        : null,
      bizForm,
      el('h3', { class: 'mgr-sec' }, `${R().monthLabel(month)}の自分の予定`),
      items.length
        ? el('ul', { class: 'mgr-cards' }, items.map((x) => el('li', { class: 'mgr-card' }, el('div', { class: 'mgr-card__main' }, el('span', { class: 'mgr-card__date' }, shortDate(x.date)), el('span', { class: 'mgr-card__name' }, x.text)), x.can && editable ? el('div', { class: 'mgr-card__actions' }, el('button', { type: 'button', class: 'text-btn', onclick: () => run(x.fn, `${shortDate(x.date)}を取り消しました。`) }, '取り消す')) : null)))
        : el('p', { class: 'mgr-empty' }, 'まだ登録していません'),
      help('「休み」は日を押して「休みを登録」。「社用」は日を押して、1日まるごとか時間（開始・終了を押すと、くるくる回して選べます）を選び、内容を選んで「社用を登録」。どちらも、入れるとその場で確定します。受付期間の間は「取り消す」で取り消せます。有給はオーナーが承認します。')
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

  // 勤怠の締めのお知らせ（毎月最終日の20時から7日間）
  function attendanceNotice() {
    const n = K.attendance && K.attendance.closedNotice();
    if (!n) return null;
    return el('button', { type: 'button', class: 'mgr-todo__notice', onclick: () => { view.tab = 'attendance'; view.message = null; K.app.rerender(); } }, `🔔 ${Number(n.month.slice(5))}月の勤怠を締めました。集計表ができました`, el('span', { class: 'mgr-todo__arrow', 'aria-hidden': 'true' }, '›'));
  }

  // いちばん上の「あいさつ」：幹部の画面・担当店舗・受付の状況・申請中の件数（スタッフも兼ねる人は「自分の申請へ」）
  function hero() {
    const w = R().requestWindow();
    const stores = view.ctx ? view.ctx.stores : [];
    const pend = view.data ? (view.data.paidRequests || []).filter((r) => r.status === 'pending').length + (view.data.changeRequests || []).filter((r) => r.status === 'pending').length : 0;
    let main;
    if (!view.data) main = el('p', { class: 'mgr-todo__done' }, '読み込んでいます…');
    else if (!w.open) main = el('div', { class: 'mgr-todo__closed' }, el('span', { class: 'mgr-todo__badge' }, '受付期間外'), el('span', { class: 'mgr-todo__big' }, `次の受付：${Number(w.opensOn.slice(5, 7))}月${Number(w.opensOn.slice(8, 10))}日から`), el('span', { class: 'mgr-todo__small' }, `${R().monthLabel(w.opensFor)}分`));
    else if (pend) main = el('button', { type: 'button', class: 'mgr-todo__go', onclick: () => { view.tab = 'paid'; view.message = null; K.app.rerender(); } }, el('span', { class: 'mgr-todo__n' }, String(pend)), el('span', null, '件　判断待ち'), el('span', { class: 'mgr-todo__arrow', 'aria-hidden': 'true' }, '›'));
    else main = el('p', { class: 'mgr-todo__done' }, '✓ 今やることはありません');
    return el(
      'section',
      { class: 'mgr-todo' },
      el('p', { class: 'mgr-todo__who' }, `幹部${stores.length ? `｜担当：${stores.map((x) => x.name).join('・')}` : ''}`),
      main,
      w.open && view.data ? el('p', { class: 'mgr-todo__small' }, `受付中：${R().monthLabel(w.month)}分・${R().untilText(w)}`) : null,
      attendanceNotice()
    );
  }

  // ---- 勤怠（11/9〜）：今日・月の表・集計表（共通の画面 js/screens/attendance.js） ----
  // 11/12〜 3店舗とも見る・出力できる（集計表用の名簿 attendanceDirectory から）。直せるのは担当店舗だけ
  // 予定は、確定シフトの写しと、承認済みの有給。担当店舗は写しと申請から、ほかの店舗は名簿（確定した月の予定・有給の日）から
  // （幹部が読める確定シフトの写しは担当店舗だけ、の決まりは変えない）
  async function managerPlan(storeId, month) {
    const mine = view.ctx.stores.some((s) => s.id === storeId);
    const dir = attDir(storeId);
    const [rosters, req] = mine
      ? await Promise.all([backend().loadManagerPublishedRosters([storeId], [month]), backend().loadManagerRequests([storeId], month)])
      : [((dir && dir.rosters) || []).filter((r) => r.month === month).map((r) => ({ ...r, storeId })), null];
    const roster = rosters.find((r) => r.storeId === storeId && r.month === month);
    const days = new Map(((roster && roster.days) || []).map((d) => [d.date, d]));
    const paid = mine
      ? new Set(((req && req.paidRequests) || []).filter((p) => p.status === 'approved').map((p) => `${p.staffId}|${p.date}`))
      : new Set((dir && dir.paid) || []);
    return (staffId, date) => {
      const day = days.get(date);
      const plan = day ? K.attendance.planFromCell((day.cells || {})[staffId]) : null;
      if (plan && plan.kind === 'off' && paid.has(`${staffId}|${date}`)) return { kind: 'paid', t: '有給' };
      return plan;
    };
  }

  // 集計表用の名簿（管理者が作る）。読めないとき（ルールの公開前など）は、担当店舗だけ
  function attDir(storeId) {
    return ((view.att && view.att.list) || []).find((d) => d.storeId === storeId) || null;
  }
  function loadAttDir() {
    if (view.att) return;
    view.att = { loading: true, list: [] };
    const v = view;
    backend()
      .loadAttendanceDirectory()
      .then((list) => {
        if (view !== v) return;
        view.att = { loading: false, list: list || [] };
        K.app.rerender();
      })
      .catch((err) => {
        if (view !== v) return;
        view.att = { loading: false, list: [], error: err && err.message };
        K.app.rerender();
      });
  }

  function attendanceView() {
    if (backend().loadAttendanceDirectory) loadAttDir();
    const mine = new Set(view.ctx.stores.map((s) => s.id));
    const others = ((view.att && view.att.list) || [])
      .filter((d) => d.storeId && !mine.has(d.storeId))
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((d) => ({ id: d.storeId, name: d.storeName || '店舗' }));
    const info = K.attendanceView.staffInfo;
    return K.attendanceView.panel({
      key: 'manager',
      role: 'manager',
      email: String(view.email || '').toLowerCase(),
      stores: [...view.ctx.stores, ...others],
      // 担当店舗は、スタッフの記録（最新）から。ほかの店舗は名簿から
      staffOf: (storeId) => (mine.has(storeId) ? view.ctx.staff.filter((m) => m.storeId === storeId).map(info) : ((attDir(storeId) || {}).staff || []).map(info)),
      patternsOf: (storeId) => (attDir(storeId) || {}).patterns || [],
      canEditStore: (storeId) => mine.has(storeId),
      planSource: managerPlan,
    });
  }

  // いちばん下の「アカウント・この端末の設定」（スタッフの画面と同じ形。ふだんは閉じておく）
  function accountSection() {
    const user = K.app.cloudUser();
    return el(
      'details',
      { class: 'req-account' },
      el('summary', { class: 'req-account__summary' }, el('span', { class: 'req-account__title' }, 'アカウント・この端末の設定'), el('span', { class: 'req-account__hint' }, '勤怠の番号・簡単ログイン・パスワード・ログアウト')),
      el(
        'div',
        { class: 'req-account__body' },
        el('p', { class: 'hint hint--left req-account__who' }, `幹部としてログインしています。担当店舗の申請を、受付期間（${R().periodLabel()}）に判断できます。`),
        // 簡単ログイン（この端末のロック）の設定
        K.quickLock && user ? K.quickLock.card(user, K.app.rerender) : null,
        K.loginUI && user ? K.loginUI.passwordCard(user) : null,
        // 勤怠の番号（PIN）（11/9〜。スタッフとしても登録されている幹部だけ）
        K.attendanceView && view.account ? K.attendanceView.pinCard(view.account.staffIds, view.email) : null,
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
    if (view.tab === 'self' && !view.account) view.tab = 'paid';
    const parts = [hero(), tabs()];
    if (view.tab === 'paid' || view.tab === 'calendar') {
      // 担当が2店舗以上の人だけ、店舗を選ぶ。月の切り替え
      if (view.ctx.stores.length > 1) parts.push(el('div', { class: 'mgr-stores' }, storeChips()));
      parts.push(el('div', { class: 'mgr-bar mgr-bar--slim' }, monthNav()));
    }
    if (view.message && view.message.text) parts.push(el('p', { class: view.message.ok ? 'sync__result' : 'form-error', role: 'status' }, view.message.text));
    const body = view.tab === 'paid' ? paidView() : view.tab === 'calendar' ? calendarView() : view.tab === 'self' ? selfView() : view.tab === 'attendance' ? attendanceView() : rosterView();
    parts.push(el('section', { class: 'card req-card mgr-body' }, body));
    parts.push(accountSection());
    container.append(...parts.filter(Boolean));
  }

  K.screens = K.screens || {};
  K.screens.manager = { render, reset: () => (view = null) };
})();
