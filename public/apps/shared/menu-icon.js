// Shared header hamburger for the sub-apps that keep their settings behind one.
//
// The same three lines, at the same size and weight, in every bar in the
// gallery. It is the one control that means the same thing everywhere — "the
// rest of this app is in here" — so it is the one that has no business looking
// hand-drawn in each app. Self-contained, like the volume: one script tag ahead
// of the app's own, and every `.menu` button in the bar is drawn.
//
//   <script src="../shared/menu-icon.js"></script>
//
// The markup an app has to carry is the button and what it means. The glyph is
// this file's business:
//
//   <button class="menu" id="menu-btn" type="button" aria-label="Settings"
//           aria-haspopup="dialog" aria-expanded="false"></button>
//
// Bars are an SVG rather than the ☰ glyph, and that is not fussiness. The ink of
// ☰ is not centred in its em box — it hangs low and sits differently in every
// font a device might fall back to — so a text hamburger lands a pixel or two
// off centre in a pill and lands somewhere else again on the next platform.
// Three symmetric lines flex-centred sit dead centre everywhere.
//
// What this file does NOT own is the pill around the glyph: the border, the
// color and the hover belong to the bar the button is standing in, which is the
// app's own. Burnt Crust's bar is a hardware rack and its menu is one of its
// rack buttons; that is right, and only the glyph inside it needs to be the
// same glyph as everywhere else.
(function () {
  'use strict';

  // Every app in the gallery puts the button in its header bar, and scoping to
  // it keeps this away from anything else an app might have called `.menu`.
  var SEL = '.bar .menu';

  var SVG =
    '<svg viewBox="0 0 24 18" aria-hidden="true" focusable="false">' +
      '<line x1="2" y1="3" x2="22" y2="3"/>' +
      '<line x1="2" y1="9" x2="22" y2="9"/>' +
      '<line x1="2" y1="15" x2="22" y2="15"/>' +
    '</svg>';

  var CSS =
    // Centred by flex rather than by line box, which is the whole reason the
    // glyph is drawn rather than typed.
    SEL + '{display:inline-flex;align-items:center;justify-content:center}' +
    // currentColor throughout: a bar sets a color, and the icon is in it. The
    // one app with a light theme changes nothing here to follow it.
    SEL + ' svg{display:block;width:17px;height:13px;fill:none;stroke:currentColor;' +
      'stroke-width:2;stroke-linecap:round}';

  function draw() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var buttons = document.querySelectorAll(SEL);
    for (var i = 0; i < buttons.length; i++) {
      // An app that draws its own bars keeps them: this fills a button that has
      // nothing in it, and replaces a typed ☰ with the drawn one.
      if (buttons[i].querySelector('svg')) continue;
      buttons[i].innerHTML = SVG;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', draw);
  } else {
    draw();
  }
})();
