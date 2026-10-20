// 共有モード：Firebase（ログイン・Firestore）とのやり取りを担当するファイル
// 「この端末だけで使う」モードでは、このファイルは Firebase の部品を読み込まず、通信もしない。
//
// 画面や storage.js からは、次の関数だけを使う（テストでは同じ形の偽物に差し替える）：
//   supported()                 共有モードを使える開き方か（https か、Mac での確認用の localhost）
//   start(onAuth)               Firebase を準備し、ログイン状態が変わるたびに onAuth(ユーザー or null) を呼ぶ
//   isLoginLink()               今のURLが、メールで届いたログイン用のリンクか
//   savedEmail()                ログイン用のメールを送ったメールアドレス（同じ端末なら覚えている）
//   sendLoginLink(email)        ログイン用のメールを送る
//   completeLogin(email)        メールのリンクでログインを完了する
//   checkAdmin()                管理者として登録されているか（ルールで読めるかどうかで判断）
//   checkStaff(email)           スタッフとして登録されているか（staffAccounts に本人のメールがあるか）
//   loadStaffContext / loadMyRequests / addWishRequest / removeWishRequest / submitNoWish / addPaidRequest / withdrawPaidRequest   スタッフ本人の申請
//   decideRequest / changePaidDateLogged                                                    判断（承認・却下・申請中に戻す）と有給の日付の変更（履歴と一緒に）
//   subscribeRequests / adminSet / adminUpdate / adminDelete                                 管理者の申請の受け取り・変更
//   publishRoster / unpublishRoster / loadPublishedRosters                                確定シフトの公開用の写し
//   subscribe(onData, onError)  共有データを受け取り続ける（変わるたびに onData）。戻り値で止められる
//   write(changes)              記録をまとめて保存する：[{ collection, id, data }]
//   isEmpty()                   共有の保存場所が空か（店舗が1つもないか）
//   signOut()                   ログアウト
(function () {
  'use strict';
  const K = window.ShiftApp;

  const EMAIL_KEY = 'shift-app-login-email'; // ログイン用のメールを送ったアドレス（この端末だけ）
  const BATCH_LIMIT = 400; // 1回にまとめて保存する件数（Firestore の上限 500 より少なく）

  let fb = null; // 読み込んだ Firebase の部品と、初期化したもの

  function supported() {
    return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  // Firebase の部品を読み込んで初期化する（アプリに同梱した js/vendor/firebase から）
  async function load() {
    if (fb) return fb;
    const [appMod, authMod, fsMod] = await Promise.all([
      import('./vendor/firebase/firebase-app.js'),
      import('./vendor/firebase/firebase-auth.js'),
      import('./vendor/firebase/firebase-firestore.js'),
    ]);
    const app = appMod.initializeApp(K.firebaseConfig);
    // ポップアップ用の部品は使わない（メールリンクだけ）。ログイン状態はこの端末（localStorage）に保存する
    const auth = authMod.initializeAuth(app, { persistence: authMod.browserLocalPersistence });
    auth.languageCode = 'ja'; // ログイン用のメールを日本語で送る
    // 電波がないときも、最後に読み込んだ内容で見られるように、この端末にも保存しておく
    const db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
    });
    fb = { appMod, authMod, fsMod, app, auth, db };
    return fb;
  }

  async function start(onAuth) {
    const { authMod, auth } = await load();
    authMod.onAuthStateChanged(auth, (user) => onAuth(user ? { email: user.email, uid: user.uid } : null));
  }

  function isLoginLink() {
    // Firebase を読み込む前でも判定できるよう、URL の形で見る
    return /[?&]mode=signIn(&|$)/.test(location.search) && /[?&]oobCode=/.test(location.search);
  }

  function savedEmail() {
    try {
      return localStorage.getItem(EMAIL_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  // ログインのリンクを押したあとに戻ってくる場所（このアプリの URL）
  function returnUrl() {
    return location.origin + location.pathname;
  }

  async function sendLoginLink(email) {
    const { authMod, auth } = await load();
    await authMod.sendSignInLinkToEmail(auth, email, { url: returnUrl(), handleCodeInApp: true });
    try {
      localStorage.setItem(EMAIL_KEY, email);
    } catch (err) {
      // 覚えられなくても、リンクを開いたときにもう一度入力すればよい
    }
  }

  async function completeLogin(email) {
    const { authMod, auth } = await load();
    if (!authMod.isSignInWithEmailLink(auth, location.href)) throw new Error('ログイン用のリンクではありません。');
    await authMod.signInWithEmailLink(auth, email, location.href);
    try {
      localStorage.removeItem(EMAIL_KEY);
    } catch (err) {
      // なにもしない
    }
    // アドレスバーからログイン用の文字を消す（再読み込みでもう一度ログインしようとしないように）
    history.replaceState(null, '', returnUrl());
  }

  // 管理者かどうか：管理者だけが読める access/admins を読んでみる
  async function checkAdmin() {
    const { fsMod, db } = await load();
    try {
      await fsMod.getDoc(fsMod.doc(db, 'access', 'admins'));
      return true;
    } catch (err) {
      if (err && err.code === 'permission-denied') return false;
      throw err;
    }
  }

  // スタッフかどうか：staffAccounts/{ログインしたメール} を読む（本人の分だけ読めるルール）。
  // スタッフなら { staffIds, storeIds }、そうでなければ null
  async function checkStaff(email) {
    const { fsMod, db } = await load();
    try {
      const snap = await fsMod.getDoc(fsMod.doc(db, 'staffAccounts', String(email || '').toLowerCase()));
      if (!snap.exists()) return null;
      const account = snap.data();
      return account.deleted || !account.staffIds || !account.staffIds.length ? null : { staffIds: account.staffIds, storeIds: account.storeIds || [] };
    } catch (err) {
      if (err && err.code === 'permission-denied') return null;
      throw err;
    }
  }

  // 共有データを受け取り続ける。最初に全部そろったときと、その後変わるたびに onData(data) を呼ぶ
  function subscribe(onData, onError) {
    const { fsMod, db } = fb;
    const keys = K.storage.LIST_KEYS;
    const lists = {};
    let settings = null;
    let loaded = 0;
    const total = keys.length + 1;
    const seen = new Set();
    let timer = null;

    const emit = () => {
      if (loaded < total) return;
      // 立て続けに届いた変更は、まとめて1回で画面に反映する
      clearTimeout(timer);
      timer = setTimeout(() => {
        const data = { version: 1, settings: settings || {} };
        for (const k of keys) data[k] = lists[k] || [];
        onData(data);
      }, 30);
    };
    const markLoaded = (name) => {
      if (!seen.has(name)) {
        seen.add(name);
        loaded += 1;
      }
    };
    const fail = (err) => onError && onError(err);

    const stops = keys.map((k) =>
      fsMod.onSnapshot(
        fsMod.collection(db, k),
        (snap) => {
          lists[k] = snap.docs.map((d) => d.data());
          markLoaded(k);
          emit();
        },
        fail
      )
    );
    stops.push(
      fsMod.onSnapshot(
        fsMod.doc(db, 'settings', 'main'),
        (snap) => {
          settings = snap.exists() ? snap.data() : null;
          markLoaded('settings');
          emit();
        },
        fail
      )
    );
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }

  // 記録をまとめて保存する（電波がないときは、この端末に一時的に保存され、つながったときに送られる）
  async function write(changes) {
    const { fsMod, db } = fb;
    for (let i = 0; i < changes.length; i += BATCH_LIMIT) {
      const batch = fsMod.writeBatch(db);
      for (const c of changes.slice(i, i + BATCH_LIMIT)) {
        batch.set(fsMod.doc(db, c.collection, c.id), JSON.parse(JSON.stringify(c.data)));
      }
      await batch.commit();
    }
  }

  // ---- 希望休・有給（スタッフ）：自分の分だけを読み書きする（ルールでもそれ以外は止めている） ----

  // 読めないもの・ないものは null にする
  async function getData(col, id) {
    const { fsMod, db } = await load();
    try {
      const snap = await fsMod.getDoc(fsMod.doc(db, col, id));
      return snap.exists() ? snap.data() : null;
    } catch (err) {
      if (err && err.code === 'permission-denied') return null;
      throw err;
    }
  }

  // 本人のスタッフ記録・所属店舗・希望休の設定
  async function loadStaffContext(account) {
    const [stores, staff, settings] = await Promise.all([
      Promise.all(account.storeIds.map((id) => getData('stores', id))),
      Promise.all(account.staffIds.map((id) => getData('staff', id))),
      getData('settings', 'requests'),
    ]);
    return {
      stores: stores.filter((s) => s && !s.deleted),
      staff: staff.filter((s) => s && !s.deleted && s.active !== false),
      settings,
    };
  }

  // 本人のその月の申請（希望休＝1日ごと・希望休の日数・有給希望・上限の変更）
  async function loadMyRequests(staffId, month) {
    const { fsMod, db } = await load();
    const mine = (col) => fsMod.getDocs(fsMod.query(fsMod.collection(db, col), fsMod.where('staffId', '==', staffId), fsMod.where('month', '==', month)));
    const [wishes, counts, paid, quota, changes] = await Promise.all([mine('wishRequests'), mine('wishCounts'), mine('paidRequests'), mine('requestQuotas'), mine('changeRequests')]);
    return {
      changes: changes.docs.map((d) => ({ id: d.id, ...d.data() })),
      wishes: wishes.docs.map((d) => ({ id: d.id, ...d.data() })),
      count: counts.docs.length ? counts.docs[0].data() : null,
      paid: paid.docs.map((d) => ({ id: d.id, ...d.data() })),
      quota: quota.docs.length ? quota.docs[0].data() : null,
    };
  }

  // 記録の名前は「スタッフID_日付_回数」（回数は requests.js が決める）。
  // 同じ名前がすでにあると、スタッフには書き換えが許されていないのでルールが断る（すでにある申請は上書きしない）
  async function addPaidRequest({ staffId, storeId, month, date, note, email, attempt }) {
    const { fsMod, db } = await load();
    const now = new Date().toISOString();
    const id = `${staffId}_${date}_${attempt}`;
    const ref = fsMod.doc(db, 'paidRequests', id);
    try {
      await fsMod.setDoc(ref, {
        staffId,
        storeId,
        month,
        date,
        status: 'pending',
        note: note || '',
        createdAt: now,
        updatedAt: now,
        createdBy: email || '',
      });
    } catch (err) {
      if (err && err.code === 'permission-denied') throw new Error('この日は、すでに有給希望を出しています。画面を読み込み直してください。');
      throw err;
    }
    return id;
  }

  async function withdrawPaidRequest(id) {
    const { fsMod, db } = await load();
    await fsMod.deleteDoc(fsMod.doc(db, 'paidRequests', id));
  }

  // ---- 希望休・有給（オーナー）：全店舗の申請と判断の履歴を受け取り続ける ----
  function subscribeRequests(onData, onError) {
    const { fsMod, db } = fb;
    const parts = { wishRequests: null, wishCounts: null, paidRequests: null, changeRequests: null, quotas: null, logs: null, settings: undefined };
    let timer = null;
    const emit = () => {
      if (Object.values(parts).some((v) => v === null || v === undefined)) return;
      clearTimeout(timer);
      timer = setTimeout(() => onData({ ...parts, settings: parts.settings || null }), 30);
    };
    const fail = (err) => onError && onError(err);
    const listen = (col, key) =>
      fsMod.onSnapshot(
        fsMod.collection(db, col),
        (snap) => {
          parts[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          emit();
        },
        fail
      );
    const stops = [
      listen('wishRequests', 'wishRequests'),
      listen('wishCounts', 'wishCounts'),
      listen('paidRequests', 'paidRequests'),
      listen('requestQuotas', 'quotas'),
      listen('changeRequests', 'changeRequests'),
      listen('decisionLogs', 'logs'),
      fsMod.onSnapshot(
        fsMod.doc(db, 'settings', 'requests'),
        (snap) => {
          parts.settings = snap.exists() ? snap.data() : false;
          emit();
        },
        fail
      ),
    ];
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }

  async function adminSet(col, id, data) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, col, id), data);
  }

  async function adminUpdate(col, id, data) {
    const { fsMod, db } = await load();
    await fsMod.updateDoc(fsMod.doc(db, col, id), data);
  }

  async function adminDelete(col, id) {
    const { fsMod, db } = await load();
    await fsMod.deleteDoc(fsMod.doc(db, col, id));
  }

  // ---- 確定シフトの公開用の写し（publishedRosters） ----

  async function publishRoster(snapshot) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'publishedRosters', snapshot.id), JSON.parse(JSON.stringify(snapshot)));
  }

  async function unpublishRoster(id) {
    const { fsMod, db } = await load();
    await fsMod.deleteDoc(fsMod.doc(db, 'publishedRosters', id));
  }

  // スタッフ：所属店舗の写しを、指定した月の分だけ読む（ルールで、ほかの店舗は読めない）
  async function loadPublishedRosters(storeId, months) {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDocs(
      fsMod.query(fsMod.collection(db, 'publishedRosters'), fsMod.where('storeId', '==', storeId), fsMod.where('month', 'in', months))
    );
    return snap.docs.map((d) => d.data());
  }

  // ---- 権限の作り直し（段階①の土台。画面からは段階②〜④で使う） ----
  // 記録の形は js/records.js（Firestore のルールの試験と同じもの）で作る。

  // 幹部かどうか：managers/{ログインしたメール} を読む（本人の分だけ読めるルール）。幹部なら { storeIds }、そうでなければ null
  async function checkManager(email) {
    const { fsMod, db } = await load();
    try {
      const snap = await fsMod.getDoc(fsMod.doc(db, 'managers', String(email || '').toLowerCase()));
      if (!snap.exists()) return null;
      const m = snap.data();
      return m.deleted || !Array.isArray(m.storeIds) || !m.storeIds.length ? null : { storeIds: m.storeIds };
    } catch (err) {
      if (err && err.code === 'permission-denied') return null;
      throw err;
    }
  }

  // スタッフ：希望休を1日出す（希望休の記録と、月の日数を1つ増やすのを、1回の書き込みで）
  async function addWishRequest({ staffId, storeId, date, email }) {
    const { fsMod, db } = await load();
    const R = K.records;
    const month = date.slice(0, 7);
    const countRef = fsMod.doc(db, 'wishCounts', R.countId(staffId, month));
    const snap = await fsMod.getDoc(countRef);
    const count = snap.exists() ? snap.data().count || 0 : 0;
    const now = new Date().toISOString();
    const batch = fsMod.writeBatch(db);
    batch.set(fsMod.doc(db, 'wishRequests', R.wishId(staffId, date)), R.newWish({ staffId, storeId, date, email, now }));
    batch.set(countRef, R.countDoc({ staffId, storeId, month, count: count + 1, lastDate: date, email, now }));
    await batch.commit();
  }

  // スタッフ：申請中・却下の希望休を1日消す（月の日数を1つ減らすのと、1回の書き込みで）。承認済みはルールが断る
  async function removeWishRequest({ staffId, storeId, date, email }) {
    const { fsMod, db } = await load();
    const R = K.records;
    const month = date.slice(0, 7);
    const countRef = fsMod.doc(db, 'wishCounts', R.countId(staffId, month));
    const snap = await fsMod.getDoc(countRef);
    const count = snap.exists() ? snap.data().count || 0 : 0;
    const now = new Date().toISOString();
    const batch = fsMod.writeBatch(db);
    batch.delete(fsMod.doc(db, 'wishRequests', R.wishId(staffId, date)));
    batch.set(countRef, R.countDoc({ staffId, storeId, month, count: Math.max(0, count - 1), lastDate: date, email, now }));
    await batch.commit();
  }

  // スタッフ：「希望なし」を送る（日数は変えずに、送信した印だけを残す）
  async function submitNoWish({ staffId, storeId, month, email }) {
    const { fsMod, db } = await load();
    const R = K.records;
    const countRef = fsMod.doc(db, 'wishCounts', R.countId(staffId, month));
    const snap = await fsMod.getDoc(countRef);
    const count = snap.exists() ? snap.data().count || 0 : 0;
    await fsMod.setDoc(countRef, R.countDoc({ staffId, storeId, month, count, lastDate: '', email, now: new Date().toISOString() }));
  }

  // オーナー・幹部：判断する（承認・却下・申請中に戻す）。判断と履歴を1回の書き込みで（ルールで履歴が必須）
  // kind は 'wish' か 'paid'、before は今の記録（id を含む）、role は 'owner' か 'manager'
  async function decideRequest(kind, before, { status, reason, email, role }) {
    const { fsMod, db } = await load();
    const R = K.records;
    const { patch, log } = R.decision(kind, before, { status, reason, email, role, now: new Date().toISOString() });
    const batch = fsMod.writeBatch(db);
    batch.update(fsMod.doc(db, R.collectionOf(kind), before.id), patch);
    batch.set(fsMod.doc(db, 'decisionLogs', log.id), log.data);
    await batch.commit();
    return patch;
  }

  // オーナー：申請中の有給の日付を変える（履歴と一緒に）
  async function changePaidDateLogged(before, newDate, email) {
    const { fsMod, db } = await load();
    const R = K.records;
    const now = new Date().toISOString();
    const batch = fsMod.writeBatch(db);
    batch.update(fsMod.doc(db, 'paidRequests', before.id), {
      date: newDate,
      month: newDate.slice(0, 7),
      originalDate: before.originalDate || before.date,
      changedBy: email,
      lastActionBy: email,
      lastActionAt: now,
      updatedAt: now,
    });
    const log = R.newLog('paid', before, { from: 'pending', to: 'pending', email, role: 'owner', now, note: `日付の変更 ${before.date}→${newDate}` });
    batch.set(fsMod.doc(db, 'decisionLogs', log.id), log.data);
    await batch.commit();
  }

  // ---- 変更申請（段階④） ----
  // スタッフ：変更申請を出す（change は records.newChange で作ったもの）。同じ名前がすでにあれば、ルールが断る
  async function addChangeRequest(change) {
    const { fsMod, db } = await load();
    try {
      await fsMod.setDoc(fsMod.doc(db, 'changeRequests', change.id), change.data);
    } catch (err) {
      if (err && err.code === 'permission-denied') throw new Error('変更申請を出せませんでした（すでに出している・対象が承認済みでない など）。画面を読み込み直してください。');
      throw err;
    }
  }

  // スタッフ：申請中の変更申請を取り下げる（申請中のものだけ。ルールでも止める）
  async function withdrawChangeRequest(id) {
    const { fsMod, db } = await load();
    await fsMod.deleteDoc(fsMod.doc(db, 'changeRequests', id));
  }

  // オーナー：承認された変更申請を反映する（1回の書き込みで）
  //   ・対象の希望休・有給を「取り消し済み」にする（履歴と一緒に）
  //   ・日付の変更なら、新しい日の承認済みの記録を作る（履歴と一緒に）
  //   ・変更申請に「反映した人・日時」を入れる（履歴と一緒に）
  // シフト表のマスは、呼ぶ前に requests.js が直している
  async function reflectChangeRequest({ change, target, newTarget, email }) {
    const { fsMod, db } = await load();
    const R = K.records;
    const now = new Date().toISOString();
    const batch = fsMod.writeBatch(db);
    const cancel = R.decision(change.kind, target, { status: 'cancelled', email, role: 'owner', now, note: `変更申請の反映（${change.type === 'move' ? `${change.newDate}へ変更` : '取り消し'}）` });
    batch.update(fsMod.doc(db, R.collectionOf(change.kind), target.id), cancel.patch);
    batch.set(fsMod.doc(db, 'decisionLogs', cancel.log.id), cancel.log.data);
    if (newTarget) {
      const data = { ...newTarget.data, decidedBy: email, decidedRole: 'owner', decidedAt: now, lastActionBy: email, lastActionAt: now, updatedAt: now };
      batch.set(fsMod.doc(db, R.collectionOf(change.kind), newTarget.id), data);
      const log = R.newLog(change.kind, { ...data, id: newTarget.id }, { from: '', to: 'approved', email, role: 'owner', now, note: `変更申請（日付の変更）で作成（${change.date}から）` });
      batch.set(fsMod.doc(db, 'decisionLogs', log.id), log.data);
    }
    batch.update(fsMod.doc(db, 'changeRequests', change.id), { reflectedAt: now, reflectedBy: email, lastActionBy: email, lastActionAt: now, updatedAt: now });
    const log = R.newLog('change', change, { from: 'approved', to: 'approved', email, role: 'owner', now, note: 'シフト表に反映' });
    batch.set(fsMod.doc(db, 'decisionLogs', log.id), log.data);
    await batch.commit();
  }

  // 幹部：担当店舗・担当店舗のスタッフ・希望休の設定（ルールで、担当外は読めない）
  async function loadManagerContext(manager) {
    const { fsMod, db } = await load();
    const staffOf = (storeId) => fsMod.getDocs(fsMod.query(fsMod.collection(db, 'staff'), fsMod.where('storeId', '==', storeId)));
    const [stores, staffSnaps, settings] = await Promise.all([
      Promise.all(manager.storeIds.map((id) => getData('stores', id))),
      Promise.all(manager.storeIds.map(staffOf)),
      getData('settings', 'requests'),
    ]);
    return {
      stores: stores.map((s, i) => (s ? { ...s, id: s.id || manager.storeIds[i] } : null)).filter((s) => s && !s.deleted),
      staff: staffSnaps.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }))).filter((m) => !m.deleted),
      settings,
    };
  }

  // 幹部：担当店舗のその月の申請・日数・上限の変更・判断の履歴（店舗ごとに絞って読む。ルールで、担当外は読めない）
  async function loadManagerRequests(storeIds, month) {
    const { fsMod, db } = await load();
    const read = async (col) => {
      const snaps = await Promise.all(
        storeIds.map((storeId) => fsMod.getDocs(fsMod.query(fsMod.collection(db, col), fsMod.where('storeId', '==', storeId), fsMod.where('month', '==', month))))
      );
      return snaps.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    };
    const [wishRequests, wishCounts, paidRequests, changeRequests, quotas, logs] = await Promise.all([
      read('wishRequests'),
      read('wishCounts'),
      read('paidRequests'),
      read('changeRequests'),
      read('requestQuotas'),
      read('decisionLogs'),
    ]);
    return { wishRequests, wishCounts, paidRequests, changeRequests, quotas, logs };
  }

  // 幹部：担当店舗の確定シフトの写しを、店舗ごと・指定した月の分だけ読む（作成中のシフトは読めない）
  // ルールで担当店舗の分だけを許しているので、店舗で絞らずにまとめて読むと、読み込み全体が断られる
  async function loadManagerPublishedRosters(storeIds, months) {
    const lists = await Promise.all(storeIds.map((storeId) => loadPublishedRosters(storeId, months)));
    return lists.flat();
  }

  async function isEmpty() {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'stores'), fsMod.limit(1)));
    return snap.empty;
  }

  async function signOut() {
    const { authMod, auth } = await load();
    await authMod.signOut(auth);
  }

  K.cloud = {
    supported,
    start,
    isLoginLink,
    savedEmail,
    sendLoginLink,
    completeLogin,
    checkAdmin,
    checkStaff,
    subscribe,
    write,
    isEmpty,
    signOut,
    loadStaffContext,
    loadMyRequests,
    addPaidRequest,
    withdrawPaidRequest,
    subscribeRequests,
    adminSet,
    adminUpdate,
    adminDelete,
    publishRoster,
    unpublishRoster,
    loadPublishedRosters,
    checkManager,
    addWishRequest,
    removeWishRequest,
    submitNoWish,
    decideRequest,
    changePaidDateLogged,
    loadManagerPublishedRosters,
    loadManagerContext,
    loadManagerRequests,
    addChangeRequest,
    withdrawChangeRequest,
    reflectChangeRequest,
  };
})();
