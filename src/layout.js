// layout.js — shared constants + value mappers for the ZX81 Weather Wall.
// Dual module: usable in Node (require) and the browser (window.WW_LAYOUT).
(function (g) {
  'use strict';
  const L = {
    // --- fixed RAM addresses the BASIC program and host agree on ---
    LAND_BASE: 0x6000, // 24576: 768 bytes, 1/cell (0=sea, >0=land)
    TEMP_ADDR: 0x6300, // 25344: temperature byte (degC + 50, clamped)
    PRECIP_ADDR: 0x6301, // 25345: precip flag (0 dry / >0 wet)
    GO_ADDR: 0x6302,   // 25346: GO flag (host=1 -> repaint -> program clears)
    CAT_ADDR: 0x6303,  // 25347: weather category byte (WMO -> CAT.*)
    SEA_ADDR: 0x6304,  // 25348: sea-state byte (0 calm .. 4 storm)
    WIND_ADDR: 0x6305, // 25349: wind byte (km/h, clamped) — transmitted, reserved
    CYC_ADDR: 0x6306,  // 25350: cyclone byte — tier | pos | S-hemi bit | animate bit
    ISO_ADDR: 0x6307,  // 25351: isotherm edge mask (radar mode) — low nibble N/S/W/E
    PAGE_ADDR: 0x6308, // 25352: page id (teletext view) — PAGE.* ; only on LEN>=8 frames
    WDIR_ADDR: 0x6309, // 25353: wind direction octant (0..7, N=0 CW) — WIND page
    PERIPH_ADDR: 0x630A, // 25354: cyclone-periphery band code (0=none) — only on LEN>=10 frames

    TILE_W: 32,
    TILE_H: 24,
    GRID: 10,          // 10x10 tiles

    // --- FS7 micro-phenomena (phen) layer ----------------------------------
    // Per-tile phenomena list of one-cell MICRO marks (src/glyphs.js MICRO):
    // [{x,y,code}] at the phenomena's EXACT sample cells. Threaded through the
    // wire and MUTUALLY EXCLUSIVE (per tile) with the FS2 cyclone name/pressure
    // trailer: a tier>=CYCLONE tile carries the name/pressure trailer and NO
    // phen; a tier<CYCLONE WEATHER-page tile carries a phen list and NO trailer
    // (see gateway.tilePayload). PHEN_MAX caps the marks/tile; the worst phen
    // frame is 11 base (including TERMV) + 1 count + PHEN_MAX*3 triples = 60 <= 64 (PBUF budget).
    // TEMP/PRESSURE/WIND reuse the same triple format for symbolic contour strokes,
    // quantity labels, and wind-direction hints; the ZX81 still draws the bytes.
    PHEN_MAX: 16,

    // --- payload byte-slot map (per page) — the fixed wire layout ------------
    // The base LEN11 wall frame is a FIXED map so later tasks slot into known
    // offsets without variable-offset arithmetic on the Z80:
    //   [0] tempByte  [1] precipByte  [2] weatherCat  [3] seaState  [4] windByte
    //   [5] cycloneByte  [6] isoByte   [7] pageId      [8] windOctant [9] periphByte [10] termByte
    // BYTE 6 (iso slot, ISO_ADDR 0x6307): the contour edge mask (low nibble
    //   N/S/W/E band-boundary bits), drawn as half-block contour lines. FS7-T3
    //   makes this ONE SHARED slot whose MEANING follows the active PAGE (only one
    //   variable is ever on screen at a time): isotherm edges on TEMP/RADAR
    //   (wx.isoByte, byteToLevel bands), isobar edges on PRESSURE (wx.pressIsoByte,
    //   pressBand), isotach edges on WIND (wx.windIsoByte, windBand). The gateway
    //   (gateway.tilePayload) picks which byte rides the wire by opts.page; the
    //   machine's pg_* routine draws it (TEMP/WIND/RADAR land-only; PRESSURE also
    //   overlays sea via the SEACONTOUR gate — most lows sit over open ocean). On a
    //   page with no contour layer (WEATHER/SEA) it is transmitted but unused.
    // BYTE 8 (windOctant slot, WDIR_ADDR 0x6309): wind direction octant (0..7,
    //   N=0 CW) — CONSUMED ONLY on the WIND page (sizes/points the arrow). On
    //   every other page transmitted but unused. UNCHANGED by FS7.
    // BYTE 10 (termByte): all-page machine terminator primitive. bits0-3 are the
    //   day/night edge mask, bit4 is night-side hatching, bit5 suppresses Antarctic
    //   surface-ice glare on the SATELLITE page. It is renderer-owned, not a phen
    //   triple list, so it does not create dotted connector artifacts.
    // FS7 appends, past byte 10, EITHER the FS2 name/pressure trailer (tier>=
    //   CYCLONE) OR the phen list [count, (x,y,code)...] (tier<CYCLONE, WEATHER
    //   page) — never both. byte6/byte8 semantics are untouched here.

    // ZX81 display file geometry (full 16K/64K file: leading newline, then
    // 24 rows of 32 chars + a 0x76 newline each).
    DFILE_STRIDE: 33,

    // Block-graphics shade ramp for temperature levels 1..4 (empirically chosen
    // from the char ROM: 25% / 50% / 75% / 100% ink coverage). Sea cells render
    // as display code 0 (blank) — a literal, not a named key here.
    RAMP: [0x01, 0x03, 0x07, 0x80],
    INVERSE: 0x80,     // precip -> OR this bit for a "wet" look

    // temperature byte = round(degC) + 50, clamped to a POKE-safe byte.
    tempToByte(degC) {
      let b = Math.round(degC) + 50;
      if (b < 0) b = 0;
      if (b > 255) b = 255;
      return b;
    },
    // Plate width in CHARS of the big TEMP reading for a tempByte (°C+50): digits +
    // a minus char, magnitude clamped to 99 — the same split stampTempNumber / the
    // Z80 st_core perform. Shared by the contour-label placement engine, the
    // worker's relight skip boxes and the proofs, so plate-fit math never forks.
    tempPlateChars(b) {
      const c = ((((b & 0xff) - 50) & 0xff) << 24) >> 24;   // 8-bit signed, as the Z80's SUB 50
      const mag = Math.min(99, Math.abs(c));
      return (mag >= 10 ? 2 : 1) + (c < 0 ? 1 : 0);
    },
    // BASIC thresholds: byte>44 ->L2, >59 ->L3, >74 ->L4  (else L1)
    // i.e. degC  -6 / +9 / +24 boundaries. Mirror here for reference/tests.
    byteToLevel(b) {
      if (b > 74) return 4;
      if (b > 59) return 3;
      if (b > 44) return 2;
      return 1;
    },
    precipToByte(mm) {
      return mm && mm > 0.1 ? 1 : 0;
    },

    // --- precip INTENSITY + TYPE (bulletin wording: INTENSITY TYPE at a city) -----
    // INTENSITY band from precipitation RATE (mm/h), standard meteorological bands:
    //   0 none/trace (<=0.1) · 1 LIGHT (<2.5) · 2 MODERATE (2.5-7.6) · 3 HEAVY (>7.6)
    // Boundaries are inclusive-below / exclusive-at the next band's floor (2.5 -> band
    // 2, 7.6 -> band 3), the WMO/AMS convention. A null/absent rate -> band 0 (no
    // precip clause; ABSENT is never fabricated into a reading). NOTE: this is a
    // rain-rate scale; frozen precip (SNOW) intensity is carried by the TYPE/WMO code
    // variants below, not by liquid mm/h — see PRECIP_TYPE.
    PRECIP_BANDS: [0.1, 2.5, 7.6],   // <=BANDS[0] none · <BANDS[1] light · <BANDS[2] moderate · else heavy
    precipToBand(mm) {
      if (mm == null || !(mm > L.PRECIP_BANDS[0])) return 0;   // absent/trace -> none
      if (mm < L.PRECIP_BANDS[1]) return 1;                    // LIGHT
      if (mm < L.PRECIP_BANDS[2]) return 2;                    // MODERATE
      return 3;                                                // HEAVY
    },
    PRECIP_BAND_WORD: ['', 'LIGHT', 'MODERATE', 'HEAVY'],

    // TYPE from the WMO weather_code (Open-Meteo), a FINER split than the CAT byte
    // used for the map textures: CAT collapses freezing rain (66/67) and rain
    // showers (80-82) into plain RAIN, but the bulletin distinguishes them. The
    // closed enum (index = PRECIP_TYPE.*, matched to PRECIP_TYPE_WORD below):
    //   0 NONE · 1 DRIZZLE (51-57) · 2 RAIN (61-65) · 3 SHOWERS (80-82) ·
    //   4 FREEZING RAIN (66/67) · 5 SNOW (71-77) · 6 SNOW SHOWERS (85/86) ·
    //   7 THUNDER (95-99). A non-precip code (clear/cloud/fog) -> 0 NONE.
    // Snow intensity: WMO 71/73/75 encode slight/moderate/heavy in the code itself,
    // so a SNOW type carries its intensity via the code, not a liquid mm/h rate
    // (documented; the reporter uses the liquid band for rain-family types and the
    // WMO snow-code variant for SNOW — see weatherCodeToSnowBand).
    PRECIP_TYPE: { NONE: 0, DRIZZLE: 1, RAIN: 2, SHOWERS: 3, FREEZING: 4, SNOW: 5, SNOW_SHOWERS: 6, THUNDER: 7 },
    PRECIP_TYPE_WORD: ['', 'DRIZZLE', 'RAIN', 'SHOWERS', 'FREEZING RAIN', 'SNOW', 'SNOW SHOWERS', 'THUNDER'],
    weatherCodeToPrecipType(code) {
      const c = code | 0;
      if (c >= 95 && c <= 99) return 7;                        // THUNDER
      if (c === 66 || c === 67) return 4;                      // FREEZING RAIN
      if (c >= 51 && c <= 57) return 1;                        // DRIZZLE
      if (c >= 80 && c <= 82) return 3;                        // RAIN SHOWERS
      if (c >= 61 && c <= 65) return 2;                        // RAIN
      if (c === 85 || c === 86) return 6;                      // SNOW SHOWERS
      if (c >= 71 && c <= 77) return 5;                        // SNOW
      return 0;                                                // NONE (clear/cloud/fog/other)
    },
    // Pack a per-tile PRECIP DESCRIPTOR byte for the reporter (payload byte 1 on
    // REPORTER frames only — gateway.tilePayload opts.precip; WALL frames keep the
    // 0/1 precipToByte flag). Layout: bits0-2 = TYPE (PRECIP_TYPE, 0=none), bits4-5
    // = INTENSITY band (0..3). 0 = no precip (byte-identical to a dry precipToByte,
    // so the renderer's `>0 == wet` test is preserved). A coded-precip tile whose
    // liquid rate is absent/trace still reports its type at the LIGHT floor (band 1)
    // rather than vanishing — the WMO code is authoritative that precip is falling.
    precipDescriptor(mm, code) {
      const type = L.weatherCodeToPrecipType(code);
      if (type === 0) return 0;
      const isSnow = (type === L.PRECIP_TYPE.SNOW || type === L.PRECIP_TYPE.SNOW_SHOWERS);
      let band = isSnow ? L.weatherCodeToSnowBand(code) : L.precipToBand(mm);
      if (band === 0) band = 1;   // coded precip, absent rate -> LIGHT floor
      return ((band & 0x03) << 4) | (type & 0x07);
    },
    precipDescType(b) { return (b | 0) & 0x07; },
    precipDescBand(b) { return ((b | 0) >> 4) & 0x03; },

    // Snow intensity band from the WMO snow code (71/73/75 = slight/mod/heavy;
    // 77 grains -> light; 85/86 showers slight/heavy). Returned on the SAME 1..3
    // LIGHT/MODERATE/HEAVY scale as precipToBand so the reporter uses one word table.
    weatherCodeToSnowBand(code) {
      const c = code | 0;
      if (c === 75 || c === 86) return 3;   // heavy snow / heavy snow showers
      if (c === 73) return 2;               // moderate snow
      return 1;                             // 71/77/85 slight -> LIGHT
    },

    // --- weather-code layer -------------------------------------------------
    // Weather categories carried in the CAT byte (must match src/texture.js).
    CAT: { CLEAR: 0, CLOUD: 1, FOG: 2, DRIZZLE: 3, RAIN: 4, SNOW: 5, THUNDER: 6 },
    SEA: { CALM: 0, LIGHT: 1, MODERATE: 2, HIGH: 3, STORM: 4, NODATA: 5 },

    // --- teletext page layer (single-variable "pages", time-multiplexed) --------
    // The wall no longer stacks all variables on one 1-bit map; it broadcasts one
    // PAGE at a time and each machine switches its draw routine by the page id (the
    // 8th payload byte, LEN>=8). Page flips cost ZERO API calls — the gateway just
    // re-codes the last fetch. Cyclone markers draw on EVERY page (safety layer).
    // FS7-T5: SATELLITE (6) is a NEW page id appended at the end. RADAR (4) is
    // RETAINED as an id AND its whole render path (gateway/texture/listener) so
    // proof-isotherm/proof-motion stay byte-identical; RADAR only loses its
    // user-facing tab button (web/app.js PAGES, web/index.html). No id is reused
    // or renumbered.
    // FIRE (owner 2026-07-21): a dedicated wildfire view — fire points + downwind smoke
    // field + only fire-relevant weather (wind streaks, precip relief). App-level page:
    // the MACHINE renders the proven WEATHER routine (the worker maps the payload page
    // byte FIRE->WEATHER), the app composes fire-only content + overlays.
    PAGE: { TEMP: 0, WEATHER: 1, WIND: 2, SEA: 3, RADAR: 4, PRESSURE: 5, SATELLITE: 6, FIRE: 7 },
    PAGE_NAMES: ['TEMP', 'WEATHER', 'WIND', 'SEA', 'RADAR', 'PRESSURE', 'SATELLITE', 'FIRE'],

    // Wind direction -> octant (0=N,1=NE,..7=NW), from Open-Meteo wind_direction_10m
    // (degrees the wind blows FROM). Transmitted on the WIND page as WDIR.
    windDirToOctant(deg) {
      if (deg == null || !isFinite(deg)) return 0;
      let d = ((deg % 360) + 360) % 360;
      return Math.round(d / 45) & 7;
    },
    // Wind strength band for the WIND page arrow size: 0 calm (no arrow), 1 breeze,
    // 2 wind, 3 gale — from the wind byte (km/h). Kept coarse so the arrow reads
    // from across the room.
    WIND_BANDS: [12, 30, 55], // km/h boundaries: <12 calm, <30 breeze, <55 wind, else gale
    windBand(kmh) {
      const v = kmh || 0;
      if (v < L.WIND_BANDS[0]) return 0;
      if (v < L.WIND_BANDS[1]) return 1;
      if (v < L.WIND_BANDS[2]) return 2;
      return 3;
    },

    // MSL pressure -> 4 isobar bands (hPa), mirroring byteToLevel's 4-level shape:
    // boundaries at 995/1013/1025 hPa straddle standard sea-level pressure
    // (1013.25 hPa) so "normal" splits into a below/above pair around it, with a
    // deep-low band (near the 990 hPa CYCLONE-signature threshold) and a
    // ridge/high band on top. Returns 1..4, or null for a missing sample (-> no
    // spurious isobar). Used by gateway.computeIsobars for the PRESSURE page.
    PRESS_BANDS: [995, 1013, 1025],
    pressBand(hpa) {
      if (hpa == null) return null;
      if (hpa < L.PRESS_BANDS[0]) return 1;
      if (hpa < L.PRESS_BANDS[1]) return 2;
      if (hpa < L.PRESS_BANDS[2]) return 3;
      return 4;
    },

    // --- PRESSURE isobar CONTOUR field (machine MG=4 engine) -----------------
    // The 4-band pressBand above drives the grey SHADING fill. The smooth machine
    // isobars need a CONTINUOUS field byte instead (as tempToByte gives temperature a
    // continuous field for isotherms). PRESS_ISO_DATUM anchors a 1-byte-per-hPa map:
    //   byte = round(hPa - 950)  -> 950 hPa == 0, 1013 hPa == 63, 1050 hPa == 100.
    // Levels are standard 4 hPa synoptic isobars from 980..1024 hPa (bytes 30..74),
    // matching the CT_LVL_PRESS table baked into tools/z80-contour.js BYTE-FOR-BYTE.
    // A tile with no pressure sample maps to the datum-neutral byte (1013 hPa) so it
    // adds no spurious low/high — the same "never fabricate a reading" rule as the
    // host isobars (pressBand -> null == no edge).
    PRESS_ISO_DATUM: 950,
    PRESS_ISO_LEVELS: [30, 34, 38, 42, 46, 50, 54, 58, 62, 66, 70, 74],
    pressToByte(hpa) {
      if (hpa == null || !isFinite(hpa)) return 1013 - L.PRESS_ISO_DATUM;   // neutral (63)
      let b = Math.round(hpa - L.PRESS_ISO_DATUM);
      if (b < 0) b = 0;
      if (b > 255) b = 255;
      return b;
    },
    // On-contour PRESSURE label width (src/contour-labels.js charsOf): the label
    // prints the isobar's own millibar value (PRESS_ISO_DATUM + levelByte) — 4
    // digits from 1000 MB up, 3 below. Unsigned (no minus glyph, unlike TEMP).
    pressPlateChars(byte) {
      return (L.PRESS_ISO_DATUM + (byte & 0xff)) >= 1000 ? 4 : 3;
    },
    // Tape-loop PRESSURE label levels: every 8 MB (alternate 4 MB isobars). Loop
    // frames are corner-promoted bilinear fields — the same de-crowding rationale
    // as the TEMP loop's major-only filter (see worker placeLabels call).
    pressLoopLabelLevel(byte) {
      return ((byte - 30) % 8) === 0;
    },

    // --- SATELLITE layer (FS7-T5) -------------------------------------------
    // Cloud cover (Open-Meteo cloud_cover, 0-100%) -> a 4-level density band,
    // shown as checker-density greyscale (25/50/75/~overcast ink), the SAME dither
    // idiom already used for sea-state/precip, just applied GLOBALLY (every tile,
    // land + sea) instead of per weather-category. null (no data) -> null
    // (clear/no-mark, never fabricated).
    CLOUD_BANDS: [25, 50, 75],
    cloudLevel(pct) {
      if (pct == null) return null;
      if (pct < L.CLOUD_BANDS[0]) return 0;   // clear
      if (pct < L.CLOUD_BANDS[1]) return 1;
      if (pct < L.CLOUD_BANDS[2]) return 2;
      return 3;                               // ~overcast
    },

    // Day/night terminator ("if cheap" — owner's ask): a real, standard solar-
    // position calculation, NO extra API call. Solar declination from the day of
    // year (a good approximation year-round, no leap-year correction needed at this
    // precision) + hour angle from UTC time and longitude (no equation-of-time
    // correction — a few minutes' error is invisible at 36deg/tile resolution).
    // Returns true iff the sun is above the horizon at (lat, lon) at epochMs.
    // DR-19: epochMs is an EXPLICIT argument (never Date.now()/new Date() from a
    // clock internally) so every caller stays deterministic/reproducible from a
    // fixture timestamp — the same discipline weather.js parse(nowMs) follows.
    isDaylight(lat, lon, epochMs) {
      const d = new Date(epochMs);
      const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 0);
      const dayOfYear = Math.floor((epochMs - startOfYear) / 86400000);
      const decl = 23.44 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81)) * Math.PI / 180;
      const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
      const solarTime = utcHours + lon / 15;             // longitude hour correction
      const hourAngle = (solarTime - 12) * 15 * Math.PI / 180;
      const latRad = lat * Math.PI / 180;
      const sinElev = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
      return sinElev > 0;
    },

    // Map a WMO weather_code (Open-Meteo `weather_code`) to a display category.
    // WMO 4677 groups: 0 clear; 1-3 mainly clear/cloud; 45,48 fog; 51-57 drizzle;
    // 61-67 & 80-82 rain (showers); 71-77 & 85-86 snow; 95-99 thunderstorm.
    weatherCodeToCat(code) {
      const c = code | 0;
      if (c === 45 || c === 48) return 2;                         // FOG
      if (c >= 51 && c <= 57) return 3;                           // DRIZZLE
      if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return 4; // RAIN
      if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 5; // SNOW
      if (c >= 95 && c <= 99) return 6;                           // THUNDER
      if (c >= 1 && c <= 3) return 1;                             // CLOUD
      return 0;                                                   // CLEAR
    },

    // WMO 4677 present-weather DUSTSTORM / SANDSTORM codes. Only the genuine
    // duststorm class (30-35: slight/moderate 30-32, severe 33-35) is a duststorm
    // event — a zero-visibility, respiratory/traffic hazard. The LESSER dust/haze
    // codes (06 widespread suspended dust, 07 wind-raised dust/sand, 08 dust/sand
    // whirls, 09 duststorm within sight) are haze / blowing dust, NOT a duststorm,
    // and MUST NOT raise a DUST STORM alert (the bulletin's dust detection uses this
    // predicate so the split is one source of truth; a cheap range compare the Z80
    // mirror reproduces with two CP guards). Non-numeric/absent -> false.
    isDustStorm(code) { const c = code | 0; return c >= 30 && c <= 35; },
    isFog(code) { const c = code | 0; return c === 45 || c === 48; },   // WMO fog / rime fog -> NOTABLE "DENSE FOG"
    // WMO 4677 present-weather DUST/HAZE codes BELOW the duststorm class: 06 widespread suspended
    // dust, 07 wind-raised dust/sand, 08 dust/sand whirls, 09 duststorm within sight. These are
    // haze / blowing dust — a NOTABLE visibility/air matter, NOT the zero-visibility duststorm
    // (30-35, isDustStorm, an ALERT). Disjoint bands: a code is at most one of the two.
    isDustHaze(code) { const c = code | 0; return c >= 6 && c <= 9; },   // WMO 06-09 -> NOTABLE "DUSTY, HAZY AIR"

    // Map a marine significant wave height (metres) to a sea-state band. Calm
    // stays blank (crisp coastline); rising -> denser waves; storm-force -> bands.
    // null/undefined (no marine data) maps to NODATA — ABSENT ≠ CALM. A marine-API
    // miss renders as "no signal" bars and is aggregated honestly by the reporter
    // (never folded into the rough-sea max, never reported as calm).
    waveToSeaState(m) {
      if (m == null) return L.SEA.NODATA;    // absent — never fabricate calm
      if (!(m > 0)) return 0;                // measured zero/negative -> CALM (blank)
      if (m < 0.5) return 0;                 // slight/calm sea -> blank (as before)
      if (m < 1.25) return 1;                // LIGHT
      if (m < 2.5) return 2;                 // MODERATE
      if (m < 4.0) return 3;                 // HIGH
      return 4;                              // STORM
    },

    windToByte(kmh) {
      let b = Math.round(kmh || 0);
      if (b < 0) b = 0;
      if (b > 255) b = 255;
      return b;
    },

    // --- cyclone-signature layer -------------------------------------------
    // Cyclone tiers carried in the CYC byte's high nibble (must match texture.js).
    CYC: { NONE: 0, STORM: 1, CYCLONE: 2, MAJOR: 3 },
    // Sub-tile sample positions (low nibble) — where in the 32x24 tile the
    // triggering sample sits, so the marker draws at the storm core, not the
    // tile centre. Geographic NW (west+north) maps to the tile's top-left, etc.
    SUB: { CENTER: 0, NW: 1, NE: 2, SW: 3, SE: 4 },

    // Cyclone-signature thresholds — the crux of the layer. Wave height ALONE
    // cannot identify a cyclone: swell radiates thousands of km from the core and
    // deep mid-latitude winter lows raise huge seas too. The signature is the
    // COINCIDENCE of extreme surface wind (gusts) with a very LOW sea-level
    // pressure core:
    //   STORM   gusts >= 75 km/h                          — gale/severe wind only
    //   CYCLONE gusts >= 90 km/h AND pressure <= 990 hPa  — wind + low-pressure core
    //   MAJOR   gusts >= 120 km/h AND pressure <= 975 hPa — hurricane-force + deep core
    // Evaluated strongest-first; a missing gust (or, for CYCLONE/MAJOR, a missing
    // pressure) degrades the tier DOWNWARD, never upward — a data gap can never
    // fabricate a cyclone (see cycloneTier()).
    CYC_THRESHOLDS: [
      { tier: 3, gustKmh: 120, pressureHpa: 975 },  // MAJOR
      { tier: 2, gustKmh: 90, pressureHpa: 990 },   // CYCLONE
      { tier: 1, gustKmh: 75, pressureHpa: null },  // STORM (wind only)
    ],

    // Classify one sample's (gust, pressure) into a cyclone tier. Graceful:
    // no gust -> tier 0; a tier that requires pressure but has none falls through
    // to a lower (wind-only) tier, so missing data never invents a cyclone.
    cycloneTier(gustKmh, pressureHpa) {
      if (gustKmh == null || !(gustKmh >= 0)) return 0;
      for (let i = 0; i < L.CYC_THRESHOLDS.length; i++) {
        const t = L.CYC_THRESHOLDS[i];
        const pressOk = (t.pressureHpa == null) ||
          (pressureHpa != null && pressureHpa <= t.pressureHpa);
        if (gustKmh >= t.gustKmh && pressOk) return t.tier;
      }
      return 0;
    },

    // Pack the cyclone byte: pos (bits0-2) | SUPPRESS (bit3) | tier (bits4-5) |
    // animate (bit6) | south (bit7). tier/pos are the original layer; the spare
    // bits carry animation + honesty state WITHOUT growing the payload:
    //   bit7 SOUTH    — southern hemisphere (spiral rotates CW, mirrored per Coriolis)
    //   bit6 ANIMATE  — this tile is in the capped top-N animated set (else static)
    //   bit3 SUPPRESS — the tropical spiral is gated OFF for this detection (FS2 §C.1):
    //                   tier/bulletin are UNCHANGED (detector thresholds untouched);
    //                   only the on-screen spiral is suppressed so the DISPLAY matches
    //                   the latitude-aware WIRE BULLETIN. The gateway sets it when the
    //                   spiral-gate fails (no NHC match AND |lat| >= TROPICS_LAT); the
    //                   tile then draws the extratropical bold/inverse `L`, no spiral.
    // Derived by the gateway from the triggering sample's latitude/row, so no
    // payload is spent identifying the hemisphere. Legacy callers pass 2 or 4 args
    // -> south/animate/suppress default 0 -> byte identical to the pre-FS2 layer.
    cycloneToByte(tier, pos, south, animate, suppress) {
      return ((pos | 0) & 0x07) | (((tier | 0) & 0x03) << 4) |
        (animate ? 0x40 : 0) | (south ? 0x80 : 0) | (suppress ? 0x08 : 0);
    },
    cycTierOf(b) { return ((b | 0) >> 4) & 0x03; },
    cycPosOf(b) { return (b | 0) & 0x07; },
    cycSouthOf(b) { return ((b | 0) & 0x80) ? 1 : 0; },
    cycAnimOf(b) { return ((b | 0) & 0x40) ? 1 : 0; },
    cycSuppressOf(b) { return ((b | 0) & 0x08) ? 1 : 0; },

    // --- FS2 spiral-gate + pressure codec (see docs/fs2-cyclone-honesty-design.md) --
    // OUTER latitude bound for the tropical-spiral gate (§C.2). An NHC-named system
    // carries the spiral through the 30-40 band; beyond 40 an NHC match still draws
    // it. The INNER bound stays report.js TROPICS_LAT (30) — NOT duplicated here.
    CYC_GATE_OUTER_LAT: 40,

    // Pressure codec (§C.3): one byte covers 850..1105 hPa.
    //   pressureByte = clamp(round(hPa) - 850, 0..255);  hPa = 850 + byte.
    // A null/undefined/NaN reading returns null so callers can decline to emit a
    // pressure trailer (rather than silently encoding a bogus 850 hPa). A reading
    // outside the encodable band is clamped and pressureClamped() flags it so the
    // gateway/NOTES can log the honest loss.
    pressureToByte(hPa) {
      if (hPa == null || !isFinite(hPa)) return null;
      let b = Math.round(hPa) - 850;
      if (b < 0) b = 0;
      if (b > 255) b = 255;
      return b;
    },
    pressureByteToHpa(b) { return 850 + ((b | 0) & 0xff); },
    // True iff round(hPa) falls outside 850..1105 (encoding will clamp -> honest
    // loss). Null/NaN is NOT a clamp (it yields no trailer) -> returns false.
    pressureClamped(hPa) {
      if (hPa == null || !isFinite(hPa)) return false;
      const r = Math.round(hPa);
      return r < 850 || r > 1105;
    },

    // --- cyclone-periphery layer (sub-tile storm spiral) -------------------
    // The eye tile draws a bigger cloud/wind SPIRAL around its eye, sized in
    // KILOMETRES (a real storm is < 1 tile — see gateway.computePeriphery /
    // src/glyphs.js). The gateway packs a per-tile PERIPH byte; the machine blits a
    // baked centred spiral stamp of the given radius bucket, optionally L-R
    // mirrored (S-hemisphere CW spin). Packing MUST match src/glyphs.js PERIPH.
    //   bits0-2 SIZE  radius bucket 1..6 (0 = no periphery)
    //   bit3    FLIP  horizontal mirror (southern hemisphere)
    PERIPH: { SIZE_MASK: 0x07, FLIP: 0x08 },
    periphToByte(sizeIdx, flip) {
      return (((sizeIdx | 0) + 1) & 0x07) | (flip ? 0x08 : 0);
    },
    periphSizeOf(b) { return ((b | 0) & 0x07) - 1; },   // -1 = none
    periphFlipOf(b) { return ((b | 0) & 0x08) ? 1 : 0; },

    // --- FS2 T11: ordinary (sub-CYCLONE) pressure-centre L/H marker -----------
    // A plain char 'L'/'H' at the tile CENTRE flags an ordinary pressure low/high
    // (a strict local extremum of the per-tile MSL grid that is NOT a cyclone).
    // It reuses the FREE high bits of the PERIPH byte (bits 4-5) — NO new payload
    // byte, no LEN change. The encoding is DISJOINT from the cyclone periphery:
    //   * a cyclone tile has SIZE bits0-2 set (radius bucket) and centre bits 0;
    //   * an ordinary L/H tile has SIZE 0 and centre bits = LOW(1)/HIGH(2).
    // The two never coincide (findPressureCentres excludes tier>=CYCLONE tiles),
    // so bits0-3 (size+flip) and bits4-5 (centre) can share the one byte safely.
    PERIPH_CENTRE: { NONE: 0, LOW: 1, HIGH: 2 },
    periphCentreToBits(c) { return ((c | 0) & 0x03) << 4; },
    periphCentreOf(b) { return ((b | 0) >> 4) & 0x03; },

    // --- isotherm layer (radar mode) ---------------------------------------
    // Temperature is shown as CONTOUR LINES between the 4 temperature bands
    // (byteToLevel) rather than as a grey fill. An isotherm crosses a tile edge
    // iff the neighbouring tile sits in a different band. The gateway computes,
    // per tile, a 4-bit edge mask (which of N/S/W/E edges is a band boundary) and
    // ships it as the 7th payload byte; the machine draws a half-block line on
    // each flagged edge. A missing neighbour (grid pole edge) or missing sample
    // (null level) is treated as "same band" -> no spurious line.
    ISO: { N: 1, S: 2, W: 4, E: 8 },
    // Build the edge mask from this tile's band level and its 4 neighbours'
    // levels (null = no neighbour / no data -> no boundary on that edge).
    isothermEdges(self, north, south, west, east) {
      if (self == null) return 0;
      let m = 0;
      if (north != null && north !== self) m |= L.ISO.N;
      if (south != null && south !== self) m |= L.ISO.S;
      if (west != null && west !== self) m |= L.ISO.W;
      if (east != null && east !== self) m |= L.ISO.E;
      return m;
    },

    // --- smooth temperature shading (spatial dither) ------------------------
    // The classic RAMP has only 4 ink-density levels, so the TEMP wall bands in 4
    // hard steps. tempToLevel16 maps a temperature byte to a CONTINUOUS level in 4.4
    // fixed point (16 = level 1 .. 64 = level 4); BAYER4 is a 4x4 ordered-dither
    // matrix; smoothShade renders a cell by dithering between the two adjacent RAMP
    // chars that bracket the fractional level. Across the wall this yields ~16
    // perceived shades from the same 4 glyphs, so tile-to-tile temperature reads as a
    // smooth gradient instead of 4 bands. Pure per-cell math (x&3, y&3, frac), so the
    // Z80 mirrors it with a table lookup + compare; LF16_TABLE is baked into the
    // machine as DB so JS reference == Z80 byte-for-byte. Opt-in (the gateway sets the
    // smooth flag); the classic 4-level path is byte-identical when it is off.
    LF16_MIN: 16, LF16_MAX: 64,
    // 256-entry byte -> Lf16 table (level*16, clamped 16..64), linear about the band
    // centres (L1..L4 at bytes 37/52/67/82, 15 bytes/level). Generated once here and
    // consumed by both the oracle and the Z80 DB emitter (single source of truth).
    LF16_TABLE: (function () {
      const t = new Array(256);
      for (let b = 0; b < 256; b++) {
        let v = Math.round(16 + (b - 37) * 16 / 15);
        if (v < 16) v = 16;
        if (v > 64) v = 64;
        t[b] = v;
      }
      return t;
    })(),
    tempToLevel16(b) { return L.LF16_TABLE[b & 0xff]; },
    // Bayer 4x4 ordered-dither thresholds (0..15), indexed (y&3)*4 + (x&3).
    BAYER4: [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5],
    // Render one land cell of the smooth TEMP fill: dither between the two RAMP chars
    // bracketing the fractional level lf16 (4.4 fixed). Endpoints collapse to a solid
    // ramp char (no dither) so a uniform extreme tile is byte-clean.
    smoothShade(lf16, x, y) {
      if (lf16 <= L.LF16_MIN) return L.RAMP[0];
      if (lf16 >= L.LF16_MAX) return L.RAMP[3];
      const lo = lf16 >> 4;                 // 1..3
      const frac = lf16 & 0x0f;             // 0..15
      const m = L.BAYER4[((y & 3) << 2) + (x & 3)];
      const lvl = frac > m ? lo + 1 : lo;   // 1..4
      return L.RAMP[lvl - 1];
    },
  };
  g.WW_LAYOUT = L;
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
})(typeof window !== 'undefined' ? window : globalThis);
