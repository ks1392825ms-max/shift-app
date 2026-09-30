// どの画面からも使う、小さな便利関数をまとめたファイル
(function () {
  'use strict';
  const K = (window.ShiftApp = window.ShiftApp || {});

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  // 役割の表示名
  const ROLE_LABELS = { stylist: 'スタイリスト', assistant: 'アシスタント' };
  const ROLE_SHORT = { stylist: 'St', assistant: 'As' };

  // 重ならないID（UUID）を作る
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // ---- 日付 ----

  // Date → "2026-10-01"
  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayStr() {
    return toDateStr(new Date());
  }

  // "2026-10-01" が実在する日付か
  function isValidDate(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const [y, m, d] = text.split('-').map(Number);
    return toDateStr(new Date(y, m - 1, d)) === text;
  }

  // "2026-10-01" → "2026/10/1(木)"
  function formatDateLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const w = WEEKDAYS[new Date(y, m - 1, d).getDay()];
    return `${y}/${m}/${d}(${w})`;
  }

  // ---- 時刻（"09:30" の形。30分刻み） ----

  // "09:30" → 570（0時からの分）
  function toMinutes(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  // 570 → "09:30"
  function fromMinutes(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // "09:00" → "9:00"（表示用）
  function formatTime(time) {
    const [h, m] = time.split(':');
    return `${Number(h)}:${m}`;
  }

  // "09:00" → "9"、"09:30" → "9:30"（勤務パターンの短い表示名用）
  function shortTime(time) {
    const [h, m] = time.split(':');
    return m === '00' ? String(Number(h)) : `${Number(h)}:${m}`;
  }

  // 480 → "8時間"、450 → "7.5時間"
  function formatHours(minutes) {
    return `${Number((minutes / 60).toFixed(2))}時間`;
  }

  // from〜to の時刻を step 分刻みで並べる（"00:00" 〜 "24:00"）
  function timeOptions(from = 0, to = 24 * 60, step = 30) {
    const list = [];
    for (let m = from; m <= to; m += step) list.push(fromMinutes(m));
    return list;
  }

  // "HH:MM" の形で、step 分刻み・0:00〜24:00 の範囲か
  function isValidTime(text, step = 30) {
    if (typeof text !== 'string' || !/^\d{2}:\d{2}$/.test(text)) return false;
    const minutes = toMinutes(text);
    return minutes >= 0 && minutes <= 24 * 60 && minutes % step === 0;
  }

  // ---- 画面の部品 ----

  // HTML要素を作る関数。文字は textContent として入れるので、名前に記号が入っても安全
  const PROPS = ['value', 'checked', 'disabled', 'hidden', 'selected'];
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'style' && typeof value === 'object') {
          for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
        } else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2), value);
        } else if (PROPS.includes(key)) node[key] = value;
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  // 時刻を選ぶ <select> を作る
  function timeSelect({ id, value, from, to, step, onchange }) {
    return el(
      'select',
      { id, class: 'field__input field__input--time', onchange },
      timeOptions(from, to, step).map((t) => el('option', { value: t, selected: t === value }, formatTime(t)))
    );
  }

  K.utils = {
    WEEKDAYS,
    ROLE_LABELS,
    ROLE_SHORT,
    uuid,
    nowIso,
    toDateStr,
    todayStr,
    isValidDate,
    formatDateLabel,
    toMinutes,
    fromMinutes,
    formatTime,
    shortTime,
    formatHours,
    timeOptions,
    isValidTime,
    el,
    timeSelect,
  };
})();
