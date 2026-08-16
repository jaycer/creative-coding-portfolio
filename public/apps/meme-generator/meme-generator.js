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
// Nothing is uploaded and nothing is kept between visits. An image lives in a
// bitmap in this tab and goes away with it, so the work is only ever as safe as
// the last Save — which writes the whole document, pictures and all, to a file
// on the user's own disk. There is no autosave into storage: a meme editor that
// reopens on yesterday's half-finished meme is a worse app, and a browser quota
// is a bad place to put somebody's photographs.

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

// How a layer meets the ones under it. These are the canvas compositing modes
// under plain names: the id is what goes on the wire and into the save file, the
// op is what the context is set to.
//
// Eight of the twelve the browser has, because the rest are for photographic
// retouching and this is an app for putting words on a picture. Overlay, Soft
// light and Hard light are the contrast family — they push the layer below away
// from mid gray rather than simply darkening or lightening it.
// Vivid light is the punchy one, and the only one here the browser cannot do:
// below mid gray it burns the picture down, above it it dodges it up, and mid
// gray leaves it exactly alone. That is the mode an editor means when it puts a
// button marked "Contrast" on the screen — the standard name for it is Vivid
// light, and it is the strongest member of the contrast family that Overlay and
// the two Lights belong to. Written out per pixel below, since canvas has no
// composite operation for it.
function vividLight(cb, cs) {
  if (cs <= 0.5) {
    const d = 2 * cs;                                   // color burn
    return d <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / d);
  }
  const d = 2 * (cs - 0.5);                             // color dodge
  return d >= 1 ? 1 : Math.min(1, cb / (1 - d));
}

// In the order the darkroom thinks about them, and grouped the way Photoshop
// groups them, because seventeen entries in a flat list is a wall. `group` is
// the heading the menu draws above the run of modes that share it.
const BLENDS = [
  { id: 'normal', label: 'Normal', op: 'source-over' },

  { id: 'darken', label: 'Darken', op: 'darken', group: 'Darker' },
  { id: 'multiply', label: 'Multiply', op: 'multiply', group: 'Darker' },
  { id: 'color-burn', label: 'Color burn', op: 'color-burn', group: 'Darker' },

  { id: 'lighten', label: 'Lighten', op: 'lighten', group: 'Lighter' },
  { id: 'screen', label: 'Screen', op: 'screen', group: 'Lighter' },
  { id: 'color-dodge', label: 'Color dodge', op: 'color-dodge', group: 'Lighter' },

  { id: 'overlay', label: 'Overlay', op: 'overlay', group: 'Contrast' },
  { id: 'soft-light', label: 'Soft light', op: 'soft-light', group: 'Contrast' },
  { id: 'hard-light', label: 'Hard light', op: 'hard-light', group: 'Contrast' },
  { id: 'vivid-light', label: 'Vivid light', op: null, fn: vividLight, group: 'Contrast' },

  { id: 'difference', label: 'Difference', op: 'difference', group: 'Compare' },
  { id: 'exclusion', label: 'Exclusion', op: 'exclusion', group: 'Compare' },

  { id: 'hue', label: 'Hue', op: 'hue', group: 'Color' },
  { id: 'saturation', label: 'Saturation', op: 'saturation', group: 'Color' },
  { id: 'color', label: 'Color', op: 'color', group: 'Color' },
  { id: 'luminosity', label: 'Luminosity', op: 'luminosity', group: 'Color' },
];
const blendById = (id) => BLENDS.find((b) => b.id === id) || BLENDS[0];
const blendOf = (layer) => blendById(layer.blend).op || 'source-over';
/** The ones done by hand rather than by the compositor. */
const manualBlend = (layer) => blendById(layer.blend).fn || null;

// A blend done by hand is a function of two bytes, so it is really a 256×256
// table. Built once on first use; after that a pixel costs a lookup rather than
// two divides and a branch, which is the difference between a slider that moves
// and one that lurches.
const lutCache = new Map();
function blendLut(blend) {
  let lut = lutCache.get(blend.id);
  if (lut) return lut;
  lut = new Uint8Array(256 * 256);
  for (let cs = 0; cs < 256; cs++) {
    for (let cb = 0; cb < 256; cb++) {
      lut[cs * 256 + cb] = Math.round(255 * blend.fn(cb / 255, cs / 255));
    }
  }
  lutCache.set(blend.id, lut);
  return lut;
}

const LINE_H = 1.16;      // multiples of the font size, tight enough for caps
// The same pair of numbers the size slider carries in the markup. Three routes
// set a text size — the slider, the number typed beside it, and a corner
// handle dragged on the canvas — and they have to agree on where the ends are,
// or a size you can drag to is one you cannot type.
const MIN_TEXT = 12;
const MAX_TEXT = 500;
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

// Whether there is work in here that is not in a file yet. Set by every change
// a person makes, cleared by Save, by Load (what is on screen IS the file), and
// by clearing the whole thing out. Only ever consulted alongside the layer
// count: an empty frame nobody has touched is not work to lose.
let dirty = false;
const touch = () => { dirty = true; };

// The one thing standing between an afternoon of work and the back button.
// Images live in this tab and nowhere else, so a reload is not a small mistake.
window.addEventListener('beforeunload', (e) => {
  if (!dirty || !state.layers.length) return;
  e.preventDefault();
  // Old spelling, still what some engines look at. The message itself is the
  // browser's; none of them have shown a page's own words for years.
  e.returnValue = '';
});

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
    if (needsBuffer(layer)) { paintThroughBuffer(c, layer); continue; }
    c.save();
    c.globalAlpha = layer.opacity;
    // How this layer meets what is already down. save/restore puts it back to
    // source-over for the next one, so a blend never leaks past its own layer
    // and the selection handles are never drawn through one.
    c.globalCompositeOperation = blendOf(layer);
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

/**
 * Does this layer have to be composed on its own before it meets the picture?
 *
 * Outlined text is drawn twice, stroke then fill, and both of those are real
 * draws: with a blend mode set, the fill blends against its OWN outline instead
 * of against the picture, and a white glyph on a black outline under Multiply
 * comes out black. Partial opacity has the same flaw for a subtler reason — the
 * outline shows through the middle of every letter.
 *
 * A picture is one drawImage with nothing under it to blend against, so it takes
 * the direct path and costs nothing extra.
 */
function needsBuffer(layer) {
  // A blend done by hand always needs it: the arithmetic reads the layer and
  // the picture as two separate images, so the layer has to exist as one.
  if (manualBlend(layer)) return true;
  if (layer.type !== 'text' || layer.strokeW <= 0) return false;
  return blendOf(layer) !== 'source-over' || layer.opacity < 1;
}

// One buffer, reused. A second full-frame canvas is 5MB at 1080×1350 and there
// is never a need for two at once: a layer is composed, drawn, and done with.
let bufferCanvas = null;
function layerBuffer() {
  if (!bufferCanvas) bufferCanvas = document.createElement('canvas');
  const bc = bufferCanvas.getContext('2d');
  if (bufferCanvas.width !== W() || bufferCanvas.height !== H()) {
    // Sizing a canvas clears it, so this is the clear as well.
    bufferCanvas.width = W();
    bufferCanvas.height = H();
  } else {
    bc.clearRect(0, 0, W(), H());
  }
  return bc;
}

function paintThroughBuffer(c, layer) {
  const bc = layerBuffer();
  bc.save();
  bc.translate(layer.x, layer.y);
  bc.rotate(layer.rot);
  // Composed at full strength and with no blend: what lands in here is the
  // layer as a thing in itself, outline and letters already resolved.
  if (layer.type === 'image') {
    const w = layer.natW * layer.scale;
    const h = layer.natH * layer.scale;
    bc.imageSmoothingEnabled = true;
    bc.imageSmoothingQuality = 'high';
    bc.drawImage(layer.bitmap, -w / 2, -h / 2, w, h);
  } else {
    paintText(bc, layer);
  }
  bc.restore();

  const manual = manualBlend(layer);
  if (manual) { compositeByHand(c, layer); return; }

  c.save();
  c.globalAlpha = layer.opacity;
  c.globalCompositeOperation = blendOf(layer);
  c.drawImage(bc.canvas, 0, 0);
  c.restore();
}

/** The screen-space box a layer covers, rounded out and clipped to the frame. */
function layerBox(layer) {
  const b = bounds(layer);
  const cos = Math.abs(Math.cos(layer.rot));
  const sin = Math.abs(Math.sin(layer.rot));
  const w = b.w * cos + b.h * sin;
  const h = b.w * sin + b.h * cos;
  const x0 = clamp(Math.floor(layer.x - w / 2) - 2, 0, W());
  const y0 = clamp(Math.floor(layer.y - h / 2) - 2, 0, H());
  const x1 = clamp(Math.ceil(layer.x + w / 2) + 2, 0, W());
  const y1 = clamp(Math.ceil(layer.y + h / 2) + 2, 0, H());
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Blend a composed layer onto the picture with arithmetic the compositor does
 * not offer. Only over the layer's own box, so a line of text costs a band of
 * pixels rather than the whole frame.
 *
 * The picture underneath is always opaque — the frame starts life filled with
 * the backdrop color — so this is the simple case of the compositing formula:
 * the result is the blend of the two colors, faded in by the layer's own alpha.
 */
function compositeByHand(c, layer) {
  const blend = blendById(layer.blend);
  const box = layerBox(layer);
  if (box.w <= 0 || box.h <= 0) return;

  const lut = blendLut(blend);
  const under = c.getImageData(box.x, box.y, box.w, box.h);
  const over = bufferCanvas.getContext('2d').getImageData(box.x, box.y, box.w, box.h);
  const u = under.data;
  const o = over.data;
  for (let i = 0; i < u.length; i += 4) {
    const a = (o[i + 3] / 255) * layer.opacity;
    if (a === 0) continue;
    for (let k = 0; k < 3; k++) {
      const cb = u[i + k];
      const mixed = lut[o[i + k] * 256 + cb];
      u[i + k] = cb + (mixed - cb) * a;
    }
  }
  // putImageData ignores globalAlpha and the composite mode, which is right
  // here: both of them have already been paid, above, by hand.
  c.putImageData(under, box.x, box.y);
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
  if (layer.locked) {
    // Selected, and saying so, but with nothing on it to take hold of.
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1.5 * k;
    c.setLineDash([4 * k, 6 * k]);
    c.beginPath();
    hp.corners.forEach((pt, i) => (i ? c.lineTo(pt.x, pt.y) : c.moveTo(pt.x, pt.y)));
    c.closePath();
    c.stroke();
    c.restore();
    return;
  }
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
    blend: 'normal',
    visible: true,
    // A locked layer is ignored by the pointer: it cannot be picked up, sized
    // or spun on the canvas. It still draws, still selects from the list, and
    // its controls in the panel still work — the lock is there to stop the
    // accidents, not to make the layer read-only.
    locked: false,
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
  touch();
  syncAll();
}

function addImage(bitmap, name, blob) {
  const layer = Object.assign(baseLayer('image'), {
    bitmap,
    // The bytes the picture came in as, kept so Save can write the original
    // file back out rather than a re-encode of what was drawn.
    blob,
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
  touch();
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
  touch();
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
  touch();
  syncAll();
}

/** dir is +1 toward the front of the picture, -1 toward the back. */
function moveLayer(id, dir) {
  const i = state.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= state.layers.length) return;
  const [l] = state.layers.splice(i, 1);
  state.layers.splice(j, 0, l);
  touch();
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
  // Whatever is selected answers first, however much is stacked on top of it.
  // Otherwise one full-bleed photo at the front of a pile swallows every click
  // in the frame and the layers underneath cannot be moved at all. The handles
  // have always worked this way — they are tested against the selected layer
  // and nothing else — and this is the same rule for the layer's own body.
  const sel = selected();
  if (sel && sel.visible && !sel.locked && hitLayer(sel, p)) return sel;
  // Failing that, front to back: the thing you can see is the thing you grab.
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (l.visible && !l.locked && hitLayer(l, p)) return l;
  }
  return null;
}

function pickHandle(p) {
  const sel = selected();
  if (!sel || !sel.visible || sel.locked) return null;
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
  touch();
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
  touch();
  syncTransformControls();
  draw();
}

// ---------------------------------------------------------------- layer list
const layerList = document.getElementById('layer-list');
const layersEmpty = document.getElementById('layers-empty');

// Drawn, not typed: the padlock characters are emoji on most platforms and
// would arrive in full color in a row of monochrome glyphs. Shackle closed on
// the body when locked, lifted off it when not.
const LOCK_CLOSED =
  '<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">' +
    '<path d="M4.6 6.6V4.7a2.4 2.4 0 0 1 4.8 0v1.9" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<rect x="2.9" y="6.4" width="8.2" height="5.8" rx="1.3" fill="currentColor"/>' +
  '</svg>';
const LOCK_OPEN =
  '<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">' +
    '<path d="M4.6 6.6V4.7a2.4 2.4 0 0 1 4.8 0" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<rect x="2.9" y="6.4" width="8.2" height="5.8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '</svg>';

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
    const lock = btn('', l.locked ? 'Unlock' : 'Lock so the pointer ignores it', 'lock');
    lock.innerHTML = l.locked ? LOCK_CLOSED : LOCK_OPEN;
    if (l.locked) lock.classList.add('on');
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
  else if (act === 'lock') {
    const l = byId(id);
    if (l) l.locked = !l.locked;
    touch();
    syncAll();
  }
  else if (act === 'vis') {
    const l = byId(id);
    if (l) l.visible = !l.visible;
    touch();
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
const blendSelect = el('blend-select');
const opacityRange = el('opacity-range');

let blendGroup = null;
for (const b of BLENDS) {
  const o = document.createElement('option');
  o.value = b.id;
  o.textContent = b.label;
  if (b.group) {
    // A new heading each time the run changes; the ungrouped first entry
    // (Normal) hangs above all of them, which is where it belongs.
    if (!blendGroup || blendGroup.label !== b.group) {
      blendGroup = document.createElement('optgroup');
      blendGroup.label = b.group;
      blendSelect.appendChild(blendGroup);
    }
    blendGroup.appendChild(o);
  } else {
    blendSelect.appendChild(o);
  }
}

for (const f of FONTS) {
  const o = document.createElement('option');
  o.value = f.id;
  o.textContent = f.label;
  o.style.fontFamily = f.stack;
  fontSelect.appendChild(o);
}

// ------------------------------------------------------- the numbers, typed
// Every readout beside a slider is the slider's own value, which is what makes
// them editable for almost nothing: a typed number is written into the range
// and dispatched as an `input` event, so it arrives at the very same handler a
// drag arrives at. One path, one place that can be wrong.

/** Put a number in a readout — unless that is the one being typed into, where
 *  rewriting it under the caret would eat the next keystroke. */
function showNum(id, value) {
  const node = el(id);
  if (node === document.activeElement) return;
  node.value = String(value);
  node.setAttribute('aria-invalid', 'false');
}

function bindNumberField(id, range) {
  const field = el(id);
  const lo = Number(range.min);
  const hi = Number(range.max);

  const commit = (raw) => {
    const v = parseFloat(raw);
    if (!isFinite(v)) return false;
    // Clamped rather than refused, and the field is left saying what was typed
    // while it has the caret: half of "-120" is "-1", and a field that argues
    // with you halfway through a number is unusable.
    range.value = String(clamp(v, lo, hi));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    field.setAttribute('aria-invalid', String(v < lo || v > hi));
    return true;
  };

  field.addEventListener('input', () => { commit(field.value); });
  // Leaving it settles it: whatever is in there becomes the number the slider
  // actually holds, or goes back to it if it never became a number at all.
  const settle = () => {
    field.setAttribute('aria-invalid', 'false');
    field.value = range.value;
  };
  field.addEventListener('change', settle);
  field.addEventListener('blur', settle);
  field.addEventListener('focus', () => field.select());
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { settle(); field.blur(); return; }
    if (e.key === 'Escape') { settle(); field.blur(); return; }
    // Up and down step the value here rather than walking the blend modes: in a
    // number field that is what those keys have always meant.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      commit(String(clamp(Number(range.value) + step, lo, hi)));
      field.value = range.value;
    }
  });
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
  showNum('rot-val', rotRange.value);
  if (l.type === 'text') {
    sizeRange.value = String(l.size);
    showNum('size-val', l.size);
  } else {
    scaleRange.value = String(Math.round(l.scale * 100));
    showNum('scale-val', Math.round(l.scale * 100));
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
    showNum('wrap-val', Math.round(l.wrap * 100));
    fillColor.value = l.color;
    strokeColor.value = l.stroke;
    strokeRange.value = String(Math.round(l.strokeW * 100));
    for (const b of alignSeg.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.align === l.align));
    }
    capsOn.setAttribute('aria-pressed', String(l.caps));
    capsOff.setAttribute('aria-pressed', String(!l.caps));
  }
  blendSelect.value = blendById(l.blend).id;
  opacityRange.value = String(Math.round(l.opacity * 100));
  showNum('opacity-val', Math.round(l.opacity * 100));
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
    touch();
    if (relist) syncLayerList();
    draw();
  });
}

onControl(textInput, 'input', (l) => { l.text = textInput.value; }, { relist: true });
onControl(fontSelect, 'change', (l) => { l.font = fontSelect.value; });
onControl(sizeRange, 'input', (l) => {
  l.size = Number(sizeRange.value);
  showNum('size-val', sizeRange.value);
});
onControl(wrapRange, 'input', (l) => {
  l.wrap = Number(wrapRange.value) / 100;
  showNum('wrap-val', wrapRange.value);
});
onControl(strokeRange, 'input', (l) => { l.strokeW = Number(strokeRange.value) / 100; });
onControl(fillColor, 'input', (l) => { l.color = fillColor.value; });
onControl(strokeColor, 'input', (l) => { l.stroke = strokeColor.value; });
onControl(scaleRange, 'input', (l) => {
  l.scale = Number(scaleRange.value) / 100;
  showNum('scale-val', scaleRange.value);
});
onControl(rotRange, 'input', (l) => {
  l.rot = (Number(rotRange.value) * Math.PI) / 180;
  showNum('rot-val', rotRange.value);
});
onControl(blendSelect, 'change', (l) => { l.blend = blendById(blendSelect.value).id; });
onControl(opacityRange, 'input', (l) => {
  l.opacity = Number(opacityRange.value) / 100;
  showNum('opacity-val', opacityRange.value);
});

// Each readout, wired to the slider standing next to it.
bindNumberField('size-val', sizeRange);
bindNumberField('wrap-val', wrapRange);
bindNumberField('scale-val', scaleRange);
bindNumberField('rot-val', rotRange);
bindNumberField('opacity-val', opacityRange);

alignSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  const l = selected();
  if (!b || !l) return;
  l.align = b.dataset.align;
  touch();
  syncInspector();
  draw();
});
capsOn.addEventListener('click', () => { const l = selected(); if (l) { l.caps = true; touch(); syncInspector(); draw(); } });
capsOff.addEventListener('click', () => { const l = selected(); if (l) { l.caps = false; touch(); syncInspector(); draw(); } });

for (const b of document.querySelectorAll('.fit-btn')) {
  b.addEventListener('click', () => {
    const l = selected();
    if (!l || l.type !== 'image') return;
    fitLayer(l, b.dataset.fit);
    touch();
    syncInspector();
    draw();
  });
}

el('straighten-btn').addEventListener('click', () => {
  const l = selected();
  if (!l) return;
  l.rot = 0;
  touch();
  syncInspector();
  draw();
});
el('center-btn').addEventListener('click', () => {
  const l = selected();
  if (!l) return;
  l.x = W() / 2;
  l.y = H() / 2;
  touch();
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
    addImage(bitmap, file.name.replace(/\.[^.]+$/, '').slice(0, 28) || 'Image', file);
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
  // Stamped with the moment rather than the size: a folder full of exports
  // wants to sort by when you made them, and every export at a given format
  // has the same dimensions anyway. Same stamp the save files carry, so a JPG
  // and the document it came from sit next to each other.
  const name = `meme-${stamp()}.jpg`;
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

// ------------------------------------------------------------ save and load
// The whole document, pictures and all, as one JSON file. A meme is usually
// built on a photo somebody will not find again, so a save holding only
// positions would be a save of nothing: the images ride along as data URLs,
// which is why these files are megabytes where a settings file is bytes. Each
// picture is stored once however many layers use it.
//
// Two different versions are stamped on every save. `version` is the shape of
// the file, which is what this loader reads; `build` is the codebase that wrote
// it, published by vite.config at /version.json. If the shape ever has to
// change in a way this loader cannot read, `build` is what says which version
// of the app to hand an old file back to.
const FILE_VERSION = 1;
let build = 'unknown';
fetch('../../version.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((v) => { if (v && v.version) build = String(v.version); })
  .catch(() => { /* opened from a file:// copy, or offline. Stays 'unknown'. */ });

const toastEl = el('toast');
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function stamp() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

// Nine decimals: a saved file reads as "540" and "-12" where the numbers are
// round, and loading one puts the identical picture back — measured, pixel for
// pixel across the whole frame, not eyeballed. Coarser would probably also
// survive that (four-decimal radians did), but the digits cost nothing next to
// the base64 photograph two lines down.
const round = (v, n) => Number(Number(v).toFixed(n));
const toDeg = (rad) => round((rad * 180) / Math.PI, 9);

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('could not read the picture back'));
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(url) {
  const comma = String(url).indexOf(',');
  if (comma < 0) throw new Error('not a data URL');
  const head = url.slice(0, comma);
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const mime = (head.match(/^data:([^;,]+)/) || [, 'image/jpeg'])[1];
  return new Blob([bytes], { type: mime });
}

async function saveProject() {
  const assets = {};
  // Keyed by the blob itself, so a duplicated picture is written once and both
  // layers point at it — otherwise Duplicate would double the size of the file.
  const ids = new Map();
  const layers = [];
  for (const l of state.layers) {
    const common = {
      type: l.type,
      x: round(l.x, 9), y: round(l.y, 9),
      // Degrees on disk, radians in here: the file is something a person may
      // open, and "-12" says what "-0.20943951" does.
      rot: toDeg(l.rot),
      opacity: round(l.opacity, 3),
      blend: l.blend,
      visible: l.visible,
      locked: l.locked,
    };
    if (l.type === 'image') {
      let id = ids.get(l.blob);
      if (!id) {
        id = 'a' + (ids.size + 1);
        ids.set(l.blob, id);
        assets[id] = { name: l.name, src: await blobToDataUrl(l.blob) };
      }
      layers.push({ ...common, asset: id, scale: round(l.scale, 9) });
    } else {
      layers.push({
        ...common,
        text: l.text, font: l.font, size: l.size,
        color: l.color, stroke: l.stroke, strokeW: round(l.strokeW, 3),
        align: l.align, caps: l.caps, wrap: round(l.wrap, 3),
      });
    }
  }

  const doc = {
    app: 'meme-generator',
    version: FILE_VERSION,
    build,
    savedAt: new Date().toISOString(),
    format: state.format.id,
    bg: state.bg,
    assets,
    layers,
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `meme-${stamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
  dirty = false;
  const mb = blob.size / (1024 * 1024);
  toast(`Saved, ${mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(blob.size / 1024)) + ' KB'}`);
}

const numOr = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
const hexOr = (v, def) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : def);

/**
 * Put a saved document back up. Everything coming off disk is a stranger, so
 * each field is coerced and clamped on the way in rather than trusted: a file
 * hand-edited into nonsense should open as something odd-looking, not break the
 * app. Nothing on screen is touched until the whole file has been read and
 * every picture in it decoded.
 */
async function loadProject(file) {
  const doc = JSON.parse(await file.text());
  if (!doc || doc.app !== 'meme-generator' || !Array.isArray(doc.layers)) throw new Error('shape');
  if (numOr(doc.version, 1) > FILE_VERSION) throw new Error('newer');

  const assets = {};
  for (const [id, a] of Object.entries(doc.assets || {})) {
    if (!a || typeof a.src !== 'string') continue;
    const blob = dataUrlToBlob(a.src);
    assets[id] = {
      blob,
      bitmap: await decode(blob),
      name: typeof a.name === 'string' && a.name ? a.name : 'Image',
    };
  }

  state.layers = [];
  state.selected = null;
  state.nextId = 1;
  // Set before any layer lands: applyFormat rescales the y of everything in the
  // stack, and the coordinates in the file are already in the saved format.
  const fmt = FORMATS.find((f) => f.id === doc.format) ? doc.format : FORMATS[0].id;
  applyFormat(fmt);
  formatSelect.value = state.format.id;
  state.bg = hexOr(doc.bg, '#000000');
  bgColor.value = state.bg;

  let texts = 0;
  for (const raw of doc.layers) {
    if (!raw || typeof raw !== 'object') continue;
    const l = baseLayer(raw.type === 'image' ? 'image' : 'text');
    l.x = numOr(raw.x, W() / 2);
    l.y = numOr(raw.y, H() / 2);
    l.rot = (numOr(raw.rot, 0) * Math.PI) / 180;
    l.opacity = clamp(numOr(raw.opacity, 1), 0, 1);
    l.blend = blendById(raw.blend).id;
    l.visible = raw.visible !== false;
    l.locked = raw.locked === true;
    if (l.type === 'image') {
      const a = assets[raw.asset];
      if (!a) continue;   // a picture that did not survive; its layer goes too
      l.bitmap = a.bitmap;
      l.blob = a.blob;
      l.name = a.name;
      l.natW = a.bitmap.width;
      l.natH = a.bitmap.height;
      l.scale = clamp(numOr(raw.scale, 1), MIN_SCALE, MAX_SCALE);
    } else {
      l.text = typeof raw.text === 'string' ? raw.text : '';
      l.font = fontById(raw.font).id;
      l.size = clamp(Math.round(numOr(raw.size, 96)), MIN_TEXT, MAX_TEXT);
      l.color = hexOr(raw.color, '#ffffff');
      l.stroke = hexOr(raw.stroke, '#000000');
      l.strokeW = clamp(numOr(raw.strokeW, 0.08), 0, 0.2);
      l.align = raw.align === 'left' || raw.align === 'right' ? raw.align : 'center';
      l.caps = raw.caps !== false;
      l.wrap = clamp(numOr(raw.wrap, 0.9), 0.2, 1);
      texts++;
    }
    state.layers.push(l);
  }
  state.textCount = texts;
  // What is on screen is exactly the file that was just opened.
  dirty = false;
  syncAll();
  return doc;
}

el('save-btn').addEventListener('click', () => {
  saveProject().catch((err) => {
    console.error('[meme] save failed', err);
    toast('That could not be saved');
  });
});

// Kept out of the markup so nothing in the panel can tab into it, and given an
// id anyway so a headless harness can hand it a file.
const projectFile = document.createElement('input');
projectFile.type = 'file';
projectFile.id = 'project-file';
projectFile.accept = 'application/json,.json';
projectFile.hidden = true;
document.body.appendChild(projectFile);

el('load-btn').addEventListener('click', () => projectFile.click());
projectFile.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  // Cleared straight away, or picking the same file twice fires no change event
  // and the second load silently does nothing.
  e.target.value = '';
  if (!file) return;
  if (state.layers.length && !window.confirm('Load this file over what is on screen?')) return;
  try {
    const doc = await loadProject(file);
    const n = state.layers.length;
    toast(`Loaded ${n} layer${n === 1 ? '' : 's'}`);
    if (doc.build && doc.build !== build) console.info(`[meme] file was saved by build ${doc.build}, this is ${build}`);
  } catch (err) {
    console.error('[meme] load failed', err);
    toast(err && err.message === 'newer' ? 'That file is from a newer Meme Generator' : 'Not a Meme Generator file');
  }
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
  pxVal.textContent = `${next.w} × ${next.h} pixels`;
  draw();
}

formatSelect.addEventListener('change', () => { applyFormat(formatSelect.value); touch(); });
bgColor.addEventListener('input', () => { state.bg = bgColor.value; touch(); draw(); });

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
  dirty = false;
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
  if (!l || !e.key.startsWith('Arrow')) return;
  e.preventDefault();

  // Held down, the arrows place the layer. Bare, they walk the blend modes:
  // seventeen of them is more than anybody will find by opening a menu
  // seventeen times, and the point of a blend is what it does to THIS picture,
  // which you can only see by watching the picture while you step through them.
  if (e.shiftKey) {
    const step = 2;
    if (e.key === 'ArrowLeft') l.x -= step;
    if (e.key === 'ArrowRight') l.x += step;
    if (e.key === 'ArrowUp') l.y -= step;
    if (e.key === 'ArrowDown') l.y += step;
    touch();
    draw();
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') cycleBlend(l, e.key === 'ArrowDown' ? 1 : -1);
});

/** Step to the next blend mode, wrapping at both ends. */
function cycleBlend(layer, dir) {
  const i = BLENDS.indexOf(blendById(layer.blend));
  const next = BLENDS[(i + dir + BLENDS.length) % BLENDS.length];
  layer.blend = next.id;
  touch();
  syncInspector();
  draw();
  // Named out loud, because the whole reason to do this from the keyboard is
  // that you are looking at the picture rather than at the panel.
  toast(next.label);
}

// The canvas is scaled by CSS, so a window resize changes how many canvas units
// a screen pixel is worth — and with it the size the handles have to be drawn.
window.addEventListener('resize', draw);

// --------------------------------------------------------------------- start
formatSelect.value = state.format.id;
bgColor.value = state.bg;
pxVal.textContent = `${W()} × ${H()} pixels`;
syncAll();

// Anton is a file, and a file takes a moment. Text measured before it arrives is
// measured in the fallback, so the first paint of a meme would be laid out for
// the wrong font. Repaint once it is really here.
if (document.fonts && document.fonts.load) {
  document.fonts.load('400 100px Anton').then(() => draw()).catch(() => {});
}
