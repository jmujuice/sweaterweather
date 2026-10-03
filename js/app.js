(() => {
'use strict';

/* ---------- Storage (per-browser preferences) ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('wx.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wx.' + k, JSON.stringify(v)); } catch {} }
};
const state = {
  unit: LS.get('unit', 'F'), wear: LS.get('wear', true),
  comfort: LS.get('comfort', 'average'), activity: LS.get('activity', 'walking'),
  voice: LS.get('voice', LS.get('aud', 'w') === 't' ? 'teen' : 'standard'),
  win: LS.get('win', '6'), winTouched: false, adjOpen: false,
  mode: LS.get('mode', 'geo'), zip: LS.get('zip', ''), loc: null, m: null, loadedAt: 0, busy: false
};

const SW = window.SW;   // from solar.js, interpret.js, recommend.js
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NWS = { Accept: 'application/geo+json' };

/* ---------- Networking ---------- */
async function getJSON(url, { headers = {}, timeout = 12000, tries = 1 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { headers, signal: ac.signal, cache: 'no-store' });
      clearTimeout(t);
      if (r.ok) return await r.json();
      last = new Error('HTTP ' + r.status); last.status = r.status;
      if (r.status < 500) throw last;
    } catch (e) {
      clearTimeout(t); last = e;
      if (e.status && e.status < 500) throw e;
    }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 900 * (i + 1)));
  }
  throw last;
}

/* ---------- Time helpers (in the forecast location's time zone) ---------- */
const fmtCache = {};
function fmt(tz, opts) { const k = tz + JSON.stringify(opts); return fmtCache[k] || (fmtCache[k] = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts })); }
function tzParts(ms, tz) {
  const o = {};
  fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(ms)).forEach(p => o[p.type] = p.value);
  return { date: `${o.year}-${o.month}-${o.day}`, hour: (+o.hour) % 24, wd: o.weekday };
}
const hourLabel = (ms, tz) => fmt(tz, { hour: 'numeric' }).format(new Date(ms));
const clockLabel = (ms, tz) => fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

/* ---------- NWS grid data ---------- */
function parseValid(vt) {
  const [s, d] = vt.split('/');
  const m = (d || 'PT1H').match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/) || [];
  const hrs = (+(m[1] || 0)) * 24 + (+(m[2] || 0)) + (+(m[3] || 0)) / 60;
  return { start: Date.parse(s), hrs: Math.max(1, Math.round(hrs)) };
}
const toF = u => /degC/.test(u) ? v => v * 9 / 5 + 32 : v => v;
const toMph = u => /km_h/.test(u) ? v => v / 1.609344 : /m_s/.test(u) ? v => v * 2.236936 : /kt/.test(u) ? v => v * 1.15078 : v => v;
const toIn = u => /mm/.test(u) ? v => v / 25.4 : v => v;
const same = () => v => v;
function expand(series, conv, spread) {
  const map = new Map();
  if (!series || !series.values) return map;
  const c = conv(series.uom || '');
  for (const v of series.values) {
    if (v.value == null) continue;
    const { start, hrs } = parseValid(v.validTime);
    const h0 = Math.floor(start / 3.6e6);
    const val = c(v.value);
    for (let i = 0; i < hrs; i++) map.set(h0 + i, spread ? val / hrs : val);
  }
  return map;
}

/* Rain amounts as NWS issued them (often one total per 6-hour block), for each hour they cover.
   The engine judges intensity from the block, so a downpour isn't watered down by spreading. */
function expandBlocks(series, conv) {
  const map = new Map();
  if (!series || !series.values) return map;
  const c = conv(series.uom || '');
  for (const v of series.values) {
    if (v.value == null) continue;
    const { start, hrs } = parseValid(v.validTime);
    const h0 = Math.floor(start / 3.6e6);
    for (let i = 0; i < hrs; i++) map.set(h0 + i, { total: c(v.value), hrs });
  }
  return map;
}

/* ---------- Latest reading from the nearest weather station (item 3) ---------- */
const cToF = c => c * 9 / 5 + 32;
function windChillF(t, mph) {
  if (t > 50 || mph < 3) return t;
  return 35.74 + 0.6215 * t - 35.75 * Math.pow(mph, 0.16) + 0.4275 * t * Math.pow(mph, 0.16);
}
function heatIndexF(t, rh) {
  if (t < 80 || rh == null) return t;
  return -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh - 0.00683783 * t * t
    - 0.05481717 * rh * rh + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
}
const stationName = n => (n || '').split(',')[0].replace(/\s*International Airport/i, ' Airport').trim();
async function getObservation(stationsUrl) {
  if (!stationsUrl) return null;
  try {
    const st = await getJSON(stationsUrl, { headers: NWS, timeout: 8000 });
    for (const f of (st.features || []).slice(0, 3)) {
      try {
        const id = f.properties.stationIdentifier;
        const o = await getJSON(`https://api.weather.gov/stations/${id}/observations/latest`, { headers: NWS, timeout: 8000 });
        const p = o.properties || {};
        const ts = Date.parse(p.timestamp);
        // Skip empty or stale readings (the API sometimes lags) and try the next station.
        if (p.temperature?.value == null || isNaN(ts) || Date.now() - ts > 2 * 3.6e6) continue;
        const t = /degF/.test(p.temperature.unitCode || '') ? p.temperature.value : cToF(p.temperature.value);
        const mph = p.windSpeed?.value != null ? toMph(p.windSpeed.unitCode || 'km_h')(p.windSpeed.value) : 0;
        const feels = p.windChill?.value != null ? cToF(p.windChill.value)
          : p.heatIndex?.value != null ? cToF(p.heatIndex.value)
          : t <= 50 ? windChillF(t, mph) : heatIndexF(t, p.relativeHumidity?.value);
        return { temp: t, feels, text: p.textDescription || '', ms: ts, station: id, name: stationName(f.properties.name) };
      } catch {}
    }
  } catch {}
  return null;
}

/* ---------- UV index (EPA, by zip) ---------- */
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
async function getUV(zip) {
  const map = new Map();
  if (!/^\d{5}$/.test(zip || '')) return map;
  const urls = [
    `https://data.epa.gov/efservice/getEnvirofactsUVHOURLY/ZIP/${zip}/JSON`,
    `https://data.epa.gov/dmapservice/getEnvirofactsUVHOURLY/ZIP/${zip}/JSON`
  ];
  for (const url of urls) {
    try {
      const rows = await getJSON(url, { timeout: 7000 });
      if (!Array.isArray(rows) || !rows.length) continue;
      for (const r of rows) {
        const o = {}; for (const k in r) o[k.toUpperCase()] = r[k];
        const m = String(o.DATE_TIME || '').match(/([A-Z]{3})\/(\d{1,2})\/(\d{4}) (\d{1,2}) ?(AM|PM)/i);
        if (!m) continue;
        const mon = MONTHS.indexOf(m[1].toUpperCase()) + 1;
        let h = (+m[4]) % 12; if (m[5].toUpperCase() === 'PM') h += 12;
        map.set(`${m[3]}-${String(mon).padStart(2, '0')}-${m[2].padStart(2, '0')} ${h}`, +o.UV_VALUE);
      }
      if (map.size) return map;
    } catch {}
  }
  return map;
}

/* ---------- Place names ---------- */
async function reverseName(lat, lon) {
  try {
    const r = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lon}`, { timeout: 7000 });
    const a = r.address || {};
    const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
    const st = (a['ISO3166-2-lvl4'] || '').replace('US-', '');
    const zip = (a.postcode || '').slice(0, 5);
    if (!city) return null;
    return { name: st ? `${city}, ${st}` : city, zip: /^\d{5}$/.test(zip) ? zip : '' };
  } catch { return null; }
}

/* ---------- Conditions ---------- */
function kindFor(text, isDay) {
  const s = (text || '').toLowerCase();
  if (/thunder|t-storm/.test(s)) return 'storm';
  if (/snow|sleet|flurr|ice|freezing/.test(s)) return 'snow';
  if (/rain|shower|drizzle/.test(s)) return 'rain';
  if (/fog|haze|smoke|mist/.test(s)) return 'fog';
  if (/mostly sunny|mostly clear|sunny|clear|fair/.test(s)) return isDay ? 'sun' : 'moon';
  if (/partly/.test(s)) return isDay ? 'partly' : 'partlyNight';
  if (/cloud|overcast/.test(s)) return 'cloud';
  return isDay ? 'partly' : 'partlyNight';
}
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  partly: '<path d="M8 3v1.5M3.2 5.7l1 1M2 10.5h1.5M12.8 5.7l-1 1"/><path d="M5 10.5a3 3 0 0 1 5.7-1.3"/><path d="M9 20h9a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 9 14a3 3 0 0 0 0 6z"/>',
  partlyNight: '<path d="M5.5 4a3.5 3.5 0 0 0 4.9 4.6A3.5 3.5 0 1 1 5.5 4z"/><path d="M9 20h9a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 9 14a3 3 0 0 0 0 6z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 11 3.5 3.5 0 0 0 7 18z"/>',
  rain: '<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 8 3.5 3.5 0 0 0 7 15z"/><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3"/>',
  storm: '<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 8 3.5 3.5 0 0 0 7 15z"/><path d="M12.5 15l-2 3.5h3l-2 3.5"/>',
  snow: '<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 8 3.5 3.5 0 0 0 7 15z"/><path d="M8 19h.01M12 18.5h.01M16 19h.01M10 21.5h.01M14 21.5h.01"/>',
  fog: '<path d="M4 8h16M3 12h18M5 16h14M8 20h8"/>'
};
function icon(kind, size) {
  const color = /rain|storm|snow/.test(kind) ? 'var(--rain)' : kind === 'sun' ? 'var(--sun)' : 'var(--slate)';
  const sw = /snow/.test(kind) ? 1.8 : 1.6;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind] || ICONS.cloud}</svg>`;
}
const DIRS = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5, S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };
const arrow = dir => `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--slate)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(${DIRS[dir] ?? 0}deg)"><path d="M12 4v16M6 14l6 6 6-6"/></svg>`;
function uvCat(u) { return u <= 2 ? 'low' : u <= 5 ? 'moderate' : u <= 7 ? 'high' : u <= 10 ? 'very high' : 'extreme'; }

/* ---------- Units ---------- */
const T = f => f == null ? '—' : Math.round(state.unit === 'F' ? f : (f - 32) * 5 / 9) + '°';
const W = mph => Math.round(state.unit === 'F' ? mph : mph * 1.609344);
const WU = () => state.unit === 'F' ? 'mph' : 'km/h';
const R = inch => state.unit === 'F' ? (inch < 0.005 ? '0' : inch.toFixed(2)) : (inch * 25.4 < 0.05 ? '0' : (inch * 25.4).toFixed(1));
const RU = () => state.unit === 'F' ? 'in' : 'mm';

/* Newest "last updated" time across the three NWS feeds */
function issuedAt(...docs) {
  const t = docs.map(d => Date.parse(d?.properties?.updateTime || '')).filter(n => !isNaN(n) && n <= Date.now() + 5 * 60 * 1000);
  return t.length ? Math.max(...t) : null;
}

/* ---------- Build the model from NWS data ---------- */
function build(P, fc, hr, grid, uv, place, lat, lon, obs) {
  const tz = P.timeZone;
  const g = grid.properties;
  const A = expand(g.apparentTemperature, toF), SKY = expand(g.skyCover, same), GU = expand(g.windGust, toMph),
        WS = expand(g.windSpeed, toMph), Q = expand(g.quantitativePrecipitation, toIn, true), POP = expand(g.probabilityOfPrecipitation, same),
        DEW = expand(g.dewpoint, toF), QB = expandBlocks(g.quantitativePrecipitation, toIn);

  const now = Date.now();
  // 48 hours: 24 for the hourly table, the rest so "Tomorrow" outfits work in the evening.
  const periods = hr.properties.periods.filter(p => Date.parse(p.endTime) > now).slice(0, 48);
  const hoursAll = periods.map(p => {
    const ms = Date.parse(p.startTime), hk = Math.floor(ms / 3.6e6), tp = tzParts(ms, tz);
    const temp = p.temperatureUnit === 'C' ? p.temperature * 9 / 5 + 32 : p.temperature;
    const nums = (p.windSpeed || '').match(/\d+(\.\d+)?/g) || [];
    const ws = WS.has(hk) ? WS.get(hk) : (nums.length ? Math.max(...nums.map(Number)) : 0);
    const sky = SKY.get(hk);
    const uvv = uv.get(`${tp.date} ${tp.hour}`);
    const pop = p.probabilityOfPrecipitation?.value ?? POP.get(hk) ?? 0;
    const qpf = Q.get(hk) || 0;
    return {
      ms, date: tp.date, hour: tp.hour, wd: tp.wd, label: hourLabel(ms, tz),
      temp, feels: A.has(hk) ? A.get(hk) : temp,
      ws, gust: Math.max(GU.get(hk) || 0, ws), dir: p.windDirection || '',
      pop, qpf, qpfBlock: QB.get(hk) || { total: qpf, hrs: 1 },
      isDay: p.isDaytime, sky: sky ?? null, sun: p.isDaytime && sky != null ? Math.round(100 - sky) : null,
      // EPA forecast when we have it (today only), otherwise estimated from sun angle and clouds.
      uv: p.isDaytime ? (uvv != null ? uvv : SW.estimateUV(lat, lon, ms, sky, pop)) : null,
      dew: DEW.has(hk) ? DEW.get(hk) : null,
      cond: p.shortForecast, kind: kindFor(p.shortForecast, p.isDaytime)
    };
  });
  const hours = hoursAll.slice(0, 24);

  /* Daily aggregates from the grid */
  const agg = new Map();
  const allH = new Set([...A.keys(), ...SKY.keys(), ...Q.keys(), ...GU.keys()]);
  for (const hk of allH) {
    const tp = tzParts(hk * 3.6e6, tz);
    let a = agg.get(tp.date);
    if (!a) { a = { fmax: null, fmin: null, gust: 0, sky: 0, skyN: 0, q: 0, qN: 0, uv: null }; agg.set(tp.date, a); }
    if (A.has(hk)) { const f = A.get(hk); a.fmax = a.fmax == null ? f : Math.max(a.fmax, f); a.fmin = a.fmin == null ? f : Math.min(a.fmin, f); }
    if (GU.has(hk)) a.gust = Math.max(a.gust, GU.get(hk));
    if (SKY.has(hk) && tp.hour >= 8 && tp.hour <= 17) {
      a.sky += SKY.get(hk); a.skyN++;
      a.uv = Math.max(a.uv ?? 0, SW.estimateUV(lat, lon, hk * 3.6e6, SKY.get(hk), POP.get(hk)));
    }
    if (Q.has(hk)) { a.q += Q.get(hk); a.qN++; }
  }
  const todayKey = tzParts(now, tz).date;
  let uvToday = null;
  for (const [k, v] of uv) if (k.startsWith(todayKey + ' ')) uvToday = Math.max(uvToday ?? 0, v);

  const byDate = new Map();
  for (const p of fc.properties.periods) {
    const d = p.startTime.slice(0, 10), h = +p.startTime.slice(11, 13);
    if (!p.isDaytime && h < 12) continue; // skip leftover overnight period
    if (!byDate.has(d)) byDate.set(d, { date: d });
    const o = byDate.get(d);
    if (p.isDaytime) o.day = o.day || p; else o.night = o.night || p;
  }
  const days = [...byDate.values()].slice(0, 7).map(o => {
    const a = agg.get(o.date) || {};
    const p = o.day || o.night;
    const [y, mo, dd] = o.date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, dd, 12));
    const short = o.date === todayKey ? 'Today' : `${fmt('UTC', { weekday: 'short' }).format(dt)} ${dd}`;
    const long = o.date === todayKey ? 'Today' : fmt('UTC', { weekday: 'long', month: 'short', day: 'numeric' }).format(dt);
    const f = t => t == null ? null : (p.temperatureUnit === 'C' ? t * 9 / 5 + 32 : t);
    const windNums = ((o.day || o.night).windSpeed || '').match(/\d+/g) || [];
    return {
      short, long, cond: p.shortForecast, kind: kindFor(p.shortForecast, !!o.day),
      hi: o.day ? f(o.day.temperature) : null, lo: o.night ? f(o.night.temperature) : null,
      fhi: a.fmax, flo: a.fmin,
      dir: p.windDirection || '', wind: windNums.map(Number), gust: a.gust || 0,
      pop: Math.max(o.day?.probabilityOfPrecipitation?.value || 0, o.night?.probabilityOfPrecipitation?.value || 0),
      q: a.qN ? a.q : null,
      sun: a.skyN ? Math.round(100 - a.sky / a.skyN) : null,
      uv: o.date === todayKey && uvToday != null ? uvToday : a.uv
    };
  });

  return {
    tz, hours, hoursAll, days, place, lat, lon, obs, office: P.cwa,
    updated: clockLabel(issuedAt(fc, hr, grid) || now, tz),
    checked: clockLabel(now, tz)
  };
}

/* ---------- Next 6 hours summary ---------- */
function next6(m) {
  const n = m.hours.slice(0, 6);
  const feels = n.map(h => h.feels), ws = n.map(h => h.ws);
  const sunVals = n.filter(h => h.sun != null).map(h => h.sun);
  const uvVals = n.filter(h => h.uv != null).map(h => h.uv);
  const dirCount = {}; n.forEach(h => dirCount[h.dir] = (dirCount[h.dir] || 0) + 1);
  const startIdx = n.findIndex(h => h.pop >= 30);
  return {
    n, fmin: Math.min(...feels), fmax: Math.max(...feels),
    wsMin: Math.min(...ws), wsMax: Math.max(...ws), gust: Math.max(...n.map(h => h.gust)),
    dir: Object.entries(dirCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    sun: sunVals.length ? Math.round(sunVals.reduce((s, v) => s + v, 0) / sunVals.length) : null,
    uv: uvVals.length ? Math.max(...uvVals) : null,
    pop: Math.max(...n.map(h => h.pop)),
    start: startIdx, startLabel: startIdx >= 0 ? n[startIdx].label : '',
    q: n.reduce((s, h) => s + h.qpf, 0)
  };
}

/* ---------- Rendering ---------- */
function render() {
  const m = state.m; if (!m) return;
  $('#main').hidden = false;
  $('#placeName').textContent = m.place.name + (m.place.zip ? ' ' + m.place.zip : '');
  $('#updated').textContent = `${state.mode === 'geo' ? 'Current location' : 'Zip code'} · Forecast issued ${m.updated} · Checked ${m.checked}`;
  $('#unitBtn').textContent = state.unit === 'F' ? '°F' : '°C';
  $('#unitBtn').setAttribute('aria-label', state.unit === 'F' ? 'Showing Fahrenheit. Switch to Celsius' : 'Showing Celsius. Switch to Fahrenheit');
  $('#dhWind').textContent = 'Wind, ' + WU();
  const s = next6(m);
  renderNow(m); renderTiles(m, s); renderHourly(m); renderWear(); renderDays(m); renderFoot(m);
}

function renderNow(m) {
  const h = m.hours[0], o = m.obs;
  const temp = o ? o.temp : h.temp, feels = o ? o.feels : h.feels;
  const cond = o && o.text ? o.text : h.cond;
  const kind = o && o.text ? kindFor(o.text, h.isDay) : h.kind;
  const src = o ? `Measured at ${esc(o.name || o.station)}, ${clockLabel(o.ms, m.tz)}` : 'Forecast for this hour';
  $('#now').innerHTML = `
    <div>
      <div class="muted nowlab">Now</div>
      <div class="bigt">${T(temp)}</div>
      <div class="feels">Feels like <b>${T(feels)}</b></div>
      <div class="nowsrc">${src}</div>
    </div>
    <div class="nowcond">${icon(kind, 48)}<span>${esc(cond)}</span></div>`;
}

function renderTiles(m, s) {
  $('#n6range').textContent = `${s.n[0].label} – ${s.n[s.n.length - 1].label}`;
  const wsTxt = W(s.wsMin) === W(s.wsMax) ? `${W(s.wsMax)}` : `${W(s.wsMin)}–${W(s.wsMax)}`;
  const gustTxt = s.gust - s.wsMax >= 3 ? `Gusts to ${W(s.gust)} ${WU()}` : 'No strong gusts';
  const sunBig = s.sun == null ? `<div class="tv s">Night</div>` : `<div class="tv s">${s.sun}% <small>sun</small></div>`;
  const sunSub = s.sun == null ? 'The sun is down' : s.uv != null ? `UV peaks at ${s.uv} (${uvCat(s.uv)})` : 'UV index unavailable';
  const rainSub = s.start === 0 ? 'Likely right now' : s.start > 0 ? `Starting around ${s.startLabel}` : s.pop > 0 ? 'Low chance' : 'Dry';
  const q = s.q;
  const ra = SW.analyze(m.hoursAll.slice(0, 6)).rain;
  const qDesc = q < 0.005 ? 'None expected'
    : ra.wetHours ? 'Total, ' + { light: 'light rain', steady: 'steady rain', heavy: 'heavy rain at times' }[ra.intensity]
    : 'Total, light showers';
  $('#tiles').innerHTML = `
    <div class="tile"><div class="tl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--slate)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>Wind</div>
      <div class="tv">${wsTxt} <small>${WU()} ${esc(s.dir)}</small></div><div class="ts">${gustTxt}</div></div>
    <div class="tile"><div class="tl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sun)" stroke-width="2" stroke-linecap="round" aria-hidden="true">${ICONS.sun}</svg>Sun exposure</div>
      ${sunBig}<div class="ts">${sunSub}</div></div>
    <div class="tile"><div class="tl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--rain)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>Rain chance</div>
      <div class="tv r">${s.pop}%</div><div class="ts">${rainSub}</div></div>
    <div class="tile"><div class="tl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--rain)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 20h14"/><path d="M7 20v-4M12 20v-8M17 20v-6"/></svg>Rain amount</div>
      <div class="tv r">${R(q)} <small>${RU()}</small></div><div class="ts">${qDesc}</div></div>`;
}

function renderHourly(m) {
  const H = m.hours;
  const cls = h => 'hc' + (h.hour === 0 && h !== H[0] ? ' mid' : '');
  const row = (label, cell, extra = '') =>
    `<div class="hrow ${extra}"><div class="hlab">${label}</div>${H.map(h => `<div class="${cls(h)}">${cell(h)}</div>`).join('')}</div>`;
  $('#hourly').innerHTML = `<div class="hgrid">` +
    row('', h => `<span class="dmk">${h === H[0] || h.hour === 0 ? h.wd : ''}</span><span class="ht">${h.label}</span>${icon(h.kind, 22)}`, 'head') +
    row('Temp', h => `<span class="hv">${T(h.temp)}</span>`) +
    row('Feels like', h => `<span class="fv">${T(h.feels)}</span>`) +
    row(`Wind<br>${WU()}`, h => `<span class="wv">${arrow(h.dir)}${W(h.ws)}</span><span class="sm">gust ${W(h.gust)}</span>`) +
    row('Sun<br>UV', h => `<span class="sv">${h.sun == null ? '—' : h.sun + '%'}</span><span class="sbar"><i style="width:${h.sun || 0}%"></i></span><span class="sm">${!h.isDay ? 'Night' : h.uv == null ? 'UV —' : 'UV ' + h.uv}</span>`) +
    row('Rain<br>chance', h => `<span class="vbar"><i style="height:${h.pop}%"></i></span><span class="rv">${h.pop}%</span>`, 'end') +
    row(`Amount<br>${RU()}`, h => `<span class="av">${R(h.qpf)}</span>`) +
    `</div>`;
}

/* ---------- What should I wear? (engine in recommend.js) ---------- */
function wearOpts() {
  const h0 = state.m.hoursAll[0];
  // Late at night, default to tomorrow's outfit unless the person picked a window this visit.
  const win = !state.winTouched && SW.isNightHour(h0.hour) ? 'day' : state.win;
  return { window: win, comfort: state.comfort, activity: state.activity, voice: state.voice, unit: state.unit };
}
function segRow(group, label, options, current) {
  return `<div class="wrow"><span id="lbl-${group}">${label}</span>
    <div class="seg" role="group" aria-labelledby="lbl-${group}">${options.map(([k, l]) =>
      `<button type="button" data-${group}="${k}" aria-pressed="${current === k}">${l}</button>`).join('')}</div></div>`;
}
const SLIDERS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
function renderWear() {
  const el = $('#wear');
  if (!state.wear) {
    el.classList.add('collapsed');
    el.innerHTML = `<div class="whead"><h2 class="eyebrow">What should I wear?</h2><button type="button" class="adj" data-act="show">Show</button></div>`;
    return;
  }
  el.classList.remove('collapsed');
  const o = wearOpts();
  const r = SW.recommend(state.m.hoursAll, o);
  if (!r) { el.innerHTML = ''; return; }
  const items = r.clothing.map((c, i) => (i ? c.charAt(0).toLowerCase() + c.slice(1) : c)).join(' + ');
  const win = [['2', 'Next 2 hrs'], ['6', 'Next 6 hrs'], ['day', SW.dayWindowName(state.m.hoursAll[0].hour)]]
    .map(([k, l]) => `<button type="button" data-win="${k}" aria-pressed="${o.window === k}">${l}</button>`).join('');
  const panel = state.adjOpen ? `
    <div class="wpanel" id="wpanel">
      ${segRow('comfort', 'I usually', [['cold', 'Run cold'], ['average', 'Average'], ['warm', 'Run warm']], state.comfort)}
      ${segRow('activity', 'While I’m out', [['still', 'Sitting still'], ['walking', 'Walking'], ['active', 'Active']], state.activity)}
      ${segRow('voice', 'Style', [['standard', 'Standard'], ['teen', 'Teen']], state.voice)}
      <button type="button" class="linkbtn" data-act="hide">Hide this card</button>
    </div>` : '';
  el.innerHTML = `
    <div class="whead">
      <h2 class="eyebrow">What should I wear?</h2>
      <button type="button" class="adj" data-act="adjust" aria-expanded="${state.adjOpen}" aria-controls="wpanel">${SLIDERS} Adjust</button>
    </div>
    <div class="wmain">
      <span class="wicon" aria-hidden="true">${r.icon}</span>
      <div><p class="wlabel">${esc(r.label)}</p><p class="wclothes">${esc(items)}</p></div>
    </div>
    <p class="wsum">${esc(r.summary)}</p>
    ${r.alerts.length ? `<ul class="walerts">${r.alerts.map(x => `<li><span aria-hidden="true">${x.icon}</span> ${esc(x.text)}</li>`).join('')}</ul>` : ''}
    <div class="seg wwin" role="group" aria-label="How long you’ll be out">${win}</div>
    ${panel}`;
}

function renderDays(m) {
  const vals = m.days.flatMap(d => [d.hi, d.lo]).filter(v => v != null);
  const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
  $('#days').innerHTML = m.days.map(d => {
    const lo = d.lo ?? d.hi, hi = d.hi ?? d.lo;
    const left = ((lo - min) / span) * 100, width = ((hi - lo) / span) * 100;
    const wind = d.wind.length ? `${esc(d.dir)} ${d.wind.map(W).join('–')}` : esc(d.dir);
    const gust = d.gust >= 15 && d.gust - Math.max(...d.wind, 0) >= 3 ? `, gust ${W(d.gust)}` : '';
    const feels = d.fhi == null ? '—' : `${T(d.fhi)} / ${T(d.flo)}`;
    const sun = d.sun == null ? '—' : `${d.sun}%${d.uv != null ? ' · UV ' + d.uv : ''}`;
    const rain = `${d.pop}%${d.q != null ? ' · ' + R(d.q) + (state.unit === 'F' ? '″' : ' mm') : ''}`;
    return `
    <div class="day">
      <div class="dname"><b><span class="short">${esc(d.short)}</span><span class="long">${esc(d.long)}</span></b><span class="c">${esc(d.cond)}</span></div>
      <div class="dicon">${icon(d.kind, 26)}</div>
      <div class="drange"><span class="lo">${T(d.lo)}</span><div class="rbar"><i style="left:${left}%;width:${width}%"></i></div><span class="hi">${T(d.hi)}</span></div>
      <div class="dmeta">
        <div class="dm"><span class="ml">Feels</span><span class="v">${feels}</span></div>
        <div class="dm"><span class="ml">Wind ${WU()}</span><span class="v">${wind}${gust}</span></div>
        <div class="dm s"><span class="ml">Sun · UV</span><span class="v">${sun}</span></div>
        <div class="dm r"><span class="ml">Rain</span><span class="pbar"><i style="width:${d.pop}%"></i></span><span class="v">${rain}</span></div>
      </div>
    </div>`;
  }).join('');
}

function renderFoot(m) {
  $('#foot').innerHTML = `Forecast from the <a href="https://forecast.weather.gov/MapClick.php?lat=${m.lat.toFixed(4)}&lon=${m.lon.toFixed(4)}" target="_blank" rel="noopener">National Weather Service</a> (${esc(m.office)} office). Current temperature from the nearest NWS weather station. UV index from the EPA for today when available, otherwise estimated from sun angle and NWS cloud cover. Place names from OpenStreetMap.`;
}

/* ---------- Status and location form ---------- */
function setStatus(msg, retry) {
  const el = $('#status');
  el.innerHTML = msg ? esc(msg) + (retry ? `<div><button type="button" class="primary" id="retryBtn">Try again</button></div>` : '') : '';
  if (retry) $('#retryBtn').onclick = refresh;
}
function showForm(show, msg) {
  $('#locForm').hidden = !show;
  $('#placeBtn').setAttribute('aria-expanded', String(show));
  $('#locMsg').textContent = msg || '';
  if (show) { $('#zip').value = state.zip || ''; setTimeout(() => $('#zip').focus(), 50); }
}
function busy(on) { state.busy = on; $('#refreshBtn').classList.toggle('spin', on); }

/* ---------- Loading flow ---------- */
function locate() {
  showForm(false);
  if (!state.m) setStatus('Finding your location');
  if (!('geolocation' in navigator)) return fallback('This browser can’t share your location. Enter a zip code to see your forecast.');
  busy(true);
  navigator.geolocation.getCurrentPosition(
    pos => { state.mode = 'geo'; LS.set('mode', 'geo'); load(pos.coords.latitude, pos.coords.longitude, null); },
    err => { busy(false); fallback(err.code === 1 ? 'Location access is off. Enter a zip code to see your forecast.' : 'Your location couldn’t be found. Enter a zip code to see your forecast.', err.code === 1); },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 }
  );
}
function fallback(msg, denied) {
  if (state.zip && !state.m) { loadZip(state.zip, denied ? null : msg); return; }
  setStatus('');
  showForm(true, msg);
}
async function loadZip(zip, note) {
  showForm(false);
  if (!state.m) setStatus('Looking up ' + zip);
  busy(true);
  let z;
  try { z = await getJSON('https://api.zippopotam.us/us/' + zip, { timeout: 8000, tries: 2 }); }
  catch (e) {
    busy(false); setStatus('');
    showForm(true, e.status === 404 ? 'That zip code wasn’t found. Check the five digits and try again.' : 'The zip code lookup didn’t respond. Try again in a moment.');
    return;
  }
  const pl = z.places[0];
  state.zip = zip; LS.set('zip', zip);
  state.mode = 'zip'; LS.set('mode', 'zip');
  load(+pl.latitude, +pl.longitude, { name: `${pl['place name']}, ${pl['state abbreviation']}`, zip });
}
async function load(lat, lon, known) {
  state.loc = { lat, lon, known };
  if (!state.m) setStatus('Loading forecast');
  busy(true);
  try {
    const pts = await getJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: NWS, tries: 2 });
    const P = pts.properties;
    const feeds = () => Promise.all([
      getJSON(P.forecast, { headers: NWS, tries: 3 }),
      getJSON(P.forecastHourly, { headers: NWS, tries: 3 }),
      getJSON(P.forecastGridData, { headers: NWS, tries: 3 })
    ]);
    const obsP = getObservation(P.observationStations);
    let [[fc, hr, grid], place] = await Promise.all([feeds(), known ? Promise.resolve(known) : reverseName(lat, lon)]);
    // The NWS API sometimes serves an older copy of a forecast. If any feed looks
    // more than 2 hours old, ask again once and keep whichever copy is newer.
    const age = d => Date.now() - (issuedAt(d) || 0);
    if ([fc, hr, grid].some(d => age(d) > 2 * 3.6e6)) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const again = await feeds();
        const newer = (a, b) => (issuedAt(b) || 0) > (issuedAt(a) || 0) ? b : a;
        fc = newer(fc, again[0]); hr = newer(hr, again[1]); grid = newer(grid, again[2]);
      } catch {}
    }
    const rl = P.relativeLocation?.properties || {};
    const nm = place || { name: [rl.city, rl.state].filter(Boolean).join(', ') || 'Your location', zip: '' };
    const uv = await getUV(nm.zip);
    const obs = await obsP;
    state.m = build(P, fc, hr, grid, uv, nm, lat, lon, obs);
    state.loadedAt = Date.now();
    setStatus(''); showForm(false); render();
  } catch (e) {
    if (e.status === 404) {
      setStatus('');
      showForm(true, 'The National Weather Service only covers US locations. Enter a US zip code.');
    } else if (!state.m) {
      setStatus('The weather service didn’t respond. Check your connection and try again.', true);
    } else {
      $('#updated').textContent = 'Couldn’t refresh. Showing the last forecast.';
    }
  } finally { busy(false); }
}
function refresh() {
  if (state.busy) return;
  if (state.mode === 'geo' || !state.loc) locate();
  else load(state.loc.lat, state.loc.lon, state.loc.known);
}
function start() {
  if (state.mode === 'zip' && state.zip) loadZip(state.zip);
  else locate();
}

/* ---------- Events ---------- */
$('#placeBtn').addEventListener('click', () => showForm($('#locForm').hidden, ''));
$('#geoBtn').addEventListener('click', () => { state.mode = 'geo'; LS.set('mode', 'geo'); state.m = null; $('#main').hidden = true; locate(); });
$('#locForm').addEventListener('submit', e => {
  e.preventDefault();
  const z = $('#zip').value.trim();
  if (!/^\d{5}$/.test(z)) { $('#locMsg').textContent = 'Enter a five-digit US zip code.'; return; }
  loadZip(z);
});
$('#refreshBtn').addEventListener('click', refresh);
$('#unitBtn').addEventListener('click', () => { state.unit = state.unit === 'F' ? 'C' : 'F'; LS.set('unit', state.unit); render(); });
$('#wear').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t || !state.m) return;
  const d = t.dataset;
  let focus;
  if (d.act === 'adjust') { state.adjOpen = !state.adjOpen; focus = '[data-act="adjust"]'; }
  else if (d.act === 'hide') { state.wear = false; state.adjOpen = false; LS.set('wear', false); focus = '[data-act="show"]'; }
  else if (d.act === 'show') { state.wear = true; LS.set('wear', true); focus = '[data-act="adjust"]'; }
  else if (d.win) { state.win = d.win; state.winTouched = true; LS.set('win', d.win); focus = `[data-win="${d.win}"]`; }
  else if (d.comfort) { state.comfort = d.comfort; LS.set('comfort', d.comfort); focus = `[data-comfort="${d.comfort}"]`; }
  else if (d.activity) { state.activity = d.activity; LS.set('activity', d.activity); focus = `[data-activity="${d.activity}"]`; }
  else if (d.voice) { state.voice = d.voice; LS.set('voice', d.voice); focus = `[data-voice="${d.voice}"]`; }
  else return;
  renderWear();
  const f = $('#wear ' + focus); f && f.focus();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.m && Date.now() - state.loadedAt > 30 * 60 * 1000) refresh();
});

start();
})();
