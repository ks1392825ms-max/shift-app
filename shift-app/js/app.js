// アプリの起動と、画面の切り替えを担当するファイル
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const SCREEN_TITLES = { roster: 'シフト表', day: '1日の詳細', staff: 'スタッフ別', summary: '集計', settings: '設定' };

  // 下のタブで、どのタブを選択中にするか（1日の詳細はシフト表の中の画面）
  const TAB_OF = { roster: 'roster', day: 'roster', staff: 'staff', summary: 'summary', settings: 'settings' };

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

    renderStoreSwitch();

    const container = document.getElementById('screen');
    container.replaceChildren();
    container.dataset.screen = state.screen;

    const title = SCREEN_TITLES[state.screen];
    document.getElementById('screen-title').textContent = title;
    document.title = `${currentStore().name} ${title} | シフト管理`;

    for (const btn of document.querySelectorAll('.bottom-nav__btn')) {
      const current = btn.dataset.screen === TAB_OF[state.screen];
      btn.classList.toggle('is-active', current);
      if (current) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }

    K.screens[state.screen].render(container, state.params);
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
    // 別のタブ（ウィンドウ）で変更されたら、最新の内容で画面を作り直す
    K.storage.onExternalChange(() => {
      render();
      toast('別のタブで変更された内容を読み込みました');
    });
    registerServiceWorker();
    navigate('roster');
  }

  // 公開した URL（https）で開いたときだけ、電波がなくても開けるようにする仕組みを登録する
  // （index.html をダブルクリックで開いたときは使えないので登録しない。localhost は Mac での動作確認用）
  function registerServiceWorker() {
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker の登録に失敗しました', err));
  }

  K.app = { state, navigate, setMonth, setStore, currentStore, rerender: render, toast };

  document.addEventListener('DOMContentLoaded', start);
})();
