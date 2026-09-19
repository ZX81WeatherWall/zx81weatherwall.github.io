// contour-plot.js — per-machine CONTOUR CURVE engine (the ZX81 does the geometry).
//
// Each ZX81 is shipped the four scalar field values at ITS OWN tile corners (NW, NE,
// SE, SW). Corners are SHARED with the neighbouring machines (tile A's east corners are
// tile B's west corners), so the curves the machines draw MEET exactly at the seams —
// one continuous contour map across the 10x10 wall, with no machine knowing the whole.
//
// Given its 4 corners, a machine:
//   1. bilinearly interpolates the field across its 64x48 sub-pixel canvas (the ZX81's
//      native PLOT resolution: every char cell is a 2x2 block-graphic quadrant),
//   2. runs MARCHING SQUARES on a fine sub-grid for each contour level that passes
//      through the tile, producing short line segments that approximate the curve,
//   3. plots those segments at sub-pixel resolution by OR-ing block-graphic quadrants.
//
// This is the JS reference. tools/listener.js (the real Z80) mirrors it byte-for-byte;
// src/texture.js calls it so the proof/poster and the browser agree. Pure integer math
// (no divide beyond a small fixed-point step) so the Z80 port stays faithful.
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;

  const SUBW = 2 * L.TILE_W, SUBH = 2 * L.TILE_H;   // 64 x 48 sub-pixels (PLOT grid)
  // Marching-squares sub-grid: MG x MG cells across the tile. MG=1 (one cell = the four
  // corners) is the Z80 target: continuous curves seam-to-seam with NO multiply on the
  // machine — only an edge-crossing divide + a Bresenham line. Higher MG is smoother but
  // needs bilinear (multiply) on the Z80; the visual gain is marginal (see contour-mg4).
  const MG = 1;

  // Quadrant bit per sub-pixel within a char cell: TL=1, TR=2, BL=4, BR=8. The 16 combos
  // map to ZX81 block-graphic char codes (0..7 solid quadrants, 8..15 via inverse). This
  // is the standard ZX81 PLOT encoding — the same table the ROM's PLOT uses.
  const QUAD2CH = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,   // 0..7: no BR
    0x87, 0x86, 0x85, 0x84, 0x83, 0x82, 0x81, 0x80,   // 8..15: with BR (inverse of the complement)
  ];

  // Plot one sub-pixel (sx,sy) in a 0..63 x 0..47 grid into the per-cell quad-mask array.
  function plotSub(quad, sx, sy) {
    if (sx < 0 || sy < 0 || sx >= SUBW || sy >= SUBH) return;
    const cx = sx >> 1, cy = sy >> 1;
    const bit = 1 << (((sy & 1) << 1) | (sx & 1));   // TL/TR/BL/BR
    quad[cy * L.TILE_W + cx] |= bit;
  }

  // Bresenham line across the sub-pixel grid.
  function plotLine(quad, x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      plotSub(quad, x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // Bilinear field value at fractional tile coords (u,v in 0..1) from the 4 corners.
  // Scaled x256 fixed point so the Z80 mirror uses integer math only.
  function bilin(nw, ne, se, sw, u256, v256) {
    // top = nw + (ne-nw)*u ; bot = sw + (se-sw)*u ; val = top + (bot-top)*v
    const top = (nw << 8) + (ne - nw) * u256;
    const bot = (sw << 8) + (se - sw) * u256;
    return (top + (((bot - top) * v256) >> 8)) >> 8;   // back to field units
  }

  // Interpolate the sub-pixel crossing along an edge between grid values a,b for `level`.
  // Returns fixed fraction 0..256 (a==b guarded by caller).
  function frac256(a, b, level) {
    return (((level - a) << 8) / (b - a)) | 0;
  }

  // contourQuads(corners, levels) -> Uint8Array(TILE_W*TILE_H) of per-cell quad masks
  // (0..15). corners = {nw,ne,se,sw}. levels = ascending array of contour values.
  function contourQuads(corners, levels, mg) {
    mg = mg || MG;                                  // sub-grid resolution (power of 2 for the Z80)
    const { nw, ne, se, sw } = corners;
    const quad = new Uint8Array(L.TILE_W * L.TILE_H);
    // Sample the field on the (mg+1)x(mg+1) lattice once (bilinear from corners).
    const gvals = new Array((mg + 1) * (mg + 1));
    for (let gy = 0; gy <= mg; gy++)
      for (let gx = 0; gx <= mg; gx++) {
        const u = (gx * 256 / mg) | 0, v = (gy * 256 / mg) | 0;
        gvals[gy * (mg + 1) + gx] = bilin(nw, ne, se, sw, u, v);
      }
    const sxOf = (gx, fx) => (((gx * 256 + fx) * (SUBW - 1)) / (mg * 256)) | 0;
    const syOf = (gy, fy) => (((gy * 256 + fy) * (SUBH - 1)) / (mg * 256)) | 0;
    for (const lv of levels) {
      for (let gy = 0; gy < mg; gy++)
        for (let gx = 0; gx < mg; gx++) {
          const tl = gvals[gy * (mg + 1) + gx];
          const tr = gvals[gy * (mg + 1) + gx + 1];
          const br = gvals[(gy + 1) * (mg + 1) + gx + 1];
          const bl = gvals[(gy + 1) * (mg + 1) + gx];
          // marching-squares case index
          let ci = 0;
          if (tl >= lv) ci |= 8;
          if (tr >= lv) ci |= 4;
          if (br >= lv) ci |= 2;
          if (bl >= lv) ci |= 1;
          if (ci === 0 || ci === 15) continue;   // no crossing
          // edge crossing points (sub-pixel), interpolated
          const top = () => [sxOf(gx, tl !== tr ? frac256(tl, tr, lv) : 128), syOf(gy, 0)];
          const bottom = () => [sxOf(gx, bl !== br ? frac256(bl, br, lv) : 128), syOf(gy + 1, 0)];
          const left = () => [sxOf(gx, 0), syOf(gy, tl !== bl ? frac256(tl, bl, lv) : 128)];
          const right = () => [sxOf(gx + 1, 0), syOf(gy, tr !== br ? frac256(tr, br, lv) : 128)];
          // connect per case (standard MS; saddles 5/10 draw both diagonals)
          const seg = [];
          switch (ci) {
            case 1: case 14: seg.push([left(), bottom()]); break;
            case 2: case 13: seg.push([bottom(), right()]); break;
            case 3: case 12: seg.push([left(), right()]); break;
            case 4: case 11: seg.push([top(), right()]); break;
            case 6: case 9:  seg.push([top(), bottom()]); break;
            case 7: case 8:  seg.push([left(), top()]); break;
            case 5:  seg.push([left(), top()], [bottom(), right()]); break;
            case 10: seg.push([left(), bottom()], [top(), right()]); break;
          }
          for (const s of seg) plotLine(quad, s[0][0], s[0][1], s[1][0], s[1][1]);
        }
    }
    return quad;
  }

  // Merge the per-cell quad masks into display char codes, OR-ing over an existing base
  // cell array (only where a curve was plotted). base cells stay untouched where quad==0.
  function stampContour(cells, quad, major) {
    for (let i = 0; i < quad.length; i++) {
      const q = quad[i];
      if (!q) continue;
      cells[i] = QUAD2CH[q & 0x0f];
    }
    return cells;
  }

  // ---- MG=1 CANONICAL path (the exact integer spec the Z80 mirrors) --------------
  // One marching-squares cell per tile = the four corners. Each edge crossing is a single
  // unsigned divide: pos = |lv-A|*SPAN / |B-A|  (SPAN=63 across x, 47 across y). Sign
  // cancels because lv lies between A and B. No multiply-then-shift, no bilinear — the
  // whole tile from four bytes. Continuity is exact: an edge crossing depends only on the
  // two SHARED corners, so the neighbour computes the identical point.
  const SPX = SUBW - 1, SPY = SUBH - 1;   // 63, 47
  function cross(a, b, lv, span) {
    const u = a < b ? (lv - a) : (a - lv);
    const d = a < b ? (b - a) : (a - b);
    if (d === 0) return span >> 1;
    let q = ((u * span) / d) | 0;
    if (q < 0) q = 0; else if (q > span) q = span;
    return q;
  }
  // contourSimple(corners, levels) -> Uint8Array(TILE_W*TILE_H) quad masks (MG=1).
  function contourSimple(corners, levels) {
    const nw = corners.nw | 0, ne = corners.ne | 0, se = corners.se | 0, sw = corners.sw | 0;
    const quad = new Uint8Array(L.TILE_W * L.TILE_H);
    for (const lv of levels) {
      let ci = 0;
      if (nw >= lv) ci |= 8;
      if (ne >= lv) ci |= 4;
      if (se >= lv) ci |= 2;
      if (sw >= lv) ci |= 1;
      if (ci === 0 || ci === 15) continue;
      const top = () => [cross(nw, ne, lv, SPX), 0];
      const bottom = () => [cross(sw, se, lv, SPX), SPY];
      const left = () => [0, cross(nw, sw, lv, SPY)];
      const right = () => [SPX, cross(ne, se, lv, SPY)];
      const seg = [];
      switch (ci) {
        case 1: case 14: seg.push([left(), bottom()]); break;
        case 2: case 13: seg.push([bottom(), right()]); break;
        case 3: case 12: seg.push([left(), right()]); break;
        case 4: case 11: seg.push([top(), right()]); break;
        case 6: case 9:  seg.push([top(), bottom()]); break;
        case 7: case 8:  seg.push([left(), top()]); break;
        case 5:  seg.push([left(), top()], [bottom(), right()]); break;
        case 10: seg.push([left(), bottom()], [top(), right()]); break;
      }
      for (const s of seg) plotLine(quad, s[0][0], s[0][1], s[1][0], s[1][1]);
    }
    return quad;
  }

  // ---- MG=4 CANONICAL path (the exact integer spec the Z80 `ct_run4` mirrors) --------
  // Smooth machine-drawn curves. The tile is sampled on a 5x5 lattice with an INTEGER
  // bilinear whose four weights sum to 16 (MG=4), so every sample is a byte*small-int
  // multiply + a >>4 — NO 24-bit intermediates (unlike contourQuads' <<8 fixed point).
  // Marching squares then runs on the 4x4 sub-grid. This is a SEPARATE oracle from
  // contourQuads: the Z80 is proven byte-exact against THIS, not against contourQuads.
  const MG4 = 4;
  // bilinear sample at lattice node (gx,gy in 0..4). weights (4-gx)(4-gy)+... sum to 16.
  function bilinMG(nw, ne, se, sw, gx, gy) {
    const a = 4 - gx, b = gx, c = 4 - gy, d = gy;
    return (nw * a * c + ne * b * c + sw * a * d + se * b * d) >> 4;
  }
  // edge fraction 0..256 (magnitude form — sign cancels because lv lies between a,b;
  // this mirrors the Z80 `frac_edge`, which reuses the same signed-safe divide as `cross`).
  // a==b (d==0) returns 128, so callers need no separate tl!==tr guard.
  function fracMG(a, b, lv) {
    const u = a < b ? (lv - a) : (a - lv);
    const dd = a < b ? (b - a) : (a - b);
    if (dd === 0) return 128;
    let q = ((u << 8) / dd) | 0;
    if (q < 0) q = 0; else if (q > 256) q = 256;
    return q;
  }
  // sub-pixel mapping: node index gx (0..4) + fraction fx (0..256) -> 0..63 (x) / 0..47 (y).
  // MG*256 = 1024 = 2^10, so the divide is a >>10. 63/47 = SUBW-1/SUBH-1.
  const sxOfMG = (gx, fx) => (((gx * 256 + fx) * SPX) >> 10);
  const syOfMG = (gy, fy) => (((gy * 256 + fy) * SPY) >> 10);
  // contourFromGrid(gv, levels) -> Uint8Array quad masks (MG=4). Runs marching squares over
  // a 5x5 node grid `gv` (row-major, gv[gy*5+gx], values 0..255) — the shared geometry of
  // contourMG. This is the byte-exact spec the Z80 `ct_run4f` (real-data path) mirrors: the
  // machine is shipped a REAL 5x5 field per tile (denser continental data) and runs THIS,
  // skipping the corner bilinear. contourMG = build gv from corners, then call this.
  function contourFromGrid(gv, levels) {
    const quad = new Uint8Array(L.TILE_W * L.TILE_H);
    for (const lv of levels) {
      for (let gy = 0; gy < MG4; gy++)
        for (let gx = 0; gx < MG4; gx++) {
          const tl = gv[gy * 5 + gx], tr = gv[gy * 5 + gx + 1];
          const br = gv[(gy + 1) * 5 + gx + 1], bl = gv[(gy + 1) * 5 + gx];
          let ci = 0;
          if (tl >= lv) ci |= 8;
          if (tr >= lv) ci |= 4;
          if (br >= lv) ci |= 2;
          if (bl >= lv) ci |= 1;
          if (ci === 0 || ci === 15) continue;
          // crossings (fracMG returns 128 when the two grid values are equal)
          const topX = sxOfMG(gx, fracMG(tl, tr, lv));
          const botX = sxOfMG(gx, fracMG(bl, br, lv));
          const lefY = syOfMG(gy, fracMG(tl, bl, lv));
          const rgtY = syOfMG(gy, fracMG(tr, br, lv));
          // cell-corner sub-pixel coords (axis-aligned edges)
          const cyT = syOfMG(gy, 0), cyB = syOfMG(gy + 1, 0);
          const cxL = sxOfMG(gx, 0), cxR = sxOfMG(gx + 1, 0);
          const top = [topX, cyT], bottom = [botX, cyB], left = [cxL, lefY], right = [cxR, rgtY];
          const seg = [];
          switch (ci) {
            case 1: case 14: seg.push([left, bottom]); break;
            case 2: case 13: seg.push([bottom, right]); break;
            case 3: case 12: seg.push([left, right]); break;
            case 4: case 11: seg.push([top, right]); break;
            case 6: case 9:  seg.push([top, bottom]); break;
            case 7: case 8:  seg.push([left, top]); break;
            case 5:  seg.push([left, top], [bottom, right]); break;
            case 10: seg.push([left, bottom], [top, right]); break;
          }
          for (const s of seg) plotLine(quad, s[0][0], s[0][1], s[1][0], s[1][1]);
        }
    }
    return quad;
  }

  // contourMG(corners, levels) -> Uint8Array quad masks (MG=4). Same output contract as
  // contourSimple; builds the 5x5 grid from 4 corners (bilinear) then runs contourFromGrid.
  function contourMG(corners, levels) {
    const nw = corners.nw | 0, ne = corners.ne | 0, se = corners.se | 0, sw = corners.sw | 0;
    const gv = new Array(25);
    for (let gy = 0; gy <= MG4; gy++)
      for (let gx = 0; gx <= MG4; gx++)
        gv[gy * 5 + gx] = bilinMG(nw, ne, se, sw, gx, gy);
    return contourFromGrid(gv, levels);
  }

  const API = { SUBW, SUBH, MG, MG4, SPX, SPY, QUAD2CH, plotSub, plotLine, bilin, frac256, cross, bilinMG, fracMG, sxOfMG, syOfMG, contourQuads, contourSimple, contourMG, contourFromGrid, stampContour };
  g.WW_CONTOURPLOT = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
