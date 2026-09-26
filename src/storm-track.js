// storm-track.js — the ONE canonical loop-track source (owner 2026-07-30: "We need smooth
// tracks, and these same tracks will need to apply to all tabs, so there is logical
// persistence of hurricanes and tracks from tab to tab... data-driven as far as
// possible"). Input is data/storm-tracks.json — real agency (NHC/JTWC) eye fixes
// distilled from the dense-history archive by tools/refresh-tracks.js — and this module
// interpolates a storm's position at any loop-frame epoch and maps it to wall
// coordinates. Every tab's loop asks HERE, so a hurricane sits in the same place on the
// PRESSURE chart, the WEATHER map and the SATELLITE view for the same hour.
//
// PURE + deterministic; node + browser (window.WW_STORMTRACK).
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const GL = (typeof require === 'function') ? require('./glyphs') : g.WW_GLYPHS;
  const N = 10;

  // Linear interpolation of the fix list at epochMs, clamped to the track's ends.
  // Returns {lat, lon, clamped} or null for an empty/invalid track. Longitude
  // interpolates wrap-aware (a dateline-crossing storm does not sweep the globe).
  function trackAt(points, epochMs) {
    if (!Array.isArray(points) || !points.length) return null;
    const ts = points.map((p) => +new Date(p.at));
    if (epochMs <= ts[0]) return { lat: points[0].lat, lon: points[0].lon, clamped: 'start' };
    const last = points.length - 1;
    if (epochMs >= ts[last]) return { lat: points[last].lat, lon: points[last].lon, clamped: 'end' };
    let i = 0;
    while (i < last && ts[i + 1] < epochMs) i++;
    const a = points[i], b = points[i + 1];
    const f = (epochMs - ts[i]) / Math.max(1, ts[i + 1] - ts[i]);
    let dLon = b.lon - a.lon;
    if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
    let lon = a.lon + dLon * f;
    if (lon > 180) lon -= 360; else if (lon < -180) lon += 360;
    return { lat: a.lat + (b.lat - a.lat) * f, lon, clamped: null };
  }

  // lat/lon -> wall position: tile index plus CONTINUOUS within-tile cell coords
  // (ex 0..31, ey 0..23) and the nearest sub-tile quadrant (the 3-bit wire pos).
  // Tile centres sit at lat = 81 - 18*row, lon = 36*col - 162 (the fire-zone grid).
  function wallPos(lat, lon) {
    const rf = (81 - lat) / 18;
    let row = Math.round(rf);
    if (row < 0) row = 0; else if (row > N - 1) row = N - 1;
    const cf = (lon + 162) / 36;
    let col = Math.round(cf);
    const colW = ((col % N) + N) % N;
    let ex = Math.round(((cf - col) + 0.5) * L.TILE_W);
    let ey = Math.round(((rf - row) + 0.5) * L.TILE_H);
    if (ex < 0) ex = 0; else if (ex > L.TILE_W - 1) ex = L.TILE_W - 1;
    if (ey < 0) ey = 0; else if (ey > L.TILE_H - 1) ey = L.TILE_H - 1;
    let pos = 0, best = Infinity;
    for (const k of Object.keys(GL.SUB_CELL)) {
      const c = GL.SUB_CELL[k];
      const d = (c[0] - ex) * (c[0] - ex) + (c[1] - ey) * (c[1] - ey);
      if (d < best) { best = d; pos = +k; }
    }
    return { tile: row * N + colW, row, col: colW, ex, ey, pos };
  }

  // Match a currently-detected storm (wx.cycloneName) to its track record.
  // Track ids are agency ids; names are the honest join key (case-insensitive).
  function trackFor(tracks, name) {
    if (!tracks || !tracks.storms || !name) return null;
    const up = String(name).toUpperCase();
    for (const id of Object.keys(tracks.storms)) {
      const s = tracks.storms[id];
      if (s && String(s.name || '').toUpperCase() === up
          && Array.isArray(s.points) && s.points.length) return s;
    }
    return null;
  }

  const API = { trackAt, wallPos, trackFor };
  g.WW_STORMTRACK = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
