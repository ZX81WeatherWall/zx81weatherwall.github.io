///////////////////////////////////////////////////////////////////////////////
// tapebus.js — the ZX81 Weather Wall communication substrate.
//
// EVERYTHING in this project — gateway->machine weather frames, machine->gateway
// ACKs, and the boot-time program broadcast — travels as edges on a *tape bus*:
// a single, shared, T-state-timestamped square-wave line, exactly like a ZX81
// cassette lead. There is no host memory-poking of graphics; the only thing the
// host does is drive/read this line (physically: a sound card / distribution amp
// on MIC-out, a summing mixer on EAR-in).
//
// Two physical lines exist in the wall:
//   * DOWNLINK  — one gateway MIC -> distribution amp -> all 100 EAR inputs in
//                 parallel (broadcast party line, one-way).
//   * UPLINK    — all 100 MICs -> passive summing mixer -> gateway EAR. Strict
//                 TDMA: only the addressed machine transmits in its slot.
//
// A TapeBus is one such line. Because the downlink is a *recording* of edges in
// a global T-state timeline, any machine can consume it deterministically at any
// wall-clock time — which is what lets tile reception fan out across Web Workers
// (browser) or serialize in Node without breaking physical fidelity. Uplink TDMA
// slots are serialized by construction.
//
// Units: the ZX81 Z80 runs at 3.25 MHz, so 1 µs = 3.25 T-states. All timings in
// this file are in T-states (integer) to match the emulator's own clock.
///////////////////////////////////////////////////////////////////////////////

(function (global) {
  "use strict";

  const CPU_HZ = 3250000;               // 3.25 MHz
  const US = CPU_HZ / 1e6;              // 3.25 T-states per microsecond
  const us = (n) => Math.round(n * US); // microseconds -> T-states

  //===========================================================================
  // TapeBus — a timestamped square-wave line.
  //
  // Internally: a sorted list of edges {t, level}. level is 0/1. `sample(t)`
  // returns the line level at absolute T-state t (the level of the last edge at
  // or before t). Emitters append edges; a real party line just wire-ORs, but
  // our TDMA discipline means at most one emitter is active at any instant, so
  // an insert-sorted edge list is a faithful model.
  //===========================================================================
  class TapeBus {
    constructor() {
      this.edges = [{ t: 0, level: 0 }]; // idle low
    }
    reset() { this.edges = [{ t: 0, level: 0 }]; }

    // Force the line to `level` at absolute time t. No-op if already at level
    // (edges record *transitions* only). Insert-sorted so multiple emitters at
    // interleaved (TDMA) times compose correctly.
    emit(t, level) {
      t = t | 0; level = level ? 1 : 0;
      const e = this.edges;
      // Fast path: appending at the end (the common case).
      if (t >= e[e.length - 1].t) {
        if (e[e.length - 1].level === level) return;
        e.push({ t, level });
        return;
      }
      // Slow path: locate insertion point.
      let i = e.length - 1;
      while (i > 0 && e[i].t > t) i--;
      if (e[i].level === level) return;
      e.splice(i + 1, 0, { t, level });
    }

    // Level at absolute time t (binary search for last edge <= t).
    sample(t) {
      const e = this.edges;
      let lo = 0, hi = e.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (e[mid].t <= t) { ans = e[mid].level; lo = mid + 1; }
        else hi = mid - 1;
      }
      return ans;
    }

    // Last timestamp any edge was recorded at (== end of the current signal).
    get lastT() { return this.edges[this.edges.length - 1].t; }

    // Rising/falling edge list within [t0,t1) as [{t,level}], for demodulators
    // that prefer edges over polling.
    edgesIn(t0, t1) {
      return this.edges.filter((e) => e.t >= t0 && e.t < t1);
    }
  }

  //===========================================================================
  // A tiny square-wave EMITTER that writes pulses onto a bus starting at some
  // T-state, tracking a running cursor. Both codecs build on it.
  //===========================================================================
  class Pen {
    constructor(bus, t0) { this.bus = bus; this.t = t0 | 0; }
    // hold current level for `dt` T-states
    hold(dt) { this.t += dt | 0; }
    // a HIGH excursion of width `hi` then LOW for `lo` (one pulse)
    pulse(hi, lo) {
      this.bus.emit(this.t, 1); this.t += hi | 0;
      this.bus.emit(this.t, 0); this.t += lo | 0;
    }
    low(dt) { this.bus.emit(this.t, 0); this.t += dt | 0; }
  }

  //===========================================================================
  // ROM-STANDARD codec — the genuine ZX81 cassette format, used for the boot
  // broadcast (all 100 machines run the ROM LOAD from the shared line).
  //
  // Verified against the 8K ROM (SAVE at $0329: `SBC A,A; AND 05; ADD 04` -> a
  // pulse count of 4 for a '0' bit and 9 for a '1' bit; LOAD at $0350 reads the
  // EAR on bit 7 of IN A,($FE)). We reproduce that structure with period-
  // plausible half-cycles. This codec is self-consistent (modulate<->demodulate
  // byte-exact); the *real* ROM round-trip is proved separately by feeding a
  // real ROM SAVE's captured MIC edges into a real ROM LOAD (tools/proof-*).
  //===========================================================================
  const ROM = {
    HALF: us(150),        // ~150 µs half-cycle
    ZERO_PULSES: 4,       // '0' bit  -> 4 pulses
    ONE_PULSES: 9,        // '1' bit  -> 9 pulses
    BIT_GAP: us(1300),    // ~1300 µs silence between bits
    LEADIN_BITS: 8,       // a few '1' bits of lead-in tone

    modulate(bus, t0, bytes) {
      const pen = new Pen(bus, t0);
      const emitBit = (b) => {
        const n = b ? this.ONE_PULSES : this.ZERO_PULSES;
        for (let i = 0; i < n; i++) pen.pulse(this.HALF, this.HALF);
        pen.low(this.BIT_GAP);
      };
      for (let i = 0; i < this.LEADIN_BITS; i++) emitBit(1);
      for (const byte of bytes)
        for (let bit = 7; bit >= 0; bit--) emitBit((byte >> bit) & 1);
      return pen.t;
    },

    // Demodulate by counting HIGH pulses between long (>BIT_GAP/2) silences.
    demodulate(bus, t0, t1) {
      const edges = bus.edgesIn(t0, t1);
      const bits = [];
      let pulses = 0, lastHighEnd = t0, seen = false;
      const GAP_THRESH = this.BIT_GAP / 2;
      const flush = () => {
        if (!seen) return;
        bits.push(pulses >= (this.ZERO_PULSES + this.ONE_PULSES) / 2 ? 1 : 0);
        pulses = 0; seen = false;
      };
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.level === 1) {
          if (e.t - lastHighEnd > GAP_THRESH) flush();
          pulses++; seen = true;
        } else {
          lastHighEnd = e.t;
        }
      }
      flush();
      // strip lead-in ones then pack bytes
      let start = 0;
      while (start < bits.length && bits[start] === 1 &&
             start < this.LEADIN_BITS) start++;
      const bytes = [];
      for (let i = start; i + 8 <= bits.length; i += 8) {
        let b = 0;
        for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
        bytes.push(b);
      }
      return bytes;
    },
  };

  //===========================================================================
  // FAST codec — the custom machine-code data plane (period-authentic; custom
  // ZX81 fast loaders were common). Self-clocking pulse-WIDTH encoding so a
  // hand-written Z80 bit-banger can decode it with one counting loop and no
  // byte-alignment guesswork:
  //
  //   each symbol = one HIGH excursion (mark) followed by a LOW gap (space);
  //   the HIGH width selects the symbol:
  //       '0'    short HIGH
  //       '1'    long  HIGH
  //       START  extra-long HIGH  (frame delimiter; never occurs mid-byte)
  //
  // A frame is:  START  ADDR(8)  LEN(8)  PAYLOAD(8*LEN)  CKSUM(8)
  // where CKSUM = (ADDR + LEN + sum(PAYLOAD)) & 0xFF. Because START is the only
  // extra-long pulse, a receiver locks onto frame boundaries by width alone —
  // a machine whose address doesn't match simply resumes hunting for the next
  // START, skipping the rest of the frame with no bit accounting.
  //
  // Timings are chosen so the width classes are separated by many Z80 poll-loop
  // iterations (~40 T-states each), giving the bit-banger comfortable margin.
  //===========================================================================
  const FAST = {
    ZERO_HI: 380,         // ~117 µs
    ONE_HI: 950,          // ~292 µs
    START_HI: 1600,       // ~492 µs
    GAP: 380,             // low space after each mark
    LEADIN: 6,            // '1' marks of lead-in before a burst of frames

    // classification thresholds (T-states of HIGH width)
    TH_01: (380 + 950) / 2,     // 665: below -> 0, above -> 1
    TH_1S: (950 + 1600) / 2,    // 1275: above -> START

    _mark(pen, hi) { pen.pulse(hi, this.GAP); },
    _byte(pen, v) {
      for (let bit = 7; bit >= 0; bit--)
        this._mark(pen, ((v >> bit) & 1) ? this.ONE_HI : this.ZERO_HI);
    },

    checksum(addr, payload) {
      let s = (addr + payload.length) & 0xff;
      for (const b of payload) s = (s + b) & 0xff;
      return s;
    },

    // Modulate one addressed frame; returns the end T-state. opts.badChecksum
    // transmits a deliberately wrong checksum (a corrupted frame the receiver
    // must reject and NAK) — used to prove selective retransmit.
    modulateFrame(bus, t0, addr, payload, opts) {
      const pen = new Pen(bus, t0);
      for (let i = 0; i < this.LEADIN; i++) this._mark(pen, this.ONE_HI);
      this._mark(pen, this.START_HI);          // START
      this._byte(pen, addr & 0xff);
      this._byte(pen, payload.length & 0xff);
      for (const b of payload) this._byte(pen, b & 0xff);
      let ck = this.checksum(addr, payload);
      if (opts && opts.badChecksum) ck = (ck ^ 0xff) & 0xff;
      this._byte(pen, ck);
      return pen.t;
    },

    // Modulate one ACK/NAK symbol in a machine's uplink slot: START then one
    // status byte (0x06 ACK, 0x15 NAK — the real ASCII ACK/NAK codes).
    ACK: 0x06, NAK: 0x15,
    modulateAck(bus, t0, addr, ok) {
      const pen = new Pen(bus, t0);
      this._mark(pen, this.START_HI);
      this._byte(pen, addr & 0xff);
      this._byte(pen, ok ? this.ACK : this.NAK);
      return pen.t;
    },

    // Software demodulator (mirror of the Z80 decoder) — used by the gateway to
    // read uplink ACKs and by the loopback unit test. Walks HIGH-pulse widths.
    _pulseWidths(bus, t0, t1) {
      const edges = bus.edgesIn(t0, t1);
      const widths = [];
      let riseT = -1;
      for (const e of edges) {
        if (e.level === 1) riseT = e.t;
        else if (riseT >= 0) { widths.push(e.t - riseT); riseT = -1; }
      }
      return widths;
    },
    _classify(w) { return w > this.TH_1S ? 'S' : (w > this.TH_01 ? 1 : 0); },

    // Decode the FIRST frame found at/after t0 whose START is present. Returns
    // {addr,len,payload,cksum,ok, endWidthIndex} or null.
    demodulateFrame(bus, t0, t1) {
      const widths = this._pulseWidths(bus, t0, t1).map((w) => this._classify(w));
      let i = 0;
      while (i < widths.length && widths[i] !== 'S') i++;
      if (i >= widths.length) return null;
      i++; // consume START
      const readByte = () => {
        if (i + 8 > widths.length) return null;
        let v = 0;
        for (let k = 0; k < 8; k++) {
          const b = widths[i++];
          if (b === 'S') return null; // unexpected START -> malformed
          v = (v << 1) | b;
        }
        return v;
      };
      const addr = readByte(); if (addr === null) return null;
      const len = readByte(); if (len === null) return null;
      const payload = [];
      for (let k = 0; k < len; k++) {
        const b = readByte(); if (b === null) return null;
        payload.push(b);
      }
      const cksum = readByte(); if (cksum === null) return null;
      const ok = cksum === this.checksum(addr, payload);
      return { addr, len, payload, cksum, ok };
    },

    // ---- variable-length TEXT uplink (the REPORTER's bulletin) --------------
    // The 101st "reporter" machine composes a <=300-char bulletin and ships it
    // out its MIC line as a short burst of TEXT frames, each <=64 payload bytes,
    // multi-frame with a sequence number so the gateway can reassemble:
    //
    //   START  ADDR(8)  SEQ(8)  LEN(8)  PAYLOAD(8*LEN)  CKSUM(8)
    //   SEQ bit7 = last-frame flag; bits0-6 = frame index.
    //   CKSUM = (ADDR + SEQ + LEN + sum(PAYLOAD)) & 0xFF.
    //
    // The gateway ACK/NAKs each frame on the downlink (reusing modulateAck with
    // the reporter's address); the reporter retransmits any NAKed frame. This
    // mirrors the tile ACK path, inverted (machine talks, gateway acknowledges).
    textChecksum(addr, seq, payload) {
      let s = (addr + seq + payload.length) & 0xff;
      for (const b of payload) s = (s + b) & 0xff;
      return s;
    },
    modulateText(bus, t0, addr, seq, payload, opts) {
      const pen = new Pen(bus, t0);
      this._mark(pen, this.START_HI);
      this._byte(pen, addr & 0xff);
      this._byte(pen, seq & 0xff);
      this._byte(pen, payload.length & 0xff);
      for (const b of payload) this._byte(pen, b & 0xff);
      let ck = this.textChecksum(addr, seq, payload);
      if (opts && opts.badChecksum) ck = (ck ^ 0xff) & 0xff;
      this._byte(pen, ck);
      return pen.t;
    },
    // Decode EVERY text frame in [t0,t1), in order. Robust to the giant HIGH the
    // reporter's receive loop leaves on its MIC between frames (an IN A,(FE) sets
    // the MIC latch and readsym never clears it until the next transmit) — that
    // reads as one over-wide 'S' pulse; a parse attempt there hits an unexpected
    // START inside a byte, returns null, and the scan advances to the real START.
    // Returns [{addr,seq,len,payload,cksum,ok}] — retransmits appear as repeats.
    demodulateAllText(bus, t0, t1) {
      const widths = this._pulseWidths(bus, t0, t1).map((w) => this._classify(w));
      const out = [];
      let s = 0;
      while (s < widths.length) {
        while (s < widths.length && widths[s] !== 'S') s++;
        if (s >= widths.length) break;
        let i = s + 1;
        const readByte = () => {
          if (i + 8 > widths.length) return null;
          let v = 0;
          for (let k = 0; k < 8; k++) { const b = widths[i++]; if (b === 'S') return null; v = (v << 1) | b; }
          return v;
        };
        const addr = readByte();
        const seq = addr === null ? null : readByte();
        const len = seq === null ? null : readByte();
        if (len === null || len > 64) { s++; continue; }
        const payload = [];
        let bad = false;
        for (let k = 0; k < len; k++) { const b = readByte(); if (b === null) { bad = true; break; } payload.push(b); }
        if (bad) { s++; continue; }
        const cksum = readByte();
        if (cksum === null) { s++; continue; }
        out.push({ addr, seq, len, payload, cksum, ok: cksum === this.textChecksum(addr, seq, payload) });
        s = i; // consume the parsed frame
      }
      return out;
    },

    // Decode an ACK symbol (START + addr + status). Robust to spurious leading
    // pulses (a receiving machine holds MIC high through its receive loop, which
    // reads as one giant pulse before the real ACK): scan every START candidate.
    // Returns the LAST valid ACK/NAK in the window — so after a NAK->retransmit
    // ->ACK exchange the gateway sees the machine's final word (the ACK).
    demodulateAck(bus, t0, t1) {
      const widths = this._pulseWidths(bus, t0, t1).map((w) => this._classify(w));
      let s = 0, result = null;
      while (s < widths.length) {
        while (s < widths.length && widths[s] !== 'S') s++;
        if (s >= widths.length) break;
        let i = s + 1;
        const readByte = () => {
          if (i + 8 > widths.length) return null;
          let v = 0;
          for (let k = 0; k < 8; k++) { const b = widths[i++]; if (b === 'S') return null; v = (v << 1) | b; }
          return v;
        };
        const addr = readByte();
        const status = addr === null ? null : readByte();
        if (status === this.ACK || status === this.NAK)
          result = { addr, ok: status === this.ACK, status };
        s++;
      }
      return result;
    },
  };

  const API = { TapeBus, Pen, ROM, FAST, CPU_HZ, us };
  global.WW_TAPEBUS = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
