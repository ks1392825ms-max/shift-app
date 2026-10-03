// 共有モードの入口（ログイン・メール送信・権限の確認・初回のデータ移行）
// app.js が状態（state）を決めて、この画面を表示する。
//   loading       準備中
//   login         メールアドレスを入力して、ログイン用のメールを送る
//   sent          メールを送った
//   confirm-email ほかの端末でメールのリンクを開いたとき：メールアドレスをもう一度入力
//   not-admin     管理者として登録されていない
//   empty         共有の保存場所が空：初回のデータ移行（バックアップファイルから写しをアップロード）
//   error         エラー
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const MAX_FILE_SIZE = 20 * 1024 * 1024;

  // 移行用に選んだファイル（確認画面を出すまで持っておく）
  let pendingUpload = null;

  function card(title, ...children) {
    return el('section', { class: 'card gate-card' }, el('h2', { class: 'card__title' }, title), ...children);
  }

  function backToLocalButton() {
    return el(
      'button',
      { type: 'button', class: 'btn btn--ghost', onclick: () => K.app.cloudActions.backToLocal() },
      'この端末だけで使う形に戻す'
    );
  }

  function emailForm({ id, label, button, value, onSubmit }) {
    const input = el('input', {
      id,
      class: 'field__input',
      type: 'email',
      inputmode: 'email',
      autocomplete: 'email',
      placeholder: '例：name@example.com',
      value: value || '',
    });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary' }, button);
    const form = el(
      'form',
      {
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          const email = input.value.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errorBox.textContent = 'メールアドレスを正しく入力してください。';
            errorBox.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            await onSubmit(email);
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
            submit.disabled = false;
          }
        },
      },
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: id }, label), input),
      errorBox,
      el('div', { class: 'actions' }, submit)
    );
    setTimeout(() => input.focus(), 0);
    return form;
  }

  // ---- 初回：店舗名を入力して始める ----

  function storeNameForm() {
    const input = el('input', { id: 'first-store-name', class: 'field__input', type: 'text', maxlength: '10', autocomplete: 'off', placeholder: '例：本店' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const status = el('p', { class: 'sync__result', role: 'status', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary' }, 'この店舗名で始める');
    return el(
      'form',
      {
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          errorBox.hidden = true;
          submit.disabled = true;
          try {
            await K.app.cloudActions.startFresh(input.value);
            status.hidden = false;
            status.textContent = '店舗を作りました。まもなく画面が切り替わります。';
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
            submit.disabled = false;
          }
        },
      },
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'first-store-name' }, '店舗名（10文字以内）'), input),
      errorBox,
      el('div', { class: 'actions' }, submit),
      status
    );
  }

  // ---- 初回のデータ移行 ----

  function pickFile() {
    const input = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      try {
        if (file.size > MAX_FILE_SIZE) throw new Error('ファイルが大きすぎます。バックアップファイルか確認してください。');
        const parsed = K.backup.parseFile(await file.text());
        pendingUpload = { fileName: file.name, parsed, error: null };
      } catch (err) {
        pendingUpload = { error: err.message };
      }
      K.app.rerender();
    });
    input.addEventListener('cancel', () => input.remove());
    document.body.append(input);
    input.click();
  }

  function uploadPreview() {
    const { parsed, fileName } = pendingUpload;
    const live = (list) => list.filter((x) => !x.deleted);
    const d = parsed.data;
    const rows = live(d.stores)
      .sort((a, b) => a.order - b.order)
      .map((s) => {
        const after = K.storage.normalizeStoreName(s.name);
        const staff = live(d.staff).filter((m) => m.storeId === s.id).length;
        return el(
          'li',
          { class: 'detail-item' },
          el('span', { class: 'detail-item__text' }, after, after !== s.name ? el('span', { class: 'detail-item__note' }, `（「${s.name}」から店舗名を整えます）`) : null),
          el('span', { class: 'detail-item__note' }, `スタッフ ${staff}人`)
        );
      });
    const status = el('p', { class: 'sync__result', role: 'status', hidden: true });
    const go = el(
      'button',
      {
        type: 'button',
        class: 'btn btn--primary',
        onclick: async () => {
          go.disabled = true;
          status.hidden = false;
          status.textContent = 'アップロードしています…（そのままお待ちください）';
          try {
            const result = await K.app.cloudActions.upload(parsed.data);
            pendingUpload = null;
            status.textContent = `アップロードしました（${result.records}件）。まもなく画面が切り替わります。`;
          } catch (err) {
            status.textContent = err.message;
            go.disabled = false;
          }
        },
      },
      'この内容で共有の保存場所に移す'
    );
    return card(
      '移す内容の確認',
      el('dl', { class: 'info-list' }, el('dt', null, 'ファイル'), el('dd', null, fileName), el('dt', null, 'シフト'), el('dd', null, `${live(d.shifts).length}件`)),
      el('ul', { class: 'detail-list' }, rows),
      el(
        'p',
        { class: 'hint hint--left' },
        'アップロードするのは写しです。この端末のデータ（今まで使っていたデータ）は消えず、書き換えもしません。'
      ),
      parsed.skipped ? el('p', { class: 'form-error' }, `形式が正しくないため移せない記録：${parsed.skipped}件`) : null,
      el(
        'div',
        { class: 'actions' },
        go,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => {
              pendingUpload = null;
              K.app.rerender();
            },
          },
          'ファイルを選び直す'
        )
      ),
      status
    );
  }

  function render(container, params) {
    const s = params.state;
    const info = params.info || {};
    let body;

    if (s === 'loading') {
      body = card('共有モード', el('p', { class: 'hint hint--left' }, '準備しています…'));
    } else if (s === 'login') {
      body = card(
        'ログイン（共有モード）',
        el('p', { class: 'hint hint--left' }, 'メールアドレスを入力すると、ログイン用のリンクがメールで届きます。パスワードは不要です。'),
        emailForm({
          id: 'login-email',
          label: 'メールアドレス',
          button: 'ログイン用のメールを送る',
          value: K.cloud.savedEmail(),
          onSubmit: (email) => K.app.cloudActions.sendLink(email),
        }),
        el('div', { class: 'actions' }, backToLocalButton())
      );
    } else if (s === 'sent') {
      body = card(
        'メールを送りました',
        el('p', { class: 'hint hint--left' }, `${info.email} にログイン用のメールを送りました。メールの中のリンクを押すと、ログインが完了します。`),
        el(
          'ul',
          { class: 'gate-notes' },
          el('li', null, 'メールが届かないときは、迷惑メールのフォルダも確認してください。'),
          el('li', null, 'リンクは、このメールを送ったのと同じ端末・同じブラウザで開くと、すぐにログインできます。')
        ),
        el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => K.app.cloudActions.showLogin() }, 'メールアドレスを入力し直す'))
      );
    } else if (s === 'confirm-email') {
      body = card(
        'メールアドレスの確認',
        el('p', { class: 'hint hint--left' }, 'ログイン用のメールを送ったメールアドレスを、もう一度入力してください。'),
        emailForm({
          id: 'confirm-email',
          label: 'メールアドレス',
          button: 'ログインする',
          onSubmit: (email) => K.app.cloudActions.confirmEmail(email),
        })
      );
    } else if (s === 'not-admin') {
      body = card(
        'このアカウントでは使えません',
        el('p', { class: 'hint hint--left' }, `${info.email} は、管理者として登録されていません。`),
        el('p', { class: 'hint hint--left' }, '管理者のメールアドレスは、Firebase の管理画面（access/admins）に登録します。'),
        el(
          'div',
          { class: 'actions' },
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => K.app.cloudActions.signOut() }, 'ログアウト'),
          backToLocalButton()
        )
      );
    } else if (s === 'empty') {
      if (pendingUpload && !pendingUpload.error) {
        body = uploadPreview();
      } else {
        body = el(
          'div',
          null,
          card(
            '共有の保存場所はまだ空です',
            el('p', { class: 'hint hint--left' }, `${info.email || ''} でログインしています。`),
            el('p', { class: 'hint hint--left' }, '最初の1回だけ、次のどちらかで始めます。登録した店舗名・スタッフ名・シフトは、共有の保存場所（Firebase）にだけ保存されます。'),
            el(
              'div',
              { class: 'actions' },
              el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => K.app.cloudActions.signOut() }, 'ログアウト'),
              backToLocalButton()
            )
          ),
          card(
            '1. 店舗名を入力して始める',
            el('p', { class: 'hint hint--left' }, '最初の店舗を作ります。スタッフ・シフト・ほかの店舗は、このあとアプリの画面（設定）から登録します。'),
            storeNameForm()
          ),
          card(
            '2. バックアップファイルから移す',
            el('p', { class: 'hint hint--left' }, 'この端末で使っていたデータのバックアップファイルを選んで、写しをアップロードします。'),
            pendingUpload && pendingUpload.error ? el('p', { class: 'form-error', role: 'alert' }, pendingUpload.error) : null,
            el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--ghost', onclick: pickFile }, 'バックアップファイルを選ぶ'))
          )
        );
      }
    } else {
      body = card(
        'うまくいきませんでした',
        el('p', { class: 'form-error', role: 'alert' }, info.message || 'エラーが起きました。'),
        el('p', { class: 'hint hint--left' }, '電波の状態を確認して、もう一度開いてください。'),
        el(
          'div',
          { class: 'actions' },
          el('button', { type: 'button', class: 'btn btn--primary', onclick: () => location.reload() }, 'もう一度試す'),
          backToLocalButton()
        )
      );
    }

    container.append(body);
  }

  K.screens = K.screens || {};
  K.screens.login = { render };
})();
