// アプリの起動と、画面の切り替えを担当するファイル
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const SCREEN_TITLES = { roster: 'シフト表', day: '1日の詳細', monthTimeline: '月のタイムライン', staff: 'スタッフ別', summary: '集計', settings: '設定', requests: '申請', login: '共有モード', request: '希望休・有給の申請', manager: '幹部の画面' };

  // 下のタブで、どのタブを選択中にするか（1日の詳細はシフト表の中の画面）
  const TAB_OF = { roster: 'roster', day: 'roster', monthTimeline: 'roster', staff: 'staff', summary: 'summary', settings: 'settings', requests: 'requests', login: null, request: null, manager: null };

  // 表示中の店舗を、次に開いたときも同じにするための保存場所（シフトのデータとは別。消えても困らない）
  const UI_KEY = 'shift-app-ui';

  const state = {
    screen: 'roster',
    params: {},
    month: U.todayStr().slice(0, 7), // 表示している月（"2026-10"）
    storeId: null, // 表示している店舗。すべての画面で共通（ヘッダーの店舗の切り替えで選ぶ）
  };

  function loadUiState() {
    try {
      const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
      if (saved.storeId) state.storeId = saved.storeId;
    } catch (err) {
      // 読めなければ最初の店舗を表示する
    }
  }

  function saveUiState() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ storeId: state.storeId }));
    } catch (err) {
      // 保存できなくても動作には影響しない
    }
  }

  // 表示中の店舗（登録されていない店舗が選ばれていたら、最初の店舗にする）
  function currentStore() {
    const stores = K.storage.getStores();
    const store = stores.find((s) => s.id === state.storeId) || stores[0];
    state.storeId = store.id;
    return store;
  }

  // ヘッダーの店舗の切り替え
  // 3店舗までは横に並んだボタン、4店舗以上はスマホでも押しやすい選択メニューにする
  const SWITCH_BUTTONS_MAX = 3;

  function renderStoreSwitch() {
    const box = document.getElementById('store-switch');
    const store = currentStore();
    document.documentElement.style.setProperty('--current-store-color', store.color);
    if (!box) return;
    const stores = K.storage.getStores();
    const useMenu = stores.length > SWITCH_BUTTONS_MAX;
    box.classList.toggle('segment', !useMenu);
    box.classList.toggle('header-store--menu', useMenu);
    if (useMenu) {
      box.replaceChildren(
        U.el(
          'select',
          {
            class: 'store-select',
            'aria-label': '表示する店舗',
            style: { '--store-color': store.color },
            onchange: (event) => setStore(event.currentTarget.value),
          },
          stores.map((s) => U.el('option', { value: s.id, selected: s.id === store.id }, s.name))
        )
      );
      return;
    }
    box.replaceChildren(
      ...stores.map((s) =>
        U.el(
          'button',
          {
            type: 'button',
            class: `segment__btn${s.id === store.id ? ' is-selected' : ''}`,
            style: { '--store-color': s.color },
            'aria-pressed': String(s.id === store.id),
            onclick: () => setStore(s.id),
          },
          s.name
        )
      )
    );
  }

  // 同じ画面を作り直すとき（共有データが届いた・入力のあとなど）は、スクロールの位置と、選んでいたマスを戻す。
  // 画面・店舗・月・表示の条件が変わったとき（タブの移動・月や店舗の切り替え）は戻さない
  let lastViewKey = null;

  function viewKey() {
    return JSON.stringify([state.screen, state.storeId, state.month, state.params]);
  }

  function rememberView() {
    if (viewKey() !== lastViewKey) return null;
    const wrap = document.querySelector('#screen .roster-wrap');
    const active = document.activeElement;
    const cell = active && active.closest && active.closest('#screen [data-staff][data-date]');
    return {
      x: window.scrollX,
      y: window.scrollY,
      wrap: wrap ? [wrap.scrollLeft, wrap.scrollTop] : null,
      cell: cell ? [cell.dataset.staff, cell.dataset.date] : null,
    };
  }

  function restoreView(kept) {
    if (!kept) return;
    const wrap = document.querySelector('#screen .roster-wrap');
    if (wrap && kept.wrap) [wrap.scrollLeft, wrap.scrollTop] = kept.wrap;
    window.scrollTo(kept.x, kept.y);
    // 選んでいたマスに戻る（入力シートを開いているときは、シートのほうを優先する）
    if (kept.cell && !document.querySelector('.sheet-layer')) {
      const target = document.querySelector(`#screen button[data-staff="${kept.cell[0]}"][data-date="${kept.cell[1]}"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function render() {
    const kept = rememberView();
    // 下から出るシートが開いたままにならないようにする
    for (const screen of Object.values(K.screens)) {
      if (typeof screen.cleanup === 'function') screen.cleanup();
    }

    // 共有モードの入口（ログインなど）では、店舗の切り替えと下のタブを隠す
    // スタッフの申請画面（request）・幹部の画面（manager）も、店舗の切り替えと下のタブを出さない
    const gate = state.screen === 'login' || state.screen === 'request' || state.screen === 'manager';
    document.body.classList.toggle('is-gate', gate);
    renderModeBadge();
    renderRoleBadge();
    if (!gate) renderStoreSwitch();

    const container = document.getElementById('screen');
    container.replaceChildren();
    container.dataset.screen = state.screen;
    renderLocalNotice(gate);

    const title = SCREEN_TITLES[state.screen];
    document.getElementById('screen-title').textContent = title;
    document.title = gate ? `${title} | シフト管理` : `${currentStore().name} ${title} | シフト管理`;

    for (const btn of document.querySelectorAll('.bottom-nav__btn')) {
      const current = btn.dataset.screen === TAB_OF[state.screen];
      btn.classList.toggle('is-active', current);
      if (current) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }

    K.screens[state.screen].render(container, state.params);
    lastViewKey = viewKey();
    restoreView(kept);
  }

  // 「この端末だけ」モードの案内（公開URLで開いたときだけ）：見本や端末だけのデータを、共有のデータと間違えないように
  function renderLocalNotice(gate) {
    let box = document.getElementById('local-notice');
    const show = !gate && !K.storage.isCloud() && Boolean(K.cloud && K.cloud.supported());
    if (!show) {
      if (box) box.remove();
      return;
    }
    if (box) return;
    box = U.el(
      'div',
      { id: 'local-notice', class: 'local-notice', role: 'note' },
      U.el('span', { class: 'local-notice__text' }, K.storage.isPristineSample() ? 'この端末だけの見本のデータを表示しています。' : 'この端末だけのデータを表示しています（共有のデータではありません）。'),
      U.el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => cloudActions.switchToCloud() }, '共有のデータを見る（ログイン）')
    );
    const header = document.querySelector('.app-header');
    if (header) header.after(box);
    else document.body.prepend(box);
  }

  // ヘッダーの「共有中」の印
  function renderModeBadge() {
    const badge = document.getElementById('mode-badge');
    if (!badge) return;
    const on = K.storage.isCloud() && Boolean(cloud.user);
    badge.hidden = !on;
    badge.textContent = on ? '共有中' : '';
    badge.title = on ? `共有モード（${cloud.user.email} でログイン中）` : '';
  }

  // 誰としてログインしているか：「SHIFT」の枠の色と名札（管理者＝オレンジ・幹部＝赤・スタッフ＝白）
  // ログインの前・「この端末だけ」モードでは出さない
  const ROLE_LABELS = { admin: '管理者', manager: '幹部', 'manager-self': '幹部（自分の申請）', staff: 'スタッフ' };

  function currentRole() {
    if (!cloud.user) return null;
    if (state.screen === 'manager') return 'manager';
    if (state.screen === 'request') return state.params && state.params.manager ? 'manager-self' : 'staff';
    if (state.screen !== 'login' && cloud.ready && K.storage.isCloud()) return 'admin';
    return null;
  }

  function renderRoleBadge() {
    const role = currentRole();
    if (role) document.body.dataset.role = role === 'manager-self' ? 'manager' : role;
    else delete document.body.dataset.role;
    const title = document.querySelector('.app-title');
    if (!title) return;
    let badge = document.getElementById('role-badge');
    if (!badge) {
      badge = U.el('span', { id: 'role-badge', class: 'login-role' });
      title.after(badge);
    }
    badge.hidden = !role;
    badge.textContent = role ? ROLE_LABELS[role] : '';
  }

  function navigate(screen, params = {}) {
    state.screen = screen;
    state.params = params;
    if (params.storeId && params.storeId !== state.storeId) {
      state.storeId = params.storeId;
      saveUiState();
    }
    lastViewKey = null; // 画面を移ったときは、一番上から表示する
    render();
    window.scrollTo(0, 0);
  }

  function setMonth(month) {
    state.month = month;
    render();
  }

  function setStore(storeId) {
    if (state.storeId === storeId) return;
    state.storeId = storeId;
    saveUiState();
    // 1日の詳細などで開いていたスタッフの指定は、店舗を変えたら使わない
    if (state.params.staffId) state.params = { ...state.params, staffId: undefined };
    render();
  }

  let toastTimer = null;
  // ms：出しておく時間（長い案内や、理由を読んでもらうメッセージは長めにする）
  function toast(message, ms = 2000) {
    const box = document.getElementById('toast');
    box.textContent = message;
    box.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('is-visible'), ms);
  }

  // ---- 共有モード ----
  // 共有モードの流れ：ログイン → 管理者か確認 → 共有データを受け取り続ける（空なら初回の移行）

  const cloud = { user: null, unsubscribe: null, unsubscribeRequests: null, ready: false, backend: null, awaitingConfirm: false, renderTimer: null, unlockedUid: null };

  // 簡単ログイン（この端末のロック）：設定してあれば、データを読み込む前に PIN か顔認証・指紋認証で解除してもらう。
  // 解除できたら true。「メールでログインし直す」を選んだ・続けて間違えたら false（そのあとログアウトする）
  async function unlockIfNeeded(user) {
    const Q = K.quickLock;
    if (!Q || cloud.unlockedUid === user.uid || !Q.isEnabled(user.uid)) return true;
    showGate('loading');
    const ok = await Q.lock(user.uid);
    if (cloud.user !== user) return false; // 待っている間にログアウトした
    if (ok) cloud.unlockedUid = user.uid;
    return ok;
  }

  // メールのリンクでログインしたら、アプリに入る前に、必ずその場でパスワードを決めてもらう。
  // （まだログインしたことのない人のアドレスで、ほかの人が先にパスワードを決めていた場合に、それを上書きするため）
  // 決め終わるまでは、開き直しても同じ画面に戻るよう、この端末に印を残す（値はログインした人の uid。分からないときは *）
  const NEED_PASSWORD_KEY = 'shift-app-need-password';

  function needPassword(user) {
    try {
      const v = localStorage.getItem(NEED_PASSWORD_KEY);
      return Boolean(v && user && (v === '*' || v === user.uid));
    } catch (err) {
      return false;
    }
  }

  function setNeedPassword(uid) {
    try {
      if (uid === null) localStorage.removeItem(NEED_PASSWORD_KEY);
      else localStorage.setItem(NEED_PASSWORD_KEY, uid || '*');
    } catch (err) {
      // 覚えられなくても、この画面の間はパスワードを決めてもらう
    }
  }

  // ログインのあとに一度だけ、簡単ログインを設定するかをたずねる
  function offerQuickLock() {
    if (K.quickLock && cloud.user) setTimeout(() => K.quickLock.offer(cloud.user), 300);
  }

  function showGate(gateState, info = {}) {
    state.screen = 'login';
    state.params = { state: gateState, info };
    render();
  }

  // ログイン状態が変わったとき
  async function onAuth(user) {
    if (cloud.unsubscribe) {
      cloud.unsubscribe();
      cloud.unsubscribe = null;
    }
    if (cloud.unsubscribeRequests) {
      cloud.unsubscribeRequests();
      cloud.unsubscribeRequests = null;
    }
    K.requests.clearAdminData();
    cloud.ready = false;
    cloud.user = user;
    if (!user) {
      cloud.unlockedUid = null;
      setNeedPassword(null);
      // ログアウトしたら、この端末の簡単ログインも解除する（「この端末では使わない」の設定は残す）
      if (K.quickLock) K.quickLock.clear();
      if (K.storage.isCloud()) K.storage.detachCloud();
      // ほかの端末でメールのリンクを開いた場合は、メールアドレスの入力を待つ
      if (cloud.linkError) {
        // 使えないリンクを開いたとき：行き止まりにせず、新しいメールを送れる画面にする
        showGate('link-error', cloud.linkError);
        cloud.linkError = null;
        return;
      }
      showGate(cloud.awaitingConfirm ? 'confirm-email' : 'login', cloud.loginNotice ? { notice: cloud.loginNotice } : {});
      cloud.loginNotice = '';
      return;
    }
    cloud.linkError = null; // ログインできているので、使えなかったリンクの案内は出さない
    // メールの確認が済んでいないアカウント（パスワードだけで作られたもの）では使わない
    if (user.emailVerified === false) {
      cloud.loginNotice = 'このメールアドレスは、まだ確認が済んでいません。「初めての方・パスワードを忘れた方」から、パスワードを決めてください。';
      await cloud.backend.signOut();
      return;
    }
    // メールのリンクでログインした直後：パスワードを決めるまで、アプリには入らない
    if (needPassword(user)) {
      showGate('set-password', { email: user.email });
      return;
    }
    if (!(await unlockIfNeeded(user))) {
      if (cloud.user === user) await cloud.backend.signOut();
      return;
    }
    showGate('loading');
    let admin;
    try {
      admin = await cloud.backend.checkAdmin();
    } catch (err) {
      showGate('error', { message: `権限を確認できませんでした（${err.message}）` });
      return;
    }
    if (!admin) {
      // オーナーでなければ、幹部として登録されているか（managers）と、スタッフとして登録されているかを見る
      // 幹部：担当店舗の申請の判断と、全店舗の確定シフトだけ。スタッフ：自分の情報と申請だけ
      let account = null;
      let manager = null;
      try {
        manager = cloud.backend.checkManager ? await cloud.backend.checkManager(user.email) : null;
        account = cloud.backend.checkStaff ? await cloud.backend.checkStaff(user.email) : null;
      } catch (err) {
        showGate('error', { message: `権限を確認できませんでした（${err.message}）` });
        return;
      }
      if (manager) {
        // 幹部の画面（スタッフとしても登録されていれば、そこから自分の申請の画面へ移れる）
        state.screen = 'manager';
        state.params = { email: user.email, manager, account };
        render();
        offerQuickLock();
      } else if (account) {
        // スタッフ：申請画面（本人の情報と申請だけを読み書きする）
        state.screen = 'request';
        state.params = { email: user.email, account };
        render();
        offerQuickLock();
      } else {
        showGate('not-admin', { email: user.email });
      }
      return;
    }
    cloud.unsubscribe = cloud.backend.subscribe(onCloudData, (err) => {
      console.error(err);
      toast('共有データを受け取れませんでした。電波の状態を確認してください');
    });
  }

  // 共有データが届いたとき（最初の1回と、ほかの管理者が変えたとき）
  function onCloudData(cloudData) {
    const hasStores = (cloudData.stores || []).some((s) => !s.deleted);
    if (!hasStores) {
      showGate('empty', { email: cloud.user && cloud.user.email });
      return;
    }
    if (!cloud.ready) {
      cloud.ready = true;
      K.storage.attachCloud(cloud.backend, cloudData);
      // 管理者：全店舗の希望休・有給申請も受け取り続ける（申請タブ・シフト表の「希」の印）
      if (cloud.backend.subscribeRequests) {
        cloud.unsubscribeRequests = cloud.backend.subscribeRequests(
          (d) => {
            K.requests.setAdminData(d);
            renderWhenIdle();
          },
          (err) => console.error(err)
        );
      }
      navigate('roster');
      offerQuickLock();
      return;
    }
    K.storage.receiveCloudData(cloudData);
    renderWhenIdle();
  }

  // 入力シートなどを開いている途中で画面が作り直されないよう、閉じるまで待ってから反映する
  function renderWhenIdle() {
    clearTimeout(cloud.renderTimer);
    if (document.querySelector('.sheet-layer')) {
      cloud.renderTimer = setTimeout(renderWhenIdle, 800);
      return;
    }
    render();
  }

  // ログイン画面などのボタンから呼ぶ操作
  const cloudActions = {
    // パスワード再設定メールを送る（初めての方・パスワードを忘れた方。1日に送れる数が多い）
    async sendReset(email) {
      await cloud.backend.sendPasswordReset(email);
      showGate('sent-reset', { email });
    },
    // まだ一度もログインしたことがない人：ログイン用のリンクを送る（開くと、その場でパスワードを決める）
    async sendLink(email) {
      await cloud.backend.sendLoginLink(email);
      showGate('sent', { email });
    },
    async confirmEmail(email) {
      setNeedPassword('*');
      let uid;
      try {
        uid = await cloud.backend.completeLogin(email);
      } catch (err) {
        setNeedPassword(null);
        if (err && err.code === 'link-invalid') {
          cloud.awaitingConfirm = false;
          showGate('link-error', { email });
          return;
        }
        // アドレスの入れ間違いなど：同じリンクのまま、もう一度入れられる
        throw err;
      }
      cloud.awaitingConfirm = false;
      if (uid) setNeedPassword(uid);
      // ログインが完了すると onAuth が呼ばれる
    },
    // メールアドレスとパスワードでログインする（ログインが完了すると onAuth が呼ばれる）
    async signInWithPassword(email, password) {
      await cloud.backend.signInWithPassword(email, password);
    },
    // メールのリンクでログインしたあと、パスワードを決める → そのままアプリに入る
    async setPassword(password) {
      await cloud.backend.setPassword(password);
      setNeedPassword(null);
      if (cloud.user) onAuth(cloud.user);
    },
    showLogin() {
      showGate('login');
    },
    // ログイン中の人が、パスワードを決め直す：自分のメールにリンクを送る（開くと、新しいパスワードを決める画面）
    async requestPasswordChange() {
      if (!cloud.user) throw new Error('ログインしていません。');
      await cloud.backend.sendPasswordReset(cloud.user.email);
    },
    // 「初めての方・パスワードを忘れた方」
    showReset(email) {
      showGate('reset', { email: email || '' });
    },
    async signOut() {
      if (K.quickLock) K.quickLock.clear();
      setNeedPassword(null);
      await cloud.backend.signOut();
    },
    upload(incoming) {
      return K.storage.uploadToCloud(cloud.backend, incoming);
    },
    startFresh(storeName) {
      return K.storage.startFreshCloud(cloud.backend, storeName);
    },
    // この端末だけで使う形に戻す（端末のデータは、共有モードの間も変わっていない）
    backToLocal() {
      K.storage.setMode('local');
      location.href = location.pathname;
    },
    // 共有モードに切り替える（設定 > データ から）
    switchToCloud() {
      K.storage.setMode('cloud');
      location.href = location.pathname;
    },
  };

  async function startCloud(backend) {
    cloud.backend = backend;
    if (K.quickLock) K.quickLock.watchVisibility(() => cloud.user && cloud.user.uid);
    K.requests.attach(backend);
    K.storage.onCloudError((err) => toast(`共有の保存場所に保存できませんでした（${err.code || err.message}）`));
    showGate('loading');
    try {
      if (backend.isLoginLink()) {
        const email = backend.savedEmail();
        if (!email) {
          // ほかの端末でメールのリンクを開いたとき：メールアドレスをもう一度入力してもらう（入力されると confirmEmail からログインが進む）
          cloud.awaitingConfirm = true;
          await backend.start(onAuth);
          return;
        }
        // リンクでログインしたら、このあとパスワードを決めてもらう
        setNeedPassword('*');
        try {
          const uid = await backend.completeLogin(email);
          if (uid) setNeedPassword(uid);
        } catch (err) {
          setNeedPassword(null);
          if (!err || err.code !== 'link-invalid') throw err;
          // 使えないリンク：ログインしていなければ「新しいメールを送る」画面（すでにログイン中なら、そのまま使える）
          cloud.linkError = { email };
          toast('このリンクは使えませんでした（期限切れか、使用済み）', 5000);
        }
      }
      await backend.start(onAuth);
    } catch (err) {
      console.error(err);
      showGate('error', { message: err.message });
    }
  }

  function start() {
    const result = K.storage.init();
    if (!result.ok) {
      document.getElementById('screen').replaceChildren(U.el('p', { class: 'fatal', role: 'alert' }, result.message));
      return;
    }
    loadUiState();
    for (const btn of document.querySelectorAll('.bottom-nav__btn')) {
      btn.addEventListener('click', () => navigate(btn.dataset.screen));
    }
    // 別のタブ（ウィンドウ）で変更されたら、最新の内容で画面を作り直す（端末だけのモード）
    K.storage.onExternalChange(() => {
      render();
      toast('別のタブで変更された内容を読み込みました');
    });
    registerServiceWorker();
    // 共有モードを選んでいて、使える開き方（公開 URL）なら共有モードで始める。
    // メールのログイン用リンクを開いたとき（別のブラウザで開いた場合も）は、共有モードに切り替えてログインを進める
    // ログイン用のURL（末尾に ?login）で開いたときも、共有モードのログイン画面にする（スタッフ向け）
    const loginEntry = Boolean(K.cloud && K.cloud.isLoginEntry && K.cloud.isLoginEntry());
    // まだモードを選んだことがなく、この端末のデータが見本のまま（ホーム画面・Dock に追加したばかりのアプリなど）
    // → 見本の店舗A・Bではなく、共有モード（ログイン画面）で始める。実際に入力したことがある端末は、勝手に切り替えない
    const firstOpen = Boolean(K.cloud && K.cloud.supported() && !K.storage.hasChosenMode() && K.storage.isPristineSample());
    if (K.cloud && K.cloud.supported() && (K.storage.getMode() === 'cloud' || K.cloud.isLoginLink() || loginEntry || firstOpen)) {
      if (K.storage.getMode() !== 'cloud') K.storage.setMode('cloud');
      // アドレスバーから ?login を消す（ホーム画面に追加したときに、ふつうのURLになるように）
      if (loginEntry) history.replaceState(null, '', location.pathname + location.hash);
      startCloud(K.cloud);
      return;
    }
    navigate('roster');
  }

  // 公開した URL（https）で開いたときだけ、電波がなくても開けるようにする仕組みを登録する
  // （index.html をダブルクリックで開いたときは使えないので登録しない。localhost は Mac での動作確認用）
  function registerServiceWorker() {
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure || !('serviceWorker' in navigator)) return;
    // 前から仕組みが動いていたか（初めて開いたときは、お知らせを出さない）
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => {
        // 新しい版（sw.js が変わった）が届いたら、お知らせを出す
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated' && hadController) showUpdateBanner();
          });
        });
        // 画面に戻ってきたときにも、新しい版があるか確かめる
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch((err) => console.warn('Service Worker の登録に失敗しました', err));
  }

  // 「新しい版があります」のお知らせ（押すと読み込み直す）
  function showUpdateBanner() {
    if (document.getElementById('update-banner')) return;
    const banner = U.el(
      'div',
      { id: 'update-banner', class: 'update-banner', role: 'status' },
      U.el('span', null, '新しい版があります'),
      U.el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => location.reload() }, '更新する')
    );
    document.body.append(banner);
  }

  K.app = {
    state,
    navigate,
    setMonth,
    setStore,
    currentStore,
    rerender: render,
    toast,
    cloudActions,
    cloudUser: () => cloud.user,
    cloudBackend: () => cloud.backend,
    startCloud, // テスト用（偽の保存場所で共有モードを動かす）
    showUpdateBanner, // テスト用
  };

  document.addEventListener('DOMContentLoaded', start);
})();
