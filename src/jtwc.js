// jtwc.js — Joint Typhoon Warning Center feed: W-Pacific / N-Indian-Ocean /
// S-Hemisphere tropical-cyclone ingestion, MERGED into the SAME authority-storm
// pipeline the NHC feed uses (src/nhc.js + gateway.detectCyclones/matchNhcStorm).
//
// WHY this exists. The authority storm feed was NHC CurrentStorms only (Atlantic +
// E/C Pacific). W-Pacific named systems — the Philippine-Sea typhoons — never
// entered the pipeline, so a genuine typhoon produced at most an indirect
// "SEAS ROUGH NEAR S CHINA" marine signal and was NEVER named on the wall. JTWC is
// the US military's authority for exactly the basins NHC does not cover, so folding
// it in closes the coverage gap without a second detector: a JTWC-named system
// becomes an AUTHORITY-FORCED cyclone detection (a spiral at its official position,
// name beside it, eye pressure) using gateway.detectCyclones's existing machinery.
//
// TWO-STEP FETCH (bounded, once per cycle). The RSS index (jtwc.rss) lists the
// active systems by NAME + designation but carries NO position/winds/pressure —
// those live in each system's linked warning-text product (wpNNYYweb.txt). So one
// ingestion pass = fetch the RSS once, then fetch the warning text for each ACTIVE
// named system (typically 0-3). This is still "once per scheduler cycle" (it does
// not poll); the per-storm warning fetches are bounded by the tiny active-system
// count. Each fetch RETRIES ONCE then degrades — the navy endpoint is known flaky.
//
// GRACEFUL DEGRADE is a HARD requirement, identical to nhc.js (design R2): ANY
// failure — RSS down, warning down, malformed body, no position — yields FEWER (or
// zero) storms and NEVER throws. Feed down = W-Pac systems simply absent this cycle,
// never a broken cycle. An empty feed ("No Current Tropical Cyclone Warnings.") is
// the NORMAL off-season case and is indistinguishable, on purpose, from a benign
// failure: both mean "no JTWC names available".
//
// The normalized storm keeps the RAW NHC field names latitudeNumeric /
// longitudeNumeric so gateway.matchNhcStorm consumes it byte-for-byte identically to
// an NHC storm; it adds source:'jtwc', basin, gustKmh, and forced:true (the
// authority-forced-detection flag detectCyclones keys the spiral injection on).
// Dual module (Node 18+/browser both have global fetch).
(function (g) {
  'use strict';
  const RSS_URL = 'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss';
  const KT_TO_KMH = 1.852;   // 1 knot = 1.852 km/h (exact, nautical mile / hour)

  // Basin group from a JTWC storm designation suffix letter (e.g. "09W" -> WP).
  //   W        -> WP  (Northwest Pacific)
  //   A | B    -> IO  (North Indian Ocean: Arabian Sea / Bay of Bengal)
  //   S | P    -> SH  (Southern Hemisphere: S Indian / S Pacific)
  //   E | C    -> EP  (East/Central Pacific — normally NHC's, JTWC rarely lists)
  // Unknown suffix -> null (kept, but basin-less); the region-table label still
  // names the tile in the bulletin, so a null basin never blanks a storm.
  function basinFromDesignation(desig) {
    const m = /(\d{2})([A-Z])/.exec(String(desig || '').toUpperCase());
    if (!m) return null;
    switch (m[2]) {
      case 'W': return 'WP';
      case 'A': case 'B': return 'IO';
      case 'S': case 'P': return 'SH';
      case 'E': case 'C': return 'EP';
      default: return null;
    }
  }

  // Parse a "DD.DN DDD.DE" style position (JTWC "REPEAT POSIT" / "NEAR" line) into
  // signed { lat, lon }. N/E positive, S/W negative; lon stays in [-180,180] (the
  // wall's equirectangular convention, tileCenterLonLat). null if unparseable.
  function parsePosition(text) {
    if (!text) return null;
    // Prefer the unambiguous "REPEAT POSIT:" current fix; fall back to the first
    // "NEAR <lat> <lon>" (the warning-position line). Never the FORECAST positions.
    const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*([NS])\s+([0-9]{1,3}(?:\.[0-9]+)?)\s*([EW])/i;
    let m = /REPEAT\s+POSIT:\s*([0-9.]+)\s*([NS])\s+([0-9.]+)\s*([EW])/i.exec(text);
    if (!m) m = /NEAR\s+([0-9.]+)\s*([NS])\s+([0-9.]+)\s*([EW])/i.exec(text);
    if (!m) m = re.exec(text);
    if (!m) return null;
    const lat = parseFloat(m[1]) * (m[2].toUpperCase() === 'S' ? -1 : 1);
    let lon = parseFloat(m[3]) * (m[4].toUpperCase() === 'W' ? -1 : 1);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
    return { lat, lon };
  }

  // Parse one JTWC warning-text product (wpNNYYweb.txt) into the fields the wall
  // needs. Robust to missing fields (each degrades to null); NEVER throws. The
  // warning is the AUTHORITY for position + intensity + (when present) central
  // pressure — unlike our own coarse tile sampling, which misses compact cores.
  function parseWarningText(txt) {
    const s = String(txt || '');
    // SUBJ/TYPHOON 09W (BAVI) WARNING NR 039//
    const subj = /SUBJ\/\s*([A-Z ]+?)\s+(\d{2}[A-Z])\s+\(([^)]+)\)\s+WARNING\s+NR\s+(\d+)/i.exec(s);
    const classification = subj ? subj[1].trim().toUpperCase() : null;
    const designation = subj ? subj[2].toUpperCase() : null;
    const name = subj ? subj[3].trim().toUpperCase() : null;
    const warningNr = subj ? parseInt(subj[4], 10) : null;
    const pos = parsePosition(s);
    // FIRST "MAX SUSTAINED WINDS - NNN KT, GUSTS NNN KT" is the CURRENT (present)
    // wind distribution; later identical lines are FORECAST hours — never taken.
    const wind = /MAX\s+SUSTAINED\s+WINDS\s*-\s*(\d+)\s*KT(?:\s*,\s*GUSTS\s*(\d+)\s*KT)?/i.exec(s);
    const sustainedKt = wind ? parseInt(wind[1], 10) : null;
    const gustKt = wind && wind[2] != null ? parseInt(wind[2], 10) : null;
    // MINIMUM CENTRAL PRESSURE AT ...Z IS 958 MB.  (optional — many warnings omit it)
    // "MINIMUM CENTRAL PRESSURE AT 101200Z IS 958 MB." — anchor on " IS " so the
    // warning-time digits ("101200Z") are skipped and the pressure value is taken.
    const pres = /MINIMUM\s+CENTRAL\s+PRESSURE\b.*?\bIS\s+(\d{3,4})\s*MB/i.exec(s);
    const pressureMb = pres ? parseInt(pres[1], 10) : null;
    if (!name || !pos) return null;   // no name or no position -> cannot draw/match
    return normalizeStorm({
      designation, name, classification, warningNr,
      lat: pos.lat, lon: pos.lon, sustainedKt, gustKt, pressureMb,
    });
  }

  // Build the normalized authority-storm object from parsed warning fields. Shares
  // the NHC field names (latitudeNumeric/longitudeNumeric, name, pressureMb,
  // intensity) so gateway.matchNhcStorm consumes it directly, and adds the JTWC
  // extras (basin, gustKmh, source, forced).
  function normalizeStorm(f) {
    if (!f || f.lat == null || f.lon == null || !f.name) return null;
    const gustKmh = f.gustKt != null ? f.gustKt * KT_TO_KMH
      : (f.sustainedKt != null ? f.sustainedKt * KT_TO_KMH : null);
    return {
      id: f.designation || f.name,
      name: f.name,
      classification: f.classification || null,
      basin: basinFromDesignation(f.designation),
      intensity: f.sustainedKt == null ? null : f.sustainedKt,   // sustained KT (NHC-compatible)
      gustKt: f.gustKt == null ? null : f.gustKt,
      gustKmh: gustKmh,
      pressureMb: f.pressureMb == null ? null : f.pressureMb,
      warningNr: f.warningNr == null ? null : f.warningNr,
      latitudeNumeric: f.lat,
      longitudeNumeric: f.lon,
      source: 'jtwc',
      forced: true,   // authority-forced-detection flag (gateway.detectCyclones)
    };
  }

  // Parse the RSS index into a list of { name, designation, classification,
  // warningUrl }. Every ACTIVE named system in every region item is captured; the
  // "No Current Tropical Cyclone Warnings." items yield nothing. Never throws.
  function parseRssIndex(xml) {
    const s = String(xml || '');
    const out = [];
    // Each active system header looks like:
    //   <b>Typhoon  09W (Bavi) Warning #39 </b> ... <a href='...wp0926web.txt'>
    // Capture classification / designation / name at the header, then the FIRST
    // web.txt link that follows it (the TC Warning Text product).
    const hdr = /<b>\s*([A-Za-z ]+?)\s+(\d{2}[A-Z])\s+\(([^)]+)\)\s+Warning\s*#?(\d+)/gi;
    let m;
    while ((m = hdr.exec(s)) !== null) {
      const classification = m[1].trim().toUpperCase();
      const designation = m[2].toUpperCase();
      const name = m[3].trim().toUpperCase();
      const rest = s.slice(m.index);
      const link = /href=['"]([^'"]*web\.txt)['"]/i.exec(rest);
      out.push({
        name, designation, classification,
        warningUrl: link ? link[1] : null,
      });
    }
    return out;
  }

  // GET one URL as text with a single retry, then degrade to null. NEVER throws.
  async function fetchText(url, fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f || !url) return null;
    for (let attempt = 0; attempt < 2; attempt++) {   // try once, retry once
      try {
        const res = await f(url);
        if (res && res.ok) { const t = await res.text(); if (t) return t; }
      } catch (_) { /* fall through to retry / degrade */ }
    }
    return null;
  }

  // Fetch the RSS index + each active system's warning text and return the
  // normalized authority-storm list (may be empty). fetchImpl is injectable
  // (proofs stub it) and defaults to the platform global fetch. NEVER throws.
  async function fetchJtwcStorms(fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return [];
    const rss = await fetchText(RSS_URL, f);
    if (!rss) return [];
    const index = parseRssIndex(rss);
    const storms = [];
    const seen = new Set();
    for (const entry of index) {
      if (!entry.warningUrl) continue;
      if (seen.has(entry.warningUrl)) continue;   // one fetch per distinct product
      seen.add(entry.warningUrl);
      const txt = await fetchText(entry.warningUrl, f);
      if (!txt) continue;                          // warning down -> this system absent
      const storm = parseWarningText(txt);
      if (storm) storms.push(storm);
    }
    return storms;
  }

  const JTWC = {
    RSS_URL, KT_TO_KMH, basinFromDesignation, parsePosition,
    parseWarningText, normalizeStorm, parseRssIndex, fetchText, fetchJtwcStorms,
  };
  g.WW_JTWC = JTWC;
  if (typeof module !== 'undefined' && module.exports) module.exports = JTWC;
})(typeof window !== 'undefined' ? window : globalThis);
