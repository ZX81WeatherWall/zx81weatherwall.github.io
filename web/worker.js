// worker.js — a burst receiver for the ZX81 Weather Wall. Each worker owns a
// ZX81 factory and the clone template; on each job it clones the template,
// runs the on-machine Z80 listener which decodes the tile's weather frame OFF
// THE TAPE BUS (its EAR line), draws the tile, and ACKs on its MIC. Nothing is
// host-poked. This is the "duty-cycled fleet": a machine runs at full speed ONLY
// while receiving + drawing its tile, then HALTs.

// The emulator/rom scripts were written for the browser and reference `window`.
// A worker has no `window`, so alias it to the worker global BEFORE loading them.
self.window = self;

importScripts(
  '../src/Z80.js',
  '../rom/zx81-rom.js',
  '../src/zx81.js',
  '../src/layout.js',
  '../src/contour-plot.js',
  '../src/contour-labels.js',
  '../src/clone.js',
  '../src/render.js',
  '../src/tapebus.js',
  '../src/glyphs.js',
  '../src/bigfont.js',
  '../src/texture.js',
  '../tools/z80asm.js',
  '../tools/z80-contour.js',
  '../tools/listener.js',
  '../src/tab-spec.js',
  '../src/weather-chart.js',
  '../src/gateway.js'
);

const L = self.WW_LAYOUT;
const CL = self.WW_CONTOURLABELS;
const CP = self.WW_CONTOURPLOT;
const clone = self.WW_CLONE;
const render = self.WW_RENDER;
const gw = self.WW_GATEWAY;
const listener = self.WW_LISTENER;
const texture = self.WW_TEXTURE;
const WCHART = self.WW_WEATHERCHART;

// How many distinct precip drift frames a category is worth (its parity period):
// drizzle ((x+y)&3) has 4; rain/snow/thunder are 2-state (a blink). Non-precip = 1.
function phaseCountFor(cat) {
  if (cat === L.CAT.DRIZZLE) return 4;
  if (cat === L.CAT.RAIN || cat === L.CAT.SNOW || cat === L.CAT.THUNDER) return 2;
  return 1;
}

let makeMachine = null;
let template = null;
let asm = null;
let STATUS_ADDR = 0, PHASEV_ADDR = 0, QUAD_ADDR = 0;

function factory() {
  return self.ZX81({ Z80: self.Z80, romB64: self.ZX81_ROM_B64, ram64k: false });
}

// Capture an on-machine animation straight from the machine's OWN loop: after the
// phase-0 frame, the machine free-runs (anim loop) advancing PHASEV. We sample the
// display file only when the machine flags STATUS=0xA2 ("phase ready", set AFTER the
// on-machine redraw), collecting one clean frame per distinct PHASEV in [0,maxPhases)
// — no host-side rotation, the Z80 draws every frame. Used for the rotating cyclone
// spiral (maxPhases = NPHASE) and the WEATHER-page THUNDER glyph blink (maxPhases = 2:
// phase 0 = bolt visible, phase 1 = bolt blank; T14).
function captureAnimFrames(m, bufs, maxPhases, nightCells, overlays) {
  // `overlays` (owner QC 2026-07-28, FIRE page: "why are big blocks of NA, EU and AF
  // flashing?"): the free-running machine REDRAWS its tile from PBUF each phase, which
  // wipes every host-poked overlay — the smoke field above all. bufs[0] carried the smoke,
  // the harvested flicker frames did not, and the motion ticker alternated them: the whole
  // plume (25-42% of a fire tile, measured live) blinked on and off. The flame flicker
  // itself is ~1.5% of the tile — that was never the flashing. Re-poke the overlays into
  // every settled phase before rendering, so only the machine's own animation animates.
  const seen = new Set([0]);
  let guard = 0;
  while (seen.size < maxPhases && guard++ < 3000) {
    m.runFrame();
    if (m.peek(STATUS_ADDR) === 0xA2) {
      const p = m.peek(PHASEV_ADDR);
      if (p < maxPhases && !seen.has(p)) {
        seen.add(p);
        if (overlays) overlays();
        applyNight(m, nightCells);
        bufs.push(render.renderRGBA(m).data.buffer);
      }
    }
  }
}

// Day/night terminator as GENUINE 1-bit machine cells (owner 2026-07-15): host draws
// NOTHING on the wall. app.js computes a per-cell night bitmap from real solar
// geometry; here we poke the ZX81 fine-checker char (0x08 — a 1-bit alternating
// pixel pattern, NOT a grey wash) into the night-side BACKGROUND cells of the tile
// the machine already drew, then the real ULA rasterises it. Only empty/dim-land
// background cells (BLANK 0x00 / land TINT 0x01) are dithered, so weather symbols,
// coastlines, contours and cyclones stay crisp and read straight through the night.
// Display-only: the tape/posting payload and the texture.js<->Z80 parity oracle are
// untouched (this pokes the finished display file, exactly as the ULA sees it).
function applyNight(m, nightCells) {
  if (!nightCells) return;
  const F = m.dfile();
  for (let y = 0; y < L.TILE_H; y++)
    for (let x = 0; x < L.TILE_W; x++) {
      const i = y * L.TILE_W + x;
      if (!nightCells[i]) continue;
      // Genuine 1-bit CROSS-HATCH (not the fine-checker char, which tiles into a flat
      // grey wash): solid ink on a diagonal lattice (~44% coverage), so the night side
      // reads as machine texture and weather/coastline shows straight through the gaps.
      if (((x + y) & 3) !== 0 && ((x - y) & 3) !== 0) continue;
      const a = F + 1 + y * L.DFILE_STRIDE + x;
      const c = m.peek(a);
      if (c === 0x00 || c === 0x01) m.poke(a, 0x80);
    }
}

// Wildfire SMOKE hatch (WEATHER page, owner 2026-07-16): a genuine 1-bit DIAGONAL hatch
// (one-way lattice), deliberately DISTINCT from the night cross-hatch and the dot-stipple
// precip so the four textures read apart — land dots · precip dots · smoke hatch · solid
// fire. Density rises with the plume level (1 light / 2 medium / 3 heavy). Display-only
// poke over the finished tile, like applyNight: only empty/tint background cells (0x00/
// 0x01) are hatched, so the fire glyph, coastline and marks read straight through.
function applySmoke(m, smokeByte) {
  const lvl = smokeByte | 0;
  if (!lvl) return;
  const F = m.dfile();
  // spacing: heavy = every 2nd diagonal, medium = every 3rd, light = every 4th
  const period = lvl >= 3 ? 2 : lvl === 2 ? 3 : 4;
  for (let y = 0; y < L.TILE_H; y++)
    for (let x = 0; x < L.TILE_W; x++) {
      if (((x + y) % period) !== 0) continue;   // one-way diagonal lattice
      const a = F + 1 + y * L.DFILE_STRIDE + x;
      const c = m.peek(a);
      if (c === 0x00 || c === 0x01) m.poke(a, 0x80);
    }
}

// Coast OUTLINE (WEATHER, owner 2026-07-21 — the radiofax convention): land draws as
// an outline, not a stipple fill, so the ink budget belongs to the weather. mask
// per cell: 0 sea / 1 interior land / 2 coast (computed globally in app.js so tile
// seams never read as false coastlines). Only rewrites cells still carrying the
// plain land TINT (0x01) — every symbol, plate, glyph and flame reads through.
// Runs BEFORE the smoke field, so interior land becomes background the plume can fill.
function applyCoastOutline(m, mask) {
  if (!mask) return;
  const F = m.dfile();
  for (let y = 0; y < L.TILE_H; y++)
    for (let x = 0; x < L.TILE_W; x++) {
      const v = mask[y * L.TILE_W + x];
      if (!v) continue;
      const a = F + 1 + y * L.DFILE_STRIDE + x;
      if (m.peek(a) === 0x01) m.poke(a, v === 2 ? 0x80 : 0x00);   // coast = solid black ink
    }
}

// Downwind smoke FIELD (WEATHER, docs/MONOCHROME-WX-DESIGN.md): per-cell graded
// Bayer-dither chars from src/smokeflow.js — a real advected concentration field,
// replacing the flat per-tile hatch. BACKGROUND-ONLY poke (0x00 empty / 0x01 land
// tint), so coastline, symbols, flames and plates read straight through the plume.
// Display-only, like applyNight/applyLines — pending its own Z80-native move.
function applySmokeField(m, cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const F = m.dfile();
  for (const cell of cells) {
    const x = cell.i % L.TILE_W, y = (cell.i / L.TILE_W) | 0;
    const a = F + 1 + y * L.DFILE_STRIDE + x;
    const c = m.peek(a);
    if (c === 0x00 || c === 0x01) m.poke(a, cell.c & 0xff);
  }
}

// WEATHER synoptic chart overlay (src/weather-chart.js, owner 2026-08-02 "lines
// not tone"): rain areas (scalloped outline + dot fill + contained pictogram)
// and gale pictograms as per-tile {i,c} lists. Poked in LIST ORDER (later wins)
// through WCHART.pokeable, which rewrites only background/chart cells — flames,
// spirals, plates, bolts and coastline always read through. Display-only, the
// applySmokeField idiom — pending its own Z80-native move.
function applyChart(m, cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const F = m.dfile();
  for (const cell of cells) {
    const x = cell.i % L.TILE_W, y = (cell.i / L.TILE_W) | 0;
    const a = F + 1 + y * L.DFILE_STRIDE + x;
    if (WCHART.pokeable(m.peek(a))) m.poke(a, cell.c & 0xff);
  }
}

// FIRE-page precip relief dots + wind streaks: background-only pokes (0x00/0x01),
// so flames, plates, coastline and smoke cores all read through. Streaks go last of
// the fields — the spread-driving wind must stay legible over the plume stipple.
// Per-tab identity label (owner 2026-07-29): the lower-left reverse-video page-name
// plate. OPAQUE poke — unlike the dot overlays it overwrites whatever is under it
// (the label must stay legible over smoke, night hatch, isolines, sea texture).
function applyLabelCells(m, cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const F = m.dfile();
  for (const cell of cells) {
    const x = cell.i % L.TILE_W, y = (cell.i / L.TILE_W) | 0;
    m.poke(F + 1 + y * L.DFILE_STRIDE + x, cell.c & 0xff);
  }
}
function applyDotCells(m, cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const F = m.dfile();
  for (const cell of cells) {
    const x = cell.i % L.TILE_W, y = (cell.i / L.TILE_W) | 0;
    const a = F + 1 + y * L.DFILE_STRIDE + x;
    const c = m.peek(a);
    if (c === 0x00 || c === 0x01) m.poke(a, cell.c & 0xff);
  }
}

// Surface FRONTS (WEATHER): line + pip cells from src/fronts.js (cold=triangle-read
// solid pips / warm=half-block pips / stationary=alternating sides, per the WPC
// radiofax convention). Fronts are LINES — they poke over area fills (smoke, night)
// like applyLines pokes isolines, so the synoptic backbone always reads.
function applyFront(m, cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const F = m.dfile();
  for (const cell of cells) {
    const x = cell.i % L.TILE_W, y = (cell.i / L.TILE_W) | 0;
    m.poke(F + 1 + y * L.DFILE_STRIDE + x, cell.c & 0xff);
  }
}

// Day/night terminator LINE (WEATHER): night-side edge cells from src/terminator.js
// solar geometry, poked as the grey chequer over BACKGROUND cells only (0x00/0x01),
// so glyphs, coastline, fronts and plates read straight through — the smooth
// replacement for the tile-grid termCell L's (7afcb38).
function applyTerm(m, cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const F = m.dfile();
  for (const i of cells) {
    const x = i % L.TILE_W, y = (i / L.TILE_W) | 0;
    const a = F + 1 + y * L.DFILE_STRIDE + x;
    const c = m.peek(a);
    if (c === 0x00 || c === 0x01) m.poke(a, 0x08);   // 0x08 = G.GREY chequer
  }
}

// Native isolines (isobars/isotherms): app.js rasterised the smooth marching-squares
// polylines into a per-cell mask (2 = major line, 1 = minor); poke them as machine
// ink over the finished display file. Display-only, like applyNight — the posting
// path and Z80 parity are untouched.
function applyLines(m, lineCells) {
  if (!lineCells) return;
  const F = m.dfile();
  for (let y = 0; y < L.TILE_H; y++)
    for (let x = 0; x < L.TILE_W; x++) {
      const v = lineCells[y * L.TILE_W + x];
      if (!v) continue;
      m.poke(F + 1 + y * L.DFILE_STRIDE + x, v === 2 ? 0x80 : 0x08);
    }
}

// Native pressure-centre H/L (owner 2026-07-15): the PRESSURE page marks each discrete
// synoptic HIGH with an 'H' and each LOW with an 'L' at the ovoid's centre cell.
// Like applyNight/applyLines this is a DISPLAY-ONLY poke over the finished display
// file (posting path + Z80 parity untouched) — but it writes BOTH ink (0x80) and
// paper (0x00): a black 5x7 letter wrapped in a 1-cell WHITE keyline halo. A phen
// mark can only ADD ink (stampPhen skips code 0x00), so the old phen 'L' vanished on
// the dark deep-low fill; the halo guarantees the letter reads on ANY fill — a solid-
// black low or a light high alike. The centre type rides the periph byte's centre
// bits (0x10=LOW, 0x20=HIGH), already sent on every PRESSURE tile + loop frame.
const CENTRE_GLYPH = {
  1: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], // LOW  -> 'L'
  2: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'], // HIGH -> 'H'
};
const CENTRE_W = 5, CENTRE_H = 7;
function applyCentres(m, page, periphByte, centreCell) {
  // Pre-existing PRESSURE host-poke H/L (owner 2026-07-15). WEATHER H/L must be Z80-native
  // (via the phen conventional H/L) under the strict-charm ruling — not host-poked here.
  if (page !== L.PAGE.PRESSURE) return;
  const rows = CENTRE_GLYPH[((periphByte | 0) >> 4) & 0x03];   // 1=LOW 2=HIGH, else none
  if (!rows) return;
  const F = m.dfile();
  // SUB-TILE placement (owner QC 2026-07-24): the marker sits on the dense field's actual
  // extremum node, inside the innermost closed isobar, NOT at the tile centre. Once the
  // isobars started marching the 5x5 field, a tile-centred glyph landed outside its own
  // loop whenever the extremum was off-centre in the tile. centreCell is the pre-clamped
  // top-left anchor from src/pressure-centres.js glyphAnchor; absent -> the legacy
  // tile-centre anchor (the coarse per-tile path has no node to point at).
  const ax = centreCell ? (centreCell.x | 0) : (L.TILE_W >> 1) - (CENTRE_W >> 1);   // 14
  const ay = centreCell ? (centreCell.y | 0) : (L.TILE_H >> 1) - (CENTRE_H >> 1);   // 9
  const isInk = (r, c) => r >= 0 && r < CENTRE_H && c >= 0 && c < CENTRE_W && rows[r][c] === '1';
  const poke = (x, y, v) => {
    if (x < 0 || x >= L.TILE_W || y < 0 || y >= L.TILE_H) return;
    m.poke(F + 1 + y * L.DFILE_STRIDE + x, v);
  };
  // Pass 1: white keyline halo (paper) around every stroke, so the black letter is
  // framed even on a solid-black low. Pass 2: the ink strokes overwrite any overlap.
  for (let r = 0; r < CENTRE_H; r++)
    for (let c = 0; c < CENTRE_W; c++) {
      if (!isInk(r, c)) continue;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if (!isInk(r + dr, c + dc)) poke(ax + c + dc, ay + r + dr, 0x00);
    }
  for (let r = 0; r < CENTRE_H; r++)
    for (let c = 0; c < CENTRE_W; c++)
      if (isInk(r, c)) poke(ax + c, ay + r, 0x80);
}

// Quiet the LAND on the scalar CHART pages (TEMP/PRESSURE). owner 2026-07-15 QC: on the
// live wall (real pressure/temperature variance) the land was filled with the temp/
// pressure RAMP shade — a SECOND encoding, distinct from the ocean and darkening warm/
// deep-low continents — that competed with the isobar/isotherm lines and H/L/number
// marks ("the colour schemes on the land masses themselves change"). The WEATHER page
// shows the target: land is a quiet LIGHT dotted silhouette (the bare TINT base map,
// char 0x01). Here we relight the finished display file's LAND background to that same
// TINT, so land locates as a silhouette and the DATA rides ONE treatment only — the
// poked isolines + H/L (applyLines/applyCentres, both drawn AFTER this) plus the on-
// machine TEMP number. That number is a white-on-black plate the Z80 stamps (bit6) at a
// FIXED centre box; when the tile centre is land the relight would wipe it, so its
// bounding box (mirrors texture.stampTempNumber / the Z80 stamptemp: rows 10..14, cols
// x-1..x+W, W=nch*2, x=16-(W>>1)) is skipped. Display-only, like applyNight/applyLines
// — the tape/posting payload and the texture.js<->Z80 parity oracle are untouched.
function relightLandQuiet(m, page, land, tempByte, hasLabel, contourMask, labels) {
  if (page !== L.PAGE.TEMP && page !== L.PAGE.PRESSURE) return;
  if (!land) return;
  const boxes = [];                          // plate skip boxes (empty on PRESSURE / unlabelled TEMP)
  if (page === L.PAGE.TEMP && hasLabel)      // legacy centred reading (non-field tile, iso bit6)
    boxes.push(CL.plateBox(16, 11, L.tempPlateChars(tempByte)));
  if (page === L.PAGE.TEMP && Array.isArray(labels))  // on-contour label plates (field-frame tail)
    for (const lb of labels) boxes.push(CL.plateBox(lb.x | 0, lb.y | 0, L.tempPlateChars(lb.byte)));
  const F = m.dfile();
  for (let y = 0; y < L.TILE_H; y++)
    for (let x = 0; x < L.TILE_W; x++) {
      const i = y * L.TILE_W + x;
      if (!land[i]) continue;                                     // ocean keeps its own treatment
      let onPlate = false;                                        // keep every reading plate
      for (const b of boxes) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) { onPlate = true; break; }
      if (onPlate) continue;
      if (contourMask && contourMask[i]) continue;                // spare the machine's own curve cells
      m.poke(F + 1 + y * L.DFILE_STRIDE + x, 0x01);               // G.TINT — quiet WEATHER-style silhouette
    }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    template = msg.template;
    makeMachine = factory;
    asm = listener.build(); // assemble the on-machine Z80 listener once
    STATUS_ADDR = asm.labels.STATUS; PHASEV_ADDR = asm.labels.PHASEV;
    QUAD_ADDR = asm.contourQUAD; // contour engine curve-mask buffer (for relightLandQuiet sparing)
    self.postMessage({ type: 'ready', id: msg.id });
    return;
  }
  if (msg.type === 'paint') {
    const t0 = (self.performance && self.performance.now) ? self.performance.now() : 0;
    const m = makeMachine();
    clone.restore(m, template);
    const page = msg.page | 0;
    // Paged frame (LEN 10): [temp, precip, cat, sea, wind, cyclone, iso, page,
    // windDir, periph]. The machine picks its draw routine by the page byte, stamps
    // the cyclone, and draws the contour lines locally — the gateway sends codes,
    // not pixels. byte6 (iso) is the SHARED contour edge-mask slot whose meaning
    // follows the active page (isotherm/isobar/isotach); app.js already selected
    // the right mask per page (mirrors gateway.tilePayload), so this relays it
    // verbatim to 0x6307. Consumed on TEMP/WIND/RADAR (land) + PRESSURE (land+sea).
    // Smooth-temp: the live TEMP page enables the on-machine Bayer dither via ISO
    // byte bit7 (the contour routine reads only the low nibble, so isotherm edges are
    // preserved). The poster/proof frames leave it off, so they stay byte-identical.
    // The TEMP page ignores precip (byte1) and wind (byte4), so on a smooth TEMP frame
    // those slots carry the within-tile gradient steps gx8/gy8 (Increment 2).
    // TEMP page: bit7 = smooth dither, bit6 = the temperature reading (white digits).
    const smoothTemp = page === L.PAGE.TEMP;
    // FIRE is an APP-level page: the machine renders the proven WEATHER routine
    // (flames, plates, phen micro-map), so the payload page byte maps FIRE->WEATHER.
    // Overlay decisions below still use the app page.
    const mpage = page === L.PAGE.FIRE ? L.PAGE.WEATHER : page;
    // Contour CORNERS (mirrors gw.tilePayload): a TEMP/PRESSURE tile carrying its four shared
    // corner bytes flags byte6 bit4 and clears the legacy iso low-nibble + bit5 (smooth/number
    // survive); the four corners ride at 11..14 and REPLACE the FS2/phen trailer (LEN 15).
    // DENSE continental field: a TEMP tile carrying its real 5x5 field (25 bytes) renders via
    // ct_run4f (LEN 36+ frame). Takes precedence over the 4-corner path; same byte6 bit4 flag
    // (ct_hook discriminates field vs corners by frame length).
    // TEMP corner frames are PROMOTED to field frames host-side (owner QC 2026-07-24, the
    // tape-loop's mid-tile temps): the 4-corner tile's 5x5 integer-bilinear lattice
    // (CP.bilinMG — the EXACT grid the Z80 ct_run4 samples before marching squares) ships
    // as fieldCells, so ct_run4f draws BYTE-IDENTICAL curves and the on-contour label
    // tail (LEN 37+3N) rides where the LEN-15 frame could only print a fixed centre
    // plate. PRESSURE keeps its LEN-15 corner frames (no label tail on that page yet).
    if (page === L.PAGE.TEMP && !msg.fieldCells && msg.corners) {
      const c = msg.corners, gv = new Array(25);
      for (let gy = 0; gy <= 4; gy++)
        for (let gx = 0; gx <= 4; gx++)
          gv[gy * 5 + gx] = CP.bilinMG(c.nw | 0, c.ne | 0, c.se | 0, c.sw | 0, gx, gy);
      msg.fieldCells = gv;
    }
    // FS2 trailer PRECEDENCE (owner 2026-07-24: name bar on all tabs): a non-suppressed
    // tier>=CYCLONE tile with a decodable pressure ships its name/pressure trailer
    // INSTEAD of field/corner bytes — the eye stamp + name plate own the tile (the
    // standing doctrine; the frame layout makes them mutually exclusive, and before
    // this the field/corner branch silently ate the trailer on TEMP/PRESSURE).
    // Byte-parity mirror of gw.tilePayload's cycTrailer gate.
    const tier = L.cycTierOf(msg.cyc | 0);
    const hasTrailer = tier >= L.CYC.CYCLONE && msg.pressureByte != null;
    // PRESSURE joins the dense-field path (DENSITY-PLAN build step 5): its 25 bytes are
    // per-node L.pressToByte values, so the machine marches CT_LVL_PRESS over real data
    // instead of bilinear-guessing isobars from four tile-centre corners. ct_hook now picks
    // the level table by PAGE *before* the LEN branch, so a field frame honours it too.
    const hasField = !hasTrailer && !!msg.fieldCells
      && (page === L.PAGE.TEMP || page === L.PAGE.PRESSURE);
    const hasCorners = !hasTrailer && !hasField && !!msg.corners && (page === L.PAGE.TEMP || page === L.PAGE.PRESSURE);
    // On-contour TEMP labels (docs/TEMP-LABEL-PLAN.md): the worker mirrors the tape
    // master, so it PLACES the labels its own field frame ships. The engine
    // (src/contour-labels.js) anchors each reading ON a level's marching-squares
    // curve, quoting that isotherm's own level byte — so the printed temperature
    // always agrees with the line under it. A flat field tile (no label-worthy
    // curve) falls back to a centred reading quoting the field's own middle node
    // (gv[12] IS the tile-centre lattice node), on the sparse (row+col) lattice.
    // Cyclone tiles carry no labels — the eye stamp + name plate own the tile.
    // TEMP only: the label engine quotes L.tempPlateChars, so a PRESSURE field frame ships
    // the tail with count 0 until fmt_press lands (docs/TEMP-LABEL-PLAN.md "Reuse on the
    // next tab") rather than stamping temperatures over isobars.
    let contourLabels = null;
    if (hasField && (page === L.PAGE.TEMP || page === L.PAGE.PRESSURE)
        && L.cycTierOf(msg.cyc | 0) < L.CYC.CYCLONE) {
      const row = ((msg.tile | 0) / 10) | 0, col = (msg.tile | 0) % 10;   // 10x10 wall
      // TAPE-LOOP frames (msg.frame set) label MAJOR (10degC) isotherms only, and skip
      // the centre-fallback plate (owner QC 2026-07-24): loop frames are corner-promoted
      // bilinear fields, so steep gradients pack the 5degC lines 1-2 cells apart —
      // labelling every level stamps a '20' and a '25' on what READS as one line, and
      // the checkerboard fallback drops centre readings beside lines they don't match.
      // The live still keeps every level + the fallback: its real 5x5 field separates
      // the curves and the centre node is a genuine lattice reading there.
      const isLoop = msg.frame != null;
      if (page === L.PAGE.PRESSURE) {
        // PRESSURE reuses the engine untouched (docs/TEMP-LABEL-PLAN.md "Reuse on the
        // next tab"): PRESS_ISO_LEVELS + pressPlateChars, and the H/L centre glyph's
        // box (applyCentres' halo footprint) is RESERVED so a millibar plate never
        // sits under the synoptic letter. Loop frames label every-8-MB only (corner-
        // promoted bilinear fields pack the 4 MB lines too tight — the TEMP majors
        // rationale). No centre-fallback plate: a flat pressure tile stays quiet.
        const levels = isLoop
          ? L.PRESS_ISO_LEVELS.filter((b) => L.pressLoopLabelLevel(b))
          : L.PRESS_ISO_LEVELS;
        const reserved = [];
        if (((msg.periph | 0) >> 4) & 0x03) {
          const ax = msg.centreCell ? (msg.centreCell.x | 0) : (L.TILE_W >> 1) - (CENTRE_W >> 1);
          const ay = msg.centreCell ? (msg.centreCell.y | 0) : (L.TILE_H >> 1) - (CENTRE_H >> 1);
          reserved.push({ x0: ax - 1, x1: ax + CENTRE_W, y0: ay - 1, y1: ay + CENTRE_H });
        }
        contourLabels = CL.placeLabels(msg.fieldCells, levels,
          { charsOf: (b) => L.pressPlateChars(b), row, col, reserved });
      } else {
        const levels = isLoop
          ? self.WW_Z80CONTOUR.LEVELS.filter((b) => (b - 50) % 10 === 0)
          : self.WW_Z80CONTOUR.LEVELS;
        contourLabels = CL.placeLabels(msg.fieldCells, levels,
          { charsOf: (b) => L.tempPlateChars(b), row, col });
        if (!contourLabels.length && !isLoop && ((row + col) & 1) === 0)
          contourLabels.push({ x: 16, y: 11, byte: msg.fieldCells[12] & 0xff });
      }
    }
    // byte6: TEMP dither (bit7, whole page) + number (bit6, SPARSE per SPEC.tempLabelForTile
    // — owner: not a number in all 100 tiles); WEATHER bit5 = wildfire free-run. A FIELD tile
    // never sets bit6: its readings ride the on-contour label tail instead (LEN 37+3N,
    // docs/TEMP-LABEL-PLAN.md), so the fixed centre plate would double-print.
    const iso6 = (msg.iso | 0) | (smoothTemp ? 0x80 : 0) | (smoothTemp && msg.tempLabel && !hasField ? 0x40 : 0);
    const iso6f = (hasField || hasCorners) ? ((iso6 & 0xc0) | 0x10) : iso6;
    const b1 = smoothTemp ? ((msg.smoothGx | 0) & 0xff) : msg.precipByte;
    const b4 = smoothTemp ? ((msg.smoothGy | 0) & 0xff) : (msg.wind | 0);
    // byte3 = sea state, EXCEPT on WEATHER where the slot carries the wildfire-smoke
    // plume density (0..3) — the machine hatches from it (mirrors gw.tilePayload).
    const b3 = mpage === L.PAGE.WEATHER ? ((msg.smokeByte | 0) & 0x03) : (msg.seaState | 0);
    const payload = [msg.tempByte, b1, msg.cat | 0, b3,
      b4, msg.cyc | 0, iso6f, mpage, msg.windDir | 0, msg.periph | 0,
      msg.termByte | 0];
    // FS2 §A + FS7: the cyclone NAME/min-PRESSURE trailer and the phen list are
    // MUTUALLY EXCLUSIVE per tile. This MUST be a byte-faithful mirror of
    // src/gateway.js tilePayload, so it is gated on the SAME discriminator — the
    // cyclone TIER read out of the cyclone byte — NOT on which optional field happens
    // to be set (the proofs only exercise gateway; a divergence here would misparse on
    // the live wall). tier>=CYCLONE -> FS2 name/pressure at byte 10 (app.js already
    // nulls pressureByte for a suppressed/no-pressure cyclone, so the trailer is
    // appended only when a decodable pressure travels); tier<CYCLONE WEATHER -> phen
    // list [10]=count then (x,y,code) triples (an EMPTY list still ships count=0 so the
    // machine draws the modern micro-map and drops the legacy big glyph). NEVER both —
    // a stray pressureByte on a sub-cyclone tile is ignored, exactly as gateway ignores
    // it. [10]=term, then [11]=pressure/[12]=nameLen/[13..]=name OR [11]=count/[12..]=triples.
    // (tier + hasTrailer computed above with the frame-type discriminators.)
    if (hasField) {
      const fc = msg.fieldCells;                    // bytes 11..35: real 5x5 field (row-major)
      for (let i = 0; i < 25; i++) payload.push(fc[i] & 0xff);
      // Contour-label tail (LEN 37+3N): [36]=count, then (x, y digit-row, levelByte)
      // triples — the on-contour readings placed above. Always appended on a field
      // frame (count 0 -> LEN 37); a label-less old ROM ignores the tail (ct_hook
      // copies exactly PBUF+11..35), degrading gracefully.
      const lbs = contourLabels || [];
      payload.push(lbs.length & 0xff);
      for (const lb of lbs) payload.push(lb.x & 0xff, lb.y & 0xff, lb.byte & 0xff);
    } else if (hasCorners) {
      const c = msg.corners;                       // bytes 11..14: nw, ne, se, sw (no trailer)
      payload.push(c.nw & 0xff, c.ne & 0xff, c.se & 0xff, c.sw & 0xff);
    } else if (tier >= L.CYC.CYCLONE) {
      if (msg.pressureByte != null) {
        const codes = msg.nameCodes || [];
        payload.push(msg.pressureByte & 0xff, codes.length & 0xff);
        for (let i = 0; i < codes.length; i++) payload.push(codes[i] & 0xff);
        // SEA-BIAS plate anchor (2 bytes after the name; named trailers only): the
        // host-picked least-land caption spot. LEN-gated on the machine (PANCH).
        if (codes.length && msg.plateAnchor)
          payload.push(msg.plateAnchor.cx & 0xff, msg.plateAnchor.y & 0xff);
      }
    } else if (Array.isArray(msg.phen)) {
      const phen = msg.phen;
      const n = Math.min(phen.length, L.PHEN_MAX);
      payload.push(n & 0xff);
      for (let k = 0; k < n; k++) payload.push(phen[k].x & 0xff, phen[k].y & 0xff, phen[k].code & 0xff);
      // FIRE NAME after the phen triples (WEATHER fire tile) — mirrors gw.tilePayload:
      // [nameRow, nameLen, ...codes]. nameRow is the caption's top cell row (hugs the flame).
      const fc = msg.fireNameCodes;
      if (mpage === L.PAGE.WEATHER && (iso6 & 0x20) && Array.isArray(fc) && fc.length) {
        payload.push((msg.fireNameRow | 0) & 0xff);
        payload.push(fc.length & 0xff);
        for (let i = 0; i < fc.length; i++) payload.push(fc[i] & 0xff);
      }
    }
    // receive this tile's frame over the tape bus (EAR), draw, ACK. This is the
    // CANONICAL frame (phase 0): byte-exact to src/texture.js.
    const r = gw.receiveTile(m, { asm, addr: msg.tile, land: msg.land, payload, maxRetransmit: 3 });
    // Machine curve mask: after ct_run4 drew this tile's smooth isotherms into its QUAD
    // buffer (768 cells, nonzero = a curve passes here), snapshot it so relightLandQuiet
    // can SPARE those cells from the quiet-land flatten. Only meaningful when the tile
    // carried corners (else no machine curve was drawn); otherwise leave the host isolines.
    let contourMask = null;
    if ((hasCorners || hasField) && QUAD_ADDR) {
      contourMask = new Uint8Array(L.TILE_W * L.TILE_H);
      for (let i = 0; i < contourMask.length; i++) contourMask[i] = m.peek(QUAD_ADDR + i);
    }
    // The full display-only overlay stack, poked over the machine's freshly-drawn tile
    // (night hatch UNDER, then quiet-land relight, isolines, H/L centres). Factored so a
    // scalar terminator SWEEP can re-lay the identical base under each marching night mask.
    function pokeOverlays(nightMask) {
      // Terminator + smoke are MACHINE-rendered now (termByte / smokeByte via the Z80
      // draw), not host pokes — strict charm. Only the isoline + H/L pokes remain here
      // (pending their own Z80-native move); nightMask is retained as a no-op arg for the
      // sweep call sites below.
      relightLandQuiet(m, page, msg.land, msg.tempByte, !!msg.tempLabel && !hasField, contourMask, contourLabels);  // TEMP/PRESSURE land -> quiet TINT, sparing machine curve cells + plates
      applyCoastOutline(m, msg.outlineMask);  // WEATHER/FIRE: land as outline, not fill (radiofax)
      applySmokeField(m, msg.smokeCells);  // WEATHER/FIRE: graded downwind smoke field (AREA, under the lines)
      applyDotCells(m, msg.precipCells);   // FIRE: precip relief dots (fire-relevant weather)
      applyDotCells(m, msg.windStreakCells); // FIRE: wind streaks (spread driver) over the fields
      applyLines(m, msg.lineCells);
      applyFront(m, msg.frontCells);       // WEATHER: front lines + pips (LINES, over the fields)
      applyTerm(m, msg.termLineCells);     // WEATHER: day/night terminator line (background cells only)
      applyChart(m, msg.chartCells);       // WEATHER: synoptic chart (rain areas + glyphs + gales), after term so lines layer right
      applyCentres(m, page, msg.periph, msg.centreCell);   // PRESSURE/WEATHER H/L centre letters (display-only poke)
      applyLabelCells(m, msg.labelCells);  // per-tab identity plate (lower-left) — LAST, wins over everything
    }
    // Snapshot the RAW received tile (pre-overlay) iff a scalar terminator sweep will
    // re-lay the overlays under a moving night mask per motion frame.
    const sweepTerm = Array.isArray(msg.nightFrames) && msg.nightFrames.length > 1;
    let rawCells = null;
    if (sweepTerm) {
      const F0 = m.dfile();
      rawCells = new Uint8Array(L.TILE_W * L.TILE_H);
      for (let y = 0; y < L.TILE_H; y++)
        for (let x = 0; x < L.TILE_W; x++)
          rawCells[y * L.TILE_W + x] = m.peek(F0 + 1 + y * L.DFILE_STRIDE + x);
    }
    // Native day/night: dither the night-side background cells straight into the
    // display file the machine just drew (SATELLITE carries its own satCell night,
    // so app.js sends no nightCells there — applyNight is a no-op then). Then poke the
    // native isolines (TEMP/PRESSURE) on top so isobars/isotherms read over the base.
    pokeOverlays(msg.nightCells);
    const img = render.renderRGBA(m); // {width,height,data:Uint8ClampedArray}
    const bufs = [img.data.buffer];

    const NPHASE = (self.WW_GLYPHS && self.WW_GLYPHS.NPHASE) || 4;
    const animated = L.cycAnimOf(msg.cyc | 0) && L.cycTierOf(msg.cyc | 0) >= L.CYC.CYCLONE;
    // SATELLITE cloud poke present: it repaints the WHOLE tile (the storm is the
    // raster's comma signature, not the sprite), so it must win this chain — an
    // animated storm tile would otherwise free-run the sprite spiral and the cloud
    // field would never land (owner QC 2026-07-30: storm tiles stayed hashed-stipple).
    const satPoke = page === L.PAGE.SATELLITE && Array.isArray(msg.satFrames) && msg.satFrames.length;
    // SEA wave poke: same precedence rule — a storm tile still flagged animated must
    // not free-run the sprite and eat the wave field (app.js zeroes cyc on SEA storm
    // tiles, but this guard keeps the chain honest for any other animation source).
    const seaPoke = page === L.PAGE.SEA && Array.isArray(msg.seaFrames) && msg.seaFrames.length;
    // WIND page, animated cyclone, drift dots present (owner QC 2026-07-28: DOLPHIN "no
    // swirling dots"): the free-run spiral harvest below would WIN this if/else and the
    // tile's windDots — the vortex swirl included — were computed and then thrown away.
    // The storm tile is where the swirl mostly LIVES (rOut ~9 cells barely spills onto
    // neighbours), so the composed dots+spiral path below must take precedence; it
    // rotates the spiral host-side via tileCells cyclonePhase, the RADAR branch's idiom.
    const windDotsCyc = page === L.PAGE.WIND && Array.isArray(msg.windDots);
    // FS7 T1 known-limitation (deferred to T11): the blink is gated on the tile's
    // CENTRE category (msg.cat). A THUNDER micro-mark from a SUB-TILE sample on a tile
    // whose centre category isn't THUNDER won't free-run, so that sub-sample bolt
    // renders steady rather than blinking (phase-0 bytes are unaffected).
    const thunderBlink = mpage === L.PAGE.WEATHER
      && ((msg.cat | 0) === L.CAT.THUNDER || (msg.cat | 0) === 10);   // 10 = EMERGENCY FIRE glyph, blinks too
    // A wildfire tile free-runs so its flame flickers on-machine (grey ember persists,
    // solid flame cells blink off on odd phases) — same 2-state harvest as the thunder blink.
    const fireBlink = mpage === L.PAGE.WEATHER && !!msg.fireAnim;
    if (animated && !windDotsCyc && !satPoke && !seaPoke) {
      // rotating cyclone: the machine kept running; harvest its phase frames.
      captureAnimFrames(m, bufs, NPHASE, msg.nightCells, pokeOverlays);
    } else if (thunderBlink || fireBlink) {
      // T14: WEATHER-page thunder tile — the machine free-runs and blinks its bolt
      // glyph on-machine. Harvest the 2 blink states (phase 0 visible, phase 1 blank);
      // the motion ticker in app.js alternates them like the precip radar loop.
      captureAnimFrames(m, bufs, 2, msg.nightCells, pokeOverlays);
    } else if (page === L.PAGE.RADAR) {
      // Radar precip "loop": the frozen machine's precip cells re-poked at drifted
      // phases (shared texture.js, phase 0 == the tape-driven frame). Base
      // (tint/coast/sea/isotherm/cyclone) is invariant, so only precip drifts.
      const phases = phaseCountFor(msg.cat | 0);
      if (phases > 1) {
        const F = m.dfile();
        const cycTier = L.cycTierOf(msg.cyc | 0), cycPos = L.cycPosOf(msg.cyc | 0);
        const cycSouth = L.cycSouthOf(msg.cyc | 0);
        for (let p = 1; p < phases; p++) {
          const cells = texture.tileCells({
            tempByte: msg.tempByte, precipByte: msg.precipByte, weatherCat: msg.cat | 0,
            seaState: msg.seaState | 0, land: msg.land, iso: msg.iso | 0, phase: p,
            termByte: msg.termByte | 0,
            page: L.PAGE.RADAR, windByte: msg.wind | 0, windDir: msg.windDir | 0,
            cycloneTier: cycTier, cyclonePos: cycPos, cycloneSouth: cycSouth,
            periphByte: msg.periph | 0,
            // FS2: a suppressed extratropical low draws the bold-L (no spiral); a
            // named cyclone keeps its name+eye-pressure — so precip drift frames
            // match the tape-driven phase-0 blit. cycloneName wants ZX char codes.
            cycloneSuppress: L.cycSuppressOf(msg.cyc | 0),
            cyclonePressureHpa: msg.pressureHpa, cycloneName: msg.nameCodes || [],
          });
          for (let y = 0; y < L.TILE_H; y++)
            for (let x = 0; x < L.TILE_W; x++)
              m.poke(F + 1 + y * L.DFILE_STRIDE + x, cells[y * L.TILE_W + x]);
          applyNight(m, msg.nightCells);
          applyLabelCells(m, msg.labelCells);
          bufs.push(render.renderRGBA(m).data.buffer);
        }
      }
    } else if (page === L.PAGE.WIND && Array.isArray(msg.windDots)) {
      // WIND "drifting dots" loop: the whole-wall orchestrator (app.js) ran the
      // windflow particle sim across ALL 100 tiles and handed this tile its
      // per-phase dot overlay (whole-cell positions, poked-as-data). The machine
      // draws the WIND base (dim land + sea, NO chevron) and the dot cells, then
      // the real ULA rasterises — same mechanism as the precip radar loop. Phase
      // 0 is re-drawn too (chevron retired), so bufs[0] is replaced.
      // WIND has no tape loop, so the day/night terminator sweeps HERE, composed with
      // the drift dots: the dots cycle fast (nDots phases), the night marches slowly
      // over its own nightFrames cycle. We harvest max(nDots, nNight) frames so both
      // advance; the eye reads the dots streaming while the terminator creeps westward.
      const F = m.dfile();
      const nDots = msg.windDots.length;
      const sweep = Array.isArray(msg.nightFrames) && msg.nightFrames.length > 1;
      const nNight = sweep ? msg.nightFrames.length : 1;
      const nph = Math.max(nDots, nNight);
      // A storm-owned WIND tile (owner 2026-07-28, design ruling): the WIND page shows the
      // storm as the SWIRL ITSELF — intense dots circling the eye — with only the name
      // plate + pressure beside it. NO spiral stamp, NO periphery band on this page: the
      // rotating graphic superimposed on the circling dots read as clutter, and the dots
      // ARE the storm here. stampNamePressure's legacy anchor already parks the plate on
      // the tile half OPPOSITE the eye, so the caption sits beside the swirl, not in it.
      // Every other page keeps the full spiral+band treatment (windDotsCyc gates WIND only).
      const cycTier = L.cycTierOf(msg.cyc | 0);
      const stormTile = cycTier >= L.CYC.CYCLONE && !L.cycSuppressOf(msg.cyc | 0);
      for (let p = 0; p < nph; p++) {
        const cells = texture.tileCells({
          tempByte: msg.tempByte, land: msg.land, iso: 0, termByte: msg.termByte | 0,
          page: L.PAGE.WIND, windByte: msg.wind | 0, windDir: msg.windDir | 0,
          seaState: msg.seaState | 0, windDots: msg.windDots[p % nDots],
        });
        if (stormTile)
          texture.stampNamePressure(cells, cycTier, L.cycPosOf(msg.cyc | 0),
            msg.pressureHpa, msg.nameCodes || [], null);
        for (let y = 0; y < L.TILE_H; y++)
          for (let x = 0; x < L.TILE_W; x++)
            m.poke(F + 1 + y * L.DFILE_STRIDE + x, cells[y * L.TILE_W + x]);
        applyNight(m, sweep ? msg.nightFrames[p % nNight] : msg.nightCells);
        applyLabelCells(m, msg.labelCells);
        const buf = render.renderRGBA(m).data.buffer;
        if (p === 0) bufs[0] = buf; else bufs.push(buf);
      }
    } else if (seaPoke) {
      // Native SEA swell: app.js computed a 1-bit rolling-swell raster per motion
      // frame; poke it into the SEA cells only. Land (owner 2026-08-05, tab-spec
      // 'coastline-outline'): white chart paper with a solid black coast, baked into
      // EVERY motion frame here so the ticker can never wipe it — outlineMask per
      // cell: 0 sea / 1 interior land -> blank / 2 coast -> ink. Without a mask
      // (legacy job) land keeps the machine coastline the tape frame drew. Same
      // display-only poke mechanism as the WIND dots / SATELLITE clouds.
      const F = m.dfile();
      const nf = msg.seaFrames.length, land = msg.land, omask = msg.outlineMask;
      for (let p = 0; p < nf; p++) {
        const cells = msg.seaFrames[p];
        for (let y = 0; y < L.TILE_H; y++)
          for (let x = 0; x < L.TILE_W; x++) {
            const i = y * L.TILE_W + x;
            if (land[i]) {
              if (omask) m.poke(F + 1 + y * L.DFILE_STRIDE + x, omask[i] === 2 ? 0x80 : 0x00);
              continue;
            }
            m.poke(F + 1 + y * L.DFILE_STRIDE + x, cells[i]);
          }
        // iso-wave-height contours ride OVER the swell texture on every motion
        // frame (the poke above just overwrote any earlier line lay-down)
        applyLines(m, msg.lineCells);
        applyLabelCells(m, msg.labelCells);
        const buf = render.renderRGBA(m).data.buffer;
        if (p === 0) bufs[0] = buf; else bufs.push(buf);
      }
    } else if (sweepTerm) {
      // Scalar terminator SWEEP (TEMP): rebuild the raw received tile and re-lay the
      // overlay stack under each MARCHING night mask, so the day/night boundary creeps
      // steadily westward as the motion ticker cycles the harvested frames — the same
      // clock-driven model satFrames uses. Frame 0 (already in bufs[0]) is wall-clock.
      const F = m.dfile();
      const nf = msg.nightFrames.length;
      for (let p = 1; p < nf; p++) {
        for (let y = 0; y < L.TILE_H; y++)
          for (let x = 0; x < L.TILE_W; x++)
            m.poke(F + 1 + y * L.DFILE_STRIDE + x, rawCells[y * L.TILE_W + x]);
        pokeOverlays(msg.nightFrames[p]);
        bufs.push(render.renderRGBA(m).data.buffer);
      }
    } else if (satPoke) {
      // Native SATELLITE cloud field: app.js computed full per-cell 1-bit cloud +
      // night rasters (motion frames) from the archived cloud field; poke each frame
      // into the display file and let the real ULA rasterise it — same display-only
      // mechanism as the WIND drift dots. Replaces the coarse per-tile satCell frame
      // (bufs[0]) and the retired host greyscale cloud overlay. The motion ticker
      // cycles the harvested frames so the cloud masses advect on-machine.
      const F = m.dfile();
      const nf = msg.satFrames.length;
      for (let p = 0; p < nf; p++) {
        const cells = msg.satFrames[p];
        for (let y = 0; y < L.TILE_H; y++)
          for (let x = 0; x < L.TILE_W; x++)
            m.poke(F + 1 + y * L.DFILE_STRIDE + x, cells[y * L.TILE_W + x]);
        applyLabelCells(m, msg.labelCells);
        const buf = render.renderRGBA(m).data.buffer;
        if (p === 0) bufs[0] = buf; else bufs.push(buf);
      }
    }

    const t1 = (self.performance && self.performance.now) ? self.performance.now() : 0;
    self.postMessage(
      { type: 'painted', tile: msg.tile, w: img.width, h: img.height, bufs,
        frame: msg.frame,   // FS7-T9 tape-loop frame index (null/undefined = live burst)
        gen: msg.gen,       // FS7-T9 build generation (echoed so app.js drops stale replies)
        frames: r.frames, acked: r.acked, attempts: r.attempts, ms: t1 - t0 },
      bufs
    );
  }
};
