// 集計の計算を担当するファイル
// 画面のファイルは、人数や日数を自分で数えず、ここの関数を使う。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const SLOT_MINUTES = 30; // 時間帯別の人数の刻み

  // "2026-10" → その月の日付の一覧 ["2026-10-01", …]
  function monthDates(month) {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const list = [];
    for (let d = 1; d <= days; d++) list.push(`${month}-${String(d).padStart(2, '0')}`);
    return list;
  }

  function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }

  // 店舗の定休日か（毎週の曜日と、第○週の○曜日）
  function isStoreClosed(store, dateStr) {
    const w = weekdayOf(dateStr);
    if (store.closedWeekdays.includes(w)) return true;
    const nth = (store.closedNthWeekdays || []).find((x) => x.weekday === w);
    return Boolean(nth && nth.weeks.includes(U.nthWeekOf(dateStr)));
  }

  // 人数（St／As）や必要人数のチェックに数える人か（「戦力外」の人は数えない。シフト表には表示する）
  function countsAsStaff(member) {
    return !member.excludeFromCount;
  }

  // シフト表に出すスタッフ：その店舗に所属する在籍中の人 ＋ その月にその店舗のシフトが入っている人
  // （在籍していない人や、ほかの店舗に移った人も、その店舗での記録がある月は表示する）
  function rosterStaff(storeId, month) {
    const withShifts = new Set(K.storage.getShifts({ month, storeId }).map((s) => s.staffId));
    return K.storage.getStaff({ includeInactive: true }).filter((m) => (m.storeId === storeId && m.active) || withShifts.has(m.id));
  }

  // シフトを「スタッフID|日付」で引けるようにする（storeId を渡すと、その店舗の勤務だけ）
  function shiftMap(month, storeId) {
    const map = new Map();
    for (const s of K.storage.getShifts({ month, storeId })) map.set(`${s.staffId}|${s.date}`, s);
    return map;
  }

  // 1日の人数：{ stylist, assistant, total, business }
  // stylist / assistant / total は「通常勤務」の人（予約を受けられる人）だけを数える。
  // 社用の人は business に別に数える。
  function dailyCounts(staffList, map, dateStr) {
    const counts = { stylist: 0, assistant: 0, total: 0, business: 0 };
    for (const member of staffList) {
      const shift = map.get(`${member.id}|${dateStr}`);
      if (!shift) continue;
      if (shift.kind === 'work') {
        if (!countsAsStaff(member)) continue;
        counts[member.role] += 1;
        counts.total += 1;
      } else if (shift.kind === 'business') {
        counts.business += 1;
      }
    }
    return counts;
  }

  // ---- 日の区分と必要人数 ----

  // その日の情報：{ holiday（祝日名 or null）, dayType（'weekday' / 'holiday'）, naturalType（上書き前の区分）,
  //                 override（日付ごとの上書き or null）, bands（その日の必要人数の時間帯）, closed（定休日か） }
  // 土曜・日曜・祝日は「土日祝」。日付ごとの上書きがあれば、そちらを使う。
  function dayInfo(store, dateStr) {
    const holiday = K.holidays.holidayName(dateStr);
    const w = weekdayOf(dateStr);
    const naturalType = holiday || w === 0 || w === 6 ? 'holiday' : 'weekday';
    const override = K.storage.getDayOverride(store.id, dateStr);
    const dayType = override && override.mode === 'type' ? override.dayType : naturalType;
    const bands =
      override && override.mode === 'custom' ? override.bands : K.storage.getStaffingRules({ storeId: store.id, dayType });
    return { holiday, dayType, naturalType, override, bands, closed: isStoreClosed(store, dateStr) };
  }

  // 1日の実働時間（分）：勤務時間 − 休憩
  // 休憩の時刻を設定した日はその時間を、設定していない日は勤務パターンの休憩の長さを引く
  function workMinutes(day) {
    const span = day.end - day.start;
    if (day.breaks.length) return span - day.breaks.reduce((sum, b) => sum + (b.end - b.start), 0);
    return span - day.pattern.breakMinutes;
  }

  // ---- 1日の詳細 ----

  function toRange(start, end) {
    return { start: U.toMinutes(start), end: U.toMinutes(end) };
  }

  // 1人の1日の勤務・休憩・社用時間（分に直したもの）
  // 戻り値：null（勤務なし）または
  // { member, shift, pattern, kind, start, end,
  //   breaks: [{ start, end }],
  //   business: [{ start, end, source: 'date'|'weekly', id, note, skipped }] ← 勤務時間に重なる部分だけ }
  // 毎週の社用時間は、その日が通常勤務のときだけ反映する（休みの日は無視）
  function staffDay(member, shift, dateStr) {
    if (!shift || (shift.kind !== 'work' && shift.kind !== 'business')) return null;
    const pattern = K.storage.getPattern(shift.patternId);
    if (!pattern) return null;
    const day = { member, shift, pattern, kind: shift.kind, ...toRange(pattern.start, pattern.end), breaks: [], business: [] };
    if (shift.kind !== 'work') return day;

    day.breaks = (shift.breaks || []).map((b) => toRange(b.start, b.end));

    const weekday = weekdayOf(dateStr);
    for (const bt of K.storage.getBusinessTimes({ staffId: member.id })) {
      const applies =
        bt.type === 'date'
          ? bt.date === dateStr
          : bt.weekday === weekday && (!bt.validFrom || bt.validFrom <= dateStr) && (!bt.validTo || dateStr <= bt.validTo);
      if (!applies) continue;
      // 勤務時間に重なる部分だけにする
      const start = Math.max(U.toMinutes(bt.start), day.start);
      const end = Math.min(U.toMinutes(bt.end), day.end);
      if (start >= end) continue;
      day.business.push({
        start,
        end,
        source: bt.type,
        id: bt.id,
        note: bt.note,
        skipped: bt.type === 'weekly' && K.storage.isBusinessTimeSkipped(bt.id, dateStr),
      });
    }
    day.business.sort((a, b) => a.start - b.start);
    return day;
  }

  // 休憩・社用時間が設定されている日か（シフト表の印に使う）
  function hasTimeDetails(member, shift, dateStr) {
    const day = staffDay(member, shift, dateStr);
    return Boolean(day && (day.breaks.length || day.business.some((b) => !b.skipped)));
  }

  // 30分ごとの人数
  // 戻り値：{
  //   slots: [{ start, end, stylist, assistant, total, excluded: [{ name, reason: '休憩'|'社用' }] }],
  //   days: [staffDay の結果（勤務・社用の人）],
  //   business: [終日社用の人の名前と時間],
  // }
  // その30分をすべて通常勤務している人を数える。休憩・社用時間に少しでも重なる人は除く。
  // 表示する範囲は、営業時間・その日の勤務時間・必要人数の時間帯が入る範囲。
  // 各枠には必要人数（req）と、不足・過多（shortSt / shortAs / overSt / overAs）も付ける（定休日は付けない）。
  function slotCounts(staffList, map, dateStr, store) {
    const days = staffList.map((m) => staffDay(m, map.get(`${m.id}|${dateStr}`), dateStr)).filter(Boolean);
    const working = days.filter((d) => d.kind === 'work');
    const info = dayInfo(store, dateStr);
    const bands = info.closed ? [] : info.bands.map((b) => ({ ...b, ...toRange(b.start, b.end) }));

    let from = U.toMinutes(store.open);
    let to = U.toMinutes(store.close);
    for (const d of [...days, ...bands]) {
      from = Math.min(from, d.start);
      to = Math.max(to, d.end);
    }
    // 15分単位の勤務（例 8:15 出勤）があっても、枠の区切りは 8:00・8:30 のような30分ちょうどにそろえる
    from = Math.floor(from / SLOT_MINUTES) * SLOT_MINUTES;
    to = Math.ceil(to / SLOT_MINUTES) * SLOT_MINUTES;

    const slots = [];
    for (let t = from; t + SLOT_MINUTES <= to; t += SLOT_MINUTES) {
      const range = { start: t, end: t + SLOT_MINUTES };
      const slot = { start: U.fromMinutes(t), end: U.fromMinutes(t + SLOT_MINUTES), stylist: 0, assistant: 0, total: 0, excluded: [] };
      for (const d of working) {
        if (!(d.start <= range.start && d.end >= range.end)) continue;
        if (d.breaks.some((b) => overlapsRange(b, range))) {
          slot.excluded.push({ name: d.member.name, reason: '休憩' });
        } else if (d.business.some((b) => !b.skipped && overlapsRange(b, range))) {
          slot.excluded.push({ name: d.member.name, reason: '社用' });
        } else if (!countsAsStaff(d.member)) {
          slot.excluded.push({ name: d.member.name, reason: '戦力外' });
        } else {
          slot[d.member.role] += 1;
          slot.total += 1;
        }
      }
      const band = bands.find((b) => b.start <= range.start && b.end >= range.end);
      slot.req = band ? { stMin: band.stMin, stMax: band.stMax, asMin: band.asMin, asMax: band.asMax } : null;
      slot.shortSt = Boolean(band) && slot.stylist < band.stMin;
      slot.shortAs = Boolean(band) && slot.assistant < band.asMin;
      slot.overSt = Boolean(band) && band.stMax !== null && slot.stylist > band.stMax;
      slot.overAs = Boolean(band) && band.asMax !== null && slot.assistant > band.asMax;
      slots.push(slot);
    }

    return {
      from,
      to,
      info,
      slots,
      days,
      business: days
        .filter((d) => d.kind === 'business')
        .map((d) => ({ name: d.member.name, role: d.member.role, start: d.pattern.start, end: d.pattern.end })),
    };
  }

  function overlapsRange(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  // スタッフ1人の月の合計：{ work（通常勤務）, business（社用）, off（通常休）, paid（有給）, blank（未入力） }
  // 定休日で何も入っていない日は、設定に合わせて通常休として数える
  function staffMonthTotals(member, map, dates, store) {
    const checks = K.storage.getChecks(store.id);
    // other：この店舗で働く曜日ではない日（2店舗で働く人の、ほかの店舗の曜日）。未入力には数えない
    const totals = { work: 0, business: 0, off: 0, paid: 0, blank: 0, other: 0 };
    const workDays = member.workWeekdays || [];
    for (const date of dates) {
      const shift = map.get(`${member.id}|${date}`);
      if (shift) totals[shift.kind] += 1;
      else if (checks.closedDayAsOff && isStoreClosed(store, date)) totals.off += 1;
      else if (workDays.length && !workDays.includes(weekdayOf(date))) totals.other += 1;
      else totals.blank += 1;
    }
    return totals;
  }

  // ---- スタッフ別・集計（Step5） ----

  function addDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1, d + delta));
  }

  // 1人の1日の実働時間（分）。勤務・社用でなければ 0
  function dayWorkMinutes(member, shift, dateStr) {
    const day = staffDay(member, shift, dateStr);
    return day ? workMinutes(day) : 0;
  }

  // スタッフ1人の月の詳細
  // 戻り値：{ rows: [{ date, shift, day, minutes }], totals（staffMonthTotals ＋ minutes）,
  //           weeks: [{ start（月曜）, end（日曜）, minutes }] ← 月をまたぐ週も7日分で数える }
  // storeId を渡すと、その店舗での勤務だけを数える（省略時は所属店舗）
  function staffMonthDetail(member, month, storeId = member.storeId) {
    const store = K.storage.getStore(storeId);
    const dates = monthDates(month);
    const map = shiftMap(month, storeId);
    const shiftAt = (date) =>
      date.startsWith(`${month}-`) ? map.get(`${member.id}|${date}`) || null : K.storage.getShift(member.id, date, storeId);

    const rows = dates.map((date) => {
      const shift = shiftAt(date);
      const day = staffDay(member, shift, date);
      return { date, shift, day, minutes: day ? workMinutes(day) : 0 };
    });
    const totals = { ...staffMonthTotals(member, map, dates, store), minutes: rows.reduce((sum, r) => sum + r.minutes, 0) };

    const mondays = [...new Set(dates.map((d) => addDays(d, -((weekdayOf(d) + 6) % 7))))];
    const weeks = mondays.map((monday) => {
      let minutes = 0;
      for (let i = 0; i < 7; i++) {
        const date = addDays(monday, i);
        minutes += dayWorkMinutes(member, shiftAt(date), date);
      }
      return { start: monday, end: addDays(monday, 6), minutes };
    });

    return { rows, totals, weeks };
  }

  // 店舗の月の合計
  // 戻り値：{ days: [{ date, closed, counts }], openDays（営業日数）, personDays（延べ出勤人数：通常勤務）,
  //           avgStylist, avgAssistant, avgTotal（営業日1日あたり） }
  // 店舗の月の合計（その店舗の勤務だけを数える）
  // 戻り値：{ days, openDays（営業日数）, personDays（延べ出勤人数：通常勤務）, businessDays（延べ社用日数）,
  //           paidDays（延べ有給日数）, totalMinutes（月間の実働時間の合計：通常勤務＋社用）,
  //           staffCount（在籍スタッフ数 { stylist, assistant, total }）, avgStylist, avgAssistant, avgTotal }
  function storeMonthSummary(storeId, month) {
    const store = K.storage.getStore(storeId);
    const staff = rosterStaff(storeId, month);
    const map = shiftMap(month, storeId);
    const days = monthDates(month).map((date) => ({ date, closed: isStoreClosed(store, date), counts: dailyCounts(staff, map, date) }));
    const open = days.filter((d) => !d.closed);
    const sum = (key) => open.reduce((s, d) => s + d.counts[key], 0);
    const avg = (key) => (open.length ? Math.round((sum(key) / open.length) * 10) / 10 : 0);

    let totalMinutes = 0;
    let businessDays = 0;
    let paidDays = 0;
    const byId = new Map(staff.map((m) => [m.id, m]));
    for (const s of map.values()) {
      const member = byId.get(s.staffId);
      if (!member) continue;
      if (s.kind === 'business') businessDays += 1;
      if (s.kind === 'paid') paidDays += 1;
      totalMinutes += dayWorkMinutes(member, s, s.date);
    }
    const current = K.storage.getStaff({ storeId });
    return {
      days,
      openDays: open.length,
      personDays: sum('total'),
      businessDays,
      paidDays,
      totalMinutes,
      staffCount: {
        stylist: current.filter((m) => countsAsStaff(m) && m.role === 'stylist').length,
        assistant: current.filter((m) => countsAsStaff(m) && m.role === 'assistant').length,
        total: current.length,
      },
      avgStylist: avg('stylist'),
      avgAssistant: avg('assistant'),
      avgTotal: avg('total'),
    };
  }

  K.calc = {
    SLOT_MINUTES,
    monthDates,
    weekdayOf,
    isStoreClosed,
    countsAsStaff,
    rosterStaff,
    shiftMap,
    dailyCounts,
    dayInfo,
    workMinutes,
    staffDay,
    hasTimeDetails,
    slotCounts,
    staffMonthTotals,
    staffMonthDetail,
    storeMonthSummary,
  };
})();
