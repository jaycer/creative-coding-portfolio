// limiter-processor.js — a look-ahead brickwall limiter that provably cannot
// overshoot its ceiling.
//
// A compressor with a fast attack is not a limiter: however fast the attack,
// an exponential envelope only *approaches* the gain it needs, so the leading
// edge of a transient always slips through. The fix is to see the peak coming.
// This limiter delays the audio and computes the gain from the future:
//
//   t[n]  target gain for this sample          = min(1, ceiling / |x[n]|)
//   m[n]  sliding MINIMUM of t over N samples  -> starts ducking N samples early
//   e[n]  release-limited version of m         -> can dive instantly, recovers slowly
//   s[n]  e smoothed by two moving averages    -> no corners, so no distortion
//         applied to x[n - (N-1)]
//
// The window lengths are chosen so this is not merely "usually enough": every
// e[j] inside the smoother's support is a minimum taken over a window that
// contains sample k = n-(N-1), so s[n] <= t[k] always. The gain applied to a
// sample is never larger than the gain that sample needed, which is what makes
// the ceiling hard rather than hopeful.
//
// Cost is O(1) per sample: the sliding minimum is a monotonic deque, and the
// two moving averages are running sums.
//
// Caveat worth knowing: this limits sample peaks, not inter-sample (true)
// peaks. A lossy encoder can still reconstruct a waveform slightly above a
// 0.0 dBFS ceiling, which is why the default sits at -1.0 dB and the meter
// shows a 4x-oversampled true-peak reading next to it.

const SMOOTH_MS = 12; // one-pole smoothing for knob changes, avoids zipper noise

class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive',   defaultValue: 0,  minValue: 0,   maxValue: 24, automationRate: 'k-rate' },
      { name: 'ceiling', defaultValue: -1, minValue: -24, maxValue: 0,  automationRate: 'k-rate' },
      // Seconds to recover 20 dB of reduction.
      { name: 'release', defaultValue: 0.25, minValue: 0.02, maxValue: 2, automationRate: 'k-rate' },
      { name: 'bypass',  defaultValue: 0,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super(options);
    const opts = (options && options.processorOptions) || {};
    let N = Math.max(4, Math.round(opts.lookaheadSamples || 0.005 * sampleRate));
    if (N % 2) N += 1;              // needs to split into two equal averagers
    this.N = N;
    this.halfN = N / 2;
    this.delay = N - 1;             // exactly the latency this node adds

    // Audio delay line (grown on demand for however many channels arrive).
    this.lines = [];
    this.writeIdx = 0;
    this.lineLen = N;               // ring holds delay + 1 samples, exactly

    // Sliding-minimum deque over the target gain.
    this.cap = N + 1;
    this.dqVal = new Float32Array(this.cap);
    this.dqPos = new Float64Array(this.cap);
    this.head = 0;
    this.tail = 0;
    this.pos = 0;                   // absolute sample counter

    // Two cascaded moving averages = a triangular smoothing window.
    this.ma1 = new Float32Array(this.halfN).fill(1);
    this.ma2 = new Float32Array(this.halfN).fill(1);
    this.sum1 = this.halfN;
    this.sum2 = this.halfN;
    this.ma1i = 0;
    this.ma2i = 0;

    this.envDb = 0;                 // release-limited envelope, dB
    this.driveLin = 1;              // smoothed knob values
    this.ceilLin = Math.pow(10, -1 / 20);
    // Knob smoothing must not apply to the *first* block: gliding up from a
    // guessed default would let peaks past a low ceiling for the first few
    // milliseconds of every offline render. Snap to the real values instead.
    this.primed = false;
    this.smoothCoef = 1 - Math.exp(-1 / (SMOOTH_MS * 0.001 * sampleRate));

    this.grPeak = 1;                // lowest gain seen since the last report
    this.sinceReport = 0;
  }

  ensureLines(channels) {
    while (this.lines.length < channels) {
      this.lines.push(new Float32Array(this.lineLen));
    }
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channels = output.length;
    const frames = output[0].length;
    this.ensureLines(channels);

    const hasInput = input && input.length > 0 && input[0];
    const inChannels = hasInput ? input.length : 0;

    if (params.bypass[0] >= 0.5) {
      for (let c = 0; c < channels; c++) {
        const src = hasInput ? input[Math.min(c, inChannels - 1)] : null;
        if (src) output[c].set(src); else output[c].fill(0);
      }
      this.report(frames, true);
      return true;
    }

    const driveTarget = Math.pow(10, params.drive[0] / 20);
    const ceilTarget = Math.pow(10, params.ceiling[0] / 20);
    if (!this.primed) {
      this.driveLin = driveTarget;
      this.ceilLin = ceilTarget;
      this.primed = true;
    }
    // dB the envelope may climb back per sample (release is "seconds per 20 dB").
    const relStep = 20 / (Math.max(params.release[0], 1e-4) * sampleRate);

    const N = this.N;
    const halfN = this.halfN;
    const delay = this.delay;
    const lineLen = this.lineLen;
    const cap = this.cap;
    const dqVal = this.dqVal;
    const dqPos = this.dqPos;
    const sc = this.smoothCoef;

    let head = this.head;
    let tail = this.tail;
    let pos = this.pos;
    let write = this.writeIdx;
    let envDb = this.envDb;
    let drive = this.driveLin;
    let ceil = this.ceilLin;
    let grPeak = this.grPeak;

    for (let i = 0; i < frames; i++) {
      drive += (driveTarget - drive) * sc;
      ceil += (ceilTarget - ceil) * sc;

      // Write this sample into the delay line and find the loudest channel.
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const v = hasInput && input[Math.min(c, inChannels - 1)]
          ? input[Math.min(c, inChannels - 1)][i] * drive
          : 0;
        this.lines[c][write] = v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }

      // t[n] — the gain this sample will need when it reaches the output.
      const t = peak > ceil ? ceil / peak : 1;

      // m[n] — sliding minimum over the look-ahead window, via monotonic deque.
      while (tail !== head) {
        const back = (tail - 1 + cap) % cap;
        if (dqVal[back] >= t) tail = back; else break;
      }
      dqVal[tail] = t;
      dqPos[tail] = pos;
      tail = (tail + 1) % cap;
      while (dqPos[head] <= pos - N) head = (head + 1) % cap;
      const m = dqVal[head];

      // e[n] — instant dive, rate-limited climb back to unity.
      const mDb = m >= 1 ? 0 : 20 * Math.log10(m);
      envDb = mDb < envDb ? mDb : Math.min(mDb, envDb + relStep);
      const e = envDb >= 0 ? 1 : Math.pow(10, envDb / 20);

      // s[n] — two moving averages: a triangular window, no corners.
      this.sum1 += e - this.ma1[this.ma1i];
      this.ma1[this.ma1i] = e;
      this.ma1i = (this.ma1i + 1) % halfN;
      const avg1 = this.sum1 / halfN;

      this.sum2 += avg1 - this.ma2[this.ma2i];
      this.ma2[this.ma2i] = avg1;
      this.ma2i = (this.ma2i + 1) % halfN;
      let g = this.sum2 / halfN;
      if (g > 1) g = 1;             // guard against float drift above unity

      if (g < grPeak) grPeak = g;

      // Apply to the sample that entered `delay` samples ago.
      const readIdx = (write - delay + lineLen) % lineLen;
      for (let c = 0; c < channels; c++) {
        output[c][i] = this.lines[c][readIdx] * g;
      }

      write = (write + 1) % lineLen;
      pos++;
    }

    this.head = head;
    this.tail = tail;
    this.pos = pos;
    this.writeIdx = write;
    this.envDb = envDb;
    this.driveLin = drive;
    this.ceilLin = ceil;
    this.grPeak = grPeak;
    this.report(frames, false);
    return true;
  }

  report(frames, idle) {
    this.sinceReport += frames;
    if (this.sinceReport < 512) return;
    this.sinceReport = 0;
    const g = idle ? 1 : this.grPeak;
    this.port.postMessage({ gr: g >= 1 ? 0 : -20 * Math.log10(g) });
    this.grPeak = 1;
  }
}

registerProcessor('gs-limiter', LimiterProcessor);
