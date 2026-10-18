#!/usr/bin/env node
// Synthesize a drum track as a WAV, for handing to Chrome as a fake microphone.
//
// Chrome plays a 16-bit PCM WAV into getUserMedia when launched with
// --use-file-for-fake-audio-capture, which gives anything that listens to the
// room an input whose tempo and phase are known to the sample. shoot.mjs --mic
// uses this. The file loops, so it is made minutes long: one that runs out
// mid-run looks exactly like a detector falling apart.
//
//   node tools/make-beat-wav.mjs --bpm 128 --out /tmp/beat-128.wav
//   node tools/make-beat-wav.mjs --noise --out /tmp/noise.wav     # loud, no beat
//   node tools/make-beat-wav.mjs --silence --out /tmp/quiet.wav   # near nothing
//
// Kick on every beat, snare on 2 and 4, closed hat on the eighths, and a bass
// note under the kick, so there is something in every band the apps read.

import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const RATE = 48000;
const bpm = Number(opt('bpm', 120));
const seconds = Number(opt('seconds', 240));
const out = opt('out', `beat-${bpm}.wav`);
const N = Math.floor(RATE * seconds);
const buf = new Float32Array(N);

// xorshift32, with Math.imul so nothing leaves 32 bits. The obvious LCG in
// doubles loses precision above 2^53 and collapses into a short cycle, which
// makes "noise" that repeats every second or so, and a beat tracker finds it.
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  seed = Math.imul(seed, 1) | 0;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
};

if (flag('noise')) {
  for (let i = 0; i < N; i++) buf[i] = rnd() * 0.5;
} else if (flag('silence')) {
  for (let i = 0; i < N; i++) buf[i] = rnd() * 0.0005;
} else {
  const beat = 60 / bpm;
  const add = (at, len, fn) => {
    const s = Math.floor(at * RATE), e = Math.min(N, s + Math.floor(len * RATE));
    for (let i = s; i < e; i++) buf[i] += fn((i - s) / RATE);
  };
  for (let b = 0; b * beat < seconds; b++) {
    const t0 = b * beat;
    // kick: a sine sweeping 150 -> 45 Hz over 180 ms
    add(t0, 0.25, (t) => Math.sin(2 * Math.PI * (45 * t + 4.2 * (1 - Math.exp(-t / 0.04)))) * Math.exp(-t / 0.08) * 0.8);
    // bass note under it
    add(t0, beat * 0.9, (t) => Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.3) * 0.25);
    if (b % 2 === 1) {
      // snare on 2 and 4: noise burst plus a 200 Hz body
      add(t0, 0.2, (t) => (rnd() * 0.5 + Math.sin(2 * Math.PI * 200 * t) * 0.4) * Math.exp(-t / 0.06) * 0.6);
    }
    for (let h = 0; h < 2; h++) {
      // hats on the eighths, quieter off the beat
      add(t0 + h * beat / 2, 0.06, (t) => rnd() * Math.exp(-t / 0.015) * (h ? 0.18 : 0.25));
    }
  }
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
// Normalized to -1 dBFS, except silence, whose whole point is its level.
const gain = flag('silence') ? 1 : peak > 0 ? 0.9 / peak : 1;

const wav = Buffer.alloc(44 + N * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + N * 2, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i] * gain)) * 32767), 44 + i * 2);
writeFileSync(out, wav);
console.log('wrote', out, `${seconds}s at ${flag('noise') ? 'noise' : flag('silence') ? 'silence' : bpm + ' BPM'}`);
