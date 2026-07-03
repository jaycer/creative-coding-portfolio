let eShader; // The shader
let timerSeconds = 10.0;
let efs; // a collection of shader properties
let introOpen = true; // the intro modal is shown over the running visual until closed
let demoTimer; // the Demo Mode countdown; reset on each click so it restarts
let demoMode = 1;
let versionLabel = 'v0';

function preload() {

  // allow for full screen display
  if (window.location.href.indexOf("/u17sv-v0") > -1) {
    let header = document.getElementById("templateHeader");
    if (header) {
      header.style.display = "none";
    }
  
    let footer = document.getElementById("templateFooter");
    if (footer) {
      footer.style.display = "none";
    }
  }
  
  eShader = loadShader('./u17sv.v0.vert.glsl', './u17sv.v0.frag.glsl');
}

// Load a random preset and calm its flash-prone parameters before use.
function freshFactors() {
  let e = new ShaderEFactors(JSON.parse(getFav()));
  e.calm();
  e.broadenColor();
  return e;
}

function setup() {

  let cnv = createCanvas(windowWidth, windowHeight, WEBGL);
  cnv.position(0, 0, 'fixed');

  // uncomment for high-pixel density displays
  //pixelDensity(1);

  shader(eShader);

  // Start a default preset running right away, behind the intro modal.
  efs = freshFactors();
  beginTimer();

  initIntro();
  initStateButtons();
}

function draw() {

  // manually update factors via keyboard
  efs.handleControl();

  if (efs.useNoise === undefined || efs.useNoise === 1) {
    efs.updateWithNoise();
    efs.useNoise = 1;
  }

  // Update the region inside the shader;
  eShader.setUniform("factorA", efs.factorA.f);
  eShader.setUniform("factorB", efs.factorB.f);
  eShader.setUniform("factorC", efs.factorC.f);
  eShader.setUniform("factorD", efs.factorD.f);
  eShader.setUniform("factorE", efs.factorE.f);
  eShader.setUniform("factorF", efs.factorF.f);
  eShader.setUniform("factorG", efs.factorG.f);
  eShader.setUniform("factorH", efs.factorH.f);
  eShader.setUniform("factorI", efs.factorI.f);
  eShader.setUniform("factorJ", efs.factorJ.f);
  eShader.setUniform("fRotation", efs.factorR.f);
  eShader.setUniform("fPositionDividend", efs.fPositionDividend.f);
  eShader.setUniform("fGlitch", radians(efs.fGlitch.f));
  eShader.setUniform("uHueSpread", efs.hueSpread !== undefined ? efs.hueSpread : 1.0);
  eShader.setUniform("mouse", [efs.factorX.f/2.0, efs.factorY.f/2.0]);
  eShader.setUniform("resolution", [width/efs.factorW.f, height/efs.factorW.f]);
  eShader.setUniform("time", efs.factorT.f);

  // Give the shader a surface to draw on
  rect(-width/2, -height/2, width, height);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// Wire up the HTML intro modal: fill in the dynamic bits from the running
// factor set, then handle close (button / backdrop / Esc) and reopen.
function initIntro() {
  const intro = document.getElementById('intro');
  const openBtn = document.getElementById('introOpen');
  const secEl = document.getElementById('introTimer');

  if (secEl) secEl.textContent = timerSeconds;

  function closeIntro() {
    introOpen = false;
    if (intro) intro.classList.add('hidden');
  }
  function openIntro() {
    introOpen = true;
    if (intro) intro.classList.remove('hidden');
  }

  document.querySelectorAll('[data-intro-close]').forEach(function (el) {
    el.addEventListener('click', closeIntro);
  });
  // Swallow every click inside the modal so it never reaches the p5 canvas
  // (otherwise closing via a button would also register as a canvas reset,
  // since p5 listens for clicks at the window level).
  if (intro) intro.addEventListener('click', function (e) {
    e.stopPropagation();
    if (e.target === intro) closeIntro(); // click on the dimmed backdrop closes
  });
  if (openBtn) openBtn.addEventListener('click', function (e) {
    e.preventDefault();
    openIntro();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeIntro();
  });
}

// --- Save / load state ------------------------------------------------------
let fileInput; // hidden <input type="file"> driving the Load button

// Serialize the live factor set the same way the Ctrl+L logger does — drop the
// shaderFactors array (it just duplicates the named factors as references).
function serializeFactors(e) {
  return JSON.stringify(e, function (key, value) {
    return key === 'shaderFactors' ? undefined : value;
  }, 2);
}

function fileStamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Save: download the current state as a .json file.
function saveState() {
  try {
    const blob = new Blob([serializeFactors(efs)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'u17sv-state-' + fileStamp() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('State downloaded');
  } catch (err) {
    showToast('Could not save');
  }
}

// Load: read an uploaded .json file and restore it.
function handleStateFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      efs = new ShaderEFactors(JSON.parse(reader.result));
      // Turn Demo Mode off so the restored state isn't overwritten on the next tick.
      demoMode = 0;
      if (demoTimer) demoTimer.reset();
      showToast('State loaded · Demo off');
    } catch (err) {
      showToast('Invalid state file');
    }
  };
  reader.onerror = function () { showToast('Could not read file'); };
  reader.readAsText(file);
  e.target.value = ''; // let the same file be chosen again
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1600);
}

function initStateButtons() {
  const saveBtn = document.getElementById('saveState');
  const loadBtn = document.getElementById('loadState');

  if (saveBtn) saveBtn.addEventListener('click', saveState);

  // A hidden file input backs the Load button's upload dialog.
  fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', handleStateFile);
  document.body.appendChild(fileInput);

  if (loadBtn) loadBtn.addEventListener('click', function () { fileInput.click(); });
}

// keypress handler
// https://p5js.org/reference/p5/keyPressed/
function keyPressed() {
  if (isKeyDown('Shift') && isKeyDown('d')) {
    if (demoMode === 1) {
      demoMode = 0;
    } else {
      demoMode = 1;
    }
  }
  // prevent default
  return false;
}

// Reset on click/tap. Only mouseClicked is used (not touchStarted): p5 fires
// both for a single mouse interaction — touchStarted on press and mouseClicked
// on release — which was resetting the visual twice per click. p5 synthesizes
// a click from touch taps, so touch still triggers a single reset here.
function mouseClicked(event) {
  // Only respond to clicks that actually land on the canvas — not the header
  // buttons/links or the modal. p5 receives the click at the window level, so
  // checking the target is what reliably keeps UI clicks from resetting the
  // visual. Return nothing (not false) for those so p5 does NOT preventDefault
  // the event — otherwise the Gallery link won't navigate and the Save/Load
  // buttons stop working.
  if (event && event.target && event.target.nodeName !== 'CANVAS') return;

  // Ignore canvas clicks while the intro modal is up.
  if (introOpen) return;

  if (isKeyDown('Shift')) {
    // hard refresh
    efs = freshFactors();
  } else {
    // soft refresh
    efs.updateRandom();
  }
  // Restart the Demo Mode countdown so an auto-reset doesn't fire right after.
  if (demoTimer) demoTimer.reset();
  return false; // prevent default only for handled canvas clicks
}

function beginTimer() {
    demoTimer = new DeltaTimer(function(time) {

      if (demoMode === 1) {
        efs = freshFactors();
        efs.updateRandom();
      }
    //efs.expandMinMax();
    //efs.updateRandom();
    efs.isLogLocked = 0;

  }, timerSeconds * 1000);

  demoTimer.start();
}

// an attempt to describe how these factors affect the visual

// a - movement
// b - movement
// c - scale
// d - 
// e - lateral waves
// f - lateral springiness
// g - vertical frequency
// h - background radius
// j - brightness / color
// i - foreground color - green / yellow
// w - resolution
// r - rotation

// represents a set of ShaderFactors for Shader e
class ShaderEFactors {
  constructor(obj) {
    if (obj) {
      
      Object.assign(this, obj);
      
      this.factorA = new ShaderFactor(this.factorA);
      this.factorB = new ShaderFactor(this.factorB);
      this.factorC = new ShaderFactor(this.factorC);
      this.factorD = new ShaderFactor(this.factorD);
      this.factorE = new ShaderFactor(this.factorE);
      this.factorF = new ShaderFactor(this.factorF);
      this.factorG = new ShaderFactor(this.factorG);
      this.factorH = new ShaderFactor(this.factorH);
      this.factorI = new ShaderFactor(this.factorI);
      this.factorJ = new ShaderFactor(this.factorJ);
      this.factorR = new ShaderFactor(this.factorR);
      this.factorT = new ShaderFactor(this.factorT);
      this.factorW = new ShaderFactor(this.factorW);
      this.factorX = new ShaderFactor(this.factorX);
      this.factorY = new ShaderFactor(this.factorY);
      this.fGlitch = new ShaderFactor(this.fGlitch);
      this.fPositionDividend = new ShaderFactor(this.fPositionDividend);

      // Swap the 'w' and 'z' controls from the presets: w now steers the
      // position warp (fPositionDividend), z steers the zoom (factorW).
      if (this.factorW) this.factorW.controlKey = 'z';
      if (this.fPositionDividend) this.fPositionDividend.controlKey = 'w';

    } else {
/*this.factorA = new ShaderFactor(JSON.parse('{"defaultValue":54.984,"f":54.984,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0}'));
this.factorC = new ShaderFactor(JSON.parse('{"defaultValue":33,"f":138.55521038394454,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0}'));
this.factorD = new ShaderFactor(JSON.parse('{"defaultValue":98.1,"f":80.53142619222771,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0}'));
this.factorE = new ShaderFactor(JSON.parse('{"defaultValue":69.1,"f":-55.8915993716673,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0}'));
this.factorF = new ShaderFactor(JSON.parse('{"defaultValue":43,"f":-56.86657752615936,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0}'));
this.factorG = new ShaderFactor(JSON.parse('{"defaultValue":35,"f":122.37439510689967,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0}'));
this.factorH = new ShaderFactor(JSON.parse('{"defaultValue":0.2,"f":-61.587026095236155,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0}'));
this.factorI = new ShaderFactor(JSON.parse('{"defaultValue":-1,"f":-2.8844597292080962,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.006,"isDecreasing":0}'));
this.factorJ = new ShaderFactor(JSON.parse('{"defaultValue":-1.1,"f":-10.585653366893222,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0}'));
this.factorT = new ShaderFactor(JSON.parse('{"defaultValue":19.915,"f":19.915,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0}'));
this.factorW = new ShaderFactor(JSON.parse('{"defaultValue":0.8,"f":0.003591006772435501,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0}'));
this.factorX = new ShaderFactor(JSON.parse('{"defaultValue":-3.191,"f":58.07383530481431,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0}'));
this.factorY = new ShaderFactor(JSON.parse('{"defaultValue":-8.109,"f":-65.61613407378648,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0}'));
this.factorR = new ShaderFactor(JSON.parse('{"defaultValue":1.081,"f":6.300399999999425,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0.0004,"isDecreasing":0}'));
this.fGlitch = new ShaderFactor(JSON.parse('{"defaultValue":4,"f":7.709853216831793,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0}'));
this.fPositionDividend = new ShaderFactor(JSON.parse('{"defaultValue":4,"f":7.709853216831793,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0}'));
      this.factorB = new ShaderFactor(JSON.parse(' {"defaultValue":69,"f":128.59585829926408,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0}'));*/
    }
    
    this.shaderFactors = [
      this.factorA,
      this.factorB,
      this.factorC,
      this.factorD,
      this.factorE,
      this.factorF,
      this.factorG,
      this.factorH,
      this.factorI,
      this.factorJ,
      this.factorR,
      this.factorT,
      this.factorW,
      this.factorX,
      this.factorY,
      this.fGlitch,
      this.fPositionDividend
    ];
    
    this.isLogLocked = 0;
  }
  
  updateRandom() {
    this.shaderFactors.forEach(function(x) { x.updateRandom(); });
  }
  
  updateWithNoise() {
    
    this.factorA.updateWithNoise();
    this.factorI.updateWithNoise();
    this.factorT.updateWithNoise();

  }
  
  expandMinMax() {
    this.shaderFactors.forEach(function(x) { x.expandMinMax(); });
  }
  
  handleControl() {
    this.shaderFactors.forEach(function(x) { x.handleControl(); });
    
    // log -- control+L
    if (isKeyDown('Control') && isKeyDown('l') && this.isLogLocked === 0) {
      
      this.isLogLocked = 1;
      //print(JSON.stringify(this));
      
      print(JSON.stringify(this, (key, value) => {
          if (key === "shaderFactors") {
              return undefined; // Exclude the 'name' property
          }
          return value; // Keep other properties unchanged
      }));
    }
    
    // status -- control+s
    if (isKeyDown('Control') && isKeyDown('s') && this.isLogLocked === 0) {
      
      this.isLogLocked = 1;
      let status = String.format('id:{0} ', this.id);
      this.shaderFactors.forEach(function(x) { status += x.status(); });
      
      print(status);
    }
  }
  
  getControlKeysText() {
    let keys = [];
    this.shaderFactors.forEach(function(x) { keys.push(x.controlKey) });
    let keyString =  keys.sort().join(', ');

    //keyString += String.format(', {0}', x.controlKey);
    return keyString;
  }

  // Rein in the parameters most responsible for harsh strobing/flashing so a
  // random preset is far less likely to land on a full-frame flicker:
  //   fGlitch  — hue rotation + channel-swap glitch (the biggest offender)
  //   factorJ  — brightness/contrast multiplier (blows out to black/white)
  //   factorI  — red-channel multiplier (hard color swings)
  // Tightens each factor's random range and clamps its current value into it.
  calm() {
    this._tame(this.fGlitch, 1.5, 3.5);
    this._tame(this.factorJ, -6, 6);
    this._tame(this.factorI, -6, 6);
  }

  // factorD is unused by the geometry and now drives the shader's hue rotation.
  // Give it the full color wheel and a random starting hue so presets spread
  // across all colors rather than landing on blue/yellow.
  broadenColor() {
    if (this.factorD) {
      this.factorD.fmin = 0;
      this.factorD.fmax = TAU;
      this.factorD.f = random(0, TAU);
      this.factorD.defaultValue = this.factorD.f;
    }
    // Pick a color harmony for this preset: often analogous (narrow hue arc,
    // like a pink/violet/blue scheme), sometimes the full complementary range.
    this.hueSpread = random() < 0.5 ? random(0.12, 0.4) : random(0.5, 1.15);
  }

  _tame(factor, lo, hi) {
    if (!factor) return;
    factor.fmin = Math.max(factor.fmin, lo);
    factor.fmax = Math.min(factor.fmax, hi);
    let clamp = function (v) { return Math.min(Math.max(v, factor.fmin), factor.fmax); };
    factor.f = clamp(factor.f);
    if (factor.defaultValue !== undefined) factor.defaultValue = clamp(factor.defaultValue);
  }

}

String.format = function() {
  var s = arguments[0];
  for (var i = 0; i < arguments.length - 1; i++) {       
      var reg = new RegExp("\\{" + i + "\\}", "gm");             
      s = s.replace(reg, arguments[i + 1]);
  }
  return s;
}

// represents a value that can change over time between a min and max amount
class ShaderFactor {
  
  constructor(obj) {
    
    Object.assign(this, obj);
    
    if (this.f) {
      // we already know what to do
    } else {
      if (this.defaultValue) {
        this.f = this.defaultValue;
      } else {
        this.defaultValue = this.fmin;
        this.f = random(this.fmin, this.fmax);
      }
      this.isIncreasing = 0.0;
      this.isDecreasing = 0.0;
    }
    
    this.directionIndex = floor(random(0, 8));
    this.noiseScale = random(0.002, 0.009);
    this.xOffset = random(-0.5,0.5);
    
  }
  
  update() {
    // reverse if we get too close to min / max
    if (this.f > this.fmax || this.f < this.fmin) {
      this.delta *= -1;
    }
    // change according to the delta value
    this.f += this.delta;
  }
  
  updateRandom() {
    this.f = random(this.fmin, this.fmax);
  }
  
  expandMinMax() {
    this.fmin -= 0.1;
    this.fmax += 0.1;
  }
  
  updateWithNoise() {
    let n = noise(this.fmin * this.noiseScale, this.fmax * this.noiseScale, (frameCount) * this.noiseScale/1000.0);
    
    let a = TAU * n / 1000.0;
    
    if (this.directionIndex == 7) {
      this.f -= sin(a);
    } else if (this.directionIndex == 6) {
      this.f += cos(a);
    } else if (this.directionIndex == 5) {
      this.f += sin(a);
    } else if (this.directionIndex == 4) {
      this.f -= cos(a);
    } else if (this.directionIndex == 3) {
      this.f += tan(a);
    } else if (this.directionIndex == 2) {
      this.f -= tan(a);
    } else if (this.directionIndex == 1) {
      this.f += cos(a);
    } else {
      this.f += sin(a);
    }
    
    //this.f += this.xOffset;
  }
  
  // key codes https://www.toptal.com/developers/keycode
  // https://stackoverflow.com/q/72881145/4463445
  handleControl() {
    // is my key being pressed?
    if (isKeyDown(this.controlKey)) {
      if (keyIsDown(LEFT_ARROW)) {
        this.decrease();
      } else if (keyIsDown(RIGHT_ARROW)) {
        this.increase();
      } else if (isKeyDown('0')) {
        this.stopChanging();
      }
    }
    
    if (this.f < this.fmax)
      this.f += this.isIncreasing;
    
    if (this.f > this.fmin)
      this.f -= this.isDecreasing;
    
    if (isKeyDown('q') || isKeyDown('Escape')){
      this.resetControls();
    }
  }
  
  status() {
    return String.format('{0}:{1} ', this.controlKey, round(this.f, 3));
  }
  
  resetControls() {
    this.f = this.defaultValue;
    this.isIncreasing = 0.0;
    this.isDecreasing = 0.0;
  }
  
  stopChanging() {
    this.isIncreasing = 0.0;
    this.isDecreasing = 0.0;
  }
  
  increase() {
    this.isDecreasing = 0.0;
    this.isIncreasing += this.controlDelta;
  }
  
  decrease(){
    this.isIncreasing = 0.0;
    this.isDecreasing += this.controlDelta;
  }
}

// provides an accurate, repeatable timer
// from https://stackoverflow.com/a/11624239/4463445
function DeltaTimer(render, interval) {
  var timeout;
  var lastTime;

  this.start = start;
  this.stop = stop;
  this.reset = reset;

  function start() {
    timeout = setTimeout(loop, 0);
    lastTime = +new Date();
    return lastTime;
  }

  function stop() {
    clearTimeout(timeout);
    return lastTime;
  }

  // Restart the countdown: schedule the next tick a full interval from now,
  // without the immediate render that start() does.
  function reset() {
    clearTimeout(timeout);
    lastTime = (+new Date()) + interval;
    timeout = setTimeout(loop, interval);
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

Array.prototype.sample = function(){
  return this[Math.floor(Math.random()*this.length)];
}

function getFav(id) {
  let favs = [
    '{"factorA":{"defaultValue":54.984,"f":25.17886254741454,"delta":0.01,"fmin":15.19999999999999,"fmax":161.7999999999999,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008557568958373254,"xOffset":-0.3996834144373689},"factorC":{"defaultValue":33,"f":-43.76557925534951,"delta":0.001,"fmin":-141.7999999999999,"fmax":141.7999999999999,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0,"directionIndex":7,"noiseScale":0.004198937337172972,"xOffset":-0.3838535553321828},"factorD":{"defaultValue":98.1,"f":140.65247263113645,"delta":0.007,"fmin":-141.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0,"directionIndex":7,"noiseScale":0.0029608118960470957,"xOffset":0.10759342150099704},"factorE":{"defaultValue":69.1,"f":-65.82801411873906,"delta":0.002,"fmin":-141.7999999999999,"fmax":181.7999999999999,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0,"directionIndex":6,"noiseScale":0.0031518319145127554,"xOffset":-0.4872945554103204},"factorF":{"defaultValue":43,"f":10.027556942105463,"delta":0.002,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.008484611528134484,"xOffset":0.2707248388740514},"factorG":{"defaultValue":35,"f":-100.69702712783669,"delta":0.008,"fmin":-141.7999999999999,"fmax":171.7999999999999,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.007128205875651299,"xOffset":0.45794246214554235},"factorH":{"defaultValue":0.2,"f":-81.25318552060406,"delta":0.003,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.004210671899378189,"xOffset":-0.4200400411513484},"factorI":{"defaultValue":-1,"f":349.119547830118,"delta":0.003,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0,"directionIndex":1,"noiseScale":0.004523198852322356,"xOffset":0.07508478064616397},"factorJ":{"defaultValue":-1.1,"f":-6.409564224616428,"delta":0.001,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0,"directionIndex":7,"noiseScale":0.0062374666100870136,"xOffset":0.36346884214627284},"factorT":{"defaultValue":19.915,"f":121.16336495934297,"delta":0.0001,"fmin":-51.800000000000026,"fmax":151.7999999999999,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.0032740911208376123,"xOffset":-0.3864808532615863},"factorW":{"defaultValue":0.8,"f":1.9335432928728282,"delta":0.01,"fmin":-1.7990000000000006,"fmax":3.8000000000000016,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0,"directionIndex":6,"noiseScale":0.006412085079525425,"xOffset":0.37630521368839553},"factorX":{"defaultValue":-3.191,"f":-12.68185156171944,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0,"directionIndex":4,"noiseScale":0.0069324493383055704,"xOffset":-0.3583580244431679},"factorY":{"defaultValue":-8.109,"f":-65.36882054622752,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.005226261388301599,"xOffset":0.3883141249627795},"factorR":{"defaultValue":1.081,"f":3.601821249598105,"delta":0.01,"fmin":-4.9499999999999975,"fmax":8.099999999999994,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0.0004,"isDecreasing":0,"directionIndex":4,"noiseScale":0.002064935824857967,"xOffset":-0.07690505376502765},"fGlitch":{"defaultValue":4,"f":360.04532205625753,"delta":0.01,"fmin":0,"fmax":360,"controlDelta":0.01,"controlKey":"v","isIncreasing":0.1,"isDecreasing":0,"directionIndex":4,"noiseScale":0.00637388321723493,"xOffset":-0.3133153953421104},"fPositionDividend":{"defaultValue":4,"f":9.409595910741416,"delta":0.01,"fmin":0.19999999999999937,"fmax":9.799999999999994,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0,"directionIndex":6,"noiseScale":0.006491343178124881,"xOffset":0.3923127654478492},"factorB":{"defaultValue":69,"f":-20.673395404747737,"delta":0.02,"fmin":-161.7999999999999,"fmax":161.7999999999999,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.015,"isDecreasing":0,"directionIndex":0,"noiseScale":0.006978831182655504,"xOffset":0.38333693070248454},"isLogLocked":1,"id":"0","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":115.93171863001557,"delta":0.01,"fmin":15.19999999999999,"fmax":161.7999999999999,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008557568958373254,"xOffset":-0.3996834144373689},"factorC":{"defaultValue":33,"f":-36.17364477909034,"delta":0.001,"fmin":-141.7999999999999,"fmax":141.7999999999999,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0,"directionIndex":7,"noiseScale":0.004198937337172972,"xOffset":-0.3838535553321828},"factorD":{"defaultValue":98.1,"f":117.05083622641666,"delta":0.007,"fmin":-141.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0,"directionIndex":7,"noiseScale":0.0029608118960470957,"xOffset":0.10759342150099704},"factorE":{"defaultValue":69.1,"f":163.251153890179,"delta":0.002,"fmin":-141.7999999999999,"fmax":181.7999999999999,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0,"directionIndex":6,"noiseScale":0.0031518319145127554,"xOffset":-0.4872945554103204},"factorF":{"defaultValue":43,"f":93.90452663339141,"delta":0.002,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.008484611528134484,"xOffset":0.2707248388740514},"factorG":{"defaultValue":35,"f":163.7903846558533,"delta":0.008,"fmin":-141.7999999999999,"fmax":171.7999999999999,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.007128205875651299,"xOffset":0.45794246214554235},"factorH":{"defaultValue":0.2,"f":-22.900342058400057,"delta":0.003,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.004210671899378189,"xOffset":-0.4200400411513484},"factorI":{"defaultValue":-1,"f":322.3851855074119,"delta":0.003,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0,"directionIndex":1,"noiseScale":0.004523198852322356,"xOffset":0.07508478064616397},"factorJ":{"defaultValue":-1.1,"f":12.819872888606668,"delta":0.001,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0,"directionIndex":7,"noiseScale":0.0062374666100870136,"xOffset":0.36346884214627284},"factorT":{"defaultValue":19.915,"f":117.5022452597713,"delta":0.0001,"fmin":-51.800000000000026,"fmax":151.7999999999999,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.0032740911208376123,"xOffset":-0.3864808532615863},"factorW":{"defaultValue":0.8,"f":3.201893398414458,"delta":0.01,"fmin":-1.7990000000000006,"fmax":3.8000000000000016,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0,"directionIndex":6,"noiseScale":0.006412085079525425,"xOffset":0.37630521368839553},"factorX":{"defaultValue":-3.191,"f":79.20824085989312,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0,"directionIndex":4,"noiseScale":0.0069324493383055704,"xOffset":-0.3583580244431679},"factorY":{"defaultValue":-8.109,"f":-91.84609537138196,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.005226261388301599,"xOffset":0.3883141249627795},"factorR":{"defaultValue":1.081,"f":3.4365723052059325,"delta":0.01,"fmin":-4.9499999999999975,"fmax":8.099999999999994,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0.0004,"isDecreasing":0,"directionIndex":4,"noiseScale":0.002064935824857967,"xOffset":-0.07690505376502765},"fGlitch":{"defaultValue":4,"f":136.5292654002399,"delta":0.01,"fmin":0,"fmax":360,"controlDelta":0.01,"controlKey":"v","isIncreasing":0.1,"isDecreasing":0,"directionIndex":4,"noiseScale":0.00637388321723493,"xOffset":-0.3133153953421104},"fPositionDividend":{"defaultValue":4,"f":5.3343525082148995,"delta":0.01,"fmin":0.19999999999999937,"fmax":9.799999999999994,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0,"directionIndex":6,"noiseScale":0.006491343178124881,"xOffset":0.3923127654478492},"factorB":{"defaultValue":69,"f":-148.77299864386552,"delta":0.02,"fmin":-161.7999999999999,"fmax":161.7999999999999,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.015,"isDecreasing":0,"directionIndex":0,"noiseScale":0.006978831182655504,"xOffset":0.38333693070248454},"isLogLocked":1,"id":"1","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":66.7248455852611,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.005,"directionIndex":3,"noiseScale":0.0026064714318032416,"xOffset":0.39091318908591344},"factorC":{"defaultValue":33,"f":29.906072378759962,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.002863067570347033,"xOffset":0.44859727793142756},"factorD":{"defaultValue":98.1,"f":8.516887121860684,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0,"directionIndex":4,"noiseScale":0.00439290738588557,"xOffset":-0.1846293415622785},"factorE":{"defaultValue":69.1,"f":-77.98332775694489,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008409444725841826,"xOffset":-0.38992597239880966},"factorF":{"defaultValue":43,"f":73.04745810365814,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.009000000000000001,"directionIndex":3,"noiseScale":0.0038277534304133514,"xOffset":0.3059828144467671},"factorG":{"defaultValue":35,"f":23.538629975196162,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.010000000000000002,"isDecreasing":0,"directionIndex":0,"noiseScale":0.0064567142307584416,"xOffset":0.13234833031168147},"factorH":{"defaultValue":0.2,"f":1.533803160339423,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0,"directionIndex":4,"noiseScale":0.0027561083177527245,"xOffset":-0.049660590846947295},"factorI":{"defaultValue":-1,"f":34849.61850662008,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.017000000000000008,"directionIndex":6,"noiseScale":0.0029252820044965333,"xOffset":0.2246767810791439},"factorJ":{"defaultValue":-1.1,"f":14.001953292626832,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0.006,"isDecreasing":0,"directionIndex":0,"noiseScale":0.007395683537425263,"xOffset":-0.26022646305124797},"factorT":{"defaultValue":19.915,"f":-76.61848998340209,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0.0010000000000000002,"isDecreasing":0,"directionIndex":7,"noiseScale":0.005860116669886441,"xOffset":-0.4257849250408787},"factorW":{"defaultValue":0.8,"f":0.5418810205587562,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0,"directionIndex":4,"noiseScale":0.002974503452926192,"xOffset":0.05182511805834111},"factorX":{"defaultValue":-3.191,"f":52.11332406432544,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0.006,"directionIndex":1,"noiseScale":0.003964657670215618,"xOffset":-0.2437944117203621},"factorY":{"defaultValue":-8.109,"f":-32.33969580340725,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.009000000000000001,"isDecreasing":0,"directionIndex":5,"noiseScale":0.006983276359470995,"xOffset":0.01440936254860381},"factorR":{"defaultValue":1.081,"f":-1.1466449895456798,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0,"directionIndex":7,"noiseScale":0.002572923092104892,"xOffset":-0.3406952295232175},"fGlitch":{"defaultValue":4,"f":8.000382456798729,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0005,"isDecreasing":0,"directionIndex":6,"noiseScale":0.005606297740296126,"xOffset":-0.013200742244814823},"fPositionDividend":{"defaultValue":4,"f":8.000345282094807,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0007000000000000001,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008737239388194703,"xOffset":-0.1204257662213295},"factorB":{"defaultValue":69,"f":-56.65402437616379,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.0078682601728653,"xOffset":-0.43751191906079623},"isLogLocked":1,"id":"2","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":112.7841616973822,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006,"directionIndex":3,"noiseScale":0.0034942308878647384,"xOffset":0.4013898305437231},"factorC":{"defaultValue":33,"f":29.004463176623545,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.007765166903058704,"xOffset":-0.12809192284456916},"factorD":{"defaultValue":98.1,"f":-85.2830871837146,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.007,"isDecreasing":0,"directionIndex":0,"noiseScale":0.004562652516348813,"xOffset":-0.3156643187175946},"factorE":{"defaultValue":69.1,"f":-12.286369412818416,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.008,"directionIndex":2,"noiseScale":0.0053974189019219115,"xOffset":-0.1364541267662338},"factorF":{"defaultValue":43,"f":-68.37142407044949,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.005,"isDecreasing":0,"directionIndex":6,"noiseScale":0.004110008794621632,"xOffset":0.07168244628192066},"factorG":{"defaultValue":35,"f":80.15537683672588,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.008,"isDecreasing":0,"directionIndex":5,"noiseScale":0.006935531973724667,"xOffset":-0.44387003496149036},"factorH":{"defaultValue":0.2,"f":-76.08820492381727,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.012000000000000004,"isDecreasing":0,"directionIndex":0,"noiseScale":0.004613918645353471,"xOffset":0.11087715748134797},"factorI":{"defaultValue":-1,"f":-5.46904506768731,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008985398898166625,"xOffset":0.31227935783442307},"factorJ":{"defaultValue":-1.1,"f":4.396556647231421,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.002236701239640127,"xOffset":-0.4395536104705773},"factorT":{"defaultValue":19.915,"f":-16.43456092090749,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0.0007000000000000001,"isDecreasing":0,"directionIndex":5,"noiseScale":0.0024912733772381596,"xOffset":-0.23136770982477506},"factorW":{"defaultValue":0.8,"f":1.4349089054835042,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008842553952866863,"xOffset":-0.08907427425231862},"factorX":{"defaultValue":-3.191,"f":30.16156871680161,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.0027506980995989825,"xOffset":-0.07706580667124696},"factorY":{"defaultValue":-8.109,"f":-21.380336378564834,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.004345114441519177,"xOffset":-0.0965570499940116},"factorR":{"defaultValue":1.081,"f":1.9306572541510358,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.00389903117102208,"xOffset":0.1723698316298733},"fGlitch":{"defaultValue":4,"f":7.552619430219793,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0009000000000000002,"isDecreasing":0,"directionIndex":5,"noiseScale":0.005288005359351491,"xOffset":-0.3435445983751161},"fPositionDividend":{"defaultValue":4,"f":2.879550097860641,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.0025167064417606034,"xOffset":0.022250383983518307},"factorB":{"defaultValue":69,"f":113.98253684964169,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0,"directionIndex":6,"noiseScale":0.00528519559179595,"xOffset":-0.4502537362670168},"isLogLocked":1,"id":"3","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":142.15694424705734,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006,"directionIndex":3,"noiseScale":0.0034942308878647384,"xOffset":0.4013898305437231},"factorC":{"defaultValue":33,"f":-72.72892762124229,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.007765166903058704,"xOffset":-0.12809192284456916},"factorD":{"defaultValue":98.1,"f":-53.351112878137165,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.007,"isDecreasing":0,"directionIndex":0,"noiseScale":0.004562652516348813,"xOffset":-0.3156643187175946},"factorE":{"defaultValue":69.1,"f":-115.19832775694307,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.008,"directionIndex":2,"noiseScale":0.0053974189019219115,"xOffset":-0.1364541267662338},"factorF":{"defaultValue":43,"f":25.301458103618277,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.005,"isDecreasing":0,"directionIndex":6,"noiseScale":0.004110008794621632,"xOffset":0.07168244628192066},"factorG":{"defaultValue":35,"f":-34.671370024802336,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.008,"isDecreasing":0,"directionIndex":5,"noiseScale":0.006935531973724667,"xOffset":-0.44387003496149036},"factorH":{"defaultValue":0.2,"f":-0.9181968396640632,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.012000000000000004,"isDecreasing":0,"directionIndex":0,"noiseScale":0.004613918645353471,"xOffset":0.11087715748134797},"factorI":{"defaultValue":-1,"f":-8.80112740731294,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008985398898166625,"xOffset":0.31227935783442307},"factorJ":{"defaultValue":-1.1,"f":-11.363046707373684,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.002236701239640127,"xOffset":-0.4395536104705773},"factorT":{"defaultValue":19.915,"f":111.37697210927195,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0.0007000000000000001,"isDecreasing":0,"directionIndex":5,"noiseScale":0.0024912733772381596,"xOffset":-0.23136770982477506},"factorW":{"defaultValue":0.8,"f":1.020181020558748,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.008842553952866863,"xOffset":-0.08907427425231862},"factorX":{"defaultValue":-3.191,"f":85.15132406434299,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.0027506980995989825,"xOffset":-0.07706580667124696},"factorY":{"defaultValue":-8.109,"f":-19.164695803412314,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0,"directionIndex":3,"noiseScale":0.004345114441519177,"xOffset":-0.0965570499940116},"factorR":{"defaultValue":1.081,"f":-2.307644989545553,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.00389903117102208,"xOffset":0.1723698316298733},"fGlitch":{"defaultValue":4,"f":4.215782456800132,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0009000000000000002,"isDecreasing":0,"directionIndex":5,"noiseScale":0.005288005359351491,"xOffset":-0.3435445983751161},"fPositionDividend":{"defaultValue":4,"f":2.7694452820938222,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.0025167064417606034,"xOffset":0.022250383983518307},"factorB":{"defaultValue":69,"f":0.2109756238223027,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0,"directionIndex":6,"noiseScale":0.00528519559179595,"xOffset":-0.4502537362670168},"isLogLocked":1,"id":"4","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":64.45237022911763,"delta":0.01,"fmin":16.39999999999999,"fmax":160.59999999999997,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.009000000000000001,"directionIndex":5,"noiseScale":0.002721122011313071,"xOffset":0.46158976831459275},"factorC":{"defaultValue":33,"f":-12.192727584042917,"delta":0.001,"fmin":-140.59999999999997,"fmax":140.59999999999997,"controlDelta":0.001,"controlKey":"c","isIncreasing":0.005,"isDecreasing":0,"directionIndex":1,"noiseScale":0.006512812463729524,"xOffset":0.35068154478797375},"factorD":{"defaultValue":98.1,"f":37.22723687636736,"delta":0.007,"fmin":-140.59999999999997,"fmax":150.59999999999997,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.006,"isDecreasing":0,"directionIndex":5,"noiseScale":0.007660299929652357,"xOffset":0.0055331084904864936},"factorE":{"defaultValue":69.1,"f":4.4624284348574275,"delta":0.002,"fmin":-140.59999999999997,"fmax":180.59999999999997,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005,"directionIndex":6,"noiseScale":0.00404446985056668,"xOffset":0.28203918927385463},"factorF":{"defaultValue":43,"f":-14.905264686960162,"delta":0.002,"fmin":-140.59999999999997,"fmax":110.59999999999997,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.009000000000000001,"isDecreasing":0,"directionIndex":0,"noiseScale":0.004870549100596444,"xOffset":-0.2540871223612924},"factorG":{"defaultValue":35,"f":-129.46871665063233,"delta":0.008,"fmin":-140.59999999999997,"fmax":170.59999999999997,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.005,"directionIndex":1,"noiseScale":0.006865835696124834,"xOffset":-0.26635780417923527},"factorH":{"defaultValue":0.2,"f":20.44180884093648,"delta":0.003,"fmin":-140.59999999999997,"fmax":110.59999999999997,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.005,"directionIndex":4,"noiseScale":0.008072091808009683,"xOffset":0.03454437212219408},"factorI":{"defaultValue":-1,"f":-0.29008322931750097,"delta":0.003,"fmin":-14.599999999999998,"fmax":14.599999999999998,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.008,"isDecreasing":0,"directionIndex":3,"noiseScale":0.007194608640754583,"xOffset":-0.44704026377624373},"factorJ":{"defaultValue":-1.1,"f":-11.320420805334585,"delta":0.001,"fmin":-14.599999999999998,"fmax":14.599999999999998,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.005,"directionIndex":6,"noiseScale":0.005914549485563076,"xOffset":-0.4914431286769919},"factorT":{"defaultValue":19.915,"f":64.03182801796106,"delta":0.0001,"fmin":-50.60000000000001,"fmax":150.59999999999997,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0,"directionIndex":0,"noiseScale":0.007367945893119552,"xOffset":-0.10536514503781469},"factorW":{"defaultValue":0.8,"f":0.21828318213288,"delta":0.01,"fmin":-0.599,"fmax":2.6000000000000005,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0,"directionIndex":5,"noiseScale":0.003756826719256982,"xOffset":0.1612154641267981},"factorX":{"defaultValue":-3.191,"f":76.06452949755766,"delta":0.01,"fmin":-150.59999999999997,"fmax":150.59999999999997,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0.005,"directionIndex":1,"noiseScale":0.0028940619709134103,"xOffset":0.4336455632416667},"factorY":{"defaultValue":-8.109,"f":-131.03113375148286,"delta":0.01,"fmin":-150.59999999999997,"fmax":150.59999999999997,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0.005,"directionIndex":7,"noiseScale":0.005007856912371623,"xOffset":-0.38943531729811764},"factorR":{"defaultValue":1.081,"f":-2.2902865865273148,"delta":0.01,"fmin":-3.7500000000000004,"fmax":6.899999999999998,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001,"directionIndex":1,"noiseScale":0.007401528966494674,"xOffset":0.4359114916878798},"fGlitch":{"defaultValue":4,"f":3.546665798061013,"delta":0.01,"fmin":1.3999999999999995,"fmax":8.599999999999998,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0006000000000000001,"isDecreasing":0,"directionIndex":3,"noiseScale":0.006298813378055188,"xOffset":0.032432861843391},"fPositionDividend":{"defaultValue":4,"f":6.961379532605139,"delta":0.01,"fmin":1.3999999999999995,"fmax":8.599999999999998,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0006000000000000001,"isDecreasing":0,"directionIndex":7,"noiseScale":0.006136555012193781,"xOffset":-0.20023212873587581},"factorB":{"defaultValue":69,"f":137.94527189826368,"delta":0.02,"fmin":-160.59999999999997,"fmax":160.59999999999997,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025,"directionIndex":5,"noiseScale":0.007746441679058079,"xOffset":-0.35347385099486484},"isLogLocked":1,"id":"5","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":160.0044758878039,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0.008,"isDecreasing":0,"directionIndex":1,"noiseScale":0.004618325033222166,"xOffset":-0.03385923873184837},"factorC":{"defaultValue":33,"f":109.09671989289524,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0.010000000000000002,"isDecreasing":0,"directionIndex":3,"noiseScale":0.007418257613467686,"xOffset":0.059377498524888384},"factorD":{"defaultValue":98.1,"f":150.00083939398223,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.007,"isDecreasing":0,"directionIndex":3,"noiseScale":0.004433451462461261,"xOffset":-0.04954893159601037},"factorE":{"defaultValue":69.1,"f":180.00667036497836,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0,"directionIndex":7,"noiseScale":0.004723711482148178,"xOffset":0.4826362882817159},"factorF":{"defaultValue":43,"f":14575.612147165491,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005,"directionIndex":6,"noiseScale":0.006695037195501299,"xOffset":-0.4989721824791826},"factorG":{"defaultValue":35,"f":63.868067822058066,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0,"directionIndex":4,"noiseScale":0.00556665257715851,"xOffset":0.24927294330032757},"factorH":{"defaultValue":0.2,"f":110.01335453220058,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0,"directionIndex":5,"noiseScale":0.006394600913375407,"xOffset":-0.2041672549822372},"factorI":{"defaultValue":-1,"f":-271.0504795141602,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.02100000000000001,"directionIndex":2,"noiseScale":0.007017553872573937,"xOffset":-0.17179685630921981},"factorJ":{"defaultValue":-1.1,"f":-14.001119836591052,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.010000000000000002,"directionIndex":4,"noiseScale":0.0034890029765525694,"xOffset":0.43950119210573013},"factorT":{"defaultValue":19.915,"f":-1.9374434795681152,"delta":0.0001,"fmin":-50,"fmax":50,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0.0007000000000000001,"isDecreasing":0,"directionIndex":2,"noiseScale":0.005325724269159516,"xOffset":0.12709950847068485},"factorW":{"defaultValue":0.8,"f":0.6943562871600457,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0.00025,"directionIndex":1,"noiseScale":0.006678796843625628,"xOffset":0.2070145104256732},"factorX":{"defaultValue":-3.191,"f":-70.140498491532,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.008,"isDecreasing":0,"directionIndex":5,"noiseScale":0.006606140027207148,"xOffset":0.2532069944334152},"factorY":{"defaultValue":-8.109,"f":19.239400745707545,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.008,"isDecreasing":0,"directionIndex":5,"noiseScale":0.007768346612072079,"xOffset":-0.45771478019646605},"factorR":{"defaultValue":1.081,"f":-1.0919377385234135,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0,"directionIndex":1,"noiseScale":0.008415291260698758,"xOffset":0.3510853840645246},"fGlitch":{"defaultValue":4,"f":8.00023377811833,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0013000000000000004,"isDecreasing":0,"directionIndex":7,"noiseScale":0.004407523395966687,"xOffset":-0.2916230025849468},"fPositionDividend":{"defaultValue":4,"f":1.999582719006179,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005,"directionIndex":2,"noiseScale":0.0020226941119011912,"xOffset":-0.4014229375221452},"factorB":{"defaultValue":69,"f":160.0112761650305,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0,"directionIndex":5,"noiseScale":0.0048623174708262145,"xOffset":0.12870235148186182},"isLogLocked":1,"id":"6","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":127.85747588776024,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006,"directionIndex":2,"noiseScale":0.003969846504216562,"xOffset":0.03655628364756214},"factorC":{"defaultValue":33,"f":91.2107198928814,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007,"directionIndex":1,"noiseScale":0.002076997911993692,"xOffset":0.30607095524713634},"factorD":{"defaultValue":98.1,"f":82.66183939392326,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006,"directionIndex":3,"noiseScale":0.008783565069304156,"xOffset":0.028451823136811938},"factorE":{"defaultValue":69.1,"f":80.36867036490716,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0,"directionIndex":7,"noiseScale":0.002235652291287649,"xOffset":-0.2099447812371712},"factorF":{"defaultValue":43,"f":53.64775777500619,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005,"directionIndex":6,"noiseScale":0.007199547145278212,"xOffset":0.3419659439804077},"factorG":{"defaultValue":35,"f":-67.48693217794654,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0,"directionIndex":7,"noiseScale":0.004130627088057049,"xOffset":0.06378527710389048},"factorH":{"defaultValue":0.2,"f":77.78535453221026,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0,"directionIndex":0,"noiseScale":0.00890468998183825,"xOffset":0.4903405555159642},"factorI":{"defaultValue":-1,"f":-256.1470399140215,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.013000000000000005,"directionIndex":0,"noiseScale":0.007862818348640603,"xOffset":0.15480734283552822},"factorJ":{"defaultValue":-1.1,"f":-9.798119836590887,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0.005,"isDecreasing":0,"directionIndex":7,"noiseScale":0.0029031828847688747,"xOffset":0.28093363633572377},"factorT":{"defaultValue":19.915,"f":20.56411834968486,"delta":0.0001,"fmin":-50,"fmax":50,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006,"directionIndex":4,"noiseScale":0.006051374898113903,"xOffset":0.17119661991338242},"factorW":{"defaultValue":0.8,"f":0.09864628715990868,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0,"directionIndex":4,"noiseScale":0.0032267264680883308,"xOffset":0.36569074744598307},"factorX":{"defaultValue":-3.191,"f":-73.4584984914906,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0,"directionIndex":2,"noiseScale":0.007629402221089177,"xOffset":-0.06639170913099202},"factorY":{"defaultValue":-8.109,"f":-90.37859925429584,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0,"directionIndex":6,"noiseScale":0.002566889037496057,"xOffset":-0.4095679708079176},"factorR":{"defaultValue":1.081,"f":-1.4841377385233565,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0,"directionIndex":2,"noiseScale":0.006357483785690077,"xOffset":-0.3061155566192667},"fGlitch":{"defaultValue":4,"f":2.0116337781195903,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0.0005,"directionIndex":0,"noiseScale":0.0025552865445145276,"xOffset":0.3560282324908549},"fPositionDividend":{"defaultValue":4,"f":4.48108271900658,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005,"directionIndex":3,"noiseScale":0.0044460184348498275,"xOffset":0.43411888623688},"factorB":{"defaultValue":69,"f":98.33627616501647,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0,"directionIndex":0,"noiseScale":0.005294285287183556,"xOffset":-0.20290296257215745},"isLogLocked":1,"id":"7","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":8.09545459681943,"delta":0.01,"fmin":8.100000000000016,"fmax":168.8999999999995,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.009000000000000001},"factorC":{"defaultValue":33,"f":-1.880714643716943,"delta":0.001,"fmin":-148.8999999999995,"fmax":148.8999999999995,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-46.91543277052121,"delta":0.007,"fmin":-148.8999999999995,"fmax":158.8999999999995,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-65.43396970644906,"delta":0.002,"fmin":-148.8999999999995,"fmax":188.8999999999995,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-41.964673850529266,"delta":0.002,"fmin":-148.8999999999995,"fmax":118.8999999999995,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.008},"factorG":{"defaultValue":35,"f":54.52883389336968,"delta":0.008,"fmin":-148.8999999999995,"fmax":178.8999999999995,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.011000000000000003},"factorH":{"defaultValue":0.2,"f":-37.81894110308681,"delta":0.003,"fmin":-148.8999999999995,"fmax":118.8999999999995,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.010000000000000002},"factorI":{"defaultValue":-1,"f":22.90422668262876,"delta":0.003,"fmin":-22.90000000000009,"fmax":22.90000000000009,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.008,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":22.900266043277043,"delta":0.001,"fmin":-22.90000000000009,"fmax":22.90000000000009,"controlDelta":0.001,"controlKey":"j","isIncreasing":0.006,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":74.81087205798917,"delta":0.0001,"fmin":-58.90000000000013,"fmax":158.8999999999995,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0012000000000000003},"factorW":{"defaultValue":0.8,"f":-6.622933993912561,"delta":0.01,"fmin":-8.898999999999985,"fmax":10.899999999999977,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-1.797135205940346,"delta":0.01,"fmin":-158.8999999999995,"fmax":158.8999999999995,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":7.264540014931942,"delta":0.01,"fmin":-158.8999999999995,"fmax":158.8999999999995,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":6.276345612792108,"delta":0.01,"fmin":-12.049999999999972,"fmax":15.199999999999969,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":-7.172835682451556,"delta":0.01,"fmin":-7.099999999999991,"fmax":367.1000000000016,"controlDelta":0.01,"controlKey":"v","isIncreasing":0,"isDecreasing":0.10999999999999999},"fPositionDividend":{"defaultValue":4,"f":16.901255884172134,"delta":0.01,"fmin":-6.899999999999992,"fmax":16.899999999999984,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0022,"isDecreasing":0},"factorB":{"defaultValue":69,"f":168.93723305214,"delta":0.02,"fmin":-168.8999999999995,"fmax":168.8999999999995,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.04,"isDecreasing":0},"isLogLocked":1,"id":"8","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":43.80752349189184,"delta":0.01,"fmin":16.39999999999999,"fmax":160.59999999999997,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.009000000000000001},"factorC":{"defaultValue":33,"f":-54.034100186591594,"delta":0.001,"fmin":-140.59999999999997,"fmax":140.59999999999997,"controlDelta":0.001,"controlKey":"c","isIncreasing":0.005,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-91.51827831186966,"delta":0.007,"fmin":-140.59999999999997,"fmax":150.59999999999997,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.006,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-1.3733493037190811,"delta":0.002,"fmin":-140.59999999999997,"fmax":180.59999999999997,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":-116.7959869808998,"delta":0.002,"fmin":-140.59999999999997,"fmax":110.59999999999997,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorG":{"defaultValue":35,"f":27.605445578163046,"delta":0.008,"fmin":-140.59999999999997,"fmax":170.59999999999997,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.005},"factorH":{"defaultValue":0.2,"f":94.58766177937235,"delta":0.003,"fmin":-140.59999999999997,"fmax":110.59999999999997,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.005},"factorI":{"defaultValue":-1,"f":-1.4484666365619896,"delta":0.003,"fmin":-14.599999999999998,"fmax":14.599999999999998,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.008,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":6.645893477807353,"delta":0.001,"fmin":-14.599999999999998,"fmax":14.599999999999998,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.005},"factorT":{"defaultValue":19.915,"f":57.949999687769065,"delta":0.0001,"fmin":-50.60000000000001,"fmax":150.59999999999997,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":1.864301106058617,"delta":0.01,"fmin":-0.599,"fmax":2.6000000000000005,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-102.81873225853438,"delta":0.01,"fmin":-150.59999999999997,"fmax":150.59999999999997,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0.005},"factorY":{"defaultValue":-8.109,"f":-73.87717562184291,"delta":0.01,"fmin":-150.59999999999997,"fmax":150.59999999999997,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0.005},"factorR":{"defaultValue":1.081,"f":-0.57135710127158,"delta":0.01,"fmin":-3.7500000000000004,"fmax":6.899999999999998,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001},"fGlitch":{"defaultValue":4,"f":7.734379299139524,"delta":0.01,"fmin":1.3999999999999995,"fmax":8.599999999999998,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0006000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":5.539066836780147,"delta":0.01,"fmin":1.3999999999999995,"fmax":8.599999999999998,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0006000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-42.32401515109171,"delta":0.02,"fmin":-160.59999999999997,"fmax":160.59999999999997,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025},"isLogLocked":1,"id":"9","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":80.42008229736132,"delta":0.01,"fmin":14.799999999999992,"fmax":162.19999999999987,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.009000000000000001},"factorC":{"defaultValue":33,"f":-131.4824279744092,"delta":0.001,"fmin":-142.19999999999987,"fmax":142.19999999999987,"controlDelta":0.001,"controlKey":"c","isIncreasing":0.005,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":111.52096569085535,"delta":0.007,"fmin":-142.19999999999987,"fmax":152.19999999999987,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.006,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":103.65054238337652,"delta":0.002,"fmin":-142.19999999999987,"fmax":182.19999999999987,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":-56.56193308363905,"delta":0.002,"fmin":-142.19999999999987,"fmax":112.19999999999987,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorG":{"defaultValue":35,"f":-94.52956249889625,"delta":0.008,"fmin":-142.19999999999987,"fmax":172.19999999999987,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.005},"factorH":{"defaultValue":0.2,"f":61.878046106525495,"delta":0.003,"fmin":-142.19999999999987,"fmax":112.19999999999987,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.005},"factorI":{"defaultValue":-1,"f":16.201825137683876,"delta":0.003,"fmin":-16.199999999999996,"fmax":16.199999999999996,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.008,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":12.663831873203323,"delta":0.001,"fmin":-16.199999999999996,"fmax":16.199999999999996,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.005},"factorT":{"defaultValue":19.915,"f":43.01704383686143,"delta":0.0001,"fmin":-52.20000000000003,"fmax":152.19999999999987,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":1.5273398440623387,"delta":0.01,"fmin":-2.1990000000000007,"fmax":4.200000000000001,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-18.96755486735776,"delta":0.01,"fmin":-152.19999999999987,"fmax":152.19999999999987,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0.005},"factorY":{"defaultValue":-8.109,"f":-100.93373346815224,"delta":0.01,"fmin":-152.19999999999987,"fmax":152.19999999999987,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0.005},"factorR":{"defaultValue":1.081,"f":3.5078085642106855,"delta":0.01,"fmin":-5.349999999999996,"fmax":8.499999999999993,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001},"fGlitch":{"defaultValue":4,"f":3.7101567520643384,"delta":0.01,"fmin":-0.20000000000000065,"fmax":10.199999999999992,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0006000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":7.903851461669199,"delta":0.01,"fmin":-0.20000000000000065,"fmax":10.199999999999992,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0006000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-12.993336724643333,"delta":0.02,"fmin":-162.19999999999987,"fmax":162.19999999999987,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025},"isLogLocked":1,"id":"10","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":39.54145459682062,"delta":0.01,"fmin":15.19999999999999,"fmax":161.7999999999999,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":-1.880714643716943,"delta":0.001,"fmin":-141.7999999999999,"fmax":141.7999999999999,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-46.91543277052121,"delta":0.007,"fmin":-141.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-140.1059697065105,"delta":0.002,"fmin":-141.7999999999999,"fmax":181.7999999999999,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":34.69332614947326,"delta":0.002,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.006,"isDecreasing":0},"factorG":{"defaultValue":35,"f":153.30083389332341,"delta":0.008,"fmin":-141.7999999999999,"fmax":171.7999999999999,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.006},"factorH":{"defaultValue":0.2,"f":56.26405889691268,"delta":0.003,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.006,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-1.028773317366873,"delta":0.003,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.006,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":3.8972660432756454,"delta":0.001,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.005},"factorT":{"defaultValue":19.915,"f":89.49527205794749,"delta":0.0001,"fmin":-51.800000000000026,"fmax":151.7999999999999,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0017000000000000006},"factorW":{"defaultValue":0.8,"f":0.8062060060875356,"delta":0.01,"fmin":-1.7990000000000006,"fmax":3.8000000000000016,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0.00006},"factorX":{"defaultValue":-3.191,"f":7.37386479405974,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-3.2574599850678845,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":4.715645612792289,"delta":0.01,"fmin":-4.9499999999999975,"fmax":8.099999999999994,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":260.2371643175641,"delta":0.01,"fmin":0,"fmax":360,"controlDelta":0.01,"controlKey":"v","isIncreasing":0,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":9.80015588417264,"delta":0.01,"fmin":0.19999999999999937,"fmax":9.799999999999994,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0008000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-74.53776694785853,"delta":0.02,"fmin":-161.7999999999999,"fmax":161.7999999999999,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.030000000000000002,"isDecreasing":0},"isLogLocked":1,"id":"11","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":39.54145459682062,"delta":0.01,"fmin":15.19999999999999,"fmax":161.7999999999999,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":-1.880714643716943,"delta":0.001,"fmin":-141.7999999999999,"fmax":141.7999999999999,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-46.91543277052121,"delta":0.007,"fmin":-141.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-100.34596970654665,"delta":0.002,"fmin":-141.7999999999999,"fmax":181.7999999999999,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":-13.018673850528103,"delta":0.002,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.006,"isDecreasing":0},"factorG":{"defaultValue":35,"f":171.8018338933241,"delta":0.008,"fmin":-141.7999999999999,"fmax":171.7999999999999,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.008,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":8.552058896910873,"delta":0.003,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.006,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-15.803773317367249,"delta":0.003,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.004},"factorJ":{"defaultValue":-1.1,"f":15.802266043276775,"delta":0.001,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"j","isIncreasing":0.006,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":100.08767205793026,"delta":0.0001,"fmin":-51.800000000000026,"fmax":151.7999999999999,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0012000000000000003},"factorW":{"defaultValue":0.8,"f":1.2833260060871299,"delta":0.01,"fmin":-1.7990000000000006,"fmax":3.8000000000000016,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0.00006},"factorX":{"defaultValue":-3.191,"f":-1.797135205940346,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-3.2574599850678845,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":5.294745612791957,"delta":0.01,"fmin":-4.9499999999999975,"fmax":8.099999999999994,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":260.2371643175641,"delta":0.01,"fmin":0,"fmax":360,"controlDelta":0.01,"controlKey":"v","isIncreasing":0,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":9.80015588417264,"delta":0.01,"fmin":0.19999999999999937,"fmax":9.799999999999994,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0008000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-161.82276694786182,"delta":0.02,"fmin":-161.7999999999999,"fmax":161.7999999999999,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025},"isLogLocked":1,"id":"12","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":39.54145459682062,"delta":0.01,"fmin":15.19999999999999,"fmax":161.7999999999999,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":-1.880714643716943,"delta":0.001,"fmin":-141.7999999999999,"fmax":141.7999999999999,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-46.91543277052121,"delta":0.007,"fmin":-141.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-15.49596970656645,"delta":0.002,"fmin":-141.7999999999999,"fmax":181.7999999999999,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":-114.83867385053196,"delta":0.002,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.006,"isDecreasing":0},"factorG":{"defaultValue":35,"f":36.62583389329691,"delta":0.008,"fmin":-141.7999999999999,"fmax":171.7999999999999,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.008,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-93.26794110309254,"delta":0.003,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.006,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":3.6682266826314582,"delta":0.003,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.004},"factorJ":{"defaultValue":-1.1,"f":1.9242660432764,"delta":0.001,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"j","isIncreasing":0.006,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":120.4516720578828,"delta":0.0001,"fmin":-51.800000000000026,"fmax":151.7999999999999,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0012000000000000003},"factorW":{"defaultValue":0.8,"f":1.72513600608645,"delta":0.01,"fmin":-1.7990000000000006,"fmax":3.8000000000000016,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0.00006},"factorX":{"defaultValue":-3.191,"f":-1.797135205940346,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-3.2574599850678845,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":3.14734561279141,"delta":0.01,"fmin":-4.9499999999999975,"fmax":8.099999999999994,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":235.79716431760306,"delta":0.01,"fmin":0,"fmax":360,"controlDelta":0.01,"controlKey":"v","isIncreasing":0,"isDecreasing":0.05},"fPositionDividend":{"defaultValue":4,"f":1.9473558841735028,"delta":0.01,"fmin":0.19999999999999937,"fmax":9.799999999999994,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0008000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":92.55223305216177,"delta":0.02,"fmin":-161.7999999999999,"fmax":161.7999999999999,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025},"isLogLocked":1,"id":"13","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":39.54145459682062,"delta":0.01,"fmin":15.19999999999999,"fmax":161.7999999999999,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":-1.880714643716943,"delta":0.001,"fmin":-141.7999999999999,"fmax":141.7999999999999,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-46.91543277052121,"delta":0.007,"fmin":-141.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":31.454030293432602,"delta":0.002,"fmin":-141.7999999999999,"fmax":181.7999999999999,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":-94.32067385050317,"delta":0.002,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.007},"factorG":{"defaultValue":35,"f":-38.494166106701535,"delta":0.008,"fmin":-141.7999999999999,"fmax":171.7999999999999,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.008,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-76.78894110309191,"delta":0.003,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.006},"factorI":{"defaultValue":-1,"f":6.022226682628982,"delta":0.003,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.005,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":-5.057733956722821,"delta":0.001,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.005},"factorT":{"defaultValue":19.915,"f":127.67537205791385,"delta":0.0001,"fmin":-51.800000000000026,"fmax":151.7999999999999,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0006000000000000001},"factorW":{"defaultValue":0.8,"f":2.079526006086149,"delta":0.01,"fmin":-1.7990000000000006,"fmax":3.8000000000000016,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-1.797135205940346,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-3.2574599850678845,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":3.14734561279141,"delta":0.01,"fmin":-4.9499999999999975,"fmax":8.099999999999994,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":62.68716431766008,"delta":0.01,"fmin":0,"fmax":360,"controlDelta":0.01,"controlKey":"v","isIncreasing":0.07,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":0.19975588417358595,"delta":0.01,"fmin":0.19999999999999937,"fmax":9.799999999999994,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0},"factorB":{"defaultValue":69,"f":58.16223305217432,"delta":0.02,"fmin":-161.7999999999999,"fmax":161.7999999999999,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.04,"isDecreasing":0},"isLogLocked":1,"id":"14","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":79.97545459682227,"delta":0.01,"fmin":15.19999999999999,"fmax":161.7999999999999,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":-96.22671464372155,"delta":0.001,"fmin":-141.7999999999999,"fmax":141.7999999999999,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-55.79943277047819,"delta":0.007,"fmin":-141.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":170.09903029335237,"delta":0.002,"fmin":-141.7999999999999,"fmax":181.7999999999999,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-41.40567385048948,"delta":0.002,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0},"factorG":{"defaultValue":35,"f":87.72483389330267,"delta":0.008,"fmin":-141.7999999999999,"fmax":171.7999999999999,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-4.139941103090109,"delta":0.003,"fmin":-141.7999999999999,"fmax":111.7999999999999,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-10.578773317371144,"delta":0.003,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":5.6382660432808365,"delta":0.001,"fmin":-15.799999999999994,"fmax":15.799999999999994,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":143.53967205769675,"delta":0.0001,"fmin":-51.800000000000026,"fmax":151.7999999999999,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":0.6404560060873721,"delta":0.01,"fmin":-1.7990000000000006,"fmax":3.8000000000000016,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":33.57686479406246,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":94.97154001492203,"delta":0.01,"fmin":-151.7999999999999,"fmax":151.7999999999999,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":-3.826554387209283,"delta":0.01,"fmin":-4.9499999999999975,"fmax":8.099999999999994,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":7.297164317712144,"delta":0.01,"fmin":0.0,"fmax":360.0,"controlDelta":0.01,"controlKey":"v","isIncreasing":0.1,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":8.221955884175948,"delta":0.01,"fmin":0.19999999999999937,"fmax":9.799999999999994,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-106.99276694782044,"delta":0.02,"fmin":-161.7999999999999,"fmax":161.7999999999999,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.015,"isDecreasing":0},"isLogLocked":1,"id":"15","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":154.13655195354832,"delta":0.01,"fmin":-2,"fmax":179,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.005},"factorC":{"defaultValue":33,"f":-57.4800825387639,"delta":0.001,"fmin":-159,"fmax":159,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":-26.778221352605854,"delta":0.007,"fmin":-159,"fmax":169,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":32.74853353498233,"delta":0.002,"fmin":-159,"fmax":199,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-85.15286611167056,"delta":0.002,"fmin":-159,"fmax":129,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.003},"factorG":{"defaultValue":35,"f":117.02392698795575,"delta":0.008,"fmin":-159,"fmax":189,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.005},"factorH":{"defaultValue":0.2,"f":-63.22061036978343,"delta":0.003,"fmin":-159,"fmax":129,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.008,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-33.00055704297781,"delta":0.003,"fmin":-33,"fmax":33,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.02000000000000001},"factorJ":{"defaultValue":-1.1,"f":12.851741071247645,"delta":0.001,"fmin":-33,"fmax":33,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":1.0696899756059306,"delta":0.0001,"fmin":-69,"fmax":169,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0004},"factorW":{"defaultValue":0.8,"f":1.2174667516607756,"delta":0.01,"fmin":-18.999000000000002,"fmax":21,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0.00005},"factorX":{"defaultValue":-3.191,"f":34.59847469048369,"delta":0.01,"fmin":-169,"fmax":169,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.012000000000000004,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":89.94011768792512,"delta":0.01,"fmin":-169,"fmax":169,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":-2.5950201991449044,"delta":0.01,"fmin":-22.15,"fmax":25.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001},"fGlitch":{"defaultValue":4,"f":0.41265631072543113,"delta":0.01,"fmin":-17,"fmax":27,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0.0007000000000000001},"fPositionDividend":{"defaultValue":4,"f":-0.8780610968291684,"delta":0.01,"fmin":-17,"fmax":27,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0007000000000000001},"factorB":{"defaultValue":69,"f":97.55234931676998,"delta":0.02,"fmin":-179,"fmax":179,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025},"isLogLocked":1,"id":"16","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":-35.34460156573666,"delta":0.01,"fmin":-81,"fmax":258,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":117.5251354498605,"delta":0.001,"fmin":-238,"fmax":238,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":52.79962583745163,"delta":0.007,"fmin":-238,"fmax":248,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006},"factorE":{"defaultValue":69.1,"f":13.653319339890583,"delta":0.002,"fmin":-238,"fmax":278,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":137.8454085818924,"delta":0.002,"fmin":-238,"fmax":208,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005},"factorG":{"defaultValue":35,"f":-225.37613784672595,"delta":0.008,"fmin":-238,"fmax":268,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":7.155603797416418,"delta":0.003,"fmin":-238,"fmax":208,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":48.89739090657142,"delta":0.003,"fmin":-112,"fmax":112,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.006},"factorJ":{"defaultValue":-1.1,"f":79.27809985402882,"delta":0.001,"fmin":-112,"fmax":112,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.006},"factorT":{"defaultValue":19.915,"f":212.91083537048297,"delta":0.0001,"fmin":-148,"fmax":248,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006},"factorW":{"defaultValue":0.8,"f":43.30393579768176,"delta":0.01,"fmin":-97.999,"fmax":100,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-219.43737864633624,"delta":0.01,"fmin":-248,"fmax":248,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":115.40052029404382,"delta":0.01,"fmin":-248,"fmax":248,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":-43.79282413909489,"delta":0.01,"fmin":-101.15,"fmax":104.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":-52.054660134519224,"delta":0.01,"fmin":-96,"fmax":106,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":38.73455690444354,"delta":0.01,"fmin":-96,"fmax":106,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005},"factorB":{"defaultValue":69,"f":-151.17392658183348,"delta":0.02,"fmin":-258,"fmax":258,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"17","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":132.95396859212727,"delta":0.01,"fmin":9,"fmax":168,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":104.81034208562218,"delta":0.001,"fmin":-148,"fmax":148,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":-50.39662433680141,"delta":0.007,"fmin":-148,"fmax":158,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006},"factorE":{"defaultValue":69.1,"f":11.533041576852595,"delta":0.002,"fmin":-148,"fmax":188,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-142.0470261799254,"delta":0.002,"fmin":-148,"fmax":118,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005},"factorG":{"defaultValue":35,"f":-112.84081641573974,"delta":0.008,"fmin":-148,"fmax":178,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-109.5830849861465,"delta":0.003,"fmin":-148,"fmax":118,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":6.6174890500071015,"delta":0.003,"fmin":-22,"fmax":22,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.006},"factorJ":{"defaultValue":-1.1,"f":5.30992828585488,"delta":0.001,"fmin":-22,"fmax":22,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.006},"factorT":{"defaultValue":19.915,"f":-21.203123076153044,"delta":0.0001,"fmin":-58,"fmax":158,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006},"factorW":{"defaultValue":0.8,"f":6.05194936146674,"delta":0.01,"fmin":-7.9990000000000006,"fmax":10,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-4.016835169484722,"delta":0.01,"fmin":-158,"fmax":158,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":20.120991424698133,"delta":0.01,"fmin":-158,"fmax":158,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":8.553227449952354,"delta":0.01,"fmin":-11.15,"fmax":14.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":-3.086405702070041,"delta":0.01,"fmin":-6,"fmax":16,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":15.287618219771618,"delta":0.01,"fmin":-6,"fmax":16,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005},"factorB":{"defaultValue":69,"f":150.87201294476742,"delta":0.02,"fmin":-168,"fmax":168,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"18","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":8.550112699301742,"delta":0.01,"fmin":-11,"fmax":188,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":-163.97733843465747,"delta":0.001,"fmin":-168,"fmax":168,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":169.96141195015542,"delta":0.007,"fmin":-168,"fmax":178,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006},"factorE":{"defaultValue":69.1,"f":-141.767191494953,"delta":0.002,"fmin":-168,"fmax":208,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":128.24097872713935,"delta":0.002,"fmin":-168,"fmax":138,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005},"factorG":{"defaultValue":35,"f":187.95579724233068,"delta":0.008,"fmin":-168,"fmax":198,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":29.593156450932263,"delta":0.003,"fmin":-168,"fmax":138,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-6.685831204252118,"delta":0.003,"fmin":-42,"fmax":42,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.006},"factorJ":{"defaultValue":-1.1,"f":27.36362712836464,"delta":0.001,"fmin":-42,"fmax":42,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.006},"factorT":{"defaultValue":19.915,"f":-0.8330372493296108,"delta":0.0001,"fmin":-78,"fmax":178,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006},"factorW":{"defaultValue":0.8,"f":0.5065293869790466,"delta":0.01,"fmin":-27.999000000000002,"fmax":30,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":49.994281737607935,"delta":0.01,"fmin":-178,"fmax":178,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":171.42304113026046,"delta":0.01,"fmin":-178,"fmax":178,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":6.912651813091379,"delta":0.01,"fmin":-31.15,"fmax":34.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":18.89795597464368,"delta":0.01,"fmin":-26,"fmax":36,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":26.79397919134299,"delta":0.01,"fmin":-26,"fmax":36,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005},"factorB":{"defaultValue":69,"f":-144.7800598684624,"delta":0.02,"fmin":-188,"fmax":188,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"19","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":25.342878483366306,"delta":0.01,"fmin":-12,"fmax":189,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":-47.444125559187306,"delta":0.001,"fmin":-169,"fmax":169,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":-26.511606868786316,"delta":0.007,"fmin":-169,"fmax":179,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006},"factorE":{"defaultValue":69.1,"f":59.948646327543166,"delta":0.002,"fmin":-169,"fmax":209,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":6.49613339563174,"delta":0.002,"fmin":-169,"fmax":139,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005},"factorG":{"defaultValue":35,"f":-71.88764458146181,"delta":0.008,"fmin":-169,"fmax":199,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-19.862528226864452,"delta":0.003,"fmin":-169,"fmax":139,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":3.135387142943316,"delta":0.003,"fmin":-43,"fmax":43,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.006},"factorJ":{"defaultValue":-1.1,"f":32.44118568115232,"delta":0.001,"fmin":-43,"fmax":43,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.006},"factorT":{"defaultValue":19.915,"f":18.538525456437416,"delta":0.0001,"fmin":-79,"fmax":179,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006},"factorW":{"defaultValue":0.8,"f":-5.167171412898583,"delta":0.01,"fmin":-28.999000000000002,"fmax":31,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-119.8529102052834,"delta":0.01,"fmin":-179,"fmax":179,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":20.318951162816006,"delta":0.01,"fmin":-179,"fmax":179,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":-23.305955020235572,"delta":0.01,"fmin":-32.15,"fmax":35.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":-11.706267570350166,"delta":0.01,"fmin":-27,"fmax":37,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":7.099158936948878,"delta":0.01,"fmin":-27,"fmax":37,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005},"factorB":{"defaultValue":69,"f":124.40999493264249,"delta":0.02,"fmin":-189,"fmax":189,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"20","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":103.58173768720437,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":5.145740140927927,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":133.49598840208017,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-50.85503624396594,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-9.84093888847994,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0},"factorG":{"defaultValue":35,"f":106.66207042964723,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":73.34317590715284,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-3.520136912402222,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":5.103889174256651,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":-14.87607518438945,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":0.9938540590029374,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-111.61531546391019,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":52.672201602061506,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":2.278266363693206,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":6.530247536500759,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":2.3609937431535912,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0},"factorB":{"defaultValue":69,"f":85.18578854648557,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.015,"isDecreasing":0},"isLogLocked":1,"id":"21","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":57.41053909729472,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":49.42003927397076,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":67.9858718593822,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-97.7799651050691,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-78.8372360221744,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0},"factorG":{"defaultValue":35,"f":-139.92043564522243,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":0.013226609282327217,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-0.5599175136708574,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":5.604513128507676,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":89.53204367787959,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":1.01845230795976,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":72.67967536009087,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-82.99802405329007,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":-1.2750522352244615,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":5.027292528352868,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":3.0518074297425413,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-41.11164318001123,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.015,"isDecreasing":0},"isLogLocked":1,"id":"22","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":24.20824304545227,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.009000000000000001},"factorC":{"defaultValue":33,"f":86.80224626066624,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0.005,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":-71.50101586342993,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.006,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-78.68985979968028,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":-33.4461569272505,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorG":{"defaultValue":35,"f":66.94092389799118,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.005},"factorH":{"defaultValue":0.2,"f":43.4583734751519,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.005},"factorI":{"defaultValue":-1,"f":12.185696200180825,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.008,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":0.08332922948245436,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.005},"factorT":{"defaultValue":19.915,"f":95.30241361819779,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":0.5351542832300807,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-16.532265394111043,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0.005},"factorY":{"defaultValue":-8.109,"f":-7.599328630632451,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0.005},"factorR":{"defaultValue":1.081,"f":-0.2592610124851797,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001},"fGlitch":{"defaultValue":4,"f":4.079371020142161,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0006000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":5.293136739502149,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0006000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":24.70060673527705,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025},"isLogLocked":1,"id":"23","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":122.27585785855528,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":13.716894888922981,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":136.0295365659454,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006},"factorE":{"defaultValue":69.1,"f":13.522350213642936,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-66.57432954148541,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005},"factorG":{"defaultValue":35,"f":-27.825568201177433,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-75.34334608145001,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":2.8544816458141287,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.006},"factorJ":{"defaultValue":-1.1,"f":1.0410997847326882,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.006},"factorT":{"defaultValue":19.915,"f":124.61637825594747,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006},"factorW":{"defaultValue":0.8,"f":0.9022449600883293,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-44.214325463589205,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-96.01512210398835,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":-0.5873197787205888,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":6.448461337600259,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":6.887769745266414,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005},"factorB":{"defaultValue":69,"f":-68.34122270839947,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"24","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":16.994999999999706,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":26.80433689656427,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":29.14660146675159,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006},"factorE":{"defaultValue":69.1,"f":-62.70163706130407,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":25.34649484300454,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005},"factorG":{"defaultValue":35,"f":149.435073864981,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":100.8221804031557,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-14.004751758467574,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.006},"factorJ":{"defaultValue":-1.1,"f":-14.005149209763458,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.006},"factorT":{"defaultValue":19.915,"f":-3.0287000000003337,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006},"factorW":{"defaultValue":0.8,"f":1.1103065993368362,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":53.74469643199411,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":1.1011465471463349,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":0.012800000000328986,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":7.377210690915519,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":1.9999908715661368,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005},"factorB":{"defaultValue":69,"f":160.01677684599187,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"25","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":19.880999999999815,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":71.16333689656085,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":67.16860146675303,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0.006},"factorE":{"defaultValue":69.1,"f":-107.06063706133445,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0.007,"isDecreasing":0},"factorF":{"defaultValue":43,"f":57.03149484301602,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0.005},"factorG":{"defaultValue":35,"f":92.40207386501268,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":12.104180403161063,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.014000000000000005,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":0.9232482415327357,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.006},"factorJ":{"defaultValue":-1.1,"f":1.3008507902368522,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.006},"factorT":{"defaultValue":19.915,"f":8.37789999999979,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0018000000000000006},"factorW":{"defaultValue":0.8,"f":1.2954565993372271,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0.00005},"factorX":{"defaultValue":-3.191,"f":15.722696431992668,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.006,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-36.92085345285484,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0.006,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":-3.150499999999817,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001},"fGlitch":{"defaultValue":4,"f":2.9413106909146007,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":3.0624908715664914,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0005},"factorB":{"defaultValue":69,"f":92.29177684597649,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"26","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":90.24555195357802,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.009000000000000001},"factorC":{"defaultValue":33,"f":-110.62308253884297,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0.005,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":7.388778647394996,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.006,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":5.033533534983951,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.005},"factorF":{"defaultValue":43,"f":-29.607866111668457,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorG":{"defaultValue":35,"f":102.19392698796923,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.005},"factorH":{"defaultValue":0.2,"f":77.44138963028135,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.005},"factorI":{"defaultValue":-1,"f":14.003442957021477,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0.008,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":-14.003258928753754,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0.005},"factorT":{"defaultValue":19.915,"f":2.097489975605818,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":1.4288667516612215,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":114.5424746905203,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0.005},"factorY":{"defaultValue":-8.109,"f":55.63511768794442,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0.005},"factorR":{"defaultValue":1.081,"f":-3.1500201991448433,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001},"fGlitch":{"defaultValue":4,"f":6.051656310726416,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0006000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":6.051738903171825,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0006000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-27.817650683232216,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.025},"isLogLocked":1,"id":"27","useNoise":"0"}',
    '{"factorA":{"defaultValue":54.984,"f":156.1265519535256,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0.007,"isDecreasing":0},"factorC":{"defaultValue":33,"f":-19.55408253876898,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0.007},"factorD":{"defaultValue":98.1,"f":-26.778221352605854,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":32.74853353498233,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-78.1988661116703,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0},"factorG":{"defaultValue":35,"f":128.22892698794556,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-101.25161036979405,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.007,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":8.649442957022885,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0.015000000000000006},"factorJ":{"defaultValue":-1.1,"f":12.851741071247645,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":2.097489975605818,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":1.4288667516612215,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-30.417525309517885,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.012000000000000004,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":89.94011768792512,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":0.6557798008549569,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0006000000000000001},"fGlitch":{"defaultValue":4,"f":4.205256310725799,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0.0007000000000000001},"fPositionDividend":{"defaultValue":4,"f":2.914538903170941,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0.0007000000000000001},"factorB":{"defaultValue":69,"f":25.352349316790836,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.06499999999999999,"isDecreasing":0},"isLogLocked":1,"id":"28","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":48.40499999999975,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0.006},"factorC":{"defaultValue":33,"f":33,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":93.9180000000016,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0.007,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":65.14400000000217,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0.008},"factorF":{"defaultValue":43,"f":50.28000000000372,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.005,"isDecreasing":0},"factorG":{"defaultValue":35,"f":25.647999999999577,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0.007},"factorH":{"defaultValue":0.2,"f":7.937000000000078,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0.006,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-1,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":-1.1,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":18.735600000002748,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0.0007000000000000001},"factorW":{"defaultValue":0.8,"f":0.8,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-3.191,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-8.109,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":0.7500000000000364,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0.0005},"fGlitch":{"defaultValue":4,"f":4,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":4,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0},"factorB":{"defaultValue":69,"f":109.9750000000093,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.025,"isDecreasing":0},"isLogLocked":1,"id":"29","useNoise":"1"}',
    '{"factorA":{"defaultValue":54.984,"f":54.984,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":91.63133689657548,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":106.12960146675451,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-127.59863706134911,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":17.502494843015597,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0},"factorG":{"defaultValue":35,"f":-1.629926134990626,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-121.22781959683448,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":-8.433751758468324,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":-4.7351492097631045,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":19.915,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":1.5886565993378456,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-29.124303568008585,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-46.82385345285522,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":1.081,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":3.7988106909147783,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":6.575990871565378,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-87.4282231540347,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0.015,"isDecreasing":0},"isLogLocked":1,"id":"30","useNoise":"0"}',
              '{"factorA":{"defaultValue":54.984,"f":64.42800000000277,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0.008,"isDecreasing":0},"factorC":{"defaultValue":33,"f":33,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":98.1,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":69.1,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":57.52600000000055,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0.009000000000000001,"isDecreasing":0},"factorG":{"defaultValue":35,"f":48.08499999999741,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0.010000000000000002,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-4.993999999999973,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0.007},"factorI":{"defaultValue":-1,"f":-1,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":-1.1,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":19.915,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":0.8,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-3.191,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-8.109,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":1.081,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":5.065400000000221,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0.0007000000000000001,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":5.065400000000221,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0.0007000000000000001,"isDecreasing":0},"factorB":{"defaultValue":69,"f":6.719999999998008,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0.045},"isLogLocked":1,"id":"31","useNoise":"0"}',
              '{"factorA":{"defaultValue":54.984,"f":134.6230838845741,"delta":0.01,"fmin":17,"fmax":160,"controlDelta":0.001,"controlKey":"a","isIncreasing":0,"isDecreasing":0},"factorC":{"defaultValue":33,"f":-133.5579063359812,"delta":0.001,"fmin":-140,"fmax":140,"controlDelta":0.001,"controlKey":"c","isIncreasing":0,"isDecreasing":0},"factorD":{"defaultValue":98.1,"f":111.4558201858525,"delta":0.007,"fmin":-140,"fmax":150,"controlDelta":0.001,"controlKey":"d","isIncreasing":0,"isDecreasing":0},"factorE":{"defaultValue":69.1,"f":-124.42362549775592,"delta":0.002,"fmin":-140,"fmax":180,"controlDelta":0.001,"controlKey":"e","isIncreasing":0,"isDecreasing":0},"factorF":{"defaultValue":43,"f":-91.3384861335015,"delta":0.002,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"f","isIncreasing":0,"isDecreasing":0},"factorG":{"defaultValue":35,"f":158.17282631774566,"delta":0.008,"fmin":-140,"fmax":170,"controlDelta":0.001,"controlKey":"g","isIncreasing":0,"isDecreasing":0},"factorH":{"defaultValue":0.2,"f":-82.56255946941215,"delta":0.003,"fmin":-140,"fmax":110,"controlDelta":0.001,"controlKey":"h","isIncreasing":0,"isDecreasing":0},"factorI":{"defaultValue":-1,"f":10.8615535669718,"delta":0.003,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"i","isIncreasing":0,"isDecreasing":0},"factorJ":{"defaultValue":-1.1,"f":-9.021013512646718,"delta":0.001,"fmin":-14,"fmax":14,"controlDelta":0.001,"controlKey":"j","isIncreasing":0,"isDecreasing":0},"factorT":{"defaultValue":19.915,"f":25.58858449996231,"delta":0.0001,"fmin":-50,"fmax":150,"controlDelta":0.0001,"controlKey":"t","isIncreasing":0,"isDecreasing":0},"factorW":{"defaultValue":0.8,"f":1.1067135512824635,"delta":0.01,"fmin":0.001,"fmax":2,"controlDelta":0.00001,"controlKey":"w","isIncreasing":0,"isDecreasing":0},"factorX":{"defaultValue":-3.191,"f":-102.99846634243238,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"x","isIncreasing":0.0025,"isDecreasing":0},"factorY":{"defaultValue":-8.109,"f":-147.72693318555753,"delta":0.01,"fmin":-150,"fmax":150,"controlDelta":0.001,"controlKey":"y","isIncreasing":0,"isDecreasing":0},"factorR":{"defaultValue":1.081,"f":4.707064548716241,"delta":0.01,"fmin":-3.15,"fmax":6.3,"controlDelta":0.0001,"controlKey":"r","isIncreasing":0,"isDecreasing":0},"fGlitch":{"defaultValue":4,"f":7.352076079839248,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"v","isIncreasing":0,"isDecreasing":0},"fPositionDividend":{"defaultValue":4,"f":4.147104829965986,"delta":0.01,"fmin":2,"fmax":8,"controlDelta":0.0001,"controlKey":"z","isIncreasing":0,"isDecreasing":0},"factorB":{"defaultValue":69,"f":-22.93218981725292,"delta":0.02,"fmin":-160,"fmax":160,"controlDelta":0.005,"controlKey":"b","isIncreasing":0,"isDecreasing":0},"isLogLocked":1,"id":"32","useNoise":"1"}'
  ];
  
  if (id === undefined){
    return favs.sample();
  } else {
    return favs[id];
  }
}

function isKeyDown(value) {
  return keyIsDown(getKeyCode(value));
}

function getKeyCode(value) {
  return { 
    ArrowRight:39, 
    ArrowDown:40, 
    ArrowUp:38, 
    ArrowLeft:37, 
    Alt:18, 
    Meta:93, 
    Control:17, 
    Space:32, 
    Shift:16,
    Backspace:8,
    Enter:13, 
    CapsLock:20, 
    Tab:9, 
    Escape:27, 
    F1:112, 
    F2:113, 
    F3:114, 
    F4:115, 
    F5:116, 
    F6:117, 
    F7:118, 
    F8:119, 
    F9:120, 
    F10:121, 
    F12:123,  
    0:48,
    1:49,
    2:50,
    3:51,
    4:52,
    5:53,
    6:54,
    7:55,
    8:56,
    9:57,
    a:65,
    b:66,
    c:67,
    d:68,
    e:69,
    f:70,
    g:71,
    h:72,
    i:73,
    j:74,
    k:75,
    l:76,
    m:77,
    n:78,
    o:79,
    p:80,
    q:81,
    r:82,
    s:83,
    t:84,
    u:85,
    v:86,
    w:87,
    x:88,
    y:89,
    z:90,
    '=':187, 
    '-':189, 
    '`':192, 
    '\\':220, 
    ']':221, 
    '[':219, 
    '\'':222, 
    ';':186, 
    '/':191, 
    '.':190, 
    ',':188
  }[value];
}

/*

  //x -0.113 y: -2.371 a15: 65.429 b80: 160 c10: 8 d25: 0 e40: 0 f5: 110 g35: 124 h3.5: 110 i0.05: 24 j0.5: 0 t: -13.915 w: 2.427 r: 1.081 
  // 
// x: 37.561 y: 12.692 a15: 117.237 b80: 160 c10: 3 d25: 0 e40: 73 f5: 0 g35: 83 h3.5: 0 i0.05: -100 j0.5: 16 t: -4.51 w: 2.132 r: 5.21 
  
//  x: 13.316 y: 12.692 a15: 117.237 b80: 160 c10: 3 d25: 0 e40: 73 f5: 0 g35: 139 h3.5: 0 i0.05: -28 j0.5: 96 t: -0.565 w: 2.132 r: 5.21
  
  //  x: -3.191 y: -8.109 a15: 54.984 b80: 69 c10: 33 d25: 98 e40: 69 f5: 43 g35: 35 h3.5: 0 i0.05: -3 j0.5: -1 t: 19.947 w: 0.756 r: 3.123 z: 0.3
  
  //x: 22.427 y: 6.651 a15: 16.99 b80: -67 c10: -78 d25: 106 e40: 180 f5: -119 g35: 54 h3.5: 56 i0.05: -41 j0.5: 0 t: 19.915 w: 0.207 r: 4.714 z: 84
  
  
  // this is a collection of classes whose values change over time
  // these values get fed to the shader
  efs = new ShaderEFactors();
  

  factorB = new DeltaFactor(1.0, 160.0, 0.02, 0.05);
  factorC = new DeltaFactor(10.0, 20.0, 0.001, 0.05);
  factorD = new DeltaFactor(25.0, 50.0, 0.007, 0.05);
  factorE = new DeltaFactor(40.0, 80.0, 0.002, 0.05);
  factorF = new DeltaFactor(5.0, 10.0, 0.002, 0.05);
  factorG = new DeltaFactor(35.0, 70.0, 0.008, 0.05);
  factorH = new DeltaFactor(3.0, 10.0, 0.003, 0.05);
  factorI = new DeltaFactor(0.05, 2.0, 0.003, 0.05);
  factorJ = new DeltaFactor(0.5, 2.0, 0.001, 0.05);
  factorT = new DeltaFactor(-50.0, 50.0, 0.01, 0.001, 't', 3.5);
  factorX = new DeltaFactor(-50.0, 50.0, 0.01, 0.001, 'x', 0.3);
  factorY = new DeltaFactor(-50.0, 50.0, 0.01, 0.001, 'y', 0.2);
  factorA = new DeltaFactor(17.0, 60.0, 0.01, 0.001, 'a', 20.0);
  
  // this is a resolution control
  factorW = new DeltaFactor(0.001, 2.0, 0.01, 0.00001, 'w', 0.8);
  
  // rotation
  factorR = new DeltaFactor(-3.15, 6.3, 0.01, 0.0001, 'r', 1.081);
  
  // replacing the hard-coded value of 4.0
  fPositionDividend = new DeltaFactor(2.0, 8.0, 0.01, 0.0001, 'z', 4.0);
  
  // harsher settings
  factorA = new DeltaFactor(15.0, 160.0, 0.01);
  factorB = new DeltaFactor(80.0, 160.0, 0.02);
  factorC = new DeltaFactor(10.0, 120.0, 0.001);
  factorD = new DeltaFactor(25.0, 150.0, 0.007);
  factorE = new DeltaFactor(40.0, 180.0, 0.002);
  factorF = new DeltaFactor(5.0, 110.0, 0.02);
  factorG = new DeltaFactor(35.0, 170.0, 0.08);
  factorH = new DeltaFactor(3.0, 110.0, 0.03);
  factorI = new DeltaFactor(0.05, 12.0, 0.03);
  factorJ = new DeltaFactor(0.5, 12.0, 0.01);
  factorT = new DeltaFactor(25.0, 26.0, 0.01);

*/

/*

// represents a value that can change over time between a min and max amount
class DeltaFactor {
  constructor(fmin, fmax, fd, cd, controlKey, defaultValue) {
    if (defaultValue) {
      this.defaultValue = defaultValue;
      this.f = defaultValue;
    } else {
      this.defaultValue = fmin;
      this.f = random(fmin, fmax);
    }
    this.delta = fd;
    this.fmin = fmin;
    this.fmax = fmax;
    this.controlDelta = cd;
    this.controlKey = controlKey;
    this.isIncreasing = 0.0;
    this.isDecreasing = 0.0;
  }
  
  update() {
    // reverse if we get too close to min / max
    if (this.f > this.fmax || this.f < this.fmin) {
      this.delta *= -1;
    }
    // change according to the delta value
    this.f += this.delta;
  }
  
  updateRandom() {
    this.f = random(this.fmin, this.fmax);
  }
  
  // key codes https://www.toptal.com/developers/keycode
  // https://stackoverflow.com/q/72881145/4463445
  handleControl() {
    // is my key being pressed?
    if (isKeyDown(this.controlKey)) {
      if (keyIsDown(LEFT_ARROW)) {
        this.decrease();
      } else if (keyIsDown(RIGHT_ARROW)) {
        this.increase();
      } else if (isKeyDown('0')) {
        this.stopChanging();
      }
    }
    
    if (this.f < this.fmax)
      this.f += this.isIncreasing;
    
    if (this.f > this.fmin)
      this.f -= this.isDecreasing;
    
    if (isKeyDown('q') || isKeyDown('Escape')){
      this.resetControls();
    }
    

  }
  
  resetControls() {
    this.f = this.defaultValue;
    this.isIncreasing = 0.0;
    this.isDecreasing = 0.0;
  }
  
  stopChanging() {
    this.isIncreasing = 0.0;
    this.isDecreasing = 0.0;
  }
  
  increase() {
    this.isDecreasing = 0.0;
    this.isIncreasing += this.controlDelta;
  }
  
  decrease(){
    this.isIncreasing = 0.0;
    this.isDecreasing += this.controlDelta;
  }
}
*/