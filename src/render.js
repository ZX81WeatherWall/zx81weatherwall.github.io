// render.js — turn a ZX81 machine's display into pixels. Dual module.
// The machine exposes renderInto(imageData) which fills a 256x192 RGBA buffer
// (set pixel = black ink on white). We wrap it for Node (plain object) and the
// browser (real ImageData via a canvas 2d context).
(function (g) {
  'use strict';
  const W = 256, H = 192;
  // returns { width, height, data:Uint8ClampedArray(W*H*4) }
  function newImageData() {
    return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  }
  function renderRGBA(m) {
    const img = newImageData();
    m.renderInto(img);
    return img;
  }
  // RGBA -> packed RGB Buffer/array (for PNG). Node returns Buffer via caller.
  function rgbaToRGB(rgba, out) {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; out[j + 2] = rgba[i + 2];
    }
    return out;
  }
  const R = { W, H, newImageData, renderRGBA, rgbaToRGB };
  g.WW_RENDER = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
