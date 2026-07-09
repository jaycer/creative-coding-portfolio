// Shared configuration for Bloon Boon.
//
// Single source of truth for values that must agree between the JS game
// (bloon-boon.js), the audio synth (audio.js) and the GLSL shader
// (balloons.frag.glsl). `maxBalloons` sizes both the JS uniform buffers and the
// shader's `uniform [...MAX]` array length — the shader can't read a JS value
// (its array length has to be a compile-time constant), so bloon-boon.js injects
// this number into the shader source at load time (replacing the
// `__MAX_BALLOONS__` token in balloons.frag.glsl).
//
// Loaded as a plain global before the other scripts (see index.html).
const BLOON_CONFIG = {
  // Hard cap on simultaneous balloons. Physics never spawns past this; it also
  // sets the GLSL array size, so keep it modest — every balloon is a loop
  // iteration per pixel.
  maxBalloons: 24,

  // Spawn cadence, in seconds. A new balloon arrives at a random interval in
  // this range. The very first ones come faster so the game isn't empty on
  // start (see firstSpawnsSeconds).
  spawnMinSeconds: 10,
  spawnMaxSeconds: 30,
  firstSpawnsSeconds: [1.0, 4.0, 8.0], // scripted opening so you start with a few

  // Difficulty ramp: spawn intervals shrink the longer a level lasts, so the
  // room fills faster and the game gets harder as you play. Over spawnRampSeconds
  // the interval scales from full down to spawnRampFloor of itself, then holds.
  // The ramp restarts each level; fall speed also steps up per level.
  spawnRampSeconds: 150,  // ~2.5 min to reach full difficulty
  spawnRampFloor: 0.3,    // late-game intervals are 30% of early ones (≈3–9s)

  // Fill the screen with `maxBalloons` to clear a level and advance. Each level
  // falls faster than the last (fall speed scales by 1 + (level-1)*levelFallStep)
  // and uses the next palette, cycling once you run past the list — so it's
  // endless and always has a "next".
  levelFallStep: 0.4,     // +40% fall speed per level

  // One 6-color palette per level (cycled). Each color is a distinct "voice" —
  // its own synthesized sound (see audio.js). `rgb` is 0..1 color handed to the
  // shader; `name` doubles as the audio voice key.
  palettes: [
    // Level 1 — playful acoustic-ish voices.
    [
      { name: 'bird',   label: 'Bird call',     rgb: [0.30, 0.72, 1.00] }, // sky blue
      { name: 'horn',   label: 'Car horn',      rgb: [0.96, 0.24, 0.28] }, // red
      { name: 'slide',  label: 'Slide whistle', rgb: [0.36, 0.83, 0.44] }, // green
      { name: 'piano',  label: 'Toy piano',     rgb: [1.00, 0.82, 0.24] }, // yellow
      { name: 'bell',   label: 'Glass bell',    rgb: [0.74, 0.50, 1.00] }, // violet
      { name: 'kazoo',  label: 'Kazoo',         rgb: [1.00, 0.55, 0.18] }, // orange
    ],
    // Level 2 — brighter, electronic/neon voices.
    [
      { name: 'zap',     label: 'Laser',   rgb: [0.16, 0.92, 0.92] }, // cyan
      { name: 'drop',    label: 'Droplet', rgb: [0.34, 0.48, 1.00] }, // electric blue
      { name: 'marimba', label: 'Marimba', rgb: [1.00, 0.68, 0.12] }, // amber
      { name: 'boop',    label: 'Bubble',  rgb: [1.00, 0.25, 0.76] }, // magenta
      { name: 'siren',   label: 'Siren',   rgb: [1.00, 0.40, 0.26] }, // coral
      { name: 'cowbell', label: 'Cowbell', rgb: [0.68, 1.00, 0.24] }, // lime
    ],
  ],
};
