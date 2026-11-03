// 2本指の拡大・縮小（ピンチ）：ブラウザの拡大をそのまま使う（viewport で禁止しない）。
// 拡大しているあいだだけ、画面の右下に「元の大きさに戻す」ボタンを出す。
// ボタンは拡大に合わせて位置と大きさを直すので、いつも画面の右下に同じ大きさで見える。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const SHOW_FROM = 1.05; // これより大きく拡大したらボタンを出す
  let button = null;

  function scale() {
    return window.visualViewport ? window.visualViewport.scale : 1;
  }

  // 拡大を元に戻す：viewport の設定を一時的に変えて、すぐ元の設定に戻す
  // 1) 最初の倍率（initial-scale）を少しだけ変えて戻す（Chrome・Android はこれで等倍に戻り、そのあとも拡大できる）
  // 2) それでも戻らなかったときだけ、最大倍率（maximum-scale）を一時的に 1 にして戻す（iPhone の Safari 向け）
  //    Chrome でこれをすると、しばらく拡大できなくなるので、1) で戻ったときはしない
  function reset() {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.getAttribute('content');
    const nudged = /initial-scale=/.test(original) ? original.replace(/initial-scale=[\d.]+/, 'initial-scale=1.0001') : `${original}, initial-scale=1.0001`;
    meta.setAttribute('content', nudged);
    setTimeout(() => {
      meta.setAttribute('content', original);
      if (scale() <= SHOW_FROM) {
        update();
        return;
      }
      meta.setAttribute('content', `${original}, maximum-scale=1`);
      setTimeout(() => {
        meta.setAttribute('content', original);
        update();
      }, 300);
    }, 150);
  }

  function update() {
    const vv = window.visualViewport;
    if (!vv || !button) return;
    const zoomed = vv.scale > SHOW_FROM;
    button.hidden = !zoomed;
    if (!zoomed) return;
    // 見えている部分（visualViewport）の右下に置き、拡大の分だけ小さくして同じ大きさに見せる
    // （position: fixed の基準はレイアウトの画面。visualViewport の offsetLeft/offsetTop も同じ基準）
    const s = 1 / vv.scale;
    button.style.left = `${vv.offsetLeft + vv.width - 12 * s}px`;
    button.style.top = `${vv.offsetTop + vv.height - 12 * s}px`;
    button.style.transform = `translate(-100%, -100%) scale(${s})`;
  }

  function start() {
    if (!window.visualViewport) return;
    button = U.el('button', { type: 'button', class: 'zoom-reset', hidden: true, onclick: reset }, '元の大きさに戻す');
    document.body.append(button);
    window.visualViewport.addEventListener('resize', update);
    window.visualViewport.addEventListener('scroll', update);
    update();
  }

  K.zoom = { reset, scale, update };
  document.addEventListener('DOMContentLoaded', start);
})();
