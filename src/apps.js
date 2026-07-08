// Manifest for the gallery grid. Each entry is a self-contained sub-app served
// at /apps/<slug>/. The numbered apps are Vite multi-page entries under /apps;
// the named ones below are fully static pages under /public/apps/<slug>/ (they
// load p5/Bootstrap from a CDN and fetch their own assets at runtime, so they
// ship verbatim rather than going through the bundler). Static apps set
// `entry: 'index.html'` so the gallery links straight to the file — Vite's dev
// server only resolves bare directory URLs for its own registered entries, not
// for static folders under /public. To add work: drop a folder in either place
// and add a row here.
export const apps = [
  // Flow Field (app-01) and Particle Swarm (app-02) are intentionally unlisted —
  // still reachable by direct URL, just not shown in the gallery grid.
  { slug: 'bloon-boon',             title: 'Bloon Boon',             blurb: 'A shader-balloon juggling game — tap and flick glossy 3D balloons to keep them aloft; each colour sings its own sound.', entry: 'index.html' },
  { slug: 'particle-system',        title: 'Particle System',        blurb: 'Color-shifting orbs that breathe in and out across an HSB field.',           entry: 'index.html' },
  { slug: 'shader-particle-system', title: 'Shader Particle System', blurb: 'The particle system reborn on the GPU — soft additive blobs in a fragment shader.', entry: 'index.html' },
  { slug: 'ambient-lumina',         title: 'Ambient Lumina',         blurb: 'Ten lumina that sing — pitch from color, pan from motion, contrast where they meet.', entry: 'index.html' },
  { slug: 'ios-web-audio',          title: 'Web Audio on iOS',       blurb: 'A field note: the three WebKit gotchas that keep sound silent on iPhone — with a live tone that proves the fix.', entry: 'index.html' },
  { slug: 'spiral-generator',       title: 'Spiral Generator',       blurb: 'Paisley spirals accumulate from a rotating ring of squares — mouse sets scale and count.', entry: 'index.html' },
  { slug: 'hieroglyph-viewer',      title: 'Hieroglyph Viewer',      blurb: 'Browse Egyptian hieroglyphs one at a time — favorite the ones you like.',   entry: 'index.html' },
  { slug: 'u17sv-v0',               title: 'U17SV',                  blurb: 'An interactive WebGL shader visual driven by the keyboard. (flash warning)', entry: 'index.html' },
  { slug: 'brick-layer',            title: 'Brick Layer',            blurb: 'A React shader compositor — stack, rotate, and blend generative visual layers.', entry: 'index.html' },
];
