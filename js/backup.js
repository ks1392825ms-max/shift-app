// バックアップファイルの作成・中身のチェック・2つのデータの合体を担当するファイル
// ここではデータを保存しない（保存は storage.js が行う）。
//
// ファイルの形：
// {
//   format: "shift-app-backup",   シフト管理のバックアップであることの目印
//   exportedAt: "2026-09-30T...",
//   data: { version, stores: [...], staff: [...], …, settings: {...} }
// }
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const FORMAT = 'shift-app-backup';
  const DATA_VERSION = 1;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  function buildFile(data) {
    // 「最後にバックアップした日時」などの記録そのものは、ファイルに入れない
    const settings = { ...(data.settings || {}) };
    delete settings.backup;
    return { format: FORMAT, exportedAt: U.nowIso(), data: { ...data, settings } };
  }

  // ---- 記録ごとのチェック（正しくないものは取り込まない） ----

  const isStr = (v, max = 200) => typeof v === 'string' && v.length <= max;
  const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
  const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const isTime = (v) => U.isValidTime(v);
  const isRange = (r) => r && isTime(r.start) && isTime(r.end) && r.start < r.end;
  // 勤務パターンの出勤・退勤は15分単位まで
  const isPatternRange = (r) => r && U.isValidTime(r.start, 15) && U.isValidTime(r.end, 15) && r.start < r.end;
  // 曜日ごとのいつもの勤務：{ "0"〜"6": 勤務パターンID または "off" }
  const isWeekly = (w) =>
    w === undefined || (w && typeof w === 'object' && !Array.isArray(w) && Object.entries(w).every(([k, v]) => /^[0-6]$/.test(k) && (v === 'off' || isId(v))));
  const isOptDate = (v) => v === '' || v === undefined || U.isValidDate(v);
  const isCount = (v) => isInt(v, 0, 50);
  const isOptCount = (v) => v === null || v === undefined || isCount(v);
  const isBand = (b) => isRange(b) && isCount(b.stMin) && isCount(b.asMin) && isOptCount(b.stMax) && isOptCount(b.asMax);

  function common(r) {
    return r && typeof r === 'object' && isId(r.id) && ISO_RE.test(r.createdAt) && ISO_RE.test(r.updatedAt) && typeof r.deleted === 'boolean';
  }

  const CHECKERS = {
    stores: (r) =>
      isStr(r.name, 10) && r.name.trim() && COLOR_RE.test(r.color) && isTime(r.open) && isTime(r.close) && r.open < r.close &&
      Array.isArray(r.closedWeekdays) && r.closedWeekdays.every((w) => isInt(w, 0, 6)) && Number.isFinite(r.order),
    staff: (r) =>
      isStr(r.name, 12) && r.name.trim() && isId(r.storeId) && ['stylist', 'assistant'].includes(r.role) && isStr(r.title || '', 10) &&
      Array.isArray(r.patternIds) && r.patternIds.every(isId) && typeof r.active === 'boolean' && Number.isFinite(r.order) &&
      isWeekly(r.weeklyPatterns),
    shiftPatterns: (r) =>
      isPatternRange(r) && isInt(r.breakMinutes, 0, 24 * 60) && isStr(r.label, 12) && r.label.trim() && COLOR_RE.test(r.color) &&
      (r.storeId === undefined || r.storeId === null || isId(r.storeId)),
    shifts: (r) =>
      isId(r.staffId) && U.isValidDate(r.date) && ['work', 'off', 'paid', 'business'].includes(r.kind) &&
      (r.patternId === null || r.patternId === undefined || isId(r.patternId)) &&
      (r.storeId === undefined || isId(r.storeId)) &&
      (r.breaks === undefined || (Array.isArray(r.breaks) && r.breaks.every(isRange))),
    businessTimes: (r) =>
      isId(r.staffId) && isRange(r) && isStr(r.note || '', 20) &&
      ((r.type === 'date' && U.isValidDate(r.date)) || (r.type === 'weekly' && isInt(r.weekday, 0, 6) && isOptDate(r.validFrom) && isOptDate(r.validTo))),
    businessTimeSkips: (r) => isId(r.businessTimeId) && U.isValidDate(r.date),
    staffingRules: (r) => isId(r.storeId) && ['weekday', 'holiday'].includes(r.dayType) && isBand(r),
    dayOverrides: (r) =>
      isId(r.storeId) && U.isValidDate(r.date) &&
      ((r.mode === 'type' && ['weekday', 'holiday'].includes(r.dayType)) || (r.mode === 'custom' && Array.isArray(r.bands) && r.bands.every(isBand))),
    holidays: (r) => U.isValidDate(r.date) && (r.action === 'remove' || (r.action === 'add' && isStr(r.name, 12))),
    requests: () => true, // 将来の機能。形だけ引き継ぐ
  };

  // チェックの基準：正しくない値は初期値にする
  function cleanChecks(checks) {
    const d = K.defaults.checks;
    const c = checks && typeof checks === 'object' ? checks : {};
    const num = (key, min, max) => (Number.isFinite(c[key]) && c[key] >= min && c[key] <= max ? c[key] : d[key]);
    const bool = (key) => (typeof c[key] === 'boolean' ? c[key] : d[key]);
    return {
      maxConsecutiveDays: num('maxConsecutiveDays', 1, 31),
      monthlyOffDays: num('monthlyOffDays', 0, 31),
      shortageMinSlots: num('shortageMinSlots', 1, 48),
      hoursCheckEnabled: bool('hoursCheckEnabled'),
      dailyHoursLimit: num('dailyHoursLimit', 1, 24),
      weeklyHoursLimit: num('weeklyHoursLimit', 1, 168),
      countPaidLeaveAsOff: bool('countPaidLeaveAsOff'),
      closedDayAsOff: bool('closedDayAsOff'),
    };
  }

  // ファイルの文字を読み取り、チェック済みのデータを返す
  // 戻り値：{ exportedAt, data（storage と同じ形）, skipped（取り込まなかった件数）, counts（種類ごとの件数） }
  function parseFile(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      throw new Error('ファイルを読み込めませんでした。シフト管理のバックアップファイルか確認してください。');
    }
    if (!obj || obj.format !== FORMAT || !obj.data || typeof obj.data !== 'object') {
      throw new Error('シフト管理のバックアップファイルではありません。');
    }
    if (typeof obj.data.version !== 'number' || obj.data.version > DATA_VERSION) {
      throw new Error('このアプリより新しい形式のファイルです。アプリを最新にしてください。');
    }

    const data = { version: DATA_VERSION };
    let skipped = 0;
    for (const key of K.storage.LIST_KEYS) {
      const list = Array.isArray(obj.data[key]) ? obj.data[key] : [];
      data[key] = list.filter((r) => {
        const valid = common(r) && CHECKERS[key](r);
        if (!valid) skipped += 1;
        return valid;
      });
    }
    // 臨時休業日の機能はなくしたので、古いファイルに入っていても使わない
    for (const s of data.stores) {
      delete s.closedDates;
      // 店舗専用のチェックの基準（ある場合だけ）：正しくない値は初期値にする
      if (s.checks !== undefined) s.checks = cleanChecks(s.checks);
    }

    if (data.stores.filter((s) => !s.deleted).length === 0) {
      throw new Error('ファイルに店舗の情報が入っていません。シフト管理のバックアップファイルか確認してください。');
    }

    const settings = obj.data.settings && typeof obj.data.settings === 'object' ? obj.data.settings : {};
    data.settings = {
      checks: cleanChecks(settings.checks),
      updatedAt: ISO_RE.test(settings.updatedAt) ? settings.updatedAt : '2000-01-01T00:00:00.000Z',
    };

    const counts = {
      staff: data.staff.filter((s) => !s.deleted).length,
      shifts: data.shifts.filter((s) => !s.deleted).length,
    };
    return { exportedAt: ISO_RE.test(obj.exportedAt) ? obj.exportedAt : null, data, skipped, counts };
  }

  // 同じ id の記録は、更新日時が新しいほうを残す
  function mergeList(localList, incomingList, stats) {
    const byId = new Map(localList.map((x) => [x.id, x]));
    const incomingIds = new Set();
    for (const inc of incomingList) {
      incomingIds.add(inc.id);
      const loc = byId.get(inc.id);
      if (!loc) {
        byId.set(inc.id, inc);
        stats.added += 1;
      } else if (inc.updatedAt > loc.updatedAt) {
        byId.set(inc.id, inc);
        stats.updated += 1;
      } else if (loc.updatedAt > inc.updatedAt) {
        stats.localNewer += 1;
      }
    }
    stats.localNewer += localList.filter((x) => !incomingIds.has(x.id)).length;
    return [...byId.values()];
  }

  // この端末のデータ（local）と、ファイルのデータ（incoming）を合体する
  // 戻り値：{ data, stats: { added, updated, localNewer } }
  function mergeData(local, incoming) {
    const stats = { added: 0, updated: 0, localNewer: 0 };
    const data = { version: DATA_VERSION };
    for (const key of K.storage.LIST_KEYS) data[key] = mergeList(local[key] || [], incoming[key] || [], stats);
    // チェックの基準は、あとから変更したほう
    const localSettings = local.settings || {};
    data.settings =
      (incoming.settings.updatedAt || '') > (localSettings.updatedAt || '')
        ? { ...localSettings, checks: incoming.settings.checks, updatedAt: incoming.settings.updatedAt }
        : localSettings;
    return { data, stats };
  }

  K.backup = { buildFile, parseFile, mergeData };
})();
