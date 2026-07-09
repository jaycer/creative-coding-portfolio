// Sleep Noise — a three-channel noise machine for sleep.
//
// Dark, white, and pink noise, each generated into a looping buffer once and
// mixed live. Every channel has two sliders: LEVEL (how loud) and TONE (a
// low-pass cutoff — drag it down to soften the hiss, up to open it back up).
// One master volume rides on top.
//
//   dark  — Brownian (a.k.a. red/brown) noise: energy piles up in the low end,
//           so it reads as a deep, dark rumble. Named "dark" here for its color.
//   white — flat spectrum, equal energy per hertz: the bright, even hiss.
//   pink  — 1/f noise (Paul Kellet's filter): equal energy per octave, the
//           balanced middle most people find easiest to sleep to.

// --- iOS-reliable AudioContext -------------------------------------------------
// Inlined so the app is self-contained. Same three moves as the shared
// ios-web-audio module: playback session, retried resume(), auto re-resume on
// interruption. Start must happen from a completed gesture (pointerup/click).
function makeUnlockableAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  async function resume() {
    for (let i = 0; i < 6 && ctx.state !== 'running'; i++) {
      try { await ctx.resume(); } catch { /* keep trying */ }
      if (ctx.state !== 'running') await new Promise((r) => setTimeout(r, 60));
    }
    return ctx.state === 'running';
  }
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {});
  });
  async function unlock() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older iOS */ }
    return resume();
  }
  return { ctx, unlock };
}

// --- noise buffer generators ---------------------------------------------------
const NOISE_SECONDS = 6; // long enough that the loop point is inaudible

function fillWhite(data) {
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
}

// Paul Kellet's economical pink-noise filter over a white source.
function fillPink(data) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
}

// Brownian / brown noise: a leaky integral of white noise → deep and dark.
function fillBrown(data) {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5; // scale back toward unity
  }
}

const GENERATORS = { white: fillWhite, pink: fillPink, brown: fillBrown };

// --- channel model -------------------------------------------------------------
// Order matches the request: dark, white, pink.
const CHANNELS = [
  { id: 'dark',  name: 'Dark',  desc: 'deep low rumble', gen: 'brown', level: 55, tone: 30 },
  { id: 'white', name: 'White', desc: 'bright even hiss', gen: 'white', level: 18, tone: 82 },
  { id: 'pink',  name: 'Pink',  desc: 'soft & balanced',  gen: 'pink',  level: 38, tone: 60 },
];

// Slider mappings.
const levelToGain = (v) => Math.pow(v / 100, 2) * 0.9;          // 0..100 → 0..0.9, eased
const toneToFreq  = (v) => 80 * Math.pow(18000 / 80, v / 100);  // 0..100 → 80Hz..18kHz, log
const masterToGain = (v) => Math.pow(v / 100, 1.4);

// --- audio graph (built lazily on first play) ----------------------------------
const FADE_SECONDS = 3; // gentle ramp in/out on play/pause

const audio = makeUnlockableAudioContext();
const ctx = audio.ctx;
let master = null;
let fade = null;        // dedicated node for the play/pause fade, downstream of master
let built = false;
let playing = false;
let sourcesRunning = false;
let fadeStopTimer = null;
const nodes = {}; // id → { buffer, filter, gain, source|null }

function buildGraph() {
  master = ctx.createGain();
  master.gain.value = masterToGain(masterSlider.valueAsNumber);

  // A separate gain rides the fade so it never fights the master slider's ramps.
  fade = ctx.createGain();
  fade.gain.value = 0; // start silent; fadeTo(1) brings it up on play
  master.connect(fade).connect(ctx.destination);

  for (const ch of CHANNELS) {
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    GENERATORS[ch.gen](buffer.getChannelData(0));

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.value = toneToFreq(ch.tone);

    const gain = ctx.createGain();
    gain.gain.value = levelToGain(ch.level);

    filter.connect(gain).connect(master);
    nodes[ch.id] = { buffer, filter, gain, source: null };
  }
  built = true;
}

function startSources() {
  for (const ch of CHANNELS) {
    const n = nodes[ch.id];
    const source = ctx.createBufferSource();
    source.buffer = n.buffer;
    source.loop = true;
    source.connect(n.filter);
    source.start();
    n.source = source;
  }
  sourcesRunning = true;
}

function stopSources() {
  for (const ch of CHANNELS) {
    const n = nodes[ch.id];
    if (n.source) { try { n.source.stop(); } catch { /* already stopped */ } n.source = null; }
  }
  sourcesRunning = false;
}

// Smootherstep (Perlin): eased at both ends, so the fade lingers near silence
// and near full — an S curve with long tails rather than a straight line.
function sCurve(from, to, steps) {
  const arr = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const s = t * t * t * (t * (t * 6 - 15) + 10);
    arr[i] = from + (to - from) * s;
  }
  return arr;
}

// Ride the fade node to a target (0 = silent, 1 = full) over FADE_SECONDS along
// an S curve. Building the curve from the current value keeps quick re-toggles
// click-free — it glides on from wherever the last fade left off.
function fadeTo(target) {
  const now = ctx.currentTime;
  const g = fade.gain;
  const from = g.value;
  g.cancelScheduledValues(now);
  g.setValueCurveAtTime(sCurve(from, target, 96), now, FADE_SECONDS);
}

// --- UI ------------------------------------------------------------------------
const channelsEl = document.getElementById('channels');
const playBtn = document.getElementById('play');
const playLabel = document.getElementById('play-label');
const masterSlider = document.getElementById('master');
const masterVal = document.getElementById('master-val');

// Build the channel cards from the model.
channelsEl.innerHTML = CHANNELS.map((ch) => `
  <div class="ch" id="ch-${ch.id}">
    <div class="ch__head">
      <span class="ch__name">${ch.name}</span>
      <span class="ch__desc">${ch.desc}</span>
    </div>
    <div class="ctl">
      <div class="ctl__row">
        <span class="ctl__label">Level</span>
        <span class="ctl__val" id="${ch.id}-level-val">${ch.level}%</span>
      </div>
      <input type="range" min="0" max="100" value="${ch.level}"
             id="${ch.id}-level" aria-label="${ch.name} level" />
    </div>
    <div class="ctl">
      <div class="ctl__row">
        <span class="ctl__label">Tone</span>
        <span class="ctl__val" id="${ch.id}-tone-val">${ch.tone}%</span>
      </div>
      <input type="range" min="0" max="100" value="${ch.tone}"
             id="${ch.id}-tone" aria-label="${ch.name} tone" />
    </div>
  </div>
`).join('');

// Smoothly ride a param to a target so slider drags don't click.
const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.03);

// Wire each channel's two sliders.
for (const ch of CHANNELS) {
  const levelEl = document.getElementById(`${ch.id}-level`);
  const toneEl = document.getElementById(`${ch.id}-tone`);
  const levelValEl = document.getElementById(`${ch.id}-level-val`);
  const toneValEl = document.getElementById(`${ch.id}-tone-val`);

  levelEl.addEventListener('input', () => {
    const v = levelEl.valueAsNumber;
    ch.level = v;
    levelValEl.textContent = `${v}%`;
    if (built) ramp(nodes[ch.id].gain.gain, levelToGain(v));
    persistSettings();
  });
  toneEl.addEventListener('input', () => {
    const v = toneEl.valueAsNumber;
    ch.tone = v;
    toneValEl.textContent = `${v}%`;
    if (built) ramp(nodes[ch.id].filter.frequency, toneToFreq(v));
    persistSettings();
  });
}

masterSlider.addEventListener('input', () => {
  const v = masterSlider.valueAsNumber;
  masterVal.textContent = `${v}%`;
  if (built) ramp(master.gain, masterToGain(v));
  persistSettings();
});

function markLive(on) {
  for (const ch of CHANNELS) {
    document.getElementById(`ch-${ch.id}`).classList.toggle('live', on);
  }
}

async function togglePlay() {
  if (!playing) {
    await audio.unlock();          // must run from the gesture (pointerup/click)
    if (!built) buildGraph();
    // Cancel a pending fade-out stop, and (re)start sources if they've been cut.
    if (fadeStopTimer) { clearTimeout(fadeStopTimer); fadeStopTimer = null; }
    if (!sourcesRunning) startSources();
    fadeTo(1);                     // gentle 2s ramp up
    playing = true;
    playBtn.classList.add('playing');
    playBtn.setAttribute('aria-pressed', 'true');
    playBtn.setAttribute('aria-label', 'Pause');
    playLabel.textContent = 'playing';
    markLive(true);
  } else {
    fadeTo(0);                     // gentle 2s ramp down, then cut the sources
    if (fadeStopTimer) clearTimeout(fadeStopTimer);
    fadeStopTimer = setTimeout(() => { stopSources(); fadeStopTimer = null; }, FADE_SECONDS * 1000 + 80);
    playing = false;
    playBtn.classList.remove('playing');
    playBtn.setAttribute('aria-pressed', 'false');
    playBtn.setAttribute('aria-label', 'Play');
    playLabel.textContent = 'paused';
    markLive(false);
  }
}

// pointerup completes the gesture — the reliable moment to start audio on iOS.
playBtn.addEventListener('pointerup', togglePlay);
// Keyboard: space/enter fire click; guard against pointerup double-firing.
playBtn.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePlay(); }
});

// --- save / load settings ------------------------------------------------------
// The CHANNELS model and the master slider always hold the current values (kept
// in sync by the input handlers above), so saving is just reading them, and
// loading is writing them back through the same input path so the audio graph
// and value readouts update exactly as if the user had dragged the sliders.
const clamp01 = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));

function currentSettings() {
  const channels = {};
  for (const ch of CHANNELS) channels[ch.id] = { level: ch.level, tone: ch.tone };
  return { app: 'sleep-noise', version: 1, master: masterSlider.valueAsNumber, channels };
}

// --- persistence: remember settings across reloads via localStorage ------------
// Separate from the file-based Save/Load: every slider change mirrors the current
// settings into localStorage, and restoreFromStorage() rehydrates them on load.
const STORAGE_KEY = 'sleep-noise:settings';

function persistSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings()));
  } catch { /* private mode / quota / disabled — non-fatal */ }
}

function restoreFromStorage() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return; }
  if (!raw) return;
  try { applySettings(JSON.parse(raw)); } catch { /* stale or corrupt — ignore */ }
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function saveState() {
  try {
    const blob = new Blob([JSON.stringify(currentSettings(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sleep-noise-${fileStamp()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Settings saved');
  } catch {
    showToast('Could not save');
  }
}

// Push a value through a slider's own input handler so the model, readout, and
// (if playing) audio node all update along the normal path.
function setSlider(el, value) {
  el.value = clamp01(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function applySettings(state) {
  if (!state || typeof state !== 'object' || !state.channels) throw new Error('unrecognized');
  let applied = false;
  if (state.master != null) { setSlider(masterSlider, state.master); applied = true; }
  for (const ch of CHANNELS) {
    const c = state.channels[ch.id];
    if (!c) continue;
    if (c.level != null) { setSlider(document.getElementById(`${ch.id}-level`), c.level); applied = true; }
    if (c.tone != null)  { setSlider(document.getElementById(`${ch.id}-tone`), c.tone);  applied = true; }
  }
  if (!applied) throw new Error('nothing to apply');
}

function handleStateFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applySettings(JSON.parse(reader.result));
      showToast('Settings loaded');
    } catch {
      showToast('Invalid settings file');
    }
  };
  reader.onerror = () => showToast('Could not read file');
  reader.readAsText(file);
  e.target.value = ''; // allow re-selecting the same file
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

document.getElementById('saveState').addEventListener('click', saveState);

// A hidden file input backs the Load button's upload dialog.
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'application/json,.json';
fileInput.style.display = 'none';
fileInput.addEventListener('change', handleStateFile);
document.body.appendChild(fileInput);
document.getElementById('loadState').addEventListener('click', () => fileInput.click());

// Rehydrate the last-used settings (if any) now that all controls are wired.
restoreFromStorage();
