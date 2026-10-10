// smokeflow.js — downwind wildfire SMOKE advection field.
//
// The companion to windflow.js: same honest advection of the REAL per-tile wind
// field, but with FIRE SOURCES. Smoke is emitted at each active fire (weighted by
// its fire load), advected DOWNWIND through the wind field, and accumulated into a
// density grid that fades with distance/age — so real plumes stream downwind, bend
// with the wind, and merge into regional palls exactly where the smoke goes.
//
// AUTHENTICITY (the charm bar — see windflow.js):
//   * Sources are REAL fires (nifc/effis/bc lat-lon binned to tiles); strength is
//     the real per-tile fire load. Advection uses the REAL wind vectors (the same
//     Open-Meteo wind the WIND page transmits), via windflow's tileVel/sampleField.
//   * The tape master (app.js — the side that sees all 100 tiles) computes the
//     density field; the ZX81 fleet DRAWS the 1-bit cells (the blessed coastline-
//     mask / poke-as-data model, same as windflow's dots and the smooth-temp field).
//   * A calm tile advects nothing new (smoke stalls, never a fabricated breeze); a
//     source-less region stays clear (no fabricated smoke).
//   * Whole-cell fixed-point Euler steps — arithmetic a real ZX81 could do.
//
// simulate() returns a per-tile per-cell smoke-density char overlay (graded 1-bit
// dither: clear -> light stipple -> checker -> dense -> solid), so density VARIES
// cell-by-cell along the plume instead of one flat hatch.

(function (g) {
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const WF = (typeof require === 'function') ? require('./windflow') : g.WW_WINDFLOW;

  const TW = L.TILE_W, TH = L.TILE_H;     // 32 x 24 cells per tile
  const FP = 8;                           // fixed-point: 1/8-cell units (matches windflow)

  // ---- tuneables --------------------------------------------------------------
  // RANGE (owner QC 2026-07-29: "dense regions of smoke on tracks along the eastern
  // pacific... a frequent link between BC and Hawaii"). Decay was PER STEP, but a step
  // advances by the wind speed — so a gale carried a plume ~5 cells/step for 150 steps:
  // measured reach 276 cells ≈ 33,000 km, wrapping the globe, with the area-quantile
  // classifier promoting the accumulated streamline corridor to DENSE at any distance.
  // Decay is now PER CELL OF TRAVEL, making range wind-speed-INDEPENDENT and physical:
  // 0.88/cell ≈ 28% mass at ~10 cells (~1,200 km — the dense core), cutoff (<0.03) at
  // ~27 cells ≈ 3,200 km — long-range transport reads as the faint tail it really is,
  // and BC smoke no longer parks a dense ribbon on Hawaii.
  // FADE 0.88 -> 0.84 (owner QC 2026-07-29 round 2: with 27-cell tails, the US and EU/AF
  // fires' plumes MET mid-Atlantic — two honest tails fusing into one dishonest bridge, a
  // measured near-continuous stipple band across the 64-cell ocean gap). 0.84 cuts off at
  // ~20 cells ≈ 2,400 km, so opposite-shore tails span ~40 of the 64 cells and the mid-
  // ocean stays clear. Real trans-Atlantic smoke exists but is haze, invisible at this
  // rendering scale — a readable band overstates it.
  const STEPS = 150;          // safety bound on advection iterations (range is FADE's job)
  const FADE = 0.84;          // per-CELL-travelled mass decay — the plume thins with DISTANCE
  const EMIT = [0, 4, 7, 12]; // particles per source by intensity 1..3 (index 0 unused)
  const DIFFUSE = 4;          // lateral half-spread (cells) the deposit smears, grows downwind
  // Density -> ZX81 cell char. Ordered thresholds; the Bayer matrix (below) turns a
  // continuous density into a graded stipple so the plume reads as smoke, not a fill.
  const SOLID = 0x80, DENSE = 0x08, LIGHT = 0x08, BLANK = 0x00;

  // 4x4 Bayer ordered-dither matrix (0..15) — deterministic, no RNG.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function hash16(i) {
    let h = (i * 2654435761) >>> 0; h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return h & 0xffff;
  }

  // Accumulate the raw smoke-density grid (Float32, length GW*GH), normalised 0..1.
  // opts: { N, vecs:[{oct,kmh}], sources:[{tile, intensity, cx, cy}] }.
  function densityField(opts) {
    const N = opts.N || 10, GW = N * TW, GH = N * TH;
    const vecs = opts.vecs || [], sources = opts.sources || [];
    const vel = new Array(N * N);
    for (let t = 0; t < N * N; t++) {
      const w = vecs[t] || {};
      vel[t] = WF.tileVel(w.oct == null ? -1 : w.oct | 0, w.kmh || 0);
    }
    const dens = new Float32Array(GW * GH);
    const GW8 = GW * FP, GH8 = (GH - 1) * FP;
    const deposit = (cx, cy, m, spread) => {
      // smear the deposit over a small lateral kernel that widens downwind (the
      // plume broadens as it travels) — real diffusion, cheap.
      for (let dy = -spread; dy <= spread; dy++) {
        const yy = cy + dy; if (yy < 0 || yy >= GH) continue;
        for (let dx = -spread; dx <= spread; dx++) {
          const w = m / (1 + dx * dx + dy * dy);           // gaussian-ish falloff
          const xx = ((cx + dx) % GW + GW) % GW;
          dens[yy * GW + xx] += w;
        }
      }
    };
    for (let si = 0; si < sources.length; si++) {
      const f = sources[si];
      const it = Math.max(1, Math.min(3, f.intensity | 0));
      const emit = EMIT[it];
      const ox = (f.tile % N) * TW, oy = ((f.tile / N) | 0) * TH;
      for (let e = 0; e < emit; e++) {
        const h = hash16(si * 131 + e * 977 + 1);
        // scatter the emission point a little around the fire cell
        let X8 = (ox + (f.cx == null ? 16 : f.cx) + ((h & 7) - 3)) * FP;
        let Y8 = (oy + (f.cy == null ? 12 : f.cy) + (((h >> 3) & 7) - 3)) * FP;
        let mass = 1.0;
        for (let s = 0; s < STEPS; s++) {
          const cx = (X8 >> 3), cy = (Y8 >> 3);
          const spread = Math.min(DIFFUSE, 1 + ((s / 30) | 0));
          deposit(((cx % GW) + GW) % GW, cy, mass, spread);
          const sv = WF.sampleField(vel, N, X8 / FP, Y8 / FP);
          // Calm air: smoke pools, but decay FAST (0.7/step) — at 0.9 a becalmed
          // particle deposited ~30 steps into one cell and the pooled mass swamped
          // the global normalization (the "black slug" bug). ~8 deposits reads as
          // a genuine stagnant haze without dominating the whole field.
          if (sv.vx8 === 0 && sv.vy8 === 0) { mass *= 0.7; if (mass < 0.05) break; continue; }
          X8 += sv.vx8; Y8 += sv.vy8;
          X8 = ((X8 % GW8) + GW8) % GW8;
          if (Y8 < 0) Y8 = 0; else if (Y8 > GH8) Y8 = GH8;
          // decay by the DISTANCE just travelled (cells), not by the iteration count —
          // a fast wind must shorten the plume's lifetime, not multiply its length.
          mass *= Math.pow(FADE, Math.hypot(sv.vx8, sv.vy8) / FP);
          if (mass < 0.03) break;
        }
      }
    }
    // Tier thresholds by AREA QUANTILE of the nonzero cells (equal-count
    // classification — standard choropleth practice). Guarantees the HMS-like
    // distribution regardless of absolute mass: most of a plume reads LIGHT,
    // the middle CHECKER, and only the top slice DENSE/SOLID at the cores —
    // immune to one pooled hotspot skewing a global divisor.
    const nz = [];
    for (let i = 0; i < dens.length; i++) if (dens[i] > 0) nz.push(dens[i]);
    nz.sort((a, b) => a - b);
    const q = (p) => nz.length ? nz[Math.min(nz.length - 1, (nz.length * p) | 0)] : Infinity;
    const th = { t1: q(0.55), t2: q(0.85), t3: q(0.96) };
    return { W: GW, H: GH, density: dens, th };
  }

  // density -> ZX81 cell char: four ORDINAL textures picked by the area-quantile
  // tier (th from densityField), dithered by Bayer so each tier has a distinct,
  // stable, obviously-increasing 1-bit texture (HMS light / medium / heavy + core):
  //   tier0 faint tail : sparse grey stipple (~1 in 4)
  //   tier1 light plume: half grey checker
  //   tier2 heavy body : full grey + scattered solid
  //   tier3 core       : mostly solid over grey
  function cellChar(d, gx, gy, th) {
    if (!(d > 0)) return BLANK;
    const b = (BAYER[(gy & 3) * 4 + (gx & 3)] + 0.5) / 16;
    if (th && d >= th.t3) return b < 0.75 ? SOLID : DENSE;
    if (th && d >= th.t2) return b < 0.25 ? SOLID : DENSE;
    if (th && d >= th.t1) return b < 0.5 ? LIGHT : BLANK;
    return b < 0.25 ? LIGHT : BLANK;
  }

  // simulate(...) -> per-tile overlay: array length N*N; each entry a list of
  // {i, c} (i = local cell index y*TW+x, c = ZX81 char). Static field (the plume
  // shape); the caller pokes it as smoke cells the machine draws.
  function simulate(opts) {
    const N = opts.N || 10;
    const { W, H, density, th } = densityField(opts);
    const out = new Array(N * N);
    for (let t = 0; t < N * N; t++) out[t] = [];
    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) {
        const c = cellChar(density[gy * W + gx], gx, gy, th);
        if (!c) continue;
        const t = ((gy / TH) | 0) * N + ((gx / TW) | 0);
        const i = (gy % TH) * TW + (gx % TW);
        out[t].push({ i, c });
      }
    }
    return out;
  }

  // ---- SMOKE TIME-LAPSE (owner 2026-07-28: "show how the smoke drifts over a 12/24/48
  // hour cycle") -----------------------------------------------------------------------
  // One plume field per ARCHIVED hour: frame h re-runs the steady-state advection with
  // hour h's REAL per-tile wind vector (windHist + windDirHist, newest-last — the same
  // honest-window slicing as the scalar time-lapses), against today's fire sources.
  //
  // HONESTY NOTE, deliberate and documented: the SOURCES are today's fires for every
  // frame — historical fire-perimeter feeds are not archived, and incidents move on a
  // scale of days while the wind swings hourly, so the drift story (what owner asked to
  // see) lives almost entirely in the wind. A tile with no direction history for hour h
  // contributes NO advection that frame (honest stall, never a fabricated breeze —
  // the same rule simulate() applies to calm tiles).
  //
  // loopFrames(data, sources, opts) -> { frames: [per-tile smokeCells x F], hours: F,
  //   avail } — frames oldest-first, newest last (== the live "now" plume when hour
  //   avail-1 uses the current wind). Returns { frames: [], avail } when direction
  //   history has not accrued yet (the caller shows "SMOKE · next refresh").
  //   opts: { N, spanH (12/24/48), frameCount (samples across the span) }.
  function loopFrames(data, sources, opts) {
    const o = opts || {};
    const N = o.N || 10;
    const spanH = o.spanH || 24;
    // shortest usable BOTH-series history across tiles that have wind at all
    let avail = Infinity, any = false;
    for (let t = 0; t < N * N; t++) {
      const w = data[t];
      if (!w || !Array.isArray(w.windHist) || !Array.isArray(w.windDirHist)) continue;
      const len = Math.min(w.windHist.length, w.windDirHist.length);
      if (len > 0) { any = true; avail = Math.min(avail, len); }
    }
    if (!any || !isFinite(avail)) return { frames: [], avail: 0 };
    avail = Math.min(avail, spanH);
    if (avail < 2) return { frames: [], avail };
    const F = Math.min(o.frameCount || (spanH >= 48 ? 12 : spanH >= 24 ? 9 : 6), avail);
    const frames = [];
    for (let f = 0; f < F; f++) {
      const h = F === 1 ? avail - 1 : Math.round((f * (avail - 1)) / (F - 1));
      const vecs = new Array(N * N);
      for (let t = 0; t < N * N; t++) {
        const w = data[t] || {};
        const wh = w.windHist, dh = w.windDirHist;
        let kmh = null, dir = null;
        if (Array.isArray(wh) && Array.isArray(dh)) {
          const len = Math.min(wh.length, dh.length);
          const i = len - avail + h;                       // newest-last window, like scalarRealAt
          if (i >= 0 && i < len) { kmh = wh[i]; dir = dh[i]; }
        }
        vecs[t] = (kmh != null && dir != null && isFinite(kmh) && isFinite(dir))
          ? { oct: L.windDirToOctant(dir), kmh: kmh }
          : { oct: -1, kmh: 0 };
      }
      frames.push(simulate({ N, vecs, sources }));
    }
    return { frames, avail };
  }

  const SF = { densityField, cellChar, simulate, loopFrames, STEPS, FADE };
  g.WW_SMOKEFLOW = SF;
  if (typeof module !== 'undefined' && module.exports) module.exports = SF;
})(typeof window !== 'undefined' ? window : globalThis);
