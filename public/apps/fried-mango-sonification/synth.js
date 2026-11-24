// synth.js — the score played on a sound chip that never existed.
//
// Four kinds of voice, the ones an 8-bit console had: pulse waves of a fixed
// width, a triangle, and noise. Each track is one voice into its own fader,
// and the faders meet at a master. No filters on the pitched voices and
// nearly square envelopes, because that bluntness is the sound. The beat is
// the exception: a kick and a clap with some weight, for the chips to sit on.
//
// The same code plays live and renders a file: it only schedules nodes on
// whatever context it is given, an AudioContext or an OfflineAudioContext.

import { TRACKS, DRUM } from './sonify.js';

const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

// A pulse wave of a given duty cycle, as its Fourier series.
function pulseWave(ctx, duty) {
  const N = 64;
  const real = new Float32Array(N), imag = new Float32Array(N);
  for (let n = 1; n < N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag);
}

// One second of noise, the same second every time, so a render is repeatable.
function noiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 0x2545f491;
  for (let i = 0; i < data.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    data[i] = ((seed >>> 0) / 2147483648) - 1;
  }
  return buf;
}

/**
 * Build the mixer on a context.
 * @returns {{ ctx, master: GainNode, faders: Record<string, GainNode>,
 *             setLevel(id: string, v: number): void, setMaster(v: number): void,
 *             play(e, when: number, secPerBeat: number): void }}
 */
export function createSynth(ctx) {
  // No limiter on the master. The browser's compressor adds makeup gain of
  // its own and does not render the same way twice, and a score that is the
  // same every time should be a file that is too. The default levels leave
  // headroom, and the WAV is turned down if a mix still goes over.
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  const faders = {};
  for (const t of TRACKS) {
    const g = ctx.createGain();
    g.gain.value = t.level;
    g.connect(master);
    faders[t.id] = g;
  }

  // The offers ring: a short echo, the one effect on the board.
  const echo = ctx.createDelay(1);
  echo.delayTime.value = 0.1875;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.35;
  const echoOut = ctx.createGain();
  echoOut.gain.value = 0.5;
  echo.connect(feedback).connect(echo);
  echo.connect(echoOut).connect(faders.offers);

  const waves = { p12: pulseWave(ctx, 0.125), p25: pulseWave(ctx, 0.25), p50: pulseWave(ctx, 0.5) };
  const noise = noiseBuffer(ctx);
  const VOICE = { postings: 'triangle', pursued: 'p12', applied: 'p25', interviews: 'p50', offers: 'p50' };

  // A short note has a flat top: up in a couple of milliseconds, down in a
  // few. A held one falls away to a low sustain first, the way a long chip
  // note was usually given a decay.
  function envelope(when, dur, peak) {
    const g = ctx.createGain();
    const end = when + Math.max(0.004, dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.003);
    if (dur > 1) {
      g.gain.setTargetAtTime(peak * 0.35, when + 0.05, dur / 4);
      g.gain.setTargetAtTime(0, end, 0.08);
    } else {
      g.gain.setValueAtTime(peak, end);
      g.gain.linearRampToValueAtTime(0, end + 0.012);
    }
    return g;
  }

  function tone(track, note, when, dur, vel) {
    const osc = ctx.createOscillator();
    const kind = VOICE[track];
    if (kind === 'triangle') osc.type = 'triangle'; else osc.setPeriodicWave(waves[kind]);
    osc.frequency.value = midiHz(note);
    const g = envelope(when, dur, vel * (kind === 'triangle' ? 0.9 : 0.5));
    osc.connect(g).connect(faders[track]);
    if (track === 'offers') g.connect(echo);
    osc.start(when);
    osc.stop(when + dur + 0.5);
  }

  // The techno kick: a sine dropping two octaves in a tenth of a second, with
  // a click on the front so it reads on a phone speaker.
  function kick(when, vel) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, when);
    osc.frequency.exponentialRampToValueAtTime(48, when + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, when);
    g.gain.setValueAtTime(vel, when + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
    osc.connect(g).connect(faders.beat);
    osc.start(when);
    osc.stop(when + 0.32);
    hiss('beat', when, vel * 0.25, 0.012, 1, 2000, 0.2);
  }

  // A clap is three quick bursts and a tail, through a band around 1.5 kHz.
  function clap(when, vel, offset) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    for (let i = 0; i < 3; i++) {
      g.gain.setValueAtTime(vel * 0.9, when + i * 0.011);
      g.gain.exponentialRampToValueAtTime(vel * 0.2, when + i * 0.011 + 0.009);
    }
    g.gain.setValueAtTime(vel * 0.8, when + 0.033);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
    src.connect(bp).connect(g).connect(faders.beat);
    src.start(when, offset);
    src.stop(when + 0.22);
  }

  // `offset` picks where in the noise a hit starts, so hits differ from each
  // other but the same hit is the same every time.
  function hiss(track, when, vel, decay, rate, highpass, offset) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = rate;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + decay);
    src.connect(hp).connect(g).connect(faders[track]);
    src.start(when, offset);
    src.stop(when + decay + 0.02);
  }

  function play(e, when, secPerBeat) {
    const dur = e.dur * secPerBeat;
    if (e.track === 'beat') {
      if (e.note === DRUM.kick) kick(when, e.vel);
      else if (e.note === DRUM.clap) clap(when, e.vel, (e.beat * 0.23) % 0.9);
      else hiss('beat', when, e.vel * 0.45, 0.14, 1, 8000, (e.beat * 0.41) % 0.9);
    } else if (e.track === 'days') {
      hiss('days', when, e.vel * 0.8, 0.045, 1, 7000, (e.beat * 0.37) % 0.9);
    } else if (e.track === 'milestones') {
      hiss('milestones', when, e.vel * 0.6, Math.min(2.5, Math.max(0.6, dur)), 0.6, 3000, (e.beat * 0.11) % 0.9);
    } else {
      tone(e.track, e.note, when, dur, e.vel);
    }
  }

  return {
    ctx, master, faders, play,
    setLevel(id, v) { faders[id].gain.setTargetAtTime(v, ctx.currentTime, 0.015); },
    setMaster(v) { master.gain.setTargetAtTime(v, ctx.currentTime, 0.015); },
  };
}

/**
 * Render the whole score to a buffer, with the mixer as it stands.
 * @param score what sonify() returned
 * @param {{ bpm: number, levels: Record<string, number>, master: number, sampleRate?: number }} mix
 * @returns {Promise<AudioBuffer>}
 */
export async function renderScore(score, { bpm, levels, master, sampleRate = 44100 }) {
  const secPerBeat = 60 / bpm;
  // Exactly as long as the score, so it drops under a film of the same length.
  const seconds = score.beats * secPerBeat;
  const off = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const synth = createSynth(off);
  for (const t of TRACKS) synth.faders[t.id].gain.value = levels[t.id];
  synth.master.gain.value = master;
  for (const e of score.events) synth.play(e, e.beat * secPerBeat, secPerBeat);
  return off.startRendering();
}

/** A 16-bit stereo WAV. Turned down only if it would clip, and told so. */
export function encodeWav(buffer) {
  const frames = buffer.length, channels = buffer.numberOfChannels;
  const data = [];
  let peak = 0;
  for (let c = 0; c < channels; c++) {
    data.push(buffer.getChannelData(c));
    for (let i = 0; i < frames; i++) { const a = Math.abs(data[c][i]); if (a > peak) peak = a; }
  }
  const ceiling = 0.891;   // -1 dBFS
  const scale = peak > ceiling ? ceiling / peak : 1;
  const out = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const ascii = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); out.setUint32(4, 36 + frames * channels * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, channels, true);
  out.setUint32(24, buffer.sampleRate, true); out.setUint32(28, buffer.sampleRate * channels * 2, true);
  out.setUint16(32, channels * 2, true); out.setUint16(34, 16, true);
  ascii(36, 'data'); out.setUint32(40, frames * channels * 2, true);
  // The last 30 ms fade to nothing, so the file cannot end on a click.
  const fade = Math.min(frames, Math.round(buffer.sampleRate * 0.03));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const close = i >= frames - fade ? (frames - 1 - i) / fade : 1;
    for (let c = 0; c < channels; c++) {
      out.setInt16(o, Math.round(Math.max(-1, Math.min(1, data[c][i] * scale * close)) * 32767), true);
      o += 2;
    }
  }
  return { blob: new Blob([out.buffer], { type: 'audio/wav' }), peak, turnedDown: scale < 1 };
}
