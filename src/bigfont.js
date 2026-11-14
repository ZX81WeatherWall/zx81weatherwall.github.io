// bigfont.js — the SHARED block-font byte table for the cyclone NAME + MIN-PRESSURE
// text layer (FS2 T15). Same discipline as src/glyphs.js: the font is authored ONCE
// here as pixel art, packed to ZX81 display CODES, and consumed by BOTH the JS
// reference renderer (src/texture.js) AND the on-machine Z80 program (tools/listener.js,
// which injects FONT_BYTES verbatim as DB). So "JS reference == Z80 DB" holds by
// construction, exactly as for the spiral/glyph/wind tables.
//
// WHY a block font: T14 stacked the NAME (row cy+4) and PRESSURE (row cy+5) below the
// 7x7 spiral stamp as single-cell ROM char codes. owner reports that at the wall's 1:1
// viewing scale those single-cell glyphs are too small to read. T15 enlarges ONLY the
// glyph SIZE (placement unchanged): each character is now drawn ~2x linear as a
// 2-cell-wide x 3-cell-tall block glyph.
//
// HOW it stays legible at that size WITHOUT a huge table: each glyph is authored as a
// 4px-wide x 6px-tall bitmap (a legible 3x5 letter/digit core in the top-left, with a
// 1px right + 1px bottom gap so neighbouring glyphs never touch). Those 4x6 pixels are
// packed into a 2x3 grid of ZX81 QUADRANT-graphic cells (each cell = one of the 16
// 2x2 block characters, codes 0x00..0x07 / 0x80..0x87 — verified against the real char
// ROM in tools/dump-chars.js). So one cell carries 2x2 sub-pixels: the on-screen glyph
// is 16px wide x 24px tall (2x-3x the ROM font's 8x8) — chunky, from-across-the-room
// legible — while the table is just 6 bytes/glyph.
//
// Dual module: Node (require) and browser/worker (window/self global). No deps.
(function (g) {
  'use strict';

  // ZX81 quadrant-graphic CODE for a 2x2 sub-pixel block (tl,tr,bl,br in {0,1}).
  // Index = tl*8 + tr*4 + bl*2 + br. Codes verified against the char ROM: 0x00 blank,
  // 0x03 top-half, 0x83 bottom-half, 0x05 left-half, 0x85 right-half, 0x80 solid, etc.
  const QUAD = [
    0x00, 0x87, 0x04, 0x83, 0x02, 0x85, 0x06, 0x81,
    0x01, 0x86, 0x05, 0x82, 0x03, 0x84, 0x07, 0x80,
  ];

  // Glyph geometry (in CELLS). Advance == glyph width, so neighbouring glyphs abut at
  // the cell grid but the 1px right gap baked into every bitmap keeps them separated.
  const GLYPH_PW = 4, GLYPH_PH = 6;     // pixel bitmap size
  const GLYPH_CW = 2, GLYPH_CH = 3;     // cell footprint (PW/2 x PH/2)
  const ADVANCE = GLYPH_CW;             // 2 cells per character
  const CELLS_PER_GLYPH = GLYPH_CW * GLYPH_CH; // 6

  // Pixel art: 36 glyphs, index 0..9 = digits 0-9, index 10..35 = letters A-Z. Each is
  // 6 rows x 4 cols ('#' = ink pixel). Core letter/digit lives in cols 0-2, rows 0-4;
  // col 3 and row 5 stay blank so glyphs never collide with their right/bottom neighbour.
  const ART = [
    // --- digits 0-9 ---
    ['###.', '#.#.', '#.#.', '#.#.', '###.', '....'], // 0
    ['.#..', '##..', '.#..', '.#..', '###.', '....'], // 1
    ['###.', '..#.', '###.', '#...', '###.', '....'], // 2
    ['###.', '..#.', '###.', '..#.', '###.', '....'], // 3
    ['#.#.', '#.#.', '###.', '..#.', '..#.', '....'], // 4
    ['###.', '#...', '###.', '..#.', '###.', '....'], // 5
    ['###.', '#...', '###.', '#.#.', '###.', '....'], // 6
    ['###.', '..#.', '..#.', '..#.', '..#.', '....'], // 7
    ['###.', '#.#.', '###.', '#.#.', '###.', '....'], // 8
    ['###.', '#.#.', '###.', '..#.', '###.', '....'], // 9
    // --- letters A-Z ---
    ['###.', '#.#.', '###.', '#.#.', '#.#.', '....'], // A
    ['##..', '#.#.', '##..', '#.#.', '##..', '....'], // B
    ['###.', '#...', '#...', '#...', '###.', '....'], // C
    ['##..', '#.#.', '#.#.', '#.#.', '##..', '....'], // D
    ['###.', '#...', '##..', '#...', '###.', '....'], // E
    ['###.', '#...', '##..', '#...', '#...', '....'], // F
    ['###.', '#...', '#.#.', '#.#.', '###.', '....'], // G
    ['#.#.', '#.#.', '###.', '#.#.', '#.#.', '....'], // H
    ['###.', '.#..', '.#..', '.#..', '###.', '....'], // I
    ['..#.', '..#.', '..#.', '#.#.', '###.', '....'], // J
    ['#.#.', '#.#.', '##..', '#.#.', '#.#.', '....'], // K
    ['#...', '#...', '#...', '#...', '###.', '....'], // L
    ['#.#.', '###.', '###.', '#.#.', '#.#.', '....'], // M
    ['#.#.', '##..', '#.#.', '.##.', '#.#.', '....'], // N
    ['###.', '#.#.', '#.#.', '#.#.', '###.', '....'], // O
    ['###.', '#.#.', '###.', '#...', '#...', '....'], // P
    ['###.', '#.#.', '#.#.', '###.', '..#.', '....'], // Q
    ['##..', '#.#.', '##..', '#.#.', '#.#.', '....'], // R
    ['###.', '#...', '###.', '..#.', '###.', '....'], // S
    ['###.', '.#..', '.#..', '.#..', '.#..', '....'], // T
    ['#.#.', '#.#.', '#.#.', '#.#.', '###.', '....'], // U
    ['#.#.', '#.#.', '#.#.', '#.#.', '.#..', '....'], // V
    ['#.#.', '#.#.', '###.', '###.', '#.#.', '....'], // W
    ['#.#.', '#.#.', '.#..', '#.#.', '#.#.', '....'], // X
    ['#.#.', '#.#.', '.#..', '.#..', '.#..', '....'], // Y
    ['###.', '..#.', '.#..', '#...', '###.', '....'], // Z
  ];

  // Pack one 4x6 art grid to CELLS_PER_GLYPH cell codes, row-major by cell:
  // [ (r0,c0),(r0,c1), (r1,c0),(r1,c1), (r2,c0),(r2,c1) ].
  function packGlyph(art) {
    const px = (x, y) => (art[y] && art[y][x] === '#') ? 1 : 0;
    const cells = [];
    for (let cr = 0; cr < GLYPH_CH; cr++)
      for (let cc = 0; cc < GLYPH_CW; cc++) {
        const x0 = cc * 2, y0 = cr * 2;
        const idx = (px(x0, y0) << 3) | (px(x0 + 1, y0) << 2) | (px(x0, y0 + 1) << 1) | px(x0 + 1, y0 + 1);
        cells.push(QUAD[idx]);
      }
    return cells;
  }

  // FONT_CELLS[i] = 6 cell codes for glyph i (0..35). Index 36 = the BLANK glyph (space
  // / any unmapped code): six 0x00 cells. Kept as an explicit entry so the Z80 DB table
  // and the JS reference share one address for it.
  const FONT_CELLS = ART.map(packGlyph);
  FONT_CELLS.push(new Array(CELLS_PER_GLYPH).fill(0x00)); // [36] blank
  const BLANK_INDEX = FONT_CELLS.length - 1;              // 36

  // ===== 2x (cell-resolution) font — the ENLARGED name font ================
  // owner QC: the packed 2x3-cell name (16x24 px) was too small to read on the wall.
  // Render the SAME art at ONE CELL PER PIXEL instead of quadrant-packing 2x2 px/cell:
  // each glyph becomes RAW_CW x RAW_CH = 4x6 CELLS (32x48 px on screen — 2x linear, the
  // crisp 3x5 block letters the legend already uses), with zero new art. Used for the
  // enlarged cyclone/fire NAME. RAW[i] = 6 rows, each a 4-bit value (bit3 = col 0).
  const RAW_CW = GLYPH_PW, RAW_CH = GLYPH_PH, RAW_ADVANCE = GLYPH_PW; // 4 wide, 6 tall, advance 4
  function rawRows(art) {
    const rows = [];
    for (let r = 0; r < GLYPH_PH; r++) {
      let b = 0;
      for (let c = 0; c < GLYPH_PW; c++) if (art[r] && art[r][c] === '#') b |= (1 << (GLYPH_PW - 1 - c));
      rows.push(b & 0x0f);
    }
    return rows;
  }
  const FONT_RAW = ART.map(rawRows);              // [36][6] 4-bit rows
  FONT_RAW.push(new Array(GLYPH_PH).fill(0));     // [36] blank
  // Z80 DB table: PACKED 3 bytes/glyph (two 4-bit rows per byte: hi nibble = even row,
  // lo nibble = odd row) to fit the tight low-RAM budget. RAW_CH must be even (6). The
  // Z80 stampbigtext2x reads byte cr>>1 and takes the hi/lo nibble by (cr&1).
  const FONT_RAW_BYTES = [];
  for (const rows of FONT_RAW)
    for (let r = 0; r < GLYPH_PH; r += 2)
      FONT_RAW_BYTES.push(((rows[r] & 0x0f) << 4) | (rows[r + 1] & 0x0f));

  // ZX81 char code -> glyph index. Digits 28..37 -> 0..9, letters 38..63 -> 10..35
  // (contiguous: idx = code-28). Anything else (space=0, punctuation, >Z) -> BLANK.
  function glyphIndex(code) {
    const c = code & 0xff;
    return (c >= 28 && c <= 63) ? (c - 28) : BLANK_INDEX;
  }

  // Flat byte table for the Z80 DB emitter: 37 glyphs x 6 bytes = 222 bytes, in glyph-
  // index order (so FONTTAB + idx*6 addresses glyph idx, matching FONT_CELLS[idx]).
  const FONT_BYTES = [];
  for (const cells of FONT_CELLS) for (const b of cells) FONT_BYTES.push(b & 0xff);

  const BF = {
    QUAD, GLYPH_PW, GLYPH_PH, GLYPH_CW, GLYPH_CH, ADVANCE, CELLS_PER_GLYPH,
    FONT_CELLS, FONT_BYTES, BLANK_INDEX, glyphIndex, packGlyph,
    RAW_CW, RAW_CH, RAW_ADVANCE, FONT_RAW, FONT_RAW_BYTES,
  };
  g.WW_BIGFONT = BF;
  if (typeof module !== 'undefined' && module.exports) module.exports = BF;
})(typeof window !== 'undefined' ? window : globalThis);
