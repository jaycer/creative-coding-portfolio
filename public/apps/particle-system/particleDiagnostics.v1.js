// Diagnostics for the particle system, kept out of the sketch so it only runs when
// it is asked for. Load it after particleSystem.v1.js and it attaches itself: p5
// looks up draw() and keyReleased() on the window every time it needs them, so
// wrapping draw here is enough to get a look at each finished frame.
//
//   <script src="./particleSystem.v1.js"></script>
//   <script src="./particleDiagnostics.v1.js"></script>
//
// Release 'a' for a JSON file holding the field as it stands, the biggest jumps
// the watcher caught, and the last few hundred frames of jump history.

// --- settings ---
var snapshotKey = 'a';              // release this key to save the field as JSON
var isWatchingFlicker = true;       // compare each frame to the one before it
var flickerSampleWide = 64;         // columns in the shrunk copy it compares
var flickerSampleHigh = 40;         // rows in the shrunk copy it compares
var flickerEventsKept = 3;          // biggest jumps kept, of each of the two kinds
var flickerHistoryFrames = 600;     // frames of jump history kept
var secondsPerMinute = 60;          // seconds in one minute

// --- what the watcher is holding ---
var flickerShrinkSteps = [];        // the chain of canvases the frame shrinks through
var flickerSourceWide = 0;          // the canvas size that chain was built for
var flickerSourceHigh = 0;
var lastFlickerSample = null;       // last frame's brightness, cell by cell
var lastFlickerMean = 0;
var wholeScreenJumps = [];          // the frames the whole field moved most
var singlePatchJumps = [];          // the frames one patch of it moved most
var flickerHistory = [];

// --- attach to the sketch ---
var sketchDraw = window.draw;

window.draw = function () {
  sketchDraw();

  if (isWatchingFlicker) {
    watchForFlicker();
  }
};

// Release 'a' to drop a timestamped snapshot of the whole field to a JSON file.
// Every number that decides what is on the screen is in it, so two snapshots taken
// either side of a glitch say which value moved.
function keyReleased() {
  if (key.toLowerCase() === snapshotKey) {
    saveJSON({
      current: getSnapshot(),
      wholeScreenJumps: wholeScreenJumps,
      singlePatchJumps: singlePatchJumps,
      recentJumps: flickerHistory
    }, 'particles-' + getFileTimestamp());
  }
}

function getSnapshot() {
  return {
    frameCount: frameCount,
    width: width,
    height: height,
    blendMode: drawingContext.globalCompositeOperation,
    isExiting: isExiting,
    particleAmount: particleAmount,
    defaultMaxPeriod: defaultMaxPeriod,
    background: {
      walk: bgWalk,
      target: targetBgWalk,
      rgba: backgroundColor.levels
    },
    particles: particles.map(getParticleSnapshot)
  };
}

function getParticleSnapshot(particle) {
  return {
    x: particle.position.x,
    y: particle.position.y,
    speed: particle.speed,
    speedY: particle.speedY,
    size: particle.size,
    minSize: particle.minSize,
    maxSize: particle.maxSize,
    amp: particle.amp,
    period: particle.period,
    frameCountOffset: particle.frameCountOffset,
    isGrowing: particle.isGrowing,
    isExiting: particle.isExiting,
    hasExited: particle.hasExited,
    colorChanges: particle.colorChanges,
    colorStepFrames: particle.colorStepFrames,
    colorStepFrame: particle.colorStepFrame,
    walk: particle.walk,
    colorFrom: particle.colorFrom,
    colorTo: particle.colorTo,
    rgba: particle.color.levels
  };
}

// A flash lasts one frame, which is far too quick to catch by hand. So shrink each
// finished frame to a small grid, compare it against the frame before, and hold on
// to the handful of biggest jumps along with a full snapshot of the field as it was
// at that moment. Two kinds are worth telling apart: the whole field changing
// brightness at once, and one patch of it changing while the rest sits still.
function watchForFlicker() {
  let pixels = shrinkFrame();

  let sample = new Float64Array(flickerSampleWide * flickerSampleHigh);
  let total = 0;

  for (let i = 0; i < sample.length; i++) {
    // rec 601 luma, so the numbers track what an eye would call brightness
    sample[i] = 0.299 * pixels[4*i] + 0.587 * pixels[4*i+1] + 0.114 * pixels[4*i+2];
    total += sample[i];
  }

  let mean = total / sample.length;

  if (lastFlickerSample) {
    let meanJump = mean - lastFlickerMean;
    let patchJump = 0;

    for (let i = 0; i < sample.length; i++) {
      patchJump = max(patchJump, abs(sample[i] - lastFlickerSample[i]));
    }

    keepBiggestJump(wholeScreenJumps, abs(meanJump), meanJump, patchJump, mean);
    keepBiggestJump(singlePatchJumps, patchJump, meanJump, patchJump, mean);

    flickerHistory.push({
      frameCount: frameCount,
      meanJump: meanJump,
      patchJump: patchJump
    });

    if (flickerHistory.length > flickerHistoryFrames) {
      flickerHistory.shift();
    }
  }

  lastFlickerSample = sample;
  lastFlickerMean = mean;
}

// Going from the full canvas to the small grid in one step samples the frame
// rather than averaging it, which turns an edge moving a single pixel into a jump
// the size of a real flash. Halving repeatedly averages, so each cell ends up
// holding what that patch of screen actually looks like.
function buildShrinkSteps(sourceWide, sourceHigh) {
  flickerShrinkSteps = [];

  let stepWide = sourceWide;
  let stepHigh = sourceHigh;

  while (stepWide > flickerSampleWide * 2 && stepHigh > flickerSampleHigh * 2) {
    stepWide = max(flickerSampleWide, floor(stepWide / 2));
    stepHigh = max(flickerSampleHigh, floor(stepHigh / 2));
    flickerShrinkSteps.push(makeShrinkStep(stepWide, stepHigh));
  }

  flickerShrinkSteps.push(makeShrinkStep(flickerSampleWide, flickerSampleHigh));
  flickerSourceWide = sourceWide;
  flickerSourceHigh = sourceHigh;
}

function makeShrinkStep(stepWide, stepHigh) {
  let stepCanvas = document.createElement('canvas');
  stepCanvas.width = stepWide;
  stepCanvas.height = stepHigh;

  let stepContext = stepCanvas.getContext('2d', { willReadFrequently: true });
  stepContext.imageSmoothingEnabled = true;
  stepContext.imageSmoothingQuality = 'high';

  return stepContext;
}

function shrinkFrame() {
  let source = drawingContext.canvas;

  if (source.width !== flickerSourceWide || source.height !== flickerSourceHigh) {
    buildShrinkSteps(source.width, source.height);
  }

  for (let step of flickerShrinkSteps) {
    step.drawImage(source, 0, 0, step.canvas.width, step.canvas.height);
    source = step.canvas;
  }

  let last = flickerShrinkSteps[flickerShrinkSteps.length - 1];
  return last.getImageData(0, 0, flickerSampleWide, flickerSampleHigh).data;
}

function keepBiggestJump(jumps, score, meanJump, patchJump, mean) {
  // only worth the cost of a snapshot if this frame beats one already held
  if (jumps.length >= flickerEventsKept && score <= jumps[jumps.length - 1].score) {
    return;
  }

  jumps.push({
    score: score,
    frameCount: frameCount,
    meanJump: meanJump,
    patchJump: patchJump,
    mean: mean,
    snapshot: getSnapshot()
  });

  jumps.sort((first, second) => second.score - first.score);

  if (jumps.length > flickerEventsKept) {
    jumps.length = flickerEventsKept;
  }
}

function getFileTimestamp() {
  // the local time as 2026-08-30T21-42-05, so a snapshot lines up with the clock
  // you were watching, and with nothing in it a file name minds
  var now = new Date();
  var local = new Date(now - now.getTimezoneOffset() * secondsPerMinute * msPerSecond);
  return local.toISOString().slice(0, 19).replace(/:/g, '-');
}
