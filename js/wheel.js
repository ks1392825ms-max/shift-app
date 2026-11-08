// 時刻をスクロールで選ぶ（11/8〜）：押すと下から出る窓に「時」「分」の2つの列。指でくるくる回して、真ん中の行が選ばれる
// K.wheel.button({ value, from, to, step, label, onchange }) → 押すと選べるボタン（今の時刻を表示）
// K.wheel.pickTime({ value, from, to, step, title }) → Promise（"13:30" / やめたら null）
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;
  const el = U.el;
  const ROW = 44; // 1行の高さ（px）

  function column(items, index, label) {
    const list = el('div', { class: 'wheel__list', role: 'listbox', 'aria-label': label, tabindex: '0' });
    list.append(el('div', { class: 'wheel__pad', 'aria-hidden': 'true' }));
    for (const it of items) list.append(el('div', { class: 'wheel__item', role: 'option', 'data-value': it.value }, it.text));
    list.append(el('div', { class: 'wheel__pad', 'aria-hidden': 'true' }));
    const col = el('div', { class: 'wheel__col' }, list);
    const mark = () => {
      const i = current();
      list.querySelectorAll('.wheel__item').forEach((x, k) => {
        x.classList.toggle('is-selected', k === i);
        x.setAttribute('aria-selected', String(k === i));
      });
    };
    const current = () => Math.max(0, Math.min(items.length - 1, Math.round(list.scrollTop / ROW)));
    const setIndex = (i, smooth) => {
      list.scrollTo({ top: i * ROW, behavior: smooth ? 'smooth' : 'auto' });
      setTimeout(mark, smooth ? 250 : 0);
    };
    let timer;
    list.addEventListener('scroll', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const i = current();
        if (Math.abs(list.scrollTop - i * ROW) > 1) setIndex(i, true);
        mark();
      }, 90);
      mark();
    });
    // 行を押しても選べる。上下の矢印キーでも動かせる
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.wheel__item');
      if (item) setIndex([...list.querySelectorAll('.wheel__item')].indexOf(item), true);
    });
    list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex(Math.max(0, Math.min(items.length - 1, current() + (e.key === 'ArrowDown' ? 1 : -1))), true);
      }
    });
    return { node: col, value: () => items[current()].value, init: () => setIndex(index, false) };
  }

  function pickTime({ value, from = '06:00', to = '23:30', step = 30, title = '時刻を選ぶ' }) {
    return new Promise((resolve) => {
      const fromM = U.toMinutes(from);
      const toM = U.toMinutes(to);
      const hours = [];
      for (let h = Math.floor(fromM / 60); h <= Math.floor(toM / 60); h++) hours.push({ value: h, text: String(h) });
      const mins = [];
      for (let m = 0; m < 60; m += step) mins.push({ value: m, text: String(m).padStart(2, '0') });
      const cur = U.toMinutes(value || from);
      const hCol = column(hours, Math.max(0, hours.findIndex((x) => x.value === Math.floor(cur / 60))), '時');
      const mCol = column(mins, Math.max(0, mins.findIndex((x) => x.value === cur % 60)), '分');
      const close = (result) => {
        layer.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
      };
      const ok = () => {
        const total = Math.min(Math.max(hCol.value() * 60 + mCol.value(), fromM), toM);
        close(U.fromMinutes(total));
      };
      const panel = el(
        'div',
        { class: 'wheel-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'wheel-sheet__head' }, el('button', { type: 'button', class: 'text-btn', onclick: () => close(null) }, 'やめる'), el('strong', null, title), el('button', { type: 'button', class: 'text-btn wheel-sheet__ok', onclick: ok }, '決定')),
        el('div', { class: 'wheel' }, hCol.node, el('span', { class: 'wheel__sep' }, '時'), mCol.node, el('span', { class: 'wheel__sep' }, '分'), el('div', { class: 'wheel__band', 'aria-hidden': 'true' }))
      );
      const layer = el('div', { class: 'wheel-layer' }, el('div', { class: 'wheel-layer__back', onclick: () => close(null) }), panel);
      document.body.append(layer);
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(() => {
        hCol.init();
        mCol.init();
        panel.querySelector('.wheel__list').focus({ preventScroll: true });
      });
    });
  }

  // 押すと選べるボタン
  function button({ value, from, to, step, label, onchange }) {
    const btn = el('button', { type: 'button', class: 'wheel-btn', 'aria-label': `${label}（今：${U.formatTime(value)}）` }, el('span', { class: 'wheel-btn__label' }, label), el('span', { class: 'wheel-btn__value' }, U.formatTime(value)));
    btn.addEventListener('click', async () => {
      const v = await pickTime({ value: btn.dataset.value || value, from, to, step, title: label });
      if (v === null) return;
      btn.dataset.value = v;
      btn.querySelector('.wheel-btn__value').textContent = U.formatTime(v);
      btn.setAttribute('aria-label', `${label}（今：${U.formatTime(v)}）`);
      if (onchange) onchange(v);
    });
    btn.dataset.value = value;
    return btn;
  }

  K.wheel = { pickTime, button };
})();
