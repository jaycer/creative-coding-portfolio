// wash-file.js — what a Color Wash setting is, and the file it is saved in.
//
// Everything in here is plain data in, plain data out, with no page and no
// WebGL, so the same code runs in the app and in the tests under
// tests/color-wash. Those tests keep a frozen file from every format this app
// has ever written and check each one still loads.
//
// A saved file:
//
//   { app: 'color-wash', format: 1, build: 'v0.10.0-…', saved: '2026-…Z',
//     profile: 'Fried Mango',            the profile that was selected
//     settings: { colors, direction, speed, fade },   what was on screen
//     profiles: [{ name, colors, direction, speed, fade }] }   the saved ones
//
// `format` is what the loader goes by. `build` names the code that wrote the
// file, for the day a file has to be handed back to the version that made it.
//
// To change the format: raise FORMAT, add a step to MIGRATIONS that turns the
// old shape into the new one, and freeze a file of the new format in
// tests/color-wash/fixtures. Never edit an old fixture.

export const APP = 'color-wash';
export const FORMAT = 1;
export const MAX_COLORS = 6;
export const MIN_COLORS = 2;
export const MAX_PROFILES = 50;

export const BUILT_IN = [
  // The wash as the film had it, shown full screen.
  { name: 'Fried Mango', colors: ['#3987e5', '#d95926', '#199e70'], direction: 270, speed: 1, fade: 0 },
  { name: 'Dusk', colors: ['#1b1f4b', '#7b3fa0', '#e8638c', '#f4a261'], direction: 0, speed: 0.5, fade: 0 },
  { name: 'Sea Glass', colors: ['#0f6e7a', '#5fc9b8', '#d8ecd0', '#2a9fd6'], direction: 135, speed: 0.6, fade: 0 },
  { name: 'Neon Arcade', colors: ['#ff2bd6', '#12e6ff', '#ffe600'], direction: 45, speed: 2, fade: 0 },
  { name: 'Ember', colors: ['#ff3d00', '#ff9e00', '#7a0c0c'], direction: 90, speed: 0.75, fade: 30 },
  { name: 'Northern Lights', colors: ['#19e68c', '#12b5c9', '#7a4bff'], direction: 270, speed: 0.4, fade: 22 },
  { name: 'Sherbet', colors: ['#ffb3c7', '#ffd9a0', '#c8f0d0', '#b9d4ff'], direction: 225, speed: 0.8, fade: 0 },
];
export const DEFAULTS = BUILT_IN[0];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

export const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
export const same = (a, b) => a.toLowerCase() === b.toLowerCase();
export const isBuiltIn = (name) => BUILT_IN.some((p) => same(p.name, name));

/** Settings from anything: missing or bad values fall back to the defaults. */
export function tidy(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let colors = Array.isArray(s.colors) ? s.colors.filter(isHex).slice(0, MAX_COLORS) : [];
  if (colors.length < MIN_COLORS) colors = DEFAULTS.colors;
  const n = (v, d, lo, hi) =>
    (v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : d);
  return {
    colors: colors.map((c) => c.toLowerCase()),
    direction: n(s.direction, DEFAULTS.direction, 0, 360),
    speed: n(s.speed, DEFAULTS.speed, 0, 4),
    fade: n(s.fade, DEFAULTS.fade, 0, 100),
  };
}

/** A list of saved profiles from anything: named, unique, never a built-in name. */
export function tidyProfiles(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const p of raw) {
    if (out.length >= MAX_PROFILES) break;
    const name = cleanName(p && p.name);
    if (name && !isBuiltIn(name) && !out.some((q) => same(q.name, name))) out.push({ name, ...tidy(p) });
  }
  return out;
}

/** The file Save writes. */
export function makeFile({ settings, profile, profiles, build = 'unknown', saved = new Date() }) {
  return {
    app: APP,
    format: FORMAT,
    build,
    saved: saved.toISOString(),
    profile,
    settings: tidy(settings),
    profiles: tidyProfiles(profiles),
  };
}

// One step per format: MIGRATIONS[n] takes a format n file and returns it in
// the shape of format n + 1. Empty while there has only been one format.
const MIGRATIONS = {};

/**
 * Read a saved file, of this format or any earlier one.
 * @returns {{ settings, profile: string, profiles: object[], format: number, build: string, newer: boolean }}
 *   newer: the file came from a later version of the app; what this version
 *   understands of it has been read.
 */
export function readFile(doc) {
  if (!doc || typeof doc !== 'object' || doc.app !== APP) throw new Error('not a Color Wash file');
  const format = Number.isInteger(doc.format) && doc.format > 0 ? doc.format : 1;
  let d = doc;
  for (let f = format; f < FORMAT; f++) {
    if (!MIGRATIONS[f]) throw new Error(`no way to read format ${f}`);
    d = MIGRATIONS[f](d);
  }
  return {
    settings: tidy(d.settings),
    profile: cleanName(d.profile),
    profiles: tidyProfiles(d.profiles),
    format,
    build: typeof doc.build === 'string' ? doc.build : 'unknown',
    newer: format > FORMAT,
  };
}

/** Bring loaded profiles into the saved list: same name replaces, new ones are added. */
export function mergeProfiles(saved, incoming) {
  const out = saved.map((p) => incoming.find((q) => same(q.name, p.name)) || p);
  for (const p of incoming) if (!out.some((q) => same(q.name, p.name)) && out.length < MAX_PROFILES) out.push(p);
  return out;
}
