#!/usr/bin/env node
// A synthetic Gaussian-splat scan of a shape whose answer is known in advance.
//
// This exists because splat2glb.mjs has exactly one dangerous failure mode: it
// always returns a plausible lump. Run it on a real scan and you get a soft
// blobby animal whether the pipeline is right or wrong, and there is no way to
// tell those apart by looking — a real capture has no ground truth to check
// against, so every bug reads as "the scan was mediocre".
//
// It cost a lot of wasted time to learn that. The bracket step was rewritten
// three times against a real pig, each version judged by eye, before a fixture
// showed that the pipeline had been correct for two of them and the scan was
// simply that soft. The fixture is what turns "does this look right" into a
// question with an answer.
//
// The shape is a capsule body with four legs, two ears and a snout: unmistakable
// at a glance, and made of parts small enough that losing one is obvious. Two
// colors, so the clustering has something real to find. Sampling is
// deterministic, so a rerun produces a byte-identical file and a diff in the
// output means a diff in the code.
//
// --fuzz displaces each sample along the surface normal, which is what a real
// splat trainer does: it fits splats to a band around the surface rather than to
// the surface. This is the property the reconstruction has to survive, and 4mm
// on a 20cm object is roughly what a phone capture of a small object looks like.
//
// Usage:
//   node tools/make-splat-fixture.mjs --out /tmp/clean.ply
//   node tools/make-splat-fixture.mjs --out /tmp/fuzzy.ply --fuzz 0.004
//   node tools/splat2glb.mjs --in /tmp/fuzzy.ply --out /tmp/fuzzy.glb --colors 2
//
// What a pass looks like: a pig. Body, four legs standing clear of each other,
// two ears, a snout, and the legs in their own color group. What failure looks
// like: an open tube (the caps went missing), a crumpled bag (the solid leaked),
// or a smooth egg (the smoothing ran away with it).

import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const outPath = opt('out');
if (!outPath) {
  console.error('usage: make-splat-fixture.mjs --out <fixture.ply> [--fuzz 0.004] [--splats 30000]');
  process.exit(1);
}
const FUZZ = Number(opt('fuzz', 0));
const N = Math.round(Number(opt('splats', 30000)));

// xorshift32, so the fixture is the same file every time. Math.random() would
// make a diff between two runs meaningless, which is the one thing a fixture
// must not do.
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};

// Capsules: [ax, ay, az, bx, by, bz, radius]. Y up, the body along Z, standing
// on y = 0.
const PARTS = [
  [0, 0.055, -0.045, 0, 0.055, 0.045, 0.035],       // body
  [0, 0.055, 0.052, 0, 0.048, 0.075, 0.020],        // snout
  [-0.018, 0.020, -0.030, -0.018, 0, -0.030, 0.009], // legs
  [0.018, 0.020, -0.030, 0.018, 0, -0.030, 0.009],
  [-0.018, 0.020, 0.030, -0.018, 0, 0.030, 0.009],
  [0.018, 0.020, 0.030, 0.018, 0, 0.030, 0.009],
  [-0.020, 0.082, 0.045, -0.026, 0.095, 0.050, 0.008], // ears
  [0.020, 0.082, 0.045, 0.026, 0.095, 0.050, 0.008],
];

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const len = (p) => Math.sqrt(dot(p, p));
const scale = (p, s) => [p[0] * s, p[1] * s, p[2] * s];
const add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const norm = (p) => scale(p, 1 / (len(p) || 1));

/** How far inside the union of capsules a point is; > 0 means buried. */
function buried(p, shrink) {
  let best = -Infinity;
  for (const [ax, ay, az, bx, by, bz, r] of PARTS) {
    const a = [ax, ay, az];
    const ab = sub([bx, by, bz], a);
    const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / dot(ab, ab)));
    best = Math.max(best, r * shrink - len(sub(p, add(a, scale(ab, t)))));
  }
  return best;
}

// Sample each capsule in proportion to its area — tube plus two hemispherical
// caps. The caps are not optional: sample only the tube and the "solid" is an
// open pipe, and a correct reconstruction then hands back an open pipe, which
// looks exactly like a bug in the reconstruction.
const areas = PARTS.map(([ax, ay, az, bx, by, bz, r]) => {
  const L = len(sub([bx, by, bz], [ax, ay, az]));
  return 2 * Math.PI * r * L + 4 * Math.PI * r * r;
});
const total = areas.reduce((s, a) => s + a, 0);
const pick = () => {
  let t = rnd() * total;
  for (let i = 0; i < areas.length; i++) { t -= areas[i]; if (t <= 0) return i; }
  return areas.length - 1;
};

const pts = [];
let guard = 0;
while (pts.length < N && guard++ < N * 40) {
  const [ax, ay, az, bx, by, bz, r] = PARTS[pick()];
  const a = [ax, ay, az];
  const b = [bx, by, bz];
  const ab = sub(b, a);
  const L = len(ab);
  const axis = norm(ab);
  let u = cross(axis, [0, 0, 1]);
  if (len(u) < 1e-6) u = cross(axis, [0, 1, 0]);
  u = norm(u);
  const v = cross(axis, u);
  let p;
  if (rnd() < (2 * Math.PI * r * L) / (2 * Math.PI * r * L + 4 * Math.PI * r * r)) {
    const th = rnd() * 2 * Math.PI;
    p = add(add(a, scale(ab, rnd())), scale(add(scale(u, Math.cos(th)), scale(v, Math.sin(th))), r));
  } else {
    // A direction uniform on the sphere, by rejection — cheaper to read than the
    // closed form and this runs once.
    let d;
    do { d = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; } while (len(d) > 1 || len(d) < 1e-6);
    d = norm(d);
    p = add(dot(d, axis) > 0 ? b : a, scale(d, r));
  }
  // Drop anything that landed inside a neighbor: a leg sampled where it is
  // buried in the body would put "surface" points inside the shape.
  if (buried(p, 0.985) > 0) continue;
  pts.push(p);
}
if (pts.length < N) console.warn(`only placed ${pts.length} of ${N}`);

// The properties a 3DGS file carries. Everything splat2glb reads is real;
// f_rest (the higher spherical-harmonic bands) and the rotation quaternion are
// written as zeros and identity because nothing here uses them, and a file that
// omitted them would not be the format.
const NAMES = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
for (let i = 0; i < 45; i++) NAMES.push(`f_rest_${i}`);
NAMES.push('opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3');
const idx = Object.fromEntries(NAMES.map((n, i) => [n, i]));

const SH_C0 = 0.28209479177387814;
const BODY = [0.85, 0.55, 0.60];
const LEGS = [0.15, 0.12, 0.12];
const bin = Buffer.alloc(pts.length * NAMES.length * 4);
const centre = [0, 0.05, 0];
pts.forEach((p0, i) => {
  let p = p0;
  if (FUZZ) {
    const n = norm(sub(p, centre));
    // Box–Muller, so the displacement is Gaussian rather than uniform: a
    // trainer's uncertainty has tails, and a uniform band would not test them.
    const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    p = add(p, scale(n, g * FUZZ));
  }
  const rgb = p0[1] < 0.022 ? LEGS : BODY;
  const at = i * NAMES.length * 4;
  const put = (name, value) => bin.writeFloatLE(value, at + idx[name] * 4);
  put('x', p[0]); put('y', p[1]); put('z', p[2]);
  for (let k = 0; k < 3; k++) put(`f_dc_${k}`, (rgb[k] - 0.5) / SH_C0);
  put('opacity', 2.0);                        // sigmoid(2) = 0.88
  for (let k = 0; k < 3; k++) put(`scale_${k}`, Math.log(0.0012));
  put('rot_0', 1);
});

const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\n`
  + NAMES.map((n) => `property float ${n}\n`).join('')
  + 'end_header\n';
writeFileSync(outPath, Buffer.concat([Buffer.from(head, 'ascii'), bin]));
console.log(`${outPath}: ${pts.length} splats, fuzz ${(FUZZ * 1000).toFixed(1)}mm, ${(bin.length / 1024 / 1024).toFixed(1)}MB`);
