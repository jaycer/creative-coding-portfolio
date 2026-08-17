#!/usr/bin/env node
// Stand a GLB up, and re-emit it in the deck's own format.
//
// The Splat Editor builds in the scan's frame, because that is the frame the
// cloud is in and rotating it mid-session would make every erase stroke land
// somewhere unexpected. A phone has no idea which way up a pig is, so what comes
// out of the editor lies at whatever angle the capture happened to be at — fine
// on a workbench, wrong in a gallery where the object is the subject.
//
// The re-emit matters as much as the rotation. GLTFExporter writes POSITION and
// NORMAL; the deck's own writer writes positions only, three per triangle and
// unindexed, and lets the app compute face normals on load. Same picture, a bit
// under half the bytes, and it is the format the rest of the deck is in — a
// model that arrives with its own normals is one more thing behaving differently
// from its sixty neighbours for no reason anybody can see later.
//
//   node tools/orient-glb.mjs --in model.glb --out model.glb --up -x [--yaw 90]
//
// --up names the axis of the INPUT that should end up pointing up.

import { readFileSync, writeFileSync } from 'node:fs';
import { orient } from '../public/apps/splat-editor/build.js';

const argv = process.argv.slice(2);
const opt = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const inPath = opt('in');
const outPath = opt('out', inPath);
const up = opt('up', '+y');
const yaw = Number(opt('yaw', 0));
if (!inPath) {
  console.error('usage: node tools/orient-glb.mjs --in model.glb [--out model.glb] --up -x [--yaw 90]');
  process.exit(1);
}

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${inPath} is not a GLB`);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binAt = 20 + jsonLen + 8;

// Every triangle, in world space, grouped by the material it wore.
const groups = new Map();
const nodeMatrix = new Map();
for (const [i, n] of (gltf.nodes || []).entries()) {
  if (n.mesh !== undefined) nodeMatrix.set(n.mesh, n.matrix || null);
}
for (const [mi, mesh] of gltf.meshes.entries()) {
  for (const prim of mesh.primitives) {
    if (prim.mode !== undefined && prim.mode !== 4) continue;
    const acc = gltf.accessors[prim.attributes.POSITION];
    const view = gltf.bufferViews[acc.bufferView];
    const base = binAt + view.byteOffset + (acc.byteOffset || 0);
    const stride = view.byteStride || 12;
    const read = (v) => [
      buf.readFloatLE(base + v * stride),
      buf.readFloatLE(base + v * stride + 4),
      buf.readFloatLE(base + v * stride + 8),
    ];
    let index = null;
    if (prim.indices !== undefined) {
      const ia = gltf.accessors[prim.indices];
      const iv = gltf.bufferViews[ia.bufferView];
      const ib = binAt + iv.byteOffset + (ia.byteOffset || 0);
      const size = ia.componentType === 5125 ? 4 : ia.componentType === 5123 ? 2 : 1;
      index = [];
      for (let k = 0; k < ia.count; k++) {
        index.push(size === 4 ? buf.readUInt32LE(ib + k * 4)
          : size === 2 ? buf.readUInt16LE(ib + k * 2) : buf.readUInt8(ib + k));
      }
    }
    const count = index ? index.length : acc.count;
    const key = prim.material ?? -1;
    if (!groups.has(key)) {
      const mat = prim.material !== undefined ? gltf.materials[prim.material] : null;
      const c = mat?.pbrMetallicRoughness?.baseColorFactor || [0.8, 0.8, 0.8, 1];
      groups.set(key, { color: [c[0], c[1], c[2]], verts: [] });
    }
    const g = groups.get(key);
    const m = nodeMatrix.get(mi);
    for (let k = 0; k < count; k++) {
      let p = read(index ? index[k] : k);
      if (m) {
        // Column-major, as glTF stores it.
        p = [
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ];
      }
      g.verts.push(p[0], p[1], p[2]);
    }
  }
}
if (!groups.size) throw new Error('no triangles in that GLB');

const all = [];
for (const g of groups.values()) all.push(...g.verts);
const verts = Float64Array.from(all);
orient(verts, up, yaw);

// Back out into the groups, then write the deck's flat GLB.
let at = 0;
for (const g of groups.values()) {
  for (let i = 0; i < g.verts.length; i++) g.verts[i] = verts[at++];
}

const pad4 = (n) => (n + 3) & ~3;
const bin = [];
const bufferViews = [];
const accessors = [];
const primitives = [];
const materials = [];
let offset = 0;
for (const [gi, g] of [...groups.values()].entries()) {
  const count = g.verts.length / 3;
  const b = Buffer.alloc(count * 12);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const v = g.verts[i * 3 + c];
      b.writeFloatLE(v, i * 12 + c * 4);
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length });
  const chunk = Buffer.alloc(pad4(b.length));
  b.copy(chunk);
  bin.push(chunk);
  offset += chunk.length;
  accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count, type: 'VEC3', min, max });
  materials.push({
    name: `g${gi}`,
    pbrMetallicRoughness: { baseColorFactor: [...g.color, 1], metallicFactor: 0, roughnessFactor: 0.8 },
  });
  primitives.push({ attributes: { POSITION: accessors.length - 1 }, material: materials.length - 1 });
}

const binBuf = Buffer.concat(bin);
const name = outPath.split('/').pop().replace(/\.glb$/i, '');
const json = {
  asset: { version: '2.0', generator: 'orient-glb.mjs' },
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
const out = Buffer.concat([header, jh, jsonChunk, bh, binBuf]);
writeFileSync(outPath, out);

const tris = accessors.reduce((s, a) => s + a.count, 0) / 3;
const bb = accessors[0];
console.log(`${outPath}  ${(out.length / 1024).toFixed(1)}KB, ${tris} triangles, ${groups.size} group(s)`);
console.log(`  stood up on ${up}${yaw ? `, turned ${yaw}°` : ''} — now ${bb.max.map((v, i) => ((v - bb.min[i]) * 100).toFixed(1)).join(' x ')} cm`);
