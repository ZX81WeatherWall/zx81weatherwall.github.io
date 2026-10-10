///////////////////////////////////////////////////////////////////////////////
// zx81.js — Sinclair ZX81 machine emulation
//
// CPU: Molly Howell's Z80.js (MIT, passes ZEXALL) — used unmodified.
// ROM: genuine Sinclair 8K ZX81 ROM (Amstrad permits non-commercial use).
//
// ULA / display model
// -------------------
// The ZX81 has no video chip proper; the ULA forces the Z80 to *execute* the
// display file (mapped at 0x8000+) to clock pixels out, and generates the
// maskable interrupt and (in SLOW mode) the NMI that pace the ROM. Faithfully
// reproducing this is what lets the ROM ever return from the display routine to
// scan the keyboard and run BASIC. We reproduce the documented EightyOne/JtyOne
// algorithm on top of Z80.js:
//
//   * Opcode (M1) fetches from 0x8000+ are intercepted: if bit 6 of the byte is
//     clear the ULA substitutes a NOP (so the CPU walks the display file) and
//     latches the character bitmap; if bit 6 is set (e.g. HALT 0x76) the real
//     opcode executes. We detect M1 because Z80.js reads PC first each
//     instruction.
//   * The maskable INT is requested when bit 6 of the R register is 0 (exactly
//     as the hardware derives /INT from A6 during the I-R refresh).
//   * An hsync counter (T-states per scanline = 207) drives the NMI in SLOW
//     mode and the line/row counters.
//
// The visible screen is then rasterised from the display file (pointer D_FILE)
// using glyphs from the character ROM at 0x1E00 — the ROM keeps that file
// correct, so the output matches the hardware for text/blocky graphics. The
// documented gap (NOTES.md): we do not build a per-pixel scanline framebuffer,
// so pure-machine-code hi-res tricks (WRX, pseudo-hires) are not displayed.
///////////////////////////////////////////////////////////////////////////////

(function (global) {
  "use strict";

  const ROM_SIZE = 0x2000;   // 8 KiB
  const CHARSET  = 0x1e00;   // character generator in ROM
  const D_FILE   = 0x400c;   // system var: pointer to display file
  const RAMTOP   = 0x7fff;   // top of 16K RAM
  const TS_PER_SCANLINE = 207;

  function decodeRom(b64) {
    const bin = (typeof atob === "function")
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
    const rom = new Uint8Array(ROM_SIZE);
    for (let i = 0; i < ROM_SIZE && i < bin.length; i++) rom[i] = bin.charCodeAt(i);
    return rom;
  }

  function ZX81(opts) {
    opts = opts || {};
    const Z80 = opts.Z80 || global.Z80;
    if (!Z80) throw new Error("Z80 core not loaded");

    const rom = decodeRom(opts.romB64 || global.ZX81_ROM_B64);
    const mem = new Uint8Array(0x10000);
    mem.set(rom, 0);

    // ----- RAM configuration -----
    // 16K (default): RAM 0x4000-0x7FFF; the ULA leaves A15 *unconnected* above
    //   the pack, so the whole 0x8000-0xFFFF window mirrors the low 32K. That
    //   mirror is also what the display generator exploits (it executes the
    //   display file out of the high window, which maps back down to low RAM).
    // 64K pack: the pack drives A15, so 0x2000-0xFFFF is REAL contiguous RAM
    //   (ROM stays at 0x0000-0x1FFF). General reads/writes at 0x8000+ hit real
    //   high RAM — there is NO data mirror. The ULA's *video DMA*, however,
    //   still clears A15 to fetch display-file bytes from the lower 32K (where
    //   the system variables' D_FILE points), so the display path is unchanged.
    //   Net: the ROM probes upward from 0x4000, finds contiguous RAM to 0xFFFF,
    //   and sets RAMTOP high (~56K usable).
    const mirror = !opts.ram64k;          // true = classic 16K A15 mirror

    // ----- keyboard matrix: 8 half-rows selected by address bits A8..A15 -----
    const KEYMATRIX = [
      ["SHIFT", "Z", "X", "C", "V"],     // A8
      ["A", "S", "D", "F", "G"],         // A9
      ["Q", "W", "E", "R", "T"],         // A10
      ["1", "2", "3", "4", "5"],         // A11
      ["0", "9", "8", "7", "6"],         // A12
      ["P", "O", "I", "U", "Y"],         // A13
      ["NEWLINE", "L", "K", "J", "H"],   // A14
      ["SPACE", ".", "M", "N", "B"],     // A15
    ];
    const pressed = new Uint8Array(8); // bit c set = key (row,c) down

    function setKey(name, down) {
      for (let r = 0; r < 8; r++) {
        const c = KEYMATRIX[r].indexOf(name);
        if (c >= 0) {
          if (down) pressed[r] |= (1 << c); else pressed[r] &= ~(1 << c);
          return true;
        }
      }
      return false;
    }
    function clearKeys() { pressed.fill(0); }

    // ----- ULA state -----
    let nmiGenerator = false;
    let hsyncCounter = TS_PER_SCANLINE;
    let rowCounter   = 0;          // 0..7 scanline within character row
    let intPending   = false;
    let shiftReg     = 0;          // (not rendered, but kept for fidelity)
    let lastInst     = 0;          // 0 none, 1 INFE, 2 OUTFD, 3 OUTFE, 4 OUTFF

    // ----- tape / cassette port state (the ZX81 Weather Wall bus) -----
    // The MIC output line is the ULA's vsync latch: an `IN A,($FE)` (A0 low) SETS
    // it, any `OUT` RESETS it — exactly how the ROM SAVE routine pulses the tape.
    // The EAR input is bit 7 of `IN A,($FE)`. tState is a free-running T-state
    // clock (the whole-machine time base the bus timestamps are expressed in).
    let tState    = 0;             // absolute T-states since power-on
    let micLevel  = 0;             // vsync/MIC latch (0/1)
    let earBus    = null;          // downlink TapeBus feeding this EAR (or null)
    let earOffset = 0;             // busTime = tState + earOffset
    let micBus    = null;          // uplink TapeBus this MIC drives (or null)
    let micOffset = 0;

    function setMic(level) {
      if (level === micLevel) return;
      micLevel = level;
      if (micBus) micBus.emit(tState + micOffset, level);
    }

    // M1 detection: Z80.js reads the opcode at PC as the first read of each
    // instruction. We track the PC we expect for the next M1 fetch.
    let m1Address = -1;

    const core = {
      mem_read(addr) {
        addr &= 0xffff;
        // Is this the opcode (M1) fetch? Z80.js fetches PC first.
        if (addr === m1Address) {
          m1Address = -1; // consume; subsequent reads this instruction are data
          return opcodeFetch(addr);
        }
        return readByte(addr);
      },
      mem_write(addr, val) {
        addr &= 0xffff;
        if (addr < ROM_SIZE) return;            // ROM read-only (0x0000-0x1FFF)
        if (mirror) {
          if (addr < 0x4000) return;            // 16K: 0x2000-0x3FFF unmapped
          if (addr >= 0x8000) { mem[addr & 0x7fff] = val & 0xff; return; } // A15 mirror
        }
        mem[addr] = val & 0xff;                 // RAM (16K low / 64K contiguous)
      },
      io_read(port) {
        port &= 0xffff;
        if ((port & 0x01) === 0) {              // keyboard / ULA read (A0 low)
          lastInst = 1;                         // INFE
          setMic(1);                            // A0-low IN sets vsync/MIC latch
          const hi = (port >> 8) & 0xff;
          let data = 0x80;                      // bit7 set initially
          for (let r = 0; r < 8; r++) {
            if ((hi & (1 << r)) === 0) data |= pressed[r];
          }
          let ret = (~data) & 0xff;             // active low: pressed -> 0
          // EAR (tape input) = bit 7. Inject the downlink bus level sampled at
          // this machine's current T-state (mapped into bus time by earOffset).
          if (earBus) ret = earBus.sample(tState + earOffset) ? (ret | 0x80) : (ret & 0x7f);
          return ret;
        }
        return 0xff;
      },
      io_write(port, val) {
        setMic(0);                                                    // any OUT resets vsync/MIC latch
        const lo = port & 0xff;
        if (lo === 0xfd) { nmiGenerator = false; lastInst = 2; }      // OUT (FD): NMI off
        else if (lo === 0xfe) { nmiGenerator = true; lastInst = 3; }  // OUT (FE): NMI on
        else lastInst = 4;                                            // OUT (FF) etc.
      },
    };

    function readByte(addr) {
      addr &= 0xffff;
      if (mirror) {
        // 16K: 0x2000-0x3FFF is unmapped (no RAM there); reads float to 0xFF.
        if (addr >= 0x2000 && addr < 0x4000) return 0xff;
        // The unconnected A15 mirrors the high window down to low 32K.
        if (addr >= 0x8000) return mem[addr & 0x7fff];
      }
      // 64K pack: A15 is real, so 0x2000-0xFFFF is genuine contiguous RAM.
      return mem[addr];
    }

    // ULA video-DMA fetch: the display generator always clears A15 to read the
    // display file / character bitmaps out of the lower 32K, independent of the
    // RAM pack (the system variables' D_FILE points into low RAM in both modes).
    // This must NOT go through the mode-dependent data mirror.
    function videoRead(addr) { return mem[addr & 0x7fff]; }

    // ULA opcode-fetch substitution for the display region. The interception is
    // gated on hardware address bit A15 (0x8000+), NOT on RAMTOP — A15 is a
    // physical bus line that is set the same way regardless of pack size, so
    // this stays correct when RAMTOP moves up in the 64K configuration.
    function opcodeFetch(address) {
      if (address < 0x8000) return readByte(address);  // normal code/data fetch
      let data = videoRead(address);                   // display file (A15 cleared)
      const bit6 = (data & 0x40) !== 0;
      if (!bit6) {
        // Display byte: fetch char bitmap from ROM and feed shift register;
        // CPU sees a NOP so it advances through the display file.
        const ch = data & 0x3f;
        const I = cpu.getState().i & 0xff;
        let bitmap = 0xff;
        if (I < 64) bitmap = videoRead(((I & 0xfe) << 8) + (ch << 3) + rowCounter);
        shiftReg = bitmap & 0xff;
        return 0x00; // NOP
      }
      return data; // bit6 set (incl. HALT 0x76): execute real opcode
    }

    const cpu = new Z80(core);
    cpu.reset();

    // ---------- main step: run one instruction with ULA timing ----------
    //
    // Timing model (documented shortcut — see NOTES.md):
    //   * /INT is asserted whenever bit 6 of R is 0 (exactly as the ULA derives
    //     it from A6 during refresh). We let Z80.js's own iff1 gate decide
    //     whether RST 0x38 actually runs.
    //   * The Z80 core does NOT refresh R while HALTed, but real DRAM refresh
    //     continues during HALT — that is precisely how the display routine's
    //     "HALT then wait for INT" line-delay terminates. So when the core is
    //     halted we keep advancing R ourselves and fire the maskable INT the
    //     moment R's bit 6 clears, which wakes the CPU at RST 0x38. Without
    //     this the ROM HALTs forever at the first display line and nothing
    //     ever renders (no boot "K" cursor).
    //   * The NMI generator (SLOW mode, toggled by OUT FE/FD) fires the NMI at
    //     each horizontal-retrace (end of scanline) to count blank border
    //     lines, which is what lets FRAMES decrement and the editor blink.
    function bumpR() {
      // emulate one refresh tick: increment low 7 bits of R, keep bit 7.
      const st = cpu.getState();
      const r = (st.r & 0x80) | (((st.r & 0x7f) + 1) & 0x7f);
      st.r = r;
      cpu.setState(st);
      return r;
    }

    function step() {
      lastInst = 0;
      const pre = cpu.getState();

      if (pre.halted) {
        // CPU is HALTed waiting for an interrupt. Keep DRAM refresh alive so
        // the ULA's /INT (R bit6 == 0) eventually fires and ends the line.
        const r = bumpR();
        hsyncCounter -= 4;
        tState += 4;
        if ((r & 0x40) === 0) cpu.interrupt(false, 0xff); // RST 38 wakes HALT
        if (hsyncCounter <= 0) {
          if (nmiGenerator) cpu.interrupt(true, 0);
          hsyncCounter += TS_PER_SCANLINE;
          rowCounter = (rowCounter + 1) & 7;
        }
        return 4;
      }

      m1Address = pre.pc & 0xffff; // next read at PC is the opcode (M1 fetch)
      let ts = cpu.run_instruction() | 0;
      if (ts <= 0) ts = 4;

      hsyncCounter -= ts;
      tState += ts;

      // /INT derived from A6 of refresh address: assert when R bit6 == 0.
      // Z80.js ignores it unless iff1 is set, so this is safe to call always.
      if ((cpu.getState().r & 0x40) === 0) cpu.interrupt(false, 0xff);

      if (hsyncCounter <= 0) {
        if (nmiGenerator) cpu.interrupt(true, 0); // end-of-scanline NMI (SLOW)
        hsyncCounter += TS_PER_SCANLINE;
        rowCounter = (rowCounter + 1) & 7;
      }
      return ts;
    }

    // Run ~ one TV frame (50 Hz). 3.25 MHz / 50 ≈ 65000 T-states.
    function runFrame() {
      let t = 0;
      while (t < 65000) t += step();
    }

    // ---------- display-file rasteriser ----------
    function readScreen() {
      const out = new Uint8Array(32 * 24);
      let p = mem[D_FILE] | (mem[D_FILE + 1] << 8);
      if (p === 0) return out;
      if (mem[p & 0x7fff] === 0x76) p++;        // skip leading newline
      for (let row = 0; row < 24; row++) {
        let col = 0, guard = 0;
        while (guard++ < 33) {
          const code = mem[p & 0x7fff];
          if (code === 0x76) { p++; break; }
          if (col < 32) out[row * 32 + col] = code;
          col++; p++;
        }
      }
      return out;
    }

    function renderInto(imageData) {
      const screen = readScreen();
      const data = imageData.data;
      const W = 256;
      for (let cy = 0; cy < 24; cy++) {
        for (let cx = 0; cx < 32; cx++) {
          const code = screen[cy * 32 + cx];
          const inv = (code & 0x80) ? 0xff : 0x00;
          const glyph = CHARSET + (code & 0x3f) * 8;
          for (let sl = 0; sl < 8; sl++) {
            let bits = rom[glyph + sl] ^ inv;
            const py = cy * 8 + sl;
            for (let px = 0; px < 8; px++) {
              const on = (bits & 0x80) ? 0 : 255; // set bit = black ink
              bits = (bits << 1) & 0xff;
              const off = (py * W + (cx * 8 + px)) * 4;
              data[off] = on; data[off + 1] = on; data[off + 2] = on; data[off + 3] = 255;
            }
          }
        }
      }
    }

    return {
      cpu, mem, rom,
      step, runFrame, readScreen, renderInto,
      setKey, clearKeys, KEYMATRIX,
      get nmiOn() { return nmiGenerator; },
      get ram64k() { return !mirror; },

      // ----- tape bus wiring (the Weather Wall communication layer) -----
      // Absolute machine T-state clock; bus timestamps live in this base.
      tState() { return tState; },
      get micLevel() { return micLevel; },
      // Attach the downlink line to this EAR input. `offset` maps machine time
      // to bus time: busTime = tState + offset. Set offset = busStartT -
      // m.tState() at attach so "now" aligns with the start of the recording.
      attachEar(bus, offset) { earBus = bus || null; earOffset = offset | 0; },
      detachEar() { earBus = null; },
      // Attach this MIC output to an uplink line; edges are emitted at
      // tState + offset. Pass the current bus cursor so slots concatenate.
      attachMic(bus, offset) { micBus = bus || null; micOffset = offset | 0; },
      detachMic() { micBus = null; },
      // Bus-accurate access through the same decode the CPU sees (honours the
      // 16K A15 mirror vs. 64K real high RAM). Use these to test the memory map.
      peek(addr) { return readByte(addr & 0xffff); },
      poke(addr, val) { core.mem_write(addr & 0xffff, val & 0xff); },
      ramtopVar() { return mem[0x4004] | (mem[0x4005] << 8); },
      dfile() { return mem[D_FILE] | (mem[D_FILE + 1] << 8); },
      // Savestate for the ULA/timing state that lives OUTSIDE cpu+mem. A
      // snapshot of mem + cpu.getState() alone is NOT a faithful machine state:
      // restoring it into a machine whose nmiGenerator/hsyncCounter differ from
      // capture time mis-times interrupts and crashes the ROM. Capture/restore
      // these alongside cpu+mem for a complete savestate.
      getMachineState() {
        return { nmiGenerator, hsyncCounter, rowCounter, lastInst, m1Address, tState, micLevel };
      },
      setMachineState(s) {
        if (!s) return;
        nmiGenerator = !!s.nmiGenerator;
        hsyncCounter = s.hsyncCounter | 0;
        rowCounter = s.rowCounter | 0;
        lastInst = s.lastInst | 0;
        m1Address = (s.m1Address === undefined ? -1 : s.m1Address) | 0;
        if (s.tState !== undefined) tState = s.tState;
        if (s.micLevel !== undefined) micLevel = s.micLevel | 0;
      },
    };
  }

  global.ZX81 = ZX81;
  if (typeof module !== "undefined" && module.exports) module.exports = { ZX81 };
})(typeof window !== "undefined" ? window : globalThis);
