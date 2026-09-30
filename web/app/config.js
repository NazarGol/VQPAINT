// Deployment config. Relative paths work both locally (web/ served as root) and on GitHub Pages.
export const CONFIG = {
  ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/',
  modelBase: 'https://huggingface.co/noi3noi3/vqpaint-web/resolve/main/',   // decoder, MobileCLIP, palette, bank (CORS ok, CDN-backed)
  modelFallback: new URL('../models/', import.meta.url).href,               // same files on GitHub Pages; used when Hugging Face fails (?models=pages forces it)
  roomsUrl: 'https://vqpaint-rooms.vqpaint-rooms.workers.dev',  // Cloudflare worker + Durable Object (web/rooms)
  gridW: 256, gridH: 256,                                          // tokens; 256x256 = 4096 px world, blank = page background
  brushSizes: [4, 6, 8],
  efforts: { quick: 5, normal: 10, long: 20 },                     // seconds of search per stroke
  blankToken: 6328,           // codebook tile nearest #404040 (export/…: palette_rgb); rooms are filled with it
  blankRgb: 'rgb(68, 61, 60)', // its decoded colour: the page background, so blank canvas has no edge
  version: 'v1',
};
