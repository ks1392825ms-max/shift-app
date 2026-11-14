// スマホの打刻（GPS・11/14〜）：スタッフ本人の画面のいちばん上の「打刻」のカード
// ・押したときに、スマホの位置を1回だけ取る（ずっと追いかけない）。お店の位置（storeGeo）からの距離で、範囲内かを決める
// ・範囲内 →「出勤しますか？」→ はい で打刻。範囲の外・位置が取れない → 理由を選んで「例外の打刻」として送る（管理者か担当の幹部が認める）
// ・保存するのは「範囲内か・お店からの距離・位置のずれ」だけ（細かい緯度・経度は残さない）
// ・今日と前の日の自分の打刻は、受け取り続ける（お店の iPad で打った分も、すぐ「今の状態」に出る）
// ・休憩中の退勤は、退勤の時刻で休憩も終わり（ユーザー A）
(function () {
  'use strict';

  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const A = () => K.attendance;

  // スタッフごとの状態：{ staffId, storeId, geo（お店の位置）, geoLoaded, punches, checks, stop, busy, sheet, msg, error }
  let st = null;

  // スタッフ・幹部の画面は、共有のデータ（storage）にはつながないので、ログインの部品（cloudBackend）を直接使う
  function backend() {
    return (K.app.cloudBackend && K.app.cloudBackend()) || null;
  }

  function reset(member) {
    if (st && st.stop) st.stop();
    st = { staffId: member.id, storeId: member.storeId, geo: null, geoLoaded: false, punches: [], checks: [], stop: null, busy: false, sheet: null, msg: null, error: '', watchDates: '' };
    const b = backend();
    b.loadStoreGeo(member.storeId)
      .then((g) => {
        st.geo = g;
        st.geoLoaded = true;
        K.app.rerender();
      })
      .catch((err) => {
        st.geoLoaded = true;
        st.error = `お店の位置を読み込めませんでした（${err.message}）`;
        K.app.rerender();
      });
    watch();
  }

  // 今日と前の日の分を受け取り続ける（日付が変わったら付け直す）
  function watch() {
    const today = A().nowJst().date;
    const dates = [A().addDays(today, -1), today];
    if (st.watchDates === dates.join() && st.stop) return;
    if (st.stop) st.stop();
    st.watchDates = dates.join();
    const mine = st;
    backend()
      .watchMyPunches(
        st.staffId,
        dates,
        (data) => {
          if (st !== mine) return;
          mine.punches = data.punches;
          mine.checks = data.checks;
          K.app.rerender();
        },
        (err) => {
          if (st !== mine) return;
          mine.error = `打刻を読み込めませんでした（${err.message}）`;
          K.app.rerender();
        }
      )
      .then((stop) => {
        if (st === mine) mine.stop = stop;
        else stop();
      })
      .catch((err) => {
        mine.error = `打刻を読み込めませんでした（${err.message}）`;
        K.app.rerender();
      });
  }

  // 今の打刻（0時〜5時は、前の日に出勤したままの分を続ける）
  function current() {
    return A().currentPunches(st.punches, A().nowJst().date).filter((p) => p.staffId === st.staffId);
  }

  // スマホの位置を1回だけ取る（取れないときは null）
  function locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  async function press(type) {
    if (st.busy) return;
    st.busy = true;
    st.msg = null;
    st.locating = true;
    K.app.rerender();
    const pos = await locate();
    st.locating = false;
    st.busy = false;
    const geo = A().judgeGeo(st.geo, pos);
    st.sheet = { type, geo, at: A().now(), reason: geo.dist == null ? 'nogps' : '', note: '' };
    K.app.rerender();
  }

  async function send() {
    const s = st.sheet;
    if (!s || st.busy) return;
    st.busy = true;
    K.app.rerender();
    try {
      const user = K.app.cloudUser && K.app.cloudUser();
      const p = await A().punchPhone({ staffId: st.staffId, storeId: st.storeId, type: s.type, email: user && user.email, current: current(), geo: s.geo, reason: s.reason, note: s.note });
      st.msg = { ok: true, text: `${A().TYPES[s.type]}しました（${A().timeOf(p.at)}）${s.geo.ok ? '' : '。管理者か幹部が確認するまで「確認待ち」です'}` };
      st.sheet = null;
    } catch (err) {
      st.msg = { ok: false, text: err.message };
      st.sheet = null;
    }
    st.busy = false;
    K.app.rerender();
  }

  function sheet() {
    const s = st.sheet;
    const close = () => {
      st.sheet = null;
      K.app.rerender();
    };
    const label = A().TYPES[s.type];
    const time = A().timeOf(s.at.toISOString ? s.at.toISOString() : s.at);
    const where = s.geo.ok
      ? el('p', { class: 'pp-loc is-ok' }, el('i', { 'aria-hidden': 'true' }), `お店の範囲内（${s.geo.dist}m）`)
      : el('p', { class: 'pp-loc is-ng' }, el('i', { 'aria-hidden': 'true' }), s.geo.dist == null ? '位置が取れませんでした' : `お店から約 ${s.geo.dist}m（範囲は ${st.geo.radius}m）`);
    let body;
    if (s.geo.ok) {
      body = [
        el('h3', { class: 'pp-sheet__title', id: 'pp-sheet-title' }, `${label}しますか？`),
        el('p', { class: 'pp-sheet__time' }, time),
        where,
        el(
          'div',
          { class: 'pp-sheet__btns' },
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, 'いいえ'),
          el('button', { type: 'button', class: 'btn btn--primary', disabled: st.busy, onclick: send }, st.busy ? '送っています…' : 'はい')
        ),
      ];
    } else {
      const note = el('input', { id: 'pp-note', class: 'field__input', type: 'text', maxlength: '100', value: s.note, placeholder: '例：講習会場から、そのまま帰宅', oninput: (ev) => (s.note = ev.currentTarget.value) });
      body = [
        el('h3', { class: 'pp-sheet__title', id: 'pp-sheet-title' }, s.geo.dist == null ? '位置が取れませんでした' : 'お店の範囲の外です'),
        where,
        el('p', { class: 'pp-sheet__note' }, `このまま${label}するときは、理由を選んで「例外の打刻」として送ります。管理者か担当の幹部が確認します。`),
        el('p', { class: 'pp-sheet__label' }, '理由'),
        el(
          'div',
          { class: 'pp-reasons', role: 'group', 'aria-label': '理由' },
          Object.entries(A().REASONS).map(([k, t]) =>
            el('button', { type: 'button', class: `pp-reason${s.reason === k ? ' is-on' : ''}`, 'aria-pressed': String(s.reason === k), onclick: () => { s.reason = k; K.app.rerender(); } }, t)
          )
        ),
        el('label', { class: 'pp-sheet__label', for: 'pp-note' }, 'くわしく（任意・100文字まで）'),
        note,
        el(
          'div',
          { class: 'pp-sheet__btns' },
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, 'やめる'),
          el('button', { type: 'button', class: 'btn btn--primary', disabled: st.busy || !s.reason, onclick: send }, st.busy ? '送っています…' : `${label}を送る`)
        ),
      ];
    }
    return el('div', { class: 'pp-layer' }, el('div', { class: 'pp-dim', onclick: close }), el('div', { class: 'pp-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pp-sheet-title' }, body));
  }

  // 打刻のカード。member：スタッフの記録（{ id, storeId, name }）。plan：今日の予定（あれば）
  function card(member, { plan } = {}) {
    const b = backend();
    if (!member || !b || !b.watchMyPunches || !b.loadStoreGeo) return null;
    if (!st || st.staffId !== member.id || st.storeId !== member.storeId) reset(member);
    else watch();
    const mine = current();
    const state = A().stateOf(mine);
    const next = A().NEXT[state];
    const last = mine.slice().sort((x, y) => String(x.at).localeCompare(String(y.at))).pop();
    const pending = A().pendingExceptions(st.punches, st.checks).filter((p) => p.staffId === st.staffId);
    // お店の位置が決まっていない店舗（と、読み込み中）は、カードを出さない（お店のタブレットで打刻。カレンダーを上に保つため）
    if (!st.geoLoaded || !st.geo) return st.error ? el('p', { class: 'pp-msg is-error', role: 'alert' }, st.error) : null;
    // 今押せるボタンだけを、1行に（出勤前：出勤／出勤中：休憩開始・退勤／休憩中：休憩戻り・退勤）
    const order = ['in', 'bs', 'be', 'out'].filter((t) => next.includes(t));
    return el(
      'section',
      { class: 'card pp-card' },
      el(
        'div',
        { class: 'pp-head' },
        el('h2', { class: 'card__title' }, '打刻'),
        el('span', { class: `pp-badge is-${state}` }, A().STATE_LABELS[state]),
        last ? el('span', { class: 'pp-last' }, `${A().TYPES[last.type]} ${A().timeOf(last.at)}（${last.source === 'phone' ? 'スマホ' : 'タブレット'}）`) : null
      ),
      plan ? el('p', { class: 'pp-plan' }, `今日の予定 ${plan}`) : null,
      st.error ? el('p', { class: 'pp-msg is-error', role: 'alert' }, st.error) : null,
      order.length
        ? el(
            'div',
            { class: `pp-btns is-${order.length}` },
            order.map((t) => el('button', { type: 'button', class: `btn ${t === 'in' || t === 'be' ? 'btn--primary' : t === 'out' ? 'btn--primary' : 'btn--ghost'} pp-btn pp-btn--${t}`, disabled: st.busy, onclick: () => press(t) }, A().TYPES[t]))
          )
        : el('p', { class: 'pp-note' }, '今日は退勤しました。おつかれさまでした。'),
      st.locating ? el('p', { class: 'pp-note', role: 'status' }, '位置を確かめています…') : null,
      st.msg ? el('p', { class: `pp-msg${st.msg.ok ? '' : ' is-error'}`, role: 'status' }, st.msg.text) : null,
      pending.length ? el('p', { class: 'pp-note' }, `確認待ちの打刻が ${pending.length}件あります（管理者か幹部が確認します）。`) : null,
      st.sheet ? sheet() : null
    );
  }

  // ログアウトなどで止める
  function stop() {
    if (st && st.stop) st.stop();
    st = null;
  }

  K.phonePunch = { card, stop };
})();
