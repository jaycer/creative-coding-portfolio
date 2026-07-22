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

// Distance depth. The pile towers and the camera pulls a long way back, so a
// knock at the far rim should read as farther off than one in your lap: quieter,
// duller (air and the pile itself soak up the highs), and arriving more as room
// than as direct sound. `dist` is the chair's range from the camera in meters,
// which the caller already has in camera-local space. Everything below NEAR is
// full presence; everything past FAR is the back wall; between, it crossfades.
const DEPTH_NEAR = 6;       // m — at or under this, no distance coloring
const DEPTH_FAR = 34;       // m — at or over this, fully "across the room"
const DEPTH_MIN_GAIN = 0.4; // the far knock still counts; the pile is one instrument
const DEPTH_LP_NEAR = 19000; // Hz — open
const DEPTH_LP_FAR = 1500;   // Hz — muffled
const DEPTH_DRY_FAR = 0.45;  // direct sound left at FAR, relative to NEAR's 1.0
const DEPTH_WET_FAR = 1.7;   // room send at FAR, relative to NEAR's ~0.85

/**
 * Two voices for the same physics — same synthesis throughout, only the balance
 * between the strike and the body moves.
 *
 * What reads as "wooden" rather than "drum" is which of the two you hear first.
 * MELLOW is the original: a soft, low strike over partials that ring on for a
 * tenth of a second, which is close to how a tuned skin behaves — hence the
 * bongo in it. SHARP puts the energy in the transient instead: brighter, tighter
 * strike, partials cut short so the crack lands and gets out of the way, plus a
 * third high partial to break up what is left. The pitch bend goes with it — the
 * ear reads a fast bend on a short partial as a hard surface.
 *
 * The two are matched for loudness, which takes deliberate work in opposite
 * directions. Nearly all the energy in a knock is in the body, not the strike: a
 * 20ms noise burst carries almost none however high its peak, while a partial
 * ringing for a tenth of a second carries a lot. So cutting the partials short
 * to sharpen it also gutted it — measured, sharp came out around a third of
 * mellow's energy and a fifth of its peak. The answer is not to let them ring
 * again, which would only walk back to mellow, but to strike them harder: sharp's
 * partials start well above mellow's and still die in half the time.
 *
 * They have to match, because loudness masquerades as quality — given two
 * versions of a sound, the louder one is picked nearly every time, whatever else
 * is true of it. A choice between these two is only a real choice about timbre
 * if neither wins by being louder.
 */
const TIMBRES = {
  sharp: {
    strikeGain: 1.12,
    strikeHz: [2600, 3400, 900],  // base + strength + jitter, all times the chair's pitch
    strikeQ: 1.3,
    strikeDecay: [0.008, 0.014],  // base + strength
    bodyHz: [190, 140],           // base + jitter
    // Struck well past mellow's [0.34, 0.16] and gone in half the time. The
    // levels only look hot: a bandpass at this Q throws away most of the noise
    // it is handed, and each partial is most of the way down before the next
    // frame. Measured at the speakers, this lands level with mellow.
    partials: [[1, 0.63, 0.06], [2.7, 0.4, 0.042], [5.1, 0.21, 0.028]],
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
  // These chairs are steel: they clang and ring instead of knocking, and never
  // break. Metal differs from the wood pair in kind, not degree. The strike is a
  // bright chink up in the harsh band. The body is many partials, not two, tuned
  // to the modes of a free steel bar (1, 2.76, 5.40, 8.93, ...) so it shimmers
  // atonally rather than playing a pitch; the higher modes shed energy faster, as
  // real metal does, but even the low ones ring for the better part of a second —
  // an order longer than wood, which is the whole character. `bend` is near 1: a
  // stiff metal bar barely detunes as it rings, where a wooden frame sags away
  // fast. `level` trims the whole voice so five long partials still land level
  // with the wood pair rather than dominating (loudness masquerades as quality,
  // as above) — measured at the speakers, not guessed.
  metal: {
    level: 0.5,
    strikeGain: 1.0,
    strikeHz: [3400, 4200, 1600],
    strikeQ: 1.2,
    strikeDecay: [0.006, 0.012],
    bodyHz: [300, 210],
    partials: [
      [1, 0.5, 0.92], [2.76, 0.34, 0.72], [5.4, 0.24, 0.52], [8.93, 0.15, 0.36], [13.4, 0.09, 0.24],
    ],
    bend: 0.992,
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
export function clatter(strength, pitch, pan, dist = DEPTH_NEAR) {
  if (!ctx || ctx.state !== 'running' || muted || voices > VOICE_CAP) return;
  if (!dryBus || !wetBus) return;

  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.05, strength));
  const nodes = [];
  const T = TIMBRES[timbre];
  const trim = T.level ?? 1; // per-timbre loudness trim (metal rings hot)

  // Distance depth: d is 0 at NEAR (a chair in your lap), 1 at FAR (the back
  // wall). Farther knocks lose level, lose highs, and tip from direct sound
  // toward room, so the pile has front and back rather than sitting flat.
  const d = Math.min(1, Math.max(0, (dist - DEPTH_NEAR) / Math.max(0.0001, DEPTH_FAR - DEPTH_NEAR)));
  const depthGain = 1 - d * (1 - DEPTH_MIN_GAIN);
  const lpHz = DEPTH_LP_NEAR * Math.pow(DEPTH_LP_FAR / DEPTH_LP_NEAR, d); // exp, so it falls by ear

  // Per-voice output: synth -> lowpass (distance muffle) -> panner -> a dry send
  // and a wet send whose balance tips to the room with distance. Older WebKit
  // without a panner drops the pan but keeps the depth.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lpHz;
  const dryG = ctx.createGain();
  dryG.gain.value = depthGain * (1 - d * (1 - DEPTH_DRY_FAR));
  const wetG = ctx.createGain();
  wetG.gain.value = depthGain * (0.85 + d * (DEPTH_WET_FAR - 0.85));
  dryG.connect(dryBus);
  wetG.connect(wetBus);
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner) {
    panner.pan.value = Math.max(-1, Math.min(1, pan || 0));
    lp.connect(panner);
    panner.connect(dryG);
    panner.connect(wetG);
    nodes.push(panner);
  } else {
    lp.connect(dryG);
    lp.connect(wetG);
  }
  nodes.push(lp, dryG, wetG);
  const out = lp;

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
  g.gain.exponentialRampToValueAtTime(T.strikeGain * s * trim, t + 0.001);
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
    const peak = Math.max(0.0002, level * s * trim);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    og.gain.exponentialRampToValueAtTime(0.0001, t + decay * (0.6 + s * 0.6));
    o.connect(og); og.connect(out);
    o.start(t); o.stop(t + decay + 0.1);
    nodes.push(o, og);
  }

  // Hold the voice open for its longest ring, not a fixed 0.3s: metal's partials
  // run most of a second, and disconnecting them early would clip the tail.
  let tail = snapDecay;
  for (const p of T.partials) tail = Math.max(tail, p[2]);
  cleanup(nodes, t + tail + 0.15);
}
