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

  var CSS =
    '.bar-vol{pointer-events:auto;display:inline-flex;align-items:center;gap:7px;' +
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
    // Phone bars are already full. The track gives way; the icon never does,
    // because on a phone the icon is the whole unmute affordance.
    '@media (max-width:600px){.bar-vol{gap:5px}' + R + '{width:52px}}' +
    '@media (max-width:380px){' + R + '{width:40px}}';

  var SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path class="bar-vol__cone" d="M4 9.2h3.4L12 5.2v13.6l-4.6-4H4z"/>' +
      '<path class="bar-vol__wave bar-vol__wave--near" d="M15.4 9.4a3.7 3.7 0 0 1 0 5.2"/>' +
      '<path class="bar-vol__wave" d="M18 7a7.2 7.2 0 0 1 0 10"/>' +
      '<path class="bar-vol__cross" d="M15.6 9.6l4.8 4.8"/>' +
      '<path class="bar-vol__cross" d="M20.4 9.6l-4.8 4.8"/>' +
    '</svg>';

  var changeFns = [];
  var gestureFns = [];
  var percent = 0;
  var lastOn = DEFAULT_ON;   // where the icon toggle returns you to
  var root = null, input = null, btn = null;

  function gainFor(p) { return p <= 0 ? 0 : Math.pow(p / 100, CURVE); }

  function paint() {
    var level = percent === 0 ? '0' : percent < 55 ? '1' : '2';
    root.setAttribute('data-level', level);
    root.style.setProperty('--vol-p', percent + '%');
    input.setAttribute('aria-valuetext', percent === 0 ? 'Muted' : percent + ' percent');
    btn.setAttribute('aria-label', percent === 0 ? 'Unmute' : 'Mute');
    btn.title = percent === 0 ? 'Unmute' : 'Mute';
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

    root.appendChild(btn);
    root.appendChild(input);

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
    onGesture: function (fn) { gestureFns.push(fn); return this; },
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
    },
  };
})();
