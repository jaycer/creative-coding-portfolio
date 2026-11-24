// dawproject.js — the score as a DAW session.
//
// DAWproject is the open exchange format Bitwig publishes and opens directly
// (Studio One and Cubase read it too). It is a zip holding project.xml and
// metadata.xml. Unlike a MIDI file it carries the session and not only the
// notes: named, colored tracks, the mixer as it stands here, the tempo, and
// the captions as arranger markers.
//
// It cannot carry Bitwig's own instruments, so the tracks arrive empty. Drop
// an instrument on each one.
//
// The beat, days and milestones tracks are drum notes. The score names them
// the General MIDI way, but Bitwig's Drum Machine kits do not follow General
// MIDI: they run kick, snare, closed hat, open hat, kick 2, clap up from C1,
// with the crash on D2. So the notes are moved to where a Bitwig kit keeps
// each sound. The MIDI file stays General MIDI.

import { TRACKS } from './sonify.js';
import { makeZip } from '../shared/zip.js';

// General MIDI note to the same sound's pad in a Bitwig Drum Machine kit.
const DRUM_TRACKS = new Set(['beat', 'days', 'milestones']);
const BITWIG_PAD = { 36: 36, 39: 41, 42: 38, 46: 39, 49: 50 };
const keyFor = (e) => (DRUM_TRACKS.has(e.track) ? BITWIG_PAD[e.note] ?? e.note : e.note);

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const num = (v) => String(Number(v.toFixed(6)));

/**
 * @param score what sonify() returned
 * @param {{ bpm: number, title?: string, milestones?: [number, string][],
 *           mix: { master: number, level: Record<string, number>, mute: Record<string, boolean>, solo: Record<string, boolean> },
 *           build?: string }} options
 * @returns {Promise<Blob>}
 */
export async function makeDawProject(score, { bpm, title = '', milestones = [], mix, build = 'unknown' }) {
  let n = 0;
  const id = () => `id${n++}`;
  const masterId = id();

  const channel = (cid, role, volume, mute, solo, destination) =>
    `      <Channel audioChannels="2"${destination ? ` destination="${destination}"` : ''} role="${role}" solo="${solo}" id="${cid}">\n` +
    `        <Mute value="${mute}" id="${id()}" name="Mute"/>\n` +
    `        <Pan max="1" min="0" unit="normalized" value="0.5" id="${id()}" name="Pan"/>\n` +
    `        <Volume max="2" min="0" unit="linear" value="${num(volume)}" id="${id()}" name="Volume"/>\n` +
    `      </Channel>\n`;

  let structure = '';
  let lanes = '';
  for (const t of TRACKS) {
    const trackId = id();
    structure +=
      `    <Track contentType="notes" loaded="true" id="${trackId}" name="${esc(t.name)}" color="${t.color}">\n` +
      channel(id(), 'regular', mix.level[t.id], mix.mute[t.id], mix.solo[t.id], masterId) +
      `    </Track>\n`;
    const notes = score.events
      .filter((e) => e.track === t.id)
      .map((e) => `            <Note time="${num(e.beat)}" duration="${num(e.dur)}" channel="0" key="${keyFor(e)}" vel="${num(e.vel)}" rel="${num(e.vel)}"/>\n`)
      .join('');
    lanes +=
      `      <Lanes track="${trackId}" id="${id()}">\n` +
      `        <Clips id="${id()}">\n` +
      `          <Clip time="0" duration="${num(score.beats)}" playStart="0" name="${esc(t.name)}">\n` +
      `            <Notes id="${id()}">\n${notes}            </Notes>\n` +
      `          </Clip>\n` +
      `        </Clips>\n` +
      `      </Lanes>\n`;
  }
  structure +=
    `    <Track contentType="audio notes" loaded="true" id="${id()}" name="Master">\n` +
    channel(masterId, 'master', mix.master, false, false, '') +
    `    </Track>\n`;

  const markers = milestones.length
    ? `    <Markers id="${id()}">\n` +
      milestones.map(([day, label]) => `      <Marker time="${num(day)}" name="${esc(label)}"/>\n`).join('') +
      `    </Markers>\n`
    : '';

  const project =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<Project version="1.0">\n` +
    `  <Application name="Fried Mango Sonification" version="${esc(build)}"/>\n` +
    `  <Transport>\n` +
    `    <Tempo max="666" min="20" unit="bpm" value="${num(bpm)}" id="${id()}" name="Tempo"/>\n` +
    `    <TimeSignature denominator="4" numerator="4" id="${id()}"/>\n` +
    `  </Transport>\n` +
    `  <Structure>\n${structure}  </Structure>\n` +
    `  <Arrangement id="${id()}">\n` +
    `    <Lanes timeUnit="beats" id="${id()}">\n${lanes}    </Lanes>\n` +
    markers +
    `  </Arrangement>\n` +
    `  <Scenes/>\n` +
    `</Project>\n`;

  const metadata =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<MetaData>\n  <Title>${esc(title || 'Job search')}</Title>\n` +
    `  <Comment>Made by Fried Mango Sonification ${esc(build)}. One beat is one day.</Comment>\n</MetaData>\n`;

  const zip = await makeZip([
    { name: 'project.xml', data: project },
    { name: 'metadata.xml', data: metadata },
  ]);
  return new Blob([zip], { type: 'application/octet-stream' });
}
