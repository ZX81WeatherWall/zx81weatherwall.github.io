// contour-labels.js — host-side placement engine for on-contour value labels
// (docs/TEMP-LABEL-PLAN.md Phase 1). Given a tile's REAL 5x5 field grid and a level
// table, pick <=max anchor cells that LIE ON a level's marching-squares curve and
// have room for the big-digit plate, so the printed reading sits along the isoline
// and quotes the contour's own level value. FIELD-NEUTRAL by design: the engine
// knows grids, levels and rectangles — never pages, units or occupants. Everything
// page-specific is injected (charsOf = plate width of a level byte; reserved =
// rectangles other occupants own). TEMP today; PRESSURE reuses it untouched.
//
// The per-level curve geometry is CP.contourFromGrid run one level at a time — the
// byte-exact spec the Z80 ct_run4f mirrors — so "on the curve" here means on the
// exact cells the machine will ink. Pure + deterministic (no RNG, no Date): same
// grid -> same labels, provable by replay. Node + browser.
(function (g) {
  'use strict';
  const L = g.WW_LAYOUT || (typeof require !== 'undefined' ? require('./layout') : null);
  const CP = g.WW_CONTOURPLOT || (typeof require !== 'undefined' ? require('./contour-plot') : null);
  const W = L.TILE_W, H = L.TILE_H;

  // Plate rectangle (inclusive) of a big-digit reading anchored at centre col cx /
  // digit row cyd — the SAME geometry texture.stampTempNumber and the Z80 st_core
  // use: digits occupy rows cyd..cyd+2, the black plate pads one cell all round
  // (rows cyd-1..cyd+3, cols x0-1..x0+2*nch with x0 = cx-nch).
  function plateBox(cx, cyd, nch) {
    const x0 = cx - nch;
    return { x0: x0 - 1, x1: x0 + nch * 2, y0: cyd - 1, y1: cyd + 3 };
  }
  // Plate fully inside the tile with a 1-cell margin (labels never kiss a seam).
  function plateFits(b) { return b.x0 >= 1 && b.x1 <= W - 2 && b.y0 >= 1 && b.y1 <= H - 2; }
  function overlap(a, b, gap) {
    return !(a.x1 + gap < b.x0 || b.x1 + gap < a.x0 || a.y1 + gap < b.y0 || b.y1 + gap < a.y0);
  }

  // Bilinear sample of the 5x5 grid at fractional node coords (fx, fy in 0..4).
  // Every tab's honest centre readout is this sample at the tile-centre coords
  // (2,2 — where it degenerates to the exact middle node, gv[12]).
  function fieldSampleAt(gv, fx, fy) {
    const gx = Math.min(3, Math.max(0, Math.floor(fx))), gy = Math.min(3, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - gx)), ty = Math.min(1, Math.max(0, fy - gy));
    const tl = gv[gy * 5 + gx], tr = gv[gy * 5 + gx + 1];
    const bl = gv[(gy + 1) * 5 + gx], br = gv[(gy + 1) * 5 + gx + 1];
    return (tl * (1 - tx) + tr * tx) * (1 - ty) + (bl * (1 - tx) + br * tx) * ty;
  }

  // placeLabels(gv, levels, opts) -> [{x, y, byte}] with x = plate centre col,
  // y = DIGIT row (what the wire ships and st_core consumes), byte = the level value
  // verbatim (the page's own encoding; the engine never decodes it).
  // opts:
  //   charsOf(byte) -> plate width in chars (page formatting, injected) [required]
  //   row, col      -> tile coords, for the deterministic seam stagger [required]
  //   reserved      -> rectangles {x0,x1,y0,y1} the labels must not touch (default [])
  //   max           -> label cap per tile (default 2)
  //   minCells      -> minimum curve cells for a level to earn a label (default 8)
  //   stagger       -> neighbour de-crowding on/off (default true)
  function placeLabels(gv, levels, opts) {
    const charsOf = opts.charsOf, reserved = opts.reserved || [];
    const max = opts.max == null ? 2 : opts.max;
    const minCells = opts.minCells == null ? 8 : opts.minCells;
    const stagger = opts.stagger == null ? true : !!opts.stagger;

    // per-level curve cell lists, longest first (the visually dominant lines win)
    const present = [];
    for (let li = 0; li < levels.length; li++) {
      const mask = CP.contourFromGrid(gv, [levels[li]]);
      const cells = [];
      for (let i = 0; i < mask.length; i++) if (mask[i]) cells.push(i);
      if (cells.length >= minCells) present.push({ lv: levels[li], li, cells });
    }
    present.sort((a, b) => b.cells.length - a.cells.length || a.li - b.li);

    const placed = [];
    // Anchor search: walk outward from the level's median curve cell (row-major
    // order), so the plate lands mid-run, and take the first spot where it fits
    // clear of the tile margin, the reserved rects and already-placed plates.
    function tryPlace(ent) {
      const nch = charsOf(ent.lv);
      const n = ent.cells.length, mid = n >> 1;
      for (let d = 0; d < 2 * n; d++) {
        const k = mid + ((d & 1) ? -((d + 1) >> 1) : (d >> 1));
        if (k < 0 || k >= n) continue;
        const i = ent.cells[k], x = i % W, y = (i / W) | 0;
        const box = plateBox(x, y - 1, nch);       // digit row y-1 centres the plate on the curve cell
        if (!plateFits(box)) continue;
        let clash = false;
        for (const r of reserved) if (overlap(box, r, 1)) { clash = true; break; }
        if (!clash) for (const p of placed) if (overlap(box, p.box, 2)) { clash = true; break; }
        if (clash) continue;
        placed.push({ x, y: y - 1, byte: ent.lv, box });
        return true;
      }
      return false;
    }

    for (const ent of present) {
      if (placed.length >= max) break;
      // Seam stagger: neighbouring tiles crossed by the same level alternate who
      // labels it ((row+col) parity flips between neighbours), so a long isoline
      // is not captioned in every tile it touches.
      if (stagger && (((opts.row + opts.col + ent.li) & 1) !== 0)) continue;
      tryPlace(ent);
    }
    // Fallback: a tile whose every level was staggered out still labels its
    // dominant line — no contour-crossed tile goes mute just from parity.
    if (!placed.length && present.length) tryPlace(present[0]);
    return placed.map(p => ({ x: p.x, y: p.y, byte: p.byte }));
  }

  const API = { plateBox, plateFits, overlap, fieldSampleAt, placeLabels };
  g.WW_CONTOURLABELS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
