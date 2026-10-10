// dense-loop.js — HYBRID dense tape-loop replay (owner 2026-07-24: the loop must match
// the still's density). The scheduler archives each live tiered field snapshot
// (data/history-dense/<hour>.json, tools/refresh-continental-field.js writeField); a
// loop frame then rebuilds each tile's 25-node grid as
//
//     grid = nearest archived DENSE snapshot  +  hourly CENTRE-delta field
//
// The snapshot carries the sub-tile STRUCTURE (real 5x5 lattice, ~6h cadence + chase/
// featured merges); the delta carries the hour-by-hour EVOLUTION (tempHist, the same
// archive the coarse loop already replays). The delta is evaluated per NODE from the
// bilinear tile-CENTRE field (CG.centreAt) — NOT per tile — so two neighbours add the
// IDENTICAL correction on their shared edge nodes and the seam invariant survives:
// snapshot grids are seam-shared by construction, and a continuous field plus a
// continuous correction is still continuous. Pure math; no fetch, no ZX81. Node + browser.
(function (g) {
  'use strict';
  const req = (typeof require === 'function') ? require : null;
  const CG = req ? req('./continental-grid') : g.WW_CONTINENTAL;

  // nearestHour(hours, targetMs) -> the archived hour key (ISO 'YYYY-MM-DDTHH')
  // closest to targetMs, or null when the archive is empty or the best match is
  // further than maxDistH hours (default 7 — beyond that the snapshot's structure is
  // staler than a plain corner frame is coarse; honest-degrade to corners).
  function nearestHour(hours, targetMs, maxDistH) {
    const cap = (maxDistH == null ? 7 : maxDistH) * 3600000;
    let best = null, bestD = Infinity;
    for (const h of hours || []) {
      const t = Date.parse(h + ':00:00Z');
      if (!isFinite(t)) continue;
      const d = Math.abs(t - targetMs);
      if (d < bestD) { bestD = d; best = h; }
    }
    return (best != null && bestD <= cap) ? best : null;
  }

  // hybridGrid(snapTiles, tile, deltaCentres) -> Uint8Array(25): the tile's archived
  // grid shifted node-by-node by the interpolated centre-delta field (byte-clamped).
  // deltaCentres = per-tile (frame-hour centre byte) - (snapshot-hour centre byte),
  // 0 where either reading is absent (an absent hour never fabricates a shift).
  function hybridGrid(snapTiles, tile, deltaCentres) {
    const base = snapTiles[tile];
    if (!base || base.length !== 25) return null;
    return Uint8Array.from(CG.tileNodeIndices(tile).map((n, i) => {
      const ll = CG.nodeLonLat(n.gi, n.gj);
      const v = (base[i] & 0xff) + Math.round(CG.centreAt(deltaCentres, ll.lat, ll.lon));
      return v < 0 ? 0 : v > 255 ? 255 : v;
    }));
  }

  // deltaCentres(frameCentres, snapCentres) -> per-tile byte deltas, null-safe.
  function deltaCentres(frameCentres, snapCentres) {
    const out = new Array(100);
    for (let t = 0; t < 100; t++) {
      const a = frameCentres[t], b = snapCentres[t];
      out[t] = (typeof a === 'number' && typeof b === 'number') ? a - b : 0;
    }
    return out;
  }

  const API = { nearestHour, hybridGrid, deltaCentres };
  g.WW_DENSELOOP = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
