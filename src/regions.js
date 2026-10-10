// regions.js — the reporter's baked geographic name table for the ZX81 Weather
// Wall. Each of the 100 tiles (a 36deg x 18deg cell of the equirectangular map)
// gets ONE short uppercase region/basin label. The REPORTER machine (the 101st
// ZX81) uses it to turn a tile INDEX — where the hottest reading is, where a
// cyclone spun up, which sea is roughest — into a human name for its global
// bulletin.
//
// Like the coastline mask, this is STATIC geographic data baked into the machine
// (sent once at boot); the on-machine Z80 reporter reads the SAME bytes because
// this module's tables are injected verbatim into its assembly as DB directives
// (see tools/reporter.js) — so "JS reference == Z80 table" by construction, the
// same discipline src/glyphs.js and src/texture.js already follow.
//
// The label for a tile is the single best geographic descriptor for that cell's
// centre (a 36x18 cell is either mostly a land region or mostly an ocean basin),
// so one table serves hottest/coldest land readings AND rough-sea / cyclone
// ocean basins. Names are kept <= 12 chars so they compose within the 300-char
// bulletin budget. Dual module: Node (require) and browser/worker (global).
(function (g) {
  'use strict';

  // The 10x10 name grid, row-major (row 0 = ~81N arctic .. row 9 = ~81S). Column
  // centres run -162,-126,-90,-54,-18,+18,+54,+90,+126,+162 (deg lon). Chosen to
  // read recognisably at wall scale — a synoptic map, not a gazetteer.
  const GRID_NAMES = [
    // row 0  ~81N
    'ARCTIC','ARCTIC','ARCTIC','ARCTIC','ARCTIC','ARCTIC','ARCTIC','ARCTIC','ARCTIC','ARCTIC',
    // row 1  ~63N
    'ALASKA','NW CANADA','N CANADA','GREENLAND','N ATLANTIC','SCANDINAVIA','W RUSSIA','SIBERIA','E SIBERIA','NE SIBERIA',
    // row 2  ~45N
    'N PACIFIC','NW USA','N USA','NE USA','N ATLANTIC','EUROPE','C ASIA','MONGOLIA','E ASIA','NW PACIFIC',
    // row 3  ~27N
    'C PACIFIC','E PACIFIC','MEXICO','N ATLANTIC','E ATLANTIC','N AFRICA','ARABIA','N INDIA','S CHINA','W PACIFIC',
    // row 4  ~9N
    'C PACIFIC','E PACIFIC','C AMERICA','CARIBBEAN','TROP ATL','W AFRICA','E AFRICA','S INDIA','SE ASIA','W PACIFIC',
    // row 5  ~9S
    'C PACIFIC','E PACIFIC','PERU','AMAZON','S ATLANTIC','C AFRICA','E AFRICA','N INDIAN','INDONESIA','W PACIFIC',
    // row 6  ~27S
    'S PACIFIC','SE PACIFIC','CHILE','S BRAZIL','S ATLANTIC','S AFRICA','S INDIAN','S INDIAN','NW AUSTRAL','SW PACIFIC',
    // row 7  ~45S
    'S PACIFIC','S PACIFIC','S PACIFIC','ARGENTINA','S ATLANTIC','S ATLANTIC','S INDIAN','S INDIAN','S AUSTRAL','TASMAN SEA',
    // row 8  ~63S
    'S OCEAN','S OCEAN','S OCEAN','S OCEAN','S OCEAN','S OCEAN','S OCEAN','S OCEAN','S OCEAN','S OCEAN',
    // row 9  ~81S
    'ANTARCTICA','ANTARCTICA','ANTARCTICA','ANTARCTICA','ANTARCTICA','ANTARCTICA','ANTARCTICA','ANTARCTICA','ANTARCTICA','ANTARCTICA',
  ];

  // De-dupe into a compact name list + a per-tile index into it. The reporter
  // stores only the 100-byte index table plus the name blob (both baked), so the
  // per-tile cost is one byte.
  const REGION_NAMES = [];
  const nameIndex = Object.create(null);
  const REGION_OF = new Array(100);
  for (let t = 0; t < 100; t++) {
    const nm = GRID_NAMES[t];
    if (!(nm in nameIndex)) { nameIndex[nm] = REGION_NAMES.length; REGION_NAMES.push(nm); }
    REGION_OF[t] = nameIndex[nm];
  }

  // Longest name — the reporter's field-width budget uses this to stay truncation
  // safe (see src/report.js). Assert the <=12 invariant loudly at load.
  let MAX_NAME_LEN = 0;
  for (const nm of REGION_NAMES) if (nm.length > MAX_NAME_LEN) MAX_NAME_LEN = nm.length;
  if (MAX_NAME_LEN > 12) throw new Error('regions.js: name exceeds 12 chars: ' + MAX_NAME_LEN);

  function regionName(tile) { return REGION_NAMES[REGION_OF[tile & 0xff] | 0] || '?'; }

  // --- Region -> continent rollup (FS5 R1/R4) -----------------------------
  // A frozen classification of the 100 tiles into 6 rotation-order land
  // continents (id 0..5) plus ocean/polar (-1). CONTINENT_TILES is the single
  // source of truth; CONTINENT_OF is derived from it so the count/derivation
  // cannot drift. Asserted at load, matching the MAX_NAME_LEN discipline above.
  // MEMBERSHIP RULE (owner QC 2026-07-09): a tile is a continent member only if it
  // carries MEANINGFUL land share OR names a owner-ordered landmass. Near-zero-land
  // ocean tiles are NOT members even if they sit inside the continent's bbox —
  // e.g. tile 62 (CHILE, 0% land, pure Pacific) and tile 78 (S AUSTRAL, 2% land)
  // were dropped because they inflated the "N OF N ZX81S" coverage with ocean.
  // Tile 79 (TASMAN SEA, 7% land) STAYS by explicit order — it is the NZ/Tasmania
  // desk. Verify with `node tools/viz-continents.js` (docs/continent-tiles.png).
  //
  // ORPHANED-LAND FIX (owner QC 2026-07-09, live AFRICA post): a large chunk of NW
  // Africa was cropped because member tiles carrying REAL continental coastline
  // were assigned to NO continent — the crop, which follows member bbox, sliced
  // the continent mid-Sahara. Six such coastal-land tiles (>=13% land, ocean-BASIN
  // names but genuine continental coast) are folded into their continents so the
  // crop covers the whole landmass. Extremes still name these tiles by their basin
  // label (regions.js), which is honest for a coastal reading:
  //   34 E ATLANTIC (34% land, Morocco/NW Africa) + 44 TROP ATL (29%, W Sahara/
  //      Senegal coast)                                             -> AFRICA
  //   43 CARIBBEAN  (28%, Venezuela/Guyanas/Caribbean arc)          -> S AMERICA
  //   31 E PACIFIC  (13%, Baja/NW Mexico)                           -> N AMERICA
  //   24 N ATLANTIC (14%, Ireland + Portugal/W Iberia) + 14 N ATLANTIC
  //      (13%, Iceland)                                             -> EUROPE
  // Land tiles 37->43, ocean 63->57. The ONLY orphaned land that stays desk-less is
  // POLAR (Arctic row 0, Antarctica row 9) and the sub-antarctic specks (66/72/
  // 83-89) — no population desk, and Antarctica's extremes already lead the GLOBAL
  // bulletin. proof-continental-orphans enforces that no OTHER >=10%-land tile is
  // ever orphaned again.
  const CONTINENT_NAMES = ['N AMERICA', 'S AMERICA', 'EUROPE', 'AFRICA', 'ASIA', 'OCEANIA'];
  const CONTINENT_TILES = [
    [10, 11, 12, 13, 21, 22, 23, 31, 32, 42],   // 0 N AMERICA (10): +31 Baja/NW Mexico (owner QC)
    [43, 52, 53, 63, 73],                        // 1 S AMERICA (5): +43 Venezuela/Caribbean coast (owner QC); drop 62 CHILE (0% land)
    [14, 15, 16, 24, 25],                        // 2 EUROPE (5): +14 Iceland, +24 Ireland/W Iberia (owner QC)
    [34, 35, 44, 45, 46, 55, 56, 65],            // 3 AFRICA (8): +34 Morocco/NW Africa, +44 W Sahara/Senegal (owner QC)
    [17, 18, 19, 26, 27, 28, 36, 37, 38, 47, 48, 58], // 4 ASIA (12)
    [68, 69, 79],                                // 5 OCEANIA (3): NW AU, SW Pacific, NZ/TAS; drop 78 S AUSTRAL (2% land, owner QC)
  ];

  // Derive CONTINENT_OF from CONTINENT_TILES (single source of truth).
  const CONTINENT_OF = new Array(100).fill(-1);
  for (let id = 0; id < CONTINENT_TILES.length; id++) {
    for (const tile of CONTINENT_TILES[id]) {
      if (tile < 0 || tile > 99) throw new Error('regions.js: continent tile out of range: ' + tile);
      if (CONTINENT_OF[tile] !== -1) throw new Error('regions.js: tile in two continents: ' + tile);
      CONTINENT_OF[tile] = id;
    }
  }

  // Per-id member counts, and the frozen expected counts.
  const CONTINENT_TILE_COUNT = CONTINENT_TILES.map((a) => a.length);
  const EXPECTED_TILE_COUNT = [10, 5, 5, 8, 12, 3];   // owner QC 2026-07-09: +orphaned coastal land 31/43/14+24/34+44 (N AM,S AM,EUR,AFR)

  // Assert-at-load invariants (throw on violation).
  for (let id = 0; id < CONTINENT_TILE_COUNT.length; id++) {
    if (CONTINENT_TILE_COUNT[id] !== EXPECTED_TILE_COUNT[id]) {
      throw new Error('regions.js: continent tile count drift at id ' + id);
    }
  }
  let LAND_TILES = 0;
  let OCEAN_TILES = 0;
  for (let t = 0; t < 100; t++) {
    const c = CONTINENT_OF[t];
    if (c === -1) { OCEAN_TILES++; }
    else if (c >= 0 && c <= 5) { LAND_TILES++; }
    else { throw new Error('regions.js: invalid continent id at tile ' + t); }
  }
  if (LAND_TILES !== 43) throw new Error('regions.js: land tile count != 43: ' + LAND_TILES);   // 37->43: +6 orphaned coastal-land tiles (owner QC 2026-07-09)
  if (OCEAN_TILES !== 57) throw new Error('regions.js: ocean/polar tile count != 57: ' + OCEAN_TILES);
  for (const nm of CONTINENT_NAMES) {
    if (nm.length > 12) throw new Error('regions.js: continent name exceeds 12 chars: ' + nm);
  }

  // ---- EXTREME-SKIP tiles (owner QC 2026-07-13, live EUROPE HIGH/LOW bug) --------
  // The 6 orphaned coastal-land tiles were added to continents purely for CROP
  // coverage + the honest "N OF N REPORTING" count (owner QC 2026-07-09). Each is an
  // ocean-BASIN-named tile (14/24 N ATLANTIC, 31 E PACIFIC, 34 E ATLANTIC, 43
  // CARIBBEAN, 44 TROP ATL) whose mask centre is SEA, so its cell temperature is
  // ocean-dominated (stable water, not land). Left in the hot/cold EXTREME scan they
  // (a) sample WATER, not the continent's land, and (b) collapse the peak/trough
  // LOCATION to a coarse basin name — e.g. Europe's HIGH and LOW BOTH resolved to
  // "N ATLANTIC" (tiles 24 and 14). EXCLUDE them from the continental HIGH/LOW
  // selection ONLY; they still count for coverage, precip, and the crop rect.
  // Global-desk extremes never land on these (desert land / Antarctica win), so the
  // skip is output-neutral for the world desk — applied unconditionally so the Z80
  // aggregate1 (which does not know the desk at fold time) can mirror it with ONE
  // table. The Z80 reporter bakes EXTSKIP from THIS list; keep them byte-parity.
  //
  // OCEANIA BASINS (owner QC 2026-07-14, live OCEANIA HIGH/LOW bug): the fix above was
  // NOT applied to ocean-heavy Oceania. Its members are [68 NW AUSTRAL 69% land, 69
  // SW PACIFIC 20% land, 79 TASMAN SEA 7% land] — 69/79 carry an ocean-BASIN name
  // over sea-centre water, so the continental HIGH/LOW drew a ~sea-surface temp
  // LABELLED "SW PACIFIC" (an ocean basin, never a valid temp name). Add 69/79 so
  // the extreme falls to LAND tile 68 (NW AUSTRAL, a land name, land temp). Swept all
  // 6 continents: these two were the ONLY members whose region name is an ocean basin
  // yet were not already skipped — every other sea-centre member (MEXICO, INDONESIA,
  // S CHINA, ...) names a LAND locality, honest for a temp. Global desk unchanged.
  const EXTREME_SKIP_TILES = [14, 24, 31, 34, 43, 44, 69, 79];
  const EXTREME_SKIP = new Set(EXTREME_SKIP_TILES);
  // Each skip tile must be a real continent member, and every continent must retain
  // at least one NON-skip tile (else its HIGH/LOW would have no land to name).
  for (const t of EXTREME_SKIP_TILES) {
    if (CONTINENT_OF[t] === -1) throw new Error('regions.js: EXTREME_SKIP tile not a continent member: ' + t);
  }
  for (let id = 0; id < CONTINENT_TILES.length; id++) {
    if (!CONTINENT_TILES[id].some((t) => !EXTREME_SKIP.has(t))) {
      throw new Error('regions.js: continent ' + id + ' has no non-skip extreme tile');
    }
  }

  function continentOf(tile) { return CONTINENT_OF[tile & 0xff]; }
  function continentName(id) { return CONTINENT_NAMES[id] || '?'; }

  const R = { GRID_NAMES, REGION_NAMES, REGION_OF, MAX_NAME_LEN, regionName,
    CONTINENT_NAMES, CONTINENT_OF, CONTINENT_TILES, CONTINENT_TILE_COUNT,
    EXTREME_SKIP_TILES, EXTREME_SKIP,
    continentOf, continentName };
  g.WW_REGIONS = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
