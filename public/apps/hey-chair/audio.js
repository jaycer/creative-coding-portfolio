// Hey Chair — the band.
//
// One instrument, one key, one written phrase. A steel tongue drum in B major,
// in a large soft room, playing a fixed eight bar melody around a low B pedal.
// Nothing here is random and nothing chooses for itself: the same notes come
// round in the same order every time, and the only thing that changes them is
// the tempo the listener set.
//
// The scheduler is also the clock the STAGE dances to. Nothing visual is
// animated from wall time: hey-chair.js reads transport() every frame and takes
// its beat, its bar and its accents from here, which is the only way the chairs
// land on the music instead of near it. listen.js can take that same clock over
// and pull it onto whatever is playing in the room.

// --- iOS-reliable AudioContext -------------------------------------------------
// Inlined so the app is self-contained: playback session, retried resume(), and
// auto re-resume after an interruption. Start has to come from a finished
// gesture — a pointerdown that might still become a scroll doesn't count.
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

let audio = makeUnlockableAudioContext();
let ctx = audio.ctx;

// --- the notes -----------------------------------------------------------------
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// B major pentatonic, three octaves of it: B C# D# F# G#. A tongue drum is
// built this way for a reason — with the fourth and the seventh left out there
// is no interval in the instrument that can sound wrong against another, which
// is most of why the thing is so restful to listen to.
const SCALE = [
  47, 49, 51, 54, 56,   //  0..4   B2  C#3 D#3 F#3 G#3   the pedal
  59, 61, 63, 66, 68,   //  5..9   B3  C#4 D#4 F#4 G#4
  71, 73, 75, 78, 80,   // 10..14  B4  C#5 D#5 F#5 G#5   the melody
];

// Eight bars, written out. Each note is [16th step in the bar, note, how hard].
// Bars four and eight are nearly empty on purpose: the phrase needs somewhere
// to breathe, and at this tempo the room is still ringing anyway.
const PHRASE = [
  [[0, 10, 0.85], [6, 12, 0.60], [12, 11, 0.55]],
  [[0, 8, 0.70], [6, 10, 0.55], [12, 13, 0.60]],
  [[0, 11, 0.80], [4, 10, 0.50], [10, 9, 0.60], [14, 8, 0.45]],
  [[0, 6, 0.70], [8, 8, 0.55]],
  [[0, 10, 0.85], [6, 12, 0.60], [12, 14, 0.60]],
  [[0, 13, 0.70], [6, 12, 0.50], [12, 10, 0.55]],
  [[0, 9, 0.75], [4, 11, 0.50], [10, 12, 0.60], [14, 13, 0.50]],
  [[0, 10, 0.70], [10, 8, 0.50]],
];

// Under all of it, the same low B twice a bar. A pedal rather than a bass line:
// it holds the key down, it gives the bar a pulse to sit on, and it is the beat
// the chairs bounce to. The fifth underneath moves on the resting bars, which is
// as much motion as this wants.
const PEDAL_ROOT = 0;    // B2
const PEDAL_FIFTH = 3;   // F#3
const PEDAL_SIXTH = 4;   // G#3

// --- the graph -----------------------------------------------------------------
let mix = null;          // everything dry lands here
let verbSend = null, verbOut = null;
let master = null;
let muteGain = null;     // a node of its own: never a param anything else modulates
// Two independent reasons to be quiet, multiplied into that one node. `outLevel`
// is the header slider, which pushes its remembered level down at startup and
// begins at 0 until it does. `muted` is the app taking the
// output away wholesale — it goes silent to listen to the room — and it must
// win without disturbing where the listener left the slider.
let outLevel = 0;
let fade = null, streamEl = null;
let built = false;
let running = false;
let audioStale = false;

let bpm = 80;
let muted = false;
// Drive into the ceiling. High enough that the drum is present, low enough
// that only the shout ever reaches the soft clip.
const LEVEL = 1.15;

/** A big soft room built from decaying noise. Cheap, and no file to fetch. */
function makeVerb(seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      // The two channels are filled independently, which is the whole of the
      // width: the same noise in both would collapse to the middle.
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/** A soft ceiling, so two low notes landing together cannot spike the mix. */
function limitCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.5) / Math.tanh(1.5);
  }
  return curve;
}

function buildGraph() {
  if (built) return;

  mix = ctx.createGain();
  mix.gain.value = 1;

  // Long and soft. The room is doing as much of the work here as the drum is:
  // struck metal into a big space is the entire sound, and a short room would
  // leave the phrase sounding like somebody tapping a pipe.
  const verb = ctx.createConvolver();
  verb.buffer = makeVerb(4.2, 2.1);
  verbSend = ctx.createGain();
  verbSend.gain.value = 1;
  verbOut = ctx.createGain();
  verbOut.gain.value = 0.7;
  // Take the top off the tail, so the room stays behind the drum rather than
  // hissing along on top of it.
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = 4200;
  verbSend.connect(verb).connect(air).connect(verbOut);

  // No compressor. One instrument with a four second decay has nothing to be
  // glued to, and anything with a release on it would breathe against the tails
  // and turn the quiet bars into a pumping noise.
  //
  // The level goes BEFORE the ceiling, so the ceiling is genuinely the last
  // thing in the chain and nothing downstream can push past it. With the gain
  // after it, as it was, a shout at the top of the tempo range came out at 1.08
  // and clipped on the way out of the machine — the limiter having already had
  // its say, one stage too early to matter.
  master = ctx.createGain();
  master.gain.value = LEVEL;
  mix.connect(master);
  verbOut.connect(master);

  const ceiling = ctx.createWaveShaper();
  ceiling.curve = limitCurve();
  ceiling.oversample = '4x';
  master.connect(ceiling);

  // Mute is its own node, never a param anything else is moving.
  muteGain = ctx.createGain();
  muteGain.gain.value = muted ? 0 : outLevel;
  ceiling.connect(muteGain);

  fade = ctx.createGain();
  fade.gain.value = 0;
  muteGain.connect(fade);

  // Out through a MediaStream on an <audio> element rather than straight to
  // ctx.destination: WebKit keeps a live stream rendering while the tab is in
  // the background, so the music survives a trip to another tab.
  if (streamEl) { try { streamEl.pause(); } catch { /* gone already */ } streamEl.remove(); }
  const streamDest = ctx.createMediaStreamDestination();
  fade.connect(streamDest);
  streamEl = new Audio();
  streamEl.srcObject = streamDest.stream;
  document.body.appendChild(streamEl);

  built = true;
}

// --- the instrument ------------------------------------------------------------
const noiseCache = new Map();
function noiseBuffer(seconds) {
  const key = Math.round(seconds * 1000);
  if (noiseCache.has(key)) return noiseCache.get(key);
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseCache.set(key, buf);
  return buf;
}

// A struck steel tongue, as a handful of partials. The second is a true octave
// because that is what the maker tunes it to; the ones above are deliberately
// not whole multiples, and that slight wrongness is the metal in the sound. Each
// one dies away faster than the one below it, which is why the note starts
// bright and ends as almost a pure tone.
const PARTIALS = [
  { mult: 1,    level: 1,    decay: 1,    type: 'sine' },
  { mult: 2.01, level: 0.34, decay: 0.62, type: 'sine' },
  { mult: 3.02, level: 0.11, decay: 0.38, type: 'sine' },
  { mult: 5.41, level: 0.05, decay: 0.16, type: 'triangle' },
];

function tongue(t, midi, peak = 1) {
  const f = mtof(midi);
  // A big tongue rings far longer than a small one, so the low notes hang under
  // the phrase and the high ones get out of its way.
  const ring = 3.2 * Math.pow(2, (59 - midi) / 26);

  const out = ctx.createGain();
  out.gain.value = peak * 0.2;
  const warm = ctx.createBiquadFilter();
  warm.type = 'lowpass';
  warm.frequency.value = Math.min(9000, f * 8);
  warm.Q.value = 0.4;
  warm.connect(out);
  out.connect(mix);
  const room = ctx.createGain();
  room.gain.value = 0.85;
  out.connect(room).connect(verbSend);

  for (const p of PARTIALS) {
    const o = ctx.createOscillator();
    o.type = p.type;
    // Struck metal is sharp for the first instant and settles as the energy of
    // the strike leaves it. A few cents, over a few hundredths of a second, and
    // without it the note starts like an organ instead of like a blow.
    o.frequency.setValueAtTime(f * p.mult * 1.006, t);
    o.frequency.exponentialRampToValueAtTime(f * p.mult, t + 0.05);
    const g = ctx.createGain();
    const dur = ring * p.decay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(p.level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(warm);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // The mallet itself, which is most of what says "struck" rather than "played".
  const click = ctx.createBufferSource();
  click.buffer = noiseBuffer(0.02);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2400;
  band.Q.value = 1.1;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(peak * 0.05, t);
  cg.gain.exponentialRampToValueAtTime(0.0005, t + 0.014);
  click.connect(band).connect(cg).connect(warm);
  click.start(t);
  click.stop(t + 0.04);

  markHit(midi < 59 ? 'low' : 'note', t);
}

// --- what the stage watches ----------------------------------------------------
// Every note stamps the time it was struck. The visuals turn those into decaying
// envelopes, so the chairs can bounce on the pedal without the audio thread ever
// calling into the renderer.
const hits = { low: -99, note: -99, accent: -99 };
function markHit(name, t) { if (t > hits[name]) hits[name] = t; }

// --- the scheduler -------------------------------------------------------------
// Steps are 16ths. Everything is placed on the audio clock ahead of time; the
// only thing the timer does is keep the queue topped up.
const SCHEDULE_AHEAD = 0.12;
const TIMER_MS = 25;
let timer = null;
let step = 0;          // next step to schedule
let anchorStep = 0;    // the step the clock was re-anchored at
let anchorTime = 0;    // ctx time of that step

const stepDur = () => 60 / bpm / 4;
const timeOfStep = (s) => anchorTime + (s - anchorStep) * stepDur();
/** Fractional step position at any moment on the audio clock, past or future. */
const stepAt = (t) => anchorStep + (t - anchorTime) / stepDur();
/** Fractional step position right now, valid across tempo changes. */
const stepNow = () => stepAt(ctx.currentTime);

function scheduleStep(s, t) {
  const bar = Math.floor(s / 16) % PHRASE.length;
  const inBar = s % 16;

  if (inBar === 0) tongue(t, SCALE[PEDAL_ROOT], 0.5);
  if (inBar === 8) {
    const resting = bar === 3 || bar === 7;
    tongue(t, SCALE[resting ? PEDAL_SIXTH : PEDAL_FIFTH], 0.3);
  }

  for (const [at, index, vel] of PHRASE[bar]) {
    if (at === inBar) tongue(t, SCALE[index], vel);
  }
}

function tick() {
  if (!running) return;
  // A frozen tab can leave the clock far behind. Skip onto the grid rather than
  // firing every missed step at once, which comes back as a burst of noise.
  if (timeOfStep(step) < ctx.currentTime - 0.25) {
    const missed = Math.ceil((ctx.currentTime - timeOfStep(step)) / stepDur());
    step += missed;
  }
  while (timeOfStep(step) < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(step, Math.max(ctx.currentTime, timeOfStep(step)));
    step++;
  }
}

// --- public --------------------------------------------------------------------
const FADE = 0.7;

/**
 * The clock everything here is scheduled on. Anything that wants to line
 * something up with the band has to quote its times in this.
 */
export function audioContext() { return ctx; }

/**
 * Bring the context up without starting the band. The microphone listener needs
 * a running context to read anything at all — a suspended one has a frozen
 * currentTime — but turning it on in the sheet must not raise the curtain.
 */
export async function wakeAudio() {
  buildGraph();
  return audio.unlock();
}

/** Must be called from a completed gesture (pointerup, click, keyup). */
export async function startAudio() {
  buildGraph();
  await audio.unlock();
  if (streamEl) streamEl.play().catch(() => { /* best effort */ });
  if (!running) {
    running = true;
    anchorTime = ctx.currentTime + 0.08;
    anchorStep = 0;
    step = 0;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, TIMER_MS);
  }
  fade.gain.cancelScheduledValues(ctx.currentTime);
  fade.gain.setTargetAtTime(1, ctx.currentTime, FADE / 3);
  return ctx.state === 'running';
}

function applyLevel() {
  if (muteGain) muteGain.gain.setTargetAtTime(muted ? 0 : outLevel, ctx.currentTime, 0.05);
}

/** The app taking the output away (it cannot play and listen at once). */
export function setMuted(m) {
  muted = !!m;
  applyLevel();
}

/** Header slider, 0..1. Safe to call before the graph is built. */
export function setVolume(v) {
  outLevel = Math.max(0, Math.min(1, v));
  applyLevel();
}

/** Re-anchors the clock so the beat the stage is reading stays continuous. */
export function setTempo(v) {
  const s = stepNow();
  bpm = Math.max(60, Math.min(150, v));
  anchorStep = s;
  anchorTime = ctx.currentTime;
  // Never back up over a step that has already been handed to the audio clock.
  // Dragging the fader re-anchors many times a second, and each one used to
  // rewind `step` to just ahead of now — which is behind what was scheduled,
  // so the last steps got laid down a second time on top of themselves.
  step = Math.max(step, Math.ceil(s));
}

// How much of the phase error to take out on each correction. The stage reads
// this clock every frame, so a hard snap is a jump in the position of every
// chair at once; a fifth at a time walks the parade into step over a couple of
// seconds and looks like the troupe finding the groove.
const PHASE_PULL = 0.2;

/**
 * Follow a beat that was heard somewhere else. `beatTime` is when it happened,
 * on this same audio clock, so no wall time and no latency assumptions get into
 * it. Snap only for the first correction after the clock starts, where there is
 * no dance in progress to disturb.
 */
export function lockTo(targetBpm, beatTime, snap) {
  const wanted = Math.max(60, Math.min(150, targetBpm));
  // Ease the tempo rather than stepping to it. A detector that wobbles by a
  // beat per minute is doing well; the stage would show that as the whole
  // parade twitching, so let it in slowly.
  const eased = snap ? wanted : bpm + (wanted - bpm) * 0.2;
  if (Math.abs(eased - bpm) > 0.05) setTempo(eased);

  if (!running || !Number.isFinite(beatTime)) return;
  // Where that beat fell on our grid. Whole numbers are on the beat; the
  // fraction is how far out of step we are, and it is signed, so a beat that
  // arrived early and one that arrived late are corrected in opposite
  // directions rather than both being dragged forward.
  const beat = stepAt(beatTime) / 4;
  const err = beat - Math.round(beat);
  // Pushing the anchor later moves the whole clock earlier by the same amount.
  anchorTime += err * (60 / bpm) * (snap ? 1 : PHASE_PULL);
}

/**
 * The shout. Three notes up the scale, hard and quick — the one moment the
 * instrument is played at rather than played.
 */
export function accent() {
  if (!built || !running) return;
  const t = ctx.currentTime + 0.01;
  [10, 12, 13].forEach((index, i) => tongue(t + i * 0.055, SCALE[index], 1.05 - i * 0.1));
  hits.accent = t;
}

/**
 * Everything the stage needs, read fresh each frame off the audio clock.
 * `beat` is fractional and monotonic, so choreography can be written as plain
 * arithmetic on it. The envelopes are 0..1 and decay from the last strike.
 */
export function transport() {
  const s = stepNow();
  const now = ctx.currentTime;
  const env = (name, tau) => {
    const dt = now - hits[name];
    return dt < 0 || dt > tau * 6 ? 0 : Math.exp(-dt / tau);
  };
  return {
    running,
    bpm,
    // Seconds on the audio clock. Monotonic whatever the tempo does, which
    // beat is not once you divide it back out by a bpm that moved.
    time: now,
    step: s,
    beat: s / 4,
    bar: s / 16,
    barPhase: (s % 16) / 16,
    low: env('low', 0.16),      // the pedal, which is what the chairs bounce on
    note: env('note', 0.3),     // the melody
    accent: env('accent', 0.45),
  };
}

/** Safari drops a backgrounded context's sources; rebuild if we came back dead. */
export function resync() {
  if (!built || !running) return;
  const dead = ctx.state !== 'running' || (streamEl && streamEl.paused);
  if (!dead && !audioStale) return;
  audio.unlock().then(() => {
    if (streamEl) streamEl.play().catch(() => { /* best effort */ });
  });
  audioStale = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') audioStale = true;
  else resync();
});
