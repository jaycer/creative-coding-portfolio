// A tiny, self-contained chime for Chairs in Space.
//
// One soft bell per chair that enters, pitched from a small pentatonic set so
// repeated taps make a pleasant, non-repeating shimmer rather than one nagging
// note. WebAudio needs a user gesture to start on most browsers, so the context
// is created lazily and resumed from the first tap/key (see resumeAudio).

let ctx = null;
let master = null;
let muted = false;

// A pentatonic scale (A minor pentatonic across two octaves), in Hz. Every
// pick sounds consonant against the others, so any order of chairs is musical.
const SCALE = [
  220.00, 261.63, 293.66, 329.63, 392.00,
  440.00, 523.25, 587.33, 659.25, 783.99,
];
let lastIdx = -1;

export function initAudio() {
  // Nothing to do up front — the context is built on the first gesture. Kept as
  // a hook so the app's start-up reads the same as its sibling's.
}

export function resumeAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function setMuted(m) { muted = !!m; }
export function isMuted() { return muted; }

/** A single soft bell: two detuned sines through a quick pluck envelope. */
export function chime() {
  if (muted || !ctx || ctx.state !== 'running') return;

  // Step to a nearby scale degree rather than jumping around, so a run of taps
  // reads as a little melody instead of noise.
  let idx = lastIdx < 0
    ? Math.floor(Math.random() * SCALE.length)
    : lastIdx + (Math.floor(Math.random() * 5) - 2);
  idx = Math.max(0, Math.min(SCALE.length - 1, idx));
  lastIdx = idx;
  const f = SCALE[idx];

  const now = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.35, now + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0005, now + 1.6);
  g.connect(master);

  // Fundamental plus a soft octave shimmer, slightly detuned for warmth.
  for (const [mult, level, detune] of [[1, 1, 0], [2, 0.32, 4], [3, 0.12, -3]]) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f * mult;
    o.detune.value = detune;
    const og = ctx.createGain();
    og.gain.value = level;
    o.connect(og).connect(g);
    o.start(now);
    o.stop(now + 1.7);
  }
}
