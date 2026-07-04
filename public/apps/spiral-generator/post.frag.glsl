// Presentation pass for the Spiral Generator. The squares still accumulate in
// a plain 2D buffer (that history is the artwork and can't be recomputed per
// pixel); this shader just decides how that buffer reaches the screen:
//   - the slow whole-spiral rotation, done by inverse-rotating the sample point
//   - bloom: a two-ring blur whose squared term halos only the bright arms
//   - chromatic aberration that grows toward the screen edges
//   - a gentle vignette to pull focus to the center
precision highp float;

uniform sampler2D uTex;   // square 2D accumulation buffer
uniform vec2 uResolution; // canvas size in px
uniform float uBufSize;   // buffer side length in px (window diagonal)
uniform float uAngle;     // current spin of the whole spiral, radians

// map a screen-px offset from center into the (rotated) buffer
vec3 sampleBuf(vec2 p) {
  float c = cos(uAngle);
  float s = sin(uAngle);
  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  return texture2D(uTex, q / uBufSize + 0.5).rgb;
}

void main() {
  // px from screen center, y pointing down to match the 2D buffer's frame
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) - 0.5 * uResolution;
  float rNorm = length(p) / (0.5 * min(uResolution.x, uResolution.y));

  // chromatic aberration: split channels radially, stronger near the edges
  float ca = 1.0 + 0.006 * rNorm * rNorm;
  vec3 col;
  col.r = sampleBuf(p * ca).r;
  col.g = sampleBuf(p).g;
  col.b = sampleBuf(p / ca).b;

  // bloom: average two rings of taps around this pixel
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = 6.2831853 * float(i) / 8.0;
    vec2 d = vec2(cos(a), sin(a));
    glow += sampleBuf(p + d * 3.0);
    glow += sampleBuf(p + d * 8.0) * 0.5;
  }
  glow /= 12.0;
  col += glow * glow * 0.9 + glow * 0.2;

  col *= mix(1.0, 0.68, smoothstep(0.75, 1.45, rNorm));

  gl_FragColor = vec4(col, 1.0);
}
