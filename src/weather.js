// weather.js — Open-Meteo batched fetch for the 100 tile centers. No API key
// (free, non-commercial). One batched call = comma-separated lat/lon lists, so
// a 60s refresh is ~1440 calls/day, well within the 10k/day allowance.
// Dual module (Node 18+/browser both have global fetch).
(function (g) {
  'use strict';
  const BASE = 'https://api.open-meteo.com/v1/forecast';

  // coords: [{lat, lon}, ...]  -> one batched URL. opts.history adds the last 48h
  // of hourly gusts/MSL-pressure/temperature/wind-speed (past_days=2) to the SAME
  // call — the iso-line tape-loop (gateway.contourFrames) re-derives the isotherm/
  // isobar/isotach bands at each sampled past hour from this SAME history, so the
  // animated contour shift costs ZERO extra API calls. timeformat=unixtime keeps
  // the "which hours are past" cut trivial. (DR-19 API freeze: this only changes
  // the request SHAPE — exercised via fixtures, never a live fetch.)
  function buildUrl(coords, opts) {
    const lats = coords.map(c => c.lat.toFixed(3)).join(',');
    const lons = coords.map(c => c.lon.toFixed(3)).join(',');
    // DENSE continental field (opts.dense): a lean snapshot request for the layers the
    // continental desks CONTOUR — temperature + wind + pressure — over a many-point shared
    // lattice (src/continental-grid.js). No daily/hourly blocks: the dense fetch is a live
    // field for the desk map, NOT the report's 48h history (which the sparse 100-centre call
    // still carries). Cost is the COORDINATE COUNT (Open-Meteo weights by locations), so the
    // lattice size is what's budgeted; the four current= fields ride free. Same retry/backoff
    // via fetchWeather. DR-19: request-shape only (fixture-exercised, never a live test fetch).
    // DENSITY-PLAN Option B (2026-07-23): the dense current= list is widened to the full
    // field suite — precipitation + cloud_cover (dense precip areas / cloud masses for the
    // later tab rollouts) and wind_gusts_10m (true eyewall gust gradient for the cyclone
    // chase). Open-Meteo weights by LOCATION, so all three ride the SAME batched call at
    // ZERO extra API cost; only the lattice size is budgeted. DR-19: request-shape only.
    if (opts && opts.dense)
      return `${BASE}?latitude=${encodeURIComponent(lats)}&longitude=${encodeURIComponent(lons)}` +
        `&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,precipitation,cloud_cover`;
    // weather_code (WMO) + wind + cyclone signature (gusts + MSL pressure) all in
    // the SAME batched call — Open-Meteo weights a request by locations, not
    // variables, so extra fields are free; the cost is the coordinate count.
    // apparent_temperature = Open-Meteo's server-side feels-like (Steadman-family:
    // temperature folded with humidity, wind and radiation). It is what backs the
    // MEASURED dangerous-heat detection (report.js aggregate2 heat list) — a lethal
    // heat dome over a city with no national CAP feed would otherwise go unremarked
    // beyond a bare "MAX 47C". relative_humidity_2m IS now requested (it was not
    // before): apparent_temperature is a Steadman feels-like, but the true
    // physiological heat-death limit is WET-BULB temperature (humid 35C is lethal
    // where dry 45C is survivable with water+shade), which the feels-like does not
    // isolate. We compute wet-bulb host-side from temperature_2m + relative_humidity_2m
    // via the Stull (2011) closed-form approximation (parse() below) and ship a
    // wet-bulb byte on the wire like apparent — no ZX81-side iteration. Open-Meteo
    // weights a request by LOCATIONS, not variables, so this rides the SAME batched
    // call at ZERO extra API cost — the 100-centre + <=32-scout/cycle budget (<=6336
    // forecast locations/day) is byte-unchanged (only the response is one field wider,
    // exactly like the apparent_temperature addition). DR-19: request-shape only.
    let url = `${BASE}?latitude=${encodeURIComponent(lats)}&longitude=${encodeURIComponent(lons)}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover` +
      // snowfall_sum = the DAY's total snowfall (cm), a 24h-scale accumulation. It backs the
      // MEASURED heavy/extreme snowfall detection (report.js aggregate2 snow list): a gazetteer
      // city buried under >=25cm/24h (HEAVY) / >=50cm (EXTREME) is an ALERT-class hazard a bare
      // "MIN -8C" would miss. daily is a SUM (current= only carries the preceding hour, far too
      // short for a 24h accumulation threshold), so it rides the daily block. snowfall_sum[0] =
      // today's GMT-day total (parse reads [0]); the GMT-day boundary is documented accepted
      // coarseness, not a defect. ZERO extra API cost: Open-Meteo weights a request by LOCATIONS,
      // not variables/blocks, so this rides the SAME batched call as apparent_temperature — the
      // 100-centre + <=32-scout/cycle budget (<=6336 forecast locations/day) is byte-unchanged
      // (only the response is one daily field wider). DR-19: request-shape only.
      //
      // temperature_2m_min = the GMT-day MINIMUM 2m air temperature (degC) — the overnight
      // low. It backs the MEASURED hot-night ("tropical night") detection (report.js aggregate2
      // hotNight scan): the single biggest driver of heatwave death is a night that never cools
      // (the body cannot recover overnight and the elderly die in their sleep), which the
      // daytime feels-like peak alone MISSES. WMO tropical night = overnight min >=20C; a
      // sweltering night >=25C is severe and >=30C is lethal for temperate populations. Rides
      // the SAME batched daily block as snowfall_sum at ZERO extra API cost (Open-Meteo weights
      // by LOCATIONS, not variables). [0] = today's GMT-day min (parse reads [0]); the GMT-day
      // boundary is the SAME documented accepted coarseness as snowfall_sum. DR-19: request-shape only.
      `&daily=snowfall_sum,temperature_2m_min`;
    if (opts && opts.history)
      // cloud_cover added to the hourly block (2026-07-16): the SATELLITE loop needs a
      // real per-tile cloud history to advect over the 12/24/48h replay (it was current-
      // only, so clouds could only shimmer, never move). Same batched call, ZERO extra API
      // cost (Open-Meteo weights by locations, not variables). DR-19: request-shape only.
      // wind_direction_10m + precipitation + weather_code added 2026-07-28 (owner: smoke
      // drift over a 12/24/48h loop). Direction history is what lets the FIRE-page smoke
      // loop re-run the plume with each hour's REAL wind vector (speed history alone
      // cannot orient a plume), and precipitation/weather_code close the known glyph gap
      // in backfilled loop frames. Same batched call, ZERO extra API cost (Open-Meteo
      // weights by locations, not variables). DR-19: request-shape only.
      url += `&hourly=wind_gusts_10m,pressure_msl,temperature_2m,wind_speed_10m,cloud_cover,wind_direction_10m,precipitation,weather_code&past_days=2&forecast_days=1&timeformat=unixtime`;
    return url;
  }

  // Stull (2011) closed-form wet-bulb approximation from dry-bulb T (degC) and
  // relative humidity RH (%). Standard reference formula (Stull, J. Appl. Meteorol.
  // Climatol. 50:2267) — accurate to ~0.3C over RH 5-99% / T -20..50C, which fully
  // covers the humid-heat danger band (wet-bulb 31-35C). No iteration: it is a single
  // algebraic expression, so it runs host-side and the ZX81 only ever sees the byte.
  // Returns null when either input is absent (never fabricates a wet-bulb).
  function wetBulbStull(T, RH) {
    if (typeof T !== 'number' || typeof RH !== 'number') return null;
    const rh = RH < 0 ? 0 : RH > 100 ? 100 : RH;   // clamp to the formula's domain
    return T * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
      Math.atan(T + rh) - Math.atan(rh - 1.676331) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
  }

  // Open-Meteo returns an ARRAY of location objects for multi-location requests
  // (a single object for one location). Normalise to
  // [{tempC, apparentC, wetBulbC, precipMm, weatherCode, windKmh, gustKmh, pressureHpa}, ...].
  // gustKmh/pressureHpa are null when the field is absent, so cyclone detection
  // degrades to "no marker" rather than a false positive. When the response
  // carries hourly history (opts.history), each record also gets gustHist/
  // pressHist/tempHist/windHist: the last <=48 PAST hours (newest-last; future
  // forecast hours are cut off at `nowMs`), so the iso-line tape-loop never plots
  // a contour through hours that haven't happened yet.
  function parse(json, nowMs) {
    const arr = Array.isArray(json) ? json : [json];
    const now = nowMs == null ? Date.now() : nowMs;
    return arr.map(o => {
      const cur = o && o.current ? o.current : {};
      const t = typeof cur.temperature_2m === 'number' ? cur.temperature_2m : null;
      const at = typeof cur.apparent_temperature === 'number' ? cur.apparent_temperature : null;   // feels-like (null when absent → no heat claim)
      // wet-bulb (Stull) — humid-heat lethality; null when temp or humidity absent → no humid-heat claim
      const rh = typeof cur.relative_humidity_2m === 'number' ? cur.relative_humidity_2m : null;
      const wb = (t != null && rh != null) ? wetBulbStull(t, rh) : null;
      const p = typeof cur.precipitation === 'number' ? cur.precipitation : 0;
      const wc = typeof cur.weather_code === 'number' ? cur.weather_code : 0;
      const wk = typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : 0;
      const wd = typeof cur.wind_direction_10m === 'number' ? cur.wind_direction_10m : 0;
      const g = typeof cur.wind_gusts_10m === 'number' ? cur.wind_gusts_10m : null;
      const pr = typeof cur.pressure_msl === 'number' ? cur.pressure_msl : null;
      const cc = typeof cur.cloud_cover === 'number' ? cur.cloud_cover : null;   // SATELLITE page (FS7-T5); null when absent
      // daily snowfall_sum[0] = today's total snowfall (cm); null when absent → no snow claim
      // (an absent reading NEVER fabricates a snowstorm, same discipline as apparent/gust).
      const day = o && o.daily ? o.daily : null;
      const sf = day && Array.isArray(day.snowfall_sum) && typeof day.snowfall_sum[0] === 'number' ? day.snowfall_sum[0] : null;
      // daily temperature_2m_min[0] = today's overnight low (degC); null when absent → no
      // hot-night claim (an absent reading NEVER fabricates a tropical night, same discipline
      // as apparent/wet-bulb/snow).
      const nm = day && Array.isArray(day.temperature_2m_min) && typeof day.temperature_2m_min[0] === 'number' ? day.temperature_2m_min[0] : null;
      const rec = { tempC: t, apparentC: at, wetBulbC: wb, precipMm: p, weatherCode: wc, windKmh: wk, windDir: wd, gustKmh: g, pressureHpa: pr, cloudCoverPct: cc, snowfallCm: sf, minTempC: nm };
      const hr = o && o.hourly ? o.hourly : null;
      if (hr && Array.isArray(hr.time)) {
        // cut = index of the last PAST hour (unixtime seconds <= now); slice the
        // trailing <=48 hours so the tape-loop replays only hours that happened.
        const nowS = Math.floor(now / 1000);
        let cut = -1;
        for (let i = 0; i < hr.time.length; i++) if (hr.time[i] <= nowS) cut = i;
        if (cut >= 0) {
          const s = Math.max(0, cut - 47);
          rec.gustHist = (hr.wind_gusts_10m || []).slice(s, cut + 1);
          rec.pressHist = (hr.pressure_msl || []).slice(s, cut + 1);
          rec.tempHist = (hr.temperature_2m || []).slice(s, cut + 1);
          rec.windHist = (hr.wind_speed_10m || []).slice(s, cut + 1);
          rec.cloudHist = (hr.cloud_cover || []).slice(s, cut + 1);   // SATELLITE loop advection
          rec.windDirHist = (hr.wind_direction_10m || []).slice(s, cut + 1);  // FIRE smoke-loop plume orientation
          rec.precipHist = (hr.precipitation || []).slice(s, cut + 1);        // backfilled-frame precip layer
          rec.codeHist = (hr.weather_code || []).slice(s, cut + 1);           // backfilled-frame weather glyphs
        }
      }
      return rec;
    });
  }

  // Transient upstream failures worth a retry: rate-limit + the 5xx family
  // Open-Meteo returns when its forecast endpoint is momentarily overloaded (the
  // top-of-hour thundering-herd 503 that darked the live feed on 2026-07-14 —
  // every scheduler cycle fires at HH:00:00 and hit an overloaded server, while
  // off-cycle requests seconds later returned 200). A network throw (DNS/TCP
  // blip) is transient too. A 4xx OTHER than 429 (e.g. 400 bad-request) is a
  // permanent client error — do NOT retry it.
  function transientStatus(s) { return s === 429 || (s >= 500 && s <= 599); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function fetchWeather(coords, fetchImpl, opts) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('no fetch available');
    const url = buildUrl(coords, opts);
    const env = (g.process && g.process.env) || {};
    const nap = (opts && opts.sleep) || sleep;
    const now = (opts && opts.now) || (() => Date.now());
    // TIME-BUDGETED retry with jittered exponential backoff. The old schedule was 3
    // attempts in ~1.3s — but Open-Meteo's top-of-hour 503 overload (every scheduler
    // cycle fires at HH:00:00 into a thundering herd) persists for TENS OF SECONDS, so
    // all 3 tries rode inside the same dead window and the whole cycle synthesised
    // (2026-07-14: forecast was synthetic 08:00Z-14:00Z, 7 hours straight). Now we keep
    // retrying until a wall-clock BUDGET elapses (default ~75s, ZWX_FETCH_BUDGET_MS /
    // opts.budgetMs) so the fetch OUTLASTS the burst instead of giving up inside it.
    // Backoff grows 1,2,4,8,10s (capped) with a per-attempt desync jitter to spread off
    // the herd. opts.retries / ZWX_FETCH_RETRIES still cap the ATTEMPT COUNT (tests inject
    // a small count + opts.sleep to run instantly); opts.now injects a virtual clock.
    const budgetMs = opts && opts.budgetMs != null ? +opts.budgetMs : (+env.ZWX_FETCH_BUDGET_MS || 75000);
    const cap = +(opts && opts.retries) || +env.ZWX_FETCH_RETRIES || 0; // 0 = uncapped, ride the budget
    const maxAttempts = cap > 0 ? cap : Infinity;
    const t0 = now();
    let lastErr, attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await f(url);
        if (res.ok) return parse(await res.json());
        lastErr = new Error('open-meteo HTTP ' + res.status);
        if (!transientStatus(res.status)) throw lastErr; // permanent (e.g. 400) — fail fast
      } catch (e) {
        lastErr = e;
        if (e && /HTTP (4[0-9]{2})/.test(e.message) && !/HTTP 429/.test(e.message)) throw e; // permanent 4xx
      }
      if (attempt >= maxAttempts) break;                 // count cap (tests)
      const base = Math.min(10000, 1000 * Math.pow(2, Math.min(attempt - 1, 4))); // 1,2,4,8,10s
      const wait = base + (attempt * 271 % 1000);        // + up to ~1s desync jitter
      if (now() - t0 + wait >= budgetMs) break;          // next nap would blow the budget — stop
      await nap(wait);
    }
    throw lastErr;
  }

  const W = { BASE, buildUrl, parse, fetchWeather };
  g.WW_WEATHER = W;
  if (typeof module !== 'undefined' && module.exports) module.exports = W;
})(typeof window !== 'undefined' ? window : globalThis);
