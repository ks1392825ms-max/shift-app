// AIシフト作成（アプリの中で動く自動作成。外部のサービスにデータは送らない）
// 1店舗・1か月分の「空いているマス」だけを埋める案を作る。入力済みのマスは変えない。
//
// 考え方：
//   1. 必ず休み：承認済みの有給（空いているマスに「有給」を入れる）、承認済みの希望休（平日・土日祝とも）、固定休（曜日・祝日）
//      申請中・却下の希望休と有給は、勤務の候補のまま（申請中の件数はお知らせに出す）
//   2. 対象外の日：定休日、この店舗で働く曜日ではない日、同じ人がほかの店舗に入っている日（空欄のまま）
//   3. 休みを足す：本人の月の休日数がある人はその日数まで。週休の人は月曜〜日曜で週休の日数まで。固定休がない人は「月の休日数の目安」まで。土日祝には足さない。
//      連休（休みが2日以上続くところ）が公平になるように、連休の回数が少ない人から1日ずつ順番に選ぶ。
//      連休がいちばん少ない人は、人数に余裕のある日の中で連休になる日を、それ以外の人は余裕のある日・ほかの休みから離れた日を選ぶ
//   4. 連勤の上限を超える並びは、余裕のある平日を休みにして切る
//   ・休みを足しきれない・連勤を切れないときは、理由をお知らせに出す（無理に入れない）
//   5. 勤務の日は、その日に合う勤務パターン（平日用／土日祝用）を選ぶ。曜日ごとのいつもの勤務があればそれを使う。
//      ① 前日の番と違う番（休みを挟んだら数えない）→ ② 必要人数の不足が実際に減るときだけ変える
//      → ③ 早番が0人なら、不足を増やさない範囲で1人を早番に → ④ その日の早番・遅番の人数をそろえる
//      → ⑤ 早番と遅番の回数の偏りを減らす（偏りのある人どうしで入れ替え）
//      → ⑥ 仕上げ：偏りが大きい人は、休みに挟まれた勤務のかたまりを、まるごと早番⇔遅番で入れ替える
//   6. 作ったあとに確かめる：早番が0人の日・早早／遅遅（パートは含めない）・必要人数に足りない日を、理由つきでお知らせに出す
//      （無理に勤務を変えたり、希望休を消したりはしない）
//   ・勤務パターンがない人は対象外。戦力外の人は人数に数えない（勤務は入れる）
//   ・パート：契約（働く曜日・勤務パターンの時間・固定休・週休・いつもの勤務）を最優先する。働く曜日も固定休の曜日も未登録の人は対象外。
//     正社員向けの「月の休日数の目安」「早番・遅番の交互」「連休の公平」は当てはめない（公平さは正社員どうしでそろえる）
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

  // 土日祝（土曜・日曜・祝日）。自動で休みを足さない日
  function isWeekendOrHoliday(dateStr) {
    const w = K.calc.weekdayOf(dateStr);
    return w === 0 || w === 6 || Boolean(K.holidays.holidayName(dateStr));
  }

  function md(dateStr) {
    return `${Number(dateStr.slice(5, 7))}/${Number(dateStr.slice(8, 10))}`;
  }

  // 勤務パターンの番（slot がなければ、9:00 までに始まるものを早番とする）
  function slotOf(pat) {
    return pat.slot || (U.toMinutes(pat.start) <= 9 * 60 ? 'early' : 'late');
  }

  // 点数の並びを前から順に比べて、a のほうが大きければ true
  function better(a, b) {
    const k = a.findIndex((v, j) => v !== b[j]);
    return k >= 0 && a[k] > b[k];
  }

  const SLOT_LABELS = { early: '早番', late: '遅番' };
  // 早早・遅遅になった理由のうち、本人の設定による「制約あり」（無理に変えない・交互の対象外）
  const WHY_USUAL = 'いつもの勤務のため';
  const WHY_SINGLE = '選べる番が1つのため（選べる勤務パターンがその番だけ）';
  const CONSTRAINED = [WHY_USUAL, WHY_SINGLE];
  const ROLE_LABELS = { stylist: 'スタイリスト', assistant: 'アシスタント' };

  // options.wishes(staffId) → 希望休の日付の配列（省略時は、受け取っている申請データから）
  function plan(storeId, month, options = {}) {
    const store = K.storage.getStore(storeId);
    if (!store) throw new Error('店舗が見つかりませんでした。');
    const checks = K.storage.getChecks(storeId);
    const dates = K.calc.monthDates(month);
    const map = K.calc.shiftMap(month, storeId);
    // 承認済みの希望休・有給だけを使う（申請中・却下は勤務の候補のまま）
    const wishesOf = options.wishes || ((staffId) => (K.storage.isCloud() ? K.requests.adminWishDates(staffId, month) : []));
    const paidOf = options.paid || ((staffId) => (K.storage.isCloud() ? K.requests.adminApprovedPaidDates(staffId, month) : []));
    // 社用で不在の日（幹部が自分で登録）
    const businessOf = options.business || ((staffId) => (K.storage.isCloud() && K.requests.adminBusinessDates ? K.requests.adminBusinessDates(staffId, month) : []));
    const notes = [];
    if (!options.wishes && K.storage.isCloud()) {
      const pend = K.requests.pendingCounts(storeId, month);
      if (pend.wishes || pend.paid) {
        notes.push(`申請中（まだ承認・却下していない）の希望休が${pend.wishes}件、有給が${pend.paid}件あります。承認されるまで休みにしていません（申請タブで判断すると、次の作成から反映されます）。`);
      }
    }

    const info = new Map(dates.map((d) => [d, K.calc.dayInfo(store, d)]));
    const hasRules = dates.some((d) => !info.get(d).closed && info.get(d).bands.length);
    if (!hasRules) notes.push(`${store.name}の必要人数が設定されていないため、早番・遅番と St／As を日ごとにそろえて作ります（設定 > 必要人数で登録すると、足りない時間帯を優先して埋めます）。`);

    // 対象のスタッフ（この店舗で使える勤務パターンがある人）
    const people = [];
    const skipped = [];
    const noWorkdays = []; // 契約の勤務曜日（働く曜日・固定休の曜日）が未登録のパート
    for (const m of K.storage.getStaff({ storeId })) {
      const pats = m.patternIds
        .map((id) => K.storage.getPattern(id))
        .filter((p) => p && !p.deleted && (!p.storeId || p.storeId === storeId))
        .sort(K.storage.comparePatterns(storeId));
      if (!pats.length) {
        skipped.push(m);
        continue;
      }
      const part = m.employment === 'part';
      // 契約の勤務曜日が未登録：働く曜日（空欄＝全曜日）も固定休の曜日も登録されていない
      if (part && !m.offFlex && !(m.workWeekdays || []).length && !((m.fixedOff && m.fixedOff.weekdays) || []).length) {
        noWorkdays.push(m);
        continue;
      }
      // 同じ人がほかの店舗に入っている日
      const elsewhere = new Set();
      for (const o of K.storage.getSamePersonStaff(m.id)) {
        for (const s of K.storage.getShifts({ month, staffId: o.id })) {
          if (s.kind === 'work' || s.kind === 'business') elsewhere.add(s.date);
        }
      }
      // flex：休みの日数を決めないパート（人数が足りない日にだけ入れる。入れない日は休み）／bizPat：いつもの勤務の社用の日 → 勤務パターンID
      people.push({ m, pats, status: new Map(), elsewhere, counted: K.calc.countsAsStaff(m), role: m.role, part, flex: part && Boolean(m.offFlex), contractOff: new Set(), paidFixed: new Set(), aiOff: new Set(), bizPat: new Map() });
    }
    if (skipped.length) notes.push(`勤務パターンが登録されていないため対象外：${skipped.map((m) => `${m.name}さん`).join('、')}`);
    if (noWorkdays.length) {
      notes.push(`パートの契約の勤務曜日（この店舗で働く曜日、または固定休の曜日）が登録されていないため対象外：${noWorkdays.map((m) => `${m.name}さん`).join('、')}（設定 > スタッフで登録してください）`);
    }

    // いつもの勤務が「社用」の曜日なら、その勤務パターンID（使える勤務パターンのときだけ）
    const usualBusiness = (p, w) => {
      const pid = K.storage.weeklyBusinessPattern((p.m.weeklyPatterns || {})[String(w)]);
      return pid && p.pats.some((x) => x.id === pid) ? pid : null;
    };

    // ---- 1・2：日ごとの状態 ----
    // work（入力済みの勤務）/ offFixed（入力済みの休み）/ off（新しく休み）/ closed / skip（対象外）/ cand（勤務の候補）
    for (const p of people) {
      const fixed = p.m.fixedOff || { weekdays: [], holidays: false };
      const workDays = p.m.workWeekdays || [];
      const wishes = new Set(wishesOf(p.m.id));
      const paidDays = new Set(paidOf(p.m.id));
      const businessDays = new Set(businessOf(p.m.id));
      for (const date of dates) {
        const shift = map.get(`${p.m.id}|${date}`);
        const w = K.calc.weekdayOf(date);
        let st;
        if (shift) {
          st = shift.kind === 'work' || shift.kind === 'business' ? 'work' : 'offFixed';
          if (shift.kind === 'paid') p.paidFixed.add(date); // 手入力の有給（シフト休とは別に数える）
        }
        else if (info.get(date).closed) st = 'closed';
        else if (workDays.length && !workDays.includes(w)) st = 'skip';
        else if (p.elsewhere.has(date)) st = 'skip';
        else if (fixed.weekdays.includes(w) || (fixed.holidays && K.holidays.holidayName(date))) {
          st = 'off';
          p.contractOff.add(date); // 固定休（契約上の休み）。必要人数不足の理由を分けるのに使う
        }
        else if (businessDays.has(date)) st = 'business'; // 社用で不在（シフト表に「社用」を入れる。店舗の人数には数えない）
        else if (paidDays.has(date)) st = 'paid'; // 承認済みの有給（シフト表に「有給」を入れる）
        else if (wishes.has(date)) st = 'off'; // 承認済みの希望休（平日・土日祝とも）
        else if (usualBusiness(p, w)) {
          // いつもの勤務が「社用」の曜日（11/5〜。店舗の人数には数えない）
          st = 'business';
          p.bizPat.set(date, usualBusiness(p, w));
        }
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

    // 同じ日の休みを分ける（設定 > チェック「同じ日の休みは、なるべく1人まで」・11/8〜）：休みを入れる日は、休みの人が少ない日から
    // この人が休み・社用の日は出勤（スタッフの設定・11/8〜）：相手が休み・社用の日には、休みを入れない（相手の休みを選ぶときも同じ）
    const spread = checks.offSpread !== false;
    const isAbsent = (st) => st === 'off' || st === 'offFixed' || st === 'paid' || st === 'business';
    const othersOff = (p, date) => people.filter((q) => q !== p && q.counted && isAbsent(q.status.get(date))).length;
    const coverBlocked = (p, date) => {
      const target = p.m.coverFor ? people.find((q) => q.m.id === p.m.coverFor) : null;
      if (target && isAbsent(target.status.get(date))) return true;
      return people.some((q) => q.m.coverFor === p.m.id && isAbsent(q.status.get(date)));
    };

    const isOff = (st) => st === 'off' || st === 'offFixed' || st === 'paid';
    const countsAsOff = (st) => isOff(st) || (st === 'closed' && checks.closedDayAsOff);

    // 連休の回数：休み（通常休・有給。設定で定休日も）が2日以上続いたところを1回と数える
    function renkyuCount(p) {
      let n = 0;
      let run = 0;
      for (const date of dates) {
        if (countsAsOff(p.status.get(date))) run += 1;
        else {
          if (run >= 2) n += 1;
          run = 0;
        }
      }
      return run >= 2 ? n + 1 : n;
    }

    // 休みにする日を1つ選ぶ
    //   連休を増やしたい人（連休がいちばん少ない人）：人数に余裕のある日 → 新しく連休になる日 → 余裕の大きい日 → 平日
    //   それ以外：余裕のある日 → ほかの休みから離れた日 → 平日（今までどおり）
    function pickOff(p, candidates, wantRenkyu = false) {
      const base = wantRenkyu ? renkyuCount(p) : 0;
      let best = null;
      let bestScore = null;
      for (const date of candidates) {
        if (coverBlocked(p, date)) continue;
        const weekday = info.get(date).dayType === 'weekday' ? 1 : 0;
        let score;
        if (wantRenkyu) {
          const before = p.status.get(date);
          p.status.set(date, 'off');
          const makes = renkyuCount(p) > base ? 1 : 0;
          p.status.set(date, before);
          score = [Math.min(margin(p, date), 1), makes, spread ? -othersOff(p, date) : 0, margin(p, date), weekday];
        } else {
          let gap = 99;
          for (const [d, st] of p.status) {
            if (!countsAsOff(st)) continue;
            gap = Math.min(gap, Math.abs((new Date(d) - new Date(date)) / 86400000));
          }
          score = [Math.min(margin(p, date), 1), spread ? -othersOff(p, date) : 0, margin(p, date), Math.min(gap, 7), weekday];
        }
        if (!bestScore || better(score, bestScore)) {
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

    // 平日の週のシフト休・月の連休の決まり（設定 > チェック。0 なら今までどおり月の休日数の目安で作る）
    const weekTarget = checks.weekdayShiftOff;
    const renkyuTarget = checks.monthlyRenkyu;
    function weeklyRule(p) {
      // 働く曜日（契約）を登録した人は、曜日で休みが決まるので対象外（今までどおり）
      return weekTarget > 0 && !p.part && !Number.isInteger(p.m.monthlyOffDays) && !p.m.weeklyOffDays && !(p.m.workWeekdays || []).length;
    }

    // ---- 3：休みを足す ----
    // 本人の月の休日数がある人はその日数まで（定休日・固定休・希望休なども1日として数える。週休より優先）。
    // それ以外は、週休の人は週ごと、固定休がない人は月の休日数の目安まで。土日祝には足さない。
    // 連休が公平になるように、連休の回数が少ない人から1日ずつ順番に選ぶ（連休がいちばん少ない人は、連休になる日を選ぶ）
    const offTasks = [];
    for (const p of people) {
      if (weeklyRule(p)) continue; // 正社員（個別の休日数・週休なし）は、下の「3'：平日の週のシフト休・月の連休」で決める
      const fixed = p.m.fixedOff || { weekdays: [], holidays: false };
      if (Number.isInteger(p.m.monthlyOffDays)) {
        offTasks.push({ p, scope: dates, required: p.m.monthlyOffDays, weekly: false, done: false });
      } else if (p.m.weeklyOffDays) {
        // 週休：月曜〜日曜。月の初め・終わりの半端な週は、この月に入る日数に合わせて減らす
        for (const monday of [...new Set(dates.map(mondayOf))]) {
          const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => d.startsWith(`${month}-`));
          offTasks.push({ p, scope: week, required: Math.round((p.m.weeklyOffDays * week.length) / 7), weekly: true, done: false });
        }
      } else if (!p.part && !fixed.weekdays.length && !fixed.holidays) {
        // 月の休日数の目安は正社員だけ（パートの休みは契約の働く曜日で決まる）
        offTasks.push({ p, scope: dates, required: checks.monthlyOffDays, weekly: false, done: false });
      }
    }
    const offIn = (t) => t.scope.filter((d) => countsAsOff(t.p.status.get(d))).length;
    const fairPeople = [...new Set(offTasks.map((t) => t.p))].filter((p) => !p.part); // 連休をそろえる相手（休みを足す正社員）
    for (;;) {
      const next = new Map(); // 人ごとに、まだ足りない一番早いもの
      for (const t of offTasks) if (!t.done && offIn(t) < t.required && !next.has(t.p)) next.set(t.p, t);
      if (!next.size) break;
      const minRenkyu = fairPeople.length ? Math.min(...fairPeople.map(renkyuCount)) : 0;
      const order = [...next.values()].sort((a, b) => renkyuCount(a.p) - renkyuCount(b.p));
      for (const t of order) {
        const date = pickOff(t.p, t.scope.filter((d) => t.p.status.get(d) === 'cand' && !isWeekendOrHoliday(d)), !t.p.part && renkyuCount(t.p) <= minRenkyu);
        if (date) setOff(t.p, date);
        else t.done = true;
      }
    }
    for (const t of offTasks) {
      const short = t.required - offIn(t);
      if (short <= 0) continue;
      if (t.weekly && t.scope.some((d) => t.p.status.get(d) === 'cand')) {
        notes.push(`${t.p.m.name}さん：${md(t.scope[0])}〜${md(t.scope[t.scope.length - 1])}の週の休みが${short}日足りません（土日祝は休みにしないため、平日に休める日がありません）。`);
      } else if (!t.weekly) {
        notes.push(`${t.p.m.name}さん：月の休みが目安（${t.required}日）より${short}日少なくなりました（土日祝は休みにしないため、平日に休める日が足りません）。`);
      }
    }

    // ---- 3'：平日の週のシフト休・月の連休（正社員。本人の「月の休日数」「週休」を入れていない人） ----
    // ・月曜〜日曜の週ごとに、シフト休（通常休・承認済みの希望休・固定休・定休日／臨時休業）が「平日の週のシフト休」の日数になるように、平日に休みを足す
    //   土日祝には足さない（原則出勤）。有給はシフト休に数えない。手入力の休みが多くても減らさない
    //   前の月から続く週は、前の月に保存されているシフトも数える。翌月に続く週は、この月に入る平日の数に合わせて減らす
    // ・休みを選ぶときに、月に「月の連休」の回数だけ、シフト休が2日以上続く所（連休）ができるようにする（有給は連休に数えない）
    //   連休は、始まった日の月に数える（3日以上続いても1回）
    const isWeekdayPlain = (d) => !isWeekendOrHoliday(d);
    // シフト休か（この月の日）
    const shiftOff = (p, d) => {
      const st = p.status.get(d);
      return st === 'off' || st === 'closed' || (st === 'offFixed' && !p.paidFixed.has(d));
    };
    // この月の外の日：保存されているシフトで判断（true＝シフト休、false＝勤務・有給、null＝未入力）
    const outsideOff = (p, d) => {
      const sh = K.storage.getShift(p.m.id, d, storeId);
      if (sh) return sh.kind === 'off';
      return K.calc.isStoreClosed(store, d) ? true : null;
    };
    const offAt = (p, d) => (d.startsWith(`${month}-`) ? shiftOff(p, d) : outsideOff(p, d) === true);
    // 連休の回数（この月に始まる、シフト休が2日以上続く所）
    function shiftRenkyu(p) {
      let n = 0;
      for (const d of dates) {
        if (offAt(p, d) && !offAt(p, addDays(d, -1)) && offAt(p, addDays(d, 1))) n += 1;
      }
      return n;
    }
    // 連勤のいちばん長い所（勤務・勤務の候補を出勤として数える。前の月から続く分も）
    function longestRun(p) {
      let run = 0;
      for (let d = addDays(dates[0], -1); run <= 62; d = addDays(d, -1)) {
        const sh = K.storage.getShift(p.m.id, d, storeId);
        if (!sh || (sh.kind !== 'work' && sh.kind !== 'business')) break;
        run += 1;
      }
      let max = run;
      for (const d of dates) {
        const st = p.status.get(d);
        run = st === 'work' || st === 'cand' ? run + 1 : 0;
        max = Math.max(max, run);
      }
      return max;
    }
    const weekly = people.filter(weeklyRule);
    const weeks = [];
    for (const monday of [...new Set(dates.map(mondayOf))]) {
      const all = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
      const inMonth = all.filter((d) => d.startsWith(`${month}-`));
      const after = all.filter((d) => d > dates[dates.length - 1]);
      // 翌月に続く週：この月に入る平日（月〜金）の数に合わせて減らす
      const monFri = (list) => list.filter((d) => K.calc.weekdayOf(d) >= 1 && K.calc.weekdayOf(d) <= 5).length;
      const target = after.length ? Math.min(weekTarget, Math.round((weekTarget * monFri(inMonth)) / 5)) : weekTarget;
      weeks.push({ monday, all, inMonth, target });
    }
    const weekTasks = [];
    for (const p of weekly) for (const w of weeks) weekTasks.push({ p, w, done: false });
    const offsIn = (t) => t.w.all.filter((d) => offAt(t.p, d)).length;
    const pickWeekOff = (p, candidates) => {
      const wantRenkyu = shiftRenkyu(p) < renkyuTarget;
      const base = shiftRenkyu(p);
      let best = null;
      let bestScore = null;
      for (const date of candidates) {
        if (coverBlocked(p, date)) continue;
        const before = p.status.get(date);
        p.status.set(date, 'off');
        const makes = wantRenkyu && shiftRenkyu(p) > base ? 1 : 0;
        const streakOk = longestRun(p) <= checks.maxConsecutiveDays ? 1 : 0;
        p.status.set(date, before);
        let gap = 99;
        for (const d of dates) if (d !== date && shiftOff(p, d)) gap = Math.min(gap, Math.abs((new Date(d) - new Date(date)) / 86400000));
        // ① 人数に余裕がある ② 連勤の上限を超えない ③ 連休が足りない人は連休になる日 ④ 余裕の大きい日 ⑤ ほかの休みから離れた日
        // ③' 連休の次に、同じ日の休みが少ない日（設定でオンのとき。連休・連勤の決まりを先に守る）
        const score = [Math.min(margin(p, date), 1), streakOk, makes, spread ? -othersOff(p, date) : 0, margin(p, date), wantRenkyu ? 0 : Math.min(gap, 7)];
        if (!bestScore || better(score, bestScore)) {
          best = date;
          bestScore = score;
        }
      }
      return best;
    };
    for (;;) {
      const next = new Map();
      for (const t of weekTasks) if (!t.done && offsIn(t) < t.w.target && !next.has(t.p)) next.set(t.p, t);
      if (!next.size) break;
      // 連休が少ない人から、1日ずつ順番に
      const order = [...next.values()].sort((a, b) => shiftRenkyu(a.p) - shiftRenkyu(b.p));
      for (const t of order) {
        const date = pickWeekOff(t.p, t.w.inMonth.filter((d) => t.p.status.get(d) === 'cand' && isWeekdayPlain(d)));
        if (date) {
          setOff(t.p, date);
          t.p.aiOff.add(date);
        } else t.done = true;
      }
    }
    // 連休が足りない人：同じ週の中で、AIが入れた休みを、ほかのシフト休の隣の平日へ動かす（週の日数は変えない・人数に余裕のある日だけ）
    for (const p of weekly) {
      for (let guard = 0; guard < 20 && shiftRenkyu(p) < renkyuTarget; guard++) {
        const base = shiftRenkyu(p);
        let best = null;
        for (const w of weeks) {
          for (const from of w.inMonth.filter((d) => p.aiOff.has(d) && p.status.get(d) === 'off')) {
            for (const to of w.inMonth.filter((d) => p.status.get(d) === 'cand' && isWeekdayPlain(d) && !coverBlocked(p, d) && (!spread || othersOff(p, d) <= othersOff(p, from)))) {
              p.status.set(from, 'cand');
              p.status.set(to, 'off');
              const gain = shiftRenkyu(p) - base;
              const after = longestRun(p);
              p.status.set(to, 'cand');
              p.status.set(from, 'off');
              const ok = after <= checks.maxConsecutiveDays || after <= longestRun(p);
              const m = p.counted ? avail.get(to)[p.role] - need(to)[p.role] : 1;
              if (gain > 0 && ok && m >= 1 && (!best || m > best.m)) best = { from, to, m };
            }
          }
        }
        if (!best) break;
        p.status.set(best.from, 'cand');
        p.aiOff.delete(best.from);
        if (p.counted) avail.get(best.from)[p.role] += 1;
        setOff(p, best.to);
        p.aiOff.add(best.to);
      }
    }
    for (const t of weekTasks) {
      const n = offsIn(t);
      const label = `${md(t.w.all[0])}〜${md(t.w.all[6])}の週`;
      if (n < t.w.target) {
        notes.push(`${t.p.m.name}さん：${label}の平日のシフト休が${n}日で、${t.w.target}日に${t.w.target - n}日足りません（休める平日がないため。土日祝は原則出勤・手入力の勤務／有給は変えていません）。`);
      } else if (n > t.w.target && t.w.all.some((d) => d.startsWith(`${month}-`) && t.p.status.get(d) === 'offFixed' && !t.p.paidFixed.has(d))) {
        notes.push(`${t.p.m.name}さん：${label}のシフト休が${n}日で、${t.w.target}日より多くなっています（手入力の休みのため。休みは変えていません）。`);
      }
    }
    for (const p of weekly) {
      const n = shiftRenkyu(p);
      if (n < renkyuTarget) {
        notes.push(`${p.m.name}さん：連休（シフト休が2日続く所）が${n}回で、月${renkyuTarget}回に足りません（人数に余裕のある平日で、続けて休める日がないため。有給は連休に数えていません）。`);
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
            // 週のシフト休の日数で決める人は、休みを増やさない（知らせるだけ）
            const date2 = weeklyRule(p) ? null : pickOff(p, run.filter((d) => p.status.get(d) === 'cand' && !isWeekendOrHoliday(d)));
            if (date2) {
              setOff(p, date2);
              const i = run.indexOf(date2);
              run = run.slice(i + 1);
              streak = run.length;
            } else if (streak === checks.maxConsecutiveDays + 1) {
              notes.push(
                weeklyRule(p)
                  ? `${p.m.name}さん：${md(date)}で連勤が${checks.maxConsecutiveDays}日を超えます（週のシフト休の日数を守るため、休みを増やしていません。休みの曜日を手で調整してください）。`
                  : `${p.m.name}さん：${md(date)}で連勤が${checks.maxConsecutiveDays}日を超えます（休みにできる平日がないため、切っていません）。`
              );
            }
          }
        } else {
          run = [];
          streak = 0;
        }
      }
    }

    // ---- 5：勤務パターンを選ぶ ----
    // 日ごとに次の順で決める（パートは契約の時間のまま。入れ替えには使わないが、必要人数には数える）
    //   ① 前日の番と違う番で仮に決める（前日が休みなら、本人の早番・遅番の回数が少ないほう）
    //   ② 必要人数の不足が実際に減るときだけ、番を変える（既存の条件。いちばん優先）
    //   ③ 早番が0人なら、不足を増やさない範囲で、1人を早番に変える（前日が早番でない人を優先）
    //   ④ その日の早番・遅番の人数をそろえる（早早・遅遅・不足・早番0人を増やさない範囲で）
    const toMin = U.toMinutes;
    const assignments = [];
    const slotCount = new Map(); // 人ごとの早番・遅番の回数（月の中でかたよらないように）
    const daySlot = new Map(); // `${スタッフID}|${日付}` → 'early' / 'late'（勤務の日。入力済み・前月の最後の日も）
    const repeatWhy = new Map(); // `${スタッフID}|${日付}` → 前日と同じ番になった理由
    const slotOfShift = (s) => {
      if (!s || (s.kind !== 'work' && s.kind !== 'business') || !s.patternId) return null;
      const pat = K.storage.getPattern(s.patternId);
      return pat ? slotOf(pat) : null;
    };
    for (const p of people) {
      const d0 = addDays(dates[0], -1);
      const sl = slotOfShift(K.storage.getShift(p.m.id, d0, storeId));
      if (sl) daySlot.set(`${p.m.id}|${d0}`, sl);
    }
    const earlyZeroDays = [];
    // 毎日そろえる出勤時刻（設定 > チェック。平日・土日祝）。その日に、その時刻に出勤する人を最低1人ずつ
    const startTimesOf = (date) => (info.get(date).dayType === 'holiday' ? checks.startTimesHoliday : checks.startTimesWeekday) || [];
    const startMissing = []; // { date, time, reason }
    // その時刻に始まる勤務パターンを使える人が、店舗に1人もいない時刻は、そろえない（知らせない）
    const storeStartable = new Set(people.filter((p) => p.counted).flatMap((p) => p.pats.map((x) => x.start)));
    const dayCtx = new Map(); // 日付 → { req, fixedWork, optsOf: Map(スタッフID → { opts, usual }) }（⑥で使う）
    for (const date of dates) {
      const i = info.get(date);
      const prevDate = addDays(date, -1);
      // 入力済みの勤務（変えない）
      const fixedWork = [];
      for (const p of people) {
        const s = map.get(`${p.m.id}|${date}`);
        const sl = slotOfShift(s);
        if (!sl) continue;
        daySlot.set(`${p.m.id}|${date}`, sl);
        if (daySlot.get(`${p.m.id}|${prevDate}`) === sl) repeatWhy.set(`${p.m.id}|${date}`, '入力済みのマスのため');
        if (p.counted && s.kind === 'work') fixedWork.push({ p, pat: K.storage.shiftPattern(s) });
      }
      if (i.closed) continue;
      const dayAll = people.filter((p) => p.status.get(date) === 'cand');
      const day = dayAll.filter((p) => !p.flex);
      const flexDay = dayAll.filter((p) => p.flex);
      // 30分ごとの必要人数
      const req = new Map();
      for (const b of i.bands) {
        for (let t = toMin(b.start); t < toMin(b.end); t += SLOT) req.set(t, { stylist: b.stMin, assistant: b.asMin });
      }
      const optionsOf = (p) => {
        const usual = (p.m.weeklyPatterns || {})[String(K.calc.weekdayOf(date))];
        const fit = p.pats.filter((x) => !x.dayType || x.dayType === i.dayType);
        if (usual && usual !== 'off' && fit.some((x) => x.id === usual)) return { opts: fit.filter((x) => x.id === usual), usual: true };
        return { opts: fit, usual: false };
      };
      const picks = new Map(); // 人 → 勤務パターン
      const ctx = new Map(); // 人 → { opts, usual, prev, single }
      const optsOfDay = new Map();
      dayCtx.set(date, { req, fixedWork, optsOf: optsOfDay });
      for (const p of day) {
        const { opts, usual } = optionsOf(p);
        if (!opts.length) {
          notes.push(`${p.m.name}さん：${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${i.dayType === 'holiday' ? '土日祝' : '平日'}）に使える勤務パターンがないため、空欄のままにしました。`);
          continue;
        }
        const prev = daySlot.get(`${p.m.id}|${prevDate}`) || null;
        const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
        const want = p.part ? null : prev ? (prev === 'early' ? 'late' : 'early') : mine.early <= mine.late ? 'early' : 'late';
        const inWant = want ? opts.filter((x) => slotOf(x) === want) : [];
        picks.set(p, (inWant.length ? inWant : opts)[0]);
        ctx.set(p, { opts, usual, prev, single: new Set(opts.map(slotOf)).size < 2 });
        optsOfDay.set(p.m.id, { opts, usual });
      }
      // 不足（30分ごと・役割ごとに足りない人数の合計）
      const shortage = () => {
        const cov = new Map();
        const add = (role, pat) => {
          for (let t = Math.floor(toMin(pat.start) / SLOT) * SLOT; t + SLOT <= toMin(pat.end); t += SLOT) {
            if (!cov.has(t)) cov.set(t, { stylist: 0, assistant: 0 });
            cov.get(t)[role] += 1;
          }
        };
        for (const f of fixedWork) if (f.pat) add(f.p.role, f.pat);
        for (const [p, pat] of picks) if (p.counted) add(p.role, pat);
        let n = 0;
        for (const [t, r] of req) {
          const c = cov.get(t) || { stylist: 0, assistant: 0 };
          n += Math.max(0, r.stylist - c.stylist) + Math.max(0, r.assistant - c.assistant);
        }
        return n;
      };
      const earlyCount = () =>
        fixedWork.filter((f) => f.pat && slotOf(f.pat) === 'early').length + [...picks].filter(([p, pat]) => p.counted && slotOf(pat) === 'early').length;
      const moved = new Map(); // 人 → 番を変えた理由（前日と同じ番になったとき）
      const repeatsIf = (p, pat) => (!p.part && ctx.get(p).prev && slotOf(pat) === ctx.get(p).prev ? 1 : 0);
      const tryPat = (p, pat, fn) => {
        const old = picks.get(p);
        picks.set(p, pat);
        const r = fn();
        picks.set(p, old);
        return r;
      };
      // ①' 休みの日数を決めないパート：足りない時間帯が減るときだけ、1人ずつ入れる（いちばん減る人・パターンから）。入れない人は休み
      {
        let left = flexDay.filter((p) => p.counted);
        let now = shortage();
        while (now > 0 && left.length) {
          let best = null;
          for (const p of left) {
            const { opts, usual } = optionsOf(p);
            for (const pat of opts) {
              picks.set(p, pat);
              const sh = shortage();
              picks.delete(p);
              if (sh >= now) continue;
              const score = [now - sh, -(slotCount.get(p.m.id) ? slotCount.get(p.m.id).early + slotCount.get(p.m.id).late : 0)];
              if (!best || better(score, best.score)) best = { p, pat, sh, score, opts, usual };
            }
          }
          if (!best) break;
          picks.set(best.p, best.pat);
          ctx.set(best.p, { opts: best.opts, usual: best.usual, prev: daySlot.get(`${best.p.m.id}|${prevDate}`) || null, single: new Set(best.opts.map(slotOf)).size < 2 });
          optsOfDay.set(best.p.m.id, { opts: best.opts, usual: best.usual });
          now = best.sh;
          left = left.filter((p) => p !== best.p);
        }
        for (const p of flexDay) if (!picks.has(p)) p.status.set(date, 'off');
      }
      // ② 必要人数の不足が実際に減るときだけ変える
      let cur = shortage();
      for (let guard = 0; guard < 80 && cur > 0; guard++) {
        let best = null;
        for (const p of picks.keys()) {
          if (!p.counted) continue;
          for (const pat of ctx.get(p).opts) {
            if (pat === picks.get(p)) continue;
            const sh = tryPat(p, pat, shortage);
            if (sh >= cur) continue;
            const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
            // 早早・遅遅にならない変え方があれば、必ずそちらを先に選ぶ
            const score = [-repeatsIf(p, pat), cur - sh, -mine[slotOf(pat)]];
            if (!best || better(score, best.score)) best = { p, pat, sh, score };
          }
        }
        if (!best) break;
        picks.set(best.p, best.pat);
        cur = best.sh;
        if (repeatsIf(best.p, best.pat)) moved.set(best.p, '必要人数を満たすため');
        else moved.delete(best.p);
      }
      // ③ 早番が0人なら、不足を増やさない範囲で1人を早番に
      const anyWorker = fixedWork.length + [...picks.keys()].filter((p) => p.counted).length > 0;
      if (anyWorker && earlyCount() === 0) {
        let best = null;
        for (const p of picks.keys()) {
          if (!p.counted || p.part) continue;
          for (const pat of ctx.get(p).opts) {
            if (slotOf(pat) !== 'early') continue;
            const sh = tryPat(p, pat, shortage);
            if (sh > cur) continue;
            const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
            const score = [-repeatsIf(p, pat), -(sh - cur), -mine.early];
            if (!best || better(score, best.score)) best = { p, pat, sh, score };
          }
        }
        if (best) {
          picks.set(best.p, best.pat);
          cur = best.sh;
          if (repeatsIf(best.p, best.pat)) moved.set(best.p, '早番を1人確保するため');
        }
      }
      if (anyWorker && earlyCount() === 0) {
        const canEarly = [...picks.keys()].some((p) => p.counted && ctx.get(p).opts.some((x) => slotOf(x) === 'early'));
        earlyZeroDays.push({
          date,
          reason: canEarly
            ? '早番にすると必要人数が足りなくなるため、早番を入れられませんでした'
            : '早番の勤務パターンを使える人が、この日は出勤できません（休み・希望休・有給・固定休・勤務曜日・いつもの勤務など）',
        });
      }
      // ③' 毎日そろえる出勤時刻：その時刻に出勤する人がいなければ、不足を増やさない範囲で、1人の勤務をその時刻に始まるパターンに変える
      //     （ほかのそろえる時刻を0人にしない・早番を0人にしない。早早・遅遅にならない人・回数の少ない人を先に）
      const needStarts = anyWorker ? startTimesOf(date) : [];
      const startCount = (time) =>
        fixedWork.filter((f) => f.pat && f.pat.start === time).length + [...picks].filter(([p, pat]) => p.counted && pat.start === time).length;
      const startsCovered = () => needStarts.filter((t) => startCount(t) > 0).length;
      for (const time of needStarts) {
        if (!storeStartable.has(time) || startCount(time) > 0) continue;
        let best = null;
        const before = startsCovered();
        for (const p of picks.keys()) {
          if (!p.counted) continue;
          for (const pat of ctx.get(p).opts) {
            if (pat.start !== time || pat === picks.get(p)) continue;
            const r = tryPat(p, pat, () => ({ sh: shortage(), cov: startsCovered(), early: earlyCount() }));
            if (r.sh > cur || r.cov <= before || (anyWorker && r.early === 0 && earlyCount() > 0)) continue;
            const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
            const score = [-repeatsIf(p, pat), -(r.sh - cur), -mine[slotOf(pat)]];
            if (!best || better(score, best.score)) best = { p, pat, sh: r.sh, score };
          }
        }
        if (best) {
          picks.set(best.p, best.pat);
          cur = best.sh;
          if (repeatsIf(best.p, best.pat)) moved.set(best.p, `${U.formatTime(time)}に出勤する人を確保するため`);
        } else {
          const can = [...picks.keys()].some((p) => p.counted && ctx.get(p).opts.some((x) => x.start === time));
          startMissing.push({
            date,
            time,
            reason: can
              ? 'その時刻に変えると、必要人数が足りなくなる・ほかの出勤時刻が0人になるため'
              : 'その時刻に始まる勤務パターンを使える人が、この日は出勤できません（休み・希望休・有給・固定休・勤務曜日・いつもの勤務など）',
          });
        }
      }
      const startsBase = startsCovered();
      // ④ その日の早番・遅番の人数をそろえる（役割ごと。何も悪くならない入れ替えだけ）
      for (let guard = 0; guard < 40; guard++) {
        let done = false;
        for (const role of ['stylist', 'assistant']) {
          const cnt = { early: 0, late: 0 };
          for (const f of fixedWork) if (f.p.role === role && f.pat) cnt[slotOf(f.pat)] += 1;
          for (const [p, pat] of picks) if (p.counted && p.role === role) cnt[slotOf(pat)] += 1;
          if (Math.abs(cnt.early - cnt.late) <= 1) continue;
          const from = cnt.early > cnt.late ? 'early' : 'late';
          const to = from === 'early' ? 'late' : 'early';
          let best = null;
          for (const p of picks.keys()) {
            if (!p.counted || p.part || p.role !== role || slotOf(picks.get(p)) !== from) continue;
            for (const pat of ctx.get(p).opts) {
              if (slotOf(pat) !== to || repeatsIf(p, pat)) continue;
              const ok = tryPat(p, pat, () => shortage() <= cur && (earlyCount() > 0 || !anyWorker) && startsCovered() >= startsBase);
              if (!ok) continue;
              // 早番が多い人を遅番に、遅番が多い人を早番に（回数の偏りが減る人を先に）
              const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
              const score = [to === 'late' ? mine.early - mine.late : mine.late - mine.early];
              if (!best || better(score, best.score)) best = { p, pat, score };
            }
          }
          if (best) {
            picks.set(best.p, best.pat);
            moved.delete(best.p);
            done = true;
          }
        }
        if (!done) break;
      }
      // ⑤ 早番と遅番の回数の偏りを減らす：早番が多い人と遅番が多い人の番を入れ替える（同じ役割どうし。何も悪くならないときだけ）
      const lean = (p) => {
        const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
        return mine.early - mine.late;
      };
      for (let guard = 0; guard < 20; guard++) {
        let best = null;
        const list = [...picks.keys()].filter((p) => p.counted && !p.part);
        for (const a of list) {
          if (slotOf(picks.get(a)) !== 'early' || lean(a) <= 0) continue;
          for (const b of list) {
            if (b === a || b.role !== a.role || slotOf(picks.get(b)) !== 'late' || lean(b) >= 0) continue;
            const aPat = ctx.get(a).opts.find((x) => slotOf(x) === 'late');
            const bPat = ctx.get(b).opts.find((x) => slotOf(x) === 'early');
            if (!aPat || !bPat || repeatsIf(a, aPat) || repeatsIf(b, bPat)) continue;
            const oldA = picks.get(a);
            const oldB = picks.get(b);
            picks.set(a, aPat);
            picks.set(b, bPat);
            const ok = shortage() <= cur && (earlyCount() > 0 || !anyWorker) && startsCovered() >= startsBase;
            picks.set(a, oldA);
            picks.set(b, oldB);
            if (!ok) continue;
            const score = [lean(a) - lean(b)];
            if (!best || better(score, best.score)) best = { a, b, aPat, bPat, score };
          }
        }
        if (!best || best.score[0] < 2) break;
        picks.set(best.a, best.aPat);
        picks.set(best.b, best.bPat);
        moved.delete(best.a);
        moved.delete(best.b);
      }
      // 決める
      for (const [p, pat] of picks) {
        const sl = slotOf(pat);
        const c = ctx.get(p);
        if (!p.part && c.prev === sl) {
          repeatWhy.set(`${p.m.id}|${date}`, moved.get(p) || (c.usual ? WHY_USUAL : c.single ? WHY_SINGLE : '必要人数・早番の確保を優先したため'));
        }
        daySlot.set(`${p.m.id}|${date}`, sl);
        const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
        mine[sl] += 1;
        slotCount.set(p.m.id, mine);
        assignments.push({ staffId: p.m.id, date, kind: 'work', patternId: pat.id });
      }
    }

    // ---- ⑥ 仕上げ：早番と遅番の回数の偏りが大きい人は、休みに挟まれた勤務のかたまりを、まるごと早番⇔遅番で入れ替える ----
    // かたまりの前後は休みなので、早早・遅遅は生まれない。各日で不足が増えず、早番0人にならないときだけ。
    // いつもの勤務・選べる番が1つの日・入力済みのマスは変えない。パートは対象外。
    const assignAt = new Map(assignments.map((a) => [`${a.staffId}|${a.date}`, a]));
    const patOf = new Map([...K.storage.getStaff({ storeId })].map((m) => [m.id, m]));
    const dayShortage = (date) => {
      const c = dayCtx.get(date);
      if (!c) return { short: 0, early: 0, workers: 0, starts: 0 };
      const cov = new Map();
      let early = 0;
      let workers = 0;
      const startSet = new Set();
      const add = (role, pat) => {
        for (let t = Math.floor(toMin(pat.start) / SLOT) * SLOT; t + SLOT <= toMin(pat.end); t += SLOT) {
          if (!cov.has(t)) cov.set(t, { stylist: 0, assistant: 0 });
          cov.get(t)[role] += 1;
        }
      };
      for (const f of c.fixedWork) if (f.pat) { add(f.p.role, f.pat); workers += 1; startSet.add(f.pat.start); if (slotOf(f.pat) === 'early') early += 1; }
      for (const p of people) {
        if (!p.counted) continue;
        const a = assignAt.get(`${p.m.id}|${date}`);
        if (!a || a.kind !== 'work') continue;
        const pat = K.storage.getPattern(a.patternId);
        add(p.role, pat);
        workers += 1;
        startSet.add(pat.start);
        if (slotOf(pat) === 'early') early += 1;
      }
      let short = 0;
      for (const [t, r] of c.req) {
        const v = cov.get(t) || { stylist: 0, assistant: 0 };
        short += Math.max(0, r.stylist - v.stylist) + Math.max(0, r.assistant - v.assistant);
      }
      return { short, early, workers, starts: startTimesOf(date).filter((t) => startSet.has(t)).length };
    };
    for (const p of people) {
      if (p.part || !patOf.has(p.m.id)) continue;
      for (let guard = 0; guard < 6; guard++) {
        const mine = slotCount.get(p.m.id) || { early: 0, late: 0 };
        const lean = mine.early - mine.late;
        if (Math.abs(lean) <= 2) break;
        const from = lean > 0 ? 'early' : 'late';
        const to = from === 'early' ? 'late' : 'early';
        // 勤務のかたまり（自動で入れる勤務だけが続くところ。前後は勤務でない日）
        const runs = [];
        let runDates = [];
        for (const date of [...dates, null]) {
          const a = date && assignAt.get(`${p.m.id}|${date}`);
          if (a && a.kind === 'work') runDates.push(date);
          else {
            if (runDates.length) runs.push(runDates);
            runDates = [];
          }
        }
        let flipped = false;
        for (const run of runs) {
          const slots = run.map((d) => slotOf(K.storage.getPattern(assignAt.get(`${p.m.id}|${d}`).patternId)));
          const net = slots.filter((x) => x === from).length - slots.filter((x) => x === to).length;
          if (net <= 0) continue; // 入れ替えて偏りが減るかたまりだけ
          const first = run[0];
          const last = run[run.length - 1];
          if (daySlot.get(`${p.m.id}|${addDays(first, -1)}`) || daySlot.get(`${p.m.id}|${addDays(last, 1)}`)) continue; // 前後が勤務（入力済みなど）なら変えない
          const plan2 = [];
          let ok = true;
          for (const d of run) {
            const o = (dayCtx.get(d) && dayCtx.get(d).optsOf.get(p.m.id)) || null;
            const cur = assignAt.get(`${p.m.id}|${d}`);
            const curSlot = slotOf(K.storage.getPattern(cur.patternId));
            const want = curSlot === 'early' ? 'late' : 'early';
            const alt = o && !o.usual ? o.opts.find((x) => slotOf(x) === want) : null;
            if (!alt) {
              ok = false;
              break;
            }
            plan2.push({ d, cur, alt });
          }
          if (!ok) continue;
          const before = new Map(run.map((d) => [d, dayShortage(d)]));
          for (const x of plan2) x.old = x.cur.patternId;
          for (const x of plan2) x.cur.patternId = x.alt.id;
          const worse = run.some((d) => {
            const b = before.get(d);
            const n = dayShortage(d);
            return n.short > b.short || (b.early > 0 && n.early === 0) || n.starts < b.starts;
          });
          if (worse) {
            for (const x of plan2) x.cur.patternId = x.old;
            continue;
          }
          for (const x of plan2) {
            const oldSlot = slotOf(K.storage.getPattern(x.old));
            const newSlot = slotOf(x.alt);
            mine[oldSlot] -= 1;
            mine[newSlot] += 1;
            daySlot.set(`${p.m.id}|${x.d}`, newSlot);
          }
          slotCount.set(p.m.id, mine);
          flipped = true;
          break;
        }
        if (!flipped) break;
      }
    }

    // ---- 作ったあとの確認：早早・遅遅（前日も勤務で同じ番。休みを挟んだら数えない。パートは含めない） ----
    const repeatRuns = [];
    for (const p of people) {
      if (p.part) continue;
      let run = null;
      for (const date of dates) {
        const prevDate = addDays(date, -1);
        const sl = daySlot.get(`${p.m.id}|${date}`);
        if (sl && daySlot.get(`${p.m.id}|${prevDate}`) === sl) {
          const why = repeatWhy.get(`${p.m.id}|${date}`) || '入力済みのマスのため';
          if (run && run.slot === sl && run.dates[run.dates.length - 1] === prevDate) {
            run.dates.push(date);
            if (!run.reasons.includes(why)) run.reasons.push(why);
          } else {
            run = { staffId: p.m.id, name: p.m.name, slot: sl, dates: [prevDate, date], reasons: [why] };
            repeatRuns.push(run);
          }
        }
      }
    }
    for (const r of repeatRuns) r.reason = r.reasons.join('・');
    // 「制約あり」（いつもの勤務・選べる番が1つの日だけで続いたもの）は、交互の対象外として別に記録する
    const isConstrained = (r) => r.reasons.every((x) => CONSTRAINED.includes(x));
    const constrainedRuns = repeatRuns.filter(isConstrained);
    const avoidRuns = repeatRuns.filter((r) => !isConstrained(r));
    const constrained = [];
    for (const r of constrainedRuns) {
      let c = constrained.find((x) => x.staffId === r.staffId);
      if (!c) {
        c = { staffId: r.staffId, name: r.name, reasons: [], count: 0, runs: [] };
        constrained.push(c);
      }
      c.count += r.dates.length - 1;
      c.runs.push(r);
      for (const x of r.reasons) if (!c.reasons.includes(x)) c.reasons.push(x);
    }
    for (const c of constrained) c.reason = c.reasons.join('・');

    // ---- 6：理由のお知らせ ----
    // 連休の回数の差（休みを足す人どうし）
    if (fairPeople.length >= 2) {
      const counts = fairPeople.map((p) => [p, renkyuCount(p)]);
      const values = counts.map(([, n]) => n);
      if (Math.max(...values) - Math.min(...values) >= 2) {
        notes.push(`連休の回数に差があります（${counts.map(([p, n]) => `${p.m.name}さん${n}回`).join('・')}）。人数に余裕のある平日が足りないため、そろえきれませんでした。`);
      }
    }
    if (startMissing.length) {
      notes.push(`出勤時刻をそろえられなかった日があります（無理に勤務を変えていません）：${startMissing.map((x) => `${md(x.date)}（${U.WEEKDAYS[K.calc.weekdayOf(x.date)]}）${U.formatTime(x.time)}に出勤する人がいません［${x.reason}］`).join('、')}`);
    }
    if (earlyZeroDays.length) {
      notes.push(`早番が0人の日があります（無理に勤務を変えていません）：${earlyZeroDays.map((x) => `${md(x.date)}（${U.WEEKDAYS[K.calc.weekdayOf(x.date)]}）${x.reason}`).join('、')}`);
    }
    for (const r of avoidRuns) {
      notes.push(`${r.name}さん：${SLOT_LABELS[r.slot]}が${r.dates.length}回続きました（${md(r.dates[0])}〜${md(r.dates[r.dates.length - 1])}。${r.reason}）。`);
    }
    for (const c of constrained) {
      notes.push(`${c.name}さん：制約あり（${c.reason}）。無理に変えず、早番・遅番の交互の対象外にしました（同じ番の続き${c.count}回：${c.runs.map((r) => `${md(r.dates[0])}〜${md(r.dates[r.dates.length - 1])}`).join('、')}）。`);
    }
    // 早番と遅番の回数の差が3回以上残った人（早番・遅番の両方を使える人だけ。パートは含めない）
    const imbalance = [];
    for (const p of people) {
      if (p.part || new Set(p.pats.map(slotOf)).size < 2) continue;
      const mine = slotCount.get(p.m.id);
      if (mine && Math.abs(mine.early - mine.late) >= 3) {
        imbalance.push({ staffId: p.m.id, name: p.m.name, early: mine.early, late: mine.late });
        notes.push(`${p.m.name}さん：早番${mine.early}回・遅番${mine.late}回で、回数に差があります（必要人数・早番の確保・早早／遅遅を避けることを優先したため）。`);
      }
    }
    // 必要人数に足りない日（入力済みの勤務と、この案の勤務を合わせて数える。戦力外の人は数えない）
    // 理由は3つに分ける：全員出勤しても足りない（設定・人数）／休み・希望休・有給などで足りない／自動作成の対象外の人がいる
    const shortDays = [];
    const excludedRoles = new Set([...skipped, ...noWorkdays].filter((m) => K.calc.countsAsStaff(m)).map((m) => m.role));
    for (const date of dates) {
      const n = need(date);
      if (!n.stylist && !n.assistant) continue;
      const have = { stylist: 0, assistant: 0 };
      const cap = { stylist: 0, assistant: 0 }; // 契約上この日に出勤できる人（週休・希望休・有給などの休みを含めて数える）
      const dayType = info.get(date).dayType;
      for (const p of people) {
        if (!p.counted) continue;
        const s = map.get(`${p.m.id}|${date}`);
        const working = (s && s.kind === 'work') || assignments.some((a) => a.staffId === p.m.id && a.date === date && a.kind === 'work');
        if (working) have[p.role] += 1;
        const st = p.status.get(date);
        const usualOff = (p.m.weeklyPatterns || {})[String(K.calc.weekdayOf(date))] === 'off';
        const canPattern = p.pats.some((x) => !x.dayType || x.dayType === dayType);
        if (working || (st !== 'skip' && st !== 'closed' && !p.contractOff.has(date) && !usualOff && canPattern)) cap[p.role] += 1;
      }
      const roles = Object.keys(ROLE_LABELS).filter((role) => have[role] < n[role]);
      if (!roles.length) continue;
      const parts = roles.map((role) => `${ROLE_LABELS[role]}${n[role] - have[role]}人（勤務${have[role]}人／必要${n[role]}人）`);
      const why = roles.some((role) => cap[role] < n[role])
        ? '全員出勤しても足りない：必要人数の設定か、スタッフの人数・契約の曜日を確認'
        : '休み（週休・希望休・有給など）の人がいるため';
      const extra = roles.some((role) => excludedRoles.has(role)) ? '・自動作成の対象外の人がいる（契約の勤務曜日・勤務パターンが未登録）' : '';
      shortDays.push(`${md(date)}（${U.WEEKDAYS[K.calc.weekdayOf(date)]}）${parts.join('・')}［${why}${extra}］`);
    }
    if (shortDays.length) notes.push(`必要人数に足りない日があります（勤務できる人が足りないため、無理に入れていません）：${shortDays.join('、')}`);

    // 新しく入れる休み・承認済みの有給
    for (const p of people) {
      for (const date of dates) {
        const st = p.status.get(date);
        if (st === 'off' || st === 'paid') assignments.push({ staffId: p.m.id, date, kind: st, patternId: null });
        else if (st === 'business') assignments.push({ staffId: p.m.id, date, kind: 'business', patternId: p.bizPat.get(date) || p.pats[0].id });
      }
    }
    assignments.sort((a, b) => a.date.localeCompare(b.date));

    const summary = people.map((p) => ({
      staffId: p.m.id,
      name: p.m.name,
      work: assignments.filter((a) => a.staffId === p.m.id && a.kind === 'work').length,
      off: assignments.filter((a) => a.staffId === p.m.id && a.kind === 'off').length,
      renkyu: weeklyRule(p) ? shiftRenkyu(p) : renkyuCount(p),
      part: p.part,
    }));
    // 同じ日に2人以上が休み・社用の日（設定でオンのとき。希望休・有給・固定休などが重なって避けられなかった日）
    const sameDayOff = [];
    if (spread) {
      for (const date of dates) {
        if (info.get(date).closed) continue;
        const absent = people.filter((q) => q.counted && isAbsent(q.status.get(date)));
        if (absent.length >= 2) sameDayOff.push({ date, names: absent.map((q) => q.m.name) });
      }
      if (sameDayOff.length) notes.push(`同じ日に2人以上が休み・社用の日があります（希望休・有給・固定休・定休日の前後などが重なったため。無理に変えていません）：${sameDayOff.map((x) => `${md(x.date)}（${U.WEEKDAYS[K.calc.weekdayOf(x.date)]}）${x.names.length}人`).join('、')}`);
    }
    // この人が休み・社用の日は出勤、が守れなかった日（希望休・有給・固定休が重なったとき）
    const coverMissed = [];
    for (const p of people) {
      const target = p.m.coverFor ? people.find((q) => q.m.id === p.m.coverFor) : null;
      if (!target) continue;
      for (const date of dates) {
        if (isAbsent(p.status.get(date)) && isAbsent(target.status.get(date))) coverMissed.push({ date, name: p.m.name, target: target.m.name });
      }
    }
    if (coverMissed.length) notes.push(`「休み・社用の日は出勤」の組み合わせが、同じ日に休みになりました（希望休・有給・固定休が重なったため）：${coverMissed.map((x) => `${md(x.date)} ${x.target}さんと${x.name}さん`).join('、')}`);
    const problems = { earlyZero: earlyZeroDays, startMissing, sameDayOff, coverMissed, repeats: avoidRuns, constrained, shortDays, imbalance };
    return { storeId, month, assignments, notes, problems, skipped: [...skipped, ...noWorkdays].map((m) => m.id), summary };
  }

  K.autoshift = { plan };
})();
