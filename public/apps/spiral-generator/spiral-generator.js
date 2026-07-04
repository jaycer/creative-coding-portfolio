// Spiral Generator — adapted from "Spiral Gen v2" by laxinline
// https://editor.p5js.org/laxinline/full/rr_MW-_dZ
// Move the mouse to change element scale and amount; click to clear.
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
var isTouchDevice;

var instructionFrameAmount = 180;

// The squares accumulate in an offscreen 2D buffer; the WEBGL main canvas
// runs the post shader over it, spinning the whole spiral with frameCount.
var pg;
var postShader;
var spinSpeed = 0.05; // degrees per frame — one full turn every ~2 minutes

function preload() {
  postShader = loadShader('./post.vert.glsl', './post.frag.glsl');
}

function setup() {
  isTouchDevice = ('ontouchstart' in document.documentElement);

  var introEl = document.getElementById('intro-text');
  if (introEl) {
    introEl.textContent = isTouchDevice
      ? 'Touch screen to change element scale and amount\nTouch with two fingers to clear\nBeginning spiral generation soon'
      : 'Move mouse to change element scale and amount\nClick mouse to clear\nBeginning spiral generation soon';
  }

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
  resizeCanvas(windowWidth, windowHeight);
  factorSetup(0);
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

  if (frameCount < instructionFrameAmount) {
    background(0);
    return;
  }
  if (frameCount == instructionFrameAmount) {
    var overlay = document.getElementById('intro-overlay');
    if (overlay) overlay.classList.add('gone');
  }
  // touch with two or more fingers to clear
  if (touches && touches.length > 1) {
    pg.background(0);
    resetColors();
  }

  let fc = frameCount - instructionFrameAmount; // offset

  // stamp this frame's ring of squares into the accumulation buffer
  pg.push();
  pg.translate(pg.width / 2, pg.height / 2);
  pg.rotate(radians(fc % 360));

  // change the amount of elements according to the mouse x position
  elAmount = constrain(map(mouseX, 0, width, minElAmount, maxElAmount), minElAmount, maxElAmount);

  // make sure elAmount is not 7 and even if above 10
  if (elAmount == 7) {
    elAmount = 8;
  } else if (elAmount > 10 && elAmount % 2 == 1) {
    elAmount = elAmount - 1;
  }

  // change the scale of elements according to the mouse y position
  elScale = constrain(map(mouseY, 0, height, minScale, maxScale), minScale, maxScale);

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

  // present the buffer through the post shader (rotation, bloom, CA, vignette)
  background(0);
  shader(postShader);
  postShader.setUniform('uTex', pg);
  postShader.setUniform('uResolution', [width, height]);
  postShader.setUniform('uBufSize', pg.width);
  postShader.setUniform('uAngle', radians(fc * spinSpeed));
  rect(-width / 2, -height / 2, width, height);
}

function mouseClicked() {
  pg.background(0);
  resetColors(); // each clear starts a fresh random palette
}

function touchMoved() {
  // This prevents dragging screen around
  return false;
}
