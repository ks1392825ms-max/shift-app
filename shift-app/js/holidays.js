// 日本の祝日の判定（インターネットには通信せず、計算で求める）
// 国民の祝日・振替休日・国民の休日に対応。設定画面での追加・取り消しは storage.js に保存し、ここで反映する。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  const cache = new Map(); // 年 → Map(日付 → 祝日名)

  function ymd(y, m, d) {
    return U.toDateStr(new Date(y, m - 1, d));
  }

  // その月の第n月曜日
  function nthMonday(y, m, n) {
    const first = new Date(y, m - 1, 1).getDay();
    const day = 1 + ((8 - first) % 7) + (n - 1) * 7;
    return ymd(y, m, day);
  }

  // 春分の日・秋分の日（1980〜2099年の計算式）
  function equinox(y, base) {
    return Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  }

  // 祝日法による、その年の祝日（手直しを反映する前）
  function yearHolidays(y) {
    if (cache.has(y)) return cache.get(y);
    const list = new Map();
    const add = (date, name) => list.set(date, name);

    add(ymd(y, 1, 1), '元日');
    add(nthMonday(y, 1, 2), '成人の日');
    add(ymd(y, 2, 11), '建国記念の日');
    if (y >= 2020) add(ymd(y, 2, 23), '天皇誕生日');
    add(ymd(y, 3, equinox(y, 20.8431)), '春分の日');
    add(ymd(y, 4, 29), '昭和の日');
    add(ymd(y, 5, 3), '憲法記念日');
    add(ymd(y, 5, 4), 'みどりの日');
    add(ymd(y, 5, 5), 'こどもの日');
    add(nthMonday(y, 7, 3), '海の日');
    if (y >= 2016) add(ymd(y, 8, 11), '山の日');
    add(nthMonday(y, 9, 3), '敬老の日');
    add(ymd(y, 9, equinox(y, 23.2488)), '秋分の日');
    add(nthMonday(y, 10, 2), 'スポーツの日');
    add(ymd(y, 11, 3), '文化の日');
    add(ymd(y, 11, 23), '勤労感謝の日');

    const next = (date, delta) => {
      const [yy, mm, dd] = date.split('-').map(Number);
      return U.toDateStr(new Date(yy, mm - 1, dd + delta));
    };
    const weekday = (date) => {
      const [yy, mm, dd] = date.split('-').map(Number);
      return new Date(yy, mm - 1, dd).getDay();
    };

    // 国民の休日：祝日にはさまれた平日
    for (const date of [...list.keys()]) {
      const between = next(date, 1);
      if (list.has(next(date, 2)) && !list.has(between) && weekday(between) !== 0) add(between, '国民の休日');
    }

    // 振替休日：祝日が日曜なら、その後の最初の祝日でない日
    for (const date of [...list.keys()].sort()) {
      if (weekday(date) !== 0) continue;
      let d = next(date, 1);
      while (list.has(d)) d = next(d, 1);
      add(d, '振替休日');
    }

    cache.set(y, list);
    return list;
  }

  // 祝日なら名前、そうでなければ null（設定画面での追加・取り消しを反映）
  function holidayName(dateStr) {
    const edit = K.storage.getHolidayEdit(dateStr);
    if (edit) return edit.action === 'add' ? edit.name || '休日' : null;
    return yearHolidays(Number(dateStr.slice(0, 4))).get(dateStr) || null;
  }

  // その年の祝日の一覧（手直しを反映する前）：[{ date, name }]
  function listYear(y) {
    return [...yearHolidays(y)].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
  }

  K.holidays = { holidayName, listYear, builtIn: (dateStr) => yearHolidays(Number(dateStr.slice(0, 4))).get(dateStr) || null };
})();
