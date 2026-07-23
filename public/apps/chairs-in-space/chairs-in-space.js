// Chairs in Space — plain dining chairs, adrift in zero gravity.
//
// A sibling to Chair Pile: the same four-leg chair, but with the floor and the
// gravity taken away. Chairs tumble and drift through a starfield, each on its
// own slow spin. Tap or press a key to send another one out; drag to look
// around, scroll to move in and out. Nothing ever lands — it just keeps
// turning, out past a hazy planet and a low sun.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { initAudio, resumeAudio, chime, setMuted, isMuted } from './audio.js';

// How many chairs may be adrift at once. Each is a lit mesh with its own
// transform; a few hundred stays smooth on a phone and already fills the void.
const MAX_CHAIRS = 260;
const START_CHAIRS = 46;       // how many are already out there on load

// The chairs live inside a sphere this big. A chair that drifts past it is
// wrapped back in from the far side (see recycle), so the field never empties
// and never thins out on one side — it reads as an endless, even drift.
const FIELD_RADIUS = 26;

// Motion, in the chairs' own units. Drift is meters per second, tumble is
// radians per second. Both are scaled live by the Drift slider.
const DRIFT_BASE = 0.55;       // typical linear speed of a chair
const TUMBLE_BASE = 0.5;       // typical spin rate
let motionScale = 1;           // the slider multiplies both of the above

// Demo mode: chairs launch themselves and the camera makes a slow, wide orbit.
const DEMO_SPAWN_MS = 2600;
let demoSpawnMs = DEMO_SPAWN_MS;
const DEMO_ORBIT_SPEED = 0.16; // radians/sec of camera yaw
const DEMO_TILT = 0.12;        // how far the camera nods up and down

// ---------------------------------------------------------------- chair shape
// The exact chair from Chair Pile: a plain four-leg dining chair, in meters,
// with y=0 at the floor. One merged geometry is shared by every chair.
const SEAT_W = 0.46, SEAT_D = 0.44, SEAT_T = 0.05, SEAT_Y = 0.44;
const LEG = 0.05, LEG_H = 0.44;
const BACK_H = 0.55;

// Butt joints put two coplanar faces at the same depth; nudging each part a
// hair into the next buries the shared end faces so they can't z-fight.
const JOIN = 0.004;
const LEG_X = SEAT_W / 2 - LEG / 2;
const LEG_Z = SEAT_D / 2 - LEG / 2;
const CHAIR_H = SEAT_Y + SEAT_T + BACK_H;

const CHAIR_PARTS = [
  // seat
  { size: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
  // front legs
  { size: [LEG, LEG_H + JOIN, LEG], pos: [ LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
  { size: [LEG, LEG_H + JOIN, LEG], pos: [-LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
  // back stiles: floor to top rail in one piece, through the seat
  { size: [LEG, CHAIR_H - JOIN, LEG], pos: [ LEG_X, (CHAIR_H - JOIN) / 2, -LEG_Z] },
  { size: [LEG, CHAIR_H - JOIN, LEG], pos: [-LEG_X, (CHAIR_H - JOIN) / 2, -LEG_Z] },
  // back slats
  { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.66, -LEG_Z] },
  { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.80, -LEG_Z] },
  // top rail
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
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050c);

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 2000);
camera.position.set(0, 1.6, 12);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 60;
controls.target.set(0, 0, 0);

// --------------------------------------------------------------------- lights
// A low, warm sun on one side and a cool fill on the other — the standard
// "sunlit object in orbit" key/fill, so faces read as lit rather than flat.
const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
sun.position.set(6, 3, 4);
scene.add(sun);

const fill = new THREE.DirectionalLight(0x5f7bd6, 0.7);
fill.position.set(-5, -2, -3);
scene.add(fill);

// Faint sky/ground hemisphere so the shadowed sides never go fully black.
scene.add(new THREE.HemisphereLight(0x2a3358, 0x0a0a14, 0.45));

// -------------------------------------------------------------------- the sun
// A soft glowing disc far off, roughly where the key light comes from, so the
// warm side of every chair has a source you can see.
function makeSunSprite() {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,247,225,1)');
  g.addColorStop(0.25, 'rgba(255,231,180,0.9)');
  g.addColorStop(0.6, 'rgba(255,180,120,0.25)');
  g.addColorStop(1.0, 'rgba(255,160,90,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  sprite.scale.setScalar(70);
  sprite.position.set(120, 60, 80);
  return sprite;
}
scene.add(makeSunSprite());

// ------------------------------------------------------------------- starfield
// Two shells of points: a dense faint field and a sparse bright one, on a soft
// round sprite so the stars are dots, not squares. Colors ride a blue→white→
// amber temperature ramp for a little variety without looking tinted.
function starTexture() {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const STAR_SPRITE = starTexture();

// Deterministic pseudo-random so the field is stable across reloads within a
// session (no dependence on Math.random ordering elsewhere).
function makeStarLayer({ count, near, far, size, brightness }) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // A random direction on the unit sphere, pushed out to a random radius in
    // the shell — an even scatter across the whole sky.
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const radius = near + Math.random() * (far - near);
    positions[i * 3 + 0] = Math.cos(t) * r * radius;
    positions[i * 3 + 1] = u * radius;
    positions[i * 3 + 2] = Math.sin(t) * r * radius;
    // Temperature: mostly white, some cool, a few warm.
    const h = 0.55 + (Math.random() - 0.5) * 0.22; // blue-ish to amber
    const s = 0.15 + Math.random() * 0.35;
    const l = 0.75 + Math.random() * 0.25;
    tmp.setHSL(h, s, l).multiplyScalar(brightness);
    colors[i * 3 + 0] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size,
    map: STAR_SPRITE,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  return new THREE.Points(geo, mat);
}

const starGroup = new THREE.Group();
starGroup.add(makeStarLayer({ count: 1400, near: 140, far: 320, size: 1.1, brightness: 0.9 }));
starGroup.add(makeStarLayer({ count: 220,  near: 120, far: 260, size: 2.6, brightness: 1.0 }));
scene.add(starGroup);

// --------------------------------------------------------------------- planet
// A hazy world low in the frame for depth and scale. Lit by the same sun, so
// its terminator lines up with the chairs' shadowed sides.
function makePlanet() {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(40, 64, 48);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b4a7a, roughness: 1.0, metalness: 0.0,
    emissive: 0x0a1730, emissiveIntensity: 0.5,
  });
  group.add(new THREE.Mesh(geo, mat));

  // A thin atmospheric rim: a slightly larger back-side shell that glows where
  // it grazes the edge, faked with additive blending and a soft falloff.
  const atmoMat = new THREE.MeshBasicMaterial({
    color: 0x6fa8ff, transparent: true, opacity: 0.14,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  group.add(new THREE.Mesh(new THREE.SphereGeometry(43, 48, 32), atmoMat));

  group.position.set(-30, -46, -70);
  return group;
}
const planet = makePlanet();
scene.add(planet);

// ------------------------------------------------------------------ the chairs
const chairGeometry = buildChairGeometry();
const materials = PALETTE.map((color) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.08 }));

const chairs = [];
const _spin = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/** A random point on the surface of the field sphere. */
function randomShellPoint(radius, out) {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return out.set(Math.cos(t) * r, u, Math.sin(t) * r).multiplyScalar(radius);
}

function newChairMesh() {
  const tint = Math.floor(Math.random() * materials.length);
  const mesh = new THREE.Mesh(chairGeometry, materials[tint]);
  const s = 0.85 + Math.random() * 0.6; // a little variety in size/distance feel
  mesh.scale.setScalar(s);
  mesh.userData.vel = new THREE.Vector3();
  mesh.userData.omega = new THREE.Vector3();  // angular velocity, radians/sec
  return mesh;
}

/** Point a chair somewhere sensible with a fresh drift and tumble. */
function seedMotion(mesh) {
  mesh.userData.vel.set(
    (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5),
  ).normalize().multiplyScalar(DRIFT_BASE * (0.4 + Math.random() * 1.2));
  mesh.userData.omega.set(
    (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5),
  ).normalize().multiplyScalar(TUMBLE_BASE * (0.3 + Math.random() * 1.4));
  mesh.quaternion.set(Math.random(), Math.random(), Math.random(), Math.random()).normalize();
}

/** Fill the field with chairs already scattered and drifting, as if long adrift. */
function seedField(n) {
  for (let i = 0; i < n; i++) {
    if (chairs.length >= MAX_CHAIRS) break;
    const mesh = newChairMesh();
    // Scatter through the whole volume, denser toward the middle so the edges
    // fade rather than forming a hard shell.
    randomShellPoint(FIELD_RADIUS * Math.cbrt(Math.random()), mesh.position);
    seedMotion(mesh);
    scene.add(mesh);
    chairs.push(mesh);
  }
  updateCount();
}

/**
 * Launch one chair. With no aim, it appears just off-camera to one side and
 * drifts across the view — the resting animation. When the user taps, it comes
 * in from behind the camera and heads out toward where they aimed, so a tap
 * reads as "sending one out there".
 */
function launchChair(aim) {
  let mesh;
  if (chairs.length >= MAX_CHAIRS) {
    mesh = chairs.shift();   // recycle the oldest rather than grow without bound
    scene.add(mesh);
    chairs.push(mesh);
  } else {
    mesh = newChairMesh();
    scene.add(mesh);
    chairs.push(mesh);
  }

  seedMotion(mesh);

  if (aim) {
    // Come from just in front of the camera, heading toward the aim point.
    const forward = aim.clone().sub(camera.position).normalize();
    mesh.position.copy(camera.position).addScaledVector(forward, 4.5);
    mesh.userData.vel.copy(forward).multiplyScalar(DRIFT_BASE * 2.2);
    // A brisk tumble on a tap, so a fresh chair is visibly livelier.
    mesh.userData.omega.multiplyScalar(1.6);
    chime();
  } else {
    randomShellPoint(FIELD_RADIUS * (0.75 + Math.random() * 0.25), mesh.position);
    // Aim its drift roughly back through the middle so it crosses the view.
    mesh.userData.vel.copy(mesh.position).multiplyScalar(-1).normalize()
      .multiplyScalar(DRIFT_BASE * (0.5 + Math.random()));
  }
  updateCount();
}

/**
 * Keep a chair inside the field. Once it passes the boundary it is wrapped to
 * the opposite side and re-aimed inward, so it re-enters the view instead of
 * sailing off forever — an endless drift on a finite budget.
 */
function recycle(mesh) {
  const d = mesh.position.length();
  if (d <= FIELD_RADIUS) return;
  // Reflect the position through the origin and pull it just inside the edge.
  mesh.position.multiplyScalar(-(FIELD_RADIUS - 0.5) / d);
  // Re-aim the drift generally inward, keeping most of its speed.
  const speed = mesh.userData.vel.length();
  mesh.userData.vel.copy(mesh.position).multiplyScalar(-1).normalize()
    .multiplyScalar(speed)
    // plus a sideways wobble so they don't all funnel through dead center
    .add(new THREE.Vector3(
      (Math.random() - 0.5) * DRIFT_BASE,
      (Math.random() - 0.5) * DRIFT_BASE,
      (Math.random() - 0.5) * DRIFT_BASE,
    ));
}

// --------------------------------------------------------------------- counter
const countEl = document.getElementById('count');
function updateCount() {
  const n = chairs.length;
  countEl.textContent = `${n} chair${n === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------ the loop
const clock = new THREE.Clock();
let demoOn = true;
let demoAccMs = 0;
let demoYaw = 0;

function frame(dt) {
  const m = motionScale;
  for (const mesh of chairs) {
    mesh.position.addScaledVector(mesh.userData.vel, dt * m);
    // Integrate the tumble: build the small rotation for this step and premul.
    const w = mesh.userData.omega;
    const angle = w.length() * dt * m;
    if (angle > 1e-6) {
      _axis.copy(w).normalize();
      _spin.setFromAxisAngle(_axis, angle);
      mesh.quaternion.premultiply(_spin).normalize();
    }
    recycle(mesh);
  }

  // The whole starfield turns very slowly, so even a still camera never feels
  // frozen. The planet spins on its own axis at a hair's pace.
  starGroup.rotation.y += dt * 0.004;
  planet.rotation.y += dt * 0.02;

  if (demoOn) {
    demoYaw += dt * DEMO_ORBIT_SPEED;
    const r = camera.position.length();
    camera.position.x = Math.sin(demoYaw) * r;
    camera.position.z = Math.cos(demoYaw) * r;
    camera.position.y = Math.sin(demoYaw * 0.5) * r * DEMO_TILT;
    controls.update();
    demoAccMs += dt * 1000;
    if (demoAccMs >= demoSpawnMs) {
      demoAccMs = 0;
      launchChair(null);
    }
  } else {
    controls.update();
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp so a tab-out doesn't lurch
  frame(dt);
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
// A tap that isn't a drag launches a chair toward where it was aimed. We tell a
// tap from a drag by how far the pointer moved between down and up.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const aimPlaneDist = 10; // how far out a tap aims, along the camera ray
let downX = 0, downY = 0, downT = 0;

function aimFromEvent(x, y) {
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.at(aimPlaneDist, new THREE.Vector3());
}

canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX; downY = e.clientY; downT = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  if (menuOpen) return;
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  const quick = performance.now() - downT < 500;
  if (moved < 8 && quick) {
    resumeAudio();
    launchChair(aimFromEvent(e.clientX, e.clientY));
    spawnRipple(e.clientX, e.clientY);
  }
});

window.addEventListener('keydown', (e) => {
  if (menuOpen) return;
  if (e.key === 'Escape') return;
  // Ignore modifier combos and repeats so held keys don't spray chairs.
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  resumeAudio();
  launchChair(null);
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
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) closeMenu(); });

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
}
demoToggle.addEventListener('change', syncDemo);
spawn.addEventListener('input', () => {
  demoSpawnMs = parseFloat(spawn.value) * 1000;
  spawnVal.textContent = parseFloat(spawn.value).toFixed(1) + 's';
});
syncDemo();

// Drift speed
const drift = document.getElementById('drift');
const driftVal = document.getElementById('drift-val');
drift.addEventListener('input', () => {
  motionScale = parseFloat(drift.value);
  driftVal.textContent = motionScale.toFixed(1) + '×';
});

// Stars
const starsToggle = document.getElementById('stars-toggle');
starsToggle.addEventListener('change', () => { starGroup.visible = starsToggle.checked; });

// Show taps
const tapsToggle = document.getElementById('taps-toggle');
tapsToggle.addEventListener('change', () => { ripplesOn = tapsToggle.checked; });

// ---------------------------------------------------------------------- go
initAudio();
seedField(START_CHAIRS);
animate();
