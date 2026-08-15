// Object Tile Scroll — the voices.
//
// There is no band here and no beat. Every object on screen carries a small
// continuous soundscape of its own, and the mix is the picture: an object's pan
// is where it stands across the frame, and its level is how far up the frame it
// has got, loudest through the middle and gone by the time the last of it has
// left the top. Twenty things standing in a field is therefore twenty voices,
// and what you hear is a chord that reshuffles itself as the field rises.
//
// The pitches come out of one pentatonic set spanning four octaves, so any
// handful of them sounds consonant against any other — the field can deal
// itself whatever it likes and never deal a wrong note. Bigger objects are
// pitched lower, which is the one rule tying what you hear to what you see.
//
// Nothing is built until the header slider is moved. An app that opens silent
// from a gallery index should also open with no audio graph running at all.

// --- iOS-reliable AudioContext ------------------------------------------------
// Same shape as the other noisy apps in the repo: playback session, retried
// resume(), and auto re-resume after an interruption. Start has to come from a
// gesture that FINISHED — a pointerdown that might still become a scroll does
// not count on iOS.
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
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* < iOS 16.4 */ }
  return { ctx, unlock: resume };
}

let ctx = null;
let bus = null;      // everything the objects make
let volume = null;   // the header slider, kept apart from the mix
let mute = null;     // and this apart from BOTH, so it can be taken away and given back
let outLevel = 0;
let muted = false;

/** Build the graph and unlock it. Safe to call repeatedly. */
export function startAudio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const a = makeUnlockableAudioContext();
    ctx = a.ctx;

    bus = ctx.createGain();
    bus.gain.value = 0.9;

    // Twenty voices arriving and leaving on their own schedules will otherwise
    // pile up at the loud end whenever the field happens to fill the middle of
    // the frame. A gentle limiter holds the ceiling without audibly ducking.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 20;
    comp.ratio.value = 5;
    comp.attack.value = 0.01;
    comp.release.value = 0.28;

    volume = ctx.createGain();
    volume.gain.value = outLevel;

    // Its own node rather than a second thing writing to the volume gain: the
    // slider's level and "the room has the floor" are two facts, and one node
    // holding both means whichever was set last wins and the other is lost.
    mute = ctx.createGain();
    mute.gain.value = muted ? 0 : 1;

    bus.connect(comp).connect(volume).connect(mute).connect(ctx.destination);
    a.unlock();
  } else if (ctx.state !== 'running') {
    ctx.resume().catch(() => {});
  }
}

/** Header slider, 0..1. Safe before the graph exists. */
export function setVolume(v) {
  outLevel = Math.max(0, Math.min(1, v));
  if (!ctx) return;
  volume.gain.cancelScheduledValues(ctx.currentTime);
  volume.gain.setTargetAtTime(outLevel, ctx.currentTime, 0.03);
}

/**
 * Take the sound away without touching the slider, and give it back exactly as
 * it was. Used while the microphone is open: the voices are a continuous drone
 * across the whole field, and a beat tracker listening to a room that the piece
 * itself is droning into is partly listening to the piece.
 */
export function setMuted(on) {
  muted = !!on;
  if (!ctx) return;
  mute.gain.cancelScheduledValues(ctx.currentTime);
  mute.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.08);
}

/**
 * True when there is a running graph worth hanging a voice on. Muted counts as
 * live: the voices go on being built and mixed, silently, so the field is
 * already singing the picture that is up when the sound comes back rather than
 * fading two dozen things in from nothing.
 */
export function audioLive() {
  return !!ctx && ctx.state === 'running' && outLevel > 0;
}

export function audioContext() { return ctx; }

// --- the note pool -------------------------------------------------------------
// A minor pentatonic, four octaves of it. No interval in the set can sound
// wrong against another, so the field is free to pick at random forever.
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const DEGREES = [0, 3, 5, 7, 10];
const NOTES = [];
for (let oct = 2; oct <= 6; oct++) {
  for (const d of DEGREES) NOTES.push(mtof(12 * oct + d - 3)); // A minor
}
NOTES.sort((a, b) => a - b);

/**
 * A pitch for an object, low for a big one and high for a small one, with a
 * little slack so two objects of the same size are not forced onto one note.
 * `size` is 0..1, `r` a 0..1 random.
 */
export function pitchFor(size, r) {
  const span = NOTES.length - 1;
  const i = Math.round(span * (1 - Math.min(1, Math.max(0, size))) * 0.82 + (r - 0.5) * 5);
  return NOTES[Math.min(span, Math.max(0, i))];
}

// --- shared noise --------------------------------------------------------------
let noise = null;
function noiseBuffer() {
  if (!noise) {
    const n = Math.floor(ctx.sampleRate * 2.5);
    noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
}

function lfo(rate, depth, target, phase = 0) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g).connect(target);
  // An oscillator's phase cannot be set, so it is dialed in by starting late.
  o.start(ctx.currentTime + (phase % 1) / rate);
  return o;
}

// --- the four timbres ----------------------------------------------------------
// Each returns the node its sound comes out of, plus everything that has to be
// stopped when the object leaves. They all run continuously: an object's level
// is decided entirely by where it is on screen, so a voice never needs an
// envelope of its own.

/** Chairs: warm, woody, breathing. Two detuned triangles under a slow tremolo. */
function wood(freq, seed) {
  const out = ctx.createGain();
  out.gain.value = 0.30;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(5200, freq * 5.5);
  lp.Q.value = 0.9;
  const trem = ctx.createGain();
  trem.gain.value = 0.72;
  lp.connect(trem).connect(out);

  const osc = [];
  for (const cents of [-6, 7]) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    o.detune.value = cents;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    o.connect(g).connect(lp);
    o.start();
    osc.push(o);
  }
  osc.push(lfo(0.11 + seed * 0.3, 0.26, trem.gain, seed));
  return { out, osc };
}

/** The iron: steam. Band-passed noise wandering, over a low mains hum. */
function steam(freq, seed) {
  const out = ctx.createGain();
  out.gain.value = 0.22;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900 + seed * 1500;
  bp.Q.value = 2.2;
  const hiss = ctx.createGain();
  hiss.gain.value = 0.55;
  src.connect(bp).connect(hiss).connect(out);
  src.start();

  const hum = ctx.createOscillator();
  hum.type = 'sine';
  hum.frequency.value = freq * 0.5;
  const hg = ctx.createGain();
  hg.gain.value = 0.16;
  hum.connect(hg).connect(out);
  hum.start();

  return {
    out,
    osc: [hum, lfo(0.07 + seed * 0.14, 380, bp.frequency, seed), lfo(0.19, 0.22, hiss.gain, seed * 0.5)],
    src: [src],
  };
}

/** The dumbbell: heavy. A low fundamental with two inharmonic partials on top. */
function ring(freq, seed) {
  const out = ctx.createGain();
  out.gain.value = 0.26;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  lp.connect(out);

  const base = freq * 0.5;
  const osc = [];
  for (const [mult, level] of [[1, 1], [2.76, 0.10], [5.41, 0.05]]) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = base * mult;
    const g = ctx.createGain();
    g.gain.value = level * 0.5;
    o.connect(g).connect(lp);
    o.start();
    osc.push(o);
  }
  // A very slow swell, so a field of these never settles into a flat pad.
  osc.push(lfo(0.045 + seed * 0.05, 0.08, out.gain, seed));
  return { out, osc };
}

/** The desk lamp: electric. A narrow saw hum with a faint whine over it. */
function hum(freq, seed) {
  const out = ctx.createGain();
  out.gain.value = 0.17;

  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = freq * 0.5;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq * 2;
  bp.Q.value = 7;
  const sg = ctx.createGain();
  sg.gain.value = 0.85;
  saw.connect(bp).connect(sg).connect(out);
  saw.start();

  const whine = ctx.createOscillator();
  whine.type = 'sine';
  whine.frequency.value = freq * 4;
  const wg = ctx.createGain();
  wg.gain.value = 0.05;
  whine.connect(wg).connect(out);
  whine.start();

  return { out, osc: [saw, whine, lfo(0.13 + seed * 0.2, 0.035, wg.gain, seed), lfo(2.9, 0.05, sg.gain, seed)] };
}

const TIMBRES = { wood, steam, ring, hum };

// --- voices --------------------------------------------------------------------
// One per object on screen. The cap is a backstop for a very wide window at the
// tightest spacing; in the ordinary case every object in view gets one.
const MAX_VOICES = 40;
let live = 0;

/**
 * Hang a voice on an object. Returns null if there is no graph or no room, and
 * the caller is expected to cope — an object without a voice is simply silent.
 */
export function makeVoice(timbre, freq, seed) {
  if (!audioLive() || live >= MAX_VOICES) return null;
  const build = TIMBRES[timbre] || wood;
  const parts = build(freq, seed);

  // The mix node. It starts at silence and is driven every frame from where the
  // object is on screen, so a voice can be built at any moment without a click.
  const mix = ctx.createGain();
  mix.gain.value = 0;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  parts.out.connect(mix);
  if (pan) mix.connect(pan).connect(bus);
  else mix.connect(bus);

  live++;
  return { mix, pan, parts, dead: false };
}

/** Where the object is now: `gain` 0..1, `pan` -1..1. Called at ~20Hz. */
export function setVoiceMix(v, gain, panPos) {
  if (!v || v.dead) return;
  const t = ctx.currentTime;
  v.mix.gain.setTargetAtTime(gain, t, 0.06);
  if (v.pan) v.pan.pan.setTargetAtTime(panPos, t, 0.08);
}

/** Take the voice away. Faded out first: an object can leave mid-note. */
export function stopVoice(v) {
  if (!v || v.dead) return;
  v.dead = true;
  live--;
  const t = ctx.currentTime;
  v.mix.gain.cancelScheduledValues(t);
  v.mix.gain.setTargetAtTime(0, t, 0.04);
  const end = t + 0.3;
  for (const o of v.parts.osc || []) { try { o.stop(end); } catch { /* already gone */ } }
  for (const s of v.parts.src || []) { try { s.stop(end); } catch { /* ditto */ } }
  setTimeout(() => {
    try { v.mix.disconnect(); } catch { /* ditto */ }
    try { if (v.pan) v.pan.disconnect(); } catch { /* ditto */ }
  }, 420);
}

/** How many voices are up. Read by the harness, and handy in the console. */
export function voiceCount() { return live; }
