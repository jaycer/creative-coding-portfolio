// Shared header volume for the sub-apps that make sound.
//
// Drops a speaker icon + slider into the app's ".bar" header, so every noisy
// app in the gallery is silenced and unsilenced the same way, in the same
// place. Self-contained: it injects its own CSS and markup, so an app only
// needs one script tag ahead of its own scripts:
//
//   <script src="../shared/volume.js"></script>
//   <script src="../shared/volume.js" data-push></script>   // right-align it
//
// It starts at 0 — silent — the first time you open an app, deliberately: these
// open from a gallery index, often several tabs at a time, and a piece that
// starts playing at you is a piece you close. Sound is opt-in, and the
// crossed-out speaker is there to say so.
//
// After that the level is remembered per app in localStorage, so a refresh
// comes back where you left it. Silence is only ever the default, never a
// correction: 0 is stored like any other level, so an app you deliberately
// muted stays muted too.
//
// The app wires itself up through the global:
//
//   HeaderVolume.onGesture(startAudio);           // build/resume the context
//   HeaderVolume.onChange((gain) => setVolume(gain));
//
// onGesture fires on pointerup and on keyboard commits, never on pointerdown:
// per the repo's iOS Web Audio note, iOS only grants audio activation when a
// gesture *completes*, so resume() from a pointerdown handler silently no-ops
// and the context stays suspended.
//
// Remembering the level has a cost, and it is the reason for the "Tap to Hear"
// button: a reload comes back showing 70 and playing nothing, because browsers
// only hand out audio on a completed gesture and a page load is not one. macOS
// Safari does the same thing mid-session, suspending a context the moment its
// tab goes to the background. Either way the control would be claiming sound
// that is not coming out, so while it would be lying the control is covered
// with a button that says what to do about it. See needsGesture() below.
(function () {
  'use strict';

  var script = document.currentScript;
  var PUSH = script && script.hasAttribute('data-push');
  var LABEL = (script && script.getAttribute('data-label')) || 'Volume';

  // Slider position -> gain. Ear response is closer to a power law than to the
  // linear track, so without a curve the whole usable range is crammed into the
  // bottom third of the travel. 1.5 matches the faders already in Burnt Crust.
  var CURVE = 1.5;
  // Where the icon lands when you click it to unmute from silence. Loud enough
  // to be unmistakably on, short of the top so there is somewhere left to go.
  var DEFAULT_ON = 70;

  // Remembered per app, not per gallery: every sub-app is its own page on one
  // origin, so a single shared key would have Sleep Noise and Chair Pile
  // fighting over one number. The slug off the URL matches how the rest of the
  // repo keys its settings (ch4td1c3-theme, hey-chair-input).
  var KEY = (script && script.getAttribute('data-key')) || (function () {
    var m = location.pathname.match(/\/apps\/([^/]+)\//);
    return 'volume:' + (m ? m[1] : 'app');
  })();

  /** The stored level, or null if this app has never been given one. */
  function stored() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw === null) return null;
      var n = parseInt(raw, 10);
      return isNaN(n) ? null : Math.max(0, Math.min(100, n));
    } catch (e) { return null; }   // private window, or storage switched off
  }

  // Dragging fires `input` continuously, and every one of those is a synchronous
  // write on the main thread. Coalesce them: the level that matters is the one
  // the drag ends on.
  var saveTimer = null;
  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try { localStorage.setItem(KEY, String(percent)); } catch (e) { /* nothing to be done */ }
    }, 200);
  }

  // See the note by the slider rules: the range input needs to outweigh the
  // host app's own `input[type="range"]` styling, so every rule for it is
  // written through this three-class prefix.
  var R = '.bar .bar-vol .bar-vol__range';
  // And the same for the "Tap to Hear" button: several of these bars style
  // `.bar button` for their own pills, which outweighs a lone class.
  var P = '.bar .bar-vol .bar-vol__prompt';

  var CSS =
    '.bar-vol{position:relative;pointer-events:auto;display:inline-flex;align-items:center;gap:7px;' +
      'flex-shrink:0;color:inherit;-webkit-tap-highlight-color:transparent}' +
    '.bar-vol.push{margin-left:auto}' +
    // The icon is a button, but it should read as part of the control, not as
    // another pill next to the Save/Load ones.
    '.bar-vol__btn{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;' +
      'width:26px;height:26px;padding:0;margin:0;border:0;border-radius:6px;' +
      'background:none;color:inherit;cursor:pointer;opacity:.75;' +
      'transition:opacity .15s ease,background .15s ease}' +
    '.bar-vol__btn:hover{opacity:1;background:rgba(128,128,128,.18)}' +
    '.bar-vol__btn:focus-visible{outline:2px solid currentColor;outline-offset:1px}' +
    // Some apps take the output away for a while — Hey Chair goes silent to
    // listen to the room. The control says so rather than lying about it.
    '.bar-vol[data-off]{opacity:.35}' +
    '.bar-vol[data-off] .bar-vol__btn,.bar-vol[data-off] .bar-vol__range{cursor:default}' +
    '.bar-vol[data-off] .bar-vol__btn:hover{background:none;opacity:.55}' +
    '.bar-vol__btn svg{width:19px;height:19px;display:block;fill:none;stroke:currentColor;' +
      'stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
    '.bar-vol__cone{fill:currentColor;stroke-width:1.4}' +
    // Silent is the default state, so it has to be legible at a glance rather
    // than a subtlety: the whole control dims and the cone gets a cross.
    '.bar-vol[data-level="0"] .bar-vol__btn{opacity:.55}' +
    '.bar-vol__wave,.bar-vol__cross{opacity:0;transition:opacity .12s ease}' +
    '.bar-vol[data-level="0"] .bar-vol__cross{opacity:1}' +
    '.bar-vol[data-level="1"] .bar-vol__wave--near{opacity:1}' +
    '.bar-vol[data-level="2"] .bar-vol__wave{opacity:1}' +
    // The slider. Everything is drawn in currentColor so the control picks up
    // whatever palette the host app's bar already sets.
    //
    // Every slider rule is written `.bar .bar-vol .bar-vol__range`, three
    // classes deep, and that is not decoration. Half these apps style
    // `input[type="range"]` page-wide to look like their own hardware — Burnt
    // Crust's rack faders, Sleep Noise's round caps — and an attribute selector
    // outweighs a single class, so a plain `.bar-vol__range` loses and the
    // header sprouts a 24px mixer cap. Three classes clear those rules and
    // their `:focus-visible` variants both. The control only ever mounts inside
    // `.bar`, so leaning on it is a fact about the markup, not a hack.
    R + '{pointer-events:auto;-webkit-appearance:none;appearance:none;' +
      'display:inline-block;width:72px;height:18px;margin:0;padding:0;' +
      'background:none;color:inherit;cursor:pointer;vertical-align:middle;touch-action:none}' +
    R + ':focus{outline:none}' +
    R + ':focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:4px}' +
    // The track is drawn twice: a flat rgba first for engines without
    // color-mix, then the filled gradient, which those engines drop whole.
    R + '::-webkit-slider-runnable-track{background:rgba(128,128,128,.45);' +
      'background:linear-gradient(to right,currentColor 0 var(--vol-p,0%),' +
        'color-mix(in srgb,currentColor 22%,transparent) var(--vol-p,0%) 100%);' +
      'height:4px;border-radius:2px;border:0;box-shadow:none}' +
    R + '::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;' +
      'margin-top:-4px;border-radius:50%;background:currentColor;border:0;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.45);cursor:pointer}' +
    R + '::-moz-range-track{background:rgba(128,128,128,.45);' +
      'background:linear-gradient(to right,currentColor 0 var(--vol-p,0%),' +
        'color-mix(in srgb,currentColor 22%,transparent) var(--vol-p,0%) 100%);' +
      'height:4px;border-radius:2px;border:0;box-shadow:none}' +
    R + '::-moz-range-thumb{width:12px;height:12px;border-radius:50%;' +
      'background:currentColor;border:0;box-shadow:0 1px 3px rgba(0,0,0,.45);cursor:pointer}' +
    // The "Tap to Hear" button: a pill sitting on top of the whole control,
    // icon and track both. Covering them is the point — a slider you can read
    // but that is not doing anything is the problem being fixed, and a tap
    // anywhere on the control is the gesture that fixes it. Drawn in
    // currentColor over a wash of the same, so it belongs to whatever palette
    // the host bar sets without knowing anything about it.
    // What is underneath goes invisible rather than away: it still holds the
    // width, so the pill is the size of the control it stands in for and the
    // bar does not shuffle when the two swap.
    '.bar-vol[data-prompt] .bar-vol__btn,.bar-vol[data-prompt] .bar-vol__range{visibility:hidden}' +
    // Inset vertically but never horizontally: the pill is exactly as wide as
    // the control it covers, so it cannot push a full phone bar into a scroll
    // no matter which app it lands in.
    P + '{position:absolute;inset:-3px 0;z-index:1;' +
      'display:inline-flex;align-items:center;justify-content:center;' +
      'padding:0 7px;margin:0;border-radius:999px;cursor:pointer;white-space:nowrap;' +
      'background:rgba(128,128,128,.42);' +
      'background:color-mix(in srgb,currentColor 16%,transparent);' +
      'border:1px solid rgba(128,128,128,.6);' +
      'border:1px solid color-mix(in srgb,currentColor 42%,transparent);' +
      '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);' +
      'color:inherit;font:inherit;font-size:11px;font-weight:600;line-height:1;' +
      'letter-spacing:.02em;box-shadow:none;animation:bar-vol-in .18s ease both}' +
    P + '[hidden]{display:none}' +
    P + ':hover{background:rgba(128,128,128,.55);' +
      'background:color-mix(in srgb,currentColor 24%,transparent)}' +
    P + ':focus-visible{outline:2px solid currentColor;outline-offset:2px}' +
    '@keyframes bar-vol-in{from{opacity:0}to{opacity:1}}' +
    '@media (prefers-reduced-motion:reduce){' + P + '{animation:none}}' +
    // Phone bars are already full. The track gives way; the icon never does,
    // because on a phone the icon is the whole unmute affordance.
    '@media (max-width:600px){.bar-vol{gap:5px}' + R + '{width:52px}' +
      P + '{font-size:10.5px;padding:0 5px}}' +
    '@media (max-width:380px){' + R + '{width:40px}' +
      P + '{font-size:10px;padding:0 2px;letter-spacing:0}}';

  var SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path class="bar-vol__cone" d="M4 9.2h3.4L12 5.2v13.6l-4.6-4H4z"/>' +
      '<path class="bar-vol__wave bar-vol__wave--near" d="M15.4 9.4a3.7 3.7 0 0 1 0 5.2"/>' +
      '<path class="bar-vol__wave" d="M18 7a7.2 7.2 0 0 1 0 10"/>' +
      '<path class="bar-vol__cross" d="M15.6 9.6l4.8 4.8"/>' +
      '<path class="bar-vol__cross" d="M20.4 9.6l-4.8 4.8"/>' +
    '</svg>';

  var PROMPT = (script && script.getAttribute('data-prompt')) || 'Tap to Hear';

  var changeFns = [];
  var gestureFns = [];
  var percent = 0;
  var lastOn = DEFAULT_ON;   // where the icon toggle returns you to
  var root = null, input = null, btn = null, prompt = null;

  // ------------------------------------------------------------- is it audible
  // Nothing is asked of the app for this. Every context a page plays through is
  // built by one of these two constructors, so wrapping them here — which
  // happens before any app script runs, since this file is loaded ahead of them
  // — is enough to see all of them, however late they appear and however many
  // there are. A Proxy is used rather than a wrapper function so that
  // `instanceof`, subclassing and the statics all keep working.
  var seen = [];   // [{ctx, ran}] — `ran` is "has been running at least once"

  function track(ctx) {
    for (var i = 0; i < seen.length; i++) if (seen[i].ctx === ctx) return ctx;
    var rec = { ctx: ctx, ran: ctx.state === 'running' };
    seen.push(rec);
    try {
      ctx.addEventListener('statechange', function () {
        if (ctx.state === 'running') rec.ran = true;
        refresh();
      });
    } catch (e) { /* an engine without the event still gets the poll-free checks */ }
    refresh();
    return ctx;
  }

  (function hookAudioContext() {
    if (typeof Proxy !== 'function' || typeof Reflect !== 'object') return;
    var names = ['AudioContext', 'webkitAudioContext'];
    var origs = [], proxies = [];
    for (var i = 0; i < names.length; i++) {
      var C = window[names[i]];
      if (typeof C !== 'function') continue;
      // Safari has both names pointing at one constructor; patch it once and
      // hang the same proxy off both, or the second pass wraps the first.
      var at = origs.indexOf(C);
      if (at === -1) {
        at = origs.length;
        origs.push(C);
        proxies.push(new Proxy(C, {
          construct: function (Target, args, NewTarget) {
            return track(Reflect.construct(Target, args, NewTarget));
          },
        }));
      }
      try { window[names[i]] = proxies[at]; } catch (e) { /* frozen global: leave it alone */ }
    }
  })();

  /** Is any context actually running, i.e. can this page make a sound right now? */
  function audible() {
    for (var i = 0; i < seen.length; i++) if (seen[i].ctx.state === 'running') return true;
    return false;
  }

  /** A context that was playing and has had the output taken away from it. */
  function interrupted() {
    for (var i = 0; i < seen.length; i++) {
      var s = seen[i].ctx.state;
      if (seen[i].ran && s !== 'running' && s !== 'closed') return true;
    }
    return false;
  }

  var unlockable = true;   // apps whose sound needs more than this control say so

  /**
   * Should the control be covered by "Tap to Hear"? Only when it would be
   * telling the user something untrue and a tap on it is the fix:
   *
   *  - it is claiming a level above silence, and nothing is coming out;
   *  - the app has not already greyed the control out for a reason of its own,
   *    which is a truthful state and says so already;
   *  - and either the app unlocks its audio from this control, or a context has
   *    been suspended out from under one that was running, which a tap resumes
   *    here regardless of what the app wired up.
   *
   * That last pair is what keeps the button honest in apps whose sound starts
   * somewhere else — Sleep Noise and Burnt Crust have their own transports, and
   * a stopped transport is not a lie to paper over.
   */
  function needsGesture() {
    if (!root || !unlockable || percent === 0) return false;
    if (root.hasAttribute('data-off')) return false;
    if (audible()) return false;
    return gestureFns.length > 0 || interrupted();
  }

  function refresh() {
    if (!prompt) return;
    // A hidden tab is allowed to be silent, and several of these apps suspend
    // themselves on the way out and resume on the way back. Deciding anything
    // while nobody is looking only risks the prompt flashing up on return, a
    // frame before the app has resumed.
    if (document.hidden) return;
    var want = needsGesture();
    prompt.hidden = !want;
    if (want) root.setAttribute('data-prompt', '');
    else root.removeAttribute('data-prompt');
  }

  // resume() resolves on its own schedule, and an app's gesture handler may
  // build its context a tick or two later still, so the answer is looked at
  // again over the second after a gesture rather than once at the end of it.
  // These are the only timers in the file: the rest is statechange events.
  var RECHECK = [0, 120, 350, 800, 1600];
  function recheck(late) {
    for (var i = late ? 2 : 0; i < RECHECK.length; i++) setTimeout(refresh, RECHECK[i]);
  }

  function gainFor(p) { return p <= 0 ? 0 : Math.pow(p / 100, CURVE); }

  function paint() {
    var level = percent === 0 ? '0' : percent < 55 ? '1' : '2';
    root.setAttribute('data-level', level);
    root.style.setProperty('--vol-p', percent + '%');
    input.setAttribute('aria-valuetext', percent === 0 ? 'Muted' : percent + ' percent');
    btn.setAttribute('aria-label', percent === 0 ? 'Unmute' : 'Mute');
    btn.title = percent === 0 ? 'Unmute' : 'Mute';
    refresh();   // muting is a truthful silence; the prompt has nothing to say
  }

  function emit() {
    var g = gainFor(percent);
    for (var i = 0; i < changeFns.length; i++) {
      try { changeFns[i](g, percent); } catch (e) { /* one bad listener is not the others' problem */ }
    }
  }

  function gesture() {
    for (var i = 0; i < gestureFns.length; i++) {
      try { gestureFns[i](); } catch (e) { /* ditto */ }
    }
    // Whatever the app does with the gesture, a context that has merely been
    // suspended can be resumed from here, and this is the completed gesture
    // that is allowed to do it.
    for (var j = 0; j < seen.length; j++) {
      var c = seen[j].ctx;
      if (c.state !== 'running' && c.state !== 'closed') {
        try { c.resume(); } catch (e) { /* it stays suspended and the prompt stays up */ }
      }
    }
    recheck();
  }

  function apply(p, quiet) {
    percent = Math.max(0, Math.min(100, Math.round(p)));
    if (percent > 0) lastOn = percent;
    if (input.valueAsNumber !== percent) input.value = String(percent);
    paint();
    save();
    if (!quiet) emit();
  }

  function build() {
    var bar = document.querySelector('.bar');
    if (!bar) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.className = 'bar-vol' + (PUSH ? ' push' : '');

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bar-vol__btn';
    btn.innerHTML = SVG;

    input = document.createElement('input');
    input.type = 'range';
    input.className = 'bar-vol__range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    // Where this app was left last time, or silence if it has never been opened.
    var start = stored();
    percent = start === null ? 0 : start;
    if (percent > 0) lastOn = percent;
    input.value = String(percent);
    input.setAttribute('aria-label', LABEL);

    // Last in the DOM, so tabbing still reaches the icon and the slider first:
    // it covers them for the pointer, but a keyboard was never blocked from
    // working them, and the arrow keys unlock the audio too.
    prompt = document.createElement('button');
    prompt.type = 'button';
    prompt.className = 'bar-vol__prompt';
    prompt.hidden = true;
    prompt.textContent = PROMPT;
    prompt.title = 'Browsers only allow sound after you interact with the page';

    root.appendChild(btn);
    root.appendChild(input);
    root.appendChild(prompt);

    // Sit just left of the hamburger where there is one: the menu is the last
    // thing in every bar that has one, and it should stay the last thing.
    var menu = bar.querySelector('.menu');
    if (menu) bar.insertBefore(root, menu); else bar.appendChild(root);

    input.addEventListener('input', function () { apply(input.valueAsNumber, false); });

    // Dragging the slider is itself the unlocking gesture, so an app never needs
    // a separate "tap to begin" step once this is here. pointerup, not
    // pointerdown — see the header comment.
    input.addEventListener('pointerup', gesture);
    input.addEventListener('change', gesture);   // keyboard, and pointer on some engines
    input.addEventListener('keyup', function (e) {
      if (e.key && e.key.indexOf('Arrow') === 0) gesture();
    });

    btn.addEventListener('click', function () {
      apply(percent > 0 ? 0 : lastOn, false);
      gesture();
    });

    // click, not pointerup: a click is by definition a completed gesture, which
    // is the only kind iOS grants audio on.
    prompt.addEventListener('click', gesture);

    // Coming back to a backgrounded tab is the other half of the Safari case:
    // the context was suspended on the way out and is not always handed back on
    // the way in, so the answer is worth asking again here — a beat late, to
    // give an app that resumes itself on return the chance to do it first.
    var onReturn = function () { if (!document.hidden) recheck(true); };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);

    paint();
  }

  function mount() {
    build();
    if (!root) return;
    // Anything registered before the DOM was ready gets the current (silent)
    // state now, so an app can set its gain up front and not special-case zero.
    emit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.HeaderVolume = {
    /** Current gain, 0..1, already curved. */
    get gain() { return gainFor(percent); },
    /** Current slider position, 0..100. */
    get percent() { return percent; },
    /** Move the slider from code. Pass quiet:true to not fire onChange. */
    set: function (p, quiet) { if (input) apply(p, !!quiet); },
    /** Called with (gain, percent) whenever the level moves. Fires once on mount. */
    onChange: function (fn) {
      changeFns.push(fn);
      if (input) { try { fn(gainFor(percent), percent); } catch (e) { /* not our problem */ } }
      return this;
    },
    /** Called when the user finishes a gesture on the control. Unlock audio here. */
    onGesture: function (fn) { gestureFns.push(fn); refresh(); return this; },
    /**
     * Say whether a gesture on this control can start sound at all right now.
     * Apps whose sound begins somewhere else — Hey Chair does not put the band
     * on stage until the sheet's button says so — turn it off until it can, so
     * the control never offers a tap that would do nothing.
     */
    setUnlockable: function (on) { unlockable = !!on; refresh(); return this; },
    /** Is sound actually coming out: a running context, at a level above zero. */
    get audible() { return percent > 0 && audible(); },
    /**
     * Grey the control out while the app has taken the output away, with a
     * reason for the tooltip. The level is left where the user put it, so
     * handing it back does not have to remember anything.
     */
    setEnabled: function (on, why) {
      if (!input) return;
      input.disabled = btn.disabled = !on;
      if (on) root.removeAttribute('data-off');
      else root.setAttribute('data-off', '');
      root.title = on ? '' : (why || '');
      refresh();
    },
  };
})();
