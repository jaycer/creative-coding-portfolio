// meter-processor.js — the numbers that tell you whether a master is finished.
//
// Four measurements, all pass-through (the audio leaves untouched):
//
//   PEAK       plain sample peak, with a clip counter.
//   TRUE PEAK  the peak of the *reconstructed* analog waveform, found by
//              4x oversampling. Samples can sit under 0 dBFS while the curve
//              drawn through them overshoots — that is what makes a "legal"
//              master distort after MP3/AAC encoding.
//   RMS        short-window average power, for a quick sense of density.
//   LUFS       ITU-R BS.1770-4 loudness: K-weight the signal (a filter pair
//              standing in for how the ear and head respond), average the
//              power, and gate out the silence. This is the unit every
//              streaming service normalizes to, so it is the one number that
//              decides how loud your track sounds next to everyone else's.
//
// Momentary is a 400 ms window, short-term 3 s, and integrated is the gated
// average over everything played since the last reset — computed with both
// gates from the spec (absolute -70 LUFS, then relative -10 LU).

const SUBBLOCK_MS = 100;   // gating blocks are 4 of these, hopping one at a time
const REPORT_MS = 50;

// K-weighting, exactly as specified: a high shelf for the head, a high-pass
// for the fact that nobody hears the bottom octave as loudness. Designed from
// the RBJ cookbook at the real sample rate rather than pasting the 48 kHz
// coefficient table, so 44.1 and 96 kHz files measure correctly too.
const SHELF_F0 = 1681.9744509555319;
const SHELF_G  = 3.999843853973347;
const SHELF_Q  = 0.7071752369554196;
const HPF_F0   = 38.13547087602444;
const HPF_Q    = 0.5003270373238773;

function highShelf(f0, gainDb, Q, fs) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const sq = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cos + sq;
  return {
    b0: (A * ((A + 1) + (A - 1) * cos + sq)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cos)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cos - sq)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cos)) / a0,
    a2: ((A + 1) - (A - 1) * cos - sq) / a0,
  };
}

function highPass(f0, Q, fs) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

// 4x polyphase interpolator for true peak. A 48-tap windowed sinc split into
// four 12-tap phases; each phase is normalized to unity DC gain, which is the
// property a peak estimator actually needs.
function makePolyphase() {
  const TAPS = 48, UP = 4, PER = TAPS / UP;
  const center = (TAPS - 1) / 2;
  const proto = new Float64Array(TAPS);
  for (let j = 0; j < TAPS; j++) {
    const x = (j - center) / UP;
    const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    // Blackman window
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * j) / (TAPS - 1))
                   + 0.08 * Math.cos((4 * Math.PI * j) / (TAPS - 1));
    proto[j] = s * w;
  }
  const phases = [];
  for (let p = 0; p < UP; p++) {
    const h = new Float32Array(PER);
    let sum = 0;
    for (let k = 0; k < PER; k++) { h[k] = proto[k * UP + p]; sum += h[k]; }
    if (sum !== 0) for (let k = 0; k < PER; k++) h[k] /= sum;
    phases.push(h);
  }
  return { phases, PER };
}

class Biquad {
  constructor(c) { this.c = c; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  run(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class MeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const opts = (options && options.processorOptions) || {};
    this.doLufs = opts.lufs !== false;
    this.doTruePeak = opts.truePeak !== false;

    this.filters = [];   // per channel: [shelf, hpf]
    this.tpHist = [];    // per channel: history for the interpolator
    const { phases, PER } = makePolyphase();
    this.phases = phases;
    this.tpTaps = PER;

    this.subLen = Math.max(1, Math.round((SUBBLOCK_MS / 1000) * sampleRate));
    this.subFill = 0;
    this.subSum = 0;          // K-weighted, channel-summed square accumulator
    this.subN = 0;            // samples counted (per channel-frame)
    this.subRing = new Float64Array(30);  // 3 s of sub-block mean squares
    this.subRingFill = 0;
    this.subRingIdx = 0;
    this.blockEnergies = [];  // gating-block mean squares, for integrated

    this.peak = 0;
    this.truePeak = 0;
    this.rmsSum = 0;
    this.rmsN = 0;
    this.clips = 0;

    this.reportEvery = Math.max(128, Math.round((REPORT_MS / 1000) * sampleRate));
    this.sinceReport = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.reset) this.reset();
    };
  }

  reset() {
    this.subFill = 0; this.subSum = 0; this.subN = 0;
    this.subRingFill = 0; this.subRingIdx = 0;
    this.subRing.fill(0);
    this.blockEnergies = [];
    this.peak = 0; this.truePeak = 0; this.rmsSum = 0; this.rmsN = 0; this.clips = 0;
  }

  ensure(channels) {
    while (this.filters.length < channels) {
      this.filters.push([
        new Biquad(highShelf(SHELF_F0, SHELF_G, SHELF_Q, sampleRate)),
        new Biquad(highPass(HPF_F0, HPF_Q, sampleRate)),
      ]);
      this.tpHist.push(new Float32Array(this.tpTaps));
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const hasInput = input && input.length > 0 && input[0];

    if (output && output.length) {
      for (let c = 0; c < output.length; c++) {
        const src = hasInput ? input[Math.min(c, input.length - 1)] : null;
        if (src) output[c].set(src); else output[c].fill(0);
      }
    }
    if (!hasInput) return true;

    const channels = input.length;
    const frames = input[0].length;
    this.ensure(channels);

    for (let i = 0; i < frames; i++) {
      let frameSum = 0;   // K-weighted power across channels, this frame

      for (let c = 0; c < channels; c++) {
        const v = input[c][i];
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        if (a >= 1) this.clips++;
        this.rmsSum += v * v;

        if (this.doTruePeak) {
          // Slide the history and evaluate all four sub-sample phases.
          const hist = this.tpHist[c];
          for (let k = this.tpTaps - 1; k > 0; k--) hist[k] = hist[k - 1];
          hist[0] = v;
          for (let p = 0; p < 4; p++) {
            const h = this.phases[p];
            let acc = 0;
            for (let k = 0; k < this.tpTaps; k++) acc += h[k] * hist[k];
            const aa = acc < 0 ? -acc : acc;
            if (aa > this.truePeak) this.truePeak = aa;
          }
        }

        if (this.doLufs && c < 2) {
          // Only L/R carry weight 1.0 in the stereo case; extra channels
          // would need their own weights, so leave them out of loudness.
          const f = this.filters[c];
          const k = f[1].run(f[0].run(v));
          frameSum += k * k;
        }
      }

      this.rmsN += channels;

      if (this.doLufs) {
        this.subSum += frameSum;
        this.subN++;
        if (++this.subFill >= this.subLen) {
          this.pushSubBlock(this.subSum / this.subN);
          this.subFill = 0; this.subSum = 0; this.subN = 0;
        }
      }
    }

    this.sinceReport += frames;
    if (this.sinceReport >= this.reportEvery) { this.sinceReport = 0; this.send(); }
    return true;
  }

  pushSubBlock(meanSquare) {
    this.subRing[this.subRingIdx] = meanSquare;
    this.subRingIdx = (this.subRingIdx + 1) % this.subRing.length;
    if (this.subRingFill < this.subRing.length) this.subRingFill++;

    // Every new 100 ms sub-block completes another 400 ms gating block
    // (75% overlap), which is exactly what the spec asks for.
    if (this.subRingFill >= 4) {
      let sum = 0;
      for (let k = 1; k <= 4; k++) {
        sum += this.subRing[(this.subRingIdx - k + this.subRing.length) % this.subRing.length];
      }
      this.blockEnergies.push(sum / 4);
      // Cap memory on very long sessions; ~11 hours before this ever trips.
      if (this.blockEnergies.length > 400000) this.blockEnergies.shift();
    }
  }

  windowLoudness(count) {
    if (this.subRingFill < 1) return -Infinity;
    const n = Math.min(count, this.subRingFill);
    let sum = 0;
    for (let k = 1; k <= n; k++) {
      sum += this.subRing[(this.subRingIdx - k + this.subRing.length) % this.subRing.length];
    }
    const mean = sum / n;
    return mean > 0 ? -0.691 + 10 * Math.log10(mean) : -Infinity;
  }

  integrated() {
    const blocks = this.blockEnergies;
    if (blocks.length === 0) return -Infinity;
    const loud = (ms) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);

    // Absolute gate: ignore anything below -70 LUFS (silence, room tone).
    let sum = 0, n = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (loud(blocks[i]) > -70) { sum += blocks[i]; n++; }
    }
    if (n === 0) return -Infinity;

    // Relative gate: ignore anything more than 10 LU below that average, so
    // quiet passages do not drag the number down.
    const relThresh = loud(sum / n) - 10;
    let sum2 = 0, n2 = 0;
    for (let i = 0; i < blocks.length; i++) {
      const l = loud(blocks[i]);
      if (l > -70 && l > relThresh) { sum2 += blocks[i]; n2++; }
    }
    if (n2 === 0) return -Infinity;
    return loud(sum2 / n2);
  }

  send() {
    const rms = this.rmsN > 0 ? Math.sqrt(this.rmsSum / this.rmsN) : 0;
    this.port.postMessage({
      peak: this.peak,
      truePeak: this.truePeak,
      rms,
      clips: this.clips,
      momentary: this.doLufs ? this.windowLoudness(4) : -Infinity,
      shortTerm: this.doLufs ? this.windowLoudness(30) : -Infinity,
      integrated: this.doLufs ? this.integrated() : -Infinity,
    });
    // Peaks are held by the UI, not here — reset so each report is a fresh
    // window and a transient does not pin the meter forever.
    this.peak = 0;
    this.truePeak = 0;
    this.rmsSum = 0;
    this.rmsN = 0;
  }
}

registerProcessor('gs-meter', MeterProcessor);
