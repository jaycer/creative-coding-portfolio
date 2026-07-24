// Manifest for the gallery grid. Each entry is a self-contained sub-app served
// at /apps/<slug>/. The apps below are fully static pages under
// /public/apps/<slug>/ (they load p5/Bootstrap from a CDN and fetch their own
// assets at runtime, so they ship verbatim rather than going through the
// bundler) and set `entry: 'index.html'` so the gallery links straight to the
// file. Vite can also build multi-page entries dropped under /apps/<slug>/ —
// its dev server only resolves bare directory URLs for those registered
// entries, not for static folders under /public. To add work: drop a folder in
// either place and add a row here.
export const apps = [
  { slug: 'chair-pile',             title: 'Chair Pile',             blurb: 'Chairs fall out of the dark and pile up forever. Tap or press any key to send another one down, then drag to look around what you built.', entry: 'index.html' },
  { slug: 'chairs-in-space',        title: 'Chairs In Space!',       blurb: 'The chairs are pulled into a singularity. Slowly they form a planetoid. Tap to add a chair. Orbit the center and zoom.', entry: 'index.html' },
  { slug: 'photo-gallery',          title: 'Photo Gallery',          blurb: 'Professional photography including real estate interiors and exteriors, and more.', entry: 'index.html' },
  { slug: 'ch4td1c3',               title: 'ch4td1c3',               blurb: 'A full set of DnD dice drawn by a raymarching shader, hearts and all. Tap a die to roll it, or rattle the whole set.', entry: 'index.html' },
  { slug: 'bloon-boon',             title: 'Bloon Boon',             blurb: 'A shader-bloon juggling game. Tap and flick glossy 3D bloons to keep them aloft, each color singing its own sound, until 30 are up at once and you win.', entry: 'index.html' },
  { slug: 'sleep-noise',            title: 'Sleep Noise',            blurb: 'A calm noise machine for sleep. Blend dark, white, and pink noise, each with its own level and tone.', entry: 'index.html' },
  { slug: 'particle-system',        title: 'Particle System',        blurb: 'Color-shifting orbs that breathe in and out across an HSB field.',           entry: 'index.html' },
  { slug: 'shader-particle-system', title: 'Shader Particle System', blurb: 'The particle system reborn on the GPU as soft additive blobs in a fragment shader.', entry: 'index.html' },
  { slug: 'ambient-lumina',         title: 'Ambient Lumina',         blurb: 'Ten lumina that sing, with pitch from color, pan from motion, and contrast where they meet.', entry: 'index.html' },
  { slug: 'ios-web-audio',          title: 'Web Audio on iOS',       blurb: 'A field note on the three WebKit gotchas that keep sound silent on iPhone, with a live tone that proves the fix.', entry: 'index.html' },
  { slug: 'spiral-generator',       title: 'Spiral Generator',       blurb: 'Paisley spirals accumulate from a rotating ring of squares. Move to set scale and count.', entry: 'index.html' },
  { slug: 'hieroglyph-viewer',      title: 'Hieroglyph Viewer',      blurb: 'Browse Egyptian hieroglyphs one at a time and favorite the ones you like.',   entry: 'index.html' },
  { slug: 'u17sv-v0',               title: 'U17SV',                  blurb: 'An interactive WebGL shader visual driven by the keyboard. (flash warning)', entry: 'index.html' },
  { slug: 'brick-layer',            title: 'Brick Layer',            blurb: 'A React shader compositor that stacks, rotates, and blends generative visual layers.', entry: 'index.html' },
];
