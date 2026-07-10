/* polotno M2.5 frontend.
   View transform: screen = world * k + (px, py). Last-fetched view is a
   sprite pinned to its world rect; pan/zoom move it locally, a debounced
   refetch swaps in fresh pixels.
   Tools: place (soft square), brush (freeform mask), image (place a PNG
   and VQGAN-ify it in), wand (select similar color, generate into it).
   Right/middle drag always pans. */

let WORLD = 8192;

const app = new PIXI.Application({
  resizeTo: window, background: 0x0e0e12, antialias: true,
});
document.body.appendChild(app.view);

const viewSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
const border = new PIXI.Graphics();
const strokeGfx = new PIXI.Graphics();
const selSprite = new PIXI.Sprite(PIXI.Texture.EMPTY); selSprite.visible = false;
const imgSprite = new PIXI.Sprite(PIXI.Texture.EMPTY); imgSprite.visible = false;
imgSprite.alpha = 0.55;
const jobGfx = new PIXI.Graphics();
const jobLabels = new PIXI.Container();
const brushGfx = new PIXI.Graphics();
app.stage.addChild(viewSprite, border, selSprite, strokeGfx, jobGfx, jobLabels, imgSprite, brushGfx);

let k = 0.1, px = 40, py = 40;
let fetchRect = null;
let activeJobs = [];
let mouse = { x: -1e9, y: -1e9 };
let tool = "place";                 // 'place' | 'brush' | 'image' | 'wand'
let strokes = [];                   // brush: [{r, pts:[{x,y}..]}] world coords
let selection = null;               // wand: {bbox, mask_png}
let importImg = null;               // image: {b64, w, h, texture}
let bleedFromPt = null;             // [x, y] world or null
let pickingBleed = false;

const $ = (id) => document.getElementById(id);
const worldX = (sx) => (sx - px) / k;
const worldY = (sy) => (sy - py) / k;

function fitWorld() {
  k = Math.min(innerWidth, innerHeight) / WORLD * 0.92;
  px = (innerWidth - WORLD * k) / 2;
  py = (innerHeight - WORLD * k) / 2;
}

function redraw() {
  if (fetchRect) {
    viewSprite.x = px + fetchRect.x0 * k;
    viewSprite.y = py + fetchRect.y0 * k;
    viewSprite.width = (fetchRect.x1 - fetchRect.x0) * k;
    viewSprite.height = (fetchRect.y1 - fetchRect.y0) * k;
  }
  border.clear().lineStyle(1, 0x3a3a48, 1).drawRect(px, py, WORLD * k, WORLD * k);
  if (bleedFromPt) {
    border.lineStyle(1.5, 0x6ab8e0, 0.9)
          .drawCircle(px + bleedFromPt[0] * k, py + bleedFromPt[1] * k, 14)
          .moveTo(px + bleedFromPt[0] * k - 20, py + bleedFromPt[1] * k)
          .lineTo(px + bleedFromPt[0] * k + 20, py + bleedFromPt[1] * k);
  }

  strokeGfx.clear();
  for (const s of strokes) {
    strokeGfx.lineStyle({ width: 2 * s.r * k, color: 0x7fc97a, alpha: 0.3,
                          cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    if (s.pts.length === 1) {
      strokeGfx.lineStyle(0).beginFill(0x7fc97a, 0.3)
        .drawCircle(px + s.pts[0].x * k, py + s.pts[0].y * k, s.r * k).endFill();
    } else {
      strokeGfx.moveTo(px + s.pts[0].x * k, py + s.pts[0].y * k);
      for (let i = 1; i < s.pts.length; i++)
        strokeGfx.lineTo(px + s.pts[i].x * k, py + s.pts[i].y * k);
    }
  }

  if (selection) {
    const [bx, by, bw, bh] = selection.bbox;
    selSprite.x = px + bx * k; selSprite.y = py + by * k;
    selSprite.width = bw * k; selSprite.height = bh * k;
    selSprite.visible = true;
  } else selSprite.visible = false;

  jobGfx.clear();
  jobLabels.removeChildren().forEach((c) => c.destroy());
  for (const j of activeJobs) {
    if (!["running", "queued", "error"].includes(j.status)) continue;
    const [bx, by, bw, bh] = j.bbox;
    const col = j.status === "error" ? 0xe06a6a : j.status === "running" ? 0xe8c46a : 0x8888c8;
    jobGfx.lineStyle(1.5, col, 0.9).drawRect(px + bx * k, py + by * k, bw * k, bh * k);
    const label = new PIXI.Text(
      j.status === "running" ? `${j.iter}/${j.iterations}` : j.status,
      { fontSize: 12, fill: col, fontFamily: "monospace" });
    label.x = px + bx * k + 4; label.y = py + by * k + 4;
    jobLabels.addChild(label);
  }

  // cursor preview
  brushGfx.clear();
  imgSprite.visible = false;
  if (mouse.x > -1e8) {
    if (pickingBleed) {
      brushGfx.lineStyle(1.5, 0x6ab8e0, 0.9).drawCircle(mouse.x, mouse.y, 14);
    } else if (tool === "place") {
      const s = +$("size").value * k;
      brushGfx.lineStyle(1, 0x7fc97a, 0.55)
              .drawRect(mouse.x - s / 2, mouse.y - s / 2, s, s);
    } else if (tool === "brush") {
      brushGfx.lineStyle(1, 0x7fc97a, 0.8)
              .drawCircle(mouse.x, mouse.y, +$("radius").value * k);
    } else if (tool === "image" && importImg) {
      const w = +$("size").value * k;
      const h = w * importImg.h / importImg.w;
      imgSprite.x = mouse.x - w / 2; imgSprite.y = mouse.y - h / 2;
      imgSprite.width = w; imgSprite.height = h;
      imgSprite.visible = true;
      brushGfx.lineStyle(1, 0xe0c46a, 0.8)
              .drawRect(mouse.x - w / 2, mouse.y - h / 2, w, h);
    } else if (tool === "wand") {
      brushGfx.lineStyle(1, 0xc98fe0, 0.9).drawCircle(mouse.x, mouse.y, 6);
    }
  }
}

// ---- view fetching ------------------------------------------------

let fetching = false, needFetch = false, fetchTimer = null;

function scheduleFetch(delay = 220) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(fetchView, delay);
}

async function fetchView() {
  if (fetching) { needFetch = true; return; }
  fetching = true;
  const r = { x0: worldX(0), y0: worldY(0), x1: worldX(innerWidth), y1: worldY(innerHeight) };
  const w = Math.min(Math.round(innerWidth), 2048);
  const h = Math.min(Math.round(innerHeight), 2048);
  try {
    const res = await fetch(`/view?x0=${r.x0}&y0=${r.y0}&x1=${r.x1}&y1=${r.y1}&w=${w}&h=${h}&t=${Date.now()}`);
    if (res.ok) {
      const bmp = await createImageBitmap(await res.blob());
      const old = viewSprite.texture;
      viewSprite.texture = PIXI.Texture.from(bmp);
      fetchRect = r;
      if (old && old !== PIXI.Texture.EMPTY) old.destroy(true);
      redraw();
    }
  } catch (e) { console.error(e); }
  fetching = false;
  if (needFetch) { needFetch = false; scheduleFetch(50); }
}

// ---- input --------------------------------------------------------

let down = null, moved = false, panning = false, drawing = null;

app.view.addEventListener("pointerdown", (e) => {
  if (e.button === 1 || e.button === 2) {
    panning = true; down = { x: e.clientX, y: e.clientY };
    return;
  }
  if (e.button !== 0) return;
  if (pickingBleed) return;  // handled on pointerup
  if (tool === "brush") {
    drawing = { r: +$("radius").value, pts: [{ x: worldX(e.clientX), y: worldY(e.clientY) }] };
    strokes.push(drawing);
    selection = null;
    $("brushActions").style.display = "flex";
    redraw();
  } else if (tool === "place") {
    down = { x: e.clientX, y: e.clientY }; moved = false;
  }
});
window.addEventListener("pointermove", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (panning && down) {
    px += e.clientX - down.x; py += e.clientY - down.y;
    down = { x: e.clientX, y: e.clientY };
    scheduleFetch();
  } else if (drawing) {
    const wx = worldX(e.clientX), wy = worldY(e.clientY);
    const last = drawing.pts[drawing.pts.length - 1];
    if (Math.hypot(wx - last.x, wy - last.y) > drawing.r * 0.3)
      drawing.pts.push({ x: wx, y: wy });
  } else if (down && tool === "place") {
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) { px += dx; py += dy; down = { x: e.clientX, y: e.clientY }; scheduleFetch(); }
  }
  $("coords").textContent =
    `${Math.round(worldX(e.clientX))}, ${Math.round(worldY(e.clientY))} · zoom ${k.toFixed(2)}`;
  redraw();
});
window.addEventListener("pointerup", (e) => {
  if (panning) { panning = false; down = null; return; }
  if (drawing) { drawing = null; return; }
  if (e.target !== app.view) { down = null; return; }
  const wx = worldX(e.clientX), wy = worldY(e.clientY);
  if (pickingBleed) {
    bleedFromPt = [wx, wy];
    pickingBleed = false;
    $("bleedFrom").textContent = `⊙ ${Math.round(wx)}, ${Math.round(wy)}`;
    $("bleedFromClear").style.display = "";
    redraw();
  } else if (tool === "place" && down && !moved) {
    paintSquare(wx, wy);
  } else if (tool === "image" && importImg) {
    placeImage(wx, wy);
  } else if (tool === "wand") {
    wandSelect(wx, wy);
  }
  down = null;
});
app.view.addEventListener("contextmenu", (e) => e.preventDefault());
app.view.addEventListener("wheel", (e) => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0012);
  const nk = Math.min(8, Math.max(0.005, k * f));
  const real = nk / k;
  px = e.clientX - (e.clientX - px) * real;
  py = e.clientY - (e.clientY - py) * real;
  k = nk;
  redraw(); scheduleFetch();
}, { passive: false });
window.addEventListener("resize", () => { redraw(); scheduleFetch(); });
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  if (e.key === "Escape") { clearPending(); pickingBleed = false; redraw(); }
  if (e.key === "Enter" && (strokes.length || selection)) generatePending();
});

// ---- tools --------------------------------------------------------

function setTool(t) {
  tool = t;
  for (const [id, name] of [["toolPlace", "place"], ["toolBrush", "brush"],
                            ["toolImage", "image"], ["toolWand", "wand"]])
    $(id).classList.toggle("active", t === name);
  $("brushRow").style.display = t === "brush" ? "flex" : "none";
  $("wandRow").style.display = t === "wand" ? "flex" : "none";
  $("imageRow").style.display = t === "image" ? "block" : "none";
  if (t !== "brush" && t !== "wand") clearPending();
  redraw();
}
$("toolPlace").onclick = () => setTool("place");
$("toolBrush").onclick = () => setTool("brush");
$("toolWand").onclick = () => setTool("wand");
$("toolImage").onclick = () => {
  if (tool === "image" && importImg) { setTool("place"); return; }
  $("imageFile").click();
};
$("imageFile").addEventListener("change", async () => {
  const f = $("imageFile").files[0];
  if (!f) return;
  const b64 = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.readAsDataURL(f);
  });
  const bmp = await createImageBitmap(f);
  if (importImg && importImg.texture) importImg.texture.destroy(true);
  importImg = { b64, w: bmp.width, h: bmp.height, texture: PIXI.Texture.from(bmp) };
  imgSprite.texture = importImg.texture;
  $("imageFile").value = "";
  setTool("image");
});

function clearPending() {
  strokes = []; drawing = null; selection = null;
  $("brushActions").style.display = "none";
  redraw();
}
$("clearBrush").onclick = clearPending;
$("genBrush").onclick = () => generatePending();

$("bleedFrom").onclick = () => { pickingBleed = true; };
$("bleedFromClear").onclick = () => {
  bleedFromPt = null;
  $("bleedFrom").textContent = "⊙ bleed from…";
  $("bleedFromClear").style.display = "none";
  redraw();
};

function commonParams() {
  return {
    prompt: $("prompt").value,
    falloff: +$("falloff").value,
    iterations: +$("iters").value,
    seed: $("seed").value.trim() === "" ? null : +$("seed").value,
    lr: +$("lr").value,
    cutn: +$("cutn").value,
    start_noise: +$("noise").value / 100,
    w_img: +$("wimg").value,
    w_text: +$("wtext").value,
    hold: +$("hold").value,
    cut_method: $("cutmethod").value,
    bleed_drift: +$("drift").value,
    bleed_from: bleedFromPt,
  };
}

async function paintSquare(wx, wy) {
  if (wx < 0 || wy < 0 || wx > WORLD || wy > WORLD) return;
  await submitPaint({ ...commonParams(), x: wx, y: wy, size: +$("size").value });
}

async function placeImage(wx, wy) {
  const w = Math.round(+$("size").value);
  const h = Math.round(w * importImg.h / importImg.w);
  await submitPaint({
    ...commonParams(),
    bbox: [Math.round(wx - w / 2), Math.round(wy - h / 2), w, h],
    source_png: importImg.b64,
    source_strength: +$("strength").value,
  });
}

async function wandSelect(wx, wy) {
  if (wx < 0 || wy < 0 || wx > WORLD || wy > WORLD) return;
  const res = await fetch("/select", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: wx, y: wy, tolerance: +$("tolerance").value }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.detail || `select failed (${res.status})`);
    return;
  }
  selection = await res.json();
  strokes = [];
  // tinted overlay from the mask
  const raw = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${selection.mask_png}`)).blob());
  const c = document.createElement("canvas");
  c.width = raw.width; c.height = raw.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(raw, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "#7fc97a";
  ctx.fillRect(0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < data.data.length; i += 4)
    data.data[i + 3] = data.data[i + 1] > 40 ? 110 : 0;
  ctx.putImageData(data, 0, 0);
  const old = selSprite.texture;
  selSprite.texture = PIXI.Texture.from(c);
  if (old && old !== PIXI.Texture.EMPTY) old.destroy(true);
  $("brushActions").style.display = "flex";
  redraw();
}

async function generatePending() {
  if (selection) {
    const ok = await submitPaint({
      ...commonParams(),
      bbox: selection.bbox, mask_png: selection.mask_png,
    });
    if (ok) clearPending();
    return;
  }
  if (!strokes.length) return;
  const falloff = +$("falloff").value;
  let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
  for (const s of strokes) for (const p of s.pts) {
    x0 = Math.min(x0, p.x - s.r); y0 = Math.min(y0, p.y - s.r);
    x1 = Math.max(x1, p.x + s.r); y1 = Math.max(y1, p.y + s.r);
  }
  x0 = Math.floor(x0 - falloff); y0 = Math.floor(y0 - falloff);
  x1 = Math.ceil(x1 + falloff); y1 = Math.ceil(y1 + falloff);
  const bw = x1 - x0, bh = y1 - y0;
  const scale = Math.min(1, 1024 / Math.max(bw, bh));
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(bw * scale));
  c.height = Math.max(8, Math.round(bh * scale));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = ctx.fillStyle = "#fff";
  ctx.lineCap = ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.pts.length === 1) {
      ctx.beginPath();
      ctx.arc((s.pts[0].x - x0) * scale, (s.pts[0].y - y0) * scale, s.r * scale, 0, 7);
      ctx.fill();
    } else {
      ctx.lineWidth = 2 * s.r * scale;
      ctx.beginPath();
      ctx.moveTo((s.pts[0].x - x0) * scale, (s.pts[0].y - y0) * scale);
      for (let i = 1; i < s.pts.length; i++)
        ctx.lineTo((s.pts[i].x - x0) * scale, (s.pts[i].y - y0) * scale);
      ctx.stroke();
    }
  }
  const mask_png = c.toDataURL("image/png").split(",")[1];
  const ok = await submitPaint({ ...commonParams(), bbox: [x0, y0, bw, bh], mask_png });
  if (ok) clearPending();
}

async function submitPaint(body) {
  const res = await fetch("/paint", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.detail || `paint failed (${res.status})`);
    return false;
  }
  pollJobs();
  return true;
}

// ---- jobs ---------------------------------------------------------

window.cancelJob = async (id) => { await fetch(`/job/${id}/cancel`, { method: "POST" }); pollJobs(); };

async function pollJobs() {
  try {
    const res = await fetch("/jobs");
    const js = await res.json();
    const sig = (a) => JSON.stringify(a.map((j) => [j.id, j.status, j.iter]));
    const changed = sig(js) !== sig(activeJobs);
    activeJobs = js;
    if (changed) { renderJobList(js); redraw(); }
  } catch (e) { /* server restarting */ }
}

function renderJobList(js) {
  $("jobs").innerHTML = js.slice(-8).map((j) => `
    <div class="job">
      ${j.status === "queued" ? `<button onclick="cancelJob('${j.id}')">✕</button>` : ""}
      ${j.status === "running" ? `<button onclick="cancelJob('${j.id}')" title="stop here and keep what it looks like right now">■ stop</button>` : ""}
      <span class="st-${j.status}">${j.status}</span>
      ${j.status === "running" ? ` ${j.iter}/${j.iterations}` : ""}
      ${j.seed != null ? ` · seed ${j.seed}` : ""}
      ${j.note ? ` · ${j.note}` : ""}
      ${j.error ? ` · ${j.error}` : ""}
      <div class="prompt">${j.kind === "image" ? "⇓ " : ""}${j.prompt && j.prompt.trim() ? j.prompt : (j.kind === "image" ? "(image ingest)" : "(flow from surroundings)")}</div>
    </div>`).join("");
}

setInterval(() => {
  if (activeJobs.some((j) => j.status === "running")) scheduleFetch(0);
}, 1500);
setInterval(pollJobs, 500);

// ---- settings -----------------------------------------------------

for (const [id, out, fmt] of [
  ["size", "sizeVal", (v) => v], ["falloff", "falloffVal", (v) => v],
  ["iters", "itersVal", (v) => v], ["radius", "radiusVal", (v) => v],
  ["noise", "noiseVal", (v) => v + "%"], ["lr", "lrVal", (v) => (+v).toFixed(2)],
  ["cutn", "cutnVal", (v) => v], ["wimg", "wimgVal", (v) => (+v).toFixed(2)],
  ["wtext", "wtextVal", (v) => (+v).toFixed(2)], ["hold", "holdVal", (v) => (+v).toFixed(2)],
  ["drift", "driftVal", (v) => (+v).toFixed(2)], ["strength", "strengthVal", (v) => (+v).toFixed(2)],
  ["tolerance", "tolVal", (v) => v],
]) {
  $(id).addEventListener("input", () => { $(out).textContent = fmt($(id).value); redraw(); });
}

$("applyWorld").onclick = async () => {
  const s = +$("worldSize").value;
  if (s < WORLD && !confirm(`Shrink canvas to ${s}? Content beyond ${s}px (right/bottom) is cropped.`)) return;
  const res = await fetch("/canvas_size", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size: s }),
  });
  if (res.ok) {
    WORLD = (await res.json()).world;
    $("worldSize").value = WORLD;
    redraw(); scheduleFetch(0);
  }
};

const exportUrl = (scope) =>
  `/export?scope=${scope}&bg=${$("exportAlpha").checked ? "transparent" : "canvas"}`;
$("exportPainted").onclick = () => { location.href = exportUrl("painted"); };
$("exportFull").onclick = () => { location.href = exportUrl("full"); };

// ---- boot ---------------------------------------------------------

(async () => {
  try {
    const info = await (await fetch("/canvas_info")).json();
    WORLD = info.world;
    $("worldSize").value = WORLD;
  } catch (e) { /* defaults */ }
  fitWorld();
  redraw();
  fetchView();
  pollJobs();
})();
