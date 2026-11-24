// midi.js — the score as a Standard MIDI File.
//
// Format 1: a conductor track with the tempo and a marker for each captioned
// moment, then one track per layer, named, so a DAW opens it as a session
// with the layers already separated and ready to be given real instruments.
//
// The beat and the two noise layers go to channel 10, where General MIDI keeps its drum
// kit. The rest get a channel each and a square or bass patch, which is only
// a hint; the point of the file is the notes.

import { TRACKS } from './sonify.js';

const PPQ = 480;
const DRUM_CHANNEL = 9;
const PROGRAM = { postings: 38, pursued: 80, applied: 80, interviews: 80, offers: 80 };

const text = (s) => [...new TextEncoder().encode(s)];

/** A MIDI variable-length quantity. */
function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const meta = (type, bytes) => [0xff, type, ...vlq(bytes.length), ...bytes];

/** Turn timed messages into a track chunk. `rank` breaks ties: offs before ons. */
function chunk(messages) {
  messages.sort((a, b) => a.tick - b.tick || a.rank - b.rank);
  const body = [];
  let at = 0;
  for (const m of messages) {
    body.push(...vlq(m.tick - at), ...m.bytes);
    at = m.tick;
  }
  body.push(0, ...meta(0x2f, []));
  return [...text('MTrk'), ...u32(body.length), ...body];
}

/**
 * @param score what sonify() returned
 * @param {{ bpm: number, title?: string, milestones?: [number, string][] }} options
 * @returns {Blob}
 */
export function makeMidi(score, { bpm, title = '', milestones = [] }) {
  const tick = (beat) => Math.round(beat * PPQ);
  const usPerBeat = Math.round(60000000 / bpm);

  const conductor = [
    { tick: 0, rank: 0, bytes: meta(0x03, text(title || 'Job search')) },
    { tick: 0, rank: 0, bytes: meta(0x51, [(usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255]) },
    { tick: 0, rank: 0, bytes: meta(0x58, [4, 2, 24, 8]) },
    ...milestones.map(([day, label]) => ({ tick: tick(day), rank: 0, bytes: meta(0x06, text(label)) })),
    // Hold the file open to the end of the last ringing note.
    { tick: tick(score.beats), rank: 1, bytes: meta(0x06, text('End')) },
  ];
  const chunks = [chunk(conductor)];

  let nextChannel = 0;
  for (const t of TRACKS) {
    const drums = !(t.id in PROGRAM);
    let channel = DRUM_CHANNEL;
    if (!drums) { channel = nextChannel++; if (channel === DRUM_CHANNEL) channel = nextChannel++; }
    const messages = [{ tick: 0, rank: 0, bytes: meta(0x03, text(t.name)) }];
    if (!drums) messages.push({ tick: 0, rank: 0, bytes: [0xc0 | channel, PROGRAM[t.id]] });
    for (const e of score.events) {
      if (e.track !== t.id) continue;
      const on = tick(e.beat);
      const off = Math.max(on + 1, tick(e.beat + e.dur));
      const vel = Math.max(1, Math.min(127, Math.round(e.vel * 127)));
      messages.push({ tick: on, rank: 1, bytes: [0x90 | channel, e.note, vel] });
      messages.push({ tick: off, rank: 0, bytes: [0x80 | channel, e.note, 0] });
    }
    chunks.push(chunk(messages));
  }

  const header = [...text('MThd'), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ)];
  return new Blob([new Uint8Array([...header, ...chunks.flat()])], { type: 'audio/midi' });
}
