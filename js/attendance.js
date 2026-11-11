// 勤怠（共有モードだけで使う。11/9〜）
// 店舗の iPad（勤怠用アカウント）で、スタッフが「名前 → 4けたの番号（PIN）→ 出勤・退勤・休憩開始・休憩戻り」を打つ。
// 管理者と幹部（担当店舗だけ）が、今日の様子・月の表を見て、時刻を直せる（理由は必須・修正の記録を残す）。
// 毎月最終日の20時（日本時間）に締める。締めたあとの修正は管理者だけ。集計表はパスワードで開き、PDF（印刷）・Excel で出力できる。
//
// 記録の形（Firestore）：
//   kiosks/{メール}              { storeId, deleted, createdAt, createdBy }  勤務用 iPad のアカウント（管理者がアプリで登録）
//   kioskDirectory/{店舗ID}      { storeId, staff: [{ id, name }], updatedAt }  iPad に出す名前の一覧（メールなどは入れない。管理者のアプリが作る）
//   attendancePins/{スタッフID}  { staffId, hash, updatedAt, updatedBy }  番号（PIN）は元に戻せない形（SHA-256）だけ
//   punches/{スタッフID_日付_ミリ秒} { staffId, storeId, date, month, type（in/out/bs/be）, at, atMs, by, source }  打刻（追加するだけ）
//   punchProofs/{打刻と同じID}   { staffId, hash }  番号の確かめ用（ルールが PIN と比べる。誰も読めない）
//   punchEdits/{スタッフID_日付}  { staffId, storeId, date, month, in, out, breaks, reason, by, role, at, logId }  直した1日分（打刻より優先）
//   attendanceLogs/{…}           修正の記録（追加するだけ）
//   settings/attendance          { summaryHash（集計表のパスワード）, updatedAt, updatedBy }
// 読み書きの決まりは Firestore のルールでも強制している。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const TYPES = { in: '出勤', out: '退勤', bs: '休憩開始', be: '休憩戻り' };
  const NEXT = { wait: ['in'], in: ['bs', 'out'], br: ['be'], out: [] };
  const STATE_LABELS = { wait: '出勤前', in: '出勤中', br: '休憩中', out: '退勤済み' };
  const CLOSE_HOUR = 20; // 毎月最終日の20時（日本時間）に締める
  const LATE_MIN = 10; // 予定から10分すぎても出勤していなければ「未出勤」
  const MAX_REASON = 50;
  const JST = 9 * 60 * 60 * 1000;

  let backend = null;
  let clock = () => new Date();
  let summaryUnlocked = false; // 集計表のパスワードを、この画面を開いている間だけ覚える

  function attach(b) {
    backend = b;
  }
  function setClock(fn) {
    clock = fn || (() => new Date());
  }
  function requireBackend() {
    if (!backend) throw new Error('共有モードでログインしてから使ってください。');
    return backend;
  }

  const pad = (n) => String(n).padStart(2, '0');

  // 日本時間の「今」：{ date: '2026-12-03', month: '2026-12', time: '09:52', min: 592 }
  function nowJst(d = clock()) {
    const t = new Date(d.getTime() + JST);
    const date = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    return { date, month: date.slice(0, 7), time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`, min: t.getUTCHours() * 60 + t.getUTCMinutes() };
  }

  // ISO の日時 → 日本時間の「09:05」
  function timeOf(iso) {
    if (!iso) return '';
    const t = new Date(new Date(iso).getTime() + JST);
    return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  }

  // 「09:05」→ 545（分）。空・おかしな値は null
  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  }

  // 分 → 「8:05」（勤務時間などの長さ）
  function hm(min) {
    if (min == null) return '—';
    const sign = min < 0 ? '-' : '';
    const a = Math.abs(min);
    return `${sign}${Math.floor(a / 60)}:${pad(a % 60)}`;
  }

  // 「09:05」→「9:05」
  function shortTime(hhmm) {
    return hhmm ? hhmm.replace(/^0(\d)/, '$1') : '';
  }

  // その月の締め：最終日の20時（日本時間）＝ 翌月1日0時（UTC）の13時間前
  function closeAt(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 1) - (24 - CLOSE_HOUR + 9) * 60 * 60 * 1000);
  }
  function isClosed(month, d = clock()) {
    return d.getTime() >= closeAt(month).getTime();
  }

  // 締めのお知らせ：締めてから7日の間だけ（締めた月）
  function closedNotice(d = clock()) {
    const { month } = nowJst(d);
    const [y, m] = month.split('-').map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
    for (const mo of [month, prev]) {
      const c = closeAt(mo).getTime();
      if (d.getTime() >= c && d.getTime() < c + 7 * 24 * 60 * 60 * 1000) return { month: mo, at: closeAt(mo) };
    }
    return null;
  }

  // ---- 1日分の計算 ----

  // 打刻（その人・その日の分）から、今の状態：wait（出勤前）/ in（出勤中）/ br（休憩中）/ out（退勤済み）
  function stateOf(punches) {
    const sorted = (punches || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const last = sorted[sorted.length - 1];
    if (!last) return 'wait';
    return { in: 'in', be: 'in', bs: 'br', out: 'out' }[last.type] || 'wait';
  }

  // 1日分の出勤・退勤・休憩（直したものがあれば、そちらを使う）
  // 戻り値：{ in, out, breaks: [{ s, e }], openBreak, edited, breakMin, workMin, short, missingOut }
  function dayOf(punches, edit, { today, date } = {}) {
    let inT = '';
    let outT = '';
    let breaks = [];
    let openBreak = '';
    let edited = false;
    if (edit) {
      inT = edit.in || '';
      outT = edit.out || '';
      breaks = (edit.breaks || []).filter((b) => b && b.s && b.e);
      edited = true;
    } else {
      const sorted = (punches || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
      for (const p of sorted) {
        const t = timeOf(p.at);
        if (p.type === 'in' && !inT) inT = t;
        else if (p.type === 'out') outT = t;
        else if (p.type === 'bs') openBreak = t;
        else if (p.type === 'be' && openBreak) {
          breaks.push({ s: openBreak, e: t });
          openBreak = '';
        }
      }
    }
    const breakMin = breaks.reduce((sum, b) => sum + Math.max(0, (toMin(b.e) || 0) - (toMin(b.s) || 0)), 0);
    const a = toMin(inT);
    const z = toMin(outT);
    const workMin = a != null && z != null && z > a ? z - a - breakMin : null;
    // 休憩の決まり：6時間をこえる日は45分以上、8時間をこえる日は60分以上
    const short = workMin != null && ((workMin > 480 && breakMin < 60) || (workMin > 360 && breakMin < 45));
    const missingOut = Boolean(inT) && !outT && Boolean(today && date && date < today);
    return { in: inT, out: outT, breaks, openBreak, edited, breakMin, workMin, short, missingOut };
  }

  // 予定から10分すぎても出勤していないか（予定：{ kind: 'work', start: '09:00' }）
  function isLate(plan, state, now = nowJst()) {
    if (!plan || plan.kind !== 'work' || state !== 'wait') return false;
    const s = toMin(plan.start);
    return s != null && now.min >= s + LATE_MIN;
  }

  // 公開用の写しのマス（{ k, t: '9:00〜18:00' }）→ 予定 { kind, t, start, end }
  function planFromCell(cell) {
    if (!cell) return null;
    if (cell.k === 'work' || cell.k === 'business') {
      const m = /^(\d{1,2}:\d{2})〜(\d{1,2}:\d{2})$/.exec(cell.t || '');
      return { kind: cell.k, t: cell.t || '', start: m ? m[1].padStart(5, '0') : '', end: m ? m[2].padStart(5, '0') : '' };
    }
    if (cell.k === 'off') return { kind: 'off', t: '休み' };
    if (cell.k === 'closed') return { kind: 'closed', t: cell.t || '定休' };
    return null;
  }

  function planLabel(plan) {
    if (!plan) return '—';
    if (plan.kind === 'work') return `${shortTime(plan.start)}-${shortTime(plan.end).replace(/:00$/, '')}`.replace(/:00-/, '-');
    if (plan.kind === 'business') return '社用';
    if (plan.kind === 'paid') return '有給';
    if (plan.kind === 'closed') return '定休';
    return '休み';
  }

  // ---- 集計 ----

  // 1人分の月の集計
  function summarize(days) {
    const r = { workDays: 0, workMin: 0, breakMin: 0, shortDays: 0, missingOut: 0, edited: 0, paidDays: 0 };
    for (const d of days) {
      if (d.plan && d.plan.kind === 'paid') r.paidDays += 1;
      if (d.in) r.workDays += 1;
      if (d.workMin != null) r.workMin += d.workMin;
      r.breakMin += d.breakMin || 0;
      if (d.short) r.shortDays += 1;
      if (d.missingOut) r.missingOut += 1;
      if (d.edited) r.edited += 1;
    }
    return r;
  }

  // 店舗・月の表：staff（[{ id, name }]）・planOf(staffId, date)・データ（打刻・直したもの）から、1人ずつ日ごとの行と集計を作る
  function monthTable({ month, staff, planOf, punches, edits }) {
    const today = nowJst().date;
    const byKey = new Map();
    for (const p of punches || []) {
      const k = `${p.staffId}|${p.date}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(p);
    }
    const editOf = new Map((edits || []).map((e) => [`${e.staffId}|${e.date}`, e]));
    return staff.map((m) => {
      const days = K.calc.monthDates(month).map((date) => {
        const edit = editOf.get(`${m.id}|${date}`) || null;
        const d = dayOf(byKey.get(`${m.id}|${date}`), edit, { today, date });
        return { date, plan: planOf ? planOf(m.id, date) : null, ...d };
      });
      return { staff: m, days, total: summarize(days) };
    });
  }

  // ---- 番号（PIN）・パスワード ----

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function pinHash(staffId, pin) {
    return sha256(`shift-pin:${staffId}:${pin}`);
  }
  function summaryHash(password) {
    return sha256(`shift-sum:${password}`);
  }
  function validPin(pin) {
    return /^\d{4}$/.test(String(pin || ''));
  }

  // スタッフ本人・管理者：番号を決める
  async function setPin(staffId, pin, { email }) {
    if (!validPin(pin)) throw new Error('番号は4けたの数字にしてください。');
    const hash = await pinHash(staffId, pin);
    await requireBackend().setAttendancePin({ staffId, hash, updatedAt: clock().toISOString(), updatedBy: String(email || '').toLowerCase() });
  }

  // ---- 打刻（店舗の iPad） ----

  function punchId(staffId, date, d = clock()) {
    return `${staffId}_${date}_${d.getTime()}`;
  }

  // 打つ：番号の確かめは Firestore のルールが行う（番号が違えば保存されない）
  async function punch({ staffId, storeId, type, pin, email, current }) {
    if (!TYPES[type]) throw new Error('打刻の種類が正しくありません。');
    if (!validPin(pin)) throw new Error('番号は4けたの数字です。');
    const d = clock();
    const { date, month } = nowJst(d);
    if (isClosed(month, d)) throw new Error(`${Number(month.slice(5))}月の勤怠は締めました。管理者に伝えてください。`);
    const state = stateOf(current);
    if (!NEXT[state].includes(type)) throw new Error(`今は「${STATE_LABELS[state]}」なので、${TYPES[type]}は押せません。`);
    const id = punchId(staffId, date, d);
    const data = { staffId, storeId, date, month, type, at: d.toISOString(), atMs: d.getTime(), by: String(email || '').toLowerCase(), source: 'kiosk' };
    const hash = await pinHash(staffId, pin);
    try {
      await requireBackend().addPunch({ id, data, proof: { staffId, hash } });
    } catch (err) {
      if (err && err.code === 'permission-denied') {
        const e = new Error('番号が違います。もう一度入れてください。');
        e.code = 'bad-pin';
        throw e;
      }
      throw err;
    }
    return { id, ...data };
  }

  // ---- 直す（管理者・幹部） ----

  function editId(staffId, date) {
    return `${staffId}_${date}`;
  }

  function checkEdit({ in: inT, out, breaks, reason }) {
    const r = String(reason || '').trim();
    if (!r) return '直す理由を入れてください。';
    if (r.length > MAX_REASON) return `理由は${MAX_REASON}文字以内にしてください。`;
    for (const t of [inT, out]) if (t && toMin(t) == null) return '時刻の形が正しくありません。';
    if (out && !inT) return '退勤だけは入れられません。出勤も入れてください。';
    if (inT && out && toMin(out) <= toMin(inT)) return '退勤は出勤より後の時刻にしてください。';
    for (const b of breaks || []) {
      if (!b.s && !b.e) continue;
      if (toMin(b.s) == null || toMin(b.e) == null) return '休憩は、開始と戻りの両方を入れてください。';
      if (toMin(b.e) <= toMin(b.s)) return '休憩の戻りは、開始より後の時刻にしてください。';
      if (inT && toMin(b.s) < toMin(inT)) return '休憩は出勤のあとにしてください。';
      if (out && toMin(b.e) > toMin(out)) return '休憩は退勤の前にしてください。';
    }
    return null;
  }

  async function saveEdit({ staffId, storeId, date, in: inT, out, breaks, reason, email, role, before }) {
    const month = date.slice(0, 7);
    const err = checkEdit({ in: inT, out, breaks, reason });
    if (err) throw new Error(err);
    if (role !== 'owner' && isClosed(month)) throw new Error(`${Number(month.slice(5))}月の勤怠は締めました。直せるのは管理者だけです。`);
    const now = clock().toISOString();
    const by = String(email || '').toLowerCase();
    const id = editId(staffId, date);
    const logId = `att_${id}_${now}`;
    const cleanBreaks = (breaks || []).filter((b) => b && b.s && b.e).map((b) => ({ s: b.s, e: b.e }));
    const data = { staffId, storeId, date, month, in: inT || '', out: out || '', breaks: cleanBreaks, reason: String(reason).trim(), by, role, at: now, logId };
    const log = {
      targetId: id,
      staffId,
      storeId,
      date,
      month,
      from: before ? { in: before.in || '', out: before.out || '', breaks: (before.breaks || []).map((b) => ({ s: b.s, e: b.e })) } : null,
      to: { in: data.in, out: data.out, breaks: cleanBreaks },
      reason: data.reason,
      by,
      role,
      at: now,
    };
    await requireBackend().saveAttendanceEdit({ id, data, logId, log });
    return { id, ...data };
  }

  // ---- 集計表のパスワード ----

  async function setSummaryPassword(password, { email }) {
    if (String(password || '').length < 4) throw new Error('パスワードは4文字以上にしてください。');
    const hash = await summaryHash(password);
    await requireBackend().saveAttendanceSettings({ summaryHash: hash, updatedAt: clock().toISOString(), updatedBy: String(email || '').toLowerCase() });
  }

  async function unlockSummary(password, settings) {
    if (!settings || !settings.summaryHash) throw new Error('集計表のパスワードが、まだ決まっていません。管理者が 設定 › 勤怠 で決めてください。');
    const ok = (await summaryHash(password)) === settings.summaryHash;
    if (!ok) throw new Error('パスワードが違います。');
    summaryUnlocked = true;
    return true;
  }
  function isSummaryUnlocked() {
    return summaryUnlocked;
  }
  function lockSummary() {
    summaryUnlocked = false;
  }

  // ---- 出力（Excel・PDF） ----

  function dayLabel(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  }
  function wdLabel(date) {
    return U.WEEKDAYS[K.calc.weekdayOf(date)];
  }
  function noteOf(d) {
    const n = [];
    if (d.edited) n.push('修正');
    if (d.short) n.push('休憩不足');
    if (d.missingOut) n.push('退勤なし');
    return n.join('・');
  }
  function breakText(d) {
    return d.breaks.map((b) => `${shortTime(b.s)}-${shortTime(b.e)}`).join(' ');
  }

  // 集計表の行（Excel・PDF・画面で共通）
  const SUMMARY_HEAD = ['名前', '出勤日数', '勤務時間', '休憩', '有給', '休憩不足', '退勤なし', '修正'];
  function summaryRow(row) {
    const t = row.total;
    return [row.staff.name, `${t.workDays}日`, hm(t.workMin), hm(t.breakMin), `${t.paidDays}日`, `${t.shortDays}日`, `${t.missingOut}日`, `${t.edited}件`];
  }
  function totalRow(rows) {
    const s = summarize(rows.flatMap((r) => r.days));
    return ['合計', `${s.workDays}日`, hm(s.workMin), hm(s.breakMin), `${s.paidDays}日`, `${s.shortDays}日`, `${s.missingOut}日`, `${s.edited}件`];
  }
  const DETAIL_HEAD = ['日付', '曜日', '予定', '出勤', '退勤', '休憩', '休憩(分)', '勤務時間', 'メモ'];
  function detailRow(d) {
    return [dayLabel(d.date), wdLabel(d.date), planLabel(d.plan), shortTime(d.in), shortTime(d.out), breakText(d), d.breakMin ? String(d.breakMin) : '', d.workMin != null ? hm(d.workMin) : '', noteOf(d)];
  }

  // Excel（.xlsx）：1枚目に集計、2枚目から1人ずつの日ごとの表
  function xlsxBlob({ store, month, rows }) {
    const title = `${store.name} ${K.requests.monthLabel(month)} 勤怠`;
    const sheets = [{ name: '集計', rows: [[title], [], SUMMARY_HEAD, ...rows.map(summaryRow), totalRow(rows)] }];
    const used = new Set(['集計']);
    for (const r of rows) {
      let name = String(r.staff.name).replace(/[\\/?*[\]:]/g, '').slice(0, 28) || 'スタッフ';
      while (used.has(name)) name += '_';
      used.add(name);
      sheets.push({ name, rows: [[`${r.staff.name}　${title}`], [], DETAIL_HEAD, ...r.days.map(detailRow), [], ['合計', '', '', '', '', '', String(r.total.breakMin), hm(r.total.workMin), `出勤${r.total.workDays}日`]] });
    }
    return K.xlsx.build(sheets);
  }

  function fileBase({ store, month }) {
    return `勤怠_${store.name}_${month}`.replace(/[\\/:*?"<>|\s]/g, '_');
  }

  async function saveExcel(args) {
    const blob = xlsxBlob(args);
    return K.exporter.saveFiles([{ name: `${fileBase(args)}.xlsx`, blob }]);
  }

  // PDF：印刷の画面を開く（「PDFとして保存」を選ぶ）。1ページ目に集計、そのあと1人1ページ
  function printSummary({ store, month, rows }, { onNotOpened } = {}) {
    const el = U.el;
    const title = `${store.name}　${K.requests.monthLabel(month)}　勤怠`;
    const table = (head, body, cls) =>
      el('table', { class: `kp-table ${cls || ''}` }, el('thead', null, el('tr', null, head.map((h) => el('th', null, h)))), el('tbody', null, body.map((r, i) => el('tr', { class: r.cls || '' }, (r.cells || r).map((c) => el('td', null, c))))));
    const pages = [
      el('section', { class: 'kp-page' }, el('h1', { class: 'kp-title' }, `${title}　集計`), el('p', { class: 'kp-sub' }, `締め：${dayLabel(closeAt(month).toISOString().slice(0, 10))} 20:00　／　出力：${nowJst().date.replace(/-/g, '/')} ${nowJst().time}`), table(SUMMARY_HEAD, [...rows.map(summaryRow), { cells: totalRow(rows), cls: 'kp-total' }])),
      ...rows.map((r) =>
        el(
          'section',
          { class: 'kp-page' },
          el('h1', { class: 'kp-title' }, `${r.staff.name}　${title}`),
          el('p', { class: 'kp-sub' }, `出勤 ${r.total.workDays}日　勤務 ${hm(r.total.workMin)}　休憩 ${hm(r.total.breakMin)}　有給 ${r.total.paidDays}日　休憩不足 ${r.total.shortDays}日　修正 ${r.total.edited}件`),
          table(DETAIL_HEAD, r.days.map((d) => ({ cells: detailRow(d), cls: [K.calc.weekdayOf(d.date) === 0 ? 'is-sun' : '', K.calc.weekdayOf(d.date) === 6 ? 'is-sat' : '', d.short || d.missingOut ? 'is-warn' : ''].join(' ') })), 'kp-detail')
        )
      ),
    ];
    const old = document.getElementById('print-root');
    if (old) old.remove();
    const root = el('div', { id: 'print-root', class: 'kp-root' }, pages);
    document.body.append(root);
    const cleanup = () => {
      root.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    let opened = false;
    const onBefore = () => (opened = true);
    window.addEventListener('beforeprint', onBefore);
    window.print();
    setTimeout(() => {
      window.removeEventListener('beforeprint', onBefore);
      if (!opened && onNotOpened) onNotOpened();
    }, 1500);
  }

  K.attendance = {
    TYPES,
    NEXT,
    STATE_LABELS,
    CLOSE_HOUR,
    LATE_MIN,
    attach,
    setClock,
    now: () => clock(),
    nowJst,
    timeOf,
    toMin,
    hm,
    shortTime,
    closeAt,
    isClosed,
    closedNotice,
    stateOf,
    dayOf,
    isLate,
    planFromCell,
    planLabel,
    summarize,
    monthTable,
    sha256,
    pinHash,
    summaryHash,
    validPin,
    setPin,
    punch,
    editId,
    checkEdit,
    saveEdit,
    setSummaryPassword,
    unlockSummary,
    isSummaryUnlocked,
    lockSummary,
    SUMMARY_HEAD,
    DETAIL_HEAD,
    summaryRow,
    totalRow,
    detailRow,
    xlsxBlob,
    saveExcel,
    printSummary,
    backend: () => backend,
  };
})();
