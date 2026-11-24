// Color Wash — a slow wash of color across the whole screen.
//
// The wash is lifted from the header glow of a job search film, where it was
// drawn on a 2D canvas one pixel row at a time. Here the same arithmetic runs
// in a fragment shader:
//
//   1. at(phase) blends between neighboring palette colors with a smoothstep,
//      so phase 0 is the first color, 1 the second, and it wraps at the end.
//   2. Across the screen there are three stops, at phase, phase + 0.5 and
//      phase + 1, joined by straight blends. The screen always shows about
//      one color change from edge to edge.
//   3. Phase climbs with the clock, so the colors travel.
//   4. Fade lets the wash die away to one side over a dark ground, the way
//      the original glow fell off below the header: alpha is v squared, with
//      v running from 1 at the edge to 0 where the wash ends.
//
// Direction is where the colors travel to, as a compass bearing: 0 is up and
// 90 is right. The fade falls off to the right of that heading, so the
// original (traveling left, fading downward) is 270.

import {
  BUILT_IN, DEFAULTS, MAX_COLORS, MIN_COLORS, MAX_PROFILES,
  tidy, tidyProfiles, cleanName, same, isBuiltIn, makeFile, readFile, mergeProfiles,
} from './wash-file.js';

// A profile is a named set of settings. The built-in ones cannot be changed;
// saved ones are kept in this browser. A new tab opens on a profile picked at
// random, and after that the tab remembers what it was showing, so a reload
// does not deal again.
const PROFILES_KEY = 'color-wash:profiles:v1';
const SESSION_KEY = 'color-wash:session:v1';
// At speed 1 the wash moves one color along every four seconds, the rate of
// the film it came from.
const STEPS_PER_SECOND = 0.25;
const GROUND = [0x0b / 255, 0x0d / 255, 0x12 / 255];

const canvas = document.getElementById('field');
const colorsEl = document.getElementById('colors');
const directionEl = document.getElementById('direction');
const speedEl = document.getElementById('speed');
const fadeEl = document.getElementById('fade');

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

let saved = [];
try { saved = tidyProfiles(JSON.parse(localStorage.getItem(PROFILES_KEY))); } catch { /* private window, or not JSON */ }
const keepProfiles = () => { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(saved)); } catch { /* private window */ } };

const allProfiles = () => [...BUILT_IN, ...saved];
const findProfile = (name) => allProfiles().find((p) => same(p.name, name));

let settings;
let profileName;
try {
  const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
  if (s && findProfile(cleanName(s.profile))) { profileName = findProfile(cleanName(s.profile)).name; settings = tidy(s.settings); }
} catch { /* fall through to a deal */ }
if (!settings) {
  const all = allProfiles();
  const pick = all[Math.floor(Math.random() * all.length)];
  profileName = pick.name;
  settings = tidy(pick);
}
const remember = () => {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ profile: profileName, settings })); } catch { /* private window */ }
  showProfile();
};

// ---------------------------------------------------------------------- WebGL
const VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// WebGL 1 cannot index a uniform array with a variable, so pal() walks the
// array with a constant bound and keeps the one it wants.
const FRAG = `
precision highp float;
uniform vec2 size;
uniform vec3 colors[${MAX_COLORS}];
uniform float count;
uniform float phase;
uniform vec2 heading;
uniform float fade;
uniform vec3 ground;

vec3 pal(float i) {
  vec3 c = colors[0];
  for (int k = 1; k < ${MAX_COLORS}; k++) if (float(k) == i) c = colors[k];
  return c;
}
vec3 at(float ph) {
  float i = floor(ph), f = ph - i, e = f * f * (3.0 - 2.0 * f);
  return mix(pal(mod(i, count)), pal(mod(i + 1.0, count)), e);
}
float hash(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  // Pixels from the center, y down, so a bearing means what it says on any
  // shape of screen.
  vec2 q = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) - 0.5 * size;
  float along = abs(heading.x) * size.x + abs(heading.y) * size.y;
  float u = clamp(0.5 - dot(q, heading) / along, 0.0, 1.0);
  vec3 wash = u < 0.5
    ? mix(at(phase), at(phase + 0.5), u * 2.0)
    : mix(at(phase + 0.5), at(phase + 1.0), u * 2.0 - 1.0);

  vec2 side = vec2(heading.y, -heading.x);
  float across = abs(side.x) * size.x + abs(side.y) * size.y;
  float s = 0.5 + dot(q, side) / across;
  float v = fade > 0.0 ? clamp(1.0 - s * fade / 0.154, 0.0, 1.0) : 1.0;
  float alpha = mix(1.0, 0.62, fade) * v * v;

  vec3 c = mix(ground, wash, alpha);
  // Half a step of noise, so a slow gradient on an 8-bit screen does not band.
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
let uni = null;

function setUp() {
  const shader = (type, source) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  uni = {};
  for (const name of ['size', 'colors', 'count', 'phase', 'heading', 'fade', 'ground']) {
    uni[name] = gl.getUniformLocation(program, name);
  }
  gl.uniform3fv(uni.ground, GROUND);
}

function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// Phase is kept as a running total and not worked out from the clock, so a
// change of speed carries on from where the wash is and does not jump.
let phase = 0;
let last = 0;

function draw() {
  fit();
  gl.viewport(0, 0, canvas.width, canvas.height);
  const flat = new Float32Array(MAX_COLORS * 3);
  settings.colors.forEach((c, i) => flat.set(rgb(c), i * 3));
  const a = (settings.direction * Math.PI) / 180;
  gl.uniform2f(uni.size, canvas.width, canvas.height);
  gl.uniform3fv(uni.colors, flat);
  gl.uniform1f(uni.count, settings.colors.length);
  gl.uniform1f(uni.phase, phase);
  gl.uniform2f(uni.heading, Math.sin(a), -Math.cos(a));
  gl.uniform1f(uni.fade, settings.fade / 100);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function frame(now) {
  // A tab that was in the background comes back with a long gap; do not
  // spend it all at once.
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  phase = (phase + dt * settings.speed * STEPS_PER_SECOND) % settings.colors.length;
  draw();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------- controls
function label() {
  document.getElementById('direction-out').textContent = `${Math.round(settings.direction) % 360}°`;
  document.getElementById('speed-out').textContent = settings.speed === 0 ? 'Still' : `${settings.speed.toFixed(2)}×`;
  document.getElementById('fade-out').textContent = settings.fade === 0 ? 'Off' : `${Math.round(settings.fade)}%`;
}

function buildColors() {
  colorsEl.textContent = '';
  settings.colors.forEach((c, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'swatch';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = c;
    input.setAttribute('aria-label', `Color ${i + 1}`);
    input.addEventListener('input', () => { settings.colors[i] = input.value.toLowerCase(); remember(); });
    wrap.append(input);
    if (settings.colors.length > MIN_COLORS) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'remove';
      x.textContent = '✕';
      x.setAttribute('aria-label', `Remove color ${i + 1}`);
      x.addEventListener('click', () => {
        settings.colors.splice(i, 1);
        phase %= settings.colors.length;
        remember();
        buildColors();
      });
      wrap.append(x);
    }
    colorsEl.append(wrap);
  });
  if (settings.colors.length < MAX_COLORS) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Add a color');
    add.addEventListener('click', () => {
      settings.colors.push('#ffffff');
      remember();
      buildColors();
    });
    colorsEl.append(add);
  }
}

// ------------------------------------------------------------------- profiles
const profileEl = document.getElementById('profile');
const nameForm = document.getElementById('name-form');
const nameEl = document.getElementById('name');
const nameNote = document.getElementById('name-note');
const deleteBtn = document.getElementById('delete-btn');

const edited = () => JSON.stringify(settings) !== JSON.stringify(tidy(findProfile(profileName)));

function showProfile() {
  document.getElementById('profile-out').textContent = edited() ? 'Edited' : '';
  deleteBtn.hidden = isBuiltIn(profileName);
}

function buildProfiles() {
  profileEl.textContent = '';
  const group = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const p of list) g.append(new Option(p.name, p.name));
    profileEl.append(g);
  };
  group('Built in', BUILT_IN);
  group('Saved', saved);
  profileEl.value = profileName;
}

function useProfile(name) {
  const p = findProfile(name) || DEFAULTS;
  profileName = p.name;
  settings = tidy(p);
  settings.colors = [...settings.colors];
  phase %= settings.colors.length;
  buildProfiles();
  showSettings();
  remember();
}

function closeNaming() {
  nameForm.hidden = true;
  nameNote.hidden = true;
  nameEl.setAttribute('aria-invalid', 'false');
}

profileEl.addEventListener('change', () => { closeNaming(); useProfile(profileEl.value); });

document.getElementById('save-btn').addEventListener('click', () => {
  nameEl.value = isBuiltIn(profileName) ? '' : profileName;
  nameForm.hidden = false;
  nameNote.hidden = true;
  nameEl.focus();
  nameEl.select();
});
document.getElementById('name-cancel').addEventListener('click', closeNaming);
nameEl.addEventListener('input', () => { nameEl.setAttribute('aria-invalid', 'false'); nameNote.hidden = true; });

nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = cleanName(nameEl.value);
  const existing = saved.find((p) => same(p.name, name));
  let problem = '';
  if (!name) problem = 'Give it a name.';
  else if (isBuiltIn(name)) problem = 'That name is built in. Pick another.';
  else if (!existing && saved.length >= MAX_PROFILES) problem = 'Delete a saved profile first.';
  if (problem) {
    nameEl.setAttribute('aria-invalid', 'true');
    nameNote.textContent = problem;
    nameNote.hidden = false;
    return;
  }
  const copy = { name: existing ? existing.name : name, ...tidy(settings) };
  if (existing) saved[saved.indexOf(existing)] = copy; else saved.push(copy);
  keepProfiles();
  profileName = copy.name;
  closeNaming();
  buildProfiles();
  remember();
});

deleteBtn.addEventListener('click', () => {
  if (isBuiltIn(profileName)) return;
  saved = saved.filter((p) => !same(p.name, profileName));
  keepProfiles();
  // The picture stays as it is; it now counts as an edit of the first profile.
  profileName = DEFAULTS.name;
  closeNaming();
  buildProfiles();
  remember();
});

function showSettings() {
  directionEl.value = settings.direction;
  speedEl.value = settings.speed;
  fadeEl.value = settings.fade;
  buildColors();
  label();
}

for (const [el, key] of [[directionEl, 'direction'], [speedEl, 'speed'], [fadeEl, 'fade']]) {
  el.addEventListener('input', () => { settings[key] = Number(el.value); label(); remember(); });
}
document.getElementById('reset-btn').addEventListener('click', () => {
  // Back to the profile as it was saved.
  closeNaming();
  useProfile(profileName);
});

// ---------------------------------------------------------------- save, load
const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

document.getElementById('saveState').addEventListener('click', () => {
  const doc = makeFile({ settings, profile: profileName, profiles: saved, build: window.buildVersion?.() ?? 'unknown' });
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `color-wash-${doc.saved.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Settings saved');
});

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'application/json,.json';
fileInput.hidden = true;
document.body.append(fileInput);
document.getElementById('loadState').addEventListener('click', () => fileInput.click());

function loadText(text) {
  let file;
  try { file = readFile(JSON.parse(text)); } catch { toast('Not a Color Wash file'); return; }
  saved = mergeProfiles(saved, file.profiles);
  keepProfiles();
  profileName = (findProfile(file.profile) || DEFAULTS).name;
  settings = file.settings;
  settings.colors = [...settings.colors];
  phase %= settings.colors.length;
  closeNaming();
  buildProfiles();
  showSettings();
  remember();
  toast(file.newer ? 'Loaded · made by a newer version' : 'Settings loaded');
}
fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  fileInput.value = '';
  if (f) loadText(await f.text());
});

// ------------------------------------------------------------- settings sheet
const menuBtn = document.getElementById('menu-btn');
const scrim = document.getElementById('scrim');

function openMenu() {
  scrim.hidden = false;
  document.body.classList.add('menu-open');
  menuBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  scrim.hidden = true;
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', openMenu);
document.getElementById('close-btn').addEventListener('click', closeMenu);
document.getElementById('done-btn').addEventListener('click', closeMenu);
scrim.addEventListener('click', (e) => { if (e.target === scrim) closeMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ----------------------------------------------------------------------- start
settings.colors = [...settings.colors];
buildProfiles();
showSettings();
remember();
// For a test harness: read the state, or hold the wash at a phase.
window.colorWash = { get settings() { return settings; }, get profile() { return profileName; }, get phase() { return phase; }, set phase(v) { phase = v; } };

if (gl) {
  try {
    setUp();
    requestAnimationFrame((now) => { last = now; frame(now); });
  } catch (err) {
    console.error(err);
    document.getElementById('nogl').hidden = false;
    openMenu();
  }
} else {
  document.getElementById('nogl').hidden = false;
  openMenu();
}
