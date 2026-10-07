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

  async function isEmpty() {
    const { fsMod, db } = await load();
    const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'stores'), fsMod.limit(1)));
    return snap.empty;
  }

  async function signOut() {
    const { authMod, auth } = await load();
    await authMod.signOut(auth);
  }

  K.cloud = { supported, start, isLoginLink, savedEmail, sendLoginLink, completeLogin, checkAdmin, checkStaff, subscribe, write, isEmpty, signOut };
})();
