// 希望休・有給希望（共有モードだけで使う）
// データは Firestore に置く（この端末には保存しない）：
//   settings/requests             { defaultLimit（希望休の初期の上限）, openDay（受付開始日＝25） }
//   requestQuotas/{スタッフID_月}  { staffId, storeId, month, limit, note }  スタッフ別・月別の上限（夏休みなど）
//   wishOffs/{スタッフID_月}       { staffId, storeId, month, dates: [日付…], updatedAt, updatedBy }
//   paidRequests/{ID}              { staffId, storeId, month, date, status: pending/approved/rejected, note, … }
// 受付は日本時間の毎月25日〜月末に、翌月分。Firestore のルールでも同じ期間・上限で止めている。
// 読み書きは backend（K.cloud。テストでは偽物）を通す。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const DEFAULTS = { defaultLimit: 2, openDay: 25 };
  const MAX_LIMIT = 31;
  const STATUS_LABELS = { pending: '申請中', approved: '承認済み', rejected: '却下' };

  let backend = null;
  let clock = () => new Date(); // テストでは日付を固定する

  // 管理者が受け取っている申請データ（シフト表の「希」の印などに使う）
  const admin = { settings: null, wishOffs: [], paidRequests: [], quotas: [] };

  function attach(b) {
    backend = b;
  }

  function setClock(fn) {
    clock = fn || (() => new Date());
  }

  const pad = (n) => String(n).padStart(2, '0');

  // 日本時間の今日（"2026-10-07"）
  function todayJst() {
    const t = new Date(clock().getTime() + 9 * 60 * 60 * 1000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  function nextMonthOf(month) {
    const [y, m] = month.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }

  function monthLabel(month) {
    const [y, m] = month.split('-').map(Number);
    return `${y}年${m}月`;
  }

  // 受付期間：{ open, month（申請する月）, opensOn（次に受付が始まる日） }
  function requestWindow() {
    const today = todayJst();
    const month = nextMonthOf(today.slice(0, 7));
    const open = Number(today.slice(8, 10)) >= DEFAULTS.openDay;
    const opensOn = open ? null : `${today.slice(0, 7)}-${DEFAULTS.openDay}`;
    return { open, month, opensOn, today };
  }

  function settingsOf(settings) {
    const s = settings || {};
    const defaultLimit = Number.isInteger(s.defaultLimit) && s.defaultLimit >= 0 && s.defaultLimit <= MAX_LIMIT ? s.defaultLimit : DEFAULTS.defaultLimit;
    return { defaultLimit, openDay: DEFAULTS.openDay };
  }

  // 希望休の上限（スタッフ別・月別の上限があればそれ、なければ全体の初期値）
  function limitFor(settings, quota) {
    if (quota && Number.isInteger(quota.limit)) return quota.limit;
    return settingsOf(settings).defaultLimit;
  }

  function limitMessage(limit) {
    return `通常の希望休は${limit}日までです。${limit + 1}日以上の休みが必要な場合は有給希望または管理者へ相談してください。`;
  }

  // 希望休の日付を押したとき：{ dates, error }
  function toggleWish(dates, date, limit) {
    const set = new Set(dates);
    if (set.has(date)) {
      set.delete(date);
      return { dates: [...set].sort(), error: null };
    }
    if (set.size >= limit) return { dates: [...set].sort(), error: limitMessage(limit) };
    set.add(date);
    return { dates: [...set].sort(), error: null };
  }

  // 申請できる日か（申請する月の日付で、店舗の定休日でない）
  function checkDate(store, month, date) {
    if (!U.isValidDate(date) || date.slice(0, 7) !== month) return `${monthLabel(month)}の日付を選んでください。`;
    if (store && K.calc.isStoreClosed(store, date)) return '定休日は選べません。';
    return null;
  }

  function requireBackend() {
    if (!backend) throw new Error('共有モードでログインしてから使ってください。');
    return backend;
  }

  function requireOpen(month) {
    const w = requestWindow();
    if (!w.open) throw new Error(`今は受付期間外です。${monthLabel(w.month)}分は${Number(w.opensOn.slice(5, 7))}月${DEFAULTS.openDay}日から受け付けます。`);
    if (month !== w.month) throw new Error(`今受け付けているのは${monthLabel(w.month)}分です。`);
  }

  // ---- スタッフ ----

  async function saveWishOffs({ staffId, storeId, month, dates, limit, store, email }) {
    requireOpen(month);
    if (dates.length > limit) throw new Error(limitMessage(limit));
    for (const d of dates) {
      const err = checkDate(store, month, d);
      if (err) throw new Error(err);
    }
    await requireBackend().saveWishOff({ staffId, storeId, month, dates: [...new Set(dates)].sort(), email });
  }

  async function requestPaid({ staffId, storeId, month, date, note, store, email, existing }) {
    requireOpen(month);
    const err = checkDate(store, month, date);
    if (err) throw new Error(err);
    if ((existing || []).some((r) => r.date === date && r.status !== 'rejected')) throw new Error('この日は、すでに有給希望を出しています。');
    const cleanNote = String(note || '').trim().slice(0, 50);
    return requireBackend().addPaidRequest({ staffId, storeId, month, date, note: cleanNote, email });
  }

  async function withdrawPaid(request) {
    if (request.status !== 'pending') throw new Error('申請中のものだけ取り下げられます。');
    await requireBackend().withdrawPaidRequest(request.id);
  }

  // ---- 管理者 ----

  function setAdminData(d) {
    admin.settings = d.settings || null;
    admin.wishOffs = d.wishOffs || [];
    admin.paidRequests = d.paidRequests || [];
    admin.quotas = d.quotas || [];
  }

  function clearAdminData() {
    setAdminData({});
  }

  function adminWishDates(staffId, month) {
    const w = admin.wishOffs.find((x) => x.staffId === staffId && x.month === month);
    return w ? [...w.dates] : [];
  }

  // 希望休を一度でも送信したか（0日で送信した「希望なし」も含む）
  function adminHasWish(staffId, month) {
    return admin.wishOffs.some((x) => x.staffId === staffId && x.month === month);
  }

  function adminSettings() {
    return admin.settings;
  }

  function adminQuota(staffId, month) {
    return admin.quotas.find((q) => q.staffId === staffId && q.month === month) || null;
  }

  function adminLimit(staffId, month) {
    return limitFor(admin.settings, adminQuota(staffId, month));
  }

  function adminPaid({ month, storeId } = {}) {
    return admin.paidRequests
      .filter((r) => (!month || r.month === month) && (!storeId || r.storeId === storeId))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  async function setDefaultLimit(value, email) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) throw new Error(`希望休の上限は0〜${MAX_LIMIT}日で入れてください。`);
    await requireBackend().adminSet('settings', 'requests', { defaultLimit: n, openDay: DEFAULTS.openDay, updatedAt: U.nowIso(), updatedBy: email || '' });
  }

  // スタッフ別・月別の上限（value が空なら、初期値に戻す）
  async function setQuota({ staffId, storeId, month, value, note, email }) {
    const id = `${staffId}_${month}`;
    if (value === '' || value === null || value === undefined) {
      await requireBackend().adminDelete('requestQuotas', id);
      return;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) throw new Error(`上限は0〜${MAX_LIMIT}日で入れてください。`);
    await requireBackend().adminSet('requestQuotas', id, {
      staffId,
      storeId,
      month,
      limit: n,
      note: String(note || '').trim().slice(0, 50),
      updatedAt: U.nowIso(),
      updatedBy: email || '',
    });
  }

  // 有給を承認する：申請を「承認済み」にして、シフト表のその日に「有給」を入れる
  // 既存のシフトがある日は、confirmOverwrite() が true のときだけ上書きする
  async function approvePaid(request, { email, confirmOverwrite }) {
    if (request.status !== 'pending') throw new Error('申請中のものだけ承認できます。');
    const existing = K.storage.getShift(request.staffId, request.date, request.storeId);
    if (existing && existing.kind !== 'paid') {
      const kinds = { work: '通常勤務', off: '通常休', business: '社用' };
      if (!confirmOverwrite(`この日はすでに「${kinds[existing.kind] || existing.kind}」が入っています。有給に変えますか？`)) return false;
    }
    if (!existing || existing.kind !== 'paid') K.storage.setShift(request.staffId, request.date, { kind: 'paid', storeId: request.storeId });
    await requireBackend().adminUpdate('paidRequests', request.id, { status: 'approved', decidedAt: U.nowIso(), decidedBy: email || '', updatedAt: U.nowIso() });
    return true;
  }

  async function rejectPaid(request, { email }) {
    if (request.status !== 'pending') throw new Error('申請中のものだけ却下できます。');
    await requireBackend().adminUpdate('paidRequests', request.id, { status: 'rejected', decidedAt: U.nowIso(), decidedBy: email || '', updatedAt: U.nowIso() });
  }

  // 日付を変える（申請中のものだけ。元の日付も残す）
  async function changePaidDate(request, newDate, { email, store }) {
    if (request.status !== 'pending') throw new Error('申請中のものだけ日付を変えられます。');
    if (!U.isValidDate(newDate)) throw new Error('日付が正しくありません。');
    if (store && K.calc.isStoreClosed(store, newDate)) throw new Error('定休日は選べません。');
    if (newDate === request.date) return;
    await requireBackend().adminUpdate('paidRequests', request.id, {
      date: newDate,
      month: newDate.slice(0, 7),
      originalDate: request.originalDate || request.date,
      updatedAt: U.nowIso(),
      changedBy: email || '',
    });
  }

  K.requests = {
    STATUS_LABELS,
    attach,
    setClock,
    todayJst,
    nextMonthOf,
    monthLabel,
    requestWindow,
    settingsOf,
    limitFor,
    limitMessage,
    toggleWish,
    checkDate,
    saveWishOffs,
    requestPaid,
    withdrawPaid,
    setAdminData,
    clearAdminData,
    adminWishDates,
    adminHasWish,
    adminSettings,
    adminQuota,
    adminLimit,
    adminPaid,
    setDefaultLimit,
    setQuota,
    approvePaid,
    rejectPaid,
    changePaidDate,
  };
})();
