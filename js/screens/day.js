// 1日の詳細画面（タイムライン・30分ごとの人数・休憩と社用時間の編集）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;

  const KIND_LABELS = { off: '休', paid: '有' };

  // 編集シートを開いているスタッフ（画面を作り直しても開いたままにする）
  let editingStaffId = null;
  let lastParams = null;

  function shortDate(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${m}/${d}(${U.WEEKDAYS[K.calc.weekdayOf(dateStr)]})`;
  }

  function addDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1, d + delta));
  }

  function timeLabel(minutes) {
    return U.formatTime(U.fromMinutes(minutes));
  }

  function rangeLabel(r) {
    return `${timeLabel(r.start)}〜${timeLabel(r.end)}`;
  }

  // ---- 画面の上の操作 ----

  function toolbar(date, store) {
    const go = (delta) => K.app.navigate('day', { date: addDays(date, delta), storeId: store.id });
    return el(
      'div',
      { class: 'roster-toolbar' },
      el('button', { type: 'button', class: 'text-btn day-back', onclick: () => K.app.navigate('roster') }, '‹ シフト表'),
      el(
        'div',
        { class: 'month-nav' },
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '前の日', onclick: () => go(-1) }, '◀'),
        el('h2', { class: 'month-nav__label' }, shortDate(date)),
        el('button', { type: 'button', class: 'icon-btn icon-btn--round', 'aria-label': '次の日', onclick: () => go(1) }, '▶')
      ),
      // 店舗の切り替えは、画面上部（ヘッダー）で行う
      el('span', { class: 'store-tag', style: { '--store-color': store.color } }, store.name)
    );
  }

  // ---- タイムライン ----

  function segment(cls, range, from, span, title, style) {
    return el('span', {
      class: `tl-seg ${cls}`,
      style: { left: `${((range.start - from) / span) * 100}%`, width: `${((range.end - range.start) / span) * 100}%`, ...(style || {}) },
      title,
    });
  }

  function timeline(result, date, others) {
    const { from, to, days } = result;
    const span = to - from;
    const hours = [];
    for (let t = Math.ceil(from / 60) * 60; t <= to; t += 60) hours.push(t);
    const slotCount = span / K.calc.SLOT_MINUTES;

    const rows = days.map((d) => {
      const isWork = d.kind === 'work';
      const color = d.pattern.color;
      const segs = [];
      if (isWork) {
        segs.push(segment('tl-seg--work', d, from, span, `勤務 ${rangeLabel(d)}`, { '--pattern-color': color }));
        for (const b of d.breaks) segs.push(segment('tl-seg--break', b, from, span, `休憩 ${rangeLabel(b)}`));
        for (const b of d.business) {
          segs.push(
            segment(
              `tl-seg--business${b.skipped ? ' is-skipped' : ''}`,
              b,
              from,
              span,
              `社用 ${rangeLabel(b)}${b.source === 'weekly' ? '（毎週）' : ''}${b.skipped ? '（この日は取り消し）' : ''}`
            )
          );
        }
      } else {
        segs.push(segment('tl-seg--business-day', d, from, span, `終日社用 ${rangeLabel(d)}`, { '--pattern-color': color }));
      }

      const name = el(
        'span',
        { class: 'tl-name__inner' },
        el('span', { class: 'tl-name__text' }, d.member.name),
        el('span', { class: `role-badge role-badge--${d.member.role}` }, U.ROLE_SHORT[d.member.role])
      );

      return el(
        'div',
        { class: 'tl-row', role: 'listitem' },
        isWork
          ? el(
              'button',
              {
                type: 'button',
                class: 'tl-name tl-name--btn',
                'data-staff': d.member.id,
                'aria-label': `${d.member.name}さんの休憩・社用時間を編集（${rangeLabel(d)}）`,
                onclick: () => openEditor(d.member.id),
              },
              name,
              el('span', { class: 'tl-name__edit', 'aria-hidden': 'true' }, '編集')
            )
          : el('div', { class: 'tl-name' }, name, el('span', { class: 'tl-name__edit' }, '終日社用')),
        el('div', { class: 'tl-track', style: { '--slots': String(slotCount) } }, segs)
      );
    });

    return el(
      'section',
      { class: 'card day-card' },
      el('h3', { class: 'card__title' }, 'タイムライン'),
      el(
        'p',
        { class: 'tl-legend' },
        el('span', { class: 'tl-key tl-seg--work', style: { '--pattern-color': '#64748b' } }),
        '勤務',
        el('span', { class: 'tl-key tl-seg--break' }),
        '休憩',
        el('span', { class: 'tl-key tl-seg--business' }),
        '社用',
        el('span', { class: 'tl-legend__note' }, '名前をタップして休憩・社用時間を編集')
      ),
      days.length
        ? el(
            'div',
            { class: 'tl-wrap' },
            el(
              'div',
              { class: 'tl', style: { '--slots': String(slotCount) } },
              el(
                'div',
                { class: 'tl-row tl-row--head', 'aria-hidden': 'true' },
                el('div', { class: 'tl-name' }),
                el(
                  'div',
                  { class: 'tl-track tl-track--head' },
                  hours.map((t) =>
                    el('span', { class: `tl-hour${t === from ? ' tl-hour--first' : ''}`, style: { left: `${((t - from) / span) * 100}%` } }, String(t / 60))
                  )
                )
              ),
              el('div', { role: 'list' }, rows)
            )
          )
        : el('p', { class: 'hint' }, 'この日は勤務している人がいません。'),
      others.length ? el('p', { class: 'day-others' }, others.join('　')) : null
    );
  }

  // ---- 30分ごとの人数 ----

  function reqText(min, max) {
    return max === null || max === undefined ? String(min) : `${min}〜${max}`;
  }

  function slotTable(result) {
    const roleCls = (short, over) => (short ? 'is-short' : over ? 'is-over' : null);
    return el(
      'section',
      { class: 'card day-card' },
      el('h3', { class: 'card__title' }, '30分ごとの人数'),
      el(
        'p',
        { class: 'hint' },
        'その30分をすべて通常勤務している人数です。休憩・社用時間に重なる人は除きます。△＝必要人数より少ない、＋＝上限より多い。'
      ),
      el(
        'div',
        { class: 'slots-wrap' },
        el(
          'table',
          { class: 'slots' },
          el(
            'thead',
            null,
            el(
              'tr',
              null,
              el('th', { scope: 'col' }, '時間'),
              el('th', { scope: 'col' }, 'St'),
              el('th', { scope: 'col' }, 'As'),
              el('th', { scope: 'col' }, '計'),
              el('th', { scope: 'col', class: 'slots__req-head' }, '必要 St / As'),
              el('th', { scope: 'col', class: 'slots__excluded-head' }, '人数から除いた人')
            )
          ),
          el(
            'tbody',
            null,
            result.slots.map((s) => {
              const short = s.shortSt || s.shortAs;
              const over = s.overSt || s.overAs;
              const rowCls = [s.total === 0 ? 'is-zero' : '', short ? 'is-short' : '', over ? 'is-over' : ''].filter(Boolean).join(' ');
              return el(
                'tr',
                { class: rowCls || null },
                el('th', { scope: 'row' }, `${U.formatTime(s.start)}〜`),
                el('td', { class: roleCls(s.shortSt, s.overSt) }, String(s.stylist)),
                el('td', { class: roleCls(s.shortAs, s.overAs) }, String(s.assistant)),
                el(
                  'td',
                  { class: 'slots__total' },
                  String(s.total),
                  short || over ? el('span', { class: 'roster__mark' }, `${short ? '△' : ''}${over ? '＋' : ''}`) : null
                ),
                el('td', { class: 'slots__req' }, s.req ? `${reqText(s.req.stMin, s.req.stMax)} / ${reqText(s.req.asMin, s.req.asMax)}` : '—'),
                el('td', { class: 'slots__excluded' }, s.excluded.map((x) => `${x.name}（${x.reason}）`).join('、'))
              );
            })
          )
        )
      )
    );
  }

  // ---- この日の必要人数（日付ごとの上書き） ----

  function requirementCard(store, date, info) {
    const L = K.staffingUI.DAY_TYPE_LABELS;
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

    const override = info.override;
    const isCustom = override && override.mode === 'custom';
    const other = info.naturalType === 'weekday' ? 'holiday' : 'weekday';

    let source;
    if (isCustom) source = 'この日だけの必要人数を使っています。';
    else if (override) source = `この日だけ「${L[info.dayType]}」の必要人数を使っています（本来は${L[info.naturalType]}）。`;
    else source = `「${L[info.dayType]}」の必要人数を使っています。`;

    const bandList = info.bands.length
      ? el(
          'ul',
          { class: 'detail-list' },
          info.bands.map((b, i) =>
            el(
              'li',
              { class: 'detail-item' },
              el('span', { class: 'detail-item__text' }, `${U.formatTime(b.start)}〜${U.formatTime(b.end)}`, el('span', { class: 'detail-item__note' }, K.staffingUI.bandSummary(b))),
              isCustom
                ? el(
                    'button',
                    {
                      type: 'button',
                      class: 'detail-item__remove',
                      'aria-label': `${U.formatTime(b.start)}〜${U.formatTime(b.end)} を削除`,
                      onclick: () =>
                        run(() => K.storage.setDayOverride(store.id, date, { mode: 'custom', bands: info.bands.filter((_, j) => j !== i) }), '削除しました'),
                    },
                    '×'
                  )
                : null
            )
          )
        )
      : el('p', { class: 'hint' }, '必要人数が設定されていないので、人員不足・過多のチェックはしません。');

    let customAdd = null;
    if (isCustom) {
      const fields = K.staffingUI.bandFields('override', null);
      customAdd = el(
        'div',
        { class: 'band-add-box' },
        fields.node,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost btn--small',
            onclick: () =>
              run(() => K.storage.setDayOverride(store.id, date, { mode: 'custom', bands: [...info.bands, fields.read()] }), '追加しました'),
          },
          '時間帯を追加'
        )
      );
    }

    const actions = el(
      'div',
      { class: 'req-actions' },
      !isCustom
        ? el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost btn--small',
              onclick: () =>
                run(() => K.storage.setDayOverride(store.id, date, { mode: 'custom', bands: info.bands }), 'この日だけの設定にしました'),
            },
            'この日だけ個別に設定'
          )
        : null,
      !override || override.mode !== 'type'
        ? el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost btn--small',
              onclick: () => run(() => K.storage.setDayOverride(store.id, date, { mode: 'type', dayType: other }), `${L[other]}として扱います`),
            },
            `${L[other]}の設定を使う`
          )
        : null,
      override
        ? el(
            'button',
            { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => run(() => K.storage.clearDayOverride(store.id, date), '元に戻しました') },
            '元に戻す（設定どおり）'
          )
        : null
    );

    return el(
      'section',
      { class: 'card day-card' },
      el('h3', { class: 'card__title' }, 'この日の必要人数'),
      el('p', { class: 'hint' }, source),
      bandList,
      customAdd,
      actions,
      errorBox
    );
  }

  // ---- 休憩・社用時間の編集シート ----

  let sheet = null;

  function closeEditor() {
    editingStaffId = null;
    removeSheet(true);
  }

  function removeSheet(returnFocus) {
    if (!sheet) return;
    const staffId = sheet.staffId;
    sheet.root.remove();
    document.removeEventListener('keydown', onKeydown);
    sheet = null;
    if (returnFocus) {
      const btn = document.querySelector(`.tl-name--btn[data-staff="${staffId}"]`);
      if (btn) btn.focus({ preventScroll: true });
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') closeEditor();
  }

  function openEditor(staffId) {
    editingStaffId = staffId;
    K.app.rerender();
  }

  // 範囲を選ぶ2つの <select>（勤務時間の中だけ）
  function rangeSelects(idPrefix, day, defaults) {
    const start = U.timeSelect({ id: `${idPrefix}-start`, value: defaults.start, from: day.start, to: day.end - 30 });
    const end = U.timeSelect({ id: `${idPrefix}-end`, value: defaults.end, from: day.start + 30, to: day.end });
    return { start, end, node: el('div', { class: 'time-range' }, start, el('span', { class: 'time-range__sep' }, '〜'), end) };
  }

  function defaultRange(day, preferStart, length) {
    const start = Math.min(Math.max(preferStart, day.start), day.end - 30);
    const end = Math.min(start + length, day.end);
    return { start: U.fromMinutes(start), end: U.fromMinutes(end) };
  }

  function editor(day, date) {
    const member = day.member;
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

    const currentBreaks = day.breaks.map((b) => ({ start: U.fromMinutes(b.start), end: U.fromMinutes(b.end) }));

    // 休憩
    const breakSel = rangeSelects('break', day, defaultRange(day, 13 * 60, 60));
    const breakList = el(
      'ul',
      { class: 'detail-list' },
      day.breaks.length
        ? day.breaks.map((b, i) =>
            el(
              'li',
              { class: 'detail-item' },
              el('span', { class: 'detail-item__key tl-seg--break' }),
              el('span', { class: 'detail-item__text' }, rangeLabel(b)),
              el(
                'button',
                {
                  type: 'button',
                  class: 'detail-item__remove',
                  'aria-label': `休憩 ${rangeLabel(b)} を削除`,
                  onclick: () => run(() => K.storage.setShiftBreaks(member.id, date, currentBreaks.filter((_, j) => j !== i)), '休憩を削除しました'),
                },
                '×'
              )
            )
          )
        : el('li', { class: 'detail-item detail-item--empty' }, '設定なし（時間帯別の人数からは除きません）')
    );

    // 社用時間
    const bizSel = rangeSelects('biz', day, defaultRange(day, 14 * 60, 120));
    const noteInput = el('input', { id: 'biz-note', class: 'field__input', type: 'text', maxlength: '20', placeholder: 'メモ（任意）例：打ち合わせ' });
    const bizList = el(
      'ul',
      { class: 'detail-list' },
      day.business.length
        ? day.business.map((b) =>
            el(
              'li',
              { class: `detail-item${b.skipped ? ' is-skipped' : ''}` },
              el('span', { class: 'detail-item__key tl-seg--business' }),
              el(
                'span',
                { class: 'detail-item__text' },
                rangeLabel(b),
                b.source === 'weekly' ? el('span', { class: 'detail-item__badge' }, '毎週') : null,
                b.note ? el('span', { class: 'detail-item__note' }, b.note) : null,
                b.skipped ? el('span', { class: 'detail-item__note' }, 'この日は取り消し中') : null
              ),
              b.source === 'weekly'
                ? el(
                    'button',
                    {
                      type: 'button',
                      class: 'text-btn text-btn--small',
                      onclick: () =>
                        run(
                          () => K.storage.setBusinessTimeSkip(b.id, date, !b.skipped),
                          b.skipped ? '取り消しを戻しました' : 'この日だけ取り消しました'
                        ),
                    },
                    b.skipped ? '取り消しを戻す' : 'この日だけ取り消す'
                  )
                : el(
                    'button',
                    {
                      type: 'button',
                      class: 'detail-item__remove',
                      'aria-label': `社用時間 ${rangeLabel(b)} を削除`,
                      onclick: () => run(() => K.storage.deleteBusinessTime(b.id), '社用時間を削除しました'),
                    },
                    '×'
                  )
            )
          )
        : el('li', { class: 'detail-item detail-item--empty' }, '設定なし')
    );

    const panel = el(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      el(
        'div',
        { class: 'sheet__head' },
        el(
          'h2',
          { class: 'sheet__title', id: 'sheet-title' },
          `${member.name}さん`,
          el('span', { class: 'sheet__name' }, `${shortDate(date)}　${day.pattern.label}（${rangeLabel(day)}）`)
        ),
        el('button', { type: 'button', class: 'sheet__close', 'aria-label': '閉じる', onclick: closeEditor }, '×')
      ),

      el('p', { class: 'sheet__label' }, '休憩'),
      breakList,
      el(
        'div',
        { class: 'detail-add' },
        breakSel.node,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost btn--small',
            onclick: () =>
              run(
                () => K.storage.setShiftBreaks(member.id, date, [...currentBreaks, { start: breakSel.start.value, end: breakSel.end.value }]),
                '休憩を追加しました'
              ),
          },
          '休憩を追加'
        )
      ),

      el('p', { class: 'sheet__label' }, '社用時間（予約可能人数から除く）'),
      bizList,
      el(
        'div',
        { class: 'detail-add' },
        bizSel.node,
        noteInput,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost btn--small',
            onclick: () =>
              run(
                () =>
                  K.storage.addBusinessTime({
                    type: 'date',
                    staffId: member.id,
                    date,
                    start: bizSel.start.value,
                    end: bizSel.end.value,
                    note: noteInput.value,
                  }),
                '社用時間を追加しました'
              ),
          },
          'この日の社用時間を追加'
        )
      ),
      el('p', { class: 'sheet__note' }, '毎週決まった社用時間は「設定 > 毎週の社用」で登録します。'),
      errorBox
    );
    return panel;
  }

  function showEditor(result, date) {
    removeSheet(false);
    const day = result.days.find((d) => d.member.id === editingStaffId && d.kind === 'work');
    if (!day) {
      editingStaffId = null;
      return;
    }
    const panel = editor(day, date);
    const root = el('div', { class: 'sheet-layer' }, el('div', { class: 'sheet-backdrop', onclick: closeEditor }), panel);
    document.body.append(root);
    document.addEventListener('keydown', onKeydown);
    sheet = { root, staffId: day.member.id };
    panel.querySelector('.sheet__close').focus({ preventScroll: true });
  }

  // ---- 画面全体 ----

  function render(container, params) {
    removeSheet(false);
    if (params !== lastParams) {
      editingStaffId = params.staffId || null;
      lastParams = params;
    }

    const store = K.app.currentStore();
    const date = U.isValidDate(params.date) ? params.date : U.todayStr();
    const month = date.slice(0, 7);
    K.app.state.month = month; // シフト表に戻ったとき、この日の月を表示する

    const staff = K.calc.rosterStaff(store.id, month);
    const map = K.calc.shiftMap(month, store.id);
    const result = K.calc.slotCounts(staff, map, date, store);
    const n = K.calc.dailyCounts(staff, map, date);

    const others = [];
    const offs = [];
    const blanks = [];
    for (const m of staff) {
      const s = map.get(`${m.id}|${date}`);
      if (s && KIND_LABELS[s.kind]) offs.push(`${m.name}（${KIND_LABELS[s.kind]}）`);
      else if (!s && m.active) blanks.push(m.name);
    }
    if (offs.length) others.push(`休み：${offs.join('、')}`);
    if (blanks.length) others.push(`未入力：${blanks.join('、')}`);

    const closed = K.calc.isStoreClosed(store, date);

    container.append(
      toolbar(date, store),
      el(
        'p',
        { class: 'day-summary' },
        `${store.name}　営業 ${U.formatTime(store.open)}〜${U.formatTime(store.close)}`,
        closed ? el('span', { class: 'day-summary__closed' }, '定休日') : null,
        el('span', { class: 'day-summary__closed' }, K.staffingUI.DAY_TYPE_LABELS[result.info.dayType]),
        result.info.holiday ? el('span', { class: 'day-summary__holiday' }, result.info.holiday) : null,
        el('span', { class: 'day-summary__counts' }, `通常勤務 St ${n.stylist}・As ${n.assistant}・計 ${n.total}人`),
        n.business ? el('span', { class: 'day-summary__counts' }, `終日社用 ${n.business}人`) : null
      ),
      el(
        'div',
        { class: 'stack' },
        timeline(result, date, others),
        closed ? null : requirementCard(store, date, result.info),
        slotTable(result)
      )
    );

    if (editingStaffId) showEditor(result, date);
  }

  K.screens = K.screens || {};
  K.screens.day = { render, cleanup: () => removeSheet(false) };
})();
