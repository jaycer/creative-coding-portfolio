// Chair Pile — chairs fall out of the dark and pile up forever.
//
// One chair floats above the pile at a time. Any tap or keypress drops it; a
// couple of seconds later the next fades in. The physics collider is built from the
// same boxes as the visible chair, so legs really do snag on slats and the pile
// interlocks the way the shapes suggest.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as CANNON from 'cannon-es';
import { initAudio, resumeAudio, clatter, setMuted, isMuted, setTimbre, getTimbre } from './audio.js';

const SPAWN_DELAY_MS = 2000;   // gap between a chair landing and the next appearing
const FREEZE_BEHIND = 25;      // chairs this far down the pile turn to static bedrock
const PILE_RADIUS = 1.3;       // chairs beyond this from the drop column are strays
// Both scaled together, so a chair falls the same way onto a tall pile as onto
// an empty floor. The gap is what gets scaled, not the height above the floor:
// the chair floats over the pile, so scaling its absolute height would stretch
// the fall further the taller the heap got, and a drop that grows without bound
// would end up scattering the pile it is supposed to be building.
const SPAWN_GAP = 2.55;        // how far above the pile the next chair floats
const MIN_SPAWN_Y = 3.6;       // floating height over an empty floor
const REST_SPEED = 0.4;        // m/s under which a chair counts as come to rest
const MIN_FALL_TIME = 0.4;     // s of falling before a chair can be called landed
const HIT_MIN_SPEED = 0.7;     // m/s of impact under which a contact makes no sound
const HIT_COOLDOWN_MS = 70;    // one chair can only speak this often
const HIT_LOUD_SPEED = 5;      // impact speed that counts as a full-strength bang
const BUMP_LEVEL = 0.32;       // how loudly a chair already at rest answers when knocked

// Framing. The view is centered at spanTop * FOCUS_BIAS and reaches
// spanTop * 0.5 * FRAME_MARGIN above that, so the top edge lands at
// spanTop * (FOCUS_BIAS + 0.5 * FRAME_MARGIN). That has to clear 1.0 or the
// floating chair hangs off the top of the screen — at 0.45 the margin must
// exceed 1.1.
//
// It needs to clear it by more than it looks, though, so the nominal 1.1 is not
// the number to sail close to. That arithmetic measures the frame where the
// camera is pointed, but the floating chair is the one thing above the view
// axis: it sits nearer than the target plane, where the frame is narrower than
// the half-extent used here, and the error runs to about 5% at the angle the
// camera keeps. The chair also bobs, spawns off-center, and lands on a random
// tilt that reaches further above its origin than its own half-height does. Each
// is small; together they cost more than the 5% that a margin of 1.2 left over.
const FOCUS_BIAS = 0.45;       // <0.5 sits the view low, giving the pile the frame
const FRAME_MARGIN = 1.35;
const EXPLORE_FRACTION = 0.8;  // closer than this share of the fit = exploring, so stop framing

// Demo mode. The camera orbits on its own and breathes in and out on a slow
// sine, while chairs drop themselves. The zoom is expressed as a share of the
// framing distance rather than in meters, so it keeps its composition as the
// pile grows and the fit distance climbs with it.
const DEMO_DWELL_MS = 1500;    // how long a chair is left floating before demo drops it
const DEMO_ORBIT_SPEED = 0.55; // OrbitControls units: about one lap every two minutes
const DEMO_ZOOM_PERIOD = 26;   // seconds for one full breath in and back out
const DEMO_ZOOM_NEAR = 0.4;    // closest approach, as a share of the framing distance
const DEMO_ZOOM_FAR = 0.98;    // and the far end of the breath, just inside the fit

/** Barely moving — resting or being jostled, as opposed to falling. */
function atRest(body) {
  return body.velocity.lengthSquared() < REST_SPEED * REST_SPEED
    && body.angularVelocity.lengthSquared() < 1.0;
}

// ---------------------------------------------------------------- chair shape
// Parts of a plain four-leg dining chair, in meters, with y=0 at the floor.
// Both the mesh and the physics compound are generated from this one list.
const SEAT_W = 0.46, SEAT_D = 0.44, SEAT_T = 0.05, SEAT_Y = 0.44;
const LEG = 0.05, LEG_H = 0.44;
const LEG_X = SEAT_W / 2 - LEG / 2;
const LEG_Z = SEAT_D / 2 - LEG / 2;
const BACK_H = 0.55;

const CHAIR_PARTS = [
  // seat
  { size: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
  // legs
  { size: [LEG, LEG_H, LEG], pos: [ LEG_X, LEG_H / 2,  LEG_Z] },
  { size: [LEG, LEG_H, LEG], pos: [-LEG_X, LEG_H / 2,  LEG_Z] },
  { size: [LEG, LEG_H, LEG], pos: [ LEG_X, LEG_H / 2, -LEG_Z] },
  { size: [LEG, LEG_H, LEG], pos: [-LEG_X, LEG_H / 2, -LEG_Z] },
  // back posts
  { size: [LEG, BACK_H, LEG], pos: [ LEG_X, SEAT_Y + SEAT_T + BACK_H / 2, -LEG_Z] },
  { size: [LEG, BACK_H, LEG], pos: [-LEG_X, SEAT_Y + SEAT_T + BACK_H / 2, -LEG_Z] },
  // back slats, with gaps for legs to catch in
  { size: [SEAT_W - LEG * 2, 0.07, 0.035], pos: [0, 0.66, -LEG_Z] },
  { size: [SEAT_W - LEG * 2, 0.07, 0.035], pos: [0, 0.80, -LEG_Z] },
  // top rail
  { size: [SEAT_W, 0.07, LEG], pos: [0, SEAT_Y + SEAT_T + BACK_H - 0.035, -LEG_Z] },
];

const CHAIR_TOP = SEAT_Y + SEAT_T + BACK_H;
const CHAIR_MID = CHAIR_TOP / 2; // shift parts down by this so the body origin sits mid-chair

const PALETTE = [
  0xc98a45, // oak
  0x8f5a34, // walnut
  0xd6cbb4, // bone
  0x6f7d8c, // slate
  0xa8493f, // rust
  0x4f6b53, // sage
  0xc9ad4a, // mustard
  0xb8b3aa, // ash
];

/** One merged geometry, shared by every chair — the origin sits at mid-chair. */
function buildChairGeometry() {
  const boxes = CHAIR_PARTS.map((part) => {
    const geo = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
    geo.translate(part.pos[0], part.pos[1] - CHAIR_MID, part.pos[2]);
    return geo;
  });
  return mergeGeometries(boxes);
}

/** The matching compound collider: one cannon Box per visible box. */
function addChairShapes(body) {
  for (const part of CHAIR_PARTS) {
    const half = new CANNON.Vec3(part.size[0] / 2, part.size[1] / 2, part.size[2] / 2);
    const offset = new CANNON.Vec3(part.pos[0], part.pos[1] - CHAIR_MID, part.pos[2]);
    body.addShape(new CANNON.Box(half), offset);
  }
}

// -------------------------------------------------------------------- scene
// Cool near-black. The fog matches it exactly so the floor dissolves into the
// background instead of ending at a line. Denser fog blurs that horizon further:
// the floor fades out well before its true vanishing point, which spreads the
// transition over a wide band of screen rather than compressing it into an edge.
const VOID = 0x070b14;

// Fog is the one thing here measured from the camera rather than from the world,
// so a fixed density reads as a bubble of visibility that travels with the
// viewer — and the pile grows without bound while the framing pulls back to keep
// up, so ANY fixed density eventually swallows it whole. Instead, hold the haze
// on the pile constant and let the density fall as the camera retreats: at the
// framing distance the pile always sits at the same slight remove, while the
// floor's true horizon is always far enough beyond it to still dissolve.
// density = FOG_HAZE / dist puts fog(dist) = 1 - exp(-FOG_HAZE^2), about 15%.
const FOG_HAZE = 0.4;
const FOG_HOLD = 8; // stop thickening inside this: zoomed among the chairs, fog must not close in
const scene = new THREE.Scene();
scene.background = new THREE.Color(VOID);
scene.fog = new THREE.FogExp2(VOID, FOG_HAZE / FOG_HOLD);

// A near plane this close lets the camera push right through a chair without the
// surfaces clipping out early — see the zoom-through note on controls.minDistance.
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.03, 200);
camera.position.set(2.9, 2.1, 4.0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 1.2, 0);
// Zoom right in among the chairs and out the far side: the orbit center sits in
// the heap, so an almost-zero minimum lets the camera travel through it. Pan
// (right-drag or two-finger) moves that center, so the whole pile is explorable
// from the inside.
controls.minDistance = 0.05;
controls.maxDistance = 60; // headroom for auto-framing to pull back from a tall pile
controls.maxPolarAngle = Math.PI / 2 - 0.04; // stay above the floor
// Demo mode's orbit. Off until asked for; controls.update() already runs every
// frame, which is all autoRotate needs, and dragging still overrides it.
controls.autoRotate = false;
controls.autoRotateSpeed = DEMO_ORBIT_SPEED;

// Lit from above, softly: a wide key light plus cool sky bounce, no hard sun.
scene.add(new THREE.AmbientLight(0x9fb4c8, 0.22));
scene.add(new THREE.HemisphereLight(0x9fb4c8, 0x15171d, 0.5));

// A directional light is nothing but a direction — position only aims it and
// places its shadow camera. So this is the whole of the light's character, set
// once and never touched again: what makes a source read as fixed in the world
// is that orbiting past it changes which face is lit, and that only holds if the
// direction is constant. It has to ride up with the pile to keep the heap inside
// its shadow frustum, which aimKey does by moving the light and its target
// together, as one rigid pair.
// 35 degrees up, and about 90 degrees around from where the camera starts. Both
// halves matter: the low angle is what gives every chair a bright side and a
// dark one, but a low light sitting behind the viewer would only flatten the
// pile from the front and hide its own shadows behind it. Off to one side, the
// shadows rake across the floor where they can be seen.
const KEY_DIR = new THREE.Vector3(10, 8.5, -7).normalize(); // pile toward light
const KEY_STANDOFF = 22; // how far back it rides, on top of the pile's own height

// Brighter than the old overhead key at the same exposure. Light this low strikes
// the seats and the floor at a glance, and the cosine falloff costs those faces
// about a third of what a steeper light gave them; the vertical faces more than
// make it back, which is the whole point, but the flat ones need the make-up.
const key = new THREE.DirectionalLight(0xfff1dd, 2.4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.bias = -0.0012;
key.shadow.normalBias = 0.02;
scene.add(key);
scene.add(key.target);

let shadowSpan = -1;

/**
 * Ride the light up with the pile without ever turning it. Both ends move by the
 * same vector, so the direction survives untouched however tall the heap gets —
 * moving them by different amounts is what quietly tips a side light into an
 * overhead one, and an overhead light lands the same on every face, so orbiting
 * it reveals nothing and the source seems to travel with the viewer.
 */
function aimKey() {
  key.target.position.set(0, pileTopY * 0.5, 0);
  key.target.updateMatrixWorld();
  key.position.copy(key.target.position).addScaledVector(KEY_DIR, KEY_STANDOFF + pileTopY);

  // The frustum has to grow with the heap, and faster than the heap does. A
  // light held at 35 degrees rakes a shadow about 1.4x the pile's height across
  // the floor, and the box has to hold the receiving floor as well as the chairs
  // casting onto it: the shadow map is only sampled inside it, so a floor that
  // falls outside simply comes back lit and the shadow ends in a straight line.
  // The cost is resolution — the same 2048 map stretched over a wider box — but
  // a pile tall enough to notice it is a long way from the camera by then.
  const span = 10 + pileTopY * 1.1;
  if (Math.abs(span - shadowSpan) > 0.25) { // resizing every frame rebuilds the matrix for nothing
    shadowSpan = span;
    const cam = key.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.far = KEY_STANDOFF + pileTopY + span * 2;
    cam.updateProjectionMatrix();
  }
}

// Swung round to sit opposite the key, and left low and weak. A key this low
// leaves a genuinely dark side, which is the point — but with nothing coming the
// other way it goes to flat black and takes the shape of the chair with it. Cool
// against the key's warmth, and far too dim to compete: it says how deep the
// shadow is, not where the light comes from. Casts nothing, as before.
const fill = new THREE.DirectionalLight(0x8fa6c4, 0.3);
fill.position.set(-9, 4.5, 6);
scene.add(fill);

// A soft pool of light on the patch of floor the pile grows on. decay=0 keeps it
// distance-independent so it stays put as the pile rises, and penumbra=1 leaves
// no visible rim — just a slow brightening toward the middle. It deliberately
// casts no shadow: the key light already does, and a second set would read as a
// mistake. angle 0.42 at 9m up puts the falloff around 4m out, wider than the heap.
const pool = new THREE.SpotLight(0xdce8ff, 1.5, 0, 0.42, 1.0, 0);
pool.position.set(0, 9, 0);
pool.target.position.set(0, 0, 0);
scene.add(pool);
scene.add(pool.target);

/**
 * A tileable value-noise texture for the floor, drawn at runtime so the page
 * stays self-contained. Kept near white and low contrast: it multiplies the
 * floor color, so it reads as broad unevenness in the concrete rather than as a
 * pattern. Octaves are deliberately coarse — the smallest features still span
 * several chair-widths once it's stretched over the floor.
 */
function makeFloorTexture() {
  const SIZE = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(SIZE, SIZE);

  // Each octave is a lattice of random values that wraps, so the whole tile does.
  const octave = (cells) => {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
    return (x, y) => {
      const fx = x * cells, fy = y * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty); // smoothstep
      const at = (cx, cy) => grid[(cy % cells) * cells + (cx % cells)];
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    };
  };

  const layers = [[octave(3), 0.55], [octave(6), 0.28], [octave(12), 0.17]];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let n = 0;
      for (const [sample, weight] of layers) n += sample(x / SIZE, y / SIZE) * weight;
      // Spread around the mean, not across the raw range. Summing octaves
      // clusters n tightly about 0.5, so scaling [0,1] into a narrow band (the
      // obvious way to keep it subtle) leaves only a couple of percent of actual
      // variation and the mottling disappears entirely.
      const shade = Math.min(1, Math.max(0, 0.9 + (n - 0.5) * 0.3));
      const v = Math.round(255 * shade);
      const i = (y * SIZE + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  // ~10 units per tile, matching the floor's own size: 60 tiles over 600 units.
  // Tiles any larger than this and the patch of floor around the pile is less
  // than one tile wide, so the mottling flattens into a plain gradient and reads
  // as no texture at all. Here the coarsest octave lands around 3 units —
  // several chairs across, large but legible.
  texture.repeat.set(60, 60);
  // Enough to keep the mottling from smearing at grazing angles near the
  // horizon; the full 16x costs real sampling time on a floor this big for no
  // visible gain on texture this soft.
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

const floorTexture = makeFloorTexture();
// Two triangles, so the size is free — and it has to outrun the fog. The haze
// thins as the camera pulls back, which reaches further out into the floor, and
// a plane that ends inside the visible range shows its edge as a hard line
// against the void. This one always ends well past where the fog has closed.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshStandardMaterial({
    color: 0x5a636e, // cooler, bluer gray
    roughness: 0.94,
    metalness: 0.02,
    map: floorTexture,
    roughnessMap: floorTexture, // same mottling varies the sheen under the spot
  })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ------------------------------------------------------------------ physics
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.solver.iterations = 14;
world.solver.tolerance = 0.002;

const chairMat = new CANNON.Material('chair');
const floorMat = new CANNON.Material('floor');
// High friction, near-zero bounce: chairs should grab and settle, not skate away.
world.addContactMaterial(new CANNON.ContactMaterial(chairMat, chairMat, { friction: 0.6, restitution: 0.03 }));
world.addContactMaterial(new CANNON.ContactMaterial(chairMat, floorMat, { friction: 0.7, restitution: 0.02 }));

const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: floorMat });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

// -------------------------------------------------------------------- chairs
const chairGeometry = buildChairGeometry();
const materials = PALETTE.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.04 }));

const chairs = [];     // every dropped chair, in drop order
let freezeIdx = 0;     // chairs before this index are already frozen
let floating = null;   // the chair waiting in the air, if any
let pileTopY = 0;
let frozenTopY = 0;    // tallest frozen chair — fixed forever, so measured once
let dropped = 0;

const countEl = document.getElementById('count');

const _pan = new THREE.Vector3();

/** Frozen chairs are bedrock: welded in place, with their velocity zeroed. */
function isFrozen(chair) {
  return chair.body.type === CANNON.Body.STATIC;
}

/** Turn a physics contact into a knock, if it's worth hearing. */
function onCollide(chair, event) {
  // Bedrock has no rattle left in it — it cannot move, so there is nothing there
  // to hear. It also puts a ceiling on the racket: every chair ever dropped
  // stays in the world and stays able to answer, so without this the deeper the
  // pile got the louder every landing would be, forever.
  if (isFrozen(chair)) return;

  const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
  if (speed < HIT_MIN_SPEED) return; // a nudge, not a knock

  // A ten-box chair makes several contacts per landing, and a chair resting on
  // the pile keeps generating them forever. One knock per chair per cooldown
  // collapses both into the single sound the eye expects.
  const now = performance.now();
  if (now - chair.lastHitAt < HIT_COOLDOWN_MS) return;
  chair.lastHitAt = now;

  // Both chairs in a chair-on-chair hit are told about it, and both now answer.
  //
  // They didn't before, and which one was speaking was backwards: the tie-break
  // gave the pair to the lower id, and the lower id is always the older chair —
  // so what sounded on every landing was the chair already lying in the pile, at
  // full strength, while the chair that actually fell was silenced. A landing was
  // four or five settled chairs shouting at once, each at its own pitch, and no
  // voice for the impact itself. That chord is where the mush came from.
  //
  // So keep both voices and let the fall decide the level. The arriving chair is
  // still falling when it strikes, so it makes the knock; the chairs it lands on
  // have come to rest, so they answer under it — quietly, each in its own voice,
  // from its own place in the stereo field. Same count of voices, one of them now
  // in front.
  const level = chair.landed ? BUMP_LEVEL : 1;

  // Pan by where the chair sits across the current view rather than in world
  // space: the camera orbits, so world x has nothing to do with left and right.
  _pan.copy(chair.body.position);
  camera.worldToLocal(_pan);
  clatter(
    (speed / HIT_LOUD_SPEED) * level,
    chair.pitch,
    THREE.MathUtils.clamp(_pan.x / 3, -1, 1) * 0.7
  );
}

function makeChair() {
  const mesh = new THREE.Mesh(chairGeometry, materials[Math.floor(Math.random() * materials.length)]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 2.2, material: chairMat });
  addChairShapes(body);
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.12;
  body.sleepTimeLimit = 0.6;
  body.linearDamping = 0.05;
  body.angularDamping = 0.1;
  body.isChair = true;

  const chair = {
    mesh,
    body,
    landed: false,   // has it come to rest since being dropped: pile, not rain
    fallTime: 0,
    pitch: 0.82 + Math.random() * 0.46, // its own voice, for every hit it takes
    lastHitAt: 0,
  };
  body.addEventListener('collide', (event) => onCollide(chair, event));
  return chair;
}

/**
 * How high the next chair floats. The framing reads this too, rather than
 * re-deriving it from SPAWN_GAP alone: over a low pile the MIN_SPAWN_Y floor is
 * what actually decides the height, and a shot fitted to the gap instead would
 * be fitted to somewhere below the chair and crop it off the top.
 */
function spawnHeight() {
  return Math.max(pileTopY + SPAWN_GAP, MIN_SPAWN_Y);
}

function spawnFloating() {
  const chair = makeChair();
  // Just high enough to read as floating: a longer fall only scatters the pile.
  const spawnY = spawnHeight();
  chair.mesh.position.set((Math.random() - 0.5) * 0.36, spawnY, (Math.random() - 0.5) * 0.36);
  chair.mesh.rotation.set(
    (Math.random() - 0.5) * 1.0,
    Math.random() * Math.PI * 2,
    (Math.random() - 0.5) * 1.0
  );
  chair.baseY = spawnY;
  chair.phase = Math.random() * Math.PI * 2;
  chair.spin = (Math.random() - 0.5) * 0.5;
  chair.spawnedAt = performance.now(); // demo mode waits a beat from here before dropping it
  chair.mesh.scale.setScalar(0.01); // pops in over the first moments
  floating = chair;
}

function dropFloating() {
  if (!floating) return; // nothing waiting up there; the pile is between chairs
  const chair = floating;
  floating = null;

  chair.mesh.scale.setScalar(1); // honor a tap landing mid pop-in: snap to full size and go
  const p = chair.mesh.position;
  const q = chair.mesh.quaternion;
  chair.body.position.set(p.x, p.y, p.z);
  chair.body.quaternion.set(q.x, q.y, q.z, q.w);
  chair.body.angularVelocity.set(
    (Math.random() - 0.5) * 0.7,
    (Math.random() - 0.5) * 0.7,
    (Math.random() - 0.5) * 0.7
  );
  world.addBody(chair.body);
  chairs.push(chair);

  dropped += 1;
  countEl.textContent = dropped === 1 ? '1 chair' : `${dropped} chairs`;

  setTimeout(spawnFloating, SPAWN_DELAY_MS);
}

/**
 * Settled chairs deep in the pile become static: cheap, and the base stops
 * creeping. Only ever freezes a chair that is actually at rest, so one still
 * tumbling is never locked in place mid-motion — it just gets frozen on a later
 * frame once it comes to rest. Deliberately tests rest rather than the physics
 * engine's sleep state: chairs this deep are pinned but get knocked awake by
 * every landing above them, so waiting for sleep could stall the queue for good
 * and let the per-frame work grow without bound.
 */
function freezeSettled() {
  while (chairs.length - freezeIdx > FREEZE_BEHIND) {
    const chair = chairs[freezeIdx];
    if (!chair.landed || !atRest(chair.body)) break; // still moving; try again later
    freezeIdx++;
    chair.body.type = CANNON.Body.STATIC;
    chair.body.mass = 0;
    chair.body.updateMassProperties();
    chair.body.velocity.setZero();
    chair.body.angularVelocity.setZero();
    // Fold its height in now: a frozen chair can never move, so the per-frame
    // scan below never has to look at it again.
    if (Math.hypot(chair.body.position.x, chair.body.position.z) <= PILE_RADIUS) {
      frozenTopY = Math.max(frozenTopY, chair.body.position.y + CHAIR_MID);
    }
  }
}

// -------------------------------------------------------------------- input
// OrbitControls owns dragging, so only a short, still, primary-button pointerup
// counts as a tap. Right and middle are its pan and dolly gestures, and each
// pointer is tracked by id so a second finger can't be mistaken for the first.
const downs = new Map();

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // pan/dolly gestures are not taps
  downs.set(e.pointerId, { at: performance.now(), x: e.clientX, y: e.clientY });
});

renderer.domElement.addEventListener('pointerup', (e) => {
  initAudio(); // a completed gesture: the one moment the context may be created
  const down = downs.get(e.pointerId);
  if (!down) return;
  downs.delete(e.pointerId);
  if (downs.size > 0) return; // part of a multi-touch gesture, not a tap
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  if (moved < 6 && performance.now() - down.at < 400) dropFloating();
});

renderer.domElement.addEventListener('pointercancel', (e) => downs.delete(e.pointerId));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Tab') return;                                  // leave keyboard nav alone
  if (menuOpen) {
    if (e.key === 'Escape') closeMenu({ toButton: true });
    return; // no chair drops while the settings are up, whatever is focused
  }
  if (e.target.closest && e.target.closest('a, button')) return; // let the Gallery link work
  initAudio();
  dropFloating();
});

// Safari suspends the context when the tab goes away and only wakes on request.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resumeAudio();
});

// ---------------------------------------------------------------- settings
// The hamburger opens a centered overlay. Its scrim covers the canvas, so the
// click that dismisses it is swallowed there rather than dropping a chair, and
// the keydown handler above stands down for as long as the overlay is up.
const menuBtn = document.getElementById('menu-btn');
const scrim = document.getElementById('scrim');
const soundToggle = document.getElementById('sound-toggle');
const demoToggle = document.getElementById('demo-toggle');
const doneBtn = document.getElementById('done-btn');
const howEl = document.getElementById('how');
const timbreEl = document.getElementById('timbre');

let menuOpen = false;
let openedFromButton = false;
let demo = false;

// Whether this browser has met the piece before. The how-to lives in the overlay
// now, so a first-time visitor is shown it unasked — there is nothing else on
// screen that would tell them the chair is waiting on a tap.
const SEEN_KEY = 'chair-pile-seen';
const TIMBRE_KEY = 'chair-pile-timbre'; // which knock they settled on, kept for next time

function seenBefore() {
  // Storage is off entirely in some privacy modes, and reading it throws rather
  // than returning null. Treat that as a first visit: showing the how-to twice
  // is a smaller failure than never showing it, and than a dead sketch.
  try { return !!localStorage.getItem(SEEN_KEY); } catch { return false; }
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode: greet them again */ }
}

/**
 * fromButton says a real click opened this, which decides two things: whether
 * the audio context may be created (it may only be built inside a genuine
 * gesture, and the greeting on load is not one), and where focus goes on the way
 * back out.
 */
function openMenu({ fromButton }) {
  menuOpen = true;
  openedFromButton = fromButton;
  scrim.hidden = false;
  document.body.classList.add('menu-open'); // hold the header against the idle fade
  menuBtn.setAttribute('aria-expanded', 'true');
  if (fromButton) initAudio();
}

/**
 * Close, and put focus somewhere the page still works from. A mouse click
 * leaves its control focused, and the keydown handler ignores keys aimed at a
 * button — so "press any key" would quietly stop dropping chairs. Blur for the
 * pointer, hand it back to the hamburger for the keyboard, where losing your
 * place is worse than losing a keystroke.
 *
 * Only ever back to the hamburger, though, if that is where they came from. The
 * greeting on load came from nowhere: parking focus on a button they never
 * pressed would leave the keyboard aimed at the menu, and every key they then
 * pressed to drop a chair would go to it instead and do nothing.
 */
function closeMenu({ toButton }) {
  menuOpen = false;
  scrim.hidden = true;
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
  if (toButton && openedFromButton) menuBtn.focus();
  else if (document.activeElement) document.activeElement.blur();
}

menuBtn.addEventListener('click', (e) => {
  // detail 0 is a keyboard activation: only then does focus belong on the
  // button afterwards. A mouse click that lands there wants it back on the page.
  if (menuOpen) closeMenu({ toButton: e.detail === 0 });
  else openMenu({ fromButton: true });
});

// Only the scrim itself: a click that lands on the overlay is not a dismissal.
scrim.addEventListener('click', (e) => {
  if (e.target === scrim) closeMenu({ toButton: false });
});

doneBtn.addEventListener('click', (e) => closeMenu({ toButton: e.detail === 0 }));

soundToggle.checked = !isMuted();
soundToggle.addEventListener('change', () => {
  setMuted(!soundToggle.checked);
  initAudio(); // the click behind this change is a gesture too
});

demoToggle.addEventListener('change', () => {
  demo = demoToggle.checked;
  controls.autoRotate = demo;
  howEl.hidden = demo; // nothing to tell them to do while it plays itself
  initAudio(); // demo drops chairs with nothing else to unlock the audio
});

/** Light the chosen knock and dim the other. */
function paintTimbre() {
  for (const btn of timbreEl.querySelectorAll('.choice-btn')) {
    const on = btn.dataset.timbre === getTimbre();
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

// setTimbre ignores a name it does not know, so a stale or hand-edited value
// here leaves the default standing rather than breaking the sound.
try {
  const saved = localStorage.getItem(TIMBRE_KEY);
  if (saved) setTimbre(saved);
} catch { /* storage off: the default stands */ }
paintTimbre();

timbreEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.choice-btn');
  if (!btn) return;
  setTimbre(btn.dataset.timbre);
  try { localStorage.setItem(TIMBRE_KEY, getTimbre()); } catch { /* nothing to do */ }
  paintTimbre();
  initAudio(); // a click is a gesture, which is the only way the preview can sound
  clatter(0.85, 1, 0); // hear the choice now, rather than waiting for a chair to land
});

// Say hello, once ever. Marked on the way in rather than on the way out: someone
// who has read it and wandered off has been greeted, and reloading should not
// greet them again.
if (!seenBefore()) {
  markSeen();
  openMenu({ fromButton: false });
}

// --------------------------------------------------------------------- loop
const clock = new THREE.Clock();
let camFocusY = 1.2;
let framedTop = -1;                                    // pile height the framing was last fit to
let wantDist = camera.position.distanceTo(controls.target);
const _dir = new THREE.Vector3();

/**
 * Keep the floor, the pile, and the floating chair all in frame as the heap
 * grows. Only re-fits when the pile actually gets taller, and only ever pulls
 * back — so orbiting is never fought.
 *
 * Stands down entirely once the camera is well inside the framing distance,
 * which means the viewer has deliberately zoomed in among the chairs. Otherwise
 * the next chair to land would grow the pile, widen the fit, and quietly drag
 * them back out of the pile they were exploring.
 */
function frame(dt, t) {
  // Floor up to the top of the floating chair: its own height above its origin,
  // plus the bob. Measured from where the chair really is, so the low-pile case
  // where MIN_SPAWN_Y holds it up stays in shot.
  const spanTop = spawnHeight() + CHAIR_MID + 0.11;
  if (pileTopY > framedTop + 0.05) {
    framedTop = pileTopY;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const need = (spanTop * 0.5) / Math.tan(vFov / 2) * FRAME_MARGIN;
    wantDist = Math.max(wantDist, need);
  }

  _dir.subVectors(camera.position, controls.target);
  const dist = _dir.length();

  // Thin the haze as the camera retreats, so the pile keeps the same slight
  // remove at any zoom instead of dissolving into the void. Held below FOG_HOLD:
  // zoomed in among the chairs the orbit distance goes to almost nothing, and
  // dividing by it would pack the whole pile into solid fog.
  scene.fog.density = FOG_HAZE / Math.max(dist, FOG_HOLD);

  // The orbit center is both what the camera looks at and what it zooms toward.
  // Framed from outside it belongs up between the pile and the floating chair;
  // but zooming toward that point just flies into the empty air above the heap.
  // So as the viewer comes in, walk it down into the body of the pile — the
  // closer they get, the more the pile itself is the subject, and zooming
  // carries them in among the chairs.
  // Measured from the explore threshold, not from wantDist itself: while the
  // pile is growing the camera legitimately trails its fit distance, and reading
  // that lag as "zoomed in" would sag the view downward on every drop.
  const closeness = THREE.MathUtils.clamp(
    (wantDist * EXPLORE_FRACTION - dist) / (wantDist * 0.5), 0, 1);
  const framed = Math.max(1.1, spanTop * FOCUS_BIAS);
  const wantFocus = THREE.MathUtils.lerp(framed, pileTopY * 0.5, closeness);

  // Move the orbit center and the camera together: the viewer's angle survives.
  const delta = (wantFocus - camFocusY) * Math.min(1, dt * 1.2);
  camFocusY += delta;
  camera.position.y += delta;
  controls.target.y += delta;

  // In demo mode the breath owns the distance. It has to run instead of the
  // framing below rather than alongside it: that code exists to pull the camera
  // back out to the fit, which is exactly what it would do to every zoom the
  // demo tried to make. wantDist still tracks the growing pile above, so the
  // breath stays proportional to it, and the focus walk has already read the
  // closer distance — so diving in also tips the view down into the heap.
  if (demo) {
    const breath = (Math.sin((t / DEMO_ZOOM_PERIOD) * Math.PI * 2) + 1) / 2;
    const want = wantDist * THREE.MathUtils.lerp(DEMO_ZOOM_NEAR, DEMO_ZOOM_FAR, breath);
    const next = dist + (want - dist) * Math.min(1, dt * 0.8);
    camera.position.copy(controls.target).addScaledVector(_dir.normalize(), next);
    return;
  }

  // Never pull them back out of a pile they went in to look at.
  if (dist < wantDist * EXPLORE_FRACTION) return;
  if (dist < wantDist - 0.02) {
    const next = dist + (wantDist - dist) * Math.min(1, dt * 0.7);
    camera.position.copy(controls.target).addScaledVector(_dir.normalize(), next);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  world.step(1 / 60, dt, 4);

  // One pass over the live chairs: move their meshes, notice the ones that have
  // landed, and measure the pile. Chairs before freezeIdx are frozen — their
  // transforms and heights can never change, so they cost nothing per frame no
  // matter how deep the pile gets.
  //
  // Only chairs that have landed count toward the height. A chair in mid-fall is
  // briefly the highest thing in the scene, and counting it made the measurement
  // dive from the spawn height down to the pile on every drop — which the camera
  // faithfully followed, heaving the whole view like a swell. Note that landing
  // is about being at rest, NOT about the physics engine putting the body to
  // sleep: at this drop cadence chairs constantly knock each other awake, so a
  // sleep-based test finds almost nothing settled and the pile reads as flat.
  let measured = frozenTopY;
  for (let i = freezeIdx; i < chairs.length; i++) {
    const chair = chairs[i];
    const body = chair.body;
    chair.mesh.position.copy(body.position);
    chair.mesh.quaternion.copy(body.quaternion);

    if (!chair.landed) {
      chair.fallTime += dt;
      if (chair.fallTime > MIN_FALL_TIME && atRest(body)) chair.landed = true;
      continue; // still on its way down: not part of the pile yet
    }
    // Strays that slid off the heap shouldn't push the next chair higher.
    if (Math.hypot(body.position.x, body.position.z) > PILE_RADIUS) continue;
    measured = Math.max(measured, body.position.y + CHAIR_MID);
  }

  // Rise readily, sink reluctantly. If the chair holding the high point topples
  // off the heap the measurement steps down; sinking slowly keeps that from
  // yanking the view, while genuine growth is still followed.
  const rate = measured > pileTopY ? 1.5 : 0.15;
  pileTopY += (measured - pileTopY) * Math.min(1, dt * rate);

  freezeSettled(); // after the copies above, so a chair freezes at its final transform

  if (floating) {
    floating.mesh.position.y = floating.baseY + Math.sin(t * 1.1 + floating.phase) * 0.11;
    floating.mesh.rotateY(floating.spin * dt);
    const s = floating.mesh.scale.x;
    if (s < 1) floating.mesh.scale.setScalar(Math.min(1, s + dt * 2.2));
    // Hands free: let it hang long enough to be seen, then let it go. The next
    // chair is already on the SPAWN_DELAY_MS timer dropFloating sets, so the
    // demo settles into a chair every dwell-plus-delay without a timer of its own.
    if (demo && performance.now() - floating.spawnedAt > DEMO_DWELL_MS) dropFloating();
  }

  frame(dt, t);

  aimKey();

  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

spawnFloating();
animate();
