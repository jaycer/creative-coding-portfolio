// Hey Chair — a troupe of chairs, theatrically lit, dancing in time.
//
// A troupe comes in out of the dark, dances its way across the frame while the
// choreography changes on every fourth bar, and carries on off the far side to
// be replaced by an entirely different set of chairs. Nobody comes back: each
// troupe is built fresh, so the shapes, finishes and quirks on stage are never
// quite the same twice.
//
// The camera keeps the house seat, head-on and near eye level, and the rig — a
// key from the front and three washes from above — is hung and left alone. Everything that moves is a chair: the whole stay is one
// parade past a fixed point of view, against a plain still field.
//
// Every chair is one of five builds in one of six finishes, and a share of each
// troupe is dealt a QUIRK on top of the choreography:
//
//   GLITCH    is thrown into a new attitude on the beat — any attitude, drawn
//             evenly from every direction there is — and holds it until the
//             next beat, throwing a colored double of itself as it goes
//   WANDER    never settles, drifting between points around its slot
//   SPIN      whips around its own axes, re-picking the rate on the beat
//
// Nothing is animated from wall time. Position on the beat comes from audio.js's
// transport(), which reads the audio clock, so the dance is locked to the music
// rather than merely near it. See that file for the band.
//
// The music does not have to be ours. With FOLLOW THE ROOM on, listen.js takes
// the microphone, works out the tempo and the downbeat of whatever is playing
// nearby, and pulls that same clock onto it — so the beat arrives by the one
// route, and no part of the choreography knows or cares where it came from.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  startAudio, wakeAudio, audioContext, setMuted, setVolume, setTempo, lockTo,
  accent, transport, resync,
} from './audio.js';
import {
  startListening, stopListening, listenState, inputName, inputChoices,
  currentInputId, useInput,
} from '../shared/listen.js';

// ---------------------------------------------------------------- the chairs
// All in meters, y=0 at the floor, origin at the middle of the footprint, so a
// chair can be dropped straight onto the stage at its slot.
const JOIN = 0.004; // bury shared end faces so butt joints can't z-fight

/** The plain four-leg dining chair, the same one the other chair apps use. */
function diningParts() {
  const SEAT_W = 0.46, SEAT_D = 0.44, SEAT_T = 0.05, SEAT_Y = 0.44;
  const LEG = 0.05, LEG_H = 0.44, BACK_H = 0.55;
  const LEG_X = SEAT_W / 2 - LEG / 2, LEG_Z = SEAT_D / 2 - LEG / 2;
  const H = SEAT_Y + SEAT_T + BACK_H;
  return [
    { size: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
    { size: [LEG, LEG_H + JOIN, LEG], pos: [LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
    { size: [LEG, LEG_H + JOIN, LEG], pos: [-LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
    { size: [LEG, H - JOIN, LEG], pos: [LEG_X, (H - JOIN) / 2, -LEG_Z] },
    { size: [LEG, H - JOIN, LEG], pos: [-LEG_X, (H - JOIN) / 2, -LEG_Z] },
    { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.66, -LEG_Z] },
    { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.80, -LEG_Z] },
    { size: [SEAT_W, 0.07, LEG], pos: [0, H - 0.035, -LEG_Z] },
  ];
}

/** Backless, tall, with a footrest ring — the one that reads as a bar stool. */
function stoolParts() {
  const S = 0.36, T = 0.06, Y = 0.68, LEG = 0.045;
  const X = S / 2 - LEG / 2;
  const parts = [{ size: [S, T, S], pos: [0, Y + T / 2, 0] }];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ size: [LEG, Y + JOIN, LEG], pos: [sx * X, (Y + JOIN) / 2, sz * X] });
    }
  }
  // The ring, as four rails rather than a torus, to stay in the same box idiom.
  for (const [sx, sz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    parts.push({
      size: sz ? [S, 0.035, 0.035] : [0.035, 0.035, S],
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
    { size: [W, T, D], pos: [0, SEAT_Y + T / 2, 0] },
    { size: [W, 0.52, 0.14], pos: [0, SEAT_Y + T + 0.26, -D / 2 + 0.07] },
    { size: [0.12, 0.22, D - 0.1], pos: [W / 2 - 0.06, SEAT_Y + T + 0.11, 0.03] },
    { size: [0.12, 0.22, D - 0.1], pos: [-W / 2 + 0.06, SEAT_Y + T + 0.11, 0.03] },
    { size: [LEG, SEAT_Y + JOIN, LEG], pos: [LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { size: [LEG, SEAT_Y + JOIN, LEG], pos: [-LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { size: [LEG, SEAT_Y + JOIN, LEG], pos: [LEG_X, (SEAT_Y + JOIN) / 2, -LEG_Z] },
    { size: [LEG, SEAT_Y + JOIN, LEG], pos: [-LEG_X, (SEAT_Y + JOIN) / 2, -LEG_Z] },
  ];
}

/** A ladderback: absurdly tall, five rungs, the drama queen of the set. */
function ladderbackParts() {
  const SEAT_W = 0.42, SEAT_D = 0.40, SEAT_T = 0.045, SEAT_Y = 0.46;
  const LEG = 0.042, H = 1.34;
  const LEG_X = SEAT_W / 2 - LEG / 2, LEG_Z = SEAT_D / 2 - LEG / 2;
  const parts = [
    { size: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
    { size: [LEG, SEAT_Y + JOIN, LEG], pos: [LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { size: [LEG, SEAT_Y + JOIN, LEG], pos: [-LEG_X, (SEAT_Y + JOIN) / 2, LEG_Z] },
    { size: [LEG, H - JOIN, LEG], pos: [LEG_X, (H - JOIN) / 2, -LEG_Z] },
    { size: [LEG, H - JOIN, LEG], pos: [-LEG_X, (H - JOIN) / 2, -LEG_Z] },
  ];
  for (let i = 0; i < 5; i++) {
    parts.push({
      size: [SEAT_W - LEG * 2 + JOIN * 2, 0.05, LEG * 0.8],
      pos: [0, 0.62 + i * 0.17, -LEG_Z],
    });
  }
  return parts;
}

/** A folding chair: thin everything, an X frame, and a slight recline. */
/**
 * A member given by where it STARTS and where it ENDS in the side view, rather
 * than by a center, a length and an angle. Everything hard about a folding
 * chair is that its parts have to meet each other: pick a leg's length and its
 * splay independently and it will either stop short of the seat or run straight
 * through it, and picking a stretcher's height and depth independently leaves
 * it hanging in the air near the legs it is supposed to join.
 */
function memberYZ(x, width, thick, from, to) {
  const dy = to[0] - from[0];
  const dz = to[1] - from[1];
  return {
    size: [width, Math.hypot(dy, dz), thick],
    pos: [x, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    // A box stands along Y, and turning it about X swings its top toward +Z.
    rot: [Math.atan2(dz, dy), 0, 0],
  };
}

/**
 * The folding chair: two frames that cross. The rear pair carries straight on
 * past the seat to become the uprights the back is hung from, and the front
 * pair stops underneath the seat — which is what a folding chair actually is,
 * and what the old build got wrong in three separate places. Its legs were a
 * fixed 0.64 long at a fixed splay, which put their tops seven centimeters
 * above the seat they were meant to hold up; its back leaned forward into the
 * sitter; and its bottom rails were at a depth nothing else was at, so they
 * floated a few centimeters clear of every leg.
 */
function foldingParts() {
  const W = 0.44, SEAT_D = 0.40, SEAT_T = 0.034;
  const SEAT_TOP = 0.44;
  const UNDER = SEAT_TOP - SEAT_T;   // the underside, where the front legs stop
  const T = 0.032;                   // frame stock
  const BACK_TOP = 0.86;

  // Rear uprights: floor to the top of the back in one piece, leaning back as
  // they go. The seat's rear edge meets them at sitting height.
  const UP_X = W / 2 - T / 2;
  const UP_FOOT = -0.15;
  const UP_HEAD = -0.29;
  const upZ = (y) => UP_FOOT + (y / BACK_TOP) * (UP_HEAD - UP_FOOT);

  // Front legs: floor at the front, up and back to under the seat, crossing the
  // uprights on the way. Set inboard so the two frames pass each other.
  const LEG_X = UP_X - T - 0.006;
  const LEG_FOOT = 0.20;
  const LEG_HEAD = -0.09;
  const legZ = (y) => LEG_FOOT + (y / UNDER) * (LEG_HEAD - LEG_FOOT);

  const RAIL = 0.026;
  const RAIL_Y = 0.13;
  const parts = [];

  for (const side of [1, -1]) {
    parts.push(memberYZ(side * UP_X, T, T, [0, UP_FOOT], [BACK_TOP, UP_HEAD]));
    // A hair into the seat, so the joint is buried rather than merely touching.
    parts.push(memberYZ(side * LEG_X, T, T, [0, LEG_FOOT], [UNDER + JOIN, legZ(UNDER)]));
  }

  // The seat, nudged back by a whisker so its rear edge bites into the uprights.
  parts.push({ size: [W, SEAT_T, SEAT_D], pos: [0, SEAT_TOP - SEAT_T / 2, -JOIN] });

  // The back, hung between the uprights and leaning with them. Flush with their
  // tops: two centimeters of upright left standing proud reads as a tab at each
  // top corner rather than as a detail.
  parts.push(memberYZ(0, UP_X * 2, 0.026, [0.56, upZ(0.56)], [BACK_TOP, UP_HEAD]));

  // Rails, at the depth their own legs are at at that height — which is the
  // whole point, and what makes them read as joined rather than as floating.
  parts.push({ size: [LEG_X * 2, RAIL, RAIL], pos: [0, RAIL_Y, legZ(RAIL_Y)] });
  parts.push({ size: [UP_X * 2, RAIL, RAIL], pos: [0, RAIL_Y, upZ(RAIL_Y)] });

  return parts;
}

const KINDS = [
  { name: 'dining', parts: diningParts },
  { name: 'stool', parts: stoolParts },
  { name: 'armchair', parts: armchairParts },
  { name: 'ladderback', parts: ladderbackParts },
  { name: 'folding', parts: foldingParts },
];

function partsToGeometry(parts) {
  const boxes = parts.map((p) => {
    const g = new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
    if (p.rot) {
      if (p.rot[0]) g.rotateX(p.rot[0]);
      if (p.rot[1]) g.rotateY(p.rot[1]);
      if (p.rot[2]) g.rotateZ(p.rot[2]);
    }
    g.translate(p.pos[0], p.pos[1], p.pos[2]);
    return g;
  });
  return mergeGeometries(boxes);
}

// Built once and shared: every chair on stage is an instance of one of these
// five, so a troupe change costs materials and matrices, not geometry.
const GEOMETRIES = KINDS.map((k) => partsToGeometry(k.parts()));
for (const g of GEOMETRIES) {
  g.computeBoundingBox();
  // Hold every build to the contract at the top of this file: y=0 is the floor.
  // The folding chair breaks it on its own — its X frame is a pair of splayed
  // boxes rotated about their centers, which puts the bottom of the cross a few
  // centimeters under the origin, so it has been standing very slightly sunk
  // into the deck. Nudging whatever dips is cheaper than hand-fitting one model,
  // and it means a new build can never quietly reintroduce this.
  const dip = g.boundingBox.min.y;
  if (dip < 0) {
    g.translate(0, -dip, 0);
    g.computeBoundingBox();
  }
}

// ------------------------------------------------------------------- finishes
// Six ways a chair can be made, each with its own color range, so a troupe reads
// as a mixed set from a props store rather than one chair recolored six times.
const FINISHES = [
  { name: 'wood', colors: [0xc98a45, 0x8f5a34, 0xb07a4a, 0x6b432a], rough: 0.72, metal: 0.04 },
  { name: 'paint', colors: [0xd94f6a, 0x3f7fd6, 0x4fbf74, 0xe0b23c, 0xd6d0c4], rough: 0.5, metal: 0.05 },
  { name: 'chrome', colors: [0xd8dde6, 0xb9c2cc, 0xe7c98a], rough: 0.16, metal: 0.95 },
  { name: 'velvet', colors: [0x7a1f4d, 0x1f3f7a, 0x2f6b45, 0x6b2f1f], rough: 0.95, metal: 0 },
  { name: 'gloss', colors: [0x12131a, 0xf2f0ea, 0xc0342f], rough: 0.14, metal: 0.2 },
  { name: 'neon', colors: [0xff3d8b, 0x2fe8ff, 0xb4ff3d, 0xffb02f], rough: 0.4, metal: 0.1, glow: 0.55 },
];

function makeChairMaterial(rng) {
  const f = FINISHES[Math.floor(rng() * FINISHES.length)];
  const color = f.colors[Math.floor(rng() * f.colors.length)];
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: f.rough, metalness: f.metal,
  });
  if (f.glow) {
    mat.emissive = new THREE.Color(color);
    mat.emissiveIntensity = f.glow;
  }
  return mat;
}

// -------------------------------------------------------------------- the rig
// Gels a lighting designer would actually hang: a warm front key, and three
// saturated washes that read as color on a dark stage. `cyc` is the flat field
// hung behind all of it — a heavily muted relative of the wash, dark enough that
// a lit chair reads against it without anything else going on back there.
const GELS = [
  { key: 0xffd9a8, wash: [0xff2f6d, 0x2fd8ff, 0x9d5cff], cyc: 0x2e1c3f },
  { key: 0xfff0d8, wash: [0xff8a1f, 0x18e0a0, 0xff3b6b], cyc: 0x33231a },
  { key: 0xdfe8ff, wash: [0x2f6bff, 0xff4fd8, 0x36ffb0], cyc: 0x16283a },
  { key: 0xffe4c0, wash: [0xffd12f, 0xff5a2f, 0x7a2fff], cyc: 0x3a2a18 },
  { key: 0xe8f0ff, wash: [0x00e5ff, 0xff2f2f, 0xf0f0ff], cyc: 0x1b2b33 },
];

// --------------------------------------------------------------- choreography
// A move maps a beat to an offset from the chair's slot. They are written to be
// read at any fractional beat, so nothing depends on frames arriving on time.
const MOVES = [
  { name: 'bob', f: (b) => ({ y: Math.abs(Math.sin(b * Math.PI)) * 0.26, rz: Math.sin(b * Math.PI / 2) * 0.07 }) },
  { name: 'sway', f: (b) => ({ rz: Math.sin(b * Math.PI / 2) * 0.30, y: Math.abs(Math.sin(b * Math.PI)) * 0.07 }) },
  { name: 'twist', f: (b) => ({ ry: Math.sin(b * Math.PI / 2) * 0.75, y: Math.abs(Math.sin(b * Math.PI)) * 0.10 }) },
  {
    name: 'hop',
    f: (b) => {
      const u = b - Math.floor(b);
      return { y: Math.sin(Math.PI * Math.min(1, u * 1.7)) * 0.46, rx: -Math.sin(Math.PI * u) * 0.20 };
    },
  },
  {
    name: 'kick',
    f: (b) => {
      const u = b - Math.floor(b);
      const side = Math.floor(b) % 2 ? 1 : -1;
      return { rx: side * Math.sin(Math.PI * u) * 0.42, y: Math.abs(Math.sin(b * Math.PI)) * 0.11 };
    },
  },
  { name: 'carousel', f: (b) => ({ ry: b * Math.PI * 0.5, y: Math.abs(Math.sin(b * Math.PI)) * 0.18 }) },
  {
    name: 'shimmy',
    f: (b) => ({
      x: Math.sin(b * Math.PI * 4) * 0.11,
      rz: Math.sin(b * Math.PI * 4) * 0.12,
      y: Math.abs(Math.sin(b * Math.PI)) * 0.08,
    }),
  },
  {
    name: 'stomp',
    f: (b) => {
      const u = b - Math.floor(b);
      const drop = Math.pow(1 - Math.min(1, u * 3), 2);
      return { y: 0.30 * (1 - drop) * (u < 0.34 ? u * 3 : 1 - (u - 0.34) * 0.6), rx: drop * 0.14 };
    },
  },
];

// Where a troupe stands. Each returns a slot position for member i of n.
const FORMATIONS = [
  { name: 'line', f: (i, n) => [(i - (n - 1) / 2) * 1.15, 0, 0] },
  // A staggered single file: the parade formation, every other chair set half a
  // meter back so the whole troupe stays visible head-on as it crosses.
  { name: 'file', f: (i, n) => [(i - (n - 1) / 2) * 1.3, 0, i % 2 ? 0.55 : -0.55] },
  {
    name: 'arc',
    f: (i, n) => {
      const a = (i - (n - 1) / 2) * (0.9 / Math.max(1, n - 1)) * Math.PI * 0.9;
      return [Math.sin(a) * 3.4, 0, -Math.cos(a) * 1.5 + 1.2];
    },
  },
  {
    name: 'vee',
    f: (i, n) => {
      const half = (n - 1) / 2;
      const d = i - half;
      return [d * 1.05, 0, -Math.abs(d) * 0.75];
    },
  },
  {
    name: 'ring',
    f: (i, n) => {
      const a = (i / n) * Math.PI * 2;
      return [Math.sin(a) * 2.1, 0, Math.cos(a) * 2.1 - 0.4];
    },
  },
  {
    name: 'rows',
    f: (i, n) => {
      const per = Math.ceil(n / 2);
      const row = Math.floor(i / per), col = i % per;
      const wide = Math.min(per, n - row * per);
      return [(col - (wide - 1) / 2) * 1.25, 0, row * -1.5 + 0.6];
    },
  },
];

const QUIRKS = ['glitch', 'wander', 'spin'];

// Roughly a quarter of every troupe comes on at two to three times size.
const BIG_SHARE = 0.25;

// ---------------------------------------------------------------- the machine
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2e1c3f);
// Linear rather than exponential, because what matters here is exactly where it
// finishes: the deck has to arrive at the field's own color by the time it
// reaches the wall, or the last unlit stretch of it sits as a dark stripe
// between the lit stage and the back. `far` is set just short of the wall to
// guarantee that, and `near` is out past where the troupe stands so the chairs
// keep their color — only the ones on their way off get to fade out.
scene.fog = new THREE.Fog(0x2e1c3f, 8, 16);

const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
const STAGE_LOOK = new THREE.Vector3(0, 0.95, 0);

// --------------------------------------------------------------------- stage
// Matte, barely reflective. A shinier deck picks the whole rig up as streaks and
// the floor starts competing with the chairs for attention.
//
// The emissive is the trick that makes the back of the stage work. Left as plain
// dark material the deck is black wherever the lamps do not reach, so the run
// between the far edge of the light and the wall reads as a dark stripe across
// the picture no matter what the fog does — fog can only ramp it from black to
// the field color, and the ramp itself is the stripe. Sitting the deck on the
// field's own color instead means unlit deck already *is* the background, and
// the lamps simply add their pools on top of it.
// Out of the fog as well: with the deck already sitting on the field color there
// is nothing for fog to blend it toward, and fog is mixed in after tone mapping,
// so all it can do is drag the back of the deck off the color the wall is drawn
// in and put the stripe back by a different route.
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x0a0910, roughness: 0.86, metalness: 0.04,
  emissive: new THREE.Color(0x2e1c3f),
  fog: false,
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// The cyclorama. Unlit on purpose: hung as a normal surface it catches every
// wash and every sweep, and the back of the stage turns into moving colored
// smears that pull the eye off the troupe. Drawn instead as one still field —
// a soft vertical ramp with a little lift behind center — it stays plain no
// matter what the rig is doing, and the chairs are the only thing moving.
const cyc = new THREE.Mesh(
  new THREE.PlaneGeometry(130, 70),
  new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x2e1c3f) } },
    // Driven off world position rather than uv, so the ramp and the lift are
    // written in meters above the deck and stay put however the plane is sized.
    vertexShader: `
      varying float vX;
      varying float vY;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vX = world.x;
        vY = world.y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vX;
      varying float vY;
      void main() {
        // At the deck it is exactly uColor, which is also what the deck itself
        // is emitting, so the join is an identity rather than a match anyone has
        // to maintain. From there it only lifts, the way a cyc lit from above
        // does. The two chunks below are what makes that identity hold: a raw
        // ShaderMaterial otherwise writes straight to the framebuffer, skipping
        // the tone mapping and color-space conversion every other material in
        // the scene goes through, and lands somewhere else entirely.
        vec3 c = uColor * mix(1.0, 1.4, smoothstep(-1.0, 11.0, vY));
        // Faded out before it reaches the deck: the glow is the only thing that
        // makes the bottom of the wall brighter than the floor emitting the very
        // same color, and that difference is the whole seam.
        float lift = pow(1.0 - min(1.0, length(vec2(vX / 11.0, (vY - 3.0) / 7.0))), 2.0);
        lift *= smoothstep(0.0, 3.5, vY);
        gl_FragColor = vec4(c + uColor * lift * 0.5, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    depthWrite: false,
    fog: false,
  }),
);
// A shallow stage on purpose. Every meter of deck between the far edge of the
// lamps and the wall is unlit, and reads as a dark stripe across the picture;
// standing the wall just behind the deepest formation leaves almost none of it.
cyc.position.set(0, 20, -9);
cyc.renderOrder = -1;
scene.add(cyc);

// The fill, which is not there to light the stage — the lamps do that — but so
// that a surface the lamps miss comes out DARK rather than absent. That is the
// whole job, and it was being missed by two orders of magnitude. The key is a
// 430-candela spot, which puts something like fifteen units of irradiance on
// the deck; the fill was putting about a hundredth of one. So every surface the
// key could not see rendered at (1, 0, 1) — a black hole in the shape of a
// chair, with a hard edge along it wherever a shadow began. Under a seat, inside
// a tipped chair, behind a leg: all holes.
//
// The ground color is the half that matters. Almost everything that goes black
// here is facing DOWN, and only the lower half of a hemisphere light reaches
// those. On a real stage that light exists and has a name: it is the key coming
// back up off the deck, which is why it is warm and why it is not black.
//
// Nothing else in the picture moves when these do, which is what makes them
// safe to raise this far: the deck is emissive and almost perfectly black in
// albedo, the wall is a raw shader with no lights in it at all, and the beams
// and pools are additive. The chairs are the only thing a fill can reach.
scene.add(new THREE.HemisphereLight(0x2a3050, 0x38263f, 3.6));
scene.add(new THREE.AmbientLight(0x404a6a, 2.8));

// --------------------------------------------------------------------- beams
// The visible cone of a lamp in haze. There is no volumetric pass here: it is an
// additive cone whose alpha falls off along its length and softens at the rim,
// which is what sells a lit stage far more cheaply than real scattering.
// The shaft is a flat quad that spins about the beam axis to face the camera,
// not a cone. A cone mesh gives itself away: its silhouette is a hard polygon
// edge, and the camera walking inside one turns the shot into a flat wash. A
// billboarded quad has no silhouette at all — it is a gradient that feathers to
// nothing at both edges, which is what haze in a beam actually looks like.
const BEAM_VERT = `
  uniform float uApex;   // how wide the quad is at the lamp, as a share of the mouth
  varying float vT;      // 0 at the lamp, 1 at the floor
  varying float vU;      // -1..1 across the beam
  varying float vDist;   // meters from the eye, for the near fade
  void main() {
    vT = 0.5 - position.y;
    vU = position.x * 2.0;
    // Taper: a beam is a sliver at the lamp and its full width at the deck.
    vec3 p = vec3(position.x * mix(uApex, 1.0, vT), position.y, position.z);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const BEAM_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vT;
  varying float vU;
  varying float vDist;
  void main() {
    // Gentle: the lamps hang well above the frame, so a steep falloff puts the
    // whole bright end off-screen and leaves only the dim mouth in shot.
    float along = pow(clamp(1.0 - vT, 0.0, 1.0), 0.55);
    float across = pow(clamp(1.0 - abs(vU), 0.0, 1.0), 1.6);
    // Walking into a beam should not paint the whole screen. Real haze right in
    // front of the eye contributes almost nothing, and without this the moment
    // the camera crosses a shaft the shot turns into a flat color wash.
    float near = smoothstep(0.0, 2.5, vDist);
    float a = along * across * near * uOpacity;
    if (a < 0.002) discard;
    // NOT premultiplied. Additive blending already multiplies by gl_FragColor.a,
    // so scaling the color by alpha as well squares it and the beam vanishes.
    gl_FragColor = vec4(uColor, a);
  }
`;

/** A unit shaft: 1x1 in local space, scaled to width and throw by aimBeam. */
function makeBeam(color) {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 12);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0.0 },
      uApex: { value: 0.34 },
    },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Stand a shaft from the lamp to its target and roll it about its own axis
 * until it faces the camera. Local +Y is the lamp end, so the quad's up axis is
 * the beam pointing back at its source.
 */
const _beamDir = new THREE.Vector3();
const _beamMid = new THREE.Vector3();
const _beamUp = new THREE.Vector3();
const _beamRight = new THREE.Vector3();
const _beamFwd = new THREE.Vector3();
const _beamToCam = new THREE.Vector3();
const _basis = new THREE.Matrix4();
function aimBeam(mesh, from, to, width) {
  _beamDir.subVectors(to, from);
  const len = _beamDir.length() || 1;
  _beamDir.divideScalar(len);
  _beamUp.copy(_beamDir).negate();

  _beamToCam.subVectors(camera.position, from);
  _beamRight.crossVectors(_beamUp, _beamToCam);
  // Dead-on down the barrel there is no roll that helps; any perpendicular does.
  if (_beamRight.lengthSq() < 1e-8) _beamRight.set(1, 0, 0);
  _beamRight.normalize();
  _beamFwd.crossVectors(_beamRight, _beamUp).normalize();

  _basis.makeBasis(_beamRight, _beamUp, _beamFwd);
  mesh.quaternion.setFromRotationMatrix(_basis);
  mesh.position.copy(from).addScaledVector(_beamDir, len / 2);
  mesh.scale.set(width, len, 1);
}

/** The disc of light a lamp leaves on the floor. */
function makePool(color) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(clamp(1.0 - d, 0.0, 1.0), 2.2) * uOpacity;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a); // see the beam shader: not premultiplied
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.012; // just off the deck, so it never z-fights the floor
  return mesh;
}

// ------------------------------------------------------------- the key's map
// The key is the only lamp that casts, and its shadow map is the one place in
// this file where a bare number means nothing on its own.
//
// three's `shadow.bias` is a share of the shadow map's DEPTH RANGE, and a
// spot's depth is perspective — so what one unit of it is worth in meters
// depends entirely on near, far and how far off the receiver is. It is not a
// distance and it does not travel. Written flat as -0.0015 across a 1..40
// frustum it worked out at sixteen centimeters of walk-back where the chairs
// actually stand, which is three chair legs' width of daylight between every
// chair and its own shadow: the shadow left the foot and started somewhere
// upstage on its own.
//
// So the frustum is cut down to the shell things can really be in — nothing
// nearer to the lamp than a chair lifted into the flies, nothing further than
// one on its way off the side — and the walk-back is written in METERS and
// converted against that frustum here, once. Change either and the other still
// means what it says.
const KEY_FROM = [0, 8.5, 6.5];
const KEY_ANGLE = 0.8;
const SHADOW_NEAR = 3;
const SHADOW_FAR = 28;
const SHADOW_WALK_M = 0.004;   // how far a shadow is allowed to retreat: 4mm
const KEY_THROW = Math.hypot(
  KEY_FROM[0] - STAGE_LOOK.x, KEY_FROM[1] - STAGE_LOOK.y, KEY_FROM[2] - STAGE_LOOK.z,
);
// A perspective depth buffer stores f(d - n) / ((f - n) d), so a meter at the
// deck is worth this much of the stored range. Divide the meters we want by it.
const SHADOW_DEPTH_PER_M = (SHADOW_FAR * SHADOW_NEAR)
  / ((SHADOW_FAR - SHADOW_NEAR) * KEY_THROW * KEY_THROW);
const SHADOW_BIAS = -SHADOW_WALK_M * SHADOW_DEPTH_PER_M;

// A phone is showing the same stage at a fraction of the pixels and does not
// want to pay for a 2048 map to do it.
const SHADOW_SIZE = matchMedia('(pointer: fine)').matches ? 2048 : 1024;
// Acne is a texel-sized problem, so its cure is sized in texels. The map covers
// the key's whole cone, so one texel lands this wide on the deck, and a deck lit
// from about fifty degrees up needs a shade under one of them. normalBias is in
// world units, which is why it can be written this way at all — it is the only
// shadow constant in three that already means meters.
const SHADOW_TEXEL_M = 2 * Math.tan(KEY_ANGLE) * KEY_THROW / SHADOW_SIZE;

// The rig: one front key that casts the shadows, three colored washes on a
// truss above and behind, and a pair of low back lights for silhouette.
function makeLamp({ color, intensity, angle, penumbra, from, castShadow }) {
  const light = new THREE.SpotLight(color, intensity, 46, angle, penumbra, 1.4);
  light.position.set(from[0], from[1], from[2]);
  light.target.position.copy(STAGE_LOOK);
  scene.add(light);
  scene.add(light.target);
  if (castShadow) {
    light.castShadow = true;
    light.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    light.shadow.camera.near = SHADOW_NEAR;
    light.shadow.camera.far = SHADOW_FAR;
    light.shadow.bias = SHADOW_BIAS;
    light.shadow.normalBias = SHADOW_TEXEL_M * 1.1;
  }
  const beam = makeBeam(color);
  scene.add(beam);
  const pool = makePool(color);
  scene.add(pool);
  return { light, beam, pool, base: intensity, color: new THREE.Color(color) };
}

// Intensities are candela (three has been physically-scaled since r155), so a
// lamp eight meters up needs to be in the hundreds before it reads on the deck.
// The key is wide enough to cover the whole formation, not just center stage.
//
// Penumbra is near the top of its range throughout, and the angles are opened up
// to pay for it. A tighter edge draws its own hard rim on the deck — a wavy
// bright shape with the dark stage outside it — and that rim is the busiest
// thing in the picture once nothing else is moving.
const keyLamp = makeLamp({
  color: 0xffd9a8, intensity: 430, angle: KEY_ANGLE, penumbra: 0.92,
  from: KEY_FROM, castShadow: true,
});
const washLamps = [
  makeLamp({ color: 0xff2f6d, intensity: 360, angle: 0.68, penumbra: 0.95, from: [-6.5, 8, -1.5] }),
  makeLamp({ color: 0x2fd8ff, intensity: 360, angle: 0.68, penumbra: 0.95, from: [6.5, 8, -1.5] }),
  makeLamp({ color: 0x9d5cff, intensity: 300, angle: 0.72, penumbra: 0.95, from: [0, 9, -6] }),
];
const allLamps = [keyLamp, ...washLamps];

// Where each wash sits. Spread across the width the troupe parades through, so
// there is lit stage to cross rather than one hot spot at center.
const WASH_AIM = [
  new THREE.Vector3(-3.6, 0.8, 0.4),
  new THREE.Vector3(3.6, 0.8, 0.4),
  new THREE.Vector3(0, 0.9, -1.2),
];

// How much of the rig is actually drawn as haze. The shafts and the pools are
// the loudest thing on a dark stage, and at full strength they streak across the
// whole frame; kept this low they read as atmosphere behind the troupe instead.
const BEAM_LEVEL = 0.2;
const POOL_LEVEL = 0.05;

// The rig crossfades between gels rather than cutting. A hard change was fine
// while troupes came on one at a time, but now two share the stage during a
// changeover, and snapping the color would repaint the troupe still dancing.
// Every lamp, the wall, the deck and the fog travel together over a few bars.
const GEL_FADE_BARS = 4;
/** The gel flattened to one color per fixture, so a fade is a list of lerps. */
function gelColors(gel) {
  return [
    gel.key,
    ...washLamps.map((_, i) => gel.wash[i % gel.wash.length]),
  ].map((hex) => new THREE.Color(hex)).concat([new THREE.Color(gel.cyc)]);
}
let gelFrom = null;
let gelTo = null;
let gelFadeStart = 0;    // the bar the fade began on
const _mix = new THREE.Color();

/** Begin a change of scene. Called as a troupe is sent on, not when it lands. */
function dressRig(gel, atBar) {
  gelFrom = gelTo ? applyRig(1) : gelColors(gel);  // wherever the rig is right now
  gelTo = gelColors(gel);
  gelFadeStart = atBar;
}

/**
 * Put the rig somewhere between the two gels and hand back what it landed on,
 * so a fade interrupted halfway starts its next one from the real colors rather
 * than from the gel it never reached.
 */
function applyRig(u) {
  const e = smooth(Math.max(0, Math.min(1, u)));
  const now = allLamps.map((l, i) => {
    _mix.copy(gelFrom[i]).lerp(gelTo[i], e);
    l.color.copy(_mix);
    l.light.color.copy(_mix);
    l.beam.material.uniforms.uColor.value.copy(_mix);
    l.pool.material.uniforms.uColor.value.copy(_mix);
    return l.color.clone();
  });
  // The wall and the deck are handed the same color, and both take it through
  // the same tone mapping, so the two meet at exactly one value. The fog only
  // has the chairs left to work on: it is what a troupe on its way off dissolves
  // into rather than shrinking away into a dark corner.
  const last = gelFrom.length - 1;
  _mix.copy(gelFrom[last]).lerp(gelTo[last], e);
  cyc.material.uniforms.uColor.value.copy(_mix);
  floorMat.emissive.copy(_mix);
  scene.background.copy(_mix);
  scene.fog.color.copy(_mix);
  now.push(_mix.clone());
  return now;
}

// -------------------------------------------------------------- the troupe
// A tiny seeded generator, so a troupe's whole look follows from one number and
// nothing has to be stored to reproduce it. This is splitmix32 rather than the
// usual one-line LCG on purpose: seeded from consecutive troupe numbers, an LCG
// hands back nearly the same first draw every time, and every troupe in a row
// picked the same formation off it.
function makeRng(seed) {
  let s = (Math.imul(seed, 2654435761) + 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Everything on the boards, so the whole cast can be hidden with one flag while
// the opening sheet is up.
const stage = new THREE.Group();
scene.add(stage);

// Who is out there. Usually one; two during a changeover, when the troupe coming
// on and the troupe going off share the stage. Oldest first. Each carries its own
// group, because two troupes at different points in their crossings cannot ride
// on one transform.
const troupes = [];
let troupeIndex = 0;     // which troupe this is, and the seed its whole look follows from
// Both of these start from the settings sheet rather than from a number here —
// see the read at the bottom of the wiring. Two copies of a default is two
// places to forget.
let troupeSize;          // chairs per troupe
let oddShare;            // how much of a troupe is dealt a quirk


function disposeTroupe(t) {
  if (!t) return;
  stage.remove(t.group);
  for (const c of t.chairs) {
    c.mesh.material.dispose();
    if (c.ghost) c.ghost.material.dispose();
  }
}

/** 0..n-1, shuffled, for handing out a fixed number of somethings at random. */
function shuffledIndices(n, rng) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// One number decides the whole run: every troupe's shapes, finishes, scales,
// quirks and staging follow from it, in order. It used to be a constant, and
// that is a poor kind of variety — the troupes differed from EACH OTHER, and
// every visit replayed the identical sequence, so the curtain went up on the
// same three stools every single time. Drawn per visit now. ?seed=12345 pins it
// again for a screenshot that has to be repeatable.
const SEED_PARAM = new URLSearchParams(location.search).get('seed');
const RUN_SEED = SEED_PARAM !== null && Number.isFinite(Number(SEED_PARAM))
  ? Number(SEED_PARAM) >>> 0
  : (Math.random() * 0x100000000) >>> 0;

function buildTroupe(index, cycleStart) {
  const rng = makeRng(RUN_SEED + index);
  const n = troupeSize;
  const group = new THREE.Group();
  stage.add(group);
  const formation = FORMATIONS[Math.floor(rng() * FORMATIONS.length)];
  const gel = GELS[Math.floor(rng() * GELS.length)];
  // Four moves, one per phrase, so the choreography changes on the 4-bar line.
  const moves = Array.from({ length: 4 }, () => MOVES[Math.floor(rng() * MOVES.length)]);
  // Unison most nights; now and then the move travels down the line as a canon.
  const wave = rng() < 0.35 ? 0.25 + rng() * 0.3 : 0;

  // The parade. A troupe does not hold center stage and dance: it crosses the
  // frame, so the whole stay is one pass in front of the camera. The crossing is
  // given as a distance rather than a speed, so the march reads the same however
  // long the troupe has been handed, and it is centered on the stay — a march
  // that simply set off from the middle would spend its whole second half
  // hugging one edge with an empty stage beside it.
  //
  // How far it can go depends on how wide the troupe already stands: a line of
  // twelve is broader than the frame before it has moved at all, and marching it
  // anywhere would just push most of the cast out of shot.
  const dir = rng() < 0.5 ? -1 : 1;
  const xs = Array.from({ length: n }, (_, i) => formation.f(i, n)[0]);
  const spread = Math.max(...xs) - Math.min(...xs);
  const cross = Math.min(5 + rng() * 6, Math.max(2.5, 13 - spread));
  // In from the side it is marching away from, out the way it was already going.
  // Now and then one drops from the flies or lifts straight out instead.
  const enter = rng() < 0.28 ? 'above' : (dir > 0 ? 'left' : 'right');
  const exit = rng() < 0.18 ? 'above' : (dir > 0 ? 'right' : 'left');
  // The crossing is not a straight line across: it bows toward the audience and
  // back, so the troupe swells as it passes and shrinks again on the way out.
  // Upstage at both ends, closest at the middle of the stay.
  const arc = 1.8 + rng() * 1.6;

  // Deal the quirks. Whoever is odd is chosen up front and guaranteed to cover
  // all three kinds when the troupe is big enough, so a stage never ends up with
  // three spinners and nothing else.
  const oddCount = Math.min(n, Math.round(n * oddShare));
  const order = shuffledIndices(n, rng);
  const quirkOf = new Array(n).fill(null);
  for (let k = 0; k < oddCount; k++) {
    quirkOf[order[k]] = QUIRKS[k < QUIRKS.length ? k : Math.floor(rng() * QUIRKS.length)];
  }

  // A couple of the troupe are giants. They keep their ordinary slot, so a big
  // one stands among the others rather than being given room — it towers over
  // its neighbors and the formation closes around its legs, which is the joke.
  // Drawn from a shuffle of its own, so being big and being odd can coincide and
  // the stage can get a three-meter chair whipping around its own axis.
  const bigCount = Math.max(1, Math.round(n * BIG_SHARE));
  const isBig = new Set(shuffledIndices(n, rng).slice(0, bigCount));

  const chairs = [];
  for (let i = 0; i < n; i++) {
    const kindIdx = Math.floor(rng() * KINDS.length);
    const mat = makeChairMaterial(rng);
    const mesh = new THREE.Mesh(GEOMETRIES[kindIdx], mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const scale = isBig.has(i) ? 2.1 + rng() * 1.3 : 0.82 + rng() * 0.5;
    mesh.scale.setScalar(scale);
    group.add(mesh);

    const slot = formation.f(i, n);
    // Stand it in its slot right away, so the stage is dressed behind the
    // opening sheet instead of every chair sitting on top of the origin.
    mesh.position.set(slot[0], slot[1], slot[2]);
    const quirk = quirkOf[i];

    // The glitchers carry a colored double of themselves, parked out of sight
    // until they stutter. Additive and unlit, so it reads as a signal artifact
    // rather than another chair.
    let ghost = null;
    if (quirk === 'glitch') {
      const gmat = new THREE.MeshBasicMaterial({
        color: rng() < 0.5 ? 0x2fe8ff : 0xff2f8b,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      ghost = new THREE.Mesh(GEOMETRIES[kindIdx], gmat);
      ghost.scale.setScalar(scale);
      ghost.visible = false;
      group.add(ghost);
    }

    chairs.push({
      mesh,
      ghost,
      kind: kindIdx,                      // which build, so a saved still can name it
      slot: new THREE.Vector3(slot[0], slot[1], slot[2]),
      home: new THREE.Vector3(slot[0], slot[1], slot[2]),
      face: (rng() - 0.5) * 0.5,          // how square-on to the audience it stands
      scale,
      quirk,
      phase: i * wave,
      seed: rng() * 100,
      spinRate: new THREE.Vector3(),
      spinAngle: new THREE.Vector3(),
      spinBeat: -1,
      wander: new THREE.Vector3(slot[0], 0, slot[2]),
      wanderFrom: new THREE.Vector3(slot[0], 0, slot[2]),
      wanderAt: -1,
      snapTick: null,                  // which beat, or which second, it last jumped on
      snapEuler: new THREE.Euler(),    // the attitude it is holding
      snapFlash: 0,                    // decays from the instant of the jump
    });
  }

  const troupe = {
    group, chairs, formation, gel, moves, wave,
    dir, cross, arc, enter, exit, cycleStart, index,
  };
  // Stand it at the top of its crossing before its first frame is drawn, so it
  // does not appear at the origin and jump.
  placeTroupe(troupe, 0);
  return troupe;
}

/**
 * Call the next lot on. The one already out there is left to finish: for the
 * length of the overlap both are on the boards, one walking off as the other
 * walks on, which is what makes the changeover read as a handover rather than as
 * a stage that empties and refills.
 */
function sendInTroupe(atBar) {
  troupeIndex += 1;
  const troupe = buildTroupe(troupeIndex, atBar);
  troupes.push(troupe);
  dressRig(troupe.gel, atBar);
  return troupe;
}

// How long a troupe is on stage, and how much of that is coming and going. The
// stay comes from the settings sheet; the entrance and exit are fixed.
let troupeBars;
const ENTER_BARS = 2;
const EXIT_BARS = 2;
// How long the two troupes share the stage at a changeover. Wide enough that the
// one walking on is well into its entrance before the one walking off is gone,
// which is the whole point: the stage is handed over, never emptied.
const OVERLAP_BARS = 3;

/**
 * Where a chair waits before its entrance and where it goes afterward. In the
 * troupe's own space, which the parade is sliding: an exit to the right is a
 * chair carrying on the way it was already walking.
 */
function offstageFor(chair, side, out) {
  switch (side) {
    case 'left': return out.set(chair.home.x - 11, 0.4, chair.home.z);
    case 'right': return out.set(chair.home.x + 11, 0.4, chair.home.z);
    default: return out.set(chair.home.x, 9.5, chair.home.z);
  }
}

// Where the troupe stands at the ends of its crossing, in meters upstage. It
// comes on and leaves from back here and swings down toward the audience in
// between, so the arc reads as depth rather than as a sideways slide.
const ARC_BACK = -1.6;

/**
 * Put the troupe where it should be at this point in its stay.
 *
 * Across: half the crossing upstream when it lands, dead center at the midpoint,
 * half of it downstream by the time the exit carries it off. Toward the camera:
 * a bow that peaks at the middle, which is what makes the chairs swell on the
 * way past and shrink again as they go.
 */
function placeTroupe(tr, localBar) {
  const march = Math.max(1, troupeBars - ENTER_BARS - EXIT_BARS);
  const u = Math.max(0, Math.min(1, (localBar - ENTER_BARS) / march));
  tr.group.position.set(
    tr.dir * tr.cross * (u - 0.5),
    0,
    ARC_BACK + (tr.arc - ARC_BACK) * Math.sin(Math.PI * u),
  );
}

const _q = new THREE.Quaternion();
const _wasQ = new THREE.Quaternion();

/**
 * An attitude drawn evenly from every direction there is.
 *
 * Not three random Euler angles, which is the obvious way and is not even:
 * turning about x, then y, then z crowds the results toward the poles, so the
 * chair keeps finding its way back to the same handful of attitudes. This is
 * Shoemake's method — a uniform random unit quaternion — which gives every
 * orientation in three dimensions the same chance, and only then gets read back
 * out as the euler the mesh wants.
 */
function randomAttitude(q) {
  const u1 = Math.random(), u2 = Math.random(), u3 = Math.random();
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  q.set(
    a * Math.sin(2 * Math.PI * u2),
    a * Math.cos(2 * Math.PI * u2),
    b * Math.sin(2 * Math.PI * u3),
    b * Math.cos(2 * Math.PI * u3),
  );
}

function nextAttitude(out) {
  _wasQ.setFromEuler(out);
  // Far enough from where it already was to read as a jump. The dot of two unit
  // quaternions is the cosine of half the angle between them, so this asks for
  // at least sixty degrees of turn — otherwise an unlucky draw lands the chair
  // near the attitude it was already holding and the beat passes unmarked.
  for (let i = 0; i < 12; i++) {
    randomAttitude(_q);
    if (Math.abs(_q.dot(_wasQ)) < 0.87) break;
  }
  out.setFromQuaternion(_q);
}

const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const smooth = (u) => u * u * (3 - 2 * u);

// ------------------------------------------------------------------- dancing
const _off = new THREE.Vector3();
const _target = new THREE.Vector3();

function updateChair(c, tr, t, localBar, move, jolt, dt) {
  const mesh = c.mesh;
  let beat = t.beat + c.phase;

  // GLITCH: the chair is thrown into a new attitude between one frame and the
  // next, and then holds it — no easing in, nothing settling afterwards. The
  // holding is the whole effect: a chair that tumbles continuously reads as a
  // chair that is moving, and one that is suddenly on its side and STAYS there
  // reads as something that went wrong and has not been fixed.
  if (c.quirk === 'glitch') {
    // On the beat, always. There is a beat either way — the band's own when
    // nothing is being followed, the room's when something is — and it is the
    // same clock in both cases, so the jump lands on the music rather than near
    // it whichever is playing, and it takes the tempo fader with it.
    const tick = Math.floor(t.beat);
    if (tick !== c.snapTick) {
      c.snapTick = tick;
      nextAttitude(c.snapEuler);
      c.snapFlash = 1;
    }
    c.snapFlash = Math.max(0, c.snapFlash - dt * 7);
  }

  const m = move.f(beat);
  const amp = 0.85 + 0.5 * t.low + 0.3 * jolt;

  // Where the chair is standing this frame, before the dance moves it.
  _target.copy(c.home);
  if (c.quirk === 'wander') {
    // Never settles: picks a new spot near its slot every beat or two and eases
    // toward it, so the drift is continuous but never leaves the formation.
    if (t.beat > c.wanderAt) {
      c.wanderFrom.copy(c.wander);
      c.wander.set(
        c.home.x + (Math.random() - 0.5) * 3.4,
        Math.random() * 1.6,
        c.home.z + (Math.random() - 0.5) * 2.6,
      );
      c.wanderAt = t.beat + 1 + Math.random() * 1.5;
    }
    const u = 1 - Math.min(1, Math.max(0, c.wanderAt - t.beat) / 1.6);
    _target.lerpVectors(c.wanderFrom, c.wander, easeInOut(Math.min(1, u)));
  }

  mesh.position.set(
    _target.x + (m.x || 0),
    _target.y + (m.y || 0),
    _target.z + (m.z || 0),
  );
  // A glitched chair keeps dancing on the spot and is simply pointing the wrong
  // way while it does — the attitude replaces the choreography's rotation
  // outright rather than being added to it, or it would drift and stop reading
  // as held.
  if (c.quirk === 'glitch') mesh.rotation.copy(c.snapEuler);
  else mesh.rotation.set((m.rx || 0) * amp, c.face + (m.ry || 0), (m.rz || 0) * amp);

  if (c.quirk === 'spin') {
    // Constantly changing angle, and the rate itself is re-thrown twice a beat.
    // The angle is integrated rather than derived from the beat: re-deriving it
    // would jump by whole turns every time the rate changed, which reads as
    // flicker instead of as a chair whipping around.
    const beatIdx = Math.floor(t.beat * 2);
    if (beatIdx !== c.spinBeat) {
      c.spinBeat = beatIdx;
      c.spinRate.set(
        (Math.random() - 0.5) * 5.5,
        (Math.random() - 0.5) * 11,
        (Math.random() - 0.5) * 4,
      );
    }
    c.spinAngle.addScaledVector(c.spinRate, dt);
    mesh.rotation.x += c.spinAngle.x;
    mesh.rotation.y += c.spinAngle.y;
    mesh.rotation.z += c.spinAngle.z;
  }

  // A jolt on the shout: everyone snaps up and open for a moment.
  if (jolt > 0.001) {
    mesh.position.y += jolt * 0.5;
    mesh.rotation.z += Math.sin(c.seed * 13.3) * jolt * 0.5;
  }

  // Entrance and exit ride on top of everything: the chair is carried from
  // offstage to its slot, and the pose it is holding comes along for the trip.
  let p = 1;
  let side = tr.enter;
  if (localBar < ENTER_BARS) p = easeOut(Math.min(1, localBar / ENTER_BARS));
  else if (localBar > troupeBars - EXIT_BARS) {
    p = 1 - smooth(Math.min(1, (localBar - (troupeBars - EXIT_BARS)) / EXIT_BARS));
    side = tr.exit;
  }
  if (p < 0.999) {
    offstageFor(c, side, _off);
    mesh.position.lerp(_off, 1 - p);
    // A slow tumble on the way in and out, settling exactly as it lands.
    const spin = (1 - p) * Math.PI * 1.2;
    mesh.rotation.y += spin * (c.seed % 2 ? 1 : -1);
    mesh.rotation.x += spin * 0.25;
    const s = c.scale * (0.55 + 0.45 * p);
    mesh.scale.setScalar(s);
    if (c.ghost) c.ghost.scale.setScalar(s);
  } else if (mesh.scale.x !== c.scale) {
    mesh.scale.setScalar(c.scale);
    if (c.ghost) c.ghost.scale.setScalar(c.scale);
  }

  liftAboveDeck(mesh);

  // The double, dragged a few centimeters off and shown only mid-stutter. Taken
  // from the chair's finished pose, so it travels with the entrance and sits on
  // the deck with it rather than being left behind at the slot.
  if (c.ghost) {
    c.ghost.visible = c.snapFlash > 0.02;
    if (c.ghost.visible) {
      // Dragged far enough off to read as a displaced echo. Sitting on top of
      // the chair it just looks like the chair went the wrong color.
      c.ghost.position.copy(mesh.position).add(_off.set(
        Math.sin(c.seed * 7.7) * 0.34, 0.06, Math.cos(c.seed * 5.1) * 0.34,
      ));
      c.ghost.rotation.copy(mesh.rotation);
      c.ghost.material.opacity = c.snapFlash * (0.4 + Math.random() * 0.25);
    }
  }
}

const _rot = new THREE.Matrix4();
/**
 * Float the chair so no part of it dips through the deck.
 *
 * Every rotation here is about the chair's own base, and the dance turns them a
 * long way past level — the spinners go clean over — so a tilt of any size
 * swings a corner underground. Rather than damp the choreography, which is the
 * good part, the whole chair is lifted by exactly however far it would have
 * sunk. Standing square it does not move at all; mid-cartwheel it vaults.
 */
function liftAboveDeck(mesh) {
  const b = mesh.geometry.boundingBox;
  _rot.makeRotationFromEuler(mesh.rotation);
  const e = _rot.elements;
  // Only the row of the rotation that produces world y matters (three stores
  // column-major, so that row is elements 1, 5 and 9), and the lowest corner of
  // the box follows per axis from the sign of its coefficient: a negative one
  // takes the far end of the range down, a positive one the near end.
  const s = mesh.scale.x;
  const drop = s * (
    (e[1] < 0 ? e[1] * b.max.x : e[1] * b.min.x)
    + (e[5] < 0 ? e[5] * b.max.y : e[5] * b.min.y)
    + (e[9] < 0 ? e[9] * b.max.z : e[9] * b.min.z)
  );
  if (mesh.position.y + drop < 0) mesh.position.y = -drop;
}

// -------------------------------------------------------------------- camera
// One seat in the house, head-on, at head height, and it never moves. The
// choreography is what changes size and position now: the troupe bows toward the
// audience and back, so a chair swells as it passes without the camera doing
// anything at all. Cuts, drift and orbit are gone — with the arc doing the work
// a moving camera only muddles which of the two is moving.
//
// phi is measured from straight up, so a shade under a right angle is a camera
// standing at head height: this puts the eye at about 2.1m.
const SHOT = { r: 8.2, phi: 1.47, look: [0, 1.25, 0] };
const cam = { r: SHOT.r, look: new THREE.Vector3(...SHOT.look) };

// A perspective camera's fov is vertical, so a tall viewport does not show less
// height, it shows less width — and a phone held upright crops a parade of seven
// chairs down to about two. The rig backs off to pay for it, capped so a phone
// gets a wide shot rather than an aerial one.
const REF_ASPECT = 16 / 9;
let aspectPull = 1;

function placeCamera() {
  // The wheel is the one thing that moves it, and only along its own axis: the
  // angle is fixed, so getting closer is all a viewer can ask for.
  const r = cam.r * aspectPull;
  camera.position.set(
    cam.look.x,
    cam.look.y + r * Math.cos(SHOT.phi),
    cam.look.z + r * Math.sin(SHOT.phi),
  );
  camera.lookAt(cam.look);

  // Fog is measured from the eye, so it has to follow the eye: pinned to fixed
  // meters it would swallow the troupe whole the moment the rig backs off for a
  // phone, or when the wheel pulls it out. Center stage is always just clear of
  // it, and a chair on its way off the side always fades into the field.
  scene.fog.near = r + 0.5;
  scene.fog.far = r + 9;
}

// ------------------------------------------------------------------ the show
const clock = new THREE.Clock();
let jolt = 0;
let started = false;
// Declared up here rather than beside the buttons that set them: resize() reads
// `paused` and runs at module scope, well before the freeze-frame section is
// reached, and a `let` further down would still be in its dead zone. See that
// section for what they mean.
let paused = false;
let tableau = null;
const _lampTarget = new THREE.Vector3();
const _lampFrom = new THREE.Vector3();

function updateRig(t) {
  // One slow breath per bar, and that is the whole of it. The rig used to answer
  // every kick, clap and stab — the washes swung from about half to double on
  // each hit — and against a plain still field that reads as a strobe rather
  // than as a stage. Each lamp is offset a little around the bar so they pass
  // through each other instead of blinking in step.
  const swell = (phase) => 0.95 + 0.09 * Math.cos((t.barPhase - phase) * Math.PI * 2);
  // The shout still flashes. Nothing else does.
  const flare = t.accent;

  keyLamp.light.intensity = keyLamp.base * (swell(0) + 0.2 * t.accent);
  keyLamp.light.target.position.set(0, 0.9, 0);

  washLamps.forEach((l, i) => {
    // Hung and left there. Sweeping them painted the deck and the back of the
    // stage with moving color, which is exactly the busy-ness the picture does
    // not want — and with the troupe parading now, standing lamps read better
    // anyway: the chairs cross the light instead of the light chasing them.
    l.light.target.position.copy(WASH_AIM[i]);
    l.light.intensity = l.base * (swell(0.16 + i * 0.14) + 0.3 * t.accent);
  });

  for (const l of allLamps) {
    l.light.target.updateMatrixWorld();
    _lampFrom.copy(l.light.position);
    _lampTarget.copy(l.light.target.position);
    // The shaft is drawn as the bright core of the lamp, not its full footprint:
    // at the true cone angle it is wide enough to fill the frame on its own.
    const throwLen = _lampFrom.distanceTo(_lampTarget);
    const mouth = Math.tan(l.light.angle) * throwLen;
    aimBeam(l.beam, _lampFrom, _lampTarget, Math.max(0.5, mouth * 0.5));
    // Beam brightness tracks the lamp, with a little haze flicker on top.
    const lit = l.light.intensity / l.base;
    const flick = 0.94 + 0.06 * Math.sin(t.beat * 5.3 + l.light.position.x);
    l.beam.material.uniforms.uOpacity.value = BEAM_LEVEL * lit * flick + flare * 0.05;
    // The pool is kept tighter and dimmer than the lamp's true footprint. Drawn
    // to its real size it floods the deck and the beam above it disappears into
    // the glare, which is the opposite of the look.
    l.pool.position.x = _lampTarget.x;
    l.pool.position.z = _lampTarget.z;
    l.pool.scale.setScalar(Math.max(1.2, mouth * 1.5));
    l.pool.material.uniforms.uOpacity.value = POOL_LEVEL * lit;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  // Held: nothing is advanced, nothing is placed, nothing is re-lit. The frame
  // on screen is the frame that was there when the button went down, and it
  // stays that way through a resize, a zoom and a reload of the shadow settings
  // — which is the entire point of the thing. See the freeze-frame section.
  if (paused) { renderer.render(scene, camera); return; }
  const t = transport();

  // On stage exactly when it is being danced. Before the transport starts there
  // is nothing to place the chairs by, so they would be found standing at their
  // slots behind the opening sheet instead of walking on from the dark.
  const onStage = started && t.running;
  stage.visible = onStage;

  if (onStage) {
    const bar = t.bar;
    // Each troupe's clock runs from the bar it walked on at, not from bar zero
    // over a fixed length: that is what lets the sheet call one on early, and
    // what keeps the time-on-stage slider from throwing whoever is mid-dance
    // straight off. The next is called while the last still has its exit to
    // play, so for OVERLAP_BARS there are two out there.
    const lead = troupes[troupes.length - 1];
    if (bar - lead.cycleStart >= troupeBars - OVERLAP_BARS) {
      let at = lead.cycleStart + troupeBars - OVERLAP_BARS;
      // If the tab was away for a while, don't march through every troupe that
      // was missed one frame at a time — pick up from here.
      if (bar - at > troupeBars) at = Math.floor(bar);
      sendInTroupe(at);
    }

    jolt = Math.max(jolt - dt * 2.6, t.accent);
    for (const tr of troupes) {
      const localBar = bar - tr.cycleStart;
      const phrase = Math.floor(Math.max(0, localBar - ENTER_BARS) / 4) % tr.moves.length;
      const move = tr.moves[phrase];
      // The crossing is carried on the troupe's group rather than on every chair,
      // so it travels as one body and each chair's own dance, drift and stutter
      // all stay written against a slot that never moves.
      placeTroupe(tr, localBar);
      for (const c of tr.chairs) updateChair(c, tr, t, localBar, move, jolt, dt);
    }
    // Anyone who has finished their exit leaves for good.
    while (troupes.length > 1 && bar - troupes[0].cycleStart > troupeBars) {
      disposeTroupe(troupes.shift());
    }
    // The scene change rides the same clock as the changeover.
    applyRig((bar - gelFadeStart) / GEL_FADE_BARS);
  }

  if (listening && showMeter) {
    // Sharp on the beat and gone by the next one, which is what makes it read
    // as a strike rather than as a blinking light. Counted on the beat of the
    // room rather than of the stage, so it agrees with the figure beside it.
    // Scaling the decay by the same ratio cancels it back out of the exponent,
    // which leaves the strike exactly the length it has always been rather than
    // smearing it across the longer gap a folded beat leaves behind.
    const b = t.beat / meterRatio;
    const flash = Math.exp(-(b - Math.floor(b)) * 5 * meterRatio);
    bpmDot.style.opacity = (0.3 + 0.7 * flash).toFixed(2);
    bpmDot.style.transform = `scale(${(0.85 + 0.4 * flash).toFixed(2)})`;
  }

  updateRig(t);
  placeCamera();
  renderer.render(scene, camera);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Never closer than the shot asked for, and never so far back that the troupe
  // turns into a row of specks — past about two and a half a phone is better off
  // simply letting the ends of the parade run out of frame.
  aspectPull = Math.min(2.5, Math.max(1, REF_ASPECT / camera.aspect));
  camera.updateProjectionMatrix();
  // A held frame draws nowhere else, so without this the window can be resized
  // and the picture stays at the old size until somebody presses Play.
  if (paused) redrawStill();
}
window.addEventListener('resize', resize);
resize();

// -------------------------------------------------------------- interaction
// A press that does not move is a shout: the band throws a stab and the whole
// cast snaps to it. Movement is still tracked, but only so a scroll or a swipe
// is not mistaken for one — the camera does not turn, so there is nothing for a
// drag to do.
let dragging = false;
let dragMoved = false;
let lastX = 0, lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (menuOpen) return;
  dragging = true;
  dragMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 3) dragMoved = true;
});

canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  if (dragMoved) return;
  // Audio has to start from a finished gesture, so a first tap doubles as the
  // unlock if the sheet was dismissed some other way.
  if (!started) { begin(); return; }
  accent();
  jolt = 1;
});

// The wheel moves the seat along its own axis and nothing else: closer or
// further, never around.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.r = Math.max(2.5, Math.min(20, cam.r + e.deltaY * 0.01));
  // Getting closer is the one useful thing to do to a held frame, so the wheel
  // keeps working while it is held and redraws on the spot.
  if (paused) redrawStill();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (menuOpen) { if (e.key === 'Escape') closeMenu(); return; }
  if (e.key === 'Escape') { openMenu(); return; }
  if (e.repeat) return;
  // A key pressed with a header button focused is aimed at the button, not at
  // the chairs — Space and Enter activate it, and shouting as well would pause
  // and jolt on one press.
  if (e.target instanceof Element && e.target.closest('.bar')) return;
  if (!started) return;
  accent();
  jolt = 1;
});

// -------------------------------------------------------------- freeze frame
// Everything in this section exists so a picture can be argued about.
//
// An artifact spotted mid-dance is gone by the time anyone has looked at it
// twice, and a shadow fix that cannot be held up against the exact frame it was
// meant to fix is a guess with a screenshot attached. So: PAUSE holds the frame
// outright, SAVE writes it out as JSON, and LOAD stands the same one back up —
// same chairs, same poses, same rig, same seat — however many reloads later.
//
// A loaded scene is a still, not a sim to carry on from: the chairs are plain
// meshes at fixed transforms with nothing driving them. The live cast is not
// thrown away though, only hidden, so Play drops the still and the show picks up
// wherever the audio clock has got to in the meantime.
const pauseBtn = document.getElementById('pause-btn');
const saveBtn = document.getElementById('save-btn');
const loadBtn = document.getElementById('load-btn');
const toastEl = document.getElementById('toast');

// What was opened, kept verbatim so Save on a loaded still hands back the same
// still rather than a snapshot of the live cast hiding behind it.
let loadedData = null;
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

/** Draw the held frame again, after something that is allowed to change it. */
function redrawStill() {
  placeCamera();
  renderer.render(scene, camera);
}

function setPaused(on) {
  if (paused === on) return;
  paused = on;
  if (!paused) dropTableau();
  pauseBtn.textContent = paused ? 'Play' : 'Pause';
  pauseBtn.setAttribute('aria-pressed', String(paused));
  if (paused) redrawStill();
}

function dropTableau() {
  if (!tableau) return;
  scene.remove(tableau);
  for (const m of tableau.children) m.material.dispose();
  tableau = null;
  loadedData = null;
}

pauseBtn.addEventListener('click', () => setPaused(!paused));

// ------------------------------------------------------------ the still, saved
// Rounded on the way out: this is a file a person opens and reads, and sixteen
// digits of a chair's z is not a fact about the scene, it is float noise.
const num = (n, places = 4) => +n.toFixed(places);
const triple = (v, places = 4) => [num(v.x, places), num(v.y, places), num(v.z, places)];
const hexOf = (c) => '#' + c.getHexString();

const _snapP = new THREE.Vector3();
const _snapQ = new THREE.Quaternion();
const _snapS = new THREE.Vector3();

/** A mesh's WORLD transform, because the troupe group it rides on is not saved. */
function poseOf(mesh) {
  mesh.updateWorldMatrix(true, false);
  mesh.matrixWorld.decompose(_snapP, _snapQ, _snapS);
  return {
    p: triple(_snapP, 4),
    q: [num(_snapQ.x, 5), num(_snapQ.y, 5), num(_snapQ.z, 5), num(_snapQ.w, 5)],
    s: num(_snapS.x, 4),
  };
}

/**
 * The whole picture as data. Not the machinery that produced it — no seeds, no
 * beat, no troupe clocks — because a still that had to be re-derived from a seed
 * would only be as reproducible as the code that derives it, and the code is the
 * thing under suspicion. Poses and colors are what was actually drawn.
 */
function sceneSnapshot() {
  const chairs = [];
  for (const tr of troupes) {
    for (const c of tr.chairs) {
      const mat = c.mesh.material;
      const rec = {
        kind: c.kind,
        ...poseOf(c.mesh),
        color: hexOf(mat.color),
        rough: num(mat.roughness, 3),
        metal: num(mat.metalness, 3),
      };
      if (mat.emissiveIntensity > 0 && mat.emissive.getHex() !== 0) {
        rec.emissive = hexOf(mat.emissive);
        rec.glow = num(mat.emissiveIntensity, 3);
      }
      if (c.ghost && c.ghost.visible) {
        rec.ghost = {
          ...poseOf(c.ghost),
          color: hexOf(c.ghost.material.color),
          opacity: num(c.ghost.material.opacity, 3),
        };
      }
      chairs.push(rec);
    }
  }
  return {
    app: 'hey-chair',
    version: 1,
    // Not read back — the poses below are the scene. Kept because knowing which
    // run and which troupe a still came out of is the first question anybody
    // asks of one, and ?seed= can put the whole run back.
    run: { seed: RUN_SEED, troupe: troupeIndex },
    camera: { r: num(cam.r, 3), aspectPull: num(aspectPull, 4) },
    rig: {
      lamps: allLamps.map((l) => ({
        color: hexOf(l.light.color),
        intensity: num(l.light.intensity, 2),
        from: triple(l.light.position, 3),
        at: triple(l.light.target.position, 3),
        beam: num(l.beam.material.uniforms.uOpacity.value, 4),
        pool: num(l.pool.material.uniforms.uOpacity.value, 4),
        poolAt: triple(l.pool.position, 3),
        poolSize: num(l.pool.scale.x, 3),
      })),
      cyc: hexOf(cyc.material.uniforms.uColor.value),
      fog: { near: num(scene.fog.near, 3), far: num(scene.fog.far, 3) },
    },
    chairs,
  };
}

/** Stand a saved still back up, and hold it. */
function loadSceneSnapshot(data) {
  if (!data || data.app !== 'hey-chair' || !Array.isArray(data.chairs)) {
    throw new Error('not a Hey Chair scene');
  }
  dropTableau();

  const group = new THREE.Group();
  const pose = (mesh, rec) => {
    mesh.position.fromArray(rec.p);
    mesh.quaternion.fromArray(rec.q);
    mesh.scale.setScalar(rec.s);
  };
  for (const rec of data.chairs) {
    const geo = GEOMETRIES[rec.kind] || GEOMETRIES[0];
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(rec.color),
      roughness: rec.rough,
      metalness: rec.metal,
    });
    if (rec.emissive) {
      mat.emissive = new THREE.Color(rec.emissive);
      mat.emissiveIntensity = rec.glow ?? 1;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pose(mesh, rec);
    group.add(mesh);
    if (rec.ghost) {
      const ghost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(rec.ghost.color),
        transparent: true,
        opacity: rec.ghost.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      pose(ghost, rec.ghost);
      group.add(ghost);
    }
  }
  scene.add(group);
  tableau = group;
  loadedData = data;
  // The live cast steps aside rather than being disposed, so Play is a return to
  // the show rather than a restart of it.
  stage.visible = false;

  const rig = data.rig;
  if (rig) {
    (rig.lamps || []).forEach((rec, i) => {
      const l = allLamps[i];
      if (!l) return;
      l.color.set(rec.color);
      l.light.color.set(rec.color);
      l.light.intensity = rec.intensity;
      l.light.position.fromArray(rec.from);
      l.light.target.position.fromArray(rec.at);
      l.light.target.updateMatrixWorld();
      l.beam.material.uniforms.uColor.value.set(rec.color);
      l.beam.material.uniforms.uOpacity.value = rec.beam;
      l.pool.material.uniforms.uColor.value.set(rec.color);
      l.pool.material.uniforms.uOpacity.value = rec.pool;
      l.pool.position.set(rec.poolAt[0], l.pool.position.y, rec.poolAt[2]);
      l.pool.scale.setScalar(rec.poolSize);
    });
    if (rig.cyc) {
      cyc.material.uniforms.uColor.value.set(rig.cyc);
      floorMat.emissive.set(rig.cyc);
      scene.background.set(rig.cyc);
      scene.fog.color.set(rig.cyc);
    }
  }

  // The seat. placeCamera derives fog from the radius, so the saved fog is put
  // back after it rather than before — and aspectPull is only honored until the
  // next resize, which is the honest thing: a still saved on a wide window and
  // reopened on a narrow one cannot be the same shot.
  if (data.camera) {
    cam.r = data.camera.r ?? cam.r;
    if (data.camera.aspectPull) aspectPull = data.camera.aspectPull;
  }
  placeCamera();
  if (rig && rig.fog) {
    scene.fog.near = rig.fog.near;
    scene.fog.far = rig.fog.far;
  }
  // Last, and only now: a shaft is a quad rolled to face the eye, so aiming one
  // before the seat has been set rolls it at whatever the camera was doing
  // before the file was opened.
  for (const l of allLamps) {
    const throwLen = l.light.position.distanceTo(l.light.target.position);
    aimBeam(l.beam, l.light.position, l.light.target.position,
      Math.max(0.5, Math.tan(l.light.angle) * throwLen * 0.5));
  }

  paused = true;
  pauseBtn.textContent = 'Play';
  pauseBtn.setAttribute('aria-pressed', 'true');
  renderer.render(scene, camera);
}
// Reachable from a harness, which drives the app through the DOM everywhere
// else but has no way to hand it a file it did not build first.
window.sceneSnapshot = sceneSnapshot;
window.loadSceneSnapshot = loadSceneSnapshot;

function stamp() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

saveBtn.addEventListener('click', () => {
  // A still that is already up is handed straight back, camera and all, so a
  // save-load-save round trip is the identity rather than a slow drift.
  const data = loadedData
    ? { ...loadedData, camera: { r: num(cam.r, 3), aspectPull: num(aspectPull, 4) } }
    : sceneSnapshot();
  // The codebase that wrote the file, stamped last so a loaded-then-resaved
  // still reports the build that wrote it and not the one it came in with.
  // Kept out of sceneSnapshot(), which the harnesses compare against fixtures.
  const doc = { ...data, build: window.buildVersion?.() ?? 'unknown' };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `hey-chair-${stamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  toast(`Scene saved, ${data.chairs.length} chair${data.chairs.length === 1 ? '' : 's'}`);
});

// Kept out of the markup because nothing in the sheet should be able to focus
// it, and given an id anyway so a headless harness can put a file into it.
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
      toast('Scene loaded, held');
    } catch {
      toast('Not a Hey Chair scene');
    }
  };
  reader.onerror = () => toast('That file could not be read');
  reader.readAsText(file);
});

// ------------------------------------------------------------ settings sheet
const menuBtn = document.getElementById('menu-btn');
const closeBtn = document.getElementById('close-btn');
const doneBtn = document.getElementById('done-btn');
const scrim = document.getElementById('scrim');
let menuOpen = false;

function openMenu() {
  menuOpen = true;
  scrim.hidden = false;
  document.body.classList.add('menu-open');
  menuBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  menuOpen = false;
  scrim.hidden = true;
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', openMenu);
closeBtn.addEventListener('click', closeMenu);
doneBtn.addEventListener('click', () => { begin(); closeMenu(); });
// A modal: the backdrop swallows the press but never dismisses. A drag that
// starts on a fader and wanders off the sheet releases over the backdrop, and
// the browser hands that click to the nearest ancestor of press and release —
// the scrim — which would otherwise close the sheet mid-adjustment.
scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) e.preventDefault(); });

/** First gesture: start the band, and let the show run. */
async function begin() {
  // The transport starts at bar 0, and the troupe waiting in the wings behind the
  // sheet is the one that performs — it walks on from there.
  started = true;
  HeaderVolume.setUnlockable(true);
  await startAudio();
}

// Sound lives in the header now: one slider, silent the first time and remembered after, in the same spot
// in every app in the gallery. Dragging it wakes a context the browser may have
// let go stale, but it does not start the show — the sheet's button does that.
HeaderVolume.onGesture(() => { if (started) wakeAudio(); });
HeaderVolume.onChange(setVolume);
// Until the sheet's button puts the band on stage there is nothing for a tap on
// the volume to wake, so the control does not offer one. begin() hands it back.
HeaderVolume.setUnlockable(false);

const tempo = document.getElementById('tempo');
const tempoVal = document.getElementById('tempo-val');
tempo.addEventListener('input', () => {
  setTempo(tempo.valueAsNumber);
  tempoVal.textContent = tempo.value + ' BPM';
});

// -------------------------------------------------------- following the room
// The microphone gives us a tempo and a downbeat. Neither is handed to the
// stage: they go to the band's clock, which is what the chairs read every frame
// anyway, so a room's beat arrives by exactly the same route the band's does and
// nothing in the choreography has to know where the beat came from.
//
// The band goes quiet while this is on. It is the loudest thing in the room by
// some distance, and left playing the detector would lock onto its own kick
// drum and report the tempo it was already running at.
const listenToggle = document.getElementById('listen-toggle');
const listenStatus = document.getElementById('listen-status');
const bpmMeter = document.getElementById('bpm-meter');
const bpmDot = document.getElementById('bpm-dot');
const bpmText = document.getElementById('bpm-text');
const meterToggle = document.getElementById('meter-toggle');
const micRow = document.getElementById('mic-row');
const micSelect = document.getElementById('mic-select');
// Remembered, because the browser will offer the system default every time and
// the system default is how this went wrong in the first place.
const MIC_KEY = 'hey-chair-input';
const rememberedMic = () => { try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; } };
const rememberMic = (id) => { try { localStorage.setItem(MIC_KEY, id); } catch { /* private window */ } };
let statusTimer = null;
let listening = false;  // the microphone is ours and it has the sheet's controls
let snapNext = false;   // the first correction may jump; every one after eases

const LISTEN_TEXT = {
  asking: ['Asking for the microphone…', false],
  listening: ['Listening for a beat…', false],
  quiet: ['Too quiet to hear a beat.', false],
  // Permission was granted, a live track was handed over, and it carries
  // nothing but zeros. On a Mac that is very often the browser itself never
  // having been given access at the SYSTEM level: the page's own permission is
  // a separate thing, and with one granted and the other not, this is exactly
  // what arrives — a track that opens, stays live, and is silent.
  // Filled in at the point of failure, because the only thing worth saying here
  // is WHICH microphone went quiet — see silentText().
  silent: ['The microphone is open but completely silent.', true],
  asleep: ['Take the stage, and this starts listening with it.', false],
  lost: ['The microphone was taken away. Switch this off and on to get it back.', true],
  denied: ['The microphone is blocked. Allow it for this site, then try again.', true],
  missing: ['No microphone found.', true],
  // Permission was granted and the device still would not open. On a Mac that
  // is almost always the system rather than the browser, and it is worth saying
  // where to go: the browser will not ask a second time on its own.
  busy: ['The microphone would not open. Another app may have it, or this browser may need turning on under System Settings, Privacy and Security, Microphone.', true],
  insecure: ['The microphone needs a secure connection.', true],
  error: ['The microphone could not be opened.', true],
};

function showStatus(text, warn) {
  listenStatus.textContent = text;
  listenStatus.classList.toggle('warn', !!warn);
  listenStatus.hidden = false;
}

/** A failure nobody anticipated should at least say its own name, or the only
 *  thing anyone can report about it is that it did not work. */
function sayStatus(status, fallback) {
  const [text, warn] = LISTEN_TEXT[status] || fallback;
  const detail = listenState().detail;
  showStatus(status === 'error' && detail ? `${text} (${detail})` : text, warn);
}

/**
 * How loud the room is, as a percentage of the range this can work with. On a
 * log scale, because loudness is: half of everything a microphone hears lives
 * in the bottom tenth of a linear one.
 */
function inputMeter(level) {
  if (!(level > 0)) return 0;
  const u = Math.log10(level / 0.0004) / Math.log10(0.3 / 0.0004);
  return Math.max(0, Math.min(100, Math.round(u * 100)));
}

/**
 * A microphone that opened and delivers nothing but zeros is almost never a
 * quiet room — a real one in a silent house still reads something. Overwhelmingly
 * it is the wrong device: a machine can have several inputs, one of them is the
 * system default, and a virtual or loopback device with nothing routed into it
 * is live, willing, and completely silent. So name the one we were given, and
 * name the others, which is the fact that actually resolves it.
 */
function silentText(s) {
  const name = inputName();
  const others = inputChoices().filter((n) => n !== name);
  const which = name ? ` The input is "${name}".` : '';
  const rest = others.length
    ? ` Other inputs on this machine: ${others.join(', ')}. Pick one in the browser's site settings for this page.`
    : ' Check the input the system is using, and that this browser is allowed a microphone in System Settings.';
  return `The microphone is open but completely silent.${which}${rest}`;
}

/**
 * Keep the picker in step with what is actually being heard — which is not
 * always what was asked for, since a dead input gets abandoned on its own.
 */
function refreshInputs() {
  const choices = inputChoices();
  const live = currentInputId();
  if (choices.length < 2) { micRow.hidden = true; micSelect.hidden = true; return; }
  const want = choices.map((d) => `${d.id}\u0000${d.label}`).join('|');
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

// The tempo the stage is actually running at, held still for a while at a time.
// A reading that changes every quarter second is not a thing anybody can read,
// and the last digit of a tempo is never the point — but a real change of track
// should not have to wait out the clock, so a large move goes up at once.
const METER_HOLD = 10;
const METER_JUMP = 5;
let meterShown = 0;
let meterAt = 0;
// Off, and the reading is not merely hidden: nothing is written to the DOM for
// it at all — not the number every quarter second, and not the two style
// properties the dot takes every single frame.
let showMeter = meterToggle.checked;
let meterLocked = false;
// Beats of the stage per beat of the number on screen. 1 unless fold() has
// doubled or halved the room to keep the chairs in the window they were
// choreographed for. Figure dashes, not hyphens: a figure dash is a digit wide,
// so the placeholder occupies exactly the space the reading will.
let meterRatio = 1;
const METER_WAITING = '‒‒‒';

function refreshMeter() {
  if (!showMeter) return;
  const s = listenState();
  // What the room is playing, before folding — not what the band's clock was
  // set to. The two part company on anything slow: at 72 in the room the stage
  // runs at 144, and 144 is the wrong answer to "what is this?". Until the
  // first estimate lands there is no heard tempo at all, and the honest thing
  // to show is that there isn't one, rather than the band's own idle pace.
  const heard = Math.round(s.heard);
  const now = performance.now() / 1000;
  // Struck on the beat of the number beside it. Left on the stage's beat it
  // would strike twice per beat of a doubled reading, and the dot and the
  // figure it sits next to would be saying different things.
  meterRatio = s.heard > 0 ? Math.max(0.2, transport().bpm / s.heard) : 1;

  const locked = s.status === 'locked';
  // The hold is there to stop a settled reading twitching, and it must not hold
  // a number from BEFORE the room was found: a room within METER_JUMP of the
  // last guess would otherwise sit on it for the whole hold, at full
  // brightness, having just dropped the dim that said it was still looking.
  const settled = locked && !meterLocked;
  meterLocked = locked;
  if (!heard) {
    bpmText.textContent = METER_WAITING;
    meterShown = 0;
  } else if (settled || !meterShown || Math.abs(heard - meterShown) >= METER_JUMP || now - meterAt >= METER_HOLD) {
    meterShown = heard;
    meterAt = now;
    // Three digits whatever the tempo. Centered, a number that changes width
    // shifts on the screen, and the reading appears to move when it has not.
    bpmText.textContent = String(heard).padStart(3, '0');
  }
  // Dimmed until it has settled on the room, so an estimate still being argued
  // with does not read as a measurement.
  bpmMeter.classList.toggle('searching', !locked);
}

/** Show it or take it away, from whichever of the two switches just moved. */
function applyMeter() {
  const show = listening && showMeter;
  // Filled in before it is unhidden, or it comes up on the last tempo it read.
  if (show) { meterShown = 0; meterLocked = false; meterRatio = 1; refreshMeter(); }
  bpmMeter.hidden = !show;
}

meterToggle.addEventListener('change', () => {
  showMeter = meterToggle.checked;
  applyMeter();
});

function refreshStatus() {
  refreshInputs();
  refreshMeter();
  const s = listenState();
  if (s.status !== 'locked') {
    // While it is listening and has not settled on anything, say what it can
    // hear. Without this the only report anybody can make is that it did not
    // work, and there is no telling a room that is too quiet from a microphone
    // that is handing over nothing at all.
    // Note the absence of a `level > 0` test here. There was one, and it threw
    // away the only reading that mattered: an input delivering exact digital
    // silence reads zero, so the case this detail was written to explain was
    // the single case it refused to print for.
    const heard = s.status === 'listening' || s.status === 'quiet' || s.status === 'silent';
    if (heard) {
      const [text, warn] = LISTEN_TEXT[s.status] || LISTEN_TEXT.listening;
      // Nothing arriving is a fault, not a state: carry the details of the
      // input path with it, because there is no way to work out from the
      // outside why a microphone that opened is handing over silence.
      if (s.status === 'silent') { showStatus(silentText(s), true); return; }
      showStatus(`${text} Input ${inputMeter(s.level)}%.`, warn);
      return;
    }
    sayStatus(s.status, LISTEN_TEXT.listening);
    return;
  }
  const bpm = Math.round(s.bpm);
  const heard = Math.round(s.heard);
  // Say so when the room is being danced at half or double what it is playing,
  // or the readout looks like the detector simply got it wrong.
  const note = Math.abs(heard - bpm) < 2 ? ''
    : heard > bpm ? `, half of the ${heard} in the room`
      : `, double the ${heard} in the room`;
  showStatus(`Locked to ${bpm} BPM${note}.`, false);
  // The fader becomes a meter: disabled, but still reading out what it is on.
  tempo.value = String(Math.round(Math.max(80, Math.min(140, s.bpm))));
  tempoVal.textContent = bpm + ' BPM';
}

/** Every settled estimate: pull the clock onto it. */
function onRoomBeat(s) {
  const wasRunning = transport().running;
  lockTo(s.bpm, s.beatTime, snapNext);
  // Snapping is only free before the chairs are dancing to it. Once the clock
  // is running, the first correction lands and the rest ease in.
  if (wasRunning) snapNext = false;
}

async function beginListening() {
  showStatus(...LISTEN_TEXT.asking);
  // Both of these are asked for here, in the same breath, and only sorted out
  // afterwards. Waking the context and awaiting THAT before asking for the
  // microphone is the obvious order and the wrong one: Safari treats a user
  // gesture as spent at the first await, so the microphone request arrives with
  // no permission behind it and is refused before anyone is asked anything.
  // Nothing awaits this if the microphone falls over first, so give it a home.
  const woken = wakeAudio().catch(() => {});
  const status = await startListening(audioContext(), onRoomBeat, woken, rememberedMic());
  // A permission prompt that is dismissed rather than answered never settles,
  // so the toggle stays live throughout and turning it back off is the way out.
  // If that is what happened, hand the device straight back.
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
  listening = true;
  applyMeter();
  snapNext = true;
  // The band goes quiet for the duration: the microphone would otherwise hear
  // the piece and follow itself.
  setMuted(true);
  HeaderVolume.setEnabled(false, 'Silent while listening to the room');
  tempo.disabled = true;
  statusTimer = setInterval(refreshStatus, 250);
  refreshStatus();
}

micSelect.addEventListener('change', async () => {
  const id = micSelect.value;
  rememberMic(id);
  showStatus('Switching microphone…', false);
  await useInput(id);
  refreshStatus();
});

function endListening() {
  stopListening();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  listenStatus.hidden = true;
  bpmMeter.hidden = true;
  meterShown = 0;
  micRow.hidden = true;
  micSelect.hidden = true;
  // Turned off again before it ever took anything over: there is nothing to
  // give back, and handing back a Sound setting we never saved would clobber it.
  if (!listening) return;
  listening = false;
  setMuted(false);
  HeaderVolume.setEnabled(true);
  tempo.disabled = false;
  // Leave the pace where the room left it rather than snapping back to whatever
  // the fader said before, and move the fader to match.
  setTempo(tempo.valueAsNumber);
  tempoVal.textContent = tempo.value + ' BPM';
}

listenToggle.addEventListener('change', () => {
  if (listenToggle.checked) beginListening();
  else endListening();
});

/**
 * Rebuild the troupe that is waiting in the wings. It is built at load, before
 * anybody has had the chance to touch a setting, so anything decided in the
 * sheet before the curtain goes up would otherwise not reach the stage until
 * the SECOND troupe — set the size to twelve, press the button, and three
 * chairs walk on. Same index, so it is the same cast, differently arranged.
 */
function restageWings() {
  if (started) return;
  disposeTroupe(troupes.pop());
  troupes.push(buildTroupe(troupeIndex, 0));
  dressRig(troupes[0].gel, 0);
  applyRig(1);
}

const size = document.getElementById('size');
const sizeVal = document.getElementById('size-val');
size.addEventListener('input', () => {
  troupeSize = size.valueAsNumber;
  sizeVal.textContent = size.value;
  restageWings();
});

const stay = document.getElementById('stay');
const stayVal = document.getElementById('stay-val');
stay.addEventListener('input', () => {
  troupeBars = stay.valueAsNumber;
  stayVal.textContent = stay.value + ' bars';
});

const odd = document.getElementById('odd');
const oddVal = document.getElementById('odd-val');
odd.addEventListener('input', () => {
  oddShare = odd.valueAsNumber / 100;
  oddVal.textContent = odd.value + '%';
  restageWings();
});

// The sheet is the source of truth for every starting value. Read once here so
// the controls and the show cannot drift apart: changing a default means editing
// one number in the markup, not two that have to agree.
setTempo(tempo.valueAsNumber);
troupeSize = size.valueAsNumber;
troupeBars = stay.valueAsNumber;
oddShare = odd.valueAsNumber / 100;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resync();
});

// ----------------------------------------------------------------------- go
// The first troupe is built now, but only so the rig is already wearing its gel
// and the stage does not change color the moment the show starts. It is held off
// until the sheet is dismissed: the curtain goes up on an empty stage and the
// chairs walk on, rather than being discovered standing there waiting.
troupes.push(buildTroupe(troupeIndex, 0));
dressRig(troupes[0].gel, 0);
applyRig(1);
stage.visible = false;
openMenu();
animate();
