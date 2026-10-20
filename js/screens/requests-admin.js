// オーナーの「申請」タブ：希望休一覧・有給申請一覧（どちらも承認・却下・申請中に戻す。有給は日付の変更も）・判断の履歴・希望休の上限
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

  // ---- 判断（承認・却下・申請中に戻す） ----
  const ROLE_LABELS = { owner: 'オーナー', manager: '幹部' };

  function decidedText(r) {
    if (!r.decidedBy) return null;
    const at = r.decidedAt ? `${Number(r.decidedAt.slice(5, 7))}/${Number(r.decidedAt.slice(8, 10))}` : '';
    return `${ROLE_LABELS[r.decidedRole] || ''} ${r.decidedBy} ${at}`.trim();
  }

  // 却下の理由を聞く（必須・50文字以内。スタッフにも表示される）。やめたら null
  function askReason() {
    const reason = window.prompt('却下の理由を入れてください（50文字以内・スタッフにも表示されます）', '');
    if (reason === null) return null;
    return reason;
  }

  function decideButtons(kind, r, who) {
    if (r.status === 'cancelled') return []; // 取り消し済み（変更申請の反映済み）は、もう判断しない
    const act = (status, label) =>
      el(
        'button',
        {
          type: 'button',
          class: `btn btn--small ${status === 'approved' ? 'btn--primary' : 'btn--ghost'}`,
          onclick: () => {
            let reason = '';
            if (status === 'rejected') {
              reason = askReason();
              if (reason === null) return;
            }
            const done = { approved: '承認しました。', rejected: '却下しました。', pending: '申請中に戻しました。' }[status];
            run(() => R().decide(kind, r, { status, reason, email: email(), role: 'owner' }), `${who}さんの${shortDate(r.date)}を${done}`);
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

  function decisionLine(kind, r, who) {
    return el(
      'li',
      { class: 'req-holiday-item req-decision' },
      el('span', null, shortDate(r.date)),
      el('span', { class: `req-status req-status--${r.status}` }, R().STATUS_LABELS[r.status] || r.status),
      decidedText(r) ? el('span', { class: 'req-decision__by' }, decidedText(r)) : null,
      ...decideButtons(kind, r, who),
      r.status === 'rejected' && r.reason ? el('span', { class: 'req-reason' }, `理由：${r.reason}`) : null
    );
  }

  // ---- 希望休一覧（スタッフ別） ----
  function wishView(store) {
    const staff = K.storage.getStaff({ storeId: store.id });
    if (!staff.length) return el('p', { class: 'empty-row' }, `${store.name}のスタッフがいません。`);
    const rows = staff.map((m) => {
      const list = R().adminWishes({ month, staffId: m.id });
      const limit = R().adminLimit(m.id, month);
      return el(
        'tr',
        null,
        el('th', { scope: 'row', class: 'is-left' }, m.name, m.title ? el('span', { class: 'title-badge' }, ` ${m.title}`) : null),
        el(
          'td',
          { class: 'is-left' },
          list.length
            ? el('ul', { class: 'req-holiday-list' }, list.map((w) => decisionLine('wish', w, m.name)))
            : R().adminHasWish(m.id, month)
              ? '希望なし'
              : el('span', { class: 'req-unsent' }, '未提出')
        ),
        el('td', null, `${list.length}／${limit}日`)
      );
    });
    const pend = R().pendingCounts(store.id, month);
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'p',
        { class: 'hint hint--left' },
        `希望休は、平日・土日祝とも、承認したものだけが AIシフト作成で休みになります（申請中 ${pend.wishes}件）。却下には理由が必要で、スタッフにも表示されます。判断はいつでも変えられ、履歴に残ります。`
      ),
      el(
        'table',
        { class: 'data-table req-table' },
        el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'is-left' }, 'スタッフ'), el('th', { scope: 'col', class: 'is-left' }, '希望休と判断'), el('th', { scope: 'col' }, '日数／上限'))),
        el('tbody', null, rows)
      )
    );
  }

  // ---- 有給申請一覧 ----
  function paidRow(r, store) {
    const member = K.storage.getStaffMember(r.staffId);
    const who = member ? member.name : '（不明なスタッフ）';
    const dateInput = el('input', { type: 'date', class: 'field__input req-date-input', value: r.date, 'aria-label': '変更する日付' });
    return el(
      'li',
      { class: 'req-paid-row' },
      el(
        'div',
        { class: 'req-paid-row__main' },
        el('span', { class: 'req-paid-row__name' }, who),
        el('span', null, shortDate(r.date)),
        r.originalDate ? el('span', { class: 'detail-item__note' }, `（${shortDate(r.originalDate)}から変更）`) : null,
        el('span', { class: `req-status req-status--${r.status}` }, R().STATUS_LABELS[r.status] || r.status),
        decidedText(r) ? el('span', { class: 'req-decision__by' }, decidedText(r)) : null,
        r.note ? el('span', { class: 'detail-item__note' }, `備考：${r.note}`) : null,
        r.status === 'rejected' && r.reason ? el('span', { class: 'req-reason' }, `却下の理由：${r.reason}`) : null
      ),
      el(
        'div',
        { class: 'req-paid-row__actions' },
        ...decideButtons('paid', r, who),
        r.status === 'pending' ? dateInput : null,
        r.status === 'pending'
          ? el(
              'button',
              { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => run(() => R().changePaidDate(r, dateInput.value, { email: email(), store }), '日付を変更しました。') },
              '日付を変更'
            )
          : null
      )
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
    return el(
      'div',
      null,
      el('p', { class: 'hint hint--left' }, '承認した有給は、AIシフト作成で空いているマスに「有給」として入ります（入力済みのマスは変えません）。確定の前に、食い違いがないか確かめる案内が出ます。'),
      ...[group('pending', '申請中'), group('approved', '承認済み有給'), group('rejected', '却下')].filter(Boolean)
    );
  }

  // ---- 変更申請（承認済みの希望休・有給の取り消し・日付の変更） ----
  function changeView(store) {
    const list = R().adminChanges({ month, storeId: store.id });
    const head = el('p', { class: 'hint hint--left' }, '承認済みの希望休・有給について、スタッフが出した取り消し・日付の変更の申請です。承認したあと「シフト表に反映」を押すと、シフト表のマスを直し、元の申請を「取り消し済み」にします（日付の変更なら、新しい日の承認済みの申請を作ります）。確定済みの月は、先に「確定を取り消す」が必要です。');
    if (!list.length) return el('div', null, head, el('p', { class: 'empty-row' }, `${R().monthLabel(month)}の変更申請はありません。`));
    return el(
      'div',
      null,
      head,
      el(
        'ul',
        { class: 'req-paid-list' },
        list.map((c) => {
          const member = K.storage.getStaffMember(c.staffId);
          const who = member ? member.name : '（不明なスタッフ）';
          return el(
            'li',
            { class: 'req-paid-row req-change-row', 'data-id': c.id },
            el(
              'div',
              { class: 'req-paid-row__main' },
              el('span', { class: 'req-paid-row__name' }, who),
              el('span', null, R().changeText(c)),
              el('span', { class: `req-status req-status--${c.status}` }, R().STATUS_LABELS[c.status] || c.status),
              decidedText(c) ? el('span', { class: 'req-decision__by' }, decidedText(c)) : null,
              c.note ? el('span', { class: 'detail-item__note' }, `理由：${c.note}`) : null,
              c.status === 'rejected' && c.reason ? el('span', { class: 'req-reason' }, `却下の理由：${c.reason}`) : null,
              c.reflectedAt ? el('span', { class: 'req-decision__by' }, `反映済み：${c.reflectedBy} ${Number(c.reflectedAt.slice(5, 7))}/${Number(c.reflectedAt.slice(8, 10))}`) : null
            ),
            el(
              'div',
              { class: 'req-paid-row__actions' },
              ...(c.reflectedAt ? [] : decideButtons('change', c, who)),
              c.status === 'approved' && !c.reflectedAt
                ? el(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn--primary btn--small',
                      onclick: () =>
                        run(() => R().reflectChange(c, { email: email(), confirmOverwrite: (text) => window.confirm(text) }), `${who}さんの変更申請をシフト表に反映しました。`),
                    },
                    'シフト表に反映'
                  )
                : null
            )
          );
        })
      )
    );
  }

  // ---- 判断の履歴 ----
  const STATUS_SHORT = { pending: '申請中', approved: '承認', rejected: '却下', cancelled: '取り消し済み', '': '（新規）' };

  function logView(store) {
    const logs = R().adminLogs({ month, storeId: store.id });
    if (!logs.length) return el('p', { class: 'empty-row' }, `${R().monthLabel(month)}の判断の履歴はありません。`);
    return el(
      'div',
      null,
      el('p', { class: 'hint hint--left' }, '誰が・いつ・どの申請を・どう判断したかの記録です。履歴は書き換え・削除できません。'),
      el(
        'ul',
        { class: 'req-log-list' },
        logs.map((l) => {
          const member = K.storage.getStaffMember(l.staffId);
          const at = l.at ? `${Number(l.at.slice(5, 7))}/${Number(l.at.slice(8, 10))} ${new Date(l.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : '';
          const change = l.from === l.to ? l.note || '変更' : `${STATUS_SHORT[l.from] || l.from} → ${STATUS_SHORT[l.to] || l.to}`;
          return el(
            'li',
            { class: 'req-log-item' },
            el('span', { class: 'req-log-item__time' }, at),
            ' ',
            `${member ? member.name : '（不明なスタッフ）'}　${{ wish: '希望休', paid: '有給', change: '変更申請' }[l.kind] || ''} ${l.date ? shortDate(l.date) : ''}　${change}`,
            el('span', { class: 'req-decision__by' }, `　${ROLE_LABELS[l.role] || ''} ${l.by}`),
            l.reason ? el('span', { class: 'req-reason' }, `理由：${l.reason}`) : null
          );
        })
      )
    );
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
        ['change', '変更申請'],
        ['log', '判断の履歴'],
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
          key === 'change' && R().pendingCounts(store.id, month).changes ? el('span', { class: 'req-badge' }, String(R().pendingCounts(store.id, month).changes)) : null,
          key === 'wish' && R().pendingCounts(store.id, month).wishes ? el('span', { class: 'req-badge' }, String(R().pendingCounts(store.id, month).wishes)) : null,
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
      tab === 'wish' ? wishView(store) : tab === 'paid' ? paidView(store) : tab === 'change' ? changeView(store) : tab === 'log' ? logView(store) : limitView(store),
    ];
    container.append(...parts.filter(Boolean));
  }

  K.screens = K.screens || {};
  K.screens.requests = { render };
})();
