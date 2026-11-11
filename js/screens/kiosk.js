// 勤怠用 iPad の画面（11/9〜）：勤怠用アカウント（kiosks/{メール}）でログインしたときだけ出る。ほかの画面には移れない
// いちばん上：店舗名・日付と曜日・今の時刻。その下：今日シフトがある人の名前（点の色で今の状態）。いちばん下：今日の休みの人・予定にない人。
// 名前 → 4けたの番号（PIN）→ 出勤・退勤・休憩開始・休憩戻り。打つと、押したボタンの色が広がる演出（約2.7秒）のあと一覧に戻る。
// 番号の確かめは Firestore のルールが行う（この画面は番号を読めない）。閉じる（ログアウト）には、このアカウントのパスワードが必要。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const A = () => K.attendance;

  const REFRESH_MS = 60 * 1000;
  const MAX_TRIES = 5; // 番号を5回まちがえたら、その人は1分待つ
  const LOCK_MS = 60 * 1000;

  let view = null;
  let timer = null;
  let clockTimer = null;

  function reset(params) {
    view = {
      email: params.email,
      storeId: params.kiosk.storeId,
      // 11/11〜 管理者の「タブレット」タブ：同じ画面を見本として動かす（打っても記録しない）
      demo: Boolean(params.demo),
      screen: params.demo ? 'kioskview' : 'kiosk',
      loading: true,
      error: '',
      data: null, // { store, roster, directory, punches }
      sheet: null, // { kind: 'pin'|'act'|'extra'|'exit', staff, code, msg }
      tries: {}, // staffId → { n, until }
      busy: false,
    };
    load();
  }

  // 名前は苗字だけ（11/10 ユーザー）：スペース（半角・全角）の前。同じ苗字の人が並ぶときは、下の名前の1文字目をつける
  function surname(name) {
    const parts = String(name || '').trim().split(/[\s\u3000]+/);
    return parts[0] || String(name || '');
  }
  function shortNames(list) {
    const uniq = [...new Map(list.map((m) => [m.id, m])).values()]; // 同じ人を2回数えない（休み・予定にない人の両方に出る人）
    const count = new Map();
    for (const m of uniq) count.set(surname(m.name), (count.get(surname(m.name)) || 0) + 1);
    const out = new Map();
    for (const m of list) {
      const s = surname(m.name);
      const given = String(m.name || '').trim().split(/[\s\u3000]+/)[1] || '';
      out.set(m.id, count.get(s) > 1 && given ? `${s}（${given[0]}）` : s);
    }
    return out;
  }

  function backend() {
    return K.app.cloudBackend();
  }

  async function load() {
    const v = view;
    if (!v) return;
    try {
      const { date } = A().nowJst();
      const data = await backend().loadKioskData(v.storeId, date);
      v.data = data;
      // 天気（気象庁。読めなくても打刻には関係しない）
      if (K.weather) K.weather.today(date).then((w) => { if (view === v) { v.weather = w; if (!v.sheet && !v.busy && K.app.state.screen === v.screen) K.app.rerender(); } });
      v.date = date;
      v.error = '';
    } catch (err) {
      v.error = `読み込めませんでした（${err.message}）。電波を確かめてください。`;
    }
    v.loading = false;
    if (view === v && !v.sheet && !v.busy && K.app.state.screen === v.screen) K.app.rerender();
  }

  // 1分ごとに読み直す（ほかの iPad・直した分・日付が変わったとき）。何かを入れている途中は読み直さない
  function startTimers() {
    // ログアウトしたら止める
    const alive = () => view && K.app.state.screen === view.screen;
    if (!timer) timer = setInterval(() => (alive() ? !view.sheet && !view.busy && load() : stopTimers()), REFRESH_MS);
    if (!clockTimer)
      clockTimer = setInterval(() => {
        if (!alive()) return stopTimers();
        const c = document.getElementById('kiosk-clock');
        if (c) c.textContent = A().shortTime(A().nowJst().time);
      }, 1000);
  }

  function stopTimers() {
    clearInterval(timer);
    clearInterval(clockTimer);
    timer = null;
    clockTimer = null;
  }

  // 今日の名前：確定シフトの写しの今日のマス。写しがなければ、名前の一覧（予定なし）
  function people() {
    const d = view.data || {};
    const date = view.date;
    const punches = d.punches || [];
    const mine = (id) => punches.filter((p) => p.staffId === id);
    const dir = (d.directory && d.directory.staff) || [];
    const roster = d.roster;
    const day = roster && (roster.days || []).find((x) => x.date === date);
    const working = [];
    const off = [];
    const seen = new Set();
    if (roster && day) {
      for (const m of roster.staff || []) {
        const plan = A().planFromCell((day.cells || {})[m.id]);
        if (!plan) continue;
        if (plan.kind === 'work' || plan.kind === 'business') {
          working.push({ id: m.id, name: m.name, plan, punches: mine(m.id) });
          seen.add(m.id);
        } else if (plan.kind === 'off') off.push({ id: m.id, name: m.name });
      }
    }
    // 予定にない人で、今日すでに打っている人も出す（休みの日の急な出勤など）
    for (const m of dir) {
      if (!seen.has(m.id) && mine(m.id).length) {
        working.push({ id: m.id, name: m.name, plan: null, punches: mine(m.id), extra: true });
        seen.add(m.id);
      }
    }
    const extras = dir.filter((m) => !seen.has(m.id));
    const offList = off.filter((m) => !seen.has(m.id));
    const short = shortNames([...working, ...offList, ...extras]);
    const named = (m) => ({ ...m, name: short.get(m.id) || surname(m.name) });
    return { working: working.map(named), off: offList.map(named), extras: extras.map(named), hasRoster: Boolean(roster && day) };
  }

  function stateText(p, state) {
    const pun = p.punches.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const last = pun[pun.length - 1];
    const t = last ? A().shortTime(A().timeOf(last.at)) : '';
    if (state === 'in') return `出勤中 ${A().shortTime(A().timeOf((pun.find((x) => x.type === 'in') || last).at))}〜`;
    if (state === 'br') return `休憩中 ${t}〜`;
    if (state === 'out') return `退勤 ${t}`;
    if (p.plan && p.plan.start) return A().isLate(p.plan, state) ? `${A().shortTime(p.plan.start)} 予定・未出勤` : `${A().shortTime(p.plan.start)} から`;
    return p.extra ? '予定外' : '';
  }

  function openSheet(sheet) {
    view.sheet = sheet;
    K.app.rerender();
  }
  function closeSheet() {
    view.sheet = null;
    K.app.rerender();
  }

  function pick(p) {
    const t = view.tries[p.id];
    if (t && t.until > Date.now()) {
      openSheet({ kind: 'msg', staff: p, msg: `番号を${MAX_TRIES}回まちがえたので、1分たってからもう一度押してください。` });
      return;
    }
    openSheet({ kind: 'pin', staff: p, code: '', msg: '' });
  }

  async function onDigit(k) {
    const s = view.sheet;
    if (!s || s.kind !== 'pin') return;
    if (k === 'del') s.code = s.code.slice(0, -1);
    else if (s.code.length < 4) s.code += k;
    s.msg = '';
    if (s.code.length === 4) {
      // 番号は、打つときにルールが確かめる。ここではボタンの画面へ進む
      view.sheet = { kind: 'act', staff: s.staff, code: s.code, msg: '' };
    }
    K.app.rerender();
  }

  // 押しまちがい対策の確かめ（11/10〜）
  const CONFIRM = { in: '出勤しますか？', out: '退勤しますか？', bs: '休憩に入りますか？', be: '休憩から戻りますか？' };
  function askConfirm(type) {
    const s = view.sheet;
    if (!s || s.kind !== 'act' || view.busy) return;
    view.sheet = { kind: 'confirm', staff: s.staff, code: s.code, type, msg: '' };
    K.app.rerender();
  }

  async function onAct(type, btn) {
    const s = view.sheet;
    if (!s || view.busy) return;
    view.busy = true;
    const rect = btn.getBoundingClientRect();
    try {
      // 見本（管理者の「タブレット」タブ）は記録しない。この画面の中だけで打った形にする
      const rec = view.demo
        ? { id: `demo_${Date.now()}`, staffId: s.staff.id, storeId: view.storeId, type, at: A().now().toISOString(), atMs: A().now().getTime(), demo: true }
        : await A().punch({ staffId: s.staff.id, storeId: view.storeId, type, pin: s.code, email: view.email, current: s.staff.punches });
      view.tries[s.staff.id] = { n: 0, until: 0 };
      (view.data.punches = view.data.punches || []).push(rec);
      view.sheet = null;
      reveal(type, rect, s.staff.name, rec);
    } catch (err) {
      view.busy = false;
      if (err.code === 'bad-pin') {
        const t = (view.tries[s.staff.id] = view.tries[s.staff.id] || { n: 0, until: 0 });
        t.n += 1;
        if (t.n >= MAX_TRIES) {
          t.until = Date.now() + LOCK_MS;
          t.n = 0;
          view.sheet = { kind: 'msg', staff: s.staff, msg: `番号を${MAX_TRIES}回まちがえたので、1分たってからもう一度押してください。` };
        } else view.sheet = { kind: 'pin', staff: s.staff, code: '', msg: err.message };
      } else view.sheet = { kind: 'act', staff: s.staff, code: s.code, msg: err.message };
      K.app.rerender();
    }
  }

  // 打ったあとの演出：押したボタンの位置から、その色が画面いっぱいに広がる → 線のアイコン・ひとこと・時刻 → 一覧へ
  const REVEAL = {
    in: { cls: 'v-in', word: 'おはようございます', sub: '今日もよろしくお願いします', icon: '<circle class="d" style="--l:190" cx="75" cy="75" r="30"/><g class="spin"><path class="d d2" style="--l:20" d="M75 18v14M75 118v14M18 75h14M118 75h14M35 35l10 10M105 105l10 10M35 115l10-10M105 45l10-10"/></g>' },
    bs: { cls: 'v-bs', word: 'ゆっくり休んでください', sub: '休憩を始めました', icon: '<path class="d" style="--l:260" d="M38 70h62v22a28 28 0 0 1-28 28h-6a28 28 0 0 1-28-28z"/><path class="d d2" style="--l:70" d="M100 78h8a12 12 0 0 1 0 24h-10"/><g class="steam"><path class="d" style="--l:30" d="M58 56c-6-8 6-12 0-22"/><path class="d" style="--l:30" d="M74 56c-6-8 6-12 0-22"/><path class="d" style="--l:30" d="M90 56c-6-8 6-12 0-22"/></g>' },
    be: { cls: 'v-be', word: 'おかえりなさい', sub: '後半もよろしくお願いします', icon: '<path class="d" style="--l:330" d="M120 75a45 45 0 1 1-13-32"/><path class="d d2" style="--l:50" d="M110 22v22H88"/><path class="d d2" style="--l:60" d="M58 76l12 12 24-26"/>' },
    out: { cls: 'v-out', word: 'おつかれさまでした', sub: '', icon: '<path class="d" style="--l:300" d="M95 30a48 48 0 1 0 28 72A40 40 0 0 1 95 30z"/><path class="d d2" style="--l:40" d="M40 40v14M33 47h14M118 120v10M113 125h10"/>' },
  };

  function reveal(type, rect, name, rec) {
    const r = REVEAL[type];
    const root = document.querySelector('.kiosk');
    const box = root ? root.getBoundingClientRect() : { left: 0, top: 0 };
    let sub = r.sub;
    if (type === 'out') {
      const mine = view.data.punches.filter((p) => p.staffId === rec.staffId);
      const d = A().dayOf(mine, null);
      sub = d.workMin != null ? `今日の勤務 ${A().hm(d.workMin).replace(':', '時間')}分（休憩 ${d.breakMin}分）` : '退勤しました';
    }
    const time = A().shortTime(A().timeOf(rec.at));
    const layer = el('div', { class: `kiosk-reveal ${r.cls}`, role: 'status', 'aria-live': 'assertive', style: { '--x': `${rect.left + rect.width / 2 - box.left}px`, '--y': `${rect.top + rect.height / 2 - box.top}px` } });
    layer.innerHTML =
      `<div class="kr-who"></div><i class="kr-ring"></i><i class="kr-ring kr-r2"></i>` +
      `<div class="kr-ico"><svg viewBox="0 0 150 150" aria-hidden="true">${r.icon}</svg></div>` +
      `<div class="kr-word">${[...r.word].map((c, i) => `<span style="animation-delay:${0.45 + i * 0.045}s">${c}</span>`).join('')}</div>` +
      `<div class="kr-time">${[...time].map((c, i) => `<span style="animation-delay:${0.55 + i * 0.06}s">${c}</span>`).join('')}</div>` +
      `<div class="kr-line"></div><div class="kr-sub"></div><i class="kr-bar"></i>`;
    layer.querySelector('.kr-who').textContent = `${name} さん`;
    layer.querySelector('.kr-sub').textContent = sub;
    (root || document.body).append(layer);
    requestAnimationFrame(() => layer.classList.add('on'));
    setTimeout(() => {
      layer.classList.add('off');
      view.busy = false;
      K.app.rerender();
      const again = document.querySelector('.kiosk');
      if (again) again.append(layer);
    }, 2700);
    setTimeout(() => layer.remove(), 3200);
  }

  // 押したところから光の波紋
  function ripple(e) {
    const t = e.target.closest('.kiosk-nm, .kiosk-key, .kiosk-act:not(:disabled), .kiosk-ghost');
    if (!t) return;
    const r = t.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const s = el('i', { class: 'kiosk-ripple', style: { width: `${d}px`, height: `${d}px`, left: `${e.clientX - r.left - d / 2}px`, top: `${e.clientY - r.top - d / 2}px` } });
    t.append(s);
    setTimeout(() => s.remove(), 600);
  }

  // 午前・午後の天気（気象庁の予報。苫小牧＝胆振地方。気温は室蘭の最低・最高）。11/10〜 見出しは AM・PM（画面の右端）
  // 天気の絵（11/10〜 案3：黒い細い線＋ワンポイントの色。晴れ・くもり・雨・雪・晴れ時々くもり・雷）
  const WX_CLOUD = 'M20 48H45a10 10 0 0 0 1-20 14 14 0 0 0-26.5-2A11 11 0 0 0 20 48z';
  function wxRays(cx, cy, r1, r2) {
    return Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      return `M${(cx + Math.cos(a) * r1).toFixed(1)} ${(cy + Math.sin(a) * r1).toFixed(1)}L${(cx + Math.cos(a) * r2).toFixed(1)} ${(cy + Math.sin(a) * r2).toFixed(1)}`;
    }).join('');
  }
  function wxSvg(kind) {
    const sun = (x, y, r) => `<path d="${wxRays(x, y, r + 5, r + 9)}" stroke="#222" stroke-width="2.4" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="${r}" fill="#ffd25e" stroke="#222" stroke-width="2.4"/>`;
    const cloud = (t) => `<path transform="${t}" d="${WX_CLOUD}" fill="#fff" stroke="#222" stroke-width="2.4" stroke-linejoin="round"/>`;
    const up = cloud('translate(0,-10)');
    const body = {
      sun: sun(32, 32, 13),
      cloud: cloud('translate(0,-4)'),
      rain: up + [22, 32, 42].map((x, i) => `<path d="M${x} ${50 + (i % 2) * 3}q-3 5 0 7q3-2 0-7z" fill="#3d8bfd" stroke="#3d8bfd" stroke-linejoin="round"/>`).join(''),
      snow: up + [22, 32, 42].map((x, i) => { const y = 52 + (i % 2) * 3; return `<path d="M${x} ${y}v6M${x - 3} ${y + 3}h6M${x - 2.2} ${y + 0.8}l4.4 4.4M${x + 2.2} ${y + 0.8}l-4.4 4.4" stroke="#3d8bfd" stroke-width="2" stroke-linecap="round"/>`; }).join(''),
      thunder: up + '<path d="M35 44l-9 12h7l-4 10 12-15h-7l4-7z" fill="#ffd25e" stroke="#222" stroke-width="2" stroke-linejoin="round"/>',
      suncloud: sun(22, 22, 10) + cloud('translate(7,4) scale(.9)'),
    }[kind];
    return body ? `<svg viewBox="0 0 64 68" aria-hidden="true" focusable="false">${body}</svg>` : '';
  }

  function weatherView() {
    const w = view.weather;
    if (!w) return null;
    const box = (label, x, temp) =>
      el('div', { class: 'kiosk-wx__box', 'aria-label': `${label} ${x.text}${x.pop != null ? ` 降水 ${x.pop}%` : ''}` },
        el('b', null, label),
        (() => {
          const ic = el('span', { class: 'kiosk-wx__icon', 'aria-hidden': 'true' });
          const svg = wxSvg(x.kind);
          if (svg) ic.innerHTML = svg; // 決まった形の絵だけ（外から来た文字は入れない）
          else ic.textContent = x.icon || '・';
          return ic;
        })(),
        temp != null ? el('em', null, `${temp}°`) : null,
        el('i', null, `${x.text}${x.pop != null ? `・降水 ${x.pop}%` : ''}`));
    return el('div', { class: 'kiosk-wx', title: `${w.place}の天気（気象庁）：${w.text}。気温は${w.tempPlace}` }, box('AM', w.am, w.min), box('PM', w.pm, w.max));
  }

  function header() {
    const { date, time } = A().nowJst();
    const store = (view.data && view.data.store) || {};
    return el(
      'div',
      { class: 'kiosk-top' },
      // 11/10〜 左に店舗名と日付・真ん中に大きな時計・右端に天気
      el('div', { class: 'kiosk-when' }, el('p', { class: 'kiosk-store' }, store.name || ''), el('p', { class: 'kiosk-date' }, `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`, el('small', null, `（${U.WEEKDAYS[K.calc.weekdayOf(date)]}）`))),
      el('p', { class: 'kiosk-clock', id: 'kiosk-clock' }, A().shortTime(time)),
      weatherView() || el('div', { class: 'kiosk-wx-none', 'aria-hidden': 'true' })
    );
  }

  function list() {
    const ps = people();
    const cards = ps.working.map((p) => {
      const state = A().stateOf(p.punches);
      const late = A().isLate(p.plan, state);
      return el(
        'button',
        { type: 'button', class: `kiosk-nm is-${late ? 'late' : state}`, onclick: () => pick(p), 'aria-label': `${p.name}　${stateText(p, state)}` },
        el('i', { class: 'kiosk-dot', 'aria-hidden': 'true' }),
        el('b', null, p.name),
        el('small', null, stateText(p, state))
      );
    });
    return [
      el(
        'div',
        { class: 'kiosk-label' },
        el('h2', null, ps.hasRoster ? '今日のスタッフ' : '今日のスタッフ（確定シフトがまだありません）'),
        el('div', { class: 'kiosk-legend' }, [['in', '出勤中'], ['br', '休憩中'], ['late', '10分すぎ'], ['out', '退勤']].map(([k, t]) => el('span', null, el('i', { class: `kiosk-dot is-${k}` }), t)))
      ),
      cards.length ? el('div', { class: 'kiosk-names' }, cards) : el('p', { class: 'kiosk-empty' }, ps.hasRoster ? '今日シフトがある人はいません。' : '「予定にない人」から名前を選んでください。'),
      el(
        'div',
        { class: 'kiosk-foot' },
        el('p', { class: 'kiosk-off' }, ps.off.length ? [el('b', null, '今日の休み'), ps.off.map((m) => m.name).join('・')] : ''),
        ps.extras.length ? el('button', { type: 'button', class: 'kiosk-ghost', onclick: () => openSheet({ kind: 'extra' }) }, '予定にない人') : null,
        view.demo ? null : el('button', { type: 'button', class: 'kiosk-ghost kiosk-exit', onclick: () => openSheet({ kind: 'exit', msg: '' }) }, '管理者')
      ),
    ];
  }

  function sheetView() {
    const s = view.sheet;
    if (!s) return null;
    let panel;
    if (s.kind === 'pin') {
      panel = [
        el('h3', null, `${s.staff.name} さん`),
        el('p', null, '4けたの番号を入れてください'),
        el('div', { class: 'kiosk-pins', 'aria-label': `${s.code.length}けた入力済み` }, [0, 1, 2, 3].map((i) => el('i', { class: i < s.code.length ? 'is-f' : '' }))),
        s.msg ? el('p', { class: 'kiosk-err', role: 'alert' }, s.msg) : null,
        el(
          'div',
          { class: 'kiosk-keys' },
          ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) =>
            k === '' ? el('span') : el('button', { type: 'button', class: `kiosk-key${k === 'del' ? ' is-sm' : ''}`, 'aria-label': k === 'del' ? '1つ消す' : k, onclick: () => onDigit(k) }, k === 'del' ? '消す' : k)
          )
        ),
      ];
    } else if (s.kind === 'act') {
      const state = A().stateOf(s.staff.punches);
      const ok = A().NEXT[state];
      panel = [
        el('h3', null, `${s.staff.name} さん`),
        el('p', null, `いま：${A().STATE_LABELS[state]}${s.staff.plan ? '' : '（今日は予定にありません）'}`),
        s.msg ? el('p', { class: 'kiosk-err', role: 'alert' }, s.msg) : null,
        el(
          'div',
          { class: 'kiosk-acts' },
          [['in', '出勤'], ['out', '退勤'], ['bs', '休憩開始'], ['be', '休憩戻り']].map(([k, t]) =>
            el('button', { type: 'button', class: `kiosk-act a-${k}`, disabled: !ok.includes(k) || view.busy, onclick: () => askConfirm(k) }, t)
          )
        ),
      ];
    } else if (s.kind === 'confirm') {
      // 11/10〜 押しまちがい対策：「出勤しますか？」→ はい／いいえ
      panel = [
        el('h3', null, `${s.staff.name} さん`),
        el('p', { class: `kiosk-ask is-${s.type}` }, CONFIRM[s.type]),
        el('p', null, `いまの時刻 ${A().shortTime(A().nowJst().time)}`),
        s.msg ? el('p', { class: 'kiosk-err', role: 'alert' }, s.msg) : null,
        el(
          'div',
          { class: 'kiosk-yesno' },
          el('button', { type: 'button', class: 'kiosk-act kiosk-no', disabled: view.busy, onclick: () => { view.sheet = { kind: 'act', staff: s.staff, code: s.code, msg: '' }; K.app.rerender(); } }, 'いいえ'),
          el('button', { type: 'button', class: `kiosk-act kiosk-yes a-${s.type}`, disabled: view.busy, onclick: (e) => onAct(s.type, e.currentTarget) }, 'はい')
        ),
      ];
    } else if (s.kind === 'extra') {
      panel = [
        el('h3', null, '予定にない人'),
        el('p', null, '今日シフトがない人です。名前を押してください（管理者・幹部の画面に「予定外」と出ます）'),
        el('div', { class: 'kiosk-names kiosk-names--extra' }, people().extras.map((m) => el('button', { type: 'button', class: 'kiosk-nm is-wait', onclick: () => pick({ id: m.id, name: m.name, plan: null, punches: [], extra: true }) }, el('b', null, m.name)))),
      ];
    } else if (s.kind === 'exit') {
      const input = el('input', { type: 'password', class: 'kiosk-input', id: 'kiosk-pass', autocomplete: 'current-password', placeholder: 'この iPad のアカウントのパスワード' });
      panel = [
        el('h3', null, '勤怠の画面を閉じる（管理者）'),
        el('p', null, 'ログアウトします。この iPad のアカウントのパスワードを入れてください。'),
        input,
        s.msg ? el('p', { class: 'kiosk-err', role: 'alert' }, s.msg) : null,
        el(
          'button',
          {
            type: 'button',
            class: 'kiosk-act a-out kiosk-act--wide',
            onclick: async () => {
              const ok = input.value && (await backend().verifyPassword(input.value));
              if (!ok) {
                view.sheet = { kind: 'exit', msg: 'パスワードが違います。' };
                K.app.rerender();
                return;
              }
              stopTimers();
              view = null;
              await K.app.cloudActions.signOut();
            },
          },
          'ログアウト'
        ),
      ];
    } else {
      panel = [el('h3', null, s.staff ? `${s.staff.name} さん` : ''), el('p', { class: 'kiosk-err' }, s.msg)];
    }
    return el('div', { class: 'kiosk-sheet', role: 'dialog', 'aria-modal': 'true' }, el('div', { class: 'kiosk-panel' }, ...panel.filter(Boolean), el('button', { type: 'button', class: 'kiosk-ghost kiosk-cancel', onclick: closeSheet }, 'やめる')));
  }

  function render(container, params) {
    if (!view || view.email !== params.email || view.storeId !== params.kiosk.storeId || view.demo !== Boolean(params.demo)) reset(params);
    startTimers();
    const root = el('div', { class: 'kiosk', onpointerdown: ripple });
    if (view.loading) root.append(header(), el('p', { class: 'kiosk-empty' }, '読み込んでいます…'));
    else if (view.error) root.append(header(), el('p', { class: 'kiosk-empty kiosk-err' }, view.error), el('button', { type: 'button', class: 'kiosk-ghost', onclick: () => { view.loading = true; K.app.rerender(); load(); } }, 'もう一度読み込む'));
    else root.append(header(), ...list(), sheetView() || '');
    container.append(root);
  }

  // ---- 管理者の「タブレット」タブ（11/11〜）：お店のタブレットと同じ画面を、見本として見る（本番の記録は書かない） ----
  // スマホを横向きにしたときは、画面の幅を iPad の横向きと同じ 1180 にして、iPad と同じ並び・字の大きさの割合で見せる
  const TABLET_WIDTH = 1180;
  let baseViewport = null;
  let watching = false;

  // 横向きかどうか：今の画面の幅と高さで決める（幅を 1180 にしたあとも、縦に戻すと高さのほうが大きくなる）
  function landscape() {
    return window.innerWidth > window.innerHeight;
  }

  function isPhone() {
    return window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600;
  }

  // 画面に入る・出るとき（app.js の render から毎回）と、向きを変えたときに呼ぶ
  function syncView(on) {
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && baseViewport === null) baseViewport = meta.getAttribute('content');
    const full = Boolean(on && isPhone() && landscape());
    const want = full ? `width=${TABLET_WIDTH}, viewport-fit=cover` : baseViewport;
    if (meta && meta.getAttribute('content') !== want) meta.setAttribute('content', want);
    document.body.classList.toggle('is-kv', Boolean(on));
    document.body.classList.toggle('is-kv-full', full);
    if (on && !watching) {
      watching = true;
      const again = () => syncView(K.app.state.screen === 'kioskview');
      window.addEventListener('orientationchange', () => setTimeout(again, 120));
      window.addEventListener('resize', again);
    }
  }

  function renderView(container) {
    const backendOk = K.storage.isCloud() && K.app.cloudBackend() && K.app.cloudBackend().loadKioskData;
    if (!backendOk) {
      container.append(el('section', { class: 'card' }, el('h2', { class: 'card__title' }, 'タブレットの画面'), el('p', { class: 'hint hint--left' }, '共有モード（ログインして使うとき）で、お店のタブレットと同じ打刻の画面を見られます。')));
      return;
    }
    const store = K.app.currentStore();
    const u = K.app.cloudUser();
    container.append(
      el(
        'div',
        { class: 'kv-bar', role: 'note' },
        el('span', { class: 'kv-badge' }, '見本'),
        el('span', { class: 'kv-text' }, `${store.name}のタブレットと同じ画面です。押しても記録されません。`),
        el('span', { class: 'kv-rotate' }, 'スマホを横向きにすると、iPad と同じ画面で見られます'),
        el('span', { class: 'kv-back' }, '縦向きに戻すと、管理者の画面に戻ります')
      )
    );
    render(container, { email: `demo:${(u && u.email) || ''}`, kiosk: { storeId: store.id }, demo: true });
  }

  K.screens = K.screens || {};
  K.screens.kioskview = { render: renderView, sync: syncView, reset: () => { stopTimers(); view = null; } };
  K.screens.kiosk = { render, reset: () => { stopTimers(); view = null; }, shortNames, surname };
})();
