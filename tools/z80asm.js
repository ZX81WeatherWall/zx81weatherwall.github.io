// z80asm.js — a small two-pass Z80 assembler covering exactly the instruction
// subset used by the Weather Wall on-machine listener/renderer. Not a general
// Z80 assembler; it encodes the forms this project needs and throws on anything
// it doesn't recognise (so a typo fails loudly rather than assembling garbage).
//
// Syntax: one instruction per line. `label:` defines a label. `; ...` comments.
// Directives: ORG nn, EQU (via `NAME EQU expr`), DB b,b,..., DS n[,fill].
// Numbers: decimal, 0x-hex, $hex, or a label. `(nn)` = memory operand.
'use strict';

function assemble(source, org0) {
  const lines = source.split('\n');
  const labels = Object.create(null);
  const equ = Object.create(null);

  // ---- expression evaluation (labels/equ resolved in pass 2) ----
  function val(tok, labelsReady) {
    tok = tok.trim();
    let m;
    if ((m = tok.match(/^0x([0-9a-fA-F]+)$/))) return parseInt(m[1], 16);
    if ((m = tok.match(/^\$([0-9a-fA-F]+)$/))) return parseInt(m[1], 16);
    if ((m = tok.match(/^-?\d+$/))) return parseInt(tok, 10) & 0xffff;
    // expr: A+B or A-B (single op, enough for our needs)
    if ((m = tok.match(/^(.+?)\s*([+\-])\s*(.+)$/))) {
      const a = val(m[1], labelsReady), b = val(m[3], labelsReady);
      return (m[2] === '+' ? a + b : a - b) & 0xffff;
    }
    if (tok in equ) return equ[tok];
    if (labelsReady) {
      if (tok in labels) return labels[tok];
      throw new Error('unknown symbol: ' + tok);
    }
    return 0; // pass 1 placeholder
  }

  // ---- tokenise a line into {label, mnem, ops[]} ----
  function parse(line) {
    line = line.replace(/;.*/, '').trim();
    if (!line) return null;
    let label = null;
    let m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) { label = m[1]; line = m[2].trim(); }
    if (!line) return { label, mnem: null, ops: [] };
    // NAME EQU expr
    m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.*)$/i);
    if (m) return { label, mnem: 'EQU', ops: [m[1], m[2]] };
    const sp = line.indexOf(' ');
    const mnem = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    const ops = rest === '' ? [] : splitOps(rest);
    return { label, mnem, ops };
  }
  function splitOps(s) {
    // split on commas not inside parens
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const parsed = lines.map(parse).filter(Boolean);

  // ---- pass 1: assign addresses / collect labels & equ ----
  let pc = org0 | 0;
  const sized = [];
  for (const ins of parsed) {
    if (ins.mnem === 'EQU') { equ[ins.ops[0]] = val(ins.ops[1], false); continue; }
    if (ins.label) labels[ins.label] = pc;
    if (ins.mnem === null) continue;
    if (ins.mnem === 'ORG') { pc = val(ins.ops[0], false); labels[ins.label] = pc; continue; }
    const size = sizeOf(ins);
    sized.push({ ins, pc });
    pc += size;
  }
  const endPc = pc;

  // ---- pass 2: emit bytes ----
  const bytes = [];
  for (const { ins, pc } of sized) {
    const enc = encode(ins, pc, true);
    for (const b of enc) bytes.push(b & 0xff);
  }
  return { org: org0 | 0, end: endPc, bytes: Uint8Array.from(bytes), labels };

  // ---- helpers ----
  function isMem(op) { return /^\(.*\)$/.test(op); }
  function memArg(op) { return op.slice(1, -1).trim(); }
  function sizeOf(ins) { return encode(ins, 0, false).length; }

  function lo(n) { return n & 0xff; }
  function hi(n) { return (n >> 8) & 0xff; }

  function rel(target, pcAfter) {
    const d = target - pcAfter;
    if (d < -128 || d > 127) throw new Error('JR/DJNZ out of range: ' + d);
    return d & 0xff;
  }

  function encode(ins, pc, ready) {
    const M = ins.mnem, O = ins.ops;
    const A = (i) => O[i];
    const V = (i) => val(O[i], ready);
    const Vm = (i) => val(memArg(O[i]), ready);
    const reg8 = { B: 0, C: 1, D: 2, E: 3, H: 4, L: 5, A: 7 };

    switch (M) {
      case 'DB': {
        const out = [];
        for (const o of O) out.push(lo(val(o, ready)));
        return out;
      }
      case 'DS': {
        const n = val(O[0], ready), fill = O[1] ? lo(val(O[1], ready)) : 0;
        return new Array(n).fill(fill);
      }
      case 'NOP': return [0x00];
      case 'DI': return [0xF3];
      case 'EI': return [0xFB];
      case 'HALT': return [0x76];
      case 'RET': {
        const cc = { NZ: 0xC0, Z: 0xC8, NC: 0xD0, C: 0xD8 };
        if (O.length === 0) return [0xC9];
        if (O[0] in cc) return [cc[O[0]]];
        break;
      }
      case 'RLA': return [0x17];
      case 'RRA': return [0x1F];
      case 'RLCA': return [0x07];
      case 'RRCA': return [0x0F];
      case 'SCF': return [0x37];
      case 'CCF': return [0x3F];
      case 'EXX': return [0xD9];
      case 'EX':
        if (O[0] === 'DE' && O[1] === 'HL') return [0xEB];
        if (O[0] === 'AF' && (O[1] === "AF'" || O[1] === 'AF_')) return [0x08];
        break;
      case 'PUSH': return [{ BC: 0xC5, DE: 0xD5, HL: 0xE5, AF: 0xF5 }[O[0]]];
      case 'POP': return [{ BC: 0xC1, DE: 0xD1, HL: 0xE1, AF: 0xF1 }[O[0]]];
      case 'IN': // IN A,(n)
        if (O[0] === 'A' && isMem(O[1])) return [0xDB, lo(Vm(1))];
        break;
      case 'OUT': // OUT (n),A
        if (isMem(O[0]) && O[1] === 'A') return [0xD3, lo(Vm(0))];
        break;
      case 'SLA': return [0xCB, 0x20 | reg8[O[0]]];
      case 'SRL': return [0xCB, 0x38 | reg8[O[0]]];
      case 'RL': return [0xCB, 0x10 | reg8[O[0]]];
      case 'RR': return [0xCB, 0x18 | reg8[O[0]]];
      case 'INC': {
        const r16 = { BC: 0x03, DE: 0x13, HL: 0x23, SP: 0x33 };
        if (O[0] in r16) return [r16[O[0]]];
        const r8 = { B: 0x04, C: 0x0C, D: 0x14, E: 0x1C, H: 0x24, L: 0x2C, A: 0x3C };
        if (O[0] in r8) return [r8[O[0]]];
        if (O[0] === '(HL)') return [0x34];
        break;
      }
      case 'DEC': {
        const r16 = { BC: 0x0B, DE: 0x1B, HL: 0x2B, SP: 0x3B };
        if (O[0] in r16) return [r16[O[0]]];
        const r8 = { B: 0x05, C: 0x0D, D: 0x15, E: 0x1D, H: 0x25, L: 0x2D, A: 0x3D };
        if (O[0] in r8) return [r8[O[0]]];
        if (O[0] === '(HL)') return [0x35];
        break;
      }
      case 'ADD': // ADD A,n | ADD A,r | ADD HL,rr
        if (O[0] === 'A') {
          if (O[1] in reg8) return [0x80 | reg8[O[1]]];
          if (O[1] === '(HL)') return [0x86];
          return [0xC6, lo(V(1))];
        }
        if (O[0] === 'HL') {
          const r16 = { BC: 0x09, DE: 0x19, HL: 0x29, SP: 0x39 };
          if (O[1] in r16) return [r16[O[1]]];
        }
        break;
      case 'SBC': // SBC A,n | SBC A,r | SBC HL,rr (ED-prefixed)
        if (O[0] === 'HL') {
          const r16 = { BC: 0x42, DE: 0x52, HL: 0x62, SP: 0x72 };
          if (O[1] in r16) return [0xED, r16[O[1]]];
          break;
        }
        if (O[0] === 'A') {
          if (O[1] in reg8) return [0x98 | reg8[O[1]]];
          if (O[1] === '(HL)') return [0x9E];
          return [0xDE, lo(V(1))];
        }
        break;
      case 'SUB': // SUB n | SUB r  (implicit A)
        if (O[0] in reg8) return [0x90 | reg8[O[0]]];
        return [0xD6, lo(V(0))];
      case 'AND':
        if (O[0] in reg8) return [0xA0 | reg8[O[0]]];
        if (O[0] === '(HL)') return [0xA6];
        return [0xE6, lo(V(0))];
      case 'OR':
        if (O[0] in reg8) return [0xB0 | reg8[O[0]]];
        if (O[0] === '(HL)') return [0xB6];
        return [0xF6, lo(V(0))];
      case 'XOR':
        if (O[0] in reg8) return [0xA8 | reg8[O[0]]];
        return [0xEE, lo(V(0))];
      case 'CP':
        if (O[0] in reg8) return [0xB8 | reg8[O[0]]];
        if (O[0] === '(HL)') return [0xBE];
        return [0xFE, lo(V(0))];
      case 'DJNZ': return [0x10, rel(V(0), pc + 2)];
      case 'JR': {
        if (O.length === 1) return [0x18, rel(V(0), pc + 2)];
        const cc = { NZ: 0x20, Z: 0x28, NC: 0x30, C: 0x38 };
        return [cc[O[0]], rel(V(1), pc + 2)];
      }
      case 'JP': {
        if (O.length === 1) {
          if (O[0] === '(HL)') return [0xE9];
          return [0xC3, lo(V(0)), hi(V(0))];
        }
        const cc = { NZ: 0xC2, Z: 0xCA, NC: 0xD2, C: 0xDA };
        return [cc[O[0]], lo(V(1)), hi(V(1))];
      }
      case 'CALL': {
        if (O.length === 1) return [0xCD, lo(V(0)), hi(V(0))];
        const cc = { NZ: 0xC4, Z: 0xCC, NC: 0xD4, C: 0xDC };
        return [cc[O[0]], lo(V(1)), hi(V(1))];
      }
      case 'LD': return encodeLD(O, ready);
    }
    throw new Error('cannot encode: ' + M + ' ' + O.join(', '));

    function encodeLD(O, ready) {
      const dst = O[0], src = O[1];
      const r8 = reg8;
      const r16imm = { BC: 0x01, DE: 0x11, HL: 0x21, SP: 0x31 };
      // LD rr,nn
      if (dst in r16imm && !isMem(src)) {
        const n = val(src, ready);
        return [r16imm[dst], lo(n), hi(n)];
      }
      // LD HL,(nn) / LD (nn),HL
      if (dst === 'HL' && isMem(src)) { const n = val(memArg(src), ready); return [0x2A, lo(n), hi(n)]; }
      if (isMem(dst) && src === 'HL') { const n = val(memArg(dst), ready); return [0x22, lo(n), hi(n)]; }
      // ED-prefixed 16-bit memory loads: LD DE/BC/SP,(nn) and LD (nn),DE/BC/SP
      { const edLoad = { BC: 0x4B, DE: 0x5B, SP: 0x7B }, edStore = { BC: 0x43, DE: 0x53, SP: 0x73 };
        if (dst in edLoad && isMem(src)) { const n = val(memArg(src), ready); return [0xED, edLoad[dst], lo(n), hi(n)]; }
        if (isMem(dst) && src in edStore) { const n = val(memArg(dst), ready); return [0xED, edStore[src], lo(n), hi(n)]; } }
      // LD A,(nn) / LD (nn),A
      if (dst === 'A' && isMem(src) && !/^\((BC|DE|HL)\)$/.test(src)) { const n = val(memArg(src), ready); return [0x3A, lo(n), hi(n)]; }
      if (isMem(dst) && src === 'A' && !/^\((BC|DE|HL)\)$/.test(dst)) { const n = val(memArg(dst), ready); return [0x32, lo(n), hi(n)]; }
      // LD A,(BC)/(DE)/(HL) ; LD (BC)/(DE)/(HL),A
      if (dst === 'A' && src === '(BC)') return [0x0A];
      if (dst === 'A' && src === '(DE)') return [0x1A];
      if (dst === 'A' && src === '(HL)') return [0x7E];
      if (dst === '(BC)' && src === 'A') return [0x02];
      if (dst === '(DE)' && src === 'A') return [0x12];
      // LD r,(HL) / LD (HL),r
      if (dst in r8 && src === '(HL)') return [0x46 | (r8[dst] << 3)];
      if (dst === '(HL)' && src in r8) return [0x70 | r8[src]];
      // LD (HL),n
      if (dst === '(HL)' && !isMem(src)) return [0x36, lo(val(src, ready))];
      // LD r,r'
      if (dst in r8 && src in r8) return [0x40 | (r8[dst] << 3) | r8[src]];
      // LD r,n
      if (dst in r8 && !isMem(src)) return [0x06 | (r8[dst] << 3), lo(val(src, ready))];
      throw new Error('cannot encode LD ' + O.join(', '));
    }
  }
}

if (typeof window !== 'undefined') window.WW_Z80ASM = { assemble };
if (typeof module !== 'undefined' && module.exports) module.exports = { assemble };

// self-test when run directly
if (typeof require !== 'undefined' && require.main === module) {
  const r = assemble(`
    ORG 0x4000
  start:
    DI
    LD HL, 0x6000
    LD B, 24
  loop:
    LD A,(HL)
    INC HL
    DJNZ loop
    IN A,(0xFE)
    RLA
    JR C, start
    OUT (0xFF),A
    LD A,1
    LD (0x6302),A
    RET
  `, 0x4000);
  console.log('bytes', Array.from(r.bytes).map((b) => b.toString(16).padStart(2, '0')).join(' '));
  console.log('labels', r.labels);
}
