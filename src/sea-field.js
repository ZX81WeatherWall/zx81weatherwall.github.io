// sea-field.js — the SEA page's wave texture engine (owner QC 2026-07-30: the tab
// is "remarkably uninformative... either grey or black animated per-tile waves...
// waves mysteriously stop hundreds of km from the African west coast").
//
// Three defects, one root: the page rendered ONE whole-tile average through TWO
// ink levels, and only on tiles whose sample point happened to be sea (a coast
// tile sampled on land carried no marine value, so its offshore cells went dead
// — the African gap). This module replaces that with a per-CELL significant-
// wave-height FIELD:
//
//   fillTiles(vals, N)         — diffusion-fill the per-tile wave heights into
//                                the null (land-sampled) tiles from their marine
//                                neighbours, so the field reaches the coastline.
//                                Double-buffered per pass (no directional bias);
//                                x wraps at the date line. Real samples are
//                                NEVER altered — only nulls are filled.
//   boost(wh, d, R, peak)      — storm-sea maximum: within radius R of a
//                                canonical storm head the height rises linearly
//                                to `peak` at the eye (a hurricane owns the
//                                roughest water on the wall). max(), never less
//                                than the real reading.
//   seaCharAt(wh, gx, gy, ph, headD)
//                              — ONE cell -> display char. Six-step Douglas-
//                                style ramp (calm blank -> sparse crest flecks
//                                -> checker crest lines -> ink crests w/ grey
//                                lead edge -> short ink crests + foam flecks ->
//                                inverse storm bands). `ph` in [0,1) rolls the
//                                crests; near a storm head (headD != null, the
//                                distance in cells) crests become concentric
//                                rings RADIATING from the eye.
//
// Chars are the display-poke alphabet: 0x00 open water, 0x08 grey checker,
// 0x80 solid ink. Display-only host poke (parity-EXEMPT like satFrames); the
// tape payload still ships waveToSeaState and texture.seaCell stays the
// machine-native baseline.
//
// PURE + deterministic; node + browser (window.WW_SEAFIELD).
(function (g) {
  'use strict';
  var TAU = Math.PI * 2;

  // Fill null tiles from 4-neighbour means, one synchronous pass at a time,
  // until no null remains (bounded by N passes: the widest possible gap).
  function fillTiles(vals, N) {
    var out = vals.slice();
    for (var pass = 0; pass < N; pass++) {
      var next = out.slice(), changed = false;
      for (var t = 0; t < N * N; t++) {
        if (out[t] != null) continue;
        var c = t % N, r = (t / N) | 0, s = 0, n = 0;
        var nb = [out[r * N + (c + 1) % N], out[r * N + (c + N - 1) % N],
                  r > 0 ? out[(r - 1) * N + c] : null,
                  r < N - 1 ? out[(r + 1) * N + c] : null];
        for (var k = 0; k < 4; k++) if (nb[k] != null) { s += nb[k]; n++; }
        if (n) { next[t] = s / n; changed = true; }
      }
      out = next;
      if (!changed) break;
    }
    // an all-null field (no marine data at all) fills to 0 = calm, honest blank
    for (var i = 0; i < out.length; i++) if (out[i] == null) out[i] = 0;
    return out;
  }

  // Storm-sea maximum around a canonical head. Linear to `peak` at the eye.
  function boost(wh, d, R, peak) {
    if (d >= R) return wh;
    return Math.max(wh, peak * (1 - d / R));
  }

  // One cell of sea -> display char code.
  //   wh    significant wave height, metres (already storm-boosted)
  //   gx,gy global cell coords (texture variation only)
  //   ph    motion phase [0,1)
  //   headD distance in cells to the nearest storm head, or null
  //   swell OPTIONAL {sx, sy, wl}: real swell — unit TRAVEL vector (screen
  //         coords) + wavelength in cells (from the true wave period). Crests
  //         render PERPENDICULAR to travel and roll ALONG it; without it the
  //         texture falls back to the styled southward roll.
  function seaCharAt(wh, gx, gy, ph, headD, swell) {
    if (wh < 0.15) return 0x00;                       // calm: open white water
    var amp = Math.min(1, wh / 6);
    var wl = swell ? swell.wl : 4 + 8 * (1 - amp);    // real period, else styled
    // Roll speed must be an INTEGER number of cycles per loop or the frame
    // wrap (ph 7/8 -> 0) visibly seams. Rougher seas roll faster: 1..3 cycles.
    var cyc = 1 + Math.round(amp * 2);
    var s;
    if (headD != null) {
      // storm zone: concentric crests RADIATE from the eye (phase moves outward)
      s = Math.sin(headD * TAU / wl - ph * TAU * 2);
    } else if (swell) {
      // crest phase = projection onto the travel direction; rolling +ph moves
      // the crests ALONG (sx,sy) — the real propagation on screen
      s = Math.sin((gx * swell.sx + gy * swell.sy) * TAU / wl - ph * TAU * cyc);
    } else {
      s = Math.sin(gy * TAU / wl - ph * TAU * cyc + Math.sin(gx * 0.11) * 0.8);
    }
    if (wh < 0.7) return s > 0.85 ? 0x08 : 0x00;      // light: sparse crest flecks
    if (wh < 1.8) return s > 0.6 ? 0x08 : 0x00;       // moderate: checker crest lines
    if (wh < 3.5) return s > 0.6 ? 0x80                // high: ink crests,
      : (s > 0.35 ? 0x08 : 0x00);                     //   grey lead edge
    if (wh < 6) return s > 0.5 ? 0x80                  // very high: short ink crests
      : (s > 0.2 ? 0x08                                //   grey shoulder
      : (((gx * 3 + gy) & 7) === 0 ? 0x08 : 0x00));    //   + foam flecks in troughs
    return s > 0 ? 0x80 : (s < -0.8 ? 0x00 : 0x08);   // phenomenal: inverse bands
  }

  var api = { fillTiles: fillTiles, boost: boost, seaCharAt: seaCharAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.WW_SEAFIELD = api;
})(typeof window !== 'undefined' ? window : this);
