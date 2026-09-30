// 設定 > 必要人数（店舗 × 平日／土日祝の時間帯ごとの人数）と、祝日の追加・取り消し
// 時間帯の入力部品（K.staffingUI）は、1日の詳細画面の「この日だけの必要人数」でも使う
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const DAY_TYPE_LABELS = { weekday: '平日', holiday: '土日祝' };

  // ---- 共通の部品 ----

  // "St 2人以上（上限4）・As 1人以上"
  function bandSummary(b) {
    const part = (label, min, max) => `${label} ${min}人以上${max !== null && max !== undefined ? `（上限${max}）` : ''}`;
    return `${part('St', b.stMin, b.stMax)}・${part('As', b.asMin, b.asMax)}`;
  }

  function numberInput(id, value, placeholder) {
    return el('input', {
      id,
      class: 'field__input field__input--num',
      type: 'number',
      inputmode: 'numeric',
      min: '0',
      max: '50',
      step: '1',
      placeholder: placeholder || '',
      value: value === null || value === undefined ? '' : String(value),
    });
  }

  // 1つの時間帯を入力する欄。read() で入力値を返す
  function bandFields(prefix, band) {
    const start = U.timeSelect({ id: `${prefix}-start`, value: band ? band.start : '10:00', from: 0, to: 23 * 60 + 30 });
    const end = U.timeSelect({ id: `${prefix}-end`, value: band ? band.end : '19:00', from: 30, to: 24 * 60 });
    const stMin = numberInput(`${prefix}-st-min`, band ? band.stMin : 1);
    const stMax = numberInput(`${prefix}-st-max`, band ? band.stMax : null, 'なし');
    const asMin = numberInput(`${prefix}-as-min`, band ? band.asMin : 1);
    const asMax = numberInput(`${prefix}-as-max`, band ? band.asMax : null, 'なし');

    const row = (label, minInput, maxInput) =>
      el(
        'div',
        { class: 'band-row' },
        el('span', { class: 'band-row__label' }, label),
        el('label', { class: 'band-row__field' }, '最低', minInput, '人'),
        el('label', { class: 'band-row__field' }, '上限', maxInput, '人')
      );

    const node = el(
      'div',
      { class: 'band-fields' },
      el('div', { class: 'time-range' }, start, el('span', { class: 'time-range__sep' }, '〜'), end),
      row('スタイリスト', stMin, stMax),
      row('アシスタント', asMin, asMax),
      el('p', { class: 'field__note' }, '上限は空欄なら「上限なし」（人員過多のチェックをしない）。')
    );

    return {
      node,
      read: () => ({
        start: start.value,
        end: end.value,
        stMin: stMin.value,
        stMax: stMax.value,
        asMin: asMin.value,
        asMax: asMax.value,
      }),
    };
  }

  function bandRow(b, onClick) {
    return el(
      'li',
      null,
      el(
        'button',
        { type: 'button', class: 'pattern-row', onclick: onClick },
        el('span', { class: 'band-time' }, `${U.formatTime(b.start)}〜${U.formatTime(b.end)}`),
        el('span', { class: 'pattern-row__main' }, el('span', { class: 'pattern-row__sub band-summary' }, bandSummary(b))),
        el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')
      )
    );
  }

  K.staffingUI = { DAY_TYPE_LABELS, bandSummary, bandFields, bandRow };

  // ---- 必要人数の設定 ----

  let dayType = 'weekday';
  let formTarget = null; // null / 'new' / 設定ID
  let year = Number(U.todayStr().slice(0, 4));

  function segment(label, options, value, onChange) {
    return el(
      'div',
      { class: 'segment segment--compact', role: 'group', 'aria-label': label },
      options.map(([key, text]) =>
        el(
          'button',
          {
            type: 'button',
            class: `segment__btn${key === value ? ' is-selected' : ''}`,
            'aria-pressed': String(key === value),
            onclick: () => {
              onChange(key);
              formTarget = null;
              K.app.rerender();
            },
          },
          text
        )
      )
    );
  }

  function ruleForm(store, rule) {
    const isNew = !rule;
    const fields = bandFields('rule', rule);
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    function close() {
      formTarget = null;
      K.app.rerender();
    }

    function fail(err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }

    function onSubmit(event) {
      event.preventDefault();
      try {
        if (isNew) K.storage.addStaffingRule({ storeId: store.id, dayType, ...fields.read() });
        else K.storage.updateStaffingRule(rule.id, fields.read());
        K.app.toast('保存しました');
        close();
      } catch (err) {
        fail(err);
      }
    }

    function onDelete() {
      if (!window.confirm('この時間帯の必要人数を削除しますか？')) return;
      try {
        K.storage.deleteStaffingRule(rule.id);
        K.app.toast('削除しました');
        close();
      } catch (err) {
        fail(err);
      }
    }

    return el(
      'form',
      { class: 'card', novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, `${store.name}・${DAY_TYPE_LABELS[dayType]}の必要人数を${isNew ? '追加' : '編集'}`),
      el('div', { class: 'field' }, fields.node),
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? '追加する' : '保存する'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, 'キャンセル'),
        isNew ? null : el('button', { type: 'button', class: 'btn btn--danger', onclick: onDelete }, 'この時間帯を削除')
      )
    );
  }

  // ---- 祝日 ----

  function holidaySection() {
    const builtIn = K.holidays.listYear(year);
    const edits = K.storage.getHolidayEdits().filter((h) => h.date.startsWith(`${year}-`));
    const removed = new Set(edits.filter((h) => h.action === 'remove').map((h) => h.date));
    const added = edits.filter((h) => h.action === 'add');

    const dateInput = el('input', { id: 'holiday-date', class: 'field__input', type: 'date', value: `${year}-12-31` });
    const nameInput = el('input', { id: 'holiday-name', class: 'field__input', type: 'text', maxlength: '12', placeholder: '例：年末年始' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    function run(action, message) {
      try {
        action();
        K.app.toast(message);
        K.app.rerender();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    return el(
      'section',
      { class: 'card holiday-card' },
      el(
        'div',
        { class: 'card__head' },
        el('h2', { class: 'card__title' }, '祝日'),
        el(
          'div',
          { class: 'month-nav' },
          el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の年', onclick: () => { year -= 1; K.app.rerender(); } }, '◀'),
          el('span', { class: 'holiday-year' }, `${year}年`),
          el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の年', onclick: () => { year += 1; K.app.rerender(); } }, '▶')
        )
      ),
      el('p', { class: 'hint' }, '祝日は自動で判定し、「土日祝」の必要人数を使います。祝日として扱わない日はチェックを外してください。'),
      el(
        'ul',
        { class: 'holiday-list' },
        builtIn.map((h) =>
          el(
            'li',
            { class: `holiday-item${removed.has(h.date) ? ' is-removed' : ''}` },
            el(
              'label',
              { class: 'holiday-item__label' },
              el('input', {
                type: 'checkbox',
                checked: !removed.has(h.date),
                onchange: (event) =>
                  run(
                    () => (event.currentTarget.checked ? K.storage.clearHolidayEdit(h.date) : K.storage.setHolidayEdit(h.date, 'remove')),
                    event.currentTarget.checked ? '祝日に戻しました' : '祝日として扱わないようにしました'
                  ),
              }),
              el('span', { class: 'holiday-item__date' }, U.formatDateLabel(h.date).slice(5)),
              el('span', null, h.name)
            )
          )
        )
      ),
      el('h3', { class: 'section-subtitle' }, '追加した休日（土日祝として扱う日）'),
      el(
        'ul',
        { class: 'holiday-list' },
        added.length
          ? added.map((h) =>
              el(
                'li',
                { class: 'holiday-item' },
                el('span', { class: 'holiday-item__date' }, U.formatDateLabel(h.date).slice(5)),
                el('span', { class: 'holiday-item__name' }, h.name),
                el(
                  'button',
                  {
                    type: 'button',
                    class: 'detail-item__remove',
                    'aria-label': `${h.name}を削除`,
                    onclick: () => run(() => K.storage.clearHolidayEdit(h.date), '削除しました'),
                  },
                  '×'
                )
              )
            )
          : el('li', { class: 'holiday-item muted' }, 'なし')
      ),
      el(
        'div',
        { class: 'detail-add' },
        dateInput,
        nameInput,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost btn--small',
            onclick: () => run(() => K.storage.setHolidayEdit(dateInput.value, 'add', nameInput.value), '追加しました'),
          },
          '休日を追加'
        )
      ),
      errorBox
    );
  }

  function render(container) {
    // 店舗は、ヘッダーで選んだ店舗
    const store = K.app.currentStore();

    const editing = formTarget && formTarget !== 'new' ? K.storage.getStaffingRules().find((r) => r.id === formTarget) : null;
    if (formTarget === 'new' || editing) {
      container.append(ruleForm(store, editing));
      return;
    }

    const rules = K.storage.getStaffingRules({ storeId: store.id, dayType });

    container.append(
      el(
        'div',
        { class: 'toolbar toolbar--wrap' },
        el('span', { class: 'store-tag', style: { '--store-color': store.color } }, store.name),
        segment('日の区分', Object.entries(DAY_TYPE_LABELS), dayType, (key) => (dayType = key))
      ),
      el('p', { class: 'hint' }, '30分ごとの予約可能人数が、ここで決めた人数と合っているかをチェックします。設定していない時間帯はチェックしません。'),
      rules.length
        ? el('ul', { class: 'list-card' }, rules.map((r) => bandRow(r, () => { formTarget = r.id; K.app.rerender(); })))
        : el('p', { class: 'empty-row' }, `${store.name}の${DAY_TYPE_LABELS[dayType]}の必要人数は、まだ設定されていません。`),
      el(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--block band-add', onclick: () => { formTarget = 'new'; K.app.rerender(); } },
        '＋ 時間帯を追加'
      ),
      holidaySection()
    );
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.staffing = { render };
})();
