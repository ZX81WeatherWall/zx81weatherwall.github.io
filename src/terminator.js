// terminator.js — the day/night terminator as a per-tile LINE overlay (owner
// 2026-07-31: "the old wall still includes a time-accurate terminator"). The
// machine termCell edge (7724877) drew per-tile boundary strips that read as
// grey L's tracing the tile grid off-SATELLITE (7afcb38 gated it away); this is
// the smooth replacement: solar geometry evaluated per GLOBAL cell (320x240), the
// night-side cells bordering day emitted as one clean stepped line. Poked over
// background cells only (worker applyTerm / stitch overlay — the applyLines /
// applyFront display-only idiom), so glyphs, coastline and marks read through.
// Shared browser + node (UMD) so the wall and the continental crops agree.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WW_TERMINATOR = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  var N = 10, TW = 32, TH = 24, GXN = N * TW, GYN = N * TH;
  var D = Math.PI / 180;

  // Same solar model as the retired app.js computeNightGeom: declination from
  // day-of-year, sub-solar longitude from UTC hour. Accurate to well under a
  // wall cell (~1 deg).
  function sunGeom(epochMs) {
    var d = new Date(epochMs);
    var start = Date.UTC(d.getUTCFullYear(), 0, 0);
    var doy = Math.floor((epochMs - start) / 86400e3);
    var decl = -23.44 * D * Math.cos((2 * Math.PI / 365) * (doy + 10));
    var utcH = d.getUTCHours() + d.getUTCMinutes() / 60;
    var subLon = -15 * (utcH - 12) * D;
    return { decl: decl, subLon: subLon };
  }

  function nightAt(gx, gy, g) {
    var lat = (90 - 180 * (gy + 0.5) / GYN) * D;
    var lon = (-180 + 360 * (gx + 0.5) / GXN) * D;
    var sinAlt = Math.sin(lat) * Math.sin(g.decl)
      + Math.cos(lat) * Math.cos(g.decl) * Math.cos(lon - g.subLon);
    return sinAlt < 0;
  }

  // compute(epochMs) -> { tileIdx: { cells: [cellIdx, ...] } } — the NIGHT-side
  // cells with at least one DAY 4-neighbour (lon wraps, lat clamps): a single
  // ~1-cell stepped line, the radiofax terminator.
  function compute(epochMs) {
    var g = sunGeom(epochMs);
    var night = new Uint8Array(GXN * GYN);
    for (var gy = 0; gy < GYN; gy++)
      for (var gx = 0; gx < GXN; gx++)
        night[gy * GXN + gx] = nightAt(gx, gy, g) ? 1 : 0;
    var out = {};
    for (gy = 0; gy < GYN; gy++)
      for (gx = 0; gx < GXN; gx++) {
        if (!night[gy * GXN + gx]) continue;
        var edge = !night[gy * GXN + (gx + 1) % GXN] || !night[gy * GXN + (gx + GXN - 1) % GXN]
          || (gy > 0 && !night[(gy - 1) * GXN + gx]) || (gy < GYN - 1 && !night[(gy + 1) * GXN + gx]);
        if (!edge) continue;
        var t = ((gy / TH) | 0) * N + ((gx / TW) | 0);
        if (!out[t]) out[t] = { cells: [] };
        out[t].cells.push((gy % TH) * TW + (gx % TW));
      }
    return out;
  }

  return { compute: compute };
});
