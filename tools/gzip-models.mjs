#!/usr/bin/env node
// Gzip the .glb models in a folder to .glbz, and drop the originals.
//
// GitHub Pages compresses text and JavaScript but not binary, so a .glb ships at
// full size — and glTF is mostly float arrays, which gzip is very good at. The
// app therefore fetches the compressed file and inflates it itself with
// DecompressionStream before handing the buffer to GLTFLoader.parse(). Object
// Tile Scroll's models go from about 1.5MB on the wire to about 0.4MB for
// exactly the same 70 objects.
//
// The extension is `.glbz` and NOT `.glb.gz`, which matters. A server that sees
// `.gz` decides the file is transport-compressed and sets Content-Encoding: gzip
// — Vite's dev server does exactly this — so the browser silently inflates it
// and the app's own inflate then fails on already-plain bytes. Named `.glbz`
// nobody touches it, and the page is the only thing that unpacks it. (The app
// sniffs the gzip magic number anyway, so it survives a server that compresses
// regardless.)
//
// Idempotent: a folder that is already compressed is left alone. Run it after
// dropping new models in, or after obj2glb.
//
//   node tools/gzip-models.mjs --dir public/apps/object-tile-scroll/models
//   node tools/gzip-models.mjs --dir <dir> --keep     # leave the .glb in place

import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const i = argv.indexOf('--dir');
const dir = i >= 0 ? argv[i + 1] : null;
const keep = argv.includes('--keep');
if (!dir) {
  console.error('usage: gzip-models.mjs --dir <dir> [--keep]');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.glb'));
if (!files.length) {
  const done = readdirSync(dir).filter((f) => f.endsWith('.glbz')).length;
  console.log(done ? `nothing to do — ${done} file(s) already compressed` : 'no .glb files found');
  process.exit(0);
}

let raw = 0;
let gz = 0;
for (const f of files) {
  const src = join(dir, f);
  const buf = readFileSync(src);
  // Level 9: these are written once and served forever, so the slow setting is
  // free. It is worth a few percent over the default.
  const out = gzipSync(buf, { level: 9 });
  writeFileSync(join(dir, `${f.slice(0, -4)}.glbz`), out);
  if (!keep) unlinkSync(src);
  raw += buf.length;
  gz += out.length;
}
const kb = (n) => (n / 1024).toFixed(0) + 'KB';
console.log(`${files.length} file(s): ${kb(raw)} -> ${kb(gz)} (${(100 - (100 * gz) / raw).toFixed(0)}% smaller)`);
if (keep) console.log('kept the .glb alongside; the app only fetches .glbz');

// A quick sanity note for whoever runs this next.
const total = readdirSync(dir).filter((f) => f.endsWith('.glbz')).length;
const bytes = readdirSync(dir)
  .filter((f) => f.endsWith('.glbz'))
  .reduce((s, f) => s + statSync(join(dir, f)).size, 0);
console.log(`folder now holds ${total} compressed model(s), ${kb(bytes)} total`);
