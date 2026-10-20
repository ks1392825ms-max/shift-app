// 自動チェック（人員不足・過多・連勤・月の休日数・労働時間・パターン外・未入力）
// アプリは知らせるだけで、シフトを自動で直すことはしない。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const TYPES = [
    ['shortage', '人員不足'],
    ['over', '人員過多'],
    ['consecutive', '連勤'],
    ['offDays', '月の休日数'],
    ['dailyHours', '1日の労働時間'],
    ['weeklyHours', '1週の労働時間'],
    ['pattern', 'パターン外'],
    ['fixedOff', '固定休'],
    ['workDay', '勤務曜日外'],
    ['otherStore', '他店舗と重複'],
    ['outsideHours', '営業時間外'],
    ['weeklyOff', '週休'],
    ['earlyZero', '早番0人'],
    ['slotRepeat', '早早・遅遅'],
    ['blank', '未入力'],
  ];
  const TYPE_LABELS = Object.fromEntries(TYPES);

  function isAtWork(shift) {
    return Boolean(shift && (shift.kind === 'work' || shift.kind === 'business'));
  }

  function addDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1, d + delta));
  }

  // 勤務パターンの番（slot がなければ、9:00 までに始まるものを早番とする。autoshift.js と同じ）
  function slotOfPattern(p) {
    return p.slot || (U.toMinutes(p.start) <= 9 * 60 ? 'early' : 'late');
  }

  function slotOfShift(s) {
    if (!isAtWork(s) || !s.patternId) return null;
    const p = K.storage.getPattern(s.patternId);
    return p ? slotOfPattern(p) : null;
  }

  function mdLabel(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${m}/${d}`;
  }

  // 条件に合う30分の枠を、つながった時間帯にまとめる（例："14:00〜15:30、18:00〜19:00"）
  function rangesText(slots, test) {
    const ranges = [];
    for (const s of slots) {
      if (!test(s)) continue;
      const last = ranges[ranges.length - 1];
      if (last && last.end === s.start) last.end = s.end;
      else ranges.push({ start: s.start, end: s.end });
    }
    return ranges.map((r) => `${U.formatTime(r.start)}〜${U.formatTime(r.end)}`).join('、');
  }

  // 1か月分のチェック
  // 戻り値：{
  //   issues: [{ type, date?, staffId?, message }],
  //   dates: Map(日付 → { short, over, shortSt, shortAs, overSt, overAs }),
  //   cells: Map("スタッフID|日付" → [メッセージ]),
  //   offShort: Map(スタッフID → { off, target }),
  //   total: 未入力以外の件数, blank: 未入力の件数
  // }
  function checkMonth(storeId, month) {
    const checks = K.storage.getChecks(storeId);
    const store = K.storage.getStore(storeId);
    const dates = K.calc.monthDates(month);
    const staff = K.calc.rosterStaff(storeId, month);
    const map = K.calc.shiftMap(month, storeId);
    const result = { issues: [], dates: new Map(), cells: new Map(), offShort: new Map() };

    const addCell = (staffId, date, message) => {
      const key = `${staffId}|${date}`;
      if (!result.cells.has(key)) result.cells.set(key, []);
      result.cells.get(key).push(message);
    };
    // 月の外の日は保存データから読む（連勤・週の労働時間は月をまたぐため）
    const shiftAt = (staffId, date) => (date.startsWith(`${month}-`) ? map.get(`${staffId}|${date}`) || null : K.storage.getShift(staffId, date, storeId));

    // ---- 人員不足・過多（日ごと） ----
    for (const date of dates) {
      const sc = K.calc.slotCounts(staff, map, date, store);
      if (sc.info.closed) continue;
      const shortSlots = sc.slots.filter((s) => s.shortSt || s.shortAs);
      const overSlots = sc.slots.filter((s) => s.overSt || s.overAs);
      const flag = {
        short: shortSlots.length >= checks.shortageMinSlots,
        over: overSlots.length > 0,
        shortSt: shortSlots.some((s) => s.shortSt),
        shortAs: shortSlots.some((s) => s.shortAs),
        overSt: overSlots.some((s) => s.overSt),
        overAs: overSlots.some((s) => s.overAs),
      };
      if (flag.short) {
        const who = [flag.shortSt ? 'St' : null, flag.shortAs ? 'As' : null].filter(Boolean).join('・');
        result.issues.push({ type: 'shortage', date, message: `${who}不足　${rangesText(sc.slots, (s) => s.shortSt || s.shortAs)}` });
      }
      if (flag.over) {
        const who = [flag.overSt ? 'St' : null, flag.overAs ? 'As' : null].filter(Boolean).join('・');
        result.issues.push({ type: 'over', date, message: `${who}過多　${rangesText(sc.slots, (s) => s.overSt || s.overAs)}` });
      }
      result.dates.set(date, flag);
    }

    // ---- 早番0人（日ごと）：出勤している人（人数に数える人）が全員遅番の日。早番の勤務パターンを持つ人がいる店舗だけ ----
    const usesEarly = staff.some((m) => K.calc.countsAsStaff(m) && (m.patternIds || []).some((id) => {
      const p = K.storage.getPattern(id);
      return p && !p.deleted && slotOfPattern(p) === 'early';
    }));
    if (usesEarly) {
      for (const date of dates) {
        if (K.calc.isStoreClosed(store, date)) continue;
        const working = staff.filter((m) => K.calc.countsAsStaff(m) && slotOfShift(map.get(`${m.id}|${date}`)));
        if (working.length && !working.some((m) => slotOfShift(map.get(`${m.id}|${date}`)) === 'early')) {
          result.issues.push({ type: 'earlyZero', date, message: `早番0人（出勤${working.length}人がすべて遅番）` });
        }
      }
    }

    // ---- スタッフごと ----
    for (const member of staff) {
      // 連勤（月の前から続いている分も数える）
      let streak = 0;
      for (let d = addDays(dates[0], -1); streak <= 62 && isAtWork(shiftAt(member.id, d)); d = addDays(d, -1)) streak += 1;
      let runStart = streak ? addDays(dates[0], -streak) : null;
      let runIssue = null;
      for (const date of dates) {
        if (isAtWork(map.get(`${member.id}|${date}`))) {
          if (streak === 0) runStart = date;
          streak += 1;
          if (streak > checks.maxConsecutiveDays) {
            const message = `${member.name}さん　${mdLabel(runStart)}から${streak}連勤（上限${checks.maxConsecutiveDays}日）`;
            if (!runIssue) {
              runIssue = { type: 'consecutive', date, staffId: member.id, message };
              result.issues.push(runIssue);
            } else {
              runIssue.message = message;
            }
            addCell(member.id, date, `連勤${streak}日目`);
          }
        } else {
          streak = 0;
          runIssue = null;
        }
      }

      // 月の休日数（目安より少ないときだけ）。本人の月の休日数があれば、そちらを使う
      const totals = K.calc.staffMonthTotals(member, map, dates, store);
      const off = totals.off + (checks.countPaidLeaveAsOff ? totals.paid : 0);
      const offTarget = Number.isInteger(member.monthlyOffDays) ? member.monthlyOffDays : checks.monthlyOffDays;
      if (off < offTarget) {
        result.offShort.set(member.id, { off, target: offTarget });
        const blankNote = totals.blank ? `・未入力${totals.blank}日` : '';
        result.issues.push({
          type: 'offDays',
          staffId: member.id,
          message: `${member.name}さん　休日${off}日（目安${offTarget}日）${blankNote}`,
        });
      }

      // 早早・遅遅（前日も勤務で同じ番。休みを挟んだら数えない）。パートと、早番・遅番の片方しか使えない人は確かめない
      const mySlots = new Set((member.patternIds || []).map((id) => K.storage.getPattern(id)).filter((p) => p && !p.deleted).map(slotOfPattern));
      if (member.employment !== 'part' && mySlots.size === 2) {
        let rep = null;
        for (const date of dates) {
          const prev = addDays(date, -1);
          const sl = slotOfShift(map.get(`${member.id}|${date}`));
          if (sl && slotOfShift(shiftAt(member.id, prev)) === sl) {
            const label = sl === 'early' ? '早番' : '遅番';
            if (rep && rep.slot === sl && rep.last === prev) {
              rep.days += 1;
              rep.last = date;
              rep.issue.message = `${member.name}さん　${label}が${rep.days}日続く（${mdLabel(rep.first)}〜${mdLabel(date)}）`;
            } else {
              const issue = { type: 'slotRepeat', date, staffId: member.id, message: `${member.name}さん　${label}が2日続く（${mdLabel(prev)}〜${mdLabel(date)}）` };
              result.issues.push(issue);
              rep = { slot: sl, first: prev, last: date, days: 2, issue };
            }
            addCell(member.id, date, sl === 'early' ? '早早' : '遅遅');
          }
        }
      }

      // 未入力
      if (totals.blank > 0) {
        result.issues.push({ type: 'blank', staffId: member.id, message: `${member.name}さん　${totals.blank}日` });
      }

      // パターン外・1日の労働時間
      for (const date of dates) {
        const shift = map.get(`${member.id}|${date}`);
        if (!isAtWork(shift)) continue;
        if (!member.patternIds.includes(shift.patternId)) {
          const p = K.storage.getPattern(shift.patternId);
          result.issues.push({
            type: 'pattern',
            date,
            staffId: member.id,
            message: `${member.name}さん　${p ? p.label : '?'} は登録されていない勤務パターンです`,
          });
          addCell(member.id, date, 'パターン外');
        }
        if (checks.hoursCheckEnabled) {
          const day = K.calc.staffDay(member, shift, date);
          const minutes = day ? K.calc.workMinutes(day) : 0;
          if (minutes > checks.dailyHoursLimit * 60) {
            result.issues.push({
              type: 'dailyHours',
              date,
              staffId: member.id,
              message: `${member.name}さん　実働${U.formatHours(minutes)}（目安${checks.dailyHoursLimit}時間）`,
            });
            addCell(member.id, date, `実働${U.formatHours(minutes)}`);
          }
        }
      }

      // ---- 勤務条件（スタッフの設定） ----
      // 同じ人のほかの店舗での勤務（同じ日に2店舗に入っていないか・週休を数えるとき）
      const otherWork = new Map();
      for (const other of K.storage.getSamePersonStaff(member.id)) {
        for (const s of K.storage.getShifts({ month, staffId: other.id })) {
          if (isAtWork(s) && (s.storeId || other.storeId) !== storeId) otherWork.set(s.date, s.storeId || other.storeId);
        }
      }
      const fixed = member.fixedOff || { weekdays: [], holidays: false };
      const workDays = member.workWeekdays || [];
      for (const date of dates) {
        if (!isAtWork(map.get(`${member.id}|${date}`))) continue;
        const w = K.calc.weekdayOf(date);
        const holiday = K.holidays.holidayName(date);
        if (fixed.weekdays.includes(w) || (fixed.holidays && holiday)) {
          const what = fixed.weekdays.includes(w) ? `${U.WEEKDAYS[w]}曜` : '祝日';
          result.issues.push({ type: 'fixedOff', date, staffId: member.id, message: `${member.name}さん　固定休（${what}）の日に勤務が入っています` });
          addCell(member.id, date, '固定休');
        } else if (workDays.length && !workDays.includes(w)) {
          result.issues.push({
            type: 'workDay',
            date,
            staffId: member.id,
            message: `${member.name}さん　${U.WEEKDAYS[w]}曜は${store.name}で働く曜日ではありません`,
          });
          addCell(member.id, date, '勤務曜日外');
        }
        // 休業の日・営業時間（曜日ごと・特別の時間を入れた日）の外の勤務は、知らせるだけ（勤務は変えない）
        const sh = map.get(`${member.id}|${date}`);
        if (K.calc.closedPeriodOf(store, date)) {
          result.issues.push({ type: 'outsideHours', date, staffId: member.id, message: `${member.name}さん　臨時休業の日に勤務が入っています` });
          addCell(member.id, date, '臨時休業の日');
        } else {
          const hours = K.calc.hoursOf(store, date);
          const pat = sh && sh.patternId ? K.storage.getPattern(sh.patternId) : null;
          if (hours.explicit && pat && (U.toMinutes(pat.start) < U.toMinutes(hours.open) || U.toMinutes(pat.end) > U.toMinutes(hours.close))) {
            const label = `${U.formatTime(hours.open)}〜${U.formatTime(hours.close)}`;
            result.issues.push({ type: 'outsideHours', date, staffId: member.id, message: `${member.name}さん　営業時間（${label}）の外に勤務が入っています` });
            addCell(member.id, date, '営業時間外');
          }
        }
        if (otherWork.has(date)) {
          const other = K.storage.getStore(otherWork.get(date));
          result.issues.push({
            type: 'otherStore',
            date,
            staffId: member.id,
            message: `${member.name}さん　同じ日に${other ? other.name : 'ほかの店舗'}にも勤務が入っています`,
          });
          addCell(member.id, date, `${other ? other.name : 'ほかの店舗'}と重複`);
        }
      }

      // 週休（月曜〜日曜の7日がこの月に入っていて、未入力のない週だけ数える。有給は休みに数える）
      if (member.weeklyOffDays) {
        const mondays = new Set(dates.map((d) => addDays(d, -((K.calc.weekdayOf(d) + 6) % 7))));
        for (const monday of mondays) {
          const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
          if (!week.every((d) => d.startsWith(`${month}-`))) continue;
          const shifts = week.map((d) => map.get(`${member.id}|${d}`));
          if (shifts.some((s) => !s)) continue;
          const off = week.filter((d, i) => !isAtWork(shifts[i]) && !otherWork.has(d)).length;
          if (off < member.weeklyOffDays) {
            result.issues.push({
              type: 'weeklyOff',
              date: week[0],
              staffId: member.id,
              message: `${member.name}さん　${mdLabel(week[0])}〜${mdLabel(week[6])}の週 休み${off}日（週休${member.weeklyOffDays}日）`,
            });
          }
        }
      }

      // 1週の労働時間（月曜〜日曜。月をまたぐ週も7日分で数える）
      if (checks.hoursCheckEnabled) {
        const mondays = new Set(dates.map((d) => addDays(d, -((K.calc.weekdayOf(d) + 6) % 7))));
        for (const monday of mondays) {
          const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
          let minutes = 0;
          for (const date of week) {
            const shift = shiftAt(member.id, date);
            if (!isAtWork(shift)) continue;
            const day = K.calc.staffDay(member, shift, date);
            if (day) minutes += K.calc.workMinutes(day);
          }
          if (minutes > checks.weeklyHoursLimit * 60) {
            const inMonth = week.filter((d) => d.startsWith(`${month}-`));
            result.issues.push({
              type: 'weeklyHours',
              date: inMonth[0],
              staffId: member.id,
              message: `${member.name}さん　${mdLabel(week[0])}〜${mdLabel(week[6])}の週 実働${U.formatHours(minutes)}（目安${checks.weeklyHoursLimit}時間）`,
            });
            for (const date of inMonth) {
              if (isAtWork(map.get(`${member.id}|${date}`))) addCell(member.id, date, `週の実働${U.formatHours(minutes)}`);
            }
          }
        }
      }
    }

    const order = Object.fromEntries(TYPES.map(([t], i) => [t, i]));
    result.issues.sort((a, b) => order[a.type] - order[b.type] || (a.date || '').localeCompare(b.date || ''));
    result.blank = result.issues.filter((i) => i.type === 'blank').length;
    result.total = result.issues.length - result.blank;
    return result;
  }

  K.rules = { TYPES, TYPE_LABELS, checkMonth };
})();
