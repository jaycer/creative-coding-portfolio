// A2V — the five ways it draws what it hears.
//
// Each scene is a class with the same small surface, and knows nothing about
// microphones, clocks or controls:
//
//   enter(g, f)      it was just switched to; start clean
//   draw(g, f, a)    one frame onto `g`, the work canvas, f.W by f.H device px
//   beat(a, f)       the clock just struck a beat
//   bar(a, f)        ...and that beat began a bar (called right after beat)
//   hit(a, f)        the room just produced an onset louder than its recent run
//
// `f` is the frame: { W, H, dpr, pal, res, t }. `a` is the audio, one object
// reused every frame and documented where it is built, in a2v.js. The short
// version: level, bass, mid, treb and hit are 0 to 1 and already normalized to
// the room, so a quiet room and a loud one both use the whole range; phase is
// 0 to 1 across the current beat; pulse is 1 on the beat and decays; beatN and
// barN count up; struck is true on the one frame an onset landed.
//
// Nothing here jumps. A beat is allowed to push a quantity, but the push goes
// through a Surge, which spreads it over the next fraction of a second, so the
// picture speeds up and settles rather than stepping; the smoothed bands do
// the rest. A scene changes its mind (new orb, new pattern) by fading.
//
// Several of these borrow from other pieces in the gallery, and say so.

export const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const frac = (v) => v - Math.floor(v);
const lerp = (a, b, t) => a + (b - a) * t;

// --- noise ---------------------------------------------------------------------
// Ken Perlin's improved noise, in three dimensions, the third of which every
// scene here uses as time. Seeded once, so the same field comes up each visit.

const PERM = new Uint8Array(512);
(function seed() {
  const p = Array.from({ length: 256 }, (_, i) => i);
  let s = 20261017;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h, x, y, z) {
  const g = h & 15;
  const u = g < 8 ? x : y;
  const v = g < 4 ? y : (g === 12 || g === 14 ? x : z);
  return ((g & 1) ? -u : u) + ((g & 2) ? -v : v);
}
/** Roughly -1 to 1. */
export function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  return lerp(
    lerp(lerp(grad(PERM[AA], x, y, z), grad(PERM[BA], x - 1, y, z), u),
      lerp(grad(PERM[AB], x, y - 1, z), grad(PERM[BB], x - 1, y - 1, z), u), v),
    lerp(lerp(grad(PERM[AA + 1], x, y, z - 1), grad(PERM[BA + 1], x - 1, y, z - 1), u),
      lerp(grad(PERM[AB + 1], x, y - 1, z - 1), grad(PERM[BB + 1], x - 1, y - 1, z - 1), u), v),
    w,
  );
}

/** A quantity the beat is allowed to push without it ever stepping: the push
 *  becomes a velocity that drains over `tau` seconds, and integrates to
 *  exactly the amount asked for. */
class Surge {
  constructor(tau = 0.3) { this.v = 0; this.tau = tau; }
  push(amount) { this.v += amount / this.tau; }
  /** How far it moved this frame. */
  step(dt) {
    const k = Math.exp(-dt / this.tau);
    const d = this.v * this.tau * (1 - k);
    this.v *= k;
    return d;
  }
}

// --- palettes ------------------------------------------------------------------
// Five stops, dark to light. A palette is read as a RING: position 0 to 0.5
// runs dark to light and 0.5 to 1 runs back, so anything that cycles a palette
// (Pixels, Layers) wraps without a seam, the way the Earthbound ramps do.

export const PALETTES = [
  { name: 'Neon', stops: ['#0b0620', '#2d1b8a', '#e8619f', '#ffd166', '#5ad2e6'] },
  { name: 'Ember', stops: ['#120604', '#6b1d0e', '#e8532a', '#ffb347', '#fff1c1'] },
  { name: 'Ice', stops: ['#03101c', '#0d3b66', '#3a86c8', '#9bd6f0', '#f1fbff'] },
  { name: 'Acid', stops: ['#06120a', '#145c2b', '#7fd41e', '#e4ff5a', '#2bd4c2'] },
  { name: 'Bubblegum', stops: ['#1a0a2a', '#7a2d8a', '#ff5db1', '#ffb8e0', '#8ef2ff'] },
  { name: 'Mono', stops: ['#000000', '#3a3a3a', '#8c8c8c', '#d9d9d9', '#ffffff'] },
  // Drift has no fixed stops: it is rebuilt from a hue that keeps turning.
  { name: 'Drift', stops: null, mode: 'drift' },
  // Chromatic is rebuilt from the notes being heard: each pitch class is a
  // hue, C red and a semitone every thirty degrees around the wheel, and the
  // three loudest make the palette. A single note brings its own harmonics,
  // so one note reads as root, fifth and third: a triad of color.
  { name: 'Chromatic', stops: null, mode: 'chroma', note: 'Each note is a hue, C red and on around the wheel by semitone. The three loudest notes heard make the palette.' },
];

const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function hsl2rgb(h, s, l) {
  h = frac(h / 360);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = frac(t);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

export class Palette {
  constructor() {
    this.lut = new Uint8ClampedArray(256 * 3);
    this.hue = Math.random() * 360;
    this.use(PALETTES[0]);
  }
  use(def) {
    this.def = def;
    if (def.stops) this.build(def.stops.map(hex2rgb));
    else if (def.mode === 'chroma') this.tune(this.hues || [0, 210, 120]);
    else this.drift(0);
  }
  /** Chromatic: build from three hues, the loudest note's first. Dark and
   *  light ends are tinted with the first and last, so the ring reads as the
   *  chord rather than as black and white with color between. */
  tune(hues) {
    this.hues = hues;
    const [h1, h2, h3] = hues;
    this.build([hsl2rgb(h1, 0.75, 0.08), hsl2rgb(h1, 0.8, 0.36), hsl2rgb(h2, 0.9, 0.55), hsl2rgb(h3, 0.8, 0.72), hsl2rgb(h3, 0.6, 0.92)]);
  }
  /** Drift: turn the hue on and rebuild. Called every frame while it is live. */
  drift(deg) {
    this.hue = frac((this.hue + deg) / 360) * 360;
    const h = this.hue;
    this.build([hsl2rgb(h, 0.7, 0.07), hsl2rgb(h + 40, 0.8, 0.34), hsl2rgb(h + 95, 0.85, 0.55), hsl2rgb(h + 150, 0.8, 0.72), hsl2rgb(h + 200, 0.7, 0.93)]);
  }
  build(cols) {
    const lut = this.lut;
    for (let i = 0; i < 256; i++) {
      const u = i / 256;
      const s = u < 0.5 ? u * 2 : 2 - u * 2;
      const x = s * (cols.length - 1);
      const k = Math.min(cols.length - 2, Math.floor(x));
      const t = x - k;
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = cols[k][c] + (cols[k + 1][c] - cols[k][c]) * t;
    }
  }
  idx(t) { return (Math.floor(frac(t) * 256)) & 255; }
  rgb(t) {
    const i = this.idx(t) * 3;
    return [this.lut[i], this.lut[i + 1], this.lut[i + 2]];
  }
  css(t, alpha = 1) {
    const i = this.idx(t) * 3;
    return `rgba(${this.lut[i]},${this.lut[i + 1]},${this.lut[i + 2]},${alpha})`;
  }
}

// --- Pixels --------------------------------------------------------------------
// A Perlin field on a coarse grid, drawn at the resolution asked for and
// scaled up with no smoothing, so every cell is a square. Bass brightens the
// whole field, each beat urges the field on through time so it keeps morphing,
// treble sprinkles white cells, and the palette cycles underneath the lot.

class Pixels {
  constructor() {
    this.cv = document.createElement('canvas');
    this.cx = this.cv.getContext('2d');
    this.img = null;
    this.z = Math.random() * 50;
    this.off = Math.random();
    this.zs = new Surge(0.35);
    this.offs = new Surge(0.5);
  }
  size(f) {
    const n = clamp(Math.round(f.res), 4, 240);
    const m = Math.max(3, Math.round(n * f.H / f.W));
    if (this.cv.width !== n || this.cv.height !== m) {
      this.cv.width = n;
      this.cv.height = m;
      this.img = this.cx.createImageData(n, m);
    }
  }
  enter() { /* stateless apart from time, which should carry on */ }
  beat() { this.zs.push(0.18); this.offs.push(1 / 12); }
  bar() { this.offs.push(1 / 10); }
  hit() { /* the sparkle below reads a.hit directly */ }
  draw(g, f, a) {
    this.size(f);
    const n = this.cv.width, m = this.cv.height, d = this.img.data, lut = f.pal.lut;
    this.z += a.dt * (0.04 + 0.3 * a.level) + this.zs.step(a.dt);
    this.off += a.dt * 0.025 * (1 + 3 * a.treb) + this.offs.step(a.dt);
    const zoom = 2.6;
    const bright = 0.5 + 0.35 * a.bass + 0.2 * a.hit;
    const z2 = this.z * 1.6 + 3.3;
    let p = 0;
    for (let y = 0; y < m; y++) {
      const fy = (y / n) * zoom;
      for (let x = 0; x < n; x++, p += 4) {
        const fx = (x / n) * zoom;
        let v = noise3(fx, fy, this.z) * 0.5 + 0.5;
        v += 0.5 * (noise3(fx * 2.3 + 7.1, fy * 2.3, z2) * 0.5 + 0.5);
        const i = f.pal.idx(v * 0.63 + this.off) * 3;
        d[p] = lut[i] * bright;
        d[p + 1] = lut[i + 1] * bright;
        d[p + 2] = lut[i + 2] * bright;
        d[p + 3] = 255;
      }
    }
    // Treble is sparkle: a scatter of white cells, more of them the brighter
    // the top end, and more again while a hit rings.
    const cells = n * m;
    const k = Math.floor((a.treb * a.treb * 0.7 + a.hit * a.hit * 0.5) * cells * a.dt);
    for (let i = 0; i < k; i++) {
      const q = (Math.random() * cells | 0) * 4;
      d[q] = d[q + 1] = d[q + 2] = 255;
    }
    this.cx.putImageData(this.img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.cv, 0, 0, f.W, f.H);
    g.imageSmoothingEnabled = true;
  }
}

// --- Flow ----------------------------------------------------------------------
// Particles riding a Perlin flow field, leaving trails. Bass is their speed,
// mids their weight, and every beat urges the field on through time so the
// current keeps changing course.

class Flow {
  constructor() {
    this.N = 1200;
    this.p = null;
    this.zt = Math.random() * 100;
    this.off = Math.random();
    this.zs = new Surge(0.4);
    this.W = 0;
    this.H = 0;
  }
  enter(g, f) {
    this.W = f.W;
    this.H = f.H;
    const p = this.p = new Float32Array(this.N * 3);
    for (let i = 0; i < this.N; i++) {
      p[i * 3] = Math.random() * f.W;
      p[i * 3 + 1] = Math.random() * f.H;
      p[i * 3 + 2] = Math.random();
    }
    g.fillStyle = '#000';
    g.fillRect(0, 0, f.W, f.H);
  }
  beat() { this.zs.push(0.22); }
  bar() { /* nothing is dealt afresh here: see the trickle in draw */ }
  hit() { /* the speed below reads a.hit */ }
  draw(g, f, a) {
    if (!this.p || this.W !== f.W || this.H !== f.H) this.enter(g, f);
    g.globalCompositeOperation = 'source-over';
    // Trails fade on the clock, not per frame, so a fast screen and a slow one
    // leave the same tail.
    g.fillStyle = `rgba(0,0,0,${(1 - Math.exp(-a.dt / 0.19)).toFixed(3)})`;
    g.fillRect(0, 0, f.W, f.H);
    this.zt += a.dt * 0.07 + this.zs.step(a.dt);
    this.off += a.dt * 0.015 * (1 + 2 * a.treb);
    const s = Math.min(f.W, f.H);
    const sc = 1.8 / s;
    const spd = s * a.dt * (0.05 + 0.32 * a.bass + 0.45 * a.hit);
    // A trickle of them start again somewhere new, so the field never settles
    // into the few channels everything eventually drains into. A trickle, not
    // a share of them every bar: that put a fresh scatter of dots on screen.
    const fresh = a.dt * 0.08;
    // One path per color rather than one stroke per particle: twelve strokes a
    // frame instead of twelve hundred.
    const B = 12;
    const paths = [];
    for (let b = 0; b < B; b++) paths.push(new Path2D());
    const p = this.p;
    for (let i = 0; i < this.N; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      const ang = noise3(x * sc, y * sc, this.zt) * TAU * 1.6;
      const nx = x + Math.cos(ang) * spd, ny = y + Math.sin(ang) * spd;
      if (nx < 0 || nx >= f.W || ny < 0 || ny >= f.H || Math.random() < fresh) {
        p[i * 3] = Math.random() * f.W;
        p[i * 3 + 1] = Math.random() * f.H;
        continue;
      }
      const t = p[i * 3 + 2] * 0.2 + (ang / TAU) * 0.3 + this.off;
      const b = Math.floor(frac(t) * B);
      paths[b].moveTo(x, y);
      paths[b].lineTo(nx, ny);
      p[i * 3] = nx;
      p[i * 3 + 1] = ny;
    }
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineWidth = f.dpr * (0.7 + 2.2 * a.mid);
    for (let b = 0; b < B; b++) {
      // The lit half of the ring only: the dark half is the background's.
      g.strokeStyle = f.pal.css(0.14 + 0.36 * (b + 0.5) / B, 0.85);
      g.stroke(paths[b]);
    }
    g.globalCompositeOperation = 'source-over';
  }
}

// --- Orbs ----------------------------------------------------------------------
// Borrowed from Particle System: soft orbs drifting and breathing. Here each
// one breathes in a whole number of beats, one, two or four, so they swell
// together on the downbeats, and a hit sends a ring out of one of them. Orbs
// come and go by fading, over a couple of seconds each way.

class Orbs {
  constructor() {
    this.orbs = [];
    this.rings = [];
    this.bgT = Math.random();
    this.W = 0;
    this.H = 0;
  }
  make(f) {
    const s = Math.min(f.W, f.H);
    return {
      x: Math.random() * f.W, y: Math.random() * f.H,
      vx: (Math.random() - 0.5) * s * 0.05, vy: (Math.random() - 0.5) * s * 0.05,
      beats: [1, 1, 2, 2, 4][Math.floor(Math.random() * 5)],
      off: Math.floor(Math.random() * 4),
      min: s * 0.012, max: s * (0.06 + Math.random() * 0.2),
      t: Math.random(), dt: (Math.random() - 0.5) * 0.06,
      al: 0.35 + Math.random() * 0.3,
      life: 0, going: false,
    };
  }
  enter(g, f) {
    this.W = f.W;
    this.H = f.H;
    this.orbs = [];
    for (let i = 0; i < 22; i++) { const o = this.make(f); o.life = 1; this.orbs.push(o); }
    this.rings = [];
  }
  beat() { /* the breathing reads the phase directly */ }
  bar(a, f) {
    // Retire the oldest, bring in a new one, so the field keeps changing. Both
    // by fading: the one going out is dropped once it has gone.
    const old = this.orbs.find((o) => !o.going);
    if (old) old.going = true;
    this.orbs.push(this.make(f));
  }
  hit(a, f) {
    const up = this.orbs.filter((o) => o.life > 0.5);
    const o = up[Math.floor(Math.random() * up.length)];
    if (!o) return;
    this.rings.push({ x: o.x, y: o.y, r: o.max * 0.5, age: 0, t: o.t });
    if (this.rings.length > 12) this.rings.shift();
  }
  draw(g, f, a) {
    if (!this.orbs.length || this.W !== f.W || this.H !== f.H) this.enter(g, f);
    this.bgT += a.dt * 0.01;
    const [br, bgc, bb] = f.pal.rgb(this.bgT);
    const dim = 0.2 + 0.1 * a.bass;
    g.fillStyle = `rgb(${br * dim | 0},${bgc * dim | 0},${bb * dim | 0})`;
    g.fillRect(0, 0, f.W, f.H);
    const pos = a.beatN + a.phase;
    const swell = 1 + 0.35 * a.bass;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.life += (o.going ? -1 : 1) * a.dt / 2;
      if (o.life <= 0) { this.orbs.splice(i, 1); continue; }
      o.life = Math.min(1, o.life);
      o.x += o.vx * a.dt;
      o.y += o.vy * a.dt;
      if (o.x < 0 || o.x > f.W) { o.vx *= -1; o.x = clamp(o.x, 0, f.W); }
      if (o.y < 0 || o.y > f.H) { o.vy *= -1; o.y = clamp(o.y, 0, f.H); }
      o.t += o.dt * a.dt;
      const ph = frac((pos + o.off) / o.beats);
      const r = (o.min + (o.max - o.min) * (0.5 + 0.5 * Math.cos(TAU * ph))) * swell;
      const [r1, g1, b1] = f.pal.rgb(o.t);
      const al = o.al * o.life;
      const grad = g.createRadialGradient(o.x, o.y, 0, o.x, o.y, r);
      grad.addColorStop(0, `rgba(${r1},${g1},${b1},${al})`);
      grad.addColorStop(0.65, `rgba(${r1},${g1},${b1},${al * 0.75})`);
      grad.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(o.x, o.y, r, 0, TAU);
      g.fill();
    }
    const s = Math.min(f.W, f.H);
    g.lineWidth = 2 * f.dpr;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const k = this.rings[i];
      k.age += a.dt;
      if (k.age > 0.8) { this.rings.splice(i, 1); continue; }
      g.strokeStyle = f.pal.css(k.t + 0.25, 1 - k.age / 0.8);
      g.beginPath();
      g.arc(k.x, k.y, k.r + k.age * s * 0.5, 0, TAU);
      g.stroke();
    }
  }
}

// --- Spiral --------------------------------------------------------------------
// Borrowed from Spiral Generator (after laxinline's Spiral Gen v2): every frame
// the transform turns one degree further and stamps a ring of small squares at
// a growing radius into a buffer that is never cleared, so paisley arms pile
// up. The pointer used to set the count and the size; here the mids set the
// count and the treble the size, the bass fattens the squares, and the two
// colors drift on, faster the louder the room.

class Spiral {
  constructor() {
    this.pg = document.createElement('canvas');
    this.pc = this.pg.getContext('2d');
    this.fc = 0;
    this.A = Math.random();
    this.C = this.A + 0.5;
    this.spin = 0;
  }
  ensure(f) {
    // Capped: at phone pixel densities the diagonal buffer would otherwise run
    // to eleven megapixels, and it is redrawn whole every frame.
    const d = Math.min(2048, Math.ceil(Math.hypot(f.W, f.H)));
    if (this.pg.width !== d) {
      this.pg.width = this.pg.height = d;
      this.pc.fillStyle = '#000';
      this.pc.fillRect(0, 0, d, d);
    }
  }
  enter(g, f) {
    this.ensure(f);
    this.pc.fillStyle = '#000';
    this.pc.fillRect(0, 0, this.pg.width, this.pg.height);
    this.fc = 0;
  }
  beat() { /* the colors drift on their own, below */ }
  bar() { /* the fade is per frame, below */ }
  hit() { /* the stamp below reads a.hit */ }
  draw(g, f, a) {
    this.ensure(f);
    const pc = this.pc, d = this.pg.width;
    const scaleOut = Math.hypot(f.W, f.H) / d;
    const dim = Math.max(f.W, f.H) / scaleOut;
    // The original lets the arms over-paint forever. A touch of fade, a tenth
    // per bar, keeps the newest arms readable against the oldest. Not a tenth
    // at once on the bar, which read as the whole picture blinking, and not a
    // sliver every frame either: an eight-bit canvas rounds a fill under about
    // a hundredth away to nothing. Three hundredths, as often as the bar owes
    // them.
    const barLen = 4 * 60 / Math.max(40, a.bpm);
    this.owed = (this.owed || 0) + 1 - Math.pow(0.9, a.dt / barLen);
    if (this.owed >= 0.03) {
      this.owed -= 0.03;
      pc.fillStyle = 'rgba(0,0,0,0.03)';
      pc.fillRect(0, 0, d, d);
    }
    const drift = a.dt * (0.3 + 0.7 * a.level);
    this.A += 0.12 * drift;
    this.C += 0.09 * drift;
    // One stamp per sixtieth of a second, however often the screen refreshes.
    // The original stamped per frame at p5's sixty; at an uncapped rate that
    // would lay down a solid disc.
    this.acc = Math.min(4, (this.acc || 0) + a.dt * 60);
    let n = 6 + Math.round(58 * clamp(a.mid * 1.2, 0, 1));
    if (n > 10 && n % 2 === 1) n -= 1;   // the original's rule: even above ten
    if (n === 7) n = 8;                   // and never seven
    const s = 0.5 + 1.8 * a.treb;
    const sq = 4 * (1 + 0.8 * a.bass + 0.5 * a.hit);
    // Stamped in CSS pixels, as the original was: in device pixels a phone
    // would take twice as long to grow the same spiral, and draw it half size.
    const reach = (dim / f.dpr / 2) / s;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.fc += 1;
      const fc = this.fc;
      pc.save();
      pc.translate(d / 2, d / 2);
      pc.scale(f.dpr, f.dpr);
      pc.rotate((fc % 360) * Math.PI / 180);
      pc.fillStyle = fc % 2 === 0 ? f.pal.css(this.A, 0.35) : f.pal.css(this.C, 0.5);
      for (let i = 0; i < n; i++) {
        pc.save();
        pc.rotate(TAU * i / n);
        pc.translate(i, i * 3);
        pc.scale(s, s);
        pc.fillRect(fc % reach, 0, sq, sq);
        pc.restore();
      }
      pc.restore();
    }
    // Present it: the whole spiral turns slowly, faster when the room is loud.
    this.spin += a.dt * 0.04 * (1 + 3 * a.level);
    g.fillStyle = '#000';
    g.fillRect(0, 0, f.W, f.H);
    g.save();
    g.translate(f.W / 2, f.H / 2);
    g.rotate(this.spin);
    g.scale(scaleOut, scaleOut);
    g.drawImage(this.pg, -d / 2, -d / 2);
    g.restore();
  }
}

// --- Layers --------------------------------------------------------------------
// Borrowed from Earthbound Layers: two indexed patterns, each with its own
// rotating palette and its own per-scanline distortion, added together on a
// coarse grid. The bass bends the distortion, the treble spins the palettes,
// and every fourth bar deals one layer afresh, cross-fading it in over the
// next two seconds while the layer it replaces fades out.

const PATTERNS = ['Checker', 'Stripes', 'Rings', 'Diagonals', 'Bubbles', 'Spiral'];

class Layers {
  constructor() {
    this.cv = document.createElement('canvas');
    this.cx = this.cv.getContext('2d');
    this.img = null;
    this.L = [this.deal(), this.deal()];
    this.t = Math.random() * 100;
    this.which = 0;      // the layer the next deal replaces
    this.next = null;    // the layer coming in, while one is
    this.mix = 0;        // how far in it is, 0 to 1
    this.dx = [];
    this.dy = [];
  }
  deal() {
    const sign = () => (Math.random() < 0.5 ? -1 : 1);
    return {
      pat: Math.floor(Math.random() * PATTERNS.length),
      type: 1 + Math.floor(Math.random() * 3),
      amp: 3 + Math.random() * 12,
      freq: 1 + Math.random() * 6,
      speed: (0.5 + Math.random() * 2.5) * sign(),
      cyc: 0,
      cycSpeed: (3 + Math.random() * 14) * sign(),
      scroll: 0,
      scrollSpeed: (Math.random() - 0.5) * 16,
      palT: Math.random(),
      scale: 20 + Math.random() * 44,
    };
  }
  enter() { this.L = [this.deal(), this.deal()]; this.next = null; }
  beat() { /* the palettes cycle on their own, below */ }
  bar(a) {
    if (a.barN % 4 === 0 && !this.next) { this.next = this.deal(); this.mix = 0; }
  }
  hit() { /* nothing: a jolt here was a jump */ }
  /** Move a layer on by a frame, and build its 16-entry ramp at weight `w`:
   *  the layers add, and two full palettes added give white, so a layer on
   *  its own is half intensity. */
  advance(L, li, a, f, n, m, k, w) {
    L.cyc += a.dt * L.cycSpeed * (1 + 2 * a.treb);
    L.scroll += a.dt * L.scrollSpeed * k;
    const amp = L.amp * k * (1 + 1.5 * a.bass);
    let dx = this.dx[li], dy = this.dy[li];
    if (!dx) { dx = this.dx[li] = new Float32Array(m); dy = this.dy[li] = new Float32Array(m); }
    for (let y = 0; y < m; y++) {
      const v = amp * Math.sin((y / m) * L.freq * TAU + this.t * L.speed);
      if (L.type === 1) { dx[y] = v; dy[y] = 0; }
      else if (L.type === 2) { dx[y] = (y & 1) ? v : -v; dy[y] = 0; }
      else { dx[y] = 0; dy[y] = v * 0.5; }
    }
    const ramp = new Float32Array(16 * 3);
    const rot = Math.floor(L.cyc);
    for (let i = 0; i < 16; i++) {
      const [r, gg, b] = f.pal.rgb(L.palT + ((i + rot) & 15) / 16);
      ramp[i * 3] = r * 0.5 * w; ramp[i * 3 + 1] = gg * 0.5 * w; ramp[i * 3 + 2] = b * 0.5 * w;
    }
    return { L, ramp, dx, dy, s: L.scale * k };
  }
  pattern(pat, x, y, s, n, m) {
    switch (pat) {
      case 0: {
        const cell = ((Math.floor(x / s) + Math.floor(y / s)) & 1) === 0;
        return Math.floor(frac((cell ? x : y) / s) * 16);
      }
      case 1: return Math.floor(frac(x / s) * 16);
      case 2: return Math.floor(frac(Math.hypot(x - n / 2, y - m / 2) / s) * 16);
      case 3: return Math.floor(frac((x + y) / s) * 16);
      case 4: return Math.floor((0.5 + 0.5 * Math.sin(x / s * TAU) * Math.sin(y / s * TAU)) * 15.99);
      default: {
        const ax = x - n / 2, ay = y - m / 2;
        return Math.floor(frac(Math.atan2(ay, ax) / TAU + Math.hypot(ax, ay) / s / 2) * 16);
      }
    }
  }
  draw(g, f, a) {
    // A fixed grid, a little finer than the 256 the originals had: the
    // Resolution slider is Pixels' own. Below about 128 across the two layers
    // and the scanline warp stop reading as anything.
    const n = 192;
    const m = Math.max(3, Math.round(n * f.H / f.W));
    if (this.cv.width !== n || this.cv.height !== m) {
      this.cv.width = n;
      this.cv.height = m;
      this.img = this.cx.createImageData(n, m);
      this.dx = [];
      this.dy = [];
    }
    this.t += a.dt;
    const k = n / 128;   // everything was tuned at 128 across
    // The two layers, and a third while a fresh one is coming in: the one
    // going out gives up its weight to the one taking its place.
    if (this.next) {
      this.mix = Math.min(1, this.mix + a.dt / 2);
      if (this.mix >= 1) { this.L[this.which] = this.next; this.next = null; this.which ^= 1; }
    }
    const layers = [];
    for (let li = 0; li < 2; li++) {
      const w = this.next && li === this.which ? 1 - this.mix : 1;
      layers.push(this.advance(this.L[li], li, a, f, n, m, k, w));
    }
    if (this.next) layers.push(this.advance(this.next, 2, a, f, n, m, k, this.mix));
    const d = this.img.data;
    const nl = layers.length;
    let p = 0;
    for (let y = 0; y < m; y++) {
      for (let li = 0; li < nl; li++) {
        const q = layers[li];
        q.x = q.dx[y];
        q.y = y + q.dy[y] + q.L.scroll;
      }
      for (let x = 0; x < n; x++, p += 4) {
        let r = 0, gg = 0, b = 0;
        for (let li = 0; li < nl; li++) {
          const q = layers[li];
          const i = this.pattern(q.L.pat, x + q.x, q.y, q.s, n, m) * 3;
          r += q.ramp[i]; gg += q.ramp[i + 1]; b += q.ramp[i + 2];
        }
        d[p] = r;
        d[p + 1] = gg;
        d[p + 2] = b;
        d[p + 3] = 255;
      }
    }
    this.cx.putImageData(this.img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.cv, 0, 0, f.W, f.H);
    g.imageSmoothingEnabled = true;
  }
}

export const SCENES = [
  { key: 'pixels', name: 'Pixels', make: () => new Pixels(), note: 'A noise field on a coarse grid. Bass brightens it, beats urge it on, treble sparkles. Resolution sets the grid.' },
  { key: 'flow', name: 'Flow', make: () => new Flow(), note: 'Particles ride a Perlin flow field. Bass drives them, mids weight the lines, beats turn the current.' },
  { key: 'orbs', name: 'Orbs', make: () => new Orbs(), note: 'The Particle System’s orbs, breathing in whole beats so they swell together. Hits send out rings.' },
  { key: 'spiral', name: 'Spiral', make: () => new Spiral(), note: 'The Spiral Generator’s ring of squares, counted by the mids and sized by the treble. The colors drift with the level.' },
  { key: 'layers', name: 'Layers', make: () => new Layers(), note: 'Earthbound Layers: two patterns with cycling palettes, warped by the bass and spun by the treble. Every fourth bar fades a fresh layer in.' },
];
