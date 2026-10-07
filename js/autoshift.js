// AIシフト作成（アプリの中で動く自動作成。外部のサービスにデータは送らない）
// 1店舗・1か月分の「空いているマス」だけを埋める案を作る。入力済みのマスは変えない。
//
// 考え方：
//   1. 必ず休み：承認済みの有給（シフト表に「有給」が入っている）、希望休、固定休（曜日・祝日）
//   2. 対象外の日：定休日、この店舗で働く曜日ではない日、同じ人がほかの店舗に入っている日（空欄のまま）
//   3. 休みを足す：週休の人は月曜〜日曜で週休の日数まで。固定休がない人は「月の休日数の目安」まで。
//      人数に余裕がある日（必要人数との差が大きい日）を選び、休みが続けて固まらないようにする
//   4. 連勤の上限を超える並びは、余裕のある日を休みにして切る
//   5. 勤務の日は、その日に合う勤務パターン（平日用／土日祝用）を選ぶ。曜日ごとのいつもの勤務があればそれを使う。
//      必要人数の時間帯が足りないところを優先して埋め、早番・遅番の人数をそろえる
//   ・勤務パターンがない人は対象外。戦力外の人は人数に数えない（勤務は入れる）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const SLOT = 30;

  function addDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return U.toDateStr(new Date(y, m - 1, d + delta));
  }

  function mondayOf(dateStr) {
    return addDays(dateStr, -((K.calc.weekdayOf(dateStr) + 6) % 7));
  }

  // options.wishes(staffId) → 希望休の日付の配列（省略時は、受け取っている申請データから）
  function plan(storeId, month, options = {}) {
    const store = K.storage.getStore(storeId);
    if (!store) throw new Error('店舗が見つかりませんでした。');
    const checks = K.storage.getChecks(storeId);
    const dates = K.calc.monthDates(month);
    const map = K.calc.shiftMap(month, storeId);
    const wishesOf = options.wishes || ((staffId) => (K.storage.isCloud() ? K.requests.adminWishDates(staffId, month) : []));
    const notes = [];

    const info = new Map(dates.map((d) => [d, K.calc.dayInfo(store, d)]));
    const hasRules = dates.some((d) => !info.get(d).closed && info.get(d).bands.length);
    if (!hasRules) notes.push(`${store.name}の必要人数が設定されていないため、早番・遅番と St／As を日ごとにそろえて作ります（設定 > 必要人数で登録すると、足りない時間帯を優先して埋めます）。`);

    // 対象のスタッフ（この店舗で使える勤務パターンがある人）
    const people = [];
    const skipped = [];
    for (const m of K.storage.getStaff({ storeId })) {
      const pats = m.patternIds
        .map((id) => K.storage.getPattern(id))
        .filter((p) => p && !p.deleted && (!p.storeId || p.storeId === storeId))
        .sort(K.storage.comparePatterns(storeId));
      if (!pats.length) {
        skipped.push(m);
        continue;
      }
      // 同じ人がほかの店舗に入っている日
      const elsewhere = new Set();
      for (const o of K.storage.getSamePersonStaff(m.id)) {
        for (const s of K.storage.getShifts({ month, staffId: o.id })) {
          if (s.kind === 'work' || s.kind === 'business') elsewhere.add(s.date);
        }
      }
      people.push({ m, pats, status: new Map(), elsewhere, counted: K.calc.countsAsStaff(m), role: m.role });
    }
    if (skipped.length) notes.push(`勤務パターンが登録されていないため対象外：${skipped.map((m) => `${m.name}さん`).join('、')}`);

    // ---- 1・2：日ごとの状態 ----
    // work（入力済みの勤務）/ offFixed（入力済みの休み）/ off（新しく休み）/ closed / skip（対象外）/ cand（勤務の候補）
    for (const p of people) {
      const fixed = p.m.fixedOff || { weekdays: [], holidays: false };
      const workDays = p.m.workWeekdays || [];
      const wishes = new Set(wishesOf(p.m.id));
      for (const date of dates) {
        const shift = map.get(`${p.m.id}|${date}`);
        const w = K.calc.weekdayOf(date);
        let st;
        if (shift) st = shift.kind === 'work' || shift.kind === 'business' ? 'work' : 'offFixed';
        else if (info.get(date).closed) st = 'closed';
        else if (workDays.length && !workDays.includes(w)) st = 'skip';
        else if (p.elsewhere.has(date)) st = 'skip';
        else if (fixed.weekdays.includes(w) || (fixed.holidays && K.holidays.holidayName(date)) || wishes.has(date)) st = 'off';
        else st = 'cand';
        p.status.set(date, st);
      }
    }

    // その日の必要人数（時間帯の中で一番多い最低人数）と、勤務できる人数
    const need = (date) => {
      const i = info.get(date);
      if (i.closed || !i.bands.length) return { stylist: 0, assistant: 0 };
      return { stylist: Math.max(...i.bands.map((b) => b.stMin)), assistant: Math.max(...i.bands.map((b) => b.asMin)) };
    };
    const avail = new Map(dates.map((d) => [d, { stylist: 0, assistant: 0 }]));
    for (const p of people) {
      if (!p.counted) continue;
      for (const date of dates) {
        const st = p.status.get(date);
        if (st === 'work' || st === 'cand') avail.get(date)[p.role] += 1;
      }
    }
    const margin = (p, date) => (p.counted ? avail.get(date)[p.role] - need(date)[p.role] : 0);

    const isOff = (st) => st === 'off' || st === 'offFixed';
    const countsAsOff = (st) => isOff(st) || (st === 'closed' && checks.closedDayAsOff);

    // 休みにする日を1つ選ぶ（余裕のある日 → ほかの休みから離れた日 → 平日）
    function pickOff(p, candidates) {
      let best = null;
      let bestScore = null;
      for (const date of candidates) {
        let gap = 99;
        for (const [d, st] of p.status) {
          if (!countsAsOff(st)) continue;
          gap = Math.min(gap, Math.abs((new Date(d) - new Date(date)) / 86400000));
        }
        const score = [margin(p, date), Math.min(gap, 7), info.get(date).dayType === 'weekday' ? 1 : 0];
        if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))) {
          best = date;
          bestScore = score;
        }
      }
      return best;
    }

    function setOff(p, date) {
      p.status.set(date, 'off');
      if (p.counted) avail.get(date)[p.role] -= 1;
    }

    // ---- 3：休みを足す ----
    for (const p of people) {
      const fixed = p.m.fixedOff || { weekdays: [], holidays: false };
      if (p.m.weeklyOffDays) {
        // 週休：月曜〜日曜。月の初め・終わりの半端な週は、この月に入る日数に合わせて減らす
        const mondays = [...new Set(dates.map(mondayOf))];
        for (const monday of mondays) {
          const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => d.startsWith(`${month}-`));
          const required = Math.round((p.m.weeklyOffDays * week.length) / 7);
          let current = week.filter((d) => countsAsOff(p.status.get(d))).length;
          while (current < required) {
            const date = pickOff(p, week.filter((d) => p.status.get(d) === 'cand'));
            if (!date) break;
            setOff(p, date);
            current += 1;
          }
        }
      } else if (!fixed.weekdays.length && !fixed.holidays) {
        // 固定休がない人：月の休日数の目安まで
        let current = dates.filter((d) => countsAsOff(p.status.get(d))).length;
        while (current < checks.monthlyOffDays) {
          const date = pickOff(p, dates.filter((d) => p.status.get(d) === 'cand'));
          if (!date) break;
          setOff(p, date);
          current += 1;
        }
      }
    }

    // ---- 4：連勤の上限 ----
    for (const p of people) {
      let streak = 0;
      for (let d = addDays(dates[0], -1); streak <= 62; d = addDays(d, -1)) {
        const s = K.storage.getShift(p.m.id, d, storeId);
        if (!s || (s.kind !== 'work' && s.kind !== 'business')) break;
        streak += 1;
      }
      let run = [];
      for (const date of dates) {
        const st = p.status.get(date);
        if (st === 'work' || st === 'cand') {
          run.push(date);
          streak += 1;
          if (streak > checks.maxConsecutiveDays) {
            const date2 = pickOff(p, run.filter((d) => p.status.get(d) === 'cand'));
            if (date2) {
              setOff(p, date2);
              const i = run.indexOf(date2);
              run = run.slice(i + 1);
              streak = run.length;
            }
          }
        } else {
          run = [];
          streak = 0;
        }
      }
    }

    // ---- 5：勤務パターンを選ぶ ----
    const toMin = U.toMinutes;
    const assignments = [];
    const slotCount = new Map(); // 人ごとの早番・遅番の回数（月の中でかたよらないように）
    for (const date of dates) {
      const i = info.get(date);
      if (i.closed) continue;
      const day = people.filter((p) => p.status.get(date) === 'cand');
      if (!day.length) continue;
      // 30分ごとの必要人数と、入力済みの勤務での人数
      const req = new Map();
      for (const b of i.bands) {
        for (let t = toMin(b.start); t < toMin(b.end); t += SLOT) req.set(t, { stylist: b.stMin, assistant: b.asMin });
      }
      const cov = new Map();
      const addCov = (role, pat) => {
        for (let t = Math.floor(toMin(pat.start) / SLOT) * SLOT; t + SLOT <= toMin(pat.end); t += SLOT) {
          if (!cov.has(t)) cov.set(t, { stylist: 0, assistant: 0 });
          cov.get(t)[role] += 1;
        }
      };
      for (const p of people) {
        const s = map.get(`${p.m.id}|${date}`);
        if (p.counted && s && s.kind === 'work') {
          const pat = K.storage.getPattern(s.patternId);
          if (pat) addCov(p.role, pat);
        }
      }
      const daySlots = { stylist: { early: 0, late: 0 }, assistant: { early: 0, late: 0 } };
      const options = (p) => {
        const usual = (p.m.weeklyPatterns || {})[String(K.calc.weekdayOf(date))];
        const fit = p.pats.filter((x) => !x.dayType || x.dayType === i.dayType);
        if (usual && usual !== 'off' && fit.some((x) => x.id === usual)) return fit.filter((x) => x.id === usual);
        return fit;
      };
      // 選べるパターンが少ない人から決める
      day.sort((a, b) => options(a).length - options(b).length || Number(b.counted) - Number(a.counted));
      for (const p of day) {
        const opts = options(p);
        if (!opts.length) {
          notes.push(`${p.m.name}さん：${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${i.dayType === 'holiday' ? '土日祝' : '平日'}）に使える勤務パターンがないため、空欄のままにしました。`);
          continue;
        }
        const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
        let best = null;
        let bestScore = null;
        for (const pat of opts) {
          let gain = 0;
          if (p.counted) {
            for (let t = Math.floor(toMin(pat.start) / SLOT) * SLOT; t + SLOT <= toMin(pat.end); t += SLOT) {
              const r = req.get(t);
              if (!r) continue;
              const c = cov.get(t) ? cov.get(t)[p.role] : 0;
              if (c < r[p.role]) gain += 1;
            }
          }
          const slot = pat.slot || (toMin(pat.start) <= 9 * 60 ? 'early' : 'late');
          const score = [gain, -daySlots[p.role][slot], -mine[slot]];
          if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))) {
            best = { pat, slot };
            bestScore = score;
          }
        }
        if (p.counted) {
          addCov(p.role, best.pat);
          daySlots[p.role][best.slot] += 1;
        }
        mine[best.slot] += 1;
        slotCount.set(p.m.id, mine);
        assignments.push({ staffId: p.m.id, date, kind: 'work', patternId: best.pat.id });
      }
    }

    // 新しく入れる休み
    for (const p of people) {
      for (const date of dates) if (p.status.get(date) === 'off') assignments.push({ staffId: p.m.id, date, kind: 'off', patternId: null });
    }
    assignments.sort((a, b) => a.date.localeCompare(b.date));

    const summary = people.map((p) => ({
      staffId: p.m.id,
      name: p.m.name,
      work: assignments.filter((a) => a.staffId === p.m.id && a.kind === 'work').length,
      off: assignments.filter((a) => a.staffId === p.m.id && a.kind === 'off').length,
    }));
    return { storeId, month, assignments, notes, skipped: skipped.map((m) => m.id), summary };
  }

  K.autoshift = { plan };
})();
