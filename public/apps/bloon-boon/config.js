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

  // Difficulty ramp: spawn intervals shrink the longer a round lasts, so the
  // room fills faster and the game gets harder as you play. Over spawnRampSeconds
  // the interval scales from full down to spawnRampFloor of itself, then holds.
  spawnRampSeconds: 150,  // ~2.5 min to reach full difficulty
  spawnRampFloor: 0.3,    // late-game intervals are 30% of early ones (≈3–9s)

  // The palette. Each color is a distinct "voice" — its own synthesized sound
  // (see audio.js). `rgb` is 0..1 linear-ish color handed straight to the
  // shader. `name` doubles as the audio voice key.
  //
  // A mix of playful, non-balloon voices (bird call, car horn, slide whistle,
  // toy piano, glass bell, kazoo) so the room stays varied.
  palette: [
    { name: 'bird',   label: 'Bird call',    rgb: [0.30, 0.72, 1.00] }, // sky blue
    { name: 'horn',   label: 'Car horn',     rgb: [0.96, 0.24, 0.28] }, // red
    { name: 'slide',  label: 'Slide whistle', rgb: [0.36, 0.83, 0.44] }, // green
    { name: 'piano',  label: 'Toy piano',    rgb: [1.00, 0.82, 0.24] }, // yellow
    { name: 'bell',   label: 'Glass bell',   rgb: [0.74, 0.50, 1.00] }, // violet
    { name: 'kazoo',  label: 'Kazoo',        rgb: [1.00, 0.55, 0.18] }, // orange
  ],
};
