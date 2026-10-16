// シフト表（日付が縦・スタッフが横。右に St／As／計の人数）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const KIND_TEXT = { off: '休', paid: '有' };
  const KIND_LABELS = { work: '通常勤務', off: '通常休', paid: '有給', business: '社用' };
  const TIMED_KINDS = ['work', 'business'];

  // 選んだら次の日へ進むか（入力シートの設定）
  let autoAdvance = true;

  // いま表示しているシフト表の情報（マスを更新するときに使う）
  let view = null;

  function shortDate(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${m}/${d}(${U.WEEKDAYS[K.calc.weekdayOf(dateStr)]})`;
  }

  // ---- マス ----

  function cellContent(shift, closed) {
    if (!shift) {
      return closed
        ? { cls: 'cell--closed', text: '定休', label: '定休日' }
        : { cls: 'cell--blank', text: '', label: '未入力' };
    }
    if (TIMED_KINDS.includes(shift.kind)) {
      const p = K.storage.getPattern(shift.patternId);
      const isBusiness = shift.kind === 'business';
      const time = p ? `${U.formatTime(p.start)}〜${U.formatTime(p.end)}` : '';
      return {
        cls: `cell--${shift.kind}`,
        text: isBusiness ? [el('span', { class: 'cell__tag' }, '社'), p ? p.label : '?'] : p ? p.label : '?',
        label: `${KIND_LABELS[shift.kind]} ${p ? `${p.label}（${time}）` : ''}`,
        color: p ? p.color : null,
      };
    }
    return { cls: `cell--${shift.kind}`, text: KIND_TEXT[shift.kind], label: KIND_LABELS[shift.kind] };
  }

  function cell(member, date) {
    const shift = view.map.get(`${member.id}|${date}`);
    const c = cellContent(shift, view.closed.has(date));
    // 休憩・社用時間が設定されている日は、右上に小さな印を付ける
    const detailed = shift && shift.kind === 'work' && K.calc.hasTimeDetails(member, shift, date);
    if (detailed) {
      c.cls += ' has-details';
      c.label += '（休憩・社用時間あり）';
    }
    // スタッフが出した希望休の日（共有モードのとき）。シフトのデータは変えず、印を付けるだけ
    const wish = K.storage.isCloud() && K.requests.adminWishDates(member.id, date.slice(0, 7)).includes(date);
    if (wish) {
      c.cls += ' has-wish';
      c.label += '（希望休）';
    }
    // 当日の欠勤・休暇（急な休み）：右上に「急」の印。対応中は点線の枠
    const absence = shift && shift.absence;
    if (absence) {
      c.cls += ` has-absence${absence.status === 'handling' ? ' is-absence-handling' : ''}`;
      c.label += `（当日の欠勤・休暇：${K.storage.ABSENCE_TYPES[absence.type]}・${K.storage.ABSENCE_STATUS[absence.status]}）`;
    }
    // 連勤・労働時間・パターン外のチェックに引っかかったマス
    const issues = view.check.cells.get(`${member.id}|${date}`);
    if (issues) {
      c.cls += ' has-issue';
      c.label += `（注意：${issues.join('、')}）`;
    }
    return el(
      'td',
      { class: 'roster__cell' },
      el(
        'button',
        {
          type: 'button',
          class: `cell ${c.cls}`,
          style: c.color ? { '--pattern-color': c.color } : null,
          'aria-label': `${shortDate(date)} ${member.name}：${c.label}`,
          'data-staff': member.id,
          'data-date': date,
          onclick: () => openSheet(member, date),
          title: issues ? issues.join('、') : null,
        },
        c.text,
        wish ? el('span', { class: 'cell__wish', 'aria-hidden': 'true' }, '希') : null,
        absence ? el('span', { class: 'cell__absence', 'aria-hidden': 'true' }, '急') : null
      )
    );
  }

  // 右側の人数。人員不足の日は △、過多の日は ＋ を付け、足りない（多い）役割の数字に色を付ける
  function countCells(date) {
    const n = K.calc.dailyCounts(view.staff, view.map, date);
    const f = view.check.dates.get(date) || {};
    const cls = (role) => {
      if (f.short && (role === 'st' ? f.shortSt : f.shortAs)) return ' is-short';
      if (f.over && (role === 'st' ? f.overSt : f.overAs)) return ' is-over';
      return '';
    };
    const marks = `${f.short ? '△' : ''}${f.over ? '＋' : ''}`;
    const note = [f.short ? '人員不足あり' : null, f.over ? '人員過多あり' : null].filter(Boolean).join('・');
    return [
      el('td', { class: `roster__count roster__count--st${cls('st')}` }, String(n.stylist)),
      el('td', { class: `roster__count roster__count--as${cls('as')}` }, String(n.assistant)),
      el(
        'td',
        { class: `roster__count roster__count--total${marks ? ' has-mark' : ''}`, title: note || null },
        String(n.total),
        marks ? el('span', { class: 'roster__mark', 'aria-label': note }, marks) : null
      ),
    ];
  }

  function dateRow(date) {
    const w = K.calc.weekdayOf(date);
    const closed = view.closed.has(date);
    const classes = ['roster__row'];
    const holiday = K.holidays.holidayName(date);
    if (w === 0 || holiday) classes.push('is-sun');
    if (w === 6 && !holiday) classes.push('is-sat');
    if (closed) classes.push('is-closed');
    if (date === U.todayStr()) classes.push('is-today');
    const [, , d] = date.split('-').map(Number);

    const n = K.calc.dailyCounts(view.staff, view.map, date);

    return el(
      'tr',
      { class: classes.join(' '), 'data-date': date },
      el(
        'th',
        { class: 'roster__date', scope: 'row' },
        // 日付をタップすると、その日の時間帯別の人数を表示する
        el(
          'button',
          {
            type: 'button',
            class: 'roster__date-btn',
            'data-day': date,
            'aria-label': `${shortDate(date)}${holiday ? `（${holiday}）` : ''}の1日の詳細を見る`,
            title: holiday || null,
            onclick: () => K.app.navigate('day', { date, storeId: view.store.id }),
          },
          el('span', { class: 'roster__day' }, String(d)),
          el('span', { class: 'roster__wd' }, holiday ? '祝' : U.WEEKDAYS[w]),
          holiday ? el('span', { class: 'roster__closed-tag roster__holiday-tag' }, holiday) : null,
          closed ? el('span', { class: 'roster__closed-tag' }, '定休') : null,
          n.business ? el('span', { class: 'roster__business-tag' }, `社用${n.business}`) : null
        )
      ),
      view.staff.map((m) => cell(m, date)),
      countCells(date)
    );
  }

  function footer() {
    const totals = view.staff.map((m) => K.calc.staffMonthTotals(m, view.map, view.dates, view.store));
    const row = (label, key, extra) =>
      el(
        'tr',
        { class: 'roster__foot-row' },
        el('th', { class: 'roster__date roster__foot-label', scope: 'row' }, label),
        totals.map((t, i) => {
          // 月の休日数が目安より少ない人は、「休」の数に色を付ける
          const short = key === 'off' ? view.check.offShort.get(view.staff[i].id) : null;
          return el(
            'td',
            {
              class: `roster__foot${extra ? ` ${extra}` : ''}${short ? ' is-short' : ''}`,
              title: short ? `休日${short.off}日（目安${short.target}日）` : null,
            },
            String(t[key]),
            short ? el('span', { class: 'roster__mark' }, '△') : null
          );
        }),
        el('td', { class: 'roster__count roster__count--st roster__foot-blank' }),
        el('td', { class: 'roster__count roster__count--as roster__foot-blank' }),
        el('td', { class: 'roster__count roster__count--total roster__foot-blank' })
      );
    return el(
      'tfoot',
      null,
      row('勤務', 'work'),
      row('社用', 'business'),
      row('休', 'off'),
      row('有', 'paid', 'is-paid'),
      row('未入力', 'blank', 'is-muted')
    );
  }

  // 入力のあと、表の中身とチェック結果を作り直す
  // （連勤や週の労働時間はほかの日にも関わるため、1か月分をまとめて作り直す。スクロール位置はそのまま）
  function refreshAll() {
    view.map = K.calc.shiftMap(view.month, view.store.id);
    view.check = K.rules.checkMonth(view.store.id, view.month);
    view.table.querySelector('tbody').replaceWith(el('tbody', null, view.dates.map(dateRow)));
    view.table.querySelector('tfoot').replaceWith(footer());
    const oldButton = document.querySelector('.check-btn:not(.export-btn):not(.weekly-btn):not(.tool-btn)');
    if (oldButton) oldButton.replaceWith(checkButton());
    // 欠勤・急な休みのボタン（件数）も新しくする
    const oldAbsence = document.querySelector('.absence-btn');
    const nextAbsence = absenceButton();
    if (oldAbsence && nextAbsence) oldAbsence.replaceWith(nextAbsence);
    else if (oldAbsence) oldAbsence.remove();
    else if (nextAbsence) {
      const anchor = document.querySelector('.check-btn:not(.export-btn):not(.weekly-btn):not(.tool-btn)');
      if (anchor) anchor.after(nextAbsence);
    }
  }

  function focusCell(staffId, date) {
    const target = view.table.querySelector(`button[data-staff="${staffId}"][data-date="${date}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return target;
  }

  // ---- 入力シート（画面の下から出る選択肢） ----

  let sheet = null;

  function closeSheet(returnFocus = true) {
    if (!sheet) return;
    const { staffId, date, kind } = sheet;
    sheet.root.remove();
    document.removeEventListener('keydown', onKeydown);
    sheet = null;
    if (!returnFocus || !view) return;
    if (kind === 'check' || kind === 'export') {
      const btn = document.querySelector(kind === 'check' ? '.check-btn:not(.export-btn):not(.weekly-btn):not(.tool-btn)' : '.export-btn');
      if (btn) btn.focus({ preventScroll: true });
    } else {
      focusCell(staffId, date);
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') closeSheet();
  }

  function showSheet(panel, info) {
    const root = el('div', { class: 'sheet-layer' }, el('div', { class: 'sheet-backdrop', onclick: () => closeSheet() }), panel);
    document.body.append(root);
    document.addEventListener('keydown', onKeydown);
    sheet = { root, ...info };
  }

  function sheetHead(title, sub) {
    return el(
      'div',
      { class: 'sheet__head' },
      el('h2', { class: 'sheet__title', id: 'sheet-title' }, title, el('span', { class: 'sheet__name' }, sub)),
      el('button', { type: 'button', class: 'sheet__close', 'aria-label': '閉じる', onclick: () => closeSheet() }, '×')
    );
  }

  function apply(member, date, choice) {
    try {
      if (choice === null) K.storage.clearShift(member.id, date);
      else K.storage.setShift(member.id, date, { ...choice, storeId: view.store.id });
    } catch (err) {
      K.app.toast(err.message);
      return;
    }
    refreshAll();

    const index = view.dates.indexOf(date);
    const next = view.dates[index + 1];
    if (autoAdvance && next) {
      openSheet(member, next);
      focusCell(member.id, next);
    } else {
      closeSheet();
    }
  }

  function openSheet(member, date) {
    closeSheet(false);
    // 確定済みの月は、確定を取り消すまで入力できない（当日の欠勤・休暇の登録・確定・取り消しだけはできる）
    if (K.storage.getPublication(view.store.id, view.month)) {
      openAbsenceSheet(member, date);
      return;
    }
    const current = view.map.get(`${member.id}|${date}`) || null;
    // その曜日のいつもの勤務（スタッフの設定。勤務パターンID または "off"）
    const usual = (member.weeklyPatterns || {})[String(K.calc.weekdayOf(date))] || null;
    // いつもの勤務を先頭に、そのあとは店舗ごとの勤務パターンの並び順（設定 > 勤務パターン で変えられる）
    const byStoreOrder = K.storage.comparePatterns(K.app.currentStore().id);
    const patterns = member.patternIds
      .map((id) => K.storage.getPattern(id))
      .filter((p) => p && !p.deleted)
      .sort((a, b) => (b.id === usual) - (a.id === usual) || byStoreOrder(a, b));

    const isCurrent = (kind, patternId) =>
      Boolean(current && current.kind === kind && (!TIMED_KINDS.includes(kind) || current.patternId === patternId));

    const isUsual = (kind, patternId) => Boolean(usual) && ((kind === 'work' && patternId === usual) || (kind === 'off' && usual === 'off'));

    const option = ({ cls, main, sub, kind, patternId, color }) =>
      el(
        'button',
        {
          type: 'button',
          class: `sheet-option ${cls}${isCurrent(kind, patternId) ? ' is-current' : ''}${isUsual(kind, patternId) ? ' is-usual' : ''}`,
          style: color ? { '--pattern-color': color } : null,
          'aria-pressed': String(isCurrent(kind, patternId)),
          onclick: () => apply(member, date, { kind, patternId }),
        },
        el('span', { class: 'sheet-option__main' }, main),
        sub ? el('span', { class: 'sheet-option__sub' }, sub) : null,
        isUsual(kind, patternId) ? el('span', { class: 'usual-badge' }, 'いつも') : null
      );

    // 通常勤務・社用のどちらも、登録済みの勤務パターンから時間を選ぶ
    const patternOptions = (kind) =>
      patterns.length
        ? el(
            'div',
            { class: 'sheet__grid' },
            patterns.map((p) =>
              option({
                cls: `sheet-option--${kind}`,
                main: kind === 'business' ? [el('span', { class: 'cell__tag' }, '社'), p.label] : p.label,
                sub: `${U.formatTime(p.start)}〜${U.formatTime(p.end)}`,
                kind,
                patternId: p.id,
                color: p.color,
              })
            )
          )
        : el('p', { class: 'sheet__note' }, '使える勤務パターンがありません。設定画面で登録してください。');

    const advanceInput = el('input', {
      type: 'checkbox',
      checked: autoAdvance,
      onchange: (event) => (autoAdvance = event.currentTarget.checked),
    });

    const panel = el(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      // どの店舗のシフトを入力しているかを、必ず表示する
      sheetHead(shortDate(date), `${view.store.name}　${member.name}さん`),
      view.closed.has(date) ? el('p', { class: 'sheet__note' }, 'この日は店舗の定休日です。') : null,
      el('p', { class: 'sheet__label' }, '通常勤務'),
      patternOptions('work'),
      el('p', { class: 'sheet__label' }, '休み'),
      el(
        'div',
        { class: 'sheet__grid' },
        option({ cls: 'sheet-option--off', main: '休', sub: '通常休', kind: 'off' }),
        option({ cls: 'sheet-option--paid', main: '有', sub: '有給', kind: 'paid' })
      ),
      el('p', { class: 'sheet__label' }, '社用（出勤するが、予約可能人数に含めない）'),
      patternOptions('business'),
      el('p', { class: 'sheet__label' }, '当日の欠勤・休暇（子どもの発熱など、急な休み）'),
      el(
        'button',
        { type: 'button', class: 'btn btn--ghost sheet__absence-btn', onclick: () => openAbsenceSheet(member, date) },
        current && current.absence ? `欠勤・休暇の内容を見る（${K.storage.ABSENCE_STATUS[current.absence.status]}）` : '欠勤・休暇を登録'
      ),
      el(
        'div',
        { class: 'sheet__foot' },
        el('label', { class: 'sheet__advance' }, advanceInput, '選んだら次の日へ進む'),
        current
          ? el('button', { type: 'button', class: 'text-btn text-btn--small', onclick: () => apply(member, date, null) }, '未入力に戻す')
          : null
      ),
      // 通常勤務の日は、1日の詳細画面で休憩・社用時間を設定できる
      current && current.kind === 'work'
        ? el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost sheet__detail-btn',
              onclick: () => K.app.navigate('day', { date, storeId: view.store.id, staffId: member.id }),
            },
            '休憩・社用時間を設定 →'
          )
        : null
    );

    showSheet(panel, { kind: 'cell', staffId: member.id, date });

    const first = panel.querySelector('.sheet-option.is-current') || panel.querySelector('.sheet-option');
    if (first) first.focus({ preventScroll: true });
  }

  // ---- チェック結果 ----

  // ---- 当日の欠勤・休暇（急な休み） ----
  // 本人からの連絡を受けて店長が登録する。種類は店長が本人の申出・就業規則に沿って選ぶ（アプリは決めない）。
  // 代わりの勤務は自動で入れない（店長がシフト表で調整）。確定済みの月でも、登録・変更・確定・取り消しだけはできる。

  // その日の人員不足（自動チェックと同じもの）
  function shortageOf(date) {
    return view.check.issues.filter((i) => i.type === 'shortage' && i.date === date).map((i) => i.message);
  }

  // 確定済みの月で、確定した欠勤・休暇が変わったら、スタッフの確定シフト（写し）を作り直す
  function republishIfNeeded(message) {
    const locked = Boolean(K.storage.getPublication(view.store.id, view.month));
    if (!locked || !K.storage.isCloud()) {
      K.app.toast(message);
      return;
    }
    K.published
      .publish(view.store.id, view.month)
      .then(() => K.app.toast(`${message}スタッフの確定シフトも更新しました。`))
      .catch((err) => K.app.toast(`${message}ただし、スタッフの確定シフトを更新できませんでした（${err.message}）。`));
  }

  function openAbsenceSheet(member, date) {
    closeSheet(false);
    const T = K.storage.ABSENCE_TYPES;
    const ST = K.storage.ABSENCE_STATUS;
    const locked = Boolean(K.storage.getPublication(view.store.id, view.month));
    const current = K.storage.getShift(member.id, date, view.store.id);
    const ab = current && current.absence;
    let type = ab ? ab.type : null;
    const radios = Object.entries(T).map(([key, label]) =>
      el(
        'label',
        { class: 'absence-type' },
        el('input', { type: 'radio', name: 'absence-type', value: key, checked: type === key, onchange: () => (type = key) }),
        el('span', null, label)
      )
    );
    const reasonInput = el('input', {
      type: 'text',
      class: 'field__input absence-reason',
      maxlength: String(K.storage.MAX_ABSENCE_REASON),
      value: ab ? ab.reason : '',
      placeholder: '任意',
      'aria-label': '理由（任意）',
    });
    const act = (fn, message, wasSettled) => {
      try {
        fn();
      } catch (err) {
        K.app.toast(err.message);
        return;
      }
      refreshAll();
      if (wasSettled) republishIfNeeded(message);
      else K.app.toast(message);
      openAbsenceSheet(member, date);
    };
    const shortage = shortageOf(date);
    const actions = !ab
      ? [
          el(
            'button',
            { type: 'button', class: 'btn btn--primary', onclick: () => act(() => K.storage.registerAbsence(member.id, date, view.store.id, { type, reason: reasonInput.value }), '欠勤・休暇を登録しました（対応中）。') },
            '登録する（対応中）'
          ),
        ]
      : [
          el(
            'button',
            { type: 'button', class: 'btn btn--ghost', onclick: () => act(() => K.storage.updateAbsence(member.id, date, view.store.id, { type, reason: reasonInput.value }), '種類・理由を保存しました。', ab.status === 'settled') },
            '種類・理由を保存'
          ),
          ab.status === 'handling'
            ? el('button', { type: 'button', class: 'btn btn--primary', onclick: () => act(() => K.storage.settleAbsence(member.id, date, view.store.id), '欠勤・休暇を確定しました。', true) }, '確定する')
            : null,
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost',
              onclick: () => {
                if (!window.confirm('この欠勤・休暇の登録を取り消して、もとのマスに戻しますか？')) return;
                act(() => K.storage.cancelAbsence(member.id, date, view.store.id), '登録を取り消して、もとのマスに戻しました。', ab.status === 'settled');
              },
            },
            '取り消す（もとのマスに戻す）'
          ),
        ];
    const panel = el(
      'div',
      { class: 'sheet absence-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      sheetHead(`${shortDate(date)} 欠勤・休暇`, `${view.store.name}　${member.name}さん`),
      locked
        ? el('p', { class: 'sheet__note' }, 'この月は確定済みです。欠勤・休暇の登録・変更・確定・取り消しだけができます（代わりの勤務の調整は「確定を取り消す」から）。')
        : null,
      ab
        ? el('p', { class: `absence-status absence-status--${ab.status}` }, `${ST[ab.status]}：${T[ab.type]}`)
        : el('p', { class: 'sheet__note' }, '本人からの連絡（電話・LINE WORKS など）を受けて、店長が登録します。事前の申請は要りません。'),
      el('p', { class: 'sheet__label' }, '休みの種類（本人の申出・就業規則に沿って、店長が選びます）'),
      el('div', { class: 'absence-types', role: 'radiogroup', 'aria-label': '休みの種類' }, radios),
      el('p', { class: 'sheet__label' }, `理由（任意・${K.storage.MAX_ABSENCE_REASON}文字まで。スタッフの画面・印刷には出ません）`),
      reasonInput,
      el('div', { class: 'actions absence-actions' }, actions),
      el('p', { class: 'sheet__label' }, 'この日の勤務への影響'),
      shortage.length
        ? el('ul', { class: 'absence-impact is-short' }, shortage.map((m) => el('li', null, `人員不足：${m}`)))
        : el('p', { class: 'absence-impact' }, K.calc.dayInfo(view.store, date).bands.length ? '必要人数は足りています。' : '必要人数が設定されていないため、不足は計算できません（設定 > 必要人数）。'),
      el('p', { class: 'sheet__note' }, '代わりの人は自動では入れません。同じ店舗の調整・他店舗からの応援・予約の変更などを検討し、シフト表で調整してください。解消できないときは、店長・代表で確認してください。')
    );
    showSheet(panel, { staffId: member.id, date, kind: 'absence' });
  }

  function absenceButton() {
    const list = K.storage.getAbsences({ storeId: view.store.id, month: view.month });
    if (!list.length) return null;
    const handling = list.filter((a) => a.absence.status === 'handling').length;
    return el(
      'button',
      { type: 'button', class: `check-btn tool-btn absence-btn${handling ? ' has-issues' : ''}`, onclick: openAbsenceList },
      handling ? `欠勤・急な休み（対応中 ${handling}件）` : `欠勤・急な休み（${list.length}件）`
    );
  }

  function openAbsenceList() {
    closeSheet(false);
    const T = K.storage.ABSENCE_TYPES;
    const ST = K.storage.ABSENCE_STATUS;
    const list = K.storage.getAbsences({ storeId: view.store.id, month: view.month });
    const rows = list.map((a) => {
      const member = K.storage.getStaffMember(a.staffId);
      const shortage = shortageOf(a.date);
      return el(
        'li',
        { class: `absence-row${shortage.length ? ' is-short' : ''}` },
        el(
          'div',
          { class: 'absence-row__main' },
          el('span', { class: 'absence-row__date' }, shortDate(a.date)),
          el('span', { class: 'absence-row__name' }, member ? `${member.name}さん` : '（不明なスタッフ）'),
          el('span', { class: 'absence-row__type' }, T[a.absence.type]),
          el('span', { class: `req-status req-status--${a.absence.status === 'settled' ? 'approved' : 'pending'}` }, ST[a.absence.status])
        ),
        shortage.length ? el('p', { class: 'absence-row__short' }, `店長・代表への確認事項：人員不足 ${shortage.join('／')}`) : el('p', { class: 'absence-row__ok' }, '必要人数の不足はありません'),
        member ? el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => openAbsenceSheet(member, a.date) }, '開く') : null
      );
    });
    const panel = el(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      sheetHead(`${Number(view.month.slice(5))}月の欠勤・急な休み`, view.store.name),
      el('p', { class: 'sheet__note' }, '対応中のものは、勤務の調整が終わったら「開く」から確定してください。不足が残る日は、店長・代表で確認してください。'),
      el('ul', { class: 'absence-list' }, rows)
    );
    showSheet(panel, { kind: 'absence-list' });
  }

  function checkButton() {
    const { total, blank } = view.check;
    return el(
      'button',
      {
        type: 'button',
        class: `check-btn${total ? ' has-issues' : ''}`,
        'aria-label': `チェック結果：注意${total}件、未入力のスタッフ${blank}人`,
        onclick: openCheckSheet,
      },
      total ? `△ チェック ${total}件` : '✓ 問題なし',
      blank ? el('span', { class: 'check-btn__sub' }, `未入力 ${blank}人`) : null
    );
  }

  function openCheckSheet() {
    closeSheet(false);
    const { issues } = view.check;

    const item = (issue) => {
      const when = issue.date ? shortDate(issue.date) : '';
      const content = [when ? el('span', { class: 'check-item__date' }, when) : null, el('span', { class: 'check-item__text' }, issue.message)];
      let action = null;
      if (issue.date && (issue.type === 'shortage' || issue.type === 'over')) {
        action = () => K.app.navigate('day', { date: issue.date, storeId: view.store.id });
      } else if (issue.date && issue.staffId) {
        action = () => {
          closeSheet(false);
          focusCell(issue.staffId, issue.date);
        };
      }
      return el(
        'li',
        null,
        action
          ? el('button', { type: 'button', class: 'check-item', onclick: action }, content, el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'))
          : el('div', { class: 'check-item' }, content)
      );
    };

    const groups = K.rules.TYPES.map(([type, label]) => ({ type, label, list: issues.filter((i) => i.type === type) })).filter((g) => g.list.length);

    const panel = el(
      'div',
      { class: 'sheet sheet--wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      sheetHead('チェック結果', `${view.store.name}・${Number(view.month.slice(5))}月`),
      groups.length
        ? groups.map((g) =>
            el(
              'section',
              { class: 'check-group' },
              el('h3', { class: 'check-group__title' }, g.type === 'blank' ? `${g.label}（スタッフごとの日数）` : g.label, el('span', { class: 'check-group__count' }, `${g.list.length}件`)),
              el('ul', { class: 'check-list' }, g.list.map(item))
            )
          )
        : el('p', { class: 'sheet__note' }, '問題は見つかりませんでした。'),
      el('p', { class: 'sheet__note' }, 'アプリは知らせるだけで、シフトを自動で直すことはしません。基準は「設定 > チェック」で変更できます。')
    );

    showSheet(panel, { kind: 'check' });
    panel.querySelector('.sheet__close').focus({ preventScroll: true });
  }

  // ---- 曜日ごとのいつもの勤務を反映 ----

  // スタッフの「曜日ごとのいつもの勤務」を、この月の未入力の日にだけ入れる（入力済みの日・定休日は変えない）
  function applyWeekly() {
    const hasSetting = view.staff.some((m) => m.active && m.storeId === view.store.id && m.weeklyPatterns && Object.keys(m.weeklyPatterns).length);
    if (!hasSetting) {
      K.app.toast('曜日ごとの勤務を設定したスタッフがいません（設定 > スタッフ）');
      return;
    }
    const monthLabel = `${Number(view.month.slice(5))}月`;
    if (!window.confirm(`${view.store.name}の${monthLabel}の「未入力の日」に、スタッフの曜日ごとのいつもの勤務を入れます。\n入力済みの日と定休日は変えません。よろしいですか？`)) return;
    try {
      const count = K.storage.applyWeeklyPatterns(view.store.id, view.month);
      refreshAll();
      K.app.toast(count ? `${count}日分を入れました` : '入れられる未入力の日はありませんでした');
    } catch (err) {
      K.app.toast(err.message);
    }
  }

  // ---- 出力（画像・印刷） ----

  function openExportSheet() {
    closeSheet(false);
    const stores = K.storage.getStores();
    let target = view.store.id; // 店舗ID か 'all'
    const targetIds = () => (target === 'all' ? stores.map((s) => s.id) : [target]);
    const monthLabel = `${Number(view.month.slice(0, 4))}年${Number(view.month.slice(5))}月`;

    const buttons = [...stores.map((s) => [s.id, s.name]), ['all', '全店舗']].map(([key, label]) =>
      el(
        'button',
        {
          type: 'button',
          class: `chip${key === target ? ' is-selected' : ''}`,
          'aria-pressed': String(key === target),
          onclick: (event) => {
            target = key;
            for (const b of buttons) {
              const on = b === event.currentTarget;
              b.classList.toggle('is-selected', on);
              b.setAttribute('aria-pressed', String(on));
            }
          },
        },
        label
      )
    );

    async function saveImage() {
      try {
        const result = await K.exporter.saveImages(targetIds(), view.month);
        if (result !== 'cancelled') K.app.toast(result === 'shared' ? '共有しました' : '画像を保存しました');
      } catch (err) {
        K.app.toast(err.message);
      }
    }

    function print() {
      closeSheet(false);
      K.exporter.printRosters(targetIds(), view.month);
    }

    const panel = el(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      sheetHead('出力', monthLabel),
      el('p', { class: 'sheet__label' }, '店舗'),
      el('div', { class: 'chips', role: 'group', 'aria-label': '出力する店舗' }, buttons),
      el(
        'div',
        { class: 'export-actions' },
        el(
          'button',
          { type: 'button', class: 'btn btn--primary', onclick: saveImage },
          '画像を保存（PNG）',
          el('span', { class: 'export-actions__sub' }, '1店舗1か月を1枚。iPhone では共有メニューから LINE などへ')
        ),
        el(
          'button',
          { type: 'button', class: 'btn btn--ghost', onclick: print },
          '印刷・PDF（A4横）',
          el('span', { class: 'export-actions__sub' }, '1店舗1ページ。印刷の画面で「PDFとして保存」も選べます')
        )
      ),
      el(
        'p',
        { class: 'sheet__note' },
        '勤務・休・有・社用と St／As／計 を出力します（チェックの記号は入れません）。画像や PDF は、保存・共有したときだけ端末の外に出ます。'
      )
    );

    showSheet(panel, { kind: 'export' });
    panel.querySelector('.sheet__close').focus({ preventScroll: true });
  }

  // ---- AIシフト作成 ----

  function whoAmI() {
    const user = K.app.cloudUser && K.app.cloudUser();
    return user ? user.email : 'この端末';
  }

  // 作成結果の確認（別々に表示）：① 早番不足 ② 連続勤務（早早・遅遅） ③ 必要人数不足 ④ 回数の偏り。⑤ 制約あり（対象外）はお知らせとして
  // くわしい日付と理由は下のお知らせ
  function autoProblems(problems) {
    if (!problems) return null;
    const rows = [
      ['早番不足（早番が0人の日）', problems.earlyZero.length ? `${problems.earlyZero.length}日：${problems.earlyZero.map((x) => `${shortDate(x.date)} ${x.reason}`).join('／')}` : null],
      ['連続勤務（早早・遅遅）', problems.repeats.length ? `${problems.repeats.length}か所：${problems.repeats.map((r) => `${r.name}さん ${shortDate(r.dates[0])}〜（${r.reason}）`).join('／')}` : null],
      ['必要人数不足', problems.shortDays.length ? `${problems.shortDays.length}日：${problems.shortDays.join('、')}` : null],
      ['早番と遅番の回数の差（3回以上）', problems.imbalance && problems.imbalance.length ? problems.imbalance.map((x) => `${x.name}さん 早番${x.early}回・遅番${x.late}回`).join('／') : null],
    ];
    const bad = rows.filter(([, v]) => v);
    const constrained = problems.constrained || [];
    return el(
      'div',
      { class: 'auto-checks' },
      el(
        'div',
        { class: `auto-problems${bad.length ? '' : ' auto-problems--ok'}`, role: 'status' },
        el('p', { class: 'auto-problems__title' }, bad.length ? '条件を満たせない日があります（無理に勤務を変えていません）' : '早番不足・連続勤務・必要人数不足はありません'),
        el(
          'ul',
          null,
          rows.map(([label, v]) => el('li', { class: v ? 'is-bad' : 'is-ok' }, `${label}：${v || 'なし'}`))
        )
      ),
      constrained.length
        ? el(
            'p',
            { class: 'auto-constrained' },
            `制約あり（交互の対象外。無理に変えていません）：${constrained.map((c) => `${c.name}さん（${c.reason}・同じ番の続き${c.count}回）`).join('、')}。パートは契約の時間のため対象外です。`
          )
        : el('p', { class: 'auto-constrained' }, 'パートは契約の時間のため、早番・遅番の交互の対象外です。')
    );
  }

  function openAutoSheet() {
    closeSheet(false);
    const monthLabel = `${Number(view.month.slice(0, 4))}年${Number(view.month.slice(5))}月`;
    let result;
    try {
      result = K.autoshift.plan(view.store.id, view.month);
    } catch (err) {
      K.app.toast(err.message);
      return;
    }
    const works = result.assignments.filter((a) => a.kind === 'work').length;
    const offs = result.assignments.length - works;

    function doApply() {
      try {
        const { count } = K.storage.applyAutoShifts(view.store.id, view.month, result.assignments);
        closeSheet(false);
        K.app.rerender();
        K.app.toast(`${count}マスを入れました。シフト表と「チェック」で確認してください`);
      } catch (err) {
        K.app.toast(err.message);
      }
    }

    const panel = el(
      'div',
      { class: 'sheet sheet--wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      sheetHead('AIシフト作成', `${view.store.name}・${monthLabel}`),
      el(
        'p',
        { class: 'sheet__note' },
        '空いているマスだけを埋めます（入力済みのマスは変えません）。承認済みの有給・希望休・固定休は必ず休みにし、週休・月の休日数の目安・連勤の上限・必要人数を見て作ります。'
      ),
      result.assignments.length
        ? el('p', { class: 'auto-summary' }, `勤務 ${works}マス・休み ${offs}マスを入れます。`)
        : el('p', { class: 'auto-summary' }, '入れられる空きマスはありませんでした。'),
      autoProblems(result.problems),
      result.summary.length
        ? el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              { class: 'data-table auto-table' },
              el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'is-left' }, 'スタッフ'), el('th', { scope: 'col' }, '勤務'), el('th', { scope: 'col' }, '休み'), el('th', { scope: 'col' }, '連休'))),
              el(
                'tbody',
                null,
                result.summary.map((s) => el('tr', null, el('th', { scope: 'row', class: 'is-left' }, s.name), el('td', null, `${s.work}`), el('td', null, `${s.off}`), el('td', null, `${s.renkyu}回`)))
              )
            ),
            el('p', { class: 'hint hint--left' }, '連休：この月に、休み（通常休・有給。定休日を休みに数える設定のときは定休日も）が2日以上続いたところの回数（入力済みのマスを含む）。連休・早番と遅番の公平さは、正社員どうしでそろえます（パートは契約と希望を優先）。')
          )
        : null,
      result.notes.length ? el('ul', { class: 'auto-notes' }, result.notes.map((n) => el('li', null, n))) : null,
      el(
        'div',
        { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn--primary', disabled: !result.assignments.length, onclick: doApply }, 'この内容で入れる'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => closeSheet() }, 'やめる')
      ),
      el('p', { class: 'sheet__note' }, '入れたあとも、マスを押して手で直せます。「自動作成を取り消す」で、自動で入れて手で直していないマスだけを消せます。')
    );
    showSheet(panel, { kind: 'auto' });
    panel.querySelector('.sheet__close').focus({ preventScroll: true });
  }

  function undoAuto() {
    const count = K.storage.autoShiftCount(view.store.id, view.month);
    if (!window.confirm(`自動で入れて、まだ手で直していない ${count}マスを消して、未入力に戻します。よろしいですか？`)) return;
    try {
      const n = K.storage.undoAutoShifts(view.store.id, view.month);
      K.app.rerender();
      K.app.toast(`${n}マスを未入力に戻しました`);
    } catch (err) {
      K.app.toast(err.message);
    }
  }

  // ---- シフト確定 ----

  function confirmShift() {
    const monthLabel = `${Number(view.month.slice(5))}月`;
    const blank = view.check.blank;
    const note = view.check.total || blank ? `\n（注意：チェックの注意 ${view.check.total}件・未入力のスタッフ ${blank}人があります）` : '';
    if (!window.confirm(`${view.store.name}の${monthLabel}のシフトを確定しますか？\n確定すると、「確定を取り消す」を押すまで変更できません。${note}`)) return;
    const { id: storeId } = view.store;
    const month = view.month;
    try {
      K.storage.confirmMonth(storeId, month, whoAmI());
      K.app.rerender();
    } catch (err) {
      K.app.toast(err.message);
      return;
    }
    // 共有モードのときは、スタッフが見る公開用の写しも作る
    K.published
      .publish(storeId, month)
      .then((done) => K.app.toast(done ? 'シフトを確定しました（スタッフの画面にも表示されます）' : 'シフトを確定しました'))
      .catch((err) => K.app.toast(`確定しました。ただしスタッフへの公開に失敗しました（${err.message}）。もう一度「確定を取り消す」→「シフトを確定」を試してください`));
  }

  function unconfirmShift() {
    if (!window.confirm('確定を取り消して、もう一度変更できるようにしますか？')) return;
    const { id: storeId } = view.store;
    const month = view.month;
    try {
      K.storage.unconfirmMonth(storeId, month);
      K.app.rerender();
    } catch (err) {
      K.app.toast(err.message);
      return;
    }
    // スタッフの画面からも消す
    K.published
      .unpublish(storeId, month)
      .then(() => K.app.toast('確定を取り消しました'))
      .catch((err) => K.app.toast(`確定を取り消しました。ただしスタッフの画面から消せませんでした（${err.message}）`));
  }

  function publishBanner(pub) {
    const d = new Date(pub.confirmedAt);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return el(
      'div',
      { class: 'publish-banner', role: 'status' },
      el('span', { class: 'publish-banner__text' }, `✓ 確定済み（${when}・${pub.confirmedBy || ''}）`),
      el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: unconfirmShift }, '確定を取り消す')
    );
  }

  // ---- スタッフ列の並べ替え（見出しをドラッグ。スマートフォンは長押ししてから） ----
  // 並び順はシフト表の表示だけに使う（店舗ごとに保存。スタッフ・シフトの記録は変えない）

  const LONG_PRESS_MS = 400;
  const EDGE = 48; // 表の端からこの幅に来たら、表を横にスクロールする
  let drag = null;

  function staffHeads() {
    return view && view.table ? [...view.table.querySelectorAll('thead th.roster__staff')] : [];
  }

  // index 番目のスタッフの列のマス（見出し・各日・下の合計）。どの行も「日付・スタッフ…・人数」の順なので、左から index + 1 番目
  function columnCells(index) {
    return view && view.table && index >= 0 ? [...view.table.rows].map((tr) => tr.cells[index + 1]).filter(Boolean) : [];
  }

  // マウス・ペン：押したまま少し動かしたら始める（指のときは onHeadTouchStart）
  function onHeadPointerDown(e) {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    beginDrag(e.currentTarget, e.clientX, e.clientY, false);
  }

  // タッチ：動かさずに長押ししたら始める（すぐ動かしたときは、今までどおり表のスクロール）
  function onHeadTouchStart(e) {
    if (e.touches.length !== 1) return;
    beginDrag(e.currentTarget, e.touches[0].clientX, e.touches[0].clientY, true);
  }

  function beginDrag(th, x, y, touch) {
    cancelDrag();
    drag = { th, id: th.dataset.staff, wrap: th.closest('.roster-wrap'), startX: x, startY: y, x, touch, active: false, target: -1, edge: 0, timer: null };
    if (touch) {
      drag.timer = setTimeout(activateDrag, LONG_PRESS_MS);
      window.addEventListener('touchmove', onDragTouchMove, { passive: false });
      window.addEventListener('touchend', finishDrag);
      window.addEventListener('touchcancel', cancelDrag);
    } else {
      window.addEventListener('pointermove', onDragPointerMove);
      window.addEventListener('pointerup', finishDrag);
      window.addEventListener('pointercancel', cancelDrag);
    }
    window.addEventListener('keydown', onDragKey);
  }

  function activateDrag() {
    if (!drag) return;
    drag.active = true;
    // 見出しは点滅して浮き上がり、列のマスは半透明にする。差し込む位置には表の高さいっぱいの縦線
    drag.th.classList.add('is-dragging', 'is-lifted');
    for (const c of columnCells(staffHeads().indexOf(drag.th))) if (c !== drag.th) c.classList.add('is-drag-col');
    drag.line = el('div', { class: 'roster-drop-line', 'aria-hidden': 'true' });
    drag.wrap.append(drag.line);
    document.body.classList.add('is-column-dragging');
    if (drag.touch && navigator.vibrate) navigator.vibrate(10);
    updateDropTarget();
    requestAnimationFrame(edgeScroll);
  }

  function onDragPointerMove(e) {
    if (!drag) return;
    drag.x = e.clientX;
    if (!drag.active && Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 6) activateDrag();
    if (drag.active) updateDropTarget();
  }

  function onDragTouchMove(e) {
    if (!drag) return;
    const t = e.touches[0];
    if (!drag.active) {
      // 長押しの前に指が動いたら、並べ替えはやめて、スクロールに任せる
      if (Math.abs(t.clientX - drag.startX) + Math.abs(t.clientY - drag.startY) > 10) cancelDrag();
      return;
    }
    e.preventDefault();
    drag.x = t.clientX;
    updateDropTarget();
  }

  // 指（マウス）の位置から、差し込む位置（0〜列の数）を決めて、線を出す
  function updateDropTarget() {
    const heads = staffHeads();
    let target = heads.length;
    for (let i = 0; i < heads.length; i++) {
      const r = heads[i].getBoundingClientRect();
      if (drag.x < r.left + r.width / 2) {
        target = i;
        break;
      }
    }
    drag.target = target;
    heads.forEach((h, i) => {
      h.classList.toggle('is-drop-before', i === target);
      h.classList.toggle('is-drop-after', target === heads.length && i === heads.length - 1);
    });
    if (drag.line && heads.length) {
      const last = heads[heads.length - 1];
      const x = view.table.offsetLeft + (target < heads.length ? heads[target].offsetLeft : last.offsetLeft + last.offsetWidth);
      drag.line.style.left = `${x - 2}px`;
      drag.line.style.height = `${view.table.offsetHeight}px`;
    }
    const box = drag.wrap.getBoundingClientRect();
    const left = box.left + (view.table.querySelector('.roster__corner') || { offsetWidth: 0 }).offsetWidth;
    drag.edge = drag.x < left + EDGE ? -1 : drag.x > box.right - EDGE ? 1 : 0;
  }

  function edgeScroll() {
    if (!drag || !drag.active) return;
    if (drag.edge) {
      drag.wrap.scrollLeft += drag.edge * 8;
      updateDropTarget();
    }
    requestAnimationFrame(edgeScroll);
  }

  function onDragKey(e) {
    if (e.key === 'Escape') cancelDrag();
  }

  function finishDrag() {
    const d = drag;
    cancelDrag();
    if (!d || !d.active || d.target < 0) return;
    const ids = view.staff.map((m) => m.id);
    const from = ids.indexOf(d.id);
    const to = d.target > from ? d.target - 1 : d.target;
    if (from < 0 || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    saveColumnOrder(ids, '並び順を保存しました', d.id);
  }

  function cancelDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    window.removeEventListener('touchmove', onDragTouchMove, { passive: false });
    window.removeEventListener('touchend', finishDrag);
    window.removeEventListener('touchcancel', cancelDrag);
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', finishDrag);
    window.removeEventListener('pointercancel', cancelDrag);
    window.removeEventListener('keydown', onDragKey);
    for (const h of staffHeads()) h.classList.remove('is-dragging', 'is-lifted', 'is-drop-before', 'is-drop-after');
    if (view && view.table) for (const c of view.table.querySelectorAll('.is-drag-col')) c.classList.remove('is-drag-col');
    if (drag.line) drag.line.remove();
    document.body.classList.remove('is-column-dragging');
    drag = null;
  }

  // キーボード：見出しを選んで Alt＋←／→ で1つずつ動かす
  function onHeadKey(e) {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const ids = view.staff.map((m) => m.id);
    const from = ids.indexOf(e.currentTarget.dataset.staff);
    const to = from + (e.key === 'ArrowLeft' ? -1 : 1);
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    saveColumnOrder(ids, '並び順を保存しました', ids[to]);
    const moved = view.table.querySelector(`th.roster__staff[data-staff="${ids[to]}"]`);
    if (moved) moved.focus();
  }

  // 並べ替えたあと、動かした列を少しの間だけ成功の色で光らせる
  const MOVED_MS = 1600;
  function flashMoved(id) {
    const cells = columnCells(view.staff.findIndex((m) => m.id === id));
    for (const c of cells) c.classList.add('is-just-moved');
    setTimeout(() => cells.forEach((c) => c.classList.remove('is-just-moved')), MOVED_MS);
  }

  // 保存して表を作り直す（スクロール位置はそのまま）。movedId を渡すと、その列を光らせる
  function saveColumnOrder(ids, message, movedId) {
    const wrap = document.querySelector('.roster-wrap');
    const pos = wrap ? [wrap.scrollLeft, wrap.scrollTop] : null;
    try {
      K.storage.setRosterOrder(view.store.id, ids);
    } catch (err) {
      K.app.toast(err.message);
      return;
    }
    K.app.rerender();
    const next = document.querySelector('.roster-wrap');
    if (next && pos) [next.scrollLeft, next.scrollTop] = pos;
    if (movedId) flashMoved(movedId);
    K.app.toast(message);
  }

  function resetColumnOrder() {
    if (!window.confirm('スタッフの列の並びを、設定（スタッフ）の並び順に戻します。よろしいですか？')) return;
    saveColumnOrder([], '並び順を元に戻しました');
  }

  // ---- 画面全体 ----

  function toolbar(month, store) {
    const pub = K.storage.getPublication(store.id, month);
    const autoCount = K.storage.autoShiftCount(store.id, month);
    return el(
      'div',
      { class: 'roster-toolbar' },
      el(
        'div',
        { class: 'month-nav' },
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の月', onclick: () => K.app.setMonth(shiftMonth(month, -1)) }, '◀'),
        el('h2', { class: 'month-nav__label' }, `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`),
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の月', onclick: () => K.app.setMonth(shiftMonth(month, 1)) }, '▶')
      ),
      // 店舗の切り替えは、画面上部（ヘッダー）で行う
      el('span', { class: 'store-tag', style: { '--store-color': store.color } }, store.name),
      el(
        'div',
        { class: 'roster-toolbar__actions' },
        checkButton(),
        absenceButton(),
        el('button', { type: 'button', class: 'check-btn export-btn', onclick: openExportSheet }, '出力'),
        pub ? null : el('button', { type: 'button', class: 'check-btn weekly-btn', onclick: applyWeekly }, '曜日の設定を反映'),
        pub ? null : el('button', { type: 'button', class: 'check-btn tool-btn ai-btn', onclick: openAutoSheet }, 'AIで作成'),
        !pub && autoCount ? el('button', { type: 'button', class: 'check-btn tool-btn undo-auto-btn', onclick: undoAuto }, `自動作成を取り消す（${autoCount}）`) : null,
        pub ? null : el('button', { type: 'button', class: 'check-btn tool-btn confirm-btn', onclick: confirmShift }, 'シフトを確定'),
        store.rosterOrder && store.rosterOrder.length
          ? el('button', { type: 'button', class: 'check-btn tool-btn order-reset-btn', onclick: resetColumnOrder }, '並び順を元に戻す')
          : null
      )
    );
  }

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1 + delta, 1)).slice(0, 7);
  }

  function render(container) {
    closeSheet(false);
    const store = K.app.currentStore();
    const storeId = store.id;
    const month = K.app.state.month;
    const dates = K.calc.monthDates(month);

    view = {
      month,
      store,
      dates,
      // 列の並びは、シフト表で並べ替えた順（店舗ごと）
      staff: K.calc.rosterStaff(storeId, month).sort(K.storage.compareRosterStaff(storeId)),
      map: K.calc.shiftMap(month, storeId),
      closed: new Set(dates.filter((d) => K.calc.isStoreClosed(store, d))),
      check: K.rules.checkMonth(storeId, month),
      table: null,
    };

    container.append(toolbar(month, store));
    const pub = K.storage.getPublication(storeId, month);
    if (pub) container.append(publishBanner(pub));

    if (view.staff.length === 0) {
      container.append(
        el(
          'div',
          { class: 'empty-row' },
          el('p', null, `${store.name}のスタッフがまだ登録されていません。`),
          el('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => K.app.navigate('settings') }, '設定でスタッフを登録する')
        )
      );
      return;
    }

    const head = el(
      'thead',
      null,
      el(
        'tr',
        null,
        el('th', { class: 'roster__corner', scope: 'col' }, '日付'),
        view.staff.map((m) =>
          el(
            'th',
            {
              class: `roster__staff${m.active ? '' : ' is-inactive'}`,
              scope: 'col',
              'data-staff': m.id,
              tabindex: '0',
              title: 'ドラッグで左右に並べ替え（スマートフォンは長押ししてから動かす）',
              onpointerdown: onHeadPointerDown,
              ontouchstart: onHeadTouchStart,
              onkeydown: onHeadKey,
              oncontextmenu: (e) => e.preventDefault(),
            },
            el('span', { class: 'roster__staff-name' }, m.name),
            el(
              'span',
              { class: 'roster__staff-meta' },
              // 戦力外の人は St／As に数えないので、その印にする
              m.excludeFromCount
                ? el('span', { class: 'role-badge role-badge--excluded', title: '戦力外（人数に数えない）' }, '外')
                : el('span', { class: `role-badge role-badge--${m.role}` }, U.ROLE_SHORT[m.role]),
              m.title ? el('span', { class: 'roster__staff-title' }, m.title) : null
            )
          )
        ),
        el('th', { class: 'roster__count roster__count--st roster__count-head', scope: 'col', title: 'スタイリスト' }, 'St'),
        el('th', { class: 'roster__count roster__count--as roster__count-head', scope: 'col', title: 'アシスタント' }, 'As'),
        el('th', { class: 'roster__count roster__count--total roster__count-head', scope: 'col', title: '合計' }, '計')
      )
    );

    view.table = el(
      'table',
      { class: 'roster', style: { '--store-color': store.color } },
      el('caption', { class: 'visually-hidden' }, `${store.name} ${month} のシフト表`),
      head,
      el('tbody', null, dates.map(dateRow)),
      footer()
    );

    container.append(
      el('div', { class: 'roster-wrap' }, view.table),
      el(
        'p',
        { class: 'roster-legend' },
        el('span', { class: 'legend-chip cell--off' }, '休'),
        '通常休',
        el('span', { class: 'legend-chip cell--paid' }, '有'),
        '有給',
        el('span', { class: 'legend-chip cell--business', style: { '--pattern-color': '#64748b' } }, el('span', { class: 'cell__tag' }, '社')),
        '社用（人数に含めない）',
        el('span', { class: 'legend-chip cell--closed' }, '定休'),
        '定休日（通常休として数えます）',
        el('span', { class: 'legend-chip legend-chip--dot' }, el('span', { class: 'legend-dot', 'aria-hidden': 'true' })),
        '休憩・社用時間あり',
        K.storage.isCloud() ? el('span', { class: 'legend-chip legend-chip--wish' }, el('span', { class: 'cell__wish' }, '希')) : null,
        K.storage.isCloud() ? 'スタッフの希望休' : null,
        '　日付をタップすると1日の詳細'
      )
    );
  }

  K.screens = K.screens || {};
  K.screens.roster = {
    render,
    closeSheet,
    cleanup: () => {
      cancelDrag();
      closeSheet(false);
    },
  };
})();
