// Burnt Crust — a ten element break machine with ten city kits.
//
// Every kit fills the same ten ROLES, so the panel never changes shape: an
// AMOUNT fader (how much of that element you hear) and a DRIFT fader under it
// (how fast that amount moves on its own). Drift is a smooth random walk from a
// value-noise table — at 0 the fader stays put, and the higher you push it the
// faster the machine drags that fader around. Tempo is the one manual control.
//
// A kit supplies its own voices, pattern weights, swing, bass line, drive
// character, reverb, and a one-bar break rendered offline from its own drums —
// CHOP plays random slices of that render at random pitch, forward or reversed,
// which is the technique the genre is built on. Switching kits swaps the whole
// palette live and keeps your fader positions.

// --- iOS-reliable AudioContext -------------------------------------------------
// Inlined so the app is self-contained. Playback session, retried resume(), and
// auto re-resume on interruption. Start has to happen from a completed gesture.
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

// --- roles ---------------------------------------------------------------------
// Fixed slots every kit fills. 'trigger' roles fire events and get a row in the
// pattern readout; 'level' roles run continuously and get a meter.
// `pans` marks the roles that are actually a sound in the field. CRUSH and SPACE
// shape the whole mix rather than sit somewhere in it, so they get no pan pages
// instead of a control that would do nothing.
const ROLES = [
  { id: 'low',   kind: 'trigger', pans: true },
  { id: 'mid',   kind: 'trigger', pans: true },
  { id: 'high',  kind: 'trigger', pans: true },
  { id: 'chop',  kind: 'trigger', pans: true },
  { id: 'roll',  kind: 'trigger', pans: true },
  { id: 'bass',  kind: 'trigger', pans: true },
  { id: 'gate',  kind: 'trigger', pans: false },   // a gate on the bus, not a voice
  { id: 'drone', kind: 'level',   pans: true },
  { id: 'crush', kind: 'level',   pans: false },
  { id: 'space', kind: 'level',   pans: false },
];

// What the sub fader under each amount fader is holding right now.
const SUB_PAGES = [
  { id: 'drift', label: 'Drift', field: 'drift',     aria: 'drift rate' },
  { id: 'width', label: 'Pan W', field: 'panWidth',  aria: 'pan width' },
  { id: 'rando', label: 'Pan R', field: 'panRando',  aria: 'pan randomness' },
];
const pageOf = (id) => SUB_PAGES.find((p) => p.id === id) ?? SUB_PAGES[0];

// --- voice engines -------------------------------------------------------------
// Three engines cover every kit. Each takes an explicit context and destination
// so the same code renders a break offline and plays it live. `tune` multiplies
// every frequency and shortens the tail, which is what makes rolls rise.
const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

// A pitched body: sine/triangle/square swept down. Kicks, toms, log drums, rims.
function boom(ctx, dest, t, p) {
  const {
    wave = 'sine', f0 = 160, f1 = 45, drop = 0.09, decay = 0.34,
    vel = 1, click = 0, clickFreq = 1600, tune = 1,
  } = p;
  const dec = decay / (tune > 1 ? tune * 0.85 : 1);
  const o = ctx.createOscillator();
  o.type = wave;
  o.frequency.setValueAtTime(Math.max(20, f0 * tune), t);
  o.frequency.exponentialRampToValueAtTime(Math.max(18, f1 * tune), t + drop);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + dec + 0.05);
  if (click > 0) {
    noiseHit(ctx, dest, t, { type: 'highpass', freq: clickFreq, decay: 0.02, vel: vel * click });
  }
}

// Filtered noise. Snares, hats, claps (taps > 1), shakers, ice ticks.
function noiseHit(ctx, dest, t, p) {
  const {
    type = 'bandpass', freq = 1800, q = 1, decay = 0.1, vel = 0.5,
    taps = 1, spread = 0.011, body = null, tune = 1,
  } = p;
  const dec = decay / (tune > 1 ? tune * 0.85 : 1);
  for (let i = 0; i < taps; i++) {
    const tt = t + i * spread * (0.7 + Math.random() * 0.6);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = Math.min(20000, freq * tune); f.Q.value = q;
    const g = ctx.createGain();
    const v = vel * (i === taps - 1 ? 1 : 0.62);
    g.gain.setValueAtTime(Math.max(0.0002, v), tt);
    g.gain.exponentialRampToValueAtTime(0.0001, tt + dec);
    src.connect(f).connect(g).connect(dest);
    src.start(tt, Math.random() * 1.5);
    src.stop(tt + dec + 0.03);
  }
  if (body) boom(ctx, dest, t, { ...body, vel: vel * (body.gain ?? 0.5), tune });
}

// Two operator FM. Bells, metallic snares, whistles, glass.
function fmHit(ctx, dest, t, p) {
  const { f = 300, ratio = 2.4, index = 6, decay = 0.2, vel = 0.5, wave = 'sine', tune = 1 } = p;
  const dec = decay / (tune > 1 ? tune * 0.85 : 1);
  const carF = f * tune;
  const car = ctx.createOscillator();
  car.type = wave; car.frequency.value = carF;
  const mod = ctx.createOscillator();
  mod.type = 'sine'; mod.frequency.value = carF * ratio;
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(carF * index, t);
  modGain.gain.exponentialRampToValueAtTime(1, t + dec * 0.85);
  mod.connect(modGain).connect(car.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.0002, vel), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
  car.connect(g).connect(dest);
  car.start(t); mod.start(t);
  car.stop(t + dec + 0.05); mod.stop(t + dec + 0.05);
}

function playVoice(ctx, dest, t, spec, vel, tune = 1, open = false) {
  if (!spec) return;
  const p = { ...spec, vel: vel * (spec.gain ?? 1), tune };
  if (open && spec.openDecay) p.decay = spec.openDecay;
  if (spec.engine === 'boom') boom(ctx, dest, t, p);
  else if (spec.engine === 'fm') fmHit(ctx, dest, t, p);
  else noiseHit(ctx, dest, t, p);
}

// The bass role: a sustained note with a short glide in.
function bassNote(ctx, dest, t, spec, dur, freq, vel) {
  const { wave = 'sine', cutoff = 220, q = 1, glide = 1.5, gain = 1 } = spec;
  const o = ctx.createOscillator();
  o.type = wave;
  o.frequency.setValueAtTime(freq * glide, t);
  o.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = q;
  const g = ctx.createGain();
  const v = Math.max(0.0002, vel * gain);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + 0.014);
  g.gain.setValueAtTime(v, t + Math.max(0.03, dur - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(dest);
  o.start(t); o.stop(t + dur + 0.03);
}

// --- drive curves --------------------------------------------------------------
// CRUSH sounds different per kit because the curve is different: soft tape,
// hard clip, a wavefolder, a bit quantizer, an asymmetric tube.
function makeCurve(kind, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    switch (kind) {
      case 'hard': c[i] = Math.max(-0.85, Math.min(0.85, x * 3.4)); break;
      case 'fold': c[i] = Math.sin(x * Math.PI * 1.9) * 0.9; break;
      case 'bits': c[i] = Math.round(x * 6) / 6.6; break;             // staircase quantizer
      case 'tube': c[i] = Math.tanh(x * 2.6 + 0.18) - Math.tanh(0.18); break;
      case 'soft': c[i] = Math.tanh(x * 1.7); break;
      default:     c[i] = Math.tanh(x * 3.2) * 0.92
                        + Math.sign(x) * Math.pow(Math.abs(x), 0.6) * 0.08; break;
    }
  }
  return c;
}

// A plain tanh shaper on the output: a compressor alone still lets transients
// past 1.0, and this stack is all transients.
function limitCurve(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(((i * 2) / n - 1) * 1.6);
  return c;
}

// --- kits ----------------------------------------------------------------------
// Ten cities, ten palettes. Each fills the same ten roles.
const KITS = [
  {
    id: 'cleveland', city: 'Cleveland', tag: 'industrial jungle',
    notes: 'Sine kick, noise snare, amen chop, reese growl.',
    names: { low: 'Kick', mid: 'Snare', high: 'Hats', chop: 'Chop', roll: 'Roll',
             bass: 'Sub', gate: 'Stutter', drone: 'Reese', crush: 'Crush', space: 'Space' },
    descs: { low: 'sub thud on the grid', mid: 'the backbeat crack', high: '16th tick, open spray',
             chop: 'break slices, pitched', roll: 'snare rush into the bar', bass: 'sine bass underneath',
             gate: 'gate retrigger', drone: 'detuned growl', crush: 'drive into distortion', space: 'reverb wash' },
    defaults: { low: [75, 0], mid: [70, 0], high: [45, 14], chop: [55, 26], roll: [30, 20],
                bass: [60, 0], gate: [25, 30], drone: [35, 18], crush: [30, 12], space: [25, 10] },
    swing: 0,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 165, f1: 43, drop: 0.085, decay: 0.34, click: 0.35 },
      mid:  { engine: 'noise', type: 'bandpass', freq: 1750, q: 0.8, decay: 0.11, gain: 0.85,
              body: { wave: 'triangle', f0: 210, f1: 140, drop: 0.07, decay: 0.09, gain: 0.5 } },
      high: { engine: 'noise', type: 'highpass', freq: 7600, q: 0.9, decay: 0.042, openDecay: 0.22, gain: 0.5 },
      bass: { wave: 'sine', cutoff: 220 },
    },
    weights: { low: [1, 0, 0, 0.18, 0, 0, 0.45, 0, 0.30, 0, 0, 0.12, 0, 0.35, 0, 0.08],
               mid: [0, 0, 0.06, 0, 1, 0, 0.10, 0.14, 0, 0.06, 0, 0.12, 1, 0, 0.14, 0.10],
               high: 0.95, open: 0.08 },
    bass: { root: 41.2, keys: [0, 0, 5, 3],
            pattern: [{ s: 0, n: 0, len: 5 }, { s: 6, n: 0, len: 2 }, { s: 10, n: 3, len: 3 }, { s: 14, n: -2, len: 2 }] },
    chop: { semis: [-5, -3, 0, 0, 0, 2, 5, 7, 12], reverse: 0.28, density: 0.55 },
    roll: { voice: 'mid', rise: 0.55, max: 22, chopChance: 0.22, steps: [12, 8] },
    gate: { divisions: [3, 4, 6, 8, 12], windows: [2, 4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 2, detune: -14, gain: 0.35 },
                    { wave: 'sawtooth', mul: 2, detune: 15, gain: 0.35 },
                    { wave: 'sawtooth', mul: 1, detune: 0, gain: 0.5 }],
             filter: { type: 'lowpass', freq: 700, q: 7 }, lfo: { rate: 0.13, depth: 420 }, gain: 0.3 },
    crush: { curve: 'sat', drive: 7 },
    space: { seconds: 2.0, decay: 2.6 },
    break: { bpm: 170, hits: [
      { voice: 'low', steps: [0, 10], vel: 0.95 },
      { voice: 'mid', steps: [4, 12], vel: 0.9 },
      { voice: 'mid', steps: [7, 11, 15], vel: 0.3, tune: 1.15 },
      { voice: 'high', steps: 'all', vel: 0.3, open: [6, 14] },
    ] },
  },
  {
    id: 'detroit', city: 'Detroit', tag: 'machine techno',
    notes: '909 drop, four tap clap, hoover wobble, wavefolder.',
    names: { low: 'Kick', mid: 'Clap', high: 'Tick', chop: 'Chop', roll: 'Rush',
             bass: 'Bass', gate: 'Gate', drone: 'Hoover', crush: 'Fold', space: 'Hall' },
    descs: { low: 'long 909 drop', mid: 'four tap clap', high: 'metallic FM tick',
             chop: 'electro slices', roll: 'clap rush', bass: 'square electro bass',
             gate: 'straight gate', drone: 'hoover wobble', crush: 'wavefolder', space: 'big hall' },
    defaults: { low: [82, 0], mid: [60, 10], high: [50, 16], chop: [40, 22], roll: [22, 24],
                bass: [55, 12], gate: [20, 26], drone: [40, 22], crush: [25, 18], space: [30, 8] },
    swing: 0,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 200, f1: 38, drop: 0.12, decay: 0.5, click: 0.5, clickFreq: 3000 },
      mid:  { engine: 'noise', type: 'bandpass', freq: 1400, q: 1.2, decay: 0.16, taps: 4, spread: 0.010, gain: 0.6 },
      high: { engine: 'fm', f: 380, ratio: 1.4, index: 8, decay: 0.05, openDecay: 0.2, gain: 0.35 },
      bass: { wave: 'square', cutoff: 400, q: 3, gain: 0.6 },
    },
    weights: { low: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0.2],
               mid: [0, 0, 0, 0, 1, 0, 0, 0.1, 0, 0, 0, 0.08, 1, 0, 0, 0.12],
               high: 0.9, open: 0.05 },
    bass: { root: 49, keys: [0, 0, -2, 3],
            pattern: [{ s: 2, n: 0, len: 2 }, { s: 6, n: 0, len: 2 }, { s: 10, n: 5, len: 2 }, { s: 14, n: 3, len: 2 }] },
    chop: { semis: [-12, -5, 0, 0, 3, 7], reverse: 0.2, density: 0.45 },
    roll: { voice: 'mid', rise: 0.35, max: 16, chopChance: 0.1, steps: [12, 4] },
    gate: { divisions: [4, 8, 16], windows: [4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 1, detune: -25, gain: 0.4 },
                    { wave: 'sawtooth', mul: 1, detune: 26, gain: 0.4 },
                    { wave: 'sawtooth', mul: 0.5, detune: 0, gain: 0.4 }],
             filter: { type: 'lowpass', freq: 900, q: 9 }, lfo: { rate: 5.5, depth: 600 }, gain: 0.26 },
    crush: { curve: 'fold', drive: 5 },
    space: { seconds: 3.2, decay: 2.0 },
    break: { bpm: 130, hits: [
      { voice: 'low', steps: [0, 4, 8, 12], vel: 0.95 },
      { voice: 'mid', steps: [4, 12], vel: 0.7 },
      { voice: 'high', steps: [2, 6, 10, 14], vel: 0.4 },
    ] },
  },
  {
    id: 'tokyo', city: 'Tokyo', tag: 'hyper chip',
    notes: 'Square thud, FM zap, bit quantizer, the fastest gates.',
    names: { low: 'Thud', mid: 'Zap', high: 'Blip', chop: 'Chop', roll: 'Stammer',
             bass: 'Chip', gate: 'Glitch', drone: 'Pulse', crush: 'Bits', space: 'Room' },
    descs: { low: 'square gabber thud', mid: 'metal FM zap', high: 'tight chip blip',
             chop: 'fast slices', roll: 'zap stammer', bass: 'square chip bass',
             gate: 'fine glitch gate', drone: 'pulse detune', crush: 'bit quantizer', space: 'bright room' },
    defaults: { low: [78, 0], mid: [62, 20], high: [62, 24], chop: [70, 34], roll: [45, 30],
                bass: [50, 14], gate: [45, 36], drone: [28, 26], crush: [45, 22], space: [18, 12] },
    swing: 0,
    voices: {
      low:  { engine: 'boom', wave: 'square', f0: 210, f1: 50, drop: 0.06, decay: 0.28, click: 0.6, clickFreq: 4200, gain: 0.8 },
      mid:  { engine: 'fm', f: 320, ratio: 3.7, index: 14, decay: 0.18, gain: 0.5 },
      high: { engine: 'noise', type: 'highpass', freq: 11000, decay: 0.02, openDecay: 0.1, gain: 0.45 },
      bass: { wave: 'square', cutoff: 800, q: 2, gain: 0.5 },
    },
    weights: { low: [1, 0, 0.1, 0.3, 0, 0.15, 0.5, 0, 0.4, 0, 0.15, 0.25, 0, 0.4, 0.1, 0.2],
               mid: [0, 0.1, 0, 0.12, 1, 0, 0.18, 0.2, 0, 0.12, 0, 0.2, 1, 0.1, 0.22, 0.18],
               high: 1, open: 0.04 },
    bass: { root: 55, keys: [0, 3, 5, 7],
            pattern: [{ s: 0, n: 0, len: 2 }, { s: 4, n: 7, len: 1 }, { s: 8, n: 3, len: 2 }, { s: 12, n: 10, len: 1 }] },
    chop: { semis: [-7, 0, 0, 4, 7, 12, 12, 19], reverse: 0.4, density: 0.75 },
    roll: { voice: 'mid', rise: 0.9, max: 28, chopChance: 0.35, steps: [12, 8, 4] },
    gate: { divisions: [8, 12, 16, 24], windows: [2, 4] },
    drone: { oscs: [{ wave: 'square', mul: 2, detune: -9, gain: 0.3 },
                    { wave: 'square', mul: 2, detune: 11, gain: 0.3 },
                    { wave: 'sawtooth', mul: 4, detune: 0, gain: 0.15 }],
             filter: { type: 'bandpass', freq: 1400, q: 4 }, lfo: { rate: 2.1, depth: 900 }, gain: 0.2 },
    crush: { curve: 'bits', drive: 9 },
    space: { seconds: 1.2, decay: 3.5 },
    break: { bpm: 200, hits: [
      { voice: 'low', steps: [0, 6, 10], vel: 0.9 },
      { voice: 'mid', steps: [4, 12], vel: 0.75 },
      { voice: 'mid', steps: [3, 7, 14], vel: 0.28, tune: 1.4 },
      { voice: 'high', steps: 'all', vel: 0.3 },
    ] },
  },
  {
    id: 'berlin', city: 'Berlin', tag: 'dub techno',
    notes: 'Soft deep kick, rimshot, minor seventh chord, long cavern.',
    names: { low: 'Kick', mid: 'Rim', high: 'Brush', chop: 'Chop', roll: 'Ripple',
             bass: 'Sub', gate: 'Gate', drone: 'Pad', crush: 'Tape', space: 'Cavern' },
    descs: { low: 'soft deep drop', mid: 'wood rimshot', high: 'brushed noise',
             chop: 'minimal slices', roll: 'rim ripple', bass: 'deep sine sub',
             gate: 'slow gate', drone: 'minor seventh chord', crush: 'tape saturation', space: 'long cavern' },
    defaults: { low: [70, 0], mid: [45, 12], high: [38, 18], chop: [25, 20], roll: [15, 16],
                bass: [65, 8], gate: [12, 18], drone: [55, 24], crush: [18, 14], space: [55, 16] },
    swing: 0.06,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 120, f1: 36, drop: 0.2, decay: 0.6, click: 0.1 },
      mid:  { engine: 'noise', type: 'bandpass', freq: 2400, q: 6, decay: 0.04, gain: 0.6,
              body: { wave: 'triangle', f0: 400, f1: 300, drop: 0.02, decay: 0.05, gain: 0.4 } },
      high: { engine: 'noise', type: 'bandpass', freq: 6000, q: 0.6, decay: 0.09, openDecay: 0.3, gain: 0.3 },
      bass: { wave: 'sine', cutoff: 150 },
    },
    weights: { low: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
               mid: [0, 0, 0.2, 0, 0, 0, 0.35, 0, 0, 0, 0.2, 0, 0, 0, 0.4, 0.1],
               high: 0.55, open: 0.12 },
    bass: { root: 36.7, keys: [0, 0, 0, 5],
            pattern: [{ s: 0, n: 0, len: 7 }, { s: 8, n: 0, len: 4 }, { s: 12, n: 7, len: 4 }] },
    chop: { semis: [-12, -7, 0, 0, 0, 5], reverse: 0.35, density: 0.3 },
    roll: { voice: 'mid', rise: 0.3, max: 12, chopChance: 0.15, steps: [14] },
    gate: { divisions: [2, 3, 4], windows: [4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 1, detune: -6, gain: 0.3 },
                    { wave: 'sawtooth', mul: 1.189, detune: 4, gain: 0.26 },
                    { wave: 'sawtooth', mul: 1.782, detune: -3, gain: 0.22 }],
             filter: { type: 'lowpass', freq: 500, q: 2 }, lfo: { rate: 0.06, depth: 260 }, gain: 0.3 },
    crush: { curve: 'soft', drive: 3 },
    space: { seconds: 4.5, decay: 1.6 },
    break: { bpm: 125, hits: [
      { voice: 'low', steps: [0, 8], vel: 0.9 },
      { voice: 'mid', steps: [6, 14], vel: 0.55 },
      { voice: 'high', steps: [2, 4, 10, 12], vel: 0.3 },
    ] },
  },
  {
    id: 'kingston', city: 'Kingston', tag: 'dub roots',
    notes: 'One drop, timbale, organ bubble, spring tank.',
    names: { low: 'Drop', mid: 'Timbale', high: 'Shaker', chop: 'Chop', roll: 'Flam',
             bass: 'Bassline', gate: 'Cut', drone: 'Organ', crush: 'Tube', space: 'Spring' },
    descs: { low: 'one drop boom', mid: 'pitched timbale', high: 'triple shaker',
             chop: 'rocksteady slices', roll: 'timbale flam', bass: 'walking bassline',
             gate: 'echo cut', drone: 'organ bubble', crush: 'tube warmth', space: 'spring tank' },
    defaults: { low: [65, 0], mid: [55, 14], high: [50, 20], chop: [35, 22], roll: [25, 22],
                bass: [70, 10], gate: [18, 22], drone: [45, 20], crush: [22, 12], space: [40, 18] },
    swing: 0.14,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 140, f1: 45, drop: 0.12, decay: 0.45, click: 0.18 },
      mid:  { engine: 'boom', wave: 'triangle', f0: 420, f1: 300, drop: 0.05, decay: 0.18, click: 0.4, clickFreq: 3000, gain: 0.6 },
      high: { engine: 'noise', type: 'bandpass', freq: 9000, q: 1.4, decay: 0.03, openDecay: 0.14, taps: 3, spread: 0.008, gain: 0.3 },
      bass: { wave: 'triangle', cutoff: 200, glide: 1.2, gain: 1.1 },
    },
    weights: { low: [0.2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.2, 0],
               mid: [0, 0, 0.1, 0, 0, 0, 0.2, 0, 1, 0, 0.1, 0, 0.3, 0, 0.15, 0.2],
               high: 0.8, open: 0.1 },
    bass: { root: 43.6, keys: [0, 0, 5, 7],
            pattern: [{ s: 0, n: 0, len: 3 }, { s: 3, n: 7, len: 2 }, { s: 6, n: 5, len: 3 }, { s: 11, n: 3, len: 4 }] },
    chop: { semis: [-12, -5, 0, 0, 0, 7], reverse: 0.3, density: 0.4 },
    roll: { voice: 'mid', rise: 0.4, max: 10, chopChance: 0.2, steps: [12, 14] },
    gate: { divisions: [3, 4, 6], windows: [2, 4] },
    drone: { oscs: [{ wave: 'sine', mul: 2, detune: 0, gain: 0.4 },
                    { wave: 'sine', mul: 3, detune: 6, gain: 0.24 },
                    { wave: 'square', mul: 1, detune: -4, gain: 0.16 }],
             filter: { type: 'bandpass', freq: 900, q: 3 }, lfo: { rate: 5.2, depth: 300 }, gain: 0.24 },
    crush: { curve: 'tube', drive: 4 },
    space: { seconds: 1.4, decay: 1.2, spring: true },
    break: { bpm: 140, hits: [
      { voice: 'low', steps: [8], vel: 0.95 },
      { voice: 'mid', steps: [8, 12], vel: 0.6 },
      { voice: 'high', steps: [0, 2, 4, 6, 8, 10, 12, 14], vel: 0.35 },
    ] },
  },
  {
    id: 'sao-paulo', city: 'São Paulo', tag: 'baile funk',
    notes: 'Surdo, tamborzão, whistle, horn stab.',
    names: { low: 'Surdo', mid: 'Tamborzão', high: 'Whistle', chop: 'Chop', roll: 'Rufo',
             bass: 'Bass', gate: 'Corte', drone: 'Horn', crush: 'Drive', space: 'Street' },
    descs: { low: 'deep surdo boom', mid: 'tamborzão hit', high: 'whistle tick',
             chop: 'funk slices', roll: 'drum rufo', bass: 'saw bass punch',
             gate: 'corte gate', drone: 'horn stab', crush: 'hot drive', space: 'street echo' },
    defaults: { low: [80, 0], mid: [72, 14], high: [42, 20], chop: [45, 26], roll: [35, 26],
                bass: [58, 12], gate: [28, 28], drone: [30, 24], crush: [35, 16], space: [22, 12] },
    swing: 0.1,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 95, f1: 48, drop: 0.1, decay: 0.32, click: 0.25 },
      mid:  { engine: 'noise', type: 'bandpass', freq: 900, q: 2, decay: 0.09, gain: 0.8,
              body: { wave: 'triangle', f0: 250, f1: 180, drop: 0.04, decay: 0.08, gain: 0.6 } },
      high: { engine: 'fm', f: 2400, ratio: 1.2, index: 3, decay: 0.04, openDecay: 0.12, gain: 0.22 },
      bass: { wave: 'sawtooth', cutoff: 300, q: 2, gain: 0.7 },
    },
    weights: { low: [1, 0, 0, 0.5, 0, 0, 0.35, 0, 0.8, 0, 0, 0.4, 0, 0, 0.3, 0],
               mid: [0, 0, 0.5, 0, 0.9, 0, 0.5, 0.3, 0, 0.4, 0, 0.5, 0.9, 0, 0.4, 0.3],
               high: 0.6, open: 0.06 },
    bass: { root: 49, keys: [0, 0, 3, 5],
            pattern: [{ s: 0, n: 0, len: 3 }, { s: 6, n: 0, len: 2 }, { s: 8, n: 5, len: 3 }, { s: 12, n: 3, len: 3 }] },
    chop: { semis: [-5, 0, 0, 0, 3, 7], reverse: 0.22, density: 0.5 },
    roll: { voice: 'mid', rise: 0.5, max: 18, chopChance: 0.15, steps: [12, 8] },
    gate: { divisions: [4, 6, 8], windows: [2, 4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 4, detune: -8, gain: 0.22 },
                    { wave: 'sawtooth', mul: 4, detune: 9, gain: 0.22 },
                    { wave: 'triangle', mul: 2, detune: 0, gain: 0.3 }],
             filter: { type: 'lowpass', freq: 1500, q: 4 }, lfo: { rate: 4.8, depth: 500 }, gain: 0.2 },
    crush: { curve: 'sat', drive: 8 },
    space: { seconds: 1.8, decay: 2.4 },
    break: { bpm: 130, hits: [
      { voice: 'low', steps: [0, 3, 8, 11], vel: 0.95 },
      { voice: 'mid', steps: [4, 6, 12, 14], vel: 0.8 },
      { voice: 'high', steps: [2, 10], vel: 0.4 },
    ] },
  },
  {
    id: 'mumbai', city: 'Mumbai', tag: 'tabla pressure',
    notes: 'Dholak, pitched tabla, tanpura beating.',
    names: { low: 'Dholak', mid: 'Tabla', high: 'Tick', chop: 'Chop', roll: 'Tihai',
             bass: 'Bass', gate: 'Kut', drone: 'Tanpura', crush: 'Warm', space: 'Hall' },
    descs: { low: 'dholak belly', mid: 'pitched tabla', high: 'finger tick',
             chop: 'tabla slices', roll: 'tihai run', bass: 'root and fifth',
             gate: 'kut gate', drone: 'tanpura beating', crush: 'warm edge', space: 'wide hall' },
    defaults: { low: [68, 0], mid: [65, 18], high: [45, 22], chop: [40, 28], roll: [30, 28],
                bass: [55, 8], gate: [20, 24], drone: [50, 14], crush: [18, 12], space: [35, 14] },
    swing: 0.04,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 110, f1: 70, drop: 0.06, decay: 0.35, click: 0.2, clickFreq: 900 },
      mid:  { engine: 'fm', f: 300, ratio: 1.5, index: 5, decay: 0.22, gain: 0.5 },
      high: { engine: 'noise', type: 'bandpass', freq: 5200, q: 4, decay: 0.05, openDecay: 0.16, gain: 0.3 },
      bass: { wave: 'sine', cutoff: 240, gain: 0.9 },
    },
    weights: { low: [1, 0, 0.1, 0.3, 0, 0.2, 0.4, 0, 0.6, 0, 0.2, 0.3, 0, 0.3, 0.15, 0.2],
               mid: [0, 0.2, 0.4, 0, 0.8, 0.2, 0.3, 0.4, 0.3, 0.2, 0.5, 0.2, 0.9, 0.2, 0.4, 0.35],
               high: 0.7, open: 0.07 },
    bass: { root: 48.9, keys: [0, 0, 0, 0],
            pattern: [{ s: 0, n: 0, len: 8 }, { s: 8, n: 7, len: 4 }, { s: 12, n: 0, len: 4 }] },
    chop: { semis: [-5, 0, 0, 2, 5, 7], reverse: 0.25, density: 0.5 },
    roll: { voice: 'mid', rise: 0.7, max: 20, chopChance: 0.25, steps: [12, 8, 14] },
    gate: { divisions: [3, 6, 9], windows: [2, 4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 1, detune: -3, gain: 0.28 },
                    { wave: 'sawtooth', mul: 1.5, detune: 5, gain: 0.24 },
                    { wave: 'triangle', mul: 2, detune: 2, gain: 0.24 },
                    { wave: 'triangle', mul: 3, detune: -4, gain: 0.14 }],
             filter: { type: 'lowpass', freq: 1200, q: 2 }, lfo: { rate: 0.09, depth: 500 }, gain: 0.24 },
    crush: { curve: 'soft', drive: 4 },
    space: { seconds: 3.0, decay: 2.2 },
    break: { bpm: 150, hits: [
      { voice: 'low', steps: [0, 6, 10], vel: 0.9 },
      { voice: 'mid', steps: [2, 4, 8, 12, 14], vel: 0.6 },
      { voice: 'high', steps: [1, 5, 9, 13], vel: 0.35 },
    ] },
  },
  {
    id: 'lagos', city: 'Lagos', tag: 'log drum',
    notes: 'Log drum, shakers, warm pad, heavy swing.',
    names: { low: 'Log', mid: 'Rim', high: 'Shaker', chop: 'Chop', roll: 'Run',
             bass: 'Sub', gate: 'Gate', drone: 'Pad', crush: 'Warm', space: 'Room' },
    descs: { low: 'pitched log drum', mid: 'rim and clap', high: 'four tap shaker',
             chop: 'afro slices', roll: 'log run', bass: 'round sub',
             gate: 'lazy gate', drone: 'warm pad', crush: 'soft warmth', space: 'wide room' },
    defaults: { low: [78, 0], mid: [55, 12], high: [55, 18], chop: [35, 20], roll: [25, 24],
                bass: [62, 10], gate: [15, 20], drone: [45, 18], crush: [15, 10], space: [30, 12] },
    swing: 0.12,
    voices: {
      low:  { engine: 'boom', wave: 'triangle', f0: 200, f1: 62, drop: 0.14, decay: 0.5, click: 0.2, gain: 0.9 },
      mid:  { engine: 'noise', type: 'bandpass', freq: 1800, q: 1.6, decay: 0.12, taps: 2, spread: 0.014, gain: 0.55 },
      high: { engine: 'noise', type: 'highpass', freq: 8000, decay: 0.025, openDecay: 0.11, taps: 4, spread: 0.007, gain: 0.28 },
      bass: { wave: 'sine', cutoff: 190, gain: 1 },
    },
    weights: { low: [1, 0, 0, 0.3, 0, 0.2, 0.6, 0, 0.4, 0, 0.3, 0.5, 0, 0.2, 0.4, 0],
               mid: [0, 0, 0.1, 0, 0.8, 0, 0.15, 0.2, 0, 0.1, 0, 0.2, 0.8, 0, 0.2, 0.15],
               high: 0.85, open: 0.06 },
    bass: { root: 41.2, keys: [0, 0, 5, 3],
            pattern: [{ s: 0, n: 0, len: 4 }, { s: 6, n: 3, len: 2 }, { s: 10, n: 5, len: 3 }, { s: 14, n: 0, len: 2 }] },
    chop: { semis: [-12, -5, 0, 0, 3, 7], reverse: 0.2, density: 0.4 },
    roll: { voice: 'low', rise: 0.5, max: 12, chopChance: 0.15, steps: [12] },
    gate: { divisions: [3, 4, 6], windows: [2, 4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 2, detune: -7, gain: 0.26 },
                    { wave: 'sawtooth', mul: 2, detune: 8, gain: 0.26 },
                    { wave: 'triangle', mul: 3, detune: 0, gain: 0.2 }],
             filter: { type: 'lowpass', freq: 800, q: 1.4 }, lfo: { rate: 0.22, depth: 340 }, gain: 0.26 },
    crush: { curve: 'soft', drive: 3 },
    space: { seconds: 2.6, decay: 2.0 },
    break: { bpm: 112, hits: [
      { voice: 'low', steps: [0, 6, 11], vel: 0.95 },
      { voice: 'mid', steps: [4, 12], vel: 0.6 },
      { voice: 'high', steps: 'all', vel: 0.28 },
    ] },
  },
  {
    id: 'reykjavik', city: 'Reykjavik', tag: 'glacial',
    notes: 'Slow pulse, FM glass, bowed drone, cathedral tail.',
    names: { low: 'Pulse', mid: 'Glass', high: 'Ice', chop: 'Chop', roll: 'Shiver',
             bass: 'Deep', gate: 'Stutter', drone: 'Bow', crush: 'Edge', space: 'Cathedral' },
    descs: { low: 'slow soft pulse', mid: 'FM glass bell', high: 'ice tick',
             chop: 'sparse slices', roll: 'glass shiver', bass: 'deep slow note',
             gate: 'rare stutter', drone: 'bowed string', crush: 'faint edge', space: 'cathedral tail' },
    defaults: { low: [55, 0], mid: [40, 22], high: [35, 26], chop: [20, 24], roll: [12, 20],
                bass: [50, 12], gate: [8, 16], drone: [60, 26], crush: [8, 10], space: [70, 20] },
    swing: 0,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 90, f1: 55, drop: 0.2, decay: 0.8, click: 0.05 },
      mid:  { engine: 'fm', f: 520, ratio: 2.7, index: 3, decay: 0.9, gain: 0.3 },
      high: { engine: 'noise', type: 'highpass', freq: 12000, decay: 0.012, openDecay: 0.08, gain: 0.24 },
      bass: { wave: 'sine', cutoff: 160, glide: 1.1, gain: 0.9 },
    },
    weights: { low: [1, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
               mid: [0, 0, 0, 0.2, 0.5, 0, 0, 0.15, 0, 0, 0.25, 0, 0.4, 0, 0.15, 0],
               high: 0.5, open: 0.15 },
    bass: { root: 32.7, keys: [0, 0, 7, 5],
            pattern: [{ s: 0, n: 0, len: 10 }, { s: 10, n: 7, len: 6 }] },
    chop: { semis: [-12, -12, -7, 0, 0, 7], reverse: 0.5, density: 0.3 },
    roll: { voice: 'mid', rise: 0.3, max: 8, chopChance: 0.3, steps: [12] },
    gate: { divisions: [2, 3, 4], windows: [4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 1, detune: -4, gain: 0.22 },
                    { wave: 'triangle', mul: 2, detune: 5, gain: 0.26 },
                    { wave: 'triangle', mul: 3, detune: -6, gain: 0.16 }],
             filter: { type: 'lowpass', freq: 600, q: 3 }, lfo: { rate: 0.05, depth: 300 }, gain: 0.3 },
    crush: { curve: 'soft', drive: 2 },
    space: { seconds: 6.0, decay: 1.2 },
    break: { bpm: 90, hits: [
      { voice: 'low', steps: [0, 8], vel: 0.8 },
      { voice: 'mid', steps: [4, 12], vel: 0.4 },
      { voice: 'high', steps: [2, 6, 10, 14], vel: 0.25 },
    ] },
  },
  {
    id: 'chicago', city: 'Chicago', tag: 'footwork',
    notes: 'Long 808, triple clap, triplet rolls, hard clip.',
    names: { low: '808', mid: 'Clap', high: 'Hat', chop: 'Chop', roll: 'Triplet',
             bass: 'Boom bass', gate: 'Cut', drone: 'Stab', crush: 'Clip', space: 'Plate' },
    descs: { low: 'long 808 boom', mid: 'triple clap', high: 'tight hat',
             chop: 'juke slices', roll: 'triplet roll', bass: 'gliding 808 bass',
             gate: 'fast chop gate', drone: 'organ stab', crush: 'hard clip', space: 'short plate' },
    defaults: { low: [72, 0], mid: [65, 12], high: [58, 20], chop: [50, 28], roll: [40, 30],
                bass: [65, 10], gate: [35, 32], drone: [25, 20], crush: [35, 16], space: [20, 10] },
    swing: 0.08,
    voices: {
      low:  { engine: 'boom', wave: 'sine', f0: 90, f1: 38, drop: 0.16, decay: 0.9, click: 0.3, clickFreq: 2200 },
      mid:  { engine: 'noise', type: 'bandpass', freq: 1600, q: 1.1, decay: 0.13, taps: 3, spread: 0.009, gain: 0.6 },
      high: { engine: 'noise', type: 'highpass', freq: 9000, decay: 0.03, openDecay: 0.13, gain: 0.4 },
      bass: { wave: 'sine', cutoff: 260, glide: 2.2, gain: 1.1 },
    },
    weights: { low: [1, 0, 0.2, 0.4, 0, 0.2, 0.5, 0, 0.35, 0, 0.3, 0.4, 0, 0.35, 0.2, 0.25],
               mid: [0, 0, 0, 0.15, 1, 0, 0.2, 0.15, 0, 0.15, 0, 0.2, 1, 0, 0.2, 0.2],
               high: 0.9, open: 0.05 },
    bass: { root: 55, keys: [0, 0, 5, 3],
            pattern: [{ s: 0, n: 0, len: 3 }, { s: 5, n: 0, len: 2 }, { s: 8, n: 5, len: 3 }, { s: 13, n: 3, len: 2 }] },
    chop: { semis: [-12, -5, 0, 0, 0, 5, 12], reverse: 0.3, density: 0.6 },
    roll: { voice: 'mid', rise: 0.6, max: 24, chopChance: 0.25, steps: [12, 8, 4] },
    gate: { divisions: [6, 8, 12], windows: [2, 4] },
    drone: { oscs: [{ wave: 'sawtooth', mul: 2, detune: -5, gain: 0.24 },
                    { wave: 'square', mul: 3, detune: 6, gain: 0.16 },
                    { wave: 'sawtooth', mul: 1, detune: 0, gain: 0.3 }],
             filter: { type: 'lowpass', freq: 1200, q: 5 }, lfo: { rate: 0.3, depth: 700 }, gain: 0.22 },
    crush: { curve: 'hard', drive: 6 },
    space: { seconds: 1.6, decay: 3.0 },
    break: { bpm: 160, hits: [
      { voice: 'low', steps: [0, 3, 8, 11], vel: 0.95 },
      { voice: 'mid', steps: [4, 12], vel: 0.7 },
      { voice: 'high', steps: 'all', vel: 0.3 },
    ] },
  },
];

const kitById = Object.fromEntries(KITS.map((k) => [k.id, k]));
let kit = KITS[0];

// --- element state (roles carry the live fader values) -------------------------
const ELEMENTS = ROLES.map((r) => ({
  id: r.id, kind: r.kind, pans: r.pans,
  amount: 0, drift: 0, panWidth: 0, panRando: 0,
  subPage: 'drift',
}));
const byId = Object.fromEntries(ELEMENTS.map((e) => [e.id, e]));
const amt = (id) => byId[id].amount / 100;
const triggers = ELEMENTS.filter((e) => e.kind === 'trigger');
const levels = ELEMENTS.filter((e) => e.kind === 'level');

// --- drift: a smooth random walk per element -----------------------------------
// Drift only sets the SPEED — the excursion is fixed, so a slow drift and a fast
// drift cover the same ground at different paces, which is what "rate of change"
// should mean. The anchor is wherever you last dropped the fader.
const NOISE_LEN = 48;
const WANDER = 34;
const driftRate = (d) => (d <= 0 ? 0 : 0.012 + Math.pow(d / 100, 2) * 0.85);

for (const el of ELEMENTS) {
  el.anchor = 0;
  el.phase = Math.random() * NOISE_LEN;
  el.table = Float32Array.from({ length: NOISE_LEN + 1 }, () => Math.random() * 2 - 1);
  el.table[NOISE_LEN] = el.table[0];
}

function noiseAt(el, phase) {
  const p = ((phase % NOISE_LEN) + NOISE_LEN) % NOISE_LEN;
  const i = Math.floor(p);
  const f = p - i;
  const s = f * f * (3 - 2 * f);
  return el.table[i] * (1 - s) + el.table[i + 1] * s;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const midiRatio = (n) => Math.pow(2, n / 12);
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// --- the break -----------------------------------------------------------------
// One bar of each kit's own drums, rendered offline and then sliced live by CHOP.
// Kept forward and reversed, since half of breakcore is a slice played backwards.
const BREAK_STEPS = 16;
const breakCache = new Map();   // kit id → { fwd, rev, bpm }

async function renderBreak(k, sampleRate) {
  const stepDur = 60 / k.break.bpm / 4;
  const barDur = stepDur * BREAK_STEPS;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OfflineCtx(1, Math.ceil(sampleRate * (barDur + 0.4)), sampleRate);
  const bus = off.createGain();
  bus.gain.value = 0.85;
  bus.connect(off.destination);

  const at = (s) => 0.005 + s * stepDur;
  for (const hit of k.break.hits) {
    const steps = hit.steps === 'all' ? [...Array(BREAK_STEPS).keys()] : hit.steps;
    for (const s of steps) {
      const open = Array.isArray(hit.open) && hit.open.includes(s);
      const vel = hit.vel * (hit.steps === 'all' && s % 2 ? 0.7 : 1);
      playVoice(off, bus, at(s), k.voices[hit.voice], vel, hit.tune ?? 1, open);
    }
  }
  const rendered = await off.startRendering();
  const src = rendered.getChannelData(0);
  const revBuf = off.createBuffer(1, src.length, sampleRate);
  const dst = revBuf.getChannelData(0);
  for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
  breakCache.set(k.id, { fwd: rendered, rev: revBuf, bpm: k.break.bpm });
  return breakCache.get(k.id);
}

const breakPending = new Set();
function ensureBreak(k) {
  if (breakCache.has(k.id) || breakPending.has(k.id)) return;
  breakPending.add(k.id);
  renderBreak(k, ctx.sampleRate)
    .catch(() => { /* CHOP falls back to a plain hit */ })
    .finally(() => breakPending.delete(k.id));
}

// --- audio graph ---------------------------------------------------------------
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
// A backgrounded tab has its timers throttled to about once a second, which
// starves a 0.12s horizon and drops most of the bar (measured: 8 hits where 28
// belong). Layering runs in background tabs by design, so when hidden we hand
// the audio clock several seconds of work at a time and let it coast.
const SCHEDULE_AHEAD_HIDDEN = 2.5;
const FADE_SECONDS = 0.35;
const STALE_PAUSE_MS = 60_000;

let audio = makeUnlockableAudioContext();
let ctx = audio.ctx;
let mix = null;
let gate = null;
let crushDry = null, crushWet = null, crushPre = null, crushOut = null, shaper = null;
let verb = null, reverbSend = null, reverbOut = null;
let droneNodes = null;     // { oscs, filter, gain, lfo, lfoAmt }
let master = null, fade = null, streamEl = null;
let built = false;
let running = false;
let audioStale = false;
let stoppedAt = null;

function watchContext(c) {
  c.addEventListener('statechange', () => {
    if (c.state === 'suspended' || c.state === 'interrupted') audioStale = true;
  });
}
watchContext(ctx);

function impulseResponse(spec) {
  const { seconds = 2.0, decay = 2.6, spring = false } = spec;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    // A spring tank rings rather than washes: a few discrete reflections on top.
    if (spring) {
      for (let r = 1; r <= 5; r++) {
        const at = Math.floor(len * r * 0.055 * (1 + ch * 0.07));
        if (at < len) d[at] += (r % 2 ? 0.7 : -0.7) / r;
      }
    }
  }
  return buf;
}

// Build (or rebuild) the drone stack for the current kit. Crossfades so a kit
// change mid-performance does not click.
function buildDrone() {
  const spec = kit.drone;
  const filter = ctx.createBiquadFilter();
  filter.type = spec.filter.type;
  filter.frequency.value = spec.filter.freq;
  filter.Q.value = spec.filter.q;
  const gain = ctx.createGain();
  gain.gain.value = 0;   // applyLevels ramps it in
  // The drone never stops, so it cannot pan per hit like the voices do: it gets
  // one panner that sweeps across each bar instead (see scheduleStep).
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) filter.connect(gain).connect(pan).connect(mix);
  else filter.connect(gain).connect(mix);

  const lfo = ctx.createOscillator();
  lfo.frequency.value = spec.lfo.rate;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = spec.lfo.depth;
  lfo.connect(lfoAmt).connect(filter.frequency);
  lfo.start();

  const oscs = [];
  for (const o of spec.oscs) {
    const osc = ctx.createOscillator();
    osc.type = o.wave;
    osc.frequency.value = kit.bass.root * o.mul;
    osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.value = o.gain;
    osc.connect(g).connect(filter);
    osc.start();
    oscs.push({ osc, mul: o.mul });
  }

  const old = droneNodes;
  droneNodes = { oscs, filter, gain, pan, lfo, lfoAmt };
  if (old) {
    const now = ctx.currentTime;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setTargetAtTime(0, now, 0.04);
    for (const { osc } of old.oscs) { try { osc.stop(now + 0.3); } catch { /* */ } }
    try { old.lfo.stop(now + 0.3); } catch { /* */ }
  }
  applyLevels();
}

function buildGraph() {
  mix = ctx.createGain();
  mix.gain.value = 0.8;

  // CRUSH: a dry path and a driven path, crossfaded by the amount. The curve is
  // the kit's own — tape, fold, bits, hard clip.
  crushPre = ctx.createGain();
  shaper = ctx.createWaveShaper();
  shaper.curve = makeCurve(kit.crush.curve);
  shaper.oversample = '4x';
  crushDry = ctx.createGain();
  crushWet = ctx.createGain();
  crushOut = ctx.createGain();
  mix.connect(crushDry).connect(crushOut);
  mix.connect(crushPre).connect(shaper).connect(crushWet).connect(crushOut);

  // The gate sits downstream of the crush.
  gate = ctx.createGain();
  gate.gain.value = 1;
  crushOut.connect(gate);

  // SPACE is a send off the mix so the wash survives the gate.
  verb = ctx.createConvolver();
  verb.buffer = impulseResponse(kit.space);
  reverbSend = ctx.createGain();
  reverbSend.gain.value = 0;
  reverbOut = ctx.createGain();
  reverbOut.gain.value = 1;
  mix.connect(reverbSend).connect(verb).connect(reverbOut);

  droneNodes = null;
  buildDrone();

  // Output stage: compressor for glue, tanh shaper as the actual ceiling.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 8;
  comp.ratio.value = 10;
  comp.attack.value = 0.003;
  comp.release.value = 0.18;
  const ceiling = ctx.createWaveShaper();
  ceiling.curve = limitCurve();
  ceiling.oversample = '4x';
  gate.connect(comp);
  reverbOut.connect(comp);
  comp.connect(ceiling);

  master = ctx.createGain();
  master.gain.value = masterToGain(masterSlider.valueAsNumber);
  ceiling.connect(master);

  fade = ctx.createGain();
  fade.gain.value = 0;
  master.connect(fade);

  // Route through a MediaStream played by an <audio> element rather than
  // straight to ctx.destination: WebKit keeps a live stream rendering while the
  // tab is backgrounded, which is what keeps this from going silent on return.
  if (streamEl) { try { streamEl.pause(); } catch { /* */ } streamEl.remove(); }
  const streamDest = ctx.createMediaStreamDestination();
  fade.connect(streamDest);
  streamEl = new Audio();
  streamEl.srcObject = streamDest.stream;
  document.body.appendChild(streamEl);

  built = true;
  applyLevels(true);
}

function rebuildAudio() {
  const old = audio;
  audio = makeUnlockableAudioContext();
  ctx = audio.ctx;
  watchContext(ctx);
  built = false;
  droneNodes = null;
  buildGraph();
  try { old.ctx.close(); } catch { /* already closed */ }
}

// --- continuous levels ---------------------------------------------------------
const masterToGain = (v) => Math.pow(v / 100, 1.5);

function applyLevels(instant = false) {
  if (!built) return;
  const now = ctx.currentTime;
  const set = (param, v) => {
    if (instant) param.value = v;
    else param.setTargetAtTime(v, now, 0.05);
  };
  const crush = amt('crush');
  set(crushPre.gain, 1 + crush * kit.crush.drive);
  set(crushWet.gain, crush * 0.8);
  set(crushDry.gain, 1 - crush * 0.85);
  if (droneNodes) set(droneNodes.gain.gain, Math.pow(amt('drone'), 1.6) * kit.drone.gain);
  set(reverbSend.gain, Math.pow(amt('space'), 1.4) * 0.7);
}

// --- the scheduler -------------------------------------------------------------
let bpm = 140;
let step = 0;
let nextStepTime = 0;
let timer = null;
let stutterUntil = 0;
const drawQueue = [];

const stepDur = () => 60 / bpm / 4;

// --- panning -------------------------------------------------------------------
// PAN WIDTH is how much of the field a sound crosses over one bar: at 0 it sits
// dead center, at 100 it starts hard left on the downbeat and ends hard right.
// PAN RANDO throws each individual sounding somewhere else on top of that. Both
// together read as a sweep that never lands in quite the same place twice.
function panFor(el, stepPos) {
  const w = el.panWidth / 100;
  const r = el.panRando / 100;
  if (w <= 0 && r <= 0) return 0;
  const sweep = (stepPos / 16) * 2 - 1;               // -1 on the downbeat, +1 at the bar's end
  return clamp(w * sweep + r * (Math.random() * 2 - 1), -1, 1);
}

// A panner per sounding, since every hit lands somewhere different. Dead center
// returns the mix itself so the common case adds no node at all.
function panned(pan) {
  if (!pan || !ctx.createStereoPanner) return mix;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(mix);
  return p;
}

const panDest = (id, stepPos) => panned(panFor(byId[id], stepPos));

function chopSlice(t, vel, stepPos = 0) {
  const dest = panDest('chop', stepPos);
  const cached = breakCache.get(kit.id);
  if (!cached) { playVoice(ctx, dest, t, kit.voices.mid, vel * 0.7, 1.3); return; }
  const reversed = chance(kit.chop.reverse);
  const buf = reversed ? cached.rev : cached.fwd;
  const breakStep = 60 / cached.bpm / 4;
  const sliceDur = breakStep * (chance(0.25) ? 2 : 1);
  const idx = Math.floor(Math.random() * BREAK_STEPS);
  const rate = midiRatio(pick(kit.chop.semis)) * (bpm / cached.bpm);
  const offset = (idx * breakStep) % Math.max(0.05, buf.duration - sliceDur);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  const len = sliceDur / rate;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.002);
  g.gain.setValueAtTime(vel, t + Math.max(0.01, len - 0.012));
  g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.01);
  src.connect(g).connect(dest);
  src.start(t, offset, sliceDur + 0.02);
  src.stop(t + len + 0.03);
}

function scheduleRoll(t, amount, step0) {
  const spec = kit.roll;
  const dur = stepDur() * 4;                       // one beat of rush
  const n = Math.round(4 + amount * (spec.max - 4));
  for (let i = 0; i < n; i++) {
    const f = i / n;
    const eased = Math.pow(f, 1.3);                // accelerating
    const tt = t + dur * eased;
    const pos = step0 + 4 * eased;                 // where in the bar this hit lands
    if (chance(spec.chopChance) && breakCache.has(kit.id)) chopSlice(tt, 0.3 + 0.35 * f, pos);
    else playVoice(ctx, panDest('roll', pos), tt, kit.voices[spec.voice], 0.22 + 0.45 * f, 1 + spec.rise * f);
  }
}

function scheduleStutter(t, amount) {
  const window = stepDur() * pick(kit.gate.windows);   // windows are in 16th steps
  const divisions = pick(kit.gate.divisions) * (amount > 0.65 ? 2 : 1);
  const d = window / divisions;
  const g = gate.gain;
  g.cancelScheduledValues(t);
  for (let i = 0; i < divisions; i++) {
    const on = t + i * d;
    const off = on + d * 0.45;
    g.setValueAtTime(0, on);
    g.linearRampToValueAtTime(1, on + 0.0015);
    g.setValueAtTime(1, off);
    g.linearRampToValueAtTime(0, off + 0.0015);
  }
  g.setValueAtTime(0, t + window);
  g.linearRampToValueAtTime(1, t + window + 0.002);
  stutterUntil = t + window;
}

function scheduleStep(n, rawT) {
  const s = n % 16;
  const bar = Math.floor(n / 16);
  const keys = kit.bass.keys;
  const key = keys[bar % keys.length];
  const hits = {};
  // Swing pushes the off-16ths late; some kits lean, some are dead straight.
  const t = rawT + (s % 2 ? kit.swing * stepDur() : 0);

  const a = {
    low: amt('low'), mid: amt('mid'), high: amt('high'), chop: amt('chop'),
    roll: amt('roll'), bass: amt('bass'), gate: amt('gate'),
  };
  const w = kit.weights;

  if (s === 0 && droneNodes) {
    const root = kit.bass.root * midiRatio(key);
    for (const d of droneNodes.oscs) d.osc.frequency.setTargetAtTime(root * d.mul, t, 0.05);

    // One sweep per bar, offset somewhere new each time rando is up.
    if (droneNodes.pan) {
      const el = byId.drone;
      const width = el.panWidth / 100;
      const offset = (el.panRando / 100) * (Math.random() * 2 - 1);
      const p = droneNodes.pan.pan;
      p.cancelScheduledValues(t);
      p.setValueAtTime(clamp(-width + offset, -1, 1), t);
      p.linearRampToValueAtTime(clamp(width + offset, -1, 1), t + stepDur() * 16);
    }
  }

  if (a.low > 0.02 && (s === 0 && w.low[0] >= 1 ? a.low > 0.1 : chance(a.low * w.low[s]))) {
    playVoice(ctx, panDest('low', s), t, kit.voices.low, 0.55 + 0.45 * a.low);
    hits.low = 1;
  }
  if (a.mid > 0.02 && chance(a.mid * w.mid[s])) {
    const ghost = w.mid[s] < 0.5;
    playVoice(ctx, panDest('mid', s), t, kit.voices.mid,
      (ghost ? 0.3 : 0.75) * (0.5 + 0.5 * a.mid), ghost ? 1.15 : 1);
    hits.mid = 1;
  }
  if (a.high > 0.02 && chance(a.high * w.high)) {
    playVoice(ctx, panDest('high', s), t, kit.voices.high,
      (s % 2 === 0 ? 0.34 : 0.22) * (0.4 + 0.6 * a.high), 1, chance(w.open * a.high));
    hits.high = 1;
  }
  if (a.chop > 0.02 && chance(a.chop * kit.chop.density)) {
    chopSlice(t, 0.28 + 0.4 * a.chop, s);
    hits.chop = 1;
    if (a.chop > 0.6 && chance(a.chop - 0.55)) chopSlice(t + stepDur() * 0.5, 0.24 + 0.3 * a.chop, s + 0.5);
  }
  if (a.roll > 0.02 && kit.roll.steps.includes(s)
      && chance(a.roll * (s === kit.roll.steps[0] ? 0.75 : 0.25))) {
    scheduleRoll(t, a.roll, s);
    hits.roll = 1;
  }
  if (a.bass > 0.02) {
    const note = kit.bass.pattern.find((p) => p.s === s);
    if (note && chance(0.6 + 0.4 * a.bass)) {
      bassNote(ctx, panDest('bass', s), t, kit.voices.bass, note.len * stepDur() * 0.9,
        kit.bass.root * midiRatio(key + note.n), 0.55 + 0.45 * a.bass);
      hits.bass = 1;
    }
  }
  if (a.gate > 0.02 && t > stutterUntil && (s === 8 || s === 14 || s === 0)
      && chance(a.gate * 0.45)) {
    scheduleStutter(t, a.gate);
    hits.gate = 1;
  }

  // No point queueing a readout nobody can see: rAF is stopped while hidden, so
  // these would pile up unread and flood the LCD on return.
  if (document.visibilityState === 'visible') drawQueue.push({ t: rawT, step: s, bar, hits });
}

function scheduler() {
  const hidden = document.visibilityState === 'hidden';
  const ahead = hidden ? SCHEDULE_AHEAD_HIDDEN : SCHEDULE_AHEAD;

  // If the tab was frozen outright, the clock can be a long way past where we
  // left off. Skip forward onto the grid rather than dumping every missed step
  // at once, which would come back as a burst of machine-gun fire.
  if (nextStepTime < ctx.currentTime - 0.25) {
    const missed = Math.ceil((ctx.currentTime - nextStepTime) / stepDur());
    step += missed;
    nextStepTime += missed * stepDur();
  }

  while (nextStepTime < ctx.currentTime + ahead) {
    scheduleStep(step, nextStepTime);
    nextStepTime += stepDur();
    step++;
  }
}

// --- UI ------------------------------------------------------------------------
const stripsEl = document.getElementById('strips');
const matrixEl = document.getElementById('matrix');
const metersEl = document.getElementById('meters');
const railEl = document.getElementById('kit-rail');
const kitNowEl = document.getElementById('kit-now');
const modelEl = document.getElementById('model');
const lcdEl = document.getElementById('lcd');
const lcdState = document.getElementById('lcd-state');
const lcdBar = document.getElementById('lcd-bar');
const runBtn = document.getElementById('run');
const runLabel = document.getElementById('run-label');
const bpmSlider = document.getElementById('bpm');
const bpmVal = document.getElementById('bpm-val');
const masterSlider = document.getElementById('master');
const masterVal = document.getElementById('master-val');

// kit rail
railEl.innerHTML = KITS.map((k) => `
  <button class="kit" type="button" role="radio" aria-checked="false" data-kit="${k.id}">
    <span class="led" aria-hidden="true"></span>
    <span>
      <span class="kit__city">${k.city}</span>
      <span class="kit__tag">${k.tag}</span>
    </span>
  </button>
`).join('');

// the guide's kit table — same data as the rail, so the two cannot drift apart
const kitTableEl = document.getElementById('kit-table');
kitTableEl.innerHTML = KITS.map((k) => `
  <tr data-kit="${k.id}" tabindex="0" aria-current="false">
    <th scope="row">
      <span class="kit-table__city">${k.city}</span>
      <span class="kit-table__tag">${k.tag}</span>
    </th>
    <td>${k.notes}</td>
  </tr>
`).join('');

// channel strips
stripsEl.innerHTML = ELEMENTS.map((el, i) => `
  <section class="panel strip" id="strip-${el.id}">
    <div class="strip__head">
      <span class="strip__ch">CH ${String(i + 1).padStart(2, '0')}</span>
      <span class="strip__name" id="${el.id}-name"></span>
      <span class="strip__desc" id="${el.id}-desc"></span>
    </div>
    <div class="ctl">
      <div class="ctl__row">
        <span class="ctl__label">Amount</span>
        <span class="ctl__val" id="${el.id}-amount-val">0</span>
      </div>
      <input type="range" class="fader--amount" min="0" max="100" value="0"
             id="${el.id}-amount" aria-label="Amount" />
    </div>
    <div class="ctl ctl--sub">
      <div class="ctl__row">
        <span class="drift-led" aria-hidden="true"></span>
        ${el.pans ? `<div class="pager" id="${el.id}-pager">${SUB_PAGES.map((p) => `
          <button class="pager__btn${p.id === 'drift' ? ' on' : ''}" type="button"
                  data-page="${p.id}" aria-pressed="${p.id === 'drift'}">${p.label}</button>`).join('')}
        </div>` : '<span class="ctl__label">Drift</span>'}
        <span class="ctl__val" id="${el.id}-sub-val">0</span>
      </div>
      <input type="range" class="fader--trim" min="0" max="100" value="0"
             id="${el.id}-sub" aria-label="Drift rate" />
    </div>
  </section>
`).join('');

// pattern readout
matrixEl.innerHTML = triggers.map((el) => `
  <div class="matrix">
    <span class="matrix__label" id="code-${el.id}"></span>
    <div class="matrix__row" id="row-${el.id}">
      ${Array.from({ length: 16 }, (_, s) =>
        `<span class="cell${s % 4 === 0 ? ' beat' : ''}"></span>`).join('')}
    </div>
  </div>
`).join('');

metersEl.innerHTML = levels.map((el) => `
  <div class="meters">
    <span class="matrix__label" id="code-${el.id}"></span>
    <div class="meter"><i id="meter-${el.id}"></i></div>
  </div>
`).join('');

const rows = Object.fromEntries(triggers.map((el) => [
  el.id,
  { cells: Array.from(document.getElementById(`row-${el.id}`).children), level: new Float32Array(16) },
]));
const meterEls = Object.fromEntries(levels.map((el) => [el.id, document.getElementById(`meter-${el.id}`)]));
let headCells = [];

for (const el of ELEMENTS) {
  el.ui = {
    amountEl: document.getElementById(`${el.id}-amount`),
    subEl: document.getElementById(`${el.id}-sub`),
    amountValEl: document.getElementById(`${el.id}-amount-val`),
    subValEl: document.getElementById(`${el.id}-sub-val`),
    pager: document.getElementById(`${el.id}-pager`),
    nameEl: document.getElementById(`${el.id}-name`),
    descEl: document.getElementById(`${el.id}-desc`),
    codeEl: document.getElementById(`code-${el.id}`),
    strip: document.getElementById(`strip-${el.id}`),
    led: document.querySelector(`#strip-${el.id} .drift-led`),
  };

  el.ui.amountEl.addEventListener('input', () => {
    const v = el.ui.amountEl.valueAsNumber;
    el.amount = v;
    // Re-anchor so the walk carries on from where you dropped the fader.
    el.anchor = clamp(v - WANDER * noiseAt(el, el.phase), -WANDER, 100 + WANDER);
    el.ui.amountValEl.textContent = String(Math.round(v));
    applyLevels();
    persistSettings();
  });

  // One fader, three parameters: it writes to whichever page is showing.
  el.ui.subEl.addEventListener('input', () => {
    const v = el.ui.subEl.valueAsNumber;
    const field = pageOf(el.subPage).field;
    el[field] = v;
    el.ui.subValEl.textContent = String(Math.round(v));
    if (field === 'drift') setLed(el, v);
    persistSettings();
  });

  if (el.ui.pager) {
    el.ui.pager.addEventListener('click', (e) => {
      const btn = e.target.closest('.pager__btn');
      if (!btn) return;
      showSubPage(el, btn.dataset.page);
      persistSettings();
    });
  }
}

// Swap which parameter the sub fader is holding, without touching any value.
function showSubPage(el, id) {
  const page = pageOf(id);
  el.subPage = page.id;
  const v = Math.round(el[page.field]);
  el.ui.subEl.value = String(v);
  el.ui.subValEl.textContent = String(v);
  el.ui.subEl.setAttribute('aria-label', `${kit.names[el.id]} ${page.aria}`);
  if (!el.ui.pager) return;
  for (const b of el.ui.pager.querySelectorAll('.pager__btn')) {
    const on = b.dataset.page === page.id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

// Set one of the sub fader's parameters from code (kit defaults, presets); the
// fader itself only moves if that parameter is the one on show.
function setSub(el, field, value) {
  el[field] = clamp(Math.round(Number(value)), 0, 100);
  if (field === 'drift') setLed(el, el.drift);
  if (pageOf(el.subPage).field === field) {
    el.ui.subEl.value = String(el[field]);
    el.ui.subValEl.textContent = String(el[field]);
  }
}

// The LED blinks at the drift rate, so the speed you dialed in is legible before
// the fader has moved far enough to see.
function setLed(el, v) {
  el.ui.strip.classList.toggle('drifting', v > 0);
  if (v > 0) el.ui.led.style.animationDuration = `${clamp(1.6 / (0.25 + v / 60), 0.16, 2.4).toFixed(2)}s`;
}

bpmSlider.addEventListener('input', () => {
  bpm = bpmSlider.valueAsNumber;
  bpmVal.textContent = String(bpm);
  persistSettings();
});
const BPM_MIN = 20;
const BPM_MAX = 300;
const nudgeBpm = (d) => {
  bpmSlider.value = clamp(bpmSlider.valueAsNumber + d, BPM_MIN, BPM_MAX);
  bpmSlider.dispatchEvent(new Event('input', { bubbles: true }));
};
document.getElementById('bpm-down').addEventListener('click', () => nudgeBpm(-1));
document.getElementById('bpm-up').addEventListener('click', () => nudgeBpm(1));

masterSlider.addEventListener('input', () => {
  const v = masterSlider.valueAsNumber;
  masterVal.textContent = `${v}%`;
  if (built) master.gain.setTargetAtTime(masterToGain(v), ctx.currentTime, 0.03);
  persistSettings();
});

// --- kits: labels, defaults, switching -----------------------------------------
// LCD labels are squeezed the way hardware panels do it — whole word when it
// fits, vowels dropped when it doesn't (STUTTER → STTR), so they read as
// abbreviations rather than as truncations.
function shortCode(name) {
  const word = name.includes(' ') ? name.split(' ')[0] : name;
  const clean = word.replace(/[^a-z0-9]/gi, '');
  if (clean.length <= 5) return clean.toUpperCase();
  const squeezed = (clean[0] + clean.slice(1).replace(/[aeiou]/gi, '')).replace(/(.)\1+/g, '$1');
  return (squeezed.length >= 4 ? squeezed.slice(0, 5) : clean.slice(0, 4)).toUpperCase();
}

function labelKit() {
  kitNowEl.textContent = kit.city;
  updateTitle();
  for (const el of ELEMENTS) {
    const name = kit.names[el.id];
    el.ui.nameEl.textContent = name;
    el.ui.descEl.textContent = kit.descs[el.id];
    el.ui.amountEl.setAttribute('aria-label', `${name} amount`);
    el.ui.subEl.setAttribute('aria-label', `${name} ${pageOf(el.subPage).aria}`);
    el.ui.codeEl.textContent = shortCode(name);
  }
  for (const chip of railEl.children) {
    const on = chip.dataset.kit === kit.id;
    chip.setAttribute('aria-checked', on ? 'true' : 'false');
    chip.setAttribute('tabindex', on ? '0' : '-1');
  }
  for (const row of kitTableEl.children) {
    row.setAttribute('aria-current', row.dataset.kit === kit.id ? 'true' : 'false');
  }
}

function loadKitDefaults() {
  for (const el of ELEMENTS) {
    const [amount, drift, width = 0, rando = 0] = kit.defaults[el.id];
    setSlider(el.ui.amountEl, amount);
    setSub(el, 'drift', drift);
    setSub(el, 'panWidth', width);
    setSub(el, 'panRando', rando);
  }
}

// Switching swaps the whole palette live and keeps your fader positions, so a
// kit change is a performance move rather than a reset.
function selectKit(id, { defaults = false } = {}) {
  const next = kitById[id];
  if (!next) return;
  kit = next;
  labelKit();
  if (defaults) loadKitDefaults();
  if (built) {
    shaper.curve = makeCurve(kit.crush.curve);
    verb.buffer = impulseResponse(kit.space);
    buildDrone();
    applyLevels();
  }
  ensureBreak(kit);
  const chip = railEl.querySelector(`[data-kit="${id}"]`);
  if (chip) chip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  persistSettings();
}

railEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.kit');
  if (chip) selectKit(chip.dataset.kit);
});
// Arrow keys walk the rail, the way a radio group should.
railEl.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  const i = KITS.findIndex((k) => k.id === kit.id);
  const next = KITS[(i + (e.key === 'ArrowRight' ? 1 : KITS.length - 1)) % KITS.length];
  selectKit(next.id);
  railEl.querySelector(`[data-kit="${next.id}"]`)?.focus();
});
// Picking a kit from the guide selects it and gets out of the way, so you hear
// the change instead of reading about it.
kitTableEl.addEventListener('click', (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  selectKit(row.dataset.kit);
  closeMenu();
});
kitTableEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('tr');
  if (!row) return;
  e.preventDefault();
  selectKit(row.dataset.kit);
  closeMenu();
});

document.getElementById('kit-defaults').addEventListener('click', (e) => {
  if (e.detail > 0) e.currentTarget.blur();
  loadKitDefaults();
  showToast(`${kit.city} defaults loaded`);
});

// --- the guide sheet -----------------------------------------------------------
const menuBtn = document.getElementById('menu-btn');
const scrim = document.getElementById('scrim');
let menuOpen = false;

function openMenu() {
  menuOpen = true;
  scrim.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
  document.getElementById('close-btn').focus();
}
function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  scrim.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.focus();
}
menuBtn.addEventListener('click', openMenu);
document.getElementById('close-btn').addEventListener('click', closeMenu);
// A real modal, as the sheet's own aria-modal already claims: the backdrop does
// not dismiss, it only swallows the press so a tap that misses the sheet can't
// reach the machine behind it. The way out is the ✕ or Escape. Tap-outside used
// to close it, but a press that starts on the sheet and drifts off it — sweeping
// a fader, dragging across the guide text — releases over the backdrop, and the
// browser delivers that click to the nearest ancestor of press and release, the
// scrim, which read as a tap outside and dismissed the sheet mid-gesture.
scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) e.preventDefault(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// --- transport -----------------------------------------------------------------
async function toggleRun() {
  if (!running) {
    if (stoppedAt != null && performance.now() - stoppedAt > STALE_PAUSE_MS) audioStale = true;
    if (audioStale) { rebuildAudio(); audioStale = false; }
    else if (!built) buildGraph();
    stoppedAt = null;

    audio.unlock();
    if (streamEl) streamEl.play().catch(() => { /* best effort */ });
    fade.gain.cancelScheduledValues(ctx.currentTime);
    fade.gain.setTargetAtTime(1, ctx.currentTime, FADE_SECONDS / 3);
    nextStepTime = ctx.currentTime + 0.06;
    step = 0;
    stutterUntil = 0;
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    running = true;
    runBtn.classList.add('on');
    runBtn.setAttribute('aria-pressed', 'true');
    runLabel.textContent = 'Stop';
    lcdState.textContent = 'running';
    lcdEl.classList.remove('dark');
    updateTitle();
  } else {
    fade.gain.cancelScheduledValues(ctx.currentTime);
    fade.gain.setTargetAtTime(0, ctx.currentTime, FADE_SECONDS / 4);
    clearInterval(timer); timer = null;
    drawQueue.length = 0;
    stoppedAt = performance.now();
    running = false;
    runBtn.classList.remove('on');
    runBtn.setAttribute('aria-pressed', 'false');
    runLabel.textContent = 'Start';
    lcdState.textContent = 'stopped';
    lcdEl.classList.add('dark');
    updateTitle();
    for (const c of headCells) c.classList.remove('playhead');
    headCells = [];
  }
}

// pointerup completes the gesture — the reliable moment to start audio on iOS.
runBtn.addEventListener('pointerup', toggleRun);
runBtn.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleRun(); }
});
window.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || menuOpen) return;
  if (e.target instanceof Element && e.target.closest('a, button, input')) return;
  e.preventDefault();
  toggleRun();
});

// --- the frame loop: drift the faders, draw the readout ------------------------
let lastFrame = performance.now();

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  let levelChanged = false;
  for (const el of ELEMENTS) {
    if (el.drift <= 0) continue;
    el.phase += driftRate(el.drift) * dt;
    const v = clamp(el.anchor + WANDER * noiseAt(el, el.phase), 0, 100);
    if (Math.abs(v - el.amount) > 0.05) {
      el.amount = v;
      el.ui.amountEl.value = String(Math.round(v));
      el.ui.amountValEl.textContent = String(Math.round(v));
      if (el.kind === 'level') levelChanged = true;
    }
  }
  if (levelChanged) applyLevels();

  while (drawQueue.length && drawQueue[0].t <= ctx.currentTime) {
    const ev = drawQueue.shift();
    for (const id of Object.keys(ev.hits)) {
      if (rows[id]) rows[id].level[ev.step] = 1;
    }
    // the playhead is the whole column, so it reads across every row
    for (const c of headCells) c.classList.remove('playhead');
    headCells = triggers.map((el) => rows[el.id].cells[ev.step]);
    for (const c of headCells) c.classList.add('playhead');
    lcdBar.textContent = `bar ${ev.bar + 1}`;
  }

  // Decay the lit cells. The rate follows the tempo so a hit fades over exactly
  // one beat: any cell still dark is something you are hearing right now, not a
  // souvenir of the last bar (a fixed rate made the grid read a bar behind).
  const decay = bpm / 60;
  for (const id of Object.keys(rows)) {
    const { cells, level } = rows[id];
    for (let s = 0; s < 16; s++) {
      if (level[s] <= 0) continue;
      level[s] = Math.max(0, level[s] - dt * decay);
      const base = s % 4 === 0 ? 0.30 : 0.16;         // matches .cell / .cell.beat
      cells[s].style.background = `rgba(23,29,7,${(base + (1 - base) * level[s]).toFixed(3)})`;
      if (level[s] === 0) cells[s].style.background = '';
    }
  }

  for (const el of levels) meterEls[el.id].style.width = `${el.amount}%`;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- self-heal after the browser idles the audio -------------------------------
let resyncing = false;
async function resyncPlayback() {
  if (!running || !built || resyncing || !audioStale) return;
  resyncing = true;
  try {
    const alive = ctx.state === 'running' && streamEl && !streamEl.paused;
    if (alive) { audioStale = false; return; }
    clearInterval(timer);
    rebuildAudio();
    await audio.unlock();
    if (streamEl) streamEl.play().catch(() => {});
    fade.gain.value = 1;
    nextStepTime = ctx.currentTime + 0.06;
    step = 0;
    stutterUntil = 0;
    drawQueue.length = 0;
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    if (ctx.state === 'running') audioStale = false;
  } finally {
    resyncing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (built) audioStale = true; }
  else resyncPlayback();
});
window.addEventListener('focus', () => resyncPlayback());

// --- save / load ---------------------------------------------------------------
// Two paths, same as the other apps here: a JSON file you can keep, and a
// localStorage mirror so a reload lands you back where you were.
const STORAGE_KEY = 'burnt-crust:settings';   // the last setup you touched
const LIVE_KEY = 'burnt-crust:live';          // which layers are open right now

// --- layers: one machine per tab -----------------------------------------------
// Running several of these at once is the point: each tab is its own machine on
// its own clock, so they slide against each other instead of locking up. That
// only works if the tabs stop fighting over one saved state, so a tab's live
// settings go to sessionStorage (private to that tab) and localStorage keeps
// only the last setup, which seeds the first layer opened.
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const BEAT_MS = 2000;
const STALE_MS = 6500;
let layerNo = 1;

function readLive() {
  try {
    const all = JSON.parse(localStorage.getItem(LIVE_KEY) || '{}');
    const now = Date.now();
    const live = {};
    for (const [id, e] of Object.entries(all)) {
      if (e && now - e.t < STALE_MS) live[id] = e;   // drop tabs that stopped beating
    }
    return live;
  } catch { return {}; }
}
function writeLive(live) {
  try { localStorage.setItem(LIVE_KEY, JSON.stringify(live)); } catch { /* non-fatal */ }
}

// Take the lowest layer number nobody else is using, and keep it for this tab.
function claimLayer() {
  const live = readLive();
  const others = Object.keys(live).length;
  const taken = new Set(Object.values(live).map((e) => e.n));
  layerNo = 1;
  while (taken.has(layerNo)) layerNo++;
  live[TAB_ID] = { t: Date.now(), n: layerNo };
  writeLive(live);
  showLayers(Object.keys(live).length);
  return others;
}

function beat() {
  const live = readLive();
  live[TAB_ID] = { t: Date.now(), n: layerNo };
  writeLive(live);
  showLayers(Object.keys(live).length);
}

function showLayers(count) {
  modelEl.textContent = count > 1 ? `BC-10 · LAYER ${layerNo} / ${count}` : 'BC-10';
  updateTitle(count);
}

// The tab title is how you tell layers apart in the tab bar.
function updateTitle(count = Object.keys(readLive()).length) {
  const mark = running ? '▶ ' : '';
  const layer = count > 1 ? ` (layer ${layerNo})` : '';
  document.title = `${mark}${kit.city} · Burnt Crust${layer}`;
}

setInterval(beat, BEAT_MS);
// localStorage changes fire here in the OTHER tabs, so the count reacts at once
// when a layer opens or closes rather than waiting for the next beat.
window.addEventListener('storage', (e) => {
  if (e.key === LIVE_KEY) showLayers(Object.keys(readLive()).length);
});
window.addEventListener('pagehide', () => {
  const live = readLive();
  delete live[TAB_ID];
  writeLive(live);
});

function currentSettings() {
  const elements = {};
  for (const el of ELEMENTS) {
    elements[el.id] = {
      amount: Math.round(el.amount), drift: el.drift,
      panWidth: el.panWidth, panRando: el.panRando, page: el.subPage,
    };
  }
  return {
    app: 'burnt-crust',
    version: 3,
    kit: kit.id,
    bpm: bpmSlider.valueAsNumber,
    master: masterSlider.valueAsNumber,
    elements,
  };
}

// Boot seeds the faders with kit defaults, which fires the same input handlers a
// drag does — so persistence stays shut until boot is done, or those defaults
// would overwrite the saved state before it has been read back.
let booting = true;

function persistSettings() {
  if (booting) return;
  const json = JSON.stringify(currentSettings());
  // sessionStorage is this tab's own memory: a reload comes back exactly as you
  // left it, and the layer in the next tab is left alone.
  try { sessionStorage.setItem(STORAGE_KEY, json); } catch { /* non-fatal */ }
  try { localStorage.setItem(STORAGE_KEY, json); } catch { /* non-fatal */ }
}

// Push values through the sliders' own input handlers so the model, the
// readouts, and the live audio all update exactly as if you had dragged them.
function setSlider(el, value, lo = 0, hi = 100) {
  el.value = String(clamp(Math.round(Number(value)), lo, hi));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function applySettings(state) {
  if (!state || typeof state !== 'object' || !state.elements) throw new Error('unrecognized');
  let applied = false;
  if (state.kit && kitById[state.kit]) { selectKit(state.kit); applied = true; }
  if (state.bpm != null) { setSlider(bpmSlider, state.bpm, BPM_MIN, BPM_MAX); applied = true; }
  if (state.master != null) { setSlider(masterSlider, state.master); applied = true; }
  for (const el of ELEMENTS) {
    const s = state.elements[el.id];
    if (!s) continue;
    if (s.amount != null) { setSlider(el.ui.amountEl, s.amount); applied = true; }
    if (s.drift != null) { setSub(el, 'drift', s.drift); applied = true; }
    // Presets written before pan existed carry none, so read them as centered.
    setSub(el, 'panWidth', s.panWidth ?? 0);
    setSub(el, 'panRando', s.panRando ?? 0);
    if (el.pans && s.page) showSubPage(el, s.page);
  }
  if (!applied) throw new Error('nothing to apply');
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
    a.download = `burnt-crust-${kit.id}-${fileStamp()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Settings saved');
  } catch {
    showToast('Could not save');
  }
}

function handleStateFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { applySettings(JSON.parse(reader.result)); showToast('Settings loaded'); }
    catch { showToast('That file is not a Burnt Crust preset'); }
  };
  reader.onerror = () => showToast('Could not read that file');
  reader.readAsText(file);
  e.target.value = '';
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// Open another machine in a new tab, already on the next kit so the layer you
// add is a different sound rather than the same one twice.
document.getElementById('new-layer').addEventListener('click', (e) => {
  if (e.detail > 0) e.currentTarget.blur();
  const next = KITS[(KITS.findIndex((k) => k.id === kit.id) + 1) % KITS.length];
  const url = new URL(location.href);
  url.searchParams.set('kit', next.id);
  url.searchParams.set('fresh', '1');   // do not inherit this tab's panel
  const tab = window.open(url.toString(), '_blank');
  showToast(tab ? `Layer opened on ${next.city}` : 'Allow pop-ups to open a layer');
});

document.getElementById('saveState').addEventListener('click', (e) => {
  if (e.detail > 0) e.currentTarget.blur();   // keep Space on the transport
  saveState();
});
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'application/json,.json';
fileInput.style.display = 'none';
fileInput.addEventListener('change', handleStateFile);
document.body.appendChild(fileInput);
document.getElementById('loadState').addEventListener('click', (e) => {
  if (e.detail > 0) e.currentTarget.blur();
  fileInput.click();
});

// --- boot ----------------------------------------------------------------------
labelKit();
loadKitDefaults();

function restoreState(otherLayers) {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('kit');
  // A tab opened from another one inherits a COPY of its sessionStorage, so a
  // new layer would otherwise come up wearing the panel of the tab that opened
  // it. + Layer marks the tab it opens as fresh, and we clear that inheritance.
  const fresh = params.get('fresh') === '1';
  if (fresh) { try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* blocked */ } }

  let own = null;
  if (!fresh) { try { own = sessionStorage.getItem(STORAGE_KEY); } catch { /* blocked */ } }
  if (own) {
    try {
      applySettings(JSON.parse(own));
      if (wanted && kitById[wanted]) selectKit(wanted);   // a link still picks the kit
      return;
    } catch { /* corrupt — fall through to the defaults below */ }
  }
  if (wanted && kitById[wanted]) { selectKit(wanted, { defaults: true }); return; }
  // Layers after the first start on their kit's defaults rather than inheriting
  // the other tab's panel, so a new layer sounds like something new.
  if (otherLayers > 0) return;
  let last = null;
  try { last = localStorage.getItem(STORAGE_KEY); } catch { /* blocked */ }
  if (!last) return;
  try { applySettings(JSON.parse(last)); } catch { /* stale or corrupt — ignore */ }
}
restoreState(claimLayer());
// The query is a launch instruction, not state: drop it so a later reload comes
// back to what this tab is now, rather than to how it was opened.
if (location.search) history.replaceState(null, '', location.pathname);
booting = false;

// Render the current kit's break now; the rest fill in behind it so switching is
// instant, and CHOP falls back to a plain hit for any kit not yet rendered.
ensureBreak(kit);
setTimeout(() => { for (const k of KITS) ensureBreak(k); }, 400);
