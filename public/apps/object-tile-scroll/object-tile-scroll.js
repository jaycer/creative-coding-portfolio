// Object Tile Scroll — everyday things, tiled across the dark, drifting upward.
//
// The camera never moves and neither does anything else, in the sense that
// matters: an object is planted at a spot in a lattice and rides straight out
// of the frame the way the whole field is going — up, by default, and any
// bearing the Angle slider is set to. It never wanders, never crosses another,
// never comes back. What it does IN that spot is the whole piece — some spin flat,
// some tumble end over end, some stutter into a new attitude and stay wrong,
// some breathe, some drift through colors, and a good share just stand there,
// which is what makes the rest read as odd.
//
// The lattice is the reliability and the deal is the surprise. Columns are
// spaced evenly across the frame at three depths, rows are spaced evenly along
// it, and every slot is filled the same way every time — but the moment an
// object leaves the leading edge it is thrown away and a completely new one is
// dealt in at the trailing one: a different object, a different finish, a
// different set of habits, a different note. Nothing recurs, so nothing can be
// anticipated, and yet you always know exactly where the next one will appear.
//
// Sound is the same idea. Every object carries its own continuous voice, panned
// to where it stands and loudest through the middle of the frame; see audio.js.
// The mix is therefore a readout of the picture, and it is silent by default —
// the header slider is what starts it.
//
// The set is seventy things. The chairs come from the other chair pieces in
// this gallery and the iron, dumbbell and desk lamp are built here out of boxes
// and cylinders; the rest of the household is Kenney's CC0 models, loaded after
// the field is already running. See models/CREDITS.md, and the bottom of this
// file for how a model becomes a build.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  startAudio, setVolume, audioLive, makeVoice, setVoiceMix, stopVoice, pitchFor,
  voiceCount,
} from './audio.js';

// ------------------------------------------------------------------ the parts
// Everything is built from a list of primitives given in meters at the object's
// own natural size, with y=0 at whatever it stands on. Nothing here has to
// agree with anything else about scale: each build is normalized to a unit
// sphere at the end, because a real iron next to a real chair is a speck, and
// a field of specks and chairs is not a field of objects.
const JOIN = 0.004; // bury shared end faces so butt joints can't z-fight

function partGeometry(p) {
  let g;
  if (p.box) g = new THREE.BoxGeometry(p.box[0], p.box[1], p.box[2]);
  else if (p.cyl) g = new THREE.CylinderGeometry(p.cyl[0], p.cyl[1], p.cyl[2], p.cyl[3] || 16);
  else g = new THREE.SphereGeometry(p.ball, 14, 10);
  // Scale first, so a primitive can be stretched along its own axes before it is
  // aimed: a three-sided cylinder is the only way to get a point, and a point
  // that is as long as it is wide is not the point of anything.
  if (p.scale) g.scale(p.scale[0], p.scale[1], p.scale[2]);
  if (p.rot) {
    if (p.rot[0]) g.rotateX(p.rot[0]);
    if (p.rot[1]) g.rotateY(p.rot[1]);
    if (p.rot[2]) g.rotateZ(p.rot[2]);
  }
  if (p.pos) g.translate(p.pos[0], p.pos[1], p.pos[2]);
  return g;
}

/**
 * A round member given by where it starts and where it ends in the side view,
 * rather than by a center, a length and an angle. A lamp arm is defined by the
 * two joints it connects; picking its length and its lean independently leaves
 * it either short of the elbow or through it.
 */
function rodYZ(x, r, from, to, seg = 10) {
  const dy = to[0] - from[0];
  const dz = to[1] - from[1];
  return {
    cyl: [r, r, Math.hypot(dy, dz), seg],
    pos: [x, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    // A cylinder stands along Y, and turning it about X swings its top toward +Z.
    rot: [Math.atan2(dz, dy), 0, 0],
  };
}

// ---- chairs, carried over from Hey Chair and Chair Pile ----------------------

/** The plain four-leg dining chair. */
function diningParts() {
  const SEAT_W = 0.46, SEAT_D = 0.44, SEAT_T = 0.05, SEAT_Y = 0.44;
  const LEG = 0.05, LEG_H = 0.44, BACK_H = 0.55;
  const LEG_X = SEAT_W / 2 - LEG / 2, LEG_Z = SEAT_D / 2 - LEG / 2;
  const H = SEAT_Y + SEAT_T + BACK_H;
  return [
    { box: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
    { box: [LEG, LEG_H + JOIN, LEG], pos: [LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
    { box: [LEG, LEG_H + JOIN, LEG], pos: [-LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
    { box: [LEG, H - JOIN, LEG], pos: [LEG_X, (H - JOIN) / 2, -LEG_Z] },
    { box: [LEG, H - JOIN, LEG], pos: [-LEG_X, (H - JOIN) / 2, -LEG_Z] },
    { box: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.66, -LEG_Z] },
    { box: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.80, -LEG_Z] },
    { box: [SEAT_W, 0.07, LEG], pos: [0, H - 0.035, -LEG_Z] },
  ];
}

/** Backless, tall, with a footrest ring — the one that reads as a bar stool. */
function stoolParts() {
  const S = 0.36, T = 0.06, Y = 0.68, LEG = 0.045;
  const X = S / 2 - LEG / 2;
  const parts = [{ box: [S, T, S], pos: [0, Y + T / 2, 0] }];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ box: [LEG, Y + JOIN, LEG], pos: [sx * X, (Y + JOIN) / 2, sz * X] });
    }
  }
  for (const [sx, sz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    parts.push({
      box: sz ? [S, 0.035, 0.035] : [0.035, 0.035, S],
      pos: [sx * X, 0.22, sz * X],
    });
  }
  return parts;
}

/** Wide, low and upholstered-looking, with arms. */
function armchairParts() {
  const W = 0.62, D = 0.58, SEAT_Y = 0.36, T = 0.12;
  const LEG = 0.06, LEG_X = W / 2 - LEG, LEG_Z = D / 2 - LEG;
  return [
    { box: [W, T, D], pos: [0, SEAT_Y + T / 2, 0] },
    { box: [W, 0.52, 0.14], pos: [0, SEAT_Y + T + 0.26, -D / 2 + 0.07] },
    { box: [0.12, 0.22, D - 0.1], pos: [W / 2 - 0.06, SEAT_Y + T + 0.11, 0.03] },
    { box: [0.12, 0.22, D - 0.1], pos: [-W / 2 + 0.06, SEAT_Y + T + 0.11, 0.03] },
    { box: [LEG, SEAT_Y + JOIN, LEG], pos: [LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { box: [LEG, SEAT_Y + JOIN, LEG], pos: [-LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { box: [LEG, SEAT_Y + JOIN, LEG], pos: [LEG_X, (SEAT_Y + JOIN) / 2, -LEG_Z] },
    { box: [LEG, SEAT_Y + JOIN, LEG], pos: [-LEG_X, (SEAT_Y + JOIN) / 2, -LEG_Z] },
  ];
}

/** A ladderback: absurdly tall, five rungs, the drama queen of the set. */
function ladderbackParts() {
  const SEAT_W = 0.42, SEAT_D = 0.40, SEAT_T = 0.045, SEAT_Y = 0.46;
  const LEG = 0.042, H = 1.34;
  const LEG_X = SEAT_W / 2 - LEG / 2, LEG_Z = SEAT_D / 2 - LEG / 2;
  const parts = [
    { box: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
    { box: [LEG, SEAT_Y + JOIN, LEG], pos: [LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { box: [LEG, SEAT_Y + JOIN, LEG], pos: [-LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { box: [LEG, H - JOIN, LEG], pos: [LEG_X, (H - JOIN) / 2, -LEG_Z] },
    { box: [LEG, H - JOIN, LEG], pos: [-LEG_X, (H - JOIN) / 2, -LEG_Z] },
  ];
  for (let i = 0; i < 5; i++) {
    parts.push({
      box: [SEAT_W - LEG * 2 + JOIN * 2, 0.05, LEG * 0.8],
      pos: [0, 0.62 + i * 0.17, -LEG_Z],
    });
  }
  return parts;
}

/** The folding chair: two frames that cross, the rear pair carrying on up. */
function foldingParts() {
  const W = 0.44, SEAT_D = 0.40, SEAT_T = 0.034;
  const SEAT_TOP = 0.44;
  const UNDER = SEAT_TOP - SEAT_T;
  const T = 0.032;
  const BACK_TOP = 0.86;

  const UP_X = W / 2 - T / 2;
  const UP_FOOT = -0.15;
  const UP_HEAD = -0.29;
  const upZ = (y) => UP_FOOT + (y / BACK_TOP) * (UP_HEAD - UP_FOOT);

  const LEG_X = UP_X - T - 0.006;
  const LEG_FOOT = 0.20;
  const LEG_HEAD = -0.09;
  const legZ = (y) => LEG_FOOT + (y / UNDER) * (LEG_HEAD - LEG_FOOT);

  const RAIL = 0.026;
  const RAIL_Y = 0.13;
  const parts = [];

  // Square stock, so these use the box form of the same start/end idea rodYZ
  // does for round members.
  const memberYZ = (x, width, thick, from, to) => {
    const dy = to[0] - from[0], dz = to[1] - from[1];
    return {
      box: [width, Math.hypot(dy, dz), thick],
      pos: [x, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
      rot: [Math.atan2(dz, dy), 0, 0],
    };
  };

  for (const side of [1, -1]) {
    parts.push(memberYZ(side * UP_X, T, T, [0, UP_FOOT], [BACK_TOP, UP_HEAD]));
    parts.push(memberYZ(side * LEG_X, T, T, [0, LEG_FOOT], [UNDER + JOIN, legZ(UNDER)]));
  }
  parts.push({ box: [W, SEAT_T, SEAT_D], pos: [0, SEAT_TOP - SEAT_T / 2, -JOIN] });
  parts.push(memberYZ(0, UP_X * 2, 0.026, [0.56, upZ(0.56)], [BACK_TOP, UP_HEAD]));
  parts.push({ box: [LEG_X * 2, RAIL, RAIL], pos: [0, RAIL_Y, legZ(RAIL_Y)] });
  parts.push({ box: [UP_X * 2, RAIL, RAIL], pos: [0, RAIL_Y, upZ(RAIL_Y)] });
  return parts;
}

// ---- the rest of the household ----------------------------------------------

/**
 * A clothes iron. Only two things identify one: a flat plate that comes to a
 * point, and an arch of handle over the top. So both are made large and
 * everything else is kept out of the way — the first build gave it a body like
 * a brick and a temperature dial on the nose, and it came out reading as a
 * camera.
 *
 * The point is a triangular prism, a three-sided cylinder, and the body repeats
 * it a size down so the taper carries all the way up instead of a wedge with a
 * box parked on it.
 */
function ironParts() {
  // A three-sided cylinder of circumradius r has a flat side of width r*√3 and
  // reaches r past the middle to its point, so both are set from the width the
  // part has to meet.
  // Left to itself that fixes a prism's length at 0.87 of its width, which is a
  // chamfer and not a point, so it is stretched along z until it is a nose.
  //
  // One prism on a box is still not enough. A prism is extruded straight up, so
  // its point exists in plan and nowhere else: seen from the side — which is how
  // a thing sitting at eye level in this field is mostly seen — a flat body with
  // a pointed plan is a rectangle, and the first two builds both read as a
  // stepped block. So the body is a stack of slabs, each one narrower than the
  // last and each one reaching less far forward, which puts the taper in the
  // profile as well and is roughly how the real object is shaped anyway.
  const slab = (w, reach, y0, y1, backZ, frontZ) => {
    const r = w / Math.sqrt(3);
    const sz = reach / (r * 1.5);
    const h = y1 - y0, y = (y0 + y1) / 2;
    return [
      { box: [w, h, frontZ - backZ], pos: [0, y, (backZ + frontZ) / 2] },
      { cyl: [r, r, h, 3], scale: [1, 1, sz], pos: [0, y, frontZ + (r / 2) * sz] },
    ];
  };
  // The soleplate, wider than anything above it, and over half of it point.
  const parts = [...slab(0.145, 0.155, 0.000, 0.016, -0.185, -0.045)];

  // The body over it, in six thin slabs whose width and reach fall away as a
  // quarter circle. Four fat ones made a ziggurat; six on a curve read as a
  // shell that domes over and noses down to the tip.
  const TOP = 0.108, LAYERS = 6;
  for (let i = 0; i < LAYERS; i++) {
    const y0 = 0.016 + ((TOP - 0.016) * i) / LAYERS;
    const y1 = 0.016 + ((TOP - 0.016) * (i + 1)) / LAYERS;
    const u = (i + 0.5) / LAYERS;
    const fall = Math.sqrt(1 - u * u * 0.86);
    parts.push(...slab(0.132 * fall, 0.140 * fall, y0, y1, -0.182 + 0.012 * u, -0.045));
  }

  parts.push(
    // The handle: two slim posts and a grip running past both of them.
    { box: [0.026, 0.068, 0.030], pos: [0, 0.136, -0.150] },
    { box: [0.024, 0.060, 0.028], pos: [0, 0.132, -0.048] },
    { cyl: [0.017, 0.017, 0.190, 12], pos: [0, 0.172, -0.100], rot: [Math.PI / 2, 0, 0] },
    // The cord guard off the back, which is what stops it reading as a doorstop
    // when the handle happens to be edge-on.
    { cyl: [0.024, 0.013, 0.050, 12], pos: [0, 0.078, -0.205], rot: [Math.PI / 2, 0, 0] },
  );
  return parts;
}

/** A dumbbell: a knurled bar, two collars, two plates with a rim step. */
function dumbbellParts() {
  const AX = [0, 0, Math.PI / 2];   // lay a cylinder along X
  const parts = [
    { cyl: [0.021, 0.021, 0.30, 14], pos: [0, 0, 0], rot: AX },
  ];
  for (const s of [1, -1]) {
    parts.push({ cyl: [0.055, 0.055, 0.030, 16], pos: [s * 0.104, 0, 0], rot: AX });
    parts.push({ cyl: [0.105, 0.105, 0.056, 24], pos: [s * 0.146, 0, 0], rot: AX });
    parts.push({ cyl: [0.078, 0.078, 0.020, 24], pos: [s * 0.182, 0, 0], rot: AX });
  }
  return parts;
}

/**
 * A desk lamp of the jointed-arm kind, which is the one everybody pictures. The
 * arms are given end to end so the elbow is a real joint, and the shade hangs
 * off the head pointing down and forward rather than straight down — a shade
 * aimed at its own base reads as a mushroom.
 */
function lampParts() {
  const ELBOW = [0.36, -0.10];
  const HEAD = [0.50, 0.13];
  const TILT = -0.6;                             // opening swings down and forward
  const dir = [-Math.cos(TILT), -Math.sin(TILT)]; // where the shade opens, in (y,z)
  const SHADE_H = 0.125;
  return [
    { cyl: [0.115, 0.128, 0.024, 26], pos: [0, 0.012, 0] },
    { cyl: [0.026, 0.026, 0.045, 14], pos: [0, 0.042, 0] },
    rodYZ(0, 0.014, [0.05, 0], ELBOW),
    { ball: 0.027, pos: [0, ELBOW[0], ELBOW[1]] },
    rodYZ(0, 0.014, ELBOW, HEAD),
    { ball: 0.025, pos: [0, HEAD[0], HEAD[1]] },
    {
      cyl: [0.036, 0.095, SHADE_H, 22],
      pos: [0, HEAD[0] + dir[0] * SHADE_H / 2, HEAD[1] + dir[1] * SHADE_H / 2],
      rot: [TILT, 0, 0],
    },
    { ball: 0.034, pos: [0, HEAD[0] + dir[0] * 0.10, HEAD[1] + dir[1] * 0.10] },
  ];
}

// ------------------------------------------------------------------ the deck
// One entry per build the field can deal. `weight` is how often it comes up and
// `voice` is which timbre in audio.js it sings with. Kinds are registered rather
// than declared, because the imported models (see the bottom of this file)
// arrive over the network a moment after the field is already running.
//
// Every build is recentered on its own bounding box and scaled to a unit
// bounding sphere, which does two jobs: a spin is about the object's middle
// rather than about its feet, and a mug holds the same amount of frame as a
// sofa. Real relative sizes would make half the set invisible, and the
// flattening is most of why the field reads as a set of icons rather than as a
// warehouse.
const KINDS = [];
const KIND_BY_NAME = new Map();
let totalWeight = 0;

function normalize(g) {
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  g.boundingBox.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingSphere();
  const s = 1 / g.boundingSphere.radius;
  g.scale(s, s, s);
  g.computeBoundingSphere();
  return g;
}

/**
 * Register a build.
 *
 * `groups` describes how the geometry is divided between materials. A hand-built
 * object is one group and takes the finish color flat. An imported model came
 * with its own flat-colored parts — a television is a dark screen in a lighter
 * shell — and throwing those away would turn it into a solid lump, so instead
 * each group records how its color sat RELATIVE to the model's main one, in
 * hue, saturation and lightness. Recolor the main one to whatever the finish
 * says and every other part moves with it, keeping the screen dark and the
 * leaves distinct from the pot.
 */
function addKind({ name, weight, voice, geometry, srcColors }) {
  const groups = [];
  if (!srcColors || srcColors.length < 2) {
    groups.push({ dh: 0, ds: 0, dl: 0 });
  } else {
    // The body is the group with the most of the object in it; everything else
    // is measured against that.
    const body = srcColors[0];
    const bh = { h: 0, s: 0, l: 0 };
    body.getHSL(bh);
    const h = { h: 0, s: 0, l: 0 };
    for (const c of srcColors) {
      c.getHSL(h);
      let dh = h.h - bh.h;
      if (dh > 0.5) dh -= 1;
      if (dh < -0.5) dh += 1;
      groups.push({ dh, ds: h.s - bh.s, dl: h.l - bh.l });
    }
  }
  KIND_BY_NAME.set(name, KINDS.length);
  KINDS.push({ name, weight, voice, geometry: normalize(geometry), groups });
  totalWeight += weight;
}

// The five chairs carried over from the other chair pieces were weighted for a
// set of eight builds, where they had to be most of the field or there was no
// field. With fifty-five builds and ten chairs among them they no longer have to
// carry it, so they are dealt at half what they were: a chair still comes round
// about a quarter of the time, but it is far less often one of these five.
for (const k of [
  { name: 'dining chair', parts: diningParts, weight: 1.5, voice: 'wood' },
  { name: 'stool', parts: stoolParts, weight: 1.2, voice: 'wood' },
  { name: 'armchair', parts: armchairParts, weight: 1, voice: 'wood' },
  { name: 'ladderback', parts: ladderbackParts, weight: 1, voice: 'wood' },
  { name: 'folding chair', parts: foldingParts, weight: 1, voice: 'wood' },
  { name: 'clothes iron', parts: ironParts, weight: 2.2, voice: 'steam' },
  { name: 'dumbbell', parts: dumbbellParts, weight: 2.2, voice: 'ring' },
  { name: 'desk lamp', parts: lampParts, weight: 2.2, voice: 'hum' },
]) {
  addKind({ ...k, geometry: mergeGeometries(k.parts().map(partGeometry)) });
}

function pickKind(rand) {
  let r = rand() * totalWeight;
  for (let i = 0; i < KINDS.length; i++) {
    r -= KINDS[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}

// -------------------------------------------------------------------- finishes
// The same six ways of making a thing the chair pieces use, so a chair here is
// recognizably a chair from over there, and so an iron and a dumbbell are made
// of the materials those are actually made of often enough to be believed.
// Every swatch is held above a luminance floor, which the chair pieces did not
// have to do: against their lit stage a near-black gloss read as a black chair,
// and against this room it reads as a hole. The darkest wood, the velvets and
// the black gloss have all been lifted a stop or two — enough that the room is
// still the darkest thing on screen by a clear margin, and no object can ever
// arrive as a silhouette.
const FINISHES = [
  { name: 'wood', colors: [0xc98a45, 0x9c6539, 0xb07a4a, 0x8b5c38], rough: 0.72, metal: 0.04 },
  { name: 'paint', colors: [0xd94f6a, 0x3f7fd6, 0x4fbf74, 0xe0b23c, 0xd6d0c4], rough: 0.5, metal: 0.05 },
  { name: 'chrome', colors: [0xd8dde6, 0xc4ccd6, 0xe7c98a], rough: 0.22, metal: 0.82 },
  { name: 'velvet', colors: [0x9c2a63, 0x35619f, 0x3e8c5c, 0x8f4229], rough: 0.9, metal: 0 },
  { name: 'gloss', colors: [0x5c6478, 0xf2f0ea, 0xc0342f], rough: 0.14, metal: 0.2 },
  { name: 'neon', colors: [0xff3d8b, 0x2fe8ff, 0xb4ff3d, 0xffb02f], rough: 0.4, metal: 0.1, glow: 0.5 },
];

// ---------------------------------------------------------------------- the rng
// Seeded, so ?seed=123 deals the same opening field twice. Only the opening: the
// point of the piece is that what comes after is not written down anywhere.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED_PARAM = new URLSearchParams(location.search).get('seed');
const RUN_SEED = SEED_PARAM !== null && Number.isFinite(Number(SEED_PARAM))
  ? Number(SEED_PARAM) >>> 0
  : (Math.random() * 4294967296) >>> 0;
const rng = makeRng(RUN_SEED);

// --------------------------------------------------------------------- the view
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

// The room. Near black, but not flat black: a slow vertical wash, darkest
// overhead and lifting a little toward the floor, which is what an unlit room
// with light coming from somewhere low actually looks like. It is drawn as the
// scene background rather than as a plane, so it costs nothing and can never be
// intersected by an object drifting back through it.
//
// Deliberately NOT a radial pool. A gradient that darkens toward the corners
// would dim whatever happened to be passing them, and an object's brightness
// here must depend on nothing but the rig.
function roomBackdrop() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#05060a');
  grad.addColorStop(0.55, '#0a0c12');
  grad.addColorStop(1, '#13161e');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = roomBackdrop();
// No fog. Fog dims a thing for being far away, and every object here is meant
// to be as well lit at the back of the room as at the front — the far band
// already reads as far away from being smaller and from the parallax.

/**
 * The room again, this time as something to reflect.
 *
 * Without this, anything with metalness renders very nearly black: a metal has
 * almost no diffuse, so all it can show is what is around it, and around it was
 * nothing. The chrome finish came out as a silhouette with one specular streak
 * on the seat. Three's own RoomEnvironment would fix that by putting a bright
 * white studio around everything, which is not this room.
 *
 * So the environment is built to match the backdrop: dark overhead, a broad
 * band of light at lamp height, and a lifted floor underneath. Metals now catch
 * the same room the eye is being told they are standing in, and the diffuse
 * bounce it adds is what makes the field feel enclosed rather than cut out.
 */
function roomEnvironment() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d');
  // An equirectangular map, so top of the canvas is straight up.
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, '#0b0d13');     // ceiling
  grad.addColorStop(0.30, '#5d6779');  // the lamps, as a band rather than points
  grad.addColorStop(0.52, '#252b39');  // horizon
  grad.addColorStop(1, '#353c4c');     // floor, catching the key
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}
scene.environment = roomEnvironment();

const FOV = 42;
const TAN = Math.tan((FOV * Math.PI) / 360);
// The seat, and it never moves: at the origin, looking down -Z, so an object's
// world y IS its height up the frame and the projection is one division.
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 60);

// The rig. Every source is a DIRECTIONAL light, which is the whole point: a
// directional light has no position and no falloff, so a chair in the top left
// corner is lit by exactly the same light, from exactly the same angle, as one
// in the middle or one twelve meters further back. Everything in the field
// therefore reads as being in one room under one set of lamps, and nothing is
// dimmer for being near an edge. A point or spot light would put a pool in the
// middle of the frame and darken the corners, which is the one thing this must
// not do.
const key = new THREE.DirectionalLight(0xfff3e4, 2.7);   // high front left
key.position.set(0.5, 0.9, 0.85);
const fill = new THREE.DirectionalLight(0xc2d8ff, 1.15); // cool, from the right
fill.position.set(-0.85, 0.2, 0.5);
const rim = new THREE.DirectionalLight(0xffffff, 1.0);   // behind, to draw edges
rim.position.set(-0.15, 0.45, -1);
// Off the floor. Without it an object's underside is the same value as the room
// and the bottom half of everything disappears into the dark.
const bounce = new THREE.DirectionalLight(0x9fb0cc, 0.55);
bounce.position.set(0.15, -1, 0.4);
const amb = new THREE.HemisphereLight(0x93a6c8, 0x1a1d26, 0.8);
scene.add(key, fill, rim, bounce, amb);

// ---------------------------------------------------------------- the settings
const DEFAULTS = { speed: 1.0, spacing: 1.0, odd: 0.55, angle: 0 };
const cfg = { ...DEFAULTS };

const BASE_ROW = 3.3;      // world units between rows at spacing 1
const DEPTHS = [10.6, 12.6, 14.8];
const MARGIN = 2.6;        // how far past the frame a slot is kept alive
// A screen is about 9.7 units tall at the middle band, so half a minute to
// cross it — slow enough that a still frame of the piece looks still, which is
// the pace the whole thing is written at.
const SPEED_BASE = 0.3;

const rowStep = () => BASE_ROW * cfg.spacing;
const halfHAt = (depth) => depth * TAN;
const halfWAt = (depth) => depth * TAN * camera.aspect;

// ------------------------------------------------------------- which way is up
// The angle is a compass bearing on the screen: 0 rides straight up, 90 to the
// right, 180 falls. Everything below is written in the frame that bearing sets —
// v along the travel, u across it — so the lattice, the recycling and the mix
// are one piece of arithmetic that happens to be pointed somewhere. Only these
// four numbers know which way that is.
//
// The camera projects x and y through the same focal length, so an angle in
// world units IS the angle you see on screen; NDC is the stretched space, not
// this one. That is what lets the whole field be aimed by rotating two axes and
// leaves the picture undistorted at 37 degrees.
let TX = 0, TY = 1;    // along the travel
let NX = 1, NY = 0;    // across it, a quarter turn from the travel

function aimField() {
  const a = (cfg.angle * Math.PI) / 180;
  TX = Math.sin(a); TY = Math.cos(a);
  NX = TY; NY = -TX;
}

/** The lattice coordinates of an object, put back into the world the camera sees. */
function place(o) {
  o.x = o.u * NX + o.v * TX;
  o.y = o.u * NY + o.v * TY;
}

// How far the frame reaches along each of those axes. A rectangle measured along
// a tilted axis is as long as its own shadow on it: the width contributes |sin|,
// the height |cos|. Both are proportional to depth, exactly as the frame is, so
// a column placed by its screen fraction stays under the same screen fraction at
// every depth however the field is aimed.
const halfTAt = (depth) => halfWAt(depth) * Math.abs(TX) + halfHAt(depth) * Math.abs(TY);
const halfUAt = (depth) => halfWAt(depth) * Math.abs(NX) + halfHAt(depth) * Math.abs(NY);

// ------------------------------------------------------------------ the field
// A column is a fixed place across the frame at a fixed depth, holding a stack
// of slots spaced rowStep apart. Columns are laid out in SCREEN space and not
// in world space: place them by world x and the near ones bunch into the middle
// while the far ones run off the sides, and the field stops reading as a tiling.
const field = [];    // columns: { ndcU, depth, rows, span, phase, objs[] }
let scrolled = 0;    // how far the whole field has risen, for the record


const PRIMARIES = [
  ['spin', 0.26],      // flat, about its own vertical axis
  ['tumble', 0.20],    // end over end
  ['glitch', 0.16],    // thrown into a new attitude and left there
  ['breathe', 0.20],   // grows and shrinks
  ['hue', 0.18],       // walks through colors
];
const PRIMARY_TOTAL = PRIMARIES.reduce((s, p) => s + p[1], 0);

function pickPrimary(rand) {
  let r = rand() * PRIMARY_TOTAL;
  for (const [name, w] of PRIMARIES) {
    r -= w;
    if (r <= 0) return name;
  }
  return 'spin';
}

// The stutter runs off one clock for everybody. Each glitching object takes
// every first, second or third tick of it, so the frame stutters together
// without every stutterer moving at the same moment — a shared pulse, dealt out
// unevenly, which is the piece in one line.
const GLITCH_HZ = 2.6;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const _base = new THREE.Color();
const _bhsl = { h: 0, s: 0, l: 0 };

/**
 * Hand the object the geometry and the right number of materials for a kind.
 * Kinds differ in how many color groups they have, so the material pool grows to
 * fit and the mesh is given either the one material or the array.
 */
function setKind(o, kindIdx) {
  const k = KINDS[kindIdx];
  o.kindIdx = kindIdx;
  o.mesh.geometry = k.geometry;
  o.ghost.geometry = k.geometry;
  const n = k.groups.length;
  while (o.mats.length < n) {
    o.mats.push(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 }));
  }
  // A single material is handed over as itself rather than as a one-element
  // array: three only walks the geometry's groups when the material IS an array,
  // and a hand-built geometry has no groups to walk.
  o.mesh.material = n === 1 ? o.mats[0] : o.mats.slice(0, n);
}

/**
 * Paint the object from its finish, its base color and however far its hue has
 * drifted. Everything about how an object looks is derived here and nowhere
 * else, so the color-drifting habit is one number moving rather than a second
 * copy of the coloring rules.
 */
function applyLook(o) {
  const k = KINDS[o.kindIdx];
  const f = FINISHES[o.finishIdx];
  _base.set(o.baseHex);
  if (o.hueShift) {
    _base.getHSL(_bhsl);
    _base.setHSL((_bhsl.h + o.hueShift + 1) % 1, _bhsl.s, _bhsl.l);
  }
  _base.getHSL(_bhsl);
  for (let i = 0; i < k.groups.length; i++) {
    const g = k.groups[i];
    const m = o.mats[i];
    if (g.dh === 0 && g.ds === 0 && g.dl === 0) m.color.copy(_base);
    else m.color.setHSL((_bhsl.h + g.dh + 1) % 1, clamp01(_bhsl.s + g.ds), clamp01(_bhsl.l + g.dl));
    m.roughness = f.rough;
    m.metalness = f.metal;
    if (f.glow) { m.emissive.copy(m.color); m.emissiveIntensity = f.glow; }
    else { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
  }
}

/** Deal an object a whole new identity in place. Used at build and at recycle. */
function deal(o, rand) {
  const kindIdx = pickKind(rand);
  const kind = KINDS[kindIdx];
  setKind(o, kindIdx);

  const fi = Math.floor(rand() * FINISHES.length);
  const f = FINISHES[fi];
  o.finishIdx = fi;
  o.baseHex = f.colors[Math.floor(rand() * f.colors.length)];
  o.hueShift = 0;
  applyLook(o);

  // Bigger things sit nearer the front of the depth band they are in and sing
  // lower; the size is the one thing the eye and the ear agree about.
  o.baseScale = 0.62 + rand() * 0.46;
  o.size = (o.baseScale - 0.62) / 0.46;
  o.note = pitchFor(o.size, rand());

  // Habits. Below the misbehaving share an object simply stands there, which is
  // not a fallback — a field where everything moves has nothing in it that is
  // moving.
  const odd = rand() < cfg.odd;
  o.spin = false; o.tumble = false; o.glitch = false; o.breathe = false; o.hue = false;
  if (odd) {
    o[pickPrimary(rand)] = true;
    if (rand() < 0.35) o[pickPrimary(rand)] = true;
  }

  // A thing standing still is turned a little off square so it reads as placed
  // rather than as installed; a thing that is going to spin anyway can start
  // anywhere.
  o.face = odd ? rand() * Math.PI * 2 : (rand() - 0.5) * 1.3;
  o.tiltX = odd ? (rand() - 0.5) * 0.3 : (rand() - 0.5) * 0.12;
  o.tiltZ = (rand() - 0.5) * 0.12;

  o.spinRate = (0.35 + rand() * 1.15) * (rand() < 0.5 ? -1 : 1);
  o.tumbleAxis = rand() < 0.5 ? 'x' : 'z';
  o.tumbleRate = (0.3 + rand() * 0.85) * (rand() < 0.5 ? -1 : 1);
  o.breatheRate = 0.09 + rand() * 0.28;
  o.breatheAmp = 0.18 + rand() * 0.3;
  o.breathePhase = rand() * Math.PI * 2;
  o.hueRate = (0.02 + rand() * 0.075) * (rand() < 0.5 ? -1 : 1);
  o.glitchEvery = 1 + Math.floor(rand() * 3);
  o.glitchOffset = Math.floor(rand() * 3);

  o.angle = 0;
  o.snapTick = -1;
  o.snapFlash = 0;
  o.snapEuler.set(0, 0, 0);

  o.mesh.visible = true;
  o.ghost.visible = false;
  // The double is struck off the object's own color rather than being one fixed
  // hue, so the smear always belongs to the thing that made it.
  _base.set(o.baseHex).getHSL(_bhsl);
  o.ghost.material.color.setHSL((_bhsl.h + 0.42) % 1, 0.85, 0.62);
  o.ghostOff.set(
    (rand() - 0.5) * 0.7, 0.08 + rand() * 0.2, (rand() - 0.5) * 0.5,
  );

  releaseVoice(o);
  o.voiceName = kind.voice;
  o.voiceSeed = rand();
}

function makeObject(col, rand) {
  const mesh = new THREE.Mesh(KINDS[0].geometry, null);
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
  });
  const ghost = new THREE.Mesh(KINDS[0].geometry, ghostMat);
  ghost.visible = false;
  scene.add(mesh, ghost);

  const o = {
    mesh, ghost, mats: [], col,
    kindIdx: 0, finishIdx: 0, baseHex: 0xffffff, hueShift: 0,
    // u across the travel and v along it are where the object actually lives;
    // x and y are where that lands once the field is aimed, rewritten every
    // frame by place() and never the other way about.
    u: 0, v: 0,
    x: 0, y: 0, z: -col.depth,
    scale: 1,
    snapEuler: new THREE.Euler(),
    ghostOff: new THREE.Vector3(),
    voice: null, voiceName: 'wood', voiceSeed: 0,
    // A slot's own nudge off the lattice, kept for the object's whole life at
    // that slot: without it the columns are ruler-straight and the field looks
    // printed rather than placed.
    jx: 0, jz: 0,
  };
  deal(o, rand);
  return o;
}

function disposeObject(o) {
  releaseVoice(o);
  scene.remove(o.mesh, o.ghost);
  for (const m of o.mats) m.dispose();
  o.ghost.material.dispose();
}

// The field is dealt once and adjusted from then on. Nothing here ever throws
// the picture away and starts again: a setting changes what the lattice is, and
// the objects already standing in it stay standing, move to where the new
// lattice puts them, and are added to or taken from at the trailing end where
// nothing is in sight. Only a loaded file replaces the field outright, and that
// is the one case where replacing it is the whole point.

/** How many slots a column needs to reach across the frame along the travel. */
function rowsFor(depth, step) {
  return Math.ceil((2 * halfTAt(depth) + 2 * MARGIN) / step) + 1;
}

/** The slot furthest back in a column: the one behind everything else. */
function backOf(col) {
  let back = null;
  for (const o of col.objs) if (!back || o.v < back.v) back = o;
  return back;
}

/**
 * Give a column the length it needs, adding and taking away at the trailing end
 * only. An object on screen is never the one that goes, and a new one arrives
 * behind everything already up, so a column changes length without anything
 * visible moving to let it.
 *
 * `shrink` is what separates a change of angle from a change of spacing. Aiming
 * the field only ever asks for MORE reach — a column that has covered the
 * diagonal once can keep those slots, and dropping them the moment the bearing
 * swings back would be a drop for nothing.
 */
function fitRows(col, step, shrink) {
  const need = rowsFor(col.depth, step);
  while (col.objs.length < need) {
    const back = backOf(col);
    const o = makeObject(col, rng);
    o.jx = (rng() - 0.5) * 0.34;
    o.jz = (rng() - 0.5) * 1.5;
    o.v = (back ? back.v : 0) - step;
    col.objs.push(o);
  }
  // The trailing slot is usually well behind the frame, but at a wide spacing —
  // where a row step is more than the margin — it can be standing just inside
  // the bottom of it. A slot dropped there is an object disappearing in front of
  // you, so the column simply stays a slot long: extra length past the end costs
  // nothing but a little arithmetic, and the next adjustment collects it once
  // the column has turned over and the back of it is out of sight again.
  const edge = -halfTAt(col.depth);
  while (shrink && col.objs.length > need) {
    const back = backOf(col);
    if (back.v + back.scale > edge) break;
    col.objs.splice(col.objs.indexOf(back), 1);
    disposeObject(back);
  }
  col.rows = col.objs.length;
  col.span = col.rows * step;
}

/** A column with no history: dealt full, from the back of the frame forward. */
function fillColumn(col, step) {
  const start = -halfTAt(col.depth) - MARGIN;
  const rows = rowsFor(col.depth, step);
  for (let r = 0; r < rows; r++) {
    const o = makeObject(col, rng);
    o.jx = (rng() - 0.5) * 0.34;
    o.jz = (rng() - 0.5) * 1.5;
    o.v = start + (r + col.phase) * step;
    col.objs.push(o);
  }
  col.rows = rows;
  col.span = rows * step;
}

/**
 * Take the field to the lattice the settings now describe — a new spacing, a new
 * window — without dealing it again.
 *
 * Columns are spread evenly across the frame, so a change in how many there are
 * moves all of them: they fan out or draw in, and the ones that cannot be paid
 * for are dropped from the end. Along a column, the slots are simply scaled: an
 * object's distance along the travel is multiplied by how much the row step
 * moved, which stretches the column about the middle of the frame rather than
 * about its own end. The thing you are looking at stays roughly where it is and
 * the field opens out around it, which is what "how far apart they stand" ought
 * to feel like.
 *
 * It also builds the field from nothing, since a field of no columns is just the
 * case where every column is new.
 */
function respace() {
  const step = rowStep();
  const cols = columnCount();

  while (field.length > cols) {
    for (const o of field.pop().objs) disposeObject(o);
  }
  while (field.length < cols) {
    const i = field.length;
    const col = {
      ndcU: 0,
      depth: DEPTHS[i % DEPTHS.length],
      rows: 0,
      span: 0,
      // Half a row of stagger on every other column, so the field is a tiling
      // and not a spreadsheet.
      phase: (i % 2) * 0.5,
      objs: [],
    };
    field.push(col);
    fillColumn(col, step);
  }

  for (let c = 0; c < field.length; c++) {
    const col = field[c];
    col.ndcU = -1 + ((c + 0.5) / cols) * 2;
    // The step this column is currently laid out at, read back off itself rather
    // than remembered: rows and span are kept in step by everything that touches
    // them, so their ratio is the truth about where its objects are standing.
    const was = col.rows ? col.span / col.rows : step;
    if (was !== step) for (const o of col.objs) o.v *= step / was;
    fitRows(col, step, true);
  }
  placeColumns();
}

/**
 * Lengthen every column to reach across the frame along the travel axis.
 *
 * Aiming the field at a corner asks a column to cover the diagonal rather than
 * the height, and a column too short to reach wraps early and drags an empty
 * band up through the picture. Growing is all that happens: the bearing must be
 * free to swing without the field re-spacing itself under the slider.
 */
function growColumns() {
  const step = rowStep();
  for (const c of field) fitRows(c, step, false);
}

/** How many columns the window is worth, across whichever way the field runs. */
function columnCount() {
  const wide = 2 * halfUAt(DEPTHS[1]);
  return Math.max(3, Math.min(12, Math.round(wide / (2.9 * cfg.spacing))));
}

/** Put every column where its screen fraction says, for this aspect and bearing. */
function placeColumns() {
  for (const c of field) {
    const halfU = halfUAt(c.depth);
    // 1.04 so the outermost columns hang a little off each edge: a field that
    // stops exactly at the frame edge reads as a strip, not as a field.
    const u = c.ndcU * halfU * 1.04;
    for (const o of c.objs) {
      o.u = u + o.jx * (2 * halfU) / field.length;
      o.z = -(c.depth + o.jz);
      place(o);
    }
  }
}

// ------------------------------------------------------------------ the voices
function releaseVoice(o) {
  if (o.voice) { stopVoice(o.voice); o.voice = null; }
}

/**
 * How loud an object is and where it is panned, from where it is on screen.
 *
 * The rule the piece is written to: loudest through the middle of the frame,
 * quieter toward the top and bottom, and silent the moment the last of its
 * pixels has gone. So the level is the taper multiplied by how much of the
 * object is actually inside the frame — which reaches zero exactly as the
 * object clears it, rather than at some margin chosen by hand.
 *
 * All of it is read off where the thing is on screen and none of it off which
 * way the field is going, so aiming the field needs no second version of this:
 * turn the travel sideways and objects fade up out of the left edge already
 * panned hard left, and the vertical taper still says which of them is nearest
 * the middle of the frame. The sound is a readout of the picture, and it stays
 * one at every bearing.
 */
function mixFor(o) {
  const depth = -o.z;
  const rWorld = o.scale;                       // every build is a unit sphere
  const rY = rWorld / (depth * TAN);
  const rX = rY / camera.aspect;
  const ndcY = o.y / (depth * TAN);
  const ndcX = o.x / (depth * TAN * camera.aspect);

  const visY = (Math.min(ndcY + rY, 1) - Math.max(ndcY - rY, -1)) / (2 * rY);
  const visX = (Math.min(ndcX + rX, 1) - Math.max(ndcX - rX, -1)) / (2 * rX);
  if (visY <= 0 || visX <= 0) return null;

  const centered = Math.cos(Math.max(-1, Math.min(1, ndcY)) * Math.PI * 0.5);
  const base = 0.14 + 0.86 * Math.pow(centered, 1.4);
  // Something in the far band is further away, and should sound it.
  const near = Math.min(1, DEPTHS[0] / depth);
  const gain = base * Math.min(1, visY) * Math.min(1, visX) * near * 0.5;
  const pan = Math.max(-1, Math.min(1, ndcX)) * 0.85;
  return { gain, pan };
}

// The mix moves at 20Hz rather than every frame. A field of twenty voices means
// forty parameter writes a frame at 60Hz, and the ear cannot tell: each write is
// a short ramp, so what it hears is a continuous move either way.
const MIX_HZ = 20;
let mixAt = 0;

function updateMix(t) {
  if (t < mixAt) return;
  mixAt = t + 1 / MIX_HZ;
  const live = audioLive();
  for (const c of field) {
    for (const o of c.objs) {
      const m = live ? mixFor(o) : null;
      if (!m) { releaseVoice(o); continue; }
      if (!o.voice) o.voice = makeVoice(o.voiceName, o.note, o.voiceSeed);
      if (o.voice) setVoiceMix(o.voice, m.gain, m.pan);
    }
  }
}

// -------------------------------------------------------------------- the ride
const _euler = new THREE.Euler();

function updateObject(o, t, dt) {
  const step = rowStep();

  o.v += SPEED_BASE * cfg.speed * dt;
  // Out of the frame at the leading end, with the last of it gone: thrown away
  // and dealt again at the back of its own column, exactly one column-length
  // down, so the lattice survives something leaving it.
  const end = halfTAt(-o.z) + MARGIN;
  if (o.v > end) {
    o.v -= o.col.span;
    // A new slot deserves a new nudge, or the field slowly memorizes itself.
    o.jx = (rng() - 0.5) * 0.34;
    o.jz = (rng() - 0.5) * 1.5;
    o.z = -(o.col.depth + o.jz);
    const halfU = halfUAt(o.col.depth);
    o.u = o.col.ndcU * halfU * 1.04 + o.jx * (2 * halfU) / field.length;
    deal(o, rng);
  }
  place(o);

  // Scale. Objects further back are made a little larger in world terms so the
  // far band is legible without flattening the depth away entirely.
  let s = o.baseScale * Math.pow(-o.z / DEPTHS[0], 0.55);
  if (o.breathe) s *= 1 + o.breatheAmp * Math.sin(t * o.breatheRate * Math.PI * 2 + o.breathePhase);
  o.scale = s;

  // Attitude. The stutter replaces the pose outright rather than adding to it:
  // added, it would creep, and creeping is exactly what a thing that is stuck
  // must not do.
  if (o.glitch) {
    const tick = Math.floor(t * GLITCH_HZ);
    if (tick !== o.snapTick && (tick + o.glitchOffset) % o.glitchEvery === 0) {
      o.snapTick = tick;
      o.snapEuler.set(
        Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2,
      );
      o.snapFlash = 1;
    }
    o.snapFlash = Math.max(0, o.snapFlash - dt * 6);
    _euler.copy(o.snapEuler);
  } else {
    o.angle += dt;
    _euler.set(
      o.tiltX + (o.tumble && o.tumbleAxis === 'x' ? o.angle * o.tumbleRate : 0),
      o.face + (o.spin ? o.angle * o.spinRate : 0),
      o.tiltZ + (o.tumble && o.tumbleAxis === 'z' ? o.angle * o.tumbleRate : 0),
    );
  }

  o.mesh.position.set(o.x, o.y, o.z);
  o.mesh.rotation.copy(_euler);
  o.mesh.scale.setScalar(o.scale);

  if (o.hue) {
    o.hueShift = t * o.hueRate;
    applyLook(o);
  }

  // The double, dragged off and shown only mid-stutter. Taken from the pose the
  // object has just landed in, so it reads as a smear of the same thing rather
  // than as a second object standing nearby.
  const flashing = o.glitch && o.snapFlash > 0.02;
  o.ghost.visible = flashing;
  if (flashing) {
    o.ghost.position.set(
      o.x + o.ghostOff.x * o.scale,
      o.y + o.ghostOff.y * o.scale,
      o.z + o.ghostOff.z * o.scale,
    );
    o.ghost.rotation.copy(_euler);
    o.ghost.scale.setScalar(o.scale);
    o.ghost.material.opacity = o.snapFlash * (0.35 + Math.random() * 0.25);
  }
}

// -------------------------------------------------------------------- the loop
const clock = new THREE.Clock();
let t = 0;
let paused = false;

function animate() {
  requestAnimationFrame(animate);
  const raw = clock.getDelta();
  // A tab that has been in the background comes back with a delta measured in
  // seconds, which would teleport the whole field. Clamped, it simply resumes.
  const dt = paused ? 0 : Math.min(raw, 0.1);
  t += dt;
  if (!paused) {
    scrolled += SPEED_BASE * cfg.speed * dt;
    for (const c of field) for (const o of c.objs) updateObject(o, t, dt);
  }
  updateMix(t);
  renderer.render(scene, camera);
}

// -------------------------------------------------------------------- resizing
let lastCols = 0;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const cols = columnCount();
  // A phone hiding and showing its URL bar fires resize constantly. Only a
  // change in how many columns fit is worth re-spacing the field for; anything
  // else just slides the columns to where the new frame wants them. Either way
  // the field survives: turning a phone on its side rearranges the lattice, it
  // does not empty the room.
  if (cols !== lastCols) {
    lastCols = cols;
    respace();
  } else {
    placeColumns();
  }
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------- the header
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

const pauseBtn = document.getElementById('pause-btn');
const saveBtn = document.getElementById('save-btn');
const loadBtn = document.getElementById('load-btn');

function setPaused(on) {
  paused = on;
  pauseBtn.textContent = on ? 'Play' : 'Pause';
  pauseBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
pauseBtn.addEventListener('click', () => setPaused(!paused));

// The header slider is the only thing that starts the sound, and the only thing
// that sets its level. onGesture fires on pointerup, never pointerdown — iOS
// grants audio on a gesture that finished.
window.HeaderVolume.onGesture(startAudio);
window.HeaderVolume.onChange((gain) => setVolume(gain));

// --------------------------------------------------------------- save and load
const num = (v, p = 3) => Number(v.toFixed(p));

/** Everything needed to put this exact frame back up. */
function sceneSnapshot() {
  return {
    app: 'object-tile-scroll',
    // 2 renamed the columns' screen fraction from ndcX to ndcU: it is measured
    // across the travel now, and the travel is not always across the screen.
    version: 2,
    seed: RUN_SEED,
    t: num(t, 3),
    scrolled: num(scrolled, 3),
    settings: { ...cfg },
    aspect: num(camera.aspect, 4),
    columns: field.map((c) => ({
      ndcU: num(c.ndcU, 4), depth: c.depth, rows: c.rows, span: num(c.span, 3), phase: c.phase,
      objs: c.objs.map((o) => ({
        kind: KINDS[o.kindIdx].name,
        finish: FINISHES[o.finishIdx].name,
        // The base color and the drift, not the color on screen: an object with
        // several groups has several colors, and all of them follow from these
        // two. Saving what was rendered would save one of the answers instead of
        // the question.
        color: '#' + new THREE.Color(o.baseHex).getHexString(),
        hueShift: num(o.hueShift, 4),
        at: [num(o.x), num(o.y), num(o.z)],
        rot: [num(o.mesh.rotation.x, 4), num(o.mesh.rotation.y, 4), num(o.mesh.rotation.z, 4)],
        scale: num(o.scale, 4),
        baseScale: num(o.baseScale, 4),
        note: num(o.note, 2),
        does: [o.spin && 'spin', o.tumble && 'tumble', o.glitch && 'glitch',
          o.breathe && 'breathe', o.hue && 'hue'].filter(Boolean),
      })),
    })),
  };
}

const FINISH_BY_NAME = new Map(FINISHES.map((f, i) => [f.name, i]));

/**
 * Put a saved frame back. The columns come from the file rather than from the
 * window, so a frame saved on a wide screen opens as itself on a narrow one and
 * is simply cropped — which is the honest thing, and what makes an A/B of two
 * renders an A/B of one picture. The next resize hands the field back to the
 * window it is actually in.
 */
function loadSceneSnapshot(data) {
  if (!data || data.app !== 'object-tile-scroll' || !Array.isArray(data.columns)) {
    throw new Error('not an Object Tile Scroll scene');
  }
  for (const c of field) for (const o of c.objs) disposeObject(o);
  field.length = 0;

  if (data.settings) {
    for (const k of ['speed', 'spacing', 'odd']) {
      if (typeof data.settings[k] === 'number') cfg[k] = data.settings[k];
    }
    // A file written before the field could be aimed is a file of a field going
    // straight up, whatever the angle happens to be set to now.
    cfg.angle = typeof data.settings.angle === 'number' ? data.settings.angle : 0;
    syncControls();
    // A file you opened is where you are now, so it is what you come back to.
    saveSettings();
  }
  // Before anything is placed: every position in the file is a world position,
  // and it takes the bearing to read one back as a place in the lattice.
  aimField();
  t = data.t || 0;
  scrolled = data.scrolled || 0;

  for (const cs of data.columns) {
    const column = {
      ndcU: cs.ndcU ?? cs.ndcX, depth: cs.depth, rows: cs.rows, span: cs.span,
      phase: cs.phase || 0, objs: [],
    };
    field.push(column);
    for (const os of cs.objs || []) {
      const o = makeObject(column, rng);
      // An imported model that has not landed yet cannot be put back, so the
      // slot falls back to the first build rather than to nothing. A file saved
      // and reopened once the models are in is exact.
      setKind(o, KIND_BY_NAME.get(os.kind) ?? 0);
      o.finishIdx = FINISH_BY_NAME.get(os.finish) ?? 0;
      o.baseHex = new THREE.Color(os.color).getHex();
      o.hueShift = os.hueShift || 0;
      applyLook(o);
      o.x = os.at[0]; o.y = os.at[1]; o.z = os.at[2];
      // The lattice coordinates the file does not carry, read back off the world
      // ones: the two axes are a rotation, so this is exact and the first frame
      // after a load puts every object back exactly where the file left it.
      o.u = o.x * NX + o.y * NY;
      o.v = o.x * TX + o.y * TY;
      o.baseScale = os.baseScale;
      o.scale = os.scale;
      o.note = os.note;
      const does = new Set(os.does || []);
      o.spin = does.has('spin'); o.tumble = does.has('tumble');
      o.glitch = does.has('glitch'); o.breathe = does.has('breathe'); o.hue = does.has('hue');
      o.voiceName = KINDS[o.kindIdx].voice;
      // Straight to the pose in the file: everything else about the object is a
      // rule for how it got there, and a saved frame is a picture, not a rule.
      o.mesh.position.set(o.x, o.y, o.z);
      o.mesh.rotation.set(os.rot[0], os.rot[1], os.rot[2]);
      o.mesh.scale.setScalar(o.scale);
      o.snapEuler.set(os.rot[0], os.rot[1], os.rot[2]);
      column.objs.push(o);
    }
  }

  lastCols = field.length;
  setPaused(true);
  renderer.render(scene, camera);
}
// Reachable from the harness, which drives the app through the DOM everywhere
// else but has no way to hand it a file it did not build first.
window.sceneSnapshot = sceneSnapshot;
window.loadSceneSnapshot = loadSceneSnapshot;
/** A count of what is actually in frame, for the harness and for the console. */
window.fieldStats = () => {
  let objs = 0;
  for (const c of field) objs += c.objs.length;
  const inPlay = {};
  for (const c of field) for (const o of c.objs) {
    const n = KINDS[o.kindIdx].name;
    inPlay[n] = (inPlay[n] || 0) + 1;
  }
  return {
    columns: field.length, objs, onScreen: onScreenNow(), voices: voiceCount(),
    kinds: KINDS.length, inPlay, seed: RUN_SEED,
  };
};

function stamp() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

saveBtn.addEventListener('click', () => {
  const data = sceneSnapshot();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `object-tile-scroll-${stamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  const n = data.columns.reduce((s, c) => s + c.objs.length, 0);
  toast(`Field saved, ${n} object${n === 1 ? '' : 's'}`);
});

// Kept out of the markup because nothing on the page should be able to focus it,
// and given an id anyway so a headless harness can put a file into it.
const sceneFile = document.createElement('input');
sceneFile.type = 'file';
sceneFile.id = 'scene-file';
sceneFile.accept = 'application/json,.json';
sceneFile.hidden = true;
document.body.appendChild(sceneFile);

loadBtn.addEventListener('click', () => sceneFile.click());
sceneFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  // Cleared straight away, or picking the same file twice fires no change event
  // and the second load silently does nothing.
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadSceneSnapshot(JSON.parse(reader.result));
      toast('Field loaded, held');
    } catch {
      toast('Not an Object Tile Scroll field');
    }
  };
  reader.onerror = () => toast('That file could not be read');
  reader.readAsText(file);
});

// ------------------------------------------------------------- settings sheet
const menuBtn = document.getElementById('menu-btn');
const closeBtn = document.getElementById('close-btn');
const doneBtn = document.getElementById('done-btn');
const scrim = document.getElementById('scrim');

function openMenu() {
  scrim.hidden = false;
  document.body.classList.add('menu-open');
  menuBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  scrim.hidden = true;
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', openMenu);
closeBtn.addEventListener('click', closeMenu);
doneBtn.addEventListener('click', closeMenu);
scrim.addEventListener('click', (e) => { if (e.target === scrim) closeMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

const speedEl = document.getElementById('speed');
const speedVal = document.getElementById('speed-val');
const angleEl = document.getElementById('angle');
const angleVal = document.getElementById('angle-val');
const spacingEl = document.getElementById('spacing');
const spacingVal = document.getElementById('spacing-val');
const oddEl = document.getElementById('odd');
const oddVal = document.getElementById('odd-val');

/**
 * How many objects are in frame right now. Counted rather than worked out from
 * the lattice: the arithmetic version divided the frustum by the row step and
 * came out a third low, because the rows hanging half off the top and bottom
 * are on screen and are exactly the ones a formula like that drops.
 */
function onScreenNow() {
  let n = 0;
  for (const c of field) for (const o of c.objs) if (mixFor(o)) n++;
  return n;
}

// The four bearings that have a word for them get the word as well as the
// number. Everything in between is a number, because "37 degrees up and a bit
// right" is not a thing anybody says.
const BEARINGS = { 0: 'up', 90: 'right', 180: 'down', 270: 'left' };

function paintReadouts() {
  speedVal.textContent = `${cfg.speed.toFixed(1)}×`;
  const deg = Math.round(cfg.angle);
  angleVal.textContent = `${deg}°${BEARINGS[deg] ? ' ' + BEARINGS[deg] : ''}`;
  spacingVal.textContent = `${onScreenNow()} on screen`;
  oddVal.textContent = `${Math.round(cfg.odd * 100)}%`;
}

speedEl.addEventListener('input', () => {
  cfg.speed = speedEl.valueAsNumber / 100;
  paintReadouts();
  saveSettings();
});
// Aiming the field only ever re-points the lattice under the objects: the whole
// picture turns as the slider moves, and nothing is dealt, dropped or re-spaced
// on the way — not while dragging and not on release either. Letting go of a
// slider should confirm what you were watching, not settle it into something
// else. The columns keep the count they had, so the field packs a little closer
// as the travel turns toward the short side of the frame, and opens back out on
// the way round; that is the picture rotating, which is the whole idea.
angleEl.addEventListener('input', () => {
  cfg.angle = angleEl.valueAsNumber;
  aimField();
  growColumns();     // reach the far corners before they can show as a gap
  placeColumns();
  paintReadouts();
  saveSettings();
});
spacingEl.addEventListener('input', () => {
  cfg.spacing = spacingEl.valueAsNumber / 100;
  // Spacing changes how many slots a column holds and how far apart they are.
  // The field takes both without being dealt again: it opens out or draws in
  // around what is already standing in it, and only the objects at the ends of
  // the columns — behind the frame, out of sight — come and go.
  lastCols = columnCount();
  respace();
  paintReadouts();
  saveSettings();
});
oddEl.addEventListener('input', () => {
  cfg.odd = oddEl.valueAsNumber / 100;
  paintReadouts();
  saveSettings();
  // Applies to what is dealt next, not to what is standing: reaching into the
  // field and re-rolling everybody's habits mid-frame reads as a glitch in the
  // piece rather than as a setting.
});

// ------------------------------------------------------- the settings, kept
// Every setting, with the control that shows it and what a cfg value is
// multiplied by to get there — one place that knows a speed of 1.0 is a slider
// at 100 — plus the band it is rolled in on a first visit.
//
// The bands are narrower than the sliders on purpose. A slider goes as far as it
// goes because somebody deliberate should be able to take it there; an opening
// nobody asked for should be a version of the piece, not an extreme of it. So a
// first visit can arrive at any bearing at all, but never at a blur or a frozen
// frame or an empty room.
const CONTROLS = [
  { key: 'speed', el: speedEl, per: 100, roll: [65, 160] },
  { key: 'angle', el: angleEl, per: 1, roll: [0, 359] },
  { key: 'spacing', el: spacingEl, per: 100, roll: [80, 135] },
  { key: 'odd', el: oddEl, per: 100, roll: [30, 80] },
];

const SETTINGS_KEY = 'object-tile-scroll:settings';

/** Push cfg back out to the controls, after a file or a first visit set it. */
function syncControls() {
  for (const c of CONTROLS) c.el.value = String(Math.round(cfg[c.key] * c.per));
  paintReadouts();
}

// Dragging a slider fires input continuously and every one of those would be a
// synchronous write. The setting that matters is the one the drag ends on.
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const c of CONTROLS) out[c.key] = cfg[c.key];
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch { /* private window */ }
  }, 250);
}

/** A number that control could actually be set to: in range, and on its step. */
function onSlider(el, v) {
  if (!Number.isFinite(v)) return null;
  const lo = Number(el.min), hi = Number(el.max), step = Number(el.step) || 1;
  return lo + Math.round((Math.min(hi, Math.max(lo, v)) - lo) / step) * step;
}

/**
 * How the piece opens.
 *
 * A first visit is rolled rather than handed the defaults. The field is
 * generative and these are part of what it generates: a gallery where every
 * visitor is shown the same speed, the same bearing and the same spacing is a
 * gallery showing one picture. After that the roll is written down and it is
 * theirs — what you come back to is what you left, including anything you
 * changed while you were here.
 *
 * The roll is drawn off its own generator rather than the field's, so a seed in
 * the URL still means exactly one field whether or not this browser has been
 * here before. And a seed asked for by name takes the settings that go with it:
 * it is a request for a particular piece, and half of that piece is here.
 */
function openingSettings() {
  let saved = null;
  if (SEED_PARAM === null) {
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { saved = null; }
  }

  if (saved && typeof saved === 'object') {
    for (const c of CONTROLS) {
      // typeof, not just arithmetic: null and '' and false all multiply to 0,
      // which is a real slider position, so a key that has gone missing would
      // come back as that control pinned to its minimum rather than left alone.
      const raw = saved[c.key];
      const v = typeof raw === 'number' ? onSlider(c.el, Math.round(raw * c.per)) : null;
      cfg[c.key] = v === null ? DEFAULTS[c.key] : v / c.per;
    }
    return;
  }

  const roll = makeRng(RUN_SEED ^ 0x5eed);
  for (const c of CONTROLS) {
    const step = Number(c.el.step) || 1;
    const [lo, hi] = c.roll;
    cfg[c.key] = (lo + Math.floor(roll() * (Math.floor((hi - lo) / step) + 1)) * step) / c.per;
  }
  saveSettings();   // the piece they were shown is the piece they come back to
}

// ----------------------------------------------------------------------- start
lastCols = 0;
openingSettings();
aimField();
resize();
syncControls();
animate();

// ------------------------------------------------------------ the imported set
// Everything above this line is built out of boxes and cylinders in this file.
// Everything below is a model somebody else made: Kenney's Furniture Kit and
// Food Kit, both CC0, trimmed to the things that are unmistakable at a glance
// with no texture on them. See models/CREDITS.md.
//
// They are fetched AFTER the field is already running and dealt in as they
// arrive, which is deliberate: the piece opens instantly on the hand-built set
// and quietly gets stranger over the next second, rather than showing a loading
// screen for 400KB. An object already on screen is left alone; the models only
// affect what is dealt next, which is the same rule every setting here follows.
//
// Weights are low on purpose. A television twice a minute is a surprise; a
// television every fourth slot is a piece about televisions. Chairs stay the
// most common thing in the field by a wide margin, because the recurring motif
// is what makes the rest read as a departure.
const MODELS = [
  // Kenney Furniture Kit
  { file: 'televisionModern', name: 'television', voice: 'hum' },
  { file: 'kitchenFridge', name: 'fridge', voice: 'hum' },
  { file: 'washer', name: 'washing machine', voice: 'hum' },
  { file: 'kitchenMicrowave', name: 'microwave', voice: 'hum' },
  { file: 'kitchenStove', name: 'stove', voice: 'hum' },
  { file: 'toaster', name: 'toaster', voice: 'hum' },
  { file: 'kitchenBlender', name: 'blender', voice: 'hum' },
  { file: 'laptop', name: 'laptop', voice: 'hum' },
  { file: 'radio', name: 'radio', voice: 'hum' },
  { file: 'lampRoundFloor', name: 'floor lamp', voice: 'hum' },
  { file: 'ceilingFan', name: 'ceiling fan', voice: 'steam' },
  { file: 'toilet', name: 'toilet', voice: 'ring' },
  { file: 'bathtub', name: 'bathtub', voice: 'ring' },
  { file: 'trashcan', name: 'trash can', voice: 'ring' },
  { file: 'pottedPlant', name: 'potted plant', voice: 'wood' },
  { file: 'coatRackStanding', name: 'coat rack', voice: 'wood' },
  { file: 'loungeSofa', name: 'sofa', voice: 'wood' },
  { file: 'bedSingle', name: 'bed', voice: 'wood' },
  // Kenney Food Kit
  { file: 'mug', name: 'mug', voice: 'ring' },
  { file: 'cup-coffee', name: 'coffee cup', voice: 'steam' },
  { file: 'frying-pan', name: 'frying pan', voice: 'ring' },
  { file: 'banana', name: 'banana', voice: 'wood' },
  // Quaternius, Ultimate Home Interior. Shipped as OBJ+MTL and converted to GLB
  // by tools/obj2glb.mjs, so everything here loads down the one path.
  //
  // The three chairs carry a chair's weight rather than a model's: they are the
  // motif, not a departure from it, and they are what keeps a chair coming round
  // about a third of the time as the set grows.
  { file: 'Chair_1', name: 'kitchen chair', voice: 'wood', weight: 1.6 },
  { file: 'Chair_3', name: 'spindle chair', voice: 'wood', weight: 1.6 },
  { file: 'Chair_4', name: 'slat chair', voice: 'wood', weight: 1.6 },
  { file: 'Table_RoundSmall', name: 'round table', voice: 'wood' },
  { file: 'Table_RoundLarge', name: 'dining table', voice: 'wood' },
  { file: 'Bookshelf', name: 'bookshelf', voice: 'wood' },
  { file: 'Drawer_3', name: 'chest of drawers', voice: 'wood' },
  { file: 'NightStand_2', name: 'nightstand', voice: 'wood' },
  { file: 'Bed_Bunk', name: 'bunk bed', voice: 'wood' },
  { file: 'Door_2', name: 'door', voice: 'wood' },
  { file: 'Houseplant_5', name: 'spider plant', voice: 'wood' },
  { file: 'Fireplace', name: 'fireplace', voice: 'ring' },
  { file: 'Bathroom_Sink', name: 'sink', voice: 'ring' },
  { file: 'Kitchen_Sink', name: 'kitchen sink', voice: 'ring' },
  { file: 'Bathroom_Mirror1', name: 'mirror', voice: 'ring' },
  { file: 'Bathroom_ToiletPaper', name: 'toilet roll', voice: 'wood' },
  { file: 'Light_Chandelier', name: 'chandelier', voice: 'hum' },
  { file: 'Light_Ceiling3', name: 'pendant lights', voice: 'hum' },
  { file: 'Light_Floor3', name: 'table lamp', voice: 'hum' },
  // Quaternius, Ultimate Furniture. Converted with --flat: this is the one pack
  // that ships partly smooth-shaded, and faceting it is not a compromise made
  // for the file size, it is what puts these in the same world as everything
  // else here. Four models, because they are the only four that are not another
  // version of something the set already has.
  { file: 'Chair', name: 'bentwood chair', voice: 'wood', weight: 1.2 },
  { file: 'OfficeChair', name: 'office chair', voice: 'wood', weight: 1.2 },
  { file: 'Desk', name: 'desk', voice: 'wood' },
  { file: 'Closet', name: 'wardrobe', voice: 'wood' },
  // Quaternius, Ultimate Food. This pack is what the Kenney Food Kit could not
  // be: several flat-color groups per model instead of one material and a
  // texture atlas, so a cheeseburger arrives with its own layers and a donut
  // with its own sprinkles, and both still take the finish. Kenney's plain donut
  // and burger are dropped rather than kept alongside — two donuts in a deck is
  // not variety, it is a repeat.
  { file: 'Cheeseburger', name: 'cheeseburger', voice: 'wood' },
  { file: 'Donut1', name: 'donut', voice: 'wood' },
  { file: 'Cupcake', name: 'cupcake', voice: 'wood' },
  { file: 'Croissant', name: 'croissant', voice: 'wood' },
  { file: 'IceCream_1', name: 'ice cream', voice: 'wood' },
  { file: 'Apple', name: 'apple', voice: 'wood' },
  { file: 'Carrot', name: 'carrot', voice: 'wood' },
  { file: 'Broccoli', name: 'broccoli', voice: 'wood' },
  { file: 'Eggplant', name: 'eggplant', voice: 'wood' },
  { file: 'Pumpkin', name: 'pumpkin', voice: 'wood' },
  // Hot food gets the steam voice, which is the one place in the mix where what
  // a thing IS decides how it sounds rather than what it is made of.
  { file: 'Hotdog', name: 'hot dog', voice: 'steam' },
  { file: 'Corndog', name: 'corn dog', voice: 'steam' },
  { file: 'Fries', name: 'fries', voice: 'steam' },
  { file: 'Pancakes_Stack', name: 'pancakes', voice: 'steam' },
  { file: 'CookingPot', name: 'cooking pot', voice: 'steam' },
  { file: 'Soda', name: 'soda cup', voice: 'ring' },
  { file: 'KetchupBottle', name: 'ketchup bottle', voice: 'ring' },
];
const MODEL_WEIGHT = 0.7;

/**
 * Turn a loaded glTF scene into one geometry with one group per material, and
 * the list of colors those groups had.
 *
 * The models are used for their shape and their color RELATIONSHIPS only, never
 * their materials: this piece decides what an object is made of, and a model
 * that brought its own finish along could not take part in the color habit. UVs
 * and tangents go with them — nothing here is textured, and leaving a stray
 * attribute on one primitive is what makes a merge return null.
 */
function bakeModel(root) {
  const byMaterial = new Map();
  root.updateWorldMatrix(true, true);
  root.traverse((n) => {
    if (!n.isMesh || !n.geometry) return;
    const g = n.geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    g.applyMatrix4(n.matrixWorld);
    // A model converted with obj2glb --flat ships positions only, three per
    // triangle and unindexed, so this produces exactly the face normals it left
    // behind — at a bit under half the bytes. On indexed geometry the same call
    // would average them into smooth normals, which is why the converter drops
    // the index buffer rather than just the normals.
    if (!g.attributes.normal) g.computeVertexNormals();
    // GLTFLoader gives a mesh one material per primitive, so a mesh is one color.
    const mat = Array.isArray(n.material) ? n.material[0] : n.material;
    const key = mat ? mat.uuid : 'none';
    if (!byMaterial.has(key)) byMaterial.set(key, { color: mat && mat.color ? mat.color.clone() : new THREE.Color(0xffffff), parts: [] });
    byMaterial.get(key).parts.push(g);
  });
  if (!byMaterial.size) return null;

  const merged = [];
  const colors = [];
  for (const { color, parts } of byMaterial.values()) {
    const g = parts.length === 1 ? parts[0] : mergeGeometries(parts);
    if (!g) continue;
    // Biggest group first, so addKind measures every other color against the one
    // that actually reads as the object's color.
    merged.push({ g, color, n: g.attributes.position.count });
  }
  if (!merged.length) return null;
  merged.sort((a, b) => b.n - a.n);
  for (const m of merged) colors.push(m.color);
  const geometry = merged.length === 1
    ? merged[0].g
    : mergeGeometries(merged.map((m) => m.g), true);
  return geometry ? { geometry, colors } : null;
}

{
  // The food models point at a shared texture atlas this piece does not want and
  // will not use. Rather than ship 200KB of it to be thrown away, every image
  // request is answered with a single transparent pixel — which keeps the
  // console clean instead of showing 404s on load.
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (/\.(png|jpe?g|webp)$/i.test(url) ? BLANK : url));
  const loader = new GLTFLoader(manager);

  /**
   * Fetch one model and inflate it here rather than leaving it to the server.
   *
   * glTF is mostly float arrays and gzips to about a quarter of its size, but
   * GitHub Pages only compresses text and JavaScript — a .glb goes out at full
   * size and there is no header we can set to change that. So the models are
   * stored compressed (tools/gzip-models.mjs) and unpacked in the page: the same
   * seventy objects arrive in about 0.4MB instead of about 1.5MB.
   *
   * The file is `.glbz` rather than `.glb.gz` on purpose. A server that sees
   * `.gz` decides the file is transport-compressed and sets Content-Encoding —
   * Vite's dev server does — so the browser quietly inflates it and the inflate
   * below then chokes on plain bytes. Under a name nothing recognizes, the page
   * is the only thing that unpacks it, in dev and in production alike.
   *
   * The magic number is checked anyway, so this works whichever way the file
   * arrives. Two bytes of paranoia for a class of bug that only shows up after
   * deploying.
   *
   * DecompressionStream costs nothing in reach: this page already needs import
   * maps, which is the same Safari 16.4 floor.
   */
  async function fetchModel(file) {
    const res = await fetch(`./models/${file}.glbz`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (head[0] === 0x1f && head[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') throw new Error('no DecompressionStream');
      buf = await new Response(
        new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer();
    }
    // parse() rather than load(), because the bytes are already here. The second
    // argument is the base the file's own references resolve against, which the
    // Kenney food models still need for the atlas the manager then swaps out.
    return new Promise((resolve, reject) => loader.parse(buf, './models/', resolve, reject));
  }

  // Every model is optional by design, so anything that cannot be loaded costs
  // the field that one build and nothing else. Reported once with a count rather
  // than sixty-two times, because the interesting failure is all of them.
  let failed = 0;
  let firstError = '';
  let report = null;
  for (const m of MODELS) {
    fetchModel(m.file).then((gltf) => {
      const baked = bakeModel(gltf.scene);
      if (!baked) return;
      addKind({
        name: m.name,
        weight: m.weight || MODEL_WEIGHT,
        voice: m.voice,
        geometry: baked.geometry,
        srcColors: baked.colors,
      });
    }).catch((e) => {
      if (!failed++) firstError = `${m.file}: ${e.message}`;
      clearTimeout(report);
      report = setTimeout(() => {
        console.warn(`object-tile-scroll: ${failed} of ${MODELS.length} models did not load (${firstError})`);
      }, 400);
    });
  }
}
