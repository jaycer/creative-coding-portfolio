// A2V — audio in, visuals out. The mirror of V2A.
//
// This file is the wiring: it takes the room through the shared listener, turns
// what arrives into a handful of numbers a picture can use, keeps a beat clock
// that follows the room when there is one to follow and runs on its own when
// there is not, and hands all of that to whichever scene is up. The scenes
// live in scenes.js and know nothing about any of this.
//
// Sound stays local. The microphone is read and never recorded or sent.

import {
  startListening, stopListening, listenState, listenSource,
  inputName, inputChoices, currentInputId, useInput,
} from '../shared/listen.js';
import { SCENES, PALETTES, Palette } from './scenes.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), view: $('view'), idle: $('idle'), toast: $('toast'),
  dock: $('dock'), dockBtn: $('dockBtn'), scrim: $('scrim'),
  listenBtn: $('listenBtn'), fullBtn: $('fullBtn'), saveState: $('saveState'), loadState: $('loadState'),
  idleListen: $('idleListen'), idleWatch: $('idleWatch'), settingsFile: $('settingsFile'),
  meter: $('meter'), meterNum: $('meterNum'), meterMsg: $('meterMsg'), bpmText: $('bpmText'), dot: $('dot'),
  scene: $('scene'), sceneNote: $('sceneNote'),
  res: $('res'), resVal: $('resVal'), resCtl: $('resCtl'),
  palettes: $('palettes'), paletteNote: $('paletteNote'), tiles: $('tiles'), tilesVal: $('tilesVal'),
  sens: $('sens'), sensVal: $('sensVal'), freeBpm: $('freeBpm'), freeBpmVal: $('freeBpmVal'), autoScene: $('autoScene'),
  meterToggle: $('meterToggle'), listenStatus: $('listenStatus'), micRow: $('micRow'), micSelect: $('micSelect'),
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Config

const DEFAULTS = { scene: 'pixels', res: 48, palette: 'Neon', tiles: 1, sens: 1, freeBpm: 110, autoScene: 16, meter: true };
const cfg = { ...DEFAULTS };
const SAVED = Object.keys(DEFAULTS);

// Sensitivity is heard logarithmically, so its slider holds a position.
const SENS_LO = 0.25, SENS_HI = 4;
const sensFromPos = (p) => SENS_LO * Math.pow(SENS_HI / SENS_LO, p / 1000);
const sensToPos = (v) => Math.round(1000 * Math.log(clamp(v, SENS_LO, SENS_HI) / SENS_LO) / Math.log(SENS_HI / SENS_LO));

function fillRange(el) {
  const lo = +el.min, hi = +el.max;
  el.style.setProperty('--p', ((+el.value - lo) / (hi - lo) * 100) + '%');
}

// ---------------------------------------------------------------------------
// Canvases
//
// Scenes draw onto `work`; the screen gets `work` either straight or repeated
// into mirrored tiles, the way Image Tiler lays a picture out. Keeping the two
// apart is what lets the tiling change under a scene without the scene knowing.

const vctx = els.view.getContext('2d');
const work = document.createElement('canvas');
const g = work.getContext('2d');
// The scene on its way out keeps drawing here while the new one fades in.
const work2 = document.createElement('canvas');
const g2 = work2.getContext('2d');
let W = 0, H = 0, dpr = 1;
const pal = new Palette();
const frame = { W: 0, H: 0, dpr: 1, pal, res: cfg.res, t: 0 };

function resize() {
  const r = els.stage.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = Math.max(1, Math.round(r.width * dpr));
  let h = Math.max(1, Math.round(r.height * dpr));
  // A ceiling on the pixel count: several scenes touch every pixel every
  // frame, and a phone at 3x does not need to be drawn at 3x to look right.
  const cap = 2.4e6;
  if (w * h > cap) {
    const k = Math.sqrt(cap / (w * h));
    w = Math.round(w * k);
    h = Math.round(h * k);
    dpr *= k;
  }
  if (w === W && h === H) return;
  W = w; H = h;
  els.view.width = work.width = work2.width = W;
  els.view.height = work.height = work2.height = H;
  frame.W = W; frame.H = H; frame.dpr = dpr;
  fade = null;
  if (scene) scene.enter(g, frame);
}
let resizeTimer = null;
new ResizeObserver(() => {
  // Debounced: a sheet sliding open reports a dozen sizes on the way.
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 120);
}).observe(els.stage);

// ---------------------------------------------------------------------------
// The audio frame
//
// One object, filled every frame, read by the scene. Everything in it is
// already normalized to THIS room: each band is scored against the loudest it
// has been in the last several seconds, so a laptop speaker across the room
// and a PA both use the full range. That is also why the picture does not go
// flat when a track gets quieter: it follows the shape, not the gain.

const a = {
  t: 0, dt: 0,
  level: 0, bass: 0, mid: 0, treb: 0,   // 0 to 1
  hit: 0, struck: false,                 // onset strength (decays) and the frame it landed
  phase: 0, pulse: 0,                    // across the beat; 1 on the beat, decaying
  beat: false, bar: false, beatN: 0, barN: 0,
  bpm: cfg.freeBpm, locked: false, live: false,
};

let ctx = null;
let tapSrc = null, anSlow = null, anFast = null, anPitch = null, zero = null;
let specSlow = null, specFast = null, prevFast = null, wave = null, specPitch = null;
let bandBins = null;   // [bassLo, bassHi, midHi, trebHi] in slow-analyser bins
let fluxLo = 1, fluxHi = 2;
let binPc = null;      // pitch-analyser bin -> pitch class 0..11, or -1 outside the range read

// Running peaks the bands are scored against, and the smoothed results.
const peak = { level: 0, bass: 0, mid: 0, treb: 0 };
const sm = { level: 0, bass: 0, mid: 0, treb: 0 };
let fluxAvg = 0, lastHit = -10;

// Which notes are being heard: twelve pitch classes, each scored against the
// loudest of the twelve this frame and smoothed, for the Chromatic palette.
const chroma = new Float32Array(12);
const chromaRaw = new Float32Array(12);
let chromaHeard = false;   // true while the spectrum has notes in it

/**
 * Hang three analysers of our own off the listener's source node. Three,
 * because they want different things: a smoothed spectrum for the bands, so
 * the picture breathes rather than flickers; an unsmoothed one for onsets,
 * where any averaging would blunt exactly the edge being looked for; and a
 * long one for pitch, because telling C from C sharp in the fourth octave
 * takes bins a few hertz wide, which the other two are far too coarse for.
 * The listener swaps its source when the input changes, so this is checked
 * every frame.
 */
function retap() {
  const s = listenSource();
  if (s === tapSrc) return;
  tapSrc = s;
  if (zero) { try { zero.disconnect(); } catch { /* already gone */ } zero = null; }
  anSlow = anFast = anPitch = null;
  if (!s || !ctx) return;
  anSlow = ctx.createAnalyser();
  anSlow.fftSize = 2048;
  anSlow.smoothingTimeConstant = 0.6;
  anSlow.minDecibels = -90;
  anSlow.maxDecibels = -10;
  anFast = ctx.createAnalyser();
  anFast.fftSize = 1024;
  anFast.smoothingTimeConstant = 0;
  anFast.minDecibels = -90;
  anFast.maxDecibels = -10;
  anPitch = ctx.createAnalyser();
  anPitch.fftSize = 8192;
  anPitch.smoothingTimeConstant = 0.5;
  anPitch.minDecibels = -90;
  anPitch.maxDecibels = -10;
  // Through a gain of zero to the destination: WebKit pulls a graph from its
  // end, and an analyser hanging off nothing is never asked for a sample.
  zero = ctx.createGain();
  zero.gain.value = 0;
  for (const an of [anSlow, anFast, anPitch]) { s.connect(an); an.connect(zero); }
  zero.connect(ctx.destination);
  specSlow = new Uint8Array(anSlow.frequencyBinCount);
  specFast = new Uint8Array(anFast.frequencyBinCount);
  specPitch = new Uint8Array(anPitch.frequencyBinCount);
  prevFast = new Uint8Array(anFast.frequencyBinCount);
  wave = new Float32Array(anFast.fftSize);
  const hzSlow = ctx.sampleRate / anSlow.fftSize;
  const bin = (hz) => clamp(Math.round(hz / hzSlow), 1, anSlow.frequencyBinCount);
  bandBins = [bin(40), bin(150), bin(2000), bin(9000)];
  const hzFast = ctx.sampleRate / anFast.fftSize;
  fluxLo = clamp(Math.round(40 / hzFast), 1, anFast.frequencyBinCount);
  fluxHi = clamp(Math.round(8000 / hzFast), fluxLo + 1, anFast.frequencyBinCount);
  // Pitch class per bin, 80 Hz to 5 kHz: below that even these bins are too
  // coarse to tell semitones apart, above it there is little but hiss.
  const hzPitch = ctx.sampleRate / anPitch.fftSize;
  binPc = new Int8Array(anPitch.frequencyBinCount).fill(-1);
  for (let i = 1; i < binPc.length; i++) {
    const hz = i * hzPitch;
    if (hz < 80 || hz > 5000) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    binPc[i] = ((Math.round(midi) % 12) + 12) % 12;
  }
}

/** Fold the spectrum onto the twelve pitch classes. Power, not magnitude, so
 *  the notes stand out from the wash between them; then each class against
 *  the loudest, so a quiet passage keeps its colors. */
function chromaTick(dt) {
  anPitch.getByteFrequencyData(specPitch);
  chromaRaw.fill(0);
  for (let i = 1; i < binPc.length; i++) {
    const pc = binPc[i];
    if (pc < 0) continue;
    const v = specPitch[i] / 255;
    chromaRaw[pc] += v * v;
  }
  let top = 0;
  for (let k = 0; k < 12; k++) top = Math.max(top, chromaRaw[k]);
  chromaHeard = top > 0.05;
  const k = 1 - Math.exp(-dt / 0.15);
  for (let i = 0; i < 12; i++) chroma[i] += ((chromaHeard ? chromaRaw[i] / top : 0) - chroma[i]) * k;
}

function bandAvg(lo, hi) {
  let s = 0;
  for (let i = lo; i < hi; i++) s += specSlow[i];
  return s / Math.max(1, hi - lo) / 255;
}

/** Score a raw reading against its own recent peak, then smooth it: quick up,
 *  slower down, which is how loudness is heard. */
function score(key, raw, dt) {
  peak[key] = Math.max(raw, peak[key] * Math.exp(-dt / 6));
  let v = raw < 0.02 ? 0 : clamp(raw / Math.max(peak[key], 0.12) * cfg.sens, 0, 1);
  const tau = v > sm[key] ? 0.03 : 0.16;
  sm[key] += (v - sm[key]) * (1 - Math.exp(-dt / tau));
  return sm[key];
}

function analyze(dt) {
  retap();
  const room = listenState();
  const silent = !anSlow || room.level < 0.0005;
  if (silent) {
    for (const k of Object.keys(sm)) sm[k] *= Math.exp(-dt / 0.3);
    a.level = sm.level; a.bass = sm.bass; a.mid = sm.mid; a.treb = sm.treb;
    a.hit *= Math.exp(-dt / 0.14);
    a.struck = false;
    chromaHeard = false;
    return;
  }
  anSlow.getByteFrequencyData(specSlow);
  chromaTick(dt);
  a.bass = score('bass', bandAvg(bandBins[0], bandBins[1]), dt);
  a.mid = score('mid', bandAvg(bandBins[1], bandBins[2]), dt);
  a.treb = score('treb', bandAvg(bandBins[2], bandBins[3]), dt);

  anFast.getFloatTimeDomainData(wave);
  let sq = 0;
  for (let i = 0; i < wave.length; i++) sq += wave[i] * wave[i];
  const rms = Math.sqrt(sq / wave.length);
  peak.level = Math.max(rms, peak.level * Math.exp(-dt / 6));
  const lv = clamp(rms / Math.max(peak.level, 0.004) * cfg.sens, 0, 1);
  sm.level += (lv - sm.level) * (1 - Math.exp(-dt / (lv > sm.level ? 0.03 : 0.2)));
  a.level = sm.level;

  // Onsets: how much of the spectrum got louder since the last frame, against
  // the run of that figure. Only the rises; a note ending is not a hit.
  anFast.getByteFrequencyData(specFast);
  let flux = 0;
  for (let i = fluxLo; i < fluxHi; i++) {
    const d = specFast[i] - prevFast[i];
    if (d > 0) flux += d;
    prevFast[i] = specFast[i];
  }
  flux /= (fluxHi - fluxLo) * 255;
  fluxAvg += (flux - fluxAvg) * (1 - Math.exp(-dt / 1.2));
  a.hit *= Math.exp(-dt / 0.14);
  a.struck = false;
  if (flux > fluxAvg * (1 + 0.7 / cfg.sens) + 0.004 && a.t - lastHit > 0.1) {
    lastHit = a.t;
    a.struck = true;
    a.hit = Math.max(a.hit, clamp((flux - fluxAvg) / (fluxAvg * 2.5 + 0.01), 0.35, 1));
  }
}

// The Chromatic palette's three hues. They glide toward the three loudest
// pitch classes rather than snapping, so a chord change is a color change you
// can watch, and a note that comes and goes at the edge of hearing does not
// flicker the whole picture. With nothing heard they turn slowly, as Drift
// does, as a triad.
const hues = [0, 210, 120];
let idleHue = Math.random() * 360;
const PC_HUE = (pc) => pc * 30;   // C red, then thirty degrees a semitone
function huesTick(dt) {
  let want;
  if (live && chromaHeard) {
    const order = [...Array(12).keys()].sort((p, q) => chroma[q] - chroma[p]);
    want = [PC_HUE(order[0]), PC_HUE(order[1]), PC_HUE(order[2])];
  } else {
    idleHue = (idleHue + dt * 4) % 360;
    want = [idleHue, idleHue + 210, idleHue + 120];
  }
  const k = 1 - Math.exp(-dt / 0.35);
  for (let i = 0; i < 3; i++) {
    const d = ((want[i] - hues[i] + 540) % 360) - 180;
    hues[i] = (hues[i] + d * k + 360) % 360;
  }
}

/** Nothing is being heard: give the scene a room to draw anyway, built from
 *  the free-running clock, so the piece is alive before the microphone is
 *  allowed and goes on being alive between tracks. */
function pretend() {
  const off = Math.exp(-(((a.phase - 0.5 + 1) % 1) ** 2) * 60);   // an off-beat hat
  // A track has phrases: it builds, breaks down, builds again. Two slow
  // swells that never quite line up, so the room on its own is not a loop.
  const swell = 0.5 + 0.3 * Math.sin(a.t / 6.1) + 0.2 * Math.sin(a.t / 15.7 + 1);
  const energy = 0.45 + 0.55 * swell;
  a.bass = (0.05 + 0.9 * a.pulse) * (0.55 + 0.45 * energy);
  a.mid = (0.35 + 0.2 * Math.sin(a.t * 0.7) + 0.2 * a.pulse) * (0.6 + 0.4 * energy);
  a.treb = (0.15 + 0.55 * off) * (0.3 + 0.7 * energy);
  a.level = (0.45 + 0.3 * a.pulse) * (0.5 + 0.5 * energy);
  a.hit *= Math.exp(-a.dt / 0.14);
  a.struck = false;
  if (a.beat) { a.hit = 0.85; a.struck = true; }
  else if (a.phase >= 0.5 && a.phase - a.dt * a.bpm / 60 < 0.5) { a.hit = Math.max(a.hit, 0.5); a.struck = true; }
}

// ---------------------------------------------------------------------------
// The clock
//
// The listener reports the room's grid as a beat time and a period in the
// audio clock. This keeps its own beat and, every frame, finds the grid beat
// nearest one period on from it; when the moment arrives it strikes. Rounding
// to the nearest grid beat is what makes it robust: the listener re-settles
// its phase a little with every estimate, and a follower that counted grid
// beats directly would strike twice when the grid shifted under it. When the
// room has nothing to say the grid is this clock's own last beat plus the
// free-run period, so the handover in either direction is one beat long.

let live = false;
let myLast = 0, started = false;
let grid = null, gridUntil = 0;

function clockTick(now) {
  const s = listenState();
  if (live && s.status === 'locked' && s.period > 0 && ctx) {
    grid = { bt: s.beatTime + (now - ctx.currentTime), per: s.period };
    gridUntil = now + 4;   // free-wheel this long through a fill or a track change
  }
  let bt = null, per;
  if (live && grid && now < gridUntil) {
    bt = grid.bt; per = grid.per;
    a.locked = s.status === 'locked';
    a.bpm = s.heard || 60 / per;
  } else {
    grid = null;
    per = 60 / cfg.freeBpm;
    a.locked = false;
    a.bpm = live && s.heard ? s.heard : cfg.freeBpm;
  }
  // The first frame, or the first one back from a hidden tab: strike now.
  // A flag, not a test of myLast itself — a beat can legitimately land at
  // zero, and a clock that read that as "never started" struck every frame
  // for the first half second of the page.
  if (!started || now - myLast > 4 * per) { started = true; myLast = now - per; }
  if (bt === null) bt = myLast;   // free run: the grid is our own last beat
  const n = Math.round((myLast + per - bt) / per);
  let next = bt + n * per;
  if (next < myLast + per * 0.5) next += per;
  a.beat = false;
  a.bar = false;
  if (now >= next) {
    a.beat = true;
    a.beatN++;
    myLast = next;
    next += per;
    if (a.beatN % 4 === 0) { a.bar = true; a.barN = a.beatN / 4; }
  }
  a.phase = clamp((now - myLast) / (next - myLast), 0, 1);
  a.pulse = Math.exp(-(now - myLast) / 0.16);
}

// ---------------------------------------------------------------------------
// Scenes

const made = {};
let scene = null;
let sceneDef = null;
let fade = null;         // { from, t }: the scene going out, and how long it has been going
const FADE = 1.4;        // seconds; a change of scene is a dissolve, not a cut
let barsInScene = 0;     // for the auto change while the microphone is off

function setScene(key, { quiet = false } = {}) {
  const def = SCENES.find((d) => d.key === key) || SCENES[0];
  cfg.scene = def.key;
  sceneDef = def;
  const next = made[def.key] || (made[def.key] = def.make());
  if (scene && next !== scene && W) {
    // Hand the outgoing scene its own canvas, with the picture it was drawing
    // still on it, so trails and accumulations carry on through the dissolve.
    g2.drawImage(work, 0, 0);
    fade = { from: scene, t: 0 };
  }
  scene = next;
  barsInScene = 0;
  if (W) scene.enter(g, frame);
  for (const b of els.scene.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === def.key));
  els.sceneNote.textContent = def.note;
  els.resCtl.classList.toggle('disabled', def.key !== 'pixels');
  if (!quiet) toast(def.name);
}
function stepScene(dir, opts) {
  const i = SCENES.findIndex((d) => d.key === cfg.scene);
  setScene(SCENES[(i + dir + SCENES.length) % SCENES.length].key, opts);
}

function present(src, alpha) {
  const n = cfg.tiles;
  vctx.globalAlpha = alpha;
  if (n <= 1) { vctx.drawImage(src, 0, 0); vctx.globalAlpha = 1; return; }
  // The middle of the picture, repeated, with every other tile mirrored so
  // the seams meet themselves.
  const tw = W / n, th = H / n;
  const sx = (W - tw) / 2, sy = (H - th) / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      vctx.save();
      vctx.translate(i * tw + (i % 2 ? tw : 0), j * th + (j % 2 ? th : 0));
      vctx.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
      vctx.drawImage(src, sx, sy, tw, th, 0, 0, tw, th);
      vctx.restore();
    }
  }
  vctx.globalAlpha = 1;
}

let lastT = 0;
const beatLog = [];   // the last few beat times, for the harness
function loop(ms) {
  requestAnimationFrame(loop);
  const now = ms / 1000;
  const dt = lastT ? clamp(now - lastT, 0, 0.1) : 1 / 60;
  lastT = now;
  if (!W || !scene) return;
  a.t = now;
  a.dt = dt;
  a.live = live;
  clockTick(now);
  if (live) analyze(dt); else pretend();
  if (pal.def.mode === 'drift') pal.drift(dt * 4 + (a.bar ? 25 : 0));
  else if (pal.def.mode === 'chroma') { huesTick(dt); pal.tune(hues); }
  frame.t = now;
  frame.res = cfg.res;

  if (a.beat) { scene.beat(a, frame); beatLog.push(+now.toFixed(3)); if (beatLog.length > 12) beatLog.shift(); }
  if (a.bar) {
    scene.bar(a, frame);
    // On its own, the piece changes scene for itself. With a room to follow
    // it stays where it was put.
    if (!live && cfg.autoScene && ++barsInScene >= cfg.autoScene) stepScene(1, { quiet: true });
  }
  if (a.struck) scene.hit(a, frame);
  scene.draw(g, frame, a);
  present(work, 1);
  if (fade) {
    fade.t += dt;
    if (fade.t >= FADE) fade = null;
    else {
      fade.from.draw(g2, frame, a);
      present(work2, 1 - fade.t / FADE);
    }
  }

  if (live && cfg.meter) els.dot.style.opacity = (0.3 + 0.7 * a.pulse).toFixed(2);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------------------
// Listening

const MIC_KEY = 'hey-chair-input';   // shared with Hey Chair, so one choice serves both
const rememberedMic = () => { try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; } };
const rememberMic = (id) => { try { localStorage.setItem(MIC_KEY, id); } catch { /* private mode */ } };

const LISTEN_TEXT = {
  asking: ['Asking for the microphone…', false],
  listening: ['Listening for a beat…', false],
  quiet: ['Too quiet to hear a beat.', false],
  silent: ['The microphone is open but completely silent.', true],
  lost: ['The microphone was taken away. Press Listen again to get it back.', true],
  denied: ['The microphone is blocked. Allow it for this site, then try again.', true],
  missing: ['No microphone found.', true],
  busy: ['The microphone would not open. Another app may have it, or this browser may need turning on under System Settings, Privacy and Security, Microphone.', true],
  insecure: ['The microphone needs a secure connection.', true],
  error: ['The microphone could not be opened.', true],
};

function silentText() {
  const name = inputName();
  const others = inputChoices().map((d) => d.label).filter((n) => n !== name);
  const which = name ? ` The input is "${name}".` : '';
  const rest = others.length
    ? ` Other inputs on this machine: ${others.join(', ')}. Pick one below.`
    : ' Check the input the system is using, and that this browser is allowed a microphone in System Settings.';
  return `The microphone is open but completely silent.${which}${rest}`;
}

function showStatus(text, warn) {
  els.listenStatus.textContent = text;
  els.listenStatus.classList.toggle('warn', !!warn);
  els.listenStatus.hidden = false;
}
function sayStatus(status) {
  const [text, warn] = LISTEN_TEXT[status] || LISTEN_TEXT.error;
  const detail = listenState().detail;
  const full = status === 'error' && detail ? `${text} (${detail})` : text;
  showStatus(full, warn);
  if (warn) toast(full);
}

function refreshInputs() {
  const choices = inputChoices();
  const liveId = currentInputId();
  if (choices.length < 2) { els.micRow.hidden = true; return; }
  const want = choices.map((d) => `${d.id}\u0000${d.label}`).join('|');
  if (els.micSelect.dataset.built !== want) {
    els.micSelect.dataset.built = want;
    els.micSelect.textContent = '';
    for (const d of choices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      els.micSelect.appendChild(opt);
    }
  }
  if (liveId && els.micSelect.value !== liveId) els.micSelect.value = liveId;
  els.micRow.hidden = false;
}

// Held for a while at a time: a reading that changes every quarter second is
// not a thing anybody can read, but a real change of track goes up at once.
const METER_HOLD = 10, METER_JUMP = 5;
const WAITING = '‒‒‒';   // figure dashes, a digit wide each
let shown = 0, shownAt = 0, wasLocked = false;

function refreshStatus() {
  refreshInputs();
  const s = listenState();
  const heard = Math.round(s.heard);
  const settled = s.status === 'locked' && !wasLocked;
  wasLocked = s.status === 'locked';
  const now = performance.now() / 1000;
  if (!heard) {
    els.bpmText.textContent = WAITING;
    shown = 0;
  } else if (settled || !shown || Math.abs(heard - shown) >= METER_JUMP || now - shownAt >= METER_HOLD) {
    shown = heard;
    shownAt = now;
    els.bpmText.textContent = String(heard).padStart(3, '0');
  }
  els.meter.classList.toggle('searching', s.status !== 'locked');
  // Until a tempo has been heard the pill says what is going on instead of
  // showing a placeholder, so a quiet room and a dead input read differently.
  const talking = !heard && (s.status === 'listening' || s.status === 'quiet' || s.status === 'silent');
  els.meterNum.hidden = talking;
  els.meterMsg.hidden = !talking;
  if (s.status === 'silent') {
    const text = silentText();
    showStatus(text, true);
    els.meterMsg.textContent = LISTEN_TEXT.silent[0];
  } else if (s.status === 'listening' || s.status === 'quiet' || s.status === 'locked') {
    const [text] = LISTEN_TEXT[s.status] || LISTEN_TEXT.listening;
    const where = inputName();
    showStatus(s.status === 'locked' ? `Following the room${where ? ` through ${where}` : ''}.` : text, false);
    els.meterMsg.textContent = text;
  } else if (s.status === 'lost' || s.status === 'off') {
    endListening();
    if (s.status === 'lost') sayStatus('lost');
  }
}

let statusTimer = null;
let asking = false, cancelled = false;

async function beginListening() {
  if (live || asking) return;
  asking = true;
  cancelled = false;
  setListenUI(true);
  showStatus(...LISTEN_TEXT.asking);
  els.meterMsg.textContent = LISTEN_TEXT.asking[0];
  els.meterNum.hidden = true;
  els.meterMsg.hidden = false;
  if (cfg.meter) els.meter.hidden = false;
  // Both in the same breath, sorted out afterwards: Safari counts the gesture
  // as spent at the first await, and the microphone needs it more.
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  const woken = ctx.resume().catch(() => {});
  const status = await startListening(ctx, null, woken, rememberedMic());
  asking = false;
  if (cancelled) { stopListening(); endListening(); return; }
  if (status !== 'listening') {
    stopListening();
    setListenUI(false);
    els.meter.hidden = true;
    sayStatus(status);
    return;
  }
  live = true;
  els.idle.hidden = true;
  shown = 0;
  wasLocked = false;
  statusTimer = setInterval(refreshStatus, 250);
  refreshStatus();
}

function endListening() {
  if (asking) { cancelled = true; return; }
  stopListening();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  live = false;
  grid = null;
  tapSrc = null;
  anSlow = anFast = anPitch = null;
  setListenUI(false);
  els.meter.hidden = true;
  els.listenStatus.hidden = true;
  els.micRow.hidden = true;
}

function setListenUI(on) {
  els.listenBtn.setAttribute('aria-pressed', String(on));
  els.listenBtn.textContent = on ? 'Listening' : 'Listen';
  els.listenBtn.title = on ? 'Turn the microphone off; it carries on by itself' : 'Follow whatever is playing in the room';
  barsInScene = 0;
}

els.listenBtn.addEventListener('click', () => { if (live || asking) endListening(); else beginListening(); });
els.idleListen.addEventListener('click', beginListening);
els.idleWatch.addEventListener('click', () => { els.idle.hidden = true; });
els.micSelect.addEventListener('change', async () => {
  const id = els.micSelect.value;
  rememberMic(id);
  showStatus('Switching microphone…', false);
  await useInput(id);
  refreshStatus();
});

// ---------------------------------------------------------------------------
// Controls

els.scene.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (b) setScene(b.dataset.v);
});
els.res.addEventListener('input', () => { cfg.res = +els.res.value; paintUI(); });
els.tiles.addEventListener('input', () => { cfg.tiles = +els.tiles.value; paintUI(); });
els.sens.addEventListener('input', () => { cfg.sens = sensFromPos(+els.sens.value); paintUI(); });
els.freeBpm.addEventListener('input', () => { cfg.freeBpm = +els.freeBpm.value; paintUI(); });
els.autoScene.addEventListener('change', () => { cfg.autoScene = +els.autoScene.value; barsInScene = 0; });
els.meterToggle.addEventListener('change', () => {
  cfg.meter = els.meterToggle.checked;
  els.meter.hidden = !(cfg.meter && (live || asking));
});

for (const p of PALETTES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = p.name;
  b.dataset.v = p.name;
  b.addEventListener('click', () => setPalette(p.name));
  els.palettes.appendChild(b);
}
function setPalette(name) {
  const def = PALETTES.find((p) => p.name === name) || PALETTES[0];
  cfg.palette = def.name;
  pal.use(def);
  for (const b of els.palettes.children) b.setAttribute('aria-pressed', String(b.dataset.v === def.name));
  els.paletteNote.textContent = def.note || '';
  els.paletteNote.hidden = !def.note;
}

function paintUI() {
  els.res.value = cfg.res;
  els.resVal.textContent = cfg.res + ' across';
  els.tiles.value = cfg.tiles;
  els.tilesVal.textContent = cfg.tiles <= 1 ? 'Off' : `${cfg.tiles}×${cfg.tiles}`;
  els.sens.value = sensToPos(cfg.sens);
  els.sensVal.textContent = cfg.sens.toFixed(2) + '×';
  els.freeBpm.value = cfg.freeBpm;
  els.freeBpmVal.textContent = cfg.freeBpm + ' BPM';
  els.autoScene.value = String(cfg.autoScene);
  els.meterToggle.checked = cfg.meter;
  for (const el of [els.res, els.tiles, els.sens, els.freeBpm]) fillRange(el);
}

function applyCfg(src) {
  if (!src || typeof src !== 'object') throw new Error('not an object');
  const num = (k, lo, hi) => { if (typeof src[k] === 'number' && Number.isFinite(src[k])) cfg[k] = clamp(src[k], lo, hi); };
  num('res', +els.res.min, +els.res.max);
  num('tiles', 1, 6);
  num('sens', SENS_LO, SENS_HI);
  num('freeBpm', +els.freeBpm.min, +els.freeBpm.max);
  num('autoScene', 0, 64);
  if (![0, 8, 16, 32].includes(cfg.autoScene)) cfg.autoScene = DEFAULTS.autoScene;
  cfg.res = Math.round(cfg.res);
  cfg.tiles = Math.round(cfg.tiles);
  cfg.freeBpm = Math.round(cfg.freeBpm);
  if (typeof src.meter === 'boolean') cfg.meter = src.meter;
  if (typeof src.palette === 'string') setPalette(src.palette);
  if (typeof src.scene === 'string') setScene(src.scene, { quiet: true });
  paintUI();
  els.meter.hidden = !(cfg.meter && (live || asking));
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

els.saveState.addEventListener('click', () => {
  // `version` is the shape of the file; `build` is the codebase that wrote it.
  const out = { app: 'a2v', version: 1, build: window.buildVersion?.() ?? 'unknown' };
  for (const k of SAVED) out[k] = cfg[k];
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'a2v-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Settings saved');
});
els.loadState.addEventListener('click', () => els.settingsFile.click());
els.settingsFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    try { applyCfg(JSON.parse(fr.result)); toast('Settings loaded'); }
    catch { toast('Invalid settings file'); }
  };
  fr.onerror = () => toast('Could not read that file');
  fr.readAsText(file);
});

// Drawer
function setDock(open) {
  els.dock.classList.toggle('open', open);
  els.scrim.classList.toggle('show', open);
  els.dockBtn.setAttribute('aria-expanded', String(open));
}
els.dockBtn.addEventListener('click', () => setDock(!els.dock.classList.contains('open')));
els.scrim.addEventListener('click', () => setDock(false));

// Fullscreen, where the browser offers it (iPhone does not).
if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
  els.fullBtn.hidden = false;
  els.fullBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    els.fullBtn.setAttribute('aria-pressed', String(!!document.fullscreenElement));
  });
}

// A tap on the picture steps to the next scene. A drag does not: that is
// someone adjusting their grip on a phone, not a request.
let press = null;
els.view.addEventListener('pointerdown', (e) => { press = { x: e.clientX, y: e.clientY }; });
els.view.addEventListener('pointerup', (e) => {
  if (!press) return;
  const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  press = null;
  if (moved < 8 && els.idle.hidden) stepScene(1);
});
els.view.addEventListener('pointercancel', () => { press = null; });

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key;
  if (k >= '1' && k <= String(SCENES.length)) setScene(SCENES[+k - 1].key);
  else if (k === 'ArrowRight' || k === ' ') { e.preventDefault(); stepScene(1); }
  else if (k === 'ArrowLeft') stepScene(-1);
  else if (k === 'l' || k === 'L') els.listenBtn.click();
  else if (k === 'c' || k === 'C') els.dockBtn.click();
  else if ((k === 'f' || k === 'F') && !els.fullBtn.hidden) els.fullBtn.click();
  else if (k === 'Escape') setDock(false);
  else return;
  if (els.idle.hidden === false && k !== 'l' && k !== 'L') els.idle.hidden = true;
});

// For the harness (tools/shoot.mjs): a snapshot of what the piece is working
// from, read through the same module scope a visitor's clicks reach.
window.a2vState = () => {
  const s = listenState();
  return { ...a, scene: cfg.scene, fading: !!fade, bars: barsInScene, beats: beatLog.slice(), chroma: Array.from(chroma, (v) => +v.toFixed(3)), hues: hues.map(Math.round), room: { status: s.status, heard: s.heard, conf: s.conf, level: s.level } };
};

// ---------------------------------------------------------------------------
// Go

setPalette(cfg.palette);
paintUI();
resize();
setScene(cfg.scene, { quiet: true });
