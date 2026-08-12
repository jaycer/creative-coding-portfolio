// V2A — the bank of voices the picture plays.
//
// One oscillator per band, all of them running from the moment the context
// starts and never stopped. Starting and stopping oscillators per frame would
// be the obvious design and it is the wrong one: an OscillatorNode is
// single-use, so a 60fps mode would allocate 1900 nodes a second, and every
// one of them would click on its way in. Instead the bank is built once at the
// maximum band count and the unused voices sit at zero gain, which costs
// nothing audible and nothing measurable.
//
// Graph:
//
//   osc -> gain -> pan --\
//   osc -> gain -> pan ---+-> bus -> tone -> dry ------\
//   ...                                                 +-> mix -> comp -> master -> out
//                                     tone -> send -> reverb ----/

/** Voices built up front. The Bands control never asks for more than this. */
export const MAX_BANDS = 64;

/** A procedural room: white noise under an exponential decay. Two channels of
 *  independent noise, which is what makes it read as a space rather than as a
 *  mono echo pinned to the middle. */
function makeImpulse(ctx, seconds, decay) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export class Engine {
  constructor(ctx) {
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Sixty-four oscillators can and will line up in phase. The compressor is
    // not an effect here, it is the thing standing between a white frame and
    // a peak of 64.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;
    this.comp.connect(this.master);

    this.mix = ctx.createGain();
    this.mix.connect(this.comp);

    this.dry = ctx.createGain();
    this.dry.connect(this.mix);
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 2.6, 2.4);
    this.send.connect(this.reverb);
    this.reverb.connect(this.mix);

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.7;
    this.tone.frequency.value = 8000;
    this.tone.connect(this.dry);
    this.tone.connect(this.send);

    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.tone);

    this.voices = [];
    for (let i = 0; i < MAX_BANDS; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      osc.connect(gain);
      gain.connect(pan);
      pan.connect(this.bus);
      osc.start();
      // `t`, `f` and `p` shadow what has already been scheduled, so a frame
      // where nothing moved schedules nothing. At 60fps across 64 bands that
      // is the difference between 11,000 AudioParam events a second and a
      // few dozen.
      this.voices.push({ osc, gain, pan, t: 0, f: 220, p: 0 });
    }
    this.wave = 'sine';
    this.n = 0;
  }

  /** Header volume, 0..1. */
  setMaster(g) {
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
  }

  /**
   * Push one analyzed frame at the bank.
   *
   * `cfg` carries attack, release, glide (all in ms), tone (Hz) and space
   * (0..1 reverb mix) — the Voice and Output panels, in other words.
   */
  update(amps, pans, freqs, n, cfg) {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    if (this.wave !== cfg.wave) {
      this.wave = cfg.wave;
      for (let i = 0; i < MAX_BANDS; i++) this.voices[i].osc.type = cfg.wave;
    }
    if (this.n !== n) {
      this.n = n;
      // Equal-amplitude partials sum as roughly the square root of their count,
      // so without this every step of the Bands slider is also a volume step.
      this.bus.gain.setTargetAtTime(0.85 / Math.sqrt(n), t, 0.05);
    }

    // setTargetAtTime never actually arrives, it only gets exponentially close.
    // Dividing by 3 makes the stated attack the time to ~95%, which is what a
    // number labeled "attack" has to mean if the control is going to be usable.
    const atk = Math.max(0.001, cfg.attack / 3000);
    const rel = Math.max(0.001, cfg.release / 3000);
    const glide = Math.max(0.001, cfg.glide / 3000);

    for (let i = 0; i < MAX_BANDS; i++) {
      const v = this.voices[i];
      const target = i < n ? amps[i] : 0;
      if (target !== v.t) {
        v.gain.gain.setTargetAtTime(target, t, target > v.t ? atk : rel);
        v.t = target;
      }
      if (i >= n) continue;

      const f = freqs[i];
      // A tenth of a percent is a sixth of a cent. Below that nobody is hearing
      // the difference and the event is pure cost.
      if (Math.abs(f - v.f) > v.f * 0.001) {
        v.osc.frequency.setTargetAtTime(f, t, glide);
        v.f = f;
      }
      const p = pans[i];
      if (Math.abs(p - v.p) > 0.01) {
        v.pan.pan.setTargetAtTime(p, t, 0.04);
        v.p = p;
      }
    }

    this.tone.frequency.setTargetAtTime(cfg.tone, t, 0.05);
    // Constant-power-ish: at full wet the dry side is gone, at zero the reverb
    // is fed nothing, and halfway is not a dip.
    this.send.gain.setTargetAtTime(Math.sin(cfg.space * Math.PI / 2), t, 0.05);
    this.dry.gain.setTargetAtTime(Math.cos(cfg.space * Math.PI / 2), t, 0.05);
  }

  /** Everything down, now — for losing the source or holding a silent frame. */
  silence() {
    const t = this.ctx.currentTime;
    for (let i = 0; i < MAX_BANDS; i++) {
      const v = this.voices[i];
      if (v.t !== 0) { v.gain.gain.setTargetAtTime(0, t, 0.06); v.t = 0; }
    }
  }
}
