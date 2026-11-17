// シフト表を画面に合わせて小さく表示し、2本指で広げる（11/16〜 幹部の確定シフト・管理者のシフト表で共通）
// ・月全体を1画面（all）：表全体を、横幅と画面の高さの両方に収める。横幅に合わせる（width）：横幅だけ収め、縦は画面をスクロール
// ・2本指で広げる・縮める：スマホは指2本、パソコンはトラックパッド（ctrl つきのホイールで届く）。指のあいだの場所を中心に広げる
//   広げても、画面全体は拡大しない（表の枠の中だけが大きくなる）。画面に合わせた大きさより小さくはしない
// ・縮め方：0.75 倍より小さいときは transform（絵として縮める）。Safari は CSS の zoom で縮めると、文字を 9px より小さくしないので、
//   月全体が1画面に収まらない。0.75 倍からは CSS の zoom にして、上の名前・左の日付・右の人数を固定（sticky）にする
// データには何も触れない（見え方だけ）
(function () {
  'use strict';
  const K = (window.ShiftApp = window.ShiftApp || {});
  const SCALE_BELOW = 0.75;
  const MAX = 2.5;

  function applyScale(table, wrap, z) {
    const scaled = z < SCALE_BELOW;
    table.style.zoom = scaled ? '' : z;
    table.style.transform = scaled ? `scale(${z})` : '';
    // transform は見た目だけが縮むので、外側の場所（レイアウト）も、縮めた大きさにそろえる
    table.style.marginRight = scaled ? `${-table.offsetWidth * (1 - z)}px` : '';
    table.style.marginBottom = scaled ? `${-table.offsetHeight * (1 - z)}px` : '';
    wrap.classList.toggle('is-scaled', scaled);
  }

  // wrap：表の枠（overflow のある要素）。state：{ mode: 'all'|'width', zoom: null|倍率, fitZoom }（画面の作り直しのあとも残す）
  // opts.bar：下のタブ（その高さだけ、使える高さから引く）。opts.reset：「全体に戻す」のボタン
  function fit(wrap, state, opts = {}) {
    if (!wrap || !wrap.isConnected) return;
    const table = wrap.querySelector('table');
    if (!table) return;
    wrap.classList.add('is-fit');
    wrap.style.height = '';
    table.style.minWidth = '';
    applyScale(table, wrap, 1);
    const aw = wrap.clientWidth;
    const bar = opts.bar && opts.bar();
    const ah = Math.max(240, window.innerHeight - (wrap.getBoundingClientRect().top + window.scrollY) - (bar ? bar.offsetHeight : 0) - 14);
    const all = state.mode !== 'width';
    let fitZoom = Math.min(1, aw / table.offsetWidth, all ? ah / table.offsetHeight : 1);
    // 縮めた表を、枠の横幅いっぱいに広げる（高さで決まったときも、横は枠いっぱい）。広げると高さが少し変わることがあるので、もう一度合わせる
    table.style.minWidth = `${Math.floor(aw / fitZoom)}px`;
    if (all) fitZoom = Math.min(fitZoom, ah / table.offsetHeight);
    state.fitZoom = fitZoom;
    if (state.zoom && state.zoom <= fitZoom + 0.001) state.zoom = null;
    const z = state.zoom || fitZoom;
    const zoomed = z > fitZoom + 0.001;
    const fitHeight = Math.ceil(table.offsetHeight * fitZoom) + 2;
    applyScale(table, wrap, z);
    wrap.classList.toggle('is-zoomed', zoomed);
    // 月全体：枠の大きさは変えず、広げた表を枠の中で動かす。横幅：広げたら画面の高さの枠にする
    wrap.style.height = all ? `${fitHeight}px` : zoomed ? `${ah}px` : '';
    const reset = opts.reset && opts.reset();
    if (reset) reset.hidden = !zoomed;
    if (!wrap.dataset.pinch) listen(wrap, state, opts);
  }

  function listen(wrap, state, opts) {
    wrap.dataset.pinch = '1';
    const now = () => state.zoom || state.fitZoom || 1;
    const zoomAt = (next, cx, cy) => {
      const old = now();
      const z = Math.max(state.fitZoom, Math.min(MAX, next));
      const r = wrap.getBoundingClientRect();
      const ux = (wrap.scrollLeft + cx - r.left) / old;
      const uy = (wrap.scrollTop + cy - r.top) / old;
      state.zoom = z <= state.fitZoom + 0.001 ? null : z;
      fit(wrap, state, opts);
      wrap.scrollLeft = ux * z - (cx - r.left);
      wrap.scrollTop = uy * z - (cy - r.top);
    };
    wrap.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        zoomAt(now() * Math.exp(-e.deltaY * 0.004), e.clientX, e.clientY);
      },
      { passive: false }
    );
    let pinch = null;
    const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    wrap.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: dist(e), z: now() }; }, { passive: true });
    wrap.addEventListener(
      'touchmove',
      (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        zoomAt(pinch.z * (dist(e) / pinch.d), (e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
      },
      { passive: false }
    );
    wrap.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
  }

  K.fitTable = { fit };
})();
