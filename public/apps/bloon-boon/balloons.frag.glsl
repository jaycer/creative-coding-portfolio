// Bloon Boon — rendering pass.
//
// All game *physics* runs in JS (bloon-boon.js). Each frame the JS uploads
// every balloon's position, radius, color and jelly-squash as uniform arrays,
// packed far-to-near; this fragment shader draws the whole scene in one
// full-screen pass: a dim room, then each balloon as a fake-3D lit sphere with
// a little knot, composited back-to-front with the over operator.
//
// The "3D" is cheap but convincing: inside a balloon we reconstruct a sphere
// normal (z = sqrt(1 - x^2 - y^2)), light it with a fixed key light, add a
// glossy specular dot and a subsurface rim glow (latex is translucent), and
// darken the silhouette for roundness. No geometry, no depth buffer — just the
// balloon list looped per pixel, same shape as shader-particle-system.

#ifdef GL_ES
precision highp float;
#endif

// __MAX_BALLOONS__ is substituted at load time from BLOON_CONFIG.maxBalloons in
// the JS, so the array size lives in exactly one place. (Not compiled raw.)
#define MAX __MAX_BALLOONS__

uniform vec2 resolution;
uniform int  uCount;
uniform vec4 uBalloons[MAX]; // xy = center (0..1, gl_FragCoord uv, y up), z = radius (height-normalized), w = squash
uniform vec2 uRot[MAX];      // (cos, sin) of each balloon's rotation, precomputed in JS
uniform vec3 uColors[MAX];   // rgb balloon color

// Balloon silhouette shape.
const float BODY_ASPECT = 1.14; // taller than wide (1 = round)
const float BODY_W      = 0.80; // body half-width in radius units

// Lighting.
const vec3  KEY_DIR = vec3(-0.42, 0.72, 0.55); // key light: upper-left, toward viewer
const float AMBIENT = 0.26;

// Draw one balloon at this pixel. Returns rgb in .rgb and coverage in .a.
vec4 balloon(vec2 d, float radius, float squash, vec3 color, float aspect, vec2 rot) {
  d.x *= aspect;      // into square (height-normalized) space
  // Rotate into the balloon's own frame so its knot, egg-taper and sheen spin
  // with it. Light stays fixed in screen space, so you read the turn.
  d = vec2(rot.x * d.x + rot.y * d.y, -rot.y * d.x + rot.x * d.y);
  d /= radius;        // now in units of radius, y up

  // Jelly squash from a hit: squash > 1 stretches tall & thin, < 1 squats
  // wide & flat. Area is roughly preserved so volume reads constant.
  float halfH = BODY_ASPECT * BODY_W * squash;
  float halfW = BODY_W / squash;

  // Egg profile: a touch wider up top than an ellipse would be.
  float ey  = d.y / halfH;
  float egg = 1.0 + 0.10 * clamp(ey, -1.0, 1.0);
  float ex  = (d.x / halfW) / egg;
  float rr  = length(vec2(ex, ey));

  // Pixel-sized anti-alias band, constant in screen space across balloon sizes.
  float px   = (1.0 / resolution.y) / radius; // one pixel, in d-units
  float edge = 1.6 * px / halfH;              // in rr units
  float bodyA = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, rr);

  // --- knot: a small dark triangle hanging under the body ---
  float knotH = 0.17 * halfH;
  float knotW = 0.16 * halfW;
  float ky    = d.y - (-halfH * 0.98);        // origin at body bottom, y up
  float down  = clamp(-ky / knotH, 0.0, 1.0); // 0 at body, 1 at knot tip
  float allow = knotW * (1.0 - down * down);
  float knotA = (ky < 0.0 && ky > -knotH)
    ? (1.0 - smoothstep(allow - 1.2 * px, allow, abs(d.x))) : 0.0;
  knotA *= step(bodyA, 0.001); // knot only shows where the body doesn't

  if (bodyA + knotA < 0.002) return vec4(0.0);

  // --- shade the body as a sphere ---
  vec2  n2 = vec2(ex, ey);
  float z  = sqrt(max(0.0, 1.0 - dot(n2, n2)));
  vec3  N  = normalize(vec3(n2.x, n2.y, max(z, 1e-3)));
  vec3  L  = normalize(KEY_DIR);
  vec3  V  = vec3(0.0, 0.0, 1.0);
  vec3  H  = normalize(L + V);

  float diff = max(dot(N, L), 0.0);
  vec3  lit  = color * (AMBIENT + 0.95 * diff);

  // Glossy white specular dot near the top-left.
  float spec = pow(max(dot(N, H), 0.0), 46.0);

  // Subsurface / rim: latex glows where it's thin near the silhouette.
  float rim = pow(1.0 - N.z, 2.4);
  lit = mix(lit, color * 1.25, rim * 0.28);

  // Slight edge occlusion so the ball reads round, not flat.
  lit *= mix(1.0, 0.80, smoothstep(0.80, 1.0, rr));

  vec3 bodyCol = lit + spec * 0.85;

  // Knot sits in shadow — darker, desaturated toward the base color.
  vec3 knotCol = color * 0.42;

  vec3  col = bodyCol * bodyA + knotCol * knotA;
  float a   = max(bodyA, knotA);
  return vec4(col, a);
}

// Dim room background: wall gradient, a soft warm pool of light, a floor band,
// and a vignette. Kept dark so the balloons pop.
vec3 room(vec2 uv) {
  // Back wall, slightly lighter toward the top where light falls.
  vec3 col = mix(vec3(0.045, 0.045, 0.062), vec3(0.085, 0.088, 0.115),
                 smoothstep(0.0, 1.0, uv.y));

  // Soft pool of warm light, up and slightly left of center.
  float pool = distance(uv * vec2(resolution.x / resolution.y, 1.0),
                        vec2(0.46 * resolution.x / resolution.y, 0.68));
  col += vec3(0.10, 0.085, 0.075) * smoothstep(0.62, 0.0, pool);

  // Floor: a darker, slightly warmer band across the bottom with a faint sheen.
  float floorLine = 0.14;
  float onFloor   = smoothstep(floorLine + 0.02, floorLine - 0.02, uv.y);
  vec3  floorCol  = mix(vec3(0.05, 0.045, 0.05), vec3(0.02, 0.018, 0.022),
                        smoothstep(floorLine, 0.0, uv.y));
  floorCol += vec3(0.05, 0.045, 0.04) * smoothstep(0.14, 0.0, abs(uv.x - 0.5)) * onFloor;
  col = mix(col, floorCol, onFloor);

  // Vignette.
  float vig = smoothstep(1.15, 0.35, distance(uv, vec2(0.5, 0.5)));
  col *= mix(0.55, 1.0, vig);
  return col;
}

void main() {
  vec2  uv     = gl_FragCoord.xy / resolution.xy;
  float aspect = resolution.x / resolution.y;

  vec3 col = room(uv);

  // Painter's algorithm: balloons are packed far-to-near in JS, so drawing in
  // order with the over operator gives correct occlusion.
  for (int i = 0; i < MAX; i++) {
    if (i >= uCount) break;
    vec4 b = uBalloons[i];
    vec4 s = balloon(uv - b.xy, b.z, max(b.w, 0.05), uColors[i], aspect, uRot[i]);
    col = mix(col, s.rgb, s.a);
  }

  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
}
