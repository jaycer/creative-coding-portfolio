// Splat Editor — open a scan, brush the noise off it, trace a polygon over it.
//
// This is a workshop tool rather than a piece: it exists because splat2glb.mjs
// can only ever be as good as what it is handed, and the two things that ruin a
// capture are noise no threshold can reach and coverage nothing can invent. The
// first of those is fixable by hand in about a minute, and this is the hand.
//
// Two modes over the same cloud:
//
//   ERASE  a ring follows the cursor and everything whose projection lands
//          inside it is deleted, all the way through — which is what you want
//          for haze, because haze is a volume and picking at its surface would
//          take all day. Undo is a full stack; nothing is written until you save.
//
//   TRACE  click a point and it becomes a vertex of a polygon, with lines drawn
//          between them in order. The click snaps to a real point rather than to
//          empty space, so a traced outline is made of measurements.
//
// The camera is hand-rolled rather than OrbitControls, for one reason: in a tool
// mode the left button belongs to the tool, and every version of this built on
// OrbitControls spends its life fighting over that button. Here the right button
// always orbits, in every mode, and the left button does whatever the mode says.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeViewCube } from './viewcube.js';
import { readScan, writePly } from './scanfile.js';
import { buildFromCloud } from './build.js';
import { wrap } from './wrap.js';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08090c);
const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);

/**
 * Light the room, once, the first time anything that needs lighting arrives.
 *
 * Points carry their own color and are drawn unlit, so for a cloud this is dead
 * weight — but a mesh under a standard material with no lights in the scene is
 * black, and black on this background is an empty screen. That is not a subtle
 * failure to sit behind a check: it looks exactly like the file failed to load.
 *
 * Deliberately NOT the gallery's rig. This is the workshop, where the job is to
 * see the geometry; the gallery's near-black room is what Preview is for.
 */
function ensureLights() {
  if (scene.children.some((c) => c.isLight)) return;
  const key = new THREE.DirectionalLight(0xfff3e4, 2.4);
  key.position.set(0.5, 0.9, 0.85);
  const fill = new THREE.DirectionalLight(0xc2d8ff, 1.0);
  fill.position.set(-0.85, 0.2, 0.5);
  scene.add(key, fill, new THREE.HemisphereLight(0x93a6c8, 0x1a1d26, 0.9));
}

// ------------------------------------------------------------------- the cloud
// Points are never removed from the buffers. An `alive` attribute is flipped to
// zero and the shader discards them, which keeps every index stable for the
// whole session — undo is then a list of indices rather than a saved copy of the
// geometry, and a stroke costs one attribute upload instead of a rebuild.
//
// The colors can be switched off, and for erasing they usually should be. A
// scan's own color is what makes it look like the object, which is exactly the
// problem: haze picks up the color of whatever it drifted off, so a shelf of
// grey fog reads as part of a grey pig and the eye stops flagging it. Stripped
// to one flat value, the only thing left to see is DENSITY — and density is what
// separates a surface from the fog around it.
const pointMaterial = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 2 }, uPlain: { value: 0 } },
  vertexShader: `
    attribute vec3 color;
    attribute float alive;
    uniform float uSize;
    uniform float uPlain;
    varying vec3 vColor;
    varying float vAlive;
    void main() {
      vColor = mix(color, vec3(0.86, 0.88, 0.92), uPlain);
      vAlive = alive;
      // A fixed size in pixels, not a size in world units that shrinks with
      // distance. Noise is mostly far from the camera and mostly what you are
      // here to find, and attenuated points hide it exactly when it matters.
      gl_PointSize = uSize;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vAlive;
    void main() {
      if (vAlive < 0.5) discard;
      vec2 d = gl_PointCoord - vec2(0.5);
      if (dot(d, d) > 0.25) discard;   // round, not square
      gl_FragColor = vec4(vColor, 1.0);
    }
  `,
});

let cloudData = null;      // what scanfile handed back
let alive = null;          // Uint8Array, 1 while a point is still there
let points = null;         // THREE.Points
let aliveAttr = null;
let liveCount = 0;
let skinMesh = null;       // the vacuum's result, once it has been pulled
let builtMesh = null;      // a mesh opened from a GLB — a splat2glb build, usually
let wrapping = false;
/** Whichever mesh is on screen. A build if one was opened, else the vacuum's. */
function currentMesh() { return builtMesh || skinMesh; }
/** Is there anything here to look at. */
function loaded() { return !!(cloudData || builtMesh); }
// Nothing here is written anywhere until a Save, and a session is minutes of
// work that a stray ⌘W or a click on Gallery would take with it. Rather than a
// single flag, each thing that can be saved remembers the state it was last
// saved AT — so undoing back to that state counts as clean again, which a plain
// boolean gets wrong and which is exactly what somebody does after a misfire.
let savedLive = -1;        // liveCount when the cloud was last written
let savedTrace = 0;        // traceVerts.length when the polygon was last written
let meshSaved = true;      // has this wrap been written out
// What is open, by name. It was only ever in the browser tab's title, which is
// the one place you cannot see while looking at the model — and after an hour of
// BertScan / cleanedBert / cleanedUpBertAgain there is no telling them apart by
// eye. Anything that has to say which file this is reads it from here.
let loadedName = '';
const undoStack = [];      // each entry is the list of indices one action killed

// ------------------------------------------------------------------ the camera
// Spherical about a target, which is the middle of whatever was loaded.
let yaw = 0.7;
let pitch = 0.25;
let dist = 1;
let target = new THREE.Vector3();
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

let viewCube = null;

function placeCamera() {
  const cp = Math.cos(pitch);
  camera.position.set(
    target.x + Math.sin(yaw) * cp * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * cp * dist,
  );
  camera.lookAt(target);
  if (viewCube) viewCube.setOrientation(yaw, pitch);
}

// Every route to a new angle goes through placeCamera, so the cube is told once
// rather than at each of the four places that move the camera.
viewCube = makeViewCube(document.getElementById('cube-canvas'), (y, p) => {
  yaw = y;
  pitch = p;
  placeCamera();
}, (dy2, dp) => {
  // Same signs as dragging the main canvas, so the two surfaces turn the model
  // the same way and neither has to be learned separately.
  yaw -= dy2;
  pitch = clamp(pitch + dp, -1.5, 1.5);
  placeCamera();
});
viewCube.setOrientation(yaw, pitch);

function frameBox(box) {
  box.getCenter(target);
  const r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  dist = r * 2.6;
  camera.near = r / 500;
  camera.far = r * 60;
  camera.updateProjectionMatrix();
  placeCamera();
}

function frameCloud() {
  frameBox(new THREE.Box3().setFromBufferAttribute(points.geometry.getAttribute('position')));
}

/**
 * Put whatever is loaded back in the middle of the frame, at the same angle.
 *
 * Zoom has no stops worth the name and orbit has no home, so it takes about two
 * seconds of enthusiasm to end up inside the object or a mile off it, looking at
 * an empty screen that is indistinguishable from a file that failed to load.
 * The angle is deliberately kept — losing your place is the problem, and
 * throwing away the view you had chosen is not the fix.
 */
function fitView() {
  if (points) frameCloud();
  else if (builtMesh) frameBox(new THREE.Box3().setFromObject(builtMesh));
  else if (skinMesh) frameBox(new THREE.Box3().setFromObject(skinMesh));
}
document.getElementById('fit-btn').addEventListener('click', fitView);

// -------------------------------------------------------------------- the trace
// Vertices in the order they were clicked, and a line through them. Kept as a
// plain list because that is what it is — an ordered set of positions somebody
// chose, and every operation on it is push, pop or export.
const traceVerts = [];
const traceLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x7fe8c0 }),
);
traceLine.frustumCulled = false;
scene.add(traceLine);
const traceDots = new THREE.Points(
  new THREE.BufferGeometry(),
  new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false }),
);
traceDots.frustumCulled = false;
scene.add(traceDots);

function refreshTrace() {
  const arr = new Float32Array(traceVerts.length * 3);
  traceVerts.forEach((v, i) => { arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z; });
  for (const o of [traceLine, traceDots]) {
    o.geometry.dispose();
    o.geometry = new THREE.BufferGeometry();
    o.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  }
  updateReadout();
}

// --------------------------------------------------------------------- the work
/**
 * Project every living point once, into a scratch array.
 *
 * Both tools need the same thing — where each point landed on screen — and both
 * are asked for it on every pointer move. Doing it in one pass over typed arrays
 * with the matrix precomputed keeps a 30,000 point cloud comfortably inside a
 * frame; going through Vector3.project() per point does not.
 */
const screen = { x: null, y: null, depth: null, ok: null };
const mvp = new THREE.Matrix4();
function projectAll() {
  const n = cloudData.n;
  if (!screen.x || screen.x.length !== n) {
    screen.x = new Float32Array(n);
    screen.y = new Float32Array(n);
    screen.depth = new Float32Array(n);
    screen.ok = new Uint8Array(n);
  }
  camera.updateMatrixWorld();
  mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = mvp.elements;
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  const pos = cloudData.pos;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3]; const y = pos[i * 3 + 1]; const z = pos[i * 3 + 2];
    // Behind the camera is cw <= 0. NOT depth < 0 — normalised depth is
    // negative for everything nearer than the middle of the depth range, which
    // on a framed object is most of it.
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 0) { screen.ok[i] = 0; continue; }
    screen.ok[i] = 1;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
    screen.x[i] = ((cx / cw) * 0.5 + 0.5) * w;
    screen.y[i] = (0.5 - (cy / cw) * 0.5) * h;
    screen.depth[i] = cz / cw;
  }
}

function eraseAt(px, py, radiusPx, into) {
  const r2 = radiusPx * radiusPx;
  const n = cloudData.n;
  for (let i = 0; i < n; i++) {
    if (!alive[i] || !screen.ok[i]) continue;
    const dx = screen.x[i] - px;
    const dy = screen.y[i] - py;
    if (dx * dx + dy * dy > r2) continue;
    alive[i] = 0;
    aliveAttr.array[i] = 0;
    into.push(i);
    liveCount--;
  }
}

/** The living point nearest the cursor, nearest the camera among ties. */
function pickAt(px, py, radiusPx) {
  const r2 = radiusPx * radiusPx;
  let best = -1;
  let bestDepth = Infinity;
  for (let i = 0; i < cloudData.n; i++) {
    if (!alive[i] || !screen.ok[i]) continue;
    const dx = screen.x[i] - px;
    const dy = screen.y[i] - py;
    if (dx * dx + dy * dy > r2) continue;
    if (screen.depth[i] < bestDepth) { bestDepth = screen.depth[i]; best = i; }
  }
  return best;
}

function undo() {
  const last = undoStack.pop();
  if (!last) return;
  if (last.trace) {
    traceVerts.pop();
    refreshTrace();
  } else {
    for (const i of last.killed) { alive[i] = 1; aliveAttr.array[i] = 1; liveCount++; }
    aliveAttr.needsUpdate = true;
  }
  undoBtn.disabled = !undoStack.length;
  updateReadout();
}

// ------------------------------------------------------------------- the chrome
const dropEl = document.getElementById('drop');
const dropErr = document.getElementById('drop-err');
const fileEl = document.getElementById('file');
const brushEl = document.getElementById('brush-ring');
const snapEl = document.getElementById('snap-ring');
const brushInput = document.getElementById('brush');
const sizeRow = document.getElementById('size-row');
const readoutEl = document.getElementById('readout');
const hintEl = document.getElementById('hint');
const undoBtn = document.getElementById('undo-btn');
const modeBtns = {
  orbit: document.getElementById('mode-orbit'),
  erase: document.getElementById('mode-erase'),
  trace: document.getElementById('mode-trace'),
};

let mode = 'orbit';
const HINTS = {
  orbit: 'drag to turn · wheel to zoom',
  erase: 'drag to erase · right-drag to turn · [ ] brush size · ⌘Z undo',
  trace: 'the ring shows what will be picked · right-drag to turn · ⌘Z undo',
};

// How far a click may reach for a point to snap to. It used to be 22, which is
// far enough that tracing along a silhouette pulled every vertex sideways onto
// the nearest dot INWARD of the edge — the cursor said one thing and the vertex
// landed somewhere else. Halved, and the ring below now shows where it will go,
// so the snap is visible instead of surprising.
const SNAP = 11;

function setMode(next) {
  mode = next;
  for (const [k, b] of Object.entries(modeBtns)) b.setAttribute('aria-pressed', String(k === next));
  sizeRow.style.opacity = next === 'erase' ? '1' : '0.35';
  brushEl.style.display = next === 'erase' ? 'block' : 'none';
  snapEl.style.display = 'none';
  canvas.style.cursor = next === 'orbit' ? 'grab' : next === 'trace' ? 'crosshair' : 'none';
  hintEl.textContent = HINTS[next];
}
for (const [k, b] of Object.entries(modeBtns)) b.addEventListener('click', () => setMode(k));

/** What would be lost right now, in the order somebody would care about it. */
function unsaved() {
  const out = [];
  if (cloudData && liveCount !== savedLive) {
    const gone = cloudData.n - liveCount;
    out.push(gone ? `${gone.toLocaleString()} erased points` : 'the reloaded cloud');
  }
  if (traceVerts.length !== savedTrace) out.push(`${traceVerts.length} traced vertices`);
  if (currentMesh() && !meshSaved) out.push(builtMesh ? 'the build' : 'the vacuum result');
  return out;
}

function updateReadout() {
  if (!cloudData) {
    let tris = 0;
    if (builtMesh) {
      builtMesh.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      });
    }
    readoutEl.textContent = tris
      ? `${loadedName}\n${Math.round(tris).toLocaleString()} triangles`
      : '';
    return;
  }
  const gone = cloudData.n - liveCount;
  readoutEl.textContent =
    `${loadedName}\n`
    + `${liveCount.toLocaleString()} points  (${gone.toLocaleString()} erased, ${(100 * gone / cloudData.n).toFixed(1)}%)\n`
    + `${traceVerts.length} traced vertices`
    + (skinMesh ? `\n${(skinMesh.geometry.index.count / 3).toLocaleString()} triangles wrapped` : '')
    + (unsaved().length ? `\nunsaved: ${unsaved().join(', ')}` : '');
}

function brushRadius() { return Number(brushInput.value) / 2; }
brushInput.addEventListener('input', () => {
  brushEl.style.width = `${brushRadius() * 2}px`;
  brushEl.style.height = `${brushRadius() * 2}px`;
});

// ---------------------------------------------------------------------- loading
async function openTraces(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.traces) || !data.traces.length) throw new Error('no traces in that file');
    showTraceData(data);
    hintEl.textContent = `${data.traces.length} outlines from ${data.object || 'a scan'}`;
  } catch (e) {
    dropErr.textContent = e.message;
  }
}

function dropTheCloud() {
  if (points) { scene.remove(points); points.geometry.dispose(); points = null; }
  cloudData = null;
  alive = null;
  aliveAttr = null;
  liveCount = 0;
  savedLive = -1;
  traceVerts.length = 0;
  refreshTrace();
  undoStack.length = 0;
  undoBtn.disabled = true;
}

function dropTheMesh() {
  if (skinMesh) { scene.remove(skinMesh); skinMesh.geometry.dispose(); skinMesh.material.dispose(); skinMesh = null; }
  if (builtMesh) {
    scene.remove(builtMesh);
    builtMesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    builtMesh = null;
  }
  meshSaved = true;
}

/** Put a cloud on screen and reset everything that belonged to the last one. */
function installCloud(c, name) {
  cloudData = c;
  alive = new Uint8Array(c.n).fill(1);
  liveCount = c.n;
  savedLive = c.n;
  savedTrace = 0;
  meshSaved = true;
  undoStack.length = 0;
  undoBtn.disabled = true;
  traceVerts.length = 0;
  refreshTrace();
  dropTheMesh();

  if (points) { scene.remove(points); points.geometry.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c.rgb, 3));
  aliveAttr = new THREE.BufferAttribute(new Float32Array(c.n).fill(1), 1);
  g.setAttribute('alive', aliveAttr);
  points = new THREE.Points(g, pointMaterial);
  points.frustumCulled = false;
  scene.add(points);

  frameCloud();
  dropEl.hidden = true;
  loadedName = name;
  document.title = `${name} — Splat Editor`;
  updateReadout();
}

/**
 * A combined `.glb` from `splat2glb --trace-glb`: the cloud and every outline in
 * one file, so there is one thing to open rather than two things to open in the
 * right order.
 *
 * The cloud arrives as a POINTS primitive and each outline as a closed
 * LINE_STRIP, with how it was drawn hung off the node as glTF `extras`. Nothing
 * here is specific to that writer beyond the naming — any GLB with points in it
 * opens, and any lines it carries are shown as outlines.
 *
 * The one thing a GLB cannot carry is the splat properties, so opacity and
 * radius come back as defaults. Erasing still works, and so does saving, but a
 * cloud round-tripped through here has lost what the scan knew about how big and
 * how certain each blob was. Open the PLY or the SPZ when that matters.
 */
async function openTraced(file) {
  const lost = unsaved();
  if (lost.length && !confirm(`Open ${file.name}?\n\nThis would discard ${lost.join(' and ')}.`)) return;
  dropErr.textContent = '';
  try {
    const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
    let cloud = null;
    const solids = [];
    const views = [];
    gltf.scene.traverse((o) => {
      if (o.isPoints && !cloud) cloud = o;
      if (o.isMesh) solids.push(o);
      if (!o.isLine) return;
      const extras = { ...(o.parent ? o.parent.userData : {}), ...o.userData };
      const pos = o.geometry.getAttribute('position');
      const ring = [];
      for (let i = 0; i < pos.count; i++) ring.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
      // Written closed, with the first vertex repeated. Drawn closed too, so
      // carrying the repeat through would double one segment.
      if (ring.length > 1
        && ring[0][0] === ring[ring.length - 1][0]
        && ring[0][1] === ring[ring.length - 1][1]
        && ring[0][2] === ring[ring.length - 1][2]) ring.pop();
      const at = views.find((v) => v.name === o.name || v.name === (o.parent && o.parent.name));
      if (at) at.rings.push(ring);
      else views.push({ name: o.name, rings: [ring], ...extras });
    });
    if (!cloud && !solids.length) throw new Error('that GLB has no points and no triangles in it');

    // A build rather than a capture — a splat2glb output, opened here to look at
    // it and to preview it as the gallery would show it. It replaces the cloud
    // rather than joining it: there is nothing to erase on a finished mesh.
    if (!cloud) {
      gltf.scene.updateMatrixWorld(true);
      clearTraces();
      dropTheCloud();
      dropTheMesh();
      builtMesh = gltf.scene;
      scene.add(builtMesh);
      ensureLights();
      frameBox(new THREE.Box3().setFromObject(builtMesh));
      dropEl.hidden = true;
      loadedName = file.name;
      document.title = `${file.name} — Splat Editor`;
      let tris = 0;
      for (const m of solids) {
        const g = m.geometry;
        tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      }
      hintEl.textContent = `${Math.round(tris).toLocaleString()} triangles — Preview shows it as the gallery would`;
      updateReadout();
      return;
    }

    const pos = cloud.geometry.getAttribute('position');
    const col = cloud.geometry.getAttribute('color');
    const c = {
      n: pos.count,
      pos: new Float32Array(pos.count * 3),
      rgb: new Float32Array(pos.count * 3),
      opacity: new Float32Array(pos.count).fill(1),
      radius: new Float32Array(pos.count).fill(0.001),
    };
    for (let i = 0; i < pos.count; i++) {
      c.pos[i * 3] = pos.getX(i); c.pos[i * 3 + 1] = pos.getY(i); c.pos[i * 3 + 2] = pos.getZ(i);
      c.rgb[i * 3] = col ? col.getX(i) : 0.8;
      c.rgb[i * 3 + 1] = col ? col.getY(i) : 0.8;
      c.rgb[i * 3 + 2] = col ? col.getZ(i) : 0.8;
    }
    clearTraces();
    installCloud(c, file.name);
    if (views.length) showTraceData({ object: file.name, traces: views });
    hintEl.textContent = views.length
      ? `${views.length} outlines and ${c.n.toLocaleString()} points, from one file`
      : `${c.n.toLocaleString()} points, no outlines in that file`;
  } catch (e) {
    dropErr.textContent = e.message;
  }
}

async function open(file) {
  if (/\.json$/i.test(file.name)) return openTraces(file);
  if (/\.glb$/i.test(file.name)) return openTraced(file);
  const lost = unsaved();
  if (lost.length && !confirm(`Open ${file.name}?\n\nThis would discard ${lost.join(' and ')}.`)) return;
  dropErr.textContent = '';
  try {
    const c = await readScan(await file.arrayBuffer());
    if (!c.n) throw new Error('that file has no points in it');
    clearTraces();
    installCloud(c, file.name);
  } catch (e) {
    dropErr.textContent = e.message;
  }
}

document.getElementById('pick-btn').addEventListener('click', () => fileEl.click());
document.getElementById('open-btn').addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', () => { if (fileEl.files[0]) open(fileEl.files[0]); fileEl.value = ''; });
for (const ev of ['dragenter', 'dragover']) {
  window.addEventListener(ev, (e) => { e.preventDefault(); dropEl.hidden = false; dropEl.classList.add('over'); });
}
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) dropEl.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropEl.classList.remove('over');
  if (e.dataTransfer.files[0]) open(e.dataTransfer.files[0]);
  else if (cloudData) dropEl.hidden = true;
});

// ----------------------------------------------------------------------- saving
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('save-btn').addEventListener('click', () => {
  if (!cloudData) return;
  const { blob, kept } = writePly(cloudData, alive);
  download(blob, 'cleaned.ply');
  savedLive = liveCount;
  updateReadout();
  hintEl.textContent = `saved ${kept.toLocaleString()} points to cleaned.ply`;
});

document.getElementById('poly-btn').addEventListener('click', () => {
  if (!traceVerts.length) {
    hintEl.textContent = 'no polygon to save yet — this saves the outline you click in Trace (T). '
      + 'For the mesh Build made, use Save mesh.';
    return;
  }
  const data = {
    app: 'splat-editor',
    version: 1,
    vertices: traceVerts.map((v) => [Number(v.x.toFixed(6)), Number(v.y.toFixed(6)), Number(v.z.toFixed(6))]),
  };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'polygon.json');
  savedTrace = traceVerts.length;
  updateReadout();
  hintEl.textContent = `saved ${traceVerts.length} vertices to polygon.json`;
});

undoBtn.addEventListener('click', undo);

const plainBtn = document.getElementById('plain-btn');
function setPlain(on) {
  pointMaterial.uniforms.uPlain.value = on ? 1 : 0;
  plainBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
plainBtn.addEventListener('click', () => {
  setPlain(pointMaterial.uniforms.uPlain.value < 0.5);
});

/**
 * Hand the page a moment, and never wait forever for one.
 *
 * requestAnimationFrame is the right way to let a long job draw — except that it
 * does not fire at all when the tab is not being composited: backgrounded,
 * occluded, or driven by automation. A job that awaits it then stops dead, which
 * is not a slow build but a hung one, indistinguishable from a crash. Racing it
 * against a timer keeps the painting when the page is visible and keeps the work
 * moving when it is not.
 */
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const fire = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(fire);
    setTimeout(fire, 60);
  });
}

// ------------------------------------------------------------------- the build
// The same pipeline the command-line tool runs, on the cloud as you have left
// it, without leaving the page.
//
// This is the loop the whole tool was missing. Erasing is guesswork until you
// see what the build makes of it — a plume you left in reads as a spur, a patch
// you took too much off reads as a dent — and posting the file to a terminal to
// find out is slow enough that in practice you stop checking. It imports the
// algorithm rather than reimplementing it, so what appears here is what the tool
// would write, not an impression of it.
//
// Only the LIVE points go in. Erasing is the whole point of the room.
const trisEl = document.getElementById('tris');
const dirsEl = document.getElementById('dirs');
const gridEl = document.getElementById('gridr');
const isolEl = document.getElementById('isol');
const buildBtn = document.getElementById('build-btn');
let building = false;

for (const [el, id] of [[trisEl, 'tris-val'], [dirsEl, 'dirs-val'], [gridEl, 'gridr-val'], [isolEl, 'isol-val']]) {
  const out = document.getElementById(id);
  const sync = () => { out.textContent = el.value; };
  el.addEventListener('input', sync);
  sync();
}

/** The editor's cloud, minus what has been erased, in the pipeline's shape. */
function livePoints() {
  const n = liveCount;
  const x = new Float64Array(n); const y = new Float64Array(n); const z = new Float64Array(n);
  const opacity = new Float64Array(n); const radius = new Float64Array(n);
  const rgb = new Float64Array(n * 3);
  let j = 0;
  for (let i = 0; i < cloudData.n; i++) {
    if (!alive[i]) continue;
    x[j] = cloudData.pos[i * 3]; y[j] = cloudData.pos[i * 3 + 1]; z[j] = cloudData.pos[i * 3 + 2];
    opacity[j] = cloudData.opacity[i];
    radius[j] = cloudData.radius[i];
    rgb[j * 3] = cloudData.rgb[i * 3]; rgb[j * 3 + 1] = cloudData.rgb[i * 3 + 1]; rgb[j * 3 + 2] = cloudData.rgb[i * 3 + 2];
    j++;
  }
  return { count: n, format: 'ply', x, y, z, opacity, radius, rgb };
}

/**
 * The pipeline's mesh as something three can draw.
 *
 * Unindexed, three positions per triangle, one primitive per color group and no
 * normals of its own — which is exactly what the GLB writer emits, so
 * computeVertexNormals lands on face normals and the faceting matches the
 * gallery's rather than merely resembling it.
 */
function meshToThree(result) {
  const { mesh, group, colors } = result;
  const root = new THREE.Group();
  const byGroup = colors.map(() => []);
  for (let f = 0; f < mesh.faces.length / 3; f++) byGroup[group[f]].push(f);
  colors.forEach((c, g) => {
    const tris = byGroup[g];
    if (!tris.length) return;
    const pos = new Float32Array(tris.length * 9);
    let at = 0;
    for (const f of tris) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.faces[f * 3 + k];
        pos[at++] = mesh.verts[v * 3];
        pos[at++] = mesh.verts[v * 3 + 1];
        pos[at++] = mesh.verts[v * 3 + 2];
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    root.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.8, metalness: 0,
    })));
  });
  return root;
}

buildBtn.addEventListener('click', async () => {
  if (!cloudData || building) return;
  if (!liveCount) { hintEl.textContent = 'nothing left to build from'; return; }
  building = true;
  buildBtn.disabled = true;
  const started = performance.now();
  try {
    const result = await buildFromCloud(livePoints(), {
      grid: Number(gridEl.value),
      tris: Number(trisEl.value),
      hull: Number(dirsEl.value),
      consensus: Number(dirsEl.value) >= 240 ? 0.99 : 1,
      isolation: Number(isolEl.value),
    }, async (stage, frac) => {
      hintEl.textContent = `${stage}… ${(frac * 100).toFixed(0)}%`;
      await nextFrame();
    });

    dropTheMesh();
    builtMesh = meshToThree(result);
    meshSaved = false;
    scene.add(builtMesh);
    ensureLights();
    const s = result.stats;
    hintEl.textContent = `${s.triangles.toLocaleString()} triangles from ${s.kept.toLocaleString()} of `
      + `${s.read.toLocaleString()} points, ${s.cells.toLocaleString()} cells`
      + `${s.budget ? `, forgiving ${s.budget} of ${s.views} views` : ''}`
      + ` — ${((performance.now() - started) / 1000).toFixed(1)}s`;
    updateReadout();
    openPreview();
  } catch (e) {
    hintEl.textContent = `build failed: ${e.message}`;
  } finally {
    building = false;
    buildBtn.disabled = false;
  }
});

// ------------------------------------------------------------------ the vacuum
// The skin, once it has been pulled on. Shown instead of nothing and alongside
// the points, because the only way to tell whether the sheet behaved is to see
// it against the data it was pulled onto.
const skinEl = document.getElementById('skin');
const tensionEl = document.getElementById('tension');
const levelsEl = document.getElementById('levels');
const showPointsEl = document.getElementById('show-points');
const wrapBtn = document.getElementById('wrap-btn');

const dials = [[skinEl, 'skin-val', (v) => `${Number(v).toFixed(1)}mm`],
  [tensionEl, 'tension-val', (v) => `${v}%`],
  [levelsEl, 'levels-val', (v) => v]];
for (const [el, id, fmt] of dials) {
  const out = document.getElementById(id);
  const sync = () => { out.textContent = fmt(el.value); };
  el.addEventListener('input', sync);
  sync();
}
showPointsEl.addEventListener('change', () => { if (points) points.visible = showPointsEl.checked; });

wrapBtn.addEventListener('click', async () => {
  if (!cloudData || wrapping) return;
  wrapping = true;
  wrapBtn.disabled = true;
  const started = performance.now();
  try {
    const mesh = await wrap(cloudData.pos, alive, {
      skin: Number(skinEl.value) / 1000,
      tension: Number(tensionEl.value) / 100,
      levels: Number(levelsEl.value),
      onProgress: ({ frac, level, levels, triangles, touching }) => {
        hintEl.textContent = `vacuum: level ${level}/${levels}, ${triangles.toLocaleString()} triangles, `
          + `${(touching * 100).toFixed(0)}% touching, ${(frac * 100).toFixed(0)}%`;
      },
    });
    if (skinMesh) { scene.remove(skinMesh); skinMesh.geometry.dispose(); skinMesh.material.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(mesh.pos), 3));
    g.setIndex(Array.from(mesh.faces));
    g.computeVertexNormals();
    skinMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0xbfd4e4, roughness: 0.75, metalness: 0, flatShading: false,
    }));
    skinMesh.frustumCulled = false;
    meshSaved = false;
    scene.add(skinMesh);
    ensureLights();
    hintEl.textContent = `vacuum done: ${(mesh.faces.length / 3).toLocaleString()} triangles `
      + `in ${((performance.now() - started) / 1000).toFixed(1)}s`;
    updateReadout();
  } catch (e) {
    hintEl.textContent = `vacuum failed: ${e.message}`;
  } finally {
    wrapping = false;
    wrapBtn.disabled = false;
  }
});

// Whatever mesh is on screen, whichever of the two made it. Build and Vacuum
// both produce one and only the vacuum's used to be saveable, so the result of
// the thing you are most likely to want — the build — was the one thing here you
// could not get out of the page.
document.getElementById('mesh-btn').addEventListener('click', () => {
  const mesh = currentMesh();
  if (!mesh) { hintEl.textContent = 'nothing to save — run Build, or Vacuum'; return; }
  const stem = (loadedName || 'model').replace(/\.(ply|spz|glb|json)$/i, '');
  const name = `${stem}${builtMesh ? '-build' : '-wrapped'}.glb`;
  new GLTFExporter().parse(mesh, (glb) => {
    download(new Blob([glb], { type: 'model/gltf-binary' }), name);
    meshSaved = true;
    updateReadout();
    hintEl.textContent = `saved ${name}`;
  }, (err) => { hintEl.textContent = `export failed: ${err}`; }, { binary: true });
});

// ----------------------------------------------------------------------- input
// The right button orbits in every mode, so the left button is always free for
// whatever the mode is for. Touch orbits with one finger unless erasing.
let dragging = null;   // 'orbit' | 'tool' | null
let last = { x: 0, y: 0 };
let stroke = null;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  // Anything on screen can be turned. The TOOLS need a cloud — there is nothing
  // to erase or to snap to on a finished mesh — but looking at a thing is not a
  // tool, and gating the whole handler on the cloud is what made an opened build
  // sit there refusing to move.
  if (!loaded()) return;
  canvas.setPointerCapture(e.pointerId);
  last = { x: e.clientX, y: e.clientY };
  const wantsTool = e.button === 0 && mode !== 'orbit' && !!cloudData;
  dragging = wantsTool ? 'tool' : 'orbit';
  if (dragging !== 'tool') return;

  projectAll();
  if (mode === 'erase') {
    stroke = [];
    eraseAt(e.clientX, e.clientY, brushRadius(), stroke);
    aliveAttr.needsUpdate = true;
    updateReadout();
  } else if (mode === 'trace') {
    const i = pickAt(e.clientX, e.clientY, SNAP);
    if (i >= 0) {
      traceVerts.push(new THREE.Vector3(cloudData.pos[i * 3], cloudData.pos[i * 3 + 1], cloudData.pos[i * 3 + 2]));
      undoStack.push({ trace: true });
      undoBtn.disabled = false;
      refreshTrace();
    } else {
      hintEl.textContent = 'nothing under the cursor — click on a point';
    }
    dragging = null;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (mode === 'erase') {
    brushEl.style.left = `${e.clientX}px`;
    brushEl.style.top = `${e.clientY}px`;
  } else if (mode === 'trace' && cloudData && !dragging) {
    // Show the point a click would actually take. Projecting the whole cloud on
    // every move is a few thousand multiplies and nothing next to a frame.
    projectAll();
    const i = pickAt(e.clientX, e.clientY, SNAP);
    if (i >= 0) {
      snapEl.style.display = 'block';
      snapEl.style.left = `${screen.x[i]}px`;
      snapEl.style.top = `${screen.y[i]}px`;
    } else {
      snapEl.style.display = 'none';
    }
  }
  if (!dragging) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY };
  if (dragging === 'orbit') {
    const w = canvas.clientWidth || 1;
    yaw -= (dx / w) * 3.4;
    pitch = clamp(pitch + (dy / w) * 3.4, -1.5, 1.5);
    placeCamera();
  } else if (mode === 'erase' && stroke) {
    // Re-projecting mid-stroke would let the camera drift under the brush; the
    // projection from pointerdown is the one the ring was drawn against.
    eraseAt(e.clientX, e.clientY, brushRadius(), stroke);
    aliveAttr.needsUpdate = true;
    updateReadout();
  }
});

const endDrag = () => {
  if (dragging === 'tool' && stroke && stroke.length) {
    undoStack.push({ killed: stroke });
    undoBtn.disabled = false;
  }
  stroke = null;
  dragging = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', (e) => {
  if (!loaded()) return;
  e.preventDefault();
  // Shift and the wheel sizes the brush, because reaching for the slider in the
  // middle of picking noise off a leg is how you stop picking noise off a leg.
  if (e.shiftKey && mode === 'erase') {
    brushInput.value = String(clamp(Number(brushInput.value) + Math.sign(e.deltaY) * -6, 8, 220));
    brushInput.dispatchEvent(new Event('input'));
    return;
  }
  dist = clamp(dist * (1 + e.deltaY * 0.0015), camera.near * 4, camera.far / 3);
  placeCamera();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === '[' || e.key === ']') {
    brushInput.value = String(clamp(Number(brushInput.value) + (e.key === ']' ? 8 : -8), 8, 220));
    brushInput.dispatchEvent(new Event('input'));
  }
  // Letters as well as numbers. Erasing is a rhythm of look, cut, look again,
  // and reaching for the header to change mode breaks it every few seconds —
  // the point of a shortcut here is that the hand never leaves the work.
  const k = e.key.toLowerCase();
  if (k === 'c') setPlain(pointMaterial.uniforms.uPlain.value < 0.5);
  if (k === 'l' || e.key === '1') setMode('orbit');
  if (k === 'e' || e.key === '2') setMode('erase');
  if (k === 't' || e.key === '3') setMode('trace');
  if (k === 'f') fitView();
});

// ---------------------------------------------------------------- the traces
// A traces.json from `splat2glb --trace-out`, drawn against the cloud it was
// traced from.
//
// This is the answer to a fair question — how does drawing round the outside of
// something end up with holes in the middle — and the honest answer was that the
// outlines were not closed. Being able to lay them back over the points is what
// turns that from an argument into something you can look at, one view at a
// time, from the angle it was drawn at.
const traceGroup = new THREE.Group();
scene.add(traceGroup);
let traceData = null;
const tracesEl = document.getElementById('traces');
const traceI = document.getElementById('trace-i');
const traceVal = document.getElementById('trace-val');
const traceAll = document.getElementById('trace-all');
const traceInfo = document.getElementById('trace-info');

/**
 * One outline, in the world.
 *
 * Two shapes of trace file, and they want drawing differently. A newer one
 * carries `rings`: closed loops of measured points, in world coordinates,
 * already in the order they were walked — so they draw as actual lines. An older
 * one carries only `outline`, a set of boundary PIXELS in raster order, which is
 * not a path at all; joining those consecutively draws a cat's cradle across the
 * middle instead of a rim, so they go up as loose points.
 */
function outlineLine(t, cell, colour, opacity) {
  const g = new THREE.Group();
  if (t.rings && t.rings.length) {
    const m = new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity });
    for (const ring of t.rings) {
      const pts = ring.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      pts.push(pts[0]); // closed, and it should read as closed
      const o = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m);
      o.frustumCulled = false;
      g.add(o);
    }
    return g;
  }
  const pts = [];
  for (const [px, py] of t.outline) {
    const su = (px - t.pad) * cell + t.au;
    const sv = (py - t.pad) * cell + t.av;
    pts.push(new THREE.Vector3(
      su * t.u[0] + sv * t.v[0],
      su * t.u[1] + sv * t.v[1],
      su * t.u[2] + sv * t.v[2],
    ));
  }
  const m = new THREE.PointsMaterial({ color: colour, size: 4, sizeAttenuation: false, transparent: opacity < 1, opacity });
  const o = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), m);
  o.frustumCulled = false;
  g.add(o);
  return g;
}

function showTraceData(data) {
  traceData = data;
  traceI.max = String(data.traces.length - 1);
  traceI.value = '0';
  tracesEl.hidden = false;
  dropEl.hidden = true;
  showTraces();
}

/** Opening a different cloud should not leave the last one's outlines hanging. */
function clearTraces() {
  traceData = null;
  tracesEl.hidden = true;
  showTraces();
}

function showTraces() {
  for (const c of [...traceGroup.children]) {
    traceGroup.remove(c);
    c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  if (!traceData) return;
  const cell = traceData.cell;
  const i = Number(traceI.value);
  if (traceAll.checked) {
    for (const t of traceData.traces) traceGroup.add(outlineLine(t, cell, 0x2f6f5c, 0.5));
  }
  const t = traceData.traces[i];
  traceGroup.add(outlineLine(t, cell, 0x7fe8c0, 1));
  traceVal.textContent = `${i + 1} / ${traceData.traces.length}`;
  const how = t.rings
    ? `${t.rings.length} ring(s), ${t.rings.reduce((a, r) => a + r.length, 0)} real points`
    : `${t.outline.length} boundary pixels`;
  traceInfo.textContent = [
    t.closing === undefined ? null : `closing ${t.closing}px scaffolding`,
    how,
    t.filled === undefined ? null : `${t.filled} filled`,
  ].filter(Boolean).join(' · ');
}

traceI.addEventListener('input', showTraces);
traceAll.addEventListener('change', showTraces);
document.getElementById('trace-face').addEventListener('click', () => {
  if (!traceData) return;
  const d = traceData.traces[Number(traceI.value)].direction;
  if (!d) return; // a GLB written by something else, with no view recorded
  // Straight down the barrel of the view this outline was drawn from, which is
  // the only angle at which an outline should look like an outline.
  pitch = Math.asin(clamp(d[1], -1, 1));
  yaw = Math.atan2(d[0], d[2]);
  placeCamera();
});

// ------------------------------------------------------------- the preview
// What this mesh would look like in Object Tile Scroll, before committing to
// finding out.
//
// The workshop's own view is a diagnostic: bright neutral points, a soft grey
// skin, no tone mapping worth the name — everything chosen so you can SEE the
// data. The gallery is the opposite, a near-black room with a hard rig, and a
// mesh that reads perfectly well here can arrive there as a lump. The gap is
// worth closing before a build ships rather than after.
//
// So this is not a stylised impression of the piece. It is the piece's own
// backdrop, environment, five lights, tone curve, finish palette, bake and
// normalization, imported from one file that exists to be diffed against it.
//
// Two framings, because they answer different questions. FIELD is the object at
// the size and distance it actually appears at, which is where a silhouette
// either reads or does not. CLOSER is the gallery's own inspector distance,
// which is where the surface either holds up or shows its facets.
import {
  FINISHES, FIELD, CLOSER, roomBackdrop, roomEnvironment, addLights,
  applyToneMapping, normalize, bakeModel, groupsOf, applyLook, newMaterial,
} from './gallery-look.js';

const previewEl = document.getElementById('preview');
const previewCanvas = document.getElementById('preview-canvas');
const previewNote = document.getElementById('preview-note');
const previewWhere = document.getElementById('preview-where');
const previewFinish = document.getElementById('preview-finish');

let pv = null;             // the whole preview rig, built once and kept
let pvOpen = false;
let pvCloser = true;
let pvFinish = 0;
let pvColor = 0;
let pvYaw = 0.6;
let pvPitch = 0.25;
let pvSpin = true;         // until you take hold of it
let pvRaf = 0;

function buildPreview() {
  const renderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
  applyToneMapping(renderer);
  const pvScene = new THREE.Scene();
  pvScene.background = roomBackdrop();
  pvScene.environment = roomEnvironment(renderer);
  addLights(pvScene);
  const cam = new THREE.PerspectiveCamera(CLOSER.fov, 1, CLOSER.near, CLOSER.far);
  const mats = [newMaterial()];
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mats[0]);
  pvScene.add(mesh);
  pv = { renderer, scene: pvScene, cam, mesh, mats, groups: [{ dh: 0, ds: 0, dl: 0 }] };
}

/** Bake whatever mesh is in the editor into a gallery build. */
function loadPreviewGeometry() {
  const src = currentMesh();
  if (!src) return 'nothing to preview — open a built .glb, or run the vacuum';
  const baked = bakeModel(src);
  if (!baked) return 'that mesh would not bake — no triangles in it';
  if (pv.mesh.geometry) pv.mesh.geometry.dispose();
  pv.mesh.geometry = normalize(baked.geometry);
  pv.groups = groupsOf(baked.colors);
  while (pv.mats.length < pv.groups.length) pv.mats.push(newMaterial());
  pv.mesh.material = pv.groups.length === 1 ? pv.mats[0] : pv.mats.slice(0, pv.groups.length);
  const g = pv.mesh.geometry;
  const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  pv.tris = Math.round(tris);
  pv.smooth = !!g.index;
  return null;
}

function paintPreview() {
  const f = FINISHES[pvFinish];
  pvColor %= f.colors.length;
  applyLook(pv.mats, pv.groups, pvFinish, f.colors[pvColor]);
  previewFinish.textContent = f.name;
}

function placePreview() {
  const cam = pv.cam;
  if (pvCloser) {
    cam.fov = CLOSER.fov; cam.near = CLOSER.near; cam.far = CLOSER.far;
    pv.mesh.position.set(0, 0, 0);
    pv.mesh.scale.setScalar(1);
    const cp = Math.cos(pvPitch);
    cam.position.set(
      Math.sin(pvYaw) * cp * CLOSER.dist,
      Math.sin(pvPitch) * CLOSER.dist,
      Math.cos(pvYaw) * cp * CLOSER.dist,
    );
    cam.lookAt(0, 0, 0);
  } else {
    // The field's camera never moves: it sits at the origin looking down -Z,
    // and the object stands out in the room. Turning it here therefore turns the
    // OBJECT, which is also what the field's spinning habit does.
    cam.fov = FIELD.fov; cam.near = FIELD.near; cam.far = FIELD.far;
    cam.position.set(0, 0, 0);
    cam.rotation.set(0, 0, 0);
    pv.mesh.position.set(0, 0, -FIELD.depth);
    pv.mesh.scale.setScalar(FIELD.scale);
    pv.mesh.rotation.set(pvPitch, pvYaw, 0);
  }
  cam.updateProjectionMatrix();
}

function pvResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  pv.renderer.setSize(w, h, false);
  pv.cam.aspect = w / h;
  pv.cam.updateProjectionMatrix();
}

function pvFrame() {
  if (!pvOpen) return;
  if (pvSpin) pvYaw += 0.004;
  placePreview();
  pv.renderer.render(pv.scene, pv.cam);
  pvRaf = requestAnimationFrame(pvFrame);
}

function openPreview() {
  if (!pv) buildPreview();
  const why = loadPreviewGeometry();
  if (why) { hintEl.textContent = why; return; }
  pvOpen = true;
  pvSpin = true;
  previewEl.hidden = false;
  pvResize();
  paintPreview();
  previewWhere.textContent = pvCloser ? 'Closer look' : 'In the field';
  // The overlay covers the workshop entirely, so it is the one view with no
  // other clue about which file this came from.
  document.getElementById('preview-name').textContent = loadedName
    ? `${loadedName} — as Object Tile Scroll would show it`
    : 'As Object Tile Scroll would show it';
  previewNote.textContent = `${pv.tris.toLocaleString()} triangles · `
    + `${pv.groups.length} color group${pv.groups.length === 1 ? '' : 's'} · `
    + `${pv.smooth ? 'indexed, so smooth-shaded' : 'unindexed, so faceted'}\n`
    + 'drag to turn · click the finish to cycle · the gallery deals these at random';
  pvFrame();
}

function closePreview() {
  pvOpen = false;
  cancelAnimationFrame(pvRaf);
  previewEl.hidden = true;
}

document.getElementById('preview-btn').addEventListener('click', openPreview);
document.getElementById('preview-close').addEventListener('click', closePreview);
previewWhere.addEventListener('click', () => {
  pvCloser = !pvCloser;
  previewWhere.textContent = pvCloser ? 'Closer look' : 'In the field';
});
previewFinish.addEventListener('click', () => {
  // Through every color of every finish in turn, rather than a jump to the next
  // finish — the palette within a finish is as much of the look as the finish is.
  pvColor++;
  if (pvColor >= FINISHES[pvFinish].colors.length) {
    pvColor = 0;
    pvFinish = (pvFinish + 1) % FINISHES.length;
  }
  paintPreview();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pvOpen) closePreview();
});
previewCanvas.addEventListener('pointerdown', (e) => {
  pvSpin = false;
  previewCanvas.setPointerCapture(e.pointerId);
  let px = e.clientX; let py = e.clientY;
  const move = (m) => {
    pvYaw -= (m.clientX - px) * 0.008;
    pvPitch = clamp(pvPitch + (m.clientY - py) * 0.008, -1.45, 1.45);
    px = m.clientX; py = m.clientY;
  };
  const up = () => {
    previewCanvas.removeEventListener('pointermove', move);
    previewCanvas.removeEventListener('pointerup', up);
  };
  previewCanvas.addEventListener('pointermove', move);
  previewCanvas.addEventListener('pointerup', up);
});

// ------------------------------------------------------------- not losing it
// Three ways out of here, and each needs its own guard.
//
let leaving = false;

// beforeunload covers closing the tab, reloading, and typing somewhere else. The
// browser will not show our words in that dialog — it has said "changes you made
// may not be saved" and nothing else for years now — so the readout carries the
// detail instead, and this is only the stop sign.
window.addEventListener('beforeunload', (e) => {
  if (leaving || !unsaved().length) return;
  e.preventDefault();
  e.returnValue = '';
});

// The Gallery link is our own, so it CAN say what is about to be lost. Worth the
// extra handler: "3,412 erased points" is a reason to stay, where "changes you
// made" is a sentence people click through without reading.
document.querySelector('.bar .back').addEventListener('click', (e) => {
  const lost = unsaved();
  if (!lost.length) return;
  e.preventDefault();
  if (!confirm(`Leave without saving?\n\nThis would discard ${lost.join(' and ')}.`)) return;
  leaving = true;
  window.location.href = e.currentTarget.href;
});

// ------------------------------------------------------------------------- loop
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointMaterial.uniforms.uSize.value = 2 * renderer.getPixelRatio();
  // The header wraps to two rows on a narrow window, so how far down the side
  // panels have to start is something to measure rather than to assume.
  document.documentElement.style.setProperty(
    '--bar', `${document.querySelector('.bar').getBoundingClientRect().height}px`,
  );
  if (pv) pvResize();
}
window.addEventListener('resize', resize);
resize();
setMode('orbit');
brushInput.dispatchEvent(new Event('input'));

function frame() {
  requestAnimationFrame(frame);
  renderer.render(scene, camera);
}
frame();
