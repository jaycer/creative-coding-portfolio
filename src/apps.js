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
  { slug: 'object-tile-scroll', title: 'Object Tile Scroll', blurb: 'Watch objects scroll by while forming an ambient chorus. Set how many of them breathe and whether they breathe together, or let it listen and breathe to whatever is playing in the room. Includes 3D models by Kenney and Quaternius.', entry: 'index.html' },
  { slug: 'v2a',            title: 'V2A',           blurb: 'Video in, audio out. Use a live camera feed or a video file, and hear the picture as a bank of tones. Height is pitch, brightness is loudness, and four mapping modes decide how the two meet. Video stays local.', entry: 'index.html' },
  { slug: 'hey-chair',      title: 'Hey Chair',     blurb: 'A troupe of chairs parades across the stage in time under theater lights, then carries on off the far side and is replaced by another set. Some of them glitch, wander, or spin. Tap to shout at them, or let it listen and dance to whatever is playing in the room.', entry: 'index.html' },
  { slug: 'gain-stage',     title: 'Gain Stage',    blurb: 'A mastering chain that runs in the tab. Drop in a file, shape it with EQ, compression, saturation and a look-ahead limiter, then export a WAV. Audio stays local.', entry: 'index.html' },
  { slug: 'burnt-crust',    title: 'Burnt Crust',   blurb: 'Ten faders of breakcore, each with a drift rate that moves it for you. Ten city kits, from Cleveland to Tokyo, swap every sound on the fly.', entry: 'index.html' },
  { slug: 'chair-pile',             title: 'Chair Pile',             blurb: 'Chairs fall out of the dark and pile up forever. Tap or press any key to send another one down, then drag to look around what you built.', entry: 'index.html' },
  { slug: 'chairs-in-space',        title: 'Chairs In Space!',       blurb: 'The chairs are pulled into a singularity. Slowly they form a planetoid. Tap to add a chair. Orbit the center and zoom.', entry: 'index.html' },
  { slug: 'pantry',                 title: 'Food Access Directory for Greater Cleveland',  blurb: 'A bilingual directory of food locations around Cleveland. Data source: Greater Cleveland Food Bank data. · Un directorio bilingüe de lugares de alimentos en el área de Cleveland. Fuente de datos: datos del Greater Cleveland Food Bank.', entry: 'index.html' },
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
