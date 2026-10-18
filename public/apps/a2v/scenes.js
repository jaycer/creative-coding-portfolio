// A2V — the six ways it draws what it hears.
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
/** 0 to 1. */
const noise01 = (x, y, z) => clamp(noise3(x, y, z) * 0.5 + 0.5, 0, 1);

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
  { name: 'Drift', stops: null },
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
    else this.drift(0);
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
// whole field, each beat pushes the field through time so it morphs, treble
// sprinkles white cells, and the palette cycles underneath the lot.

class Pixels {
  constructor() {
    this.cv = document.createElement('canvas');
    this.cx = this.cv.getContext('2d');
    this.img = null;
    this.z = Math.random() * 50;
    this.off = Math.random();
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
  beat() { this.z += 0.22; this.off += 1 / 10; }
  bar() { this.off += 1 / 8; }
  hit() { /* the sparkle below reads a.struck directly */ }
  draw(g, f, a) {
    this.size(f);
    const n = this.cv.width, m = this.cv.height, d = this.img.data, lut = f.pal.lut;
    this.z += a.dt * (0.04 + 0.3 * a.level);
    this.off += a.dt * 0.025 * (1 + 3 * a.treb);
    const zoom = 2.6 * (1 - 0.12 * a.pulse);
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
    // the top end, and a burst on a hit.
    const cells = n * m;
    const k = Math.floor(a.treb * a.treb * cells * 0.7 * a.dt + (a.struck ? cells * 0.006 : 0));
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
// mids their weight, and every beat shoves the field through time so the whole
// current changes course at once.

class Flow {
  constructor() {
    this.N = 1200;
    this.p = null;
    this.zt = Math.random() * 100;
    this.off = Math.random();
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
  beat() { this.zt += 0.28; }
  bar(a, f) {
    // A share of them start again somewhere new, so the field never settles
    // into the few channels everything eventually drains into.
    const p = this.p;
    for (let i = 0; i < this.N; i++) {
      if (Math.random() < 0.15) { p[i * 3] = Math.random() * f.W; p[i * 3 + 1] = Math.random() * f.H; }
    }
  }
  hit() { this.off += 0.03; }
  draw(g, f, a) {
    if (!this.p || this.W !== f.W || this.H !== f.H) this.enter(g, f);
    g.globalCompositeOperation = 'source-over';
    // Trails fade on the clock, not per frame, so a fast screen and a slow one
    // leave the same tail.
    g.fillStyle = `rgba(0,0,0,${(1 - Math.exp(-a.dt / 0.19)).toFixed(3)})`;
    g.fillRect(0, 0, f.W, f.H);
    this.zt += a.dt * 0.07;
    this.off += a.dt * 0.015;
    const s = Math.min(f.W, f.H);
    const sc = 1.8 / s;
    const spd = s * a.dt * (0.05 + 0.32 * a.bass + 0.45 * a.hit);
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
      if (nx < 0 || nx >= f.W || ny < 0 || ny >= f.H) {
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
// together on the downbeats, and a hit sends a ring out of one of them.

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
    };
  }
  enter(g, f) {
    this.W = f.W;
    this.H = f.H;
    this.orbs = [];
    for (let i = 0; i < 22; i++) this.orbs.push(this.make(f));
    this.rings = [];
  }
  beat() { /* the breathing reads the phase directly */ }
  bar(a, f) {
    // Retire the oldest, bring in a new one, so the field keeps changing.
    this.orbs.shift();
    this.orbs.push(this.make(f));
  }
  hit(a, f) {
    const o = this.orbs[Math.floor(Math.random() * this.orbs.length)];
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
    for (const o of this.orbs) {
      o.x += o.vx * a.dt;
      o.y += o.vy * a.dt;
      if (o.x < 0 || o.x > f.W) { o.vx *= -1; o.x = clamp(o.x, 0, f.W); }
      if (o.y < 0 || o.y > f.H) { o.vy *= -1; o.y = clamp(o.y, 0, f.H); }
      o.t += o.dt * a.dt;
      const ph = frac((pos + o.off) / o.beats);
      const r = (o.min + (o.max - o.min) * (0.5 + 0.5 * Math.cos(TAU * ph))) * swell;
      const [r1, g1, b1] = f.pal.rgb(o.t);
      const grad = g.createRadialGradient(o.x, o.y, 0, o.x, o.y, r);
      grad.addColorStop(0, `rgba(${r1},${g1},${b1},${o.al})`);
      grad.addColorStop(0.65, `rgba(${r1},${g1},${b1},${o.al * 0.75})`);
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
// count and the treble the size, the bass fattens the squares, and each beat
// steps the two colors on.

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
  beat() { this.A += 0.06; this.C += 0.045; }
  bar(a) {
    // The original lets the arms over-paint forever. A touch of fade on every
    // bar keeps the newest arms readable against the oldest.
    this.pc.fillStyle = 'rgba(0,0,0,0.1)';
    this.pc.fillRect(0, 0, this.pg.width, this.pg.height);
    if (a.barN % 16 === 0) { this.A = Math.random(); this.C = this.A + 0.5; }
  }
  hit() { /* the stamp below reads a.hit */ }
  draw(g, f, a) {
    this.ensure(f);
    const pc = this.pc, d = this.pg.width;
    const scaleOut = Math.hypot(f.W, f.H) / d;
    const dim = Math.max(f.W, f.H) / scaleOut;
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
    // Present it: the whole spiral turns slowly, faster when the room is loud,
    // and breathes a little on the beat.
    this.spin += a.dt * 0.04 * (1 + 3 * a.level);
    g.fillStyle = '#000';
    g.fillRect(0, 0, f.W, f.H);
    g.save();
    g.translate(f.W / 2, f.H / 2);
    g.rotate(this.spin);
    const k = scaleOut * (1 + 0.05 * a.pulse);
    g.scale(k, k);
    g.drawImage(this.pg, -d / 2, -d / 2);
    g.restore();
  }
}

// --- Layers --------------------------------------------------------------------
// Borrowed from Earthbound Layers: two indexed patterns, each with its own
// rotating palette and its own per-scanline distortion, added together on a
// coarse grid. The bass bends the distortion, the treble spins the palettes,
// each beat jolts the lot, and every fourth bar deals one layer afresh.

const PATTERNS = ['Checker', 'Stripes', 'Rings', 'Diagonals', 'Bubbles', 'Spiral'];

class Layers {
  constructor() {
    this.cv = document.createElement('canvas');
    this.cx = this.cv.getContext('2d');
    this.img = null;
    this.L = [this.deal(), this.deal()];
    this.t = Math.random() * 100;
    this.jolt = 0;
    this.which = 0;
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
  enter() { this.L = [this.deal(), this.deal()]; }
  beat() { this.jolt = 1; for (const L of this.L) L.cyc += 1; }
  bar(a) {
    if (a.barN % 4 === 0) { this.L[this.which] = this.deal(); this.which ^= 1; }
  }
  hit() { this.jolt = Math.max(this.jolt, 0.6); }
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
      this.dx = [new Float32Array(m), new Float32Array(m)];
      this.dy = [new Float32Array(m), new Float32Array(m)];
    }
    this.t += a.dt;
    this.jolt *= Math.exp(-a.dt / 0.25);
    const k = n / 128;   // everything was tuned at 128 across
    const ramps = [];
    for (let li = 0; li < 2; li++) {
      const L = this.L[li];
      L.cyc += a.dt * L.cycSpeed * (1 + 2 * a.treb);
      L.scroll += a.dt * L.scrollSpeed * k;
      const amp = L.amp * k * (1 + 1.5 * a.bass + 1.5 * this.jolt);
      const dx = this.dx[li], dy = this.dy[li];
      for (let y = 0; y < m; y++) {
        const w = amp * Math.sin((y / m) * L.freq * TAU + this.t * L.speed);
        if (L.type === 1) { dx[y] = w; dy[y] = 0; }
        else if (L.type === 2) { dx[y] = (y & 1) ? w : -w; dy[y] = 0; }
        else { dx[y] = 0; dy[y] = w * 0.5; }
      }
      // Sixteen entries, half intensity each, rotated by the cycle: the two
      // layers add, and two full palettes added give white.
      const ramp = new Float32Array(16 * 3);
      const rot = Math.floor(L.cyc);
      for (let i = 0; i < 16; i++) {
        const [r, gg, b] = f.pal.rgb(L.palT + ((i + rot) & 15) / 16);
        ramp[i * 3] = r * 0.5; ramp[i * 3 + 1] = gg * 0.5; ramp[i * 3 + 2] = b * 0.5;
      }
      ramps.push(ramp);
    }
    const d = this.img.data;
    const [L0, L1] = this.L;
    const s0 = L0.scale * k, s1 = L1.scale * k;
    let p = 0;
    for (let y = 0; y < m; y++) {
      const x0 = this.dx[0][y], y0 = y + this.dy[0][y] + L0.scroll;
      const x1 = this.dx[1][y], y1 = y + this.dy[1][y] + L1.scroll;
      for (let x = 0; x < n; x++, p += 4) {
        const i0 = this.pattern(L0.pat, x + x0, y0, s0, n, m) * 3;
        const i1 = this.pattern(L1.pat, x + x1, y1, s1, n, m) * 3;
        d[p] = ramps[0][i0] + ramps[1][i1];
        d[p + 1] = ramps[0][i0 + 1] + ramps[1][i1 + 1];
        d[p + 2] = ramps[0][i0 + 2] + ramps[1][i1 + 2];
        d[p + 3] = 255;
      }
    }
    this.cx.putImageData(this.img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.cv, 0, 0, f.W, f.H);
    g.imageSmoothingEnabled = true;
  }
}

// --- Bloons --------------------------------------------------------------------
// Borrowed from Bloon Boon: glossy balloons drifting up. They swell with the
// bass, bob on every beat, and a hit pops the highest one into confetti, with
// a new one let go from the bottom.

class Bloons {
  constructor() {
    this.bs = [];
    this.bits = [];
    this.lastPop = -10;
    this.W = 0;
    this.H = 0;
  }
  make(f, atBottom) {
    const s = Math.min(f.W, f.H);
    const r = s * (0.035 + Math.random() * 0.05);
    return {
      x: r + Math.random() * (f.W - 2 * r),
      y: atBottom ? f.H + r * 2.5 : Math.random() * f.H,
      r, vy: s * (0.04 + Math.random() * 0.06), bob: 0,
      ph: Math.random() * TAU, t: Math.random(),
    };
  }
  enter(g, f) {
    this.W = f.W;
    this.H = f.H;
    this.bs = [];
    for (let i = 0; i < 18; i++) this.bs.push(this.make(f, false));
    this.bits = [];
  }
  beat() { for (const b of this.bs) b.bob = 1; }
  bar(a, f) {
    // Something always pops on a downbeat if the room has been quiet.
    if (a.t - this.lastPop > 2) this.pop(a, f);
  }
  hit(a, f) {
    // Onsets come several a second on a busy track; a pop every one of them
    // is a screen of confetti and no balloons.
    if (a.hit > 0.45 && a.t - this.lastPop > 0.25) this.pop(a, f);
  }
  pop(a, f) {
    let top = null;
    for (const b of this.bs) if (b.y > -b.r && b.y < f.H && (!top || b.y < top.y)) top = b;
    if (!top) return;
    this.lastPop = a.t;
    const s = Math.min(f.W, f.H);
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * TAU, v = s * (0.2 + Math.random() * 0.6);
      this.bits.push({ x: top.x, y: top.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - s * 0.2, age: 0, t: top.t + Math.random() * 0.3, w: top.r * 0.18 });
    }
    if (this.bits.length > 400) this.bits.splice(0, this.bits.length - 400);
    Object.assign(top, this.make(f, true));
  }
  draw(g, f, a) {
    if (!this.bs.length || this.W !== f.W || this.H !== f.H) this.enter(g, f);
    const s = Math.min(f.W, f.H);
    const [r0, g0, b0] = f.pal.rgb(0.05);
    const sky = g.createLinearGradient(0, 0, 0, f.H);
    sky.addColorStop(0, `rgb(${r0 * 0.3 | 0},${g0 * 0.3 | 0},${b0 * 0.3 | 0})`);
    sky.addColorStop(1, `rgb(${r0 * 0.08 | 0},${g0 * 0.08 | 0},${b0 * 0.08 | 0})`);
    g.fillStyle = sky;
    g.fillRect(0, 0, f.W, f.H);
    this.bs.sort((p, q) => p.r - q.r);
    const swell = 1 + 0.35 * a.bass;
    for (const b of this.bs) {
      b.bob *= Math.exp(-a.dt / 0.18);
      b.y -= b.vy * a.dt * (1 + 0.6 * a.level) + b.bob * s * 0.9 * a.dt;
      b.x += Math.sin(a.t * 1.3 + b.ph) * s * 0.03 * a.dt;
      if (b.y < -b.r * 3) Object.assign(b, this.make(f, true));
      const r = b.r * swell * (1 + 0.1 * b.bob);
      const [cr, cg, cb] = f.pal.rgb(b.t);
      // string
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = f.dpr;
      g.beginPath();
      g.moveTo(b.x, b.y + r * 1.2);
      g.quadraticCurveTo(b.x + Math.sin(a.t * 2 + b.ph) * r * 0.5, b.y + r * 2.2, b.x + Math.sin(a.t * 2.7 + b.ph) * r * 0.3, b.y + r * 3.4);
      g.stroke();
      // body, lit from the upper left
      const grad = g.createRadialGradient(b.x - r * 0.35, b.y - r * 0.45, r * 0.05, b.x, b.y, r * 1.15);
      grad.addColorStop(0, `rgba(255,255,255,0.95)`);
      grad.addColorStop(0.18, `rgba(${cr},${cg},${cb},1)`);
      grad.addColorStop(1, `rgba(${cr * 0.35 | 0},${cg * 0.35 | 0},${cb * 0.35 | 0},1)`);
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(b.x, b.y, r, r * 1.15, 0, 0, TAU);
      g.fill();
      // knot
      g.beginPath();
      g.moveTo(b.x, b.y + r * 1.1);
      g.lineTo(b.x - r * 0.14, b.y + r * 1.3);
      g.lineTo(b.x + r * 0.14, b.y + r * 1.3);
      g.closePath();
      g.fill();
    }
    const grav = s * 1.4;
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const k = this.bits[i];
      k.age += a.dt;
      if (k.age > 1.2) { this.bits.splice(i, 1); continue; }
      k.vy += grav * a.dt;
      k.x += k.vx * a.dt;
      k.y += k.vy * a.dt;
      g.fillStyle = f.pal.css(k.t, 1 - k.age / 1.2);
      g.fillRect(k.x, k.y, k.w, k.w * 0.6);
    }
  }
}

export const SCENES = [
  { key: 'pixels', name: 'Pixels', make: () => new Pixels(), note: 'A noise field on a coarse grid. Bass brightens it, beats morph it, treble sparkles. Resolution sets the grid.' },
  { key: 'flow', name: 'Flow', make: () => new Flow(), note: 'Particles ride a Perlin flow field. Bass drives them, mids weight the lines, beats redraw the current.' },
  { key: 'orbs', name: 'Orbs', make: () => new Orbs(), note: 'The Particle System’s orbs, breathing in whole beats so they swell together. Hits send out rings.' },
  { key: 'spiral', name: 'Spiral', make: () => new Spiral(), note: 'The Spiral Generator’s ring of squares, counted by the mids and sized by the treble. Beats step the colors.' },
  { key: 'layers', name: 'Layers', make: () => new Layers(), note: 'Earthbound Layers: two patterns with cycling palettes, warped by the bass and jolted by the beat. Every fourth bar deals one layer afresh.' },
  { key: 'bloons', name: 'Bloons', make: () => new Bloons(), note: 'Bloons from Bloon Boon rise and swell with the bass. Hits pop the highest one.' },
];
