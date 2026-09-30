// Deployment config. Relative paths work both locally (web/ served as root) and on GitHub Pages.
export const CONFIG = {
  ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/',
  modelBase: new URL('../models/', import.meta.url).href,        // decoder, MobileCLIP, palette
  roomsUrl: 'https://vqpaint-rooms.vqpaint-rooms.workers.dev',  // Cloudflare worker + Durable Object (web/rooms)
  gridW: 256, gridH: 256,                                          // tokens; 256x256 = 4096 px world, blank = page background
  brushSizes: [4, 6, 8],
  efforts: { quick: 5, normal: 10, long: 20 },                     // seconds of search per stroke
  version: 'v1',
};
