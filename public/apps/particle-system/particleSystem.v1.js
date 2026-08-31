// a particle system using p5js
// Jayce Renner

// --- particle field ---
var particleAmount;                 // count derived from the canvas area
var particles = [];
var particleDensity = 0.00009;      // particles per square pixel
var defaultMaxSize = 500;           // max particle size
var maxSizeScreenRatio = 0.5;       // max size vs shortest screen edge
var minParticleSize = 0;            // smallest particle size
var maxSpeed = 1;                   // max pixels moved per frame
var exitSizeThreshold = 1;          // size below which a particle is gone

// --- color ---
var backgroundColor = null;
var bgWalk = null;                  // the background's current hue, sat and brightness
var targetBgWalk = null;            // where the background is drifting to
var bgSkipMinHue = 60;              // start of the hue band the background avoids
var bgSkipMaxHue = 200;             // end of the hue band the background avoids
var hueCircle = 360;                // degrees in a full turn of hue
var backgroundLerpAmount = 0.004;   // background color step, spread over the frames below
var backgroundLerpFrames = 25;      // frames that step is spread across
var newTargetBgInSeconds = 60;      // seconds between new background targets
var msPerSecond = 1000;             // milliseconds in one second
var bgMinSat = 30;                  // background saturation floor, percent
var bgMaxSat = 44;                  // background saturation ceiling, percent
var bgMinBright = 40;               // background brightness floor, percent
var bgMaxBright = 54;               // background brightness ceiling, percent
var particleMinSat = 25;            // particle saturation floor, percent
var particleMaxSat = 100;           // particle saturation ceiling, percent
var particleMinBright = 50;         // particle brightness floor, percent
var particleMaxBright = 100;        // particle brightness ceiling, percent
var minParticleAlpha = 0.5;         // least opaque a particle can be
var maxParticleAlpha = 1;           // most opaque a particle can be
var opaqueAlpha = 1;                // the background is never see through
var minColorChanges = 1;            // fewest new colors per expansion
var maxColorChanges = 2;            // most new colors per expansion

// --- hue selection ---
var greenHuePercentage = 0.075;     // chance of a green hue
var greenMinHue = 70;               // start of the green band, degrees
var greenMaxHue = 180;              // end of the green band, degrees
var warmHueChance = 0.5;            // roll above this picks a warm hue
var warmMinHue = 0;                 // start of red to yellow, degrees
var warmMaxHue = 360;               // end of red to yellow, degrees
var coolMinHue = 0;                 // start of blue to red, degrees
var coolMaxHue = 360;               // end of blue to red, degrees

// --- timing ---
var transitionRateMod = 5;          // determines rate of particle emission and decay
var exitMod = 2400;                 // frames per lifespan before exiting
var isExiting = false;

// variables limiting particle expansion and contraction
var minMaxPeriod = 1000;            // shortest possible cycle limit
var maxMaxPeriod = 3000;            // longest possible cycle limit
var defaultMaxPeriod = 3000;        // this cycle's chosen limit
var minPeriod = 500;                // fastest a particle can pulse
var ampMin = -1;                    // wave low, fully expanded
var ampMax = 1;                     // wave high, fully contracted
var ampEpsilon = 0.0001;            // tolerance at the wave extremes

function setup() {
  colorMode(HSB);
  
  bgWalk = getBackgroundWalk();
  targetBgWalk = getBackgroundWalk();
  backgroundColor = getWalkColor(bgWalk);

  // change the target background color based on a timer
  var timer = new DeltaTimer(function (time) {
    
    targetBgWalk = getBackgroundWalk();
    
  }, newTargetBgInSeconds * msPerSecond);

  timer.start();
  
  factorSetup(backgroundColor);
}

// called initially and when the screen is resized
function factorSetup(bgColor) {
  let ww = windowWidth;
  let wh = windowHeight;
  let wscale = (ww > wh ? wh : ww);
  let cnv = createCanvas(ww, wh);
  cnv.position(0, 0, 'fixed');
  backgroundColor = bgColor;

  defaultMaxSize = wscale * maxSizeScreenRatio;
  // base the amount of particles on this ratio
  particleAmount = floor((ww * wh) * particleDensity);
  defaultMaxPeriod = random(minMaxPeriod, maxMaxPeriod);
}

function draw() {
  noStroke();
  
  // walk towards the target background a little at a time. Taking the whole step
  // once every backgroundLerpFrames drifts just as fast, but lands as a pulse that
  // a blend mode amplifies through every particle stacked on top of it.
  bgWalk = lerpWalk(bgWalk, targetBgWalk, backgroundLerpAmount / backgroundLerpFrames);
  backgroundColor = getWalkColor(bgWalk);
  
  blendMode(BLEND);
  background(backgroundColor);
  // could add a call blendMode(OVERLAY) here, but shimmer has become a concern that cannot be diagnosed 
  
  // add particles as needed
  if (frameCount % transitionRateMod == 0 && particles.length < particleAmount) {
    // particle emitter
    particles.push(new Particle(frameCount));
  }

  if (frameCount > exitMod - 1 && frameCount % exitMod == 0) {
    // begin the exiting process where all particles eventually vanish and lifespan ends
    isExiting = true;
    //print('isExiting',isExiting);
  }

  let hasExitedOne = false;

  // loop through the particle array and call their methods
  for (let particle of particles) {
    particle.resize();
    particle.move();
    particle.show();
    
    if (isExiting && frameCount % transitionRateMod == 0 && !hasExitedOne && !particle.isExiting) {
      // periodically flag a particle for decay
      particle.isExiting = isExiting;
      hasExitedOne = true;
    }
  }

  if (particles.every(x => x.hasExited)) {
    // reset to create a new set of particles
    particles = [];
    // change the max period every cycle
    defaultMaxPeriod = random(minMaxPeriod, maxMaxPeriod);
    isExiting = false;
  }
}

// this class represents a particle that 
//   moves according to speed
//   changes color as it expands
//   expands and contracts in size
//   stays on the screen for its lifespan
//   can expand after being flagged to end lifespan but cannot re-expand
class Particle {
  
  constructor(frameCountOffset) {

    // required properties: position, size, color, speed
    this.position = createVector(random(width), random(height));
    this.size = minParticleSize;
    this.walk = getParticleWalk();
    this.color = getWalkColor(this.walk);
    this.speed = random(maxSpeed*-1, maxSpeed);
    this.speedY = random(maxSpeed*-1, maxSpeed);
    
    this.minSize = minParticleSize;
    this.maxSize = random(this.minSize, defaultMaxSize);
    this.isGrowing = true;

    // period determines the speed of expansion and contraction
    this.period = random(minPeriod, defaultMaxPeriod);

    // walk through a run of colors over the course of an expansion
    this.colorChanges = floor(random(minColorChanges, maxColorChanges + 1));
    this.colorStepFrames = max(1, floor(this.period / this.colorChanges));
    this.colorStepFrame = 0;
    this.colorFrom = this.walk;
    this.colorTo = getParticleWalk();
    this.frameCountOffset = frameCountOffset;
    this.amp = ampMin;
    this.isExiting = false;
    this.hasExited = false;
  }

  show() {
    fill(this.color);
    ellipse(this.position.x, this.position.y, this.size);
  }
  
  move() {
    // stay on the screen
    if (this.position.x > width || this.position.x < 0) {
      this.speed *= -1;
    }
    if (this.position.y > height || this.position.y < 0) {
      this.speedY *= -1;
    }
    
    // update position according to speed
    this.position.x += this.speed;
    this.position.y += this.speedY;
  }

  resize() {

    if (this.isExiting && this.size < exitSizeThreshold) {
      
      // flag the end of lifespan
      this.hasExited = true;

    } else {
      
      // determine the size based on a wave to provide easing
      this.amp = cos(PI * (frameCount - this.frameCountOffset) / this.period);

      if (this.amp < ampMin + ampEpsilon && this.isGrowing) {
        this.isGrowing = false;
      }

      if (this.amp > ampMax - ampEpsilon && !this.isGrowing) {
        this.isGrowing = true;
        // new fill and max
        this.colorFrom = this.walk;
        this.colorTo = getParticleWalk();
        this.colorStepFrame = 0;
        this.maxSize = random(this.minSize, defaultMaxSize);
      }

      if (this.isGrowing) {
        // once the run reaches its color, set off toward another one
        if (++this.colorStepFrame >= this.colorStepFrames) {
          this.colorStepFrame = 0;
          this.colorFrom = this.colorTo;
          this.colorTo = getParticleWalk();
        }

        // walk toward it at a steady rate, so the color never sits still
        this.walk = lerpWalk(this.colorFrom, this.colorTo, this.colorStepFrame / this.colorStepFrames);
        this.color = getWalkColor(this.walk);
      }
      
      this.size = map(this.amp, ampMin, ampMax, this.maxSize, this.minSize);
    }
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  factorSetup(backgroundColor);
}

// helper functions
// Colors are held as numbers rather than as p5 colors because lerpColor takes the
// short way around the color wheel, so a run between two hues covers as little
// ground as it can and, for the background, cuts through the skipped band whenever
// the two sit on opposite sides of it. Lerping the numbers instead sends the hue
// the way it was picked, however far round that is. The background's hues run past
// a full turn, over the arc that begins where the band ends and comes back around
// to where it begins, so a step between two of them stays on the arc.
function getBackgroundWalk() {
  // parameters for all background colors
  return {
    hue: random(bgSkipMaxHue, bgSkipMinHue + hueCircle),
    sat: random(bgMinSat, bgMaxSat),
    bright: random(bgMinBright, bgMaxBright),
    alpha: opaqueAlpha
  };
}

function getParticleWalk() {
  // parameters for all particle colors
  return {
    hue: getHue(),
    sat: random(particleMinSat, particleMaxSat),
    bright: random(particleMinBright, particleMaxBright),
    alpha: random(minParticleAlpha, maxParticleAlpha)
  };
}

function lerpWalk(from, to, amount) {
  // step each of the four towards the target
  return {
    hue: lerp(from.hue, to.hue, amount),
    sat: lerp(from.sat, to.sat, amount),
    bright: lerp(from.bright, to.bright, amount),
    alpha: lerp(from.alpha, to.alpha, amount)
  };
}

function getWalkColor(walk) {
  // bring the hue back onto the color wheel to draw with it, and keep the four
  // as they are: rounding them steps the whole screen a full percent at a time,
  // which a blend mode picks up and turns into a flicker
  return color(walk.hue % hueCircle, walk.sat, walk.bright, walk.alpha);
}

function getHue(){
  // modify the chances of getting a green hue
  let x = random(1);
  
  if (x < greenHuePercentage) {
    
    let greenHue = floor(random(greenMinHue, greenMaxHue));
    
    return greenHue;
    
  } else if (x > warmHueChance) {
    
    // red to yellow
    return floor(random(warmMinHue, warmMaxHue));
    
  } else {
    
    // blue to red
    return floor(random(coolMinHue, coolMaxHue));
  }
}

// provides an accurate, repeatable timer
// from https://stackoverflow.com/a/11624239/4463445
class DeltaTimer {

    constructor(render, interval) {
        var timeout;
        var lastTime;

        this.start = start;
        this.stop = stop;

        function start() {
            timeout = setTimeout(loop, 0);
            lastTime = +new Date();
            return lastTime;
        }

        function stop() {
            clearTimeout(timeout);
            return lastTime;
        }

        function loop() {
            var thisTime = +new Date();
            var deltaTime = thisTime - lastTime;
            var delay = Math.max(interval - deltaTime, 0);
            timeout = setTimeout(loop, delay);
            lastTime = thisTime + delay;
            render(thisTime);
        }
    }
}
