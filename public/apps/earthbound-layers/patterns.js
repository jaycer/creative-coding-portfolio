// Earthbound Layers — the pattern library.
//
// Every layer in the original is a 256x256 indexed bitmap at two or four bits a
// pixel: four colors or sixteen, and nothing in between. The bitmap itself never
// moves and never changes. What you see moving is two other things entirely —
// the scanline offsets that distort where it is sampled, and the palette
// rotating underneath it — which is why the whole effect cost the SNES almost
// nothing and why it is so cheap here.
//
// So these functions run ONCE, at load, and hand back an index map. Nothing in
// this file knows about time, and nothing in it knows about color.
//
// None of these are Nintendo's. They are patterns in the same idiom, written
// here: the game's own layers are ROM data and are not shipped with this.
//
// Every pattern must be periodic in SIZE on both axes, because the texture
// wraps and a distortion pushes the sample well past the edge. The radial ones
// are built out of a mirrored coordinate so that they close up too — a spiral
// that simply ran off its own edge would show a hard seam the moment the
// amplitude got interesting.

export const SIZE = 256;

const TAU = Math.PI * 2;

/** Wrap a coordinate to a triangle wave: 0..1..0 across the tile, so it meets itself. */
function mirror(u) {
  const t = u * 2;
  return t < 1 ? t : 2 - t;
}

/** Quantize a 0..1 signal into `levels` indices. */
function band(v, levels) {
  const i = Math.floor(v * levels);
  return i < 0 ? 0 : i >= levels ? levels - 1 : i;
}

/**
 * Build an index map from a function of position.
 *
 * `fn(x, y, u, v)` gets both the pixel coordinates and the 0..1 versions, and
 * returns 0..1; the banding into discrete indices happens here, in one place,
 * because the number of colors is a property of the layer and not of the shape.
 */
function build(levels, fn) {
  const data = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      data[y * SIZE + x] = band(fn(x, y, x / SIZE, y / SIZE), levels);
    }
  }
  return { data, levels };
}

// ---------------------------------------------------------------- the patterns
// Each entry is { name, levels, make }. `levels` is how many palette entries the
// layer uses, and it is deliberately small: four and sixteen are the only two
// depths the original had, and holding to them is most of why these read as
// being from that machine rather than as a gradient with a filter on it.

export const PATTERNS = [
  {
    name: 'Checkerboard',
    make: () => build(2, (x, y) => ((Math.floor(x / 16) + Math.floor(y / 16)) & 1 ? 0.9 : 0.1)),
  },
  {
    name: 'Diamonds',
    make: () => build(4, (x, y, u, v) => {
      const d = Math.abs(mirror(u) - 0.5) + Math.abs(mirror(v) - 0.5);
      return (d * 3) % 1;
    }),
  },
  {
    name: 'Rings',
    make: () => build(4, (x, y, u, v) => {
      // Around the tile's own middle, on mirrored axes, so the rings close up
      // against every neighboring copy instead of stopping at the seam.
      const dx = mirror(u) - 0.5, dy = mirror(v) - 0.5;
      return (Math.sqrt(dx * dx + dy * dy) * 9) % 1;
    }),
  },
  {
    name: 'Stripes',
    make: () => build(4, (x, y, u) => (Math.sin(u * TAU * 4) * 0.5 + 0.5)),
  },
  {
    name: 'Bars',
    make: () => build(2, (x, y, u, v) => (Math.sin(v * TAU * 6) * 0.5 + 0.5)),
  },
  {
    name: 'Diagonals',
    make: () => build(4, (x, y) => (((x + y) % 64) / 64)),
  },
  {
    name: 'Herringbone',
    make: () => build(4, (x, y) => {
      const band16 = Math.floor(y / 16) & 1;
      return (((band16 ? x + y : x - y) % 32) + 32) % 32 / 32;
    }),
  },
  {
    name: 'Spiral',
    make: () => build(4, (x, y, u, v) => {
      const dx = mirror(u) - 0.5, dy = mirror(v) - 0.5;
      const a = Math.atan2(dy, dx);
      const r = Math.sqrt(dx * dx + dy * dy);
      return ((a / TAU) * 5 + r * 7 + 1) % 1;
    }),
  },
  {
    name: 'Lattice',
    make: () => build(4, (x, y) => {
      const gx = Math.min((x % 32) / 32, 1 - (x % 32) / 32) * 2;
      const gy = Math.min((y % 32) / 32, 1 - (y % 32) / 32) * 2;
      return 1 - Math.min(gx, gy);
    }),
  },
  {
    name: 'Bubbles',
    make: () => build(4, (x, y, u, v) => {
      // Three sine pairs beaten against each other: blobby, and periodic by
      // construction because every term is a whole number of cycles per tile.
      let s = 0;
      s += Math.sin(u * TAU * 3) * Math.sin(v * TAU * 3);
      s += Math.sin(u * TAU * 5 + 1.7) * Math.sin(v * TAU * 2 + 0.4);
      s += Math.sin(u * TAU * 2 - 0.8) * Math.sin(v * TAU * 5 + 2.2);
      return s / 6 + 0.5;
    }),
  },
  {
    name: 'Chevrons',
    make: () => build(4, (x, y, u, v) => {
      const z = Math.abs(mirror(u) - 0.5) * 2;
      return (z * 2 + v * 4) % 1;
    }),
  },
  {
    name: 'Honeycomb',
    make: () => build(4, (x, y, u, v) => {
      const a = Math.sin(u * TAU * 4);
      const b = Math.sin((u * 0.5 + v * 0.866) * TAU * 4);
      const c = Math.sin((u * 0.5 - v * 0.866) * TAU * 4);
      return (a + b + c) / 6 + 0.5;
    }),
  },
  {
    name: 'Static',
    make: () => {
      // A fixed hash rather than Math.random: the layer is meant to be the same
      // bitmap every time the app opens, the way a ROM's would be, so that a
      // saved setup comes back as the picture it was saved from.
      let s = 0x9e3779b9;
      return build(4, () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return (s >>> 8) / 0xffffff;
      });
    },
  },
  {
    name: 'Weave',
    make: () => build(4, (x, y) => {
      const over = (Math.floor(x / 16) + Math.floor(y / 16)) & 1;
      return over ? ((y % 16) / 16) : ((x % 16) / 16);
    }),
  },
  {
    name: 'Sunburst',
    make: () => build(4, (x, y, u, v) => {
      const dx = mirror(u) - 0.5, dy = mirror(v) - 0.5;
      return ((Math.atan2(dy, dx) / TAU) * 12 + 1) % 1;
    }),
  },
  {
    // Polar checkerboard. Nothing built on a square grid produces this, and it
    // turns out to be one of the commonest shapes in the originals: blocks
    // marching round a center, breaking into a pinwheel the moment a distortion
    // touches them.
    name: 'Radial Blocks',
    make: () => build(2, (x, y, u, v) => {
      const dx = mirror(u) - 0.5, dy = mirror(v) - 0.5;
      const a = Math.atan2(dy, dx) / TAU + 0.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      return ((Math.floor(a * 12) + Math.floor(r * 10)) & 1) ? 0.9 : 0.1;
    }),
  },
  {
    // Rings drawn as LINES rather than as filled bands. Every other pattern here
    // is areas of color meeting each other; this one is mostly empty, which is
    // what lets a layer read as a thin bright figure on a dark ground instead of
    // as a field. Hard to get any other way.
    name: 'Outlines',
    make: () => build(4, (x, y, u, v) => {
      const dx = Math.abs(mirror(u) - 0.5), dy = Math.abs(mirror(v) - 0.5);
      const f = (Math.max(dx, dy) * 8) % 1;
      return f < 0.2 ? 0.95 : (f < 0.28 ? 0.45 : 0.02);
    }),
  },
  {
    name: 'Triangles',
    make: () => build(4, (x, y, u, v) => {
      const cx = u * 6, cy = v * 6;
      const up = ((cx % 1) + (cy % 1)) < 1 ? 0 : 1;
      return ((Math.floor(cx) + Math.floor(cy) * 2 + up * 3) % 4 + 0.5) / 4;
    }),
  },
  {
    name: 'Plaid',
    make: () => build(4, (x, y, u, v) => {
      const a = Math.sin(u * TAU * 2) * 0.5 + 0.5;
      const b = Math.sin(v * TAU * 3) * 0.5 + 0.5;
      return (a * 0.6 + b * 0.6) % 1;
    }),
  },
];

export const PATTERN_NAMES = PATTERNS.map((p) => p.name);
