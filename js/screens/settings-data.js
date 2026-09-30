// 設定 > データ（保存の状態・バックアップ・復元）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

  // 読み込んだファイル（合体か置き換えかを選ぶまで持っておく）と、直前の操作の結果
  let pending = null;
  let lastResult = null;

  function formatDateTime(iso) {
    if (!iso) return 'まだありません';
    const d = new Date(iso);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function showResult(ok, text) {
    lastResult = { ok, text };
    K.app.rerender();
  }

  function skippedNote(n) {
    return n > 0 ? `\n形式が正しくないため取り込めなかった記録：${n}件` : '';
  }

  // ---- 保存 ----

  async function saveBackup() {
    try {
      const file = K.storage.buildBackup();
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const result = await K.exporter.saveFiles([{ blob, name: `shift-backup-${U.todayStr()}.json` }]);
      if (result === 'cancelled') return;
      K.storage.markBackedUp();
      K.app.toast('バックアップを保存しました');
      showResult(true, 'バックアップを保存しました。Google Drive や iCloud Drive など、この端末以外の場所にも置いておくと安心です。');
    } catch (err) {
      showResult(false, `保存できませんでした（${err.message}）`);
    }
  }

  // ---- 読み込み ----

  function pickFile() {
    const input = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      try {
        if (file.size > MAX_FILE_SIZE) throw new Error('ファイルが大きすぎます。バックアップファイルか確認してください。');
        pending = K.backup.parseFile(await file.text());
        pending.fileName = file.name;
        lastResult = null;
        K.app.rerender();
      } catch (err) {
        pending = null;
        showResult(false, err.message);
      }
    });
    input.addEventListener('cancel', () => input.remove());
    document.body.append(input);
    input.click();
  }

  function applyMerge() {
    try {
      const stats = K.storage.mergeBackup(pending.data);
      const note = skippedNote(pending.skipped);
      pending = null;
      K.app.toast('合体しました');
      showResult(true, `合体しました（追加 ${stats.added}件・更新 ${stats.updated}件）${note}`);
    } catch (err) {
      showResult(false, err.message);
    }
  }

  function applyReplace() {
    const message =
      'この端末のデータを、ファイルの内容で丸ごと置き換えます。よろしいですか？\n' + '置き換える前の状態は「復元を取り消す」で戻せます。';
    if (!window.confirm(message)) return;
    try {
      K.storage.replaceWithBackup(pending.data);
      const note = skippedNote(pending.skipped);
      pending = null;
      K.app.toast('復元しました');
      showResult(true, `ファイルの内容で置き換えました。${note}`);
    } catch (err) {
      showResult(false, err.message);
    }
  }

  function undoRestore() {
    if (!window.confirm('復元する前の状態に戻しますか？')) return;
    try {
      K.storage.undoRestore();
      K.app.toast('元に戻しました');
      showResult(true, '復元する前の状態に戻しました。');
    } catch (err) {
      showResult(false, err.message);
    }
  }

  function pendingCard() {
    return el(
      'section',
      { class: 'card import-card' },
      el('h3', { class: 'card__title' }, 'このファイルを読み込みますか？'),
      el(
        'dl',
        { class: 'info-list' },
        el('dt', null, 'ファイル'),
        el('dd', null, pending.fileName),
        el('dt', null, '保存した日時'),
        el('dd', null, formatDateTime(pending.exportedAt)),
        el('dt', null, '中身'),
        el('dd', null, `スタッフ ${pending.counts.staff}人・シフト ${pending.counts.shifts}件`)
      ),
      el(
        'div',
        { class: 'export-actions' },
        el(
          'button',
          { type: 'button', class: 'btn btn--primary', onclick: applyMerge },
          '合体する（おすすめ）',
          el('span', { class: 'export-actions__sub' }, 'この端末とファイルの両方の入力を残します。同じ記録は、あとから変更したほうを残します')
        ),
        el(
          'button',
          { type: 'button', class: 'btn btn--ghost', onclick: applyReplace },
          '丸ごと置き換える',
          el('span', { class: 'export-actions__sub' }, 'この端末のデータを、ファイルの内容と同じにします')
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => {
              pending = null;
              K.app.rerender();
            },
          },
          'やめる'
        )
      )
    );
  }

  function render(container) {
    const status = K.storage.getBackupStatus();
    const restoreDate = K.storage.getRestoreBackupDate();

    let state;
    if (status.changedSinceBackup) state = el('p', { class: 'sync__state is-warning' }, '⚠ バックアップしていない変更があります');
    else if (status.lastBackupAt) state = el('p', { class: 'sync__state is-ok' }, '✓ 最新の状態をバックアップ済みです');
    else state = el('p', { class: 'sync__state' }, 'まだバックアップしていません');

    const persistText = el('dd', { id: 'storage-persist' }, '確認中…');
    const usageText = el('dd', { id: 'storage-usage' }, '確認中…');
    K.storage.getStorageInfo().then((info) => {
      persistText.textContent = info.persisted === true ? '有効（ブラウザが自動で消しにくい状態）' : info.persisted === false ? '無効（ブラウザの判断で消される場合があります）' : '不明';
      usageText.textContent = info.usage !== null && info.usage !== undefined ? `${Math.max(1, Math.round(info.usage / 1024))}KB 使用中` : '不明';
    });

    // 表示しない部分（null）を除いてから並べる
    const parts = [
      el('p', { class: 'hint' }, 'データは、このブラウザの中に保存されています。万一に備えて、ときどきバックアップを保存してください。'),
      pending ? pendingCard() : null,
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'バックアップ'),
        state,
        el('dl', { class: 'sync__status' }, el('dt', null, '最後のバックアップ'), el('dd', null, formatDateTime(status.lastBackupAt))),
        el(
          'div',
          { class: 'actions actions--tight' },
          el('button', { type: 'button', class: 'btn btn--primary', onclick: saveBackup }, 'バックアップを保存'),
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: pickFile }, 'バックアップを読み込む（復元・合体）'),
          restoreDate
            ? el('button', { type: 'button', class: 'btn btn--danger', onclick: undoRestore }, `復元を取り消す（${formatDateTime(restoreDate)}の状態に戻す）`)
            : null
        ),
        el(
          'p',
          { class: 'hint hint--left' },
          'ファイル名は shift-backup-日付.json です。Mac と iPhone で同じデータを使うときは、片方で保存したファイルを、もう片方で「合体する」で読み込みます。'
        ),
        lastResult ? el('p', { class: lastResult.ok ? 'sync__result' : 'form-error', role: 'status' }, lastResult.text) : null
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'このブラウザの保存の状態'),
        el(
          'dl',
          { class: 'info-list' },
          el('dt', null, '保存場所'),
          el('dd', null, 'このブラウザの中（Safari と Chrome では別々）'),
          el('dt', null, '消されにくい設定'),
          persistText,
          el('dt', null, '使用量'),
          usageText
        ),
        el(
          'p',
          { class: 'hint hint--left' },
          'ブラウザの「履歴とWebサイトデータを消去」をすると、データも消えます。iPhone ではホーム画面に追加して使うと消えにくくなります。'
        )
      ),
    ];
    container.append(...parts.filter(Boolean));
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.data = { render };
})();
