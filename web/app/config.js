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
  ink: { size: 110, speed: 0.5, viscosity: 0.45, lobes: 3, lobeLength: 0.6, tendrils: 0.6, satellites: 0.5, holes: 0.3, twin: 0.25, stretch: 0.4, roughness: 0.5, weird: 0.5 },   // the ink's base settings (app/effects.html "copy settings" gives this line); size is overridden per stroke
  version: 'v1',
};
