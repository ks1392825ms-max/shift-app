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
    // シフト確定の記録（店舗・月ごと）
    publications: (r) => isId(r.storeId) && /^\d{4}-\d{2}$/.test(r.month) && ['confirmed', 'draft'].includes(r.status),
    // スタッフのログイン用メール（スタッフの設定から作る対応表）
    staffAccounts: (r) =>
      isStr(r.email, 254) && r.id === r.email && Array.isArray(r.staffIds) && r.staffIds.every(isId) &&
      Array.isArray(r.storeIds) && r.storeIds.every(isId),
  };

  // 段階Aで足した項目（ある場合だけ）：正しくない値は使わない（記録そのものは取り込む）
  const POSITIONS = ['stylist', 'junior_stylist', 'junior_assistant', 'assistant'];
  const isWeekdays = (v) => Array.isArray(v) && v.every((w) => isInt(w, 0, 6));
  function cleanAddedFields(data) {
    // 自動作成の印（段階C）
    for (const s of data.shifts) {
      if (s.autoRunId !== undefined && !isId(s.autoRunId)) delete s.autoRunId;
    }
    for (const s of data.stores) {
      const ok =
        Array.isArray(s.closedNthWeekdays) &&
        s.closedNthWeekdays.every((x) => x && isInt(x.weekday, 0, 6) && Array.isArray(x.weeks) && x.weeks.length && x.weeks.every((w) => isInt(w, 1, 5)));
      if (s.closedNthWeekdays !== undefined && !ok) delete s.closedNthWeekdays;
    }
    for (const p of data.shiftPatterns) {
      if (p.dayType !== undefined && p.dayType !== null && !['weekday', 'holiday'].includes(p.dayType)) p.dayType = null;
      if (p.slot !== undefined && p.slot !== null && !['early', 'late'].includes(p.slot)) p.slot = null;
    }
    for (const m of data.staff) {
      if (m.position !== undefined && !POSITIONS.includes(m.position)) delete m.position;
      if (m.employment !== undefined && !['full', 'part'].includes(m.employment)) delete m.employment;
      for (const key of ['isNew', 'excludeFromCount']) if (m[key] !== undefined && typeof m[key] !== 'boolean') delete m[key];
      if (m.weeklyOffDays !== undefined && m.weeklyOffDays !== null && !isInt(m.weeklyOffDays, 1, 6)) delete m.weeklyOffDays;
      if (m.fixedOff !== undefined && !(m.fixedOff && isWeekdays(m.fixedOff.weekdays) && typeof m.fixedOff.holidays === 'boolean')) delete m.fixedOff;
      if (m.workWeekdays !== undefined && !isWeekdays(m.workWeekdays)) delete m.workWeekdays;
      if (m.note !== undefined && !isStr(m.note, 100)) delete m.note;
      if (m.email !== undefined && !(m.email === '' || (isStr(m.email, 254) && /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(m.email)))) delete m.email;
      if (m.personId !== undefined && m.personId !== null && !isId(m.personId)) delete m.personId;
    }
  }

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
      // 店舗ごとの勤務パターンの並び順（ある場合だけ）：正しくなければ使わない（時刻順に戻る）
      if (s.patternOrder !== undefined && !(Array.isArray(s.patternOrder) && s.patternOrder.length <= 500 && s.patternOrder.every(isId))) {
        delete s.patternOrder;
      }
    }
    cleanAddedFields(data);
    // 毎週の社用・必要人数の時間帯の並び順（ある場合だけ）：正しくなければ使わない
    for (const r of [...data.businessTimes, ...data.staffingRules]) {
      if (r.order !== undefined && !Number.isFinite(r.order)) delete r.order;
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
