// 共有モードの入口（ログイン・メール送信・権限の確認・初回のデータ移行）
// app.js が状態（state）を決めて、この画面を表示する。
//   loading       準備中
//   login         メールアドレスとパスワードでログインする
//   reset         初めての方・パスワードを忘れた方：パスワードを決めるためのメールを送る
//   sent          メールを送った
//   confirm-email ほかの端末でメールのリンクを開いたとき：メールアドレスをもう一度入力
//   set-password  メールのリンクでログインした直後：新しいパスワードを決める（決めるまでアプリには入らない）
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

  const PASSWORD_MIN = 8;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // パスワードの入力欄（「表示」で、入力した文字を確かめられる）
  function passwordField({ id, label, autocomplete, note }) {
    const input = el('input', { id, class: 'field__input pw-input', type: 'password', autocomplete, autocapitalize: 'off', spellcheck: 'false' });
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'pw-toggle',
        'aria-controls': id,
        'aria-pressed': 'false',
        onclick: () => {
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          toggle.textContent = show ? '隠す' : '表示';
          toggle.setAttribute('aria-pressed', String(show));
        },
      },
      '表示'
    );
    return {
      input,
      node: el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: id }, label),
        el('div', { class: 'pw-wrap' }, input, toggle),
        note ? el('p', { class: 'field__note' }, note) : null
      ),
    };
  }

  // 通常のログイン：メールアドレスとパスワード
  function passwordLoginForm(email, notice) {
    const mail = el('input', { id: 'login-email', class: 'field__input', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'off', placeholder: '例：name@example.com', value: email || '' });
    const pw = passwordField({ id: 'login-password', label: 'パスワード', autocomplete: 'current-password' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: !notice }, notice || '');
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'ログイン');
    setTimeout(() => (mail.value ? pw.input : mail).focus(), 0);
    return el(
      'form',
      {
        class: 'login-form',
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          errorBox.hidden = true;
          const address = mail.value.trim();
          if (!EMAIL_RE.test(address)) {
            errorBox.textContent = 'メールアドレスを正しく入力してください。';
            errorBox.hidden = false;
            return;
          }
          if (!pw.input.value) {
            errorBox.textContent = 'パスワードを入力してください。';
            errorBox.hidden = false;
            return;
          }
          submit.disabled = true;
          submit.textContent = 'ログインしています…';
          try {
            await K.app.cloudActions.signInWithPassword(address, pw.input.value);
            // ログインが完了すると、画面が切り替わる
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
            submit.disabled = false;
            submit.textContent = 'ログイン';
          }
        },
      },
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'login-email' }, 'メールアドレス'), mail),
      pw.node,
      errorBox,
      el('div', { class: 'actions' }, submit),
      el('div', { class: 'login-sub' }, el('button', { type: 'button', class: 'text-btn login-link', onclick: () => K.app.cloudActions.showReset(mail.value.trim()) }, '初めての方・パスワードを忘れた方'))
    );
  }

  // メールのリンクでログインした直後：新しいパスワードを決める
  function setPasswordForm() {
    const pw1 = passwordField({ id: 'new-password', label: '新しいパスワード', autocomplete: 'new-password', note: `${PASSWORD_MIN}文字以上。ほかのサービスと同じパスワードは避けてください。` });
    const pw2 = passwordField({ id: 'new-password2', label: '確認のため、もう一度', autocomplete: 'new-password' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'このパスワードにする');
    setTimeout(() => pw1.input.focus(), 0);
    return el(
      'form',
      {
        class: 'login-form',
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          const a = pw1.input.value;
          let error = '';
          if (a.length < PASSWORD_MIN) error = `パスワードは${PASSWORD_MIN}文字以上にしてください。`;
          else if (/^\s|\s$/.test(a)) error = 'パスワードの最初と最後に空白は使えません。';
          else if (a !== pw2.input.value) error = '確認のパスワードが一致しません。もう一度入力してください。';
          if (error) {
            errorBox.textContent = error;
            errorBox.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            await K.app.cloudActions.setPassword(a);
            K.app.toast('パスワードを決めました。次からは、メールアドレスとパスワードでログインできます', 5000);
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
            submit.disabled = false;
          }
        },
      },
      pw1.node,
      pw2.node,
      errorBox,
      el('div', { class: 'actions' }, submit)
    );
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
        'ログイン',
        passwordLoginForm(K.cloud && K.cloud.savedEmail ? K.cloud.savedEmail() : '', info.notice),
        el('div', { class: 'login-local' }, backToLocalButton())
      );
    } else if (s === 'reset') {
      body = card(
        '初めての方・パスワードを忘れた方',
        el('p', { class: 'hint hint--left' }, '登録しているメールアドレスを入れてください。届いたメールのリンクを押すと、新しいパスワードを決める画面が開きます。'),
        emailForm({
          id: 'reset-email',
          label: 'メールアドレス',
          button: 'メールを送る',
          value: info.email || (K.cloud && K.cloud.savedEmail ? K.cloud.savedEmail() : ''),
          onSubmit: (email) => K.app.cloudActions.sendReset(email),
        }),
        el('div', { class: 'login-sub' }, el('button', { type: 'button', class: 'text-btn login-link', onclick: () => K.app.cloudActions.showLogin() }, '‹ ログインに戻る'))
      );
    } else if (s === 'link-error') {
      body = card(
        'このリンクは使えません',
        el('p', { class: 'hint hint--left' }, 'リンクの期限が切れているか、すでに使われています。新しいメールを送ってください。'),
        el(
          'ul',
          { class: 'gate-notes' },
          el('li', null, '届いたメールのうち、いちばん新しいメールのリンクを押してください。'),
          el('li', null, 'リンクは1回しか使えません。長押し（下見）をせずに、1回だけ押してください。')
        ),
        emailForm({
          id: 'resend-email',
          label: 'メールアドレス',
          button: '新しいメールを送る',
          value: info.email || (K.cloud && K.cloud.savedEmail ? K.cloud.savedEmail() : ''),
          onSubmit: (email) => K.app.cloudActions.sendReset(email),
        }),
        el('div', { class: 'login-sub' }, el('button', { type: 'button', class: 'text-btn login-link', onclick: () => K.app.cloudActions.showLogin() }, '‹ ログインに戻る'))
      );
    } else if (s === 'sent-reset') {
      const firstStatus = el('p', { class: 'form-error', role: 'alert', hidden: true });
      const firstBtn = el(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost btn--block',
          onclick: async () => {
            firstBtn.disabled = true;
            firstStatus.hidden = true;
            try {
              await K.app.cloudActions.sendLink(info.email);
            } catch (err) {
              firstStatus.textContent = err.message;
              firstStatus.hidden = false;
              firstBtn.disabled = false;
            }
          },
        },
        '初めてログインする方はこちら（ログイン用のメールを送る）'
      );
      body = card(
        'メールを送りました',
        el('p', { class: 'hint hint--left' }, `${info.email} に「パスワードの再設定」のメールを送りました。`),
        el(
          'ol',
          { class: 'gate-notes' },
          el('li', null, 'メールのリンクを押します（スマホ・パソコンのどちらで開いても大丈夫です）。'),
          el('li', null, '開いた画面で、新しいパスワード（8文字以上）を入れて「保存」を押します。'),
          el('li', null, 'このアプリに戻って、メールアドレスと新しいパスワードでログインします。')
        ),
        el('p', { class: 'hint hint--left' }, 'メールが届かないときは、迷惑メールのフォルダーも確認してください。パスワードを決めると、ほかの端末は1時間ほどでログアウトされます（新しいパスワードでログインし直します）。'),
        el(
          'div',
          { class: 'first-login' },
          el('p', { class: 'hint hint--left' }, '数分たっても届かないとき：まだ一度もログインしたことがない方には、このメールは届きません。下のボタンを押してください。'),
          firstBtn,
          firstStatus
        ),
        el('div', { class: 'login-sub' }, el('button', { type: 'button', class: 'text-btn login-link', onclick: () => K.app.cloudActions.showLogin() }, '‹ ログインに戻る'))
      );
    } else if (s === 'sent') {
      body = card(
        'メールを送りました',
        el('p', { class: 'hint hint--left' }, `${info.email} にメールを送りました。メールの中のリンクを押して、新しいパスワードを決めてください。`),
        el(
          'ul',
          { class: 'gate-notes' },
          el('li', null, 'リンクは、スマホ・パソコンのどちらで開いても大丈夫です（Safari などのブラウザが開きます）。'),
          el('li', null, 'リンクは1回しか使えません。いちばん新しいメールのリンクを、長押し（下見）をせずに1回だけ押してください。'),
          el('li', null, 'パスワードを決めたら、ホーム画面（Dock）のアプリに戻って、メールアドレスとパスワードでログインしてください。'),
          el('li', null, 'メールが届かないときは、迷惑メールのフォルダーも確認してください。')
        ),
        el('div', { class: 'login-sub' }, el('button', { type: 'button', class: 'text-btn login-link', onclick: () => K.app.cloudActions.showLogin() }, '‹ ログインに戻る'))
      );
    } else if (s === 'set-password') {
      body = card(
        '新しいパスワードを決める',
        el('p', { class: 'hint hint--left' }, `${info.email || ''} の、ログイン用のパスワードを決めてください。`),
        setPasswordForm(),
        el('div', { class: 'login-sub' }, el('button', { type: 'button', class: 'text-btn login-link', onclick: () => K.app.cloudActions.signOut() }, 'やめる（ログアウト）'))
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
    } else if (s === 'staff') {
      // スタッフの申請画面は段階Bで作る。今はログインできることだけ確かめられる
      body = card(
        'スタッフとしてログインしました',
        el('p', { class: 'hint hint--left' }, `${info.email} でログインしています。`),
        el('p', { class: 'hint hint--left' }, '希望休・有給の申請画面は、準備ができしだい使えるようになります。'),
        el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => K.app.cloudActions.signOut() }, 'ログアウト'))
      );
    } else if (s === 'not-admin') {
      body = card(
        'このアカウントでは使えません',
        el('p', { class: 'hint hint--left' }, `${info.email} は、管理者・スタッフとして登録されていません。`),
        el('p', { class: 'hint hint--left' }, '管理者は Firebase の管理画面（access/admins）に、スタッフは管理者がアプリの「設定 > スタッフ」のログイン用メールに登録します。'),
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

  // ログイン中の人の「パスワード」の欄（設定 > データ、幹部・スタッフの画面）：自分のメールにリンクを送り、開くとパスワードを決め直せる
  function passwordCard(user) {
    const status = el('p', { class: 'sync__result', role: 'status', hidden: true });
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost',
        onclick: async () => {
          if (!window.confirm(`${user.email} に、パスワードを決め直すためのメールを送りますか？`)) return;
          btn.disabled = true;
          status.hidden = false;
          status.textContent = '送っています…';
          try {
            await K.app.cloudActions.requestPasswordChange();
            status.textContent = 'パスワード再設定のメールを送りました。メールのリンクを押して、新しいパスワードを決めてください。決めたあと、この端末を含むログイン中の端末は1時間ほどでログアウトされるので、新しいパスワードでログインし直してください。';
          } catch (err) {
            status.textContent = `送れませんでした（${err.message}）。少し待ってから、もう一度試してください。`;
          } finally {
            btn.disabled = false;
          }
        },
      },
      'パスワードを決め直す（メールで確認）'
    );
    return el(
      'section',
      { class: 'card pw-card' },
      el('h2', { class: 'card__title' }, 'パスワード'),
      el('p', { class: 'hint hint--left' }, 'メールアドレスとパスワードでログインします。パスワードをまだ決めていないとき・変えたいときは、下のボタンを押してください（安全のため、メールで本人か確かめます）。'),
      el('div', { class: 'actions actions--tight' }, btn),
      status
    );
  }

  K.screens = K.screens || {};
  K.screens.login = { render };
  K.loginUI = { passwordCard };
})();
