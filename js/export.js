// シフト表の出力（画像・印刷）
// スタッフに渡す用なので、チェックの記号（△＋）や色枠は入れない。勤務・休・有・社用と、右側の St／As／計だけ。
// インターネットには通信しない。画像はブラウザの保存・共有機能で、ご自身が保存したときだけ端末の外に出る。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  // 画像・印刷は、ダークモードでも白地で作る
  const COLORS = {
    bg: '#ffffff',
    text: '#111214',
    muted: '#6e6f73',
    border: '#e4e4e0',
    offFill: '#ecece8',
    countFill: '#f4f4f1',
    closedFill: '#f7f7f5',
    sat: '#2563eb',
    sun: '#dc2626',
  };
  const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

  // 1店舗1か月分の表のデータ（画像・印刷で共通）
  function rosterData(storeId, month) {
    const store = K.storage.getStore(storeId);
    const staff = K.calc.rosterStaff(storeId, month);
    const map = K.calc.shiftMap(month, storeId);
    const rows = K.calc.monthDates(month).map((date) => {
      const closed = K.calc.isStoreClosed(store, date);
      const cells = staff.map((m) => {
        const s = map.get(`${m.id}|${date}`);
        if (!s) return closed ? { kind: 'closed', text: '定休' } : { kind: 'blank', text: '' };
        if (s.kind === 'off') return { kind: 'off', text: '休' };
        if (s.kind === 'paid') return { kind: 'paid', text: '有' };
        const p = K.storage.getPattern(s.patternId);
        return { kind: s.kind, text: p ? p.label : '?', color: p ? p.color : '#64748b' };
      });
      return { date, closed, holiday: K.holidays.holidayName(date), weekday: K.calc.weekdayOf(date), cells, counts: K.calc.dailyCounts(staff, map, date) };
    });
    const [y, m] = month.split('-').map(Number);
    // 確定した月は、タイトルに「（確定）」を付ける
    const confirmed = K.storage.getPublication(storeId, month) ? '（確定）' : '';
    return { store, staff, rows, title: `${store.name}　${y}年${m}月　シフト表${confirmed}` };
  }

  const LEGEND = '休＝通常休　有＝有給　社＝社用（人数に含めない）　定休＝定休日　St／As／計＝その日の通常勤務の人数';

  // ---- 画像（PNG） ----

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 幅に収まるまで文字を小さくして書く
  function fitText(ctx, text, x, y, maxWidth, size, weight = '700') {
    let s = size;
    ctx.font = `${weight} ${s}px ${FONT}`;
    while (s > 7 && ctx.measureText(text).width > maxWidth) {
      s -= 0.5;
      ctx.font = `${weight} ${s}px ${FONT}`;
    }
    ctx.fillText(text, x, y);
  }

  function drawRoster(storeId, month) {
    const data = rosterData(storeId, month);
    const PAD = 20;
    const TITLE_H = 44;
    const HEAD_H = 50;
    const ROW_H = 32;
    const DATE_W = 72;
    const STAFF_W = 70;
    const COUNT_W = 42;
    const LEGEND_H = 40;
    const scale = 2; // 文字をくっきりさせるため2倍で描く

    const width = PAD * 2 + DATE_W + data.staff.length * STAFF_W + COUNT_W * 3;
    const height = PAD * 2 + TITLE_H + HEAD_H + data.rows.length * ROW_H + LEGEND_H;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.textBaseline = 'middle';

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    // タイトル
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.font = `800 20px ${FONT}`;
    ctx.fillText(data.title, PAD, PAD + TITLE_H / 2 - 4);

    const top = PAD + TITLE_H;
    const countX = PAD + DATE_W + data.staff.length * STAFF_W;

    // 右側の人数の背景
    ctx.fillStyle = COLORS.countFill;
    ctx.fillRect(countX, top, COUNT_W * 3, HEAD_H + data.rows.length * ROW_H);

    // 見出し
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.muted;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText('日付', PAD + DATE_W / 2, top + HEAD_H - 14);
    data.staff.forEach((m, i) => {
      const cx = PAD + DATE_W + i * STAFF_W + STAFF_W / 2;
      ctx.fillStyle = COLORS.text;
      fitText(ctx, m.name, cx, top + 16, STAFF_W - 8, 14, '800');
      ctx.fillStyle = COLORS.muted;
      fitText(ctx, `${U.ROLE_SHORT[m.role]}${m.title ? `・${m.title}` : ''}`, cx, top + 35, STAFF_W - 8, 11, '600');
    });
    ['St', 'As', '計'].forEach((h, i) => {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillText(h, countX + COUNT_W * i + COUNT_W / 2, top + HEAD_H - 14);
    });
    ctx.fillStyle = data.store.color;
    ctx.fillRect(PAD, top + HEAD_H - 2, width - PAD * 2, 2);

    // 各日の行
    data.rows.forEach((row, r) => {
      const y = top + HEAD_H + r * ROW_H;
      const cy = y + ROW_H / 2;
      const [, , d] = row.date.split('-').map(Number);

      if (row.closed) {
        ctx.fillStyle = COLORS.closedFill;
        ctx.fillRect(PAD, y, countX - PAD, ROW_H);
      }

      // 日付
      const dayColor = row.weekday === 0 || row.holiday ? COLORS.sun : row.weekday === 6 ? COLORS.sat : COLORS.text;
      // 日付は右寄せ、曜日はその右に少し間を空けて書く（2桁の日付と曜日がくっつかないように）
      ctx.fillStyle = dayColor;
      ctx.textAlign = 'right';
      ctx.font = `800 15px ${FONT}`;
      ctx.fillText(String(d), PAD + 30, cy);
      ctx.textAlign = 'left';
      ctx.font = `600 12px ${FONT}`;
      ctx.fillText(row.holiday ? '祝' : U.WEEKDAYS[row.weekday], PAD + 37, cy);

      // マス
      row.cells.forEach((c, i) => {
        const x = PAD + DATE_W + i * STAFF_W;
        const bx = x + 3;
        const by = y + 3;
        const bw = STAFF_W - 6;
        const bh = ROW_H - 6;
        ctx.textAlign = 'center';
        if (c.kind === 'work' || c.kind === 'business') {
          roundRect(ctx, bx, by, bw, bh, 5);
          ctx.fillStyle = `${c.color}${c.kind === 'business' ? '1a' : '2e'}`;
          ctx.fill();
          if (c.kind === 'business') {
            ctx.setLineDash([3, 2]);
            ctx.strokeStyle = c.color;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            ctx.fillStyle = c.color;
            ctx.fillRect(bx, by + 2, 3, bh - 4);
          }
          ctx.fillStyle = COLORS.text;
          fitText(ctx, c.kind === 'business' ? `社 ${c.text}` : c.text, x + STAFF_W / 2 + 1, cy, bw - 8, 13, '700');
        } else if (c.kind === 'off') {
          roundRect(ctx, bx, by, bw, bh, 5);
          ctx.fillStyle = COLORS.offFill;
          ctx.fill();
          ctx.fillStyle = COLORS.muted;
          ctx.font = `700 13px ${FONT}`;
          ctx.fillText('休', x + STAFF_W / 2, cy);
        } else if (c.kind === 'paid') {
          roundRect(ctx, bx + 0.75, by + 0.75, bw - 1.5, bh - 1.5, 5);
          ctx.strokeStyle = COLORS.text;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.fillStyle = COLORS.text;
          ctx.font = `700 13px ${FONT}`;
          ctx.fillText('有', x + STAFF_W / 2, cy);
        } else if (c.kind === 'closed') {
          ctx.fillStyle = COLORS.muted;
          ctx.font = `600 10px ${FONT}`;
          ctx.fillText('定休', x + STAFF_W / 2, cy);
        }
      });

      // 人数
      [row.counts.stylist, row.counts.assistant, row.counts.total].forEach((n, i) => {
        ctx.textAlign = 'center';
        ctx.fillStyle = COLORS.text;
        ctx.font = `${i === 2 ? 800 : 700} 13px ${FONT}`;
        ctx.fillText(String(n), countX + COUNT_W * i + COUNT_W / 2, cy);
      });

      // 行の区切り線
      ctx.fillStyle = COLORS.border;
      ctx.fillRect(PAD, y + ROW_H - 1, width - PAD * 2, 1);
    });

    // 日付と人数の列の区切り
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(PAD + DATE_W, top, 1, HEAD_H + data.rows.length * ROW_H);
    ctx.fillRect(countX, top, 1, HEAD_H + data.rows.length * ROW_H);

    // 凡例
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.muted;
    fitText(ctx, LEGEND, PAD, height - PAD - LEGEND_H / 2 + 6, width - PAD * 2, 12, '500');

    return canvas;
  }

  function isIOS() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像を作れませんでした。'))), 'image/png');
    });
  }

  // ファイルを保存する（iPhone は共有メニュー、それ以外はダウンロード）
  // 戻り値：'shared' / 'downloaded' / 'cancelled'
  async function saveFiles(files) {
    if (isIOS() && typeof navigator.canShare === 'function') {
      const list = files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
      if (navigator.canShare({ files: list })) {
        try {
          await navigator.share({ files: list });
          return 'shared';
        } catch (err) {
          if (err.name === 'AbortError') return 'cancelled';
          console.warn(err);
        }
      }
    }
    for (const f of files) {
      const url = URL.createObjectURL(f.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    return 'downloaded';
  }

  // 店舗ごとに1枚ずつ画像を作って保存する
  async function saveImages(storeIds, month) {
    const files = [];
    for (const id of storeIds) {
      const store = K.storage.getStore(id);
      const blob = await canvasToBlob(drawRoster(id, month));
      files.push({ blob, name: `シフト表_${store.name}_${month}.png` });
    }
    return saveFiles(files);
  }

  // ---- 印刷（A4横・1店舗1ページ） ----

  function printPage(storeId, month) {
    const el = U.el;
    const data = rosterData(storeId, month);
    const compact = data.staff.length > 10 ? ' is-compact' : '';
    return el(
      'section',
      { class: `print-page${compact}`, style: { '--store-color': data.store.color } },
      el('h1', { class: 'print-title' }, data.title),
      el(
        'table',
        { class: 'print-table' },
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            el('th', { class: 'print-date' }, '日付'),
            data.staff.map((m) =>
              el('th', null, el('span', { class: 'print-name' }, m.name), el('span', { class: 'print-role' }, `${U.ROLE_SHORT[m.role]}${m.title ? `・${m.title}` : ''}`))
            ),
            el('th', { class: 'print-count' }, 'St'),
            el('th', { class: 'print-count' }, 'As'),
            el('th', { class: 'print-count' }, '計')
          )
        ),
        el(
          'tbody',
          null,
          data.rows.map((row) => {
            const [, , d] = row.date.split('-').map(Number);
            const dayCls = row.weekday === 0 || row.holiday ? ' is-sun' : row.weekday === 6 ? ' is-sat' : '';
            return el(
              'tr',
              { class: row.closed ? 'is-closed' : null },
              el('th', { class: `print-date${dayCls}` }, `${d} ${row.holiday ? '祝' : U.WEEKDAYS[row.weekday]}`),
              row.cells.map((c) =>
                el(
                  'td',
                  { class: `p-${c.kind}`, style: c.color ? { '--pattern-color': c.color } : null },
                  c.kind === 'business' ? `社 ${c.text}` : c.text
                )
              ),
              el('td', { class: 'print-count' }, String(row.counts.stylist)),
              el('td', { class: 'print-count' }, String(row.counts.assistant)),
              el('td', { class: 'print-count print-count--total' }, String(row.counts.total))
            );
          })
        )
      ),
      el('p', { class: 'print-legend' }, LEGEND)
    );
  }

  function printRosters(storeIds, month) {
    const old = document.getElementById('print-root');
    if (old) old.remove();
    const root = U.el('div', { id: 'print-root' }, storeIds.map((id) => printPage(id, month)));
    document.body.append(root);
    const cleanup = () => {
      root.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  }

  K.exporter = { drawRoster, saveImages, printRosters, saveFiles };
})();
