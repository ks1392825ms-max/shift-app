// スタッフの申請画面（希望休・有給希望）。スマホで使う前提
// 流れ：あいさつ（名前・店舗・受付の状況）→ 店舗を選択（所属が2店舗の人だけ）→ 翌月のカレンダー → 申請の状況 → アカウント・この端末の設定（閉じておく）
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
      data: null, // { wishes（1日ごと）, count, paid, quota }
      draft: [], // 選んでいる希望休（送信済みの申請中・承認済みと、まだ送っていない日。却下の日は入れない）
      mode: 'wish', // wish / paid / business（社用で不在：幹部が自分の分を入れるときだけ）
      paidDate: null, // 有給希望で選んだ日
      bizDate: null, // 社用で不在で選んだ日
      selfMode: false, // 幹部が自分の休み・社用を入れる画面（休み・社用で不在は、その場で確定）
      message: null, // { ok, text }
      busy: false,
      tab: 'requests', // requests（休み希望）/ roster（確定シフト）
      pub: null, // 確定シフト：{ staffId, loading, rosters, myPaid, month, error }
      onlyMine: false,
      changeFor: null, // 変更申請の入力中：{ kind: 'wish' / 'paid', targetId }
      scrollToChange: false, // 変更申請の入力欄を開いた直後（画面を動かす）
      thisData: null, // 今月の申請（変更申請のため。受付中の月と同じなら data と同じ）
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
      R().usePeriodSettings(view.ctx.settings); // オーナーが選んだ受付期間
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
    view.pub = null;
    if (view.tab === 'roster') loadPublished();
    view.paidDate = null;
    view.message = null;
    if (rerender) K.app.rerender();
    try {
      view.data = await backend().loadMyRequests(member.id, R().requestWindow().month);
      view.thisData = await loadThisMonth(member.id);
      view.draft = activeDates();
    } catch (err) {
      view.message = { ok: false, text: `申請を読み込めませんでした（${err.message}）` };
    }
    if (rerender) K.app.rerender();
  }

  async function reloadRequests(text) {
    view.data = await backend().loadMyRequests(view.staffId, R().requestWindow().month);
    view.thisData = await loadThisMonth(view.staffId);
    view.draft = activeDates();
    show(true, text);
  }

  // 今月の申請（受付中の月と違うときだけ読む）
  async function loadThisMonth(staffId) {
    const thisMonth = R().todayJst().slice(0, 7);
    return thisMonth === R().requestWindow().month ? null : backend().loadMyRequests(staffId, thisMonth);
  }

  // 変更申請の対象になりうる記録（今月と、受付中の月）
  function allData() {
    return [view.data, view.thisData].filter(Boolean);
  }

  // 送信済みの希望休（1日ごと）
  function savedWishes() {
    return view.data ? view.data.wishes || [] : [];
  }

  // 送信済みのうち、申請中・承認済みの日（却下の日は除く）
  function activeDates() {
    return savedWishes().filter((w) => w.status === 'pending' || w.status === 'approved').map((w) => w.date).sort();
  }

  function wishOn(date) {
    return savedWishes().find((w) => w.date === date) || null;
  }

  // 選べる残りの日数：上限から、却下のまま残っている日を引く（却下の日は、消すと空く）
  function wishLimit() {
    return R().limitFor(view.ctx.settings, view.data && view.data.quota);
  }

  // 上限に数える、選べない日（却下・取り消し済み）
  function rejectedCount() {
    return savedWishes().filter((w) => w.status === 'rejected' || w.status === 'cancelled').length;
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

  function weekdayHead() {
    return U.WEEKDAYS.map((w, i) => el('div', { class: `req-cal__head${i === 0 ? ' is-sun' : i === 6 ? ' is-sat' : ''}` }, w));
  }

  function calendar(store, month, editable) {
    const dates = K.calc.monthDates(month);
    const first = K.calc.weekdayOf(dates[0]);
    const paidByDate = new Map((view.data ? view.data.paid : []).map((r) => [r.date, r]));
    const bizByDate = new Map(myBusinessDays().map((r) => [r.date, r]));
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(el('div', { class: 'req-cal__blank', 'aria-hidden': 'true' }));
    for (const date of dates) {
      const w = K.calc.weekdayOf(date);
      const closed = store && K.calc.isStoreClosed(store, date);
      const holiday = K.holidays.holidayName(date);
      const wish = view.draft.includes(date);
      const saved = wishOn(date);
      const wishState = wish ? (saved ? saved.status : 'draft') : saved && saved.status === 'rejected' ? 'rejected' : null;
      const paid = paidByDate.get(date);
      const biz = bizByDate.get(date);
      const classes = ['req-day'];
      if (w === 0 || holiday) classes.push('is-sun');
      else if (w === 6) classes.push('is-sat');
      if (closed) classes.push('is-closed');
      if (wish) classes.push('is-wish');
      if (wishState === 'pending' || wishState === 'draft') classes.push('is-wish-pending');
      if (wishState === 'rejected') classes.push('is-wish-rejected');
      if (paid) classes.push(`is-paid is-paid--${paid.status}`);
      if (biz) classes.push('is-bday');
      if (view.paidDate === date || (view.mode === 'business' && view.bizDate === date)) classes.push('is-picked');
      // 押せない日（受付期間外・定休日・臨時休業・送信中）は薄くし、押したら理由を出す（disabled にすると押しても何も起きないため）
      const locked = !editable || closed;
      if (locked) classes.push('is-locked');
      const wishLabel = { draft: '希望休（まだ送信していない）', pending: '希望休（申請中）', approved: '希望休（承認）', rejected: '希望休（却下）' }[wishState];
      const marks = [wishLabel || null, paid ? `有給${paid.status === 'pending' ? '（申請中）' : paid.status === 'approved' ? '（承認）' : '（却下）'}` : null, biz ? `社用で不在（${biz.what}）` : null, closed ? '定休日' : null].filter(Boolean);
      cells.push(
        el(
          'button',
          {
            type: 'button',
            class: classes.join(' '),
            'aria-disabled': locked ? 'true' : null,
            'aria-label': `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日（${U.WEEKDAYS[w]}）${marks.length ? `：${marks.join('・')}` : ''}`,
            'aria-pressed': String(view.mode === 'wish' ? wish : view.mode === 'business' ? view.bizDate === date : view.paidDate === date),
            'data-date': date,
            onclick: () => (locked ? onLockedDay(date, closed) : onDay(date)),
          },
          el('span', { class: 'req-day__num' }, String(Number(date.slice(8, 10)))),
          el('span', { class: 'req-day__mark' }, wishState === 'approved' ? '希' : wishState === 'pending' || wishState === 'draft' ? '希?' : wishState === 'rejected' ? '×' : paid ? (paid.status === 'approved' ? '有' : paid.status === 'pending' ? '有?' : '×') : biz ? '社' : closed ? '休' : '')
        )
      );
    }
    return el('div', { class: 'req-cal', role: 'group', 'aria-label': `${R().monthLabel(month)}のカレンダー` }, weekdayHead(), cells);
  }

  // 押せない日を押したとき：理由をカレンダーのすぐ下に出す（申請の内容は変えない）
  function onLockedDay(date, closed) {
    const { store } = current();
    const w = R().requestWindow();
    let text;
    if (!w.open) text = `今は受付期間外です。${R().closedText(w)}`;
    else if (closed) text = `${shortDate(date)}：${R().checkDate(store, w.month, date) || '定休日は選べません。'}`;
    else text = view.busy ? '送信中です。終わるまでお待ちください。' : '読み込み中です。少し待ってから、もう一度押してください。';
    view.message = { ok: false, text };
    K.app.rerender();
  }

  function onDay(date) {
    const { store } = current();
    view.message = null;
    const biz = myBusinessDays().find((r) => r.date === date);
    if (view.mode === 'business') {
      const err = R().checkDate(store, R().requestWindow().month, date);
      if (err) view.message = { ok: false, text: err };
      else if (biz) view.message = { ok: false, text: `${shortDate(date)}は、社用で不在を登録済みです（取り消すときは、下の「申請の状況」の「取り消す」）。` };
      else if (view.draft.includes(date) || wishOn(date)) view.message = { ok: false, text: 'この日は休み（希望休）にしています。' };
      else if ((view.data ? view.data.paid : []).some((r) => r.date === date && r.status !== 'rejected')) view.message = { ok: false, text: 'この日は有給希望を出しています。' };
      else view.bizDate = view.bizDate === date ? null : date;
      K.app.rerender();
      return;
    }
    if (biz) {
      show(false, `${shortDate(date)}は、社用で不在を登録しています。`);
      return;
    }
    if (view.mode === 'wish') {
      if ((view.data ? view.data.paid : []).some((r) => r.date === date && r.status !== 'rejected')) {
        show(false, 'この日は有給希望を出しています。');
        return;
      }
      const saved = wishOn(date);
      if (saved && saved.status === 'approved' && R().isSelfWish(saved, view.email)) {
        show(false, `${shortDate(date)}は、自分で登録した休みです。取り消すときは、下の「申請の状況」の「取り消す」を押してください。`);
        return;
      }
      if (saved && saved.status === 'approved') {
        show(false, `${shortDate(date)}の希望休は承認済みのため、ここでは外せません。変更が必要なときは、下の「希望休の状況」の「変更申請」から申請してください。`);
        return;
      }
      if (saved && saved.status === 'cancelled') {
        show(false, `${shortDate(date)}の希望休は、変更申請で取り消し済みです。`);
        return;
      }
      if (saved && saved.status === 'rejected') {
        show(false, `${shortDate(date)}の希望休は却下されています（理由：${saved.reason || '—'}）。下の「希望休の状況」で消すと、上限の範囲で別の日を申請できます。`);
        return;
      }
      const limit = wishLimit();
      const result = R().toggleWish(view.draft, date, Math.max(0, limit - rejectedCount()));
      view.draft = result.dates;
      if (result.error) view.message = { ok: false, text: rejectedCount() ? `${R().limitMessage(limit)}（却下の日も、消すまでは日数に数えます）` : result.error };
      else if (result.dates.includes(date) && R().needsApproval(date)) {
        view.message = { ok: true, text: `${shortDate(date)}は土日祝です。土日祝は原則出勤のため、休みは店長・幹部の承認が必要です（冠婚葬祭など、やむを得ない事情のとき）。承認されるまで休みは確定しません。年次有給休暇など、法令上の休暇の申出は、この限りではありません（有給は「有給希望」から申請してください）。` };
      }
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
      await R().saveWishes({
        staffId: member.id,
        storeId: member.storeId,
        month,
        draft: view.draft,
        saved: savedWishes(),
        limit: wishLimit(),
        store,
        email: view.email,
      });
      view.busy = false;
      await reloadRequests(view.draft.length ? '希望休を送信しました。店長・幹部が承認すると休みになります。' : '希望休をなしにして送信しました。');
    } catch (err) {
      view.busy = false;
      show(false, err.message);
    }
  }

  // 幹部：自分の休みを登録（その場で確定）
  async function sendSelfWish() {
    const { member, store } = current();
    view.busy = true;
    K.app.rerender();
    try {
      const r = await R().saveSelfWishes({ staffId: member.id, storeId: member.storeId, month: R().requestWindow().month, draft: view.draft, saved: savedWishes(), limit: wishLimit(), store, email: view.email });
      view.busy = false;
      await reloadRequests(`休みを${r.added}日登録しました（確定）。オーナーのシフト表に表示されます。`);
    } catch (err) {
      view.busy = false;
      show(false, err.message);
    }
  }

  async function removeSelf(wish) {
    if (!window.confirm(`${shortDate(wish.date)}の休みを取り消しますか？`)) return;
    try {
      await R().removeSelfWish(wish, { email: view.email });
      await reloadRequests(`${shortDate(wish.date)}の休みを取り消しました。`);
    } catch (err) {
      show(false, err.message);
    }
  }

  // 幹部：社用で不在の日を登録（その場で確定）・取り消す
  async function sendBusiness(whatSelect, detailInput) {
    const { member, store } = current();
    view.busy = true;
    K.app.rerender();
    try {
      await R().registerBusinessDay({ staffId: member.id, storeId: member.storeId, date: view.bizDate, what: whatSelect.value, detail: detailInput.value, store, email: view.email, existing: myBusinessDays(), wishes: savedWishes(), paid: view.data ? view.data.paid : [] });
      const d = view.bizDate;
      view.busy = false;
      view.bizDate = null;
      await reloadRequests(`${shortDate(d)}を社用で不在として登録しました（確定）。`);
    } catch (err) {
      view.busy = false;
      show(false, err.message);
    }
  }

  async function removeBusiness(rec) {
    if (!window.confirm(`${shortDate(rec.date)}の社用で不在を取り消しますか？`)) return;
    try {
      await R().removeBusinessDay(rec);
      await reloadRequests(`${shortDate(rec.date)}の社用で不在を取り消しました。`);
    } catch (err) {
      show(false, err.message);
    }
  }

  function myBusinessDays() {
    return (view.data && view.data.businessDays) || [];
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

  // 却下された希望休を消す（上限の範囲で、別の日を申請し直せるようにする）
  async function removeRejected(wish) {
    if (!window.confirm(`却下された${shortDate(wish.date)}の希望休を消しますか？（消すと、上限の範囲で別の日を申請できます）`)) return;
    try {
      await R().removeWish(wish, { email: view.email });
      await reloadRequests(`${shortDate(wish.date)}の希望休を消しました。`);
    } catch (err) {
      show(false, err.message);
    }
  }

  // ---- 変更申請（承認済みの希望休・有給） ----
  function isChanging(target) {
    return !!view.changeFor && view.changeFor.targetId === target.id;
  }

  function openChange(kind, target) {
    view.changeFor = isChanging(target) ? null : { kind, targetId: target.id };
    view.scrollToChange = !!view.changeFor; // 開いたら、入力欄が見えるところまで動かす
    view.message = null;
    K.app.rerender();
  }

  function changeButton(kind, target) {
    if (target.status !== 'approved') return null;
    const open = isChanging(target);
    return el('button', { type: 'button', class: 'text-btn text-btn--small', 'aria-expanded': open ? 'true' : 'false', onclick: () => openChange(kind, target) }, open ? '閉じる' : '変更申請');
  }

  // 一覧の1行と、変更申請の入力中ならそのすぐ下の入力欄（一覧の flatMap で使う）
  function withChangeForm(kind, target, row) {
    return [row, changeForm(kind, target)];
  }

  // 変更申請の入力欄：押した行のすぐ下に出す
  function changeForm(kind, target) {
    if (!isChanging(target) || view.changeFor.kind !== kind) return null;
    const cf = view.changeFor;
    const { store } = current();
    const typeSelect = el(
      'select',
      { id: 'change-type', class: 'field__input field__input--short', 'aria-label': '変更の種類' },
      el('option', { value: 'cancel' }, '取り消し'),
      el('option', { value: 'move' }, '日付の変更')
    );
    const dates = K.calc.monthDates(target.month);
    const dateInput = el('input', { id: 'change-date', type: 'date', class: 'field__input req-date-input', min: dates[0], max: dates[dates.length - 1], 'aria-label': '変更後の日付' });
    const noteInput = el('input', { id: 'change-note', type: 'text', class: 'field__input', maxlength: '50', placeholder: '理由など（任意・50文字以内）' });
    // 日付の欄は「日付の変更」のときだけ出す
    const showDate = () => (dateInput.hidden = typeSelect.value !== 'move');
    typeSelect.addEventListener('change', showDate);
    showDate();
    const send = async () => {
      try {
        await R().requestChange({
          kind: cf.kind,
          target,
          type: typeSelect.value,
          newDate: dateInput.value,
          note: noteInput.value,
          store,
          email: view.email,
          existing: allData().flatMap((d) => d.changes || []),
        });
        view.changeFor = null;
        await reloadRequests('変更申請を出しました。店長・幹部が承認すると、オーナーがシフト表に反映します。');
      } catch (err) {
        show(false, err.message);
      }
    };
    const form = el(
      'div',
      { class: 'req-paid-form req-change-form' },
      el('p', { class: 'req-paid-form__date' }, `${cf.kind === 'wish' ? '希望休' : '有給'} ${shortDate(target.date)} の変更申請`),
      el('div', { class: 'time-range' }, typeSelect, dateInput),
      noteInput,
      el('p', { class: 'hint hint--left' }, '「日付の変更」は、同じ月の日付を選んでください。承認されるまでは、今のまま（承認済み）です。'),
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn--primary', onclick: send }, '変更申請を送る'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => openChange(cf.kind, target) }, 'やめる')
      )
    );
    if (view.scrollToChange) {
      view.scrollToChange = false;
      setTimeout(() => {
        if (!form.isConnected) return;
        form.scrollIntoView({ block: 'nearest' });
        typeSelect.focus({ preventScroll: true });
      }, 0);
    }
    return el('li', { class: 'detail-item req-change-row' }, form);
  }

  // 今月（確定済みのことが多い）の承認済みの希望休・有給：変更申請だけ出せる
  function thisMonthList() {
    if (!view.thisData) return null;
    const month = R().todayJst().slice(0, 7);
    const items = [...(view.thisData.wishes || []).map((x) => ({ kind: 'wish', x })), ...(view.thisData.paid || []).map((x) => ({ kind: 'paid', x }))]
      .filter((i) => i.x.status === 'approved')
      .sort((a, b) => a.x.date.localeCompare(b.x.date));
    return [
      el('h3', { class: 'card__title card__title--section' }, `${R().monthLabel(month)}の承認済みの休み`),
      items.length
        ? el(
            'ul',
            { class: 'detail-list req-this-month' },
            items.flatMap((i) =>
              withChangeForm(
                i.kind,
                i.x,
                el(
                  'li',
                  { class: 'detail-item' },
                  el('span', { class: 'detail-item__text' }, `${i.kind === 'wish' ? '希望休' : '有給'} ${shortDate(i.x.date)}`),
                  el('span', { class: 'req-status req-status--approved' }, R().STATUS_LABELS.approved),
                  changeButton(i.kind, i.x)
                )
              )
            )
          )
        : el('p', { class: 'empty-row' }, '承認済みの希望休・有給はありません。'),
    ];
  }

  function changeList() {
    const list = allData().flatMap((d) => d.changes || []).sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || ''));
    if (!list.length) return null;
    return [
      el('h3', { class: 'card__title card__title--section' }, '変更申請の状況'),
      el(
        'ul',
        { class: 'detail-list req-change-list' },
        list.map((c) =>
          el(
            'li',
            { class: 'detail-item' },
            el(
              'span',
              { class: 'detail-item__text' },
              R().changeText(c),
              c.note ? el('span', { class: 'detail-item__note' }, `（${c.note}）`) : null,
              c.status === 'rejected' && c.reason ? el('span', { class: 'req-reason' }, `却下の理由：${c.reason}`) : null,
              c.status === 'approved' ? el('span', { class: 'req-reason' }, c.reflectedAt ? 'シフト表に反映されました。' : '承認されました。オーナーがシフト表に反映します。') : null
            ),
            el('span', { class: `req-status req-status--${c.status}` }, R().STATUS_LABELS[c.status] || c.status),
            c.status === 'pending' ? el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => withdrawChangeReq(c) }, '取り下げ') : null
          )
        )
      ),
    ];
  }

  async function withdrawChangeReq(c) {
    if (!window.confirm('この変更申請を取り下げますか？')) return;
    try {
      await R().withdrawChange(c);
      await reloadRequests('変更申請を取り下げました。');
    } catch (err) {
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

  // ---- 確定シフト（所属店舗の今月・来月の確定分） ----

  function visibleMonths() {
    const thisMonth = R().todayJst().slice(0, 7);
    return [thisMonth, R().nextMonthOf(thisMonth)];
  }

  async function loadPublished() {
    const staffId = view.staffId;
    const storeId = view.storeId;
    view.pub = { staffId, loading: true, rosters: [], myPaid: new Set(), month: null, error: null };
    K.app.rerender();
    try {
      const months = visibleMonths();
      const rosters = await backend().loadPublishedRosters(storeId, months);
      // 本人の承認済みの有給（写しでは「休」になっているので、本人の画面だけ「有」にする）
      const mine = await Promise.all(months.map((m) => backend().loadMyRequests(staffId, m)));
      const myPaid = new Set(mine.flatMap((d) => d.paid.filter((r) => r.status === 'approved').map((r) => r.date)));
      if (!view.pub || view.pub.staffId !== staffId) return; // 途中で店舗を変えた
      const published = months.filter((m) => rosters.some((r) => r.month === m));
      view.pub = { staffId, loading: false, rosters, myPaid, month: published[0] || months[0], error: null };
    } catch (err) {
      if (view.pub) view.pub = { ...view.pub, loading: false, error: `確定シフトを読み込めませんでした（${err.message}）` };
    }
    K.app.rerender();
  }

  function cellText(cell, mine, date) {
    if (!cell) return '';
    if (cell.k === 'work') return cell.t;
    if (cell.k === 'business') return `社用 ${cell.t}`;
    if (cell.k === 'closed') return cell.t || '定休';
    if (cell.k === 'off') return mine && view.pub.myPaid.has(date) ? '有' : '休';
    return '';
  }

  // 「自分のシフトだけ」：縦に日付、横に時間。出勤の時間を帯で、休み・定休は文字で見せる（中身は確定シフトの写しだけ）
  function toMin(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
  }

  // 「9:00〜18:00」→ { start: 540, end: 1080 }
  function rangeOf(t) {
    const m = String(t || '').match(/(\d{1,2}:\d{2})\s*〜\s*(\d{1,2}:\d{2})/);
    return m ? { start: toMin(m[1]), end: toMin(m[2]) } : null;
  }

  function shortRange(t) {
    return String(t || '').replace(/:00/g, '').replace('〜', '-');
  }

  function mineTimeline(roster, member, label, dayClass) {
    const today = R().todayJst();
    // 横の時間の幅：その月の自分の出勤・社用の、いちばん早い始まりから、いちばん遅い終わりまで（1時間単位。なければ 9〜20時）
    const ranges = roster.days.map((d) => d.cells[member.id]).filter((c) => c && (c.k === 'work' || c.k === 'business')).map((c) => rangeOf(c.t)).filter(Boolean);
    let from = ranges.length ? Math.floor(Math.min(...ranges.map((r) => r.start)) / 60) : 9;
    let to = ranges.length ? Math.ceil(Math.max(...ranges.map((r) => r.end)) / 60) : 20;
    if (to - from < 4) to = from + 4;
    const hours = to - from;
    const step = hours > 12 ? 3 : 2;
    const pct = (min) => `${(((min - from * 60) / (hours * 60)) * 100).toFixed(3)}%`;
    const ticks = [];
    for (let h = from; h <= to; h += step) ticks.push(el('span', { class: 'pub-tl__tick', style: { left: pct(h * 60) } }, String(h)));
    const workDays = roster.days.filter((d) => { const c = d.cells[member.id]; return c && c.k === 'work'; }).length;
    const offDays = roster.days.filter((d) => { const c = d.cells[member.id]; return c && c.k === 'off'; }).length;
    const rows = roster.days.map((day) => {
      const c = day.cells[member.id];
      const r = c && (c.k === 'work' || c.k === 'business') ? rangeOf(c.t) : null;
      let mark = null;
      if (r) {
        mark = el(
          'span',
          { class: `pub-tl__bar${c.k === 'business' ? ' is-business' : ''}`, style: { left: pct(r.start), width: pct(from * 60 + (r.end - r.start)) } },
          el('span', { class: 'pub-tl__bar-text', 'aria-hidden': 'true' }, `${c.k === 'business' ? '社用 ' : ''}${shortRange(c.t)}`)
        );
      } else {
        const text = cellText(c, true, day.date);
        mark = el('span', { class: `pub-tl__label${c && c.k === 'off' && text === '有' ? ' is-paid' : ''}` }, text || '—');
      }
      return el(
        'li',
        { class: `pub-tl__row${day.closed ? ' is-closed' : ''}${day.date === today ? ' is-today' : ''}`, 'data-date': day.date },
        el('span', { class: `pub-tl__date ${dayClass(day)}` }, label(day)),
        // 読み上げ・検索用：「9:00〜18:00」「休」などの文字（画面には帯の中の短い形を出す）
        el('span', { class: 'visually-hidden' }, `：${cellText(c, true, day.date) || '—'}`),
        el('span', { class: 'pub-tl__track', 'aria-hidden': 'true' }, mark)
      );
    });
    return el(
      'div',
      { class: 'pub-tl', style: { '--tl-step': `${(100 / hours).toFixed(4)}%` } },
      el('p', { class: 'pub-tl__sum' }, `出勤 ${workDays}日・休み ${offDays}日`),
      el('div', { class: 'pub-tl__head', 'aria-hidden': 'true' }, el('span', { class: 'pub-tl__date' }, '日付'), el('span', { class: 'pub-tl__axis' }, ticks)),
      el('ul', { class: 'pub-mine pub-tl__list' }, rows)
    );
  }

  function rosterCard(member) {
    const p = view.pub;
    if (!p || p.loading) return el('section', { class: 'card req-card' }, el('p', { class: 'hint' }, '読み込んでいます…'));
    if (p.error) return el('section', { class: 'card req-card' }, el('p', { class: 'form-error' }, p.error));
    const months = visibleMonths();
    const roster = p.rosters.find((r) => r.month === p.month);
    const monthButtons = el(
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
              view.pub.month = m;
              K.app.rerender();
            },
          },
          R().monthLabel(m)
        )
      )
    );
    const parts = [el('h2', { class: 'card__title' }, '確定シフト'), monthButtons];
    if (!roster) {
      parts.push(el('p', { class: 'empty-row' }, `${R().monthLabel(p.month)}のシフトは、まだ確定していません。`));
      return el('section', { class: 'card req-card' }, parts);
    }
    const d = new Date(roster.confirmedAt);
    parts.push(el('p', { class: 'hint hint--left' }, `${roster.storeName}・${d.getMonth() + 1}/${d.getDate()} に確定`));
    parts.push(
      el(
        'label',
        { class: 'check-line' },
        el('input', {
          type: 'checkbox',
          id: 'only-mine',
          checked: view.onlyMine,
          onchange: (event) => {
            view.onlyMine = event.currentTarget.checked;
            K.app.rerender();
          },
        }),
        '自分のシフトだけ'
      )
    );
    const label = (day) => `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))}（${U.WEEKDAYS[K.calc.weekdayOf(day.date)]}）${day.hours ? ` 特別営業 ${day.hours}` : ''}`;
    const dayClass = (day) => {
      const w = K.calc.weekdayOf(day.date);
      return w === 0 || day.holiday ? 'is-sun' : w === 6 ? 'is-sat' : '';
    };
    if (view.onlyMine) {
      parts.push(mineTimeline(roster, member, label, dayClass));
    } else {
      parts.push(
        el(
          'div',
          { class: 'table-wrap pub-wrap' },
          el(
            'table',
            { class: 'data-table pub-table' },
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                el('th', { scope: 'col', class: 'is-left' }, '日付'),
                roster.staff.map((s) => el('th', { scope: 'col', class: s.id === member.id ? 'is-me' : null }, s.name, el('span', { class: 'pub-role' }, s.title ? `${s.role}・${s.title}` : s.role)))
              )
            ),
            el(
              'tbody',
              null,
              roster.days.map((day) =>
                el(
                  'tr',
                  { class: day.closed ? 'is-closed' : null },
                  el('th', { scope: 'row', class: `is-left ${dayClass(day)}` }, label(day)),
                  roster.staff.map((s) => el('td', { class: s.id === member.id ? 'is-me' : null }, cellText(day.cells[s.id], s.id === member.id, day.date)))
                )
              )
            )
          )
        )
      );
    }
    parts.push(el('p', { class: 'hint hint--left' }, 'ほかの人の有給は「休」と表示されます。シフトが変わったときは、管理者が確定し直すと更新されます。'));
    return el('section', { class: 'card req-card' }, parts);
  }

  function tabSwitch() {
    return el(
      'div',
      { class: 'segment req-tabs', role: 'tablist', 'aria-label': '画面の切り替え' },
      [
        ['requests', view.selfMode ? '休み・社用' : '休み希望'],
        ['roster', '確定シフト'],
      ].map(([key, text]) =>
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
              if (key === 'roster' && (!view.pub || view.pub.staffId !== view.staffId)) loadPublished();
              else K.app.rerender();
            },
          },
          text
        )
      )
    );
  }

  function shortDate(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${U.WEEKDAYS[K.calc.weekdayOf(date)]}）`;
  }

  function requestCard(member, store) {
    const w = R().requestWindow();
    const limit = wishLimit();
    const saved = activeDates();
    const changed = JSON.stringify(saved) !== JSON.stringify([...view.draft].sort());
    const used = view.draft.length + rejectedCount();
    const editable = w.open && !view.busy && Boolean(view.data);

    const modeSwitch = el(
      'div',
      { class: 'segment segment--compact req-mode', role: 'group', 'aria-label': '申請の種類' },
      (view.selfMode
        ? [
            ['wish', '休み'],
            ['business', '社用で不在'],
            ['paid', '有給希望'],
          ]
        : [
            ['wish', '希望休'],
            ['paid', '有給希望'],
          ]
      ).map(([key, label]) =>
        el(
          'button',
          {
            type: 'button',
            class: `segment__btn${view.mode === key ? ' is-selected' : ''}`,
            'aria-pressed': String(view.mode === key),
            onclick: () => {
              view.mode = key;
              view.paidDate = null;
              view.bizDate = null;
              view.message = null;
              K.app.rerender();
            },
          },
          label
        )
      )
    );

    const noteInput = el('input', { id: 'paid-note', class: 'field__input', type: 'text', maxlength: '50', placeholder: '理由など（任意）' });

    return el(
      'section',
      { class: 'card req-card' },
      el('h2', { class: 'card__title' }, view.selfMode ? `${R().monthLabel(w.month)}の休み・社用` : `${R().monthLabel(w.month)}の休み希望`),
      w.open ? null : el('p', { class: 'form-error' }, `今は受付期間外です。${R().closedText(w)}`),
      modeSwitch,
      view.selfMode && view.mode === 'business'
        ? el('p', { class: 'req-guide' }, el('span', { class: 'req-guide__main' }, '不在の日を押して、内容を選んで「登録」'), el('span', { class: 'req-guide__left' }, 'その場で確定します（店舗の人数には数えません）'))
        : view.mode === 'wish'
        ? el(
            'p',
            { class: 'req-guide' },
            el('span', { class: 'req-guide__main' }, view.selfMode ? '休みにする日を押して、「休みを登録」（その場で確定）' : '休みたい日を押して、「希望休を送信」'),
            el('span', { class: `req-guide__left${used >= limit ? ' is-full' : ''}` }, `あと${Math.max(0, limit - used)}日選べます（今 ${used}／${limit}日${rejectedCount() ? '・却下の日を含む' : ''}）`)
          )
        : el('p', { class: 'req-guide' }, el('span', { class: 'req-guide__main' }, '有給を希望する日を押して、「有給希望を申請」')),
      el(
        'details',
        { class: 'req-more' },
        el('summary', null, 'くわしい説明'),
        el(
          'p',
          { class: 'hint hint--left' },
          view.selfMode && view.mode !== 'paid'
            ? `幹部は、自分の休み・社用で不在の日を、承認なしで登録できます（その場で確定し、オーナーのシフト表に表示されます）。休みの決まりはスタッフの希望休と同じで、受付期間（${R().periodLabel()}）に翌月分を、月に${limit}日まで登録できます。社用で不在は、日数の上限はありません。受付期間の間は、自分で取り消せます。有給は、今までどおりオーナーが承認します。`
            : view.mode === 'wish'
            ? `休みたい日を押して「希望休を送信」を押してください。通常の希望休は${limit}日まで選べます。希望休は、店長・幹部が承認すると休みになります。土日祝は原則出勤です。年次有給休暇など、法令上の休暇の申出は、この限りではありません（有給は「有給希望」から申請してください）。`
            : '有給を希望する日を押して、「有給希望を申請」を押してください。管理者が承認すると確定します。'
        )
      ),
      calendar(store, w.month, editable),
      el('div', { class: 'req-legend' }, el('span', null, '希?＝希望休（申請中）'), el('span', { class: 'req-legend__wish' }, view.selfMode ? '希＝休み（確定）' : '希＝希望休（承認）'), el('span', null, '×＝却下'), el('span', null, '有?＝有給（申請中）'), el('span', null, '有＝有給（承認済み）'), view.selfMode ? el('span', null, '社＝社用で不在') : null, el('span', null, '休＝定休日')),
      view.message ? el('p', { class: view.message.ok ? 'sync__result' : 'form-error', role: 'alert' }, view.message.text) : null,
      view.selfMode && view.mode === 'business'
        ? view.bizDate
          ? businessForm(editable)
          : null
        : view.selfMode && view.mode === 'wish'
        ? el(
            'div',
            { class: 'actions' },
            el('button', { type: 'button', class: 'btn btn--primary btn--block req-send', disabled: !editable || !selfAdds().length, onclick: sendSelfWish }, selfAdds().length ? `休みを登録（${selfAdds().length}日・確定）` : saved.length ? '登録済み' : '日を選んでください')
          )
        : view.mode === 'wish'
        ? el(
            'div',
            { class: 'actions' },
            el('button', { type: 'button', class: 'btn btn--primary btn--block req-send', disabled: !editable || !changed, onclick: sendWish }, changed ? '希望休を送信' : saved.length || (view.data && view.data.count) ? '送信済み' : '日を選んでください'),
            changed && saved.length + view.draft.length ? el('span', { class: 'hint hint--inline' }, `まだ送信していません（${view.draft.length}日）`) : null
          )
        : view.paidDate
          ? el(
              'div',
              { class: 'req-paid-form' },
              el('p', { class: 'req-paid-form__date' }, `${shortDate(view.paidDate)} を有給希望で申請`),
              noteInput,
              el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--primary btn--block req-send', disabled: !editable, onclick: () => sendPaid(noteInput) }, '有給希望を申請'))
            )
          : null
    );
  }

  // 幹部：選んだ日のうち、まだ登録していない日
  function selfAdds() {
    const has = new Set(savedWishes().map((x) => x.date));
    return view.draft.filter((d) => !has.has(d));
  }

  // 幹部：社用で不在の入力欄（選んだ日・内容・詳細）
  function businessForm(editable) {
    const whatSelect = el('select', { id: 'biz-what', class: 'field__input', 'aria-label': '社用の内容' }, K.records.BUSINESS_WHATS.map((x) => el('option', { value: x }, x)));
    const detailInput = el('input', { id: 'biz-detail', class: 'field__input', type: 'text', maxlength: String(K.records.MAX_BUSINESS_DETAIL), placeholder: '詳細（任意・30文字以内。例：カット講習）' });
    return el(
      'div',
      { class: 'req-paid-form req-bday-form' },
      el('p', { class: 'req-paid-form__date' }, `${shortDate(view.bizDate)} を社用で不在にする`),
      whatSelect,
      detailInput,
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--primary btn--block req-send', disabled: !editable, onclick: () => sendBusiness(whatSelect, detailInput) }, '社用で不在を登録（確定）'))
    );
  }

  // 申請の状況（希望休・有給希望・今月の承認済みの休み・変更申請）を1つのカードにまとめる
  function statusCard() {
    const w = R().requestWindow();
    const paidList = (view.data ? view.data.paid : []).slice().sort((a, b) => a.date.localeCompare(b.date));
    return el(
      'section',
      { class: 'card req-card req-status-card' },
      el('h2', { class: 'card__title' }, '申請の状況'),
      el('h3', { class: 'card__title card__title--section' }, '希望休の状況'),
      savedWishes().length
        ? el(
            'ul',
            { class: 'detail-list' },
            savedWishes()
              .slice()
              .sort((a, b) => a.date.localeCompare(b.date))
              .flatMap((wsh) =>
                withChangeForm(
                  'wish',
                  wsh,
                  el(
                    'li',
                    { class: 'detail-item' },
                    el('span', { class: 'detail-item__text' }, shortDate(wsh.date), wsh.status === 'rejected' && wsh.reason ? el('span', { class: 'req-reason' }, `却下の理由：${wsh.reason}`) : null),
                    el('span', { class: `req-status req-status--${wsh.status}` }, R().isSelfWish(wsh, view.email) ? '確定（自分で登録）' : R().STATUS_LABELS[wsh.status] || wsh.status),
                    wsh.status === 'rejected' && w.open ? el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => removeRejected(wsh) }, '消す') : null,
                    R().isSelfWish(wsh, view.email) ? (w.open && wsh.month === w.month ? el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => removeSelf(wsh) }, '取り消す') : null) : changeButton('wish', wsh)
                  )
                )
              )
          )
        : el('p', { class: 'empty-row' }, view.data && view.data.count ? '希望なしで送信済みです。' : 'まだ送信していません。'),
      view.selfMode || myBusinessDays().length ? el('h3', { class: 'card__title card__title--section' }, '社用で不在') : null,
      view.selfMode || myBusinessDays().length
        ? myBusinessDays().length
          ? el(
              'ul',
              { class: 'detail-list req-bday-list' },
              myBusinessDays()
                .slice()
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((r) =>
                  el(
                    'li',
                    { class: 'detail-item' },
                    el('span', { class: 'detail-item__text' }, shortDate(r.date), el('span', { class: 'detail-item__note' }, ` ${r.what}${r.detail ? `（${r.detail}）` : ''}`)),
                    el('span', { class: 'req-status req-status--approved' }, '確定'),
                    w.open && r.month === w.month ? el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => removeBusiness(r) }, '取り消す') : null
                  )
                )
            )
          : el('p', { class: 'empty-row' }, 'まだ登録していません。')
        : null,
      el('h3', { class: 'card__title card__title--section' }, '有給希望の状況'),
      paidList.length
        ? el(
            'ul',
            { class: 'detail-list' },
            paidList.flatMap((r) =>
              withChangeForm(
                'paid',
                r,
                el(
                  'li',
                  { class: 'detail-item' },
                  el('span', { class: 'detail-item__text' }, shortDate(r.date), r.originalDate ? el('span', { class: 'detail-item__note' }, `（${shortDate(r.originalDate)}から変更）`) : null, r.status === 'rejected' && r.reason ? el('span', { class: 'req-reason' }, `却下の理由：${r.reason}`) : null),
                  el('span', { class: `req-status req-status--${r.status}` }, R().STATUS_LABELS[r.status] || r.status),
                  r.status === 'pending' && w.open ? el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => withdraw(r) }, '取り下げ') : null,
                  changeButton('paid', r)
                )
              )
            )
          )
        : el('p', { class: 'empty-row' }, 'まだ申請していません。'),
      ...(thisMonthList() || []),
      ...(changeList() || [])
    );
  }

  // いちばん上の「あいさつ」：名前・店舗・受付の状況（幹部が自分の申請を出すときは、幹部の画面へ戻るボタンも）
  function hero(params) {
    const { member, store } = view.staffId ? current() : { member: null, store: null };
    const w = R().requestWindow();
    return el(
      'section',
      { class: 'req-hero' },
      el('p', { class: 'req-hero__eyebrow' }, params.manager ? '幹部・自分の申請' : 'スタッフ'),
      el('h2', { class: 'req-hero__name' }, member ? `${member.name} さん` : '希望休・有給の申請'),
      member ? el('p', { class: 'req-hero__store' }, store ? store.name : '', member.title ? `・${member.title}` : '') : null,
      el(
        'p',
        { class: `req-hero__window${w.open ? ' is-open' : ''}` },
        el('span', { class: 'req-hero__badge' }, w.open ? '受付中' : '受付期間外'),
        el('span', null, w.open ? `${R().monthLabel(w.month)}分・${R().untilText(w)}` : `${R().monthLabel(w.opensFor)}分は${Number(w.opensOn.slice(5, 7))}月${Number(w.opensOn.slice(8, 10))}日から`)
      ),
      // 幹部がスタッフも兼ねるときは、幹部の画面へ戻れる
      params.manager
        ? el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost btn--small req-hero__back',
              onclick: () => {
                // 自分で登録した休み・社用を、幹部の画面にもすぐ出すため、読み込み直す
                if (K.screens.manager && K.screens.manager.reset) K.screens.manager.reset();
                K.app.navigate('manager', { email: params.email, manager: params.manager, account: params.account });
              },
            },
            '幹部の画面へ戻る'
          )
        : null
    );
  }

  // いちばん下の「アカウント・この端末の設定」：ログイン中のメール・簡単ログイン・パスワード・ログアウト（ふだんは閉じておく）
  function accountSection(params) {
    const user = K.app.cloudUser();
    return el(
      'details',
      { class: 'req-account' },
      el('summary', { class: 'req-account__summary' }, el('span', { class: 'req-account__title' }, 'アカウント・この端末の設定'), el('span', { class: 'req-account__hint' }, '簡単ログイン・パスワード・ログアウト')),
      el(
        'div',
        { class: 'req-account__body' },
        el('p', { class: 'hint hint--left req-account__who' }, `${view.email} でログインしています（${params.manager ? '幹部・自分の申請' : 'スタッフ'}）。`),
        // 簡単ログイン（この端末のロック）の設定
        K.quickLock && user ? K.quickLock.card(user, K.app.rerender) : null,
        K.loginUI && user ? K.loginUI.passwordCard(user) : null,
        el('button', { type: 'button', class: 'btn btn--ghost btn--block', onclick: () => K.app.cloudActions.signOut() }, 'ログアウト')
      )
    );
  }

  function render(container, params) {
    if (!view || view.email !== params.email) reset(params);
    view.selfMode = Boolean(params.manager);
    if (!view.selfMode && view.mode === 'business') view.mode = 'wish';

    if (view.loading) {
      container.append(hero(params), el('p', { class: 'hint' }, '読み込んでいます…'), accountSection(params));
      return;
    }
    if (!view.ctx || !view.ctx.staff.length) {
      container.append(hero(params), el('p', { class: 'form-error' }, (view.message && view.message.text) || 'スタッフの情報が見つかりませんでした。管理者に連絡してください。'), accountSection(params));
      return;
    }

    const parts = [hero(params)];
    // 店舗を選ぶ欄は、所属が2店舗の人だけ（1店舗の人は自動で選んである）
    const stores = view.ctx.stores.filter((s) => view.ctx.staff.some((m) => m.storeId === s.id));
    if (stores.length > 1 || !view.staffId) parts.push(storePicker());
    if (view.staffId) {
      const { member, store } = current();
      parts.push(tabSwitch());
      if (view.tab === 'roster') parts.push(rosterCard(member));
      else if (view.data) parts.push(requestCard(member, store), statusCard());
      else parts.push(view.message ? el('p', { class: 'form-error' }, view.message.text) : el('p', { class: 'hint' }, '読み込んでいます…'));
    } else {
      parts.push(el('p', { class: 'hint' }, '店舗を選ぶと、申請の画面が開きます。'));
    }
    parts.push(accountSection(params));
    container.append(...parts.filter(Boolean));
  }

  K.screens = K.screens || {};
  K.screens.request = { render, reset: () => (view = null) };
})();
