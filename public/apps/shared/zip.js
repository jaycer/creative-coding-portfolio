// zip.js — write and read a zip archive, in the browser, with no library.
//
// A zip is the one container every system opens without help, so what an app
// saves in one stays usable when the app is not around. Gain Stage keeps a
// project in one (the original audio, the settings and a render); Fried Mango
// Sonification writes a DAWproject session, which is a zip by definition.
//
// An ES module, unlike the classic scripts beside it: import it.
//
// Writing stores the files as they are, without compression. Audio that is
// already compressed gains nothing from deflate, a WAV gains little, and
// storing means the archive is assembled from the original Blobs instead of a
// second copy of a large file held in memory.
//
// Reading also takes deflated entries, so a project that someone unpacked and
// zipped again with their own tool still opens.
//
// Classic zip only: no zip64, so 4 GB a file and 4 GB an archive.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const LIMIT = 0xffffffff;
const UTF8_NAMES = 0x0800;

function dosStamp(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a zip from named pieces.
 * @param {{ name: string, data: Blob | ArrayBuffer | Uint8Array | string }[]} files
 * @param {Date} [when] the modified time written on every entry
 * @returns {Promise<Blob>}
 */
export async function makeZip(files, when = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosStamp(when);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const blob = f.data instanceof Blob ? f.data : new Blob([f.data]);
    const size = blob.size;
    if (size > LIMIT) throw new Error(`${f.name} is over 4 GB`);
    // Read once for the checksum and let go; the archive keeps the Blob.
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const name = enc.encode(f.name);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);            // version needed
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);             // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);              // version made by
    dir.setUint16(6, 20, true);
    dir.setUint16(8, UTF8_NAMES, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);         // where the local header starts
    central.push(dir.buffer, name);

    parts.push(local.buffer, name, blob);
    offset += 30 + name.length + size;
    if (offset > LIMIT) throw new Error('the project is over 4 GB');
  }

  const dirSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/**
 * Open a zip.
 * @param {Blob} blob
 * @returns {Promise<Map<string, { size: number, blob: (type?: string) => Promise<Blob> }>>}
 */
export async function readZip(blob) {
  const buf = await blob.arrayBuffer();
  const v = new DataView(buf);
  const dec = new TextDecoder();

  // The end record is the last thing in the file, bar an optional comment.
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  if (count === 0xffff || at === LIMIT) throw new Error('zip64 archives are not supported');

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.byteLength || v.getUint32(at, true) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = v.getUint16(at + 10, true);
    const packed = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(new Uint8Array(buf, at + 46, nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;        // a folder, nothing to read

    entries.set(name, {
      size,
      async blob(type = '') {
        if (local + 30 > buf.byteLength || v.getUint32(local, true) !== 0x04034b50) throw new Error(`damaged entry: ${name}`);
        // The local header has its own name and extra lengths; they can differ.
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const raw = new Uint8Array(buf, start, packed);
        if (method === 0) return new Blob([raw], { type });
        if (method !== 8) throw new Error(`${name} uses a compression this app cannot read`);
        if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot unpack a compressed zip');
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Blob([await new Response(stream).arrayBuffer()], { type });
      },
    });
  }
  return entries;
}
