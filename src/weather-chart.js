// weather-chart.js — the WEATHER page's synoptic chart overlay (owner 2026-08-02,
// spiked to acceptance as scratchpad spike-a..o): "lines not tone; every mark
// means something."
//
//   RAIN AREAS   precip >= 0.25 mm (bilinear raster of the tile readings; an
//                active WMO code floors a dry slot) -> closed regions drawn as
//                a black SCALLOPED outline with a quarter-block dot lattice
//                inside ('.' -> 0x01 quads; '*' 0x17 snow below freezing), and
//                the machine's own full-size 16x12 precip pictogram
//                (GL.CAT_GLYPHS) seated at the area's centroid — or the nearest
//                seat where the glyph is COMPLETELY CONTAINED in the area; a
//                band too small to hold it carries outline+dots only.
//   GALES        wind >= 62 km/h (Beaufort 8) -> the wind-streak pictogram
//                (CAT_GLYPHS[GALE]) at the wind-field peak on a cleared halo.
//                NO outline (owner: "too much extra clutter") and none within a
//                cyclone's neighbourhood — the spiral already says wind.
//   LAND         white interiors + solid black coastline (the radiofax look
//                the browser's applyCoastOutline already draws) — outline
//                masks are computed here so the stitch/poster path can draw
//                the identical land.
//
// Everything is a DISPLAY-ONLY host poke (the applySmokeField idiom — pending
// a Z80-native move): per-tile {i,c} cell lists, poked over the machine's
// finished tile through pokeCell() below, which only rewrites background/chart
// cells — flames, spirals, plates, bolts and coastline always read through.
// Cloud cover is deliberately ABSENT: at 10x10-tile resolution every rendering
// of it was soup or scribble (rounds 1-9); SATELLITE owns cloud.
// Shared browser + node (UMD) so the live wall, the posted still/video and the
// continental desks agree cell-for-cell.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./layout'), require('./glyphs'));
  } else {
    root.WW_WEATHERCHART = factory(root.WW_LAYOUT, root.WW_GLYPHS);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (L, GL) {
  var TW = L.TILE_W, TH = L.TILE_H;
  var PR_TH = 0.25;        // rain-area threshold (mm)
  var GALE_KMH = 62;       // Beaufort 8
  var MIN_BAND = 60;       // cells; smaller regions are specks, not systems
  var RAIN_DOT = 0x01, SNOW_DOT = 0x17, INK = 0x80, CLEAR = 0x00;

  // Cell codes this overlay may rewrite: true background (0x00 empty / 0x01
  // land tint — also our rain dot), our snow dot, and the terminator chequer
  // (0x08). Everything else (icons, plates, coast ink, spiral) wins.
  function pokeable(c) { return c === 0x00 || c === 0x01 || c === 0x17 || c === 0x08; }

  // Bilinear promotion of per-tile values to the global cell raster; tile
  // centres are the knots, longitude wraps, latitude clamps.
  function bilin(vals, N, gx, gy) {
    var fx = (gx - TW / 2) / TW, fy = (gy - TH / 2) / TH;
    var c0 = Math.floor(fx), r0 = Math.floor(fy);
    var tx = fx - c0, ty = fy - r0;
    var r1 = r0 + 1;
    if (r0 < 0) r0 = 0; if (r1 < 0) r1 = 0;
    if (r0 > N - 1) r0 = N - 1; if (r1 > N - 1) r1 = N - 1;
    var ca = ((c0 % N) + N) % N, cb = (((c0 + 1) % N) + N) % N;
    return (vals[r0 * N + ca] * (1 - tx) + vals[r0 * N + cb] * tx) * (1 - ty)
         + (vals[r1 * N + ca] * (1 - tx) + vals[r1 * N + cb] * tx) * ty;
  }

  // Land OUTLINE masks from the coastline masks: per tile, 0 sea / 1 interior
  // land / 2 coast (a land cell with a 4-neighbour sea, seams honest via the
  // global raster). Same encoding the browser's applyCoastOutline consumes.
  function outlineMasks(landMasks, N) {
    var GW = N * TW, GH = N * TH;
    var land = new Uint8Array(GW * GH);
    var t, x, y;
    for (t = 0; t < N * N; t++) {
      var mk = landMasks[t], bx = (t % N) * TW, by = ((t / N) | 0) * TH;
      for (y = 0; y < TH; y++) for (x = 0; x < TW; x++)
        if (mk[y * TW + x]) land[(by + y) * GW + (bx + x)] = 1;
    }
    var out = [];
    for (t = 0; t < N * N; t++) out.push(new Uint8Array(TW * TH));
    for (var gy = 0; gy < GH; gy++)
      for (var gx = 0; gx < GW; gx++) {
        if (!land[gy * GW + gx]) continue;
        var w = land[gy * GW + ((gx + GW - 1) % GW)], e = land[gy * GW + ((gx + 1) % GW)];
        var n = land[Math.max(0, gy - 1) * GW + gx], s = land[Math.min(GH - 1, gy + 1) * GW + gx];
        out[((gy / TH) | 0) * N + ((gx / TW) | 0)][(gy % TH) * TW + (gx % TW)] = (w && e && n && s) ? 1 : 2;
      }
    return out;
  }

  // Flood-fill the connected regions (>= MIN_BAND cells) of a 0/1 raster;
  // longitude wraps. Returns arrays of global cell indices.
  function regions(mask, GW, GH) {
    var seen = new Uint8Array(GW * GH), out = [];
    for (var start = 0; start < GW * GH; start++) {
      if (!mask[start] || seen[start]) continue;
      var q = [start], cells = [];
      seen[start] = 1;
      while (q.length) {
        var i = q.pop(); cells.push(i);
        var gx = i % GW, gy = (i / GW) | 0;
        var nb = [gy * GW + ((gx + 1) % GW), gy * GW + ((gx + GW - 1) % GW)];
        if (gy > 0) nb.push((gy - 1) * GW + gx);
        if (gy < GH - 1) nb.push((gy + 1) * GW + gx);
        for (var k = 0; k < nb.length; k++)
          if (mask[nb[k]] && !seen[nb[k]]) { seen[nb[k]] = 1; q.push(nb[k]); }
      }
      if (cells.length >= MIN_BAND) out.push(cells);
    }
    return out;
  }

  // Seat search: nearest position (ring order from cx,cy) whose 16x12 glyph
  // box lies entirely inside `mask`. null when nothing fits.
  function containedSeat(mask, GW, GH, cx, cy) {
    var fits = function (px, py) {
      if (py - 6 < 0 || py + 5 >= GH) return false;
      for (var ry = 0; ry < 12; ry++)
        for (var rx = 0; rx < 16; rx++)
          if (!mask[(py - 6 + ry) * GW + (((px - 8 + rx) % GW) + GW) % GW]) return false;
      return true;
    };
    for (var r = 0; r <= 40; r++)
      for (var dy = -r; dy <= r; dy++)
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var px = ((cx + dx) % GW + GW) % GW, py = cy + dy;
          if (fits(px, py)) return [px, py];
        }
    return null;
  }

  // Stamp a 16x12 CAT_GLYPHS pictogram (row bitmasks, bit 15-x) with its
  // clearing halo into the per-tile push list.
  function stampGlyph(push, GW, GH, art, cx, cy) {
    var dx, dy, rx, ry;
    for (dy = -7; dy <= 6; dy++)
      for (dx = -9; dx <= 8; dx++)
        push(((cx + dx) % GW + GW) % GW, Math.max(0, Math.min(GH - 1, cy + dy)), CLEAR);
    for (ry = 0; ry < 12; ry++)
      for (rx = 0; rx < 16; rx++) {
        if (!((art[ry] >> (15 - rx)) & 1)) continue;
        push(((cx - 8 + rx) % GW + GW) % GW, Math.max(0, Math.min(GH - 1, cy - 6 + ry)), INK);
      }
  }

  // compute({ weather, N }) -> array N*N of {i,c} lists (null = no chart cells
  // on that tile). Pure function of the snapshot readings; poke order within a
  // list is the draw order (later wins under pokeCell).
  function compute(opts) {
    var weather = opts.weather || [], N = opts.N || 10;
    var NT = N * N, GW = N * TW, GH = N * TH;
    var prec = new Float32Array(NT), temp = new Float32Array(NT), wind = new Float32Array(NT);
    var cycNear = {};
    var t, i, gx, gy;
    for (t = 0; t < NT; t++) {
      var w = weather[t] || {};
      var p = (typeof w.precipMm === 'number') ? Math.max(0, w.precipMm) : 0;
      var wc = w.weatherCode | 0;
      if (wc >= 95) p = Math.max(p, 1.5); else if (wc >= 51) p = Math.max(p, 0.6);
      prec[t] = p;
      temp[t] = (typeof w.tempC === 'number') ? w.tempC : 10;
      wind[t] = (typeof w.windKmh === 'number') ? Math.max(0, w.windKmh) : 0;
      if ((w.cycloneTier | 0) >= L.CYC.CYCLONE) {
        var r = (t / N) | 0, c = t % N;
        for (var dr = -1; dr <= 1; dr++) {
          var rr = r + dr; if (rr < 0 || rr >= N) continue;
          for (var dc = -1; dc <= 1; dc++) cycNear[rr * N + ((c + dc + N) % N)] = 1;
        }
      }
    }
    var prR = new Float32Array(GW * GH), tmR = new Float32Array(GW * GH), wnR = new Float32Array(GW * GH);
    for (gy = 0; gy < GH; gy++)
      for (gx = 0; gx < GW; gx++) {
        prR[gy * GW + gx] = bilin(prec, N, gx, gy);
        tmR[gy * GW + gx] = bilin(temp, N, gx, gy);
        wnR[gy * GW + gx] = bilin(wind, N, gx, gy);
      }
    var tiles = new Array(NT).fill(null);
    var push = function (px, py, code) {
      var tt = ((py / TH) | 0) * N + ((px / TW) | 0);
      if (!tiles[tt]) tiles[tt] = [];
      tiles[tt].push({ i: (py % TH) * TW + (px % TW), c: code });
    };

    // ---- rain areas --------------------------------------------------------
    var pmask = new Uint8Array(GW * GH);
    for (i = 0; i < GW * GH; i++) pmask[i] = prR[i] > PR_TH ? 1 : 0;
    var bands = regions(pmask, GW, GH);
    for (var b = 0; b < bands.length; b++) {
      var cells = bands[b];
      var sx = 0, sy = 0, my = 0;
      for (i = 0; i < cells.length; i++) {
        gx = cells[i] % GW; gy = (cells[i] / GW) | 0;
        var a = (gx / GW) * 2 * Math.PI;
        sx += Math.cos(a); sy += Math.sin(a); my += gy;
        // interior: dot lattice, spacing by real intensity, rows offset
        var pv = prR[cells[i]];
        var wn = pmask[gy * GW + ((gx + GW - 1) % GW)], en = pmask[gy * GW + ((gx + 1) % GW)];
        var nn = pmask[Math.max(0, gy - 1) * GW + gx], sn = pmask[Math.min(GH - 1, gy + 1) * GW + gx];
        if (!(wn && en && nn && sn)) {
          // SCALLOPED boundary: every edge cell + periodic 1-cell outward bump
          push(gx, gy, INK);
          if ((gx * 3 + gy) % 5 === 0) {
            var bx = !wn ? (gx + GW - 1) % GW : !en ? (gx + 1) % GW : gx;
            var by = (bx === gx) ? (!nn ? Math.max(0, gy - 1) : Math.min(GH - 1, gy + 1)) : gy;
            push(bx, by, INK);
          }
          continue;
        }
        var step = pv > 4 ? 2 : pv > 1 ? 3 : 4;
        if (gy % step === 0 && (gx + ((gy / step) & 1) * (step >> 1)) % step === 0)
          push(gx, gy, tmR[gy * GW + gx] < 0 ? SNOW_DOT : RAIN_DOT);
      }
      // TYPE GLYPHS (owner 2026-08-03, mega-band rule): a band bigger than ~2
      // glyph-areas seeds EXTRA pictograms at its LOCAL INTENSITY PEAKS —
      // glyphs sit over actual phenomena, so a monsoon complex marks where the
      // rain concentrates, count capped by area (1 + cells/1200), spacing >=
      // 1.5 tiles. Each glyph is typed LOCALLY (snow at the polar end of a
      // band whose tropical end rains; thunder only if a thunder tile sits
      // within 1 tile of the SEAT, not anywhere in the band). Small bands keep
      // the single centroid-seated glyph. Flat bands with mushy maxima fall
      // back to farthest-point seats so a wide band never carries one mark.
      var budget = 1 + Math.floor(cells.length / 1200);
      var ccx = Math.round(((Math.atan2(sy, sx) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * GW) % GW;
      var ccy = Math.round(my / cells.length);
      var inBand = {};
      for (i = 0; i < cells.length; i++) inBand[cells[i]] = 1;
      var typeAt = function (px, py) {
        var st = ((py / TH) | 0), sc = ((px / TW) | 0);
        for (var dr2 = -1; dr2 <= 1; dr2++) {
          var rr2 = st + dr2; if (rr2 < 0 || rr2 >= N) continue;
          for (var dc2 = -1; dc2 <= 1; dc2++) {
            var tt2 = rr2 * N + ((sc + dc2 + N) % N);
            var w2 = weather[tt2];
            if (w2 && L.weatherCodeToCat(w2.weatherCode || 0) === L.CAT.THUNDER
              && inBand[(rr2 * TH + (TH >> 1)) * GW + (((sc + dc2 + N) % N) * TW + (TW >> 1))]) return L.CAT.THUNDER;
          }
        }
        if (tmR[py * GW + px] < 0) return L.CAT.SNOW;
        return prR[py * GW + px] > 1 ? L.CAT.RAIN : L.CAT.DRIZZLE;
      };
      var seats = [];
      var sepOK = function (px, py) {
        for (var s2 = 0; s2 < seats.length; s2++) {
          var dx2 = Math.abs(px - seats[s2][0]); dx2 = Math.min(dx2, GW - dx2);
          if (Math.hypot(dx2, py - seats[s2][1]) < 48) return false;   // 1.5 tiles
        }
        return true;
      };
      var place = function (px, py) {
        var seat = containedSeat(pmask, GW, GH, px, py);
        if (!seat || !sepOK(seat[0], seat[1])) return false;
        stampGlyph(push, GW, GH, GL.CAT_GLYPHS[typeAt(seat[0], seat[1])] || [], seat[0], seat[1]);
        seats.push(seat);
        return true;
      };
      // strongest local maxima of the precip raster inside the band
      var maxima = [];
      for (i = 0; i < cells.length; i++) {
        var ci = cells[i];
        gx = ci % GW; gy = (ci / GW) | 0;
        var v = prR[ci], isMax = true;
        for (var ndy = -1; ndy <= 1 && isMax; ndy++)
          for (var ndx = -1; ndx <= 1; ndx++) {
            if (!ndx && !ndy) continue;
            var nyy = Math.max(0, Math.min(GH - 1, gy + ndy));
            if (prR[nyy * GW + ((gx + ndx + GW) % GW)] > v) { isMax = false; break; }
          }
        if (isMax) maxima.push(ci);
      }
      maxima.sort(function (a, b) { return prR[b] - prR[a]; });
      place(ccx, ccy);                                     // the centroid glyph first
      for (i = 0; i < maxima.length && seats.length < budget; i++)
        place(maxima[i] % GW, (maxima[i] / GW) | 0);
      // farthest-point fallback: flat band, budget unfilled
      var guard = 0;
      while (seats.length > 0 && seats.length < budget && guard++ < 8) {
        var best = -1, bestD = -1;
        for (i = 0; i < cells.length; i += 7) {
          gx = cells[i] % GW; gy = (cells[i] / GW) | 0;
          var dmin = Infinity;
          for (var s3 = 0; s3 < seats.length; s3++) {
            var dx3 = Math.abs(gx - seats[s3][0]); dx3 = Math.min(dx3, GW - dx3);
            dmin = Math.min(dmin, Math.hypot(dx3, gy - seats[s3][1]));
          }
          if (dmin > bestD) { bestD = dmin; best = cells[i]; }
        }
        if (best < 0 || !place(best % GW, (best / GW) | 0)) break;
      }
    }

    // ---- gales    // ---- gales -------------------------------------------------------------
    var gmask = new Uint8Array(GW * GH);
    for (i = 0; i < GW * GH; i++) gmask[i] = wnR[i] >= GALE_KMH ? 1 : 0;
    var gales = regions(gmask, GW, GH);
    for (var g = 0; g < gales.length; g++) {
      var gc = gales[g];
      var peak = gc[0];
      for (i = 0; i < gc.length; i++) if (wnR[gc[i]] > wnR[peak]) peak = gc[i];
      var pkTile = (((peak / GW) | 0) / TH | 0) * N + ((peak % GW) / TW | 0);
      if (cycNear[pkTile]) continue;   // the spiral owns it
      stampGlyph(push, GW, GH, GL.CAT_GLYPHS[9] || [],   // 9 = GALE wind-streak art
        peak % GW, Math.max(7, Math.min(GH - 7, (peak / GW) | 0)));
    }
    return tiles;
  }

  return {
    compute: compute,
    outlineMasks: outlineMasks,
    pokeable: pokeable,
    bilin: bilin,
    PR_TH: PR_TH, GALE_KMH: GALE_KMH, MIN_BAND: MIN_BAND,
    RAIN_DOT: RAIN_DOT, SNOW_DOT: SNOW_DOT,
  };
});
