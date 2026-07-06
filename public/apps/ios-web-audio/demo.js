// Demo harness for ios-web-audio.js. Everything iOS-specific lives in the
// imported module; this file is just the instrument around it — a soft pad
// tone, a live oscilloscope, and the telemetry readout that proves it worked.
import { makeUnlockableAudioContext, detectPlatform } from './ios-web-audio.js';

const AMBER = '#ffb84d';
const AMBER_DIM = '#6f5220';
const ALERT = '#ff5c4d';

// "tap" on touch devices, "click" on pointer devices.
const WORD =
  window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'tap' : 'click';

const el = (id) => document.getElementById(id);
const canvas = el('scope');
const cctx = canvas.getContext('2d');
const btn = el('unlock');
const statusEl = el('status');
const dot = el('statedot');

let audio = null;      // { ctx, unlock } from the module
let analyser = null;   // set once the graph is live
let masterGain = null; // envelope + tremolo live here
let muteGain = null;   // dedicated mute control — the LFO never touches this one
let data = null;       // time-domain sample buffer
let muted = false;
let running = false;

// --- Copy the device word into the interactive copy up front ----------------
btn.querySelector('.label').textContent = `${WORD} to unlock audio`;
setStatus('silenced', `Audio is locked. ${cap(WORD)} to prove it can play.`);

// --- Oscilloscope -----------------------------------------------------------
// The signature: a dim amber flatline while silenced, a bright live trace once
// real samples flow. Driven by an AnalyserNode, so the waveform is the proof —
// if it moves, sound is genuinely running on this device.
const reduceMotion =
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', sizeCanvas);
sizeCanvas();

function drawScope() {
  requestAnimationFrame(drawScope);
  const w = canvas.width / (Math.min(window.devicePixelRatio || 1, 2));
  const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2));
  cctx.clearRect(0, 0, w, h);

  // Center graticule line.
  cctx.strokeStyle = 'rgba(255,184,77,0.10)';
  cctx.lineWidth = 1;
  cctx.beginPath();
  cctx.moveTo(0, h / 2);
  cctx.lineTo(w, h / 2);
  cctx.stroke();

  const live = analyser && running && !muted;
  cctx.lineWidth = live ? 2 : 1.5;
  cctx.strokeStyle = live ? AMBER : AMBER_DIM;
  if (live && !reduceMotion) {
    cctx.shadowColor = AMBER;
    cctx.shadowBlur = 12;
  } else {
    cctx.shadowBlur = 0;
  }

  cctx.beginPath();
  if (live) {
    analyser.getByteTimeDomainData(data);
    const step = w / data.length;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;          // -1..1
      const y = h / 2 + v * (h * 0.42);
      i === 0 ? cctx.moveTo(0, y) : cctx.lineTo(i * step, y);
    }
  } else {
    // Silenced: a flat line with a barely-there idle wobble.
    cctx.moveTo(0, h / 2);
    cctx.lineTo(w, h / 2);
  }
  cctx.stroke();
  cctx.shadowBlur = 0;
}
requestAnimationFrame(drawScope);

// --- The pad voice ----------------------------------------------------------
// Three detuned triangle oscillators in an A-minor triad, softened by a lowpass
// and a slow tremolo. Warm and obviously musical, so "it works" is unmistakable.
function buildGraph(ctx) {
  masterGain = ctx.createGain();
  masterGain.gain.value = 0;

  // Mute lives on its own node. If it shared masterGain with the tremolo, the
  // LFO's connected signal would keep adding to the gain param and a quiet tone
  // would leak through even at "0" — audible on iOS. A clean node mutes fully.
  muteGain = ctx.createGain();
  muteGain.gain.value = 1;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1300;
  lowpass.Q.value = 0.6;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  data = new Uint8Array(analyser.fftSize);

  lowpass.connect(masterGain);
  masterGain.connect(muteGain);
  muteGain.connect(ctx.destination);
  muteGain.connect(analyser);             // tap after mute, so the scope reads true output

  // A-minor triad: A3, C4, E4, each slightly detuned so the unison shimmers.
  for (const [freq, det] of [[220, -4], [261.63, 3], [329.63, -2]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = det;
    osc.connect(lowpass);
    osc.start();
  }

  // Slow tremolo on the master, for a gentle breathing pad.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.15;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.03;
  lfo.connect(lfoDepth);
  lfoDepth.connect(masterGain.gain);
  lfo.start();

  // Ease the pad in.
  masterGain.gain.setValueAtTime(0, ctx.currentTime);
  masterGain.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 1.2);
}

// --- Unlock flow ------------------------------------------------------------
// pointerup, not pointerdown — the whole point (see THE GESTURE in the module).
btn.addEventListener('pointerup', async () => {
  if (!running) {
    audio = makeUnlockableAudioContext();
    audio.ctx.addEventListener('statechange', refreshTelemetry);
    buildGraph(audio.ctx);

    const t0 = performance.now();
    const ok = await audio.unlock();
    const startupMs = Math.round(performance.now() - t0);

    running = ok;
    if (ok) {
      btn.classList.add('is-live');
      btn.querySelector('.label').textContent = `${WORD} to mute`;
      setStatus('running', 'Sound is live. The trace above is the real output.');
    } else {
      setStatus('blocked', `Still locked — ${WORD} once more to unlock.`);
    }
    refreshTelemetry(startupMs);
  } else {
    // Second gesture onward: mute / unmute. Ramp to an exact 0/1 (setTargetAtTime
    // only asymptotes toward its target and never truly reaches it).
    muted = !muted;
    const t = audio.ctx.currentTime;
    muteGain.gain.cancelScheduledValues(t);
    muteGain.gain.setValueAtTime(muteGain.gain.value, t);
    muteGain.gain.linearRampToValueAtTime(muted ? 0 : 1, t + 0.12);
    btn.classList.toggle('is-muted', muted);
    btn.querySelector('.label').textContent = `${WORD} to ${muted ? 'unmute' : 'mute'}`;
    setStatus(muted ? 'silenced' : 'running',
      muted ? 'Muted.' : 'Sound is live. The trace above is the real output.');
  }
});

// --- Telemetry --------------------------------------------------------------
const plat = detectPlatform();

function field(id, value, tone) {
  const node = el(id);
  if (!node) return;
  node.textContent = value;
  node.dataset.tone = tone || '';
}

function refreshTelemetry(startupMs) {
  const ctx = audio && audio.ctx;
  field('t-state', ctx ? ctx.state : 'suspended', ctx && ctx.state === 'running' ? 'ok' : 'warn');
  field('t-rate', ctx ? `${ctx.sampleRate} Hz` : '—');
  const lat = ctx ? (ctx.outputLatency || ctx.baseLatency || 0) : 0;
  field('t-latency', lat ? `${Math.round(lat * 1000)} ms` : '—');
  const hasSession = 'audioSession' in navigator;
  field('t-session', hasSession ? 'playback' : 'unavailable', hasSession ? 'ok' : 'dim');
  field('t-platform', plat.label, plat.isIOS ? 'ok' : 'dim');
  field('t-ringer', hasSession ? 'bypassed ✓' : 'n/a on this OS', hasSession ? 'ok' : 'dim');
  if (typeof startupMs === 'number') field('t-startup', `${startupMs} ms`);
}
refreshTelemetry();

// --- Status line ------------------------------------------------------------
function setStatus(state, message) {
  statusEl.textContent = message;
  dot.dataset.state = state;         // silenced | running | blocked
  el('status-tag').textContent = state.toUpperCase();
  el('status-tag').dataset.state = state;
}

// --- Copy the source snippet ------------------------------------------------
const copyBtn = el('copy');
if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el('snippet').textContent);
      copyBtn.textContent = 'copied';
      setTimeout(() => (copyBtn.textContent = 'copy'), 1400);
    } catch {
      copyBtn.textContent = 'select all + copy';
    }
  });
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
