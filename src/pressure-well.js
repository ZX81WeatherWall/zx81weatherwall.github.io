// pressure-well.js — the PRESSURE page's storm-as-field treatment (owner 2026-07-30 QC:
// "Can we either draw the actual isobaric lines or else simulate them with best effort
// from the available data?"). Instead of stamping ring art over the chart, the storm
// tile's 25-node pressure grid is DEEPENED by a parametric well — central pressure at
// the eye, blending smoothly to the ambient field, exactly ZERO at the tile-edge nodes
// (edge nodes are SHARED with neighbours, so the well must never move them or the
// isobars tear at the seam). The machine's own marching-squares engine then draws the
// storm's isobars: thin quadrant-resolution curves, the same line weight as the rest of
// the chart, naturally tighter and more numerous for deeper storms, and morphing with
// the ambient field on every loop frame. The charm-over-truth exception applies to the
// WELL SHAPE only (a radial profile, not measured structure); its centre value is the
// storm's real reported central pressure and the surroundings are the real field.
//
// PURE + deterministic; node + browser (window.WW_PRESSWELL).
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const GL = (typeof require === 'function') ? require('./glyphs') : g.WW_GLYPHS;

  const MG = 4;                                   // 5x5 nodes -> 4 steps per axis
  const NSX = L.TILE_W / MG, NSY = L.TILE_H / MG; // node spacing in cells (8 x 6)
  const R = 14;                                   // well radius in cells (sub-tile: cap < half tile)
  // Drawn-depth cap: 6 closed isobars (24 MB) below the local ambient. Deeper than that
  // the 4 MB lines pack tighter than the quadrant plot resolves and the eye smears into
  // a solid blot (owner QC: lines "too thick... distracting"). The plate still quotes the
  // storm's TRUE central pressure — only the DRAWN well is clamped for legibility.
  const MAX_DEPTH = 24;

  // wellField(gv, pos, hPa) -> new 25-entry byte grid with the storm well folded in.
  //   gv  : the tile's ambient 5x5 pressure grid, L.pressToByte scale (950-datum)
  //   pos : eye position — a SUB_CELL index, or {x,y} CONTINUOUS cell coords (the
  //         storm-track path: the well centres on the interpolated agency fix)
  //   hPa : the storm's central pressure. null/non-finite -> the grid is returned
  //         unchanged (no well is ever fabricated without a real reading).
  function wellField(gv, pos, hPa) {
    if (!gv || gv.length !== 25) return gv;
    if (hPa == null || !isFinite(hPa)) return gv.slice();
    const c = (pos && typeof pos === 'object') ? [pos.x | 0, pos.y | 0]
      : (GL.SUB_CELL[pos | 0] || GL.SUB_CELL[0]);
    const ex = c[0], ey = c[1];
    // Local ambient at the eye (bilinear over the 5x5), for the drawn-depth cap.
    const fx = Math.min(3, Math.max(0, ex / NSX - 0.0001)), fy = Math.min(3, Math.max(0, ey / NSY - 0.0001));
    const gx0 = Math.floor(fx), gy0 = Math.floor(fy), tx = fx - gx0, ty = fy - gy0;
    const av = (gx, gy) => L.PRESS_ISO_DATUM + (gv[gy * 5 + gx] & 0xff);
    const ambEye = (av(gx0, gy0) * (1 - tx) + av(gx0 + 1, gy0) * tx) * (1 - ty)
                 + (av(gx0, gy0 + 1) * (1 - tx) + av(gx0 + 1, gy0 + 1) * tx) * ty;
    const drawn = Math.max(hPa, ambEye - MAX_DEPTH);
    const out = new Array(25);
    for (let gy = 0; gy <= MG; gy++)
      for (let gx = 0; gx <= MG; gx++) {
        const i = gy * 5 + gx;
        const ambient = L.PRESS_ISO_DATUM + (gv[i] & 0xff);
        let v = ambient;
        // Edge nodes are SHARED with the neighbouring tile's grid — never welled.
        if (gx > 0 && gx < MG && gy > 0 && gy < MG) {
          const d = Math.hypot(gx * NSX - ex, gy * NSY - ey);
          if (d < R) {
            // LINEAR profile: uniform isobar spacing across the well (a quadratic
            // profile bunches the 4 MB lines mid-radius past the plot resolution).
            const w = 1 - d / R;
            v = ambient + (drawn - ambient) * w;
          }
        }
        out[i] = L.pressToByte(v) & 0xff;
      }
    return out;
  }

  const API = { wellField, R, NSX, NSY };
  g.WW_PRESSWELL = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
