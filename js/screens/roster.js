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
        wish ? el('span', { class: 'cell__wish', 'aria-hidden': 'true' }, '希') : null
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
    // 確定済みの月は、確定を取り消すまで入力できない
    if (K.storage.getPublication(view.store.id, view.month)) {
      K.app.toast('確定済みです。変更するときは「確定を取り消す」を押してください');
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
      result.summary.length
        ? el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              { class: 'data-table auto-table' },
              el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'is-left' }, 'スタッフ'), el('th', { scope: 'col' }, '勤務'), el('th', { scope: 'col' }, '休み'))),
              el(
                'tbody',
                null,
                result.summary.map((s) => el('tr', null, el('th', { scope: 'row', class: 'is-left' }, s.name), el('td', null, `${s.work}`), el('td', null, `${s.off}`)))
              )
            )
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
    try {
      K.storage.confirmMonth(view.store.id, view.month, whoAmI());
      K.app.rerender();
      K.app.toast('シフトを確定しました');
    } catch (err) {
      K.app.toast(err.message);
    }
  }

  function unconfirmShift() {
    if (!window.confirm('確定を取り消して、もう一度変更できるようにしますか？')) return;
    try {
      K.storage.unconfirmMonth(view.store.id, view.month);
      K.app.rerender();
      K.app.toast('確定を取り消しました');
    } catch (err) {
      K.app.toast(err.message);
    }
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
        el('button', { type: 'button', class: 'check-btn export-btn', onclick: openExportSheet }, '出力'),
        pub ? null : el('button', { type: 'button', class: 'check-btn weekly-btn', onclick: applyWeekly }, '曜日の設定を反映'),
        pub ? null : el('button', { type: 'button', class: 'check-btn tool-btn ai-btn', onclick: openAutoSheet }, 'AIで作成'),
        !pub && autoCount ? el('button', { type: 'button', class: 'check-btn tool-btn undo-auto-btn', onclick: undoAuto }, `自動作成を取り消す（${autoCount}）`) : null,
        pub ? null : el('button', { type: 'button', class: 'check-btn tool-btn confirm-btn', onclick: confirmShift }, 'シフトを確定')
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
      staff: K.calc.rosterStaff(storeId, month),
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
            { class: `roster__staff${m.active ? '' : ' is-inactive'}`, scope: 'col' },
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
  K.screens.roster = { render, closeSheet, cleanup: () => closeSheet(false) };
})();
