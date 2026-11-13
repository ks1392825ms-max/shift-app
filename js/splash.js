// 起動のアニメーション（11/13〜）：アプリを開いたときに1回だけ、ロゴのマス・SHIFT・RENASCOR. が浮いてきて、画面が上へ抜ける（約2.9秒）
// ・押すとすぐ閉じる。「視差効果を減らす」の設定の人は、ふわっと消えるだけ
// ・名札の色（管理者＝オレンジ・幹部＝赤・スタッフ＝白）は、この端末で前にログインしたときの役割（ログインの前・初めては出さない）
// ・勤怠用 iPad（前に勤怠用でログインした端末）と、自動テスト（navigator.webdriver）では出さない
// 11/13 修正：アプリを読み込んでいる間（スマホでは1秒ほど）は黒い画面のまま止めておき、読み込みが終わってから最初から動かす
//   （止めずに動かすと、読み込み中は画面が描かれないので、前半が飛んで最後だけが見えていた）
// 11/13 修正（2）：簡単ログインのロック画面（PIN）が出たときは、最初の形で止めて隠しておき、解除してから最初から動かす
//   （ロック画面の下で動き続けて、解除したときには最後だけ・または終わっていた）
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
  let held = false; // ロック画面が出ている間
  let ready = false; // 読み込みが終わった
  let safety = null;
  function close() {
    clearTimeout(safety);
    if (!node) return;
    node.remove();
    node = null;
  }

  function build(role) {
    const el = document.createElement('div');
    el.className = 'splash';
    el.setAttribute('aria-hidden', 'true');
    if (role) el.style.setProperty('--splash-accent', role.color);
    const grid = CELLS.map((c, i) => {
      const [k, from] = c.split(':');
      return `<i class="${k === 'D' ? 'is-dark' : ''}" style="--d:${(i % 4) + Math.floor(i / 4)};${from ? `--from:${from}` : ''}"></i>`;
    }).join('');
    const word = [...'SHIFT'].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('');
    el.innerHTML =
      `<div class="splash__mark"><div class="splash__grid">${grid}</div><div class="splash__word">${word}</div>` +
      '<div class="splash__brand">RENASCOR<b>.</b></div>' +
      (role ? `<div class="splash__line"></div><div class="splash__role">${role.label}</div>` : '') +
      '</div>';
    el.addEventListener('pointerdown', close);
    el.addEventListener('animationend', (e) => {
      if (e.target === el && (e.animationName === 'splash-lift' || e.animationName === 'splash-fade')) close();
    });
    return el;
  }

  // 動かす（2回描いてから。止めていた最初の形を、いったん画面に出す）
  function play() {
    if (!node || held || node.classList.contains('is-play')) return;
    const el = node;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (node !== el || held) return;
      el.classList.add('is-play');
      // 念のため（アニメーションが止まる環境でも、画面を隠したままにしない）
      clearTimeout(safety);
      safety = setTimeout(close, 4000);
    }));
  }

  // ロック画面が出た：最初の形に戻して止める（ロック画面の間は、ページのほかの部分と一緒に隠れる）
  function hold() {
    if (!node) return;
    held = true;
    clearTimeout(safety);
    const fresh = build(ROLES[stored('shift-last-role')] || null);
    node.replaceWith(fresh);
    node = fresh;
  }

  // ロック画面が閉じた：解除できたら最初から動かす。できなかった（メールでログインし直す）ときは閉じる
  function release(unlocked) {
    if (!held) return;
    held = false;
    if (!unlocked) return close();
    if (ready) play();
  }

  function show() {
    const last = stored('shift-last-role');
    if (last === 'kiosk') return;
    if (navigator.webdriver && stored('shift-splash-test') !== '1') return;
    node = build(ROLES[last] || null);
    document.body.prepend(node);
    // 読み込みが終わってから動かす（遅い端末でも、最初から最後まで見えるように）
    const start = () => {
      ready = true;
      play();
    };
    const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 700 }) : setTimeout(fn, 120));
    if (document.readyState === 'complete') idle(start);
    else window.addEventListener('load', () => idle(start), { once: true });
    // 読み込みがとても遅いときも、3秒たったら動かす
    setTimeout(start, 3000);
  }

  const K = (window.ShiftApp = window.ShiftApp || {});
  K.splash = { close, hold, release, isOpen: () => Boolean(node), isHeld: () => held };
  show();
})();
