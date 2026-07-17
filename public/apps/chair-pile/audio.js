// Chair Pile — the clatter of wood on wood, all synthesized (no audio files).
//
// One impact = a bright noise transient (the crack of the strike) layered with a
// couple of inharmonic decaying sines (the hollow "tok" of a wooden frame). Both
// scale with how hard the chair actually hit, so a chair dropping onto the heap
// bangs and a chair settling against its neighbor only ticks. Every chair gets
// its own pitch when it's built, so a given chair sounds like itself each time
// it's struck, and a pile of them reads as many objects rather than one sample.
//
// Everything lands in a dark, long reverb — the room the pile can't be seen in.
//
// Unlock follows the repo's "iOS Web Audio recipe" note: create the context in a
// real gesture, retry resume() (one call often leaves it suspended), and set
// navigator.audioSession so the hardware mute switch doesn't silence it. Per
// that note, the silent-buffer "unlock" hack is deliberately not here — it was
// tried on the other apps and was never what fixed anything.

const REVERB_SECONDS = 2.4;
const REVERB_DECAY = 2.8;   // higher = faster tail
const WET = 0.3;
// Concurrent impacts. Settled chairs answer when they are bumped, so one chair
// landing on a crowded heap can ask for a handful of voices at once where it
// used to ask for one; a big collapse asks for more again.
const VOICE_CAP = 28;

/**
 * Two voices for the same physics — same synthesis throughout, only the balance
 * between the strike and the body moves.
 *
 * What reads as "wooden" rather than "drum" is which of the two you hear first.
 * MELLOW is the original: a soft, low strike over partials that ring on for a
 * tenth of a second, which is close to how a tuned skin behaves — hence the
 * bongo in it. SHARP puts the energy in the transient instead: brighter, tighter
 * strike, partials dropped and cut short so the crack lands and gets out of the
 * way, plus a third high partial to break up what is left. The pitch bend has to
 * go with it — the ear reads a fast bend on a short partial as a hard surface.
 */
const TIMBRES = {
  sharp: {
    strikeGain: 0.72,
    strikeHz: [2600, 3400, 900],  // base + strength + jitter, all times the chair's pitch
    strikeQ: 1.3,
    strikeDecay: [0.008, 0.014],  // base + strength
    bodyHz: [190, 140],           // base + jitter
    partials: [[1, 0.2, 0.06], [2.7, 0.13, 0.042], [5.1, 0.07, 0.028]],
    bend: 0.84,
  },
  mellow: {
    strikeGain: 0.5,
    strikeHz: [1400, 2200, 700],
    strikeQ: 0.9,
    strikeDecay: [0.012, 0.02],
    bodyHz: [150, 120],
    partials: [[1, 0.34, 0.13], [2.7, 0.16, 0.085]],
    bend: 0.88,
  },
};
const DEFAULT_TIMBRE = 'sharp';

let ctx = null;
let master = null;
let dryBus = null;
let wetBus = null;
let muted = false;
let voices = 0;
let noiseBuf = null;
let timbre = DEFAULT_TIMBRE;

/** Cached white noise every transient slices out of. */
function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

/** Exponentially decaying stereo noise — a cheap, convincing room. */
function makeImpulse() {
  const len = Math.floor(ctx.sampleRate * REVERB_SECONDS);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, REVERB_DECAY);
    }
  }
  return buf;
}

/** Create the graph. Must be called from inside a real user gesture. */
export function initAudio() {
  if (ctx) { resumeAudio(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();

  // Route onto the media channel so iOS's ringer switch doesn't kill it.
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) { /* older WebKit — nothing to do */ }

  // A whole pile landing at once would clip a bare sum, so everything meets at a
  // compressor before the speakers.
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 1;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 6;
  comp.attack.value = 0.001;
  comp.release.value = 0.22;

  // The compressor alone is not enough. Its attack, even at a millisecond, is
  // slower than the strike of a wooden impact, so the very transients this app
  // is made of walk straight past it — a busy pile measured 1.12 peak, which
  // the hardware would hard-clip. tanh can't exceed 1 no matter what it's fed,
  // so it bounds the output for good; overshoot bends into gentle saturation
  // instead of tearing.
  const limiter = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.3);
  }
  limiter.curve = curve;
  limiter.oversample = '4x'; // the fold is nonlinear; don't let it alias

  master.connect(comp);
  comp.connect(limiter);
  limiter.connect(ctx.destination);

  dryBus = ctx.createGain();
  dryBus.gain.value = 0.9;
  dryBus.connect(master);

  // The wet path is rolled off on the way in: undamped noise convolution tails
  // are hissy, and wood in a large dark room shouldn't sparkle.
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 3200;
  const verb = ctx.createConvolver();
  verb.buffer = makeImpulse();
  const wetGain = ctx.createGain();
  wetGain.gain.value = WET;
  wetBus = ctx.createGain();
  wetBus.connect(damp);
  damp.connect(verb);
  verb.connect(wetGain);
  wetGain.connect(master);

  resumeAudio();
}

/** One resume() often leaves the context suspended, so keep asking for a bit. */
export function resumeAudio() {
  if (!ctx) return;
  let tries = 0;
  const tick = () => {
    if (!ctx || ctx.state === 'running') return;
    ctx.resume().catch(() => {});
    if (++tries < 8) setTimeout(tick, 120);
  };
  tick();
}

export function setMuted(next) {
  muted = next;
  if (!ctx || !master) return;
  // Ramp rather than jump: a hard gain step on a live tail is an audible click.
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
}

export function isMuted() { return muted; }

/** Takes effect on the next impact; nothing already ringing is disturbed. */
export function setTimbre(next) {
  if (TIMBRES[next]) timbre = next;
}

export function getTimbre() { return timbre; }

/** The names a caller may pass to setTimbre, so the UI need not hardcode them. */
export function timbreNames() { return Object.keys(TIMBRES); }

function cleanup(nodes, when) {
  const ms = Math.max(0, (when - ctx.currentTime) * 1000) + 120;
  voices++;
  setTimeout(() => {
    voices--;
    nodes.forEach((n) => { try { n.disconnect(); } catch (e) { /* already gone */ } });
  }, ms);
}

/**
 * One wooden impact.
 *   strength 0..1 — how hard, from the physics impact velocity
 *   pitch          — the chair's own timbre multiplier
 *   pan   -1..1    — where it is across the view
 */
export function clatter(strength, pitch, pan) {
  if (!ctx || ctx.state !== 'running' || muted || voices > VOICE_CAP) return;

  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.05, strength));
  const nodes = [];
  const T = TIMBRES[timbre];

  let out = master ? dryBus : null;
  if (!out) return;
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner) {
    panner.pan.value = Math.max(-1, Math.min(1, pan || 0));
    panner.connect(dryBus);
    panner.connect(wetBus);
    nodes.push(panner);
    out = panner;
  } else {
    wetBus && dryBus.connect(wetBus);
  }

  // The strike: a burst of bandpass noise. Harder hits are brighter and ring a
  // touch longer, which is most of what sells one impact as heavier than another.
  const snapDecay = T.strikeDecay[0] + s * T.strikeDecay[1];
  const snap = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = (T.strikeHz[0] + s * T.strikeHz[1] + Math.random() * T.strikeHz[2]) * pitch;
  bp.Q.value = T.strikeQ;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(T.strikeGain * s, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + snapDecay);
  snap.connect(bp); bp.connect(g); g.connect(out);
  snap.start(t); snap.stop(t + snapDecay + 0.02);
  nodes.push(snap, bp, g);

  // The body: two inharmonic partials. The 2.7 ratio is deliberately not a
  // musical interval — whole-number ratios would ring like a bell or a pipe,
  // where a struck wooden frame is atonal.
  const f0 = (T.bodyHz[0] + Math.random() * T.bodyHz[1]) * pitch;
  for (const [mult, level, decay] of T.partials) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * mult, t);
    // A slight downward bend is what a struck object does as the strike energy
    // leaves it; without it the partials sound synthetic.
    o.frequency.exponentialRampToValueAtTime(f0 * mult * T.bend, t + decay);
    const og = ctx.createGain();
    const peak = Math.max(0.0002, level * s);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    og.gain.exponentialRampToValueAtTime(0.0001, t + decay * (0.6 + s * 0.6));
    o.connect(og); og.connect(out);
    o.start(t); o.stop(t + decay + 0.1);
    nodes.push(o, og);
  }

  cleanup(nodes, t + 0.3);
}
