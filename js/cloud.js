// 共有モード：Firebase（ログイン・Firestore）とのやり取りを担当するファイル
// 「この端末だけで使う」モードでは、このファイルは Firebase の部品を読み込まず、通信もしない。
//
// 画面や storage.js からは、次の関数だけを使う（テストでは同じ形の偽物に差し替える）：
//   supported()                 共有モードを使える開き方か（https か、Mac での確認用の localhost）
//   start(onAuth)               Firebase を準備し、ログイン状態が変わるたびに onAuth(ユーザー or null) を呼ぶ
//   isLoginLink()               今のURLが、メールで届いたログイン用のリンクか
//   isLoginEntry() / loginEntryUrl()  ログイン画面をすぐに開くURL（公開URLの末尾に ?login）か／そのURL
//   savedEmail()                ログイン用のメールを送ったメールアドレス（同じ端末なら覚えている）
//   sendLoginLink(email)        ログイン用のメールを送る
//   sendStaffLoginLink(email)   オーナーが、登録したスタッフのメールにログイン用のメールを送る（この端末には覚えない）
//   sendPasswordReset(email)    パスワード再設定メールを送る（パスワードを決める・決め直す。1日に送れる数が多い）
//   inviteStaff(email)          管理者が、スタッフにパスワード設定のメールを送る（ログイン用のアカウントがまだなければ先に作る。11/13〜）
//   completeLogin(email)        メールのリンクでログインを完了する（戻り値：ログインした人の uid）。使えないリンクは code='link-invalid'
//   clearLoginLink()            アドレスバーから、ログイン用のリンクの文字を消す
//   signInWithPassword(email, password)  メールアドレスとパスワードでログインする
//   setPassword(password)       ログイン中の人のパスワードを決める（メールのリンクでログインした直後に使う）
//   checkAdmin()                管理者として登録されているか（ルールで読めるかどうかで判断）
//   checkStaff(email)           スタッフとして登録されているか（staffAccounts に本人のメールがあるか）
//   loadStaffContext / loadMyRequests / addWishRequest / removeWishRequest / submitNoWish / addPaidRequest / withdrawPaidRequest   スタッフ本人の申請
//   addSelfWish / removeSelfWish / addBusinessDay / removeBusinessDay   幹部が自分で登録する休み・社用で不在の日（その場で確定）
//   decideRequest / changePaidDateLogged                                                    判断（承認・却下・申請中に戻す）と有給の日付の変更（履歴と一緒に）
//   subscribeRequests / adminSet / adminUpdate / adminDelete                                 管理者の申請の受け取り・変更
//   publishRoster / unpublishRoster / loadPublishedRosters                                確定シフトの公開用の写し
//   checkKiosk / loadKioskData / addPunch / verifyPassword                                 勤怠用 iPad（11/9〜）
//   setAttendancePin / loadPinStatus / deleteAttendancePin                                 勤怠の番号（PIN）
//   loadAttendance / saveAttendanceEdit / loadAttendanceSettings / saveAttendanceSettings   勤怠の表・修正・集計表のパスワード
//   loadAttendanceDirectory / saveAttendanceDirectory                                     集計表用の名簿（11/12〜）
//   addPhonePunch / watchMyPunches / savePunchCheck / loadStoreGeo / loadStoreGeos / saveStoreGeo   スマホの打刻（GPS・11/14〜）
//   loadKiosks / saveKiosk / saveKioskDirectory                                             勤怠用 iPad の登録（管理者）
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
    authMod.onAuthStateChanged(auth, (user) => onAuth(user ? { email: user.email, uid: user.uid, emailVerified: user.emailVerified } : null));
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

  // ログイン画面をすぐに開くURL（スタッフに送る）。開くと、この端末だけの形でも共有モードのログイン画面になる
  function isLoginEntry() {
    return /[?&]login(=[^&]*)?(&|$)/.test(location.search);
  }

  function loginEntryUrl() {
    return returnUrl() + '?login';
  }

  // メールを送るときのエラーを、利用者に分かる文にする
  // 11/14〜 日本語の文に置き換えても、Firebase の元のエラーコード（auth/…）は code に残す（原因を調べられるように）
  function mailError(err) {
    const code = (err && err.code) || '';
    const withCode = (message) => Object.assign(new Error(message), { code });
    if (/quota-exceeded/.test(code)) return withCode('きょう送れるメールの数の上限に達しました。明日もう一度試してください。');
    if (/too-many-requests/.test(code)) return withCode('続けて送ったため、しばらく送れません。時間をおいてから試してください。');
    if (/invalid-email/.test(code)) return withCode('メールアドレスを正しく入力してください。');
    if (/network-request-failed/.test(code)) return withCode('つながりませんでした。電波の状態を確認してください。');
    return err;
  }

  async function sendLoginLink(email) {
    const { authMod, auth } = await load();
    try {
      await authMod.sendSignInLinkToEmail(auth, email, { url: returnUrl(), handleCodeInApp: true });
    } catch (err) {
      throw mailError(err);
    }
    try {
      localStorage.setItem(EMAIL_KEY, email);
    } catch (err) {
      // 覚えられなくても、リンクを開いたときにもう一度入力すればよい
    }
  }

  // オーナーが、スタッフの登録メールにログイン用のリンクを送る。
  // 送ったアドレスはこの端末に覚えない（スタッフが自分の端末でリンクを開くと、メールアドレスをもう一度入れる画面になる）
  async function sendStaffLoginLink(email) {
    const { authMod, auth } = await load();
    try {
      await authMod.sendSignInLinkToEmail(auth, email, { url: returnUrl(), handleCodeInApp: true });
    } catch (err) {
      throw mailError(err);
    }
  }

  // パスワード再設定メール（ログイン用リンクのメールより、1日に送れる数がずっと多い）。
  // リンクを開くと Firebase の画面で新しいパスワードを決める（どの端末で開いてもよい。アプリのログインは起きない）。
  // まだアカウントがない人には届かない（本番は、アドレスを探られないよう、そのときもエラーを返さない）
  async function sendPasswordReset(email) {
    const { authMod, auth } = await load();
    try {
      await authMod.sendPasswordResetEmail(auth, email, { url: loginEntryUrl() });
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') return; // 登録の有無は知らせない
      throw mailError(err);
    }
  }

  // 管理者が、スタッフにパスワード設定のメールを送る（11/13〜）。
  // パスワード再設定メールは、ログイン用のアカウントがまだない人には届かない（エラーも出ない）ので、
  // アカウントがなければ、先に作ってから送る。作るときのパスワードは、ここで作る長い乱数（保存も表示もしない。本人がメールで決め直す）。
  // 作るのは別のアプリの入れ物（この端末に保存しない）で行い、管理者のログインはそのまま。
  // 作ったアカウントは、メールの確認が済むまで（＝本人がメールのリンクでパスワードを決めるまで）アプリに入れない（app.js）
  function randomPassword() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') + 'Aa1!';
  }

  async function inviteStaff(email) {
    const { appMod, authMod } = await load();
    let created = false;
    const helper = appMod.initializeApp(K.firebaseConfig, `invite-${Date.now()}`);
    try {
      const helperAuth = authMod.initializeAuth(helper, { persistence: authMod.inMemoryPersistence });
      try {
        await authMod.createUserWithEmailAndPassword(helperAuth, email, randomPassword());
        created = true;
        await authMod.signOut(helperAuth);
      } catch (err) {
        // すでにアカウントがある人は、そのままメールを送る
        // 11/14〜 失敗したときは、どの手順か（step：create＝アカウントを作る／send＝メールを送る）と元のコードを付けて返す
        if (err && /admin-restricted-operation|operation-not-allowed/.test(err.code || '')) throw Object.assign(new Error('Firebase の設定で、新しいアカウントを作れないようになっています。'), { code: err.code, step: 'create' });
        if (!err || err.code !== 'auth/email-already-in-use') throw Object.assign(mailError(err) || new Error('アカウントを作れませんでした。'), { step: 'create' });
      }
    } finally {
      await appMod.deleteApp(helper).catch(() => {});
    }
    try {
      await sendPasswordReset(email);
    } catch (err) {
      throw Object.assign(err || new Error('メールを送れませんでした。'), { step: 'send' });
    }
    return { created };
  }

  // アドレスバーから、ログイン用のリンクの文字を消す
  function clearLoginLink() {
    history.replaceState(null, '', returnUrl());
  }

  async function completeLogin(email) {
    const { authMod, auth } = await load();
    const url = location.href;
    if (!authMod.isSignInWithEmailLink(auth, url)) throw new Error('ログイン用のリンクではありません。');
    let result;
    try {
      result = await authMod.signInWithEmailLink(auth, email, url);
    } catch (err) {
      const code = err && err.code;
      if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') {
        // 使えないリンク：アドレスからリンクの文字を消す（読み込み直しても、同じエラーがくり返されないように）
        clearLoginLink();
        const e = new Error('このリンクは使えません（期限が切れているか、すでに使われています）。');
        e.code = 'link-invalid';
        throw e;
      }
      if (code === 'auth/invalid-email') throw new Error('メールアドレスが、ログイン用のメールを送ったアドレスと違います。');
      throw err;
    }
    try {
      localStorage.removeItem(EMAIL_KEY);
    } catch (err) {
      // なにもしない
    }
    // アドレスバーからログイン用の文字を消す（再読み込みでもう一度ログインしようとしないように）
    history.replaceState(null, '', returnUrl());
    return result && result.user ? result.user.uid : null;
  }

  // Firebase のエラーを、利用者に分かる文にする（どちらが違うかは教えない）
  function passwordError(err) {
    const code = (err && err.code) || '';
    if (/invalid-credential|invalid-login-credentials|wrong-password|user-not-found|invalid-email/.test(code)) return new Error('メールアドレスかパスワードが違います。');
    if (/too-many-requests/.test(code)) return new Error('続けて間違えたため、しばらくログインできません。時間をおいてから試すか、「初めての方・パスワードを忘れた方」からパスワードを決め直してください。');
    if (/user-disabled/.test(code)) return new Error('このアカウントは使えなくなっています。オーナーに連絡してください。');
    if (/network-request-failed/.test(code)) return new Error('つながりませんでした。電波の状態を確認してください。');
    if (/weak-password/.test(code)) return new Error('パスワードが短すぎます。8文字以上にしてください。');
    if (/requires-recent-login/.test(code)) return new Error('安全のため、もう一度メールのリンクからやり直してください（「初めての方・パスワードを忘れた方」）。');
    return err;
  }

  async function signInWithPassword(email, password) {
    const { authMod, auth } = await load();
    try {
      await authMod.signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      throw passwordError(err);
    }
  }

  async function setPassword(password) {
    const { authMod, auth } = await load();
    if (!auth.currentUser) throw new Error('ログインしていません。もう一度メールのリンクからやり直してください。');
    try {
      await authMod.updatePassword(auth.currentUser, password);
    } catch (err) {
      throw passwordError(err);
    }
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

  // シフトを書く直前に、保存先の最新の状態を確かめてから書く（ほかの端末で入れた休みなどを上書きしない）
  // guard の付いた変更だけトランザクションで確かめる（決まりは K.storage.guardAllows）。戻り値：{ skipped: [{ collection, id, server }] }
  const TX_LIMIT = 200;
  async function writeGuarded(changes) {
    const { fsMod, db } = fb;
    const guarded = changes.filter((c) => c.guard);
    const plain = changes.filter((c) => !c.guard);
    const skipped = [];
    for (let i = 0; i < guarded.length; i += TX_LIMIT) {
      const part = guarded.slice(i, i + TX_LIMIT);
      const refs = part.map((c) => fsMod.doc(db, c.collection, c.id));
      const skip = await fsMod.runTransaction(db, async (tx) => {
        const snaps = await Promise.all(refs.map((r) => tx.get(r)));
        const list = [];
        part.forEach((c, j) => {
          const server = snaps[j].exists() ? snaps[j].data() : null;
          if (K.storage.guardAllows(c.guard, server, c.data)) tx.set(refs[j], JSON.parse(JSON.stringify(c.data)));
          else list.push({ collection: c.collection, id: c.id, server });
        });
        return list;
      });
      skipped.push(...skip);
    }
    if (plain.length) await write(plain);
    return { skipped };
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
    const [wishes, counts, paid, quota, changes, business] = await Promise.all([mine('wishRequests'), mine('wishCounts'), mine('paidRequests'), mine('requestQuotas'), mine('changeRequests'), mine('businessDays')]);
    return {
      businessDays: business.docs.map((d) => ({ id: d.id, ...d.data() })),
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
    const parts = { wishRequests: null, wishCounts: null, paidRequests: null, changeRequests: null, quotas: null, logs: null, businessDays: null, settings: undefined };
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
      listen('businessDays', 'businessDays'),
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

  // 幹部：自分の休みを1日登録する（承認済みで作る。希望休の記録・月の日数・履歴を、1回の書き込みで）
  async function addSelfWish({ staffId, storeId, date, email }) {
    const { fsMod, db } = await load();
    const R = K.records;
    const month = date.slice(0, 7);
    const countRef = fsMod.doc(db, 'wishCounts', R.countId(staffId, month));
    const snap = await fsMod.getDoc(countRef);
    const count = snap.exists() ? snap.data().count || 0 : 0;
    const now = new Date().toISOString();
    const id = R.wishId(staffId, date);
    const data = R.newSelfWish({ staffId, storeId, date, email, now });
    const log = R.newLog('wish', { ...data, id }, { from: '', to: 'approved', email, role: 'manager', now, note: '幹部が自分で登録' });
    const batch = fsMod.writeBatch(db);
    batch.set(fsMod.doc(db, 'wishRequests', id), data);
    batch.set(countRef, R.countDoc({ staffId, storeId, month, count: count + 1, lastDate: date, email, now }));
    await batch.commit();
    // 判断の履歴は、別の書き込みで残す（1回の書き込みにまとめると、Firestore のルールの計算の回数の上限をこえるため。11/5）
    // 休みの記録そのものに「誰が・いつ・幹部として確定したか」は入っている。履歴を書けなくても、休みの登録は済んでいる
    try {
      await fsMod.setDoc(fsMod.doc(db, 'decisionLogs', log.id), log.data);
    } catch (err) {
      console.warn('判断の履歴を残せませんでした', err && err.message);
    }
  }

  // 幹部：自分で登録した休みを取り消す（受付期間だけ。月の日数を1つ減らすのと、1回の書き込みで）
  async function removeSelfWish({ staffId, storeId, date, email }) {
    await removeWishRequest({ staffId, storeId, date, email });
  }

  // 幹部：社用で不在の日を登録する・取り消す
  async function addBusinessDay(rec) {
    const { fsMod, db } = await load();
    try {
      await fsMod.setDoc(fsMod.doc(db, 'businessDays', rec.id), rec.data);
    } catch (err) {
      if (err && err.code === 'permission-denied') throw new Error('登録できませんでした（受付期間外・担当外・すでに登録済み など）。画面を読み込み直してください。');
      throw err;
    }
  }

  async function removeBusinessDay(id) {
    const { fsMod, db } = await load();
    await fsMod.deleteDoc(fsMod.doc(db, 'businessDays', id));
  }

  // ---- 勤怠（11/9〜） ----

  // 勤怠用 iPad のアカウントか（kiosks/{メール}）。戻り値：{ storeId } か null
  async function checkKiosk(email) {
    const { fsMod, db } = await load();
    try {
      const snap = await fsMod.getDoc(fsMod.doc(db, 'kiosks', String(email || '').toLowerCase()));
      if (!snap.exists()) return null;
      const k = snap.data();
      return k.deleted || !k.storeId ? null : { storeId: k.storeId };
    } catch (err) {
      if (err && err.code === 'permission-denied') return null;
      throw err;
    }
  }

  // 勤怠用 iPad：その店舗の名前・今月の確定シフトの写し・名前の一覧・今日の打刻
  // prevDate（11/12〜 0時〜5時だけ）：前の日の打刻も読む（日をまたぐ勤務の人が、退勤を押せるように）
  async function loadKioskData(storeId, date, { prevDate } = {}) {
    const { fsMod, db } = await load();
    const month = date.slice(0, 7);
    const punchesOf = (d) => fsMod.getDocs(fsMod.query(fsMod.collection(db, 'punches'), fsMod.where('storeId', '==', storeId), fsMod.where('date', '==', d)));
    const [store, roster, directory, punchSnap, prevSnap] = await Promise.all([
      getData('stores', storeId),
      getData('publishedRosters', `${storeId}_${month}`).catch((err) => (err && err.code === 'permission-denied' ? null : Promise.reject(err))),
      getData('kioskDirectory', storeId).catch(() => null),
      punchesOf(date),
      prevDate ? punchesOf(prevDate) : Promise.resolve(null),
    ]);
    const docs = [...(prevSnap ? prevSnap.docs : []), ...punchSnap.docs];
    return { store: store ? { ...store, id: storeId } : null, roster, directory, punches: docs.map((d) => ({ id: d.id, ...d.data() })) };
  }

  // 打刻：打刻の記録と、番号の確かめ用の記録を1回の書き込みで（番号が違えば、ルールが両方とも断る）
  async function addPunch({ id, data, proof }) {
    const { fsMod, db } = await load();
    const batch = fsMod.writeBatch(db);
    batch.set(fsMod.doc(db, 'punchProofs', id), proof);
    batch.set(fsMod.doc(db, 'punches', id), data);
    await batch.commit();
  }

  // ログイン中の人のパスワードを確かめる（勤怠用 iPad を閉じるとき）
  async function verifyPassword(password) {
    const { authMod, auth } = await load();
    const user = auth.currentUser;
    if (!user) throw new Error('ログインしていません。');
    try {
      await authMod.reauthenticateWithCredential(user, authMod.EmailAuthProvider.credential(user.email, password));
      return true;
    } catch (err) {
      return false;
    }
  }

  async function setAttendancePin(rec) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'attendancePins', rec.staffId), rec);
  }

  // 管理者：番号を決めた人（スタッフID の一覧）
  async function loadPinStatus() {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDocs(fsMod.collection(db, 'attendancePins'));
    return snap.docs.map((d) => ({ staffId: d.id, updatedAt: d.data().updatedAt || '', updatedBy: d.data().updatedBy || '' }));
  }

  async function deleteAttendancePin(staffId) {
    const { fsMod, db } = await load();
    await fsMod.deleteDoc(fsMod.doc(db, 'attendancePins', staffId));
  }

  // 管理者・幹部：店舗・月の打刻・直したもの・修正の記録（11/12〜 幹部は3店舗とも読める。直せるのは担当店舗だけ）
  // 打刻は、前の月の最終日と次の月の1日の分も読む（日をまたぐ勤務を、正しい日に分けるため）
  async function loadAttendance(storeId, month) {
    const { fsMod, db } = await load();
    const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const read = async (col) => docs(await fsMod.getDocs(fsMod.query(fsMod.collection(db, col), fsMod.where('storeId', '==', storeId), fsMod.where('month', '==', month))));
    const onDay = async (date) => docs(await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'punches'), fsMod.where('storeId', '==', storeId), fsMod.where('date', '==', date))));
    const [y, m] = month.split('-').map(Number);
    const prevLast = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const nextFirst = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const [punches, edits, logs, before, after, checks] = await Promise.all([read('punches'), read('punchEdits'), read('attendanceLogs'), onDay(prevLast), onDay(nextFirst), read('punchChecks')]);
    return { punches: [...before, ...punches, ...after], edits, logs, checks };
  }

  // ---- スマホの打刻（GPS・11/14〜） ----
  // スタッフ本人が、自分の分を出す（番号はいらない）
  async function addPhonePunch({ id, data }) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'punches', id), data);
  }

  // スタッフ本人の、今日と前の日の打刻と、その確認を受け取り続ける（iPad で打った分も、すぐ反映）。戻り値で止められる
  async function watchMyPunches(staffId, dates, onData, onError) {
    const { fsMod, db } = await load();
    const state = { punches: new Map(), checks: [] };
    const emit = () => onData({ punches: [...state.punches.values()].flat(), checks: state.checks });
    const stops = dates.map((date) =>
      fsMod.onSnapshot(
        fsMod.query(fsMod.collection(db, 'punches'), fsMod.where('staffId', '==', staffId), fsMod.where('date', '==', date)),
        (snap) => {
          state.punches.set(date, snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          emit();
        },
        onError
      )
    );
    stops.push(
      fsMod.onSnapshot(
        fsMod.query(fsMod.collection(db, 'punchChecks'), fsMod.where('staffId', '==', staffId), fsMod.where('date', 'in', dates)),
        (snap) => {
          state.checks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          emit();
        },
        onError
      )
    );
    return () => stops.forEach((f) => f());
  }

  // 管理者・幹部：例外の打刻を認める・認めない
  async function savePunchCheck({ id, data }) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'punchChecks', id), data);
  }

  // お店の位置：1店舗（スタッフ・幹部・管理者）／全部（管理者）／決める（管理者）
  async function loadStoreGeo(storeId) {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDoc(fsMod.doc(db, 'storeGeo', storeId));
    return snap.exists() ? snap.data() : null;
  }

  async function loadStoreGeos() {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDocs(fsMod.collection(db, 'storeGeo'));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async function saveStoreGeo(storeId, data) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'storeGeo', storeId), data);
  }

  // 集計表用の名簿（11/12〜）：店舗ごとの名前・従業員番号・氏名・職種・勤務パターンの休憩・有給の日。管理者が作り、管理者と幹部が読む
  async function loadAttendanceDirectory() {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDocs(fsMod.collection(db, 'attendanceDirectory'));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async function saveAttendanceDirectory(storeId, data) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'attendanceDirectory', storeId), data);
  }

  // 直す：直した1日分と、修正の記録を1回の書き込みで
  async function saveAttendanceEdit({ id, data, logId, log }) {
    const { fsMod, db } = await load();
    const batch = fsMod.writeBatch(db);
    batch.set(fsMod.doc(db, 'attendanceLogs', logId), log);
    batch.set(fsMod.doc(db, 'punchEdits', id), data);
    try {
      await batch.commit();
    } catch (err) {
      if (err && err.code === 'permission-denied') throw new Error('保存できませんでした（締めたあと・担当外 など）。画面を読み込み直してください。');
      throw err;
    }
  }

  async function loadAttendanceSettings() {
    return (await getData('settings', 'attendance').catch((err) => (err && err.code === 'permission-denied' ? null : Promise.reject(err)))) || {};
  }

  async function saveAttendanceSettings(data) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'settings', 'attendance'), data, { merge: true });
  }

  // 管理者：勤怠用 iPad のアカウントの一覧・登録・解除
  async function loadKiosks() {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDocs(fsMod.collection(db, 'kiosks'));
    return snap.docs.map((d) => ({ email: d.id, ...d.data() }));
  }

  async function saveKiosk(email, data) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'kiosks', String(email).toLowerCase()), data);
  }

  // 管理者：iPad に出す名前の一覧（名前と ID だけ）
  async function saveKioskDirectory(storeId, data) {
    const { fsMod, db } = await load();
    await fsMod.setDoc(fsMod.doc(db, 'kioskDirectory', storeId), data);
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
    const [wishRequests, wishCounts, paidRequests, changeRequests, quotas, logs, businessDays] = await Promise.all([
      read('wishRequests'),
      read('wishCounts'),
      read('paidRequests'),
      read('changeRequests'),
      read('requestQuotas'),
      read('decisionLogs'),
      read('businessDays'),
    ]);
    return { wishRequests, wishCounts, paidRequests, changeRequests, quotas, logs, businessDays };
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
    isLoginEntry,
    loginEntryUrl,
    savedEmail,
    sendLoginLink,
    sendStaffLoginLink,
    sendPasswordReset,
    inviteStaff,
    addPhonePunch,
    watchMyPunches,
    savePunchCheck,
    loadStoreGeo,
    loadStoreGeos,
    saveStoreGeo,
    mailError, // テスト用（エラーの文）
    completeLogin,
    clearLoginLink,
    signInWithPassword,
    setPassword,
    passwordError, // テスト用（エラーの文）
    checkAdmin,
    checkStaff,
    subscribe,
    write,
    writeGuarded,
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
    addSelfWish,
    removeSelfWish,
    addBusinessDay,
    removeBusinessDay,
    decideRequest,
    changePaidDateLogged,
    loadManagerPublishedRosters,
    loadManagerContext,
    loadManagerRequests,
    addChangeRequest,
    withdrawChangeRequest,
    reflectChangeRequest,
    checkKiosk,
    loadKioskData,
    addPunch,
    verifyPassword,
    setAttendancePin,
    loadPinStatus,
    deleteAttendancePin,
    loadAttendance,
    loadAttendanceDirectory,
    saveAttendanceDirectory,
    saveAttendanceEdit,
    loadAttendanceSettings,
    saveAttendanceSettings,
    loadKiosks,
    saveKiosk,
    saveKioskDirectory,
  };
})();
