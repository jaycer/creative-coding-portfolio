// Image Tiler — one picture, repeated into a grid, out as a single sheet.
//
// The whole app is one function: given a source image, a count across and down,
// and a few rules about how neighboring tiles relate, draw the sheet. Everything
// else here is getting a picture in, keeping a slider and the number beside it
// telling the same story, and writing the result out at a size a browser will
// actually allocate.
//
// The drawing is resolution-independent — every tile is a drawImage into a rect
// worked out from the sheet's width — so the preview on screen and the file that
// comes out are the same picture at two sizes, and there is no second code path
// to keep in step. See drawSheet.
//
// Nothing leaves the page. The file is read with createImageBitmap, drawn to a
// canvas, and handed back through a blob URL.

// --------------------------------------------------------------------- the state
const cfg = {
  across: 3,
  down: 3,
  square: true,          // one number for both, so the sheet keeps the source's shape
  mirror: 'off',         // 'off' | 'x' | 'both'
  offset: 0,             // percent of a tile, applied to every other row
  gap: 0,                // percent of a tile's width, between tiles and around them
  bg: '#ffffff',
  width: 2048,           // the exported sheet's width in pixels
  format: 'image/png',
};

let img = null;          // ImageBitmap or HTMLImageElement, whichever we got
let imgName = '';
// Whether the export width is a number somebody chose. Until it is, it follows
// the grid: three tiles of a 900px photo want a wider sheet than one tile does,
// and a default that ignores the grid is wrong the moment the grid changes.
let widthTouched = false;

// A canvas has a maximum area as well as a maximum side, and both are lower on
// iOS than anywhere else. Past this the browser hands back a blank bitmap rather
// than an error, so the check has to happen here.
const MAX_PIXELS = 40e6;
const MAX_SIDE = 8000;

// --------------------------------------------------------------------- the sheet
/**
 * The geometry of a sheet `w` pixels wide.
 *
 * A tile keeps the source's aspect, always: a grid of squashed copies is a
 * different picture, not a tiling of this one. So the tile width falls out of
 * how many have to fit across, the tile height follows from the source, and the
 * sheet's height is whatever that leaves. The sheet's shape is therefore a
 * result and never an input, which is why there is no "output size" control
 * beyond the one number.
 */
function sheetSize(w, source, o) {
  const aspect = source.width / source.height;
  const g = o.gap / 100;
  // n tiles and n+1 gutters, counting the two outer margins.
  const tw = w / (o.across + (o.across + 1) * g);
  const th = tw / aspect;
  const margin = g * tw;
  const h = o.down * th + (o.down + 1) * margin;
  return { w, h: Math.max(1, Math.round(h)), tw, th, margin };
}

/**
 * One tile, flipped or not.
 *
 * Mirroring is the reason this app is worth having over a screenshot and a
 * copy-paste: a photograph tiled straight has a hard seam everywhere two copies
 * meet, because the left edge of the picture has nothing to do with the right
 * one. Flip every other column and each seam becomes an edge meeting itself,
 * which is continuous by construction. Flip the rows too and it is continuous in
 * both directions — a real repeating pattern out of any picture at all.
 *
 * The column index runs from -1, and a bitwise & on -1 gives 1, so the parity
 * carries across zero correctly and the tile hanging off the left edge is
 * flipped the same way its neighbors expect.
 */
function drawTile(ctx, source, x, y, w, h, col, row, mirror) {
  const fx = mirror !== 'off' && (col & 1) ? -1 : 1;
  const fy = mirror === 'both' && (row & 1) ? -1 : 1;
  if (fx === 1 && fy === 1) {
    ctx.drawImage(source, x, y, w, h);
    return;
  }
  ctx.save();
  ctx.translate(x + (fx < 0 ? w : 0), y + (fy < 0 ? h : 0));
  ctx.scale(fx, fy);
  ctx.drawImage(source, 0, 0, w, h);
  ctx.restore();
}

/** The sheet, at whatever size the canvas already is. */
function drawSheet(ctx, source, o, S) {
  ctx.save();
  ctx.fillStyle = o.bg;
  ctx.fillRect(0, 0, S.w, S.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // An offset row reaches past both edges, and a tile drawn past the edge of the
  // sheet is not the app's business — clip once rather than working out partial
  // rectangles for every tile.
  ctx.beginPath();
  ctx.rect(0, 0, S.w, S.h);
  ctx.clip();

  const stepX = S.tw + S.margin;
  const stepY = S.th + S.margin;
  const shift = (o.offset / 100) * stepX;
  for (let row = 0; row < o.down; row++) {
    const y = S.margin + row * stepY;
    // Every other row, not a running total: a cumulative shift is a diagonal,
    // and what the word offset means on a wall is brickwork.
    const dx = (row & 1) ? shift : 0;
    // One extra tile each side, so a shifted row still reaches both edges
    // instead of leaving a bare strip the background color shows through.
    for (let col = -1; col <= o.across; col++) {
      const x = S.margin + col * stepX + dx;
      if (x >= S.w || x + S.tw <= 0) continue;
      drawTile(ctx, source, x, y, S.tw, S.th, col, row, o.mirror);
    }
  }
  ctx.restore();
}

// --------------------------------------------------------------------- the view
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const emptyEl = document.getElementById('empty');

/**
 * Fit the sheet into the stage and draw it there.
 *
 * The preview is its own size, not a scaled copy of the export: drawing the same
 * sheet at 900px and at 6000px goes down the same path, so what is on screen is
 * the picture that will come out and not a rendering of it.
 */
function render() {
  if (!img) return;
  const box = stage.getBoundingClientRect();
  const pad = 36;
  const availW = Math.max(80, box.width - pad);
  const availH = Math.max(80, box.height - pad);
  // The shape first, from a nominal width, because the height is a result.
  const nominal = sheetSize(1000, img, cfg);
  const aspect = nominal.w / nominal.h;
  let cssW = availW;
  let cssH = cssW / aspect;
  if (cssH > availH) { cssH = availH; cssW = cssH * aspect; }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const S = sheetSize(pxW, img, cfg);
  if (canvas.width !== S.w || canvas.height !== S.h) {
    canvas.width = S.w;
    canvas.height = S.h;
  }
  canvas.style.width = `${Math.round(cssW)}px`;
  canvas.style.height = `${Math.round(cssH)}px`;
  drawSheet(ctx, img, cfg, S);
  paintOutSize();
}

/** What the file will be, said before it is made rather than after it fails. */
function paintOutSize() {
  if (!img) { outEl.textContent = ' '; outEl.classList.remove('warn'); return; }
  const S = sheetSize(cfg.width, img, cfg);
  const px = S.w * S.h;
  const over = px > MAX_PIXELS || S.h > MAX_SIDE;
  outEl.textContent = `${S.w} × ${S.h}${over ? ' — too big to draw, bring the width down' : ''}`;
  outEl.classList.toggle('warn', over);
  exportBtn.disabled = !img || over;
}

// --------------------------------------------------------------------- the image
/**
 * A file to something drawable. createImageBitmap is the fast path and the one
 * that honors the orientation an EXIF tag asks for; the <img> fallback is for
 * browsers that have neither.
 */
async function toImage(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall through: Safari has refused this for some sources */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('could not decode that file'));
      el.src = url;
    });
  } finally {
    // Revoking immediately is safe: a decoded <img> keeps its own bitmap.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function useFile(file) {
  if (!file || !/^image\//.test(file.type)) {
    toast('That is not an image');
    return;
  }
  let next;
  try {
    next = await toImage(file);
  } catch (e) {
    toast(e.message || 'Could not read that image');
    return;
  }
  if (img && img.close) img.close();
  img = next;
  imgName = (file.name || 'image').replace(/\.[^.]+$/, '');
  srcHint.textContent = `${imgName} · ${img.width} × ${img.height}`;
  emptyEl.hidden = true;
  canvas.hidden = false;
  for (const s of sections) s.setAttribute('aria-disabled', 'false');
  if (!widthTouched) autoWidth();
  render();
}

/**
 * A width that shows the picture at about its own resolution, tile for tile,
 * and then a cap. A 4000px photo across eight tiles is a 32000px sheet, which no
 * browser will allocate; being quietly given a quarter of the detail is a better
 * outcome than being handed a blank file.
 */
function autoWidth() {
  const want = cfg.across * img.width;
  const byArea = Math.sqrt(MAX_PIXELS * (img.width / img.height) * (cfg.across / cfg.down));
  const w = Math.round(Math.min(want, byArea, MAX_SIDE));
  setNumber('width', Math.max(256, Math.min(8000, w)), { silent: true });
}

// --------------------------------------------------------------------- the export
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function exportSheet() {
  if (!img) return;
  const S = sheetSize(cfg.width, img, cfg);
  if (S.w * S.h > MAX_PIXELS || S.h > MAX_SIDE) { toast('That sheet is too big to draw'); return; }
  const off = document.createElement('canvas');
  off.width = S.w;
  off.height = S.h;
  const octx = off.getContext('2d');
  // JPEG has no transparency, and neither does this sheet — the background is
  // painted either way — so the two formats differ only in size and in edges.
  drawSheet(octx, img, cfg, S);
  const ext = cfg.format === 'image/jpeg' ? 'jpg' : 'png';
  off.toBlob((blob) => {
    if (!blob) { toast('The browser could not write that file'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${imgName || 'tiled'}-${cfg.across}x${cfg.down}-${stamp()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Saved ${S.w} × ${S.h}`);
  }, cfg.format, cfg.format === 'image/jpeg' ? 0.92 : undefined);
}

// --------------------------------------------------------------------- the wiring
const els = {};
for (const id of ['across', 'down', 'offset', 'gap', 'width']) {
  els[id] = { range: document.getElementById(id), num: document.getElementById(`${id}-val`) };
}
const linkEl = document.getElementById('link');
const mirrorEl = document.getElementById('mirror');
const bgEl = document.getElementById('bg');
const formatEl = document.getElementById('format');
const outEl = document.getElementById('out-size');
const srcHint = document.getElementById('src-hint');
const exportBtn = document.getElementById('export-btn');
const fileEl = document.getElementById('file');
const sections = ['grid-section', 'pattern-section', 'export-section'].map((id) => document.getElementById(id));

/** Put a value into cfg and into both halves of its control. */
function setNumber(key, value, { silent = false } = {}) {
  const { range, num } = els[key];
  const lo = Number(range.min), hi = Number(range.max), step = Number(range.step) || 1;
  const v = Math.max(lo, Math.min(hi, Math.round(value / step) * step));
  cfg[key] = v;
  range.value = String(v);
  num.value = String(v);
  num.removeAttribute('aria-invalid');
  if (!silent) render();
}

for (const key of Object.keys(els)) {
  const { range, num } = els[key];
  range.addEventListener('input', () => {
    cfg[key] = Number(range.value);
    num.value = range.value;
    num.removeAttribute('aria-invalid');
    if (key === 'width') widthTouched = true;
    // The square switch is a statement about the grid, so it holds while either
    // number is moved rather than only while the one it was set from is.
    if (cfg.square && (key === 'across' || key === 'down')) {
      const other = key === 'across' ? 'down' : 'across';
      cfg[other] = cfg[key];
      els[other].range.value = String(cfg[key]);
      els[other].num.value = String(cfg[key]);
    }
    if (!widthTouched && img && (key === 'across' || key === 'down')) autoWidth();
    render();
  });
  // Typing is allowed to be in progress: a half-finished number is not an error,
  // it is just not a value yet, so it colors itself and changes nothing.
  num.addEventListener('input', () => {
    const v = Number(num.value.replace(/[^0-9.]/g, ''));
    const lo = Number(range.min), hi = Number(range.max);
    if (!Number.isFinite(v) || num.value.trim() === '' || v < lo || v > hi) {
      num.setAttribute('aria-invalid', 'true');
      return;
    }
    num.removeAttribute('aria-invalid');
    if (key === 'width') widthTouched = true;
    cfg[key] = v;
    range.value = String(v);
    if (cfg.square && (key === 'across' || key === 'down')) {
      const other = key === 'across' ? 'down' : 'across';
      setNumber(other, v, { silent: true });
    }
    render();
  });
  num.addEventListener('blur', () => setNumber(key, Number(num.value) || Number(range.value)));
}

linkEl.addEventListener('change', () => {
  cfg.square = linkEl.checked;
  // Turning it on squares up on the number you can see first, which is Across.
  if (cfg.square) setNumber('down', cfg.across, { silent: true });
  if (!widthTouched && img) autoWidth();
  render();
});
mirrorEl.addEventListener('change', () => { cfg.mirror = mirrorEl.value; render(); });
bgEl.addEventListener('input', () => { cfg.bg = bgEl.value; render(); });
formatEl.addEventListener('change', () => { cfg.format = formatEl.value; });
exportBtn.addEventListener('click', exportSheet);

for (const id of ['file-btn', 'empty-btn']) {
  document.getElementById(id).addEventListener('click', () => fileEl.click());
}
fileEl.addEventListener('change', () => {
  if (fileEl.files && fileEl.files[0]) useFile(fileEl.files[0]);
  // Cleared, so choosing the same file twice in a row still fires.
  fileEl.value = '';
});

// Drop, on the stage rather than the window: the panel is a form, and a file
// dropped on a slider should do what the browser normally does with it.
for (const type of ['dragenter', 'dragover']) {
  stage.addEventListener(type, (e) => { e.preventDefault(); stage.classList.add('dropping'); });
}
for (const type of ['dragleave', 'dragend']) {
  stage.addEventListener(type, (e) => {
    if (e.type === 'dragleave' && stage.contains(e.relatedTarget)) return;
    stage.classList.remove('dropping');
  });
}
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dropping');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) useFile(f);
});

window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  // Indexed rather than iterated: DataTransferItemList is array-LIKE, and in
  // some browsers it carries no iterator at all, so for..of throws.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'file' && /^image\//.test(it.type)) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); useFile(f); }
      return;
    }
  }
});

// --------------------------------------------------------------------- the trim
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

const scrim = document.getElementById('scrim');
const menuBtn = document.getElementById('menu-btn');
function setMenu(open) {
  scrim.hidden = !open;
  menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
menuBtn.addEventListener('click', () => setMenu(scrim.hidden));
document.getElementById('close-btn').addEventListener('click', () => setMenu(false));
scrim.addEventListener('click', (e) => { if (e.target === scrim) setMenu(false); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !scrim.hidden) setMenu(false);
});

// A phone showing and hiding its URL bar fires this constantly, and redrawing a
// sheet is cheap, but not free at 8000px. One frame's worth of coalescing.
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; render(); });
});

paintOutSize();
