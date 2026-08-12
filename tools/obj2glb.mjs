#!/usr/bin/env node
// OBJ + MTL  ->  GLB, for the flat-shaded CC0 model packs the gallery uses.
//
// Object Tile Scroll loads every build through GLTFLoader and colors it from the
// model's own material groups, so a pack that ships as OBJ is converted here
// rather than teaching the app a second loader and a second material path. The
// packs this is for (Quaternius, Kenney) are low-poly with no textures: a
// handful of materials per model, each a flat Kd. Anything else in the MTL —
// specular, illum, maps — is dropped on the floor, deliberately.
//
// One glTF primitive per material, which is what the app groups on. Vertices are
// deduplicated by position+normal, so a shared corner is stored once.
//
// Kd is written straight into baseColorFactor. Blender's MTL exporter writes Kd
// linear and glTF's baseColorFactor is linear, so that is a copy and not a
// conversion. (Get this backwards and every model arrives washed out.)
//
// --flat drops normals and the index buffer, writing three positions per
// triangle and letting the app call computeVertexNormals() to get flat ones. For
// a faceted model that is not a loss — every vertex already carries its own face
// normal, so nothing is being shared and the index buffer is counting 0,1,2,3…
// It is a little over half the bytes, and it makes the flat look a property of
// the pipeline rather than of whoever exported the pack.
//
// Usage:
//   node tools/obj2glb.mjs --in <dir> --out <dir> [--only a,b,c] [--flat]
//   node tools/obj2glb.mjs --in ~/Downloads/Pack --out public/apps/x/models --only Chair_1,Table --flat

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const inDir = opt('in');
const outDir = opt('out');
const only = opt('only') ? opt('only').split(',').map((s) => s.trim()) : null;
const flat = argv.includes('--flat');
if (!inDir || !outDir) {
  console.error('usage: obj2glb.mjs --in <dir> --out <dir> [--only a,b,c]');
  process.exit(1);
}

/** newmtl name -> [r,g,b], linear. */
function parseMtl(text) {
  const mats = new Map();
  let cur = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('newmtl ')) { cur = t.slice(7).trim(); mats.set(cur, [1, 1, 1]); }
    else if (cur && t.startsWith('Kd ')) {
      const v = t.slice(3).trim().split(/\s+/).map(Number);
      if (v.length >= 3 && v.every(Number.isFinite)) mats.set(cur, v.slice(0, 3));
    }
  }
  return mats;
}

/**
 * Read an OBJ into one vertex buffer per material.
 *
 * Faces may be triangles, quads or larger, so each is fanned from its first
 * vertex. OBJ indices are 1-based and may be negative (relative to the end),
 * which is rare but legal and cheap to honor.
 */
function parseObj(text) {
  const pos = [];
  const nrm = [];
  const groups = new Map();   // material name -> { verts: [], index: [], seen: Map }
  let cur = '__default';

  const group = (name) => {
    if (!groups.has(name)) groups.set(name, { verts: [], index: [], seen: new Map() });
    return groups.get(name);
  };

  const vertexOf = (g, spec) => {
    const [vi, , ni] = spec.split('/');
    let pi = parseInt(vi, 10);
    pi = pi < 0 ? pos.length / 3 + pi : pi - 1;
    let no = ni ? parseInt(ni, 10) : NaN;
    if (Number.isFinite(no)) no = no < 0 ? nrm.length / 3 + no : no - 1;
    const key = `${pi}|${Number.isFinite(no) ? no : 'x'}`;
    let at = g.seen.get(key);
    if (at === undefined) {
      at = g.verts.length / 6;
      g.verts.push(
        pos[pi * 3] || 0, pos[pi * 3 + 1] || 0, pos[pi * 3 + 2] || 0,
        Number.isFinite(no) ? (nrm[no * 3] || 0) : 0,
        Number.isFinite(no) ? (nrm[no * 3 + 1] || 1) : 1,
        Number.isFinite(no) ? (nrm[no * 3 + 2] || 0) : 0,
      );
      g.seen.set(key, at);
    }
    return at;
  };

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('v ')) pos.push(...t.slice(2).trim().split(/\s+/).map(Number));
    else if (t.startsWith('vn ')) nrm.push(...t.slice(3).trim().split(/\s+/).map(Number));
    else if (t.startsWith('usemtl ')) cur = t.slice(7).trim() || '__default';
    else if (t.startsWith('f ')) {
      const specs = t.slice(2).trim().split(/\s+/);
      const g = group(cur);
      const a = vertexOf(g, specs[0]);
      for (let i = 1; i + 1 < specs.length; i++) {
        g.index.push(a, vertexOf(g, specs[i]), vertexOf(g, specs[i + 1]));
      }
    }
  }
  return groups;
}

const pad4 = (n) => (n + 3) & ~3;

function buildGlb(groups, mats) {
  const bin = [];               // { buf, byteLength } pieces, each padded to 4
  const bufferViews = [];
  const accessors = [];
  const primitives = [];
  const materials = [];
  let offset = 0;

  const addView = (buf) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: buf.length };
    bufferViews.push(view);
    const padded = pad4(buf.length);
    const chunk = Buffer.alloc(padded);
    buf.copy(chunk);
    bin.push(chunk);
    offset += padded;
    return bufferViews.length - 1;
  };

  for (const [name, g] of groups) {
    if (!g.index.length) continue;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const track = (v, k) => { if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; };

    const attributes = {};
    let indicesAccessor = -1;
    if (flat) {
      // Positions only, one set per triangle corner, no index buffer.
      const count = g.index.length;
      const p = Buffer.alloc(count * 12);
      for (let i = 0; i < count; i++) {
        const src = g.index[i] * 6;
        for (let k = 0; k < 3; k++) {
          const v = g.verts[src + k];
          p.writeFloatLE(v, i * 12 + k * 4);
          track(v, k);
        }
      }
      attributes.POSITION = accessors.push({
        bufferView: addView(p), componentType: 5126, count, type: 'VEC3', min, max,
      }) - 1;
    } else {
      const count = g.verts.length / 6;
      const p = Buffer.alloc(count * 12);
      const n = Buffer.alloc(count * 12);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < 3; k++) {
          const v = g.verts[i * 6 + k];
          p.writeFloatLE(v, i * 12 + k * 4);
          track(v, k);
          n.writeFloatLE(g.verts[i * 6 + 3 + k], i * 12 + k * 4);
        }
      }
      // 16-bit indices wherever they fit, which is every model in these packs.
      const short = count <= 65535;
      const idx = Buffer.alloc(g.index.length * (short ? 2 : 4));
      g.index.forEach((v, i) => (short ? idx.writeUInt16LE(v, i * 2) : idx.writeUInt32LE(v, i * 4)));
      attributes.POSITION = accessors.push({
        bufferView: addView(p), componentType: 5126, count, type: 'VEC3', min, max,
      }) - 1;
      attributes.NORMAL = accessors.push({
        bufferView: addView(n), componentType: 5126, count, type: 'VEC3',
      }) - 1;
      indicesAccessor = accessors.push({
        bufferView: addView(idx), componentType: short ? 5123 : 5125,
        count: g.index.length, type: 'SCALAR',
      }) - 1;
    }

    const kd = mats.get(name) || [0.8, 0.8, 0.8];
    materials.push({
      name,
      pbrMetallicRoughness: { baseColorFactor: [kd[0], kd[1], kd[2], 1], metallicFactor: 0, roughnessFactor: 0.8 },
    });
    const prim = { attributes, material: materials.length - 1 };
    if (!flat) prim.indices = indicesAccessor;
    primitives.push(prim);
  }
  if (!primitives.length) return null;

  const binBuf = Buffer.concat(bin);
  const json = {
    asset: { version: '2.0', generator: 'obj2glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBuf.length }],
  };

  // The JSON chunk pads with spaces and the binary chunk with zeroes; the spec
  // is specific about which, and a viewer that validates will reject the file.
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20);
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);          // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binBuf.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);              // 'JSON'
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binBuf.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);              // 'BIN'
  return Buffer.concat([header, jh, jsonChunk, bh, binBuf]);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const objs = readdirSync(inDir).filter((f) => f.toLowerCase().endsWith('.obj'));
let made = 0;
for (const file of objs) {
  const stem = basename(file, '.obj');
  if (only && !only.includes(stem)) continue;
  const mtlPath = join(inDir, `${stem}.mtl`);
  const mats = existsSync(mtlPath) ? parseMtl(readFileSync(mtlPath, 'utf8')) : new Map();
  const groups = parseObj(readFileSync(join(inDir, file), 'utf8'));
  const glb = buildGlb(groups, mats);
  if (!glb) { console.warn('no geometry:', stem); continue; }
  writeFileSync(join(outDir, `${stem}.glb`), glb);
  console.log(`${stem}.glb`.padEnd(34), String(glb.length).padStart(7), 'bytes,', groups.size, 'material(s)');
  made++;
}
console.log(`\nwrote ${made} file(s) to ${outDir}`);
if (only) {
  const missing = only.filter((n) => !objs.includes(`${n}.obj`));
  if (missing.length) console.warn('NOT FOUND in --in:', missing.join(', '));
}
