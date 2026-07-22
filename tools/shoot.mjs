#!/usr/bin/env node
// Headless screenshot + FPS harness for the gallery sub-apps.
//
// Drives a real GPU-backed Chrome for Testing (the one Playwright caches) against
// the running Vite dev server, so it verifies that shaders actually compile and
// captures what a browser really draws — not a mock. Two jobs:
//   • screenshots (verify a visual change, generate OG images)
//   • a rough frame-time read (--fps), to sanity-check a perf-sensitive change
//
// It talks to the app only through the DOM and real input events (it never
// reaches into module scope): it loads a chair-pile scene through the file
// input, and orbits by dragging the canvas — the same surface a user touches.
//
// Requires the dev server (npm run dev) and playwright-core (a devDependency).
// The Chrome binary is found automatically from the Playwright cache, or set
// CHROME_PATH to override.
//
// Examples:
//   node tools/shoot.mjs --app chair-pile --out /tmp/shot.png
//   node tools/shoot.mjs --app chair-pile --scene ~/Downloads/pile.json --orbit down --fps
//   node tools/shoot.mjs --url http://localhost:5173/creative-coding-portfolio/apps/ch4td1c3/index.html --out /tmp/dice.png

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

// --- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const BASE = opt('base', 'http://localhost:5173/creative-coding-portfolio');
const app = opt('app');
const url = opt('url', app ? `${BASE}/apps/${app}/index.html` : BASE + '/');
const scene = opt('scene');
const orbit = opt('orbit'); // 'down' tilts toward the horizon; omit to keep the saved camera
const out = opt('out', 'shot.png');
const width = Number(opt('width', 1400));
const height = Number(opt('height', 900));
const wantFps = flag('fps');
const fpsSeconds = Number(opt('seconds', 4));
// --mobile emulates a touch phone, so `(pointer: fine)` is false and the app
// takes its phone code path (smaller shadow map, lighter shadow tier).
const mobile = flag('mobile');

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
    // Prefer full Chromium over the headless shell (the shell has no real GPU).
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
const browser = await chromium.launch({
  executablePath: findChrome(),
  args: [
    '--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl',
    // Uncap rAF so --fps reads real render throughput, not the 60Hz vsync cap.
    // With the pile at rest (demo off) physics is nearly free, so the frame cost
    // this exposes is dominated by rendering — which is what a shadow change moves.
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
  ],
});
const context = mobile
  ? await browser.newContext({ ...devices['iPhone 13'] })
  : await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERR', m.text()); });
page.on('pageerror', (e) => console.log('PAGE EXC', e.message));

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => !!document.querySelector('canvas'));
await page.waitForTimeout(600);

// chair-pile: turn demo off, load a scene, close the settings card.
if (app === 'chair-pile') {
  await page.evaluate(() => {
    const t = document.getElementById('demo-toggle');
    if (t && t.checked) { t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  if (scene) {
    await page.setInputFiles('#scene-file', scene);
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => document.getElementById('menu-done')?.click() ?? document.getElementById('menu-btn')?.click());
  await page.waitForTimeout(1000);
}

// Orbit by dragging the canvas. 'down' drags downward, which tilts the camera
// toward the horizon (bounded by the app's own maxPolarAngle).
if (orbit === 'down') {
  const cx = Math.round(width / 2), cy = Math.round(height / 2);
  for (let pass = 0; pass < 3; pass++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(cx, cy + i * 12, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 16; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(30); }
  await page.waitForTimeout(1500);
}

if (wantFps) {
  // Average frame interval from rAF over a window. Absolute numbers are only
  // meaningful relative to another run on the same machine — use it for A/B.
  const fps = await page.evaluate((secs) => new Promise((resolve) => {
    const t = [];
    let last = performance.now();
    const end = last + secs * 1000;
    function tick(now) {
      t.push(now - last); last = now;
      if (now < end) requestAnimationFrame(tick);
      else {
        t.sort((a, b) => a - b);
        const median = t[Math.floor(t.length / 2)];
        const mean = t.reduce((s, x) => s + x, 0) / t.length;
        resolve({ frames: t.length, medianMs: +median.toFixed(2), meanMs: +mean.toFixed(2), fps: +(1000 / mean).toFixed(1) });
      }
    }
    requestAnimationFrame((now) => { last = now; requestAnimationFrame(tick); });
  }), fpsSeconds);
  console.log('FPS', JSON.stringify(fps));
}

await page.screenshot({ path: out });
console.log('wrote', out);
await browser.close();
