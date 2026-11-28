// alert-places.js — the PLACE an authority warning names in the bulletin.
//
// WHY: the authority clauses used to name the gazetteer city of the 10x10 grid tile an alert's
// centroid rounded into — an 18 x 36-degree tile named "NEW YORK" stood for Colorado to Maine
// (owner 2026-09-24). A warning now names the place the authority actually warned: a US STATE (NWS
// UGC zone codes), a Canadian PROVINCE (Environment Canada), or a COUNTRY (Meteoalarm's 37 European
// services; the WMO Severe Weather Information Centre list for the rest — owner 2026-09-27: "look at
// other warning services around the globe such as environment canada").
//
// PLACE IDs are assigned in DESCENDING POPULATION order across the whole table, so "place-ID
// ascending" == "most populous first" — the listing order on both desks, and the order the gateway
// wires them (the Z80 lists in wire order). Populations are approximate (ordering only, never
// printed). The Z80 reporter bakes the SAME names (PLOFF/PLBLOB) — id = index here.
//
// Continent (for the continental desks): US states + Canadian provinces are N AMERICA (Hawaii and
// the Pacific territories OCEANIA); a country is the continent of the continental member tile
// nearest its capital (the same rule the desk cities use).
(function (g) {
  'use strict';
  const R = (typeof require === 'function') ? require('./regions') : g.WW_REGIONS;

  // [key, bulletin name, population (millions), capital lat, lon, continent or null (-> nearest tile)]
  const US = [
    ['CA', 'CALIFORNIA', 39.5], ['TX', 'TEXAS', 29.1], ['FL', 'FLORIDA', 21.5], ['NY', 'NEW YORK', 20.2],
    ['PA', 'PENNSYLVANIA', 13.0], ['IL', 'ILLINOIS', 12.8], ['OH', 'OHIO', 11.8], ['GA', 'GEORGIA', 10.7],
    ['NC', 'NORTH CAROLINA', 10.4], ['MI', 'MICHIGAN', 10.1], ['NJ', 'NEW JERSEY', 9.3], ['VA', 'VIRGINIA', 8.6],
    ['WA', 'WASHINGTON', 7.7], ['AZ', 'ARIZONA', 7.2], ['MA', 'MASSACHUSETTS', 7.0], ['TN', 'TENNESSEE', 6.9],
    ['IN', 'INDIANA', 6.8], ['MD', 'MARYLAND', 6.2], ['MO', 'MISSOURI', 6.15], ['WI', 'WISCONSIN', 5.9],
    ['CO', 'COLORADO', 5.8], ['MN', 'MINNESOTA', 5.7], ['SC', 'SOUTH CAROLINA', 5.1], ['AL', 'ALABAMA', 5.0],
    ['LA', 'LOUISIANA', 4.7], ['KY', 'KENTUCKY', 4.5], ['OR', 'OREGON', 4.2], ['OK', 'OKLAHOMA', 4.0],
    ['CT', 'CONNECTICUT', 3.6], ['PR', 'PUERTO RICO', 3.29], ['UT', 'UTAH', 3.27], ['IA', 'IOWA', 3.19],
    ['NV', 'NEVADA', 3.1], ['AR', 'ARKANSAS', 3.0], ['MS', 'MISSISSIPPI', 2.96], ['KS', 'KANSAS', 2.94],
    ['NM', 'NEW MEXICO', 2.1], ['NE', 'NEBRASKA', 1.96], ['ID', 'IDAHO', 1.84], ['WV', 'WEST VIRGINIA', 1.79],
    ['HI', 'HAWAII', 1.46, 5], ['NH', 'NEW HAMPSHIRE', 1.38], ['ME', 'MAINE', 1.36], ['RI', 'RHODE ISLAND', 1.10],
    ['MT', 'MONTANA', 1.08], ['DE', 'DELAWARE', 0.99], ['SD', 'SOUTH DAKOTA', 0.89], ['ND', 'NORTH DAKOTA', 0.78],
    ['AK', 'ALASKA', 0.73], ['DC', 'WASHINGTON DC', 0.69], ['VT', 'VERMONT', 0.64], ['WY', 'WYOMING', 0.58],
    ['GU', 'GUAM', 0.15, 5], ['VI', 'US VIRGIN ISLANDS', 0.09], ['AS', 'AMERICAN SAMOA', 0.05, 5], ['MP', 'N MARIANA ISLANDS', 0.05, 5],
  ];
  const CANADA = [
    ['ON', 'ONTARIO', 15.6], ['QC', 'QUEBEC', 8.9], ['BC', 'BRITISH COLUMBIA', 5.6], ['AB', 'ALBERTA', 4.8],
    ['MB', 'MANITOBA', 1.5], ['SK', 'SASKATCHEWAN', 1.2], ['NS', 'NOVA SCOTIA', 1.1], ['NB', 'NEW BRUNSWICK', 0.84],
    ['NL', 'NEWFOUNDLAND', 0.54], ['PE', 'PRINCE EDWARD ISLAND', 0.17], ['NT', 'NORTHWEST TERRITORIES', 0.045],
    ['YT', 'YUKON', 0.044], ['NU', 'NUNAVUT', 0.04],
  ];
  // Countries: [ISO2, name, pop, capital lat, lon]. Meteoalarm members first (MA = its feed slug).
  const COUNTRIES = [
    ['AT', 'AUSTRIA', 9.1, 48.2, 16.4, 'austria'], ['BE', 'BELGIUM', 11.8, 50.85, 4.35, 'belgium'],
    ['BA', 'BOSNIA', 3.2, 43.86, 18.41, 'bosnia-herzegovina'], ['BG', 'BULGARIA', 6.4, 42.7, 23.3, 'bulgaria'],
    ['HR', 'CROATIA', 3.9, 45.8, 16.0, 'croatia'], ['CY', 'CYPRUS', 1.3, 35.17, 33.36, 'cyprus'],
    ['CZ', 'CZECHIA', 10.9, 50.08, 14.43, 'czechia'], ['DK', 'DENMARK', 5.9, 55.68, 12.57, 'denmark'],
    ['EE', 'ESTONIA', 1.37, 59.44, 24.75, 'estonia'], ['FI', 'FINLAND', 5.6, 60.17, 24.94, 'finland'],
    ['FR', 'FRANCE', 68, 48.86, 2.35, 'france'], ['DE', 'GERMANY', 84, 52.52, 13.4, 'germany'],
    ['GR', 'GREECE', 10.4, 37.98, 23.73, 'greece'], ['HU', 'HUNGARY', 9.6, 47.5, 19.04, 'hungary'],
    ['IS', 'ICELAND', 0.39, 64.15, -21.94, 'iceland'], ['IE', 'IRELAND', 5.3, 53.35, -6.26, 'ireland'],
    ['IL', 'ISRAEL', 9.8, 31.77, 35.21, 'israel'], ['IT', 'ITALY', 59, 41.9, 12.5, 'italy'],
    ['LV', 'LATVIA', 1.9, 56.95, 24.1, 'latvia'], ['LT', 'LITHUANIA', 2.8, 54.69, 25.28, 'lithuania'],
    ['LU', 'LUXEMBOURG', 0.67, 49.61, 6.13, 'luxembourg'], ['MT', 'MALTA', 0.54, 35.9, 14.51, 'malta'],
    ['MD', 'MOLDOVA', 2.5, 47.01, 28.86, 'moldova'], ['ME', 'MONTENEGRO', 0.62, 42.44, 19.26, 'montenegro'],
    ['NL', 'NETHERLANDS', 17.9, 52.37, 4.9, 'netherlands'], ['MK', 'NORTH MACEDONIA', 1.8, 42.0, 21.43, 'republic-of-north-macedonia'],
    ['NO', 'NORWAY', 5.5, 59.91, 10.75, 'norway'], ['PL', 'POLAND', 37, 52.23, 21.01, 'poland'],
    ['PT', 'PORTUGAL', 10.4, 38.72, -9.14, 'portugal'], ['RO', 'ROMANIA', 19, 44.43, 26.1, 'romania'],
    ['RS', 'SERBIA', 6.6, 44.8, 20.46, 'serbia'], ['SK', 'SLOVAKIA', 5.4, 48.15, 17.11, 'slovakia'],
    ['SI', 'SLOVENIA', 2.1, 46.05, 14.51, 'slovenia'], ['ES', 'SPAIN', 48, 40.42, -3.7, 'spain'],
    ['SE', 'SWEDEN', 10.5, 59.33, 18.07, 'sweden'], ['CH', 'SWITZERLAND', 8.8, 46.95, 7.45, 'switzerland'],
    ['UA', 'UKRAINE', 37, 50.45, 30.52, 'ukraine'], ['GB', 'UNITED KINGDOM', 68, 51.51, -0.13, 'united-kingdom'],
    // Rest of the world (WMO Severe Weather Information Centre sources)
    ['RU', 'RUSSIA', 144, 55.76, 37.62], ['BY', 'BELARUS', 9.2, 53.9, 27.56], ['AU', 'AUSTRALIA', 26, -35.28, 149.13],
    ['IN', 'INDIA', 1430, 28.61, 77.21], ['IR', 'IRAN', 89, 35.69, 51.39], ['VU', 'VANUATU', 0.33, -17.73, 168.32],
    ['MG', 'MADAGASCAR', 30, -18.88, 47.51], ['TZ', 'TANZANIA', 65, -6.16, 35.75], ['ZW', 'ZIMBABWE', 16, -17.83, 31.05],
    ['GH', 'GHANA', 34, 5.6, -0.19], ['NG', 'NIGERIA', 223, 9.08, 7.4], ['LY', 'LIBYA', 6.9, 32.89, 13.19],
    ['SB', 'SOLOMON ISLANDS', 0.72, -9.43, 159.95], ['TT', 'TRINIDAD', 1.5, 10.65, -61.52], ['AR', 'ARGENTINA', 46, -34.6, -58.38],
    ['PY', 'PARAGUAY', 6.8, -25.26, -57.58], ['EC', 'ECUADOR', 18, -0.18, -78.47], ['UY', 'URUGUAY', 3.4, -34.9, -56.16],
    ['MX', 'MEXICO', 128, 19.43, -99.13], ['BR', 'BRAZIL', 216, -15.79, -47.88], ['CL', 'CHILE', 19.6, -33.45, -70.67],
    ['CO', 'COLOMBIA', 52, 4.71, -74.07], ['PE', 'PERU', 34, -12.05, -77.04], ['BO', 'BOLIVIA', 12, -16.5, -68.15],
    ['VE', 'VENEZUELA', 28, 10.49, -66.88], ['CR', 'COSTA RICA', 5.2, 9.93, -84.08], ['NZ', 'NEW ZEALAND', 5.2, -41.29, 174.78],
    ['PH', 'PHILIPPINES', 117, 14.6, 120.98], ['JP', 'JAPAN', 124, 35.68, 139.69], ['CN', 'CHINA', 1410, 39.9, 116.4],
    ['KR', 'SOUTH KOREA', 51.7, 37.57, 126.98], ['HK', 'HONG KONG', 7.5, 22.3, 114.17], ['MU', 'MAURITIUS', 1.3, -20.16, 57.5],
    ['KE', 'KENYA', 55, -1.29, 36.82], ['ZA', 'SOUTH AFRICA', 60, -25.75, 28.19], ['PK', 'PAKISTAN', 240, 33.69, 73.06],
    ['BD', 'BANGLADESH', 173, 23.81, 90.41], ['MY', 'MALAYSIA', 34, 3.14, 101.69], ['SG', 'SINGAPORE', 5.9, 1.35, 103.82],
    ['FJ', 'FIJI', 0.93, -18.14, 178.44], ['TH', 'THAILAND', 72, 13.76, 100.5], ['ID', 'INDONESIA', 278, -6.21, 106.85],
    ['KZ', 'KAZAKHSTAN', 20, 51.17, 71.45], ['SA', 'SAUDI ARABIA', 36, 24.71, 46.68], ['EG', 'EGYPT', 112, 30.04, 31.24],
  ];

  function tileCentre(t) { return { lat: 81 - 18 * Math.floor(t / 10), lon: -162 + 36 * (t % 10) }; }
  function haversineKm(a, b) {
    const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function nearestContinent(lat, lon) {
    let best = -1, bd = Infinity;
    R.CONTINENT_TILES.forEach((tiles, c) => tiles.forEach((t) => {
      const d = haversineKm({ lat, lon }, tileCentre(t));
      if (d < bd) { bd = d; best = c; }
    }));
    return best;
  }

  const rows = [];
  for (const [k, n, pop, cont] of US) rows.push({ key: 'US-' + k, name: n, pop, cont: cont != null ? cont : 0 });
  for (const [k, n, pop] of CANADA) rows.push({ key: 'CA-' + k, name: n, pop, cont: 0 });
  // Malta's capital sits nearest an Africa desk tile; it reports with its European neighbours.
  const CONT_OVERRIDE = { MT: 2 };
  for (const [iso, n, pop, lat, lon, slug] of COUNTRIES) {
    rows.push({ key: 'ISO-' + iso, name: n, pop, cont: CONT_OVERRIDE[iso] != null ? CONT_OVERRIDE[iso] : nearestContinent(lat, lon), slug: slug || null });
  }
  rows.sort((a, b) => b.pop - a.pop);   // ID order == population order (the listing order)

  const PLACES = rows.map((r) => [r.key, r.name]);
  const PLACE_NAMES = rows.map((r) => r.name);
  const PLACE_COUNT = PLACE_NAMES.length;
  const CONT_OF = rows.map((r) => r.cont);
  const ID_OF_KEY = {};
  rows.forEach((r, i) => { ID_OF_KEY[r.key] = i; });
  const METEOALARM = rows.map((r, i) => (r.slug ? { slug: r.slug, place: i } : null)).filter(Boolean);

  if (PLACE_COUNT > 254) throw new Error('alert-places: ' + PLACE_COUNT + ' places — ids must fit a byte');
  for (const n of PLACE_NAMES) {
    if (!/^[A-Z ]+$/.test(n)) throw new Error('alert-places.js: name not ZX81-safe: ' + JSON.stringify(n));
  }

  function isPlace(id) { return Number.isInteger(id) && id >= 0 && id < PLACE_COUNT; }
  function placeName(id) { return isPlace(id) ? PLACE_NAMES[id] : ''; }
  function continentOf(id) { return isPlace(id) ? CONT_OF[id] : -1; }
  function stateId(usps) { const v = ID_OF_KEY['US-' + String(usps || '').toUpperCase()]; return v === undefined ? -1 : v; }
  function provinceId(code) { const v = ID_OF_KEY['CA-' + String(code || '').toUpperCase()]; return v === undefined ? -1 : v; }
  function countryId(iso2) { const v = ID_OF_KEY['ISO-' + String(iso2 || '').toUpperCase()]; return v === undefined ? -1 : v; }

  // placesOfUgc: distinct US-state place IDs named by NWS UGC codes ("ILC149", "MOZ012"), in
  // first-seen order. The first two letters are the USPS code; marine zones ("PZZ", "AMZ") skip.
  function placesOfUgc(ugc) {
    const out = [];
    if (!Array.isArray(ugc)) return out;
    for (const u of ugc) {
      if (typeof u !== 'string' || u.length < 2) continue;
      const id = stateId(u.slice(0, 2));
      if (id >= 0 && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  const WARNING_RE = /warning|emergency/i;

  // matchToPlaces: the NWS alerts of ONE event code, as the places they warn (Extreme/Severe,
  // WARNING/EMERGENCY products only, eventCode via the shared closed table, optional event-name
  // filter). [{place}] deduped, place-ID ascending, capped.
  function matchToPlaces(alerts, eventCode, eventToCode, cap, eventRe) {
    const seen = new Set();
    if (Array.isArray(alerts)) {
      for (const a of alerts) {
        if (!a || (a.severity !== 'Extreme' && a.severity !== 'Severe')) continue;
        if (!WARNING_RE.test(a.event || '')) continue;
        if (eventRe && !eventRe.test(a.event || '')) continue;
        if (eventToCode(a.event, a.category) !== eventCode) continue;
        for (const p of (Array.isArray(a.places) ? a.places : [])) if (isPlace(p)) seen.add(p);
      }
    }
    return finish(seen, cap);
  }

  // evacToPlaces: authority EVACUATION orders (a.evac) as the places they cover. [{place}].
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

  const AP = { PLACES, PLACE_NAMES, PLACE_COUNT, METEOALARM, isPlace, placeName, continentOf, stateId, provinceId, countryId,
    placesOfUgc, matchToPlaces, evacToPlaces, finish };
  if (typeof module !== 'undefined' && module.exports) module.exports = AP;
  else g.WW_ALERT_PLACES = AP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
