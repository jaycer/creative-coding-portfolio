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
const NOISE_SECONDS = 6; // AudioBufferSourceNode loops this sample-accurately (gapless)

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
const FADE_SECONDS = 3;         // gentle ramp in/out on play/pause
const STALE_PAUSE_MS = 60_000;  // a pause longer than this rebuilds fresh on play

// audio/ctx are rebuilt from scratch when Safari leaves them stale after a long
// background (see rebuildAudio), so they're reassignable rather than const.
let audio = makeUnlockableAudioContext();
let ctx = audio.ctx;
let master = null;
let fade = null;        // dedicated node for the play/pause fade, downstream of master
let streamEl = null;    // <audio> element playing the graph's MediaStream (see buildGraph)
let built = false;
let playing = false;
let sourcesRunning = false;
let fadeStopTimer = null;
let audioStale = false; // set when the tab is backgrounded or the context suspends
let pausedAt = null;    // performance.now() when playback last stopped
const nodes = {}; // id → { el, source, filter, gain }

// Once a context leaves "running" it won't play the old graph again — mark it
// stale so the next play rebuilds. Attached to every context we create.
function watchContext(c) {
  c.addEventListener('statechange', () => {
    if (c.state === 'suspended' || c.state === 'interrupted') audioStale = true;
  });
}
watchContext(ctx);

function buildGraph() {
  master = ctx.createGain();
  master.gain.value = masterToGain(masterSlider.valueAsNumber);

  // A separate gain rides the fade so it never fights the master slider's ramps.
  fade = ctx.createGain();
  fade.gain.value = 0; // start silent; fadeTo(1) brings it up on play
  master.connect(fade);

  // Route the graph into a MediaStream played by an <audio> element instead of
  // fade → ctx.destination. This is the key to background playback in Safari: a
  // media element consuming a live MediaStream uses WebKit's call/stream keep-alive
  // path (the same one behind WebRTC/mic audio), so — with audioSession 'playback'
  // set in unlock() — the context keeps rendering while the tab is backgrounded and
  // even while an iPhone is locked (verified). A live stream also has no loop point,
  // so there's no seam. The rebuildAudio() fallback covers any deeper staleness.
  if (streamEl) { try { streamEl.pause(); } catch { /* */ } streamEl.remove(); }
  const streamDest = ctx.createMediaStreamDestination();
  fade.connect(streamDest);
  streamEl = new Audio();
  streamEl.srcObject = streamDest.stream;
  document.body.appendChild(streamEl); // some Safari builds want it in the DOM

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

// Buffer sources loop gaplessly but can only be started once, so play creates a
// fresh source and stop discards it.
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
  if (streamEl) streamEl.play().catch(() => { /* non-gesture resync — best effort */ });
  sourcesRunning = true;
}

function stopSources() {
  for (const ch of CHANNELS) {
    const n = nodes[ch.id];
    if (n.source) { try { n.source.stop(); } catch { /* already stopped */ } n.source = null; }
  }
  if (streamEl) streamEl.pause();
  sourcesRunning = false;
}

// Full teardown + rebuild — what closing and reopening the tab does by hand.
// WebKit suspends a backgrounded tab's context and its buffer sources come back
// silent even after it auto-resumes to "running" (the macOS Safari bug); the only
// cure is a brand-new context and graph. Runs synchronously (the old context's
// close() isn't awaited) so it can happen inside a play gesture.
function rebuildAudio() {
  const old = audio;
  audio = makeUnlockableAudioContext();
  ctx = audio.ctx;
  watchContext(ctx);
  master = null; fade = null; built = false; sourcesRunning = false;
  buildGraph();
  try { old.ctx.close(); } catch { /* already closed */ }
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
    // A long pause can leave the context silently stale even foreground, so treat
    // it like a background: rebuild a fresh stack. Rebuild (or first build), then
    // start + resume — all inside the gesture, so Safari lets start()/resume() through.
    if (pausedAt != null && performance.now() - pausedAt > STALE_PAUSE_MS) audioStale = true;
    if (audioStale) { rebuildAudio(); audioStale = false; }
    else if (!built) buildGraph();
    pausedAt = null;
    if (fadeStopTimer) { clearTimeout(fadeStopTimer); fadeStopTimer = null; }
    if (!sourcesRunning) startSources();
    fadeTo(1);                     // gentle 3s ramp up (scheduled; sounds once running)
    audio.unlock();
    playing = true;
    playBtn.classList.add('playing');
    playBtn.setAttribute('aria-pressed', 'true');
    playBtn.setAttribute('aria-label', 'Pause');
    playLabel.textContent = 'playing';
    markLive(true);
  } else {
    fadeTo(0);                     // gentle 3s ramp down, then cut the sources
    if (fadeStopTimer) clearTimeout(fadeStopTimer);
    fadeStopTimer = setTimeout(() => { stopSources(); fadeStopTimer = null; }, FADE_SECONDS * 1000 + 80);
    pausedAt = performance.now();
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

// --- self-heal after macOS Safari idles the audio ------------------------------
// WebKit suspends a backgrounded tab's context, and its buffer sources come back
// silent even after it auto-resumes to "running" (the address-bar speaker shows,
// but nothing plays). We can't observe that a source went dead, so we treat any
// background as suspect: mark the stack stale on hide, and on return, if it was
// backgrounded, rebuild fresh and resume so sound comes back on its own instead
// of needing the tab closed and reopened.
let resyncing = false;
async function resyncPlayback() {
  if (!playing || !built || resyncing || !audioStale) return;
  resyncing = true;
  try {
    // Did the MediaStream keep the audio alive through the background? If the
    // context is still running and the stream element wasn't paused, trust it
    // survived and skip the rebuild — that's the whole reason for the stream.
    const alive = ctx.state === 'running' && streamEl && !streamEl.paused;
    if (alive) { audioStale = false; return; }
    rebuildAudio();
    await audio.unlock();
    startSources();
    fade.gain.value = 1;                 // already mid-listen; resume at full
    if (ctx.state === 'running') audioStale = false; // else a play tap rebuilds
  } finally {
    resyncing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (built) audioStale = true;        // a background can kill buffer sources
  } else {
    resyncPlayback();                    // rebuilds now if we were playing…
  }
  // …and if we were paused, the stale flag makes the next play tap rebuild.
});
// Focus covers returning to the window when the tab never went fully hidden.
window.addEventListener('focus', () => resyncPlayback());

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
