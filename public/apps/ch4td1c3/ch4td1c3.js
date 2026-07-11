// ch4td1c3 — a pocket set of DnD dice.
//
// Seven polyhedra (d4 through d20) laid out on a leather pad and drawn by
// dice.frag.glsl as raymarched SDFs. Every face carries its number inside a
// heart, all the time, like a real die. Tap a die to roll just it; "Roll all"
// tumbles the set with a small stagger. A roll is quick (~0.5s): the die spins
// around a random axis, hops, and eases to a stop with the rolled face square
// to the camera, glyph upright. All the numbers live in a glyph atlas drawn
// once into an offscreen canvas.
//
// The RNG picks the result up front; the animation is theater. JS keeps the
// quaternions and per-die timing here and ships rotation matrices + scale
// bounce to the shader every frame.

const DIE_DEFS = [
  { name: 'd4',  sides: 4 },
  { name: 'd6',  sides: 6 },
  { name: 'd8',  sides: 8 },
  { name: 'd10', sides: 10 },
  { name: 'd%',  sides: 10, percentile: true },
  { name: 'd12', sides: 12 },
  { name: 'd20', sides: 20 },
];
const NDICE = DIE_DEFS.length;

// Face normals per solid, in the exact id order dice.frag.glsl's faceInfo()
// considers them — face id k carries value k+1, and a roll of v settles by
// rotating FACE_SETS[die][v-1] to point straight at the camera, upright.
const S3 = 1 / Math.sqrt(3);
const PH_A = 0.5257311, PH_B = 0.8506508; // dodecahedron rep normals
const IC_A = 0.3568221, IC_B = 0.9341724; // icosahedron edge-type reps
const neg = (n) => [-n[0], -n[1], -n[2]];
const pairs = (reps) => reps.flatMap((n) => [n, neg(n)]);

const D10_FACES = [
  [0.848, 0.53, 0], [0.262046, 0.53, 0.806496], [-0.686046, 0.53, 0.498442],
  [-0.686046, 0.53, -0.498442], [0.262046, 0.53, -0.806496],
  [0.686046, -0.53, 0.498442], [-0.262046, -0.53, 0.806496], [-0.848, -0.53, 0],
  [-0.262046, -0.53, -0.806496], [0.686046, -0.53, -0.498442],
];

const FACE_SETS = [
  [[S3, S3, S3], [S3, -S3, -S3], [-S3, S3, -S3], [-S3, -S3, S3]],                    // d4
  [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],             // d6
  [[S3, S3, S3], [-S3, S3, S3], [S3, -S3, S3], [-S3, -S3, S3],
   [S3, S3, -S3], [-S3, S3, -S3], [S3, -S3, -S3], [-S3, -S3, -S3]],                  // d8
  D10_FACES,                                                                          // d10
  D10_FACES,                                                                          // d%
  pairs([[0, PH_A, PH_B], [0, PH_A, -PH_B], [PH_A, PH_B, 0],
         [PH_A, -PH_B, 0], [PH_B, 0, PH_A], [PH_B, 0, -PH_A]]),                       // d12
  pairs([[S3, S3, S3], [S3, S3, -S3], [S3, -S3, S3], [S3, -S3, -S3],
         [0, IC_A, IC_B], [0, IC_A, -IC_B], [IC_A, IC_B, 0], [-IC_A, IC_B, 0],
         [IC_B, 0, IC_A], [IC_B, 0, -IC_A]]),                                         // d20
];

// Die looks. Colors are linear-ish RGB triples for the shader.
const THEMES = [
  { id: 'matcha',    name: 'Matcha Hearts',   body: [0.647, 0.729, 0.616], accent: [0.871, 0.549, 0.608], num: [0.42, 0.17, 0.23],  gloss: 36, spec: 0.5,  transluc: 0 },
  { id: 'seaglass',  name: 'Seaglass Gold',   body: [0.216, 0.478, 0.435], accent: [0.933, 0.784, 0.29],  num: [0.07, 0.24, 0.21],  gloss: 90, spec: 0.95, transluc: 0.65 },
  { id: 'licorice',  name: 'Licorice Silver', body: [0.145, 0.137, 0.168], accent: [0.82, 0.81, 0.87],    num: [0.13, 0.12, 0.15],  gloss: 80, spec: 0.85, transluc: 0 },
  { id: 'bubblegum', name: 'Bubblegum',       body: [0.906, 0.624, 0.714], accent: [1.0, 0.953, 0.965],   num: [0.78, 0.36, 0.48],  gloss: 28, spec: 0.4,  transluc: 0 },
];

let theShader, vertSrc, fragSrc;
let atlas;                 // offscreen glyph sheet (8x4 cells)
let dice = [];             // per-die runtime state
let theme = THEMES[0];

// --- shared uniform buffers ---
const uDie  = new Float32Array(NDICE * 3);
const uAnim = new Float32Array(NDICE * 4);
const uRotA = new Float32Array(NDICE * 3);
const uRotB = new Float32Array(NDICE * 3);
const uRotC = new Float32Array(NDICE * 3);

// DOM refs
let elLabels, elTotal;

function preload() {
  vertSrc = loadStrings('./dice.vert.glsl');
  fragSrc = loadStrings('./dice.frag.glsl');
}

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight, WEBGL);
  cnv.position(0, 0, 'fixed');
  // Render at device resolution (capped at 2x for mobile GPUs) so the
  // raymarched edges don't alias; draw() scales the px-space uniforms by the
  // same density so gl_FragCoord stays aligned with the die centers.
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  noStroke();
  theShader = createShader(vertSrc.join('\n'), fragSrc.join('\n'));

  buildAtlas();
  initDice();
  layout();
  wireUi();
  attachInput(cnv.elt);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  layout();
}

// ---------------------------------------------------------------------------
// Glyph atlas: cells 0..19 = "1".."20", cells 20..29 = "00","10".."90" (d%).
// White glyphs on transparent; the shader colors them via alpha.
// ---------------------------------------------------------------------------
function buildAtlas() {
  const CELL = 256; // roomy cells so numbers stay crisp on 2x displays
  atlas = createGraphics(CELL * 8, CELL * 4);
  atlas.pixelDensity(1);
  atlas.clear();
  atlas.noStroke();
  atlas.fill(255);
  atlas.textAlign(CENTER, CENTER);
  atlas.textFont('Arial'); // clean sans; universally available
  atlas.textStyle(BOLD);
  const labels = [];
  for (let i = 1; i <= 20; i++) labels.push(String(i));
  for (let i = 0; i < 10; i++) labels.push(i === 0 ? '00' : String(i * 10));
  labels.forEach((label, i) => {
    const cx = (i % 8) * CELL + CELL / 2;
    const cy = Math.floor(i / 8) * CELL + CELL / 2;
    atlas.textSize(label.length > 1 ? 128 : 152);
    atlas.text(label, cx, cy + 8);
  });
}

// ---------------------------------------------------------------------------
// Quaternions [x, y, z, w]
// ---------------------------------------------------------------------------
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qAxisAngle(axis, ang) {
  const s = Math.sin(ang / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
}

// Shortest-arc rotation taking unit vector a to unit vector b.
function qFromTo(a, b) {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  const w = 1 + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (w < 1e-6) return [1, 0, 0, 0]; // antiparallel: any half-turn works
  const n = Math.hypot(cx, cy, cz, w);
  return [cx / n, cy / n, cz / n, w / n];
}

// Columns of the object→world matrix for quat q — exactly what the shader
// wants as its world→object rows.
function qToCols(q) {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function qRotate(q, v) {
  const c = qToCols(q);
  return [0, 1, 2].map((r) => c[0][r] * v[0] + c[1][r] * v[1] + c[2][r] * v[2]);
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; };

// Orientation that lands face value `v` of die `i` square to the camera with
// its glyph upright. The tangent basis here mirrors faceUV() in the shader
// (same ref vector, same fallback) — the glyph's up is t2, so after rotating
// the face normal to +z we spin about z until t2 points up the screen.
function faceUpQuat(i, v) {
  const n = FACE_SETS[i][v - 1];
  const q1 = qFromTo(n, [0, 0, 1]);
  let t1 = cross3(n, [0.267, 0.923, 0.276]);
  if (dot3(t1, t1) < 0.05) t1 = cross3(n, [1, 0, 0]);
  t1 = norm3(t1);
  const t2w = qRotate(q1, cross3(n, t1));
  return qMul(qAxisAngle([0, 0, 1], Math.PI / 2 - Math.atan2(t2w[1], t2w[0])), q1);
}

function randUnit() {
  let v, n;
  do {
    v = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    n = Math.hypot(v[0], v[1], v[2]);
  } while (n < 0.01 || n > 1);
  return [v[0] / n, v[1] / n, v[2] / n];
}

// ---------------------------------------------------------------------------
// Dice state
// ---------------------------------------------------------------------------
function initDice() {
  dice = DIE_DEFS.map((def, i) => ({
    ...def,
    idx: i,
    cx: 0, cy: 0, r: 60,
    quat: faceUpQuat(i, def.sides), // rest showing the top face, like a shop shelf
    spinAxis: [0, 1, 0],
    spinTotal: 0,
    rollStart: -1,
    rollDur: 520,
    pending: null,
    value: null,
    reported: true,
    labelEl: null,
    valueEl: null,
  }));
}

// A roll is decided the moment you ask for it; the tumble is presentation.
// `delay` (ms) staggers "Roll all" so the set cascades.
function rollDie(i, delay) {
  const d = dice[i];
  const now = millis();
  const rolling = d.pending || (d.rollStart >= 0 && (now - d.rollStart) / d.rollDur < 1);
  if (rolling) return; // a die in the air can't be re-thrown

  const v = 1 + Math.floor(Math.random() * d.sides);
  const pending = {
    spinAxis: randUnit(),
    spinTotal: (7 + Math.random() * 4) * (Math.random() < 0.5 ? -1 : 1),
    // the rolled face lands frontside up; ±3° of tilt keeps it looking thrown
    quat: qMul(qAxisAngle([0, 0, 1], (Math.random() - 0.5) * 0.12), faceUpQuat(i, v)),
    value: d.percentile ? (v === 10 ? 100 : v * 10) : v, // 00 counts as 100
  };
  d.pending = pending;
  d.rollStart = now + delay;
  d.rollDur = 480 + Math.random() * 120;
  d.reported = true; // stays true until the new value lands (commit resets it)
  DiceAudio.roll(delay / 1000);
}

function rollAll() {
  dice.forEach((d, i) => rollDie(i, i * 45 + Math.random() * 30));
}

// ---------------------------------------------------------------------------
// Layout: 4+3 in landscape, 2/2/2/1 in portrait (the d20 gets the last row).
// ---------------------------------------------------------------------------
function layout() {
  const top = 60, bottom = 52; // footer is just the total line now
  const LABEL = 28; // strip under each die for its name/value
  const availH = height - top - bottom;
  const rows = width > height ? [4, 3] : [2, 2, 2, 1];
  const maxCols = Math.max(...rows);
  const slotH = availH / rows.length;
  // Solve the radius from the space itself: a row is exactly one die plus its
  // label, so no height is spent on dead gaps between rows.
  const r = Math.min((slotH - LABEL) / 2, (width / maxCols) * 0.42, 170);
  let k = 0;
  rows.forEach((n, ri) => {
    // center each die+label block inside its slot
    const cy = top + slotH * ri + (slotH - (2 * r + LABEL)) / 2 + r;
    for (let c = 0; c < n; c++, k++) {
      dice[k].cx = width * (c + 0.5 + (maxCols - n) / 2) / maxCols;
      dice[k].cy = cy;
      dice[k].r = r;
    }
  });
  positionLabels();
}

function positionLabels() {
  dice.forEach((d) => {
    if (!d.labelEl) return;
    d.labelEl.style.left = d.cx + 'px';
    d.labelEl.style.top = (d.cy + d.r + 6) + 'px';
  });
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
function draw() {
  const now = millis();

  for (const d of dice) {
    // Commit a pending roll the moment its stagger delay is up.
    if (d.pending && now >= d.rollStart) {
      Object.assign(d, d.pending);
      d.pending = null;
      d.reported = false;
    }

    let t = d.rollStart < 0 ? 1 : (now - d.rollStart) / d.rollDur;
    if (d.pending) t = 1; // stagger still pending: hold the old resting pose

    let q, scale;
    if (t >= 1) {
      q = d.quat;
      // tiny damped wobble just after landing
      const s2 = (now - (d.rollStart + d.rollDur)) / 1000;
      scale = d.rollStart >= 0 && s2 < 1.2 ? 1 + 0.04 * Math.exp(-5 * s2) * Math.sin(18 * s2) : 1;
      if (!d.reported) {
        d.reported = true;
        if (d.valueEl) d.valueEl.textContent = ' · ' + (d.percentile && d.value === 100 ? '00' : d.value);
        updateTotal();
      }
    } else {
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      q = qMul(qAxisAngle(d.spinAxis, d.spinTotal * (1 - e)), d.quat);
      scale = 1 + 0.14 * Math.sin(Math.PI * t);
    }

    const i = d.idx, o3 = i * 3, o4 = i * 4;
    const dpr = pixelDensity();        // gl_FragCoord is in device px
    uDie[o3] = d.cx * dpr;
    uDie[o3 + 1] = (height - d.cy) * dpr; // flip into gl_FragCoord space (y up)
    uDie[o3 + 2] = d.r * dpr;
    uAnim[o4] = 0;
    uAnim[o4 + 1] = scale;
    uAnim[o4 + 2] = 0;
    uAnim[o4 + 3] = 0;
    const cols = qToCols(q);
    for (let c = 0; c < 3; c++) {
      uRotA[o3 + c] = cols[0][c];
      uRotB[o3 + c] = cols[1][c];
      uRotC[o3 + c] = cols[2][c];
    }
  }

  shader(theShader);
  theShader.setUniform('resolution', [width * pixelDensity(), height * pixelDensity()]);
  theShader.setUniform('uDie', uDie);
  theShader.setUniform('uAnim', uAnim);
  theShader.setUniform('uRotA', uRotA);
  theShader.setUniform('uRotB', uRotB);
  theShader.setUniform('uRotC', uRotC);
  theShader.setUniform('uBody', theme.body);
  theShader.setUniform('uAccent', theme.accent);
  theShader.setUniform('uNumCol', theme.num);
  theShader.setUniform('uGloss', theme.gloss);
  theShader.setUniform('uSpec', theme.spec);
  theShader.setUniform('uTransluc', theme.transluc);
  theShader.setUniform('uAtlas', atlas);
  rect(-width / 2, -height / 2, width, height); // full-screen quad
}

function updateTotal() {
  const rolled = dice.filter((d) => d.value !== null);
  if (!rolled.length) { elTotal.textContent = ''; return; }
  const sum = rolled.reduce((s, d) => s + d.value, 0);
  elTotal.textContent = 'total ' + sum;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function attachInput(canvasEl) {
  const opts = { passive: false };
  const down = (e) => {
    e.preventDefault(); // also kills iOS double-tap zoom on rapid re-rolls
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    let best = null, bd = 1e9;
    for (const d of dice) {
      const dd = Math.hypot(t.clientX - d.cx, t.clientY - d.cy);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (best && bd < best.r * 1.35) rollDie(best.idx, 0);
  };
  canvasEl.addEventListener('pointerdown', down, opts);
  canvasEl.addEventListener('touchstart', down, opts);
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'r') { e.preventDefault(); rollAll(); }
  });
}

// ---------------------------------------------------------------------------
// UI: labels under each die, Roll all, and the looks panel
// ---------------------------------------------------------------------------
function wireUi() {
  elLabels = document.getElementById('labels');
  elTotal = document.getElementById('total');

  dice.forEach((d) => {
    const el = document.createElement('div');
    el.className = 'die-label';
    el.textContent = d.name;
    const val = document.createElement('span');
    el.appendChild(val);
    elLabels.appendChild(el);
    d.labelEl = el;
    d.valueEl = val;
  });
  positionLabels();

  document.getElementById('roll-all').addEventListener('click', rollAll);

  // looks panel
  const menuBtn = document.getElementById('menu-btn');
  const panel = document.getElementById('looks-panel');
  const btns = Array.from(panel.querySelectorAll('.theme-btn'));

  const saved = localStorage.getItem('ch4td1c3-theme');
  const savedIdx = THEMES.findIndex((t) => t.id === saved);
  applyTheme(savedIdx >= 0 ? savedIdx : 0);

  // volume slider: persisted, squared taper in audio.js, 0 = mute
  const vol = document.getElementById('volume');
  const savedVol = localStorage.getItem('ch4td1c3-volume');
  if (savedVol !== null) vol.value = savedVol;
  DiceAudio.setVolume(vol.value / 100);
  vol.addEventListener('input', () => {
    DiceAudio.setVolume(vol.value / 100);
    localStorage.setItem('ch4td1c3-volume', vol.value);
  });
  vol.addEventListener('change', () => DiceAudio.preview()); // hear the level on release

  menuBtn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== menuBtn) panel.hidden = true;
  });
  btns.forEach((b) => b.addEventListener('click', () => applyTheme(Number(b.dataset.theme))));

  function applyTheme(i) {
    theme = THEMES[i];
    localStorage.setItem('ch4td1c3-theme', theme.id);
    btns.forEach((b) => b.classList.toggle('active', Number(b.dataset.theme) === i));
  }
}
