// alert-places.js — the PLACE an authority alert names in the bulletin (owner 2026-09-24).
//
// WHY: the authority clauses (TORNADO WARNING / FLASH FLOOD WARNING / EVACUATION ORDER) used to
// name the gazetteer city of the 10x10 grid tile the alert's centroid rounded into. A grid tile is
// 18 deg x 36 deg, so "NEW YORK" stood for everything from Colorado to Maine — a river-flood warning
// in Pike County, Illinois read as "FLASH FLOOD WARNING IN NEW YORK". The bulletin now names the
// alert's own STATE, read from the authority's affected-zone codes (NWS UGC "ILC149" -> IL), so the
// place printed is the place the authority actually warned. State level suits the wall's scope:
// weather of continental interest, not county detail.
//
// PLACE_NAMES is ordered by population (2020 census), then the territories. The index is the
// place ID on the 0xC4 header wire and doubles as the sort key: the bulletin lists places
// place-ID ascending, i.e. most populous first — the same "biggest population first" discipline
// the city clauses use. The Z80 reporter bakes this SAME table (tools/reporter.js PLOFF/PLBLOB),
// so the tape and report.js render byte-identical names by construction.
//
// COVERAGE: only US NWS alerts carry UGC codes. A WMO-register alert has no state, so it names no
// place and stays out of these clauses (never mislabelled). The WMO register is not fetched live
// today; if it is, extend this table with countries rather than falling back to tile cities.
(function (g) {
  'use strict';

  // [USPS code, bulletin name] — population order (2020 census), then DC and the territories.
  const PLACES = [
    ['CA', 'CALIFORNIA'], ['TX', 'TEXAS'], ['FL', 'FLORIDA'], ['NY', 'NEW YORK'],
    ['PA', 'PENNSYLVANIA'], ['IL', 'ILLINOIS'], ['OH', 'OHIO'], ['GA', 'GEORGIA'],
    ['NC', 'NORTH CAROLINA'], ['MI', 'MICHIGAN'], ['NJ', 'NEW JERSEY'], ['VA', 'VIRGINIA'],
    ['WA', 'WASHINGTON'], ['AZ', 'ARIZONA'], ['MA', 'MASSACHUSETTS'], ['TN', 'TENNESSEE'],
    ['IN', 'INDIANA'], ['MD', 'MARYLAND'], ['MO', 'MISSOURI'], ['WI', 'WISCONSIN'],
    ['CO', 'COLORADO'], ['MN', 'MINNESOTA'], ['SC', 'SOUTH CAROLINA'], ['AL', 'ALABAMA'],
    ['LA', 'LOUISIANA'], ['KY', 'KENTUCKY'], ['OR', 'OREGON'], ['OK', 'OKLAHOMA'],
    ['CT', 'CONNECTICUT'], ['UT', 'UTAH'], ['IA', 'IOWA'], ['NV', 'NEVADA'],
    ['AR', 'ARKANSAS'], ['MS', 'MISSISSIPPI'], ['KS', 'KANSAS'], ['NM', 'NEW MEXICO'],
    ['NE', 'NEBRASKA'], ['ID', 'IDAHO'], ['WV', 'WEST VIRGINIA'], ['HI', 'HAWAII'],
    ['NH', 'NEW HAMPSHIRE'], ['ME', 'MAINE'], ['RI', 'RHODE ISLAND'], ['MT', 'MONTANA'],
    ['DE', 'DELAWARE'], ['SD', 'SOUTH DAKOTA'], ['ND', 'NORTH DAKOTA'], ['AK', 'ALASKA'],
    ['DC', 'WASHINGTON DC'], ['VT', 'VERMONT'], ['WY', 'WYOMING'],
    ['PR', 'PUERTO RICO'], ['GU', 'GUAM'], ['VI', 'US VIRGIN ISLANDS'],
    ['AS', 'AMERICAN SAMOA'], ['MP', 'N MARIANA ISLANDS'],
  ];
  const PLACE_NAMES = PLACES.map((p) => p[1]);
  const PLACE_COUNT = PLACE_NAMES.length;
  const ID_OF_CODE = {};
  PLACES.forEach((p, i) => { ID_OF_CODE[p[0]] = i; });

  // Load-time self-check: every name must be ZX81 bulletin-safe (A-Z + space), same rule as the
  // WMO_EVENT table — fail at import rather than put an un-encodable byte on the tape.
  for (const n of PLACE_NAMES) {
    if (!/^[A-Z ]+$/.test(n)) throw new Error('alert-places.js: name not ZX81-safe: ' + JSON.stringify(n));
  }

  function isPlace(id) { return Number.isInteger(id) && id >= 0 && id < PLACE_COUNT; }
  function placeName(id) { return isPlace(id) ? PLACE_NAMES[id] : ''; }

  // placesOfUgc: distinct place IDs named by a list of NWS UGC codes ("ILC149", "MOZ012"), in
  // first-seen order. The first two letters are the USPS state code; marine zones ("PZZ", "AMZ",
  // "GMZ", "LMZ") have no state code and are skipped.
  function placesOfUgc(ugc) {
    const out = [];
    if (!Array.isArray(ugc)) return out;
    for (const u of ugc) {
      if (typeof u !== 'string' || u.length < 2) continue;
      const id = ID_OF_CODE[u.slice(0, 2).toUpperCase()];
      if (id !== undefined && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  const WARNING_RE = /warning|emergency/i;

  // matchToPlaces: the authority alerts of ONE event code, as the places they warn.
  //   * Extreme/Severe only (the same honesty gate as WMO matchToTiles),
  //   * a WARNING or EMERGENCY product only — the clause says "WARNING", so a watch or an
  //     advisory must not print as one,
  //   * eventCode match through the shared closed event table (WM.eventToCode).
  // Every state an alert covers is listed. Returns [{place}] deduped, place-ID ascending,
  // capped at `cap`.
  function matchToPlaces(alerts, eventCode, eventToCode, cap) {
    const seen = new Set();
    if (Array.isArray(alerts)) {
      for (const a of alerts) {
        if (!a || (a.severity !== 'Extreme' && a.severity !== 'Severe')) continue;
        if (!WARNING_RE.test(a.event || '')) continue;
        if (eventToCode(a.event, a.category) !== eventCode) continue;
        for (const p of (Array.isArray(a.places) ? a.places : [])) if (isPlace(p)) seen.add(p);
      }
    }
    return finish(seen, cap);
  }

  // evacToPlaces: authority EVACUATION orders (the a.evac flag the CAP parsers set from
  // responseType==Evacuate or an evacuate-directing instruction/headline) as the places they
  // cover. Not severity-gated (same posture as WMO evacToTiles). [{place}] ascending, capped.
  function evacToPlaces(alerts, cap) {
    const seen = new Set();
    if (Array.isArray(alerts)) {
      for (const a of alerts) {
        if (!a || !a.evac) continue;
        for (const p of (Array.isArray(a.places) ? a.places : [])) if (isPlace(p)) seen.add(p);
      }
    }
    return finish(seen, cap);
  }

  function finish(seen, cap) {
    const ids = Array.from(seen).sort((x, y) => x - y);
    return ids.slice(0, cap == null ? ids.length : cap).map((place) => ({ place }));
  }

  const AP = { PLACES, PLACE_NAMES, PLACE_COUNT, isPlace, placeName, placesOfUgc, matchToPlaces, evacToPlaces };
  if (typeof module !== 'undefined' && module.exports) module.exports = AP;
  else g.WW_ALERT_PLACES = AP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
