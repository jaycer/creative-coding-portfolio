// Ambient Lumina
//
// A sonified fork of the Shader Particle System. "Lumina" are the glowing
// bodies themselves — one lumen, many lumina. The same hand-tuned particle
// simulation runs in JS — the lumina drift, bounce off the edges, breathe in
// and out on a cosine-eased size wave, lerp their color while growing, and
// live out a birth/decay lifespan in waves — but the population is capped at
// 10, because every lumen is also a *voice*:
//
//   pitch  ← the lumen's current hue, quantised to a minor-pentatonic scale
//   pan    ← the lumen's x position, tracked live across the stereo field
//   volume ← the lumen's breathing size (the tone swells and fades with it)
//
// Rendering happens in particles.frag.glsl, where overlapping lumina blend
// with an exclusion (soft-XOR) rule so their intersections contrast instead of
// brightening. Audio needs a user gesture: the first click/tap starts the
// drone; later clicks toggle mute.

const MAX_PARTICLES = AMB_CONFIG.maxParticles;  // single source of truth — see config.js

// --- tuning carried over from the original sketch ---
let particleAmount;
let particles = [];
let defaultMaxSize = 400;
const transitionRateMod = 5;        // cadence of particle emission / decay
const maxRunFrames = 3 * 60 * 60;   // a run (one wave of lumina) retires after at most 3 minutes @60fps
let runStartFrame = 0;              // when the current run began; reset each fresh wave
const minMaxPeriod = 1000;
const maxMaxPeriod = 3000;
let defaultMaxPeriod = 3000;
let isExiting = false;
const maxSpeed = 4; // faster than the original sketch's 1, so the stereo panning is audible
const greenHuePercentage = 0.075;

// --- per-particle shape ---
const maxElongation = 1.8;          // how oval a lumen can get (1 = circle); each gets a random value in [1, this]
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
const uRipple = new Float32Array(MAX_PARTICLES * 4);    // x = phase, y = lobe count, z = amplitude (w unused)

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
// One voice per lumen: triangle oscillator → per-voice gain (breathing
// size) → stereo panner (x position) → shared bus. The bus runs through a
// lowpass to soften the triangle's edge, a gentle feedback delay for air, and
// a compressor as a safety net against ten voices swelling at once.
let audioCtx = null;
let audioStarted = false;
let muted = false;
let busIn, masterGain;

const MASTER_LEVEL = 0.9;
const VOICE_LEVEL = 0.11;           // per-voice gain ceiling before the compressor (pre-bass-boost)
const PENTATONIC = [0, 3, 5, 7, 10]; // A-minor pentatonic, in semitones
const BASE_FREQ = 40;               // deep sub-bass root (~E1)
const OCTAVES = 4;                  // hue sweeps 0→360 across 20 notes over 4 octaves (40Hz → ~570Hz)

function buildAudioGraph() {
  busIn = audioCtx.createGain();
  busIn.gain.value = 1;

  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 2400;
  lowpass.Q.value = 0.5;

  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 24;
  compressor.ratio.value = 4;

  masterGain = audioCtx.createGain();
  masterGain.gain.value = MASTER_LEVEL;

  busIn.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  // Feedback delay: a quiet, darkening echo that gives the drone some room.
  const delaySend = audioCtx.createGain();
  delaySend.gain.value = 0.25;
  const delay = audioCtx.createDelay(1.0);
  delay.delayTime.value = 0.42;
  const feedback = audioCtx.createGain();
  feedback.gain.value = 0.35;

  busIn.connect(delaySend);
  delaySend.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(lowpass);
}

function makeVoice() {
  const osc = audioCtx.createOscillator();
  osc.type = 'triangle';
  osc.detune.value = random(-6, 6); // a few cents apart so unison notes shimmer instead of phase-locking

  const gain = audioCtx.createGain();
  gain.gain.value = 0;

  const pan = audioCtx.createStereoPanner();

  osc.connect(gain);
  gain.connect(pan);
  pan.connect(busIn);
  osc.start();

  return { osc, gain, pan };
}

// Hue (0..360) → note index into the pentatonic scale across OCTAVES.
function hueToNoteIndex(hue) {
  const noteCount = PENTATONIC.length * OCTAVES;
  return Math.min(noteCount - 1, Math.floor((hue / 360) * noteCount));
}

function noteIndexToFreq(idx) {
  const oct = Math.floor(idx / PENTATONIC.length);
  const semis = PENTATONIC[idx % PENTATONIC.length] + 12 * oct;
  return BASE_FREQ * Math.pow(2, semis / 12);
}

function hueToFreq(hue) {
  return noteIndexToFreq(hueToNoteIndex(hue));
}

// Equal-loudness compensation: the ear is far less sensitive down at 40Hz than
// in the midrange, so low voices get a logarithmic boost — a fixed number of
// dB for every octave below the scale's top note. At +4dB/oct the 40Hz root
// comes out ~15dB (~5.7x amplitude) hotter than the highest note.
const BASS_BOOST_DB_PER_OCT = 4;
const TOP_FREQ = noteIndexToFreq(PENTATONIC.length * OCTAVES - 1);
function bassBoost(freq) {
  const octavesBelowTop = Math.log2(TOP_FREQ / freq);
  return Math.pow(10, (BASS_BOOST_DB_PER_OCT * octavesBelowTop) / 20);
}

// r/g/b in [0,1] → hue in [0,360). Needed because the sim lerps in RGB.
function rgbToHue(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < 1e-6) return 0;
  let h;
  if (mx === r)      h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else               h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function updateVoice(p) {
  const t = audioCtx.currentTime;
  // Pitch follows the lumen's live (lerping) color; the long time constant
  // makes note changes glide rather than step.
  const freq = hueToFreq(rgbToHue(p.r, p.g, p.b));
  p.voice.osc.frequency.setTargetAtTime(freq, t, 0.25);
  // Pan tracks x across the stereo field.
  const panv = constrain((p.x / width) * 2 - 1, -1, 1);
  p.voice.pan.pan.setTargetAtTime(panv, t, 0.08);
  // Loudness breathes with the lumen (the exponent keeps small ones quiet),
  // with low notes boosted so the bass reads at ear level.
  const breath = Math.pow(constrain(p.size / defaultMaxSize, 0, 1), 1.4);
  p.voice.gain.gain.setTargetAtTime(breath * p.alpha * VOICE_LEVEL * bassBoost(freq), t, 0.15);
}

function disposeVoice(p) {
  const v = p.voice;
  p.voice = null;
  const t = audioCtx.currentTime;
  v.gain.gain.setTargetAtTime(0, t, 0.1);
  v.osc.stop(t + 0.8);
  v.osc.onended = () => {
    v.osc.disconnect();
    v.gain.disconnect();
    v.pan.disconnect();
  };
}

function updateAudio() {
  if (!audioStarted) return;
  for (const p of particles) {
    if (p.hasExited) {
      if (p.voice) disposeVoice(p);
    } else {
      if (!p.voice) p.voice = makeVoice();
      updateVoice(p);
    }
  }
}

function setHint(text) {
  const el = document.getElementById('sound-hint');
  if (el) el.textContent = text;
}

window.addEventListener('pointerdown', (e) => {
  if (e.target.closest('a')) return; // let the back link be just a link
  if (!audioStarted) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    buildAudioGraph();
    audioCtx.resume();
    audioStarted = true;
    const overlay = document.getElementById('sound-overlay');
    if (overlay) {
      overlay.classList.add('gone');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    }
    setHint('♪ sounding · click to mute');
  } else {
    muted = !muted;
    masterGain.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, audioCtx.currentTime, 0.2);
    setHint(muted ? '🔇 muted · click to unmute' : '♪ sounding · click to mute');
  }
});

// Silence the drone when the tab is hidden; pick it back up on return.
document.addEventListener('visibilitychange', () => {
  if (!audioStarted) return;
  if (document.hidden) audioCtx.suspend();
  else audioCtx.resume();
});

// ---------------------------------------------------------------------------
// Sketch
// ---------------------------------------------------------------------------
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
  // With only ~10 lumina the field would feel empty at the original size, so
  // each one is a little larger than in shader-particle-system.
  defaultMaxSize = wscale * 0.62;
  particleAmount = Math.min(MAX_PARTICLES, Math.max(3, Math.round((width * height) / 150000)));
  defaultMaxPeriod = random(minMaxPeriod, maxMaxPeriod);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  factorSetup();
}

function draw() {
  stepSimulation();
  updateAudio();

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

    // Ripple = the lumen's tone made visible, as pond rings radiating from its
    // centre. The true audio frequency (40-570Hz) is far above what 60fps can
    // show, so the ring speed is scaled down 100:1 (~0.4-6Hz), proportionally
    // faster for higher notes. Ring spacing tightens with pitch (higher note =
    // finer rings) and depth follows the voice's loudness, so the water goes
    // still as the lumen fades out.
    const noteIdx = hueToNoteIndex(rgbToHue(p.r, p.g, p.b));
    p.ripplePhase += TWO_PI * (noteIndexToFreq(noteIdx) / 100) * (deltaTime / 1000);
    const breath = Math.pow(constrain(p.size / defaultMaxSize, 0, 1), 1.4);
    uRipple[o4]     = p.ripplePhase % TWO_PI;     // shader sees phase mod 2π; rings still travel smoothly
    uRipple[o4 + 1] = TWO_PI * (2 + 0.3 * noteIdx); // 2..8 concentric rings across the influence radius
    uRipple[o4 + 2] = 0.05 + 0.25 * breath * p.alpha;
    uRipple[o4 + 3] = 0;

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
  theShader.setUniform('uRipple', uRipple);
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

  // Once the run reaches its maximum age, begin retiring the whole population.
  if (!isExiting && frameCount - runStartFrame >= maxRunFrames) {
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
    for (const p of particles) {
      if (p.voice) disposeVoice(p); // don't strand oscillators when the wave resets
    }
    particles = [];
    defaultMaxPeriod = random(minMaxPeriod, maxMaxPeriod);
    isExiting = false;
    runStartFrame = frameCount;
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
    ripplePhase: random(TWO_PI),            // tone-driven pond ripple, advanced each frame in draw()
    isExiting: false,
    hasExited: false,
    voice: null,                            // Web Audio voice, attached once sound starts
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
  // Near-black tinted base — much darker than the original sketch's mid-tone,
  // so the exclusion-blended lumina pop against it.
  return hsbToRgb(getHue(), random(18, 32) / 100, random(8, 16) / 100);
}

function getParticleColor() {
  // vivid, semi-transparent glow; returns [r, g, b, alpha]. Higher saturation/
  // brightness floors than the original so every lumen stays punchy against the
  // near-black background (hue range untouched — pitch mapping is unaffected).
  const rgb = hsbToRgb(getHue(), random(55, 100) / 100, random(65, 100) / 100);
  rgb.push(random(0.5, 1.0));
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
