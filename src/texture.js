// texture.js — the SHARED per-cell renderer reference for the Weather Wall.
//
// This is the single source of truth for how a tile's compact payload
// [tempByte, precipByte, weatherCat, seaState, wind] expands into ZX81 display
// codes. It exists so the hand-written Z80 on-machine renderer (tools/listener.js)
// has an adversarial oracle: the emulated machine's display file must come out
// BYTE-IDENTICAL to tileDisplayRegion() here, for every category and sea state.
//
// It is tied to the ORIGINAL oracle (basic/weather-tile.bas) on the CLEAR/base
// path: with weatherCat = CLEAR and seaState = CALM, every cell equals the exact
// byte weather-tile.bas would POKE (temp shade, precip inverse). So:
//   Z80 == texture.js       (all categories + sea states)   <- proven here
//   texture.js == BASIC     (CLEAR + CALM base path)         <- proven here
//   => Z80 == BASIC on base weather (the hard-won invariant, preserved).
//
// Per-cell rules are deliberately kept to parity math (x&1, y&1, (x+y)&3) so the
// Z80 renderer mirrors them with only INC / AND / CP / JR. Dual module.
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const GL = (typeof require === 'function') ? require('./glyphs') : g.WW_GLYPHS;
  const BF = (typeof require === 'function') ? require('./bigfont') : g.WW_BIGFONT;
  const CP = (typeof require === 'function') ? require('./contour-plot') : g.WW_CONTOURPLOT;

  // Glyph codes (verified against the char ROM, tools/dump-chars.js):
  //   0x08 fine grey checker (fog veil / storm-cloud grey)
  //   0x09 bottom grey ripple (wave crest)
  //   0x17 '*' asterisk       (snow flake)
  //   0x80 solid inverse      (rain / storm band)
  //   --- radar-mode isotherm contour glyphs (half-block edges) ---
  //   0x01 top-left quadrant  (uniform LAND TINT — replaces the temp grey fill)
  //   0x03 top-half solid     (isotherm on the tile's NORTH edge)
  //   0x83 bottom-half solid  (isotherm on the SOUTH edge; = inverse of 0x03)
  //   0x05 left-half solid    (isotherm on the WEST edge)
  //   0x85 right-half solid   (isotherm on the EAST edge; = inverse of 0x05)
  //   0x80 solid              (isotherm corner node where two segments meet)
  const G = { VEIL: 0x08, GREY: 0x08, WAVE: 0x09, SNOW: 0x17, INV: 0x80, BLANK: 0x00,
    TINT: 0x01, ISO_N: 0x03, ISO_S: 0x83, ISO_W: 0x05, ISO_E: 0x85, ISO_CORNER: 0x80 };

  // Isotherm edge-mask bits carried in the low nibble of the isoByte (7th payload
  // byte). A bit is set when the neighbouring tile sits in a DIFFERENT temperature
  // band, so a contour line is drawn along that shared edge. Mirror src/layout.js.
  const ISO = { N: 1, S: 2, W: 4, E: 8 };

  // Weather categories (what the gateway sends as the weatherCat byte).
  const CAT = { CLEAR: 0, CLOUD: 1, FOG: 2, DRIZZLE: 3, RAIN: 4, SNOW: 5, THUNDER: 6 };
  // Sea states (from the marine wave height).
  const SEA = { CALM: 0, LIGHT: 1, MODERATE: 2, HIGH: 3, STORM: 4, NODATA: 5 };
  // Cyclone tiers + sub-tile positions (mirror src/layout.js).
  const CYC = { NONE: 0, STORM: 1, CYCLONE: 2, MAJOR: 3 };
  const SUB = { CENTER: 0, NW: 1, NE: 2, SW: 3, SE: 4 };
  // Teletext pages (mirror src/layout.js). The paged renderer draws ONE variable
  // per view; TEMP/SEA/RADAR reuse the base fill loop, WEATHER/WIND add a stamp.
  const PAGE = { TEMP: 0, WEATHER: 1, WIND: 2, SEA: 3, RADAR: 4, PRESSURE: 5, SATELLITE: 6 };

  // --- cyclone marker: a 7x7 "eye + spiral arms" stamp, drawn OVER the base
  // texture at the triggering sample's sub-tile position. A skip cell (SK) leaves
  // the underlying texture showing; INK arms are solid inverse; the eye is BLANK.
  // The 4 rotation phases (glyphs.js) let the machine spin the spiral; phase 0 is
  // byte-identical to the original static stamp. S hemisphere mirrors columns
  // (Coriolis: CCW north, CW south). The Z80 embeds these BYTE-IDENTICAL tables.
  const SK = GL.SK, I = GL.INK, B = GL.EYE;
  const STAMP_W = GL.SW, STAMP_H = GL.SH, STAMP_CX = GL.SCX, STAMP_CY = GL.SCY;
  const STAMP_CYCLONE = GL.CYC_P0, STAMP_MAJOR = GL.MAJ_P0;   // phase 0 (static)
  const SUB_CELL = GL.SUB_CELL;
  // Return the phase-`phase` stamp for a tier, mirrored for the S hemisphere.
  function cycloneStampPhase(tier, phase, south) {
    let ph;
    if (tier >= CYC.MAJOR) ph = GL.MAJ_PHASES;
    else if (tier >= CYC.CYCLONE) ph = GL.CYC_PHASES;
    else return null; // STORM/NONE: no spiral (wind alone is not the signature)
    let st = ph[((phase | 0) % GL.NPHASE + GL.NPHASE) % GL.NPHASE];
    if (south) {
      const m = new Array(STAMP_W * STAMP_H);
      for (let y = 0; y < STAMP_H; y++)
        for (let x = 0; x < STAMP_W; x++) m[y * STAMP_W + x] = st[y * STAMP_W + (STAMP_W - 1 - x)];
      st = m;
    }
    return st;
  }
  function cycloneStamp(tier) { return cycloneStampPhase(tier, 0, 0); }

  // temp shade (dry, no precip) for a temperature byte — same ramp as BASIC.
  function shadeOf(tempByte) {
    return L.RAMP[L.byteToLevel(tempByte) - 1];
  }

  // Radar-mode isotherm contour for a LAND cell. Returns a contour glyph if the
  // cell lies on an active band-boundary edge of the tile, else null (keep the
  // base texture). The rule is per-cell (no cross-cell state) so the Z80 mirrors
  // it verbatim inside its cell loop. Two abutting tiles each draw their own seam
  // edge, so a boundary reads as one continuous line on the shared edge.
  function contourGlyph(x, y, iso) {
    const onN = (iso & ISO.N) && y === 0;
    const onS = (iso & ISO.S) && y === (L.TILE_H - 1);
    const onW = (iso & ISO.W) && x === 0;
    const onE = (iso & ISO.E) && x === (L.TILE_W - 1);
    const horiz = onN || onS, vert = onW || onE;
    if (horiz && vert) return G.ISO_CORNER;   // corner node
    if (onN) return G.ISO_N;
    if (onS) return G.ISO_S;
    if (onW) return G.ISO_W;
    if (onE) return G.ISO_E;
    return null;                              // interior -> keep base texture
  }

  // One LAND cell -> display code. shadeC is the dry base shade (the temp ramp in
  // classic mode; a uniform LAND TINT in radar mode); precipWet is the precip flag
  // (only consulted on the CLEAR/CLOUD base path, to match BASIC). `phase` drifts
  // the precip pattern (0 = the canonical on-machine frame; browser loops 1..N for
  // the radar-loop motion channel). `iso` (>=0) enables the isotherm contour
  // overlay (radar mode); null keeps the classic byte-for-byte behaviour.
  function landCell(x, y, cat, shadeC, precipWet, phase, iso) {
    const p = phase | 0;
    let base;
    switch (cat) {
      case CAT.FOG:                                   // light chequer haze veil (static)
        base = ((x + y) & 1) === 0 ? G.VEIL : shadeC; break;
      case CAT.DRIZZLE:                               // sparse inverse cells (25%), drifts
        base = ((x + y + p) & 3) === 0 ? G.INV : shadeC; break;
      case CAT.RAIN:                                  // dense inverse cells (50%), drifts
        base = ((x + y + p) & 1) === 0 ? G.INV : shadeC; break;
      case CAT.SNOW:                                  // sparse asterisk stipple (25%), drifts
        base = (((x + p) & 1) === 0 && ((y + p) & 1) === 0) ? G.SNOW : shadeC; break;
      case CAT.THUNDER:                               // bold inverse + storm grey, drifts
        base = ((x + y + p) & 1) === 0 ? G.INV : G.GREY; break;
      case CAT.CLEAR:
      case CAT.CLOUD:                                 // base only (cloud folds to base
      default:                                        // to keep the map legible)
        if (iso == null && precipWet && shadeC > 0 && shadeC < 0x80) base = (shadeC + 0x80) & 0xff;
        else base = shadeC;                           // radar CLEAR = plain tint (precip is the moving layer)
        break;
    }
    if (iso != null) {                                // radar: isotherm contour overrides the edge cell
      const c = contourGlyph(x, y, iso);
      if (c !== null) return c;
    }
    return base;
  }

  // One SEA cell -> display code. Calm = blank (crisp coastline, as before);
  // rising sea = progressively denser wave ripple; storm = inverse wave bands.
  // `iso` (>=0, PRESSURE page only) overlays the contour edge on top of the base
  // sea texture — isobars are a GLOBAL field (most systems sit over open ocean),
  // unlike isotherms/isotachs which stay land-only (the established RADAR
  // precedent). null/undefined keeps every other page byte-for-byte unchanged.
  function seaCell(x, y, seaState, iso) {
    let base;
    switch (seaState) {
      case SEA.LIGHT:                                 // sparse wave flecks (~12%)
        base = (((x + y) & 7) === 0) ? G.WAVE : G.BLANK; break;
      case SEA.MODERATE:                              // broken wave flecks (~25%)
        base = (((x + y) & 3) === 0) ? G.WAVE : G.BLANK; break;
      case SEA.HIGH:                                  // same density, inverse storm reserved for severity
        base = (((x + y) & 3) === 0) ? G.WAVE : G.BLANK; break;
      case SEA.STORM:                                 // unmistakable bands, not full soup
        base = ((y & 3) === 0) ? G.INV : (((x + y) & 3) === 0 ? G.WAVE : G.BLANK); break;
      case SEA.NODATA:                                // vertical grey bars — "no signal"
        // Missing marine data must NOT read as calm (the outage incident). Every
        // real sea texture is a diagonal ripple stipple or horizontal storm band;
        // vertical structure (and the grey glyph on sea) occurs nowhere else, so
        // this reads as a test-card, not weather.
        base = (x & 1) === 0 ? G.GREY : G.BLANK; break;
      case SEA.CALM:
      default:
        base = G.BLANK; break;
    }
    if (iso != null) {                                // PRESSURE: isobar contour over sea
      const c = contourGlyph(x, y, iso);
      if (c !== null) return c;
    }
    return base;
  }

  // One SATELLITE cell (FS7-T5) -> display code, INVERTED video: dark earth,
  // clouds lightening toward white. cloudLvl (0-3, from L.cloudLevel) sets the
  // brightness band; `night` kills the clear-sky daylight sheen so the terminator
  // reads (clouds still show on both sides — a real composite lights cloud tops
  // day and night). `term` is the day/night terminator's N/S/W/E edge mask and
  // overrides LAST on the satellite page.
  function satCell(x, y, cloudLvl, night, term, land, iceSuppress) {
    // INVERTED video (owner 2026-07-30: "the whole image should be inverted so clouds
    // appear white against a dark earth"): clear sky is solid ink over land and sea
    // alike (`land` is ignored — a satellite photographs clouds over both), with a
    // sparse daylight sheen speckle so the terminator reads on clear sky; rising
    // cloud bands lighten toward a white overcast deck.
    if (iceSuppress) {
      if (term) {
        const c = contourGlyph(x, y, term);
        if (c !== null) return c;
      }
      return ((x + y) & 3) === 0 ? G.GREY : G.BLANK;  // Antarctic ice sheet: bright, faintly textured
    }
    let base = (!night && ((x + y) & 7) === 0) ? G.GREY : G.INV;
    switch (cloudLvl) {
      case 1: if (((x + y) & 3) === 0) base = G.GREY; break;          // thin scatter
      case 2: if (((x + y) & 1) === 0) base = G.GREY; break;          // broken: grey checker
      case 3: base = ((x + y) & 3) === 0 ? G.GREY : G.BLANK; break;   // overcast deck: white
      default: break;                                                 // 0 / null -> bg only
    }
    if (term) {
      const c = contourGlyph(x, y, term);
      if (c !== null) return c;
    }
    return base;
  }

  // Dedicated machine terminator primitive (payload TERM byte): bits0-3 carry the
  // terminator edge mask, bit4 marks the night side. This is a renderer primitive,
  // not phen triples, so it cannot produce the previous dotted connector artifacts.
  function termCell(base, x, y, term) {
    const edge = term & 0x0f;
    if (edge) {
      const onN = (edge & ISO.N) && y <= 1;
      const onS = (edge & ISO.S) && y >= L.TILE_H - 2;
      const onW = (edge & ISO.W) && x <= 1;
      const onE = (edge & ISO.E) && x >= L.TILE_W - 2;
      if (onN || onS || onW || onE) return G.GREY;
    }
    // For non-SATELLITE pages the design-bible lesson is: show the terminator as
    // a machine-rendered edge, not a night hatch that fights the weather symbols.
    return base;
  }

  // Stamp the cyclone marker over an already-filled cell grid, at the triggering
  // sample's sub-tile position, at rotation `phase` (0 = static), mirrored for the
  // S hemisphere. Skip cells leave the base texture; clipped to the tile so an
  // edge position never writes out of bounds. Mirrored by the Z80.
  function stampCyclone(cells, tier, pos, phase, south) {
    const stamp = cycloneStampPhase(tier, phase | 0, south ? 1 : 0);
    if (!stamp) return;
    const c = SUB_CELL[pos | 0] || SUB_CELL[0];
    const cx = c[0], cy = c[1];
    for (let sy = 0; sy < STAMP_H; sy++)
      for (let sx = 0; sx < STAMP_W; sx++) {
        const v = stamp[sy * STAMP_W + sx];
        if (v === SK) continue;
        const x = cx + sx - STAMP_CX, y = cy + sy - STAMP_CY;
        if (x < 0 || x >= L.TILE_W || y < 0 || y >= L.TILE_H) continue;
        cells[y * L.TILE_W + x] = v;
      }
  }

  // Stamp the cyclone PERIPHERY spiral over an already-filled cell grid. The eye
  // tile draws a baked centred log-spiral (src/glyphs.js BAND_GRIDS[sizeIdx]) around
  // its eye, radius set by the km->cell bucket in the PERIPH byte, optionally L-R
  // mirrored about the eye (FLIP: southern-hemisphere CW spin). The stamp is centred
  // on the eye's sub-tile position (cyclonePos), clipped to the tile (a big storm
  // near the edge just clips — the bezel gap already breaks continuity). Arms paint
  // solid ink so the storm reads BOLD on its own tile (dominant vs a thunder glyph);
  // the gaps between the two arms + the inner hole (where the eye stamp draws AFTER
  // and wins) keep the eye crisp. Byte-identical to the Z80 listener.js stampband.
  function stampBand(cells, periphByte, cyclonePos) {
    const sizeIdx = L.periphSizeOf(periphByte);
    if (sizeIdx < 0) return;
    const grid = GL.BAND_GRIDS[sizeIdx]; if (!grid) return;
    const flip = L.periphFlipOf(periphByte);
    const c = GL.SUB_CELL[cyclonePos | 0] || GL.SUB_CELL[0];
    const cx = c[0], cy = c[1], FR = GL.BAND_FR, FS = GL.BAND_FS;
    for (let sy = 0; sy < FS; sy++)
      for (let sx = 0; sx < FS; sx++) {
        const gx = flip ? (FS - 1 - sx) : sx;             // mirror the spiral about the eye
        if (!grid[sy * FS + gx]) continue;
        const x = cx - FR + sx, y = cy - FR + sy;
        if (x < 0 || x >= L.TILE_W || y < 0 || y >= L.TILE_H) continue;
        cells[y * L.TILE_W + x] = G.INV;                  // 0x80 ink; transparent between arms
      }
  }

  // Stamp a big synoptic glyph (WEATHER page) centred on the tile. LAND tiles get
  // any category glyph. A SEA tile (centre cell is sea) gets ONLY the THUNDER
  // glyph — a thunderstorm over open ocean (WMO 95-99) is real weather worth
  // showing — and keeps the clean blank ocean for every other category. The glyph
  // ink (0x80) is opaque and wins the cell; 0-bits are transparent (the plain
  // land tint / blank ocean shows through), so it stays legible over water.
  // T14 (parent /cto #3): the THUNDER glyph BLINKS on-machine — its stamped cells
  // toggle between inverse (0x80, visible bolt) and plain (0x00, blank) on the render
  // PHASE, using the ZX81's real inverse-video attribute, so ONLY the bolt flashes,
  // not the whole tile (the old host-side CSS `filter:invert(1)` inverted everything).
  // Phase 0 is byte-identical to the original static stamp (0x80). Odd phases clear
  // the ink bit -> 0x00. Only THUNDER blinks; every other category glyph is static.
  function stampGlyph(cells, cat, land, phase, pos) {
    const ci = (L.TILE_H >> 1) * L.TILE_W + (L.TILE_W >> 1);
    // Sea tiles draw RAIN..GALE (rain/snow/thunder/heat/cold/gale) glyphs; the
    // subtle CLEAR/CLOUD/FOG/DRIZZLE marks stay off the ocean. Mirrors the Z80.
    if (!land[ci] && (cat | 0) < CAT.RAIN) return;
    const rows = GL.CAT_GLYPHS[cat | 0]; if (!rows) return;
    // THUNDER blinks (T14); the EMERGENCY FIRE glyph (index 10) blinks the same way
    // (owner 2026-07-31: animated fires alongside thunder + cyclones). Mirrors Z80 sgl_blink.
    const blink = (cat | 0) === CAT.THUNDER || (cat | 0) === 10;
    const ink = (blink && ((phase | 0) & 1)) ? (I & 0x7f) : I;
    // SUB-TILE position (owner 2026-07-31: glyphs centered over the weather they
    // report): a tier-NONE tile's byte5 pos bits shift the 16x12 stamp into the
    // half-tile quadrant nearest its cluster centroid — the cyclone sub-position
    // idiom. CENTER (0) is byte-identical to the fixed centre stamp. Mirrors Z80
    // GPOSTAB in stampglyph.
    const p = pos | 0;
    const x0 = (p === L.SUB.NW || p === L.SUB.SW) ? 0
      : (p === L.SUB.NE || p === L.SUB.SE) ? L.TILE_W - GL.GW
      : GL.GCX - (GL.GW >> 1);
    const y0 = (p === L.SUB.NW || p === L.SUB.NE) ? 0
      : (p === L.SUB.SW || p === L.SUB.SE) ? L.TILE_H - GL.GH
      : GL.GCY - (GL.GH >> 1);
    for (let r = 0; r < GL.GH; r++)
      for (let c = 0; c < GL.GW; c++)
        if ((rows[r] >> (GL.GW - 1 - c)) & 1) {
          const x = x0 + c, y = y0 + r;
          if (x >= 0 && x < L.TILE_W && y >= 0 && y < L.TILE_H) cells[y * L.TILE_W + x] = ink;
        }
  }

  // --- FS7 micro-phenomena stamp (WEATHER page) -------------------------------
  // Stamp a tile's phen list — each entry {x, y, code} is ONE display code written
  // OPAQUELY at the phenomenon's exact sample cell (clipped to the 32x24 tile).
  // This REPLACES the big 16x12 category glyph on a modern (phen-carrying)
  // tier<CYCLONE WEATHER tile: a CLEAR/CLOUD tile has an EMPTY list and so draws
  // nothing (sparse map), while fog/drizzle/rain/snow/thunder draw their one-cell
  // MICRO mark (src/glyphs.js MICRO). THUNDER (0x98, inverse '/') carries the 0x80
  // ink bit; on ODD render phases that bit is cleared (0x98 -> 0x18) so ONLY the
  // bolt blinks — the micro-scale twin of the T14 whole-glyph blink. The AND-0x7f
  // is a no-op for the non-ink marks (fog/drizzle/rain/snow lack bit7), so only the
  // THUNDER cell toggles across phases. Mirrored byte-for-byte by the Z80 stampphen.
  function stampPhen(cells, phen, phase) {
    if (!phen) return;
    const odd = (phase | 0) & 1;
    for (let k = 0; k < phen.length && k < L.PHEN_MAX; k++) {
      const q = phen[k];
      const x = q.x | 0, y = q.y | 0;
      let code = q.code & 0xff;
      if (odd) code &= 0x7f;                          // odd phase: clear the ink bit
      if (!code || x < 0 || x >= L.TILE_W || y < 0 || y >= L.TILE_H) continue;
      cells[y * L.TILE_W + x] = code;
    }
  }


  // --- on-machine text primitive (FS2 §B) -------------------------------------
  // Write an array of ZX81 CHARACTER CODES left-to-right starting at cell (x,y),
  // OPAQUE (each code overwrites the underlying cell), clipped to the 32x24 tile.
  // The ULA expands each code through the ROM font at scan time, so a "text" cell
  // is just its char code in the display file — proven by tools/spike-charset-blit.js.
  // Mirrored on the machine by the listener's stamptext-style running-HL write.
  function stampText(cells, codes, x, y) {
    if (y < 0 || y >= L.TILE_H) return;
    for (let i = 0; i < codes.length; i++) {
      const cx = (x | 0) + i;
      if (cx < 0 || cx >= L.TILE_W) continue;         // clip to the tile
      cells[y * L.TILE_W + cx] = codes[i] & 0xff;
    }
  }
  // --- FS2 T15: BLOCK-FONT text primitive (enlarged name/pressure) -----------------
  // Write an array of ZX81 CHARACTER CODES left-to-right starting at cell (x,y), each
  // as a 2-cell-wide x 3-cell-tall block glyph (src/bigfont.js), OPAQUE (every cell of
  // the glyph footprint — ink AND blank — overwrites the underlying cell), clipped
  // per-cell to the 32x24 tile. Opaque blanks are deliberate: they give the text a
  // clean box so it stays byte-identical across animation phases (the spiral can't
  // bleed through the glyph gaps) and reads high-contrast over any base texture.
  // Mirrored on the machine by the listener's stampbigtext running-cell writer.
  function stampTextBig(cells, codes, x, y) {
    for (let i = 0; i < codes.length; i++) {
      const gcells = BF.FONT_CELLS[BF.glyphIndex(codes[i] & 0xff)];
      const cx0 = (x | 0) + i * BF.ADVANCE;
      for (let cr = 0; cr < BF.GLYPH_CH; cr++) {
        const cy = (y | 0) + cr;
        if (cy < 0 || cy >= L.TILE_H) continue;         // clip row to the tile
        for (let cc = 0; cc < BF.GLYPH_CW; cc++) {
          const cxc = cx0 + cc;
          if (cxc < 0 || cxc >= L.TILE_W) continue;     // clip col to the tile
          cells[cy * L.TILE_W + cxc] = gcells[cr * BF.GLYPH_CW + cc] & 0xff;
        }
      }
    }
  }
  // 2x (cell-resolution) enlarged text: each glyph is RAW_CW x RAW_CH = 4x6 CELLS, one
  // cell per art pixel (set -> 0x80 ink, clear -> 0x00, OPAQUE), advance RAW_ADVANCE.
  // Used for the enlarged cyclone/fire NAME. Mirrored by the Z80 stampbigtext2x.
  function stampTextBig2x(cells, codes, x, y) {
    for (let i = 0; i < codes.length; i++) {
      const rows = BF.FONT_RAW[BF.glyphIndex(codes[i] & 0xff)];
      const cx0 = (x | 0) + i * BF.RAW_ADVANCE;
      for (let cr = 0; cr < BF.RAW_CH; cr++) {
        const cy = (y | 0) + cr;
        if (cy < 0 || cy >= L.TILE_H) continue;
        for (let cc = 0; cc < BF.RAW_CW; cc++) {
          const cxc = cx0 + cc;
          if (cxc < 0 || cxc >= L.TILE_W) continue;
          cells[cy * L.TILE_W + cxc] = ((rows[cr] >> (BF.RAW_CW - 1 - cc)) & 1) ? 0x80 : 0x00;
        }
      }
    }
  }
  // Centred left column for a 2x NAME of n glyphs anchored under an eye at cell cx:
  // centre on the eye, clamp so the (n*RAW_ADVANCE)-cell run stays on the 32-cell tile.
  // The Z80 stampname mirrors this arithmetic exactly.
  function nameOrigin2x(cx, n) {
    const w = n * BF.RAW_ADVANCE;
    const maxX = L.TILE_W - w;                          // may be < 0 for an over-wide name
    let x0 = (cx | 0) - (w >> 1);
    if (maxX < 0 || x0 < 0) x0 = 0; else if (x0 > maxX) x0 = maxX;
    return x0;
  }
  // TEMP-page reading: the tile's temperature in °C as BIG WHITE digits knocked out of
  // a solid black plate, centred on the tile. The machine already holds tempByte
  // (°C+50), so it formats + stamps the number itself — no new payload. Built by
  // clearing a padded bounding box, drawing the block-font digits (+ a minus bar for
  // sub-zero), then inverting the whole box (^0x80) so digits read white on black over
  // any shade. Mirrored byte-for-byte by the Z80 stamptemp/st_core. Anchor is
  // parameterized (cx = plate centre col, cyd = digit row; plate rows cyd-1..cyd+3)
  // so the on-contour label path can stamp the same plate anywhere; the default
  // (16, 11) is the classic centred reading.
  function stampTempNumber(cells, tempByte, cx, cyd) {
    if (cx == null) cx = 16;
    if (cyd == null) cyd = 11;
    let c = ((((tempByte & 0xff) - 50) & 0xff) << 24) >> 24;   // °C, as the Z80's 8-bit signed SUB 50
    const neg = c < 0;
    let mag = Math.abs(c); if (mag > 99) mag = 99;
    const digs = mag >= 10 ? [(mag / 10) | 0, mag % 10] : [mag];
    const nch = digs.length + (neg ? 1 : 0);
    const W = nch * BF.ADVANCE;                      // cells wide (2 per glyph)
    const x = cx - (W >> 1), y = cyd;               // rows cyd..cyd+2, centred on (cx, cyd+1)
    const bx0 = x - 1, by0 = y - 1, bx1 = x + W, by1 = y + 3;
    const put = (xx, yy, v) => { if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] = v; };
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++) put(xx, yy, 0x00);  // clear plate box
    let dx = x;
    if (neg) { put(dx, y + 1, 0x80); put(dx + 1, y + 1, 0x80); dx += BF.ADVANCE; }              // minus bar (black -> white)
    for (const d of digs) {
      const g = BF.FONT_CELLS[BF.glyphIndex(28 + d)];
      for (let cr = 0; cr < BF.GLYPH_CH; cr++) for (let cc = 0; cc < BF.GLYPH_CW; cc++) put(dx + cc, y + cr, g[cr * BF.GLYPH_CW + cc]);
      dx += BF.ADVANCE;
    }
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++)                     // invert -> white digits on black
      if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] ^= 0x80;
  }

  // PRESSURE on-contour label: the isobar's own millibar value (PRESS_ISO_DATUM +
  // levelByte, e.g. 1004) as white block digits knocked out of a black plate — the
  // SAME clear/stamp/invert treatment as stampTempNumber, but UNSIGNED 3-4 digit.
  // Mirrored byte-for-byte by the Z80 fmt_press (stamplabels PRESSURE branch).
  function stampPressNumber(cells, levelByte, cx, cyd) {
    if (cx == null) cx = 16;
    if (cyd == null) cyd = 11;
    const mb = L.PRESS_ISO_DATUM + (levelByte & 0xff);   // 950..1205 — always 3-4 digits
    const digs = [];
    for (let v = mb; v > 0; v = (v / 10) | 0) digs.unshift(v % 10);
    const nch = digs.length;
    const W = nch * BF.ADVANCE;                      // cells wide (2 per glyph)
    const x = cx - (W >> 1), y = cyd;               // rows cyd..cyd+2, centred on (cx, cyd+1)
    const bx0 = x - 1, by0 = y - 1, bx1 = x + W, by1 = y + 3;
    const put = (xx, yy, v) => { if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] = v; };
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++) put(xx, yy, 0x00);  // clear plate box
    let dx = x;
    for (const d of digs) {
      const g = BF.FONT_CELLS[BF.glyphIndex(28 + d)];
      for (let cr = 0; cr < BF.GLYPH_CH; cr++) for (let cc = 0; cc < BF.GLYPH_CW; cc++) put(dx + cc, y + cr, g[cr * BF.GLYPH_CW + cc]);
      dx += BF.ADVANCE;
    }
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++)                     // invert -> white digits on black
      if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] ^= 0x80;
  }

  // Extratropical-low marker (FS2 §C.4): a BOLD/INVERSE 'L'. ZX81 char code for
  // 'L' is 49 (A-Z -> 38..63); OR 0x80 for the ULA inverse-video path => 0xB1.
  const EXTRATROPICAL_L = 0x80 | 49;   // 0xB1
  // Ordinary (sub-CYCLONE) pressure-centre markers (FS2 T11 §C.4): PLAIN char codes
  // (NO inverse) at the tile CENTRE. 'L' = 49, 'H' = 45 (A-Z -> 38..63). Distinct
  // from the bold/inverse 'L' (0xB1) and from the rotating spiral. Carried in the
  // FREE high bits of the periph byte (bits4-5) — see layout.periphCentreOf.
  const ORDINARY_L = 49, ORDINARY_H = 45;
  // T16 (UAT): the ordinary L/H marker is drawn ~2x in the T15 block font. Top-left
  // anchor of the 2-cell-wide x 3-cell-tall glyph, chosen so the footprint straddles
  // the tile centre (16,12): cols 15-16, rows 11-13. Must match the Z80 stampcentre.
  const ORD_CENTRE_COL = 15, ORD_CENTRE_ROW = 11;

  // --- FS2 T9/T14: cyclone NAME + MIN-PRESSURE static layer (§B draw-order) --------
  // Drawn LAST (after the spiral), every phase, as OPAQUE char-code writes at FIXED,
  // phase-INDEPENDENT cells, so they win the overdraw and are byte-identical across
  // all rotation phases (the spike's "static text over a rotating spiral" pattern).
  //
  // T14 (parent /cto #3): the pressure moved OUT of the eye. owner observed the digits
  // inside the 3-5 cell spiral eye were too small to read on the live wall. Both the
  // NAME and the PRESSURE sit BELOW the 7x7 stamp, LEFT-ALIGNED at the stamp's left
  // column (x = cx - STAMP_CX), stacked.
  //
  // T15 (UAT remediation): at the wall's 1:1 scale the single-cell name/pressure were
  // STILL too small to read. The PLACEMENT is unchanged; only the GLYPH SIZE grows —
  // both runs now render in the 2-cell x 3-cell BLOCK FONT (src/bigfont.js). Re-spaced
  // vertically for the taller glyphs:
  //   * NAME     top row = cy + 4  (occupies rows cy+4..cy+6)  — only when non-empty.
  //   * PRESSURE top row = cy + 7  (occupies rows cy+7..cy+9)  — directly under the name.
  // The eye stays clean (nothing is drawn in it). An UNNAMED cyclone still shows its
  // pressure at cy+7 (the name rows above it are simply left blank). Both runs are
  // clipped per-cell to the tile by stampTextBig (a bottom-edge sub-tile position may
  // clip the lower rows — the clip is the backstop, matching the single-cell behaviour).
  // The old in-eye placement + §C.6 tiny-eye DEGRADE branch (and the EYE_INNER_*
  // constants) stay retired: pressure has ONE fixed placement, no eye-width fit test.
  //
  // PRESSURE codes: the caller passes the DECODED hPa in opts.cyclonePressureHpa (an
  // integer 850..1105; the Z80 decodes the raw byte identically as 850+byte),
  // rendered as its decimal DIGIT codes (0-9 -> 28..37, matching report.zxCode).
  // NAME codes: opts.cycloneName carries the ZX81 char codes (transcoded from the NHC
  // feed; cap 10).
  function pressDigitCodes(hPa) {
    const s = String(hPa | 0);                         // 3-4 decimal digits, no leading zeros
    const out = [];
    for (let i = 0; i < s.length; i++) out.push(28 + (s.charCodeAt(i) - 48));
    return out;                                        // digit d -> code 28+d
  }
  // Draw a NAME as a white-on-black plate using the SMALL 2x3-cell block font (same size as
  // the TEMP-page numerals), centred on the tile, top row nameY. Reuses the stampTempNumber
  // technique: clear a padded box, draw the block-font glyphs, invert the box (^0x80 is the
  // clean visual inverse for the quadrant codes, e.g. top-half 0x03 <-> bottom-half 0x83).
  // Used for the wildfire caption (owner: match the temp numerals). Mirrored on the machine
  // (stampfirename: PLX0..PLY1 + platefill + stampbigtext).
  function plateNameSmall(cells, codes, nameY) {
    const n = codes ? codes.length : 0;
    if (n <= 0) return;
    const x0 = 16 - n;                                  // centre: width n*2, centre at col 16
    const nameW = n * BF.ADVANCE;                       // 2 cells/glyph
    const bx0 = x0 - 1, by0 = nameY - 1, bx1 = x0 + nameW, by1 = nameY + BF.GLYPH_CH;
    const put = (xx, yy, v) => { if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] = v; };
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++) put(xx, yy, 0x00);
    stampTextBig(cells, codes, x0, nameY);
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++)
      if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] ^= 0x80;
  }
  // Draw a NAME as a white-on-black plate (2x font), centred on `cx` (default: the
  // tile centre), top row nameY. The 2x font is pure 0x80/0x00 so the box inverts
  // cleanly to white-on-black. Used by the cyclone name (large, for typhoon
  // legibility). Mirrored on the machine (platebox/platefill).
  function plateName(cells, codes, nameY, cx) {
    const n = codes ? codes.length : 0;
    if (n <= 0) return;
    const x0 = nameOrigin2x(cx == null ? (L.TILE_W >> 1) : (cx | 0), n);
    const nameW = n * BF.RAW_ADVANCE;
    const bx0 = x0 - 1, by0 = nameY - 1, bx1 = x0 + nameW, by1 = nameY + 5;
    const put = (xx, yy, v) => { if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] = v; };
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++) put(xx, yy, 0x00);
    stampTextBig2x(cells, codes, x0, nameY);
    for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++)
      if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] ^= 0x80;
  }
  // Small-font name origin: width n*2 centred on `cx`, clamped on-tile.
  function nameOriginSmall(cx, n) {
    const w = n * BF.ADVANCE, maxX = L.TILE_W - w;
    let x0 = (cx | 0) - n;
    if (maxX < 0 || x0 < 0) x0 = 0; else if (x0 > maxX) x0 = maxX;
    return x0;
  }
  // Legacy caption top row: UNDER the eye when the block fits (name plate + pressure spans
  // nameY-1..nameY+6), else ABOVE it — plate box clear of the 7x7 stamp both ways.
  function captionNameY(cy) { return (cy <= 12) ? cy + 5 : cy - 10; }
  function stampNamePressure(cells, tier, pos, hPa, nameCodes, anchor) {
    const c = SUB_CELL[pos | 0] || SUB_CELL[0];
    const cx = c[0], cy = c[1];
    const n = nameCodes ? nameCodes.length : 0;
    if (n > 0) {
      // NAME + PRESSURE as a WHITE-ON-BLACK PLATE. T-DOWNSIZE (owner 2026-07-29: "the
      // hurricane name bars are HUGE... somewhere between current size and named fire
      // size" + "have the name bar under the hurricane/cyclone" + "pressure number is
      // currently a good size, so don't shrink that"): the name drops from the 2x
      // (4x6-cell) font to the SMALL 2x3 block font — the fire-caption size — and the
      // legacy placement moves from tile-centred/eye-OPPOSITE to centred on the EYE,
      // directly UNDER the stamp (top row cy+5), or above it (cy-10) when a low eye
      // leaves no room below. The pressure keeps its font, riding the row under the
      // plate. A SEA-BIAS anchor still overrides (host-picked; the candidate list now
      // prefers the under-eye spot). Mirrors the Z80 PANCH/PLAX/PLAY path.
      const pcx = anchor ? (anchor.cx | 0) : cx;
      const x0 = nameOriginSmall(pcx, n);
      const nameY = anchor ? (anchor.y | 0) : captionNameY(cy);
      const bx0 = x0 - 1, by0 = nameY - 1, bx1 = x0 + n * BF.ADVANCE, by1 = nameY + BF.GLYPH_CH;
      const put = (xx, yy, v) => { if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] = v; };
      for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++) put(xx, yy, 0x00);
      stampTextBig(cells, nameCodes, x0, nameY);
      for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++)
        if (xx >= 0 && xx < L.TILE_W && yy >= 0 && yy < L.TILE_H) cells[yy * L.TILE_W + xx] ^= 0x80;
      // PRESSURE: unchanged font, on the row below the plate (left-aligned to the name).
      if (hPa != null && isFinite(hPa)) stampTextBig(cells, pressDigitCodes(hPa), x0, nameY + BF.GLYPH_CH + 1);
    } else if (hPa != null && isFinite(hPa)) {
      // Unnamed cyclone: pressure only, at the original small-font placement.
      stampTextBig(cells, pressDigitCodes(hPa), cx - STAMP_CX, cy + 4);
    }
  }

  // tabLabelCells(codes) — the PAGE label plate (owner 2026-07-29: "it's unclear what the
  // loop represents if you're just jumping in from, say, a bluesky link... a per-tab
  // label on the lower left corner of the page in reverse video"; 2026-07-30: "far too
  // tiny. Should be the biggest text on the page"; 2026-07-30: "move the page namebars
  // to the top left corner"). The 2x RAW font — 4x6 CELLS per glyph, the enlarged
  // cyclone-name font, the biggest type the wall owns — anchored at the PAGE's
  // top-left corner: glyphs from x0=1, text rows 1-6, plate box rows 0..7 (the tile's
  // top edge). Returns the FINAL display codes as [{x, y, c}] with x UNCLIPPED — a
  // long label ("WILDFIRES AND SMOKE" = 76 glyph cells) runs far past x=31; the
  // caller splits the strip across the top-row tiles. Display-only host overlay (the
  // night/smoke poke idiom), re-applied per animation phase and per loop frame.
  function tabLabelCells(codes) {
    const n = codes ? codes.length : 0;
    if (n <= 0) return [];
    const x0 = 1, nameY = 1;                            // text rows 1-6, box 0-7 (top edge — owner 2026-07-30)
    const w = n * BF.RAW_ADVANCE;
    const grid = new Map();                              // virtual x -> code (box default 0)
    for (let yy = nameY - 1; yy <= nameY + BF.RAW_CH; yy++)
      for (let xx = x0 - 1; xx <= x0 + w; xx++) grid.set(yy * 4096 + xx, 0x00);
    for (let i = 0; i < n; i++) {
      const rows = BF.FONT_RAW[BF.glyphIndex(codes[i] & 0xff)];
      for (let cr = 0; cr < BF.RAW_CH; cr++)
        for (let cc = 0; cc < BF.RAW_CW; cc++)
          grid.set((nameY + cr) * 4096 + (x0 + i * BF.RAW_ADVANCE + cc),
            ((rows[cr] >> (BF.RAW_CW - 1 - cc)) & 1) ? 0x80 : 0x00);
    }
    const out = [];
    for (const [k, v] of grid) out.push({ x: k % 4096, y: (k / 4096) | 0, c: (v ^ 0x80) & 0xff });
    return out;
  }

  // pickPlateAnchor(landCells, n, hPa, pos) — SEA-BIAS plate placement (owner 2026-07-24:
  // the storm caption must never sit over land; bias it out to sea even at landfall).
  // Scores a small candidate set (3 centre cols x top/bottom rows) by LAND CELLS under
  // the full caption footprint (name plate box + pressure digits) using the tile's
  // coastline mask, and returns the least-land anchor {cx, y}. Ties prefer the LEGACY
  // spot (tile-centred, eye-opposite) so an all-sea tile renders byte-identically to
  // the pre-anchor build. Landfall tiles (no sea-clean spot) still get the least-land
  // choice — biased coastward, the best 32x24 cells can do. Host-side only (the tape
  // master owns the coastline mask); the wire ships the RESULT, the Z80 just stamps.
  function pickPlateAnchor(landCells, n, hPa, pos, periphByte, avoidCells) {
    if (!landCells || !(n > 0)) return null;
    // FIRE AVOIDANCE (owner QC 2026-07-29: Genevieve's plate "sits on top of california,
    // nevada, and a major fire, whereas below it is open ocean"): a flame-cluster cell
    // under the caption costs 10x — same as the storm graphic. The plate must never
    // paper over another phenomenon's story.
    const avoid = new Set();
    if (Array.isArray(avoidCells))
      for (const p of avoidCells)
        if (p && p.x >= 0 && p.x < L.TILE_W && p.y >= 0 && p.y < L.TILE_H)
          avoid.add((p.y | 0) * L.TILE_W + (p.x | 0));
    const c = SUB_CELL[pos | 0] || SUB_CELL[0];
    const eyeX = c[0], eyeY = c[1];
    // T-DOWNSIZE (owner 2026-07-29): the caption is the SMALL 2x3 font now, and the
    // preferred spot is UNDER the eye — the fire-caption pattern. Footprint = small
    // name plate (rows y-1..y+3) + the unchanged pressure digits (rows y+4..y+6).
    // caption block spans nameY-1 .. nameY+6 (plate + pressure), so valid rows are [1,17]
    // — an unclamped candidate half off the tile is worse than any on-tile compromise
    // (proof-plate-anchor caught y=23 clipping on a low eye).
    const clampY = (y) => Math.max(1, Math.min(L.TILE_H - 7, y));
    // BAND CLEARANCE (owner QC 2026-07-29, DOLPHIN: "the namebar steps on the lower
    // portion of the graphic symbol"): the drawn storm is the periphery spiral
    // (BUCKET_R cells), not just the 7x7 eye stamp — clear the caption past the FULL
    // band radius. r=3 (no band) reproduces the legacy captionNameY rows exactly
    // (below = cy+5, above = cy-10), so band-less callers are byte-identical.
    const sizeIdx = L.periphSizeOf(periphByte | 0);
    const r = Math.max(3, sizeIdx >= 0 ? GL.BUCKET_R[sizeIdx] : 0);
    // With a band, pad one extra row: the avoid-set dilates the arm ink by 1 cell, and
    // eyeY+r+2 puts the plate's TOP row exactly on that halo (the eye-column spot ate
    // phantom halo cost and lost to a detached side spot). Band-less keeps legacy rows.
    const pad = sizeIdx >= 0 ? 1 : 0;
    const belowY = clampY(eyeY + r + 2 + pad);
    const aboveY = clampY(eyeY - r - 7 - pad);
    const underY = (eyeY <= 12) ? belowY : aboveY;   // preferred side: room first
    const otherY = (eyeY <= 12) ? aboveY : belowY;
    const pressW = (hPa != null && isFinite(hPa)) ? pressDigitCodes(hPa).length * BF.ADVANCE : 0;
    // SPIRAL AVOIDANCE (owner QC 2026-07-29, Genevieve): a caption cell over the storm
    // graphic costs 10x a land cell — land under the plate is ugly, the plate over the
    // storm animation is broken. Priced against the ACTUAL DRAWN INK (7x7 eye stamp box
    // + the band's real spiral-arm cells, 1-cell dilated), not the band's bounding
    // square — the square's empty corners phantom-blocked genuinely clear sea (the
    // Genevieve bottom-left open Pacific). OFF-CENTRE eyes only (a CENTER eye grazes
    // everything; proof-plate-anchor pins it).
    const avoidEye = (pos | 0) !== SUB.CENTER;
    if (avoidEye) {
      const mark = (x, y) => { if (x >= 0 && x < L.TILE_W && y >= 0 && y < L.TILE_H) avoid.add(y * L.TILE_W + x); };
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) mark(eyeX + dx, eyeY + dy);
      if (sizeIdx >= 0) {
        const grid = GL.BAND_GRIDS[sizeIdx], flip = L.periphFlipOf(periphByte | 0);
        const FR = GL.BAND_FR, FS = GL.BAND_FS;
        for (let sy = 0; sy < FS; sy++)
          for (let sx = 0; sx < FS; sx++) {
            const gx = flip ? (FS - 1 - sx) : sx;          // same mirror as stampBand
            if (!grid[sy * FS + gx]) continue;
            const x = eyeX - FR + sx, y = eyeY - FR + sy;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mark(x + dx, y + dy);
          }
      }
    }
    const score = (pcx, y) => {
      const x0 = nameOriginSmall(pcx, n);
      const nameW = n * BF.ADVANCE;
      let cost = 0;
      const count = (xa, xb, ya, yb) => {
        for (let yy = Math.max(0, ya); yy <= Math.min(L.TILE_H - 1, yb); yy++)
          for (let xx = Math.max(0, xa); xx <= Math.min(L.TILE_W - 1, xb); xx++) {
            if (landCells[yy * L.TILE_W + xx]) cost++;
            if (avoid.has(yy * L.TILE_W + xx)) cost += 10;   // storm ink / flame / phenomenon cell
          }
      };
      count(x0 - 1, x0 + nameW, y - 1, y + BF.GLYPH_CH);            // small name plate box
      if (pressW) count(x0, x0 + pressW - 1, y + BF.GLYPH_CH + 1, y + BF.GLYPH_CH + 3);  // pressure digits
      // ATTACHMENT (owner 2026-07-29, option A: "name bar under the hurricane... where
      // possible"): horizontal drift off the eye column is PRICED (2/cell), so the
      // caption stays visually attached to its storm unless the eye column is worse
      // (land, fire, graphic overlap). 2/cell (was 3) after Genevieve second QC: a
      // CA/NV land shelf (36 cells) must LOSE to the open ocean 16 columns away
      // (cost 32) — sea-bias beats attachment when the eye column is that dirty.
      cost += 2 * Math.abs((pcx | 0) - eyeX);
      // VERTICAL drift too (owner third QC: the plate ended up "quite a ways above left...
      // no obvious link between the two" — a side spot 13 rows above the eye tied with
      // one right beside it). 1/row of plate-centre offset from the eye row, off-centre
      // eyes only (a CENTER eye keeps the legacy zero-vertical-cost contract).
      if (avoidEye) cost += Math.abs((y + 2) - eyeY);
      return cost;
    };
    // candidate order IS the tie-break preference: UNDER the eye first (owner's ruling),
    // then the side thirds LEVEL with the eye (nearest linked spot when the eye column
    // is dirty), then the west/east thirds of the clear rows.
    const eyeRowY = clampY(eyeY - 2);   // plate block ~vertically centred on the eye row
    const cands = [
      { cx: eyeX, y: underY }, { cx: eyeX, y: otherY },
      { cx: 8, y: eyeRowY }, { cx: 24, y: eyeRowY },
      { cx: 8, y: underY }, { cx: 24, y: underY },
      { cx: 8, y: otherY }, { cx: 24, y: otherY },
    ];
    let best = cands[0], bestS = score(cands[0].cx, cands[0].y);
    for (let i = 1; i < cands.length && bestS > 0; i++) {
      const s = score(cands[i].cx, cands[i].y);
      if (s < bestS) { best = cands[i]; bestS = s; }
    }
    return best;
  }

  // Stamp the WIND-page chevron/barb speed notation centred on the tile (T13/FS7).
  // COUNT of chevrons = wind-speed band (calm 0 -> nothing, breeze/wind/gale ->
  // 1/2/3 chevrons; the EXISTING L.WIND_BANDS thresholds), ORIENTATION = wind octant
  // — replacing the old bare direction arrow. Drawn on every tile so the wall reads
  // as one wind field (land + sea); the isotach contour (byte6) still draws alongside.
  function stampWind(cells, octant, band) {
    if ((band | 0) <= 0) return;
    const rows = GL.WIND_CHEVRONS[(octant | 0) & 7][(band | 0) & 3]; if (!rows) return;
    const x0 = GL.GCX - (GL.GW >> 1), y0 = GL.GCY - (GL.GH >> 1);
    for (let r = 0; r < GL.GH; r++)
      for (let c = 0; c < GL.GW; c++)
        if ((rows[r] >> (GL.GW - 1 - c)) & 1) {
          const x = x0 + c, y = y0 + r;
          if (x >= 0 && x < L.TILE_W && y >= 0 && y < L.TILE_H) cells[y * L.TILE_W + x] = I;
        }
  }

  // Stamp the WIND-page DRIFTING-DOT comets over the tile. `dots` is this tile's
  // per-phase overlay from src/windflow.js: a list of {i, c} (i = local cell
  // index y*32+x, c = char code — a solid head or a fading comet-trail cell).
  // The positions are the tape master's whole-cell particle field (poked-as-data,
  // coastline-mask model); the ZX81 renders the cells. Replaces the chevron on
  // the WIND page ("not just chevrons").
  //
  // CONTRAST (the whole reason the first cut failed): the WIND base fills LAND
  // with a per-cell TINT stipple (a grid of quadrant dots). A solid dot over that
  // stipple is indistinguishable from it — and carving a 1-cell blank channel is
  // just as invisible (the stipple is already half white). So on the dots path we
  // first THIN the land fill to a COASTLINE OUTLINE: any land cell whose 4
  // orthogonal neighbours are all land (a tile edge counts as land, so continents
  // spanning tiles keep a clean seam) is cleared to blank; only the shore cells
  // keep the tint. Land and sea then share a white background, over which the
  // SOLID black comets read at full contrast everywhere. The map stays legible as
  // an outline; the flow is unmistakable.
  function outlineLand(cells, land) {
    if (!land) return;
    const W = L.TILE_W, H = L.TILE_H;
    const isLand = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? true : !!land[y * W + x];
    const src = cells.slice();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!land[i]) continue;
        if (isLand(x - 1, y) && isLand(x + 1, y) && isLand(x, y - 1) && isLand(x, y + 1))
          cells[i] = G.BLANK;                 // interior land -> blank (keep shore)
        else cells[i] = src[i];               // shore cell -> leave the tint
      }
  }
  function stampWindDots(cells, dots, land) {
    if (!dots) return;
    outlineLand(cells, land);
    for (let k = 0; k < dots.length; k++) {
      const i = dots[k].i | 0;
      if (i >= 0 && i < cells.length) cells[i] = dots[k].c & 0xff;
    }
  }

  // Expand a tile payload against its baked land mask into the 768 cell codes
  // (row-major y*32+x). land: 768-length array/typed-array (0 = sea, else land).
  // Optional cycloneTier/cyclonePos stamp the storm marker on top (tier>=CYCLONE).
  //   opts.iso    — isotherm edge mask (radar mode). null/undefined -> classic
  //                 temp-shade fill, byte-identical to weather-tile.bas.
  //   opts.phase  — precip drift phase for the motion channel (default 0).
  function tileCells(opts) {
    const land = opts.land;
    const phase = opts.phase | 0;
    const cycPhase = opts.cyclonePhase | 0, cycSouth = opts.cycloneSouth ? 1 : 0;
    // Effective per-page fill parameters. When opts.page is set we draw ONE
    // variable (teletext page); otherwise we keep the legacy stacked render
    // (byte-identical to the BASIC oracle / prior proofs).
    let cat, sea, iso, shadeC, precipWet, glyphCat = -1, windOct = -1, windBand = 0, phen = null, seaIso = null;
    let satMode = false, cloudLvl = 0, satNight = false, satTerm = 0;
    const termByte = opts.termByte == null ? 0 : (opts.termByte | 0);
    if (opts.page != null) {
      const page = opts.page | 0;
      cat = CAT.CLEAR; precipWet = false; iso = null; sea = SEA.CALM;
      shadeC = G.TINT;                                  // dim land background
      switch (page) {
        case PAGE.TEMP:                                 // temp shade/stipple + isotherm edges over land
          shadeC = shadeOf(opts.tempByte & 0xff); iso = opts.iso | 0; break;
        case PAGE.SEA:                                  // sea hazards rendered by the emulated tile
          // The SEA page is a navigation-hazard chart, not an all-ocean texture map:
          // keep calm/light/moderate seas quiet and show only HIGH/STORM payloads.
          // PRESSURE/RADAR may still use the full sea texture separately.
          sea = (opts.seaState | 0) >= SEA.HIGH ? (opts.seaState | 0) : SEA.CALM;
          break;
        case PAGE.RADAR:                                // isotherm contours + moving precip
          iso = opts.iso | 0; cat = opts.weatherCat | 0; sea = opts.seaState | 0;
          precipWet = (opts.precipByte & 0xff) > 0; break;
        case PAGE.PRESSURE:                             // pressure shade/sea texture + global isobar contour
          shadeC = shadeOf(opts.tempByte & 0xff);
          sea = opts.seaState | 0; iso = opts.iso | 0; seaIso = opts.iso | 0;
          break;
        case PAGE.WEATHER:
          // byte6 bit6 = HOT/COLD numeric marker: the temperature reading is stamped
          // below (no glyph, no phen), mirroring the machine's pg_weather bit6 gate.
          if (((opts.iso | 0) & 0x40) !== 0) {
            // numeric marker — leave glyphCat/phen unset
          } else if ((opts.cycloneTier | 0) < CYC.CYCLONE && opts.phen != null) {
            // Modern WEATHER frames are the editorial synthesis layer: pictograms
            // and sparse conventional pressure H/L ride in phen. Legacy big glyphs
            // are used only for non-modern frames.
            phen = opts.phen;
          } else glyphCat = opts.weatherCat | 0;
          break;
        case PAGE.WIND:                                 // wind speed/direction rendered on-machine
          iso = opts.iso | 0;
          windOct = opts.windDir | 0;
          windBand = L.windBand(opts.windByte == null ? 0 : opts.windByte | 0);
          break;
        case PAGE.SATELLITE:                            // cloud-cover greyscale + day/night — GLOBAL
          satMode = true;
          cloudLvl = L.cloudLevel(opts.tempByte & 0xff);  // byte0 repurposed: raw cloud% on this page
          satNight = !!(((termByte || (opts.iso | 0)) & 0x10)); // TERM byte bit4, fallback to legacy byte6
          satTerm = (termByte || (opts.iso | 0)) & 0x0f;    // TERM byte, fallback to legacy byte6
          break;
      }
    } else {                                            // legacy stacked render
      cat = opts.weatherCat | 0; sea = opts.seaState | 0;
      const radar = opts.iso != null;
      iso = radar ? (opts.iso | 0) : null;
      shadeC = radar ? G.TINT : shadeOf(opts.tempByte & 0xff);
      precipWet = (opts.precipByte & 0xff) > 0;
    }
    // Smooth TEMP fill (opt-in): dither each LAND cell between adjacent RAMP chars so
    // the wall's temperature reads as a continuous gradient rather than 4 hard bands.
    // Gated to the TEMP page + the smoothTemp flag, so every other page and the classic
    // 4-level TEMP path are byte-identical when off. Increment 1 uses the single tile
    // centre value (a finer per-tile shade); the intra-tile gradient rides on later.
    const smoothLand = !!opts.smoothTemp && opts.page != null && (opts.page | 0) === PAGE.TEMP;
    const lf16Base = smoothLand ? L.tempToLevel16(opts.tempByte & 0xff) : 0;
    // Increment 2: within-tile gradient. gx8/gy8 are signed per-cell level steps in
    // 1/32-Lf16 units (gateway-derived from neighbouring tile centres). nw32 is the
    // level*32 value at cell (0,0); each cell's level = clamp(nw32 + gx8*x + gy8*y) >> 5.
    // gx8==gy8==0 collapses to lf16Base exactly (Increment 1), so the flat path is
    // byte-identical. Land tiles are ~24-32 cells wide, so this is the honest inter-
    // tile gradient smoothed across the tile, not fabricated sub-tile data.
    const gx8 = smoothLand ? (opts.smoothGx | 0) : 0;
    const gy8 = smoothLand ? (opts.smoothGy | 0) : 0;
    const nw32 = lf16Base * 32 - gx8 * 16 - gy8 * 12;
    const graded = smoothLand && (gx8 !== 0 || gy8 !== 0);
    const out = new Uint8Array(L.TILE_W * L.TILE_H);
    for (let y = 0; y < L.TILE_H; y++)
      for (let x = 0; x < L.TILE_W; x++) {
        const i = y * L.TILE_W + x;
        if (smoothLand && land[i]) {
          const c = (iso != null) ? contourGlyph(x, y, iso) : null;   // isotherm edge wins
          let lf16 = lf16Base;
          if (graded) {
            let raw = nw32 + gx8 * x + gy8 * y;
            if (raw < 512) raw = 512; else if (raw > 2048) raw = 2048;
            lf16 = raw >> 5;
          }
          out[i] = (c !== null) ? c : L.smoothShade(lf16, x, y);
        } else {
          out[i] = satMode ? satCell(x, y, cloudLvl, satNight, satTerm, land[i], !!(termByte & 0x20))
            : land[i] ? landCell(x, y, cat, shadeC, precipWet, phase, iso)
                      : seaCell(x, y, sea, seaIso);
        }
        if (!satMode && termByte) out[i] = termCell(out[i], x, y, termByte);
      }
    // MARCHING-SQUARES CONTOUR (TEMP isotherms / PRESSURE isobars — MACHINE-drawn, byte-exact
    // to the Z80 ct_run4/ct_emit path, MG=4 smooth). Each tile draws its own curves from the four SHARED
    // corner field bytes, so lines meet seam-to-seam across the wall (continuity is a property
    // of cross() depending only on the two shared corners). Runs right after the base fill and
    // before the phen/cyclone/number stamps, mirroring the listener's `CALL ct_hook` placement.
    // Opt-in via opts.corners, so every legacy frame (no corners) is byte-identical.
    // DENSE field takes precedence over corners (mirrors ct_hook's LEN>=36 branch:
    // a real 5x5 grid runs contourFromGrid directly, skipping the corner bilinear).
    if ((opts.fieldCells || opts.corners) && opts.contourLevels &&
        ((opts.page | 0) === PAGE.TEMP || (opts.page | 0) === PAGE.PRESSURE)) {
      const quad = opts.fieldCells
        ? CP.contourFromGrid(opts.fieldCells, opts.contourLevels)
        : CP.contourMG(opts.corners, opts.contourLevels);
      CP.stampContour(out, quad);
    }
    // WILDFIRE SMOKE hatch (WEATHER page, owner 2026-07-16 — MACHINE-drawn, byte-exact to
    // listener pgw_smoke). The smoke plume density (0..3) rides the sea byte on WEATHER
    // (sea is meaningless there). A one-way DIAGONAL lattice over BACKGROUND cells only
    // (BLANK/TINT), density by level, deliberately distinct from the night edge and the
    // precip stipple, so the fire glyph / coastline / marks read straight through the gaps.
    const smokeLvl = ((opts.page | 0) === PAGE.WEATHER) ? ((opts.smokeByte | 0) & 0x03) : 0;
    if (smokeLvl) {
      for (let y = 0; y < L.TILE_H; y++)
        for (let x = 0; x < L.TILE_W; x++) {
          const s = (x + y) & 3;
          const on = smokeLvl === 1 ? (s === 0) : smokeLvl === 2 ? ((x + y) & 1) === 0 : (s !== 1);
          if (!on) continue;
          const i = y * L.TILE_W + x;
          if (out[i] === G.BLANK || out[i] === G.TINT) out[i] = G.INV;
        }
    }
    if (opts.phen != null && !((opts.page | 0) === PAGE.WEATHER && (opts.cycloneTier | 0) < CYC.CYCLONE)) phen = opts.phen;
    const gpos = ((opts.cycloneTier | 0) === CYC.NONE) ? (opts.cyclonePos | 0) : 0;   // byte5 pos bits = glyph quadrant on tier-NONE tiles
    if (glyphCat >= 0) stampGlyph(out, glyphCat, land, phase, gpos);   // THUNDER/FIRE glyph blinks on phase
    // WIND page: drifting dots REPLACE the chevron when a windflow overlay is
    // supplied (the live browser wall); otherwise the classic chevron stamps
    // (tape/post/proof path unchanged, so every prior WIND proof stays green).
    if (windOct >= 0 && opts.windDots == null) stampWind(out, windOct, windBand);
    if (opts.windDots != null) stampWindDots(out, opts.windDots, land);
    if (phen) stampPhen(out, phen, phase);                        // symbolic machine marks/labels last
    // WILDFIRE NAME: a white-on-black caption plate in the SMALL (temp-numeral) block font,
    // HUGGING the flame — its top row (opts.fireNameRow) sits directly above or below the
    // flame cluster (computed in gateway.applyEmergencies), never edge-pinned to the opposite half.
    if (opts.fireName && opts.fireName.length && (opts.page | 0) === PAGE.WEATHER)
      plateNameSmall(out, opts.fireName, (opts.fireNameRow | 0) || 15);
    // FS2 §C spiral gate: a tier>=CYCLONE tile flagged SUPPRESS (extratropical —
    // no NHC match AND |lat|>=TROPICS_LAT) draws the bold/inverse 'L' marker and NO
    // spiral/periphery, so the DISPLAY matches the latitude-aware WIRE BULLETIN.
    // (T3/gateway already ships periphByte==0 for suppressed tiles; the !suppress
    // guard on stampBand below is belt-and-braces.) Non-suppressed tiles keep the
    // exact prior behaviour: periphery + spiral + hemisphere mirror.
    const cycTier = opts.cycloneTier | 0;
    const cycSuppress = opts.cycloneSuppress ? 1 : 0;
    if (cycTier >= CYC.CYCLONE && cycSuppress) {
      const c = SUB_CELL[opts.cyclonePos | 0] || SUB_CELL[0];
      stampText(out, [EXTRATROPICAL_L], c[0], c[1]);   // extratropical marker, no spiral
    } else {
      if (opts.periphByte) stampBand(out, opts.periphByte | 0, opts.cyclonePos | 0); // storm periphery spiral (under the eye)
      stampCyclone(out, cycTier, opts.cyclonePos | 0, cycPhase, cycSouth);
      // FS2 T9 (§B): name + pressure LAST, so they win the overdraw and are
      // byte-identical across every rotation phase (phase-independent static layer).
      // (PRESSURE-page live storms never reach here: the app ships them as FIELD
      // frames with the parametric well folded in — src/pressure-well.js — so the
      // machine draws the storm's own isobars and the plate rides the overlay path.)
      if (cycTier >= CYC.CYCLONE)
        stampNamePressure(out, cycTier, opts.cyclonePos | 0, opts.cyclonePressureHpa, opts.cycloneName, opts.plateAnchor || null);
    }
    // TEMP page: stamp the tile's temperature reading (big white digits on a black
    // plate), centred. Opt-in (opts.tempNumber) so every other page + the classic TEMP
    // proofs are byte-identical when off; the live TEMP page enables it.
    if ((opts.tempNumber && (opts.page | 0) === PAGE.TEMP) ||
        ((opts.page | 0) === PAGE.WEATHER && (((opts.iso | 0) & 0x40) !== 0)))
      stampTempNumber(out, opts.tempByte & 0xff);
    // On-contour TEMP labels (LEN 37+3N tail; docs/TEMP-LABEL-PLAN.md): host-placed
    // anchors quoting the isotherm's own level byte. Mirror of the Z80 stamplabels
    // loop — stamped LAST, after the centre reading, exactly like the machine.
    if ((opts.page | 0) === PAGE.TEMP && Array.isArray(opts.contourLabels))
      for (const lb of opts.contourLabels)
        stampTempNumber(out, lb.byte & 0xff, lb.x | 0, lb.y | 0);
    // On-contour PRESSURE labels (same LEN 37+3N tail): each isobar quotes its own
    // millibar value. Mirror of the Z80 stamplabels PRESSURE branch (fmt_press).
    if ((opts.page | 0) === PAGE.PRESSURE && Array.isArray(opts.contourLabels))
      for (const lb of opts.contourLabels)
        stampPressNumber(out, lb.byte & 0xff, lb.x | 0, lb.y | 0);
    // Ordinary (sub-CYCLONE) pressure-centre L/H: the machine no longer draws a small
    // block-font L/H here (owner QC: it read as a "little letter inside" the conventional
    // H/L). The centre bits (periphCentreOf, bits4-5) are still detected and now render
    // ONLY as the larger conventional 4x7 H/L on the phen path, so there is exactly one
    // marker per centre. periph-byte encoding / detection (findPressureCentres) unchanged.
    return out;
  }

  // Build the 793-byte display-file region exactly as the machine holds it:
  // [0] leading 0x76 newline, then 24 rows of (32 cells + trailing 0x76). This is
  // directly comparable to peek(D_FILE .. D_FILE+792) on a real emulated machine.
  const NL = 0x76;
  function tileDisplayRegion(opts) {
    const cells = tileCells(opts);
    const region = new Uint8Array(1 + L.TILE_H * L.DFILE_STRIDE); // 1 + 24*33 = 793
    region[0] = NL;
    for (let y = 0; y < L.TILE_H; y++) {
      const rowBase = 1 + y * L.DFILE_STRIDE;
      for (let x = 0; x < L.TILE_W; x++) region[rowBase + x] = cells[y * L.TILE_W + x];
      region[rowBase + L.TILE_W] = NL; // trailing newline of the row
    }
    return region;
  }

  const T = { CAT, SEA, CYC, SUB, ISO, PAGE, G, SK, STAMP_W, STAMP_H, STAMP_CX, STAMP_CY,
    STAMP_CYCLONE, STAMP_MAJOR, SUB_CELL, shadeOf, landCell, seaCell, satCell, contourGlyph,
    cycloneStamp, cycloneStampPhase, stampCyclone, stampGlyph, stampPhen, stampWind, stampBand,
    stampText, stampTextBig, EXTRATROPICAL_L, ORDINARY_L, ORDINARY_H, pressDigitCodes, stampNamePressure, pickPlateAnchor, tabLabelCells,
    stampTempNumber, stampPressNumber, tileCells, tileDisplayRegion };
  g.WW_TEXTURE = T;
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
})(typeof window !== 'undefined' ? window : globalThis);
