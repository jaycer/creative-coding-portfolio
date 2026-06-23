// Shared configuration for the Shader Particle System.
//
// Single source of truth for values that have to agree between the JS
// simulation and the GLSL shader. `maxParticles` sets both the JS uniform
// buffer sizes and the shader's `uniform […MAX]` array length — the shader
// can't read a JS variable (its array size must be a compile-time constant),
// so the sketch injects this number into the shader source at load time
// (replacing the `__MAX_PARTICLES__` token in particles.frag.glsl).
//
// Loaded as a plain global before shader-particle-system.js (see index.html).
const SPS_CONFIG = {
  maxParticles: 100,
};
