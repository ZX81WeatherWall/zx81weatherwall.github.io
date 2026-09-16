// app.js — main-thread controller for the ZX81 Weather Wall.
//  * builds the 10x10 canvas grid + legend
//  * fetches the clone template once
//  * spawns a pool of Web Workers (each a duty-cycled ZX81 burst-renderer)
//  * every REFRESH_MS: reads the scheduler-owned weather snapshot, then fans 100
//    tile-paint jobs across the workers and blits each returned ZX81 screen.
//
// Browser authority rule: the browser must NEVER call Open-Meteo or other live
// weather providers directly. All provider access is gated through the scheduler,
// which writes data/weather-fixture.json / data/marine-fixture.json.
'use strict';
(function () {
  const L = window.WW_LAYOUT;
  const CG = window.WW_CORNERGRID;  // shared tile-corner grid builder (contour continuity)
  const coast = window.WW_COASTLINE;
  const GW = window.WW_GATEWAY;
  const SPEC = window.WW_TABSPEC;   // governing tab spec (land/hatch/terminator/marks/labels)
  const NHC = window.WW_NHC;        // NHC naming feed (fetchNhcStorms/parse/nameToZX)
  const JTWC = window.WW_JTWC;      // JTWC W-Pac/Indian/S-Hemi authority feed (merged into the same storm list)
  const N = L.GRID;                 // 10

  // ---- FS2 demo mode ---------------------------------------------------------
  // ?demo=<name> drives the wall from data/<name>.json (weather + subSamples + an
  // embedded { nhc:{activeStorms:[…]} }) instead of the live network, so a wall can
  // show EVERY FS2 feature (tropical spiral+name+pressure, extratropical bold-L,
  // ordinary L/H) off a fixture. Bare ?demo defaults to the fs2-demo fixture. This
  // is a DISPLAY harness only — it makes zero API calls. See NOTES.md (FS2 / demo).
  const DEMO_FILE = (function () {
    try {
      const v = new URLSearchParams(location.search).get('demo');
      if (v == null) return null;
      return v === '' || v === '1' ? 'fs2-demo-fixture' : v.replace(/[^a-zA-Z0-9._-]/g, '');
    } catch (e) { return null; }
  })();
  // 30 min UI refresh. This no longer spends provider quota: the browser rereads
  // the scheduler-owned snapshot and re-renders the machines. Display-page cycling
  // and tape-loop replay also cost ZERO provider calls.
  const REFRESH_MS = 1800000;
  const POOL = Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
  const MOTION_MS = 360;   // motion tick: precip drift + cyclone spin (0 API calls)

  // ---- teletext pages (single-variable views) --------------------------------
  // TEMP | WEATHER | WIND | SEA | PRESSURE | SATELLITE, plus AUTO (rotate through
  // all six). FS7-T5: RADAR is RETIRED from the live UI (owner: replace it with the
  // SATELLITE cloud/terminator view); its render path stays intact but is no longer
  // in the rotation. A page flip costs ZERO API calls — it re-broadcasts the last
  // fetch as a new burst of re-coded frames (the page byte tells each machine which
  // routine to draw). AUTO period is set comfortably above the measured re-broadcast
  // + burst time (see NOTES.md). The chosen tab persists in localStorage.
  const PAGES = [L.PAGE.TEMP, L.PAGE.WEATHER, L.PAGE.FIRE, L.PAGE.WIND, L.PAGE.SEA, L.PAGE.PRESSURE, L.PAGE.SATELLITE];
  const AUTO_PERIOD_MS = 24000;   // ~24 s/view; ≫ ~1–2 s burst, wide margin
  // Open on TEMP, not SATELLITE: SATELLITE has NO tile-level tape loop (buildTracks
  // returns early for it — its only motion is the host cloud-drift overlay), so a
  // cold load on SATELLITE presents a FROZEN wall of static machines until the AUTO
  // rotation finally advances ~24 s later. TEMP carries the full per-tile 24 h
  // time-lapse, so the loop-within-loop reads as motion the instant data lands.
  let activePage = L.PAGE.TEMP;  // default view: strongest visible on-load inner loop

  let autoMode = true;            // AUTO on by default
  let autoTimer = 0;
  try {
    const sp = localStorage.getItem('zwx-page');
    const sa = localStorage.getItem('zwx-auto');
    if (sa === '0') autoMode = false;
    // Honor a persisted page only if it is still a reachable tab (a returning user
    // with the retired RADAR stored falls back to the default, not a stranded UI).
    if (sp != null && !isNaN(+sp) && PAGES.indexOf(+sp) >= 0) activePage = +sp;
  } catch (e) {}

  const $ = (id) => document.getElementById(id);
  const canvases = [];
  const ctxs = [];
  // per-tile animation frames (1 = static; >1 = precip drift loop, radar mode)
  const tileFrames = [];
  let motionPhase = 0;

  // ---- build the wall ----
  const wall = $('wall');
  for (let i = 0; i < N * N; i++) {
    const cell = document.createElement('div');
    cell.className = 'screen';
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 192;
    cell.appendChild(cv);
    wall.appendChild(cell);
    canvases.push(cv);
    ctxs.push(cv.getContext('2d'));
  }

  // FS8-F1 host contour-overlay canvas REMOVED (owner 2026-07-15): the wall must draw
  // NO host-side meteorological marks. Isobars/isotherms, the day/night terminator,
  // the satellite cloud field and SEA swell are all genuine ZX81-native machine cells
  // now (poked into the tiles; see worker.js applyNight/applyLines + the sat/sea/line
  // raster builders). There is no overlay canvas and no host draw path.

  // SATELLITE cloud engine (owner QC 2026-07-30: the still was "wobbling jello", the
  // loop "stipple blocks popping around the grid. Just pure nonsense"). The frozen
  // 2024 GIBS raster + sinusoid shimmer + per-tile band flips are all retired.
  // src/cloud-field.js supplies a deterministic rank-uniform noise TEXTURE; the two
  // quantities that govern it are REAL: per-tile cloud_cover (cloudHist) sets how
  // much of each tile is clouded, and per-tile wind (windHist/windDirHist) advects
  // the texture so cloud masses genuinely travel frame-to-frame. Named storms ride
  // the canonical agency track as a rotating comma/spiral cloud signature.
  //
  // The STILL page is genuinely STILL (owner QC 2026-07-30: "terminator and clouds
  // are moving in the still image instead of the terminator being at its actual
  // current clock location") — ONE frame, terminator at the real sub-solar
  // position, clouds where the current data puts them. Motion lives on the TRK
  // loop, where each frame is a real archived hour.
  const TAU = Math.PI * 2;
  let CLOUD_BASE = null;
  function cloudBase() {
    if (!CLOUD_BASE && window.WW_CLOUDFIELD)
      CLOUD_BASE = window.WW_CLOUDFIELD.buildBase(L.TILE_W * N, L.TILE_H * N);
    return CLOUD_BASE;
  }
  // Bilinear over per-TILE values at a continuous wall cell (tile centres are the
  // knots; x wraps at the date line, y clamps at the poles) — the same promotion
  // idea the corner grids use, so per-tile data varies smoothly across the wall.
  function tileBilin(vals, gx, gy) {
    const tx = gx / L.TILE_W - 0.5, ty = gy / L.TILE_H - 0.5;
    let x0 = Math.floor(tx); const fx = tx - x0;
    let y0 = Math.floor(ty); const fy = ty - y0;
    const y1 = Math.max(0, Math.min(N - 1, y0 + 1)); y0 = Math.max(0, Math.min(N - 1, y0));
    const xa = ((x0 % N) + N) % N, xb = (xa + 1) % N;
    const v = (x, y) => vals[y * N + x] || 0;
    return (v(xa, y0) * (1 - fx) + v(xb, y0) * fx) * (1 - fy)
         + (v(xa, y1) * (1 - fx) + v(xb, y1) * fx) * fy;
  }
  // Real 10m wind -> cloud drift in wall cells/hour. dir is meteorological (FROM);
  // screen y grows southward. Longitude cell size shrinks with latitude (clamped
  // near the poles so the drift never blows up).
  function windCellVec(spdKmh, dirDeg, row) {
    if (spdKmh == null || dirDeg == null || !isFinite(spdKmh) || !isFinite(dirDeg)) return [0, 0];
    const lat = (81 - 18 * row) * Math.PI / 180;
    const kmX = 125.23 * Math.max(0.2, Math.cos(lat));
    const kmY = 83.35;
    const rad = dirDeg * Math.PI / 180;
    return [(-Math.sin(rad) * spdKmh) / kmX, (Math.cos(rad) * spdKmh) / kmY];
  }
  // One global cloud-level raster (Uint8Array 320x240, 0 clear / 1 thin / 2 thick):
  // the advected texture thresholded by the real cover field, then each storm's
  // comma signature burned in at its canonical position. dxV/dyV are per-tile drift
  // grids (cells). `alt` cross-fades toward a second drift (alt.dxV/dyV, weight
  // alt.a): cells switch source in coherent patches, so the still sweep's wrap seam
  // dissolves frame N-1 back into frame 0 instead of popping.
  function cloudRaster(pctV, dxV, dyV, heads, phase, alt) {
    const CF = window.WW_CLOUDFIELD, base = cloudBase();
    if (!CF || !base) return null;
    const W = L.TILE_W * N, H = L.TILE_H * N, out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let dx = tileBilin(dxV, x, y), dy = tileBilin(dyV, x, y);
        if (alt && CF.sample(base, W, H, x * 1.7 + 811, y * 1.7 + 313) < alt.a) {
          dx += tileBilin(alt.dxV, x, y); dy += tileBilin(alt.dyV, x, y);
        }
        out[y * W + x] = CF.levelFor(CF.sample(base, W, H, x + dx, y + dy), tileBilin(pctV, x, y));
      }
    if (heads) for (const [tile, hd] of heads) {
      const cw = hd.cw || {};
      const gx = (tile % N) * L.TILE_W + hd.ex, gy = ((tile / N) | 0) * L.TILE_H + hd.ey;
      const r = (cw.cycloneTier | 0) >= L.CYC.MAJOR ? 12 : 9;
      CF.stampCyclone(out, W, H, gx, gy, r, !cw.cycloneSouth, phase);
    }
    return out;
  }
  // Slice one tile's display cells out of the global raster — INVERTED video (owner:
  // "the whole image should be inverted so clouds appear white against a dark
  // earth"): clear sky is solid ink with a sparse daylight sheen, thin cloud a grey
  // checker, thick cloud white; the 1-cell coastline rides as faint grey dots over
  // clear sky only (cloud hides the ground, as in a real frame); night blacks out
  // the sheen and dims cloud one step, so the terminator reads through the clouds.
  // The bottom tile row is the Antarctic ice sheet: bright, faintly textured (the
  // machine path flags the same zone via termByte bit5).
  function satInvCells(t, raster, night) {
    const col = t % N, row = (t / N) | 0, W = L.TILE_W * N;
    const cpt = L.TILE_W, rpt = L.TILE_H;
    const edge = coastEdgeMask();
    const cells = new Uint8Array(cpt * rpt);
    for (let cy = 0; cy < rpt; cy++)
      for (let cx = 0; cx < cpt; cx++) {
        const gx = col * cpt + cx, gy = row * rpt + cy, i = cy * cpt + cx;
        if (row === N - 1) { cells[i] = ((cx + cy) & 3) === 0 ? 0x08 : 0x00; continue; }
        const lvl = raster[gy * W + gx], nt = night && night[i];
        let v;
        if (lvl >= 2) v = nt ? 0x08 : 0x00;
        else if (lvl === 1) v = ((cx + cy) & (nt ? 3 : 1)) === 0 ? 0x08 : 0x80;
        else if (edge[gy * W + gx]) v = 0x08;
        else v = (!nt && ((cx * 2 + cy) & 7) === 0) ? 0x08 : 0x80;
        cells[i] = v;
      }
    return cells;
  }
  // Still-page raster: ONE global raster at the current instant — real cover, no
  // drift (the "now" texture is the drift origin the loop's history advects into),
  // storm bands phased by the wall clock so the still matches the loop's newest frame.
  function buildSatStillRasters(data) {
    if (!cloudBase()) return null;
    const pctV = new Array(N * N), zero = new Array(N * N).fill(0);
    for (let t = 0; t < N * N; t++) {
      const w = data[t] || {};
      pctV[t] = w.cloudCoverPct == null ? 0 : w.cloudCoverPct;
    }
    const heads = stormHeadsAt(currentStormList(stormTracksCache), Date.now());
    const phase = ((Date.now() / 3600e3) % 12) / 12 * TAU;
    return [cloudRaster(pctV, zero, zero, heads, phase, null)];
  }

  function pressureBand(hpa) {
    if (hpa == null || !isFinite(hpa)) return 0;
    if (hpa < 995) return 1;
    if (hpa < 1013) return 2;
    if (hpa < 1025) return 3;
    return 4;
  }
  function pressureTempByte(hpa) {
    const b = pressureBand(hpa);
    return b === 1 ? 35 : b === 2 ? 55 : b === 3 ? 70 : b === 4 ? 90 : L.tempToByte(0);
  }
  // pressureSeaState() removed 2026-07-24: it banded the PRESSURE ocean into wave/storm
  // stipple, a second encoding of the variable the isobars draw. The POSTED path never did
  // this (proof-pages.js uses the real L.waveToSeaState(waveHeight)), so this was a
  // browser-only divergence; the live wall and the posted maps now agree.

  const ZX_SYM = { ' ': 0, ':': 14, '>': 18, '<': 19, '=': 20, '+': 21, '-': 22, '*': 23, '/': 24, '.': 27 };
  function zxCode(ch) {
    if (ch >= '0' && ch <= '9') return 28 + (ch.charCodeAt(0) - 48);
    const u = ch.toUpperCase();
    if (u >= 'A' && u <= 'Z') return 38 + (u.charCodeAt(0) - 65);
    return ZX_SYM[ch] == null ? 0 : ZX_SYM[ch];
  }
  function zxText(s) { const out = []; for (const ch of String(s)) out.push(zxCode(ch)); return out; }
  function contourValueLabel(page, wx) {
    if (!wx) return '';
    if (page === L.PAGE.TEMP && wx.tempC != null) return String(Math.round(wx.tempC));
    if (page === L.PAGE.PRESSURE && wx.pressureHpa != null) return String(Math.round(wx.pressureHpa));
    if (page === L.PAGE.WIND && wx.windKmh != null) return String(Math.round(wx.windKmh / 10) * 10);
    return '';
  }
  function windDirCode(oct) {
    const o = (oct | 0) & 7;
    if (o === 1 || o === 5) return zxCode('/');
    if (o === 3) return zxCode('>');
    if (o === 7) return zxCode('<');
    return zxCode('+');
  }
  function scalarForPage(page, wx) {
    if (!wx) return null;
    if (page === L.PAGE.TEMP) return wx.tempC;
    if (page === L.PAGE.PRESSURE) return wx.pressureHpa;
    if (page === L.PAGE.WIND) return wx.windKmh;
    return null;
  }
  function scalarEdgeMask(page, tile, iso) {
    let m = (iso | 0) & 0x0f;
    if (m || !lastData) return m;
    const self = scalarForPage(page, lastData[tile]);
    if (self == null || !isFinite(self)) return 0;
    const row = (tile / N) | 0, col = tile % N;
    const q = page === L.PAGE.PRESSURE ? 4 : page === L.PAGE.WIND ? 10 : 8;
    const band = (v) => Math.floor(v / q), b0 = band(self);
    const edge = (r, c, bit) => {
      if (r < 0 || r >= N) return;
      const v = scalarForPage(page, lastData[r * N + ((c + N) % N)]);
      if (v != null && isFinite(v) && band(v) !== b0) m |= bit;
    };
    edge(row - 1, col, L.ISO.N); edge(row + 1, col, L.ISO.S);
    edge(row, col - 1, L.ISO.W); edge(row, col + 1, L.ISO.E);
    return m;
  }
  function mergeMarks(...lists) {
    const out = [];
    let sawList = false;
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      sawList = true;
      for (const m of list) {
        if (out.length >= L.PHEN_MAX) return out;
        out.push(m);
      }
    }
    return out.length || sawList ? out : null;
  }
  function terminatorMarksForTile(wx, tile) {
    const sat = wx ? (wx.satIsoByte | 0) : 0;
    const mask = sat & 0x0f;
    if (!mask) return null;
    const marks = [], seen = new Set();
    const row = (tile / N) | 0, col = tile % N;
    const phase = (row * 3 + col * 5) & 7;
    const add = (x, y) => {
      const xx = Math.max(0, Math.min(31, Math.round(x)));
      const yy = Math.max(0, Math.min(23, Math.round(y)));
      const key = xx + ',' + yy;
      if (seen.has(key) || marks.length >= 12) return;
      seen.add(key);
      // Use a solid inverse display cell for the terminator so it reads distinctly
      // from scalar contour label/stroke characters and survives dense textures.
      marks.push({ x: xx, y: yy, code: 0x80 });
    };
    const curve = (i, count) => Math.round(2 * Math.sin(((i + phase) / Math.max(1, count - 1)) * Math.PI));
    const count = 7;
    // Draw ONLY along the day/night boundary edge(s). The previous centre-spoke
    // attempt created low-density dotted vertical/horizontal artifacts across tiles.
    if (mask & L.ISO.N) for (let i = 0; i < count; i++) add(2 + i * 5, 1 + curve(i, count));
    if (mask & L.ISO.S) for (let i = 0; i < count; i++) add(2 + i * 5, 22 - curve(i, count));
    if (mask & L.ISO.W) for (let i = 0; i < count; i++) add(1 + curve(i, count), 2 + i * 3);
    if (mask & L.ISO.E) for (let i = 0; i < count; i++) add(30 - curve(i, count), 2 + i * 3);
    return marks.length ? marks : null;
  }
  // ---- native day/night terminator (owner 2026-07-15) --------------------------
  // The night side is drawn as GENUINE 1-bit ZX81 cells (worker.applyNight pokes the
  // fine-checker char into night background cells), NOT a host alpha wash. app.js
  // owns only the solar geometry: it computes, per tile, a 32x24 per-CELL night
  // bitmap from the real sub-solar point at wall-clock UTC, so the terminator is a
  // crisp curved boundary at cell resolution on EVERY page. Equirectangular wall:
  // gx->lon(-180..180), gy->lat(90..-90); night where solar altitude < 0, i.e.
  // sinφ·sinδ + cosφ·cosδ·cos(lon-λ☉) < 0.
  const NIGHT_DEG = Math.PI / 180;
  function computeNightGeom(epochMs) {
    const now = epochMs == null ? new Date() : new Date(epochMs);
    const yStart = Date.UTC(now.getUTCFullYear(), 0, 0);
    const doy = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - yStart) / 86400000;
    const decl = -23.44 * NIGHT_DEG * Math.cos((2 * Math.PI / 365) * (doy + 10));
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const subLon = -15 * (utcH - 12) * NIGHT_DEG;
    return { sinD: Math.sin(decl), cosD: Math.cos(decl), subLon };
  }
  function nightMaskForTile(col, row, g) {
    const cpt = L.TILE_W, rpt = L.TILE_H;
    const mask = new Uint8Array(cpt * rpt);
    for (let cy = 0; cy < rpt; cy++) {
      const gy = row + (cy + 0.5) / rpt;                 // wall-fraction 0..N (tile units)
      const lat = (90 - 180 * gy / N) * NIGHT_DEG;
      const sinP = Math.sin(lat), cosP = Math.cos(lat);
      for (let cx = 0; cx < cpt; cx++) {
        const gx = col + (cx + 0.5) / cpt;
        const lon = (-180 + 360 * gx / N) * NIGHT_DEG;
        if (g.sinD * sinP + g.cosD * cosP * Math.cos(lon - g.subLon) < 0) mask[cy * cpt + cx] = 1;
      }
    }
    return mask;
  }
  // Marching night-mask frames for a SCALAR tile's terminator SWEEP: nf masks whose
  // sub-solar longitude steps a full 360deg WEST across the set (SPEC.subLonForFrame),
  // so the motion ticker cycling them makes the terminator creep steadily westward and
  // wrap seamlessly — the exact model satTileFrames uses, so every show=true tab sweeps
  // identically. Frame 0 is the real wall-clock position.
  function scalarNightFrames(col, row, geom, nf) {
    const frames = [];
    for (let f = 0; f < nf; f++)
      frames.push(nightMaskForTile(col, row,
        { sinD: geom.sinD, cosD: geom.cosD, subLon: SPEC.subLonForFrame(geom.subLon, f, nf) }));
    return frames;
  }
  // ---- native SATELLITE still frames -----------------------------------------
  // Slice the burst's global still raster(s) into per-tile char rasters
  // (Uint8Array(768)), poked straight into each machine's display file (worker) —
  // the same display-only mechanism as the WIND dots. The night mask is the REAL
  // current sub-solar geometry: the still's terminator sits at its actual clock
  // position and does not move. Returns null (no cloud engine) so the tile
  // honest-degrades to the coarse native satCell tape frame.
  function satTileFrames(col, row, nightGeom, rasters) {
    if (!rasters) return null;
    const night = nightMaskForTile(col, row, nightGeom);
    return rasters.map((r) => satInvCells(row * N + col, r, night));
  }
  // Land/sea coastline as a 1-cell-thick edge mask over the full 320x240 wall grid
  // (a land cell that touches sea in any 4-neighbour direction). Reuses the SAME
  // machine-drawn Natural Earth mask the map tabs render (coast.buildMask), so the
  // silhouette matches; x wraps at the date-line seam. Computed once, cached.
  let COAST_EDGE = null;
  function coastEdgeMask() {
    if (COAST_EDGE) return COAST_EDGE;
    const W = coast.MAPW, H = coast.MAPH, m = coast.buildMask();
    const e = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!m[y * W + x]) continue;                    // only land cells anchor the coast edge
        const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
        const up = y === 0 ? 1 : m[(y - 1) * W + x];    // off-grid (pole) counts as land: no edge
        const dn = y === H - 1 ? 1 : m[(y + 1) * W + x];
        if (!m[y * W + xl] || !m[y * W + xr] || !up || !dn) e[y * W + x] = 1;
      }
    COAST_EDGE = e;
    return e;
  }
  // ---- native SEA swell (owner 2026-07-15) -------------------------------------
  // The machine SEA page read as "meaningless hash marks" with no motion. Replace
  // the retired host greyscale swell overlay with a GENUINE 1-bit rolling swell
  // poked into the sea cells: crest bands of machine ink advect with wall-clock,
  // wavelength shortens + whitecaps foam as the tile's significant wave height
  // rises (Open-Meteo marine — the same value the SEA page transmits). Only sea
  // cells are poked; land keeps the machine's coastline silhouette. Returns per-
  // frame char rasters, or null (calm/no marine data) so the tile keeps native
  // seaCell. SEA_SWELL_NF motion frames are cycled by the motion ticker.
  const SEA_SWELL_NF = 8;
  // Whole-wall wave-height FIELD (owner QC 2026-07-30: one whole-tile average through
  // two ink levels, with dead water off any land-sampled coast tile, was
  // "remarkably uninformative"). Per-tile waveHeight readings are diffusion-filled
  // into land-sampled tiles (src/sea-field.js), bilinearly promoted per CELL
  // (tileBilin — same knots the corner grids use), storm-boosted around the
  // canonical track heads (a hurricane owns the roughest water on the wall), and
  // rendered through a six-step Douglas-style ramp. Returns SEA_SWELL_NF global
  // 320x240 char rasters, or null (module missing). Motion stays crest-roll only;
  // near a head the crests radiate from the eye.
  const SEA_STORM_R = 14;   // cells — eye-proximity radius (crest-radiation styling only)
  // Per-tile marine inputs for one instant. `at` maps a sea tile's wx to
  // {wh, dir, pd} (any null) — the still uses current readings, the TRK loop the
  // archived hour. Returns the promoted per-cell arrays seaRasterAt renders from.
  function seaPrep(data, heads, at) {
    const SF = window.WW_SEAFIELD;
    if (!SF) return null;
    const vals = new Array(N * N).fill(null);
    for (const t of seaIdx) {
      const wx = data[t];
      if (wx && at(wx).wh != null) vals[t] = at(wx).wh;
    }
    const filled = SF.fillTiles(vals, N);
    // Real swell (option C, 2026-07-31): per-tile TRAVEL unit vectors from the
    // true wave_direction (meteorological FROM, same convention as windCellVec;
    // screen y grows southward) + wave_period, diffusion-filled like the heights.
    // Direction interpolates via vector COMPONENTS (bilinear on degrees breaks at
    // the 359->0 wrap). No direction data anywhere -> styled-roll fallback.
    const uxV = new Array(N * N).fill(null), uyV = new Array(N * N).fill(null),
      pdV = new Array(N * N).fill(null);
    let anyDir = false;
    for (const t of seaIdx) {
      const wx = data[t];
      const m = wx && at(wx);
      if (!m || m.dir == null) continue;
      const rad = m.dir * Math.PI / 180;
      uxV[t] = -Math.sin(rad); uyV[t] = Math.cos(rad);
      if (m.pd != null) pdV[t] = m.pd;
      anyDir = true;
    }
    const ux = anyDir ? SF.fillTiles(uxV, N) : null,
      uy = anyDir ? SF.fillTiles(uyV, N) : null,
      pd = anyDir ? SF.fillTiles(pdV, N) : null;
    const cpt = L.TILE_W, rpt = L.TILE_H, W = N * cpt, H = N * rpt;
    // per-cell height + nearest-head distance (x wraps at the date line)
    const wh = new Float32Array(W * H), hd = new Float32Array(W * H).fill(-1);
    // per-cell swell: unit travel vector + wavelength cells (0 = fallback — no
    // data, or opposing swells cancelling to a degenerate vector)
    const sxA = ux ? new Float32Array(W * H) : null,
      syA = ux ? new Float32Array(W * H) : null,
      wlA = ux ? new Float32Array(W * H) : null;
    const hpos = [];
    for (const [ht, hh] of heads)
      hpos.push([(ht % N) * cpt + hh.ex, ((ht / N) | 0) * rpt + hh.ey]);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = tileBilin(filled, x, y), d = -1;
        for (const [hx, hy] of hpos) {
          const dx = Math.min(Math.abs(x - hx), W - Math.abs(x - hx));
          const dd = Math.hypot(dx, y - hy);
          if (dd < SEA_STORM_R && (d < 0 || dd < d)) d = dd;
        }
        // STORM BOOST RETIRED (owner 2026-08-04 audit): SF.boost() invented a 9 m
        // linear ramp around every storm head — unmeasured wave heights that the
        // page's own iso-wave contours (real readings only) contradicted. The
        // texture now renders MEASURED water everywhere; `d` still marks
        // eye-proximity so the crest-radiation styling keeps its geometry.
        const i = y * W + x;
        wh[i] = v; hd[i] = d;
        if (ux) {
          const vx = tileBilin(ux, x, y), vy = tileBilin(uy, x, y);
          const m2 = Math.hypot(vx, vy);
          if (m2 > 0.05) {
            sxA[i] = vx / m2; syA[i] = vy / m2;
            // wavelength in CELLS from the true period: long swell (16 s) reads as
            // wide-spaced crests, short chop packs them. Styled scale, real driver.
            wlA[i] = Math.min(16, Math.max(4, tileBilin(pd, x, y)));
          }
        }
      }
    return { wh, hd, sxA, syA, wlA, W, H };
  }
  // One global char raster at motion phase ph [0,1) from a seaPrep.
  function seaRasterAt(prep, ph) {
    const SF = window.WW_SEAFIELD;
    const { wh, hd, sxA, syA, wlA, W, H } = prep;
    const cells = new Uint8Array(W * H), sw = { sx: 0, sy: 0, wl: 0 };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let s = null;
        if (wlA && wlA[i] > 0) { sw.sx = sxA[i]; sw.sy = syA[i]; sw.wl = wlA[i]; s = sw; }
        cells[i] = SF.seaCharAt(wh[i], x, y, ph, hd[i] >= 0 ? hd[i] : null, s);
      }
    return cells;
  }
  function buildSeaWall(data) {
    const heads = stormHeadsAt(currentStormList(stormTracksCache), Date.now());
    const prep = seaPrep(data, heads,
      (wx) => ({ wh: wx.waveHeight, dir: wx.waveDir, pd: wx.wavePeriod }));
    if (!prep) return null;
    const frames = [];
    for (let f = 0; f < SEA_SWELL_NF; f++) frames.push(seaRasterAt(prep, f / SEA_SWELL_NF));
    return frames;
  }
  // Wave-height contour mask for one tile with LAND cells zeroed (a wave line has
  // no business crossing a continent). Null when nothing survives the mask.
  function seaLineCells(mask, land) {
    if (!mask) return null;
    let out = null;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || land[i]) continue;
      if (!out) out = new Uint8Array(mask.length);
      out[i] = mask[i];
    }
    return out;
  }
  // Slice the global sea rasters for one tile. Any tile CONTAINING sea cells gets
  // frames now (the worker's land mask keeps the coastline) — the old seaSet gate
  // is what killed the water off land-sampled coast tiles. Night hatch is NOT
  // applied to sea cells (it filled calm night water into a solid wash).
  function seaTileFrames(t, col, row, seaWall) {
    if (!seaWall) return null;
    const land = landMasks[t];
    let hasSea = false;
    for (let i = 0; i < land.length && !hasSea; i++) if (!land[i]) hasSea = true;
    if (!hasSea) return null;
    const cpt = L.TILE_W, rpt = L.TILE_H, W = N * cpt;
    return seaWall.map(r => {
      const cells = new Uint8Array(cpt * rpt);
      for (let cy = 0; cy < rpt; cy++)
        for (let cx = 0; cx < cpt; cx++)
          cells[cy * cpt + cx] = r[(row * rpt + cy) * W + (col * cpt + cx)];
      return cells;
    });
  }
  // ---- native isolines (owner 2026-07-15) --------------------------------------
  // The smooth marching-squares isobars/isotherms used to be strokes on the host
  // overlay canvas. Rasterise those exact polylines into per-tile 1-bit cell masks
  // and poke them as machine ink (major = solid, minor = checker), so the synoptic
  // isolines are genuine ZX81 cells drawn by the ULA — not a host stroke. PRESSURE
  // isobars are essential (the native byte6 edge mask is disabled for it), so this
  // is how PRESSURE gets its chart; TEMP rides the same path. Returns array[N*N] of
  // per-tile Uint8Array(768) (cell value 2 = major line, 1 = minor), or null.
  function contourLineCells(page, data) {
    const cfg = page === L.PAGE.PRESSURE ? { key: 'pressureHpa', step: 4, major: 20 }
      : page === L.PAGE.TEMP ? { key: 'tempC', step: 5, major: 10 }
      // SEA (option D, 2026-07-31): iso-wave-height contours — at-a-glance which
      // basins are up. Real readings only (no storm boost); land-sampled tiles
      // filled by the same diffusion the field uses so contours reach the coast.
      : page === L.PAGE.SEA ? { key: 'waveHeight', step: 1.5, major: 3 }
      // WEATHER isobars must be Z80-native (iso-edge byte drawn by pg_weather) under the
      // strict-charm ruling — the host smooth-isobar poke is retired here. Pending that
      // Z80 work, WEATHER carries no host isobars.
      : null;
    if (!cfg || !data || !window.WW_CONTOURS) return null;
    if (page === L.PAGE.SEA) {
      const SF = window.WW_SEAFIELD;
      if (!SF) return null;
      const vals = new Array(N * N).fill(null);
      for (const t of seaIdx) {
        const w = data[t];
        if (w && w.waveHeight != null) vals[t] = w.waveHeight;
      }
      data = SF.fillTiles(vals, N).map(v => ({ waveHeight: v }));
    }
    const { lines } = window.WW_CONTOURS.computeContours(data, N,
      { key: cfg.key, step: cfg.step, major: cfg.major, S: 6, unit: '' });
    if (!lines.length) return null;
    const cpt = L.TILE_W, rpt = L.TILE_H, Wc = N * cpt, Hc = N * rpt;
    const masks = new Array(N * N).fill(null);
    const setCell = (gx, gy, v) => {
      if (gx < 0 || gy < 0 || gx >= Wc || gy >= Hc) return;
      const col = (gx / cpt) | 0, row = (gy / rpt) | 0, t = row * N + col;
      let m = masks[t]; if (!m) m = masks[t] = new Uint8Array(cpt * rpt);
      const i = (gy % rpt) * cpt + (gx % cpt);
      if (v > m[i]) m[i] = v;
    };
    for (const ln of lines) {
      const v = ln.major ? 2 : 1;
      for (const s of ln.segs) {
        const ax = s[0] * cpt, ay = s[1] * rpt, bx = s[2] * cpt, by = s[3] * rpt;
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        for (let k = 0; k <= steps; k++) {
          const tt = k / steps;
          setCell(Math.round(ax + (bx - ax) * tt), Math.round(ay + (by - ay) * tt), v);
        }
      }
    }
    return masks;
  }

  // Promote a tile's 4 corner bytes to the 5x5 field grid the machine would derive
  // itself (CP.bilinMG per lattice node — ct_run4's own bilinear), so a PRESSURE loop
  // corner frame can ride the field wire (and its on-contour MB label tail) with
  // byte-identical curves (contourMG === contourFromGrid over this grid, by definition).
  function promoteCorners(c) {
    const CP = window.WW_CONTOURPLOT;
    const gv = new Array(25);
    for (let gy = 0; gy <= 4; gy++)
      for (let gx = 0; gx <= 4; gx++)
        gv[gy * 5 + gx] = CP.bilinMG(c.nw | 0, c.ne | 0, c.se | 0, c.sw | 0, gx, gy);
    return gv;
  }

  // ---- CANONICAL LOOP STORM TRACKS (owner 2026-07-30: "We need smooth tracks, and these
  // same tracks will need to apply to all tabs... data-driven as far as possible").
  // data/storm-tracks.json = real agency (NHC/JTWC) eye fixes distilled from the dense
  // archive by tools/refresh-tracks.js; src/storm-track.js interpolates them per frame.
  // Every tab's loop resolves storm positions HERE — same storm, same place, every tab.
  let stormTracksCache = null, stormTracksAt = 0;
  async function loadStormTracks() {
    if (stormTracksCache && (Date.now() - stormTracksAt) < 10 * 60e3) return stormTracksCache;
    try {
      const r = await fetch('/data/storm-tracks.json', { cache: 'no-store' });
      if (r.ok) { stormTracksCache = await r.json(); stormTracksAt = Date.now(); }
    } catch (e) { /* keep the last copy — honest degrade */ }
    return stormTracksCache;
  }
  // The currently-detected storms joined to their track records (by name).
  function currentStormList(tracks) {
    const ST = window.WW_STORMTRACK;
    const out = [];
    for (let st = 0; st < N * N; st++) {
      const cw = lastData && lastData[st];
      if (!cw || (cw.cycloneTier | 0) < L.CYC.CYCLONE || cw.cycloneSuppress) continue;
      out.push({ st, cw, rec: (ST && tracks) ? ST.trackFor(tracks, cw.cycloneName) : null });
    }
    return out;
  }
  // Per-epoch head positions: Map(tile -> {ex, ey, pos, cw}). A tracked storm rides its
  // interpolated fix; an untracked one holds its current fix (smooth by definition); a
  // frame earlier than the track's first fix (minus slack) has NO head — honest genesis.
  function stormHeadsAt(storms, epochMs) {
    const ST = window.WW_STORMTRACK;
    const heads = new Map();
    for (const s of storms) {
      let wp = null;
      if (s.rec && ST) {
        const first = +new Date(s.rec.points[0].at);
        if (epochMs < first - 2 * 3600e3) continue;
        const p = ST.trackAt(s.rec.points, epochMs);
        if (p) wp = ST.wallPos(p.lat, p.lon);
      } else if (ST && typeof s.cw.cycloneLat === 'number' && typeof s.cw.cycloneLon === 'number') {
        wp = ST.wallPos(s.cw.cycloneLat, s.cw.cycloneLon);
      }
      if (!wp) {
        const c = (window.WW_GLYPHS && window.WW_GLYPHS.SUB_CELL[s.cw.cyclonePos | 0]) || [16, 12];
        wp = { tile: s.st, ex: c[0], ey: c[1], pos: s.cw.cyclonePos | 0 };
      }
      heads.set(wp.tile, { ex: wp.ex, ey: wp.ey, pos: wp.pos, cw: s.cw });
    }
    return heads;
  }
  // A gust-track head within 1 tile of a canonical head is the SAME storm re-detected —
  // suppress it (no doubles); genuinely separate unnamed lows keep their marker.
  function nearTrackedHead(heads, t) {
    if (!heads || !heads.size) return false;
    const r = (t / N) | 0, c = t % N;
    for (const tile of heads.keys()) {
      const hr = (tile / N) | 0, hc = tile % N;
      const dc = Math.min(Math.abs(hc - c), N - Math.abs(hc - c));
      if (Math.abs(hr - r) <= 1 && dc <= 1) return true;
    }
    return false;
  }
  function headCycByte(hd) {
    const cw = hd.cw;
    return L.cycloneToByte(cw.cycloneTier | 0, hd.pos | 0, cw.cycloneSouth | 0, cw.cycloneAnim | 0, 0);
  }

  // PRESSURE storm plate as OVERLAY cells (rides msg.labelCells): with the storm shipped
  // as a FIELD frame (the pressure well) there is no name/pressure trailer for the
  // machine to stamp, so the host renders the SAME plate (texture.stampNamePressure,
  // anchor from the same sea-bias chooser — pricing the well's own isobar cells) and
  // pokes it display-only: the exempt overlay class (night/smoke/tab label).
  function stormPlateCells(wx, land, welled) {
    const T = window.WW_TEXTURE, CP = window.WW_CONTOURPLOT;
    if (!T || !T.stampNamePressure) return null;
    const nameCodes = (NHC && wx.cycloneName) ? NHC.nameToZX(wx.cycloneName, 10) : [];
    const hPa = wx.cyclonePressureHpa;
    if (!nameCodes.length && hPa == null) return null;
    let avoid = null;
    if (CP && welled) {
      const quad = CP.contourFromGrid(welled, L.PRESS_ISO_LEVELS);
      avoid = [];
      for (let i = 0; i < quad.length; i++)
        if (quad[i]) avoid.push({ x: i % L.TILE_W, y: (i / L.TILE_W) | 0 });
    }
    const anchor = (nameCodes.length && T.pickPlateAnchor)
      ? T.pickPlateAnchor(land, nameCodes.length, hPa, wx.cyclonePos | 0, 0, avoid)
      : null;
    const buf = new Uint8Array(L.TILE_W * L.TILE_H).fill(0xFF);   // 0xFF sentinel = untouched
    T.stampNamePressure(buf, wx.cycloneTier | 0, wx.cyclonePos | 0, hPa, nameCodes, anchor);
    const cells = [];
    for (let i = 0; i < buf.length; i++) if (buf[i] !== 0xFF) cells.push({ i, c: buf[i] });
    return cells.length ? cells : null;
  }

  // TEMP numeric labels ride the ISOTHERMS (owner 2026-07-16): a tile is labelled only
  // when a MAJOR isotherm crosses it, so the readings sit ON the contour band and MOVE
  // with the lines as the loop re-renders (was a fixed row/col lattice at tile centres,
  // static). A deterministic sparse filter keeps them from crowding every line tile.
  function hasMajorLine(cells) {
    if (!cells) return false;
    for (let i = 0; i < cells.length; i++) if (cells[i] === 2) return true;
    return false;
  }
  function tempLabelOnIso(lineCells, row, col) {
    return hasMajorLine(lineCells) && (((row + col) & 1) === 0);
  }

  // WILDFIRE SMOKE PLUME (WEATHER page). The CAMS aerosol_optical_depth field is real
  // smoke/aerosol column, but AOD is raised by dust and city smog too — so we attribute
  // it as WILDFIRE smoke honestly: the plume is the CONNECTED region of elevated AOD that
  // TOUCHES an active fire tile (flood-fill from fires through elevated-AOD neighbours).
  // Downwind extent is captured from the real field; non-fire haze/dust is excluded. NO
  // advection sim — the AOD field already encodes where the smoke is. Sets w.smokeByte
  // (0 none / 1 light / 2 medium / 3 heavy) per tile; the machine renders the hatch.
  // AOD bands tuned for MAJOR wildfire smoke (owner's ask): light haze near a fire is not
  // the target — the plume should read only when the aerosol column is genuinely smoke-
  // scale. Clean air ~0.05; moderate haze ~0.2-0.35; a real smoke plume runs 0.5-3+.
  const AOD_LIGHT = 0.4, AOD_MED = 0.8, AOD_HEAVY = 1.5;
  function computeSmokePlume(data) {
    const elevated = (i) => { const w = data[i]; return !!w && typeof w.smoke === 'number' && w.smoke >= AOD_LIGHT; };
    const inPlume = new Uint8Array(data.length);
    const q = [];
    for (let i = 0; i < data.length; i++) if (data[i] && data[i].fireMark && elevated(i)) { inPlume[i] = 1; q.push(i); }
    while (q.length) {
      const t = q.pop(), r = (t / N) | 0, c = t % N;
      const step = (rr, cc) => { if (rr < 0 || rr >= N) return; const n = rr * N + ((cc % N + N) % N); if (!inPlume[n] && elevated(n)) { inPlume[n] = 1; q.push(n); } };
      step(r - 1, c); step(r + 1, c); step(r, c - 1); step(r, c + 1);
    }
    for (let i = 0; i < data.length; i++) {
      const w = data[i]; if (!w) continue;
      let lvl = 0;
      if (inPlume[i]) { const a = w.smoke; lvl = a >= AOD_HEAVY ? 3 : a >= AOD_MED ? 2 : 1; }
      w.smokeByte = lvl;
    }
  }

  // Symbolic scalar contour marks. These are NOT pixels: they ride the existing
  // phen triple protocol as ZX81 display-file character codes, then the emulator
  // stamps them inside each tile. Host logic chooses sparse placements only.
  function contourMarksForTile(page, wx, iso, tile) {
    if (!(page === L.PAGE.TEMP || page === L.PAGE.PRESSURE || page === L.PAGE.WIND)) return null;
    iso = scalarEdgeMask(page, tile, iso | 0);
    const marks = [];
    const add = (x, y, code) => {
      if (marks.length >= L.PHEN_MAX) return;
      marks.push({ x: Math.max(0, Math.min(31, x | 0)), y: Math.max(0, Math.min(23, y | 0)), code: (code | 0x80) & 0xff });
    };
    const addIcon = (kind, x, y) => {
      const rows = window.WW_GATEWAY && window.WW_GATEWAY.WEATHER_ICONS && window.WW_GATEWAY.WEATHER_ICONS[kind];
      if (!rows) return false;
      for (let r = 0; r < rows.length; r++)
        for (let c = 0; c < rows[r].length; c++)
          if (rows[r][c] === '1') add(x + c, y + r, 0x80);
      return true;
    };
    // PRESSURE centre H/L moved OFF the phen path (owner 2026-07-15): a phen mark can
    // only ADD ink (worker stampPhen treats code 0x00 as transparent), so a solid-ink
    // 'L' vanished on the dark deep-low fill — the synoptic lows read as unlabelled.
    // The centre letter is now a display-only POKE (worker.applyCentres) that writes a
    // black glyph on a white keyline halo, legible on ANY fill; it rides the periph
    // byte's centre bits (already sent on every PRESSURE tile/loop frame). No phen here.
    // PRESSURE declutter (owner QC): the per-tile isobar CONTOUR is already drawn on-
    // machine as clean half-block edges. The old ':'/'-'/'=' connector strokes just
    // read as dotted noise along the grid lines, and the tiny 1-cell per-tile pressure
    // value labels were illegible at wall scale — both removed. The WIND-page
    // direction hint is retained (WIND still uses this path when wired).
    if (page === L.PAGE.WIND && wx && wx.windKmh >= 12) add(16, 14, windDirCode(L.windDirToOctant(wx.windDir)));
    return marks.length ? marks : null;
  }

  // On-map Pacific LEGEND suppression (owner 2026-07-15 QC): gateway.addPacificLegend
  // stamps a weather-key column (RA/SN/TH/GA/HT/CL) onto the mid-Pacific tiles so the
  // POSTED image carries its own key. The WEB wall already has the full HTML footer
  // legend, so that on-map column just reads as stray glyphs stacked in the left
  // gutter over the ocean. Clear those exact legend tiles from the DISPLAY data (the
  // gateway already overwrote any real weather there with the key, so nothing real is
  // lost); the posting path is untouched. Tiles mirror gateway LEGEND_ROWS icon+label.
  // stripPacificLegend RETIRED with the on-map legend itself (gateway, owner 2026-08-03).
  // RETIRED (owner 2026-07-15): every wall/data graphic is now genuine ZX81-native
  // machine cells drawn by the ULA — the day/night terminator, satellite cloud field,
  // SEA swell, isobars/isotherms and WEATHER pictograms are all poked into the tiles
  // (see worker.js applyNight/applyLines + the sat/sea/line raster builders above).
  // The host overlay canvas and ALL its draw/clear functions (drawContourOverlay,
  // clearOverlay, drawBroadcastWeatherIcon, drawWeatherSummaryOverlay,
  // drawWindChartChevrons, paintTerminator, drawSeaSwell, drawSatelliteOverlay) have
  // been DELETED. Nothing host-side draws on the wall, and there is no resize repaint.

  // ---- legend swatches drawn straight from the char ROM ----
  (function drawLegend() {
    const m = window.ZX81({ Z80: window.Z80, romB64: window.ZX81_ROM_B64, ram64k: false });
    const rom = m.rom, CHARSET = 0x1e00;
    document.querySelectorAll('.swatch[data-code]').forEach((cv) => {
      const code = parseInt(cv.dataset.code, 10);
      cv.width = 16; cv.height = 16;
      const ctx = cv.getContext('2d');
      const inv = (code & 0x80) ? 0xff : 0x00;
      const glyph = CHARSET + (code & 0x3f) * 8;
      for (let sl = 0; sl < 8; sl++) {
        let bits = rom[glyph + sl] ^ inv;
        for (let px = 0; px < 8; px++) {
          const on = (bits & 0x80) ? '#111' : '#f6f6ee';
          bits = (bits << 1) & 0xff;
          ctx.fillStyle = on; ctx.fillRect(px * 2, sl * 2, 2, 2);
        }
      }
    });
    // cyclone swatch: the shared texture.js MAJOR stamp, so the legend icon is
    // literally the marker the wall draws (arm = inverse ink, eye = blank).
    const cyc = document.getElementById('cyc-swatch');
    if (cyc && window.WW_TEXTURE) {
      const T = window.WW_TEXTURE, S = T.STAMP_MAJOR, W = T.STAMP_W, H = T.STAMP_H;
      const ctx = cyc.getContext('2d');
      const cw = cyc.width / W, ch = cyc.height / H;
      ctx.fillStyle = '#f6f6ee'; ctx.fillRect(0, 0, cyc.width, cyc.height);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const v = S[y * W + x];
          ctx.fillStyle = (v === T.SK) ? '#f6f6ee' : (v === 0 ? '#f6f6ee' : '#111');
          ctx.fillRect(x * cw, y * ch, Math.ceil(cw), Math.ceil(ch));
        }
    }
    // periphery swatch: a real centred spiral bitmap (a mid-size bucket) from the
    // shared BAND_GRIDS, so the legend icon is literally the spiral the wall draws.
    const band = document.getElementById('band-swatch');
    if (band && window.WW_GLYPHS && window.WW_GLYPHS.BAND_GRIDS) {
      const G = window.WW_GLYPHS, grid = G.BAND_GRIDS[3], FS = G.BAND_FS;
      const ctx = band.getContext('2d');
      const cw = band.width / FS, ch = band.height / FS;
      ctx.fillStyle = '#f6f6ee'; ctx.fillRect(0, 0, band.width, band.height);
      ctx.fillStyle = '#111';
      for (let y = 0; y < FS; y++)
        for (let x = 0; x < FS; x++)
          if (grid[y * FS + x]) ctx.fillRect(x * cw, y * ch, Math.ceil(cw), Math.ceil(ch));
    }
    // glyph + wind legend swatches, drawn straight from the shared byte tables.
    const GLY = window.WW_GLYPHS;
    function paintBitmap(cv, rows) {
      cv.width = GLY.GW; cv.height = GLY.GH;
      const c2 = cv.getContext('2d');
      c2.fillStyle = '#f6f6ee'; c2.fillRect(0, 0, GLY.GW, GLY.GH);
      c2.fillStyle = '#111';
      for (let r = 0; r < GLY.GH; r++)
        for (let x = 0; x < GLY.GW; x++)
          if ((rows[r] >> (GLY.GW - 1 - x)) & 1) c2.fillRect(x, r, 1, 1);
    }
    if (GLY) {
      document.querySelectorAll('.gswatch[data-glyph]').forEach((cv) =>
        paintBitmap(cv, GLY.CAT_GLYPHS[+cv.dataset.glyph]));
      document.querySelectorAll('.wswatch[data-wind]').forEach((cv) => {
        const [o, b] = cv.dataset.wind.split(',').map(Number);
        paintBitmap(cv, GLY.WIND_CHEVRONS[o][b]);
      });
    }
    const WIC = window.WW_GATEWAY && window.WW_GATEWAY.WEATHER_ICONS;
    if (WIC) document.querySelectorAll('.pictswatch[data-weather-icon]').forEach((cv) => {
      const rows = WIC[cv.dataset.weatherIcon] || [];
      cv.width = 28; cv.height = 28;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#f6f6ee'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#111';
      const cell = 4;
      for (let y = 0; y < rows.length; y++)
        for (let x = 0; x < rows[y].length; x++)
          if (rows[y][x] === '1') ctx.fillRect(x * cell, y * cell, cell, cell);
    });
  })();

  // ---- precompute static land masks (coastline never changes) ----
  const landMasks = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) landMasks.push(coast.tileLandMask(r, c));

  // Coast OUTLINE masks (WEATHER, owner 2026-07-21): the synoptic chart draws land as
  // an OUTLINE, not a stipple fill — the radiofax convention (the ink budget belongs
  // to the weather, land is just geography). Computed GLOBALLY across tile seams
  // (longitude wraps, off-grid rows count as land) so interior tile boundaries never
  // read as false coastlines. Per cell: 0 = sea, 1 = interior land, 2 = coast.
  const outlineMasks = (() => {
    const GWc = N * L.TILE_W, GHc = N * L.TILE_H;
    const glob = new Uint8Array(GWc * GHc);
    for (let t = 0; t < N * N; t++) {
      const ox = (t % N) * L.TILE_W, oy = ((t / N) | 0) * L.TILE_H, m = landMasks[t];
      for (let y = 0; y < L.TILE_H; y++)
        for (let x = 0; x < L.TILE_W; x++)
          glob[(oy + y) * GWc + (ox + x)] = m[y * L.TILE_W + x] ? 1 : 0;
    }
    const at = (x, y) => {
      if (y < 0 || y >= GHc) return 1;                       // off-grid = land (no map-edge line)
      return glob[y * GWc + (((x % GWc) + GWc) % GWc)];      // wrap longitude
    };
    const out = [];
    for (let t = 0; t < N * N; t++) {
      const ox = (t % N) * L.TILE_W, oy = ((t / N) | 0) * L.TILE_H;
      const m = new Uint8Array(L.TILE_W * L.TILE_H);
      for (let y = 0; y < L.TILE_H; y++)
        for (let x = 0; x < L.TILE_W; x++) {
          const gx = ox + x, gy = oy + y;
          if (!glob[gy * GWc + gx]) continue;
          const coastCell = !at(gx - 1, gy) || !at(gx + 1, gy) || !at(gx, gy - 1) || !at(gx, gy + 1);
          m[y * L.TILE_W + x] = coastCell ? 2 : 1;
        }
      out.push(m);
    }
    return out;
  })();

  const coords = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) { const [lon, lat] = coast.tileCenterLonLat(r, c); coords.push({ lat, lon }); }

  // Sea-tile indexes are used only to interpret the scheduler-owned snapshot.
  // The browser does not fetch marine data directly.
  const seaIdx = [], seaCoords = [];
  const cxi = (L.TILE_W >> 1), cyi = (L.TILE_H >> 1);
  for (let i = 0; i < N * N; i++)
    if (!landMasks[i][cyi * L.TILE_W + cxi]) { seaIdx.push(i); seaCoords.push(coords[i]); }
  // Only these tiles carry a marine sample, so only these derive a real sea state.
  // A LAND tile has no marine sample: its coastal sea cells stay CALM (blank) and
  // must NOT read as the grey NO-DATA test-card (waveToSeaState(absent) => NODATA).
  const seaSet = new Set(seaIdx);

  // Impact-scout sub-tile sampling: the live path fetches the 100 tile centres
  // first, lets those ZX81-local samples identify population/severe-weather tiles,
  // then spends a small extra quincunx budget only there. The demo/fallback path
  // still has the historical sea-wide fixture shape, so keep that as the initial
  // `subPts` alignment until a live refresh replaces it.
  const fallbackSub = GW.cycloneSubPoints(seaIdx, seaCoords, 360 / N, 180 / N);
  const IMPACT_SCOUT_CAP = 8;
  let subPts = fallbackSub.subPts;

  // ---- worker pool ----
  const workers = [];
  let readyCount = 0;
  let template = null;

  // refresh/burst state
  let queue = [];
  let paintedCount = 0;
  let burstStart = 0;
  let lastBurstMs = 0;
  let nextRefreshAt = 0;
  let refreshing = false;
  let failStreak = 0;
  let everRendered = false;
  let lastData = null;      // last resolved weather map (for the RADAR/CLASSIC toggle)
  // DENSE continental field: { tiles: { tileId: [25 bytes] } } written by the scheduler
  // (tools/refresh-continental-field.js). Loaded once; a continental TEMP tile with a field
  // here ships it (worker -> ct_run4f) so the machine draws real dense sub-tile isotherms.
  let contField = null;
  // DENSE-HISTORY archive (hybrid loops): index + per-hour snapshots, lazily fetched
  // and cached for the session. index false = fetch failed (loop degrades to corners).
  let denseIndex = null;
  const denseSnaps = new Map();
  async function loadDenseIndex() {
    if (denseIndex !== null) return denseIndex;
    try {
      const r = await fetch('/data/history-dense/index.json', { cache: 'no-store' });
      denseIndex = r.ok ? await r.json() : false;
    } catch (e) { denseIndex = false; }
    return denseIndex;
  }
  async function loadDenseSnap(hour) {
    if (denseSnaps.has(hour)) return denseSnaps.get(hour);
    let s = null;
    try {
      const r = await fetch('/data/history-dense/' + hour + '.json', { cache: 'no-store' });
      if (r.ok) s = await r.json();
    } catch (e) {}
    denseSnaps.set(hour, s);
    return s;
  }
  async function loadContinentalField() {
    if (contField !== null) return contField;
    try {
      const r = await fetch('/data/continental-field.json', { cache: 'no-store' });
      contField = (r.ok) ? (await r.json()) : {};
      // never render a synthetic dense field as real isotherms/isobars (owner
      // 2026-08-04 audit: the file carries mode:'synthetic' but no consumer
      // checked it) — degrade to the 4-corner curves instead
      if (contField && contField.mode === 'synthetic') { console.warn('continental-field is SYNTHETIC — ignored'); contField = {}; }
    } catch (e) { contField = {}; }
    return contField;
  }

  // ---- page cache (#3): harvest each page's tiles ONCE per data refresh so a tab
  // flip / AUTO step re-blits from cache instead of re-broadcasting the whole burst.
  // FALLBACK-SAFE: the cache is only a side effect of normal rendering; repaintPage
  // uses it ONLY when a page is fully cached for the CURRENT map, else it falls
  // through to the usual startBurst re-broadcast (so it can never regress). A burst
  // generation (burstGen) guards against a stale in-flight reply (from a burst the
  // user switched away from) polluting the wrong page's cache.
  const pageCache = new Map();   // `${mapVersion}:${page}` -> { frames:[], cyc:[], done }
  let mapVersion = 0;            // bumps on genuine new data (invalidates the cache)
  let burstGen = 0;             // increments per startBurst; stamped on each job
  let burstKey = null;         // cache key of the in-flight burst
  function invalidatePageCache() {
    mapVersion++; pageCache.clear();
    denseIndex = null; denseSnaps.clear();   // new map -> re-read the dense archive (it grows)
  }
  let lastSubResults = [];  // last cyclone sub-tile sample results (history rides on them)

  // ---- tape-loop: phenomenon TRACKS (WEATHER) + smooth contour loops (scalar pages) ---
  // The TRK control picks a 12/24/48h window. If the scheduler snapshot carries
  // hourly history, the browser can re-derive the layer from that cached data and
  // burst-render one frame per sampled hour. It never fetches history itself.
  // Frame SOURCE follows the active page:
  //   WEATHER -> gw.trackFrames (storm HEAD + fading TRAIL, one frame/hour);
  //   TEMP/WIND/PRESSURE/SEA -> compositor-level smooth isoline loops over sampled
  //     scalar frames; no tile-edge contour boxes, no extra machine work.
  //   SATELLITE -> its own cloud-motion compositor loop.
  const CONTOUR_FRAMES = 6;   // fixed sampled-hour count for the contour tape-loop
  let trackSpan = 0;          // 0 = off, else 12/24/48 (window hours)
  let trackImgs = null;       // [frame] -> { tileIdx: ImageData } for the loop tiles
  let contourLoopFrames = null; // [frame] -> weather-like scalar array for smooth overlay loops
  let trackPending = 0;       // outstanding frame-tile renders
  let trackPhase = 0;
  let trackGen = 0;           // generation token: bumped on every buildTracks() so a
                              // STALE in-flight reply (page/span switched, or a refresh
                              // rebuilt, mid-burst) can't land in the NEW trackImgs or
                              // corrupt the NEW trackPending count
  let hasTrackPref = false;
  try { const ts = localStorage.getItem('zwx-tracks'); if (ts != null) { trackSpan = +ts || 0; hasTrackPref = true; } } catch (e) {}
  // AUTO "cycle all" is a two-level loop: the OUTER loop steps through every sheet
  // (startAuto), and while a sheet is up its INNER loop time-lapses that sheet's own
  // prior-24h archived history (the tape loop below).
  // Arm the inner 24h loop BY DEFAULT — independent of AUTO — so opening the page
  // shows the loop-within-loop moving on the very first sheet, even for a returning
  // visitor whose AUTO is paused (persisted zwx-auto=0). Without this a paused-AUTO
  // reload lands on a FROZEN static sheet (no span => no tape loop). An explicit
  // TRK OFF (persisted zwx-tracks=0) is still honoured — only the never-chosen case
  // defaults on.
  const CYCLE_SPAN_H = 24;
  if (trackSpan === 0 && !hasTrackPref) trackSpan = CYCLE_SPAN_H;

  // Scheduler-owned weather snapshot. The browser never contacts live weather
  // providers; it only reads same-origin artifacts written by tools/scheduler-cycle.sh.
  // DEMO-FIXTURE FALLBACK RETIRED (owner 2026-08-04 audit): a missing scheduler
  // snapshot used to silently render the synthetic July-2 demo capture as the
  // whole wall (and seed the loops from it) with only a status-bar pill as the
  // tell. A missing snapshot now takes the honest NO SCHEDULER DATA branch —
  // a dark wall over a fake one. The demo fixture remains reachable ONLY via
  // the explicit ?demo= URL parameter.
  function validWeatherArray(a) {
    return Array.isArray(a) && a.length === N * N && a.every((w) => w && typeof w === 'object');
  }
  // FEED AGE GATE (owner 2026-08-04 audit): overlay feed files were consumed with
  // no age check — a stalled scheduler left storms/fires/floods painting as
  // current indefinitely. A feed older than 6h (two missed cycles) is treated
  // as ABSENT (quiet layer), never as live. Files without fetchedAt pass (age
  // unknown beats layer permanently dark; the scheduler stamps every live feed).
  const MAX_FEED_AGE_MS = 6 * 3600000;
  function feedFresh(o, label) {
    if (!o || !o.fetchedAt) return true;
    const age = Date.now() - Date.parse(o.fetchedAt);
    if (!(age > MAX_FEED_AGE_MS)) return true;
    console.warn(label + ' feed is ' + Math.round(age / 3600000) + 'h old — treated as absent (quiet), not current');
    return false;
  }
  async function schedulerWeatherSnapshot() {
    for (const spec of [
      { url: '/data/weather-fixture.json', fallback: false },
    ]) {
      try {
        const r = await fetch(spec.url, { cache: 'no-store' });
        if (r.ok) {
          const o = await r.json();
          if (o && validWeatherArray(o.weather))
            return {
              at: Date.parse(o.fetchedAt) || 0,
              data: o.weather,
              subs: o.subSamples || [],
              source: o.source,
              sources: o.sources,
              fallback: spec.fallback,
            };
        }
      } catch (e) {}
    }
    return null;
  }

  // Drive the per-source MARINE status pill from an honest sub-source label (see
  // tools/refresh-fixture.js buildSourceLabels): "live" | "failed(<reason>)" |
  // "absent" | "synthetic". A failing sub-source is NAMED as NO DATA — never the
  // blanket "ok"/"calm" that hid the last marine outage (missing != measured-calm).
  function applyMarinePill(state) {
    const el = $('s-marine'); if (!el) return;
    if (state === 'live') { el.textContent = 'ok'; el.className = 'ok'; return; }
    if (state === 'synthetic') { el.textContent = 'synthetic'; el.className = 'fail'; return; }
    const m = /^failed\((.+)\)$/.exec(state || '');
    el.textContent = m ? 'NO DATA (' + m[1] + ')' : 'NO DATA' + (state === 'absent' ? ' (absent)' : '');
    el.className = 'fail';
  }

  function feed(worker) {
    if (queue.length === 0) return;
    const job = queue.shift();
    worker.postMessage({
      type: 'paint', tile: job.tile,
      land: job.land, tempByte: job.tempByte, precipByte: job.precipByte,
      cat: job.cat, seaState: job.seaState, wind: job.wind, cyc: job.cyc,
      iso: job.iso, termByte: job.termByte, page: job.page, windDir: job.windDir, periph: job.periph,
      // FS2 §A name/pressure trailer: the DECODED name char codes + pressure byte +
      // decoded hPa (for the radar drift-frame texture path). The worker appends the
      // LEN-gated trailer (mirrors gw.tilePayload) so the spiral's name+eye-pressure
      // travel on the tape and land in the Z80 PBUF byte-exact.
      pressureByte: job.pressureByte, nameCodes: job.nameCodes, pressureHpa: job.pressureHpa,
      // FS7 phen list (mutually exclusive with the trailer): one-cell MICRO marks
      // for the WEATHER page. The worker appends [count,(x,y,code)...] after TERMV
      // for a tier<CYCLONE tile (mirrors gw.tilePayload).
      phen: job.phen,
      // Wildfire free-run flag: the worker harvests 2 flame-flicker phases.
      fireAnim: job.fireAnim,
      fireNameCodes: job.fireNameCodes, fireNameRow: job.fireNameRow,
      // Wildfire smoke density (WEATHER): worker hatches the tile background.
      smokeByte: job.smokeByte,
      // Smooth-temp within-tile gradient (TEMP page): signed per-cell level steps.
      smoothGx: job.smoothGx, smoothGy: job.smoothGy,
      // PRESSURE H/L sub-tile anchor: {x,y} top-left cell for the centre glyph, so the
      // letter sits on the dense field's extremum node inside its innermost closed isobar
      // instead of at the tile centre. Absent -> worker uses the legacy centred anchor.
      centreCell: job.centreCell,
      // TEMP number stamp gate (iso bit6): sparse readings riding the isotherms. Was
      // built on the job but never dispatched, so TEMP carried NO numbers at all;
      // wired 2026-07-16.
      tempLabel: job.tempLabel,
      // FS7-T9: tape-loop frame index (echoed back so onPainted can route the
      // rendered canvas into the cache instead of the live wall). undefined = burst.
      // gen is the build generation (echoed back too) so a stale reply is dropped.
      frame: job.frame, gen: job.gen,
      bgen: job.bgen,   // page-cache burst generation (echoed back)
      // WIND drifting-dot per-phase overlay (whole-cell positions from windflow);
      // the worker draws base+dots through the ULA and harvests the drift frames.
      windDots: job.windDots,
      // Native day/night terminator: per-cell night bitmap (worker.applyNight).
      nightCells: job.nightCells,
      // Marching night-sweep frames (worker cycles them for the animated terminator on
      // no-tape pages like WIND + the still view — was built on the job but never sent,
      // so the sweep path was dead; wired 2026-07-16).
      nightFrames: job.nightFrames,
      // Native SATELLITE cloud motion frames (worker pokes them like windDots).
      satFrames: job.satFrames,
      // Native SEA swell motion frames (worker pokes sea cells only).
      seaFrames: job.seaFrames,
      // Native isoline cells (worker pokes them over the base like applyNight).
      lineCells: job.lineCells,
      // WEATHER synoptic overlays: downwind smoke-field cells + front line/pip cells
      // + coast outline mask (display-only worker pokes; see docs/MONOCHROME-WX-DESIGN.md).
      smokeCells: job.smokeCells,
      // Per-tab identity label plate (bottom-left tiles; worker pokes it LAST, opaque,
      // re-applied per animation phase / loop frame like the other overlays).
      labelCells: job.labelCells,
      frontCells: job.frontCells,
      termLineCells: job.termLineCells,   // WEATHER terminator line (worker.applyTerm)
      chartCells: job.chartCells,         // WEATHER synoptic chart (worker.applyChart)
      outlineMask: job.outlineMask,
      windStreakCells: job.windStreakCells,
      precipCells: job.precipCells,
      // Marching-squares contour corners (TEMP/PRESSURE): the four SHARED tile-corner
      // field bytes. The worker flags byte6 bit4 + appends them so the machine draws its
      // own seam-continuous curves (mirrors gw.tilePayload). undefined -> legacy render.
      corners: job.corners,
      // DENSE continental field (TEMP): a real 5x5 temperature grid (25 bytes) for a
      // continental-desk tile. Takes precedence over corners — the worker ships a LEN-36
      // frame and the machine runs ct_run4f on real data. undefined -> corners/legacy.
      fieldCells: job.fieldCells,
      // SEA-BIAS plate anchor (owner 2026-07-24): host-picked least-land caption spot;
      // the worker appends [centreCol, nameTopRow] after the name codes (LEN-gated).
      plateAnchor: job.plateAnchor,
    });
  }

  function onPainted(worker, msg) {
    if (msg.frame != null) {           // a tape-loop frame tile (track/contour)
      // generation guard: a reply from a superseded buildTracks() (page/span switched,
      // or a refresh rebuilt, while its jobs were still in flight) must NOT write the
      // new trackImgs or decrement the new trackPending — just drop it and keep draining.
      if (msg.gen !== trackGen) { feed(worker); return; }
      const bufs = msg.bufs || [];
      if (trackImgs && trackImgs[msg.frame] && bufs[0])
        trackImgs[msg.frame][msg.tile] = new ImageData(new Uint8ClampedArray(bufs[0]), msg.w, msg.h);
      trackPending--;
      feed(worker);                    // keep draining the queued frame-tile jobs
      return;
    }
    const cv = ctxs[msg.tile];
    const bufs = msg.bufs || (msg.buf ? [msg.buf] : []);
    const frames = bufs.map((b) => new ImageData(new Uint8ClampedArray(b), msg.w, msg.h));
    tileFrames[msg.tile] = frames;
    cv.putImageData(frames[0], 0, 0);
    // page cache: store the harvested frames, but ONLY if this reply belongs to the
    // current burst (a stale reply from a page the user switched away from is dropped
    // so it can't pollute the wrong page's cache).
    if (msg.bgen === burstGen && burstKey != null) {
      const pc = pageCache.get(burstKey);
      if (pc && pc.gen === burstGen) {
        if (!pc.frames[msg.tile]) pc.done++;
        pc.frames[msg.tile] = frames;
      }
    }
    paintedCount++;
    $('s-painted').textContent = paintedCount + '/100';
    const elapsed = (performance.now() - burstStart) / 1000;
    if (elapsed > 0) $('s-fps').textContent = (paintedCount / elapsed).toFixed(1) + ' tiles/s';
    if (paintedCount >= N * N) {
      lastBurstMs = performance.now() - burstStart;
      $('s-fps').textContent = (100 / (lastBurstMs / 1000)).toFixed(1) + ' tiles/s (' + (lastBurstMs / 1000).toFixed(1) + 's burst)';
      refreshing = false;
      // No host overlay to repaint: isobars/isotherms, the day/night terminator, the
      // satellite cloud field and SEA swell are all machine cells poked into the tiles
      // during the burst (worker.js), so the wall is complete when the tiles land.
    }
    feed(worker);   // keep draining (tape-loop frame-tile jobs may still be queued)
  }

  // Cache-bust the worker URL. `new Worker()` loads via the browser's per-URL script
  // cache, which a normal reload does NOT revalidate — so an edited worker.js would keep
  // serving the STALE worker after a plain reload (gotcha #3), silently pairing new app.js
  // with old worker logic (e.g. host isolines retired here but the old worker never sparing
  // the machine's own curve cells -> blank TEMP). A per-load version query forces a fresh
  // worker whenever this page loads, so the two halves never drift.
  const WORKER_URL = '/web/worker.js?v=' + Date.now();
  function initWorkers() {
    for (let i = 0; i < POOL; i++) {
      const wk = new Worker(WORKER_URL);
      wk.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') { readyCount++; if (readyCount === POOL) startWall(); }
        else if (msg.type === 'painted') onPainted(wk, msg);
      };
      wk.postMessage({ type: 'init', id: i, template });
      workers.push(wk);
    }
    $('s-workers').textContent = POOL;
  }

  // Read the server-side NHC snapshot (same origin) for live cyclone naming. The
  // node scheduler (tools/refresh-nhc.js) writes data/nhc-live.json each cycle; the
  // browser can't hit the CORS-blocked NHC endpoint itself. Returns the normalized
  // storm list (already in matchNhcStorm's shape) or [] on absent/stale/malformed.
  // Honest source of the storms liveNhc() last returned: 'nhc-live' (server
  // snapshot), 'nhc-fixture' (FS8-F4 empty-live fallback), or 'none'. Surfaced in
  // the status bar so the wall NEVER claims live data it did not have.
  let nhcSource = 'none';
  async function liveNhc() {
    // 1) PRIMARY: the server-side live snapshot (tools/refresh-nhc.js writes it).
    try {
      const r = await fetch('/data/nhc-live.json', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        let storms = [];
        if (Array.isArray(o.storms)) storms = o.storms;
        else if (o.activeStorms && NHC) storms = NHC.parse(o);   // tolerate a raw feed shape
        if (!feedFresh(o, 'NHC')) storms = [];
        if (storms.length) { nhcSource = 'nhc-live'; return storms; }
      }
    } catch (e) { /* quiet feed handled below */ }
    // FS8-F4 fallback RETIRED (owner 2026-08-04: "why are you showing 2 year old
    // hurricanes?!"): an empty live NHC list used to substitute the archived
    // 2024-09-27 capture (Helene/Isaac/John), painting two-year-old storms at
    // their 2024 positions on today's wall — and into the posted product loops.
    // A quiet Atlantic is REAL weather: quiet feed => quiet map. The fixture
    // file stays for proofs/demos only; it must never reach the live wall.
    nhcSource = 'none';
    return [];
  }

  // Read the server-side JTWC snapshot (same origin) for W-Pac/Indian/S-Hemi
  // typhoon naming + authority-forced spirals. tools/refresh-jtwc.js writes
  // data/jtwc-live.json each cycle (the browser can't hit the CORS-blocked navy
  // endpoint). Returns the normalized authority-storm list (forced:true) or [] on
  // absent/empty/malformed — an empty JTWC feed is the NORMAL off-season case, so
  // there is NO archived-real fixture fallback here (an out-of-date typhoon would be
  // worse than silence). Basin-disjoint with NHC; detectCyclones dedups the merge.
  let jtwcCount = 0;
  async function liveJtwc() {
    jtwcCount = 0;
    try {
      const r = await fetch('/data/jtwc-live.json', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        const storms = feedFresh(o, 'JTWC') && Array.isArray(o.storms) ? o.storms.filter(Boolean) : [];
        jtwcCount = storms.length;
        return storms;
      }
    } catch (e) { /* feed absent this cycle -> no W-Pac systems (honest degrade) */ }
    return [];
  }

  // Read the server-side EMERGENCY snapshots (same origin): GDACS weather emergencies
  // (tools/refresh-gdacs.js -> data/gdacs-live.json; WF->FIRE, FL->FLOOD glyph — DR/TC
  // carry no glyph here, TC is owned by the spiral layer) + BC significant fires
  // (tools/refresh-bc.js -> data/bc-live.json -> FIRE). Returns a unified mark list
  // [{tile, kind:'FIRE'|'FLOOD'}] for GW.applyEmergencies, or [] on any absent/empty/
  // malformed snapshot (honest degrade — an emergency outage never breaks the wall).
  let emergencyCount = 0;
  async function liveEmergencies() {
    emergencyCount = 0;
    const marks = [];
    const GLYPH_OF = { WF: 'FIRE', FL: 'FLOOD' };   // DR/TC deliberately omit a glyph
    try {
      const r = await fetch('/data/gdacs-live.json', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        for (const mk of (feedFresh(o, 'GDACS') && Array.isArray(o.marks) ? o.marks : [])) {
          const kind = GLYPH_OF[mk && mk.eventType];
          // Only GENUINE emergencies: GDACS Orange/Red. Green = routine notification
          // (a swarm of low-severity fire notices, many on ocean-centre tiles) — drop.
          const lvl = String((mk && mk.alertLevel) || '').toLowerCase();
          if (kind && mk.tile != null && (lvl === 'orange' || lvl === 'red'))
            marks.push({ tile: mk.tile | 0, kind, lat: mk.lat, lon: mk.lon, level: lvl });
        }
      }
    } catch (e) { /* GDACS absent this cycle -> no global emergencies (honest degrade) */ }
    try {
      const r = await fetch('/data/bc-live.json', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        for (const mk of (feedFresh(o, 'BC fire') && Array.isArray(o.marks) ? o.marks : []))
          if (mk && mk.tile != null) marks.push({ tile: mk.tile | 0, kind: 'FIRE', lat: mk.lat, lon: mk.lon, name: mk.name || null, level: mk.flash ? 'red' : 'orange' });
      }
    } catch (e) { /* BC absent this cycle -> no BC fires (honest degrade) */ }
    try {
      const r = await fetch('/data/nifc-live.json', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        for (const mk of (feedFresh(o, 'regional fire') && Array.isArray(o.marks) ? o.marks : []))
          if (mk && mk.tile != null) marks.push({ tile: mk.tile | 0, kind: 'FIRE', lat: mk.lat, lon: mk.lon, name: mk.name || null, level: mk.level || 'orange' });
      }
    } catch (e) { /* NIFC absent this cycle -> no US fires (honest degrade) */ }
    try {
      const r = await fetch('/data/effis-live.json', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        for (const mk of (feedFresh(o, 'regional fire') && Array.isArray(o.marks) ? o.marks : []))
          if (mk && mk.tile != null) marks.push({ tile: mk.tile | 0, kind: 'FIRE', lat: mk.lat, lon: mk.lon, name: mk.name || null, level: mk.level || 'orange' });
      }
    } catch (e) { /* EFFIS absent this cycle -> no EU fires (honest degrade) */ }
    const merged = mergeFireMarks(marks);
    emergencyCount = merged.length;
    return merged;
  }
  // Merge fire/flood marks from all sources onto tiles (GDACS severity + BC/NIFC/EFFIS
  // names may hit the SAME tile). One mark per (tile,kind): the HIGHEST severity wins
  // (red > orange), and a REAL name (from a named source) beats a nameless GDACS notice.
  // Position prefers a named mark's lat/lon (it's the specific fire, not the coarse cell).
  function mergeFireMarks(marks) {
    const by = new Map();
    for (const m of marks) {
      if (!m) continue;
      const key = (m.tile | 0) + ':' + m.kind;
      const prev = by.get(key);
      if (!prev) { by.set(key, { ...m }); continue; }
      if (m.level === 'red') prev.level = 'red';
      if (!prev.name && m.name) { prev.name = m.name; if (m.lat != null) { prev.lat = m.lat; prev.lon = m.lon; } }
    }
    return Array.from(by.values()).sort((a, b) => a.tile - b.tile);
  }
  // WEATHER is a HIGH-LEVEL WORLD SUMMARY, not a wildfire map (owner 2026-07-15). The
  // globe carries 100s of fires; letting every named fire onto the summary buried the
  // pressure/precip/temp/storm picture under a wall of flame plates. Hard-cap the fire
  // glyphs the summary draws to the few MOST-SIGNIFICANT (red before orange), and spread
  // them so one region can't hog the cap. FLOOD marks pass through untouched. Display-only
  // (posting path in src/* is unchanged); the desk/emergency view keeps every fire+name.
  function capSummaryFires(marks, maxFires) {
    if (!Array.isArray(marks)) return marks;
    const fires = [], rest = [];
    for (const m of marks) (m && m.kind === 'FIRE' ? fires : rest).push(m);
    if (fires.length <= maxFires) return marks;
    // red (flash) outranks orange; then spread across coarse regions so the cap isn't
    // eaten by one busy area (e.g. a single continent's fire season).
    fires.sort((a, b) => (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1) || a.tile - b.tile);
    const kept = [], seenRegion = new Set();
    for (const pass of [0, 1]) {
      for (const f of fires) {
        if (kept.length >= maxFires) break;
        if (kept.includes(f)) continue;
        const region = (f.tile / N | 0) + ':' + ((f.tile % N) / 4 | 0);   // coarse 18deg x ~14deg cell
        if (pass === 0 && seenRegion.has(region)) continue;   // pass 0: one per region
        seenRegion.add(region); kept.push(f);
      }
    }
    return rest.concat(kept.slice(0, maxFires));
  }

  // Bold wildfire ZONES (WEATHER, owner 2026-07-21) — the fix for "wildfires ravaging North
  // America, yet you'd never know." Bin ALL live fires (nifc US, effis EU, bc Canada) onto
  // tiles, score each tile's real fire load (incident count + largest incident acreage),
  // and return intensity zones (1..3). UNCAPPED — replaces the old FIRE_CAP=4 dot summary +
  // dead AOD smoke. The strongest few incidents carry a name; the rest are pure zone fill.
  const HA_TO_ACRE = 2.471;
  // Latest computed WEATHER overlay fields (rebuilt each refresh in the try-block
  // below): the downwind smoke field's per-tile graded cells and the per-tile front
  // line+pip cells. Read by startBurst when assembling WEATHER jobs.
  let weatherSmokeCells = null, weatherFrontCells = null;
  // Last burst's fire-zone list, stashed for the FIRE smoke time-lapse (the loop builder
  // re-runs the plume per archived hour against these sources; zones refresh each burst).
  let lastFireZones = [];
  // Raw per-feed fire lists from the last refresh — the FIRE loop swaps the FIRMS
  // list for an archived hour's snapshot and rebuilds zones per frame (2026-08-04).
  let lastFireFeeds = { nifc: [], effis: [], bc: [], firms: [] };
  async function computeFireZones() {
    // firms-live: NASA FIRMS global VIIRS complexes for everywhere the dedicated feeds
    // don't reach (Asia/Oceania/Africa/S.America — owner 2026-07-29). FIRMS fires carry
    // no name and no acreage (honest: satellites count detections, not hectares), so
    // they weigh in through the incident-count ladder only and never take a name bar.
    const feeds = { nifc: '/data/nifc-live.json', effis: '/data/effis-live.json', bc: '/data/bc-live.json', firms: '/data/firms-live.json' };
    const lists = { nifc: [], effis: [], bc: [], firms: [] };
    for (const keyF of Object.keys(feeds)) {
      try { const r = await fetch(feeds[keyF], { cache: 'no-store' }); if (r.ok) { const o = await r.json(); lists[keyF] = feedFresh(o, keyF + ' fire') && Array.isArray(o.fires) ? o.fires : []; } }
      catch (e) { /* feed absent this cycle -> honest degrade (no fabricated fire) */ }
    }
    lastFireFeeds = lists;
    return zonesFromFires([lists.nifc, lists.effis, lists.bc, lists.firms]);
  }
  // Pure zone builder: fire lists (any mix of feeds) -> intensity zones 1..3.
  function zonesFromFires(fireLists) {
    const perTile = new Map();   // tile -> { count, maxAcres, name }
    for (const fires of fireLists) {
      if (!Array.isArray(fires)) continue;
      for (const f of fires) {
        if (!f || f.lat == null || f.lon == null) continue;
        const row = Math.max(0, Math.min(N - 1, Math.round((81 - f.lat) / 18)));
        let dlon = f.lon; if (dlon > 180) dlon -= 360; if (dlon < -180) dlon += 360;
        const col = Math.max(0, Math.min(N - 1, Math.round((dlon + 162) / 36)));
        const tile = row * N + col;
        const acres = f.acres != null ? f.acres : (f.areaHa != null ? f.areaHa * HA_TO_ACRE : 0);
        // sub-tile cell from the fire's real lat/lon (tile centre lat=81-18row, lon=-162+36col)
        const tLat = 81 - 18 * row, tLon = -162 + 36 * col;
        let dL = f.lon - tLon; if (dL > 180) dL -= 360; if (dL < -180) dL += 360;
        const fx = Math.round(16 + (dL / 18) * 14), fy = Math.round(12 - ((f.lat - tLat) / 9) * 10);
        const e = perTile.get(tile) || { count: 0, maxAcres: 0, name: '', sx: 0, sy: 0 };
        e.count++; e.sx += fx; e.sy += fy;
        if (acres > e.maxAcres) { e.maxAcres = acres; if (f.name) e.name = String(f.name); }
        perTile.set(tile, e);
      }
    }
    const zones = [];
    for (const [tile, e] of perTile) {
      let it = e.count >= 20 ? 3 : e.count >= 5 ? 2 : 1;   // load by incident count...
      if (e.maxAcres >= 100000) it = 3;                    // ...forced to max by a mega-fire
      else if (e.maxAcres >= 20000 && it < 2) it = 2;
      zones.push({ tile, intensity: it, count: e.count, maxAcres: e.maxAcres, name: e.name,
        cx: Math.round(e.sx / e.count), cy: Math.round(e.sy / e.count) });   // real fire centroid
    }
    // Name only the strongest few incidents so the map stays legible (the zones carry the story).
    zones.sort((a, b) => b.maxAcres - a.maxAcres);
    zones.forEach((z, i) => { z.name = (i < 4 && z.name) ? cleanFireName(z.name) : null; });
    return zones;
  }
  function cleanFireName(s) {
    return String(s).toUpperCase().replace(/[^A-Z ]/g, '').trim().split(/\s+/)[0].slice(0, 8) || null;
  }
  // FIRE-page precip relief: real precipitation drawn as a sparse DOT lattice (the
  // WMO rain-dot idiom; texture distinct from the smoke checkers and wind streaks),
  // spacing by the real intensity band. ZX81 '.' glyph (code 27). null = dry tile.
  function firePrecipCells(wx) {
    const band = L.precipToBand(wx.precipMm);
    if (!band) return null;
    const step = band >= 3 ? 2 : band === 2 ? 3 : 4;
    const cells = [];
    for (let y = 1; y < L.TILE_H - 1; y += step)
      for (let x = (y & 1) ? 2 : 0; x < L.TILE_W; x += step)
        cells.push({ i: y * L.TILE_W + x, c: 27 });
    return cells;
  }

  // ---- FS2 DEMO path ---------------------------------------------------------
  // Load the demo fixture (weather + subSamples + embedded NHC feed) and drive the
  // FULL detect->periphery->burst tail off it — zero network, zero API calls. Shows
  // every FS2 marker at once: tropical spiral+name+pressure, extratropical bold-L,
  // ordinary L/H. See NOTES.md (FS2 / how to drive the demo wall).
  async function loadDemoFixture() {
    const r = await fetch('/data/' + DEMO_FILE + '.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('demo fixture HTTP ' + r.status);
    const o = await r.json();
    if (!validWeatherArray(o.weather)) throw new Error('demo fixture: bad weather array');
    const nhc = (o.nhc && NHC) ? NHC.parse(o.nhc) : [];
    return { data: o.weather, subs: o.subSamples || [], nhc };
  }
  async function refreshDemo() {
    paintedCount = 0;
    $('s-painted').textContent = '0/100';
    let dm;
    try { dm = await loadDemoFixture(); }
    catch (err) {
      console.error('demo fixture load failed', err);
      $('s-api').textContent = 'NO DEMO FIXTURE'; $('s-api').className = 'fail';
      refreshing = false; scheduleNext(); return;
    }
    const data = dm.data;
    $('s-api').textContent = 'DEMO (' + DEMO_FILE + ')'; $('s-api').className = 'ok';
    $('s-last').textContent = new Date().toLocaleTimeString();
    applyMarinePill('synthetic');   // fixture seas are synthetic, named honestly
    $('s-nhc') && ($('s-nhc').textContent = String(dm.nhc.length));
    try {
      const haveSubs = dm.subs.length === subPts.length;
      GW.detectCyclones(data, seaIdx, haveSubs ? subPts : [], haveSubs ? dm.subs : [], N, dm.nhc);
      // FS7-T7 WEATHER FRONT PAGE: importance-ranked + FRONT_CAP-capped micro-marks
      // + tightest-isobar 'L'. Needs computeIsobars' pressIsoByte, so run the iso
      // layers here (startBurst recomputes them idempotently below).
      GW.computeIsotherms(data, N); GW.computeIsobars(data, N); GW.computeIsotachs(data, N); GW.computeSmoothGrad(data, N);
      const front = GW.computeWeatherFrontPage(data, haveSubs ? subPts : [], haveSubs ? dm.subs : [], null, landMasks);
      $('s-front').textContent = front.ranked.length
        + (front.ranked.length > front.top.length ? ' (top ' + front.top.length + ')' : '');
      const cnt = seaIdx.filter((i) => data[i] && data[i].cycloneName && (data[i].cycloneTier | 0) >= L.CYC.STORM).length;
      $('s-cyc').textContent = String(cnt); $('s-cyc').className = cnt ? 'fail' : 'ok';
    } catch (e) { $('s-cyc').textContent = '–'; $('s-front').textContent = '–'; }
    invalidatePageCache();   // new map -> drop stale page-cache frames
    lastData = data;
    lastSubResults = dm.subs || [];
    await loadContinentalField();   // dense continental fields (if the scheduler wrote them)
    startBurst(data);   // computes isotherms + periphery + L/H centres, then paints
    buildTracks();      // demo fixtures carry no hourly history -> "next refresh"
    scheduleNext();
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    if (DEMO_FILE) return refreshDemo();
    paintedCount = 0;
    $('s-painted').textContent = '0/100';

    const snap = await schedulerWeatherSnapshot();
    if (!snap) {
      failStreak++;
      $('s-api').textContent = 'NO SCHEDULER DATA';
      $('s-api').className = 'fail';
      refreshing = false;
      scheduleNext();
      return;
    }

    failStreak = 0;
    const data = snap.data;
    const subResults = snap.subs || [];
    subPts = subResults.length
      ? subResults.map((s) => ({ tileIdx: s.tileIdx, pos: s.pos, lat: s.lat, lon: s.lon }))
      : [];

    const ageMin = snap.at ? Math.max(0, Math.round((Date.now() - snap.at) / 60000)) : 0;
    const source = snap.source || '';
    const forecastSource = snap.sources && snap.sources.forecast;
    if (snap.fallback) {
      $('s-api').textContent = 'DEMO SNAPSHOT';
      $('s-api').className = 'fail';
    } else if (forecastSource === 'live' || /^live/.test(source)) {
      $('s-api').textContent = 'SCHEDULER OK (' + ageMin + 'm old)';
      $('s-api').className = 'ok';
    } else {
      $('s-api').textContent = 'SCHEDULER ' + (source || 'snapshot') + ' (' + ageMin + 'm old)';
      $('s-api').className = 'fail';
    }
    $('s-last').textContent = snap.at ? new Date(snap.at).toLocaleTimeString() : new Date().toLocaleTimeString();
    if (snap.sources && snap.sources.marine) applyMarinePill(snap.sources.marine);
    else if (/synthetic/.test(source)) applyMarinePill('synthetic');
    else applyMarinePill(seaIdx.some((i) => data[i] && typeof data[i].waveHeight === 'number') ? 'live' : 'failed(no-marine)');

    // Authority storm feed: NHC (Atlantic/E+C Pac) + JTWC (W-Pac/Indian/S-Hemi),
    // merged into ONE list (basin-disjoint; detectCyclones dedups). Browser reads
    // only same-origin scheduler snapshots.
    const nhcStorms = await liveNhc();
    const jtwcStorms = await liveJtwc();
    const authStorms = nhcStorms.concat(jtwcStorms);
    $('s-nhc') && ($('s-nhc').textContent = String(nhcStorms.length)
      + (jtwcCount ? ' +' + jtwcCount + ' JTWC' : ''));

    let cycloneCount = 0;
    try {
      const haveSubs = subResults.length === subPts.length;
      GW.detectCyclones(data, seaIdx, haveSubs ? subPts : [], haveSubs ? subResults : [], N, authStorms);
      GW.computeIsotherms(data, N); GW.computeIsobars(data, N); GW.computeIsotachs(data, N); GW.computeSmoothGrad(data, N);
      const front = GW.computeWeatherFrontPage(data, haveSubs ? subPts : [], haveSubs ? subResults : [], null, landMasks);
      // Emergency overlay LAST (below the cyclone layer), cyclones keep precedence.
      // Research-grounded synoptic layering (docs/MONOCHROME-WX-DESIGN.md): FIRE =
      // POINT markers at the incidents' real centroids (NOAA HMS/AirNow convention);
      // SMOKE = a separate AREA field advected downwind on the real wind (smokeflow);
      // FRONTS = the synoptic backbone from the real thermal gradient + wind advection.
      // FLOODS keep the point-icon path.
      const floodMarks = (await liveEmergencies()).filter((m) => m && m.kind === 'FLOOD');
      GW.applyEmergencies && GW.applyEmergencies(data, floodMarks, N);
      const fireZones = await computeFireZones();
      lastFireZones = fireZones;   // stashed for the FIRE smoke time-lapse
      GW.applyFireZones && GW.applyFireZones(data, fireZones, N, landMasks);   // masks: flames snap to land
      // Downwind smoke FIELD: sources = the fire zones, wind = the same per-tile
      // vectors the WIND page transmits. Per-tile graded dither cells, poked
      // display-only by the worker (applySmokeField) — pending its Z80-native move.
      weatherSmokeCells = null;
      if (window.WW_SMOKEFLOW && fireZones.length) {
        const svecs = new Array(N * N);
        for (let t = 0; t < N * N; t++) {
          const w = data[t] || {};
          svecs[t] = (w.windKmh != null && w.windDir != null)
            ? { oct: L.windDirToOctant(w.windDir), kmh: w.windKmh } : { oct: -1, kmh: 0 };
        }
        weatherSmokeCells = window.WW_SMOKEFLOW.simulate({ N, vecs: svecs, sources: fireZones });
      }
      // FRONTS: OFF the global wall (owner 2026-07-31 — at ~110 km/cell the strokes
      // are unreadable at world zoom, curated or not). The analysis renders ONLY on
      // the continental desk crops (tools/refresh-report.js runContinental ->
      // stitchWallFrames opts.frontCells), where the zoom gives the teeth room.
      weatherFrontCells = null;
      $('s-front').textContent = front.ranked.length
        + (front.ranked.length > front.top.length ? ' (top ' + front.top.length + ')' : '');
      cycloneCount = seaIdx.filter((i) => data[i] && data[i].cycloneName && (data[i].cycloneTier | 0) >= L.CYC.STORM).length;
      $('s-cyc').textContent = cycloneCount ? String(cycloneCount) : '0';
      $('s-cyc').className = cycloneCount ? 'fail' : 'ok';
    } catch (e) { $('s-cyc').textContent = '–'; $('s-front').textContent = '–'; }

    lastSubResults = subResults;
    invalidatePageCache();   // new map -> drop stale page-cache frames
    lastData = data;
    await loadContinentalField();   // dense continental fields (if the scheduler wrote them)
    startBurst(data);
    buildTracks();
    scheduleNext();
  }

  // Build the 100-tile job queue from a resolved weather map and kick the workers.
  // Split out of refresh() so the RADAR/CLASSIC toggle can re-render the last map
  // instantly with zero API calls.
  // Per-tab identity label (owner 2026-07-29: "it's unclear what the loop represents if
  // you're just jumping in from, say, a bluesky link... a per-tab label on the lower
  // left corner of the page in reverse video... Apply this to each tab, visible still
  // and looping"). Names are owner's, except the ZX81 charset has no '&' (and the block
  // font is digits+letters only), so WILDFIRES & SMOKE is spelt out with AND. The
  // strip is texture.tabLabelCells split across the bottom-left tile + its neighbour;
  // ships as labelCells (the night/smoke display-only poke idiom), so the worker
  // re-applies it on every animation phase and every loop frame.
  const TAB_LABELS = {};
  TAB_LABELS[L.PAGE.TEMP] = 'TEMPERATURE';
  TAB_LABELS[L.PAGE.WEATHER] = 'WEATHER';
  TAB_LABELS[L.PAGE.FIRE] = 'WILDFIRES AND SMOKE';
  TAB_LABELS[L.PAGE.WIND] = 'WIND';
  TAB_LABELS[L.PAGE.SEA] = 'SEA STATE';
  TAB_LABELS[L.PAGE.PRESSURE] = 'PRESSURE';
  TAB_LABELS[L.PAGE.SATELLITE] = 'SATELLITE';
  function textToZX(s) {
    const out = [];
    for (const ch of String(s).toUpperCase()) {
      if (ch >= 'A' && ch <= 'Z') out.push(38 + ch.charCodeAt(0) - 65);
      else if (ch >= '0' && ch <= '9') out.push(28 + ch.charCodeAt(0) - 48);
      else out.push(0);                                   // space / unmapped -> blank
    }
    return out;
  }
  const tabLabelMemo = new Map();                         // page -> {tile: [{i,c}]}
  function tabLabelFor(page) {
    const p = page | 0;
    if (tabLabelMemo.has(p)) return tabLabelMemo.get(p);
    const name = TAB_LABELS[p];
    let byTile = null;
    if (name && window.WW_TEXTURE && window.WW_TEXTURE.tabLabelCells) {
      byTile = {};
      const baseT = 0;                                    // top-left tile (owner 2026-07-30)
      for (const c of window.WW_TEXTURE.tabLabelCells(textToZX(name))) {
        const t = baseT + ((c.x / L.TILE_W) | 0);
        if (t >= N) continue;                             // never wraps past the top row
        (byTile[t] = byTile[t] || []).push({ i: c.y * L.TILE_W + (c.x % L.TILE_W), c: c.c });
      }
    }
    tabLabelMemo.set(p, byTile);
    return byTile;
  }

  function startBurst(data) {
    refreshing = true;
    paintedCount = 0;
    $('s-painted').textContent = '0/100';
    // page cache: a fresh generation + a cache slot for (this map, this page). Stale
    // replies from a superseded burst are dropped by burstGen in onPainted.
    burstGen++;
    burstKey = mapVersion + ':' + activePage;
    if (!pageCache.has(burstKey))
      pageCache.set(burstKey, { frames: new Array(N * N), cyc: new Array(N * N).fill(false), done: 0, gen: burstGen });
    else pageCache.get(burstKey).gen = burstGen;
    // iso-line layers: compute each tile's band-edge mask from its neighbours
    // across the whole grid for each contoured variable (isotherms/isobars/
    // isotachs — only the active page's mask actually rides the wire on byte6;
    // gateway.tilePayload + the per-page iso select below pick which).
    GW.computeIsotherms(data, N);
    GW.computeIsobars(data, N);
    GW.computeIsotachs(data, N);
    GW.computeSmoothGrad(data, N);
    // SATELLITE (FS7-T5): real solar-position day/night per tile (no API call) +
    // its terminator edge mask, computed fresh every burst so the terminator
    // visibly creeps as the day goes on. The live wall passes the real current
    // time (Date.now()); computeSatellite takes the epoch as an argument (DR-19 —
    // deterministic for fixtures/proofs, live here).
    GW.computeSatellite(data, N, (t) => coast.tileCenterLonLat((t / N) | 0, t % N), Date.now());
    // cyclone periphery: flag every tile within a storm's radius with a band code
    // so a big hurricane spans a multi-tile spiral (recomputed each burst — cheap).
    GW.computePeriphery(data, seaIdx, N);
    const page = activePage;
    // build the job queue for the active page: every machine still gets the full
    // payload (temp+precip+cat+sea+wind+cyclone+iso), plus the page byte + wind
    // direction; the machine draws only the page's variable. Cyclone markers +
    // rotation ride along on every page.
    queue = [];
    // Native day/night: one sub-solar solve per burst, sampled per cell below. The
    // terminator visibly creeps as the geometry is recomputed every burst.
    const nightGeom = computeNightGeom();
    // SATELLITE still: the global sweep rasters, computed ONCE per burst and sliced
    // per tile below. Storm heads use the cached canonical track when present (kick
    // a refresh for next time); a cold cache falls back to the live agency fix.
    let satStillRasters = null;
    if (page === L.PAGE.SATELLITE) {
      if (!stormTracksCache) loadStormTracks();
      satStillRasters = buildSatStillRasters(data);
    }
    // SEA still: the global wave-field rasters, computed ONCE per burst and sliced
    // per tile below (same model as satellite). Storm heads ride the canonical track.
    let seaWall = null;
    if (page === L.PAGE.SEA) {
      if (!stormTracksCache) loadStormTracks();
      seaWall = buildSeaWall(data);
    }
    // Governing spec for THIS page: does it show the day/night terminator, and animate
    // it? (SPEC.TAB_SPEC — SATELLITE + TEMP show+animate by default; others off.) The
    // SATELLITE terminator rides its own satFrames sweep; the scalar terminator (TEMP)
    // is poked as a marching night hatch here so it SWEEPS identically to satellite,
    // clock-driven by the ONE shared sub-solar model (owner: "the terminators stopped").
    const pageSpec = SPEC.specForPage(page);
    const scalarTerm = !!(pageSpec && pageSpec.terminator.show && page !== L.PAGE.SATELLITE);
    const scalarTermAnim = scalarTerm && pageSpec.terminator.animate;
    // Native isolines for the current scalar page (rasterised once, sliced per tile).
    const lineMasks = contourLineCells(page, data);
    // FIRE page (owner 2026-07-21): fire + smoke + only fire-RELEVANT weather. Wind
    // streaks (spread driver) from the windflow sim, static phase-0 — the streak's
    // head/tail shape carries direction even in a still; flames still flicker.
    const firePage = page === L.PAGE.FIRE;
    // FIRE-RELEVANT means NEAR THE FIRES: wind streaks + precip relief draw ONLY
    // inside the fire REGION (fire tiles ∪ smoke-covered tiles, dilated one tile) —
    // global wind churn and far-away rain dilute the story to noise (v1 lesson).
    let fireWindStreaks = null, fireRegion = null;
    if (firePage) {
      fireRegion = new Set();
      for (let t = 0; t < N * N; t++) {
        const w = data[t] || {};
        if (w.fireMark || (weatherSmokeCells && weatherSmokeCells[t] && weatherSmokeCells[t].length)) fireRegion.add(t);
      }
      for (const t of [...fireRegion]) {                       // dilate 1 (lon wraps)
        const r = (t / N) | 0, c = t % N;
        if (r > 0) fireRegion.add((r - 1) * N + c);
        if (r < N - 1) fireRegion.add((r + 1) * N + c);
        fireRegion.add(r * N + ((c + 1) % N));
        fireRegion.add(r * N + ((c + N - 1) % N));
      }
      // (fire wind-streak sim retired with the overlay — owner QC 2026-07-29)
    }
    // Day/night terminator LINE on WEATHER (owner 2026-07-31: "the old wall still
    // includes a time-accurate terminator"): smooth solar-geometry edge from
    // src/terminator.js at the wall clock, poked over background cells only
    // (worker applyTerm) — not the tile-grid termCell L's 7afcb38 banned.
    const termCellsMap = (page === L.PAGE.WEATHER && window.WW_TERMINATOR)
      ? window.WW_TERMINATOR.compute(Date.now()) : null;
    // WEATHER synoptic chart (owner 2026-08-02 "lines not tone"): rain areas as
    // scalloped dotted regions with a contained precip pictogram, gales as the
    // wind-streak pictogram at the wind peak. Computed once per burst from the
    // same snapshot readings (src/weather-chart.js, shared with the stitch /
    // poster path so the live wall and the posted product agree cell-for-cell).
    const chartTiles = (page === L.PAGE.WEATHER && window.WW_WEATHERCHART)
      ? window.WW_WEATHERCHART.compute({ weather: data, N }) : null;
    for (let t = 0; t < N * N; t++) {
      const wx = data[t] || { tempC: 0, precipMm: 0 };
      const tC = typeof wx.tempC === 'number' ? wx.tempC : 0;
      // WEATHER-front extreme markers (HOT/COLD/GALE) + legend rows carry a synthetic
      // glyphCat (7/8/9) so the machine stamps the big HEAT/COLD/GALE pictogram; every
      // other page uses the real weather category. Mirrors gw.tilePayload byte2.
      // FIRE: cat forced CLEAR — the routine weather category texture is not
      // fire-relevant; precip relief rides its own dot overlay instead.
      const cat = firePage ? L.weatherCodeToCat(0)
        : (page === L.PAGE.WEATHER && wx.glyphCat != null)
        ? (wx.glyphCat & 0xff)
        : L.weatherCodeToCat(wx.weatherCode || 0);
      const cycTier = wx.cycloneTier | 0, cycPos = wx.cyclonePos | 0;
      const namedCyclone = !!wx.cycloneName;
      // Named tropical cyclone markers are machine-rendered on EVERY page (owner
      // 2026-07-24: named storms with the name bar appear on all tabs — supersedes
      // the earlier SATELLITE/FIRE exclusions). The Z80's pg_cyc path already runs
      // on every page; this gate was the only thing hiding them.
      const shownCycTier = namedCyclone ? (wx.cycloneTier | 0) : L.CYC.NONE;
      const cycSuppress = wx.cycloneSuppress | 0;
      // FS2 §A trailer: the LEN-gated pressure + NHC name ride along ONLY on a
      // non-suppressed tier>=CYCLONE tile with a decodable pressure (the worker
      // appends them, mirroring gw.tilePayload). pressureByte==null / suppressed /
      // sub-cyclone => no trailer, byte-identical to the pre-FS2 frame.
      const pressureByte = L.pressureToByte(wx.cyclonePressureHpa);
      const nameCodes = (NHC && wx.cycloneName) ? NHC.nameToZX(wx.cycloneName, 10) : [];
      // byte6 is no longer used for scalar tile-edge outlines: those read as
      // unwanted bezels. TERMV remains the dedicated edge primitive for the
      // day/night terminator; TEMP/WIND/PRESSURE let their machine textures speak.
      // WEATHER byte6: bit6 = HOT/COLD numeric marker; bit5 = wildfire free-run (flame
      // flicker). Mirrors gw.tilePayload.
      const weatherTempMarker = page === L.PAGE.WEATHER && wx.tempMarker != null;
      const iso = page === L.PAGE.SATELLITE ? (wx.satIsoByte | 0)
        : page === L.PAGE.WEATHER ? ((weatherTempMarker ? 0x40 : 0) | (wx.fireMark ? 0x20 : 0))   // temp marker + flame free-run
        : firePage ? (wx.fireMark ? 0x20 : 0)          // FIRE: flame free-run only, no temp marker
        : 0;
      // byte0 is ALSO page-dependent: raw cloud-cover% (SATELLITE) vs temperature. On a
      // WEATHER HOT/COLD marker it carries the reading to stamp (tempMarker).
      const tempByte = page === L.PAGE.SATELLITE
        ? Math.max(0, Math.min(100, Math.round(wx.cloudCoverPct == null ? 0 : wx.cloudCoverPct)))
        : page === L.PAGE.PRESSURE ? pressureTempByte(wx.pressureHpa)
        : weatherTempMarker ? L.tempToByte(wx.tempMarker)
        : L.tempToByte(tC);
      // PRESSURE: the ocean is QUIET (owner QC 2026-07-24: "why is the sea stipple soup on the
      // pressure page"). pressureSeaState re-encodes the pressure band as wave/storm texture —
      // a SECOND encoding of the variable the isobars already draw, and SEA.STORM lays inverse
      // bands every 4th row. That was tolerable while the isobars were a sparse 4-corner
      // bilinear guess; once they marched the dense 5x5 field the ocean became stipple plus
      // curves plus inverse bands. This is the same ruling already applied to LAND on
      // 2026-07-15 (relightLandQuiet: "the DATA rides ONE treatment only"), which quieted the
      // continents and left the sea alone. Now both agree: the isobars own the PRESSURE sheet.
      const seaStateRaw = firePage ? L.SEA.CALM        // FIRE: sea state not fire-relevant
        : page === L.PAGE.PRESSURE ? L.SEA.CALM
        : seaSet.has(t) ? L.waveToSeaState(wx.waveHeight) : L.SEA.CALM;
      // Display-only (owner 2026-07-15 QC): the NODATA "vertical grey bars" test-card
      // (texture.seaCell) read as stray overlay-leak blocks scattered on the wall. A
      // marine-dataless sea cell now shows as CALM open water instead (honest — the
      // native swell only draws where waveHeight is present, so no fabricated waves).
      // The posting path (src/layout.waveToSeaState) is UNTOUCHED and still emits NODATA.
      const seaState = seaStateRaw === L.SEA.NODATA ? L.SEA.CALM : seaStateRaw;
      // Day/night terminator: SATELLITE-ONLY (owner 2026-07-21). The scalar sheets
      // (TEMP/WEATHER/WIND/PRESSURE/SEA) drew the terminator via texture.js termCell,
      // whose per-tile-EDGE strips traced the 10x10 tile grid as thick discontinuous
      // grey L's ("black L's jumping around the page") instead of one clean day/night
      // line. The 2026-07-16 all-pages experiment is reverted here. SATELLITE keeps its
      // terminator via satCell (greyscale-integrated night, reads clean). A proper
      // smooth machine-drawn terminator (solar-elevation field through the MG=4 contour
      // engine, like the isotherms/isobars) is the planned reinstatement for scalar pages.
      const termByte = page === L.PAGE.SATELLITE
        ? (wx.termByte != null ? (wx.termByte | 0) : (wx.satIsoByte | 0))
        : 0;
      // Scalar outlines/labels read as bezels/artifacts, so they stay disabled.
      // Exception: PRESSURE needs sparse conventional H/L centre symbols to read
      // as a synoptic chart; those ride the same machine-stamped phen path.
      const scalarPhen = page === L.PAGE.PRESSURE ? contourMarksForTile(page, wx, iso, t) : null;
      // Fire tiles' phen holds EXACTLY the flame cluster (applyFireZones). Fires
      // DRAW on WEATHER (owner 2026-08-01: "if there's lots of fire, i want to see
      // it" — the earlier blanking over-corrected his "all there was was fire",
      // which was about the ABSENCE of other weather, now fixed by the generous
      // field-seated minis). Flames flicker via the free-run flag below.
      const weatherPhen = (page === L.PAGE.WEATHER && shownCycTier < L.CYC.CYCLONE && Array.isArray(wx.phen))
        ? wx.phen : null;
      // FIRE: ONLY the flame phen (fire tiles' phen holds exactly the flame cluster);
      // an empty list still ships (count=0 -> modern micro-map, no legacy big glyph).
      const firePhen = firePage ? ((wx.fireMark && Array.isArray(wx.phen)) ? wx.phen : []) : null;
      const tabLabel = tabLabelFor(page);
      // Hoisted so the plate-anchor chooser sees the SAME periphery byte the job ships
      // (band clearance: the caption must clear the drawn band, not the raw wx byte —
      // PRESSURE strips the band bits, so its plate hugs the eye closer, correctly).
      const periphForJob = page === L.PAGE.PRESSURE
        ? ((wx.periphByte | 0) & 0x30)
        : namedCyclone ? (wx.periphByte | 0) : 0;
      queue.push({
        tile: t,
        land: landMasks[t],
        tempByte,
        precipByte: L.precipToByte(wx.precipMm),
        cat,
        // Sea tiles derive their state from the marine wave height (null/absent =>
        // SEA.NODATA, the distinct grey test-card — never the calm blank). Land
        // tiles have no marine sample, so their coastal cells stay CALM (blank).
        seaState,
        wind: L.windToByte(wx.windKmh),
        windDir: L.windDirToOctant(wx.windDir),
        // FS2 §C.1: carry the SUPPRESS bit so a poleward extratropical low draws the
        // bold-L (no spiral) — the display matches the latitude-aware wire bulletin.
        // WEATHER tier-NONE tiles repurpose the dead pos bits as the icon's
        // sub-tile anchor (glyphPos — gw.tilePayload does the same; fac2e86
        // wired only the stitch path, so the live wall seated every icon at
        // CENTER: owner's "scant, centered, per-tile glyphs").
        cyc: L.cycloneToByte(shownCycTier,
          (page === L.PAGE.WEATHER && shownCycTier === L.CYC.NONE && wx.glyphPos) ? (wx.glyphPos | 0) : cycPos,
          wx.cycloneSouth | 0, wx.cycloneAnim | 0, cycSuppress),
        iso,
        termByte,
        // PRESSURE wants conventional H/L centre bits, not generic cyclone/periphery
        // spirals. Named cyclones keep their periphery on every page — FIRE included
        // (owner 2026-07-24, same all-tabs order as shownCycTier above).
        periph: periphForJob,
        // Per-tab identity label (bottom-left tiles only; null elsewhere).
        labelCells: tabLabel ? (tabLabel[t] || null) : null,
        page,
        // FS2 trailer (LEN-gated in the worker): pressure byte + decoded hPa +
        // name char codes. Present only for a non-suppressed cyclone with pressure.
        pressureByte: (shownCycTier >= L.CYC.CYCLONE && !cycSuppress && pressureByte != null) ? pressureByte : null,
        nameCodes: (shownCycTier >= L.CYC.CYCLONE && !cycSuppress && pressureByte != null) ? nameCodes : [],
        // SEA-BIAS plate anchor (owner 2026-07-24): least-land caption spot from the
        // coastline mask, shipped as 2 trailer bytes. Null (legacy placement) when
        // there is no named trailer or no texture module (stale cache).
        plateAnchor: (shownCycTier >= L.CYC.CYCLONE && !cycSuppress && pressureByte != null &&
          nameCodes.length && window.WW_TEXTURE && window.WW_TEXTURE.pickPlateAnchor)
          ? window.WW_TEXTURE.pickPlateAnchor(landMasks[t], nameCodes.length, wx.cyclonePressureHpa, cycPos, periphForJob,
              Array.isArray(wx.phen) ? wx.phen : null)
          : null,
        pressureHpa: (shownCycTier >= L.CYC.CYCLONE && !cycSuppress) ? wx.cyclonePressureHpa : null,
        // WEATHER micro-phenomena are symbolic triples stamped by the emulated
        // machine. Scalar contour triples stay disabled: they read as bezels.
        phen: firePage ? firePhen : mergeMarks(scalarPhen, weatherPhen),
        // A wildfire tile free-runs 2 phases so its flame flickers on-machine (the
        // grey ember base persists, the solid flame cells blink) — like the thunder
        // blink. FIRE and WEATHER both (owner 2026-08-01: fires visible + animated).
        fireAnim: (firePage || page === L.PAGE.WEATHER) && !!wx.fireMark,
        // Wildfire NAME plate RESTORED on the summary (owner 2026-07-21): the fire zones ARE
        // the weather story now, so the worst incidents carry their name (MORRILL etc.) so a
        // burning region reads as a named fire, not an anonymous dark block. The pre-2026-07-21
        // suppression comment below is retained for history.
        // Wildfire NAME plate SUPPRESSED on the summary (owner 2026-07-15): a fire name
        // like HOGATZA is desk-detail, not a world-summary mark. The flame glyph + count
        // stays; the named-fire plates belong on the emergency/detail view, not here.
        fireNameCodes: (firePage && wx.fireName && NHC) ? NHC.nameToZX(wx.fireName, 8) : [],
        fireNameRow: firePage && !!wx.fireMark ? (wx.fireNameRow | 0) : 0,
        // Wildfire smoke: the flat per-tile density hatch (smokeByte) is RETIRED —
        // the graded downwind smoke FIELD replaces it (docs/MONOCHROME-WX-DESIGN.md:
        // smoke is an AREA field, fire is POINTS; the tile-wide hatch conflated them).
        smokeByte: 0,
        // Downwind smoke field: FIRE page only (owner 2026-07-31 newspaper restyle —
        // smoke off WEATHER; the synoptic chart is fronts/isobars/icons, the plume
        // story lives on FIRE). Front line/pip cells stay WEATHER.
        smokeCells: firePage && weatherSmokeCells ? (weatherSmokeCells[t] || null) : null,
        frontCells: page === L.PAGE.WEATHER && weatherFrontCells && weatherFrontCells[t] ? weatherFrontCells[t].cells : null,
        // Coast OUTLINE mask (WEATHER + FIRE): land renders as outline, not stipple fill.
        // SEA too (owner 2026-08-05): continents = white paper + solid black coast; the
        // worker bakes it into every swell motion frame (tab-spec 'coastline-outline').
        outlineMask: (page === L.PAGE.WEATHER || firePage || page === L.PAGE.SEA) ? outlineMasks[t] : null,
        // FIRE-relevant weather overlays: wind streaks (spread driver, windflow phase 0)
        // + precip relief dots (WMO rain-dot idiom, spacing by real intensity band).
        // Wind streaks RETIRED from the FIRE still (owner QC 2026-07-29: "wind vectors...
        // make the page look noisy"). They were a fourth texture over smoke + precip
        // dots + coast outline; the smoke plume's own drift already tells the wind
        // story, and the WIND page owns the flow visual. applyDotCells stays for precip.
        windStreakCells: null,
        precipCells: firePage && fireRegion.has(t) ? firePrecipCells(wx) : null,
        // Smooth-temp within-tile gradient (TEMP page only): signed per-cell level
        // steps derived from neighbouring tile centres. The worker rides them in the
        // TEMP page's unused precip/wind slots (see worker payload build).
        smoothGx: wx.smoothGx | 0,
        smoothGy: wx.smoothGy | 0,
        // Day/night terminator, governed by SPEC.TAB_SPEC. SATELLITE bakes its sweep
        // into satFrames; a show=true SCALAR page (TEMP) gets the marching night hatch
        // here. It is NOT the old static smother that was retired — it SWEEPS (nightFrames
        // below march the sub-solar longitude), and applyNight only hatches empty/tint
        // background cells, so the temp reading, isotherms and coastline read straight
        // through. Frame 0 (nightCells) is the wall-clock position for the static blit.
        // Terminator is a MACHINE-rendered edge from termByte now (strict charm), not a
        // host night hatch — these host-poke night masks are retired.
        nightCells: null,
        nightFrames: null,
        // WEATHER terminator line (src/terminator.js) — display-only poke, applyLines class.
        termLineCells: termCellsMap && termCellsMap[t] ? termCellsMap[t].cells : null,
        // WEATHER synoptic chart cells (rain areas + glyphs + gales; worker.applyChart).
        chartCells: chartTiles ? (chartTiles[t] || null) : null,
        // TEMP labels ride the isotherms: labelled only where a MAJOR isotherm crosses
        // this tile (sparse filter), so the reading sits on the contour band. The worker
        // gates the on-machine number stamp (iso bit6) on this flag.
        tempLabel: page === L.PAGE.TEMP ? tempLabelOnIso(lineMasks ? lineMasks[t] : null, (t / N) | 0, t % N) : false,
        // SATELLITE: full-detail native cloud motion frames (poked, ULA-rasterised).
        satFrames: page === L.PAGE.SATELLITE ? satTileFrames(t % N, (t / N) | 0, nightGeom, satStillRasters) : null,
        // SEA: native wave-field motion frames (sea cells only; poked).
        seaFrames: page === L.PAGE.SEA ? seaTileFrames(t, t % N, (t / N) | 0, seaWall) : null,
        // TEMP + PRESSURE both retire the host isoline poke — the machine now draws its
        // OWN smooth (MG=4) isotherms/isobars from the corner bytes, and the worker spares
        // those cells from the quiet-land flatten. lineMasks stays computed (above) so the
        // TEMP tempLabel can still ride where a MAJOR host isotherm crosses. Any remaining
        // host-isoline page keeps its poke.
        // SEA wave contours are a MARINE quantity: mask them off land cells (an
        // isobar legitimately crosses a continent; a wave-height line does not).
        lineCells: (page === L.PAGE.TEMP || page === L.PAGE.PRESSURE) ? null
          : page === L.PAGE.SEA ? seaLineCells(lineMasks ? lineMasks[t] : null, landMasks[t])
          : (lineMasks ? lineMasks[t] : null),
        bgen: burstGen,   // page-cache burst generation (stale replies dropped)
      });
      // T14: the WEATHER-page thunder glyph blinks ON-MACHINE (the Z80 toggles the
      // bolt's cells inverse<->plain on the render phase; the worker harvests the two
      // blink frames and the motion ticker below cycles them). No host-side CSS flash.
      const isCyc = shownCycTier >= L.CYC.CYCLONE;
      canvases[t].parentNode.classList.toggle('cyclone', isCyc);
      pageCache.get(burstKey).cyc[t] = isCyc;   // remember for an instant cached repaint
    }
    // WIND "drifting dots": app.js is the only side that sees all 100 wind
    // vectors at once, so it (the whole-wall tape master) runs the windflow
    // particle sim and hands each machine its per-phase dot overlay (whole-cell
    // positions, poked-as-data — coastline-mask model). The machines render the
    // cells; the chevron is retired. A data-less tile contributes no flow.
    if (page === L.PAGE.WIND && window.WW_WINDFLOW) {
      const vecs = new Array(N * N);
      for (let t = 0; t < N * N; t++) {
        const wx = data[t];
        vecs[t] = (wx && wx.windKmh != null && wx.windDir != null)
          ? { oct: L.windDirToOctant(wx.windDir), kmh: wx.windKmh }
          : { oct: -1, kmh: 0 };
      }
      // Parametric cyclone vortices (owner 2026-07-28, charm-over-truth exception): dots
      // CIRCLE a detected storm using its published parameters — official eye, authority
      // gust, sized periphery — because no sample at this tile scale can show rotation.
      // Display-only: the vortex feeds the particle sim, never data[] (readings, isotach
      // bytes and posted products stay measured). computePeriphery ran above, so
      // periphRadiusKm/cycloneLat/cycloneGust are current on the detected tiles.
      const vortices = window.WW_WINDFLOW.buildVortices(data, N, GW.kmPerCellAtLat);
      const dots = window.WW_WINDFLOW.simulate({ N, vecs, vortices });
      for (const job of queue) job.windDots = dots[job.tile];
    }
    // Marching-squares contour corners (TEMP + PRESSURE): build the shared 11x11 node grid
    // ONCE from every tile's centre field byte, then hand each machine its four corners so
    // the curves meet seam-to-seam. TEMP feeds tempByte (isotherms); PRESSURE feeds the
    // CONTINUOUS pressure byte (L.pressToByte) so the machine draws real smooth isobars —
    // NOT the 4-band shading byte. Both level tables (CT_LVL_TEMP / CT_LVL_PRESS) are
    // calibrated and the worker picks the right one by page.
    if (CG && (page === L.PAGE.TEMP || page === L.PAGE.PRESSURE)) {
      const centres = new Array(N * N).fill(0);
      for (const job of queue) {
        centres[job.tile] = (page === L.PAGE.PRESSURE
          ? L.pressToByte((data[job.tile] || {}).pressureHpa)
          : job.tempByte) & 0xff;
      }
      const cg = CG.buildCornerGrid(centres, N, N);
      for (const job of queue) job.corners = cg[job.tile];
    }
    // DENSE continental fields (TEMP): a continental-desk tile with a real 5x5 grid in the
    // scheduler snapshot ships it instead of corners (worker sends a LEN-36 frame -> ct_run4f).
    // Tiles not in the field set keep their 4-corner curves — the wall stays seamless.
    if (page === L.PAGE.TEMP && contField && contField.tiles) {
      for (const job of queue) {
        const f = contField.tiles[job.tile];
        if (f && f.length === 25) job.fieldCells = f;
      }
    }
    // DENSE continental fields (PRESSURE): the isobars stop being a bilinear guess off four
    // tile-centre corners and march the snapshot's REAL 5x5 pressure grid, exactly as TEMP
    // does. `tiles` is the pre-byted temp grid, so pressure converts here — the same
    // L.pressToByte the corner path uses above, applied per NODE instead of per tile, which
    // keeps the byte scale (and therefore CT_LVL_PRESS) identical on both paths.
    // A node with no reading maps to the datum-neutral byte, never a fabricated low/high.
    // Tiles missing from `fields.pressureHpa` (a snapshot written before the fields covered
    // the whole wall — e.g. an older history-dense archive frame) keep their 4-corner curves.
    if (page === L.PAGE.PRESSURE && contField && contField.fields && contField.fields.pressureHpa) {
      const pf = contField.fields.pressureHpa;
      for (const job of queue) {
        const f = pf[job.tile];
        if (f && f.length === 25) job.fieldCells = f.map((v) => L.pressToByte(v) & 0xff);
      }
      // SYNOPTIC H/L on the DENSE field (owner QC 2026-07-24: "only one L and one H on the
      // entire global map, and the L isn't even inside the lowest isobar"). computePeriphery
      // above ran gw.findPressureCentres over the COARSE 10x10 tile-CENTRE grid, where a
      // strict 8-neighbour extremum almost never fires at 36x18 degree spacing — so it fell
      // through to its basin-scale fallback and marked exactly one low + one high globally,
      // positioned off the isobars it was supposed to sit inside. Recompute from the SAME
      // 5x5 grids the isobars march, keeping only extrema genuinely enclosed by a closed
      // isobar (src/pressure-centres.js), and hand each marked tile a sub-tile anchor.
      const PC = window.WW_PRESSCENTRES;
      if (PC) {
        for (let t = 0; t < N * N; t++) {                     // clear the coarse pass's marks
          const w = data[t];
          if (w) w.periphByte = (w.periphByte | 0) & ~0x30;
        }
        // Tile-centre pressures back the dense grids: a node the dense pull never reached is
        // a HOLE, and a hole blocks enclosure (a marker must be ringed by an isobar, not by
        // the edge of coverage). Without this fallback an older 76-tile snapshot silently
        // loses the centres nearest the coverage edge.
        const cHpa = [];
        for (let t = 0; t < N * N; t++) {
          const w = data[t];
          cHpa.push(w && typeof w.pressureHpa === 'number' ? w.pressureHpa : null);
        }
        const nodeAt = PC.nodeAtFromTileGrids(pf, cHpa);
        const centres = PC.findCentres(nodeAt, {
          // A named tropical system already carries its own spiral + name plate.
          skipTile: (t) => {
            const w = data[t];
            return !!(w && (w.cycloneTier | 0) >= L.CYC.CYCLONE && (w.cycloneName || w.cycloneGust == null));
          },
        });
        const anchors = new Map();
        for (const c of centres) {
          const w = data[c.tile];
          if (!w) continue;
          w.periphByte = (w.periphByte | 0) | L.periphCentreToBits(c.kind === 'L' ? 1 : 2);
          // Sub-node parabolic refinement: the letter sits at the field's interpolated
          // vertex, not the nearest lattice node (and so DRIFTS as the field evolves).
          const rf = PC.refineAnchor(nodeAt, c);
          anchors.set(c.tile, PC.glyphAnchor(rf.gx, rf.gy));
        }
        for (const job of queue) {
          job.periph = (data[job.tile] || {}).periphByte | 0;   // re-read: marks changed above
          if (anchors.has(job.tile)) job.centreCell = anchors.get(job.tile);
        }
      }
    }
    // STORM WELL (PRESSURE; owner 2026-07-30 QC: "draw the actual isobaric lines or else
    // simulate them with best effort from the available data"): a tier>=CYCLONE tile
    // with a real central pressure ships a FIELD frame with the parametric well folded
    // in (src/pressure-well.js) — the machine then draws the storm's OWN tight isobars:
    // thin, the chart's line weight, seamless with the ambient field. No trailer, no
    // sprite; the name/min-pressure plate rides the display-only overlay path.
    if (page === L.PAGE.PRESSURE && window.WW_PRESSWELL) {
      for (const job of queue) {
        const wx = data[job.tile] || {};
        if ((wx.cycloneTier | 0) < L.CYC.CYCLONE || wx.cycloneSuppress) continue;
        if (wx.cyclonePressureHpa == null || !isFinite(wx.cyclonePressureHpa)) continue;
        const base = (job.fieldCells && job.fieldCells.length === 25) ? job.fieldCells
          : (job.corners && window.WW_CONTOURPLOT) ? promoteCorners(job.corners) : null;
        if (!base) continue;
        job.fieldCells = window.WW_PRESSWELL.wellField(base, wx.cyclonePos | 0, wx.cyclonePressureHpa);
        job.corners = null;
        job.cyc = 0;                 // the well IS the storm — no sprite, no trailer
        job.pressureByte = null;
        job.nameCodes = null;
        job.plateAnchor = null;
        const plate = stormPlateCells(wx, landMasks[job.tile], job.fieldCells);
        if (plate) job.labelCells = (job.labelCells || []).concat(plate);
      }
    }
    // SATELLITE still: the satFrames poke overwrites the whole tile, so the storm
    // name/min-pressure plate rides the display-only labelCells overlay (the same
    // path as PRESSURE) — the comma cloud signature is already in the raster.
    if (page === L.PAGE.SATELLITE && satStillRasters) {
      for (const job of queue) {
        const wx = data[job.tile] || {};
        if ((wx.cycloneTier | 0) < L.CYC.CYCLONE || wx.cycloneSuppress || !wx.cycloneName) continue;
        const plate = stormPlateCells(wx, landMasks[job.tile], null);
        if (plate) job.labelCells = (job.labelCells || []).concat(plate);
      }
    }
    // SEA storm tiles (owner QC 2026-07-30: "stippled other than the hurricane
    // animations"): the radiating storm-sea field IS the storm now — no sprite, no
    // periphery spiral, no trailer plate (the same "the well IS the storm" ruling
    // PRESSURE made). Name/min-pressure ride the display-only labelCells overlay.
    if (page === L.PAGE.SEA && seaWall) {
      for (const job of queue) {
        const wx = data[job.tile] || {};
        if ((wx.cycloneTier | 0) < L.CYC.CYCLONE || wx.cycloneSuppress) continue;
        job.cyc = 0;
        job.periph = 0;
        job.pressureByte = null;
        job.nameCodes = null;
        job.plateAnchor = null;
        if (!wx.cycloneName) continue;
        const plate = stormPlateCells(wx, landMasks[job.tile], null);
        if (plate) job.labelCells = (job.labelCells || []).concat(plate);
      }
    }
    burstStart = performance.now();
    everRendered = true;
    // kick every worker; each pulls the next job when it finishes
    for (const wk of workers) feed(wk);
  }

  // Re-render the last-good map for the current page — a page flip, zero API calls.
  // The tape-loop source follows the active page, so rebuild it on every flip too
  // (a no-op when TRK is off).
  function repaintPage() {
    if (!(lastData && !refreshing)) return;
    // page cache: if THIS page is fully harvested for the current map, re-blit from
    // cache instantly — zero re-broadcast, zero ZX81 time. Otherwise fall through to
    // the normal burst (which populates the cache as a side effect). Fallback-safe.
    const pc = pageCache.get(mapVersion + ':' + activePage);
    if (pc && pc.done >= N * N) {
      for (let t = 0; t < N * N; t++) {
        const fr = pc.frames[t];
        if (!fr) continue;
        tileFrames[t] = fr;
        ctxs[t].putImageData(fr[0], 0, 0);
        canvases[t].parentNode.classList.toggle('cyclone', !!pc.cyc[t]);
      }
      // The cached tile frames already contain every native graphic (terminator,
      // clouds, swell, isolines were poked in before the burst rendered them), so a
      // cached page flip is complete on re-blit — no host overlay to re-run.
      buildTracks();
      return;
    }
    startBurst(lastData); buildTracks();
  }

  // ---- tape-loop builders + replay (FS7-T9 + DR-12b contour fold-in) ----------
  // The live cyclone byte / phen list for a tile (mirrors startBurst's per-tile job
  // fields) — used to keep the contour tape-loop's non-contour layers identical to
  // the live wall while only the iso (byte6) edge mask drifts per frame.
  function liveCyc(wx) {
    return L.cycloneToByte(wx.cycloneName ? (wx.cycloneTier | 0) : L.CYC.NONE, wx.cyclonePos | 0, wx.cycloneSouth | 0, wx.cycloneAnim | 0, wx.cycloneSuppress | 0);
  }
  function livePhen(wx) {
    return ((wx.cycloneTier | 0) < L.CYC.CYCLONE && Array.isArray(wx.phen)) ? wx.phen : null;
  }
  // Assemble one tape-loop frame-tile job (full payload, mirrors startBurst) with the
  // per-frame overrides o = { cyc, iso, periph, phen, page }.
  function tapeJob(t, f, wx, o) {
    const tC = typeof wx.tempC === 'number' ? wx.tempC : 0;
    const tempByte = o.page === L.PAGE.SATELLITE
      ? Math.max(0, Math.min(100, Math.round(wx.cloudCoverPct == null ? 0 : wx.cloudCoverPct)))
      : o.page === L.PAGE.PRESSURE ? pressureTempByte(wx.pressureHpa)
      : L.tempToByte(tC);
    // PRESSURE ocean quiet on the tape loop too — same ruling as the still above (a loop
    // frame that kept the pressure-band stipple would flicker the soup back every replay).
    const seaStateRaw = o.page === L.PAGE.PRESSURE
      ? L.SEA.CALM
      : seaSet.has(t) ? L.waveToSeaState(wx.waveHeight) : L.SEA.CALM;
    const seaState = seaStateRaw === L.SEA.NODATA ? L.SEA.CALM : seaStateRaw;  // hide NODATA bars on the loop too
    const cycTier = L.cycTierOf(o.cyc | 0), cycSuppress = L.cycSuppressOf(o.cyc | 0);
    const pressureByte = L.pressureToByte(wx.cyclonePressureHpa);
    const gated = cycTier >= L.CYC.CYCLONE && !cycSuppress && pressureByte != null;
    const nameCodes = (NHC && wx.cycloneName) ? NHC.nameToZX(wx.cycloneName, 10) : [];
    return {
      tile: t, frame: f, gen: trackGen, land: landMasks[t], tempByte,
      precipByte: L.precipToByte(wx.precipMm),
      cat: L.weatherCodeToCat(wx.weatherCode || 0),
      seaState,
      wind: L.windToByte(wx.windKmh), windDir: L.windDirToOctant(wx.windDir),
      // Terminator (owner 2026-07-16 QC — re-enabled animated on every loop): SATELLITE
      // draws its night from termByte on-machine; every OTHER page gets a per-frame
      // night-cell bitmap (below) poked as a clean 1-bit cross-hatch (applyNight), so
      // the day/night boundary SWEEPS across the 12/24/48h loop. o.nightGeom is this
      // frame's real solar geometry (buildTracks steps it one hour per frame).
      cyc: o.cyc | 0, iso: o.iso | 0, termByte: o.page === L.PAGE.SATELLITE ? (o.term != null ? (o.term | 0) : (wx.termByte != null ? (wx.termByte | 0) : (wx.satIsoByte | 0))) : 0, periph: o.periph | 0, page: o.page,
      // Per-tab identity label on loop frames too (same memoized strip as the burst),
      // plus any per-frame overlay extras (the PRESSURE storm plate).
      labelCells: (() => {
        const a = ((tabLabelFor(o.page) || {})[t] || []).concat(o.extraLabelCells || []);
        return a.length ? a : null;
      })(),
      pressureByte: gated ? pressureByte : null,
      nameCodes: gated ? nameCodes : [],
      pressureHpa: (cycTier >= L.CYC.CYCLONE && !cycSuppress) ? wx.cyclonePressureHpa : null,
      // SEA-BIAS plate anchor on loop frames too (same chooser as the live burst).
      plateAnchor: (gated && nameCodes.length && window.WW_TEXTURE && window.WW_TEXTURE.pickPlateAnchor)
        ? window.WW_TEXTURE.pickPlateAnchor(landMasks[t], nameCodes.length, wx.cyclonePressureHpa, wx.cyclonePos | 0, o.periph | 0,
            Array.isArray(wx.phen) ? wx.phen : null)
        : null,
      phen: o.phen,
      // TEMP loop numbers ride the isotherms too: labelled where a major isotherm
      // crosses this frame's tile, so the readings move with the lines across the loop.
      tempLabel: o.page === L.PAGE.TEMP ? tempLabelOnIso(o.lineCells, t % N, (t / N) | 0) : false,
      // PRESSURE H/L sub-tile anchor on loop frames too (per-frame dense centres).
      centreCell: o.centreCell || null,
      // Terminator rides termByte (machine edge) now — no host night mask on the loop.
      nightCells: null,
      // Native isolines for this loop frame. TEMP + PRESSURE retire the host poke — the
      // machine draws its OWN smooth (MG=4) isotherms/isobars from o.corners, exactly like
      // the burst path (line ~1404). o.lineCells stays available above so the TEMP tempLabel
      // can still ride where a MAJOR host isotherm crosses this frame's tile.
      lineCells: (o.page === L.PAGE.TEMP || o.page === L.PAGE.PRESSURE) ? null : (o.lineCells || null),
      // TEMP loop machine-curve corners (four shared node bytes: nw, ne, se, sw). The
      // worker ships a LEN-15 frame -> ct_run4 and spares those cells from quiet-land
      // flatten. Null on non-TEMP pages (PRESSURE corners are wired but sent separately).
      corners: o.corners || null,
      // HYBRID DENSE loop grid (real 25-node field: archived snapshot + centre delta).
      // Takes the LEN-36 field path in the worker — full still-page density per frame.
      fieldCells: o.fieldCells || null,
      // FIRE smoke time-lapse: this loop frame's plume field (hour-h wind, today's fires).
      smokeCells: o.smokeCells || null,
      // SATELLITE loop frame: sliced global cloud raster (single display-poke frame).
      satFrames: o.satFrames || null,
      // SEA loop frame: sliced global wave raster (single display-poke frame).
      seaFrames: o.seaFrames || null,
      // WEATHER loop frames replay the full synoptic chart per hour (owner 2026-08-03:
      // the loop animated only storm tiles over a frozen still). Same worker pokes
      // as the burst path: terminator line first, chart marks over it.
      termLineCells: o.termLineCells || null,
      chartCells: o.chartCells || null,
      // FIRE loop keeps land as outline + flames as STATIC marks per frame (no per-frame
      // free-run harvest — the loop's motion channel is the PLUME, not the flicker).
      outlineMask: o.outlineMask || null,
      fireAnim: false,
    };
  }

  function scalarPageKind(page) {
    return page === L.PAGE.TEMP ? 'temp'
      : page === L.PAGE.WIND ? 'wind'
      : page === L.PAGE.PRESSURE ? 'press'
      : page === L.PAGE.SEA ? 'sea'
      : page === L.PAGE.SATELLITE ? 'cloud'   // cloud-cover time-lapse (real cloudHist advection)
      : null;
  }
  function contourFrameCount(spanH) { return spanH >= 48 ? 12 : spanH >= 24 ? 9 : CONTOUR_FRAMES; }
  // Real archived per-tile history for a scalar layer (hourly readings, newest-last,
  // sliced by src/weather.js to <=48 PAST hours; waveHist from src/marine.js). This is
  // what the per-sheet time-lapse reads — no synthesized values; a layer with no
  // history honest-degrades to a still sheet.
  function scalarHistOf(wx, kind) {
    return !wx ? null
      : kind === 'temp' ? wx.tempHist
      : kind === 'wind' ? wx.windHist
      : kind === 'press' ? wx.pressHist
      : kind === 'sea' ? wx.waveHist
      : kind === 'cloud' ? wx.cloudHist
      : null;
  }
  // Honest window: the LONGEST real per-tile history for this layer, capped to the
  // requested span. 0 => nothing archived yet (caller shows a still sheet + honest
  // "next refresh", never a padded/fabricated loop — the charm rule).
  function scalarAvailHours(page, span) {
    const kind = scalarPageKind(page);
    if (!kind || !lastData) return 0;
    let max = 0;
    for (const wx of lastData) { const h = scalarHistOf(wx, kind); if (h && h.length > max) max = h.length; }
    return Math.min(span | 0, max);
  }
  // The REAL reading for tile wx at loop-hour h within an `avail`-hour window (h in
  // [0, avail-1], newest at avail-1). Out-of-range / missing history falls back to the
  // tile's CURRENT reading (a still tile) — never a synthesized in-between value. This
  // is the charm rule: a short-history tile freezes rather than inventing motion.
  function scalarRealAt(wx, kind, h, avail) {
    const hist = scalarHistOf(wx, kind);
    if (hist && hist.length) {
      const i = hist.length - avail + h;
      if (i >= 0 && i < hist.length && hist[i] != null) return hist[i];
      const last = hist[hist.length - 1];
      if (last != null) return last;
    }
    return kind === 'temp' ? (wx.tempC == null ? null : wx.tempC)
      : kind === 'wind' ? (wx.windKmh == null ? null : wx.windKmh)
      : kind === 'press' ? (wx.pressureHpa == null ? null : wx.pressureHpa)
      : kind === 'cloud' ? (wx.cloudCoverPct == null ? null : wx.cloudCoverPct)
      : (wx.waveHeight == null ? null : wx.waveHeight);
  }

  // Per-frame day/night terminator (moving sweep): recompute the REAL solar terminator
  // for THIS loop frame's UTC timestamp so a 24h loop advances one full rotation instead
  // of freezing the single build-time "now" across every frame. The terminator depends
  // ONLY on tile lon/lat + epoch, so run computeSatellite on a throwaway array to harvest
  // termByte per tile — never clobbering the live wall's current-now satIsoByte/termByte
  // on lastData. Returns the stub array (stub[t].termByte per tile).
  function frameTermBytes(epochMs) {
    const stub = new Array(lastData.length);
    for (let i = 0; i < stub.length; i++) stub[i] = lastData[i] ? {} : null;
    GW.computeSatellite(stub, N, (t) => coast.tileCenterLonLat((t / N) | 0, t % N), epochMs);
    return stub;
  }

  // Build the tape loop for the ACTIVE page. WEATHER uses cached machine frames;
  // scalar compositor-only contour loops are disabled by the charm principle.
  async function buildTracks() {
    trackGen++;   // start a new generation; any in-flight reply from the old one is stale
    const myGen = trackGen;   // async guard: a later buildTracks supersedes this one
    trackImgs = null; contourLoopFrames = null; trackPhase = 0; trackPending = 0;
    const el = $('s-tracks');
    if (trackSpan === 0 || !lastData) { if (el) el.textContent = 'off'; return; }
    const nowMs = Date.now();   // the loop's "now" anchor; newest frame == nowMs
    const page = activePage;
    // SATELLITE now runs the scalar time-lapse too (kind='cloud'): the loop re-renders
    // each tile's cloud coverage from its REAL archived cloudHist, so cloud masses
    // genuinely advect over 12/24/48h (was a frozen 2024 raster + procedural shimmer).
    // The fine GIBS raster stays the still "now" view (burst path). Falls through to the
    // scalar branch below; honest-degrades to "CLOUD · next refresh" until cloudHist accrues.
    // WIND's motion IS the drifting-dot streamline flow (the 8-phase windflow overlay
    // baked into the burst frames, cycled by the motion ticker). The old scalar
    // time-lapse re-rendered every frame WITHOUT windDots, so each frame fell back to
    // the per-tile chevron stamp — the "tile-centred chevrons" regression. Skip the
    // time-lapse entirely: the burst flow already animates across tile borders and the
    // TRK span buttons are a no-op here (like SATELLITE).
    if (page === L.PAGE.WIND) { if (el) el.textContent = 'wind flow'; return; }

    const jobs = [];
    let frameCount = 0, label = '';
    // FIRE smoke time-lapse (owner 2026-07-28: "show how the smoke drifts over a 12/24/48
    // hour cycle"): one plume field per archived hour — hour h's REAL wind vector
    // (windHist + windDirHist) advecting TODAY'S fire sources (incidents move on a scale
    // of days; the drift story is the wind's). Flames/plates ride every frame as static
    // marks; the plume is the loop's motion channel. Honest-degrades until direction
    // history accrues (windDirHist ships with the first pull after 2026-07-28) and when
    // there are no fires (nothing to emit — a clear sky loops as a clear sky).
    if (page === L.PAGE.FIRE) {
      const SF = window.WW_SMOKEFLOW;
      if (!SF || !SF.loopFrames) { if (el) el.textContent = 'FIRE · still'; return; }
      const res = SF.loopFrames(lastData, lastFireZones, { N, spanH: trackSpan });
      if (!res.frames.length) { if (el) el.textContent = 'SMOKE · next refresh'; return; }
      // HOURLY FIRE HISTORY (owner 2026-08-04): FIRMS' 48h file is timestamped, so the
      // scheduler archives "the fire map as of hour H" (trailing-24h window per hour,
      // data/history-fires/). Each loop frame rebuilds its zones with THAT hour's
      // FIRMS snapshot — global flames appear/intensify/fade across the loop instead
      // of today's map pasted on every frame. Dedicated feeds (NIFC/EFFIS/BC) publish
      // no history, so their regions honestly ride the current lists on all frames.
      // The smoke plume keeps its existing wind-history channel unchanged.
      let fireHourIdx = null;
      try { const r = await fetch('/data/history-fires/index.json', { cache: 'no-store' }); if (r.ok) fireHourIdx = (await r.json()).hours || null; }
      catch (e) { /* no archive yet -> every frame uses current zones */ }
      if (myGen !== trackGen) return;
      const frameOverlays = [];   // per frame: null (use still) or per-tile zone overlay
      for (let f = 0; f < res.frames.length; f++) {
        const frameEpoch = nowMs - (res.frames.length - 1 - f) * 3600000;
        let snapFires = null;
        if (fireHourIdx && fireHourIdx.length) {
          const want = new Date(frameEpoch).toISOString().slice(0, 13);
          let pick = null;
          for (const hh of fireHourIdx) { if (hh <= want) pick = hh; else break; }
          // stale-gate: an archived window more than 3h older than the frame is
          // not "that hour's map" — honest fall-through to the current zones
          if (pick && frameEpoch - Date.parse(pick + ':00:00Z') <= 3 * 3600000) {
            try { const r = await fetch('/data/history-fires/' + pick + '.json', { cache: 'no-store' }); if (r.ok) snapFires = (await r.json()).fires || null; }
            catch (e) { snapFires = null; }
            if (myGen !== trackGen) return;
          }
        }
        if (!snapFires) { frameOverlays.push(null); continue; }
        // this hour's zones: archived FIRMS + current dedicated feeds, through the
        // SAME builder and flame-placement pass as the still page
        const zonesF = zonesFromFires([lastFireFeeds.nifc, lastFireFeeds.effis, lastFireFeeds.bc, snapFires]);
        const stub = lastData.map((w) => (w ? { cycloneTier: w.cycloneTier } : null));
        GW.applyFireZones(stub, zonesF, N, landMasks);
        frameOverlays.push(stub);
      }
      for (let f = 0; f < res.frames.length; f++) {
        const smokeF = res.frames[f];
        const ov = frameOverlays[f];
        for (let t = 0; t < N * N; t++) {
          const wx = lastData[t] || {};
          const fw = ov ? (ov[t] || {}) : wx;   // frame's fire state (fall back: still page)
          jobs.push(tapeJob(t, f, ov ? Object.assign({}, wx, { fireName: fw.fireName || null }) : wx, {
            cyc: 0, iso: (fw.fireMark ? 0x20 : 0), periph: 0, page,
            phen: (fw.fireMark && Array.isArray(fw.phen)) ? fw.phen : [],
            smokeCells: smokeF[t] && smokeF[t].length ? smokeF[t] : null,
            outlineMask: outlineMasks[t],
          }));
        }
      }
      frameCount = res.frames.length;
      label = 'LAST ' + res.avail + 'H · SMOKE+FIRE · ' + frameCount + 'f';
      // same dispatch tail as the scalar/WEATHER branches below
      trackImgs = [];
      for (let f = 0; f < frameCount; f++) trackImgs.push({});
      trackPending = jobs.length;
      if (el) el.textContent = label;
      queue.push(...jobs);
      for (const wk of workers) feed(wk);
      return;
    }
    const kind = scalarPageKind(page);
    if (kind) {
      // Per-sheet time-lapse (TEMP/WIND/PRESSURE/SEA): re-render every tile from its
      // ARCHIVED hourly readings for this layer, one machine frame per sampled real
      // hour across the honest window. No fabricated motion — a tile with missing/short
      // history freezes at its current reading. SEA has no waveHist source, so avail
      // is 0 and we honest-degrade to a still sheet ("SEA · next refresh").
      const avail = scalarAvailHours(page, trackSpan);
      if (avail < 2) { if (el) el.textContent = kind.toUpperCase() + ' · next refresh'; return; }
      const F = Math.min(contourFrameCount(trackSpan), avail);
      // Storm TRACK on every loop (owner 2026-07-24): reuse the WEATHER-loop per-hour
      // re-detection so the head spiral + fading trail animate across the scalar loops
      // too. Sampled at this loop's frame hours; a tile the track owns that frame drops
      // its corner/field bytes (the storm owns the tile — same wire doctrine as the
      // live page), every other tile is untouched. With track data present the old
      // static liveCyc marker is retired: a past frame must not pin the storm at its
      // CURRENT position.
      let trk = null;
      if (lastData.some((w) => w && w.gustHist && w.gustHist.length)) {
        const haveSubs = lastSubResults.length === subPts.length;
        const tr = GW.trackFrames(lastData, seaIdx, haveSubs ? subPts : [], haveSubs ? lastSubResults : [], trackSpan);
        if (tr.affected.size) trk = tr;
      }
      // Canonical agency tracks for this loop build (one fetch, all frames).
      const stormTracks = await loadStormTracks();
      if (myGen !== trackGen) return;
      const curStorms = currentStormList(stormTracks);
      // HYBRID DENSE frames (owner 2026-07-24, TEMP only): each frame rebuilds every
      // tile's 25-node grid as (nearest archived dense snapshot) + (hourly centre-delta
      // field) — the snapshot carries the still page's sub-tile structure, the delta
      // carries the hour-by-hour motion, and the delta is interpolated per NODE
      // (src/dense-loop.js) so seams survive. Honest-degrades: no archive / no snapshot
      // within 7h of a frame -> that frame keeps its corner-promoted grid (the archive
      // only accrues from live pulls, so early loops densify newest-frames-first).
      const DL = window.WW_DENSELOOP;
      let denseHours = null;
      if (page === L.PAGE.TEMP && DL) {
        const idx = await loadDenseIndex();
        if (idx && Array.isArray(idx.hours) && idx.hours.length) denseHours = idx.hours;
        if (myGen !== trackGen) return;   // superseded while awaiting the index
      }
      // SATELLITE loop (owner QC 2026-07-30 "stipple blocks popping around the grid"):
      // the loop no longer re-bands one scalar per tile — each frame renders ONE
      // global cloud raster (real per-hour cover thresholds the texture, real
      // per-hour wind advects it) and slices it per tile as a display poke. The
      // cumulative drift D[h] integrates the archived hourly wind from frame-hour h
      // to now, so the texture a frame samples is exactly where today's clouds were
      // then — playing forward, the masses travel along the real wind.
      const histVal = (hist, h, cur) => {
        if (hist && hist.length) {
          const i = hist.length - avail + h;
          if (i >= 0 && i < hist.length && hist[i] != null) return hist[i];
        }
        return cur == null ? null : cur;
      };
      let satCum = null;
      if (kind === 'cloud' && cloudBase()) {
        satCum = new Array(avail);
        const cx = new Array(N * N).fill(0), cy = new Array(N * N).fill(0);
        satCum[avail - 1] = { dx: cx.slice(), dy: cy.slice() };
        for (let h = avail - 2; h >= 0; h--) {
          for (let t = 0; t < N * N; t++) {
            const wx = lastData[t] || {};
            const vv = windCellVec(histVal(wx.windHist, h, wx.windKmh),
              histVal(wx.windDirHist, h, wx.windDir), (t / N) | 0);
            cx[t] += vv[0]; cy[t] += vv[1];
          }
          satCum[h] = { dx: cx.slice(), dy: cy.slice() };
        }
      }
      for (let f = 0; f < F; f++) {
        const h = F === 1 ? avail - 1 : Math.round((f * (avail - 1)) / (F - 1));
        // This frame's real UTC: the window is `avail` past hours, newest (h==avail-1)
        // is nowMs, so each earlier frame steps one hour back. Recompute the solar
        // terminator for that timestamp — a full 24h loop sweeps one whole rotation.
        const frameEpoch = nowMs - (avail - 1 - h) * 3600000;
        const term = frameTermBytes(frameEpoch);
        const frameNightGeom = computeNightGeom(frameEpoch);
        // Build this frame's FULL scalar field first, so the native isolines are
        // computed from the whole frame (marching squares needs all tile centres),
        // then emit one tape job per tile carrying its isoline cells.
        const frameField = new Array(lastData.length);
        for (let t = 0; t < lastData.length; t++) {
          const wx = lastData[t] || {};
          const v = scalarRealAt(wx, kind, h, avail);
          frameField[t] = v == null ? wx : Object.assign({}, wx,
            kind === 'temp' ? { tempC: v } : kind === 'wind' ? { windKmh: v }
            : kind === 'press' ? { pressureHpa: v } : kind === 'cloud' ? { cloudCoverPct: v }
            : { waveHeight: v });
        }
        const frameLineMasks = contourLineCells(page, frameField);
        // TEMP + PRESSURE: build THIS frame's shared 11x11 corner-node grid from every
        // tile's frame-field centre (mirrors startBurst's buildCornerGrid), so the loop's
        // machine-drawn isotherms/isobars meet seam-to-seam and MOVE hour-by-hour across
        // the loop instead of freezing on host isolines. TEMP feeds the temp byte; PRESSURE
        // feeds the CONTINUOUS pressure byte (L.pressToByte) — both level tables calibrated.
        let frameCorners = null;
        if (CG && (page === L.PAGE.TEMP || page === L.PAGE.PRESSURE)) {
          const centres = new Array(N * N).fill(0);
          for (let t = 0; t < N * N; t++) {
            const w = frameField[t] || {};
            centres[t] = (page === L.PAGE.PRESSURE
              ? L.pressToByte(w.pressureHpa)
              : L.tempToByte(typeof w.tempC === 'number' ? w.tempC : 0)) & 0xff;
          }
          frameCorners = CG.buildCornerGrid(centres, N, N);
        }
        // PRESSURE H/L TRACK the frame's real extrema (owner 2026-07-16): recompute the
        // synoptic centres from THIS frame's pressure field, on a clean copy (findPressure
        // Centres mutates periphByte — never touch lastData / frameField's v==null aliases),
        // so the H and L jump to and follow the deepest low / strongest high as the field
        // evolves across the loop instead of sitting frozen at the current-now position.
        let framePeriphMap = null, frameCentreCells = null;
        if (kind === 'press') {
          // DENSE per-frame H/L (owner QC 2026-07-30 "finer H/L placement"): the coarse
          // findPressureCentres pass marks basin-scale extrema at TILE centres, so the
          // loop's letters jumped tile-to-tile and sat off the isobars while the still
          // page had node-anchored, enclosure-checked centres. Recompute each frame's
          // centres on the bilinear lattice its own pressures induce (nodeAtFromTileGrids
          // with NO dense grids — every node takes the tile-centre fallback, the same
          // field the frame's corner-promoted isobars derive from), with the closed-
          // isobar test + sub-tile glyph anchors. A frame with a pressure hole (after
          // falling back to the current reading) keeps the legacy coarse pass — markers
          // must degrade to coarse, never silently vanish.
          const PC = window.WW_PRESSCENTRES;
          const cHpa = frameField.map((w, tt) => (w && typeof w.pressureHpa === 'number') ? w.pressureHpa
            : (lastData[tt] && typeof lastData[tt].pressureHpa === 'number') ? lastData[tt].pressureHpa : null);
          if (PC && cHpa.every((v) => v != null)) {
            const skip = (tt) => { const w = frameField[tt] || {};
              return !!(((w.cycloneTier | 0) >= L.CYC.CYCLONE) && (w.cycloneName || w.cycloneGust == null)); };
            const nodeAt = PC.nodeAtFromTileGrids({}, cHpa);
            const centres = PC.findCentres(nodeAt, { skipTile: skip });
            framePeriphMap = new Array(N * N).fill(0);
            frameCentreCells = new Map();
            for (const c of centres) {
              framePeriphMap[c.tile] |= L.periphCentreToBits(c.kind === 'L' ? 1 : 2);
              // Sub-node parabolic refinement: as the frame fields evolve the letters
              // DRIFT through the tile instead of snapping node-to-node.
              const rf = PC.refineAnchor(nodeAt, c);
              frameCentreCells.set(c.tile, PC.glyphAnchor(rf.gx, rf.gy));
            }
          } else {
            const parr = frameField.map((w) => ({ pressureHpa: (w || {}).pressureHpa,
              cycloneTier: (w || {}).cycloneTier, cycloneName: (w || {}).cycloneName,
              cycloneGust: (w || {}).cycloneGust }));
            GW.findPressureCentres(parr, N);
            framePeriphMap = parr.map((w) => (w.periphByte | 0) & 0x30);
          }
        }
        // Canonical per-frame storm heads (agency track, interpolated) — the one
        // position source every tab's loop shares.
        const frameHeads = stormHeadsAt(curStorms, frameEpoch);
        // SATELLITE: this frame's global cloud raster. Band rotation is clocked by
        // the frame's real epoch (one arm turn per 12h), so the storms visibly spin
        // hemisphere-correctly as the loop plays.
        let satRaster = null;
        if (satCum) {
          const pctV = frameField.map((w) => (w && w.cloudCoverPct != null) ? w.cloudCoverPct : 0);
          const phase = ((frameEpoch / 3600e3) % 12) / 12 * TAU;
          satRaster = cloudRaster(pctV, satCum[h].dx, satCum[h].dy, frameHeads, phase, null);
        }
        // SEA loop: this frame's global wave raster from the archived hour —
        // scalarRealAt already put hour-h waveHeight on frameField; direction and
        // period ride their own hists (falling back to current, honest freeze).
        // Crest roll is clocked by the frame's real epoch (1/8 cycle per hour, the
        // still's own timebase); storm seas follow the interpolated head.
        let seaRaster = null;
        if (kind === 'sea' && window.WW_SEAFIELD) {
          const prep = seaPrep(frameField, frameHeads, (wx) => ({
            wh: wx.waveHeight,
            dir: histVal(wx.waveDirHist, h, wx.waveDir),
            pd: histVal(wx.wavePeriodHist, h, wx.wavePeriod),
          }));
          if (prep) seaRaster = seaRasterAt(prep, ((frameEpoch / 3600e3) % 8) / 8);
        }
        // PRESSURE STORM WELLS ride the canonical head: present on every frame the
        // storm existed, centred on the interpolated fix (CONTINUOUS cells — the well
        // glides, no quadrant snapping), depth = current central + this hour's
        // tile-centre delta (the archived deepening/weakening).
        let frameWells = null;
        if (kind === 'press' && window.WW_PRESSWELL) {
          frameWells = new Map();
          for (const [tile, hd] of frameHeads) {
            const cw = hd.cw;
            if (cw.cyclonePressureHpa == null || !isFinite(cw.cyclonePressureHpa)) continue;
            const pF = frameField[tile] && frameField[tile].pressureHpa;
            const pNow = lastData[tile] && lastData[tile].pressureHpa;
            const hPaF = (typeof pF === 'number' && typeof pNow === 'number')
              ? cw.cyclonePressureHpa + (pF - pNow) : cw.cyclonePressureHpa;
            frameWells.set(tile, { pos: { x: hd.ex, y: hd.ey }, posQ: hd.pos, hPa: hPaF, cw });
          }
        }
        // This loop frame's hour h maps to the track's hourly frame g (both windows
        // end at NOW: track hour trackSpan-1 == loop hour avail-1).
        const g = trk ? (trackSpan - 1) - (avail - 1 - h) : -1;
        const trkTiles = (trk && g >= 0 && g < trk.frames.length) ? trk.frames[g].tiles : null;
        // This frame's hybrid dense grids (TEMP): nearest snapshot + per-node delta.
        let snapTiles = null, dCentres = null;
        if (denseHours) {
          const snapHour = DL.nearestHour(denseHours, frameEpoch);
          const snap = snapHour && await loadDenseSnap(snapHour);
          if (myGen !== trackGen) return;   // superseded while awaiting a snapshot
          if (snap && snap.tiles) {
            const frameC = new Array(N * N), snapC = new Array(N * N);
            for (let t = 0; t < N * N; t++) {
              const w = frameField[t] || {};
              frameC[t] = L.tempToByte(typeof w.tempC === 'number' ? w.tempC : 0) & 0xff;
              const sg = snap.tiles[t];
              snapC[t] = (sg && sg.length === 25) ? (sg[12] & 0xff) : null;
            }
            dCentres = DL.deltaCentres(frameC, snapC);
            snapTiles = snap.tiles;
          }
        }
        for (let t = 0; t < lastData.length; t++) {
          const wx = lastData[t] || {};
          // The H/L letter is a display-only poke (worker.applyCentres) driven by the
          // periph byte's centre bits (0x30 mask). Other scalars carry no centre bits.
          const framePeriph = framePeriphMap ? framePeriphMap[t] : 0;
          // The storm owns the tile ONLY on a frame where the track actually has
          // something to draw (head or trail); an affected-but-empty frame keeps its
          // isotherm corners — no reason to blank the curve for hours with no storm.
          const tf = trkTiles ? trkTiles[t] : null;
          const tfActive = !!(tf && ((tf.cyc | 0) || (tf.phen && tf.phen.length)));
          // TEMP: a storm-owned tile ships the trailer/phen wire; otherwise the hybrid
          // dense grid, falling back to the corner frame. PRESSURE is handled below
          // (pressField): every tile ships a field every frame — chart continuity.
          const fieldCells = (!tfActive && snapTiles) ? DL.hybridGrid(snapTiles, t, dCentres) : null;
          // PRESSURE loop STORM: the well rides THIS frame's field, at the position and
          // depth the frameWells pass derived from the pressure history — present on
          // EVERY frame the storm existed. Plate follows on the overlay path.
          let pressWell = null, pressPlate = null;
          const fw = frameWells && frameWells.get(t);
          if (fw && window.WW_CONTOURPLOT && frameCorners && frameCorners[t]) {
            pressWell = window.WW_PRESSWELL.wellField(promoteCorners(frameCorners[t]), fw.pos, fw.hPa);
            pressPlate = stormPlateCells(
              Object.assign({}, fw.cw, { cyclonePos: fw.posQ, cyclonePressureHpa: Math.round(fw.hPa) }),
              landMasks[t], pressWell);
          }
          // PRESSURE loop: the CHART always wins (owner QC 2026-07-30: storm-owned frames
          // dropped every isobar on the tile — "sudden dropout of all isobars SW of
          // Australia", hurricanes "only appearing on one frame"). Every press tile
          // ships its field every frame: the welled field on a storm-head frame, the
          // plain promoted field otherwise. A pressure-less storm head keeps its sprite
          // OVER the chart (cyc byte on a field frame stamps after the contours); the
          // WEATHER-page trail dots are dropped on this tab — chart continuity wins.
          const pressField = (kind === 'press' && !pressWell && frameCorners && frameCorners[t]
            && window.WW_CONTOURPLOT) ? promoteCorners(frameCorners[t]) : null;
          jobs.push(tapeJob(t, f, frameField[t], {
            // PRESSURE carries NO sprites (wells are the storm layer). Every other
            // scalar loop takes the CANONICAL head when this tile has one; a gust-
            // track head survives only away from tracked storms (unnamed lows).
            // PRESSURE carries NO sprites (wells are the storm layer); SEA likewise —
            // the radiating storm sea + plate are the storm on that tab.
            cyc: (kind === 'press' || seaRaster) ? 0
              : frameHeads.has(t) ? headCycByte(frameHeads.get(t))
              : (tfActive && !nearTrackedHead(frameHeads, t)) ? (tf.cyc | 0)
              : (trk || frameHeads.size ? 0 : liveCyc(wx)),
            iso: 0, periph: framePeriph,
            centreCell: frameCentreCells ? frameCentreCells.get(t) : null,
            // Overlay plates: the PRESSURE storm plate, or on SATELLITE/SEA the storm
            // name plate (the raster poke overwrites the sea/tile, so the plate must
            // ride the display-only labelCells path here too).
            extraLabelCells: pressPlate
              || (((satRaster || seaRaster) && frameHeads.has(t) && frameHeads.get(t).cw && frameHeads.get(t).cw.cycloneName)
                ? stormPlateCells(frameHeads.get(t).cw, landMasks[t], null) : null),
            // SATELLITE loop frame: the sliced raster replaces the whole tile.
            satFrames: satRaster
              ? [satInvCells(t, satRaster, nightMaskForTile(t % N, (t / N) | 0, frameNightGeom))]
              : null,
            // SEA loop frame: the sliced wave raster replaces the sea cells; the coast
            // outline mask rides along so the worker bakes white land + black coast
            // into the frame raster (same treatment as the still burst).
            seaFrames: seaRaster ? seaTileFrames(t, t % N, (t / N) | 0, [seaRaster]) : null,
            outlineMask: kind === 'sea' ? outlineMasks[t] : null,
            phen: (kind === 'press') ? null : ((tfActive && tf.phen && tf.phen.length) ? tf.phen : null),
            page, term: term[t] ? term[t].termByte : 0, nightGeom: frameNightGeom,
            lineCells: frameLineMasks
              ? (kind === 'sea' ? seaLineCells(frameLineMasks[t], landMasks[t]) : frameLineMasks[t])
              : null,
            fieldCells: pressWell || (kind === 'press' ? pressField : fieldCells),
            corners: (tfActive || pressWell || pressField || fieldCells) ? null : (frameCorners ? frameCorners[t] : null) }));
        }
      }
      frameCount = F;
      label = 'LAST ' + avail + 'H · ' + kind + ' · ' + F + 'f';
    } else if (page === L.PAGE.WEATHER) {
      // FULL-CHART hourly replay (owner 2026-08-03: "terminator is failing to progress
      // ... all weather is failing to progress"). The old loop was the icon-era
      // design: per-hour STORM re-detection only, so just storm-affected tiles ever
      // re-rendered — the synoptic chart underneath stayed the frozen still page and
      // the terminator was computed once at build time. Now every frame rebuilds the
      // WHOLE chart from the archived hourly readings (precip/code/temp/wind Hist)
      // and recomputes the terminator line at that frame's real UTC, so rain areas
      // grow/move/shrink and the day/night line sweeps. Storm heads ride on top
      // exactly as before. All-tile jobs per frame — the same shape every scalar
      // loop already runs; pure archive replay, zero API calls.
      const haveHist = lastData.some((w) => w &&
        ((w.precipHist && w.precipHist.length) || (w.tempHist && w.tempHist.length) ||
         (w.gustHist && w.gustHist.length) || (w.windHist && w.windHist.length)));
      if (!haveHist) { if (el) el.textContent = 'next refresh'; return; }
      let depth = 0;
      for (const w of lastData) {
        if (!w) continue;
        depth = Math.max(depth, w.precipHist ? w.precipHist.length : 0,
          w.tempHist ? w.tempHist.length : 0, w.windHist ? w.windHist.length : 0);
      }
      const availW = Math.min(trackSpan, depth);
      if (availW < 2) { if (el) el.textContent = 'WEATHER · next refresh'; return; }
      const haveSubs = lastSubResults.length === subPts.length;
      // per-hour storm layer over the same window (empty tiles are fine — the loop
      // no longer needs a storm to run)
      const { frames } = GW.trackFrames(
        lastData, seaIdx, haveSubs ? subPts : [], haveSubs ? lastSubResults : [], availW);
      // Canonical agency heads override the gust re-detected ones frame by frame
      // (owner 2026-07-30: same smooth track on every tab). Gust heads survive only
      // away from tracked storms.
      const stormTracksW = await loadStormTracks();
      if (myGen !== trackGen) return;
      const curStormsW = currentStormList(stormTracksW);
      const WCH = window.WW_WEATHERCHART;
      // hour-h reading with the still-page value as fallback (same convention as
      // scalarRealAt: window covers the last availW hours, newest at h==availW-1)
      const histAt = (hist, h, cur) => {
        if (hist && hist.length) {
          const i = hist.length - availW + h;
          if (i >= 0 && i < hist.length && hist[i] != null) return hist[i];
        }
        return cur;
      };
      for (let f = 0; f < availW; f++) {
        const frameEpoch = nowMs - (availW - 1 - f) * 3600000;
        const headsW = stormHeadsAt(curStormsW, frameEpoch);
        const fr = frames && frames[f];
        // this hour's readings, tile by tile
        const frameField = new Array(lastData.length);
        for (let t = 0; t < lastData.length; t++) {
          const wx = lastData[t];
          frameField[t] = !wx ? wx : Object.assign({}, wx, {
            tempC: histAt(wx.tempHist, f, wx.tempC),
            precipMm: histAt(wx.precipHist, f, wx.precipMm),
            weatherCode: histAt(wx.codeHist, f, wx.weatherCode),
            windKmh: histAt(wx.windHist, f, wx.windKmh),
            windDir: histAt(wx.windDirHist, f, wx.windDir),
          });
        }
        const chartT = WCH ? WCH.compute({ weather: frameField, N }) : null;
        const termT = window.WW_TERMINATOR ? window.WW_TERMINATOR.compute(frameEpoch) : null;
        for (let t = 0; t < N * N; t++) {
          const fw = frameField[t] || {};
          const wx = lastData[t] || {};
          const d = fr && fr.tiles[t];
          const hd = headsW.get(t);
          // d.cyc = the per-hour HEAD spiral byte; agency heads win, gust heads
          // survive only away from tracked storms (owner QC 2026-07-24 / 2026-07-30).
          const cyc = hd ? headCycByte(hd)
            : d && !(L.cycTierOf(d.cyc | 0) >= L.CYC.CYCLONE && nearTrackedHead(headsW, t)) ? (d.cyc | 0)
            : 0;
          jobs.push(tapeJob(t, f, fw, { cyc, iso: wx.isoByte | 0, periph: 0,
            phen: d ? d.phen : null, page: L.PAGE.WEATHER,
            termLineCells: termT && termT[t] ? termT[t].cells : null,
            chartCells: chartT ? (chartT[t] || null) : null }));
        }
      }
      frameCount = availW;
      label = 'LAST ' + availW + 'H · CHART · ' + availW + 'f';
    } else { if (el) el.textContent = 'n/a'; return; }

    trackImgs = [];
    for (let f = 0; f < frameCount; f++) trackImgs.push({});
    trackPending = jobs.length;
    if (el) el.textContent = label;
    queue.push(...jobs);
    for (const wk of workers) feed(wk);
  }

  // A tape loop is READY to replay on the active page: frames cached, all frame-tile
  // renders drained, not mid-burst, and the page has a history layer.
  // A tape loop is READY to replay on the active page: frames cached, all frame-tile
  // renders drained, not mid-burst. Any page that built frames replays (WEATHER storm
  // tracks + the scalar per-sheet time-lapses); SATELLITE/no-history pages leave
  // trackImgs null and fall through to their static/host-motion render.
  function tapeActive() {
    return trackSpan > 0 && trackImgs && trackImgs.length && trackPending === 0 && !refreshing;
  }

  // ~2fps replay: re-blit the next cached frame's tiles. Pure canvas work — the
  // machines are frozen, so it costs no ZX81 time and no API calls (like the precip
  // radar loop). The motion ticker yields to an active tape loop (see below).
  setInterval(() => {
    // WEATHER pictograms are now native machine cells (phen glyphs); their motion
    // (thunder-bolt blink, wildfire-flame flicker) is harvested as multi-frame tiles
    // and cycled by the precip-radar motion ticker below — no host overlay to repaint.
    if (!tapeActive()) return;
    trackPhase = (trackPhase + 1) % trackImgs.length;
    const fr = trackImgs[trackPhase];
    for (const t in fr) ctxs[t].putImageData(fr[t], 0, 0);
  }, 500);

  function setTrackSpan(h) {
    trackSpan = h | 0;
    try { localStorage.setItem('zwx-tracks', String(trackSpan)); } catch (e) {}
    document.querySelectorAll('#tracks .trk').forEach((b) =>
      b.classList.toggle('active', +b.dataset.h === trackSpan));
    if (trackSpan === 0) { buildTracks(); repaintPage(); return; }
    if (scalarPageKind(activePage) || activePage === L.PAGE.SATELLITE) { buildTracks(); return; }
    const haveHist = lastData && lastData.some((w) => w &&
      ((w.gustHist && w.gustHist.length) || (w.tempHist && w.tempHist.length) ||
       (w.pressHist && w.pressHist.length) || (w.windHist && w.windHist.length)));
    if (haveHist) buildTracks();
    else refresh();   // reread scheduler snapshot; browser does not fetch history
  }
  document.querySelectorAll('#tracks .trk').forEach((b) =>
    b.addEventListener('click', () => setTrackSpan(+b.dataset.h)));
  document.querySelectorAll('#tracks .trk').forEach((b) =>
    b.classList.toggle('active', +b.dataset.h === trackSpan));

  // Indexed by PAGE id, so RADAR (id 4) stays in place for the label lookup even
  // though it has no tab; SATELLITE (id 6) is appended.
  const PAGE_LABELS = ['TEMP', 'WEATHER', 'WIND', 'SEA', 'RADAR', 'PRESSURE', 'SATELLITE'];
  const PAGE_KEYS = { TEMP: L.PAGE.TEMP, WEATHER: L.PAGE.WEATHER, WIND: L.PAGE.WIND, SEA: L.PAGE.SEA, PRESSURE: L.PAGE.PRESSURE, SATELLITE: L.PAGE.SATELLITE };

  function applyTabUI() {
    document.querySelectorAll('#tabs .tab').forEach((b) => {
      const p = b.dataset.page;
      const isAuto = p === 'auto';
      b.classList.toggle('active', isAuto ? autoMode : (!autoMode && +p === activePage));
      // while auto-rotating, faintly mark the page currently on the wall
      b.classList.toggle('showing', autoMode && !isAuto && +p === activePage);
    });
    const banner = $('page-banner');
    if (banner) banner.textContent = (autoMode ? 'AUTO · ' : '') + (PAGE_LABELS[activePage] || '');
    document.querySelectorAll('footer .grp[data-legend]').forEach((g) => {
      g.style.display = (+g.dataset.legend === activePage) ? '' : 'none';
    });
  }

  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = 0; } }
  function startAuto() {
    stopAuto();
    autoTimer = setInterval(() => {
      const idx = PAGES.indexOf(activePage);
      activePage = PAGES[(idx + 1) % PAGES.length];
      try { localStorage.setItem('zwx-page', String(activePage)); } catch (e) {}
      applyTabUI();
      repaintPage();
    }, AUTO_PERIOD_MS);
  }
  // Clicking a view tab pauses rotation on that view; clicking AUTO resumes.
  function setPage(page) {
    activePage = page; autoMode = false; stopAuto();
    try { localStorage.setItem('zwx-page', String(page)); localStorage.setItem('zwx-auto', '0'); } catch (e) {}
    applyTabUI(); repaintPage();
  }
  function setAuto() {
    autoMode = true;
    try { localStorage.setItem('zwx-auto', '1'); } catch (e) {}
    // Cycle-all is two-level: ensure the inner 24h loop is on so every sheet the
    // rotation lands on time-lapses its own prior 24h (honest-degrading where a
    // sheet has no archived history). Respect a span the user already picked.
    if (trackSpan === 0) {
      trackSpan = CYCLE_SPAN_H;
      try { localStorage.setItem('zwx-tracks', String(trackSpan)); } catch (e) {}
      document.querySelectorAll('#tracks .trk').forEach((b) =>
        b.classList.toggle('active', +b.dataset.h === trackSpan));
    }
    startAuto(); applyTabUI(); repaintPage();
  }
  document.querySelectorAll('#tabs .tab').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.page === 'auto') setAuto(); else setPage(+b.dataset.page);
    });
  });
  applyTabUI();
  if (autoMode) startAuto();

  function scheduleNext() {
    // Exponential backoff while the scheduler snapshot is missing. This is no
    // longer provider backoff: browser refreshes never spend Open-Meteo quota.
    const delay = failStreak
      ? Math.min(REFRESH_MS * Math.pow(2, failStreak - 1), 2 * 3600000)
      : REFRESH_MS;
    nextRefreshAt = Date.now() + delay;
    setTimeout(refresh, delay);
  }

  // countdown ticker
  setInterval(() => {
    if (!nextRefreshAt) return;
    const s = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    $('s-count').textContent = s + 's';
  }, 250);

  // precip radar-loop ticker: re-blit the next drift frame for any tile that
  // carries more than one (moving precip in radar mode). Costs ZERO API calls and
  // no ZX81 CPU time — the frames were rasterised once during the burst. The eye
  // separates the moving precip layer from the static isotherm/coastline base.
  setInterval(() => {
    // SATELLITE/SEA: the motion-enhanced cloud field and the rolling sea swell live on
    // the host overlay canvas (z-index above the machine tiles), so they must advance
    // even while a still-frame tape loop "owns" the tiles — same canvas split as the
    // WEATHER broadcast overlay. SEA in particular builds a still-frame time-lapse (no
    // wave history), which makes tapeActive() true; redrawing the overlay BEFORE the
    // tape yield is what keeps the swell rolling instead of freezing to raw ZX81 hash.
    // SATELLITE + SEA are now fully native: their per-cell cloud/swell motion frames
    // are harvested into the tiles and cycled below (like the precip radar loop), so
    // there is no host overlay tick to run here anymore.
    if (tapeActive()) return;   // a tape loop owns the machine tiles — don't fight its blits
    motionPhase++;
    for (let t = 0; t < N * N; t++) {
      const fr = tileFrames[t];
      if (fr && fr.length > 1) ctxs[t].putImageData(fr[motionPhase % fr.length], 0, 0);
    }
  }, MOTION_MS);

  function startWall() { refresh(); }

  // ---- REPORTER ticker -------------------------------------------------------
  // The gateway's report cycle (tools/refresh-report.js) writes the reporter's
  // latest on-machine bulletin to docs/latest-report.{txt,json}. Poll it and
  // crawl the text; the bulletin was composed on the 101st ZX81 and delivered
  // over its cassette port, then reassembled here — this panel just displays it.
  function weatherDisplayTickerText(text) {
    // The reporter is a general marine bulletin and may mention extratropical lows.
    // WEATHER's front-page contract is stricter: no cyclone/low cues unless a named
    // tropical storm/cyclone/hurricane is being displayed, so strip generic lows here.
    return String(text || '')
      .replace(/\s+\d+\s+(?:STORM|HURRICANE)-FORCE LOWS?\s+[A-Z ]+?\./g, '.')
      .replace(/\.\s*\./g, '.')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  async function updateTicker() {
    try {
      const r = await fetch('/docs/latest-report.json', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        const box = $('ticker');
        $('ticker-text').textContent = weatherDisplayTickerText(o.text || '');
        $('ticker-g').textContent = o.graphemes != null ? o.graphemes : '–';
        const armed = !!o.armed;
        $('ticker-status').textContent = armed
          ? (o.posted ? 'POSTED' : (o.status || 'ARMED'))
          : 'DRY-RUN';
        if (box) box.classList.toggle('armed', armed);
        return;
      }
    } catch (e) {}
    try {
      const r2 = await fetch('/docs/latest-report.txt', { cache: 'no-store' });
      if (r2.ok) { const t = (await r2.text()).trim(); if (t) $('ticker-text').textContent = weatherDisplayTickerText(t); }
    } catch (e) {}
  }
  updateTicker();
  setInterval(updateTicker, 60000);   // the bulletin only changes each refresh

  // ---- boot: load template, then start workers ----
  fetch('/data/template.json')
    .then((r) => { if (!r.ok) throw new Error('template HTTP ' + r.status); return r.json(); })
    .then((json) => { template = json; initWorkers(); })
    .catch((err) => { $('s-api').textContent = 'NO TEMPLATE'; $('s-api').className = 'fail'; console.error(err); });
})();
