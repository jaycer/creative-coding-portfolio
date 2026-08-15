// Meme Generator — pictures and words, stacked, and a JPG at the end.
//
// The whole app is one canvas at the exact pixel size of the export. Nothing is
// laid out in CSS and rescaled at the end: the canvas backing store IS
// 1080×1350, shown small by CSS, so what is on screen is the file, and Export is
// a copy of the same paint routine with the selection handles left off. The one
// piece of arithmetic that costs anything is going from a pointer on screen back
// into those 1080 units, and it lives in one function (`toCanvas`).
//
// Every format is 1080 wide — that is what Instagram wants and it is also what
// makes a format switch cheap: only the height changes, so a text size in canvas
// pixels stays meaningful and only the y of each layer has to be remapped.
//
// Layers are one flat array, back to front, holding both pictures and text. The
// list in the panel shows it reversed, because "top of the list" should mean
// "on top of the picture". Reordering is two buttons rather than a drag: this is
// an editor a thumb has to be able to work, and a drag-to-reorder list on a
// touch screen fights the drag that moves the layer on the canvas.
//
// Nothing is uploaded and nothing is remembered. An image lives in a bitmap in
// this tab and goes away with it — which is also why there is no autosave: a
// meme editor that reopens on yesterday's half-finished meme is a worse app.

'use strict';

// ---------------------------------------------------------------- the formats
// All 1080 wide. Instagram's own numbers for a portrait post, a square, a story
// and the wide crop, so an export needs no resizing after it lands.
const FORMATS = [
  { id: '4:5', label: '4:5 portrait (post)', w: 1080, h: 1350 },
  { id: '1:1', label: '1:1 square', w: 1080, h: 1080 },
  { id: '9:16', label: '9:16 story', w: 1080, h: 1920 },
  { id: '1.91:1', label: '1.91:1 wide', w: 1080, h: 566 },
];

// The usual suspects, and one of them is the point. Impact is what a meme looks
// like, and iOS does not have it — so the stack leads with Anton, which ships in
// this folder, and falls back through the Impact-alikes for anything that got
// here without loading it. The rest are stacks rather than single names so that
// a Mac, a Windows box and a phone each land on something with the right
// personality even though none of them have the same fonts installed.
const FONTS = [
  { id: 'impact', label: 'Impact', weight: 400, stack: "'Anton', Impact, 'Haettenschweiler', 'Arial Narrow', sans-serif" },
  { id: 'sans', label: 'Helvetica', weight: 700, stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: 'serif', label: 'Georgia', weight: 700, stack: "Georgia, 'Times New Roman', Times, serif" },
  { id: 'mono', label: 'Courier', weight: 700, stack: "'Courier New', Courier, monospace" },
  { id: 'wide', label: 'Verdana', weight: 700, stack: "Verdana, 'Trebuchet MS', Geneva, sans-serif" },
  { id: 'comic', label: 'Comic', weight: 700, stack: "'Comic Sans MS', 'Chalkboard SE', 'Marker Felt', cursive" },
];
const fontById = (id) => FONTS.find((f) => f.id === id) || FONTS[0];

const LINE_H = 1.16;      // multiples of the font size, tight enough for caps
const MIN_TEXT = 12;
const MAX_TEXT = 400;
const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
const JPEG_QUALITY = 0.92;

// ------------------------------------------------------------------ the state
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
// A second context that never draws, only measures. Text metrics need a font set
// on a context, and doing that on the visible one mid-paint means the paint has
// to put everything back afterwards.
const scratch = document.createElement('canvas').getContext('2d');

const state = {
  format: FORMATS[0],
  bg: '#000000',
  layers: [],       // back to front
  selected: null,   // layer id
  nextId: 1,
  textCount: 0,     // only for deciding where a new line of text lands
};

const W = () => state.format.w;
const H = () => state.format.h;
const byId = (id) => state.layers.find((l) => l.id === id) || null;
const selected = () => byId(state.selected);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ measuring
function fontSpec(layer) {
  const f = fontById(layer.font);
  return `${f.weight} ${layer.size}px ${f.stack}`;
}

/**
 * Break a text layer into the lines it will actually draw as, and measure them.
 * Wrapping happens in canvas units against `wrap` (a fraction of the canvas
 * width), so a line breaks in the same place on a phone as on a desktop — the
 * display size never enters into it.
 */
function layoutText(layer) {
  scratch.font = fontSpec(layer);
  const maxW = Math.max(1, layer.wrap * W());
  const src = layer.caps ? layer.text.toUpperCase() : layer.text;
  const lines = [];
  for (const para of src.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      // A single word wider than the box is left to overflow rather than
      // hyphenated mid-word: on a meme that word is usually the joke.
      if (line && scratch.measureText(next).width > maxW) { lines.push(line); line = word; }
      else line = next;
    }
    lines.push(line);
  }
  const lineH = layer.size * LINE_H;
  let w = 0;
  for (const l of lines) w = Math.max(w, scratch.measureText(l).width);
  return { lines, lineH, w, h: lines.length * lineH };
}

/** The unrotated box a layer occupies, in canvas units, centered on its x,y. */
function bounds(layer) {
  if (layer.type === 'image') {
    return { w: layer.natW * layer.scale, h: layer.natH * layer.scale };
  }
  const m = layoutText(layer);
  // The outline hangs outside the glyphs, so the grab box has to include it or
  // the handles sit inside the shape they are meant to be holding.
  const pad = layer.size * layer.strokeW;
  return { w: m.w + pad * 2, h: m.h + pad * 2, metrics: m };
}

// ------------------------------------------------------------------- painting
/**
 * Draw the whole picture into a context. `overlay` is the only difference
 * between what is on screen and what gets exported: the selection box, the
 * handles and the empty-canvas hint are all in it, and the export asks for
 * none of them.
 */
function paint(c, overlay) {
  c.save();
  c.fillStyle = state.bg;
  c.fillRect(0, 0, W(), H());
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';

  for (const layer of state.layers) {
    if (!layer.visible) continue;
    c.save();
    c.globalAlpha = layer.opacity;
    c.translate(layer.x, layer.y);
    c.rotate(layer.rot);
    if (layer.type === 'image') {
      const w = layer.natW * layer.scale;
      const h = layer.natH * layer.scale;
      c.drawImage(layer.bitmap, -w / 2, -h / 2, w, h);
    } else {
      paintText(c, layer);
    }
    c.restore();
  }
  c.restore();

  if (overlay) {
    if (!state.layers.length) paintHint(c);
    const sel = selected();
    if (sel && sel.visible) paintSelection(c, sel);
  }
}

function paintText(c, layer) {
  const m = layoutText(layer);
  c.font = fontSpec(layer);
  c.textBaseline = 'middle';
  c.textAlign = layer.align;
  c.lineJoin = 'round';
  c.miterLimit = 2;
  // The block is centered on the layer's point; within it, the alignment
  // decides which edge the lines are pinned to.
  const ax = layer.align === 'left' ? -m.w / 2 : layer.align === 'right' ? m.w / 2 : 0;
  for (let i = 0; i < m.lines.length; i++) {
    const by = -m.h / 2 + m.lineH * (i + 0.5);
    if (layer.strokeW > 0) {
      // A stroke straddles the outline, so half of it is buried under the fill
      // that follows. Doubled here so the slider means the ink you can see.
      c.lineWidth = layer.size * layer.strokeW * 2;
      c.strokeStyle = layer.stroke;
      c.strokeText(m.lines[i], ax, by);
    }
    c.fillStyle = layer.color;
    c.fillText(m.lines[i], ax, by);
  }
}

function paintHint(c) {
  c.save();
  c.fillStyle = 'rgba(255,255,255,0.34)';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `500 40px ${FONTS[1].stack}`;
  c.fillText('Add an image, or some text', W() / 2, H() / 2);
  c.restore();
}

/** Canvas units per CSS pixel — the handles are sized in screen terms so they
 *  stay the same size to a finger whatever the format and the window are. */
function unitsPerPx() {
  const r = canvas.getBoundingClientRect();
  return r.width ? W() / r.width : 1;
}

function handlePoints(layer) {
  const b = bounds(layer);
  const k = unitsPerPx();
  const arm = 34 * k;
  const cos = Math.cos(layer.rot);
  const sin = Math.sin(layer.rot);
  const at = (lx, ly) => ({ x: layer.x + lx * cos - ly * sin, y: layer.y + lx * sin + ly * cos });

  // The rotate handle normally stands above the box. A meme's top line sits at
  // the very top of the frame, though, and an arm above THAT is off the canvas
  // and cannot be grabbed at all — so it swings under the box whenever there is
  // more room down there. Measured as distance to the nearest edge, which also
  // covers a layer pushed against the left, right or bottom.
  const room = (p) => Math.min(p.x, W() - p.x, p.y, H() - p.y);
  let rotate = at(0, -b.h / 2 - arm);
  let stem = at(0, -b.h / 2);
  const under = at(0, b.h / 2 + arm);
  if (room(under) > room(rotate)) { rotate = under; stem = at(0, b.h / 2); }

  return {
    b, k, cos, sin, rotate, stem,
    scale: at(b.w / 2, b.h / 2),
    corners: [at(-b.w / 2, -b.h / 2), at(b.w / 2, -b.h / 2), at(b.w / 2, b.h / 2), at(-b.w / 2, b.h / 2)],
  };
}

function paintSelection(c, layer) {
  const hp = handlePoints(layer);
  const k = hp.k;
  c.save();
  c.strokeStyle = '#7fe8c0';
  c.fillStyle = '#7fe8c0';
  c.lineWidth = 1.5 * k;
  c.setLineDash([7 * k, 5 * k]);
  c.beginPath();
  hp.corners.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.closePath();
  c.stroke();
  c.setLineDash([]);
  // The arm the rotate handle sits on, so it reads as attached to the layer
  // rather than floating near it.
  c.beginPath();
  c.moveTo(hp.stem.x, hp.stem.y);
  c.lineTo(hp.rotate.x, hp.rotate.y);
  c.stroke();
  for (const p of [hp.rotate, hp.scale]) {
    c.beginPath();
    c.arc(p.x, p.y, 9 * k, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.stroke();
    c.strokeStyle = '#7fe8c0';
  }
  c.restore();
}

// One paint per frame however many things asked for one — a slider drag fires
// input events faster than a 1080-wide canvas wants to be repainted.
let painting = false;
function draw() {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => {
    painting = false;
    paint(ctx, true);
  });
}

// -------------------------------------------------------------- layer making
function baseLayer(type) {
  return {
    id: state.nextId++,
    type,
    x: W() / 2,
    y: H() / 2,
    rot: 0,
    opacity: 1,
    visible: true,
  };
}

function addText() {
  const layer = Object.assign(baseLayer('text'), {
    text: 'Top text',
    font: 'impact',
    size: 96,
    color: '#ffffff',
    stroke: '#000000',
    strokeW: 0.08,
    align: 'center',
    caps: true,
    wrap: 0.9,
  });
  // The first two lines land where a meme puts them, top and bottom. After that
  // it is anybody's guess, so they arrive in the middle to be moved.
  if (state.textCount === 0) { layer.y = H() * 0.14; }
  else if (state.textCount === 1) { layer.y = H() * 0.86; layer.text = 'Bottom text'; }
  state.textCount++;
  state.layers.push(layer);
  selectLayer(layer.id);
  syncAll();
}

function addImage(bitmap, name) {
  const layer = Object.assign(baseLayer('image'), {
    bitmap,
    natW: bitmap.width,
    natH: bitmap.height,
    name: name || 'Image',
    scale: 1,
  });
  fitLayer(layer, 'cover');
  // A picture arrives under the words already on the meme, which is nearly
  // always what was meant: text on top of the photo, not buried by the next one.
  const firstText = state.layers.findIndex((l) => l.type === 'text');
  if (firstText === -1) state.layers.push(layer);
  else state.layers.splice(firstText, 0, layer);
  selectLayer(layer.id);
  syncAll();
}

/** Cover fills the frame and crops; contain fits the whole picture inside it. */
function fitLayer(layer, mode) {
  const sx = W() / layer.natW;
  const sy = H() / layer.natH;
  layer.scale = mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  layer.rot = 0;
  layer.x = W() / 2;
  layer.y = H() / 2;
}

function removeLayer(id) {
  const i = state.layers.findIndex((l) => l.id === id);
  if (i === -1) return;
  state.layers.splice(i, 1);
  if (state.selected === id) {
    const next = state.layers[Math.min(i, state.layers.length - 1)];
    state.selected = next ? next.id : null;
  }
  syncAll();
}

function duplicateLayer(id) {
  const src = byId(id);
  if (!src) return;
  const copy = Object.assign({}, src, { id: state.nextId++ });
  // Offset so the copy is visibly a second thing rather than a layer that looks
  // like it did nothing.
  copy.x += 28;
  copy.y += 28;
  const i = state.layers.indexOf(src);
  state.layers.splice(i + 1, 0, copy);
  selectLayer(copy.id);
  syncAll();
}

/** dir is +1 toward the front of the picture, -1 toward the back. */
function moveLayer(id, dir) {
  const i = state.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= state.layers.length) return;
  const [l] = state.layers.splice(i, 1);
  state.layers.splice(j, 0, l);
  syncAll();
}

function selectLayer(id) {
  state.selected = id;
  syncLayerList();
  syncInspector();
  draw();
}

// The one number a gesture changes, whatever kind of layer it is holding.
const sizeOf = (l) => (l.type === 'text' ? l.size : l.scale);
function setSize(l, v) {
  if (l.type === 'text') l.size = clamp(Math.round(v), MIN_TEXT, MAX_TEXT);
  else l.scale = clamp(v, MIN_SCALE, MAX_SCALE);
}

// ------------------------------------------------------- pointer interaction
const pointers = new Map();
let drag = null;
let pinch = null;

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (W() / r.width),
    y: (e.clientY - r.top) * (H() / r.height),
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Is p inside this layer's rotated box? Asked by rotating p backwards into the
 *  layer's own frame, where the box is an axis-aligned rectangle again. */
function hitLayer(layer, p) {
  const b = bounds(layer);
  const dx = p.x - layer.x;
  const dy = p.y - layer.y;
  const cos = Math.cos(-layer.rot);
  const sin = Math.sin(-layer.rot);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

function pickLayer(p) {
  // Front to back, so the thing you can see is the thing you grab.
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (l.visible && hitLayer(l, p)) return l;
  }
  return null;
}

function pickHandle(p) {
  const sel = selected();
  if (!sel || !sel.visible) return null;
  const hp = handlePoints(sel);
  const near = 20 * hp.k;
  if (dist(p, hp.rotate) <= near) return 'rotate';
  if (dist(p, hp.scale) <= near) return 'scale';
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, toCanvas(e));
  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;

  const p = toCanvas(e);
  const sel = selected();
  const handle = pickHandle(p);
  if (handle && sel) {
    const b = bounds(sel);
    drag = handle === 'rotate'
      ? { mode: 'rotate', id: sel.id, a0: Math.atan2(p.y - sel.y, p.x - sel.x), rot0: sel.rot }
      : { mode: 'scale', id: sel.id, d0: Math.max(1, dist(p, sel)), s0: sizeOf(sel), diag: Math.hypot(b.w, b.h) / 2 };
    return;
  }

  const hit = pickLayer(p);
  if (!hit) { selectLayer(null); return; }
  if (hit.id !== state.selected) selectLayer(hit.id);
  drag = { mode: 'move', id: hit.id, dx: hit.x - p.x, dy: hit.y - p.y };
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, toCanvas(e));
  if (pinch) { movePinch(); return; }

  const p = toCanvas(e);
  if (!drag) { hoverCursor(p); return; }

  const l = byId(drag.id);
  if (!l) return;
  if (drag.mode === 'move') {
    // Kept reachable: a layer may hang well off the edge, but not so far that
    // there is nothing left on screen to grab it by.
    l.x = clamp(p.x + drag.dx, -W() * 0.4, W() * 1.4);
    l.y = clamp(p.y + drag.dy, -H() * 0.4, H() * 1.4);
  } else if (drag.mode === 'rotate') {
    let rot = drag.rot0 + (Math.atan2(p.y - l.y, p.x - l.x) - drag.a0);
    // A magnet at the square angles only. Every 15° would fight anyone trying
    // to set a deliberate slight tilt, which is most of what this is used for.
    const quarter = Math.PI / 2;
    const snapped = Math.round(rot / quarter) * quarter;
    if (Math.abs(rot - snapped) < 0.045) rot = snapped;
    l.rot = rot;
  } else if (drag.mode === 'scale') {
    setSize(l, drag.s0 * (dist(p, l) / drag.d0));
  }
  syncTransformControls();
  draw();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    if (drag) { drag = null; syncInspector(); syncLayerList(); }
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function hoverCursor(p) {
  const h = pickHandle(p);
  canvas.style.cursor = h === 'rotate' ? 'grab' : h === 'scale' ? 'nwse-resize' : pickLayer(p) ? 'move' : 'default';
}

// Two fingers do all three transforms at once, which is how a phone expects to
// place something: the pinch scales, the twist rotates, and the midpoint drags.
function startPinch() {
  const sel = selected();
  const [a, b] = [...pointers.values()];
  if (!sel) return;
  drag = null;
  pinch = {
    id: sel.id,
    d0: Math.max(1, dist(a, b)),
    a0: Math.atan2(b.y - a.y, b.x - a.x),
    c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    rot0: sel.rot, s0: sizeOf(sel), x0: sel.x, y0: sel.y,
  };
}

function movePinch() {
  const l = byId(pinch.id);
  if (!l) return;
  const [a, b] = [...pointers.values()];
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  setSize(l, pinch.s0 * (dist(a, b) / pinch.d0));
  l.rot = pinch.rot0 + (Math.atan2(b.y - a.y, b.x - a.x) - pinch.a0);
  l.x = clamp(pinch.x0 + (c.x - pinch.c0.x), -W() * 0.4, W() * 1.4);
  l.y = clamp(pinch.y0 + (c.y - pinch.c0.y), -H() * 0.4, H() * 1.4);
  syncTransformControls();
  draw();
}

// ---------------------------------------------------------------- layer list
const layerList = document.getElementById('layer-list');
const layersEmpty = document.getElementById('layers-empty');

function layerName(l) {
  if (l.type === 'image') return l.name;
  const first = (l.text || '').split('\n')[0].trim();
  return first || 'Text';
}

function syncLayerList() {
  layersEmpty.hidden = state.layers.length > 0;
  layerList.textContent = '';
  // Reversed: the row at the top of the list is the layer on top of the picture.
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    const li = document.createElement('li');
    li.dataset.id = String(l.id);
    li.setAttribute('aria-selected', String(l.id === state.selected));
    if (!l.visible) li.classList.add('hidden');

    const kind = document.createElement('span');
    kind.className = 'layer-kind';
    kind.textContent = l.type === 'image' ? '▦' : 'T';
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layerName(l);
    li.append(kind, name);

    const btn = (label, title, act, disabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layer-btn' + (act === 'remove' ? ' danger' : '');
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.dataset.act = act;
      b.disabled = !!disabled;
      li.appendChild(b);
      return b;
    };
    btn('↑', 'Move up', 'up', i === state.layers.length - 1);
    btn('↓', 'Move down', 'down', i === 0);
    btn(l.visible ? '◉' : '○', l.visible ? 'Hide' : 'Show', 'vis');
    btn('✕', 'Delete layer', 'remove');
    layerList.appendChild(li);
  }
}

layerList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = Number(li.dataset.id);
  const act = e.target.dataset && e.target.dataset.act;
  if (act === 'up') moveLayer(id, 1);
  else if (act === 'down') moveLayer(id, -1);
  else if (act === 'remove') removeLayer(id);
  else if (act === 'vis') {
    const l = byId(id);
    if (l) l.visible = !l.visible;
    syncAll();
  } else selectLayer(id);
});

// ----------------------------------------------------------------- inspector
const el = (id) => document.getElementById(id);
const inspector = el('inspector');
const inspTitle = el('insp-title');
const textControls = el('text-controls');
const imageControls = el('image-controls');
const textInput = el('text-input');
const fontSelect = el('font-select');
const sizeRange = el('size-range');
const wrapRange = el('wrap-range');
const alignSeg = el('align-seg');
const capsOn = el('caps-on');
const capsOff = el('caps-off');
const fillColor = el('fill-color');
const strokeColor = el('stroke-color');
const strokeRange = el('stroke-range');
const scaleRange = el('scale-range');
const rotRange = el('rot-range');
const opacityRange = el('opacity-range');

for (const f of FONTS) {
  const o = document.createElement('option');
  o.value = f.id;
  o.textContent = f.label;
  o.style.fontFamily = f.stack;
  fontSelect.appendChild(o);
}

/** Radians to the degrees the slider speaks: a whole number in (-180, 180], so
 *  a layer spun several times around still reads as the angle it looks like. */
function degrees(rad) {
  const d = Math.round((rad * 180) / Math.PI);
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** The readouts and the two controls a canvas gesture moves under your hand. */
function syncTransformControls() {
  const l = selected();
  if (!l) return;
  rotRange.value = String(degrees(l.rot));
  el('rot-val').textContent = rotRange.value + '°';
  if (l.type === 'text') {
    sizeRange.value = String(l.size);
    el('size-val').textContent = String(l.size);
  } else {
    scaleRange.value = String(Math.round(l.scale * 100));
    el('scale-val').textContent = Math.round(l.scale * 100) + '%';
  }
}

function syncInspector() {
  const l = selected();
  inspector.hidden = !l;
  if (!l) return;
  const isText = l.type === 'text';
  textControls.hidden = !isText;
  imageControls.hidden = isText;
  inspTitle.textContent = isText ? 'Text layer' : 'Image layer';

  if (isText) {
    // Only written when it is not the field being typed in, or the caret jumps
    // to the end on every keystroke.
    if (document.activeElement !== textInput) textInput.value = l.text;
    fontSelect.value = l.font;
    wrapRange.value = String(Math.round(l.wrap * 100));
    el('wrap-val').textContent = Math.round(l.wrap * 100) + '%';
    fillColor.value = l.color;
    strokeColor.value = l.stroke;
    strokeRange.value = String(Math.round(l.strokeW * 100));
    for (const b of alignSeg.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.align === l.align));
    }
    capsOn.setAttribute('aria-pressed', String(l.caps));
    capsOff.setAttribute('aria-pressed', String(!l.caps));
  }
  opacityRange.value = String(Math.round(l.opacity * 100));
  el('opacity-val').textContent = Math.round(l.opacity * 100) + '%';
  syncTransformControls();
}

function syncAll() {
  syncLayerList();
  syncInspector();
  draw();
}

/** Wire a control to the selected layer: change it, repaint, and refresh the
 *  list only when the change is one the list can see. */
function onControl(node, event, fn, { relist = false } = {}) {
  node.addEventListener(event, () => {
    const l = selected();
    if (!l) return;
    fn(l);
    if (relist) syncLayerList();
    draw();
  });
}

onControl(textInput, 'input', (l) => { l.text = textInput.value; }, { relist: true });
onControl(fontSelect, 'change', (l) => { l.font = fontSelect.value; });
onControl(sizeRange, 'input', (l) => {
  l.size = Number(sizeRange.value);
  el('size-val').textContent = sizeRange.value;
});
onControl(wrapRange, 'input', (l) => {
  l.wrap = Number(wrapRange.value) / 100;
  el('wrap-val').textContent = wrapRange.value + '%';
});
onControl(strokeRange, 'input', (l) => { l.strokeW = Number(strokeRange.value) / 100; });
onControl(fillColor, 'input', (l) => { l.color = fillColor.value; });
onControl(strokeColor, 'input', (l) => { l.stroke = strokeColor.value; });
onControl(scaleRange, 'input', (l) => {
  l.scale = Number(scaleRange.value) / 100;
  el('scale-val').textContent = scaleRange.value + '%';
});
onControl(rotRange, 'input', (l) => {
  l.rot = (Number(rotRange.value) * Math.PI) / 180;
  el('rot-val').textContent = rotRange.value + '°';
});
onControl(opacityRange, 'input', (l) => {
  l.opacity = Number(opacityRange.value) / 100;
  el('opacity-val').textContent = opacityRange.value + '%';
});

alignSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  const l = selected();
  if (!b || !l) return;
  l.align = b.dataset.align;
  syncInspector();
  draw();
});
capsOn.addEventListener('click', () => { const l = selected(); if (l) { l.caps = true; syncInspector(); draw(); } });
capsOff.addEventListener('click', () => { const l = selected(); if (l) { l.caps = false; syncInspector(); draw(); } });

for (const b of document.querySelectorAll('.fit-btn')) {
  b.addEventListener('click', () => {
    const l = selected();
    if (!l || l.type !== 'image') return;
    fitLayer(l, b.dataset.fit);
    syncInspector();
    draw();
  });
}

el('straighten-btn').addEventListener('click', () => {
  const l = selected();
  if (!l) return;
  l.rot = 0;
  syncInspector();
  draw();
});
el('center-btn').addEventListener('click', () => {
  const l = selected();
  if (!l) return;
  l.x = W() / 2;
  l.y = H() / 2;
  draw();
});
el('dupe-btn').addEventListener('click', () => { if (state.selected != null) duplicateLayer(state.selected); });

// -------------------------------------------------------------- adding image
const fileInput = el('file');
el('add-text').addEventListener('click', addText);
el('add-image').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  for (const f of fileInput.files) await loadImageFile(f);
  // Cleared so picking the same file twice in a row still fires a change event.
  fileInput.value = '';
});

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const bitmap = await decode(file);
    addImage(bitmap, file.name.replace(/\.[^.]+$/, '').slice(0, 28) || 'Image');
  } catch (err) {
    console.error('[meme] could not read that image', err);
    window.alert('That image could not be read.');
  }
}

/**
 * A file to something drawable. createImageBitmap is the fast path and is also
 * the one that can be told to honor the EXIF rotation a phone camera writes;
 * the <img> fallback is for engines that do not take options here.
 */
async function decode(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall through to the img path */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('decode failed'));
      img.src = url;
    });
    if (img.decode) { try { await img.decode(); } catch { /* already loaded */ } }
    return img;
  } finally {
    // Revoked late enough that the bitmap is decoded and drawing keeps working.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// Drop and paste, because getting a picture into a meme should not require
// finding it twice in a file dialog.
const stage = el('stage');
let dragDepth = 0;
stage.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  stage.classList.add('dropping');
});
stage.addEventListener('dragover', (e) => { e.preventDefault(); });
stage.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) stage.classList.remove('dropping');
});
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('dropping');
  for (const f of e.dataTransfer.files) await loadImageFile(f);
});
window.addEventListener('paste', async (e) => {
  const items = e.clipboardData ? e.clipboardData.files : null;
  if (!items || !items.length) return;
  for (const f of items) await loadImageFile(f);
});

// --------------------------------------------------------------- the export
const exportBtn = el('export-btn');
let exportLabelTimer = 0;

exportBtn.addEventListener('click', () => {
  // Painted into a canvas of its own with the overlay off, rather than
  // repainting the visible one and hoping the async toBlob lands before the
  // next frame puts the handles back.
  const off = document.createElement('canvas');
  off.width = W();
  off.height = H();
  paint(off.getContext('2d'), false);
  const name = `meme-${W()}x${H()}.jpg`;
  off.toBlob((blob) => {
    if (!blob) { window.alert('The export failed.'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    exportBtn.textContent = 'Saved';
    clearTimeout(exportLabelTimer);
    exportLabelTimer = setTimeout(() => { exportBtn.textContent = 'Export JPG'; }, 1400);
  }, 'image/jpeg', JPEG_QUALITY);
});

// ------------------------------------------------------------ settings sheet
const formatSelect = el('format-select');
const bgColor = el('bg-color');
const pxVal = el('px-val');
const scrim = el('scrim');
const menuBtn = el('menu-btn');

for (const f of FORMATS) {
  const o = document.createElement('option');
  o.value = f.id;
  o.textContent = f.label;
  formatSelect.appendChild(o);
}

function applyFormat(id) {
  const next = FORMATS.find((f) => f.id === id);
  if (!next || next === state.format) return;
  // Only the height ever changes, so keeping a composition through a format
  // switch is one proportion: everything holds its place down the picture.
  const ky = next.h / state.format.h;
  for (const l of state.layers) l.y *= ky;
  state.format = next;
  canvas.width = next.w;
  canvas.height = next.h;
  formatSelect.value = next.id;
  pxVal.textContent = `${next.w}×${next.h}`;
  draw();
}

formatSelect.addEventListener('change', () => applyFormat(formatSelect.value));
bgColor.addEventListener('input', () => { state.bg = bgColor.value; draw(); });

function openMenu() {
  scrim.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  scrim.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', openMenu);
el('close-btn').addEventListener('click', closeMenu);
el('done-btn').addEventListener('click', closeMenu);
scrim.addEventListener('click', (e) => { if (e.target === scrim) closeMenu(); });

el('reset-btn').addEventListener('click', () => {
  if (!window.confirm('Clear every layer and start over?')) return;
  state.layers = [];
  state.selected = null;
  state.textCount = 0;
  closeMenu();
  syncAll();
});

// ------------------------------------------------------------------ keyboard
const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT');
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!scrim.hidden) closeMenu();
    else selectLayer(null);
    return;
  }
  if (typing()) return;
  const l = selected();
  if ((e.key === 'Backspace' || e.key === 'Delete') && l) {
    e.preventDefault();
    removeLayer(l.id);
    return;
  }
  if (l && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 20 : 2;
    if (e.key === 'ArrowLeft') l.x -= step;
    if (e.key === 'ArrowRight') l.x += step;
    if (e.key === 'ArrowUp') l.y -= step;
    if (e.key === 'ArrowDown') l.y += step;
    draw();
  }
});

// The canvas is scaled by CSS, so a window resize changes how many canvas units
// a screen pixel is worth — and with it the size the handles have to be drawn.
window.addEventListener('resize', draw);

// --------------------------------------------------------------------- start
formatSelect.value = state.format.id;
bgColor.value = state.bg;
pxVal.textContent = `${W()}×${H()}`;
syncAll();

// Anton is a file, and a file takes a moment. Text measured before it arrives is
// measured in the fallback, so the first paint of a meme would be laid out for
// the wrong font. Repaint once it is really here.
if (document.fonts && document.fonts.load) {
  document.fonts.load('400 100px Anton').then(() => draw()).catch(() => {});
}
