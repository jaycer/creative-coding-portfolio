// Shader Particle System — rendering pass (true metaballs).
//
// All particle *physics* still runs in JS (faithfully ported from the original
// p5 sketch). Each frame the JS uploads every particle's position, radius,
// colour and intensity as uniform arrays; this fragment shader then draws the
// whole field on the GPU in a single full-screen pass.
//
// Unlike a plain additive blend, this is a real metaball field: every particle
// contributes a smooth scalar "blobbiness" with a soft tail (Wyvill-style
// (1 - q^2)^3 kernel out to an influence radius), the contributions are summed,
// and the *surface* is found by thresholding that field at an isovalue. Where
// two particles approach, their fields add and the iso-contour bulges across
// the gap — so the blobs visibly stretch toward and fuse into each other,
// then pull apart, instead of just brightening where they overlap.

#ifdef GL_ES
precision highp float;
#endif

// __MAX_PARTICLES__ is substituted at load time from MAX_PARTICLES in the JS,
// so the array size lives in exactly one place. (This file isn't compiled raw.)
#define MAX __MAX_PARTICLES__

uniform vec2 resolution;
uniform int  uCount;
uniform vec3 uParticles[MAX]; // xy = position (0..1, gl_FragCoord space), z = radius (height-normalised)
uniform vec4 uColors[MAX];    // rgb = colour, a = intensity
uniform vec3 uBg;             // background colour

// Tunables -----------------------------------------------------------------
const float INFLUENCE = 3.5;  // influence radius as a multiple of a particle's radius (bigger = more reach/merging)
const float ISO       = 0.65; // surface threshold on the summed field
const float EDGE      = 0.18; // half-width of the soft anti-aliased surface band
const float HALO      = 0.45; // strength of the faint sub-surface glow around the goo
// --------------------------------------------------------------------------

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  float aspect = resolution.x / resolution.y;

  float field = 0.0;       // summed metaball field at this pixel
  vec3  colAccum = vec3(0.0); // field-weighted colour

  for (int i = 0; i < MAX; i++) {
    if (i >= uCount) break;

    vec3 p = uParticles[i];
    vec4 c = uColors[i];

    vec2 d = uv - p.xy;
    d.x *= aspect;                       // keep the field circular regardless of canvas ratio

    float R = max(p.z, 0.0001) * INFLUENCE;
    float qq = dot(d, d) / (R * R);      // (dist / R)^2, no sqrt needed
    if (qq < 1.0) {
      float w = 1.0 - qq;
      w = w * w * w;                     // smooth (1 - q^2)^3 falloff, 0 at the influence edge
      field += w;
      colAccum += c.rgb * c.a * w;       // intensity-weighted colour contribution
    }
  }

  vec3 albedo = colAccum / max(field, 1e-4);

  // Surface: a soft step across the isovalue. Plus a faint halo just below the
  // threshold so the goo has a gentle glow rather than a hard cutout edge.
  float surf = smoothstep(ISO - EDGE, ISO + EDGE, field);
  float halo = smoothstep(ISO * 0.25, ISO, field) * (1.0 - surf);

  vec3 col = uBg + albedo * (surf + HALO * halo);
  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
}
