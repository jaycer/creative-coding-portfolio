// Listening to the room. Shared: Hey Chair dances a band to it, Object Tile
// Scroll breathes to it.
//
// Nothing in this file makes a sound. It takes the microphone, works out how
// fast whatever is playing nearby is going and where its beats fall, and hands
// that back, so a piece can run on the room instead of on its own clock.
//
// Two answers come out of it and they are not the same. `heard`, `period` and
// `beatTime` are the measurement: the tempo actually out there and the grid its
// beats sit on. `bpm` is that folded into the window a show can be danced at,
// which is a convenience for the caller that has one — anything working in the
// room's own terms should read `heard` and ignore it.
//
// The chain is the standard one, and each link exists for a reason:
//
//   ANALYSER        a spectrum every few milliseconds, and only ever when some
//                   audio has genuinely arrived since the last one
//   SPECTRAL FLUX   how much of that spectrum got louder since the last one,
//                   which is as close to "something was struck" as you get
//                   without knowing what the instrument was. Counted per band
//                   and averaged, never summed across the whole spectrum: a
//                   hi-hat lifts every bin it has and a kick lifts three, so a
//                   flat sum is a record of the cymbals with the drums missing.
//   ENVELOPE        those readings, per second rather than per reading, binned
//                   onto a fixed 100 Hz grid indexed by AUDIO CLOCK time and
//                   never by when the timer happened to fire. A timer that
//                   slips 6 ms is nothing to a listener and fatal to an
//                   autocorrelation, whose whole subject is spacing.
//   AUTOCORRELATION the lag the envelope most agrees with itself at. Multiples
//                   of each candidate are folded in so a beat is not mistaken
//                   for the half-beat between two of them, and the whole thing
//                   is weighted toward the tempos people actually play.
//   COMB            which offset inside that lag the beats sit on, so we get a
//                   downbeat and not just a speed.
//
// Everything is reported in the audio clock's own time, which is the clock the
// band is scheduled on. That is the whole trick: a beat heard here and a beat
// played there are the same kind of number, so one can be lined up with the
// other without either side knowing anything about wall time.

// --- the shape of the analysis -------------------------------------------------
const RATE = 100;             // envelope bins per second
const HOP_MS = 5;             // how often the spectrum is read
const HISTORY = 12 * RATE;    // envelope kept, in bins
const EST_MS = 200;           // how often the estimate is redone
const WINDOW = 6 * RATE;      // how much of it each estimate reads

// A six second window is the compromise: long enough that four bars of almost
// anything are in it, short enough that the answer follows a track change
// rather than averaging across it.

// Nothing is looked for above 155, and that is not a limitation: a track at 175
// is found at 87 and one at 190 at 95, which is the same grid counted at the
// half, and it is where they would be folded to anyway. Searching up there
// instead buys a whole class of mistakes, because the eighth notes of a slow
// track are a perfectly good beat at twice the tempo and there is no way to
// tell them apart from the beats of a fast one.
const MIN_BPM = 65;
const MAX_BPM = 155;
const LAG_MIN = Math.round((60 / MAX_BPM) * RATE);
const LAG_MAX = Math.round((60 / MIN_BPM) * RATE);
const AC_MAX = LAG_MAX * 3 + 2;   // far enough out to fold in third harmonics
const LAG_STEP = 0.25;            // candidates are scanned finer than the bins

// Absent any other evidence, a tempo is likelier to be near 120 than near the
// ends. Weighting by distance in octaves rather than in BPM is what makes this
// symmetric: 60 and 240 are equally unlikely, and 240 is not four times worse.
const PRIOR_BPM = 120;
const PRIOR_OCTAVES = 1.1;

// The show was tuned between these. Any tempo can be halved or doubled and
// still be on the beat, so a track outside the window is danced at whichever
// multiple of itself lands inside it.
const SHOW_MIN = 80, SHOW_MAX = 140, SHOW_MID = 105;
const HARD_MIN = 60, HARD_MAX = 150;   // what the band's clock will take

// Below this there is nothing out there to dance to. Measured as a slowly
// smoothed RMS of the waveform itself, which is a real loudness: the obvious
// thing, a smoothed average of the spectrum, turns out to swing by two orders
// of magnitude between the kick and the gap after it, so it reports a loud
// track as alternately deafening and silent several times a bar.
// With automatic gain control switched off — and it has to be, it flattens the
// dynamics being measured — some inputs deliver a great deal less level than
// the meter in the system settings would suggest. So this sits very low: it is
// only here to tell an empty room from a working one, and deciding whether
// there is a BEAT in what arrives is the confidence measure's job, not this.
const QUIET = 0.0005;    // about -66 dBFS
const SILENT = 0.00002;  // nothing arriving at all, which is a different fault

// How periodic the room has to be before any of this is believed. Measured
// straight off the autocorrelation, which is already 0 to 1 and says what it
// means: this share of the envelope repeats at that spacing. On the tracks this
// was built against it reads 0.63 to 0.87; on filtered noise with events thrown
// in at random it reads 0.10 to 0.14, and on a silent room the same.
//
// It has to be absolute. Scoring the winner against the average candidate — how
// much it stands out from the field — looks like the more careful measure and
// is worthless here: with no beat in the room the field averages nothing, so
// the largest of the random peaks stands out from it enormously and every room
// full of noise reports total confidence.
const CONF_FLOOR = 0.18;
const CONF_FULL = 0.50;
const LOCK_CONF = 0.25;
const STEADY = 2.5;      // BPM the estimate may wander and still count as held

// The spectrum read is over by the time it is read: the analyser hands back a
// transform of the last fftSize samples, so the sound in it happened, on
// average, half a window ago. Small, but it is a straight offset on every beat
// time we report and it costs nothing to take off.
let lookback = 0;

// --- state ---------------------------------------------------------------------
let ctx = null;
let stream = null;
let source = null;
let analyser = null;
let spectrum = null;
let previous = null;
let waveform = null;
let keepAlive = null;   // a muted <audio> holding the stream open for WebKit
let silence = null;     // a zero-gain path to the destination, so the graph is pulled
let otherInputs = [];   // every audio input the machine has, once labels are readable
let silentSince = 0;    // when the current input started handing over nothing
const tried = new Set();// inputs already found to be dead, this session
// How long an input is given to produce a single non-zero sample before we
// give up on it. Long enough not to trip over a slow start, short enough that
// nobody sits watching a dead device.
const DEAD_AFTER = 4;
let binLo = 1, binHi = 2;
// Roughly: drums, bass and low body, voices and guitars, cymbals. Each one gets
// an equal say in whether something just happened.
const BAND_HZ = [40, 200, 800, 3000, 8000];
let bandEdges = [];
let pollTimer = null;
let estTimer = null;
let onEstimate = null;

const env = new Float32Array(HISTORY);
let envAt = -1;   // newest bin written, counted from the start and never wrapped
let t0 = 0;       // ctx time of bin 0
let lastPoll = 0; // ctx time the last reading was taken at
let level = 0;
const recent = []; // the last few folded readings, for deciding we have settled

// The grid we are currently committed to, and how many estimates in a row have
// argued with it. A beat tracker that believes every reading follows the music
// straight into every fill and every syncopated bar; one that never changes its
// mind sits through the next track. Two in a row is the compromise.
let gridBeat = 0;
let gridPeriod = 0;
let pending = 0;     // where the last rejected reading wanted to put the beat
const JUMP = 0.25;   // of a period: further than this is a disagreement, not drift

const state = {
  active: false,
  // off | asking | listening | quiet | silent | locked | asleep | lost
  //     | denied | missing | busy | insecure | error
  status: 'off',
  detail: '',    // the browser's own words, when it gave any
  bpm: 0,        // what the stage should run at: heard, then folded into range
  heard: 0,      // what was actually out there, before folding
  conf: 0,
  level: 0,
  beatTime: 0,   // ctx time of the most recent beat
  period: 0,     // seconds per beat, as heard
};

export function listenState() {
  return state;
}

/**
 * Why the microphone did not open. The names are worth keeping apart: on a Mac
 * they are the difference between the browser having been refused and the
 * SYSTEM having refused the browser, and those are fixed in different places.
 * Anything unrecognized keeps its own name in `detail`, so a report of it says
 * something rather than nothing.
 */
function failed(err) {
  const name = (err && err.name) || 'Error';
  state.detail = `${name}${err && err.message ? `: ${err.message}` : ''}`;
  state.status = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
    : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'missing'
      // Permission was given and the device still would not open: something
      // else holds it, or macOS has never been asked to let this browser near
      // a microphone at all.
      : name === 'NotReadableError' || name === 'AbortError' ? 'busy'
        : 'error';
  return state.status;
}

// --- the microphone ------------------------------------------------------------

/**
 * Everything worth knowing about the input path, in one line. When a microphone
 * opens and then delivers nothing there is no way to reason about it from the
 * outside: the useful facts are whether the track is live, whether it agrees
 * with the context about the sample rate, and which way the audio was routed.
 */
function inputDetail() {
  const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
  const set = track && track.getSettings ? track.getSettings() : {};
  const parts = [
    `ctx ${Math.round(ctx.sampleRate)}Hz ${ctx.state}`,
    `track ${set.sampleRate ? Math.round(set.sampleRate) + 'Hz' : 'rate?'}`,
    `ch ${set.channelCount || '?'}`,
  ];
  if (track) {
    parts.push(track.readyState + (track.muted ? ' muted' : '') + (track.enabled ? '' : ' disabled'));
  } else {
    parts.push('no track');
  }
  if (otherInputs.length > 1) parts.push(`${otherInputs.length} inputs`);
  return parts.join(', ');
}

/** Which microphone this actually is, in the words the machine uses for it. */
export function inputName() {
  const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
  return (track && track.label) || '';
}

/** Every input the machine has, as {id, label}, once labels are readable. */
export function inputChoices() {
  return otherInputs;
}

/** Which one is live, so a picker can show what is actually being heard. */
export function currentInputId() {
  const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
  const set = track && track.getSettings ? track.getSettings() : {};
  return set.deviceId || '';
}

/**
 * WebKit only. The page's audio session decides what it is allowed to do with
 * audio at all, and 'playback' — which is what the band wants, and sets — bars
 * capture entirely. Everywhere else this is undefined and does nothing.
 */
function setSessionType(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* < iOS 16.4 */ }
}


const WANTED = {
  // All three processors off. They are built to keep a voice intelligible on a
  // call, and each does something ruinous to music: the canceller subtracts
  // whatever the machine is playing, the suppressor treats a steady groove as
  // room noise, and the gain control flattens exactly the dynamics being
  // measured.
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

/**
 * Take a stream, by name if we have been given one. Returns a failure status,
 * or nothing at all if it worked.
 *
 * A page cannot choose which input the browser offers first, and the browser
 * offers whatever the system calls the default — which on a machine with any
 * audio work on it may well be a loopback device with nothing routed into it.
 * Naming one is only possible AFTER a capture has been permitted, because that
 * is when ids and labels become readable, so the honest order is: take what we
 * are given, look at what else there is, and reopen on the right one.
 */
async function openStream(deviceId) {
  const asked = deviceId ? { ...WANTED, deviceId: { exact: deviceId } } : WANTED;
  // If a named device is gone — unplugged, renamed, a stale id from last visit
  // — fall back to whatever the machine will give rather than failing outright.
  const ladder = deviceId
    ? [{ audio: asked }, { audio: WANTED }, { audio: true }]
    : [{ audio: WANTED }, { audio: WANTED }, { audio: true }];

  let refusal = null;
  for (const constraints of ladder) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      return null;
    } catch (err) {
      refusal = err;
      // No amount of rephrasing turns a no into a yes.
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
      if (err && err.name === 'InvalidStateError') setSessionType('play-and-record');
    }
  }
  return failed(refusal);
}

/**
 * Move to another input without dropping the show. Everything downstream is
 * rebuilt around the new stream, and the envelope is thrown away: it describes
 * a different microphone.
 */
export async function useInput(deviceId) {
  if (!state.active) return state.status;
  const old = stream;
  const failure = await openStream(deviceId);
  if (failure) {
    stream = old;
    return failure;
  }
  if (old && old !== stream) for (const t of old.getTracks()) t.stop();
  watchTracks();
  wireUp();
  state.status = 'listening';
  return state.status;
}

/**
 * A machine can take the microphone back — another app claims it, a device is
 * unplugged, a phone takes a call. The analyser then goes on being read and
 * goes on returning nothing, which looks exactly like a silent room, so say
 * what actually happened instead.
 */
function watchTracks() {
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (state.active) state.status = 'lost';
    });
  }
}

/** Build everything that hangs off the stream. Safe to call again on a new one. */
function wireUp() {
  if (source) { try { source.disconnect(); } catch { /* never connected */ } }
  if (silence) { silence.disconnect(); silence = null; }

  // WebKit will hand a MediaStreamAudioSourceNode nothing but silence unless
  // something else is also consuming the stream. Attaching it to a muted audio
  // element is the long-standing way round it, and it costs nothing anywhere
  // else. Muted matters: this is the room, and playing it back out of the
  // speakers the microphone is listening to is a feedback loop.
  if (keepAlive) { try { keepAlive.pause(); } catch { /* already gone */ } keepAlive.remove(); }
  keepAlive = new Audio();
  keepAlive.muted = true;
  keepAlive.playsInline = true;
  // The same stream the source node has, not a copy of it. A copy is a second
  // capture of the device and consumes nothing that the node depends on, which
  // makes the pin decorative — and the pin only exists for the one engine whose
  // node goes silent without it.
  keepAlive.srcObject = stream;
  // In the page, not merely in a variable. A detached element is not reliably
  // played, and an element that is not playing is not consuming the stream,
  // which is the entire point of it being here.
  document.body.appendChild(keepAlive);
  keepAlive.play().catch(() => { /* the graph below usually carries it anyway */ });

  source = ctx.createMediaStreamSource(stream);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  // No smoothing at all. Averaging consecutive frames is the one thing that
  // would blunt the transients this is entirely built to find.
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -95;
  analyser.maxDecibels = -12;
  source.connect(analyser);

  // And onward into the graph, at a gain of exactly zero. An analyser hanging
  // off the end of nothing looks complete and is not: a WebKit graph is pulled
  // from its destination backwards, so a branch with no path to one is never
  // asked for a sample and quietly hands back an empty buffer forever. Which
  // reads, from up here, precisely like a silent room.
  //
  // Zero gain because this is the room: at any other value the microphone would
  // be feeding the speakers it is listening to.
  silence = ctx.createGain();
  silence.gain.value = 0;
  analyser.connect(silence).connect(ctx.destination);

  const bins = analyser.frequencyBinCount;
  spectrum = new Uint8Array(bins);
  previous = new Uint8Array(bins);
  waveform = new Float32Array(analyser.fftSize);
  const binHz = ctx.sampleRate / analyser.fftSize;
  // Below about 40 Hz is rumble and handling noise; above 8 kHz is cymbal wash
  // and hiss. The beat lives in between.
  binLo = Math.max(1, Math.floor(40 / binHz));
  binHi = Math.min(bins, Math.ceil(8000 / binHz));
  bandEdges = BAND_HZ.map((hz) => Math.max(binLo, Math.min(binHi, Math.round(hz / binHz))));
  lookback = analyser.fftSize / 2 / ctx.sampleRate;

  resetEnvelope();
}

/**
 * Give up on an input that has produced nothing at all and take the next one
 * that has not already failed. Only ever moves AWAY from silence, so the worst
 * it can do is arrive somewhere equally quiet and stop.
 */
function moveOffDeadInput() {
  silentSince = 0;
  const here = currentInputId();
  if (here) tried.add(here);
  const next = otherInputs.find((d) => !tried.has(d.id));
  if (!next) return;
  state.status = 'listening';
  useInput(next.id).catch(() => { /* the status will show where it got to */ });
}

/** Forget everything measured. It described a different microphone. */
function resetEnvelope() {
  env.fill(0);
  envAt = -1;
  recent.length = 0;
  gridBeat = 0;
  pending = 0;
  level = 0;
  silentSince = 0;
  t0 = ctx.currentTime;
  lastPoll = t0;
}

/**
 * Take the microphone and start following it. `context` must be the same
 * AudioContext the band runs on, and it must already be running: a suspended
 * context has a frozen currentTime, and every beat time here is quoted in it.
 *
 * Resolves to the status, so the caller can put the reason on screen. Must be
 * called from a gesture, like anything else that asks for a device.
 */
export async function startListening(context, onEstimateFn, ready, preferred) {
  if (state.active) return state.status;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // Which is what a browser tells you on a plain http:// origin, rather than
    // anything being wrong with the machine.
    state.status = 'insecure';
    return state.status;
  }

  ctx = context;
  onEstimate = onEstimateFn || null;
  state.status = 'asking';
  state.detail = '';

  // ASK FIRST, await afterwards. Everything down to the first await here runs
  // inside the gesture that flipped the switch, and it has to: Safari counts a
  // user gesture as spent the moment anything is awaited, so waking the audio
  // context and then awaiting it before asking for the microphone loses the
  // permission the microphone needed. Both are started here, together, and
  // sorted out below.
  //
  // All three processors are turned off. They are built to keep a voice
  // intelligible on a call, and each does something ruinous to music: the
  // canceller subtracts whatever the machine is playing, the suppressor treats
  // a steady groove as room noise, and the gain control flattens exactly the
  // dynamics being measured.

  // WebKit runs the whole page through an audio session, and the band put that
  // session into 'playback' the moment it built its graph — a category which is
  // not permitted to capture anything. It has to be changed BEFORE the
  // microphone is asked for. Afterwards, which is where this used to be, is too
  // late: Safari refuses the request outright with "AudioSession category is
  // not compatible with audio capture". The same line is what gets iOS to open
  // an input at all, so it is doing both jobs.
  setSessionType('play-and-record');

  const opened = await openStream(preferred);
  if (opened) return opened;

  // The context has to be running for any of this to mean anything: every beat
  // time is quoted in its clock, and a suspended one has a frozen clock. But
  // failing outright here is wrong, because the sheet's own button is about to
  // start it — so take the microphone now and let estimate() wait.
  try { await ready; } catch { /* it will be tried again below */ }
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* the show's own start will do it */ }
  }

  watchTracks();

  wireUp();


  // Device labels are hidden until a capture has been permitted, so this is the
  // first moment the machine will say what any of its inputs are called.
  otherInputs = [];
  tried.clear();
  if (navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then((list) => {
      otherInputs = list
        .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Input' }));
    }).catch(() => { /* nothing lost but a nicer message */ });
  }

  state.active = true;
  state.status = 'listening';
  state.conf = 0;
  state.bpm = 0;
  state.heard = 0;
  pollTimer = setInterval(poll, HOP_MS);
  estTimer = setInterval(estimate, EST_MS);
  return state.status;
}

export function stopListening() {
  if (pollTimer) clearInterval(pollTimer);
  if (estTimer) clearInterval(estTimer);
  pollTimer = estTimer = null;
  if (source) source.disconnect();
  if (silence) { silence.disconnect(); silence = null; }
  if (keepAlive) {
    try { keepAlive.pause(); } catch { /* already gone */ }
    keepAlive.srcObject = null;
    keepAlive.remove();
    keepAlive = null;
  }
  // Let go of the device properly. A track left live keeps the recording
  // indicator up and, on a phone, keeps the session in the input category.
  if (stream) for (const track of stream.getTracks()) track.stop();
  setSessionType('playback');
  source = analyser = stream = null;
  onEstimate = null;
  state.active = false;
  state.status = 'off';
  state.conf = 0;
}

// --- the onset envelope --------------------------------------------------------

function poll() {
  if (!analyser) return;

  // How much audio has actually arrived since the last reading. The clock moves
  // in quanta of a few milliseconds and the timer does not, so a good share of
  // these calls land inside the same quantum as the one before: the analyser
  // has nothing new in it, and there is no instant to file a reading under
  // either. Take those out here, before they can become data.
  const now = ctx.currentTime;
  const dt = now - lastPoll;
  if (dt <= 0) return;
  lastPoll = now;

  analyser.getByteFrequencyData(spectrum);

  let flux = 0;
  for (let b = 0; b < bandEdges.length - 1; b++) {
    const lo = bandEdges[b];
    const hi = bandEdges[b + 1];
    let rise = 0;
    for (let i = lo; i < hi; i++) {
      const d = spectrum[i] - previous[i];
      if (d > 0) rise += d;   // only the rises: a note ending is not an onset
    }
    flux += rise / Math.max(1, (hi - lo) * 255);
  }
  flux /= bandEdges.length - 1;
  for (let i = binLo; i < binHi; i++) previous[i] = spectrum[i];

  // Is there anything out there at all. The float waveform, not the byte one: a
  // byte sample is a 128th of full scale, so a quiet room quantizes to the same
  // handful of values as a silent one and reads about as loud either way.
  analyser.getFloatTimeDomainData(waveform);
  let sq = 0;
  for (let i = 0; i < waveform.length; i++) sq += waveform[i] * waveform[i];
  const rms = Math.sqrt(sq / waveform.length);
  // Quick up, slow down. Symmetric smoothing cannot win here: fast enough to
  // answer at once and it collapses in the gap after every kick drum, slow
  // enough to hold through the gaps and it spends the first several seconds
  // climbing up from zero — announcing a silent room to somebody standing in
  // front of a loud one. Rising in a fifth of a second and falling over three
  // is what the question actually wants: has there been sound lately.
  level += (rms - level) * (rms > level ? 0.05 : 0.004);

  // Flux PER SECOND, not per reading. A reading taken 12 ms after the last one
  // has had twice as long to accumulate as one taken after 6, and recording the
  // raw figure writes the timer's stutter into the envelope as though it were
  // something the room did.
  const rate = flux / dt;

  const at = Math.floor((now - lookback - t0) * RATE);
  if (at <= envAt || at < 0) return;
  // The reading stands for the whole stretch it covers, so every bin in that
  // stretch gets it. Bins are never left empty and filled with a zero, which is
  // the obvious thing to do and was in here for a while: whether a bin got
  // skipped depends on where the timer fell against the clock's quanta, and
  // that pattern repeats exactly. It gave the envelope a periodicity of its own
  // that had nothing to do with the room, and this found it and locked to it,
  // and reported a rock steady 83.33 BPM in a room playing nothing but noise.
  // Not an edge case: it is the timer's own fingerprint, always there, always
  // perfectly periodic, and quite happy to outshine the music.
  for (let i = Math.max(envAt + 1, at - HISTORY + 1); i <= at; i++) {
    env[((i % HISTORY) + HISTORY) % HISTORY] = rate;
  }
  envAt = at;
}

// --- the estimate --------------------------------------------------------------

function estimate() {
  if (!state.active || state.status === 'lost') return;

  // A suspended context has a frozen clock, so there is nothing to measure and
  // nowhere to put it. This happens legitimately: the switch can be turned on
  // before the curtain goes up, and on Safari the context may not start until
  // the show itself does. Say so rather than reporting an empty room, and pick
  // up by itself the moment the clock moves.
  if (ctx.state !== 'running') {
    state.status = 'asleep';
    state.conf = 0;
    // The bins between then and now were never filled, and they are not silence.
    t0 = ctx.currentTime;
    lastPoll = t0;
    envAt = -1;
    gridBeat = 0;
    recent.length = 0;
    return;
  }
  if (state.status === 'asleep') state.status = 'listening';
  // Published before the early return below: the loudness is known from the
  // first reading, and it is the one thing worth showing during the six seconds
  // this spends collecting enough envelope to have an opinion about tempo.
  state.level = level;
  if (envAt < WINDOW) return;

  if (level < QUIET) {
    // Worth telling apart. One of these is a room; the other is a microphone
    // that opened and is handing over digital silence, which is a fault at this
    // end and not something the listener can fix by turning the music up.
    state.status = level < SILENT ? 'silent' : 'quiet';
    if (state.status === 'silent') {
      state.detail = inputDetail();
      // An input delivering exact zeros is not a quiet room — a real microphone
      // in a silent house still reads something — so it is not worth waiting on.
      // Walk to the next one rather than sitting on a device that will never
      // say anything, which is otherwise what a visitor gets for accepting the
      // default on a machine that has a loopback device installed.
      if (!silentSince) silentSince = ctx.currentTime;
      else if (ctx.currentTime - silentSince > DEAD_AFTER) moveOffDeadInput();
    } else {
      silentSince = 0;
    }
    state.conf = 0;
    recent.length = 0;
    gridBeat = 0;   // nothing to hold on to; the next music starts a new grid
    return;
  }

  // Pull the window out of the ring, oldest first, and take the mean off. The
  // mean is the difference between "this is where the beats are" and "this is
  // where the sound is", and only the first one has a period.
  const n = WINDOW;
  const start = envAt - n + 1;
  const buf = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const v = env[(start + i) % HISTORY];
    buf[i] = v;
    mean += v;
  }
  mean /= n;
  for (let i = 0; i < n; i++) buf[i] -= mean;

  const ac = new Float32Array(AC_MAX + 1);
  for (let lag = 0; lag <= AC_MAX; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += buf[i] * buf[i - lag];
    // Over the overlap, not the window: without this every long lag is
    // penalized for having had fewer samples to agree over, and the whole
    // curve slopes down toward the slow tempos.
    ac[lag] = s / (n - lag);
  }
  if (!(ac[0] > 0)) return;
  const scale = 1 / ac[0];

  // A true period is hardly ever a whole number of bins. Reading the curve
  // between bins has to be done on the curve's own terms: a straight line
  // between two samples of a peak reads low everywhere between them, worst of
  // all at the halfway point, which is where a period lands about as often as
  // not. That bias alone hands the answer to whichever candidate happens to sit
  // near a whole bin, and it is how three beats of one tempo comes to be
  // mistaken for two of a slower one.
  const acAt = (x) => {
    const i = Math.round(x);
    if (i < 1 || i + 1 > AC_MAX) return 0;
    const f = x - i;
    const y0 = ac[i - 1], y1 = ac[i], y2 = ac[i + 1];
    return (y1 + 0.5 * f * (y2 - y0) + 0.5 * f * f * (y2 - 2 * y1 + y0)) * scale;
  };

  const steps = Math.round((LAG_MAX - LAG_MIN) / LAG_STEP) + 1;
  const score = new Float32Array(steps);
  let bestStep = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < steps; k++) {
    const lag = LAG_MIN + k * LAG_STEP;
    // Fold in the multiples. A candidate at half the true period agrees with
    // the beats it does land on and with nothing in between, so it can look
    // strong on its own; its multiples are what give it away.
    let s = acAt(lag) + 0.5 * acAt(lag * 2) + 0.34 * acAt(lag * 3);
    // And look underneath it. Nearly all of this music is built in halves, so a
    // real beat has a real half-beat below it, while a candidate three eighths
    // long has nothing whatever at one and a half of them. Without this the two
    // are all but indistinguishable, and a fast track gets danced in three
    // against its two.
    s += 0.5 * acAt(lag / 2);
    const octaves = Math.log2((60 * RATE / lag) / PRIOR_BPM);
    s *= Math.exp(-0.5 * (octaves / PRIOR_OCTAVES) ** 2);
    score[k] = s;
    if (s > bestScore) { bestScore = s; bestStep = k; }
  }

  // Even a quarter of a bin is three quarters of a BPM up at the fast end. Fit
  // a parabola through the peak and its neighbors for the rest.
  let lagF = LAG_MIN + bestStep * LAG_STEP;
  if (bestStep > 0 && bestStep < steps - 1) {
    const y0 = score[bestStep - 1], y1 = score[bestStep], y2 = score[bestStep + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) {
      lagF += LAG_STEP * Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / denom));
    }
  }

  // Not the score, which has the multiples and the prior folded into it and so
  // cannot be compared against anything: the plain share of the envelope that
  // repeats at the period we settled on.
  state.conf = Math.max(0, Math.min(1, (acAt(lagF) - CONF_FLOOR) / (CONF_FULL - CONF_FLOOR)));

  const heard = 60 * RATE / lagF;
  const period = lagF / RATE;
  state.heard = heard;
  state.period = period;
  state.bpm = fold(heard);
  state.beatTime = settle(phase(buf, start, lagF), period);

  // One reading is a guess. Hold the same answer three times running and it is
  // a tempo — which also keeps a fill or a key change from throwing the whole
  // parade for a bar.
  recent.push(state.bpm);
  if (recent.length > 3) recent.shift();
  const held = recent.length === 3
    && Math.max(...recent) - Math.min(...recent) < STEADY;

  if (state.conf >= LOCK_CONF && held) {
    state.status = 'locked';
    if (onEstimate) onEstimate(state);
  } else if (state.status !== 'listening') {
    state.status = 'listening';
  }
}

/**
 * Which offset inside the period the beats actually land on. Walks back from
 * the newest bin in strides of one period and adds up what it finds, for every
 * offset in turn; the offset that collects the most is the one the beats are
 * on. Recent strides count for more, so the answer tracks the music rather than
 * averaging over where the beat used to be.
 */
function phase(buf, start, lagF) {
  const p = Math.max(1, Math.round(lagF));
  const energy = new Float32Array(p);
  for (let off = 0; off < p; off++) {
    let e = 0;
    let w = 1;
    for (let b = envAt - off; b >= start; b -= lagF) {
      const i = Math.round(b) - start;
      if (i < 0) break;
      e += buf[i] * w;
      // Barely a taper. Leaning hard on the last couple of beats reads a fill
      // as a change of grid; letting the whole window vote is what makes the
      // offset hold still while the music does something unusual over it.
      w *= 0.96;
    }
    energy[off] = e;
  }

  let best = 0;
  for (let off = 1; off < p; off++) if (energy[off] > energy[best]) best = off;
  // Offsets are 10 ms apart, so the raw answer can only ever be within 5 ms.
  // Fit the peak against its neighbors for the rest, wrapping at the ends: the
  // last offset in a period is next to the first one in the following period.
  let offset = best;
  const y0 = energy[(best - 1 + p) % p];
  const y1 = energy[best];
  const y2 = energy[(best + 1) % p];
  const denom = y0 - 2 * y1 + y2;
  if (denom < 0) offset += Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / denom));

  // Bin index back into audio clock time. The lookback was already taken off
  // when the bin was written, so this is when the sound happened, not when we
  // noticed it.
  let at = t0 + (envAt - offset) / RATE;
  const period = lagF / RATE;
  while (at + period <= ctx.currentTime) at += period;
  return at;
}

/**
 * Hold a grid rather than believing every reading. The comb can be talked into
 * the offbeat by a bar of syncopation, and a phase that jumps a third of a beat
 * and comes back is a lurch that runs through the whole parade. So: a reading
 * near the grid we are on refines it, and a reading far from it is ignored
 * once. Twice in a row and the music really has moved, and we go with it.
 */
function settle(raw, period) {
  // A period that has moved by more than a few percent is not this track any
  // more, and there is no sense holding a grid that belongs to the last one.
  const newTrack = gridPeriod > 0 && Math.abs(Math.log2(period / gridPeriod)) > 0.08;
  if (!gridBeat || !(period > 0) || newTrack) {
    gridBeat = raw;
    gridPeriod = period;
    pending = 0;
    return raw;
  }
  // How far this reading is from the beat of our grid nearest to it, which is
  // what it ought to be a small correction to.
  const off = (a, b) => Math.abs(a - (b + Math.round((a - b) / period) * period));

  if (off(raw, gridBeat) > period * JUMP) {
    // Two readings have to agree WITH EACH OTHER, not merely disagree with the
    // grid, before the grid moves. Counting bare disagreements instead lets two
    // readings that point in different directions combine into a move, and then
    // the reading after that disagrees with the new grid, and the beat flips
    // back and forth between two places for as long as the music stays hard.
    const backsUpLast = pending && off(raw, pending) <= period * JUMP;
    if (!backsUpLast) {
      pending = raw;
      let at = gridBeat + Math.round((raw - gridBeat) / period) * period;
      while (at + period <= ctx.currentTime) at += period;
      gridBeat = at;
      gridPeriod = period;
      return at;
    }
  }
  pending = 0;
  gridBeat = raw;
  gridPeriod = period;
  return raw;
}

/**
 * Put a heard tempo where the show can dance to it. Halving or doubling keeps
 * every beat a beat, so a track at 170 is danced at 85 and one at 60 at 120,
 * and in both cases the chairs still land on the music.
 */
function fold(bpm) {
  let best = bpm;
  let bestCost = Infinity;
  for (let k = -2; k <= 2; k++) {
    const c = bpm * Math.pow(2, k);
    if (c < HARD_MIN || c > HARD_MAX) continue;
    // How far outside the window the show likes, in octaves, and then a much
    // gentler pull toward the middle of it to settle ties.
    const out = c < SHOW_MIN ? Math.log2(SHOW_MIN / c)
      : c > SHOW_MAX ? Math.log2(c / SHOW_MAX) : 0;
    const cost = out * 4 + Math.abs(Math.log2(c / SHOW_MID)) * 0.25;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return Math.max(HARD_MIN, Math.min(HARD_MAX, best));
}
