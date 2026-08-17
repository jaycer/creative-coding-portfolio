// A box you can steer by.
//
// Turning something with a drag tells you which way it moved and never which way
// it is FACING, and on an object with no obvious front — a scan of a pig, viewed
// from wherever the phone happened to start — that gap is most of the confusion.
// A labelled cube fixes both ends of it at once: it reads out the orientation
// continuously, and it takes a click to snap to any of its twenty-six views.
//
// Drawn as glass. The three panels facing you carry their labels; the far three
// are culled, because a label seen through the back of its own face is mirrored
// and reads as a different word. What comes through the glass instead is the far
// CAGE — and edges are the part worth seeing through, since an edge is a view
// you can click and a mirrored word is not.
//
// Its own canvas and its own tiny renderer rather than a corner viewport of the
// main one. A scissor rectangle would have to be undone every frame, would
// inherit whatever camera and tone settings the host had, and would put the
// cube's picking in the host's coordinate space — three things to get wrong for
// no gain. This way it is a widget: hand it a yaw and a pitch, get a click back.

import * as THREE from 'three';

// Three's own material order for a BoxGeometry: +x, -x, +y, -y, +z, -z.
// The labels are what those faces mean when the camera is looking AT them.
const LABELS = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];

const GREEN = '#7fe8c0';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace';

/**
 * One face, as a transparent panel: a faint wash, a grid, an inset frame and a
 * label. Two versions of each — resting and aimed-at — swapped on hover, because
 * a material's color multiplies the texture's RGB and cannot touch its alpha, so
 * tinting alone can brighten a panel but never make it read as filled.
 */
function faceTexture(label, hot) {
  const s = 160;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');

  g.fillStyle = hot ? 'rgba(127,232,192,0.30)' : 'rgba(127,232,192,0.07)';
  g.fillRect(0, 0, s, s);

  // Graph paper, faintly. Gives the glass something to catch the eye at a
  // grazing angle, where a plain wash disappears entirely.
  g.strokeStyle = hot ? 'rgba(127,232,192,0.45)' : 'rgba(127,232,192,0.16)';
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const t = (i * s) / 8;
    g.beginPath(); g.moveTo(t, 0); g.lineTo(t, s); g.stroke();
    g.beginPath(); g.moveTo(0, t); g.lineTo(s, t); g.stroke();
  }

  // Corner brackets rather than a full border: reads as a targeting reticle and
  // leaves the middle clear for the label.
  g.strokeStyle = hot ? GREEN : 'rgba(127,232,192,0.55)';
  g.lineWidth = 3;
  const m = 10; const arm = 26;
  for (const [x, y, dx, dy] of [[m, m, 1, 1], [s - m, m, -1, 1], [m, s - m, 1, -1], [s - m, s - m, -1, -1]]) {
    g.beginPath();
    g.moveTo(x + dx * arm, y);
    g.lineTo(x, y);
    g.lineTo(x, y + dy * arm);
    g.stroke();
  }

  g.font = `600 ${label.length > 5 ? 19 : 22}px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (hot) {
    g.shadowColor = GREEN;
    g.shadowBlur = 12;
  }
  g.fillStyle = hot ? '#eafff6' : GREEN;
  // Letter-spaced by hand. ctx.letterSpacing is recent enough that leaning on it
  // would silently drop the tracking in older browsers, and tracking is most of
  // what makes a monospaced label read as an instrument rather than as text.
  const track = 3;
  const chars = [...label];
  const width = chars.reduce((w, ch) => w + g.measureText(ch).width + track, -track);
  let x = s / 2 - width / 2;
  for (const ch of chars) {
    const w = g.measureText(ch).width;
    g.fillText(ch, x + w / 2, s / 2);
    x += w + track;
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * @param {HTMLCanvasElement} canvas where to draw it
 * @param {(yaw:number, pitch:number)=>void} onPick called when a view is clicked
 * @param {(dx:number, dy:number)=>void} onDrag called while the cube is dragged
 */
export function makeViewCube(canvas, onPick, onDrag) {
  const size = 104;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size, false);

  const scene = new THREE.Scene();
  const cool = LABELS.map((l) => faceTexture(l, false));
  const hot = LABELS.map((l) => faceTexture(l, true));
  const materials = LABELS.map((l, i) => new THREE.MeshBasicMaterial({
    map: cool[i],
    transparent: true,
    // Off, or the near faces would occlude the far ones and the glass would be
    // opaque in everything but name.
    depthWrite: false,
    side: THREE.FrontSide,
  }));
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  scene.add(cube);

  const wire = new THREE.EdgesGeometry(cube.geometry);
  cube.add(new THREE.LineSegments(wire, new THREE.LineBasicMaterial({
    color: 0x7fe8c0, transparent: true, opacity: 0.95, depthWrite: false,
  })));
  // A second cage a hair outside the first. WebGL will not draw a line thicker
  // than a pixel, so a halo is the only way to give the edges any weight.
  const halo = new THREE.LineSegments(wire, new THREE.LineBasicMaterial({
    color: 0x7fe8c0, transparent: true, opacity: 0.22, depthWrite: false,
  }));
  halo.scale.setScalar(1.035);
  cube.add(halo);

  // Orthographic, because a cube in perspective leans, and a leaning cube reads
  // as an orientation it is not at.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 3);

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const local = new THREE.Vector3();
  let hovered = [];

  function draw() { renderer.render(scene, camera); }

  /**
   * Face the cube the way the host camera faces the object.
   *
   * The host's camera orbits the model; the cube stands still and turns under
   * the same angles, inverted — so a face pointing at you here is the side of
   * the object pointing at you there.
   *
   * The host puts its camera along d = RotY(yaw)·RotX(-pitch)·(0,0,1), so the
   * rotation that brings that direction back to the cube camera's own +Z is the
   * inverse of it, RotX(pitch)·RotY(-yaw) — which is what these two calls
   * compose to, in this order. Getting the sign of the yaw wrong here produces a
   * cube that turns the right amount the wrong way, which looks almost right and
   * is worse than no cube at all.
   */
  function setOrientation(yaw, pitch) {
    cube.rotation.set(0, 0, 0);
    cube.rotateX(pitch);
    cube.rotateY(-yaw);
    draw();
  }

  // How close to an edge counts as aiming at it. In cube-local units, where a
  // face runs from -0.5 to 0.5, so this is the outer 16% of each face.
  const RIM = 0.34;

  /**
   * What the cursor is aiming at: a face, an edge or a corner.
   *
   * The axis facing the camera is always at its extreme, so the number of axes
   * near their extreme IS the answer — one is a face, two an edge, three a
   * corner. The view direction falls straight out of it: the signs of those
   * axes, normalized. A corner of the +x+y+z octant is the (1,1,1) view, which
   * is the three-quarter angle you actually want to inspect something from and
   * the one a six-face cube cannot offer.
   *
   * Single-sided panels also settle the picking for free: a ray can only strike
   * the faces turned toward the camera, so the first hit is the one under the
   * cursor and there is no far side to disambiguate against.
   */
  function aimAt(e) {
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObject(cube, false)[0];
    if (!hit) return null;
    local.copy(hit.point);
    cube.worldToLocal(local);
    const c = [local.x, local.y, local.z];
    const dir = [0, 0, 0];
    const faces = [];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(c[a]) < RIM) continue;
      dir[a] = c[a] > 0 ? 1 : -1;
      faces.push(a * 2 + (c[a] > 0 ? 0 : 1)); // BoxGeometry order: +x -x +y -y +z -z
    }
    if (!faces.length) return null;
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    return { dir: [dir[0] / len, dir[1] / len, dir[2] / len], faces };
  }

  function highlight(faces) {
    if (faces.length === hovered.length && faces.every((f, i) => f === hovered[i])) return;
    for (const f of hovered) materials[f].map = cool[f];
    hovered = faces;
    for (const f of hovered) materials[f].map = hot[f];
    for (const m of materials) m.needsUpdate = true;
    canvas.style.cursor = hovered.length ? 'pointer' : 'default';
    draw();
  }

  // Drag it as well as click it.
  //
  // Otherwise the cube is the one thing on screen you can only ever jump with:
  // to look somewhere between two of its twenty-six views you have to leave it,
  // cross the window, and drag the main canvas — which is a mode change and a
  // journey for what should be a nudge. Dragging here turns the model exactly as
  // dragging there does, so the cube is a control and not just a signpost.
  //
  // A click is a drag that went nowhere. Deciding between them on release rather
  // than on press is what lets both live on the same button: below the slop
  // threshold it snaps, above it, it never fires the snap at all.
  const SLOP = 4;      // pixels of wander still counted as a click
  const TURN = 0.011;  // radians per pixel; the widget is small, so faster than the main view
  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    // State first, capture second. setPointerCapture throws if the pointer is
    // already gone, and with the order reversed that exception aborts the rest
    // of the handler — leaving the drag unrecorded, so the cube silently stops
    // being draggable rather than merely losing events outside its bounds.
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      const a = aimAt(e);
      highlight(a ? a.faces : []);
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.moved > SLOP) {
      highlight([]);
      if (onDrag) onDrag(dx * TURN, dy * TURN);
    }
  });

  const release = (e) => {
    if (!drag) return;
    const wasClick = drag.moved <= SLOP;
    drag = null;
    if (!wasClick) return;
    const a = aimAt(e);
    if (!a) return;
    // Back out the host's own angles from the direction. Its camera sits at
    // (sin yaw cos pitch, sin pitch, cos yaw cos pitch), so this inverts that.
    const [x, y, z] = a.dir;
    const pitch = Math.asin(Math.min(1, Math.max(-1, y)));
    const yaw = Math.atan2(x, z);
    // Straight up and straight down have no yaw of their own; lookAt would roll
    // the camera arbitrarily, so back off the pole by a hair.
    const eps = 1e-3;
    onPick(yaw, Math.min(Math.PI / 2 - eps, Math.max(-Math.PI / 2 + eps, pitch)));
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointerleave', () => { if (!drag) highlight([]); });

  return { setOrientation, draw };
}
