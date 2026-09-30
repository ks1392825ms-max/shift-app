// 設定画面（店舗・スタッフ・勤務パターンの切り替え）
// それぞれの中身は settings-stores.js / settings-staff.js / settings-patterns.js にある
(function () {
  'use strict';
  const K = window.ShiftApp;
  const el = K.utils.el;

  const TABS = [
    ['stores', '店舗'],
    ['staff', 'スタッフ'],
    ['patterns', '勤務パターン'],
    ['business', '毎週の社用'],
    ['staffing', '必要人数'],
    ['checks', 'チェック'],
    ['data', 'データ'],
  ];

  let tab = 'stores';

  function render(container) {
    const tabBar = el(
      'div',
      { class: 'segment segment--tabs', role: 'tablist', 'aria-label': '設定の種類' },
      TABS.map(([key, label]) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `segment__btn${tab === key ? ' is-selected' : ''}`,
            'aria-selected': String(tab === key),
            onclick: () => {
              if (tab === key) return;
              tab = key;
              K.app.rerender();
            },
          },
          label
        )
      )
    );

    const body = el('div', { class: 'settings-body', role: 'tabpanel' });
    container.append(tabBar, body);
    K.settingsViews[tab].render(body);
    // 選んでいるタブが見えるように横スクロールする
    const selected = tabBar.querySelector('.is-selected');
    if (selected) tabBar.scrollLeft = selected.offsetLeft - 16;
  }

  K.screens = K.screens || {};
  K.screens.settings = { render };
})();
