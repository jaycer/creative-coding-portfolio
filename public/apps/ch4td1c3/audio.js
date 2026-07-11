// ch4td1c3 — dice roll sounds, all synthesized (no audio files).
//
// One roll = a short train of plastic clicks whose gaps stretch out as the die
// loses energy, capped with a low knock when it lands — resin on a leather
// pad. Each click is a burst of bandpass-filtered noise (bright snap) layered
// with a quieter mid-band burst (body); the knock is a pitch-dropping sine.
// Rolling all seven just overlaps seven trains at slight staggers, which is
// exactly what a handful of thrown dice sounds like.
//
// iOS is the fussy part (see the repo's "iOS Web Audio recipe" note): the
// AudioContext must be created inside a real user gesture, resume() often
// needs a retry, and navigator.audioSession has to be told this is 'playback'
// or the hardware mute switch silences everything. init() does all three.

const DiceAudio = (function () {
  let ctx = null;
  let master = null;      // master gain → compressor → destination
  let ready = false;
  let volume = 0.8;       // user volume 0..1 (the overlay slider); 0 = mute

  // Squared taper reads as even loudness steps; 1.3 puts the 80% default
  // right at the old fixed master level (1.3 * 0.8^2 ≈ 0.83).
  function masterGain() { return 1.3 * volume * volume; }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    if (master) master.gain.value = masterGain();
  }

  // Cached white-noise buffer all the clicks slice from.
  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
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

    // master → gentle compressor so seven dice at once don't clip.
    master = ctx.createGain();
    master.gain.value = masterGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.2;
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

  // Safari suspends contexts on blur/idle and only accepts an in-gesture
  // resume, so listen for every gesture forever and re-run init() each time.
  function attachUnlock() {
    const evts = ['pointerdown', 'pointerup', 'mousedown', 'click', 'touchend', 'keydown'];
    const un = () => init();
    evts.forEach((e) => window.addEventListener(e, un, true));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resume();
    });
  }

  // Disconnect every node a bit after `when` so voices never leak.
  function cleanup(nodes, when) {
    const ms = Math.max(0, (when - ctx.currentTime) * 1000) + 120;
    setTimeout(() => nodes.forEach((n) => { try { n.disconnect(); } catch (e) {} }), ms);
  }

  // Route a source chain out through an optional stereo pan.
  function outNode(pan, nodes) {
    if (ctx.createStereoPanner) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = Math.max(-1, Math.min(1, pan));
      pn.connect(master);
      nodes.push(pn);
      return pn;
    }
    return master;
  }

  // One click: bright noise snap + a quieter mid-band body.
  function click(t, vol, pan) {
    const nodes = [];
    const out = outNode(pan, nodes);

    const snap = noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700 + Math.random() * 1600;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
    snap.connect(bp); bp.connect(g); g.connect(out);
    snap.start(t); snap.stop(t + 0.04);

    const body = noise();
    const bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.frequency.value = 450 + Math.random() * 300;
    bp2.Q.value = 1.4;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(vol * 0.45, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    body.connect(bp2); bp2.connect(g2); g2.connect(out);
    body.start(t); body.stop(t + 0.05);

    cleanup([snap, bp, g, body, bp2, g2, ...nodes], t + 0.06);
  }

  // Landing knock: a sine that drops in pitch as it dies, plus a last click.
  function knock(t, vol, pan) {
    const nodes = [];
    const out = outNode(pan, nodes);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 165 + Math.random() * 70;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.1);
    cleanup([o, g, ...nodes], t + 0.1);
    click(t, vol * 0.7, pan);
  }

  // One die's tumble, starting `delay` seconds from now.
  function roll(delay, isRetry) {
    if (!ctx) return;
    if (ctx.state !== 'running') {
      resume();
      // The very first tap races the context's resume(); try once more so the
      // opening roll isn't silent — 180ms late still lands inside the tumble.
      if (!isRetry) setTimeout(() => roll(delay, true), 180);
      return;
    }
    const pan = (Math.random() * 2 - 1) * 0.55;
    const t0 = ctx.currentTime + 0.02 + Math.max(0, delay || 0);
    const clicks = 4 + ((Math.random() * 2) | 0);
    let tt = 0;
    let gap = 0.035 + Math.random() * 0.025;
    for (let i = 0; i < clicks; i++) {
      const p = i / (clicks - 1);
      click(t0 + tt,
            0.13 + 0.1 * p + Math.random() * 0.04,
            pan + (Math.random() - 0.5) * 0.25);
      tt += gap;
      gap *= 1.5 + Math.random() * 0.25; // the tumble slows as energy bleeds off
    }
    knock(t0 + tt + 0.01, 0.4 + Math.random() * 0.12, pan);
  }

  // One clack at the current volume — feedback while dragging the slider.
  function preview() {
    if (!ctx || ctx.state !== 'running') return;
    click(ctx.currentTime + 0.01, 0.3, 0);
  }

  attachUnlock(); // start listening for the first gesture right away

  return { init, resume, roll, setVolume, preview, isReady: () => ready && ctx && ctx.state === 'running' };
})();
