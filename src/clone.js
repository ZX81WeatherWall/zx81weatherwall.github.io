// clone.js — restore a serialized ZX81 machine snapshot (RAM region + CPU regs +
// ULA/timing state) into a fresh machine. This is the whole "clone a live
// running machine" trick: capture once, restore into N machines. Dual module.
(function (g) {
  'use strict';
  function b64ToBytes(b64) {
    if (typeof atob === 'function') {
      const s = atob(b64);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  // restore a snapshot {region:[lo,hi], data:b64, cpu, machine} into machine m.
  function restore(m, snap) {
    const bytes = b64ToBytes(snap.data);
    const lo = snap.region[0];
    for (let i = 0; i < bytes.length; i++) m.poke(lo + i, bytes[i]);
    m.cpu.setState(snap.cpu);
    m.setMachineState(snap.machine);
  }
  g.WW_CLONE = { restore, b64ToBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = { restore, b64ToBytes };
})(typeof window !== 'undefined' ? window : globalThis);
