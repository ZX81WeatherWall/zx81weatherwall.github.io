// report.js — the ZX81 Weather Wall REPORTER: the single source of truth for how
// the 101st machine turns 100 tiles of received weather into a <=300-char wire
// bulletin. Two things live here:
//
//   1. a JS *reference* aggregator + composer (aggregate/compose), and
//   2. the shared constants/tables (ZX81 charset, fixed template fragments,
//      frame ids) that get injected verbatim into the on-machine Z80 reporter
//      (tools/reporter.js).
//
// The Z80 reporter mirrors this reference exactly — the fixed text fragments and
// region names are the SAME bytes (injected as DB), and the number/temperature
// formatting is the same algorithm — so the proofs assert "Z80 == report.js"
// byte-for-byte, the discipline texture.js/glyphs.js already use.
//
// CHARSET: the machine composes in the genuine ZX81 character set (uppercase —
// the ZX81 has no lowercase; that is the charm, kept). The gateway transcodes
// ZX81 codes -> ASCII only at the very end, when handing the reassembled bytes
// to the Bluesky pipeline. Dual module: Node (require) + browser/worker (global).
(function (g) {
  'use strict';
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const R = (typeof require === 'function') ? require('./regions') : g.WW_REGIONS;
  const C = (typeof require === 'function') ? require('./coastline') : g.WW_COASTLINE;
  // Baked major-city gazetteer (src/gazetteer.js): names the highest-population city
  // in a tile so the precip bulletin reads "CITY INTENSITY TYPE" preferring a major
  // population centre. Static geography baked into the Z80 (CITYOF/CITYBLOB), same
  // discipline as the region table. Absent a city, the reporter uses the region name.
  const GZ = (typeof require === 'function') ? require('./gazetteer') : g.WW_GAZETTEER;
  // WMO CAP authority spine — the SINGLE SOURCE of the closed WMO_EVENT phrase
  // table (FS5 R3). report.js NEVER retypes those phrases; it requires WM and
  // uses WM.WMO_EVENT so the reporter injects the SAME bytes (no drift).
  const WM = (typeof require === 'function') ? require('./wmo-cap') : g.WW_WMOCAP;
  // NOAA SWPC space-weather spine (src/swpc.js): the SINGLE source of the Kp->aurora-
  // visibility-latitude table + watch threshold, so the AURORA WATCH clause and any Z80
  // mirror inject the SAME table (no drift). Global scalar (one Kp worldwide), fetched
  // once per cycle, non-fatal degrade — threaded into aggregate2 via opts.kp.
  const SW = (typeof require === 'function') ? require('./swpc') : g.WW_SWPC;
  // Authority-alert PLACE table (src/alert-places.js): the tornado / flash-flood / evacuation
  // clauses name the STATE the authority warned (place ID on the header wire), never the grid
  // tile's gazetteer city — an 18x36-degree tile named "NEW YORK" covered Colorado to Maine.
  // Baked into the Z80 (PLOFF/PLBLOB) from this SAME table.
  const AP = (typeof require === 'function') ? require('./alert-places') : g.WW_ALERT_PLACES;

  // ---- baked sea-tile map ------------------------------------------------
  // SEA_TILE[t] = 1 iff tile t is a SEA tile (centre cell of its coastline mask
  // is sea) — the SAME criterion gateway.seaTiles() uses to pick the marine
  // coverage set. Static geography, so it is baked into the Z80 reporter as a DB
  // table (tools/reporter.js injects THIS array), the regions.js discipline.
  // The aggregator needs it for honesty: land tiles legitimately carry no marine
  // data (seaState = NODATA on the wire), and that must never flag the SEA claim
  // as unknown — only a SEA tile with no marine data does.
  const SEA_TILE = new Array(L.GRID * L.GRID);
  {
    const cx = L.TILE_W >> 1, cy = L.TILE_H >> 1;
    for (let r = 0; r < L.GRID; r++)
      for (let c = 0; c < L.GRID; c++) {
        const mask = C.tileLandMask(r, c);
        SEA_TILE[r * L.GRID + c] = mask[cy * L.TILE_W + cx] ? 0 : 1;
      }
  }

  // ---- ZX81 character set ------------------------------------------------
  // Codes verified against the char ROM (see tools/_harness.js zx81code): space
  // = 0, digits 0-9 = 28..37, A-Z = 38..63, plus the punctuation the bulletin
  // uses. This is the machine's native encoding; the report buffer holds THESE
  // bytes and they are what cross the tape.
  const SYM = { ' ': 0, '"': 11, '$': 13, ':': 14, '?': 15, '(': 16, ')': 17,
    '>': 18, '<': 19, '=': 20, '+': 21, '-': 22, '*': 23, '/': 24, ';': 25,
    ',': 26, '.': 27 };
  function zxCode(ch) {
    if (ch >= '0' && ch <= '9') return 28 + (ch.charCodeAt(0) - 48);
    const u = ch.toUpperCase();
    if (u >= 'A' && u <= 'Z') return 38 + (u.charCodeAt(0) - 65);
    if (ch in SYM) return SYM[ch];
    throw new Error('report.js: char not in ZX81 bulletin charset: ' + JSON.stringify(ch));
  }
  // Build the reverse map (ZX81 code -> ASCII char) for the gateway transcode.
  const ZX_TO_ASCII = {};
  for (const ch in SYM) ZX_TO_ASCII[SYM[ch]] = ch;
  for (let d = 0; d <= 9; d++) ZX_TO_ASCII[28 + d] = String(d);
  for (let a = 0; a < 26; a++) ZX_TO_ASCII[38 + a] = String.fromCharCode(65 + a);

  function toZX(str) { const o = []; for (const ch of str) o.push(zxCode(ch)); return o; }
  function fromZX(bytes) {
    let s = '';
    for (const b of bytes) { const c = ZX_TO_ASCII[b & 0xff]; if (c != null) s += c; }
    return s;
  }

  // ---- protocol ids ------------------------------------------------------
  const REPORTER_ADDR = 100;   // the 101st machine's DIP-switch address
  const CMD_RESET = 0xC9;      // downlink control frame: zero the aggregator
  const CMD_COMPOSE = 0xC8;    // downlink control frame: payload = time string;
                               // triggers compose + uplink transmit
  const FRAME_MAX = 60;        // text-uplink payload bytes/frame (<=64 budget)
  const CAP = 300;             // Bluesky grapheme limit, enforced ON THE MACHINE
  const MAX_CYC_STORE = 8;     // named cyclones kept for the list (RAM budget)
  const MAX_CYC_PRINT = 3;     // named in the bulletin; the rest -> "+N MORE"
  // Latitude-aware nomenclature: a storm's PUBLIC label depends on its tier
  // (detector thresholds unchanged — see layout.js CYC_THRESHOLDS) AND whether its
  // triggering tile sits in the tropics (~30N-30S) or poleward of it. Tier STORM
  // (1) never reaches this list (aggregate() only stores tier >= CYCLONE), so only
  // 4 labelled kinds exist: tropical CYCLONE/MAJOR and extratropical CYCLONE/MAJOR.
  const TROPICS_LAT = 30;      // |tileLat| < this -> tropics; mirrors the Z80 LAT_ABS compare
  const CYC_KIND = { TCYC: 0, MTCYC: 1, SFLOW: 2, HFLOW: 3 };
  const MAX_PRECIP_STORE = 8;  // precip-active tiles kept for the list (RAM budget)
  const MAX_PRECIP_PRINT = 4;  // precip sites named in a bulletin; rest -> "+N MORE"
  const NO_CITY_RANK = 255;    // population rank for a tile with no gazetteer city
                               // (sorts LAST within an intensity band; Z80-mirrored)
  const MAX_HAZ = 8;           // hazard events the reporter lists per sweep (RAM budget)
  const CMD_FLASH = 0xC7;      // downlink control: payload = [hazIndex] + time string;
                               // reporter composes + uplinks the flash for list[hazIndex]

  // ---- fixed template fragments (the parts that are constant text) -------
  // These become DB byte tables in the Z80, so the machine's fragments ARE these.
  const FRAG = {
    PREFIX: 'ZX81 WEATHER WALL ',   // + time string follows
    HOT: ': HIGH ',
    C_SP: 'C ',
    COLD: '; LOW ',
    RAIN: '. RAIN ',
    TILE_SNOW: ' TILE, SNOW ',      // rainCnt == 1 (singular)
    TILES_SNOW: ' TILES, SNOW ',    // rainCnt != 1 (plural, incl. 0)
    DOT_SP: '. ',
    NO_CYC: 'TROPICS QUIET.',
    CYCLONE: ' CYCLONE',            // + 'S' if plural + ': '
    S: 'S',
    COLON_SP: ': ',
    MAJOR: ' MAJOR',
    // Latitude-aware public nomenclature (marine-forecast vocabulary; WMO
    // "tropical cyclone" implies sustained-wind classification we don't have —
    // ours are gust-tiered signatures, but for a general-public audience we
    // still spell the tropics side out as "TROPICAL CYCLONE" rather than an
    // abbreviation. Extratropical systems use Beaufort marine terms
    // (storm-force / hurricane-force = gust bands), never "CYCLONE", so a
    // Southern Ocean low is never mistaken for a tropical storm.
    TCYCLONE: ' HURRICANE SIGNATURE',  // + 'S' if plural — tropics, tier CYCLONE
    SFLOW: ' STORM-FORCE LOW',      // + 'S' if plural — extratropics, tier CYCLONE
    HFLOW: ' HURRICANE-FORCE LOW',  // + 'S' if plural — extratropics, tier MAJOR
    CYC_X: ' X',                    // + count, for a deduped region group ("S OCEAN X3")
    MB: 'MB',                       // pressure unit, printed after the eye pressure digits
                                    // in a NAMED cyclone clause ("... DOUGLAS 965MB ...")
    COMMA_SP: ', ',
    MORE_A: ' +',                   // ' +N MORE'
    MORE_B: ' MORE',
    DOT: '.',
    ROUGH: ' SEAS ROUGH NEAR ',
    CALM: ' SEAS QUIET',
    SEA_NA: ' SEAS LISTENING',              // no rough sea measured AND >=1 sea tile NODATA
    ORLESS: 'OR LESS ',               // clamp mark: coldest hit the byte floor (-50C)
    REPORTING: ' ZX81S ON WATCH.',
    // --- severe-weather FLASH fragments (composed on the reporter) ---
    FPREFIX: 'ZX81 WX FLASH ',      // + time + ': ' + phrase + value + unit + region + coords
    OPEN: ' (',                     // ' (' before coords
    CLOSE: ')',
    COMMA: ',',
    // --- FS5 continental-desk + WMO-flash fragments ---
    CPRE: 'ZX81 ',                   // continental prefix (+ CONT + ' ' + time)
    CREP: ' REPORTING. ',            // (legacy) coverage tail — superseded by COF/CSIGN
    CMON: ' MONITORING ZX81S REPORTING.', // (legacy) credit tail — superseded by COF/CSIGN
    // Single clean continental sign-off (replaces the old duplicated "... REPORTING.
    // ... MONITORING ZX81S REPORTING."): "<seen> OF <Nalloc> <CONT> ZX81S REPORTING."
    // keeps BOTH honest figures (live coverage vs baked allocation) with ONE closing.
    COF: ' OF ',
    CSIGN: ' ZX81S REPORTING.',
    // --- precip clause words (INTENSITY + TYPE), injected as DB so the Z80 flash
    // text is byte-identical. Band words index PB[band]; type words index PT[type].
    SEMI: '; ',                      // separator between precip sites
    PB1: 'LIGHT', PB2: 'MODERATE', PB3: 'HEAVY',
    PT1: 'DRIZZLE', PT2: 'RAIN', PT3: 'SHOWERS', PT4: 'FREEZING RAIN',
    PT5: 'SNOW', PT6: 'SNOW SHOWERS', PT7: 'THUNDER',
    WAUTH: ' -',                     // ' -' before the wired WMO authority name
    CNODATA: 'NO DATA. ',            // seen==0 honest-degrade (no fabricated extremes)
  };

  // Hazard phrase + unit, indexed by hazard class (src/hazards.js HAZ; 0 unused).
  // The value prints between phrase and unit; EXTREME COLD prepends '-'. These
  // become DB fragment tables in the Z80 reporter, so its flash text is byte-
  // identical to composeFlash() here.
  const HAZ_PHRASE = ['',
    'VIOLENT THUNDERSTORM GUSTS ', // 1 VIOLENT_TS
    'EXTREME HEAT ',               // 2 HEAT
    'EXTREME COLD ',               // 3 COLD
    'DAMAGING WIND GUSTS ',        // 4 WIND
    'BLIZZARD GUSTS ',             // 5 BLIZZARD
    'PHENOMENAL SEAS ',            // 6 SEAS
  ];
  const HAZ_UNIT = ['', ' KMH', 'C', 'C', ' KMH', ' KMH', 'M'];
  const HAZ_COLD = 3;              // the one class whose value is printed negative

  // ---- number formatting (mirrored exactly by the Z80) -------------------
  // Unsigned 0..255 -> decimal, no leading zeros.
  function numZX(v) {
    v &= 0xff;
    const h = Math.floor(v / 100), t = Math.floor((v % 100) / 10), o = v % 10;
    const out = [];
    if (h > 0) out.push(28 + h);
    if (h > 0 || t > 0) out.push(28 + t);
    out.push(28 + o);
    return out;
  }
  // Cyclone eye pressure (hPa, 850..1105) -> decimal digits. numZX() only spans a
  // byte (0..255), so pressure needs its own formatter: the hundreds-group
  // floor(hPa/100) (8..11) prints via numZX, then the low two digits are ALWAYS
  // emitted (zero-padded — "850" not "85", "905" not "95"). The Z80 mirror
  // (putpress) decomposes the wire pressure byte (hPa-850) into the same digits.
  function pressZX(hPa) {
    const h = Math.floor(hPa / 100);   // 8..11
    const rem = hPa % 100;             // 0..99
    const out = numZX(h);
    out.push(28 + Math.floor(rem / 10));
    out.push(28 + (rem % 10));
    return out;
  }
  // Temperature byte (degC + 50) -> signed decimal. Range -50..+205.
  function tempZX(byte) {
    const c = (byte & 0xff) - 50;
    if (c < 0) return [zxCode('-')].concat(numZX(-c));
    return numZX(c);
  }

  // ---- aggregation -------------------------------------------------------
  // tiles: array (index = tile addr 0..99) of { tempByte, cat, seaState, cycByte }
  // exactly as the reporter reads them off the payloads. Processed in addr order;
  // first-wins on ties (matches the Z80's strict > / < comparisons).
  function aggregate(tiles) {
    const s = {
      hotByte: 0, hotTile: 0, coldByte: 255, coldTile: 0, extSeen: 0,
      rainCnt: 0, snowCnt: 0, roughSea: 0, roughTile: 0, seaNoData: 0,
      cycCount: 0, cyc: [], anyMajor: 0, seen: 0, precip: [],
    };
    for (let t = 0; t < tiles.length; t++) {
      const w = tiles[t]; if (!w) continue;
      const tb = w.tempByte & 0xff;
      // Robust FIRST-SEEN min/max: the first EXTREME-ELIGIBLE tile initializes BOTH
      // the hot and cold extremes to ITSELF, so hotTile/coldTile are ALWAYS a real
      // member of the passed tile set (a set whose members are all at the byte
      // floor no longer leaks tile 0 / ARCTIC via the seeded coldByte=255). On
      // real data (global max > floor, min < ceil) the final extremes are
      // unchanged, so this is output-neutral. Subsequent tiles use the SAME
      // strict >/< first-wins comparisons the Z80 mirrors.
      //
      // EXTREME-SKIP (regions.EXTREME_SKIP): the ocean-basin coastal orphan tiles
      // are NOT eligible for HIGH/LOW — their cell temp is water and their name is a
      // basin, which mislabelled Europe's peak+trough as BOTH "N ATLANTIC" (owner QC
      // 2026-07-13). They still count for seen / precip below; only the extremes skip
      // them. Global extremes never land on these, so the skip is output-neutral for
      // the world desk (proof-verified). The Z80 aggregate1 mirrors this via EXTSKIP.
      //
      // The FIRST-SEEN seed stays keyed on s.seen (not an eligible-only counter) so it
      // is byte-identical to the Z80, which keys on SEENN: when the first folded tile
      // is an orphan, seen increments with NO seed and the first eligible tile instead
      // takes the strict >/< path against the reset defaults (hotByte 0 / coldByte 255)
      // — the same tile/byte a seed would have produced for any temp in (floor, ceil).
      // TRUE HOT-SPOT (2026-07-14, DR-19 unfreeze): the HIGH/LOW extreme is eligible
      // ONLY on a POPULATED tile (GZ.hasCity) — never an empty cell, desert, or ocean
      // basin. owner's mandate: a temperature extreme names a REAL human habitation in
      // ALL instances, and (with at-city sampling upstream) reports the temperature
      // MEASURED THERE. This SUPERSEDES the old EXTREME_SKIP orphan list: hasCity is a
      // strict superset of that intent (it excludes every non-city tile), AND it now
      // RE-INCLUDES the coastal-city orphans (LONDON/CARACAS/...) that EXTREME_SKIP
      // dropped — their tile-centre sampled water, but the at-city sample reads land.
      // LOW is thereby the coldest INHABITED place (not the Antarctic ice), per mandate.
      // Z80 aggregate1 mirrors this via hascity_chk (CITYOF[tile]!=0xFF).
      // FIRST-ELIGIBLE seed (keyed on extSeen, NOT the all-tile counter): the FIRST
      // populated tile seeds BOTH extremes to ITSELF, so hotTile/coldTile are ALWAYS a
      // real city member — even a lone city AT the -50C floor (Oceania). Keying on the
      // all-tile counter left hotTile at the init 0 (ARCTIC, non-city) when no city beat
      // the default hotByte=0, producing the absurd "HIGH -50C ARCTIC". The Z80 aggregate1
      // + claims mirror this via an EXTSEED flag. Output-neutral for normal desks (real
      // temps beat the defaults, so seed vs strict-first-compare pick the same tile).
      if (GZ.hasCity(t)) {
        if (s.extSeen === 0) {
          s.hotByte = tb; s.hotTile = t;
          s.coldByte = tb; s.coldTile = t;
          s.extSeen = 1;
        } else {
          if (tb > s.hotByte) { s.hotByte = tb; s.hotTile = t; }
          if (tb < s.coldByte) { s.coldByte = tb; s.coldTile = t; }
        }
      }
      s.seen++;
      if ((w.cat & 0xff) === L.CAT.RAIN) s.rainCnt = Math.min(255, s.rainCnt + 1);
      if ((w.cat & 0xff) === L.CAT.SNOW) s.snowCnt = Math.min(255, s.snowCnt + 1);
      // Precip list (bulletin: INTENSITY TYPE at a major city). The reporter frame's
      // byte1 is the PACKED precip descriptor (gateway opts.precip): type bits0-2,
      // intensity band bits4-5, 0 = dry. A precip-active tile (type>0) is stored with
      // its band + type in tile-address order (the Z80 scans identically); the
      // worst-first ordering + city/region resolution happen at compose time.
      const pd = w.precipByte & 0xff;
      const ptype = L.precipDescType(pd);
      if (ptype > 0 && s.precip.length < MAX_PRECIP_STORE) {
        s.precip.push({ tile: t, band: L.precipDescBand(pd), type: ptype });
      }
      // Sea honesty: NODATA is NOT rough — it is EXCLUDED from the rough max
      // (NODATA=5 would otherwise outrank STORM=4 and fabricate "ROUGH SEAS")
      // and tracked as a separate "any SEA tile with no data" flag. Land tiles
      // carry NODATA legitimately (no marine coverage) and never set the flag.
      const ss = w.seaState & 0xff;
      if (ss === L.SEA.NODATA) {
        if (SEA_TILE[t]) s.seaNoData = 1;
      } else if (ss > s.roughSea) { s.roughSea = ss; s.roughTile = t; }
      const tier = L.cycTierOf(w.cycByte);
      if (tier >= L.CYC.CYCLONE) {
        s.cycCount = Math.min(255, s.cycCount + 1);
        if (tier === L.CYC.MAJOR) s.anyMajor = 1;
        if (s.cyc.length < MAX_CYC_STORE) {
          // FS2 §A: a reporter frame may carry a name+pressure trailer past its
          // hazard bytes (payload byte 12 = pressure, 13 = nameLen, 14.. = ZX name
          // codes). The proof supplies them decoded as w.cycPressByte / w.cycName —
          // exactly what the Z80 reads out of PBUF+12.. LEN-gated. A NAMED storm
          // (nameLen>0) carries a min pressure; unnamed/legacy tiles carry neither
          // (name=[], press=null) so the bulletin is byte-identical to pre-FS2.
          const rawName = Array.isArray(w.cycName) ? w.cycName.slice(0, 10) : [];
          const name = rawName.length > 0 ? rawName : [];
          const press = (name.length > 0 && w.cycPressByte != null)
            ? (850 + (w.cycPressByte & 0xff)) : null;
          s.cyc.push({ tile: t, tier, name, press });
        }
      }
    }
    return s;
  }

  // ---- cyclone list dedupe ------------------------------------------------
  // Group a stored cyclone list (tile-order, capped at MAX_CYC_STORE) into
  // distinct region groups, FIRST-APPEARANCE order: a basin visited by several
  // storms (e.g. three S OCEAN lows in one sweep) collapses to one named entry
  // + a count ("S OCEAN X3") instead of repeating the name. `major` is set if
  // ANY storm in the group reached tier MAJOR (severe weather is never hidden
  // by the roll-up). Mirrored append-for-append by the Z80 (group_build).
  function groupCyclones(cyc) {
    const groups = [];
    const byName = new Map();
    for (const c of cyc) {
      const name = R.regionName(c.tile);
      let g = byName.get(name);
      if (!g) { g = { name, count: 0, major: false }; byName.set(name, g); groups.push(g); }
      g.count++;
      if (c.tier === L.CYC.MAJOR) g.major = true;
    }
    return groups;
  }

  // Classify one stored storm (tile + tier, tier is CYCLONE or MAJOR — STORM
  // never reaches this list) into a public-nomenclature KIND by latitude zone.
  // tileLat is defined below (function declarations hoist), reused verbatim from
  // the flash-coordinate geometry so the tropics boundary is the SAME grid math
  // everywhere. Mirrored on the Z80 via its LAT_ABS[row] table (group_build).
  function cycKindOf(tile, tier) {
    const tropics = Math.abs(tileLat(tile)) < TROPICS_LAT;
    if (tropics) return tier === L.CYC.MAJOR ? CYC_KIND.MTCYC : CYC_KIND.TCYC;
    return tier === L.CYC.MAJOR ? CYC_KIND.HFLOW : CYC_KIND.SFLOW;
  }

  // Group a stored cyclone list by (kind, basin) — a DIFFERENT dedupe key from
  // groupCyclones() above (which is region-only and stays region-only for the ALT
  // text, composeAlt(), unaffected by this nomenclature change). Since kind already
  // encodes the tier (a kind bucket is never mixed CYCLONE/MAJOR), no separate
  // "major" flag is needed. Returns groups in first-appearance order PLUS
  // kindTotals[] — the count of every stored storm of each kind (used nowhere
  // directly by compose(), which instead sums only the PRINTED groups per kind so
  // the leading number in each clause never overstates what is actually named;
  // see compose()'s printedKindTotal). Mirrored append-for-append by the Z80
  // (group_build, compound key regionId*4+kind).
  function groupCyclonesByKind(cyc) {
    const groups = [];
    const byKey = new Map();
    for (const c of cyc) {
      const kind = cycKindOf(c.tile, c.tier);
      const name = R.regionName(c.tile);
      const key = kind + '|' + name;
      let g = byKey.get(key);
      if (!g) { g = { kind, name, count: 0 }; byKey.set(key, g); groups.push(g); }
      g.count++;
    }
    return groups;
  }

  // Kind label text: TCYC/MTCYC print "TROPICAL CYCLONE"/"MAJOR TROPICAL CYCLONE" (MTCYC is the
  // MAJOR fragment + the TCYCLONE fragment, concatenated — see FRAG); SFLOW/HFLOW
  // print their own fixed marine-forecast phrase directly (no MAJOR prefix — the
  // word itself already carries the severity). `plural` appends the shared 'S'
  // fragment (no other kind text has an internal space to pluralize incorrectly).
  function pushKindLabel(pushLim, limit, kind, plural) {
    if (kind === CYC_KIND.MTCYC) pushLim(F('MAJOR'), limit);
    const base = (kind === CYC_KIND.TCYC || kind === CYC_KIND.MTCYC) ? 'TCYCLONE'
      : (kind === CYC_KIND.HFLOW ? 'HFLOW' : 'SFLOW');
    pushLim(F(base), limit);
    if (plural) pushLim(F('S'), limit);
  }

  // ---- precip clause (INTENSITY TYPE at a major city) --------------------
  // A precip site's display name prefers the tile's baked major-city name
  // (gazetteer), else the region name; its worst-first tiebreak key is the city
  // population rank (NO_CITY_RANK for a region-only tile, so it sorts last within a
  // band). Both are baked static geography the Z80 mirrors (CITYOF/CITYRANK tables).
  function precipName(tile) { return GZ.hasCity(tile) ? GZ.cityName(tile) : R.regionName(tile); }
  // storePlaces: fold an authority place list ([{place, eventCode?}]) into an aggregate store —
  // valid place IDs only, one per place, first `cap` kept, place-ID ascending (= population
  // order, the bulletin's listing order). eventCode (when given) is the honest source gate: a
  // mark of any other event never lands in this clause. The Z80 keeps the first `cap` wired
  // entries in wire order; the gateway wires the SAME deduped ascending list, so the two agree.
  function storePlaces(list, into, cap, eventCode) {
    if (!Array.isArray(list)) return;
    const seen = new Set();
    for (const m of list) {
      if (!m || (eventCode != null && (m.eventCode | 0) !== eventCode)) continue;
      const p = m.place;
      if (!AP.isPlace(p) || seen.has(p)) continue;
      seen.add(p);
      if (into.length < cap) into.push({ place: p });
    }
    into.sort((a, b) => a.place - b.place);
  }
  function precipRank(tile) { return GZ.hasCity(tile) ? (GZ.CITY_RANK[GZ.cityIdOf(tile)] & 0xff) : NO_CITY_RANK; }
  // siteName(tile): the PRECISE locality — the tile's baked gazetteer city if it has one,
  // else the synoptic region. The temperature extreme (HIGH/LOW/TEMP) and gale clauses name
  // the actual place, not the broad tile region: "HIGH 35C TEHRAN" not "HIGH 35C ARABIA"
  // (owner 2026-07-14: report the precise hot/cold spot, never a blurred tile label). Same
  // static geography + city-else-region fallback precipName uses, so the Z80 mirror is the
  // SAME append_precip_name routine (CITYOF/CITYBLOB tables). SEA claims (roughest/phenomenal
  // seas) keep basin names via regionName — a wave is at sea, no locality (the Oceania rule).
  const siteName = precipName;
  // Order a stored precip list WORST-FIRST: intensity band DESC, then population rank
  // ASC (larger city first), then tile-address ASC — a total, stable order the Z80
  // selection-sort mirrors exactly.
  function orderPrecip(precip) {
    return precip.map((p) => ({ tile: p.tile, band: p.band, type: p.type, rank: precipRank(p.tile) }))
      .sort((a, b) => (b.band - a.band) || (a.rank - b.rank) || (a.tile - b.tile));
  }
  // Append the precip clause: ". CITY INTENSITY TYPE; CITY INTENSITY TYPE[+N MORE]"
  // (worst-first, capped at MAX_PRECIP_PRINT). ZERO precip -> appends NOTHING (the
  // clause is OMITTED entirely — no "RAIN 0 TILES" placeholder). Field widths are
  // bounded (city<=12, one band word <=8, one type word <=13, cap 4 sites), so the
  // clause is structurally <=~160 chars and needs no on-the-wire truncation. `push`
  // is the caller's byte appender; leading '. ' via F('DOT_SP').
  function appendPrecipClause(precip, push) {
    const list = orderPrecip(precip);
    if (list.length === 0) return;
    const nPrint = Math.min(list.length, MAX_PRECIP_PRINT);
    const leftover = list.length - nPrint;
    push(F('DOT_SP'));
    for (let i = 0; i < nPrint; i++) {
      const p = list[i];
      push(toZX(precipName(p.tile)));
      push(toZX(' '));
      push(F('PB' + p.band));   // band word 1..3
      push(toZX(' '));
      push(F('PT' + p.type));   // type word 1..7
      if (i < nPrint - 1) push(F('SEMI'));
    }
    if (leftover > 0) { push(F('MORE_A')); push(numZX(leftover)); push(F('MORE_B')); }
  }

  // ---- composition -------------------------------------------------------
  // Build the ZX81-code report from a stats object + a time string (ZX81 codes,
  // gateway-supplied). Truncation-safe: appends never exceed CAP; the closing
  // "... ZX81S REPORTING." tail is always reserved so it can't be lost.
  function compose(stats, timeZ) {
    const out = [];
    const F = (name) => toZX(FRAG[name]);
    // budget-aware push: appends `arr` only if it fits under `limit`. Returns
    // whether it fit. The Z80 mirrors this with a running length + CP guard.
    const pushLim = (arr, limit) => {
      if (out.length + arr.length > limit) return false;
      for (const b of arr) out.push(b);
      return true;
    };
    const push = (arr) => pushLim(arr, CAP);

    // Reserve the tail so it is never truncated away. Tail = sea section +
    // reporting line; the cyclone section ends in its own '.', so the sea claim
    // leads with a space (no separator needed here). Compute its exact bytes now
    // so we know how much room to leave for the (bounded) cyclone list.
    // Sea claim honesty (R3): measured rough sea (live-backed) stands; otherwise
    // any SEA tile with no marine data forces "SEAS N/A" — the bulletin NEVER
    // fabricates "SEAS CALM" out of absent data. Only all-live-and-calm says CALM.
    const roughSection = stats.roughSea > 0
      ? F('ROUGH').concat(toZX(R.regionName(stats.roughTile))).concat(F('DOT'))
      : (stats.seaNoData ? F('SEA_NA') : F('CALM')).concat(F('DOT'));
    const reporting = numZX(stats.seen).concat(F('REPORTING'));
    const tailAll = roughSection.concat(toZX(' ')).concat(reporting);
    const headLimit = CAP - tailAll.length;

    // ---- head ----
    push(F('PREFIX'));
    push(timeZ.slice());
    push(F('HOT'));
    push(tempZX(stats.hotByte));
    push(F('C_SP'));
    push(toZX(siteName(stats.hotTile)));   // TRUE HOT-SPOT: city-else-region (v1==v2==guard)
    push(F('COLD'));
    push(tempZX(stats.coldByte));
    push(F('C_SP'));
    // Clamp mark (R7): temperature byte 0 is the encoding floor (-50C). A coldest
    // reading AT the floor was (or may have been) clamped, so the claim carries
    // an explicit "OR LESS" — the bulletin never presents a clamped extreme as
    // an exact measurement.
    if ((stats.coldByte & 0xff) === 0) push(F('ORLESS'));
    push(toZX(siteName(stats.coldTile)));   // TRUE HOT-SPOT: city-else-region (v1==v2==guard)
    push(F('DOT_SP'));

    // ---- cyclone section (bounded to headLimit so the tail always fits) ----
    // Latitude-aware nomenclature (labels only — detector tiers untouched): each
    // storm is dedup-grouped by (kind, basin) via groupCyclonesByKind, then the
    // printed groups (first MAX_CYC_PRINT, tile-order first-appearance, same cap
    // as before) are bucketed into per-KIND clauses, one sentence per kind, in the
    // order that kind first appears — e.g. "1 TROPICAL CYCLONE W PACIFIC. 3 STORM-FORCE
    // LOWS S OCEAN." A kind clause's leading number is the sum of ONLY its own
    // printed groups (never an unnamed total), so every clause is fully backed by
    // the names next to it; any un-printed groups (of any kind) and any storms
    // beyond the storage cap fold into one "+N MORE" on the LAST clause — the
    // same total-additive-honesty invariant the single-sentence design proved
    // (sum of printed + leftover === cycCount), just split across clauses.
    // FS2 (R2): a NAMED cyclone (nameLen>0, DR-26/ASSUMP-4) reuses its honest kind
    // label but prints as its OWN clause with the NHC name + min pressure inserted
    // ("1 TROPICAL CYCLONE DOUGLAS 965MB E PACIFIC."). UNNAMED storms keep the
    // (kind,basin) grouping unchanged — so a sweep with no named storm is
    // BYTE-IDENTICAL to the pre-FS2 bulletin. Named clauses print FIRST (store
    // order), then the unnamed kind-bucketed clauses; the print budget
    // MAX_CYC_PRINT covers named clauses + unnamed groups together, and the
    // total-additive-honesty invariant holds (sum of printed + leftover ==
    // cycCount), with "+N MORE" trailing the LAST clause.
    const isNamed = (c) => !!(c.name && c.name.length > 0 && c.press != null);
    if (stats.cycCount === 0) {
      pushLim(F('NO_CYC'), headLimit);
    } else {
      const named = stats.cyc.filter(isNamed);
      const unnamed = stats.cyc.filter((c) => !isNamed(c));
      const groups = groupCyclonesByKind(unnamed);
      const printNamed = Math.min(named.length, MAX_CYC_PRINT);
      const remaining = MAX_CYC_PRINT - printNamed;
      const nPrintGroups = Math.min(groups.length, remaining);
      const kindOrder = [];
      const kindGroups = new Map();
      let printedTotal = printNamed;              // each named clause backs 1 storm
      for (let i = 0; i < nPrintGroups; i++) {
        const g = groups[i];
        if (!kindGroups.has(g.kind)) { kindGroups.set(g.kind, []); kindOrder.push(g.kind); }
        kindGroups.get(g.kind).push(g);
        printedTotal += g.count;
      }
      const leftover = stats.cycCount - printedTotal;
      const totalClauses = printNamed + kindOrder.length;
      let clauseIdx = 0;
      // ---- named clauses (each its own sentence, count always 1) ----
      for (let n = 0; n < printNamed; n++) {
        const c = named[n];
        const kind = cycKindOf(c.tile, c.tier);
        pushLim(numZX(1), headLimit);
        pushKindLabel(pushLim, headLimit, kind, false);
        pushLim(toZX(' '), headLimit);
        pushLim(c.name.slice(), headLimit);       // NHC name (ZX codes)
        pushLim(toZX(' '), headLimit);
        pushLim(pressZX(c.press), headLimit);
        pushLim(F('MB'), headLimit);
        pushLim(toZX(' '), headLimit);
        pushLim(toZX(R.regionName(c.tile)), headLimit);
        const isLast = clauseIdx === totalClauses - 1;
        if (isLast && leftover > 0) {
          pushLim(F('MORE_A'), headLimit);
          pushLim(numZX(leftover), headLimit);
          pushLim(F('MORE_B'), headLimit);
        }
        pushLim(F('DOT'), headLimit);
        if (!isLast) pushLim(toZX(' '), headLimit);
        clauseIdx++;
      }
      // ---- unnamed kind-bucketed clauses (unchanged grammar) ----
      for (let ki = 0; ki < kindOrder.length; ki++) {
        const kind = kindOrder[ki];
        const glist = kindGroups.get(kind);
        const kindTotal = glist.reduce((a, g) => a + g.count, 0);
        pushLim(numZX(kindTotal), headLimit);
        pushKindLabel(pushLim, headLimit, kind, kindTotal !== 1);
        pushLim(toZX(' '), headLimit);
        for (let j = 0; j < glist.length; j++) {
          const g = glist[j];
          pushLim(toZX(g.name), headLimit);
          // Xn is redundant when this kind names only one basin (the leading
          // number already IS that basin's count) — only split-basin kinds need it.
          if (glist.length > 1 && g.count > 1) { pushLim(F('CYC_X'), headLimit); pushLim(numZX(g.count), headLimit); }
          if (j < glist.length - 1) pushLim(F('COMMA_SP'), headLimit);
        }
        const isLast = clauseIdx === totalClauses - 1;
        if (isLast && leftover > 0) {
          pushLim(F('MORE_A'), headLimit);
          pushLim(numZX(leftover), headLimit);
          pushLim(F('MORE_B'), headLimit);
        }
        pushLim(F('DOT'), headLimit);
        if (!isLast) pushLim(toZX(' '), headLimit);
        clauseIdx++;
      }
    }

    // ---- tail (reserved) ----
    for (const b of tailAll) out.push(b);

    const z = Uint8Array.from(out.slice(0, CAP));
    return { z, text: fromZX(z), len: z.length };
  }

  // ---- severe-weather flash: on-machine scan + compose -------------------
  // Scan the swept tiles for hazard codes (payload byte 10 = class, byte 11 =
  // value) and list up to MAX_HAZ events in tile-address order — the SAME order
  // the Z80 reporter records them, so a gateway-side hazard index maps to the same
  // event on the machine (mirrors the cyclone list). `tiles[t].hazClass/hazVal`.
  function aggregateHazards(tiles) {
    const list = [];
    for (let t = 0; t < tiles.length; t++) {
      const w = tiles[t]; if (!w) continue;
      const cls = w.hazClass | 0;
      if (cls > 0 && list.length < MAX_HAZ) list.push({ tile: t, cls, val: w.hazVal | 0 });
    }
    return list;
  }

  // Grid geometry (regions.js): row centres 81N..81S (18deg steps), column centres
  // 162W..162E (36deg steps). Coarse but honest "approx coords" for the flash.
  function tileLat(tile) { return 81 - 18 * Math.floor((tile & 0xff) / 10); }
  function tileLon(tile) { return -162 + 36 * ((tile & 0xff) % 10); }
  // TEMPERATE/MARITIME heat zone: |tileLat| in the 45N/63N & 45S/63S rows (rows 1,2,7,8).
  // These are the non-heat-adapted, limited-AC mid-latitudes where a lower heat bar applies
  // (HEAT_TEMP_* above). Polar rows (81) and tropical/subtropical/desert rows (27,9) stay on
  // the desert 40C/45C bar. The Z80 mirror bakes HEATDANGOF/HEATEXTROF from THIS function.
  function heatZoneTemperate(tile) { const a = Math.abs(tileLat(tile)); return a >= 45 && a <= 63; }

  // Compose ONE severe-weather flash bulletin (ZX81 codes) for hazard event `hz`
  // ({tile,cls,val}) + a gateway-supplied time string. Uppercase, <=300, mirrors
  // the cyclone-flash shape: PREFIX + time + ': ' + phrase + value + unit + region
  // + ' (' + approx coords + ').'. The Z80 reporter mirrors this append-for-append
  // (composeflash), so the tape-delivered flash is byte-identical (proof h1).
  function composeFlash(hz, timeZ) {
    const out = [];
    const push = (arr) => { for (const b of arr) out.push(b); };
    push(toZX(FRAG.FPREFIX));
    push(timeZ.slice());
    push(F('COLON_SP'));
    push(toZX(HAZ_PHRASE[hz.cls] || ''));
    if (hz.cls === HAZ_COLD) push([zxCode('-')]);
    push(numZX(hz.val & 0xff));
    push(toZX(HAZ_UNIT[hz.cls] || ''));
    push(toZX(' '));
    push(toZX(R.regionName(hz.tile)));
    push(F('OPEN'));
    const lat = tileLat(hz.tile), lon = tileLon(hz.tile);
    push(numZX(Math.abs(lat)));
    push([zxCode(lat >= 0 ? 'N' : 'S')]);
    push(F('COMMA'));
    push(numZX(Math.abs(lon)));
    push([zxCode(lon < 0 ? 'W' : 'E')]);
    push(F('CLOSE'));
    push(F('DOT'));
    const z = Uint8Array.from(out.slice(0, CAP));
    return { z, text: fromZX(z), len: z.length };
  }
  function F(name) { return toZX(FRAG[name]); }

  // ---- FS5 R1: continental desk (composeContinental) ---------------------
  // Compose ONE continent's bulletin (ZX81 codes) from a stats object built by
  // ---- grouped precip clause (compose2 clause c grammar) ------------------
  // Condition stated ONCE, cities listed: "DRIZZLE IN A, B. HEAVY RAIN IN C." —
  // never "A DRIZZLE; B DRIZZLE". Groups emitted severity-first (THUNDER > FREEZING
  // RAIN > SNOW > SNOW SHOWERS > HEAVY RAIN > HEAVY SHOWERS > RAIN > SHOWERS >
  // DRIZZLE); cities within a group worst-first then population (orderPrecip). Each
  // group is one atomic buffer committed under the desk's budget. This is the
  // grouped grammar the global desk (compose2 clause c) already speaks; the Z80
  // mirror is precip2_clause / precip2_body (reporter.js), byte-for-byte. `commit`
  // appends a buffer iff it fits; `availOf()` returns budget remaining. keepCityIce
  // KEEPS city freezing rain as its own "FREEZING RAIN IN <city>" group (the
  // continental desk has NO ice-storm ALERT clause to elevate it to); the global
  // desk excludes it there (elevated to ICE STORM in ALERT).
  function appendGroupedPrecip(precip, keepCityIce, commit, availOf) {
    const cat = (...parts) => { const b = []; for (const p of parts) for (const x of p) b.push(x); return b; };
    const greedyPack = (lead, items, renderFull, renderShort, sep, moreWord, avail) => {
      if (lead.length > avail) return null;
      const b = lead.slice();
      let printed = 0;
      const trailerW = (F2('MOREP').length + numZX(items.length).length + moreWord.length);
      for (let i = 0; i < items.length; i++) {
        const s = printed ? sep : [];
        const res = (i < items.length - 1) ? trailerW : 0;
        let form = renderFull(items[i]);
        if (b.length + s.length + form.length + res > avail) {
          const sh = renderShort ? renderShort(items[i]) : null;
          if (sh && b.length + s.length + sh.length + res <= avail) form = sh;
          else break;
        }
        for (const x of s) b.push(x); for (const x of form) b.push(x); printed++;
      }
      if (printed === 0) return null;
      const leftover = items.length - printed;
      if (leftover > 0) { for (const x of F2('MOREP')) b.push(x); for (const x of numZX(leftover)) b.push(x); for (const x of moreWord) b.push(x); }
      return b;
    };
    const precipCond = (type, band) => {
      switch (type) {
        case 7: return { sev: 0, label: F('PT7') };                                   // THUNDER
        case 4: return { sev: 1, label: F('PT4') };                                   // FREEZING RAIN
        case 5: return { sev: 2, label: F('PT5') };                                   // SNOW
        case 6: return { sev: 3, label: F('PT6') };                                   // SNOW SHOWERS
        case 2: return band >= 3 ? { sev: 4, label: cat(F2('HEAVY_SP'), F('PT2')) } : { sev: 6, label: F('PT2') };
        case 3: return band >= 3 ? { sev: 5, label: cat(F2('HEAVY_SP'), F('PT3')) } : { sev: 7, label: F('PT3') };
        case 1: return { sev: 8, label: F('PT1') };                                   // DRIZZLE
        default: return { sev: 9, label: F('PT' + type) };
      }
    };
    const list = orderPrecip(precip)   // worst-first: band DESC, pop rank ASC, tile ASC
      .filter((p) => keepCityIce || !(p.type === ICE_TYPE && GZ.hasCity(p.tile)));
    if (list.length === 0) return;
    const groups = new Map();
    for (const p of list) {
      const c = precipCond(p.type, p.band);
      let g = groups.get(c.sev);
      if (!g) { g = { sev: c.sev, label: c.label, items: [] }; groups.set(c.sev, g); }
      g.items.push(p);
    }
    const ordered = Array.from(groups.values()).sort((a, b) => a.sev - b.sev);
    const cityFull = (p) => toZX(precipName(p.tile));
    for (const g of ordered) {
      const lead = cat(toZX(' '), g.label, F2('IN'));
      const body = greedyPack(lead, g.items, cityFull, null, F2('COMMA_SP'), F2('MORE'), availOf());
      if (body) commit(cat(body, F('DOT')));
      else break;   // worst-first budget exhausted; drop lesser groups
    }
  }

  // aggregate() over ONLY that continent's member tiles (the gateway selects them
  // — DR-9/ASSUMP-10), plus a gateway-supplied time string. Mirrors the global
  // desk head EXACTLY but continent-scoped, with NO cyclone and NO sea section
  // (ASSUMP-7), and closes with the coverage + stable-allocation credit line.
  // <=300; the Z80 reporter mirrors this append-for-append (proof pins
  // reference==hand-frozen literal AND Z80-tape==reference).
  function composeContinental(stats, contId, timeZ) {
    const out = [];
    const push = (arr) => { for (const b of arr) out.push(b); };
    const cont = toZX(R.CONTINENT_NAMES[contId]);
    const nAlloc = R.CONTINENT_TILE_COUNT[contId];
    // ---- prefix: 'ZX81 ' + CONT + ' ' + time ----
    push(F('CPRE'));
    push(cont);
    push(toZX(' '));
    push(timeZ.slice());
    // ---- seen==0 honest-degrade (§5b): NEVER emit hottest/coldest/rain/snow ----
    // (those aggregate bytes are uninitialized and would fabricate -50C/205C).
    if (stats.seen === 0) {
      push(F('COLON_SP'));
      push(F('CNODATA'));
      // single clean sign-off: "<0> OF <Nalloc> <CONT> ZX81S REPORTING."
      push(numZX(0));
      push(F('COF'));
      push(numZX(nAlloc));
      push(toZX(' '));
      push(cont);
      push(F('CSIGN'));
      const z0 = Uint8Array.from(out.slice(0, CAP));
      return { z: z0, text: fromZX(z0), len: z0.length };
    }
    // ---- head (seen>0): mirrors compose()'s head, continent-scoped ----
    push(F('HOT'));
    push(tempZX(stats.hotByte));
    push(F('C_SP'));
    push(toZX(siteName(stats.hotTile)));   // TRUE HOT-SPOT: city-else-region (v1==v2==guard)
    push(F('COLD'));
    push(tempZX(stats.coldByte));
    push(F('C_SP'));
    // FS1 clamp mark (R7): coldest AT the byte floor (-50C) carries "OR LESS".
    if ((stats.coldByte & 0xff) === 0) push(F('ORLESS'));
    push(toZX(siteName(stats.coldTile)));   // TRUE HOT-SPOT: city-else-region (v1==v2==guard)
    push(F('DOT'));                // head-terminating period (formerly carried by ". ")
    // ---- precip clause: GROUPED BY CONDITION (condition stated ONCE), worst-first,
    // or OMITTED when dry. "DRIZZLE IN A, B. HEAVY RAIN IN C." — the SAME grouped
    // grammar the global desk speaks, never "A DRIZZLE; B DRIZZLE" (owner). Budget is
    // CAP minus the sign-off tail, exactly like compose2 (greedy pack reserves it). ----
    const tail = toZX(' ').concat(numZX(stats.seen)).concat(F('COF')).concat(numZX(nAlloc))
      .concat(toZX(' ')).concat(cont).concat(F('CSIGN'));   // " <seen> OF <Nalloc> <CONT> ZX81S REPORTING."
    const limit = CAP - tail.length;
    const commit = (buf) => { if (out.length + buf.length > limit) return false; for (const b of buf) out.push(b); return true; };
    appendGroupedPrecip(stats.precip, true, commit, () => limit - out.length);
    // ---- single clean sign-off: " <seen> OF <Nalloc> <CONT> ZX81S REPORTING." ----
    // Keeps BOTH honest figures (live coverage vs baked allocation) with ONE closing.
    // Leads with a single space; the preceding clause (head or last precip group)
    // already ended in ".", so the total is byte-identical to the old ". " when dry.
    push(tail);
    const z = Uint8Array.from(out.slice(0, CAP));
    return { z, text: fromZX(z), len: z.length };
  }

  // ---- FS5 R3: WMO-sourced severe-weather FLASH (composeWmoFlash) ---------
  // Compose ONE authority-sourced flash (ZX81 codes) for a matched CAP alert
  // hz = { tile, eventCode (1..12), authority (ZX81-safe string, may be '') } +
  // a gateway-supplied time string. Event phrase comes from WM.WMO_EVENT (the
  // SINGLE closed-table source), region + coords from the SAME grid geometry the
  // wmo-cap matcher inverts, then the wired authority "where feasible" (§5c: an
  // EMPTY authority OMITS the ' -<AUTHORITY>' clause entirely). <=300; the Z80
  // reporter mirrors this append-for-append.
  function composeWmoFlash(hz, timeZ) {
    // Honest / never-throw guards → empty no-op (same shape as eventCode 0):
    //   * WM absent (browser load-order: WW_WMOCAP not yet loaded);
    //   * hz missing / eventCode 0 (no event — §5c / FROZEN-GRAMMAR §3);
    //   * eventCode not an integer in [1, WMO_EVENT.length-1] (out-of-range →
    //     WMO_EVENT[code] undefined → toZX would iterate undefined and throw).
    const empty = () => ({ z: new Uint8Array(0), text: '', len: 0 });
    if (!WM || !WM.WMO_EVENT) return empty();
    if (!hz || !hz.eventCode) return empty();
    const code = hz.eventCode;
    if (!Number.isInteger(code) || code < 1 || code > WM.WMO_EVENT.length - 1) return empty();
    const out = [];
    const push = (arr) => { for (const b of arr) out.push(b); };
    push(toZX(FRAG.FPREFIX));
    push(timeZ.slice());
    push(F('COLON_SP'));
    push(toZX(WM.WMO_EVENT[hz.eventCode]));
    push(toZX(' '));
    push(toZX(R.regionName(hz.tile)));
    push(F('OPEN'));
    const lat = tileLat(hz.tile), lon = tileLon(hz.tile);
    push(numZX(Math.abs(lat)));
    push([zxCode(lat >= 0 ? 'N' : 'S')]);
    push(F('COMMA'));
    push(numZX(Math.abs(lon)));
    push([zxCode(lon < 0 ? 'W' : 'E')]);
    push(F('CLOSE'));
    // §5c attribution "where feasible": only when the wired authority is non-empty.
    if (typeof hz.authority === 'string' && hz.authority.length > 0) {
      push(F('WAUTH'));
      push(toZX(hz.authority));
    }
    push(F('DOT'));
    const z = Uint8Array.from(out.slice(0, CAP));
    return { z, text: fromZX(z), len: z.length };
  }

  // ---- accessibility: image ALT text ------------------------------------
  // A genuinely descriptive line for the WEATHER-tab screencap attached to every
  // post, composed from the SAME aggregate stats as the wire bulletin (so the
  // picture and its description can never drift). Plain readable ASCII prose (NOT
  // the ZX81 uppercase wire charset) — this is for screen readers, not the tape.
  function composeAlt(stats) {
    const rn = (t) => R.regionName(t);
    const degC = (b) => (b & 0xff) - 50;
    const p = ['A 10x10 wall of 100 ZX81 screens rendering a live world weather map in 1-bit block graphics.'];
    if (stats.cycCount === 0) {
      p.push('No cyclones active.');
    } else {
      const spiral = stats.cycCount === 1 ? 'a rotating spiral marker' : 'rotating spiral markers';
      const groups = groupCyclones(stats.cyc);
      const nPrint = Math.min(groups.length, MAX_CYC_PRINT);
      let printedTotal = 0;
      const named = [];
      for (let i = 0; i < nPrint; i++) {
        const g = groups[i];
        named.push(g.name + (g.count > 1 ? ' x' + g.count : '') + (g.major ? ' (major)' : ''));
        printedTotal += g.count;
      }
      let clause = stats.cycCount + ' cyclone' + (stats.cycCount === 1 ? '' : 's') +
        ' marked by ' + spiral + ': ' + named.join(', ');
      const leftover = stats.cycCount - printedTotal;
      if (leftover > 0) clause += ' +' + leftover + ' more';
      p.push(clause + '.');
    }
    if (stats.rainCnt || stats.snowCnt) {
      const parts = [];
      if (stats.rainCnt) parts.push('rain areas');
      if (stats.snowCnt) parts.push('snow or wintry areas');
      p.push('Precipitation signals present: ' + parts.join(' and ') + '.');
    } else {
      p.push('No notable precipitation signal on the WEATHER board.');
    }
    if (stats.extSeen) p.push('Hottest ' + degC(stats.hotByte) + 'C at ' + rn(stats.hotTile) +
      ', coldest ' + degC(stats.coldByte) + 'C' +
      ((stats.coldByte & 0xff) === 0 ? ' or less' : '') + ' at ' + rn(stats.coldTile) + '.');
    else p.push('No populated-tile temperature readings this cycle.');
    // Mirrors the wire bulletin's sea honesty: never describe absent data as calm.
    p.push(stats.roughSea > 0 ? 'Roughest seas at ' + rn(stats.roughTile) + '.'
      : stats.seaNoData ? 'Sea state not available.' : 'Seas calm.');
    return p.join(' ');
  }

  // Split a report byte array into text-uplink frames (<= FRAME_MAX each).
  function frameize(z) {
    const frames = [];
    for (let i = 0; i < z.length; i += FRAME_MAX) frames.push(Array.from(z.slice(i, i + FRAME_MAX)));
    if (frames.length === 0) frames.push([]);
    return frames;
  }

  // ======================================================================
  // BULLETIN V2 — Shipping-Forecast / NAVTEX format (bridge job zwx-newformat)
  // ----------------------------------------------------------------------
  // Additive + isolated: the v1 aggregate/compose/composeContinental/composeAlt above
  // are BYTE-UNTOUCHED, so every frozen v1 proof stays green. v2 ships behind the
  // BULLETIN_V2 switch (default OFF); the live path selects v1 vs v2 via composeAuto.
  // Structure (see NOTES.md "BULLETIN V2"): HEADER . [ALERT: worst-first red/warning] .
  // CONDITIONS (MAX/MIN, gale, precip, sea, residual orange fires) . SIGN-OFF.
  // Greedy fill: reserve the sign-off tail first, then expand named detail worst-first
  // until the 300 budget is nearly spent, only then collapse a section tail to "+N".
  // ======================================================================
  const BULLETIN_V2 = (typeof process !== 'undefined' && process.env
    && process.env.ZWX_BULLETIN_V2 === '1');
  const MAX_FIRE_STORE = 8;    // fires kept per band for the list (RAM budget)
  const MAX_FLOOD_STORE = 8;   // floods kept for the list
  const MAX_HEAT_STORE = 8;    // dangerous-heat cities kept for the list (RAM budget)
  const MAX_COLD_STORE = 8;    // dangerous-cold cities kept for the list (RAM budget)
  const MAX_ICE_STORE = 8;     // ice-storm (freezing-rain) cities kept for the list (RAM budget)
  const MAX_DUST_STORE = 8;    // dust-storm cities/areas kept per list (RAM budget)
  const MAX_SNOW_STORE = 8;    // heavy/extreme snowfall cities kept for the list (RAM budget)
  const MAX_TSUNAMI_STORE = 8; // authority tsunami warnings kept for the list (RAM budget)
  const MAX_RIVER_STORE = 8;   // GloFAS river-flood forecasts kept for the list (RAM budget)
  const MAX_EVAC_STORE = 8;    // authority evacuation orders kept for the list (RAM budget)
  const MAX_TORNADO_STORE = 8; // authority tornado warnings kept for the list (RAM budget)
  // TORNADO WARNING is the ONLY authority-sourced ALERT clause (every other clause is a
  // measured/self-judged fact). Its source is the WMO-CAP register's eventCode 9
  // (WMO_EVENT[9]='TORNADO'), matched to a monitored tile by src/wmo-cap.js — we NEVER
  // self-declare a tornado (no detector exists). The load-time self-check pins the code to
  // the closed table so a future WMO_EVENT reorder can't silently mis-source the clause.
  const TORNADO_EVENT_CODE = 9;
  if (WM && WM.WMO_EVENT && WM.WMO_EVENT[TORNADO_EVENT_CODE] !== 'TORNADO')
    throw new Error('report.js: TORNADO_EVENT_CODE drift — WMO_EVENT[' + TORNADO_EVENT_CODE + '] != TORNADO');
  const MAX_FLASHFLOOD_STORE = 8; // authority flash-flood warnings kept for the list (RAM budget)
  // FLASH FLOOD WARNING — an authority-sourced ALERT clause (with TORNADO/HEAT). Source is the
  // WMO-CAP register's eventCode 3 (WMO_EVENT[3]='FLASH FLOOD'), matched to a monitored tile by
  // src/wmo-cap.js — the US NWS et al. issue flash-flood warnings for minutes-scale wall-of-water
  // lethality, so it ranks just below tornado. Distinct from the slow-onset GDACS DROUGHT clause
  // and the GDACS river/area FLOOD marks; carries NO number (the authority warning IS the signal).
  // Load-time self-check pins the code to the closed table (a future WMO_EVENT reorder can't
  // silently mis-source the clause). NEW with feed #1 (US authority alerts).
  const FLASHFLOOD_EVENT_CODE = 3;
  if (WM && WM.WMO_EVENT && WM.WMO_EVENT[FLASHFLOOD_EVENT_CODE] !== 'FLASH FLOOD')
    throw new Error('report.js: FLASHFLOOD_EVENT_CODE drift — WMO_EVENT[' + FLASHFLOOD_EVENT_CODE + '] != FLASH FLOOD');
  const MAX_HEATWARN_STORE = 8; // authority extreme-heat warnings kept for the list (RAM budget)
  const MAX_DROUGHT_STORE = 8;  // authority (GDACS) drought emergencies kept for the list (RAM budget)
  const MAX_SMOKE_STORE = 8;    // hazardous-smoke (PM2.5>=150) city tiles kept for the list (RAM budget)
  const MAX_SMOKEMID_STORE = 8; // mid-band smoke (PM2.5 55-149) city tiles kept for the NOTABLE list (RAM budget)
  const MAX_FOG_STORE = 8;      // DENSE FOG (WMO 45/48) city tiles kept for the NOTABLE list (RAM budget)
  const MAX_DUSTHAZE_STORE = 8; // MODERATE DUST/HAZE (WMO 06-09) city tiles kept for the NOTABLE list (RAM budget)
  // EXTREME HEAT WARNING — the SECOND authority-sourced ALERT clause (with TORNADO). Source is
  // the WMO-CAP register's eventCode 4 (WMO_EVENT[4]='EXTREME HEAT'), matched to a monitored
  // tile by src/wmo-cap.js — a NATIONAL met-authority red/amber heat warning. Distinct from the
  // MEASURED heat clauses (DANGEROUS/EXTREME HEAT <temp>): authorities issue red heat warnings
  // for CUMULATIVE deadly heat (multi-day, elderly, no AC) that a single feels-like reading
  // misses, so we trust the authority over our own threshold. Load-time self-check pins the code
  // to the closed table so a future WMO_EVENT reorder can't silently mis-source the clause.
  const HEAT_WARN_EVENT_CODE = 4;
  if (WM && WM.WMO_EVENT && WM.WMO_EVENT[HEAT_WARN_EVENT_CODE] !== 'EXTREME HEAT')
    throw new Error('report.js: HEAT_WARN_EVENT_CODE drift — WMO_EVENT[' + HEAT_WARN_EVENT_CODE + '] != EXTREME HEAT');
  const ICE_TYPE = 4;          // precip descriptor type for FREEZING RAIN (WMO 66/67)
  // MEASURED heavy/extreme snowfall thresholds, on a per-tile snowfall byte = the day's total
  // snowfall in CM (Open-Meteo daily snowfall_sum, a 24h-scale accumulation; degC-free — a
  // plain 0..255 cm count). Two tiers, chosen against operational heavy-snow-warning practice
  // (US NWS Winter Storm Warning criteria run ~15-30cm/24h regionally; Japan/Sapporo routinely
  // clears both):
  //   >= 25cm/24h -> HEAVY SNOWFALL (level 1): a disruptive, transport-paralysing accumulation;
  //   >= 50cm/24h -> EXTREME SNOWFALL (level 2): a life-threatening, roof-loading blizzard-scale
  //     dump (people trapped, structures at risk).
  // POPULATED-TILE ONLY (same rationale as heat/cold): 60cm over empty tundra is climate, not an
  // emergency; a heavy dump matters because PEOPLE and infrastructure are under it, so an
  // unpopulated tile is silent by design. An absent snowByte reads as 0cm (below the HEAVY floor)
  // so absent data is SILENT — safe like heat's ceiling (no cold-style absent-masquerade guard
  // needed; 0 can never clear a >=25 floor).
  const SNOW_HEAVY_CM = 25;
  const SNOW_EXTREME_CM = 50;
  const SNOW_HEAVY = 1, SNOW_EXTREME = 2;
  // MEASURED dangerous-heat thresholds, on the apparent (feels-like) temperature byte
  // (degC+50, the SAME tempByte encoding). Two tiers, chosen against the humidex /
  // NWS heat-index literature: a feels-like of ~40C is the humidex "dangerous" / HI
  // "danger" band (heat cramps/exhaustion likely, heat stroke possible on exertion);
  // ~45C is the humidex "heat stroke imminent" onset / deep into the HI danger band.
  //   >= 40C apparent -> DANGEROUS HEAT (level 1);  >= 45C apparent -> EXTREME HEAT (level 2).
  // POPULATED-TILE ONLY: heat is only listed for a tile that carries a gazetteer city
  // (GZ.hasCity). 47C over empty desert is climate, not an emergency; a feels-like of
  // 40C+ matters because PEOPLE are under it, so an unpopulated tile is silent by design.
  const HEAT_DANGEROUS_BYTE = 90;   // 40C + 50  (hot/tropical/desert zones)
  const HEAT_EXTREME_BYTE = 95;     // 45C + 50
  // REGIONALIZED heat bar (heatZoneTemperate): a FLAT 40C worldwide bar misses the deadly
  // TEMPERATE/MARITIME heatwaves — Europe / Pacific NW etc. have limited AC, elderly
  // populations, and no physiological heat adaptation, so heat-health warning literature
  // (WMO-WHO / Meteo-France Vigilance / UK HHA) puts the danger onset there far lower than
  // desert. Temperate-zone cities trip DANGEROUS at 35C and EXTREME at 40C feels-like; hot
  // zones keep the 40C/45C desert bar. 35C is well above a routine temperate summer afternoon
  // (~28-32C), so this catches a genuine heatwave without crying wolf. Cold IS zoned too (see
  // COLD_TEMP_* below) — for a DIFFERENT reason than heat: not acclimatization but PREPAREDNESS.
  // Instantaneous like every other measured clause (persistence gating is a documented
  // follow-on, needs a history wire).
  const HEAT_TEMP_DANGEROUS_BYTE = 85;   // 35C + 50  (temperate/maritime zones)
  const HEAT_TEMP_EXTREME_BYTE = 90;     // 40C + 50
  const HEAT_DANGEROUS = 1, HEAT_EXTREME = 2;
  // MEASURED humid-heat (WET-BULB) thresholds — the true physiological heat-death limit,
  // which the dry-bulb feels-like does NOT isolate. Read off the RAW wet-bulb byte (degC,
  // NOT the +50 temp encoding — wet-bulb in the danger band is always positive, so a bare
  // byte prints directly and the bars compare directly), computed host-side via Stull(2011)
  // from temperature_2m + relative_humidity_2m (src/weather.js wetBulbStull). THREE named tiers
  // anchored to the recognized physiological limits of TRUE wet-bulb temperature (Tw — NOT WBGT,
  // whose alert tables use different numbers; do not borrow those):
  //   >= 35C Tw -> SURVIVAL LIMIT (level 3): theoretical limit of human thermoregulation, fatal
  //      within ~6h even for the young/healthy at rest in shade with water (Sherwood & Huber 2010);
  //   31-34C Tw -> DANGER (level 2): hazardous even for the young/healthy (Vecellio/Penn State);
  //   28-30C Tw -> CAUTION (level 1): heat-stress onset — the entry bar.
  // Wet-bulb is NOT zoned (it is an absolute physiological limit, not a preparedness/
  // acclimatization question like dry heat/cold). POPULATED-TILE ONLY (same rationale as heat).
  // SUPERSEDES the dry-heat clause on a tile where both trip (a tile is not double-reported) —
  // humid heat is the more specific, more lethal reading, so it wins.
  const WETBULB_CAUTION_C = 28;    // raw degC (byte4) — heat-stress onset, entry bar
  const WETBULB_DANGER_C = 31;
  const WETBULB_SURVIVAL_C = 35;
  const HUMID_CAUTION = 1, HUMID_DANGER = 2, HUMID_SURVIVAL = 3;
  const MAX_HUMID_STORE = 8;   // humid-heat cities kept for the list (RAM budget, mirrors heat)
  // MEASURED dangerous-COLD thresholds — the mirror of dangerous heat, on the SAME
  // apparent (feels-like) temperature byte (degC+50). Feels-like on the cold side IS
  // wind chill: Open-Meteo's apparent_temperature folds wind + humidity in, so the
  // wind-chill hazard needs NO extra field. Two tiers, chosen against the wind-chill
  // literature (Environment Canada / US NWS wind-chill charts):
  //   <= -30C apparent -> DANGEROUS COLD (level 1): frostbite on exposed skin in
  //     ~10-30 min, the Canadian wind-chill "frostbite risk" advisory band;
  //   <= -40C apparent -> EXTREME COLD (level 2): frostbite in <=5-10 min, the
  //     "frostbite in minutes / cold-weather warning" band (EC issues extreme-cold
  //     warnings around -40 to -50 wind chill across the North).
  // POPULATED-TILE ONLY (same rationale as heat): -45C over empty tundra is climate,
  // not an emergency; a killing wind chill matters because PEOPLE are under it, so an
  // unpopulated tile is silent by design.
  //
  // ABSENT-READING GUARD (why cold differs from heat): an absent apparentByte reads as
  // 0, and for the COLD floor byte 0 == -50C — i.e. absent data would masquerade as the
  // most extreme cold on EVERY tile. Heat is safe (absent 0 never clears the >=90 ceiling),
  // but cold MUST require a genuinely PRESENT finite reading (Number.isFinite) before it
  // fires. Phase-2 wire defines the absent sentinel; the reference guards on presence.
  const COLD_DANGEROUS_BYTE = 20;   // -30C + 50  (polar/continental/tropical zones)
  const COLD_EXTREME_BYTE = 10;     // -40C + 50
  // REGIONALIZED cold bar (heatZoneTemperate — SAME zone table as heat): a FLAT -30/-40C
  // worldwide bar misses the deadly TEMPERATE/MARITIME cold snaps. The rationale is NOT
  // wind-chill physics (that IS universal) but PREPAREDNESS: a -18C snap in a temperate
  // maritime city (little building winterization, exposed unhoused populations, heating-
  // system failures, a population with no cold adaptation) is a genuine killing emergency,
  // while -30C is a routine winter day in Yakutsk or Winnipeg where infrastructure and people
  // are built for it. So temperate/maritime rows (|tileLat| 45-63) trip DANGEROUS at -20C and
  // EXTREME at -30C; polar/continental/tropical rows keep the -30C/-40C bar. -20C is well below
  // a routine temperate winter (~0 to -10C), so this catches a genuine cold wave without crying
  // wolf. The ABSENT-READING GUARD still holds: the warmer bar only RAISES the ceiling byte,
  // so an absent 255 (>31) still never trips and the Number.isFinite gate is unchanged.
  const COLD_TEMP_DANGEROUS_BYTE = 30;   // -20C + 50  (temperate/maritime zones)
  const COLD_TEMP_EXTREME_BYTE = 20;     // -30C + 50
  const COLD_DANGEROUS = 1, COLD_EXTREME = 2;
  // MEASURED HOT-NIGHT ("tropical night") thresholds — the overnight-recovery counterpart to
  // the daytime feels-like heat clause. The single biggest driver of heatwave death is a night
  // whose MINIMUM temperature never drops: the body cannot shed the day's heat load overnight,
  // and the elderly die in their sleep — a signal the daytime peak alone MISSES. Read off the
  // RAW overnight-low degC byte (nightByte, byte12; NOT the +50 temp encoding — a dangerous
  // night is always well above 0C, so the bare byte prints directly and the bars compare
  // directly, exactly like the wet-bulb byte). Source = Open-Meteo daily temperature_2m_min
  // (the GMT-day overnight low), NOT a proxy. STANDARD meteorological overnight-heat terms (Met
  // Office / MeteoSwiss / DWD convention): the WMO tropical-night line is a GLOBAL 20C threshold,
  // so ONE absolute three-tier ladder applies everywhere (no zone split — the term is descriptive,
  // not alarmist): >=20C TROPICAL NIGHT, >=25C HOT NIGHT, >=30C SWELTERING NIGHT. Three tiers,
  // ranked with the heat family. A single dangerous night is the signal (no multi-night persistence
  // gate — persistence needs a history wire, a documented follow-on). POPULATED-TILE ONLY (a hot
  // night over empty desert is climate, not an emergency; it matters because PEOPLE cannot recover).
  //
  // ABSENT-READING GUARD: the wire encodes absent as 255; a real dangerous night is 20–40C, so
  // 255 never collides. The reference reads a null nightByte (Number.isFinite gate), the Z80
  // mirror guards CP 255 — the SAME absent split as apparent/wet-bulb.
  const HOTNIGHT_TROPICAL_C = 20;       // overnight-min degC — TROPICAL NIGHT (level 1), WMO global floor
  const HOTNIGHT_HOT_C = 25;            // HOT NIGHT (level 2)
  const HOTNIGHT_SWELTER_C = 30;        // SWELTERING NIGHT (level 3)
  const HOTNIGHT_TROPICAL = 1, HOTNIGHT_HOT = 2, HOTNIGHT_SWELTER = 3;
  const MAX_HOTNIGHT_STORE = 8;   // hot-night cities kept for the list (RAM budget, mirrors heat)
  const MAX_ANOMALY_STORE = 8;    // "UNUSUAL FOR HERE" departures kept for the CONDITIONS list (RAM budget)
  const PHENOMENAL_M = 14;     // Douglas 9 wave-height floor (metres) — ALERT escalation
  // Hazard classes reused from src/hazards.js (mirror; the wire already carries these
  // in the hazard trailer, so gale + phenomenal seas need NO new plumbing).
  const HZ_VTS = 1, HZ_WIND = 4, HZ_BLIZZARD = 5, HZ_SEAS = 6;

  // v2-only fixed fragments (kept in a SEPARATE table so the v1 FRAG object — which
  // the Z80 fragDB iterates — is unchanged this phase; Phase 2 merges what the Z80
  // mirror references). Each becomes a DB byte table in the compose2 Z80 mirror.
  const FRAG2 = {
    PRE: 'ZX81 ',
    WWALL: 'WEATHER WALL',
    ALERT: ' ALERT: ',
    SEMI: '; ',
    MAJ_FIRES: ' MAJOR FIRES ',
    MAJ_FIRE: ' MAJOR FIRE ',
    FLOODS: ' FLOODS ',
    FLOOD: ' FLOOD ',
    PHEN_SEAS: 'PHENOMENAL SEAS ',
    MAJ: 'MAJOR ',
    HURRSIG: 'HURRICANE SIGNATURE',
    SFLOW_L: 'STORM-FORCE LOW',
    HFLOW_L: 'HURRICANE-FORCE LOW',
    MORESTORMS: ' MORE STORMS',
    MOREP: ' +',
    MORE: ' MORE',
    MORE_FIRES: ' MORE FIRES ',
    MORE_FIRE: ' MORE FIRE ',
    MORE_FIRES0: ' MORE FIRES',
    MORE_FIRE0: ' MORE FIRE',
    MAX: 'HIGH ',                     // CONDITIONS peak (owner 2026-07-14 rename MAX->HIGH, both v2 desks)
    MIN: ', LOW ',                    // CONDITIONS trough (MIN->LOW); v2 grammar keeps the ", " join
    TEMP: 'TEMP ',                    // CONDITIONS single-reading (owner 2026-07-14 OCEANIA high==low guard):
                                      // when peak and trough are the SAME temp at the SAME place (a continent
                                      // with one eligible land reading), print ONE "TEMP tC PLACE." — never an
                                      // absurd "HIGH 11C NW AUSTRAL, LOW 11C NW AUSTRAL".
    GALE: ' GALE ',
    KMH: 'KMH ',
    SP: ' ',
    COMMA_SP: ', ',
    IN: ' IN ',                       // precip condition infix: "DRIZZLE IN LONDON, ..."
    HEAVY_SP: 'HEAVY ',               // band-3 rain/showers qualifier ("HEAVY RAIN")
    XHEAT: 'EXTREME HEAT ',           // measured feels-like >=45C, condition-first
    DHEAT: 'DANGEROUS HEAT ',         // measured feels-like >=40C, condition-first
    HUMIDLEAD: 'HEAT (WET BULB): ',   // wet-bulb qualifier stated ONCE for the whole humid clause
                                      // (owner 2026-07-13). The three tier TERMS below carry severity;
                                      // no per-city "WETBULB" repeat. City-first, temp grouped.
    HSURV: 'SURVIVAL LIMIT ',         // tier term, Tw >=35C (human survival limit)
    HDANG: 'DANGER ',                 // tier term, Tw 31-34C
    HCAUT: 'CAUTION ',                // tier term, Tw 28-30C
    HC: 'C',                          // bare degC unit, group-final ("35C") — no trailing space
    TROPNIGHT: 'TROPICAL NIGHT ',     // measured overnight-low >=20C (WMO tropical-night line) over a populated
                                      // tile, condition-first "TROPICAL NIGHT 22C <city>". The standard met term
                                      // (Met Office / MeteoSwiss / DWD); lowest of the three overnight tiers.
    HOTNIGHT: 'HOT NIGHT ',           // measured overnight-low >=25C, condition-first "HOT NIGHT 26C <city>".
                                      // A night that never cools is the biggest driver of heatwave death (no
                                      // overnight recovery — the elderly die in their sleep). Middle tier.
    SWELTNIGHT: 'SWELTERING NIGHT ',  // measured overnight-low >=30C, condition-first "SWELTERING NIGHT 31C
                                      // <city>". Extreme band, leads the overnight-heat family.
    XCOLD: 'EXTREME COLD ',           // measured feels-like (wind chill) <=-40C, condition-first
    DCOLD: 'DANGEROUS COLD ',         // measured feels-like (wind chill) <=-30C, condition-first
    ICE: 'ICE STORM',                 // freezing rain (WMO 66/67) over a populated tile,
                                      // condition-first ALERT clause + " IN <city>, ..." (FRAG2.IN)
    DUST: 'DUST STORM',               // duststorm/sandstorm (WMO 30-35) over a populated tile,
                                      // condition-first ALERT clause + " IN <city>, ..." (FRAG2.IN);
                                      // non-city dust is a CONDITIONS mention "DUST STORM IN <region>"
    DENSEFOG: 'DENSE FOG',            // WMO fog / rime fog (45/48) over a populated tile -> NOTABLE
                                      // clause "DENSE FOG IN <city>, ..." (FRAG2.IN). Calm travel wording.
    DUSTHAZE: 'DUSTY, HAZY AIR',      // WMO widespread/blowing dust & haze (06-09) over a populated tile
                                      // -> NOTABLE clause "DUSTY, HAZY AIR IN <city>, ..." (FRAG2.IN); this
                                      // is the LESSER dust band BELOW the DUST STORM ALERT (30-35). Calm
                                      // visibility/air wording — not the zero-visibility respiratory hazard.
    TSUNAMI_WARN: 'TSUNAMI WARNING ',  // AUTHORITY tsunami warning (NOAA PTWC/NTWC, tsunami.gov ATOM
                                      // Category==Warning) — the TOP-PRECEDENCE emergency, ranked at the
                                      // VERY TOP of ALERT, ABOVE even the evacuation order: a tsunami is a
                                      // coast-scale wall of water with the longest lead-warning value.
                                      // Condition-first "TSUNAMI WARNING <region>, <region2> +K MORE": a
                                      // tsunami threatens whole ocean-adjacent basins, so it names the tile's
                                      // REGION/BASIN (R.regionName — like DROUGHT, NOT a city point;
                                      // byte-parity with the Z80). Trailing space, regions follow directly (no
                                      // " IN "). Carries NO number — authority PRESENCE is the whole signal.
    EVAC_ORDER: 'EVACUATION ORDER: ',  // AUTHORITY evacuation order (CAP responseType==Evacuate, or an
                                      // evacuate-directing instruction/headline) — the single most
                                      // ACTIONABLE emergency, ranked at the VERY TOP of ALERT, above even
                                      // tornado. Singular form "EVACUATION ORDER: <place>". The place is
                                      // the gazetteer settlement at the matched CAP-area tile (byte-parity
                                      // with the Z80 reporter, like TORNADO_WARN's per-tile city). A colon
                                      // (not " IN ") separates lead from the place list.
    EVAC_ORDERS: 'EVACUATION ORDERS: ',// plural lead when >1 area is under order:
                                      // "EVACUATION ORDERS: <place1>, <place2>". Same colon grammar.
    FLASHFLOOD_WARN: 'FLASH FLOOD WARNING', // AUTHORITY flash-flood warning (WMO-CAP eventCode 3, US NWS
                                      // et al.), ranked just BELOW tornado: a flash flood is a minutes-scale
                                      // wall of water. Clause "FLASH FLOOD WARNING IN <city>, ..." (FRAG2.IN).
                                      // Authority-sourced (not our own threshold); carries NO number.
    TORNADO_WARN: 'TORNADO WARNING',  // AUTHORITY tornado warning (WMO-CAP eventCode 9, NWS et al.),
                                      // TOP-of-ALERT clause "TORNADO WARNING IN <city>, ..." (FRAG2.IN).
                                      // The ONE authority-sourced ALERT clause (all others measured);
                                      // ranked ABOVE named storms (minutes-scale lethality). We NEVER
                                      // self-declare a tornado — no detector exists.
    DROUGHT: 'DROUGHT EMERGENCY ',    // AUTHORITY drought (GDACS eventtype DR), BOTTOM-of-ALERT clause
                                      // "DROUGHT EMERGENCY E AFRICA, ... -GDACS". Region/city named + a
                                      // GDACS source tag (unlike the other ALERT clauses, which are
                                      // multi-source WMO-CAP and untagged) — drought is single-sourced
                                      // and unfamiliar as a wall item, so the attribution earns its bytes.
                                      // Slow-onset famine-scale: ranked below every acute clause, present.
    RIVER_FLOOD: 'RIVER FLOODING ',   // GloFAS river-flood forecast (Copernicus GloFAS via Open-Meteo,
                                      // KEYLESS) — a large-river flood signal SHARPER than the coarse
                                      // GDACS flood mark: a monitored city's forecast river discharge is
                                      // predicted to reach its ~2-yr-return flood level (empirical p98 of
                                      // 10-yr GloFAS reanalysis). Ranked in ALERT just ABOVE the GDACS
                                      // flood marks + drought. Region-first "RIVER FLOODING <region>,
                                      // <region2> +K MORE": a large-river flood spans a basin, so — like
                                      // TSUNAMI/DROUGHT — it names the tile's REGION/BASIN (R.regionName,
                                      // NOT the city point; byte-parity with the Z80). Trailing space,
                                      // regions follow directly (no " IN "). Carries NO number.
    GDACS_SRC: ' -GDACS',             // drought clause source attribution (trailing tag, house style)
    SMOKE: 'HAZARDOUS SMOKE ',        // MEASURED hazardous air (PM2.5>=150 ug/m3) over a populated tile,
                                      // condition-first ALERT clause "HAZARDOUS SMOKE NEW YORK, TORONTO"
                                      // (trailing space, cities follow directly — no " IN "). The
                                      // wildfire-SMOKE-plume respiratory hazard that travels far downwind
                                      // of the fire layer (Canada 2023 choked New York). Independent of
                                      // fire (smoke travels); carries NO number (the >=150 threshold is
                                      // the whole signal, like the authority clauses).
    HEAT_WARN: 'EXTREME HEAT WARNING',// AUTHORITY extreme-heat warning (WMO-CAP eventCode 4, national
                                      // met authorities), condition-first ALERT clause "EXTREME HEAT
                                      // WARNING IN SEVILLE, ..." (FRAG2.IN). Second authority clause
                                      // (with TORNADO); ranked near TOP of ALERT, above named storms —
                                      // a red heat warning is the multi-day mass-casualty event our
                                      // own measured feels-like bar can miss. NO temperature (not a
                                      // measured reading) — that is what distinguishes it from DHEAT.
    XSNOW: 'EXTREME SNOWFALL ',       // measured 24h snowfall >=50cm, condition-first ("... 55CM SAPPORO")
    HSNOW: 'HEAVY SNOWFALL ',         // measured 24h snowfall >=25cm, condition-first ("... 30CM SAPPORO")
    CM: 'CM ',                        // snowfall-amount suffix (cm), like C_SP is the degC suffix
    // --- NOTABLE tier (important but NON-emergency) fragments ---
    // The NOTABLE section is a distinct bulletin section kept SEPARATE from the red emergency
    // ALERT: it carries important-but-calm weather (mid-band smoke, aurora, and future notable
    // types), placed AFTER the CONDITIONS body and BEFORE the sign-off. Its grammar mirrors ALERT
    // (section lead on the first clause, "; " between clauses, closing "."), but the wording is
    // plain and calm — never alarming. New notable clauses slot in by emitting under this lead.
    NOTABLE: ' NOTABLE: ',            // section lead on the FIRST committed notable clause
    SMOKY: 'SMOKY, UNHEALTHY AIR OVER ', // MEASURED mid-band air (PM2.5 55-149 ug/m3, US-AQI unhealthy-
                                      // for-sensitive/unhealthy) over a POPULATED tile — BELOW the >=150
                                      // hazardous ALERT floor, so it is NOTABLE not emergency. Condition
                                      // stated ONCE, cities follow "SMOKY, UNHEALTHY AIR OVER SEATTLE,
                                      // VANCOUVER" (trailing space, no " IN "). Same air-quality feed as
                                      // the hazardous SMOKE clause; only the PM2.5 band differs. Calm wording.
    MONSOON: ' MONSOON RAINS S ASIA', // NOTABLE seasonal clause (owner 2026-08-03) — Z80 mirror c2_monsoon
    // PRODUCT DESK tags (owner 2026-08-04 rotation): one per non-WEATHER product,
    // emitted right after the header dot when the 0xCA product compose runs.
    TDESK: ' TEMP DESK.', PDESK: ' PRESSURE DESK.', SDESK: ' SATELLITE DESK.',
    WDESK: ' WIND DESK.', FDESK: ' FIRE DESK.',
    AURORA: ' AURORA WATCH KP',       // NOTABLE space-weather clause lead (+ Kp digits) — relocated from
                                      // CONDITIONS (2026-07-15): aurora is notable/delightful, not an emergency.
    VISTO: ' - VISIBLE TO ',          // + visibility latitude digits + N/S
    DEG_N: 'N', DEG_S: 'S',           // hemisphere suffix on the visibility latitude
    UNUSUAL: 'UNUSUAL: ',             // "UNUSUAL FOR HERE" CONDITIONS lead — departure from LOCAL climate
                                      // normal (not an absolute bar): "UNUSUAL: BRITAIN 12C ABOVE NORMAL,
                                      // PATAGONIA 9C BELOW NORMAL." Notable, NOT an emergency (the absolute-
                                      // threshold clauses stay the emergency channel); populated/land-focused.
    ANOM_ABOVE: 'C ABOVE NORMAL',     // warm-departure item suffix (after "<region> <N>")
    ANOM_BELOW: 'C BELOW NORMAL',     // cold-departure item suffix (a July cold snap is as anomalous as a spike)
  };
  const F2 = (name) => toZX(FRAG2[name]);

  // Normalise a fire/flood name that may arrive as a ZX-code array (wire) OR an ASCII
  // string (fixture / JS reference): returns ZX codes, uppercased + charset-filtered.
  // Cap is a DEFENSIVE store ceiling (NAME_CAP=24), NOT the everyday truncator: real fire/
  // flood/place names (e.g. "CAMBRA E CARAMULO", 17) fit whole, so the name reaches the
  // greedy packer in FULL and adaptive budget-driven shortening (full -> name-only ->
  // "+N MORE") is the packer's job, never a fixed field width. 24 « the 300-grapheme
  // bulletin budget, so a stored name always fits as the packer's first item — a clause is
  // never dropped for name length, and no name is ever cut mid-word (the "CAMBRA E CAR" bug).
  function nameZX(v, cap) {
    if (Array.isArray(v)) return v.slice(0, cap || 24);
    if (typeof v !== 'string' || !v) return [];
    const clean = v.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().replace(/\s+/g, ' ');
    return clean ? toZX(clean).slice(0, cap || 24) : [];
  }

  // ---- aggregate2: v1 aggregate + emergency/gale/phenomenal-sea signals ----
  // Superset of aggregate(): reuses every v1 stat, then adds fire/flood lists (from the
  // per-tile emergency trailer — read directly off fixture tiles here; the Z80/gateway
  // wire read is Phase 2) plus the worst gale + worst phenomenal-sea derived from the
  // EXISTING hazard trailer. Tile-address order; the Z80 mirror scans identically.
  function aggregate2(tiles, opts) {
    opts = opts || {};
    const s = aggregate(tiles);
    s.redFires = []; s.orangeFires = []; s.floods = [];
    s.galeGust = 0; s.galeTile = 0; s.galeCls = 0;
    s.seaHazWave = 0; s.seaHazTile = 0;
    s.heat = [];
    s.humidHeat = [];   // MEASURED humid-heat (wet-bulb), supersedes dry heat on a shared tile
    s.hotNight = [];    // MEASURED hot-night (overnight low), the daytime-heat clause's night counterpart
    s.cold = [];
    s.iceStorms = [];
    s.dustStorms = [];   // duststorm/sandstorm (WMO 30-35) over POPULATED tiles -> ALERT
    s.dustAreas = [];    // same over NON-city tiles -> CONDITIONS mention "when room"
    s.snow = [];         // heavy/extreme 24h snowfall (cm) over POPULATED tiles -> ALERT
    s.tsunamis = [];     // AUTHORITY tsunami warnings (NOAA tsunami.gov, Category==Warning) -> VERY TOP of ALERT.
    s.rivers = [];       // GloFAS river-flood forecasts (Copernicus GloFAS via Open-Meteo) -> ALERT, above GDACS flood.
    s.evac = [];         // AUTHORITY evacuation orders (CAP responseType==Evacuate) -> VERY TOP of ALERT.
    s.tornadoes = [];    // AUTHORITY tornado warnings (WMO-CAP eventCode 9) -> TOP-of-ALERT.
    s.flashfloods = [];  // AUTHORITY flash-flood warnings (WMO-CAP eventCode 3, US NWS et al.) -> below tornado.
    s.heatWarnings = []; // AUTHORITY extreme-heat warnings (WMO-CAP eventCode 4) -> near-TOP-of-ALERT.
    s.droughts = [];     // AUTHORITY drought emergencies (GDACS eventtype DR) -> BOTTOM-of-ALERT (slow-onset).
    s.smoke = [];        // MEASURED hazardous smoke (PM2.5>=150) over populated tiles -> dangerous-air tier.
    s.smokeMid = [];     // MEASURED mid-band smoke (PM2.5 55-149) over populated tiles -> NOTABLE tier (below the ALERT floor).
    s.fog = [];          // DENSE FOG (WMO 45/48) over populated tiles -> NOTABLE tier (travel/visibility; frame bit6, not a header feed).
    s.dustHaze = [];     // MODERATE DUST/HAZE (WMO 06-09) over populated tiles -> NOTABLE tier (below the DUST STORM ALERT; frame bit7).
    s.anomalies = [];    // UNUSUAL FOR HERE — notable departures from LOCAL climate normal -> CONDITIONS.
    // AURORA WATCH — global scalar (one planetary Kp worldwide, NOAA SWPC), not a
    // per-tile signal: threaded in via opts.kp (observed current Kp). null/absent =>
    // no space-weather clause. compose2 turns it into a CONDITIONS line via SW.auroraWatch.
    s.kp = (typeof opts.kp === 'number' && isFinite(opts.kp)) ? opts.kp : null;
    // AUTHORITY tsunami warnings — NOAA tsunami.gov (PTWC/NTWC ATOM, Category=="Warning"), matched
    // to its epicenter/basin tile by src/tsunami.js tsunamiToTiles (NO land-only restriction — a
    // tsunami threatens ocean-adjacent tiles). opts.tsunamis is that matcher output: [{tile, area}]
    // already deduped + tile-ascending. Keep one per tile, tile-ascending, capped. The `area` (NOAA
    // affected-region readable label) is carried for the ALT prose + tracer; the byte-exact bulletin
    // renders the tile's REGION/BASIN name (R.regionName, byte-parity with the Z80 — same as drought).
    // Absent/malformed => empty (an absent feed never fabricates a warning; a non-Warning never fires).
    if (Array.isArray(opts.tsunamis)) {
      const seenTs = new Set();
      for (const m of opts.tsunamis) {
        if (!m) continue;
        const tile = m.tile | 0;
        if (tile < 0 || tile > 99 || seenTs.has(tile)) continue;
        seenTs.add(tile);
        if (s.tsunamis.length < MAX_TSUNAMI_STORE) s.tsunamis.push({ tile, area: (typeof m.area === 'string') ? m.area : '' });
      }
      s.tsunamis.sort((a, b) => a.tile - b.tile);
    }
    // GloFAS RIVER-FLOOD forecasts — Copernicus GloFAS river discharge (via Open-Meteo, KEYLESS),
    // matched to a monitored city's tile by src/river-flood.js floodTiles (forecast discharge >= the
    // point's empirical p98 flood level). opts.rivers is that matcher output: [{tile, area}] already
    // deduped + tile-ascending. Keep one per tile, tile-ascending, capped. The `area` (the flooding
    // gazetteer CITY name) rides the ALT prose + tracer; the byte-exact bulletin renders the tile's
    // REGION/BASIN name (R.regionName, byte-parity with the Z80 — same as tsunami/drought). Absent/
    // malformed => empty (an absent feed never fabricates a flood; a below-threshold forecast never fires).
    if (Array.isArray(opts.rivers)) {
      const seenRv = new Set();
      for (const m of opts.rivers) {
        if (!m) continue;
        const tile = m.tile | 0;
        if (tile < 0 || tile > 99 || seenRv.has(tile)) continue;
        seenRv.add(tile);
        if (s.rivers.length < MAX_RIVER_STORE) s.rivers.push({ tile, area: (typeof m.area === 'string') ? m.area : '' });
      }
      s.rivers.sort((a, b) => a.tile - b.tile);
    }
    // AUTHORITY evacuation orders — the CAP responseType=="Evacuate" (or an evacuate-directing
    // instruction/headline) signal, as the STATES the order covers (alert-places.js evacToPlaces).
    // opts.evac is that output: [{place}] deduped + place-ID ascending. The bulletin names the
    // state (AP.placeName) — byte-parity with the Z80 (PLBLOB). Absent/malformed/unknown place =>
    // skipped (an absent feed never fabricates an evacuation; only real CAP evac alerts).
    storePlaces(opts.evac, s.evac, MAX_EVAC_STORE, null);
    // AUTHORITY tornado warnings — NOT a measured signal (we have no tornado detector).
    // opts.tornadoes is the alert-places matchToPlaces output ([{place, eventCode}]: already
    // Extreme/Severe WARNINGS, one entry per warned state). Keep ONLY eventCode 9 (TORNADO),
    // one per place, place-ID ascending, capped. Absent/malformed => empty (honest: an absent
    // feed never fabricates a tornado).
    storePlaces(opts.tornadoes, s.tornadoes, MAX_TORNADO_STORE, TORNADO_EVENT_CODE);
    // AUTHORITY flash-flood warnings — same place-threading as opts.tornadoes. Keep ONLY eventCode 3
    // (FLASH FLOOD — a plain river flood warning never maps to 3), one per place, place-ID ascending,
    // capped. Absent/malformed => empty (an absent feed never fabricates a warning).
    storePlaces(opts.flashfloods, s.flashfloods, MAX_FLASHFLOOD_STORE, FLASHFLOOD_EVENT_CODE);
    // AUTHORITY extreme-heat warnings — same opts-threading pattern as opts.tornadoes (the
    // gateway CAP-register -> matcher wire is Phase 2 / DR-19). Keep ONLY eventCode 4 (EXTREME
    // HEAT), one per tile, tile-ascending, capped. Absent/malformed => empty (an absent feed
    // never fabricates a warning).
    if (Array.isArray(opts.heatWarnings)) {
      const seenHw = new Set();
      for (const m of opts.heatWarnings) {
        if (!m || (m.eventCode | 0) !== HEAT_WARN_EVENT_CODE) continue;
        const tile = m.tile | 0;
        if (seenHw.has(tile)) continue;
        seenHw.add(tile);
        if (s.heatWarnings.length < MAX_HEATWARN_STORE) s.heatWarnings.push({ tile });
      }
      s.heatWarnings.sort((a, b) => a.tile - b.tile);
    }
    // AUTHORITY drought emergencies — GDACS eventtype DR (the KEYLESS public-domain global
    // disaster feed, already fetched + filtered to weather classes in src/gdacs.js; DR passes
    // filterWeather). UNLIKE tornado/heat these are NOT WMO-CAP marks and carry no eventCode:
    // opts.droughts is a list of GDACS DR items each pre-mapped to a grid tile (gdacs.tileOf).
    // Authority-first (v1): the mere PRESENCE of a red/orange GDACS drought on a tile lights the
    // clause — a measured precip-deficit signal is optional polish. One per tile, tile-ascending,
    // capped. Absent/malformed => empty (an absent feed never fabricates a drought).
    if (Array.isArray(opts.droughts)) {
      const seenDr = new Set();
      for (const m of opts.droughts) {
        if (!m) continue;
        const tile = m.tile | 0;
        if (tile < 0 || tile > 99 || seenDr.has(tile)) continue;
        seenDr.add(tile);
        if (s.droughts.length < MAX_DROUGHT_STORE) s.droughts.push({ tile });
      }
      s.droughts.sort((a, b) => a.tile - b.tile);
    }
    // MEASURED hazardous smoke — the wildfire-SMOKE respiratory hazard. Open-Meteo's keyless
    // air-quality API supplies ground-level PM2.5 (ug/m3); a tile whose measured PM2.5 meets the
    // HAZARDOUS floor (>=150, US-AQI very-unhealthy/hazardous) over a POPULATED tile is elevated
    // to an ALERT. Like drought this rides the 0xC4 HEADER (not a per-tile v2 frame byte — bytes
    // 0-11 are full), so the >=150 threshold + hasCity + sea-snap filter live in the ingest
    // (refresh-report smokeTilesLive), the SAME in-refresh filtering discipline drought uses.
    // opts.smoke is that pre-filtered tile list. One per tile, tile-ascending, capped. Absent/
    // malformed => empty (an absent feed never fabricates a smoke emergency). INDEPENDENT of the
    // fire layer — smoke travels far downwind of any fire we track.
    if (Array.isArray(opts.smoke)) {
      const seenSm = new Set();
      for (const m of opts.smoke) {
        if (!m) continue;
        const tile = m.tile | 0;
        if (tile < 0 || tile > 99 || seenSm.has(tile)) continue;
        seenSm.add(tile);
        if (s.smoke.length < MAX_SMOKE_STORE) s.smoke.push({ tile });
      }
      s.smoke.sort((a, b) => a.tile - b.tile);
    }
    // MEASURED mid-band smoke (PM2.5 55-149 ug/m3) — the NOTABLE-tier air-quality signal, BELOW the
    // >=150 hazardous ALERT floor. Same pre-filtered discipline as the hazardous band: the threshold
    // band + hasCity + sea-snap filter live in the ingest (refresh-report smokeMidTilesLive), so
    // opts.smokeMid arrives as an already-notable tile list. One per tile, tile-ascending, capped.
    // DISJOINT from opts.smoke by construction (a tile is either mid-band or hazardous, never both).
    // Absent/malformed => empty (an absent feed never fabricates a smoke claim).
    if (Array.isArray(opts.smokeMid)) {
      const seenSm2 = new Set();
      for (const m of opts.smokeMid) {
        if (!m) continue;
        const tile = m.tile | 0;
        if (tile < 0 || tile > 99 || seenSm2.has(tile)) continue;
        seenSm2.add(tile);
        if (s.smokeMid.length < MAX_SMOKEMID_STORE) s.smokeMid.push({ tile });
      }
      s.smokeMid.sort((a, b) => a.tile - b.tile);
    }
    // UNUSUAL FOR HERE — departure from the tile's LOCAL climate normal (CONDITIONS; notable,
    // not an emergency). Like drought/smoke this is pre-filtered in the ingest (refresh-report
    // anomalyTilesLive): the "notable" gate (>=UNUSUAL_SIGMA sigma AND >=UNUSUAL_MIN_C degC) +
    // hasCity/land-focus + the per-tile normal all live host-side in src/climatenormal.js, so
    // opts.anomalies arrives as an already-notable [{tile, deltaC}] list (deltaC signed, +warm/
    // -cold). One per tile, capped; the compose sorts worst-departure-first. Absent/malformed =>
    // empty (no cache -> no anomaly claim; NEVER fabricates a normal).
    if (Array.isArray(opts.anomalies)) {
      const seenAn = new Set();
      for (const m of opts.anomalies) {
        if (!m) continue;
        const tile = m.tile | 0;
        if (tile < 0 || tile > 99 || seenAn.has(tile)) continue;
        if (typeof m.deltaC !== 'number' || !isFinite(m.deltaC)) continue;
        seenAn.add(tile);
        if (s.anomalies.length < MAX_ANOMALY_STORE) s.anomalies.push({ tile, deltaC: Math.round(m.deltaC) });
      }
    }
    for (let t = 0; t < tiles.length; t++) {
      const w = tiles[t]; if (!w) continue;
      // MEASURED dangerous heat (feels-like), populated-tile only. apparentByte is the
      // apparent-temperature byte (degC+50) read off the tile — Phase-2 wire-plumbed like
      // the fire/flood emergency trailer; here it is read straight off the fixture tile.
      // A tile with no gazetteer city, or below the DANGEROUS floor, contributes nothing.
      const ab = w.apparentByte | 0;
      // MEASURED humid heat (wet-bulb), populated-tile only — checked BEFORE dry heat because it
      // SUPERSEDES it (a tile that trips humid heat is not also listed as dry heat). wetBulbByte is
      // the RAW wet-bulb degC (byte4), computed host-side via Stull; absent (non-finite) never trips.
      const wb = w.wetBulbByte;
      // humidQual / heatQual = QUALIFIES for the humid / dry-heat clause (threshold + city),
      // independent of the store cap. The heat FAMILY is a strict priority ladder — a city
      // appears in AT MOST ONE heat clause, its most-severe tier: wet-bulb > dry heat >
      // sweltering night > hot night (owner 2026-07-14, ends the same-city-twice double-list).
      const humidQual = Number.isFinite(wb) && wb >= WETBULB_CAUTION_C && GZ.hasCity(t);
      let humidTrips = false;
      if (humidQual && s.humidHeat.length < MAX_HUMID_STORE) {
        const level = wb >= WETBULB_SURVIVAL_C ? HUMID_SURVIVAL : (wb >= WETBULB_DANGER_C ? HUMID_DANGER : HUMID_CAUTION);
        s.humidHeat.push({ tile: t, byte: wb, level });
        humidTrips = true;
      }
      // Zone-specific bar (temperate/maritime rows trip lower — see HEAT_TEMP_* note). Dry heat is
      // SUPPRESSED on a tile the humid clause already claims (reconciliation — no double-report).
      const heatDangByte = heatZoneTemperate(t) ? HEAT_TEMP_DANGEROUS_BYTE : HEAT_DANGEROUS_BYTE;
      const heatExtrByte = heatZoneTemperate(t) ? HEAT_TEMP_EXTREME_BYTE : HEAT_EXTREME_BYTE;
      const heatQual = ab >= heatDangByte && GZ.hasCity(t);
      if (!humidTrips && heatQual && s.heat.length < MAX_HEAT_STORE) {
        s.heat.push({ tile: t, byte: ab, level: ab >= heatExtrByte ? HEAT_EXTREME : HEAT_DANGEROUS });
      }
      // MEASURED dangerous COLD (wind-chill / feels-like), populated-tile only — the mirror
      // of dangerous heat. REQUIRES a genuinely present finite apparent reading (absent==0
      // would otherwise masquerade as -50C on the cold floor; see the threshold note above).
      // Zone-specific bar (temperate/maritime rows trip WARMER — see COLD_TEMP_* note).
      const coldDangByte = heatZoneTemperate(t) ? COLD_TEMP_DANGEROUS_BYTE : COLD_DANGEROUS_BYTE;
      const coldExtrByte = heatZoneTemperate(t) ? COLD_TEMP_EXTREME_BYTE : COLD_EXTREME_BYTE;
      if (Number.isFinite(w.apparentByte) && ab <= coldDangByte && GZ.hasCity(t) && s.cold.length < MAX_COLD_STORE) {
        s.cold.push({ tile: t, byte: ab, level: ab <= coldExtrByte ? COLD_EXTREME : COLD_DANGEROUS });
      }
      // ICE STORM — freezing rain (WMO 66/67, precip type 4) over a POPULATED tile is
      // elevated from mere precip to an ALERT-class hazard (an ice storm downs power/trees
      // and is genuinely dangerous where PEOPLE are). Populated-tile only, same reasoning
      // as measured heat: a non-city freezing-rain tile stays plain FREEZING RAIN in the
      // precip groups (compose2 clause c). Read off the SAME packed precip descriptor the
      // v1 precip list uses (no new wire field).
      if (L.precipDescType(w.precipByte) === ICE_TYPE && GZ.hasCity(t) && s.iceStorms.length < MAX_ICE_STORE) {
        s.iceStorms.push({ tile: t });
      }
      // DUST STORM — WMO duststorm/sandstorm (codes 30-35) is a serious visibility /
      // respiratory / traffic hazard. A gazetteer-city tile is elevated to an ALERT-class
      // DUST STORM (grouped grammar, like ice storms); a NON-city duststorm tile gets a
      // CONDITIONS mention "when room" (interesting, not a city emergency) — the SAME
      // populated/unpopulated split the ice-storm and heat scans use. Read off the RAW WMO
      // weather code on the tile (Phase-2 wire like apparentByte; here off the fixture). The
      // lesser haze / blowing-dust codes (06-09) are NOT a duststorm and never fire (L.isDustStorm).
      if (L.isDustStorm(w.weatherCode)) {
        if (GZ.hasCity(t)) { if (s.dustStorms.length < MAX_DUST_STORE) s.dustStorms.push({ tile: t }); }
        else if (s.dustAreas.length < MAX_DUST_STORE) s.dustAreas.push({ tile: t });
      }
      // DENSE FOG — WMO fog / rime fog (codes 45/48) over a POPULATED tile is a travel/visibility
      // matter: important but NON-emergency, so it rides the NOTABLE section (not ALERT). City-only
      // (non-city fog has nothing to caption), grouped grammar "DENSE FOG IN <cities>". Read off the
      // RAW WMO weather code; the Z80 mirror reads the frame's fog bit (byte1 bit6, gateway-set from
      // the SAME predicate), so both desks select the identical tiles. Frame-derived -> continental free.
      if (L.isFog(w.weatherCode) && GZ.hasCity(t) && s.fog.length < MAX_FOG_STORE) s.fog.push({ tile: t });
      // MODERATE DUST / HAZE — WMO widespread suspended dust / wind-raised dust / dust whirls / duststorm-
      // in-sight (codes 06-09) over a POPULATED tile is a visibility/air matter BELOW the DUST STORM ALERT
      // (30-35): important but NON-emergency, so it rides the NOTABLE section. City-only, grouped grammar
      // "DUSTY, HAZY AIR IN <cities>". Read off the RAW WMO weather code; the Z80 mirror reads the frame's
      // dust-haze bit (byte1 bit7, gateway-set from the SAME L.isDustHaze predicate), so both desks select
      // the identical tiles. Frame-derived -> continental free (like fog).
      if (L.isDustHaze(w.weatherCode) && GZ.hasCity(t) && s.dustHaze.length < MAX_DUSTHAZE_STORE) s.dustHaze.push({ tile: t });
      // MEASURED heavy/extreme SNOWFALL — the day's snowfall accumulation (cm) over a POPULATED
      // tile is elevated to an ALERT-class hazard: >=25cm HEAVY, >=50cm EXTREME. Populated-tile
      // only (same split as heat/cold): a big dump matters where PEOPLE + infrastructure are.
      // snowByte is the per-tile snowfall byte (cm, 0..255) — Phase-2 wire-plumbed like the
      // apparent-temp byte; here read straight off the fixture tile. Absent (0cm) is below the
      // HEAVY floor -> silent, no absent-masquerade guard needed (unlike cold).
      const sb = w.snowByte | 0;
      if (sb >= SNOW_HEAVY_CM && GZ.hasCity(t) && s.snow.length < MAX_SNOW_STORE) {
        s.snow.push({ tile: t, cm: sb, level: sb >= SNOW_EXTREME_CM ? SNOW_EXTREME : SNOW_HEAVY });
      }
      // MEASURED overnight-heat — the overnight low (nightByte, RAW degC) over a POPULATED tile is
      // elevated to an ALERT-class health warning. ABSOLUTE three-tier ladder (no zone split — see
      // HOTNIGHT_*): >=20 TROPICAL, >=25 HOT, >=30 SWELTERING. nightByte is the per-tile overnight-min
      // byte (RAW degC); null/absent never trips (a present-reading gate, like cold — an absent 255
      // on the wire is guarded Z80-side).
      const nb = w.nightByte;
      // SUPPRESSED on any tile that already qualifies for a higher heat-family tier (wet-bulb
      // OR dry heat) — the city is reported there, never twice (owner 2026-07-14 double-list fix).
      if (Number.isFinite(nb) && GZ.hasCity(t) && !humidQual && !heatQual && s.hotNight.length < MAX_HOTNIGHT_STORE) {
        if (nb >= HOTNIGHT_TROPICAL_C) {
          const level = nb >= HOTNIGHT_SWELTER_C ? HOTNIGHT_SWELTER
            : (nb >= HOTNIGHT_HOT_C ? HOTNIGHT_HOT : HOTNIGHT_TROPICAL);
          s.hotNight.push({ tile: t, byte: nb, level });
        }
      }
      const fl = w.fireLevel | 0;
      if (fl === 2 && s.redFires.length < MAX_FIRE_STORE) {
        s.redFires.push({ tile: t, name: nameZX(w.fireName, 24), country: nameZX(w.fireCountry, 24) });
      } else if (fl === 1 && s.orangeFires.length < MAX_FIRE_STORE) {
        s.orangeFires.push({ tile: t, name: nameZX(w.fireName, 24), country: nameZX(w.fireCountry, 24) });
      }
      if ((w.floodFlag | 0) && s.floods.length < MAX_FLOOD_STORE) {
        s.floods.push({ tile: t, place: nameZX(w.floodPlace, 24), country: nameZX(w.floodCountry, 24) });
      }
      const hc = w.hazClass | 0, hv = w.hazVal | 0;
      if ((hc === HZ_WIND || hc === HZ_VTS || hc === HZ_BLIZZARD) && hv > s.galeGust) {
        s.galeGust = hv; s.galeTile = t; s.galeCls = hc;
      }
      if (hc === HZ_SEAS && hv > s.seaHazWave) { s.seaHazWave = hv; s.seaHazTile = t; }
    }
    // MONSOON census (owner 2026-08-03): precip-active tiles among the fixed S Asia
    // monsoon box (rows 3-4, cols 6-8 — Arabian Sea/India/Bay of Bengal/SE Asia).
    // INDEPENDENT of the capped precip-8 list (a wet planet can crowd the box tiles
    // out of it). Z80 mirror: ag_monwet census in tools/reporter.js.
    const MONSOON_TILES = [36, 37, 38, 46, 47, 48];
    s.monsoonWet = MONSOON_TILES.filter((mt) => {
      const w = tiles[mt];
      return w && L.precipDescType((w.precipByte == null ? 0 : w.precipByte) & 0xff) > 0;
    }).length;
    return s;
  }

  // ---- compose2: the v2 bulletin (ZX81 codes) ----------------------------
  // opts.contId (0..5) => continental desk (no cyclone / no open-ocean sea, land-focused
  // sign-off); absent => global desk. timeZ = gateway ZX81 time codes. <=300, tail-safe.
  function compose2(stats, timeZ, opts) {
    opts = opts || {};
    const isCont = opts.contId != null;
    const out = [];
    const pushLim = (arr, lim) => {
      if (out.length + arr.length > lim) return false;
      for (const b of arr) out.push(b);
      return true;
    };
    const isNamed = (c) => !!(c.name && c.name.length > 0 && c.press != null);
    void pushLim;   // v1-style helper kept for reference; compose2 uses commit() below

    // ---- reserve the sign-off tail first (never truncated) ----
    // Tail leads with a space so it reads ". 100 ZX81S ON WATCH." after the last clause.
    let tail;
    if (isCont) {
      const cont = toZX(R.CONTINENT_NAMES[opts.contId]);
      const nAlloc = R.CONTINENT_TILE_COUNT[opts.contId];
      tail = toZX(' ').concat(numZX(stats.seen)).concat(F('COF')).concat(numZX(nAlloc))
        .concat(toZX(' ')).concat(cont).concat(F('CSIGN'));
    } else {
      tail = toZX(' ').concat(numZX(stats.seen)).concat(F('REPORTING'));   // " ZX81S ON WATCH."
    }
    const limit = CAP - tail.length;

    // commit(buf): append `buf` ATOMICALLY iff it fits under `limit`. Every clause is
    // built into a local buffer and committed as a unit, so a clause that would overflow
    // is dropped WHOLE (never partially) — the discipline greedy fill needs when it
    // deliberately fills to the brink.
    const commit = (buf) => {
      if (out.length + buf.length > limit) return false;
      for (const b of buf) out.push(b);
      return true;
    };
    const cat = (...parts) => { const b = []; for (const p of parts) for (const x of p) b.push(x); return b; };

    // greedyPack(lead, items, renderFull, renderShort, sep, moreWord, avail):
    // build "lead item0 sep item1 ... [+K MORE moreWord]" into ONE buffer that fits in
    // `avail`, climbing renderFull -> renderShort per item, then collapsing the tail to
    // a "+K MORE" count. Returns the buffer (>=1 item) or null if nothing fits.
    const greedyPack = (lead, items, renderFull, renderShort, sep, moreWord, avail) => {
      if (lead.length > avail) return null;
      const b = lead.slice();
      let printed = 0;
      const trailerW = (F2('MOREP').length + numZX(items.length).length + moreWord.length);
      for (let i = 0; i < items.length; i++) {
        const s = printed ? sep : [];
        const res = (i < items.length - 1) ? trailerW : 0;
        let form = renderFull(items[i]);
        if (b.length + s.length + form.length + res > avail) {
          const sh = renderShort ? renderShort(items[i]) : null;
          if (sh && b.length + s.length + sh.length + res <= avail) form = sh;
          else break;
        }
        for (const x of s) b.push(x); for (const x of form) b.push(x); printed++;
      }
      if (printed === 0) return null;
      const leftover = items.length - printed;
      if (leftover > 0) { for (const x of F2('MOREP')) b.push(x); for (const x of numZX(leftover)) b.push(x); for (const x of moreWord) b.push(x); }
      return b;
    };

    // ---- HEADER: "ZX81 <SCOPE> <time>." ----
    commit(cat(F2('PRE'), isCont ? toZX(R.CONTINENT_NAMES[opts.contId]) : F2('WWALL'),
      toZX(' '), timeZ.slice(), F('DOT')));
    // PRODUCT DESK TAG (owner 2026-08-04): the 4-hourly rotation names its product
    // right after the header dot — " TEMP DESK." etc. prodIdx 0/absent = plain
    // global (WEATHER slot; the header already says WEATHER WALL). Never on a
    // continental desk. Z80 mirror: c2_hdrdone PRODTAB dispatch (0xCA wire).
    const PRODFRAG = [null, 'TDESK', 'PDESK', 'SDESK', 'WDESK', 'FDESK'];
    if (!isCont && (opts.prodIdx | 0) >= 1 && (opts.prodIdx | 0) <= 5)
      commit(F2(PRODFRAG[opts.prodIdx | 0]));

    // continental seen==0 honest-degrade (mirror v1): NO fabricated extremes. Sign-off
    // here has NO leading space ("NO DATA. 0 OF N ..."), so it is built inline rather
    // than reusing the space-led `tail`.
    if (isCont && stats.seen === 0) {
      commit(cat(toZX(' '), F('CNODATA'),
        numZX(0), F('COF'), numZX(R.CONTINENT_TILE_COUNT[opts.contId]),
        toZX(' '), toZX(R.CONTINENT_NAMES[opts.contId]), F('CSIGN')));
      const z0 = Uint8Array.from(out.slice(0, CAP));
      return { z: z0, text: fromZX(z0), len: z0.length };
    }

    // ---- ALERT (NAVTEX precedence, worst-first, omit-when-quiet) ----
    // Each category is one atomic, greedy clause; the FIRST committed clause carries the
    // " ALERT: " lead, later ones a "; " lead. A clause built into `body` (no leading
    // space) is prefixed by the lead and committed atomically.
    let alertStarted = false;
    const alertCommit = (body) => {
      while (body.length && body[0] === 0) body.shift();   // trim leading space (kind labels)
      if (body.length === 0) return false;
      const lead = alertStarted ? F2('SEMI') : F2('ALERT');
      if (commit(cat(lead, body))) { alertStarted = true; return true; }
      return false;
    };

    // TORNADO WARNING ALERT clause — AUTHORITY-sourced (WMO-CAP eventCode 9: NWS et al.),
    // ranked TOP of ALERT, ABOVE named storms: a tornado is minutes-scale lethality, the most
    // time-critical warning on the board. This is the ONE authority clause in the bulletin
    // ALERT class (every other clause is a measured/self-judged fact); we NEVER self-declare a
    // tornado (no detector). Grouped condition-first grammar like ice/dust: condition stated
    // ONCE + the warned STATES listed "TORNADO WARNING IN TEXAS, OKLAHOMA" (FRAG2.IN), most
    // populous first (place-ID order), greedy "+K MORE" under the 300 budget. Both
    // desks. Unlike the measured clauses this event ALSO flashes via the existing CAP path
    // (composeWmoFlash) — the flash and the bulletin ALERT are independent, consistent surfaces
    // of the SAME authority event. US coverage is the honest practical limit (NWS is the CAP
    // tornado-warning issuer at this granularity; documented in NOTES).
    // EVACUATION ORDER ALERT clause — AUTHORITY-sourced (CAP responseType==Evacuate, or an
    // evacuate-directing instruction/headline), ranked at the VERY TOP of ALERT, ABOVE even
    // tornado: a live "leave now" directive is the single most actionable emergency on the board.
    // Grammar differs from the " IN " city-list clauses: a COLON separates the lead from the place
    // list, and the lead is count-aware — "EVACUATION ORDER: <place>" for one, "EVACUATION ORDERS:
    // <place1>, <place2>" for several. Places are the STATES the order covers (AP.placeName —
    // byte-parity with the Z80 PLBLOB, like tornado), most populous first, greedy "+K MORE"
    // under the 300 budget. Both desks. Honest: only real CAP evac alerts
    // reach opts.evac; an absent feed emits nothing.
    // AUTHORITY tsunami warning — NOAA tsunami.gov (Category==Warning), the TOP-PRECEDENCE emergency,
    // ABOVE even evacuation: a tsunami is a coast-scale wall of water. A tsunami threatens whole
    // ocean-adjacent basins, so — like DROUGHT — it names each matched tile's REGION/BASIN
    // (R.regionName, NOT the city point the acute per-city clauses use), greedy-packed under the 300
    // budget, "TSUNAMI WARNING <region>, <region2> +K MORE" (trailing space, no " IN ", no source tag).
    // Both desks. Authority-sourced, carries NO number. Honest: only real Category==Warning entries
    // reach opts.tsunamis; an absent feed emits nothing.
    const emitTsunami = () => {
      const ts = stats.tsunamis || [];
      if (!ts.length) return;
      const items = ts.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = F2('TSUNAMI_WARN').slice();   // "TSUNAMI WARNING " (trailing space, no " IN ")
      const body = greedyPack(lead, items, (h) => toZX(R.regionName(h.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // GloFAS RIVER-FLOOD forecast — Copernicus GloFAS river discharge (via Open-Meteo, KEYLESS),
    // a large-river flood signal SHARPER than the coarse GDACS flood mark: a monitored city's
    // forecast discharge is predicted to reach its ~2-yr-return flood level. Ranked in ALERT just
    // above the GDACS flood clause + drought. Like tsunami/drought it names each matched tile's
    // REGION/BASIN (R.regionName, NOT the city point), greedy-packed under the 300 budget:
    // "RIVER FLOODING <region>, <region2> +K MORE" (trailing space, no " IN ", no source tag).
    // Both desks. Carries NO number. Honest: only real above-threshold forecasts reach opts.rivers;
    // an absent feed emits nothing.
    const emitRiver = () => {
      const rv = stats.rivers || [];
      if (!rv.length) return;
      const items = rv.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = F2('RIVER_FLOOD').slice();   // "RIVER FLOODING " (trailing space, no " IN ")
      const body = greedyPack(lead, items, (h) => toZX(R.regionName(h.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    const emitEvac = () => {
      const ev = stats.evac || [];
      if (!ev.length) return;
      const items = ev.slice().sort((a, b) => a.place - b.place);   // most populous state first
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = (ev.length === 1 ? F2('EVAC_ORDER') : F2('EVAC_ORDERS')).slice();  // colon lead, no " IN "
      const body = greedyPack(lead, items, (h) => toZX(AP.placeName(h.place)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    const emitTornado = () => {
      const tw = stats.tornadoes || [];
      if (!tw.length) return;
      const items = tw.slice().sort((a, b) => a.place - b.place);   // most populous state first
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = cat(F2('TORNADO_WARN'), F2('IN'));   // "TORNADO WARNING IN "
      const body = greedyPack(lead, items, (h) => toZX(AP.placeName(h.place)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // AUTHORITY flash-flood ALERT clause — WMO-CAP eventCode 3 (US NWS et al.), ranked just BELOW
    // tornado: a flash flood is minutes-scale wall-of-water lethality. Same grouped condition-first
    // grammar as tornado: "FLASH FLOOD WARNING IN ARIZONA, NEW MEXICO" warned states, most populous
    // first, greedy "+K MORE" under budget. Both desks. Authority-sourced, carries NO number.
    const emitFlashFlood = () => {
      const ff = stats.flashfloods || [];
      if (!ff.length) return;
      const items = ff.slice().sort((a, b) => a.place - b.place);   // most populous state first
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = cat(F2('FLASHFLOOD_WARN'), F2('IN'));   // "FLASH FLOOD WARNING IN "
      const body = greedyPack(lead, items, (h) => toZX(AP.placeName(h.place)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // AUTHORITY extreme-heat ALERT clause — WMO-CAP eventCode 4 (national met authorities),
    // ranked just BELOW tornado and ABOVE named storms (a red heat warning is a multi-day
    // mass-casualty event; NAVTEX precedence puts authority warnings high). Same grouped
    // condition-first grammar as tornado: "EXTREME HEAT WARNING IN SEVILLE, ROME, ..." cities
    // by population rank then tile, greedy "+K MORE" under budget. Both desks. Carries NO
    // temperature — it is an authority warning, not a measured reading (distinct from emitHeat).
    const emitHeatWarn = () => {
      const hw = stats.heatWarnings || [];
      if (!hw.length) return;
      const items = hw.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = cat(F2('HEAT_WARN'), F2('IN'));   // "EXTREME HEAT WARNING IN "
      const body = greedyPack(lead, items, (h) => toZX(precipName(h.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // AUTHORITY drought ALERT clause — GDACS eventtype DR, ranked at the BOTTOM of ALERT (below
    // every acute storm/fire/flood clause): drought is famine-scale but slow-onset, so NAVTEX
    // precedence keeps it present-but-last. "DROUGHT EMERGENCY E AFRICA, S ASIA -GDACS": drought
    // is a continental-scale phenomenon, so it names the tile's REGION (R.regionName — NOT the
    // city-point rendering the acute per-city clauses use), greedy-packed under the 300 budget,
    // then a trailing " -GDACS" source tag (room for which is reserved in the greedy budget).
    // Both desks. Carries NO measurement — authority-first PRESENCE is the whole signal (a
    // precip-deficit reading is optional polish).
    const emitDrought = () => {
      const dr = stats.droughts || [];
      if (!dr.length) return;
      const items = dr.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const srcW = F2('GDACS_SRC').length;
      const lead = F2('DROUGHT').slice();   // "DROUGHT EMERGENCY " (trailing space, no " IN ")
      const body = greedyPack(lead, items, (d) => toZX(R.regionName(d.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW - srcW);
      if (body) { for (const x of F2('GDACS_SRC')) body.push(x); alertCommit(body); }
    };

    // HAZARDOUS SMOKE ALERT clause — MEASURED PM2.5>=150 over populated tiles (the wildfire-
    // smoke plume that kills far downwind). "HAZARDOUS SMOKE NEW YORK, TORONTO": condition
    // stated ONCE, cities listed by population rank then tile, greedy "+K MORE" under the 300
    // budget. Ranked in the dangerous-air tier (alongside DUST STORMS — the two airborne-
    // particulate hazards). Carries NO number (the >=150 threshold is the whole signal). Both
    // desks. Structurally the drought clause without the source tag, rendering CITY (precipName)
    // not region. INDEPENDENT of fire — smoke travels.
    const emitSmoke = () => {
      const sm = stats.smoke || [];
      if (!sm.length) return;
      const items = sm.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = F2('SMOKE').slice();   // "HAZARDOUS SMOKE " (trailing space, cities follow, no " IN ")
      const body = greedyPack(lead, items, (h) => toZX(precipName(h.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // MEASURED-heat ALERT clauses, grouped like precip (owner's grammar): condition +
    // feels-like temp stated ONCE, cities listed — "EXTREME HEAT 47C DELHI" /
    // "DANGEROUS HEAT 41C PHOENIX, CAIRO". Grouped by (level, apparentByte) so every
    // city named genuinely reads the SAME measured feels-like the clause prints (a
    // different byte is a different, honest clause). Groups hottest-byte first; cities
    // within a byte ordered by population rank then tile (orderPrecip discipline).
    // Greedy fill collapses the city tail to "+K MORE" under the 300 budget. Applies
    // to BOTH desks (a city under a heat dome is an emergency on any desk). This is a
    // BULLETIN fact only — it NEVER flashes (flashes stay WMO-CAP-authority-only;
    // constitution bars self-judged hazard flashes). Authority heat warnings keep
    // flashing via composeWmoFlash, unchanged.
    const emitHeat = (level) => {
      const hs = stats.heat ? stats.heat.filter((h) => h.level === level) : [];
      if (!hs.length) return;
      // hottest-first, then population rank then tile — one flat list, phrase stated ONCE, the
      // per-city feels-like moved INTO each entry ("EXTREME HEAT 47C DELHI, 45C CAIRO").
      hs.sort((a, b) => (b.byte - a.byte) || (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const phrase = level === HEAT_EXTREME ? 'XHEAT' : 'DHEAT';
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = F2(phrase).slice();   // "EXTREME HEAT " (severity once, no value)
      const render = (h) => cat(tempZX(h.byte), F('C_SP'), toZX(precipName(h.tile)));   // "47C DELHI"
      const body = greedyPack(lead, hs, render, null, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // MEASURED humid-heat (WET-BULB) ALERT clause — owner's 2026-07-13 grammar. ONE clause spans
    // all three physiological wet-bulb tiers with the qualifier stated ONCE:
    //   "HEAT (WET BULB): SURVIVAL LIMIT JACOBABAD 35C; DANGER DELHI, LAHORE 33C, DUBAI 32C; CAUTION KARACHI 29C"
    // City-FIRST; cities sharing a wet-bulb temp are grouped ("DELHI, LAHORE 33C") so the reading
    // prints ONCE per temp; tiers worst-first (SURVIVAL LIMIT Tw>=35 / DANGER 31-34 / CAUTION
    // 28-30), within a tier hottest-temp first, within a temp cities rank+tile sorted. Tiers
    // joined by "; ", temp-groups within a tier by ", ". Greedy-packed under the 300 budget: whole
    // temp-GROUPS place atomically, the remainder collapses to "+K MORE" (K = unplaced groups).
    // A BULLETIN fact only — it NEVER flashes. Ranked at the lethal-tier lead (leads with SURVIVAL
    // LIMIT — worst-first). The wet-bulb qualifier scopes ONLY this clause (its "; " continuations
    // are internal), so a following non-heat alert is never mistaken for a temperature.
    const HUMID_TERM = { [HUMID_SURVIVAL]: 'HSURV', [HUMID_DANGER]: 'HDANG', [HUMID_CAUTION]: 'HCAUT' };
    const emitHumid = () => {
      const hs = stats.humidHeat ? stats.humidHeat.slice() : [];
      if (!hs.length) return;
      // tier worst-first, then hottest wet-bulb, then population rank, then tile
      hs.sort((a, b) => (b.level - a.level) || (b.byte - a.byte)
        || (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      // fold the flat sorted list into temp-GROUPS — consecutive same (level,byte) share one value
      const groups = [];
      for (const h of hs) {
        const g = groups[groups.length - 1];
        if (g && g.level === h.level && g.byte === h.byte) g.tiles.push(h.tile);
        else groups.push({ level: h.level, byte: h.byte, tiles: [h.tile] });
      }
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const avail = limit - out.length - leadW;
      const body = F2('HUMIDLEAD').slice();   // "HEAT (WET BULB): "
      if (body.length > avail) return;
      const trailerW = F2('MOREP').length + numZX(groups.length).length + F2('MORE').length;
      let placed = 0, prevLevel = -1;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        // contextual prefix: new tier -> ["; "]+TERM ; same tier, next temp-group -> ", "
        const newTier = g.level !== prevLevel;
        const pre = newTier ? cat(placed ? F2('SEMI') : [], F2(HUMID_TERM[g.level]))
                            : F2('COMMA_SP').slice();
        // "CITY[, CITY] NNC" — cities joined by ", ", the wet-bulb read once after the last
        const grp = [];
        for (let ci = 0; ci < g.tiles.length; ci++) {
          if (ci) for (const x of F2('COMMA_SP')) grp.push(x);
          for (const x of toZX(precipName(g.tiles[ci]))) grp.push(x);
        }
        for (const x of toZX(' ')) grp.push(x);
        for (const x of numZX(g.byte)) grp.push(x);
        for (const x of F2('HC')) grp.push(x);
        const res = (gi < groups.length - 1) ? trailerW : 0;
        if (body.length + pre.length + grp.length + res > avail) break;
        for (const x of pre) body.push(x);
        for (const x of grp) body.push(x);
        placed++; prevLevel = g.level;
      }
      if (placed === 0) return;
      const leftover = groups.length - placed;
      if (leftover > 0) {
        for (const x of F2('MOREP')) body.push(x);
        for (const x of numZX(leftover)) body.push(x);
        for (const x of F2('MORE')) body.push(x);
      }
      alertCommit(body);
    };

    // MEASURED-cold ALERT clauses — the exact mirror of emitHeat, grouped like precip:
    // condition + wind-chill temp stated ONCE, cities listed — "EXTREME COLD -44C MOSCOW" /
    // "DANGEROUS COLD -33C STOCKHOLM, REYKJAVIK". Grouped by (level, apparentByte) so every
    // city named genuinely reads the SAME measured feels-like the clause prints. Groups
    // COLDEST-byte first (ascending byte — the mirror of heat's hottest-first); cities within
    // a byte ordered by population rank then tile (orderPrecip discipline). Greedy fill
    // collapses the city tail to "+K MORE" under the 300 budget. Applies to BOTH desks. Like
    // heat, a BULLETIN fact only — it NEVER flashes (flashes stay WMO-CAP-authority-only;
    // constitution bars self-judged hazard flashes). Authority cold warnings keep flashing via
    // composeWmoFlash, unchanged.
    const emitCold = (level) => {
      const cs = stats.cold ? stats.cold.filter((h) => h.level === level) : [];
      if (!cs.length) return;
      // coldest-first (ascending byte, mirror of heat), then rank then tile — phrase ONCE, the
      // per-city wind chill moved into each entry ("EXTREME COLD -44C MOSCOW, -42C OSLO").
      cs.sort((a, b) => (a.byte - b.byte) || (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const phrase = level === COLD_EXTREME ? 'XCOLD' : 'DCOLD';
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = F2(phrase).slice();   // "EXTREME COLD "
      const render = (h) => cat(tempZX(h.byte), F('C_SP'), toZX(precipName(h.tile)));   // "-44C MOSCOW"
      const body = greedyPack(lead, cs, render, null, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // ICE-STORM ALERT clause (freezing rain over populated tiles), grouped like precip:
    // condition stated ONCE, cities listed — "ICE STORM IN MONTREAL, OTTAWA". One group
    // (there is a single condition), cities ordered by population rank then tile (orderPrecip
    // discipline); greedy fill collapses the city tail to "+K MORE" under the 300 budget.
    // Ranked with the DANGEROUS-HEAT tier (a serious public-danger warning, not on the
    // imminently-lethal EXTREME-HEAT/major-fire par). Both desks. BULLETIN fact only — it
    // NEVER flashes (freezing rain is a self-judged reading, not a WMO-CAP authority event;
    // constitution bars self-judged hazard flashes, same split as measured heat).
    const emitIce = () => {
      const ics = stats.iceStorms || [];
      if (!ics.length) return;
      const items = ics.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = cat(F2('ICE'), F2('IN'));   // "ICE STORM IN "
      const body = greedyPack(lead, items, (h) => toZX(precipName(h.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // DUST-STORM ALERT clause (WMO 30-35 duststorm/sandstorm over populated tiles), grouped
    // like ice storms: condition stated ONCE + cities listed — "DUST STORM IN RIYADH". One
    // group (a single condition), cities ordered by population rank then tile (orderPrecip
    // discipline); greedy fill collapses the city tail to "+K MORE" under the 300 budget.
    // Ranked with the DANGEROUS-HEAT / ICE-STORM tier (a serious public-danger warning, not
    // on the imminently-lethal EXTREME-HEAT / major-fire par). Both desks. BULLETIN fact only
    // — it NEVER flashes (a self-judged reading off the WMO code, not a WMO-CAP authority
    // event; constitution bars self-judged hazard flashes, same split as measured heat/ice).
    const emitDust = () => {
      const ds = stats.dustStorms || [];
      if (!ds.length) return;
      const items = ds.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = cat(F2('DUST'), F2('IN'));   // "DUST STORM IN "
      const body = greedyPack(lead, items, (h) => toZX(precipName(h.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // MEASURED-snowfall ALERT clauses — the exact mirror of emitHeat, grouped like precip:
    // condition + 24h accumulation stated ONCE, cities listed — "EXTREME SNOWFALL 55CM SAPPORO" /
    // "HEAVY SNOWFALL 30CM DENVER, MUNICH". Grouped by (level, cm) so every city named genuinely
    // reads the SAME measured accumulation the clause prints (a different cm is a different, honest
    // clause). Groups DEEPEST-cm first; cities within a group by population rank then tile
    // (orderPrecip discipline). Greedy fill collapses the city tail to "+K MORE" under the 300
    // budget. Applies to BOTH desks (a buried city is an emergency on any desk). BULLETIN fact
    // only — it NEVER flashes (a self-judged measured reading, not a WMO-CAP authority event;
    // constitution bars self-judged hazard flashes, same split as measured heat/cold/ice/dust).
    const emitSnow = (level) => {
      const ss = stats.snow ? stats.snow.filter((h) => h.level === level) : [];
      if (!ss.length) return;
      // deepest-cm first, then rank then tile — phrase ONCE, the per-city 24h accumulation moved
      // into each entry ("EXTREME SNOWFALL 55CM SAPPORO, 50CM AOMORI").
      ss.sort((a, b) => (b.cm - a.cm) || (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const phrase = level === SNOW_EXTREME ? 'XSNOW' : 'HSNOW';
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = F2(phrase).slice();   // "EXTREME SNOWFALL "
      const render = (h) => cat(numZX(h.cm), F2('CM'), toZX(precipName(h.tile)));   // "55CM SAPPORO"
      const body = greedyPack(lead, ss, render, null, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // MEASURED HOT-NIGHT ("tropical night") ALERT clauses — the exact structure of emitHeat, but
    // the reading is the overnight LOW stated as a bare "NNC ": "SWELTERING NIGHT 28C ATHENS" /
    // "HOT NIGHT 22C PARIS, MADRID". Grouped by overnight-min byte (HOTTEST night first — worst
    // recovery), cities rank+tile sorted, greedy-packed under the 300 budget. Ranked with the
    // heat family (sweltering rides the extreme tier, hot the dangerous tier). BULLETIN fact only
    // — it NEVER flashes (a self-judged measured reading, like heat/cold/snow).
    const emitHotNight = (level) => {
      const hs = stats.hotNight ? stats.hotNight.filter((h) => h.level === level) : [];
      if (!hs.length) return;
      // hottest-night first, then rank then tile — phrase ONCE, the per-city overnight low moved
      // into each entry ("SWELTERING NIGHT 31C TEHRAN, 26C TASHKENT" / "HOT NIGHT 28C TOKYO,
      // 27C MEXICO CITY, 25C CAIRO, 25C SANTO DOMINGO, 23C BEIJING"). Same discipline as precip.
      hs.sort((a, b) => (b.byte - a.byte) || (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const phrase = level === HOTNIGHT_SWELTER ? 'SWELTNIGHT'
        : (level === HOTNIGHT_HOT ? 'HOTNIGHT' : 'TROPNIGHT');
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = F2(phrase).slice();   // "SWELTERING NIGHT " / "HOT NIGHT " / "TROPICAL NIGHT "
      const render = (h) => cat(numZX(h.byte), F('C_SP'), toZX(precipName(h.tile)));   // "28C TOKYO"
      const body = greedyPack(lead, hs, render, null, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    };

    // (0--) TSUNAMI WARNINGS (authority, NOAA tsunami.gov) — the TOP-PRECEDENCE emergency, above
    // even the evacuation order: a coast-scale wall of water with the longest lead-warning value.
    emitTsunami();

    // (0-) EVACUATION ORDERS (authority, CAP responseType==Evacuate) — the VERY TOP of ALERT,
    // above even tornado: a live "leave now" directive is the most actionable emergency. Both desks.
    emitEvac();

    // (0) TORNADO WARNINGS (authority, WMO-CAP eventCode 9) — TOP of ALERT, ABOVE named
    // storms: minutes-scale lethality outranks everything. Both desks.
    emitTornado();

    // (0a) FLASH FLOOD WARNINGS (authority, WMO-CAP eventCode 3: US NWS et al.) — just below tornado,
    // ABOVE heat/storms: minutes-scale wall-of-water lethality. Both desks.
    emitFlashFlood();

    // (0b) EXTREME HEAT WARNINGS (authority, WMO-CAP eventCode 4) — just below tornado, ABOVE
    // named storms: a national red heat warning is a multi-day mass-casualty event. Both desks.
    emitHeatWarn();

    // (1) named storms — deepest pressure first (global desk only) ----
    if (!isCont && stats.cycCount > 0) {
      const named = stats.cyc.filter(isNamed).slice()
        .sort((a, b) => (a.press - b.press) || (a.tile - b.tile));
      if (named.length) {
        const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
        const renderStorm = (c) => cat(labelZX(cycKindOf(c.tile, c.tier)), toZX(' '),
          c.name.slice(), toZX(' '), pressZX(c.press), F('MB'), toZX(' '), toZX(R.regionName(c.tile)));
        const body = greedyPack([], named, renderStorm, null, F2('SEMI'), F2('MORESTORMS'),
          limit - out.length - leadW);
        if (body) alertCommit(body);
      }
    }

    // (1b) HUMID HEAT (measured wet-bulb) — ONE clause spanning SURVIVAL LIMIT / DANGER / CAUTION,
    // ranked at the lethal-tier lead because it leads with the SURVIVAL LIMIT reading (Tw>=35, the
    // human-survivability limit — worst-first). Supersedes dry heat, the more lethal mechanism.
    // Both desks. (Was two clauses — deadly here, dangerous after fires; owner's 2026-07-13 grammar
    // merges all tiers into this single city-first clause, so it emits ONCE.)
    emitHumid();
    // (1b) EXTREME HEAT (measured feels-like >=45C) — ranked BETWEEN named storms and
    // fires: at ~45C+ apparent, heat stroke is imminent, an emergency on par with a
    // major fire, so it leads the fire/flood/sea alerts (precedence choice, documented
    // in NOTES). Both desks.
    emitHeat(HEAT_EXTREME);
    // EXTREME COLD (measured wind chill <=-40C) — ranked WITH extreme heat (imminently lethal:
    // frostbite in minutes), so it also leads the fire/flood/sea alerts. Heat first, then cold,
    // within this tier (stable, documented ordering). Both desks.
    emitCold(COLD_EXTREME);
    // EXTREME SNOWFALL (measured >=50cm/24h) — ranked WITH extreme heat/cold (a life-threatening,
    // roof-loading, people-trapping dump), so it also leads the fire/flood/sea alerts. Heat, then
    // cold, then snow, within this tier (stable, documented ordering). Both desks.
    emitSnow(SNOW_EXTREME);
    // SWELTERING NIGHT (measured overnight low >=30C) — a night that never cools is lethal for the
    // vulnerable (no overnight recovery); ranked at the BOTTOM of the imminently-lethal tier
    // (slower-acting than a daytime spike, but the dominant heatwave killer over successive
    // nights). Both desks.
    emitHotNight(HOTNIGHT_SWELTER);

    // (2) red / major fires — "N MAJOR FIRE[S] NAME[ COUNTRY], NAME ... +K MORE" ----
    if (stats.redFires.length > 0) {
      const reds = stats.redFires;
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = cat(numZX(reds.length), reds.length === 1 ? F2('MAJ_FIRE') : F2('MAJ_FIRES'));
      const full = (f) => f.country.length > 0 ? cat(f.name, toZX(' '), f.country) : f.name;
      const short = (f) => f.name;
      const body = greedyPack(lead, reds, full, short, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    }

    // (2b) DANGEROUS HEAT (measured feels-like 40–45C) — ranked AFTER fires: a serious
    // public-health warning, but not immediately lethal like EXTREME, so it trails the
    // major-fire tier (precedence choice, documented in NOTES). Both desks.
    emitHeat(HEAT_DANGEROUS);
    // DANGEROUS COLD (measured wind chill -30..-40C) — ranked WITH dangerous heat / ice storms
    // (a serious public-danger warning, not immediately lethal), so it trails the major-fire
    // tier. Heat first, then cold, within this tier. Both desks.
    emitCold(COLD_DANGEROUS);
    // HOT NIGHT (measured overnight low >=25C) — a serious public-health warning, so it trails the
    // major-fire tier with the other dangerous-band measured clauses. Both desks.
    emitHotNight(HOTNIGHT_HOT);
    // TROPICAL NIGHT (measured overnight low >=20C — the WMO tropical-night line) — the lowest
    // overnight-heat tier, emitted just after HOT NIGHT in the dangerous band. Both desks.
    emitHotNight(HOTNIGHT_TROPICAL);

    // (2c) ICE STORMS (measured freezing rain over populated tiles) — ranked with the
    // DANGEROUS-HEAT tier: a serious public-danger warning, so it sits alongside dangerous
    // heat, after the major-fire tier. Both desks.
    emitIce();

    // (2d) DUST STORMS (WMO 30-35 duststorm/sandstorm over populated tiles) — ranked with the
    // DANGEROUS-HEAT / ICE-STORM tier: a serious public-danger warning, after the major-fire
    // tier. Both desks.
    emitDust();

    // (2d') HAZARDOUS SMOKE (measured PM2.5>=150 over populated tiles) — ranked with the
    // DANGEROUS-HEAT / DUST tier, right after dust (the two airborne-particulate hazards): a
    // serious respiratory public-danger warning. INDEPENDENT of the fire layer (smoke travels
    // far downwind). Both desks.
    emitSmoke();

    // (2e) HEAVY SNOWFALL (measured 25-50cm/24h over populated tiles) — ranked with the
    // DANGEROUS-HEAT / ICE / DUST tier: a serious, transport-paralysing public-danger warning,
    // not on the imminently-lethal EXTREME par, so it trails the major-fire tier. Both desks.
    emitSnow(SNOW_HEAVY);

    // (3) phenomenal seas (global desk only) ----
    if (!isCont && stats.seaHazWave >= PHENOMENAL_M) {
      alertCommit(cat(F2('PHEN_SEAS'), toZX(R.regionName(stats.seaHazTile))));
    }

    // (3b) RIVER FLOODING (GloFAS forecast, Copernicus GloFAS via Open-Meteo) — ranked just ABOVE
    // the coarse GDACS flood marks: a forecast large-river flood at a monitored city is a sharper,
    // more actionable signal than the GDACS event mark. Region-named, both desks.
    emitRiver();

    // (4) floods — "N FLOOD[S] PLACE[ COUNTRY], PLACE ... +K MORE" ----
    if (stats.floods.length > 0) {
      const fl = stats.floods;
      const leadW = (alertStarted ? F2('SEMI') : F2('ALERT')).length;
      const lead = cat(numZX(fl.length), fl.length === 1 ? F2('FLOOD') : F2('FLOODS'));
      const placeOf = (f) => f.place.length > 0 ? f.place : nameZX(R.regionName(f.tile), 24);
      const full = (f) => f.country.length > 0 ? cat(placeOf(f), toZX(' '), f.country) : placeOf(f);
      const short = (f) => placeOf(f);
      const body = greedyPack(lead, fl, full, short, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) alertCommit(body);
    }

    // (5) DROUGHT EMERGENCIES (authority, GDACS eventtype DR) — BOTTOM of ALERT, below every
    // acute clause: famine-scale but slow-onset, so it is present-but-last. Both desks.
    emitDrought();

    // close the ALERT sentence
    if (alertStarted) commit(F('DOT'));

    // ---- CONDITIONS (Shipping-Forecast order); every clause is atomic ----
    // (a) MAX / MIN temps + region (core; committed first so it wins the budget)
    // HIGH==LOW GUARD (owner QC 2026-07-14, live OCEANIA bug): when the peak and trough
    // resolve to the SAME temperature at the SAME place — a continent whose extreme scan
    // has only ONE eligible land reading (Oceania after the 69/79 ocean-basin skip leaves
    // just 68 NW AUSTRAL) — "HIGH 11C NW AUSTRAL, LOW 11C NW AUSTRAL" is absurd. Collapse to
    // a single "TEMP tC PLACE." Same-temp-DIFFERENT-place and different-temp-same-place are
    // both left as HIGH/LOW (physically sensible). "Same place" = same region index (so two
    // distinct tiles sharing a region label also collapse). Applies to EVERY desk (all
    // continents + global); the global world desk never degenerates, so it is output-neutral
    // there. The Z80 mirror (c2 CONDITIONS a) applies the byte-identical guard.
    // EXTSEEN GATE (owner 2026-08-04 audit): a desk whose member set contains NO
    // populated tile never seeds the extremes — hotByte/coldByte still hold the
    // init 0/255, which would emit "MAX -50C ARCTIC, MIN 205C ARCTIC". No city
    // readings = no temp clause. Z80 mirror: c2 CONDITIONS (a) EXTSEED gate.
    const singleReading = (stats.hotByte & 0xff) === (stats.coldByte & 0xff)
      && R.REGION_OF[stats.hotTile & 0xff] === R.REGION_OF[stats.coldTile & 0xff];
    if (!stats.extSeen) {
      /* no populated tiles seen — skip the whole extremes clause */
    } else if (singleReading) {
      commit(cat(toZX(' '), F2('TEMP'), tempZX(stats.hotByte), F('C_SP'),
        (stats.hotByte & 0xff) === 0 ? F('ORLESS') : [], toZX(siteName(stats.hotTile)), F('DOT')));
    } else {
      commit(cat(toZX(' '), F2('MAX'), tempZX(stats.hotByte), F('C_SP'), toZX(siteName(stats.hotTile)),
        F2('MIN'), tempZX(stats.coldByte), F('C_SP'),
        (stats.coldByte & 0xff) === 0 ? F('ORLESS') : [], toZX(siteName(stats.coldTile)), F('DOT')));
    }

    // (b) gale — peak gust KMH + precise place (city-else-region: a land gale names the
    // city, an open-sea gale falls to the basin). Both desks.
    if (stats.galeGust > 0) {
      commit(cat(F2('GALE'), numZX(stats.galeGust), F2('KMH'), toZX(siteName(stats.galeTile)), F('DOT')));
    }

    // (c) precip — GROUPED BY CONDITION, condition stated ONCE (owner's grammar):
    // "DRIZZLE IN LONDON, HAMBURG, PARIS. HEAVY RAIN IN MADRID, MOSCOW, ROME." — never
    // "DRIZZLE LONDON, DRIZZLE HAMBURG". Groups ordered severity-first (THUNDER >
    // FREEZING RAIN > SNOW > SNOW SHOWERS > HEAVY RAIN > HEAVY SHOWERS > RAIN > SHOWERS >
    // DRIZZLE); cities within a group worst-first then population (orderPrecip order).
    // Each group is one atomic sentence; greedy fill still governs how many groups/cities
    // fit before the per-group city tail collapses to "+K MORE". Applies to BOTH desks.
    // precipCond(type,band) -> { sev, label(ZX) }: band-3 rain/showers reads "HEAVY RAIN"
    // / "HEAVY SHOWERS"; every other type keeps its bare word. Labels come from FRAG2/FRAG
    // so the Z80 mirror injects the same DB bytes.
    {
      const precipCond = (type, band) => {
        switch (type) {
          case 7: return { sev: 0, label: F('PT7') };                                   // THUNDER
          case 4: return { sev: 1, label: F('PT4') };                                   // FREEZING RAIN
          case 5: return { sev: 2, label: F('PT5') };                                   // SNOW
          case 6: return { sev: 3, label: F('PT6') };                                   // SNOW SHOWERS
          case 2: return band >= 3 ? { sev: 4, label: cat(F2('HEAVY_SP'), F('PT2')) } : { sev: 6, label: F('PT2') };
          case 3: return band >= 3 ? { sev: 5, label: cat(F2('HEAVY_SP'), F('PT3')) } : { sev: 7, label: F('PT3') };
          case 1: return { sev: 8, label: F('PT1') };                                   // DRIZZLE
          default: return { sev: 9, label: F('PT' + type) };
        }
      };
      // City freezing rain (WMO 66/67 on a populated tile) is ELEVATED to the ICE STORM
      // ALERT clause above, so it is EXCLUDED here to avoid double-reporting. Non-city
      // freezing rain has no ALERT clause and stays a plain "FREEZING RAIN IN <region>"
      // precip group — the same populated/unpopulated split the ice-storm scan uses.
      const list = orderPrecip(stats.precip)   // worst-first: band DESC, pop rank ASC, tile ASC
        .filter((p) => !(p.type === ICE_TYPE && GZ.hasCity(p.tile)));
      if (list.length > 0) {
        // bucket into condition groups (preserving worst-first city order), then emit
        // groups severity-first. A Map keyed by sev keeps the grouping deterministic.
        const groups = new Map();
        for (const p of list) {
          const c = precipCond(p.type, p.band);
          let g = groups.get(c.sev);
          if (!g) { g = { sev: c.sev, label: c.label, items: [] }; groups.set(c.sev, g); }
          g.items.push(p);
        }
        const ordered = Array.from(groups.values()).sort((a, b) => a.sev - b.sev);
        const cityFull = (p) => toZX(precipName(p.tile));
        for (const g of ordered) {
          const lead = cat(toZX(' '), g.label, F2('IN'));
          const body = greedyPack(lead, g.items, cityFull, null, F2('COMMA_SP'), F2('MORE'), limit - out.length);
          if (body) commit(cat(body, F('DOT')));
          else break;   // worst-first budget exhausted; drop lesser groups
        }
      }
    }

    // (c2) DUST STORM over NON-city tiles — a CONDITIONS mention (interesting, not a city
    // emergency), grouped "DUST STORM IN <region>, <region>." City dust is elevated to the
    // ALERT clause above and is EXCLUDED here (no double-report), mirroring the ice-storm
    // populated/unpopulated split. Atomic + greedy: dropped silently if the busy-day budget
    // is spent ("when room"). Regions ordered by tile address.
    if (stats.dustAreas && stats.dustAreas.length) {
      const items = stats.dustAreas.slice().sort((a, b) => a.tile - b.tile);
      const lead = cat(toZX(' '), F2('DUST'), F2('IN'));
      const body = greedyPack(lead, items, (h) => toZX(R.regionName(h.tile)), null,
        F2('COMMA_SP'), F2('MORE'), limit - out.length);
      if (body) commit(cat(body, F('DOT')));
    }

    // (c3) UNUSUAL FOR HERE — departure from LOCAL climate normal (CONDITIONS; notable, not an
    // emergency). "UNUSUAL: N USA 11C ABOVE NORMAL, PATAGONIA 9C BELOW NORMAL." Worst-departure-
    // first (largest |deltaC|), greedy-packed under the 300 budget, hot AND cold surfaced (a July
    // cold snap is as anomalous as a heat spike). Populated/land-focused (the ingest filters to
    // hasCity). Omitted entirely when nothing is notably off-normal (honest quiet). Both desks.
    if (stats.anomalies && stats.anomalies.length) {
      const items = stats.anomalies.slice().sort((a, b) => (Math.abs(b.deltaC) - Math.abs(a.deltaC)) || (a.tile - b.tile));
      const lead = cat(toZX(' '), F2('UNUSUAL'));
      const renderFull = (h) => cat(toZX(R.regionName(h.tile)), toZX(' '), numZX(Math.abs(h.deltaC)),
        h.deltaC >= 0 ? F2('ANOM_ABOVE') : F2('ANOM_BELOW'));
      const body = greedyPack(lead, items, renderFull, null, F2('COMMA_SP'), F2('MORE'), limit - out.length);
      if (body) commit(cat(body, F('DOT')));
    }

    // (d) sea line (global desk only) — honest, never fabricates calm
    if (!isCont) {
      if (stats.roughSea > 0) commit(cat(F('ROUGH'), toZX(R.regionName(stats.roughTile)), F('DOT')));
      else if (stats.seaNoData) commit(cat(F('SEA_NA'), F('DOT')));
      else commit(cat(F('CALM'), F('DOT')));
    }

    // (e) residual orange fires — "N MORE FIRE[S][ PLACE, PLACE...]."
    if (stats.orangeFires.length > 0) {
      const ors = stats.orangeFires;
      const lead = cat(toZX(' '), numZX(ors.length), ors.length === 1 ? F2('MORE_FIRE0') : F2('MORE_FIRES0'));
      const placeOf = (f) => f.country.length > 0 ? f.country
        : (f.name.length > 0 ? f.name : nameZX(R.regionName(f.tile), 24));
      // located places are optional detail; a bare "N MORE FIRES." always commits.
      const body = greedyPack(lead, ors, (f) => cat(toZX(' '), placeOf(f)),
        (f) => cat(toZX(' '), placeOf(f)), F2('COMMA_SP'), F2('MORE'), limit - out.length);
      if (body) commit(cat(body, F('DOT')));
      else commit(cat(lead, F('DOT')));
    }

    // ---- NOTABLE section — important but NON-emergency weather, kept clearly SEPARATE from
    // the red emergency ALERT (which stays storms/fires/floods/hazardous-air/etc.). Placed AFTER
    // the CONDITIONS body and BEFORE the sign-off; its own section led by " NOTABLE: " on the
    // FIRST committed clause and "; " between clauses, closed by "." — the SAME grammar ALERT
    // uses, so a busy-day budget drops whole notable clauses cleanly. Wording plain and calm
    // (never alarming). Ranked MOST-NOTABLE first. New notable types slot in by adding an emit
    // under this lead (the section is a framework, not a fixed pair). Both desks. ----
    let notableStarted = false;
    const notableCommit = (body) => {
      while (body.length && body[0] === 0) body.shift();   // trim leading space (frag leads)
      if (body.length === 0) return false;
      const lead = notableStarted ? F2('SEMI') : F2('NOTABLE');
      if (commit(cat(lead, body))) { notableStarted = true; return true; }
      return false;
    };

    // (1) SMOKY, UNHEALTHY AIR — MEASURED mid-band smoke (PM2.5 55-149 ug/m3, US-AQI unhealthy),
    // BELOW the >=150 hazardous ALERT floor: a real air-quality advisory, not an emergency.
    // "SMOKY, UNHEALTHY AIR OVER SEATTLE, VANCOUVER" — condition stated ONCE, cities by population
    // rank then tile, greedy "+K MORE" under budget. Same air-quality feed as the hazardous SMOKE
    // ALERT clause; only the PM2.5 band differs. Ranked FIRST in NOTABLE (health-relevant). Both desks.
    if (stats.smokeMid && stats.smokeMid.length) {
      const sm = stats.smokeMid.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (notableStarted ? F2('SEMI') : F2('NOTABLE')).length;
      const lead = F2('SMOKY').slice();   // "SMOKY, UNHEALTHY AIR OVER " (trailing space, cities follow, no " IN ")
      const body = greedyPack(lead, sm, (h) => toZX(precipName(h.tile)), null, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) notableCommit(body);
    }

    // (2) MODERATE DUST / HAZE — WMO widespread/blowing dust & haze (06-09) over a populated tile:
    // a visibility/air advisory BELOW the DUST STORM ALERT (30-35), not an emergency. "DUSTY, HAZY
    // AIR IN <city>, ..." — condition ONCE, cities by population rank then tile, greedy "+K MORE"
    // under budget. Frame-derived (byte1 bit7), so BOTH desks light it. Ranked after the smoke
    // advisory (both air quality), before fog (travel). Both desks.
    if (stats.dustHaze && stats.dustHaze.length) {
      const dh = stats.dustHaze.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (notableStarted ? F2('SEMI') : F2('NOTABLE')).length;
      const lead = cat(F2('DUSTHAZE'), F2('IN'));   // "DUSTY, HAZY AIR IN " (cities follow)
      const body = greedyPack(lead, dh, (h) => toZX(precipName(h.tile)), null, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) notableCommit(body);
    }

    // (3) DENSE FOG — WMO fog / rime fog (45/48) over a populated tile: a travel/visibility advisory,
    // not an emergency. "DENSE FOG IN <city>, ..." — condition ONCE, cities by population rank then
    // tile, greedy "+K MORE" under budget. Frame-derived (byte1 bit6), so BOTH desks (global and,
    // via the scoped tile scan, continental) light it. Ranked AFTER the dust/haze advisory. Both desks.
    if (stats.fog && stats.fog.length) {
      const fg = stats.fog.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile));
      const leadW = (notableStarted ? F2('SEMI') : F2('NOTABLE')).length;
      const lead = cat(F2('DENSEFOG'), F2('IN'));   // "DENSE FOG IN " (cities follow)
      const body = greedyPack(lead, fg, (h) => toZX(precipName(h.tile)), null, F2('COMMA_SP'), F2('MORE'), limit - out.length - leadW);
      if (body) notableCommit(body);
    }

    // (3c) MONSOON RAINS — the seasonal system named as itself (owner 2026-08-03),
    // ranked before aurora (weather before space weather). Season from the bulletin's
    // OWN time string (JUN-SEP, the SW monsoon — the Z80 mirror c2_monsoon reads the
    // same chars it prints; the machine has no calendar); wet from aggregate2's
    // monsoonWet census (>=3 of the 6 S Asia box tiles). GLOBAL + ASIA desks only.
    if ((stats.monsoonWet | 0) >= 3 && /JUN|JUL|AUG|SEP/.test(fromZX(Uint8Array.from(timeZ)))
        && (!isCont || opts.contId === 4))
      notableCommit(F2('MONSOON'));

    // (4) AURORA WATCH — SPACE WEATHER (both desks), relocated here from CONDITIONS (2026-07-15):
    // aurora is notable/delightful, not an emergency. Kp>=5 (NOAA G1+) lights the auroral oval down
    // to a mid-latitude visibility line (SW.visLatForKp, standard NOAA/GI table). Ranked AFTER the
    // smoke advisory (interest vs health). Like measured heat it NEVER flashes (a global scalar,
    // structurally invisible to the per-tile flash scanner). Global desk states the NORTHERN line
    // (where population lives); a continental desk prints the clause ONLY if that continent has a
    // member tile poleward of the line, N or S per the reaching hemisphere (aurora australis for
    // southern continents). Trailing "." comes from the section close, not the clause.
    if (stats.kp != null) {
      const aw = SW.auroraWatch(stats.kp);
      if (aw) {
        let dir = 'N', emit = true;
        if (isCont) {
          emit = false;
          const mem = R.CONTINENT_TILES[opts.contId] || [];
          let reachN = false, reachS = false;
          for (const tl of mem) { const la = tileLat(tl); if (la >= aw.visLat) reachN = true; if (la <= -aw.visLat) reachS = true; }
          if (reachN) { dir = 'N'; emit = true; } else if (reachS) { dir = 'S'; emit = true; }
        }
        if (emit) notableCommit(cat(F2('AURORA'), numZX(aw.kp), F2('VISTO'), numZX(aw.visLat),
          dir === 'S' ? F2('DEG_S') : F2('DEG_N')));
      }
    }

    // close the NOTABLE sentence iff any notable clause committed
    if (notableStarted) commit(F('DOT'));

    // ---- SIGN-OFF tail (reserved) ----
    for (const b of tail) out.push(b);
    const z = Uint8Array.from(out.slice(0, CAP));
    return { z, text: fromZX(z), len: z.length };
  }

  // v2 kind label (NO leading space; the ALERT list supplies its own separators). Reuses
  // the honest latitude-aware nomenclature (gap a): named tropical -> "HURRICANE
  // SIGNATURE"/"MAJOR HURRICANE SIGNATURE"; extratropical -> "STORM-FORCE LOW" /
  // "HURRICANE-FORCE LOW". Bytes come from FRAG2 so the Z80 mirror injects the same DB.
  function labelZX(kind) {
    if (kind === CYC_KIND.MTCYC) return F2('MAJ').concat(F2('HURRSIG'));
    if (kind === CYC_KIND.TCYC) return F2('HURRSIG');
    if (kind === CYC_KIND.HFLOW) return F2('HFLOW_L');
    return F2('SFLOW_L');
  }

  // Continental v2 desk — thin wrapper so callers read symmetrically with v1.
  function composeContinental2(stats, contId, timeZ) {
    return compose2(stats, timeZ, { contId });
  }

  // v2 ALT text — same aggregate2 stats, ALERT/CONDITIONS shape, readable ASCII prose.
  function composeAlt2(stats) {
    const rn = (t) => R.regionName(t);
    const degC = (b) => (b & 0xff) - 50;
    const p = ['A 10x10 wall of 100 ZX81 screens rendering a live world weather map in 1-bit block graphics.'];
    const alerts = [];
    // AUTHORITY tsunami warnings — the TOP-PRECEDENCE emergency (coast-scale wall of water),
    // screen-reader prose. Prefer NOAA's own readable affected-region label; fall back to the tile
    // region/basin when absent.
    if (stats.tsunamis && stats.tsunamis.length) {
      const places = stats.tsunamis.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => (h.area && h.area.length ? h.area.toLowerCase() : rn(h.tile)));
      alerts.push('tsunami warning ' + places.join(', '));
    }
    // AUTHORITY evacuation orders — the VERY TOP of ALERT (most actionable emergency), screen-reader
    // prose naming the states the orders cover.
    if (stats.evac && stats.evac.length) {
      const places = stats.evac.slice().sort((a, b) => a.place - b.place).map((h) => AP.placeName(h.place));
      alerts.push('evacuation order' + (stats.evac.length === 1 ? '' : 's') + ' ' + places.join(', '));
    }
    // AUTHORITY tornado warnings — TOP of ALERT (minutes-scale lethality), screen-reader prose
    if (stats.tornadoes && stats.tornadoes.length) {
      const cities = stats.tornadoes.slice().sort((a, b) => a.place - b.place).map((h) => AP.placeName(h.place));
      alerts.push('tornado warning ' + cities.join(', '));
    }
    // AUTHORITY flash-flood warnings — just below tornado (minutes-scale wall of water), screen-reader prose
    if (stats.flashfloods && stats.flashfloods.length) {
      const cities = stats.flashfloods.slice().sort((a, b) => a.place - b.place).map((h) => AP.placeName(h.place));
      alerts.push('flash flood warning ' + cities.join(', '));
    }
    // Seasonal monsoon named in the screen-reader prose too (season decided by the
    // caller — refresh-report sets stats.monsoon from its own clock + census).
    if (stats.monsoon) alerts.push('monsoon rains over south asia');
    // AUTHORITY extreme-heat warnings — just below tornado, above named storms, screen-reader prose
    if (stats.heatWarnings && stats.heatWarnings.length) {
      const cities = stats.heatWarnings.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => rn(h.tile));
      alerts.push('extreme heat warning ' + cities.join(', '));
    }
    // GloFAS river-flood forecasts — ranked above the GDACS flood marks, screen-reader prose. Prefer
    // the flooding gazetteer city label; fall back to the tile region/basin when absent.
    if (stats.rivers && stats.rivers.length) {
      const places = stats.rivers.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => (h.area && h.area.length ? h.area.toLowerCase() : rn(h.tile)));
      alerts.push('river flooding ' + places.join(', '));
    }
    if (stats.cyc && stats.cycCount > 0) {
      const named = stats.cyc.filter((c) => c.name && c.name.length > 0 && c.press != null)
        .slice().sort((a, b) => a.press - b.press);
      if (named.length) alerts.push(named.map((c) => fromZX(c.name) + ' ' + c.press + 'MB ' + rn(c.tile)).join(', '));
      else alerts.push(stats.cycCount + ' cyclone' + (stats.cycCount === 1 ? '' : 's'));
    }
    // measured heat (feels-like) — EXTREME ranks with storms, DANGEROUS trails; degC = byte-50
    const heatPhrase = (level, word) => {
      const hs = (stats.heat || []).filter((h) => h.level === level);
      if (!hs.length) return;
      const cities = hs.slice().sort((a, b) => (b.byte - a.byte) || (a.tile - b.tile))
        .map((h) => rn(h.tile) + ' ' + degC(h.byte) + 'C');
      alerts.push(word + ' ' + cities.join(', '));
    };
    // measured humid heat (wet-bulb) — ONE clause, three tiers, qualifier once, city-first, temps
    // grouped: "heat (wet bulb): survival limit jacobabad 35C; danger delhi, lahore 33C; ..."
    const humidClause = () => {
      const hs = (stats.humidHeat || []).slice();
      if (!hs.length) return;
      hs.sort((a, b) => (b.level - a.level) || (b.byte - a.byte) || (a.tile - b.tile));
      const term = { 3: 'survival limit', 2: 'danger', 1: 'caution' };
      const groups = [];
      for (const h of hs) {
        const g = groups[groups.length - 1];
        if (g && g.level === h.level && g.byte === h.byte) g.tiles.push(h.tile);
        else groups.push({ level: h.level, byte: h.byte, tiles: [h.tile] });
      }
      let s = 'heat (wet bulb):';
      let prev = -1, first = true;
      for (const g of groups) {
        if (g.level !== prev) { s += (first ? ' ' : '; ') + term[g.level] + ' '; prev = g.level; }
        else s += ', ';
        s += g.tiles.map(rn).join(', ') + ' ' + g.byte + 'C';
        first = false;
      }
      alerts.push(s);
    };
    // measured cold (wind chill) — mirror of heat; coldest byte first; degC = byte-50
    const coldPhrase = (level, word) => {
      const cs = (stats.cold || []).filter((h) => h.level === level);
      if (!cs.length) return;
      const cities = cs.slice().sort((a, b) => (a.byte - b.byte) || (a.tile - b.tile))
        .map((h) => rn(h.tile) + ' ' + degC(h.byte) + 'C');
      alerts.push(word + ' ' + cities.join(', '));
    };
    // measured snowfall (24h accumulation) — mirror of heat; deepest cm first; cm printed as-is
    const snowPhrase = (level, word) => {
      const ss = (stats.snow || []).filter((h) => h.level === level);
      if (!ss.length) return;
      const cities = ss.slice().sort((a, b) => (b.cm - a.cm) || (a.tile - b.tile))
        .map((h) => rn(h.tile) + ' ' + h.cm + 'cm');
      alerts.push(word + ' ' + cities.join(', '));
    };
    // measured hot night (overnight low) — mirror of heat; hottest night first; byte is RAW degC
    const nightPhrase = (level, word) => {
      const hs = (stats.hotNight || []).filter((h) => h.level === level);
      if (!hs.length) return;
      const cities = hs.slice().sort((a, b) => (b.byte - a.byte) || (a.tile - b.tile))
        .map((h) => rn(h.tile) + ' ' + h.byte + 'C');
      alerts.push(word + ' ' + cities.join(', '));
    };
    humidClause();
    heatPhrase(2, 'extreme heat');
    coldPhrase(2, 'extreme cold');
    snowPhrase(2, 'extreme snowfall');
    nightPhrase(2, 'sweltering night');
    if (stats.redFires && stats.redFires.length) {
      alerts.push(stats.redFires.length + ' major fire' + (stats.redFires.length === 1 ? '' : 's')
        + ': ' + stats.redFires.map((f) => fromZX(f.name)).filter(Boolean).join(', '));
    }
    if (stats.seaHazWave >= PHENOMENAL_M) alerts.push('phenomenal seas ' + rn(stats.seaHazTile));
    if (stats.floods && stats.floods.length) {
      alerts.push(stats.floods.length + ' flood' + (stats.floods.length === 1 ? '' : 's'));
    }
    heatPhrase(1, 'dangerous heat');
    coldPhrase(1, 'dangerous cold');
    nightPhrase(1, 'hot night');
    if (stats.iceStorms && stats.iceStorms.length) {
      const cities = stats.iceStorms.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => rn(h.tile));
      alerts.push('ice storm ' + cities.join(', '));
    }
    if (stats.dustStorms && stats.dustStorms.length) {
      const cities = stats.dustStorms.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => rn(h.tile));
      alerts.push('dust storm ' + cities.join(', '));
    }
    // MEASURED hazardous smoke (PM2.5>=150) — dangerous-air tier, alongside dust; screen-reader prose
    if (stats.smoke && stats.smoke.length) {
      const cities = stats.smoke.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => rn(h.tile));
      alerts.push('hazardous smoke ' + cities.join(', '));
    }
    snowPhrase(1, 'heavy snowfall');
    // AUTHORITY drought emergencies (GDACS) — BOTTOM of ALERT (slow-onset), screen-reader prose
    if (stats.droughts && stats.droughts.length) {
      const places = stats.droughts.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((d) => rn(d.tile));
      alerts.push('drought emergency ' + places.join(', ') + ' (GDACS)');
    }
    p.push(alerts.length ? 'Alerts: ' + alerts.join('; ') + '.' : 'No red-alert events active.');
    if (stats.extSeen) p.push('Hottest ' + degC(stats.hotByte) + 'C at ' + siteName(stats.hotTile) +
      ', coldest ' + degC(stats.coldByte) + 'C' +
      ((stats.coldByte & 0xff) === 0 ? ' or less' : '') + ' at ' + siteName(stats.coldTile) + '.');
    else p.push('No populated-tile temperature readings this cycle.');
    if (stats.galeGust > 0) p.push('Peak gust ' + stats.galeGust + ' km/h at ' + siteName(stats.galeTile) + '.');
    if (stats.rainCnt || stats.snowCnt) {
      const parts = [];
      if (stats.rainCnt) parts.push('rain areas');
      if (stats.snowCnt) parts.push('snow or wintry areas');
      p.push('Precipitation: ' + parts.join(' and ') + '.');
    }
    p.push(stats.roughSea > 0 ? 'Roughest seas at ' + rn(stats.roughTile) + '.'
      : stats.seaNoData ? 'Sea state not available.' : 'Seas calm.');
    // UNUSUAL FOR HERE — departure from local climate normal (CONDITIONS), worst-first prose
    if (stats.anomalies && stats.anomalies.length) {
      const items = stats.anomalies.slice().sort((a, b) => (Math.abs(b.deltaC) - Math.abs(a.deltaC)) || (a.tile - b.tile));
      p.push('Unusual for here: ' + items.map((h) =>
        rn(h.tile) + ' ' + Math.abs(h.deltaC) + 'C ' + (h.deltaC >= 0 ? 'above' : 'below') + ' normal').join(', ') + '.');
    }
    // NOTABLE (non-emergency) — mid-band smoke advisory then aurora watch, screen-reader prose
    if (stats.smokeMid && stats.smokeMid.length) {
      const cities = stats.smokeMid.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => rn(h.tile));
      p.push('Notable: smoky, unhealthy air over ' + cities.join(', ') + '.');
    }
    if (stats.dustHaze && stats.dustHaze.length) {
      const cities = stats.dustHaze.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => rn(h.tile));
      p.push('Notable: dusty, hazy air in ' + cities.join(', ') + '.');
    }
    if (stats.fog && stats.fog.length) {
      const cities = stats.fog.slice().sort((a, b) => (precipRank(a.tile) - precipRank(b.tile)) || (a.tile - b.tile))
        .map((h) => rn(h.tile));
      p.push('Notable: dense fog in ' + cities.join(', ') + '.');
    }
    if (stats.kp != null) { const aw = SW.auroraWatch(stats.kp); if (aw) p.push('Aurora watch: Kp' + aw.kp + ', visible to ' + aw.visLat + 'N.'); }
    if (stats.dustAreas && stats.dustAreas.length) {
      p.push('Duststorm over ' + stats.dustAreas.map((d) => rn(d.tile)).join(', ') + '.');
    }
    if (stats.orangeFires && stats.orangeFires.length) {
      p.push(stats.orangeFires.length + ' further wildfire' + (stats.orangeFires.length === 1 ? '' : 's') + ' burning.');
    }
    return p.join(' ');
  }

  // Switch-aware dispatchers: the LIVE path calls these; v1 is the default until the
  // bridge instance flips ZWX_BULLETIN_V2 on owner's LIVE-sample approval (Phase 3).
  function aggregateAuto(tiles) { return BULLETIN_V2 ? aggregate2(tiles) : aggregate(tiles); }
  function composeAuto(stats, timeZ) { return BULLETIN_V2 ? compose2(stats, timeZ) : compose(stats, timeZ); }
  function composeContinentalAuto(stats, contId, timeZ) {
    return BULLETIN_V2 ? composeContinental2(stats, contId, timeZ) : composeContinental(stats, contId, timeZ);
  }
  function composeAltAuto(stats) { return BULLETIN_V2 ? composeAlt2(stats) : composeAlt(stats); }

  const API = {
    zxCode, toZX, fromZX, numZX, tempZX, pressZX,
    aggregate, compose, composeAlt, groupCyclones, groupCyclonesByKind, cycKindOf, frameize,
    aggregateHazards, composeFlash, tileLat, tileLon, heatZoneTemperate,
    composeContinental, composeWmoFlash, WMO_EVENT: (WM && WM.WMO_EVENT),
    FRAG, HAZ_PHRASE, HAZ_UNIT, HAZ_COLD, SEA_TILE,
    REPORTER_ADDR, CMD_RESET, CMD_COMPOSE, CMD_FLASH, FRAME_MAX, CAP,
    MAX_CYC_STORE, MAX_CYC_PRINT, MAX_HAZ, TROPICS_LAT, CYC_KIND,
    MAX_PRECIP_STORE, MAX_PRECIP_PRINT, NO_CITY_RANK,
    orderPrecip, precipName, precipRank,
    // ---- Bulletin V2 (behind ZWX_BULLETIN_V2, default OFF) ----
    BULLETIN_V2, FRAG2, PHENOMENAL_M, MAX_FIRE_STORE, MAX_FLOOD_STORE, MAX_HEAT_STORE, MAX_COLD_STORE, MAX_ICE_STORE, MAX_DUST_STORE, MAX_SNOW_STORE, nameZX,
    HEAT_DANGEROUS_BYTE, HEAT_EXTREME_BYTE, HEAT_TEMP_DANGEROUS_BYTE, HEAT_TEMP_EXTREME_BYTE, HEAT_DANGEROUS, HEAT_EXTREME,
    COLD_DANGEROUS_BYTE, COLD_EXTREME_BYTE, COLD_TEMP_DANGEROUS_BYTE, COLD_TEMP_EXTREME_BYTE, COLD_DANGEROUS, COLD_EXTREME,
    SNOW_HEAVY_CM, SNOW_EXTREME_CM, SNOW_HEAVY, SNOW_EXTREME,
    WETBULB_CAUTION_C, WETBULB_DANGER_C, WETBULB_SURVIVAL_C, HUMID_CAUTION, HUMID_DANGER, HUMID_SURVIVAL, MAX_HUMID_STORE,
    HOTNIGHT_TROPICAL_C, HOTNIGHT_HOT_C, HOTNIGHT_SWELTER_C, HOTNIGHT_TROPICAL, HOTNIGHT_HOT, HOTNIGHT_SWELTER, MAX_HOTNIGHT_STORE,
    MAX_ANOMALY_STORE,
    MAX_TSUNAMI_STORE, MAX_RIVER_STORE, MAX_EVAC_STORE, MAX_TORNADO_STORE, TORNADO_EVENT_CODE, MAX_FLASHFLOOD_STORE, FLASHFLOOD_EVENT_CODE, MAX_HEATWARN_STORE, HEAT_WARN_EVENT_CODE, MAX_DROUGHT_STORE, MAX_SMOKE_STORE, MAX_SMOKEMID_STORE,
    aggregate2, compose2, composeContinental2, composeAlt2,
    aggregateAuto, composeAuto, composeContinentalAuto, composeAltAuto,
  };
  g.WW_REPORT = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
