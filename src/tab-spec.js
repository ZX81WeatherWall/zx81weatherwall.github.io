// tab-spec.js — the GOVERNING SPEC for every visual tab of the ZX81 Weather Wall.
//
// SINGLE SOURCE OF TRUTH. owner's directive (2026-07-15): the visuals kept regressing
// (marks collapse to ~9 worldwide, land goes invisible, terminator freezes on all
// tabs but SATELLITE) because each fix was an ad-hoc per-tab model guess, eyeballed
// on ONE tab, with no spec and no test. This module replaces that with:
//   (a) TAB_SPEC — a declarative object: per tab (TEMP/WEATHER/WIND/SEA/PRESSURE/
//       SATELLITE) the explicit deterministic rules for land treatment, field hatch
//       density, terminator {show,animate}, mark selection, and label density.
//   (b) A small set of PURE deterministic selector functions — the terminator's
//       clock-based sub-solar model, and the WEATHER summary mark selector — so the
//       behaviour is inspectable, testable, and changed in ONE place, not re-guessed
//       per fix. Both web/app.js (browser) and the node visual-regression test
//       require this module; the spec is the contract the gate asserts against.
//
// Dual module: usable in Node (require('./tab-spec')) and the browser (WW_TABSPEC).
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;

  // Page ids (mirror L.PAGE so callers can key the spec by the same id the wire uses).
  const PAGE = L.PAGE;   // { TEMP:0, WEATHER:1, WIND:2, SEA:3, RADAR:4, PRESSURE:5, SATELLITE:6 }

  // ---------------------------------------------------------------------------
  // LAND treatment vocabulary (how each tab draws continents):
  //   'coastline-outline' — a 1-cell-thick native inverse coast edge only; land is
  //       LOCATABLE but never a heavy dark fill that competes with the data field.
  //   'clouds'            — the satellite cloud raster, WITH the coastline outline
  //       punched through it (SATELLITE only).
  //   'quiet-silhouette'  — a faint land hatch, quieter than the data marks (reserved;
  //       not currently assigned — kept in the vocabulary so a future tab can pick it).
  // owner: "coastlines are fine now, keep them." NO heavy dark land-fill anywhere.
  const LAND = { OUTLINE: 'coastline-outline', CLOUDS: 'clouds', QUIET: 'quiet-silhouette' };

  // FIELD hatch density — how busy the background texture / contour field may get, so
  // isolines and H/L stay readable (never a wall-to-wall noise field). Ordinal.
  const HATCH = { NONE: 0, LIGHT: 1, MEDIUM: 2 };

  // LABEL density (numeric cell labels) — a sparse readable grid, never a number in
  // all 100 tiles.
  //   'sparse-grid' — notable / gridded cells only (TEMP numbers).
  //   'hl-centres'  — only synoptic H/L centres carry a value (PRESSURE).
  //   'none'        — no numeric labels.
  const LABELS = { SPARSE: 'sparse-grid', HL: 'hl-centres', NONE: 'none' };

  // ---------------------------------------------------------------------------
  // THE DECLARATIVE SPEC. One entry per tab. Everything a tab does visually that has
  // regressed is stated here, once.
  const TAB_SPEC = {
    TEMP: {
      page: PAGE.TEMP,
      land: LAND.OUTLINE,
      hatch: HATCH.LIGHT,          // isotherm strokes, sparse
      terminator: { show: true, animate: true },   // sweeps with the clock
      marks: 'none',
      labels: LABELS.SPARSE,
    },
    WEATHER: {
      page: PAGE.WEATHER,
      land: LAND.OUTLINE,
      hatch: HATCH.NONE,           // marks carry this page; no competing field hatch
      terminator: { show: true, animate: true },
      marks: 'summary',            // the deterministic world summary (see WEATHER_MARKS)
      labels: LABELS.NONE,
    },
    WIND: {
      page: PAGE.WIND,
      land: LAND.OUTLINE,
      hatch: HATCH.LIGHT,          // flow chevrons
      terminator: { show: true, animate: true },
      marks: 'none',
      labels: LABELS.NONE,
    },
    SEA: {
      page: PAGE.SEA,
      land: LAND.OUTLINE,
      hatch: HATCH.MEDIUM,         // rolling swell crest lines
      terminator: { show: true, animate: true },
      marks: 'none',
      labels: LABELS.NONE,
    },
    PRESSURE: {
      page: PAGE.PRESSURE,
      land: LAND.OUTLINE,
      hatch: HATCH.LIGHT,          // isobars
      terminator: { show: true, animate: true },
      marks: 'none',
      labels: LABELS.HL,           // H / L at synoptic centres only
    },
    SATELLITE: {
      page: PAGE.SATELLITE,
      land: LAND.CLOUDS,           // clouds + coastline outline punched through
      hatch: HATCH.NONE,
      terminator: { show: true, animate: true },   // the day/night sweep lives here too
      labels: LABELS.NONE,
      marks: 'none',
    },
  };

  // Tabs the coastline outline MUST be locatable on (the visual-regression gate asserts
  // coast pixels here). SATELLITE draws clouds but still punches the coast outline.
  const COASTLINE_TABS = ['TEMP', 'WEATHER', 'WIND', 'SEA', 'PRESSURE', 'SATELLITE'];

  // Look up a spec entry by page id (the wire/byte id) or by name.
  function specForPage(pageId) {
    for (const k in TAB_SPEC) if (TAB_SPEC[k].page === pageId) return TAB_SPEC[k];
    return null;
  }
  function specForName(name) { return TAB_SPEC[name] || null; }

  // ===========================================================================
  // TERMINATOR — ONE shared clock-based sub-solar model (15 deg / hour), used
  // IDENTICALLY by every tab where spec.terminator.show is true. Position is a
  // deterministic function of a timestamp; NOT satellite-only, NOT frozen.
  //
  // Sub-solar longitude: the sun is overhead at local solar noon; at UTC hour h the
  // sub-solar meridian is (12 - h) * 15 degrees east. So it marches WEST as time
  // advances (h up -> lon down) at exactly 15 deg/hour. Wrapped to (-180, 180].
  const DEG = Math.PI / 180;
  function subSolarLonDeg(epochMs) {
    const d = new Date(epochMs);
    const utcH = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    let lon = -15 * (utcH - 12);
    lon = ((lon + 180) % 360 + 360) % 360 - 180;   // wrap to (-180,180]
    return lon;
  }
  // Solar declination (deg) — the seasonal tilt; small, but the model carries it so the
  // boundary curves correctly. Cosine-of-day-of-year approximation.
  function solarDeclDeg(epochMs) {
    const d = new Date(epochMs);
    const yStart = Date.UTC(d.getUTCFullYear(), 0, 0);
    const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - yStart) / 86400000;
    return -23.44 * Math.cos((2 * Math.PI / 365) * (doy + 10));
  }
  // Full geometry bundle (matches web/app.js computeNightGeom): the values a per-cell
  // night test needs. subLon in RADIANS to match the render math.
  function nightGeom(epochMs) {
    const decl = solarDeclDeg(epochMs) * DEG;
    return { sinD: Math.sin(decl), cosD: Math.cos(decl), subLon: subSolarLonDeg(epochMs) * DEG };
  }
  // Is the point (lonDeg,latDeg) on the NIGHT side at this instant? Shared predicate.
  function isNight(lonDeg, latDeg, geom) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    return geom.sinD * Math.sin(lat) + geom.cosD * Math.cos(lat) * Math.cos(lon - geom.subLon) < 0;
  }
  // The two terminator boundary COLUMNS at the equator, in wall pixels [0,width).
  // At the equator (lat=0) night is where cos(lon - subLon) < 0, i.e. the boundary
  // meridians are subLon +/- 90 deg. Returned sorted; used by the gate to prove the
  // boundary SHIFTED by the expected deterministic amount between T and T+dt (and that
  // every show=true tab yields the IDENTICAL columns — one model, not per-tab).
  function terminatorColsAtEquator(epochMs, width) {
    const s = subSolarLonDeg(epochMs);
    const cols = [s + 90, s - 90].map((lon) => {
      const w = ((lon + 180) % 360 + 360) % 360 / 360 * width;   // lon->col, wrapped
      return Math.round(w) % width;
    });
    return cols.sort((a, b) => a - b);
  }
  // Expected westward pixel shift of the terminator over dtMs (deterministic, 15deg/h).
  function terminatorShiftPx(dtMs, width) {
    const degShift = -15 * (dtMs / 3600000);          // negative = westward
    return degShift / 360 * width;                    // pixels (signed)
  }
  // How many marching night-mask frames a live sweep uses (one full 360deg wrap over
  // the motion cycle, so the terminator creeps steadily westward and loops seamlessly).
  const TERM_SWEEP_FRAMES = 24;
  // Sub-solar longitude (RADIANS) for sweep frame f of nf: the base longitude stepped a
  // fraction of a full turn WEST (advancing time -> decreasing subLon), matching the
  // satellite path. f=0 is the real wall-clock position.
  function subLonForFrame(baseSubLonRad, f, nf) {
    return baseSubLonRad - (f / (nf || TERM_SWEEP_FRAMES)) * 2 * Math.PI;
  }

  // TEMP LABEL density — a sparse READABLE grid, never a number in all 100 tiles.
  // Deterministic: a label rides tiles on an even row/col lattice (25 of 100), so the
  // reader sees a legible scatter of readings, not wall-to-wall digits. Pure predicate.
  const LABEL_STRIDE = 2;
  function tempLabelForTile(row, col) {
    return (row % LABEL_STRIDE === 0) && (col % LABEL_STRIDE === 0);
  }

  // ===========================================================================
  // WEATHER SUMMARY MARKS — deterministic per-CATEGORY selection with COUNTS,
  // a global FLOOR, and a global CAP. owner: "9 total marks worldwide is absurd."
  //
  // The selector takes a flat list of candidate SYSTEMS (each already normalized to
  // {category, magnitude, lon, lat, tile, label}) and returns the marks the WEATHER
  // summary surfaces: for each category, the strongest `count` by magnitude, stable-
  // sorted, tie-broken by (lon,lat) so the choice is reproducible. FIRE is hard-capped
  // (fire must never dominate). The union is then bounded by CAP_TOTAL. There is NO
  // fuzzy "importance top-16" anywhere.
  //
  // Categories + counts are tuned so a real world state lands a RICH summary: floor
  // >= 24 marks spanning >= 5 categories, but bounded (<= 40) and never a single-
  // category wall.
  const MARK_CAT = {
    CYCLONE: 'CYCLONE',   // tropical/extratropical spirals
    LOW:     'LOW',       // deep synoptic lows
    HIGH:    'HIGH',      // strong synoptic highs
    PRECIP:  'PRECIP',    // heavy precipitation
    HEAT:    'HEAT',      // hottest inhabited
    COLD:    'COLD',      // coldest inhabited
    WIND:    'WIND',      // strongest sustained wind
    FIRE:    'FIRE',      // largest active fires (CAPPED)
    ALERT:   'ALERT',     // severe / authority alert markers (tornado/tsunami/evac/flood)
  };
  // Per-category cap on how many marks that category may contribute. Sum of caps is the
  // theoretical max; a real state fills what it has. FIRE=4 is the hard "never dominate"
  // cap owner asked for.
  const CATEGORY_CAPS = {
    CYCLONE: 8,   // ALL cyclones, capped so a busy basin can't wall the map
    LOW:     6,   // N deepest lows
    HIGH:    5,   // N strongest highs
    PRECIP:  6,   // top-K heavy precip
    HEAT:    3,   // hottest inhabited
    COLD:    3,   // coldest inhabited
    WIND:    5,   // top-K strong wind
    FIRE:    4,   // top-K largest fires — HARD cap, fire never dominates
    ALERT:   8,   // severe / alert markers
  };
  const FLOOR_TOTAL = 24;    // the summary must surface at least this many marks...
  const CAP_TOTAL = 40;      // ...and never more than this (bounded, legible).
  const MIN_CATEGORIES = 5;  // ...spanning at least this many distinct categories.
  const FIRE_CAP = 4;        // explicit fire ceiling (== CATEGORY_CAPS.FIRE).

  // Deterministic stable rank: magnitude DESC, then lon ASC, then lat ASC, then tile.
  function rankSystems(a, b) {
    if (b.magnitude !== a.magnitude) return b.magnitude - a.magnitude;
    if (a.lon !== b.lon) return a.lon - b.lon;
    if (a.lat !== b.lat) return a.lat - b.lat;
    return (a.tile | 0) - (b.tile | 0);
  }

  // selectWeatherMarks(systems) -> { marks, byCategory, categories, count }
  //   systems: [{category, magnitude, lon, lat, tile, label}]
  // Pure and deterministic: same input -> identical output (order included).
  function selectWeatherMarks(systems, opts) {
    opts = opts || {};
    const caps = Object.assign({}, CATEGORY_CAPS, opts.caps || {});
    const capTotal = opts.capTotal || CAP_TOTAL;
    // bucket by category
    const buckets = {};
    for (const s of (systems || [])) {
      if (!s || s.category == null || s.magnitude == null) continue;
      (buckets[s.category] || (buckets[s.category] = [])).push(s);
    }
    // per-category: rank, then take up to the cap
    const byCategory = {};
    let picked = [];
    for (const cat in buckets) {
      const cap = caps[cat] != null ? caps[cat] : 4;
      const chosen = buckets[cat].slice().sort(rankSystems).slice(0, cap);
      byCategory[cat] = chosen;
      picked = picked.concat(chosen);
    }
    // global cap: if the union exceeds CAP_TOTAL, keep the globally-strongest, but do it
    // WITHOUT starving categories — round-robin strongest-first across categories so the
    // summary never collapses back to one wall. FIRE stays inside its own cap regardless.
    if (picked.length > capTotal) {
      const order = Object.keys(byCategory).sort();          // deterministic cat order
      const queues = {}; order.forEach((c) => (queues[c] = byCategory[c].slice()));
      const kept = [];
      let progressed = true;
      while (kept.length < capTotal && progressed) {
        progressed = false;
        for (const c of order) {
          if (queues[c].length && kept.length < capTotal) { kept.push(queues[c].shift()); progressed = true; }
        }
      }
      picked = kept;
    }
    // final deterministic order for rendering / hashing
    picked.sort((a, b) => {
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      return rankSystems(a, b);
    });
    const cats = {};
    for (const m of picked) cats[m.category] = true;
    return { marks: picked, byCategory, categories: Object.keys(cats).sort(), count: picked.length };
  }

  // Gate helper: does a selection satisfy the invariants? Returns {ok, reasons[]}.
  function validateSelection(sel) {
    const reasons = [];
    if (sel.count < FLOOR_TOTAL) reasons.push('below floor: ' + sel.count + ' < ' + FLOOR_TOTAL);
    if (sel.count > CAP_TOTAL) reasons.push('above cap: ' + sel.count + ' > ' + CAP_TOTAL);
    if (sel.categories.length < MIN_CATEGORIES) reasons.push('too few categories: ' + sel.categories.length + ' < ' + MIN_CATEGORIES);
    const fires = (sel.byCategory.FIRE || []).length;
    if (fires > FIRE_CAP) reasons.push('fire wall: ' + fires + ' > ' + FIRE_CAP);
    // no single category may be > half the marks (never a single-category wall)
    for (const c of sel.categories) {
      const n = (sel.byCategory[c] || []).filter((m) => sel.marks.indexOf(m) >= 0).length;
      if (sel.count > 0 && n > sel.count / 2) reasons.push('single-category wall: ' + c + ' = ' + n + '/' + sel.count);
    }
    return { ok: reasons.length === 0, reasons };
  }

  const API = {
    PAGE, LAND, HATCH, LABELS, TAB_SPEC, COASTLINE_TABS,
    MARK_CAT, CATEGORY_CAPS, FLOOR_TOTAL, CAP_TOTAL, MIN_CATEGORIES, FIRE_CAP,
    specForPage, specForName,
    // terminator model
    subSolarLonDeg, solarDeclDeg, nightGeom, isNight,
    terminatorColsAtEquator, terminatorShiftPx,
    TERM_SWEEP_FRAMES, subLonForFrame, LABEL_STRIDE, tempLabelForTile,
    // weather summary
    rankSystems, selectWeatherMarks, validateSelection,
  };
  g.WW_TABSPEC = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
