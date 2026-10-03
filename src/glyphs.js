// glyphs.js — the SHARED byte tables for the teletext-page + animated-cyclone
// layers of the Weather Wall. This is the single source of truth: the JS
// reference renderer (src/texture.js) and the on-machine Z80 program
// (tools/listener.js, which injects these bytes verbatim as DB directives) both
// read from HERE, so "JS reference == Z80 DB" is true by construction — exactly
// the discipline the base texture tables already follow.
//
// Contents:
//   * cyclone spiral STAMPS (7x7) — phase 0 is byte-identical to the original
//     static marker; phases 1..3 are 45deg rotations used by the rotating-spiral
//     animation (the machine cycles them in its own loop; S hemisphere mirrors).
//   * synoptic GLYPHS (16x12, 1 bit/cell) — one big weather icon per land tile
//     for the WEATHER page (sun/cloud/fog/drizzle/rain/snow/thunder).
//   * wind CHEVRONS (16x12, 1 bit/cell) — a standard `>`/`>>`/`>>>` chevron stack
//     for the WIND page (8 octants x 3 bands): COUNT = wind-speed band, ORIENTATION
//     = wind octant. Replaces the old bare direction arrow (T13/FS7).
//
// Dual module: Node (require) and browser/worker (window/self global). No deps.
(function (g) {
  'use strict';

  // ===== cyclone spiral stamps (7x7) =====================================
  const SK = 0xff;               // skip: leave the underlying base texture
  const I = 0x80, B = 0x00;      // arm ink (solid inverse) / eye (blank)
  const SW = 7, SH = 7, SCX = 3, SCY = 3;
  // phase 0 — BYTE-IDENTICAL to the original STAMP_CYCLONE / STAMP_MAJOR so every
  // prior cyclone/motion proof stays green.
  const CYC_P0 = [
    SK, SK, SK, I, I, I, SK,
    SK, SK, SK, SK, SK, I, I,
    I, I, SK, SK, SK, SK, I,
    I, SK, SK, B, SK, SK, I,
    I, SK, SK, SK, SK, I, I,
    I, I, SK, SK, SK, SK, SK,
    SK, I, I, I, SK, SK, SK,
  ];
  const MAJ_P0 = [
    SK, SK, I, I, I, I, SK,
    SK, I, I, SK, SK, I, I,
    I, I, SK, SK, SK, SK, I,
    I, I, SK, B, SK, I, I,
    I, SK, SK, SK, SK, I, I,
    I, I, SK, SK, I, I, SK,
    SK, I, I, I, I, SK, SK,
  ];

  // Rotate a 7x7 stamp about its centre by `deg` (nearest-neighbour inverse map).
  // Screen y is DOWN; a POSITIVE deg here rotates the arms counter-clockwise as
  // seen on the wall (the Northern-Hemisphere Coriolis sense). The eye (centre)
  // is a fixed point, so it never smears. Cells that map outside the 7x7 -> skip.
  function rotateStamp(src, deg) {
    const rad = deg * Math.PI / 180;
    // inverse map: dest <- source at angle -theta. On a y-down raster, a CCW
    // on-screen rotation corresponds to the standard matrix with +theta applied
    // to (dx, -dy). We sample source = R(+theta) . dest.
    const c = Math.cos(rad), s = Math.sin(rad);
    const out = new Array(SW * SH).fill(SK);
    for (let dy = 0; dy < SH; dy++)
      for (let dx = 0; dx < SW; dx++) {
        const rx = dx - SCX, ry = dy - SCY;
        // rotate the dest vector by +theta (y-up), then read source
        const sxf = c * rx - s * (-ry);
        const syf = s * rx + c * (-ry);
        const sx = Math.round(sxf) + SCX;
        const sy = SCY - Math.round(syf);
        if (sx < 0 || sx >= SW || sy < 0 || sy >= SH) continue;
        out[dy * SW + dx] = src[sy * SW + sx];
      }
    // the centre eye is invariant under rotation — keep it crisp
    out[SCY * SW + SCX] = B;
    return out;
  }

  const NPHASE = 4;                 // 4 phases @ 45deg = one full 180deg (2-arm) cycle
  function phasesOf(base) {
    const ph = [];
    for (let k = 0; k < NPHASE; k++) ph.push(k === 0 ? base.slice() : rotateStamp(base, 45 * k));
    return ph;
  }
  const CYC_PHASES = phasesOf(CYC_P0);   // [4][49]
  const MAJ_PHASES = phasesOf(MAJ_P0);

  // sub-tile position -> marker centre cell (x,y) in the 32x24 tile.
  const SUB_CELL = { 0: [16, 12], 1: [8, 6], 2: [24, 6], 3: [8, 18], 4: [24, 18] };

  // ===== MICRO-GLYPHS: one cell per phenomenon (FS7 phen layer) ===========
  // A micro-glyph IS a single ZX81 display code — the machine "stamps" it by
  // writing ONE byte into its display file at the phenomenon's EXACT sample
  // cell (SUB_CELL[pos]). This REPLACES the big 16x12 tile-filling category
  // glyphs (CAT_GLYPHS, kept only as the legacy fallback for pre-phen frames)
  // with a sparse, from-the-across-the-room-but-honest phenomena map. Codes are
  // real char-ROM display codes chosen for 1:1 mutual distinctness (proven in
  // tools/proof-microglyphs.js by pairwise Hamming over the char-ROM bitmaps):
  //   FOG 0x14 '=' stacked bars · DRIZZLE 0x1b faint droplet · RAIN 0x18 '/'
  //   streak · SNOW 0x17 '*' flake · THUNDER 0x98 INVERSE '/' (a bold bolt).
  // The THUNDER mark carries the 0x80 inverse (ink) bit; the on-machine blink
  // clears that bit on odd render phases (0x98 -> 0x18) so ONLY the bolt flashes
  // — the micro-scale twin of the old whole-glyph T14 blink. STORM/LOW are
  // reserved for later tasks (T1 uses only FOG/DRIZZLE/RAIN/SNOW/THUNDER).
  const MICRO = {
    FOG: 0x14, DRIZZLE: 0x1b, RAIN: 0x18, SNOW: 0x17, THUNDER: 0x98,
    STORM: 0x95, LOW: 0xb1,
  };
  // layout CAT enum index -> micro code; 0 = draw nothing. CLEAR(0)/CLOUD(1)
  // map to 0 so the phenomena map stays sparse (an uncluttered wall). The map is
  // deliberately kept sparse: index absent/0 means "no mark".
  const MICRO_CAT = [0, 0, MICRO.FOG, MICRO.DRIZZLE, MICRO.RAIN, MICRO.SNOW, MICRO.THUNDER];
  const MICRO_NAMES = { FOG: 'FOG', DRIZZLE: 'DRIZZLE', RAIN: 'RAIN', SNOW: 'SNOW', THUNDER: 'THUNDER', LOW: 'LOW' };
  // Track-TRAIL fading (FS7-T9): a phenomenon TRACK replays the last 12/24/48h of
  // storm motion (gateway.trackFrames). The newest hour is the HEAD (full mark: the
  // 2x2 cyclone byte for tier>=CYCLONE, else the STORM micro); every EARLIER hour
  // fades with age — a grey checker (NEAR) within NEAR_HOURS, then a bare dot (FAR).
  // Both trail codes ride the ORDINARY phen[] wire (one-cell MICRO marks), so the
  // machines draw the tape frames themselves with ZERO wire/Z80/texture change.
  const TRAIL = { NEAR: 0x08, FAR: 0x1b, NEAR_HOURS: 3 };
  function trailCode(ageHours) { return ageHours <= TRAIL.NEAR_HOURS ? TRAIL.NEAR : TRAIL.FAR; }
  // top-left cell offset (y0*33 + x0) of a 7x7 stamp for each sub-tile position —
  // used by the Z80 OFFTAB. lo,hi byte pairs.
  function stampOffset(pos) {
    const c = SUB_CELL[pos] || SUB_CELL[0];
    const x0 = c[0] - SCX, y0 = c[1] - SCY;
    return y0 * 33 + x0;
  }

  // ===== synoptic glyphs (WEATHER page) ==================================
  // Authored as 12 rows of 16 chars ('#' = ink cell 0x80, '.' = transparent so
  // the plain land tint shows through). Packed to 12 uint16 rows (bit15 = col 0).
  const GW = 16, GH = 12, GCX = 16, GCY = 12; // centred at tile cell (16,12)
  function packRows(art) {
    const rows = [];
    for (let r = 0; r < GH; r++) {
      const line = art[r] || '';
      let bits = 0;
      for (let cc = 0; cc < GW; cc++) if (line[cc] === '#') bits |= (1 << (GW - 1 - cc));
      rows.push(bits & 0xffff);
    }
    return rows;
  }
  // Big, chunky, from-across-the-room icons. Indices 0..6 MUST match layout CAT
  // enum: 0 CLEAR(sun) 1 CLOUD 2 FOG 3 DRIZZLE 4 RAIN 5 SNOW 6 THUNDER. Indices
  // 7..9 are the EXTREME-marker glyphs (no CAT enum slot): 7 HEAT 8 COLD 9 GALE.
  // Indices 10..11 are the EMERGENCY-marker glyphs (GDACS/BC feeds, no CAT slot):
  // 10 FIRE (wildfire) 11 FLOOD. All of 7..11 are driven the same way — the gateway
  // sets a synthetic glyphCat byte + phen=null on the tile, so the machine stamps the
  // big pictogram exactly like a weather glyph (the Z80 stampglyph guard admits 0..11).
  const GLYPH_ART = [
    [ // 0 CLEAR — sun disc with rays
      '.......##.......',
      '...#...##...#...',
      '....#..##..#....',
      '.....######.....',
      '..#..######..#..',
      '#....######....#',
      '#....######....#',
      '.....######.....',
      '..#..######..#..',
      '....#..##..#....',
      '...#...##...#...',
      '.......##.......',
    ],
    [ // 1 CLOUD — puffy cumulus
      '................',
      '......####......',
      '....########....',
      '...##########...',
      '..############..',
      '.##############.',
      '################',
      '################',
      '.##############.',
      '..############..',
      '................',
      '................',
    ],
    [ // 2 FOG — stacked haze bars
      '................',
      '..############..',
      '................',
      '.##############.',
      '................',
      '..############..',
      '................',
      '.##############.',
      '................',
      '..############..',
      '................',
      '................',
    ],
    [ // 3 DRIZZLE — small cloud + clean light dashes (no pepper)
      '................',
      '......#####.....',
      '....#########...',
      '...##########...',
      '...#########....',
      '................',
      '....##...##.....',
      '................',
      '...##...##......',
      '................',
      '................',
      '................',
    ],
    [ // 4 RAIN — cloud + clean vertical streaks (solid, not scattered)
      '................',
      '.....######.....',
      '...##########...',
      '..############..',
      '.##############.',
      '..############..',
      '................',
      '...##..##..##...',
      '...##..##..##...',
      '...##..##..##...',
      '................',
      '................',
    ],
    [ // 5 SNOW — cloud + clean plus-shaped flakes (crisp, not pepper)
      '................',
      '.....######.....',
      '...##########...',
      '..############..',
      '.##############.',
      '..############..',
      '................',
      '...#...#...#....',
      '..###.###.###...',
      '...#...#...#....',
      '................',
      '................',
    ],
    [ // 6 THUNDER — smaller cloud + bold compact bolt
      '................',
      '................',
      '.....######.....',
      '...##########...',
      '..###########...',
      '..###########...',
      '......###.......',
      '.....###........',
      '....######......',
      '......###.......',
      '.....##.........',
      '................',
    ],
    [ // 7 HEAT — blazing sun: solid disc + 8 bold rays (extreme warmth)
      '.......##.......',
      '.......##.......',
      '..#...####...#..',
      '...#.######.#...',
      '.....######.....',
      '##...######...##',
      '##...######...##',
      '.....######.....',
      '...#.######.#...',
      '..#...####...#..',
      '.......##.......',
      '.......##.......',
    ],
    [ // 8 COLD — bold six-arm snow crystal (distinct from the SNOW cloud glyph)
      '.......##.......',
      '....#..##..#....',
      '.....#.##.#.....',
      '..#...####...#..',
      '...#.######.#...',
      '....########....',
      '..############..',
      '....########....',
      '...#.######.#...',
      '..#...####...#..',
      '.....#.##.#.....',
      '....#..##..#....',
    ],
    [ // 9 GALE — bold streaming wind gusts with arrowheads (strong wind)
      '................',
      '..##########....',
      '..........###...',
      '.........####...',
      '..........###...',
      '................',
      '....##########..',
      '............###.',
      '...........####.',
      '............###.',
      '................',
      '................',
    ],
    [ // 10 FIRE — wildfire flame: pointed top, wide base, hot inner core (GDACS WF / BC)
      '.......#........',
      '.......##.......',
      '......###.......',
      '......####......',
      '.....##.###.....',
      '....##...###....',
      '...##..#..###...',
      '..###.###..###..',
      '..##..####..##..',
      '..##..####..##..',
      '..###......###..',
      '...##########...',
    ],
    [ // 11 FLOOD — three stacked WAVY water bands (distinct from FOG's straight bars,
      //           from RAIN's vertical streaks, and from the SEA-page wave rows)
      '................',
      '................',
      '.###..###..###..',
      '#...##...##...##',
      '................',
      '.###..###..###..',
      '#...##...##...##',
      '................',
      '.###..###..###..',
      '#...##...##...##',
      '................',
      '................',
    ],
  ];
  const CAT_GLYPHS = GLYPH_ART.map(packRows);   // [12][12] uint16 (0..6 CAT, 7..9 extreme, 10..11 emergency)

  // ===== wind chevrons (WIND page) — standard barb/chevron speed notation ====
  // T13 (FS7): SPEED is shown as a standard CHEVRON COUNT and DIRECTION as the
  // chevron ORIENTATION, REPLACING the bare direction arrow (whose only speed cue
  // was its length — not legible from across the room). The chevron COUNT maps the
  // EXISTING wind-speed bands (src/layout.js L.WIND_BANDS / L.windBand — the same
  // Beaufort-anchored thresholds already used for the isotach contour layer), so NO
  // new band table is invented:
  //   band 0 (calm)   -> 0 chevrons (reads as "calm")    (nothing)
  //   band 1 (breeze) -> 1 chevron                        >
  //   band 2 (wind)   -> 2 chevrons                       >>
  //   band 3 (gale)   -> 3 chevrons                       >>>
  // Each chevron is a two-stroke `>` (the arrowhead of the old arrow, minus the
  // shaft) whose apex points ALONG the wind octant (OCT_VEC; octant 0 = N = up the
  // wall, CW). Successive chevrons stack back along -u so the group reads `>`/`>>`/
  // `>>>` pointing the way the wind blows. Rasterised into a GW x GH bitmap and
  // bit-packed exactly like the category glyphs, so texture.js (stampWind) and the
  // Z80 (WINDTAB / stampbmp) read the SAME table shape and stay byte-exact by
  // construction — this is a pure GLYPH swap; the render/wire path is untouched.
  const OCT_VEC = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  // chevron geometry: SP = apex spacing along the wind axis, BARB = barb stroke
  // length, DA = barb sweep-back angle (135deg, same as the old arrowhead).
  const CHEV_SP = 3, CHEV_BARB = 3, CHEV_DA = Math.PI * 0.75;
  function plot(grid, x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || xi >= GW || yi < 0 || yi >= GH) return;
    grid[yi * GW + xi] = 1;
  }
  function line(grid, x0, y0, x1, y1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      plot(grid, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }
  function packGrid(grid) {
    const rows = [];
    for (let r = 0; r < GH; r++) {
      let bits = 0;
      for (let cc = 0; cc < GW; cc++) if (grid[r * GW + cc]) bits |= (1 << (GW - 1 - cc));
      rows.push(bits & 0xffff);
    }
    return rows;
  }
  // A count-`band` chevron stack pointing along the wind octant. band<=0 -> empty
  // (calm draws nothing). The apexes are centred on the tile and spaced CHEV_SP
  // cells apart along the octant unit vector; each apex sprouts two barbs swept
  // back +/-CHEV_DA so the mark reads as `>`/`>>`/`>>>` in the wind direction.
  function chevronBitmap(octant, band) {
    const grid = new Array(GW * GH).fill(0);
    if (band <= 0) return packGrid(grid);
    const v = OCT_VEC[octant];
    // normalise the diagonal so all octants have comparable on-screen length
    const norm = (v[0] && v[1]) ? Math.SQRT1_2 : 1;
    const ux = v[0] * norm, uy = v[1] * norm;
    const cx = (GW - 1) / 2, cy = (GH - 1) / 2;
    const a = Math.atan2(uy, ux);
    for (let k = 0; k < band; k++) {
      const s = ((band - 1) / 2 - k) * CHEV_SP;       // signed offset along +u, centred
      const ax = cx + ux * s, ay = cy + uy * s;       // chevron k apex
      for (const da of [CHEV_DA, -CHEV_DA]) {         // two barbs swept back from the apex
        const bx = ax + Math.cos(a + da) * CHEV_BARB;
        const by = ay + Math.sin(a + da) * CHEV_BARB;
        line(grid, ax, ay, bx, by);
      }
    }
    return packGrid(grid);
  }
  // WIND_CHEVRONS[octant][band] -> [12] uint16 rows (band 0 = empty = calm).
  const WIND_CHEVRONS = [];
  for (let o = 0; o < 8; o++) {
    const perBand = [];
    for (let b = 0; b < 4; b++) perBand.push(chevronBitmap(o, b));
    WIND_CHEVRONS.push(perBand);
  }

  // ===== cyclone PERIPHERY spiral (physical, sub-tile size) ==============
  // A cyclone's eye stamp is a lone 7x7 mark, but the storm's cloud/wind field is
  // far bigger — yet, crucially, still SMALLER THAN ONE WALL TILE. One tile spans
  // 36deg of longitude (~2,800-4,000 km); even the largest storm on record
  // (Typhoon Tip, gale diameter ~2,200 km) is under one tile wide. So the periphery
  // is a SUB-TILE spiral centred on the eye, its radius measured in KILOMETRES
  // (floor 300 km, cap 1,100 km — Tip) and converted to character cells at the
  // anchor tile's latitude by the gateway. It renders on the eye's own tile (a big
  // storm may clip a few cells at the tile edge — the bezel gap already breaks
  // continuity there; documented in NOTES). The spiral bitmaps are generated HERE
  // (real log-spiral math) and injected verbatim as Z80 DB — "JS reference == Z80"
  // as for the eye stamp.
  //
  // PERIPH byte layout (payload byte 9, addr 0x630A; 0 = no band):
  //   bits0-2  SIZE   radius bucket 1..6 (BUCKET_R cells); 0 = no periphery
  //   bit3     FLIP   L-R mirror (x -> -x about the eye) — the S-hemisphere CW spin
  const PERIPH = { SIZE_MASK: 0x07, FLIP: 0x08 };
  // Radius buckets in CELLS. The gateway floors the km-derived radius to a bucket
  // (so the rendered span never exceeds the km cap): span_km = 2*R*kmPerCell and
  // R <= capKm/kmPerCell => span <= 2*capKm <= 2,200 km. Six coarse buckets — one
  // forecast sample per ~3,000 km tile can't justify finer.
  const BUCKET_R = [2, 4, 6, 7, 9, 11];   // bucket id 1..6 -> radius cells
  const BAND_FR = 12;                     // stamp half-size (field = 25x25, holds R<=12)
  const BAND_FS = 2 * BAND_FR + 1;        // 25
  const BAND_ARMS = 2, BAND_PITCH = 2.4, BAND_STROKE = 0.30, BAND_RMIN = 3.2;
  // A centred CCW log-spiral out to radius R (cells), inner hole RMIN where the eye
  // stamp sits. Field is BAND_FS x BAND_FS, eye at the centre (BAND_FR,BAND_FR).
  function bandGrid(R) {
    const grid = new Array(BAND_FS * BAND_FS).fill(0);
    for (let y = 0; y < BAND_FS; y++)
      for (let x = 0; x < BAND_FS; x++) {
        const dx = x - BAND_FR, dy = y - BAND_FR;
        const r = Math.hypot(dx, dy);
        if (r < BAND_RMIN || r > R) continue;         // inner eye hole / outer edge
        const theta = Math.atan2(dy, dx);             // screen angle (y-down)
        // arms where (theta - PITCH*ln r) hits a multiple of 2pi/ARMS. -ln r makes
        // them CCW-trailing (northern Coriolis); FLIP mirrors to CW for the south.
        let ph = (theta - BAND_PITCH * Math.log(r)) * BAND_ARMS / (2 * Math.PI);
        ph -= Math.floor(ph);
        if (ph < BAND_STROKE) grid[y * BAND_FS + x] = 1;
      }
    return grid;
  }
  const BAND_GRIDS = BUCKET_R.map(bandGrid);          // [6][25*25]
  // Pack one spiral grid to bytes: ceil(25/8)=4 bytes/row (bit7=col0), 25 rows = 100.
  function bandBytes(grid) {
    const b = [];
    for (let y = 0; y < BAND_FS; y++)
      for (let byte = 0; byte < 4; byte++) {
        let bits = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = byte * 8 + bit;
          if (x < BAND_FS && grid[y * BAND_FS + x]) bits |= (1 << (7 - bit));
        }
        b.push(bits);
      }
    return b;
  }
  const BAND_BYTES = BAND_GRIDS.map(bandBytes);       // [6][100]

  // ===== Z80 DB emitter ==================================================
  // Render a byte array as `DB b0,b1,...` lines (16/line) for injection into the
  // listener's assembly source, so the machine's tables ARE these tables.
  function emitDB(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 16)
      out.push('  DB ' + bytes.slice(i, i + 16).map((b) => '0x' + (b & 0xff).toString(16).padStart(2, '0')).join(','));
    return out.join('\n');
  }
  // flatten a [rows] uint16 glyph to bytes (hi,lo per row) for the Z80.
  function glyphBytes(rows) {
    const b = [];
    for (const r of rows) { b.push((r >> 8) & 0xff, r & 0xff); }
    return b;
  }

  // ===== MINI weather glyphs (WEATHER page, owner 2026-08-01: sub-tile SIZE, seated
  // over the phenomena) ======================================================
  // Each entry: [dx, dy, code] cell offsets about the glyph anchor, stamped through
  // the FS7 phen wire (x,y,code triples) — the Z80 stampphen path draws them with
  // ZERO new machine code, and the free-run blink rules (thunder-cat tile, flame
  // flag) apply unchanged. Ink budget <= 9 cells per glyph (PHEN_MAX 16). Indices
  // 0..6 match the layout CAT enum. Drops are quadrant dots (0x01/0x02), snow is
  // the ZX81 '*' (0x17), everything else solid ink (0x80).
  // 12-cell 7-wide cloud (quarter-tile scale — sub-tile but readable from across
  // the room): 4-cell crown, shoulders, 6-cell base. Anchor ~ the visual centre.
  const MG_CLOUD = [
    [-2, -1, 0x80], [-1, -1, 0x80], [0, -1, 0x80], [1, -1, 0x80],
    [-3, 0, 0x80], [2, 0, 0x80],
    [-3, 1, 0x80], [-2, 1, 0x80], [-1, 1, 0x80], [0, 1, 0x80], [1, 1, 0x80], [2, 1, 0x80],
  ];
  const MINI_GLYPHS = [
    /* 0 CLEAR   */ [[-1, 0, 0x80], [0, 0, 0x80], [-1, 1, 0x80], [0, 1, 0x80],   // 2x2 core
                     [-3, 0, 0x80], [-3, 1, 0x80], [2, 0, 0x80], [2, 1, 0x80],   // E/W rays
                     [-1, -2, 0x80], [0, -2, 0x80], [-1, 3, 0x80], [0, 3, 0x80]], // N/S rays
    /* 1 CLOUD   */ MG_CLOUD,
    /* 2 FOG     */ [[-3, -1, 0x80], [-2, -1, 0x80], [-1, -1, 0x80], [0, -1, 0x80],
                     [-2, 0, 0x80], [-1, 0, 0x80], [0, 0, 0x80], [1, 0, 0x80],
                     [-3, 1, 0x80], [-2, 1, 0x80], [-1, 1, 0x80], [0, 1, 0x80]],
    /* 3 DRIZZLE */ MG_CLOUD.concat([[-2, 2, 0x01], [0, 2, 0x02]]),
    /* 4 RAIN    */ MG_CLOUD.concat([[-2, 2, 0x02], [0, 2, 0x01], [-1, 3, 0x02]]),
    /* 5 SNOW    */ MG_CLOUD.concat([[-2, 2, 0x17], [0, 2, 0x17], [-1, 3, 0x17]]),
    /* 6 THUNDER */ MG_CLOUD.concat([[0, 2, 0x80], [-1, 3, 0x80], [-2, 4, 0x80]]),
  ];

  const GLY = {
    SK, INK: I, EYE: B, SW, SH, SCX, SCY, NPHASE, MINI_GLYPHS,
    CYC_P0, MAJ_P0, CYC_PHASES, MAJ_PHASES, SUB_CELL, stampOffset, rotateStamp,
    MICRO, MICRO_CAT, MICRO_NAMES, TRAIL, trailCode,
    GW, GH, GCX, GCY, CAT_GLYPHS, GLYPH_ART, WIND_CHEVRONS, OCT_VEC,
    PERIPH, BUCKET_R, BAND_FR, BAND_FS, BAND_GRIDS, BAND_BYTES, bandGrid, bandBytes,
    emitDB, glyphBytes, packRows,
  };
  g.WW_GLYPHS = GLY;
  if (typeof module !== 'undefined' && module.exports) module.exports = GLY;
})(typeof window !== 'undefined' ? window : globalThis);
