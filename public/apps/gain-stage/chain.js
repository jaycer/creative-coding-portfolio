// chain.js — the signal chain, built the same way twice.
//
// One function assembles the whole processor, and both the live AudioContext
// and the OfflineAudioContext used for export call it. That is deliberate:
// an export path that rebuilds the graph by hand is an export path that
// eventually stops matching what you heard.
//
//   trim -> [meter] -> HPF -> shelf/peak/peak/peak/shelf -> LPF
//        -> compressor -> saturation -> limiter -> output gain -> [meter]
//
// Everything defeatable is defeated *exactly*: a peaking biquad at 0 dB is
// mathematically an identity (b == a), a WaveShaper with a null curve passes
// samples through untouched, and the two worklets take a bypass parameter.
// The filters that cannot be neutral this way (the high- and low-pass) get
// unplugged from the graph instead of being parked at an inaudible frequency.

export const LOOKAHEAD_SEC = 0.005;

export const EQ_BANDS = [
  { key: 'ls', type: 'lowshelf',  label: 'Low',      freq: 90,    gain: 0, q: 0.7, min: 30,   max: 400 },
  { key: 'p1', type: 'peaking',   label: 'Low mid',  freq: 260,   gain: 0, q: 1.0, min: 80,   max: 1000 },
  { key: 'p2', type: 'peaking',   label: 'Mid',      freq: 1000,  gain: 0, q: 1.0, min: 300,  max: 4000 },
  { key: 'p3', type: 'peaking',   label: 'Presence', freq: 4000,  gain: 0, q: 1.0, min: 1500, max: 12000 },
  { key: 'hs', type: 'highshelf', label: 'Air',      freq: 10000, gain: 0, q: 0.7, min: 3000, max: 16000 },
];

// --- saturation curves -----------------------------------------------------
// Three characters, all odd-or-even harmonic generators rather than clippers.
const SHAPERS = {
  soft: (x) => Math.tanh(x),
  tape: (x) => Math.atan(x) / (Math.PI / 2),
  // Asymmetric, so it produces even harmonics — the "warm" ones.
  warm: (x) => {
    const a = 0.4;
    return (Math.tanh(x + a) - Math.tanh(a)) / (Math.tanh(1 + a) - Math.tanh(a));
  },
};

/**
 * Build a WaveShaper curve for the given character, drive and blend.
 *
 * The curve is loudness-compensated: after shaping, it is scaled so that
 * Gaussian program material comes out at the same RMS it went in at. Without
 * that, the drive knob is really a volume knob and every A/B is a lie —
 * louder always wins.
 */
export function makeSaturationCurve(mode, driveDb, mix, n = 4096) {
  const shape = SHAPERS[mode] || SHAPERS.soft;
  const g = Math.pow(10, driveDb / 20);
  const norm = shape(g) || 1;
  const f = (x) => shape(g * x) / norm;

  // Deterministic RMS comparison over a Gaussian-weighted sweep (sigma 0.2 is
  // roughly a mixed, un-mastered track sitting around -14 dBFS RMS).
  let inSq = 0, outSq = 0, w = 0;
  const sigma = 0.2;
  for (let i = -600; i <= 600; i++) {
    const x = i / 600;
    const weight = Math.exp(-(x * x) / (2 * sigma * sigma));
    inSq += weight * x * x;
    outSq += weight * f(x) * f(x);
    w += weight;
  }
  const comp = outSq > 1e-12 ? Math.sqrt(inSq / outSq) : 1;

  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const wet = f(x) * comp;
    let y = x * (1 - mix) + wet * mix;
    curve[i] = y > 1 ? 1 : y < -1 ? -1 : y;
  }
  return curve;
}

// --- worklet loading -------------------------------------------------------
const MODULES = [
  new URL('./dsp/compressor-processor.js', import.meta.url).href,
  new URL('./dsp/limiter-processor.js', import.meta.url).href,
  new URL('./dsp/meter-processor.js', import.meta.url).href,
];

export async function loadWorklets(ctx) {
  for (const url of MODULES) await ctx.audioWorklet.addModule(url);
}

// --- default state ---------------------------------------------------------
export function defaultState() {
  return {
    app: 'gain-stage',
    version: 1,
    preset: 'Flat',
    trim: 0,
    hpf: { on: false, freq: 30 },
    lpf: { on: false, freq: 18000 },
    eq: EQ_BANDS.map((b) => ({ freq: b.freq, gain: b.gain, q: b.q })),
    // Starts defeated: the app should be transparent until you ask it not to
    // be. The limiter stays in with no drive, purely as a safety net.
    comp: {
      on: false, threshold: -18, ratio: 3, knee: 6,
      attack: 0.012, release: 0.18, makeup: 0, mix: 1,
      sidechainHz: 0, rmsBlend: 0,
    },
    sat: { on: false, mode: 'soft', drive: 6, mix: 0.5 },
    limiter: { on: true, drive: 0, ceiling: -1, release: 0.25 },
    output: 0,
  };
}

export function cloneState(s) {
  return JSON.parse(JSON.stringify(s));
}

/**
 * Assemble the chain on any BaseAudioContext.
 *
 * @param {BaseAudioContext} ctx
 * @param {{ meters?: boolean }} [opts] the input meter costs CPU and is
 *   pointless during an offline render, so export turns it off. The *output*
 *   meter lives outside this function, downstream of the A/B switch, so it
 *   always reads what is actually coming out of the speakers.
 * @returns an object with `input`, `output`, the nodes, and `apply(state)`.
 */
export function buildChain(ctx, opts = {}) {
  const withMeters = opts.meters !== false;
  const lookaheadSamples = Math.round(LOOKAHEAD_SEC * ctx.sampleRate);

  const trim = ctx.createGain();
  const inMeter = withMeters
    ? new AudioWorkletNode(ctx, 'gs-meter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { lufs: false, truePeak: false },
      })
    : null;

  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.Q.value = 0.707;

  const bands = EQ_BANDS.map((b) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.freq;
    f.Q.value = b.q;
    f.gain.value = 0;
    return f;
  });

  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.Q.value = 0.707;

  const eqHead = ctx.createGain();   // fixed anchors so rewiring is contained
  const eqTail = ctx.createGain();

  const comp = new AudioWorkletNode(ctx, 'gs-compressor', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
  });

  const sat = ctx.createWaveShaper();
  sat.oversample = '4x';
  sat.curve = null;

  const limiter = new AudioWorkletNode(ctx, 'gs-limiter', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { lookaheadSamples },
  });

  const output = ctx.createGain();
  const tail = ctx.createGain();  // single node everything downstream hangs off

  // Static wiring. Only the HPF/LPF section is ever re-plugged.
  if (inMeter) { trim.connect(inMeter); inMeter.connect(eqHead); }
  else trim.connect(eqHead);

  eqTail.connect(comp);
  comp.connect(sat);
  sat.connect(limiter);
  limiter.connect(output);
  output.connect(tail);

  let wiredHpf = null, wiredLpf = null;

  function rewireEq(useHpf, useLpf) {
    if (useHpf === wiredHpf && useLpf === wiredLpf) return;
    wiredHpf = useHpf; wiredLpf = useLpf;

    eqHead.disconnect();
    hpf.disconnect();
    lpf.disconnect();
    bands.forEach((b) => b.disconnect());

    const line = [];
    if (useHpf) line.push(hpf);
    line.push(...bands);
    if (useLpf) line.push(lpf);

    let node = eqHead;
    for (const next of line) { node.connect(next); node = next; }
    node.connect(eqTail);
  }
  rewireEq(false, false);

  const p = (node, name) => node.parameters.get(name);
  let lastSatKey = '';

  /**
   * Push a state object onto the graph.
   * @param {object} s
   * @param {number} [at] context time to schedule at (defaults to now)
   * @param {number} [ramp] seconds to glide, so live tweaks do not click
   */
  function apply(s, at = ctx.currentTime, ramp = 0.02) {
    const set = (param, value) => {
      const v = Number.isFinite(value) ? value : 0;
      if (ramp > 0) {
        param.setTargetAtTime(v, at, ramp / 3);
      } else {
        param.setValueAtTime(v, at);
      }
    };

    set(trim.gain, Math.pow(10, s.trim / 20));
    set(output.gain, Math.pow(10, s.output / 20));

    rewireEq(!!s.hpf.on, !!s.lpf.on);
    set(hpf.frequency, s.hpf.freq);
    set(lpf.frequency, s.lpf.freq);
    s.eq.forEach((b, i) => {
      const f = bands[i];
      set(f.frequency, b.freq);
      set(f.gain, b.gain);
      set(f.Q, b.q);
    });

    const c = s.comp;
    set(p(comp, 'threshold'), c.threshold);
    set(p(comp, 'ratio'), c.ratio);
    set(p(comp, 'knee'), c.knee);
    set(p(comp, 'attack'), c.attack);
    set(p(comp, 'release'), c.release);
    set(p(comp, 'makeup'), c.makeup);
    set(p(comp, 'mix'), c.mix);
    set(p(comp, 'sidechainHz'), c.sidechainHz);
    set(p(comp, 'rmsBlend'), c.rmsBlend);
    p(comp, 'bypass').setValueAtTime(c.on ? 0 : 1, at);

    // Rebuilding a 4096-point curve on every slider frame is wasteful, so
    // only do it when the character actually changed.
    const satKey = s.sat.on ? `${s.sat.mode}|${s.sat.drive}|${s.sat.mix}` : '';
    if (satKey !== lastSatKey) {
      lastSatKey = satKey;
      sat.curve = s.sat.on ? makeSaturationCurve(s.sat.mode, s.sat.drive, s.sat.mix) : null;
    }

    const l = s.limiter;
    set(p(limiter, 'drive'), l.drive);
    set(p(limiter, 'ceiling'), l.ceiling);
    set(p(limiter, 'release'), l.release);
    p(limiter, 'bypass').setValueAtTime(l.on ? 0 : 1, at);
  }

  return {
    input: trim,
    output: tail,
    nodes: { trim, hpf, lpf, bands, comp, sat, limiter, output, inMeter },
    lookaheadSamples,
    apply,
  };
}

/**
 * Combined magnitude response of the EQ section, for drawing the curve.
 * Uses the real getFrequencyResponse of the live filters, so the picture
 * cannot drift away from what the audio is doing.
 */
export function eqResponse(chain, state, freqs) {
  const n = freqs.length;
  const mag = new Float32Array(n).fill(1);
  const m = new Float32Array(n);
  const ph = new Float32Array(n);

  const parts = [];
  if (state.hpf.on) parts.push(chain.nodes.hpf);
  chain.nodes.bands.forEach((b, i) => { if (state.eq[i].gain !== 0) parts.push(b); });
  if (state.lpf.on) parts.push(chain.nodes.lpf);

  for (const f of parts) {
    f.getFrequencyResponse(freqs, m, ph);
    for (let i = 0; i < n; i++) mag[i] *= m[i];
  }
  return mag;
}
