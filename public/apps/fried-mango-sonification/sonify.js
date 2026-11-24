// sonify.js — a job search in, note events out.
//
// This file is the score. It knows nothing about audio or MIDI: it turns the
// search into a flat list of notes, and the synth and the MIDI writer both
// play that same list. There is no randomness in it, so one search is always
// one piece of music.
//
// Time is counted in beats and a beat is a day. At 120 BPM that is two days a
// second, the speed the journey video runs at, so a note lands on the frame
// its dot appears in.
//
// Every layer of the picture is a track with a voice of its own:
//
//   beat        four on the floor. It is not data: it is the floor the data
//               dances on, and it is a track like the rest so that the MIDI
//               file and the render both carry it.
//   days        the calendar. A tick a day, and more of them as the search
//               goes on.
//   postings    postings captured. A bass note, louder the more there were.
//   pursued     jobs picked out to pursue. Thin high blips.
//   applied     applications sent. An arpeggio, one note per application.
//   interviews  an earcon: a rising two-note call.
//   offers      an earcon: the fanfare.
//   milestones  a crash on each captioned moment.
//
// The harmony is a four-bar loop, one chord per bar, and every pitched track
// takes its notes from the chord of the day. That is what keeps seven
// independent data streams sounding like one tune.

export const TRACKS = [
  { id: 'beat',       name: 'Beat',              voice: 'Kick, clap, hat', color: '#f6a821', level: 0.75 },
  { id: 'days',       name: 'Days',              voice: 'Noise tick',     color: '#8a93a3', level: 0.6 },
  { id: 'postings',   name: 'Postings captured', voice: 'Triangle bass',  color: '#c9ced8', level: 0.55 },
  { id: 'pursued',    name: 'Jobs pursued',      voice: 'Pulse 12.5%',    color: '#9aa3b2', level: 0.5 },
  { id: 'applied',    name: 'Applications sent', voice: 'Pulse 25%',      color: '#3b8eea', level: 0.85 },
  { id: 'interviews', name: 'Interviews',        voice: 'Pulse 50%',      color: '#f26b21', level: 0.6 },
  { id: 'offers',     name: 'Offers',            voice: 'Pulse 50%, echo', color: '#22c58b', level: 0.65 },
  { id: 'milestones', name: 'Milestones',        voice: 'Noise crash',    color: '#e6b45c', level: 0.5 },
];

// Drum notes, as General MIDI names them, so the MIDI file plays on any kit.
export const DRUM = { kick: 36, clap: 39, hat: 42, openHat: 46, crash: 49 };

// C, G, A minor, F: one bar each. Roots sit in the bass octave.
const CHORDS = [
  { root: 36, tones: [0, 4, 7] },
  { root: 43, tones: [7, 11, 14] },
  { root: 45, tones: [9, 12, 16] },
  { root: 41, tones: [5, 9, 12] },
];
const BEATS_PER_BAR = 4;
const chordAt = (beat) => CHORDS[Math.floor(beat / BEATS_PER_BAR) % CHORDS.length];
// The nth step up a chord: its three tones, then the same an octave higher.
const ladder = (chord, n, base) => base + chord.tones[n % 3] + 12 * Math.floor(n / 3);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Check and tidy a search. Accepts the journey page's own names (n, P) as
 * well as the plain ones.
 * @returns {{ days: number, jobs: number[][], captured: number[], milestones: [number, string][], title: string, start: string }}
 */
export function normalizeSearch(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not a search file');
  const jobsIn = Array.isArray(raw.jobs) ? raw.jobs : raw.P;
  if (!Array.isArray(jobsIn)) throw new Error('no jobs list');
  const day = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : -1);
  const jobs = jobsIn
    .filter((j) => Array.isArray(j) && Number.isFinite(j[0]))
    .map((j) => [day(j[0]), day(j[1]), day(j[2]), day(j[3]), day(j[4])]);
  const capturedIn = Array.isArray(raw.captured) ? raw.captured : [];
  let last = capturedIn.length - 1;
  for (const j of jobs) for (const d of j) if (d > last) last = d;
  const days = Math.max(1, Math.min(3660, Math.floor(Number(raw.days ?? raw.n) || last + 1)));
  const captured = Array.from({ length: days }, (_, i) => Math.max(0, Number(capturedIn[i]) || 0));
  const milestones = (Array.isArray(raw.milestones) ? raw.milestones : [])
    .filter((m) => Array.isArray(m) && Number.isFinite(m[0]) && m[0] >= 0 && m[0] < days)
    .map((m) => [Math.floor(m[0]), String(m[1] ?? '').slice(0, 200)]);
  return {
    days, jobs, captured, milestones,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    start: typeof raw.start === 'string' ? raw.start.slice(0, 10) : '',
  };
}

/** How many jobs reached each stage on each day: [pursued, applied, interviews, offers]. */
export function perDay(search) {
  const rows = [0, 1, 2, 3].map(() => new Array(search.days).fill(0));
  for (const j of search.jobs) {
    for (let s = 0; s < 4; s++) if (j[s] >= 0 && j[s] < search.days) rows[s][j[s]] += 1;
  }
  return rows;
}

/**
 * Write the score.
 * @param search a normalized search
 * @param {{ tail?: number }} [options] tail: beats after the last day
 * @returns {{ events: { track: string, beat: number, dur: number, note: number, vel: number }[],
 *             beats: number, days: number, counts: Record<string, number> }}
 */
export function sonify(search, options = {}) {
  const tail = Math.max(0, Math.round(options.tail ?? 8));
  const N = search.days;
  const [pursued, applied, interviews, offers] = perDay(search);
  const events = [];
  const add = (track, beat, dur, note, vel) => {
    events.push({ track, beat, dur, note, vel: clamp01(vel) });
  };

  const maxCaptured = Math.max(1, ...search.captured);
  const totalApplied = Math.max(1, applied.reduce((a, b) => a + b, 0));
  const milestoneDays = new Set(search.milestones.map((m) => m[0]));

  let sent = 0;
  for (let d = 0; d < N; d++) {
    const chord = chordAt(d);
    sent += applied[d];
    // The crescendo: half of it is simply time passing, half is the work done.
    const p = clamp01(0.5 * (d / Math.max(1, N - 1)) + 0.5 * (sent / totalApplied));
    const swell = 0.55 + 0.45 * p;

    // The beat. A kick on every day, a clap on two and four, an open hat
    // between the kicks, and a kick roll into every sixteenth bar.
    const inBar = d % BEATS_PER_BAR;
    add('beat', d, 0.25, DRUM.kick, inBar === 0 ? 1 : 0.9);
    if (inBar === 1 || inBar === 3) add('beat', d, 0.2, DRUM.clap, 0.8);
    add('beat', d + 0.5, 0.2, DRUM.openHat, 0.6);
    if (d % 64 === 63) for (let i = 1; i < 4; i++) add('beat', d + i * 0.25, 0.12, DRUM.kick, 0.55 + 0.1 * i);

    // Days. The ticking fills in as the search goes on.
    add('days', d, 0.1, DRUM.hat, 0.35 + 0.25 * p);
    if (p > 0.3) add('days', d + 0.5, 0.1, DRUM.hat, 0.2 + 0.2 * p);
    if (p > 0.75) { add('days', d + 0.25, 0.08, DRUM.hat, 0.16); add('days', d + 0.75, 0.08, DRUM.hat, 0.16); }

    // Postings captured. Loudness follows the count on a log scale, since the
    // busiest day can be a hundred times an ordinary one.
    const c = search.captured[d];
    if (c > 0) {
      const amount = Math.log1p(c) / Math.log1p(maxCaptured);
      add('postings', d, 0.45, chord.root, 0.35 + 0.6 * amount);
      // A big day gets the octave on the off beat, the bass line waking up.
      if (amount > 0.6) add('postings', d + 0.5, 0.4, chord.root + 12, 0.3 + 0.5 * amount);
    }

    // Jobs pursued. Up to four blips, falling.
    const f = Math.min(4, pursued[d]);
    for (let i = 0; i < f; i++) add('pursued', d + i * 0.25, 0.12, ladder(chord, f - 1 - i, 72), 0.4 + 0.3 * swell);

    // Applications. One note each, climbing the chord; a busy day plays faster.
    const a = Math.min(8, applied[d]);
    if (a > 0) {
      const step = a <= 2 ? 0.5 : a <= 4 ? 0.25 : 0.125;
      const lift = p > 0.66 ? 1 : 0;   // start a rung higher late in the search
      for (let i = 0; i < a; i++) add('applied', d + i * step, step * 0.85, ladder(chord, i + lift, 60), (0.5 + 0.08 * i) * swell + 0.15);
    }

    // Interviews. Root to fifth, rising: a question being asked.
    const iv = Math.min(2, interviews[d]);
    for (let i = 0; i < iv; i++) {
      const at = d + i * 0.5;
      add('interviews', at, 0.12, chord.root + 36 + 12 * i, 0.85);
      add('interviews', at + 0.125, 0.3, chord.root + 43 + 12 * i, 0.95);
    }

    // Offers. The fanfare: up the chord in sixteenths, and hold the top.
    if (offers[d] > 0) {
      for (let i = 0; i < 4; i++) add('offers', d + i * 0.125, 0.11, ladder(chord, i, 72), 0.9);
      add('offers', d + 0.5, 1.5, ladder(chord, 4, 72), 1);
    }

    if (milestoneDays.has(d)) add('milestones', d, 2, DRUM.crash, 0.8);
  }

  // The ending. A film of the search holds on its last frame for a while, so
  // the tail can be long. The last eight beats are the home chord ringing;
  // anything before that is an outro, where the beat and the bass carry on
  // and the lead walks up the chords with nothing left to report.
  if (tail > 0) {
    const ring = Math.min(tail, 8);
    const outro = tail - ring;
    for (let i = 0; i < outro; i++) {
      const d = N + i;
      const chord = chordAt(d);
      const inBar = d % BEATS_PER_BAR;
      add('beat', d, 0.25, DRUM.kick, inBar === 0 ? 1 : 0.9);
      if (inBar === 1 || inBar === 3) add('beat', d, 0.2, DRUM.clap, 0.8);
      add('beat', d + 0.5, 0.2, DRUM.openHat, 0.6);
      add('days', d, 0.1, DRUM.hat, 0.6);
      add('days', d + 0.5, 0.1, DRUM.hat, 0.4);
      add('postings', d, 0.45, chord.root, 0.8);
      add('applied', d, 0.42, ladder(chord, inBar, 60), 0.6);
      add('applied', d + 0.5, 0.42, ladder(chord, inBar + 1, 60), 0.5);
    }
    // The held notes stop a beat short of the end, so the file closes on
    // silence and not on a cut.
    const at = N + outro;
    const held = Math.max(0.5, ring - 1);
    const home = CHORDS[0];
    add('beat', at, 0.25, DRUM.kick, 1);
    add('milestones', at, held, DRUM.crash, 0.7);
    add('postings', at, held, home.root, 0.9);
    add('applied', at, held, ladder(home, 0, 60), 0.7);
    add('pursued', at, held, ladder(home, 2, 72), 0.5);
    add('interviews', at, held, ladder(home, 1, 72), 0.6);
  }

  events.sort((x, y) => x.beat - y.beat);
  const counts = Object.fromEntries(TRACKS.map((t) => [t.id, 0]));
  for (const e of events) counts[e.track] += 1;
  return { events, beats: N + tail, days: N, counts };
}
