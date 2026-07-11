// Spiral Generator — adapted from "Spiral Gen v2" by laxinline
// https://editor.p5js.org/laxinline/full/rr_MW-_dZ
// Pointer position shapes the spiral (element scale and amount); a tap locks
// the current input; restart lives in the settings menu.
// The trick: each frame rotates the draw transform one degree further and
// stamps a ring of small squares whose radius grows with frameCount, so the
// un-cleared buffer accumulates into paisley-like spiral arms. A fragment
// shader then presents that buffer each frame — slow whole-spiral rotation,
// bloom, chromatic aberration, vignette — without touching the accumulation.

var elAmount = 10;
var elScale = 1;
var colorA;
var colorB;
var colorC;
var colorD;
var lerpAmount = 0.04; // per 100 frames, so the palette visibly drifts over a cycle
var minScale = 0.25;
var maxScale = 4;
var minElAmount = 1;
var maxElAmount = 128;
var squareSize = 5;
var colorResetMod = 3000;
var dimension;

// The squares accumulate in an offscreen 2D buffer; the WEBGL main canvas
// runs the post shader over it, spinning the whole spiral with frameCount.
var pg;
var postShader;
var spinSpeed = 0.05; // degrees per frame — one full turn every ~2 minutes

// A tap always locks/unlocks the pointer's input: scale & count in 2D,
// the plane aim in 3D (each mode keeps its own lock). Restarting the
// spiral lives in the settings menu.
var paramsLocked = false;

// 3D motion (settings menu): the pointer aims the spiral's plane instead of
// scale/count; angles ease toward their target so toggling never snaps.
// While the aim is locked, dragging pans and pinch/scroll zooms.
var tilt3D = false;
var planeLocked = false;
var tiltX = 0; // smoothed pitch, radians
var tiltY = 0; // smoothed yaw, radians
var targetTiltX = 0;
var targetTiltY = 0;
var maxTilt = Math.PI * 78 / 180; // stop short of edge-on so the plane never vanishes
var tiltEase = 0.06;

var zoomLevel = 1;
var targetZoom = 1;
var minZoom = 0.3;
var maxZoom = 8;
var panX = 0; // camera offset across the plane, buffer px
var panY = 0;

// last pointer position over the canvas itself; p5's mouseX/mouseY also
// follow the pointer across the header and settings menu, which would drag
// the spiral input along on every menu trip — UI positions must not count
var inputX = 0;
var inputY = 0;

// tap-vs-drag bookkeeping (shared by mouse and touch)
var pressOnCanvas = false;
var tapMoved = false;
var pressX = 0;
var pressY = 0;
var pressTime = 0;
var lastPlaneX = null; // pointer's plane-space position on the previous drag step
var lastPlaneY = null;
var pinching = false;
var pinchDist = null;

function preload() {
  postShader = loadShader('./post.vert.glsl', './post.frag.glsl');
}

function setup() {
  factorSetup(0);
}

function factorSetup(bgColor) {
  let ww = windowWidth;
  let wh = windowHeight;
  let cnv = createCanvas(ww, wh, WEBGL);
  cnv.position(0, 0, 'fixed');
  pixelDensity(1); // keep drawingbuffer == css pixels so gl_FragCoord lines up

  colorMode(HSB);
  background(bgColor);
  noStroke();

  // square buffer sized to the window diagonal, so rotating it on screen
  // never exposes a clipped corner
  var bufSize = ceil(sqrt(ww * ww + wh * wh));
  pg = createGraphics(bufSize, bufSize);
  pg.pixelDensity(1); // halves the texture re-uploaded to the GPU each frame
  pg.colorMode(HSB);
  pg.noStroke();
  pg.background(0);

  resetColors();

  if (width > height) {
    dimension = width;
  } else {
    dimension = height;
  }
}

function windowResized() {
  // resizeCanvas keeps the WebGL context; recreating the canvas (factorSetup)
  // would orphan postShader on the old context and kill the draw loop
  resizeCanvas(windowWidth, windowHeight);

  // rebuild the accumulation buffer for the new window diagonal, carrying
  // the artwork over centered so fullscreen jumps don't reset the spiral
  var bufSize = ceil(sqrt(windowWidth * windowWidth + windowHeight * windowHeight));
  if (bufSize !== pg.width) {
    var old = pg;
    pg = createGraphics(bufSize, bufSize);
    pg.pixelDensity(1);
    pg.colorMode(HSB);
    pg.noStroke();
    pg.background(0);
    pg.image(old, (bufSize - old.width) / 2, (bufSize - old.height) / 2);
    old.remove();
  }

  if (width > height) {
    dimension = width;
  } else {
    dimension = height;
  }
}

function resetColors() {
  // random palette each cycle: a vivid base hue with a pale counterpoint
  // (the fc % 2 alternation needs the contrast), plus random drift targets
  // that the lerp pulls toward — so every run grows its own colors
  var baseHue = random(360);
  var driftHue = (baseHue + random(120, 240)) % 360;
  colorA = color(baseHue, random(70, 100), 100, 0.1);
  colorC = color((baseHue + random(-60, 60) + 360) % 360, random(0, 35), random(60, 95), 0.2);
  colorB = color(driftHue, random(50, 100), random(30, 80), 0.1);
  colorD = color(driftHue, random(60, 100), random(10, 40), 0.2);
}

function draw() {

  let fc = frameCount;

  // stamp this frame's ring of squares into the accumulation buffer
  pg.push();
  pg.translate(pg.width / 2, pg.height / 2);
  pg.rotate(radians(fc % 360));

  // scale/count follow the pointer only in unlocked 2D mode: a tap locks
  // them in place, and in 3D mode the pointer aims the plane instead
  if (!tilt3D && !paramsLocked) {
    // change the amount of elements according to the pointer x position
    elAmount = constrain(map(inputX, 0, width, minElAmount, maxElAmount), minElAmount, maxElAmount);

    // make sure elAmount is not 7 and even if above 10
    if (elAmount == 7) {
      elAmount = 8;
    } else if (elAmount > 10 && elAmount % 2 == 1) {
      elAmount = elAmount - 1;
    }

    // change the scale of elements according to the pointer y position
    elScale = constrain(map(inputY, 0, height, minScale, maxScale), minScale, maxScale);
  }

  // loop according to the amount of elements
  for (var i = 0; i < elAmount; i++) {

    pg.push();

    // rotate according to the amount of elements
    pg.rotate(TWO_PI * i / elAmount);

    // creates a more swirly spiral, like paisley
    pg.translate(i, i * 3);

    // lerp the colors
    if (fc % 100 == 0) {
      colorA = lerpColor(colorA, colorB, lerpAmount);
      colorC = lerpColor(colorC, colorD, lerpAmount);
    }

    // alternate colors for contrast
    if (fc % 2 == 0) {
      pg.fill(colorA);
    } else {
      pg.fill(colorC);
    }

    // scale according to mouse position
    pg.scale(elScale);

    // draw a square
    // divide by scale to stay on screen
    pg.rect(fc % ((dimension / 2) / elScale), 0, squareSize, squareSize);

    pg.pop();

  }

  pg.pop();

  if (fc % colorResetMod == 0) {
    // reset the colors every so often
    resetColors();
  }

  // ease the plane toward its target: pointer-aimed when 3D motion is on and
  // unlocked (screen center = flat); locking freezes the aim where it is;
  // turning 3D off brings everything back to the flat framing
  if (tilt3D && !planeLocked) {
    targetTiltX = constrain(map(inputY, 0, height, -maxTilt, maxTilt), -maxTilt, maxTilt);
    targetTiltY = constrain(map(inputX, 0, width, -maxTilt, maxTilt), -maxTilt, maxTilt);
  } else if (!tilt3D) {
    targetTiltX = 0;
    targetTiltY = 0;
    targetZoom = 1;
    panX += (0 - panX) * 0.1;
    panY += (0 - panY) * 0.1;
  }
  tiltX += (targetTiltX - tiltX) * tiltEase;
  tiltY += (targetTiltY - tiltY) * tiltEase;
  zoomLevel += (targetZoom - zoomLevel) * 0.15;

  // present the buffer through the post shader (rotation, tilt, bloom, CA, vignette)
  background(0);
  shader(postShader);
  postShader.setUniform('uTex', pg);
  postShader.setUniform('uResolution', [width, height]);
  postShader.setUniform('uBufSize', pg.width);
  postShader.setUniform('uAngle', radians(fc * spinSpeed));
  postShader.setUniform('uTilt', [tiltX, tiltY]);
  postShader.setUniform('uZoom', zoomLevel);
  postShader.setUniform('uPan', [panX, panY]);
  rect(-width / 2, -height / 2, width, height);
}

// menu actions, deliberately separate: restarting keeps the palette,
// resetting the palette keeps the drawn spiral (new squares just pick up
// the fresh colors as they accumulate)
function restartSpiral() {
  if (!pg) return;
  pg.background(0);
}

function resetPalette() {
  if (!pg) return;
  resetColors();
}

// mirror of the shader's ray->plane intersection, so dragging can hold the
// grabbed point of the plane under the pointer even while tilted
function screenToPlane(sx, sy) {
  var f = 0.9 * Math.min(width, height);
  var cx = Math.cos(tiltX);
  var sxr = Math.sin(tiltX);
  var cy = Math.cos(tiltY);
  var syr = Math.sin(tiltY);
  var U = [cy, 0, -syr];
  var V = [syr * sxr, cx, cy * sxr];
  var N = [syr * cx, -sxr, cy * cx];
  var dir = [sx - width / 2, sy - height / 2, f];
  var t = f * N[2] / (dir[0] * N[0] + dir[1] * N[1] + dir[2] * N[2]);
  if (!(t > 0)) return null; // pointer is past the horizon
  var hit = [t * dir[0], t * dir[1], t * dir[2] - f];
  return {
    x: hit[0] * U[0] + hit[1] * U[1] + hit[2] * U[2],
    y: hit[0] * V[0] + hit[1] * V[1] + hit[2] * V[2],
  };
}

// shared press/drag/release logic; mouse and touch handlers both route here
function pointerPressed(e) {
  if (e && e.target && e.target.tagName !== 'CANVAS') return;
  var panel = document.getElementById('settings-panel');
  if (panel && !panel.hidden) {
    // a canvas press with the menu open just dismisses the menu
    panel.hidden = true;
    pressOnCanvas = false;
    return;
  }
  pressOnCanvas = true;
  tapMoved = false;
  pressX = mouseX;
  pressY = mouseY;
  pressTime = millis();
  var pl = screenToPlane(mouseX, mouseY);
  lastPlaneX = pl ? pl.x : null;
  lastPlaneY = pl ? pl.y : null;
}

function pointerDragged() {
  if (!pressOnCanvas) return;
  if (dist(mouseX, mouseY, pressX, pressY) > 6) tapMoved = true;
  if (tilt3D && planeLocked) {
    var pl = screenToPlane(mouseX, mouseY);
    if (pl && lastPlaneX != null) {
      var lim = pg.width / 2;
      panX = constrain(panX + (lastPlaneX - pl.x) / zoomLevel, -lim, lim);
      panY = constrain(panY + (lastPlaneY - pl.y) / zoomLevel, -lim, lim);
    }
    lastPlaneX = pl ? pl.x : null;
    lastPlaneY = pl ? pl.y : null;
  }
}

function pointerReleased() {
  if (!pressOnCanvas) return;
  pressOnCanvas = false;
  if (tapMoved || millis() - pressTime > 400) return;
  // it's a tap: lock/unlock the current mode's pointer input
  if (tilt3D) {
    planeLocked = !planeLocked;
  } else {
    paramsLocked = !paramsLocked;
  }
  updateHint();
}

function mousePressed(e) { pointerPressed(e); }
function mouseDragged() { pointerDragged(); }
function mouseReleased() { pointerReleased(); }

function mouseWheel(event) {
  if (!tilt3D) return;
  if (event && event.target && event.target.tagName !== 'CANVAS') return;
  targetZoom = constrain(targetZoom * Math.exp(-event.delta * 0.0015), minZoom, maxZoom);
  return false;
}

function touchStarted(e) {
  if (e && e.target && e.target.tagName !== 'CANVAS') return;
  if (touches.length >= 2) {
    // second finger down: the gesture becomes a pinch, not a tap or pan
    pinching = true;
    pinchDist = null;
    pressOnCanvas = false;
  } else {
    pointerPressed(e);
  }
  return false;
}

function touchMoved(e) {
  if (e && e.target && e.target.tagName !== 'CANVAS') return;
  if (tilt3D && touches.length >= 2) {
    var d = dist(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
    if (pinchDist != null && pinchDist > 0) {
      targetZoom = constrain(targetZoom * d / pinchDist, minZoom, maxZoom);
    }
    pinchDist = d;
  } else {
    pointerDragged();
  }
  return false; // also prevents dragging the page around
}

function touchEnded(e) {
  if (e && e.target && e.target.tagName !== 'CANVAS') return;
  if (touches.length === 0) {
    if (pinching) {
      pinching = false;
      pressOnCanvas = false;
    } else {
      pointerReleased();
    }
  }
  pinchDist = null;
  return false;
}

function updateHint() {
  var hint = document.getElementById('hint');
  if (!hint) return;
  // restart the brightness-settle so the changed message draws the eye
  hint.classList.remove('fresh');
  void hint.offsetWidth;
  hint.classList.add('fresh');
  if (!tilt3D) {
    hint.textContent = paramsLocked
      ? 'locked · tap to unlock'
      : 'move to set scale & count · tap to lock';
  } else {
    hint.textContent = planeLocked
      ? 'drag to pan · pinch or scroll to zoom · tap to unlock'
      : 'move to tilt the plane · tap to lock';
  }
}

// feed inputX/inputY only from pointer positions over the canvas (mouse and
// touch both arrive as pointer events; the canvas is fixed at 0,0 with
// pixelDensity 1, so client coords are sketch coords)
(function () {
  function track(e) {
    if (e.target && e.target.tagName === 'CANVAS') {
      inputX = e.clientX;
      inputY = e.clientY;
    }
  }
  window.addEventListener('pointerdown', track, { passive: true });
  window.addEventListener('pointermove', track, { passive: true });
})();

// settings menu (hamburger in the header)
(function () {
  var btn = document.getElementById('menu-btn');
  var panel = document.getElementById('settings-panel');
  var toggle = document.getElementById('toggle-3d');
  var paletteBtn = document.getElementById('palette-btn');
  var restartBtn = document.getElementById('restart-btn');

  btn.addEventListener('click', function () {
    panel.hidden = !panel.hidden;
  });

  // a click anywhere outside the panel closes it
  document.addEventListener('click', function (e) {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) {
      panel.hidden = true;
    }
  });

  toggle.addEventListener('change', function () {
    tilt3D = toggle.checked;
    planeLocked = false;
    updateHint();
  });

  paletteBtn.addEventListener('click', function () {
    resetPalette();
  });

  restartBtn.addEventListener('click', function () {
    restartSpiral();
  });
})();
