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
import { initAudio, resumeAudio, clatter, setMuted, isMuted } from './audio.js';

const SPAWN_DELAY_MS = 2000;   // gap between a chair landing and the next appearing
const FREEZE_BEHIND = 25;      // chairs this far down the pile turn to static bedrock
const PILE_RADIUS = 1.3;       // chairs beyond this from the drop column are strays
const SPAWN_GAP = 1.7;         // how far above the pile the next chair floats
const MIN_SPAWN_Y = 2.4;       // floating height over an empty floor
const REST_SPEED = 0.4;        // m/s under which a chair counts as come to rest
const MIN_FALL_TIME = 0.4;     // s of falling before a chair can be called landed
const HIT_MIN_SPEED = 0.7;     // m/s of impact under which a contact makes no sound
const HIT_COOLDOWN_MS = 70;    // one chair can only speak this often
const HIT_LOUD_SPEED = 5;      // impact speed that counts as a full-strength bang

// Framing. The view is centered at spanTop * FOCUS_BIAS and reaches
// spanTop * 0.5 * FRAME_MARGIN above that, so the top edge lands at
// spanTop * (FOCUS_BIAS + 0.5 * FRAME_MARGIN). That has to clear 1.0 or the
// floating chair hangs off the top of the screen — at 0.45 the margin must
// exceed 1.1, so 1.2 leaves about 5% of headroom above the chair.
const FOCUS_BIAS = 0.45;       // <0.5 sits the view low, giving the pile the frame
const FRAME_MARGIN = 1.2;
const EXPLORE_FRACTION = 0.8;  // closer than this share of the fit = exploring, so stop framing

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

const scene = new THREE.Scene();
scene.background = new THREE.Color(VOID);
scene.fog = new THREE.FogExp2(VOID, 0.055);

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

// Lit from above, softly: a wide key light plus cool sky bounce, no hard sun.
scene.add(new THREE.AmbientLight(0x9fb4c8, 0.22));
scene.add(new THREE.HemisphereLight(0x9fb4c8, 0x15171d, 0.5));

const key = new THREE.DirectionalLight(0xfff1dd, 1.7);
key.position.set(3.5, 11, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -8;
key.shadow.camera.right = 8;
key.shadow.camera.top = 8;
key.shadow.camera.bottom = -8;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 90; // the light rises with the pile; keep the floor inside it
key.shadow.bias = -0.0012;
key.shadow.normalBias = 0.02;
scene.add(key);
scene.add(key.target);

const fill = new THREE.DirectionalLight(0x8fa6c4, 0.22);
fill.position.set(-6, 4, -5);
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
  // ~10 units per tile. Tiles any larger than this and the patch of floor around
  // the pile is less than one tile wide, so the mottling flattens into a plain
  // gradient and reads as no texture at all. Here the coarsest octave lands
  // around 3 units — several chairs across, large but legible.
  texture.repeat.set(16, 16);
  // Enough to keep the mottling from smearing at grazing angles near the
  // horizon; the full 16x costs real sampling time on a floor this big for no
  // visible gain on texture this soft.
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

const floorTexture = makeFloorTexture();
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(160, 160),
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
const footEl = document.getElementById('foot');

const _pan = new THREE.Vector3();

/** Turn a physics contact into a knock, if it's worth hearing. */
function onCollide(chair, event) {
  const other = event.body;
  // Both chairs in a chair-on-chair hit get told about it, so let the lower id
  // own the pair or every impact speaks twice. The floor has no listener, so
  // chair-on-floor needs no such tie-break.
  if (other.isChair && other.id < chair.body.id) return;

  const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
  if (speed < HIT_MIN_SPEED) return; // a nudge, not a knock

  // A ten-box chair makes several contacts per landing, and a chair resting on
  // the pile keeps generating them forever. One knock per chair per cooldown
  // collapses both into the single sound the eye expects.
  const now = performance.now();
  if (now - chair.lastHitAt < HIT_COOLDOWN_MS) return;
  chair.lastHitAt = now;

  // Pan by where the chair sits across the current view rather than in world
  // space: the camera orbits, so world x has nothing to do with left and right.
  _pan.copy(chair.body.position);
  camera.worldToLocal(_pan);
  clatter(
    speed / HIT_LOUD_SPEED,
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

function spawnFloating() {
  const chair = makeChair();
  // Just high enough to read as floating: a longer fall only scatters the pile.
  const spawnY = Math.max(pileTopY + SPAWN_GAP, MIN_SPAWN_Y);
  chair.mesh.position.set((Math.random() - 0.5) * 0.36, spawnY, (Math.random() - 0.5) * 0.36);
  chair.mesh.rotation.set(
    (Math.random() - 0.5) * 1.0,
    Math.random() * Math.PI * 2,
    (Math.random() - 0.5) * 1.0
  );
  chair.baseY = spawnY;
  chair.phase = Math.random() * Math.PI * 2;
  chair.spin = (Math.random() - 0.5) * 0.5;
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
  if (dropped === 3) footEl.classList.add('gone'); // hint has done its job

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
  if (e.target.closest && e.target.closest('a, button')) return; // let the Gallery link work
  initAudio();
  dropFloating();
});

// Safari suspends the context when the tab goes away and only wakes on request.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resumeAudio();
});

const soundBtn = document.getElementById('sound');
soundBtn.addEventListener('click', (e) => {
  setMuted(!isMuted());
  soundBtn.textContent = isMuted() ? '🔇' : '🔊';
  soundBtn.setAttribute('aria-label', isMuted() ? 'Turn sound on' : 'Turn sound off');
  soundBtn.setAttribute('aria-pressed', String(!isMuted()));
  initAudio(); // this click is itself a gesture, so it can start the context too

  // A mouse click leaves the button focused, and every later keypress would go
  // to it: "press any key" would stop dropping chairs and the spacebar would
  // silently toggle the sound instead. Hand focus back to the page. Keyboard
  // activation (detail === 0) keeps it — a keyboard user must not lose their place.
  if (e.detail > 0) soundBtn.blur();
});

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
function frame(dt) {
  const spanTop = pileTopY + SPAWN_GAP + 0.6; // floor up to the top of the floating chair
  if (pileTopY > framedTop + 0.05) {
    framedTop = pileTopY;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const need = (spanTop * 0.5) / Math.tan(vFov / 2) * FRAME_MARGIN;
    wantDist = Math.max(wantDist, need);
  }

  _dir.subVectors(camera.position, controls.target);
  const dist = _dir.length();

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
  }

  frame(dt);

  key.position.y = 11 + pileTopY;
  key.target.position.y = pileTopY * 0.5;
  key.target.updateMatrixWorld();

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
