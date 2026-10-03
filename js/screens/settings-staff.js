// 設定 > スタッフ（表示名・所属店舗・役割・肩書き・使える勤務パターン・在籍）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  // 開いているフォーム（null / 'new' / スタッフID）。表示する店舗は、ヘッダーで選んだ店舗
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

  // 1つだけ選べるボタンの並び（店舗・役割）
  // 選択肢が4つ以上（店舗が多いとき）は、スマホでも押しやすい選択メニューにする
  function choiceGroup({ label, options, value, onChange }) {
    if (options.length > 3) {
      return el(
        'select',
        { class: 'field__input', 'aria-label': label, onchange: (event) => onChange(event.currentTarget.value) },
        options.map(([key, text]) => el('option', { value: key, selected: key === value }, text))
      );
    }
    const buttons = options.map(([key, text]) =>
      el(
        'button',
        {
          type: 'button',
          class: `segment__btn${key === value ? ' is-selected' : ''}`,
          'aria-pressed': String(key === value),
          'data-key': key,
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
    return el('div', { class: 'segment segment--compact', role: 'group', 'aria-label': label }, buttons);
  }

  function staffForm(member) {
    const isNew = !member;
    const stores = K.storage.getStores();
    const state = {
      // 新しいスタッフは、表示中の店舗の所属にする
      storeId: member ? member.storeId : K.app.currentStore().id,
      role: member ? member.role : 'stylist',
      patternIds: new Set(member ? member.patternIds : []),
      // 曜日ごとのいつもの勤務：{ "0"〜"6": 勤務パターンID または "off" }
      weekly: { ...((member && member.weeklyPatterns) || {}) },
    };

    const nameInput = el('input', {
      id: 'staff-name',
      class: 'field__input',
      type: 'text',
      maxlength: '12',
      placeholder: '例：佐藤',
      value: member ? member.name : '',
    });
    const titleInput = el('input', {
      id: 'staff-title',
      class: 'field__input',
      type: 'text',
      maxlength: '10',
      placeholder: '例：代表、チーフ（なければ空欄）',
      value: member ? member.title : '',
    });
    const activeInput = el('input', { id: 'staff-active', type: 'checkbox', checked: member ? member.active : true });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    // 所属店舗で使える勤務パターン（全店舗共通＋その店舗専用）
    const available = () => K.storage.getPatterns({ storeId: state.storeId });

    const patternBox = el('div', { class: 'check-chips' });
    const weeklyBox = el('div', { class: 'weekly-list' });

    function renderPatterns() {
      const list = available();
      patternBox.replaceChildren(
        ...list.map((p) =>
          el(
            'label',
            { class: 'check-chip', style: { '--chip-color': p.color } },
            el('input', {
              type: 'checkbox',
              checked: state.patternIds.has(p.id),
              'data-pattern': p.id,
              onchange: (event) => {
                if (event.currentTarget.checked) state.patternIds.add(p.id);
                else state.patternIds.delete(p.id);
                renderWeekly();
              },
            }),
            el('span', { class: 'check-chip__label' }, p.label),
            el('span', { class: 'check-chip__sub' }, `${U.formatTime(p.start)}〜${U.formatTime(p.end)}`)
          )
        )
      );
    }

    // 曜日ごとのいつもの勤務（選べるのは「使える勤務パターン」で選んだものと「休」）
    function renderWeekly() {
      const chosen = available().filter((p) => state.patternIds.has(p.id));
      weeklyBox.replaceChildren(
        ...[1, 2, 3, 4, 5, 6, 0].map((w) => {
          const current = state.weekly[String(w)] || '';
          const select = el(
            'select',
            {
              class: 'field__input weekly-select',
              'aria-label': `${U.WEEKDAYS[w]}曜日のいつもの勤務`,
              'data-weekday': String(w),
              onchange: (event) => {
                if (event.currentTarget.value) state.weekly[String(w)] = event.currentTarget.value;
                else delete state.weekly[String(w)];
              },
            },
            el('option', { value: '', selected: !current }, '設定なし'),
            el('option', { value: 'off', selected: current === 'off' }, '休（通常休）'),
            chosen.map((p) => el('option', { value: p.id, selected: current === p.id }, `${p.label}（${U.formatTime(p.start)}〜${U.formatTime(p.end)}）`))
          );
          // 選べなくなったパターンが設定されていたら外す
          if (current && current !== 'off' && !chosen.some((p) => p.id === current)) delete state.weekly[String(w)];
          return el('label', { class: `weekly-row${w === 0 ? ' is-sun' : w === 6 ? ' is-sat' : ''}` }, el('span', { class: 'weekly-row__day' }, U.WEEKDAYS[w]), select);
        })
      );
    }

    function selectAllPatterns() {
      for (const p of available()) state.patternIds.add(p.id);
      renderPatterns();
      renderWeekly();
    }

    function onSubmit(event) {
      event.preventDefault();
      // 所属店舗で使えないパターン（店舗を変えた場合など）は外す
      const usable = new Set(available().map((p) => p.id));
      const fields = {
        name: nameInput.value,
        storeId: state.storeId,
        role: state.role,
        title: titleInput.value,
        patternIds: [...state.patternIds].filter((id) => usable.has(id)),
        weeklyPatterns: state.weekly,
        active: activeInput.checked,
      };
      try {
        if (isNew) {
          K.storage.addStaff(fields);
          K.app.toast(`${fields.name.trim()}さんを追加しました`);
        } else {
          K.storage.updateStaff(member.id, fields);
          K.app.toast('保存しました');
        }
        closeForm();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    function onDelete() {
      const message = `${member.name}さんを削除しますか？\n辞めた場合は削除せず「在籍中」のチェックを外すと、過去のシフトが残ります。`;
      if (!window.confirm(message)) return;
      try {
        K.storage.deleteStaff(member.id);
        K.app.toast('削除しました');
        closeForm();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    renderPatterns();
    renderWeekly();
    setTimeout(() => nameInput.focus(), 0);

    return el(
      'form',
      { class: 'card', novalidate: true, onsubmit: onSubmit },
      el('h2', { class: 'card__title' }, isNew ? 'スタッフを追加' : `${member.name}さんを編集`),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'staff-name' }, '表示名'), nameInput),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '所属店舗'),
        isNew
          ? el('span', { class: 'store-tag', style: { '--store-color': K.app.currentStore().color } }, K.app.currentStore().name)
          : choiceGroup({
              label: '所属店舗',
              options: stores.map((s) => [s.id, s.name]),
              value: state.storeId,
              onChange: (key) => {
                // 店舗を変えたら、その店舗で使える勤務パターンに表示を切り替える
                state.storeId = key;
                renderPatterns();
                renderWeekly();
              },
            }),
        el(
          'p',
          { class: 'field__note' },
          isNew
            ? 'ほかの店舗のスタッフは、画面上部で店舗を切り替えてから追加します。'
            : '店舗を移しても、これまでのシフトは元の店舗の記録として残ります。'
        )
      ),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '役割'),
        choiceGroup({
          label: '役割',
          options: Object.entries(U.ROLE_LABELS),
          value: state.role,
          onChange: (key) => (state.role = key),
        })
      ),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'staff-title' }, '肩書き（任意）'), titleInput),
      el(
        'div',
        { class: 'field' },
        el(
          'div',
          { class: 'field__label-row' },
          el('p', { class: 'field__label' }, '使える勤務パターン'),
          el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: selectAllPatterns }, 'すべて選ぶ')
        ),
        patternBox,
        el('p', { class: 'field__note' }, 'シフト表では、ここで選んだパターンだけが選択肢に出ます。所属店舗で使えるパターン（その店舗専用と全店舗共通）だけを表示しています。')
      ),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '曜日ごとのいつもの勤務'),
        weeklyBox,
        el(
          'p',
          { class: 'field__note' },
          'シフト表の「曜日の設定を反映」で、未入力の日にこの勤務を入れられます。入力シートでは「いつも」の印が付きます。'
        )
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'switch' }, activeInput, el('span', { class: 'switch__track', 'aria-hidden': 'true' }), '在籍中'),
        el('p', { class: 'field__note' }, '外すとシフト表に表示されなくなります（辞めた人・長期の休職など）。')
      ),
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? '追加する' : '保存する'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeForm }, 'キャンセル'),
        isNew ? null : el('button', { type: 'button', class: 'btn btn--danger', onclick: onDelete }, 'このスタッフを削除')
      )
    );
  }

  function move(id, direction) {
    try {
      K.storage.moveStaff(id, direction);
      K.app.rerender();
    } catch (err) {
      K.app.toast(err.message);
    }
  }

  function staffRow(member, index, count, { reorder }) {
    const patternLabels = member.patternIds
      .map((id) => K.storage.getPattern(id))
      .filter((p) => p && !p.deleted)
      .sort(K.storage.comparePatterns(member.storeId))
      .map((p) => p.label)
      .join(' / ');
    const hasWeekly = member.weeklyPatterns && Object.keys(member.weeklyPatterns).length > 0;

    return el(
      'li',
      { class: `staff-row${member.active ? '' : ' is-inactive'}` },
      el(
        'div',
        { class: 'staff-row__main' },
        el(
          'div',
          { class: 'staff-row__name' },
          el('span', null, member.name),
          el('span', { class: `role-badge role-badge--${member.role}` }, U.ROLE_SHORT[member.role]),
          member.title ? el('span', { class: 'title-badge' }, member.title) : null
        ),
        el('div', { class: 'staff-row__sub' }, `${patternLabels || '勤務パターン未設定'}${hasWeekly ? '・曜日の設定あり' : ''}`)
      ),
      reorder
        ? U.moveButtons({ name: `${member.name}さん`, index, count, onMove: (direction) => move(member.id, direction) })
        : null,
      el('button', { type: 'button', class: 'text-btn', onclick: () => openForm(member.id) }, '編集')
    );
  }

  function storeSection(store) {
    const members = K.storage.getStaff({ storeId: store.id });
    const st = members.filter((m) => m.role === 'stylist').length;
    const as = members.filter((m) => m.role === 'assistant').length;

    return el(
      'section',
      { class: 'store-group', style: { '--store-color': store.color } },
      el(
        'div',
        { class: 'store-group__head' },
        el('h2', { class: 'store-group__title' }, store.name),
        el('span', { class: 'store-group__count' }, `St ${st}・As ${as}・計 ${members.length}人`)
      ),
      members.length
        ? el('ul', { class: 'list-card' }, members.map((m, i) => staffRow(m, i, members.length, { reorder: true })))
        : el('p', { class: 'empty-row' }, 'まだ登録されていません')
    );
  }

  function render(container) {
    const editing = formTarget && formTarget !== 'new' ? K.storage.getStaffMember(formTarget) : null;

    if (formTarget === 'new' || editing) {
      container.append(formTarget === 'new' ? staffForm(null) : staffForm(editing));
      return;
    }

    // 表示するのは、ヘッダーで選んだ店舗のスタッフだけ
    const store = K.app.currentStore();
    const inactive = K.storage.getStaff({ storeId: store.id, includeInactive: true }).filter((m) => !m.active);

    const parts = [
      el(
        'div',
        { class: 'toolbar' },
        el('p', { class: 'hint hint--inline' }, `${store.name}のスタッフです。ほかの店舗は、画面上部で切り替えます。`),
        el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => openForm('new') }, `＋ ${store.name}に追加`)
      ),
      storeSection(store),
      inactive.length
        ? el(
            'section',
            { class: 'store-group store-group--inactive' },
            el('div', { class: 'store-group__head' }, el('h2', { class: 'store-group__title' }, '在籍していないスタッフ')),
            el(
              'ul',
              { class: 'list-card' },
              inactive.map((m, i) => staffRow(m, i, inactive.length, { reorder: false }))
            )
          )
        : null,
    ];
    container.append(...parts.filter(Boolean));
  }

  K.settingsViews = K.settingsViews || {};
  K.settingsViews.staff = { render };
})();
