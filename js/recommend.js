/*
 * Sweater Weather: "What should I wear?" recommendation engine.
 *
 * Answers: "If I leave now and I'm out for the next few hours, what should I wear?"
 * Deterministic rules only (no AI calls). Uses facts from interpret.js and returns
 * structured data; rendering lives in app.js.
 *
 *   recommend(hours, { window: '2'|'6'|'day', comfort: 'cold'|'average'|'warm',
 *                      activity: 'still'|'walking'|'active', voice: 'standard'|'teen',
 *                      unit: 'F'|'C' })
 *   → { icon, label, clothing: [..], summary, alerts: [{ icon, text }], meta: {..} }
 */
(function (root, factory) {
  const I = (typeof module === 'object' && module.exports) ? require('./interpret.js') : root.SW;
  const api = factory(I);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SW = Object.assign(root.SW || {}, api);
})(typeof self !== 'undefined' ? self : this, function (I) {
  'use strict';

  /* ---- Tunable settings ---- */
  const RECOMMEND = {
    changeMinF: 5,          // a temperature change must be at least this big (°F) to call out
    rainHeadlineWithin: 2,  // rain starting within this many hours becomes the headline
    sunscreenUV: 6, hatUV: 8,
    veryHotF: 95,
    humidDewF: 68,
    maxAlerts: 2,
    // Clothing temperature bands (°F), warmest first. `min` is inclusive.
    bands: [
      { key: 'hot', min: 80, icon: '🥵', label: 'Dress for the heat', teenLabel: 'Hot hot, dress light',
        top: 'T-shirt', layer: null, bottoms: 'Shorts', piece: 'T-shirt', teenPiece: 'tee',
        note: 'Light, breathable clothes. Shade and water help.', teenNote: 'Breathable fits only, stay hydrated.',
        rain: { add: 'Umbrella' } },
      { key: 'warm', min: 70, icon: '🩳', label: 'Shorts weather', teenLabel: 'Shorts szn',
        top: 'T-shirt', layer: null, bottoms: 'Shorts', piece: 'T-shirt', teenPiece: 'tee',
        note: 'No extra layer needed.', teenNote: 'No extra layer needed.',
        rain: { replace: 'Light rain jacket' } },
      { key: 'mild', min: 65, icon: '👕', label: 'T-shirt weather', teenLabel: 'Tee weather',
        top: 'T-shirt', layer: null, bottoms: 'Shorts or pants', piece: 'T-shirt', teenPiece: 'tee',
        note: 'Shorts or pants both work.', teenNote: 'Shorts or pants, both valid.',
        rain: { replace: 'Light rain jacket' }, wind: { replace: 'Windbreaker' } },
      { key: 'cool', min: 58, icon: '👕', label: 'Light layer weather', teenLabel: 'Light layer kinda day',
        top: 'T-shirt', layer: 'Light hoodie', optional: true, bottoms: 'Pants', piece: 'light hoodie', teenPiece: 'light hoodie',
        note: 'The hoodie is optional. Grab it if you’ll be out a while.', teenNote: 'Hoodie optional, lowkey nice to have.',
        rain: { replace: 'Light rain jacket' }, wind: { replace: 'Windbreaker' } },
      { key: 'brisk', min: 50, icon: '🧥', label: 'Hoodie weather', teenLabel: 'Hoodie szn',
        top: 'T-shirt', layer: 'Hoodie or light jacket', bottoms: 'Pants', piece: 'hoodie', teenPiece: 'hoodie',
        note: 'A hoodie or light jacket should be enough.', teenNote: 'Hoodie or light jacket and you’re good.',
        rain: { replace: 'Hoodie', add: 'Rain jacket' }, wind: { replace: 'Wind-resistant jacket' } },
      { key: 'chilly', min: 40, icon: '🧥', label: 'Jacket weather', teenLabel: 'Jacket, no debate',
        top: 'Long sleeve', layer: 'Jacket', bottoms: 'Pants', piece: 'jacket', teenPiece: 'jacket',
        note: 'You’ll want a real jacket.', teenNote: 'Real jacket, not just a hoodie.',
        rain: { replace: 'Waterproof jacket' }, wind: { replace: 'Wind-resistant jacket' } },
      { key: 'cold', min: 32, icon: '🧣', label: 'Coat weather', teenLabel: 'Coat time fr',
        top: 'Sweater', layer: 'Warm coat', bottoms: 'Pants', piece: 'coat', teenPiece: 'coat',
        note: 'Wear a warm coat.', teenNote: 'Coat on, no cap.',
        rain: { replace: 'Waterproof coat' } },
      { key: 'freezing', min: -Infinity, icon: '🥶', label: 'Bundle up', teenLabel: 'Bundle up, it’s brick',
        top: 'Warm layers', layer: 'Winter coat', bottoms: 'Pants', acc: ['Hat and gloves'], piece: 'winter coat', teenPiece: 'winter coat',
        note: 'Cover up, including hands and ears.', teenNote: 'Hat and gloves, don’t play.',
        rain: {} }
    ]
  };

  const TEEN_ITEMS = {
    'T-shirt': 'Tee', 'Hat and gloves': 'Beanie and gloves', 'Waterproof shoes': 'Shoes that can get wet',
    'Warm layers': 'Thermal + hoodie', 'Light rain jacket': 'Rain jacket', 'Waterproof boots': 'Boots with grip',
    'Shoes that can get wet': 'Slides or beaters'
  };

  /* ---- Small helpers ---- */
  const bandFor = ct => RECOMMEND.bands.find(b => ct >= b.min);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const fmtT = (f, unit) => Math.round(unit === 'C' ? (f - 32) * 5 / 9 : f) + '°';
  const fmtW = (mph, unit) => unit === 'C' ? `${Math.round(mph * 1.609344)} km/h` : `${Math.round(mph)} mph`;
  function tempPhrase(f, unit) {
    if (unit === 'C') return `around ${fmtT(f, 'C')}`;
    const n = Math.round(f);
    if (n < 10) return `around ${n}°`;
    const tens = Math.floor(n / 10) * 10, r = n - tens;
    return `the ${r <= 3 ? 'low' : r <= 6 ? 'mid' : 'upper'} ${tens}s`;
  }
  function periodPhrase(hour, kind) {
    if (kind === 'tomorrow') return hour < 12 ? 'in the morning' : hour < 17 ? 'in the afternoon' : 'in the evening';
    return hour < 12 ? 'this morning' : hour < 17 ? 'this afternoon' : 'tonight';
  }

  /* Clothing list for a band, with rain, wind and timing changes applied. */
  function buildClothing(band, o) {
    const items = [];
    const name = s => (o.teen && TEEN_ITEMS[s]) || s;
    items.push(name(o.top || band.top));
    let layer = band.layer, optional = !!band.optional, extra = null;
    if (o.rain && band.rain) {
      if (band.rain.replace) { layer = band.rain.replace; optional = false; }
      if (band.rain.add) extra = band.rain.add;
    } else if (o.windy && band.wind) {
      layer = band.wind.replace; optional = false;
    }
    if (layer) items.push(name(layer) + (o.later ? ' for later' : optional ? ' (optional)' : ''));
    if (extra && extra !== 'Umbrella') items.push(name(extra));
    items.push(name(band.bottoms));
    (band.acc || []).forEach(a => items.push(name(a)));
    if (o.ct < 20) items.push('Scarf');
    if (o.rain && o.rain.type === 'snow') items.push(name('Waterproof boots'));
    else if (o.rain && o.rain.intensity !== 'light') items.push(name(band.min >= 70 ? 'Shoes that can get wet' : 'Waterproof shoes'));
    if (extra === 'Umbrella') items.push(name(extra));
    return items;
  }

  function rainSentence(rain, H, kind, teen) {
    const s = H[rain.startIdx];
    const word = rain.type === 'snow' ? 'Snow' : rain.type === 'storm' ? 'Thunderstorms'
      : rain.intensity === 'heavy' ? 'Heavy rain' : rain.intensity === 'light' ? 'Light rain' : 'Rain';
    const after = rain.endIdx < H.length - 1 ? H[rain.endIdx + 1] : null;
    const end = after ? (teen ? `, done by about ${after.label}` : `, clearing by about ${after.label}`) : '';
    if (teen) {
      return rain.startIdx === 0 && kind === 'now' ? `${word} rn${end}.` : `${word} hits around ${s.label}${end}.`;
    }
    if (rain.startIdx === 0) {
      return kind === 'now' ? `${word} ${rain.type === 'storm' ? 'possible' : 'likely'} now${end}.` : `${word} likely from ${s.label}${end}.`;
    }
    return rain.type === 'storm' ? `${word} possible around ${s.label}${end}.` : `${word} becomes likely around ${s.label}${end}.`;
  }

  /* ---- Main entry point ---- */
  function recommend(hoursAll, opts = {}) {
    const o = Object.assign({ window: '6', comfort: 'average', activity: 'walking', voice: 'standard', unit: 'F' }, opts);
    const R = RECOMMEND, W = I.INTERPRET.wind;
    const teen = o.voice === 'teen';
    const v = (std, tn) => (teen ? tn : std);
    const T = f => fmtT(f, o.unit);
    const P = b => (teen ? b.teenPiece : b.piece);

    const win = I.selectWindow(hoursAll, o.window);
    if (!win.hours.length) return null;
    const a = I.analyze(win.hours, o);
    const H = a.hours;
    const startB = bandFor(a.ct.start), coldB = bandFor(a.ct.min), warmB = bandFor(a.ct.max);

    /* Temperature change inside the window */
    let change = null;
    if (a.ct.coldIdx > 0 && coldB.piece !== startB.piece && a.ct.start - a.ct.min >= R.changeMinF) {
      change = { dir: 'cooling', to: coldB, idx: H.findIndex(h => h.ct < a.ct.start && bandFor(h.ct).piece !== startB.piece) };
    } else if (a.ct.warmIdx > 0 && warmB.piece !== startB.piece && a.ct.max - a.ct.start >= R.changeMinF && a.ct.start - a.ct.min < 2) {
      // The layer can come off once it's two bands warmer than the start (or as warm as it gets).
      const rank = b => R.bands.indexOf(b);
      change = { dir: 'warming', to: warmB, idx: H.findIndex(h => h.ct > a.ct.start && (rank(bandFor(h.ct)) <= rank(startB) - 2 || bandFor(h.ct) === warmB)) };
    }

    /* Rain: wear it if it starts soon, otherwise mention when it arrives */
    const rain = a.rain;
    const rainWorn = rain.meaningful && rain.startIdx <= R.rainHeadlineWithin;
    let later = null;
    if (rain.meaningful && !rainWorn) later = { rain, at: H[rain.startIdx] };
    else if (!rain.meaningful && win.kind === 'now' && H.length < 6) {
      const ahead = I.analyze(hoursAll.slice(0, 6), o).rain;
      if (ahead.meaningful) later = { rain: ahead, at: hoursAll[ahead.startIdx] };
    }
    const windy = a.wind.maxWs >= W.windyMph || a.wind.maxGust >= W.windyGustMph;

    /* Headline */
    let icon, label;
    if (rainWorn) {
      if (rain.type === 'snow') { icon = '❄️'; label = v('Dress for snow', 'Snow fit activated'); }
      else if (coldB.key === 'hot') { icon = rain.type === 'storm' ? '⛈️' : '☔'; label = v('Bring an umbrella', 'Umbrella day'); }
      else { icon = rain.type === 'storm' ? '⛈️' : '🌧️'; label = v('Bring a rain jacket', 'Rain jacket, trust'); }
    } else if (change) {
      icon = { 'T-shirt': '👕', 'light hoodie': '🧥', hoodie: '🧥', jacket: '🧥', coat: '🧣', 'winter coat': '🥶' }[startB.piece];
      const startWord = win.kind === 'now' ? (change.dir === 'cooling' ? 'now' : periodPhrase(H[0].hour, 'now')) : periodPhrase(H[0].hour, win.kind);
      label = change.dir === 'cooling'
        ? `${cap(P(startB))} ${startWord}, ${P(change.to)} ${periodPhrase(H[change.idx].hour, win.kind)}`
        : `${cap(P(startB))} ${startWord}, ${P(change.to)} later`;
    } else {
      icon = coldB.icon; label = v(coldB.label, coldB.teenLabel);
    }

    /* Clothing */
    const mods = { rain: rainWorn ? rain : null, windy, ct: a.ct.min, teen };
    const clothing = change && change.dir === 'cooling' ? buildClothing(coldB, { ...mods, top: startB.top, later: true })
      : change && change.dir === 'warming' ? buildClothing(coldB, { ...mods, top: warmB.top })
      : buildClothing(coldB, mods);

    /* Summary */
    const range = T(a.feels.min) === T(a.feels.max) ? T(a.feels.min) : `${T(a.feels.min).replace('°', '')}–${T(a.feels.max)}`;
    let summary;
    if (rainWorn) {
      summary = rainSentence(rain, H, win.kind, teen);
    } else if (change && change.dir === 'cooling') {
      const at = H[change.idx];
      const when = a.sunsetIdx >= 0 && Math.abs(change.idx - a.sunsetIdx) <= 1 ? 'after sunset' : `after ${at.label}`;
      summary = v(`You’ll probably want the ${P(change.to)} ${when}, when it drops into ${tempPhrase(a.feels.min, o.unit)}.`,
                  `You’ll want the ${P(change.to)} ${when}, it drops to ${tempPhrase(a.feels.min, o.unit)}.`);
    } else if (change) {
      const at = H[change.idx], peak = periodPhrase(H[a.ct.warmIdx].hour, win.kind);
      summary = v(`Starts around ${T(a.feels.start)} but warms into ${tempPhrase(a.feels.max, o.unit)} ${peak}. The ${P(startB)} can come off around ${at.label}.`,
                  `Cold start (${T(a.feels.start)}), warms to ${tempPhrase(a.feels.max, o.unit)} ${peak}. ${cap(P(startB))} comes off around ${at.label}.`);
    } else {
      summary = v(`Feels like ${range}. ${coldB.note}`, `Feels ${range}. ${coldB.teenNote}`);
    }

    /* Secondary alerts, most important first */
    const alerts = [];
    const add = (icn, std, tn) => alerts.push({ icon: icn, text: v(std, tn) });
    if (rainWorn && rain.type === 'storm') add('⛈️', 'Head inside if you hear thunder.', 'Thunder = go inside, fr.');
    if (later) {
      const lbl = later.at.label, r = later.rain;
      if (r.type === 'storm') add('⛈️', `Storms possible around ${lbl}. Head inside if you hear thunder.`, `Storms around ${lbl}, be inside when it thunders.`);
      else if (r.type === 'snow') add('❄️', `Snow likely from about ${lbl}. Dress for it if you’ll be out later.`, `Snow around ${lbl}, dress for it if you’re out late.`);
      else if (coldB.key === 'hot') add('☔', `Dry through about ${lbl}. Bring an umbrella if you’ll be out later.`, `Dry till about ${lbl}, grab an umbrella if you’re out late.`);
      else add('🌧️', `Dry through about ${lbl}. Bring a rain jacket if you’ll be out later.`, `Dry till about ${lbl}, bring a rain jacket if you’re out late.`);
    }
    if (rainWorn && change) {
      const at = H[change.idx];
      if (change.dir === 'cooling') add('🌙', `Cools into ${tempPhrase(a.feels.min, o.unit)} after ${at.label}.`, `Drops to ${tempPhrase(a.feels.min, o.unit)} after ${at.label}.`);
      else add('🌤️', `Warms into ${tempPhrase(a.feels.max, o.unit)} by ${at.label}.`, `Warms up to ${tempPhrase(a.feels.max, o.unit)} by ${at.label}.`);
    }
    if (windy && a.ct.min < 75) {
      add('💨', `Windy, with gusts to ${fmtW(a.wind.maxGust, o.unit)}. A wind-resistant layer helps.`, `Wind is wild, gusts to ${fmtW(a.wind.maxGust, o.unit)}. Wear something that blocks it.`);
    } else if (a.wind.maxAdj >= 4 && bandFor(a.ct.min + a.wind.maxAdj).key !== coldB.key) {
      add('💨', `Breezy, so it’ll feel cooler than ${T(H[a.ct.coldIdx].temp)}.`, `Breezy, feels colder than ${T(H[a.ct.coldIdx].temp)}.`);
    }
    if (a.feels.max >= R.veryHotF) add('🥵', 'Very hot. Drink water and take breaks in the shade.', 'It’s scorching. Water + shade breaks.');
    const mostlyWet = rainWorn && rain.wetHours >= H.length - 1;
    if (a.uv.max != null && a.uv.max >= R.sunscreenUV && a.daylightHours > 0 && !mostlyWet) {
      add('☀️', `Sunscreen${a.uv.max >= R.hatUV ? ' and a hat' : ''} recommended (UV ${a.uv.max})`, `Sunscreen${a.uv.max >= R.hatUV ? ' + a hat' : ''}. A burn is not a flex.`);
    }
    if (a.dewMax >= R.humidDewF && ['hot', 'warm', 'mild'].includes(coldB.key)) add('💧', 'Humid. Breathable fabric will help.', 'Sticky out. Breathable stuff only.');
    if (rain.possible && !later) add('🌦️', 'A stray shower is possible. No rain gear needed.', 'Maybe a sprinkle, no rain gear needed.');

    return {
      icon, label, clothing, summary,
      alerts: alerts.slice(0, R.maxAlerts),
      meta: {
        window: win.kind, hours: H.length, from: H[0].label, to: H[H.length - 1].label,
        clothingTemp: { start: a.ct.start, min: a.ct.min, max: a.ct.max },
        band: coldB.key, startBand: startB.key, change: change ? change.dir : null,
        rain: { ...rain, worn: rainWorn, later: later ? later.at.label : null },
        windy, uvMax: a.uv.max
      }
    };
  }

  return { RECOMMEND, recommend, bandFor, tempPhrase, buildClothing };
});
