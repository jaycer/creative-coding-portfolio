// Object Tile Scroll — everyday things, tiled across the dark, drifting upward.
//
// The camera never moves and neither does anything else, in the sense that
// matters: an object is planted at a spot in a lattice and rides straight out
// of the frame the way the whole field is going — up, by default, and any
// bearing the Angle slider is set to. It never wanders, never crosses another,
// never comes back. What it does IN that spot is the whole piece — some spin flat,
// some tumble end over end, some stutter into a new attitude and stay wrong,
// some drift through colors, and a good share just stand there, which is what
// makes the rest read as odd.
//
// Breathing sits apart from those. It is the one habit the field can do
// TOGETHER — in step, in opposition, or as a swell running up through the
// picture — and it can be handed a clock from outside: with Follow the room on,
// the microphone finds the beat of whatever is playing nearby and the field
// breathes to it, and the stutterers land on it.
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
// The set is seventy-one things. The chairs come from the other chair pieces in
// this gallery and the iron, dumbbell and desk lamp are built here out of boxes
// and cylinders; the rest of the household is Kenney's CC0 models, loaded after
// the field is already running. One of them is a rubber pig off a shelf, scanned
// with a phone. See models/CREDITS.md, and the bottom of this file for how a
// model becomes a build.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  startAudio, setVolume, audioLive, audioContext, setMuted, makeVoice, setVoiceMix,
  stopVoice, pitchFor, voiceCount,
} from './audio.js';
import {
  startListening, stopListening, listenState, inputName, inputChoices,
  currentInputId, useInput,
} from '../shared/listen.js';

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

// `?only=rubber pig` fills the whole field with one build and deals nothing
// else. It is for looking at a single object across the finishes and habits the
// piece will actually give it, which is a different question from looking at it
// alone in the panel at the bottom of this file — a field of seventy of one
// thing shows you how it reads small, in motion, in a color you did not choose.
//
// Every other kind is still built and still in KINDS, it is simply never picked,
// so nothing downstream has to cope with a deck of one.
const ONLY = new URLSearchParams(location.search).get('only');
// The hand-built kinds are added while this file is still being evaluated, long
// before there is a field to re-deal. This says when there is one.
let fieldReady = false;

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
  // With ONLY set, anything that is not the one being looked at is added at no
  // weight, so pickKind can never reach it.
  if (ONLY && name !== ONLY) weight = 0;
  KIND_BY_NAME.set(name, KINDS.length);
  KINDS.push({ name, weight, voice, geometry: normalize(geometry), groups });
  totalWeight += weight;
  // And when the one being looked at arrives — the models load after the field
  // is already running — throw the field away and deal it again, rather than
  // waiting for sixty chairs to scroll off the top.
  if (ONLY && name === ONLY && fieldReady) {
    for (const c of field) for (const o of c.objs) disposeObject(o);
    field.length = 0;
    lastCols = 0;
    resize();
  }
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
  // Translucent matte — the milky resin a bath toy is moulded from, and the one
  // finish here the deck can claim by descent: the rubber pig really is this
  // material, and its translucency is why that scan came out soft to begin with.
  //
  // Built out of a small `glow` rather than out of transmission, which was the
  // obvious route and the wrong one. Real transmission shows what is BEHIND the
  // object, and what is behind everything in this piece is a near-black room —
  // tried at 0.72 and the back rank turned into silhouettes, which is precisely
  // what the luminance floor on every other swatch exists to prevent. It also
  // costs a whole extra pass over the scene every frame, which an ambient piece
  // can least afford.
  //
  // What makes a milky object read as milky in a dark room is not the wall
  // coming through it. It is light entering the surface, bouncing about inside,
  // and leaving again toward the eye — and there is no wall in that description.
  // A low emissive is that light, and it holds up at the back of the room where
  // transmission gave up. Well under neon's, which is a thing making light
  // rather than a thing that has been lit.
  //
  // Roughness is the matte half. Colours pale for the same reason as the glow: a
  // dark swatch has almost nothing to scatter.
  { name: 'resin', colors: [0xf0c6bb, 0xbdd9e6, 0xefdcb0, 0xcfe0cd, 0xdcc8e0], rough: 0.62, metal: 0, glow: 0.2 },
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
// breathRate is in breaths per SECOND, like every other rate in here; the slider
// that sets it is marked in breaths per minute, because that is the number a
// person can picture.
const DEFAULTS = {
  speed: 1.0, spacing: 1.0, odd: 0.55, angle: 0,
  breath: 0.4, breathRate: 0.35, breathDepth: 0.38, breathSync: 'scattered',
};
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


// Breathing is not in here. It used to be — one of the odd habits, dealt to a
// fifth of the objects that got any habit at all — and it was moved out because
// it is the one habit that wants to be shared. A field where a fixed share of
// the objects happen to be swelling is a field of objects doing their own
// thing; a field where you can say HOW MANY breathe, how fast, how deep and
// whether they agree with each other is a different instrument. So the share of
// breathers is its own setting, breathing rides on top of whatever else an
// object is doing, and everything below is about attitude and color only.
const PRIMARIES = [
  ['spin', 0.26],      // flat, about its own vertical axis
  ['tumble', 0.20],    // end over end
  ['glitch', 0.16],    // thrown into a new attitude and left there
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

// ------------------------------------------------------------------ the breath
// Every breathing object swells and shrinks on a sine. What differs between the
// patterns is only where each one reads its phase from, so all four are the same
// three lines with a different offset, and any of them can be handed the room's
// beat instead of the field's own clock without knowing that happened.
//
// Both clocks below are ACCUMULATED rather than worked out from the elapsed
// time. `t * rate` is shorter and wrong for a piece with a rate slider on it:
// halve the rate at t = 300 and every breathing object in the frame is instantly
// somewhere else in its cycle. Adding up the steps means a rate change bends the
// breathing from wherever it had got to, which is what changing a rate should
// look like — and is the same rule the rest of the settings here follow.
const TAU = Math.PI * 2;
let breathClock = 0;   // the shared breath, in radians
let breathOwnT = 0;    // how far the private clocks have run, before each one's own pace

// Depth is the one breathing setting that is a size rather than a speed, so it
// is the one that can be seen to jump: an object at the top of its breath, given
// a deeper one, is instantly bigger. Dragged, that never shows — every step is a
// percent. Clicked halfway along the track, which is a perfectly ordinary way to
// use a slider, it is a snap across every breathing thing in the frame. So the
// number the field actually uses chases the number the slider is on.
const DEPTH_FOLLOW = 0.22;   // seconds
let depthNow = DEFAULTS.breathDepth;

// How many rows apart two objects are breathing a whole cycle out of step, in
// WAVE. Six is about a screen and a half at the default spacing: long enough to
// read as one swell travelling through the field rather than as stripes.
const WAVE_ROWS = 6;

// A pattern change would otherwise jump every object to a new place in its
// cycle at once, which is a flinch across the whole frame. Instead each object
// keeps the difference between where it was and where the new pattern puts it,
// and that difference is walked off over a few seconds: the field slides into
// formation, which is a better answer to "synchronized" than arriving there
// already synchronized.
const ALIGN_FALL = 2.6;   // seconds to shed most of the difference
const GAIN_RISE = 0.7;    // seconds for a breath to arrive or leave

// Both of those ramps are the same exponential for every object in the frame,
// since they depend only on how long the frame was. Worked out once a frame
// rather than twice per breathing object.
let gainStep = 0;
let alignStep = 1;

/**
 * Where an object is in its breath, before its own alignment is added back.
 * The pattern is a parameter rather than read straight off cfg so that the
 * changeover can ask this the same question twice — once about the pattern being
 * left and once about the one being taken up — without moving the setting.
 */
function breathBase(o, sync = cfg.breathSync) {
  switch (sync) {
    case 'together':
      return breathClock;
    case 'alternate':
      // Every other column against the ones beside it. Dealing the two sides out
      // at random reads as a mess rather than as an alternation: the eye can
      // only see two groups taking turns if it can see where one group is.
      return breathClock + (o.col.side ? Math.PI : 0);
    case 'wave':
      // Along the travel, so the swell runs up the field the way the field runs.
      return breathClock - (o.v / (rowStep() * WAVE_ROWS)) * TAU;
    default:
      return breathOwnT * o.breathVar * TAU + o.breathPhase;
  }
}

/** The shortest way round to the same angle, so an alignment decays rather than unwinds. */
function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/**
 * Hold the picture still across a change of pattern. Called with the pattern
 * already changed: each object's alignment becomes whatever keeps it exactly
 * where it is at this instant, and then decays to nothing on its own.
 */
function realignBreath(was) {
  for (const c of field) {
    for (const o of c.objs) {
      o.breathAlign = wrapPi(breathBase(o, was) + o.breathAlign - breathBase(o));
    }
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
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
  o.spin = false; o.tumble = false; o.glitch = false; o.hue = false;
  if (odd) {
    o[pickPrimary(rand)] = true;
    if (rand() < 0.35) o[pickPrimary(rand)] = true;
  }

  // Whether this one breathes is not decided here. It is dealt a number and the
  // setting decides, every frame, whether the number is low enough — so moving
  // the slider brings breathing to objects already standing in the field rather
  // than only to whatever is dealt next. It can do that, where the habits above
  // cannot, because a breath can arrive and leave smoothly: an object taking up
  // breathing swells into it from exactly the size it was.
  o.breathRoll = rand();
  o.breathVar = 0.55 + rand() * 1.15;    // its own pace, in SCATTERED
  o.breathSize = 0.65 + rand() * 0.7;    // and its own depth, in every pattern
  o.breathPhase = rand() * Math.PI * 2;
  o.breathAlign = 0;
  o.breathGain = 0;

  // A thing standing still is turned a little off square so it reads as placed
  // rather than as installed; a thing that is going to spin anyway can start
  // anywhere.
  o.face = odd ? rand() * Math.PI * 2 : (rand() - 0.5) * 1.3;
  o.tiltX = odd ? (rand() - 0.5) * 0.3 : (rand() - 0.5) * 0.12;
  o.tiltZ = (rand() - 0.5) * 0.12;

  o.spinRate = (0.35 + rand() * 1.15) * (rand() < 0.5 ? -1 : 1);
  o.tumbleAxis = rand() < 0.5 ? 'x' : 'z';
  o.tumbleRate = (0.3 + rand() * 0.85) * (rand() < 0.5 ? -1 : 1);
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
  // Objects are recycled rather than rebuilt — the same object leaves the top of
  // a column and is dealt again at the bottom as something else entirely. So an
  // identity is needed for anything holding on to one across time, which is why
  // this counts deals rather than objects. See the closer look at the bottom.
  o.dealSerial = (o.dealSerial || 0) + 1;
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
    dealSerial: 0,
  };
  mesh.userData.obj = o;
  deal(o, rand);
  return o;
}

function disposeObject(o) {
  releaseVoice(o);
  // The closer look borrows an object's materials rather than copying them, so
  // it has to be told before they are thrown away — otherwise a respace or a
  // loaded scene leaves the panel drawing with a disposed material.
  onObjectGone(o);
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
    // Which of the two sides this column takes in ALTERNATE. Set here rather
    // than when the column is built, because a column's place across the frame
    // is set here too and the alternation is a fact about where it stands.
    col.side = c % 2;
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
  // The breath, on top of that. The gain is what makes the share of breathers a
  // live setting: it walks to 1 or to 0 over the best part of a second, so an
  // object handed a breath grows into it and one that loses it settles back to
  // its own size, and neither of them jumps. At gain 0 this multiplies by
  // exactly 1, so an object that does not breathe pays nothing but the ramp.
  const breathing = o.breathRoll < cfg.breath;
  if (breathing || o.breathGain > 0.0005) {
    o.breathGain += ((breathing ? 1 : 0) - o.breathGain) * gainStep;
    o.breathAlign *= alignStep;
    s *= 1 + depthNow * o.breathSize * o.breathGain
      * Math.sin(breathBase(o) + o.breathAlign);
  }
  o.scale = s;

  // Attitude. The stutter replaces the pose outright rather than adding to it:
  // added, it would creep, and creeping is exactly what a thing that is stuck
  // must not do.
  if (o.glitch) {
    // On the beat when there is one to be on: the same shared pulse, counted off
    // the room instead of off the clock in here. Everything downstream — every
    // first, second or third tick — is untouched, so a stuttering field simply
    // starts landing with the music.
    const tick = Math.floor(roomLocked ? roomBeats : t * GLITCH_HZ);
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

// ------------------------------------------------------- the breath, advanced
// The room's beat is followed rather than read. listen.js reports a grid — a
// beat time and a period, both in the audio clock — and the obvious thing is to
// work the phase out from those every frame. That gives a breath that jumps a
// little every time the estimate is refined, several times a second, which on a
// slow swell is plainly visible.
//
// So the field keeps its own clock and PULLS it toward the room: it runs at the
// room's period, and any disagreement about where in the beat we are is closed
// gradually. What comes out follows the music and is smooth even while the
// estimate underneath it is still arguing with itself.
const PULL = 1.8;          // how hard, per second
const BEATS_PER = [1, 2, 4, 8, 16];   // a breath is this many beats long

let roomLocked = false;    // the room is being followed AND has been found
let roomBeats = 0;         // beats since the lock, fractional and always rising
let roomBeatsPer = 4;

/** Which musical length of breath comes nearest the rate the slider asks for. */
function beatsPerBreath(period) {
  const want = 1 / (cfg.breathRate * period);   // beats per breath, unrounded
  let best = BEATS_PER[0];
  for (const n of BEATS_PER) {
    if (Math.abs(Math.log2(n / want)) < Math.abs(Math.log2(best / want))) best = n;
  }
  return best;
}

function advanceBreath(dt) {
  gainStep = 1 - Math.exp(-dt / GAIN_RISE);
  alignStep = Math.exp(-dt / ALIGN_FALL);
  depthNow += (cfg.breathDepth - depthNow) * (1 - Math.exp(-dt / DEPTH_FOLLOW));
  const s = roomState();
  const period = s && s.status === 'locked' && s.period > 0 ? s.period : 0;
  const wasLocked = roomLocked;
  roomLocked = period > 0;

  if (!roomLocked) {
    breathClock += dt * cfg.breathRate * TAU;
    breathOwnT += dt * cfg.breathRate;
    return;
  }

  roomBeatsPer = beatsPerBreath(period);
  const perBeat = TAU / roomBeatsPer;   // radians of breath in one beat
  roomBeats += dt / period;
  breathClock += (dt / period) * perBeat;
  breathOwnT += dt / (period * roomBeatsPer);

  // Where in the beat the room says we are, against where we think we are. Only
  // ever compared WITHIN one beat: which beat of the breath the swell starts on
  // is not a thing a beat tracker can know — there is no downbeat in an
  // autocorrelation — so the grid is what gets matched, and which beat of it the
  // breath happens to have begun on is left wherever it began.
  const err = wrapPi(((audioNow() - s.beatTime) / period) * TAU - roomBeats * TAU);
  if (!wasLocked) {
    // The first one is free: nothing has been breathing to the room yet, so
    // there is nothing to jolt.
    roomBeats += err / TAU;
    breathClock += (err / TAU) * perBeat;
  } else {
    const k = Math.min(1, PULL * dt);
    roomBeats += (err / TAU) * k;
    breathClock += (err / TAU) * perBeat * k;
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
    advanceBreath(dt);
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
    // 3 took breathing out of the odd habits and made it a setting of its own, so
    // an object no longer says WHETHER it breathes — it carries the number the
    // setting is compared against, and the file carries the shared clock.
    version: 3,
    seed: RUN_SEED,
    t: num(t, 3),
    scrolled: num(scrolled, 3),
    breathClock: num(breathClock, 4),
    breathOwnT: num(breathOwnT, 4),
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
          o.hue && 'hue'].filter(Boolean),
        // Not whether it is breathing, which is the setting's business: the
        // numbers the setting reads. A frame saved at one share and opened at
        // another is then the same objects, breathing or not as asked.
        breath: [num(o.breathRoll, 4), num(o.breathVar, 3), num(o.breathSize, 3),
          num(o.breathPhase, 3), num(o.breathGain, 3), num(o.breathAlign, 3)],
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
    for (const k of ['speed', 'spacing', 'odd', 'breath', 'breathRate', 'breathDepth']) {
      if (typeof data.settings[k] === 'number') cfg[k] = data.settings[k];
    }
    // A file written before the field could be aimed is a file of a field going
    // straight up, whatever the angle happens to be set to now.
    cfg.angle = typeof data.settings.angle === 'number' ? data.settings.angle : 0;
    // And one written before breathing was a setting is a file of the old
    // behavior: a fifth of the odd share breathing, each on its own clock.
    if (SYNCS.includes(data.settings.breathSync)) cfg.breathSync = data.settings.breathSync;
    else if (data.version < 3) { cfg.breathSync = 'scattered'; cfg.breath = 0.2 * cfg.odd; }
    syncControls();
    // A file you opened is where you are now, so it is what you come back to.
    saveSettings();
  }
  // Before anything is placed: every position in the file is a world position,
  // and it takes the bearing to read one back as a place in the lattice.
  aimField();
  t = data.t || 0;
  scrolled = data.scrolled || 0;
  breathClock = data.breathClock || 0;
  breathOwnT = data.breathOwnT || 0;
  depthNow = cfg.breathDepth;

  for (const cs of data.columns) {
    const column = {
      ndcU: cs.ndcU ?? cs.ndcX, depth: cs.depth, rows: cs.rows, span: cs.span,
      phase: cs.phase || 0, side: field.length % 2, objs: [],
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
      o.glitch = does.has('glitch'); o.hue = does.has('hue');
      if (os.breath) {
        [o.breathRoll, o.breathVar, o.breathSize,
          o.breathPhase, o.breathGain, o.breathAlign] = os.breath;
      } else {
        // An older file says only whether this one was breathing. Put it either
        // side of the share the settings above were just set to, so it comes
        // back doing what it was doing — and already at full swell, since it was
        // already at full swell when the frame was saved. Spread across its side
        // rather than pinned to the end of it: pinned, the picture would be right
        // and the slider dead, because no share short of all or nothing would
        // ever cross a roll of exactly 0 or exactly 1.
        const was = does.has('breathe');
        o.breathRoll = was ? rng() * cfg.breath : cfg.breath + rng() * (1 - cfg.breath);
        o.breathGain = was ? 1 : 0;
      }
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
const breathEl = document.getElementById('breath');
const breathVal = document.getElementById('breath-val');
const breathRateEl = document.getElementById('breath-rate');
const breathRateVal = document.getElementById('breath-rate-val');
const breathDepthEl = document.getElementById('breath-depth');
const breathDepthVal = document.getElementById('breath-depth-val');
const syncEls = [...document.querySelectorAll('input[name="sync"]')];
const SYNCS = syncEls.map((el) => el.value);

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
  breathVal.textContent = `${Math.round(cfg.breath * 100)}%`;
  breathDepthVal.textContent = `${Math.round(cfg.breathDepth * 100)}%`;
  // Following a room, the rate is not what the slider says: it is the whole
  // number of beats nearest to it, which at 96 in the room and 20 a minute asked
  // for is three a minute out. Say what it actually settled on, and what that is
  // in the room's own terms, because "4 beats" is the fact that explains why the
  // number beside it is not the one under the thumb.
  if (roomLocked) {
    const s = listenState();
    const per = Math.round(60 / (s.period * roomBeatsPer));
    breathRateVal.textContent = `${per} / min, ${roomBeatsPer} beat${roomBeatsPer === 1 ? '' : 's'}`;
  } else {
    breathRateVal.textContent = `${Math.round(cfg.breathRate * 60)} / min`;
  }
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

// All four breathing controls apply to the field as it stands, which is the
// whole reason breathing is not one of the habits above. None of them needs to
// do anything beyond writing the number down: every one of them is read fresh
// on every frame, by every object, and the ramps in updateObject() are what
// keep a change from arriving as a jolt.
breathEl.addEventListener('input', () => {
  cfg.breath = breathEl.valueAsNumber / 100;
  paintReadouts();
  saveSettings();
});
breathRateEl.addEventListener('input', () => {
  cfg.breathRate = breathRateEl.valueAsNumber / 60;
  paintReadouts();
  saveSettings();
});
breathDepthEl.addEventListener('input', () => {
  cfg.breathDepth = breathDepthEl.valueAsNumber / 100;
  paintReadouts();
  saveSettings();
});
for (const el of syncEls) {
  el.addEventListener('change', () => {
    if (!el.checked) return;
    const was = cfg.breathSync;
    cfg.breathSync = el.value;
    // The one breathing control that needs more than a number written down: the
    // objects are somewhere in a cycle and the new pattern puts them somewhere
    // else, so they are handed the difference and walk it off.
    if (was !== cfg.breathSync) realignBreath(was);
    saveSettings();
  });
}

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
  { key: 'breath', el: breathEl, per: 100, roll: [20, 65] },
  { key: 'breathRate', el: breathRateEl, per: 60, roll: [9, 34] },
  { key: 'breathDepth', el: breathDepthEl, per: 100, roll: [22, 55] },
  // The one setting that is a word rather than a number, so it carries its own
  // three lines instead of a multiplier. It is rolled like the rest: a first
  // visit can arrive at a field breathing in unison as easily as at one
  // breathing at random, and both are the piece.
  { key: 'breathSync', pick: SYNCS },
];

const SETTINGS_KEY = 'object-tile-scroll:settings';

/** Push cfg back out to the controls, after a file or a first visit set it. */
function syncControls() {
  for (const c of CONTROLS) {
    if (c.pick) for (const el of syncEls) el.checked = el.value === cfg[c.key];
    else c.el.value = String(Math.round(cfg[c.key] * c.per));
  }
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
      const raw = saved[c.key];
      if (c.pick) {
        cfg[c.key] = c.pick.includes(raw) ? raw : DEFAULTS[c.key];
        continue;
      }
      // typeof, not just arithmetic: null and '' and false all multiply to 0,
      // which is a real slider position, so a key that has gone missing would
      // come back as that control pinned to its minimum rather than left alone.
      const v = typeof raw === 'number' ? onSlider(c.el, Math.round(raw * c.per)) : null;
      cfg[c.key] = v === null ? DEFAULTS[c.key] : v / c.per;
    }
    return;
  }

  const roll = makeRng(RUN_SEED ^ 0x5eed);
  for (const c of CONTROLS) {
    if (c.pick) {
      cfg[c.key] = c.pick[Math.floor(roll() * c.pick.length)];
      continue;
    }
    const step = Number(c.el.step) || 1;
    const [lo, hi] = c.roll;
    cfg[c.key] = (lo + Math.floor(roll() * (Math.floor((hi - lo) / step) + 1)) * step) / c.per;
  }
  saveSettings();   // the piece they were shown is the piece they come back to
}

// --------------------------------------------------------------- the room
// The field can be handed a clock from outside. listen.js takes the microphone
// and reports what the room is playing; everything above reads that through the
// two functions here and nothing else, so the breath does not know whether it is
// running on the rate slider or on a record somebody put on in the next room.
//
// The piece goes silent for the duration. Its own voices are a continuous drone
// across two dozen objects, which is not a beat and would not be mistaken for
// one — but it is a wash sitting on top of the thing being measured, and a
// detector this careful about a quiet room should not be handed one that the
// piece is filling up itself.
const listenToggle = document.getElementById('listen-toggle');
const listenStatus = document.getElementById('listen-status');
const micRow = document.getElementById('mic-row');
const micSelect = document.getElementById('mic-select');
// Remembered, because the browser offers the system default every time, and on a
// machine with any audio work on it the system default may well be a loopback
// device with nothing routed into it.
const MIC_KEY = 'object-tile-scroll:input';
const rememberedMic = () => { try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; } };
let statusTimer = null;
let following = false;

/** What the room is doing, or nothing at all if we are not listening to it. */
function roomState() {
  return following ? listenState() : null;
}

/** The clock every beat time is quoted in. */
function audioNow() {
  const ac = audioContext();
  return ac ? ac.currentTime : 0;
}

const LISTEN_TEXT = {
  asking: ['Asking for the microphone…', false],
  listening: ['Listening for a beat…', false],
  quiet: ['Too quiet to hear a beat.', false],
  silent: ['The microphone is open but completely silent.', true],
  asleep: ['Waiting for the audio clock.', false],
  lost: ['The microphone was taken away. Switch this off and on to get it back.', true],
  denied: ['The microphone is blocked. Allow it for this site, then try again.', true],
  missing: ['No microphone found.', true],
  busy: ['The microphone would not open. Another app may have it, or this browser may need turning on under System Settings, Privacy and Security, Microphone.', true],
  insecure: ['The microphone needs a secure connection.', true],
  error: ['The microphone could not be opened.', true],
};

function showStatus(text, warn) {
  listenStatus.textContent = text;
  listenStatus.classList.toggle('warn', !!warn);
  listenStatus.hidden = false;
}

/** A failure nobody anticipated should at least say its own name. */
function sayStatus(status, fallback) {
  const [text, warn] = LISTEN_TEXT[status] || fallback;
  const detail = listenState().detail;
  showStatus(status === 'error' && detail ? `${text} (${detail})` : text, warn);
}

/**
 * How loud the room is, as a percentage of the range this can work with. On a
 * log scale, because loudness is: half of everything a microphone hears lives in
 * the bottom tenth of a linear one.
 */
function inputMeter(level) {
  if (!(level > 0)) return 0;
  const u = Math.log10(level / 0.0004) / Math.log10(0.3 / 0.0004);
  return Math.max(0, Math.min(100, Math.round(u * 100)));
}

/**
 * A microphone that opened and delivers nothing but zeros is almost never a
 * quiet room. Overwhelmingly it is the wrong device, so name the one we were
 * given and name the others, which is the fact that actually resolves it.
 */
function silentText() {
  const name = inputName();
  const others = inputChoices().map((d) => d.label).filter((n) => n !== name);
  const which = name ? ` The input is "${name}".` : '';
  const rest = others.length
    ? ` Other inputs on this machine: ${others.join(', ')}.`
    : ' Check the input the system is using, and that this browser is allowed a microphone in System Settings.';
  return `The microphone is open but completely silent.${which}${rest}`;
}

/** Keep the picker on what is actually being heard: a dead input gets abandoned on its own. */
function refreshInputs() {
  const choices = inputChoices();
  const live = currentInputId();
  if (choices.length < 2) { micRow.hidden = true; micSelect.hidden = true; return; }
  const want = choices.map((d) => `${d.id} ${d.label}`).join('|');
  if (micSelect.dataset.built !== want) {
    micSelect.dataset.built = want;
    micSelect.textContent = '';
    for (const d of choices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      micSelect.appendChild(opt);
    }
  }
  if (live && micSelect.value !== live) micSelect.value = live;
  micRow.hidden = false;
  micSelect.hidden = false;
}

function refreshStatus() {
  refreshInputs();
  // The rate readout says something different once the room has the clock, and
  // this is the only thing that runs while it changes.
  paintReadouts();
  const s = listenState();
  if (s.status === 'locked') {
    const per = Math.round(60 / (s.period * roomBeatsPer));
    showStatus(`${Math.round(s.heard)} BPM in the room, breathing every ${roomBeatsPer} `
      + `beat${roomBeatsPer === 1 ? '' : 's'} at ${per} a minute.`, false);
    return;
  }
  // Until it has found something, say what it can hear: without a level there is
  // no telling a room that is too quiet from a microphone handing over nothing.
  if (s.status === 'listening' || s.status === 'quiet' || s.status === 'silent') {
    if (s.status === 'silent') { showStatus(silentText(), true); return; }
    const [text, warn] = LISTEN_TEXT[s.status] || LISTEN_TEXT.listening;
    showStatus(`${text} Input ${inputMeter(s.level)}%.`, warn);
    return;
  }
  sayStatus(s.status, LISTEN_TEXT.listening);
}

async function beginListening() {
  showStatus(...LISTEN_TEXT.asking);
  // The context has to exist before anything can be quoted in its clock, and on
  // a visit where the header slider was never touched there is no context at
  // all. Started here, and started FIRST: it is what sets the audio session,
  // and listen.js has to change that session before it asks for a device.
  startAudio();
  const status = await startListening(audioContext(), null, null, rememberedMic());
  // A permission prompt that is dismissed rather than answered never settles, so
  // the toggle stays live throughout and turning it back off is the way out. If
  // that is what happened, hand the device straight back.
  if (!listenToggle.checked) {
    stopListening();
    listenStatus.hidden = true;
    return;
  }
  if (status !== 'listening') {
    listenToggle.checked = false;
    sayStatus(status, LISTEN_TEXT.error);
    return;
  }
  following = true;
  setMuted(true);
  window.HeaderVolume.setEnabled(false, 'Silent while listening to the room');
  // The Rate slider is deliberately NOT taken away here, the way a tempo fader
  // would be. The room owns the pulse; the slider still owns how many beats of
  // it a breath is worth, which is the difference between breathing on every
  // beat and breathing once a bar. It is a live control, and its readout says
  // which whole number of beats the ask actually landed on.
  statusTimer = setInterval(refreshStatus, 250);
  refreshStatus();
}

function endListening() {
  stopListening();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  listenStatus.hidden = true;
  micRow.hidden = true;
  micSelect.hidden = true;
  // Turned off again before it ever took anything over: there is nothing to give
  // back, and giving back a volume we never took would clobber it.
  if (!following) return;
  following = false;
  roomLocked = false;
  setMuted(false);
  window.HeaderVolume.setEnabled(true);
  paintReadouts();
}

listenToggle.addEventListener('change', () => {
  if (listenToggle.checked) beginListening();
  else endListening();
});

micSelect.addEventListener('change', async () => {
  const id = micSelect.value;
  try { localStorage.setItem(MIC_KEY, id); } catch { /* private window */ }
  showStatus('Switching microphone…', false);
  await useInput(id);
  refreshStatus();
});

// ------------------------------------------------------------------ the closer look
// Press an object and it comes out of the field: the same build, the same finish
// it happens to be wearing, alone in a box you can turn it over in.
//
// It is a SECOND scene with a second renderer rather than a camera move in the
// first one, and that is the whole design. The field is the piece and it must
// keep going exactly as it was — flying the main camera at an object would stop
// everything else dead, and the one rule this piece has is that the field is
// never interrupted. So the object is borrowed, not removed: the inspector holds
// a mesh that shares the kind's geometry and the object's own materials, so it
// is not a copy that can drift out of step. An object drifting through hues goes
// on drifting while you look at it.
//
// The lighting rig is rebuilt to the same numbers rather than shared, because a
// three Light belongs to one scene at a time and moving the field's key light
// into a modal would take it out of the field.
const lookEl = document.getElementById('look');
const lookCanvas = document.getElementById('look-canvas');
const lookNameEl = document.getElementById('look-name');
const lookCloseEl = document.getElementById('look-close');

let lookRenderer = null;
let lookScene = null;
let lookCamera = null;
let lookMesh = null;
let lookObj = null;          // the object in the field this is standing in for
let lookSerial = 0;          // which of that object's deals was picked
let lookOwnMats = null;      // its own copy, once the field has moved on
let lookOpen = false;
let lookYaw = 0.6;
let lookPitch = 0.25;
let lookDist = 3.6;
let lookSpin = true;         // until you take hold of it
let lookRaf = 0;

// A build is normalized to a unit sphere, so 3.6 frames anything in the deck
// with a little air round it and 1.5 is as close as you can get before the
// nearest face is through the camera.
const MIN_DIST = 1.5;
const MAX_DIST = 7;

function buildLook() {
  lookRenderer = new THREE.WebGLRenderer({ canvas: lookCanvas, antialias: true, alpha: true });
  lookRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // The same three settings as the field's renderer. A different tone curve here
  // would show an object that is not the one on screen, which is the one thing an
  // inspector must never do.
  lookRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  lookRenderer.toneMappingExposure = 1.12;
  lookRenderer.outputColorSpace = THREE.SRGBColorSpace;

  lookScene = new THREE.Scene();
  const k2 = new THREE.DirectionalLight(0xfff3e4, 2.7);
  k2.position.set(0.5, 0.9, 0.85);
  const f2 = new THREE.DirectionalLight(0xc2d8ff, 1.15);
  f2.position.set(-0.85, 0.2, 0.5);
  const r2 = new THREE.DirectionalLight(0xffffff, 1.0);
  r2.position.set(-0.15, 0.45, -1);
  const b2 = new THREE.DirectionalLight(0x9fb0cc, 0.55);
  b2.position.set(0.15, -1, 0.4);
  const a2 = new THREE.HemisphereLight(0x93a6c8, 0x1a1d26, 0.8);
  lookScene.add(k2, f2, r2, b2, a2);

  lookCamera = new THREE.PerspectiveCamera(38, 1, 0.05, 40);
  lookMesh = new THREE.Mesh(KINDS[0].geometry, null);
  lookScene.add(lookMesh);
}

/**
 * Stop following the field and keep what is on screen.
 *
 * The field recycles objects: the thing you are looking at will, sooner or
 * later, reach the top of its column and be dealt again as something else. The
 * panel cannot follow that — you would be looking at a pig and find yourself
 * looking at a fridge — so at the moment it happens the panel takes its own copy
 * of the materials and holds the object as it was. Up to then it is genuinely
 * live, and an object that drifts through colors goes on drifting while you
 * watch it, which is the half of this worth keeping.
 */
/** Called by disposeObject before an object's materials go. */
function onObjectGone(o) {
  if (lookObj === o) detachLook();
}

function detachLook() {
  if (!lookObj || lookOwnMats) return;
  const mats = Array.isArray(lookMesh.material) ? lookMesh.material : [lookMesh.material];
  lookOwnMats = mats.map((m) => m.clone());
  lookMesh.material = lookOwnMats.length === 1 ? lookOwnMats[0] : lookOwnMats;
  lookObj = null;
}

function drawLook() {
  lookRaf = 0;
  if (!lookOpen) return;
  if (lookObj && lookObj.dealSerial !== lookSerial) detachLook();
  const w = lookCanvas.clientWidth;
  const h = lookCanvas.clientHeight;
  if (w && h) {
    // Compared against the drawing buffer, not against a remembered size: the
    // panel is sized in CSS and a rotated phone changes it without any event
    // this code would otherwise hear about.
    if (lookCanvas.width !== Math.round(w * lookRenderer.getPixelRatio())
      || lookCanvas.height !== Math.round(h * lookRenderer.getPixelRatio())) {
      lookRenderer.setSize(w, h, false);
      lookCamera.aspect = w / h;
      lookCamera.updateProjectionMatrix();
    }
  }
  // While it is still the object you picked, follow it, so a color that drifts
  // in the field drifts here too.
  if (lookObj) {
    lookMesh.geometry = KINDS[lookObj.kindIdx].geometry;
    lookMesh.material = lookObj.mesh.material;
  }
  if (!lookMesh.material) { lookRaf = requestAnimationFrame(drawLook); return; }
  if (lookSpin) lookYaw += 0.0055;
  const cp = Math.cos(lookPitch);
  lookCamera.position.set(
    Math.sin(lookYaw) * cp * lookDist,
    Math.sin(lookPitch) * lookDist,
    Math.cos(lookYaw) * cp * lookDist,
  );
  lookCamera.lookAt(0, 0, 0);
  lookRenderer.render(lookScene, lookCamera);
  lookRaf = requestAnimationFrame(drawLook);
}

function openLook(o) {
  if (!lookRenderer) buildLook();
  releaseLookMats();
  lookObj = o;
  lookSerial = o.dealSerial;
  // The name is the point of the panel as much as the turning is: the deck is
  // seventy-odd things and half of them are only recognizable once you have been
  // told, which is the piece's own joke about a field of icons.
  lookNameEl.textContent = KINDS[o.kindIdx].name;
  lookYaw = 0.6;
  lookPitch = 0.25;
  lookDist = 3.6;
  lookSpin = true;
  lookOpen = true;
  lookEl.hidden = false;
  lookCloseEl.focus();
  if (!lookRaf) lookRaf = requestAnimationFrame(drawLook);
}

/** Give up any material this panel owns; the field's own are only borrowed. */
function releaseLookMats() {
  if (lookOwnMats) for (const m of lookOwnMats) m.dispose();
  lookOwnMats = null;
  if (lookMesh) lookMesh.material = null;
}

function closeLook() {
  lookOpen = false;
  lookEl.hidden = true;
  lookObj = null;
  releaseLookMats();
  if (lookRaf) cancelAnimationFrame(lookRaf);
  lookRaf = 0;
}

lookCloseEl.addEventListener('click', closeLook);
lookEl.addEventListener('pointerdown', (e) => { if (e.target === lookEl) closeLook(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lookEl.hidden) closeLook();
});

// Turning and zooming. Pointer events cover mouse, pen and touch alike; two
// fingers are tracked by hand because a pinch is the only gesture here that
// needs more than one.
{
  const down = new Map();
  let lastPinch = 0;
  lookCanvas.addEventListener('pointerdown', (e) => {
    lookCanvas.setPointerCapture(e.pointerId);
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lookSpin = false;
    lastPinch = 0;
  });
  lookCanvas.addEventListener('pointermove', (e) => {
    const prev = down.get(e.pointerId);
    if (!prev) return;
    if (down.size >= 2) {
      const pts = [...down.values()];
      const gap = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts2 = [...down.values()];
      const gap2 = Math.hypot(pts2[0].x - pts2[1].x, pts2[0].y - pts2[1].y);
      if (lastPinch && gap2 > 1) lookDist = clamp(lookDist * (gap / gap2), MIN_DIST, MAX_DIST);
      lastPinch = gap2;
      return;
    }
    // A drag across the whole panel is a bit more than half a turn, which is
    // enough to get round the back of a thing without becoming a wrist exercise.
    const wide = lookCanvas.clientWidth || 1;
    lookYaw -= ((e.clientX - prev.x) / wide) * 3.4;
    lookPitch = clamp(lookPitch + ((e.clientY - prev.y) / wide) * 3.4, -1.35, 1.35);
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const release = (e) => { down.delete(e.pointerId); lastPinch = 0; };
  lookCanvas.addEventListener('pointerup', release);
  lookCanvas.addEventListener('pointercancel', release);
  lookCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    lookSpin = false;
    lookDist = clamp(lookDist * (1 + e.deltaY * 0.0016), MIN_DIST, MAX_DIST);
  }, { passive: false });
}

/**
 * Which object is under the pointer, if any.
 *
 * Raycast against the object meshes explicitly rather than against the scene:
 * every object also carries a ghost, a transparent double drawn off to one side,
 * and picking one of those would open the panel on a smear rather than on the
 * thing that cast it.
 */
const picker = new THREE.Raycaster();
const pickAt = new THREE.Vector2();
function objectAt(clientX, clientY) {
  pickAt.x = (clientX / window.innerWidth) * 2 - 1;
  pickAt.y = -(clientY / window.innerHeight) * 2 + 1;
  picker.setFromCamera(pickAt, camera);
  const meshes = [];
  for (const c of field) for (const o of c.objs) if (o.mesh.visible) meshes.push(o.mesh);
  const hit = picker.intersectObjects(meshes, false)[0];
  return hit ? hit.object.userData.obj : null;
}

// A press that travelled is a drag and not a choice — on a phone it is usually
// the start of a scroll the page does not do — so the pick is made on pointerup
// and only if the finger stayed put.
{
  let start = null;
  canvas.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!start) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    const held = performance.now() - start.t;
    start = null;
    if (moved > 10 || held > 700) return;
    const o = objectAt(e.clientX, e.clientY);
    if (o) openLook(o);
  });
  canvas.addEventListener('pointercancel', () => { start = null; });
}

// ----------------------------------------------------------------------- start
lastCols = 0;
openingSettings();
// Whatever a first visit rolled or a return visit remembered is where the depth
// STARTS, not somewhere it eases to from the default.
depthNow = cfg.breathDepth;
aimField();
resize();
fieldReady = true;   // from here on, ONLY can re-deal the field
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
  // Not a model anybody made. A rubber pig off a shelf, scanned with a phone and
  // put through tools/splat2glb.mjs, which reads the splat cloud as a solid and
  // hands back 800 triangles in one flat color — the same shape the rest of the
  // deck arrives in, by a completely different road. It comes out softer than
  // the packs do, because a scan of a real thing is soft: the surface it was
  // measured from is uncertain by about a twentieth of the object, and no amount
  // of triangles invents an edge the capture did not see. That reads as what it
  // is, which is the point of having it here.
  { file: 'rubberPig', name: 'rubber pig', voice: 'wood' },
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

// The food models point at a shared texture atlas this piece does not want and
// will not use. Rather than ship 200KB of it to be thrown away, every image
// request is answered with a single transparent pixel — which keeps the console
// clean instead of showing 404s on load.
//
// At module scope rather than inside the block below, because the closer look
// fetches models of its own on demand and there is no reason for a second
// loader with the same settings.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const modelManager = new THREE.LoadingManager();
modelManager.setURLModifier((url) => (/\.(png|jpe?g|webp)$/i.test(url) ? BLANK : url));
const loader = new GLTFLoader(modelManager);

/**
 * Fetch one model and inflate it here rather than leaving it to the server.
 *
 * glTF is mostly float arrays and gzips to about a quarter of its size, but
 * GitHub Pages only compresses text and JavaScript — a .glb goes out at full
 * size and there is no header we can set to change that. So the models are
 * stored compressed (tools/gzip-models.mjs) and unpacked in the page: the same
 * seventy-one objects arrive in about 0.4MB instead of about 1.5MB.
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

{
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
