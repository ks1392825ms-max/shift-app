// 設定 > スタッフ（表示名・所属店舗・職種・肩書き・勤務条件・使える勤務パターン・ログイン用メール・在籍）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  // 開いているフォーム（null / 'new' / スタッフID）。表示する店舗は、ヘッダーで選んだ店舗
  let formTarget = null;
  // 開いている幹部のフォーム（null / 'new' / 'staff:スタッフID'（その人を幹部にする）/ 幹部のメールアドレス）
  let mgrTarget = null;
  // 「ログインする人」の表の絞り込み（all / mgr / staff / nomail）
  let loginFilter = 'all';

  // 携帯会社のメール（11/16〜）：パソコンなどから送られたメールを受け取らない設定のことが多く、届きにくい
  const CARRIER_DOMAINS = ['docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'ymobile.ne.jp', 'y-mobile.ne.jp', 'uqmobile.jp', 'disney.ne.jp', 'rakumail.jp'];
  function isCarrierMail(email) {
    const dom = String(email || '').trim().toLowerCase().split('@')[1] || '';
    return CARRIER_DOMAINS.some((d) => dom === d || dom.endsWith(`.${d}`));
  }
  const CARRIER_NOTE = '携帯会社のメールは、届かないことがあります。Android の人は Gmail、iPhone の人は iCloud メール（@icloud.com）がおすすめです。携帯会社のメールのままにするときは、本人に「firebaseapp.com」からのメールを受け取る設定をしてもらってください。';

  function openForm(target) {
    formTarget = target;
    K.app.rerender();
    window.scrollTo(0, 0);
  }

  function closeForm() {
    formTarget = null;
    K.app.rerender();
  }

  function openMgrForm(target) {
    mgrTarget = target;
    K.app.rerender();
    window.scrollTo(0, 0);
  }

  function closeMgrForm() {
    mgrTarget = null;
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
      // 職種（職種のない以前の記録は、役割を職種として扱う）
      position: member ? member.position || member.role : 'stylist',
      employment: (member && member.employment) || 'full',
      fixedOff: new Set((member && member.fixedOff && member.fixedOff.weekdays) || []),
      workWeekdays: new Set((member && member.workWeekdays) || []),
      // 同じ人（ほかの店舗の記録）
      samePerson: member ? (K.storage.getSamePersonStaff(member.id)[0] || {}).id || '' : '',
      patternIds: new Set(member ? member.patternIds : []),
      // 曜日ごとのいつもの勤務：{ "0"〜"6": 勤務パターンID または "off" }
      weekly: { ...((member && member.weeklyPatterns) || {}) },
    };

    const nameInput = el('input', {
      id: 'staff-name',
      class: 'field__input',
      type: 'text',
      maxlength: '12',
      placeholder: '例：山田',
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
    // 勤怠の集計表の上の欄（11/12〜）
    const employeeNoInput = el('input', { id: 'staff-employee-no', class: 'field__input', type: 'text', maxlength: '20', autocomplete: 'off', placeholder: '例：0012（なければ空欄）', value: member ? member.employeeNo || '' : '' });
    const fullNameInput = el('input', { id: 'staff-full-name', class: 'field__input', type: 'text', maxlength: '30', autocomplete: 'off', placeholder: '例：山田 太郎（空欄なら表示名）', value: member ? member.fullName || '' : '' });
    const activeInput = el('input', { id: 'staff-active', type: 'checkbox', checked: member ? member.active : true });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    // ---- 勤務条件 ----
    const isNewInput = el('input', { id: 'staff-is-new', type: 'checkbox', checked: Boolean(member && member.isNew) });
    const excludeInput = el('input', { id: 'staff-exclude', type: 'checkbox', checked: Boolean(member && member.excludeFromCount) });
    const weeklyOffSelect = el(
      'select',
      { id: 'staff-weekly-off', class: 'field__input field__input--short' },
      el('option', { value: '', selected: !(member && member.weeklyOffDays) }, 'なし'),
      [1, 2, 3].map((n) => el('option', { value: String(n), selected: Boolean(member && member.weeklyOffDays === n) }, `週${n}日`))
    );
    const monthlyOffInput = el('input', {
      id: 'staff-monthly-off',
      class: 'field__input field__input--num',
      type: 'number',
      inputmode: 'numeric',
      min: '0',
      max: '31',
      placeholder: '空欄',
      value: member && Number.isInteger(member.monthlyOffDays) ? String(member.monthlyOffDays) : '',
    });
    const holidayOffInput = el('input', { id: 'staff-holiday-off', type: 'checkbox', checked: Boolean(member && member.fixedOff && member.fixedOff.holidays) });
    // この人が休み・社用の日は出勤する相手（11/8〜。同じ店舗のほかのスタッフから選ぶ）
    const coverSelect = el(
      'select',
      { id: 'staff-cover-for', class: 'field__input' },
      el('option', { value: '' }, 'なし'),
      K.storage
        .getStaff({ storeId: (member && member.storeId) || K.app.currentStore().id })
        .filter((m) => !member || m.id !== member.id)
        .map((m) => el('option', { value: m.id, selected: Boolean(member && member.coverFor === m.id) }, `${m.name}さん`))
    );
    // パートの「休みの日数を決めない」（11/5〜）
    const offFlexInput = el('input', { id: 'staff-off-flex', type: 'checkbox', checked: Boolean(member && member.offFlex), onchange: () => updateOffFlex() });
    const offFlexField = el(
      'div',
      { class: 'field off-flex-field' },
      el('label', { class: 'check-line' }, offFlexInput, '休みの日数を決めない（人数が足りない日に入れる）'),
      el(
        'p',
        { class: 'field__note' },
        'パートの人だけ選べます。AIシフト作成では、ほかの人を入れたあと、必要人数が足りない日・時間帯にだけ入れ、入れない日は休みにします。働く曜日・固定休を登録していなくても対象になります。週休・月の休日数は使いません（休みの日数のチェックもしません）。固定休・希望休・有給は休みのままです。'
      )
    );
    const offDayFields = [];
    // パートで「決めない」を選んだときは、週休・月の休日数の欄を隠す
    function updateOffFlex() {
      const part = state.employment === 'part';
      offFlexField.hidden = !part;
      const flex = part && offFlexInput.checked;
      for (const f of offDayFields) f.hidden = flex;
    }
    const noteInput = el('textarea', { id: 'staff-note', class: 'field__input', rows: '2', maxlength: '100', placeholder: '例：日曜は店舗Bで勤務' }, member ? member.note || '' : '');
    const emailInput = el('input', {
      id: 'staff-email',
      class: 'field__input',
      type: 'email',
      inputmode: 'email',
      autocomplete: 'off',
      placeholder: '例：name@example.com（なければ空欄）',
      value: member ? member.email || '' : '',
      oninput: () => (carrierNote.hidden = !isCarrierMail(emailInput.value)),
    });
    const carrierNote = el('p', { class: 'field__note carrier-note', 'data-carrier-note': '', hidden: !isCarrierMail(member && member.email) }, CARRIER_NOTE);

    // 曜日のチェック（固定休・この店舗で働く曜日）
    function weekdayChips(name, set) {
      return el(
        'div',
        { class: 'weekday-chips', role: 'group', 'aria-label': name },
        [1, 2, 3, 4, 5, 6, 0].map((w) =>
          el(
            'label',
            { class: `weekday-chip${w === 0 ? ' is-sun' : w === 6 ? ' is-sat' : ''}` },
            el('input', {
              type: 'checkbox',
              checked: set.has(w),
              'data-weekday': String(w),
              'aria-label': `${name}：${U.WEEKDAYS[w]}`,
              onchange: (event) => (event.currentTarget.checked ? set.add(w) : set.delete(w)),
            }),
            el('span', null, U.WEEKDAYS[w])
          )
        )
      );
    }

    // 同じ人（ほかの店舗の在籍中の記録）
    function samePersonSelect() {
      const others = K.storage.getStaff().filter((s) => s.storeId !== state.storeId && (!member || s.id !== member.id));
      return el(
        'select',
        { id: 'staff-same-person', class: 'field__input', onchange: (event) => (state.samePerson = event.currentTarget.value) },
        el('option', { value: '', selected: !state.samePerson }, 'なし'),
        others.map((s) => {
          const store = K.storage.getStore(s.storeId);
          return el('option', { value: s.id, selected: s.id === state.samePerson }, `${s.name}（${store ? store.name : ''}）`);
        })
      );
    }

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
            chosen.map((p) => el('option', { value: p.id, selected: current === p.id }, `${p.label}（${U.formatTime(p.start)}〜${U.formatTime(p.end)}）`)),
            // 社用（終日・11/5〜）：その人の勤務パターンの時間で「社用」を入れる（店舗の人数には数えない）
            chosen.length
              ? el(
                  'optgroup',
                  { label: '社用（終日・人数に数えない）' },
                  chosen.map((p) => el('option', { value: `business:${p.id}`, selected: current === `business:${p.id}` }, `社用（${p.label} ${U.formatTime(p.start)}〜${U.formatTime(p.end)}）`))
                )
              : null
          );
          // 選べなくなったパターンが設定されていたら外す
          const pid = K.storage.weeklyBusinessPattern(current) || current;
          if (current && current !== 'off' && !chosen.some((p) => p.id === pid)) delete state.weekly[String(w)];
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
        position: state.position,
        title: titleInput.value,
        patternIds: [...state.patternIds].filter((id) => usable.has(id)),
        weeklyPatterns: state.weekly,
        active: activeInput.checked,
        employment: state.employment,
        isNew: isNewInput.checked,
        excludeFromCount: excludeInput.checked,
        weeklyOffDays: weeklyOffSelect.value,
        offFlex: state.employment === 'part' && offFlexInput.checked,
        coverFor: coverSelect.value,
        monthlyOffDays: monthlyOffInput.value.trim(),
        fixedOff: { weekdays: [...state.fixedOff], holidays: holidayOffInput.checked },
        workWeekdays: [...state.workWeekdays],
        note: noteInput.value,
        email: emailInput.value,
        employeeNo: employeeNoInput.value,
        fullName: fullNameInput.value,
      };
      try {
        let id;
        if (isNew) {
          id = K.storage.addStaff(fields).id;
          K.app.toast(`${fields.name.trim()}さんを追加しました`);
        } else {
          id = member.id;
          K.storage.updateStaff(member.id, fields);
          K.app.toast('保存しました');
        }
        // 同じ人のつながりが変わったときだけ保存する
        const before = (K.storage.getSamePersonStaff(id)[0] || {}).id || '';
        const linked = K.storage.getSamePersonStaff(id).some((s) => s.id === state.samePerson);
        if (state.samePerson ? !linked : before) {
          try {
            K.storage.setSamePerson(id, state.samePerson || null);
          } catch (err) {
            // スタッフ自体は保存できているので、フォームは閉じて知らせる
            K.app.toast(`保存しました。ただし「ほかの店舗の同じ人」は変えられませんでした（${err.message}）`);
          }
        }
        // 共有モード：iPad の名前の一覧・勤怠の集計表用の名簿も新しくする（11/12〜）
        if (K.storage.isCloud() && K.attendanceView && K.attendance && K.attendance.backend()) K.attendanceView.syncDirectories({ force: true });
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
    // フォームを作り終えてから、パートの「決めない」の表示を合わせる
    queueMicrotask(updateOffFlex);

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
        el('p', { class: 'field__label' }, '職種'),
        choiceGroup({
          label: '職種',
          options: Object.entries(U.POSITION_LABELS),
          value: state.position,
          onChange: (key) => (state.position = key),
        }),
        el('p', { class: 'field__note' }, 'シフト表の人数は、スタイリスト・ジュニアスタイリストを St、ジュニアスタイリスト兼アシスタント・アシスタントを As として数えます。')
      ),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'staff-title' }, '肩書き（任意）'), titleInput),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'staff-employee-no' }, '従業員番号（任意）'),
        employeeNoInput,
        el('label', { class: 'field__label', for: 'staff-full-name' }, '氏名（任意）'),
        fullNameInput,
        el('p', { class: 'field__note' }, '勤怠の集計表のいちばん上に出します。氏名が空欄のときは表示名を出します。')
      ),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '雇用形態'),
        choiceGroup({
          label: '雇用形態',
          options: Object.entries(U.EMPLOYMENT_LABELS),
          value: state.employment,
          onChange: (key) => {
            state.employment = key;
            updateOffFlex();
          },
        })
      ),
      offFlexField,
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'switch' }, isNewInput, el('span', { class: 'switch__track', 'aria-hidden': 'true' }), '新人'),
        el('label', { class: 'switch' }, excludeInput, el('span', { class: 'switch__track', 'aria-hidden': 'true' }), '戦力外'),
        el('p', { class: 'field__note' }, '「戦力外」の人はシフト表に表示しますが、St／As の人数・必要人数のチェック・AIの戦力計算には数えません。')
      ),
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
          'シフト表の「曜日の設定を反映」で、未入力の日にこの勤務を入れられます。入力シートでは「いつも」の印が付きます。「社用」を選ぶと、その曜日は社用（終日・店舗の人数に数えない）が入ります（AIシフト作成でも）。'
        )
      ),
      (offDayFields[0] = el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'staff-weekly-off' }, '週休'),
        weeklyOffSelect,
        el('p', { class: 'field__note' }, '例：週2休の人は「週2日」。自動チェックで、月曜〜日曜の休みが足りない週を知らせます。AIシフト作成でも使います。')
      )),
      (offDayFields[1] = el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'staff-monthly-off' }, '月の休日数'),
        el('div', { class: 'num-with-unit' }, monthlyOffInput, el('span', null, '日')),
        el(
          'p',
          { class: 'field__note' },
          '空欄なら、設定 > チェックの「月の休日数の目安」を使います。入れると、この人だけこの日数で確かめ、AIシフト作成もこの日数まで休みを入れます（定休日・固定休・希望休も1日として数えます。週休より優先）。'
        )
      )),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'staff-cover-for' }, 'この人が休み・社用の日は出勤する'),
        coverSelect,
        el('p', { class: 'field__note' }, '選んだ人が休み・社用の日には、AIシフト作成でこの人に休みを入れません（選んだ人の休みを決めるときも、この人の休みの日は避けます）。希望休・有給・固定休が重なったときは、結果のお知らせで知らせます。')
      ),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, '固定休（必ず休みの曜日）'),
        weekdayChips('固定休', state.fixedOff),
        el('label', { class: 'check-line' }, holidayOffInput, '祝日も休み'),
        el('p', { class: 'field__note' }, '例：月火休みの人は「月」「火」。土日祝休みのパートの人は「土」「日」と「祝日も休み」。')
      ),
      el(
        'div',
        { class: 'field' },
        el('p', { class: 'field__label' }, 'この店舗で働く曜日'),
        weekdayChips('この店舗で働く曜日', state.workWeekdays),
        el('p', { class: 'field__note' }, '複数の店舗で働く人の、この店舗の曜日です。選ばない（空）ときは、すべての曜日です。')
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'staff-same-person' }, 'ほかの店舗の同じ人'),
        samePersonSelect(),
        el('p', { class: 'field__note' }, '2つの店舗で働く人は、店舗ごとに登録してここでつなぎます。勤務条件は店舗ごとに持てます。同じ日に2店舗に入ると、自動チェックで知らせます。')
      ),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'staff-note' }, '備考（任意）'), noteInput),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'staff-email' }, 'ログイン用のメールアドレス（任意）'),
        emailInput,
        carrierNote,
        el('p', { class: 'field__note' }, '希望休・有給の申請で、本人がログインするためのメールアドレスです。共有モードでは Firebase にだけ保存し、公開するファイルには入りません。'),
        member && K.storage.isCloud() && K.storage.getManagers && K.storage.getManagers().some((g) => g.staffId === member.id)
          ? el('p', { class: 'field__note', 'data-staff-is-mgr': '' }, 'この人は幹部としても登録されています。メールアドレスを変えて保存すると、幹部の登録も新しいアドレスに移ります。')
          : null,
        isNew ? null : loginBox(member, emailInput)
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

  // ---- パスワード設定用のメールの送信結果（11/14〜） ----
  // ・結果は、画面とは別に、ここ（スタッフごと）に覚える。共有データが届いて画面が作り直されても、ここから描き直すので消えない
  // ・「受付済み」は、Firebase が送信を受け付けたという意味。相手に届いたかどうかは、アプリでは確かめられない（混同しない）
  // ・失敗したときは、Firebase のエラーコードと、どの手順（アカウントを作る／メールを送る）で失敗したかを残す
  // ・送りすぎを防ぐ：1回ごとに5秒あける・受付済みの人は10分は再送しない・送りすぎ（too-many-requests）のあとは60分、
  //   1日の上限（quota-exceeded）のあとはその日は止める（この端末で数える。Firebase 側の制限も別にある）
  // ・この端末の記録（直近20件）には、スタッフの番号・時刻・結果・コード・手順だけを残す（メールアドレス・名前・パスワードは残さない）
  const mailResults = new Map(); // スタッフID → { staffId, name, status: 'sending' | 'accepted' | 'failed', at, created, code, step, message, help }
  const MAIL_LOG_KEY = 'shift-app.staffMail.log';
  const MAIL_HOLD_KEY = 'shift-app.staffMail.hold';
  const MAIL_LOG_MAX = 20;
  const MAIL_GAP_MS = 5 * 1000; // 1回ごとの間隔
  const MAIL_RESEND_MS = 10 * 60 * 1000; // 受付済みの人に再送できるまで
  const MAIL_HOLD_MS = 60 * 60 * 1000; // 送りすぎのあと止める時間
  let lastMailAt = 0;
  let retrying = false;
  let mailLogOpen = false;

  // エラーの説明と対処（コードは Firebase のもの）
  function explainMailError(err) {
    const code = (err && err.code) || '';
    const ask = 'この画面からは直せません。エラーコードを控えて相談してください。';
    const table = [
      [/too-many-requests/, '続けて送ったため、Firebase が一時的に送信を止めています。', 'この端末からの送信を60分止めます。1時間ほどあけてから、送れなかった人に再送してください。'],
      [/quota-exceeded/, 'きょう送れるメールの数の上限に達しました。', 'この端末からの送信を、きょうは止めます。明日、送れなかった人に再送してください。'],
      [/network-request-failed/, 'Firebase につながりませんでした。', '電波や Wi-Fi の状態を確かめてから、再送してください。'],
      [/invalid-email|missing-email/, 'メールアドレスの形が正しくありません。', '全角の文字や空白が入っていないか確かめて、保存し直してから送ってください。'],
      [/admin-restricted-operation|operation-not-allowed/, 'Firebase の設定で、新しいアカウントを作れないようになっています。', ask],
      [/unauthorized-continue-uri|invalid-continue-uri|missing-continue-uri|unauthorized-domain/, 'メールのリンクの戻り先が、Firebase で許可されていません。', ask],
      [/user-disabled/, 'このスタッフのログイン用アカウントが、使えない状態になっています。', ask],
      [/internal-error/, 'Firebase の中でエラーが起きました。', '少し時間をおいてから再送してください。続くときは、エラーコードを控えて相談してください。'],
    ];
    const hit = table.find(([re]) => re.test(code));
    if (hit) return { message: hit[1], help: hit[2] };
    return { message: `送れませんでした${err && err.message ? `（${err.message}）` : ''}。`, help: '少し待ってから再送してください。続くときは、エラーコードを控えて相談してください。' };
  }

  // この端末の記録（調べるとき用）
  function readMailLog() {
    try {
      const list = JSON.parse(localStorage.getItem(MAIL_LOG_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }
  function logMailResult(r) {
    try {
      const list = readMailLog();
      list.push({ staffId: r.staffId, at: r.at, status: r.status, step: r.step || '', code: r.code || '', created: !!r.created });
      localStorage.setItem(MAIL_LOG_KEY, JSON.stringify(list.slice(-MAIL_LOG_MAX)));
    } catch (e) {
      /* 残せなくても、画面の表示はできる */
    }
  }

  // 送信を止めている間（送りすぎ・1日の上限のあと）
  function readHold() {
    try {
      const h = JSON.parse(localStorage.getItem(MAIL_HOLD_KEY) || 'null');
      return h && Number(h.until) > Date.now() ? h : null;
    } catch (e) {
      return null;
    }
  }
  function setHold(code) {
    let until;
    if (/quota-exceeded/.test(code)) {
      // 日本時間の次の0時まで
      const jst = new Date(Date.now() + 9 * 3600e3);
      until = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1) - 9 * 3600e3;
    } else {
      until = Date.now() + MAIL_HOLD_MS;
    }
    try {
      localStorage.setItem(MAIL_HOLD_KEY, JSON.stringify({ until, code }));
    } catch (e) {
      /* 残せなくても、Firebase 側の制限は働く */
    }
  }

  // その人に、最後に受け付けられた時刻（この画面で送った分と、この端末の記録から）
  function lastAcceptedAt(staffId) {
    const times = readMailLog().filter((x) => x.staffId === staffId && x.status === 'accepted').map((x) => Date.parse(x.at));
    const r = mailResults.get(staffId);
    if (r && r.status === 'accepted') times.push(Date.parse(r.at));
    return times.length ? Math.max(...times) : 0;
  }
  function lastSentAt() {
    const times = readMailLog().map((x) => Date.parse(x.at)).filter((t) => !Number.isNaN(t) && t <= Date.now());
    return Math.max(lastMailAt, ...times, 0);
  }
  const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / 60000));

  // 今送れるか：{ ok, reason, label（ボタンの文字・押せないとき）, resend（受付済みの人への再送） }
  function mailGate(staffId) {
    const r = mailResults.get(staffId);
    if (r && r.status === 'sending') return { ok: false, label: '送っています…', reason: '送っています。' };
    const hold = readHold();
    if (hold) {
      const m = minutesLeft(hold.until - Date.now());
      return { ok: false, label: `しばらく送れません（あと${m}分）`, reason: `Firebase の送信制限のため、この端末からの送信を止めています（あと${m}分）。` };
    }
    const acc = lastAcceptedAt(staffId);
    if (acc && Date.now() - acc < MAIL_RESEND_MS) {
      const m = minutesLeft(MAIL_RESEND_MS - (Date.now() - acc));
      return { ok: false, label: `受付済み（あと${m}分で再送できます）`, reason: `このスタッフへの送信は、Firebase が受け付けています。続けて送らないよう、あと${m}分は再送できません。` };
    }
    const gap = lastSentAt() + MAIL_GAP_MS - Date.now();
    if (gap > 0) return { ok: false, gapOnly: true, label: 'パスワード設定用のメールを送る', reason: `続けて送らないよう、あと${Math.ceil(gap / 1000)}秒待ってから押してください。` };
    return { ok: true, resend: Boolean(acc) };
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const MAIL_STATUS = { sending: '送信中…', accepted: '受付済み（到着は未確認）', failed: '送れませんでした' };
  const STEP_LABEL = { create: 'アカウントを作るところ', send: 'メールを送るところ' };

  // 1人分の結果の文
  function resultLines(r) {
    if (r.status === 'sending') return ['パスワード設定用のメールを送っています…'];
    if (r.status === 'accepted') {
      return [
        `Firebase が送信を受け付けました${r.created ? '（ログイン用のアカウントも作りました）' : ''}。`,
        '相手に届いたかどうかは、アプリでは確かめられません。届かないときは、迷惑メールのフォルダーや、携帯会社のメールの受信設定を見てもらってください。',
      ];
    }
    return [r.message, `対処：${r.help}`, `エラーコード：${r.code || 'なし'}${r.step ? `（${STEP_LABEL[r.step] || r.step}）` : ''}`];
  }

  // メールを送る相手：スタッフ（スタッフID）か、名簿にいない幹部（'mgr_'＋アドレスから作った短い番号。記録にアドレスを残さないため）
  function mgrKey(email) {
    let h = 5381;
    for (const c of String(email)) h = ((h * 33) ^ c.codePointAt(0)) >>> 0;
    return `mgr_${h.toString(16).padStart(8, '0')}`;
  }
  function mailTarget(id) {
    const m = K.storage.getStaffMember(id);
    if (m) return m;
    const g = K.storage.getManagers ? K.storage.getManagers().find((x) => !x.staffId && mgrKey(x.email) === id) : null;
    return g ? { id, name: g.name || '（名前が未登録の幹部）', email: g.email, active: true } : null;
  }

  // 送れなかった人（再送できる人）
  function failedTargets() {
    return [...mailResults.values()].filter((r) => r.status === 'failed').map((r) => mailTarget(r.staffId)).filter((m) => m && m.email && m.active !== false);
  }

  // 画面上部のお知らせ欄（スタッフごとに1行。新しい順）
  function mailNotice() {
    const list = [...mailResults.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (!list.length) return null;
    const hold = readHold();
    const failed = failedTargets();
    return el(
      'section',
      { class: 'mail-notice', 'data-mail-notice': '', 'aria-live': 'polite' },
      el(
        'div',
        { class: 'mail-notice__head' },
        el('h2', { class: 'mail-notice__title' }, 'パスワード設定用のメールの送信結果'),
        list.some((r) => r.status !== 'sending') && !retrying ? el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: clearMailResults }, '閉じる') : null
      ),
      hold ? el('p', { class: 'mail-notice__hold', role: 'alert' }, `Firebase の送信制限のため、この端末からの送信を止めています（${timeLabel(new Date(Number(hold.until)).toISOString())} まで）。`) : null,
      el(
        'ul',
        { class: 'mail-notice__list' },
        list.map((r) =>
          el(
            'li',
            { class: `mail-notice__item is-${r.status}`, 'data-staff': r.staffId },
            el('p', { class: 'mail-notice__who' }, el('b', null, `${r.name}さん`), el('span', { class: 'mail-notice__badge' }, MAIL_STATUS[r.status]), el('span', { class: 'mail-notice__time' }, timeLabel(r.at))),
            resultLines(r).map((t) => el('p', { class: 'mail-notice__text' }, t))
          )
        )
      ),
      failed.length || retrying
        ? el(
            'div',
            { class: 'mail-notice__retry' },
            el('button', { type: 'button', class: 'btn btn--primary btn--small', 'data-mail-retry': '', disabled: retrying || Boolean(hold), onclick: retryFailed }, retrying ? '再送しています…' : `送れなかった人に再送（${failed.length}人）`),
            el('p', { class: 'mail-notice__text' }, '送れなかった人だけに、1人ずつ5秒あけて送ります。受付済みの人には送りません。')
          )
        : null
    );
  }

  // この端末の送信の記録（直近20件・新しい順）。名前は、見るときに名簿から引く（記録には残さない）
  function mailLogView() {
    const list = readMailLog().slice().reverse();
    if (!list.length) return null;
    return el(
      'details',
      { class: 'mail-log', open: mailLogOpen, ontoggle: (ev) => (mailLogOpen = ev.currentTarget.open) },
      el('summary', null, `送信の記録（この端末・直近${MAIL_LOG_MAX}件）`),
      el(
        'ul',
        { class: 'mail-log__list' },
        list.map((x) => {
          const m = mailTarget(x.staffId);
          return el(
            'li',
            { class: `mail-log__item is-${x.status}`, 'data-staff': x.staffId },
            el('span', { class: 'mail-log__time' }, timeLabel(x.at)),
            el('b', null, m ? m.name : '（今はいない人）'),
            el('span', null, MAIL_STATUS[x.status] || x.status),
            x.code ? el('span', { class: 'mail-log__code' }, `${x.code}${x.step ? `（${STEP_LABEL[x.step] || x.step}）` : ''}`) : null
          );
        })
      ),
      el('p', { class: 'mail-notice__text' }, '記録には、スタッフの番号・時刻・結果・エラーコードだけを残しています（メールアドレスは残しません）。')
    );
  }

  function mailPanel() {
    return [mailNotice(), mailLogView()].filter(Boolean);
  }

  function clearMailResults() {
    for (const [id, r] of mailResults) if (r.status !== 'sending') mailResults.delete(id);
    refreshMail();
  }

  // 画面を作り直さずに、お知らせ欄・ボタン・スタッフの欄だけを今の結果に合わせる（入力途中の内容を消さないため）
  function refreshMail() {
    const slot = document.querySelector('[data-mail-slot]');
    if (slot) slot.replaceChildren(...mailPanel());
    document.querySelectorAll('[data-mail-btn]').forEach((btn) => paintMailButton(btn, btn.getAttribute('data-mail-btn')));
    document.querySelectorAll('[data-mail-status]').forEach((p) => paintMailStatus(p, p.getAttribute('data-mail-status')));
    // 「ログインする人」の表の、送信の結果の欄も新しくする（表はフォームを開いていないときだけ出ている）
    if (document.querySelector('[data-managers]')) K.app.rerender();
  }
  function paintMailButton(btn, staffId) {
    const g = mailGate(staffId);
    const blocked = !g.ok && !g.gapOnly;
    btn.disabled = blocked;
    const idle = btn.hasAttribute('data-mail-compact') ? 'メールを送る' : 'パスワード設定用のメールを送る';
    btn.textContent = blocked ? g.label : idle;
  }
  function paintMailStatus(p, staffId) {
    const r = mailResults.get(staffId);
    p.textContent = r ? `${MAIL_STATUS[r.status]}（${timeLabel(r.at)}）。くわしくは、画面上部のお知らせを見てください。` : '';
  }
  // 「あと◯分」の表示を進める（スタッフの画面を開いているときだけ）
  setInterval(() => {
    if (document.querySelector('[data-mail-btn], [data-mail-notice]')) refreshMail();
  }, 30 * 1000);

  // 送る（成功・失敗とも、スタッフごとの結果に残す）。送る前に mailGate で確かめておくこと
  async function sendStaffMail(backend, member) {
    const cur = mailResults.get(member.id);
    if (cur && cur.status === 'sending') return;
    const base = { staffId: member.id, name: member.name };
    lastMailAt = Date.now();
    mailResults.set(member.id, { ...base, status: 'sending', at: new Date(Date.now()).toISOString() });
    refreshMail();
    let result;
    try {
      // 11/13〜 まだアカウントがない人は、先にアカウントを作ってから送る（パスワード再設定メールは、アカウントがないと届かないため）
      let created = false;
      if (backend.inviteStaff) created = Boolean(((await backend.inviteStaff(member.email)) || {}).created);
      else await (backend.sendPasswordReset ? backend.sendPasswordReset(member.email) : backend.sendStaffLoginLink(member.email));
      result = { ...base, status: 'accepted', at: new Date(Date.now()).toISOString(), created };
      K.app.toast(`${member.name}さんへの送信を、Firebase が受け付けました（到着は未確認）`, 3500);
    } catch (err) {
      const why = explainMailError(err);
      result = { ...base, status: 'failed', at: new Date(Date.now()).toISOString(), code: (err && err.code) || '', step: (err && err.step) || '', message: why.message, help: why.help };
      if (/too-many-requests|quota-exceeded/.test(result.code)) setHold(result.code);
      console.warn('[スタッフへのメール] 失敗', { staffId: member.id, code: result.code, step: result.step });
      K.app.toast(`${member.name}さんに送れませんでした。画面上部のお知らせを見てください`, 3500);
    }
    mailResults.set(member.id, result);
    logMailResult(result);
    refreshMail();
    return result;
  }

  // 送れなかった人だけに、1人ずつ間をあけて再送する
  async function retryFailed() {
    if (retrying) return;
    const backend = K.storage.isCloud() && K.app.cloudBackend ? K.app.cloudBackend() : null;
    const targets = failedTargets();
    if (!backend || !targets.length || readHold()) return;
    if (!window.confirm(`送れなかった ${targets.length}人に、パスワード設定用のメールを再送しますか？\n1人ずつ5秒あけて送ります。受付済みの人には送りません。`)) return;
    retrying = true;
    refreshMail();
    try {
      for (const m of targets) {
        // 前の送信から5秒あける（止まっている間・受付済みになった人は飛ばす）
        for (;;) {
          const wait = lastSentAt() + MAIL_GAP_MS - Date.now();
          if (wait <= 0) break;
          await new Promise((res) => setTimeout(res, Math.min(wait, 250)));
        }
        if (readHold()) break;
        const r = mailResults.get(m.id);
        if (!r || r.status !== 'failed') continue;
        await sendStaffMail(backend, m);
      }
    } finally {
      retrying = false;
      refreshMail();
    }
  }

  // スタッフのログインの案内（共有モードで、ログイン用メールを保存済みのときだけ）
  // ・ログイン用のURL：開くとすぐにログイン画面になる（LINE などでスタッフに送る）
  // ・パスワード設定用のメールを送る：保存済みのメールアドレスに、Firebase からパスワード再設定メールを送る（開くと、新しいパスワードを決める画面）
  //   11/13〜 まだ一度もログインしたことがない人は、先にログイン用のアカウントを作ってから送る（cloud.js の inviteStaff）
  function loginBox(member, emailInput) {
    const backend = K.storage.isCloud() && K.app.cloudBackend ? K.app.cloudBackend() : null;
    if (!backend || !member || !member.email || member.active === false) return null;
    const url = backend.loginEntryUrl ? backend.loginEntryUrl() : '';
    const status = el('p', { class: 'field__note staff-login__status', role: 'status' });
    const mailStatus = el('p', { class: 'field__note staff-login__status', 'data-mail-status': member.id });
    paintMailStatus(mailStatus, member.id);

    async function copyUrl() {
      try {
        await navigator.clipboard.writeText(url);
        status.textContent = 'ログイン用のURLをコピーしました。LINE などでスタッフに送ってください。';
      } catch (err) {
        status.textContent = 'コピーできませんでした。URLを長押し（右クリック）してコピーしてください。';
      }
    }

    function sendMail() {
      const gate = mailGate(member.id);
      if (!gate.ok) {
        status.textContent = gate.reason;
        return;
      }
      // 入力欄を書き換えて、まだ保存していないときは送らない（保存済みのアドレスにだけ送る）
      if (emailInput.value.trim().toLowerCase() !== member.email) {
        status.textContent = 'メールアドレスが変わっています。先に「保存する」を押してから送ってください。';
        return;
      }
      const ask = gate.resend
        ? `${member.name}さんへの送信は、前に Firebase が受け付けています。\n先に、迷惑メールのフォルダーや受信設定を見てもらいましたか？\nもう一度送りますか？`
        : `${member.name}さんの登録メールに、パスワード設定用のメールを送りますか？\nスタッフがメールのリンクを開くと、新しいパスワードを決める画面になります。`;
      if (!window.confirm(ask)) return;
      status.textContent = '';
      sendStaffMail(backend, member);
    }

    let mailBtn = null;
    if (backend.sendPasswordReset || backend.sendStaffLoginLink) {
      mailBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--small', 'data-mail-btn': member.id, onclick: sendMail }, 'パスワード設定用のメールを送る');
      paintMailButton(mailBtn, member.id);
    }

    return el(
      'div',
      { class: 'staff-login' },
      url
        ? el(
            'p',
            { class: 'field__note' },
            'ログイン用のURL（開くとすぐにログイン画面になります）：',
            el('span', { class: 'staff-login__url' }, url)
          )
        : null,
      el('div', { class: 'actions' }, url ? el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: copyUrl }, 'URLをコピー') : null, mailBtn),
      mailStatus,
      status
    );
  }

  // ---- 幹部（11/15〜） ----
  // 幹部の登録（managers）も、この画面で決める。スタッフの名簿の人とつなぐと、名簿でメールアドレスを変えたときに、幹部の登録も一緒に移る。
  // 一覧ではメールアドレスの一部を伏せる（全部見えるのは編集画面だけ。この画面は管理者だけが開ける）
  function maskEmail(email) {
    const [local, dom] = String(email).split('@');
    return `${local.slice(0, 1)}***@${dom || ''}`;
  }

  function storeNames(ids) {
    return ids.map((id) => (K.storage.getStore(id) || {}).name).filter(Boolean).join('・') || '（店舗なし）';
  }

  // 幹部にメールを送る（名簿の人はスタッフと同じ番号で、名簿にいない人は幹部の番号で、結果を残す）
  function mgrMailMember(g) {
    if (g.staffId) return K.storage.getStaffMember(g.staffId);
    return { id: mgrKey(g.email), name: g.name || '（名前が未登録の幹部）', email: g.email, active: true };
  }

  function managerMailButton(g, compact) {
    const backend = K.storage.isCloud() && K.app.cloudBackend ? K.app.cloudBackend() : null;
    if (!backend || !(backend.inviteStaff || backend.sendPasswordReset || backend.sendStaffLoginLink)) return null;
    const member = mgrMailMember(g);
    if (!member || !member.email) return null;
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--small',
        'data-mail-btn': member.id,
        onclick: () => {
          const gate = mailGate(member.id);
          if (!gate.ok) return K.app.toast(gate.reason, 3500);
          const ask = gate.resend
            ? `${member.name}さんへの送信は、前に Firebase が受け付けています。\n先に、迷惑メールのフォルダーや受信設定を見てもらいましたか？\nもう一度送りますか？`
            : `${member.name}さんの登録メールに、パスワード設定用のメールを送りますか？\nメールのリンクを開くと、新しいパスワードを決める画面になります。`;
          if (!window.confirm(ask)) return;
          sendStaffMail(backend, member);
        },
      },
      compact ? 'メールを送る' : 'パスワード設定用のメールを送る'
    );
    if (compact) btn.setAttribute('data-mail-compact', '');
    paintMailButton(btn, member.id);
    return btn;
  }

  // 最後の送信の結果（この画面の結果と、この端末の記録から）
  function lastMail(id) {
    const r = mailResults.get(id);
    if (r) return r;
    const log = readMailLog().filter((x) => x.staffId === id);
    return log.length ? log[log.length - 1] : null;
  }
  const MAIL_SHORT = { sending: '送信中…', accepted: '受付済み', failed: '送れなかった' };

  // ---- はじめかたの案内（11/16〜）：1人ずつの案内の文をコピーして、LINE などで本人に送る・アプリの URL の QR コード ----
  // 文には、その人の登録アドレスが全部入る（管理者の画面だけで作る。本人にだけ送る）
  const INVITE_QR = 'icons/login-qr.svg'; // https://ks1392825ms-max.github.io/shift-app/?login の QR（macOS の CoreImage で作成・読み取りで確認済み）
  const SENDER = 'noreply@r-r-m-0000.firebaseapp.com';
  function loginUrl() {
    const b = K.app.cloudBackend ? K.app.cloudBackend() : null;
    return (b && b.loginEntryUrl && b.loginEntryUrl()) || 'https://ks1392825ms-max.github.io/shift-app/?login';
  }
  function inviteText(r) {
    const storeName = (id) => (K.storage.getStore(id) || {}).name || '';
    const who = [r.staff ? `${storeName(r.staff.storeId)}・スタッフ` : null, r.mgr ? `幹部（担当：${storeNames(r.mgr.storeIds)}）` : null].filter(Boolean).join('／');
    return [
      '【RENASCOR SHIFT のはじめかた】',
      `${r.name || ''}さん（${who}）`,
      '',
      ...(isCarrierMail(r.email)
        ? ['※ 登録したアドレスは携帯会社のメールです。先に、メールの設定で「firebaseapp.com」からのメールを受け取れるようにしてください（「受信リスト設定」「許可するメール」などの名前です）。', '']
        : []),
      '① 下のURLを開いて、ホーム画面に追加してください',
      loginUrl(),
      '',
      `② 「${SENDER}」から届くメールを開いて、`,
      '   1時間以内にリンクを押し、パスワードを決めてください',
      `   （登録したアドレス：${r.email}）`,
      '   メールが見つからないときは、迷惑メールのフォルダーを見てください。',
      '   リンクが切れたときは、ログイン画面の',
      '   「初めての方・パスワードを忘れた方」から送り直せます',
      '',
      '③ アプリで、メールアドレスと決めたパスワードでログインします',
      '',
      '※ メールが届きにくいときは、Android の人は Gmail、iPhone の人は iCloud メール（@icloud.com）で登録し直すと届きやすいです。管理者に伝えてください。',
    ].join('\n');
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 古いブラウザ：見えない入力欄に入れてコピー
      const ta = el('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } }, text);
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }
  async function copyInvite(r, memberId) {
    const ok = await copyText(inviteText(r));
    if (!ok) return K.app.toast('コピーできませんでした。もう一度押してください', 3500);
    const sent = lastMail(memberId);
    K.app.toast(sent && sent.status === 'accepted' ? `${r.name}さんの案内をコピーしました。LINE などで本人に送ってください` : `${r.name}さんの案内をコピーしました。先に「メールを送る」を押してください（②のメールは、そのときに届きます）`, 4500);
  }
  function showQr() {
    const close = () => layer.remove();
    const layer = el(
      'div',
      { class: 'invite-qr', 'data-invite-qr': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'アプリのQRコード', onclick: (ev) => { if (ev.target === layer) close(); } },
      el(
        'div',
        { class: 'invite-qr__box' },
        el('h3', null, 'アプリのQRコード'),
        el('img', { src: INVITE_QR, alt: 'アプリのログイン画面のQRコード', width: '240', height: '240' }),
        el('p', { class: 'invite-qr__url' }, loginUrl()),
        el('p', { class: 'field__note' }, 'スマホのカメラで読み取ると、アプリのログイン画面が開きます。開いたら「ホーム画面に追加」してもらってください。'),
        el('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: close }, '閉じる')
      )
    );
    document.body.append(layer);
  }

  // 「ログインする人」：幹部とスタッフを1つの表にまとめる（全店舗）。
  // 1行＝1人。幹部でスタッフの人は1行に「幹部」「スタッフ」の両方の札。名簿にいない幹部も入れる
  function loginPeople() {
    const stores = K.storage.getStores();
    const storeRank = (id) => {
      const i = stores.findIndex((x) => x.id === id);
      return i < 0 ? 99 : i;
    };
    const managers = K.storage.getManagers ? K.storage.getManagers() : [];
    const rows = [];
    for (const m of K.storage.getStaff()) {
      const g = managers.find((x) => x.staffId === m.id) || null;
      rows.push({ key: m.id, name: m.name, staff: m, mgr: g, storeId: m.storeId, email: m.email || '' });
    }
    for (const g of managers.filter((x) => !x.staffId)) rows.push({ key: mgrKey(g.email), name: g.name, staff: null, mgr: g, storeId: g.storeIds[0], email: g.email });
    return rows.sort((a, b) => Number(!a.mgr) - Number(!b.mgr) || storeRank(a.storeId) - storeRank(b.storeId) || (a.staff && b.staff ? a.staff.order - b.staff.order : 0));
  }

  // 店舗ごとの一覧：店舗のカードに、幹部（担当）とスタッフ（所属）の名前を並べる。名前を押すと編集
  function storeBoard(all) {
    const chip = (r, kind) =>
      el(
        'button',
        {
          type: 'button',
          class: `sb-chip is-${kind}${r.email ? '' : ' is-nomail'}`,
          'data-board-chip': r.key,
          title: r.email ? '' : 'メールアドレスが未登録です',
          onclick: () => (kind === 'mgr' && !r.staff ? openMgrForm(r.mgr.email) : kind === 'mgr' ? openMgrForm(r.mgr.email) : openForm(r.staff.id)),
        },
        r.name || '名前未登録',
        r.email ? null : el('span', { class: 'sb-chip__warn', 'aria-label': 'メール未登録' }, '!')
      );
    return el(
      'div',
      { class: 'sb', 'data-store-board': '' },
      K.storage.getStores().map((st) => {
        const mgrs = all.filter((r) => r.mgr && r.mgr.storeIds.includes(st.id));
        const staff = all.filter((r) => r.staff && r.staff.storeId === st.id);
        return el(
          'section',
          { class: 'sb-store', style: { '--store-color': st.color }, 'data-board-store': st.id },
          el('h3', { class: 'sb-store__name' }, st.name, el('span', { class: 'sb-store__count' }, `${staff.length}人`)),
          el('div', { class: 'sb-line' }, el('span', { class: 'sb-line__label is-mgr' }, '幹部'), el('div', { class: 'sb-chips' }, mgrs.length ? mgrs.map((r) => chip(r, 'mgr')) : el('span', { class: 'sb-empty' }, 'いません'))),
          el('div', { class: 'sb-line' }, el('span', { class: 'sb-line__label' }, 'スタッフ'), el('div', { class: 'sb-chips' }, staff.length ? staff.map((r) => chip(r, 'staff')) : el('span', { class: 'sb-empty' }, 'いません')))
        );
      })
    );
  }

  function loginOverview() {
    if (!K.storage.isCloud() || !K.storage.getManagers) return null;
    const all = loginPeople();
    const count = { all: all.length, mgr: all.filter((r) => r.mgr).length, staff: all.filter((r) => r.staff).length, nomail: all.filter((r) => !r.email).length };
    const filters = [
      ['all', 'すべて', count.all],
      ['mgr', '幹部', count.mgr],
      ['staff', 'スタッフ', count.staff],
      ['nomail', 'メール未登録', count.nomail],
    ];
    const pick = { all: () => true, mgr: (r) => r.mgr, staff: (r) => r.staff, nomail: (r) => !r.email };
    const rows = all.filter(pick[loginFilter] || pick.all);
    const storeName = (id) => (K.storage.getStore(id) || {}).name || '';

    // 1人分のカード（名前・役割の札・担当・メール・送信の結果・ボタン）
    function card(r) {
      const member = r.staff || mgrMailMember(r.mgr);
      const last = r.email ? lastMail(member.id) : null;
      return el(
        'div',
        { class: `lp-card${r.email ? '' : ' is-nomail'}${r.mgr ? ' is-mgr' : ''}`, 'data-login-row': r.key },
        el(
          'div',
          { class: 'lp-card__head' },
          el('b', { class: 'lp-card__name' }, r.name || '（名前が未登録）'),
          el('span', { class: 'lp-badges' }, r.mgr ? el('span', { class: 'lp-badge is-mgr' }, '幹部') : null, r.staff ? el('span', { class: 'lp-badge is-staff' }, 'スタッフ') : null)
        ),
        r.mgr ? el('p', { class: 'lp-card__mgr' }, `担当：${storeNames(r.mgr.storeIds)}`) : null,
        el('p', { class: 'lp-card__mail' }, r.email ? maskEmail(r.email) : el('span', { class: 'lp-none' }, 'メール未登録'), r.email && isCarrierMail(r.email) ? el('span', { class: 'lp-carrier', title: CARRIER_NOTE }, '携帯会社のメール・届きにくい') : null),
        el(
          'p',
          { class: 'lp-card__state' },
          !r.email
            ? el('span', { class: 'lp-chip is-none' }, 'ログインできません')
            : last
              ? el('span', { class: `lp-chip is-${last.status}` }, `${MAIL_SHORT[last.status] || last.status} ${timeLabel(last.at)}`)
              : el('span', { class: 'lp-chip is-never' }, 'まだ送っていない')
        ),
        el(
          'div',
          { class: 'lp-actions' },
          r.email ? managerMailButton({ staffId: r.staff ? r.staff.id : null, email: r.email, name: r.name }, true) : null,
          r.email ? el('button', { type: 'button', class: 'btn btn--ghost btn--small lp-invite', 'data-invite-copy': r.key, onclick: () => copyInvite(r, member.id) }, '案内をコピー') : null,
          el('button', { type: 'button', class: 'text-btn', onclick: () => (r.staff ? openForm(r.staff.id) : openMgrForm(r.mgr.email)) }, r.email ? '編集' : 'メールを入れる'),
          r.staff && r.mgr ? el('button', { type: 'button', class: 'text-btn', 'data-mgr-edit': '', onclick: () => openMgrForm(r.mgr.email) }, '幹部の設定') : null,
          r.staff && !r.mgr && r.email ? el('button', { type: 'button', class: 'text-btn lp-make-mgr', 'data-mgr-make': '', onclick: () => openMgrForm(`staff:${r.staff.id}`) }, '幹部にする') : null
        )
      );
    }

    // 店舗ごとの列（スタッフは所属する店舗、名簿にいない幹部は最初の担当店舗）。幹部を上に
    const columns = K.storage.getStores().map((st) => {
      const list = rows.filter((r) => r.storeId === st.id);
      return el(
        'section',
        { class: 'lp-col', style: { '--store-color': st.color }, 'data-login-col': st.id },
        el('h4', { class: 'lp-col__name' }, st.name, el('span', { class: 'lp-col__count' }, `${list.length}人`)),
        list.length ? list.map(card) : el('p', { class: 'sb-empty' }, '当てはまる人はいません')
      );
    });

    return el(
      'section',
      { class: 'lp', 'data-managers': '' },
      el(
        'div',
        { class: 'lp-head' },
        el('h2', { class: 'lp-title' }, 'ログインする人（全店舗）'),
        el(
          'div',
          { class: 'lp-head__btns' },
          el('button', { type: 'button', class: 'btn btn--ghost btn--small', 'data-invite-qr-open': '', onclick: showQr }, 'QRコードを表示'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--small', 'data-mgr-add': '', onclick: () => openMgrForm('new') }, '＋ 名簿にいない幹部を追加')
        )
      ),
      storeBoard(all),
      el('p', { class: 'field__note sb-note' }, '赤い名前は幹部（担当する店舗）、白い名前はスタッフ（所属する店舗）です。「!」はメールアドレスが未登録で、まだログインできない人です。名前を押すと編集できます。'),
      el('h3', { class: 'lp-subtitle' }, 'メールアドレスと送信の結果'),
      el(
        'div',
        { class: 'lp-filters', role: 'group', 'aria-label': '絞り込み' },
        filters.map(([k, label, n]) =>
          el(
            'button',
            { type: 'button', class: `lp-filter is-${k}${loginFilter === k ? ' is-on' : ''}`, 'aria-pressed': String(loginFilter === k), 'data-login-filter': k, onclick: () => { loginFilter = k; K.app.rerender(); } },
            el('span', { class: 'lp-filter__label' }, label),
            el('span', { class: 'lp-filter__num' }, `${n}人`)
          )
        )
      ),
      el('div', { class: 'lp-cols' }, columns),
      el(
        'p',
        { class: 'field__note lp-note' },
        '「案内をコピー」は、その人だけに送ってください（登録したメールアドレスが入っています）。幹部にするときは、スタッフの行の「幹部にする」を押します。メールアドレスを変えるときは「編集」から。幹部の登録も一緒に変わります。登録したら「メールを送る」を押してください（相手がメールのリンクでパスワードを決めると、ログインできます）。'
      )
    );
  }

  function managerForm(g, preset) {
    const isNew = !g;
    const stores = K.storage.getStores();
    const staff = K.storage.getStaff();
    const presetMember = preset ? staff.find((m) => m.id === preset) : null;
    const state = { staffId: g ? g.staffId || '' : presetMember ? presetMember.id : '', storeIds: new Set(g ? g.storeIds : [presetMember ? presetMember.storeId : K.app.currentStore().id]), busy: false };
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const nameInput = el('input', { id: 'mgr-name', class: 'field__input', type: 'text', maxlength: '12', autocomplete: 'off', placeholder: '例：山田', value: g && !g.staffId ? g.name : '' });
    const emailInput = el('input', { id: 'mgr-email', class: 'field__input', type: 'email', inputmode: 'email', autocomplete: 'off', placeholder: '例：name@example.com', value: g && !g.staffId ? g.email : '', oninput: () => (mgrCarrier.hidden = !isCarrierMail(emailInput.value)) });
    const mgrCarrier = el('p', { class: 'field__note carrier-note', 'data-carrier-note': '', hidden: !isCarrierMail(g && !g.staffId ? g.email : '') }, CARRIER_NOTE);
    const linkedInfo = el('p', { class: 'field__note mgr-linked', 'data-mgr-linked': '' });
    const ownFields = el(
      'div',
      { class: 'mgr-own' },
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'mgr-name' }, '名前'), nameInput),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'mgr-email' }, 'ログイン用のメールアドレス'), emailInput, mgrCarrier)
    );
    function paintLink() {
      const m = state.staffId ? staff.find((x) => x.id === state.staffId) : null;
      ownFields.hidden = Boolean(m);
      linkedInfo.hidden = !m;
      if (m) {
        linkedInfo.textContent = m.email
          ? `名前とメールアドレスは、スタッフの名簿の${m.name}さんのものを使います（${m.email}）。アドレスを変えるときは、スタッフの編集で変えてください。幹部の登録も一緒に変わります。`
          : `${m.name}さんのログイン用のメールアドレスが、まだ登録されていません。先にスタッフの編集で登録してください。`;
      }
    }
    const staffSelect = el(
      'select',
      { id: 'mgr-staff', class: 'field__input', onchange: (ev) => { state.staffId = ev.currentTarget.value; paintLink(); } },
      el('option', { value: '', selected: !state.staffId }, '名簿にいない（シフトに入らない人）'),
      stores.map((st) => {
        const members = staff.filter((m) => m.storeId === st.id);
        return members.length ? el('optgroup', { label: st.name }, members.map((m) => el('option', { value: m.id, selected: m.id === state.staffId }, `${m.name}${m.email ? '' : '（メール未登録）'}`))) : null;
      })
    );
    paintLink();
    const storeChecks = el(
      'div',
      { class: 'check-chips', role: 'group', 'aria-label': '担当する店舗' },
      stores.map((st) =>
        el(
          'label',
          { class: 'check-chip', style: { '--chip-color': st.color } },
          el('input', { type: 'checkbox', checked: state.storeIds.has(st.id), 'data-mgr-store': st.id, onchange: (ev) => (ev.currentTarget.checked ? state.storeIds.add(st.id) : state.storeIds.delete(st.id)) }),
          el('span', { class: 'check-chip__label' }, st.name)
        )
      )
    );
    const showError = (msg) => {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    };

    async function onSubmit(ev) {
      ev.preventDefault();
      if (state.busy) return;
      errorBox.hidden = true;
      const fields = { staffId: state.staffId, name: nameInput.value, email: emailInput.value, storeIds: [...state.storeIds] };
      // 勤怠用 iPad のアドレスは使えない（ログインすると iPad の画面になるため）
      const backend = K.app.cloudBackend ? K.app.cloudBackend() : null;
      const m = state.staffId ? staff.find((x) => x.id === state.staffId) : null;
      const target = String(m ? m.email || '' : fields.email).trim().toLowerCase();
      state.busy = true;
      try {
        if (target && backend && backend.loadKiosks) {
          const kiosk = (await backend.loadKiosks()).find((k) => String(k.email).toLowerCase() === target && !k.deleted);
          if (kiosk) throw new Error('このメールアドレスは、勤怠用 iPad に登録されています。幹部には、別のアドレスを使ってください。');
        }
        K.storage.saveManager(isNew ? null : g.email, fields);
        K.app.toast(isNew ? '幹部を登録しました。「パスワード設定用のメールを送る」を押してください' : '保存しました', 3500);
        closeMgrForm();
      } catch (err) {
        showError(err.message);
      } finally {
        state.busy = false;
      }
    }

    function onRemove() {
      if (!window.confirm(`${g.name ? `${g.name}さん` : 'この人'}を幹部から外しますか？\n外すと、幹部の画面に入れなくなります（スタッフとして登録されていれば、スタッフの画面は使えます）。`)) return;
      try {
        K.storage.removeManager(g.email);
        K.app.toast('幹部から外しました');
        closeMgrForm();
      } catch (err) {
        showError(err.message);
      }
    }

    return el(
      'form',
      { class: 'card mgr-form', 'data-mgr-form': '', onsubmit: onSubmit, novalidate: true },
      el('h2', { class: 'card__title' }, isNew ? '幹部を追加' : g.name ? `幹部の編集（${g.name}さん）` : '幹部の編集'),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'mgr-staff' }, 'スタッフの名簿の人'),
        staffSelect,
        el('p', { class: 'field__note' }, 'シフトに入る人は、名簿の本人を選びます。名簿にいない人は「名簿にいない」を選んで、名前とメールアドレスを入れます。'),
        linkedInfo
      ),
      ownFields,
      el('div', { class: 'field' }, el('p', { class: 'field__label' }, '担当する店舗'), storeChecks, el('p', { class: 'field__note' }, '担当する店舗の申請を判断し、確定したシフトを見られます。いくつでも選べます。')),
      errorBox,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? '登録する' : '保存する'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeMgrForm }, 'キャンセル'),
        isNew ? null : el('button', { type: 'button', class: 'btn btn--danger', 'data-mgr-remove': '', onclick: onRemove }, '幹部から外す')
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
          member.title ? el('span', { class: 'title-badge' }, member.title) : null,
          member.employment === 'part' ? el('span', { class: 'flag-badge' }, 'パート') : null,
          member.isNew ? el('span', { class: 'flag-badge' }, '新人') : null,
          member.excludeFromCount ? el('span', { class: 'flag-badge flag-badge--muted' }, '戦力外') : null
        ),
        // 職種は登録した名前のまま表示する（St／As は人数の数え方）
        el('div', { class: 'staff-row__position' }, U.positionLabel(member)),
        el(
          'div',
          { class: 'staff-row__sub' },
          [
            patternLabels || '勤務パターン未設定',
            hasWeekly ? '曜日の設定あり' : null,
            member.weeklyOffDays ? `週${member.weeklyOffDays}休` : null,
            Number.isInteger(member.monthlyOffDays) ? `月${member.monthlyOffDays}休` : null,
            K.storage.getSamePersonStaff(member.id).length ? 'ほかの店舗でも勤務' : null,
          ]
            .filter(Boolean)
            .join('・')
        )
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

    // 画面上部：メールの送信結果（作り直しても、覚えている結果から出す）
    container.append(el('div', { class: 'mail-slot', 'data-mail-slot': '' }, mailPanel()));

    if (formTarget === 'new' || editing) {
      container.append(formTarget === 'new' ? staffForm(null) : staffForm(editing));
      return;
    }
    const preset = mgrTarget && mgrTarget.startsWith('staff:') ? mgrTarget.slice(6) : null;
    const mgr = mgrTarget && mgrTarget !== 'new' && !preset && K.storage.getManagers ? K.storage.getManagers().find((g) => g.email === mgrTarget) : null;
    if (mgrTarget === 'new' || preset || mgr) {
      container.append(managerForm(mgr, preset));
      return;
    }

    // 表示するのは、ヘッダーで選んだ店舗のスタッフだけ
    const store = K.app.currentStore();
    const inactive = K.storage.getStaff({ storeId: store.id, includeInactive: true }).filter((m) => !m.active);

    const parts = [
      loginOverview(),
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
