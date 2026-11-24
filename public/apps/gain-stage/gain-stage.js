// gain-stage.js — the app around the DSP.
//
// Everything here is local by construction. A dropped file becomes an
// ArrayBuffer, an ArrayBuffer becomes an AudioBuffer, and it stays in this tab
// until you export it. There is no fetch() in this file, and no upload to be
// slow or to fail on a 200 MB stem.
//
// Layout of what follows:
//   1. state + formatting
//   2. audio graph lifecycle (create, tear down, A/B)
//   3. file / microphone input
//   4. transport + waveform + marks
//   5. the EQ display
//   6. controls, modules, presets
//   7. meters
//   8. export, and the project zip
//   9. save / load / keyboard

import {
  buildChain, loadWorklets, defaultState, cloneState,
  EQ_BANDS, eqResponse,
} from './chain.js';
import { PRESETS } from './presets.js';
import { encodeWav, downloadBlob } from './wav.js';
import { makeZip, readZip } from '../shared/zip.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const STORAGE_KEY = 'gain-stage:v1';

// ---------------------------------------------------------------- 1. state
let state = defaultState();

let ctx = null;
let chain = null;
let inputBus = null;   // everything the user feeds in arrives here, pre-trim
let dryDelay = null;   // aligns the untouched signal with the limiter's latency
let dryGain = null;
let wetGain = null;
let master = null;
let outMeter = null;
let analyser = null;
let specData = null;

let buffer = null;
let source = null;
let playing = false;
let playStart = 0;     // ctx time when the current source started
let playOffset = 0;    // buffer position that source started from
let pausedAt = 0;
let loopOn = true;
let region = { start: 0, end: 0 };
let bypassed = false;
let inputMode = 'file';
let micStream = null;
let micNode = null;
let trackLabel = '';
let sourceFile = null;  // the file as it was chosen, kept for the project zip

const fmtDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const fmtDbf = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '-inf');
const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const fmtSec = (s) => (s < 0.1 ? `${(s * 1000).toFixed(1)} ms` : s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const toDb = (a) => (a > 1e-7 ? 20 * Math.log10(a) : -Infinity);
const fmtClock = (t) => {
  if (!Number.isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ------------------------------------------------------- 2. audio lifecycle

// iOS needs the session set and resume() retried; see the ios-web-audio module
// in this gallery for the long version of why.
async function resumeCtx() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* < iOS 16.4 */ }
  for (let i = 0; i < 6 && ctx.state !== 'running'; i++) {
    // Outside a gesture WebKit leaves resume() pending rather than rejecting
    // it, so never wait on it alone: a file chosen from the picker is not a
    // gesture, and the load sat on "Decoding…" for good.
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 150))]);
    } catch { /* keep trying */ }
    if (ctx.state !== 'running') await new Promise((r) => setTimeout(r, 60));
  }
  return ctx.state === 'running';
}

async function teardownAudio() {
  stopSource();
  stopMic();
  if (ctx) { try { await ctx.close(); } catch { /* already gone */ } }
  ctx = chain = inputBus = dryDelay = dryGain = wetGain = master = outMeter = analyser = null;
}

// A context the phone will not start again. iOS leaves one behind after an
// interruption (the file picker, a call, a trip to another app): resume() is
// accepted on a tap and the context still never runs. The decoded buffer does
// not belong to a context, so the cure is a new one, and it has to be made
// inside the tap for iOS to let it run. Hence no await anywhere in here.
let ctxStale = false;
function discardAudio() {
  stopSource();
  stopMic();
  const old = ctx;
  ctx = chain = inputBus = dryDelay = dryGain = wetGain = master = outMeter = analyser = null;
  ctxStale = false;
  if (old) { try { old.close().catch(() => {}); } catch { /* already gone */ } }
}
const ctxNeedsReplacing = () => !!ctx && (ctxStale || ctx.state === 'closed' || ctx.state === 'interrupted');

/**
 * Bring up the graph, optionally at a specific sample rate.
 *
 * Matching the file's rate matters: decodeAudioData resamples to whatever the
 * context runs at, so a 44.1 kHz master decoded into a 48 kHz context comes
 * back resampled and exports at the wrong rate. When we can read the rate off
 * the file we build the context to match instead.
 */
async function ensureAudio(preferredRate, { running = true } = {}) {
  if (ctx && preferredRate && Math.abs(ctx.sampleRate - preferredRate) > 1 && inputMode === 'file') {
    await teardownAudio();
  }
  // Decoding needs a context but not a running one; only playback and the
  // microphone do, and those arrive on a gesture that is allowed to start it.
  if (ctx) { if (running) await resumeCtx(); return; }

  const Ctx = window.AudioContext || window.webkitAudioContext;
  try {
    ctx = preferredRate ? new Ctx({ sampleRate: preferredRate, latencyHint: 'interactive' }) : new Ctx();
  } catch {
    ctx = new Ctx();   // some browsers refuse an explicit rate; take what we get
  }

  await loadWorklets(ctx);
  chain = buildChain(ctx);

  inputBus = ctx.createGain();
  dryDelay = ctx.createDelay(0.5);
  dryDelay.delayTime.value = chain.lookaheadSamples / ctx.sampleRate;
  dryGain = ctx.createGain();
  dryGain.gain.value = bypassed ? 1 : 0;
  wetGain = ctx.createGain();
  wetGain.gain.value = bypassed ? 0 : 1;
  master = ctx.createGain();

  outMeter = new AudioWorkletNode(ctx, 'gs-meter', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { lufs: true, truePeak: true },
  });
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.75;
  specData = new Float32Array(analyser.frequencyBinCount);

  // Wet path through the chain; dry path delayed to match, so flipping A/B
  // does not also shift the audio 5 ms in time.
  inputBus.connect(chain.input);
  chain.output.connect(wetGain);
  wetGain.connect(master);
  inputBus.connect(dryDelay);
  dryDelay.connect(dryGain);
  dryGain.connect(master);
  master.connect(outMeter);
  outMeter.connect(analyser);
  analyser.connect(ctx.destination);

  chain.nodes.comp.port.onmessage = (e) => { meterVals.compGr = e.data.gr; };
  chain.nodes.limiter.port.onmessage = (e) => { meterVals.limGr = e.data.gr; };
  chain.nodes.inMeter.port.onmessage = (e) => { meterVals.inPeak = e.data.peak; };
  outMeter.port.onmessage = (e) => {
    meterVals.outPeak = e.data.peak;
    meterVals.truePeak = e.data.truePeak;
    meterVals.momentary = e.data.momentary;
    meterVals.shortTerm = e.data.shortTerm;
    meterVals.integrated = e.data.integrated;
    meterVals.clips = e.data.clips;
  };

  chain.apply(state, ctx.currentTime, 0);
  if (running) await resumeCtx();
  updateLatencyNote();
}

function pushAudio() {
  if (chain && ctx) chain.apply(state, ctx.currentTime, 0.02);
}

function setBypass(on) {
  bypassed = on;
  $('abBtn').setAttribute('aria-pressed', String(on));
  $('abBtn').classList.toggle('on', on);
  $('abBtn').textContent = on ? 'B · raw' : 'A/B';
  if (!ctx) return;
  const t = ctx.currentTime;
  wetGain.gain.setTargetAtTime(on ? 0 : 1, t, 0.006);
  dryGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.006);
}

function updateLatencyNote() {
  if (!ctx || !chain) { $('latencyNote').textContent = ''; return; }
  const ms = (chain.lookaheadSamples / ctx.sampleRate) * 1000;
  $('latencyNote').textContent = `${(ctx.sampleRate / 1000).toFixed(1)} kHz · ${ms.toFixed(1)} ms look-ahead`;
}

// ------------------------------------------------------------- 3. input

/**
 * Read the sample rate straight out of a RIFF/WAVE header.
 * Cheap, and it is the only way to know the rate *before* decoding commits us
 * to a context. Compressed formats fall back to the device rate.
 */
function sniffWavSampleRate(arrayBuffer) {
  if (arrayBuffer.byteLength < 44) return null;
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12;
  while (off + 8 <= v.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      const rate = v.getUint32(off + 12, true);
      return rate >= 8000 && rate <= 384000 ? rate : null;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

async function loadFile(file) {
  const note = $('srcNote');
  note.textContent = 'Decoding…';
  try {
    const arr = await file.arrayBuffer();
    const rate = sniffWavSampleRate(arr);
    stopMic();
    inputMode = 'file';
    if (ctxNeedsReplacing()) discardAudio();
    await ensureAudio(rate, { running: false });
    // decodeAudioData detaches the ArrayBuffer; nothing reads it afterwards.
    const decoded = await ctx.decodeAudioData(arr);
    stopSource();
    buffer = decoded;
    trackLabel = file.name.replace(/\.[^.]+$/, '');
    sourceFile = file;
    region = { start: 0, end: buffer.duration };
    pausedAt = 0;
    computePeaks();
    loadMarks();
    drawWave();
    resetMeters();

    $('trackName').textContent = file.name;
    $('trackMeta').textContent =
      `${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${buffer.numberOfChannels === 1 ? 'mono' : `${buffer.numberOfChannels} ch`} · ${fmtClock(buffer.duration)}`;
    note.textContent = 'Loaded locally, nothing uploaded';
    $('play').disabled = false;
    $('exportBtn').disabled = false;
    $('micBtn').classList.remove('live');
    $('micBtn').textContent = 'Use microphone';
    updateLatencyNote();
    return true;
  } catch (err) {
    note.textContent = 'Drop a file anywhere on this page';
    // Matching the file's sample rate can mean the context was torn down and
    // rebuilt before the decode failed. Any buffer decoded by the old context
    // is now attached to a closed one, so let it go rather than let Play throw.
    if (buffer && ctx && buffer.sampleRate !== ctx.sampleRate) {
      buffer = null;
      sourceFile = null;
      peaks = null;
      waveImage = null;
      loadMarks();
      $('play').disabled = true;
      $('exportBtn').disabled = true;
      $('trackName').textContent = 'No file loaded';
      $('trackMeta').textContent = 'wav · mp3 · flac · m4a · ogg';
      drawWave();
    }
    toast(`Could not decode that file (${err && err.name ? err.name : 'error'})`);
    return false;
  }
}

async function toggleMic() {
  if (micStream) {
    stopMic();
    $('micBtn').classList.remove('live');
    $('micBtn').textContent = 'Use microphone';
    $('srcNote').textContent = 'Drop a file anywhere on this page';
    return;
  }
  try {
    stopSource();
    inputMode = 'mic';
    if (ctxNeedsReplacing()) discardAudio();
    await ensureAudio();
    // Every browser "helpfulness" feature off — they are compressors and
    // filters of their own, and they would fight this chain.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, noiseSuppression: false,
        autoGainControl: false, channelCount: 2,
      },
    });
    micNode = ctx.createMediaStreamSource(micStream);
    micNode.connect(inputBus);
    resetMeters();
    $('micBtn').classList.add('live');
    $('micBtn').textContent = 'Stop microphone';
    $('srcNote').textContent = 'Live input — wear headphones';
    $('exportBtn').disabled = !buffer;
    toast('Live input on. Use headphones or it will feed back.');
  } catch {
    inputMode = 'file';
    toast('Microphone access was refused');
  }
}

function stopMic() {
  if (micNode) { try { micNode.disconnect(); } catch { /* gone */ } micNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
}

// --------------------------------------------------------- 4. transport

function stopSource() {
  if (source) {
    try { source.onended = null; source.stop(); } catch { /* already stopped */ }
    try { source.disconnect(); } catch { /* already gone */ }
    source = null;
  }
  playing = false;
  $('play').classList.remove('playing');
  $('play').setAttribute('aria-label', 'Play');
}

function currentPosition() {
  if (!buffer) return 0;
  if (!playing) return pausedAt;
  let t = playOffset + (ctx.currentTime - playStart);
  const len = region.end - region.start;
  if (loopOn && len > 0.01 && t > region.end) {
    t = region.start + ((t - region.start) % len);
  }
  return clamp(t, 0, buffer.duration);
}

async function startPlayback(from) {
  if (!buffer) return;
  // Still in the tap at this point, which is the only place a replacement
  // context can be made (see discardAudio).
  if (ctxNeedsReplacing()) discardAudio();
  await ensureAudio(ctx ? undefined : buffer.sampleRate);
  if (ctx.state !== 'running') {
    // Do not start a source on a clock that is not moving: it shows Pause and
    // sits at 0:00 with no sound. Say so, and build a fresh context next tap.
    ctxStale = true;
    stopSource();
    toast('Audio did not start. Tap Play again.');
    return;
  }
  stopSource();
  const at = clamp(from, 0, Math.max(0, buffer.duration - 0.01));
  source = ctx.createBufferSource();
  source.buffer = buffer;
  if (loopOn && region.end - region.start > 0.05) {
    source.loop = true;
    source.loopStart = region.start;
    source.loopEnd = region.end;
  }
  source.connect(inputBus);
  source.onended = () => {
    if (!source || source.loop) return;
    stopSource();
    pausedAt = 0;
  };
  source.start(0, at);
  playStart = ctx.currentTime;
  playOffset = at;
  playing = true;
  $('play').classList.add('playing');
  $('play').setAttribute('aria-label', 'Pause');
}

function togglePlay() {
  if (!buffer) return;
  if (playing) {
    pausedAt = currentPosition();
    stopSource();
  } else {
    startPlayback(pausedAt);
  }
}

// --------------------------------------------------------- 4b. waveform

let peaks = null;         // Float32Array of [min, max] pairs
let waveImage = null;     // pre-rendered waveform, redrawn only on resize
const PEAK_BUCKETS = 1600;

function computePeaks() {
  if (!buffer) { peaks = null; return; }
  const n = PEAK_BUCKETS;
  const out = new Float32Array(n * 2);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const per = buffer.length / n;
  // Scanning every sample of a long file costs hundreds of milliseconds and
  // buys nothing at 1600 buckets — sample up to 512 points per bucket instead.
  const stride = Math.max(1, Math.floor(per / 512));
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * per);
    const end = Math.min(buffer.length, Math.floor((i + 1) * per));
    let lo = 0, hi = 0;
    for (const data of chans) {
      for (let j = start; j < end; j += stride) {
        const v = data[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    out[i * 2] = lo;
    out[i * 2 + 1] = hi;
  }
  peaks = out;
  waveImage = null;
}

function sizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    return true;
  }
  return false;
}

function drawWave() {
  const cv = $('wave');
  const resized = sizeCanvas(cv);
  if (resized) waveImage = null;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;

  if (!peaks) {
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#1e222a';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#69717f';
    g.font = `${Math.round(H * 0.13)}px -apple-system, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('Drop an audio file to begin', W / 2, H / 2);
    return;
  }

  if (!waveImage) {
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const o = off.getContext('2d');
    o.fillStyle = '#1e222a';
    o.fillRect(0, 0, W, H);
    o.fillStyle = '#5a6472';
    const mid = H / 2;
    const n = peaks.length / 2;
    for (let x = 0; x < W; x++) {
      const i = Math.min(n - 1, Math.floor((x / W) * n));
      const lo = peaks[i * 2], hi = peaks[i * 2 + 1];
      const y0 = mid - hi * mid * 0.92;
      const y1 = mid - lo * mid * 0.92;
      o.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    waveImage = off;
  }

  g.clearRect(0, 0, W, H);
  g.drawImage(waveImage, 0, 0);

  // Dim whatever sits outside the loop region.
  if (buffer && (region.start > 0.001 || region.end < buffer.duration - 0.001)) {
    const x0 = (region.start / buffer.duration) * W;
    const x1 = (region.end / buffer.duration) * W;
    g.fillStyle = 'rgba(15,17,21,.66)';
    g.fillRect(0, 0, x0, H);
    g.fillRect(x1, 0, W - x1, H);
    g.strokeStyle = 'rgba(111,211,164,.5)';
    g.lineWidth = Math.max(1, W / 900);
    g.beginPath();
    g.moveTo(x0, 0); g.lineTo(x0, H);
    g.moveTo(x1, 0); g.lineTo(x1, H);
    g.stroke();
  }

  if (buffer && (marks.length || openMark !== null)) {
    const tx = (t) => (t / buffer.duration) * W;
    const lw = Math.max(2, Math.round(W / 600));
    const paint = (a, b) => {
      const x0 = tx(a), x1 = tx(b);
      if (x1 - x0 > lw) {
        g.fillStyle = 'rgba(216,221,229,.16)';
        g.fillRect(x0, 0, x1 - x0, H);
        g.fillStyle = 'rgba(216,221,229,.55)';
        g.fillRect(x1 - lw / 2, 0, lw / 2, H);
      }
      // A flag at the top, so a point is findable on a dense waveform.
      g.fillStyle = '#d8dde5';
      g.fillRect(x0 - lw / 2, 0, lw, H);
      g.fillRect(x0 - lw / 2, 0, lw * 3.5, H * 0.09);
    };
    for (const m of marks) paint(m.start, m.end);
    if (openMark !== null) paint(openMark, Math.max(openMark, heardPosition()));
  }

  const pos = currentPosition();
  if (buffer) {
    const x = (pos / buffer.duration) * W;
    g.fillStyle = '#6fd3a4';
    g.fillRect(x - 1, 0, 2, H);
  }
}

function setupWaveInteraction() {
  const cv = $('wave');
  let downX = null, dragging = false, anchor = 0;

  const xToTime = (clientX) => {
    const r = cv.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * (buffer ? buffer.duration : 0), 0, buffer ? buffer.duration : 0);
  };

  cv.addEventListener('pointerdown', (e) => {
    if (!buffer) return;
    cv.setPointerCapture(e.pointerId);
    downX = e.clientX;
    anchor = xToTime(e.clientX);
    dragging = false;
  });

  cv.addEventListener('pointermove', (e) => {
    if (downX === null || !buffer) return;
    if (!dragging && Math.abs(e.clientX - downX) > 5) dragging = true;
    if (dragging) {
      const t = xToTime(e.clientX);
      region = { start: Math.min(anchor, t), end: Math.max(anchor, t) };
      drawWave();
    }
  });

  cv.addEventListener('pointerup', (e) => {
    if (downX === null || !buffer) return;
    downX = null;
    if (dragging) {
      // A drag sets the loop region; a too-small one means they missed.
      if (region.end - region.start < 0.1) region = { start: 0, end: buffer.duration };
      dragging = false;
      if (playing) startPlayback(region.start); else pausedAt = region.start;
      drawWave();
      return;
    }
    const t = xToTime(e.clientX);
    if (playing) startPlayback(t); else { pausedAt = t; drawWave(); }
  });

  cv.addEventListener('dblclick', () => {
    if (!buffer) return;
    region = { start: 0, end: buffer.duration };
    drawWave();
    toast('Loop region cleared');
  });
}

// --------------------------------------------------------- 4c. marks
//
// Flag moments while listening: tap for a point, hold for a section. The list
// copies out as plain text, one mark per line, to hand to whoever is editing.

let marks = [];         // { start, end, note } in seconds; end === start is a point
let openMark = null;    // start of a section that is still being held
const MARK_MIN_HOLD = 0.25;   // shorter than this is a tap, so a point
let marksTimer = null;

const fmtMark = (t) => {
  if (!Number.isFinite(t)) t = 0;
  // Round first, or 59.996 prints as 0:60.00.
  const c = Math.round(t * 100);
  const m = Math.floor(c / 6000);
  return `${m}:${((c - m * 6000) / 100).toFixed(2).padStart(5, '0')}`;
};
const markLabel = (m) => (m.end > m.start ? `${fmtMark(m.start)}-${fmtMark(m.end)}` : fmtMark(m.start));

/**
 * Where the listener is, not where the scheduler is. What is audible now left
 * the buffer one limiter look-ahead plus one output latency ago, and a mark
 * should land on what was heard.
 */
function heardPosition() {
  const pos = currentPosition();
  if (!playing || !ctx || !buffer) return pos;
  const lag = (chain ? chain.lookaheadSamples / ctx.sampleRate : 0) + (ctx.outputLatency || ctx.baseLatency || 0);
  return clamp(pos - lag, 0, buffer.duration);
}

// Marks belong to a file, so they are kept per file name and length.
const marksKey = () => `gain-stage:marks:${trackLabel}:${buffer ? buffer.duration.toFixed(2) : '0'}`;

function saveMarks(soon) {
  clearTimeout(marksTimer);
  const write = () => {
    try {
      if (marks.length) localStorage.setItem(marksKey(), JSON.stringify(marks));
      else localStorage.removeItem(marksKey());
    } catch { /* private mode */ }
  };
  if (soon) marksTimer = setTimeout(write, 300); else write();
}

function loadMarks() {
  openMark = null;
  $('markBtn').classList.remove('on');
  marks = [];
  try {
    const raw = JSON.parse(localStorage.getItem(marksKey()) || '[]');
    if (Array.isArray(raw) && buffer) {
      marks = raw
        .filter((m) => m && Number.isFinite(m.start) && Number.isFinite(m.end))
        .map((m) => ({
          start: clamp(m.start, 0, buffer.duration),
          end: clamp(Math.max(m.start, m.end), 0, buffer.duration),
          note: typeof m.note === 'string' ? m.note.slice(0, 200) : '',
        }));
    }
  } catch { /* stale or corrupt, start clean */ }
  renderMarks();
}

function addMark(start, end) {
  marks.push({ start, end: Math.max(start, end), note: '' });
  marks.sort((a, b) => a.start - b.start || a.end - b.end);
  renderMarks();
  saveMarks();
}

function markDown() {
  if (!buffer || openMark !== null) return;
  if (!playing) {
    // Paused: mark the loop region if one is set, otherwise the playhead.
    const whole = region.start <= 0.001 && region.end >= buffer.duration - 0.001;
    if (whole) addMark(pausedAt, pausedAt); else addMark(region.start, region.end);
    return;
  }
  openMark = heardPosition();
  $('markBtn').classList.add('on');
}

function markUp() {
  if (openMark === null) return;
  const start = openMark;
  openMark = null;
  $('markBtn').classList.remove('on');
  if (!buffer) return;
  let end = heardPosition();
  // Behind the start means the loop wrapped or the file ran out mid-hold.
  if (end < start) end = playing ? Math.max(start, region.end) : buffer.duration;
  addMark(start, end - start < MARK_MIN_HOLD ? start : end);
}

function renderMarks() {
  const list = $('markList');
  $('marks').hidden = marks.length === 0;
  list.replaceChildren();
  for (const m of marks) {
    const row = document.createElement('div');
    row.className = 'mark';

    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'mark__time';
    time.textContent = markLabel(m);
    time.title = 'Play from here';
    time.addEventListener('click', (e) => {
      if (e.detail > 0) e.currentTarget.blur();   // hand Space back to the transport
      startPlayback(m.start);
    });

    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'mark__note';
    note.placeholder = 'Note';
    note.maxLength = 200;
    note.value = m.note;
    note.setAttribute('aria-label', `Note for ${markLabel(m)}`);
    note.addEventListener('input', () => { m.note = note.value; saveMarks(true); });
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') note.blur(); });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mark__del';
    del.textContent = '×';
    del.setAttribute('aria-label', `Delete mark at ${markLabel(m)}`);
    del.addEventListener('click', () => {
      marks = marks.filter((x) => x !== m);
      renderMarks();
      saveMarks();
    });

    row.append(time, note, del);
    list.append(row);
  }
}

function marksText() {
  const head = `${$('trackName').textContent} (${fmtMark(buffer ? buffer.duration : 0)})`;
  return [head, ...marks.map((m) => `${markLabel(m)}  ${m.note}`.trimEnd())].join('\n');
}

async function copyMarks() {
  const text = marksText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard permission (or not a secure context): the old way still works.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* refused */ }
    ta.remove();
    if (!ok) { toast('Could not copy'); return; }
  }
  toast(`${marks.length} ${marks.length === 1 ? 'mark' : 'marks'} copied`);
}

// --------------------------------------------------------- 5. EQ display

const F_MIN = 20, F_MAX = 20000, DB_RANGE = 18;
let eqFreqs = null, eqMag = null;
let dragBand = null;     // index into EQ_BANDS, or 'hpf' / 'lpf'
let hoverBand = null;
let activeBand = 0;

const fToX = (f, W) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
const xToF = (x, W) => F_MIN * Math.pow(F_MAX / F_MIN, clamp(x / W, 0, 1));
const dbToY = (db, H) => H / 2 - (db / DB_RANGE) * (H / 2 - H * 0.08);
const yToDb = (y, H) => ((H / 2 - y) / (H / 2 - H * 0.08)) * DB_RANGE;

function drawEq() {
  const cv = $('eq');
  sizeCanvas(cv);
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const dpr = W / Math.max(1, cv.clientWidth);

  g.clearRect(0, 0, W, H);
  g.fillStyle = '#1e222a';
  g.fillRect(0, 0, W, H);

  // --- grid ---
  g.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.textBaseline = 'top';
  g.lineWidth = dpr;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = fToX(f, W);
    g.strokeStyle = '#262b34';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillStyle = '#4c545f';
    g.textAlign = 'center';
    g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, H - 14 * dpr);
  }
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = dbToY(db, H);
    g.strokeStyle = db === 0 ? '#39404b' : '#242932';
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    if (db !== 0) {
      g.fillStyle = '#454d58';
      g.textAlign = 'left';
      g.fillText(`${db > 0 ? '+' : ''}${db}`, 4 * dpr, y + 2 * dpr);
    }
  }

  // --- live spectrum, drawn behind the curve ---
  if (analyser && specData) {
    analyser.getFloatFrequencyData(specData);
    const sr = ctx.sampleRate;
    const bins = specData.length;
    const binHz = sr / (analyser.fftSize);
    g.beginPath();
    g.moveTo(0, H);
    let started = false;
    const steps = Math.max(64, Math.floor(W / (2 * dpr)));
    for (let s = 0; s <= steps; s++) {
      const x = (s / steps) * W;
      const f0 = xToF(x, W);
      const f1 = xToF(((s + 1) / steps) * W, W);
      let lo = Math.floor(f0 / binHz);
      let hi = Math.max(lo + 1, Math.ceil(f1 / binHz));
      lo = clamp(lo, 0, bins - 1); hi = clamp(hi, 1, bins);
      let peak = -Infinity;
      for (let i = lo; i < hi; i++) if (specData[i] > peak) peak = specData[i];
      if (!Number.isFinite(peak)) peak = -140;
      // -96..0 dBFS maps to the full height.
      const y = H - clamp((peak + 96) / 96, 0, 1) * H;
      if (!started) { g.lineTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fillStyle = 'rgba(111,211,164,.10)';
    g.fill();
    g.strokeStyle = 'rgba(111,211,164,.22)';
    g.lineWidth = dpr;
    g.stroke();
  }

  // --- filter response ---
  if (chain) {
    const n = Math.max(96, Math.floor(W / (2 * dpr)));
    if (!eqFreqs || eqFreqs.length !== n) {
      eqFreqs = new Float32Array(n);
      eqMag = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) eqFreqs[i] = xToF((i / (n - 1)) * W, W);
    const mag = eqResponse(chain, state, eqFreqs);
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const db = clamp(toDb(mag[i]), -DB_RANGE * 1.4, DB_RANGE * 1.4);
      const x = (i / (n - 1)) * W;
      const y = dbToY(db, H);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = '#6fd3a4';
    g.lineWidth = 2 * dpr;
    g.lineJoin = 'round';
    g.stroke();
  }

  // --- handles ---
  const handles = eqHandles(W, H);
  for (const h of handles) {
    const isActive = h.id === activeBand;
    const isHover = h.id === hoverBand || h.id === dragBand;
    g.beginPath();
    g.arc(h.x, h.y, (isHover ? 8 : 6.5) * dpr, 0, Math.PI * 2);
    g.fillStyle = isActive || isHover ? '#6fd3a4' : 'rgba(111,211,164,.35)';
    g.fill();
    g.strokeStyle = '#0f1115';
    g.lineWidth = 1.5 * dpr;
    g.stroke();
    if (h.label) {
      g.fillStyle = isActive || isHover ? '#d8dde5' : '#69717f';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.font = `${10 * dpr}px -apple-system, system-ui, sans-serif`;
      g.fillText(h.label, h.x, h.y - 11 * dpr);
      g.textBaseline = 'top';
    }
  }
}

function eqHandles(W, H) {
  const out = [];
  if (state.hpf.on) out.push({ id: 'hpf', x: fToX(clamp(state.hpf.freq, F_MIN, F_MAX), W), y: dbToY(0, H), label: 'HP' });
  EQ_BANDS.forEach((b, i) => {
    const v = state.eq[i];
    out.push({ id: i, x: fToX(clamp(v.freq, F_MIN, F_MAX), W), y: dbToY(clamp(v.gain, -DB_RANGE, DB_RANGE), H), label: b.label });
  });
  if (state.lpf.on) out.push({ id: 'lpf', x: fToX(clamp(state.lpf.freq, F_MIN, F_MAX), W), y: dbToY(0, H), label: 'LP' });
  return out;
}

function setupEqInteraction() {
  const cv = $('eq');

  const pick = (e) => {
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / Math.max(1, r.width);
    const x = (e.clientX - r.left) * dpr;
    const y = (e.clientY - r.top) * dpr;
    let best = null, bestD = 20 * dpr;
    for (const h of eqHandles(cv.width, cv.height)) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bestD) { bestD = d; best = h.id; }
    }
    return { id: best, x, y, W: cv.width, H: cv.height };
  };

  cv.addEventListener('pointerdown', (e) => {
    const p = pick(e);
    if (p.id === null) return;
    dragBand = p.id;
    if (typeof p.id === 'number') { activeBand = p.id; highlightBandRow(); }
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  cv.addEventListener('pointermove', (e) => {
    const p = pick(e);
    if (dragBand === null) {
      const prev = hoverBand;
      hoverBand = p.id;
      cv.style.cursor = p.id === null ? 'crosshair' : 'grab';
      if (prev !== hoverBand) drawEq();
      return;
    }
    const f = xToF(p.x, p.W);
    if (dragBand === 'hpf') {
      state.hpf.freq = clamp(f, 20, 500);
    } else if (dragBand === 'lpf') {
      state.lpf.freq = clamp(f, 2000, 20000);
    } else {
      const b = EQ_BANDS[dragBand];
      const v = state.eq[dragBand];
      v.freq = clamp(f, b.min, b.max);
      if (!e.shiftKey) {
        v.gain = clamp(yToDb(p.y, p.H), -DB_RANGE, DB_RANGE);
      } else {
        // Shift turns the vertical axis into bandwidth, so a single drag can
        // find both the frequency and how wide the move should be.
        v.q = clamp(v.q * (1 + (e.movementY || 0) * 0.01), 0.2, 12);
      }
    }
    onControlChange();
  });

  const release = () => {
    if (dragBand === null) return;
    dragBand = null;
    drawEq();
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);

  cv.addEventListener('wheel', (e) => {
    const p = pick(e);
    // Only steal the wheel when the pointer is actually on a band handle.
    // Otherwise this canvas would swallow every scroll that crossed it, and
    // quietly retune a band on the way past.
    if (typeof p.id !== 'number') return;
    const id = p.id;
    e.preventDefault();
    const v = state.eq[id];
    v.q = clamp(v.q * (1 + Math.sign(e.deltaY) * 0.08), 0.2, 12);
    activeBand = id;
    highlightBandRow();
    onControlChange();
  }, { passive: false });

  cv.addEventListener('dblclick', (e) => {
    const p = pick(e);
    if (typeof p.id !== 'number') return;
    state.eq[p.id].gain = 0;
    onControlChange();
  });
}

// ------------------------------------------------- 6. controls & modules

const controls = [];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * One labelled slider bound to a path in `state`.
 * `log: true` swaps in an exponential mapping, which is the only way a
 * frequency or a time constant feels right under a finger.
 */
function makeControl(parent, spec) {
  const { label, min, max, step = 0.1, log = false, format, get, set } = spec;
  const wrap = el('div', 'ctl');
  const row = el('div', 'ctl__row');
  row.append(el('span', 'ctl__label', label), el('span', 'ctl__val'));
  const val = row.lastChild;
  const input = document.createElement('input');
  input.type = 'range';
  input.setAttribute('aria-label', label);
  if (log) { input.min = '0'; input.max = '1000'; input.step = '1'; }
  else { input.min = String(min); input.max = String(max); input.step = String(step); }
  wrap.append(row, input);
  parent.append(wrap);

  const toPos = (v) => Math.round(1000 * (Math.log(clamp(v, min, max) / min) / Math.log(max / min)));
  const fromPos = (p) => min * Math.pow(max / min, p / 1000);

  const refresh = () => {
    const v = get();
    input.value = String(log ? toPos(v) : clamp(v, min, max));
    val.textContent = format(v);
  };
  input.addEventListener('input', () => {
    const v = log ? fromPos(Number(input.value)) : Number(input.value);
    set(v);
    val.textContent = format(v);
    onControlChange({ skipRefresh: true });
  });

  const entry = { refresh, input, wrap };
  controls.push(entry);
  return entry;
}

function makeSwitch(parent, { get, set, label }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sw-btn';
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => {
    set(!get());
    // A pointer click leaves the button focused, which would then swallow the
    // Space key that plays and stops. Keyboard activation (detail 0) keeps it.
    if (e.detail > 0) b.blur();
    onControlChange();
  });
  parent.append(b);
  const refresh = () => {
    b.setAttribute('aria-pressed', String(!!get()));
    b.closest('.module')?.classList.toggle('off', !get());
  };
  controls.push({ refresh });
  return b;
}

function makeSegmented(parent, { options, get, set, label }) {
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  const btns = options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    b.addEventListener('click', (e) => {
      set(o.value);
      if (e.detail > 0) b.blur();
      onControlChange();
    });
    seg.append(b);
    return { b, value: o.value };
  });
  parent.append(seg);
  controls.push({
    refresh: () => btns.forEach(({ b, value }) => b.setAttribute('aria-pressed', String(get() === value))),
  });
  return seg;
}

function moduleCard(title) {
  const card = el('section', 'panel module');
  const head = el('div', 'module__head');
  // The spacer keeps the header layout identical whether or not a module has
  // a gain-reduction readout, so the on/off switches line up down the rack.
  head.append(el('span', 'module__name', title), el('span', 'module__spacer'));
  const body = el('div', 'module__body');
  card.append(head, body);
  $('rack').append(card);
  return { card, head, body };
}

function buildBandRows() {
  const host = $('bands');
  host.textContent = '';

  const row = (name, build) => {
    const r = el('div', 'band');
    const n = el('div', 'band__name');
    n.append(el('span', 'sw'), el('span', null, name));
    r.append(n);
    build(r);
    host.append(r);
    return r;
  };

  // High-pass gets a switch instead of a gain — it has no neutral setting.
  row('High-pass', (r) => {
    const c1 = el('div', 'cell');
    makeControl(c1, {
      label: 'Frequency', min: 20, max: 500, log: true, format: fmtHz,
      get: () => state.hpf.freq, set: (v) => { state.hpf.freq = v; },
    });
    const c2 = el('div', 'cell');
    const holder = el('div', 'ctl');
    const hrow = el('div', 'ctl__row');
    hrow.append(el('span', 'ctl__label', 'Enable'));
    holder.append(hrow);
    makeSwitch(holder, { get: () => state.hpf.on, set: (v) => { state.hpf.on = v; }, label: 'High-pass filter' });
    c2.append(holder);
    r.append(c1, c2, el('div', 'cell'));
  });

  EQ_BANDS.forEach((b, i) => {
    const r = row(b.label, (rr) => {
      const c1 = el('div', 'cell'), c2 = el('div', 'cell'), c3 = el('div', 'cell');
      makeControl(c1, {
        label: 'Frequency', min: b.min, max: b.max, log: true, format: fmtHz,
        get: () => state.eq[i].freq, set: (v) => { state.eq[i].freq = v; },
      });
      makeControl(c2, {
        label: 'Gain', min: -18, max: 18, step: 0.1, format: fmtDb,
        get: () => state.eq[i].gain, set: (v) => { state.eq[i].gain = v; },
      });
      makeControl(c3, {
        label: b.type === 'peaking' ? 'Q' : 'Slope', min: 0.2, max: 12, log: true,
        format: (v) => v.toFixed(2),
        get: () => state.eq[i].q, set: (v) => { state.eq[i].q = v; },
      });
      rr.append(c1, c2, c3);
    });
    r.dataset.band = String(i);
    r.addEventListener('pointerdown', () => { activeBand = i; highlightBandRow(); drawEq(); });
  });

  row('Low-pass', (r) => {
    const c1 = el('div', 'cell');
    makeControl(c1, {
      label: 'Frequency', min: 2000, max: 20000, log: true, format: fmtHz,
      get: () => state.lpf.freq, set: (v) => { state.lpf.freq = v; },
    });
    const c2 = el('div', 'cell');
    const holder = el('div', 'ctl');
    const hrow = el('div', 'ctl__row');
    hrow.append(el('span', 'ctl__label', 'Enable'));
    holder.append(hrow);
    makeSwitch(holder, { get: () => state.lpf.on, set: (v) => { state.lpf.on = v; }, label: 'Low-pass filter' });
    c2.append(holder);
    r.append(c1, c2, el('div', 'cell'));
  });

  highlightBandRow();
}

function highlightBandRow() {
  document.querySelectorAll('.band[data-band]').forEach((r) => {
    r.classList.toggle('active', Number(r.dataset.band) === activeBand);
  });
}

function buildRack() {
  // --- levels ---
  {
    const { body } = moduleCard('Levels');
    const g = el('div', 'grid2');
    makeControl(g, {
      label: 'Input trim', min: -24, max: 24, step: 0.1, format: fmtDb,
      get: () => state.trim, set: (v) => { state.trim = v; },
    });
    makeControl(g, {
      label: 'Output', min: -24, max: 12, step: 0.1, format: fmtDb,
      get: () => state.output, set: (v) => { state.output = v; },
    });
    body.append(g);
  }

  // --- compressor ---
  {
    const { head, body } = moduleCard('Compressor');
    const gr = el('span', 'module__gr', '0.0 dB');
    head.append(gr);
    grReadouts.comp = gr;
    makeSwitch(head, { get: () => state.comp.on, set: (v) => { state.comp.on = v; }, label: 'Compressor on' });

    const g = el('div', 'grid2');
    makeControl(g, {
      label: 'Threshold', min: -60, max: 0, step: 0.1, format: fmtDb,
      get: () => state.comp.threshold, set: (v) => { state.comp.threshold = v; },
    });
    makeControl(g, {
      label: 'Ratio', min: 1, max: 20, log: true, format: (v) => `${v.toFixed(v < 10 ? 1 : 0)}:1`,
      get: () => state.comp.ratio, set: (v) => { state.comp.ratio = v; },
    });
    makeControl(g, {
      label: 'Attack', min: 0.0002, max: 0.5, log: true, format: fmtSec,
      get: () => state.comp.attack, set: (v) => { state.comp.attack = v; },
    });
    makeControl(g, {
      label: 'Release', min: 0.005, max: 3, log: true, format: fmtSec,
      get: () => state.comp.release, set: (v) => { state.comp.release = v; },
    });
    makeControl(g, {
      label: 'Knee', min: 0, max: 24, step: 0.5, format: (v) => `${v.toFixed(1)} dB`,
      get: () => state.comp.knee, set: (v) => { state.comp.knee = v; },
    });
    makeControl(g, {
      label: 'Makeup', min: -12, max: 24, step: 0.1, format: fmtDb,
      get: () => state.comp.makeup, set: (v) => { state.comp.makeup = v; },
    });
    makeControl(g, {
      label: 'Mix (parallel)', min: 0, max: 1, step: 0.01, format: fmtPct,
      get: () => state.comp.mix, set: (v) => { state.comp.mix = v; },
    });
    makeControl(g, {
      label: 'Peak → RMS', min: 0, max: 1, step: 0.01, format: fmtPct,
      get: () => state.comp.rmsBlend, set: (v) => { state.comp.rmsBlend = v; },
    });
    makeControl(g, {
      label: 'Sidechain HP', min: 0, max: 400, step: 1,
      format: (v) => (v < 1 ? 'off' : fmtHz(v)),
      get: () => state.comp.sidechainHz, set: (v) => { state.comp.sidechainHz = v; },
    });
    body.append(g);

    const auto = el('button', 'btn', 'Auto makeup');
    auto.type = 'button';
    auto.style.cssText = 'margin-top:10px;font-size:.76rem;padding:6px 12px';
    auto.addEventListener('click', (e) => {
      // Roughly undo the level a compressor takes away: the reduction at the
      // threshold, halved because program material is not pinned there.
      const c = state.comp;
      c.makeup = clamp(Math.round(-c.threshold * (1 - 1 / c.ratio) * 0.5 * 2) / 2, -12, 24);
      if (e.detail > 0) auto.blur();
      onControlChange();
      toast(`Makeup set to ${fmtDb(c.makeup)}`);
    });
    body.append(auto);
  }

  // --- saturation ---
  {
    const { head, body } = moduleCard('Saturation');
    makeSwitch(head, { get: () => state.sat.on, set: (v) => { state.sat.on = v; }, label: 'Saturation on' });
    const modes = el('div');
    modes.style.marginBottom = '12px';
    makeSegmented(modes, {
      label: 'Character',
      options: [
        { label: 'Soft', value: 'soft' },
        { label: 'Tape', value: 'tape' },
        { label: 'Warm', value: 'warm' },
      ],
      get: () => state.sat.mode, set: (v) => { state.sat.mode = v; },
    });
    body.append(modes);
    const g = el('div', 'grid2');
    makeControl(g, {
      label: 'Drive', min: 0, max: 24, step: 0.1, format: (v) => `${v.toFixed(1)} dB`,
      get: () => state.sat.drive, set: (v) => { state.sat.drive = v; },
    });
    makeControl(g, {
      label: 'Amount', min: 0, max: 1, step: 0.01, format: fmtPct,
      get: () => state.sat.mix, set: (v) => { state.sat.mix = v; },
    });
    body.append(g);
    body.append(el('p', 'hint', 'Level-matched, so the drive knob adds harmonics instead of volume.'));
    body.lastChild.style.cssText = 'margin:10px 0 0;font-size:.72rem;line-height:1.5';
  }

  // --- limiter ---
  {
    const { head, body } = moduleCard('Limiter');
    const gr = el('span', 'module__gr', '0.0 dB');
    head.append(gr);
    grReadouts.lim = gr;
    makeSwitch(head, { get: () => state.limiter.on, set: (v) => { state.limiter.on = v; }, label: 'Limiter on' });

    const g = el('div', 'grid2');
    makeControl(g, {
      label: 'Drive', min: 0, max: 24, step: 0.1, format: (v) => `${v.toFixed(1)} dB`,
      get: () => state.limiter.drive, set: (v) => { state.limiter.drive = v; },
    });
    makeControl(g, {
      label: 'Ceiling', min: -12, max: 0, step: 0.1, format: fmtDb,
      get: () => state.limiter.ceiling, set: (v) => { state.limiter.ceiling = v; },
    });
    makeControl(g, {
      label: 'Release', min: 0.02, max: 2, log: true, format: fmtSec,
      get: () => state.limiter.release, set: (v) => { state.limiter.release = v; },
    });
    body.append(g);
    body.append(el('p', 'hint', 'Drive pushes into the ceiling. Watch the gain reduction: past about 6 dB it stops sounding louder and starts sounding smaller.'));
    body.lastChild.style.cssText = 'margin:10px 0 0;font-size:.72rem;line-height:1.5';
  }
}

function buildPresets() {
  const host = $('presets');
  PRESETS.forEach((p) => {
    const b = el('button', 'preset-btn', p.name);
    b.type = 'button';
    b.dataset.preset = p.name;
    b.addEventListener('click', (e) => {
      state = cloneState(p.state);
      if (e.detail > 0) b.blur();
      syncAll();
      pushAudio();
      persist();
      $('presetBlurb').textContent = p.blurb;
      toast(`${p.name} loaded`);
    });
    host.append(b);
  });
}

function refreshPresetButtons() {
  document.querySelectorAll('.preset-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.preset === state.preset);
  });
  const active = PRESETS.find((p) => p.name === state.preset);
  $('presetBlurb').textContent = active ? active.blurb : 'Custom settings.';
}

/** Called by every control. Pushes to audio, redraws, and saves. */
function onControlChange(opts = {}) {
  if (state.preset !== 'Custom') {
    // Any manual move means this is no longer the preset.
    state.preset = 'Custom';
    refreshPresetButtons();
  }
  if (!opts.skipRefresh) controls.forEach((c) => c.refresh());
  else {
    // Even on a slider drag, switches and readouts elsewhere may depend on it.
    controls.forEach((c) => { if (!c.input) c.refresh(); });
  }
  pushAudio();
  drawEq();
  persist();
}

function syncAll() {
  controls.forEach((c) => c.refresh());
  refreshPresetButtons();
  highlightBandRow();
  drawEq();
}

// Dragging a slider fires input events at frame rate; writing localStorage on
// every one of them is a synchronous disk hit per frame.
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }, 250);
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = normalizeState(JSON.parse(raw));
  } catch { /* stale or corrupt — keep the defaults */ }
}

/** Coerce an untrusted state object into something the graph can accept. */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.comp || !Array.isArray(raw.eq)) {
    throw new Error('not a Gain Stage settings file');
  }
  const d = defaultState();
  const num = (v, def, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : def);
  const s = defaultState();
  s.preset = typeof raw.preset === 'string' ? raw.preset : 'Custom';
  s.trim = num(raw.trim, 0, -24, 24);
  s.output = num(raw.output, 0, -24, 12);
  s.hpf = { on: !!(raw.hpf && raw.hpf.on), freq: num(raw.hpf && raw.hpf.freq, 30, 20, 500) };
  s.lpf = { on: !!(raw.lpf && raw.lpf.on), freq: num(raw.lpf && raw.lpf.freq, 18000, 2000, 20000) };
  s.eq = EQ_BANDS.map((b, i) => {
    const r = raw.eq[i] || {};
    return {
      freq: num(r.freq, b.freq, b.min, b.max),
      gain: num(r.gain, 0, -18, 18),
      q: num(r.q, b.q, 0.2, 12),
    };
  });
  s.comp = {
    on: raw.comp.on !== false,
    threshold: num(raw.comp.threshold, d.comp.threshold, -60, 0),
    ratio: num(raw.comp.ratio, d.comp.ratio, 1, 20),
    knee: num(raw.comp.knee, d.comp.knee, 0, 24),
    attack: num(raw.comp.attack, d.comp.attack, 0.0002, 0.5),
    release: num(raw.comp.release, d.comp.release, 0.005, 3),
    makeup: num(raw.comp.makeup, 0, -12, 24),
    mix: num(raw.comp.mix, 1, 0, 1),
    sidechainHz: num(raw.comp.sidechainHz, 0, 0, 400),
    rmsBlend: num(raw.comp.rmsBlend, 0, 0, 1),
  };
  const sat = raw.sat || {};
  s.sat = {
    on: !!sat.on,
    mode: ['soft', 'tape', 'warm'].includes(sat.mode) ? sat.mode : 'soft',
    drive: num(sat.drive, 6, 0, 24),
    mix: num(sat.mix, 0.5, 0, 1),
  };
  const lim = raw.limiter || {};
  s.limiter = {
    on: lim.on !== false,
    drive: num(lim.drive, 0, 0, 24),
    ceiling: num(lim.ceiling, -1, -12, 0),
    release: num(lim.release, 0.25, 0.02, 2),
  };
  return s;
}

// ------------------------------------------------------------ 7. meters

const meterVals = {
  inPeak: 0, outPeak: 0, truePeak: 0, compGr: 0, limGr: 0, clips: 0,
  momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity,
};
const grReadouts = { comp: null, lim: null };
const holds = { in: { v: 0, at: 0 }, out: { v: 0, at: 0 } };
// Gain reduction arrives as the worst value in a ~10 ms window, which on
// percussive material is zero more often than not. A real GR meter has
// ballistics: hold the peak, then fall back at a readable rate.
const grHold = { comp: 0, lim: 0 };
const GR_FALL_DB_PER_SEC = 24;
let lastMeterAt = 0;
let clipFlashUntil = 0;
let lastClips = 0;

function resetMeters() {
  Object.assign(meterVals, {
    inPeak: 0, outPeak: 0, truePeak: 0, compGr: 0, limGr: 0, clips: 0,
    momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity,
  });
  holds.in = { v: 0, at: 0 };
  holds.out = { v: 0, at: 0 };
  grHold.comp = 0;
  grHold.lim = 0;
  lastClips = 0;
  if (outMeter) outMeter.port.postMessage({ reset: true });
}

// -60..0 dBFS across the bar.
const barPct = (db) => `${clamp(((db + 60) / 60) * 100, 0, 100)}%`;

function drawMeters(now) {
  const inDb = toDb(meterVals.inPeak);
  const outDb = toDb(meterVals.outPeak);
  const tpDb = toDb(meterVals.truePeak);

  $('inFill').style.right = `${100 - clamp(((inDb + 60) / 60) * 100, 0, 100)}%`;
  $('outFill').style.right = `${100 - clamp(((outDb + 60) / 60) * 100, 0, 100)}%`;
  $('tpFill').style.right = `${100 - clamp(((tpDb + 60) / 60) * 100, 0, 100)}%`;
  $('inVal').textContent = fmtDbf(inDb);
  $('outVal').textContent = fmtDbf(outDb);
  $('tpVal').textContent = fmtDbf(tpDb);

  // Peak hold: keep the highest for a moment so a transient is readable.
  for (const [key, db, node] of [['in', inDb, $('inPeak')], ['out', outDb, $('outPeak')]]) {
    const h = holds[key];
    if (db > h.v || now - h.at > 1400) { h.v = db; h.at = now; }
    node.style.left = barPct(h.v);
  }

  $('tpBar').classList.toggle('clip', tpDb > -0.1);
  if (meterVals.clips > lastClips) { clipFlashUntil = now + 1200; lastClips = meterVals.clips; }
  $('outBar').classList.toggle('clip', now < clipFlashUntil);

  const dt = lastMeterAt ? Math.min(0.1, (now - lastMeterAt) / 1000) : 0;
  lastMeterAt = now;
  grHold.comp = Math.max(meterVals.compGr, grHold.comp - GR_FALL_DB_PER_SEC * dt);
  grHold.lim = Math.max(meterVals.limGr, grHold.lim - GR_FALL_DB_PER_SEC * dt);
  const cg = grHold.comp, lg = grHold.lim;
  $('cgrVal').textContent = cg.toFixed(1);
  $('lgrVal').textContent = lg.toFixed(1);
  // Gain reduction reads 0..20 dB across the bar.
  $('cgrFill').style.right = `${100 - clamp((cg / 20) * 100, 0, 100)}%`;
  $('lgrFill').style.right = `${100 - clamp((lg / 20) * 100, 0, 100)}%`;
  if (grReadouts.comp) {
    grReadouts.comp.textContent = `-${cg.toFixed(1)} dB`;
    grReadouts.comp.classList.toggle('live', cg > 0.1);
  }
  if (grReadouts.lim) {
    grReadouts.lim.textContent = `-${lg.toFixed(1)} dB`;
    grReadouts.lim.classList.toggle('live', lg > 0.1);
  }

  $('lufsM').textContent = fmtDbf(meterVals.momentary);
  $('lufsS').textContent = fmtDbf(meterVals.shortTerm);
  $('lufsI').textContent = fmtDbf(meterVals.integrated);
}

// ------------------------------------------------------------- 8. export

let exportDepth = 24;
let exportRange = 'full';
let exportKind = 'wav';   // 'wav', or 'project' for the zip

function openExport() {
  if (!buffer) { toast('Load a file first'); return; }
  $('exportSheet').classList.add('open');
  $('exportGo').focus();
}
function closeExport() {
  $('exportSheet').classList.remove('open');
  $('exportProgress').classList.remove('on');
}

/** Render the file through the current settings. Resolves to the WAV and what it covers. */
async function renderMaster() {
  const sr = buffer.sampleRate;
  const useLoop = exportRange === 'loop' && region.end - region.start > 0.05;
  const start = useLoop ? region.start : 0;
  const dur = (useLoop ? region.end : buffer.duration) - start;

  // Render a little past the end so the limiter's look-ahead delay has
  // somewhere to land, then drop exactly that many samples off the front.
  const tail = 0.3;
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const off = new OfflineAudioContext(channels, Math.ceil((dur + tail) * sr), sr);
  await loadWorklets(off);
  const c = buildChain(off, { meters: false });
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(c.input);
  c.output.connect(off.destination);
  c.apply(state, 0, 0);   // no ramps offline — the settings are already final
  src.start(0, start, dur);

  const rendered = await off.startRendering();

  const skip = c.lookaheadSamples;
  const outLen = Math.min(Math.ceil(dur * sr), Math.max(0, rendered.length - skip));
  const outBuf = off.createBuffer(channels, outLen, sr);
  for (let ch = 0; ch < channels; ch++) {
    outBuf.copyToChannel(rendered.getChannelData(ch).subarray(skip, skip + outLen), ch);
  }

  const blob = encodeWav(outBuf, { depth: exportDepth });
  const suffix = exportDepth === 32 ? '32f' : `${exportDepth}`;
  return {
    blob,
    name: `${trackLabel || 'gain-stage'}-master-${suffix}.wav`,
    range: useLoop ? 'loop' : 'full',
    start,
    end: start + dur,
  };
}

// What goes in a saved settings file, and in a project.
// `build` is the codebase that wrote the file, so a settings file made before
// a breaking change can still be traced back to the app that can read it.
// normalizeState() picks the keys it knows, so the extra one is harmless.
const settingsDoc = () => ({ ...state, build: window.buildVersion?.() ?? 'unknown' });

// A name that is safe as a path inside the archive on any system.
const zipSafe = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
const fileStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/**
 * The project zip: everything needed to get back to this master, or to redo it.
 *   project.json     what is in here, which build wrote it, and when
 *   settings.json    the same file Save writes; Load reads it on its own
 *   original/<file>  the audio as it was chosen, byte for byte
 *   export/<wav>     the render
 */
async function sha256(blob) {
  // Needs a secure context; without one the project just goes without.
  if (!globalThis.crypto || !crypto.subtle) return null;
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildProject(master) {
  const now = new Date();
  const original = `original/${zipSafe(sourceFile.name)}`;
  const exported = `export/${zipSafe(master.name)}`;
  const project = {
    app: 'gain-stage',
    format: 1,
    build: window.buildVersion?.() ?? 'unknown',
    saved: now.toISOString(),
    original: {
      path: original,
      name: sourceFile.name,
      bytes: sourceFile.size,
      sha256: await sha256(sourceFile),
      type: sourceFile.type || '',
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      seconds: Number(buffer.duration.toFixed(6)),
    },
    settings: 'settings.json',
    export: {
      path: exported,
      bytes: master.blob.size,
      // The same original and settings in the same build render to these bytes.
      sha256: await sha256(master.blob),
      bitDepth: exportDepth,
      float: exportDepth === 32,
      range: master.range,
      start: Number(master.start.toFixed(6)),
      end: Number(master.end.toFixed(6)),
    },
    loop: { on: loopOn, start: Number(region.start.toFixed(6)), end: Number(region.end.toFixed(6)) },
    marks,
  };
  const blob = await makeZip([
    { name: 'project.json', data: JSON.stringify(project, null, 2) },
    { name: 'settings.json', data: JSON.stringify(settingsDoc(), null, 2) },
    { name: original, data: sourceFile },
    { name: exported, data: master.blob },
  ], now);
  return { blob, name: `${trackLabel || 'gain-stage'}-project-${fileStamp(now)}.zip` };
}

async function runExport() {
  if (!buffer) return;
  const asProject = exportKind === 'project';
  if (asProject && !sourceFile) { toast('Load a file first'); return; }
  const go = $('exportGo');
  go.disabled = true;
  $('exportProgress').classList.add('on');
  try {
    const master = await renderMaster();
    const out = asProject ? await buildProject(master) : master;
    downloadBlob(out.blob, out.name);
    closeExport();
    const mb = `${(out.blob.size / 1048576).toFixed(1)} MB`;
    toast(asProject ? `Project saved · ${mb}` : `Exported ${mb} · ${exportDepth}-bit`);
  } catch (err) {
    toast(`${asProject ? 'Project' : 'Export'} failed: ${err && err.message ? err.message : 'unknown error'}`);
  } finally {
    go.disabled = false;
    $('exportProgress').classList.remove('on');
  }
}

/** Open a project zip: the original audio, its settings, marks and loop. */
async function loadProject(file) {
  let entries, project;
  try {
    entries = await readZip(file);
    const doc = entries.get('project.json');
    project = doc ? JSON.parse(await (await doc.blob()).text()) : null;
  } catch (err) {
    toast(`Could not open that zip (${err && err.message ? err.message : 'error'})`);
    return;
  }
  if (!project || project.app !== 'gain-stage' || !project.original || !entries.has(project.original.path)) {
    toast('Not a Gain Stage project');
    return;
  }
  try {
    const o = project.original;
    const audio = await entries.get(o.path).blob(typeof o.type === 'string' ? o.type : '');
    const name = typeof o.name === 'string' && o.name ? o.name : o.path.split('/').pop();
    if (!(await loadFile(new File([audio], name, { type: audio.type })))) return;

    const settings = entries.get(typeof project.settings === 'string' ? project.settings : 'settings.json');
    if (settings) {
      state = normalizeState(JSON.parse(await (await settings.blob()).text()));
      syncAll();
      pushAudio();
      persist();
    }
    // The project's marks win over whatever this browser remembered for the name.
    if (Array.isArray(project.marks)) {
      try { localStorage.setItem(marksKey(), JSON.stringify(project.marks)); } catch { /* private mode */ }
      loadMarks();
    }
    const l = project.loop;
    if (l && Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start) {
      region = { start: clamp(l.start, 0, buffer.duration), end: clamp(l.end, 0, buffer.duration) };
      loopOn = l.on !== false;
      $('loopBtn').setAttribute('aria-pressed', String(loopOn));
      $('loopBtn').classList.toggle('on', loopOn);
    }
    drawWave();
    toast('Project loaded');
  } catch (err) {
    toast(`Could not load that project (${err && err.message ? err.message : 'error'})`);
  }
}

/** Settings JSON or a project zip, from the Load button or a drop. */
const isZip = (f) => /\.zip$/i.test(f.name) || /zip/.test(f.type);
const isJson = (f) => /\.json$/i.test(f.name);
async function loadSettingsFile(f) {
  try {
    state = normalizeState(JSON.parse(await f.text()));
    syncAll();
    pushAudio();
    persist();
    toast('Settings loaded');
  } catch {
    toast('Invalid settings file');
  }
}

// ----------------------------------------------- 9. save / load / keyboard

function saveSettings() {
  const blob = new Blob([JSON.stringify(settingsDoc(), null, 2)], { type: 'application/json' });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  downloadBlob(blob, `gain-stage-${stamp}.json`);
  toast('Settings saved');
}

const settingsInput = document.createElement('input');
settingsInput.type = 'file';
settingsInput.accept = 'application/json,.json,application/zip,.zip';
settingsInput.style.display = 'none';
document.body.append(settingsInput);
settingsInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (isZip(f)) loadProject(f); else loadSettingsFile(f);
});

const audioInput = document.createElement('input');
audioInput.type = 'file';
audioInput.accept = 'audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus';
audioInput.style.display = 'none';
audioInput.id = 'audioFile';
document.body.append(audioInput);
audioInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) loadFile(f);
});

// ------------------------------------------------------------ bootstrap

function tick(now) {
  drawEq();
  if (buffer) {
    drawWave();
    const pos = currentPosition();
    $('time').textContent = `${fmtClock(pos)} / ${fmtClock(buffer.duration)}`;
  }
  drawMeters(now);
  requestAnimationFrame(tick);
}

function wireUp() {
  $('pickBtn').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    audioInput.click();
  });
  $('micBtn').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    toggleMic();
  });
  // pointerup, not pointerdown — iOS only grants audio on a completed gesture.
  $('play').addEventListener('pointerup', (e) => {
    e.currentTarget.blur();   // hand Space back to the transport
    togglePlay();
  });
  $('play').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
  $('loopBtn').addEventListener('click', (e) => {
    loopOn = !loopOn;
    e.currentTarget.setAttribute('aria-pressed', String(loopOn));
    e.currentTarget.classList.toggle('on', loopOn);
    if (e.detail > 0) e.currentTarget.blur();
    if (playing) startPlayback(currentPosition());
  });
  $('loopBtn').classList.toggle('on', loopOn);

  // Mark: press starts it, release ends it. preventDefault keeps focus off the
  // button so Space and M stay with the transport.
  const markBtn = $('markBtn');
  markBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { markBtn.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    markDown();
  });
  markBtn.addEventListener('pointerup', markUp);
  markBtn.addEventListener('pointercancel', markUp);
  markBtn.addEventListener('contextmenu', (e) => e.preventDefault());   // long press on touch
  // A click with no pointer behind it came from the keyboard: drop a point.
  markBtn.addEventListener('click', (e) => { if (e.detail === 0) { markDown(); markUp(); } });
  $('copyMarks').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    copyMarks();
  });

  $('abBtn').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    setBypass(!bypassed);
  });
  $('saveState').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); saveSettings(); });
  $('loadState').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); settingsInput.click(); });
  $('exportBtn').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); openExport(); });
  $('exportCancel').addEventListener('click', closeExport);
  $('exportGo').addEventListener('click', runExport);
  $('exportSheet').addEventListener('click', (e) => { if (e.target === $('exportSheet')) closeExport(); });
  $('resetMeters').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    resetMeters();
    toast('Meters reset');
  });

  const segPick = (host, attr, apply) => {
    host.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        apply(b.dataset[attr]);
        host.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      });
    });
  };
  segPick($('depthSeg'), 'depth', (v) => { exportDepth = Number(v); });
  segPick($('rangeSeg'), 'range', (v) => { exportRange = v; });
  segPick($('kindSeg'), 'kind', (v) => {
    exportKind = v;
    $('kindNote').hidden = v !== 'project';
  });

  // Drag and drop, anywhere on the page.
  let dragDepth = 0;
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dragDepth === 1) $('drop').classList.add('hot');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('hot'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').classList.remove('hot');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (isJson(f)) { loadSettingsFile(f); return; }
    if (isZip(f)) { loadProject(f); return; }
    loadFile(f);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Never steal a key from a control the user is actually operating: Space
    // on a focused button or slider belongs to that control, not to transport.
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, button, a, [contenteditable]')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setBypass(!bypassed); }
    else if ((e.key === 'm' || e.key === 'M') && !e.repeat) { e.preventDefault(); markDown(); }
    else if (e.key === 'Escape') closeExport();
  });
  // Releasing M closes the section wherever focus has gone in the meantime.
  window.addEventListener('keyup', (e) => { if (e.key === 'm' || e.key === 'M') markUp(); });
  window.addEventListener('blur', markUp);

  window.addEventListener('resize', () => { waveImage = null; });
}

restore();
buildBandRows();
buildRack();
buildPresets();
setupEqInteraction();
setupWaveInteraction();
wireUp();
syncAll();
drawWave();
requestAnimationFrame(tick);
