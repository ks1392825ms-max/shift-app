// 起動のアニメーション（11/13〜・11/15 作り直し）
// ・アプリを開いたときには出さない。簡単ログイン（パスコード・顔認証）で解除した直後にだけ流す（quick-lock.js から play を呼ぶ）
//   流すのは、アプリを開いて最初に解除したときの1回だけ（別のアプリから戻ったときの解除では流さない）
//   （11/15 まで：開いた瞬間に黒い画面を出していたので、ログインの確認に時間がかかると、ロックの前に流れてしまっていた）
// ・約4.7秒：ロゴのマスが浮かぶ → 灰色のマスが横から入る → SHIFT・RENASCOR. → 2.5秒から、マスは真ん中から360度に散り、
//   文字はふわっと消え、黒い画面は2.2秒かけて透明になる（全画面のぼかしは iPhone でカクつくので使わない）
// ・色は全員同じ（管理者・幹部・スタッフで分けない）。押すとすぐ閉じる
// ・勤怠用 iPad（前に勤怠用でログインした端末）と、自動テスト（navigator.webdriver）では出さない。「視差効果を減らす」の人は、動かさずに消すだけ
// データには何も触れない
(function () {
  'use strict';
  // ロゴのマス（4×3）。濃いマスは、となりのマスから「シフト」して入る
  const CELLS = ['L', 'L', 'D:-47px', 'L', 'D:47px', 'L', 'L', 'L', 'L', 'D:-47px', 'L', 'L'];

  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  let node = null;
  let safety = null;
  let played = false; // アプリを開いてから、もう流したか（別のアプリから戻ったときの解除では、もう流さない）
  function close() {
    clearTimeout(safety);
    if (!node) return;
    node.remove();
    node = null;
  }

  // マスが散る先：12個を、ロゴの真ん中から見た向きの順に並べ、円周に30度ずつ割り当てる（毎回少しばらつかせる）
  function flyVars() {
    const angleOf = (i) => Math.atan2((Math.floor(i / 4) - 1) * 1.6 + ((i % 4) - 1.5) * 0.01, (i % 4) - 1.5);
    const order = CELLS.map((_, i) => i).sort((a, b) => angleOf(a) - angleOf(b));
    const step = (Math.PI * 2) / CELLS.length;
    const spin = Math.random() * step;
    return CELLS.map((_, i) => {
      const x = (i % 4) - 1.5;
      const y = Math.floor(i / 4) - 1;
      const ang = -Math.PI + order.indexOf(i) * step + spin + (Math.random() - 0.5) * 0.25;
      const dist = 320 + Math.random() * 160;
      return {
        fx: Math.round(Math.cos(ang) * dist),
        fy: Math.round(Math.sin(ang) * dist),
        fr: Math.round((Math.random() - 0.5) * 160),
        fo: Math.round(Math.hypot(x, y) * -40 + Math.random() * 60),
      };
    });
  }

  function build() {
    const el = document.createElement('div');
    el.className = 'splash';
    el.setAttribute('aria-hidden', 'true');
    const fly = flyVars();
    const grid = CELLS.map((c, i) => {
      const [k, from] = c.split(':');
      const f = fly[i];
      return `<i class="${k === 'D' ? 'is-dark' : ''}" style="--d:${(i % 4) + Math.floor(i / 4)};${from ? `--from:${from};` : ''}--fx:${f.fx}px;--fy:${f.fy}px;--fr:${f.fr}deg;--fo:${f.fo}ms"></i>`;
    }).join('');
    const word = [...'SHIFT'].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('');
    el.innerHTML =
      `<div class="splash__mark"><div class="splash__grid">${grid}</div><div class="splash__word">${word}</div>` +
      '<div class="splash__brand">RENASCOR<b>.</b></div></div>';
    el.addEventListener('pointerdown', close);
    el.addEventListener('animationend', (e) => {
      if (e.target === el && (e.animationName === 'splash-out' || e.animationName === 'splash-fade')) close();
    });
    return el;
  }

  // 解除した直後に呼ぶ（quick-lock.js）
  function play() {
    if (stored('shift-last-role') === 'kiosk') return;
    if (navigator.webdriver && stored('shift-splash-test') !== '1') return;
    if (played) return;
    played = true;
    close();
    node = build();
    document.body.prepend(node);
    // 念のため（アニメーションが止まる環境でも、画面を隠したままにしない）
    safety = setTimeout(close, 6500);
  }

  const K = (window.ShiftApp = window.ShiftApp || {});
  K.splash = { play, close, isOpen: () => Boolean(node) };
})();
