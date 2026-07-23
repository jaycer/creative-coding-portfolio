// Chairs in Space — chairs fall into a singularity and pile up into a planetoid.
//
// A dark core sits at the center of a subtle starfield. Chairs drift in the
// void around it, pulled inward by its gravity; they spiral down and, once they
// reach the growing surface, settle and stick — layer on layer — into a slowly
// turning planetoid built entirely of chairs. The singularity's pull can climb
// over time, so the longer you watch, the more hungrily it draws them in.
//
// The camera is always trained on the singularity: you can orbit around it and
// zoom in and out, but never point away.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { initAudio, resumeAudio, chime, land, setMuted, isMuted } from './audio.js';

// Total chairs (drifting + settled). Each is a lit mesh; a few hundred packs a
// convincing planetoid and still runs smooth on a phone.
const MAX_CHAIRS = 2000;
const START_CHAIRS = 0;        // how many are already adrift on load

// The field the chairs live in. They spawn out near FIELD_RADIUS and fall in.
const FIELD_RADIUS = 22;
// A chair is never seen appearing: it must spawn beyond the edge of the screen
// and only ever drift into view. This is how far past the frustum edge (in NDC,
// so 1 is the exact edge) a shell point must sit to count as safely off-screen.
const OFFSCREEN_MARGIN = 1.15;

// The singularity and the planetoid growing on it.
const CORE_RADIUS = 0.3;       // the dark core's visible radius — a small point
// Closest the camera may dolly in free-fly (demo off): right up to the
// singularity, where the black core dominates the view ringed by its glow.
// Held a little off the core itself, since pressing against a black sphere just
// fills the screen with black and hides the halo behind it.
const MIN_ZOOM = CORE_RADIUS * 2.5;
const BASE_PLANETOID_R = 0.7;  // first chairs settle right up against the core
// The surface grows like the cube root of the count, so equal chairs add equal
// volume and the pile stays a ball rather than ballooning. PACK is kept low so
// the ball stays tight and the chairs pack in and interlock around the core
// rather than freezing far out in a loose, roomy shell.
const PACK = 0.42;
const LAND_MARGIN = 0.2;       // how close to the surface before a chair sticks

// Gravity. Softened inverse-square (r^2 + soften^2) so the pull stays finite
// near the middle, plus a little drag so orbits decay and every chair is
// eventually drawn in rather than slingshotting back out to infinity.
const GRAV_BASE = 58;          // strength at the slider's 1.0
const GRAV_SOFTEN = 1.6;       // meters; smooths the pull near the core
const DRAG = 0.05;             // per second; bleeds energy so orbits spiral in
const MAX_SPEED = 16;          // clamp, so a close pass can't fling a chair away
let gravityScale = 1;          // the Gravity slider multiplies GRAV_BASE

// Gravity over time: when on, the pull ramps from 1x up to RAMP_CAP across
// RAMP_SECONDS, so the field tightens the longer it runs.
let gravityRamp = true;
const RAMP_CAP = 3.2;
const RAMP_SECONDS = 50;
let elapsed = 0;               // seconds since the last reset

// Demo mode: chairs launch themselves and the camera makes a slow, locked orbit
// around the singularity.
const DEMO_SPAWN_MS = 900;     // how often demo mode sends another chair in
let demoSpawnMs = DEMO_SPAWN_MS;
const DEMO_ORBIT_SPEED = 0.35; // OrbitControls autoRotate units

// The demo camera also breathes through the full sphere the floorless scene
// affords: it dollies in and out and, on a slower and separately-timed beat,
// rises over one pole and dips under the other. Chair Pile keeps its camera
// above the floor; here there is nothing to clear, so the sweep is free to pass
// straight overhead and underneath. Azimuth stays with autoRotate; only the
// distance and elevation are driven here. The two periods differ so the vantage
// drifts over the sphere instead of retracing one ring.
const DEMO_DIST_NEAR = 12;              // closest the breath dollies in
const DEMO_DIST_FAR = 30;               // farthest it drifts back out
const DEMO_DIST_PERIOD = 24;            // seconds for one in-and-out
const DEMO_POLAR_HIGH = 0.28 * Math.PI; // small phi: looking down from above
const DEMO_POLAR_LOW = 0.72 * Math.PI;  // large phi: looking up from below
const DEMO_POLAR_PERIOD = 31;           // seconds for one over-and-under
const DEMO_CAM_EASE = 0.5;              // how firmly the camera chases the breath

// ---------------------------------------------------------------- chair shape
// The exact chair from Chair Pile: a plain four-leg dining chair, in meters,
// with y=0 at the floor. One merged geometry is shared by every chair.
const SEAT_W = 0.46, SEAT_D = 0.44, SEAT_T = 0.05, SEAT_Y = 0.44;
const LEG = 0.05, LEG_H = 0.44;
const BACK_H = 0.55;

// Butt joints put two coplanar faces at the same depth, so each part is nudged
// a hair into the next to bury the shared end faces and stop them z-fighting.
const JOIN = 0.004;
const LEG_X = SEAT_W / 2 - LEG / 2;
const LEG_Z = SEAT_D / 2 - LEG / 2;
const CHAIR_H = SEAT_Y + SEAT_T + BACK_H;

const CHAIR_PARTS = [
  { size: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
  { size: [LEG, LEG_H + JOIN, LEG], pos: [ LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
  { size: [LEG, LEG_H + JOIN, LEG], pos: [-LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
  { size: [LEG, CHAIR_H - JOIN, LEG], pos: [ LEG_X, (CHAIR_H - JOIN) / 2, -LEG_Z] },
  { size: [LEG, CHAIR_H - JOIN, LEG], pos: [-LEG_X, (CHAIR_H - JOIN) / 2, -LEG_Z] },
  { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.66, -LEG_Z] },
  { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.80, -LEG_Z] },
  { size: [SEAT_W, 0.07, LEG], pos: [0, CHAIR_H - 0.035, -LEG_Z] },
];

const CHAIR_MID = CHAIR_H / 2; // shift parts down so the body origin sits mid-chair

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

// ------------------------------------------------------------------- renderer
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 3000);
camera.position.set(0, 4, 17);

// The camera is locked onto the singularity: orbit and zoom only, never pan, so
// it can never point away from the center.
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.target.set(0, 0, 0);
controls.minDistance = 2.5;
controls.maxDistance = 90;
controls.autoRotateSpeed = DEMO_ORBIT_SPEED;

// --------------------------------------------------------------------- lights
// A cool key from one side and a warmer fill from the other, so the chairs read
// as lit bodies in space. No sun disc — the singularity is the only landmark.
const key = new THREE.DirectionalLight(0xdfe7ff, 2.3);
key.position.set(6, 5, 4);
scene.add(key);

const fill = new THREE.DirectionalLight(0xffcf9a, 0.55);
fill.position.set(-6, -3, -4);
scene.add(fill);

scene.add(new THREE.HemisphereLight(0x2a3358, 0x0a0a12, 0.4));

// ---------------------------------------------------------------- singularity
// A small black core with a soft halo — subtle, but enough to mark the center
// the whole scene falls toward. No photon ring: just the dark point and glow.
const singularity = new THREE.Group();

const core = new THREE.Mesh(
  new THREE.SphereGeometry(CORE_RADIUS, 48, 32),
  new THREE.MeshBasicMaterial({ color: 0x000000 }),
);
singularity.add(core);

// A soft radial halo sprite, so the core glows rather than sitting as a flat
// black dot on black.
function haloSprite() {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(150,180,255,0.0)');   // hollow center, so the core stays black
  g.addColorStop(0.32, 'rgba(150,180,255,0.45)');
  g.addColorStop(0.5, 'rgba(120,150,240,0.16)');
  g.addColorStop(1.0, 'rgba(90,120,220,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  sprite.scale.setScalar(CORE_RADIUS * 6);
  return sprite;
}
singularity.add(haloSprite());
scene.add(singularity);

// ------------------------------------------------------------------- starfield
// Subtle and still: small, dim, mostly-white points on a soft round sprite, so
// the stars read as faint pinpricks rather than bright confetti. They never
// twinkle — the layer only drifts, imperceptibly, for the barest parallax.
function starTexture() {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const STAR_SPRITE = starTexture();

function makeStarfield() {
  const count = 1600;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const tmp = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const radius = 300 + Math.random() * 500; // far off, so they never parallax past the chairs
    positions[i * 3 + 0] = Math.cos(t) * r * radius;
    positions[i * 3 + 1] = u * radius;
    positions[i * 3 + 2] = Math.sin(t) * r * radius;

    // A rough apparent magnitude, skewed so most stars are small and faint and
    // only a handful are big and bright, the way a real sky reads. Size and
    // brightness ride the same value: a brighter star also shows larger, and the
    // brightest push past 1 so the tone map blooms their cores toward white.
    const m = Math.pow(Math.random(), 2.5);
    sizes[i] = 0.8 + m * 4.2;         // ~0.8 to 5 px across
    const intensity = 0.45 + m * 1.3;

    // A spread of surface temperatures: mostly blue-white and white, a scatter
    // of gold, and a few orange and red, like real stellar color classes.
    const temp = Math.random();
    let h, s;
    if (temp < 0.50)      { h = 0.60; s = 0.10 + Math.random() * 0.22; } // blue-white
    else if (temp < 0.72) { h = 0.58; s = 0.02 + Math.random() * 0.05; } // near white
    else if (temp < 0.88) { h = 0.12; s = 0.25 + Math.random() * 0.30; } // gold
    else if (temp < 0.96) { h = 0.07; s = 0.40 + Math.random() * 0.35; } // orange
    else                  { h = 0.02; s = 0.55 + Math.random() * 0.35; } // red
    const l = 0.62 + Math.random() * 0.12;
    tmp.setHSL(h, s, l).multiplyScalar(intensity);
    colors[i * 3 + 0] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.PointsMaterial({
    size: 2.0,                      // fallback; the real per-star size is the aSize attribute
    map: STAR_SPRITE,
    vertexColors: true,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    blending: THREE.NormalBlending, // not additive: keeps them from piling into glare
    sizeAttenuation: false,         // fixed pixel size, so distance can't twinkle them
  });
  // Give each star its own pixel size: feed the aSize attribute into gl_PointSize.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float aSize;\n' +
      shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = aSize;');
  };
  return new THREE.Points(geo, mat);
}
const stars = makeStarfield();
scene.add(stars);

// ------------------------------------------------------------------ the chairs
const chairGeometry = buildChairGeometry();
const materials = PALETTE.map((color) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.08 }));

// Free chairs still falling in: each { mesh, vel, omega }. Settled chairs are
// reparented into `planetoid` and no longer simulated.
const free = [];
const planetoid = new THREE.Group();
scene.add(planetoid);
let settledCount = 0;
let planetoidRadius = BASE_PLANETOID_R;

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _camOff = new THREE.Vector3();
const _camSph = new THREE.Spherical();
const _shellP = new THREE.Vector3();
const _fwd = new THREE.Vector3();
let demoCamT = 0;              // seconds of demo-camera breath, advanced in demo

/** True when a shell point (direction d, given radius) sits safely off-screen. */
function offScreenShell(d, radius) {
  _shellP.copy(d).multiplyScalar(radius);
  camera.getWorldDirection(_fwd);
  if (_v.subVectors(_shellP, camera.position).dot(_fwd) <= 0) return true; // behind the camera
  _shellP.project(camera); // -> normalized device coords; edge of screen is 1
  return Math.abs(_shellP.x) > OFFSCREEN_MARGIN || Math.abs(_shellP.y) > OFFSCREEN_MARGIN;
}

/** A direction ~90 deg off the view axis: always outside the frustum. Last resort. */
function offScreenFallback() {
  camera.getWorldDirection(_fwd);
  const s = new THREE.Vector3().crossVectors(_fwd, camera.up);
  if (s.lengthSq() < 1e-6) s.set(1, 0, 0);
  return s.normalize();
}

function randomUnit(out) {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return out.set(Math.cos(t) * r, u, Math.sin(t) * r);
}

function newChairMesh() {
  const tint = Math.floor(Math.random() * materials.length);
  const mesh = new THREE.Mesh(chairGeometry, materials[tint]);
  mesh.scale.setScalar(0.8 + Math.random() * 0.5);
  return mesh;
}

function totalChairs() { return free.length + settledCount; }

/** How strong the pull is right now, folding in the slider and the time ramp. */
function gravityStrength() {
  const ramp = gravityRamp ? 1 + (RAMP_CAP - 1) * Math.min(elapsed / RAMP_SECONDS, 1) : 1;
  return GRAV_BASE * gravityScale * ramp;
}

/**
 * Send one chair into the field. `dir` (a unit vector from the center) is where
 * it comes in; with none, a random point on the shell. It gets a mostly
 * tangential velocity so it swings around and spirals down rather than dropping
 * straight into the core.
 */
function spawnChair(dir) {
  if (totalChairs() >= MAX_CHAIRS) return;
  const mesh = newChairMesh();

  // Where it drifts in from — always beyond the edge of the screen, so a chair
  // is never caught blinking into being. An aimed direction (a tap) is honored
  // when it already lands off-screen; otherwise draw random shell points until
  // one does, falling back to a point square off the side of the view.
  let d = dir || randomUnit(new THREE.Vector3());
  let radius = FIELD_RADIUS * (0.9 + Math.random() * 0.2);
  for (let i = 0; !offScreenShell(d, radius) && i < 24; i++) {
    d = i === 23 ? offScreenFallback() : randomUnit(new THREE.Vector3());
    radius = FIELD_RADIUS * (0.9 + Math.random() * 0.2);
  }
  mesh.position.copy(d).multiplyScalar(radius);

  // A tangent to the shell at this point: cross the radial with a random axis.
  const radial = mesh.position.clone().normalize();
  const tangent = new THREE.Vector3().crossVectors(radial, randomUnit(_v)).normalize();
  if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0); // radial happened to be parallel
  // Sub-orbital speed, so drag wins and the orbit decays inward.
  const vCirc = Math.sqrt(gravityStrength() / mesh.position.length());
  const speed = vCirc * (0.45 + Math.random() * 0.5);
  mesh.userData.vel = tangent.multiplyScalar(speed)
    .addScaledVector(radial, -0.15 * speed)          // a touch of initial infall
    .add(randomUnit(_v).multiplyScalar(0.08 * speed)); // and a little scatter
  mesh.userData.omega = randomUnit(new THREE.Vector3())
    .multiplyScalar(0.4 + Math.random() * 1.6);       // its own tumble

  scene.add(mesh);
  free.push(mesh);
  updateCount();
}

/** Scatter the field with chairs already drifting, as if long adrift. */
function seedField(n) {
  for (let i = 0; i < n && totalChairs() < MAX_CHAIRS; i++) spawnChair();
}

// A chair falling in only makes a sound now and then, so a shower of them
// arriving at once stays a soft patter rather than a roar.
let lastLandSound = -1;

/**
 * A chair has reached the surface: fix it to the planetoid. Its incoming
 * direction is kept but its distance is snapped to the current surface. Its
 * orientation is frozen exactly as it was tumbling — no radial alignment — so
 * the chairs sit at every which angle, the way a pile of jostled chairs would,
 * rather than all pointing the same way. It is then reparented so it turns with
 * the planetoid as one body, and the surface grows a hair for the next arrival.
 */
// The zoom-in floor depends on the mode: demo keeps the camera framed outside
// the pile, free-fly lets you go all the way in to the singularity.
function applyMinDistance() {
  controls.minDistance = demoOn ? Math.max(2.5, planetoidRadius + 1.5) : MIN_ZOOM;
}

function settle(mesh) {
  _dir.copy(mesh.position).normalize();

  // The planetoid spins, so convert the world placement into its local frame.
  const inv = planetoid.quaternion.clone().invert();
  mesh.position.copy(_dir).applyQuaternion(inv)
    .multiplyScalar(planetoidRadius + (Math.random() - 0.5) * 0.35); // jitter, so layers overlap and interlock
  // Keep the chair's current tumbled orientation; just carry it into the
  // planetoid's frame so it rides along as the body turns.
  mesh.quaternion.premultiply(inv);

  scene.remove(mesh);
  planetoid.add(mesh);
  settledCount++;
  planetoidRadius = BASE_PLANETOID_R + PACK * Math.cbrt(settledCount);

  // Nudge the zoom-in floor out past the growing surface, so you can't dolly
  // inside the planetoid.
  applyMinDistance();

  const t = performance.now();
  if (t - lastLandSound > 55) { land(); lastLandSound = t; }
  // Note: the count is refreshed by the caller after this chair leaves `free`,
  // not here — inside settle it is still in both `free` and settledCount.
}

// --------------------------------------------------------------------- counter
const countEl = document.getElementById('count');
function updateCount() {
  const n = totalChairs();
  countEl.textContent = `${n} chair${n === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------ the loop
const clock = new THREE.Clock();
let demoOn = true;
let demoAccMs = 0;

function stepChairs(dt) {
  const G = gravityStrength();
  const landAt = planetoidRadius + LAND_MARGIN;
  let landed = false;
  for (let i = free.length - 1; i >= 0; i--) {
    const mesh = free[i];
    const pos = mesh.position;
    const r2 = pos.lengthSq();
    const r = Math.sqrt(r2);

    if (r <= landAt) {
      settle(mesh);
      free.splice(i, 1);   // out of `free` before the count is read
      landed = true;
      continue;
    }

    // Softened inverse-square pull toward the center.
    const a = G / (r2 + GRAV_SOFTEN * GRAV_SOFTEN);
    const vel = mesh.userData.vel;
    vel.addScaledVector(_dir.copy(pos).multiplyScalar(-1 / r), a * dt);
    vel.multiplyScalar(1 - DRAG * dt);          // drag, so orbits decay inward
    const sp = vel.length();
    if (sp > MAX_SPEED) vel.multiplyScalar(MAX_SPEED / sp);
    pos.addScaledVector(vel, dt);

    // Tumble as it falls.
    const w = mesh.userData.omega;
    const angle = w.length() * dt;
    if (angle > 1e-6) {
      _axis.copy(w).normalize();
      _spin.setFromAxisAngle(_axis, angle);
      mesh.quaternion.premultiply(_spin).normalize();
    }
  }
  if (landed) updateCount(); // once per step, after every landing has left `free`
}

// The demo camera breath: dolly and pole sweep around the fixed target, using
// the whole space (no floor to stay above). Azimuth is left to autoRotate and
// the viewer's own drag; only distance and elevation are driven here, and eased
// so a hand on the controls can still swing the view without a fight.
function demoCamera(dt) {
  demoCamT += dt;
  const distB = (Math.sin((demoCamT / DEMO_DIST_PERIOD) * Math.PI * 2) + 1) / 2;
  const polarB = (Math.sin((demoCamT / DEMO_POLAR_PERIOD) * Math.PI * 2) + 1) / 2;
  const wantR = THREE.MathUtils.lerp(DEMO_DIST_NEAR, DEMO_DIST_FAR, distB);
  const wantPhi = THREE.MathUtils.lerp(DEMO_POLAR_HIGH, DEMO_POLAR_LOW, polarB);

  _camOff.subVectors(camera.position, controls.target);
  _camSph.setFromVector3(_camOff);
  const k = Math.min(1, dt * DEMO_CAM_EASE);
  _camSph.radius += (wantR - _camSph.radius) * k;
  _camSph.phi += (wantPhi - _camSph.phi) * k;
  _camSph.makeSafe();
  _camOff.setFromSpherical(_camSph);
  camera.position.copy(controls.target).add(_camOff); // autoRotate spins azimuth after
}

function frame(dt) {
  elapsed += dt;
  stepChairs(dt);

  // The planetoid turns slowly on its axis; the far starfield drifts a hair.
  planetoid.rotation.y += dt * 0.06;
  stars.rotation.y += dt * 0.002;

  if (demoOn) {
    demoCamera(dt);
    demoAccMs += dt * 1000;
    if (demoAccMs >= demoSpawnMs) {
      demoAccMs = 0;
      spawnChair();
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp so a tab-out doesn't lurch
  // Frozen while the settings sheet is open: nothing drifts or spawns until it closes.
  if (!menuOpen) frame(dt);
  controls.autoRotate = demoOn && !menuOpen;
  controls.update();
  renderer.render(scene, camera);
}

// -------------------------------------------------------------------- resize
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------ pointer / keys
// A tap that isn't a drag sends a chair in from the direction it was aimed. Tap
// vs. drag is told by how far the pointer moved between down and up.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downX = 0, downY = 0, downT = 0;

/** Turn a screen tap into a unit direction from the center to throw a chair in. */
function aimDir(x, y) {
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // A point well down the ray, then its direction from the center.
  const p = raycaster.ray.at(FIELD_RADIUS, new THREE.Vector3());
  if (p.lengthSq() < 1e-4) return null;
  return p.normalize();
}

canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX; downY = e.clientY; downT = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  if (menuOpen) return;
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved < 8 && performance.now() - downT < 500) {
    resumeAudio();
    spawnChair(aimDir(e.clientX, e.clientY));
    chime();
    spawnRipple(e.clientX, e.clientY);
  }
});

window.addEventListener('keydown', (e) => {
  if (menuOpen) { if (e.key === 'Escape') closeMenu(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  resumeAudio();
  spawnChair();
  chime();
});

// ----------------------------------------------------------------- tap ripple
const rippleLayer = document.getElementById('ripples');
let ripplesOn = false;
function spawnRipple(x, y) {
  if (!ripplesOn) return;
  const dot = document.createElement('div');
  dot.className = 'ripple';
  dot.style.left = x + 'px';
  dot.style.top = y + 'px';
  rippleLayer.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove());
}

// ------------------------------------------------------------------ reset
function resetField() {
  for (const mesh of free) scene.remove(mesh);
  free.length = 0;
  for (let i = planetoid.children.length - 1; i >= 0; i--) {
    planetoid.remove(planetoid.children[i]);
  }
  planetoid.rotation.set(0, 0, 0);
  settledCount = 0;
  planetoidRadius = BASE_PLANETOID_R;
  applyMinDistance();
  elapsed = 0;
  seedField(START_CHAIRS);
  updateCount();
}

// -------------------------------------------------------------- settings sheet
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
doneBtn.addEventListener('click', () => { resumeAudio(); closeMenu(); });
scrim.addEventListener('click', (e) => { if (e.target === scrim) closeMenu(); });

// Sound
const soundToggle = document.getElementById('sound-toggle');
soundToggle.addEventListener('change', () => setMuted(!soundToggle.checked));
setMuted(!soundToggle.checked);

// Demo mode + its spawn interval
const demoToggle = document.getElementById('demo-toggle');
const rateWrap = document.getElementById('rate');
const spawn = document.getElementById('spawn');
const spawnVal = document.getElementById('spawn-val');
function syncDemo() {
  demoOn = demoToggle.checked;
  rateWrap.style.display = demoOn ? '' : 'none';
  applyMinDistance(); // free-fly unlocks the full zoom-in; demo re-frames outside the pile
}
demoToggle.addEventListener('change', syncDemo);
spawn.addEventListener('input', () => {
  demoSpawnMs = parseFloat(spawn.value) * 1000;
  spawnVal.textContent = parseFloat(spawn.value).toFixed(1) + 's';
});
syncDemo();

// Gravity strength
const grav = document.getElementById('grav');
const gravVal = document.getElementById('grav-val');
grav.addEventListener('input', () => {
  gravityScale = parseFloat(grav.value);
  gravVal.textContent = gravityScale.toFixed(1) + '×';
});

// Gravity climbs over time
const rampToggle = document.getElementById('ramp-toggle');
rampToggle.addEventListener('change', () => { gravityRamp = rampToggle.checked; });

// Starfield
const starsToggle = document.getElementById('stars-toggle');
starsToggle.addEventListener('change', () => { stars.visible = starsToggle.checked; });

// Show taps
const tapsToggle = document.getElementById('taps-toggle');
tapsToggle.addEventListener('change', () => { ripplesOn = tapsToggle.checked; });

// Reset
const resetBtn = document.getElementById('reset-btn');
resetBtn.addEventListener('click', () => { resetField(); closeMenu(); });

// ---------------------------------------------------------------------- go
initAudio();
seedField(START_CHAIRS);
openMenu();
animate();
