// Ambient Lumina — rendering pass (contrasting lumina).
//
// Derived from shader-particle-system's field renderer: each lumen contributes
// a smooth Wyvill-style (1 - q^2)^3 kernel (the classic "metaball" iso-surface
// technique — the algorithm's name, kept here as documentation), the
// contributions are summed, and the surface is found by thresholding that
// field at an isovalue — so the lumina still stretch toward and fuse into
// each other in *shape*.
//
// The color rule is different, though. Instead of intensity-weighted additive
// blending (overlaps brighten toward white), each lumen's color is folded
// into the accumulator with an exclusion blend:
//
//     out = a + b - 2ab        (per channel; commutative and associative)
//
// Exclusion behaves like a soft XOR: where a lumen stands alone it keeps its
// own color, but where two overlap their shared channels cancel — vividly
// different colors flip toward each other's complement, and two same-colored
// lumina carve a dark seam where they merge. Intersections *contrast* with the
// bodies instead of just glowing hotter.

#ifdef GL_ES
precision highp float;
#endif

// __MAX_PARTICLES__ is substituted at load time from MAX_PARTICLES in the JS,
// so the array size lives in exactly one place. (This file isn't compiled raw.)
#define MAX __MAX_PARTICLES__

uniform vec2 resolution;
uniform int  uCount;
uniform vec4  uParticles[MAX]; // xy = position (0..1, gl_FragCoord space), z = radius (height-normalized), w = elongation
uniform vec2  uRot[MAX];       // (cos, sin) of each particle's rotation, precomputed in JS
uniform vec4  uRipple[MAX];    // x = phase, y = ring spatial frequency, z = amplitude — the lumen's tone as pond ripples
uniform vec4  uColors[MAX];    // rgb = color, a = intensity
uniform vec3  uBg;             // background color

// Tunables -----------------------------------------------------------------
const float INFLUENCE = 3.5;  // influence radius as a multiple of a particle's radius (bigger = more reach/merging)
const float ISO       = 0.65; // surface threshold on the summed field
const float EDGE      = 0.18; // half-width of the soft anti-aliased surface band
const float HALO      = 0.45; // strength of the faint sub-surface glow around the lumina
// --------------------------------------------------------------------------

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  float aspect = resolution.x / resolution.y;

  float field = 0.0;      // summed lumina field at this pixel (drives the surface)
  vec3  colXor = vec3(0.0); // exclusion-accumulated color

  for (int i = 0; i < MAX; i++) {
    if (i >= uCount) break;

    vec4 p = uParticles[i];
    vec4 c = uColors[i];

    vec2 d = uv - p.xy;
    d.x *= aspect;                       // into a square (height-normalized) space, so rotation is uniform

    // Rotate into the particle's local frame, then scale each axis by its own
    // radius so the field is an oval. elong > 1 stretches one axis and squeezes
    // the other (area roughly preserved); the rotation makes it spin slowly.
    float ca = uRot[i].x;
    float sa = uRot[i].y;
    vec2 rd = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y);

    float base  = max(p.z, 0.0001) * INFLUENCE;
    float elong = max(p.w, 0.0001);
    vec2 radii  = vec2(base * elong, base / elong);
    rd /= radii;

    float qq = dot(rd, rd);              // squared distance in the oval's own space
    if (qq < 1.0) {
      float w = 1.0 - qq;
      w = w * w * w;                     // smooth (1 - q^2)^3 falloff, 0 at the influence edge

      // Pond ripple: concentric rings radiate from the lumen's center, driven
      // by its tone — the advancing phase pushes the rings outward at the
      // note's (scaled) frequency, ring spacing tightens with pitch, and depth
      // follows the voice's volume. Modulating the field makes the rings show
      // as bands in the glow and lets deep troughs carve visible rings into
      // the surface. Faded near the center so the ripples' source stays calm.
      float q = sqrt(qq);
      float ring = sin(uRipple[i].y * q - uRipple[i].x) * smoothstep(0.0, 0.15, q);
      w *= 1.0 + uRipple[i].z * ring;
      field += w;

      // This lumen's own coverage, eased so its color ramps in over the same
      // range the surface forms. src is bounded to [0,1], so the exclusion
      // result stays bounded too — no normalization pass needed.
      float cov = smoothstep(0.0, ISO, w);
      vec3 src = c.rgb * (c.a * cov);
      colXor = colXor + src - 2.0 * colXor * src;   // exclusion (soft XOR)
    }
  }

  // Surface: a soft step across the isovalue. Plus a faint halo just below the
  // threshold so the lumina have a gentle glow rather than a hard cutout edge.
  float surf = smoothstep(ISO - EDGE, ISO + EDGE, field);
  float halo = smoothstep(ISO * 0.25, ISO, field) * (1.0 - surf);

  vec3 col = uBg + colXor * (surf + HALO * halo);
  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
}
