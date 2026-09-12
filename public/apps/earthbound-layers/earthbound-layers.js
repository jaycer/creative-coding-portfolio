// Earthbound Layers — the battle backgrounds of a 1994 RPG, as one fragment shader.
//
// The original ran on a SNES and cost it almost nothing, and understanding why
// is the whole design of this file. A background is TWO layers. Each layer is a
// 256x256 indexed bitmap that never changes and never moves. What moves is only:
//
//   THE DISTORTION   the background's horizontal scroll register, rewritten by
//                    HDMA once per scanline, so each of the 224 lines samples the
//                    bitmap at its own offset. Four kinds: horizontal smooth,
//                    horizontal interlaced (every other line thrown the other
//                    way, which is the helix), vertical smooth with a linear
//                    compression term that squishes or stretches the picture, and
//                    a skew that grows as it goes down the screen.
//
//   THE PALETTE      rotated a step at a time underneath the unchanging pixels.
//                    Almost all of the color you see moving is this and not the
//                    bitmap.
//
// The two layers are then added by the SNES color math, and the result is 256 by
// 224 pixels, which is the canvas here and is never anything else — the browser
// does the nearest-neighbor upscale. That grid is half of why this reads as the
// machine it came from; drawn smoothly at native resolution it is just a shader.
//
// Per-scanline offset is a y-dependent texture lookup, so the part that was hard
// enough in 1994 to need a DMA trick is the part that is free now. All of it is
// one pass over 57,344 pixels.
//
// Nothing here is Nintendo's. The patterns and palettes are written for this
// page — see patterns.js. The game's own layers are ROM data and are not shipped.
// The engine is separated from where the bitmaps come from on purpose, so a
// reader with their own copy could feed it from one later.

import { PATTERNS, SIZE } from './patterns.js';

// The authentic frame. In Fit these are the render area exactly; in Fill they
// are its floor, and whichever axis had the bars grows past them.
const BASE_W = 256, BASE_H = 224;
// A guard for an absurd window. 1024 scanlines of an ultrawide is still a
// trivial amount of shading, and the cap only exists so a bug cannot ask for a
// buffer the driver refuses.
const MAX_SIDE = 1024;
let W = BASE_W, H = BASE_H;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ palettes
// Each is a handful of key colors expanded into a 16 entry ramp. Sixteen because
// that is what a 4bpp layer had, and the ramp is what the cycling rotates
// through. They are deliberately lurid and deliberately mid-bright: two of them
// are about to be added together, and palettes mixed at full value give white.
const PALETTES = [
  { name: 'Magenta', keys: ['#180022', '#7a1e6e', '#e0479b', '#ffd2e8'] },
  { name: 'Acid', keys: ['#04210a', '#1f7a2e', '#87e02a', '#f2ffb8'] },
  { name: 'Sunset', keys: ['#1a0430', '#8a2244', '#e86a24', '#ffd98a'] },
  { name: 'Ice', keys: ['#02121f', '#12518f', '#3fb6e0', '#ddf7ff'] },
  { name: 'Ember', keys: ['#1c0500', '#8c1c08', '#e8661a', '#ffe0a0'] },
  { name: 'Violet', keys: ['#0c0020', '#3d1d8f', '#8a5ce0', '#e2d6ff'] },
  { name: 'Toxic', keys: ['#160026', '#5d0f6b', '#2fbf8f', '#d8ffd0'] },
  { name: 'Rust', keys: ['#140a04', '#6b3a12', '#c98a2e', '#ffeccb'] },
  { name: 'Deep', keys: ['#00101a', '#063a52', '#0f8f8a', '#a8f0d8'] },
  { name: 'Bubblegum', keys: ['#2a0a24', '#a03a7a', '#ff8ac4', '#fff0f8'] },
  { name: 'Mud', keys: ['#0f0f08', '#45412a', '#8f8a52', '#e4dfb8'] },
  { name: 'Neon', keys: ['#0a0014', '#c2129b', '#f5d90a', '#e8ffff'] },
  // The dark half of the set, and the half that was missing. Most of the
  // originals are not a field of color at all — they are black with one or two
  // saturated things moving on it, and a ramp that walks evenly from dark to
  // light can never make that picture. These spend their first half in the black
  // and do all their traveling in the second, so a pattern laid on one reads as
  // a bright figure on a ground rather than as a gradient. Rotating the ramp then
  // sweeps the bright band through the shape, which is the flashing everyone
  // remembers.
  { name: 'Void', keys: ['#000000', '#010008', '#7a0f8c', '#ff6ae0'] },
  { name: 'Coal', keys: ['#000000', '#0a0400', '#b03a06', '#ffb35c'] },
  { name: 'Abyss', keys: ['#000000', '#000a12', '#0a5f8c', '#7fe8ff'] },
  { name: 'Blood', keys: ['#000000', '#14000a', '#a3102a', '#ff7a5c'] },
];

const hexToRgb = (h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
];

/** A ramp of 16 colors, walked evenly through the key colors. */
function rampOf(keys) {
  const cols = keys.map(hexToRgb);
  const out = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const t = (i / 15) * (cols.length - 1);
    const a = Math.min(cols.length - 1, Math.floor(t));
    const b = Math.min(cols.length - 1, a + 1);
    const f = t - a;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(cols[a][c] * (1 - f) + cols[b][c] * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ------------------------------------------------------------------- the view
const canvas = document.createElement('canvas');
canvas.width = BASE_W;
canvas.height = BASE_H;
document.body.appendChild(canvas);

const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
if (!gl) {
  document.body.innerHTML = '<p style="color:#fff;font:16px system-ui;padding:24px">This needs WebGL.</p>';
  throw new Error('no webgl');
}

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// One function, called twice. Deliberately NOT a loop over uniform arrays: a
// WebGL1 fragment shader cannot subscript a uniform array with a variable, and
// working around that costs more than writing the call out twice.
const FRAG = `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform float uBlend;      // 0 add, 1 screen, 2 difference
uniform vec2 uRes;         // the render area in SNES pixels

uniform sampler2D uPatA, uPalA;
uniform vec4 uDistA;       // amplitude px, waves per 256, speed, compression
uniform float uTypeA, uLevelsA, uCycA, uScrollA, uLevelA;

uniform sampler2D uPatB, uPalB;
uniform vec4 uDistB;
uniform float uTypeB, uLevelsB, uCycB, uScrollB, uLevelB;

/**
 * Where this scanline samples the bitmap. Everything here is in PIXELS.
 *
 * Pixels rather than 0..1 because every number the original quotes is per
 * scanline and per 256 pixels, and because the render area is no longer always
 * 256 by 224 — filling the window widens it. Work in fractions of the screen and
 * every setting would quietly change meaning when the window did: the same
 * amplitude would throw a wave twice as far on an ultrawide monitor.
 */
vec2 distort(vec2 p, float type, vec4 d, float t) {
  float y = p.y;
  // The 256 in the phase is the unit frequency is quoted in — waves per 256
  // pixels — and is NOT the width of the screen. It stays constant however wide
  // the render area gets, which is what keeps the Frequency slider honest.
  float phase = d.y * (y / 256.0) * 6.2831853 + t * d.z;
  float off = d.x * sin(phase);

  if (type < 0.5) {
    return p;
  } else if (type < 1.5) {
    p.x += off;
  } else if (type < 2.5) {
    // Every second line thrown the other way. This is the one that does not look
    // like a wave at all: the lines shear against each other and the picture
    // reads as a twisted ribbon.
    float odd = mod(floor(y), 2.0);
    p.x += mix(off, -off, odd);
  } else if (type < 3.5) {
    // Vertical, plus the linear term. Sinusoidal alone ripples; the linear part
    // is what squeezes the whole picture toward the middle or pulls it apart,
    // so it is measured from the middle of the screen and not from the top.
    p.y += off + d.w * (y - uRes.y * 0.5) * 0.05;
  } else {
    // Skew: the further down the screen, the further displaced.
    p.x += off * (y / uRes.y) + d.w * y * 0.05;
  }
  return p;
}

vec3 layer(sampler2D pat, sampler2D pal, float levels, float type,
           vec4 d, float scroll, float cyc, float t) {
  // Distortion first, and read off the SCREEN scanline — HDMA rewrote the
  // scroll register once per line of the display, so the wave is a function of
  // where you are on the television and not of where the bitmap has scrolled to.
  // Scrolling before this makes the pattern drag its own ripple along with it.
  vec2 p = distort(vUv * uRes, type, d, t);
  p.y += scroll;
  // Into the tile's own coordinates. The tile is 256 square whatever the screen
  // is, so a wider render area simply reaches further across it and shows more
  // copies — which is the whole of how filling the window works here. Nothing is
  // stretched and nothing is cropped; there is just more picture.
  vec2 texUv = p / 256.0;

  float idx = texture2D(pat, texUv).r * 255.0;
  // Spread the levels around the palette RING, not across the ramp end to end.
  //
  // The obvious mapping is idx/(levels-1) * 15, which uses the whole ramp — and
  // it is wrong the moment the palette rotates, because 0 and 15 are ONE step
  // apart on a 16-entry loop, not fifteen. A two-level pattern mapped that way
  // has its two colors collapse into neighbors as soon as cycling starts, and
  // the contrast quietly dies: a black-and-pink pinwheel measured 180 mean luma
  // with no black in it at all. Dividing by levels instead puts them at 0 and 8,
  // half a turn apart, and they stay that far apart at every offset.
  float pos = idx / levels * 16.0;
  float c = mod(pos + cyc, 16.0);
  return texture2D(pal, vec2((c + 0.5) / 16.0, 0.5)).rgb;
}

void main() {
  vec3 a = layer(uPatA, uPalA, uLevelsA, uTypeA, uDistA, uScrollA, uCycA, uTime) * uLevelA;
  vec3 b = layer(uPatB, uPalB, uLevelsB, uTypeB, uDistB, uScrollB, uCycB, uTime) * uLevelB;

  vec3 col;
  if (uBlend < 0.5) col = a + b;
  else if (uBlend < 1.5) col = 1.0 - (1.0 - a) * (1.0 - b);
  else col = abs(a - b);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || 'shader failed');
  }
  return s;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(program) || 'link failed');
}
gl.useProgram(program);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(program, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const U = {};
for (const name of [
  'uTime', 'uBlend', 'uRes',
  'uPatA', 'uPalA', 'uDistA', 'uTypeA', 'uLevelsA', 'uCycA', 'uScrollA', 'uLevelA',
  'uPatB', 'uPalB', 'uDistB', 'uTypeB', 'uLevelsB', 'uCycB', 'uScrollB', 'uLevelB',
]) {
  U[name] = gl.getUniformLocation(program, name);
}

// -------------------------------------------------------------- the textures
// NEAREST everywhere and nothing else will do. A linear filter on the index map
// interpolates between palette INDICES, which are not a quantity — halfway
// between color 3 and color 11 is color 7, an unrelated color, and the layer
// comes out fringed with things that are in no palette entry at all.
function patternTexture(data) {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < data.length; i++) rgba[i * 4] = data[i];
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  // REPEAT, which a 256 square texture is allowed: a distortion pushes the
  // sample far outside the tile and it has to come back round.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return tex;
}

function paletteTexture(ramp) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, ramp);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// Built on demand rather than all at once: sixteen 256-square index maps is a
// megabyte of work at load for the two a visitor is actually looking at.
const patCache = new Map();
function pattern(i) {
  if (!patCache.has(i)) {
    const built = PATTERNS[i].make();
    patCache.set(i, { tex: patternTexture(built.data), levels: built.levels });
  }
  return patCache.get(i);
}

const palCache = new Map();
function palette(i) {
  if (!palCache.has(i)) palCache.set(i, paletteTexture(rampOf(PALETTES[i].keys)));
  return palCache.get(i);
}

// ------------------------------------------------------------------- the state
const DISTORTIONS = ['None', 'Horizontal', 'Interlaced', 'Vertical', 'Skew'];

const layerDefaults = () => ({
  pattern: 0, palette: 0, level: 60,
  type: 1, amp: 12, freq: 4, speed: 40, compress: 0,
  cycle: 20, scroll: 0,
});

const cfg = {
  blend: 'add',
  rate: 1,
  fill: false,
  auto: true,        // deal a fresh pair on a timer, the way the original kept
  autoSecs: 180,     // handing you a different one every battle

  layers: [layerDefaults(), layerDefaults()],
};

// Palette rotation and vertical scroll are ACCUMULATED rather than worked out
// from elapsed time. `t * rate` is shorter and wrong the moment there is a rate
// slider: halve the speed a minute in and every layer jumps to a new place in
// its cycle. Adding up the steps means a change bends what is on screen from
// wherever it had got to.
let clock = 0;
const cyc = [0, 0];
const scroll = [0, 0];
// Wall-clock seconds since the field was last dealt. Deliberately NOT scaled by
// the Speed slider: "every three minutes" is a promise about the clock on the
// wall, not about how fast the picture happens to be moving.
let sinceDeal = 0;

// ----------------------------------------------------------------- the presets
// Named for what they look like. Two layers each, because that is what the
// original allowed, and the pairing is most of the character: one slow wide
// thing under one fast narrow thing is the whole recipe.
const P = (name) => PATTERNS.findIndex((p) => p.name === name);
const C = (name) => PALETTES.findIndex((p) => p.name === name);

const PRESETS = [
  {
    name: 'Helix',
    blend: 'add',
    layers: [
      { pattern: P('Checkerboard'), palette: C('Magenta'), level: 60, type: 2, amp: 18, freq: 6, speed: 55, cycle: 24, scroll: -6 },
      { pattern: P('Stripes'), palette: C('Ice'), level: 45, type: 1, amp: 9, freq: 3, speed: 30, cycle: -14, scroll: 3 },
    ],
  },
  {
    name: 'Undertow',
    blend: 'add',
    layers: [
      { pattern: P('Rings'), palette: C('Deep'), level: 65, type: 3, amp: 14, freq: 2.5, speed: 22, compress: 18, cycle: 12, scroll: 4 },
      { pattern: P('Bubbles'), palette: C('Toxic'), level: 45, type: 1, amp: 7, freq: 5, speed: 40, cycle: -9, scroll: -2 },
    ],
  },
  {
    name: 'Migraine',
    blend: 'add',
    layers: [
      { pattern: P('Spiral'), palette: C('Neon'), level: 55, type: 2, amp: 26, freq: 9, speed: 90, cycle: 46, scroll: 0 },
      { pattern: P('Diagonals'), palette: C('Violet'), level: 50, type: 1, amp: 14, freq: 7, speed: 70, cycle: -30, scroll: -9 },
    ],
  },
  {
    name: 'Kiln',
    blend: 'add',
    layers: [
      { pattern: P('Honeycomb'), palette: C('Ember'), level: 65, type: 1, amp: 11, freq: 4, speed: 35, cycle: 18, scroll: -5 },
      { pattern: P('Static'), palette: C('Rust'), level: 28, type: 4, amp: 6, freq: 2, speed: 18, compress: 8, cycle: 8, scroll: 0 },
    ],
  },
  {
    name: 'Tidepool',
    blend: 'screen',
    layers: [
      { pattern: P('Bubbles'), palette: C('Deep'), level: 55, type: 3, amp: 17, freq: 3, speed: 18, compress: -12, cycle: 10, scroll: 2 },
      { pattern: P('Lattice'), palette: C('Acid'), level: 35, type: 1, amp: 5, freq: 6, speed: 26, cycle: -16, scroll: -3 },
    ],
  },
  {
    name: 'Carnival',
    blend: 'add',
    layers: [
      { pattern: P('Diamonds'), palette: C('Bubblegum'), level: 60, type: 1, amp: 16, freq: 5, speed: 48, cycle: 28, scroll: -7 },
      { pattern: P('Sunburst'), palette: C('Sunset'), level: 45, type: 2, amp: 10, freq: 8, speed: 62, cycle: -20, scroll: 0 },
    ],
  },
  {
    name: 'Cathode',
    blend: 'add',
    layers: [
      { pattern: P('Bars'), palette: C('Ice'), level: 55, type: 3, amp: 22, freq: 1.5, speed: 14, compress: 26, cycle: 14, scroll: 11 },
      { pattern: P('Static'), palette: C('Mud'), level: 30, type: 1, amp: 3, freq: 12, speed: 120, cycle: 0, scroll: -22 },
    ],
  },
  {
    name: 'Pollen',
    blend: 'add',
    layers: [
      { pattern: P('Plaid'), palette: C('Acid'), level: 58, type: 1, amp: 8, freq: 2.5, speed: 20, cycle: 16, scroll: -4 },
      { pattern: P('Weave'), palette: C('Rust'), level: 42, type: 4, amp: 9, freq: 3, speed: 26, compress: 12, cycle: -11, scroll: 2 },
    ],
  },
  {
    name: 'Threadbare',
    blend: 'diff',
    layers: [
      { pattern: P('Herringbone'), palette: C('Violet'), level: 75, type: 2, amp: 13, freq: 7, speed: 44, cycle: 22, scroll: -5 },
      { pattern: P('Chevrons'), palette: C('Toxic'), level: 60, type: 1, amp: 10, freq: 4, speed: 33, cycle: -18, scroll: 6 },
    ],
  },
  {
    name: 'Sinkhole',
    blend: 'add',
    layers: [
      { pattern: P('Rings'), palette: C('Magenta'), level: 62, type: 3, amp: 25, freq: 4, speed: 30, compress: -22, cycle: 26, scroll: 0 },
      { pattern: P('Spiral'), palette: C('Deep'), level: 40, type: 0, amp: 0, freq: 0, speed: 0, cycle: -13, scroll: -8 },
    ],
  },
  {
    name: 'Foundry',
    blend: 'add',
    layers: [
      { pattern: P('Lattice'), palette: C('Ember'), level: 58, type: 4, amp: 15, freq: 3, speed: 24, compress: 20, cycle: 12, scroll: -6 },
      { pattern: P('Diagonals'), palette: C('Neon'), level: 38, type: 2, amp: 8, freq: 10, speed: 80, cycle: -34, scroll: 0 },
    ],
  },
  // The five below were tuned against a playlist of the real thing, and they are
  // all darker and harder than the twelve above — which is the correction that
  // watching them actually bought. Nearly every original is black with one thing
  // happening on it.
  {
    name: 'Snake Columns',
    blend: 'add',
    layers: [
      { pattern: P('Stripes'), palette: C('Void'), level: 85, type: 1, amp: 30, freq: 5, speed: 46, cycle: 18, scroll: 0 },
      { pattern: P('Bars'), palette: C('Abyss'), level: 22, type: 1, amp: 8, freq: 2, speed: 20, cycle: -7, scroll: -4 },
    ],
  },
  {
    name: 'Pinwheel',
    blend: 'add',
    layers: [
      { pattern: P('Radial Blocks'), palette: C('Void'), level: 90, type: 1, amp: 13, freq: 3, speed: 30, cycle: 15, scroll: 0 },
      { pattern: P('Static'), palette: C('Blood'), level: 18, type: 2, amp: 5, freq: 8, speed: 70, cycle: 0, scroll: -6 },
    ],
  },
  {
    name: 'Snow',
    blend: 'add',
    layers: [
      { pattern: P('Static'), palette: C('Mud'), level: 80, type: 1, amp: 16, freq: 7, speed: 55, cycle: 4, scroll: -30 },
      { pattern: P('Bars'), palette: C('Abyss'), level: 20, type: 3, amp: 12, freq: 1.5, speed: 10, compress: 14, cycle: -5, scroll: 0 },
    ],
  },
  {
    name: 'Nested',
    blend: 'add',
    layers: [
      { pattern: P('Diamonds'), palette: C('Blood'), level: 88, type: 1, amp: 7, freq: 2, speed: 18, cycle: 20, scroll: 0 },
      { pattern: P('Triangles'), palette: C('Abyss'), level: 26, type: 4, amp: 9, freq: 3, speed: 24, compress: 10, cycle: -12, scroll: 3 },
    ],
  },
  {
    name: 'Circuit',
    blend: 'add',
    layers: [
      { pattern: P('Outlines'), palette: C('Coal'), level: 95, type: 1, amp: 5, freq: 2, speed: 14, cycle: 9, scroll: -3 },
      { pattern: P('Lattice'), palette: C('Void'), level: 20, type: 2, amp: 11, freq: 6, speed: 52, cycle: -16, scroll: 0 },
    ],
  },
  {
    name: 'Quiet',
    blend: 'add',
    layers: [
      { pattern: P('Bubbles'), palette: C('Mud'), level: 60, type: 1, amp: 6, freq: 1.5, speed: 8, cycle: 5, scroll: 2 },
      { pattern: P('Rings'), palette: C('Violet'), level: 30, type: 3, amp: 10, freq: 1, speed: 6, compress: 6, cycle: -4, scroll: -1 },
    ],
  },
];

function applyPreset(p) {
  sinceDeal = 0;
  cfg.blend = p.blend;
  for (let i = 0; i < 2; i++) {
    cfg.layers[i] = { ...layerDefaults(), ...p.layers[i] };
  }
  syncControls();
}

/**
 * A random pair.
 *
 * Not uniformly random over every control: a field where both layers happen to
 * be violent is a mess, and one where both are calm is a wallpaper. So one layer
 * is dealt as the ground and the other as the detail — wider and slower against
 * narrower and faster — which is the shape almost every one of the originals
 * turns out to have.
 */
function shuffle() {
  sinceDeal = 0;
  // The preset picker no longer names what is on screen, so it stops claiming to.
  if (typeof presetEl !== 'undefined' && presetEl) presetEl.value = '';
  const r = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => Math.floor(Math.random() * arr.length);
  const ground = {
    pattern: pick(PATTERNS), palette: pick(PALETTES),
    level: Math.round(r(50, 70)),
    type: 1 + pick([0, 1, 2, 3]),
    amp: Math.round(r(8, 26)), freq: Math.round(r(1, 5) * 2) / 2,
    speed: Math.round(r(12, 45)), compress: Math.round(r(-24, 24)),
    cycle: Math.round(r(6, 30)) * (Math.random() < 0.5 ? -1 : 1),
    scroll: Math.round(r(-8, 8)),
  };
  const detail = {
    pattern: pick(PATTERNS), palette: pick(PALETTES),
    level: Math.round(r(28, 50)),
    type: 1 + pick([0, 1, 2, 3]),
    amp: Math.round(r(3, 14)), freq: Math.round(r(4, 12) * 2) / 2,
    speed: Math.round(r(40, 110)), compress: Math.round(r(-14, 14)),
    cycle: Math.round(r(8, 40)) * (Math.random() < 0.5 ? -1 : 1),
    scroll: Math.round(r(-10, 10)),
  };
  cfg.blend = Math.random() < 0.82 ? 'add' : (Math.random() < 0.6 ? 'screen' : 'diff');
  cfg.layers = [ground, detail];
  syncControls();
}

// -------------------------------------------------------------------- the loop
const BLENDS = { add: 0, screen: 1, diff: 2 };
let paused = false;
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = paused ? 0 : Math.min((now - last) / 1000, 0.1);
  last = now;
  clock += dt * cfg.rate;

  // Auto shuffle, held back while the sheet is open. Dealing a new field out
  // from under somebody who is in the middle of tuning one would throw their
  // work away, and everything else in here is written so that a setting adjusts
  // what is on screen rather than replacing it. Closing the sheet starts the
  // interval over rather than firing immediately.
  if (!scrim.hidden) {
    sinceDeal = 0;
  } else if (cfg.auto && !paused) {
    sinceDeal += dt;
    if (sinceDeal >= cfg.autoSecs) shuffle();
  }
  for (let i = 0; i < 2; i++) {
    const L = cfg.layers[i];
    cyc[i] += dt * cfg.rate * (L.cycle / 100) * 8;
    scroll[i] += dt * cfg.rate * L.scroll;
  }

  gl.viewport(0, 0, W, H);
  gl.uniform1f(U.uTime, clock);
  gl.uniform2f(U.uRes, W, H);
  gl.uniform1f(U.uBlend, BLENDS[cfg.blend] ?? 0);

  for (const [i, S] of [[0, 'A'], [1, 'B']]) {
    const L = cfg.layers[i];
    const pat = pattern(L.pattern);
    gl.activeTexture(gl.TEXTURE0 + i * 2);
    gl.bindTexture(gl.TEXTURE_2D, pat.tex);
    gl.uniform1i(U[`uPat${S}`], i * 2);
    gl.activeTexture(gl.TEXTURE0 + i * 2 + 1);
    gl.bindTexture(gl.TEXTURE_2D, palette(L.palette));
    gl.uniform1i(U[`uPal${S}`], i * 2 + 1);

    gl.uniform4f(U[`uDist${S}`], L.amp, L.freq, (L.speed / 100) * TAU, L.compress / 10);
    gl.uniform1f(U[`uType${S}`], L.type);
    gl.uniform1f(U[`uLevels${S}`], pat.levels);
    gl.uniform1f(U[`uCyc${S}`], cyc[i]);
    gl.uniform1f(U[`uScroll${S}`], scroll[i]);
    gl.uniform1f(U[`uLevel${S}`], L.level / 100);
  }

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/**
 * Size the render area, and the element it is shown in.
 *
 * Fit is the authentic frame: 256 by 224, scaled up as far as it goes and
 * letterboxed with whatever is left.
 *
 * Fill removes the bars WITHOUT stretching and WITHOUT cropping, which is worth
 * spelling out because the two obvious answers do one or the other. Stretching
 * makes the pixels oblong and the rings into ovals; cropping throws away picture
 * to no purpose. Instead the pixel keeps exactly the size Fit gave it — the same
 * scale, to the same number — and the render area grows along whichever axis had
 * the bars. The patterns tile forever, so the bars are simply replaced by more of
 * the field. A wider window is a bigger window onto the same picture, which is
 * what the hardware would have done if it had had the scanlines.
 */
function resize() {
  const winW = window.innerWidth, winH = window.innerHeight;
  const scale = Math.min(winW / BASE_W, winH / BASE_H);
  if (cfg.fill) {
    W = Math.min(MAX_SIDE, Math.max(BASE_W, Math.round(winW / scale)));
    H = Math.min(MAX_SIDE, Math.max(BASE_H, Math.round(winH / scale)));
  } else {
    W = BASE_W;
    H = BASE_H;
  }
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  canvas.style.width = `${Math.round(W * scale)}px`;
  canvas.style.height = `${Math.round(H * scale)}px`;
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- the controls
// Built from a spec rather than written out twice in the HTML: the two layers
// have the same nine controls, and a second copy in markup is a second place for
// an id to drift out of step with what the shader reads.
const SPEC = [
  { key: 'pattern', label: 'Pattern', options: () => PATTERNS.map((p) => p.name) },
  { key: 'palette', label: 'Palette', options: () => PALETTES.map((p) => p.name) },
  { key: 'type', label: 'Distort', options: () => DISTORTIONS },
  { key: 'amp', label: 'Amplitude', min: 0, max: 64, step: 1 },
  { key: 'freq', label: 'Frequency', min: 0, max: 24, step: 0.5 },
  { key: 'speed', label: 'Speed', min: 0, max: 200, step: 1 },
  // Only ever shown for the two distortions that read it, because a slider that
  // does nothing is worse than no slider: it teaches that the control is broken.
  { key: 'compress', label: 'Compress', min: -40, max: 40, step: 1, only: [3, 4] },
  { key: 'cycle', label: 'Cycle', min: -60, max: 60, step: 1 },
  { key: 'scroll', label: 'Scroll', min: -40, max: 40, step: 1 },
  { key: 'level', label: 'Level', min: 0, max: 100, step: 1, unit: '%' },
];

const host = document.getElementById('layer-controls');
const bound = [];

for (let i = 0; i < 2; i++) {
  const h3 = document.createElement('h3');
  h3.textContent = `Layer ${i + 1}`;
  host.appendChild(h3);
  const rows = {};
  for (const s of SPEC) {
    const row = document.createElement('div');
    row.className = 'row';
    const id = `l${i}-${s.key}`;
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = s.label;
    row.appendChild(label);

    let input;
    if (s.options) {
      input = document.createElement('select');
      input.id = id;
      for (const [oi, name] of s.options().entries()) {
        const opt = document.createElement('option');
        opt.value = String(oi);
        opt.textContent = name;
        input.appendChild(opt);
      }
      input.addEventListener('change', () => {
        cfg.layers[i][s.key] = Number(input.value);
        if (s.key === 'type') paintRows();
      });
    } else {
      input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      const val = document.createElement('span');
      val.className = 'val';
      input.addEventListener('input', () => {
        cfg.layers[i][s.key] = Number(input.value);
        val.textContent = `${input.value}${s.unit || ''}`;
      });
      row.appendChild(input);
      row.appendChild(val);
      rows[s.key] = { row, input, val, spec: s };
      host.appendChild(row);
      continue;
    }
    row.appendChild(input);
    rows[s.key] = { row, input, spec: s };
    host.appendChild(row);
  }
  bound.push(rows);
}

/** Hide the rows this layer's distortion has no use for. */
function paintRows() {
  for (let i = 0; i < 2; i++) {
    for (const { row, spec } of Object.values(bound[i])) {
      if (spec.only) row.hidden = !spec.only.includes(cfg.layers[i].type);
    }
  }
}

const presetEl = document.getElementById('preset');
for (const [i, p] of PRESETS.entries()) {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = p.name;
  presetEl.appendChild(opt);
}
presetEl.addEventListener('change', () => {
  const p = PRESETS[Number(presetEl.value)];
  if (p) applyPreset(p);
});

const autoEl = document.getElementById('auto');
const everyEl = document.getElementById('every');
const everyVal = document.getElementById('every-val');
/** m:ss, so a number that spans fifteen seconds to five minutes reads as a time. */
const asTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
autoEl.addEventListener('change', () => {
  cfg.auto = autoEl.checked;
  sinceDeal = 0;
  paintAuto();
});
everyEl.addEventListener('input', () => {
  cfg.autoSecs = Number(everyEl.value);
  everyVal.textContent = asTime(cfg.autoSecs);
  sinceDeal = 0;
});
/** The interval row is meaningless with the switch off, so it goes away. */
function paintAuto() {
  everyEl.closest('.row').hidden = !cfg.auto;
}

const fillEl = document.getElementById('fill');
fillEl.addEventListener('change', () => {
  cfg.fill = fillEl.checked;
  resize();
});

const blendEl = document.getElementById('blend');
blendEl.addEventListener('change', () => { cfg.blend = blendEl.value; });
const rateEl = document.getElementById('rate');
const rateVal = document.getElementById('rate-val');
rateEl.addEventListener('input', () => {
  cfg.rate = Number(rateEl.value) / 100;
  rateVal.textContent = `${cfg.rate.toFixed(1)}×`;
});

/** Push cfg back out to every control, after a preset, a shuffle or a file. */
function syncControls() {
  for (let i = 0; i < 2; i++) {
    for (const [key, b] of Object.entries(bound[i])) {
      const v = cfg.layers[i][key];
      b.input.value = String(v);
      if (b.val) b.val.textContent = `${v}${b.spec.unit || ''}`;
    }
  }
  blendEl.value = cfg.blend;
  fillEl.checked = cfg.fill;
  autoEl.checked = cfg.auto;
  everyEl.value = String(cfg.autoSecs);
  everyVal.textContent = asTime(cfg.autoSecs);
  paintAuto();
  resize();
  rateEl.value = String(Math.round(cfg.rate * 100));
  rateVal.textContent = `${cfg.rate.toFixed(1)}×`;
  paintRows();
}

// ------------------------------------------------------------- save and load
function sceneSnapshot() {
  return {
    app: 'earthbound-layers',
    version: 1,
    build: window.buildVersion?.() ?? 'unknown',
    blend: cfg.blend,
    rate: cfg.rate,
    fill: cfg.fill,
    auto: cfg.auto,
    autoSecs: cfg.autoSecs,
    // Names rather than indices: a file should still open as the picture it was
    // saved from after a pattern is added to the middle of the list.
    layers: cfg.layers.map((L) => ({
      ...L,
      pattern: PATTERNS[L.pattern]?.name,
      palette: PALETTES[L.palette]?.name,
      distortion: DISTORTIONS[L.type],
    })),
  };
}
window.sceneSnapshot = sceneSnapshot;

function loadScene(data) {
  if (!data || data.app !== 'earthbound-layers' || !Array.isArray(data.layers)) {
    throw new Error('not an Earthbound Layers scene');
  }
  cfg.blend = BLENDS[data.blend] !== undefined ? data.blend : 'add';
  cfg.rate = typeof data.rate === 'number' ? data.rate : 1;
  cfg.fill = !!data.fill;
  cfg.auto = data.auto !== undefined ? !!data.auto : true;
  if (typeof data.autoSecs === 'number') cfg.autoSecs = Math.max(15, Math.min(300, data.autoSecs));
  sinceDeal = 0;
  for (let i = 0; i < 2; i++) {
    const src = data.layers[i] || {};
    const L = { ...layerDefaults() };
    for (const s of SPEC) {
      if (s.options) continue;
      if (typeof src[s.key] === 'number') L[s.key] = src[s.key];
    }
    const pi = PATTERNS.findIndex((p) => p.name === src.pattern);
    const ci = PALETTES.findIndex((p) => p.name === src.palette);
    const ti = DISTORTIONS.indexOf(src.distortion);
    L.pattern = pi >= 0 ? pi : 0;
    L.palette = ci >= 0 ? ci : 0;
    L.type = ti >= 0 ? ti : (typeof src.type === 'number' ? src.type : 1);
    cfg.layers[i] = L;
  }
  syncControls();
}

const fileEl = document.getElementById('scene-file');
document.getElementById('save-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(sceneSnapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  a.download = `earthbound-layers-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Saved');
});
document.getElementById('load-btn').addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', async () => {
  const f = fileEl.files && fileEl.files[0];
  fileEl.value = '';
  if (!f) return;
  try {
    loadScene(JSON.parse(await f.text()));
    toast('Loaded');
  } catch (e) {
    toast(e.message || 'Could not read that file');
  }
});

// --------------------------------------------------------------------- trim
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

const pauseBtn = document.getElementById('pause-btn');
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  pauseBtn.textContent = paused ? 'Play' : 'Pause';
});

document.getElementById('shuffle-btn').addEventListener('click', () => {
  shuffle();
  toast('Shuffled');
});

const scrim = document.getElementById('scrim');
const menuBtn = document.getElementById('menu-btn');
function setMenu(open) {
  scrim.hidden = !open;
  menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  document.body.classList.toggle('menu-open', open);
}
// closest(), not a target test: the shared menu glyph is an SVG, so a press
// lands on a <line> inside the button and never on the button itself.
menuBtn.addEventListener('click', () => setMenu(scrim.hidden));
document.getElementById('close-btn').addEventListener('click', () => setMenu(false));
document.getElementById('done-btn').addEventListener('click', () => setMenu(false));
scrim.addEventListener('click', (e) => { if (e.target === scrim) setMenu(false); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !scrim.hidden) setMenu(false);
});

// --------------------------------------------------------------------- start
applyPreset(PRESETS[0]);
presetEl.value = '0';
resize();
requestAnimationFrame(frame);
