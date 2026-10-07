// スタッフの申請画面（希望休・有給希望）。スマホで使う前提
// 流れ：店舗を選択（所属が2店舗の人だけ）→ スタッフ名（本人だけ）→ 翌月のカレンダー
// 読み書きは本人の分だけ（Firestore のルールでも、ほかの人の情報は読めない）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const R = () => K.requests;

  // 画面の状態（ログインした人が変わったら作り直す）
  let view = null;

  function reset(params) {
    view = {
      email: params.email,
      account: params.account,
      loading: true,
      ctx: null, // { stores, staff, settings }
      storeId: null,
      staffId: null,
      data: null, // { wish, paid, quota }
      draft: [], // 送信前の希望休
      mode: 'wish', // wish / paid
      paidDate: null, // 有給希望で選んだ日
      message: null, // { ok, text }
      busy: false,
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
      view.ctx = await backend().loadStaffContext(view.account);
      // 所属が1店舗なら、店舗とスタッフを自動で選ぶ
      if (view.ctx.staff.length === 1) await selectStaff(view.ctx.staff[0], false);
    } catch (err) {
      view.message = { ok: false, text: `読み込めませんでした（${err.message}）` };
    }
    view.loading = false;
    K.app.rerender();
  }

  async function selectStaff(member, rerender = true) {
    view.storeId = member.storeId;
    view.staffId = member.id;
    view.data = null;
    view.paidDate = null;
    view.message = null;
    if (rerender) K.app.rerender();
    try {
      view.data = await backend().loadMyRequests(member.id, R().requestWindow().month);
      view.draft = view.data.wish ? [...view.data.wish.dates] : [];
    } catch (err) {
      view.message = { ok: false, text: `申請を読み込めませんでした（${err.message}）` };
    }
    if (rerender) K.app.rerender();
  }

  async function reloadRequests(text) {
    view.data = await backend().loadMyRequests(view.staffId, R().requestWindow().month);
    view.draft = view.data.wish ? [...view.data.wish.dates] : [];
    show(true, text);
  }

  function current() {
    const member = view.ctx.staff.find((s) => s.id === view.staffId);
    const store = view.ctx.stores.find((s) => s.id === view.storeId) || null;
    return { member, store };
  }

  // ---- 部品 ----

  function storePicker() {
    const stores = view.ctx.stores.filter((s) => view.ctx.staff.some((m) => m.storeId === s.id));
    return el(
      'section',
      { class: 'card req-card' },
      el('h2', { class: 'card__title' }, '店舗を選択'),
      el(
        'div',
        { class: 'req-choices' },
        stores.map((s) =>
          el(
            'button',
            {
              type: 'button',
              class: `req-choice${s.id === view.storeId ? ' is-selected' : ''}`,
              style: { '--store-color': s.color },
              'aria-pressed': String(s.id === view.storeId),
              onclick: () => selectStaff(view.ctx.staff.find((m) => m.storeId === s.id)),
            },
            s.name
          )
        )
      )
    );
  }

  function namePicker(member) {
    return el(
      'section',
      { class: 'card req-card' },
      el('h2', { class: 'card__title' }, 'スタッフ名を選択'),
      el('div', { class: 'req-choices' }, el('button', { type: 'button', class: 'req-choice is-selected', 'aria-pressed': 'true' }, `${member.name}${member.title ? `（${member.title}）` : ''}`)),
      el('p', { class: 'hint hint--left' }, 'ログインした本人の名前だけが表示されます。')
    );
  }

  function weekdayHead() {
    return U.WEEKDAYS.map((w, i) => el('div', { class: `req-cal__head${i === 0 ? ' is-sun' : i === 6 ? ' is-sat' : ''}` }, w));
  }

  function calendar(store, month, editable) {
    const dates = K.calc.monthDates(month);
    const first = K.calc.weekdayOf(dates[0]);
    const paidByDate = new Map((view.data ? view.data.paid : []).map((r) => [r.date, r]));
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(el('div', { class: 'req-cal__blank', 'aria-hidden': 'true' }));
    for (const date of dates) {
      const w = K.calc.weekdayOf(date);
      const closed = store && K.calc.isStoreClosed(store, date);
      const holiday = K.holidays.holidayName(date);
      const wish = view.draft.includes(date);
      const paid = paidByDate.get(date);
      const classes = ['req-day'];
      if (w === 0 || holiday) classes.push('is-sun');
      else if (w === 6) classes.push('is-sat');
      if (closed) classes.push('is-closed');
      if (wish) classes.push('is-wish');
      if (paid) classes.push(`is-paid is-paid--${paid.status}`);
      if (view.paidDate === date) classes.push('is-picked');
      const marks = [wish ? '希望休' : null, paid ? `有給${paid.status === 'pending' ? '（申請中）' : paid.status === 'approved' ? '（承認）' : '（却下）'}` : null, closed ? '定休日' : null].filter(Boolean);
      cells.push(
        el(
          'button',
          {
            type: 'button',
            class: classes.join(' '),
            disabled: !editable || closed,
            'aria-label': `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日（${U.WEEKDAYS[w]}）${marks.length ? `：${marks.join('・')}` : ''}`,
            'aria-pressed': String(view.mode === 'wish' ? wish : view.paidDate === date),
            'data-date': date,
            onclick: () => onDay(date),
          },
          el('span', { class: 'req-day__num' }, String(Number(date.slice(8, 10)))),
          el('span', { class: 'req-day__mark' }, wish ? '希' : paid ? (paid.status === 'approved' ? '有' : paid.status === 'pending' ? '有?' : '×') : closed ? '休' : '')
        )
      );
    }
    return el('div', { class: 'req-cal', role: 'group', 'aria-label': `${R().monthLabel(month)}のカレンダー` }, weekdayHead(), cells);
  }

  function onDay(date) {
    const { store } = current();
    view.message = null;
    if (view.mode === 'wish') {
      if ((view.data ? view.data.paid : []).some((r) => r.date === date && r.status !== 'rejected')) {
        show(false, 'この日は有給希望を出しています。');
        return;
      }
      const limit = R().limitFor(view.ctx.settings, view.data && view.data.quota);
      const result = R().toggleWish(view.draft, date, limit);
      view.draft = result.dates;
      if (result.error) view.message = { ok: false, text: result.error };
    } else {
      const err = R().checkDate(store, R().requestWindow().month, date);
      if (err) view.message = { ok: false, text: err };
      else if (view.draft.includes(date)) view.message = { ok: false, text: 'この日は希望休に選んでいます。有給希望にする場合は、先に希望休から外してください。' };
      else view.paidDate = view.paidDate === date ? null : date;
    }
    K.app.rerender();
  }

  async function sendWish() {
    const { member, store } = current();
    const month = R().requestWindow().month;
    view.busy = true;
    K.app.rerender();
    try {
      await R().saveWishOffs({
        staffId: member.id,
        storeId: member.storeId,
        month,
        dates: view.draft,
        limit: R().limitFor(view.ctx.settings, view.data && view.data.quota),
        store,
        email: view.email,
      });
      view.busy = false;
      await reloadRequests(view.draft.length ? '希望休を送信しました。' : '希望休をなしにして送信しました。');
    } catch (err) {
      view.busy = false;
      show(false, err.message);
    }
  }

  async function sendPaid(noteInput) {
    const { member, store } = current();
    view.busy = true;
    K.app.rerender();
    try {
      await R().requestPaid({
        staffId: member.id,
        storeId: member.storeId,
        month: R().requestWindow().month,
        date: view.paidDate,
        note: noteInput.value,
        store,
        email: view.email,
        existing: view.data ? view.data.paid : [],
      });
      view.busy = false;
      view.paidDate = null;
      await reloadRequests('有給希望を申請しました。管理者が承認すると確定します。');
    } catch (err) {
      view.busy = false;
      show(false, err.message);
    }
  }

  async function withdraw(request) {
    if (!window.confirm(`${shortDate(request.date)}の有給希望を取り下げますか？`)) return;
    try {
      await R().withdrawPaid(request);
      await reloadRequests('有給希望を取り下げました。');
    } catch (err) {
      show(false, err.message);
    }
  }

  function shortDate(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${U.WEEKDAYS[K.calc.weekdayOf(date)]}）`;
  }

  function requestCard(member, store) {
    const w = R().requestWindow();
    const limit = R().limitFor(view.ctx.settings, view.data && view.data.quota);
    const saved = view.data && view.data.wish ? view.data.wish.dates : [];
    const changed = JSON.stringify(saved) !== JSON.stringify(view.draft);
    const editable = w.open && !view.busy && Boolean(view.data);

    const modeSwitch = el(
      'div',
      { class: 'segment segment--compact req-mode', role: 'group', 'aria-label': '申請の種類' },
      [
        ['wish', '希望休'],
        ['paid', '有給希望'],
      ].map(([key, label]) =>
        el(
          'button',
          {
            type: 'button',
            class: `segment__btn${view.mode === key ? ' is-selected' : ''}`,
            'aria-pressed': String(view.mode === key),
            onclick: () => {
              view.mode = key;
              view.paidDate = null;
              view.message = null;
              K.app.rerender();
            },
          },
          label
        )
      )
    );

    const noteInput = el('input', { id: 'paid-note', class: 'field__input', type: 'text', maxlength: '50', placeholder: '理由など（任意）' });
    const paidList = (view.data ? view.data.paid : []).slice().sort((a, b) => a.date.localeCompare(b.date));

    return el(
      'section',
      { class: 'card req-card' },
      el('h2', { class: 'card__title' }, `${R().monthLabel(w.month)}の休み希望`),
      w.open
        ? el('p', { class: 'hint hint--left' }, `受付中です（${Number(w.today.slice(5, 7))}月末まで）。`)
        : el('p', { class: 'form-error' }, `今は受付期間外です。${R().monthLabel(w.month)}分は${Number(w.opensOn.slice(5, 7))}月25日から受け付けます。`),
      modeSwitch,
      el(
        'p',
        { class: 'hint hint--left' },
        view.mode === 'wish'
          ? `休みたい日を押してください。通常の希望休は${limit}日まで選べます（今 ${view.draft.length}／${limit}日）。`
          : '有給を希望する日を押して、「有給希望を申請」を押してください。管理者が承認すると確定します。'
      ),
      calendar(store, w.month, editable),
      el('div', { class: 'req-legend' }, el('span', { class: 'req-legend__wish' }, '希＝希望休'), el('span', null, '有?＝有給（申請中）'), el('span', null, '有＝有給（承認済み）'), el('span', null, '休＝定休日')),
      view.message ? el('p', { class: view.message.ok ? 'sync__result' : 'form-error', role: 'alert' }, view.message.text) : null,
      view.mode === 'wish'
        ? el(
            'div',
            { class: 'actions' },
            el('button', { type: 'button', class: 'btn btn--primary', disabled: !editable || !changed, onclick: sendWish }, changed ? '希望休を送信' : '送信済み'),
            changed && saved.length + view.draft.length ? el('span', { class: 'hint hint--inline' }, 'まだ送信していません') : null
          )
        : view.paidDate
          ? el(
              'div',
              { class: 'req-paid-form' },
              el('p', { class: 'req-paid-form__date' }, `${shortDate(view.paidDate)} を有給希望で申請`),
              noteInput,
              el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--primary', disabled: !editable, onclick: () => sendPaid(noteInput) }, '有給希望を申請'))
            )
          : null,
      el('h3', { class: 'card__title card__title--section' }, '有給希望の状況'),
      paidList.length
        ? el(
            'ul',
            { class: 'detail-list' },
            paidList.map((r) =>
              el(
                'li',
                { class: 'detail-item' },
                el('span', { class: 'detail-item__text' }, shortDate(r.date), r.originalDate ? el('span', { class: 'detail-item__note' }, `（${shortDate(r.originalDate)}から変更）`) : null),
                el('span', { class: `req-status req-status--${r.status}` }, R().STATUS_LABELS[r.status] || r.status),
                r.status === 'pending' && w.open ? el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => withdraw(r) }, '取り下げ') : null
              )
            )
          )
        : el('p', { class: 'empty-row' }, 'まだ申請していません。')
    );
  }

  function render(container, params) {
    if (!view || view.email !== params.email) reset(params);

    const head = el(
      'section',
      { class: 'card req-card' },
      el('h2', { class: 'card__title' }, '希望休・有給の申請'),
      el('p', { class: 'hint hint--left' }, `${view.email} でログインしています。`),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => K.app.cloudActions.signOut() }, 'ログアウト'))
    );

    if (view.loading) {
      container.append(head, el('p', { class: 'hint' }, '読み込んでいます…'));
      return;
    }
    if (!view.ctx || !view.ctx.staff.length) {
      container.append(head, el('p', { class: 'form-error' }, (view.message && view.message.text) || 'スタッフの情報が見つかりませんでした。管理者に連絡してください。'));
      return;
    }

    const parts = [head, storePicker()];
    if (view.staffId) {
      const { member, store } = current();
      parts.push(namePicker(member));
      if (view.data) parts.push(requestCard(member, store));
      else parts.push(view.message ? el('p', { class: 'form-error' }, view.message.text) : el('p', { class: 'hint' }, '読み込んでいます…'));
    } else {
      parts.push(el('p', { class: 'hint' }, '店舗を選ぶと、申請の画面が開きます。'));
    }
    container.append(...parts);
  }

  K.screens = K.screens || {};
  K.screens.request = { render, reset: () => (view = null) };
})();
