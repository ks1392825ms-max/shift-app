// 天気（11/9〜 勤怠用 iPad のいちばん上に、午前・午後の天気を出す）
// 気象庁の天気予報（公開データ・登録や鍵はいらない）を読む。送るのは地域の番号だけ（スタッフの情報などは送らない）。
//   https://www.jma.go.jp/bosai/forecast/data/forecast/015000.json （室蘭地方気象台：胆振・日高）
// お店は苫小牧（胆振地方 015010）。気温は、胆振地方で予報が出ている「室蘭」の最低・最高。
// 午前・午後の天気は、その日の天気の文（例：「くもり　昼過ぎ　から　時々　晴れ」）から分ける。雨の確率は6時間ごと（6〜12時・12〜18時）。
// 読めないとき（電波がない など）は null（画面には天気を出さない。打刻には関係しない）。
(function () {
  'use strict';
  const K = window.ShiftApp;

  const PLACE = { url: 'https://www.jma.go.jp/bosai/forecast/data/forecast/015000.json', area: '015010', areaName: '苫小牧', tempPoint: '21323', tempName: '室蘭' };
  const CACHE_MS = 60 * 60 * 1000; // 1時間ごとに読み直す

  let cache = null; // { at, date, data }

  // 天気の言葉 → 絵と短い言葉
  function iconOf(text) {
    const t = String(text || '');
    const has = (w) => t.includes(w);
    if (has('雪')) return has('雨') ? ['🌨️', '雨か雪'] : ['❄️', '雪'];
    if (has('雷')) return ['⛈️', '雷雨'];
    if (has('雨')) return has('晴') ? ['🌦️', '晴れ時々雨'] : ['☔', '雨'];
    if (has('晴') && (has('くもり') || has('曇'))) return t.indexOf('晴') < Math.min(...['くもり', '曇'].map((w) => (t.indexOf(w) < 0 ? 99 : t.indexOf(w)))) ? ['🌤️', '晴れ時々くもり'] : ['⛅', 'くもり時々晴れ'];
    if (has('晴')) return ['☀️', '晴れ'];
    if (has('くもり') || has('曇')) return ['☁️', 'くもり'];
    if (has('霧')) return ['🌫️', '霧'];
    return ['', t.split(/\s+/)[0] || ''];
  }

  // その日の天気の文を、午前と午後に分ける
  // 「A　昼過ぎ　から　B」「A　夕方　から　B」「A　後　B」→ 午前 A・午後 B。「所により…」から後は、細かい但し書きなので使わない
  function splitDay(text) {
    const words = String(text || '').replace(/　/g, ' ').split(/\s+/).filter(Boolean);
    const cut = words.indexOf('所により');
    const main = cut >= 0 ? words.slice(0, cut) : words;
    const first = main.filter((w) => !['時々', '一時', 'から', '後', 'まで', 'で', '夜', '朝', '昼前', '昼過ぎ', '夕方', '夜のはじめ頃', '夜遅く', '明け方', '朝晩', '日中', '昼頃'].includes(w));
    // 「晴れ　時々　くもり」のように、分ける言葉がないときは、午前も午後も同じ（時々・一時をつけたまま）
    const occ = main.findIndex((w) => w === '時々' || w === '一時');
    const plain = !main.some((w) => w === '後' || w === 'から');
    const am = plain && occ === 1 && first[1] ? `${first[0]}時々${first[1]}` : first[0] || '';
    let pm = am;
    const afterIdx = (() => {
      for (let i = 0; i < main.length; i++) {
        if (main[i] === '後') return i + 1;
        if ((main[i] === '昼過ぎ' || main[i] === '昼頃' || main[i] === '日中') && main[i + 1] === 'から') return i + 2;
      }
      return -1;
    })();
    if (afterIdx > 0) {
      const rest = main.slice(afterIdx).filter((w) => !['から', '後', 'まで', 'で'].includes(w));
      const occasional = rest[0] === '時々' || rest[0] === '一時';
      const w = rest.find((x) => !['時々', '一時'].includes(x)) || am;
      pm = occasional ? `${am}時々${w}` : w;
    }
    return { am, pm };
  }

  // 気象庁の予報（JSON）から、今日の午前・午後の天気・雨の確率と、最低・最高の気温
  function parse(json, date) {
    const r = Array.isArray(json) ? json[0] : null;
    if (!r || !r.timeSeries) return null;
    const pick = (ts, code) => (ts.areas || []).find((a) => a.area && a.area.code === code);
    const dayOf = (iso) => String(iso).slice(0, 10);
    const [w, p, t] = r.timeSeries;
    const wa = w && pick(w, PLACE.area);
    const wi = wa ? w.timeDefines.findIndex((x) => dayOf(x) === date) : -1;
    if (!wa || wi < 0) return null;
    const { am, pm } = splitDay(wa.weathers[wi]);
    const pa = p && pick(p, PLACE.area);
    const pop = (hour) => {
      if (!pa) return null;
      const i = p.timeDefines.findIndex((x) => dayOf(x) === date && Number(String(x).slice(11, 13)) === hour);
      return i >= 0 && pa.pops[i] !== '' ? Number(pa.pops[i]) : null;
    };
    const ta = t && pick(t, PLACE.tempPoint);
    const temps = ta ? t.timeDefines.map((x, i) => [x, ta.temps[i]]).filter(([x]) => dayOf(x) === date).map(([, v]) => Number(v)) : [];
    const [amIcon, amShort] = iconOf(am);
    const [pmIcon, pmShort] = iconOf(pm);
    return {
      place: PLACE.areaName,
      tempPlace: PLACE.tempName,
      am: { icon: amIcon, text: amShort, pop: pop(6) },
      pm: { icon: pmIcon, text: pmShort, pop: pop(12) },
      min: temps.length >= 2 ? Math.min(...temps) : null,
      max: temps.length ? Math.max(...temps) : null,
      text: String(wa.weathers[wi] || '').replace(/　/g, ' '),
    };
  }

  async function today(date, { fetchImpl } = {}) {
    if (cache && cache.date === date && Date.now() - cache.at < CACHE_MS) return cache.data;
    try {
      const res = await (fetchImpl || fetch)(PLACE.url, { cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(String(res.status));
      const data = parse(await res.json(), date);
      cache = { at: Date.now(), date, data };
      return data;
    } catch (err) {
      console.warn('天気を読めませんでした', err && err.message);
      cache = { at: Date.now() - CACHE_MS + 10 * 60 * 1000, date, data: cache && cache.date === date ? cache.data : null }; // 10分後にもう一度
      return cache.data;
    }
  }

  K.weather = { today, parse, splitDay, iconOf, PLACE, reset: () => (cache = null) };
})();
