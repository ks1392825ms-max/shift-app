// アプリの起動と、画面の切り替えを担当するファイル
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const SCREEN_TITLES = { roster: 'シフト表', day: '1日の詳細', staff: 'スタッフ別', summary: '集計', settings: '設定', requests: '申請', login: '共有モード', request: '希望休・有給の申請' };

  // 下のタブで、どのタブを選択中にするか（1日の詳細はシフト表の中の画面）
  const TAB_OF = { roster: 'roster', day: 'roster', staff: 'staff', summary: 'summary', settings: 'settings', requests: 'requests', login: null, request: null };

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

  function render() {
    // 下から出るシートが開いたままにならないようにする
    for (const screen of Object.values(K.screens)) {
      if (typeof screen.cleanup === 'function') screen.cleanup();
    }

    // 共有モードの入口（ログインなど）では、店舗の切り替えと下のタブを隠す
    // スタッフの申請画面（request）も、店舗の切り替えと下のタブを出さない
    const gate = state.screen === 'login' || state.screen === 'request';
    document.body.classList.toggle('is-gate', gate);
    renderModeBadge();
    if (!gate) renderStoreSwitch();

    const container = document.getElementById('screen');
    container.replaceChildren();
    container.dataset.screen = state.screen;

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

  function navigate(screen, params = {}) {
    state.screen = screen;
    state.params = params;
    if (params.storeId && params.storeId !== state.storeId) {
      state.storeId = params.storeId;
      saveUiState();
    }
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
  function toast(message) {
    const box = document.getElementById('toast');
    box.textContent = message;
    box.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('is-visible'), 2000);
  }

  // ---- 共有モード ----
  // 共有モードの流れ：ログイン → 管理者か確認 → 共有データを受け取り続ける（空なら初回の移行）

  const cloud = { user: null, unsubscribe: null, unsubscribeRequests: null, ready: false, backend: null, awaitingConfirm: false, renderTimer: null };

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
      if (K.storage.isCloud()) K.storage.detachCloud();
      // ほかの端末でメールのリンクを開いた場合は、メールアドレスの入力を待つ
      showGate(cloud.awaitingConfirm ? 'confirm-email' : 'login');
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
      // 管理者でなければ、スタッフとして登録されているかを見る（スタッフは自分の情報と申請だけ）
      let account = null;
      try {
        account = cloud.backend.checkStaff ? await cloud.backend.checkStaff(user.email) : null;
      } catch (err) {
        showGate('error', { message: `権限を確認できませんでした（${err.message}）` });
        return;
      }
      if (account) {
        // スタッフ：申請画面（本人の情報と申請だけを読み書きする）
        state.screen = 'request';
        state.params = { email: user.email, account };
        render();
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
    async sendLink(email) {
      await cloud.backend.sendLoginLink(email);
      showGate('sent', { email });
    },
    async confirmEmail(email) {
      cloud.awaitingConfirm = false;
      await cloud.backend.completeLogin(email);
      // ログインが完了すると onAuth が呼ばれる
    },
    showLogin() {
      showGate('login');
    },
    async signOut() {
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
        await backend.completeLogin(email);
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
    if (K.cloud && K.cloud.supported() && (K.storage.getMode() === 'cloud' || K.cloud.isLoginLink())) {
      if (K.storage.getMode() !== 'cloud') K.storage.setMode('cloud');
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
