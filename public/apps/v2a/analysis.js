// V2A — reading a video frame as a set of tones.
//
// Everything here is pixels in, three parallel arrays out: for each band, how
// loud it is (`amps`), where it sits in the stereo field (`pans`), and what
// pitch it sings (`freqs`). The audio engine never sees an image and this file
// never sees an AudioContext, which is the whole reason the mapping modes are
// cheap to add: a mode is one function over an ImageData.
//
// The band grid is a resampling of the *whole* frame, not a crop of it. The
// offscreen canvas is sized so that one pixel is one band (or one cell), and
// drawImage does the averaging on the way down — a 1920x1080 frame squeezed
// into 160x32 is 32 honest row averages, computed by the GPU, for free.

/** Band counts the slider steps through. Every one factors well for the grid
 *  that Hue mode needs — a prime count would leave it a 23x1 strip. */
export const BAND_STEPS = [8, 12, 16, 20, 24, 32, 40, 48, 64];

/** Columns in the offscreen frame for the row-reading modes. Wider than it
 *  needs to be for Spectrum, but Scan reads one column at a time and 160 of
 *  them is a sweep with somewhere to go. */
export const SCAN_COLS = 160;

/** Frame differences are small numbers — a hand crossing the frame moves a
 *  given row by a few percent, not by half. Motion mode is unusable without
 *  this on the front of it. */
const MOTION_GAIN = 7;

export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Pitch-class sets, as semitone offsets from the root. `off` is the absence of
 *  a scale: bands land on a continuous log sweep instead of on notes. */
export const SCALES = {
  off:        null,
  chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],
  wholetone:  [0, 2, 4, 6, 8, 10],
  fifths:     [0, 7],
  harmonic:   'harmonic',   // not equal temperament — handled on its own below
};

/** "440 Hz" is not a thing anyone can picture. "A4" is. */
export function noteName(f) {
  if (!(f > 0)) return '--';
  const m = Math.round(12 * Math.log2(f / 440) + 69);
  return NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** The pitch class `pc` in the octave at or just below `target` Hz. Only the
 *  class matters for the equal-tempered scales, since the list below spans
 *  every octave in range anyway — but the harmonic series is built by
 *  multiplying up from its root, so that root has to start at the bottom. */
function rootFreqNear(pc, target) {
  let f = 440 * Math.pow(2, (pc - 9) / 12);   // the note in octave 4
  while (f > target) f /= 2;
  while (f * 2 <= target) f *= 2;
  return f;
}

/**
 * Every pitch the current scale allows between fLow and fHigh, ascending.
 * Returns null for `off`, which the callers read as "use a continuous sweep".
 */
export function scaleFreqList(fLow, fHigh, scale, rootPc) {
  if (!scale || scale === 'off' || !SCALES[scale]) return null;
  const root = rootFreqNear(rootPc, fLow);
  const out = [];
  if (scale === 'harmonic') {
    for (let k = 1; k <= 256; k++) {
      const f = root * k;
      if (f > fHigh) break;
      if (f >= fLow) out.push(f);
    }
  } else {
    const set = SCALES[scale];
    for (let s = -12; s <= 144; s++) {
      if (set.indexOf(((s % 12) + 12) % 12) === -1) continue;
      const f = root * Math.pow(2, s / 12);
      if (f > fHigh) break;
      if (f >= fLow) out.push(f);
    }
  }
  // A range narrower than the gap between two allowed notes. Rather than fall
  // silent, give it the one pitch that fits.
  if (!out.length) out.push(Math.min(fHigh, Math.max(fLow, root)));
  return out;
}

/**
 * The pitch of each band, in row order — index 0 is the top of the frame.
 * Top is high: that is the convention every spectrogram in the world uses, and
 * pointing a camera at the sky should sound bright.
 */
export function buildBandFreqs(n, fLow, fHigh, scale, rootPc, out) {
  const dst = out && out.length >= n ? out : new Float64Array(n);
  const list = scaleFreqList(fLow, fHigh, scale, rootPc);
  const last = Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const u = i / last;                       // 0 at the bottom band, 1 at the top
    dst[n - 1 - i] = list
      ? list[Math.round(u * (list.length - 1))]
      : fLow * Math.pow(fHigh / fLow, u);
  }
  return dst;
}

/** The factor pair of `n` closest to 16:9, for Hue mode's cell grid. */
export function gridFor(n) {
  let cols = n, rows = 1, best = Infinity;
  for (let c = 1; c <= n; c++) {
    if (n % c) continue;
    const r = n / c;
    const err = Math.abs(Math.log((c / r) / (16 / 9)));
    if (err < best) { best = err; cols = c; rows = r; }
  }
  return { cols, rows };
}

/** Rec. 709 luma, 0..1. */
function lum(d, p) {
  return (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;
}

export class Analyzer {
  constructor(maxBands = 64) {
    this.canvas = document.createElement('canvas');
    // Every frame ends in a getImageData, which is the one thing that makes a
    // GPU-backed 2D context worse than a software one. Say so up front.
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.w = 0;
    this.h = 0;
    this.prev = null;         // last frame's luma, for Motion
    this.hasPrev = false;
    this.amps = new Float32Array(maxBands);
    this.pans = new Float32Array(maxBands);
    this.freqs = new Float64Array(maxBands);
    this.scanX = 0;           // 0..1, where the read head last landed
  }

  /** Size the offscreen frame so one pixel is one band (or one Hue cell). */
  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.prev = new Float32Array(w * h);
    this.hasPrev = false;
  }

  /** The frame shape a given config wants. */
  shapeFor(cfg) {
    if (cfg.mode === 'hue') {
      const g = gridFor(cfg.bands);
      return { w: g.cols, h: g.rows };
    }
    return { w: SCAN_COLS, h: cfg.bands };
  }

  /**
   * Read one frame. `cfg.scanPhase` is 0..1 and belongs to the caller, so that
   * holding a frame holds the scan line with it.
   * Returns the analyzer's own buffers — read them before the next call.
   */
  read(video, cfg) {
    const shape = this.shapeFor(cfg);
    this.resize(shape.w, shape.h);

    const ctx = this.ctx;
    const { w, h } = this;
    ctx.save();
    if (cfg.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    // The whole frame, stretched onto the band grid. Not a crop: every part of
    // the picture should be audible, and the preview letterboxes to match.
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();

    const px = ctx.getImageData(0, 0, w, h).data;
    if (cfg.mode === 'hue') this._hue(px, cfg);
    else if (cfg.mode === 'motion') this._motion(px, cfg);
    else if (cfg.mode === 'scan') this._scan(px, cfg);
    else this._spectrum(px, cfg);

    return { amps: this.amps, pans: this.pans, freqs: this.freqs, n: cfg.bands };
  }

  /** Contrast, gate, and invert, applied the same way in every mode so the
   *  Image panel means one thing everywhere. */
  _shape(v, cfg) {
    if (cfg.invert) v = 1 - v;
    if (v <= cfg.gate) return 0;
    // Rescale above the gate rather than just clipping at it, so raising the
    // gate thins the texture out instead of turning everything down.
    v = (v - cfg.gate) / (1 - cfg.gate);
    return Math.pow(v, cfg.contrast);
  }

  /** A read head sweeping across the frame, one column at a time. The column
   *  is the spectrum: top row loud means a high partial is loud. */
  _scan(px, cfg) {
    const { w, h, amps, pans, freqs } = this;
    const cx = Math.min(w - 1, Math.max(0, Math.round(cfg.scanPhase * (w - 1))));
    this.scanX = cx / (w - 1);
    // Three columns, not one: a single column of a noisy sensor flickers, and
    // the sweep is slow enough that the smear is inaudible.
    const x0 = Math.max(0, cx - 1);
    const x1 = Math.min(w - 1, cx + 1);
    const cols = x1 - x0 + 1;
    // The whole column arrives from one place, so it is heard from one place.
    const pan = (this.scanX * 2 - 1) * cfg.width;
    for (let r = 0; r < h; r++) {
      let s = 0;
      for (let x = x0; x <= x1; x++) s += lum(px, (r * w + x) * 4);
      amps[r] = this._shape(s / cols, cfg);
      pans[r] = pan;
      freqs[r] = cfg.bandFreqs[r];
    }
  }

  /** The whole frame at once. Each row is one partial; a row's brightness is
   *  its level and the sideways center of that brightness is its pan. */
  _spectrum(px, cfg) {
    const { w, h, amps, pans, freqs } = this;
    for (let r = 0; r < h; r++) {
      let sum = 0, wsum = 0;
      for (let x = 0; x < w; x++) {
        const v = lum(px, (r * w + x) * 4);
        sum += v;
        wsum += v * x;
      }
      amps[r] = this._shape(sum / w, cfg);
      // An unlit row has no center of brightness to speak of. Leave it middle
      // rather than letting 0/0 throw it hard left.
      const c = sum > 1e-4 ? wsum / sum / (w - 1) : 0.5;
      pans[r] = (c * 2 - 1) * cfg.width;
      freqs[r] = cfg.bandFreqs[r];
    }
  }

  /** Same rows, but the level is how much the row *changed*. A still room is
   *  silent; a hand crossing it plays a chord. */
  _motion(px, cfg) {
    const { w, h, amps, pans, freqs, prev } = this;
    const first = !this.hasPrev;
    for (let r = 0; r < h; r++) {
      let sum = 0, wsum = 0;
      for (let x = 0; x < w; x++) {
        const i = r * w + x;
        const v = lum(px, i * 4);
        const d = first ? 0 : Math.abs(v - prev[i]) * MOTION_GAIN;
        prev[i] = v;
        sum += d;
        wsum += d * x;
      }
      const m = Math.min(1, sum / w);
      // Motion is already a difference, so inverting it would mean "loud where
      // nothing happened", which is not what the Invert switch promises
      // anywhere else. Gate and contrast still apply.
      amps[r] = m <= cfg.gate ? 0 : Math.pow((m - cfg.gate) / (1 - cfg.gate), cfg.contrast);
      const c = sum > 1e-4 ? wsum / sum / (w - 1) : 0.5;
      pans[r] = (c * 2 - 1) * cfg.width;
      freqs[r] = cfg.bandFreqs[r];
    }
    this.hasPrev = true;
  }

  /** A grid of cells, each one a voice. Color picks the note, so this is the
   *  mode where a red couch and a blue sky are different chords rather than
   *  different loudnesses. */
  _hue(px, cfg) {
    const { w, h, amps, pans, freqs } = this;
    const list = cfg.scaleList;
    const n = Math.min(cfg.bands, w * h);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const r = px[p] / 255, g = px[p + 1] / 255, b = px[p + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      let hue = 0;
      if (d > 1e-6) {
        if (max === r) hue = ((g - b) / d + 6) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue /= 6;
      }
      const sat = max > 1e-6 ? d / max : 0;
      // Value is the level, but a gray cell has no opinion about pitch, so
      // saturation decides how much of that level it keeps. The floor is 0.4
      // and not lower: at 0.25 an ordinary indoor scene — painted walls, wood,
      // upholstery, all of it well under half saturated — landed the whole
      // frame under a mid gate and the mode played nothing at all.
      amps[i] = this._shape(max * (0.4 + 0.6 * sat), cfg);
      freqs[i] = list
        ? list[Math.min(list.length - 1, Math.floor(hue * list.length))]
        : cfg.fLow * Math.pow(cfg.fHigh / cfg.fLow, hue);
      const col = i % w;
      pans[i] = ((w > 1 ? col / (w - 1) : 0.5) * 2 - 1) * cfg.width;
    }
    for (let i = n; i < cfg.bands; i++) amps[i] = 0;
  }
}
