// contours.js — real marching-squares contour generator for the Weather Wall.
//
// FS8-F1. The legacy "isobars" (src/texture.js contourGlyph / byte6 edge masks)
// draw a HALF-BLOCK on the outermost cell of a tile whenever a neighbouring tile
// sits in a different pressure band. By construction that can only put ink on a
// TILE BOUNDARY, so the result reads as right-angled boxes hugging the 10x10 grid
// — not isobars. A meteorologist does not recognise it as a synoptic chart.
//
// This module instead does what a real chart does: it takes the sparse 10x10
// field of tile-centre samples (MSL pressure or temperature), bilinearly
// upsamples it to a fine grid, and runs marching squares at fixed intervals
// (4 hPa for isobars, per WMO) to produce smooth, nested, CLOSED contour curves
// that flow ACROSS tile boundaries. The web compositor (web/app.js) strokes these
// as a vector overlay on top of the ZX81 tiles; the ZX81/texture.js byte path is
// untouched (its parity proofs stay green — app.js simply stops feeding it the
// byte6 band mask on the pages this overlay owns).
//
// Coordinates are WALL-TILE units: x in [0, N] is the column axis, y in [0, N]
// the row axis, so a point (X, Y) lands in tile (row=floor(Y), col=floor(X)) at
// local fraction (X-col, Y-row). Node grid spans the whole wall so contours reach
// the map edges. Dual module (browser: window.WW_CONTOURS; node: require).
(function (g) {
  'use strict';

  // Bilinear sample of the tile-CENTRE field at wall position (X, Y). Centres sit
  // at (col+0.5, row+0.5); the outer half-tile margin extrapolates the edge value
  // (clamp) so contours reach the wall edge without inventing structure. Returns
  // NaN if any of the four surrounding centres has no datum (a hole in the field)
  // — marching squares then skips every cell that touches the hole.
  function sampleField(centres, N, X, Y) {
    let fi = X - 0.5, fj = Y - 0.5;
    if (fi < 0) fi = 0; else if (fi > N - 1) fi = N - 1;
    if (fj < 0) fj = 0; else if (fj > N - 1) fj = N - 1;
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const i1 = Math.min(i0 + 1, N - 1), j1 = Math.min(j0 + 1, N - 1);
    const tx = fi - i0, ty = fj - j0;
    const v00 = centres[j0 * N + i0], v10 = centres[j0 * N + i1];
    const v01 = centres[j1 * N + i0], v11 = centres[j1 * N + i1];
    if (v00 == null || v10 == null || v01 == null || v11 == null) return NaN;
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  }

  // Build the fine node grid (values + wall positions) from the 10x10 centres.
  // S = upsample factor per tile (S=6 -> 60x60 cells over the whole wall). Nodes
  // span wall [0,N] x [0,N] inclusive.
  function buildGrid(centres, N, S) {
    const gx = N * S + 1, gy = N * S + 1;      // node counts
    const val = new Float64Array(gx * gy);
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++)
        val[j * gx + i] = sampleField(centres, N, i / S, j / S);
    return { val, gx, gy, S };
  }

  // Linear crossing point between two node values along an edge, in wall coords.
  function lerp(ax, ay, av, bx, by, bv, level) {
    let t = (level - av) / (bv - av);
    if (!isFinite(t)) t = 0.5;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  }

  // Marching squares over the node grid at one level -> array of segments
  // [x0,y0,x1,y1] in wall coords. Corners labelled TL,TR,BR,BL; standard 16 cases,
  // saddles (5,10) resolved by the cell-centre average.
  function marchLevel(grid, level) {
    const { val, gx, gy, S } = grid;
    const segs = [];
    for (let j = 0; j < gy - 1; j++) {
      for (let i = 0; i < gx - 1; i++) {
        const tl = val[j * gx + i], tr = val[j * gx + i + 1];
        const br = val[(j + 1) * gx + i + 1], bl = val[(j + 1) * gx + i];
        if (tl !== tl || tr !== tr || br !== br || bl !== bl) continue; // NaN hole
        let code = 0;
        if (tl >= level) code |= 8;
        if (tr >= level) code |= 4;
        if (br >= level) code |= 2;
        if (bl >= level) code |= 1;
        if (code === 0 || code === 15) continue;
        // wall coords of the four corners
        const x0 = i / S, x1 = (i + 1) / S, y0 = j / S, y1 = (j + 1) / S;
        // edge crossing points (T=top,R=right,B=bottom,L=left)
        const T = () => lerp(x0, y0, tl, x1, y0, tr, level);
        const R = () => lerp(x1, y0, tr, x1, y1, br, level);
        const B = () => lerp(x0, y1, bl, x1, y1, br, level);
        const Lf = () => lerp(x0, y0, tl, x0, y1, bl, level);
        const push = (p, q) => segs.push([p[0], p[1], q[0], q[1]]);
        switch (code) {
          case 1: push(Lf(), B()); break;
          case 2: push(B(), R()); break;
          case 3: push(Lf(), R()); break;
          case 4: push(T(), R()); break;
          case 6: push(T(), B()); break;
          case 7: push(Lf(), T()); break;
          case 8: push(T(), Lf()); break;
          case 9: push(T(), B()); break;
          case 11: push(T(), R()); break;
          case 12: push(Lf(), R()); break;
          case 13: push(B(), R()); break;
          case 14: push(Lf(), B()); break;
          case 5: {                                   // saddle
            const c = (tl + tr + br + bl) / 4;
            if (c >= level) { push(Lf(), T()); push(B(), R()); }
            else { push(T(), R()); push(Lf(), B()); }
            break;
          }
          case 10: {                                  // saddle
            const c = (tl + tr + br + bl) / 4;
            if (c >= level) { push(T(), R()); push(Lf(), B()); }
            else { push(Lf(), T()); push(B(), R()); }
            break;
          }
        }
      }
    }
    return segs;
  }

  // Levels crossing the field range at `step`, snapped to multiples of `step`.
  function levelsFor(min, max, step, base) {
    const out = [];
    if (!isFinite(min) || !isFinite(max) || max - min < 1e-6) return out;
    const b = base == null ? 0 : base;
    let lv = Math.ceil((min - b) / step) * step + b;
    for (; lv <= max; lv += step) out.push(+lv.toFixed(6));
    return out;
  }

  // Public: compute contour lines for a scalar field over the 10x10 tile grid.
  //   weatherArr : the 100-tile weather map (per-tile objects)
  //   N          : grid dimension (10)
  //   opts.key   : field key ('pressureHpa' | 'tempC')
  //   opts.step  : contour interval (4 hPa / 5 degC)
  //   opts.major : a line is "major" (bold + labelled) when level % major === 0
  //   opts.S     : upsample factor (default 6)
  //   opts.unit  : label suffix ('' for hPa, '°' for temp)
  // Returns { lines:[{ level, major, unit, segs:[[x0,y0,x1,y1]...] }], min, max }.
  function computeContours(weatherArr, N, opts) {
    const key = opts.key, step = opts.step, S = opts.S || 6;
    const majorStep = opts.major || step;
    const centres = new Array(N * N);
    let min = Infinity, max = -Infinity, have = 0;
    for (let t = 0; t < N * N; t++) {
      const w = weatherArr[t];
      const v = (w && w[key] != null && isFinite(w[key])) ? +w[key] : null;
      centres[t] = v;
      if (v != null) { have++; if (v < min) min = v; if (v > max) max = v; }
    }
    if (have < 4) return { lines: [], min: 0, max: 0, have };
    const grid = buildGrid(centres, N, S);
    const levels = levelsFor(min, max, step);
    const lines = [];
    for (const lv of levels) {
      const segs = marchLevel(grid, lv);
      if (!segs.length) continue;
      lines.push({
        level: lv,
        major: Math.abs(lv % majorStep) < 1e-6,
        unit: opts.unit || '',
        segs,
      });
    }
    return { lines, min, max, have };
  }

  const C = { computeContours, marchLevel, buildGrid, sampleField, levelsFor };
  g.WW_CONTOURS = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);
