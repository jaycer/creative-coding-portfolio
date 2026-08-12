// V2A — starting points.
//
// Every field here is a real unit (Hz, milliseconds, 0..1), never a slider
// position, so a preset reads as a description of a sound and survives any
// later change to how the sliders are scaled. Loading one runs through exactly
// the same path a saved settings file does.

export const PRESETS = [
  {
    name: 'Spectrogram',
    note: 'The frame read as a picture of sound, left to right.',
    cfg: {
      mode: 'scan', bands: 48, rate: 0.5, dir: 'lr',
      fLow: 110, fHigh: 3520, scale: 'off', root: 0,
      wave: 'sine', glide: 8, attack: 8, release: 120,
      gate: 0.22, contrast: 1.6, invert: false,
      width: 0.8, space: 0.25, tone: 9000,
    },
  },
  {
    name: 'Chimes',
    note: 'Color picks the note. Point it at something with paint on it.',
    cfg: {
      mode: 'hue', bands: 24, rate: 0.5, dir: 'lr',
      fLow: 220, fHigh: 2093, scale: 'pentatonic', root: 0,
      wave: 'triangle', glide: 70, attack: 6, release: 900,
      gate: 0.25, contrast: 1.2, invert: false,
      width: 1, space: 0.6, tone: 7000,
    },
  },
  {
    name: 'Drone',
    note: 'The whole frame at once, low and slow. Barely reacts, never stops.',
    cfg: {
      mode: 'spectrum', bands: 16, rate: 0.5, dir: 'lr',
      fLow: 55, fHigh: 880, scale: 'fifths', root: 2,
      wave: 'sine', glide: 40, attack: 500, release: 1400,
      gate: 0.12, contrast: 1, invert: false,
      width: 0.7, space: 0.5, tone: 2600,
    },
  },
  {
    name: 'Radar',
    note: 'A fast sweep on a minor scale. Walk in front of it.',
    cfg: {
      mode: 'scan', bands: 32, rate: 1.6, dir: 'ping',
      fLow: 165, fHigh: 1760, scale: 'minor', root: 9,
      wave: 'sawtooth', glide: 6, attack: 4, release: 90,
      gate: 0.34, contrast: 2, invert: false,
      width: 1, space: 0.35, tone: 2400,
    },
  },
  {
    name: 'Motion Bells',
    note: 'Silence until something moves, then a struck chord.',
    cfg: {
      mode: 'motion', bands: 20, rate: 0.5, dir: 'lr',
      fLow: 330, fHigh: 3136, scale: 'major', root: 5,
      wave: 'triangle', glide: 10, attack: 3, release: 700,
      gate: 0.1, contrast: 0.8, invert: false,
      width: 0.9, space: 0.55, tone: 8000,
    },
  },
  {
    name: 'Night Vision',
    note: 'Inverted, so the dark parts sing. Good in a lit room.',
    cfg: {
      mode: 'spectrum', bands: 40, rate: 0.5, dir: 'lr',
      fLow: 80, fHigh: 2400, scale: 'wholetone', root: 0,
      wave: 'square', glide: 25, attack: 120, release: 600,
      gate: 0.4, contrast: 1.8, invert: true,
      width: 1, space: 0.45, tone: 1800,
    },
  },
];

/** What a cold open sounds like. */
export const DEFAULT_CFG = PRESETS[0].cfg;
