const test = require('node:test');
const assert = require('node:assert/strict');
const { recommend } = require('../js/recommend.js');
const { makeHours } = require('./helpers.js');

const rec = (spec, opts) => recommend(makeHours(spec), opts);
const has = (list, re) => list.some(s => re.test(s));
const alertText = r => r.alerts.map(a => `${a.icon} ${a.text}`);

/* ---------- Output shape ---------- */
test('returns structured data, not HTML', () => {
  const r = rec({ temp: 70 });
  assert.equal(typeof r.icon, 'string');
  assert.equal(typeof r.label, 'string');
  assert.ok(Array.isArray(r.clothing) && r.clothing.length >= 2);
  assert.equal(typeof r.summary, 'string');
  assert.ok(Array.isArray(r.alerts));
  assert.ok(!/[<>]/.test(JSON.stringify(r)));
});

/* ---------- Temperature band boundaries ---------- */
for (const [f, band, label] of [
  [80, 'hot', 'Dress for the heat'], [79, 'warm', 'Shorts weather'], [70, 'warm', 'Shorts weather'],
  [69, 'mild', 'T-shirt weather'], [65, 'mild', 'T-shirt weather'], [64, 'cool', 'Light layer weather'],
  [58, 'cool', 'Light layer weather'], [57, 'brisk', 'Hoodie weather'], [50, 'brisk', 'Hoodie weather'],
  [49, 'chilly', 'Jacket weather'], [40, 'chilly', 'Jacket weather'], [39, 'cold', 'Coat weather'],
  [32, 'cold', 'Coat weather'], [31, 'freezing', 'Bundle up']
]) {
  test(`boundary: feels ${f}°F → ${band}`, () => {
    const r = rec({ temp: f, ws: 3 });
    assert.equal(r.meta.band, band);
    assert.equal(r.label, label);
  });
}

/* ---------- Spec scenarios ---------- */
test('hot summer day: shorts, heat message, sunscreen', () => {
  const r = rec({ temp: 92, feels: 99, dew: 72, uv: 9, ws: 5 });
  assert.equal(r.label, 'Dress for the heat');
  assert.deepEqual(r.clothing, ['T-shirt', 'Shorts']);
  assert.ok(has(alertText(r), /Very hot/));
  assert.ok(has(alertText(r), /Sunscreen and a hat/));
});

test('mild 70°F day: T-shirt and shorts, nothing extra', () => {
  const r = rec({ temp: 70, ws: 4, uv: 3 });
  assert.equal(r.label, 'Shorts weather');
  assert.deepEqual(r.clothing, ['T-shirt', 'Shorts']);
  assert.match(r.summary, /No extra layer needed/);
  assert.equal(r.alerts.length, 0);
});

test('60°F: T-shirt with an optional light hoodie', () => {
  const r = rec({ temp: 60, ws: 4 });
  assert.equal(r.label, 'Light layer weather');
  assert.deepEqual(r.clothing, ['T-shirt', 'Light hoodie (optional)', 'Pants']);
});

test('50°F: hoodie or light jacket and pants', () => {
  const r = rec({ temp: 50, ws: 4 });
  assert.equal(r.label, 'Hoodie weather');
  assert.ok(r.clothing.includes('Hoodie or light jacket'));
  assert.ok(r.clothing.includes('Pants'));
});

test('45°F: jacket and pants', () => {
  const r = rec({ temp: 45, ws: 4 });
  assert.equal(r.label, 'Jacket weather');
  assert.ok(r.clothing.includes('Jacket'));
});

test('freezing: winter coat, hat and gloves, scarf when very cold', () => {
  const r = rec({ temp: 22, feels: 15, ws: 8 });
  assert.equal(r.label, 'Bundle up');
  assert.ok(r.clothing.includes('Winter coat'));
  assert.ok(r.clothing.includes('Hat and gloves'));
  assert.ok(r.clothing.includes('Scarf'));
});

test('windy: wind-resistant layer and a wind alert', () => {
  const r = rec({ temp: 66, ws: 28, gust: 40 });
  assert.equal(r.meta.band, 'cool');        // 66°F minus 6°F for strong wind
  assert.ok(r.clothing.includes('Windbreaker'));
  assert.ok(has(alertText(r), /Windy, with gusts to 40 mph/));
});

test('breezy: wind shifts the band and the card explains why', () => {
  const r = rec({ temp: 66, ws: 17, gust: 22 });
  assert.equal(r.meta.band, 'cool');
  assert.ok(has(alertText(r), /Breezy, so it’ll feel cooler than 66°/));
});

test('no double counting: no wind adjustment at 50°F and below', () => {
  const r = rec({ temp: 45, feels: 38, ws: 20, gust: 24 });
  assert.equal(r.meta.clothingTemp.min, 38);
});

test('rain arriving later: keep the outfit, say when it starts', () => {
  const r = rec({ temp: 68, pop: [10, 10, 10, 10, 70, 70], qpf: [0, 0, 0, 0, 0.05, 0.05], cond: 'Chance Rain' });
  assert.notEqual(r.label, 'Bring a rain jacket');
  assert.ok(has(alertText(r), /Dry through about 4 PM\. Bring a rain jacket if you’ll be out later\./));
});

test('rain now: rain jacket headline', () => {
  const r = rec({ temp: 62, pop: 80, qpf: 0.05, cond: 'Rain' });
  assert.equal(r.label, 'Bring a rain jacket');
  assert.equal(r.icon, '🌧️');
  assert.match(r.summary, /likely now/);
  assert.ok(r.clothing.includes('Light rain jacket'));
});

test('rain starting within 2 hours is the headline, with its start time', () => {
  const r = rec({ temp: 68, pop: [10, 20, 70, 70, 70, 70], qpf: [0, 0, 0.04, 0.04, 0.04, 0.04], cond: 'Rain' });
  assert.equal(r.label, 'Bring a rain jacket');
  assert.match(r.summary, /becomes likely around 2 PM/);
});

test('small rain chance does not trigger rain gear', () => {
  const r = rec({ temp: 70, pop: 25, qpf: 0 });
  assert.equal(r.meta.rain.meaningful, false);
  assert.ok(!r.clothing.some(c => /rain/i.test(c)));
  assert.equal(r.alerts.length, 0);
});

test('35% chance with almost no rain: a mention, no gear', () => {
  const r = rec({ temp: 70, pop: 35, qpf: 0.005 });
  assert.ok(has(alertText(r), /stray shower/));
  assert.ok(!r.clothing.some(c => /rain/i.test(c)));
});

test('warm afternoon becoming cold after sunset', () => {
  const r = rec({ startHour: 15, temp: [75, 74, 72, 66, 60, 56], isDay: [true, true, true, false, false, false], ws: 4 });
  assert.equal(r.label, 'T-shirt now, hoodie tonight');
  assert.equal(r.icon, '👕');
  assert.match(r.summary, /want the hoodie after sunset, when it drops into the mid 50s/);
  assert.deepEqual(r.clothing, ['T-shirt', 'Hoodie or light jacket for later', 'Pants']);
});

test('cold morning warming substantially', () => {
  const r = rec({ startHour: 8, temp: [46, 50, 56, 62, 66, 69], ws: 4 });
  assert.equal(r.label, 'Jacket this morning, T-shirt later');
  assert.match(r.summary, /Starts around 46° but warms into the upper 60s this afternoon\. The jacket can come off around 11 AM\./);
  assert.deepEqual(r.clothing, ['T-shirt', 'Jacket', 'Pants']);
});

test('small temperature drift does not trigger a change message', () => {
  const r = rec({ temp: [66, 65, 64, 63, 63, 62], ws: 4 });
  assert.equal(r.meta.change, null);
});

test('high UV: sunscreen', () => {
  const r = rec({ temp: 75, uv: 7, ws: 4 });
  assert.ok(has(alertText(r), /☀️ Sunscreen recommended \(UV 7\)/));
});

test('normal UV stays off the card', () => {
  const r = rec({ temp: 75, uv: 4, ws: 4 });
  assert.equal(r.alerts.length, 0);
});

test('cold + windy + rain', () => {
  const r = rec({ temp: 42, feels: 35, ws: 26, gust: 38, pop: 80, qpf: 0.15, cond: 'Rain' });
  assert.equal(r.label, 'Bring a rain jacket');
  assert.equal(r.meta.band, 'cold');
  assert.ok(r.clothing.includes('Waterproof coat'));
  assert.ok(r.clothing.includes('Waterproof shoes'));
  assert.ok(has(alertText(r), /Windy/));
});

test('rain and a temperature drop: rain headline, drop as an alert', () => {
  const r = rec({ startHour: 15, temp: [72, 70, 66, 60, 57, 55], pop: 80, qpf: 0.05, cond: 'Rain', isDay: [true, true, true, false, false, false] });
  assert.equal(r.label, 'Bring a rain jacket');
  assert.ok(has(alertText(r), /🌙 Cools into the mid 50s/));
});

test('snow', () => {
  const r = rec({ temp: 28, feels: 20, pop: 80, qpf: 0.05, cond: 'Snow' });
  assert.equal(r.label, 'Dress for snow');
  assert.ok(r.clothing.includes('Waterproof boots'));
});

test('thunderstorms add a safety line', () => {
  const r = rec({ temp: 82, pop: 70, qpf: 0.2, cond: 'Showers And Thunderstorms' });
  assert.equal(r.icon, '⛈️');
  assert.ok(has(alertText(r), /Head inside if you hear thunder/));
});

test('hot and rainy: umbrella instead of a rain jacket', () => {
  const r = rec({ temp: 86, pop: 70, qpf: 0.2, cond: 'Rain' });
  assert.equal(r.label, 'Bring an umbrella');
  assert.equal(r.clothing.at(-1), 'Umbrella');
  assert.ok(!r.clothing.includes('Waterproof shoes'));
});

/* ---------- Personal settings (item 5) ---------- */
test('runs cold: dresses warmer', () => {
  assert.equal(rec({ temp: 61, ws: 3 }).meta.band, 'cool');
  assert.equal(rec({ temp: 61, ws: 3 }, { comfort: 'cold' }).meta.band, 'brisk');
});
test('runs warm: dresses lighter', () => {
  assert.equal(rec({ temp: 61, ws: 3 }, { comfort: 'warm' }).meta.band, 'mild');
});
test('sitting still needs more; being active needs less', () => {
  assert.equal(rec({ temp: 55, ws: 3 }, { activity: 'still' }).meta.band, 'chilly');
  assert.equal(rec({ temp: 55, ws: 3 }, { activity: 'active' }).meta.band, 'mild');
});
test('teen voice changes wording, not the decision', () => {
  const std = rec({ temp: 52, ws: 3 });
  const tn = rec({ temp: 52, ws: 3 }, { voice: 'teen' });
  assert.equal(tn.meta.band, std.meta.band);
  assert.equal(tn.label, 'Hoodie szn');
  assert.equal(tn.clothing[0], 'Tee');
});

/* ---------- Time windows (item 4) ---------- */
test('2-hour window still warns about rain just after it', () => {
  const r = rec({ temp: 68, pop: [0, 0, 0, 80, 80, 80], qpf: [0, 0, 0, 0.05, 0.05, 0.05], cond: 'Rain' }, { window: '2' });
  assert.equal(r.meta.hours, 2);
  assert.ok(has(alertText(r), /Dry through about 3 PM/));
});
test('at night, "day" means tomorrow 7 AM–9 PM', () => {
  const r = rec({ n: 30, startHour: 22, temp: 60 }, { window: 'day' });
  assert.equal(r.meta.window, 'tomorrow');
  assert.equal(r.meta.from, '7 AM');
  assert.equal(r.meta.to, '8 PM');
});
test('during the day, "day" means the rest of today', () => {
  const r = rec({ n: 30, startHour: 10, temp: 60 }, { window: 'day' });
  assert.equal(r.meta.window, 'now');
  assert.equal(r.meta.to, '9 PM');
});

/* ---------- Units ---------- */
test('Celsius wording', () => {
  const r = rec({ startHour: 8, temp: [46, 50, 56, 62, 66, 69], ws: 4 }, { unit: 'C' });
  assert.match(r.summary, /Starts around 8° but warms into around 21°/);
});
