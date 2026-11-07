// marine.js — Open-Meteo *Marine* API fetch for the ocean sea-state layer.
//
// The Marine API (marine-api.open-meteo.com) is a SEPARATE endpoint with its OWN
// free daily quota, distinct from the forecast API. We call it ONLY for the sea
// tiles' centre coordinates, batched as ONE request (comma-separated lat/lon), so
// a 5-min refresh over ~sea-tile-count coords stays trivially inside the free
// tier. On failure the sea layer degrades to ABSENT (waveHeight:null on every
// sea tile) — absent data is never presented as calm. ABSENT ≠ CALM.
// Dual module (Node 18+/browser both have global fetch).
(function (g) {
  'use strict';
  const BASE = 'https://marine-api.open-meteo.com/v1/marine';

  // The marine wave grid ends around 78–80°S: tile centres south of that
  // (Antarctic interior / ice-shelf rows at −81°) poison a whole BATCHED request
  // with HTTP 400 "No data is available for this location". lat +81 (Arctic) IS
  // covered and returns real wave heights. Callers must filter coords through
  // inCoverage() BEFORE batching; excluded tiles get waveHeight:null (absent).
  const COVERAGE_MIN_LAT = -80;
  function inCoverage(c) { return c.lat > COVERAGE_MIN_LAT; }

  // splitCoverage(coords) — shared (Node + browser) pre-batch filter: peel off
  // out-of-coverage coords, and re-expand the response back to the ORIGINAL
  // alignment (excluded slots come back as waveHeight:null — ABSENT, not calm).
  // expand() REQUIRES results.length === fetchCoords.length: positionally
  // shifting wave data onto the wrong tiles is the worst failure class, so a
  // mismatch throws loudly (err.slug 'length-mismatch') instead of shifting.
  function splitCoverage(coords) {
    const covered = coords.map(inCoverage);
    const fetchCoords = coords.filter((_, k) => covered[k]);
    return {
      covered,
      fetchCoords,
      expand(results) {
        if (!Array.isArray(results) || results.length !== fetchCoords.length) {
          const err = new Error('marine results length ' + (Array.isArray(results) ? results.length : 'none') +
            ' != ' + fetchCoords.length + ' fetched coords — refusing positional shift');
          err.slug = 'length-mismatch';
          throw err;
        }
        let j = 0;
        return covered.map((ok) => (ok ? results[j++] : { waveHeight: null, swellHeight: null, windWaveHeight: null }));
      },
    };
  }

  // Shorten a batched-coord URL for logging: keep the endpoint + a prefix of the
  // coord lists, note how much was cut and how many coords the batch carried.
  function truncUrl(url, nCoords, max) {
    const cap = max || 200;
    if (url.length <= cap) return url;
    return url.slice(0, cap) + `…(+${url.length - cap} chars, ${nCoords} coords)`;
  }

  // coords: [{lat, lon}, ...] -> one batched URL. wave_height is the significant
  // wave height (combined sea+swell); swell/wind-wave requested for completeness.
  // The hourly block (2026-07-16) adds the last 48h of wave_height/swell so the SEA
  // page can replay a REAL 12/24/48h sea-state time-lapse (it was current-only, so
  // SEA honest-degraded to a still sheet — the frozen-sea QC). Same batched marine
  // call, no extra request. DR-19: request-shape only (exercised via fixtures).
  function buildUrl(coords) {
    const lats = coords.map(c => c.lat.toFixed(3)).join(',');
    const lons = coords.map(c => c.lon.toFixed(3)).join(',');
    return `${BASE}?latitude=${encodeURIComponent(lats)}&longitude=${encodeURIComponent(lons)}` +
      `&current=wave_height,swell_wave_height,wind_wave_height,wave_direction,wave_period` +
      `&hourly=wave_height,swell_wave_height,wave_direction,wave_period&past_days=2&forecast_days=1&timeformat=unixtime`;
  }

  // Normalise to [{waveHeight, swellHeight, windWaveHeight}, ...]. The marine API
  // returns null for a coordinate with no data for that tile (e.g. inland, or an
  // in-grid gap) — we preserve that as waveHeight:null. null means ABSENT data;
  // it is never coerced to 0 (which would fabricate a calm sea).
  // When the response carries hourly history, each record also gets waveHist/swellHist:
  // the last <=48 PAST hours (newest-last; future forecast hours cut at nowMs), mirroring
  // src/weather.js. This is what the SEA tape-loop replays — real readings, never
  // synthesized in-between values. A tile with no hourly (out of coverage) keeps just the
  // current value and the SEA loop freezes it honestly.
  function parse(json, nowMs) {
    const arr = Array.isArray(json) ? json : [json];
    const now = nowMs == null ? Date.now() : nowMs;
    return arr.map(o => {
      const cur = o && o.current ? o.current : {};
      const num = (v) => (typeof v === 'number' ? v : null);
      const rec = {
        waveHeight: num(cur.wave_height),
        swellHeight: num(cur.swell_wave_height),
        windWaveHeight: num(cur.wind_wave_height),
        // 2026-07-31 (SEA field option C): true swell direction (deg, waves come
        // FROM, like wind) + period (s) so the crest texture can ride real physics.
        waveDir: num(cur.wave_direction),
        wavePeriod: num(cur.wave_period),
      };
      const hr = o && o.hourly ? o.hourly : null;
      if (hr && Array.isArray(hr.time)) {
        const nowS = Math.floor(now / 1000);
        let cut = -1;
        for (let i = 0; i < hr.time.length; i++) if (hr.time[i] <= nowS) cut = i;
        if (cut >= 0) {
          const s = Math.max(0, cut - 47);
          rec.waveHist = (hr.wave_height || []).slice(s, cut + 1);
          rec.swellHist = (hr.swell_wave_height || []).slice(s, cut + 1);
          rec.waveDirHist = (hr.wave_direction || []).slice(s, cut + 1);
          rec.wavePeriodHist = (hr.wave_period || []).slice(s, cut + 1);
        }
      }
      return rec;
    });
  }

  async function fetchMarine(coords, fetchImpl, opts) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('no fetch available');
    if (!coords.length) return [];
    const url = buildUrl(coords);
    const res = await f(url);
    if (!res.ok) {
      // Log the failing URL + status + API reason BEFORE throwing, so a batch
      // 400 is diagnosable from the logs instead of silently degrading.
      let body = '';
      try { body = await res.text(); } catch (_) { /* body unavailable */ }
      let reason = '';
      try { reason = String(JSON.parse(body).reason || ''); } catch (_) { reason = String(body || '').slice(0, 160); }
      console.error(`marine: HTTP ${res.status} for ${truncUrl(url, coords.length)}` +
        (reason ? ` — reason: ${reason}` : ''));
      const err = new Error('marine HTTP ' + res.status + (reason ? ' (' + reason + ')' : ''));
      err.status = res.status;
      err.slug = 'http-' + res.status; // short label-safe reason, e.g. "http-400"
      err.reason = reason;
      throw err;
    }
    return parse(await res.json(), opts && opts.now ? opts.now() : Date.now());
  }

  const M = { BASE, COVERAGE_MIN_LAT, inCoverage, splitCoverage, truncUrl, buildUrl, parse, fetchMarine };
  g.WW_MARINE = M;
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
})(typeof window !== 'undefined' ? window : globalThis);
