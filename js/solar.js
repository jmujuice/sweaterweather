/*
 * Sweater Weather: sun position and UV index estimate.
 *
 * The EPA only publishes a UV forecast for today, so for every other hour we estimate it:
 *   1. Work out how high the sun is (solar zenith angle) for the place and time.
 *   2. Clear-sky UV index ≈ 12.5 × cos(zenith)^2.42  (Madronich, 2007, with typical ozone).
 *   3. Scale down for clouds using NWS sky cover, and a little more when rain is likely.
 * Accurate to about ±1 to 2 UV index points: good enough to decide on sunscreen.
 *
 * Pure functions, no DOM. Works in the browser (window.SW) and in Node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SW = Object.assign(root.SW || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RAD = Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* Solar zenith angle in degrees (0 = sun overhead, 90+ = below the horizon). */
  function solarZenith(lat, lon, ms) {
    const n = ms / 86400000 + 2440587.5 - 2451545.0;          // days since J2000
    const L = (280.46 + 0.9856474 * n) % 360;                  // mean longitude
    const g = ((357.528 + 0.9856003 * n) % 360) * RAD;         // mean anomaly
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
    const eps = (23.439 - 0.0000004 * n) * RAD;
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const gmstHours = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
    const ha = (gmstHours * 15 + lon) * RAD - ra;              // hour angle
    const latR = lat * RAD;
    const cosZ = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
    return Math.acos(clamp(cosZ, -1, 1)) / RAD;
  }

  /* UV index under a clear sky. */
  function clearSkyUV(zenithDeg, ozoneDU = 300) {
    const mu = Math.cos(zenithDeg * RAD);
    if (mu <= 0) return 0;
    return 12.5 * Math.pow(mu, 2.42) * Math.pow(ozoneDU / 300, -1.23);
  }

  /* Share of UV that gets through clouds, from sky cover 0–100%. Overcast lets ~30% through. */
  function cloudFactor(skyCoverPct) {
    if (skyCoverPct == null) return 0.85;
    const c = clamp(skyCoverPct, 0, 100) / 100;
    return 1 - 0.7 * Math.pow(c, 2.5);
  }

  /* Estimated UV index (whole number) for the hour starting at ms. */
  function estimateUV(lat, lon, ms, skyCoverPct, pop) {
    const z = solarZenith(lat, lon, ms + 30 * 60000);          // middle of the hour
    let uv = clearSkyUV(z) * cloudFactor(skyCoverPct);
    if (pop != null && pop >= 60) uv *= 0.75;
    return Math.max(0, Math.round(uv));
  }

  return { solarZenith, clearSkyUV, cloudFactor, estimateUV };
});
