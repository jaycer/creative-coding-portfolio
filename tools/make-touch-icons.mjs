#!/usr/bin/env node
// Rasterize every sub-app's favicon.svg into the home-screen icon iOS wants.
//
// Safari's "Add to Home Screen" reads <link rel="apple-touch-icon"> and nothing
// else — it ignores rel="icon", and it ignores SVG. With no PNG to find it puts
// a letter tile on the home screen instead. So each app gets a 180x180 PNG
// beside its favicon, and index.html points at it.
//
// The SVG stays the single definition of the mark; this is a derived file, and
// re-running the script after editing a favicon is what keeps the two in step.
//
// iOS renders any transparency as flat black, so every icon has to come out
// opaque. The favicons fall into two kinds, told apart by measuring rather than
// by a list — how much of a ring just inside the edge is opaque:
//
//   • ring is solid (21 of them): the favicon is a full-bleed rounded rect, and
//     only its corners are clear. Flooding the frame with the color sampled at
//     the edge fills exactly the slivers iOS's squircle would otherwise blacken,
//     and nothing else. No margin — the artwork already runs to the edge.
//   • ring is broken (brick-layer): the mark floats on nothing. Sampling the
//     edge there picks a color out of the artwork and paints the mark onto
//     itself, so this kind takes the app's own theme-color as a backdrop and is
//     inset, the way an app icon puts a logo on a tile.
//
// Requires playwright-core (a devDependency). The Chrome binary is found in the
// Playwright cache automatically, or set CHROME_PATH to override.
//
//   node tools/make-touch-icons.mjs            # every app, plus the gallery
//   node tools/make-touch-icons.mjs meme-generator sleep-noise
//   node tools/make-touch-icons.mjs --check    # fail if any icon is out of date

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 180; // what Apple asks for; iOS downsamples to whatever it needs

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const wanted = argv.filter((a) => !a.startsWith('--'));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('no Chrome found — set CHROME_PATH, or run: npx playwright install chromium');
}

// Every app folder that has a favicon, plus the gallery's own at the site root.
// A backdrop for the floating-mark icons whose app declares no theme-color, or
// whose theme-color is the wrong answer. Only consulted for those — a full-bleed
// favicon brings its own and is never overridden.
const BACKDROP = {
  pantry: '#f7f8fa', // the directory is light-first; a carrot on black reads as a different app
};

/** The app's own <meta name="theme-color">, which is the backdrop it was drawn against. */
function themeColor(html) {
  if (!existsSync(html)) return null;
  const m = readFileSync(html, 'utf8').match(/name="theme-color"\s+content="([^"]+)"/);
  return m ? m[1] : null;
}

// The static apps under /public, plus the bundled ones under /apps.
const targets = [];
for (const dir of ['public/apps', 'apps']) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  for (const slug of readdirSync(base).sort()) {
    const svg = join(base, slug, 'favicon.svg');
    if (!existsSync(svg)) continue;
    targets.push({
      name: slug,
      svg,
      png: join(base, slug, 'apple-touch-icon.png'),
      theme: BACKDROP[slug] || themeColor(join(base, slug, 'index.html')),
    });
  }
}
const rootSvg = join(ROOT, 'public/favicon.svg');
if (existsSync(rootSvg)) {
  targets.push({
    name: '(gallery)',
    svg: rootSvg,
    png: join(ROOT, 'public/apple-touch-icon.png'),
    theme: themeColor(join(ROOT, 'index.html')),
  });
}

const todo = wanted.length ? targets.filter((t) => wanted.includes(t.name)) : targets;
if (!todo.length) {
  console.error(`no match for ${wanted.join(', ')}`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });

let stale = 0;
for (const t of todo) {
  const svgText = readFileSync(t.svg, 'utf8');
  const png = await page.evaluate(async ({ svgText, SIZE, theme }) => {
    const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
    const img = new Image();
    img.width = SIZE;
    img.height = SIZE;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('the SVG would not decode'));
      img.src = src;
    });

    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, SIZE, SIZE);
    const px = g.getImageData(0, 0, SIZE, SIZE).data;
    const alpha = (x, y) => px[(y * SIZE + x) * 4 + 3];

    // How much of a ring two pixels inside the edge is opaque, ignoring the
    // corners — 1 means a backdrop that runs to the edge, well short of 1 means
    // a mark floating on nothing.
    const inset = Math.round(SIZE * 0.18);
    let ring = 0, solid = 0;
    for (let x = inset; x < SIZE - inset; x++) for (const y of [2, SIZE - 3]) { ring++; if (alpha(x, y) > 250) solid++; }
    for (let y = inset; y < SIZE - inset; y++) for (const x of [2, SIZE - 3]) { ring++; if (alpha(x, y) > 250) solid++; }
    const fullBleed = solid / ring > 0.99;

    let back, mode;
    if (fullBleed) {
      // Read the rim color off the icon rather than guessing it, so a gradient
      // backdrop keeps its own tone at the edge.
      const mid = Math.floor(SIZE / 2);
      const p = g.getImageData(mid, 1, 1, 1).data;
      back = `rgb(${p[0]},${p[1]},${p[2]})`;
      mode = 'full-bleed';
    } else {
      back = theme || '#0a0a0c';
      mode = 'inset on theme-color';
    }

    g.clearRect(0, 0, SIZE, SIZE);
    g.fillStyle = back;
    g.fillRect(0, 0, SIZE, SIZE);
    if (fullBleed) {
      g.drawImage(img, 0, 0, SIZE, SIZE);
    } else {
      // Sized to survive iOS's mask with room to spare, and kept to the SVG's
      // own aspect so a mark that is not square is not stretched into one.
      const box = Math.round(SIZE * 0.72);
      const vb = (svgText.match(/viewBox="([\d.\s-]+)"/) || [])[1];
      const [, , vw = 1, vh = 1] = vb ? vb.trim().split(/\s+/).map(Number) : [];
      const scale = Math.min(box / vw, box / vh);
      const w = vw * scale, h = vh * scale;
      g.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
    }

    // Re-read rather than reusing the snapshot above, which predates the flood
    // and would report the transparency this whole function exists to remove.
    const done = g.getImageData(0, 0, SIZE, SIZE).data;
    let clear = 0;
    for (let i = 3; i < done.length; i += 4) if (done[i] < 255) clear++;

    return { data: c.toDataURL('image/png').split(',')[1], back, mode, clear };
  }, { svgText, SIZE, theme: t.theme });

  const bytes = Buffer.from(png.data, 'base64');
  const same = existsSync(t.png) && Buffer.compare(readFileSync(t.png), bytes) === 0;
  if (check) {
    if (!same) { stale++; console.log(`STALE  ${t.name}`); }
    continue;
  }
  if (!same) writeFileSync(t.png, bytes);
  console.log(
    `${same ? 'same' : 'wrote'}  ${t.name.padEnd(24)} ${String(bytes.length).padStart(6)} B  ` +
    `${png.mode.padEnd(20)} on ${String(png.back).padEnd(18)} ` +
    `${png.clear === 0 ? 'fully opaque' : `** ${png.clear} SEE-THROUGH PIXELS **`}`
  );
}

await browser.close();

if (check && stale) {
  console.error(`\n${stale} icon${stale === 1 ? '' : 's'} out of date — run: node tools/make-touch-icons.mjs`);
  process.exit(1);
}
if (check) console.log('\nevery icon matches its favicon');
