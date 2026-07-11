// ch4td1c3 — the whole dice tray in one full-screen pass.
//
// JS owns the layout, the roll animation (quaternions) and the RNG; every
// frame it uploads each die's center/radius, rotation and scale bounce as
// uniform arrays. This shader picks the nearest die per pixel and raymarches
// just that one polyhedron. Each SDF is a smooth-max over the solid's face
// planes, so edges come out beveled like molded plastic; every face carries a
// pink heart holding that face's number (glyphs from an atlas the JS draws
// into an offscreen canvas), stamped by projecting the hit point onto the
// face plane. Face values are fixed per solid, so the JS makes a roll "land"
// by rotating the face with the rolled value square to the camera, spun so
// its glyph reads upright.
//
// WebGL1 note: fragment shaders may only index uniform arrays with loop
// indices, so the nearest-die loop copies everything this pixel needs into
// plain locals (gRot*, gAnim, gType) before any of the heavy work runs.

#ifdef GL_ES
precision highp float;
#endif

const int NDICE = 7;

uniform vec2  resolution;
uniform vec3  uDie[NDICE];   // xy = center (gl_FragCoord px, y up), z = radius px
uniform vec4  uAnim[NDICE];  // y = scale bounce; x, z, w spare
uniform vec3  uRotA[NDICE];  // rows of the world->object rotation (= columns of object->world)
uniform vec3  uRotB[NDICE];
uniform vec3  uRotC[NDICE];
uniform vec3  uBody;         // theme: die body color
uniform vec3  uAccent;       // theme: heart color
uniform vec3  uNumCol;       // theme: number color
uniform float uGloss;        // specular exponent
uniform float uSpec;         // specular strength
uniform float uTransluc;     // 0 = solid resin .. 1 = seaglass
uniform sampler2D uAtlas;    // 8x4 grid of number glyphs (white on transparent)

// The pixel's die, copied out of the uniform arrays (see WebGL1 note above).
vec3 gRotA, gRotB, gRotC;
vec4 gAnim;
int  gType;   // 0 d4, 1 d6, 2 d8, 3 d10, 4 d% (same solid), 5 d12, 6 d20

const float BEV = 0.055;     // edge bevel radius (smooth-max k)
const float T3  = 0.5773503; // 1/sqrt(3)

float smax(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(a, b, h) + k * h * (1.0 - h);
}

// --- the seven solids (unit-ish size; inradius tuned so silhouettes match) --
// Convex polyhedra are just smooth-max over their face-plane distances.
// Antipodal face pairs share one |dot| term — opposite faces never meet, so
// the fold's crease lies far inside the solid and no edge loses its bevel.

float sdTetra(vec3 p) {
  float d =         dot(p, vec3( T3,  T3,  T3));
  d = smax(d, dot(p, vec3( T3, -T3, -T3)), BEV);
  d = smax(d, dot(p, vec3(-T3,  T3, -T3)), BEV);
  d = smax(d, dot(p, vec3(-T3, -T3,  T3)), BEV);
  return d - 0.40;
}

float sdCube(vec3 p) {
  vec3 a = abs(p);
  return smax(smax(a.x, a.y, BEV), a.z, BEV) - 0.60;
}

float sdOcta(vec3 p) {
  vec3 a = abs(p); // fold: the 8 faces are 4 antipodal pairs of (±1,±1,±1)/√3
  float d =         dot(a, vec3( T3,  T3,  T3));
  d = smax(d, dot(vec3(a.x, a.y, -a.z), vec3(T3, T3, T3)), BEV);
  d = smax(d, dot(vec3(a.x, -a.y, a.z), vec3(T3, T3, T3)), BEV);
  d = smax(d, dot(vec3(-a.x, a.y, a.z), vec3(T3, T3, T3)), BEV);
  return d - 0.62;
}

// Pentagonal trapezohedron: 10 kite faces = the vertex directions of a
// pentagonal antiprism (top ring az 0°+72°k, bottom ring offset 36°).
float sdD10(vec3 p) {
  float d =         dot(p, vec3( 0.848000,  0.53,  0.000000));
  d = smax(d, dot(p, vec3( 0.262046,  0.53,  0.806496)), BEV);
  d = smax(d, dot(p, vec3(-0.686046,  0.53,  0.498442)), BEV);
  d = smax(d, dot(p, vec3(-0.686046,  0.53, -0.498442)), BEV);
  d = smax(d, dot(p, vec3( 0.262046,  0.53, -0.806496)), BEV);
  d = smax(d, dot(p, vec3( 0.686046, -0.53,  0.498442)), BEV);
  d = smax(d, dot(p, vec3(-0.262046, -0.53,  0.806496)), BEV);
  d = smax(d, dot(p, vec3(-0.848000, -0.53,  0.000000)), BEV);
  d = smax(d, dot(p, vec3(-0.262046, -0.53, -0.806496)), BEV);
  d = smax(d, dot(p, vec3( 0.686046, -0.53, -0.498442)), BEV);
  return d - 0.55;
}

float sdDodeca(vec3 p) {
  float d =        abs(dot(p, vec3(0.0,       0.5257311,  0.8506508)));
  d = smax(d, abs(dot(p, vec3(0.0,       0.5257311, -0.8506508))), BEV);
  d = smax(d, abs(dot(p, vec3(0.5257311, 0.8506508,  0.0      ))), BEV);
  d = smax(d, abs(dot(p, vec3(0.5257311,-0.8506508,  0.0      ))), BEV);
  d = smax(d, abs(dot(p, vec3(0.8506508, 0.0,        0.5257311))), BEV);
  d = smax(d, abs(dot(p, vec3(0.8506508, 0.0,       -0.5257311))), BEV);
  return d - 0.82;
}

float sdIcosa(vec3 p) {
  float d =        abs(dot(p, vec3( T3,  T3,  T3)));
  d = smax(d, abs(dot(p, vec3( T3,  T3, -T3))), BEV);
  d = smax(d, abs(dot(p, vec3( T3, -T3,  T3))), BEV);
  d = smax(d, abs(dot(p, vec3( T3, -T3, -T3))), BEV);
  d = smax(d, abs(dot(p, vec3(0.0,        0.3568221,  0.9341724))), BEV);
  d = smax(d, abs(dot(p, vec3(0.0,        0.3568221, -0.9341724))), BEV);
  d = smax(d, abs(dot(p, vec3( 0.3568221, 0.9341724,  0.0      ))), BEV);
  d = smax(d, abs(dot(p, vec3(-0.3568221, 0.9341724,  0.0      ))), BEV);
  d = smax(d, abs(dot(p, vec3( 0.9341724, 0.0,        0.3568221))), BEV);
  d = smax(d, abs(dot(p, vec3( 0.9341724, 0.0,       -0.3568221))), BEV);
  return d - 0.80;
}

float sdDie(vec3 p) {
  if (gType == 0) return sdTetra(p);
  if (gType == 1) return sdCube(p);
  if (gType == 2) return sdOcta(p);
  if (gType == 3 || gType == 4) return sdD10(p);
  if (gType == 5) return sdDodeca(p);
  return sdIcosa(p);
}

// Heart size per solid, sized to sit inside one face.
float faceScale() {
  if (gType == 0) return 0.46;
  if (gType == 1) return 0.50;
  if (gType == 2) return 0.38;
  if (gType == 3 || gType == 4) return 0.34;
  if (gType == 5) return 0.46;
  return 0.27;
}

// --- exact face lookup -------------------------------------------------------
// After a hit, the face under the point is the plane with the largest dot.
// Face ids are fixed per solid (value = id + 1) and MUST match FACE_SETS in
// ch4td1c3.js — the JS uses the same ids to turn the rolled face frontside up.
vec3  gFN;  // face normal
float gFD;  // its plane distance
float gFI;  // its id

void consider(vec3 p, vec3 n, float i) {
  float d = dot(p, n);
  if (d > gFD) { gFD = d; gFN = n; gFI = i; }
}

float faceInfo(vec3 p) {
  gFD = -1e9;
  if (gType == 0) {
    consider(p, vec3( T3,  T3,  T3), 0.0);
    consider(p, vec3( T3, -T3, -T3), 1.0);
    consider(p, vec3(-T3,  T3, -T3), 2.0);
    consider(p, vec3(-T3, -T3,  T3), 3.0);
  } else if (gType == 1) {
    consider(p, vec3( 1.0, 0.0, 0.0), 0.0);
    consider(p, vec3(-1.0, 0.0, 0.0), 1.0);
    consider(p, vec3( 0.0, 1.0, 0.0), 2.0);
    consider(p, vec3( 0.0,-1.0, 0.0), 3.0);
    consider(p, vec3( 0.0, 0.0, 1.0), 4.0);
    consider(p, vec3( 0.0, 0.0,-1.0), 5.0);
  } else if (gType == 2) {
    consider(p, vec3( T3,  T3,  T3), 0.0);
    consider(p, vec3(-T3,  T3,  T3), 1.0);
    consider(p, vec3( T3, -T3,  T3), 2.0);
    consider(p, vec3(-T3, -T3,  T3), 3.0);
    consider(p, vec3( T3,  T3, -T3), 4.0);
    consider(p, vec3(-T3,  T3, -T3), 5.0);
    consider(p, vec3( T3, -T3, -T3), 6.0);
    consider(p, vec3(-T3, -T3, -T3), 7.0);
  } else if (gType == 3 || gType == 4) {
    consider(p, vec3( 0.848000,  0.53,  0.000000), 0.0);
    consider(p, vec3( 0.262046,  0.53,  0.806496), 1.0);
    consider(p, vec3(-0.686046,  0.53,  0.498442), 2.0);
    consider(p, vec3(-0.686046,  0.53, -0.498442), 3.0);
    consider(p, vec3( 0.262046,  0.53, -0.806496), 4.0);
    consider(p, vec3( 0.686046, -0.53,  0.498442), 5.0);
    consider(p, vec3(-0.262046, -0.53,  0.806496), 6.0);
    consider(p, vec3(-0.848000, -0.53,  0.000000), 7.0);
    consider(p, vec3(-0.262046, -0.53, -0.806496), 8.0);
    consider(p, vec3( 0.686046, -0.53, -0.498442), 9.0);
  } else if (gType == 5) {
    consider(p, vec3( 0.0,        0.5257311,  0.8506508),  0.0);
    consider(p, vec3( 0.0,       -0.5257311, -0.8506508),  1.0);
    consider(p, vec3( 0.0,        0.5257311, -0.8506508),  2.0);
    consider(p, vec3( 0.0,       -0.5257311,  0.8506508),  3.0);
    consider(p, vec3( 0.5257311,  0.8506508,  0.0),        4.0);
    consider(p, vec3(-0.5257311, -0.8506508,  0.0),        5.0);
    consider(p, vec3( 0.5257311, -0.8506508,  0.0),        6.0);
    consider(p, vec3(-0.5257311,  0.8506508,  0.0),        7.0);
    consider(p, vec3( 0.8506508,  0.0,        0.5257311),  8.0);
    consider(p, vec3(-0.8506508,  0.0,       -0.5257311),  9.0);
    consider(p, vec3( 0.8506508,  0.0,       -0.5257311), 10.0);
    consider(p, vec3(-0.8506508,  0.0,        0.5257311), 11.0);
  } else {
    consider(p, vec3( T3,  T3,  T3),  0.0);
    consider(p, vec3(-T3, -T3, -T3),  1.0);
    consider(p, vec3( T3,  T3, -T3),  2.0);
    consider(p, vec3(-T3, -T3,  T3),  3.0);
    consider(p, vec3( T3, -T3,  T3),  4.0);
    consider(p, vec3(-T3,  T3, -T3),  5.0);
    consider(p, vec3( T3, -T3, -T3),  6.0);
    consider(p, vec3(-T3,  T3,  T3),  7.0);
    consider(p, vec3( 0.0,        0.3568221,  0.9341724),  8.0);
    consider(p, vec3( 0.0,       -0.3568221, -0.9341724),  9.0);
    consider(p, vec3( 0.0,        0.3568221, -0.9341724), 10.0);
    consider(p, vec3( 0.0,       -0.3568221,  0.9341724), 11.0);
    consider(p, vec3( 0.3568221,  0.9341724,  0.0),       12.0);
    consider(p, vec3(-0.3568221, -0.9341724,  0.0),       13.0);
    consider(p, vec3(-0.3568221,  0.9341724,  0.0),       14.0);
    consider(p, vec3( 0.3568221, -0.9341724,  0.0),       15.0);
    consider(p, vec3( 0.9341724,  0.0,        0.3568221), 16.0);
    consider(p, vec3(-0.9341724,  0.0,       -0.3568221), 17.0);
    consider(p, vec3( 0.9341724,  0.0,       -0.3568221), 18.0);
    consider(p, vec3(-0.9341724,  0.0,        0.3568221), 19.0);
  }
  return gFI;
}

vec3 worldToObj(vec3 v) { return vec3(dot(gRotA, v), dot(gRotB, v), dot(gRotC, v)); }

float map(vec3 p) {
  float s = gAnim.y; // scale bounce (the little hop mid-roll)
  return sdDie(worldToObj(p) / s) * s;
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.018, 0.0); // largish eps softens shading over the bevels
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}

// --- decals -----------------------------------------------------------------
float dot2(vec2 v) { return dot(v, v); }

// iq's heart: tip at the origin, lobes up around y=1, |x| < ~0.55.
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0)
    return sqrt(dot2(p - vec2(0.25, 0.75))) - 0.3535534;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)),
                  dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}

// Decal frame on a face: tangent basis from its exact normal. The origin
// projects onto each face at the point the insphere touches, so face-plane
// coordinates around that projection center the decal for free. ch4td1c3.js
// replicates this basis exactly to land the rolled face upright — keep the
// two in sync.
vec2 faceUV(vec3 pObj, vec3 fn) {
  vec3 t1 = cross(fn, vec3(0.267, 0.923, 0.276)); // ref ∥ to no face normal
  if (dot(t1, t1) < 0.05) t1 = cross(fn, vec3(1.0, 0.0, 0.0));
  t1 = normalize(t1);
  vec3 t2 = cross(fn, t1);
  vec3 q3 = pObj - fn * dot(pObj, fn);
  return vec2(dot(q3, t1), dot(q3, t2));
}

// --- background: dim leather, a pool of light, soft shadow pads -------------
float hash12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i),                 hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec3 background(vec2 px) {
  vec2 uv = px / resolution;
  float n = vnoise(px * 0.55) * 0.6 + vnoise(px * 2.1) * 0.4; // leather grain
  vec3 col = mix(vec3(0.050, 0.046, 0.058), vec3(0.112, 0.104, 0.124), n * 0.6 + 0.2);
  col *= 1.18 - 0.62 * distance(uv, vec2(0.5, 0.58));
  return col;
}

void main() {
  vec2 px = gl_FragCoord.xy;

  // Nearest die wins the pixel; copy its uniforms into locals.
  float best = 1e9;
  vec3 die = vec3(0.0);
  for (int i = 0; i < NDICE; i++) {
    float d = distance(px, uDie[i].xy);
    if (d < best) {
      best = d;
      die = uDie[i];
      gRotA = uRotA[i]; gRotB = uRotB[i]; gRotC = uRotC[i];
      gAnim = uAnim[i];
      gType = i;
    }
  }

  vec3 bg = background(px);
  // Soft contact shadow, lighter while the die hops.
  vec2 sc = die.xy + vec2(0.0, -0.30 * die.z);
  float sd2 = length((px - sc) * vec2(1.0, 1.45)) / die.z;
  float sh = (1.0 - smoothstep(0.5, 1.2, sd2)) * 0.45;
  sh *= clamp(1.8 - 0.8 * gAnim.y, 0.4, 1.0);
  bg *= 1.0 - sh;

  if (best > die.z * 1.5) { gl_FragColor = vec4(bg, 1.0); return; }

  // Raymarch this die: little pinhole camera per tile, looking down -z.
  vec2 uv = (px - die.xy) / die.z;
  vec3 ro = vec3(0.0, 0.0, 3.0);
  vec3 rd = normalize(vec3(uv * 1.19, -3.0));

  float t = 1.5, minD = 1e9;
  bool hit = false;
  vec3 p = ro;
  for (int i = 0; i < 56; i++) {
    p = ro + rd * t;
    float d = map(p);
    minD = min(minD, d);
    if (d < 0.004) { hit = true; break; }
    t += d * 0.85; // smax overestimates a touch near bevels; understep
    if (t > 4.6) break;
  }

  if (!hit) {
    // near-miss fringe doubles as cheap silhouette AA
    float fringe = 1.0 - smoothstep(0.0, 3.0 / die.z, minD);
    gl_FragColor = vec4(mix(bg, uBody * 0.35, fringe * 0.85), 1.0);
    return;
  }

  vec3 nW = calcNormal(p);
  float scale = gAnim.y;
  vec3 pObj = worldToObj(p) / scale;

  // Which face is this, exactly? Every face carries its heart AND its number,
  // all the time, like a real die; JS rotates the rolled face to the front.
  float fid = faceInfo(pObj);
  vec3 fn = gFN;
  float cell = fid;                                  // value = id + 1
  if (gType == 4) cell = (fid == 9.0) ? 20.0 : 21.0 + fid; // d% shows tens, 00 last

  float s = faceScale();
  vec2 qf = faceUV(pObj, fn);
  float hSd = sdHeart(qf / s + vec2(0.0, 0.5));
  float aaH = 2.9 / die.z / s;
  float hm = 1.0 - smoothstep(-aaH, aaH, hSd);

  float numA = 0.0;
  vec2 nq = qf / (s * 1.45) + 0.5;
  if (nq.x > 0.0 && nq.x < 1.0 && nq.y > 0.0 && nq.y < 1.0) {
    vec2 c8 = vec2(mod(cell, 8.0), floor(cell / 8.0));
    numA = texture2D(uAtlas, (c8 + vec2(nq.x, 1.0 - nq.y)) / vec2(8.0, 4.0)).a;
  }

  // Lighting: key upper-left, a floor bounce, plastic specular, rim.
  vec3 L = normalize(vec3(-0.45, 0.62, 0.65));
  float dif = clamp(dot(nW, L) * 0.62 + 0.42, 0.0, 1.0);
  float bounce = clamp(dot(nW, vec3(0.5, -0.6, 0.35)), 0.0, 1.0) * 0.14;
  float light = 0.30 + 0.78 * dif + bounce;
  light = mix(light, light * 0.6 + 0.5, uTransluc); // resin scatters its shadows
  vec3 hv = normalize(L - rd);
  float spe = pow(clamp(dot(nW, hv), 0.0, 1.0), uGloss) * uSpec;
  vec3 hv2 = normalize(normalize(vec3(0.6, 0.15, 0.5)) - rd);
  spe += pow(clamp(dot(nW, hv2), 0.0, 1.0), uGloss * 0.6) * uSpec * 0.3;
  float fres = pow(1.0 - clamp(dot(nW, -rd), 0.0, 1.0), 3.0);

  float edgeDark = smoothstep(-0.12, -0.01, hSd); // engraved shadow at the rim
  vec3 heartCol = uAccent * (1.0 - 0.30 * edgeDark);
  vec3 albedo = mix(uBody, heartCol, hm);
  vec3 col = albedo * light + vec3(spe) + vec3(0.9) * fres * 0.12;
  col += uTransluc * uBody * fres * 0.9; // light leaking through seaglass edges
  col = mix(col, uNumCol * (0.35 + 0.65 * light), numA);

  gl_FragColor = vec4(col, 1.0);
}
