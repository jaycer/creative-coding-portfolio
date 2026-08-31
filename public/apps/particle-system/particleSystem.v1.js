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
var targetBackgroundColor = null;
var backgroundLerpAmount = 0.004;   // background color step per lerp
var backgroundLerpMod = 25;         // frames between background lerps
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
var maxParticleAlpha = 1;           // most opaque a particle can be
var minColorChanges = 2;            // fewest new colors per expansion
var maxColorChanges = 4;            // most new colors per expansion

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
  blendMode(OVERLAY);
  backgroundColor = getBackgroundColor();
  targetBackgroundColor = getBackgroundColor();

  // change the target background color based on a timer
  var timer = new DeltaTimer(function (time) {
    
    targetBackgroundColor = getBackgroundColor();
    
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
  
  if (frameCount % backgroundLerpMod == 0) {
    // lerp towards the targetBackgroundColor 
    backgroundColor = lerpColor(backgroundColor, targetBackgroundColor, backgroundLerpAmount); 
  }
  
  background(backgroundColor);
  
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
    //print('isExiting',isExiting);
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
    this.color = getParticleColor();
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
    this.colorFrom = this.color;
    this.colorTo = getParticleColor();
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
        this.colorFrom = this.color;
        this.colorTo = getParticleColor();
        this.colorStepFrame = 0;
        this.maxSize = random(this.minSize, defaultMaxSize);
      }

      if (this.isGrowing) {
        // once the run reaches its color, set off toward another one
        if (++this.colorStepFrame >= this.colorStepFrames) {
          this.colorStepFrame = 0;
          this.colorFrom = this.colorTo;
          this.colorTo = getParticleColor();
        }

        // walk toward it at a steady rate, so the color never sits still
        this.color = lerpColor(this.colorFrom, this.colorTo, this.colorStepFrame / this.colorStepFrames);
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
function getHSBColor(minS, maxS, minB, maxB, isAlwaysOpaque = false) {
  // get a random color with certain parameters
  if (isAlwaysOpaque) {
    return color('hsb('+getHue()+', '+floor(random(minS,maxS))+'%, '+floor(random(minB,maxB))+'%)');
  } else {
    return color('hsba('+getHue()+', '+floor(random(minS,maxS))+'%, '+floor(random(minB,maxB))+'%,'+random(maxParticleAlpha)+')');
  }
}

function getBackgroundColor() {
  // parameters for all background colors
  return getHSBColor(bgMinSat, bgMaxSat, bgMinBright, bgMaxBright, true);
}

function getParticleColor() {
  // parameters for all particle colors
  return getHSBColor(particleMinSat, particleMaxSat, particleMinBright, particleMaxBright);
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
