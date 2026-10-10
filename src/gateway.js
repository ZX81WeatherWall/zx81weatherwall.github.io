// gateway.js — the acoustic-coupler "ISP" of the ZX81 Weather Wall.
//
// Physically, the gateway is the ONLY Internet-touching element: it fetches
// Open-Meteo (one batched call for all tile coords), turns each tile's weather
// into a compact fast-protocol frame, and modulates it onto the downlink party
// bus (its MIC -> distribution amp -> all 100 EAR inputs). It then reads each
// machine's ACK/NAK off the uplink (summing mixer -> gateway EAR) in that
// machine's TDMA slot and selectively retransmits any NAKed tile.
//
// This module is the transport logic only (dual module: Node + browser worker).
// The one-per-tile receive/ACK/retransmit exchange is driven against a machine
// object that exposes the emulator's poke/peek/attachEar/attachMic/tState/cpu/
// runFrame interface — the same in Node and in a Web Worker.
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const TB = (typeof require === 'function') ? require('./tapebus') : g.WW_TAPEBUS;
  const REP = (typeof require === 'function') ? require('./report') : g.WW_REPORT;
  const GL = (typeof require === 'function') ? require('./glyphs') : g.WW_GLYPHS;
  const NHC = (typeof require === 'function') ? require('./nhc') : g.WW_NHC;
  const SPEC = (typeof require === 'function') ? require('./tab-spec') : g.WW_TABSPEC;
  const { TapeBus, FAST } = TB;

  // Compact refresh payload for a tile:
  //   [temperatureByte, precipFlag, weatherCat, seaState, windByte, cycloneByte]
  // The machine's baked-in coastline (static, sent once at boot) plus the shared
  // texture rules (src/texture.js, mirrored in the Z80 renderer) do the spatial
  // expansion locally, so the per-refresh payload stays tiny (6 bytes << 64).
  //   weatherCat  <- WMO weather_code, categorised (snow/fog/thunder/...).
  //   seaState    <- marine wave height, banded (calm..storm); calm on land.
  //   windByte    <- wind km/h, transmitted for completeness (reserved layer).
  //   cycloneByte <- tier (hi nibble) | sub-tile position (lo nibble); 0 = none.
  //   opts.radar  <- when true, append the 7th byte (isoByte, the isotherm edge
  //                  mask) so the machine renders the "weather-radar" view
  //                  (contour lines + moving precip) instead of the temp grey
  //                  fill. LEN 6 -> classic; LEN 7 -> radar (LEN-gated, so a
  //                  classic 6-byte frame stays byte-identical to the BASIC oracle).
  function tilePayload(wx, opts) {
    // byte0 is a SHARED slot: temperature (every page) OR, on the SATELLITE page
    // (FS7-T5), the raw cloud-cover PERCENT (0-100) directly — that page has no use
    // for temperature, so the slot is repurposed (same precedent as byte6's page-
    // dependent contour meaning below). No payload growth.
    const satPage = opts && (opts.page | 0) === L.PAGE.SATELLITE;
    const weatherPage = opts && (opts.page | 0) === L.PAGE.WEATHER;
    // byte0 = temperature (every page) / cloud% (SATELLITE). On WEATHER a HOT/COLD
    // marker carries the reading it wants stamped (== tempC on a real tile; a synthetic
    // sample on a legend row), so the big-number path reads it straight from byte0.
    const byte0 = satPage
      ? Math.max(0, Math.min(100, Math.round(wx.cloudCoverPct == null ? 0 : wx.cloudCoverPct)))
      : (weatherPage && wx.tempMarker != null) ? L.tempToByte(wx.tempMarker)
      : L.tempToByte(wx.tempC == null ? -50 : wx.tempC);
    // byte1 is a fixed slot the WALL renderer reads only for truthiness (wet/dry).
    // On a REPORTER frame (opts.precip) it carries the PACKED precip descriptor
    // (intensity band + fine WMO type; layout.precipDescriptor) so the reporter can
    // compose "CITY INTENSITY TYPE" without a variable-length trailer; 0 stays dry,
    // so the renderer is unaffected. WALL frames keep the classic 0/1 flag, so every
    // render proof is byte-identical.
    const byte1 = (opts && opts.precip)
      ? L.precipDescriptor(wx.precipMm, wx.weatherCode || 0)
      : L.precipToByte(wx.precipMm);
    const p = [
      byte0,
      byte1,
      // byte2 = weather category (drives land texture + big glyph). A WEATHER-front
      // extreme marker (HOT/COLD/GALE) overrides it with a synthetic glyph index
      // 7/8/9 (no CAT enum slot) so the machine stamps the HEAT/COLD/GALE big glyph;
      // the base land texture treats 7..9 as "unknown -> base tint" (cb_base).
      (wx.glyphCat != null ? (wx.glyphCat & 0xff) : L.weatherCodeToCat(wx.weatherCode || 0)),
      // byte3 = sea state, EXCEPT on WEATHER where sea is meaningless and the slot carries
      // the wildfire-smoke plume density (0..3); the machine hatches from it (pgw_smoke).
      // 0 when absent, so every no-smoke poster/proof frame stays byte-identical.
      weatherPage ? ((wx.smokeByte | 0) & 0x03) : L.waveToSeaState(wx.waveHeight),
      L.windToByte(wx.windKmh),
      // On a WEATHER-page tier-NONE tile the (otherwise dead) pos bits carry the
      // big glyph's half-tile quadrant (glyphPos, SUB codes) — sub-tile glyph
      // placement with ZERO new wire. Every other page/tier is byte-identical.
      L.cycloneToByte(wx.cycloneTier | 0,
        (weatherPage && (wx.cycloneTier | 0) === L.CYC.NONE && wx.glyphPos) ? (wx.glyphPos | 0) : (wx.cyclonePos | 0),
        wx.cycloneSouth | 0, wx.cycloneAnim | 0, wx.cycloneSuppress | 0),
    ];
    // Paged frame (LEN>=8): contour edge mask (byte6) + page id (byte7) + wind
    // direction octant (byte8, WIND page). byte6 is ONE SHARED slot whose MEANING
    // follows the active page: TEMP/RADAR=isotherm, WIND=isotach,
    // PRESSURE=isobar, SATELLITE=terminator/cloud legacy bits.
    // Legacy frames (no opts.page): LEN6 classic or LEN7 radar, byte-identical
    // to the pre-page protocol so every prior proof stays green.
    if (opts && opts.page != null) {
      const pg = opts.page | 0;
      let isoOut = pg === L.PAGE.SATELLITE ? (wx.satIsoByte | 0)
        : pg === L.PAGE.PRESSURE ? (wx.pressIsoByte | 0)
        : pg === L.PAGE.WIND ? (wx.windIsoByte | 0)
        : (wx.isoByte | 0);
      // Smooth-temp dither flag rides ISO byte bit7 (the contour routine reads only
      // the low nibble, so it coexists with the isotherm edges). Opt-in — off by
      // default so every poster/proof frame stays byte-identical; the live browser
      // path enables it for the TEMP page.
      if (pg === L.PAGE.TEMP && opts.smoothTemp) isoOut = (isoOut & 0x7f) | 0x80;
      // WEATHER page ignores the isotherm mask (no contour there); repurpose byte6:
      // bit6 = "stamp the HOT/COLD reading" (mirrors TEMP bit6); bit5 = "free-run this
      // tile" so a wildfire flame flickers. The fire NAME (with its exact caption ROW,
      // hugging the flame) rides after the phen list below.
      if (pg === L.PAGE.WEATHER) isoOut = (wx.tempMarker != null ? 0x40 : 0) | (wx.fireMark ? 0x20 : 0);
      // CONTOUR corners (FS/marching-squares): when this TEMP/PRESSURE tile carries its four
      // shared corner field bytes, flag byte6 bit4 (CORNERS) and clear the low-nibble legacy
      // isotherm edges (bits0-3) + bit5 so ONLY the machine-drawn curve shows; smooth (bit7) /
      // number (bit6) survive. The four corners ride at index 11..14 (mutually exclusive with
      // the FS2/phen trailer — a corners tile appends neither). Absent -> byte-identical legacy.
      // FS2 trailer PRECEDENCE (owner 2026-07-24: name bar on all tabs): a tile whose
      // cyclone qualifies for the name/pressure trailer ships THAT instead of its
      // corner bytes — the eye stamp + name plate own the tile. Without this the
      // LEN-15 early return below silently ate the trailer on TEMP/PRESSURE.
      // Byte-parity mirror of the worker's hasTrailer gate.
      const cycTrailer = (wx.cycloneTier | 0) >= L.CYC.CYCLONE &&
        !(wx.cycloneSuppress | 0) && L.pressureToByte(wx.cyclonePressureHpa) != null;
      const hasCorners = !opts.haz && !cycTrailer && wx.corners &&
        (pg === L.PAGE.TEMP || pg === L.PAGE.PRESSURE);
      if (hasCorners) isoOut = (isoOut & 0xc0) | 0x10;
      p.push(isoOut & 0xff);                     // byte6: page-selected contour/terminator mask
      p.push((opts.page | 0) & 0xff);            // byte7 page id
      p.push(L.windDirToOctant(wx.windDir) & 0xff); // byte8 wind direction octant
      p.push((wx.periphByte | 0) & 0xff);        // byte9 cyclone-periphery band (0 = none)
      if (!opts.haz) p.push((pg === L.PAGE.SATELLITE ? (wx.termByte | 0) : 0) & 0xff); // byte10 TERMV: SATELLITE-only — off-satellite the machine ct_ edge stamps a wall-spanning grey stepped box (the 7724877 defect; 7afcb38 gated app.js but missed this push)
      if (hasCorners) {                          // bytes 11..14: nw, ne, se, sw (shared corners)
        const c = wx.corners;
        p.push(c.nw & 0xff, c.ne & 0xff, c.se & 0xff, c.sw & 0xff);
        return p;                                // corners frame is LEN 15, no trailer/phen
      }
      // REPORTER-only trailer: severe-weather hazard code (class + headline value).
      // Only added when the gateway asks (opts.haz) — the wall's own tile frames stay
      // LEN 10 unless they carry a phen/trailer; the reporter's base frames run LEN 12
      // so its on-machine scan sees hazards.
      if (opts.haz) {
        p.push((opts.haz.cls | 0) & 0xff);       // byte10 hazard class (0 = none)
        p.push((opts.haz.val | 0) & 0xff);       // byte11 hazard headline value
        // byte12 = overnight-low placeholder (255 = absent). The v2 reporter frame
        // (tilePayloadV2) carries the real hot-night byte here; the v1 reporter frame has no
        // hot-night clause, but the SHARED on-machine aggregate1 reads the cyclone/fire/flood
        // string trailer at PBUF+13 (past this byte), so the v1 reporter frame MUST reserve
        // byte12 too or its cyclone name+pressure trailer would misalign. 255 -> no hot-night.
        p.push(255);
      }
      // FS2 §A — LEN-gated cyclone NAME + min-PRESSURE trailer. Appended ONLY for a
      // NON-suppressed tier>=CYCLONE detection that carries a decodable pressure. The
      // base offset B is 10 on a WALL frame or 13 on a REPORTER frame (past the
      // haz bytes 10-11 and the byte12 overnight-low). Encoding at B:
      //   [B]=pressureByte, [B+1]=nameLen (0..10), [B+2..B+1+nameLen]=ZX81 name codes.
      // A suppressed / non-cyclone / no-pressure tile appends NOTHING, so the frame
      // stays LEN10 (wall) / LEN12 (reporter) and is byte-identical to the pre-FS2
      // build (every prior proof green). nameLen=0 = pressure-only (an unnamed W-Pac
      // cyclone still shows its eye pressure). The tile DRAWING of these bytes is T9;
      // T8 only makes them travel + land in the Z80 PBUF byte-exact.
      // FS7: the name/pressure trailer and the phen list are MUTUALLY EXCLUSIVE
      // per tile, discriminated by tier (the SAME test the Z80 uses; no
      // variable-offset arithmetic). A tier>=CYCLONE tile emits the FS2 trailer
      // (UNCHANGED); a tier<CYCLONE WEATHER/PRESSURE wall frame may emit the phen
      // list. PRESSURE uses it only for sparse machine-stamped centre H/L helpers;
      // scalar edge/bezel outlines stay disabled.
      const cycTier = wx.cycloneTier | 0;
      if (cycTier >= L.CYC.CYCLONE) {
        const pressureByte = L.pressureToByte(wx.cyclonePressureHpa);
        if (!(wx.cycloneSuppress | 0) && pressureByte != null) {
          const codes = wx.cycloneName ? NHC.nameToZX(wx.cycloneName, 10) : [];
          p.push(pressureByte & 0xff);           // [B]     min pressure (hPa - 850)
          p.push(codes.length & 0xff);           // [B+1]   nameLen (0..10)
          for (let i = 0; i < codes.length; i++) p.push(codes[i] & 0xff); // [B+2..] name
          // SEA-BIAS plate anchor (owner 2026-07-24; named trailers only, LEN-gated on
          // the machine): 2 optional bytes — caption centre col + name top row, host-
          // picked from the coastline mask (texture.pickPlateAnchor). A caller that
          // sets wx.plateAnchor gets the seaward caption; absent -> legacy placement,
          // byte-identical to the pre-anchor build. Mirrors the worker's trailer.
          if (codes.length && wx.plateAnchor)
            p.push(wx.plateAnchor.cx & 0xff, wx.plateAnchor.y & 0xff);
        }
      } else if ((opts.page === L.PAGE.WEATHER && Array.isArray(wx.phen)) ||
                 (opts.page === L.PAGE.PRESSURE && Array.isArray(wx.pressurePhen))) {
        // FS7 wall phen list after TERMV: count, then (x,y,code) triples — one-cell
        // MICRO marks at the phenomena's exact sample cells. Emitted only when the
        // phen layer is ACTIVE (wx.phen is a defined array). An EMPTY WEATHER list
        // still emits count=0 so the machine renders the modern sparse micro-map
        // (and suppresses the legacy big glyph, so a CLEAR tile draws NOTHING); a
        // legacy caller (wx.phen undefined) appends nothing and stays byte-identical.
        // Reporter frames (opts.haz) carry NO phen.
        if (opts.haz) return p;
        const phen = opts.page === L.PAGE.PRESSURE ? wx.pressurePhen : wx.phen;
        const n = Math.min(phen.length, L.PHEN_MAX);
        p.push(n & 0xff);                        // [10] phen count (0..PHEN_MAX)
        for (let k = 0; k < n; k++)
          p.push(phen[k].x & 0xff, phen[k].y & 0xff, phen[k].code & 0xff);
        // FIRE NAME trailer (WEATHER fire tile only): after the phen triples, [nameRow,
        // nameLen, ...ZX codes]. nameRow is the caption's top cell row, hugging the flame.
        // Gated on the fire bit (byte6 0x20) so the machine reads it only for a fire tile;
        // a nameless fire / non-fire tile appends nothing (byte-identical).
        if (opts.page === L.PAGE.WEATHER && wx.fireMark && wx.fireName) {
          const codes = NHC.nameToZX(wx.fireName, 8);
          p.push((wx.fireNameRow | 0) & 0xff);
          p.push(codes.length & 0xff);
          for (let i = 0; i < codes.length; i++) p.push(codes[i] & 0xff);
        }
      }
    } else if (opts && opts.radar) {
      p.push((wx.isoByte | 0) & 0xff);
    }
    return p;
  }

  // --- BULLETIN V2 reporter wire (Phase-3 flip) -----------------------------
  // The v1 reporter frame (tilePayload above, paged) puts contour@6 / pageId@7 /
  // octant@8 / periph@9 — which COLLIDE with the compose2 mirror's emergency wire
  // (apparent@6 / snow@7 / fireLevel@8 / floodFlag@9). aggregate1 on the machine is
  // SHARED by 0xC8 (v1) and 0xC4 (v2); v1's do_compose ignores bytes 6-9 so the
  // collision is harmless there, but do_compose2 READS them — so under v2 the
  // reporter needs a DISTINCT, fixed-12-byte frame. This serializer emits exactly
  // that frame from a REFERENCE aggregate2 tile object (the same object report.js
  // compose2/aggregate2 consumes), so wire bytes and the JS reference are two views
  // of ONE source. Layout mirrors proof-reporter-compose2.quietTiles byte-for-byte:
  //   [0]temp [1]precipDesc(+bit3 dust) [2]cat [3]sea [4]wetBulb(degC,255=absent)
  //   [5]cyc [6]apparent(255=absent) [7]snow(cm,0=absent) [8]fireLevel [9]floodFlag
  //   [10]hazClass [11]hazVal [12]nightMin(overnight-low degC,255=absent), then a PBUF+13
  //   string trailer (cyclone press+name / fire name+country / flood place+country —
  //   mutually exclusive per tile). NOTE bytes 0-11 were full, so the hot-night overnight-low
  //   is a NEW fixed byte 12 (the frame widened 12->13); the trailer shifted PBUF+12 -> PBUF+13
  //   (byte-neutral in the Z80 mirror — same instruction, different constant offset).
  function tilePayloadV2(refT) {
    const t = refT || {};
    const dust = (t.weatherCode != null) && L.isDustStorm(t.weatherCode);
    const fog = (t.weatherCode != null) && L.isFog(t.weatherCode);
    const dustHaze = (t.weatherCode != null) && L.isDustHaze(t.weatherCode);
    let pd = (t.precipByte | 0) & 0xff;
    if (dust) pd |= 0x08;                              // dust rides byte1 bit3 (precip type stays 0)
    if (fog) pd |= 0x40;                               // fog rides byte1 bit6 (NOTABLE; precip type/band bits untouched)
    if (dustHaze) pd |= 0x80;                          // moderate dust/haze rides byte1 bit7 (NOTABLE; below the dust-storm ALERT)
    const ap = (t.apparentByte == null) ? 255 : (t.apparentByte & 0xff);
    const wb = (t.wetBulbByte == null) ? 255 : (t.wetBulbByte & 0xff);   // byte4 (was the unused wind placeholder)
    const sn = (t.snowByte == null) ? 0 : (t.snowByte & 0xff);
    const nb = (t.nightByte == null) ? 255 : (t.nightByte & 0xff);       // byte12 (overnight low; 255=absent)
    const fireLevel = (t.fireLevel | 0) & 0xff;
    const floodFlag = (t.floodFlag | 0) ? 1 : 0;
    const p = [
      (t.tempByte | 0) & 0xff, pd, (t.cat | 0) & 0xff, (t.seaState | 0) & 0xff,
      wb, (t.cycByte | 0) & 0xff, ap, sn, fireLevel, floodFlag,
      (t.hazClass | 0) & 0xff, (t.hazVal | 0) & 0xff, nb,
    ];
    // Trailer at PBUF+13, mutually exclusive (a tile is at most one of storm/fire/flood).
    const cycName = Array.isArray(t.cycName) ? t.cycName : [];
    if (cycName.length && t.cycPressByte != null) {
      p.push(t.cycPressByte & 0xff, cycName.length & 0xff);
      for (let i = 0; i < cycName.length; i++) p.push(cycName[i] & 0xff);
    } else if (fireLevel) {
      const nm = Array.isArray(t.fireName) ? t.fireName : [];
      const cc = Array.isArray(t.fireCountry) ? t.fireCountry : [];
      p.push(nm.length & 0xff); for (let i = 0; i < nm.length; i++) p.push(nm[i] & 0xff);
      p.push(cc.length & 0xff); for (let i = 0; i < cc.length; i++) p.push(cc[i] & 0xff);
    } else if (floodFlag) {
      const pl = Array.isArray(t.floodPlace) ? t.floodPlace : [];
      const cc = Array.isArray(t.floodCountry) ? t.floodCountry : [];
      p.push(pl.length & 0xff); for (let i = 0; i < pl.length; i++) p.push(pl[i] & 0xff);
      p.push(cc.length & 0xff); for (let i = 0; i < cc.length; i++) p.push(cc[i] & 0xff);
    }
    return p;
  }

  // --- contour (iso-line) layer (FS7-T3: isotherms/isobars/isotachs) ---------
  // A quantity's bands are a BETWEEN-tiles concept, but each machine holds only
  // its own sample — so the gateway (which sees the whole grid) computes, per
  // tile, a 4-bit edge mask flagging which of the tile's N/S/W/E edges crosses a
  // band boundary. Columns wrap (global longitude); the top/bottom rows have no
  // neighbour (poles) -> no line. `north` is the tile visually ABOVE on the 10x10
  // wall (row-1), matching the contour's y=0 top edge, so lines align across the
  // seam. `levelOf(tileIdx)` quantizes that tile's sample into its (<=4) band, or
  // null for a missing sample (-> no spurious line). Shared by
  // computeIsotherms/computeIsobars/computeIsotachs and contourFrames below.
  function computeContourEdges(weatherArr, gridN, levelOf) {
    const N = gridN || L.GRID;
    const edges = new Array(weatherArr.length).fill(0);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        const self = levelOf(i);
        const north = r > 0 ? levelOf((r - 1) * N + c) : null;
        const south = r < N - 1 ? levelOf((r + 1) * N + c) : null;
        const west = levelOf(r * N + ((c - 1 + N) % N));   // wrap longitude
        const east = levelOf(r * N + ((c + 1) % N));
        edges[i] = L.isothermEdges(self, north, south, west, east);
      }
    return edges;
  }
  // Isotherms (TEMP/RADAR pages): 4 temperature bands (byteToLevel). Sets
  // wx.isoByte on every tile.
  function computeIsotherms(weatherArr, gridN) {
    const levelOf = (t) => {
      const w = weatherArr[t];
      return (!w || w.tempC == null) ? null : L.byteToLevel(L.tempToByte(w.tempC));
    };
    const edges = computeContourEdges(weatherArr, gridN, levelOf);
    for (let i = 0; i < weatherArr.length; i++) if (weatherArr[i]) weatherArr[i].isoByte = edges[i];
    return weatherArr;
  }
  // Isobars (PRESSURE page): 4 MSL-pressure bands (L.pressBand). Sets
  // wx.pressIsoByte on every tile.
  function computeIsobars(weatherArr, gridN) {
    const levelOf = (t) => {
      const w = weatherArr[t];
      return (!w || w.pressureHpa == null) ? null : L.pressBand(w.pressureHpa);
    };
    const edges = computeContourEdges(weatherArr, gridN, levelOf);
    for (let i = 0; i < weatherArr.length; i++) if (weatherArr[i]) weatherArr[i].pressIsoByte = edges[i];
    return weatherArr;
  }
  // Smooth-temp within-tile gradient (TEMP page). Derives a per-tile signed level
  // gradient (gx8/gy8, 1/32-Lf16 per cell) from the CENTRE levels of the 4 neighbour
  // tiles — the same whole-grid quantity the isotherms use, so no new API fetches.
  // Column wraps (global longitude); a missing neighbour/edge falls back to self (no
  // gradient toward the gap). Sets wx.smoothGx/smoothGy on every tile. Values are the
  // 1/32-unit steps the machine accumulates: gx8 = (east-west)/2 over the 32-cell
  // width, gy8 = (south-north)*2/3 over the 24-cell height.
  function computeSmoothGrad(weatherArr, gridN) {
    const N = gridN || L.GRID;
    const lf = (t) => {
      const w = weatherArr[t];
      return (!w || w.tempC == null) ? null : L.tempToLevel16(L.tempToByte(w.tempC));
    };
    const clampB = (v) => { v = Math.round(v); return v < -128 ? -128 : v > 127 ? 127 : v; };
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        if (!weatherArr[i]) continue;
        const self = lf(i);
        if (self == null) { weatherArr[i].smoothGx = 0; weatherArr[i].smoothGy = 0; continue; }
        const north = r > 0 ? lf((r - 1) * N + c) : null;
        const south = r < N - 1 ? lf((r + 1) * N + c) : null;
        const west = lf(r * N + ((c - 1 + N) % N));   // wrap longitude
        const east = lf(r * N + ((c + 1) % N));
        const w = west == null ? self : west, e = east == null ? self : east;
        const n = north == null ? self : north, s = south == null ? self : south;
        weatherArr[i].smoothGx = clampB((e - w) / 2);
        weatherArr[i].smoothGy = clampB((s - n) * 2 / 3);
      }
    return weatherArr;
  }
  // Isotachs (WIND page): 4 wind-speed bands (L.windBand — the same bands the
  // WIND page's arrow strength already uses). Sets wx.windIsoByte on every tile.
  function computeIsotachs(weatherArr, gridN) {
    const levelOf = (t) => {
      const w = weatherArr[t];
      return (!w || w.windKmh == null) ? null : L.windBand(w.windKmh);
    };
    const edges = computeContourEdges(weatherArr, gridN, levelOf);
    for (let i = 0; i < weatherArr.length; i++) if (weatherArr[i]) weatherArr[i].windIsoByte = edges[i];
    return weatherArr;
  }

  // --- SATELLITE layer (FS7-T5): cloud-cover greyscale + day/night terminator ---
  // Two channels, no extra API call:
  //   * cloud density — wx.cloudLevel (0-3) from L.cloudLevel(cloud_cover%); the
  //     raw percent rides byte0 (repurposed on this page), so the machine bands it.
  //   * day/night — a REAL solar-position test per tile (L.isDaylight). Its edge
  //     mask REUSES the SAME computeContourEdges machinery as isotherms/isobars/
  //     isotachs: a terminator IS a contour, just over a 2-band field (night=1,
  //     day=0) instead of a 4-band one. wx.satIsoByte packs bits0-3 = terminator
  //     edges, bit4 = a night flag (the tile's OWN day/night state).
  // `latLonOf(tileIdx)` -> [lon, lat] is INJECTED (not computed here) so this
  // module stays decoupled from coastline.js — the same dependency-injection style
  // cycloneSubPoints/etc. already use. `epochMs` is INJECTED (DR-19): never
  // Date.now() internally, so the terminator is deterministic from a fixture time.
  function computeSatellite(weatherArr, gridN, latLonOf, epochMs) {
    const nightOf = (t) => {
      const w = weatherArr[t]; if (!w) return null;
      const ll = latLonOf(t); if (!ll) return null;
      return L.isDaylight(ll[1], ll[0], epochMs) ? 0 : 1;   // levelOf: 1 = night, 0 = day
    };
    const edges = computeContourEdges(weatherArr, gridN, nightOf);
    for (let i = 0; i < weatherArr.length; i++) {
      const w = weatherArr[i]; if (!w) continue;
      w.cloudLevel = L.cloudLevel(w.cloudCoverPct);
      const night = nightOf(i) === 1;
      w.satNight = night;
      w.satIsoByte = (edges[i] & 0x0f) | (night ? 0x10 : 0);   // satellite legacy byte6 path
      const row = (i / (gridN || L.GRID)) | 0;
      w.termByte = w.satIsoByte | (row >= (gridN || L.GRID) - 1 ? 0x20 : 0); // bit5: suppress Antarctic polar ice-zone glare on SATELLITE
    }
    return weatherArr;
  }

  // --- iso-line tape-loop (FS7-T3): the contour SHIFT over the last 12/24/48h.
  // Unlike a phenomena track (a handful of storm tiles), a contour band covers
  // the WHOLE globe, so re-rendering every tile for every PAST HOUR would blow the
  // duty-cycle budget (100 tiles x 48h is 48 full-wall bursts). Instead this
  // samples a small FIXED number of hours evenly spaced across the window (first
  // hour, now, and evenly between) — enough to see the bands visibly drift without
  // re-running the fleet 48x. `kind` selects which per-tile history array + band
  // function: 'temp' (isotherms/tempHist), 'press' (isobars/pressHist), 'wind'
  // (isotachs/windHist). Returns { frames: [{hour, edges}], hours }. edges[i] = 0
  // for a tile with no history yet (same as "no line"). Pure over weatherArr — no
  // fetch (the history rides the SAME batched call; see src/weather.js).
  function levelAtHour(rec, h, H, kind) {
    if (!rec) return null;
    const hist = kind === 'temp' ? rec.tempHist : kind === 'press' ? rec.pressHist : rec.windHist;
    if (!hist || !hist.length) return null;
    const n = hist.length, i = n - H + h;
    if (i < 0 || i >= n || hist[i] == null) return null;
    if (kind === 'temp') return L.byteToLevel(L.tempToByte(hist[i]));
    if (kind === 'press') return L.pressBand(hist[i]);
    return L.windBand(hist[i]);
  }
  function contourFrames(weatherArr, gridN, spanH, frameCount, kind) {
    const N = gridN || L.GRID;
    const H = spanH | 0, F = Math.max(1, frameCount | 0);
    const hours = [];
    for (let k = 0; k < F; k++)
      hours.push(F === 1 ? H - 1 : Math.round((k * (H - 1)) / (F - 1)));
    const frames = hours.map((h) => ({
      hour: h,
      edges: computeContourEdges(weatherArr, N, (t) => levelAtHour(weatherArr[t], h, H, kind)),
    }));
    return { frames, hours };
  }

  // --- phenomena TRACKS tape-loop (FS7-T9): 12/24/48h of storm MOTION ----------
  // The contour tape-loop (contourFrames) drifts a whole-globe band; a phenomenon
  // TRACK instead follows a handful of STORM tiles. From each sea sample's hourly
  // gust/pressure HISTORY (src/weather.js opts.history, newest-last) the gateway
  // RE-RUNS the SAME cyclone signature (L.cycloneTier + the quincunx tie-break) at
  // every past hour of the window and builds one frame per hour. Frame f
  // (0 = window start .. H-1 = now) shows the hour-f detection as the HEAD and every
  // earlier detection as a fading TRAIL:
  //   * HEAD (age 0): tier>=CYCLONE -> the 2x2 cyclone MARK, riding the cyclone byte
  //     (byte5 — the spiral channel); tier 1 (STORM) -> the inverse-'+' STORM micro,
  //     riding the phen[] list. The cell is the tile centre OR the winning quincunx
  //     sub-sample — SAME tie-break as detectCyclones (strictly higher tier, or equal
  //     tier + stronger gust), so the head lands at the MOST INTENSE cell.
  //   * TRAIL (age>0): a fading one-cell MICRO mark at the past detection's cell —
  //     grey checker (GL.TRAIL.NEAR) within NEAR_HOURS, a bare dot (GL.TRAIL.FAR)
  //     beyond — riding the phen[] list.
  //
  // WIRE RECONCILIATION (current main): a tile frame is TIER-GATED (listener
  // parsetrailer) — a tier>=CYCLONE tile carries the FS2 name/pressure trailer and
  // NEVER a phen list. So a CYCLONE/MAJOR head rides the cyclone byte ALONE (its own
  // older trail cells are subsumed by the spiral head, dropped that frame); every
  // NON-head tile (cyc 0) carries its STORM head + trail marks on the ordinary phen
  // wire. Track + trail thus ride the EXISTING byte5 (cyclone) + phen[] wire — ZERO
  // wire/Z80/texture change. Returns { frames:[{tiles:{tileIdx:{phen,cyc}}}], affected }.
  //
  // DETERMINISM (DR-19): pure over weatherArr — the history rides the SAME batched
  // call; never a live fetch, never a clock. DUTY CYCLE: the browser burst-renders
  // one frame-tile per affected tile per hour ONCE, then replays cached canvases
  // (machines frozen, zero extra API calls). Affected tiles stay sparse (only storm
  // tiles), so H frames never approach the whole-globe cost contourFrames guards.
  function trackFrames(weatherArr, seaIdx, subPts, subResults, spanH) {
    const N = L.GRID;
    const H = spanH | 0;
    // history sample at window-hour h (window covers the last H past hours,
    // newest-last, so hour h maps to array index n - H + h).
    const sampleTier = (rec, h) => {
      if (!rec || !rec.gustHist || !rec.pressHist) return 0;
      const n = Math.min(rec.gustHist.length, rec.pressHist.length);
      const i = n - H + h;
      if (i < 0 || i >= n) return 0;
      return L.cycloneTier(rec.gustHist[i], rec.pressHist[i]);
    };
    const gustAt = (rec, h) => {
      if (!rec || !rec.gustHist) return 0;
      const n = rec.gustHist.length, i = n - H + h;
      return (i >= 0 && i < n) ? (rec.gustHist[i] || 0) : 0;
    };
    // dets[h] -> [{tile, pos, tier}] : the winning detection on each storm tile at
    // hour h (same centre-vs-sub tie-break as detectCyclones).
    const dets = [];
    for (let h = 0; h < H; h++) dets.push([]);
    const pts = subPts || [], res = subResults || [];
    for (const i of seaIdx) {
      for (let h = 0; h < H; h++) {
        let best = sampleTier(weatherArr[i], h), bestGust = gustAt(weatherArr[i], h), pos = L.SUB.CENTER;
        for (let s = 0; s < pts.length; s++) {
          if (pts[s].tileIdx !== i) continue;
          const t = sampleTier(res[s], h), gd = gustAt(res[s], h);
          if (t > best || (t > 0 && t === best && gd > bestGust)) { best = t; bestGust = gd; pos = pts[s].pos; }
        }
        if (best >= L.CYC.STORM) dets[h].push({ tile: i, pos, tier: best });
      }
    }
    // NEWEST-frame live-detection merge (owner 2026-07-24: the storm must appear on every
    // loop): the per-hour SIGNATURE re-detection can miss a real named storm whose eye
    // sits between samples (a ~500 km eyewall between the centre and the quincunx —
    // Fausto 2026-07-24), while the LIVE map detects it (NHC-matched). The live
    // detection is the truth for hour H-1 (it IS the current hour), so inject it as
    // that frame's head when the history scan missed the tile. Older frames stay
    // purely signature-based — a storm the archive can't see is honestly absent there.
    if (H > 0) {
      const last = dets[H - 1];
      for (const i of seaIdx) {
        const w = weatherArr[i];
        if (!w || (w.cycloneTier | 0) < L.CYC.STORM) continue;
        if (!last.some((d) => d.tile === i))
          last.push({ tile: i, pos: w.cyclonePos | 0, tier: w.cycloneTier | 0 });
      }
    }
    const affected = new Set();
    for (const hd of dets) for (const d of hd) affected.add(d.tile);
    const frames = [];
    for (let f = 0; f < H; f++) {
      const tiles = {};
      for (const t of affected) tiles[t] = { marks: {}, cyc: 0, cycHead: false };
      for (let g = 0; g <= f; g++) {
        const age = f - g;
        for (const d of dets[g]) {
          const c = GL.SUB_CELL[d.pos] || GL.SUB_CELL[0];
          const e = tiles[d.tile];
          if (age === 0 && d.tier >= L.CYC.CYCLONE) {
            // HEAD as the cyclone MARK (byte5). The wire's tier gate means this tile
            // carries no phen this frame, so its own older trail cells are subsumed by
            // the spiral head (phen dropped below). Hemisphere from the tile row.
            e.cyc = L.cycloneToByte(d.tier, d.pos, Math.floor(d.tile / N) >= (N >> 1) ? 1 : 0, 0);
            e.cycHead = true;
          } else {
            const code = age === 0 ? GL.MICRO.STORM : GL.trailCode(age);
            const key = c[0] + ',' + c[1];
            const cur = e.marks[key];
            if (!cur || age < cur.age) e.marks[key] = { x: c[0], y: c[1], code, age };
          }
        }
      }
      for (const t in tiles) {
        const e = tiles[t];
        // a cyclone-head tile rides byte5 alone (mutual-exclusive wire) -> no phen.
        if (e.cycHead) { tiles[t] = { phen: [], cyc: e.cyc }; continue; }
        // base phenomena (up to 3, leaving room), then the trail marks newest-first —
        // the PHEN_MAX cap drops the OLDEST trail cells when it binds.
        const base = (weatherArr[t] && Array.isArray(weatherArr[t].phen)) ? weatherArr[t].phen.slice(0, 3) : [];
        const trail = Object.keys(e.marks).map((k) => e.marks[k])
          .sort((a, b) => a.age - b.age)
          .map((m) => ({ x: m.x, y: m.y, code: m.code }));
        tiles[t] = { phen: base.concat(trail).slice(0, L.PHEN_MAX), cyc: 0 };
      }
      frames.push({ tiles });
    }
    return { frames, affected };
  }

  // --- cyclone-signature sub-tile sampling -------------------------------
  // A ~500 km storm core can slip between the wall's ~36deg-wide, 1-sample-per-
  // tile grid. So on SEA tiles we add extra forecast sample points (a quincunx
  // minus the centre: 4 corners at +/-1/4 tile) used ONLY for cyclone detection.
  // The tile-centre sample already comes from the base forecast, giving a full
  // 5-point quincunx per sea tile. Offsets are fractions of a tile (lon 36deg,
  // lat 18deg); geographic NW (west+north) maps to the tile's top-left cell.
  const SUBTILE = [
    { pos: L.SUB.NW, fLon: -0.25, fLat: +0.25 },
    { pos: L.SUB.NE, fLon: +0.25, fLat: +0.25 },
    { pos: L.SUB.SW, fLon: -0.25, fLat: -0.25 },
    { pos: L.SUB.SE, fLon: +0.25, fLat: -0.25 },
  ];
  function wrapLon(lon) { let x = ((lon + 180) % 360 + 360) % 360 - 180; return x; }
  function clampLat(lat) { return lat > 89.9 ? 89.9 : (lat < -89.9 ? -89.9 : lat); }

  // Build the sub-tile sample coords for an arbitrary tile-index set. tileWdeg/
  // tileHdeg default to a 10x10 grid (36 x 18 deg). Returns
  // { subPts:[{tileIdx,pos,lat,lon}], subCoords:[{lat,lon}] } — subCoords is what
  // gets appended to the SAME batched forecast call. The quincunx is the 4 CORNERS
  // (+/-1/4 tile); the CENTRE sample already comes from the base forecast.
  function subPointsFor(idxArr, coordArr, tileWdeg, tileHdeg) {
    const W = tileWdeg == null ? 360 / L.GRID : tileWdeg;
    const H = tileHdeg == null ? 180 / L.GRID : tileHdeg;
    const subPts = [], subCoords = [];
    for (let k = 0; k < idxArr.length; k++) {
      const c = coordArr[k];
      for (let s = 0; s < SUBTILE.length; s++) {
        const o = SUBTILE[s];
        const lat = clampLat(c.lat + o.fLat * H), lon = wrapLon(c.lon + o.fLon * W);
        subPts.push({ tileIdx: idxArr[k], pos: o.pos, lat, lon });
        subCoords.push({ lat, lon });
      }
    }
    return { subPts, subCoords };
  }
  // Sea-only sub-points, fed to cyclone detection (UNCHANGED behaviour — a thin
  // wrapper over the shared generator so the sea-tile output stays byte-identical).
  function cycloneSubPoints(seaIdx, seaCoords, tileWdeg, tileHdeg) {
    return subPointsFor(seaIdx, seaCoords, tileWdeg, tileHdeg);
  }
  // DR-20 (FS7-T11): the SAME quincunx generator, but over ALL tiles/categories
  // (land AND sea) rather than sea-only. This is what lets computePhenomena place a
  // phenomenon mark at each GENUINE sub-tile sample position on ANY tile, not just
  // the tile centre. Output shape is byte-identical to cycloneSubPoints
  // ({ subPts:[{tileIdx,pos,lat,lon}], subCoords }); over the sea subset it returns
  // exactly what cycloneSubPoints returns. DORMANT capability: the live all-tile
  // quincunx forecast request is operator-owned (gated on lifting the DR-19 freeze);
  // today it is exercised FIXTURE-ONLY (data/multisample-fixture.json) — see
  // tools/proof-multisample.js. It never fetches; callers supply the coords.
  function phenomenaSubPoints(allIdx, coords, tileWdeg, tileHdeg) {
    return subPointsFor(allIdx, coords, tileWdeg, tileHdeg);
  }

  // Fold cyclone detection onto the per-tile weather array. For each sea tile we
  // evaluate the centre sample (already in weatherArr, from the base forecast)
  // plus its sub-tile samples, take the STRONGEST tier, and record the sub-tile
  // position of the triggering sample. Ties break to the strongest gust. Missing
  // gust/pressure -> tier 0 (never a false cyclone). Sets wx.cycloneTier +
  // wx.cyclonePos (0/CENTER when none). subResults aligns 1:1 with subPts and
  // each carries { gustKmh, pressureHpa } (as parsed by src/weather.js).
  // Cap on simultaneously-ANIMATED cyclone tiles: an extreme-weather day could
  // light up many cyclones at once, and each animated tile keeps its machine
  // running (burst budget). We animate the strongest ANIM_CAP (highest tier, then
  // strongest gust); the rest fall back to the static stamp. See PROTOCOL.md.
  const ANIM_CAP = 8;

  // --- FS2 §C.2 spiral-gate: NHC storm match (great-circle <= 500 km) ---------
  // The tropical spiral is KEPT for a poleward detection only if a real NHC-named
  // system sits within ~500 km of the triggering sample (else the display would
  // contradict the latitude-aware WIRE BULLETIN). With an empty feed this returns
  // null (M1 behavior); T7 feeds the real NHC storm list in. Storms carry NHC
  // field names {latitudeNumeric, longitudeNumeric}; .lat/.lon are tolerated too.
  const NHC_MATCH_KM = 500;
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function matchNhcStorm(lat, lon, nhcStorms) {
    if (!nhcStorms || !nhcStorms.length || lat == null || lon == null) return null;
    for (let i = 0; i < nhcStorms.length; i++) {
      const s = nhcStorms[i]; if (!s) continue;
      const sLat = s.latitudeNumeric != null ? s.latitudeNumeric : s.lat;
      const sLon = s.longitudeNumeric != null ? s.longitudeNumeric : s.lon;
      if (sLat == null || sLon == null) continue;
      if (haversineKm(lat, lon, +sLat, +sLon) <= NHC_MATCH_KM) return s;
    }
    return null;
  }

  // Sub-tile quadrant (one of L.SUB NW/NE/SW/SE) for an authority storm's exact
  // lat/lon within its tile — so the forced eye stamp draws at the storm's real
  // quarter-tile position rather than always the tile centre. Longitude wraps.
  function subCellForOffset(lat, lon, row, col) {
    const tileLat = 81 - 18 * row, tileLon = -162 + 36 * col;
    let dLon = lon - tileLon; if (dLon > 180) dLon -= 360; if (dLon < -180) dLon += 360;
    const north = (lat - tileLat) >= 0, east = dLon >= 0;
    return north ? (east ? L.SUB.NE : L.SUB.NW) : (east ? L.SUB.SE : L.SUB.SW);
  }

  function detectCyclones(weatherArr, seaIdx, subPts, subResults, gridN, nhcStorms) {
    const N = gridN || L.GRID;
    nhcStorms = nhcStorms || [];
    // seed every sea tile from its centre sample. Also track the TRIGGERING
    // sample's lat/lon/pressure (§C.2 gate + §C.3 pressure trailer): the centre
    // to start, then whichever sub-tile wins overwrites it.
    const best = {}; // tileIdx -> {tier,pos,gust,lat,lon,press}
    for (let k = 0; k < seaIdx.length; k++) {
      const i = seaIdx[k], w = weatherArr[i] || {};
      best[i] = {
        tier: L.cycloneTier(w.gustKmh, w.pressureHpa), pos: L.SUB.CENTER, gust: w.gustKmh || 0,
        lat: 81 - 18 * Math.floor(i / N), lon: -162 + 36 * (i % N),
        press: w.pressureHpa == null ? null : w.pressureHpa,
      };
    }
    // fold in each sub-tile sample
    for (let s = 0; s < subPts.length; s++) {
      const p = subPts[s], r = subResults[s] || {};
      const b = best[p.tileIdx];
      if (!b) continue;
      const tier = L.cycloneTier(r.gustKmh, r.pressureHpa);
      const gust = r.gustKmh || 0;
      if (tier > b.tier || (tier > 0 && tier === b.tier && gust > b.gust)) {
        b.tier = tier; b.pos = p.pos; b.gust = gust;
        b.lat = p.lat; b.lon = p.lon; b.press = r.pressureHpa == null ? null : r.pressureHpa;
      }
    }
    // --- Authority-forced detections (FS11 JTWC merge) ----------------------
    // A JTWC-named system (source:'jtwc', forced:true) is the AUTHORITY for a
    // W-Pac / Indian / S-Hemisphere tropical cyclone that our own coarse tile
    // sampling MISSES — a ~500 km typhoon core slips between the 36deg-wide tile
    // centres (the documented Douglas-class miss mode). So we seed a detection at
    // the storm's OFFICIAL position. The tier is the storm's OWN (gust,pressure)
    // run through the SAME cycloneTier() the sampler uses (no parallel scale),
    // FLOORED at CYCLONE when the authority classifies it typhoon-strength (a
    // "Typhoon" warning is >= 64 kt sustained by definition — stronger evidence
    // than our gust proxy). Honesty: authority classification can only RAISE the
    // spiral to typhoon strength, and measured gust+pressure can UPGRADE it to
    // MAJOR — it never fabricates a tier above the evidence. Since 2026-07-28 NHC
    // storms carry forced:true too (src/nhc.js): the identical miss mode hit the
    // E-Pac — Fausto and Genevieve, both live hurricanes, drew nothing because
    // their nearest tile centres sampled fair weather ~2,000 km from the eye.
    // Double-draw: the feeds are basin-disjoint except the CPHC/JTWC seam at 180W,
    // and two FORCED records for one physical storm are deduped by
    // same-name-within-500km (the task's "one storm" guard) — the first injection
    // stands, later duplicates skip.
    const injectedForced = [];
    for (let si = 0; si < nhcStorms.length; si++) {
      const st = nhcStorms[si];
      if (!st || !st.forced) continue;
      const sLat = st.latitudeNumeric != null ? +st.latitudeNumeric
        : (st.lat != null ? +st.lat : null);
      const sLon = st.longitudeNumeric != null ? +st.longitudeNumeric
        : (st.lon != null ? +st.lon : null);
      if (sLat == null || sLon == null || !Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;
      let dup = false;
      for (let dj = 0; dj < injectedForced.length; dj++) {
        const o = injectedForced[dj];
        if (String(o.name || '').toUpperCase() === String(st.name || '').toUpperCase()
          && haversineKm(sLat, sLon, o.lat, o.lon) <= NHC_MATCH_KM) { dup = true; break; }
      }
      if (dup) continue;
      // Map the official position to a tile. Cyclones ride the SEA layer, so a
      // storm whose nearest tile-centre is LAND (rare: at/after landfall) is not
      // injected — the spiral is a sub-tile ocean stamp (documented limitation).
      const row = Math.max(0, Math.min(N - 1, Math.round((81 - sLat) / 18)));
      const col = ((Math.round((sLon + 162) / 36) % N) + N) % N;
      const b = best[row * N + col];
      if (!b) continue;   // land tile (not in seaIdx) -> no injection (see above)
      // Tier: authority (gust,pressure) via the SAME detector, floored at CYCLONE
      // for a typhoon-strength classification. Sub-typhoon TS/TD (floor 0, no
      // pressure-backed CYCLONE) draws no forced spiral — a dedicated TS/TD comma
      // glyph is future work; the reported gap was the named TYPHOONS.
      const measured = L.cycloneTier(st.gustKmh != null ? st.gustKmh : null,
        st.pressureMb != null ? st.pressureMb : null);
      // JTWC spells the class out ("Typhoon"); NHC's CurrentStorms.json abbreviates
      // ("HU" hurricane, "MH" major hurricane). Both mean >=64kt sustained by definition.
      const cls = String(st.classification || '').toUpperCase();
      const floor = (/TYPHOON|HURRICANE|TROPICAL CYCLONE/.test(cls) || cls === 'HU' || cls === 'MH')
        ? L.CYC.CYCLONE : 0;
      const tier = Math.max(measured, floor);
      if (tier < L.CYC.CYCLONE) continue;
      // Inject iff the authority tier is >= our sampled tier here: re-anchor the
      // eye/name/pressure to the OFFICIAL position (so matchNhcStorm names it and
      // the official pressure wins the trailer). A genuinely stronger local sample
      // keeps its own eye (max, never downgrade).
      if (tier >= b.tier) {
        b.tier = tier;
        b.gust = st.gustKmh != null ? st.gustKmh : b.gust;
        b.lat = sLat; b.lon = sLon;
        b.press = st.pressureMb != null ? st.pressureMb : b.press;
        b.pos = subCellForOffset(sLat, sLon, row, col);
        injectedForced.push({ name: st.name, lat: sLat, lon: sLon });   // one storm, one spiral
      }
    }
    // pick the animated set: strongest CYCLONE+ tiles, capped at ANIM_CAP.
    const animated = seaIdx
      .filter((i) => best[i].tier >= L.CYC.CYCLONE)
      .sort((a, c) => best[c].tier - best[a].tier || best[c].gust - best[a].gust)
      .slice(0, ANIM_CAP);
    const animSet = new Set(animated);
    // write results back
    for (let k = 0; k < seaIdx.length; k++) {
      const i = seaIdx[k], b = best[i];
      const w = weatherArr[i]; if (!w) continue;
      w.cycloneTier = b.tier;
      w.cyclonePos = b.tier >= L.CYC.CYCLONE ? b.pos : L.SUB.CENTER;
      w.cycloneGust = b.gust;    // the triggering (eyewall) gust — sizes the periphery
                                 // even when the eye is offset between tile centres
      // hemisphere from the tile row: rows 0..N/2-1 are north (grid spans +90..-90),
      // so the spiral rotates CCW up top and CW down south (Coriolis). Derived, not
      // transmitted as extra payload — it rides a spare bit of the cyclone byte.
      w.cycloneSouth = b.tier >= L.CYC.CYCLONE ? (Math.floor(i / N) >= (N >> 1) ? 1 : 0) : 0;
      w.cycloneAnim = animSet.has(i) ? 1 : 0;
      // FS2 §C.2/§C.3: retain the triggering sample's pressure/lat/lon and compute
      // the spiral-gate SUPPRESS bit. The tropical spiral is KEPT iff an NHC storm
      // matches within 500 km of the TRIGGERING position OR the tile is in the
      // tropics; else SUPPRESS. Tier and the wire bulletin are UNCHANGED — only the
      // on-screen spiral is gated so the DISPLAY matches the latitude-aware WIRE
      // BULLETIN (the honesty invariant). The |lat|<30 tropics test uses the
      // TILE-CENTRE latitude (REP.tileLat) — the SAME basis as the bulletin oracle
      // report.js cycKindOf — so the display gate agrees with the wire tile-for-tile
      // (§5 / §D.4). cycloneLat/Lon retain the TRIGGERING sample position (eye/name/
      // pressure trailer + the NHC haversine match), which can differ from centre.
      if (b.tier >= L.CYC.CYCLONE) {
        // Match the NHC feed ONCE per detected cyclone tile and reuse the result
        // for the spiral gate, the name attach, and the pressure precedence.
        const matched = matchNhcStorm(b.lat, b.lon, nhcStorms);   // storm object or null
        w.cycloneLat = b.lat;
        w.cycloneLon = b.lon;
        // Spiral gate (§C.2): KEEP the spiral iff an NHC system matches within 500 km
        // OR the tile centre is in the tropics; else SUPPRESS. Logic UNCHANGED from T3.
        w.cycloneSuppress =
          (matched || Math.abs(REP.tileLat(i)) < REP.TROPICS_LAT) ? 0 : 1;
        // FS2 §C.5 NAME: attach the raw NHC name (uppercased) when matched; UNNAMED
        // (null) for W-Pac/Indian/no-NHC-coverage detections — never faked. T8/T9/T10
        // transcode the raw name to ZX81 codes on the render/reporter side.
        w.cycloneNhcMatched = matched ? 1 : 0;
        w.cycloneName = matched && matched.name ? String(matched.name).toUpperCase() : null;
        // FS2 §C.3 PRESSURE PRECEDENCE: the NHC official minimum pressure when matched,
        // else the already-retained sampled MSL from the triggering sub-tile (b.press).
        w.cyclonePressureHpa = (matched && matched.pressureMb != null) ? matched.pressureMb : b.press;
      } else {
        w.cycloneSuppress = 0;
      }
    }
    return best;
  }

  // --- FS7 micro-phenomena layer ------------------------------------------
  // Build each tile's phen list from the ACTUAL sample coordinates: a tile-centre
  // mark at (16,12) from the base forecast's weather code, PLUS — on sea tiles —
  // each sub-tile sample (the SAME quincunx subPts/subResults used for cyclone
  // detection) at its own SUB_CELL when that sample carries a mappable phenomenon.
  // Only real phenomena get a mark (CAT >= FOG via MICRO_CAT); CLEAR/CLOUD map to
  // 0 and stay unmarked, so the map is SPARSE. Sets wx.phen = [{x,y,code}] on
  // EVERY tile (an empty array is meaningful — it flags the tile's phen layer as
  // active so tilePayload emits the modern micro-map frame; see the mutual-
  // exclusivity rule there).
  //
  // DR-20 (FS7-T11): the sub-sample loop below now serves ALL tiles/categories
  // (fed by phenomenaSubPoints, not just the sea-only cycloneSubPoints), so a tile
  // that GENUINELY carries several distinct sub-tile phenomena renders several marks
  // at their real sub-tile positions ("quincunx" multi-point sampling).
  // HONEST DEGRADE (RISK-4, non-negotiable): a mark is placed ONLY where the DATA
  // genuinely carries a distinct phenomenon. A sub-sample that is CLEAR/CLOUD
  // (code 0) or that merely DUPLICATES the tile-centre's category adds NO mark — we
  // never interpolate/fabricate a phenomenon position from a single sample. So a
  // tile with only its centre sample keeps EXACTLY ONE centre glyph; multiples appear
  // only where the fixture (or, later, the live all-tile forecast) supplies distinct
  // sub-tile samples.
  //
  // M1 (thunder-blink) — HONEST LIMITATION, documented not faked: a sub-tile THUNDER
  // mark on a NON-thunder centre tile renders as a STATIC bolt (0x98). The on-machine
  // blink anim is gated on the tile-CENTRE category byte (byte2), so it fires only
  // when the centre is THUNDER; a sub-sample bolt does not drive it. No new wire/Z80
  // machinery is introduced for this (out of scope); proof-multisample asserts the
  // static behaviour on the real Z80.
  // opts.topSet (FS7-T7, WEATHER front page): when given, a Set of tile indices
  // — only THOSE tiles get a mark; every other tile's real phenomenon is silently
  // dropped (computeImportance already ranked it below FRONT_CAP). Omitted/
  // undefined -> unfiltered, i.e. IDENTICAL to every prior caller/proof (the
  // default behaviour is unchanged; front-page capping is strictly opt-in).
  function computePhenomena(weatherArr, subPts, subResults, topSet) {
    subPts = subPts || []; subResults = subResults || [];
    const CX = GL.SUB_CELL[0][0], CY = GL.SUB_CELL[0][1];   // tile centre (16,12)
    const curated = !!topSet;
    for (let t = 0; t < weatherArr.length; t++) {
      const w = weatherArr[t]; if (!w) continue;
      w.phen = [];
      if (curated && !showSouthernWeather(w, t)) continue;   // suppress ordinary AN/SO cloud/clear/light snow clutter
      if (curated && !topSet.has(t)) continue;               // capped out -> no mark
      const code = GL.MICRO_CAT[L.weatherCodeToCat(w.weatherCode || 0)];
      if (code) w.phen.push({ x: CX, y: CY, code });         // tile-centre mark
    }
    // sub-tile samples -> one mark each at its exact SUB_CELL (never CENTER — the
    // SUBTILE quincunx is the 4 corners; the centre came from the base fetch).
    for (let s = 0; s < subPts.length; s++) {
      const p = subPts[s], r = subResults[s] || {};
      if (curated && !showSouthernWeather(r, p.tileIdx)) continue; // no ordinary AN/SO sub-sample clutter either
      if (curated && !topSet.has(p.tileIdx)) continue;       // capped out -> no mark
      const w = weatherArr[p.tileIdx]; if (!w || !w.phen) continue;
      const code = GL.MICRO_CAT[L.weatherCodeToCat(r.weatherCode || 0)];
      if (!code) continue;                                   // CLEAR/CLOUD sub-sample -> no mark (sparse)
      // HONEST DEGRADE: a sub-sample that duplicates the tile-centre category adds no
      // new information -> never manufacture a redundant/phantom mark.
      const centreCode = GL.MICRO_CAT[L.weatherCodeToCat(w.weatherCode || 0)];
      if (code === centreCode) continue;                     // duplicates centre -> no mark
      const c = GL.SUB_CELL[p.pos] || GL.SUB_CELL[0];
      if (w.phen.length < L.PHEN_MAX) w.phen.push({ x: c[0], y: c[1], code });
    }
    return weatherArr;
  }

  // --- WEATHER tab FRONT PAGE (FS7-T7) -------------------------------------
  // The front page is a BASIC-rendered broadcast board: visible weather across
  // populated/major regions first, then global severity, with ordinary AN/SO
  // ambiguity suppressed and Southern Ocean hazards retained.
  // WEATHER-summary bounds now live in the GOVERNING SPEC (src/tab-spec.js), not as
  // ad-hoc constants here. FRONT_CAP/FRONT_MIN are the spec's global cap/floor; the
  // per-category sub-caps that used to be hand-tuned in canUse() are the spec's
  // CATEGORY_CAPS, mapped from this page's kinds. owner's "9 marks worldwide" was the
  // old perBucket>=2 / HIGH+LOW>=2 throttles strangling the count long before FRONT_CAP;
  // the spec replaces them with explicit per-category counts so the summary is rich but
  // bounded and never a single-category wall. (Fallbacks keep gateway loadable if the
  // spec is somehow absent.)
  const FRONT_CAP = SPEC ? SPEC.CAP_TOTAL : 40;
  const FRONT_MIN = SPEC ? SPEC.FLOOR_TOTAL : 24;
  // front-page candidate kind -> spec mark category (fires/cyclones/alerts ride other
  // channels; here only these six kinds are produced).
  const KIND_TO_CAT = { WX: 'PRECIP', GALE: 'WIND', HOT: 'HEAT', COLD: 'COLD', HIGH: 'HIGH', LOW: 'LOW' };
  const CAT_CAPS = (SPEC && SPEC.CATEGORY_CAPS) || {};
  const BUCKET_SPREAD_CAP = 8;   // keep some geographic spread; category caps do the real bounding
  const CAT_SCORE = [0, 0, 2, 3, 4, 5, 6]; // CLEAR,CLOUD,FOG,DRIZZLE,RAIN,SNOW,THUNDER
  function southernDomain(tileIdx) { return ((tileIdx / L.GRID) | 0) >= 7; } // ~45S and poleward: SO/AN
  function antarcticRow(tileIdx) { return ((tileIdx / L.GRID) | 0) >= 9; }   // coarse wall row centred ~81S
  function navHazard(w) {
    if (!w) return false;
    const gust = w.gustKmh == null ? (w.windKmh || 0) : w.gustKmh;
    const sea = L.waveToSeaState(w.waveHeight);
    return sea === L.SEA.HIGH || sea === L.SEA.STORM || gust >= 70 || (w.windKmh || 0) >= 55 ||
      L.weatherCodeToCat(w.weatherCode || 0) === L.CAT.THUNDER;
  }
  function antarcticInterest(w) {
    if (!w) return false;
    const cat = L.weatherCodeToCat(w.weatherCode || 0);
    const precip = w.precipMm || 0;
    const gust = w.gustKmh == null ? (w.windKmh || 0) : w.gustKmh;
    return cat === L.CAT.THUNDER || precip >= 1 || gust >= 90 || (w.windKmh || 0) >= 70;
  }
  function showSouthernWeather(w, tileIdx) {
    if (!southernDomain(tileIdx)) return true;
    return antarcticRow(tileIdx) ? antarcticInterest(w) : navHazard(w);
  }
  // WEATHER front-page symbols are deliberately non-textual. 1950s TV weather
  // maps used simple graphical marks; letters like H/L already mean pressure.
  // Each symbol is a sparse 7x7 pictogram of ZX81 inverse solid cells, capped at
  // PHEN_MAX and stamped by the machine renderer. These are intentionally larger
  // than the earlier 4x4 marks so visual QA is based on human readability.
  const ICON4 = {
    RAIN:    ['1000000','0100000','0010000','0001000','1000100','0100010','0010001'], // slanted rain streaks
    DRIZZLE: ['1000000','0001000','0000001','0100000','0000100','0000000','0010000'], // sparse drops
    SNOW:    ['0001000','1001001','0101010','0010100','0101010','1001001','0001000'], // radial snowflake/star
    THUNDER: ['0001000','0011000','0110000','0011000','0001100','0001000','0010000'], // lightning bolt
    FOG:     ['1111110','0000000','0111110','0000000','0111110','0000000','0000000'], // fog bars
    GALE:    ['0011100','0100010','0011100','0000000','0011100','0100010','0011100'], // wave curls
    HEAT:    ['1010100','0101010','1010100','0000000','0101010','1010100','0000000'], // heat shimmer
    COLD:    ['0010100','1001001','0100010','0010100','0100010','1001001','0010100'], // frost texture
    FIRE:    ['0001000','0011000','0010100','0110010','0100110','1101100','0111100'], // small flame
    FLOOD:   ['0000000','1101100','0010011','0000000','1101100','0010011','0000000'], // wave lines
    HIGH:    ['1001','1001','1001','1111','1001','1001','1001'], // conventional pressure H (16 ink cells = PHEN_MAX-safe)
    LOW:     ['1000','1000','1000','1000','1000','1000','1111'], // conventional pressure L
  };
  // Animated wildfire icon (7x7): the FLAME cells are solid ink (0x80) and the base
  // EMBER cells are grey mosaic (0x08). On odd render phases the machine/oracle clear
  // the ink bit (0x80 -> 0x00 = gone) but 0x08 is bit7-clear so it persists — so the
  // flame FLARES UP (even phase) then dies to a glowing ember base (odd phase). Pure
  // on-machine flicker via the EXISTING stampphen bit7 toggle — no Z80 change. The
  // caller free-runs a fire tile 2 phases (like the thunder blink). '1'=flame '2'=ember.
  const FIRE_ANIM = [
    '0001000', '0011000', '0010100', '0110010', '0100100', '0011100', '0001000',
  ];
  function addFireIcon(w, x, y) {
    for (let r = 0; r < FIRE_ANIM.length; r++)
      for (let c = 0; c < FIRE_ANIM[r].length; c++) {
        const ch = FIRE_ANIM[r][c];
        if (ch === '0' || w.phen.length >= L.PHEN_MAX) continue;
        w.phen.push({ x: x + c, y: y + r, code: r >= 5 ? 0x08 : 0x80 });   // rows 5-6 = ember
      }
  }
  function addIcon(w, kind, x, y) {
    const rows = ICON4[kind] || [];
    const cells = [];
    for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < rows[r].length; c++)
        if (rows[r][c] === '1') cells.push({ x: x + c, y: y + r, code: 0x80 });
    if (!cells.length) return;
    const room = Math.max(0, L.PHEN_MAX - w.phen.length);
    if (cells.length <= room) { for (const cell of cells) w.phen.push(cell); return; }
    // Keep an over-budget pictogram readable under the PHEN_MAX wire budget by
    // sampling its full 7x7 extent rather than truncating the top rows. The mark is
    // still entirely machine-rendered; the host only chooses which cells to send.
    for (let i = 0; i < room; i++) {
      const idx = Math.round(i * (cells.length - 1) / Math.max(1, room - 1));
      w.phen.push(cells[idx]);
    }
  }
  function addKindIcon(w, kind) {
    if (kind === 'HOT') { addIcon(w, 'HEAT', 14, 10); return true; }
    if (kind === 'COLD') { addIcon(w, 'COLD', 14, 10); return true; }
    if (kind === 'GALE') { addIcon(w, 'GALE', 14, 10); return true; }
    if (kind === 'HIGH') { addIcon(w, 'HIGH', 14, 10); return true; }
    if (kind === 'LOW') { addIcon(w, 'LOW', 14, 10); return true; }
    return false;
  }
  function weatherIcon(cat) {
    if (cat === L.CAT.FOG) return 'FOG';
    if (cat === L.CAT.DRIZZLE) return 'DRIZZLE';
    if (cat === L.CAT.RAIN) return 'RAIN';
    if (cat === L.CAT.SNOW) return 'SNOW';
    if (cat === L.CAT.THUNDER) return 'THUNDER';
    return '';
  }
  // Extreme-marker kinds -> big-glyph index (glyphs.js GLYPH_ART 7/8/9). These have
  // no CAT enum slot; the gateway ships the index as a synthetic byte2 (glyphCat).
  const EXTREME_GLYPH = { HOT: 7, COLD: 8, GALE: 9 };
  // Emergency-marker kinds (GDACS/BC feeds) -> big-glyph index (glyphs.js GLYPH_ART
  // 10 FIRE / 11 FLOOD), shipped the SAME way (synthetic glyphCat byte2 + phen=null).
  const EMERGENCY_GLYPH = { FIRE: 10, FLOOD: 11 };
  // On-map Pacific legend RETIRED (owner 2026-08-03): the synoptic chart's marks
  // are self-describing (areas + pictograms) and the page footer carries the key;
  // the six icon+label tiles over the mid-Pacific were chart clutter. The
  // LEGEND_ROWS/stampBig2/addPacificLegend machinery lived here (see a0c9390^).

  // --- live-fetch scout triage: population-impact weather, not cyclone patrol ---
  // The first-pass live fetch is ONE centre sample per ZX81/tile. Extra sub-tile
  // samples are a scarce budget and must be earned by weather that affects people
  // (or genuinely severe marine weather), not spent blindly on every ocean tile's
  // cyclone quincunx. This 10x10 baked weight is deliberately coarse enough for a
  // ZX81/BASIC-era rule table: 0 remote/ocean, 1 sparse, 2 populated, 3 dense.
  // Row-major, matching tile index row*10+col.
  const POP_WEIGHT = [
    0,0,0,0,0,0,0,0,0,0,
    0,1,1,2,2,1,2,2,1,0,
    1,2,2,3,3,3,3,3,2,1,
    1,2,2,3,3,3,3,3,2,1,
    0,1,2,2,3,3,3,3,2,1,
    0,1,2,2,3,3,3,2,1,1,
    0,1,1,1,2,2,2,1,1,0,
    0,0,0,0,1,1,1,0,0,0,
    0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,
  ];
  function populationWeight(tileIdx) { return POP_WEIGHT[(tileIdx | 0)] || 0; }

  function weatherImpactScore(w, tileIdx) {
    if (!w) return 0;
    const cat = L.weatherCodeToCat(w.weatherCode || 0);
    let sev = CAT_SCORE[cat] || 0;
    const precip = w.precipMm || 0;
    const gust = w.gustKmh == null ? (w.windKmh || 0) : w.gustKmh;
    const wind = w.windKmh || 0;
    const cloud = w.cloudCoverPct == null ? 0 : w.cloudCoverPct;
    const press = w.pressureHpa;
    if (precip >= 15) sev += 8;
    else if (precip >= 5) sev += 4;
    if (gust >= 90 || wind >= 70) sev += 10;
    else if (gust >= 70 || wind >= 55) sev += 6;
    if (cat === L.CAT.FOG) sev += 5;
    if (cloud >= 85 && cat !== L.CAT.CLEAR) sev += 2;
    if (press != null && press <= 990) sev += 4;
    if (L.waveToSeaState(w.waveHeight) === L.SEA.STORM) sev += 6;
    const pop = populationWeight(tileIdx);
    // Populated weather gets the multiplier; remote severe weather remains visible
    // but should not displace thunder/fog/heavy precip over population centres.
    return sev ? sev * (1 + pop * 2) + pop : 0;
  }

  function selectImpactScoutTiles(weatherArr, coordsInfo, opts) {
    const cap = opts && opts.cap != null ? opts.cap | 0 : 8;
    const minScore = opts && opts.minScore != null ? +opts.minScore : 8;
    const scored = [];
    for (let i = 0; i < weatherArr.length; i++) {
      const score = weatherImpactScore(weatherArr[i], i);
      if (score >= minScore) scored.push({ tile: i, score });
    }
    scored.sort((a, b) => b.score - a.score || a.tile - b.tile);
    const top = scored.slice(0, Math.max(0, cap));
    return { tiles: top.map((x) => x.tile), scores: top };
  }

  function impactScoutSubPoints(tileIdx, coordsInfo, tileWdeg, tileHdeg) {
    const idx = (tileIdx || []).slice();
    const coords = idx.map((i) => coordsInfo[i]);
    return subPointsFor(idx, coords, tileWdeg, tileHdeg);
  }

  function regionBucket(tileIdx) {
    const r = (tileIdx / L.GRID) | 0, c = tileIdx % L.GRID;
    if (r >= 9) return 'ANTARCTICA';
    if (r >= 7) return 'SOUTHERN_OCEAN';
    if (c <= 2 && r <= 5) return 'AMERICAS';
    if (c <= 3) return 'S_AMERICA';
    if (c <= 5 && r <= 3) return 'EUROPE_AFRICA';
    if (c <= 5) return 'AFRICA';
    if (c <= 7) return 'ASIA';
    return 'PACIFIC';
  }
  function weatherSeverity(w, tileIdx) {
    const cat = L.weatherCodeToCat(w.weatherCode || 0);
    const precip = w.precipMm || 0;
    const gust = w.gustKmh == null ? (w.windKmh || 0) : w.gustKmh;
    let s = CAT_SCORE[cat] || 0;
    if (precip >= 10) s += 8; else if (precip >= 2) s += 4; else if (precip > 0) s += 1;
    if (gust >= 90 || (w.windKmh || 0) >= 70) s += 8;
    else if (gust >= 70 || (w.windKmh || 0) >= 55) s += 4;
    s += populationWeight(tileIdx) * 3;
    return s;
  }
  function localPressureKind(weatherArr, tileIdx) {
    const N = L.GRID;
    const w = weatherArr[tileIdx];
    if (!w || w.pressureHpa == null || !isFinite(w.pressureHpa)) return null;
    if ((w.cycloneTier | 0) >= L.CYC.CYCLONE) return null;
    const p = w.pressureHpa;
    const r = (tileIdx / N) | 0, c = tileIdx % N;
    let isMin = true, isMax = true, nbrs = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr; if (rr < 0 || rr >= N) continue;
        const cc = ((c + dc) % N + N) % N;
        const n = weatherArr[rr * N + cc];
        if (!n || n.pressureHpa == null || !isFinite(n.pressureHpa)) continue;
        nbrs++;
        if (!(p < n.pressureHpa)) isMin = false;
        if (!(p > n.pressureHpa)) isMax = false;
      }
    if (!nbrs) return null;
    if (isMin && (p <= 1000 || popcount4(w.pressIsoByte | 0) >= 2)) return 'LOW';
    if (isMax && (p >= 1024 || popcount4(w.pressIsoByte | 0) >= 2)) return 'HIGH';
    return null;
  }
  function frontCandidate(w, tileIdx) {
    if (!w) return null;
    const cat = L.weatherCodeToCat(w.weatherCode || 0);
    const r = (tileIdx / L.GRID) | 0;
    const sea = L.waveToSeaState(w.waveHeight);
    const gust = w.gustKmh == null ? (w.windKmh || 0) : w.gustKmh;
    const bucket = regionBucket(tileIdx);
    const pop = populationWeight(tileIdx);
    const temp = typeof w.tempC === 'number' ? w.tempC : null;
    if (r >= 9) {
      if (cat === L.CAT.THUNDER || (w.precipMm || 0) >= 1 || gust >= 90 || (w.windKmh || 0) >= 70)
        return { tile: tileIdx, kind: cat >= L.CAT.FOG ? 'WX' : 'GALE', bucket, score: 18 + weatherSeverity(w, tileIdx) };
      if (temp != null && temp <= -40) return { tile: tileIdx, kind: 'COLD', bucket, score: 12 };
      return null;
    }
    if (r >= 7) {
      if (navHazard(w)) return { tile: tileIdx, kind: 'GALE', bucket, score: 15 + (sea === L.SEA.STORM ? 8 : 0) + Math.max(0, gust - 55) / 5 };
      return null;
    }
    if (cat >= L.CAT.FOG) return { tile: tileIdx, kind: 'WX', bucket, score: weatherSeverity(w, tileIdx) };
    if (navHazard(w) && sea >= L.SEA.HIGH) return { tile: tileIdx, kind: 'GALE', bucket, score: 12 + (sea === L.SEA.STORM ? 8 : 0) + pop };
    if (temp != null && temp >= 30 && (pop || bucket === 'AFRICA' || bucket === 'ASIA'))
      return { tile: tileIdx, kind: 'HOT', bucket, score: 10 + Math.max(0, temp - 30) + pop * 3 };
    if (temp != null && temp <= -18 && pop)
      return { tile: tileIdx, kind: 'COLD', bucket, score: 9 + Math.max(0, -18 - temp) + pop * 2 };
    return null;
  }
  function pressureCandidate(weatherArr, tileIdx) {
    const w = weatherArr[tileIdx];
    if (!w || southernDomain(tileIdx)) return null;
    const kind = localPressureKind(weatherArr, tileIdx);
    if (!kind) return null;
    const p = w.pressureHpa;
    const bucket = regionBucket(tileIdx);
    const pop = populationWeight(tileIdx);
    const edges = popcount4(w.pressIsoByte | 0);
    const score = kind === 'LOW'
      ? 11 + Math.max(0, 1008 - p) / 3 + edges * 2 + pop
      : 9 + Math.max(0, p - 1018) / 3 + edges * 2 + pop;
    return { tile: tileIdx, kind, bucket, score, source: 'pressure' };
  }
  function pressureExtremaCandidates(weatherArr) {
    let lo = null, hi = null;
    for (let i = 0; i < weatherArr.length; i++) {
      const w = weatherArr[i];
      if (!w || southernDomain(i) || w.pressureHpa == null || !isFinite(w.pressureHpa)) continue;
      if ((w.cycloneTier | 0) >= L.CYC.CYCLONE) continue;
      const p = w.pressureHpa;
      if (!lo || p < lo.p) lo = { tile: i, p };
      if (!hi || p > hi.p) hi = { tile: i, p };
    }
    const out = [];
    if (lo && lo.p <= 1008) out.push({ tile: lo.tile, kind: 'LOW', bucket: regionBucket(lo.tile), score: 24 + Math.max(0, 1008 - lo.p) / 2, source: 'pressure-extreme' });
    if (hi && hi.p >= 1010) out.push({ tile: hi.tile, kind: 'HIGH', bucket: regionBucket(hi.tile), score: 22 + Math.max(0, hi.p - 1010) / 2, source: 'pressure-extreme' });
    // Newspaper-synoptic H/L density (owner 2026-07-31): one qualifying LOW and HIGH
    // per region bucket, not one global pair — a chart with a single H is not a
    // synoptic chart. Same thresholds; the global pair above keeps its higher score.
    const perLo = {}, perHi = {};
    for (let i = 0; i < weatherArr.length; i++) {
      const w = weatherArr[i];
      if (!w || southernDomain(i) || w.pressureHpa == null || !isFinite(w.pressureHpa)) continue;
      if ((w.cycloneTier | 0) >= L.CYC.CYCLONE) continue;
      const b = regionBucket(i), p = w.pressureHpa;
      if (!perLo[b] || p < perLo[b].p) perLo[b] = { tile: i, p };
      if (!perHi[b] || p > perHi[b].p) perHi[b] = { tile: i, p };
    }
    for (const b in perLo) {
      const l2 = perLo[b], h2 = perHi[b];
      if (l2.p <= 1004 && !(lo && l2.tile === lo.tile))
        out.push({ tile: l2.tile, kind: 'LOW', bucket: +b, score: 18 + Math.max(0, 1004 - l2.p) / 2, source: 'pressure-extreme' });
      if (h2.p >= 1018 && !(hi && h2.tile === hi.tile))
        out.push({ tile: h2.tile, kind: 'HIGH', bucket: +b, score: 16 + Math.max(0, h2.p - 1018) / 2, source: 'pressure-extreme' });
    }
    return out;
  }
  function selectFrontCandidates(weatherArr, cap) {
    const all = [];
    for (let i = 0; i < weatherArr.length; i++) {
      const c = frontCandidate(weatherArr[i], i);
      if (c) all.push(c);
      const pc = pressureCandidate(weatherArr, i);
      if (pc) all.push(pc);
    }
    for (const pc of pressureExtremaCandidates(weatherArr)) all.push(pc);
    all.sort((a, b) => b.score - a.score || a.tile - b.tile);
    const limit = cap == null ? FRONT_CAP : cap;
    const selected = [], used = new Set(), perBucket = new Map(), perCat = new Map();
    // Per-category cap from the spec (WX->PRECIP, GALE->WIND, HOT->HEAT, ...); a modest
    // per-bucket spread cap keeps one region from walling the map. `relaxed` lifts the
    // bucket-spread cap only (category caps are the spec's word and are never relaxed).
    function catCapFor(c) { const cat = KIND_TO_CAT[c.kind]; return (cat && CAT_CAPS[cat] != null) ? CAT_CAPS[cat] : 4; }
    function canUse(c, relaxed) {
      if (used.has(c.tile)) return false;
      if ((perCat.get(KIND_TO_CAT[c.kind]) || 0) >= catCapFor(c)) return false;
      if (!relaxed && (perBucket.get(c.bucket) || 0) >= BUCKET_SPREAD_CAP) return false;
      return true;
    }
    function take(c) {
      selected.push(c); used.add(c.tile);
      perBucket.set(c.bucket, (perBucket.get(c.bucket) || 0) + 1);
      perCat.set(KIND_TO_CAT[c.kind], (perCat.get(KIND_TO_CAT[c.kind]) || 0) + 1);
    }
    for (const c of all) if (selected.length < limit && canUse(c, false)) take(c);
    for (const c of all) if (selected.length < Math.min(limit, FRONT_MIN) && canUse(c, true)) take(c);
    for (const c of all) if (selected.length < limit && canUse(c, true)) take(c);
    selected.sort((a, b) => a.tile - b.tile);
    return { ranked: all, top: selected, byTile: new Map(selected.map((c) => [c.tile, c])) };
  }

  function basicImportanceScore(w) {
    if (!w) return 0;
    const cat = L.weatherCodeToCat(w.weatherCode || 0);
    let score = CAT_SCORE[cat] || 0;
    if ((w.cycloneTier | 0) > 0) score += 20;
    if ((w.windKmh || 0) >= 55 || (w.gustKmh || 0) >= 70) score += 10;
    if (L.waveToSeaState(w.waveHeight) === L.SEA.STORM) score += 15;
    return score;
  }
  function computeImportance(weatherArr, cap) {
    const ranked = [];
    for (let tile = 0; tile < weatherArr.length; tile++) {
      const score = basicImportanceScore(weatherArr[tile]);
      if (score > 0) ranked.push({ tile, score });
    }
    ranked.sort((a, b) => b.score - a.score || a.tile - b.tile);
    const top = ranked.slice(0, Math.max(0, cap == null ? FRONT_CAP : cap));
    return { ranked, top, topSet: new Set(top.map((x) => x.tile)), byTile: new Map(top.map((x) => [x.tile, x])) };
  }

  // The tightest isobar cluster: the tile whose isobar edge mask (computeIsobars,
  // wx.pressIsoByte) has the MOST active N/S/W/E boundaries — a local knot of band
  // crossings, a steep pressure gradient, the synoptic "L" a real chart marks —
  // tie-broken by the lowest pressure (the deepest low). null if no tile has
  // pressure data with an active boundary.
  function popcount4(b) {
    return ((b & 1) ? 1 : 0) + ((b & 2) ? 1 : 0) + ((b & 4) ? 1 : 0) + ((b & 8) ? 1 : 0);
  }
  function computeTightestIsobar(weatherArr) {
    let best = null;
    for (let i = 0; i < weatherArr.length; i++) {
      const w = weatherArr[i]; if (!w || w.pressureHpa == null) continue;
      const edges = popcount4(w.pressIsoByte | 0);
      if (edges === 0) continue;
      if (!best || edges > best.edges ||
          (edges === best.edges && w.pressureHpa < best.pressureHpa))
        best = { tile: i, edges, pressureHpa: w.pressureHpa };
    }
    return best;
  }

  // One call for the WEATHER front page: choose an editorial synthesis set, then
  // stamp each selected candidate as a machine-rendered pictogram. H/L are allowed
  // here only in their conventional pressure sense and only when selected as sparse
  // pressure candidates; heat/cold/wind/sea/precip use pictograms, not letters.
  function computeWeatherFrontPage(weatherArr, subPts, subResults, cap, landMasks) {
    const imp = selectFrontCandidates(weatherArr, cap == null ? FRONT_CAP : cap);
    for (const w of weatherArr) if (w) { w.phen = []; w.glyphCat = null; w.tempMarker = null; w.fireMark = false; w.fireName = null; w.fireNameRow = 0; w.glyphPos = 0; }
    for (const c of imp.top) {
      const w = weatherArr[c.tile];
      if (!w || (w.cycloneTier | 0) >= L.CYC.CYCLONE) continue; // cyclone tiles use the spiral/name trailer channel
      // WEATHER-code tiles (rain/snow/thunder/fog/drizzle) draw the BIG 16x12 CAT_GLYPH
      // (bold, iconic) instead of the tiny 7x7 phen icon: setting phen=null makes both
      // the machine (PHENON=0 -> stampglyph) and the oracle (glyphCat=weatherCat) fall
      // through to the big glyph. Non-curated tiles keep phen=[] and stay blank, so the
      // wall shows one bold pictogram per significant-weather tile — bigger, not busier.
      // HEAT/COLD/GALE now draw a BIG extreme-marker glyph (indices 7/8/9) exactly
      // like the weather glyphs: phen=null + a synthetic glyphCat drives the machine.
      if (c.kind === 'WX') {
        // Curated weather tiles no longer force the big 16x12 glyph (owner 2026-08-01:
        // sub-tile size): the field-seated MINI glyph pass below covers them — a
        // curated tile is by construction a precip/thunder hotspot, so it ranks high
        // there naturally. Leave phen=[] here.
      } else if (c.kind === 'HOT' || c.kind === 'COLD') {
        // Notable temperature -> the ACTUAL reading as big white digits (reuse the
        // TEMP-page number machinery), not an icon: the machine shows the number it
        // measured. Sign distinguishes heat (+) from cold (-).
        w.phen = null; w.tempMarker = (w.tempC == null ? 0 : Math.round(w.tempC));
      } else if (EXTREME_GLYPH[c.kind] != null) {
        w.phen = null; w.glyphCat = EXTREME_GLYPH[c.kind];  // GALE gust-arrow glyph
      } else addKindIcon(w, c.kind);
    }
    const tightest = computeTightestIsobar(weatherArr);
    for (const pc of pressureExtremaCandidates(weatherArr)) {
      const w = weatherArr[pc.tile];
      if (w && Array.isArray(w.phen) && (w.cycloneTier | 0) < L.CYC.CYCLONE && w.phen.length === 0)
        addKindIcon(w, pc.kind);
    }
    if (tightest) {
      const w = weatherArr[tightest.tile];
      if (w && Array.isArray(w.phen) && (w.cycloneTier | 0) < L.CYC.CYCLONE && w.phen.length === 0)
        addIcon(w, 'LOW', 14, 10);
    }
    // FIELD-SEATED POINT-EVENT GLYPHS. The tile grid is the SENSOR, not the
    // layout: each icon sits at the 3x3 field-weighted centroid of the real
    // field, classified to the nearest sub-tile anchor (GL.SUB_CELL) and
    // shipped as glyphPos on the cyclone-byte pos bits — stampGlyph seats the
    // full 16x12 stamp there. Only POINT phenomena get icons (THUNDER, FOG);
    // precipitation and cloud are AREAS and render through the
    // src/weather-chart.js overlay ("lines not tone", owner 2026-08-02).
    {
      const NT = weatherArr.length, NN = Math.round(Math.sqrt(NT));
      const okTile = (t) => {
        const w = weatherArr[t];
        return !!w && (w.cycloneTier | 0) === L.CYC.NONE
          && Array.isArray(w.phen) && w.phen.length === 0
          && w.glyphCat == null && w.tempMarker == null;
      };
      const cycNear = new Set();
      for (let t = 0; t < NT; t++) {
        if (!weatherArr[t] || (weatherArr[t].cycloneTier | 0) < L.CYC.CYCLONE) continue;
        const r = (t / NN) | 0, c = t % NN;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr; if (rr < 0 || rr >= NN) continue;
          for (let dc = -1; dc <= 1; dc++) cycNear.add(rr * NN + ((c + dc + NN) % NN));
        }
      }
      const precipOf = (t) => { const w = weatherArr[t]; return (w && typeof w.precipMm === 'number') ? Math.max(0, w.precipMm) : 0; };
      const cloudOf = (t) => {
        const w = weatherArr[t];
        if (w && typeof w.cloudCoverPct === 'number') return Math.max(0, Math.min(100, w.cloudCoverPct));
        return (w && L.weatherCodeToCat(w.weatherCode || 0) >= L.CAT.CLOUD) ? 60 : 0;
      };
      // POINT events only (owner 2026-08-02, "lines not tone" chart ruling):
      // precipitation and cloud are AREA phenomena and render through the
      // src/weather-chart.js overlay (scalloped dotted rain areas with a
      // contained pictogram; cloud dropped — SATELLITE owns it). Per-tile
      // icons remain for the phenomena that ARE points: THUNDER (blinking
      // bolt; suppressed inside a cyclone's neighbourhood — implied by the
      // spiral) and FOG banks.
      const cands = [];
      for (let t = 0; t < NT; t++) {
        if (!okTile(t)) continue;
        const w = weatherArr[t];
        const cat = L.weatherCodeToCat(w.weatherCode || 0);
        if (cat === L.CAT.THUNDER && cycNear.has(t)) continue; // implied by the spiral
        let score;
        if (cat === L.CAT.THUNDER) score = 150 + precipOf(t) * 10;
        else if (cat === L.CAT.FOG) score = 60;
        else continue;
        cands.push({ t, cat, score });
      }
      // Greedy spacing: strongest first, 1.4 tiles of air — no two glyphs on
      // adjacent tiles, everything else places.
      cands.sort((a, b) => b.score - a.score);
      const placed = [];
      for (const c of cands) {
        const r = (c.t / NN) | 0, cc = c.t % NN;
        let ok = true;
        for (const p of placed) {
          const dr = ((p.t / NN) | 0) - r;
          let dc = Math.abs((p.t % NN) - cc); dc = Math.min(dc, NN - dc);
          if (Math.hypot(dr, dc) < 1.4) { ok = false; break; }
        }
        if (ok) placed.push(c);
      }
      // Seat each glyph's REGULAR 16x12 big pictogram (owner 2026-08-01: "regular size
      // glyphs but centred over where the weather is actually happening, not centred
      // per tile" — full size, not the shrunk MINI icon). The field-weighted 3x3
      // centroid (gx,gy) is a continuous point, but the sub-tile sample data can only
      // genuinely support 5 discrete anchors (GL.SUB_CELL: CENTER/NW/NE/SW/SE — the
      // same table stampGlyph's quadrant math already keys off), so the centroid is
      // classified to its NEAREST anchor and shipped as glyphPos on the existing
      // (otherwise dead) cyclone-byte pos bits. stampGlyph seats the 16x12 stamp
      // there, clamped wholly inside the tile — no wire/protocol change.
      for (const c of placed) {
        const r = (c.t / NN) | 0, cc = c.t % NN;
        let sw = 0, sr = 0, sc = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr; if (rr < 0 || rr >= NN) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const tt = rr * NN + ((cc + dc + NN) % NN);
            const f = c.cat === L.CAT.THUNDER ? precipOf(tt) : cloudOf(tt);
            const wgt = f * ((dr || dc) ? 0.35 : 1) + 0.01;   // centre-weighted, never all-zero
            sw += wgt; sr += wgt * (rr + 0.5); sc += wgt * (cc + dc + 0.5);
          }
        }
        const gx = Math.round((sw ? sc / sw : cc + 0.5) * L.TILE_W);
        const gy = Math.round((sw ? sr / sw : r + 0.5) * L.TILE_H);
        const lx = gx - cc * L.TILE_W, ly = gy - r * L.TILE_H;
        let pos = 0, best = Infinity;
        for (let k = 0; k < 5; k++) {
          const a = GL.SUB_CELL[k];
          const d = (lx - a[0]) * (lx - a[0]) + (ly - a[1]) * (ly - a[1]);
          if (d < best) { best = d; pos = k; }         // ties -> lower code (CENTER wins)
        }
        weatherArr[c.t].glyphCat = c.cat;
        weatherArr[c.t].glyphPos = pos;
        weatherArr[c.t].phen = null;
      }
    }
    return { topSet: new Set(imp.top.map((x) => x.tile)), ranked: imp.ranked, top: imp.top, tightest };
  }

  // --- emergency overlay (GDACS wildfire/flood + BC wildfire) --------------
  // Apply the emergency feeds ON TOP of the editorial WEATHER front page. Each mark
  // is { tile, kind:'FIRE'|'FLOOD' } (or a raw glyphCat index). For each mark the
  // tile's big pictogram is FORCED to the emergency glyph (phen=null + synthetic
  // glyphCat) — a wildfire/flood emergency outranks the tile's routine weather
  // category — EXCEPT where a cyclone already owns the tile (tier>=CYCLONE keeps its
  // spiral/name trailer; "cyclones keep precedence where they collide"). Pure and
  // idempotent: it only mutates glyphCat/phen, never the weather data. Returns the
  // number of tiles actually marked. Call AFTER computeWeatherFrontPage so the
  // emergency glyph is the last word on the WEATHER page (below the cyclone layer).
  function applyEmergencies(weatherArr, marks, N) {
    if (!Array.isArray(weatherArr) || !Array.isArray(marks)) return 0;
    const total = (N || L.GRID) * (N || L.GRID);
    let applied = 0;
    for (const mk of marks) {
      if (!mk) continue;
      const tile = mk.tile | 0;
      if (tile < 0 || tile >= total) continue;
      const w = weatherArr[tile];
      if (!w) continue;
      if ((w.cycloneTier | 0) >= L.CYC.CYCLONE) continue;   // cyclone precedence
      const kind = (mk.kind === 'FIRE' || mk.kind === 'FLOOD') ? mk.kind
        : (mk.glyphCat === EMERGENCY_GLYPH.FIRE ? 'FIRE'
          : mk.glyphCat === EMERGENCY_GLYPH.FLOOD ? 'FLOOD' : null);
      if (kind == null) continue;
      // A fire/flood is a POINT event, not a tile-wide phenomenon: draw a SMALL 7x7
      // icon at the event's real sub-tile position (from its lat/lon) via the phen
      // path, NOT a big centred glyph. Emergency precedence: it overrides the tile's
      // routine weather mark. Located marks naturally sit over the land they burn.
      let cx = GL.SUB_CELL[0][0], cy = GL.SUB_CELL[0][1];   // tile centre fallback
      if (mk.lat != null && mk.lon != null) {
        const cell = emergencyCell(mk.lat, mk.lon, (tile / (N || L.GRID)) | 0, tile % (N || L.GRID));
        cx = cell[0]; cy = cell[1];
      }
      // Only NAMED fires appear on the wall: a nameless mark (e.g. GDACS-only, which
      // carries severity but no incident name) is SKIPPED so every flame the viewer
      // sees carries a real place name and the map stays legible. Compute the plate
      // name BEFORE clearing the tile's routine mark, so a skip leaves the tile intact.
      let fireName = '';
      if (kind === 'FIRE') {
        fireName = mk.name ? String(mk.name).toUpperCase().replace(/[^A-Z ]/g, '').trim().split(/\s+/)[0].slice(0, 8) : '';
        if (!fireName) continue;   // unnamed fire -> not shown at all
      }
      w.glyphCat = null;
      w.phen = [];
      if (kind === 'FIRE') {
        // Every shown fire is ONE animated flame + its name plate. Severity no longer
        // changes the flame count (the double-flame RED variant is retired): named-only
        // coverage means a uniform, legible mark regardless of RED/ORANGE band.
        addFireIcon(w, cx - 3, cy - 3);           // single full animated flame
        w.fireMark = true;   // animated (flame flickers on-machine)
        w.fireName = fireName;
        // Caption HUGS the flame: the small 5-row plate sits DIRECTLY BELOW the flame
        // (rows cy-3..cy+3) when the flame is high on the tile, and DIRECTLY ABOVE it
        // when the flame is low — never edge-pinned. Clamped on-tile (plate box =
        // nameY-1..nameY+3, so nameY in [1,20]).
        const nameY = cy <= 12 ? cy + 5 : cy - 7;
        w.fireNameRow = Math.max(1, Math.min(20, nameY));
      } else addIcon(w, kind, cx - 3, cy - 3);   // 7x7 icon centred at the located cell
      applied++;
    }
    return applied;
  }
  // Wildfire POINTS for the WEATHER display (owner 2026-07-21, research-grounded — see
  // docs/MONOCHROME-WX-DESIGN.md). Real products (NOAA HMS, AirNow) encode fire as
  // POINT hotspot markers at the incident location and smoke as a SEPARATE area field;
  // conflating them into a tile fill was the rejected "wallpaper hatch". Here each
  // fire-active tile draws a flame CLUSTER at the fires' real sub-tile centroid, sized
  // by the tile's true load (intensity 1..3 from incident count + largest acreage),
  // and the worst incidents carry their name. The downwind smoke FIELD is a separate
  // layer (src/smokeflow.js — advected on the real wind, poked as graded cells).
  // zones: [{ tile, intensity(1..3), cx, cy, name? }]. Cyclone tiles keep precedence.
  // snapToLand(mask, x, y) — nearest land cell within a small ring search, or the original
  // cell when the mask has no land nearby. owner QC 2026-07-29: the Moroccan complex's i3
  // flame cluster fanned cx±5 (~±560 km) and its westernmost flame landed in the open
  // Atlantic — the decorative spread was blind to the coastline. A genuinely-island tile
  // (Hawaii, the Aegean) keeps its true position: the coarse mask carries no land there,
  // and relocating a real island fire would be a worse lie than a flame on blank sea.
  function snapToLand(mask, x, y) {
    const W = L.TILE_W, H = L.TILE_H;
    const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const x0 = cl(x, 3, W - 4), y0 = cl(y, 3, H - 4);
    if (!mask) return [x0, y0];
    // score = land cells under the flame's CORE (centre 3x3 of the 7x7 icon) — a bare
    // centre-cell snap left the icon straddling the shoreline (7 of 12 flame cells still
    // on sea off Morocco). A coastal fire may honestly touch the water's edge; its core
    // must not.
    const core = (xx, yy) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (mask[(yy + dy) * W + (xx + dx)]) n++;
      return n;
    };
    if (core(x0, y0) === 9) return [x0, y0];
    let best = null, bestScore = core(x0, y0);
    for (let r = 1; r <= 6 && bestScore < 9; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // ring only
          const xx = x0 + dx, yy = y0 + dy;
          if (xx < 3 || xx > W - 4 || yy < 3 || yy > H - 4) continue;
          const s = core(xx, yy);
          if (s > bestScore) { bestScore = s; best = [xx, yy]; if (s === 9) break; }
        }
    return best || [x0, y0];   // island tile: no land in the mask — keep the honest position
  }
  // landMasks (optional 4th arg): per-tile coastline masks; when provided, every flame
  // spot snaps to the nearest land cell (see snapToLand above).
  function applyFireZones(weatherArr, zones, N, landMasks) {
    if (!Array.isArray(weatherArr) || !Array.isArray(zones)) return 0;
    const total = (N || L.GRID) * (N || L.GRID);
    let applied = 0;
    for (const z of zones) {
      if (!z) continue;
      const tile = z.tile | 0;
      if (tile < 0 || tile >= total) continue;
      const w = weatherArr[tile];
      if (!w) continue;
      if ((w.cycloneTier | 0) >= L.CYC.CYCLONE) continue;   // cyclone precedence
      const it = Math.max(1, Math.min(3, z.intensity | 0));
      w.glyphCat = null;                                    // fire overrides the routine mark
      w.phen = [];
      w.fireMark = true;
      // Flame cluster at the REAL fire centroid: 1 flame minor / 2 flames active /
      // 3 flames major complex, tightly grouped so it reads as one hotspot marker.
      const cx = Math.max(4, Math.min(L.TILE_W - 5, z.cx == null ? 16 : z.cx | 0));
      const cy = Math.max(4, Math.min(L.TILE_H - 5, z.cy == null ? 12 : z.cy | 0));
      const spots = it >= 3 ? [[cx - 5, cy], [cx + 5, cy], [cx, cy - 4]]
        : it >= 2 ? [[cx - 3, cy], [cx + 4, cy - 2]]
        : [[cx, cy]];
      const mask = landMasks ? landMasks[tile] : null;
      for (const s of spots) {
        const [sx, sy] = snapToLand(mask, s[0], s[1]);
        addFireIcon(w, sx - 3, sy - 3);
      }
      if (z.name) {
        w.fireName = z.name;
        // Plate row from the ACTUAL stamped flame cells, not the pre-snap centroid
        // (owner QC 2026-07-29: MORRILL/BIVONA name bars stepped on their flame icons —
        // the fan spots spread cx+-5 and snapToLand shifts up to 6 more, so cy+-6/8
        // was blind to where the flames really landed). The plate is tile-centred
        // (plateNameSmall: cols 16-n-1 .. 16+n, rows nameY-1 .. nameY+3); take the
        // first candidate row whose box misses every flame cell, else least-overlap.
        const n = Math.min(8, String(z.name).length);
        const cells = w.phen.filter((p) => p.code === 0x80);
        let minY = 99, maxY = -1;
        for (const p of cells) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        const overlap = (nameY) => {
          let hits = 0;
          for (const p of cells)
            if (p.x >= 16 - n - 1 && p.x <= 16 + n && p.y >= nameY - 1 && p.y <= nameY + 3) hits++;
          return hits;
        };
        const clampRow = (v) => Math.max(1, Math.min(20, v));
        const cands = [clampRow(maxY + 2), clampRow(minY - 5), clampRow(cy <= 12 ? cy + 6 : cy - 8)];
        let bestRow = cands[0], bestHits = overlap(cands[0]);
        for (let i = 1; i < cands.length && bestHits > 0; i++) {
          const h = overlap(cands[i]);
          if (h < bestHits) { bestRow = cands[i]; bestHits = h; }
        }
        w.fireNameRow = bestRow;
      }
      applied++;
    }
    return applied;
  }
  // lat/lon -> an (x,y) cell inside the tile's 32x24 grid (tileLat/tileLon are the
  // tile CENTRE, as in subCellForOffset). Clamped to leave room for a 7x7 icon.
  function emergencyCell(lat, lon, row, col) {
    const tileLat = 81 - 18 * row, tileLon = -162 + 36 * col;
    let dLon = lon - tileLon; if (dLon > 180) dLon -= 360; if (dLon < -180) dLon += 360;
    const dLat = lat - tileLat;
    let x = Math.round(16 + (dLon / 18) * 14);
    let y = Math.round(12 - (dLat / 9) * 10);
    if (x < 4) x = 4; else if (x > 27) x = 27;
    if (y < 4) y = 4; else if (y > 18) y = 18;
    return [x, y];
  }

  // --- cyclone PERIPHERY: the storm's PHYSICAL (sub-tile) size -------------
  // A cyclone's cloud/wind field is bigger than its 7x7 eye stamp but — at this map
  // scale — still SMALLER THAN ONE TILE: one tile spans ~2,800-4,000 km of longitude
  // while even the largest storm ever (Typhoon Tip, gale diameter ~2,200 km) is
  // under one tile wide. So the periphery is a SUB-TILE spiral on the eye's OWN
  // tile, its radius measured in KILOMETRES (never tile counts). The machine draws a
  // baked centred spiral stamp (src/glyphs.js) sized by the km->cell bucket.
  //
  // Radius estimator (honestly coarse — one forecast sample per ~3,000 km tile can't
  // resolve a storm's true extent). Gale radius in km from the core's intensity,
  // bumped when neighbouring tiles also blow storm-force (a broader field), FLOORED
  // at 300 km (a modest hurricane) and HARD-CAPPED at 1,100 km (Tip). Converted to
  // cells at the tile's latitude (a degree of longitude shrinks with cos(lat)) and
  // floored to a radius bucket, so the rendered span is always <= 2*cap = 2,200 km.
  const STORM_GUST = 75;                          // km/h — gale/storm force
  const RADIUS_FLOOR_KM = 300, RADIUS_CAP_KM = 1100;
  const KM_PER_DEG = 111.32, TILE_LON_DEG = 360 / L.GRID;   // 36deg wide tiles
  // km per character cell at latitude `lat` (horizontal — the binding axis for the
  // longitude span the QC flagged). Vertical cells are a fixed ~83 km.
  function kmPerCellAtLat(lat) {
    const tileKm = TILE_LON_DEG * KM_PER_DEG * Math.cos(lat * Math.PI / 180);
    return tileKm / L.TILE_W;
  }
  function tileLatOf(i, N) { return 81 - 18 * Math.floor(i / N); }   // == report.tileLat
  // Radius bucket (index into glyphs BUCKET_R) whose cell radius is the largest that
  // does not exceed R_cells (floor), so span_km = 2*R*kmPerCell <= 2*capKm.
  function radiusBucket(rCells) {
    let idx = 0;
    for (let i = 0; i < GL.BUCKET_R.length; i++) if (GL.BUCKET_R[i] <= rCells) idx = i;
    return idx;
  }

  function computePeriphery(weatherArr, seaIdx, gridN) {
    const N = gridN || L.GRID;
    for (const w of weatherArr) if (w) w.periphByte = 0;
    const isCore = (i) => {
      const w = weatherArr[i];
      // A SUPPRESSED (extratropical) low is not a tropical cyclone -> no spiral, no
      // periphery band (FS2 §C.2): its periphByte stays 0.
      return w && (w.cycloneTier | 0) >= L.CYC.CYCLONE && !(w.cycloneSuppress | 0);
    };
    for (let c = 0; c < weatherArr.length; c++) {
      if (!isCore(c)) continue;
      const core = weatherArr[c];
      const cr = Math.floor(c / N), cc = c % N;
      // measured extent proxy: the core's own gust intensity + storm-force neighbours
      let stormCount = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const r = cr + dr; if (r < 0 || r >= N) continue;
          const cx = ((cc + dc) % N + N) % N, w = weatherArr[r * N + cx];
          if (w && (w.gustKmh | 0) >= STORM_GUST) stormCount++;
        }
      // the triggering (eyewall) gust from detectCyclones — not the tile-centre
      // gust, which is weak when the eye sits offset between tile centres.
      const gust = core.cycloneGust != null ? (core.cycloneGust | 0) : (core.gustKmh | 0);
      let rKm = 300 + Math.max(0, gust - 90) * 6 + stormCount * 110;   // intensity + field
      rKm = Math.max(RADIUS_FLOOR_KM, Math.min(RADIUS_CAP_KM, rKm));
      const rCells = rKm / kmPerCellAtLat(tileLatOf(c, N));
      const sizeIdx = radiusBucket(rCells);
      // spiral centred on the EYE (its sub-tile position rides cyclonePos); spin
      // follows the hemisphere (southern storms mirror to CW).
      core.periphByte = L.periphToByte(sizeIdx, core.cycloneSouth | 0);
      core.periphRadiusKm = rKm;                  // for the size proof / honest logging
    }
    // FS2 T11: fold the ordinary (sub-CYCLONE) L/H pressure centres onto the SAME
    // periph byte (its free high bits) right after the cyclone periphery is sized,
    // so every caller of computePeriphery gets both with no extra wiring.
    findPressureCentres(weatherArr, N);
    return weatherArr;
  }

  // --- FS2 T11 §C.4: ordinary (sub-CYCLONE) pressure-centre L/H markers --------
  // A bounded LOCAL-EXTREMA pass over the per-tile CENTRE pressure grid
  // (weatherArr[i].pressureHpa — the ALREADY-fetched pressure_msl sample; NO new
  // fetch, the pass is pure over weatherArr). A tile is an ordinary LOW if its
  // pressure is a STRICT local minimum vs its 8 neighbours (wrap longitude, clamp
  // poles), a HIGH if a STRICT local maximum. Cyclone tiles (tier>=CYCLONE — the
  // rotating spiral AND the suppressed extratropical bold-L) are EXCLUDED: they
  // already carry their own marker; the ordinary L/H is for sub-CYCLONE centres.
  //
  // The count is BOUNDED to the CENTRE_CAP deepest lows + CENTRE_CAP highest highs
  // (6 each) so the wall isn't littered with markers on a noisy synoptic field;
  // strict extrema beyond the cap are dropped (the most significant centres win).
  // Marks the chosen tiles by OR-ing the centre bits (bits4-5) onto periphByte —
  // disjoint from the cyclone size/flip bits, so a non-cyclone tile whose periph
  // byte was zeroed by computePeriphery now carries ONLY the L/H centre code.
  const CENTRE_CAP = 6;
  function findPressureCentres(weatherArr, gridN) {
    const N = gridN || L.GRID;
    const pAt = (i) => {
      const w = weatherArr[i];
      return (w && w.pressureHpa != null && isFinite(w.pressureHpa)) ? w.pressureHpa : null;
    };
    const lows = [], highs = [], all = [];
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const i = r * N + c, w = weatherArr[i];
        if (!w) continue;
        // Named tropical systems carry their own storm marker/name. Unnamed/generic
        // pressure-signature lows are still ordinary synoptic pressure centres on
        // the PRESSURE page, so they may receive a conventional L.
        if ((w.cycloneTier | 0) >= L.CYC.CYCLONE && (w.cycloneName || w.cycloneGust == null)) continue;
        const self = pAt(i);
        if (self == null) continue;
        all.push({ i, p: self });
        let isMin = true, isMax = true, nbrs = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr; if (rr < 0 || rr >= N) continue;   // clamp poles
            const cc = ((c + dc) % N + N) % N;                    // wrap longitude
            const np = pAt(rr * N + cc);
            if (np == null) continue;
            nbrs++;
            if (!(self < np)) isMin = false;
            if (!(self > np)) isMax = false;
          }
        if (!nbrs) continue;                    // isolated tile: no extremum
        if (isMin) lows.push({ i, p: self });
        else if (isMax) highs.push({ i, p: self });
      }
    // Coarse 10x10 pressure fields can be monotone or too smooth for a strict
    // 8-neighbour extremum, yielding no readable H/L even though the page still
    // needs a synoptic story. Fall back to the basin-scale lowest/highest sampled
    // pressure when the field has real spread; still sparse, still pressure-only,
    // and cyclone tiles remain excluded above.
    if (all.length) {
      all.sort((a, b) => a.p - b.p);
      const spread = all[all.length - 1].p - all[0].p;
      const displayable = (e) => { const r = (e.i / N) | 0; return r > 0 && r < N - 1; };
      const lo = all.find(displayable) || all[0];
      const hi = all.slice().reverse().find(displayable) || all[all.length - 1];
      if (!lows.length && spread >= 4) lows.push(lo);
      if (!highs.length && spread >= 4 && hi.i !== lo.i) highs.push(hi);
    }
    const mark = (e, code) => {
      const w = weatherArr[e.i];
      w.periphByte = (w.periphByte | 0) | L.periphCentreToBits(code);
    };
    lows.sort((a, b) => a.p - b.p).slice(0, CENTRE_CAP).forEach((e) => mark(e, L.PERIPH_CENTRE.LOW));
    highs.sort((a, b) => b.p - a.p).slice(0, CENTRE_CAP).forEach((e) => mark(e, L.PERIPH_CENTRE.HIGH));
    return weatherArr;
  }

  // Drive ONE machine through its TDMA slot: broadcast its frame on a fresh
  // downlink (a slot on the shared line), run it until it draws + ACKs, and on
  // NAK/timeout retransmit a clean frame up to maxRetransmit times.
  //
  // opts: { asm, addr, land, payload, injectCorrupt?, maxRetransmit?, maxFrames? }
  // returns { status, attempts, acked, ack, frames }
  function receiveTile(m, opts) {
    const asm = opts.asm;
    const addr = opts.addr & 0xff;
    const maxR = opts.maxRetransmit == null ? 3 : opts.maxRetransmit;
    const maxFrames = opts.maxFrames == null ? 400 : opts.maxFrames;
    const STATUS = asm.labels.STATUS;

    // configure this machine: baked coastline + program + address (DIP switch)
    if (opts.land) for (let i = 0; i < 768; i++) m.poke(L.LAND_BASE + i, opts.land[i] ? 1 : 0);
    for (let i = 0; i < asm.bytes.length; i++) m.poke(asm.org + i, asm.bytes[i]);
    // FS2 T15: seed low-RAM data segments (block font, relocated spiral table) — the
    // on-machine renderer reads these at fixed addresses below the 0x7000 image.
    if (asm.dataSegments) for (const s of asm.dataSegments) for (let i = 0; i < s.bytes.length; i++) m.poke(s.addr + i, s.bytes[i]);
    m.poke(asm.labels.MYADDR, addr);
    m.poke(STATUS, 0);

    const down = new TapeBus(), up = new TapeBus();
    const T0 = m.tState();
    m.attachEar(down, -T0);
    m.attachMic(up, -T0);
    const st = m.cpu.getState(); st.pc = asm.org; m.cpu.setState(st);

    let cursor = 2000, attempts = 1;
    cursor = FAST.modulateFrame(down, cursor, addr, opts.payload,
      { badChecksum: !!opts.injectCorrupt }) + 3000;

    let status = 0, frames = 0;
    for (; frames < maxFrames; frames++) {
      m.runFrame();
      status = m.peek(STATUS);
      if (status === 0xa1) break;               // drawn + acked
      if (status === 0x15) {                     // machine NAKed -> retransmit clean
        if (attempts >= maxR + 1) break;
        attempts++;
        m.poke(STATUS, 0);
        let c = (m.tState() - T0) + 4000;
        if (c < cursor) c = cursor;
        cursor = FAST.modulateFrame(down, c, addr, opts.payload) + 3000;
      }
    }
    const ack = FAST.demodulateAck(up, 0, up.lastT + 1000);
    return { status, attempts, acked: status === 0xa1, ack, frames, down, up };
  }

  // Fetch weather for tile coords, keeping the last good map on failure. Returns
  // { weather:[{tempC,precipMm}], ok }. weatherModule = require('./weather').
  async function refreshWeather(coords, weatherModule, fetchImpl, lastGood) {
    try {
      const w = await weatherModule.fetchWeather(coords, fetchImpl);
      return { weather: w, ok: true };
    } catch (e) {
      return { weather: lastGood || coords.map(() => ({ tempC: null, precipMm: 0 })), ok: false, error: String(e) };
    }
  }

  // Which tiles are "sea tiles" worth a marine sample: those whose CENTRE cell is
  // sea (land mask 0 at the tile centre). coordsInfo: [{row,col}]; landMaskFn:
  // (row,col)->768 mask. Returns { seaIdx:[tileIndex], seaCoords:[{lat,lon}] } —
  // the single batched marine call covers exactly seaCoords.
  function seaTiles(coordsInfo, landMaskFn, TILE_W, TILE_H) {
    const seaIdx = [], seaCoords = [];
    const cx = (TILE_W >> 1), cy = (TILE_H >> 1);
    for (let i = 0; i < coordsInfo.length; i++) {
      const ci = coordsInfo[i];
      const mask = landMaskFn(ci.row, ci.col);
      if (!mask[cy * TILE_W + cx]) { seaIdx.push(i); seaCoords.push({ lat: ci.lat, lon: ci.lon }); }
    }
    return { seaIdx, seaCoords };
  }

  // Fetch marine sea-state for the sea tiles' coords (ONE batched call) and fold
  // waveHeight back onto the per-tile weather array in place. The coords are
  // coverage-filtered FIRST via marineModule.splitCoverage — an out-of-grid coord
  // (e.g. a −81°S ice-shelf tile centre) 400s the WHOLE batch — and the response
  // is re-expanded so seaIdx alignment is preserved: excluded/missing tiles get
  // waveHeight:null (ABSENT, never fabricated as calm). On TOTAL failure every sea
  // tile is NULLED (DR-15) — leaving a STALE waveHeight would read as a measured
  // sea, the very lie this path exists to prevent; null renders as the honest
  // NO-DATA test-card. Returns { ok, error? }. marineModule = require('./marine').
  async function refreshMarine(weatherArr, seaIdx, seaCoords, marineModule, fetchImpl) {
    if (!seaCoords.length) return { ok: true };
    try {
      const cov = marineModule.splitCoverage(seaCoords);
      const marine = cov.expand(await marineModule.fetchMarine(cov.fetchCoords, fetchImpl));
      for (let k = 0; k < seaIdx.length; k++) {
        const w = weatherArr[seaIdx[k]];
        if (w) w.waveHeight = marine[k] ? marine[k].waveHeight : null;
      }
      return { ok: true };
    } catch (e) {
      // total failure: null every sea tile so nothing survives as a "measured" sea.
      for (let k = 0; k < seaIdx.length; k++) {
        const w = weatherArr[seaIdx[k]];
        if (w) w.waveHeight = null;
      }
      return { ok: false, error: String(e) };
    }
  }

  // --- REPORTER: the 101st machine's aggregate + on-machine bulletin ---------
  // Drive the reporter through a full sweep and collect its bulletin AS DELIVERED
  // OVER THE TAPE (never read from RAM): broadcast RESET + the 100 tile frames +
  // a COMPOSE control frame (carrying the gateway's date/time string) on the
  // downlink; then reactively ACK/NAK each TEXT frame the reporter transmits on
  // its MIC uplink (retransmitting-by-NAK the way tile ACKs do), and reassemble
  // the sequence-numbered payloads into the final bulletin bytes.
  //
  // opts: { asm, tiles:[{addr,payload}], timeZ:[bytes], corrupt?, aggregateOnly?,
  //         maxFrames? }. Returns { seen, bytes (reassembled ZX81 codes), text,
  //         frames, retransmits, acks, repbuf, replen, state, down, up }.
  function driveReporter(m, opts) {
    const asm = opts.asm;
    const maxFrames = opts.maxFrames == null ? 6000 : opts.maxFrames;
    const peekVar = (name) => m.peek(asm.labels[name]);

    for (let i = 0; i < asm.bytes.length; i++) m.poke(asm.org + i, asm.bytes[i]);
    if (asm.dataSegments) for (const s of asm.dataSegments) for (let i = 0; i < s.bytes.length; i++) m.poke(s.addr + i, s.bytes[i]);   // FS2 T15 low-RAM tables
    m.poke(asm.labels.CORRUPT1, opts.corrupt ? 1 : 0);

    const down = new TapeBus(), up = new TapeBus();
    const T0 = m.tState();
    m.attachEar(down, -T0);
    m.attachMic(up, -T0);
    const st = m.cpu.getState(); st.pc = asm.org; m.cpu.setState(st);

    // ---- downlink: RESET, the 100 tile frames, then COMPOSE(time) ----
    let cur = 2000;
    cur = FAST.modulateFrame(down, cur, REP.CMD_RESET, []) + 2000;
    for (const t of opts.tiles) cur = FAST.modulateFrame(down, cur, t.addr & 0xff, t.payload) + 2000;
    // Then a control frame: FLASH (compose one severe-weather flash for the scanned
    // hazard list entry `flash.index`) or COMPOSE (the routine bulletin). Both make
    // the reporter uplink TEXT frames, reassembled identically below.
    if (opts.flash)
      cur = FAST.modulateFrame(down, cur, REP.CMD_FLASH,
        [opts.flash.index & 0xff].concat(opts.flash.timeZ || [])) + 3000;
    else if (!opts.aggregateOnly)
      cur = FAST.modulateFrame(down, cur, REP.CMD_COMPOSE, opts.timeZ || []) + 3000;
    let downCursor = cur;

    // ---- aggregate-only: run until all tiles are folded in, then snapshot ----
    if (opts.aggregateOnly) {
      const nTiles = opts.tiles.length;
      for (let f = 0; f < maxFrames; f++) {
        m.runFrame();
        if (peekVar('SEENN') >= nTiles) break;
      }
      return { seen: peekVar('SEENN'), state: snapshotState(m, asm), down, up };
    }

    // ---- reactive ACK loop over the reporter's uplink TEXT frames ----
    let processed = 0, received = {}, sent = 0, retransmits = 0, acks = [];
    let finishing = -1;
    for (let f = 0; f < maxFrames; f++) {
      m.runFrame();
      if (finishing >= 0 && --finishing <= 0) break;
      const frames = FAST.demodulateAllText(up, 0, up.lastT + 1000);
      while (processed < frames.length) {
        const fr = frames[processed++];
        sent++;
        const seq = fr.seq & 0x7f, last = !!(fr.seq & 0x80), ok = fr.ok;
        let c = (m.tState() - T0) + 4000;
        if (c < downCursor) c = downCursor;
        downCursor = FAST.modulateAck(down, c, REP.REPORTER_ADDR, ok) + 3000;
        acks.push({ seq, ok, last });
        if (ok) {
          if (received[seq] === undefined) received[seq] = fr.payload;
          if (last) finishing = 60;      // let the machine consume the ACK + HALT
        } else retransmits++;
      }
    }

    // reassemble in sequence order
    const bytes = [];
    const seqs = Object.keys(received).map(Number).sort((a, b) => a - b);
    for (const s of seqs) for (const b of received[s]) bytes.push(b);
    const replen = m.peek(asm.labels.REPLEN) | (m.peek(asm.labels.REPLEN + 1) << 8);
    const repbuf = [];
    for (let i = 0; i < replen; i++) repbuf.push(m.peek(asm.labels.REPBUF + i));
    return {
      seen: peekVar('SEENN'), bytes, text: REP.fromZX(bytes), repbuf,
      replen, frames: sent, retransmits, acks, state: snapshotState(m, asm), down, up,
    };
  }

  // Read the reporter's on-machine aggregate state into a plain object (for the
  // aggregation proof to compare byte-for-byte against report.js aggregate()).
  function snapshotState(m, asm) {
    const P = (n) => m.peek(asm.labels[n]);
    const cyc = [];
    const cycn = P('CYCN');
    for (let i = 0; i < cycn; i++)
      cyc.push({ tile: m.peek(asm.labels.CYCTILES + i), tier: m.peek(asm.labels.CYCTIERS + i) });
    const haz = [];
    const hazn = P('HAZN');
    for (let i = 0; i < hazn; i++)
      haz.push({ tile: m.peek(asm.labels.HAZTILES + i), cls: m.peek(asm.labels.HAZCLS + i), val: m.peek(asm.labels.HAZVAL + i) });
    return {
      hotByte: P('HOTB'), hotTile: P('HOTT'), coldByte: P('COLDB'), coldTile: P('COLDT'),
      rainCnt: P('RAINN'), snowCnt: P('SNOWN'), roughSea: P('ROUGHS'), roughTile: P('ROUGHT'),
      cycCount: P('CYCCNT'), anyMajor: P('ANYMAJ'), seen: P('SEENN'), cyc, haz,
    };
  }

  const API = { tilePayload, tilePayloadV2, receiveTile, refreshWeather, seaTiles, refreshMarine,
    WEATHER_ICONS: ICON4,
    cycloneSubPoints, phenomenaSubPoints, impactScoutSubPoints,
    populationWeight, weatherImpactScore, selectImpactScoutTiles,
    detectCyclones, computePhenomena, computeImportance, selectFrontCandidates, computeTightestIsobar,
    computeWeatherFrontPage, applyEmergencies, applyFireZones, EMERGENCY_GLYPH, FRONT_CAP, matchNhcStorm, computePeriphery, findPressureCentres, kmPerCellAtLat, subCellForOffset,
    computeIsotherms, computeIsobars, computeIsotachs, computeSmoothGrad, computeSatellite, computeContourEdges, contourFrames, trackFrames, SUBTILE,
    driveReporter, snapshotState };
  g.WW_GATEWAY = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
