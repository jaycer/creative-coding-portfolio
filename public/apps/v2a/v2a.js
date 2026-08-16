// V2A — video in, audio out.
//
// This file is the wiring: it owns the source (a camera stream or a file), the
// config the two halves share, the render loop, and the controls. The mapping
// lives in analysis.js and the sound in engine.js, and neither of them knows
// this file exists.
//
// Nothing leaves the device. There is no upload path in here, by design: a
// camera app that phones home is a different piece of work than this one.

import { Analyzer, BAND_STEPS, buildBandFreqs, scaleFreqList, gridFor, noteName, NOTES } from './analysis.js';
import { Engine, MAX_BANDS } from './engine.js';
import { PRESETS, DEFAULT_CFG } from './presets.js';

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('stage'), view: $('view'), idle: $('idle'), hint: $('hint'),
  toast: $('toast'), dock: $('dock'), dockBtn: $('dockBtn'), scrim: $('scrim'),
  holdBtn: $('holdBtn'), saveState: $('saveState'), loadState: $('loadState'),
  camBtn: $('camBtn'), camBtn2: $('camBtn2'), flipBtn: $('flipBtn'),
  fileBtn: $('fileBtn'), fileBtn2: $('fileBtn2'),
  video: $('video'), videoFile: $('videoFile'), settingsFile: $('settingsFile'),
  transport: $('transport'), playBtn: $('playBtn'), playIcon: $('playIcon'),
  seek: $('seek'), timeNow: $('timeNow'), timeAll: $('timeAll'), loopBtn: $('loopBtn'),
  presets: $('presets'), mode: $('mode'), modeNote: $('modeNote'), wave: $('wave'),
  bands: $('bands'), bandsVal: $('bandsVal'),
  dir: $('dir'), scale: $('scale'), root: $('root'),
  rateCtl: $('rateCtl'), dirField: $('dirField'), rootField: $('rootField'),
  invert: $('invert'), mirror: $('mirror'), overlay: $('overlay'),
};

const viewCtx = els.view.getContext('2d');

// ---------------------------------------------------------------------------
// Slider scales
//
// Every range input in the drawer holds a position from 0 to 1000, never a
// value. Frequencies and times are heard logarithmically — the step from 100ms
// to 200ms is the same musical step as 1s to 2s — so a linear slider would put
// nine tenths of the useful travel in the last inch.

const logScale = (lo, hi) => ({
  lo, hi,
  fromPos: (p) => lo * Math.pow(hi / lo, p / 1000),
  toPos: (v) => Math.round(1000 * Math.log(clamp(v, lo, hi) / lo) / Math.log(hi / lo)),
});
const linScale = (lo, hi) => ({
  lo, hi,
  fromPos: (p) => lo + (hi - lo) * (p / 1000),
  toPos: (v) => Math.round(1000 * (clamp(v, lo, hi) - lo) / (hi - lo)),
});

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz');
const fmtMs = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms');

/** key -> [element id, scale, formatter]. The single source of truth for what
 *  the sliders are; readout, hydration and save all walk this list. */
const SLIDERS = {
  rate:     ['rate',     logScale(0.05, 8),     (v) => v.toFixed(2) + '/s'],
  fLow:     ['flow',     logScale(30, 4000),    (v) => fmtHz(v) + ' · ' + noteName(v)],
  fHigh:    ['fhigh',    logScale(60, 8000),    (v) => fmtHz(v) + ' · ' + noteName(v)],
  attack:   ['attack',   logScale(1, 2000),     fmtMs],
  release:  ['release',  logScale(10, 4000),    fmtMs],
  glide:    ['glide',    logScale(1, 500),      fmtMs],
  gate:     ['gate',     linScale(0, 0.9),      (v) => v.toFixed(2)],
  contrast: ['contrast', logScale(0.3, 4),      (v) => v.toFixed(2)],
  width:    ['width',    linScale(0, 1),        (v) => v.toFixed(2)],
  space:    ['space',    linScale(0, 1),        (v) => v.toFixed(2)],
  tone:     ['tone',     logScale(200, 16000),  fmtHz],
};
for (const k of Object.keys(SLIDERS)) SLIDERS[k].el = $(SLIDERS[k][0]);

const MODE_NOTES = {
  scan:     'A read head sweeps the frame. Whatever column it is over is the chord you hear.',
  spectrum: 'Every row sounds at once. Brightness sets the level, and where that brightness sits sets the pan.',
  hue:      'A grid of cells, one voice each. Color picks the note, brightness picks the level.',
  motion:   'Silent until the picture changes. Only movement makes sound, so a still room is a rest.',
};

// ---------------------------------------------------------------------------
// Config

const cfg = {
  mode: 'scan', bands: 48, rate: 0.5, dir: 'lr',
  fLow: 110, fHigh: 3520, scale: 'off', root: 0,
  wave: 'sine', glide: 8, attack: 8, release: 120,
  gate: 0.22, contrast: 1.6, invert: false, mirror: true, overlay: true,
  width: 0.8, space: 0.25, tone: 9000,
  // Derived and runtime, never saved. `scanPhase` is where the read head sits
  // right now, 0..1; the accumulator it comes from lives in the render loop.
  scanPhase: 0,
  bandFreqs: new Float64Array(MAX_BANDS),
  scaleList: null,
};

/** Keys written to a settings file, in the order they appear in the drawer. */
const SAVED = ['mode', 'bands', 'rate', 'dir', 'fLow', 'fHigh', 'scale', 'root',
  'wave', 'glide', 'attack', 'release', 'gate', 'contrast', 'invert',
  'mirror', 'overlay', 'width', 'space', 'tone'];

const analyzer = new Analyzer(MAX_BANDS);
let lastRead = null;
let lastTouched = '';

function segValue(root) {
  const on = root.querySelector('[aria-checked="true"]');
  return on ? on.dataset.v : root.firstElementChild.dataset.v;
}
function setSeg(root, v) {
  for (const b of root.children) b.setAttribute('aria-checked', String(b.dataset.v === v));
}

/** Pull every control into `cfg`, then rebuild what depends on it. */
function syncFromUI() {
  cfg.mode = segValue(els.mode);
  cfg.wave = segValue(els.wave);
  cfg.bands = BAND_STEPS[clamp(+els.bands.value | 0, 0, BAND_STEPS.length - 1)];
  cfg.dir = els.dir.value;
  cfg.scale = els.scale.value;
  cfg.root = +els.root.value | 0;
  cfg.invert = els.invert.checked;
  cfg.mirror = els.mirror.checked;
  cfg.overlay = els.overlay.checked;
  for (const k of Object.keys(SLIDERS)) cfg[k] = SLIDERS[k][1].fromPos(+SLIDERS[k].el.value);

  // The two pitch ends share one axis, so one of them has to give way. The one
  // that gives way is the one the hand is not on.
  if (cfg.fHigh < cfg.fLow * 1.5) {
    if (lastTouched === 'flow') {
      cfg.fHigh = Math.min(SLIDERS.fHigh[1].hi, cfg.fLow * 1.5);
      SLIDERS.fHigh.el.value = String(SLIDERS.fHigh[1].toPos(cfg.fHigh));
    } else {
      cfg.fLow = Math.max(SLIDERS.fLow[1].lo, cfg.fHigh / 1.5);
      SLIDERS.fLow.el.value = String(SLIDERS.fLow[1].toPos(cfg.fLow));
    }
  }

  cfg.scaleList = scaleFreqList(cfg.fLow, cfg.fHigh, cfg.scale, cfg.root);
  buildBandFreqs(cfg.bands, cfg.fLow, cfg.fHigh, cfg.scale, cfg.root, cfg.bandFreqs);
}

/** Push `cfg` back out to the readouts and the enabled/disabled states. */
function paintUI() {
  for (const k of Object.keys(SLIDERS)) {
    const [id, , fmt] = SLIDERS[k];
    const el = SLIDERS[k].el;
    el.style.setProperty('--p', (+el.value / 10) + '%');
    const out = $(id + 'Val');
    if (out) out.textContent = fmt(cfg[k]);
  }
  els.bands.style.setProperty('--p', (+els.bands.value / (BAND_STEPS.length - 1) * 100) + '%');
  // Hue mode arranges its bands as a grid, and the grid is the thing worth
  // knowing — 24 bands is 6 by 4, and that shape is what you will see.
  if (cfg.mode === 'hue') {
    const g = gridFor(cfg.bands);
    els.bandsVal.textContent = cfg.bands + ' · ' + g.cols + '×' + g.rows;
  } else {
    els.bandsVal.textContent = String(cfg.bands);
  }
  els.modeNote.textContent = MODE_NOTES[cfg.mode];

  const sweeps = cfg.mode === 'scan';
  els.rateCtl.classList.toggle('disabled', !sweeps);
  els.dirField.classList.toggle('disabled', !sweeps);
  els.rootField.classList.toggle('disabled', cfg.scale === 'off');
}

// Any hand-turned control means this is no longer somebody else's preset.
function clearPresetMark() {
  for (const c of els.presets.children) c.setAttribute('aria-pressed', 'false');
}

els.dock.addEventListener('input', onControl);
els.dock.addEventListener('change', onControl);
function onControl(e) {
  if (!e.target || !e.target.id) return;
  lastTouched = e.target.id;
  // Once it is set by hand, switching cameras stops guessing at it.
  if (e.target.id === 'mirror') autoMirror = false;
  syncFromUI();
  paintUI();
  clearPresetMark();
}

for (const root of [els.mode, els.wave]) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    setSeg(root, b.dataset.v);
    lastTouched = root.id;
    syncFromUI();
    paintUI();
    clearPresetMark();
  });
}

// ---------------------------------------------------------------------------
// Presets and settings files

const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
const DIRS = ['lr', 'rl', 'ping'];
const SCALE_KEYS = ['off', 'chromatic', 'major', 'minor', 'pentatonic', 'wholetone', 'fifths', 'harmonic'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Write a settings object onto the controls. Only keys the object actually
 * carries are touched — which is what lets a preset describe a *sound* and stay
 * out of Mirror and Overlay, two switches that belong to the room and the
 * screen rather than to the patch.
 */
function applyCfg(o) {
  if (!o || typeof o !== 'object' || !MODE_NOTES[o.mode]) throw new Error('unrecognized settings');
  setSeg(els.mode, o.mode);
  if (has(o, 'wave') && WAVES.indexOf(o.wave) >= 0) setSeg(els.wave, o.wave);
  if (has(o, 'bands')) {
    const bi = BAND_STEPS.indexOf(+o.bands);
    if (bi >= 0) els.bands.value = String(bi);
  }
  if (has(o, 'dir') && DIRS.indexOf(o.dir) >= 0) els.dir.value = o.dir;
  if (has(o, 'scale') && SCALE_KEYS.indexOf(o.scale) >= 0) els.scale.value = o.scale;
  if (has(o, 'root')) els.root.value = String(clamp(+o.root | 0, 0, 11));
  if (has(o, 'invert')) els.invert.checked = !!o.invert;
  if (has(o, 'mirror')) els.mirror.checked = !!o.mirror;
  if (has(o, 'overlay')) els.overlay.checked = !!o.overlay;

  // Both ends of the pitch range are resolved together before either is
  // written, so a file whose low sits above the current high is not silently
  // clamped by the constraint on the way in.
  let lo = has(o, 'fLow') && isFinite(+o.fLow) ? +o.fLow : cfg.fLow;
  let hi = has(o, 'fHigh') && isFinite(+o.fHigh) ? +o.fHigh : cfg.fHigh;
  lo = clamp(lo, SLIDERS.fLow[1].lo, SLIDERS.fLow[1].hi);
  hi = clamp(Math.max(hi, lo * 1.5), SLIDERS.fHigh[1].lo, SLIDERS.fHigh[1].hi);
  for (const k of Object.keys(SLIDERS)) {
    const v = k === 'fLow' ? lo : k === 'fHigh' ? hi : (has(o, k) ? +o[k] : NaN);
    if (isFinite(v)) SLIDERS[k].el.value = String(SLIDERS[k][1].toPos(v));
  }

  // Straight through the same read the drawer uses, so there is exactly one
  // place that knows what a control means.
  lastTouched = '';
  syncFromUI();
  paintUI();
}

PRESETS.forEach((p, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = p.name;
  b.title = p.note;
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => {
    applyCfg(p.cfg);
    clearPresetMark();
    b.setAttribute('aria-pressed', 'true');
    toast(p.note);
  });
  els.presets.appendChild(b);
});

NOTES.forEach((n, i) => {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = n;
  els.root.appendChild(o);
});

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

els.saveState.addEventListener('click', () => {
  // `version` is the shape of the file; `build` is the codebase that wrote it.
  const out = { app: 'v2a', version: 1, build: window.buildVersion?.() ?? 'unknown' };
  for (const k of SAVED) out[k] = cfg[k];
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'v2a-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Settings saved');
});

els.loadState.addEventListener('click', () => els.settingsFile.click());
els.settingsFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                      // so the same file can be picked twice
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      applyCfg(JSON.parse(fr.result));
      clearPresetMark();
      toast('Settings loaded');
    } catch (_) {
      toast('Invalid settings file');
    }
  };
  fr.onerror = () => toast('Could not read that file');
  fr.readAsText(file);
});

// ---------------------------------------------------------------------------
// Drawer

function setDock(open) {
  els.dock.classList.toggle('open', open);
  els.scrim.classList.toggle('show', open);
  // The phone sheet takes its space out of the stage rather than covering it;
  // the class is what the stylesheet keys that off, and it does nothing at all
  // on a wide screen where the drawer sits beside the picture.
  document.body.classList.toggle('sheet-open', open);
  els.dockBtn.setAttribute('aria-expanded', String(open));
}
els.dockBtn.addEventListener('click', () => setDock(!els.dock.classList.contains('open')));
els.scrim.addEventListener('click', () => setDock(false));

// ---------------------------------------------------------------------------
// Audio

let audioCtx = null, engine = null, audioStarted = false;

// iOS 16.4+: onto the media channel, so the hardware ringer switch cannot
// silence us. Safe here even with the camera running — the app never asks for
// an audio track, and it is audio *capture* that 'playback' forbids.
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) {}
}

// iOS routinely leaves the context suspended after a single resume(). Loop.
async function resumeCtx() {
  for (let i = 0; i < 6 && audioCtx.state !== 'running'; i++) {
    try { await audioCtx.resume(); } catch (_) {}
    if (audioCtx.state !== 'running') await new Promise((r) => setTimeout(r, 60));
  }
  return audioCtx.state === 'running';
}

async function startAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.addEventListener('statechange', () => {
    if (audioStarted && !document.hidden &&
        (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
      audioCtx.resume().catch(() => {});
    }
  });
  engine = new Engine(audioCtx);
  engine.setMaster(HeaderVolume.gain);
  setAudioSession('playback');
  audioStarted = true;
  if (!(await resumeCtx())) toast('Audio is blocked. Move the volume slider again.');
  updateHint();
}

// The header slider is both the on switch and the level. onGesture fires on
// pointerup and on keyboard commits, never on pointerdown: iOS only grants
// audio activation when a gesture completes. Both of these are registered at
// the bottom of the file — onChange fires once as it mounts, and that first
// call reaches updateHint before the source state below has been initialized.
async function onVolumeGesture() {
  if (!audioStarted) { startAudio(); return; }
  if (audioCtx.state !== 'running' && !(await resumeCtx())) {
    toast('Audio is blocked. Move the volume slider again.');
  }
}
function onVolumeChange(gain) {
  if (engine) engine.setMaster(gain);
  updateHint();
}

function updateHint() {
  const live = !!sourceKind;
  // Nothing to hold before there is a picture, and a button that silently does
  // nothing is worse than one that says so by being grey.
  els.holdBtn.disabled = !live;
  const silent = HeaderVolume.percent === 0 || !audioStarted || (audioCtx && audioCtx.state !== 'running');
  els.hint.hidden = !(live && silent);
  if (!els.hint.hidden) els.hint.textContent = 'Raise the volume to hear the picture';
}

// ---------------------------------------------------------------------------
// Source

let stream = null, objUrl = null, sourceKind = null;
let facing = 'user';
let autoMirror = true;   // until the Mirror switch is touched by hand

function stopSource() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  els.video.pause();
  els.video.srcObject = null;
  if (els.video.hasAttribute('src')) { els.video.removeAttribute('src'); els.video.load(); }
  if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
  analyzer.hasPrev = false;
}

function setMirror(on) {
  if (!autoMirror) return;
  els.mirror.checked = on;
  syncFromUI();
  paintUI();
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('This browser has no camera API');
    return;
  }
  stopSource();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    // The browser's own error name is worth more than any guess we could make
    // about why: NotAllowedError and NotFoundError need different answers.
    toast('Camera unavailable: ' + ((err && err.name) || 'error'));
    return;
  }
  els.video.srcObject = stream;
  els.video.loop = false;
  sourceKind = 'camera';
  setHold(false);
  try { await els.video.play(); } catch (_) {}
  els.idle.hidden = true;
  els.transport.hidden = true;
  setMirror(facing === 'user');
  updateHint();
}

function openVideoFile(file) {
  if (!file) return;
  if (!/^video\//.test(file.type) && !/\.(mp4|webm|mov|m4v|ogv|ogg)$/i.test(file.name)) {
    toast('That is not a video file');
    return;
  }
  stopSource();
  objUrl = URL.createObjectURL(file);
  els.video.src = objUrl;
  els.video.loop = els.loopBtn.getAttribute('aria-pressed') === 'true';
  sourceKind = 'file';
  setHold(false);
  els.video.play().catch(() => {});
  els.idle.hidden = true;
  els.transport.hidden = false;
  autoMirror = true;
  setMirror(false);
  updateHint();
}

els.camBtn.addEventListener('click', startCamera);
els.camBtn2.addEventListener('click', () => { setDock(false); startCamera(); });
els.flipBtn.addEventListener('click', () => {
  facing = facing === 'user' ? 'environment' : 'user';
  autoMirror = true;
  if (sourceKind === 'camera') startCamera(); else toast('Camera is not running');
});
for (const b of [els.fileBtn, els.fileBtn2]) {
  b.addEventListener('click', () => { setDock(false); els.videoFile.click(); });
}
els.videoFile.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  openVideoFile(f);
});

// Drop a file anywhere on the page.
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) els.stage.classList.add('dragging');
});
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; els.stage.classList.remove('dragging'); }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.stage.classList.remove('dragging');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (/json$/i.test(f.type) || /\.json$/i.test(f.name)) {
    const fr = new FileReader();
    fr.onload = () => {
      try { applyCfg(JSON.parse(fr.result)); clearPresetMark(); toast('Settings loaded'); }
      catch (_) { toast('Invalid settings file'); }
    };
    fr.readAsText(f);
    return;
  }
  openVideoFile(f);
});

// ---------------------------------------------------------------------------
// Transport, for files

const PLAY_D = 'M8 5.5l11 6.5-11 6.5z';
const PAUSE_D = 'M9 5.5h2.6v13H9zM15.4 5.5H18v13h-2.6z';

function setPlayIcon() {
  const playing = !els.video.paused && !els.video.ended;
  els.playIcon.setAttribute('d', playing ? PAUSE_D : PLAY_D);
  els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

els.playBtn.addEventListener('click', () => {
  if (els.video.paused) els.video.play().catch(() => {});
  else els.video.pause();
});
els.loopBtn.addEventListener('click', () => {
  const on = els.loopBtn.getAttribute('aria-pressed') !== 'true';
  els.loopBtn.setAttribute('aria-pressed', String(on));
  els.video.loop = on;
});
let seeking = false;
els.seek.addEventListener('pointerdown', () => { seeking = true; });
els.seek.addEventListener('pointerup', () => { seeking = false; });
els.seek.addEventListener('input', () => {
  const d = els.video.duration;
  if (isFinite(d) && d > 0) els.video.currentTime = (+els.seek.value / 1000) * d;
});
els.video.addEventListener('play', setPlayIcon);
els.video.addEventListener('pause', setPlayIcon);
els.video.addEventListener('timeupdate', () => {
  const d = els.video.duration;
  els.timeNow.textContent = fmtTime(els.video.currentTime);
  els.timeAll.textContent = fmtTime(d);
  if (!seeking && isFinite(d) && d > 0) {
    els.seek.value = String(Math.round((els.video.currentTime / d) * 1000));
    els.seek.style.setProperty('--p', (els.video.currentTime / d * 100) + '%');
  }
});

// ---------------------------------------------------------------------------
// Hold
//
// Holding takes a snapshot and analyzes that, rather than just freezing the
// numbers. It costs one canvas and buys the ability to keep turning knobs
// against an unchanging picture, which is the only way to hear what a knob
// actually does.

let frozen = null;
let wasPlaying = false;

function setHold(on) {
  if (on && !sourceReady()) return;
  els.holdBtn.setAttribute('aria-pressed', String(on));
  if (on) {
    frozen = document.createElement('canvas');
    frozen.width = els.video.videoWidth;
    frozen.height = els.video.videoHeight;
    frozen.getContext('2d').drawImage(els.video, 0, 0);
    wasPlaying = !els.video.paused;
    els.video.pause();
  } else {
    frozen = null;
    if (wasPlaying) els.video.play().catch(() => {});
    wasPlaying = false;
    analyzer.hasPrev = false;   // no phantom motion from the gap
  }
}
els.holdBtn.addEventListener('click', () => setHold(!frozen));

// A tap on the picture holds it, and another tap lets it go. Reversible, and
// the only thing a bare tap is allowed to do — everything destructive lives in
// the drawer.
els.view.addEventListener('click', () => { if (sourceKind) setHold(!frozen); });

document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Escape') { setDock(false); return; }
  if (e.key === 'h' || e.key === 'H') { setHold(!frozen); return; }
  if (e.key === ' ' && sourceKind === 'file') {
    e.preventDefault();
    if (els.video.paused) els.video.play().catch(() => {}); else els.video.pause();
  }
});

// ---------------------------------------------------------------------------
// Render loop

function sourceReady() {
  return !!sourceKind && els.video.readyState >= 2 && els.video.videoWidth > 0;
}

function resizeView() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(els.view.clientWidth * dpr);
  const h = Math.round(els.view.clientHeight * dpr);
  if (w && h && (els.view.width !== w || els.view.height !== h)) {
    els.view.width = w;
    els.view.height = h;
  }
}
window.addEventListener('resize', resizeView);

// The sweep accumulates in sweeps, not in phase, so that "back and forth" can
// read a triangle straight off it and a direction change never jumps the head.
let scanT = 0;
function scanPhase() {
  if (cfg.dir === 'rl') return 1 - (scanT % 1);
  if (cfg.dir === 'ping') { const u = scanT % 2; return u < 1 ? u : 2 - u; }
  return scanT % 1;
}

let lastTs = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = lastTs ? Math.min(0.1, (now - lastTs) / 1000) : 0;
  lastTs = now;
  resizeView();

  const ready = sourceReady() || !!(frozen && frozen.width > 0);
  if (ready) {
    // A held frame in Motion mode has nothing to differ against, so holding it
    // holds the last levels rather than dropping them to silence.
    if (!(frozen && cfg.mode === 'motion')) {
      if (!frozen && cfg.mode === 'scan') {
        scanT += dt * cfg.rate;
        if (scanT > 1e6) scanT = 0;
      }
      cfg.scanPhase = scanPhase();
      lastRead = analyzer.read(frozen || els.video, cfg);
    }
  }

  if (engine) {
    if (ready && lastRead) engine.update(lastRead.amps, lastRead.pans, lastRead.freqs, cfg.bands, cfg);
    else engine.silence();
  }
  drawView(ready);
}

function drawView(ready) {
  const g = viewCtx;
  const W = els.view.width, H = els.view.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!ready) return;

  const src = frozen || els.video;
  const sw = frozen ? frozen.width : els.video.videoWidth;
  const sh = frozen ? frozen.height : els.video.videoHeight;
  if (!sw || !sh) return;

  // Letterbox, never crop. The band grid is a resampling of the whole frame,
  // so cropping the preview would show a picture that is not the one being
  // heard — and the overlay would be lying about which row is which.
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s, dh = sh * s, dx = (W - dw) / 2, dy = (H - dh) / 2;

  g.save();
  if (cfg.mirror) { g.translate(dx + dw, dy); g.scale(-1, 1); g.drawImage(src, 0, 0, dw, dh); }
  else g.drawImage(src, dx, dy, dw, dh);
  g.restore();

  if (frozen) {
    g.strokeStyle = 'rgba(90,210,230,0.75)';
    g.lineWidth = Math.max(1, 2 * (window.devicePixelRatio || 1));
    g.strokeRect(dx + 1, dy + 1, dw - 2, dh - 2);
  }
  if (cfg.overlay && lastRead) drawOverlay(g, dx, dy, dw, dh);
}

// The overlay is the piece's one honest claim: it says which part of the
// picture is making which sound. So it has to be legible over a night sky and
// over a whitewashed wall, and an additive blend can only manage the first —
// over bright stone it disappears entirely. Hence the dark plate down the left
// edge: the meters are drawn on their own ground, and only their long tails
// reach out across the picture.
function drawOverlay(g, dx, dy, dw, dh) {
  const amps = lastRead.amps;
  const n = cfg.bands;
  const dpr = window.devicePixelRatio || 1;
  g.save();

  if (cfg.mode === 'hue') {
    const { cols, rows } = gridFor(n);
    const cw = dw / cols, ch = dh / rows;
    const rmax = Math.min(cw, ch) * 0.42;
    g.lineWidth = Math.max(1, 1.5 * dpr);
    for (let i = 0; i < n; i++) {
      const a = amps[i];
      if (a <= 0.004) continue;
      const cx = dx + ((i % cols) + 0.5) * cw;
      const cy = dy + (Math.floor(i / cols) + 0.5) * ch;
      g.beginPath();
      g.arc(cx, cy, rmax * (0.2 + 0.8 * a), 0, Math.PI * 2);
      g.fillStyle = 'rgba(90,210,230,' + (0.12 + 0.3 * a) + ')';
      g.fill();
      // The ring is what keeps a quiet cell visible against a bright wall,
      // where a 12% fill is simply not there.
      g.strokeStyle = 'rgba(150,235,250,' + (0.3 + 0.45 * a) + ')';
      g.stroke();
    }
  } else {
    const gutter = Math.min(dw * 0.13, 128 * dpr);
    g.fillStyle = 'rgba(4,6,11,0.44)';
    g.fillRect(dx, dy, gutter, dh);

    const rowH = dh / n;
    const barH = Math.max(1, rowH * 0.42);
    for (let i = 0; i < n; i++) {
      const a = amps[i];
      const y = dy + (i + 0.5) * rowH - barH / 2;
      g.fillStyle = 'rgba(122,222,240,' + (0.4 + 0.5 * a) + ')';
      g.fillRect(dx, y, gutter * 0.14 + dw * 0.36 * a, barH);
    }

    if (cfg.mode === 'scan') {
      const x = dx + analyzer.scanX * dw;
      // A short trail behind the head, so the sweep reads as having a
      // direction without having to be watched for a second first.
      const back = cfg.dir === 'rl' ? 1 : -1;
      const len = dw * 0.1;
      const grad = g.createLinearGradient(x, 0, x + back * len, 0);
      grad.addColorStop(0, 'rgba(232,97,159,0.2)');
      grad.addColorStop(1, 'rgba(232,97,159,0)');
      g.fillStyle = grad;
      g.fillRect(Math.min(x, x + back * len), dy, len, dh);
      g.fillStyle = 'rgba(255,164,208,0.92)';
      g.fillRect(x - dpr, dy, Math.max(1.5, 2 * dpr), dh);
    }
  }
  g.restore();
}

// A tab nobody is looking at should not be droning at them from another window.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && engine) engine.silence();
});

// ---------------------------------------------------------------------------
// Go

applyCfg(DEFAULT_CFG);
els.presets.firstElementChild.setAttribute('aria-pressed', 'true');
resizeView();
setPlayIcon();
HeaderVolume.onGesture(onVolumeGesture);
HeaderVolume.onChange(onVolumeChange);
requestAnimationFrame(frame);
