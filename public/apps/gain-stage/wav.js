// wav.js — turn an AudioBuffer into a downloadable WAV, in the browser.
//
// Exporting has to happen locally: the whole point of this app is that a
// 60 MB stem never goes near a server. So the render is an OfflineAudioContext
// and the file is assembled here, byte by byte.
//
// Three depths, because they are for different jobs:
//   16-bit  the universally playable one, with TPDF dither so quiet fades do
//           not turn into gritty quantization steps.
//   24-bit  the archival/hand-off depth; dither is pointless this far down.
//   32-bit float  no clipping, no rounding — for round-tripping into a DAW.

const DEPTHS = {
  16: { bytes: 2, float: false },
  24: { bytes: 3, float: false },
  32: { bytes: 4, float: true },
};

/**
 * Encode an AudioBuffer as a WAV file.
 * @param {AudioBuffer} buffer
 * @param {{ depth?: 16|24|32, dither?: boolean }} [options]
 * @returns {Blob}
 */
export function encodeWav(buffer, options = {}) {
  const depth = DEPTHS[options.depth] ? options.depth : 24;
  const { bytes, float } = DEPTHS[depth];
  const dither = options.dither !== false && depth === 16;

  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const blockAlign = channels * bytes;
  const dataBytes = frames * blockAlign;

  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  const ascii = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);                       // PCM header size
  view.setUint16(20, float ? 3 : 1, true);            // 3 = IEEE float, 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);  // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, depth, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Pull the channel data out once — getChannelData is not free.
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  const scale = depth === 16 ? 32767 : 8388607;
  let offset = 44;

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v = data[c][i];
      if (float) {
        view.setFloat32(offset, v, true);
        offset += 4;
        continue;
      }
      if (dither) {
        // TPDF (triangular) dither at ±1 LSB — the difference between a fade
        // that dissolves and one that crunches.
        v += (Math.random() + Math.random() - 1) / scale;
      }
      // Clamp before rounding: a sample at exactly 1.0 would wrap to -32768.
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      const s = Math.max(-scale - 1, Math.min(scale, Math.round(v * scale)));
      if (depth === 16) {
        view.setInt16(offset, s, true);
        offset += 2;
      } else {
        view.setUint8(offset, s & 0xff);
        view.setUint8(offset + 1, (s >> 8) & 0xff);
        view.setUint8(offset + 2, (s >> 16) & 0xff);
        offset += 3;
      }
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

/** Trigger a download of a Blob without ever leaving the page. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — Safari cancels the download if it goes too soon.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
