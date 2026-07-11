/* VQPAINT frontend — canvas-first. One floating toolbar, a contextual
   popover anchored to the active region, an Advanced drawer. The
   canvas/pan/zoom/fetch/paint pipeline is unchanged from earlier
   milestones; only the tool-UI wiring moved.
   View transform: screen = world * k + (px, py). */

let WORLD = 8192;

const app = new PIXI.Application({
  resizeTo: window, backgroundAlpha: 0, antialias: true,
});
app.view.className = "pixi";
document.body.insertBefore(app.view, document.body.firstChild);

// dot-grid paper lives in CSS; keep it panning with the world
document.body.style.background =
  "radial-gradient(#d9d7d1 1.1px, transparent 1.4px) 0 0 / 26px 26px, #f4f3f0";

const viewSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
const strokeGfx = new PIXI.Graphics();
const selSprite = new PIXI.Sprite(PIXI.Texture.EMPTY); selSprite.visible = false;
const imgSprite = new PIXI.Sprite(PIXI.Texture.EMPTY); imgSprite.visible = false;
imgSprite.alpha = 0.6;
const jobGfx = new PIXI.Graphics();
const jobLabels = new PIXI.Container();
const brushGfx = new PIXI.Graphics();
app.stage.addChild(viewSprite, selSprite, strokeGfx, jobGfx, jobLabels, imgSprite, brushGfx);

let k = 0.1, px = 40, py = 40;
let fetchRect = null;
let activeJobs = [];
let mouse = { x: -1e9, y: -1e9 };
let tool = "place";
let strokes = [];
let selection = null;               // {bbox, mask_png}
let pendingPt = null;               // {x, y} world — armed region for place/refine/image/latent
let importImg = null;
let bleedFromPt = null;
let pickingBleed = false;
let spaceHeld = false;

const ACC = 0x2f9e63, WARN = 0xc98a2b, ERR = 0xc74d4d, QUEUED = 0x8a88c0;

const $ = (id) => document.getElementById(id);
const worldX = (sx) => (sx - px) / k;
const worldY = (sy) => (sy - py) / k;

const TOOL_TITLES = {
  place: "Paint region", brush: "Paint area", wand: "Selection",
  image: "Place image", latent: "Latent op", refine: "Refine detail",
};

function refineLevel() {
  const sel = +$("refineLevel").value;
  if (sel > 0) return sel;
  return Math.max(1, Math.min(4, Math.ceil(Math.log2(Math.max(1.01, k)))));
}
function refineMaxSize() { return Math.floor(2304 / 2 ** refineLevel()); }
function updateRefineHint() {
  const lv = refineLevel(), s = 2 ** lv;
  const max = refineMaxSize();
  const size = Math.min(+$("size").value, max);
  $("refineHint").textContent =
    `${s}× — ${size} canvas px become ${size * s} fine px (max area ${max})`;
}

function fitWorld() {
  k = Math.min(innerWidth, innerHeight) / WORLD * 0.92;
  px = (innerWidth - WORLD * k) / 2;
  py = (innerHeight - WORLD * k) / 2;
}

// ---- popover anchoring ---------------------------------------------

function anchorBBox() {
  if (selection) return selection.bbox;
  if (strokes.length) {
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    for (const s of strokes) for (const p of s.pts) {
      x0 = Math.min(x0, p.x - s.r); y0 = Math.min(y0, p.y - s.r);
      x1 = Math.max(x1, p.x + s.r); y1 = Math.max(y1, p.y + s.r);
    }
    return [x0, y0, x1 - x0, y1 - y0];
  }
  if (pendingPt) {
    let w = Math.min(+$("size").value, tool === "refine" ? refineMaxSize() : 1e9);
    let h = w;
    if (tool === "image" && importImg) h = w * importImg.h / importImg.w;
    return [pendingPt.x - w / 2, pendingPt.y - h / 2, w, h];
  }
  return null;
}

function updatePopover() {
  const pop = $("popover");
  const bb = anchorBBox();
  const show = bb && !pickingBleed;
  pop.style.display = show ? "block" : "none";
  if (!show) return;
  $("popTitle").textContent = TOOL_TITLES[tool] || tool;
  const sx0 = px + bb[0] * k, sy0 = py + bb[1] * k;
  const sx1 = px + (bb[0] + bb[2]) * k, sy1 = py + (bb[1] + bb[3]) * k;
  const cx = Math.max(150, Math.min(innerWidth - 150, (sx0 + sx1) / 2));
  const ph = pop.offsetHeight || 260;
  let top = sy0 - ph - 16;
  const below = top < 64;
  if (below) top = Math.min(innerHeight - ph - 80, sy1 + 16);
  pop.classList.toggle("below", below);
  pop.style.left = `${Math.round(cx - 132)}px`;
  pop.style.top = `${Math.round(top)}px`;
  if (tool === "refine") updateRefineHint();
}

// ---- redraw ---------------------------------------------------------

let selMode = "wand";
let selDrawing = null;

function redraw() {
  document.body.style.backgroundPosition = `${px % 26}px ${py % 26}px, 0 0`;
  if (fetchRect) {
    viewSprite.x = px + fetchRect.x0 * k;
    viewSprite.y = py + fetchRect.y0 * k;
    viewSprite.width = (fetchRect.x1 - fetchRect.x0) * k;
    viewSprite.height = (fetchRect.y1 - fetchRect.y0) * k;
  }

  strokeGfx.clear();
  if (bleedFromPt) {
    strokeGfx.lineStyle(1.5, 0x4a90c2, 0.9)
             .drawCircle(px + bleedFromPt[0] * k, py + bleedFromPt[1] * k, 14);
  }
  for (const s of strokes) {
    strokeGfx.lineStyle({ width: 2 * s.r * k, color: ACC, alpha: 0.28,
                          cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    if (s.pts.length === 1) {
      strokeGfx.lineStyle(0).beginFill(ACC, 0.28)
        .drawCircle(px + s.pts[0].x * k, py + s.pts[0].y * k, s.r * k).endFill();
    } else {
      strokeGfx.moveTo(px + s.pts[0].x * k, py + s.pts[0].y * k);
      for (let i = 1; i < s.pts.length; i++)
        strokeGfx.lineTo(px + s.pts[i].x * k, py + s.pts[i].y * k);
    }
  }
  if (selDrawing) {
    strokeGfx.lineStyle(1.5, ACC, 0.9);
    if (selDrawing.mode === "rect") {
      const x = Math.min(selDrawing.ax, selDrawing.bx), y = Math.min(selDrawing.ay, selDrawing.by);
      strokeGfx.drawRect(px + x * k, py + y * k,
                         Math.abs(selDrawing.bx - selDrawing.ax) * k,
                         Math.abs(selDrawing.by - selDrawing.ay) * k);
    } else if (selDrawing.mode === "lasso") {
      strokeGfx.moveTo(px + selDrawing.pts[0].x * k, py + selDrawing.pts[0].y * k);
      for (const p of selDrawing.pts) strokeGfx.lineTo(px + p.x * k, py + p.y * k);
    } else if (selDrawing.mode === "brushsel") {
      strokeGfx.lineStyle({ width: 2 * selDrawing.r * k, color: ACC, alpha: 0.28,
                            cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
      strokeGfx.moveTo(px + selDrawing.pts[0].x * k, py + selDrawing.pts[0].y * k);
      for (const p of selDrawing.pts) strokeGfx.lineTo(px + p.x * k, py + p.y * k);
    }
  }

  // armed pending region (dashed = not yet generated)
  if (pendingPt) {
    const bb = anchorBBox();
    strokeGfx.lineStyle(1.5, ACC, 0.9);
    const x0 = px + bb[0] * k, y0 = py + bb[1] * k, w = bb[2] * k, h = bb[3] * k;
    const dash = 7, gap = 5;
    for (const [ax, ay, bx2, by2] of [[x0, y0, x0 + w, y0], [x0 + w, y0, x0 + w, y0 + h],
                                      [x0 + w, y0 + h, x0, y0 + h], [x0, y0 + h, x0, y0]]) {
      const len = Math.hypot(bx2 - ax, by2 - ay), n = Math.max(1, Math.floor(len / (dash + gap)));
      for (let i = 0; i < n; i++) {
        const t0 = i * (dash + gap) / len, t1 = Math.min(1, t0 + dash / len);
        strokeGfx.moveTo(ax + (bx2 - ax) * t0, ay + (by2 - ay) * t0)
                 .lineTo(ax + (bx2 - ax) * t1, ay + (by2 - ay) * t1);
      }
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
    const col = j.status === "error" ? ERR : j.status === "running" ? WARN : QUEUED;
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
  const overUI = document.querySelector(
    "#toolbar:hover, #popover:hover, #drawer:hover, #jobs:hover, #chromeTL:hover, " +
    "#chromeTR:hover, #zoomctl:hover, #statusline:hover");
  if (tool === "image" && importImg && pendingPt) {
    const bb = anchorBBox();
    imgSprite.x = px + bb[0] * k; imgSprite.y = py + bb[1] * k;
    imgSprite.width = bb[2] * k; imgSprite.height = bb[3] * k;
    imgSprite.visible = true;
  }
  if (mouse.x > -1e8 && !overUI && !pendingPt) {
    if (pickingBleed) {
      brushGfx.lineStyle(1.5, 0x4a90c2, 0.9).drawCircle(mouse.x, mouse.y, 14);
    } else if (tool === "place") {
      const s = +$("size").value * k;
      brushGfx.lineStyle(1, ACC, 0.5).drawRect(mouse.x - s / 2, mouse.y - s / 2, s, s);
    } else if (tool === "brush") {
      brushGfx.lineStyle(1, ACC, 0.7).drawCircle(mouse.x, mouse.y, +$("radius").value * k);
    } else if (tool === "image" && importImg) {
      const w = +$("size").value * k, h = w * importImg.h / importImg.w;
      imgSprite.x = mouse.x - w / 2; imgSprite.y = mouse.y - h / 2;
      imgSprite.width = w; imgSprite.height = h;
      imgSprite.visible = true;
      brushGfx.lineStyle(1, WARN, 0.7).drawRect(mouse.x - w / 2, mouse.y - h / 2, w, h);
    } else if (tool === "wand") {
      brushGfx.lineStyle(1, 0x9a6bb8, 0.9).drawCircle(mouse.x, mouse.y, 6);
    } else if (tool === "latent") {
      const s = +$("size").value * k;
      brushGfx.lineStyle(1, 0x9a6bb8, 0.7).drawRect(mouse.x - s / 2, mouse.y - s / 2, s, s);
    } else if (tool === "refine") {
      const s = Math.min(+$("size").value, refineMaxSize()) * k;
      brushGfx.lineStyle(1, 0x4a90c2, 0.7).drawRect(mouse.x - s / 2, mouse.y - s / 2, s, s);
    }
  }
  $("zoomPct").textContent = `${Math.round(k * 100)}%`;
  updatePopover();
}

// ---- view fetching --------------------------------------------------

let fetching = false, needFetch = false, fetchTimer = null;

function scheduleFetch(delay = 220) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(fetchView, delay);
}

async function fetchView() {
  if (fetching) { needFetch = true; return; }
  fetching = true;
  // clamp to the world so the paper shows past its edges
  const r = {
    x0: Math.max(0, worldX(0)), y0: Math.max(0, worldY(0)),
    x1: Math.min(WORLD, worldX(innerWidth)), y1: Math.min(WORLD, worldY(innerHeight)),
  };
  if (r.x1 - r.x0 > 1 && r.y1 - r.y0 > 1) {
    const w = Math.min(Math.round((r.x1 - r.x0) * k), 2048);
    const h = Math.min(Math.round((r.y1 - r.y0) * k), 2048);
    try {
      const res = await fetch(`/view?x0=${r.x0}&y0=${r.y0}&x1=${r.x1}&y1=${r.y1}&w=${Math.max(1, w)}&h=${Math.max(1, h)}&t=${Date.now()}`);
      if (res.ok) {
        const bmp = await createImageBitmap(await res.blob());
        const old = viewSprite.texture;
        viewSprite.texture = PIXI.Texture.from(bmp);
        fetchRect = r;
        if (old && old !== PIXI.Texture.EMPTY) old.destroy(true);
        redraw();
      }
    } catch (e) { console.error(e); }
  }
  fetching = false;
  if (needFetch) { needFetch = false; scheduleFetch(50); }
}

// ---- input ----------------------------------------------------------

let down = null, moved = false, panning = false, drawing = null;

app.view.addEventListener("pointerdown", (e) => {
  if (e.button === 1 || e.button === 2 || spaceHeld) {
    panning = true; down = { x: e.clientX, y: e.clientY };
    return;
  }
  if (e.button !== 0) return;
  if (pickingBleed) return;
  const wx = worldX(e.clientX), wy = worldY(e.clientY);
  if (tool === "brush") {
    drawing = { r: +$("radius").value, pts: [{ x: wx, y: wy }] };
    strokes.push(drawing);
    selection = null; pendingPt = null;
    redraw();
  } else if (tool === "wand" && selMode === "rect") {
    selDrawing = { mode: "rect", ax: wx, ay: wy, bx: wx, by: wy };
  } else if (tool === "wand" && selMode === "lasso") {
    selDrawing = { mode: "lasso", pts: [{ x: wx, y: wy }] };
  } else if (tool === "wand" && selMode === "brushsel") {
    selDrawing = { mode: "brushsel", r: +$("selRadius").value, pts: [{ x: wx, y: wy }] };
  } else {
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
  } else if (selDrawing) {
    const wx = worldX(e.clientX), wy = worldY(e.clientY);
    if (selDrawing.mode === "rect") { selDrawing.bx = wx; selDrawing.by = wy; }
    else {
      const last = selDrawing.pts[selDrawing.pts.length - 1];
      const min = selDrawing.mode === "brushsel" ? selDrawing.r * 0.3 : 3 / k;
      if (Math.hypot(wx - last.x, wy - last.y) > min) selDrawing.pts.push({ x: wx, y: wy });
    }
  } else if (down) {
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) { px += dx; py += dy; down = { x: e.clientX, y: e.clientY }; scheduleFetch(); }
  }
  $("coords").textContent =
    `${Math.round(worldX(e.clientX))},${Math.round(worldY(e.clientY))}`;
  redraw();
});
window.addEventListener("pointerup", (e) => {
  if (panning) { panning = false; down = null; return; }
  if (drawing) { drawing = null; redraw(); return; }
  if (selDrawing) { finishSelDrawing(); return; }
  if (e.target !== app.view) { down = null; return; }
  const wx = worldX(e.clientX), wy = worldY(e.clientY);
  const clicked = down && !moved;
  down = null;
  if (pickingBleed) {
    bleedFromPt = [wx, wy];
    pickingBleed = false;
    $("bleedFrom").textContent = `⊙ ${Math.round(wx)}, ${Math.round(wy)}`;
    $("bleedFromClear").style.display = "";
    redraw();
    return;
  }
  if (!clicked) return;
  if (wx < 0 || wy < 0 || wx > WORLD || wy > WORLD) { clearPending(); return; }
  if (tool === "wand" && selMode === "wand") wandSelect(wx, wy);
  else if (tool === "wand" && selMode === "similar") similarSelect(wx, wy);
  else if (tool === "image" && !importImg) $("imageFile").click();
  else if (["place", "refine", "image", "latent"].includes(tool)) {
    pendingPt = { x: wx, y: wy };
    selection = null; strokes = [];
    redraw();
  }
});
app.view.addEventListener("contextmenu", (e) => e.preventDefault());
app.view.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomBy(Math.exp(-e.deltaY * 0.0012), e.clientX, e.clientY);
}, { passive: false });
window.addEventListener("resize", () => { redraw(); scheduleFetch(); });

function zoomBy(f, cx = innerWidth / 2, cy = innerHeight / 2) {
  const nk = Math.min(8, Math.max(0.005, k * f));
  const real = nk / k;
  px = cx - (cx - px) * real;
  py = cy - (cy - py) * real;
  k = nk;
  redraw(); scheduleFetch();
}
$("zoomIn").onclick = () => zoomBy(1.25);
$("zoomOut").onclick = () => zoomBy(0.8);

// ---- keyboard -------------------------------------------------------

function sizeKeyFor() {
  if (tool === "brush") return ["radius", 16];
  if (tool === "wand") {
    if (selMode === "similar") return ["similarity", 0.02];
    if (selMode === "brushsel") return ["selRadius", 16];
    return ["tolerance", 2];
  }
  return ["size", 32];
}

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.code === "Space") { spaceHeld = true; e.preventDefault(); return; }
  if (e.key === "Escape") { clearPending(); pickingBleed = false; redraw(); }
  else if (e.key === "Enter" && (strokes.length || selection || pendingPt)) generatePending();
  else if (e.key >= "1" && e.key <= "6") setTool(["place", "brush", "wand", "image", "latent", "refine"][+e.key - 1]);
  else if (e.key === "[" || e.key === "]") {
    const [id, step] = sizeKeyFor();
    const el = $(id);
    el.value = Math.round((+el.value + (e.key === "]" ? step : -step)) * 100) / 100;
    el.dispatchEvent(new Event("input"));
  }
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceHeld = false; });

// ---- tools ----------------------------------------------------------

function setTool(t) {
  tool = t;
  for (const [id, name] of [["toolPlace", "place"], ["toolBrush", "brush"],
                            ["toolWand", "wand"], ["toolImage", "image"],
                            ["toolLatent", "latent"], ["toolRefine", "refine"]])
    $(id).classList.toggle("active", t === name);
  document.querySelectorAll(".tool-group[data-tool]").forEach((g) => {
    g.style.display = g.dataset.tool.split(" ").includes(t) ? "block" : "none";
  });
  pendingPt = null;
  if (!["brush", "wand", "latent"].includes(t)) { strokes = []; selection = null;
    $("selOps").style.display = "none"; $("latApplySel").style.display = "none"; }
  redraw();
}
$("toolPlace").onclick = () => setTool("place");
$("toolBrush").onclick = () => setTool("brush");
$("toolWand").onclick = () => setTool("wand");
$("toolLatent").onclick = () => setTool("latent");
$("toolRefine").onclick = () => setTool("refine");
$("toolImage").onclick = () => {
  if (importImg) setTool("image");
  else $("imageFile").click();
};
$("pickImage").onclick = () => $("imageFile").click();
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
  importImg = { b64, w: bmp.width, h: bmp.height, texture: PIXI.Texture.from(bmp), name: f.name };
  imgSprite.texture = importImg.texture;
  $("imageName").textContent = f.name;
  $("imageFile").value = "";
  setTool("image");
});

$("latentOp").addEventListener("change", () => {
  const LATENT_PARAMS = {
    spray:    { amount: true,  pa: null,             pb: false },
    neighbor: { amount: true,  pa: "k neighbors",    pb: false },
    shift:    { amount: false, pa: "dx (tokens)",    pb: true },
    mirror:   { amount: false, pa: "axis 0=h 1=v",   pb: false },
    repeat:   { amount: false, pa: "block (tokens)", pb: false },
    bloom:    { amount: false, pa: "passes 1-6",     pb: false },
  };
  const cfg = LATENT_PARAMS[$("latentOp").value];
  $("latAmountRow").style.display = cfg.amount ? "block" : "none";
  $("latPaRow").style.display = cfg.pa ? "flex" : "none";
  $("latPaLabel").textContent = cfg.pa || "";
  $("latPb").style.display = cfg.pb ? "" : "none";
});
$("latentOp").dispatchEvent(new Event("change"));
$("latAmount").addEventListener("input", () => {
  $("latAmountVal").textContent = $("latAmount").value + "%";
});

function clearPending() {
  strokes = []; drawing = null; selection = null; selDrawing = null; pendingPt = null;
  $("selOps").style.display = "none";
  $("latApplySel").style.display = "none";
  redraw();
}
$("clearBrush").onclick = clearPending;
$("genBrush").onclick = () => generatePending();
$("advOpen").onclick = () => $("drawer").classList.add("open");
$("drawerTab").onclick = () => $("drawer").classList.toggle("open");

document.querySelectorAll(".selmode").forEach((b) => {
  b.onclick = () => {
    selMode = b.dataset.mode;
    document.querySelectorAll(".selmode").forEach((x) => x.classList.toggle("on", x === b));
    $("selParamTol").style.display = selMode === "wand" ? "block" : "none";
    $("selParamSim").style.display = selMode === "similar" ? "block" : "none";
    $("selParamRad").style.display = selMode === "brushsel" ? "block" : "none";
  };
});
for (const op of ["Grow", "Shrink", "Feather", "Invert"])
  $("sel" + op).onclick = () => morphSelection(op.toLowerCase());

$("bleedFrom").onclick = () => { pickingBleed = true; redraw(); };
$("bleedFromClear").onclick = () => {
  bleedFromPt = null;
  $("bleedFrom").textContent = "⊙ bleed from…";
  $("bleedFromClear").style.display = "none";
  redraw();
};

$("presetDraft").onclick = () => setIters(80);
$("presetRefine").onclick = () => setIters(350);
function setIters(v) {
  $("iters").value = v;
  $("iters").dispatchEvent(new Event("input"));
}

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

function latentParams() {
  return {
    op: $("latentOp").value,
    amount: +$("latAmount").value / 100,
    pa: +$("latPa").value,
    pb: +$("latPb").value,
    falloff: +$("falloff").value,
    seed: $("seed").value.trim() === "" ? null : +$("seed").value,
  };
}

async function paintSquare(wx, wy) {
  return submitPaint({ ...commonParams(), x: wx, y: wy, size: +$("size").value });
}

async function placeImage(wx, wy) {
  const w = Math.round(+$("size").value);
  const h = Math.round(w * importImg.h / importImg.w);
  return submitPaint({
    ...commonParams(),
    bbox: [Math.round(wx - w / 2), Math.round(wy - h / 2), w, h],
    source_png: importImg.b64,
    source_strength: +$("strength").value,
  });
}

async function refineAt(wx, wy) {
  const lv = refineLevel();
  const size = Math.min(+$("size").value, refineMaxSize());
  const c = commonParams();
  const res = await fetch("/refine", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bbox: [Math.round(wx - size / 2), Math.round(wy - size / 2), size, size],
      level: lv,
      prompt: c.prompt, falloff: Math.max(8, Math.round(c.falloff / 2)),
      iterations: c.iterations, seed: c.seed, lr: c.lr, cutn: c.cutn,
      start_noise: c.start_noise, w_text: c.w_text, w_img: c.w_img,
      hold: c.hold, cut_method: c.cut_method, bleed_drift: c.bleed_drift,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.detail || `refine failed (${res.status})`);
    return false;
  }
  pollJobs();
  return true;
}

async function submitLatent(body) {
  const res = await fetch("/latent_op", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.detail || `latent op failed (${res.status})`);
    return false;
  }
  pollJobs();
  return true;
}

$("latApplySel").onclick = async () => {
  if (!selection) return;
  const ok = await submitLatent({ ...latentParams(),
    bbox: selection.bbox, mask_png: selection.mask_png });
  if (ok) clearPending();
};

// ---- selection helpers ---------------------------------------------

function maskCanvas(bbox, drawFn) {
  const [x0, y0, bw, bh] = bbox;
  const scale = Math.min(1, 1024 / Math.max(bw, bh));
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(bw * scale));
  c.height = Math.max(8, Math.round(bh * scale));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = ctx.fillStyle = "#fff";
  ctx.lineCap = ctx.lineJoin = "round";
  drawFn(ctx, scale, x0, y0);
  return { bbox, mask_png: c.toDataURL("image/png").split(",")[1] };
}

async function finishSelDrawing() {
  const d = selDrawing;
  selDrawing = null;
  if (d.mode === "rect") {
    const x0 = Math.floor(Math.min(d.ax, d.bx)), y0 = Math.floor(Math.min(d.ay, d.by));
    const w = Math.ceil(Math.abs(d.bx - d.ax)), h = Math.ceil(Math.abs(d.by - d.ay));
    if (w < 8 || h < 8) { redraw(); return; }
    await applySelection(maskCanvas([x0, y0, w, h], (ctx) => ctx.fillRect(0, 0, 1e5, 1e5)));
  } else if (d.mode === "lasso") {
    if (d.pts.length < 3) { redraw(); return; }
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    for (const p of d.pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    const w = Math.ceil(x1 - x0), h = Math.ceil(y1 - y0);
    if (w < 8 || h < 8) { redraw(); return; }
    await applySelection(maskCanvas([x0, y0, w, h], (ctx, s, ox, oy) => {
      ctx.beginPath();
      ctx.moveTo((d.pts[0].x - ox) * s, (d.pts[0].y - oy) * s);
      for (const p of d.pts) ctx.lineTo((p.x - ox) * s, (p.y - oy) * s);
      ctx.closePath(); ctx.fill();
    }));
  } else if (d.mode === "brushsel") {
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    for (const p of d.pts) {
      x0 = Math.min(x0, p.x - d.r); y0 = Math.min(y0, p.y - d.r);
      x1 = Math.max(x1, p.x + d.r); y1 = Math.max(y1, p.y + d.r);
    }
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    await applySelection(maskCanvas([x0, y0, Math.ceil(x1 - x0), Math.ceil(y1 - y0)],
      (ctx, s, ox, oy) => {
        if (d.pts.length === 1) {
          ctx.beginPath();
          ctx.arc((d.pts[0].x - ox) * s, (d.pts[0].y - oy) * s, d.r * s, 0, 7);
          ctx.fill();
        } else {
          ctx.lineWidth = 2 * d.r * s;
          ctx.beginPath();
          ctx.moveTo((d.pts[0].x - ox) * s, (d.pts[0].y - oy) * s);
          for (const p of d.pts) ctx.lineTo((p.x - ox) * s, (p.y - oy) * s);
          ctx.stroke();
        }
      }));
  }
}

async function similarSelect(wx, wy) {
  $("stripJob").textContent = "◌ looking for similar regions…";
  const res = await fetch("/select_clip", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: wx, y: wy, threshold: +$("similarity").value }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.detail || `similar-select failed (${res.status})`);
    updateStrip();
    return;
  }
  await applySelection(await res.json());
  updateStrip();
}

async function morphSelection(op) {
  if (!selection) return;
  const pad = op === "grow" ? 24 : 0;
  const [bx, by, bw, bh] = selection.bbox;
  const bbox = [bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad];
  const scale = Math.min(1, 1024 / Math.max(bbox[2], bbox[3]));
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(bbox[2] * scale));
  c.height = Math.max(8, Math.round(bbox[3] * scale));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
  const raw = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${selection.mask_png}`)).blob());
  const blur = op === "invert" ? 0 : Math.max(2, 8 * scale);
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(raw, pad * scale, pad * scale, bw * scale, bh * scale);
  ctx.filter = "none";
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = d[i];
    if (op === "grow") v = v > 32 ? 255 : 0;
    else if (op === "shrink") v = v > 224 ? 255 : 0;
    else if (op === "invert") v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  await applySelection({ bbox, mask_png: c.toDataURL("image/png").split(",")[1] });
}

async function wandSelect(wx, wy) {
  const res = await fetch("/select", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: wx, y: wy, tolerance: +$("tolerance").value }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.detail || `select failed (${res.status})`);
    return;
  }
  await applySelection(await res.json());
}

async function applySelection(sel) {
  selection = sel;
  strokes = []; pendingPt = null;
  const raw = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${sel.mask_png}`)).blob());
  const c = document.createElement("canvas");
  c.width = raw.width; c.height = raw.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(raw, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = data.data[i];
    data.data[i] = 0x2f; data.data[i + 1] = 0x9e; data.data[i + 2] = 0x63;
    data.data[i + 3] = v > 40 ? 90 : 0;
  }
  ctx.putImageData(data, 0, 0);
  const old = selSprite.texture;
  selSprite.texture = PIXI.Texture.from(c);
  if (old && old !== PIXI.Texture.EMPTY) old.destroy(true);
  $("selOps").style.display = "flex";
  $("latApplySel").style.display = "";
  redraw();
}

// ---- generate dispatch ----------------------------------------------

async function generatePending() {
  if (tool === "latent") {
    if (selection) { $("latApplySel").click(); return; }
    if (pendingPt) {
      const ok = await submitLatent({ ...latentParams(),
        x: pendingPt.x, y: pendingPt.y, size: +$("size").value });
      if (ok) clearPending();
    }
    return;
  }
  if (selection) {
    const ok = await submitPaint({
      ...commonParams(), bbox: selection.bbox, mask_png: selection.mask_png,
    });
    if (ok) clearPending();
    return;
  }
  if (strokes.length) {
    const falloff = +$("falloff").value;
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    for (const s of strokes) for (const p of s.pts) {
      x0 = Math.min(x0, p.x - s.r); y0 = Math.min(y0, p.y - s.r);
      x1 = Math.max(x1, p.x + s.r); y1 = Math.max(y1, p.y + s.r);
    }
    x0 = Math.floor(x0 - falloff); y0 = Math.floor(y0 - falloff);
    x1 = Math.ceil(x1 + falloff); y1 = Math.ceil(y1 + falloff);
    const strokesCopy = strokes;
    const m = maskCanvas([x0, y0, x1 - x0, y1 - y0], (ctx, s, ox, oy) => {
      for (const st of strokesCopy) {
        if (st.pts.length === 1) {
          ctx.beginPath();
          ctx.arc((st.pts[0].x - ox) * s, (st.pts[0].y - oy) * s, st.r * s, 0, 7);
          ctx.fill();
        } else {
          ctx.lineWidth = 2 * st.r * s;
          ctx.beginPath();
          ctx.moveTo((st.pts[0].x - ox) * s, (st.pts[0].y - oy) * s);
          for (const p of st.pts) ctx.lineTo((p.x - ox) * s, (p.y - oy) * s);
          ctx.stroke();
        }
      }
    });
    const ok = await submitPaint({ ...commonParams(), bbox: m.bbox, mask_png: m.mask_png });
    if (ok) clearPending();
    return;
  }
  if (pendingPt) {
    let ok = false;
    if (tool === "place") ok = await paintSquare(pendingPt.x, pendingPt.y);
    else if (tool === "refine") ok = await refineAt(pendingPt.x, pendingPt.y);
    else if (tool === "image" && importImg) ok = await placeImage(pendingPt.x, pendingPt.y);
    if (ok) clearPending();
  }
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

// ---- jobs + status --------------------------------------------------

window.cancelJob = async (id) => { await fetch(`/job/${id}/cancel`, { method: "POST" }); pollJobs(); };

async function pollJobs() {
  try {
    const res = await fetch("/jobs");
    const js = await res.json();
    const sig = (a) => JSON.stringify(a.map((j) => [j.id, j.status, j.iter]));
    const changed = sig(js) !== sig(activeJobs);
    activeJobs = js;
    updateStrip();
    if (changed) { renderJobList(js); redraw(); }
  } catch (e) { /* server restarting */ }
}

function updateStrip() {
  const running = activeJobs.filter((j) => j.status === "running");
  const queued = activeJobs.filter((j) => j.status === "queued").length;
  $("stripJob").textContent = running.length
    ? `● ${running[0].iter}/${running[0].iterations}` + (queued ? ` +${queued}` : "")
    : (queued ? `${queued} queued` : "");
}

function renderJobList(js) {
  $("jobs").innerHTML = js.slice(-6).filter((j) => j.status !== "done" || Date.now() / 1000 - 30 < (j.finished || 1e18)).map((j) => `
    <div class="job">
      ${j.status === "queued" ? `<button onclick="cancelJob('${j.id}')">✕</button>` : ""}
      ${j.status === "running" ? `<button onclick="cancelJob('${j.id}')" title="stop here, keep what you see">stop</button>` : ""}
      <span class="st-${j.status}">${j.status}${j.status === "running" ? ` ${j.iter}/${j.iterations}` : ""}</span>
      ${j.kind && j.kind !== "region" && j.kind !== "brush" ? ` · ${j.kind}` : ""}
      <div class="prompt">${j.prompt && j.prompt.trim() ? j.prompt : (j.kind === "image" ? "(image ingest)" : j.kind && j.kind.startsWith("latent") ? "" : "(flow from surroundings)")}</div>
    </div>`).join("");
}

async function pollInfo() {
  try {
    const info = await (await fetch("/canvas_info")).json();
    if (info.world !== WORLD) { WORLD = info.world; $("worldSize").value = WORLD; redraw(); }
    $("worldLabel").textContent = `${WORLD}px`;
    $("stripSave").textContent = info.last_save
      ? `${info.dirty ? "◌ " : ""}v${info.last_save.slice(-6)}`
      : "◌ unsaved";
  } catch (e) { /* offline */ }
}

setInterval(() => {
  if (activeJobs.some((j) => j.status === "running")) scheduleFetch(0);
}, 1500);
setInterval(pollJobs, 500);
setInterval(pollInfo, 4000);

$("saveNow").onclick = async () => { await fetch("/save", { method: "POST" }); pollInfo(); };

// ---- settings -------------------------------------------------------

for (const [id, out, fmt] of [
  ["size", "sizeVal", (v) => v], ["falloff", "falloffVal", (v) => v],
  ["iters", "itersVal", (v) => v], ["radius", "radiusVal", (v) => v],
  ["noise", "noiseVal", (v) => v + "%"], ["lr", "lrVal", (v) => (+v).toFixed(2)],
  ["cutn", "cutnVal", (v) => v], ["wimg", "wimgVal", (v) => (+v).toFixed(2)],
  ["wtext", "wtextVal", (v) => (+v).toFixed(2)], ["hold", "holdVal", (v) => (+v).toFixed(2)],
  ["drift", "driftVal", (v) => (+v).toFixed(2)], ["strength", "strengthVal", (v) => (+v).toFixed(2)],
  ["tolerance", "tolVal", (v) => v], ["similarity", "simVal", (v) => (+v).toFixed(2)],
  ["selRadius", "selRadVal", (v) => v],
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
  `/export?scope=${scope}&bg=${$("exportAlpha").checked ? "transparent" : "canvas"}` +
  `&scale=${$("exportScale").value}`;
$("exportPainted").onclick = () => { location.href = exportUrl("painted"); };
$("exportFull").onclick = () => { location.href = exportUrl("full"); };
$("exportQuick").onclick = () => { location.href = exportUrl("painted"); };

// ---- boot -----------------------------------------------------------

(async () => {
  await pollInfo();
  fitWorld();
  setTool("place");
  redraw();
  fetchView();
  pollJobs();
})();
