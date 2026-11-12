// Excel のファイル（.xlsx）を作る（11/9〜 勤怠の集計表の出力）
// インターネットには通信しない。外の部品も使わない（ZIP は圧縮しない形で、その場で組み立てる）。
// K.xlsx.build([{ name: 'シート名', rows: [['A1', 'B1'], ['A2']] }]) → Blob（11/12〜 罫線などの見た目・セルの結合・A4 の印刷の設定もつけられる）
(function () {
  'use strict';
  const K = window.ShiftApp;

  // ---- ZIP（圧縮なし） ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // 名前は UTF-8
      local.setUint16(8, 0, true); // 圧縮なし
      local.setUint16(10, 0, true);
      local.setUint16(12, 0x21, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, 0, true);
      c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true);
      c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((s, x) => s + x.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---- Excel の中身 ----
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Excel が読めない制御文字は入れない
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  function colName(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // 見た目（11/12〜 勤怠集計表）：セルを { v: 値, s: '見た目の名前' } にすると、罫線・太字・色・小数第1位の形をつける
  const STYLE_IDS = { title: 1, label: 2, cell: 3, head: 4, num1: 5, time: 6, total: 7, small: 8, sun: 9, sat: 10, totalNum: 11 };
  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>' +
    '<fonts count="7">' +
    ['<sz val="11"/>', '<b/><sz val="11"/>', '<b/><sz val="14"/>', '<sz val="9"/><color rgb="FF666666"/>', '<sz val="11"/><color rgb="FFCC0000"/>', '<sz val="11"/><color rgb="FF0055CC"/>', '<b/><sz val="12"/>'].map((f) => `<font>${f}<name val="Yu Gothic"/><family val="3"/><charset val="128"/></font>`).join('') +
    '</fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEEEEE"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FF333333"/></left><right style="thin"><color rgb="FF333333"/></right><top style="thin"><color rgb="FF333333"/></top><bottom style="thin"><color rgb="FF333333"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="12">' +
    [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>',
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>',
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>',
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>',
      '<xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
      '<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>',
      '<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>',
      '<xf numFmtId="164" fontId="6" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
    ].join('') +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  // sheet：{ rows, cols（列の幅・なければ中身から決める）, merges（['A1:G1']）, page（{ portrait, fit }：A4・1ページに収める） }
  function sheetXml(rows, { cols: widths, merges, page } = {}) {
    const width = Math.max(1, ...rows.map((r) => r.length));
    const valueOf = (x) => (x && typeof x === 'object' ? x.v : x);
    const cols = Array.from({ length: width }, (_, i) => {
      const w = widths && widths[i] ? widths[i] : Math.min(40, Math.max(8, ...rows.map((r) => String(valueOf(r[i]) == null ? '' : valueOf(r[i])).length * 2 + 2)));
      return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    }).join('');
    const body = rows
      .map((r, ri) => {
        const cells = r
          .map((x, ci) => {
            const v = valueOf(x);
            const sid = x && typeof x === 'object' && STYLE_IDS[x.s] ? ` s="${STYLE_IDS[x.s]}"` : '';
            const ref = `${colName(ci)}${ri + 1}`;
            if (v == null || v === '') return sid ? `<c r="${ref}"${sid}/>` : '';
            // 数字だけの値は数として入れる（Excel で足し算できるように）
            // { str: true } は文字のまま（従業員番号「0012」の 0 を消さない）
            if (!(x && typeof x === 'object' && x.str) && (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)))) return `<c r="${ref}"${sid}><v>${Number(v)}</v></c>`;
            return `<c r="${ref}"${sid} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    const pr = page && page.fit ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '';
    const mc = merges && merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const ps = page
      ? `<pageMargins left="0.47" right="0.47" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="${page.portrait ? 'portrait' : 'landscape'}"${page.fit ? ' fitToWidth="1" fitToHeight="1"' : ''}/>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pr}<cols>${cols}</cols><sheetData>${body}</sheetData>${mc}${ps}</worksheet>`;
  }

  function build(sheets) {
    const list = sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
    const files = [
      {
        name: '[Content_Types].xml',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      },
      {
        name: 'xl/workbook.xml',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          list.map((s, i) => `<sheet name="${esc(String(s.name).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
          '</sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
          `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          '</Relationships>',
      },
      { name: 'xl/styles.xml', data: STYLES_XML },
      ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows || [], s) })),
    ];
    return zip(files);
  }

  K.xlsx = { build, crc32, colName };
})();
