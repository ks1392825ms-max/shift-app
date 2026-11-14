// PDF ファイルを作る（11/14〜 勤怠集計表）
// ・ホーム画面に追加した iPhone のアプリでは、印刷の画面（window.print）が開かないことがあるので、PDF のファイルそのものを作る
// ・1ページ＝A4 縦の絵（canvas）。絵は JPEG にして、そのまま PDF に入れる（文字は絵の中。外のライブラリや字の形のデータはいらない）
// ・全部その場で（待たずに）作る。押した操作の続きのまま、共有メニューを開けるようにするため
(function () {
  'use strict';

  const K = window.ShiftApp;

  const A4 = { w: 210, h: 297 }; // mm
  const PT = 72 / 25.4; // 1mm → PDF の単位（pt）
  const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
  const PX_MM = 6; // 1mm を何ピクセルで描くか（約150dpi）

  // A4 縦の紙を1枚用意する。描くときは mm で指定する（ctx は mm の単位に合わせてある）
  function page() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(A4.w * PX_MM);
    canvas.height = Math.round(A4.h * PX_MM);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(PX_MM, PX_MM);
    ctx.textBaseline = 'middle';
    return { canvas, ctx };
  }

  // 字の大きさ（pt）→ canvas の font（mm の単位）
  function font(ctx, pt, weight = 400) {
    ctx.font = `${weight} ${(pt / PT).toFixed(3)}px ${FONT}`;
  }

  // 枠の中に1行で書く。入らないときは、入るまで字を小さくする（minPt まで）
  function text(ctx, str, x, y, w, { pt = 9.5, weight = 400, align = 'left', color = '#111', minPt = 5.5, pad = 1.5 } = {}) {
    const s = String(str == null ? '' : str);
    if (!s) return;
    let size = pt;
    font(ctx, size, weight);
    const room = Math.max(1, w - pad * 2);
    while (size > minPt && ctx.measureText(s).width > room) {
      size -= 0.25;
      font(ctx, size, weight);
    }
    ctx.fillStyle = color;
    ctx.textAlign = align;
    const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w - pad : x + pad;
    ctx.fillText(s, tx, y, room);
  }

  // 表を描く。cols：列の幅（mm）、rows：[{ cells, h, fill, styles }]。線は 0.25mm
  function table(ctx, x, y, cols, rows) {
    let cy = y;
    for (const row of rows) {
      let cx = x;
      cols.forEach((w, i) => {
        const st = (row.styles && row.styles[i]) || {};
        const fill = st.fill || row.fill;
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fillRect(cx, cy, w, row.h);
        }
        const v = row.cells[i];
        const lines = Array.isArray(v) ? v : [v];
        const opts = Object.assign({}, row.text, st);
        const lh = row.h / (lines.length + (lines.length > 1 ? 0.6 : 0));
        lines.forEach((ln, k) => {
          const ty = lines.length > 1 ? cy + lh * (k + 0.8) : cy + row.h / 2;
          text(ctx, ln, cx, ty, w, opts);
        });
        if (st.after) st.after(ctx, cx, cy, w, row.h);
        cx += w;
      });
      cy += row.h;
    }
    // 線
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.25;
    const total = cols.reduce((a, b) => a + b, 0);
    let ly = y;
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + total, ly);
    for (const row of rows) {
      ly += row.h;
      ctx.moveTo(x, ly);
      ctx.lineTo(x + total, ly);
    }
    let lx = x;
    ctx.moveTo(lx, y);
    ctx.lineTo(lx, ly);
    for (const w of cols) {
      lx += w;
      ctx.moveTo(lx, y);
      ctx.lineTo(lx, ly);
    }
    ctx.stroke();
    return ly;
  }

  // 結合したセルの縦の線を消す（同じ行の i 番目と i+1 番目の間）。表を描いたあとに呼ぶ
  function joinCells(ctx, x, y, cols, h, i, fill = '#fff') {
    const lx = x + cols.slice(0, i + 1).reduce((a, b) => a + b, 0);
    ctx.fillStyle = fill;
    ctx.fillRect(lx - 0.2, y + 0.15, 0.4, h - 0.3);
  }

  // data URL（base64）→ バイト
  function bytesOf(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // 絵のページ（canvas）を並べた PDF（Blob）を作る
  function build(canvases, { title = '' } = {}) {
    const enc = new TextEncoder();
    const parts = [];
    let size = 0;
    const offsets = [];
    const push = (chunk) => {
      const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
      parts.push(b);
      size += b.length;
    };
    const obj = (n, body) => {
      offsets[n] = size;
      push(`${n} 0 obj\n`);
      body();
      push('\nendobj\n');
    };
    const W = (A4.w * PT).toFixed(2);
    const H = (A4.h * PT).toFixed(2);
    const n = canvases.length;
    // 1：カタログ、2：ページの一覧、3：情報、そのあと1ページにつき3つ（ページ・中身・絵）
    const pageNo = (i) => 4 + i * 3;
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${canvases.map((_, i) => `${pageNo(i)} 0 R`).join(' ')}] >>`));
    // 題名は UTF-16BE（16進）で入れる
    const hex = (s) => 'FEFF' + Array.from(s).map((c) => {
      const code = c.codePointAt(0);
      const u = code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code];
      return u.map((v) => v.toString(16).padStart(4, '0')).join('');
    }).join('').toUpperCase();
    obj(3, () => push(`<< /Title <${hex(title)}> /Producer (RENASCOR SHIFT) >>`));
    canvases.forEach((cv, i) => {
      const p = pageNo(i);
      const img = bytesOf(cv.toDataURL('image/jpeg', 0.88));
      const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
      obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
      obj(p + 1, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
      obj(p + 2, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
        push(img);
        push('\nendstream');
      });
    });
    const count = 4 + n * 3;
    const xref = size;
    let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let k = 1; k < count; k++) x += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
    push(x);
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  K.pdf = { A4, page, font, text, table, joinCells, build };
})();
