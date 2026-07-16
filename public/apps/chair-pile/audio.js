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
const VOICE_CAP = 18;       // concurrent impacts; a big collapse can ask for more

let ctx = null;
let master = null;
let dryBus = null;
let wetBus = null;
let muted = false;
let voices = 0;
let noiseBuf = null;

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
  const snapDecay = 0.012 + s * 0.02;
  const snap = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = (1400 + s * 2200 + Math.random() * 700) * pitch;
  bp.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5 * s, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + snapDecay);
  snap.connect(bp); bp.connect(g); g.connect(out);
  snap.start(t); snap.stop(t + snapDecay + 0.02);
  nodes.push(snap, bp, g);

  // The body: two inharmonic partials. The 2.7 ratio is deliberately not a
  // musical interval — whole-number ratios would ring like a bell or a pipe,
  // where a struck wooden frame is atonal.
  const f0 = (150 + Math.random() * 120) * pitch;
  for (const [mult, level, decay] of [[1, 0.34, 0.13], [2.7, 0.16, 0.085]]) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * mult, t);
    // A slight downward bend is what a struck object does as the strike energy
    // leaves it; without it the partials sound synthetic.
    o.frequency.exponentialRampToValueAtTime(f0 * mult * 0.88, t + decay);
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
