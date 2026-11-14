// coastline.js — the wall's land/sea mask: a baked bitmap of REAL geography.
//
// v1 traced coarse procedural continent polygons + island ellipses (fake: Hudson
// Bay missing, UK+Ireland one blob, Indonesia a peanut). This version unpacks a
// bitmap RASTERISED FROM REAL DATA — the public-domain Natural Earth 1:50m land
// polygons — at the GRID*TILE_W x GRID*TILE_H (10*32 x 10*24 = 320x240) wall grid,
// one bit per ZX81 char cell. The heavy lifting (fetch + point-in-polygon + majority
// vote) happens OFFLINE in tools/build-coastline.js, which writes src/coastline-data.js;
// here we only unpack. The runtime never touches GeoJSON. Public API is unchanged:
// tileLandMask(row,col) and tileCenterLonLat(row,col). Dual module (Node + browser).
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const DATA = (typeof require === 'function') ? require('./coastline-data') : g.WW_COASTLINE_DATA;
  const MAPW = L.GRID * L.TILE_W;  // 320
  const MAPH = L.GRID * L.TILE_H;  // 240

  if (DATA.W !== MAPW || DATA.H !== MAPH) {
    throw new Error('coastline-data grid ' + DATA.W + 'x' + DATA.H +
      ' != wall grid ' + MAPW + 'x' + MAPH + ' — re-run tools/build-coastline.js');
  }

  // Unpack the base64 row-major, MSB-first, 1-bit-per-cell bitmap into a byte mask
  // (0 = sea, 1 = land), the same shape the old buildMask() returned. Cached.
  let CACHE = null;
  function buildMask() {
    if (CACHE) return CACHE;
    const bytes = (typeof Buffer !== 'undefined')
      ? Buffer.from(DATA.packed, 'base64')
      : (function (b64) {                       // browser: atob -> Uint8Array
        const bin = atob(b64), u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return u;
      })(DATA.packed);
    const mask = new Uint8Array(MAPW * MAPH);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    }
    CACHE = mask;
    return mask;
  }

  // 768-byte land mask for tile (row,col) in the 10x10 grid.
  function tileLandMask(row, col) {
    const mask = buildMask();
    const out = new Uint8Array(L.TILE_W * L.TILE_H);
    const ox = col * L.TILE_W, oy = row * L.TILE_H;
    for (let y = 0; y < L.TILE_H; y++)
      for (let x = 0; x < L.TILE_W; x++)
        out[y * L.TILE_W + x] = mask[(oy + y) * MAPW + (ox + x)];
    return out;
  }

  // center lon/lat of tile (row,col) — used to sample weather. UNCHANGED from v1;
  // the map is full-globe equirectangular (row 0 ~81N .. row 9 ~81S), so region
  // names / weather sample points are identical to before.
  function tileCenterLonLat(row, col) {
    const lon = ((col + 0.5) / L.GRID) * 360 - 180;
    const lat = 90 - ((row + 0.5) / L.GRID) * 180;
    return [lon, lat];
  }

  const C = { MAPW, MAPH, buildMask, tileLandMask, tileCenterLonLat, source: DATA.source };
  g.WW_COASTLINE = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);
