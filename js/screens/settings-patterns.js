// 設定 > 勤務パターン（出勤・退勤・休憩の長さ・表示名・色・使う店舗）
// 出勤・退勤は30分単位が基本。「15分単位で選ぶ」に切り替えると15分単位でも選べる
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const BREAK_OPTIONS = [0, 15, 30, 45, 60, 75, 90, 120];

  // よく使う勤務時間（まとめて追加の候補）
  const PRESETS = [
    ['08:00', '17:00'],
    ['08:30', '17:30'],
    ['09:00', '18:00'],
    ['09:30', '18:30'],
    ['10:00', '19:00'],
    ['10:30', '19:30'],
    ['11:00', '20:00'],
  ];

  // 開いているフォーム（null / 'new' / 'presets' / 勤務パターンID）
  let formTarget = null;

  function openForm(target) {
    formTarget = target;
    K.app.rerender();
    window.scrollTo(0, 0);
  }

  function closeForm() {
    formTarget = null;
    K.app.rerender();
  }

  function workMinutes(p) {
    return U.toMinutes(p.end) - U.toMinutes(p.start) - p.breakMinutes;
  }

  function autoLabel(start, end) {
    return `${U.shortTime(start)}-${U.shortTime(end)}`;
  }

  function is30(time) {
    return U.toMinutes(time) % 30 === 0;
  }

  // 次に使う色（すでに使っている色を避ける）
  function nextColor() {
    const used = new Set(K.storage.getPatterns().map((p) => p.color));
    return K.defaults.colors.find((c) => !used.has(c)) || K.defaults.colors[0];
  }

  // 使う店舗の選択：この店舗専用 ／ 全店舗共通
  function scopeChoice(store, value, onChange) {
    const options = [
      [store.id, `${store.name}専用`],
      ['', '全店舗共通'],
    ];
    const buttons = options.map(([key, text]) =>
      el(
        'button',
        {
          type: 'button',
          class: `segment__btn${key === value ? ' is-selected' : ''}`,
          'aria-pressed': String(key === value),
          onclick: (event) => {
            for (const b of buttons) {
              const on = b === event.currentTarget;
              b.classList.toggle('is-selected', on);
              b.setAttribute('aria-pressed', String(on));
            }
            onChange(key);
          },
        },
        text
      )
    );
    return el('div', { class: 'segment segment--compact', role: 'group', 'aria-label': '使う店舗' }, buttons);
  }

  function patternForm(pattern, store) {
    const isNew = !pattern;
    const colors = K.defaults.colors;
    const state = {
      color: pattern ? pattern.color : nextColor(),
      storeId: pattern ? pattern.storeId || '' : store.id,
      start: pattern ? pattern.start : '09:00',
      end: pattern ? pattern.end : '18:00',
      // 15分単位の時刻を使っているパターンは、最初から15分単位で表示する
      step: pattern && (!is30(pattern.start) || !is30(pattern.end)) ? 15 : 30,
      // 表示名を自分で変えていなければ、時刻に合わせて自動で変える
      labelTouched: pattern ? pattern.label !== autoLabel(pattern.start, pattern.end) : false,
    };

    const timeBox = el('div', { class: 'time-range' });
    let startSelect;
    let endSelect;
    function renderTimes() {
      // 刻みを変えたときは、近い時刻に合わせる
      const snap = (t) => U.fromMinutes(Math.round(U.toMinutes(t) / state.step) * state.step);
      state.start = snap(state.start);
      state.end = snap(state.end);
      startSelect = U.timeSelect({ id: 'pattern-start', value: state.start, step: state.step, onchange: (e) => { state.start = e.currentTarget.value; updatePreview(); } });
      endSelect = U.timeSelect({ id: 'pattern-end', value: state.end, step: state.step, onchange: (e) => { state.end = e.currentTarget.value; updatePreview(); } });
      timeBox.replaceChildren(startSelect, el('span', { class: 'time-range__sep' }, '〜'), endSelect);
    }

    const stepInput = el('input', {
      id: 'pattern-step15',
      type: 'checkbox',
      checked: state.step === 15,
      onchange: (event) => {
        state.step = event.currentTarget.checked ? 15 : 30;
        renderTimes();
        updatePreview();
      },
    });

    const breakSelect = el(
      'select',
      { id: 'pattern-break', class: 'field__input field__input--time', onchange: () => updatePreview() },
      BREAK_OPTIONS.map((m) => el('option', { value: String(m), selected: m === (pattern ? pattern.breakMinutes : 60) }, m === 0 ? 'なし' : `${m}分`))
    );
    // 平日用／土日祝用、早番／遅番（どちらも空でよい）
    const optionSelect = (id, label, labels, value) =>
      el(
        'select',
        { id, class: 'field__input', 'aria-label': label },
        el('option', { value: '', selected: !value }, `${label}：指定なし`),
        Object.entries(labels).map(([key, text]) => el('option', { value: key, selected: key === value }, text))
      );
    const dayTypeSelect = optionSelect('pattern-day-type', '使う日', U.PATTERN_DAY_LABELS, pattern && pattern.dayType);
    const slotSelect = optionSelect('pattern-slot', '早番／遅番', U.PATTERN_SLOT_LABELS, pattern && pattern.slot);

    const labelInput = el('input', {
      id: 'pattern-label',
      class: 'field__input',
      type: 'text',
      maxlength: '12',
      value: pattern ? pattern.label : autoLabel(state.start, state.end),
      oninput: () => (state.labelTouched = true),
    });
    const preview = el('p', { class: 'field__note', id: 'pattern-preview' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    function updatePreview() {
      if (!state.labelTouched) labelInput.value = autoLabel(state.start, state.end);
      const minutes = U.toMinutes(state.end) - U.toMinutes(state.start) - Number(breakSelect.value);
      preview.textContent = minutes > 0 ? `実働 ${U.formatHours(minutes)}` : '終了時刻は開始時刻より後にしてください。';
    }

    const swatches = el(
      'div',
      { class: 'swatches', role: 'group', 'aria-label': '色' },
      (colors.includes(state.color) ? colors : [state.color, ...colors]).map((c, i) =>
        el('button', {
          type: 'button',
          class: `swatch${c === state.color ? ' is-selected' : ''}`,
          style: { '--swatch-color': c },
          'aria-label': `色${i + 1}`,
          'aria-pressed': String(c === state.color),
          onclick: (event) => {
            state.color = c;
            for (const b of swatches.children) {
              const on = b === event.currentTarget;
              b.classList.toggle('is-selected', on);
              b.setAttribute('aria-pressed', String(on));
            }
          },
        })
      )
    );

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }

    function onSubmit(event) {
      event.preventDefault();
      const fields = {
        start: state.start,
        end: state.end,
        breakMinutes: Number(breakSelect.value),
        label: labelInput.value,
        color: state.color,
        storeId: state.storeId,
        dayType: dayTypeSelect.value,
        slot: slotSelect.value,
      };
      try {
        if (isNew) {
          K.storage.addPattern(fields);
          K.app.toast('追加しました');
        } else {
          K.storage.updatePattern(pattern.id, fields);
          K.app.toast('保存しました');
        }
        closeForm();
      } catch (err) {
        showError(err.message);
      }
    }

    function onDelete() {
      const users = K.storage.getPatternUsers(pattern.id);
      const note = users.length ? `\n${users.map((s) => s.name).join('、')} さんの「使える勤務パターン」からも外れます。` : '';
      if (!window.confirm(`「${pattern.label}」を削除しますか？${note}\n（すでに入力したシフトは、そのまま残ります）`)) return;
      try {
        K.storage.deletePattern(pattern.id);
        K.app.toast('削除しました');
        closeForm();
      } catch (err) {
        showError(err.message);
      }
    }

    renderTimes();
    updatePreview();

    return el(
      'form',
      { class: 'card', novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, isNew ? '勤務パターンを追加' : `「${pattern.label}」を編集`),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'pattern-start' }, '出勤 〜 退勤'),
        timeBox,
        el('label', { class: 'check-line' }, stepInput, '15分単位で選ぶ（8:15、8:45 など）')
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'pattern-break' }, '休憩の長さ'),
        breakSelect,
        preview
      ),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'pattern-label' }, '表示名（シフト表に出る短い名前）'), labelInput),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '使う店舗'),
        scopeChoice(store, state.storeId, (key) => (state.storeId = key)),
        el('p', { class: 'field__note' }, '「全店舗共通」にすると、どの店舗のスタッフにも使えます。')
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'pattern-day-type' }, '使う日・早番／遅番（任意）'),
        el('div', { class: 'time-range' }, dayTypeSelect, slotSelect),
        el('p', { class: 'field__note' }, '例：平日の早番（9:00〜18:00）は「平日用」「早番」。AIシフト作成で、その日に使えるパターンを選ぶのに使います。')
      ),
      el('div', { class: 'field' }, el('p', { class: 'field__label' }, '色'), swatches),
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? '追加する' : '保存する'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeForm }, 'キャンセル'),
        isNew ? null : el('button', { type: 'button', class: 'btn btn--danger', onclick: onDelete }, 'この勤務パターンを削除')
      )
    );
  }

  // よく使う勤務時間から、まとめて追加する
  function presetForm(store) {
    const existing = K.storage.getPatterns({ storeId: store.id });
    const has = (start, end) => existing.some((p) => p.start === start && p.end === end);
    let scope = store.id;
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    const items = PRESETS.map(([start, end]) => {
      const done = has(start, end);
      const input = el('input', { type: 'checkbox', disabled: done, 'data-start': start, 'data-end': end });
      return el(
        'label',
        { class: `preset-item${done ? ' is-done' : ''}` },
        input,
        el('span', { class: 'preset-item__time' }, `${U.formatTime(start)}〜${U.formatTime(end)}`),
        el('span', { class: 'preset-item__note' }, done ? '登録済み' : '休憩60分・実働8時間')
      );
    });

    function onSubmit(event) {
      event.preventDefault();
      const chosen = items.map((label) => label.querySelector('input')).filter((i) => i.checked && !i.disabled);
      if (!chosen.length) {
        errorBox.textContent = '追加する勤務時間を選んでください。';
        errorBox.hidden = false;
        return;
      }
      try {
        for (const input of chosen) {
          const start = input.dataset.start;
          const end = input.dataset.end;
          K.storage.addPattern({ start, end, breakMinutes: 60, label: autoLabel(start, end), color: nextColor(), storeId: scope });
        }
        K.app.toast(`${chosen.length}件追加しました`);
        closeForm();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    return el(
      'form',
      { class: 'card', novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, 'よく使う勤務時間をまとめて追加'),
      el('div', { class: 'preset-list' }, items),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '使う店舗'),
        scopeChoice(store, scope, (key) => (scope = key))
      ),
      el('p', { class: 'field__note' }, '休憩の長さや表示名は、追加したあとで1つずつ変えられます。'),
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, '選んだ勤務時間を追加'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeForm }, 'キャンセル')
      )
    );
  }

  function movePattern(id, direction, store) {
    try {
      K.storage.movePattern(id, direction, store.id);
      K.app.rerender();
    } catch (err) {
      K.app.toast(err.message);
    }
  }

  function patternRow(p, store, index, count) {
    const users = K.storage.getPatternUsers(p.id).filter((s) => s.active && s.storeId === store.id).length;
    return el(
      'li',
      { class: 'reorder-row' },
      el(
        'button',
        { type: 'button', class: 'pattern-row', onclick: () => openForm(p.id) },
        el('span', { class: 'pattern-row__tag', style: { '--pattern-color': p.color } }, p.label),
        el(
          'span',
          { class: 'pattern-row__main' },
          el('span', { class: 'pattern-row__time' }, `${U.formatTime(p.start)} 〜 ${U.formatTime(p.end)}`),
          el(
            'span',
            { class: 'pattern-row__sub' },
            [
              U.PATTERN_DAY_LABELS[p.dayType],
              U.PATTERN_SLOT_LABELS[p.slot],
              `休憩 ${p.breakMinutes ? `${p.breakMinutes}分` : 'なし'}`,
              `実働 ${U.formatHours(workMinutes(p))}`,
            ]
              .filter(Boolean)
              .join('・')
          )
        ),
        el('span', { class: 'pattern-row__users' }, `${users}人`),
        el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')
      ),
      U.moveButtons({ name: p.label, index, count, onMove: (direction) => movePattern(p.id, direction, store) })
    );
  }

  function render(container) {
    const store = K.app.currentStore();
    const editing = formTarget && !['new', 'presets'].includes(formTarget) ? K.storage.getPattern(formTarget) : null;
    if (formTarget === 'presets') {
      container.append(presetForm(store));
      return;
    }
    if (formTarget === 'new' || (editing && !editing.deleted)) {
      container.append(patternForm(formTarget === 'new' ? null : editing, store));
      return;
    }

    const patterns = K.storage.getPatterns({ storeId: store.id });
    const own = patterns.filter((p) => p.storeId === store.id);
    const shared = patterns.filter((p) => !p.storeId);
    const group = (title, list) =>
      list.length
        ? el(
            'section',
            { class: 'store-group', style: { '--store-color': title.endsWith('専用') ? store.color : 'var(--border)' } },
            el('div', { class: 'store-group__head' }, el('h2', { class: 'store-group__title' }, title), el('span', { class: 'store-group__count' }, `${list.length}件`)),
            el('ul', { class: 'list-card' }, list.map((p, i) => patternRow(p, store, i, list.length)))
          )
        : null;

    const parts = [
      el(
        'div',
        { class: 'toolbar toolbar--wrap' },
        el('p', { class: 'hint hint--inline' }, `${store.name}で使える勤務パターンです。右の人数は、使える${store.name}の在籍スタッフ数です。「↑」「↓」で、${store.name}での並び順を変えられます（シフト入力の選択肢もこの順になります）。`)
      ),
      el(
        'div',
        { class: 'pattern-actions' },
        el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => openForm('new') }, '＋ 追加'),
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => openForm('presets') }, 'よく使う勤務時間からまとめて追加')
      ),
      patterns.length ? null : el('p', { class: 'empty-row' }, '勤務パターンがありません。「＋ 追加」から登録してください。'),
      el('div', { class: 'stack' }, [group(`${store.name}専用`, own), group('全店舗共通', shared)].filter(Boolean)),
    ];
    container.append(...parts.filter(Boolean));
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.patterns = { render };
})();
