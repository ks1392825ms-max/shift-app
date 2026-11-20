// 予約サイトへの入力（11/20〜 シフト表 › 予約サイト）：確定したシフトを見ながら、カミング・ホットペッパービューティーに1人ずつ休みと出勤時間を入れる
// ・確定した月の、1人ずつの予定（休み・出勤時間）を、月のカレンダーの形で見る
// ・予約サイトごとに「入力した」のチェック（だれが・いつ）。入力のあとにシフトが変わったら「変更あり」で知らせる
// ・予定を文字でコピーできる（予約サイトに入れるときの手元のメモ用）
// ・「設定なし」：予約サイトに載せない人（アシスタントなど）。月ごとではなく、その人に付ける
// チェックは共有のデータ（bookingChecks・管理者だけ）に残す。シフトのデータは見るだけで変えない
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const SITES = [
    ['coming', 'カミング', '#7c5cff'],
    ['hpb', 'ホットペッパービューティー', '#e8508c'],
  ];
  let filter = 'all';

  // 1人分の月の予定：[{ date, kind: 'work'|'off'|'paid'|'closed'|'none', text }]
  function scheduleOf(member, view) {
    return view.dates.map((date) => {
      const s = view.map.get(`${member.id}|${date}`);
      if (!s) return view.closed.has(date) ? { date, kind: 'closed', text: '定休' } : { date, kind: 'none', text: '' };
      if (s.kind === 'work' || s.kind === 'business') {
        const p = K.storage.shiftPattern(s);
        const t = p ? `${U.formatTime(p.start)}-${U.formatTime(p.end)}` : '';
        // 社用（予約は受けられない日）は、出勤と分けて出す
        if (s.kind === 'business') return { date, kind: 'biz', text: `社用 ${t}`.trim(), short: '社用' };
        return { date, kind: 'work', text: t, short: p ? `${String(p.start).replace(/^0/, '').replace(/:00$/, '')}-${String(p.end).replace(/^0/, '').replace(/:00$/, '')}` : '' };
      }
      if (s.kind === 'paid') return { date, kind: 'paid', text: '有給' };
      return { date, kind: 'off', text: '休み' };
    });
  }
  // 予定の「しるし」：チェックのあとに変わったかを見分ける
  function signOf(list) {
    let h = 5381;
    for (const c of list.map((d) => `${d.date}${d.kind}${d.text}`).join('|')) h = ((h * 33) ^ c.codePointAt(0)) >>> 0;
    return h.toString(16);
  }
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${U.WEEKDAYS[K.calc.weekdayOf(d)]}）`;
  const stamp = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

  // 文字でコピー：休みの日と、出勤の日の時間（同じ時間の日はまとめる）
  function scheduleText(member, list, store, month) {
    const offs = list.filter((d) => d.kind === 'off' || d.kind === 'paid' || d.kind === 'closed');
    const byTime = new Map();
    for (const d of list.filter((x) => x.kind === 'work')) byTime.set(d.text, [...(byTime.get(d.text) || []), d.date]);
    const lines = [`【${store.name}】${member.name}さん ${Number(month.slice(5))}月の予定`, `休み：${offs.map((d) => `${Number(d.date.slice(8))}日${d.kind === 'paid' ? '(有給)' : d.kind === 'closed' ? '(定休)' : ''}`).join('・') || 'なし'}`];
    for (const [t, ds] of byTime) lines.push(`${t}：${ds.map((d) => `${Number(d.slice(8))}日`).join('・')}`);
    const biz = list.filter((x) => x.kind === 'biz');
    if (biz.length) lines.push(`社用（予約は受けない）：${biz.map((d) => `${Number(d.date.slice(8))}日`).join('・')}`);
    return lines.join('\n');
  }

  function render(container) {
    const store = K.app.currentStore();
    const month = K.app.state.month;
    const dates = K.calc.monthDates(month);
    const view = { dates, map: K.calc.shiftMap(month, store.id), closed: new Set(dates.filter((d) => K.calc.isStoreClosed(store, d))) };
    const pub = K.storage.getPublication(store.id, month);
    const staff = K.calc.rosterStaff(store.id, month).sort(K.storage.compareRosterStaff(store.id)).filter((m) => m.active !== false);
    // チェックの記録：「店舗|スタッフ|予約サイト」→ 記録（「設定なし」は site='none'）
    const checks = {};
    for (const c of K.storage.getBookingChecks({ storeId: store.id, month })) checks[`${c.staffId}|${c.site}`] = c;
    const key = (id, site) => `${id}|${site}`;
    const me = (K.app.cloudUser && K.app.cloudUser() && K.app.cloudUser().email) || '';
    const save = (fn) => { try { fn(); } catch (err) { K.app.toast(err.message, 3500); } K.app.rerender(); };

    const shift = (delta) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + delta, 1); K.app.setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); };
    const head = el(
      'div',
      { class: 'bk-head' },
      el('button', { type: 'button', class: 'text-btn bk-back', onclick: () => K.app.navigate('roster') }, '‹ シフト表'),
      el('div', { class: 'month-nav' }, el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => shift(-1) }, '◀'), el('h2', { class: 'month-nav__label' }, `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`), el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => shift(1) }, '▶')),
      el('span', { class: 'bk-store', style: { '--store-color': store.color } }, store.name)
    );
    if (!pub) {
      container.append(head, el('section', { class: 'card bk-empty' }, el('p', null, `${Number(month.slice(5))}月のシフトは、まだ確定していません。`), el('p', { class: 'hint' }, '確定すると、ここで1人ずつの予定を見て、予約サイトへの入力をチェックできます。')));
      return;
    }

    const rows = staff.map((m) => {
      const list = scheduleOf(m, view);
      const sig = signOf(list);
      const st = Object.fromEntries(SITES.map(([k]) => { const c = checks[key(m.id, k)]; return [k, !c ? 'todo' : c.sig === sig ? 'done' : 'changed']; }));
      // 11/20〜「設定なし」：予約サイトに載せない人（アシスタントなど）。月ごとではなく、その人に付ける（次の月もそのまま）
      const none = Boolean(checks[key(m.id, 'none')]);
      return { m, list, sig, st, none };
    });
    const targets = rows.filter((r) => !r.none);
    const count = (k, s) => targets.filter((r) => r.st[k] === s).length;
    const progress = el(
      'section',
      { class: 'bk-progress' },
      SITES.map(([k, label, color]) =>
        el(
          'div',
          { class: 'bk-prog', style: { '--site-color': color } },
          el('p', { class: 'bk-prog__head' }, el('b', null, label), el('span', null, `${count(k, 'done')}／${targets.length}人 入力済み`)),
          el('div', { class: 'bk-bar' }, el('i', { style: { width: `${targets.length ? Math.round((count(k, 'done') / targets.length) * 100) : 0}%` } })),
          count(k, 'changed') ? el('p', { class: 'bk-prog__warn' }, `⚠ 入力のあとにシフトが変わった人：${count(k, 'changed')}人`) : null,
          rows.length - targets.length ? el('p', { class: 'bk-prog__none' }, `設定なしの人（${rows.length - targets.length}人）は数えていません`) : null
        )
      )
    );
    const todo = (r) => !r.none && SITES.some(([k]) => r.st[k] !== 'done');
    const filters = [['all', '全員', rows.length], ['todo', 'まだの人', rows.filter(todo).length], ['done', '両方入力済み', targets.filter((r) => !todo(r)).length], ['none', '設定なし', rows.length - targets.length]];
    const shown = rows.filter((r) => (filter === 'todo' ? todo(r) : filter === 'done' ? !r.none && !todo(r) : filter === 'none' ? r.none : true));
    const filterBar = el('div', { class: 'bk-filters' }, filters.map(([k, label, n]) => el('button', { type: 'button', class: `pp-tab${filter === k ? ' is-on' : ''}`, onclick: () => { filter = k; K.app.rerender(); } }, el('span', { class: 'pp-tab__label' }, label), el('span', { class: 'pp-tab__num' }, String(n)))));

    const card = (r) => {
      const { m, list } = r;
      const work = list.filter((d) => d.kind === 'work').length;
      const off = list.filter((d) => d.kind === 'off' || d.kind === 'paid').length;
      const biz = list.filter((d) => d.kind === 'biz').length;
      const lead = K.calc.weekdayOf(list[0].date);
      const cells = [...Array(lead).fill(null), ...list];
      const cal = el(
        'div',
        { class: 'bk-cal' },
        ['日', '月', '火', '水', '木', '金', '土'].map((w, i) => el('span', { class: `bk-wd${i === 0 ? ' is-sun' : i === 6 ? ' is-sat' : ''}` }, w)),
        cells.map((d) => (d ? el('span', { class: `bk-day is-${d.kind}`, title: `${md(d.date)} ${d.text || '未入力'}` }, el('b', null, String(Number(d.date.slice(8)))), el('small', null, d.kind === 'work' || d.kind === 'biz' ? d.short : d.kind === 'paid' ? '有給' : d.kind === 'off' ? '休み' : d.kind === 'closed' ? '定休' : '')) : el('span', { class: 'bk-day is-blank' })))
      );
      const siteRow = ([k, label, color]) => {
        const c = checks[key(m.id, k)];
        const st = r.st[k];
        return el(
          'button',
          {
            type: 'button',
            class: `bk-check is-${st}`,
            style: { '--site-color': color },
            'aria-pressed': String(st === 'done'),
            onclick: () => {
              if (st === 'done' && !confirm(`${m.name}さんの「${label}」のチェックを外しますか？`)) return;
              save(() => (st === 'done' ? K.storage.clearBookingCheck({ storeId: store.id, staffId: m.id, site: k, month }) : K.storage.setBookingCheck({ storeId: store.id, staffId: m.id, site: k, month, sig: r.sig, by: me })));
            },
          },
          el('span', { class: 'bk-check__box', 'aria-hidden': 'true' }, st === 'done' ? '✓' : st === 'changed' ? '!' : ''),
          el('span', { class: 'bk-check__text' }, el('b', null, label), el('small', null, st === 'done' ? `入力済み ${stamp(c.checkedAt)}` : st === 'changed' ? `シフトが変わりました（${stamp(c.checkedAt)} に入力）。もう一度入れて、押し直す` : 'まだ（入れたら押す）'))
        );
      };
      return el(
        'article',
        { class: `bk-card${r.none ? ' is-none' : todo(r) ? '' : ' is-alldone'}` },
        el('div', { class: 'bk-card__head' }, el('b', { class: 'bk-name' }, m.name), el('span', { class: 'bk-sum' }, `出勤 ${work}日・休み ${off}日${biz ? `・社用 ${biz}日` : ''}`), el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: async () => { try { await navigator.clipboard.writeText(scheduleText(m, list, store, month)); K.app.toast(`${m.name}さんの予定をコピーしました`); } catch (e) { K.app.toast('コピーできませんでした'); } } }, '予定をコピー')),
        el(
          'div',
          { class: 'bk-card__body' },
          cal,
          el(
            'div',
            { class: 'bk-checks' },
            r.none ? el('div', { class: 'bk-none-note' }, el('b', null, '設定なし'), el('small', null, '予約サイトには載せない人です（次の月もこのまま）。進み具合にも数えません。')) : SITES.map(siteRow),
            el('button', { type: 'button', class: `bk-none-btn${r.none ? ' is-on' : ''}`, 'aria-pressed': String(r.none), onclick: () => { if (!r.none && !confirm(`${m.name}さんを「設定なし」（予約サイトに載せない人）にしますか？`)) return; save(() => (r.none ? K.storage.clearBookingCheck({ storeId: store.id, staffId: m.id, site: 'none' }) : K.storage.setBookingCheck({ storeId: store.id, staffId: m.id, site: 'none', by: me }))); } }, r.none ? '予約サイトに載せる人に戻す' : '設定なし（予約サイトに載せない）')
          )
        )
      );
    };

    container.append(
      head,
      el('p', { class: 'hint hint--left bk-lead' }, '確定したシフトを見ながら、予約サイトに1人ずつ休みと出勤時間を入れて、入れたらチェックを押します。入れたあとにシフトが変わると「!」で知らせます。'),
      progress,
      filterBar,
      el('div', { class: 'bk-list' }, shown.length ? shown.map(card) : el('p', { class: 'sb-empty' }, '当てはまる人はいません'))
    );
  }

  K.screens = K.screens || {};
  K.screens.booking = { render };
})();
