#!/usr/bin/env node
// A Gaussian-splat scan  ->  a low-poly flat-shaded GLB Object Tile Scroll can deal.
//
// Triangles rather than voxels, and the reason is where the budget goes. The
// scanner sub-app carves a blocky hull because a visual hull has no real
// surface — it is a carved grid, and cubes forgive the spurs a missed angle
// leaves behind. A splat scan is not that. It is a measurement of the real
// surface, so what it wants is a mesh that can spend its faces where the shape
// is doing something: an animal is one smooth barrel and four small legs, and a
// quadric decimator puts almost nothing on the flank and keeps the legs. At the
// voxel resolution that costs the same bytes, the legs are three cubes.
//
// What triangles do NOT buy is detail the capture never had, and that limit
// binds long before the mesh does. A phone splat of a small object puts its
// surface somewhere inside a band several millimetres thick — five percent of
// the object, on the scan this was written for — and everything below that is
// invention. The model comes out soft. That is the scan, not the budget.
//
// The route, end to end:
//
//   splats -> cull -> density grid -> bracket into a solid -> surface nets
//          -> Taubin smoothing -> quadric decimation -> color -> GLB
//
// BRACKET is the step that took the work, and `bracket()` below has the whole
// argument. The short version: a splat cloud is a hollow shell with pinholes all
// over it, so the obvious move — threshold it, flood air in from outside, call
// the rest inside — gets air into the middle through the first hole it finds and
// hands back a crumpled bag. Reading each ray's entry and exit off accumulated
// density instead does not care about holes at all.
//
// SURFACE NETS rather than marching cubes: its output is quad-regular and
// near-uniform, which is a far better mesh to hand a decimator than marching
// cubes' slivers, and it is eighty lines instead of a 256-entry table.
//
// The output matches what obj2glb.mjs --flat writes, for the same reason: three
// positions per triangle, no index buffer, no normals, one primitive per color
// group. The app computes face normals itself and the model arrives faceted,
// which is what puts a scanned thing in the same world as the Kenney set.
//
// Two settings carry almost all the risk and neither can be guessed from the
// file. --up, because a phone has no idea which way up a pig is. --crop, because
// a splat trainer leaves low-confidence haze in the air around its subject, and
// haze bracketed as geometry is a model wearing a fur coat. Look at the scan
// before running this, and read both off what you see.
//
// Reads a binary PLY or an SPZ, and they are interchangeable: an SPZ is the same
// capture at a tenth the size, decoded into the PLY's own frame so --up means the
// same thing whichever one a scanner handed over.
//
// Usage:
//   node tools/splat2glb.mjs --in <scan.ply|scan.spz> --out <model.glb> [options]
//   node tools/splat2glb.mjs --in ~/Downloads/BertScan.ply \
//     --out public/apps/object-tile-scroll/models/rubberPig.glb \
//     --up -x --grid 52 --min-opacity 0.45 --crop -0.09,-0.11,-0.07,0.08,0.106,0.08
//
//   --up     ±x|±y|±z  which scan axis points up out of the object   (default +y)
//   --yaw    DEG    spin about that axis, after it is stood upright   (default 0)
//   --crop   x0,y0,z0,x1,y1,z1   keep only this box, in the scan's units
//   --tris   N      triangle budget after decimation                  (default 800)
//   --grid   N      longest axis of the density grid, in cells        (default 64)
//   --colors N      flat color groups to cluster into                 (default 1)
//   --min-opacity F drop splats fainter than this                     (default 0.3)
//   --isolation N   drop splats with fewer than N neighbors within 2 cells (default 6)
//   --min-lum F     drop splats darker than this, for a pale subject in a dark room
//   --iso    F      surface level, as a fraction of the density where a splat sits (default 0.5)
//   --bite   F      density a ray passes before it counts as inside, in isos (default 1.5)
//   --agree  N      how many of the three axes must bracket a cell, 1-3 (default 2)
//   --despeckle N   majority-vote passes over the solid                (default 2)
//   --close  N      fill hollows up to 2N cells wide, where the scan saw nothing (default 2)
//   --smooth N      Taubin smoothing passes                           (default 12)
//   --vertex-color  keep the scan's own color, one per vertex, smooth-shaded
//   --report        print the density distribution and the elapsed time
//   --check         grade the capture and stop: sampling, precision, fuzz band,
//                   and whether the orbit missed an arc. Converts nothing, so two
//                   scans of the same object can be compared before either is built.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (n, d) => Number(opt(n, d));

// --check measures the CAPTURE rather than converting it, so it wants no --out.
const CHECK = argv.includes('--check');
const inPath = opt('in');
const outPath = opt('out');
if (!inPath || (!outPath && !CHECK)) {
  console.error('usage: splat2glb.mjs --in <scan.ply> --out <model.glb> [--up ±y] [--crop x0,y0,z0,x1,y1,z1] [--tris 800] [--grid 64]');
  console.error('       splat2glb.mjs --in <scan.ply> --check     # grade the capture, convert nothing');
  process.exit(1);
}
// 64 rather than something finer, because reconstructing below what the
// capture resolved does not add detail, it adds noise — and noise is what a
// decimator will spend its budget describing.
const GRID = Math.max(16, Math.round(num('grid', 64)));
const TRIS = Math.max(24, Math.round(num('tris', 800)));
// One group by default. Clustering a scan's colors mostly separates lit from
// shadowed, and shipping that would bake the room's lighting into a model this
// app is going to relight itself. Raise it only for an object whose PARTS are
// genuinely different colors.
const COLORS = Math.max(1, Math.round(num('colors', 1)));
const UP = opt('up', '+y');
const YAW = num('yaw', 0);
const MIN_OPACITY = num('min-opacity', 0.3);
// A box in the scan's own units, x0,y0,z0,x1,y1,z1. Everything outside it is
// dropped before anything else looks at the data.
const CROP = opt('crop') ? opt('crop').split(',').map(Number) : null;
if (CROP && (CROP.length !== 6 || CROP.some((v) => !Number.isFinite(v)))) {
  console.error('--crop wants six numbers: x0,y0,z0,x1,y1,z1');
  process.exit(1);
}
const ISOLATION = Math.round(num('isolation', 6));
// Drop splats darker than this. Off by default, and deliberately not clever: it
// is here because background haze in a splat scan is usually the unlit room and
// the subject usually is not, which is a fact about a particular capture and not
// about scans in general. On a dark object it would eat the object. Use it when
// a preview shows the haze is dark and the subject is not, and check the result.
const MIN_LUM = num('min-lum', 0);
const ISO = num('iso', 0.5);
const BITE = num('bite', 1.5);
const AGREE = Math.min(3, Math.max(1, Math.round(num('agree', 2))));
const DESPECKLE = Math.max(0, Math.round(num('despeckle', 2)));
const CLOSE = Math.max(0, Math.round(num('close', 2)));
const SMOOTH = Math.max(0, Math.round(num('smooth', 12)));
// The other half of what a scan measured. Off by default because Object Tile
// Scroll deletes every attribute but position and normal on arrival — the deck
// decides what an object is made of — so this is for a viewer that wants to show
// the thing as it was captured rather than as the piece dresses it.
const VCOLOR = argv.includes('--vertex-color');
const report = argv.includes('--report');
const say = (...a) => console.log(...a);
// How far a single splat is allowed to reach, in cells. It bounds the cost of
// the stamping loop, and the grid's padding is sized from it.
const REACH = 4;

// --------------------------------------------------------------------- the ply
// Binary PLY, either flavor. A 3D Gaussian splat file (what Scaniverse, Polycam
// and the reference trainer all write) carries opacity and per-axis scales,
// which is real information about how much surface a point stands for and gets
// used below. A plain XYZ+RGB cloud is read too, with every point weighted the
// same — it costs ten lines to accept and it is the difference between "this
// tool reads scans" and "this tool reads one export button".
const PLY_TYPES = {
  float: 4, float32: 4, double: 8, float64: 8,
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
};

function readPly(raw) {
  const at = raw.indexOf('end_header');
  if (at < 0) throw new Error('not a PLY: no end_header');
  const headEnd = raw.indexOf('\n', at) + 1;
  const head = raw.subarray(0, at).toString('latin1');
  if (!/format\s+binary_little_endian/.test(head)) {
    throw new Error('only binary_little_endian PLY is supported (re-export, or convert with any viewer)');
  }

  // Properties are read off the FIRST element only; a splat file has just the
  // one, and anything after it (faces, say) is ignored rather than misparsed.
  let count = 0;
  let inFirst = false;
  const props = [];
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (t.startsWith('element ')) {
      if (inFirst) break;
      inFirst = true;
      count = parseInt(t.split(/\s+/)[2], 10);
    } else if (inFirst && t.startsWith('property ')) {
      const p = t.split(/\s+/);
      if (p[1] === 'list') throw new Error('list properties in the vertex element are not supported');
      const size = PLY_TYPES[p[1]];
      if (!size) throw new Error(`unknown property type: ${p[1]}`);
      props.push({ name: p[p.length - 1], type: p[1], size });
    }
  }
  const stride = props.reduce((s, p) => s + p.size, 0);
  if (!count || !stride) throw new Error('PLY has no vertex element');
  if (headEnd + count * stride > raw.length) throw new Error('PLY is truncated');

  let off = 0;
  const offsets = new Map();
  for (const p of props) { offsets.set(p.name, { ...p, off }); off += p.size; }
  const get = (name) => {
    const p = offsets.get(name);
    if (!p) return null;
    const out = new Float64Array(count);
    for (let i = 0, base = headEnd + p.off; i < count; i++, base += stride) {
      switch (p.type) {
        case 'float': case 'float32': out[i] = raw.readFloatLE(base); break;
        case 'double': case 'float64': out[i] = raw.readDoubleLE(base); break;
        case 'char': case 'int8': out[i] = raw.readInt8(base); break;
        case 'uchar': case 'uint8': out[i] = raw.readUInt8(base); break;
        case 'short': case 'int16': out[i] = raw.readInt16LE(base); break;
        case 'ushort': case 'uint16': out[i] = raw.readUInt16LE(base); break;
        case 'int': case 'int32': out[i] = raw.readInt32LE(base); break;
        default: out[i] = raw.readUInt32LE(base); break;
      }
    }
    return out;
  };

  const x = get('x'); const y = get('y'); const z = get('z');
  if (!x || !y || !z) throw new Error('PLY has no x/y/z');

  const sigmoid = (v) => 1 / (1 + Math.exp(-v));
  const rawOpacity = get('opacity');
  const opacity = new Float64Array(count).fill(1);
  if (rawOpacity) for (let i = 0; i < count; i++) opacity[i] = sigmoid(rawOpacity[i]);

  // Splat scales are stored as logs, and the three axes are the anisotropic
  // ellipsoid. Only their mean is wanted here — the density field is isotropic,
  // because the surface it is looking for is the union of these things, not
  // any one of them.
  const s0 = get('scale_0'); const s1 = get('scale_1'); const s2 = get('scale_2');
  const radius = new Float64Array(count);
  if (s0 && s1 && s2) {
    for (let i = 0; i < count; i++) {
      radius[i] = (Math.exp(s0[i]) + Math.exp(s1[i]) + Math.exp(s2[i])) / 3;
    }
  }

  // Color: SH band 0 for a splat file (f_dc, which is a coefficient and not a
  // color until it is scaled and biased), plain bytes for a point cloud.
  const SH_C0 = 0.28209479177387814;
  const d0 = get('f_dc_0'); const d1 = get('f_dc_1'); const d2 = get('f_dc_2');
  const r8 = get('red'); const g8 = get('green'); const b8 = get('blue');
  const rgb = new Float64Array(count * 3).fill(0.8);
  if (d0 && d1 && d2) {
    for (let i = 0; i < count; i++) {
      rgb[i * 3] = Math.min(1, Math.max(0, SH_C0 * d0[i] + 0.5));
      rgb[i * 3 + 1] = Math.min(1, Math.max(0, SH_C0 * d1[i] + 0.5));
      rgb[i * 3 + 2] = Math.min(1, Math.max(0, SH_C0 * d2[i] + 0.5));
    }
  } else if (r8 && g8 && b8) {
    // Byte colors are sRGB; glTF baseColorFactor is linear, and the app reads
    // that straight into a THREE.Color. Convert, or every scan lands pale.
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    for (let i = 0; i < count; i++) {
      rgb[i * 3] = lin(r8[i] / 255);
      rgb[i * 3 + 1] = lin(g8[i] / 255);
      rgb[i * 3 + 2] = lin(b8[i] / 255);
    }
  }
  return { count, x, y, z, opacity, radius, rgb, splat: !!(d0 && s0), format: 'ply' };
}

// --------------------------------------------------------------------- the spz
// Niantic's splat format, and what Scaniverse actually holds: the PLY it will
// also give you is this file decompressed, with the float32 precision as
// decoration. Verified against a scan exported both ways — same 30,555 points in
// the same order, positions identical TO THE BIT after undoing a Y/Z flip and a
// sub-millimetre recentring, scale identical, opacity and color equal to within
// float32 rounding. For 11.4x fewer bytes.
//
// So this is here for the file size and for the convenience of not having to
// pick the right export, not because either carries more of the capture.
const SPZ_MAGIC = 0x5053474e;          // 'NGSP', little-endian
const SPZ_SH_DIM = [0, 3, 8, 15];      // coefficients per channel, by SH degree

function readSpz(buf) {
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const count = buf.readUInt32LE(8);
  const shDegree = buf.readUInt8(12);
  const fractionalBits = buf.readUInt8(13);
  if (magic !== SPZ_MAGIC) throw new Error('not an SPZ: wrong magic');
  if (version !== 2) {
    throw new Error(`SPZ version ${version} — this reads version 2. A wrong layout `
      + 'would decode to plausible garbage rather than fail, so it refuses instead.');
  }
  const shDim = SPZ_SH_DIM[shDegree];
  if (shDim === undefined) throw new Error(`SPZ SH degree ${shDegree} is not 0-3`);

  // Positions, alpha, color, scale, rotation, then the higher SH bands. Checked
  // against the file length, because a layout that is off by one field still
  // decodes — into something that looks like a scan of nothing in particular.
  const per = 9 + 1 + 3 + 3 + 3 + shDim * 3;
  const want = 16 + count * per;
  if (buf.length !== want) {
    throw new Error(`SPZ is ${buf.length} bytes; ${count} points at ${per} bytes each plus a 16-byte header is ${want}`);
  }

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  const opacity = new Float64Array(count);
  const radius = new Float64Array(count);
  const rgb = new Float64Array(count * 3);

  const SH_C0 = 0.28209479177387814;
  // The three constants that are not in the header and have to be known: color
  // is stored with a 0.15 scale about a half-way grey, log-scale in sixteenths
  // offset by -10, and position as 24-bit fixed point with the header's
  // fractional bits. All three were confirmed against the matching PLY.
  const COLOR_SCALE = 0.15;
  const denom = 1 << fractionalBits;
  let o = 16;
  const posAt = o; o += count * 9;
  const alphaAt = o; o += count;
  const colorAt = o; o += count * 3;
  const scaleAt = o;

  for (let i = 0; i < count; i++) {
    const p = posAt + i * 9;
    for (let k = 0; k < 3; k++) {
      const b0 = buf[p + k * 3]; const b1 = buf[p + k * 3 + 1]; const b2 = buf[p + k * 3 + 2];
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v >= 0x800000) v -= 0x1000000;
      const val = v / denom;
      // Into the frame Scaniverse's own PLY uses, so --up means the same thing
      // whichever file somebody happened to export. SPZ is Y-up; that PLY is
      // written with Y and Z negated, and every recipe written down here was
      // worked out against the PLY.
      if (k === 0) x[i] = val;
      else if (k === 1) y[i] = -val;
      else z[i] = -val;
    }
    opacity[i] = buf[alphaAt + i] / 255;
    let r = 0;
    for (let k = 0; k < 3; k++) {
      const c = SH_C0 * ((buf[colorAt + i * 3 + k] / 255 - 0.5) / COLOR_SCALE) + 0.5;
      rgb[i * 3 + k] = c < 0 ? 0 : c > 1 ? 1 : c;
      r += Math.exp(buf[scaleAt + i * 3 + k] / 16 - 10) / 3;
    }
    radius[i] = r;
  }
  return { count, x, y, z, opacity, radius, rgb, splat: true, format: 'spz', fractionalBits };
}

/** Read whichever of the two a scanner handed over. */
function readScan(path) {
  let buf = readFileSync(path);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);   // SPZ ships gzipped
  if (buf.length >= 4 && buf.readUInt32LE(0) === SPZ_MAGIC) return readSpz(buf);
  if (buf.subarray(0, 3).toString('latin1') === 'ply') return readPly(buf);
  throw new Error(`${path} is neither a PLY nor an SPZ`);
}

// -------------------------------------------------------------------- the cull
// Two passes, and they do different jobs.
//
// OPACITY drops the haze a trainer leaves in the air around a subject: faint,
// large, low-confidence blobs that exist to make one view's background right.
// They are numerous enough to fatten the object by a visible margin.
//
// ISOLATION drops the specks that survive that — the stray floater sitting in
// clear air with nothing near it. This is the one that matters most for what
// comes next, because a single floater near the object welds a spur onto the
// hull, and one anywhere at all pushes the bounding box out and coarsens the
// grid for everything else.
function cull(pts) {
  const keep = new Uint8Array(pts.count);
  let n = 0;
  for (let i = 0; i < pts.count; i++) {
    if (pts.opacity[i] < MIN_OPACITY) continue;
    if (MIN_LUM > 0 && (pts.rgb[i * 3] + pts.rgb[i * 3 + 1] + pts.rgb[i * 3 + 2]) / 3 < MIN_LUM) continue;
    if (CROP && (
      pts.x[i] < CROP[0] || pts.y[i] < CROP[1] || pts.z[i] < CROP[2]
      || pts.x[i] > CROP[3] || pts.y[i] > CROP[4] || pts.z[i] > CROP[5]
    )) continue;
    keep[i] = 1; n++;
  }
  if (!n) throw new Error(`--min-opacity ${MIN_OPACITY}${MIN_LUM ? ' and --min-lum' : ''}${CROP ? ' and --crop' : ''} kept nothing`);

  // Bounds of what survived, which is also what sets the grid.
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.count; i++) {
    if (!keep[i]) continue;
    const v = [pts.x[i], pts.y[i], pts.z[i]];
    for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  }
  const cell = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / GRID;

  if (ISOLATION > 0) {
    // Neighbor counting through a hash grid at twice the cell size, so "near"
    // is one bucket and its 26 neighbors and nothing has to be sorted.
    const h = cell * 2;
    const key = (i) => `${Math.floor(pts.x[i] / h)},${Math.floor(pts.y[i] / h)},${Math.floor(pts.z[i] / h)}`;
    const bins = new Map();
    for (let i = 0; i < pts.count; i++) {
      if (!keep[i]) continue;
      const k = key(i);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(i);
    }
    const r2 = (cell * 2) ** 2;
    for (let i = 0; i < pts.count; i++) {
      if (!keep[i]) continue;
      const cx = Math.floor(pts.x[i] / h); const cy = Math.floor(pts.y[i] / h); const cz = Math.floor(pts.z[i] / h);
      let near = 0;
      for (let a = -1; a <= 1 && near < ISOLATION; a++) {
        for (let b = -1; b <= 1 && near < ISOLATION; b++) {
          for (let c = -1; c <= 1 && near < ISOLATION; c++) {
            const bin = bins.get(`${cx + a},${cy + b},${cz + c}`);
            if (!bin) continue;
            for (const j of bin) {
              if (j === i) continue;
              const dx = pts.x[j] - pts.x[i]; const dy = pts.y[j] - pts.y[i]; const dz = pts.z[j] - pts.z[i];
              if (dx * dx + dy * dy + dz * dz <= r2 && ++near >= ISOLATION) break;
            }
          }
        }
      }
      if (near < ISOLATION) { keep[i] = 0; n--; }
    }
  }
  if (!n) throw new Error(`--isolation ${ISOLATION} kept nothing`);

  // Re-measure: dropping the floaters is what makes these bounds tight, and
  // they are the ones the grid is built on.
  lo = [Infinity, Infinity, Infinity];
  hi = [-Infinity, -Infinity, -Infinity];
  const out = { n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), w: new Float64Array(n), r: new Float64Array(n), rgb: new Float64Array(n * 3) };
  let j = 0;
  for (let i = 0; i < pts.count; i++) {
    if (!keep[i]) continue;
    out.x[j] = pts.x[i]; out.y[j] = pts.y[i]; out.z[j] = pts.z[i];
    out.w[j] = pts.opacity[i];
    out.r[j] = pts.radius[i];
    out.rgb[j * 3] = pts.rgb[i * 3]; out.rgb[j * 3 + 1] = pts.rgb[i * 3 + 1]; out.rgb[j * 3 + 2] = pts.rgb[i * 3 + 2];
    for (const [k, v] of [[0, out.x[j]], [1, out.y[j]], [2, out.z[j]]]) {
      if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
    }
    j++;
  }
  out.lo = lo; out.hi = hi;
  return out;
}

/**
 * Median distance to a splat's nearest neighbor — how finely the scan actually
 * sampled the surface.
 *
 * This is the number that decides everything downstream and it is not the same
 * as the splat scale: a trainer will happily fit a 1mm ellipsoid to a patch it
 * only sampled every 3mm, because a splat is sized to look right from the
 * camera, not to tile the surface. Reconstruct at the scale it was drawn at and
 * you get a shell full of pinholes, the fill leaks straight through it, and what
 * comes back is a crumpled bag rather than a pig.
 */
function spacingOf(p, hint) {
  const h = hint;
  const bins = new Map();
  const key = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  for (let i = 0; i < p.n; i++) {
    const k = key(p.x[i], p.y[i], p.z[i]);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(i);
  }
  const step = Math.max(1, Math.floor(p.n / 4000));
  const dists = [];
  for (let i = 0; i < p.n; i += step) {
    const bx = Math.floor(p.x[i] / h); const by = Math.floor(p.y[i] / h); const bz = Math.floor(p.z[i] / h);
    let best = Infinity;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const bin = bins.get(`${bx + a},${by + b},${bz + c}`);
          if (!bin) continue;
          for (const j of bin) {
            if (j === i) continue;
            const d2 = (p.x[j] - p.x[i]) ** 2 + (p.y[j] - p.y[i]) ** 2 + (p.z[j] - p.z[i]) ** 2;
            if (d2 < best) best = d2;
          }
        }
      }
    }
    if (best < Infinity) dists.push(Math.sqrt(best));
  }
  dists.sort((a, b) => a - b);
  return dists.length ? dists[Math.floor(dists.length / 2)] : hint;
}

// ------------------------------------------------------------------- the check
// Grade the CAPTURE rather than the conversion, so two scans of the same object
// can be compared without building a model from either.
//
// Everything here was written first as a one-off script to work out why a pig
// came back with a dent in his back, and the answer took a whole evening because
// each measurement had to be invented on the spot. They are cheap, they are the
// ones that turned out to matter, and a rescan should not cost an evening again.

/** Eigenvalues of a symmetric 3x3, smallest first. Closed form, no iteration. */
function eigen3(a11, a12, a13, a22, a23, a33) {
  const p1 = a12 * a12 + a13 * a13 + a23 * a23;
  const q = (a11 + a22 + a33) / 3;
  if (p1 < 1e-30) return [a11, a22, a33].sort((x, y) => x - y);
  const p2 = (a11 - q) ** 2 + (a22 - q) ** 2 + (a33 - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b11 = (a11 - q) / p; const b22 = (a22 - q) / p; const b33 = (a33 - q) / p;
  const b12 = a12 / p; const b13 = a13 / p; const b23 = a23 / p;
  const det = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13);
  const r = Math.max(-1, Math.min(1, det / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [e3, 3 * q - e1 - e3, e1];
}

/** The cloud's longest direction, by power iteration on its covariance. */
function longAxis(p) {
  let cx = 0; let cy = 0; let cz = 0;
  for (let i = 0; i < p.n; i++) { cx += p.x[i]; cy += p.y[i]; cz += p.z[i]; }
  cx /= p.n; cy /= p.n; cz /= p.n;
  let c = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < p.n; i++) {
    const dx = p.x[i] - cx; const dy = p.y[i] - cy; const dz = p.z[i] - cz;
    c[0] += dx * dx; c[1] += dx * dy; c[2] += dx * dz;
    c[3] += dy * dy; c[4] += dy * dz; c[5] += dz * dz;
  }
  c = c.map((v) => v / p.n);
  let v = [1, 0.3, 0.7];
  for (let k = 0; k < 60; k++) {
    const nx = c[0] * v[0] + c[1] * v[1] + c[2] * v[2];
    const ny = c[1] * v[0] + c[3] * v[1] + c[4] * v[2];
    const nz = c[2] * v[0] + c[4] * v[1] + c[5] * v[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    v = [nx / l, ny / l, nz / l];
  }
  return { center: [cx, cy, cz], axis: v };
}

/**
 * How thick the shell of splats is, in millimetres.
 *
 * A trainer does not put splats ON a surface, it puts them in a band around
 * where the surface probably is, and the depth of that band is the hard limit on
 * everything downstream — no reconstruction resolves detail finer than the
 * uncertainty in its own input. Measured as the spread of each splat's
 * neighbourhood along its thinnest direction: fit a local plane, ask how far off
 * it the neighbours sit.
 */
function fuzzBand(p, radius) {
  const h = radius * 2;
  const bins = new Map();
  for (let i = 0; i < p.n; i++) {
    const k = `${Math.floor(p.x[i] / h)},${Math.floor(p.y[i] / h)},${Math.floor(p.z[i] / h)}`;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(i);
  }
  const r2 = radius * radius * 4;
  const step = Math.max(1, Math.floor(p.n / 3000));
  const out = [];
  for (let i = 0; i < p.n; i += step) {
    const bx = Math.floor(p.x[i] / h); const by = Math.floor(p.y[i] / h); const bz = Math.floor(p.z[i] / h);
    let n = 0; let sx = 0; let sy = 0; let sz = 0;
    const near = [];
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const bin = bins.get(`${bx + a},${by + b},${bz + c}`);
          if (!bin) continue;
          for (const j of bin) {
            const d2 = (p.x[j] - p.x[i]) ** 2 + (p.y[j] - p.y[i]) ** 2 + (p.z[j] - p.z[i]) ** 2;
            if (d2 > r2) continue;
            near.push(j); sx += p.x[j]; sy += p.y[j]; sz += p.z[j]; n++;
          }
        }
      }
    }
    if (n < 10) continue;
    sx /= n; sy /= n; sz /= n;
    let c11 = 0; let c12 = 0; let c13 = 0; let c22 = 0; let c23 = 0; let c33 = 0;
    for (const j of near) {
      const dx = p.x[j] - sx; const dy = p.y[j] - sy; const dz = p.z[j] - sz;
      c11 += dx * dx; c12 += dx * dy; c13 += dx * dz;
      c22 += dy * dy; c23 += dy * dz; c33 += dz * dz;
    }
    const e = eigen3(c11 / n, c12 / n, c13 / n, c22 / n, c23 / n, c33 / n);
    out.push(Math.sqrt(Math.max(0, e[0])));
  }
  out.sort((a, b) => a - b);
  return out.length ? out[Math.floor(out.length / 2)] : NaN;
}

/**
 * Splats per square centimetre around the object's long axis, by angle.
 *
 * This is the measurement that finds a missed arc of the orbit, which is the
 * failure mode that actually bites and the one nothing downstream can repair.
 * Where a sector is empty the reconstruction has nothing holding its surface
 * out, so it falls inward — which shows up here twice, once as a hole in the
 * coverage and again as a smaller radius in the same sector.
 */
function coverageByAngle(p) {
  const { center, axis } = longAxis(p);
  // Any perpendicular pair will do: the gap is a gap wherever zero is put, and
  // its direction is reported in the scan's own axes at the end.
  let u = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = u[0] * axis[0] + u[1] * axis[1] + u[2] * axis[2];
  u = [u[0] - axis[0] * d, u[1] - axis[1] * d, u[2] - axis[2] * d];
  const ul = Math.hypot(...u);
  u = u.map((v) => v / ul);
  const w = [
    axis[1] * u[2] - axis[2] * u[1],
    axis[2] * u[0] - axis[0] * u[2],
    axis[0] * u[1] - axis[1] * u[0],
  ];

  const t = new Float64Array(p.n);
  const rad = new Float64Array(p.n);
  const ang = new Float64Array(p.n);
  for (let i = 0; i < p.n; i++) {
    const dx = p.x[i] - center[0]; const dy = p.y[i] - center[1]; const dz = p.z[i] - center[2];
    t[i] = dx * axis[0] + dy * axis[1] + dz * axis[2];
    const a = dx * u[0] + dy * u[1] + dz * u[2];
    const b = dx * w[0] + dy * w[1] + dz * w[2];
    rad[i] = Math.hypot(a, b);
    ang[i] = Math.atan2(b, a);
  }
  const pct = (arr, q) => {
    const s = Array.from(arr).sort((x, y) => x - y);
    return s[Math.floor(s.length * q)];
  };
  // The barrel only: the ends of a thing are legitimately sparse and would drag
  // every sector down without telling anybody anything.
  const t0 = pct(t, 0.2); const t1 = pct(t, 0.8);
  const rMin = pct(rad, 0.35);
  const L = t1 - t0;

  const BINS = 24;
  const bins = Array.from({ length: BINS }, () => ({ n: 0, radii: [] }));
  for (let i = 0; i < p.n; i++) {
    if (t[i] < t0 || t[i] > t1 || rad[i] < rMin) continue;
    let k = Math.floor(((ang[i] + Math.PI) / (2 * Math.PI)) * BINS);
    if (k < 0) k = 0;
    if (k >= BINS) k = BINS - 1;
    bins[k].n++;
    bins[k].radii.push(rad[i]);
  }
  for (const b of bins) {
    b.radii.sort((x, y) => x - y);
    b.radius = b.radii.length ? b.radii[Math.floor(b.radii.length / 2)] : 0;
    // Arc length x barrel length is the surface this sector's splats must cover.
    const arc = ((2 * Math.PI) / BINS) * (b.radius || rMin);
    b.perCm2 = arc * L > 0 ? b.n / (arc * L * 1e4) : 0;
  }
  // The middle of each bin, back in the scan's own axes, so a gap can be acted on.
  const dirOf = (k) => {
    const a = -Math.PI + ((k + 0.5) / BINS) * 2 * Math.PI;
    const ca = Math.cos(a); const sa = Math.sin(a);
    return [0, 1, 2].map((j) => ca * u[j] + sa * w[j]);
  };
  return { bins, dirOf, axis, length: L };
}

/**
 * How much local colour variation the surface carries.
 *
 * This is a measure of the SUBJECT rather than of the capture, and it predicts
 * more about how a scan will turn out than any setting does. Every multi-view
 * method — photogrammetry and splatting alike — works by recognising the same
 * patch of surface from two directions. Give it a smooth object of one colour
 * and there is nothing to recognise: poses drift, depth along the ray is barely
 * constrained, and the trainer settles for a thick band of splats that is right
 * on average and nowhere in particular.
 *
 * Measured as the median spread of colour among each splat's near neighbours.
 * A printed label, a seam, a scuff, a woodgrain all raise it. Bare glossy
 * plastic in one colour does not.
 */
function surfaceContrast(p, radius) {
  const h = radius * 2;
  const bins = new Map();
  for (let i = 0; i < p.n; i++) {
    const k = `${Math.floor(p.x[i] / h)},${Math.floor(p.y[i] / h)},${Math.floor(p.z[i] / h)}`;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(i);
  }
  const r2 = radius * radius * 4;
  const step = Math.max(1, Math.floor(p.n / 3000));
  const out = [];
  for (let i = 0; i < p.n; i += step) {
    const bx = Math.floor(p.x[i] / h); const by = Math.floor(p.y[i] / h); const bz = Math.floor(p.z[i] / h);
    let n = 0; let s = 0; let s2 = 0;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const bin = bins.get(`${bx + a},${by + b},${bz + c}`);
          if (!bin) continue;
          for (const j of bin) {
            const d2 = (p.x[j] - p.x[i]) ** 2 + (p.y[j] - p.y[i]) ** 2 + (p.z[j] - p.z[i]) ** 2;
            if (d2 > r2) continue;
            const lum = (p.rgb[j * 3] + p.rgb[j * 3 + 1] + p.rgb[j * 3 + 2]) / 3;
            s += lum; s2 += lum * lum; n++;
          }
        }
      }
    }
    if (n < 10) continue;
    out.push(Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)));
  }
  out.sort((a, b) => a - b);
  return out.length ? out[Math.floor(out.length / 2)] : NaN;
}

/** Does this file carry the precision it claims, or is it a decoded quantisation? */
function quantisation(pts) {
  const levels = (get) => {
    const s = new Set();
    for (let i = 0; i < pts.count && s.size <= 4096; i++) s.add(get(i));
    return s;
  };
  const xs = Array.from(levels((i) => pts.x[i])).sort((a, b) => a - b);
  let step = null;
  if (xs.length > 8 && xs.length <= 4096) {
    const gaps = [];
    for (let i = 1; i < xs.length; i++) {
      const g = xs[i] - xs[i - 1];
      if (g > 1e-12) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const lo = gaps[0];
    const mid = gaps[Math.floor(gaps.length / 2)];
    // A float32 cloud has gaps spanning orders of magnitude; a fixed-point one
    // has every gap equal to the same step.
    if (mid / lo < 1.05) step = lo;
  }
  return {
    step,
    posLevels: xs.length,
    opacity: levels((i) => pts.opacity[i]).size,
    color: levels((i) => pts.rgb[i * 3]).size,
  };
}

// ----------------------------------------------------------------- the density
// Every splat is stamped into the grid as an isotropic Gaussian weighted by its
// opacity. Its width is the largest of three things: the splat's own scale, what
// it takes to reach the next splat along, and three quarters of a cell. The
// middle one is what makes the shell watertight, and it is the difference
// between this working and this producing a crumpled bag.
function density(p, dim, lo, cell, floor) {
  const [nx, ny, nz] = dim;
  const f = new Float32Array(nx * ny * nz);
  // Which cells actually hold a splat, as opposed to merely catching the tail of
  // one. This is what the surface level gets calibrated against below.
  const support = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < p.n; i++) {
    const sa = Math.floor((p.x[i] - lo[0]) / cell);
    const sb = Math.floor((p.y[i] - lo[1]) / cell);
    const sc = Math.floor((p.z[i] - lo[2]) / cell);
    if (sa >= 0 && sa < nx && sb >= 0 && sb < ny && sc >= 0 && sc < nz) support[(sc * ny + sb) * nx + sa] = 1;
  }
  for (let i = 0; i < p.n; i++) {
    const sigma = Math.max(p.r[i], floor, cell * 0.75);
    const reach = Math.min(REACH, Math.ceil((sigma * 2.2) / cell));
    const gx = (p.x[i] - lo[0]) / cell;
    const gy = (p.y[i] - lo[1]) / cell;
    const gz = (p.z[i] - lo[2]) / cell;
    const cx = Math.round(gx); const cy = Math.round(gy); const cz = Math.round(gz);
    const k = -0.5 / ((sigma / cell) ** 2);
    for (let a = cx - reach; a <= cx + reach; a++) {
      if (a < 0 || a >= nx) continue;
      const dx = a - gx;
      for (let b = cy - reach; b <= cy + reach; b++) {
        if (b < 0 || b >= ny) continue;
        const dy = b - gy;
        for (let c = cz - reach; c <= cz + reach; c++) {
          if (c < 0 || c >= nz) continue;
          const dz = c - gz;
          f[(c * ny + b) * nx + a] += p.w[i] * Math.exp(k * (dx * dx + dy * dy + dz * dz));
        }
      }
    }
  }
  return { f, support };
}

/** Grid neighbors, 6-connected, as flat indices. */
function* neighbors6(idx, nx, ny, nz) {
  const a = idx % nx;
  const b = Math.floor(idx / nx) % ny;
  const c = Math.floor(idx / (nx * ny));
  if (a > 0) yield idx - 1;
  if (a < nx - 1) yield idx + 1;
  if (b > 0) yield idx - nx;
  if (b < ny - 1) yield idx + nx;
  if (c > 0) yield idx - nx * ny;
  if (c < nz - 1) yield idx + nx * ny;
}

/**
 * Fill every cell a ray crosses between entering the object and leaving it,
 * along each of the three axes, and keep what most of them agree on.
 *
 * This is the step that turns a scan into a body, and it is here because the
 * obvious thing does not work. A splat scan is a hollow shell — the columns
 * through this one read `...###......####...`, a front surface and a back
 * surface with nothing between them — and it is a shell with pinholes all over
 * it. So flooding air in from outside and calling the rest inside gets air into
 * the middle through the first hole it finds and comes back with a crumpled bag.
 * No closing radius fixes that reliably: measured on this scan, the holes run
 * from one cell to eight, and the radius that seals the big ones swells the
 * model by more than the model is worth.
 *
 * Bracketing does not care about holes. A ray that goes in and comes out fills
 * what it crossed whatever the surface was doing in between, so porosity along
 * that surface is irrelevant.
 *
 * Taking all three axes rather than one is what keeps the shape honest: a ray
 * along the body brackets straight through the gap between two legs, but the ray
 * across it finds clear air there and does not, so the legs stay apart. It is
 * the visual hull idea the scanner sub-app carves from photographs, run here
 * against real 3D positions — and better than a hull, because each ray brackets
 * its OWN entry and exit instead of a shared silhouette, so a dent facing the
 * ray survives where a silhouette carve would fill it in.
 */
function bracket(f, dim, bite, agree) {
  const [nx, ny, nz] = dim;
  const at = (a, b, c) => (c * ny + b) * nx + a;
  const votes = new Uint8Array(f.length);

  // A ray is INSIDE from the point where it has passed a fixed amount of
  // density — a bite — and stays inside until the same is true walking back
  // from the far end. Not a threshold on any single cell, and not a fraction of
  // the column either.
  //
  // A threshold on a cell has to be right twice at once: low enough that the
  // porous shell has no holes for the bracket to fall through, high enough that
  // the haze around the object is not counted as the object. On this scan there
  // is no such level; the two requirements are a factor of three apart.
  //
  // A fraction of the column's own mass fails differently and more quietly. It
  // is right down the middle of the object and wrong everywhere else: a column
  // that grazes an ear carries a tenth of what one through the body does, and
  // trimming a fixed PERCENTAGE off both trims a tenth as much material off the
  // ear as off the body in absolute terms — or, read the other way, eats the
  // ear. Measured on this scan: the same 6% takes the model from 69,000 cells
  // to 27,000, and what it takes is all the thin parts.
  //
  // A fixed bite has neither problem. Haze is diffuse, so it takes many cells to
  // add up to one and the entry point lands on the real surface; a pinhole in
  // that surface changes the running total by a rounding error and moves the
  // entry point not at all.
  const run = (count, get) => {
    let total = 0;
    for (let i = 0; i < count; i++) total += f[get(i)];
    // Two bites, because a crossing needs a way in and a way out. This is the
    // rule that keeps the space under a belly outside the model: a ray coming up
    // from below meets the belly and stops, so it never brackets anything.
    if (total < bite * 2) return;
    let seen = 0;
    let first = 0;
    for (let i = 0; i < count; i++) { seen += f[get(i)]; if (seen >= bite) { first = i; break; } }
    seen = 0;
    let last = count - 1;
    for (let i = count - 1; i >= 0; i--) { seen += f[get(i)]; if (seen >= bite) { last = i; break; } }
    for (let i = first; i <= last; i++) votes[get(i)]++;
  };
  for (let c = 0; c < nz; c++) for (let b = 0; b < ny; b++) run(nx, (i) => at(i, b, c));
  for (let c = 0; c < nz; c++) for (let a = 0; a < nx; a++) run(ny, (i) => at(a, i, c));
  for (let b = 0; b < ny; b++) for (let a = 0; a < nx; a++) run(nz, (i) => at(a, b, i));

  // Two axes out of three, by default. Unanimity is the textbook intersection
  // and it is too brittle on a real scan: one column that happens to run down a
  // thin place and fall short of two bites deletes material the other two axes
  // both bracketed. Dropping to two costs almost nothing where it matters — the
  // places that have to stay hollow, like between a pair of legs, are bracketed
  // by at most one axis anyway — and it is worth about a third of the model.
  const out = new Uint8Array(f.length);
  for (let i = 0; i < votes.length; i++) if (votes[i] >= agree) out[i] = 1;
  return out;
}

// -------------------------------------------------------------------- the solid
// Flood air in from outside the bracketed body and keep what it cannot reach,
// which seals whatever the three axes disagreed about. Then the largest
// connected component only — the last thing that kills a floater which survived
// both culls and then got bracketed into a lump of its own.
function solidify(grown, dim) {
  const [nx, ny, nz] = dim;

  // Flood from every empty cell on the boundary rather than from one corner: a
  // splat sitting right on the edge of the scan's own bounding box can stamp
  // weight into the padding, and losing the whole run to one such cell would be
  // a silly way to fail.
  const outside = new Uint8Array(grown.length);
  const stack = [];
  for (let c = 0; c < nz; c++) {
    for (let b = 0; b < ny; b++) {
      for (let a = 0; a < nx; a++) {
        if (a && b && c && a < nx - 1 && b < ny - 1 && c < nz - 1) continue;
        const i = (c * ny + b) * nx + a;
        if (!grown[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
      }
    }
  }
  if (!stack.length) throw new Error('every border cell is occupied — the scan fills its own bounding box, so there is no outside to flood from');
  while (stack.length) {
    const i = stack.pop();
    for (const j of neighbors6(i, nx, ny, nz)) {
      if (!outside[j] && !grown[j]) { outside[j] = 1; stack.push(j); }
    }
  }
  const solid = new Uint8Array(grown.length);
  for (let i = 0; i < solid.length; i++) solid[i] = outside[i] ? 0 : 1;

  // Largest component.
  const label = new Int32Array(solid.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  let next = 0;
  for (let s = 0; s < solid.length; s++) {
    if (!solid[s] || label[s] >= 0) continue;
    const id = next++;
    let size = 0;
    const q = [s];
    label[s] = id;
    while (q.length) {
      const i = q.pop();
      size++;
      for (const j of neighbors6(i, nx, ny, nz)) {
        if (solid[j] && label[j] < 0) { label[j] = id; q.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  for (let i = 0; i < solid.length; i++) if (label[i] !== best) solid[i] = 0;
  return { solid, filled: bestSize, blobs: next };
}

/**
 * Dilate then erode by the same radius: a morphological CLOSE, which fills a
 * hollow up to about 2r cells across and leaves the outside where it was.
 *
 * This is aimed at one specific thing. Where the scan never saw a patch of the
 * object — an underside that sat on the table, a flank in shadow — the density
 * there is genuinely zero, so the bracket finds its way in from two axes and
 * leaves a real tunnel through the model. The majority filter cannot help: the
 * hole is much wider than one cell, and every cell in the middle of it has a
 * clear majority of empty neighbors. Closing is the operation that is actually
 * about the size of a gap rather than about the size of a speck.
 */
function close(v, dim, r) {
  const [nx, ny, nz] = dim;
  const pass = (cur, grow) => {
    const next = cur.slice();
    for (let i = 0; i < cur.length; i++) {
      // Dilation spreads out of the occupied cells; erosion spreads in from the
      // empty ones. Same walk, opposite seed.
      if (grow ? !cur[i] : cur[i]) continue;
      for (const j of neighbors6(i, nx, ny, nz)) next[j] = grow ? 1 : 0;
    }
    return next;
  };
  let cur = v;
  for (let i = 0; i < r; i++) cur = pass(cur, true);
  for (let i = 0; i < r; i++) cur = pass(cur, false);
  return cur;
}

/**
 * Majority vote over each cell's 26 neighbors, a few times.
 *
 * A threshold on a real scan does not give a clean body: it gives a body with
 * grit stuck to it and pinpricks taken out of it, and the isosurface of THAT is
 * a crumpled bag whatever the triangle budget. Nothing downstream can recover
 * from it — the decimator will happily spend its budget describing the grit.
 * This is the cheapest thing that removes a speck and fills a prick while
 * leaving anything the width of a leg completely alone.
 */
function despeckle(solid, dim, rounds) {
  const [nx, ny, nz] = dim;
  let cur = solid;
  for (let pass = 0; pass < rounds; pass++) {
    const next = new Uint8Array(cur.length);
    for (let c = 0; c < nz; c++) {
      for (let b = 0; b < ny; b++) {
        for (let a = 0; a < nx; a++) {
          let on = 0;
          let seen = 0;
          for (let k = -1; k <= 1; k++) {
            const cz = c + k;
            if (cz < 0 || cz >= nz) continue;
            for (let j = -1; j <= 1; j++) {
              const cy = b + j;
              if (cy < 0 || cy >= ny) continue;
              for (let i = -1; i <= 1; i++) {
                const cx = a + i;
                if (cx < 0 || cx >= nx) continue;
                seen++;
                on += cur[(cz * ny + cy) * nx + cx];
              }
            }
          }
          next[(c * ny + b) * nx + a] = on * 2 > seen ? 1 : 0;
        }
      }
    }
    cur = next;
  }
  return cur;
}

// ------------------------------------------------------------- the isosurface
// Naive surface nets. One vertex per cell that straddles the surface, placed at
// the average of the crossings on that cell's twelve edges, and one quad per
// grid edge that changes sign, joining the four cells around it. Closed and
// manifold by construction, and near-uniform, which is exactly what the
// decimator below wants — marching cubes would hand it slivers instead.
const CELL_CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const CELL_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function surfaceNets(field, dim, lo, cell, iso) {
  const [nx, ny, nz] = dim;
  const at = (a, b, c) => field[(c * ny + b) * nx + a];
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const verts = [];
  const cidx = (a, b, c) => (c * (ny - 1) + b) * (nx - 1) + a;

  for (let c = 0; c < nz - 1; c++) {
    for (let b = 0; b < ny - 1; b++) {
      for (let a = 0; a < nx - 1; a++) {
        const v = new Array(8);
        let mask = 0;
        for (let k = 0; k < 8; k++) {
          const o = CELL_CORNERS[k];
          v[k] = at(a + o[0], b + o[1], c + o[2]);
          if (v[k] > iso) mask |= 1 << k;
        }
        if (mask === 0 || mask === 255) continue;
        let px = 0; let py = 0; let pz = 0; let hits = 0;
        for (const [i0, i1] of CELL_EDGES) {
          const inside0 = (mask >> i0) & 1;
          const inside1 = (mask >> i1) & 1;
          if (inside0 === inside1) continue;
          const t = (iso - v[i0]) / (v[i1] - v[i0]);
          const o0 = CELL_CORNERS[i0]; const o1 = CELL_CORNERS[i1];
          px += o0[0] + (o1[0] - o0[0]) * t;
          py += o0[1] + (o1[1] - o0[1]) * t;
          pz += o0[2] + (o1[2] - o0[2]) * t;
          hits++;
        }
        cellVert[cidx(a, b, c)] = verts.length / 3;
        verts.push(
          lo[0] + (a + px / hits) * cell,
          lo[1] + (b + py / hits) * cell,
          lo[2] + (c + pz / hits) * cell,
        );
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells around it. The
  // winding follows the direction of the sign change so that every face ends up
  // pointing OUT of the solid — get this backwards and the model is inside out,
  // which does not look like an error in a wireframe and looks like a black
  // object in the app. There is a check for it at the end.
  const faces = [];
  const quad = (p, q, r, s, flip) => {
    if (p < 0 || q < 0 || r < 0 || s < 0) return;
    if (flip) faces.push(p, r, q, p, s, r);
    else faces.push(p, q, r, p, r, s);
  };
  for (let c = 0; c < nz - 1; c++) {
    for (let b = 0; b < ny - 1; b++) {
      for (let a = 0; a < nx - 1; a++) {
        const here = at(a, b, c) > iso;
        if (a > 0 && b > 0 && (at(a, b, c + 1) > iso) !== here) {
          quad(cellVert[cidx(a, b, c)], cellVert[cidx(a - 1, b, c)], cellVert[cidx(a - 1, b - 1, c)], cellVert[cidx(a, b - 1, c)], here);
        }
        if (a > 0 && c > 0 && (at(a, b + 1, c) > iso) !== here) {
          quad(cellVert[cidx(a, b, c)], cellVert[cidx(a, b, c - 1)], cellVert[cidx(a - 1, b, c - 1)], cellVert[cidx(a - 1, b, c)], here);
        }
        if (b > 0 && c > 0 && (at(a + 1, b, c) > iso) !== here) {
          quad(cellVert[cidx(a, b, c)], cellVert[cidx(a, b - 1, c)], cellVert[cidx(a, b - 1, c - 1)], cellVert[cidx(a, b, c - 1)], here);
        }
      }
    }
  }
  // The divergence theorem, used as an assertion. A closed surface wound
  // consistently outward encloses a positive volume; wound inward it encloses
  // exactly minus the same number. Anything near zero would mean the winding is
  // not consistent at all, which surface nets cannot produce and which nothing
  // downstream could survive.
  let vol = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3; const b = faces[i + 1] * 3; const c = faces[i + 2] * 3;
    vol += (
      verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1])
      - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c])
      + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c])
    ) / 6;
  }
  if (vol < 0) for (let i = 0; i < faces.length; i += 3) { const t = faces[i + 1]; faces[i + 1] = faces[i + 2]; faces[i + 2] = t; }

  return { verts: Float64Array.from(verts), faces: Int32Array.from(faces) };
}

/**
 * Taubin smoothing: a Laplacian pass that shrinks, then a slightly larger
 * negative one that pushes back out. Plain Laplacian smoothing on a closed
 * surface deflates it — run it long enough on a pig and you get an egg — and
 * the whole point of the alternating pass is that it does not.
 */
function smooth(mesh, passes, lambda = 0.55, mu = -0.58) {
  const { verts, faces } = mesh;
  const n = verts.length / 3;
  const adj = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = [faces[i], faces[i + 1], faces[i + 2]];
    adj[a].add(b); adj[a].add(c);
    adj[b].add(a); adj[b].add(c);
    adj[c].add(a); adj[c].add(b);
  }
  let cur = verts;
  for (let pass = 0; pass < passes * 2; pass++) {
    const k = pass % 2 ? mu : lambda;
    const next = new Float64Array(cur.length);
    for (let i = 0; i < n; i++) {
      const near = adj[i];
      if (!near.size) { next[i * 3] = cur[i * 3]; next[i * 3 + 1] = cur[i * 3 + 1]; next[i * 3 + 2] = cur[i * 3 + 2]; continue; }
      let sx = 0; let sy = 0; let sz = 0;
      for (const j of near) { sx += cur[j * 3]; sy += cur[j * 3 + 1]; sz += cur[j * 3 + 2]; }
      const m = near.size;
      next[i * 3] = cur[i * 3] + k * (sx / m - cur[i * 3]);
      next[i * 3 + 1] = cur[i * 3 + 1] + k * (sy / m - cur[i * 3 + 1]);
      next[i * 3 + 2] = cur[i * 3 + 2] + k * (sz / m - cur[i * 3 + 2]);
    }
    cur = next;
  }
  return { verts: cur, faces };
}

// -------------------------------------------------------------- the decimation
// Garland–Heckbert quadric error metrics. Each vertex carries the sum of the
// squared-distance forms of its incident planes; collapsing an edge costs
// whatever that sum says the new point is away from all of them, and the
// cheapest collapse always goes next. On a barrel with four legs this spends
// almost nothing on the flank and keeps its faces where the curvature is, which
// is the entire argument for triangles over voxels at this budget.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1; const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function decimate(mesh, target) {
  const pos = Array.from({ length: mesh.verts.length / 3 }, (_, i) => [mesh.verts[i * 3], mesh.verts[i * 3 + 1], mesh.verts[i * 3 + 2]]);
  const faces = [];
  for (let i = 0; i < mesh.faces.length; i += 3) faces.push([mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]]);

  const nv = pos.length;
  const facesOf = Array.from({ length: nv }, () => new Set());
  const alive = new Uint8Array(faces.length).fill(1);
  faces.forEach((f, i) => { for (const v of f) facesOf[v].add(i); });
  const dead = new Uint8Array(nv);
  const version = new Int32Array(nv);

  const planeOf = (f) => {
    const [a, b, c] = f.map((i) => pos[i]);
    const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
    const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-18) return null;
    nx /= len; ny /= len; nz /= len;
    return [nx, ny, nz, -(nx * a[0] + ny * a[1] + nz * a[2])];
  };
  const addPlane = (q, p) => {
    const [a, b, c, d] = p;
    q[0] += a * a; q[1] += a * b; q[2] += a * c; q[3] += a * d;
    q[4] += b * b; q[5] += b * c; q[6] += b * d;
    q[7] += c * c; q[8] += c * d;
    q[9] += d * d;
  };
  const quadrics = Array.from({ length: nv }, () => new Float64Array(10));
  for (const f of faces) {
    const p = planeOf(f);
    if (!p) continue;
    for (const v of f) addPlane(quadrics[v], p);
  }
  const errorAt = (q, v) => {
    const [x, y, z] = v;
    return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
      + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
      + q[7] * z * z + 2 * q[8] * z
      + q[9];
  };

  /** Best position for a collapse: solve the quadric, or fall back if it is flat. */
  function bestPlace(q, a, b) {
    const m = [q[0], q[1], q[2], q[1], q[4], q[5], q[2], q[5], q[7]];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) > 1e-14) {
      const r = [-q[3], -q[6], -q[8]];
      const inv = [
        (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
        (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
        (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
      ];
      const v = [
        inv[0] * r[0] + inv[1] * r[1] + inv[2] * r[2],
        inv[3] * r[0] + inv[4] * r[1] + inv[5] * r[2],
        inv[6] * r[0] + inv[7] * r[1] + inv[8] * r[2],
      ];
      // A near-singular solve can throw the point across the model. Keep it only
      // if it landed near the edge it came from.
      const span = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 4 + 1e-9;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (Math.hypot(v[0] - mid[0], v[1] - mid[1], v[2] - mid[2]) < span) return v;
    }
    const options = [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]];
    let bestV = options[2];
    let bestE = Infinity;
    for (const o of options) {
      const e = errorAt(q, o);
      if (e < bestE) { bestE = e; bestV = o; }
    }
    return bestV;
  }

  const neighborsOf = (v) => {
    const out = new Set();
    for (const fi of facesOf[v]) for (const w of faces[fi]) if (w !== v) out.add(w);
    return out;
  };

  const heap = new Heap();
  const consider = (a, b) => {
    if (a === b || dead[a] || dead[b]) return;
    const q = new Float64Array(10);
    for (let k = 0; k < 10; k++) q[k] = quadrics[a][k] + quadrics[b][k];
    const at = bestPlace(q, pos[a], pos[b]);
    heap.push({ a, b, at, cost: Math.max(0, errorAt(q, at)), va: version[a], vb: version[b] });
  };
  const seen = new Set();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const a = f[k]; const b = f[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      consider(a, b);
    }
  }

  let liveFaces = faces.length;
  let collapses = 0;
  while (liveFaces > target && heap.size) {
    const e = heap.pop();
    if (dead[e.a] || dead[e.b] || version[e.a] !== e.va || version[e.b] !== e.vb) continue;

    // The link condition. On a closed manifold an edge is safe to collapse only
    // if its endpoints share exactly the two vertices opposite it; anything else
    // pinches the surface into something that is no longer a surface.
    const na = neighborsOf(e.a);
    const nb = neighborsOf(e.b);
    let shared = 0;
    for (const v of na) if (nb.has(v)) shared++;
    if (shared !== 2) continue;

    // And it must not turn a triangle inside out, which quadrics do not notice
    // and an eye notices immediately.
    const touched = new Set([...facesOf[e.a], ...facesOf[e.b]]);
    const doomed = [...facesOf[e.a]].filter((fi) => facesOf[e.b].has(fi));
    let flips = false;
    for (const fi of touched) {
      if (doomed.includes(fi)) continue;
      const before = planeOf(faces[fi]);
      if (!before) continue;
      const moved = faces[fi].map((v) => ((v === e.a || v === e.b) ? e.at : pos[v]));
      const ux = moved[1][0] - moved[0][0]; const uy = moved[1][1] - moved[0][1]; const uz = moved[1][2] - moved[0][2];
      const vx = moved[2][0] - moved[0][0]; const vy = moved[2][1] - moved[0][1]; const vz = moved[2][2] - moved[0][2];
      const nx2 = uy * vz - uz * vy; const ny2 = uz * vx - ux * vz; const nz2 = ux * vy - uy * vx;
      const len = Math.hypot(nx2, ny2, nz2);
      if (len < 1e-18) { flips = true; break; }
      if ((before[0] * nx2 + before[1] * ny2 + before[2] * nz2) / len < 0.1) { flips = true; break; }
    }
    if (flips) continue;

    // Do it: b folds into a, a moves to the chosen point.
    pos[e.a] = e.at;
    for (let k = 0; k < 10; k++) quadrics[e.a][k] += quadrics[e.b][k];
    for (const fi of [...facesOf[e.b]]) {
      const f = faces[fi];
      for (let k = 0; k < 3; k++) if (f[k] === e.b) f[k] = e.a;
      if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) {
        if (alive[fi]) { alive[fi] = 0; liveFaces--; }
        for (const v of new Set(f)) facesOf[v].delete(fi);
      } else {
        facesOf[e.a].add(fi);
      }
      facesOf[e.b].delete(fi);
    }
    dead[e.b] = 1;
    version[e.a]++;
    collapses++;
    for (const v of neighborsOf(e.a)) consider(e.a, v);
  }

  // Repack.
  const remap = new Int32Array(nv).fill(-1);
  const outVerts = [];
  const outFaces = [];
  faces.forEach((f, i) => {
    if (!alive[i]) return;
    const tri = f.map((v) => {
      if (remap[v] < 0) { remap[v] = outVerts.length / 3; outVerts.push(pos[v][0], pos[v][1], pos[v][2]); }
      return remap[v];
    });
    outFaces.push(tri[0], tri[1], tri[2]);
  });
  return { verts: Float64Array.from(outVerts), faces: Int32Array.from(outFaces), collapses };
}

/**
 * Sample the splat cloud's color at a point.
 *
 * Opacity- and distance-weighted, and the weighting matters more than it looks:
 * an unweighted average over a radius smears a dark eye across half a face, and
 * a nearest-splat lookup picks up whatever single blob happened to land there.
 *
 * The width ADAPTS to what is actually nearby. Where the scan is dense the
 * kernel stays at `radius` and resolves what the capture resolved; where it is
 * thin the kernel opens out to reach the nearest splats there are. Without that
 * the tight kernel finds nothing over the parts a capture missed and the surface
 * comes back in flat grey patches with ragged edges — which look far more like a
 * bug than the honest answer, which is that the color there is a guess made from
 * further away.
 */
function makeColorSampler(p, radius) {
  const h = Math.max(radius * 3, 0.004);
  const bins = new Map();
  for (let i = 0; i < p.n; i++) {
    const kk = `${Math.floor(p.x[i] / h)},${Math.floor(p.y[i] / h)},${Math.floor(p.z[i] / h)}`;
    if (!bins.has(kk)) bins.set(kk, []);
    bins.get(kk).push(i);
  }
  const near = [];
  return (cx, cy, cz, out) => {
    const bx = Math.floor(cx / h); const by = Math.floor(cy / h); const bz = Math.floor(cz / h);
    near.length = 0;
    let closest = Infinity;
    for (let ring = 1; ring <= 3 && !near.length; ring++) {
      for (let a = -ring; a <= ring; a++) {
        for (let bb = -ring; bb <= ring; bb++) {
          for (let c = -ring; c <= ring; c++) {
            const bin = bins.get(`${bx + a},${by + bb},${bz + c}`);
            if (!bin) continue;
            for (const i of bin) {
              const d2 = (p.x[i] - cx) ** 2 + (p.y[i] - cy) ** 2 + (p.z[i] - cz) ** 2;
              near.push(i, d2);
              if (d2 < closest) closest = d2;
            }
          }
        }
      }
    }
    if (!near.length) { out[0] = 0.7; out[1] = 0.7; out[2] = 0.7; return out; }
    // Wide enough to reach the nearest splat there is, never tighter than asked.
    const sigma = Math.max(radius, Math.sqrt(closest) * 0.9);
    const sigma2 = 2 * sigma * sigma;
    let r = 0; let g = 0; let b = 0; let wsum = 0;
    for (let k = 0; k < near.length; k += 2) {
      const i = near[k];
      const w = p.w[i] * Math.exp(-near[k + 1] / sigma2);
      r += p.rgb[i * 3] * w; g += p.rgb[i * 3 + 1] * w; b += p.rgb[i * 3 + 2] * w;
      wsum += w;
    }
    if (wsum > 1e-9) { out[0] = r / wsum; out[1] = g / wsum; out[2] = b / wsum; }
    else { out[0] = 0.7; out[1] = 0.7; out[2] = 0.7; }
    return out;
  };
}

/**
 * A color per vertex, and smooth normals to go with them.
 *
 * This is the other half of what a scan actually measured, and on a real object
 * it is the larger half. Bert's ears, the notch in his snout, his eye, the seam
 * down his side — none of that is shape at the scale the geometry resolves, all
 * of it is color, and a flat-shaded untextured mesh throws every bit of it away.
 *
 * Smooth normals rather than faceted here, deliberately, and it is the one place
 * in this tool that departs from the deck's language. Faceting is what makes a
 * hand-built model read as made; on a scan carrying its own color it just puts a
 * lattice of hard edges over a photograph of a rubber pig.
 */
function vertexColors(mesh, sample) {
  const nv = mesh.verts.length / 3;
  const colors = new Float64Array(nv * 3);
  const out = [0, 0, 0];
  for (let v = 0; v < nv; v++) {
    sample(mesh.verts[v * 3], mesh.verts[v * 3 + 1], mesh.verts[v * 3 + 2], out);
    colors[v * 3] = out[0]; colors[v * 3 + 1] = out[1]; colors[v * 3 + 2] = out[2];
  }
  // Area-weighted vertex normals: a big triangle should have more say in which
  // way a corner faces than a sliver sharing it.
  const normals = new Float64Array(nv * 3);
  for (let f = 0; f < mesh.faces.length; f += 3) {
    const a = mesh.faces[f] * 3; const b = mesh.faces[f + 1] * 3; const c = mesh.faces[f + 2] * 3;
    const ux = mesh.verts[b] - mesh.verts[a];
    const uy = mesh.verts[b + 1] - mesh.verts[a + 1];
    const uz = mesh.verts[b + 2] - mesh.verts[a + 2];
    const vx = mesh.verts[c] - mesh.verts[a];
    const vy = mesh.verts[c + 1] - mesh.verts[a + 1];
    const vz = mesh.verts[c + 2] - mesh.verts[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const at of [a, b, c]) { normals[at] += nx; normals[at + 1] += ny; normals[at + 2] += nz; }
  }
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]) || 1;
    normals[v * 3] /= l; normals[v * 3 + 1] /= l; normals[v * 3 + 2] /= l;
  }
  return { colors, normals };
}

// ------------------------------------------------------------------ the color
// Object Tile Scroll never uses a model's materials. It reads the RELATIONSHIPS
// between their colors — biggest group is the body, everything else is stored as
// an HSL delta from it — and then decides for itself what the object is made of.
// So what this has to produce is not a faithful color, it is a small number of
// groups whose colors sit in the right relation to each other: a dark snout has
// to stay dark relative to the body under any finish the piece picks.
//
// Per-triangle color comes from the splats around its centroid. K-means over
// those, then a majority vote across each triangle's neighbors, because a
// speckled assignment costs nothing here in triangles (the app merges by
// material) but produces a model whose "groups" are noise rather than parts.
function colorize(mesh, p, k, cell) {
  const nf = mesh.faces.length / 3;
  const h = cell * 3;
  const bins = new Map();
  const key = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  for (let i = 0; i < p.n; i++) {
    const kk = key(p.x[i], p.y[i], p.z[i]);
    if (!bins.has(kk)) bins.set(kk, []);
    bins.get(kk).push(i);
  }

  const faceColor = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    let cx = 0; let cy = 0; let cz = 0;
    for (let j = 0; j < 3; j++) {
      const v = mesh.faces[f * 3 + j];
      cx += mesh.verts[v * 3] / 3; cy += mesh.verts[v * 3 + 1] / 3; cz += mesh.verts[v * 3 + 2] / 3;
    }
    const bx = Math.floor(cx / h); const by = Math.floor(cy / h); const bz = Math.floor(cz / h);
    let r = 0; let g = 0; let b = 0; let wsum = 0;
    for (let a = -1; a <= 1; a++) {
      for (let bb = -1; bb <= 1; bb++) {
        for (let c = -1; c <= 1; c++) {
          const bin = bins.get(`${bx + a},${by + bb},${bz + c}`);
          if (!bin) continue;
          for (const i of bin) {
            const d2 = (p.x[i] - cx) ** 2 + (p.y[i] - cy) ** 2 + (p.z[i] - cz) ** 2;
            const w = p.w[i] * Math.exp(-d2 / (2 * (cell * 1.5) ** 2));
            r += p.rgb[i * 3] * w; g += p.rgb[i * 3 + 1] * w; b += p.rgb[i * 3 + 2] * w;
            wsum += w;
          }
        }
      }
    }
    if (wsum > 1e-9) { faceColor[f * 3] = r / wsum; faceColor[f * 3 + 1] = g / wsum; faceColor[f * 3 + 2] = b / wsum; }
    else { faceColor[f * 3] = 0.7; faceColor[f * 3 + 1] = 0.7; faceColor[f * 3 + 2] = 0.7; }
  }

  if (k === 1) {
    const mean = [0, 0, 0];
    for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) mean[c] += faceColor[f * 3 + c] / nf;
    return { group: new Int32Array(nf), colors: [mean] };
  }

  // K-means, seeded by spreading the starts as far apart as the data allows
  // (k-means++ without the randomness, so a rerun gives the same model).
  const centers = [];
  let seed = [0, 0, 0];
  for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) seed[c] += faceColor[f * 3 + c] / nf;
  centers.push(seed);
  while (centers.length < k) {
    let far = 0; let farD = -1;
    for (let f = 0; f < nf; f++) {
      let d = Infinity;
      for (const c of centers) {
        d = Math.min(d, (faceColor[f * 3] - c[0]) ** 2 + (faceColor[f * 3 + 1] - c[1]) ** 2 + (faceColor[f * 3 + 2] - c[2]) ** 2);
      }
      if (d > farD) { farD = d; far = f; }
    }
    centers.push([faceColor[far * 3], faceColor[far * 3 + 1], faceColor[far * 3 + 2]]);
  }
  const group = new Int32Array(nf);
  for (let iter = 0; iter < 40; iter++) {
    let moved = 0;
    for (let f = 0; f < nf; f++) {
      let best = 0; let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (faceColor[f * 3] - centers[c][0]) ** 2 + (faceColor[f * 3 + 1] - centers[c][1]) ** 2 + (faceColor[f * 3 + 2] - centers[c][2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (group[f] !== best) { group[f] = best; moved++; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let f = 0; f < nf; f++) {
      const s = sums[group[f]];
      s[0] += faceColor[f * 3]; s[1] += faceColor[f * 3 + 1]; s[2] += faceColor[f * 3 + 2]; s[3]++;
    }
    for (let c = 0; c < centers.length; c++) if (sums[c][3]) centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    if (!moved) break;
  }

  // Despeckle: a triangle outvoted by its edge-neighbors joins them. Three
  // rounds is enough to clear grain without eating a real patch.
  const edgeMap = new Map();
  for (let f = 0; f < nf; f++) {
    for (let j = 0; j < 3; j++) {
      const a = mesh.faces[f * 3 + j]; const b = mesh.faces[f * 3 + ((j + 1) % 3)];
      const kk = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeMap.has(kk)) edgeMap.set(kk, []);
      edgeMap.get(kk).push(f);
    }
  }
  const nbr = Array.from({ length: nf }, () => []);
  for (const fs of edgeMap.values()) {
    if (fs.length !== 2) continue;
    nbr[fs[0]].push(fs[1]);
    nbr[fs[1]].push(fs[0]);
  }
  for (let round = 0; round < 3; round++) {
    const next = group.slice();
    for (let f = 0; f < nf; f++) {
      const tally = new Map();
      for (const g of nbr[f]) tally.set(group[g], (tally.get(group[g]) || 0) + 1);
      let win = group[f]; let winN = (tally.get(group[f]) || 0) + 0.5;
      for (const [g, c] of tally) if (c > winN) { winN = c; win = g; }
      next[f] = win;
    }
    group.set(next);
  }

  // Recolor from the final grouping and drop any cluster that lost all its
  // triangles, so `colors` and the primitives stay in step.
  const used = [];
  const sums = centers.map(() => [0, 0, 0, 0]);
  for (let f = 0; f < nf; f++) {
    const s = sums[group[f]];
    s[0] += faceColor[f * 3]; s[1] += faceColor[f * 3 + 1]; s[2] += faceColor[f * 3 + 2]; s[3]++;
  }
  const remap = new Int32Array(centers.length).fill(-1);
  for (let c = 0; c < centers.length; c++) {
    if (!sums[c][3]) continue;
    remap[c] = used.length;
    used.push([sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]]);
  }
  for (let f = 0; f < nf; f++) group[f] = remap[group[f]];
  return { group, colors: used };
}

// ------------------------------------------------------------------- the write
// Same shape as obj2glb.mjs --flat: positions only, three per triangle, no index
// buffer and no normals, one primitive per color group. bakeModel() calls
// computeVertexNormals() on what arrives, which on unindexed geometry produces
// exactly face normals — the faceting is a property of this pipeline rather
// than of whatever the scanner felt like exporting.
const pad4 = (n) => (n + 3) & ~3;

function buildGlb(mesh, group, colors, name) {
  const bin = [];
  const bufferViews = [];
  const accessors = [];
  const primitives = [];
  const materials = [];
  let offset = 0;
  const addView = (buf) => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
    const chunk = Buffer.alloc(pad4(buf.length));
    buf.copy(chunk);
    bin.push(chunk);
    offset += chunk.length;
    return bufferViews.length - 1;
  };

  const byGroup = colors.map(() => []);
  for (let f = 0; f < mesh.faces.length / 3; f++) byGroup[group[f]].push(f);

  colors.forEach((color, g) => {
    const tris = byGroup[g];
    if (!tris.length) return;
    const count = tris.length * 3;
    const p = Buffer.alloc(count * 12);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let at = 0;
    for (const f of tris) {
      for (let j = 0; j < 3; j++) {
        const v = mesh.faces[f * 3 + j];
        for (let c = 0; c < 3; c++) {
          const val = mesh.verts[v * 3 + c];
          p.writeFloatLE(val, at); at += 4;
          if (val < min[c]) min[c] = val;
          if (val > max[c]) max[c] = val;
        }
      }
    }
    accessors.push({ bufferView: addView(p), componentType: 5126, count, type: 'VEC3', min, max });
    materials.push({
      name: `${name}_${g}`,
      pbrMetallicRoughness: { baseColorFactor: [color[0], color[1], color[2], 1], metallicFactor: 0, roughnessFactor: 0.8 },
    });
    primitives.push({ attributes: { POSITION: accessors.length - 1 }, material: materials.length - 1 });
  });

  const binBuf = Buffer.concat(bin);
  const json = {
    asset: { version: '2.0', generator: 'splat2glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBuf.length }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binBuf.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binBuf.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonChunk, bh, binBuf]);
}

/**
 * The vertex-colored variant: one indexed primitive carrying position, normal
 * and COLOR_0, and a white material for the colors to multiply.
 *
 * Indexed and smooth, where the flat writer above is neither. With a color per
 * vertex there is nothing to gain from splitting the corners — the color is the
 * detail, and sharing a vertex between the triangles that meet at it is both
 * smaller and better looking.
 *
 * COLOR_0 goes out as normalized unsigned bytes: a color has nowhere near 24
 * bits of real precision after being averaged out of a splat cloud, and VEC4
 * rather than VEC3 because a three-byte element would leave the accessor
 * misaligned and glTF requires four.
 */
function buildVertexColorGlb(mesh, colors, normals, name) {
  const nv = mesh.verts.length / 3;
  const bin = [];
  const bufferViews = [];
  let offset = 0;
  const addView = (buf, target) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: buf.length };
    if (target) view.target = target;
    bufferViews.push(view);
    const chunk = Buffer.alloc(pad4(buf.length));
    buf.copy(chunk);
    bin.push(chunk);
    offset += chunk.length;
    return bufferViews.length - 1;
  };

  const pos = Buffer.alloc(nv * 12);
  const nrm = Buffer.alloc(nv * 12);
  const col = Buffer.alloc(nv * 4);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) {
    for (let c = 0; c < 3; c++) {
      const val = mesh.verts[v * 3 + c];
      pos.writeFloatLE(val, v * 12 + c * 4);
      nrm.writeFloatLE(normals[v * 3 + c], v * 12 + c * 4);
      if (val < min[c]) min[c] = val;
      if (val > max[c]) max[c] = val;
      col.writeUInt8(Math.max(0, Math.min(255, Math.round(colors[v * 3 + c] * 255))), v * 4 + c);
    }
    col.writeUInt8(255, v * 4 + 3);
  }
  const short = nv <= 65535;
  const idx = Buffer.alloc(mesh.faces.length * (short ? 2 : 4));
  for (let i = 0; i < mesh.faces.length; i++) {
    if (short) idx.writeUInt16LE(mesh.faces[i], i * 2);
    else idx.writeUInt32LE(mesh.faces[i], i * 4);
  }

  const accessors = [
    { bufferView: addView(pos, 34962), componentType: 5126, count: nv, type: 'VEC3', min, max },
    { bufferView: addView(nrm, 34962), componentType: 5126, count: nv, type: 'VEC3' },
    { bufferView: addView(col, 34962), componentType: 5121, normalized: true, count: nv, type: 'VEC4' },
    { bufferView: addView(idx, 34963), componentType: short ? 5123 : 5125, count: mesh.faces.length, type: 'SCALAR' },
  ];

  const binBuf = Buffer.concat(bin);
  const json = {
    asset: { version: '2.0', generator: 'splat2glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
        indices: 3,
        material: 0,
      }],
    }],
    materials: [{
      name,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 },
    }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBuf.length }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binBuf.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binBuf.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonChunk, bh, binBuf]);
}

/**
 * Stand the model up.
 *
 * `normalize()` in the app centers every build and scales it to a unit sphere,
 * so absolute size genuinely does not matter and is not corrected here.
 * Orientation is the opposite: a scan arrives in whatever frame the phone was
 * holding and a pig on its side is a pig on its side forever.
 */
function orient(verts, up, yawDeg) {
  const m = {
    '+y': (x, y, z) => [x, y, z],
    '-y': (x, y, z) => [x, -y, -z],
    '+z': (x, y, z) => [x, z, -y],
    '-z': (x, y, z) => [x, -z, y],
    '+x': (x, y, z) => [-y, x, z],
    '-x': (x, y, z) => [y, -x, z],
  }[up];
  if (!m) throw new Error(`--up must be one of ±x ±y ±z, got "${up}"`);
  const a = (yawDeg * Math.PI) / 180;
  const ca = Math.cos(a); const sa = Math.sin(a);
  for (let i = 0; i < verts.length; i += 3) {
    const [x, y, z] = m(verts[i], verts[i + 1], verts[i + 2]);
    verts[i] = x * ca + z * sa;
    verts[i + 1] = y;
    verts[i + 2] = -x * sa + z * ca;
  }
  return verts;
}

// --------------------------------------------------------------------- the run
const t0 = Date.now();
const pts = readScan(inPath);
say(`read      ${pts.count} ${pts.splat ? 'splats' : 'points'} from ${inPath}`);

// The whole file's extent, printed whether or not it is cropped, because it is
// what somebody has to read a --crop box off.
{
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.count; i++) {
    const v = [pts.x[i], pts.y[i], pts.z[i]];
    for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  }
  const fmt = (a) => a.map((v) => v.toFixed(3)).join(',');
  say(`extent    ${fmt(lo)} .. ${fmt(hi)}${CROP ? `  cropped to ${fmt(CROP.slice(0, 3))} .. ${fmt(CROP.slice(3))}` : ''}`);
}

const p = cull(pts);
say(`cull      ${p.n} kept (opacity >= ${MIN_OPACITY}${MIN_LUM ? `, brightness >= ${MIN_LUM}` : ''}, >= ${ISOLATION} neighbors)`);

const span = [p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]];
const cell = Math.max(...span) / GRID;
const spacing = spacingOf(p, cell * 2);
say(`sample    splats sit ${(spacing * 1000).toFixed(2)}mm apart, median`);

if (CHECK) {
  const size = Math.max(...span);
  const mm = (v) => `${(v * 1000).toFixed(2)}mm`;
  const pctOf = (v) => `${((v / size) * 100).toFixed(2)}% of the object`;
  say(`size      ${mm(size)} on its longest side`);

  const q = quantisation(pts);
  if (q.step && pts.format === 'spz') {
    say(`precision ${mm(q.step)} position lattice, ${pts.fractionalBits} fractional bits — quantised at`);
    say(`          source, which is what this format is. opacity ${q.opacity} levels, color ${q.color}`);
  } else if (q.step) {
    say(`precision positions land on a ${mm(q.step)} lattice, so this file is a decoded`);
    say(`          quantisation and its float32 is decoration. The same scan as SPZ`);
    say(`          would be a tenth the size and carry the same numbers.`);
    say(`          opacity ${q.opacity} levels, color ${q.color} levels`);
  } else {
    say(`precision positions look continuous (${q.posLevels > 4096 ? '>4096' : q.posLevels} distinct), opacity ${q.opacity} levels`);
  }

  const contrast = surfaceContrast(p, Math.max(spacing * 2.5, cell));
  const grade = contrast < 0.02 ? 'featureless — nothing for the poses to lock onto'
    : contrast < 0.05 ? 'faint' : 'plenty to match on';
  say(`contrast  ${(contrast * 100).toFixed(1)}% local variation — ${grade}`);

  const fuzz = fuzzBand(p, Math.max(spacing * 2.5, cell));
  say(`fuzz      ${mm(fuzz)} thick, ${pctOf(fuzz)}`);
  say(`          the band the splats scatter in. Nothing downstream resolves finer.`);
  if (contrast < 0.05 && fuzz / size > 0.005) {
    say(`          A smooth one-color subject is the usual cause of a thick band:`);
    say(`          a translucent or glossy object gives the trainer light that comes`);
    say(`          from under the surface, not off it, so it has nothing crisp to`);
    say(`          converge on. A matte, patterned object scans far better.`);
  }

  const cov = coverageByAngle(p);
  const dens = cov.bins.map((b) => b.perCm2).filter((v) => v > 0).sort((a, b) => a - b);
  const typical = dens.length ? dens[Math.floor(dens.length / 2)] : 0;
  const thin = cov.bins.filter((b) => b.perCm2 < typical * 0.35);
  const fat = cov.bins.filter((b) => b.perCm2 >= typical * 0.35);
  const medRadius = (list) => {
    const r = list.map((b) => b.radius).filter((v) => v > 0).sort((a, b) => a - b);
    return r.length ? r[Math.floor(r.length / 2)] : 0;
  };
  say(`coverage  ${typical.toFixed(0)}/cm² typical around the long axis, over ${cov.bins.length} sectors`);
  if (thin.length) {
    const worst = thin.reduce((a, b) => (a.perCm2 <= b.perCm2 ? a : b));
    const deficit = medRadius(fat) - medRadius(thin);
    const dir = cov.dirOf(cov.bins.indexOf(worst)).map((v) => v.toFixed(2)).join(',');
    say(`          ${thin.length} of ${cov.bins.length} sectors under a third of that — the capture missed an arc`);
    say(`          thinnest ${worst.perCm2.toFixed(0)}/cm², toward ${dir} in the scan's own axes`);
    if (deficit > fuzz) {
      say(`          and the surface there sits ${mm(deficit)} further in than the covered`);
      say(`          sectors agree on. That is a dent you did not scan, not a dent it has.`);
    }
    say(`          FIX: reshoot that arc. No setting recovers what was never seen.`);
  } else {
    say(`          no sector under a third of typical — the orbit went all the way round`);
  }
  process.exit(0);
}

// Air all round, so the flood fill always has an outside to start from and the
// surface never runs into the wall of the grid. Wide enough to hold the widest
// splat footprint plus the closing radius, or the object welds itself to the
// grid wall and the fill has nowhere to begin.
const PAD = REACH + 1;
const lo = p.lo.map((v) => v - PAD * cell);
const dim = span.map((s) => Math.ceil(s / cell) + 2 * PAD + 1);
say(`grid      ${dim.join('x')} cells at ${(cell * 1000).toFixed(2)}mm`);

const { f, support } = density(p, dim, lo, cell, spacing * 0.7);

// Where to cut.
//
// The level is calibrated against the cells that actually HOLD a splat, and the
// reason is that the alternatives are both traps. Against the maximum: that is
// wherever the trainer happened to pile splats up, an order of magnitude above
// everything else and different in every capture. Against the median of every
// cell carrying weight: most of those cells hold no splat at all, they are the
// tail of the Gaussians around them, and cutting there gives an object several
// cells fatter than the one that was scanned — the fur-coat failure, which
// looks plausible in a render and is wrong by a centimetre.
//
// Half of the median reading in a cell that holds a splat is the surface: a
// Gaussian sum falls to half its value at the edge of the sampled region.
const held = [];
for (let i = 0; i < f.length; i++) if (support[i]) held.push(f[i]);
held.sort((a, b) => a - b);
const interior = held[Math.floor(held.length / 2)];
const iso = interior * ISO;
if (report) {
  const all = Array.from(f).filter((v) => v > 1e-4).sort((a, b) => a - b);
  const q = (arr) => (t) => arr[Math.floor(arr.length * t)].toFixed(3);
  say(`density   ${all.length} cells carry weight, ${held.length} hold a splat`);
  say(`          carrying deciles ${[0.1, 0.5, 0.9].map(q(all)).join(' ')}, holding deciles ${[0.1, 0.5, 0.9].map(q(held)).join(' ')}`);
}
let shellCells = 0;
for (let i = 0; i < f.length; i++) if (f[i] > iso) shellCells++;
say(`cut       ${shellCells} cells above ${iso.toFixed(2)} (${ISO} of ${interior.toFixed(2)}, the median where a splat sits)`);

// The bite is set in units of the surface level, so it is one number that means
// the same thing on any scan: 1.5 is "a cell and a half of real surface".
//
// Union with the cut, not just the bracket. Where a flank was sampled thinly the
// ray has to travel further before it has eaten a whole bite, and the entry
// point lands under the surface — which puts a dimple in the model exactly where
// the scan was weakest. Every cell above the surface level is measured surface
// by definition, so no bracket is allowed to carve one away.
const crossed = bracket(f, dim, iso * BITE, AGREE);
for (let i = 0; i < f.length; i++) if (f[i] > iso) crossed[i] = 1;
let bracketCells = 0;
for (let i = 0; i < crossed.length; i++) bracketCells += crossed[i];
const bracketed = solidify(crossed, dim);
const solid = despeckle(CLOSE ? close(bracketed.solid, dim, CLOSE) : bracketed.solid, dim, DESPECKLE);
let filled = 0;
for (let i = 0; i < solid.length; i++) filled += solid[i];
say(`solid     ${filled} cells, bracketed up from a ${shellCells}-cell shell to ${bracketCells}, largest blob ${bracketed.filled} of ${bracketed.blobs}`);

// Blur the 0/1 solid before contouring. Surface nets interpolates along each
// edge, so a hard 0/1 field gives it nothing to interpolate and the result is
// stair-stepped; two box passes are enough to hand it a real gradient.
let field = Float32Array.from(solid);
for (let pass = 0; pass < 2; pass++) {
  const next = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) {
    let s = field[i]; let n = 1;
    for (const j of neighbors6(i, dim[0], dim[1], dim[2])) { s += field[j]; n++; }
    next[i] = s / n;
  }
  field = next;
}

let mesh = surfaceNets(field, dim, lo, cell, 0.5);
say(`contour   ${mesh.verts.length / 3} vertices, ${mesh.faces.length / 3} triangles`);
if (!mesh.faces.length) throw new Error('the isosurface came back empty');

mesh = smooth(mesh, SMOOTH);
const dec = decimate(mesh, TRIS);
say(`decimate  ${dec.faces.length / 3} triangles after ${dec.collapses} collapses`);
mesh = dec;

const name = outPath.split('/').pop().replace(/\.glb$/i, '');
let glb;
if (VCOLOR) {
  // Sampled at the scale the SPLATS sit at, not at the scale the grid does.
  // The grid is coarse on purpose — a fine one tears the reconstruction apart —
  // but color has no such constraint, and averaging it over a grid cell throws
  // away whatever the capture did resolve.
  //
  // Not that it resolves much. Measured on the pig: with this sampler, a mesh at
  // 4,000 triangles and the same mesh subdivided to 64,000 render
  // indistinguishably. The splats near any surface point come from a fuzz band
  // several millimetres deep and averaging across it erases anything finer, so
  // there is no more color detail down there to go and get.
  const { colors: vcol, normals } = vertexColors(mesh, makeColorSampler(p, Math.max(spacing, cell * 0.35)));
  orient(mesh.verts, UP, YAW);
  // The normals turn with the mesh — they are directions in the same frame, and
  // a model lit from a rig that thinks it is still on its side is a subtle,
  // maddening bug to find later.
  orient(normals, UP, YAW);
  say(`color     ${mesh.verts.length / 3} vertex colors sampled from the cloud`);
  glb = buildVertexColorGlb(mesh, vcol, normals, name);
} else {
  const { group, colors } = colorize(mesh, p, COLORS, cell);
  say(`color     ${colors.length} group(s): ${colors.map((c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')).join(' ')}`);
  orient(mesh.verts, UP, YAW);
  glb = buildGlb(mesh, group, colors, name);
}
writeFileSync(outPath, glb);
say(`wrote     ${outPath}  ${(glb.length / 1024).toFixed(1)}KB, ${mesh.faces.length / 3} triangles${VCOLOR ? ', vertex colors' : ''}`);
if (report) say(`          ${((Date.now() - t0) / 1000).toFixed(1)}s`);
