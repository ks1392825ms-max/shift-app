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
        if (!s) return closed ? { kind: 'closed', text: K.calc.closedLabel(store, date) } : { kind: 'blank', text: '' };
        if (s.kind === 'off') return { kind: 'off', text: '休' };
        if (s.kind === 'paid') return { kind: 'paid', text: '有' };
        const p = K.storage.getPattern(s.patternId);
        // 勤務の日の社用予定（取り消し中のものは出さない）
        const day = s.kind === 'work' ? K.calc.staffDay(m, s, date) : null;
        const plans = day ? day.business.filter((b) => !b.skipped).map((b) => `社 ${shortRange(b)} ${K.calc.businessWhat(b)}`) : [];
        return { kind: s.kind, text: p ? p.label : '?', color: p ? p.color : '#64748b', plans };
      });
      return { date, closed, holiday: K.holidays.holidayName(date), weekday: K.calc.weekdayOf(date), cells, counts: K.calc.dailyCounts(staff, map, date) };
    });
    const [y, m] = month.split('-').map(Number);
    // 確定した月は、タイトルに「（確定）」を付ける
    const confirmed = K.storage.getPublication(storeId, month) ? '（確定）' : '';
    return { store, staff, rows, title: `${store.name}　${y}年${m}月　シフト表${confirmed}` };
  }

  const LEGEND = '休＝通常休　有＝有給　勤務の下の「社 時間 内容」＝社用予定　「社 勤務」＝終日の社用（人数に含めない）　定休＝定休日　休業＝臨時休業　St／As／計＝その日の通常勤務の人数';

  // 社用予定の短い時刻（例：13:00〜15:00 → 13-15、13:30〜15:00 → 13:30-15）
  function shortTime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
  }

  function shortRange(b) {
    return `${shortTime(b.start)}-${shortTime(b.end)}`;
  }

  // マスの1行目の文字（勤務の名前・休・有・定休）
  function cellLabel(c) {
    return c.kind === 'business' ? `社 ${c.text}` : c.text;
  }

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

  // 文字を幅に合わせて行に分ける（日本語は1文字ずつ折り返せる）
  function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const ch of Array.from(text)) {
      if (line && ctx.measureText(line + ch).width > maxWidth) {
        lines.push(line);
        line = ch.trim() ? ch : '';
      } else {
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // 名前を2行までに収まる大きさで行に分ける（9px でも収まらないときは3行以上にする。途中で切らない）
  function nameLines(ctx, text, maxWidth) {
    for (let s = 14; s >= 9; s -= 0.5) {
      ctx.font = `800 ${s}px ${FONT}`;
      const lines = wrapLines(ctx, text, maxWidth);
      if (lines.length <= 2 || s === 9) return { size: s, lines };
    }
    return { size: 9, lines: [text] };
  }

  function drawRoster(storeId, month) {
    const data = rosterData(storeId, month);
    const PAD = 20;
    const TITLE_H = 44;
    const ROW_H = 32;
    const PLAN_LINE_H = 12;
    const PLAN_SIZE = 10;
    const DATE_W = 72;
    const COUNT_W = 42;
    const LEGEND_H = 40;
    const scale = 2; // 文字をくっきりさせるため2倍で描く

    // 列の幅：いちばん長い勤務の名前が 13px で入る幅（最低 70px）
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `700 13px ${FONT}`;
    let widest = 0;
    data.rows.forEach((row) => row.cells.forEach((c) => (widest = Math.max(widest, probe.measureText(cellLabel(c)).width))));
    const STAFF_W = Math.max(70, Math.ceil(widest + 18));

    // 見出し：名前は2行まで（長いときは小さく）
    const heads = data.staff.map((m) => nameLines(probe, m.name, STAFF_W - 8));
    const nameRows = Math.max(1, ...heads.map((h) => h.lines.length));
    const HEAD_H = 34 + nameRows * 16;

    // 社用予定の行（マスの幅で折り返す）。行の高さは、その日にいちばん行が多いマスに合わせる
    probe.font = `600 ${PLAN_SIZE}px ${FONT}`;
    const rowPlans = data.rows.map((row) => row.cells.map((c) => (c.plans || []).flatMap((t) => wrapLines(probe, t, STAFF_W - 14))));
    const rowHeights = rowPlans.map((cells) => ROW_H + Math.max(0, ...cells.map((l) => l.length)) * PLAN_LINE_H);
    const bodyH = rowHeights.reduce((a, b) => a + b, 0);

    const width = PAD * 2 + DATE_W + data.staff.length * STAFF_W + COUNT_W * 3;
    const height = PAD * 2 + TITLE_H + HEAD_H + bodyH + LEGEND_H;
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
    ctx.fillRect(countX, top, COUNT_W * 3, HEAD_H + bodyH);

    // 見出し
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.muted;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText('日付', PAD + DATE_W / 2, top + HEAD_H - 14);
    data.staff.forEach((m, i) => {
      const cx = PAD + DATE_W + i * STAFF_W + STAFF_W / 2;
      const h = heads[i];
      ctx.fillStyle = COLORS.text;
      ctx.font = `800 ${h.size}px ${FONT}`;
      h.lines.forEach((line, k) => ctx.fillText(line, cx, top + 14 + k * 16));
      ctx.fillStyle = COLORS.muted;
      fitText(ctx, `${U.ROLE_SHORT[m.role]}${m.title ? `・${m.title}` : ''}`, cx, top + HEAD_H - 14, STAFF_W - 8, 11, '600');
    });
    ['St', 'As', '計'].forEach((h, i) => {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillText(h, countX + COUNT_W * i + COUNT_W / 2, top + HEAD_H - 14);
    });
    ctx.fillStyle = data.store.color;
    ctx.fillRect(PAD, top + HEAD_H - 2, width - PAD * 2, 2);

    // 各日の行
    let y = top + HEAD_H;
    data.rows.forEach((row, r) => {
      const rowH = rowHeights[r];
      const cy = y + ROW_H / 2;
      const [, , d] = row.date.split('-').map(Number);

      if (row.closed) {
        ctx.fillStyle = COLORS.closedFill;
        ctx.fillRect(PAD, y, countX - PAD, rowH);
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
        const bh = rowH - 6;
        const plans = rowPlans[r][i];
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
          fitText(ctx, cellLabel(c), x + STAFF_W / 2 + 2, cy, bw - 10, 13, '700');
          // 社用予定（勤務の下に小さく）
          ctx.font = `600 ${PLAN_SIZE}px ${FONT}`;
          plans.forEach((line, k) => ctx.fillText(line, x + STAFF_W / 2 + 2, y + ROW_H - 4 + k * PLAN_LINE_H));
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
          ctx.fillText(c.text || '定休', x + STAFF_W / 2, cy);
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
      ctx.fillRect(PAD, y + rowH - 1, width - PAD * 2, 1);
      y += rowH;
    });

    // 日付と人数の列の区切り
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(PAD + DATE_W, top, 1, HEAD_H + bodyH);
    ctx.fillRect(countX, top, 1, HEAD_H + bodyH);

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

  // ---- 印刷（A4横。スタッフが多い店舗は、何人かずつに分けて2ページ以上にする） ----

  const PRINT = {
    pageWidth: 281, // A4横 297mm − 左右の余白 8mm × 2
    dateWidth: 12,
    countWidth: 8, // St／As／計 の1列
    cellPad: 3.4, // マスの左右の余白と色の線（mm）
    minColumn: 12, // スタッフの1列の最低幅（mm）
    maxPt: 8, // マスの文字の大きさ（pt）
    minPt: 7, // これより小さくはしない（入らないときはページを分ける）
    maxNamePt: 8.5,
  };
  const PT_MM = 25.4 / 72;
  let probeCtx = null;

  // 文字の幅（mm）。少し広めに見積もる（ブラウザによる字の幅の違いの分）
  function textMm(text, pt, weight = 700) {
    if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d');
    probeCtx.font = `${weight} 100px ${FONT}`;
    return (probeCtx.measureText(text).width / 100) * pt * PT_MM * 1.08;
  }

  // 1店舗分の印刷の割り付け：スタッフを何人ずつのページに分けるか、各ページの列の幅と文字の大きさ
  function printLayout(data) {
    const area = PRINT.pageWidth - PRINT.dateWidth - PRINT.countWidth * 3;
    const labels = (staffIdx) => {
      const set = new Set();
      data.rows.forEach((row) => staffIdx.forEach((i) => set.add(cellLabel(row.cells[i]))));
      return [...set].filter(Boolean);
    };
    const widestAt = (texts, pt) => Math.max(0, ...texts.map((t) => textMm(t, pt)));

    const all = data.staff.map((_, i) => i);
    // 最小の文字（7pt）で、いちばん長いマスの文字が入る幅を、1列の最低幅にする
    const minCol = Math.max(PRINT.minColumn, widestAt(labels(all), PRINT.minPt) + PRINT.cellPad);
    const perPageMax = Math.max(1, Math.floor(area / minCol));
    const pageCount = Math.max(1, Math.ceil(data.staff.length / perPageMax));
    const perPage = Math.ceil(data.staff.length / pageCount);

    const pages = [];
    for (let p = 0; p < pageCount; p++) {
      const idx = all.slice(p * perPage, (p + 1) * perPage);
      const col = idx.length ? area / idx.length : area;
      const texts = labels(idx);
      // マスの文字：入るいちばん大きい大きさ（8pt〜7pt）
      let pt = PRINT.maxPt;
      while (pt > PRINT.minPt && widestAt(texts, pt) + PRINT.cellPad > col) pt -= 0.5;
      // 名前：2行に収まるいちばん大きい大きさ（収まらないときは7ptで3行以上に折り返す。途中で切らない）
      const names = idx.map((i) => data.staff[i].name);
      let namePt = PRINT.maxNamePt;
      while (namePt > PRINT.minPt && names.some((n) => textMm(n, namePt, 800) > (col - 2) * 2 * 0.92)) namePt -= 0.5;
      pages.push({ idx, pt, namePt });
    }
    return pages;
  }

  function printTable(data, page, title) {
    const el = U.el;
    const staff = page.idx.map((i) => data.staff[i]);
    const colCount = 1 + staff.length + 3;
    return el(
      'table',
      { class: 'print-table', style: { '--cell-pt': `${page.pt}pt`, '--name-pt': `${page.namePt}pt` } },
      el(
        'colgroup',
        null,
        el('col', { class: 'print-col-date' }),
        staff.map(() => el('col')),
        [0, 1, 2].map(() => el('col', { class: 'print-col-count' }))
      ),
      // 見出し（2ページ目以降や、表が次のページに続くときも、毎回出る）
      el(
        'thead',
        null,
        el('tr', { class: 'print-title-row' }, el('th', { colspan: String(colCount), class: 'print-title' }, title)),
        el(
          'tr',
          { class: 'print-head-row' },
          el('th', { class: 'print-date' }, '日付'),
          staff.map((m) =>
            el('th', { class: 'print-staff' }, el('span', { class: 'print-name' }, m.name), el('span', { class: 'print-role' }, `${U.ROLE_SHORT[m.role]}${m.title ? `・${m.title}` : ''}`))
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
            page.idx.map((i) => {
              const c = row.cells[i];
              return el(
                'td',
                { class: `p-${c.kind}`, style: c.color ? { '--pattern-color': c.color } : null },
                el('span', { class: 'print-cell' }, cellLabel(c)),
                (c.plans || []).map((t) => el('span', { class: 'print-plan' }, t))
              );
            }),
            el('td', { class: 'print-count' }, String(row.counts.stylist)),
            el('td', { class: 'print-count' }, String(row.counts.assistant)),
            el('td', { class: 'print-count print-count--total' }, String(row.counts.total))
          );
        })
      )
    );
  }

  // 1店舗分のページ（スタッフが多いときは2ページ以上）
  function printPages(storeId, month) {
    const el = U.el;
    const data = rosterData(storeId, month);
    const pages = printLayout(data);
    return pages.map((page, p) => {
      const part = pages.length > 1 ? `　（スタッフ ${p + 1}/${pages.length}）` : '';
      return el(
        'section',
        { class: 'print-page', style: { '--store-color': data.store.color } },
        printTable(data, page, `${data.title}${part}`),
        el('p', { class: 'print-legend' }, pages.length > 1 ? `${LEGEND}　※スタッフが多いため${pages.length}つの表に分けています（St／As／計は全員の人数）` : LEGEND)
      );
    });
  }

  // onNotOpened：印刷の画面が開かなかったとき（Chrome は、続けて何度も印刷すると、読み込み直すまで黙って無視することがある）
  // 表を作る途中で失敗したときは、例外をそのまま投げる（呼んだ側で理由を出す）
  function printRosters(storeIds, month, { onNotOpened } = {}) {
    const old = document.getElementById('print-root');
    if (old) old.remove();
    const root = U.el('div', { id: 'print-root' }, storeIds.flatMap((id) => printPages(id, month)));
    document.body.append(root);
    const cleanup = () => {
      root.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // 印刷の画面が開くと beforeprint が来る。少し待っても来なければ、開かなかったと判断する
    let opened = false;
    const onBefore = () => {
      opened = true;
    };
    window.addEventListener('beforeprint', onBefore);
    window.print();
    setTimeout(() => {
      window.removeEventListener('beforeprint', onBefore);
      if (!opened && onNotOpened) onNotOpened();
    }, 1500);
  }

  K.exporter = { drawRoster, saveImages, printRosters, printLayout, rosterData, saveFiles };
})();
