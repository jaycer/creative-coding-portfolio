// compressor-processor.js — a proper feed-forward dynamic range compressor.
//
// The built-in DynamicsCompressorNode is a black box: no makeup gain, no
// parallel mix, no sidechain filter, and no way to read how much it is actually
// pulling down. This one is the textbook log-domain design (Giannoulis,
// Massberg & Reiss, "Digital Dynamic Range Compressor Design"), which gives a
// smooth soft knee and a gain-reduction number we can put on a meter:
//
//   1. DETECT   turn the signal into a level in dB — peak, or RMS for a
//               rounder, more "average loudness" response.
//   2. CURVE    apply the static threshold/ratio/knee curve to that level and
//               subtract, giving the gain (in dB, always <= 0) we *want* now.
//   3. SMOOTH   slew that gain with separate attack and release constants, so
//               the compressor grabs and lets go at musical speeds.
//   4. APPLY    convert to linear, add makeup, multiply every channel by the
//               same number so the stereo image never wanders.
//
// The detector is stereo-linked and can be high-passed (sidechainHz) so kick
// drums and bass stop ducking the whole mix — the single biggest reason a
// compressed master sounds like it is breathing.

const SILENCE_DB = -120;
const REPORT_INTERVAL = 512; // samples between gain-reduction messages (~11ms)

class CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // All k-rate: these are knobs a human turns, not audio-rate modulation,
      // and reading one float per block instead of per sample keeps this cheap.
      { name: 'threshold',   defaultValue: -18,  minValue: -60,    maxValue: 6,   automationRate: 'k-rate' },
      { name: 'ratio',       defaultValue: 3,    minValue: 1,      maxValue: 20,  automationRate: 'k-rate' },
      { name: 'knee',        defaultValue: 6,    minValue: 0,      maxValue: 24,  automationRate: 'k-rate' },
      { name: 'attack',      defaultValue: 0.01, minValue: 0.0001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release',     defaultValue: 0.2,  minValue: 0.005,  maxValue: 3,   automationRate: 'k-rate' },
      { name: 'makeup',      defaultValue: 0,    minValue: -24,    maxValue: 24,  automationRate: 'k-rate' },
      { name: 'mix',         defaultValue: 1,    minValue: 0,      maxValue: 1,   automationRate: 'k-rate' },
      { name: 'sidechainHz', defaultValue: 0,    minValue: 0,      maxValue: 500, automationRate: 'k-rate' },
      // 0 = peak detection (fast, catches transients), 1 = RMS (slower, hears
      // loudness the way an ear does). Fractional values blend the two.
      { name: 'rmsBlend',    defaultValue: 0,    minValue: 0,      maxValue: 1,   automationRate: 'k-rate' },
      { name: 'bypass',      defaultValue: 0,    minValue: 0,      maxValue: 1,   automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.gainDb = 0;        // smoothed gain reduction, dB (<= 0)
    this.msState = 0;       // running mean-square, for RMS detection
    this.scPrevIn = 0;      // one-pole sidechain high-pass state
    this.scPrevOut = 0;
    this.grPeak = 0;        // worst (most negative) gain reduction since last report
    this.sinceReport = 0;
    // RMS window is fixed at 10ms — long enough to average out a waveform
    // cycle, short enough that the attack control still means something.
    this.msCoef = 1 - Math.exp(-1 / (0.010 * sampleRate));
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channels = output.length;
    const frames = output[0].length;

    // No input connected (or not yet playing) — emit silence but stay alive.
    if (!input || input.length === 0 || !input[0]) {
      for (let c = 0; c < channels; c++) output[c].fill(0);
      this.report(frames, true);
      return true;
    }

    const inChannels = input.length;

    if (params.bypass[0] >= 0.5) {
      for (let c = 0; c < channels; c++) {
        const src = input[Math.min(c, inChannels - 1)];
        if (src) output[c].set(src); else output[c].fill(0);
      }
      this.gainDb = 0;
      this.report(frames, true);
      return true;
    }

    const threshold = params.threshold[0];
    const ratio     = params.ratio[0];
    const knee      = params.knee[0];
    const makeup    = params.makeup[0];
    const mix       = params.mix[0];
    const scHz      = params.sidechainHz[0];
    const rmsBlend  = params.rmsBlend[0];

    // Attack/release as one-pole coefficients. The classic form: a signal
    // reaches ~63% of its target in one time constant.
    const attCoef = Math.exp(-1 / (Math.max(params.attack[0], 1e-5) * sampleRate));
    const relCoef = Math.exp(-1 / (Math.max(params.release[0], 1e-5) * sampleRate));

    // One-pole high-pass for the detector only (never the audio path).
    const scActive = scHz > 1;
    const scAlpha = scActive ? 1 / (1 + (2 * Math.PI * scHz) / sampleRate) : 0;

    const slope = 1 / ratio - 1;   // <= 0; how far the curve bends past threshold
    const halfKnee = knee * 0.5;
    const wetAmt = mix;
    const dryAmt = 1 - mix;
    const makeupLin = Math.pow(10, makeup / 20);

    let gainDb = this.gainDb;
    let ms = this.msState;
    let scPrevIn = this.scPrevIn;
    let scPrevOut = this.scPrevOut;
    let grPeak = this.grPeak;

    for (let i = 0; i < frames; i++) {
      // --- 1. DETECT ---------------------------------------------------
      // Stereo-linked: the loudest channel drives the gain for all of them.
      let detect = 0;
      for (let c = 0; c < inChannels; c++) {
        const v = input[c][i];
        const a = v < 0 ? -v : v;
        if (a > detect) detect = a;
      }

      if (scActive) {
        // y[n] = a * (y[n-1] + x[n] - x[n-1]) — 6 dB/oct high-pass.
        const hp = scAlpha * (scPrevOut + detect - scPrevIn);
        scPrevIn = detect;
        scPrevOut = hp;
        detect = hp < 0 ? -hp : hp;
      }

      let level = detect;
      if (rmsBlend > 0) {
        ms += (detect * detect - ms) * this.msCoef;
        const rms = Math.sqrt(ms);
        level = detect + (rms - detect) * rmsBlend;
      }

      const levelDb = level > 1e-9 ? 20 * Math.log10(level) : SILENCE_DB;

      // --- 2. CURVE ----------------------------------------------------
      const over = levelDb - threshold;
      let targetDb;
      if (knee > 0 && over > -halfKnee && over < halfKnee) {
        // Quadratic soft knee: the ratio eases in across the knee width
        // instead of snapping on at the threshold.
        const t = over + halfKnee;
        targetDb = slope * (t * t) / (2 * knee);
      } else if (over >= halfKnee) {
        targetDb = slope * over;
      } else {
        targetDb = 0;
      }

      // --- 3. SMOOTH ---------------------------------------------------
      // Attack when the needed gain is falling (signal got louder), release
      // when it is rising back toward 0.
      const coef = targetDb < gainDb ? attCoef : relCoef;
      gainDb = targetDb + (gainDb - targetDb) * coef;
      if (gainDb < grPeak) grPeak = gainDb;

      // --- 4. APPLY ----------------------------------------------------
      const g = Math.pow(10, gainDb / 20) * makeupLin;
      for (let c = 0; c < channels; c++) {
        const dry = input[Math.min(c, inChannels - 1)][i];
        // Parallel compression: blend the squashed signal back with the
        // untouched one, keeping transients alive under heavy ratios.
        output[c][i] = dry * g * wetAmt + dry * dryAmt;
      }
    }

    this.gainDb = gainDb;
    this.msState = ms;
    this.scPrevIn = scPrevIn;
    this.scPrevOut = scPrevOut;
    this.grPeak = grPeak;
    this.report(frames, false);
    return true;
  }

  // Throttled gain-reduction telemetry for the meter. Reports the worst
  // reduction in the window (that is what a GR needle shows), not the average.
  report(frames, idle) {
    this.sinceReport += frames;
    if (this.sinceReport < REPORT_INTERVAL) return;
    this.sinceReport = 0;
    this.port.postMessage({ gr: idle ? 0 : -this.grPeak });
    this.grPeak = 0;
  }
}

registerProcessor('gs-compressor', CompressorProcessor);
