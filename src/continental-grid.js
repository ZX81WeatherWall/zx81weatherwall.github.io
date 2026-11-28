// continental-grid.js — shared-lattice sample-point geometry for the DENSE continental
// desks. Each wall tile is a 36deg x 18deg equirectangular cell (10x10 = 100 tiles). A
// continental desk fetches a real 5x5 field per member tile (MG=4 -> 4x4 marching-squares
// cells) instead of the single centre value it interpolates today.
//
// The nodes sit on a GLOBAL lattice (9deg lon x 4.5deg lat), so a tile's east edge nodes
// are the SAME lattice points as its neighbour's west edge nodes. That gives two things for
// free: (1) seam continuity — neighbours read identical boundary values, so the machine
// curves meet exactly (the invariant proof-contour-field checks at the engine level); and
// (2) cheap fetch — shared edge nodes are queried ONCE, not per tile. The Z80 still gets its
// own 25-value grid per tile (shared nodes duplicated into its payload); only the FETCH is
// deduped. Pure geometry; no fetch, no ZX81. Node + browser.
(function (g) {
  'use strict';
  const N = 10;              // 10x10 wall tiles
  const TLON = 36, TLAT = 18;// per-tile degrees (equirectangular)
  const MG = 4;              // marching-squares cells per tile edge -> MG+1=5 nodes/edge
  const DLON = TLON / MG, DLAT = TLAT / MG;   // 9deg lon, 4.5deg lat between nodes

  function tileColRow(t) { return { col: t % N, row: (t / N) | 0 }; }
  // global integer lattice coords (gi east, gj south) -> lon/lat. row 0 / gj 0 = NORTH.
  function nodeLonLat(gi, gj) { return { lon: -180 + gi * DLON, lat: 90 - gj * DLAT }; }

  // The 25 global lattice nodes of a tile's 5x5 grid, row-major gv[gy*5+gx] with gy=0=NORTH,
  // gx=0=WEST — matching src/contour-plot.js (tl = NW). Shared edges land on shared (gi,gj).
  function tileNodeIndices(tile) {
    const { col, row } = tileColRow(tile);
    const idx = new Array(25);
    for (let gy = 0; gy <= MG; gy++)
      for (let gx = 0; gx <= MG; gx++)
        idx[gy * 5 + gx] = { gi: col * MG + gx, gj: row * MG + gy };
    return idx;
  }

  // Unique fetch points (lat/lon) covering a set of tiles, deduped on the shared lattice.
  // Pass ALL continental member tiles to get the true per-cycle fetch cost; the returned
  // list is what you hand Open-Meteo as batched coordinates.
  function fetchPoints(tiles) {
    const seen = new Set(), pts = [];
    for (const t of tiles) {
      const { col, row } = tileColRow(t);
      for (let gy = 0; gy <= MG; gy++)
        for (let gx = 0; gx <= MG; gx++) {
          const gi = col * MG + gx, gj = row * MG + gy, key = gi + ',' + gj;
          if (seen.has(key)) continue;
          seen.add(key);
          const ll = nodeLonLat(gi, gj);
          pts.push({ gi, gj, lat: ll.lat, lon: ll.lon });
        }
    }
    return pts;
  }

  // Build a tile's 25-value grid (row-major, for ct_run4f / contourFromGrid) from a fetched
  // field. `valueAt(gi,gj)` returns the byte value at a lattice node (your fetch result,
  // keyed by gi,gj). Shared nodes resolve to identical values across neighbours by construction.
  function tileGrid(tile, valueAt) {
    return tileNodeIndices(tile).map(n => valueAt(n.gi, n.gj) & 0xff);
  }

  // Bilinear interpolation of a 10x10 tile-CENTRE value field at absolute (lat,lon).
  // Tile centres sit at lon = -180+col*36+18, lat = 90-row*18-9. Shared by the refresh
  // tool's ocean-interior base fallback AND the browser's dense-loop delta field — one
  // implementation so both sides of the wire agree node-for-node (seam invariant).
  function centreAt(centres, lat, lon) {
    let fc = (lon - (-180 + 18)) / 36;         // fractional column in centre space
    let fr = ((90 - 9) - lat) / 18;            // fractional row in centre space
    if (fc < 0) fc = 0; else if (fc > N - 1) fc = N - 1;
    if (fr < 0) fr = 0; else if (fr > N - 1) fr = N - 1;
    const c0 = fc | 0, r0 = fr | 0, c1 = Math.min(N - 1, c0 + 1), r1 = Math.min(N - 1, r0 + 1);
    const dx = fc - c0, dy = fr - r0;
    const g = (rr, cc) => centres[rr * N + cc];
    const top = g(r0, c0) * (1 - dx) + g(r0, c1) * dx;
    const bot = g(r1, c0) * (1 - dx) + g(r1, c1) * dx;
    return top * (1 - dy) + bot * dy;
  }

  // ---- adaptive tiers (DENSITY-PLAN Option B; classification in src/sample-tiers.js) ----

  // Unique fetch points for a TIERED pull: dense tiles contribute all 25 nodes, ring
  // tiles only the EVEN 3x3 (gx,gy in {0,2,4}) — still on the shared global lattice, so
  // a ring tile's even nodes coincide with its dense neighbour's edge nodes and are
  // fetched ONCE. Returned flat, deduped, same shape fetchPoints returns.
  function fetchPointsTiered(denseTiles, ringTiles) {
    const seen = new Set(), pts = [];
    const add = (tiles, step) => {
      for (const t of tiles) {
        const { col, row } = tileColRow(t);
        for (let gy = 0; gy <= MG; gy += step)
          for (let gx = 0; gx <= MG; gx += step) {
            const gi = col * MG + gx, gj = row * MG + gy, key = gi + ',' + gj;
            if (seen.has(key)) continue;
            seen.add(key);
            const ll = nodeLonLat(gi, gj);
            pts.push({ gi, gj, lat: ll.lat, lon: ll.lon });
          }
      }
    };
    add(denseTiles, 1);
    add(ringTiles || [], 2);
    return pts;
  }

  // Fill a ring tile's ODD lattice nodes into `map` ("gi,gj" -> value) by interpolating
  // its fetched EVEN nodes, so downstream consumers (including the BLUE neighbour across
  // the seam) all read ONE shared value table and seams stay continuous:
  //   land-ring edge : all 5 nodes real (the land tile fetched them) — never overwritten
  //                    (a node already in the map is left alone);
  //   ring-ring edge : both sides derive the odd midpoints from the SAME two even
  //                    endpoints — identical by construction;
  //   ring-blue edge : the blue tile's grid builder reads THIS map first, so it sees the
  //                    ring's derived edge values, not its own centre-interpolated base.
  // A missing/null even input leaves the node ABSENT (falls through to the caller's base
  // fallback — both seam sides fall back identically, never fabricates a reading).
  // `round` defaults to Math.round (byte fields); pass x=>x for raw float fields.
  function densifyRing(map, ringTiles, round) {
    const rnd = round || Math.round;
    const at = (gi, gj) => { const v = map.get(gi + ',' + gj); return (v == null) ? null : v; };
    const put = (gi, gj, v) => { const k = gi + ',' + gj; if (v != null && map.get(k) == null) map.set(k, rnd(v)); };
    const mean = (a, b) => (a == null || b == null) ? null : (a + b) / 2;
    for (const t of ringTiles) {
      const { col, row } = tileColRow(t);
      const gi0 = col * MG, gj0 = row * MG;
      for (let gy = 0; gy <= MG; gy++)
        for (let gx = 0; gx <= MG; gx++) {
          const ox = gx & 1, oy = gy & 1;
          if (!ox && !oy) continue;                       // even-even: fetched
          const gi = gi0 + gx, gj = gj0 + gy;
          let v = null;
          if (ox && !oy) v = mean(at(gi - 1, gj), at(gi + 1, gj));        // between lon evens
          else if (!ox && oy) v = mean(at(gi, gj - 1), at(gi, gj + 1));   // between lat evens
          else v = mean(mean(at(gi - 1, gj - 1), at(gi + 1, gj - 1)),     // centre of 4 evens
                        mean(at(gi - 1, gj + 1), at(gi + 1, gj + 1)));
          put(gi, gj, v);
        }
    }
  }

  const API = { N, TLON, TLAT, MG, DLON, DLAT, tileColRow, nodeLonLat, tileNodeIndices, fetchPoints, tileGrid, centreAt, fetchPointsTiered, densifyRing };
  g.WW_CONTINENTAL = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
