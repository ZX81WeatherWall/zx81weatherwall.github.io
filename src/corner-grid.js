// corner-grid.js — build the SHARED tile-corner grid for the marching-squares contour.
//
// Each ZX81 draws its own curves from the four scalar field bytes at ITS tile corners.
// For the curves to meet seam-to-seam, a corner shared by neighbouring tiles must be the
// SAME byte for both — guaranteed here by construction: the (cols+1)x(rows+1) node grid is
// computed ONCE (each node = the mean of the <=4 tile centres touching it), then every tile
// reads its four nodes out of that one grid. Host-side data prep only; the machine does the
// geometry. See src/contour-plot.js (oracle) and tools/z80-contour.js (the Z80 port).
(function (g) {
  'use strict';

  // centres: field bytes at each tile centre, row-major length cols*rows (0..255).
  // Returns the (cols+1)*(rows+1) node grid, row-major, each an integer byte (rounded mean).
  function cornerNodes(centres, cols, rows) {
    const nodes = new Array((cols + 1) * (rows + 1));
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        let sum = 0, n = 0;
        // the <=4 tiles meeting at node (c,r): (c-1,r-1),(c,r-1),(c-1,r),(c,r)
        for (const [tc, tr] of [[c - 1, r - 1], [c, r - 1], [c - 1, r], [c, r]]) {
          if (tc >= 0 && tc < cols && tr >= 0 && tr < rows) { sum += centres[tr * cols + tc] & 0xff; n++; }
        }
        nodes[r * (cols + 1) + c] = n ? Math.round(sum / n) & 0xff : 0;
      }
    }
    return nodes;
  }

  // Per-tile corners {nw,ne,se,sw}, row-major length cols*rows. Adjacent tiles share the
  // node values exactly (tile A's ne == tile B's nw when B is A's east neighbour), so the
  // Z80 cross() computes the identical sub-pixel crossing on the shared edge -> lines meet.
  function buildCornerGrid(centres, cols, rows) {
    const nodes = cornerNodes(centres, cols, rows);
    const stride = cols + 1;
    const out = new Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        out[row * cols + col] = {
          nw: nodes[row * stride + col],
          ne: nodes[row * stride + col + 1],
          sw: nodes[(row + 1) * stride + col],
          se: nodes[(row + 1) * stride + col + 1],
        };
      }
    }
    return out;
  }

  const API = { cornerNodes, buildCornerGrid };
  g.WW_CORNERGRID = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
