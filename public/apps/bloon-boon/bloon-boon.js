// Bloon Boon — keep the balloons aloft.
//
// A tap/flick game. Balloons drift *down* (they're not helium — light, but
// heavier than air, so they sink slowly through a lot of drag while swaying).
// Tap or swipe to bat one upward; lose the instant any balloon slips off the
// bottom of the screen. New balloons arrive at random 10–30s intervals, each a
// different color with its own synthesized voice (see audio.js) that sounds
// when it enters the room.
//
// Physics runs here in JS; every frame the live balloons are packed into
// uniform arrays and drawn as fake-3D lit spheres by balloons.frag.glsl.

const MAX = BLOON_CONFIG.maxBalloons;          // single source of truth (config.js)
const PALETTE = BLOON_CONFIG.palette;

// --- physics tuning (pixels, seconds) ---
const GRAVITY   = 120;   // downward accel; small — these barely sink
const DRAG      = 1.5;   // linear air drag → terminal fall ≈ GRAVITY/DRAG ≈ 80 px/s
const SWAY_ACC  = 26;    // horizontal sway force amplitude
const SWAY_FREQ = 0.6;   // sway oscillation rate (Hz-ish)
const BAT_UP    = 430;   // upward speed imparted by a hit
const SIDE_PUSH = 260;   // sideways kick when you catch a balloon off-centre
const WALL_BOUNCE = 0.7; // horizontal restitution at the side walls
const HIT_COOLDOWN = 0.12; // s before the same balloon can be hit again (one swipe = one hit)

// --- rotation (radians) ---
const LEAN_PER_VX = 0.0016; // how far a balloon tilts, per px/s of horizontal drift
const LEAN_MAX    = 0.5;    // clamp on the drift lean
const LEAN_K      = 8;      // spring stiffness back toward the lean target
const LEAN_C      = 3;      // spring damping (underdamped → a gentle wobble)
const HIT_SPIN    = 5.5;    // spin kick from catching a balloon off-centre
const ANGVEL_MAX  = 11;     // clamp on angular velocity

// --- collisions ---
// How close two balloons' centres may get, as a fraction of their combined
// radii, so they overlap rather than meeting edge-to-edge like flat discs.
// Depth-aware: balloons near the same depth bump close to touching, while ones
// at different depths overlap more — the nearer one (drawn on top) passes over
// the farther one, which reads as 3D.
const COLLIDE_TOUCH     = 0.86; // same-depth spacing (1 = edges just touch)
const COLLIDE_DEPTH_K   = 0.9;  // extra overlap allowed per unit of depth (z) difference
const COLLIDE_MIN       = 0.5;  // hard floor so they never pass fully through

// --- collision sound ---
const COLLIDE_MIN_SPEED = 34;  // px/s of closing speed below which a bump is silent
const COLLIDE_COOLDOWN  = 0.2; // s between collision blips per balloon

// --- shared uniform buffers (padded to MAX so p5 sees a constant length) ---
const uBalloons = new Float32Array(MAX * 4); // xy centre (uv), z radius (h-norm), w squash
const uRot      = new Float32Array(MAX * 2); // (cos, sin) of each balloon's rotation
const uColors   = new Float32Array(MAX * 3);

let theShader, vertSrc, fragSrc;
let balloons = [];
let baseRadiusPx = 60;

// --- game state ---
// Score is the most balloons you kept aloft at once. Balloons only leave a
// round by falling off the bottom (which ends it), so the live count only
// climbs — the peak is simply how many were up when you lost.
let state = 'ready';         // 'ready' | 'playing' | 'over'
let startMs = 0;             // millis() when the round began (for spawn timing)
let peakAloft = 0;           // most balloons up at once this round
let finalAloft = 0;          // peak frozen at game over
let bestAloft = Number(localStorage.getItem('bloon-boon-best-count') || 0);
let spawnQueue = [];         // scheduled spawn times (ms, relative to round start)
let nextRandomSpawnMs = 0;   // when the next random spawn fires

// --- input / flick tracking ---
let pointerDown = false;
let lastPX = 0, lastPY = 0, lastPT = 0;
let pVX = 0, pVY = 0;        // smoothed pointer velocity (px/s)

// DOM refs (populated on load)
let elStart, elOver, elScore, elBest, elFinal, elOverBest, elStartBtn, elRestartBtn;
let elRipples, elTapToggles;
let tapViz = false;               // show taps as expanding green rings

function preload() {
  // Load shaders as text so we can inject MAX before compiling.
  vertSrc = loadStrings('./balloons.vert.glsl');
  fragSrc = loadStrings('./balloons.frag.glsl');
}

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight, WEBGL);
  cnv.position(0, 0, 'fixed');
  pixelDensity(1);                 // keep drawbuffer == css px so gl_FragCoord lines up
  noStroke();

  const frag = fragSrc.join('\n').replace(/__MAX_BALLOONS__/g, String(MAX));
  theShader = createShader(vertSrc.join('\n'), frag);

  computeSizes();
  cacheDom();
  attachInput(cnv.elt);
  showReady();
}

function computeSizes() {
  baseRadiusPx = Math.min(width, height) * 0.075;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  computeSizes();
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------
function startRound() {
  BloonAudio.init();               // (re)confirm audio inside the gesture
  balloons = [];
  state = 'playing';
  startMs = millis();
  peakAloft = 0;
  colorBag = []; lastColorIdx = -1;   // fresh shuffle each round
  // Scripted opening so the room isn't empty, then hand off to random cadence.
  spawnQueue = BLOON_CONFIG.firstSpawnsSeconds.map((s) => s * 1000);
  const last = spawnQueue[spawnQueue.length - 1] || 0;
  nextRandomSpawnMs = last + randomSpawnGap(last);
  hideOverlays();
}

function endRound() {
  state = 'over';
  finalAloft = peakAloft;
  if (finalAloft > bestAloft) {
    bestAloft = finalAloft;
    localStorage.setItem('bloon-boon-best-count', String(bestAloft));
  }
  showOver();
}

// Time until the next random spawn, shrinking as the round goes on so balloons
// arrive faster the longer you last. `roundMs` is elapsed time in the round.
function randomSpawnGap(roundMs) {
  const base = random(BLOON_CONFIG.spawnMinSeconds, BLOON_CONFIG.spawnMaxSeconds) * 1000;
  const t = constrain(roundMs / (BLOON_CONFIG.spawnRampSeconds * 1000), 0, 1);
  const factor = lerp(1, BLOON_CONFIG.spawnRampFloor, t);
  return base * factor;
}

// ---------------------------------------------------------------------------
// Balloons
// ---------------------------------------------------------------------------
// Color picker: a shuffled "bag" holding TWO of every color. Each colour shows
// up twice per bag, so pairs and small clusters happen (a little repeatability)
// while droughts and long streaks don't — pure random clumps into 5-of-a-kind
// runs that read as broken even though they aren't. A boundary guard caps any
// run at two: the two copies can sit adjacent within a bag, but a new bag never
// opens with the colour the last one closed on.
const BAG_SETS = 2;
let colorBag = [];
let lastColorIdx = -1;
function nextColorIdx() {
  if (colorBag.length === 0) {
    colorBag = [];
    for (let s = 0; s < BAG_SETS; s++) PALETTE.forEach((_, i) => colorBag.push(i));
    for (let i = colorBag.length - 1; i > 0; i--) { // Fisher–Yates shuffle
      const j = floor(random(i + 1));
      [colorBag[i], colorBag[j]] = [colorBag[j], colorBag[i]];
    }
    // Don't let the new bag open with the color the last one closed on (which
    // would make a run of three); swap in the first colour that differs.
    const last = colorBag.length - 1;
    if (colorBag[last] === lastColorIdx) {
      const j = colorBag.findIndex((c) => c !== lastColorIdx);
      [colorBag[last], colorBag[j]] = [colorBag[j], colorBag[last]];
    }
  }
  lastColorIdx = colorBag.pop();
  return lastColorIdx;
}

function spawnBalloon() {
  if (balloons.length >= MAX) return;
  const idx = nextColorIdx();
  const p = PALETTE[idx];
  const z = random(0.72, 1.2);     // size + depth: smaller balloons sit behind, bigger in front
  const b = {
    x: random(width * 0.15, width * 0.85),
    y: -baseRadiusPx,              // drop in from just above the top edge
    vx: random(-40, 40),
    vy: random(20, 50),
    z,
    radius: baseRadiusPx * z,
    mass: z * z,                   // area-like: a big balloon is heavier to bat & shove
    colorIdx: idx,
    rgb: p.rgb,
    voice: p.name,
    squash: 1,
    squashVel: 0,
    swayPhase: random(TWO_PI),
    angle: random(-0.15, 0.15),        // small initial tilt
    angVel: random(-0.5, 0.5),         // and a lazy starting spin
    lastHit: -1,
    lastCollideSound: -1,
  };
  balloons.push(b);                // silent entry — it only sounds when batted
}

function updateBalloons(dt, tSec) {
  for (const b of balloons) {
    // Non-helium float: gentle gravity, heavy drag, lazy horizontal sway.
    b.vy += GRAVITY * dt;
    b.vx += Math.sin(tSec * SWAY_FREQ * TWO_PI + b.swayPhase) * SWAY_ACC * dt;
    // Bigger balloons catch more air: more drag → they drift down slower and
    // sway more calmly, while the little ones fall faster and dart around.
    const damp = Math.exp(-DRAG * b.z * dt);
    b.vx *= damp;
    b.vy *= damp;

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Bounce off the side walls only. The top is open — a balloon can be batted
    // clean off the top of the screen and drift back down under gravity, and
    // may bump a just-spawned balloon up in the off-screen area. The floor is
    // the loss line (handled below).
    if (b.x < b.radius)          { b.x = b.radius;          b.vx = Math.abs(b.vx) * WALL_BOUNCE; }
    if (b.x > width - b.radius)  { b.x = width - b.radius;  b.vx = -Math.abs(b.vx) * WALL_BOUNCE; }

    // Jelly squash spring back toward 1.
    const k = 210, dmp = 9;
    const sa = -k * (b.squash - 1) - dmp * b.squashVel;
    b.squashVel += sa * dt;
    b.squash = constrain(b.squash + b.squashVel * dt, 0.55, 1.6);

    // Rotation: a damped spring toward a lean that follows horizontal drift, so
    // a balloon tilts as it sways/falls and settles upright when still. A hit
    // adds angVel (see tryHit), which wobbles out through the same spring.
    const targetLean = constrain(-b.vx * LEAN_PER_VX, -LEAN_MAX, LEAN_MAX);
    const angAcc = LEAN_K * (targetLean - b.angle) - LEAN_C * b.angVel;
    b.angVel = constrain(b.angVel + angAcc * dt, -ANGVEL_MAX, ANGVEL_MAX);
    b.angle += b.angVel * dt;
  }

  resolveCollisions();

  // Lose when any balloon has fully cleared the bottom edge.
  for (const b of balloons) {
    if (b.y - b.radius > height) { endRound(); return; }
  }
}

// Soft elastic separation. Balloons are allowed to overlap — more so when they
// sit at different depths — so they read as 3D rather than colliding like flat
// discs; the z-sorted painter's pass draws the nearer one over the farther.
function resolveCollisions() {
  for (let i = 0; i < balloons.length; i++) {
    for (let j = i + 1; j < balloons.length; j++) {
      const a = balloons[i], b = balloons[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      const factor = Math.max(COLLIDE_TOUCH - Math.abs(a.z - b.z) * COLLIDE_DEPTH_K, COLLIDE_MIN);
      const min = (a.radius + b.radius) * factor;
      if (dist === 0) { dx = 1; dy = 0; dist = 1; }
      if (dist < min) {
        const nx = dx / dist, ny = dy / dist;
        // Push apart, weighted by mass so the lighter one yields more.
        const overlap = min - dist;
        const wa = b.mass / (a.mass + b.mass); // share of separation a takes
        a.x -= nx * overlap * wa; a.y -= ny * overlap * wa;
        b.x += nx * overlap * (1 - wa); b.y += ny * overlap * (1 - wa);
        // Mass-weighted impulse along the normal (with a little restitution), so
        // a big balloon shoves a small one harder than the reverse.
        const va = a.vx * nx + a.vy * ny;
        const vb = b.vx * nx + b.vy * ny;
        const closing = va - vb;            // >0 means they're driving together
        if (closing > 0) {
          const e = 0.6;                    // restitution
          const j = (1 + e) * closing / (1 / a.mass + 1 / b.mass);
          a.vx -= (j / a.mass) * nx; a.vy -= (j / a.mass) * ny;
          b.vx += (j / b.mass) * nx; b.vy += (j / b.mass) * ny;
        }

        // Softly blend the two voices on a real bump — louder the harder they
        // meet — with a short per-balloon cooldown so a resting pair stays quiet.
        if (closing > COLLIDE_MIN_SPEED) {
          const now = millis() / 1000;
          const vol = constrain(map(closing, COLLIDE_MIN_SPEED, 520, 0.12, 0.4), 0.12, 0.42);
          if (now - a.lastCollideSound > COLLIDE_COOLDOWN) { BloonAudio.play(a.voice, vol); a.lastCollideSound = now; }
          if (now - b.lastCollideSound > COLLIDE_COOLDOWN) { BloonAudio.play(b.voice, vol); b.lastCollideSound = now; }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Input — tap and flick both route through tryHit()
// ---------------------------------------------------------------------------
function attachInput(canvasEl) {
  const opts = { passive: false };
  const xy = (e) => {
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    return [t.clientX, t.clientY];
  };

  const down = (e) => {
    e.preventDefault();
    // Starting/restarting is handled only by the overlay buttons — so frantic
    // tapping mid-round can't skip past the game-over screen.
    if (state !== 'playing') return;
    const [x, y] = xy(e);
    pointerDown = true;
    lastPX = x; lastPY = y; lastPT = millis();
    pVX = 0; pVY = 0;
    tryHit(x, y, 0, 0);            // a plain tap still bats upward
  };
  const move = (e) => {
    if (!pointerDown) return;
    e.preventDefault();
    const [x, y] = xy(e);
    const now = millis();
    const dt = Math.max(now - lastPT, 8) / 1000;
    // smoothed pointer velocity for flicks
    pVX = 0.6 * pVX + 0.4 * ((x - lastPX) / dt);
    pVY = 0.6 * pVY + 0.4 * ((y - lastPY) / dt);
    lastPX = x; lastPY = y; lastPT = now;
    if (Math.hypot(pVX, pVY) > 200) tryHit(x, y, pVX, pVY); // swipe-through
  };
  const up = (e) => { pointerDown = false; };

  // Pointer events cover mouse + touch; keep touch* as a fallback and to kill
  // scrolling/zoom on mobile.
  canvasEl.addEventListener('pointerdown', down, opts);
  window.addEventListener('pointermove', move, opts);
  window.addEventListener('pointerup', up, opts);
  canvasEl.addEventListener('touchstart', down, opts);
  window.addEventListener('touchmove', move, opts);
  window.addEventListener('touchend', up, opts);
}

// Find the front-most balloon under (x,y) and bat it. flick velocity in px/s.
function tryHit(x, y, vx, vy) {
  const tSec = millis() / 1000;
  let hit = null;
  // iterate so that nearer (larger z) balloons win ties
  for (const b of balloons) {
    const grab = b.radius * 1.2;   // forgiving hit area
    if (Math.hypot(x - b.x, y - b.y) < grab && tSec - b.lastHit > HIT_COOLDOWN) {
      if (!hit || b.z > hit.z) hit = b;
    }
  }
  if (!hit) return;

  hit.lastHit = tSec;
  // Always send it upward (forgiving), add flick and a sideways kick from where
  // you caught it. The bigger (heavier) the balloon, the less a hit moves it —
  // small ones pop up eagerly, big ones need a real whack.
  const m = hit.z;                                  // size as the mass proxy for the bat
  hit.vy = (-BAT_UP - Math.max(0, -vy) * 0.35) / m; // upward flicks add extra lift
  const off = (hit.x - x) / hit.radius;             // where you caught it, -1..1
  hit.vx += (constrain(vx * 0.35, -650, 650) + off * SIDE_PUSH) / m; // flick + side kick
  // squash: struck from below, it squats then springs
  hit.squashVel = -7;
  // ...and it spins: off-centre hits and flicks impart angular velocity.
  hit.angVel = constrain(hit.angVel + (off * HIT_SPIN + constrain(vx, -800, 800) * 0.003) / m,
                         -ANGVEL_MAX, ANGVEL_MAX);
  BloonAudio.play(hit.voice);      // the balloon sounds only when you bat it
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
let lastFrameMs = 0;
function draw() {
  const now = millis();
  let dt = (now - lastFrameMs) / 1000;
  lastFrameMs = now;
  if (!isFinite(dt) || dt > 0.1) dt = 0.016; // clamp huge gaps (tab switch)

  if (state === 'playing') {
    const roundMs = now - startMs;
    // Fire scripted opening spawns, then random cadence.
    while (spawnQueue.length && roundMs >= spawnQueue[0]) {
      spawnQueue.shift();
      spawnBalloon();
    }
    if (roundMs >= nextRandomSpawnMs) {
      spawnBalloon();
      nextRandomSpawnMs = roundMs + randomSpawnGap(roundMs);
    }
    // Record the peak before stepping physics, so a balloon lost this frame is
    // still counted in the final score.
    if (balloons.length > peakAloft) peakAloft = balloons.length;
    updateBalloons(dt, now / 1000);
    updateHud();
  }

  renderScene();
}

function renderScene() {
  // Pack live balloons far-to-near so the shader's over-operator occludes right.
  const order = balloons
    .map((b, i) => i)
    .sort((a, c) => balloons[a].z - balloons[c].z);

  for (let n = 0; n < order.length; n++) {
    const b = balloons[order[n]];
    const o4 = n * 4, o3 = n * 3, o2 = n * 2;
    uBalloons[o4]     = b.x / width;          // uv x
    uBalloons[o4 + 1] = 1 - b.y / height;     // uv y (flip to bottom-up)
    uBalloons[o4 + 2] = b.radius / height;    // radius, height-normalised
    uBalloons[o4 + 3] = b.squash;
    uRot[o2]     = Math.cos(b.angle);         // precompute rotation once here
    uRot[o2 + 1] = Math.sin(b.angle);
    uColors[o3]     = b.rgb[0];
    uColors[o3 + 1] = b.rgb[1];
    uColors[o3 + 2] = b.rgb[2];
  }

  shader(theShader);
  theShader.setUniform('resolution', [width, height]);
  theShader.setUniform('uCount', balloons.length);
  theShader.setUniform('uBalloons', uBalloons);
  theShader.setUniform('uRot', uRot);
  theShader.setUniform('uColors', uColors);
  rect(-width / 2, -height / 2, width, height); // full-screen quad
}

// ---------------------------------------------------------------------------
// HUD / overlays (plain DOM — see index.html)
// ---------------------------------------------------------------------------
function cacheDom() {
  elStart      = document.getElementById('start');
  elOver       = document.getElementById('over');
  elScore      = document.getElementById('score');
  elBest       = document.getElementById('best');
  elFinal      = document.getElementById('final-count');
  elOverBest   = document.getElementById('over-best');
  elStartBtn   = document.getElementById('start-btn');
  elRestartBtn = document.getElementById('restart-btn');
  // The buttons are the only way to (re)start a round.
  elStartBtn.addEventListener('click', startRound);
  elRestartBtn.addEventListener('click', startRound);

  // Tap visualizer: "Show Taps" toggles in the overlay panels (persisted) draw
  // an expanding green ring at every tap/click. There's one in each panel, kept
  // in sync.
  elRipples   = document.getElementById('ripples');
  elTapToggles = document.querySelectorAll('.tap-toggle');
  tapViz = localStorage.getItem('bloon-boon-tapviz') === '1';
  syncTapToggles();
  elTapToggles.forEach((btn) => btn.addEventListener('click', () => {
    tapViz = !tapViz;
    localStorage.setItem('bloon-boon-tapviz', tapViz ? '1' : '0');
    syncTapToggles();
  }));
  window.addEventListener('pointerdown', (e) => {
    if (tapViz) spawnRipple(e.clientX, e.clientY);
  }, true);
}

// Reflect the current tapViz state on every "Show Taps" toggle.
function syncTapToggles() {
  elTapToggles.forEach((btn) => {
    btn.classList.toggle('on', tapViz);
    btn.setAttribute('aria-pressed', tapViz ? 'true' : 'false');
  });
}

// Drop an expanding green ring at (x, y) that removes itself when it finishes.
function spawnRipple(x, y) {
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.left = x + 'px';
  r.style.top = y + 'px';
  elRipples.appendChild(r);
  const done = () => r.remove();
  r.addEventListener('animationend', done);
  setTimeout(done, 800); // fallback in case animationend doesn't fire
}

function updateHud() {
  elScore.textContent = balloons.length;
  elBest.textContent = bestAloft ? 'Best: ' + bestAloft : '';
}

function showReady() {
  state = 'ready';
  elBest.textContent = bestAloft ? 'Best: ' + bestAloft : '';
  elScore.textContent = '0';
  elStart.classList.remove('hidden');
  elOver.classList.add('hidden');
  elStartBtn.disabled = false;   // the only live button on the ready screen
  elRestartBtn.disabled = true;
}
function showOver() {
  elFinal.textContent = finalAloft;
  elOverBest.textContent = 'Best: ' + bestAloft;
  elOver.classList.remove('hidden');
  // Ignore taps for a moment so a mid-round tapping frenzy can't instantly
  // dismiss the game-over screen — the restart button wakes up after 1.5s.
  elRestartBtn.disabled = true;
  setTimeout(() => { elRestartBtn.disabled = false; }, 1500);
}
function hideOverlays() {
  elStart.classList.add('hidden');
  elOver.classList.add('hidden');
  // Neutralise both buttons the instant we start playing, so the invisible
  // (fading-out) overlay can't catch a tap and restart the round.
  elStartBtn.disabled = true;
  elRestartBtn.disabled = true;
}
