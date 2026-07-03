// Shader Particle System
//
// A GPU adaptation of the original p5 "Particle System" sketch. The particle
// *simulation* is the same hand-tuned logic ported verbatim — particles drift,
// bounce off the edges, breathe in and out on a cosine-eased size wave, lerp
// their color while growing, and live out a birth/decay lifespan in waves;
// the background slowly drifts toward a fresh target color. The difference is
// rendering: instead of drawing each particle with p5's ellipse(), every
// particle's state is uploaded to a fragment shader (particles.frag.glsl) that
// draws the whole field on the GPU as additive soft blobs.

const MAX_PARTICLES = SPS_CONFIG.maxParticles;  // single source of truth — see config.js

// --- tuning carried over from the original sketch ---
let particleAmount;
let particles = [];
let defaultMaxSize = 400;
const transitionRateMod = 5;        // cadence of particle emission / decay
const exitMod = 2400;               // frame at which a population starts retiring
const minMaxPeriod = 1000;
const maxMaxPeriod = 3000;
let defaultMaxPeriod = 3000;
let isExiting = false;
const maxSpeed = 1;
const greenHuePercentage = 0.075;

// --- per-particle shape ---
const maxElongation = 1.8;          // how oval a metaball can get (1 = circle); each gets a random value in [1, this]
const maxRotSpeed = 0.006;          // radians/frame for the slow spin (±); ~one turn every 15-20s

// --- background color drift ---
const backgroundLerpAmount = 0.004;
const backgroundLerpMod = 25;       // lerp the background once every N frames
const newTargetBgFrames = 60 * 60;  // pick a new target roughly once a minute (@60fps)
let bgColor = [0, 0, 0];
let targetBgColor = [0, 0, 0];

// --- rendering ---
let theShader;
let vertSrc;                        // raw shader sources, loaded as text in preload()
let fragSrc;
// Pre-sized uniform buffers (padded to MAX so p5 always sees the same length).
const uParticles = new Float32Array(MAX_PARTICLES * 4); // xy = pos, z = radius, w = elongation
const uColors = new Float32Array(MAX_PARTICLES * 4);
const uRot = new Float32Array(MAX_PARTICLES * 2);       // (cos, sin) of each particle's rotation, precomputed in JS

function preload() {
  // Load the shaders as text (rather than loadShader) so we can substitute the
  // single-sourced particle cap into the fragment shader before compiling it.
  vertSrc = loadStrings('./particles.vert.glsl');
  fragSrc = loadStrings('./particles.frag.glsl');
}

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight, WEBGL);
  cnv.position(0, 0, 'fixed');
  pixelDensity(1);                  // keep drawingbuffer == css pixels so gl_FragCoord lines up
  noStroke();

  // Inject MAX_PARTICLES (from config.js) into the shader's array size, then
  // compile — so the cap lives in exactly one place.
  const frag = fragSrc.join('\n').replace(/__MAX_PARTICLES__/g, String(MAX_PARTICLES));
  theShader = createShader(vertSrc.join('\n'), frag);

  bgColor = getBackgroundColor();
  targetBgColor = getBackgroundColor();
  factorSetup();
}

// (Re)derive screen-dependent parameters; called on setup and on resize.
function factorSetup() {
  const wscale = Math.min(width, height);
  defaultMaxSize = wscale * 0.5;
  particleAmount = Math.min(floor(width * height * 0.00009), MAX_PARTICLES);
  defaultMaxPeriod = random(minMaxPeriod, maxMaxPeriod);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  factorSetup();
}

function draw() {
  stepSimulation();

  // Pack the live particles into the uniform buffers (height-normalised).
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const o4 = i * 4;
    uParticles[o4]     = p.x / width;            // 0..1, matches gl_FragCoord.x / resolution.x
    uParticles[o4 + 1] = 1 - p.y / height;       // flip: canvas y is top-down, gl_FragCoord is bottom-up
    uParticles[o4 + 2] = (p.size * 0.5) / height; // radius, normalised by height
    uParticles[o4 + 3] = p.elong;                // oval-ness (1 = circle)

    uRot[i * 2]     = Math.cos(p.angle);          // precompute rotation once per particle here
    uRot[i * 2 + 1] = Math.sin(p.angle);          // instead of cos/sin per-pixel in the shader

    uColors[o4]     = p.r;
    uColors[o4 + 1] = p.g;
    uColors[o4 + 2] = p.b;
    uColors[o4 + 3] = p.alpha;                   // glow intensity
  }

  shader(theShader);
  theShader.setUniform('resolution', [width, height]);
  theShader.setUniform('uCount', particles.length);
  theShader.setUniform('uParticles', uParticles);
  theShader.setUniform('uRot', uRot);
  theShader.setUniform('uColors', uColors);
  theShader.setUniform('uBg', bgColor);

  // Full-screen quad for the fragment shader to paint.
  rect(-width / 2, -height / 2, width, height);
}

// ---------------------------------------------------------------------------
// Simulation (ported from the original; no p5 drawing happens here)
// ---------------------------------------------------------------------------
function stepSimulation() {
  // Drift the background toward its target, and occasionally pick a new target.
  if (frameCount % newTargetBgFrames === 0) {
    targetBgColor = getBackgroundColor();
  }
  if (frameCount % backgroundLerpMod === 0) {
    bgColor = lerpRGB(bgColor, targetBgColor, backgroundLerpAmount);
  }

  // Emit particles up to the target population.
  if (frameCount % transitionRateMod === 0 && particles.length < particleAmount) {
    particles.push(makeParticle());
  }

  // Periodically begin retiring the whole population.
  if (frameCount > exitMod - 1 && frameCount % exitMod === 0) {
    isExiting = true;
  }

  let hasExitedOne = false;
  for (const p of particles) {
    resizeParticle(p);
    moveParticle(p);

    if (isExiting && frameCount % transitionRateMod === 0 && !hasExitedOne && !p.isExiting) {
      p.isExiting = true;
      hasExitedOne = true;
    }
  }

  // Once everyone has decayed away, start a fresh wave.
  if (particles.length > 0 && particles.every((x) => x.hasExited)) {
    particles = [];
    defaultMaxPeriod = random(minMaxPeriod, maxMaxPeriod);
    isExiting = false;
  }
}

function makeParticle() {
  const color = getParticleColor();
  const target = getParticleColor();
  return {
    x: random(width),
    y: random(height),
    vx: random(-maxSpeed, maxSpeed),
    vy: random(-maxSpeed, maxSpeed),
    size: 0,
    minSize: 0,
    maxSize: random(0, defaultMaxSize),
    r: color[0], g: color[1], b: color[2],
    alpha: color[3],
    tr: target[0], tg: target[1], tb: target[2],
    isGrowing: true,
    lerpPercent: random(0.01, 0.05),
    period: random(500, defaultMaxPeriod),
    frameCountOffset: frameCount,
    amp: -1,
    elong: random(1.0, maxElongation),     // fixed oval-ness for this particle
    angle: random(TWO_PI),                  // random starting orientation
    rotSpeed: random(-maxRotSpeed, maxRotSpeed), // slow, signed spin
    isExiting: false,
    hasExited: false,
  };
}

function resizeParticle(p) {
  if (p.isExiting && p.size < 1) {
    p.hasExited = true;
    return;
  }

  // Cosine wave gives eased expansion/contraction.
  p.amp = cos((PI * (frameCount - p.frameCountOffset)) / p.period);

  if (p.amp < -0.9999 && p.isGrowing) {
    p.isGrowing = false;
    p.lerpPercent = -p.lerpPercent;
  }
  if (p.amp > 0.9999 && !p.isGrowing) {
    p.isGrowing = true;
    const target = getParticleColor();
    p.tr = target[0]; p.tg = target[1]; p.tb = target[2];
    p.maxSize = random(0, defaultMaxSize);
    p.lerpPercent = Math.abs(p.lerpPercent);
  }

  if (p.isGrowing) {
    p.r = lerp(p.r, p.tr, p.lerpPercent);
    p.g = lerp(p.g, p.tg, p.lerpPercent);
    p.b = lerp(p.b, p.tb, p.lerpPercent);
  }

  p.size = map(p.amp, -1, 1, p.maxSize, p.minSize);
}

function moveParticle(p) {
  if (p.x > width || p.x < 0) p.vx *= -1;
  if (p.y > height || p.y < 0) p.vy *= -1;
  p.x += p.vx;
  p.y += p.vy;
  p.angle += p.rotSpeed; // slowly rotate the oval
}

// ---------------------------------------------------------------------------
// Color helpers — same hue distribution / ranges as the original, but the
// HSB→RGB conversion is done in JS so we can hand normalised RGB to the shader.
// ---------------------------------------------------------------------------
function getBackgroundColor() {
  // muted, opaque base tone
  return hsbToRgb(getHue(), random(30, 44) / 100, random(40, 54) / 100);
}

function getParticleColor() {
  // vivid, semi-transparent glow; returns [r, g, b, alpha]
  const rgb = hsbToRgb(getHue(), random(25, 100) / 100, random(50, 100) / 100);
  rgb.push(random(0.35, 1.0));
  return rgb;
}

function getHue() {
  const x = random(1);
  if (x < greenHuePercentage) {
    return floor(random(70, 180));   // occasional green
  } else if (x > 0.5) {
    return floor(random(0, 70));     // red → yellow
  }
  return floor(random(180, 360));    // blue → red
}

// h in [0,360], s/v in [0,1] → [r,g,b] in [0,1]
function hsbToRgb(h, s, v) {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1)      { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else             { r = c; b = x; }
  const m = v - c;
  return [r + m, g + m, b + m];
}

function lerpRGB(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
