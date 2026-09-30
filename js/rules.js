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
    const checks = K.storage.getChecks();
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

      // 月の休日数（目安より少ないときだけ）
      const totals = K.calc.staffMonthTotals(member, map, dates, store);
      const off = totals.off + (checks.countPaidLeaveAsOff ? totals.paid : 0);
      if (off < checks.monthlyOffDays) {
        result.offShort.set(member.id, { off, target: checks.monthlyOffDays });
        const blankNote = totals.blank ? `・未入力${totals.blank}日` : '';
        result.issues.push({
          type: 'offDays',
          staffId: member.id,
          message: `${member.name}さん　休日${off}日（目安${checks.monthlyOffDays}日）${blankNote}`,
        });
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
