// 起動のアニメーション（11/13〜）：アプリを開いたときに1回だけ、ロゴのマス・SHIFT・RENASCOR. が浮いてきて、画面が上へ抜ける（約2.9秒）
// ・押すとすぐ閉じる。「視差効果を減らす」の設定の人は、ふわっと消えるだけ
// ・名札の色（管理者＝オレンジ・幹部＝赤・スタッフ＝白）は、この端末で前にログインしたときの役割（ログインの前・初めては出さない）
// ・勤怠用 iPad（前に勤怠用でログインした端末）と、自動テスト（navigator.webdriver）では出さない
// データには何も触れない。index.html の <body> のすぐ後で読む（defer なし）
(function () {
  'use strict';
  const ROLES = {
    admin: { color: '#f08c00', label: 'ADMIN' },
    manager: { color: '#e03131', label: 'MANAGER' },
    staff: { color: '#ffffff', label: 'STAFF' },
  };
  // ロゴのマス（4×3）。濃いマスは、となりのマスから「シフト」して入る
  const CELLS = ['L', 'L', 'D:-54px', 'L', 'D:54px', 'L', 'L', 'L', 'L', 'D:-54px', 'L', 'L'];

  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  let node = null;
  function close() {
    if (!node) return;
    node.remove();
    node = null;
  }

  function show() {
    const last = stored('shift-last-role');
    if (last === 'kiosk') return;
    if (navigator.webdriver && stored('shift-splash-test') !== '1') return;
    const role = ROLES[last] || null;
    node = document.createElement('div');
    node.className = 'splash';
    node.setAttribute('aria-hidden', 'true');
    if (role) node.style.setProperty('--splash-accent', role.color);
    const grid = CELLS.map((c, i) => {
      const [k, from] = c.split(':');
      return `<i class="${k === 'D' ? 'is-dark' : ''}" style="--d:${(i % 4) + Math.floor(i / 4)};${from ? `--from:${from}` : ''}"></i>`;
    }).join('');
    const word = [...'SHIFT'].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('');
    node.innerHTML =
      `<div class="splash__mark"><div class="splash__grid">${grid}</div><div class="splash__word">${word}</div>` +
      '<div class="splash__brand">RENASCOR<b>.</b></div>' +
      (role ? `<div class="splash__line"></div><div class="splash__role">${role.label}</div>` : '') +
      '</div>';
    node.addEventListener('pointerdown', close);
    node.addEventListener('animationend', (e) => {
      if (e.target === node && (e.animationName === 'splash-lift' || e.animationName === 'splash-fade')) close();
    });
    document.body.prepend(node);
    // 念のため（アニメーションが止まる環境でも、画面を隠したままにしない）
    setTimeout(close, 4000);
  }

  const K = (window.ShiftApp = window.ShiftApp || {});
  K.splash = { close, isOpen: () => Boolean(node) };
  show();
})();
