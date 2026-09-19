// windflow.js — drifting-dot WIND-page particle flow (the "streaming dots"
// wind visualization). This is the SINGLE SOURCE OF TRUTH for where the dots
// are: the browser (web/app.js) and any node proof both call simulate() and get
// the identical per-tile / per-phase dot cells, exactly the discipline
// texture.js / glyphs.js follow.
//
// AUTHENTICITY (the charm bar — see /zwx + CLAUDE.md):
//   * The dots follow the REAL wind field — the same per-tile wind vectors
//     (Open-Meteo wind_direction_10m + wind_speed_10m) the WIND page already
//     transmits. No invented flow, no smoothing that fabricates detail.
//   * WHERE each step runs. The particle POSITIONS are computed by the tape
//     master (the gateway server-side; the whole-wall orchestrator app.js in the
//     browser — the side that can see all 100 tiles at once), then the ZX81 fleet
//     DRAWS the cells. This is the coastline-mask model the project already
//     blesses: the humble machine renders 1-bit cells; a whole-grid quantity is
//     poked in as data. The per-cell field is an interpolation of neighbouring
//     tile CENTRES — the same honest inter-tile interpolation the smooth-temp
//     gradient uses (never sub-tile fabrication).
//   * EVERY particle resolves to a WHOLE ZX81 cell. Positions are integer Euler
//     steps in 8-bit fixed point (1/8-cell units) — arithmetic a real ZX81 could
//     do (shift + add, no float). The advance rate is a presentation choice
//     (documented), exactly like the precip radar loop's 3 Hz is not real precip
//     speed; DIRECTION and RELATIVE strength are the honest, data-backed part.
//   * A data-less tile (no wind sample) contributes ZERO velocity — particles
//     stall over it, never fabricate a breeze.
//
// The wall's wind_direction is the direction the wind blows FROM (met
// convention, see layout.windDirToOctant); a particle drifts the way the wind
// blows TOWARD, i.e. the OPPOSITE octant. simulate() inverts it.

(function (g) {
  const L = (typeof require === 'function') ? require('./layout') : g.WW_LAYOUT;
  const GL = (typeof require === 'function') ? require('./glyphs') : g.WW_GLYPHS;

  const TW = L.TILE_W, TH = L.TILE_H;      // 32 x 24 cells per tile
  const OCT_VEC = GL.OCT_VEC;              // 8 octant unit vectors (0=N,CW)

  // ---- tuneables (loop-closed; see below) -----------------------------------
  const NPHASE = 8;          // drift frames per loop (frame p+NPHASE == frame p)
  // Seeds are scattered PER TILE (not on one global lattice): a per-seed 2-D hash
  // places each seed anywhere in its 32x24 tile, so seeds never line up on shared
  // global rows. The old 26x15 GLOBAL lattice put ~15 seeds on the same handful
  // of cell-rows; with mostly-horizontal wind every particle stayed on its row
  // and the wall collapsed into ~15 horizontal dotted streaks pinned to tile
  // edges (the rejected look). Per-tile 2-D scatter spreads dots through the
  // whole tile in BOTH axes, so horizontal wind reads as a filled drifting field.
  const SEEDS_PER_TILE = 9;  // enough LONG streaks per tile to read as a flow
                             // field the eye can follow, without over-inking the
                             // outlined map (the coastline stays visible between
                             // streamlines).
  const SPD_SCALE_N = 11, SPD_SCALE_D = 25; // vmag8 = round(kmh*11/25): a PRESENTATION
                             // advance rate (like the radar loop's 3 Hz) tuned so a
                             // typical wind draws a followable streamline, not a stub.
  const VMAX8 = 40;          // cap ~5 cells/phase — long streaks for a gale
  const SUBSTEPS = 6;        // micro-steps per phase: the streak is a CONNECTED
                             // chain of cells (no gaps even for fast wind), so it
                             // traces the streamline instead of dotting it.
  const TRAIL_CELLS = 11;    // streak length (cells behind the head): a long
                             // oriented streamline, not a short dash — this is what
                             // makes the field read as WIND rather than as specks.
  const HEAD = 0x80;         // solid inverse: the bold streak head
  // Trail char by distance behind the head (0 == nearest): solid near the head,
  // fading to a lighter quadrant down the tail, so the streak points the way the
  // wind blows (head leads) even in a single still frame.
  const TRAIL_CHARS = [0x80, 0x80, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08];

  const FP = 8;              // fixed-point: position in 1/8-cell units
  const SQRT1_2_8 = 6;       // round(0.7071 * 8) — diagonal normalisation in 1/8 units

  // Deterministic 0..65535 hash of an integer (no Math.random — proofs must be
  // byte-stable across runs and machines).
  function hash16(i) {
    let h = (i * 2654435761) >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return h & 0xffff;
  }

  // Per-tile flow velocity in 1/8-cell-per-phase units, from the wall's wind
  // vector. oct = the FROM octant (0..7) or -1 (no data); kmh = wind speed.
  // Returns {vx8, vy8} — (0,0) when calm or absent (no fabricated flow).
  function tileVel(oct, kmh) {
    if (oct == null || oct < 0 || !(kmh > 0)) return { vx8: 0, vy8: 0 };
    const flow = (oct + 4) & 7;            // blow-TOWARD = opposite the FROM octant
    const v = OCT_VEC[flow];
    let vmag8 = Math.round((kmh * SPD_SCALE_N) / SPD_SCALE_D);
    if (vmag8 < 1) vmag8 = 1;              // a live but light wind still creeps
    if (vmag8 > VMAX8) vmag8 = VMAX8;
    const diag = (v[0] !== 0 && v[1] !== 0);
    // scale the unit octant vector by vmag8 (1/8-cell units), diagonals * ~0.707
    const vx8 = diag ? Math.round((v[0] * vmag8 * SQRT1_2_8) / 8) : v[0] * vmag8;
    const vy8 = diag ? Math.round((v[1] * vmag8 * SQRT1_2_8) / 8) : v[1] * vmag8;
    return { vx8, vy8 };
  }

  // --- PARAMETRIC CYCLONE VORTEX (owner 2026-07-28) -----------------------------------
  // "The guiding principle here is, this is a toy... if the winds around a hurricane must
  // to some degree be computed rather than measured, that's fine. We can allow that
  // specific exception to prioritize charm over truth."
  //
  // WHY COMPUTED: rotation around an eye cannot come from samples at this scale. The
  // per-tile wind field has ONE vector per ~3,800 x 2,000 km tile and even the dense
  // lattice's nodes sit ~1,000 km apart, while a hurricane's circulation spans a few
  // hundred km — Fausto read 30 km/h at a tile centre 2,000 km from a 139 km/h eyewall.
  // So the drift dots circle a detected storm using the storm's OWN published parameters
  // (official eye position, authority gust, the periphery radius model) — a rendering of
  // NHC/JTWC's numbers, not a fabricated sample. DISPLAY-ONLY by construction: the vortex
  // perturbs the windflow particle field and nothing else. It is never written into
  // data[].windKmh/windDir, so readings, bulletins, isotach bytes, and posted products
  // still carry only measurements.
  //
  // Model: solid-body core + linear skirt. Tangential speed rises linearly to vmax at
  // rCore, decays linearly to ZERO at rOut, exactly zero beyond — so a vortex CANNOT
  // perturb a dot outside its declared radius, and an empty vortex list is a no-op
  // (byte-identical dots; proof-wind-vortex pins both). Spin: visual CCW in the northern
  // hemisphere, CW south (Coriolis) — same convention as the spiral stamp glyphs.
  //
  // vortexVel(v, gx, gy) -> {vx8, vy8} at a global cell position. v = {gx, gy (eye, global
  // cells), kmh (authority gust), rCore, rOut (cells), south}. Same kmh -> 1/8-cell scaling
  // as tileVel so vortex speed and ambient drift read on one scale.
  function vortexVel(v, gx, gy, N) {
    const GW = (N || 10) * TW;
    let dx = gx - v.gx;
    dx = ((dx % GW) + GW) % GW;                 // wrap longitude,
    if (dx > GW / 2) dx -= GW;                  // shortest way round
    const dy = gy - v.gy;
    const r = Math.hypot(dx, dy);
    if (r <= 0 || r >= v.rOut) return { vx8: 0, vy8: 0 };
    let vmag8 = Math.round(((v.kmh || 0) * SPD_SCALE_N) / SPD_SCALE_D);
    if (vmag8 > VMAX8) vmag8 = VMAX8;
    if (vmag8 < 1) return { vx8: 0, vy8: 0 };
    const rc = Math.max(1, v.rCore || 1);
    const vt = r < rc ? (vmag8 * r) / rc
                      : vmag8 * (1 - (r - rc) / Math.max(1, v.rOut - rc));
    // unit tangent: visual CCW north = (dy,-dx)/r ; CW south = (-dy,dx)/r
    const s = v.south ? -1 : 1;
    return { vx8: Math.round((s * dy * vt) / r), vy8: Math.round((s * -dx * vt) / r) };
  }

  // buildVortices(data, N, kmPerCellAtLat) — one vortex per detected, unsuppressed
  // CYCLONE+ tile, from the fields detectCyclones/computePeriphery already set:
  // cycloneLat/Lon (the OFFICIAL eye after forced injection), cycloneGust (authority
  // gust), periphRadiusKm (the sized periphery), cycloneSouth. kmPerCellAtLat is passed
  // in (gateway owns it) so this module stays light. Pure; returns [].
  function buildVortices(data, N, kmPerCellAtLat) {
    const out = [];
    if (!data || !kmPerCellAtLat) return out;
    for (let t = 0; t < N * N; t++) {
      const w = data[t];
      if (!w) continue;
      const tier = w.cycloneTier | 0;
      if (tier < 2 /* L.CYC.CYCLONE */ || (w.cycloneSuppress | 0)) continue;
      const lat = w.cycloneLat, lon = w.cycloneLon;
      if (lat == null || lon == null) continue;
      const kmPerCell = kmPerCellAtLat(lat);
      if (!(kmPerCell > 0)) continue;
      const rOut = Math.max(4, (w.periphRadiusKm || 500) / kmPerCell);
      out.push({
        gx: (((((lon + 162) / 36) * TW + TW / 2) % (N * TW)) + N * TW) % (N * TW),
        gy: Math.max(0, Math.min(N * TH - 1, ((81 - lat) / 18) * TH + TH / 2)),
        kmh: w.cycloneGust != null ? w.cycloneGust : 120,
        rCore: Math.max(2, rOut * 0.35),
        rOut,
        south: !!(w.cycloneSouth | 0),
      });
    }
    return out;
  }

  // Bilinear interpolation of the 4 neighbouring tile-CENTRE velocities at a
  // continuous global cell position (gx,gy). Columns WRAP (global longitude, like
  // the isotherm seams); rows CLAMP (no neighbour past the poles). vel[t] =
  // {vx8,vy8}. Same inter-tile interpolation idiom as the smooth-temp gradient.
  function sampleField(vel, N, gx, gy) {
    const GW = N * TW;
    // fractional tile coordinate (tile centre sits at cell (col*TW+TW/2 ...))
    let fc = (gx - TW / 2) / TW;
    let fr = (gy - TH / 2) / TH;
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const tx = fc - c0, ty = fr - r0;
    const col = (c) => ((c % N) + N) % N;                 // wrap longitude
    const row = (r) => (r < 0 ? 0 : r > N - 1 ? N - 1 : r); // clamp latitude
    const at = (c, r) => vel[row(r) * N + col(c)];
    const a = at(c0, r0), b = at(c0 + 1, r0), cc = at(c0, r0 + 1), d = at(c0 + 1, r0 + 1);
    const lerp = (p, q, u) => p + (q - p) * u;
    const vx8 = lerp(lerp(a.vx8, b.vx8, tx), lerp(cc.vx8, d.vx8, tx), ty);
    const vy8 = lerp(lerp(a.vy8, b.vy8, tx), lerp(cc.vy8, d.vy8, tx), ty);
    return { vx8: Math.round(vx8), vy8: Math.round(vy8) };
  }

  // Advance a fixed-point position (X8,Y8) one Euler step through the field.
  // Longitude wraps; latitude clamps to the pole rows. Whole-cell arithmetic.
  function step(vel, N, X8, Y8) {
    const GW8 = N * TW * FP, GH8 = (N * TH - 1) * FP;
    const s = sampleField(vel, N, X8 / FP, Y8 / FP);
    let nx = X8 + s.vx8, ny = Y8 + s.vy8;
    nx = ((nx % GW8) + GW8) % GW8;                        // wrap
    if (ny < 0) ny = 0; else if (ny > GH8) ny = GH8;      // clamp
    return [nx, ny];
  }

  // simulate({N, vecs}) -> dotsByTile: an array length N*N; each entry is an
  // array of NPHASE overlays; each overlay is a list of {i, c} (i = local cell
  // index y*TW+x within the tile, c = the ZX81 char code). vecs[t] = {oct, kmh}
  // (oct = FROM octant 0..7 or -1; kmh = wind speed). Loop-closed: overlay for
  // phase p and phase p+NPHASE are identical, so the drift never jumps.
  function simulate(opts) {
    const N = opts.N || 10;
    const vecs = opts.vecs || [];
    const GW = N * TW, GH = N * TH;
    // Parametric cyclone vortices (see vortexVel). Empty/absent list -> sampleAt IS
    // sampleField and the output is byte-identical to the pre-vortex build (pinned by
    // proof-wind-vortex L1) — the ambient measured field is never touched.
    const vorts = opts.vortices || [];
    const sampleAt = vorts.length === 0
      ? (gx, gy) => sampleField(vel, N, gx, gy)
      : (gx, gy) => {
          const s = sampleField(vel, N, gx, gy);
          let vx8 = s.vx8, vy8 = s.vy8;
          for (let k = 0; k < vorts.length; k++) {
            const vv = vortexVel(vorts[k], gx, gy, N);
            vx8 += vv.vx8; vy8 += vv.vy8;
          }
          return { vx8, vy8 };
        };

    // per-tile velocity field
    const vel = new Array(N * N);
    for (let t = 0; t < N * N; t++) {
      const w = vecs[t] || {};
      vel[t] = tileVel(w.oct == null ? -1 : w.oct | 0, w.kmh || 0);
    }

    // Per-tile deterministic 2-D seed scatter (no RNG, no global lattice). Each
    // seed's x and y are hashed INDEPENDENTLY within its own tile, so seeds do
    // not share global cell-rows (the streak bug). A tile with no wind still gets
    // seeds — they stall in place (honest: a calm tile shows still dots, never a
    // fabricated breeze). off staggers each seed's phase so every frame carries a
    // mix of ages and the loop stays closed.
    const seeds = [];
    for (let t = 0; t < N * N; t++) {
      const ox = (t % N) * TW, oy = ((t / N) | 0) * TH;
      for (let s = 0; s < SEEDS_PER_TILE; s++) {
        const hx = hash16(t * 131 + s * 97 + 1);
        const hy = hash16(t * 57 + s * 193 + 7);
        const lx = ((hx & 0xff) * TW) >> 8;               // 0..TW-1 within tile
        const ly = ((hy & 0xff) * TH) >> 8;               // 0..TH-1 within tile
        let sx = ox + lx, sy = oy + ly;
        sx = ((sx % GW) + GW) % GW;
        sy = sy < 0 ? 0 : sy > GH - 1 ? GH - 1 : sy;
        const off = ((hx >> 8) ^ (hy >> 8)) % NPHASE;
        seeds.push({ x8: sx * FP, y8: sy * FP, off });
      }
    }
    // VORTEX DENSIFICATION (owner 2026-07-28: the WIND page shows a storm as "intense dots
    // swirling" — the swirl IS the storm's mark there, so the ambient 9-seeds-per-tile
    // density is too thin to read as a hurricane). Each vortex gets extra seeds hashed
    // deterministically into an annulus between the eye and rOut (polar: hashed angle x
    // hashed radius, biased toward rCore where the tangential speed peaks). Same hash16
    // discipline as the ambient seeds — no RNG, byte-stable, loop-closed via off. Bounded
    // like everything else about the vortex: no vortices, no extra seeds, dots unchanged.
    const VORTEX_SEEDS = 28;
    for (let vi = 0; vi < vorts.length; vi++) {
      const vo = vorts[vi];
      for (let s = 0; s < VORTEX_SEEDS; s++) {
        const ha = hash16(0x5EED + vi * 271 + s * 89);
        const hr = hash16(0xC1C + vi * 613 + s * 37);
        const ang = ((ha & 0x3ff) / 1024) * 2 * Math.PI;
        // radius: sqrt-biased into the fast band around rCore, capped inside rOut
        const rr = vo.rCore * 0.5 + Math.sqrt((hr & 0xff) / 256) * (vo.rOut - vo.rCore * 0.5) * 0.92;
        let sx = Math.round(vo.gx + rr * Math.cos(ang));
        let sy = Math.round(vo.gy + rr * Math.sin(ang));
        sx = ((sx % GW) + GW) % GW;
        sy = sy < 0 ? 0 : sy > GH - 1 ? GH - 1 : sy;
        seeds.push({ x8: sx * FP, y8: sy * FP, off: ((ha >> 10) ^ (hr >> 8)) % NPHASE });
      }
    }

    // Pre-integrate every seed into a CONNECTED cell chain. Each phase is advanced
    // in SUBSTEPS micro Euler steps and every distinct cell crossed is appended,
    // so the chain is gap-free (a streamline) even when the wind moves the
    // particle several cells per phase. headAt[age] is the chain index of the head
    // at that age; the streak is the TRAIL_CELLS chain cells behind it.
    const P = seeds.length;
    const GW8 = GW * FP, GH8 = (GH - 1) * FP;
    const chains = new Array(P);
    for (let i = 0; i < P; i++) {
      let X8 = seeds[i].x8, Y8 = seeds[i].y8;
      const cells = [[X8 >> 3, Y8 >> 3]];
      const headAt = new Array(NPHASE);
      headAt[0] = 0;
      const pushCell = (cx, cy) => {
        const n = cells.length;
        if (cells[n - 1][0] !== cx || cells[n - 1][1] !== cy) cells.push([cx, cy]);
      };
      for (let a = 1; a < NPHASE; a++) {
        for (let ss = 0; ss < SUBSTEPS; ss++) {
          const s = sampleAt(X8 / FP, Y8 / FP);
          let nx = X8 + Math.round(s.vx8 / SUBSTEPS);
          let ny = Y8 + Math.round(s.vy8 / SUBSTEPS);
          nx = ((nx % GW8) + GW8) % GW8;                    // wrap longitude
          if (ny < 0) ny = 0; else if (ny > GH8) ny = GH8;  // clamp latitude
          X8 = nx; Y8 = ny;
          pushCell(X8 >> 3, Y8 >> 3);
        }
        headAt[a] = cells.length - 1;
      }
      chains[i] = { cells, headAt };
    }

    // build per-tile / per-phase overlays. age = (p + off_i) mod NPHASE, so the
    // population is a staggered mix of ages every frame and frame(p+NPHASE) ==
    // frame(p) exactly (each particle's age cycles with period NPHASE).
    const dotsByTile = new Array(N * N);
    for (let t = 0; t < N * N; t++) {
      dotsByTile[t] = new Array(NPHASE);
      for (let p = 0; p < NPHASE; p++) dotsByTile[t][p] = null;
    }
    // per (tile,phase) code map so a head always wins a shared cell
    const maps = new Array(N * N);
    for (let t = 0; t < N * N; t++) {
      maps[t] = new Array(NPHASE);
      for (let p = 0; p < NPHASE; p++) maps[t][p] = new Map();
    }
    const put = (cx, cy, p, code, head) => {
      const t = ((cy / TH) | 0) * N + ((cx / TW) | 0);
      const li = (cy % TH) * TW + (cx % TW);
      const m = maps[t][p];
      const cur = m.get(li);
      if (head || cur == null || cur.head === false) m.set(li, { c: code, head: !!head });
    };
    for (let i = 0; i < P; i++) {
      const off = seeds[i].off;
      const cells = chains[i].cells, headAt = chains[i].headAt;
      for (let p = 0; p < NPHASE; p++) {
        const age = (p + off) % NPHASE;
        const hi = headAt[age];
        // the streak is TRAIL_CELLS connected chain cells behind the head — a
        // gap-free streamline dash that conveys motion + flow DIRECTION even in a
        // single still frame (head leads, tail fades). Near the seed the chain is
        // short, so a just-born streak is simply shorter.
        for (let k = 1; k <= TRAIL_CELLS; k++) {
          const idx = hi - k;
          if (idx >= 0) { const pr = cells[idx]; put(pr[0], pr[1], p, TRAIL_CHARS[k - 1], false); }
        }
        const cur = cells[hi];
        put(cur[0], cur[1], p, HEAD, true);
      }
    }
    for (let t = 0; t < N * N; t++) {
      for (let p = 0; p < NPHASE; p++) {
        const out = [];
        for (const [i, v] of maps[t][p]) out.push({ i, c: v.c });
        dotsByTile[t][p] = out;
      }
    }
    return dotsByTile;
  }

  const WF = { NPHASE, HEAD, TRAIL_CHARS, tileVel, sampleField, simulate, vortexVel, buildVortices };
  g.WW_WINDFLOW = WF;
  if (typeof module !== 'undefined' && module.exports) module.exports = WF;
})(typeof window !== 'undefined' ? window : globalThis);
