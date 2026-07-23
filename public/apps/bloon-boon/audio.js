// Bloon Boon — synthesized voices.
//
// Every balloon color has its own procedurally-generated sound (no audio
// files): a bird call, a car horn, a slide whistle, a toy piano, a glass bell,
// a kazoo. They're stylised, not photoreal — oscillators, pitch glides, and
// additive partials with tuned envelopes.
//
// iOS is the fussy part (see the repo's "iOS Web Audio recipe" note): the
// AudioContext must be created inside a real user gesture, resume() often needs
// a retry, and navigator.audioSession has to be told this is 'playback' or the
// hardware mute switch silences everything. init() does all three.

const BloonAudio = (function () {
  let ctx = null;
  let master = null;      // master gain → compressor → destination
  let ready = false;

  // Small helper: a cached white-noise buffer for plucks / chirps.
  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    return src;
  }

  function init() {
    if (ctx) { resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();

    // Tell iOS this is playback audio so it ignores the ringer/mute switch.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) { /* not supported — fine */ }

    // master → gentle compressor keeps a pile of simultaneous honks from
    // clipping → destination.
    master = ctx.createGain();
    master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);

    // Unlock: play a one-sample silent buffer inside this gesture.
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(ctx.destination);
    s.start(0);

    resume();
    ready = true;
  }

  // Retry resume() a few times — the first call inside a gesture sometimes
  // resolves to 'suspended' anyway on iOS.
  function resume() {
    if (!ctx) return;
    let tries = 0;
    const tick = () => {
      if (!ctx || ctx.state === 'running') return;
      ctx.resume().catch(() => {});
      if (++tries < 8) setTimeout(tick, 120);
    };
    tick();
  }

  // Keep audio alive across Safari's aggressive suspension. Desktop Safari
  // won't treat a `pointerdown` as a valid activation for resuming an
  // AudioContext (Chromium will), AND it suspends the context on tab blur /
  // idle. So we listen for EVERY gesture (pointer/mouse/click/touch/key) for the
  // life of the page and re-run init() — which creates the context the first
  // time and resumes it (in-gesture, the only thing Safari accepts) every time
  // after. Listeners are intentionally never removed, so a context that Safari
  // later suspends is revived by the player's very next tap.
  function attachUnlock() {
    const evts = ['pointerdown', 'pointerup', 'mousedown', 'click', 'touchend', 'keydown'];
    const un = () => init();
    evts.forEach((e) => window.addEventListener(e, un, true));
    // Also try to resume whenever the tab becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resume();
    });
  }

  // Schedule `node.disconnect()` for every node in the list a bit after `when`,
  // so each voice's nodes are torn down once its tail has rung out — no leaks.
  function cleanup(nodes, when) {
    const ms = Math.max(0, (when - ctx.currentTime) * 1000) + 120;
    setTimeout(() => nodes.forEach((n) => { try { n.disconnect(); } catch (e) {} }), ms);
  }

  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  // --- voices -------------------------------------------------------------
  // Each schedules its sound starting at `t0` and connects into `out`.

  // Bird: two or three quick sine chirps that sweep up then down, with vibrato.
  function bird(out, t0) {
    const base = pick([1400, 1700, 2100, 2500]);
    const chirps = 2 + ((Math.random() * 2) | 0);
    let t = t0;
    for (let c = 0; c < chirps; c++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      const f = base * (0.9 + Math.random() * 0.3);
      o.frequency.setValueAtTime(f * 0.7, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.35, t + 0.05);
      o.frequency.exponentialRampToValueAtTime(f * 0.9, t + 0.12);
      // fast vibrato for a warble
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 45;
      lg.gain.value = f * 0.03;
      lfo.connect(lg); lg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g); g.connect(out);
      o.start(t); lfo.start(t);
      o.stop(t + 0.16); lfo.stop(t + 0.16);
      cleanup([o, g, lfo, lg], t + 0.16);
      t += 0.13 + Math.random() * 0.05;
    }
  }

  // Car horn: a sustained dual-tone (a major third apart), buzzy sawtooths
  // through a soft waveshaper. Sometimes a short double honk.
  function horn(out, t0) {
    const root = pick([196, 220, 247]); // low, obnoxious
    const honks = Math.random() < 0.4 ? [[0, 0.16], [0.24, 0.42]] : [[0, 0.5]];
    honks.forEach(([off, dur]) => {
      const t = t0 + off;
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(257);
      for (let i = 0; i < 257; i++) {
        const x = (i / 256) * 2 - 1;
        curve[i] = Math.tanh(x * 2.2);
      }
      shaper.curve = curve;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.105, t + 0.012); // quieted twice: 0.32 → 0.21 → 0.105; snappy onset
      g.gain.setValueAtTime(0.105, t + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      shaper.connect(g); g.connect(out);
      [1, 1.26, 2.001].forEach((mult, i) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = root * mult;
        o.detune.value = (i - 1) * 4;
        o.connect(shaper);
        o.start(t); o.stop(t + dur + 0.02);
        cleanup([o], t + dur + 0.02);
      });
      cleanup([shaper, g], t + dur + 0.02);
    });
  }

  // Slide whistle: a breathy near-sine that swoops in pitch (up, down, or
  // up-and-back), with a little vibrato and a whisper of air noise on top.
  function slide(out, t0) {
    const dur = 0.5;
    const lo = pick([392, 440, 494]);
    const hi = lo * pick([1.9, 2.2, 2.5]);         // swoop spans roughly an octave
    const shape = pick(['up', 'down', 'updown']);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f = osc.frequency;
    if (shape === 'up') {
      f.setValueAtTime(lo, t0);
      f.exponentialRampToValueAtTime(hi, t0 + dur * 0.82);
    } else if (shape === 'down') {
      f.setValueAtTime(hi, t0);
      f.exponentialRampToValueAtTime(lo, t0 + dur * 0.82);
    } else {
      f.setValueAtTime(lo, t0);
      f.exponentialRampToValueAtTime(hi, t0 + dur * 0.42);
      f.exponentialRampToValueAtTime(lo * 1.08, t0 + dur * 0.88);
    }

    // A touch of vibrato for the hand-held wobble.
    const vib = ctx.createOscillator();
    const vg = ctx.createGain();
    vib.frequency.value = 5.5; vg.gain.value = 9;
    vib.connect(vg); vg.connect(f);

    // A faint sparkle harmonic gives the whistle a little body.
    const oct = ctx.createOscillator();
    const octg = ctx.createGain();
    oct.type = 'sine'; oct.frequency.value = lo; octg.gain.value = 0.08;
    // track the fundamental an octave up via detune (+1200 cents)
    oct.detune.value = 1200;
    if (shape === 'up') { oct.frequency.setValueAtTime(lo, t0); oct.frequency.exponentialRampToValueAtTime(hi, t0 + dur * 0.82); }
    else if (shape === 'down') { oct.frequency.setValueAtTime(hi, t0); oct.frequency.exponentialRampToValueAtTime(lo, t0 + dur * 0.82); }
    else { oct.frequency.setValueAtTime(lo, t0); oct.frequency.exponentialRampToValueAtTime(hi, t0 + dur * 0.42); oct.frequency.exponentialRampToValueAtTime(lo * 1.08, t0 + dur * 0.88); }

    // Breath: quiet high-passed noise, gated with the note.
    const air = noise();
    const airf = ctx.createBiquadFilter();
    airf.type = 'highpass'; airf.frequency.value = 2500;
    const airg = ctx.createGain();
    airg.gain.setValueAtTime(0.0001, t0);
    airg.gain.exponentialRampToValueAtTime(0.05, t0 + 0.05);
    airg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    air.connect(airf); airf.connect(airg); airg.connect(out);

    // Main envelope: soft breathy onset, then release.
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.34, t0 + 0.02); // quick onset so the tap feels immediate
    g.gain.setValueAtTime(0.34, t0 + dur - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g); oct.connect(octg); octg.connect(g); g.connect(out);

    osc.start(t0); vib.start(t0); oct.start(t0); air.start(t0);
    osc.stop(t0 + dur + 0.02); vib.stop(t0 + dur + 0.02); oct.stop(t0 + dur + 0.02); air.stop(t0 + dur + 0.02);
    cleanup([osc, vib, vg, oct, octg, air, airf, airg, g], t0 + dur + 0.02);
  }

  // Toy piano: bright, slightly inharmonic struck-bar partials with a quick
  // attack click and fast decay.
  function piano(out, t0) {
    const f = pick([523.25, 587.33, 659.25, 783.99, 880.0]);
    const partials = [
      [1.0, 0.6], [2.0, 0.25], [3.01, 0.2], [4.7, 0.12], [6.8, 0.06],
    ];
    partials.forEach(([mult, amp]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = mult === 1.0 ? 'triangle' : 'sine';
      o.frequency.value = f * mult;
      const dur = 0.5 / Math.sqrt(mult); // higher partials die faster
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + dur + 0.02);
      cleanup([o, g], t0 + dur + 0.02);
    });
    // attack click
    const n = noise();
    const ng = ctx.createGain();
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = f * 3; nf.Q.value = 0.8;
    ng.gain.setValueAtTime(0.25, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
    n.connect(nf); nf.connect(ng); ng.connect(out);
    n.start(t0); n.stop(t0 + 0.04);
    cleanup([n, ng, nf], t0 + 0.05);
  }

  // Glass bell: pure inharmonic sine partials with a long shimmering decay.
  function bell(out, t0) {
    const f = pick([659.25, 783.99, 880.0, 987.77]);
    const partials = [[1.0, 0.5], [2.76, 0.3], [5.4, 0.16], [8.9, 0.08]];
    partials.forEach(([mult, amp], i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const dur = 1.6 / (1 + i * 0.6);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + dur + 0.02);
      cleanup([o, g], t0 + dur + 0.02);
    });
  }

  // Kazoo: a nasal buzzy sawtooth through a resonant bandpass, with vibrato —
  // that comedic paper-and-comb "mmmm-aaah".
  function kazoo(out, t0) {
    const f = pick([294, 330, 370, 415]);
    const dur = 0.45;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    // little pitch scoop up at the start
    o.frequency.setValueAtTime(f * 0.85, t0);
    o.frequency.exponentialRampToValueAtTime(f, t0 + 0.08);

    const vib = ctx.createOscillator();
    const vg = ctx.createGain();
    vib.frequency.value = 6.5; vg.gain.value = f * 0.02;
    vib.connect(vg); vg.connect(o.frequency);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f * 4; bp.Q.value = 5;
    const bp2 = ctx.createBiquadFilter();
    bp2.type = 'peaking'; bp2.frequency.value = f * 2.5; bp2.Q.value = 3; bp2.gain.value = 8;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.015);
    g.gain.setValueAtTime(0.3, t0 + dur - 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    o.connect(bp); bp.connect(bp2); bp2.connect(g); g.connect(out);
    o.start(t0); vib.start(t0);
    o.stop(t0 + dur + 0.02); vib.stop(t0 + dur + 0.02);
    cleanup([o, vib, vg, bp, bp2, g], t0 + dur + 0.02);
  }

  // --- Level 2 voices: brighter, more electronic ------------------------------

  // Laser zap: a fast downward pitch sweep on a sawtooth, quick decay.
  function zap(out, t0) {
    const f0 = pick([1400, 1800, 2200]);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.14, t0 + 0.18);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + 0.22);
    cleanup([o, lp, g], t0 + 0.22);
  }

  // Water droplet: a sine that drops fast in pitch, short and round.
  function drop(out, t0) {
    const f = pick([900, 1100, 1300, 1600]);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t0);
    o.frequency.exponentialRampToValueAtTime(f * 0.32, t0 + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + 0.24);
    cleanup([o, g], t0 + 0.24);
  }

  // Marimba: warm wooden mallet — a fundamental with a strong 4th-harmonic
  // overtone (the marimba's signature), fast attack, medium decay.
  function marimba(out, t0) {
    const f = pick([330, 392, 440, 523]);
    [[1.0, 0.5, 0.5], [4.0, 0.18, 0.28], [9.2, 0.05, 0.12]].forEach(([mult, amp, dur]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * mult;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + dur + 0.02);
      cleanup([o, g], t0 + dur + 0.02);
    });
  }

  // Bubble: a sine that pops up in pitch, very short.
  function boop(out, t0) {
    const f = pick([400, 500, 600, 720]);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 0.6, t0);
    o.frequency.exponentialRampToValueAtTime(f * 1.7, t0 + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    o.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + 0.12);
    cleanup([o, g], t0 + 0.12);
  }

  // Siren: a nasal triangle sweeping up then down through a resonant bandpass.
  function siren(out, t0) {
    const f = pick([500, 600, 700]);
    const dur = 0.3;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, t0);
    o.frequency.linearRampToValueAtTime(f * 1.5, t0 + 0.12);
    o.frequency.linearRampToValueAtTime(f, t0 + 0.26);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
    g.gain.setValueAtTime(0.28, t0 + dur - 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(bp); bp.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + dur + 0.02);
    cleanup([o, bp, g], t0 + dur + 0.02);
  }

  // Cowbell: the classic 808 — two square tones a fifth-ish apart through a
  // bandpass, with a fast metallic decay.
  function cowbell(out, t0) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.45, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2640; bp.Q.value = 1.2;
    bp.connect(g); g.connect(out);
    [540, 800].forEach((fr) => {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = fr;
      o.connect(bp);
      o.start(t0); o.stop(t0 + 0.2);
      cleanup([o], t0 + 0.2);
    });
    cleanup([bp, g], t0 + 0.2);
  }

  // Level-up fanfare: a quick bright ascending arpeggio (played on clearing a
  // level), each note a triangle + a detuned square for a synthy shimmer.
  function levelup(out, t0) {
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      const t = t0 + i * 0.09;
      const o = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const o2g = ctx.createGain();
      const g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      o2.type = 'square'; o2.frequency.value = f; o2.detune.value = 7;
      o2g.gain.value = 0.35;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g); o2.connect(o2g); o2g.connect(g); g.connect(out);
      o.start(t); o2.start(t);
      o.stop(t + 0.32); o2.stop(t + 0.32);
      cleanup([o, o2, o2g, g], t + 0.32);
    });
  }

  const VOICES = {
    bird, horn, slide, piano, bell, kazoo,           // Level 1
    zap, drop, marimba, boop, siren, cowbell,        // Level 2
    levelup,                                          // transitions
  };

  // Play a voice. `vol` (0..1) scales it — collisions blend voices softly.
  function play(voice, vol) {
    if (!ctx) return;
    // If the context has drifted to 'suspended' (tab blur, browser policy),
    // kick a resume — this hit is dropped, but the next one will sound.
    if (ctx.state !== 'running') { resume(); return; }
    if (!ready) return;
    const fn = VOICES[voice];
    if (!fn) return;
    const t = ctx.currentTime + 0.001;
    if (vol === undefined || vol >= 0.999) { fn(master, t); return; }
    // Route this one hit through its own gain node, then tear it down well
    // after the longest possible tail (~1.6s for the bell).
    const g = ctx.createGain();
    g.gain.value = Math.max(0, vol);
    g.connect(master);
    fn(g, t);
    cleanup([g], t + 3.0);
  }

  attachUnlock(); // start listening for the first gesture right away

  attachUnlock(); // start listening for the first gesture right away

  return { init, resume, play, isReady: () => ready && ctx && ctx.state === 'running' };
})();
