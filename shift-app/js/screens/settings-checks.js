// 設定 > チェック（自動チェックの基準）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  function numberField(id, label, value, unit, { step = '1', note } = {}) {
    return el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', for: id }, label),
      el(
        'div',
        { class: 'num-with-unit' },
        el('input', { id, class: 'field__input field__input--num', type: 'number', inputmode: 'decimal', min: '0', step, value: String(value) }),
        el('span', null, unit)
      ),
      note ? el('p', { class: 'field__note' }, note) : null
    );
  }

  function switchField(id, label, checked, note) {
    return el(
      'div',
      { class: 'field' },
      el('label', { class: 'switch' }, el('input', { id, type: 'checkbox', checked }), el('span', { class: 'switch__track', 'aria-hidden': 'true' }), label),
      note ? el('p', { class: 'field__note' }, note) : null
    );
  }

  function render(container) {
    // 表示中の店舗のチェックの基準（店舗ごとに別々に持つ）
    const store = K.app.currentStore();
    const c = K.storage.getChecks(store.id);
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const val = (id) => container.querySelector(`#${id}`);

    function onSubmit(event) {
      event.preventDefault();
      try {
        K.storage.updateChecks(store.id, {
          maxConsecutiveDays: val('chk-consecutive').value,
          monthlyOffDays: val('chk-off').value,
          shortageMinSlots: val('chk-short-slots').value,
          hoursCheckEnabled: val('chk-hours').checked,
          dailyHoursLimit: val('chk-daily').value,
          weeklyHoursLimit: val('chk-weekly').value,
          countPaidLeaveAsOff: val('chk-paid').checked,
          closedDayAsOff: val('chk-closed').checked,
        });
        K.app.toast(`${store.name}の基準を保存しました`);
        K.app.rerender();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    container.append(
      el(
        'div',
        { class: 'toolbar toolbar--wrap' },
        el('span', { class: 'store-tag', style: { '--store-color': store.color } }, store.name),
        el('p', { class: 'hint hint--inline' }, `${store.name}専用の自動チェックの基準です。ほかの店舗は、画面上部で切り替えて設定します。`)
      ),
      el('p', { class: 'hint' }, 'アプリは知らせるだけで、シフトを自動で直すことはしません。'),
      el(
        'form',
        { class: 'card', novalidate: true, onsubmit: onSubmit },
        el('h2', { class: 'card__title' }, '人員'),
        numberField('chk-short-slots', '人員不足とする枠の数', c.shortageMinSlots, '枠以上', {
          note: '30分の枠がこの数以上不足した日に △ を付けます（1 なら、1枠でも不足で △）。',
        }),

        el('h2', { class: 'card__title card__title--section' }, '勤務日数'),
        numberField('chk-consecutive', '連勤の上限', c.maxConsecutiveDays, '日', { note: '終日社用の日も出勤として数えます。月をまたいでも数えます。' }),
        numberField('chk-off', '月の休日数の目安', c.monthlyOffDays, '日', { note: 'これより少ないときに知らせます。' }),
        switchField('chk-paid', '有給を休日数に数える', c.countPaidLeaveAsOff),
        switchField('chk-closed', '定休日を通常休として扱う', c.closedDayAsOff, '何も入力していない定休日を、通常休として数えます。'),

        el('h2', { class: 'card__title card__title--section' }, '労働時間'),
        switchField('chk-hours', '労働時間をチェックする', c.hoursCheckEnabled),
        numberField('chk-daily', '1日の実働時間の目安', c.dailyHoursLimit, '時間', { step: '0.5' }),
        numberField('chk-weekly', '1週の実働時間の目安', c.weeklyHoursLimit, '時間', {
          step: '0.5',
          note: '週は月曜〜日曜。実働＝勤務時間−休憩（休憩の時刻を設定した日はその時間、ない日は勤務パターンの休憩の長さ）。',
        }),

        errorBox,
        el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'btn btn--primary' }, '保存する'))
      )
    );
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.checks = { render };
})();
