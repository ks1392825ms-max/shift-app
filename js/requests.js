// 希望休・有給希望（共有モードだけで使う）
// データは Firestore に置く（この端末には保存しない）。記録の形は js/records.js：
//   settings/requests              { defaultLimit（希望休の初期の上限）, openDay（受付開始日＝25） }  オーナーだけが変える
//   requestQuotas/{スタッフID_月}   { staffId, storeId, month, limit, note }  スタッフ別・月別の上限（夏休みなど）
//   wishRequests/{スタッフID_日付}  希望休（1日ごと）：status＝pending（申請中）/ approved（承認）/ rejected（却下・理由つき）
//   wishCounts/{スタッフID_月}      希望休の日数（月の上限を Firestore のルールで確かめるため）
//   paidRequests/{スタッフID_日付_回数} 有給希望：status と判断の項目。同じ日は3回まで（2回目・3回目は前の回が却下のときだけ）
//   changeRequests/{種類_記録_回数}  変更申請（承認済みの希望休・有給の取り消し・日付の変更）。承認されたら、オーナーがシフト表に反映する
//   decisionLogs/…                  判断の履歴（誰が・いつ・どう変えたか）。追加するだけ
// 受付は日本時間の毎月25日〜月末に、翌月分。Firestore のルールでも同じ期間・上限で止めている。
// 希望休も有給も、承認されたものだけが AIシフト作成で休み（有給）になる。承認済みの申請は、スタッフは消せない（変更申請）。
// 読み書きは backend（K.cloud。テストでは偽物）を通す。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const DEFAULTS = { defaultLimit: 2, openDay: 25 };
  const MAX_LIMIT = 31;
  const STATUS_LABELS = { pending: '申請中', approved: '承認済み', rejected: '却下', cancelled: '取り消し済み' };
  const CHANGE_TYPE_LABELS = { cancel: '取り消し', move: '日付の変更' };
  const MAX_PAID_ATTEMPTS = 3; // 同じ日の有給希望は3回まで（却下のあとに出し直す分を含む）

  let backend = null;
  let clock = () => new Date(); // テストでは日付を固定する

  // 管理者が受け取っている申請データ（シフト表の「希」の印などに使う）
  const admin = { settings: null, wishRequests: [], wishCounts: [], paidRequests: [], changeRequests: [], quotas: [], logs: [] };

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

  // 希望休を送る：選んだ日（draft）と、送信済みの希望休（saved：1日ごとの記録）を比べて、足す日・消す日を決める
  // 承認済みの日は外せない（変更申請）。却下の日は draft に入れず、removeWish で消してから出し直す
  // 上限は、送信済みの日数（却下を含む）で数える（Firestore のルールの wishCounts と同じ）
  async function saveWishes({ staffId, storeId, month, draft, saved, limit, store, email }) {
    requireOpen(month);
    const savedList = saved || [];
    const want = new Set(draft);
    const missingApproved = savedList.filter((w) => w.status === 'approved' && !want.has(w.date));
    if (missingApproved.length) throw new Error(`承認済みの希望休（${missingApproved.map((w) => shortMd(w.date)).join('・')}）は、ここでは外せません。変更が必要なときは変更申請をしてください。`);
    const has = new Map(savedList.map((w) => [w.date, w]));
    const toRemove = savedList.filter((w) => w.status === 'pending' && !want.has(w.date));
    const toAdd = [...want].filter((d) => !has.has(d)).sort();
    if (savedList.length - toRemove.length + toAdd.length > limit) throw new Error(limitMessage(limit));
    for (const d of toAdd) {
      const err = checkDate(store, month, d);
      if (err) throw new Error(err);
    }
    const b = requireBackend();
    for (const w of toRemove) await b.removeWishRequest({ staffId, storeId, date: w.date, email });
    for (const d of toAdd) await b.addWishRequest({ staffId, storeId, date: d, email });
    if (!savedList.length && !toAdd.length) await b.submitNoWish({ staffId, storeId, month, email }); // 「希望なし」で送信
    return { added: toAdd.length, removed: toRemove.length };
  }

  // 申請中・却下の希望休を1日消す（却下のあと、ほかの日を出し直すため）。承認済みは消せない
  async function removeWish(wish, { email }) {
    requireOpen(wish.month);
    if (wish.status === 'approved') throw new Error('承認済みの希望休は消せません。変更が必要なときは変更申請をしてください。');
    await requireBackend().removeWishRequest({ staffId: wish.staffId, storeId: wish.storeId, date: wish.date, email });
  }

  // ---- 変更申請（承認済みの希望休・有給の取り消し・日付の変更） ----
  // existing：その人のその月の変更申請。同じ対象に、申請中・承認済み（反映前）のものがあれば出せない
  async function requestChange({ kind, target, type, newDate, note, store, email, existing }) {
    if (!target || target.status !== 'approved') throw new Error('変更申請は、承認済みの希望休・有給にだけ出せます。');
    if (type === 'move') {
      if (!U.isValidDate(newDate) || newDate.slice(0, 7) !== target.month) throw new Error(`${monthLabel(target.month)}の日付を選んでください。`);
      if (newDate === target.date) throw new Error('今と同じ日付です。');
      if (store && K.calc.isStoreClosed(store, newDate)) throw new Error('定休日は選べません。');
    }
    const mine = (existing || []).filter((c) => c.kind === kind && c.targetId === target.id);
    if (mine.some((c) => c.status === 'pending' || (c.status === 'approved' && !c.reflectedAt))) throw new Error('この申請には、すでに変更申請を出しています。');
    const used = new Set(mine.map((c) => c.id));
    let attempt = 1;
    while (used.has(K.records.changeId(kind, target.id, attempt))) attempt += 1;
    if (attempt > K.records.MAX_CHANGE_ATTEMPTS) throw new Error(`同じ申請への変更申請は${K.records.MAX_CHANGE_ATTEMPTS}回までです。オーナーに相談してください。`);
    const change = K.records.newChange({ kind, target, type, newDate, note, email, now: U.nowIso(), attempt });
    await requireBackend().addChangeRequest(change);
    return change.id;
  }

  async function withdrawChange(change) {
    if (change.status !== 'pending') throw new Error('申請中の変更申請だけ取り下げられます。');
    await requireBackend().withdrawChangeRequest(change.id);
  }

  function changeText(c) {
    const what = c.kind === 'wish' ? '希望休' : '有給';
    return c.type === 'move' ? `${what} ${shortMd(c.date)} → ${shortMd(c.newDate)} に日付の変更` : `${what} ${shortMd(c.date)} の取り消し`;
  }

  function shortMd(date) {
    return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  }

  async function requestPaid({ staffId, storeId, month, date, note, store, email, existing }) {
    requireOpen(month);
    const err = checkDate(store, month, date);
    if (err) throw new Error(err);
    if ((existing || []).some((r) => r.date === date && r.status !== 'rejected')) throw new Error('この日は、すでに有給希望を出しています。');
    // 記録の名前は「スタッフID_日付_回数」。使われていない一番小さい回数で出す
    const used = new Set((existing || []).map((r) => r.id));
    let attempt = 1;
    while (used.has(`${staffId}_${date}_${attempt}`)) attempt += 1;
    if (attempt > MAX_PAID_ATTEMPTS) throw new Error(`同じ日の有給希望は${MAX_PAID_ATTEMPTS}回までです。管理者に相談してください。`);
    const cleanNote = String(note || '').trim().slice(0, 50);
    return requireBackend().addPaidRequest({ staffId, storeId, month, date, note: cleanNote, email, attempt });
  }

  async function withdrawPaid(request) {
    if (request.status !== 'pending') throw new Error('申請中のものだけ取り下げられます。');
    await requireBackend().withdrawPaidRequest(request.id);
  }

  // ---- 管理者 ----

  function setAdminData(d) {
    admin.settings = d.settings || null;
    admin.wishRequests = d.wishRequests || [];
    admin.wishCounts = d.wishCounts || [];
    admin.paidRequests = d.paidRequests || [];
    admin.changeRequests = d.changeRequests || [];
    admin.quotas = d.quotas || [];
    admin.logs = d.logs || [];
  }

  function clearAdminData() {
    setAdminData({});
  }

  const byDate = (a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || '');

  // 希望休（1日ごと）の一覧
  function adminWishes({ month, storeId, staffId } = {}) {
    return admin.wishRequests
      .filter((w) => (!month || w.month === month) && (!storeId || w.storeId === storeId) && (!staffId || w.staffId === staffId))
      .sort(byDate);
  }

  // 承認済みの希望休の日付（AIシフト作成で休みにする日）
  function adminWishDates(staffId, month) {
    return adminWishes({ month, staffId }).filter((w) => w.status === 'approved').map((w) => w.date);
  }

  // その日の希望休の状態（なければ null）。シフト表の印に使う
  function adminWishStatus(staffId, date) {
    const w = admin.wishRequests.find((x) => x.staffId === staffId && x.date === date);
    return w ? w.status : null;
  }

  // 希望休を一度でも送信したか（0日で送信した「希望なし」も含む）
  function adminHasWish(staffId, month) {
    return admin.wishCounts.some((c) => c.staffId === staffId && c.month === month) || admin.wishRequests.some((w) => w.staffId === staffId && w.month === month);
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
    return admin.paidRequests.filter((r) => (!month || r.month === month) && (!storeId || r.storeId === storeId)).sort(byDate);
  }

  // 承認済みの有給の日付（AIシフト作成で「有給」を入れる日）
  function adminApprovedPaidDates(staffId, month) {
    return admin.paidRequests.filter((r) => r.staffId === staffId && r.month === month && r.status === 'approved').map((r) => r.date);
  }

  // 変更申請の一覧（対象の月で絞る）
  function adminChanges({ month, storeId } = {}) {
    return admin.changeRequests.filter((c) => (!month || c.month === month) && (!storeId || c.storeId === storeId)).sort(byDate);
  }

  // 承認された変更申請を、シフト表に反映する（オーナーだけ）
  //   シフト表：元の日の「休み／有給」を空欄に戻す（取り消し・日付の変更）。日付の変更なら、新しい日に「休み／有給」を入れる
  //   申請の記録：元の申請を「取り消し済み」にし、日付の変更なら新しい日の承認済みの記録を作る。変更申請に反映の印（どれも履歴が残る）
  // 確定済みの月は、先に「確定を取り消す」が必要（シフト表を変えるため）
  async function reflectChange(change, { email, confirmOverwrite }) {
    if (change.status !== 'approved') throw new Error('承認された変更申請だけ反映できます。');
    if (change.reflectedAt) throw new Error('この変更申請は、すでに反映しています。');
    const list = change.kind === 'wish' ? admin.wishRequests : admin.paidRequests;
    const target = list.find((x) => x.id === change.targetId);
    if (!target || target.status !== 'approved') throw new Error('対象の申請が承認済みではないため、反映できません（すでに変えられた可能性があります）。');
    const { staffId, storeId, date } = change;
    if (K.storage.getPublication(storeId, change.month)) {
      throw new Error(`${Number(change.month.slice(5))}月のシフトは確定済みです。反映するときは、シフト表の「確定を取り消す」を押してから行ってください。`);
    }
    const cellKind = change.kind === 'wish' ? 'off' : 'paid';
    let newTarget = null;
    if (change.type === 'move') {
      const ex = K.storage.getShift(staffId, change.newDate, storeId);
      if (ex && ex.kind !== cellKind) {
        const kinds = { work: '通常勤務', off: '通常休', paid: '有給', business: '社用' };
        if (!confirmOverwrite(`${shortMd(change.newDate)}には「${kinds[ex.kind] || ex.kind}」が入っています。${cellKind === 'off' ? '休み' : '有給'}に変えますか？`)) return false;
      }
      if (change.kind === 'wish') {
        const id = K.records.wishId(staffId, change.newDate);
        if (admin.wishRequests.some((w) => w.id === id)) throw new Error(`${shortMd(change.newDate)}の希望休の記録がすでにあります。先にその記録を確かめてください。`);
        newTarget = { id, data: { ...K.records.newWish({ staffId, storeId, date: change.newDate, email, now: U.nowIso() }), status: 'approved', reason: '', fromChange: change.id } };
      } else {
        let attempt = 1;
        while (admin.paidRequests.some((p) => p.id === `${staffId}_${change.newDate}_${attempt}`)) attempt += 1;
        newTarget = {
          id: `${staffId}_${change.newDate}_${attempt}`,
          data: { staffId, storeId, month: change.month, date: change.newDate, status: 'approved', note: target.note || '', reason: '', originalDate: date, createdAt: U.nowIso(), updatedAt: U.nowIso(), createdBy: email, fromChange: change.id },
        };
      }
    }
    // シフト表（確定済みでないことは上で確かめた）
    const old = K.storage.getShift(staffId, date, storeId);
    if (old && (old.kind === 'off' || old.kind === 'paid')) K.storage.clearShift(staffId, date);
    if (change.type === 'move') K.storage.setShift(staffId, change.newDate, { kind: cellKind, storeId });
    await requireBackend().reflectChangeRequest({ change, target, newTarget, email });
    return true;
  }

  // 申請中の件数（AIシフト作成のお知らせ・確定の前の確認に使う）
  function pendingCounts(storeId, month) {
    return {
      wishes: adminWishes({ month, storeId }).filter((w) => w.status === 'pending').length,
      paid: adminPaid({ month, storeId }).filter((r) => r.status === 'pending').length,
      changes: adminChanges({ month, storeId }).filter((c) => c.status === 'pending').length,
    };
  }

  // 判断の履歴（新しい順）
  function adminLogs({ month, storeId } = {}) {
    return admin.logs.filter((l) => (!month || l.month === month) && (!storeId || l.storeId === storeId)).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
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

  // 判断する（承認・却下・申請中に戻す）。kind は 'wish'（希望休）か 'paid'（有給）。却下は理由が必須（50文字以内）
  // シフト表は変えない（承認済みの分は、AIシフト作成で空いているマスに入る。確定の前にオーナーが確かめる）
  // role：'owner'（全店舗・いつでも）/ 'manager'（段階③。担当店舗・受付期間だけ）
  async function decide(kind, record, { status, reason, email, role = 'owner' }) {
    if (role === 'manager') {
      const w = requestWindow();
      if (!w.open || record.month !== w.month) throw new Error('幹部が判断できるのは、受付期間（25日〜月末）の翌月分だけです。');
    }
    K.records.cleanReason(status, reason); // 理由の確認（画面にすぐ知らせるため。ルールでも確かめる）
    return requireBackend().decideRequest(kind, record, { status, reason, email, role });
  }

  // 有給の日付を変える（オーナーだけ・申請中のものだけ。元の日付も残し、履歴を残す）
  async function changePaidDate(request, newDate, { email, store }) {
    if (request.status !== 'pending') throw new Error('申請中のものだけ日付を変えられます。');
    if (!U.isValidDate(newDate)) throw new Error('日付が正しくありません。');
    if (store && K.calc.isStoreClosed(store, newDate)) throw new Error('定休日は選べません。');
    if (newDate === request.date) return false;
    await requireBackend().changePaidDateLogged(request, newDate, email || '');
    return true;
  }

  // 確定の前に確かめること：申請中のまま・承認済みなのにシフト表が違う
  function unresolved(storeId, month) {
    const wishes = adminWishes({ month, storeId });
    const paid = adminPaid({ month, storeId });
    const shiftOf = (r) => K.storage.getShift(r.staffId, r.date, storeId);
    return {
      pendingWishes: wishes.filter((w) => w.status === 'pending'),
      pendingPaid: paid.filter((r) => r.status === 'pending'),
      wishConflicts: wishes.filter((w) => w.status === 'approved' && shiftOf(w) && ['work', 'business'].includes(shiftOf(w).kind)),
      paidConflicts: paid.filter((r) => r.status === 'approved' && (!shiftOf(r) || shiftOf(r).kind !== 'paid')),
      pendingChanges: adminChanges({ month, storeId }).filter((c) => c.status === 'pending'),
      unreflectedChanges: adminChanges({ month, storeId }).filter((c) => c.status === 'approved' && !c.reflectedAt),
    };
  }

  // 土日祝か（スタッフの画面の案内に使う）
  function needsApproval(date) {
    const w = K.calc.weekdayOf(date);
    return w === 0 || w === 6 || Boolean(K.holidays.holidayName(date));
  }

  K.requests = {
    STATUS_LABELS,
    CHANGE_TYPE_LABELS,
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
    saveWishes,
    removeWish,
    requestPaid,
    withdrawPaid,
    requestChange,
    withdrawChange,
    changeText,
    adminChanges,
    reflectChange,
    setAdminData,
    clearAdminData,
    adminWishes,
    adminWishDates,
    adminWishStatus,
    adminHasWish,
    adminSettings,
    adminQuota,
    adminLimit,
    adminPaid,
    adminApprovedPaidDates,
    pendingCounts,
    adminLogs,
    setDefaultLimit,
    setQuota,
    decide,
    changePaidDate,
    unresolved,
    needsApproval,
  };
})();
