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
// PRIOR ART, since the question comes up and the answer is not "nothing".
// Surveyed 2026-08-18, which is after this was written rather than before it.
//
// The best reconstructors - SuGaR, 2DGS, Gaussian Opacity Fields - cannot be
// used here at all, and not for a licensing reason. They are training-time
// methods: they want the original photographs and the camera poses, and they
// recover the surface as part of fitting the scene. A finished .spz off a phone
// is the wrong input to them, and it is the only input this has.
//
// The tools that DO take a standalone splat file agree on an approach, and it is
// the one bracket() argues against: build a density field, threshold it, march
// cubes over it, accept the blob. Polyvia3D does exactly that, free, in a
// browser, and says plainly that the result is soft. 3DGS-to-PC does it at the
// command line and its own authors call the meshing "quite naive, which can lead
// to noisy results". Open3D or MeshLab with screened Poisson gets there too,
// given surface normals you have to estimate yourself first.
//
// PlayCanvas splat-transform is worth naming because it looks like this tool and
// is not: its GLB is splat data in a KHR_gaussian_splatting container, and it
// does no surface reconstruction of any kind.
//
// What none of them produce is what the deck needs - a few hundred to a few
// thousand triangles, flat-shaded, in flat color groups, at 8-30KB. They hand
// back either a dense marching-cubes surface or a splat file, so the distance
// from their output to a model that can stand next to sixty Kenney props is a
// decimation stage, a color-clustering stage and a writer, which is most of what
// is below.
//
// None of the PARTS are new and none should be claimed as such: visual hull is
// Laurentini 1994, surface nets is Gibson 1998, Taubin 1995, quadric error
// metrics is Garland & Heckbert 1997, and wrap.js is a cousin of CGAL's alpha
// wrapping. What is here is the combination, the output target, and the numbers.
//
// The Splat Editor's cleaning half has a direct equivalent in SuperSplat
// (PlayCanvas, MIT, in the browser, GPU brush and lasso selection with unlimited
// undo), which is the standard tool for this and does that part better. What it
// does not do is build the mesh in the page or preview it under the gallery's
// own lights, which is the reason ours exists.
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
//   --isolation N   drop splats with fewer than N neighbors nearby           (default 6)
//   --isolation-mm F  what 'nearby' means. Default: 3x the scan's own spacing
//   --min-lum F     drop splats darker than this, for a pale subject in a dark room
//   --iso    F      surface level, as a fraction of the density where a splat sits (default 0.5)
//   --bite   F      density a ray passes before it counts as inside, in isos (default 1.5)
//   --agree  N      how many of the three axes must bracket a cell, 0-3 (default 2)
//   --hull   N      trace the outline from N directions and keep what is inside all of them
//   --outline N     the MOST closing a view may use; each picks its own (default 10)
//   --handed -1     wind the direction spiral the other way (same spread, other set)
//   --both          also trace from the opposite of every direction
//   --consensus F   share of views a cell must be inside, 0.5-1 (default 1, strict)
//   --sweep  DEG    trace by turning the model DEG at a time about x, then y, then z,
//                   instead of spreading --hull directions over a hemisphere
//   --trace-out F   write every traced outline to F as JSON, to look at
//   --trace-glb F   write ONE file holding the cloud and every outline together
//   --rings  0|1    walk the outline as real edge points, not pixels (default 1)
//   --carve  N      then bracket again from N directions spread over a hemisphere
//   --agreement F   the share of those directions a cell must survive (default 0.94)
//   --despeckle N   majority-vote passes over the solid                (default 2)
//   --close  N      fill hollows up to 2N cells wide, where the scan saw nothing (default 2)
//   --smooth N      Taubin smoothing passes                           (default 12)
//   --surface S     'fit' (default) fits a function through the points; 'hull' brackets a volume
//   --fit    MM     the fit's averaging radius, in mm. Defaults to 1.5x the fuzz band
//   --vertex-color  keep the scan's own color, one per vertex, smooth-shaded
//   --report        print the density distribution and the elapsed time
//   --check         grade the capture and stop: sampling, precision, fuzz band,
//                   and whether the orbit missed an arc. Converts nothing, so two
//                   scans of the same object can be compared before either is built.

import { readFileSync, writeFileSync } from 'node:fs';
// The pipeline itself lives with the editor, because the editor runs it too and
// a second copy would drift. See that file's header.
import {
  cull as cullCloud, spacingOf, density, neighbors6, despeckle,
  outlineOf, traceRing, fillPolygon, pointRing, spiralDirections,
  withAntipodes, axisSweep, distinctDirections, silhouetteHull as hullOf,
  surfaceNets, smooth, decimate, makeColorSampler, colorize, orient,
} from '../public/apps/splat-editor/build.js';
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
// The radius that counts as 'near', in mm. 0 measures it from the scan itself.
const ISO_RADIUS = Math.max(0, num('isolation-mm', 0)) / 1000;
// Drop splats darker than this. Off by default, and deliberately not clever: it
// is here because background haze in a splat scan is usually the unlit room and
// the subject usually is not, which is a fact about a particular capture and not
// about scans in general. On a dark object it would eat the object. Use it when
// a preview shows the haze is dark and the subject is not, and check the result.
const MIN_LUM = num('min-lum', 0);
const ISO = num('iso', 0.5);
const BITE = num('bite', 1.5);
const AGREE = Math.min(3, Math.max(0, Math.round(num('agree', 2))));
const DESPECKLE = Math.max(0, Math.round(num('despeckle', 2)));
const CLOSE = Math.max(0, Math.round(num('close', 2)));
const SMOOTH = Math.max(0, Math.round(num('smooth', 12)));
// The other half of what a scan measured. Off by default because Object Tile
// Scroll deletes every attribute but position and normal on arrival — the deck
// decides what an object is made of — so this is for a viewer that wants to show
// the thing as it was captured rather than as the piece dresses it.
const VCOLOR = argv.includes('--vertex-color');
// 'fit' fits a smooth function through the splats and takes its zero level set;
// 'hull' brackets a volume around them. The fit resolves detail the hull cannot,
// because its smoothing radius is independent of the grid.
const SURFACE = opt('surface', 'hull');
// How far the fit averages over, in millimetres. Below the scan's fuzz band it
// starts following noise; far above it, it rounds off what the capture resolved.
const FIT = num('fit', 0);
// How wide the density kernel is, in millimetres. This is the other half of
// "smooth at one scale, sample at another": raise it and the shell stays
// continuous on a grid fine enough to resolve an ear, where the default ties it
// to the cell and a fine grid tears the shell into holes.
const BLUR = num('blur', 0);
// Divide the density by a heavily smoothed copy of itself before taking a level
// set. The point is measured: coverage across this pig runs from 2 to 30 splats
// per square centimetre, a factor of fifteen, so a single global threshold is
// wrong nearly everywhere at once — it cuts holes through the thinly-covered
// parts and fattens the well-covered ones. Dividing by the local average asks
// "is this cell dense FOR HERE", which is the same question everywhere.
const NORMALIZE = argv.includes('--normalize');
// How many directions the carve brackets from. 0 leaves the three axes alone.
const CARVE = Math.max(0, Math.round(num('carve', 0)));
// How many outlines to trace. 0 uses the bracket instead.
const HULL = Math.max(0, Math.round(num('hull', 0)));
// How far to close the outline before filling it, in pixels. The points are a
// scatter and not a stroke, so some closing is always needed or the fill leaks.
const OUTLINE = Math.max(1, Math.round(num('outline', 10)));
// Turn-the-model-by-DEG sampling, instead of the spiral. 0 leaves the spiral on.
const SWEEP = Math.max(0, num('sweep', 0));
// Which way the spiral winds, and whether each direction's opposite is added.
const HANDED = num('handed', 1) < 0 ? -1 : 1;
const BOTH = argv.includes('--both');
// The share of views a cell must be inside. 1 is the strict intersection.
const CONSENSUS = Math.min(1, Math.max(0.5, num('consensus', 1)));
// Where to write the traced outlines, for looking at.
const TRACE_OUT = opt('trace-out');
// And where to write the cloud and the outlines as one file.
const TRACE_GLB = opt('trace-glb');
// Whether the outline is a ring of real edge points or a ring of pixels. See
// the long note over pointRing().
const RINGS = num('rings', 1) !== 0;
// A cell has to survive this share of them. Not all of them: one direction that
// happens to look down a thinly covered patch would otherwise punch a hole
// straight through the model.
const AGREEMENT = num('agreement', 0.94);
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


/**
 * How far the reconstructed surface departs from a smooth body.
 *
 * The top of the solid, with a quadratic fitted out so the object's own taper
 * and whatever angle it was lying at do not count as defects, leaving only what
 * is locally proud or sunken. A hollow several times the fuzz band is geometry
 * the capture never saw.
 *
 * Measured on the SOLID rather than on the input, because that is the thing
 * anybody will look at, and because every input-side proxy for it turned out to
 * be fragile in a way this is not.
 */
function surfaceRelief(solidVol, dim, cell) {
  const [nx, ny, nz] = dim;
  const h = [];
  const at = [];
  for (let c = 0; c < nz; c++) {
    for (let b = 0; b < ny; b++) {
      let top = -1;
      for (let a = 0; a < nx; a++) {
        if (solidVol[(c * ny + b) * nx + a]) { top = a; break; }
      }
      if (top >= 0) { h.push(top); at.push([b, c]); }
    }
  }
  if (h.length < 40) return { p95: 0, p99: 0 };
  // Least squares on 1, b, c, b^2, c^2, bc — six unknowns, normal equations.
  const M = Array.from({ length: 6 }, () => new Float64Array(6));
  const rhs = new Float64Array(6);
  for (let i = 0; i < h.length; i++) {
    const [b, c] = at[i];
    const row = [1, b, c, b * b, c * c, b * c];
    for (let j = 0; j < 6; j++) {
      rhs[j] += row[j] * h[i];
      for (let k = 0; k < 6; k++) M[j][k] += row[j] * row[k];
    }
  }
  for (let col = 0; col < 6; col++) {
    let piv = col;
    for (let r = col + 1; r < 6; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return { p95: 0, p99: 0 };
    [M[col], M[piv]] = [M[piv], M[col]];
    const t = rhs[col]; rhs[col] = rhs[piv]; rhs[piv] = t;
    for (let r = 0; r < 6; r++) {
      if (r === col) continue;
      const f2 = M[r][col] / M[col][col];
      for (let k = col; k < 6; k++) M[r][k] -= f2 * M[col][k];
      rhs[r] -= f2 * rhs[col];
    }
  }
  const co = Array.from({ length: 6 }, (_, i) => rhs[i] / M[i][i]);
  const res = h.map((v, i) => {
    const [b, c] = at[i];
    return v - (co[0] + co[1] * b + co[2] * c + co[3] * b * b + co[4] * c * c + co[5] * b * c);
  }).sort((a, b2) => a - b2);
  const q = (t) => res[Math.floor(res.length * t)] * cell;
  return { p95: q(0.95), p99: q(0.99) };
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











// ------------------------------------------------------------------ the carve
// The same bracket as above, but from a hundred directions instead of three.
//
// This is here because of where the information in a splat scan actually lives.
// Locally the cloud is not a surface at all — its neighbourhoods measure 0.13 to
// 0.16 on the planarity scale where 0 is a plane and 0.33 is a shapeless ball,
// at every radius, never improving as you zoom in. So every method that asks a
// neighbourhood which way the surface faces gets noise back, and normals,
// ball-pivoting and moving least squares all fail for that one reason.
//
// In PROJECTION the same data is well behaved. Thousands of points overlap along
// each ray, so a silhouette is sharp even where no local neighbourhood is. That
// is why the eye can see an ear the reconstruction cannot: it is looking at an
// integral, not at a surface. The three-axis bracket already exploits this and
// is the reason it beat everything else; it was simply only asking three
// questions.
//
// Each direction brackets its own entry and exit depth per pixel, which is more
// than a silhouette carve: a dent that faces the ray is kept, where a silhouette
// would fill it in. A cell has to survive nearly all the directions, with a
// small allowance so that one bad angle cannot punch a hole through the model.
//
// It only ever removes, so it cannot invent anything the bracket did not already
// support, and it starts from the bracket's own result rather than from the
// whole grid — a few tens of thousands of live cells instead of a million, which
// is what makes a hundred directions affordable.
function carveFromDirections(solidVol, dim, lo, cell, p, count, tol, keepFrac) {
  const [nx, ny, nz] = dim;
  const live = [];
  for (let i = 0; i < solidVol.length; i++) if (solidVol[i]) live.push(i);
  if (!live.length) return { solid: solidVol, killed: 0 };

  // Centres of the live cells, once.
  const cx = new Float64Array(live.length);
  const cy = new Float64Array(live.length);
  const cz = new Float64Array(live.length);
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    const a = i % nx;
    const b = Math.floor(i / nx) % ny;
    const c = Math.floor(i / (nx * ny));
    cx[k] = lo[0] + a * cell;
    cy[k] = lo[1] + b * cell;
    cz[k] = lo[2] + c * cell;
  }
  const against = new Uint16Array(live.length);

  // Directions spread evenly over a hemisphere — a whole sphere would be waste,
  // since a ray and its opposite bracket exactly the same interval.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (let d = 0; d < count; d++) {
    const z = (d + 0.5) / count;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = d * GOLDEN;
    const dir = [r * Math.cos(th), r * Math.sin(th), z];
    // Any two vectors perpendicular to it will do for the image plane.
    let u = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const dot = u[0] * dir[0] + u[1] * dir[1] + u[2] * dir[2];
    u = [u[0] - dir[0] * dot, u[1] - dir[1] * dot, u[2] - dir[2] * dot];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v = [
      dir[1] * u[2] - dir[2] * u[1],
      dir[2] * u[0] - dir[0] * u[2],
      dir[0] * u[1] - dir[1] * u[0],
    ];

    // The depth range of the points behind every pixel of this view.
    let au = Infinity; let bu = -Infinity; let av = Infinity; let bv = -Infinity;
    for (let i = 0; i < p.n; i++) {
      const su = p.x[i] * u[0] + p.y[i] * u[1] + p.z[i] * u[2];
      const sv = p.x[i] * v[0] + p.y[i] * v[1] + p.z[i] * v[2];
      if (su < au) au = su;
      if (su > bu) bu = su;
      if (sv < av) av = sv;
      if (sv > bv) bv = sv;
    }
    const w = Math.ceil((bu - au) / cell) + 3;
    const h = Math.ceil((bv - av) / cell) + 3;
    const tmin = new Float32Array(w * h).fill(Infinity);
    const tmax = new Float32Array(w * h).fill(-Infinity);
    for (let i = 0; i < p.n; i++) {
      const su = p.x[i] * u[0] + p.y[i] * u[1] + p.z[i] * u[2];
      const sv = p.x[i] * v[0] + p.y[i] * v[1] + p.z[i] * v[2];
      const st = p.x[i] * dir[0] + p.y[i] * dir[1] + p.z[i] * dir[2];
      const px = Math.round((su - au) / cell) + 1;
      const py = Math.round((sv - av) / cell) + 1;
      // Into the neighbouring pixels too. A single-pixel stamp leaves gaps
      // between samples that carve stripes through the model.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const qx = px + dx; const qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const at = qy * w + qx;
          if (st < tmin[at]) tmin[at] = st;
          if (st > tmax[at]) tmax[at] = st;
        }
      }
    }

    for (let k = 0; k < live.length; k++) {
      const su = cx[k] * u[0] + cy[k] * u[1] + cz[k] * u[2];
      const sv = cx[k] * v[0] + cy[k] * v[1] + cz[k] * v[2];
      const st = cx[k] * dir[0] + cy[k] * dir[1] + cz[k] * dir[2];
      const px = Math.round((su - au) / cell) + 1;
      const py = Math.round((sv - av) / cell) + 1;
      if (px < 0 || py < 0 || px >= w || py >= h) { against[k]++; continue; }
      const at = py * w + px;
      if (tmin[at] === Infinity || st < tmin[at] - tol || st > tmax[at] + tol) against[k]++;
    }
  }

  const allow = Math.floor(count * (1 - keepFrac));
  const out = new Uint8Array(solidVol.length);
  let killed = 0;
  for (let k = 0; k < live.length; k++) {
    if (against[k] <= allow) out[live[k]] = 1;
    else killed++;
  }
  return { solid: out, killed };
}

// -------------------------------------------------------------------- the fit
// Fitting a surface THROUGH the points rather than carving a volume around them.
//
// The bracket above answers "which cells are inside", and its accuracy is capped
// by the cell size — which cannot be reduced, because a fine grid on a porous
// shell tears the reconstruction into disconnected lumps. Measured: grid 52
// holds together, grid 128 falls apart. So detail the capture genuinely resolved
// — the curl of an ear, about 6mm across — is lost to a 3.9mm cell, and no
// amount of triangles gets it back.
//
// This lifts that cap. Instead of thresholding a density, fit a smooth function
// whose zero level set IS the surface, and take the isosurface of that. The
// smoothing then comes from the RADIUS OF THE FIT rather than from the size of a
// cell, and those two are suddenly independent: average over 3mm of noise while
// sampling on a 1.5mm grid. That is the whole trick, and it is why this can
// follow a curve the bracket has to flatten.
//
// The function is implicit moving least squares: at any point in space, the
// weighted average of the signed distances to the tangent planes of the splats
// nearby. Near a well-sampled surface those planes agree and the average is a
// clean signed distance; in the fuzz they disagree and the average lands in the
// middle of the band, which is exactly the right answer.

/** Unit eigenvector for the smallest eigenvalue of a symmetric 3x3. */
function smallestAxis(a11, a12, a13, a22, a23, a33) {
  const lam = eigen3(a11, a12, a13, a22, a23, a33)[0];
  // Rows of (A - lambda I). The null space is the eigenvector, and the cross
  // product of any two independent rows lies in it.
  const r = [
    [a11 - lam, a12, a13],
    [a12, a22 - lam, a23],
    [a13, a23, a33 - lam],
  ];
  let best = [0, 0, 1];
  let bestLen = 0;
  for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) {
    const c = [
      r[p][1] * r[q][2] - r[p][2] * r[q][1],
      r[p][2] * r[q][0] - r[p][0] * r[q][2],
      r[p][0] * r[q][1] - r[p][1] * r[q][0],
    ];
    const l = Math.hypot(c[0], c[1], c[2]);
    if (l > bestLen) { bestLen = l; best = c; }
  }
  if (bestLen < 1e-20) return [0, 0, 1];
  return best.map((v) => v / bestLen);
}

/**
 * A normal for every splat, pointing out.
 *
 * The direction comes from a plane fitted to each splat's neighbourhood, which
 * gives an axis but no sign — a plane has two sides and PCA has no opinion about
 * which is out. Orienting a whole cloud consistently is the classical hard part
 * of this, usually done by propagating agreement across a spanning tree.
 *
 * There is no need for any of that here, because the bracket has already worked
 * out which cells are inside. So the sign is simply read off the solid: step a
 * little each way and take the direction that leaves it. An answer that is free
 * because of a step that had to happen anyway.
 */
function pointNormals(p, solidVol, dim, lo, cell, radius) {
  const [nx, ny, nz] = dim;
  const h = radius;
  const bins = new Map();
  const key = (a, b, c) => `${a},${b},${c}`;
  for (let i = 0; i < p.n; i++) {
    const k = key(Math.floor(p.x[i] / h), Math.floor(p.y[i] / h), Math.floor(p.z[i] / h));
    let bin = bins.get(k);
    if (!bin) { bin = []; bins.set(k, bin); }
    bin.push(i);
  }
  const inside = (x, y, z) => {
    const a = Math.round((x - lo[0]) / cell);
    const b = Math.round((y - lo[1]) / cell);
    const c = Math.round((z - lo[2]) / cell);
    if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) return 0;
    return solidVol[(c * ny + b) * nx + a];
  };

  const nrm = new Float64Array(p.n * 3);
  const r2 = radius * radius;
  let flat = 0;
  for (let i = 0; i < p.n; i++) {
    const bx = Math.floor(p.x[i] / h); const by = Math.floor(p.y[i] / h); const bz = Math.floor(p.z[i] / h);
    let n = 0; let sx = 0; let sy = 0; let sz = 0;
    const near = [];
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const bin = bins.get(key(bx + a, by + b, bz + c));
          if (!bin) continue;
          for (const j of bin) {
            const d2 = (p.x[j] - p.x[i]) ** 2 + (p.y[j] - p.y[i]) ** 2 + (p.z[j] - p.z[i]) ** 2;
            if (d2 > r2) continue;
            near.push(j); sx += p.x[j]; sy += p.y[j]; sz += p.z[j]; n++;
          }
        }
      }
    }
    let v = [0, 0, 1];
    if (n >= 6) {
      sx /= n; sy /= n; sz /= n;
      let c11 = 0; let c12 = 0; let c13 = 0; let c22 = 0; let c23 = 0; let c33 = 0;
      for (const j of near) {
        const dx = p.x[j] - sx; const dy = p.y[j] - sy; const dz = p.z[j] - sz;
        c11 += dx * dx; c12 += dx * dy; c13 += dx * dz;
        c22 += dy * dy; c23 += dy * dz; c33 += dz * dz;
      }
      v = smallestAxis(c11 / n, c12 / n, c13 / n, c22 / n, c23 / n, c33 / n);
    } else {
      flat++;
    }
    // Which way is out, asked of the solid rather than propagated.
    const step = cell * 1.5;
    const outAt = inside(p.x[i] + v[0] * step, p.y[i] + v[1] * step, p.z[i] + v[2] * step);
    const inAt = inside(p.x[i] - v[0] * step, p.y[i] - v[1] * step, p.z[i] - v[2] * step);
    const sign = outAt === inAt ? 1 : (outAt ? -1 : 1);
    nrm[i * 3] = v[0] * sign; nrm[i * 3 + 1] = v[1] * sign; nrm[i * 3 + 2] = v[2] * sign;
  }
  return { nrm, flat };
}

/**
 * The IMLS field, evaluated only where it can matter.
 *
 * Away from the points the answer is never in doubt, so those nodes are seeded
 * from the bracket's own solid and never touched. Only the band around the data
 * gets the weighted sum, which is what keeps this affordable on a grid fine
 * enough to be worth having.
 */
function imlsField(p, nrm, solidVol, dim, lo, cell, radius) {
  const [nx, ny, nz] = dim;
  const f = new Float32Array(nx * ny * nz);
  // Far from anything, the sign is all that matters and the bracket knows it.
  for (let i = 0; i < f.length; i++) f[i] = solidVol[i] ? -radius : radius;

  const reach = Math.ceil((radius * 2.5) / cell);
  const inv = -1 / (radius * radius);
  const num = new Float64Array(f.length);
  const den = new Float64Array(f.length);
  for (let i = 0; i < p.n; i++) {
    const gx = (p.x[i] - lo[0]) / cell;
    const gy = (p.y[i] - lo[1]) / cell;
    const gz = (p.z[i] - lo[2]) / cell;
    const cx = Math.round(gx); const cy = Math.round(gy); const cz = Math.round(gz);
    const nxi = nrm[i * 3]; const nyi = nrm[i * 3 + 1]; const nzi = nrm[i * 3 + 2];
    for (let a = cx - reach; a <= cx + reach; a++) {
      if (a < 0 || a >= nx) continue;
      const dx = (a - gx) * cell;
      for (let b = cy - reach; b <= cy + reach; b++) {
        if (b < 0 || b >= ny) continue;
        const dy = (b - gy) * cell;
        for (let c = cz - reach; c <= cz + reach; c++) {
          if (c < 0 || c >= nz) continue;
          const dz = (c - gz) * cell;
          const d2 = dx * dx + dy * dy + dz * dz;
          const w = p.w[i] * Math.exp(d2 * inv);
          if (w < 1e-4) continue;
          const at = (c * ny + b) * nx + a;
          // Signed distance to this splat's tangent plane.
          num[at] += w * (dx * nxi + dy * nyi + dz * nzi);
          den[at] += w;
        }
      }
    }
  }
  let touched = 0;
  for (let i = 0; i < f.length; i++) {
    if (den[i] > 1e-6) { f[i] = num[i] / den[i]; touched++; }
  }
  return { f, touched };
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
 * One file holding the cloud and every outline drawn on it.
 *
 * A POINTS primitive for the scan, in its own colors, and a LINE_STRIP per
 * traced ring, closed by repeating its first vertex. Both are real glTF
 * primitive modes, so this opens in any viewer that reads a GLB rather than
 * needing the editor — the point of it is being able to check the outlines
 * against the points they were drawn from anywhere, in one drag.
 *
 * The cloud is thinned to keep the file openable. Outlines never are: they are
 * the thing being looked at, and a decimated one would be a different outline.
 */
function buildTraceGlb(p, ringsByView, meta = [], budget = 150000) {
  const bin = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
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
  const addVec3 = (list) => {
    const buf = Buffer.alloc(list.length * 12);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let at = 0;
    for (const v of list) {
      for (let c = 0; c < 3; c++) {
        buf.writeFloatLE(v[c], at); at += 4;
        if (v[c] < min[c]) min[c] = v[c];
        if (v[c] > max[c]) max[c] = v[c];
      }
    }
    accessors.push({ bufferView: addView(buf), componentType: 5126, count: list.length, type: 'VEC3', min, max });
    return accessors.length - 1;
  };

  const step = Math.max(1, Math.ceil(p.n / budget));
  const pos = [];
  const col = [];
  for (let i = 0; i < p.n; i += step) {
    pos.push([p.x[i], p.y[i], p.z[i]]);
    col.push(p.rgb[i * 3], p.rgb[i * 3 + 1], p.rgb[i * 3 + 2], 1);
  }
  const posAcc = addVec3(pos);
  const colBuf = Buffer.alloc(col.length * 4);
  for (let i = 0; i < col.length; i++) colBuf.writeFloatLE(col[i], i * 4);
  accessors.push({ bufferView: addView(colBuf), componentType: 5126, count: pos.length, type: 'VEC4' });
  materials.push({ name: 'cloud', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } });
  meshes.push({
    name: 'cloud',
    primitives: [{ mode: 0, attributes: { POSITION: posAcc, COLOR_0: accessors.length - 1 }, material: 0 }],
  });
  nodes.push({ mesh: 0, name: `cloud (${pos.length} of ${p.n} points)` });

  materials.push({
    name: 'outline',
    pbrMetallicRoughness: { baseColorFactor: [0.35, 0.95, 0.7, 1], metallicFactor: 0, roughnessFactor: 1 },
    emissiveFactor: [0.35, 0.95, 0.7],
  });
  ringsByView.forEach((view, d) => {
    const prims = [];
    for (const ring of view) {
      if (ring.length < 3) continue;
      const verts = ring.map((i) => [p.x[i], p.y[i], p.z[i]]);
      verts.push(verts[0]); // LINE_STRIP, closed by hand
      prims.push({ mode: 3, attributes: { POSITION: addVec3(verts) }, material: 1 });
    }
    if (!prims.length) return;
    const label = `outline_${String(d).padStart(2, '0')}`;
    meshes.push({ name: label, primitives: prims });
    // glTF extras: how this outline was drawn, carried with it. A viewer that
    // does not care ignores them; the editor uses them to aim the camera down
    // the direction this one was traced from, which is the only angle at which
    // an outline looks like an outline.
    nodes.push({ mesh: meshes.length - 1, name: label, extras: meta[d] || {} });
  });

  const binBuf = Buffer.concat(bin);
  const json = {
    asset: { version: '2.0', generator: 'splat2glb.mjs --trace-glb' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
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

const p = cullCloud(pts, {
  grid: GRID, minOpacity: MIN_OPACITY, minLum: MIN_LUM, crop: CROP,
  isolation: ISOLATION, isolationRadius: ISO_RADIUS,
});
const isoRadius = p.isolationRadius;
say(`cull      ${p.n} kept (opacity >= ${MIN_OPACITY}${MIN_LUM ? `, brightness >= ${MIN_LUM}` : ''}, >= ${ISOLATION} neighbors within ${(isoRadius * 1000).toFixed(2)}mm)`);

const span = [p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]];
const cell = Math.max(...span) / GRID;
const spacing = spacingOf(p, cell * 2);
say(`sample    splats sit ${(spacing * 1000).toFixed(2)}mm apart, median`);


// Air all round, so the flood fill always has an outside to start from and the
// surface never runs into the wall of the grid. Wide enough to hold the widest
// splat footprint plus the closing radius, or the object welds itself to the
// grid wall and the fill has nowhere to begin.
const PAD = REACH + 1;
const lo = p.lo.map((v) => v - PAD * cell);
const dim = span.map((s) => Math.ceil(s / cell) + 2 * PAD + 1);
say(`grid      ${dim.join('x')} cells at ${(cell * 1000).toFixed(2)}mm`);

const { f, support } = density(p, dim, lo, cell, BLUR > 0 ? BLUR / 1000 : spacing * 0.7);

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
// --agree 0 skips the bracket entirely and lets the flood fill do the work on
// the level set alone. That is only possible when the kernel is wide enough to
// close the shell's pinholes by itself — raise --blur and it becomes the better
// route, because every threshold the bracket needs was tuned against a coarse
// grid and none of them survive a fine one.
let crossed;
if (AGREE === 0) {
  crossed = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) if (f[i] > iso) crossed[i] = 1;
} else {
  crossed = bracket(f, dim, iso * BITE, AGREE);
  for (let i = 0; i < f.length; i++) if (f[i] > iso) crossed[i] = 1;
}
let bracketCells = 0;
for (let i = 0; i < crossed.length; i++) bracketCells += crossed[i];
const bracketed = solidify(crossed, dim);
let solid = despeckle(CLOSE ? close(bracketed.solid, dim, CLOSE) : bracketed.solid, dim, DESPECKLE);
if (HULL > 0) {
  const traces = TRACE_OUT ? [] : null;
  const hull = await hullOf(p, dim, lo, cell, HULL, OUTLINE, traces, RINGS, SWEEP, CONSENSUS, HANDED, BOTH);
  if (TRACE_OUT) {
    writeFileSync(TRACE_OUT, JSON.stringify({
      object: inPath.split('/').pop(),
      cell, views: traces.length, radii: hull.radii,
      traces,
    }));
    say(`traces    ${traces.length} outlines written to ${TRACE_OUT}`);
  }
  if (TRACE_GLB) {
    writeFileSync(TRACE_GLB, buildTraceGlb(p, hull.rings, hull.meta));
    let verts = 0;
    for (const view of hull.rings) for (const r of view) verts += r.length;
    say(`combined  ${TRACE_GLB}: the cloud and ${verts} outline vertices in one file`);
  }
  // Undo the closing the outlines were given — nothing at all on the ring path,
  // where the outline was never fattened in the first place. On the raster path,
  // the median: each view chose its own and the intersection is not owed any
  // single one of them, which is exactly why that path came out too thin.
  let cut = hull.solid;
  for (let r = 0; r < hull.erode; r++) {
    const next = cut.slice();
    for (let i = 0; i < cut.length; i++) {
      if (cut[i]) continue;
      for (const j of neighbors6(i, dim[0], dim[1], dim[2])) next[j] = 0;
    }
    cut = next;
  }
  cut = despeckle(cut, dim, 1);
  // Largest piece. An outlier the eraser missed defines its own little silhouette
  // in every view and leaves a satellite floating beside the pig.
  const label = new Int32Array(cut.length).fill(-1);
  let best = -1; let bestSize = 0; let pieces = 0;
  for (let s0 = 0; s0 < cut.length; s0++) {
    if (!cut[s0] || label[s0] >= 0) continue;
    const id = pieces++;
    let size = 0;
    const q = [s0];
    label[s0] = id;
    while (q.length) {
      const i = q.pop();
      size++;
      for (const j of neighbors6(i, dim[0], dim[1], dim[2])) {
        if (cut[j] && label[j] < 0) { label[j] = id; q.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  for (let i = 0; i < cut.length; i++) if (label[i] !== best) cut[i] = 0;
  solid = cut;
  say(`hull      ${hull.views} outlines (${hull.distinct} distinct directions), ${hull.kept} cells inside `
    + (hull.budget ? `all but ${hull.budget} of them` : 'all of them'));
  say(`          closing needed: ${hull.radii[0]} to ${hull.radii[hull.radii.length - 1]} px, median ${hull.median}`
    + (RINGS ? ' (scaffolding only, eroded 0)' : `, eroded ${hull.erode}`));
  say(`          ${bestSize} in the largest piece, of ${pieces}`);
}
let filled = 0;
for (let i = 0; i < solid.length; i++) filled += solid[i];
say(`solid     ${filled} cells, bracketed up from a ${shellCells}-cell shell to ${bracketCells}, largest blob ${bracketed.filled} of ${bracketed.blobs}`);

if (CARVE > 0) {
  const tol = Math.max(cell, spacing * 1.5);
  const before = filled;
  const carved = carveFromDirections(solid, dim, lo, cell, p, CARVE, tol, AGREEMENT);
  let cut = carved.solid;
  // Despeckle again: the carve leaves a rind of single cells wherever two
  // directions disagreed by one, and those become spikes on the isosurface.
  cut = despeckle(cut, dim, 1);
  // Largest piece only. A carve this aggressive can shave a leg into an island.
  {
    const label = new Int32Array(cut.length).fill(-1);
    let best = -1; let bestSize = 0; let next = 0;
    for (let s0 = 0; s0 < cut.length; s0++) {
      if (!cut[s0] || label[s0] >= 0) continue;
      const id = next++;
      let size = 0;
      const q = [s0];
      label[s0] = id;
      while (q.length) {
        const i = q.pop();
        size++;
        for (const j of neighbors6(i, dim[0], dim[1], dim[2])) {
          if (cut[j] && label[j] < 0) { label[j] = id; q.push(j); }
        }
      }
      if (size > bestSize) { bestSize = size; best = id; }
    }
    for (let i = 0; i < cut.length; i++) if (label[i] !== best) cut[i] = 0;
    solid.set(cut);
    filled = bestSize;
  }
  say(`carve     ${CARVE} directions took ${before - filled} cells off, ${filled} left`);
}

const relief = surfaceRelief(solid, dim, cell);
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
    const dir = cov.dirOf(cov.bins.indexOf(worst)).map((v) => v.toFixed(2)).join(',');
    say(`          thinnest ${worst.perCm2.toFixed(0)}/cm², toward ${dir} in the scan's own axes`);
  }
  // Deliberately no verdict from this number. The sectors are cut about an axis
  // fitted to the cloud, and that axis MOVES when the cloud is edited: erasing
  // haze off this scan rotated it enough to smear a real gap across neighbouring
  // sectors and the coverage test went quiet, while the reconstruction it was
  // supposed to be predicting had not changed by a tenth of a millimetre. So the
  // verdict comes from the surface that actually gets built, below.
  say(`relief    ${mm(relief.p95)} at the 95th percentile, ${mm(relief.p99)} at the 99th`);
  say(`          how far the reconstructed surface departs from a smooth body, once`);
  say(`          the object's own taper is fitted out. This is the measurement that`);
  say(`          matters: it is what the model will actually look like.`);
  if (relief.p95 > fuzz * 3) {
    say(`          THAT IS A DENT, and ${(relief.p95 / fuzz).toFixed(1)}x the fuzz band, so it is not noise.`);
    say(`          A hollow this size is geometry the capture never saw. Erasing cannot`);
    say(`          add it and no setting recovers it — reshoot that part of the orbit.`);
  } else {
    say(`          within a few times the fuzz band, so no unscanned hollow stands out.`);
  }
  process.exit(0);
}

let mesh;
if (SURFACE === 'fit') {
  // The fit averages over its own radius, so the grid no longer has to be coarse
  // to survive a porous shell — that job has moved into the weighting.
  const radius = (FIT > 0 ? FIT / 1000 : Math.max(spacing * 1.6, cell * 0.9));
  const { nrm, flat } = pointNormals(p, solid, dim, lo, cell, radius * 1.6);
  const { f: field, touched } = imlsField(p, nrm, solid, dim, lo, cell, radius);
  say(`fit       ${(radius * 1000).toFixed(2)}mm radius, ${touched} cells fitted${flat ? `, ${flat} splats too lonely to fit a plane to` : ''}`);
  // Zero, not a half: the field is a signed distance and the surface is where it
  // changes sign. Negative is inside, which is the opposite sense to the solid
  // above, so the winding is flipped back by surfaceNets' own volume check.
  mesh = surfaceNets(field, dim, lo, cell, 0);
} else {
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
  mesh = surfaceNets(field, dim, lo, cell, 0.5);
}
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
