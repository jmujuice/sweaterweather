const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../js/interpret.js');
const S = require('../js/solar.js');
const { makeHours } = require('./helpers.js');

/* ---------- Wind ---------- */
test('wind adjustment tiers between 50°F and 80°F', () => {
  const h = (temp, ws) => ({ temp, feels: temp, ws });
  assert.equal(I.windAdjustment(h(65, 9)), 0);
  assert.equal(I.windAdjustment(h(65, 10)), 2);
  assert.equal(I.windAdjustment(h(65, 15)), 4);
  assert.equal(I.windAdjustment(h(65, 25)), 6);
  assert.equal(I.windAdjustment(h(50, 25)), 0);   // NWS feels-like already has wind chill
  assert.equal(I.windAdjustment(h(80, 25)), 0);
});

/* ---------- Rain intensity from NWS blocks (item 6) ---------- */
test('a 6-hour block is not watered down', () => {
  // 0.5" over 6 hours: spreading evenly says 0.08"/hr (light). We call it steady.
  assert.equal(I.rainIntensity({ qpfBlock: { total: 0.5, hrs: 6 }, cond: 'Rain' }).level, 'steady');
  assert.equal(I.rainIntensity({ qpfBlock: { total: 0.8, hrs: 6 }, cond: 'Rain' }).level, 'heavy');
  assert.equal(I.rainIntensity({ qpfBlock: { total: 0.05, hrs: 6 }, cond: 'Rain' }).level, 'light');
});
test('showers and storms come in bursts', () => {
  assert.equal(I.rainIntensity({ qpfBlock: { total: 0.5, hrs: 6 }, cond: 'Showers And Thunderstorms' }).level, 'heavy');
});
test('forecast wording wins when it is explicit', () => {
  assert.equal(I.rainIntensity({ qpfBlock: { total: 0.02, hrs: 1 }, cond: 'Heavy Rain' }).level, 'heavy');
  assert.equal(I.rainIntensity({ qpfBlock: { total: 0.4, hrs: 6 }, cond: 'Light Rain' }).level, 'light');
});
test('wet hour needs a real chance and some amount', () => {
  assert.equal(I.isWetHour({ pop: 65, qpf: 0 }), true);
  assert.equal(I.isWetHour({ pop: 45, qpfBlock: { total: 0.06, hrs: 6 } }), true);
  assert.equal(I.isWetHour({ pop: 45, qpfBlock: { total: 0.01, hrs: 6 } }), false);
  assert.equal(I.isWetHour({ pop: 30, qpf: 0.1 }), false);
});

/* ---------- Windows ---------- */
test('window selection', () => {
  const day = makeHours({ n: 30, startHour: 9 });
  assert.equal(I.selectWindow(day, '2').hours.length, 2);
  assert.equal(I.selectWindow(day, '6').hours.length, 6);
  assert.equal(I.selectWindow(day, 'day').hours.at(-1).hour, 21);
  const late = makeHours({ n: 30, startHour: 1 });
  const w = I.selectWindow(late, 'day');
  assert.equal(w.kind, 'tomorrow');
  assert.equal(w.hours[0].hour, 7);
  assert.equal(I.dayWindowName(9), 'Rest of day');
  assert.equal(I.dayWindowName(19), 'Tomorrow');
  assert.equal(I.isNightHour(22), true);
});

/* ---------- UV estimate (item 7) ---------- */
const DC = [38.98, -77.53];
test('UV near noon in early summer is high', () => {
  const uv = S.estimateUV(...DC, Date.parse('2026-06-21T16:40:00Z'), 0, 0);
  assert.ok(uv >= 9 && uv <= 12, `got ${uv}`);
});
test('UV near noon in late September is moderate', () => {
  const uv = S.estimateUV(...DC, Date.parse('2026-09-26T16:40:00Z'), 0, 0);
  assert.ok(uv >= 5 && uv <= 7, `got ${uv}`);
});
test('UV is zero at night', () => {
  assert.equal(S.estimateUV(...DC, Date.parse('2026-09-26T04:00:00Z'), 0, 0), 0);
});
test('clouds cut UV', () => {
  const t = Date.parse('2026-06-21T16:40:00Z');
  const clear = S.estimateUV(...DC, t, 0, 0), overcast = S.estimateUV(...DC, t, 100, 0);
  assert.ok(overcast <= clear * 0.4, `clear ${clear}, overcast ${overcast}`);
});
