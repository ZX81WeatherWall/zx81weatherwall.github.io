// pressure-centres.js — synoptic H/L centres found on the DENSE pressure lattice, with a
// CLOSED-ISOBAR test.
//
// WHY THIS EXISTS. gateway.findPressureCentres scans the coarse 10x10 tile-CENTRE grid. On a
// smooth synoptic field a strict 8-neighbour extremum almost never fires at 36deg x 18deg
// spacing, so that pass falls through to its basin-scale fallback and marks exactly ONE low
// and ONE high for the whole globe (owner QC 2026-07-24). Worse, once the isobars started
// marching the dense 5x5 field (2500 nodes) the markers no longer agreed with the lines: the
// global minimum of 100 tile centres is not the minimum of the dense field, so the L sat
// outside the innermost closed isobar. Same class of mismatch as the pre-2026-07-24 temp
// labels, which quoted the tile centre while the contours came from the field.
//
// WHAT A CENTRE IS. Meteorologically an H or L belongs inside the innermost CLOSED isobar of
// its own basin, and that is exactly the test used here rather than a depth threshold:
//
//   1. Strict local extremum on the shared lattice (8 neighbours, longitude WRAPS, the pole
//      rows are real domain edges).
//   2. Let `lvl` be the innermost DRAWN isobar that would enclose it — the nearest 4 hPa
//      level beyond the extremum's value, clamped to the drawn band (a 968 hPa low is below
//      the table floor, so the innermost line actually on screen is the floor itself).
//   3. Flood-fill the connected component containing the extremum over nodes on the closed
//      side of `lvl`. If that component NEVER reaches a pole row, it is enclosed by a closed
//      isobar and earns a marker. If it escapes to the domain edge, the "loop" is open and
//      no marker is drawn — this is what keeps a monotone pole-to-pole gradient unmarked.
//   4. ONE marker per component (the deepest/highest node wins), so a broad basin with two
//      noisy dimples gets one L, not two.
//
// Longitude wrapping makes step 3 correct where a naive scan fails: a basin straddling the
// dateline is one component, not two.
//
// PURE: no fetch, no clock, no DOM. Input is a node accessor over the lattice, output is a
// plain list. Consumed by the live wall (web/app.js, PRESSURE page) and by the proofs.
'use strict';
(function (root, factory) {
  const API = factory(
    typeof require === 'function' ? require('./layout') : root.WW_LAYOUT,
    typeof require === 'function' ? require('./continental-grid') : root.WW_CONTINENTAL
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.WW_PRESSCENTRES = API;
}(typeof self !== 'undefined' ? self : this, function (L, CG) {

  const MG = CG.MG;                       // 4 sub-tile steps per tile
  const NT = CG.N;                        // 10 tiles per side
  const GW_ = NT * MG;                    // 40 DISTINCT lattice columns (gi 40 wraps to 0)
  const GH_ = NT * MG + 1;                // 41 lattice rows (both pole rows included)
  const INTERVAL = 4;                     // hPa between drawn isobars (PRESS_ISO_LEVELS step)
  // The drawn band, in hPa, derived from the byte table so this can never drift from what
  // the machine actually plots (bytes are hPa - PRESS_ISO_DATUM).
  const LVL_MIN = L.PRESS_ISO_LEVELS[0] + L.PRESS_ISO_DATUM;                       // 980
  const LVL_MAX = L.PRESS_ISO_LEVELS[L.PRESS_ISO_LEVELS.length - 1] + L.PRESS_ISO_DATUM; // 1024

  const wrapGi = (gi) => ((gi % GW_) + GW_) % GW_;
  // Lattice node -> tile index, and the node's position INSIDE that tile (0..MG each way).
  function nodeTile(gi, gj) {
    const g = wrapGi(gi);
    const col = Math.min(NT - 1, (g / MG) | 0);
    const row = Math.min(NT - 1, (gj / MG) | 0);
    return { tile: row * NT + col, gx: g - col * MG, gy: gj - row * MG };
  }

  // The innermost DRAWN isobar enclosing a low of `p` hPa: the nearest 4 hPa level ABOVE p,
  // clamped into the drawn band. `sign` = -1 for a low, +1 for a high (level BELOW p).
  function innerLevel(p, sign) {
    let lvl = sign < 0 ? (Math.floor(p / INTERVAL) + 1) * INTERVAL
                       : (Math.ceil(p / INTERVAL) - 1) * INTERVAL;
    if (lvl < LVL_MIN) lvl = LVL_MIN;
    if (lvl > LVL_MAX) lvl = LVL_MAX;
    return lvl;
  }

  // findCentres(nodeAt, opts) -> [{tile, gi, gj, gx, gy, kind, hpa, level, size}]
  //   nodeAt(gi, gj) -> hPa or null/undefined for no reading.
  //   kind: 'L' | 'H'.  size: nodes in the enclosed component (a crude basin extent).
  //   opts.cap        max markers per kind (default 16; the deepest/highest win)
  //   opts.minSize    smallest enclosed component that earns a marker (default 2 nodes).
  //                   A size-1 component means the closed isobar fits inside a single
  //                   lattice cell — at ~9deg node spacing that is an interpolation dimple,
  //                   not a resolvable synoptic centre, and marking it litters the wall.
  //   opts.skipTile   (tile) => true to refuse a tile (cyclone tiles carry their own marker)
  function findCentres(nodeAt, opts) {
    const o = opts || {};
    const cap = o.cap == null ? 16 : o.cap | 0;
    const minSize = o.minSize == null ? 2 : o.minSize | 0;
    const skipTile = o.skipTile || (() => false);

    // Snapshot the lattice once: nodeAt may be a closure over per-tile grids, and the
    // flood-fill revisits nodes many times.
    const val = new Float64Array(GW_ * GH_).fill(NaN);
    const at = (gi, gj) => val[gj * GW_ + wrapGi(gi)];
    for (let gj = 0; gj < GH_; gj++)
      for (let gi = 0; gi < GW_; gi++) {
        const v = nodeAt(gi, gj);
        if (v != null && isFinite(v)) val[gj * GW_ + gi] = v;
      }

    // ---- step 1: strict local extrema (8-neighbour, lon wraps, poles are edges)
    const cand = [];
    for (let gj = 0; gj < GH_; gj++)
      for (let gi = 0; gi < GW_; gi++) {
        const p = at(gi, gj);
        if (!isFinite(p)) continue;
        let isMin = true, isMax = true, nbrs = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const gjj = gj + dj;
            if (gjj < 0 || gjj >= GH_) continue;             // pole clamp
            const np = at(gi + di, gjj);
            if (!isFinite(np)) continue;
            nbrs++;
            if (!(p < np)) isMin = false;
            if (!(p > np)) isMax = false;
          }
        if (!nbrs) continue;
        if (isMin) cand.push({ gi, gj, hpa: p, sign: -1 });
        else if (isMax) cand.push({ gi, gj, hpa: p, sign: 1 });
      }

    // ---- steps 2-4: closed-isobar test, one marker per component
    // Deepest lows / highest highs first, so the extremum that claims a component is the
    // most significant one in it.
    cand.sort((a, b) => (a.sign - b.sign) || (a.sign < 0 ? a.hpa - b.hpa : b.hpa - a.hpa));
    const claimed = new Uint8Array(GW_ * GH_);
    const out = [];
    for (const c of cand) {
      if (claimed[c.gj * GW_ + wrapGi(c.gi)]) continue;      // already inside a marked basin
      const lvl = innerLevel(c.hpa, c.sign);
      // A low must actually be below the innermost line it is supposed to sit inside (and a
      // high above it), else there is no closed isobar to be inside of.
      if (c.sign < 0 ? !(c.hpa < lvl) : !(c.hpa > lvl)) continue;
      const inside = c.sign < 0 ? (v) => v < lvl : (v) => v > lvl;

      const stack = [[c.gi, c.gj]];
      const seen = new Set([c.gj * GW_ + wrapGi(c.gi)]);
      const region = [];
      const cols = new Set();
      let open = false;
      while (stack.length && !open) {
        const [gi, gj] = stack.pop();
        region.push(gj * GW_ + wrapGi(gi));
        cols.add(wrapGi(gi));
        // Reaching a pole row means the "loop" runs off the map — an open trough/ridge.
        if (gj === 0 || gj === GH_ - 1) { open = true; break; }
        // Spanning every longitude means the region ENCIRCLES the globe: topologically an
        // annulus (a zonal belt like the subtropical ridge), not a closed loop with an
        // inside. Without this test a hemisphere-wide pressure belt earns a spurious marker
        // simply because it never reaches a pole.
        if (cols.size >= GW_) { open = true; break; }
        for (let dj = -1; dj <= 1 && !open; dj++)
          for (let di = -1; di <= 1 && !open; di++) {
            if (!di && !dj) continue;
            const gjj = gj + dj;
            if (gjj < 0 || gjj >= GH_) continue;
            const gii = wrapGi(gi + di), k = gjj * GW_ + gii;
            if (seen.has(k)) continue;
            const v = val[k];
            // A MISSING node is a hole in the data, not a wall. Treating it as a wall would
            // let a component be "enclosed" by the edge of coverage rather than by an
            // isobar — which is how a deep low at the edge of the dense field earned a
            // marker whose closed loop did not exist (caught by the independent ray check
            // in proof-pressure-centres-dense leg C, against a 76-tile snapshot).
            if (!isFinite(v)) { open = true; break; }
            if (!inside(v)) continue;                        // outside the closed isobar
            seen.add(k);
            stack.push([gii, gjj]);
          }
      }
      if (open) continue;                                   // not enclosed -> no marker
      for (const k of region) claimed[k] = 1;               // one marker per basin
      if (region.length < minSize) continue;                // sub-resolution dimple
      const nt = nodeTile(c.gi, c.gj);
      if (skipTile(nt.tile)) continue;
      out.push({ tile: nt.tile, gi: wrapGi(c.gi), gj: c.gj, gx: nt.gx, gy: nt.gy,
        kind: c.sign < 0 ? 'L' : 'H', hpa: c.hpa, level: lvl, size: region.length });
    }

    // ---- cap per kind, most significant first; one marker per TILE (the glyph is
    // tile-granular, so a second centre in the same tile has nowhere to draw).
    const pick = (kind) => {
      const list = out.filter((e) => e.kind === kind)
        .sort((a, b) => (kind === 'L' ? a.hpa - b.hpa : b.hpa - a.hpa));
      const byTile = new Map();
      for (const e of list) if (!byTile.has(e.tile)) byTile.set(e.tile, e);
      return Array.from(byTile.values()).slice(0, cap);
    };
    const lows = pick('L'), highs = pick('H');
    // A tile cannot be both; the deeper anomaly (distance from the drawn band centre) wins.
    const taken = new Set(lows.map((e) => e.tile));
    return lows.concat(highs.filter((e) => !taken.has(e.tile)));
  }

  // Sub-tile glyph anchor for a centre: the node's position inside its tile, in display
  // cells, clamped so the CENTRE_W x CENTRE_H block stays wholly inside the tile. Returns
  // the TOP-LEFT anchor the renderer should use (the fixed tile-centre anchor is what
  // web/worker.js applyCentres used before sub-tile placement).
  function glyphAnchor(gx, gy, glyphW, glyphH) {
    const gw = glyphW || 5, gh = glyphH || 7;
    let x = Math.round((gx / MG) * L.TILE_W) - (gw >> 1);
    let y = Math.round((gy / MG) * L.TILE_H) - (gh >> 1);
    if (x < 0) x = 0; if (x > L.TILE_W - gw) x = L.TILE_W - gw;
    if (y < 0) y = 0; if (y > L.TILE_H - gh) y = L.TILE_H - gh;
    return { x, y };
  }

  // Sub-node anchor refinement (owner 2026-07-30 QC: loop H/L "don't seem to move
  // dynamically with the isobars"). A bilinear lattice puts its extrema exactly ON
  // data nodes, so glyph anchors quantise to node positions and the loop letters jump
  // tile-to-tile instead of drifting. Fit a 1-D parabola through the extremum node and
  // its two lattice neighbours on each axis (standard sub-sample peak interpolation —
  // real neighbour data, nothing fabricated) and return FRACTIONAL within-tile node
  // coords for glyphAnchor. Vertex offset clamped to +/- half a node step.
  function refineAnchor(nodeAt, c) {
    const off = (vm, v0, vp) => {
      if (vm == null || vp == null || !isFinite(vm) || !isFinite(vp)) return 0;
      const den = vm - 2 * v0 + vp;
      if (Math.abs(den) < 1e-9) return 0;
      let o = 0.5 * (vm - vp) / den;
      if (o > 0.5) o = 0.5; else if (o < -0.5) o = -0.5;
      return o;
    };
    const v0 = nodeAt(c.gi, c.gj);
    if (v0 == null || !isFinite(v0)) return { gx: c.gx, gy: c.gy };
    const oi = off(nodeAt(c.gi - 1, c.gj), v0, nodeAt(c.gi + 1, c.gj));
    const oj = (c.gj > 0 && c.gj < GH_ - 1)
      ? off(nodeAt(c.gi, c.gj - 1), v0, nodeAt(c.gi, c.gj + 1)) : 0;
    return { gx: c.gx + oi, gy: c.gy + oj };
  }

  // Build a nodeAt() over the snapshot's per-tile 25-node grids (continental-field.json
  // `fields.pressureHpa`): the SAME grids the isobars march, so markers and lines agree by
  // construction. Nodes shared between tiles resolve identically from either side.
  // `centresHpa` (optional): the 100 tile-CENTRE pressures. Nodes the dense grids do not
  // cover fall back to a bilinear interpolation of those centres — the SAME fallback the
  // snapshot writer uses for blue-water nodes. Without it a snapshot written before the raw
  // fields covered the whole wall (or an older history-dense archive frame) leaves holes,
  // and a hole now correctly BLOCKS a marker (see the flood fill), so markers would vanish
  // near the edge of coverage rather than degrade.
  function nodeAtFromTileGrids(tileGrids, centresHpa) {
    const idx = new Map();                                  // "gi,gj" -> hPa
    for (const t in tileGrids) {
      const g = tileGrids[t];
      if (!g || g.length !== 25) continue;
      CG.tileNodeIndices(Number(t)).forEach((n, i) => {
        const v = g[i];
        if (v != null && isFinite(v)) idx.set(wrapGi(n.gi) + ',' + n.gj, v);
      });
    }
    const centres = (centresHpa && centresHpa.length === NT * NT
      && centresHpa.every((v) => v != null && isFinite(v))) ? centresHpa : null;
    return (gi, gj) => {
      const v = idx.get(wrapGi(gi) + ',' + gj);
      if (v != null) return v;
      if (!centres) return null;
      const ll = CG.nodeLonLat(wrapGi(gi), gj);
      return CG.centreAt(centres, ll.lat, ll.lon);
    };
  }

  return { findCentres, glyphAnchor, refineAnchor, nodeAtFromTileGrids, innerLevel,
    GRID_W: GW_, GRID_H: GH_, INTERVAL, LVL_MIN, LVL_MAX, nodeTile };
}));
