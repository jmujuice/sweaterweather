/*
 * Sweater Weather: weather interpretation.
 *
 * Turns raw hourly forecast data into facts the outfit logic can use:
 * the "clothing temperature" for each hour, whether rain is meaningful,
 * how heavy it is, and which hours to look at.
 * No outfit decisions and no wording here (see recommend.js), and no DOM.
 *
 * Expected hour shape (all temperatures °F, wind mph, rain inches):
 *   { label: '4 PM', hour: 16, date: '2026-10-03', isDay: true,
 *     temp, feels, ws, gust, pop, qpf, qpfBlock: { total, hrs },
 *     dew, uv, cond: 'Chance Light Rain', kind: 'rain' }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SW = Object.assign(root.SW || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Every threshold lives here so it can be tuned without touching the logic. */
  const INTERPRET = {
    // NWS "feels like" already includes wind chill at 50°F and below, and heat index
    // at 80°F and up. Between those, wind isn't counted, so we add a small adjustment.
    wind: {
      appliesAboveF: 50, appliesBelowF: 80,
      tiers: [ { mph: 25, adjF: 6 }, { mph: 15, adjF: 4 }, { mph: 10, adjF: 2 } ],
      windyMph: 25, windyGustMph: 35
    },
    // Personal settings shift the clothing temperature (°F).
    comfort: { cold: -5, average: 0, warm: 5 },
    activity: { still: -6, walking: 0, active: 12 },
    rain: {
      wetPop: 60,                 // an hour is "wet" at 60%+ chance…
      wetPopWithAmount: 40,       // …or 40%+ with at least…
      minHourlyAmountIn: 0.01,    // …this much rain per hour expected
      meaningfulTotalIn: 0.02,    // window total needed to recommend rain gear…
      meaningfulPop: 70,          // …unless the chance is this high
      possiblePop: 30             // below "meaningful" but worth a mention
    },
    // Rain intensity from NWS amount blocks (item 6). NWS often gives one total for a
    // 6-hour block; spreading it evenly hides downpours. Rain rarely falls evenly, so we
    // use total / √hours as the effective rate, and boost showers and storms, which come
    // in bursts. Rate thresholds follow the usual in/hr definitions.
    intensity: { steadyInPerHr: 0.10, heavyInPerHr: 0.30, convectiveBoost: 1.5 }
  };

  function windAdjustment(h, cfg = INTERPRET) {
    if (!(h.temp > cfg.wind.appliesAboveF && h.temp < cfg.wind.appliesBelowF)) return 0;
    for (const t of cfg.wind.tiers) if ((h.ws || 0) >= t.mph) return t.adjF;
    return 0;
  }

  /* The temperature we dress for: feels-like, adjusted for wind and personal settings. */
  function clothingTemp(h, prefs = {}, cfg = INTERPRET) {
    return h.feels - windAdjustment(h, cfg)
      + (cfg.comfort[prefs.comfort] ?? 0)
      + (cfg.activity[prefs.activity] ?? 0);
  }

  function precipType(h) {
    const s = (h.cond || '').toLowerCase();
    if (/thunder|t-storm/.test(s) || h.kind === 'storm') return 'storm';
    if (/snow|sleet|flurr|freezing rain|ice pellets|wintry/.test(s) || h.kind === 'snow') return 'snow';
    return 'rain';
  }

  /* 'light' | 'steady' | 'heavy', plus the effective rate used. */
  function rainIntensity(h, cfg = INTERPRET) {
    const s = (h.cond || '').toLowerCase();
    const b = h.qpfBlock && h.qpfBlock.hrs ? h.qpfBlock : { total: h.qpf || 0, hrs: 1 };
    let rate = (b.total || 0) / Math.sqrt(Math.max(1, b.hrs));
    if (/thunder|shower/.test(s)) rate *= cfg.intensity.convectiveBoost;
    let level = rate >= cfg.intensity.heavyInPerHr ? 'heavy' : rate >= cfg.intensity.steadyInPerHr ? 'steady' : 'light';
    if (/heavy/.test(s)) level = 'heavy';
    else if (/drizzle|light/.test(s) && level === 'steady') level = 'light';
    return { level, rate };
  }

  function isWetHour(h, cfg = INTERPRET) {
    const r = cfg.rain;
    const perHour = h.qpfBlock && h.qpfBlock.hrs ? h.qpfBlock.total / h.qpfBlock.hrs : (h.qpf || 0);
    return (h.pop || 0) >= r.wetPop || ((h.pop || 0) >= r.wetPopWithAmount && perHour >= r.minHourlyAmountIn);
  }

  const isNightHour = hour => hour >= 21 || hour < 5;
  const dayWindowName = hour => (hour >= 5 && hour < 18 ? 'Rest of day' : 'Tomorrow');

  /* Which hours to dress for (item 4).
     '2'  → next 2 hours, '6' → next 6 hours,
     'day' → rest of today until 10 PM, or after 6 PM (and overnight) tomorrow 7 AM–9 PM. */
  function selectWindow(hours, key) {
    if (!hours || !hours.length) return { hours: [], kind: 'now' };
    const h0 = hours[0];
    if (key === '2') return { hours: hours.slice(0, 2), kind: 'now' };
    if (key === 'day') {
      if (h0.hour >= 5 && h0.hour < 18) {
        const hs = hours.filter(h => h.date === h0.date && h.hour < 22);
        return { hours: hs.length >= 3 ? hs : hours.slice(0, 3), kind: 'now' };
      }
      const target = h0.hour >= 18 ? (hours.find(h => h.date !== h0.date) || {}).date : h0.date;
      const hs = hours.filter(h => h.date === target && h.hour >= 7 && h.hour < 21);
      if (hs.length) return { hours: hs, kind: 'tomorrow' };
    }
    return { hours: hours.slice(0, 6), kind: 'now' };
  }

  /* Everything the outfit logic needs about a set of hours. */
  function analyze(hours, prefs = {}, cfg = INTERPRET) {
    const hs = hours.map(h => ({
      ...h,
      windAdj: windAdjustment(h, cfg),
      ct: clothingTemp(h, prefs, cfg),
      wet: isWetHour(h, cfg),
      ptype: precipType(h),
      intensity: rainIntensity(h, cfg).level
    }));
    const argmin = arr => arr.reduce((b, v, i) => (v < arr[b] ? i : b), 0);
    const argmax = arr => arr.reduce((b, v, i) => (v > arr[b] ? i : b), 0);
    const cts = hs.map(h => h.ct), feels = hs.map(h => h.feels), temps = hs.map(h => h.temp);

    const r = cfg.rain;
    const wetIdx = hs.map((h, i) => (h.wet ? i : -1)).filter(i => i >= 0);
    const total = hs.reduce((s, h) => s + (h.qpf || 0), 0);
    const maxPop = Math.max(0, ...hs.map(h => h.pop || 0));
    const meaningful = wetIdx.length > 0 && (total >= r.meaningfulTotalIn || maxPop >= r.meaningfulPop);
    const wetHs = wetIdx.map(i => hs[i]);
    const rank = { light: 0, steady: 1, heavy: 2 };
    const rain = {
      meaningful,
      startIdx: meaningful ? wetIdx[0] : -1,
      endIdx: meaningful ? wetIdx[wetIdx.length - 1] : -1,
      wetHours: wetIdx.length,
      type: wetHs.some(h => h.ptype === 'storm') ? 'storm' : wetHs.some(h => h.ptype === 'snow') ? 'snow' : 'rain',
      intensity: wetHs.reduce((m, h) => (rank[h.intensity] > rank[m] ? h.intensity : m), 'light'),
      total, maxPop,
      possible: !meaningful && maxPop >= r.possiblePop
    };

    const dayHs = hs.filter(h => h.isDay);
    const uvVals = dayHs.map(h => h.uv).filter(v => v != null);
    const uvMax = uvVals.length ? Math.max(...uvVals) : null;

    return {
      hours: hs,
      ct: { start: cts[0], min: Math.min(...cts), max: Math.max(...cts), coldIdx: argmin(cts), warmIdx: argmax(cts) },
      feels: { start: feels[0], min: Math.min(...feels), max: Math.max(...feels) },
      temp: { min: Math.min(...temps), max: Math.max(...temps) },
      wind: {
        maxWs: Math.max(0, ...hs.map(h => h.ws || 0)),
        maxGust: Math.max(0, ...hs.map(h => h.gust || 0)),
        maxAdj: Math.max(0, ...hs.map(h => h.windAdj))
      },
      rain,
      uv: { max: uvMax, idx: uvMax == null ? -1 : hs.findIndex(h => h.isDay && h.uv === uvMax) },
      dewMax: Math.max(-99, ...hs.map(h => (h.dew == null ? -99 : h.dew))),
      sunsetIdx: hs.findIndex((h, i) => i > 0 && !h.isDay && hs[i - 1].isDay),
      daylightHours: dayHs.length
    };
  }

  return { INTERPRET, windAdjustment, clothingTemp, precipType, rainIntensity, isWetHour, selectWindow, analyze, isNightHour, dayWindowName };
});
