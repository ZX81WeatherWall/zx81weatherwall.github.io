// desk-cities.js — the DESK CITIES each continental desk measures at (owner 2026-09-27: "the
// continental desks are often deadly dull"). ~30 real places per continent (src/desk-cities-data.js,
// baked by tools/build-desk-cities.js from Natural Earth). tools/refresh-desk-cities.js reads live
// conditions AT these cities for the continent about to post; refresh-report turns them into the
// SPOTS header block: the continent's HIGH / LOW, heaviest rain and strongest gust, each measured
// at the named city. The Z80 reporter bakes the SAME names (DCOFF/DCBLOB) — id = index here.
(function (g) {
  'use strict';
  const DATA = (typeof require === 'function') ? require('./desk-cities-data') : g.WW_DESK_CITIES_DATA;
  const NAMES = DATA.NAMES, LAT = DATA.LAT, LON = DATA.LON, CONT = DATA.CONT;
  const COUNT = NAMES.length;
  if (COUNT > 254) throw new Error('desk-cities: ' + COUNT + ' cities — ids must fit a byte below the 255 "none" marker');
  for (const n of NAMES) if (!/^[A-Z ]+$/.test(n)) throw new Error('desk-cities: name not ZX81-safe: ' + JSON.stringify(n));

  function citiesOf(contId) { const out = []; for (let i = 0; i < COUNT; i++) if (CONT[i] === contId) out.push(i); return out; }
  function name(id) { return (id >= 0 && id < COUNT) ? NAMES[id] : ''; }

  // Thresholds for the two "notable" lines — below them the line is simply absent.
  const RAIN_MM = 5;     // mm in the preceding hour (Open-Meteo current precipitation): heavy rain
  const GUST_KMH = 70;   // km/h: a strong gale gust

  // spotsOf(readings): pick the continent's HIGH / LOW / WET / GUST from live desk-city readings
  // ([{id, tempC, precipMm, gustKmh}]). Returns the 8-byte SPOTS wire block
  // [hiId, hiT, loId, loT, wetId, wetMm, gustId, gustKmh] (255 = none; temps as tempC+50 bytes,
  // clamped 0..255) or [] when there is nothing to report. Ties keep the lower id (larger city).
  function spotsOf(readings) {
    const rs = (readings || []).filter((r) => r && Number.isInteger(r.id) && r.id >= 0 && r.id < COUNT);
    const temps = rs.filter((r) => typeof r.tempC === 'number' && isFinite(r.tempC));
    if (!temps.length) return [];
    let hi = temps[0], lo = temps[0];
    for (const r of temps) {
      if (Math.round(r.tempC) > Math.round(hi.tempC)) hi = r;
      if (Math.round(r.tempC) < Math.round(lo.tempC)) lo = r;
    }
    const tb = (c) => Math.max(0, Math.min(255, Math.round(c) + 50));
    let wet = null, gust = null;
    for (const r of rs) {
      if (typeof r.precipMm === 'number' && r.precipMm >= RAIN_MM && (!wet || Math.round(r.precipMm) > Math.round(wet.precipMm))) wet = r;
      if (typeof r.gustKmh === 'number' && r.gustKmh >= GUST_KMH && (!gust || Math.round(r.gustKmh) > Math.round(gust.gustKmh))) gust = r;
    }
    return [hi.id, tb(hi.tempC), lo.id, tb(lo.tempC),
      wet ? wet.id : 255, wet ? Math.min(255, Math.round(wet.precipMm)) : 0,
      gust ? gust.id : 255, gust ? Math.min(255, Math.round(gust.gustKmh)) : 0];
  }

  const DC = { NAMES, LAT, LON, CONT, COUNT, citiesOf, name, spotsOf, RAIN_MM, GUST_KMH };
  if (typeof module !== 'undefined' && module.exports) module.exports = DC;
  else g.WW_DESK_CITIES = DC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
