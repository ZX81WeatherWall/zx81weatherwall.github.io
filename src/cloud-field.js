// cloud-field.js — the SATELLITE page's cloud texture engine (owner QC 2026-07-30:
// still clouds "look like wobbling jello", the loop is "stipple blocks popping
// around the grid. Just pure nonsense"). Both symptoms came from the same root:
// the page had NO spatial cloud model — a frozen 2024 GIBS raster shimmered by
// sinusoids for the still, and a one-scalar-per-tile band flip for the loop.
//
// This module gives the wall a deterministic cloud TEXTURE whose placement is
// styling but whose two governing quantities are REAL data supplied by the
// caller: per-tile cloud COVER (Open-Meteo cloud_cover / cloudHist) sets how
// much of each tile is clouded, and per-tile WIND (windHist + windDirHist)
// advects the texture so cloud masses genuinely travel frame-to-frame.
//
//   buildBase(W, H)     — one static rank-normalised value-noise field, x-periodic.
//                         Rank normalisation makes the values UNIFORM in [0,1), so
//                         thresholding at cover% yields cover% of cells clouded.
//   sample(b,W,H,x,y)   — bilinear sample, x wraps (date line), y clamps (poles).
//   levelFor(n, pct)    — 0 clear / 1 thin / 2 thick. Total cover tracks pct;
//                         thick fraction = (pct/100)^2 (overcast tiles read solid,
//                         scattered tiles read broken — the usual satellite look).
//   cycloneLevelAt(...) — the comma/spiral cloud signature of a tropical cyclone:
//                         clear eye, solid core, two log-spiral rain bands with
//                         hemisphere-correct rotation sense; `phase` spins the
//                         bands so the storm visibly ROTATES across frames.
//   stampCyclone(...)   — burns that signature into a level raster (x wraps).
//
// PURE + deterministic (integer-hash noise, no Math.random); node + browser
// (window.WW_CLOUDFIELD).
(function (g) {
  'use strict';

  // integer hash -> uniform-ish [0,1); deterministic across platforms
  function h2(ix, iy, seed) {
    let h = (ix * 374761393 + iy * 668265263 + seed * 1013904223) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function smooth(u) { return u * u * (3 - 2 * u); }

  // one octave of x-periodic value noise (lattice period `p` cells)
  function octave(W, H, x, y, p, seed) {
    const nx = W / p;                       // lattice columns (W must divide by p)
    const gx = x / p, gy = y / p;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = smooth(gx - x0), fy = smooth(gy - y0);
    const xa = ((x0 % nx) + nx) % nx, xb = (xa + 1) % nx;
    const v00 = h2(xa, y0, seed), v10 = h2(xb, y0, seed);
    const v01 = h2(xa, y0 + 1, seed), v11 = h2(xb, y0 + 1, seed);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  }

  // buildBase(W, H) -> Float32Array(W*H), values uniform in [0,1) by construction
  // (rank-normalised). Octaves at 32/16/8 cells: synoptic-scale masses with broken
  // detail, not per-cell salt. W should be divisible by 32 (the wall's 320 is).
  function buildBase(W, H) {
    const n = W * H, raw = new Float64Array(n);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        raw[y * W + x] = 0.5 * octave(W, H, x, y, 32, 11)
                       + 0.3 * octave(W, H, x, y, 16, 23)
                       + 0.2 * octave(W, H, x, y, 8, 47);
    // rank-normalise: sort indices by raw value (ties by index — deterministic),
    // assign each cell its rank/n. Thresholding at t now selects exactly ~t*n cells.
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    Array.prototype.sort.call(idx, (a, b) => (raw[a] - raw[b]) || (a - b));
    const out = new Float32Array(n);
    for (let r = 0; r < n; r++) out[idx[r]] = r / n;
    return out;
  }

  // bilinear sample at CONTINUOUS (x,y): x wraps (cyclic longitude), y clamps.
  function sample(base, W, H, x, y) {
    const x0 = Math.floor(x), y0f = Math.floor(y);
    const fx = x - x0, fy = y - y0f;
    const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
    const y0 = Math.max(0, Math.min(H - 1, y0f));
    const y1 = Math.max(0, Math.min(H - 1, y0f + 1));
    return (base[y0 * W + xa] * (1 - fx) + base[y0 * W + xb] * fx) * (1 - fy)
         + (base[y1 * W + xa] * (1 - fx) + base[y1 * W + xb] * fx) * fy;
  }

  // n (uniform [0,1)) + real cover pct -> cloud level 0/1/2.
  function levelFor(n, pct) {
    const cover = Math.max(0, Math.min(100, pct == null ? 0 : pct)) / 100;
    if (n >= cover) return 0;
    return n < cover * cover ? 2 : 1;
  }

  // Cyclone comma/spiral signature at offset (dx,dy) cells from the eye, storm
  // radius r cells. north=true -> counterclockwise band rotation (NH), else CW.
  // phase (radians) spins the bands. Returns 0/1/2 override, or -1 (ambient).
  function cycloneLevelAt(dx, dy, r, north, phase) {
    const rho = Math.hypot(dx, dy) / r;
    if (rho > 1.15) return -1;
    if (rho < 0.10) return 0;                          // clear eye
    if (rho < 0.38) return 2;                          // solid central dense overcast
    // Screen y grows SOUTHWARD, so atan2 over raw (dy,dx) mirrors the spin: a
    // mathematically-CCW spiral renders CLOCKWISE (owner QC 2026-07-30: "clockwise
    // flow in the hurricanes instead of ccw"). Negate dy to work in math axes;
    // north (s=+1) then curls and rotates counterclockwise ON SCREEN, south mirrors.
    const s = north ? 1 : -1;
    const a = s * (Math.atan2(-dy, dx) - phase) + 2.6 * Math.log(rho);
    const frac = ((a / Math.PI) % 2 + 2) % 2;          // two arms: period pi in angle
    const arm = frac < 1.0;
    if (arm) return rho < 1.0 ? 2 : 1;                 // rain band, thinning outward
    return rho < 0.9 ? 0 : -1;                         // dark moat between bands
  }

  // Burn the signature into a level raster (Uint8Array W*H, values 0..2). x wraps.
  function stampCyclone(levels, W, H, cx, cy, r, north, phase) {
    const R = Math.ceil(r * 1.15);
    for (let dy = -R; dy <= R; dy++) {
      const y = Math.round(cy) + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const v = cycloneLevelAt(dx, dy, r, north, phase);
        if (v < 0) continue;
        const x = ((Math.round(cx) + dx) % W + W) % W;
        levels[y * W + x] = v;
      }
    }
  }

  const API = { buildBase, sample, levelFor, cycloneLevelAt, stampCyclone };
  g.WW_CLOUDFIELD = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
