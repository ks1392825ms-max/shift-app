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
//   punchEdits/{スタッフID_日付}  { staffId, storeId, date, month, in, out, breaks, outs（外出・11/12〜）, reason, by, role, at, logId }  直した1日分（打刻より優先）
//   attendanceDirectory/{店舗ID} { storeId, storeName, order, staff: [{ id, name, fullName, employeeNo, position }], patterns: [{ start, end, breakMinutes }], paid: ['スタッフID|日付'], updatedAt }
//                                集計表用の名簿（11/12〜。管理者が作り、管理者と幹部が読む。幹部は3店舗とも見る・出力だけ）
//   attendanceLogs/{…}           修正の記録（追加するだけ）
//   settings/attendance          { summaryHash（集計表のパスワード）, updatedAt, updatedBy }
// 読み書きの決まりは Firestore のルールでも強制している。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const TYPES = { in: '出勤', out: '退勤', bs: '休憩開始', be: '休憩戻り' };
  // 11/14〜 休憩中にも退勤を押せる（休憩戻りの押し忘れとして、退勤の時刻で休憩も終わり。ユーザー A）
  const NEXT = { wait: ['in'], in: ['bs', 'out'], br: ['be', 'out'], out: [] };
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

  // 日をまたぐ勤務（11/12〜）：出勤中の人の、翌朝5時までの打刻は、出勤した日の勤務として「25:30」のように数える
  const CARRY_MIN = 5 * 60;

  // 「25:30」のような翌日の時刻（24〜29時）も読む。おかしな値は null
  function toMinX(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h > 29 || mi > 59 ? null : h * 60 + mi;
  }
  // 分 → 「09:05」「25:30」
  function fromMin(min) {
    return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  }
  function addDays(date, n) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // その日の0時（日本時間）からの分（翌日の1:30 は 1530）
  function minFrom(iso, date) {
    return Math.floor((Date.parse(iso) - Date.parse(`${date}T00:00:00+09:00`)) / 60000);
  }
  const atOf = (p) => (Number.isFinite(p.atMs) ? p.atMs : Date.parse(p.at));

  // 打刻を「勤務した日」に分ける：{ 'スタッフID|日付' → [打刻] }
  // 出勤中（退勤していない）の人の、次の日の5時までの打刻は、出勤した日に入れる
  function assignPunches(punches) {
    const byStaff = new Map();
    for (const p of punches || []) {
      if (!p || !p.date || !p.staffId) continue;
      if (!byStaff.has(p.staffId)) byStaff.set(p.staffId, []);
      byStaff.get(p.staffId).push(p);
    }
    const out = new Map();
    for (const [staffId, list] of byStaff) {
      list.sort((a, b) => atOf(a) - atOf(b));
      let open = null; // 出勤中の勤務の日
      for (const p of list) {
        let day = p.date;
        if (p.type === 'in') open = p.date;
        else if (open && open !== p.date && p.date === addDays(open, 1) && minFrom(p.at, p.date) < CARRY_MIN) day = open;
        const key = `${staffId}|${day}`;
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(p);
        if (p.type === 'out' || (p.type !== 'in' && day !== open)) open = null;
      }
    }
    return out;
  }

  // iPad の今の打刻：0時〜5時は、前の日に出勤したまま（または5時までに退勤した）人の分を、前の日の勤務として続ける
  function currentPunches(punches, today) {
    const yday = addDays(today, -1);
    const a = assignPunches(punches);
    const list = [];
    for (const id of new Set((punches || []).map((p) => p.staffId))) {
      const y = a.get(`${id}|${yday}`) || [];
      const t = a.get(`${id}|${today}`) || [];
      const carried = y.some((p) => p.date === today) || ['in', 'br'].includes(stateOf(y));
      list.push(...(carried && !t.length ? y : t));
    }
    return list;
  }

  // 1日分の出勤・退勤・休憩・外出（直したものがあれば、そちらを使う）
  // 戻り値：{ in, out, breaks: [{ s, e }], outs: [{ s, e }], openBreak, edited, breakMin, outMin, workMin, short, missingOut }
  // 労働（workMin）＝ 退勤 − 出勤 − 休憩 − 外出（11/12 ユーザー：外出は私用の外出として労働から引く）
  function dayOf(punches, edit, { today, date } = {}) {
    let inT = '';
    let outT = '';
    let breaks = [];
    let outs = [];
    let openBreak = '';
    let edited = false;
    let dup = false;
    const pairs = (list) => (Array.isArray(list) ? list : []).filter((b) => b && b.s && b.e).map((b) => ({ s: b.s, e: b.e }));
    if (edit) {
      inT = edit.in || '';
      outT = edit.out || '';
      breaks = pairs(edit.breaks);
      outs = pairs(edit.outs);
      edited = true;
    } else {
      const sorted = (punches || []).slice().sort((a, b) => atOf(a) - atOf(b));
      // 同じ種類が続けて2回（iPad とスマホでほぼ同時に押したなど）：最初の分を使い、印をつける（11/14〜）
      dup = sorted.some((p, i) => i > 0 && p.type === sorted[i - 1].type);
      const first = sorted.find((p) => p.type === 'in') || sorted[0];
      const base = date || (first && first.date) || '';
      const t = (p) => {
        const m = base ? minFrom(p.at, base) : null;
        return m != null && m >= 0 && m < 30 * 60 ? fromMin(m) : timeOf(p.at);
      };
      for (const p of sorted) {
        if (p.type === 'in' && !inT) inT = t(p);
        else if (p.type === 'in') continue;
        else if (p.type === 'out') {
          outT = t(p);
          // 休憩中の退勤：退勤の時刻で休憩も終わり（11/14〜）
          if (openBreak) {
            breaks.push({ s: openBreak, e: outT });
            openBreak = '';
          }
        }
        else if (p.type === 'bs' && !openBreak) openBreak = t(p);
        else if (p.type === 'be' && openBreak) {
          breaks.push({ s: openBreak, e: t(p) });
          openBreak = '';
        }
      }
    }
    const len = (list) => list.reduce((sum, b) => sum + Math.max(0, (toMinX(b.e) || 0) - (toMinX(b.s) || 0)), 0);
    const breakMin = len(breaks);
    const outMin = len(outs);
    const a = toMinX(inT);
    const z = toMinX(outT);
    const workMin = a != null && z != null && z > a ? Math.max(0, z - a - breakMin - outMin) : null;
    // 休憩の決まり：6時間をこえる日は45分以上、8時間をこえる日は60分以上
    const short = workMin != null && ((workMin > 480 && breakMin < 60) || (workMin > 360 && breakMin < 45));
    const missingOut = Boolean(inT) && !outT && Boolean(today && date && date < today);
    // スマホの例外の打刻（お店の外・位置が取れない）で、まだ認められていないもの（11/14〜）
    const pending = !edited && (punches || []).some((p) => p && p.pending);
    return { in: inT, out: outT, breaks, outs, openBreak, edited, breakMin, outMin, workMin, short, missingOut, dup: !edited && dup, pending };
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

  // ---- 予定の労働・残業（11/12〜） ----
  // 予定の労働 ＝ 予定の時間 − 勤務パターンの休憩。パターンと合わない日（時刻を動かした日など）は、法定の休憩（6時間こえ45分・8時間こえ60分）
  function legalBreak(len) {
    return len > 480 ? 60 : len > 360 ? 45 : 0;
  }
  // 予定に、勤務パターンの休憩（同じ開始・終了のパターン）をつける。patterns：[{ start, end, breakMinutes }]
  function withBreak(plan, patterns) {
    if (!plan || plan.breakMin != null || !plan.start || !plan.end) return plan;
    const p = (patterns || []).find((x) => x && x.start === plan.start && x.end === plan.end && Number.isInteger(x.breakMinutes));
    return p ? { ...plan, breakMin: p.breakMinutes } : plan;
  }
  function isWorkPlan(plan) {
    return Boolean(plan && (plan.kind === 'work' || plan.kind === 'business') && toMin(plan.start) != null && toMin(plan.end) != null && toMin(plan.end) > toMin(plan.start));
  }
  function planWorkMin(plan) {
    if (!isWorkPlan(plan)) return null;
    const len = toMin(plan.end) - toMin(plan.start);
    const br = Number.isInteger(plan.breakMin) ? plan.breakMin : legalBreak(len);
    return Math.max(0, len - br);
  }
  // 1日分に、予定との比べ（残業・遅刻・早退・早出）を足す
  // 残業 ＝ 労働 − 予定の労働（早出も含め、遅刻した分は差し引き。マイナスは0）。予定がない日は残業なし（11/12 ユーザー）
  function compare(day) {
    const planMin = planWorkMin(day.plan);
    const overMin = planMin != null && day.workMin != null ? Math.max(0, day.workMin - planMin) : 0;
    const a = toMinX(day.in);
    const z = toMinX(day.out);
    const work = isWorkPlan(day.plan);
    const ps = work ? toMin(day.plan.start) : null;
    const pe = work ? toMin(day.plan.end) : null;
    return {
      ...day,
      planMin,
      overMin,
      late: work && a != null && a > ps,
      cameEarly: work && a != null && a < ps,
      leftEarly: work && z != null && z < pe,
      paid: Boolean(day.plan && day.plan.kind === 'paid'),
    };
  }

  // ---- 集計 ----

  // 1人分の月の集計（日ごとの記録から数える。同じ日は1回だけ）
  function summarize(days) {
    const r = { workDays: 0, workMin: 0, breakMin: 0, outMin: 0, overMin: 0, shortDays: 0, missingOut: 0, edited: 0, paidDays: 0, late: 0, leftEarly: 0, cameEarly: 0, pending: 0 };
    for (const d of days) {
      if (d.plan && d.plan.kind === 'paid') r.paidDays += 1;
      if (d.in) r.workDays += 1;
      if (d.workMin != null) r.workMin += d.workMin;
      r.breakMin += d.breakMin || 0;
      r.outMin += d.outMin || 0;
      r.overMin += d.overMin || 0;
      if (d.short) r.shortDays += 1;
      if (d.missingOut) r.missingOut += 1;
      if (d.edited) r.edited += 1;
      if (d.late) r.late += 1;
      if (d.leftEarly) r.leftEarly += 1;
      if (d.cameEarly) r.cameEarly += 1;
      if (d.pending) r.pending += 1;
    }
    return r;
  }

  // 店舗・月の表：staff（[{ id, name, … }]）・planOf(staffId, date)・データ（打刻・直したもの）・勤務パターンの休憩から、1人ずつ日ごとの行と集計を作る
  // 打刻は、前の月の最終日・次の月の1日の分も渡してよい（日をまたぐ勤務を正しく分けるため。表に出すのはその月の日だけ）
  function monthTable({ month, staff, planOf, punches, edits, patterns, checks }) {
    const today = nowJst().date;
    const byKey = assignPunches(withChecks(punches, checks));
    const editOf = new Map((edits || []).map((e) => [`${e.staffId}|${e.date}`, e]));
    return staff.map((m) => {
      const days = K.calc.monthDates(month).map((date) => {
        const edit = editOf.get(`${m.id}|${date}`) || null;
        const d = dayOf(byKey.get(`${m.id}|${date}`), edit, { today, date });
        return compare({ date, plan: withBreak(planOf ? planOf(m.id, date) : null, patterns), ...d });
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

  // ---- スマホの打刻（GPS・11/14〜） ----
  // 例外（お店の外・位置が取れない）の理由
  const REASONS = { direct: '外出先から直行', home: '外出先から直帰', nogps: '位置が取れない', other: 'そのほか' };
  const RADII = [20, 50, 100, 200];

  // 2点の距離（m）
  function distanceM(a, b) {
    const R = 6371000;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  // お店の位置（{ lat, lng, radius }）と、スマホの位置（{ lat, lng, acc }。取れないときは null）→ { ok, dist, acc }
  // 細かい緯度・経度は返さない（保存しない）
  function judgeGeo(store, pos) {
    if (!store || !pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return { ok: false, dist: null, acc: pos && Number.isFinite(pos.acc) ? Math.round(pos.acc) : null };
    const dist = distanceM(store, pos);
    return { ok: dist <= store.radius, dist, acc: Number.isFinite(pos.acc) ? Math.round(pos.acc) : null };
  }
  // 例外の打刻か（認める・認めないが必要）
  function isException(p) {
    return Boolean(p && p.source === 'phone' && p.geo && p.geo.ok === false);
  }
  // 確認（punchChecks）を打刻に重ねる：認めない → 計算から外す・まだ → pending の印
  function withChecks(punches, checks) {
    const byId = new Map((checks || []).map((c) => [c.punchId, c]));
    const out = [];
    for (const p of punches || []) {
      if (!isException(p)) {
        out.push(p);
        continue;
      }
      const c = byId.get(punchIdOf(p));
      if (c && c.status === 'ng') continue;
      out.push(c && c.status === 'ok' ? p : { ...p, pending: true });
    }
    return out;
  }
  function punchIdOf(p) {
    return p.id || `${p.staffId}_${p.date}_${p.atMs}`;
  }
  // まだ確認していない例外の打刻（新しい順）
  function pendingExceptions(punches, checks) {
    const done = new Set((checks || []).map((c) => c.punchId));
    return (punches || []).filter((p) => isException(p) && !done.has(punchIdOf(p))).sort((a, b) => atOf(b) - atOf(a));
  }

  // スタッフがスマホで打つ（番号はいらない。ログインで本人と分かる）
  // geo：judgeGeo の結果。範囲の外・位置が取れないときは reason（REASONS のキー）が必要
  async function punchPhone({ staffId, storeId, type, email, current, geo, reason, note }) {
    if (!TYPES[type]) throw new Error('打刻の種類が正しくありません。');
    const d = clock();
    const { date, month } = nowJst(d);
    if (isClosed(month, d)) throw new Error(`${Number(month.slice(5))}月の勤怠は締めました。管理者に伝えてください。`);
    const state = stateOf(current);
    if (!NEXT[state].includes(type)) throw new Error(`今は「${STATE_LABELS[state]}」なので、${TYPES[type]}は押せません。`);
    const g = { ok: Boolean(geo && geo.ok), dist: geo && Number.isInteger(geo.dist) ? geo.dist : null, acc: geo && Number.isInteger(geo.acc) ? geo.acc : null };
    if (!g.ok && !REASONS[reason]) throw new Error('お店の範囲の外です。理由を選んでください。');
    const id = punchId(staffId, date, d);
    const data = { staffId, storeId, date, month, type, at: d.toISOString(), atMs: d.getTime(), by: String(email || '').toLowerCase(), source: 'phone', geo: g };
    if (!g.ok) data.reason = reason;
    const memo = String(note || '').trim().slice(0, 100);
    if (!g.ok && memo) data.note = memo;
    await requireBackend().addPhonePunch({ id, data });
    return { id, ...data };
  }

  // 管理者・幹部：例外の打刻を認める（ok）・認めない（ng）
  async function decidePunch(p, status, { email, role }) {
    if (!['ok', 'ng'].includes(status)) throw new Error('選び方が正しくありません。');
    const id = punchIdOf(p);
    const data = { punchId: id, staffId: p.staffId, storeId: p.storeId, date: p.date, month: p.month || String(p.date).slice(0, 7), status, by: String(email || '').toLowerCase(), role, at: clock().toISOString() };
    await requireBackend().savePunchCheck({ id, data });
    return data;
  }

  // ---- 直す（管理者・幹部） ----

  function editId(staffId, date) {
    return `${staffId}_${date}`;
  }

  // 直す画面の時刻：出勤より前で、5時までの時刻は翌日（「1:30」→「25:30」）。日をまたぐ勤務のため（11/12〜）
  function nextDayTime(t, inT) {
    const m = toMin(t);
    const a = toMin(inT);
    if (m == null || a == null) return t;
    return m < a && m <= CARRY_MIN ? fromMin(m + 24 * 60) : t;
  }
  function normalizeEditTimes({ in: inT, out, breaks, outs }) {
    const fix = (t) => (t ? nextDayTime(t, inT) : t || '');
    const pairs = (list) => (list || []).map((b) => ({ s: fix(b && b.s), e: fix(b && b.e) }));
    return { in: inT || '', out: fix(out), breaks: pairs(breaks), outs: pairs(outs) };
  }

  function checkEdit({ in: inT, out, breaks, outs, reason }) {
    const r = String(reason || '').trim();
    if (!r) return '直す理由を入れてください。';
    if (r.length > MAX_REASON) return `理由は${MAX_REASON}文字以内にしてください。`;
    if (inT && toMin(inT) == null) return '時刻の形が正しくありません。';
    if (out && toMinX(out) == null) return '時刻の形が正しくありません。';
    if (out && !inT) return '退勤だけは入れられません。出勤も入れてください。';
    if (inT && out && toMinX(out) <= toMin(inT)) return '退勤は出勤より後の時刻にしてください（0時を過ぎたときは、翌朝5時まで）。';
    for (const [list, name, a, b] of [[breaks, '休憩', '開始', '戻り'], [outs, '外出', '出', '戻り']]) {
      for (const x of list || []) {
        if (!x.s && !x.e) continue;
        if (toMinX(x.s) == null || toMinX(x.e) == null) return `${name}は、${a}と${b}の両方を入れてください。`;
        if (toMinX(x.e) <= toMinX(x.s)) return `${name}の${b}は、${a}より後の時刻にしてください。`;
        if (inT && toMinX(x.s) < toMin(inT)) return `${name}は出勤のあとにしてください。`;
        if (out && toMinX(x.e) > toMinX(out)) return `${name}は退勤の前にしてください。`;
      }
    }
    return null;
  }

  async function saveEdit({ staffId, storeId, date, in: inT, out, breaks, outs, reason, email, role, before }) {
    const month = date.slice(0, 7);
    const t = normalizeEditTimes({ in: inT, out, breaks, outs });
    const err = checkEdit({ ...t, reason });
    if (err) throw new Error(err);
    if (role !== 'owner' && isClosed(month)) throw new Error(`${Number(month.slice(5))}月の勤怠は締めました。直せるのは管理者だけです。`);
    const now = clock().toISOString();
    const by = String(email || '').toLowerCase();
    const id = editId(staffId, date);
    const logId = `att_${id}_${now}`;
    const clean = (list) => list.filter((b) => b && b.s && b.e).map((b) => ({ s: b.s, e: b.e }));
    const cleanBreaks = clean(t.breaks);
    const cleanOuts = clean(t.outs);
    const data = { staffId, storeId, date, month, in: t.in, out: t.out, breaks: cleanBreaks, outs: cleanOuts, reason: String(reason).trim(), by, role, at: now, logId };
    const log = {
      targetId: id,
      staffId,
      storeId,
      date,
      month,
      from: before ? { in: before.in || '', out: before.out || '', breaks: (before.breaks || []).map((b) => ({ s: b.s, e: b.e })), outs: (before.outs || []).map((b) => ({ s: b.s, e: b.e })) } : null,
      to: { in: data.in, out: data.out, breaks: cleanBreaks, outs: cleanOuts },
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

  // ---- 出力（Excel・PDF）：会社の勤怠集計表の形（11/12〜 1人1枚・A4 縦） ----
  //   上：従業員番号・担当・氏名・対象期間
  //   日ごと：日付・開始・終了・休憩・外出・労働・残業（1日〜末日の全部の行。打刻のない日は空欄）
  //   下：出勤日数・実働合計・残業合計・外出合計（と、有給・遅刻・早退などの回数）
  // 時間は小数第1位（四捨五入）。月の合計は、分のまま足してから四捨五入（11/12 ユーザー）

  function dayLabel(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  }
  function wdLabel(date) {
    return U.WEEKDAYS[K.calc.weekdayOf(date)];
  }
  // 分 → 小数第1位の時間「7.3」
  function hours(min) {
    return (Math.round((min || 0) / 6) / 10).toFixed(1);
  }
  const MARKS = [['late', '遅刻'], ['leftEarly', '早退'], ['cameEarly', '早出'], ['paid', '有給'], ['short', '休憩不足'], ['missingOut', '退勤なし'], ['pending', '確認待ち'], ['dup', '重複'], ['edited', '修正']];
  function marksOf(d) {
    return MARKS.filter(([k]) => d[k]).map(([, t]) => t);
  }
  function noteOf(d) {
    return marksOf(d).join('・');
  }

  const SHEET_HEAD = ['日付', '開始', '終了', '休憩', '外出', '労働', '残業'];
  // 日ごとの1行：[日付, 開始, 終了, 休憩, 外出, 労働, 残業]（時間は「1.0」の文字。0 の欄は空欄）
  function sheetDayRow(d) {
    const worked = Boolean(d.in || d.out);
    return [`${dayLabel(d.date)}（${wdLabel(d.date)}）`, shortTime(d.in), shortTime(d.out), worked && d.breakMin ? hours(d.breakMin) : '', worked && d.outMin ? hours(d.outMin) : '', d.workMin != null ? hours(d.workMin) : '', d.overMin ? hours(d.overMin) : ''];
  }
  function monthEnd(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  // 上の欄：従業員番号・担当（店舗・職種）・氏名（空なら表示名）・対象期間
  function sheetInfo(row, { store, month }) {
    const m = row.staff;
    const [y, mo] = month.split('-').map(Number);
    return {
      employeeNo: m.employeeNo || '',
      tanto: [store && store.name, U.POSITION_LABELS[m.position] || ''].filter(Boolean).join('・'),
      name: m.fullName || m.name,
      period: `${y}年${mo}月1日 〜 ${y}年${mo}月${monthEnd(month)}日`,
    };
  }
  const TOTAL_HEAD = ['出勤日数', '実働合計（時）', '残業合計（時）', '外出合計（時）'];
  function sheetTotals(t) {
    return [`${t.workDays}日`, hours(t.workMin), hours(t.overMin), hours(t.outMin)];
  }
  function sheetExtra(t) {
    return `有給 ${t.paidDays}日　遅刻 ${t.late}回　早退 ${t.leftEarly}回　早出 ${t.cameEarly}回　休憩不足 ${t.shortDays}日　退勤なし ${t.missingOut}日　修正 ${t.edited}件`;
  }

  // 画面の集計表（全員）の行
  const SUMMARY_HEAD = ['名前', '出勤日数', '実働（時）', '残業（時）', '外出（時）', '有給', '遅刻', '早退', '休憩不足', '退勤なし', '修正'];
  function sumCells(name, t) {
    return [name, `${t.workDays}日`, hours(t.workMin), hours(t.overMin), hours(t.outMin), `${t.paidDays}日`, `${t.late}回`, `${t.leftEarly}回`, `${t.shortDays}日`, `${t.missingOut}日`, `${t.edited}件`];
  }
  function summaryRow(row) {
    return sumCells(row.staff.name, row.total);
  }
  function totalRow(rows) {
    // 合計は、1人ずつの分を足す（同じ人・同じ日を2回数えない）
    const s = summarize(rows.flatMap((r) => r.days));
    return sumCells('合計', s);
  }

  // Excel（.xlsx）：1人1シート（A4 縦・1ページに収まる設定）。2人以上のときは、1枚目に全員の集計
  function sheetOf(row, args) {
    const info = sheetInfo(row, args);
    const c = (v, s) => ({ v, s });
    const numOr = (v) => (v === '' ? c('', 'cell') : c(v, 'num1'));
    const rows = [
      [c('勤怠集計表', 'title')],
      [],
      [c('従業員番号', 'label'), { v: info.employeeNo, s: 'cell', str: true }, c('', 'cell'), c('担当', 'label'), c(info.tanto, 'cell'), c('', 'cell'), c('', 'cell')],
      [c('氏名', 'label'), { v: info.name, s: 'cell', str: true }, c('', 'cell'), c('対象期間', 'label'), c(info.period, 'cell'), c('', 'cell'), c('', 'cell')],
      [],
      SHEET_HEAD.map((h) => c(h, 'head')),
      ...row.days.map((d) => {
        const r = sheetDayRow(d);
        const wd = K.calc.weekdayOf(d.date);
        const marks = marksOf(d);
        return [c(marks.length ? `${r[0]} ${marks.join('・')}` : r[0], wd === 0 ? 'sun' : wd === 6 ? 'sat' : 'cell'), c(r[1], 'time'), c(r[2], 'time'), numOr(r[3]), numOr(r[4]), numOr(r[5]), numOr(r[6])];
      }),
      [],
      [c(TOTAL_HEAD[0], 'head'), c('', 'head'), c(TOTAL_HEAD[1], 'head'), c('', 'head'), c(TOTAL_HEAD[2], 'head'), c(TOTAL_HEAD[3], 'head'), c('', 'head')],
      (() => {
        const t = sheetTotals(row.total);
        return [c(t[0], 'total'), c('', 'total'), c(t[1], 'totalNum'), c('', 'total'), c(t[2], 'totalNum'), c(t[3], 'totalNum'), c('', 'total')];
      })(),
      [c(sheetExtra(row.total), 'small')],
    ];
    const n = row.days.length;
    const tot = 6 + n + 2; // 合計の見出しの行（0始まり）
    return {
      rows,
      cols: [16, 9, 9, 9, 9, 9, 9],
      merges: ['A1:G1', 'B3:C3', 'E3:G3', 'B4:C4', 'E4:G4', `A${tot + 1}:B${tot + 1}`, `C${tot + 1}:D${tot + 1}`, `F${tot + 1}:G${tot + 1}`, `A${tot + 2}:B${tot + 2}`, `C${tot + 2}:D${tot + 2}`, `F${tot + 2}:G${tot + 2}`, `A${tot + 3}:G${tot + 3}`],
      page: { portrait: true, fit: true },
    };
  }
  function xlsxBlob({ store, month, rows }) {
    const title = `${store.name} ${K.requests.monthLabel(month)} 勤怠`;
    const sheets = [];
    const used = new Set();
    if (rows.length > 1) {
      sheets.push({ name: '集計', rows: [[title], [], SUMMARY_HEAD, ...rows.map(summaryRow), totalRow(rows)] });
      used.add('集計');
    }
    for (const r of rows) {
      let name = String(r.staff.name).replace(/[\\/?*[\]:]/g, '').slice(0, 28) || 'スタッフ';
      while (used.has(name)) name += '_';
      used.add(name);
      sheets.push({ name, ...sheetOf(r, { store, month }) });
    }
    return K.xlsx.build(sheets);
  }

  function fileBase({ store, month, rows }) {
    const who = rows && rows.length === 1 ? `_${rows[0].staff.name}` : '';
    return `勤怠_${store.name}_${month}${who}`.replace(/[\\/:*?"<>|\s]/g, '_');
  }

  async function saveExcel(args) {
    const blob = xlsxBlob(args);
    return K.exporter.saveFiles([{ name: `${fileBase(args)}.xlsx`, blob }]);
  }

  // 1人分の紙（PDF・印刷）
  function sheetPage(row, args) {
    const el = U.el;
    const info = sheetInfo(row, args);
    const t = sheetTotals(row.total);
    return el(
      'section',
      { class: 'kp-page ks-page' },
      el('h1', { class: 'ks-title' }, '勤怠集計表'),
      el(
        'table',
        { class: 'ks-info' },
        el('tbody', null, el('tr', null, el('th', null, '従業員番号'), el('td', null, info.employeeNo), el('th', null, '担当'), el('td', null, info.tanto)), el('tr', null, el('th', null, '氏名'), el('td', null, info.name), el('th', null, '対象期間'), el('td', null, info.period)))
      ),
      el(
        'table',
        { class: 'ks-main' },
        el('colgroup', null, el('col', { class: 'ks-col-date' }), SHEET_HEAD.slice(1).map(() => el('col'))),
        el('thead', null, el('tr', null, SHEET_HEAD.map((h) => el('th', null, h)))),
        el(
          'tbody',
          null,
          row.days.map((d) => {
            const r = sheetDayRow(d);
            const wd = K.calc.weekdayOf(d.date);
            const marks = marksOf(d);
            return el(
              'tr',
              { class: wd === 0 ? 'is-sun' : wd === 6 ? 'is-sat' : '' },
              el('td', { class: 'ks-date' }, el('span', null, r[0]), marks.length ? el('small', { class: 'ks-marks' }, marks.join('・')) : null),
              r.slice(1).map((v) => el('td', null, v))
            );
          })
        )
      ),
      el('table', { class: 'ks-total' }, el('tbody', null, el('tr', null, TOTAL_HEAD.map((h) => el('th', null, h))), el('tr', null, t.map((v) => el('td', null, v))))),
      el('p', { class: 'ks-extra' }, sheetExtra(row.total))
    );
  }

  // 全体の集計表の紙（11/13〜 PDF の1ページ目）：全員の従業員番号・氏名と、月の合計
  const OVERALL_HEAD = ['従業員番号', '氏名', ...SUMMARY_HEAD.slice(1)];
  function overallPage({ store, month, rows }) {
    const el = U.el;
    const [y, mo] = month.split('-').map(Number);
    const total = totalRow(rows);
    return el(
      'section',
      { class: 'kp-page ks-page ks-overall' },
      el('h1', { class: 'ks-title' }, '勤怠集計表（全体）'),
      el(
        'table',
        { class: 'ks-info' },
        el('tbody', null, el('tr', null, el('th', null, '店舗'), el('td', null, store ? store.name : ''), el('th', null, '対象期間'), el('td', null, `${y}年${mo}月1日 〜 ${y}年${mo}月${monthEnd(month)}日`)))
      ),
      el(
        'table',
        { class: 'ks-main ks-sum' },
        el('thead', null, el('tr', null, OVERALL_HEAD.map((h) => el('th', null, h)))),
        el(
          'tbody',
          null,
          rows.map((r) => {
            const info = sheetInfo(r, { store, month });
            return el('tr', null, el('td', { class: 'ks-no' }, info.employeeNo), el('td', { class: 'ks-name' }, info.name), summaryRow(r).slice(1).map((v) => el('td', null, v)));
          })
        ),
        el('tfoot', null, el('tr', null, el('td', { class: 'ks-no' }, ''), el('td', { class: 'ks-name' }, `合計（${rows.length}人）`), total.slice(1).map((v) => el('td', null, v))))
      ),
      el('p', { class: 'ks-extra' }, '時間は小数第1位（四捨五入）。月の合計は、分のまま足してから四捨五入しています。2ページ目から1人1枚です。')
    );
  }

  // PDF：印刷の画面を開く（「PDFとして保存」を選ぶ）。2人以上のときは1ページ目に全体の集計表、そのあと1人1ページ（A4 縦）
  function printSummary({ store, month, rows }, { onNotOpened } = {}) {
    const el = U.el;
    const old = document.getElementById('print-root');
    if (old) old.remove();
    const root = el('div', { id: 'print-root', class: 'kp-root' }, rows.length > 1 ? overallPage({ store, month, rows }) : null, rows.map((r) => sheetPage(r, { store, month })));
    // 集計表だけ A4 縦（シフト表の印刷は A4 横のまま）
    const pageStyle = el('style', { id: 'kp-page-style' }, '@media print { @page { size: A4 portrait; margin: 10mm 12mm; } }');
    document.head.append(pageStyle);
    document.body.append(root);
    const cleanup = () => {
      root.remove();
      pageStyle.remove();
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
    toMinX,
    fromMin,
    hm,
    hours,
    CARRY_MIN,
    assignPunches,
    currentPunches,
    addDays,
    withBreak,
    planWorkMin,
    legalBreak,
    marksOf,
    REASONS,
    RADII,
    distanceM,
    judgeGeo,
    isException,
    withChecks,
    punchIdOf,
    pendingExceptions,
    punchPhone,
    decidePunch,
    sheetPage,
    overallPage,
    OVERALL_HEAD,
    nextDayTime,
    normalizeEditTimes,
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
    SHEET_HEAD,
    TOTAL_HEAD,
    summaryRow,
    totalRow,
    sheetDayRow,
    sheetInfo,
    sheetTotals,
    xlsxBlob,
    saveExcel,
    printSummary,
    backend: () => backend,
  };
})();
