// listener.js — the on-machine Z80 program for the ZX81 Weather Wall.
//
// This is the code every one of the 100 machines runs. It is bit-banged onto
// the machines by the boot broadcast (ROM LOAD) and thereafter it:
//   1. bit-bangs the EAR line (IN A,($FE), bit 7) to receive the custom fast
//      pulse-width protocol from the downlink party bus;
//   2. hunts for a START pulse, reads the tile ADDR, and ignores frames that
//      aren't addressed to this machine (its address is a byte at MYADDR — the
//      physical "DIP switch");
//   3. on its own frame: reads LEN + PAYLOAD + CKSUM, verifies the checksum;
//   4. if good, expands PAYLOAD against the machine's baked-in coastline mask at
//      $6000 into the 32x24 display file. Which VARIABLE it draws is chosen by
//      the PAGE byte (teletext pages): TEMP isotherms / WEATHER glyphs / WIND chevrons
//      / SEA-state / RADAR isotherms. Cyclone markers draw on EVERY page. Then it
//      transmits an ACK in its TDMA slot; if bad, transmits a NAK and re-listens;
//   5. a normal tile HALTs (screen frozen). A tile carrying an ANIMATED cyclone
//      instead free-runs a loop that cycles the spiral through 4 pre-rotated phase
//      stamps (mirrored per hemisphere — CCW north, CW south) so the eye visibly
//      rotates. The phase/glyph/chevron tables are injected verbatim from the shared
//      byte-table module (src/glyphs.js), so JS reference == Z80 DB by construction.
//
// It runs with interrupts disabled and the NMI generator off (FAST mode) so the
// receive timing loop is never perturbed. Assembled by tools/z80asm.js.

// (bound under a private name: in a Web Worker all importScripts share one
// global scope, so a top-level `assemble` would collide with z80asm's export.)
const _z80asm = (typeof require === 'function') ? require('./z80asm')
  : (typeof window !== 'undefined' ? window.WW_Z80ASM : globalThis.WW_Z80ASM);
const _glyphs = (typeof require === 'function') ? require('../src/glyphs')
  : (typeof window !== 'undefined' ? window.WW_GLYPHS : globalThis.WW_GLYPHS);
const _bigfont = (typeof require === 'function') ? require('../src/bigfont')
  : (typeof window !== 'undefined' ? window.WW_BIGFONT : globalThis.WW_BIGFONT);
const _layout = (typeof require === 'function') ? require('../src/layout')
  : (typeof window !== 'undefined' ? window.WW_LAYOUT : globalThis.WW_LAYOUT);
// The Z80-native contour engine (marching-squares + Bresenham). Its ENGINE fragment is
// appended to CODE below and runs in HIGH RAM (see the LD SP move in `main`); the render
// hooks CALL ct_run/ct_emit when a TEMP/PRESSURE tile carries corner bytes.
const _contour = (typeof require === 'function') ? require('./z80-contour')
  : (typeof window !== 'undefined' ? window.WW_Z80CONTOUR : globalThis.WW_Z80CONTOUR);

// Timing note: the receive counting loop `INC B / IN A,($FE) / RLA / JR C` is
// ~31 T-states/iteration; width classes 0/1/START are 380/950/1600 T-states, so
// ~12/30/52 iterations. Thresholds 20 and 40 sit in the wide gaps. Transmit
// loops are `DEC C / JR NZ` (~16 T/iter); iteration counts chosen to land inside
// the gateway's width windows (see src/tapebus.js FAST timings).

const CODE = `
  ORG 0x6B00
; FS2 T15: the block-font table (src/bigfont.js FONT_BYTES) lives in FREE low scratch
; RAM (the 0x7000 code image already sits ~20 bytes under the 0x7ff8 stack, so the
; 222-byte table can't ride in the image). The loader pokes it at FONTADDR the same way
; it seeds the land mask at 0x6000 — see listener.FONT / gateway load. Address is well
; clear of the land mask (0x6000..0x62FF) and the config bytes (0x6300..0x630A).
FONTTAB EQU 0x6400
FONTRAW EQU 0x6760
BANDTAB EQU 0x6500
STCYC_PH EQU 0x6800
STMAJ_PH EQU 0x6900
LF16TAB EQU 0x6A00
ct_hook EQU 0x4C00      ; contour engine entry (assembled separately, poked at CONTOUR_ORG)
; ================= entry =================
main:
  DI
  LD SP, 0xBF00         ; relocate the stack into high RAM (0x8000..0xBFFF is real, non-
                        ; aliasing RAM here) so the contour engine + its buffers can ride
                        ; ABOVE the old 0x7ff8 image ceiling. The listener owns execution
                        ; after DI (no ROM/NMI), so repointing SP is safe; never restored.
  LD A,0
  OUT (0xFD),A          ; NMI generator off (FAST) -> undisturbed timing
  LD HL,(0x400C)        ; D_FILE system variable -> display file pointer
  INC HL                ; skip leading 0x76 -> F+1
  LD (DFPTR),HL
hunt:
  CALL readsym
  CP 2
  JR NZ, hunt           ; wait for a START pulse
  CALL readbyte         ; ADDR
  LD (RXADDR),A
  LD A,(MYADDR)
  LD C,A
  LD A,(RXADDR)
  CP C
  JR NZ, hunt           ; not our tile -> resume hunting for next START
  CALL readbyte         ; LEN
  LD (LENV),A
  LD C,A                ; sum = ADDR + LEN
  LD A,(RXADDR)
  ADD A,C
  LD (SUMV),A
  LD A,(LENV)
  LD C,A                ; C = payload byte count (preserved across readbyte)
  LD HL, PBUF
ploop:
  CALL readbyte         ; payload byte (preserves C,HL)
  LD (HL),A
  INC HL
  LD B,A                ; sum += byte
  LD A,(SUMV)
  ADD A,B
  LD (SUMV),A
  DEC C
  JR NZ, ploop
  CALL readbyte         ; received checksum
  LD B,A
  LD A,(SUMV)
  CP B
  JP NZ, do_nak
; ---- checksum OK: expand + draw + ACK ----
  LD A,(PBUF)
  LD (0x6300),A         ; temperature byte
  LD A,(PBUF+1)
  LD (0x6301),A         ; precip flag
; default the higher-layer bytes; copy from the payload only if the frame carried
; them (shorter frames guard downward). PAGEV defaults to 0xFF = "legacy, no page".
  XOR A
  LD (0x6303),A         ; weather category
  LD (0x6304),A         ; sea state
  LD (0x6305),A         ; wind (km/h)
  LD (0x6306),A         ; cyclone byte (tier|pos|south|animate); 0 -> no marker
  LD (0x6307),A         ; isotherm edge mask (radar); 0 -> none
  LD (0x6309),A         ; wind direction octant
  LD (0x630A),A         ; cyclone-periphery band code; 0 -> no band
  LD (TERMV),A          ; all-page terminator/night/ice primitive; 0 -> none
  LD (RADARV),A         ; radar flag off
  LD (SEACONTOUR),A     ; sea-contour flag off (PRESSURE page only)
  LD (SATMODE),A        ; satellite-mode flag off (SATELLITE page only) — reset every frame
  LD (SATNIGHT),A       ; night-side hatch flag off unless byte6 bit4 is set
  LD (PHASEV),A         ; animation phase 0
  LD (PTRAIL),A         ; FS2 T9: no name/pressure trailer (default)
  LD (PANCH),A          ; FS2 sea-bias: no plate anchor (default; a corner/field frame
                        ; skips pt_trailer entirely, so this per-frame reset is the guard)
  LD (PHENON),A         ; FS7: phen list absent (default) -> legacy big glyph
  LD (PHENCNT),A        ; FS7: phen mark count 0
  LD A,0xFF
  LD (0x6308),A         ; PAGEV = legacy (no page byte in this frame)
  LD A,(LENV)
  CP 3
  JR C, do_render       ; LEN<3 -> no cat/sea/wind/cyc
  LD A,(PBUF+2)
  LD (0x6303),A
  LD A,(LENV)
  CP 4
  JR C, do_render       ; LEN<4 -> category only
  LD A,(PBUF+3)
  LD (0x6304),A
  LD A,(LENV)
  CP 5
  JR C, do_render       ; LEN<5 -> no wind
  LD A,(PBUF+4)
  LD (0x6305),A
  LD A,(LENV)
  CP 6
  JR C, do_render       ; LEN<6 -> no cyclone byte
  LD A,(PBUF+5)
  LD (0x6306),A
  LD A,(LENV)
  CP 7
  JR C, do_render       ; LEN<7 -> classic (temp grey fill, == BASIC oracle)
  LD A,(PBUF+6)
  LD (0x6307),A         ; isotherm edge mask
  LD A,1
  LD (RADARV),A         ; LEN>=7 -> radar mode (legacy 7-byte frame)
  LD A,(LENV)
  CP 8
  JR C, do_render       ; LEN<8 -> no page byte
  LD A,(PBUF+7)
  LD (0x6308),A         ; page id (teletext view)
  LD A,(LENV)
  CP 9
  JR C, do_render       ; LEN<9 -> no wind direction
  LD A,(PBUF+8)
  LD (0x6309),A         ; wind direction octant
  LD A,(LENV)
  CP 10
  JR C, do_render       ; LEN<10 -> no periphery band
  LD A,(PBUF+9)
  LD (0x630A),A         ; cyclone-periphery band code
  LD A,(LENV)
  CP 11
  JR C, do_render       ; LEN<11 -> no TERMV/trailer
  LD A,(PBUF+10)
  LD (TERMV),A          ; all-page day/night/terminator primitive
; FS7: past byte 10 the frame carries EITHER the FS2 name/pressure trailer OR the
; phen list — MUTUALLY EXCLUSIVE per tile, discriminated by TIER. Done in a
; subroutine so the LEN-guard cascade above keeps do_render within JR range.
  CALL parsetrailer
do_render:
  CALL render
  LD A,1
  CALL sendack          ; ACK
  LD A,0xA1
  LD (STATUS),A         ; done marker (drawn + acked)
  LD A,(0x6306)
  AND 0x40              ; ANIMATE bit set? (top-N cyclone, capped by the gateway)
  JR NZ, anim          ; animated cyclone -> spin the spiral
; T14: a WEATHER-page THUNDER tile also free-runs so the machine can blink its bolt
; glyph on-machine (the render phase toggles the glyph ink). PAGEV(0x6308)==WEATHER(1)
; and the category (PBUF+2 — 0x6303 was zeroed by the pg_weather fill) == THUNDER(6).
  LD A,(0x6308)
  CP 1                  ; WEATHER page?
  JR NZ, do_halt
; FS7 T1 known-limitation (deferred to T11): the blink loop is gated on the tile's
; CENTRE category (PBUF+2). A THUNDER micro-mark coming from a SUB-TILE sample on a
; tile whose centre category isn't THUNDER won't drive this loop, so that sub-sample
; bolt renders steady rather than blinking. Phase-0 bytes are unaffected (JS==Z80).
  LD A,(PBUF+2)
  CP 6                  ; THUNDER? -> free-run (blink the bolt)
  JR Z, anim
  CP 10                 ; EMERGENCY FIRE glyph? -> free-run (blink the flame pictogram)
  JR Z, anim
  LD A,(0x6307)         ; byte6 bit5 = WILDFIRE free-run: flicker the flame (ember persists,
  AND 0x20              ; solid flame cells blink off on odd phases via stampphen's bit7 mask)
  JR NZ, anim
  JR do_halt
; ---- animated cyclone / blinking thunder: the machine stays RUNNING and re-renders
;      in its own loop (delay first, so the just-drawn phase-0 frame is stable to
;      sample, then advance one phase). The spiral spins 45deg/phase; the THUNDER
;      glyph toggles ink on/off with (phase&1). ~3.8 steps/sec on a 3.25MHz ZX81. ----
anim:
  LD BC, 0x8000
anim_dly:
  DEC BC
  LD A,B
  OR C
  JR NZ, anim_dly
  LD A,(PHASEV)
  INC A
  AND 3
  LD (PHASEV),A
  LD A,0xA3
  LD (STATUS),A         ; "rendering" — display file is mid-redraw, do not sample
  CALL render
  LD A,0xA2
  LD (STATUS),A         ; "phase ready" — sample the display file now
  JR anim
do_halt:
  HALT

; ================= FS7: parse the trailer (phen list / name-pressure) =========
; LEN>11 carries EITHER a wall FS2 name/pressure trailer or a phen list, after TERMV.
; tier>=CYCLONE -> FS2 name/pressure trailer (pressure at PBUF+11,
; nameLen at PBUF+12, LEN>=13); tier<CYCLONE -> phen list (count at PBUF+11,
; triples from PBUF+12, LEN>=12). NO
; variable-offset arithmetic — the discriminator is the cyclone byte's tier bits.
parsetrailer:
; CORNERS discriminator: on TEMP (page 0) / PRESSURE (page 5) a set byte6 bit4 means
; PBUF+11..14 are the four contour corner bytes (consumed by ct_hook), NOT an FS2 name/
; pressure trailer or a phen list -> skip trailer parsing entirely. Page-gated because
; bit4 is the night flag on SATELLITE. Legacy frames (no corners) fall straight through.
  LD A,(0x6308)         ; PAGEV
  CP 5                  ; PRESSURE?
  JR Z, pt_corner_chk
  OR A                  ; TEMP == page 0?
  JR NZ, pt_scan        ; any other page -> normal trailer parse
pt_corner_chk:
  LD A,(0x6307)
  AND 0x10              ; CORNERS flag (byte6 bit4)
  RET NZ                ; corners present -> no trailer/list on this tile
pt_scan:
  LD A,(LENV)
  CP 12
  RET C                 ; LEN<12 -> TERMV only, no trailer/list
  LD A,(0x6306)         ; cyclone byte
  AND 0x30              ; tier bits4-5 in place (0x20=CYCLONE, 0x30=MAJOR)
  CP 0x20
  JR NC, pt_trailer     ; tier>=CYCLONE -> name/pressure trailer
  LD A,(LENV)           ; tier<CYCLONE -> phen list?
  CP 12
  RET C                 ; LEN<12 -> legacy frame (no phen -> big-glyph fallback)
  LD A,1
  LD (PHENON),A         ; phen list present (modern micro-mark frame)
  LD A,(PBUF+11)
  LD (PHENCNT),A        ; phen mark count (0..PHEN_MAX); triples at PBUF+12..
; FIRE NAME after the phen triples (fire tile only, byte6 bit5). nameRow then
; nameLen at PBUF + 12 + PHENCNT*3, then that many ZX codes -> copied to
; FIRENAMEROW / FIRENAMELEN / FIRENAME.
  XOR A
  LD (FIRENAMELEN),A     ; default: no fire name
  LD (FIRENAMEROW),A
  LD A,(0x6307)
  AND 0x20
  RET Z                  ; not a fire tile
  LD A,(PHENCNT)         ; offset = 12 + count*3
  LD B,A
  ADD A,A
  ADD A,B
  ADD A,12
  LD B,A                 ; B = offset of the fire-name row byte
  LD A,(LENV)
  CP B
  RET C                  ; LEN < offset -> no fire name
  RET Z                  ; LEN == offset -> no byte at offset
  LD HL, PBUF            ; HL = PBUF + offset
  LD A,L
  ADD A,B
  LD L,A
  JR NC, pt_fn1
  INC H
pt_fn1:
  LD A,(HL)              ; fire nameRow (caption top cell row)
  LD (FIRENAMEROW),A
  INC HL
  LD A,(HL)              ; fire nameLen
  LD (FIRENAMELEN),A
  OR A
  RET Z
  LD B,A
  INC HL
  LD DE, FIRENAME        ; copy the ZX name codes
pt_fncopy:
  LD A,(HL)
  LD (DE),A
  INC HL
  INC DE
  DJNZ pt_fncopy
  RET
pt_trailer:
  LD A,(LENV)
  CP 13
  RET C                 ; LEN<13 -> no FS2 name/pressure trailer
  LD A,1
  LD (PTRAIL),A         ; trailer present
  LD A,(PBUF+11)
  LD (PRESSV),A         ; min-pressure byte (hPa = 850 + byte)
  LD A,(PBUF+12)
  LD (NAMELEN),A        ; name length (0..10); codes at PBUF+13..
; SEA-BIAS PLATE ANCHOR (owner 2026-07-24): a NAMED trailer may carry 2 extra bytes after
; the name codes — [13+n] = plate centre col, [14+n] = name top row — host-picked from
; the coastline mask so the caption sits over water. LEN-gated: an old frame without
; them (LEN == 13+n) falls back to the legacy eye-opposite placement, byte-identical.
  XOR A
  LD (PANCH),A          ; default: no anchor
  LD A,(NAMELEN)
  OR A
  RET Z                 ; unnamed -> no anchor bytes ever
  ADD A,15              ; need LEN >= 13 + n + 2
  LD B,A
  LD A,(LENV)
  CP B
  RET C                 ; no anchor bytes on this frame
  LD A,(NAMELEN)
  ADD A,13
  LD HL, PBUF           ; HL = PBUF + 13 + n
  ADD A,L
  LD L,A
  JR NC, pt_anc1
  INC H
pt_anc1:
  LD A,(HL)
  LD (PLAX),A           ; plate centre col
  INC HL
  LD A,(HL)
  LD (PLAY),A           ; name top row
  LD A,1
  LD (PANCH),A
  RET
do_nak:
  LD A,0
  CALL sendack          ; NAK
  LD A,0x15
  LD (STATUS),A         ; NAK marker (for observability)
  JP hunt               ; await retransmit

; ================= receive one symbol =================
; returns A = 0 (short), 1 (long), 2 (START). Clobbers A,B.
readsym:
rs_wl:
  IN A,(0xFE)
  RLA                   ; EAR (bit7) -> carry
  JR C, rs_wl           ; still high -> wait for a clean low first
rs_wh:
  IN A,(0xFE)
  RLA
  JR NC, rs_wh          ; wait for rising edge
  LD B,0
rs_cnt:
  INC B
  IN A,(0xFE)
  RLA
  JR C, rs_cnt          ; count while high
  LD A,B
  CP 40
  JR NC, rs_start
  CP 20
  JR NC, rs_one
  XOR A
  RET
rs_one:
  LD A,1
  RET
rs_start:
  LD A,2
  RET

; ================= receive one byte (8 symbols, MSB first) =================
; returns A = byte. Clobbers A,B,D,E. Preserves C,HL.
readbyte:
  LD D,8
  LD E,0
rb_loop:
  SLA E
  CALL readsym
  RRA                   ; bit -> carry
  JR NC, rb_skip
  INC E
rb_skip:
  DEC D
  JR NZ, rb_loop
  LD A,E
  RET

; ================= HL = HL + DE (manual: no ADD HL,rr / ADC on this assembler) =
; Clobbers A. Preserves DE.
addHLDE:
  LD A,L
  ADD A,E
  LD L,A
  LD A,0
  JR NC, ahd1
  LD A,1
ahd1:
  ADD A,D
  ADD A,H
  LD H,A
  RET

; ================= render tile into display file =================
; Dispatch on PAGEV (0x6308): 0xFF = legacy stacked render (byte-identical to the
; BASIC oracle / all prior proofs); 0..4 = a single-variable teletext page. Each
; page sets the fill parameters (SHADE/PWET/CAT/SEA/RADARV) then reuses the shared
; cell loop, adds its page stamp (glyph/arrow), and always overlays the cyclone.
render:
  XOR A
  LD (SMOOTHV),A        ; smooth-temp off by default; the TEMP page re-enables per bit7
  LD (GRADV),A          ; within-tile gradient off by default
  LD A,(0x6308)
  CP 0xFF
  JP Z, render_legacy
; ---- paged render ----
  XOR A
  LD (RADARV),A
  LD (SEACONTOUR),A
  LD (SATMODE),A
  LD (PWET),A
  LD A,1
  LD (SHADE),A          ; default: dim land tint
  LD A,(0x6308)
  CP 6
  JP Z, pg_satellite
  CP 5
  JP Z, pg_pressure
  CP 4
  JP Z, pg_radar
  CP 3
  JP Z, pg_sea
  CP 1
  JP Z, pg_weather
  CP 2
  JP Z, pg_wind
; ---- page 0: TEMP — temperature shade/stipple + isotherm edges over land ----
  CALL calcshade
; smooth-temp: 0x6307 bit7 selects the Bayer-dithered fill (finer perceived shades).
; Precompute LF16V = LF16TAB[centre byte] once per tile; the cell loop dithers.
  LD A,(0x6307)
  AND 0x80
  JR Z, tsm_done
  LD A,1
  LD (SMOOTHV),A
  LD HL,LF16TAB
  LD A,(0x6300)
  LD E,A
  LD D,0
  CALL addHLDE
  LD A,(HL)
  LD (LF16V),A
; within-tile gradient: on a smooth TEMP frame the (unused) precip/wind slots carry the
; signed per-cell gradient steps gx8=0x6301, gy8=0x6305. GRADV if either is nonzero;
; precompute NW32 = LF16V*32 - gx8*16 - gy8*12 once so the cell loop only does adds.
  LD A,(0x6301)
  LD (GX8V),A
  LD A,(0x6305)
  LD (GY8V),A
  LD B,A
  LD A,(GX8V)
  OR B
  LD (GRADV),A
  OR A
  JR Z, tsm_done
  CALL grad_setup
tsm_done:
  LD A,1
  LD (RADARV),A
  XOR A
  LD (0x6303),A         ; CAT = CLEAR
  LD (0x6304),A         ; SEA = CALM (blank)
  CALL fill
  CALL ct_hook         ; marching-squares isotherm curve (when this tile carries corners)
  CALL stampphen       ; optional symbolic isotherm strokes + quantity labels
  CALL pg_cyc          ; cyclone stamps first (RET), then the number on top
  LD A,(0x6307)
  AND 0x40             ; ISO bit6 = draw the temperature reading (live TEMP page)
  CALL NZ, stamptemp
  CALL stamplabels     ; on-contour labels from the LEN 37+3N field-frame tail (last, like the reading)
  RET
pg_sea:                 ; SEA — machine-rendered sea-state texture over ocean
  XOR A
  LD (0x6303),A
  LD A,(0x6304)
  CP 3
  JR NC, pg_sea_hazard
  XOR A
  LD (0x6304),A         ; SEA page is hazards-only: calm/light/moderate stay quiet
pg_sea_hazard:
  CALL fill
  CALL stampphen       ; optional curved terminator marks
  JP pg_cyc
pg_weather:             ; WEATHER — synthesis pictograms/H-L marks (modern) / big glyph (legacy)
  LD A,(0x6304)         ; sea byte carries the wildfire-smoke density (0..3) on WEATHER
  AND 0x03
  LD (SMOKEV),A         ; save before the sea byte is blanked below
  XOR A
  LD (0x6303),A
  LD (0x6304),A         ; blank sea
  CALL fill
  CALL pgw_smoke        ; wildfire-smoke diagonal hatch over background cells (byte-exact to texture.js)
; ISO bit6 = a HOT/COLD numeric marker: stamp the tile temperature reading (big white
; digits, reusing the TEMP-page routine) INSTEAD of a pictogram, then done.
  LD A,(0x6307)
  AND 0x40
  JR Z, pgw_glyph
  CALL stamptemp
  JP pg_cyc
pgw_glyph:
; FS7: modern PHENON frames preserve empty lists as intentional blanks. Non-empty
; frames draw only the phen-carried synthesis pictograms/H-L marks; legacy big
; category glyphs are for non-modern frames only. Byte-exact to texture.js.
  LD A,(PHENON)
  OR A
  JR NZ, pgw_phen
  CALL stampglyph
  JP pg_cyc
pgw_phen:
  CALL stampphen
  CALL stampfirename
  JP pg_cyc
; ---- wildfire-smoke diagonal hatch (WEATHER) ------------------------------------
; A one-way diagonal lattice over BACKGROUND cells (BLANK 0x00 / TINT 0x01) only, density
; by SMOKEV (1 light / 2 med / 3 heavy). Byte-exact to src/texture.js tileCells smoke pass:
;   on = lvl1:(x+y)&3==0 | lvl2:(x+y)&1==0 | lvl3:(x+y)&3!=1
; Same dest addressing as fill (DFPTR, 32 cols, stride 33). Clobbers A,B,C,DE,H.
pgw_smoke:
  LD A,(SMOKEV)
  AND 0x03
  RET Z                 ; no smoke -> nothing
  LD DE,(DFPTR)         ; dest = F+1 (fill's base)
  LD B,0                ; Y
psm_row:
  LD C,0                ; X
psm_col:
  LD A,B
  ADD A,C              ; A = x+y
  LD H,A               ; H = x+y
  LD A,(SMOKEV)
  CP 1
  JR Z, psm_l1
  CP 2
  JR Z, psm_l2
  LD A,H               ; level 3: off iff (x+y)&3 == 1
  AND 0x03
  CP 1
  JR Z, psm_skip
  JR psm_hatch
psm_l1:
  LD A,H               ; level 1: on iff (x+y)&3 == 0
  AND 0x03
  JR NZ, psm_skip
  JR psm_hatch
psm_l2:
  LD A,H               ; level 2: on iff (x+y)&1 == 0
  AND 0x01
  JR NZ, psm_skip
psm_hatch:
  LD A,(DE)            ; only hatch background cells
  CP 0x00
  JR Z, psm_set
  CP 0x01
  JR NZ, psm_skip
psm_set:
  LD A,0x80            ; INV (solid inverse block)
  LD (DE),A
psm_skip:
  INC DE
  INC C
  LD A,C
  CP 32
  JR NZ, psm_col
  INC DE               ; stride 33: skip the row's trailing 0x76
  INC B
  LD A,B
  CP 24
  JR NZ, psm_row
  RET
pg_wind:                ; WIND — machine-rendered chevrons over the map base
  LD A,1
  LD (RADARV),A
  XOR A
  LD (0x6303),A
  LD (0x6304),A
  CALL fill
  CALL stampwind
  CALL stampphen       ; optional symbolic isotach strokes/labels/direction hints
  JP pg_cyc
pg_radar:               ; RADAR — isotherm contours + moving precip (== legacy radar)
  LD A,1
  LD (RADARV),A
  XOR A
  LD (PWET),A           ; precip is the browser motion layer; phase-0 clear cells
                        ; carry no precip-OR (matches texture.js radar path, iso!=null)
  CALL fill             ; CAT/SEA kept as received; SHADE=1 (tint)
  JP pg_cyc
pg_pressure:            ; PRESSURE — shade/sea texture + global isobar contour
  CALL calcshade
  LD A,1
  LD (RADARV),A
  LD (SEACONTOUR),A
  XOR A
  LD (0x6303),A         ; CAT = CLEAR
  CALL fill
  CALL ct_hook         ; marching-squares isobar curve (when this tile carries corners)
  CALL stampphen       ; optional symbolic isobar strokes + pressure labels
  CALL pg_cyc          ; band/spiral/name/min-pressure stamps (shared tail, RET)
  CALL stamplabels     ; on-contour MB labels LAST (mirrors texture.js draw order:
                       ; stampPressNumber after every cyclone stamp)
  RET
pg_cyc:
  CALL stampband
  CALL stampcyc
  CALL stampname        ; NAME first, then pressure (mirrors texture.stampNamePressure: the
  CALL stamppress       ; pressure is drawn LAST so it wins the 1-row overlap under the 2x name)
                        ; (ordinary L/H block-font centre removed — owner QC: it read as a
                        ; little letter inside the conventional H/L; centre now draws only
                        ; as the larger 4x7 conventional H/L on the phen path)
  RET

pg_satellite:           ; SATELLITE (FS7-T5) — cloud-cover greyscale + day/night terminator, GLOBAL
  LD A,1
  LD (SATMODE),A        ; cellbyte short-circuits straight to cb_sat (ignores land/sea)
  CALL calcsatlvl       ; SATLVL <- band(0x6300) (0x6300 repurposed: raw cloud% on this page)
  LD A,(TERMV)
  OR A
  JR NZ, ps_term
  LD A,(0x6307)          ; fallback for older LEN10 satellite frames
ps_term:
  AND 0x10              ; bit4 = night
  LD (SATNIGHT),A
  CALL fill
  CALL stampphen       ; curved day/night terminator, shared with every page
  JP pg_cyc             ; cyclone spirals ride along on the satellite page too

; ---- SATLVL = cloud-cover band for 0x6300 (== L.cloudLevel: <25/<50/<75/else) ----
calcsatlvl:
  LD A,(0x6300)
  LD B,0                ; band 0 default (clear)
  CP 25
  JR C, csl2
  LD B,1
  CP 50
  JR C, csl2
  LD B,2
  CP 75
  JR C, csl2
  LD B,3
csl2:
  LD A,B
  LD (SATLVL),A
  RET

render_legacy:
  LD A,(RADARV)
  OR A
  JR Z, rl_classic
  LD A,1
  LD (SHADE),A
  XOR A
  LD (PWET),A
  JR rl_fill
rl_classic:
  CALL calcshade
  LD A,(0x6301)
  LD (PWET),A
rl_fill:
  CALL fill
  CALL stampband
  CALL stampcyc
  CALL stamppress       ; FS2 T9/T15: min-pressure below the name, block font (LAST, phase-independent)
  CALL stampname        ; FS2 T9: name beside the spiral (LAST, phase-independent)
                        ; (ordinary L/H block-font centre removed — owner QC: it read as a
                        ; little letter inside the conventional H/L; centre now draws only
                        ; as the larger 4x7 conventional H/L on the phen path)
  RET

; ---- SHADE = dry temperature shade for 0x6300 (== BASIC ramp) ----
calcshade:
  LD A,(0x6300)
  LD B,1                ; shade 0x01 default
  CP 45
  JR C, cs2
  LD B,3
cs2:
  LD A,(0x6300)
  CP 60
  JR C, cs3
  LD B,7
cs3:
  LD A,(0x6300)
  CP 75
  JR C, cs4
  LD B,128
cs4:
  LD A,B
  LD (SHADE),A
  RET

; ---- smoothsh: smooth-temp dithered ramp char from LF16V + (XV,YV). Mirrors
;      L.smoothShade byte-for-byte: endpoints collapse to a solid ramp char, the
;      middle dithers between RAMP[lo-1] and RAMP[lo] via the 4x4 Bayer threshold.
;      Called only inside cellbyte (HL/DE/BC already saved), so it clobbers freely. ----
smoothsh:
  LD A,(GRADV)
  OR A
  JR Z, ss_flat
  CALL ss_grad           ; A = per-cell level (Increment 2 within-tile gradient)
  JR ss_have
ss_flat:
  LD A,(LF16V)           ; flat: single tile-centre level (Increment 1)
ss_have:
  LD (LF16C),A
  CP 17
  JR NC, ss_hichk
  LD A,0x01              ; LF16 <= 16 -> RAMP[0]
  RET
ss_hichk:
  LD A,(LF16C)
  CP 64
  JR C, ss_dith
  LD A,0x80              ; LF16 >= 64 -> RAMP[3]
  RET
ss_dith:
  LD A,(LF16C)
  AND 0x0F
  LD B,A                 ; B = frac (0..15)
  LD A,(LF16C)
  SRL A
  SRL A
  SRL A
  SRL A
  LD C,A                 ; C = lo (1..3)
  LD A,(YV)
  AND 3
  ADD A,A
  ADD A,A                ; (YV&3)*4
  LD D,A
  LD A,(XV)
  AND 3
  ADD A,D                ; A = Bayer index (0..15)
  LD HL,BAYER4
  LD E,A
  LD D,0
  CALL addHLDE           ; HL -> BAYER4[index] (clobbers A, preserves DE/BC)
  LD A,(HL)
  LD E,A                 ; E = m (threshold)
  LD A,B                 ; frac
  CP E
  JR C, ss_lo            ; frac < m  -> lo
  JR Z, ss_lo            ; frac == m -> lo (strict >)
  INC C                  ; frac > m  -> lo+1
ss_lo:
  LD A,C
  DEC A                  ; ramp index lvl-1 (0..3)
  LD HL,RAMPTAB
  LD E,A
  LD D,0
  CALL addHLDE
  LD A,(HL)
  RET

; ---- mac: HL += signed(A) * B (B unsigned, 0..31). Shift-add (no ADD HL,rr / ADC on
;      this assembler, so 16-bit add goes through addHLDE). Clobbers A,B,C,DE; result HL. ----
mac:
  LD E,A
  LD D,0
  AND 0x80
  JR Z, mac_pe
  LD D,0xFF              ; sign-extend the multiplicand into DE (bit7 set)
mac_pe:
  LD A,B
  OR A
  RET Z
mac_lp:
  LD A,B
  AND 1
  JR Z, mac_sh
  CALL addHLDE           ; HL += DE (clobbers A, preserves DE,B)
mac_sh:
  SLA E
  RL D                   ; DE <<= 1 (double the multiplicand)
  SRL B                  ; next multiplier bit
  LD A,B
  OR A
  JR NZ, mac_lp
  RET

; ---- grad_setup: NW32 = LF16V*32 - gx8*16 - gy8*12 (level*32 at cell 0,0). ----
grad_setup:
  LD A,(LF16V)
  LD L,A
  LD H,0                 ; HL = LF16V
  SLA L
  RL H
  SLA L
  RL H
  SLA L
  RL H
  SLA L
  RL H
  SLA L
  RL H                   ; HL = LF16V * 32
  LD A,(GX8V)            ; A = -gx8 (negate: 0 - gx8)
  LD B,A
  XOR A
  SUB B
  LD B,16
  CALL mac               ; HL += (-gx8)*16
  LD A,(GY8V)
  LD B,A
  XOR A
  SUB B
  LD B,12
  CALL mac               ; HL += (-gy8)*12
  LD A,L
  LD (NW32),A
  LD A,H
  LD (NW32+1),A
  RET

; ---- ss_grad: A = clamp(NW32 + gx8*XV + gy8*YV, 512..2048) >> 5  (per-cell level). ----
ss_grad:
  LD A,(NW32)
  LD L,A
  LD A,(NW32+1)
  LD H,A                 ; HL = NW32
  LD A,(XV)
  LD B,A
  LD A,(GX8V)
  CALL mac               ; HL += gx8 * XV
  LD A,(YV)
  LD B,A
  LD A,(GY8V)
  CALL mac               ; HL += gy8 * YV
  ; clamp HL (signed) to [0x0200, 0x0800]
  LD A,H
  CP 0x80
  JR NC, gc_setlo        ; negative -> 512
  CP 0x08
  JR C, gc_chklo
  JR NZ, gc_sethi        ; H in 9..7F -> 2048
  LD A,L
  OR A
  JR Z, gc_ok            ; exactly 0x0800 = 2048 -> in range
gc_sethi:
  LD HL,0x0800
  JR gc_ok
gc_chklo:
  LD A,H
  CP 0x02
  JR NC, gc_ok           ; H in 2..7 -> >= 512, in range
gc_setlo:
  LD HL,0x0200
gc_ok:
  SRL H
  RR L
  SRL H
  RR L
  SRL H
  RR L
  SRL H
  RR L
  SRL H
  RR L                   ; HL >>= 5  (0x0200->16 .. 0x0800->64)
  LD A,L
  RET

; ---- celladdr: HL = DFPTR + STYV*33 + STXV (one display-file cell). Clobbers A,B,DE ----
celladdr:
  LD HL,(DFPTR)
  LD A,(STYV)
  OR A
  JR Z, ca_col
  LD B,A
  LD DE,33
ca_row:
  CALL addHLDE
  DJNZ ca_row
ca_col:
  LD A,(STXV)
  LD E,A
  LD D,0
  CALL addHLDE
  RET

; ---- stamptemp: the tile's temperature (°C = tempByte-50) as big WHITE digits knocked
;      out of a black plate, centred. Mirrors src/texture.js stampTempNumber byte-for-
;      byte: clear a padded box, draw the block-font digits (+ minus bar), invert the box.
;      Reuses the stamppress digit-split + stampbigtext writer. ----
stamptemp:
  LD A,16
  LD (STCXV),A           ; default anchor: plate centre col 16
  LD A,11
  LD (STCYV),A           ; default digit row 11 (plate rows 10..14)
  LD A,(0x6300)
  SUB 50                 ; A = °C (signed)
; ---- st_core: stamp signed °C (in A) as the white-on-black plate anchored at
;      STCXV (plate centre col) / STCYV (digit row; plate rows STCYV-1..STCYV+3).
;      Shared by the centred reading above (falls through) and the on-contour label
;      loop (stamplabels). Mirrors texture.js stampTempNumber(cells, byte, cx, cyd). ----
st_core:
  LD B,0                 ; B = neg flag
  LD C,A
  AND 0x80
  JR Z, st_pos
  LD B,1
  XOR A
  SUB C
  LD C,A                 ; C = |°C|
st_pos:
  LD A,C
  CP 100
  JR C, st_split
  LD C,99                ; clamp magnitude to 99 (2 digits)
st_split:
  LD A,C
  LD D,0                 ; D = tens
st_tn:
  CP 10
  JR C, st_tnd
  SUB 10
  INC D
  JR st_tn
st_tnd:
  LD (ONESV),A
  LD A,D
  LD (TENSV),A
  LD A,(TENSV)
  OR A
  JR Z, st_one
  ADD A,28
  LD (DIGBUF),A
  LD A,(ONESV)
  ADD A,28
  LD (DIGBUF+1),A
  LD A,2
  JR st_nd
st_one:
  LD A,(ONESV)
  ADD A,28
  LD (DIGBUF),A
  LD A,1
st_nd:
  LD (NDIG),A
; ---- st_tail: shared plate writer. Entry point for callers that built DIGBUF /
;      NDIG themselves (fmt_press) — B must hold the neg flag (0 for unsigned). ----
st_tail:
  LD A,B
  LD (STNEGV),A          ; save neg flag
  LD A,(NDIG)
  ADD A,B                ; nchars = ndig + neg
  LD (NCHV),A
  LD C,A
  LD A,(STCXV)
  SUB C
  LD (STX0V),A           ; x0 = centre col - nchars (leftmost, incl minus)
; box: bx0 = x0-1, width = 2*nchars+2, rows 10..14
  DEC A
  LD (STBXV),A
  LD A,(NCHV)
  ADD A,A
  ADD A,2
  LD (STBWV),A
; --- clear the box to 0 (rows STCYV-1 .. STCYV+3) ---
  LD A,(STCYV)
  ADD A,4
  LD (STEYV),A           ; exclusive end row = digit row + 4
  LD A,(STCYV)
  DEC A
  LD (STYV),A
st_cly:
  LD A,(STBXV)
  LD (STXV),A
  LD A,(STBWV)
  LD (STCCV),A
st_clx:
  LD A,(STXV)
  CP 32
  JR NC, st_cln
  LD A,(STYV)
  CP 24
  JR NC, st_cln
  CALL celladdr
  XOR A
  LD (HL),A
st_cln:
  LD A,(STXV)
  INC A
  LD (STXV),A
  LD A,(STCCV)
  DEC A
  LD (STCCV),A
  JR NZ, st_clx
  LD A,(STYV)
  INC A
  LD (STYV),A
  LD B,A
  LD A,(STEYV)
  CP B
  JR NZ, st_cly
; --- minus bar (row STCYV+1) if negative ---
  LD A,(STNEGV)
  OR A
  JR Z, st_dig
  LD A,(STCYV)
  INC A
  LD (STYV),A
  LD A,(STX0V)
  LD (STXV),A
  CALL celladdr
  LD (HL),0x80
  LD A,(STX0V)
  INC A
  LD (STXV),A
  CALL celladdr
  LD (HL),0x80
st_dig:
; --- digits via the block font: PCOL = x0 (+2 if neg), PROW = 11 ---
  LD A,(STX0V)
  LD C,A
  LD A,(STNEGV)
  OR A
  JR Z, st_pcol
  LD A,C
  ADD A,2
  LD C,A
st_pcol:
  LD A,C
  LD (PCOL),A
  LD A,(STCYV)
  LD (PROW),A
  LD HL,DIGBUF
  LD (BIGSRC),HL
  LD A,(NDIG)
  LD (BIGCNT),A
  CALL stampbigtext
; --- invert the box -> white digits on black plate ---
  LD A,(STCYV)
  DEC A
  LD (STYV),A
st_ivy:
  LD A,(STBXV)
  LD (STXV),A
  LD A,(STBWV)
  LD (STCCV),A
st_ivx:
  LD A,(STXV)
  CP 32
  JR NC, st_ivn
  LD A,(STYV)
  CP 24
  JR NC, st_ivn
  CALL celladdr
  LD A,(HL)
  XOR 0x80
  LD (HL),A
st_ivn:
  LD A,(STXV)
  INC A
  LD (STXV),A
  LD A,(STCCV)
  DEC A
  LD (STCCV),A
  JR NZ, st_ivx
  LD A,(STYV)
  INC A
  LD (STYV),A
  LD B,A
  LD A,(STEYV)
  CP B
  JR NZ, st_ivy
  RET

; ---- stamplabels: on-contour TEMP labels from the LEN 37+3N label tail
;      (docs/TEMP-LABEL-PLAN.md Phase 2). PBUF+36 = count, then (x, y, levelByte)
;      triples: x = plate centre col, y = DIGIT row, levelByte = the isotherm's own
;      level value (°C+50). Placement is HOST intelligence (src/contour-labels.js);
;      the machine just formats each level byte (SUB 50 — the temp formatter) and
;      stamps st_core at the shipped anchor. A LEN<37 frame (plain LEN-36 field, a
;      corner tile, legacy) has no tail -> RET, so old frames render unchanged. ----
stamplabels:
  LD A,(0x6307)
  AND 0x10               ; CORNERS/FIELD flag — the tail only rides field frames
  RET Z
  LD A,(LENV)
  CP 37
  RET C                  ; no label tail on this frame
  LD A,(PBUF+36)
  AND 0x07               ; label count, sanity-capped
  RET Z
  LD (LBCNT),A
  LD HL, PBUF+37
  LD (LBPTR),HL
sl_loop:
  LD HL,(LBPTR)
  LD A,(HL)
  LD (STCXV),A           ; plate centre col
  INC HL
  LD A,(HL)
  LD (STCYV),A           ; digit row
  INC HL
  LD A,(HL)
  INC HL
  LD (LBPTR),HL
  LD (LBLVV),A           ; save the level byte — the page picks the formatter
  LD A,(0x6308)          ; PBUF page byte (PAGE.PRESSURE = 5)
  CP 5
  JR Z, sl_press
  LD A,(LBLVV)
  SUB 50                 ; levelByte -> signed °C (the TEMP formatter)
  CALL st_core
  JR sl_next
sl_press:
  LD A,(LBLVV)
  CALL fmt_press         ; levelByte -> unsigned millibars (950 + byte)
sl_next:
  LD A,(LBCNT)
  DEC A
  LD (LBCNT),A
  JR NZ, sl_loop
  RET

; ---- fmt_press: on-contour PRESSURE label formatter (stamplabels PRESSURE branch).
;      A = level byte (950-datum scale) -> millibars = 950 + A (950..1205), split
;      into 3-4 decimal digits in DIGBUF/NDIG, then the shared st_tail plate writer
;      with B=0 (unsigned — no minus glyph). Mirrors texture.js stampPressNumber
;      byte-for-byte; digit-split cloned from stamppress (datum 850 there, 950 here). ----
fmt_press:
  LD L,A
  LD H,0
  LD DE,950
  CALL addHLDE          ; HL = 950 + byte (950..1205)
  LD B,0                ; B = hundreds+thousands count (floor(mb/100), 9..12)
fp_hp:
  LD A,H
  OR A
  JR NZ, fp_hpsub       ; H>0 -> >=256 -> definitely >=100
  LD A,L
  CP 100
  JR C, fp_hpdone       ; L<100 -> remainder settled
fp_hpsub:
  LD A,L
  SUB 100
  LD L,A
  JR NC, fp_hpnc
  DEC H
fp_hpnc:
  INC B
  JR fp_hp
fp_hpdone:
  LD A,L                ; A = mb mod 100 (0..99); split into tens/ones
  LD C,0                ; C = tens
fp_tn:
  CP 10
  JR C, fp_tndone
  SUB 10
  INC C
  JR fp_tn
fp_tndone:
  LD (ONESV),A          ; ones digit (0..9)
  LD A,C
  LD (TENSV),A          ; tens digit (0..9)
  LD A,B
  CP 10
  JR C, fp_three        ; B<10 -> 3 digits (hundreds only)
  LD A,29               ; 28 + 1 -> thousands digit '1'
  LD (DIGBUF),A
  LD A,B
  SUB 10
  ADD A,28
  LD (DIGBUF+1),A       ; hundreds digit (B-10)
  LD A,(TENSV)
  ADD A,28
  LD (DIGBUF+2),A
  LD A,(ONESV)
  ADD A,28
  LD (DIGBUF+3),A
  LD A,4
  JR fp_nd
fp_three:
  LD A,B
  ADD A,28
  LD (DIGBUF),A         ; hundreds digit (9)
  LD A,(TENSV)
  ADD A,28
  LD (DIGBUF+1),A
  LD A,(ONESV)
  ADD A,28
  LD (DIGBUF+2),A
  LD A,3
fp_nd:
  LD (NDIG),A
  LD B,0                ; unsigned — st_tail reads B as the neg flag
  JP st_tail

; ---- the shared cell loop: 24x32 cells, coastline($6000) x payload -> display ----
fill:
  LD HL, 0x6000         ; land mask
  LD DE,(DFPTR)         ; dest = F+1
  XOR A
  LD (YV),A             ; Y = 0
frow:
  XOR A
  LD (XV),A             ; X = 0
  LD C,32               ; cols
fcol:
  LD A,(HL)
  LD (LANDV),A          ; 0 = sea, else land
  CALL cellbyte         ; -> A = display code (preserves HL,DE,C)
  LD (DE),A
  INC HL
  INC DE
  LD A,(XV)
  INC A
  LD (XV),A
  DEC C
  JR NZ, fcol
  INC DE                ; stride 33: skip the row's trailing 0x76
  LD A,(YV)
  INC A
  LD (YV),A
  CP 24
  JR NZ, frow
  RET

; ---- one cell -> display code. Reads LANDV/XV/YV/CAT($6303)/SEA($6304)/SHADE/
;      PWET. Returns A. Preserves HL,DE,BC (loop state). ----
cellbyte:
  PUSH HL
  PUSH DE
  PUSH BC
  LD A,(XV)
  LD B,A
  LD A,(YV)
  ADD A,B
  LD (SUM2),A           ; SUM2 = X + Y (for parity predicates)
  LD A,(SATMODE)
  OR A
  JP NZ, cb_sat         ; SATELLITE page: cloud cover over a faint land mask
  LD A,(LANDV)
  OR A
  JP Z, cb_sea
; ---- land: dispatch on weather category ----
  LD A,(0x6303)
  CP 2
  JP C, cb_base         ; CLEAR(0)/CLOUD(1) -> base (== BASIC)
  JP Z, cb_fog          ; FOG(2)
  CP 3
  JP Z, cb_drz          ; DRIZZLE(3)
  CP 4
  JP Z, cb_rain         ; RAIN(4)
  CP 5
  JP Z, cb_snow         ; SNOW(5)
  CP 6
  JP Z, cb_thu          ; THUNDER(6)
  JP cb_base            ; unknown -> base
cb_fog:                 ; ((x+y)&1)==0 -> grey veil (0x08) else temp shade
  LD A,(SUM2)
  AND 1
  JP NZ, cb_useshade
  LD A,8
  JP cb_landret
cb_drz:                 ; ((x+y)&3)==0 -> inverse (0x80) else temp shade  [sparse]
  LD A,(SUM2)
  AND 3
  JP NZ, cb_useshade
  LD A,128
  JP cb_landret
cb_rain:                ; ((x+y)&1)==0 -> inverse (0x80) else temp shade  [dense]
  LD A,(SUM2)
  AND 1
  JP NZ, cb_useshade
  LD A,128
  JP cb_landret
cb_snow:                ; (x&1)==0 && (y&1)==0 -> '*' (0x17) else temp shade
  LD A,(XV)
  AND 1
  JP NZ, cb_useshade
  LD A,(YV)
  AND 1
  JP NZ, cb_useshade
  LD A,0x17
  JP cb_landret
cb_thu:                 ; ((x+y)&1)==0 -> inverse (0x80) else storm grey (0x08)
  LD A,(SUM2)
  AND 1
  JP NZ, cb_thu_g
  LD A,128
  JP cb_landret
cb_thu_g:
  LD A,8
  JP cb_landret
cb_base:                ; temp shade, precip -> OR inverse when not already solid
  LD A,(PWET)
  OR A
  JP Z, cb_useshade
  LD A,(SHADE)
  CP 128
  JP NC, cb_useshade    ; already solid -> no precip bit
  ADD A,128
  JP cb_landret
cb_useshade:
  LD A,(SMOOTHV)
  OR A
  JR Z, cb_useshade_flat
  CALL smoothsh          ; smooth-temp: dither between the two bracketing RAMP chars
  JP cb_landret
cb_useshade_flat:
  LD A,(SHADE)
  JP cb_landret
; ---- sea: dispatch on sea state ----
cb_sea:
  LD A,(0x6304)
  OR A
  JP Z, cb_blank        ; CALM -> blank
  CP 4
  JP Z, cb_storm        ; STORM(4) -> inverse wave rows
  CP 1
  JP Z, cb_sea_l        ; LIGHT(1)
  CP 2
  JP Z, cb_sea_m        ; MODERATE(2)
  CP 5
  JP Z, cb_sea_nd       ; NODATA(5) -> vertical grey bars ("no signal")
; HIGH(3): keep the same readable 25% flecks; STORM carries the severe emphasis.
  LD A,(SUM2)
  AND 3
  JP NZ, cb_blank
  JP cb_wave
cb_sea_l:               ; ((x+y)&7)==0 -> wave else blank  [sparse]
  LD A,(SUM2)
  AND 7
  JP NZ, cb_blank
  JP cb_wave
cb_sea_m:               ; ((x+y)&3)==0 -> wave else blank
  LD A,(SUM2)
  AND 3
  JP NZ, cb_blank
  JP cb_wave
cb_sea_nd:              ; (x&1)==0 -> grey (0x08) else blank — missing data must
                        ; not read as calm; vertical bars occur in no real state
  LD A,(XV)
  AND 1
  JP NZ, cb_blank
  LD A,8
  JP cb_ret
cb_storm:               ; y&3==0 -> solid inverse band, else sparse wave flecks
  LD A,(YV)
  AND 3
  JP NZ, cb_storm_wave
  LD A,128
  JP cb_ret
cb_storm_wave:
  LD A,(SUM2)
  AND 3
  JP NZ, cb_blank
  JP cb_wave
cb_wave:
  LD A,9
  JP cb_ret
cb_blank:
  XOR A
cb_ret:                 ; sea path: A = final display code
  LD (RESV),A
; ---- sea-contour overlay: PRESSURE page only (isobars are a global field) ----
  LD A,(SEACONTOUR)
  OR A
  JR Z, cb_pop          ; not the PRESSURE page -> keep base sea texture
  CALL contour          ; A = contour glyph, or 0xFF if not on an active edge
  CP 0xFF
  JR Z, cb_pop
  LD (RESV),A           ; contour overrides the base on the boundary edge
cb_pop:
  LD A,(SATMODE)
  OR A
  JR NZ, ct_done         ; SATELLITE handles terminator/night/ice inside cb_sat
  LD A,(TERMV)
  AND 0x0F
  JR Z, ct_night
  LD B,A                  ; B = TERMV edge bits
  LD A,B
  AND 1                   ; N edge: top two character rows
  JR Z, ct_chk_s
  LD A,(YV)
  CP 2
  JR C, ct_term_inv
ct_chk_s:
  LD A,B
  AND 2                   ; S edge: bottom two character rows
  JR Z, ct_chk_w
  LD A,(YV)
  CP 22
  JR NC, ct_term_inv
ct_chk_w:
  LD A,B
  AND 4                   ; W edge: left two character columns
  JR Z, ct_chk_e
  LD A,(XV)
  CP 2
  JR C, ct_term_inv
ct_chk_e:
  LD A,B
  AND 8                   ; E edge: right two character columns
  JR Z, ct_night
  LD A,(XV)
  CP 30
  JR C, ct_night
ct_term_inv:
  LD A,8
  LD (RESV),A             ; grey machine-rendered terminator edge wins
  JR ct_done
ct_night:
  JR ct_done              ; non-SATELLITE pages show the terminator edge only; no hatch
ct_done:
  POP BC
  POP DE
  POP HL
  LD A,(RESV)
  RET
; ---- land return: in radar mode, overlay the isotherm contour on edge cells ----
cb_landret:
  LD (RESV),A           ; A = land base texture code
  LD A,(RADARV)
  OR A
  JR Z, cb_pop          ; classic mode -> keep base (byte-identical to BASIC path)
  CALL contour          ; A = contour glyph, or 0xFF if not on an active edge
  CP 0xFF
  JR Z, cb_pop
  LD (RESV),A           ; contour overrides the base on the boundary edge
  JR cb_pop

; ---- SATELLITE cell (FS7-T5): INVERTED video — dark earth, white clouds ----
; Mirrors src/texture.js satCell() EXACTLY (owner 2026-07-30: "the whole image
; should be inverted so clouds appear white against a dark earth"). Ignores LANDV
; entirely (a satellite photographs clouds over land AND sea alike). Reads
; SATNIGHT/SATLVL/SUM2; terminator edge bits are the low nibble of 0x6307.
cb_sat:
  LD A,128
  LD (RESV),A           ; bg default: solid ink (dark earth, land and sea alike)
  LD A,(TERMV)
  AND 0x20
  JR Z, cs_sheen
  XOR A
  LD (RESV),A           ; Antarctic ice sheet: bright, faintly textured
  LD A,(SUM2)
  AND 3
  JR NZ, cs_term
  LD A,8
  LD (RESV),A
  JR cs_term            ; skip cloud/night density entirely
cs_sheen:
  LD A,(SATNIGHT)
  OR A
  JR NZ, cs_lvl         ; night clear stays solid ink (terminator reads on clear sky)
  LD A,(SUM2)
  AND 7
  JR NZ, cs_lvl
  LD A,8
  LD (RESV),A           ; sparse daylight sheen -> GREY
cs_lvl:
  LD A,(SATLVL)
  CP 1
  JR Z, cs_l1
  CP 2
  JR Z, cs_l2
  CP 3
  JR Z, cs_l3
  JR cs_term            ; level 0 (clear) -> keep bg
cs_l1:                  ; thin scatter: (x+y)&3==0 -> GREY
  LD A,(SUM2)
  AND 3
  JR NZ, cs_term
  LD A,8
  LD (RESV),A
  JR cs_term
cs_l2:                  ; broken: (x+y)&1==0 -> GREY
  LD A,(SUM2)
  AND 1
  JR NZ, cs_term
  LD A,8
  LD (RESV),A
  JR cs_term
cs_l3:                  ; overcast deck: white, sparse GREY texture
  XOR A
  LD (RESV),A
  LD A,(SUM2)
  AND 3
  JR NZ, cs_term
  LD A,8
  LD (RESV),A
cs_term:                ; day/night terminator overlay (edge bits, low nibble of 0x6307)
  CALL contour
  CP 0xFF
  JP Z, cb_pop
  LD (RESV),A
  JP cb_pop

; ================= isotherm contour glyph =================
; Return A = the contour glyph for cell (XV,YV) given the edge mask at 0x6307, or
; 0xFF if the cell isn't on an active boundary edge. Mirrors src/texture.js
; contourGlyph() exactly. C accumulates edge flags (bit0=N,1=S,2=W,3=E). Two
; abutting tiles each draw their own seam edge, so a boundary reads as one line.
; Clobbers A,C.
contour:
  LD C,0
  LD A,(0x6307)
  AND 1                 ; N edge active AND y==0 ?
  JR Z, cn_s
  LD A,(YV)
  OR A
  JR NZ, cn_s
  LD A,C
  OR 1
  LD C,A
cn_s:
  LD A,(0x6307)
  AND 2                 ; S edge active AND y==23 ?
  JR Z, cn_w
  LD A,(YV)
  CP 23
  JR NZ, cn_w
  LD A,C
  OR 2
  LD C,A
cn_w:
  LD A,(0x6307)
  AND 4                 ; W edge active AND x==0 ?
  JR Z, cn_e
  LD A,(XV)
  OR A
  JR NZ, cn_e
  LD A,C
  OR 4
  LD C,A
cn_e:
  LD A,(0x6307)
  AND 8                 ; E edge active AND x==31 ?
  JR Z, cn_pick
  LD A,(XV)
  CP 31
  JR NZ, cn_pick
  LD A,C
  OR 8
  LD C,A
cn_pick:
  LD A,C
  AND 3                 ; horizontal edge (N|S) present?
  JR Z, cn_vert
  LD A,C
  AND 12                ; ...and a vertical edge too -> corner node
  JR Z, cn_horiz
  LD A,0x80
  RET
cn_horiz:
  LD A,C
  AND 1
  JR Z, cn_south
  LD A,0x03             ; N edge -> top-half line
  RET
cn_south:
  LD A,0x83             ; S edge -> bottom-half line
  RET
cn_vert:
  LD A,C
  AND 4
  JR Z, cn_east
  LD A,0x05             ; W edge -> left-half line
  RET
cn_east:
  LD A,C
  AND 8
  JR Z, cn_none
  LD A,0x85             ; E edge -> right-half line
  RET
cn_none:
  LD A,0xFF
  RET

; ================= stamp big 16x12 bitmap (WEATHER glyph / WIND chevrons) =========
; HL -> 24-byte bitmap (2 bytes/row hi,lo, 12 rows). Set bits paint 0x80; 0-bits
; are transparent (the plain land tint shows through). Centred at cell (16,12):
; top-left = DFPTR + 6*33 + 8 = +206. Clobbers A,B,C,DE,HL. Uses CDEST/BMBYTE/GROW.
; The ink written for set bits is GINK (default 0x80 solid inverse). The WEATHER-page
; THUNDER glyph sets GINK=0x00 on odd render phases so the bolt blinks on-machine via
; the inverse-video attribute (T14); every other glyph/arm keeps GINK=0x80.
stampbmp:
; start = DFPTR + GOFFS (16-bit): 206 = classic centre; the glyph-quadrant starts
; (GPOSTAB) exceed 8 bits, so the old ADD A,206 byte-add is now a full HL add.
; HL holds the bitmap source pointer — preserved around the address math.
  LD DE,(DFPTR)
  PUSH HL
  LD HL,(GOFFS)
  ADD HL,DE
  LD (CDEST),HL
  POP HL
  LD A,12
  LD (GROW),A
sb_row:
  LD DE,(CDEST)         ; row start
  LD C,2                ; 2 bytes per row
sb_byte:
  LD A,(HL)
  LD (BMBYTE),A
  INC HL
  LD B,8
sb_bit:
  LD A,(BMBYTE)
  RLCA
  LD (BMBYTE),A
  JR NC, sb_skip
  LD A,(GINK)
  LD (DE),A
sb_skip:
  INC DE
  DJNZ sb_bit
  DEC C
  JR NZ, sb_byte
; advance CDEST by 33 (next display-file row)
  LD DE,(CDEST)
  LD A,E
  ADD A,33
  LD E,A
  JR NC, sb_nr
  INC D
sb_nr:
  LD (CDEST),DE
  LD A,(GROW)
  DEC A
  LD (GROW),A
  JR NZ, sb_row
  RET

; ---- WEATHER page: stamp the tile's category glyph. LAND tiles get any glyph; a
;      SEA tile (centre cell sea) gets ONLY the THUNDER glyph (cat 6) — ocean
;      thunderstorms show; every other sea category stays blank. Mirrors
;      src/texture.js stampGlyph() (JS reference == Z80 by construction). ----
stampglyph:
  LD A,(PBUF+2)         ; weather category (0..6), extreme-marker (7..9), emergency (10 FIRE, 11 FLOOD)
  CP 12
  RET NC                ; out of range -> nothing
  LD C,A                ; C = category (preserved across the index multiply)
  LD A,(0x6190)         ; land-mask centre cell (12*32+16 = 400) — land tile?
  OR A
  JR NZ, sgl_ok         ; land -> stamp any category glyph
  LD A,C                ; sea tile: RAIN(4)..GALE(9) draw (rain/snow/thunder/heat/
  CP 4                  ; cold/gale); CLEAR/CLOUD/FOG/DRIZZLE stay off the ocean
  RET C
sgl_ok:
; SUB-TILE glyph position (owner 2026-07-31: glyph sits over the weather it reports):
; on a tier-NONE tile the byte5 pos bits (cyclone sub-position idiom, 1..4 =
; NW/NE/SW/SE) pick a half-tile quadrant start offset from GPOSTAB; CENTER (0),
; any cyclone/storm tier, or an out-of-range pos keeps the classic centre 206.
  LD HL,206
  LD (GOFFS),HL
  LD A,(PBUF+5)
  AND 0x30              ; tier bits: pos is a glyph quadrant ONLY on a tier-NONE tile
  JR NZ, sgl_ink
  LD A,(PBUF+5)
  AND 0x07
  JR Z, sgl_ink         ; CENTER -> keep 206
  CP 5
  JR NC, sgl_ink        ; out of range -> keep 206
  DEC A                 ; (pos-1)*2 -> GPOSTAB index
  ADD A,A
  LD HL, GPOSTAB
  ADD A,L
  LD L,A
  JR NC, sgl_pt
  INC H
sgl_pt:
  LD E,(HL)
  INC HL
  LD D,(HL)
  EX DE,HL
  LD (GOFFS),HL
sgl_ink:
; ink = 0x80 (visible), but a THUNDER glyph (cat 6) blinks: on ODD phases the ink is
; cleared to 0x00 so only the bolt cells toggle (T14 on-machine inverse-video blink).
  LD A,0x80
  LD (GINK),A
  LD A,C
  CP 6                  ; THUNDER blinks...
  JR Z, sgl_blink
  CP 10                 ; ...and the EMERGENCY FIRE glyph blinks the same way
  JR NZ, sgl_tab
sgl_blink:
  LD A,(PHASEV)
  AND 1
  JR Z, sgl_tab         ; even phase -> keep 0x80 (bolt visible)
  XOR A
  LD (GINK),A           ; odd phase -> 0x00 (bolt blinks off)
sgl_tab:
  LD HL, GLYTAB
  LD A,C
  OR A
  JR Z, sgl_go
  LD B,A
  LD DE,24
sgl_mul:
  CALL addHLDE
  DJNZ sgl_mul
sgl_go:
  JP stampbmp

; ---- WIND page: stamp the chevron/barb speed notation (T13/FS7): COUNT of
;      chevrons = strength band (calm -> none, breeze/wind/gale -> 1/2/3), the
;      chevrons ORIENTED along the wind octant. Byte-exact mirror of texture.js
;      stampWind — both read the SAME WINDTAB/WIND_CHEVRONS table (band-1 indexed). ----
stampwind:
  LD HL,206
  LD (GOFFS),HL         ; wind chevrons always stamp at the classic centre
  LD A,0x80
  LD (GINK),A           ; wind chevrons never blink -> solid inverse ink
  LD A,(0x6305)         ; wind km/h -> band (1..3); calm -> no chevron
  LD C,3
  CP 55
  JR NC, sw_have
  LD C,2
  CP 30
  JR NC, sw_have
  LD C,1
  CP 12
  JR NC, sw_have
  RET
sw_have:
  LD A,(0x6309)         ; octant 0..7
  AND 7
  LD B,A
  ADD A,A
  ADD A,B               ; A = octant*3
  ADD A,C
  DEC A                 ; + (band-1)   -> index 0..23
  LD HL, WINDTAB
  OR A
  JR Z, sw_go
  LD B,A
  LD DE,24
sw_mul:
  CALL addHLDE
  DJNZ sw_mul
sw_go:
  JP stampbmp

; ================= FS7: stamp micro-phenomena marks =================
; Draw (PHENCNT) one-cell MICRO marks from the phen list at PBUF+12 (x,y,code
; triples). Each code is written OPAQUELY to DFPTR + y*33 + x. On ODD render
; phases the 0x80 ink bit of the code is cleared (THUNDER 0x98 -> 0x18) so ONLY
; the bolt blinks — a no-op for the non-ink marks (fog/drizzle/rain/snow lack
; bit7). Byte-identical to src/texture.js stampPhen(). No-op when PHENCNT==0 (a
; modern CLEAR/CLOUD tile draws NOTHING). Clobbers A,B,C,DE,HL + PH* scratch.
stampphen:
  LD A,(PHENCNT)
  OR A
  RET Z
  CP 17                 ; H1: CLAMP the drawn count to PHEN_MAX (16) — src/texture.js
  JR C, sp_cap          ; stampPhen loops k<PHEN_MAX, so a count>16 frame must draw
  LD A,16               ; only the first 16 here too (JS==Z80) and never overrun PBUF.
sp_cap:
  LD (PHLEFT),A
  LD HL, PBUF           ; source = PBUF + 12 (first (x,y,code) triple)
  LD A,L
  ADD A,12
  LD L,A
  JR NC, sp_src
  INC H
sp_src:
  LD (PHPTR),HL
sp_loop:
  LD HL,(PHPTR)
  LD A,(HL)             ; x
  LD (PHX),A
  INC HL
  LD A,(HL)             ; y
  LD (PHY),A
  INC HL
  LD A,(HL)             ; code
  INC HL
  LD (PHPTR),HL         ; advance past this triple (even if it is skipped below)
  LD (PHCODE),A
  LD A,(PHASEV)         ; odd render phase -> clear the ink bit (0x80) of the code
  AND 1
  JR Z, sp_chk
  LD A,(PHCODE)
  AND 0x7F
  LD (PHCODE),A
sp_chk:
; H2: skip a triple whose (masked) code is 0 or whose cell is off the 32x24 tile —
; mirror src/texture.js stampPhen (!code || x>=TILE_W || y>=TILE_H). x,y are unsigned
; bytes, so x<0 / y<0 cannot occur; only x>=32 / y>=24 need guarding.
  LD A,(PHCODE)
  OR A
  JR Z, sp_next         ; code 0 -> draw nothing
  LD A,(PHX)
  CP 32
  JR NC, sp_next        ; x >= 32 -> off the tile (never clobber the 0x76 / next row)
  LD A,(PHY)
  CP 24
  JR NC, sp_next        ; y >= 24 -> off the tile
  LD HL,(DFPTR)         ; addr = DFPTR + PHY*33 + PHX
  LD A,(PHY)
  OR A
  JR Z, sp_col
  LD B,A
  LD DE,33
sp_row:
  CALL addHLDE
  DJNZ sp_row
sp_col:
  LD A,(PHX)
  LD E,A
  LD D,0
  CALL addHLDE
  LD A,(PHCODE)
  LD (HL),A             ; OPAQUE 1-cell write
sp_next:
  LD A,(PHLEFT)
  DEC A
  LD (PHLEFT),A
  JR NZ, sp_loop
  RET

; ================= stamp cyclone marker (phase + hemisphere) =================
; Overlay the 7x7 spiral at the triggering sample's sub-tile position, at rotation
; PHASEV (0..3), mirrored L-R for the S hemisphere (Coriolis: CCW north, CW
; south). Reads the CYC byte (0x6306): pos bits0-2, tier bits4-5, SOUTH bit7. No-op
; unless tier >= CYCLONE(2). Tables are BYTE-IDENTICAL to src/glyphs.js.
; Clobbers A,B,C,DE,HL. Uses CPOS/CTIER/CSOUTH/CROW/CDEST/STSRC/SBYTE.
stampcyc:
  LD A,(0x6306)
  LD B,A
  AND 0x07
  LD (CPOS),A           ; pos = bits0-2
  LD A,B
  AND 0x80
  LD (CSOUTH),A         ; south flag (0 / 0x80)
  LD A,B
  RRCA
  RRCA
  RRCA
  RRCA
  AND 0x03
  LD (CTIER),A          ; tier = bits4-5
  CP 2
  RET C                 ; tier < CYCLONE -> no marker
; SUPPRESS (cyclone byte bit3): extratropical detection -> draw the bold/inverse
; 'L' at the sub-tile cell instead of the rotating spiral (FS2 §C.4). Mirrors
; src/texture.js tileCells: no spiral, no periphery (stampband already RET'd).
  LD A,(0x6306)
  AND 0x08
  JP NZ, sc_suppress
  LD A,(CPOS)
  CP 5
  JR C, sc_posok
  XOR A
  LD (CPOS),A           ; invalid pos -> CENTER
sc_posok:
; source = phase table for this tier, offset by PHASEV*49
  LD A,(CTIER)
  CP 3
  JR C, sc_useC
  LD HL, STMAJ_PH
  JR sc_base
sc_useC:
  LD HL, STCYC_PH
sc_base:
  LD A,(PHASEV)
  AND 3
  OR A
  JR Z, sc_srcok
  LD B,A
  LD DE,49
sc_phadd:
  CALL addHLDE
  DJNZ sc_phadd
sc_srcok:
  LD (STSRC),HL
; dest top-left = DFPTR + OFFTAB[pos]
  LD HL, OFFTAB
  LD A,(CPOS)
  OR A
  JR Z, sc_haveoff
  LD B,A
sc_offadv:
  INC HL
  INC HL
  DJNZ sc_offadv
sc_haveoff:
  LD E,(HL)
  INC HL
  LD D,(HL)             ; DE = offset
  LD HL,(DFPTR)
  CALL addHLDE          ; HL = DFPTR + offset
  LD (CDEST),HL
  LD HL,(STSRC)         ; HL = source stamp row cursor
  LD A,7
  LD (CROW),A
sc_row:
  LD C,0                ; col 0..6
sc_col:
  LD A,(HL)             ; source byte
  CP 0xFF
  JR Z, sc_after        ; skip cell -> leave base texture
  LD (SBYTE),A
; write offset within row = south ? (6 - col) : col
  LD A,(CSOUTH)
  OR A
  LD A,C
  JR Z, sc_off
  LD A,6
  SUB C
sc_off:
  LD E,A
  LD D,0
  PUSH HL
  LD HL,(CDEST)
  CALL addHLDE          ; HL = dest row-start + offset
  LD A,(SBYTE)
  LD (HL),A
  POP HL
sc_after:
  INC HL                ; next source byte
  INC C
  LD A,C
  CP 7
  JR NZ, sc_col
; advance CDEST to next display row (+33)
  LD DE,(CDEST)
  LD A,E
  ADD A,33
  LD E,A
  JR NC, sc_nr
  INC D
sc_nr:
  LD (CDEST),DE
  LD A,(CROW)
  DEC A
  LD (CROW),A
  JR NZ, sc_row
  RET

; ---- extratropical marker: write the bold/inverse 'L' (0xB1 = zx('L')|0x80) at
;      the sub-tile CENTRE cell. OFFTAB[pos] is the 7x7 stamp's TOP-LEFT cell
;      offset; the centre cell is +102 (= 3*33 + 3 = STAMP_CY rows + STAMP_CX cols).
;      Byte-identical to src/texture.js's EXTRATROPICAL_L stamp. ----
sc_suppress:
  LD A,(CPOS)
  CP 5
  JR C, scs_posok
  XOR A
  LD (CPOS),A           ; invalid pos -> CENTER
scs_posok:
  LD HL, OFFTAB
  LD A,(CPOS)
  OR A
  JR Z, scs_haveoff
  LD B,A
scs_offadv:
  INC HL
  INC HL
  DJNZ scs_offadv
scs_haveoff:
  LD E,(HL)
  INC HL
  LD D,(HL)             ; DE = 7x7 top-left offset for this position
  LD HL,(DFPTR)
  CALL addHLDE          ; HL = DFPTR + top-left
  LD DE,102
  CALL addHLDE          ; HL = centre cell (top-left + 3 rows + 3 cols)
  LD (HL),0xB1          ; bold/inverse 'L'
  RET

; ================= FS2 T9/T14/T15: min-PRESSURE digits UNDER the name =================
; Decode the wall trailer's pressure byte (PRESSV; hPa = 850 + byte, 850..1105) into its
; 3-4 decimal DIGIT codes (28+d) and write them via the 2x3-cell BLOCK FONT (T15),
; LEFT-ALIGNED at the stamp's left column (x = cx - STAMP_CX), with top row directly
; UNDER the 3-cell-tall name (row = cy + 7). T14 moved the digits OUT of the tiny spiral
; eye (unreadable on the live wall); T15 enlarged them so they are legible at 1:1 wall
; scale. The eye stays clean, no eye-width fit test / degrade branch. Drawn LAST every
; phase, so the cells are byte-identical across the animation. Byte-identical to
; src/texture.js stampNamePressure(). No-op unless the trailer is present, tier>=CYCLONE,
; and !SUPPRESS. Clobbers A,B,C,DE,HL + BT* scratch. Uses PPOS/NDIG/TENSV/ONESV/PROW/PCOL/DIGBUF.
stamppress:
  LD A,(PTRAIL)
  OR A
  RET Z                 ; no trailer
  LD A,(0x6306)
  AND 0x08
  RET NZ                ; SUPPRESS (extratropical) -> no eye pressure
  LD A,(0x6306)
  RRCA
  RRCA
  RRCA
  RRCA
  AND 3
  CP 2
  RET C                 ; tier < CYCLONE -> no pressure
  LD (PTIER),A          ; tier (2 CYCLONE / 3 MAJOR)
; --- decode hPa = 850 + PRESSV into HL, then split into digits ---
  LD A,(PRESSV)
  LD L,A
  LD H,0
  LD DE,850
  CALL addHLDE          ; HL = 850 + byte (850..1105)
  LD B,0                ; B = hundreds+thousands count (floor(hPa/100), 8..11)
sp_hp:
  LD A,H
  OR A
  JR NZ, sp_hpsub       ; H>0 -> >=256 -> definitely >=100
  LD A,L
  CP 100
  JR C, sp_hpdone       ; L<100 -> remainder settled
sp_hpsub:
  LD A,L
  SUB 100
  LD L,A
  JR NC, sp_hpnc
  DEC H
sp_hpnc:
  INC B
  JR sp_hp
sp_hpdone:
  LD A,L                ; A = hPa mod 100 (0..99); split into tens/ones
  LD C,0                ; C = tens
sp_tn:
  CP 10
  JR C, sp_tndone
  SUB 10
  INC C
  JR sp_tn
sp_tndone:
  LD (ONESV),A          ; ones digit (0..9)
  LD A,C
  LD (TENSV),A          ; tens digit (0..9)
; --- build DIGBUF (codes 28+d) + NDIG from B(=hund+thou), TENSV, ONESV ---
  LD A,B
  CP 10
  JR C, sp_three        ; B<10 -> 3 digits (hundreds only)
  LD A,29               ; 28 + 1  -> thousands digit '1'
  LD (DIGBUF),A
  LD A,B
  SUB 10
  ADD A,28
  LD (DIGBUF+1),A       ; hundreds digit (B-10)
  LD A,(TENSV)
  ADD A,28
  LD (DIGBUF+2),A
  LD A,(ONESV)
  ADD A,28
  LD (DIGBUF+3),A
  LD A,4
  LD (NDIG),A
  JR sp_place
sp_three:
  LD A,B
  ADD A,28
  LD (DIGBUF),A         ; hundreds digit (B, 8 or 9)
  LD A,(TENSV)
  ADD A,28
  LD (DIGBUF+1),A
  LD A,(ONESV)
  ADD A,28
  LD (DIGBUF+2),A
  LD A,3
  LD (NDIG),A
sp_place:
; pos -> eye cx/cy (reuse BANDCX/BANDCY tables). pressCol = cx - STAMP_CX (the stamp's
; left column, same left edge as the name); T15: pressRow = cy + 7 (under the 3-cell name).
  LD A,(0x6306)
  AND 7
  CP 5
  JR C, sp_posok
  XOR A
sp_posok:
  LD (PPOS),A
  LD E,A
  LD D,0
  LD HL, BANDCX
  CALL addHLDE
  LD A,(HL)
  LD C,A                ; C = cx (eye col)
  LD A,(NAMELEN)
  OR A
  JR Z, sp_unnamed
; SEA-BIAS anchor: pressure rides directly under the anchored plate (row PLAY+6, left-
; aligned via the same nameorg). Without an anchor: legacy centred/eye-opposite rows.
  LD A,(PANCH)
  OR A
  JR Z, sp_legacy
  LD A,(PLAX)
  LD C,A
  CALL nameorgs         ; small name origin (T-DOWNSIZE)
  LD (PCOL),A
  LD A,(PLAY)
  ADD A,4               ; row under the SMALL plate (box ends at PLAY+3)
  LD (PROW),A
  JR sp_draw
sp_legacy:
  CALL nameorgs         ; C = eye col (loaded above) — left-aligned to the caption
  LD (PCOL),A
  LD A,(PPOS)           ; pressRow = nameY+4 = (cy<=12 ? cy+9 : cy-6)
  LD E,A
  LD D,0
  LD HL, BANDCY
  CALL addHLDE
  LD A,(HL)
  CP 13
  JR C, sp_bot
  SUB 6
  JR sp_pr
sp_bot:
  ADD A,9
sp_pr:
  LD (PROW),A
  JR sp_draw
sp_unnamed:
  LD A,C
  SUB 3                 ; UNNAMED: pressure at the original small-font spot (cx-3, cy+4)
  LD (PCOL),A
  LD A,(PPOS)
  LD E,A
  LD D,0
  LD HL, BANDCY
  CALL addHLDE
  LD A,(HL)
  ADD A,4               ; pressRow = cy + 4
  LD (PROW),A
sp_draw:
  LD HL, DIGBUF         ; digits in the SMALL 2x3-cell block font (pressure stays compact)
  LD (BIGSRC),HL
  LD A,(NDIG)
  LD (BIGCNT),A
  CALL stampbigtext
  RET

; ================= FS2 T9/T15: cyclone NAME below the spiral =================
; Write the trailer's name codes (PBUF+13.., NAMELEN chars) via the 2x3-cell BLOCK FONT
; (T15), OPAQUE, left-aligned at the stamp's left column (x = cx-3), with top row one row
; BELOW the 7x7 stamp (row cy+4; the 3-cell-tall glyphs occupy cy+4..cy+6). Drawn LAST
; every phase (phase-independent). Byte-identical to src/texture.js. No-op unless the
; trailer is present, NAMELEN>0, tier>=CYCLONE, and !SUPPRESS. Clobbers A,B,C,DE,HL + BT*.
stampname:
  LD A,(PTRAIL)
  OR A
  RET Z
  LD A,(NAMELEN)
  OR A
  RET Z                 ; unnamed -> pressure only
  LD A,(0x6306)
  AND 0x08
  RET NZ                ; SUPPRESS -> no name
  LD A,(0x6306)
  RRCA
  RRCA
  RRCA
  RRCA
  AND 3
  CP 2
  RET C                 ; tier < CYCLONE
  LD A,(0x6306)
  AND 7
  CP 5
  JR C, sn_posok
  XOR A
sn_posok:
  LD (PPOS),A
; SEA-BIAS anchor (PANCH): the host picked the least-land plate spot from the coastline
; mask and shipped it on the wire — centre col PLAX, name row PLAY. Without an anchor,
; the legacy tile-centred / eye-opposite placement is byte-identical to before.
; T-DOWNSIZE (owner 2026-07-29: "the hurricane name bars are HUGE"): SMALL 2x3 block font
; (the fire-caption size), caption centred on the EYE column and placed UNDER the stamp
; (nameY = cy+5) or above it (cy-10) when a low eye leaves no room below. The anchored
; (PANCH) spot still wins. Mirrors texture.stampNamePressure byte-for-byte.
  LD A,(PANCH)
  OR A
  JR Z, sn_legacy
  LD A,(PLAX)
  LD C,A                ; x0 from the anchored centre col (small origin)
  CALL nameorgs
  LD (PCOL),A
  LD A,(PLAY)
  JR sn_ny
sn_legacy:
  LD A,(PPOS)           ; C = eye col (BANDCX) — the caption hangs off the STORM now
  LD E,A
  LD D,0
  LD HL, BANDCX
  CALL addHLDE
  LD A,(HL)
  LD C,A
  CALL nameorgs
  LD (PCOL),A
  LD A,(PPOS)           ; nameY = (cy <= 12) ? cy+5 : cy-10
  LD E,A
  LD D,0
  LD HL, BANDCY
  CALL addHLDE
  LD A,(HL)
  CP 13
  JR C, sn_under
  SUB 10
  JR sn_ny
sn_under:
  ADD A,5
sn_ny:
  LD (PROW),A
; SMALL plate box: bx0 = x0-1, bx1 = x0 + n*2, by0 = nameY-1, by1 = nameY+3
; (set directly, as stampfirename does — platebox computes the 2x footprint).
  LD A,(PCOL)
  DEC A
  LD (PLX0),A
  LD A,(NAMELEN)
  ADD A,A
  LD B,A
  LD A,(PCOL)
  ADD A,B
  LD (PLX1),A
  LD A,(PROW)
  DEC A
  LD (PLY0),A
  LD A,(PROW)
  ADD A,3
  LD (PLY1),A
  XOR A
  LD (PLOP),A           ; 0 = clear to blank
  CALL platefill
  LD HL, PBUF           ; BIGSRC = PBUF + 13 (name codes), SMALL font
  LD A,L
  ADD A,13
  LD L,A
  JR NC, sn_de
  INC H
sn_de:
  LD (BIGSRC),HL
  LD A,(NAMELEN)
  LD (BIGCNT),A
  CALL stampbigtext     ; small block-font name ink — PLX0..PLY1 untouched
  LD A,1
  LD (PLOP),A           ; 1 = invert box -> WHITE name on a BLACK plate
  CALL platefill
  RET

; ================= WILDFIRE NAME: white-on-black caption plate =================
; Draw the fire name (FIRENAME, FIRENAMELEN codes) as a white-on-black plate in the SMALL
; 2x3-cell BLOCK FONT (same size as the TEMP numerals), centred on the tile (x0 = 16-n),
; its top row = FIRENAMEROW (hugging the flame; computed gateway-side). Sets the plate box
; (PLX0..PLY1) for the small font directly, then reuses the generic platefill (clear/invert)
; + stampbigtext writer. No-op unless a fire name was parsed. Byte-exact to texture.js
; plateNameSmall (^0x80 is the clean visual inverse of the quadrant codes).
stampfirename:
  LD A,(FIRENAMELEN)
  OR A
  RET Z
  LD C,A                ; C = n
  LD A,16
  SUB C
  LD (PCOL),A           ; x0 = 16 - n (centre; width n*2 centred on col 16)
  DEC A
  LD (PLX0),A           ; bx0 = x0-1
  LD A,(FIRENAMELEN)
  ADD A,A               ; n*2
  LD B,A
  LD A,(PCOL)
  ADD A,B
  LD (PLX1),A           ; bx1 = x0 + n*2 (inclusive right pad col)
  LD A,(FIRENAMEROW)    ; caption top cell row (hugs the flame)
  LD (PROW),A
  DEC A
  LD (PLY0),A           ; by0 = nameY-1
  LD A,(FIRENAMEROW)
  ADD A,3
  LD (PLY1),A           ; by1 = nameY+3 (3-cell-tall font + 1 pad row)
  XOR A
  LD (PLOP),A
  CALL platefill        ; clear the box to 0
  LD HL, FIRENAME
  LD (BIGSRC),HL
  LD A,(FIRENAMELEN)
  LD (BIGCNT),A
  CALL stampbigtext     ; small block-font name ink (quadrant/0x80 codes)
  LD A,1
  LD (PLOP),A
  CALL platefill        ; invert the box -> white on black
  RET

; ---- plate helpers: compute the name's plate box (PLX0..PLY1) from PCOL/PROW/NAMELEN,
;      then fill it (PLOP 0 = clear to 0x00, 1 = XOR 0x80). Per-cell clipped to the tile.
;      Mirrors texture.stampNamePressure's clear/invert. Clobbers A,B,DE,HL + ST*. ----
platebox:
  LD A,(PCOL)
  OR A
  JR Z, pb_x0z
  DEC A                 ; bx0 = x0-1 (or 0 if x0==0)
pb_x0z:
  LD (PLX0),A
  LD A,(NAMELEN)
  ADD A,A
  ADD A,A               ; n*4
  LD B,A
  LD A,(PCOL)
  ADD A,B
  LD (PLX1),A           ; bx1 = x0 + n*4 (inclusive right pad col)
  LD A,(PROW)
  DEC A
  LD (PLY0),A           ; by0 = nameY-1
  LD A,(PROW)
  ADD A,5
  LD (PLY1),A           ; by1 = nameY+5
  RET
platefill:
  LD A,(PLY0)
  LD (STYV),A
pf_y:
  LD A,(PLX0)
  LD (STXV),A
pf_x:
  LD A,(STXV)
  CP 32
  JR NC, pf_xn          ; col off tile
  LD A,(STYV)
  CP 24
  JR NC, pf_xn          ; row off tile
  CALL celladdr         ; HL = DFPTR + STYV*33 + STXV
  LD A,(PLOP)
  OR A
  JR NZ, pf_inv
  LD (HL),0             ; clear
  JR pf_xn
pf_inv:
  LD A,(HL)
  XOR 0x80              ; invert
  LD (HL),A
pf_xn:
  LD A,(STXV)
  INC A
  LD (STXV),A
  LD B,A
  LD A,(PLX1)
  CP B
  JR NC, pf_x           ; while STXV <= PLX1
  LD A,(STYV)
  INC A
  LD (STYV),A
  LD B,A
  LD A,(PLY1)
  CP B
  JR NC, pf_y           ; while STYV <= PLY1
  RET

; ================= FS2 T15: block-font text writer =================
; Render (BIGCNT) ZX81 char codes starting at (BIGSRC) as 2-cell-wide x 3-cell-tall
; block glyphs (FONTTAB, 6 cell codes/glyph), OPAQUE, advancing 2 cells per character,
; with the top-left cell at (PCOL,PROW). Every cell of the glyph footprint (ink AND
; blank) is written, per-cell clipped to the 32x24 tile (col 0..31, row 0..23). This is
; the on-machine twin of src/texture.js stampTextBig — JS reference == Z80 by
; construction (the font table is src/bigfont.js FONT_BYTES, injected verbatim as DB).
; Clobbers A,B,C,DE,HL + the BT* scratch. Uses BIGSRC/BIGCNT/BTX/BTR/BTC/BTY/BCOL/GPTR/BVAL.
stampbigtext:
  LD A,(BIGCNT)
  OR A
  RET Z
  LD A,(PCOL)
  LD (BTX),A            ; running top-left col of the current glyph
sbt_char:
  LD HL,(BIGSRC)        ; fetch this char's code, advance the source pointer
  LD A,(HL)
  INC HL
  LD (BIGSRC),HL
  CALL glyphptr         ; HL = FONTTAB + glyphidx(code)*6
  LD (GPTR),HL
  XOR A
  LD (BTR),A            ; cell-row cr = 0
sbt_row:
  LD A,(PROW)
  LD B,A
  LD A,(BTR)
  ADD A,B               ; y = PROW + cr
  CP 24
  JR NC, sbt_row_adv    ; row off the tile -> skip its two cells
  LD (BTY),A
  XOR A
  LD (BTC),A            ; cell-col cc = 0
sbt_col:
  LD A,(BTX)
  LD B,A
  LD A,(BTC)
  ADD A,B               ; x = BTX + cc
  CP 32
  JR NC, sbt_col_adv    ; col off the tile -> skip (never clobber the 0x76 at col 32)
  LD (BCOL),A
  LD A,(BTR)            ; glyph byte index = cr*2 + cc
  ADD A,A
  LD B,A
  LD A,(BTC)
  ADD A,B
  LD E,A
  LD D,0
  LD HL,(GPTR)
  CALL addHLDE          ; HL = GPTR + index
  LD A,(HL)
  LD (BVAL),A           ; glyph cell code
  CALL bigcelladdr      ; HL = DFPTR + BTY*33 + BCOL
  LD A,(BVAL)
  LD (HL),A             ; OPAQUE write
sbt_col_adv:
  LD A,(BTC)
  INC A
  LD (BTC),A
  CP 2
  JR C, sbt_col
sbt_row_adv:
  LD A,(BTR)
  INC A
  LD (BTR),A
  CP 3
  JR C, sbt_row
  LD A,(BTX)            ; next glyph: advance 2 cells
  ADD A,2
  LD (BTX),A
  LD A,(BIGCNT)
  DEC A
  LD (BIGCNT),A
  JR NZ, sbt_char
  RET

; ================= 2x (cell-resolution) block-font writer — the ENLARGED NAME =====
; Render (BIGCNT) char codes from (BIGSRC) as 4-cell-wide x 6-cell-tall glyphs (one cell
; per art pixel, ink=0x80 / blank=0x00, OPAQUE), advancing 4 cells/char, top-left at
; (PCOL,PROW). Reads FONTRAW (packed 3 bytes/glyph: hi nibble = even row, lo nibble = odd
; row; bit3 = col 0). On-machine twin of src/texture.js stampTextBig2x. Per-cell clipped.
; Clobbers A,B,C,DE,HL + BT*/WVAL/CELLV.
stampbigtext2x:
  LD A,(BIGCNT)
  OR A
  RET Z
  LD A,(PCOL)
  LD (BTX),A
sb2_char:
  LD HL,(BIGSRC)
  LD A,(HL)
  INC HL
  LD (BIGSRC),HL
  CALL glyphptr2x       ; HL = FONTRAW + glyphidx*3
  LD (GPTR),HL
  XOR A
  LD (BTR),A            ; cell-row cr = 0
sb2_row:
  LD A,(PROW)
  LD B,A
  LD A,(BTR)
  ADD A,B               ; y = PROW + cr
  CP 24
  JP NC, sb2_row_adv    ; row off the tile -> skip (long span -> JP)
  LD (BTY),A
  LD A,(BTR)            ; packed byte index = cr>>1
  SRL A
  LD E,A
  LD D,0
  LD HL,(GPTR)
  CALL addHLDE
  LD A,(HL)             ; packed byte (hi=even row, lo=odd row)
  LD C,A
  LD A,(BTR)
  AND 1
  JR NZ, sb2_lo
  LD A,C                ; even row -> hi nibble
  RRCA
  RRCA
  RRCA
  RRCA
  JR sb2_nib
sb2_lo:
  LD A,C                ; odd row -> lo nibble
sb2_nib:
  AND 0x0F
  RLCA                  ; move the 4-bit row to bits7..4 (bit7 = col 0)
  RLCA
  RLCA
  RLCA
  LD (WVAL),A
  XOR A
  LD (BTC),A            ; cell-col cc = 0
sb2_col:
  LD A,(WVAL)           ; consume this col's bit into carry (bit7 = current col)
  SLA A
  LD (WVAL),A
  JR C, sb2_ink
  XOR A
  JR sb2_val
sb2_ink:
  LD A,0x80
sb2_val:
  LD (CELLV),A          ; cell value for this col (0x80 ink / 0x00 blank)
  LD A,(BTX)
  LD B,A
  LD A,(BTC)
  ADD A,B               ; x = BTX + cc
  CP 32
  JR NC, sb2_col_adv    ; col off the tile -> skip (bit already consumed)
  LD (BCOL),A
  CALL bigcelladdr      ; HL = DFPTR + BTY*33 + BCOL
  LD A,(CELLV)
  LD (HL),A             ; OPAQUE write
sb2_col_adv:
  LD A,(BTC)
  INC A
  LD (BTC),A
  CP 4
  JR C, sb2_col
sb2_row_adv:
  LD A,(BTR)
  INC A
  LD (BTR),A
  CP 6
  JP C, sb2_row
  LD A,(BTX)            ; next glyph: advance 4 cells
  ADD A,4
  LD (BTX),A
  LD A,(BIGCNT)
  DEC A
  LD (BIGCNT),A
  JP NZ, sb2_char
  RET

; ---- glyph pointer (2x): A = char code -> HL = FONTRAW + glyphidx*3. Mirrors glyphptr
;      but 3 packed bytes/glyph. Clobbers A,B,DE,HL. ----
glyphptr2x:
  CP 28
  JR C, gp2_blank
  CP 64
  JR NC, gp2_blank
  SUB 28
  JR gp2_mul
gp2_blank:
  LD A,36
gp2_mul:
  OR A
  JR Z, gp2_ptr
  LD B,A
  XOR A
gp2_add:
  ADD A,3               ; offset = idx*3
  DJNZ gp2_add
gp2_ptr:
  LD E,A
  LD D,0
  LD HL,FONTRAW
  CALL addHLDE
  RET

; ---- nameorg: A = centred left column for a NAMELEN-glyph 2x name anchored at eye col C.
;      x0 = cx - NAMELEN*2, clamped to [0, 32 - NAMELEN*4]. Mirrors texture.nameOrigin2x.
;      Input: C = cx (eye col). Clobbers A,B,D,E. ----
nameorg:
  LD A,(NAMELEN)
  ADD A,A
  LD D,A                ; D = n*2
  LD A,(NAMELEN)
  ADD A,A
  ADD A,A
  LD E,A                ; E = n*4 (width)
  LD A,C
  SUB D                 ; x0 = cx - n*2
  JR NC, no_pos
  XOR A                 ; x0 < 0 -> 0
  RET
no_pos:
  LD B,A                ; B = x0
  LD A,32
  SUB E                 ; A = 32 - width (maxX)
  JR C, no_zero         ; width > 32 -> x0 = 0
  CP B
  JR NC, no_ok          ; maxX >= x0 -> keep x0
  LD B,A                ; x0 = maxX
no_ok:
  LD A,B
  RET
no_zero:
  XOR A
  RET

; SMALL-font name origin (T-DOWNSIZE 2026-07-29): x0 = C - n (width n*2), clamped on-tile.
; Same clamp discipline as nameorg; C preserved. Mirrors texture.nameOriginSmall.
nameorgs:
  LD A,(NAMELEN)
  LD D,A                ; D = n
  ADD A,A
  LD E,A                ; E = n*2 (width)
  LD A,C
  SUB D                 ; x0 = cx - n
  JR NC, ns_pos
  XOR A
  RET
ns_pos:
  LD B,A
  LD A,32
  SUB E                 ; maxX = 32 - width
  JR C, ns_zero
  CP B
  JR NC, ns_ok
  LD B,A                ; x0 = maxX
ns_ok:
  LD A,B
  RET
ns_zero:
  XOR A
  RET


; ---- glyph pointer: A = ZX81 char code -> HL = FONTTAB + glyphidx*6. Digits 28..37 map
;      to indices 0..9, letters 38..63 to 10..35 (idx = code-28); anything else maps to
;      the BLANK glyph (index 36). Mirrors src/bigfont.js glyphIndex(). Clobbers A,B,DE,HL. ----
glyphptr:
  CP 28
  JR C, gp_blank
  CP 64
  JR NC, gp_blank
  SUB 28                ; idx 0..35
  JR gp_mul
gp_blank:
  LD A,36               ; BLANK glyph index
gp_mul:
  OR A                  ; idx == 0 -> offset 0 (A already 0)
  JR Z, gp_ptr
  LD B,A                ; offset = idx*6 (idx<=36 -> <=216, fits a byte)
  XOR A
gp_add:
  ADD A,6
  DJNZ gp_add
gp_ptr:
  LD E,A
  LD D,0
  LD HL,FONTTAB
  CALL addHLDE
  RET

; ---- HL = DFPTR + BTY*33 + BCOL (block-text cell address). Clobbers A,B,DE. ----
bigcelladdr:
  LD HL,(DFPTR)
  LD A,(BTY)
  OR A
  JR Z, bca_col
  LD B,A
  LD DE,33
bca_row:
  CALL addHLDE
  DJNZ bca_row
bca_col:
  LD A,(BCOL)
  LD E,A
  LD D,0
  CALL addHLDE
  RET

; ================= stamp cyclone-PERIPHERY spiral =================
; The eye tile blits a baked centred log-spiral (BANDTAB, 100 bytes/size: a 25x25
; field, 4 bytes/row bit7=col0) around its eye, radius set by the km->cell size
; bucket in PERIPH (0x630A): SIZE bits0-2 (id-1; 0=no spiral), FLIP bit3 (L-R mirror
; about the eye = S-hemisphere CW spin). The stamp is centred on the eye's sub-tile
; position (cyclone byte 0x6306 bits0-2) via BANDCX/BANDCY/BANDROWOFF, clipped to
; the tile; a set bit paints 0x80 where the (destX+destY) 50% dither passes. Runs
; BEFORE stampcyc so the eye's spiral wins. Byte-identical to texture.js stampBand.
; Clobbers A,B,C,DE,HL.
stampband:
  LD A,(0x6306)
  AND 0x08
  RET NZ                ; SUPPRESS (cyclone byte bit3) -> extratropical: no periphery
  LD A,(0x630A)
  AND 0x07
  RET Z                 ; size 0 -> no spiral
  DEC A
  LD (PBSIZE),A
  LD A,(0x630A)
  AND 0x08
  LD (PBFLIP),A
  LD A,(0x6306)         ; eye sub-tile position (clamp <5 -> CENTER)
  AND 0x07
  CP 5
  JR C, sbb_pok
  XOR A
sbb_pok:
  LD (PBPOS),A
  LD E,A                ; cx = BANDCX[pos]
  LD D,0
  LD HL, BANDCX
  CALL addHLDE
  LD A,(HL)
  LD (PBCX),A
  LD A,(PBPOS)          ; PBDY = BANDCY[pos] - 12 (destY for sy=0)
  LD E,A
  LD D,0
  LD HL, BANDCY
  CALL addHLDE
  LD A,(HL)
  SUB 12
  LD (PBDY),A
  LD A,(PBPOS)          ; rowbase = DFPTR + BANDROWOFF[pos] (signed)
  ADD A,A
  LD E,A
  LD D,0
  LD HL, BANDROWOFF
  CALL addHLDE
  LD E,(HL)
  INC HL
  LD D,(HL)
  LD HL,(DFPTR)
  CALL addHLDE
  LD (PDEST),HL
  LD HL, BANDTAB        ; source = BANDTAB + sizeIdx*100
  LD A,(PBSIZE)
  OR A
  JR Z, sbb_src
  LD B,A
  LD DE,100
sbb_smul:
  CALL addHLDE
  DJNZ sbb_smul
sbb_src:
  LD (PSRC),HL
  XOR A
  LD (PBSY),A
sbb_row:
  LD A,(PBFLIP)         ; destX init: flip -> cx+12, else cx-12
  OR A
  LD A,(PBCX)
  JR Z, sbb_nf
  ADD A,12
  JR sbb_dxset
sbb_nf:
  SUB 12
sbb_dxset:
  LD (PBDX),A
  LD C,4                ; 4 source bytes = 32 bits (cols 25..31 are always 0)
sbb_byte:
  LD HL,(PSRC)
  LD A,(HL)
  LD (PBBYTE),A
  INC HL
  LD (PSRC),HL
  LD B,8
sbb_bit:
  LD A,(PBBYTE)
  RLCA                  ; MSB (col0) first
  LD (PBBYTE),A
  JR NC, sbb_adv        ; source bit clear -> no ink
  CALL sbb_cell         ; bounds + dither + write (preserves B,C)
sbb_adv:
  LD A,(PBFLIP)         ; advance destX (flip: -1, else +1)
  OR A
  LD A,(PBDX)
  JR Z, sbb_dxinc
  DEC A
  JR sbb_dxst
sbb_dxinc:
  INC A
sbb_dxst:
  LD (PBDX),A
  DJNZ sbb_bit
  DEC C
  JR NZ, sbb_byte
  LD HL,(PDEST)         ; next display row (+33), destY++, sy++
  LD DE,33
  CALL addHLDE
  LD (PDEST),HL
  LD A,(PBDY)
  INC A
  LD (PBDY),A
  LD A,(PBSY)
  INC A
  LD (PBSY),A
  CP 25
  JR NZ, sbb_row
  RET

; ---- one periphery cell: paint 0x80 (solid arm) at rowbase+destX if in-bounds.
;      Preserves B,C (the blit loop counters). Clobbers A,DE,HL. ----
sbb_cell:
  LD A,(PBDX)           ; destX in [0,31]? (unsigned; negatives wrapped >=32)
  CP 32
  RET NC
  LD A,(PBDY)           ; destY in [0,23]?
  CP 24
  RET NC
  LD A,(PBDX)
  LD E,A
  LD D,0
  LD HL,(PDEST)
  CALL addHLDE
  LD A,0x80
  LD (HL),A
  RET

; ================= FS2 T11 / T16: ordinary pressure-centre L/H marker =================
; Static PLAIN 'L' (49) / 'H' (45) at the tile CENTRE for an ORDINARY (sub-CYCLONE)
; pressure low/high. Rides the FREE high bits of the PERIPH byte (0x630A): centre =
; bits4-5 (1=LOW->'L', 2=HIGH->'H'). A cyclone tile has SIZE bits0-2 set + centre 0,
; an ordinary L/H tile has SIZE 0 + centre bits — so the two never collide. NO-OP on
; a cyclone tile (0x6306 tier bits4-5 >= CYCLONE): those carry their own marker. The
; block-font L/H (quadrant-graphic codes 0x00-0x07/0x80-0x87) are distinct from the
; extratropical bold/inverse 'L' (0xB1) and from the rotating spiral.
; T16 (UAT): the single-cell marker was too small to read on the live wall, so it now
; renders in the SAME T15 2-cell-wide x 3-cell-tall BLOCK FONT via stampbigtext (font
; table = FONTTAB). Anchor top-left at (15,11) so the 2x3 footprint straddles the tile
; centre (16,12): cols 15-16, rows 11-13. stampbigtext clips per-cell to the tile.
; Byte-identical to src/texture.js tileCells. Clobbers A,B,C,DE,HL + BT* scratch.
stampcentre:
  LD A,(0x6306)
  RRCA
  RRCA
  RRCA
  RRCA
  AND 0x03
  CP 2
  RET NC                ; tier >= CYCLONE -> no ordinary marker
  LD A,(0x630A)
  RRCA
  RRCA
  RRCA
  RRCA
  AND 0x03
  RET Z                 ; centre bits 0 -> no L/H marker
  CP 1
  LD A,45               ; HIGH -> 'H'
  JR NZ, stc_write      ; centre == 2 (HIGH)
  LD A,49               ; centre == 1 (LOW) -> 'L'
stc_write:
  LD (CENTBUF),A        ; single char code -> block-font source buffer
  LD A,15
  LD (PCOL),A           ; anchor col 15 (2-cell glyph straddles centre col 16)
  LD A,11
  LD (PROW),A           ; anchor row 11 (3-cell glyph straddles centre row 12)
  LD HL,CENTBUF
  LD (BIGSRC),HL
  LD A,1
  LD (BIGCNT),A
  CALL stampbigtext     ; render the L/H in the T15 2x3-cell block font
  RET

; ================= transmit ACK/NAK in the TDMA slot =================
; A = 1 (ACK) / 0 (NAK). Toggles MIC: IN sets high, OUT resets low.
sendack:
  LD (STVAL),A
  OUT (0xFF),A          ; drive MIC low first (receive loop left it high)
  LD C,40               ; settle low so the START mark has a clean rising edge
  sagap:
  DEC C
  JR NZ, sagap
  LD C,100              ; START mark
  CALL txpulse
  LD A,(MYADDR)
  CALL txbyte
  LD A,(STVAL)
  OR A
  JR Z, sa_nak
  LD A,0x06             ; ASCII ACK
  JR sa_send
sa_nak:
  LD A,0x15             ; ASCII NAK
sa_send:
  CALL txbyte
  RET

txbyte:                 ; A = byte, MSB first. Clobbers A,C,D. Preserves B.
  LD D,A
  PUSH BC
  LD B,8
txbit:
  LD C,23               ; '0' high width
  RL D
  JR NC, txsend
  LD C,59               ; '1' high width
txsend:
  CALL txpulse
  DJNZ txbit
  POP BC
  RET

txpulse:                ; C = high-loop count. Clobbers A,C.
  IN A,(0xFE)           ; MIC -> high
tph:
  DEC C
  JR NZ, tph
  OUT (0xFF),A          ; MIC -> low
  LD C,24               ; inter-mark gap
tpl:
  DEC C
  JR NZ, tpl
  RET

; ================= variables =================
MYADDR: DB 0
STATUS: DB 0
LENV:   DB 0
SUMV:   DB 0
RXADDR: DB 0
STVAL:  DB 0
SHADE:  DB 0
SMOOTHV: DB 0           ; smooth-temp dither flag (TEMP page, 0x6307 bit7); reset every frame
LF16V:  DB 0            ; smooth-temp fine level (level*16) for this tile's centre byte
GRADV:  DB 0            ; smooth-temp within-tile gradient active (gx8|gy8 != 0)
GX8V:   DB 0            ; signed per-cell x gradient step (1/32 Lf16), from 0x6301 on TEMP
GY8V:   DB 0            ; signed per-cell y gradient step (1/32 Lf16), from 0x6305 on TEMP
NW32:   DS 2            ; level*32 at cell (0,0) = LF16V*32 - gx8*16 - gy8*12 (16-bit signed)
LF16C:  DB 0            ; current cell's fine level (flat = LF16V; graded = per-cell)
; TEMP-page number stamp scratch (white digits on a black plate)
NCHV:   DB 0
STCXV:  DB 0            ; st_core anchor: plate centre col (stamptemp default 16)
STCYV:  DB 0            ; st_core anchor: digit row (plate rows STCYV-1..STCYV+3; default 11)
STEYV:  DB 0            ; st_core scratch: exclusive end row of the plate box (STCYV+4)
LBCNT:  DB 0            ; stamplabels: labels remaining
LBPTR:  DS 2            ; stamplabels: cursor into the PBUF label tail
STX0V:  DB 0
STNEGV: DB 0
LBLVV:  DB 0            ; stamplabels scratch: current label's level byte (page dispatch)
STBXV:  DB 0
STBWV:  DB 0
STCCV:  DB 0
STXV:   DB 0
STYV:   DB 0
PWET:   DB 0
RADARV: DB 0
SEACONTOUR: DB 0        ; FS7-T3: sea-side contour overlay flag (PRESSURE page only)
SATMODE: DB 0           ; FS7-T5: satellite-page flag (cb_sat short-circuit; reset every frame)
SATLVL: DB 0            ; FS7-T5: cloud-cover band 0..3 (== L.cloudLevel of byte0)
SATNIGHT: DB 0          ; FS7-T5: night flag (0x6307 bit4)
SMOKEV: DB 0            ; WEATHER wildfire-smoke density (0..3), rides the sea byte on WEATHER
TERMV:  DB 0            ; dedicated all-page terminator primitive: edge bits + night + SAT ice suppression
ISOSAVE:DB 0            ; scratch for TERMV overlay reusing contour()
LANDV:  DB 0
XV:     DB 0
YV:     DB 0
SUM2:   DB 0
RESV:   DB 0
CPOS:   DB 0
CTIER:  DB 0
CSOUTH: DB 0
CROW:   DB 0
SBYTE:  DB 0
BMBYTE: DB 0
GROW:   DB 0
GINK:   DB 0
GOFFS:  DB 206, 0      ; 16-bit stampbmp start offset (little-endian), default centre
; glyph-quadrant start offsets, pos 1..4 = NW/NE/SW/SE: 0, 16, 396 (12*33), 412
GPOSTAB: DB 0,0, 16,0, 140,1, 156,1
PHASEV: DB 0
PBSIZE: DB 0
PBFLIP: DB 0
PBPOS:  DB 0
PBCX:   DB 0
PBDX:   DB 0
PBDY:   DB 0
PBSY:   DB 0
PBBYTE: DB 0
PTRAIL: DB 0
PRESSV: DB 0
NAMELEN:DB 0
PANCH:  DB 0            ; FS2 sea-bias: 1 = trailer carried a plate anchor (PLAX/PLAY)
PLAX:   DB 0            ; plate anchor: name-plate CENTRE column (host-picked, least-land)
PLAY:   DB 0            ; plate anchor: name top row (pressure rides at PLAY+6)
; FS7 micro-phenomena (phen) layer scratch
PHENON: DB 0
PHENCNT:DB 0
PHLEFT: DB 0
PHPTR:  DS 2
PHX:    DB 0
PHY:    DB 0
PHCODE: DB 0
PTIER:  DB 0
PPOS:   DB 0
PCX:    DB 0
PCY:    DB 0
EYEW:   DB 0
NDIG:   DB 0
TENSV:  DB 0
ONESV:  DB 0
PROW:   DB 0
PCOL:   DB 0
; FS2 T15 block-font text writer scratch
BIGSRC: DS 2
BIGCNT: DB 0
BTX:    DB 0
BTR:    DB 0
BTC:    DB 0
BTY:    DB 0
BCOL:   DB 0
GPTR:   DS 2
BVAL:   DB 0
WVAL:   DB 0            ; 2x font: the current row's 4-bit pattern (shifted MSB-first)
CELLV:  DB 0            ; 2x font: the current cell's value (0x80 ink / 0x00 blank)
PLX0:   DB 0            ; name-plate box: left/right/top/bottom (inclusive) + op (0 clear / 1 invert)
PLX1:   DB 0
PLY0:   DB 0
PLY1:   DB 0
PLOP:   DB 0
FIRENAMELEN: DB 0       ; wildfire caption: length + up to 8 ZX name codes
FIRENAMEROW: DB 0       ; wildfire caption: top cell row (hugs the flame)
FIRENAME:    DS 8
CENTBUF:DB 0            ; T16: 1-char source buffer for the ordinary L/H block glyph
DIGBUF: DS 4
DFPTR:  DS 2
CDEST:  DS 2
STSRC:  DS 2
PSRC:   DS 2
PDEST:  DS 2
; cyclone stamp geometry: OFFTAB[pos] = (y0*33 + x0) of the 7x7 stamp's top-left
; cell for each sub-tile position (CENTER,NW,NE,SW,SE), lo,hi pairs.
OFFTAB: DB 0x36,0x01, 0x68,0x00, 0x78,0x00, 0xF4,0x01, 0x04,0x02
`;

// Build the assembly source: the fixed code above + the shared byte tables
// (src/glyphs.js) injected verbatim as DB, so the machine's tables ARE the JS
// reference tables. Layout after OFFTAB:
//   GLYTAB   7 category glyphs x 24 bytes (16x12, hi,lo per row)
//   WINDTAB  8 octants x 3 strength bands x 24 bytes (band-1 indexed) — the WIND-page
//            chevron/barb stamps (COUNT = band, ORIENTATION = octant); T13/FS7
//   STCYC_PH 4 rotation phases x 49 bytes (CYCLONE spiral)
//   STMAJ_PH 4 rotation phases x 49 bytes (MAJOR spiral)
//   PBUF     64-byte receive buffer
function buildSource() {
  const G = _glyphs;
  const glyBytes = [];
  for (const rows of G.CAT_GLYPHS) glyBytes.push(...G.glyphBytes(rows));
  const windBytes = [];
  for (let o = 0; o < 8; o++)
    for (let b = 1; b <= 3; b++) windBytes.push(...G.glyphBytes(G.WIND_CHEVRONS[o][b]));
  const cycPh = [];
  for (let k = 0; k < G.NPHASE; k++) cycPh.push(...G.CYC_PHASES[k]);
  const majPh = [];
  for (let k = 0; k < G.NPHASE; k++) majPh.push(...G.MAJ_PHASES[k]);
  // (BANDTAB spiral stamps now live in low RAM via dataSegments(), not the image.)
  // per sub-tile-position centring tables (eye cell + the 25x25 field's row offset)
  const cxTab = [], cyTab = [], rowOff = [];
  for (let p = 0; p < 5; p++) {
    const c = G.SUB_CELL[p] || G.SUB_CELL[0];
    cxTab.push(c[0] & 0xff); cyTab.push(c[1] & 0xff);
    const off = (c[1] - G.BAND_FR) * 33;      // top row of the 25x25 field, in DFILE cells
    rowOff.push(off & 0xff, (off >> 8) & 0xff);
  }
  return CODE +
    '\nGLYTAB:\n' + G.emitDB(glyBytes) +
    '\nWINDTAB:\n' + G.emitDB(windBytes) +
    // BANDTAB is relocated to low RAM (0x6500) via dataSegments() — not emitted here.
    '\nBANDCX:\n' + G.emitDB(cxTab) +
    '\nBANDCY:\n' + G.emitDB(cyTab) +
    '\nBANDROWOFF:\n' + G.emitDB(rowOff) +
    // smooth-temp tables: the 4-char ramp + 4x4 Bayer thresholds, sourced from
    // src/layout.js so JS reference == Z80 DB (the LF16 byte->level table is large,
    // so it rides low RAM via dataSegments() like the font/spiral tables).
    '\nRAMPTAB:\n' + G.emitDB(_layout.RAMP.map((b) => b & 0xff)) +
    '\nBAYER4:\n' + G.emitDB(_layout.BAYER4.map((b) => b & 0xff)) +
    '\nPBUF:   DS 64\n';
}

// The Z80-native contour engine is assembled SEPARATELY at CONTOUR_ORG and poked into the
// free low executable-RAM hole (0x4800..0x6000) via dataSegments(). It CANNOT ride high RAM:
// the ZX81 ULA NOP-jams opcode fetches at 0x8000+ (bit6=0 bytes become NOPs — the video
// mechanism), so engine CODE must live below 0x8000. Its entry ct_hook sits at CONTOUR_ORG,
// which the render blocks CALL via the `ct_hook EQU` in CODE.
const CONTOUR_ORG = 0x4c00;

const SOURCE = buildSource();

// FS2 T15: LOW-RAM DATA SEGMENTS. The 0x7000 code image sits right under the 0x7ff8
// stack, so large constant tables that used to ride in the image are seeded into free
// low scratch RAM instead (same mechanism as the land mask at 0x6000). Every site that
// pokes asm.bytes must ALSO poke these — done once inside gateway's load. Addresses are
// clear of the land mask (0x6000..0x62FF) and the config bytes (0x6300..0x630A), and
// MUST match the FONTTAB / BANDTAB EQUs in CODE.
//   * FONTTAB (0x6400): the T15 block font (37 glyphs x 6 cells = 222 bytes).
//   * BANDTAB (0x6500): the cyclone-periphery spiral stamps (6 sizes x 100 bytes = 600),
//     relocated OUT of the image to make room for the block-font renderer.
const FONT_ADDR = 0x6400;
const FONT_BYTES = _bigfont.FONT_BYTES.slice();
// 2x NAME font (packed 3 bytes/glyph x 37 = 111 bytes) in the free hole after BANDTAB
// (0x6758..0x6800). Must match the FONTRAW EQU in CODE.
const FONTRAW_ADDR = 0x6760;
const FONTRAW_BYTES = _bigfont.FONT_RAW_BYTES.slice();
const BAND_ADDR = 0x6500;
const BAND_BYTES_FLAT = [];
for (const s of _glyphs.BAND_BYTES) for (const b of s) BAND_BYTES_FLAT.push(b & 0xff);
const STCYC_ADDR = 0x6800;
const STCYC_BYTES_FLAT = [];
for (const s of _glyphs.CYC_PHASES) for (const b of s) STCYC_BYTES_FLAT.push(b & 0xff);
const STMAJ_ADDR = 0x6900;
const STMAJ_BYTES_FLAT = [];
for (const s of _glyphs.MAJ_PHASES) for (const b of s) STMAJ_BYTES_FLAT.push(b & 0xff);
// smooth-temp byte->Lf16 level table (256 bytes), sourced from src/layout.js so the
// machine's lookup IS the JS reference table. Must match the LF16TAB EQU in CODE.
const LF16_ADDR = 0x6A00;
const LF16_BYTES = _layout.LF16_TABLE.map((b) => b & 0xff);

// The contour engine, assembled at CONTOUR_ORG with the listener's own PBUF / DFPTR
// addresses injected (so ct_hook reads the corner bytes and ct_emit finds the display
// pointer). Built lazily from the assembled listener labels.
function contourSegment(labels) {
  const eng = _contour.buildDeploy(CONTOUR_ORG, labels.PBUF, labels.DFPTR, labels.LENV);
  if (eng.labels.ct_hook !== CONTOUR_ORG)
    throw new Error('contour ct_hook ' + eng.labels.ct_hook.toString(16) + ' != CONTOUR_ORG');
  return { addr: eng.org, bytes: Array.from(eng.bytes) };
}

function dataSegments(labels) {
  const segs = [
    { addr: FONT_ADDR, bytes: FONT_BYTES },
    { addr: FONTRAW_ADDR, bytes: FONTRAW_BYTES },
    { addr: BAND_ADDR, bytes: BAND_BYTES_FLAT },
    { addr: STCYC_ADDR, bytes: STCYC_BYTES_FLAT },
    { addr: STMAJ_ADDR, bytes: STMAJ_BYTES_FLAT },
    { addr: LF16_ADDR, bytes: LF16_BYTES },
  ];
  if (labels) segs.push(contourSegment(labels));
  return segs;
}
// Poke every low-RAM data segment into a machine (called wherever asm.bytes is loaded).
function loadData(m) {
  for (const s of dataSegments())
    for (let i = 0; i < s.bytes.length; i++) m.poke(s.addr + i, s.bytes[i] & 0xff);
}

function build() {
  const r = _z80asm.assemble(SOURCE, 0x6B00);
  r.dataSegments = dataSegments(r.labels);  // loaders poke these into low RAM (incl. contour engine)
  // Absolute address of the contour engine's 768-cell QUAD buffer (curve mask). The worker
  // reads it after a TEMP/PRESSURE tile render so relightLandQuiet can SPARE the machine's
  // own curve cells from the quiet-land flatten (otherwise the flatten wipes them).
  const eng = _contour.buildDeploy(CONTOUR_ORG, r.labels.PBUF, r.labels.DFPTR, r.labels.LENV);
  r.contourQUAD = eng.labels.QUAD;
  return r;
}

if (typeof window !== 'undefined') window.WW_LISTENER = { build, SOURCE, loadData, dataSegments };
if (typeof module !== 'undefined' && module.exports) module.exports = { build, SOURCE, loadData, dataSegments };

if (typeof require !== 'undefined' && require.main === module) {
  const r = build();
  console.log('code', r.org.toString(16), '..', r.end.toString(16), '=', r.bytes.length, 'bytes');
  console.log('free below stack (0x7ff8):', 0x7ff8 - r.end, 'bytes');
  const L = r.labels;
  for (const k of ['main', 'render', 'stampcyc', 'stampglyph', 'stampwind', 'anim', 'PHASEV', 'GLYTAB', 'WINDTAB', 'STCYC_PH', 'PBUF'])
    console.log('  ', k.padEnd(9), '0x' + (L[k] || 0).toString(16));
}
