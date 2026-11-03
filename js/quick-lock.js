// 簡単ログイン（この端末のロック）：共有モードでログインしたあと、アプリを開くたびに PIN（4桁）か顔認証・指紋認証で解除する
// ・Firebase のログイン（メールのリンク）と、権限の確認（管理者・幹部・スタッフ、店舗の制限）はそのまま。ここはその手前の「鍵」だけ
// ・PIN はそのまま保存しない（PBKDF2 で元に戻せない形にして保存）。5回続けて間違えると待ち時間、合計10回で簡単ログインを解除してログアウト
// ・顔認証・指紋認証は WebAuthn（端末に内蔵の認証）。登録した鍵の署名を、保存しておいた公開鍵で確かめる
// ・設定はこの端末（localStorage）に、ログインした人（uid）と結びつけて保存。ログアウトしたとき・別の人がログインしたときは消す
// ・「この端末では使わない（共用の端末）」は、ログアウトしても残す（端末の設定）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const KEY = 'shift-app-quick-lock';
  const OFF_KEY = 'shift-app-quick-lock-off'; // この端末では使わない（共用の端末）
  const PBKDF2_ITER = 150000;
  const WAIT_FROM = 5; // この回数続けて間違えると、待ち時間
  const WAIT_FIRST_MS = 30 * 1000; // 最初の待ち時間（そのあと、間違えるたびに倍）
  const MAX_FAILS = 10; // 合計でこの回数間違えると、簡単ログインを解除してログアウト
  const LOCK_AFTER_MS = 5 * 60 * 1000; // ほかのアプリをこれだけ使ってから戻ったら、もう一度ロック

  let now = () => Date.now();

  // ---- 保存 ----

  function read() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      return v && typeof v === 'object' && v.uid ? v : null;
    } catch (err) {
      return null;
    }
  }

  function write(v) {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
      return true;
    } catch (err) {
      return false;
    }
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch (err) {
      // なにもしない
    }
  }

  // この人（uid）の設定。別の人の設定が残っていたら消す
  function configOf(uid) {
    const v = read();
    if (!v) return null;
    if (v.uid !== uid) {
      clear();
      return null;
    }
    return v;
  }

  function isShared() {
    try {
      return localStorage.getItem(OFF_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function setShared(on) {
    try {
      if (on) localStorage.setItem(OFF_KEY, '1');
      else localStorage.removeItem(OFF_KEY);
    } catch (err) {
      // なにもしない
    }
    if (on) clear();
  }

  function isEnabled(uid) {
    const c = uid ? configOf(uid) : null;
    return Boolean(c && c.pin && !isShared());
  }

  // ---- 文字の変換 ----

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64(text) {
    const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }

  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i += 1) d |= a[i] ^ b[i];
    return d === 0;
  }

  // ---- PIN ----

  async function pinHash(pin, salt, iter) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
    return new Uint8Array(bits);
  }

  function validPin(pin) {
    return /^\d{4}$/.test(String(pin));
  }

  async function setPin(uid, pin) {
    if (!validPin(pin)) throw new Error('PINコードは4桁の数字で入力してください。');
    const salt = randomBytes(16);
    const hash = await pinHash(String(pin), salt, PBKDF2_ITER);
    const c = configOf(uid) || { uid };
    c.pin = { alg: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: toB64(salt), hash: toB64(hash) };
    c.fails = 0;
    c.waitUntil = 0;
    c.offered = true;
    if (!write(c)) throw new Error('この端末に保存できませんでした（プライベートブラウズなど）。');
    setShared(false);
  }

  // 待ち時間の残り（ミリ秒）
  function waitLeft(uid) {
    const c = configOf(uid);
    return c && c.waitUntil ? Math.max(0, c.waitUntil - now()) : 0;
  }

  // 戻り値：{ ok: true } / { ok: false, wait: 残りミリ秒, left: 解除までに間違えられる回数, removed: 解除したか }
  async function verifyPin(uid, pin) {
    const c = configOf(uid);
    if (!c || !c.pin) return { ok: false, removed: true };
    const wait = waitLeft(uid);
    if (wait > 0) return { ok: false, wait, left: MAX_FAILS - (c.fails || 0) };
    const hash = await pinHash(String(pin), fromB64(c.pin.salt), c.pin.iter);
    if (validPin(pin) && sameBytes(hash, fromB64(c.pin.hash))) {
      c.fails = 0;
      c.waitUntil = 0;
      write(c);
      return { ok: true };
    }
    return recordFail(c);
  }

  function recordFail(c) {
    c.fails = (c.fails || 0) + 1;
    if (c.fails >= MAX_FAILS) {
      clear();
      return { ok: false, removed: true, left: 0 };
    }
    c.waitUntil = c.fails >= WAIT_FROM ? now() + WAIT_FIRST_MS * 2 ** (c.fails - WAIT_FROM) : 0;
    write(c);
    return { ok: false, wait: c.waitUntil ? c.waitUntil - now() : 0, left: MAX_FAILS - c.fails };
  }

  // ---- 顔認証・指紋認証（WebAuthn） ----

  async function bioAvailable() {
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) return false;
      if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (err) {
      return false;
    }
  }

  function hasBio(uid) {
    const c = configOf(uid);
    return Boolean(c && c.pin && c.bio);
  }

  // 顔認証・指紋認証を登録する（ボタンを押した直後に呼ぶ。iPhone は、押した操作のあとでないと出せない）
  async function registerBio(uid, label) {
    const c = configOf(uid);
    if (!c || !c.pin) throw new Error('先に PINコードを設定してください。');
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'RENASCOR SHIFT' },
        user: { id: randomBytes(16), name: label || 'RENASCOR SHIFT', displayName: label || 'RENASCOR SHIFT' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
        attestation: 'none',
      },
    });
    if (!cred) throw new Error('登録できませんでした。');
    const r = cred.response;
    const publicKey = typeof r.getPublicKey === 'function' ? r.getPublicKey() : null;
    const alg = typeof r.getPublicKeyAlgorithm === 'function' ? r.getPublicKeyAlgorithm() : null;
    c.bio = { id: toB64(cred.rawId), publicKey: publicKey ? toB64(publicKey) : null, alg };
    write(c);
  }

  function removeBio(uid) {
    const c = configOf(uid);
    if (!c) return;
    delete c.bio;
    write(c);
  }

  // ES256 の署名（DER）を、WebCrypto が受け取る形（r と s を32バイトずつ）に直す
  function derToRaw(der) {
    let p = 2;
    if (der[1] & 0x80) p += der[1] & 0x7f;
    const part = () => {
      if (der[p] !== 0x02) throw new Error('bad signature');
      const len = der[p + 1];
      let v = der.slice(p + 2, p + 2 + len);
      p += 2 + len;
      while (v.length > 32 && v[0] === 0) v = v.slice(1);
      const out = new Uint8Array(32);
      out.set(v, 32 - v.length);
      return out;
    };
    const r = part();
    const s = part();
    const raw = new Uint8Array(64);
    raw.set(r, 0);
    raw.set(s, 32);
    return raw;
  }

  // 認証の結果を確かめる：鍵・用途・チャレンジ・このアプリの場所・本人の確認（UV）・署名
  async function checkAssertion(bio, challenge, a) {
    if (!a || toB64(a.rawId) !== bio.id) return false;
    const clientData = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON));
    if (clientData.type !== 'webauthn.get' || clientData.challenge !== toB64(challenge) || clientData.origin !== location.origin) return false;
    const auth = new Uint8Array(a.response.authenticatorData);
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.hostname)));
    if (!sameBytes(auth.slice(0, 32), rpHash)) return false;
    const flags = auth[32];
    if (!(flags & 0x01) || !(flags & 0x04)) return false; // 端末にふれた・本人を確かめた
    if (!bio.publicKey) return true; // 公開鍵を取り出せない古いブラウザ：ここまでの確認だけ
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', a.response.clientDataJSON));
    const signed = new Uint8Array(auth.length + clientHash.length);
    signed.set(auth, 0);
    signed.set(clientHash, auth.length);
    const sig = new Uint8Array(a.response.signature);
    if (bio.alg === -257) {
      const key = await crypto.subtle.importKey('spki', fromB64(bio.publicKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
    }
    const key = await crypto.subtle.importKey('spki', fromB64(bio.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), signed);
  }

  async function verifyBio(uid) {
    const c = configOf(uid);
    if (!c || !c.pin || !c.bio) return false;
    const challenge = randomBytes(32);
    const a = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: fromB64(c.bio.id) }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    const ok = await checkAssertion(c.bio, challenge, a);
    if (ok) {
      c.fails = 0;
      c.waitUntil = 0;
      write(c);
    }
    return ok;
  }

  // ---- ロックの画面 ----

  let lockState = null; // { uid, resolve, ... }
  let hiddenAt = 0;

  function isLocked() {
    return Boolean(lockState);
  }

  function setAppHidden(on) {
    document.body.classList.toggle('is-locked', on);
    for (const node of document.body.children) {
      if (node.id === 'quick-lock' || node.tagName === 'SCRIPT') continue;
      if (on) node.setAttribute('inert', '');
      else node.removeAttribute('inert');
    }
  }

  function seconds(ms) {
    return Math.ceil(ms / 1000);
  }

  // ロックの画面を出す。解除したら true、「メールでログインし直す」を選んだら false
  function lock(uid) {
    if (lockState) return lockState.promise;
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    lockState = { uid, resolve, promise, digits: '', busy: false, timer: null };
    renderLock();
    setAppHidden(true);
    if (hasBio(uid)) tryBio(true);
    return promise;
  }

  function finishLock(result) {
    if (!lockState) return;
    const s = lockState;
    lockState = null;
    clearInterval(s.timer);
    document.removeEventListener('keydown', onLockKey);
    const box = document.getElementById('quick-lock');
    if (box) box.remove();
    setAppHidden(false);
    s.resolve(result);
  }

  function lockMessage(text, isError) {
    const msg = document.querySelector('#quick-lock .qlock__msg');
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle('is-error', Boolean(isError));
  }

  function renderDots() {
    const dots = document.querySelectorAll('#quick-lock .qlock__dot');
    dots.forEach((d, i) => d.classList.toggle('is-on', i < lockState.digits.length));
  }

  function showWait() {
    const s = lockState;
    clearInterval(s.timer);
    const tick = () => {
      const left = waitLeft(s.uid);
      const pad = document.querySelector('#quick-lock .qlock__pad');
      if (pad) pad.classList.toggle('is-waiting', left > 0);
      for (const b of document.querySelectorAll('#quick-lock .qlock__key')) b.disabled = left > 0 || s.busy;
      if (left > 0) lockMessage(`続けて間違えたため、${seconds(left)}秒お待ちください`, true);
      else {
        clearInterval(s.timer);
        lockMessage('PINコードを入力してください');
      }
    };
    tick();
    if (waitLeft(s.uid) > 0) s.timer = setInterval(tick, 1000);
  }

  async function pressDigit(d) {
    const s = lockState;
    if (!s || s.busy || waitLeft(s.uid) > 0 || s.digits.length >= 4) return;
    s.digits += d;
    renderDots();
    if (s.digits.length < 4) return;
    s.busy = true;
    for (const b of document.querySelectorAll('#quick-lock .qlock__key')) b.disabled = true;
    lockMessage('確かめています…');
    const r = await verifyPin(s.uid, s.digits);
    if (lockState !== s) return;
    s.busy = false;
    s.digits = '';
    renderDots();
    if (r.ok) {
      finishLock(true);
      return;
    }
    if (r.removed) {
      window.alert('PINコードを続けて間違えたため、この端末の簡単ログインを解除しました。\nメールでログインし直してください。');
      finishLock(false);
      return;
    }
    const pad = document.querySelector('#quick-lock .qlock__dots');
    if (pad) {
      pad.classList.remove('is-shake');
      void pad.offsetWidth;
      pad.classList.add('is-shake');
    }
    if (r.wait > 0) showWait();
    else {
      for (const b of document.querySelectorAll('#quick-lock .qlock__key')) b.disabled = false;
      lockMessage(`PINコードが違います（あと${r.left}回間違えると、簡単ログインを解除します）`, true);
    }
  }

  function pressBack() {
    const s = lockState;
    if (!s || s.busy) return;
    s.digits = s.digits.slice(0, -1);
    renderDots();
  }

  async function tryBio(auto) {
    const s = lockState;
    if (!s || s.bioBusy) return;
    s.bioBusy = true;
    try {
      const ok = await verifyBio(s.uid);
      if (lockState !== s) return;
      if (ok) finishLock(true);
      else if (!auto) lockMessage('確認できませんでした。PINコードで解除してください', true);
    } catch (err) {
      // 自動で出したときに断られた（押す操作が必要な端末など）ときは、ボタンを押してもらう
      if (!auto && lockState === s) lockMessage('顔認証・指紋認証を使えませんでした。PINコードで解除してください', true);
    } finally {
      s.bioBusy = false;
    }
  }

  function onLockKey(e) {
    if (!lockState) return;
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      pressDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      pressBack();
    }
  }

  function renderLock() {
    const s = lockState;
    const old = document.getElementById('quick-lock');
    if (old) old.remove();
    const key = (d) => el('button', { type: 'button', class: 'qlock__key', 'aria-label': d, onclick: () => pressDigit(d) }, d);
    const box = el(
      'div',
      { id: 'quick-lock', class: 'qlock', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'qlock-title' },
      el(
        'div',
        { class: 'qlock__inner' },
        el('p', { class: 'qlock__app' }, 'RENASCOR SHIFT'),
        el('h2', { class: 'qlock__title', id: 'qlock-title' }, 'ロックを解除'),
        el('p', { class: 'qlock__msg', role: 'status', 'aria-live': 'polite' }, 'PINコードを入力してください'),
        el('div', { class: 'qlock__dots', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => el('span', { class: 'qlock__dot' }))),
        el(
          'div',
          { class: 'qlock__pad', role: 'group', 'aria-label': 'PINコードの入力' },
          ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(key),
          hasBio(s.uid)
            ? el('button', { type: 'button', class: 'qlock__key qlock__key--sub qlock__bio', 'aria-label': '顔認証・指紋認証で解除', onclick: () => tryBio(false) }, '顔・指紋')
            : el('span', { class: 'qlock__blank' }),
          key('0'),
          el('button', { type: 'button', class: 'qlock__key qlock__key--sub', 'aria-label': '1文字消す', onclick: pressBack }, '消す')
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'text-btn qlock__fallback',
            onclick: () => {
              if (window.confirm('この端末の簡単ログインを解除して、メールでログインし直しますか？')) {
                clear();
                finishLock(false);
              }
            },
          },
          'PINを忘れたとき（メールでログインし直す）'
        )
      )
    );
    document.body.append(box);
    document.addEventListener('keydown', onLockKey);
    showWait();
  }

  // ほかのアプリから戻ったとき（5分以上たっていたら）、もう一度ロックする
  function watchVisibility(getUid) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = now();
        return;
      }
      const uid = getUid();
      if (hiddenAt && uid && now() - hiddenAt >= LOCK_AFTER_MS && isEnabled(uid) && !lockState) {
        lock(uid).then((ok) => {
          if (!ok && K.app && K.app.cloudActions) K.app.cloudActions.signOut();
        });
      }
      hiddenAt = 0;
    });
  }

  // ---- 設定の欄（オーナーの「設定 > データ」、幹部・スタッフの画面） ----

  let form = null; // { uid, error, saving } PIN の入力欄を開いているとき
  let notice = '';

  function pinForm(user, done) {
    const pin1 = el('input', { id: 'qlock-pin1', class: 'field__input qlock-input', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '4', autocomplete: 'off', 'aria-describedby': 'qlock-pin-note' });
    const pin2 = el('input', { id: 'qlock-pin2', class: 'field__input qlock-input', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '4', autocomplete: 'off' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: !form.error }, form.error || '');
    const submit = el('button', { type: 'submit', class: 'btn btn--primary' }, 'このPINコードにする');
    setTimeout(() => pin1.focus(), 0);
    return el(
      'form',
      {
        class: 'qlock-form',
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          const a = pin1.value.trim();
          const b = pin2.value.trim();
          let error = '';
          if (!validPin(a)) error = 'PINコードは4桁の数字で入力してください。';
          else if (a !== b) error = '確認のPINコードが一致しません。もう一度入力してください。';
          else if (/^(\d)\1{3}$/.test(a) || '0123456789'.includes(a) || '9876543210'.includes(a)) error = '「1111」「1234」のような、分かりやすい番号は使えません。';
          if (error) {
            errorBox.textContent = error;
            errorBox.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            await setPin(user.uid, a);
            form = null;
            notice = 'PINコードを設定しました。次にアプリを開いたときから使えます。';
            done();
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
            submit.disabled = false;
          }
        },
      },
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'qlock-pin1' }, 'PINコード（4桁の数字）'), pin1),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'qlock-pin2' }, '確認のため、もう一度'), pin2),
      el('p', { class: 'hint hint--left', id: 'qlock-pin-note' }, '「1111」「1234」のような番号や、誕生日など人に知られやすい番号は避けてください。'),
      errorBox,
      el(
        'div',
        { class: 'actions actions--tight' },
        submit,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => {
              form = null;
              done();
            },
          },
          'やめる'
        )
      )
    );
  }

  // 設定の欄の中身。user：{ uid, email }、rerender：作り直す関数
  function panel(user, rerender) {
    const box = el('div', { class: 'qlock-panel' });
    const status = el('p', { class: 'sync__result', role: 'status', hidden: !notice }, notice);
    notice = '';
    const done = () => (rerender ? rerender() : null);

    if (form && form.uid === user.uid) {
      box.append(pinForm(user, done), status);
      return box;
    }
    if (isShared()) {
      box.append(
        el('p', { class: 'hint hint--left' }, 'この端末では簡単ログインを使わない設定です（共用の端末）。アプリを開くと、ログインしたままの状態で開きます。'),
        el(
          'div',
          { class: 'actions actions--tight' },
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost',
              onclick: () => {
                setShared(false);
                done();
              },
            },
            '簡単ログインを使えるようにする'
          )
        ),
        status
      );
      return box;
    }
    const c = configOf(user.uid);
    if (!c || !c.pin) {
      box.append(
        el('p', { class: 'hint hint--left' }, 'アプリを開くたびに、4桁のPINコード（対応する端末では顔認証・指紋認証）でロックを解除するようにできます。設定はこの端末だけに保存します。'),
        el(
          'div',
          { class: 'actions actions--tight' },
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--primary',
              onclick: () => {
                form = { uid: user.uid };
                done();
              },
            },
            'PINコードを設定する'
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost',
              onclick: () => {
                if (!window.confirm('この端末では簡単ログインを使わないようにしますか？\n（共用の端末向け。あとから変えられます）')) return;
                setShared(true);
                done();
              },
            },
            'この端末では使わない（共用の端末）'
          )
        ),
        status
      );
      return box;
    }
    const bioBtnBox = el('div', { class: 'actions actions--tight qlock-bio-actions' });
    box.append(
      el('dl', { class: 'info-list' }, el('dt', null, 'この端末'), el('dd', { class: 'qlock-state' }, c.bio ? 'PINコード・顔認証/指紋認証で解除' : 'PINコードで解除')),
      el('p', { class: 'hint hint--left' }, 'アプリを開いたとき、ほかのアプリを5分以上使ってから戻ったときにロックします。ログアウトすると、この端末の簡単ログインは解除されます。'),
      el(
        'div',
        { class: 'actions actions--tight' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => {
              form = { uid: user.uid };
              done();
            },
          },
          'PINコードを変える'
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => {
              if (!window.confirm('この端末の簡単ログインをやめますか？\n（ログインはそのまま続きます）')) return;
              clear();
              notice = '簡単ログインをやめました。';
              done();
            },
          },
          '簡単ログインをやめる'
        )
      ),
      bioBtnBox,
      status
    );
    if (c.bio) {
      bioBtnBox.append(
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => {
              removeBio(user.uid);
              notice = '顔認証・指紋認証の登録を解除しました（PINコードは使えます）。';
              done();
            },
          },
          '顔認証・指紋認証の登録を解除'
        )
      );
    } else {
      bioAvailable().then((yes) => {
        if (!yes) {
          bioBtnBox.append(el('p', { class: 'hint hint--left qlock-bio-none' }, 'この端末（ブラウザ）では顔認証・指紋認証を使えないため、PINコードで解除します。'));
          return;
        }
        bioBtnBox.append(
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--primary',
              onclick: async () => {
                try {
                  await registerBio(user.uid, user.email);
                  notice = '顔認証・指紋認証を登録しました。';
                } catch (err) {
                  notice = err && err.name === 'NotAllowedError' ? '登録をやめました（または時間切れ）。もう一度押すと登録できます。' : `登録できませんでした（${(err && err.message) || err}）`;
                }
                done();
              },
            },
            '顔認証・指紋認証を登録する'
          )
        );
      });
    }
    return box;
  }

  function card(user, rerender) {
    return el('section', { class: 'card qlock-card' }, el('h2', { class: 'card__title' }, '簡単ログイン（この端末）'), panel(user, rerender));
  }

  // ログインしたあとに一度だけ、設定するかをたずねる（共用の端末・設定済み・前にたずねた人には出さない）
  // 入力シート（.sheet-layer）とは別の部品にする（入力シートを開いている間は画面の作り直しを待つ仕組みなどに、巻き込まないため）
  function offer(user) {
    if (!user || !user.uid || isShared() || lockState || document.getElementById('qlock-offer')) return;
    const c = configOf(user.uid);
    if (c && (c.pin || c.offered)) return;
    write({ ...(c || { uid: user.uid }), offered: true });
    const layer = el('div', { id: 'qlock-offer', class: 'qlock-offer' });
    const close = () => layer.remove();
    const body = el('div', { class: 'qlock-offer__sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'qlock-offer-title' });
    const draw = () => {
      if (!document.getElementById('qlock-offer')) return;
      body.replaceChildren(
        el('h2', { class: 'qlock-offer__title', id: 'qlock-offer-title' }, '簡単ログインを設定しますか？'),
        // 「この端末では使わない」を選んだら閉じる。それ以外（PINの入力・設定のあと）は、この中で続ける
        panel(user, () => (isShared() ? close() : draw())),
        el('div', { class: 'actions actions--tight' }, el('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, isEnabled(user.uid) ? '閉じる' : 'あとで（設定はいつでもできます）'))
      );
    };
    layer.append(el('div', { class: 'qlock-offer__backdrop', onclick: close }), body);
    document.body.append(layer);
    draw();
  }

  K.quickLock = {
    LOCK_AFTER_MS,
    MAX_FAILS,
    isEnabled,
    isShared,
    setShared,
    setPin,
    verifyPin,
    waitLeft,
    hasBio,
    bioAvailable,
    registerBio,
    removeBio,
    verifyBio,
    clear,
    lock,
    isLocked,
    watchVisibility,
    card,
    offer,
    // テスト用
    setClock: (fn) => {
      now = fn || (() => Date.now());
    },
    _checkAssertion: checkAssertion,
    _derToRaw: derToRaw,
  };
})();
