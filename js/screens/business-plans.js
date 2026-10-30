// 日付を指定した社用予定（その日の一覧・追加・編集・削除）。シフト表のマスの入力シートと、1日の詳細の編集シートで使う
// 社用予定は勤務のデータとは別に保存する（businessTimes）。勤務時間・休日は変えない。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  function timeLabel(minutes) {
    return U.formatTime(U.fromMinutes(minutes));
  }

  function rangeLabel(r) {
    return `${timeLabel(r.start)}〜${timeLabel(r.end)}`;
  }

  // シフト表のマスに出す短い時刻（例：13:00〜15:00 → 13-15、13:30〜15:00 → 13:30-15）
  function shortTime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
  }

  function shortRange(r) {
    return `${shortTime(r.start)}-${shortTime(r.end)}`;
  }

  // その日の社用（取り消していないもの）を「社用 13:00〜15:00 外部講習」の形で
  function planText(b) {
    return `社用 ${rangeLabel(b)} ${K.calc.businessWhat(b)}`;
  }

  // day：K.calc.staffDay の結果（通常勤務の日）。onDone(message)：保存できたとき（呼んだ側で画面を作り直す）
  function section({ member, date, day, idPrefix = 'plan', onDone }) {
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
    let editingId = null;

    function run(action, message) {
      try {
        action();
        errorBox.hidden = true;
        onDone(message);
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    // 入力欄（追加と編集で同じものを使う）
    const preferStart = Math.min(Math.max(14 * 60, day.start), day.end - 30);
    const start = U.timeSelect({ id: `${idPrefix}-start`, value: U.fromMinutes(preferStart), from: day.start, to: day.end - 30 });
    const end = U.timeSelect({ id: `${idPrefix}-end`, value: U.fromMinutes(Math.min(preferStart + 120, day.end)), from: day.start + 30, to: day.end });
    const category = el(
      'select',
      { id: `${idPrefix}-category`, class: 'field__input' },
      el('option', { value: '' }, '社用内容を選ぶ'),
      Object.entries(K.storage.BUSINESS_CATEGORIES).map(([value, label]) => el('option', { value }, label))
    );
    const detail = el('input', {
      id: `${idPrefix}-detail`,
      class: 'field__input',
      type: 'text',
      maxlength: String(K.storage.MAX_BUSINESS_DETAIL),
      placeholder: '詳細（任意）例：カット講習',
    });
    const note = el('input', {
      id: `${idPrefix}-note`,
      class: 'field__input',
      type: 'text',
      maxlength: String(K.storage.MAX_BUSINESS_PLAN_NOTE),
      placeholder: '備考（任意）',
    });
    const formTitle = el('p', { class: 'plan-form__title' }, 'この日の社用予定を追加');
    const saveBtn = el('button', { type: 'button', class: 'btn btn--primary btn--small plan-form__save', onclick: save }, '追加する');
    const cancelBtn = el('button', { type: 'button', class: 'text-btn text-btn--small plan-form__cancel', hidden: true, onclick: stopEdit }, '編集をやめる');

    function save() {
      if (!category.value) {
        errorBox.textContent = '社用内容を選んでください。';
        errorBox.hidden = false;
        category.focus();
        return;
      }
      const fields = { start: start.value, end: end.value, category: category.value, detail: detail.value, note: note.value };
      if (editingId) {
        const id = editingId;
        run(() => K.storage.updateBusinessTime(id, fields), '社用予定を変更しました');
      } else {
        run(() => K.storage.addBusinessTime({ type: 'date', staffId: member.id, date, ...fields }), '社用予定を追加しました');
      }
    }

    function startEdit(b) {
      editingId = b.id;
      start.value = U.fromMinutes(b.start);
      end.value = U.fromMinutes(b.end);
      category.value = b.category || '';
      detail.value = b.detail || '';
      note.value = b.note || '';
      formTitle.textContent = `社用予定を編集（${rangeLabel(b)}）`;
      saveBtn.textContent = '変更を保存';
      cancelBtn.hidden = false;
      errorBox.hidden = true;
      category.focus({ preventScroll: true });
    }

    function stopEdit() {
      editingId = null;
      formTitle.textContent = 'この日の社用予定を追加';
      saveBtn.textContent = '追加する';
      cancelBtn.hidden = true;
      category.value = '';
      detail.value = '';
      note.value = '';
      errorBox.hidden = true;
    }

    const list = el(
      'ul',
      { class: 'detail-list plan-list' },
      day.business.length
        ? day.business.map((b) =>
            el(
              'li',
              { class: `detail-item plan-item${b.skipped ? ' is-skipped' : ''}`, 'data-plan': b.id },
              el('span', { class: 'detail-item__key tl-seg--business' }),
              el(
                'span',
                { class: 'detail-item__text' },
                el('span', { class: 'plan-item__time' }, rangeLabel(b)),
                el('span', { class: 'plan-item__what' }, K.calc.businessWhat(b)),
                b.source === 'weekly' ? el('span', { class: 'detail-item__badge' }, '毎週') : null,
                b.source === 'date' && b.note && (b.category || b.detail) ? el('span', { class: 'detail-item__note' }, b.note) : null,
                b.skipped ? el('span', { class: 'detail-item__note' }, 'この日は取り消し中') : null
              ),
              b.source === 'weekly'
                ? el(
                    'button',
                    {
                      type: 'button',
                      class: 'text-btn text-btn--small',
                      onclick: () =>
                        run(() => K.storage.setBusinessTimeSkip(b.id, date, !b.skipped), b.skipped ? '取り消しを戻しました' : 'この日だけ取り消しました'),
                    },
                    b.skipped ? '取り消しを戻す' : 'この日だけ取り消す'
                  )
                : el(
                    'span',
                    { class: 'plan-item__actions' },
                    el('button', { type: 'button', class: 'text-btn text-btn--small', 'aria-label': `社用予定 ${rangeLabel(b)} を編集`, onclick: () => startEdit(b) }, '編集'),
                    el(
                      'button',
                      {
                        type: 'button',
                        class: 'detail-item__remove',
                        'aria-label': `社用予定 ${rangeLabel(b)} を削除`,
                        onclick: () => {
                          if (!window.confirm(`${rangeLabel(b)} の社用予定（${K.calc.businessWhat(b)}）を削除します。よろしいですか？`)) return;
                          run(() => K.storage.deleteBusinessTime(b.id), '社用予定を削除しました');
                        },
                      },
                      '×'
                    )
                  )
            )
          )
        : el('li', { class: 'detail-item detail-item--empty' }, '社用予定はありません')
    );

    return el(
      'div',
      { class: 'plan-section' },
      el('p', { class: 'sheet__label' }, `社用予定（店舗を離れる時間・予約可能人数から除く）　勤務 ${rangeLabel(day)}`),
      list,
      el(
        'div',
        { class: 'plan-form' },
        formTitle,
        el('div', { class: 'time-range' }, start, el('span', { class: 'time-range__sep' }, '〜'), end),
        category,
        detail,
        note,
        el('div', { class: 'plan-form__actions' }, saveBtn, cancelBtn)
      ),
      el('p', { class: 'sheet__note' }, '勤務時間の中で、30分刻みで登録します。同じ日に複数登録できます（時間が重なるものは登録できません）。毎週決まった社用は「設定 > 毎週の社用」で登録します。'),
      errorBox
    );
  }

  K.businessUI = { section, planText, rangeLabel, shortRange };
})();
