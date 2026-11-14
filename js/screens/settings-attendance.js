// 設定 > 勤怠（11/9〜。共有モードの管理者だけ）
// ・勤怠用 iPad のアカウント（店舗ごと）を登録・解除する（kiosks/{メール}）
// ・集計表のパスワードを決める（settings/attendance。元に戻せない形だけを保存）
// ・スタッフの勤怠の番号（PIN）：決めたかどうかを見る・管理者が決める・消す（決め直してもらう）
// ・11/14〜 スマホの打刻（GPS）：店舗ごとに、お店の位置（お店の中で「今いる場所」）と範囲（20・50・100・200m）を決める（storeGeo/{店舗}）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const A = () => K.attendance;

  let st = null;

  function backend() {
    return A().backend();
  }

  function email() {
    const u = K.app.cloudUser();
    return String((u && u.email) || '').toLowerCase();
  }

  async function load() {
    st = { loading: true, kiosks: [], pins: [], settings: {}, msg: null, geos: [], radius: {}, check: {} };
    try {
      const [kiosks, pins, settings, geos] = await Promise.all([
        backend().loadKiosks(),
        backend().loadPinStatus(),
        backend().loadAttendanceSettings(),
        backend().loadStoreGeos ? backend().loadStoreGeos() : Promise.resolve([]),
      ]);
      Object.assign(st, { kiosks, pins, settings: settings || {}, geos: geos || [], loading: false });
    } catch (err) {
      Object.assign(st, { loading: false, msg: { ok: false, text: `読み込めませんでした（${err.message}）` } });
    }
    K.app.rerender();
  }

  function say(ok, text) {
    st.msg = { ok, text };
    K.app.rerender();
  }

  function kioskCard() {
    const stores = K.storage.getStores();
    return el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card__title' }, '勤怠用 iPad（店舗ごと）'),
      el('p', { class: 'hint hint--left' }, '店舗の入口に置く iPad 用のアカウントです。ここで登録したメールアドレスでログインした端末は、その店舗の打刻の画面だけになります（シフト表や設定は開けません）。'),
      el('p', { class: 'hint hint--left' }, 'メールアドレスは、いつもの Gmail に「+店舗名」をつけた形（例：あなたのアドレスが abc@gmail.com なら abc+honten@gmail.com）にすると、新しいアドレスを作らずに、いつもの受信箱でパスワード設定のメールを受け取れます。'),
      stores.map((s) => {
        const list = st.kiosks.filter((k) => k.storeId === s.id && !k.deleted);
        const input = el('input', { type: 'email', class: 'field__input', id: `kiosk-email-${s.id}`, placeholder: '例：abc+honten@gmail.com', autocomplete: 'off' });
        return el(
          'div',
          { class: 'att-set-store' },
          el('p', { class: 'att-set-store__name' }, s.name),
          list.length
            ? el(
                'ul',
                { class: 'att-set-list' },
                list.map((k) =>
                  el(
                    'li',
                    null,
                    el('span', null, k.email),
                    el(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn--ghost btn--small',
                        onclick: async () => {
                          if (!confirm(`${k.email} の登録を解除しますか？（その iPad では打刻できなくなります）`)) return;
                          try {
                            await backend().saveKiosk(k.email, { storeId: k.storeId, deleted: true, createdAt: k.createdAt || new Date().toISOString(), createdBy: email() });
                            k.deleted = true;
                            say(true, `${k.email} の登録を解除しました。`);
                          } catch (err) {
                            say(false, `解除できませんでした（${err.message}）`);
                          }
                        },
                      },
                      '解除'
                    )
                  )
                )
              )
            : el('p', { class: 'hint hint--left' }, 'まだ登録していません。'),
          el(
            'div',
            { class: 'att-set-row' },
            input,
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn--primary',
                onclick: async () => {
                  const v = input.value.trim().toLowerCase();
                  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return say(false, 'メールアドレスの形が正しくありません。');
                  const staffMail = K.storage.getStaff({ includeInactive: true }).some((m) => String(m.email || '').toLowerCase() === v);
                  if (v === email() || staffMail) return say(false, 'スタッフ・管理者のログインのメールとは別のアドレスにしてください。');
                  try {
                    await backend().saveKiosk(v, { storeId: s.id, deleted: false, createdAt: new Date().toISOString(), createdBy: email() });
                    await K.attendanceView.syncDirectories();
                    st.kiosks = st.kiosks.filter((k) => k.email !== v).concat({ email: v, storeId: s.id, deleted: false });
                    say(true, `${s.name}の勤怠用 iPad として ${v} を登録しました。iPad で、ログイン画面の「初めての方・パスワードを忘れた方」からパスワードを決めて、ログインしてください。`);
                  } catch (err) {
                    say(false, `登録できませんでした（${err.message}）`);
                  }
                },
              },
              '登録'
            )
          )
        );
      }),
      el(
        'details',
        { class: 'att-howto' },
        el('summary', null, 'iPad の準備のしかた（最初に1回）'),
        el(
          'ol',
          null,
          el('li', null, 'iPad の Safari で SHIFT のログインページを開き、「初めての方・パスワードを忘れた方」から、登録したメールアドレスでパスワードを決める'),
          el('li', null, 'そのメールアドレスとパスワードでログインする（その店舗の打刻の画面になります）'),
          el('li', null, 'Safari の共有ボタン →「ホーム画面に追加」'),
          el('li', null, 'iPad の 設定 › アクセシビリティ › アクセスガイド をオン。SHIFT を開いてサイドボタン（ホームボタン）を3回押す →「開始」。ほかの画面に移れなくなります'),
          el('li', null, '設定 › 画面表示と明るさ › 自動ロック を「なし」にして、電源につないでおく')
        ),
        el('p', { class: 'hint hint--left' }, '打刻の画面を閉じるときは、右下の「管理者」を押して、この iPad のアカウントのパスワードを入れます。')
      )
    );
  }

  function summaryCard() {
    const a = el('input', { type: 'password', class: 'field__input', id: 'sum-pass', autocomplete: 'new-password', placeholder: '新しいパスワード（4文字以上）' });
    const b = el('input', { type: 'password', class: 'field__input', id: 'sum-pass2', autocomplete: 'new-password', placeholder: 'もう一度' });
    return el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card__title' }, '集計表のパスワード'),
      el('p', { class: 'hint hint--left' }, `${st.settings.summaryHash ? '決まっています。' : 'まだ決まっていません。'}管理者と幹部は、このパスワードを入れると勤怠の集計表（PDF・Excel の出力）を開けます。幹部に伝えるときは、口頭など、ほかの人に見られない方法で。`),
      el('div', { class: 'att-set-row' }, a, b),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--primary',
          onclick: async () => {
            if (a.value !== b.value) return say(false, '2回入れたパスワードが違います。');
            try {
              await A().setSummaryPassword(a.value, { email: email() });
              st.settings = await backend().loadAttendanceSettings();
              A().lockSummary();
              say(true, '集計表のパスワードを決めました。');
            } catch (err) {
              say(false, err.message);
            }
          },
        },
        st.settings.summaryHash ? 'パスワードを変える' : 'パスワードを決める'
      ),
      el('p', { class: 'hint hint--left' }, `毎月最終日の ${A().CLOSE_HOUR}:00 に、その月の勤怠を締めます。締めたあとは、幹部は見るだけ（直せるのは管理者）。管理者と幹部の画面に「集計表ができました」と出ます。`)
    );
  }

  function pinCard() {
    const has = new Map(st.pins.map((p) => [p.staffId, p]));
    return el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card__title' }, '勤怠の番号（PIN）'),
      el('p', { class: 'hint hint--left' }, 'スタッフは、自分のスマホの SHIFT（アカウント・この端末の設定）で4けたの番号を決めます。忘れた人は「消す」で消してから、本人に決め直してもらうか、ここで決めます。番号そのものは保存していないので、ここでも見られません。'),
      K.storage.getStores().map((s) =>
        el(
          'div',
          { class: 'att-set-store' },
          el('p', { class: 'att-set-store__name' }, s.name),
          el(
            'ul',
            { class: 'att-set-list' },
            K.storage.getStaff({ storeId: s.id }).map((m) =>
              el(
                'li',
                null,
                el('span', null, m.name),
                el('span', { class: `att-pin-state${has.has(m.id) ? ' is-set' : ''}` }, has.has(m.id) ? '✓ 決めた' : '未設定'),
                el(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn--ghost btn--small',
                    onclick: async () => {
                      const v = prompt(`${m.name} の勤怠の番号（4けたの数字）`);
                      if (v === null) return;
                      try {
                        await A().setPin(m.id, v.trim(), { email: email() });
                        st.pins = st.pins.filter((p) => p.staffId !== m.id).concat({ staffId: m.id });
                        say(true, `${m.name} の番号を決めました。本人に伝えてください。`);
                      } catch (err) {
                        say(false, err.message);
                      }
                    },
                  },
                  '決める'
                ),
                has.has(m.id)
                  ? el(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn--ghost btn--small',
                        onclick: async () => {
                          if (!confirm(`${m.name} の番号を消しますか？（消すと、決め直すまで打刻できません）`)) return;
                          try {
                            await backend().deleteAttendancePin(m.id);
                            st.pins = st.pins.filter((p) => p.staffId !== m.id);
                            say(true, `${m.name} の番号を消しました。`);
                          } catch (err) {
                            say(false, `消せませんでした（${err.message}）`);
                          }
                        },
                      },
                      '消す'
                    )
                  : null
              )
            )
          )
        )
      )
    );
  }

  // ---- スマホの打刻（GPS・11/14〜）：お店の位置と範囲 ----
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

  async function saveGeo(storeId, base, radius) {
    const data = { storeId, lat: base.lat, lng: base.lng, radius, acc: Number.isFinite(base.acc) ? Math.round(base.acc) : null, setAt: A().now().toISOString(), setBy: email() };
    await backend().saveStoreGeo(storeId, data);
    st.geos = st.geos.filter((g) => g.storeId !== storeId).concat([data]);
    return data;
  }

  async function setHere(store) {
    st.check[store.id] = { busy: true };
    K.app.rerender();
    const pos = await locate();
    st.check[store.id] = null;
    if (!pos) return say(false, '位置が取れませんでした。スマホの設定で、位置情報（Safari・ブラウザ）を許可してから、もう一度押してください。');
    const radius = st.radius[store.id] || (geoOf(store.id) || {}).radius || 50;
    if (!window.confirm(`今いる場所を「${store.name}」の位置にしますか？\n位置のずれ：±${Math.round(pos.acc)}m　範囲：${radius}m\n（お店の中で押してください）`)) return K.app.rerender();
    try {
      await saveGeo(store.id, pos, radius);
      say(true, `「${store.name}」の位置を決めました（ずれ ±${Math.round(pos.acc)}m・範囲 ${radius}m）。`);
    } catch (err) {
      say(false, `保存できませんでした（${err.message}）`);
    }
  }

  async function setRadius(store, radius) {
    st.radius[store.id] = radius;
    const g = geoOf(store.id);
    if (!g) return K.app.rerender();
    try {
      await saveGeo(store.id, g, radius);
      say(true, `「${store.name}」の範囲を ${radius}m にしました。`);
    } catch (err) {
      say(false, `保存できませんでした（${err.message}）`);
    }
  }

  async function checkHere(store) {
    st.check[store.id] = { busy: true };
    K.app.rerender();
    const pos = await locate();
    const g = geoOf(store.id);
    st.check[store.id] = pos ? { acc: Math.round(pos.acc), dist: g ? A().distanceM(g, pos) : null } : { none: true };
    K.app.rerender();
  }

  function geoOf(storeId) {
    return st.geos.find((g) => g.storeId === storeId) || null;
  }

  function geoCard() {
    if (!backend().saveStoreGeo) return null;
    const stores = K.storage.getStores();
    const stamp = (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${A().timeOf(iso)}`;
    };
    return el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card__title' }, 'スマホの打刻（GPS）'),
      el('p', { class: 'hint hint--left' }, '店舗ごとに、お店の位置と範囲を決めます。お店の中で「今いる場所をお店の位置にする」を押してください（地図のサービスは使いません）。位置が決まった店舗のスタッフは、スマホからも打刻できます。'),
      stores.map((s) => {
        const g = geoOf(s.id);
        const radius = st.radius[s.id] || (g && g.radius) || 50;
        const c = st.check[s.id];
        return el(
          'div',
          { class: 'att-set-store att-geo' },
          el('p', { class: 'att-set-store__name' }, s.name, el('span', { class: `att-geo__tag${g ? ' is-ok' : ''}` }, g ? '決めた' : 'まだ')),
          g ? el('p', { class: 'hint hint--left' }, `位置：${stamp(g.setAt)} に決めた${g.acc != null ? `（そのときのずれ ±${g.acc}m）` : ''}　範囲：${g.radius}m`) : el('p', { class: 'hint hint--left' }, 'お店の中で、下のボタンを押してください。'),
          el(
            'div',
            { class: 'segment att-geo__radius', role: 'group', 'aria-label': `${s.name}の範囲` },
            A().RADII.map((r) => el('button', { type: 'button', class: `segment__btn${radius === r ? ' is-selected' : ''}`, 'aria-pressed': String(radius === r), onclick: () => setRadius(s, r) }, `${r}m`))
          ),
          c && !c.busy
            ? el('p', { class: `att-geo__check${c.none ? ' is-ng' : ''}`, role: 'status' }, c.none ? '位置が取れませんでした。' : `今の位置のずれ：±${c.acc}m${c.dist != null ? `　お店から ${c.dist}m（${c.dist <= radius ? '範囲内' : '範囲の外'}）` : ''}`)
            : null,
          el(
            'div',
            { class: 'actions actions--tight' },
            el('button', { type: 'button', class: `btn ${g ? 'btn--ghost' : 'btn--primary'} btn--small`, disabled: Boolean(c && c.busy), onclick: () => setHere(s) }, c && c.busy ? '位置を確かめています…' : '今いる場所をお店の位置にする'),
            el('button', { type: 'button', class: 'btn btn--ghost btn--small', disabled: Boolean(c && c.busy), onclick: () => checkHere(s) }, '今の位置のずれを確かめる')
          )
        );
      }),
      el('p', { class: 'hint hint--left' }, '建物の中ではスマホの位置が 10〜50m ずれることがあります。20m で「範囲の外」が多いときは 50m に変えてください（いつでも変えられます）。位置は、打刻のときに1回だけ確かめます。保存するのは「範囲内か」「お店からの距離」「ずれ」だけです。')
    );
  }

  function render(container) {
    if (!K.storage.isCloud() || !A() || !backend()) {
      container.append(el('section', { class: 'card' }, el('h2', { class: 'card__title' }, '勤怠'), el('p', { class: 'hint hint--left' }, '勤怠は共有モード（ログインして使うとき）で使えます。')));
      return;
    }
    if (!st) {
      load();
      container.append(el('p', { class: 'hint' }, '読み込んでいます…'));
      return;
    }
    if (st.loading) {
      container.append(el('p', { class: 'hint' }, '読み込んでいます…'));
      return;
    }
    container.append(
      st.msg ? el('p', { class: st.msg.ok ? 'sync__result' : 'form-error', role: 'status' }, st.msg.text) : '',
      kioskCard(),
      geoCard(),
      summaryCard(),
      pinCard()
    );
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.attendance = { render, reset: () => (st = null) };
})();
