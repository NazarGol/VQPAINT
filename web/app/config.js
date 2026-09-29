// Deployment config. Relative paths work both locally (web/ served as root) and on GitHub Pages.
export const CONFIG = {
  ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/',
  modelBase: new URL('../models/', import.meta.url).href,        // decoder, MobileCLIP, palette
  roomsUrl: 'https://vqpaint-rooms.golianych-nazar.workers.dev',  // Cloudflare worker (set after deploy)
  gridW: 32, gridH: 32,                                            // tokens; 32x32 = 512 px canvas
  brushSizes: [4, 6, 8],
  efforts: { quick: 5, normal: 10, long: 20 },                     // seconds of search per stroke
  version: 'v1',
};
