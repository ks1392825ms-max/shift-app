// データの保存・読み込みを担当するファイル
// 画面のファイルは、必ずこのファイルの関数を通してデータを読み書きする。
// 将来インターネット上の保存（スタッフが入力できる形）に切り替えるときも、変更するのは基本的にこのファイルだけ。
//
// 保存されるデータの形：
// {
//   version: 1,
//   stores: [...],            店舗
//   staff: [...],             スタッフ
//   shiftPatterns: [...],     勤務パターン
//   shifts: [...],            シフト（Step2〜）
//   businessTimes: [...],     社用時間（Step3〜）
//   businessTimeSkips: [...], 毎週の社用時間の取り消し（Step3〜）
//   staffingRules: [...],     必要人数（Step4〜）
//   dayOverrides: [...],      日付ごとの上書き（Step4〜）
//   holidays: [...],          祝日の手直し（Step4〜）
//   requests: [...],          スタッフの希望（将来）
//   settings: { checks: {...} }
// }
// すべての記録に id / createdAt / updatedAt / deleted を持たせる（同期のため）。
// 削除は本当に消さず deleted: true にする。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  // 家計簿アプリとは別の名前で保存する（同じブラウザで開いても混ざらないように）
  const STORAGE_KEY = 'shift-app-data';
  const DATA_VERSION = 1;
  const DEFAULTS_TIMESTAMP = '2000-01-01T00:00:00.000Z'; // 初期データの日時（同期で編集したほうが必ず優先されるように）
  const LIST_KEYS = [
    'stores', 'staff', 'shiftPatterns', 'shifts', 'businessTimes', 'businessTimeSkips',
    'staffingRules', 'dayOverrides', 'holidays', 'requests',
  ];
  const ROLES = ['stylist', 'assistant'];
  const MAX_STORE_NAME = 10;
  const MAX_STAFF_NAME = 12;
  const MAX_TITLE = 10;
  const MAX_PATTERN_LABEL = 12; // "10:30-19:30"（11文字）が入る長さ

  let data = null;

  function stamp(record) {
    return { ...record, createdAt: DEFAULTS_TIMESTAMP, updatedAt: DEFAULTS_TIMESTAMP, deleted: false };
  }

  function createInitialData() {
    const obj = { version: DATA_VERSION };
    for (const key of LIST_KEYS) obj[key] = [];
    obj.stores = K.defaults.stores.map((s, i) => stamp({ ...s, closedWeekdays: [...s.closedWeekdays], order: i }));
    obj.shiftPatterns = K.defaults.shiftPatterns.map((p) => stamp({ ...p }));
    obj.settings = { checks: { ...K.defaults.checks }, updatedAt: DEFAULTS_TIMESTAMP };
    return obj;
  }

  // 古い形式のデータを、今の形式に変換する（今はバージョン1だけなので確認のみ）
  function migrate(obj) {
    if (!obj || typeof obj.version !== 'number') throw new Error('データの形式が正しくありません。');
    if (obj.version > DATA_VERSION) throw new Error('このアプリより新しい形式のデータです。アプリを最新にしてください。');
    for (const key of LIST_KEYS) obj[key] = Array.isArray(obj[key]) ? obj[key] : [];
    // 臨時休業日の機能はなくしたので、以前のデータに残っていても使わない
    for (const s of obj.stores) delete s.closedDates;
    obj.settings = obj.settings || {};
    obj.settings.checks = { ...K.defaults.checks, ...(obj.settings.checks || {}) };
    return obj;
  }

  // 最後に読み込んだ・保存した内容（別のタブやウィンドウで変更されたかを見分けるため）
  let lastSaved = null;
  let externalChangeHandler = null;

  // 別のタブで保存された内容を読み込み直す
  function reloadFromStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === lastSaved) return false;
    data = migrate(JSON.parse(raw));
    lastSaved = raw;
    return true;
  }

  // 変更して保存する。保存に失敗したら、変更前の状態に戻す
  // 通常の変更では「バックアップしていない変更あり」の目印を付ける（markChanged: false で付けない）
  function commit(mutate, { markChanged = true } = {}) {
    // 別のタブで先に保存されていたら、古い内容で上書きしないよう、最新を読み込んでやり直してもらう
    if (reloadFromStorage()) {
      if (externalChangeHandler) setTimeout(externalChangeHandler, 0);
      throw new Error('別のタブ（ウィンドウ）で変更されていたので、最新の内容を読み込みました。もう一度操作してください。');
    }
    const backup = JSON.stringify(data);
    mutate(data);
    if (markChanged) {
      data.settings.backup = { ...(data.settings.backup || {}), changedSinceBackup: true };
    }
    try {
      const raw = JSON.stringify(data);
      localStorage.setItem(STORAGE_KEY, raw);
      lastSaved = raw;
    } catch (err) {
      data = JSON.parse(backup);
      throw new Error('保存に失敗しました。ブラウザの設定や空き容量を確認してください。');
    }
  }

  // 別のタブで保存されたときに呼ぶ処理を登録する（画面の作り直しなど）
  function onExternalChange(handler) {
    externalChangeHandler = handler;
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      try {
        if (reloadFromStorage()) handler();
      } catch (err) {
        console.error(err);
      }
    });
  }

  // ブラウザに「このデータは消さないで」と頼む（対応しているブラウザだけ）
  function requestPersistence() {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {});
    }
  }

  // 保存の状態：{ persisted（消されにくい設定になっているか：true/false/null＝不明）, usage, quota }
  // ブラウザが答えない場合に備えて、2秒で打ち切って「不明」にする
  async function getStorageInfo() {
    const info = { persisted: null, usage: null, quota: null };
    const ask = async () => {
      if (navigator.storage && navigator.storage.persisted) info.persisted = await navigator.storage.persisted();
      if (navigator.storage && navigator.storage.estimate) Object.assign(info, await navigator.storage.estimate());
    };
    try {
      await Promise.race([ask(), new Promise((resolve) => setTimeout(resolve, 2000))]);
    } catch (err) {
      // 対応していないブラウザでは不明のまま
    }
    return info;
  }

  // 起動時に1回だけ呼ぶ。結果を { ok, message } で返す
  function init() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return {
        ok: false,
        message: 'このブラウザではデータを保存できません。プライベートブラウズを使っている場合は、通常のウィンドウで開いてください。',
      };
    }

    requestPersistence();

    if (raw === null) {
      data = createInitialData();
      try {
        const initial = JSON.stringify(data);
        localStorage.setItem(STORAGE_KEY, initial);
        lastSaved = initial;
      } catch (err) {
        return { ok: false, message: 'データを保存できませんでした。ブラウザの設定を確認してください。' };
      }
      return { ok: true };
    }

    try {
      data = migrate(JSON.parse(raw));
      lastSaved = raw;
    } catch (err) {
      // 読めないデータを上書きしないよう、ここで止める
      console.error(err);
      return {
        ok: false,
        message: `保存されているデータを読み込めませんでした（${err.message}）。データは消さずにそのまま残しています。`,
      };
    }
    return { ok: true };
  }

  // ---- 共通 ----

  function copy(record) {
    return JSON.parse(JSON.stringify(record));
  }

  function active(list) {
    return list.filter((x) => !x.deleted);
  }

  function findActive(list, id, notFoundMessage) {
    const found = list.find((x) => x.id === id && !x.deleted);
    if (!found) throw new Error(notFoundMessage);
    return found;
  }

  function cleanText(value, { label, max, required }) {
    const text = String(value ?? '').trim();
    if (required && !text) throw new Error(`${label}を入力してください。`);
    if (text.length > max) throw new Error(`${label}は${max}文字以内で入力してください。`);
    return text;
  }

  function cleanColor(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(color))) throw new Error('色が正しくありません。');
    return color.toLowerCase();
  }

  function nextOrder(list) {
    return Math.max(-1, ...list.map((x) => x.order ?? -1)) + 1;
  }

  // ---- 店舗（A店・B店の2つ。追加・削除はしない） ----

  function getStores() {
    return active(data.stores)
      .sort((a, b) => a.order - b.order)
      .map(copy);
  }

  function getStore(id) {
    const s = data.stores.find((x) => x.id === id);
    return s ? copy(s) : null;
  }

  function updateStore(id, fields) {
    findActive(data.stores, id, '店舗が見つかりませんでした。');

    const name = cleanText(fields.name, { label: '店舗名', max: MAX_STORE_NAME, required: true });
    if (active(data.stores).some((s) => s.id !== id && s.name === name)) {
      throw new Error(`「${name}」はすでにあります。別の名前にしてください。`);
    }

    if (!U.isValidTime(fields.open) || !U.isValidTime(fields.close)) throw new Error('営業時間が正しくありません。');
    if (U.toMinutes(fields.open) >= U.toMinutes(fields.close)) throw new Error('閉店時刻は開店時刻より後にしてください。');

    const closedWeekdays = [...new Set(fields.closedWeekdays)].map(Number).sort((a, b) => a - b);
    if (closedWeekdays.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) throw new Error('定休日が正しくありません。');
    if (closedWeekdays.length === 7) throw new Error('すべての曜日を定休日にはできません。');

    commit((d) => {
      Object.assign(d.stores.find((s) => s.id === id), {
        name,
        open: fields.open,
        close: fields.close,
        closedWeekdays,
        updatedAt: U.nowIso(),
      });
    });
  }

  // ---- 勤務パターン ----

  // 開始時刻の早い順
  function getPatterns() {
    return active(data.shiftPatterns)
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
      .map(copy);
  }

  function getPattern(id) {
    const p = data.shiftPatterns.find((x) => x.id === id);
    return p ? copy(p) : null;
  }

  function normalizePattern(fields, exceptId) {
    if (!U.isValidTime(fields.start) || !U.isValidTime(fields.end)) throw new Error('勤務時間が正しくありません。');
    const duration = U.toMinutes(fields.end) - U.toMinutes(fields.start);
    if (duration <= 0) throw new Error('終了時刻は開始時刻より後にしてください。');

    const breakMinutes = Number(fields.breakMinutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes % 15 !== 0) {
      throw new Error('休憩の長さが正しくありません。');
    }
    if (breakMinutes >= duration) throw new Error('休憩の長さは、勤務時間より短くしてください。');

    const label = cleanText(fields.label, { label: '表示名', max: MAX_PATTERN_LABEL, required: true });
    if (active(data.shiftPatterns).some((p) => p.id !== exceptId && p.label === label)) {
      throw new Error(`表示名「${label}」はすでにあります。別の表示名にしてください。`);
    }

    return { start: fields.start, end: fields.end, breakMinutes, label, color: cleanColor(fields.color) };
  }

  function addPattern(fields) {
    const clean = normalizePattern(fields);
    const now = U.nowIso();
    const pattern = { id: U.uuid(), ...clean, createdAt: now, updatedAt: now, deleted: false };
    commit((d) => d.shiftPatterns.push(pattern));
    return copy(pattern);
  }

  function updatePattern(id, fields) {
    findActive(data.shiftPatterns, id, '勤務パターンが見つかりませんでした。');
    const clean = normalizePattern(fields, id);
    commit((d) => {
      Object.assign(d.shiftPatterns.find((p) => p.id === id), clean, { updatedAt: U.nowIso() });
    });
  }

  // この勤務パターンを使えるスタッフ（削除されていない人）
  function getPatternUsers(id) {
    return active(data.staff)
      .filter((s) => s.patternIds.includes(id))
      .map(copy);
  }

  // 削除すると、スタッフの「使える勤務パターン」からも外れる。
  // それで使えるパターンが0になるスタッフがいる場合は削除できない
  function deletePattern(id) {
    findActive(data.shiftPatterns, id, '勤務パターンが見つかりませんでした。');
    const stuck = getPatternUsers(id).filter((s) => s.patternIds.filter((p) => p !== id).length === 0);
    if (stuck.length) {
      const names = stuck.map((s) => s.name).join('、');
      throw new Error(`${names} さんが使える勤務パターンがなくなるため、削除できません。先にスタッフの設定で別のパターンを選んでください。`);
    }
    commit((d) => {
      const now = U.nowIso();
      const pattern = d.shiftPatterns.find((p) => p.id === id);
      pattern.deleted = true;
      pattern.updatedAt = now;
      for (const s of d.staff) {
        if (!s.deleted && s.patternIds.includes(id)) {
          s.patternIds = s.patternIds.filter((p) => p !== id);
          s.updatedAt = now;
        }
      }
    });
  }

  // ---- スタッフ ----

  // storeId を指定するとその店舗だけ。includeInactive で在籍していない人も含める
  function getStaff({ storeId, includeInactive = false } = {}) {
    return active(data.staff)
      .filter((s) => (!storeId || s.storeId === storeId) && (includeInactive || s.active))
      .sort((a, b) => a.order - b.order)
      .map(copy);
  }

  function getStaffMember(id) {
    const s = data.staff.find((x) => x.id === id);
    return s ? copy(s) : null;
  }

  function normalizeStaff(fields, exceptId) {
    const name = cleanText(fields.name, { label: '表示名', max: MAX_STAFF_NAME, required: true });
    if (active(data.staff).some((s) => s.id !== exceptId && s.name === name)) {
      throw new Error(`「${name}」さんはすでに登録されています。別の表示名にしてください。`);
    }

    findActive(data.stores, fields.storeId, '所属店舗を選んでください。');
    if (!ROLES.includes(fields.role)) throw new Error('役割（スタイリスト／アシスタント）を選んでください。');

    const title = cleanText(fields.title, { label: '肩書き', max: MAX_TITLE, required: false });

    const patternIds = [...new Set(fields.patternIds || [])];
    if (patternIds.length === 0) throw new Error('使える勤務パターンを1つ以上選んでください。');
    for (const pid of patternIds) findActive(data.shiftPatterns, pid, '選んだ勤務パターンが見つかりませんでした。');

    return { name, storeId: fields.storeId, role: fields.role, title, patternIds, active: fields.active !== false };
  }

  function addStaff(fields) {
    const clean = normalizeStaff(fields);
    const now = U.nowIso();
    const member = { id: U.uuid(), ...clean, order: nextOrder(data.staff), createdAt: now, updatedAt: now, deleted: false };
    commit((d) => d.staff.push(member));
    return copy(member);
  }

  function updateStaff(id, fields) {
    const current = findActive(data.staff, id, 'スタッフが見つかりませんでした。');
    const clean = normalizeStaff({ ...current, ...fields }, id);
    commit((d) => {
      const s = d.staff.find((x) => x.id === id);
      const moved = clean.storeId !== s.storeId;
      if (moved) {
        // 店舗を移っても、これまでのシフトは元の店舗の記録として残す
        // （店舗の記録がない以前のシフトに、元の店舗を書き込む。内容は変わらないので更新日時は変えない）
        for (const shift of d.shifts) {
          if (shift.staffId === id && !shift.storeId) shift.storeId = s.storeId;
        }
      }
      // 店舗を変えたときは、新しい店舗の一番下に並べる
      const order = moved ? nextOrder(d.staff) : s.order;
      Object.assign(s, clean, { order, updatedAt: U.nowIso() });
    });
  }

  // 同じ店舗・在籍中のスタッフの中で、1つ上（-1）か1つ下（+1）と入れ替える
  function moveStaff(id, direction) {
    const current = findActive(data.staff, id, 'スタッフが見つかりませんでした。');
    const list = getStaff({ storeId: current.storeId });
    const index = list.findIndex((s) => s.id === id);
    const other = list[index + direction];
    if (index < 0 || !other) return;
    commit((d) => {
      const a = d.staff.find((s) => s.id === id);
      const b = d.staff.find((s) => s.id === other.id);
      [a.order, b.order] = [b.order, a.order];
      a.updatedAt = b.updatedAt = U.nowIso();
    });
  }

  // 間違えて登録したときの削除。辞めた人は「在籍中」を外す（過去のシフトを残すため）
  function deleteStaff(id) {
    findActive(data.staff, id, 'スタッフが見つかりませんでした。');
    commit((d) => {
      const s = d.staff.find((x) => x.id === id);
      s.deleted = true;
      s.updatedAt = U.nowIso();
    });
  }

  // ---- シフト ----
  // 1人の1日につき1件。id を「スタッフID＋日付」から作るので、
  // 同期で2台が同じマスを編集しても重複せず、新しいほうが残る。
  // kind：'work'（通常勤務）/ 'off'（通常休）/ 'paid'（有給）/ 'business'（社用：出勤するが予約は受けない）
  // 通常勤務と社用は、勤務パターン（patternId）で時間を持つ

  const SHIFT_KINDS = ['work', 'off', 'paid', 'business'];
  const TIMED_KINDS = ['work', 'business'];

  function shiftId(staffId, date) {
    return `shift_${staffId}_${date}`;
  }

  // month（"2026-10"）や staffId で絞り込める
  // シフトがどの店舗の勤務か
  // これから入力するシフトには storeId を記録する。店舗の記録がない以前のシフトは、スタッフの所属店舗とみなす
  function shiftStoreId(shift) {
    if (shift.storeId) return shift.storeId;
    const member = data.staff.find((m) => m.id === shift.staffId);
    return member ? member.storeId : null;
  }

  // month（"2026-10"）・staffId・storeId（その店舗の勤務だけ）で絞り込める
  function getShifts({ month, staffId, storeId } = {}) {
    return active(data.shifts)
      .filter(
        (s) =>
          (!month || s.date.startsWith(`${month}-`)) && (!staffId || s.staffId === staffId) && (!storeId || shiftStoreId(s) === storeId)
      )
      .map((s) => ({ ...copy(s), storeId: shiftStoreId(s) }));
  }

  // storeId を渡すと、その店舗の勤務のときだけ返す
  function getShift(staffId, date, storeId) {
    const s = data.shifts.find((x) => x.id === shiftId(staffId, date) && !x.deleted);
    if (!s || (storeId && shiftStoreId(s) !== storeId)) return null;
    return { ...copy(s), storeId: shiftStoreId(s) };
  }

  // storeId（入力している店舗）は必ず指定する。スタッフの所属店舗か、その日のシフトがすでに記録されている店舗でなければ入力できない
  function setShift(staffId, date, { kind, patternId, storeId }) {
    const member = findActive(data.staff, staffId, 'スタッフが見つかりませんでした。');
    if (!U.isValidDate(date)) throw new Error('日付が正しくありません。');
    const store = findActive(data.stores, storeId, '店舗を選んでください。');
    const existingShift = data.shifts.find((x) => x.id === shiftId(staffId, date) && !x.deleted);
    if (member.storeId !== store.id && !(existingShift && shiftStoreId(existingShift) === store.id)) {
      const home = data.stores.find((s) => s.id === member.storeId);
      throw new Error(`${member.name}さんは${home ? home.name : '別の店舗'}の所属です。${store.name}のシフトには入力できません。`);
    }
    if (existingShift && shiftStoreId(existingShift) !== store.id) {
      const other = data.stores.find((s) => s.id === shiftStoreId(existingShift));
      throw new Error(`この日は${other ? other.name : '別の店舗'}のシフトが入っています。`);
    }
    if (!SHIFT_KINDS.includes(kind)) throw new Error('通常勤務・通常休・有給・社用のどれかを選んでください。');
    if (TIMED_KINDS.includes(kind)) {
      findActive(data.shiftPatterns, patternId, '勤務パターンが見つかりませんでした。');
      if (!member.patternIds.includes(patternId)) {
        throw new Error(`この勤務パターンは${member.name}さんに登録されていません。設定画面で追加してください。`);
      }
    }

    const id = shiftId(staffId, date);
    const now = U.nowIso();
    const fields = { kind, patternId: TIMED_KINDS.includes(kind) ? patternId : null, storeId: store.id };
    commit((d) => {
      const existing = d.shifts.find((s) => s.id === id);
      // 休憩は通常勤務の日だけ。勤務時間を変えたときは、新しい勤務時間に収まる休憩だけ残す
      fields.breaks = [];
      if (existing && !existing.deleted && kind === 'work' && Array.isArray(existing.breaks)) {
        const p = data.shiftPatterns.find((x) => x.id === patternId);
        fields.breaks = existing.breaks.filter((b) => b.start >= p.start && b.end <= p.end);
      }
      if (existing) Object.assign(existing, fields, { deleted: false, updatedAt: now });
      else d.shifts.push({ id, staffId, date, ...fields, createdAt: now, updatedAt: now, deleted: false });
    });
    return getShift(staffId, date);
  }

  // 30分刻みの時間帯のチェック。within（{start, end}）を渡すと、その範囲内かも確かめる
  function checkRange(range, label, within) {
    if (!range || !U.isValidTime(range.start) || !U.isValidTime(range.end)) throw new Error(`${label}の時刻が正しくありません。`);
    if (range.start >= range.end) throw new Error(`${label}の終了時刻は、開始時刻より後にしてください。`);
    if (within && (range.start < within.start || range.end > within.end)) {
      throw new Error(`${label}は勤務時間（${U.formatTime(within.start)}〜${U.formatTime(within.end)}）の中で設定してください。`);
    }
    return { start: range.start, end: range.end };
  }

  function overlaps(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  // その日の通常勤務のシフトと勤務時間（なければエラー）
  function workShiftOf(staffId, date, label) {
    const shift = getShift(staffId, date);
    if (!shift || shift.kind !== 'work') throw new Error(`${label}は、通常勤務の日だけ設定できます。`);
    const pattern = getPattern(shift.patternId);
    return { shift, range: { start: pattern.start, end: pattern.end } };
  }

  // その日の休憩をまとめて保存する（breaks：[{ start, end }]。空の配列で休憩なし）
  function setShiftBreaks(staffId, date, breaks) {
    const { range } = workShiftOf(staffId, date, '休憩');
    const clean = breaks.map((b) => checkRange(b, '休憩', range)).sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < clean.length; i++) {
      if (overlaps(clean[i - 1], clean[i])) throw new Error('休憩の時間が重なっています。');
    }
    const id = shiftId(staffId, date);
    commit((d) => {
      Object.assign(d.shifts.find((s) => s.id === id), { breaks: clean, updatedAt: U.nowIso() });
    });
  }

  // ---- 社用時間 ----
  // type：'date'（日付指定：date）/ 'weekly'（毎週：weekday。validFrom〜validTo の期間だけ。空なら期限なし）
  // 毎週分は「この日だけ取り消し」（businessTimeSkips）ができる

  const MAX_BUSINESS_NOTE = 20;

  function getBusinessTimes({ staffId, type } = {}) {
    return active(data.businessTimes)
      .filter((b) => (!staffId || b.staffId === staffId) && (!type || b.type === type))
      .sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.date || '').localeCompare(b.date || '') || a.start.localeCompare(b.start))
      .map(copy);
  }

  function normalizeBusinessTime(fields, exceptId) {
    const member = findActive(data.staff, fields.staffId, 'スタッフを選んでください。');
    const note = cleanText(fields.note, { label: 'メモ', max: MAX_BUSINESS_NOTE, required: false });
    const clean = { staffId: member.id, type: fields.type, note };

    if (fields.type === 'date') {
      if (!U.isValidDate(fields.date)) throw new Error('日付が正しくありません。');
      const { range } = workShiftOf(member.id, fields.date, '日付を指定した社用時間');
      Object.assign(clean, { date: fields.date, ...checkRange(fields, '社用時間', range) });
      const sameDay = active(data.businessTimes).filter(
        (b) => b.id !== exceptId && b.type === 'date' && b.staffId === member.id && b.date === fields.date
      );
      if (sameDay.some((b) => overlaps(b, clean))) throw new Error('この日の社用時間と重なっています。');
    } else if (fields.type === 'weekly') {
      const weekday = Number(fields.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('曜日を選んでください。');
      const validFrom = fields.validFrom || '';
      const validTo = fields.validTo || '';
      if ((validFrom && !U.isValidDate(validFrom)) || (validTo && !U.isValidDate(validTo))) throw new Error('有効期間の日付が正しくありません。');
      if (validFrom && validTo && validFrom > validTo) throw new Error('有効期間の終了日は、開始日以降にしてください。');
      Object.assign(clean, { weekday, validFrom, validTo, ...checkRange(fields, '社用時間') });
    } else {
      throw new Error('社用時間の種類が正しくありません。');
    }
    return clean;
  }

  function addBusinessTime(fields) {
    const clean = normalizeBusinessTime(fields);
    const now = U.nowIso();
    const record = { id: U.uuid(), ...clean, createdAt: now, updatedAt: now, deleted: false };
    commit((d) => d.businessTimes.push(record));
    return copy(record);
  }

  function updateBusinessTime(id, fields) {
    const current = findActive(data.businessTimes, id, '社用時間が見つかりませんでした。');
    const clean = normalizeBusinessTime({ ...current, ...fields, type: current.type }, id);
    commit((d) => {
      Object.assign(d.businessTimes.find((b) => b.id === id), clean, { updatedAt: U.nowIso() });
    });
  }

  function deleteBusinessTime(id) {
    findActive(data.businessTimes, id, '社用時間が見つかりませんでした。');
    commit((d) => {
      const b = d.businessTimes.find((x) => x.id === id);
      b.deleted = true;
      b.updatedAt = U.nowIso();
    });
  }

  // 毎週の社用時間を「この日だけ取り消し」にする（skip = false で取り消しを戻す）
  function skipId(businessTimeId, date) {
    return `skip_${businessTimeId}_${date}`;
  }

  function isBusinessTimeSkipped(businessTimeId, date) {
    return data.businessTimeSkips.some((s) => s.id === skipId(businessTimeId, date) && !s.deleted);
  }

  function setBusinessTimeSkip(businessTimeId, date, skip) {
    const bt = findActive(data.businessTimes, businessTimeId, '社用時間が見つかりませんでした。');
    if (bt.type !== 'weekly') throw new Error('取り消しできるのは、毎週の社用時間だけです。');
    if (!U.isValidDate(date)) throw new Error('日付が正しくありません。');
    const id = skipId(businessTimeId, date);
    const now = U.nowIso();
    commit((d) => {
      const existing = d.businessTimeSkips.find((s) => s.id === id);
      if (existing) Object.assign(existing, { deleted: !skip, updatedAt: now });
      else if (skip) d.businessTimeSkips.push({ id, businessTimeId, date, createdAt: now, updatedAt: now, deleted: false });
    });
  }

  // 未入力に戻す
  function clearShift(staffId, date) {
    const id = shiftId(staffId, date);
    if (!data.shifts.some((s) => s.id === id && !s.deleted)) return;
    commit((d) => {
      const s = d.shifts.find((x) => x.id === id);
      s.deleted = true;
      s.updatedAt = U.nowIso();
    });
  }

  // ---- 必要人数 ----
  // 店舗 × 日の区分（weekday：平日 / holiday：土日祝）ごとに、時間帯とスタイリスト・アシスタントの最低人数・上限
  // 上限（stMax / asMax）は null なら「上限なし」

  const DAY_TYPES = ['weekday', 'holiday'];
  const MAX_PEOPLE = 50;

  function cleanCount(value, label, { optional } = {}) {
    if (optional && (value === '' || value === null || value === undefined)) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PEOPLE) throw new Error(`${label}は0〜${MAX_PEOPLE}の整数で入力してください。`);
    return n;
  }

  // 1つの時間帯の必要人数をチェックして整える
  function normalizeBand(band) {
    const clean = checkRange(band, '必要人数の時間帯');
    clean.stMin = cleanCount(band.stMin, 'スタイリストの最低人数');
    clean.stMax = cleanCount(band.stMax, 'スタイリストの上限', { optional: true });
    clean.asMin = cleanCount(band.asMin, 'アシスタントの最低人数');
    clean.asMax = cleanCount(band.asMax, 'アシスタントの上限', { optional: true });
    if (clean.stMax !== null && clean.stMax < clean.stMin) throw new Error('スタイリストの上限は、最低人数以上にしてください。');
    if (clean.asMax !== null && clean.asMax < clean.asMin) throw new Error('アシスタントの上限は、最低人数以上にしてください。');
    return clean;
  }

  function checkBandsOverlap(bands) {
    const sorted = [...bands].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) {
      if (overlaps(sorted[i - 1], sorted[i])) throw new Error('時間帯が、ほかの時間帯と重なっています。');
    }
    return sorted;
  }

  function getStaffingRules({ storeId, dayType } = {}) {
    return active(data.staffingRules)
      .filter((r) => (!storeId || r.storeId === storeId) && (!dayType || r.dayType === dayType))
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(copy);
  }

  function normalizeStaffingRule(fields, exceptId) {
    findActive(data.stores, fields.storeId, '店舗が見つかりませんでした。');
    if (!DAY_TYPES.includes(fields.dayType)) throw new Error('平日か土日祝かを選んでください。');
    const band = normalizeBand(fields);
    const others = getStaffingRules({ storeId: fields.storeId, dayType: fields.dayType }).filter((r) => r.id !== exceptId);
    checkBandsOverlap([...others, band]);
    return { storeId: fields.storeId, dayType: fields.dayType, ...band };
  }

  function addStaffingRule(fields) {
    const clean = normalizeStaffingRule(fields);
    const now = U.nowIso();
    const rule = { id: U.uuid(), ...clean, createdAt: now, updatedAt: now, deleted: false };
    commit((d) => d.staffingRules.push(rule));
    return copy(rule);
  }

  function updateStaffingRule(id, fields) {
    const current = findActive(data.staffingRules, id, '必要人数の設定が見つかりませんでした。');
    const clean = normalizeStaffingRule({ ...current, ...fields, storeId: current.storeId, dayType: current.dayType }, id);
    commit((d) => {
      Object.assign(d.staffingRules.find((r) => r.id === id), clean, { updatedAt: U.nowIso() });
    });
  }

  function deleteStaffingRule(id) {
    findActive(data.staffingRules, id, '必要人数の設定が見つかりませんでした。');
    commit((d) => {
      const r = d.staffingRules.find((x) => x.id === id);
      r.deleted = true;
      r.updatedAt = U.nowIso();
    });
  }

  // ---- 日付ごとの上書き（その日だけの必要人数） ----
  // mode：'type'（平日／土日祝の区分だけ変える：dayType）/ 'custom'（その日だけの時間帯：bands）

  function overrideId(storeId, date) {
    return `override_${storeId}_${date}`;
  }

  function getDayOverride(storeId, date) {
    const o = data.dayOverrides.find((x) => x.id === overrideId(storeId, date) && !x.deleted);
    return o ? copy(o) : null;
  }

  function setDayOverride(storeId, date, { mode, dayType, bands }) {
    findActive(data.stores, storeId, '店舗が見つかりませんでした。');
    if (!U.isValidDate(date)) throw new Error('日付が正しくありません。');
    const fields = { mode, dayType: null, bands: [] };
    if (mode === 'type') {
      if (!DAY_TYPES.includes(dayType)) throw new Error('平日か土日祝かを選んでください。');
      fields.dayType = dayType;
    } else if (mode === 'custom') {
      fields.bands = checkBandsOverlap((bands || []).map(normalizeBand));
    } else {
      throw new Error('上書きの種類が正しくありません。');
    }
    const id = overrideId(storeId, date);
    const now = U.nowIso();
    commit((d) => {
      const existing = d.dayOverrides.find((o) => o.id === id);
      if (existing) Object.assign(existing, fields, { deleted: false, updatedAt: now });
      else d.dayOverrides.push({ id, storeId, date, ...fields, createdAt: now, updatedAt: now, deleted: false });
    });
  }

  function clearDayOverride(storeId, date) {
    const id = overrideId(storeId, date);
    if (!data.dayOverrides.some((o) => o.id === id && !o.deleted)) return;
    commit((d) => {
      const o = d.dayOverrides.find((x) => x.id === id);
      o.deleted = true;
      o.updatedAt = U.nowIso();
    });
  }

  // ---- 祝日の手直し ----
  // action：'add'（祝日として扱う：name）/ 'remove'（自動で判定された祝日を、祝日として扱わない）

  function holidayEditId(date) {
    return `holiday_${date}`;
  }

  function getHolidayEdit(date) {
    const h = data.holidays.find((x) => x.id === holidayEditId(date) && !x.deleted);
    return h ? copy(h) : null;
  }

  function getHolidayEdits() {
    return active(data.holidays)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(copy);
  }

  function setHolidayEdit(date, action, name) {
    if (!U.isValidDate(date)) throw new Error('日付が正しくありません。');
    if (action !== 'add' && action !== 'remove') throw new Error('祝日の設定が正しくありません。');
    const clean = action === 'add' ? cleanText(name, { label: '名前', max: 12, required: true }) : '';
    const id = holidayEditId(date);
    const now = U.nowIso();
    commit((d) => {
      const existing = d.holidays.find((h) => h.id === id);
      const fields = { action, name: clean, deleted: false, updatedAt: now };
      if (existing) Object.assign(existing, fields);
      else d.holidays.push({ id, date, ...fields, createdAt: now });
    });
  }

  function clearHolidayEdit(date) {
    const id = holidayEditId(date);
    if (!data.holidays.some((h) => h.id === id && !h.deleted)) return;
    commit((d) => {
      const h = d.holidays.find((x) => x.id === id);
      h.deleted = true;
      h.updatedAt = U.nowIso();
    });
  }

  // ---- 設定 ----

  function getChecks() {
    return { ...data.settings.checks };
  }

  // チェックの基準を保存する
  function updateChecks(fields) {
    const intIn = (value, label, min, max) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}は${min}〜${max}の整数で入力してください。`);
      return n;
    };
    const numIn = (value, label, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max || Math.round(n * 2) !== n * 2) {
        throw new Error(`${label}は${min}〜${max}の範囲で、0.5刻みで入力してください。`);
      }
      return n;
    };
    const clean = {
      maxConsecutiveDays: intIn(fields.maxConsecutiveDays, '連勤の上限', 1, 31),
      monthlyOffDays: intIn(fields.monthlyOffDays, '月の休日数の目安', 0, 31),
      shortageMinSlots: intIn(fields.shortageMinSlots, '不足とする枠の数', 1, 48),
      hoursCheckEnabled: Boolean(fields.hoursCheckEnabled),
      dailyHoursLimit: numIn(fields.dailyHoursLimit, '1日の実働時間の目安', 1, 24),
      weeklyHoursLimit: numIn(fields.weeklyHoursLimit, '1週の実働時間の目安', 1, 168),
      countPaidLeaveAsOff: Boolean(fields.countPaidLeaveAsOff),
      closedDayAsOff: Boolean(fields.closedDayAsOff),
    };
    commit((d) => {
      Object.assign(d.settings.checks, clean);
      d.settings.updatedAt = U.nowIso();
    });
  }

  // すべてのデータのコピーを返す（バックアップ・同期用）
  function exportData() {
    return copy(data);
  }

  // ---- バックアップと復元 ----
  // ファイルの中身のチェックと合体は backup.js（K.backup）が行い、保存はここで行う

  const RESTORE_BACKUP_KEY = 'shift-app-data-before-restore'; // 復元の直前の状態

  // バックアップの状態：{ lastBackupAt, changedSinceBackup }
  function getBackupStatus() {
    const b = data.settings.backup || {};
    const hasData = data.staff.some((s) => !s.deleted) || data.shifts.some((s) => !s.deleted);
    return {
      lastBackupAt: b.lastBackupAt || null,
      // 一度もバックアップしていないのにデータがある場合（Step5 までのデータなど）も「変更あり」とする
      changedSinceBackup: Boolean(b.changedSinceBackup) || (!b.lastBackupAt && hasData),
    };
  }

  // バックアップファイルの中身を作る
  function buildBackup() {
    return K.backup.buildFile(copy(data));
  }

  // バックアップを保存したことを記録する
  function markBackedUp() {
    commit(
      (d) => {
        d.settings.backup = { lastBackupAt: U.nowIso(), changedSinceBackup: false };
      },
      { markChanged: false }
    );
  }

  // バックアップファイルと合体する（両方の端末で入力した分を両方残す。同じ記録は新しいほう）
  // incoming は K.backup.parseFile の data
  function mergeBackup(incoming) {
    const merged = K.backup.mergeData(copy(data), incoming);
    commit(
      (d) => {
        for (const key of LIST_KEYS) d[key] = merged.data[key];
        // この端末にしかない変更がなければ、ファイルと同じ内容になっている
        d.settings = {
          ...merged.data.settings,
          backup: { ...(d.settings.backup || {}), changedSinceBackup: merged.stats.localNewer > 0 },
        };
      },
      { markChanged: false }
    );
    return merged.stats;
  }

  // 復元の直前の状態が残っていれば、その日時を返す
  function getRestoreBackupDate() {
    try {
      const raw = localStorage.getItem(RESTORE_BACKUP_KEY);
      return raw ? JSON.parse(raw).savedAt : null;
    } catch (err) {
      return null;
    }
  }

  // バックアップの内容で丸ごと置き換える。直前の状態は1つだけ残しておく
  function replaceWithBackup(incoming) {
    try {
      localStorage.setItem(RESTORE_BACKUP_KEY, JSON.stringify({ savedAt: U.nowIso(), data }));
    } catch (err) {
      throw new Error('復元の前に、今のデータを残せませんでした。復元を中止しました。');
    }
    commit((d) => {
      for (const key of LIST_KEYS) d[key] = incoming[key];
      d.settings = { ...incoming.settings, backup: d.settings.backup };
    });
  }

  // 復元を取り消して、復元の直前の状態に戻す
  function undoRestore() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(RESTORE_BACKUP_KEY));
    } catch (err) {
      saved = null;
    }
    if (!saved || !saved.data) throw new Error('戻せる状態が見つかりませんでした。');
    const previous = migrate(saved.data);
    commit((d) => {
      for (const key of LIST_KEYS) d[key] = previous[key];
      d.settings = previous.settings;
    });
    localStorage.removeItem(RESTORE_BACKUP_KEY);
  }

  K.storage = {
    init,
    getStores,
    getStore,
    updateStore,
    getPatterns,
    getPattern,
    addPattern,
    updatePattern,
    getPatternUsers,
    deletePattern,
    getStaff,
    getStaffMember,
    addStaff,
    updateStaff,
    moveStaff,
    deleteStaff,
    shiftStoreId,
    getShifts,
    getShift,
    setShift,
    clearShift,
    setShiftBreaks,
    getBusinessTimes,
    addBusinessTime,
    updateBusinessTime,
    deleteBusinessTime,
    isBusinessTimeSkipped,
    setBusinessTimeSkip,
    getStaffingRules,
    addStaffingRule,
    updateStaffingRule,
    deleteStaffingRule,
    getDayOverride,
    setDayOverride,
    clearDayOverride,
    getHolidayEdit,
    getHolidayEdits,
    setHolidayEdit,
    clearHolidayEdit,
    getChecks,
    updateChecks,
    exportData,
    onExternalChange,
    getStorageInfo,
    getBackupStatus,
    buildBackup,
    markBackedUp,
    mergeBackup,
    getRestoreBackupDate,
    replaceWithBackup,
    undoRestore,
    LIST_KEYS,
  };
})();
