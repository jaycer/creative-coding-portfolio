// Shared idle auto-hide for the full-screen sketch apps.
//
// Hides the mouse cursor and the gallery ".bar" header after a stretch of
// pointer inactivity, and brings them back on any movement. Self-contained:
// it injects its own CSS, so an app only needs to drop in one script tag at
// the end of <body>:
//
//   <script src="../shared/autohide.js"></script>
//   <script src="../shared/autohide.js" data-idle-ms="5000"></script>  // custom delay
//
// Default delay is 10s; override per app with the data-idle-ms attribute.
(function () {
  var script = document.currentScript;
  var attr = script && script.getAttribute('data-idle-ms');
  var HIDE_MS = (attr && parseInt(attr, 10)) || 10000;

  var style = document.createElement('style');
  style.textContent =
    '.bar{transition:opacity .4s ease}' +
    'body.idle{cursor:none}' +
    'body.idle canvas{cursor:none}' +
    'body.idle .bar{opacity:0;pointer-events:none}';
  document.head.appendChild(style);

  var timer;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(timer);
    timer = setTimeout(function () {
      document.body.classList.add('idle');
    }, HIDE_MS);
  }

  ['mousemove', 'mousedown', 'touchstart', 'touchmove'].forEach(function (evt) {
    window.addEventListener(evt, wake, { passive: true });
  });

  wake(); // start the idle countdown
})();
