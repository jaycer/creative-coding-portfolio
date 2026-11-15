// build-footer.js — which build is this, on the page, everywhere.
//
// One line, the same on every page of the site: the version the site was built
// from and the day it was built.
//
//   v0.10.0-2-g72d95c0 · 2026-11-15
//
// It is fetched from /version.json for the reason build-version.js gives: the
// pages under /public ship verbatim, so nothing can be baked into them. That
// also means the line names the build that is deployed right now, which is the
// useful half of "am I looking at a stale copy".
//
// Where it goes is the page's call, and it never goes on top of the picture:
//
//   1. A page marks the spot and the line is written there. In a footer the
//      page already has, it inherits that footer's type:
//        <span data-build-info></span>
//      In a full-screen app it goes in the controls screen (the settings
//      sheet, the menu, the start card), with the look this file supplies:
//        <p class="build-line" data-build-info></p>
//   2. A page that scrolls and marks no spot gets a small footer of its own
//      after the content.
//   3. A full-screen page that marks no spot shows nothing. A canvas has no
//      footer, and a strip along its bottom edge would be part of the picture.
//
// A screen that is built after load (a React modal) cannot be filled from
// here, so the line is also left on window.buildLine for it to read. Such a
// page says data-build-footer="none" on the tag, so that (2) leaves it alone.
(function () {
  var script = document.currentScript;
  // Resolved against this script rather than the page, so it finds the site
  // root whatever folder depth the page that loaded it sits at.
  var url = new URL('../../version.json', script.src);

  var type =
    'font:10px/1.4 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;' +
    'letter-spacing:.04em;font-variant-numeric:tabular-nums;color:inherit;opacity:.5;text-align:center;';
  var style = document.createElement('style');
  style.textContent =
    // Tripled so it outranks a host page's own paragraph rules (.panel p,
    // .drop .inner p) without reaching for !important.
    '.build-line.build-line.build-line{' + type + 'margin:14px 0 0;padding:0}' +
    '.build-info{' + type + 'display:block;margin:0;padding:18px 12px 20px;white-space:nowrap}';
  document.head.appendChild(style);

  function text(v) {
    var day = typeof v.built === 'string' ? v.built.slice(0, 10) : '';
    return 'v' + v.version + (day ? ' · ' + day : '');
  }

  function scrolls() {
    var over = function (el) {
      var s = getComputedStyle(el);
      return s.overflowY === 'hidden' || s.overflow === 'hidden';
    };
    return !over(document.documentElement) && !over(document.body);
  }

  function place(line) {
    var spots = document.querySelectorAll('[data-build-info]');
    if (spots.length) {
      spots.forEach(function (el) { el.textContent = line; });
      return;
    }
    if (script.getAttribute('data-build-footer') === 'none' || !scrolls()) return;
    // A div, not a <footer>: several pages style the bare footer element, and
    // this must not pick up their margins and rules.
    var foot = document.createElement('div');
    foot.setAttribute('role', 'contentinfo');
    foot.className = 'build-info';
    foot.textContent = line;
    document.body.appendChild(foot);
  }

  function ready(fn) {
    if (document.body && document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  fetch(url)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (v) {
      if (!v || !v.version) return;
      var line = text(v);
      window.buildLine = line;
      ready(function () { place(line); });
    })
    .catch(function () { /* offline, or opened off the disk: say nothing */ });
})();
