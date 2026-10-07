// 管理者の「申請」タブ：希望休一覧・有給申請一覧（承認・却下・日付変更）・希望休の上限
// 表示する店舗は、画面上部で選んだ店舗。共有モードでログインしたときだけ使える
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const R = () => K.requests;

  let tab = 'wish'; // wish / paid / limit
  let month = null; // 表示する月（初めは申請を受け付ける月）
  let message = null; // { ok, text }

  function email() {
    const user = K.app.cloudUser();
    return user ? user.email : '';
  }

  function show(ok, text) {
    message = { ok, text };
    K.app.rerender();
  }

  async function run(action, done) {
    try {
      const result = await action();
      if (result !== false) show(true, done);
    } catch (err) {
      show(false, err.message);
    }
  }

  function shortDate(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${U.WEEKDAYS[K.calc.weekdayOf(date)]}）`;
  }

  function shiftMonth(delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    message = null;
    K.app.rerender();
  }

  // ---- 希望休一覧（スタッフ別） ----
  function wishView(store) {
    const staff = K.storage.getStaff({ storeId: store.id });
    if (!staff.length) return el('p', { class: 'empty-row' }, `${store.name}のスタッフがいません。`);
    const rows = staff.map((m) => {
      const dates = R().adminWishDates(m.id, month);
      const limit = R().adminLimit(m.id, month);
      return el(
        'tr',
        null,
        el('th', { scope: 'row', class: 'is-left' }, m.name, m.title ? el('span', { class: 'title-badge' }, ` ${m.title}`) : null),
        el('td', { class: 'is-left' }, dates.length ? dates.map(shortDate).join('・') : hasWishDoc(m.id) ? '希望なし' : el('span', { class: 'req-unsent' }, '未提出')),
        el('td', null, `${dates.length}／${limit}日`)
      );
    });
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table req-table' },
        el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'is-left' }, 'スタッフ'), el('th', { scope: 'col', class: 'is-left' }, '希望休'), el('th', { scope: 'col' }, '日数／上限'))),
        el('tbody', null, rows)
      )
    );
  }

  function hasWishDoc(staffId) {
    return R().adminHasWish(staffId, month);
  }

  // ---- 有給申請一覧 ----
  function paidRow(r, store) {
    const member = K.storage.getStaffMember(r.staffId);
    const dateInput = el('input', { type: 'date', class: 'field__input req-date-input', value: r.date, 'aria-label': '変更する日付' });
    return el(
      'li',
      { class: 'req-paid-row' },
      el(
        'div',
        { class: 'req-paid-row__main' },
        el('span', { class: 'req-paid-row__name' }, member ? member.name : '（不明なスタッフ）'),
        el('span', null, shortDate(r.date)),
        r.originalDate ? el('span', { class: 'detail-item__note' }, `（${shortDate(r.originalDate)}から変更）`) : null,
        el('span', { class: `req-status req-status--${r.status}` }, R().STATUS_LABELS[r.status] || r.status),
        r.note ? el('span', { class: 'detail-item__note' }, `理由：${r.note}`) : null
      ),
      r.status === 'pending'
        ? el(
            'div',
            { class: 'req-paid-row__actions' },
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn--primary btn--small',
                onclick: () =>
                  run(() => R().approvePaid(r, { email: email(), confirmOverwrite: (text) => window.confirm(text) }), `${member ? member.name : ''}さんの${shortDate(r.date)}の有給を承認しました。シフト表に「有給」を入れました。`),
              },
              '承認'
            ),
            el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => run(() => R().rejectPaid(r, { email: email() }), '却下しました。') }, '却下'),
            dateInput,
            el(
              'button',
              { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => run(() => R().changePaidDate(r, dateInput.value, { email: email(), store }), '日付を変更しました。') },
              '日付を変更'
            )
          )
        : null
    );
  }

  function paidView(store) {
    const list = R().adminPaid({ month, storeId: store.id });
    if (!list.length) return el('p', { class: 'empty-row' }, `${R().monthLabel(month)}の有給申請はありません。`);
    const group = (status, title) => {
      const items = list.filter((r) => r.status === status);
      return items.length
        ? el('section', { class: 'req-group' }, el('h3', { class: 'card__title card__title--section' }, `${title}（${items.length}件）`), el('ul', { class: 'req-paid-list' }, items.map((r) => paidRow(r, store))))
        : null;
    };
    return el('div', null, [group('pending', '申請中'), group('approved', '承認済み有給'), group('rejected', '却下')].filter(Boolean));
  }

  // ---- 希望休の上限 ----
  function limitView(store) {
    const settings = R().settingsOf(R().adminSettings());
    const defaultInput = el('input', { id: 'req-default-limit', type: 'number', min: '0', max: '31', class: 'field__input field__input--short', value: String(settings.defaultLimit) });
    const staff = K.storage.getStaff({ storeId: store.id });
    return el(
      'div',
      null,
      el(
        'section',
        { class: 'card' },
        el('h3', { class: 'card__title' }, '全員の初期の上限'),
        el('div', { class: 'time-range' }, defaultInput, el('span', null, '日まで')),
        el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => run(() => R().setDefaultLimit(defaultInput.value, email()), '初期の上限を保存しました。') }, '保存')),
        el('p', { class: 'hint hint--left' }, 'スタッフが通常の希望休として選べる日数です（全店舗共通）。')
      ),
      el(
        'section',
        { class: 'card' },
        el('h3', { class: 'card__title' }, `${R().monthLabel(month)}のスタッフ別の上限（${store.name}）`),
        el('p', { class: 'hint hint--left' }, '夏休み・冬休みなどで、その月だけ多く休む人の上限を変えます。空欄にすると初期の上限に戻ります。'),
        el(
          'ul',
          { class: 'req-limit-list' },
          staff.map((m) => {
            const quota = R().adminQuota(m.id, month);
            const input = el('input', { type: 'number', min: '0', max: '31', class: 'field__input field__input--short', value: quota ? String(quota.limit) : '', placeholder: String(settings.defaultLimit), 'aria-label': `${m.name}さんの上限` });
            const note = el('input', { type: 'text', maxlength: '50', class: 'field__input', value: quota ? quota.note || '' : '', placeholder: 'メモ（例：夏休み）', 'aria-label': `${m.name}さんのメモ` });
            return el(
              'li',
              { class: 'req-limit-row' },
              el('span', { class: 'req-limit-row__name' }, m.name),
              input,
              el('span', null, '日'),
              note,
              el(
                'button',
                {
                  type: 'button',
                  class: 'btn btn--ghost btn--small',
                  onclick: () => run(() => R().setQuota({ staffId: m.id, storeId: m.storeId, month, value: input.value, note: note.value, email: email() }), `${m.name}さんの上限を保存しました。`),
                },
                '保存'
              )
            );
          })
        )
      )
    );
  }

  function render(container) {
    if (!K.storage.isCloud()) {
      container.append(
        el('section', { class: 'card' }, el('h2', { class: 'card__title' }, '申請'), el('p', { class: 'hint hint--left' }, '希望休・有給の申請は、共有モードでログインすると使えます（設定 > データ）。'))
      );
      return;
    }
    if (!month) month = R().requestWindow().month;
    const store = K.app.currentStore();
    const w = R().requestWindow();

    const tabs = el(
      'div',
      { class: 'segment segment--compact req-tabs', role: 'tablist', 'aria-label': '申請の種類' },
      [
        ['wish', '希望休一覧'],
        ['paid', '有給申請一覧'],
        ['limit', '希望休の上限'],
      ].map(([key, label]) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `segment__btn${tab === key ? ' is-selected' : ''}`,
            'aria-selected': String(tab === key),
            onclick: () => {
              tab = key;
              message = null;
              K.app.rerender();
            },
          },
          label,
          key === 'paid' && R().adminPaid({ month, storeId: store.id }).some((r) => r.status === 'pending')
            ? el('span', { class: 'req-badge' }, String(R().adminPaid({ month, storeId: store.id }).filter((r) => r.status === 'pending').length))
            : null
        )
      )
    );

    // 表示しない部分（null）を除いてから並べる（そのまま渡すと「null」の文字が出てしまう）
    const parts = [
      el(
        'div',
        { class: 'roster-toolbar' },
        el(
          'div',
          { class: 'month-nav' },
          el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => shiftMonth(-1) }, '◀'),
          el('h2', { class: 'month-nav__label' }, R().monthLabel(month)),
          el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => shiftMonth(1) }, '▶')
        ),
        el('span', { class: 'store-tag', style: { '--store-color': store.color } }, store.name)
      ),
      el('p', { class: 'hint' }, w.open ? `${R().monthLabel(w.month)}分の申請を受付中です（今月末まで）。` : `${R().monthLabel(w.month)}分の申請は、${Number(w.opensOn.slice(5, 7))}月25日から受け付けます。`),
      tabs,
      message ? el('p', { class: message.ok ? 'sync__result' : 'form-error', role: 'status' }, message.text) : null,
      tab === 'wish' ? wishView(store) : tab === 'paid' ? paidView(store) : limitView(store),
    ];
    container.append(...parts.filter(Boolean));
  }

  K.screens = K.screens || {};
  K.screens.requests = { render };
})();
