// 勤怠の画面（11/9〜）：管理者（下のタブ「勤怠」）と幹部（幹部の画面のタブ「勤怠」）で共通
//   今日：今日の予定の人の様子（出勤中・休憩中・未出勤（予定から10分すぎ）・退勤）と、今日の休みの人
//   月の表：1人ずつ、日ごとの予定と実際（出勤・退勤・休憩・外出・労働・残業）。日を押すと「直す」（理由は必須・修正の記録を残す）
//   集計表：パスワードで開く。全員の集計と、会社の勤怠集計表の形（1人1枚・A4 縦）の PDF（印刷）・Excel。1人だけでも全員でも出せる
// 幹部（11/12〜）：3店舗とも見る・出力できる。直せるのは担当店舗だけ。毎月最終日の20時に締めたあとは、幹部は見るだけ（直せるのは管理者）。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const A = () => K.attendance;

  const states = {}; // 役割ごとの画面の状態（管理者と幹部で別）

  function stateFor(key, ctx) {
    if (!states[key] || states[key].email !== ctx.email) {
      const { month } = A().nowJst();
      states[key] = { email: ctx.email, sub: 'today', storeId: null, month, data: null, plan: null, loading: false, error: '', staffId: null, editing: null, msg: null, settings: null, pass: '' };
    }
    const st = states[key];
    if (!st.storeId || !ctx.stores.some((s) => s.id === st.storeId)) st.storeId = ctx.stores.length ? ctx.stores[0].id : null;
    return st;
  }

  async function loadData(st, ctx) {
    if (!st.storeId) return;
    st.loading = true;
    st.error = '';
    const key = `${st.storeId}|${st.month}`;
    st.loadingKey = key;
    try {
      const [data, plan, settings] = await Promise.all([A().backend().loadAttendance(st.storeId, st.month), ctx.planSource(st.storeId, st.month), st.settings ? Promise.resolve(st.settings) : A().backend().loadAttendanceSettings()]);
      if (st.loadingKey !== key) return;
      st.data = data;
      st.plan = plan;
      st.settings = settings || {};
      st.dataKey = key;
    } catch (err) {
      st.error = `読み込めませんでした（${err.message}）`;
    }
    st.loading = false;
    K.app.rerender();
  }

  function ensure(st, ctx) {
    const key = `${st.storeId}|${st.month}`;
    if (st.dataKey !== key && st.loadingKey !== key) loadData(st, ctx);
  }

  function md(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${U.WEEKDAYS[K.calc.weekdayOf(date)]}）`;
  }

  function table(st, ctx) {
    return A().monthTable({ month: st.month, staff: ctx.staffOf(st.storeId), planOf: st.plan, punches: st.data.punches, edits: st.data.edits, patterns: ctx.patternsOf ? ctx.patternsOf(st.storeId) : [] });
  }

  // 直せるか：管理者はいつでも。幹部は担当店舗を、締めの前まで（ほかの店舗は見る・出力だけ）
  function canEdit(st, ctx) {
    if (ctx.canEditStore && !ctx.canEditStore(st.storeId)) return false;
    return ctx.role === 'owner' || !A().isClosed(st.month);
  }
  // 時間（分）→「1.5」（0 は空欄）
  const hrs = (min) => (min ? A().hours(min) : '');

  // ---- 今日 ----
  function todayView(st, ctx) {
    const { date } = A().nowJst();
    if (st.month !== date.slice(0, 7)) return el('p', { class: 'att-empty' }, '「今日」は今月の表示のときに出ます。');
    const staff = ctx.staffOf(st.storeId);
    const punches = st.data.punches.filter((p) => p.date === date);
    const edits = st.data.edits.filter((e) => e.date === date);
    const rows = [];
    const off = [];
    for (const m of staff) {
      const plan = st.plan ? st.plan(m.id, date) : null;
      const mine = punches.filter((p) => p.staffId === m.id);
      const edit = edits.find((e) => e.staffId === m.id) || null;
      const working = plan && (plan.kind === 'work' || plan.kind === 'business');
      if (!working && !mine.length && !edit) {
        if (plan && (plan.kind === 'off' || plan.kind === 'paid')) off.push({ m, plan });
        continue;
      }
      const d = A().dayOf(mine, edit, { today: date, date });
      let state = A().stateOf(mine);
      if (edit) state = d.out ? 'out' : d.in ? 'in' : 'wait';
      const late = A().isLate(plan, state);
      rows.push({ m, plan, d, state: late ? 'late' : state, extra: !working });
    }
    const order = { late: 0, br: 1, in: 2, wait: 3, out: 4 };
    rows.sort((a, b) => order[a.state] - order[b.state]);
    const count = (k) => rows.filter((r) => r.state === k).length;
    const label = { late: '未出勤', wait: 'これから', in: '出勤中', br: '休憩中', out: '退勤' };
    return el(
      'div',
      { class: 'att-today' },
      el(
        'div',
        { class: 'att-counts' },
        [['in', '出勤中'], ['br', '休憩中'], ['late', '未出勤（10分すぎ）'], ['wait', 'これから'], ['out', '退勤']].map(([k, t]) => el('div', { class: `att-count is-${k}` }, el('b', null, String(count(k))), el('span', null, `人 ${t}`)))
      ),
      rows.length
        ? el(
            'ul',
            { class: 'att-list' },
            rows.map((r) =>
              el(
                'li',
                { class: `att-row is-${r.state}` },
                el('i', { class: 'att-dot', 'aria-hidden': 'true' }),
                el('span', { class: 'att-name' }, r.m.name, r.extra ? el('small', { class: 'att-tag' }, '予定外') : null),
                el('span', { class: 'att-plan' }, r.plan ? A().planLabel(r.plan) : '予定なし'),
                el('span', { class: 'att-times' }, r.d.in ? `${A().shortTime(r.d.in)}〜${A().shortTime(r.d.out)}` : '—', r.d.breaks.length || r.d.openBreak ? el('small', null, ` 休憩 ${r.d.breaks.map((b) => `${A().shortTime(b.s)}-${A().shortTime(b.e)}`).join(' ')}${r.d.openBreak ? ` ${A().shortTime(r.d.openBreak)}〜` : ''}`) : null),
                el('span', { class: `att-state is-${r.state}` }, label[r.state]),
                canEdit(st, ctx) ? el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => startEdit(st, r.m.id, date) }, '直す') : null
              )
            )
          )
        : el('p', { class: 'att-empty' }, '今日シフトがある人はいません。'),
      off.length ? el('p', { class: 'att-off' }, el('b', null, '今日の休み　'), off.map((x) => `${x.m.name}${x.plan.kind === 'paid' ? '（有給）' : ''}`).join('・')) : null
    );
  }

  // ---- 月の表 ----
  function monthView(st, ctx) {
    const rows = table(st, ctx);
    if (!rows.length) return el('p', { class: 'att-empty' }, 'スタッフがいません。');
    if (!st.staffId || !rows.some((r) => r.staff.id === st.staffId)) st.staffId = rows[0].staff.id;
    const row = rows.find((r) => r.staff.id === st.staffId);
    const editable = canEdit(st, ctx);
    const logs = st.data.logs.filter((l) => l.staffId === st.staffId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return el(
      'div',
      { class: 'att-month' },
      el(
        'div',
        { class: 'att-people', role: 'group', 'aria-label': 'スタッフを選ぶ' },
        rows.map((r) => el('button', { type: 'button', class: `att-chip${r.staff.id === st.staffId ? ' is-selected' : ''}`, 'aria-pressed': String(r.staff.id === st.staffId), onclick: () => { st.staffId = r.staff.id; st.editing = null; K.app.rerender(); } }, r.staff.name, r.total.shortDays || r.total.missingOut ? el('i', { class: 'att-warn-dot', 'aria-label': '確認が必要な日あり' }) : null))
      ),
      st.editing ? editForm(st, ctx, rows) : null,
      el(
        'div',
        { class: 'att-scroll' },
        el(
          'table',
          { class: 'att-table' },
          el('thead', null, el('tr', null, ['日付', '予定', '開始', '終了', '休憩', '外出', '労働', '残業', ''].map((h) => el('th', null, h)))),
          el(
            'tbody',
            null,
            row.days.map((d) => {
              const wd = K.calc.weekdayOf(d.date);
              const plan = d.plan;
              const blank = !d.in && !d.out && plan && plan.kind !== 'work' && plan.kind !== 'business';
              const marks = A().marksOf(d).filter((m) => m !== '修正' && m !== '有給');
              return el(
                'tr',
                { class: `${wd === 0 ? 'is-sun' : wd === 6 ? 'is-sat' : ''}${d.short || d.missingOut ? ' is-warn' : ''}` },
                el('th', { scope: 'row' }, md(d.date), marks.length ? el('small', { class: 'att-marks' }, marks.join('・')) : null),
                el('td', null, A().planLabel(plan)),
                blank ? el('td', { colspan: '6', class: 'att-muted' }, A().planLabel(plan)) : [
                  el('td', null, A().shortTime(d.in) || '—', d.edited ? el('small', { class: 'att-fixed' }, '修正') : null),
                  el('td', { class: d.missingOut ? 'att-bad' : '' }, d.out ? A().shortTime(d.out) : d.missingOut ? '未入力' : '—'),
                  el('td', { class: d.short ? 'att-bad' : '' }, hrs(d.breakMin)),
                  el('td', null, hrs(d.outMin)),
                  el('td', null, d.workMin != null ? A().hours(d.workMin) : '—'),
                  el('td', null, hrs(d.overMin)),
                ],
                el('td', null, editable ? el('button', { type: 'button', class: 'btn btn--ghost btn--small', 'aria-label': `${md(d.date)}を直す`, onclick: () => startEdit(st, row.staff.id, d.date) }, '直す') : null)
              );
            })
          ),
          el('tfoot', null, el('tr', null, el('th', { scope: 'row' }, '合計'), el('td', null, ''), el('td', { colspan: '2' }, `出勤 ${row.total.workDays}日${row.total.paidDays ? `・有給 ${row.total.paidDays}日` : ''}`), el('td', null, A().hours(row.total.breakMin)), el('td', null, A().hours(row.total.outMin)), el('td', null, A().hours(row.total.workMin)), el('td', null, A().hours(row.total.overMin)), el('td', null, '')))
        )
      ),
      el('p', { class: 'att-note' }, '時間は「時間」の単位（1.5＝1時間30分）。労働＝終了−開始−休憩−外出。残業＝労働−予定の労働（予定の時間−勤務パターンの休憩）。0時を過ぎた退勤は「25:30」のように出します。'),
      el('p', { class: 'att-note' }, editable ? '赤は休憩不足（6時間をこえる日は45分・8時間をこえる日は60分）と退勤の打ち忘れ。日付の「直す」で直せます。' : ctx.canEditStore && !ctx.canEditStore(st.storeId) ? '担当していない店舗なので、見る・出力だけです。' : `${Number(st.month.slice(5))}月は締めました。直せるのは管理者だけです。`),
      logs.length
        ? el('details', { class: 'att-logs' }, el('summary', null, `修正の記録（${logs.length}件）`), el('ul', null, logs.map((l) => el('li', null, `${md(l.date)}　${l.from ? `${A().shortTime(l.from.in) || '—'}〜${A().shortTime(l.from.out) || '—'}` : '（打刻のまま）'} → ${A().shortTime(l.to.in) || '—'}〜${A().shortTime(l.to.out) || '—'}　理由：${l.reason}　（${l.role === 'owner' ? '管理者' : '幹部'} ${l.by === ctx.email ? 'あなた' : l.by}・${stamp(l.at)}）`))))
        : null
    );
  }

  function stamp(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function startEdit(st, staffId, date) {
    st.sub = 'month';
    st.staffId = staffId;
    st.editing = { staffId, date, msg: '', vals: {} };
    K.app.rerender();
    setTimeout(() => {
      const f = document.getElementById('att-in');
      if (f) f.focus();
    }, 0);
  }

  function editForm(st, ctx, rows) {
    const e = st.editing;
    const row = rows.find((r) => r.staff.id === e.staffId);
    const d = row && row.days.find((x) => x.date === e.date);
    if (!d) return null;
    // 入れた値は、保存できなかったとき（理由がない など）も消さない
    const keep = (id, value) => (Object.prototype.hasOwnProperty.call(e.vals, id) ? e.vals[id] : value || '');
    const remember = (ev) => (e.vals[ev.currentTarget.id] = ev.currentTarget.value);
    // 「25:30」（翌日）は、時刻の欄では「01:30」と出す（保存するときに翌日に戻す）
    const clock = (t) => {
      const m = A().toMinX(t);
      return m == null ? '' : A().fromMin(m % (24 * 60));
    };
    const timeInput = (id, value, label) => el('label', { class: 'att-field' }, el('span', null, label), el('input', { type: 'time', id, class: 'field__input', value: keep(id, clock(value)), step: '60', oninput: remember, onchange: remember }));
    const br = d.breaks.length ? d.breaks : [{ s: '', e: '' }];
    const breakRows = [...br, { s: '', e: '' }].slice(0, 3);
    const outRows = [...(d.outs || []), { s: '', e: '' }, { s: '', e: '' }].slice(0, Math.min(6, Math.max(2, (d.outs || []).length + 1)));
    return el(
      'section',
      { class: 'att-edit', role: 'region', 'aria-label': '時刻を直す' },
      el('h3', null, `${md(e.date)}　${row.staff.name} の時刻を直す`),
      el('p', { class: 'att-note' }, `予定：${A().planLabel(d.plan)}　／　今：${d.in ? `${A().shortTime(d.in)}〜${A().shortTime(d.out) || '未入力'}` : '打刻なし'}${d.edited ? '（修正済み）' : ''}`),
      el('div', { class: 'att-grid' }, timeInput('att-in', d.in, '出勤'), timeInput('att-out', d.out, '退勤')),
      el('p', { class: 'att-sub' }, '休憩（開始・戻り）'),
      breakRows.map((b, i) => el('div', { class: 'att-grid' }, timeInput(`att-bs-${i}`, b.s, `休憩${i + 1} 開始`), timeInput(`att-be-${i}`, b.e, `休憩${i + 1} 戻り`))),
      el('p', { class: 'att-sub' }, '外出（出・戻り）　労働時間から引きます'),
      outRows.map((b, i) => el('div', { class: 'att-grid' }, timeInput(`att-os-${i}`, b.s, `外出${i + 1} 出`), timeInput(`att-oe-${i}`, b.e, `外出${i + 1} 戻り`))),
      el('p', { class: 'att-note' }, '0時を過ぎて退勤したときは、そのまま「1:30」のように入れてください（翌朝5時までは、翌日の時刻として数えます）。'),
      el('label', { class: 'att-field att-field--wide' }, el('span', null, '直す理由（必ず・50文字まで）'), el('input', { type: 'text', id: 'att-reason', class: 'field__input', maxlength: '50', placeholder: '例：打ち忘れのため・iPad が動かなかった', value: keep('att-reason', ''), oninput: remember })),
      e.msg ? el('p', { class: 'form-error', role: 'alert' }, e.msg) : null,
      el(
        'div',
        { class: 'att-actions' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--primary',
            onclick: async () => {
              const v = (id) => {
                const x = document.getElementById(id);
                if (x) e.vals[id] = x.value;
                return (x && x.value) || '';
              };
              const breaks = breakRows.map((_, i) => ({ s: v(`att-bs-${i}`), e: v(`att-be-${i}`) }));
              const outs = outRows.map((_, i) => ({ s: v(`att-os-${i}`), e: v(`att-oe-${i}`) }));
              try {
                const staff = ctx.staffOf(st.storeId).find((m) => m.id === e.staffId);
                const rec = await A().saveEdit({ staffId: e.staffId, storeId: st.storeId, date: e.date, in: v('att-in'), out: v('att-out'), breaks, outs, reason: v('att-reason'), email: ctx.email, role: ctx.role, before: d.in || d.out ? d : null });
                st.data.edits = st.data.edits.filter((x) => !(x.staffId === rec.staffId && x.date === rec.date)).concat(rec);
                st.data.logs = st.data.logs.concat({ targetId: rec.id, staffId: rec.staffId, storeId: rec.storeId, date: rec.date, month: rec.month, from: d.in || d.out ? { in: d.in, out: d.out } : null, to: { in: rec.in, out: rec.out, outs: rec.outs }, reason: rec.reason, by: rec.by, role: rec.role, at: rec.at });
                st.editing = null;
                st.msg = { ok: true, text: `${md(e.date)}の${staff ? staff.name : ''}の時刻を直しました。` };
              } catch (err) {
                e.msg = err.message;
              }
              K.app.rerender();
            },
          },
          '保存'
        ),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { st.editing = null; K.app.rerender(); } }, 'やめる')
      )
    );
  }

  // ---- 集計表 ----
  function summaryView(st, ctx) {
    const closed = A().isClosed(st.month);
    if (!A().isSummaryUnlocked()) {
      const input = el('input', { type: 'password', id: 'att-pass', class: 'field__input', autocomplete: 'off', placeholder: '集計表のパスワード' });
      const open = async () => {
        try {
          await A().unlockSummary(input.value, st.settings);
          st.msg = null;
        } catch (err) {
          st.msg = { ok: false, text: err.message };
        }
        K.app.rerender();
      };
      input.addEventListener('keydown', (ev) => ev.key === 'Enter' && open());
      return el(
        'div',
        { class: 'att-lock' },
        el('p', { class: 'att-lock__icon', 'aria-hidden': 'true' }, '🔒'),
        el('h3', null, '集計表のパスワード'),
        el('p', { class: 'att-note' }, st.settings && st.settings.summaryHash ? '給与に関わる内容なので、パスワードを入れて開きます。' : 'パスワードがまだ決まっていません。管理者が 設定 › 勤怠 で決めてください。'),
        el('div', { class: 'att-lock__row' }, input, el('button', { type: 'button', class: 'btn btn--primary', onclick: open }, '開く'))
      );
    }
    const rows = table(st, ctx);
    const store = ctx.stores.find((s) => s.id === st.storeId);
    // 出力する人：全員（1人1枚）か、1人だけ（11/12〜）
    if (st.outStaff && !rows.some((r) => r.staff.id === st.outStaff)) st.outStaff = '';
    const picked = st.outStaff ? rows.filter((r) => r.staff.id === st.outStaff) : rows;
    const args = { store, month: st.month, rows: picked };
    const who = el(
      'label',
      { class: 'att-field att-field--wide att-out-who' },
      el('span', null, '出力する人'),
      el(
        'select',
        { id: 'att-out-staff', class: 'field__input', onchange: (ev) => { st.outStaff = ev.currentTarget.value; K.app.rerender(); } },
        el('option', { value: '', selected: !st.outStaff }, `全員（${rows.length}人・1人1枚）`),
        rows.map((r) => el('option', { value: r.staff.id, selected: st.outStaff === r.staff.id }, r.staff.name))
      )
    );
    return el(
      'div',
      { class: 'att-summary' },
      el('p', { class: 'att-note' }, closed ? `締め済み（${Number(st.month.slice(5))}月の最終日 20:00）` : `締めの前です（${Number(st.month.slice(5))}月の最終日 20:00 に締めます）。数字は今の時点のものです。`),
      el(
        'div',
        { class: 'att-scroll' },
        el(
          'table',
          { class: 'att-table att-table--sum' },
          el('thead', null, el('tr', null, A().SUMMARY_HEAD.map((h) => el('th', null, h)))),
          el('tbody', null, rows.map((r) => el('tr', null, A().summaryRow(r).map((c, i) => (i ? el('td', { class: (i === 8 && r.total.shortDays) || (i === 9 && r.total.missingOut) ? 'att-bad' : '' }, c) : el('th', { scope: 'row' }, c)))))),
          el('tfoot', null, el('tr', null, A().totalRow(rows).map((c, i) => (i ? el('td', null, c) : el('th', { scope: 'row' }, c)))))
        )
      ),
      who,
      el(
        'div',
        { class: 'att-actions' },
        el('button', { type: 'button', class: 'btn btn--primary', onclick: () => A().printSummary(args, { onNotOpened: () => K.app.toast('印刷の画面が開きませんでした。もう一度押すか、Safari の共有ボタンから「プリント」を選んでください') }) }, 'PDF（印刷）'),
        el('button', { type: 'button', class: 'btn btn--primary', onclick: async () => { const r = await A().saveExcel(args); if (r === 'downloaded') K.app.toast('Excel のファイルを保存しました'); } }, 'Excel'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { A().lockSummary(); K.app.rerender(); } }, '閉じる（鍵をかける）')
      ),
      el('p', { class: 'att-note' }, 'PDF・Excel は、会社の勤怠集計表の形（1人1枚・A4 縦）です。PDF は、印刷の画面で「PDFとして保存」を選びます。全員の Excel は、1枚目に全員の集計、2枚目から1人1シートです。'),
      el('p', { class: 'att-note' }, '時間は小数第1位（四捨五入）。月の合計は、分のまま足してから四捨五入します。')
    );
  }

  function closedBanner() {
    const n = A().closedNotice();
    return n ? el('p', { class: 'att-banner', role: 'status' }, `🔔 ${Number(n.month.slice(5))}月の勤怠を締めました（最終日 20:00）。集計表ができました。`) : null;
  }

  // 管理者・幹部で共通の中身。ctx = { key, role（owner/manager）, email, stores, staffOf(storeId), planSource(storeId, month) → planOf }
  function panel(ctx) {
    const st = stateFor(ctx.key, ctx);
    if (!st.storeId) return el('p', { class: 'att-empty' }, '店舗がありません。');
    ensure(st, ctx);
    const monthNav = el(
      'div',
      { class: 'month-nav att-monthnav' },
      el('button', { type: 'button', class: 'month-nav__btn', 'aria-label': '前の月', onclick: () => { st.month = shift(st.month, -1); st.editing = null; K.app.rerender(); } }, '◀'),
      el('span', { class: 'month-nav__label' }, K.requests.monthLabel(st.month)),
      el('button', { type: 'button', class: 'month-nav__btn', 'aria-label': '次の月', onclick: () => { st.month = shift(st.month, 1); st.editing = null; K.app.rerender(); } }, '▶')
    );
    const subs = el(
      'div',
      { class: 'segment segment--compact att-subs', role: 'tablist', 'aria-label': '勤怠の表示' },
      [['today', '今日'], ['month', '月の表'], ['summary', '集計表']].map(([k, t]) => el('button', { type: 'button', role: 'tab', class: `segment__btn${st.sub === k ? ' is-selected' : ''}`, 'aria-selected': String(st.sub === k), onclick: () => { st.sub = k; st.msg = null; if (k === 'today') st.month = A().nowJst().month; K.app.rerender(); } }, t))
    );
    const storeChips =
      ctx.stores.length > 1 && ctx.showStoreChips !== false
        ? el('div', { class: 'att-stores' }, ctx.stores.map((s) => el('button', { type: 'button', class: `req-choice${s.id === st.storeId ? ' is-selected' : ''}`, onclick: () => { st.storeId = s.id; st.editing = null; K.app.rerender(); } }, s.name, ctx.canEditStore && !ctx.canEditStore(s.id) ? el('small', { class: 'att-viewonly' }, '見るだけ') : null)))
        : null;
    let body;
    if (st.error) body = el('p', { class: 'form-error' }, st.error);
    else if (!st.data || st.dataKey !== `${st.storeId}|${st.month}`) body = el('p', { class: 'att-empty' }, '読み込んでいます…');
    else body = st.sub === 'today' ? todayView(st, ctx) : st.sub === 'month' ? monthView(st, ctx) : summaryView(st, ctx);
    return el(
      'div',
      { class: 'att' },
      closedBanner(),
      subs,
      storeChips,
      st.sub !== 'today' ? monthNav : null,
      st.msg && st.msg.text ? el('p', { class: st.msg.ok ? 'sync__result' : 'form-error', role: 'status' }, st.msg.text) : null,
      body
    );
  }

  function shift(month, n) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // ---- 管理者の画面（下のタブ「勤怠」） ----

  // 管理者の予定：作成中を含むシフト表（storage）から
  function adminPlan(storeId, month) {
    const store = K.storage.getStore(storeId);
    const map = K.calc.shiftMap(month, storeId);
    return (staffId, date) => {
      const s = map.get(`${staffId}|${date}`);
      if (!s) return store && K.calc.isStoreClosed(store, date) ? { kind: 'closed', t: '定休' } : null;
      if (s.kind === 'work' || s.kind === 'business') {
        const p = K.storage.shiftPattern(s);
        return { kind: s.kind, start: p ? p.start : '', end: p ? p.end : '', t: p ? `${U.formatTime(p.start)}〜${U.formatTime(p.end)}` : '' };
      }
      if (s.kind === 'paid') return { kind: 'paid', t: '有給' };
      return { kind: 'off', t: '休み' };
    };
  }

  // 集計表に出すスタッフの情報（表示名・従業員番号・氏名・職種）
  function staffInfo(m) {
    return { id: m.id, name: m.name, fullName: m.fullName || '', employeeNo: m.employeeNo || '', position: m.position || m.role || '' };
  }
  // その店舗で使える勤務パターンの開始・終了・休憩（残業の計算の「予定の労働」に使う）
  function storePatterns(storeId) {
    return K.storage
      .getPatterns({ storeId })
      .map((p) => ({ start: p.start, end: p.end, breakMinutes: p.breakMinutes }));
  }
  // 幹部が担当していない店舗の集計表のための、前の2か月〜次の月
  function nearMonths() {
    const { month } = A().nowJst();
    const [y, m] = month.split('-').map(Number);
    return [-2, -1, 0, 1].map((n) => {
      const d = new Date(Date.UTC(y, m - 1 + n, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
  }
  // 有給の日（「有給」の印のため）
  function paidDays(storeId) {
    const out = [];
    for (const mo of nearMonths()) for (const [key, sh] of K.calc.shiftMap(mo, storeId)) if (sh && sh.kind === 'paid') out.push(key);
    return out;
  }
  // 確定した月の予定（確定シフトの写しと同じマス。作成中の月は入れない＝幹部は担当店舗の確定シフトしか見られない決まりのまま）
  function confirmedRosters(storeId) {
    const out = [];
    for (const mo of nearMonths()) {
      if (!K.storage.getPublication(storeId, mo) || !K.published) continue;
      try {
        out.push({ month: mo, days: K.published.build(storeId, mo).days.map((d) => ({ date: d.date, cells: d.cells })) });
      } catch (err) {
        console.warn('確定シフトを名簿に入れられませんでした', err && err.message);
      }
    }
    return out;
  }

  let directorySynced = false;
  // iPad に出す名前の一覧（名前と ID だけ）と、集計表用の名簿（11/12〜）を、管理者のデータから作り直す（画面を開いたとき・スタッフを直したとき）
  async function syncDirectories({ force } = {}) {
    if ((directorySynced && !force) || !A().backend() || !A().backend().saveKioskDirectory) return;
    directorySynced = true;
    const now = new Date().toISOString();
    try {
      for (const store of K.storage.getStores()) {
        const list = K.storage.getStaff({ storeId: store.id });
        await A().backend().saveKioskDirectory(store.id, { storeId: store.id, staff: list.map((m) => ({ id: m.id, name: m.name })), updatedAt: now });
      }
    } catch (err) {
      directorySynced = false;
      console.warn('iPad の名前の一覧を更新できませんでした', err && err.message);
      return;
    }
    if (!A().backend().saveAttendanceDirectory) return;
    try {
      for (const store of K.storage.getStores()) {
        await A().backend().saveAttendanceDirectory(store.id, {
          storeId: store.id,
          storeName: store.name,
          order: Number.isFinite(store.order) ? store.order : 0,
          staff: K.storage.getStaff({ storeId: store.id }).map(staffInfo),
          patterns: storePatterns(store.id),
          paid: paidDays(store.id),
          rosters: confirmedRosters(store.id),
          updatedAt: now,
        });
      }
    } catch (err) {
      // ルールをまだ公開していないときなど（iPad の名前の一覧には関係しない）
      console.warn('集計表用の名簿を更新できませんでした', err && err.message);
    }
  }

  function render(container) {
    if (!K.storage.isCloud() || !A().backend()) {
      container.append(el('section', { class: 'card' }, el('h2', { class: 'card__title' }, '勤怠'), el('p', { class: 'hint hint--left' }, '勤怠は共有モード（ログインして使うとき）で使えます。')));
      return;
    }
    syncDirectories();
    const user = K.app.cloudUser();
    const stores = K.storage.getStores();
    const cur = K.app.currentStore();
    const ctx = {
      key: 'owner',
      role: 'owner',
      email: String((user && user.email) || '').toLowerCase(),
      stores,
      showStoreChips: false, // 管理者は画面上の店舗の切り替えを使う
      staffOf: (storeId) => K.storage.getStaff({ storeId }).map(staffInfo),
      patternsOf: storePatterns,
      planSource: async (storeId, month) => adminPlan(storeId, month),
    };
    const st = stateFor('owner', ctx);
    if (cur && st.storeId !== cur.id && stores.some((s) => s.id === cur.id)) {
      st.storeId = cur.id;
      st.editing = null;
    }
    container.append(el('section', { class: 'card att-card' }, panel(ctx)));
  }

  // スタッフ・幹部の「勤怠の番号（PIN）」：4けたを2回入れて決める（2店舗に登録がある人は、両方の記録に同じ番号）
  const pinMsg = {};
  function pinCard(staffIds, email) {
    if (!K.attendance || !A().backend() || !staffIds || !staffIds.length) return null;
    const key = staffIds.join(',');
    const a = el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '4', id: 'pin-new', class: 'field__input pin-input', autocomplete: 'off', placeholder: '4けた' });
    const b = el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '4', id: 'pin-again', class: 'field__input pin-input', autocomplete: 'off', placeholder: 'もう一度' });
    const m = pinMsg[key];
    return el(
      'div',
      { class: 'pin-card' },
      el('p', { class: 'pin-card__title' }, '勤怠の番号（PIN）'),
      el('p', { class: 'hint hint--left' }, 'お店の iPad で出勤・退勤を打つときに使う4けたの番号です。人に教えないでください。決め直すこともできます。'),
      el('div', { class: 'pin-card__row' }, a, b),
      m ? el('p', { class: m.ok ? 'sync__result' : 'form-error', role: 'status' }, m.text) : null,
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--primary btn--block',
          onclick: async () => {
            if (!A().validPin(a.value)) pinMsg[key] = { ok: false, text: '番号は4けたの数字にしてください。' };
            else if (a.value !== b.value) pinMsg[key] = { ok: false, text: '2回入れた番号が違います。' };
            else {
              try {
                for (const id of staffIds) await A().setPin(id, a.value, { email });
                pinMsg[key] = { ok: true, text: '番号を決めました。お店の iPad で使えます。' };
              } catch (err) {
                pinMsg[key] = { ok: false, text: `決められませんでした（${err.message}）` };
              }
            }
            K.app.rerender();
            // 結果が見えるように、アカウントの欄を開いたままにする
            setTimeout(() => {
              const d = document.querySelector('#screen .req-account');
              if (d) d.open = true;
              const c = document.querySelector('#screen .pin-card');
              if (c && c.scrollIntoView) c.scrollIntoView({ block: 'center' });
            }, 0);
          },
        },
        '番号を決める'
      )
    );
  }

  K.attendanceView = { panel, adminPlan, syncDirectories, staffInfo, storePatterns, pinCard, reset: () => { for (const k of Object.keys(states)) delete states[k]; directorySynced = false; } };
  K.screens = K.screens || {};
  K.screens.attendance = { render };
})();
