// 設定 > 勤務パターン（開始・終了・休憩の長さ・表示名・色）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const BREAK_OPTIONS = [0, 15, 30, 45, 60, 75, 90, 120];

  // 開いているフォーム（null / 'new' / 勤務パターンID）
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

  function patternForm(pattern) {
    const isNew = !pattern;
    const colors = K.defaults.colors;
    const state = {
      color: pattern ? pattern.color : colors[0],
      // 表示名を自分で変えていなければ、時刻に合わせて自動で変える
      labelTouched: pattern ? pattern.label !== autoLabel(pattern.start, pattern.end) : false,
    };

    const startSelect = U.timeSelect({ id: 'pattern-start', value: pattern ? pattern.start : '09:00', onchange: updatePreview });
    const endSelect = U.timeSelect({ id: 'pattern-end', value: pattern ? pattern.end : '18:00', onchange: updatePreview });
    const breakSelect = el(
      'select',
      { id: 'pattern-break', class: 'field__input field__input--time', onchange: updatePreview },
      BREAK_OPTIONS.map((m) =>
        el('option', { value: String(m), selected: m === (pattern ? pattern.breakMinutes : 60) }, m === 0 ? 'なし' : `${m}分`)
      )
    );
    const labelInput = el('input', {
      id: 'pattern-label',
      class: 'field__input',
      type: 'text',
      maxlength: '12',
      value: pattern ? pattern.label : autoLabel('09:00', '18:00'),
      oninput: () => (state.labelTouched = true),
    });
    const preview = el('p', { class: 'field__note' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    function updatePreview() {
      if (!state.labelTouched) labelInput.value = autoLabel(startSelect.value, endSelect.value);
      const minutes = U.toMinutes(endSelect.value) - U.toMinutes(startSelect.value) - Number(breakSelect.value);
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
        start: startSelect.value,
        end: endSelect.value,
        breakMinutes: Number(breakSelect.value),
        label: labelInput.value,
        color: state.color,
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
      if (!window.confirm(`「${pattern.label}」を削除しますか？${note}`)) return;
      try {
        K.storage.deletePattern(pattern.id);
        K.app.toast('削除しました');
        closeForm();
      } catch (err) {
        showError(err.message);
      }
    }

    updatePreview();

    return el(
      'form',
      { class: 'card', novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, isNew ? '勤務パターンを追加' : `「${pattern.label}」を編集`),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'pattern-start' }, '勤務時間'),
        el('div', { class: 'time-range' }, startSelect, el('span', { class: 'time-range__sep' }, '〜'), endSelect)
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'pattern-break' }, '休憩の長さ'),
        breakSelect,
        preview,
        el('p', { class: 'field__note' }, '休憩の時刻は、シフト表で必要な日だけ個別に設定します（Step3）。')
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'pattern-label' }, '表示名（シフト表に出る短い名前）'),
        labelInput
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

  function patternRow(p) {
    const users = K.storage.getPatternUsers(p.id).filter((s) => s.active).length;
    return el(
      'li',
      null,
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
            `休憩 ${p.breakMinutes ? `${p.breakMinutes}分` : 'なし'}・実働 ${U.formatHours(workMinutes(p))}`
          )
        ),
        el('span', { class: 'pattern-row__users' }, `${users}人`),
        el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')
      )
    );
  }

  function render(container) {
    const editing = formTarget && formTarget !== 'new' ? K.storage.getPattern(formTarget) : null;
    if (formTarget === 'new' || (editing && !editing.deleted)) {
      container.append(patternForm(formTarget === 'new' ? null : editing));
      return;
    }

    const patterns = K.storage.getPatterns();
    container.append(
      el(
        'div',
        { class: 'toolbar' },
        el('p', { class: 'hint hint--inline' }, '右の人数は、このパターンを使える在籍中のスタッフ数です。'),
        el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => openForm('new') }, '＋ 追加')
      ),
      patterns.length
        ? el('ul', { class: 'list-card' }, patterns.map(patternRow))
        : el('p', { class: 'empty-row' }, '勤務パターンがありません。「＋ 追加」から登録してください。')
    );
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.patterns = { render };
})();
