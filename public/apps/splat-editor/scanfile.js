// Reading and writing scan files in the browser.
//
// The same two formats tools/splat2glb.mjs reads, and deliberately the same
// decoding, including the handedness fix: an SPZ is turned into the frame
// Scaniverse's own PLY uses, so a cloud cleaned here and converted there means
// the same thing whichever file came off the phone.
//
// Kept apart from the editor because it is the half that has to be exactly
// right and has nothing to do with the interface.

const SPZ_MAGIC = 0x5053474e; // 'NGSP', little-endian
const SPZ_SH_DIM = [0, 3, 8, 15];
const SH_C0 = 0.28209479177387814;
const COLOR_SCALE = 0.15; // SPZ stores color about mid-grey at this scale

const PLY_TYPES = {
  float: 4, float32: 4, double: 8, float64: 8,
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
};

/** A cloud: positions, colors in 0..1, opacity in 0..1, and a radius in metres. */
function cloud(n) {
  return {
    n,
    pos: new Float32Array(n * 3),
    rgb: new Float32Array(n * 3),
    opacity: new Float32Array(n),
    radius: new Float32Array(n),
  };
}

function readPly(raw) {
  const bytes = new Uint8Array(raw);
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  const at = text.indexOf('end_header');
  if (at < 0) throw new Error('not a PLY: no end_header in the first 64KB');
  const headEnd = text.indexOf('\n', at) + 1;
  if (!/format\s+binary_little_endian/.test(text.slice(0, at))) {
    throw new Error('only binary_little_endian PLY is read here');
  }

  let count = 0;
  let inFirst = false;
  const props = [];
  for (const line of text.slice(0, at).split('\n')) {
    const t = line.trim();
    if (t.startsWith('element ')) {
      if (inFirst) break;
      inFirst = true;
      count = parseInt(t.split(/\s+/)[2], 10);
    } else if (inFirst && t.startsWith('property ')) {
      const p = t.split(/\s+/);
      if (p[1] === 'list') throw new Error('list properties in the vertex element are not read here');
      const size = PLY_TYPES[p[1]];
      if (!size) throw new Error(`unknown PLY property type: ${p[1]}`);
      props.push({ name: p[p.length - 1], type: p[1], size });
    }
  }
  const stride = props.reduce((s, p) => s + p.size, 0);
  if (!count || !stride) throw new Error('PLY has no vertex element');
  if (headEnd + count * stride > bytes.length) throw new Error('PLY is truncated');

  let off = 0;
  const where = new Map();
  for (const p of props) { where.set(p.name, { ...p, off }); off += p.size; }
  const view = new DataView(raw);
  const column = (name) => {
    const p = where.get(name);
    if (!p) return null;
    const out = new Float32Array(count);
    for (let i = 0, base = headEnd + p.off; i < count; i++, base += stride) {
      switch (p.type) {
        case 'float': case 'float32': out[i] = view.getFloat32(base, true); break;
        case 'double': case 'float64': out[i] = view.getFloat64(base, true); break;
        case 'char': case 'int8': out[i] = view.getInt8(base); break;
        case 'uchar': case 'uint8': out[i] = view.getUint8(base); break;
        case 'short': case 'int16': out[i] = view.getInt16(base, true); break;
        case 'ushort': case 'uint16': out[i] = view.getUint16(base, true); break;
        case 'int': case 'int32': out[i] = view.getInt32(base, true); break;
        default: out[i] = view.getUint32(base, true); break;
      }
    }
    return out;
  };

  const x = column('x'); const y = column('y'); const z = column('z');
  if (!x || !y || !z) throw new Error('PLY has no x/y/z');
  const c = cloud(count);
  for (let i = 0; i < count; i++) {
    c.pos[i * 3] = x[i]; c.pos[i * 3 + 1] = y[i]; c.pos[i * 3 + 2] = z[i];
  }

  const rawOpacity = column('opacity');
  for (let i = 0; i < count; i++) {
    c.opacity[i] = rawOpacity ? 1 / (1 + Math.exp(-rawOpacity[i])) : 1;
  }

  const s0 = column('scale_0'); const s1 = column('scale_1'); const s2 = column('scale_2');
  if (s0 && s1 && s2) {
    for (let i = 0; i < count; i++) {
      c.radius[i] = (Math.exp(s0[i]) + Math.exp(s1[i]) + Math.exp(s2[i])) / 3;
    }
  }

  const d0 = column('f_dc_0'); const d1 = column('f_dc_1'); const d2 = column('f_dc_2');
  const r8 = column('red'); const g8 = column('green'); const b8 = column('blue');
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  if (d0 && d1 && d2) {
    for (let i = 0; i < count; i++) {
      c.rgb[i * 3] = clamp(SH_C0 * d0[i] + 0.5);
      c.rgb[i * 3 + 1] = clamp(SH_C0 * d1[i] + 0.5);
      c.rgb[i * 3 + 2] = clamp(SH_C0 * d2[i] + 0.5);
    }
  } else if (r8 && g8 && b8) {
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    for (let i = 0; i < count; i++) {
      c.rgb[i * 3] = lin(r8[i] / 255);
      c.rgb[i * 3 + 1] = lin(g8[i] / 255);
      c.rgb[i * 3 + 2] = lin(b8[i] / 255);
    }
  } else {
    c.rgb.fill(0.8);
  }
  return c;
}

function readSpz(raw) {
  const view = new DataView(raw);
  const bytes = new Uint8Array(raw);
  if (view.getUint32(0, true) !== SPZ_MAGIC) throw new Error('not an SPZ: wrong magic');
  const version = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  if (version !== 2) throw new Error(`SPZ version ${version} — this reads version 2`);
  const shDim = SPZ_SH_DIM[shDegree];
  if (shDim === undefined) throw new Error(`SPZ SH degree ${shDegree} is not 0-3`);
  const per = 9 + 1 + 3 + 3 + 3 + shDim * 3;
  if (bytes.length !== 16 + count * per) {
    throw new Error(`SPZ is ${bytes.length} bytes; ${count} points at ${per} each plus a 16-byte header is ${16 + count * per}`);
  }

  const c = cloud(count);
  const denom = 1 << fractionalBits;
  let o = 16;
  const posAt = o; o += count * 9;
  const alphaAt = o; o += count;
  const colorAt = o; o += count * 3;
  const scaleAt = o;
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  for (let i = 0; i < count; i++) {
    const p = posAt + i * 9;
    for (let k = 0; k < 3; k++) {
      let v = bytes[p + k * 3] | (bytes[p + k * 3 + 1] << 8) | (bytes[p + k * 3 + 2] << 16);
      if (v >= 0x800000) v -= 0x1000000;
      // Into the PLY's frame: SPZ is Y-up, that PLY has Y and Z negated.
      c.pos[i * 3 + k] = (k === 0 ? v : -v) / denom;
    }
    c.opacity[i] = bytes[alphaAt + i] / 255;
    let r = 0;
    for (let k = 0; k < 3; k++) {
      c.rgb[i * 3 + k] = clamp(SH_C0 * ((bytes[colorAt + i * 3 + k] / 255 - 0.5) / COLOR_SCALE) + 0.5);
      r += Math.exp(bytes[scaleAt + i * 3 + k] / 16 - 10) / 3;
    }
    c.radius[i] = r;
  }
  return c;
}

/** Read whichever of the two came off the phone. Handles the gzip an SPZ ships in. */
export async function readScan(arrayBuffer) {
  let buf = arrayBuffer;
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot gunzip an SPZ');
    buf = await new Response(
      new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
  }
  const v = new DataView(buf);
  if (buf.byteLength >= 4 && v.getUint32(0, true) === SPZ_MAGIC) return readSpz(buf);
  const magic = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, 3));
  if (magic === 'ply') return readPly(buf);
  throw new Error('that is neither a PLY nor an SPZ');
}

/**
 * Write the surviving points back out as a splat PLY.
 *
 * Ten properties rather than the sixty-two a trainer writes: position, the SH
 * band-0 color, opacity and the three scales. That is exactly the set
 * splat2glb.mjs reads, and the higher SH bands it never looks at are dropped
 * rather than carried — a cleaned file is for converting, not for re-rendering.
 *
 * Opacity goes back out as a logit and the scales as logs, which is how the
 * format stores them, so a round trip through here changes nothing but which
 * points are present.
 */
export function writePly(c, alive) {
  let n = 0;
  for (let i = 0; i < c.n; i++) if (alive[i]) n++;
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2'];
  const header = `ply\nformat binary_little_endian 1.0\ncomment cleaned in splat-editor\nelement vertex ${n}\n`
    + names.map((s) => `property float ${s}\n`).join('')
    + 'end_header\n';
  const head = new TextEncoder().encode(header);
  const body = new ArrayBuffer(n * names.length * 4);
  const view = new DataView(body);
  const logit = (a) => Math.log(Math.min(Math.max(a, 1e-6), 1 - 1e-6) / (1 - Math.min(Math.max(a, 1e-6), 1 - 1e-6)));
  let at = 0;
  for (let i = 0; i < c.n; i++) {
    if (!alive[i]) continue;
    view.setFloat32(at, c.pos[i * 3], true); at += 4;
    view.setFloat32(at, c.pos[i * 3 + 1], true); at += 4;
    view.setFloat32(at, c.pos[i * 3 + 2], true); at += 4;
    for (let k = 0; k < 3; k++) {
      view.setFloat32(at, (c.rgb[i * 3 + k] - 0.5) / SH_C0, true); at += 4;
    }
    view.setFloat32(at, logit(c.opacity[i]), true); at += 4;
    const s = Math.log(Math.max(c.radius[i], 1e-8));
    for (let k = 0; k < 3; k++) { view.setFloat32(at, s, true); at += 4; }
  }
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(body), head.length);
  return { blob: new Blob([out], { type: 'application/octet-stream' }), kept: n };
}
