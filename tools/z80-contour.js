// z80-contour.js — the ONE canonical Z80-native contour routine.
//
// Mirrors src/contour-plot.js `contourSimple(corners, levels)` BYTE-FOR-BYTE at MG=1:
// each ZX81 computes + draws its own isoline curves from 4 shared tile-corner bytes,
// into a 768-byte QUAD buffer (32x24 cells, quadrant bits TL=1,TR=2,BL=4,BR=8). The host
// only ships the 4 corners; the machine does the marching-squares + Bresenham itself.
//
// This module exports the assembler SOURCE + a build() so BOTH the bare parity proof
// (tools/proof-contour.js) and the live renderer (tools/listener.js) share one source.
//
// Assembler subset notes (verified against tools/z80asm.js):
//   - No ADC / SET / RES / BIT / SRA / NEG / CPL / LDIR / SLL. CB shifts: SLA/SRL/RL/RR only.
//   - No `SUB (HL)` form (only SUB r / SUB n) -> memory subtracts go via a register.
//   - No signed JP M/P (JP/JR cc = NZ,Z,NC,C only) -> sign tested by `LD A,H; AND 0x80`.
//   - SBC HL,rr uses the carry flag -> `OR A` (clear carry) precedes a plain 16-bit subtract.
//   - ADD HL,DE / ADD HL,HL / SBC HL,DE all encode.

'use strict';

// IIFE-wrapped so NOTHING leaks into the global scope. This matters in a Web Worker, where
// importScripts() shares ONE global scope across every file: an un-wrapped top-level
// `const SOURCE` here collides with the listener's `const SOURCE` (redeclaration SyntaxError,
// which kills the worker and blanks the wall). Node isolates each require(), so it never saw it.
(function (g) {

// Baked TEMP isotherms: tempByte = degC+50, so -5..40 degC every 5 -> 45,50,...,90.
const LEVELS = [45, 50, 55, 60, 65, 70, 75, 80, 85, 90];

// SUBW=64, SUBH=48 -> SPX=63 (X span, top/bottom edges), SPY=47 (Y span, left/right edges).
const SOURCE = `
  ORG 0x7000

; ============================ entry stubs (bare-harness) ======================
; Each sets a private stack, runs one primitive, then HALTs. The proof pokes inputs
; at the labelled scratch addresses, sets PC to the entry, runs to HALT, reads output.

ENT_CROSS:
  DI
  LD SP, 0xBF00
  CALL cross
  LD (CRESULT), A
  HALT

ENT_PLOTLINE:
  DI
  LD SP, 0xBF00
  CALL clearquad
  CALL plotline
  HALT

ENT_CONTOUR:
  DI
  LD SP, 0xBF00
  LD HL, LEVELS
  LD (LVBASE), HL
  LD A, (NLEV)
  LD (NLEVV), A
  CALL ct_run
  HALT

ENT_CONTOUR4:
  DI
  LD SP, 0xBF00
  LD HL, LEVELS
  LD (LVBASE), HL
  LD A, (NLEV)
  LD (NLEVV), A
  CALL ct_run4
  HALT

; real-data path: the proof pokes GVALS[25] first, then runs this (skips sample_grid).
ENT_CONTOUR4F:
  DI
  LD SP, 0xBF00
  LD HL, LEVELS
  LD (LVBASE), HL
  LD A, (NLEV)
  LD (NLEVV), A
  CALL ct_run4f
  HALT

; ============================ contour driver =================================
; Inputs: NW,NE,SE,SW (corner bytes). Levels: (LVBASE)[0..NLEVV) — set by the caller so
; the SAME engine serves TEMP isotherms and PRESSURE isobars. Output: QUAD (768 bytes).
ct_run:
  CALL clearquad
  LD A, (NLEVV)
  LD (LVCNT), A
  LD HL, (LVBASE)
  LD (LVPTR), HL
c_lvloop:
  LD A, (LVCNT)
  OR A
  JP Z, c_done
  ; lv = *LVPTR
  LD HL, (LVPTR)
  LD A, (HL)
  LD (CLV), A
  ; ci = (nw>=lv?8)|(ne>=lv?4)|(se>=lv?2)|(sw>=lv?1)
  LD B, A                ; B = lv
  LD C, 0               ; C = ci
  LD A, (NW)
  CP B                  ; nw - lv ; CF set if nw < lv
  JP C, c_nnw
  LD A, C
  OR 8
  LD C, A
c_nnw:
  LD A, (NE)
  CP B
  JP C, c_nne
  LD A, C
  OR 4
  LD C, A
c_nne:
  LD A, (SE)
  CP B
  JP C, c_nse
  LD A, C
  OR 2
  LD C, A
c_nse:
  LD A, (SW)
  CP B
  JP C, c_nsw
  LD A, C
  OR 1
  LD C, A
c_nsw:
  ; skip if ci==0 or ci==15
  LD A, C
  OR A
  JP Z, c_next
  CP 15
  JP Z, c_next
  LD (CI), A
  CALL calc_cross
  CALL draw_case
c_next:
  LD HL, (LVPTR)
  INC HL
  LD (LVPTR), HL
  LD A, (LVCNT)
  DEC A
  LD (LVCNT), A
  JP c_lvloop
c_done:
  RET

; compute the four edge crossings for the current level (CLV) into TOPX/BOTX/LEFY/RGTY.
; top=cross(nw,ne,63)  bottom=cross(sw,se,63)  left=cross(nw,sw,47)  right=cross(ne,se,47)
calc_cross:
  LD A, (NW)
  LD (CA), A
  LD A, (NE)
  LD (CB), A
  LD A, 63
  LD (CSPAN), A
  CALL cross
  LD (TOPX), A

  LD A, (SW)
  LD (CA), A
  LD A, (SE)
  LD (CB), A
  LD A, 63
  LD (CSPAN), A
  CALL cross
  LD (BOTX), A

  LD A, (NW)
  LD (CA), A
  LD A, (SW)
  LD (CB), A
  LD A, 47
  LD (CSPAN), A
  CALL cross
  LD (LEFY), A

  LD A, (NE)
  LD (CA), A
  LD A, (SE)
  LD (CB), A
  LD A, 47
  LD (CSPAN), A
  CALL cross
  LD (RGTY), A
  RET

; dispatch the marching-squares case -> draw 1 or 2 Bresenham segments.
; Endpoint order matches the JS EXACTLY (Bresenham is not endpoint-symmetric).
draw_case:
  LD A, (CI)
  CP 1
  JP Z, seg_LB
  CP 14
  JP Z, seg_LB
  CP 2
  JP Z, seg_BR
  CP 13
  JP Z, seg_BR
  CP 3
  JP Z, seg_LR
  CP 12
  JP Z, seg_LR
  CP 4
  JP Z, seg_TR
  CP 11
  JP Z, seg_TR
  CP 6
  JP Z, seg_TB
  CP 9
  JP Z, seg_TB
  CP 7
  JP Z, seg_LT
  CP 8
  JP Z, seg_LT
  CP 5
  JP Z, seg_5
  CP 10
  JP Z, seg_10
  RET

seg_LB:                 ; left(0,LEFY) -> bottom(BOTX,47)
  XOR A
  LD (PX0), A
  LD A, (LEFY)
  LD (PY0), A
  LD A, (BOTX)
  LD (PX1), A
  LD A, 47
  LD (PY1), A
  JP plotline

seg_BR:                 ; bottom(BOTX,47) -> right(63,RGTY)
  LD A, (BOTX)
  LD (PX0), A
  LD A, 47
  LD (PY0), A
  LD A, 63
  LD (PX1), A
  LD A, (RGTY)
  LD (PY1), A
  JP plotline

seg_LR:                 ; left(0,LEFY) -> right(63,RGTY)
  XOR A
  LD (PX0), A
  LD A, (LEFY)
  LD (PY0), A
  LD A, 63
  LD (PX1), A
  LD A, (RGTY)
  LD (PY1), A
  JP plotline

seg_TR:                 ; top(TOPX,0) -> right(63,RGTY)
  LD A, (TOPX)
  LD (PX0), A
  XOR A
  LD (PY0), A
  LD A, 63
  LD (PX1), A
  LD A, (RGTY)
  LD (PY1), A
  JP plotline

seg_TB:                 ; top(TOPX,0) -> bottom(BOTX,47)
  LD A, (TOPX)
  LD (PX0), A
  XOR A
  LD (PY0), A
  LD A, (BOTX)
  LD (PX1), A
  LD A, 47
  LD (PY1), A
  JP plotline

seg_LT:                 ; left(0,LEFY) -> top(TOPX,0)
  XOR A
  LD (PX0), A
  LD A, (LEFY)
  LD (PY0), A
  LD A, (TOPX)
  LD (PX1), A
  XOR A
  LD (PY1), A
  JP plotline

seg_5:                  ; saddle: left->top AND bottom->right
  XOR A
  LD (PX0), A
  LD A, (LEFY)
  LD (PY0), A
  LD A, (TOPX)
  LD (PX1), A
  XOR A
  LD (PY1), A
  CALL plotline
  LD A, (BOTX)
  LD (PX0), A
  LD A, 47
  LD (PY0), A
  LD A, 63
  LD (PX1), A
  LD A, (RGTY)
  LD (PY1), A
  JP plotline

seg_10:                 ; saddle: left->bottom AND top->right
  XOR A
  LD (PX0), A
  LD A, (LEFY)
  LD (PY0), A
  LD A, (BOTX)
  LD (PX1), A
  LD A, 47
  LD (PY1), A
  CALL plotline
  LD A, (TOPX)
  LD (PX0), A
  XOR A
  LD (PY0), A
  LD A, 63
  LD (PX1), A
  LD A, (RGTY)
  LD (PY1), A
  JP plotline

; ============================ cross(a,b,lv,span) =============================
; inputs: CA,CB,CLV,CSPAN. returns A = crossing coord (0..span).
;   u = a<b ? lv-a : a-lv ;  d = a<b ? b-a : a-b
;   if d==0 -> span>>1 ; q = (u*span)/d ; clamp 0..span
cross:
  ; branch on a<b : compare CB with CA
  LD HL, CA
  LD B, (HL)            ; B = CA
  LD A, (CB)            ; A = CB
  CP B                  ; CB - CA ; CF if CB<CA (=> a>b) ; Z if equal
  JP C, cr_ge
  JP Z, cr_ge
  ; a<b : d = CB-CA , u = CLV-CA
  LD HL, CA
  LD B, (HL)            ; B = CA
  LD A, (CB)
  SUB B                 ; d = CB-CA
  LD (CD), A
  LD A, (CLV)
  SUB B                 ; u = CLV-CA
  JP cr_ud
cr_ge:
  ; a>=b : d = CA-CB , u = CA-CLV
  LD HL, CB
  LD B, (HL)            ; B = CB
  LD A, (CA)
  SUB B                 ; d = CA-CB
  LD (CD), A
  LD HL, CLV
  LD B, (HL)            ; B = CLV
  LD A, (CA)
  SUB B                 ; u = CA-CLV
cr_ud:
  LD (CU), A            ; save u
  LD A, (CD)
  OR A
  JP NZ, cr_div
  ; d==0 -> span>>1
  LD A, (CSPAN)
  SRL A
  RET
cr_div:
  ; HL = u * span
  LD A, (CSPAN)
  LD E, A
  LD D, 0              ; DE = span
  LD A, (CU)           ; A = u
  CALL mul8            ; HL = u*span
  ; HL = HL / d
  LD A, (CD)
  LD C, A             ; C = d
  CALL div_hl_c       ; HL = quotient (<=span)
  LD A, L
  ; clamp 0..span (q>=0 always)
  LD B, A
  LD A, (CSPAN)
  CP B                ; span - q ; CF if span<q
  JP NC, cr_ok
  LD A, (CSPAN)
  RET
cr_ok:
  LD A, B
  RET

; mul8: HL = A * DE  (DE=span, D=0, A=u 0..255) ; MSB-first shift-add. A destroyed.
mul8:
  LD HL, 0
  LD B, 8
mul8_lp:
  ADD HL, HL
  RLA
  JR NC, mul8_sk
  ADD HL, DE
mul8_sk:
  DJNZ mul8_lp
  RET

; div_hl_c: HL / C -> HL quotient, A remainder. Restoring, handles C up to 255
; (the JR C,dsub before CP catches the 9th remainder bit).
div_hl_c:
  XOR A
  LD B, 16
div_lp:
  ADD HL, HL
  RLA
  JR C, div_sub
  CP C
  JR C, div_sk
div_sub:
  SUB C
  INC HL
div_sk:
  DJNZ div_lp
  RET

; ============================ plotline (Bresenham) ==========================
; inputs: PX0,PY0,PX1,PY1. plots into QUAD via plotsub. Mirrors JS plotLine exactly:
;   dx=|x1-x0| ; dy=-|y1-y0| ; sx=x0<x1?1:-1 ; sy=y0<y1?1:-1 ; err=dx+dy
;   loop: plotsub(x0,y0); if x0==x1&&y0==y1 stop; e2=2*err
;         if e2>=dy {err+=dy; x0+=sx}; if e2<=dx {err+=dx; y0+=sy}
plotline:
  ; --- dx (PDX) and sx (PSXSTEP) ---
  LD HL, PX0
  LD B, (HL)           ; B = x0
  LD A, (PX1)          ; A = x1
  SUB B                ; A = x1-x0 ; CF if x1<x0
  JP C, pl_xneg
  OR A
  JP Z, pl_xzero       ; x1==x0
  ; x1>x0 : dx=A, sx=+1
  LD (PDX), A
  LD A, 1
  LD (PSXSTEP), A
  JP pl_ydiff
pl_xzero:
  XOR A
  LD (PDX), A
  LD A, 0xFF
  LD (PSXSTEP), A
  JP pl_ydiff
pl_xneg:
  ; x1<x0 : dx=x0-x1, sx=-1
  LD B, A
  XOR A
  SUB B                ; A = -(x1-x0) = x0-x1
  LD (PDX), A
  LD A, 0xFF
  LD (PSXSTEP), A
pl_ydiff:
  ; --- |dy| (PDYABS) and sy (PSYSTEP) ---
  LD HL, PY0
  LD B, (HL)           ; B = y0
  LD A, (PY1)          ; A = y1
  SUB B                ; A = y1-y0 ; CF if y1<y0
  JP C, pl_yneg
  OR A
  JP Z, pl_yzero
  LD (PDYABS), A
  LD A, 1
  LD (PSYSTEP), A
  JP pl_err
pl_yzero:
  XOR A
  LD (PDYABS), A
  LD A, 0xFF
  LD (PSYSTEP), A
  JP pl_err
pl_yneg:
  LD B, A
  XOR A
  SUB B                ; |dy| = y0-y1
  LD (PDYABS), A
  LD A, 0xFF
  LD (PSYSTEP), A
pl_err:
  ; DX16 = (0,PDX)
  LD A, (PDX)
  LD L, A
  LD H, 0
  LD (DX16), HL
  ; DY16 = -(PDYABS)  (16-bit negate)
  LD A, (PDYABS)
  LD L, A
  LD H, 0
  LD A, 0
  SUB L
  LD L, A
  LD A, 0
  SBC A, H
  LD H, A
  LD (DY16), HL
  ; ERR16 = DX16 + DY16
  LD HL, (DX16)
  LD DE, (DY16)
  ADD HL, DE
  LD (ERR16), HL
pl_loop:
  CALL plotsub
  ; done? x0==x1 && y0==y1
  LD HL, PX1
  LD B, (HL)
  LD A, (PX0)
  CP B
  JP NZ, pl_step
  LD HL, PY1
  LD B, (HL)
  LD A, (PY0)
  CP B
  JP NZ, pl_step
  RET
pl_step:
  ; e2 = 2*err
  LD HL, (ERR16)
  ADD HL, HL
  LD (E2), HL
  ; cond1: e2 >= dy  ->  sign((e2 - dy)) == 0
  LD HL, (E2)
  LD DE, (DY16)
  OR A
  SBC HL, DE
  LD A, H
  AND 0x80
  JP NZ, pl_skip1      ; sign set -> e2<dy -> skip
  ; err += dy ; x0 += sx
  LD HL, (ERR16)
  LD DE, (DY16)
  ADD HL, DE
  LD (ERR16), HL
  LD A, (PX0)
  LD HL, PSXSTEP
  ADD A, (HL)
  LD (PX0), A
pl_skip1:
  ; cond2: e2 <= dx  ->  (e2 - dx) <= 0  ->  Z or sign set
  LD HL, (E2)
  LD DE, (DX16)
  OR A
  SBC HL, DE
  JP Z, pl_do2
  LD A, H
  AND 0x80
  JP Z, pl_skip2       ; sign clear -> e2>dx -> skip
pl_do2:
  ; err += dx ; y0 += sy
  LD HL, (ERR16)
  LD DE, (DX16)
  ADD HL, DE
  LD (ERR16), HL
  LD A, (PY0)
  LD HL, PSYSTEP
  ADD A, (HL)
  LD (PY0), A
pl_skip2:
  JP pl_loop

; plotsub: set the quadrant bit for sub-pixel (PX0,PY0) in QUAD.
;   cell=(sy>>1)*32+(sx>>1) ; bit=[1,2,4,8][((sy&1)<<1)|(sx&1)] ; QUAD[cell]|=bit
plotsub:
  ; bit -> save on stack via B
  LD A, (PY0)
  AND 1
  ADD A, A             ; (sy&1)<<1
  LD C, A
  LD A, (PX0)
  AND 1
  ADD A, C             ; idx 0..3
  LD HL, BITTAB
  LD E, A
  LD D, 0
  ADD HL, DE
  LD A, (HL)           ; bit
  LD B, A              ; B = bit
  ; cell -> HL
  LD A, (PY0)
  SRL A                ; cy
  LD L, A
  LD H, 0
  ADD HL, HL           ; *2
  ADD HL, HL           ; *4
  ADD HL, HL           ; *8
  ADD HL, HL           ; *16
  ADD HL, HL           ; *32
  LD A, (PX0)
  SRL A                ; cx
  LD E, A
  LD D, 0
  ADD HL, DE           ; cell
  LD DE, QUAD
  ADD HL, DE           ; &QUAD[cell]
  LD A, (HL)
  OR B
  LD (HL), A
  RET

; clearquad: zero the 768-byte QUAD buffer.
clearquad:
  LD HL, QUAD
  LD BC, 768
cq_lp:
  LD (HL), 0
  INC HL
  DEC BC
  LD A, B
  OR C
  JR NZ, cq_lp
  RET

; ============================ MG=4 engine (ct_run4) =========================
; Smooth machine-drawn curves. Mirrors src/contour-plot.js contourMG BYTE-FOR-BYTE:
;   1. sample_grid: 5x5 lattice via integer bilinear (weights sum to 16, >>4 — no 24-bit).
;   2. calc_corner_tabs: CXTAB[i]=sxOf(i,0), CYTAB[i]=syOf(i,0) for the axis-aligned edges.
;   3. per level, per 4x4 cell: marching squares, frac_edge crossings mapped by sxOf/syOf,
;      then the SAME plotline/plotsub/QUAD primitives as ct_run.
ct_run4:
  CALL clearquad
  CALL sample_grid
  JP c4_common
; ct_run4f: REAL-DATA variant. GVALS[25] already poked with a genuine 5x5 field (denser
; continental data, not corner-interpolated). Skips sample_grid; everything else identical.
; Mirrors src/contour-plot.js contourFromGrid byte-for-byte.
ct_run4f:
  CALL clearquad
c4_common:
  CALL calc_corner_tabs
  LD A, (NLEVV)
  LD (LVCNT), A
  LD HL, (LVBASE)
  LD (LVPTR), HL
c4_lvloop:
  LD A, (LVCNT)
  OR A
  JP Z, c4_done
  LD HL, (LVPTR)
  LD A, (HL)
  LD (CLV), A
  LD A, 0
  LD (CGY), A
c4_yl:
  LD A, 0
  LD (CGX), A
c4_xl:
  CALL do_cell
  LD A, (CGX)
  INC A
  LD (CGX), A
  CP 4
  JP NZ, c4_xl
  LD A, (CGY)
  INC A
  LD (CGY), A
  CP 4
  JP NZ, c4_yl
  LD HL, (LVPTR)
  INC HL
  LD (LVPTR), HL
  LD A, (LVCNT)
  DEC A
  LD (LVCNT), A
  JP c4_lvloop
c4_done:
  RET

; sample_grid: fill GVALS[25] with the bilinear samples.
;   gv(gx,gy) = ( nw*(4-gx)*(4-gy) + ne*gx*(4-gy) + sw*(4-gx)*gy + se*gx*gy ) >> 4
sample_grid:
  LD HL, GVALS
  LD (GVPTR), HL
  LD A, 0
  LD (SGY), A
sg_yl:
  LD A, 0
  LD (SGX), A
sg_xl:
  LD HL, 0
  LD (GACC), HL
  ; a=4-gx (WA), b=gx (WB), c=4-gy (WC), d=gy (WD)
  LD A, (SGX)
  LD (WB), A
  LD B, A
  LD A, 4
  SUB B
  LD (WA), A
  LD A, (SGY)
  LD (WD), A
  LD B, A
  LD A, 4
  SUB B
  LD (WC), A
  ; term1 = nw * (a*c)
  LD A, (WA)
  LD B, A
  LD A, (WC)
  LD C, A
  CALL mul_small
  LD (WT), A
  LD A, (NW)
  LD E, A
  LD D, 0
  LD A, (WT)
  CALL mul8
  LD DE, (GACC)
  ADD HL, DE
  LD (GACC), HL
  ; term2 = ne * (b*c)
  LD A, (WB)
  LD B, A
  LD A, (WC)
  LD C, A
  CALL mul_small
  LD (WT), A
  LD A, (NE)
  LD E, A
  LD D, 0
  LD A, (WT)
  CALL mul8
  LD DE, (GACC)
  ADD HL, DE
  LD (GACC), HL
  ; term3 = sw * (a*d)
  LD A, (WA)
  LD B, A
  LD A, (WD)
  LD C, A
  CALL mul_small
  LD (WT), A
  LD A, (SW)
  LD E, A
  LD D, 0
  LD A, (WT)
  CALL mul8
  LD DE, (GACC)
  ADD HL, DE
  LD (GACC), HL
  ; term4 = se * (b*d)
  LD A, (WB)
  LD B, A
  LD A, (WD)
  LD C, A
  CALL mul_small
  LD (WT), A
  LD A, (SE)
  LD E, A
  LD D, 0
  LD A, (WT)
  CALL mul8
  LD DE, (GACC)
  ADD HL, DE
  LD (GACC), HL
  ; gv = GACC >> 4
  LD HL, (GACC)
  SRL H
  RR L
  SRL H
  RR L
  SRL H
  RR L
  SRL H
  RR L
  LD A, L
  LD HL, (GVPTR)
  LD (HL), A
  INC HL
  LD (GVPTR), HL
  LD A, (SGX)
  INC A
  LD (SGX), A
  CP 5
  JP NZ, sg_xl
  LD A, (SGY)
  INC A
  LD (SGY), A
  CP 5
  JP NZ, sg_yl
  RET

; mul_small: A = B * C  (both small; simple repeated-add). Clobbers A,C.
mul_small:
  LD A, C
  OR A
  JP NZ, mss_go
  XOR A
  RET
mss_go:
  LD A, 0
mss_lp:
  ADD A, B
  DEC C
  JP NZ, mss_lp
  RET

; calc_corner_tabs: CXTAB[i]=sxOf(i,0), CYTAB[i]=syOf(i,0), i=0..4.
calc_corner_tabs:
  LD B, 0
cct_lp:
  LD A, B
  LD (SGI), A
  LD HL, 0
  PUSH BC
  CALL sxOf
  POP BC
  LD HL, CXTAB
  LD E, B
  LD D, 0
  ADD HL, DE
  LD (HL), A
  LD A, B
  LD (SGI), A
  LD HL, 0
  PUSH BC
  CALL syOf
  POP BC
  LD HL, CYTAB
  LD E, B
  LD D, 0
  ADD HL, DE
  LD (HL), A
  INC B
  LD A, B
  CP 5
  JP NZ, cct_lp
  RET

; do_cell: marching squares for cell (CGX,CGY) at level CLV -> draw 0..2 segments.
do_cell:
  ; base index = gy*5 + gx ; read tl,tr,bl,br from GVALS
  LD A, (CGY)
  LD B, A
  ADD A, A
  ADD A, A
  ADD A, B                ; gy*5
  LD B, A
  LD A, (CGX)
  ADD A, B                ; idx
  LD E, A
  LD D, 0
  LD HL, GVALS
  ADD HL, DE              ; &tl
  LD A, (HL)
  LD (DTL), A
  INC HL
  LD A, (HL)
  LD (DTR), A             ; idx+1
  LD DE, 4
  ADD HL, DE
  LD A, (HL)
  LD (DBL), A             ; idx+5
  INC HL
  LD A, (HL)
  LD (DBR), A             ; idx+6
  ; ci = (tl>=lv?8)|(tr>=lv?4)|(br>=lv?2)|(bl>=lv?1)
  LD A, (CLV)
  LD B, A
  LD C, 0
  LD A, (DTL)
  CP B
  JP C, dc1
  LD A, C
  OR 8
  LD C, A
dc1:
  LD A, (DTR)
  CP B
  JP C, dc2
  LD A, C
  OR 4
  LD C, A
dc2:
  LD A, (DBR)
  CP B
  JP C, dc3
  LD A, C
  OR 2
  LD C, A
dc3:
  LD A, (DBL)
  CP B
  JP C, dc4
  LD A, C
  OR 1
  LD C, A
dc4:
  LD A, C
  OR A
  RET Z
  CP 15
  RET Z
  LD (CI), A
  ; topX = sxOf(gx, frac(tl,tr))
  LD A, (DTL)
  LD (FA), A
  LD A, (DTR)
  LD (FB), A
  CALL frac_edge
  LD A, (CGX)
  LD (SGI), A
  CALL sxOf
  LD (TP_X), A
  ; botX = sxOf(gx, frac(bl,br))
  LD A, (DBL)
  LD (FA), A
  LD A, (DBR)
  LD (FB), A
  CALL frac_edge
  LD A, (CGX)
  LD (SGI), A
  CALL sxOf
  LD (BP_X), A
  ; lefY = syOf(gy, frac(tl,bl))
  LD A, (DTL)
  LD (FA), A
  LD A, (DBL)
  LD (FB), A
  CALL frac_edge
  LD A, (CGY)
  LD (SGI), A
  CALL syOf
  LD (LP_Y), A
  ; rgtY = syOf(gy, frac(tr,br))
  LD A, (DTR)
  LD (FA), A
  LD A, (DBR)
  LD (FB), A
  CALL frac_edge
  LD A, (CGY)
  LD (SGI), A
  CALL syOf
  LD (RP_Y), A
  ; corner coords: TP_Y=CYTAB[gy], BP_Y=CYTAB[gy+1], LP_X=CXTAB[gx], RP_X=CXTAB[gx+1]
  LD A, (CGY)
  LD E, A
  LD D, 0
  LD HL, CYTAB
  ADD HL, DE
  LD A, (HL)
  LD (TP_Y), A
  INC HL
  LD A, (HL)
  LD (BP_Y), A
  LD A, (CGX)
  LD E, A
  LD D, 0
  LD HL, CXTAB
  ADD HL, DE
  LD A, (HL)
  LD (LP_X), A
  INC HL
  LD A, (HL)
  LD (RP_X), A
  JP draw_case4

; frac_edge: edge fraction 0..256 into HL. inputs FA(a),FB(b),CLV. a==b -> 128.
;   u = a<b ? lv-a : a-lv ;  d = a<b ? b-a : a-b ;  HL = (u<<8)/d
frac_edge:
  LD A, (FA)
  LD B, A
  LD A, (FB)
  CP B                    ; b-a ; CF if b<a (a>b) ; Z if a==b
  JP C, fe_ge
  JP Z, fe_deq
  ; a<b
  LD A, (FB)
  SUB B                   ; d=b-a
  LD (FD), A
  LD A, (CLV)
  SUB B                   ; u=lv-a
  JP fe_ud
fe_ge:
  ; a>b
  LD A, (FB)
  LD B, A                 ; B=b
  LD A, (FA)
  SUB B                   ; d=a-b
  LD (FD), A
  LD A, (CLV)
  LD B, A                 ; B=lv
  LD A, (FA)
  SUB B                   ; u=a-lv
fe_ud:
  LD H, A                 ; HL = u<<8
  LD L, 0
  LD A, (FD)
  LD C, A
  CALL div_hl_c
  RET
fe_deq:
  LD HL, 128
  RET

; sxOf/syOf: HL = fx (0..256) on entry, SGI = grid index. out A = sub-pixel coord.
;   val = SGI*256 + fx ; A = (val*SPAN) >> 10   (SPAN=63 for x, 47 for y)
sxOf:
  LD A, (SGI)
  ADD A, H
  LD H, A
  LD C, 63
  CALL mul_hl_const
  LD A, H
  SRL A
  SRL A
  RET
syOf:
  LD A, (SGI)
  ADD A, H
  LD H, A
  LD C, 47
  CALL mul_hl_const
  LD A, H
  SRL A
  SRL A
  RET

; mul_hl_const: HL = HL * C  (C in 0..63; result fits 16-bit). Clobbers A,C,DE.
mul_hl_const:
  EX DE, HL               ; DE = value
  LD HL, 0                ; acc
mhc_lp:
  SRL C
  JP NC, mhc_noadd
  ADD HL, DE
mhc_noadd:
  LD A, C
  OR A
  RET Z
  SLA E
  RL D
  JP mhc_lp

; draw_case4: dispatch marching-squares case -> 1 or 2 Bresenham segments.
; Endpoint order matches contourMG's switch EXACTLY (Bresenham is not endpoint-symmetric).
;   left=(LP_X,LP_Y) top=(TP_X,TP_Y) bottom=(BP_X,BP_Y) right=(RP_X,RP_Y)
draw_case4:
  LD A, (CI)
  CP 1
  JP Z, s4_LB
  CP 14
  JP Z, s4_LB
  CP 2
  JP Z, s4_BR
  CP 13
  JP Z, s4_BR
  CP 3
  JP Z, s4_LR
  CP 12
  JP Z, s4_LR
  CP 4
  JP Z, s4_TR
  CP 11
  JP Z, s4_TR
  CP 6
  JP Z, s4_TB
  CP 9
  JP Z, s4_TB
  CP 7
  JP Z, s4_LT
  CP 8
  JP Z, s4_LT
  CP 5
  JP Z, s4_5
  CP 10
  JP Z, s4_10
  RET

s4_LB:                    ; left -> bottom
  LD A, (LP_X)
  LD (PX0), A
  LD A, (LP_Y)
  LD (PY0), A
  LD A, (BP_X)
  LD (PX1), A
  LD A, (BP_Y)
  LD (PY1), A
  JP plotline
s4_BR:                    ; bottom -> right
  LD A, (BP_X)
  LD (PX0), A
  LD A, (BP_Y)
  LD (PY0), A
  LD A, (RP_X)
  LD (PX1), A
  LD A, (RP_Y)
  LD (PY1), A
  JP plotline
s4_LR:                    ; left -> right
  LD A, (LP_X)
  LD (PX0), A
  LD A, (LP_Y)
  LD (PY0), A
  LD A, (RP_X)
  LD (PX1), A
  LD A, (RP_Y)
  LD (PY1), A
  JP plotline
s4_TR:                    ; top -> right
  LD A, (TP_X)
  LD (PX0), A
  LD A, (TP_Y)
  LD (PY0), A
  LD A, (RP_X)
  LD (PX1), A
  LD A, (RP_Y)
  LD (PY1), A
  JP plotline
s4_TB:                    ; top -> bottom
  LD A, (TP_X)
  LD (PX0), A
  LD A, (TP_Y)
  LD (PY0), A
  LD A, (BP_X)
  LD (PX1), A
  LD A, (BP_Y)
  LD (PY1), A
  JP plotline
s4_LT:                    ; left -> top
  LD A, (LP_X)
  LD (PX0), A
  LD A, (LP_Y)
  LD (PY0), A
  LD A, (TP_X)
  LD (PX1), A
  LD A, (TP_Y)
  LD (PY1), A
  JP plotline
s4_5:                     ; saddle: left->top AND bottom->right
  LD A, (LP_X)
  LD (PX0), A
  LD A, (LP_Y)
  LD (PY0), A
  LD A, (TP_X)
  LD (PX1), A
  LD A, (TP_Y)
  LD (PY1), A
  CALL plotline
  LD A, (BP_X)
  LD (PX0), A
  LD A, (BP_Y)
  LD (PY0), A
  LD A, (RP_X)
  LD (PX1), A
  LD A, (RP_Y)
  LD (PY1), A
  JP plotline
s4_10:                    ; saddle: left->bottom AND top->right
  LD A, (LP_X)
  LD (PX0), A
  LD A, (LP_Y)
  LD (PY0), A
  LD A, (BP_X)
  LD (PX1), A
  LD A, (BP_Y)
  LD (PY1), A
  CALL plotline
  LD A, (TP_X)
  LD (PX0), A
  LD A, (TP_Y)
  LD (PY0), A
  LD A, (RP_X)
  LD (PX1), A
  LD A, (RP_Y)
  LD (PY1), A
  JP plotline

; ============================ data / scratch ================================
BITTAB:  DB 1,2,4,8
LEVELS:  DB ${LEVELS.join(',')}
NLEV:    DB ${LEVELS.length}
LVBASE:  DS 2,0
NLEVV:   DB 0

NW:      DB 0
NE:      DB 0
SE:      DB 0
SW:      DB 0
CLV:     DB 0
CA:      DB 0
CB:      DB 0
CSPAN:   DB 0
CD:      DB 0
CU:      DB 0
CRESULT: DB 0
TOPX:    DB 0
BOTX:    DB 0
LEFY:    DB 0
RGTY:    DB 0
CI:      DB 0
PX0:     DB 0
PY0:     DB 0
PX1:     DB 0
PY1:     DB 0
PDX:     DB 0
PDYABS:  DB 0
PSXSTEP: DB 0
PSYSTEP: DB 0
LVCNT:   DB 0
DX16:    DS 2,0
DY16:    DS 2,0
ERR16:   DS 2,0
E2:      DS 2,0
LVPTR:   DS 2,0

; --- MG=4 (ct_run4) scratch ---
SGX:     DB 0
SGY:     DB 0
WA:      DB 0
WB:      DB 0
WC:      DB 0
WD:      DB 0
WT:      DB 0
GVPTR:   DS 2,0
GACC:    DS 2,0
GVALS:   DS 25,0
CGX:     DB 0
CGY:     DB 0
DTL:     DB 0
DTR:     DB 0
DBR:     DB 0
DBL:     DB 0
FA:      DB 0
FB:      DB 0
FD:      DB 0
SGI:     DB 0
TP_X:    DB 0
TP_Y:    DB 0
BP_X:    DB 0
BP_Y:    DB 0
LP_X:    DB 0
LP_Y:    DB 0
RP_X:    DB 0
RP_Y:    DB 0
CXTAB:   DS 5,0
CYTAB:   DS 5,0

QUAD:    DS 768,0
`;

function _assembler() {
  if (typeof window !== 'undefined' && window.WW_Z80ASM) return window.WW_Z80ASM.assemble;
  return require('./z80asm.js').assemble;
}

function build(org) {
  let src = SOURCE;
  if (org != null && (org | 0) !== 0x7000) src = src.replace('ORG 0x7000', 'ORG ' + (org | 0));
  return _assembler()(src, org != null ? (org | 0) : 0x7000);
}

// ENGINE_CORE: the pure geometry engine (ct_run + primitives + data), NO ORG / NO stubs.
const _ENGINE_MARK = '; ============================ contour driver';
const ENGINE = SOURCE.slice(SOURCE.indexOf(_ENGINE_MARK));

// DEPLOY_HOOK: the render entry point. ct_hook must be the FIRST routine so it sits at the
// engine's ORG (the listener CALLs that fixed address). ct_hook reads the CORNERS flag
// (byte6 bit4), selects the level table by page, copies the four corners PBUF+11..14 -> NW..SW,
// runs ct_run, then ct_emit stamps QUAD over the display file. PBUF / DFPTR are the listener's
// addresses, injected as EQUs at build time.
const DEPLOY_HOOK = `
ct_hook:
  LD A,(0x6307)
  AND 0x10              ; CORNERS flag (byte6 bit4)? set for BOTH corners and field frames
  RET Z                 ; no contour data -> legacy render unchanged
  ; Select the level table by PAGE *before* the frame-type branch: BOTH the 4-corner
  ; and the dense 5x5 FIELD path march the same table. (Until the PRESSURE tab rollout
  ; the field branch hardcoded the TEMP isotherms, so a dense PRESSURE frame would have
  ; marched isotherm levels against pressure bytes — garbage curves.)
  LD HL, LEVELS         ; default TEMP isotherms
  LD A,(NLEV)
  LD B,A
  LD A,(0x6308)         ; PAGEV
  CP 5                  ; PRESSURE?
  JR NZ, cth_set
  LD HL, CT_LVL_PRESS
  LD A,(CT_NLVL_PRESS)
  LD B,A
cth_set:
  LD (LVBASE), HL
  LD A,B
  LD (NLEVV), A
  ; discriminate by frame length: a corners frame is LEN 15, a dense 5x5 FIELD frame is
  ; LEN 36 (25 field bytes at PBUF+11..35). byte6's low nibble is the terminator edge mask,
  ; so the FIELD flag rides the LENGTH, not a spare bit.
  LD A,(LENV)
  CP 36
  JP NC, cth_field      ; LEN>=36 -> real 5x5 field
  LD A,(PBUF+11)        ; corner NW
  LD (NW),A
  LD A,(PBUF+12)        ; corner NE
  LD (NE),A
  LD A,(PBUF+13)        ; corner SE
  LD (SE),A
  LD A,(PBUF+14)        ; corner SW
  LD (SW),A
  CALL ct_run4          ; plot the SMOOTH (MG=4) curves into QUAD (768 cells)
  JP ct_emit            ; stamp QUAD over the display file
cth_field:
  ; DENSE continental path: a REAL 5x5 field rides at PBUF+11..35 (25 bytes). Copy it into
  ; GVALS and run ct_run4f (marching squares on real data, no corner bilinear). The level
  ; table is already selected by page above (TEMP isotherms / PRESSURE isobars).
  LD HL, PBUF+11
  LD DE, GVALS
  LD B, 25
cthf_cp:
  LD A,(HL)
  LD (DE),A
  INC HL
  INC DE
  DJNZ cthf_cp
  CALL ct_run4f         ; plot the SMOOTH curves from the real field into QUAD
  ; fall through into ct_emit (its RET returns to ct_hook's caller)
ct_emit:
  LD DE,(DFPTR)         ; display file, row0 col0 (F+1)
  LD HL, QUAD           ; 768-cell quadrant buffer, row-major (y*32+x)
  LD B, 24              ; rows
cte_row:
  LD C, 32              ; cols
cte_col:
  LD A,(HL)
  OR A
  JR Z, cte_skip        ; no curve here -> leave the base cell
  AND 0x0F
  PUSH HL
  PUSH BC
  LD HL, CT_QUAD2CH
  LD C,A
  LD B,0
  ADD HL,BC
  LD A,(HL)             ; QUAD2CH[quad & 15] -> block-graphic char
  POP BC
  POP HL
  LD (DE),A             ; overwrite the display cell with the contour glyph
cte_skip:
  INC HL
  INC DE
  DEC C
  JR NZ, cte_col
  INC DE                ; display stride 33: skip the row's trailing 0x76
  DEC B
  JR NZ, cte_row
  RET
CT_QUAD2CH:  DB 0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x87,0x86,0x85,0x84,0x83,0x82,0x81,0x80
; PRESSURE isobar levels — standard 4 hPa synoptic isobars 980..1024 hPa on the
; continuous PRESS byte field (byte = hPa-950; see layout.js PRESS_ISO_LEVELS /
; pressToByte). MUST stay byte-identical to L.PRESS_ISO_LEVELS.
CT_LVL_PRESS:  DB 30,34,38,42,46,50,54,58,62,66,70,74
CT_NLVL_PRESS: DB 12
`;

// Build the DEPLOYABLE engine (ct_hook entry at ORG=org) to poke into low executable RAM.
// The ZX81 ULA NOP-jams opcode fetches at 0x8000+, so the engine CODE must live below 0x8000
// (here in the free 0x4800..0x6000 hole); only its data buffers may sit anywhere.
function buildDeploy(org, pbuf, dfptr, lenv) {
  const src = `  ORG ${org | 0}\n`
    + `PBUF EQU ${pbuf | 0}\nDFPTR EQU ${dfptr | 0}\nLENV EQU ${lenv | 0}\n`
    + DEPLOY_HOOK + ENGINE;
  return _assembler()(src, org | 0);
}

const API = { SOURCE, ENGINE, DEPLOY_HOOK, LEVELS, build, buildDeploy };
g.WW_Z80CONTOUR = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
