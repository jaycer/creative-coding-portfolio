// presets.js — starting points, not destinations.
//
// Each one is a full state object, so loading a preset moves every control at
// once and you can always see exactly what it did. They are written to be
// *conservative*: a preset that lands you in the right neighborhood and asks
// you to taste is more useful than one that slams everything and calls it
// mastered.

import { defaultState } from './chain.js';

function preset(name, blurb, mutate) {
  const s = defaultState();
  s.preset = name;
  mutate(s);
  return { name, blurb, state: s };
}

// eq band order matches EQ_BANDS: [low shelf, low mid, mid, presence, air]
const LS = 0, LM = 1, MID = 2, PRES = 3, AIR = 4;

export const PRESETS = [
  preset('Flat', 'Everything neutral. The chain is still live, so you can build from zero.', (s) => {
    s.comp.on = false;
    s.limiter.on = true;
    s.limiter.drive = 0;
  }),

  preset('Glue', 'Gentle bus compression for a finished mix. Slow, sidechained off the bass, mostly parallel.', (s) => {
    s.hpf.on = true; s.hpf.freq = 24;
    Object.assign(s.comp, {
      on: true, threshold: -16, ratio: 2, knee: 10,
      attack: 0.025, release: 0.28, makeup: 2, mix: 0.75,
      sidechainHz: 80, rmsBlend: 0.6,
    });
    s.sat = { on: true, mode: 'soft', drive: 4, mix: 0.3 };
    s.limiter = { on: true, drive: 2, ceiling: -1, release: 0.3 };
  }),

  preset('Voice', 'Spoken word. High-pass the rumble, scoop the boxiness, lift presence, and level it hard.', (s) => {
    s.hpf.on = true; s.hpf.freq = 85;
    s.eq[LM] = { freq: 320, gain: -2.5, q: 1.1 };
    s.eq[PRES] = { freq: 4200, gain: 2.5, q: 0.9 };
    s.eq[AIR] = { freq: 11000, gain: 1.5, q: 0.7 };
    Object.assign(s.comp, {
      on: true, threshold: -24, ratio: 3.5, knee: 8,
      attack: 0.008, release: 0.14, makeup: 5, mix: 1,
      sidechainHz: 0, rmsBlend: 0.5,
    });
    s.limiter = { on: true, drive: 3, ceiling: -1.5, release: 0.2 };
    s.output = -1;
  }),

  preset('Podcast', 'Broadcast-style leveling that keeps quiet talkers audible. Aims near -16 LUFS.', (s) => {
    s.hpf.on = true; s.hpf.freq = 70;
    s.eq[LM] = { freq: 280, gain: -1.5, q: 1.0 };
    s.eq[PRES] = { freq: 3600, gain: 2, q: 0.8 };
    Object.assign(s.comp, {
      on: true, threshold: -28, ratio: 5, knee: 10,
      attack: 0.015, release: 0.35, makeup: 8, mix: 1,
      sidechainHz: 0, rmsBlend: 0.8,
    });
    s.limiter = { on: true, drive: 2, ceiling: -1.5, release: 0.35 };
    s.output = -2;
  }),

  preset('Punch', 'Drums and rhythm. Slow attack so the hit lands first, parallel blend so it stays alive.', (s) => {
    s.hpf.on = true; s.hpf.freq = 30;
    s.eq[LS] = { freq: 80, gain: 2, q: 0.7 };
    s.eq[PRES] = { freq: 5000, gain: 1.5, q: 0.8 };
    Object.assign(s.comp, {
      on: true, threshold: -20, ratio: 4, knee: 4,
      attack: 0.022, release: 0.09, makeup: 4, mix: 0.6,
      sidechainHz: 40, rmsBlend: 0,
    });
    s.sat = { on: true, mode: 'warm', drive: 7, mix: 0.4 };
    s.limiter = { on: true, drive: 1, ceiling: -1, release: 0.15 };
  }),

  preset('Warmth', 'Tape-flavored saturation and a soft top end. Barely any compression.', (s) => {
    s.eq[AIR] = { freq: 9000, gain: -1, q: 0.7 };
    s.eq[LS] = { freq: 120, gain: 1.5, q: 0.7 };
    Object.assign(s.comp, {
      on: true, threshold: -12, ratio: 1.6, knee: 12,
      attack: 0.03, release: 0.4, makeup: 1, mix: 0.6,
      sidechainHz: 60, rmsBlend: 0.7,
    });
    s.sat = { on: true, mode: 'tape', drive: 10, mix: 0.55 };
    s.limiter = { on: true, drive: 0, ceiling: -1, release: 0.35 };
  }),

  preset('Streaming', 'Aim at the -14 LUFS the platforms normalize to, with true-peak headroom to spare.', (s) => {
    s.hpf.on = true; s.hpf.freq = 26;
    s.eq[AIR] = { freq: 12000, gain: 1, q: 0.7 };
    Object.assign(s.comp, {
      on: true, threshold: -18, ratio: 2.2, knee: 10,
      attack: 0.02, release: 0.25, makeup: 3, mix: 0.8,
      sidechainHz: 90, rmsBlend: 0.6,
    });
    s.sat = { on: true, mode: 'soft', drive: 3, mix: 0.25 };
    s.limiter = { on: true, drive: 3, ceiling: -1.2, release: 0.25 };
  }),

  preset('Loud', 'For when it has to compete. Heavy limiting; watch the gain reduction meter and back off.', (s) => {
    s.hpf.on = true; s.hpf.freq = 30;
    s.eq[LS] = { freq: 70, gain: 1.5, q: 0.7 };
    s.eq[AIR] = { freq: 11000, gain: 2, q: 0.7 };
    Object.assign(s.comp, {
      on: true, threshold: -22, ratio: 3, knee: 8,
      attack: 0.015, release: 0.16, makeup: 4, mix: 0.85,
      sidechainHz: 100, rmsBlend: 0.5,
    });
    s.sat = { on: true, mode: 'soft', drive: 8, mix: 0.45 };
    s.limiter = { on: true, drive: 7, ceiling: -1, release: 0.18 };
  }),
];
