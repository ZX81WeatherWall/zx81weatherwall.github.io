// warnings.js — ONE hazard taxonomy for every official warning source the wall reads (owner
// 2026-09-27: "look at other warning services around the globe such as environment canada").
//
// Sources -> normalized [{ hazard, place }] (place = src/alert-places.js id):
//   * US NWS            api.weather.gov CAP (src/nws-cap.js)        — US states (UGC codes)
//   * Environment Canada api.weather.gc.ca weather-alerts (GeoJSON) — provinces
//   * Meteoalarm         feeds.meteoalarm.org Atom, 37 European services — countries
//   * WMO SWIC           severeweather.wmo.int/v2/json/wmo_all.json   — countries (rest of world)
//
// LEVEL RULE (the same bar everywhere, "weather of continental interest, not crazy sprawl"):
// colour-coded services count ORANGE and RED only (Meteoalarm, Canada); WMO list severity
// Severe/Extreme only; NWS Severe/Extreme WARNING products only. River "flooding" warnings are
// excluded everywhere (owner 2026-09-24: flash floods only); heavy-RAIN warnings (the cause of flash
// flooding) are kept. For the US, routine severe-thunderstorm and wind warnings are not listed —
// NWS issues dozens a day and they would crowd every post; its tornado / flash flood / hurricane /
// coastal / heat / cold / winter-storm warnings are.
//
// HONESTY: a warning whose type cannot be recognised is DROPPED, never guessed. The WMO list is
// read only for services whose event names are English, Spanish or Portuguese.
(function (g) {
  'use strict';
  const AP = (typeof require === 'function') ? require('./alert-places') : g.WW_ALERT_PLACES;

  // Hazard keys, in ALERT precedence order (the bulletin clause order, both desks).
  const HAZARDS = ['TORNADO', 'HURR', 'COAST', 'FLASH', 'TSW', 'HEAT', 'WINTER', 'COLD', 'WIND', 'RAIN', 'THUNDER'];

  // ---- US NWS event -> hazard (Severe/Extreme warning products only; evacuation is separate) ----
  function hazardOfNws(event) {
    const e = String(event || '').toLowerCase();
    if (!/warning|emergency/.test(e)) return null;
    if (/tornado/.test(e)) return 'TORNADO';
    if (/hurricane|typhoon/.test(e)) return 'HURR';
    if (/tropical storm/.test(e)) return 'TSW';
    if (/storm surge|coastal flood/.test(e)) return 'COAST';
    if (/flash flood/.test(e)) return 'FLASH';
    if (/heat/.test(e)) return 'HEAT';
    if (/extreme cold|wind chill/.test(e)) return 'COLD';
    if (/blizzard|winter storm|ice storm|heavy snow/.test(e)) return 'WINTER';
    return null;   // severe thunderstorm / high wind / river flood / marine etc.: not listed for the US
  }

  // ---- generic event text (Canada, WMO list) -> hazard; English / Spanish / Portuguese ----
  // Order matters: tropical cyclones before generic storm/wind; "tormenta tropical" before
  // "tormenta"; coastal before any flood word; river "flood" alone never matches.
  const RULES = [
    [/tornado/, 'TORNADO'],
    [/hurricane|typhoon|tropical cyclone|hurac[aá]n|furac[aã]o|cicl[oó]n tropical|ciclone tropical/, 'HURR'],
    [/tropical storm|tormenta tropical|tempestade tropical/, 'TSW'],
    [/storm surge|coastal flood|coastal ?event|coastalevent|marejada|ressaca|inundaci[oó]n costera/, 'COAST'],
    [/flash flood|crecida s[uú]bita|crecida repentina|enxurrada/, 'FLASH'],
    [/heat|high-temperature|high temperature|calor|temperaturas? (extremas|altas|elevadas)|ola de calor|onda de calor/, 'HEAT'],
    [/extreme cold|low-temperature|low temperature|wind ?chill|fr[ií]o extremo|ola de fr[ií]o|onda de frio/, 'COLD'],
    [/blizzard|snow|ice storm|freezing rain|winter storm|nevada|nieve|neve|snow-ice/, 'WINTER'],
    [/thunder|tormenta|tempestad|trovoada|tempestade/, 'THUNDER'],
    [/rainfall|heavy rain|rain-flood|rain|lluvia|precipitaci|chuva|precipita[cç][aã]o/, 'RAIN'],
    [/wind|squall|gale|viento|vento|ventania/, 'WIND'],
  ];
  function hazardOfText(event) {
    const e = String(event || '').toLowerCase();
    if (/fog|niebla|nevoeiro|forest|fire|incendio|avalanche|dust|frost|helada|geada/.test(e)) return null;
    if (/\bflood(ing)?\b/.test(e) && !/flash|coastal|rain-flood/.test(e)) return null;   // river flood: out
    for (const [re, h] of RULES) if (re.test(e)) return h;
    return null;
  }

  // ---- Meteoalarm Atom (one country feed) ----
  // Entry title "<Colour> <Type> Warning issued for <Country> - <area>"; types are Meteoalarm's
  // awareness types. Orange/Red only; active now or starting within 12 h.
  const MA_TYPE = { 'wind': 'WIND', 'snow-ice': 'WINTER', 'thunderstorm': 'THUNDER', 'high-temperature': 'HEAT',
    'low-temperature': 'COLD', 'coastalevent': 'COAST', 'rain': 'RAIN', 'rain-flood': 'RAIN' };
  function parseMeteoalarm(atomText, place, nowMs) {
    const out = [];
    if (typeof atomText !== 'string' || !AP.isPlace(place)) return out;
    for (const e of atomText.split('<entry>').slice(1)) {
      const t = /<title>([^<]*)<\/title>/.exec(e);
      const m = t && /^\s*(Orange|Red) ([A-Za-z-]+) Warning issued for/i.exec(t[1]);
      if (!m) continue;
      const hz = MA_TYPE[m[2].toLowerCase()];
      if (!hz) continue;
      const cap = (k) => { const x = new RegExp('<cap:' + k + '>([^<]*)</cap:' + k + '>').exec(e); return x ? Date.parse(x[1]) : NaN; };
      const on = cap('onset'), ex = cap('expires');
      if (!(ex > nowMs) || (on > nowMs + 12 * 3600e3)) continue;
      out.push({ hazard: hz, place });
    }
    return out;
  }

  // ---- Environment Canada weather-alerts (GeoJSON FeatureCollection) ----
  function parseCanada(fc, nowMs) {
    const out = [];
    const feats = (fc && Array.isArray(fc.features)) ? fc.features : [];
    for (const f of feats) {
      const p = f && f.properties;
      if (!p || p.alert_type !== 'warning') continue;
      if (!/^(orange|red)$/i.test(p.risk_colour_en || '')) continue;
      if (/ended|cancel/i.test(p.status_en || '')) continue;
      const ex = Date.parse(p.expiration_datetime || '');
      if (ex && !(ex > nowMs)) continue;
      const hz = hazardOfText(p.alert_name_en);
      const place = AP.provinceId(p.province);
      if (hz && place >= 0) out.push({ hazard: hz, place });
    }
    return out;
  }

  // ---- WMO SWIC combined list ----
  // Item: {event, s (1 Minor .. 4 Extreme), expires, capURL "<iso2>-<service>-<lang>/..."}.
  // Countries covered by their own feed (US, Canada, Meteoalarm members) are skipped here.
  const WMO_LANG = /-(en|es|pt|xx)$/;
  const ISO_FIX = { uk: 'GB' };
  function parseWmoList(json, nowMs, skipIso) {
    const out = [];
    const items = (json && Array.isArray(json.items)) ? json.items : [];
    const skip = skipIso || new Set();
    for (const it of items) {
      if (!it || !(it.s >= 3)) continue;
      const src = String(it.capURL || '').split('/')[0];
      if (!WMO_LANG.test(src)) continue;
      const iso = (ISO_FIX[src.slice(0, 2)] || src.slice(0, 2)).toUpperCase();
      if (skip.has(iso)) continue;
      const ex = Date.parse(String(it.expires || '').replace(' ', 'T') + 'Z');
      if (ex && !(ex > nowMs)) continue;
      const hz = hazardOfText(it.event);
      const place = AP.countryId(iso);
      if (hz && place >= 0) out.push({ hazard: hz, place });
    }
    return out;
  }

  // ---- merge: [{hazard, place}] from every source -> { HAZARD: [{place, eventCode?}] } ----
  // Deduped per hazard, place-ID ascending (= population order), capped at `cap` per hazard.
  function byHazard(list, cap) {
    const sets = {};
    for (const h of HAZARDS) sets[h] = new Set();
    for (const w of (list || [])) if (w && sets[w.hazard] && AP.isPlace(w.place)) sets[w.hazard].add(w.place);
    const out = {};
    for (const h of HAZARDS) out[h] = AP.finish(sets[h], cap);
    return out;
  }

  const W = { HAZARDS, hazardOfNws, hazardOfText, parseMeteoalarm, parseCanada, parseWmoList, byHazard };
  if (typeof module !== 'undefined' && module.exports) module.exports = W;
  else g.WW_WARNINGS = W;
})(typeof globalThis !== 'undefined' ? globalThis : this);
