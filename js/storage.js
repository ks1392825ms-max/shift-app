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
    // 共有モードのときは、共有の保存場所に保存する（端末のデータには書き込まない）
    if (backend) {
      commitCloud(mutate, markChanged);
      return;
    }
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
  // ---- 共有モード（Firebase） ----
  // 共有モードかどうかは、端末ごとに選ぶ（この端末の設定として保存する。シフトのデータとは別）。
  // 共有モードのときは、共有の保存場所（backend＝K.cloud。テストでは偽物）のデータを使い、
  // 端末のデータ（shift-app-data）には読み書きしない。

  const MODE_KEY = 'shift-app-mode';
  let backend = null;
  let cloudErrorHandler = null;

  function getMode() {
    try {
      return localStorage.getItem(MODE_KEY) === 'cloud' ? 'cloud' : 'local';
    } catch (err) {
      return 'local';
    }
  }

  function setMode(mode) {
    localStorage.setItem(MODE_KEY, mode === 'cloud' ? 'cloud' : 'local');
  }

  function isCloud() {
    return Boolean(backend);
  }

  // 共有の保存場所に保存できなかったときに呼ぶ処理を登録する（画面で知らせる）
  function onCloudError(handler) {
    cloudErrorHandler = handler;
  }

  // 共有データを使い始める
  function attachCloud(b, cloudData) {
    backend = b;
    data = migrate(JSON.parse(JSON.stringify(cloudData)));
  }

  // 共有データが変わったとき（ほかの管理者の変更など）に、最新の内容に入れ替える
  function receiveCloudData(cloudData) {
    if (!backend) return;
    data = migrate(JSON.parse(JSON.stringify(cloudData)));
  }

  // 共有データを使うのをやめて、端末のデータに戻す
  function detachCloud() {
    backend = null;
    const raw = localStorage.getItem(STORAGE_KEY);
    data = raw === null ? createInitialData() : migrate(JSON.parse(raw));
    lastSaved = raw;
  }

  // 共有の保存場所に書く形：シフトには店舗と月を必ず入れる（スタッフの閲覧範囲をルールで絞るため）
  function toCloudRecord(key, record, source) {
    if (key !== 'shifts') return record;
    const member = source.staff.find((m) => m.id === record.staffId);
    return { ...record, storeId: record.storeId || (member ? member.storeId : null), month: record.date.slice(0, 7) };
  }

  // 変更前と変更後を比べて、変わった記録だけを取り出す
  function diffForCloud(before, after) {
    const changes = [];
    for (const key of LIST_KEYS) {
      const prev = new Map((before[key] || []).map((r) => [r.id, JSON.stringify(r)]));
      for (const r of after[key]) {
        if (prev.get(r.id) !== JSON.stringify(r)) changes.push({ collection: key, id: r.id, data: toCloudRecord(key, r, after) });
      }
    }
    if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) {
      changes.push({ collection: 'settings', id: 'main', data: after.settings });
    }
    return changes;
  }

  function commitCloud(mutate, markChanged) {
    const before = JSON.parse(JSON.stringify(data));
    mutate(data);
    if (markChanged) {
      data.settings.backup = { ...(data.settings.backup || {}), changedSinceBackup: true };
    }
    // シフトに店舗と月を入れた形を、手元のデータにも合わせておく（次の比較で差が出ないように）
    for (const s of data.shifts) {
      if (!s.storeId || !s.month) Object.assign(s, toCloudRecord('shifts', s, data));
    }
    const changes = diffForCloud(before, data);
    if (!changes.length) return;
    // 電波がないときは、この端末に一時的に保存され、つながったときに送られる。失敗したときだけ知らせる
    Promise.resolve()
      .then(() => backend.write(changes))
      .catch((err) => {
        console.error(err);
        if (cloudErrorHandler) cloudErrorHandler(err);
      });
  }

  // 店舗名の空白を整える（初回の移行のときに使う）
  // 例：「店舗 A」→「店舗A」、「Salon  1」→「Salon 1」
  function normalizeStoreName(name) {
    return String(name)
      .replace(/[\s　]+/g, ' ')
      .trim()
      .replace(/([\x21-\x7e]) (?=[^\x00-\x7f])/g, '$1')
      .replace(/([^\x00-\x7f]) (?=[\x21-\x7e])/g, '$1');
  }

  // 初回だけ：バックアップファイルの内容を、空の共有の保存場所にアップロードする（写し）
  // incoming は K.backup.parseFile の data。店舗名を整え、シフトに店舗と月を入れる。
  // 戻り値：アップロードした内容のまとめ
  async function uploadToCloud(b, incoming) {
    return writeFirstData(b, migrate(JSON.parse(JSON.stringify({ version: DATA_VERSION, ...incoming }))));
  }

  // 初回だけ：店舗名を入力して、空の状態から始める（スタッフ・シフトは、このあとアプリの画面から登録する）
  // 勤務パターンとチェックの基準は、初期データ（架空の一般的な値）を使う
  async function startFreshCloud(b, storeName) {
    const name = normalizeStoreName(storeName || '');
    if (!name) throw new Error('店舗名を入力してください。');
    if (name.length > 10) throw new Error('店舗名は10文字以内で入力してください。');
    const d = createInitialData();
    d.stores = [{ ...d.stores[0], id: U.uuid(), name, createdAt: U.nowIso(), updatedAt: U.nowIso() }];
    return writeFirstData(b, d);
  }

  async function writeFirstData(b, d) {
    if (!(await b.isEmpty())) {
      throw new Error('共有の保存場所には、すでにデータがあります。二重に登録しないよう、登録を中止しました。');
    }
    const now = U.nowIso();
    for (const s of d.stores) {
      const name = normalizeStoreName(s.name);
      if (name !== s.name) Object.assign(s, { name, updatedAt: now });
    }
    const changes = [];
    for (const key of LIST_KEYS) {
      for (const r of d[key]) changes.push({ collection: key, id: r.id, data: toCloudRecord(key, r, d) });
    }
    const settings = { ...d.settings };
    delete settings.backup;
    changes.push({ collection: 'settings', id: 'main', data: settings });
    await b.write(changes);
    const live = (list) => list.filter((x) => !x.deleted);
    return {
      stores: live(d.stores).map((s) => ({ name: s.name, staff: live(d.staff).filter((m) => m.storeId === s.id).length })),
      shifts: live(d.shifts).length,
      records: changes.length,
    };
  }

  function onExternalChange(handler) {
    externalChangeHandler = handler;
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      // 共有モードのときは、端末のデータの変化は関係ない（共有データの変化は別に届く）
      if (backend) return;
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

  // ---- 表示順（設定の「↑」「↓」で変える：毎週の社用・必要人数の時間帯） ----
  // まだ並び替えていない項目（order がない）は、今までどおりの順（曜日・時刻の順など）で、並び替えた項目のあとに並ぶ。
  // あとから追加した項目も order を持たないので、並び替えた一覧では一番下に入る。
  function byOrder(fallback) {
    return (a, b) => {
      const ao = Number.isFinite(a.order);
      const bo = Number.isFinite(b.order);
      if (ao && bo) return a.order - b.order || fallback(a, b);
      if (ao !== bo) return ao ? -1 : 1;
      return fallback(a, b);
    };
  }

  // 表示中の並び（ids）で、id の項目を1つ上（-1）か1つ下（+1）へ動かし、その並びを 0, 1, 2… の order として保存する
  function reorderList(key, ids, id, direction) {
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    commit((d) => {
      const now = U.nowIso();
      next.forEach((rid, i) => {
        const r = d[key].find((x) => x.id === rid);
        if (r && r.order !== i) Object.assign(r, { order: i, updatedAt: now });
      });
    });
  }

  // ---- 店舗（初期は 店舗A・店舗B。自由に追加・削除できる） ----
  // 削除は本当に消さず deleted: true にする（その店舗のスタッフ・シフト・集計の記録は残り、「元に戻す」で戻せる）

  function getStores() {
    return active(data.stores)
      .sort((a, b) => a.order - b.order)
      .map(copy);
  }

  function getStore(id) {
    const s = data.stores.find((x) => x.id === id);
    return s ? copy(s) : null;
  }

  // 削除した店舗の一覧（元に戻す用）
  function getDeletedStores() {
    return data.stores
      .filter((s) => s.deleted)
      .sort((a, b) => a.order - b.order)
      .map(copy);
  }

  // 店舗名・営業時間・定休日のチェック
  function normalizeStore(fields, exceptId) {
    const name = cleanText(fields.name, { label: '店舗名', max: MAX_STORE_NAME, required: true });
    if (active(data.stores).some((s) => s.id !== exceptId && s.name === name)) {
      throw new Error(`「${name}」はすでにあります。別の名前にしてください。`);
    }

    if (!U.isValidTime(fields.open) || !U.isValidTime(fields.close)) throw new Error('営業時間が正しくありません。');
    if (U.toMinutes(fields.open) >= U.toMinutes(fields.close)) throw new Error('閉店時刻は開店時刻より後にしてください。');

    const closedWeekdays = [...new Set(fields.closedWeekdays || [])].map(Number).sort((a, b) => a - b);
    if (closedWeekdays.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) throw new Error('定休日が正しくありません。');
    if (closedWeekdays.length === 7) throw new Error('すべての曜日を定休日にはできません。');

    return { name, open: fields.open, close: fields.close, closedWeekdays };
  }

  // まだ使われていない色を選ぶ（店舗の目印の色）
  function nextStoreColor() {
    const used = new Set(active(data.stores).map((s) => s.color));
    return K.defaults.storeColors.find((c) => !used.has(c)) || K.defaults.storeColors[data.stores.length % K.defaults.storeColors.length];
  }

  // 店舗を追加する。チェックの基準も、その店舗専用に初期値で持たせる
  function addStore(fields) {
    const clean = normalizeStore(fields);
    const now = U.nowIso();
    const store = {
      id: U.uuid(),
      ...clean,
      color: fields.color ? cleanColor(fields.color) : nextStoreColor(),
      order: nextOrder(data.stores),
      checks: { ...K.defaults.checks },
      createdAt: now,
      updatedAt: now,
      deleted: false,
    };
    commit((d) => d.stores.push(store));
    return copy(store);
  }

  // 店舗を削除する（在籍中のスタッフがいる店舗は削除できない。最後の1店舗も削除できない）
  function deleteStore(id) {
    const store = findActive(data.stores, id, '店舗が見つかりませんでした。');
    if (active(data.stores).length <= 1) throw new Error('店舗は最低1つ必要です。');
    const members = active(data.staff).filter((m) => m.storeId === id && m.active);
    if (members.length) {
      throw new Error(
        `${store.name}には在籍中のスタッフが${members.length}人います（${members.map((m) => m.name).join('、')}）。` +
          '先にスタッフをほかの店舗に移すか、「在籍中」を外してください。'
      );
    }
    commit((d) => {
      const s = d.stores.find((x) => x.id === id);
      s.deleted = true;
      s.updatedAt = U.nowIso();
    });
  }

  // 削除した店舗を元に戻す
  function restoreStore(id) {
    const store = data.stores.find((s) => s.id === id && s.deleted);
    if (!store) throw new Error('店舗が見つかりませんでした。');
    if (active(data.stores).some((s) => s.name === store.name)) {
      throw new Error(`「${store.name}」という店舗がすでにあるため、元に戻せません。先にどちらかの名前を変えてください。`);
    }
    commit((d) => {
      const s = d.stores.find((x) => x.id === id);
      s.deleted = false;
      s.updatedAt = U.nowIso();
    });
  }

  // 店舗の並び順を、1つ上（-1）か1つ下（+1）と入れ替える
  function moveStore(id, direction) {
    findActive(data.stores, id, '店舗が見つかりませんでした。');
    const list = getStores();
    const index = list.findIndex((s) => s.id === id);
    const other = list[index + direction];
    if (index < 0 || !other) return;
    commit((d) => {
      const a = d.stores.find((s) => s.id === id);
      const b = d.stores.find((s) => s.id === other.id);
      [a.order, b.order] = [b.order, a.order];
      a.updatedAt = b.updatedAt = U.nowIso();
    });
  }

  function updateStore(id, fields) {
    findActive(data.stores, id, '店舗が見つかりませんでした。');
    const { name, closedWeekdays } = normalizeStore(fields, id);
    const color = fields.color ? cleanColor(fields.color) : null;

    commit((d) => {
      if (color) d.stores.find((s) => s.id === id).color = color;
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

  // 勤務パターンは「全店舗共通」（storeId なし。以前からのパターンはすべてこれ）か「その店舗専用」（storeId あり）
  // 出勤・退勤の時刻は15分単位まで（画面では30分単位が基本で、切り替えると15分単位も選べる）
  const PATTERN_TIME_STEP = 15;

  function patternAvailableIn(pattern, storeId) {
    return !pattern.storeId || pattern.storeId === storeId;
  }

  // 勤務パターンの並び順。店舗ごとに持つ（store.patternOrder：勤務パターンIDの並び）。
  // 全店舗共通のパターンも、店舗ごとに別の順番にできる。並びにないもの（並び替えていない・あとから追加）は開始時刻の早い順で後ろに
  function comparePatterns(storeId) {
    const store = storeId ? data.stores.find((s) => s.id === storeId) : null;
    const order = store && Array.isArray(store.patternOrder) ? store.patternOrder : [];
    const rank = (p) => {
      const i = order.indexOf(p.id);
      return i < 0 ? order.length : i;
    };
    return (a, b) => rank(a) - rank(b) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end);
  }

  // storeId を渡すと、その店舗で使えるもの（共通＋その店舗専用）だけを、その店舗の並び順で。渡さないときは開始時刻の早い順
  function getPatterns({ storeId } = {}) {
    return active(data.shiftPatterns)
      .filter((p) => !storeId || patternAvailableIn(p, storeId))
      .sort(comparePatterns(storeId))
      .map(copy);
  }

  // その店舗での並び順で、1つ上（-1）か1つ下（+1）へ動かす。
  // 画面では「店舗専用」と「全店舗共通」に分けて表示するので、同じ区分の中で隣のものと入れ替える
  function movePattern(id, direction, storeId) {
    findActive(data.stores, storeId, '店舗が見つかりませんでした。');
    const list = getPatterns({ storeId });
    const me = list.find((p) => p.id === id);
    if (!me) throw new Error('勤務パターンが見つかりませんでした。');
    const group = list.filter((p) => Boolean(p.storeId) === Boolean(me.storeId));
    const other = group[group.findIndex((p) => p.id === id) + direction];
    if (!other) return;
    const ids = list.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = ids.indexOf(other.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    commit((d) => {
      Object.assign(d.stores.find((s) => s.id === storeId), { patternOrder: ids, updatedAt: U.nowIso() });
    });
  }

  function getPattern(id) {
    const p = data.shiftPatterns.find((x) => x.id === id);
    return p ? copy(p) : null;
  }

  function normalizePattern(fields, exceptId) {
    if (!U.isValidTime(fields.start, PATTERN_TIME_STEP) || !U.isValidTime(fields.end, PATTERN_TIME_STEP)) {
      throw new Error('勤務時間が正しくありません（15分単位で設定してください）。');
    }
    const duration = U.toMinutes(fields.end) - U.toMinutes(fields.start);
    if (duration <= 0) throw new Error('終了時刻は開始時刻より後にしてください。');

    const breakMinutes = Number(fields.breakMinutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes % 15 !== 0) {
      throw new Error('休憩の長さが正しくありません。');
    }
    if (breakMinutes >= duration) throw new Error('休憩の長さは、勤務時間より短くしてください。');

    // 使う店舗：空なら全店舗共通
    const storeId = fields.storeId || null;
    if (storeId) findActive(data.stores, storeId, '店舗が見つかりませんでした。');

    // 同じ店舗で使えるパターンどうしで、表示名が重ならないようにする
    const label = cleanText(fields.label, { label: '表示名', max: MAX_PATTERN_LABEL, required: true });
    const clash = active(data.shiftPatterns).some(
      (p) => p.id !== exceptId && p.label === label && (!p.storeId || !storeId || p.storeId === storeId)
    );
    if (clash) throw new Error(`表示名「${label}」はすでにあります。別の表示名にしてください。`);

    // 専用にする店舗以外のスタッフが使っていたら、変えられない
    if (exceptId && storeId) {
      const others = active(data.staff).filter((s) => s.storeId !== storeId && s.patternIds.includes(exceptId));
      if (others.length) {
        throw new Error(`${others.map((s) => s.name).join('、')} さん（ほかの店舗）が使っているため、この店舗専用にはできません。`);
      }
    }

    return { start: fields.start, end: fields.end, breakMinutes, label, color: cleanColor(fields.color), storeId };
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
          // 曜日ごとの勤務からも外す
          if (s.weeklyPatterns) {
            for (const w of Object.keys(s.weeklyPatterns)) if (s.weeklyPatterns[w] === id) delete s.weeklyPatterns[w];
          }
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
    for (const pid of patternIds) {
      const p = findActive(data.shiftPatterns, pid, '選んだ勤務パターンが見つかりませんでした。');
      if (!patternAvailableIn(p, fields.storeId)) throw new Error(`「${p.label}」は、ほかの店舗専用の勤務パターンです。`);
    }

    // 曜日ごとのいつもの勤務：{ "0"〜"6"（日〜土）: 勤務パターンID または "off"（通常休） }
    // 使える勤務パターンから外したものは、自動で外す
    const weeklyPatterns = {};
    for (const [w, value] of Object.entries(fields.weeklyPatterns || {})) {
      if (!/^[0-6]$/.test(w) || !value) continue;
      if (value === 'off' || patternIds.includes(value)) weeklyPatterns[w] = value;
    }

    return { name, storeId: fields.storeId, role: fields.role, title, patternIds, weeklyPatterns, active: fields.active !== false };
  }

  // 曜日ごとのいつもの勤務を、その月の「未入力の日」に反映する（入力済みの日・定休日は変えない）
  // 戻り値：反映した日数
  function applyWeeklyPatterns(storeId, month) {
    const store = findActive(data.stores, storeId, '店舗が見つかりませんでした。');
    const [y, m] = month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const members = active(data.staff).filter((s) => s.storeId === storeId && s.active && s.weeklyPatterns);
    const plans = [];
    for (let day = 1; day <= days; day++) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const weekday = new Date(y, m - 1, day).getDay();
      if (store.closedWeekdays.includes(weekday)) continue;
      for (const s of members) {
        const value = s.weeklyPatterns[String(weekday)];
        if (!value) continue;
        if (data.shifts.some((x) => x.id === shiftId(s.id, date) && !x.deleted)) continue; // 入力済みは変えない
        if (value !== 'off' && !data.shiftPatterns.some((p) => p.id === value && !p.deleted)) continue;
        plans.push({ staffId: s.id, date, value });
      }
    }
    if (!plans.length) return 0;
    commit((d) => {
      const now = U.nowIso();
      for (const { staffId, date, value } of plans) {
        const id = shiftId(staffId, date);
        const fields = { kind: value === 'off' ? 'off' : 'work', patternId: value === 'off' ? null : value, storeId, breaks: [] };
        const existing = d.shifts.find((x) => x.id === id);
        if (existing) Object.assign(existing, fields, { deleted: false, updatedAt: now });
        else d.shifts.push({ id, staffId, date, ...fields, createdAt: now, updatedAt: now, deleted: false });
      }
    });
    return plans.length;
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
      .sort(byOrder((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.date || '').localeCompare(b.date || '') || a.start.localeCompare(b.start)))
      .map(copy);
  }

  // 設定の一覧（その店舗の在籍・休職中スタッフの、同じ種類の社用）の中で、1つ上（-1）か1つ下（+1）へ動かす
  function moveBusinessTime(id, direction) {
    const bt = findActive(data.businessTimes, id, '社用時間が見つかりませんでした。');
    const storeOf = (b) => {
      const m = data.staff.find((s) => s.id === b.staffId && !s.deleted);
      return m ? m.storeId : null;
    };
    const storeId = storeOf(bt);
    const ids = getBusinessTimes({ type: bt.type })
      .filter((b) => storeId && storeOf(b) === storeId)
      .map((b) => b.id);
    reorderList('businessTimes', ids, id, direction);
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
      .sort(byOrder((a, b) => a.start.localeCompare(b.start)))
      .map(copy);
  }

  // 同じ店舗・同じ日の区分（平日／土日祝）の中で、1つ上（-1）か1つ下（+1）へ動かす（表示の順番だけ。チェックの結果は変わらない）
  function moveStaffingRule(id, direction) {
    const rule = findActive(data.staffingRules, id, '必要人数の時間帯が見つかりませんでした。');
    const ids = getStaffingRules({ storeId: rule.storeId, dayType: rule.dayType }).map((r) => r.id);
    reorderList('staffingRules', ids, id, direction);
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

  // チェックの基準
  // 店舗ごとに持てる（store.checks）。店舗専用の基準がない店舗（以前からの 店舗A・店舗Bなど）は、共通の基準（settings.checks）を使う
  function getChecks(storeId) {
    const store = storeId ? data.stores.find((s) => s.id === storeId) : null;
    return { ...data.settings.checks, ...((store && store.checks) || {}) };
  }

  // チェックの基準を保存する（storeId を渡すと、その店舗専用の基準として保存する）
  function updateChecks(storeIdOrFields, maybeFields) {
    const storeId = typeof storeIdOrFields === 'string' ? storeIdOrFields : null;
    const fields = storeId ? maybeFields : storeIdOrFields;
    if (storeId) findActive(data.stores, storeId, '店舗が見つかりませんでした。');
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
      if (storeId) {
        const s = d.stores.find((x) => x.id === storeId);
        s.checks = clean;
        s.updatedAt = U.nowIso();
      } else {
        Object.assign(d.settings.checks, clean);
        d.settings.updatedAt = U.nowIso();
      }
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
    if (backend) return null; // 共有モードでは使わない
    try {
      const raw = localStorage.getItem(RESTORE_BACKUP_KEY);
      return raw ? JSON.parse(raw).savedAt : null;
    } catch (err) {
      return null;
    }
  }

  // バックアップの内容で丸ごと置き換える。直前の状態は1つだけ残しておく
  function replaceWithBackup(incoming) {
    // 共有モードでは、ほかの管理者のデータまで置き換えてしまうため使えない（「合体する」を使う）
    if (backend) throw new Error('共有モードでは「丸ごと置き換える」は使えません。「合体する」を使ってください。');
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
    if (backend) throw new Error('共有モードでは「復元を取り消す」は使えません。');
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
    getDeletedStores,
    addStore,
    deleteStore,
    restoreStore,
    moveStore,
    updateStore,
    getPatterns,
    comparePatterns,
    movePattern,
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
    applyWeeklyPatterns,
    shiftStoreId,
    getShifts,
    getShift,
    setShift,
    clearShift,
    setShiftBreaks,
    getBusinessTimes,
    moveBusinessTime,
    addBusinessTime,
    updateBusinessTime,
    deleteBusinessTime,
    isBusinessTimeSkipped,
    setBusinessTimeSkip,
    getStaffingRules,
    moveStaffingRule,
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
    getMode,
    setMode,
    isCloud,
    onCloudError,
    attachCloud,
    receiveCloudData,
    detachCloud,
    normalizeStoreName,
    uploadToCloud,
    startFreshCloud,
  };
})();
