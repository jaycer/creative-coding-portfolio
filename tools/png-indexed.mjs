#!/usr/bin/env node
// Re-encode a truecolor PNG that only has a handful of distinct colors as a
// 4-bit indexed PNG.
//
//   node tools/png-indexed.mjs in.png out.png
//
// Written for the Earthbound Layers thumbnail, whose tile is a real frame off
// the running piece. That frame is two indexed layers added together, so it
// genuinely contains 16 colors or fewer — this is not quantization, it is
// writing down what is already there. It took that thumb from 40KB to 4KB, and
// the gallery loads every thumb at once, so the difference is real.
//
// Refuses anything with more than 16 colors rather than quantizing, because a
// silent loss of color is exactly the bug this would otherwise hide.
//
// Input must be 8-bit RGBA (which is what canvas.toDataURL produces). Node
// cannot decode a PNG for us, so the scanlines are unfiltered by hand below;
// that is the only fiddly part and it is the standard five filter types.

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

// --- read the source, which node cannot decode for us: unfilter it by hand ---
const src = readFileSync(process.argv[2]);
let pos = 8, w = 0, h = 0, idat = [];
while (pos < src.length) {
  const len = src.readUInt32BE(pos);
  const type = src.toString('ascii', pos + 4, pos + 8);
  const data = src.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 6) throw new Error('want 8-bit RGBA'); }
  if (type === 'IDAT') idat.push(data);
  pos += 12 + len;
}
const raw = inflateSync(Buffer.concat(idat));
const px = Buffer.alloc(w * h * 4);
const bpp = 4, stride = w * 4;
for (let y = 0; y < h; y++) {
  const f = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? px[y * stride + x - bpp] : 0;
    const b = y > 0 ? px[(y - 1) * stride + x] : 0;
    const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
    let v = line[x];
    if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
    px[y * stride + x] = v & 0xff;
  }
}

// --- collect the palette ---
const map = new Map(); const pal = [];
for (let i = 0; i < w * h; i++) {
  const k = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
  if (!map.has(k)) { map.set(k, pal.length); pal.push(k); }
}
if (pal.length > 16) throw new Error(`${pal.length} colors, more than a 4-bit palette holds`);

// --- write it back out, 4 bits a pixel ---
const rowBytes = Math.ceil(w / 2);
const out = Buffer.alloc((rowBytes + 1) * h);
for (let y = 0; y < h; y++) {
  const o = y * (rowBytes + 1);
  out[o] = 0;
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const idx = map.get((px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2]);
    out[o + 1 + (x >> 1)] |= x & 1 ? idx : idx << 4;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
ihdr[8] = 4; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const plte = Buffer.alloc(pal.length * 3);
pal.forEach((c, i) => { plte[i * 3] = c >> 16; plte[i * 3 + 1] = (c >> 8) & 0xff; plte[i * 3 + 2] = c & 0xff; });
writeFileSync(process.argv[3], Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('PLTE', plte),
  chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${pal.length} colors, ${w}x${h}`);
