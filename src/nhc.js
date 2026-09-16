// nhc.js — NHC CurrentStorms.json fetch for FS2 cyclone-honesty naming.
//
// The National Hurricane Center publishes the live list of active tropical
// systems (Atlantic + E/Central Pacific) at a keyless JSON endpoint. FS2 uses
// it as the authoritative *naming* source and as the spiral-gate override
// (§C.2: a poleward tier-CYCLONE detection keeps its tropical spiral only if a
// real NHC-named system sits within 500 km — see gateway.matchNhcStorm).
//
// Graceful degrade is a HARD requirement (design R2): ANY failure — network
// error, non-200, empty/malformed body, missing activeStorms — returns [] and
// NEVER throws. An empty feed (off-season / no active storms) is the NORMAL
// case and is indistinguishable, on purpose, from a benign failure: both mean
// "no NHC names available", so the wall falls back to the latitude-only gate.
//
// The normalized storm keeps the RAW NHC field names latitudeNumeric /
// longitudeNumeric so gateway.matchNhcStorm consumes it directly.
// Dual module (Node 18+/browser both have global fetch).
(function (g) {
  'use strict';
  const URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

  // Pull the first present, non-empty value from a list of candidate keys.
  // NHC field names drift across seasons/advisory formats, so every field is
  // read defensively through a small alias list rather than a single key.
  function pick(o, keys) {
    for (const k of keys) {
      if (o && o[k] != null && o[k] !== '') return o[k];
    }
    return null;
  }
  // Coerce a value (often a STRING in the NHC feed, e.g. "1003", "45") to a
  // finite number, or null if it isn't numeric. Never throws.
  function num(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  }

  // Normalize one raw activeStorms entry to
  //   { id, name, classification, intensity, pressureMb,
  //     latitudeNumeric, longitudeNumeric }
  // Any missing/renamed field degrades to null (never throws). Returns null if
  // the entry lacks a COMPLETE position (either lat or lon absent) — such an
  // entry cannot be matched or drawn, so it is dropped rather than kept
  // half-formed with a null coordinate.
  function normalizeStorm(s) {
    if (!s || typeof s !== 'object') return null;
    const lat = num(pick(s, ['latitudeNumeric', 'lat', 'latitude']));
    const lon = num(pick(s, ['longitudeNumeric', 'lon', 'longitude']));
    // Require BOTH coords: a half-position storm can neither be matched (500km
    // haversine) nor rendered (T7 draws NHC systems at their lat/lon, and a null
    // coord would break the draw), so drop it rather than keep it half-formed.
    if (lat == null || lon == null) return null;
    const intensity = num(pick(s, ['intensity', 'intensityKt', 'maxWindKt']));
    return {
      id: pick(s, ['id', 'stormId', 'binNumber']),
      name: pick(s, ['name', 'stormName', 'tcName']),
      classification: pick(s, ['classification', 'stormType', 'classificationAbbrev']),
      intensity: intensity,
      pressureMb: num(pick(s, ['pressure', 'pressureMb', 'minimumPressure', 'minSeaLevelPressure'])),
      latitudeNumeric: lat,
      longitudeNumeric: lon,
      // Authority-forced detection (2026-07-28, owner: Fausto invisible). The JTWC merge
      // (FS11) fixed the W-Pac Douglas-class miss — a few-hundred-km storm core slipping
      // between 36-deg tile centres — by seeding a detection at the OFFICIAL position, but
      // only for storms carrying forced:true, which src/jtwc.js alone set. Result: two live
      // NHC hurricanes (Fausto 75kt/984mb, Genevieve 135kt/929mb) drew NOTHING because their
      // nearest tile centre sampled fair weather ~2,000 km from the eye. NHC storms now
      // carry the same flag and a gustKmh derived from sustained intensity (kt -> km/h; the
      // same sustained-as-gust fallback jtwc.js uses when no gust is reported) so
      // gateway.detectCyclones can run its OWN tier scale over authority numbers. Honesty
      // rules are the gateway's, unchanged: sub-hurricane systems inject nothing unless
      // their own numbers reach CYCLONE, and a stronger local sample is never downgraded.
      source: 'nhc',
      gustKmh: intensity == null ? null : intensity * 1.852,
      forced: true,
    };
  }

  // Parse a raw CurrentStorms.json body into the normalized list. Tolerates a
  // missing/absent/non-array activeStorms (=> []) and drops unusable entries.
  function parse(json) {
    const arr = json && Array.isArray(json.activeStorms) ? json.activeStorms : null;
    if (!arr) return [];
    const out = [];
    for (const s of arr) {
      const n = normalizeStorm(s);
      if (n) out.push(n);
    }
    return out;
  }

  // Transcode a storm NAME to ZX81 character codes, capped at 10 chars — the
  // trailer's nameLen budget (design §C.5). Uses report.js zxCode SEMANTICS,
  // reimplemented self-contained so nhc.js has no cross-module dependency:
  //   A-Z -> 38..63, 0-9 -> 28..37, everything else DROPPED (not throwing —
  // an odd character in a feed name must not blank the whole wall). Uppercase.
  // T7/T9 may instead carry the raw .name and transcode there; this helper is
  // provided so either side can do it with identical semantics.
  function nameToZX(name, cap) {
    const max = cap == null ? 10 : cap;
    const out = [];
    const s = String(name == null ? '' : name).toUpperCase();
    for (const ch of s) {
      if (out.length >= max) break;
      if (ch >= '0' && ch <= '9') out.push(28 + (ch.charCodeAt(0) - 48));
      else if (ch >= 'A' && ch <= 'Z') out.push(38 + (ch.charCodeAt(0) - 65));
      // else: dropped
    }
    return out;
  }

  // GET CurrentStorms.json and return the normalized list. fetchImpl is
  // injectable (proofs stub it) and defaults to the platform global fetch.
  // NEVER throws: every failure path is caught and yields [].
  async function fetchNhcStorms(fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return [];
    try {
      const res = await f(URL);
      if (!res || !res.ok) return [];
      let json;
      try { json = await res.json(); } catch (_) { return []; }
      return parse(json);
    } catch (_) {
      return [];
    }
  }

  const NHC = { URL, pick, num, normalizeStorm, parse, nameToZX, fetchNhcStorms };
  g.WW_NHC = NHC;
  if (typeof module !== 'undefined' && module.exports) module.exports = NHC;
})(typeof window !== 'undefined' ? window : globalThis);
