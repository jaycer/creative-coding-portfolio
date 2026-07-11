// Presentation pass for the Spiral Generator. The squares still accumulate in
// a plain 2D buffer (that history is the artwork and can't be recomputed per
// pixel); this shader just decides how that buffer reaches the screen:
//   - the slow whole-spiral rotation, done by inverse-rotating the sample point
//   - 3D motion: the buffer is treated as a plane in space and each pixel's
//     view ray is intersected with it, so the spiral can tilt like a galaxy
//   - bloom: a two-ring blur whose squared term halos only the bright arms
//   - chromatic aberration that grows toward the screen edges
//   - a gentle vignette to pull focus to the center
precision highp float;

uniform sampler2D uTex;   // square 2D accumulation buffer
uniform vec2 uResolution; // canvas size in px
uniform float uBufSize;   // buffer side length in px (window diagonal)
uniform float uAngle;     // current spin of the whole spiral, radians
uniform vec2 uTilt;       // plane tilt: x = pitch, y = yaw, radians (0,0 = flat)
uniform float uZoom;      // camera zoom, 1 = the flat-view framing
uniform vec2 uPan;        // camera offset across the plane, buffer px

// tilted-plane frame, computed once per fragment in setupPlane()
vec3 planeU, planeV, planeN;
float focal;

void setupPlane() {
  // eye at the origin, plane centered at (0,0,focal); with focal as both the
  // camera's focal length and the plane distance, zero tilt maps each screen
  // pixel to itself, so the flat view matches the old 2D pass exactly
  focal = 0.9 * min(uResolution.x, uResolution.y);
  float cx = cos(uTilt.x);
  float sx = sin(uTilt.x);
  float cy = cos(uTilt.y);
  float sy = sin(uTilt.y);
  // rotY(yaw) * rotX(pitch) applied to the plane's rest axes
  vec3 v0 = vec3(0.0, cx, sx);
  vec3 n0 = vec3(0.0, -sx, cx);
  planeU = vec3(cy, 0.0, -sy);
  planeV = vec3(sy * v0.z, v0.y, cy * v0.z);
  planeN = vec3(sy * n0.z, n0.y, cy * n0.z);
}

// map a screen-px offset from center onto the tilted, spinning plane
vec3 sampleBuf(vec2 p) {
  vec3 dir = vec3(p, focal);
  float t = focal * planeN.z / dot(dir, planeN);
  if (t <= 0.0) return vec3(0.0); // ray exits past the horizon
  vec3 hit = t * dir - vec3(0.0, 0.0, focal);
  // pan/zoom inside the spin rotation, so panning is stable while the
  // spiral turns and the spiral's center stays put on screen
  vec2 q = vec2(dot(hit, planeU), dot(hit, planeV)) / uZoom + uPan;
  float c = cos(uAngle);
  float s = sin(uAngle);
  vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vec2 uv = r / uBufSize + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  // dim with depth so the receding side reads as farther away
  return texture2D(uTex, uv).rgb / (1.0 + max(t - 1.0, 0.0) * 0.6);
}

void main() {
  setupPlane();
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
