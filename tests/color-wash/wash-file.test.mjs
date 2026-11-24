// Color Wash save files: does every file this app has ever written still load?
//
// fixtures/format-N.json is a file frozen at the time format N was current,
// and format-N.expected.json is what loading it must give. They are never
// edited. When the format changes, a new pair is added and the old pairs keep
// proving the old files still open.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  APP, FORMAT, BUILT_IN, DEFAULTS, MAX_COLORS, MAX_PROFILES,
  tidy, tidyProfiles, makeFile, readFile, mergeProfiles,
} from '../../public/apps/color-wash/wash-file.js';

const dir = new URL('./fixtures/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const frozen = readdirSync(dir).filter((f) => /^format-\d+\.json$/.test(f)).sort();

test('there is a frozen file for every format up to the current one', () => {
  const have = frozen.map((f) => Number(f.match(/\d+/)[0]));
  for (let f = 1; f <= FORMAT; f++) assert.ok(have.includes(f), `tests/color-wash/fixtures/format-${f}.json is missing`);
});

for (const name of frozen) {
  test(`${name} loads to exactly what it held`, () => {
    assert.deepEqual(readFile(json(name)), json(name.replace('.json', '.expected.json')));
  });
}

test('a file written now reads back the same', () => {
  const settings = { colors: ['#112233', '#445566', '#778899'], direction: 45, speed: 2.5, fade: 60 };
  const profiles = [{ name: 'One', ...settings }, { name: 'Two', ...DEFAULTS, name: 'Two' }];
  const doc = makeFile({ settings, profile: 'One', profiles, build: '9.9.9', saved: new Date('2030-01-02T03:04:05Z') });
  assert.equal(doc.app, APP);
  assert.equal(doc.format, FORMAT);
  assert.equal(doc.build, '9.9.9');
  assert.equal(doc.saved, '2030-01-02T03:04:05.000Z');
  // Through text, the way a real file goes.
  const back = readFile(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(back.settings, settings);
  assert.equal(back.profile, 'One');
  assert.deepEqual(back.profiles.map((p) => p.name), ['One', 'Two']);
  assert.deepEqual(back.profiles[0], { name: 'One', ...settings });
  assert.equal(back.newer, false);
});

test('a file with only the app name loads as the defaults', () => {
  const back = readFile({ app: 'color-wash' });
  assert.deepEqual(back.settings, tidy(DEFAULTS));
  assert.deepEqual(back.profiles, []);
  assert.equal(back.format, 1);
  assert.equal(back.build, 'unknown');
});

test('a file from a newer version still gives what this version understands', () => {
  const doc = { ...json('format-1.json'), format: FORMAT + 1, glow: { radius: 3 } };
  doc.settings = { ...doc.settings, shimmer: 0.4 };
  const back = readFile(doc);
  assert.equal(back.newer, true);
  assert.deepEqual(back.settings, json('format-1.expected.json').settings);
  assert.equal(back.profiles.length, 2);
});

test('files that are not Color Wash files are refused', () => {
  for (const bad of [null, 7, 'x', [], {}, { app: 'gain-stage', settings: {} }]) assert.throws(() => readFile(bad));
});

test('bad values fall back or are clamped, never passed through', () => {
  const s = tidy({ colors: ['#FFF', 'red', '#ABCDEF', 42, '#123456'], direction: 9999, speed: -3, fade: 'lots' });
  assert.deepEqual(s, { colors: ['#abcdef', '#123456'], direction: 360, speed: 0, fade: DEFAULTS.fade });
  assert.deepEqual(tidy({ colors: ['#000000'] }).colors, DEFAULTS.colors);
  assert.equal(tidy({ colors: Array(20).fill('#010101') }).colors.length, MAX_COLORS);
  assert.deepEqual(tidy({ direction: null, speed: '', fade: true }), tidy(DEFAULTS));
  assert.equal(tidy({ speed: '2.5' }).speed, 2.5);
});

test('saved profiles are named, unique, capped, and never take a built-in name', () => {
  const list = tidyProfiles([
    { name: '  My   Wash ', direction: 10 },
    { name: 'my wash', direction: 20 },
    { name: BUILT_IN[0].name.toUpperCase() },
    { name: '' }, null, 'x',
    { name: 'N'.repeat(80) },
  ]);
  assert.deepEqual(list.map((p) => p.name), ['My Wash', 'N'.repeat(40)]);
  assert.equal(list[0].direction, 10);
  assert.equal(tidyProfiles(Array.from({ length: 200 }, (_, i) => ({ name: `p${i}` }))).length, MAX_PROFILES);
  assert.deepEqual(tidyProfiles('nope'), []);
});

test('loading merges profiles: the same name is replaced, others are kept', () => {
  const a = tidyProfiles([{ name: 'Keep', speed: 1 }, { name: 'Both', speed: 1 }]);
  const b = tidyProfiles([{ name: 'both', speed: 3 }, { name: 'New', speed: 2 }]);
  const out = mergeProfiles(a, b);
  assert.deepEqual(out.map((p) => [p.name, p.speed]), [['Keep', 1], ['both', 3], ['New', 2]]);
  const full = tidyProfiles(Array.from({ length: MAX_PROFILES }, (_, i) => ({ name: `p${i}` })));
  assert.equal(mergeProfiles(full, b).length, MAX_PROFILES);
});

test('the built-in profiles are themselves valid settings', () => {
  for (const p of BUILT_IN) {
    const { name, ...rest } = p;
    assert.deepEqual(tidy(p), rest, name);
  }
});
