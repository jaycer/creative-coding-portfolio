#!/usr/bin/env node
// Rewind a Particle System snapshot and replay it, watching every frame for a jump.
//
// The app's diagnostics (public/apps/particle-system/particleDiagnostics.v1.js) save
// a JSON file holding the whole field: every particle's position, size, wave phase
// and color run, plus the background walk. That is enough to put the sketch back
// exactly as it was, step it backwards, and let it play forward again through its
// own draw() — so a glitch you saw once can be looked at as many times as you like.
//
// Nothing here re-implements the sketch's color or size math. It hydrates the real
// Particle objects and calls the real redraw(), and it injects the diagnostics
// script so the same watcher that recorded the snapshot measures the replay.
//
// What can and cannot be recovered: a particle's wave is a pure function of
// frameCount, so amp and size come back on their own. Position walks back along its
// speed, and the color run walks back along its step counter. But a particle that
// crossed a color-run boundary, the top of its wave, or a wall inside the window
// drew fresh random values at that moment, and those are gone. Every run reports how
// many particles that applies to, so you know how far to trust it.
//
// The Chrome binary is found from the Playwright cache, or set CHROME_PATH.
//
// Examples:
//   node tools/rewind.mjs --snapshot ~/Downloads/particles-2026-08-30T23-09-53.json
//   node tools/rewind.mjs --snapshot ~/Downloads/particles.json --frames 240
//   node tools/rewind.mjs --snapshot ~/Downloads/particles.json --from singlePatchJumps --pick 0

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

// --- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const snapshotPath = opt('snapshot');
if (!snapshotPath) {
  console.error('Need --snapshot <file.json>. See the header of this file for examples.');
  process.exit(1);
}
// how many frames to step back before replaying; it plays forward twice that
const rewindFrames = Number(opt('frames', 120));
// which snapshot inside the file: "current", or one the watcher caught
const from = opt('from', 'current');
const pick = Number(opt('pick', 0));

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'apps', 'particle-system');
const url = opt('url', `file://${join(appDir, 'index.html')}`);
const diagnosticsPath = join(appDir, 'particleDiagnostics.v1.js');

const saved = JSON.parse(readFileSync(snapshotPath, 'utf8'));
// files from before the watcher existed are a bare snapshot
const snapshot = from === 'current' ? (saved.current ?? saved) : saved[from]?.[pick]?.snapshot;
if (!snapshot) {
  console.error(`No snapshot at --from ${from} --pick ${pick}. The file holds: ${Object.keys(saved).join(', ')}`);
  process.exit(1);
}

// --- find the cached Chrome for Testing ------------------------------------
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* playwright-core ships no browser; fall through to the cache scan */ }
  const cache = process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/ms-playwright')
    : join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) {
    const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      for (const rel of [
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
      ]) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chrome for Testing found. Set CHROME_PATH, or `npx playwright install chromium`.');
}

// --- run -------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: snapshot.width, height: snapshot.height } });
page.on('pageerror', (e) => console.error('  [page error]', e.message.slice(0, 300)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.frameCount === 'number' && window.frameCount > 5);
// the app ships with its diagnostics script commented out, so bring it in here
await page.addScriptTag({ path: diagnosticsPath });

const report = await page.evaluate(({ snapshot, rewindFrames }) => {
  noLoop();

  // --- put the field back the way it was --------------------------------
  particleAmount = snapshot.particleAmount;
  defaultMaxPeriod = snapshot.defaultMaxPeriod;
  isExiting = snapshot.isExiting;
  bgWalk = { ...snapshot.background.walk };
  targetBgWalk = { ...snapshot.background.target };

  const lost = { colorRunBoundary: 0, waveTop: 0, hitAWall: 0 };

  particles = snapshot.particles.map((saved) => {
    const particle = new Particle(saved.frameCountOffset);
    Object.assign(particle, {
      speed: saved.speed, speedY: saved.speedY, size: saved.size,
      minSize: saved.minSize, maxSize: saved.maxSize, amp: saved.amp,
      period: saved.period, frameCountOffset: saved.frameCountOffset,
      isGrowing: saved.isGrowing, isExiting: saved.isExiting, hasExited: saved.hasExited,
      colorChanges: saved.colorChanges, colorStepFrames: saved.colorStepFrames,
      colorStepFrame: saved.colorStepFrame,
      walk: { ...saved.walk }, colorFrom: { ...saved.colorFrom }, colorTo: { ...saved.colorTo },
    });
    particle.position = createVector(saved.x, saved.y);
    particle.color = getWalkColor(particle.walk);

    // --- and walk it back -----------------------------------------------
    particle.position.x -= particle.speed * rewindFrames;
    particle.position.y -= particle.speedY * rewindFrames;
    if (particle.position.x < 0 || particle.position.x > width
      || particle.position.y < 0 || particle.position.y > height) lost.hitAWall++;

    particle.colorStepFrame -= rewindFrames;
    if (particle.colorStepFrame < 0) {
      particle.colorStepFrame = 0;
      lost.colorRunBoundary++;
    }

    const ampThen = Math.cos(Math.PI * (snapshot.frameCount - rewindFrames - particle.frameCountOffset) / particle.period);
    if (ampThen > particle.amp && !particle.isGrowing) lost.waveTop++;

    return particle;
  });

  // the background takes one lerp a frame, so undo one per frame stepped back
  const amount = backgroundLerpAmount / backgroundLerpFrames;
  for (let step = 0; step < rewindFrames; step++) {
    for (const part of ['hue', 'sat', 'bright']) {
      bgWalk[part] = (bgWalk[part] - amount * targetBgWalk[part]) / (1 - amount);
    }
  }
  backgroundColor = getWalkColor(bgWalk);
  frameCount = snapshot.frameCount - rewindFrames;

  // --- play it forward through the sketch's own draw() -------------------
  flickerHistory.length = 0;
  wholeScreenJumps.length = 0;
  singlePatchJumps.length = 0;
  lastFlickerSample = null;
  flickerHistoryFrames = rewindFrames * 2 + 10;

  for (let step = 0; step < rewindFrames * 2; step++) redraw();

  const history = flickerHistory.map((h) => ({ f: h.frameCount, mean: h.meanJump, patch: h.patchJump }));
  const worstBy = (score) => [...history].sort((a, b) => score(b) - score(a)).slice(0, 5);
  return {
    replayed: { from: snapshot.frameCount - rewindFrames, to: frameCount, particles: particles.length },
    couldNotRebuild: lost,
    biggestWholeScreenJumps: worstBy((e) => Math.abs(e.mean)).map((e) => ({ frame: e.f, meanJump: +e.mean.toFixed(2), patchJump: +e.patch.toFixed(1) })),
    biggestSinglePatchJumps: worstBy((e) => e.patch).map((e) => ({ frame: e.f, meanJump: +e.mean.toFixed(2), patchJump: +e.patch.toFixed(1) })),
  };
}, { snapshot, rewindFrames });

const { replayed, couldNotRebuild, biggestWholeScreenJumps, biggestSinglePatchJumps } = report;
console.log(`replayed frames ${replayed.from} to ${replayed.to}, ${replayed.particles} particles`);
console.log(`could not rebuild exactly: ${couldNotRebuild.colorRunBoundary} crossed a color run, `
  + `${couldNotRebuild.waveTop} crossed a wave top, ${couldNotRebuild.hitAWall} hit a wall`);
console.log('\nbiggest whole-screen jumps (a flash reads about 150):');
for (const e of biggestWholeScreenJumps) console.log(`  frame ${e.frame}  mean ${e.meanJump}  patch ${e.patchJump}`);
console.log('\nbiggest single-patch jumps:');
for (const e of biggestSinglePatchJumps) console.log(`  frame ${e.frame}  patch ${e.patchJump}  mean ${e.meanJump}`);

await browser.close();
