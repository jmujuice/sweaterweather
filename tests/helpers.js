/* Builds hourly forecast data in the same shape app.js passes to the engine.
   Any field can be a single value (every hour) or an array (one per hour; the last value repeats). */
function makeHours(spec = {}) {
  const n = spec.n || 6;
  const startHour = spec.startHour ?? 12;
  const at = (v, i) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);
  return Array.from({ length: n }, (_, i) => {
    const hour = (startHour + i) % 24;
    const day = Math.floor((startHour + i) / 24);
    const temp = at(spec.temp ?? 70, i);
    const ws = at(spec.ws ?? 5, i);
    const qpf = at(spec.qpf ?? 0, i);
    const isDay = spec.isDay !== undefined ? at(spec.isDay, i) : hour >= 7 && hour < 19;
    return {
      label: `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`,
      hour,
      date: `2026-10-${String(3 + day).padStart(2, '0')}`,
      isDay,
      temp,
      feels: spec.feels !== undefined ? at(spec.feels, i) : temp,
      ws,
      gust: spec.gust !== undefined ? at(spec.gust, i) : ws + 3,
      pop: at(spec.pop ?? 0, i),
      qpf,
      qpfBlock: spec.block ? at(spec.block, i) : { total: qpf, hrs: 1 },
      dew: at(spec.dew ?? 50, i),
      uv: isDay ? at(spec.uv ?? 2, i) : null,
      cond: at(spec.cond ?? 'Partly Sunny', i),
      kind: ''
    };
  });
}
module.exports = { makeHours };
