// a particle system using p5js
// v1
// todo: make the cursor disappear after a while
//       https://stackoverflow.com/questions/3354239/hiding-the-mouse-cursor-when-idle-using-javascript

var particleAmount;
var particles = [];
var defaultMaxSize = 400; // max particle size
var backgroundColor = null;
var targetBackgroundColor = null;
var backgroundLerpAmount = 0.004;
var transitionRateMod = 5; // determines rate of particle emission and decay
var backgroundLerpMod = 25;
var exitMod = 2400;

// variables limiting particle expansion and contraction
var minMaxPeriod = 1000;
var maxMaxPeriod = 3000;
var defaultMaxPeriod = 3000;

var isExiting = false;
var newTargetBgInSeconds = 60;
var maxSpeed = 1;
var greenHuePercentage = 0.075;

function setup() {
  colorMode(HSB);
  blendMode(OVERLAY);
  backgroundColor = getBackgroundColor();
  targetBackgroundColor = getBackgroundColor();

  // change the target background color based on a timer
  var timer = new DeltaTimer(function (time) {
    
    targetBackgroundColor = getBackgroundColor();
    //printColorRGB("new target", targetBackgroundColor);
    
  }, newTargetBgInSeconds * 1000);

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

  defaultMaxSize = wscale * 0.5;
  // base the amount of particles on this ratio
  particleAmount = floor((ww * wh) * 0.00009);
  defaultMaxPeriod = random(minMaxPeriod, maxMaxPeriod);
}

function draw() {
  noStroke();
  
  if (frameCount % backgroundLerpMod == 0) {
    // lerp towards the targetBackgroundColor 
    backgroundColor = lerpColor(backgroundColor, targetBackgroundColor, backgroundLerpAmount); 
    //printColorRGB("lerpt", backgroundColor);
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
    this.size = 0;
    this.color = getParticleColor();
    this.speed = random(maxSpeed*-1, maxSpeed);
    this.speedY = random(maxSpeed*-1, maxSpeed);
    
    this.targetColor = getParticleColor();
    this.minSize = 0;
    this.maxSize = random(this.minSize, defaultMaxSize);
    this.isGrowing = true;
    
    this.minParticleLerp = 0.01;
    this.maxParticleLerp = 0.05;
    this.lerpPercent = random(this.minParticleLerp, this.maxParticleLerp);

    // period determines the speed of expansion and contraction
    this.period = random(500, defaultMaxPeriod);
    this.frameCountOffset = frameCountOffset;
    this.amp = -1;
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

    if (this.isExiting && this.size < 1) {
      
      // flag the end of lifespan
      this.hasExited = true;

    } else {
      
      // determine the size based on a wave to provide easing
      this.amp = cos(PI * (frameCount - this.frameCountOffset) / this.period);

      if (this.amp < -0.9999 && this.isGrowing) {
        this.isGrowing = false;
        this.lerpPercent = this.lerpPercent * -1;
      }

      if (this.amp > 0.9999 && !this.isGrowing) {
        this.isGrowing = true;
        // new fill and max
        this.targetColor = getParticleColor();
        this.maxSize = random(this.minSize, defaultMaxSize);
        this.lerpPercent = abs(this.lerpPercent);
      }

      if (this.isGrowing) {
        // lerp the particle color during expansion
        this.color = lerpColor(this.color, this.targetColor, this.lerpPercent);
      }
      
      this.size = map(this.amp, -1, 1, this.maxSize, this.minSize);
    }
  }
}

//function mouseClicked() {
//  saveCanvas('still-of-particle-system-v1-by-laxinline', 'png');
//}

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
    return color('hsba('+getHue()+', '+floor(random(minS,maxS))+'%, '+floor(random(minB,maxB))+'%,'+random(1)+')');
  }
}

function getBackgroundColor() {
  // parameters for all background colors
  return getHSBColor(30,44,40,54,true);
}

function getParticleColor() {
  // parameters for all particle colors
  return getHSBColor(25,100,50,100);
}

function getHue(){
  // modify the chances of getting a green hue
  let x = random(1);
  
  if (x < greenHuePercentage) {
    
    let greenHue = floor(random(70,180));
    //print('green hue', greenHue);
    
    return greenHue;
    
  } else if (x > 0.5) {
    
    // red to yellow
    return floor(random(0,70));
    
  } else {
    
    // blue to red
    return floor(random(180,360));
  }
}

function printColorRGB(message, color){
  print(message, floor(red(color)), floor(green(color)), floor(blue(color)));
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