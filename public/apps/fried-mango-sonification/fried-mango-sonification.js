// fried-mango-sonification.js — the page around the score.
//
// The work is elsewhere: sonify.js writes the notes, synth.js plays them,
// midi.js files them. This is the search panel, the transport, the picture of
// the score and the mixer.
//
// The search stays in this tab. It is read from a file, turned into notes
// here, and the only things that leave are the files you export.

import { TRACKS, DRUM, normalizeSearch, perDay, sonify } from './sonify.js';
import { createSynth, renderScore, encodeWav } from './synth.js';
import { makeMidi } from './midi.js';
import { makeDawProject } from './dawproject.js';
import { demoSearch } from './demo.js';

const $ = (id) => document.getElementById(id);
const MIX_KEY = 'fried-mango-sonification:mix:v1';
const MASTER_DEFAULT = 0.5;

let search = normalizeSearch(demoSearch());
let isDemo = true;
let speed = 2;          // days per second; the tempo is 60 times this
let tailSec = 4;        // seconds of music after the last day
// The tail in whole beats, so the piece ends on the grid.
const tailBeats = () => Math.round(tailSec * speed);
let score = sonify(search, { tail: tailBeats() });

const mix = {
  master: MASTER_DEFAULT,
  level: Object.fromEntries(TRACKS.map((t) => [t.id, t.level])),
  mute: Object.fromEntries(TRACKS.map((t) => [t.id, false])),
  solo: Object.fromEntries(TRACKS.map((t) => [t.id, false])),
};

let ctx = null;
let synth = null;
let playing = false;
let startTime = 0;      // ctx time that beat `startBeat` falls on
let startBeat = 0;
let pausedBeat = 0;
let nextEvent = 0;      // index of the first event not yet scheduled
let pump = null;

const bpm = () => 60 * speed;
const secPerBeat = () => 1 / speed;

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const fmtClock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// ------------------------------------------------------------------ mixer

// What a track is actually set to, once mute and solo have had their say.
function heard(id) {
  const anySolo = TRACKS.some((t) => mix.solo[t.id]);
  const on = anySolo ? mix.solo[id] : !mix.mute[id];
  return on ? mix.level[id] : 0;
}
const heardLevels = () => Object.fromEntries(TRACKS.map((t) => [t.id, heard(t.id)]));

function pushMix() {
  if (synth) {
    for (const t of TRACKS) synth.setLevel(t.id, heard(t.id));
    synth.setMaster(mix.master);
  }
  for (const t of TRACKS) $(`strip-${t.id}`).classList.toggle('quiet', heard(t.id) === 0);
  rollImage = null;
  try { localStorage.setItem(MIX_KEY, JSON.stringify(mix)); } catch { /* private mode */ }
}

function restoreMix() {
  try {
    const raw = JSON.parse(localStorage.getItem(MIX_KEY) || 'null');
    if (!raw) return;
    if (Number.isFinite(raw.master)) mix.master = Math.max(0, Math.min(1, raw.master));
    for (const t of TRACKS) {
      if (Number.isFinite(raw.level?.[t.id])) mix.level[t.id] = Math.max(0, Math.min(1, raw.level[t.id]));
      mix.mute[t.id] = raw.mute?.[t.id] === true;
      mix.solo[t.id] = raw.solo?.[t.id] === true;
    }
  } catch { /* stale or corrupt, keep the defaults */ }
}

function buildMixer() {
  const host = $('mix');
  host.textContent = '';
  const strip = (id, name, sub, color, value, onInput, withChips) => {
    const row = document.createElement('div');
    row.className = 'strip' + (withChips ? '' : ' master');
    row.id = `strip-${id}`;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = color;
    const label = document.createElement('div');
    label.className = 'strip__name';
    label.textContent = name;
    const small = document.createElement('small');
    small.id = `sub-${id}`;
    small.textContent = sub;
    label.append(small);
    row.append(sw, label);
    for (const kind of ['mute', 'solo']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip ${kind}`;
      b.textContent = kind === 'mute' ? 'M' : 'S';
      if (!withChips) { b.style.visibility = 'hidden'; b.tabIndex = -1; row.append(b); continue; }
      b.setAttribute('aria-label', `${kind === 'mute' ? 'Mute' : 'Solo'} ${name}`);
      b.setAttribute('aria-pressed', String(mix[kind][id]));
      b.addEventListener('click', () => {
        mix[kind][id] = !mix[kind][id];
        b.setAttribute('aria-pressed', String(mix[kind][id]));
        pushMix();
      });
      row.append(b);
    }
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.value = String(Math.round(value * 100));
    slider.setAttribute('aria-label', `${name} level`);
    const out = document.createElement('output');
    out.textContent = slider.value;
    slider.addEventListener('input', () => { out.textContent = slider.value; onInput(Number(slider.value) / 100); pushMix(); });
    row.append(slider, out);
    host.append(row);
  };
  for (const t of TRACKS) strip(t.id, t.name, '', t.color, mix.level[t.id], (v) => { mix.level[t.id] = v; }, true);
  strip('master', 'Master', '', 'var(--accent)', mix.master, (v) => { mix.master = v; }, false);
  labelStrips();
}

function labelStrips() {
  for (const t of TRACKS) $(`sub-${t.id}`).textContent = `${t.voice} · ${score.counts[t.id].toLocaleString()} notes`;
  $('sub-master').textContent = `${score.events.length.toLocaleString()} notes in all`;
}

// --------------------------------------------------------------- transport

function position() {
  if (!playing || !ctx) return pausedBeat;
  return Math.min(score.beats, startBeat + (ctx.currentTime - startTime) / secPerBeat());
}

// Schedule everything due in the next quarter second. Run from a timer and
// not from the animation frame, so it keeps time in a tab nobody is watching.
function schedule() {
  if (!playing) return;
  const horizon = ctx.currentTime + 0.25;
  const spb = secPerBeat();
  while (nextEvent < score.events.length) {
    const e = score.events[nextEvent];
    const when = startTime + (e.beat - startBeat) * spb;
    if (when > horizon) break;
    synth.play(e, Math.max(when, ctx.currentTime), spb);
    nextEvent++;
  }
  if (position() >= score.beats) stop(0);
}

// A fresh mixer on the same context. Disconnecting the old one is what cuts
// off notes that are already ringing; there is no other handle on them.
function freshSynth() {
  if (synth) synth.master.disconnect();
  synth = createSynth(ctx);
  for (const t of TRACKS) synth.faders[t.id].gain.value = heard(t.id);
  synth.master.gain.value = mix.master;
}

async function play(fromBeat) {
  // iOS: the context has to be made, and resumed, inside the tap itself. A
  // context that will not run is thrown away so the next tap makes a new one.
  if (ctx && (ctx.state === 'closed' || ctx.state === 'interrupted')) { ctx = null; synth = null; }
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not there */ }
  }
  await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 200))]);
  if (ctx.state !== 'running') {
    try { ctx.close(); } catch { /* already gone */ }
    ctx = null; synth = null;
    toast('Audio did not start. Tap Play again.');
    return;
  }
  clearInterval(pump);
  freshSynth();
  startBeat = fromBeat >= score.beats ? 0 : Math.max(0, fromBeat);
  startTime = ctx.currentTime + 0.06;
  nextEvent = score.events.findIndex((e) => e.beat >= startBeat);
  if (nextEvent < 0) nextEvent = score.events.length;
  playing = true;
  $('play').classList.add('playing');
  $('play').setAttribute('aria-label', 'Pause');
  schedule();
  pump = setInterval(schedule, 50);
}

function stop(atBeat) {
  const at = atBeat ?? position();
  playing = false;
  clearInterval(pump);
  pausedBeat = at;
  if (ctx) freshSynth();
  $('play').classList.remove('playing');
  $('play').setAttribute('aria-label', 'Play');
}

const togglePlay = () => (playing ? stop() : play(pausedBeat));

function seek(beat) {
  const b = Math.max(0, Math.min(score.beats, beat));
  if (playing) play(b); else pausedBeat = b;
}

// A change to the notes themselves. Keeps the place, by day.
function rescore() {
  const at = position();
  const was = playing;
  if (was) stop();
  score = sonify(search, { tail: tailBeats() });
  pausedBeat = Math.min(at, score.beats);
  rollImage = null;
  labelStrips();
  showTempo();
  if (was) play(pausedBeat);
}

function showTempo() {
  $('tempo').textContent = `${bpm()} BPM · ${fmtClock(score.beats * secPerBeat())}`;
  const len = $('lengthIn');
  if (document.activeElement !== len) len.value = String(Number((score.beats * secPerBeat()).toFixed(2)));
  len.min = String(Math.ceil(search.days / speed));
}

// ------------------------------------------------------------------ score

let rollImage = null;
const LANE_ORDER = ['offers', 'interviews', 'applied', 'pursued', 'postings', 'days', 'milestones', 'beat'];

function sizeCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; rollImage = null; }
  return dpr;
}

function paintRoll(W, H, dpr) {
  const img = document.createElement('canvas');
  img.width = W; img.height = H;
  const g = img.getContext('2d');
  const laneH = H / LANE_ORDER.length;
  const x = (beat) => (beat / score.beats) * W;

  // Bars of the chord loop, faintly, and where the days end.
  g.fillStyle = 'rgba(255,255,255,0.025)';
  for (let b = 0; b < search.days; b += 32) g.fillRect(x(b), 0, x(16) - x(0), H);
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(x(search.days), 0, 1, H);

  LANE_ORDER.forEach((id, lane) => {
    const t = TRACKS.find((k) => k.id === id);
    const top = lane * laneH;
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, Math.round(top), W, 1);
    const notes = score.events.filter((e) => e.track === id);
    const drums = id === 'days' || id === 'milestones' || id === 'beat';
    let lo = Infinity, hi = -Infinity;
    if (!drums) for (const e of notes) { if (e.note < lo) lo = e.note; if (e.note > hi) hi = e.note; }
    const span = Math.max(1, hi - lo);
    g.globalAlpha = heard(id) === 0 ? 0.18 : 1;
    g.fillStyle = t.color;
    for (const e of notes) {
      const w = Math.max(1.5 * dpr, x(e.dur) - 0.5);
      let y, h;
      if (drums) {
        h = e.note === DRUM.kick || e.note === DRUM.crash ? laneH * 0.55 : e.note === DRUM.clap ? laneH * 0.38 : laneH * 0.22;
        y = top + laneH - h - 3 * dpr;
        g.globalAlpha = (heard(id) === 0 ? 0.18 : 1) * (0.35 + 0.65 * e.vel);
      } else {
        h = Math.max(2 * dpr, Math.min(5 * dpr, (laneH - 10 * dpr) / (span + 1)));
        y = top + 5 * dpr + (1 - (e.note - lo) / span) * (laneH - 10 * dpr - h);
        g.globalAlpha = (heard(id) === 0 ? 0.18 : 1) * (0.4 + 0.6 * e.vel);
      }
      g.fillRect(x(e.beat), y, w, h);
    }
    g.globalAlpha = 1;
    g.fillStyle = heard(id) === 0 ? 'rgba(148,156,171,0.4)' : 'rgba(221,225,232,0.8)';
    g.font = `${10 * dpr}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    g.textBaseline = 'top';
    g.fillText(t.name, 6 * dpr, top + 4 * dpr);
  });
  return img;
}

function drawRoll() {
  const canvas = $('roll');
  const dpr = sizeCanvas(canvas);
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  if (!rollImage) rollImage = paintRoll(W, H, dpr);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.drawImage(rollImage, 0, 0);
  const px = (position() / score.beats) * W;
  g.fillStyle = 'rgba(11,13,17,0.45)';
  g.fillRect(px, 0, W - px, H);
  g.fillStyle = '#f6a821';
  g.fillRect(Math.round(px) - dpr / 2, 0, Math.max(1, dpr), H);
}

// ----------------------------------------------------------- the readouts

const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
let lastNowDay = -2;

function showNow() {
  const beat = position();
  $('time').textContent = `${fmtClock(beat * secPerBeat())} / ${fmtClock(score.beats * secPerBeat())}`;
  const day = Math.min(search.days - 1, Math.floor(beat));
  if (day === lastNowDay) return;
  lastNowDay = day;
  const start = search.start ? Date.parse(`${search.start}T00:00:00Z`) : NaN;
  const when = Number.isFinite(start) ? `${fmtDate.format(new Date(start + day * 86400000))} · ` : '';
  // The caption is the latest milestone, for as long as it is recent.
  let caption = '';
  for (const [d, label] of search.milestones) if (d <= day && day - d < 12) caption = label;
  const now = $('now');
  now.textContent = '';
  const b = document.createElement('b');
  b.textContent = `${when}Day ${day + 1} of ${search.days}`;
  now.append(b, caption ? `  ${caption}` : '');
}

function showSearch() {
  $('title').textContent = search.title || 'A job search';
  const rows = perDay(search);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const stats = [
    [search.days, 'Days'], [sum(search.captured), 'Postings captured'], [sum(rows[0]), 'Jobs pursued'],
    [sum(rows[1]), 'Applications sent'], [sum(rows[2]), 'Interviews'], [sum(rows[3]), 'Offers'],
  ];
  const host = $('stats');
  host.textContent = '';
  for (const [n, label] of stats) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = n.toLocaleString();
    li.append(b, label);
    host.append(li);
  }
  $('srcNote').textContent = isDemo ? 'An invented search. Drop your own file anywhere on this page' : 'Loaded locally, nothing uploaded';
  lastNowDay = -2;
}

// ------------------------------------------------------------ in and out

function useSearch(next, demo) {
  if (playing) stop();
  search = next;
  isDemo = demo;
  pausedBeat = 0;
  score = sonify(search, { tail: tailBeats() });
  rollImage = null;
  labelStrips();
  showTempo();
  showSearch();
}

async function loadSearchFile(file) {
  try {
    useSearch(normalizeSearch(JSON.parse(await file.text())), false);
    toast('Search loaded');
  } catch (err) {
    toast(`Could not read that file (${err && err.message ? err.message : 'error'})`);
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Not at once: Safari cancels the download if the URL goes too soon.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const fileBase = () => {
  const slug = (search.title || 'job-search').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job-search';
  return `${slug}-sonification-${bpm()}bpm`;
};

function exportMidi() {
  download(makeMidi(score, { bpm: bpm(), title: search.title, milestones: search.milestones }), `${fileBase()}.mid`);
  toast('MIDI saved · one track per layer');
}

async function exportDaw() {
  try {
    const blob = await makeDawProject(score, {
      bpm: bpm(), title: search.title, milestones: search.milestones, mix,
      build: window.buildVersion?.() ?? 'unknown',
    });
    download(blob, `${fileBase()}.dawproject`);
    toast('Project saved · opens in Bitwig');
  } catch (err) {
    toast(`Project failed: ${err && err.message ? err.message : 'unknown error'}`);
  }
}

async function exportWav() {
  const btn = $('wavBtn');
  btn.disabled = true;
  btn.textContent = 'Rendering';
  try {
    const buffer = await renderScore(score, { bpm: bpm(), levels: heardLevels(), master: mix.master });
    const { blob, turnedDown } = encodeWav(buffer);
    download(blob, `${fileBase()}.wav`);
    toast(`WAV saved · ${fmtClock(buffer.duration)}${turnedDown ? ' · turned down to avoid clipping' : ''}`);
  } catch (err) {
    toast(`Render failed: ${err && err.message ? err.message : 'unknown error'}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'WAV';
  }
}

// ---------------------------------------------------------------- wiring

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'application/json,.json';
fileInput.id = 'searchFile';
fileInput.style.display = 'none';
document.body.append(fileInput);
fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) loadSearchFile(f);
});

function wireUp() {
  const blurAfterMouse = (e) => { if (e.detail > 0) e.currentTarget.blur(); };
  $('pickBtn').addEventListener('click', (e) => { blurAfterMouse(e); fileInput.click(); });
  $('demoBtn').addEventListener('click', (e) => { blurAfterMouse(e); useSearch(normalizeSearch(demoSearch()), true); });
  $('midiBtn').addEventListener('click', (e) => { blurAfterMouse(e); exportMidi(); });
  $('dawBtn').addEventListener('click', (e) => { blurAfterMouse(e); exportDaw(); });
  $('wavBtn').addEventListener('click', (e) => { blurAfterMouse(e); exportWav(); });
  $('resetMix').addEventListener('click', (e) => {
    blurAfterMouse(e);
    mix.master = MASTER_DEFAULT;
    for (const t of TRACKS) { mix.level[t.id] = t.level; mix.mute[t.id] = false; mix.solo[t.id] = false; }
    buildMixer();
    pushMix();
  });

  // pointerup, not pointerdown: iOS only grants audio on a completed gesture.
  $('play').addEventListener('pointerup', (e) => { e.currentTarget.blur(); togglePlay(); });
  $('play').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePlay(); }
  });

  const segPick = (host, attr, apply) => {
    host.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', (e) => {
        blurAfterMouse(e);
        host.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
        apply(Number(b.dataset[attr]));
      });
    });
  };
  // A new speed keeps the same seconds after the last day, which is a
  // different number of beats, so the ending is written again.
  segPick($('speedSeg'), 'speed', (v) => { speed = v; rescore(); });
  // Length is the whole piece. Whatever is past the last day is the tail.
  $('lengthIn').addEventListener('change', (e) => {
    const want = Number(e.target.value);
    if (Number.isFinite(want)) tailSec = Math.max(0, Math.min(120, want - search.days / speed));
    e.target.blur();
    rescore();
  });

  const roll = $('roll');
  const jump = (e) => {
    const r = roll.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * score.beats);
  };
  let dragging = false;
  roll.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { roll.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    jump(e);
  });
  roll.addEventListener('pointermove', (e) => { if (dragging && !playing) jump(e); });
  roll.addEventListener('pointerup', () => { dragging = false; });
  roll.addEventListener('pointercancel', () => { dragging = false; });

  let dragDepth = 0;
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('drop').classList.add('hot'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('hot'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').classList.remove('hot');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadSearchFile(f);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, button, a, [contenteditable]')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
  window.addEventListener('resize', () => { rollImage = null; });
}

function tick() {
  drawRoll();
  showNow();
  requestAnimationFrame(tick);
}

restoreMix();
buildMixer();
pushMix();
wireUp();
showSearch();
showTempo();
requestAnimationFrame(tick);
