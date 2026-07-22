// Chair Pile — chairs fall out of the dark and pile up forever.
//
// A tap or keypress drops another chair from a random point in a disc above
// the frame. The disc widens as the heap spreads, so the pile grows outward as
// well as up. The physics collider is built from the same boxes as the visible
// chair, so legs snag on slats and the pile interlocks.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as CANNON from 'cannon-es';
import { initAudio, resumeAudio, clatter, setMuted, isMuted, setTimbre, getTimbre } from './audio.js';

// Frozen chairs draw as instances and only the few dozen live ones are solved,
// so the cap is really about the broadphase, which sweeps every body forever.
// Measured on an M1 Max: flat 120fps past 1,500 chairs, ~40fps at 2,200.
const MAX_CHAIRS = 2000;

const DEMO_DROP_MS = 2000;     // demo's cadence, as it ships; the slider moves it
let demoDropMs = DEMO_DROP_MS;
const FREEZE_BEHIND = 25;      // chairs this far down the pile turn to static bedrock
// ...and this far down they freeze whether settled or not. Freezing runs in
// drop order off a single index, and the solver can leave a pinned chair
// jittering forever — never passing atRest, never falling asleep — which would
// block the queue and let the live set grow without bound (measured: stalled
// at 494 frozen, never recovered). A chair this deep cannot be seen, so
// snapping it still is invisible.
const FREEZE_FORCE_BEHIND = 60;
// The drop zone: a disc overhead, starting SPAWN_SPAN_CHAIRS wide and growing
// with the width the heap has reached, so the pile grows outward as well as up
// instead of building a spire. SPAWN_SPREAD must be high enough to engage
// early: chairs are all corners and barely roll, so at 0.7 the disc never grew
// at all.
const SPAWN_SPAN_CHAIRS = 10;  // how many chairs across the disc starts
const SPAWN_SPREAD = 0.9;      // share of the reached width the disc grows to fill
// Where the heap stops widening and starts climbing: at this radius 2,000
// chairs leave a heap about as tall as it is wide.
const SPAWN_RADIUS_MAX = 4.5;
const STRAY_MARGIN = 1.4;      // past the disc by this much and a chair has rolled away

// Chairs spawn above the top of the frame, computed per drop; this is only the
// floor under that, for when the camera is in so close that the frame top is
// lower than the heap.
const MIN_SKY_GAP = 3.2;       // least a chair may fall, over the top of the pile
const SKY_MARGIN = 1.3;        // clearance over the top of the frame

// A chair still high up casts almost no shadow, fading to full as it comes
// down. The shadow map is equally sharp at every height, and the 35-degree key
// throws a shadow ~1.4x the chair's height sideways — so a chair released
// above the frame would lay a hard chair-shaped shadow meters from where it
// lands, a second before it arrives. Fading cannot spread the shadow the way
// real penumbra would, but it removes the hard edge with nothing above it.
const SHADOW_FADE_FROM = 4.6;  // height over the heap where the shadow starts coming in
const SHADOW_FADE_TO = 1.1;    // and where it is full strength

// Desktop-class or not, decided once at load. It already gates the shadow-map
// size and the AO pass (see where the renderer is built); it also picks the
// soft-shadow tier below. Kept here, above the shadow constants and the shader
// chunk that bake it in, because both need it before the renderer exists.
const SHADOW_HQ = window.matchMedia('(pointer: fine)').matches;

// Soft-shadow budget, per tier. The penumbra widens with how far a caster sits
// above what it lands on (PCSS, see getShadow), up to SHADOW_MAX_BLUR — so a
// chair high in the pile throws a soft edge while a foot on the floor stays
// crisp (contact hardening). The ceiling and the tap counts are the whole cost
// knob: a wider ceiling needs more taps to stay smooth instead of banding, and
// every tap is a shadow-map fetch per shadowed fragment. Desktop (4096 map)
// gets the full treatment; phones (2048 map, fill-rate bound) get a lighter one
// that still hardens at contact but spends far fewer taps.
const SHADOW_MAX_BLUR = SHADOW_HQ ? 0.05 : 0.03; // meters, widest a shadow edge may spread
const SHADOW_RADIUS_MAX = SHADOW_HQ ? 28 : 12;   // blocker search cap, in texels
const PCSS_SEARCH_TAPS = SHADOW_HQ ? 24 : 12;    // taps that find the blocker + its distance
const PCSS_PCF_TAPS = SHADOW_HQ ? 32 : 16;       // taps that draw the penumbra gradient

// Contact darkening on the floor. Subtracting the shadow map's stored depth
// from the receiver's gives the gap between a chair and what its shadow lands
// on, in meters; darken hard at zero gap, fading out by CONTACT_GAP. Without
// it the sky fill reaches the floor at full strength right against a foot, and
// an even gray shadow under a chair reads as hovering. The floor gets it and
// the chairs do not: on them the gap changes too fast, and the nine-tap
// coverage stepped across the pile in visible bands.
// How fast a shadow softens as its caster lifts away, in blur-meters per meter
// of gap: at 0.15 an edge reaches the SHADOW_MAX_BLUR ceiling with the caster
// ~33cm off the surface (desktop), scaling smoothly from a single texel — hard
// — at contact. This is the contact-hardening curve; the tier only moves where
// it tops out.
const PCSS_SOFTNESS = 0.15;

const CONTACT_GAP = 0.12;      // meters of separation before it fades out entirely
const CONTACT_STRENGTH = 0.65; // how much of the light it takes away at zero gap

// Seam shading: a thin dark line where one chair part meets another. The
// members are only 50mm deep, so the key light legitimately skims past the
// back edge of one part and lands right at the foot of the next — and even a
// soft area light would leave that sliver sharp, because the occluding edge
// sits only centimeters away. What reads as a defect is the light touching
// the seam itself, so this pulls the joint line out of it: a narrow band,
// falling off with the square of distance so it stays a line rather than a
// smudge. Computed per fragment from the part list — no extra geometry, and
// identical for bedrock instances.
const JOINT_RADIUS = 0.012;    // meters the line reaches from a junction
const JOINT_STRENGTH = 0.3;    // how much of the light it takes away at the seam

// No tunneling guard, by choice. cannon has no continuous collision
// detection, and an uncapped chair covers ~14cm per 60Hz step against
// colliders 5.6cm thick, so a fast faller can occasionally pass through a
// member. A fall-speed cap plus finer stepping fixed that, but it slowed the
// falls and cost physics budget; the fast drop is worth the rare clip.
const REST_SPEED = 0.4;        // m/s under which a chair counts as come to rest
const MIN_FALL_TIME = 0.4;     // s of falling before a chair can be called landed
const HIT_MIN_SPEED = 0.7;     // m/s of impact under which a contact makes no sound
const HIT_COOLDOWN_MS = 70;    // one chair can only speak this often
const HIT_LOUD_SPEED = 5;      // impact speed that counts as a full-strength bang
const BUMP_LEVEL = 0.32;       // how loudly a chair already at rest answers when knocked

// Framing holds the heap's height and its width — a wide heap under a wide
// screen still runs out of frame sideways first. Both fits are computed and
// the camera takes whichever wants it further back.
const FOCUS_BIAS = 0.45;       // <0.5 sits the view low, giving the pile the frame
const FRAME_MARGIN = 1.2;
const PILE_AIR = 1.6;          // headroom over the heap, so a chair is seen falling before it lands
const EXPLORE_FRACTION = 0.8;  // closer than this share of the fit = exploring, so stop framing

// Demo mode: the camera orbits and breathes in and out on a slow sine while
// chairs drop themselves. The zoom is a share of the framing distance, not
// meters, so the composition holds as the pile grows.
const DEMO_ORBIT_SPEED = 0.55; // OrbitControls units: about one lap every two minutes
const DEMO_ZOOM_PERIOD = 26;   // seconds for one full breath in and back out
const DEMO_ZOOM_NEAR = 0.4;    // closest approach, as a share of the framing distance
const DEMO_ZOOM_FAR = 0.98;    // and the far end of the breath, just inside the fit

/** Barely moving — resting or being jostled, as opposed to falling. */
function atRest(body) {
  return body.velocity.lengthSquared() < REST_SPEED * REST_SPEED
    && body.angularVelocity.lengthSquared() < 1.0;
}

// ---------------------------------------------------------------- chair shape
// Parts of a plain four-leg dining chair, in meters, with y=0 at the floor.
// Both the mesh and the physics compound are generated from this one list.
const SEAT_W = 0.46, SEAT_D = 0.44, SEAT_T = 0.05, SEAT_Y = 0.44;
const LEG = 0.05, LEG_H = 0.44;
const BACK_H = 0.55;

// Butt joints put two coplanar faces at the same depth, and which one a pixel
// gets is float rounding. Only opposed normals show — a lit face fighting a
// dark one; two flush outer faces share a normal and material, so the fight
// draws the same pixel either way. So parts stay flush on the outside and are
// separated only along the axis they join on: each pushes JOIN inside the
// next, burying the end faces where they cannot be seen.
const JOIN = 0.004;
const LEG_X = SEAT_W / 2 - LEG / 2; // flush with the seat's sides
const LEG_Z = SEAT_D / 2 - LEG / 2;
const CHAIR_H = SEAT_Y + SEAT_T + BACK_H; // the silhouette the rail's top sets

const CHAIR_PARTS = [
  // seat
  { size: [SEAT_W, SEAT_T, SEAT_D], pos: [0, SEAT_Y + SEAT_T / 2, 0] },
  // front legs, standing on the floor and running up inside the seat
  { size: [LEG, LEG_H + JOIN, LEG], pos: [ LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
  { size: [LEG, LEG_H + JOIN, LEG], pos: [-LEG_X, (LEG_H + JOIN) / 2, LEG_Z] },
  // Back stiles: floor to top rail in one piece, passing through the seat —
  // one length of timber, with no coplanar joint at the seat to fight.
  { size: [LEG, CHAIR_H - JOIN, LEG], pos: [ LEG_X, (CHAIR_H - JOIN) / 2, -LEG_Z] },
  { size: [LEG, CHAIR_H - JOIN, LEG], pos: [-LEG_X, (CHAIR_H - JOIN) / 2, -LEG_Z] },
  // back slats, with gaps for legs to catch in; ends buried in the stiles
  { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.66, -LEG_Z] },
  { size: [SEAT_W - LEG * 2 + JOIN * 2, 0.07, LEG], pos: [0, 0.80, -LEG_Z] },
  // top rail, flush all round, swallowing the tops of the stiles
  { size: [SEAT_W, 0.07, LEG], pos: [0, CHAIR_H - 0.035, -LEG_Z] },
];

const CHAIR_TOP = CHAIR_H; // the parts list above needed this before it could be named
const CHAIR_MID = CHAIR_TOP / 2; // shift parts down by this so the body origin sits mid-chair

const PALETTE = [
  0xc98a45, // oak
  0x8f5a34, // walnut
  0xd6cbb4, // bone
  0x6f7d8c, // slate
  0xa8493f, // rust
  0x4f6b53, // sage
  0xc9ad4a, // mustard
  0xb8b3aa, // ash
];

/** One merged geometry, shared by every chair — the origin sits at mid-chair. */
function buildChairGeometry() {
  const boxes = CHAIR_PARTS.map((part) => {
    const geo = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
    geo.translate(part.pos[0], part.pos[1] - CHAIR_MID, part.pos[2]);
    return geo;
  });
  return mergeGeometries(boxes);
}

// Shared by every material that takes these terms, so the numbers can be set in
// one place and the ones that track the shadow camera refreshed once a frame.
const contactUniforms = {
  uContactGap: { value: CONTACT_GAP },
  uContactStrength: { value: CONTACT_STRENGTH },
  uShadowDepth: { value: 1 },   // far - near of the shadow camera, in meters
  uPcssSoftness: { value: PCSS_SOFTNESS },
  uPcssMaxBlur: { value: SHADOW_MAX_BLUR },
  uPcssTexel: { value: 0.002 }, // meters one shadow texel covers
  uJointRadius: { value: JOINT_RADIUS },
  uJointStrength: { value: JOINT_STRENGTH },
};

/**
 * GLSL for the seam line: one unrolled block per chair part. A part darkens a
 * fragment only when it pokes through the fragment's surface plane (h > 0) —
 * two flush coplanar faces have h = 0, so the chair's flat outsides never
 * show a line — and only within uJointRadius. The squared falloff
 * concentrates the darkness at the seam; the h ramp keeps a part that barely
 * crosses the plane from popping in.
 */
const JOINT_SHADE_CHUNK = `
uniform float uJointRadius;
uniform float uJointStrength;
varying vec3 vChairPos;
varying vec3 vChairNormal;

float jointShade() {
  vec3 n = normalize( vChairNormal );
  vec3 p = vChairPos;
  float shade = 0.0;
${CHAIR_PARTS.map(({ size, pos }) => {
    const c = [pos[0], pos[1] - CHAIR_MID, pos[2]];
    const lo = c.map((v, i) => (v - size[i] / 2).toFixed(4)).join(', ');
    const hi = c.map((v, i) => (v + size[i] / 2).toFixed(4)).join(', ');
    return `  {
    vec3 bmin = vec3( ${lo} );
    vec3 bmax = vec3( ${hi} );
    float h = dot( n, mix( bmin, bmax, step( vec3( 0.0 ), n ) ) ) - dot( n, p );
    if ( h > 0.002 ) {
      vec3 q = max( max( bmin - p, p - bmax ), vec3( 0.0 ) );
      float w = 1.0 - smoothstep( 0.0, uJointRadius, length( q ) );
      shade = max( shade, w * w * clamp( h / 0.01, 0.0, 1.0 ) );
    }
  }`;
  }).join('\n')}
  return 1.0 - uJointStrength * shade;
}
`;

// three's own shadow chunk with getShadow renamed out of the way so ours can
// take the name; lifting it at runtime keeps everything else in it — varyings,
// point and spot paths, packing — exactly as three wrote it.
const PCSS_SHADOW_CHUNK = THREE.ShaderChunk.shadowmap_pars_fragment.replace(
  'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {',
  'float getShadowUnused( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {'
) + `
uniform float uPcssSoftness;
uniform float uPcssMaxBlur;
uniform float uPcssTexel;
uniform float uShadowDepth;

// Interleaved gradient noise, as used for the falling chairs' dither: two
// instructions and it scatters evenly at pixel scale.
float chairShadowNoise( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

/**
 * Percentage-closer soft shadows: find what is casting, and let its distance
 * set the filter width. A caster touching the surface gets a single texel —
 * hard; one well above it gets the full blur. (The fixed-width filter this
 * replaced blurred contacts that should be hard, and banded.) Both loops walk
 * a Vogel disk, rotated per pixel so the residual quantization reads as faint
 * noise instead of rings.
 */
float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  shadowCoord.xyz /= shadowCoord.w;
  shadowCoord.z += shadowBias;

  bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0
                && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
  if ( ! ( inFrustum && shadowCoord.z <= 1.0 ) ) return 1.0;

  vec2 texel = vec2( 1.0 ) / shadowMapSize;
  float maxR = max( shadowRadius, 1.0 );
  float rot = chairShadowNoise( gl_FragCoord.xy ) * 6.2831853;

  // Receiver-plane depth bias. A face lying nearly along the light has a
  // depth slope so steep that a constant bias cannot cover it — one texel to
  // the side is millimeters deeper, and the face self-shadows in texel-sized
  // dashes. The screen-space derivatives give the receiver's true depth
  // gradient in light space, so each tap can be compared against the plane's
  // own depth at that offset: grazing faces get exactly the bias their slope
  // demands, face-on surfaces get none, and contact shadows stay put. The
  // clamp keeps the extrapolation sane across silhouettes, where the
  // derivatives jump between surfaces.
  vec3 dpx = dFdx( shadowCoord.xyz );
  vec3 dpy = dFdy( shadowCoord.xyz );
  float det = dpx.x * dpy.y - dpx.y * dpy.x;
  vec2 grad = abs( det ) > 1e-16
    ? vec2( dpy.y * dpx.z - dpx.y * dpy.z, dpx.x * dpy.z - dpy.x * dpx.z ) / det
    : vec2( 0.0 );
  float maxAdj = 0.02 / uShadowDepth; // never extrapolate more than 2cm of depth
  #define CHAIR_Z_AT( off ) ( shadowCoord.z + clamp( dot( grad, off ), -maxAdj, maxAdj ) )

  // 1. What is above this point, and how far up? Search the widest penumbra we
  // would ever draw. The first tap must land on the fragment's own texel
  // (fi = 0 is the disk center): near a contact the shadow band is only
  // millimeters wide while this search is the widest penumbra, so a ring that
  // starts off-center can step clean over the band, find nothing, and take the
  // early-out below — returning fully lit along the inside of every corner.
  float sum = 0.0;
  float hits = 0.0;
  for ( int i = 0; i < ${PCSS_SEARCH_TAPS}; i ++ ) {
    float fi = float( i );
    float a = fi * 2.39996323 + rot;
    vec2 off = vec2( cos( a ), sin( a ) ) * sqrt( fi / ${(PCSS_SEARCH_TAPS - 1).toFixed(1)} ) * maxR * texel; // fi = 0 lands dead centre
    float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + off ) );
    if ( d < CHAIR_Z_AT( off ) ) { sum += d; hits += 1.0; }
  }
  // No blocker within the widest penumbra: lit. A shadow narrower than the
  // center texel is narrower than this map can draw.
  if ( hits < 0.5 ) return 1.0;

  // 2. The gap, in meters, sets the width. Floor it at a texel so a contact is
  // as hard as this map can draw rather than blurring into a gap.
  float gap = ( shadowCoord.z - sum / hits ) * uShadowDepth;
  float blur = clamp( gap * uPcssSoftness, uPcssTexel, uPcssMaxBlur );
  // Floored at ~2 texels, not 1: with the whole kernel inside a single texel
  // every pixel reads that texel's binary answer and a shadow edge shows the
  // map's raw staircase — at 2 texels the rotated taps straddle edges and
  // average them into noise. Costs ~4mm of extra softness at a contact.
  float pen = max( blur / uPcssTexel, 1.75 );

  // 3. Ordinary PCF, at that width, with enough taps to read as a gradient.
  float lit = 0.0;
  for ( int i = 0; i < ${PCSS_PCF_TAPS}; i ++ ) {
    float fi = float( i );
    float a = fi * 2.39996323 + rot;
    vec2 off = vec2( cos( a ), sin( a ) ) * sqrt( ( fi + 0.5 ) / ${PCSS_PCF_TAPS.toFixed(1)} ) * pen * texel;
    float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + off ) );
    lit += ( d < CHAIR_Z_AT( off ) ) ? 0.0 : 1.0;
  }
  return lit / ${PCSS_PCF_TAPS.toFixed(1)};
}
`;

/**
 * Wire the shadow terms into a material: PCSS for everything, plus the
 * floor's contact term. The shadow camera is orthographic, so a difference of
 * stored depths is a distance in meters once multiplied by the camera's
 * range; a lit surface reads its own depth back and finds no blocker, so the
 * contact term darkens nothing there.
 */
function tuneShadows(material, { contact = false, joints = false } = {}) {
  material.onBeforeCompile = (shader) => {
    for (const name of Object.keys(contactUniforms)) shader.uniforms[name] = contactUniforms[name];
    // Everything shadowed gets the soft-shadow filter; the chairs take the
    // seam line on top of it, and the floor the contact term.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <shadowmap_pars_fragment>', PCSS_SHADOW_CHUNK);
    if (joints) {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `
          varying vec3 vChairPos;
          varying vec3 vChairNormal;
          void main() {`)
        // The raw attributes, before the instance matrix: jointShade works in
        // chair-local space, which every chair and bedrock instance shares.
        .replace('#include <begin_vertex>', `
          vChairPos = position;
          vChairNormal = normal;
          #include <begin_vertex>`);
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', JOINT_SHADE_CHUNK + '\nvoid main() {')
        // Before tone mapping, so it darkens in linear light.
        .replace('#include <tonemapping_fragment>', `
          gl_FragColor.rgb *= jointShade();
          #include <tonemapping_fragment>`);
    }
    if (!contact) return;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `
        uniform float uContactGap;
        uniform float uContactStrength;
        void main() {`)
      // Before tone mapping, so the darkening happens in linear light rather
      // than on top of an already-curved color.
      .replace('#include <tonemapping_fragment>', `
        #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
        {
          vec3 sco = vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w;
          if ( sco.x >= 0.0 && sco.x <= 1.0 && sco.y >= 0.0 && sco.y <= 1.0 && sco.z <= 1.0 ) {
            // Taps as wide as the shadow filter: narrower, and this term is
            // sharper than the shadow it sits on, which turns the falling
            // chairs' dithered depth into stripes.
            vec2 t = directionalLightShadows[ 0 ].shadowRadius / directionalLightShadows[ 0 ].shadowMapSize;
            // 4mm, which keeps a surface from finding itself as its own blocker
            float eps = 0.004 / uShadowDepth;
            float sum = 0.0;
            float n = 0.0;
            for ( int i = -1; i <= 1; i ++ ) {
              for ( int j = -1; j <= 1; j ++ ) {
                vec2 uv = sco.xy + vec2( float( i ), float( j ) ) * t;
                float d = unpackRGBAToDepth( texture2D( directionalShadowMap[ 0 ], uv ) );
                if ( d < sco.z - eps ) { sum += d; n += 1.0; }
              }
            }
            if ( n > 0.0 ) {
              float gap = ( sco.z - sum / n ) * uShadowDepth;
              float near = 1.0 - smoothstep( 0.0, uContactGap, gap );
              // Scale by how much of the neighborhood is blocked: a
              // half-dithered chair darkens half as much, and there is no
              // threshold for the dither to flicker across.
              float cover = n / 9.0;
              gl_FragColor.rgb *= 1.0 - uContactStrength * near * cover;
            }
          }
        }
        #endif
        #include <tonemapping_fragment>`);
  };
  // The variants must not collide: each combination is its own program.
  material.customProgramCacheKey = () =>
    (contact ? 'chair-shadow-floor' : joints ? 'chair-shadow-joints' : 'chair-shadow');
}

// Colliders are padded because cannon settles contacts ~2mm inside each other,
// and two visible boxes overlapping draw a crisp lit sliver of one chair
// inside another. The padding spends that overlap on empty space: the wood
// stops just short of touching, which at this size still reads as contact.
const COLLIDER_SKIN = 0.003;

/** The matching compound collider: one cannon Box per visible box. */
function addChairShapes(body) {
  for (const part of CHAIR_PARTS) {
    const half = new CANNON.Vec3(
      part.size[0] / 2 + COLLIDER_SKIN,
      part.size[1] / 2 + COLLIDER_SKIN,
      part.size[2] / 2 + COLLIDER_SKIN);
    const offset = new CANNON.Vec3(part.pos[0], part.pos[1] - CHAIR_MID, part.pos[2]);
    body.addShape(new CANNON.Box(half), offset);
  }
}

// -------------------------------------------------------------------- scene
// Cool near-black. The fog matches it exactly so the floor dissolves into the
// background instead of ending at a line.
const VOID = 0x070b14;

// Fog is measured from the camera, and the framing pulls back as the pile
// grows, so any fixed density would eventually swallow the pile. Hold the haze
// on the pile constant instead: density = FOG_HAZE / dist keeps the pile at
// the same slight remove (about 15%) at any framing distance.
const FOG_HAZE = 0.4;
const FOG_HOLD = 8; // stop thickening inside this: zoomed among the chairs, fog must not close in
const scene = new THREE.Scene();
scene.background = new THREE.Color(VOID);
scene.fog = new THREE.FogExp2(VOID, FOG_HAZE / FOG_HOLD);

// A near plane this close lets the camera push right through a chair without the
// surfaces clipping out early — see the zoom-through note on controls.minDistance.
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.03, 200);
camera.position.set(2.9, 2.1, 4.0);

// Same tier that picked the soft-shadow budget up top gates the 4096 shadow map
// and the ambient-occlusion pass below.
const fineShadows = SHADOW_HQ;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// Plain PCF rather than PCFSoft: PCFSoft's kernel is a fixed couple of texels
// and takes no radius, while PCF spreads its taps over shadow.radius, which
// aimKey sets from the texel size. (Superseded in practice by the PCSS chunk,
// which replaces getShadow; the radius still feeds its search width.)
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

// Ambient occlusion (desktop only): the scene's fills — ambient, hemisphere,
// and the fill light — ignore geometry, so without this every crevice gets
// full skylight and the joints read hot; the seams where light really does
// graze past a member's back edge stand out as leaks against surroundings
// that are wrongly bright. GTAO darkens by actual concavity, per pixel, and
// covers chair-to-chair contacts as well as joints within one chair.
// Tone mapping moves to the OutputPass; materials render linear into the
// composer's target, so the contact term above still runs in linear light.
let composer = null;
let gtao = null;
if (fineShadows) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // The composer bypasses the canvas's own antialiasing, so the target needs
  // its own MSAA.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, size.x, size.y);
  // Radius on the scale of a chair member, not a room, and thickness well
  // under one: the members are 50mm sticks, and the defaults assume meters of
  // solid wall — they turn thin slats into deep caves.
  gtao.updateGtaoMaterial({ radius: 0.15, thickness: 0.05, distanceExponent: 2, scale: 1.5 });
  gtao.blendIntensity = 0.9;
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
}

// AO runs at half resolution: occlusion is low-frequency and the denoise pass
// smooths the upsampling, so nothing visible is lost — but the cost falls to
// a quarter. Measured on an M1 Max at retina 2x with a 30-chair pile: 28.6fps
// with full-res AO, 119.9 at half, indistinguishable from AO off entirely.
// Called after every composer.setSize, which resets the pass to full size.
function sizeGtao() {
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  gtao.setSize(Math.ceil(s.x / 2), Math.ceil(s.y / 2));
}
if (gtao) sizeGtao();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 1.2, 0);
// Zoom right in among the chairs and out the far side: the orbit center sits in
// the heap, so an almost-zero minimum lets the camera travel through it. Pan
// (right-drag or two-finger) moves that center, so the whole pile is explorable
// from the inside.
controls.minDistance = 0.05;
controls.maxDistance = 60; // headroom for auto-framing to pull back from a tall pile
controls.maxPolarAngle = Math.PI / 2 - 0.04; // stay above the floor
// Demo mode's orbit. Off until asked for; controls.update() already runs every
// frame, which is all autoRotate needs, and dragging still overrides it.
controls.autoRotate = false;
controls.autoRotateSpeed = DEMO_ORBIT_SPEED;

// Lit from above, softly: a wide key light plus cool sky bounce, no hard sun.
scene.add(new THREE.AmbientLight(0x9fb4c8, 0.29));
scene.add(new THREE.HemisphereLight(0x9fb4c8, 0x15171d, 0.65));

// A directional light is only a direction — position aims it and places its
// shadow camera. The direction is set once and never turned: a source reads as
// fixed in the world only if orbiting past it changes which face is lit.
// aimKey rides the light up with the pile by moving light and target together.
// 35 degrees up, ~90 degrees around from the starting camera: low enough to
// give every chair a bright side and a dark one, off to the side so the
// shadows rake across the floor in view.
const KEY_DIR = new THREE.Vector3(10, 8.5, -7).normalize(); // pile toward light
const KEY_STANDOFF = 22; // how far back it rides, on top of the pile's own height

// Light this low strikes seats and floor at a glance; the intensity makes back
// what the cosine falloff costs the flat faces.
const key = new THREE.DirectionalLight(0xfff1dd, 3.0);
key.castShadow = true;
// A 4096 map is 64MB of depth texture: worth it on a desktop GPU, not on a
// phone that is already paying for the physics. Touch devices keep the 2048.
key.shadow.mapSize.set(fineShadows ? 4096 : 2048, fineShadows ? 4096 : 2048);
// Both biases are tiny on purpose. normalBias offsets the receiving surface
// along its normal, and at this light angle every millimeter walks the shadow
// edge ~1.4mm back toward its caster — enough of it and a chair unsticks from
// its own shadow, and with PCSS's hard contacts the walk-back no longer hides
// in a soft gradient. The fitted, tight depth range (see aimKey) is what makes
// values this small acne-free.
// Startup values only: aimKey re-derives the constant bias in meters each
// time the frustum refits. bias is a share of the depth range, so left as a
// bare constant it would grow with the pile — ~3mm of shadow walk-back on a
// small heap became ~5mm at 2,000 chairs, and the shadows visibly detached
// from the members casting them. normalBias stays small: the receiver-plane
// bias in getShadow covers grazing surfaces, which is what this was once
// raised for.
key.shadow.bias = -0.00025;
key.shadow.normalBias = 0.0005;
scene.add(key);
scene.add(key.target);

// Half the chair's own diagonal: how far its corners can reach from the body
// origin whatever way up it has landed, which is the margin every measured
// radius below needs before it can be called a bound on the geometry.
const CHAIR_REACH = Math.hypot(SEAT_W, SEAT_D, CHAIR_TOP) / 2;

let shadowSpan = -1;

// The shadow camera's own axes, which are fixed because KEY_DIR is. Three aims
// the shadow camera with lookAt against a (0,1,0) up, so its basis is fully
// determined by the light direction — worth precomputing, since aimKey needs to
// measure the aim point against it every frame.
const LIGHT_Z = KEY_DIR.clone(); // target toward light, i.e. the camera's +Z
const LIGHT_X = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), LIGHT_Z).normalize();
const LIGHT_Y = new THREE.Vector3().crossVectors(LIGHT_Z, LIGHT_X).normalize();
const aimPoint = new THREE.Vector3();

// How much of a world axis each light-space axis picks up. LIGHT_X is horizontal
// by construction — it is the cross of world up with the light — so only Y and Z
// mix height with ground distance, and these are the only two numbers the fit
// below needs.
const LY_FLAT = Math.hypot(LIGHT_Y.x, LIGHT_Y.z), LY_UP = LIGHT_Y.y;
const LZ_FLAT = Math.hypot(LIGHT_Z.x, LIGHT_Z.z), LZ_UP = LIGHT_Z.y;

/**
 * Ride the light up with the pile without ever turning it: both ends move by
 * the same vector, so the direction survives however tall the heap gets.
 */
function aimKey() {
  // Fit the box to what casts. The floor needs no room of its own: an
  // orthographic shadow camera looks along the light, so a caster and the
  // shadow it throws share the same light-space xy. What casts: everything
  // settled out to the widest counted chair, the drop disc, a chair's own
  // reach, and height up to where a falling chair's shadow has fully faded.
  const reach = Math.max(strayLimit(), castRadius) + CHAIR_REACH;
  const top = castTopY + SHADOW_FADE_FROM;

  // That region in light space: x is horizontal, y mixes radius with height
  // and is centered half way up. The box stays square so the texel — and the
  // filter kernel — stays round.
  const span = Math.max(reach, reach * LY_FLAT + LY_UP * top / 2);
  if (Math.abs(span - shadowSpan) > 0.25) { // resizing every frame rebuilds the matrix for nothing
    shadowSpan = span;
    const cam = key.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    // Near/far must bracket, in light-Z, not just the casters but the whole
    // floor the frustum sees — that is where the shadows land. The frustum is
    // ±span in light-Y, and the flat floor tilts through light space so its far
    // edge sits at light-Z ≈ (LY_UP/LZ_UP)·span; a tall pile pushes span past
    // reach, so sizing the depth to reach alone clips the cast shadow along a
    // hard line. Take whichever reaches deeper — floor edge or caster spread —
    // about the aim at top/2, plus a little slack.
    const deep = LZ_UP * top / 2 + Math.max(reach * LZ_FLAT, (LY_UP / LZ_UP) * span) + 0.5;
    cam.near = Math.max(0.1, KEY_STANDOFF + castTopY - deep);
    cam.far = KEY_STANDOFF + castTopY + deep;
    cam.updateProjectionMatrix();

    // Set the blocker-search radius from SHADOW_MAX_BLUR in the world, not a
    // fixed number of texels, so the widest penumbra stays the same real width
    // as the pile grows and the frustum with it. Capped at SHADOW_RADIUS_MAX:
    // the search must reach as far as the widest edge we will draw, or a soft
    // edge finds no blocker past the search and snaps back to hard.
    key.shadow.radius = THREE.MathUtils.clamp(SHADOW_MAX_BLUR / ((2 * span) / key.shadow.mapSize.width), 1, SHADOW_RADIUS_MAX);
    // The contact term reads depths out of this same camera, so it needs the
    // range to turn them back into meters.
    contactUniforms.uShadowDepth.value = cam.far - cam.near;
    contactUniforms.uPcssTexel.value = (2 * span) / key.shadow.mapSize.width;
    // Hold the bias at 3mm whatever the pile has grown to; see the note where
    // the startup value is set.
    key.shadow.bias = -0.003 / (cam.far - cam.near);
  }

  // Texel snapping. The map's grid is fixed in light space, and pileTopY keeps
  // approaching its target by ever-smaller amounts, so an unquantized aim
  // slides every edge across texels and the staircase ripples. Snapping the
  // aim to whole texels keeps each edge in the same texels frame after frame.
  // Aim half way up the casters — the center the span was measured about.
  const texel = (2 * shadowSpan) / key.shadow.mapSize.width;
  aimPoint.set(0, top / 2, 0);
  const x = Math.round(aimPoint.dot(LIGHT_X) / texel) * texel;
  const y = Math.round(aimPoint.dot(LIGHT_Y) / texel) * texel;
  const z = aimPoint.dot(LIGHT_Z); // depth along the light, no grid to fall off

  key.target.position.copy(LIGHT_X).multiplyScalar(x)
    .addScaledVector(LIGHT_Y, y)
    .addScaledVector(LIGHT_Z, z);
  key.target.updateMatrixWorld();
  key.position.copy(key.target.position).addScaledVector(KEY_DIR, KEY_STANDOFF + castTopY);
}

// Opposite the key, low and weak: keeps the dark side from going flat black.
// It says how deep the shadow is, not where the light comes from. Cool against
// the key's warmth, and casts nothing.
const fill = new THREE.DirectionalLight(0x8fa6c4, 0.3);
fill.position.set(-9, 4.5, 6);
scene.add(fill);

/**
 * A tileable value-noise texture for the floor, drawn at runtime. Near white
 * and low contrast — it multiplies the floor color and reads as unevenness in
 * the concrete. Octaves are coarse: the smallest features span several
 * chair-widths.
 */
function makeFloorTexture() {
  const SIZE = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(SIZE, SIZE);

  // Each octave is a lattice of random values that wraps, so the whole tile does.
  const octave = (cells) => {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
    return (x, y) => {
      const fx = x * cells, fy = y * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty); // smoothstep
      const at = (cx, cy) => grid[(cy % cells) * cells + (cx % cells)];
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    };
  };

  const layers = [[octave(3), 0.55], [octave(6), 0.28], [octave(12), 0.17]];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let n = 0;
      for (const [sample, weight] of layers) n += sample(x / SIZE, y / SIZE) * weight;
      // Spread around the mean: summing octaves clusters n tightly about 0.5,
      // and scaling the raw range instead would leave almost no variation.
      const shade = Math.min(1, Math.max(0, 0.9 + (n - 0.5) * 0.3));
      const v = Math.round(255 * shade);
      const i = (y * SIZE + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  // ~10 units per tile. Larger and the patch of floor around the pile is less
  // than one tile wide, and the mottling flattens into a plain gradient.
  texture.repeat.set(60, 60);
  // Enough to keep the mottling from smearing near the horizon; 16x costs real
  // sampling time on a floor this big for no visible gain.
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

const floorTexture = makeFloorTexture();
// Two triangles, so the size is free — and it has to outrun the fog, which
// thins as the camera pulls back. A plane ending inside the visible range
// shows its edge as a hard line against the void.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshStandardMaterial({
    color: 0x5a636e, // cooler, bluer gray
    roughness: 0.94,
    metalness: 0.02,
    map: floorTexture,
    roughnessMap: floorTexture, // same mottling varies the sheen under the spot
  })
);
floor.rotation.x = -Math.PI / 2;
// Drawn a few millimeters over the plane the chairs land on, so every foot
// stands slightly into the ground. A foot resting exactly on the plane meets
// it along a hairline where every small shadow error shows as a bright seam;
// sunk, the junction is an intersection and the error is below the floor. The
// physics plane stays at zero, so the simulation is untouched.
floor.position.y = 0.010;
tuneShadows(floor.material, { contact: true });
floor.receiveShadow = true;
scene.add(floor);

// Keep the floor out of the ambient-occlusion pass. A flat, empty ground plane
// has nothing to occlude it, but screen-space AO reads its grazing recession
// toward the horizon as false occlusion — a broad wash across the floor that
// tracks the camera rather than the geometry. Its real contact darkening comes
// from the PCSS contact term above, not here. GTAO hides points and lines for
// its depth/normal prepass via overrideVisibility(); extend that to hide the
// floor too, so the prepass sees only the chairs. restoreVisibility() cached
// the floor as visible before this ran, so the beauty pass still draws it.
if (gtao) {
  const passOverrideVisibility = gtao.overrideVisibility.bind(gtao);
  gtao.overrideVisibility = () => { passOverrideVisibility(); floor.visible = false; };
}

// ------------------------------------------------------------------ physics
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.solver.iterations = 14;
world.solver.tolerance = 0.002;

const chairMat = new CANNON.Material('chair');
const floorMat = new CANNON.Material('floor');
// High friction, near-zero bounce: chairs grab and settle, not skate away.
// Contacts are stiff for a visual reason: a contact is a spring, and the
// softer it is the further two boxes sink into each other — and an
// intersection of two boxes draws a crisp lit sliver of one chair inside
// another. See COLLIDER_SKIN, which spends the remaining overlap on padding.
const CONTACT_SPRING = { contactEquationStiffness: 1e8, contactEquationRelaxation: 3 };
world.addContactMaterial(new CANNON.ContactMaterial(chairMat, chairMat, { friction: 0.6, restitution: 0.03, ...CONTACT_SPRING }));
world.addContactMaterial(new CANNON.ContactMaterial(chairMat, floorMat, { friction: 0.7, restitution: 0.02, ...CONTACT_SPRING }));

const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: floorMat });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

// -------------------------------------------------------------------- chairs
const chairGeometry = buildChairGeometry();
const materials = PALETTE.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.04 }));
materials.forEach((m) => tuneShadows(m, { joints: true }));

const chairs = [];     // every dropped chair, in drop order
let freezeIdx = 0;     // chairs before this index are already frozen
let pileTopY = 0;
let pileRadius = 0;    // how wide the heap has reached, which is what widens the drop zone
let frozenTopY = 0;    // tallest frozen chair — fixed forever, so measured once
let frozenRadius = 0;  // and the widest, likewise
// The framing above deliberately ignores strays — a chair that rolled clear must
// not haul the camera or the drop zone out after it. But the shadow still has to
// COVER those strays, or its cast is cropped at the frustum edge (a hard straight
// line on the floor). So the shadow frustum is sized from these, which count
// every chair; grow-only, so a toppling chair never shrinks the cover.
let castTopY = 0;
let castRadius = 0;
let frozenCastTopY = 0;   // frozen contribution to the above, folded in once, strays included
let frozenCastRadius = 0;
let dropped = 0;
let lastDropAt = 0;    // demo's clock: it drops when this is old enough

const countEl = document.getElementById('count');

const _pan = new THREE.Vector3();

/** Frozen chairs are bedrock: welded in place, with their velocity zeroed. */
function isFrozen(chair) {
  return chair.body.type === CANNON.Body.STATIC;
}

/** Turn a physics contact into a knock, if it's worth hearing. */
function onCollide(chair, event) {
  // Bedrock cannot move, so there is nothing to hear — and this caps the
  // racket, since every chair ever dropped stays in the world.
  if (isFrozen(chair)) return;

  const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
  if (speed < HIT_MIN_SPEED) return; // a nudge, not a knock

  // An eight-box chair makes several contacts per landing, and a resting chair
  // keeps generating them; one knock per chair per cooldown collapses both
  // into the single sound the eye expects.
  const now = performance.now();
  if (now - chair.lastHitAt < HIT_COOLDOWN_MS) return;
  chair.lastHitAt = now;

  // Both chairs in a hit answer, and the fall decides the level: the arriving
  // chair is still falling, so it makes the knock at full strength; the chairs
  // it lands on have come to rest and answer under it, quietly, each in its
  // own voice and place in the stereo field.
  const level = chair.landed ? BUMP_LEVEL : 1;

  // Pan by where the chair sits across the current view rather than in world
  // space: the camera orbits, so world x has nothing to do with left and right.
  _pan.copy(chair.body.position);
  camera.worldToLocal(_pan);
  clatter(
    (speed / HIT_LOUD_SPEED) * level,
    chair.pitch,
    THREE.MathUtils.clamp(_pan.x / 3, -1, 1) * 0.7,
    _pan.length() // range from the camera, for distance depth
  );
}

/**
 * The depth material for the shadow pass, with one addition: it can discard a
 * share of its fragments and so cast a partial shadow. Dithered rather than
 * blended because a shadow map has no place for a half-shadow; the filter that
 * softens every edge averages the surviving fragments back into gray. Every
 * chair gets its own so each can fade alone, but the cache key is fixed so
 * they all share one compiled program.
 */
function makeShadowFader() {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.userData.fade = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFade = material.userData.fade;
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      `uniform float uFade;
       float chairDither(vec2 p) {
         return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
       }
       void main() {
         if (chairDither(gl_FragCoord.xy) >= uFade) discard;`
    );
  };
  material.customProgramCacheKey = () => 'chair-shadow-fade';
  return material;
}

/** How solid this chair's shadow should be, from how far it still has to fall. */
function shadowFade(chair) {
  const above = chair.body.position.y - pileTopY;
  return THREE.MathUtils.clamp(
    (SHADOW_FADE_FROM - above) / (SHADOW_FADE_FROM - SHADOW_FADE_TO), 0, 1);
}

function makeChair() {
  // Kept as an index: when the chair freezes, its color becomes an instance
  // value rather than a material reference.
  const tint = Math.floor(Math.random() * PALETTE.length);
  const mesh = new THREE.Mesh(chairGeometry, materials[tint]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = makeShadowFader(); // dropped again when it freezes
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 2.2, material: chairMat });
  addChairShapes(body);
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.12;
  body.sleepTimeLimit = 0.6;
  body.linearDamping = 0.05;
  body.angularDamping = 0.1;
  body.isChair = true;

  const chair = {
    mesh,            // dropped when it freezes: the instance carries it from then on
    tint,
    body,
    landed: false,   // has it come to rest since being dropped: pile, not rain
    fallTime: 0,
    pitch: 0.82 + Math.random() * 0.46, // its own voice, for every hit it takes
    lastHitAt: 0,
  };
  body.addEventListener('collide', (event) => onCollide(chair, event));
  return chair;
}

/** How wide the drop zone is: ten chairs, or the share of the heap it has reached. */
function spawnRadius() {
  const base = (SEAT_W * SPAWN_SPAN_CHAIRS) / 2;
  return Math.min(SPAWN_RADIUS_MAX, Math.max(base, pileRadius * SPAWN_SPREAD));
}

/** Past here a chair has rolled clear, and counts toward neither the height nor the width. */
function strayLimit() {
  return spawnRadius() + STRAY_MARGIN;
}

/**
 * How high a chair starts: out of sight, above the top of the frame. Worked
 * out from the camera because the frame keeps moving; a fixed height over the
 * pile would hang chairs in plain sight at one zoom and bury them at another.
 * MIN_SKY_GAP covers the case where the frame top is below the heap.
 */
function skyHeight() {
  const dist = camera.position.distanceTo(controls.target);
  const halfTall = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const frameTop = controls.target.y + halfTall;
  return Math.max(frameTop + SKY_MARGIN, pileTopY + MIN_SKY_GAP);
}

/** Send one down out of the dark. */
function dropChair() {
  if (chairs.length >= MAX_CHAIRS) return; // the heap is as big as it is allowed to get
  lastDropAt = performance.now();

  const chair = makeChair();

  // Uniform over the disc, not the radius: without the square root the middle
  // gets crowded and the drop column quietly comes back.
  const angle = Math.random() * Math.PI * 2;
  const r = spawnRadius() * Math.sqrt(Math.random());
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  const y = skyHeight();

  chair.body.position.set(x, y, z);
  chair.body.quaternion.setFromEuler(
    (Math.random() - 0.5) * 1.0,
    Math.random() * Math.PI * 2,
    (Math.random() - 0.5) * 1.0
  );
  chair.body.angularVelocity.set(
    (Math.random() - 0.5) * 0.7,
    (Math.random() - 0.5) * 0.7,
    (Math.random() - 0.5) * 0.7
  );
  // The mesh is driven off the body every frame from here; this is only so its
  // first frame is not at the origin.
  chair.mesh.position.set(x, y, z);
  chair.mesh.quaternion.copy(chair.body.quaternion);

  world.addBody(chair.body);
  chairs.push(chair);

  dropped += 1;
  countEl.textContent = dropped === 1 ? '1 chair' : `${dropped} chairs`;
}

// ------------------------------------------------------------------ bedrock
// Every frozen chair, drawn in one call. A mesh of its own costs two draw
// calls a frame forever (shadow map and scene), and at ~2,200 chairs that was
// 4,355 calls and ~50ms a frame of pure submission. A frozen chair is one
// transform, written once and never touched — exactly what an InstancedMesh
// asks for — so bedrock stays a single call however deep it gets.
const BEDROCK_CHUNK = 256; // instances to allocate at a time; doubles from here

// One material for all of it, white because the palette lives in each
// instance's own color and three multiplies the two.
const bedrockMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68, metalness: 0.04 });
tuneShadows(bedrockMaterial, { joints: true });

let bedrock = null;
let bedrockCount = 0;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();
const _color = new THREE.Color();

/**
 * Make sure there is room for one more, growing by doubling. An InstancedMesh
 * takes its capacity at construction and cannot be resized, so growing means
 * building a new one and copying the old buffers straight across — cheap, and
 * rare, since the count doubles every time.
 */
function reserveBedrock(need) {
  if (bedrock && need <= bedrock.instanceMatrix.count) return;

  let capacity = bedrock ? bedrock.instanceMatrix.count * 2 : BEDROCK_CHUNK;
  while (capacity < need) capacity *= 2;

  const next = new THREE.InstancedMesh(chairGeometry, bedrockMaterial, capacity);
  next.castShadow = true;
  next.receiveShadow = true;
  next.instanceMatrix.setUsage(THREE.StaticDrawUsage); // written once and left alone
  // Culled as a single object, and its instances are the whole pile: the bounding
  // sphere would have to cover all of them anyway, so testing it only costs.
  next.frustumCulled = false;
  // instanceColor is allocated lazily on the first setColorAt, and the copy below
  // needs it to exist already.
  next.setColorAt(0, _color.setHex(0xffffff));

  if (bedrock) {
    next.instanceMatrix.array.set(bedrock.instanceMatrix.array);
    next.instanceColor.array.set(bedrock.instanceColor.array);
    scene.remove(bedrock);
    bedrock.dispose(); // the instance buffers only; geometry and material are shared
  }
  next.count = bedrockCount;
  bedrock = next;
  scene.add(bedrock);
}

/** Hand a chair's mesh over to bedrock: its transform becomes one instance. */
function addToBedrock(chair) {
  reserveBedrock(bedrockCount + 1);

  // Composed from the body, not the mesh: the mesh can be a frame stale, and
  // nothing will ever update this transform again.
  _pos.copy(chair.body.position);
  _quat.copy(chair.body.quaternion);
  _mat.compose(_pos, _quat, _one);
  bedrock.setMatrixAt(bedrockCount, _mat);
  bedrock.setColorAt(bedrockCount, _color.setHex(PALETTE[chair.tint]));
  bedrockCount++;
  bedrock.count = bedrockCount;
  bedrock.instanceMatrix.needsUpdate = true;
  bedrock.instanceColor.needsUpdate = true;

  scene.remove(chair.mesh);
  // Bedrock never fades, so the fader goes with the mesh.
  chair.mesh.customDepthMaterial.dispose();
  chair.mesh = null; // it is an instance now, and nothing may reach for it again
}

/**
 * Settled chairs deep in the pile become static. Prefers chairs actually at
 * rest — tested directly, not via the engine's sleep state, since chairs this
 * deep are knocked awake by every landing above. Past FREEZE_FORCE_BEHIND it
 * takes them regardless; see that constant for why.
 */
function freezeSettled() {
  while (chairs.length - freezeIdx > FREEZE_BEHIND) {
    const chair = chairs[freezeIdx];
    const buried = chairs.length - freezeIdx > FREEZE_FORCE_BEHIND;
    if (!buried && (!chair.landed || !atRest(chair.body))) break; // still moving; try again later
    freezeIdx++;
    chair.body.type = CANNON.Body.STATIC;
    chair.body.mass = 0;
    chair.body.updateMassProperties();
    chair.body.velocity.setZero();
    chair.body.angularVelocity.setZero();
    // Fold its height and its reach in now: a frozen chair can never move, so the
    // per-frame scan below never has to look at it again.
    const reach = Math.hypot(chair.body.position.x, chair.body.position.z);
    if (reach <= strayLimit()) {
      frozenTopY = Math.max(frozenTopY, chair.body.position.y + CHAIR_MID);
      frozenRadius = Math.max(frozenRadius, reach);
    }
    // The shadow cover counts strays too, so it folds in every frozen chair.
    frozenCastTopY = Math.max(frozenCastTopY, chair.body.position.y + CHAIR_MID);
    frozenCastRadius = Math.max(frozenCastRadius, reach);
    addToBedrock(chair); // after the body is settled and pinned: this reads its final transform
  }
}

// -------------------------------------------------------------------- input
// OrbitControls owns dragging, so only a short, still, primary-button pointerup
// counts as a tap. Right and middle are its pan and dolly gestures, and each
// pointer is tracked by id so a second finger can't be mistaken for the first.
const downs = new Map();

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // pan/dolly gestures are not taps
  downs.set(e.pointerId, { at: performance.now(), x: e.clientX, y: e.clientY });
});

renderer.domElement.addEventListener('pointerup', (e) => {
  initAudio(); // a completed gesture: the one moment the context may be created
  const down = downs.get(e.pointerId);
  if (!down) return;
  downs.delete(e.pointerId);
  if (downs.size > 0) return; // part of a multi-touch gesture, not a tap
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  if (moved < 6 && performance.now() - down.at < 400) dropChair();
});

renderer.domElement.addEventListener('pointercancel', (e) => downs.delete(e.pointerId));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Tab') return;                                  // leave keyboard nav alone
  if (menuOpen) {
    if (e.key === 'Escape') closeMenu({ toButton: true });
    return; // no chair drops while the settings are up, whatever is focused
  }
  if (e.target.closest && e.target.closest('a, button')) return; // let the Gallery link work
  initAudio();
  dropChair();
});

// Safari suspends the context when the tab goes away and only wakes on request.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resumeAudio();
});

// ---------------------------------------------------------------- settings
// The hamburger opens a centered overlay. Its scrim covers the canvas, so the
// click that dismisses it is swallowed there rather than dropping a chair, and
// the keydown handler above stands down for as long as the overlay is up.
const menuBtn = document.getElementById('menu-btn');
const scrim = document.getElementById('scrim');
const soundToggle = document.getElementById('sound-toggle');
const demoToggle = document.getElementById('demo-toggle');
const doneBtn = document.getElementById('done-btn');
const howEl = document.getElementById('how');
const timbreEl = document.getElementById('timbre');
const spawnEl = document.getElementById('spawn');
const spawnValEl = document.getElementById('spawn-val');
const rateEl = document.getElementById('rate'); // the drop rate, shown only while demo is on

let menuOpen = false;
let openedFromButton = false;
let demo = false;

const TIMBRE_KEY = 'chair-pile-timbre'; // which knock they settled on, kept for next time

/**
 * fromButton: a real click opened this, so audio may be created (it needs a
 * genuine gesture, and the greeting on load is not one) and focus may return
 * to the button on the way out.
 */
function openMenu({ fromButton }) {
  menuOpen = true;
  openedFromButton = fromButton;
  scrim.hidden = false;
  document.body.classList.add('menu-open'); // hold the header against the idle fade
  menuBtn.setAttribute('aria-expanded', 'true');
  if (fromButton) initAudio();
}

/**
 * Close, and put focus somewhere the page still works from: a focused button
 * would swallow the any-key drop, so blur for the pointer and hand focus back
 * to the hamburger for the keyboard — but only if that is where they came
 * from; the greeting on load came from nowhere.
 */
function closeMenu({ toButton }) {
  menuOpen = false;
  scrim.hidden = true;
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
  // Every way out of here is a real gesture, so this is the earliest the audio
  // context may be built — and with demo shipping on, the first chair lands
  // moments after this returns.
  initAudio();
  if (toButton && openedFromButton) menuBtn.focus();
  else if (document.activeElement) document.activeElement.blur();
}

menuBtn.addEventListener('click', (e) => {
  // detail 0 is a keyboard activation: only then does focus belong on the
  // button afterwards. A mouse click that lands there wants it back on the page.
  if (menuOpen) closeMenu({ toButton: e.detail === 0 });
  else openMenu({ fromButton: true });
});

// The scrim swallows clicks so they cannot reach the canvas, but it is not a
// dismissal: the overlay closes only from its own buttons (or Escape).

doneBtn.addEventListener('click', (e) => closeMenu({ toButton: e.detail === 0 }));
document.getElementById('close-btn')
  .addEventListener('click', (e) => closeMenu({ toButton: e.detail === 0 }));

soundToggle.checked = !isMuted();
soundToggle.addEventListener('change', () => {
  setMuted(!soundToggle.checked);
  initAudio(); // the click behind this change is a gesture too
});

// The checkbox is the source of truth, markup included — syncing off it rather
// than assigning a default here means the shipped setting lives in one place.
function syncDemo() {
  demo = demoToggle.checked;
  howEl.hidden = demo;   // nothing to tell them to do while it plays itself
  rateEl.hidden = !demo; // and nothing for the rate to mean while it is off
}
syncDemo(); // ships on: the piece should be playing before anyone touches it

demoToggle.addEventListener('change', () => {
  syncDemo();
  initAudio(); // demo drops chairs with nothing else to unlock the audio
});

/**
 * Demo holds off — chairs and camera both — until the overlay is out of the
 * way: the first chair down is the one worth seeing.
 */
function demoRunning() {
  return demo && !menuOpen;
}

// Deliberately not remembered between visits (the knock is): coming back to
// chairs already falling faster than they can land is a fright.
spawnEl.addEventListener('input', () => {
  const seconds = Number(spawnEl.value);
  demoDropMs = seconds * 1000;
  spawnValEl.textContent = `${seconds.toFixed(1)}s`;
});
// Show taps: a faint ring blooms at each pointer press, for screen recording.
// Borrowed from Bloon Boon; the ring styling lives in the CSS. Off by default,
// remembered across visits.
const TAPS_KEY = 'chair-pile-show-taps';
const tapsToggle = document.getElementById('taps-toggle');
const ripplesEl = document.getElementById('ripples');
let showTaps = false;
try { showTaps = localStorage.getItem(TAPS_KEY) === '1'; } catch { /* storage off */ }
tapsToggle.checked = showTaps;
tapsToggle.addEventListener('change', () => {
  showTaps = tapsToggle.checked;
  try { localStorage.setItem(TAPS_KEY, showTaps ? '1' : '0'); } catch { /* nothing to do */ }
});

function spawnRipple(x, y) {
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.left = x + 'px';
  r.style.top = y + 'px';
  ripplesEl.appendChild(r);
  const done = () => r.remove();
  r.addEventListener('animationend', done);
  setTimeout(done, 700); // fallback if animationend never fires
}
// Capture phase, on window, so it marks every press — canvas, header, or sheet.
window.addEventListener('pointerdown', (e) => {
  if (showTaps) spawnRipple(e.clientX, e.clientY);
}, true);

function paintTimbre() {
  for (const btn of timbreEl.querySelectorAll('.choice-btn')) {
    const on = btn.dataset.timbre === getTimbre();
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

// setTimbre ignores a name it does not know, so a stale or hand-edited value
// here leaves the default standing rather than breaking the sound.
try {
  const saved = localStorage.getItem(TIMBRE_KEY);
  if (saved) setTimbre(saved);
} catch { /* storage off: the default stands */ }
paintTimbre();

timbreEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.choice-btn');
  if (!btn) return;
  setTimbre(btn.dataset.timbre);
  try { localStorage.setItem(TIMBRE_KEY, getTimbre()); } catch { /* nothing to do */ }
  paintTimbre();
  initAudio(); // a click is a gesture, which is the only way the preview can sound
  clatter(0.85, 1, 0); // hear the choice now, rather than waiting for a chair to land
});

// ------------------------------------------------------------ scene fixtures
// A scene is the pile plus the camera, and nothing else: the key light is a
// fixed direction and everything about the shadow camera derives from the
// pile, so chairs and camera reproduce the whole image. Loading rebuilds the
// chairs welded still — an exact scene to look at, not a simulation to
// continue — which is what makes run-to-run comparison possible.

/** The pile and camera as a plain object, small enough to save as JSON. */
function sceneSnapshot() {
  const round = (n) => Math.round(n * 10000) / 10000;
  return {
    v: 1,
    chairs: chairs.map((c) => {
      const p = c.body.position, q = c.body.quaternion;
      return [round(p.x), round(p.y), round(p.z), round(q.x), round(q.y), round(q.z), round(q.w), c.tint];
    }),
    camera: {
      p: camera.position.toArray().map(round),
      t: controls.target.toArray().map(round),
      fov: camera.fov,
    },
  };
}

/** Remove every chair, live and bedrock, leaving an empty floor. */
function clearPile() {
  for (const chair of chairs) {
    world.removeBody(chair.body);
    if (chair.mesh) {
      scene.remove(chair.mesh);
      chair.mesh.customDepthMaterial.dispose();
    }
  }
  chairs.length = 0;
  freezeIdx = 0;
  if (bedrock) {
    scene.remove(bedrock);
    bedrock.dispose();
    bedrock = null;
  }
  bedrockCount = 0;
  frozenTopY = 0;
  frozenRadius = 0;
  frozenCastTopY = 0;
  frozenCastRadius = 0;
  castTopY = 0;
  castRadius = 0;
  pileTopY = 0;
  pileRadius = 0;
  dropped = 0;
  countEl.textContent = '0 chairs';
}

/** Rebuild a saved scene exactly: every chair static at its saved pose. */
function loadSceneSnapshot(data) {
  if (!data || data.v !== 1 || !Array.isArray(data.chairs)) return false;
  clearPile();
  for (const row of data.chairs) {
    const [px, py, pz, qx, qy, qz, qw, tint] = row;
    const chair = makeChair();
    chair.tint = tint >= 0 && tint < PALETTE.length ? Math.floor(tint) : 0;
    chair.mesh.material = materials[chair.tint];
    chair.body.position.set(px, py, pz);
    chair.body.quaternion.set(qx, qy, qz, qw);
    chair.body.type = CANNON.Body.STATIC;
    chair.body.mass = 0;
    chair.body.updateMassProperties();
    chair.landed = true;
    chair.mesh.position.copy(chair.body.position);
    chair.mesh.quaternion.copy(chair.body.quaternion);
    world.addBody(chair.body);
    chairs.push(chair);
  }
  dropped = chairs.length;
  countEl.textContent = dropped === 1 ? '1 chair' : `${dropped} chairs`;

  // Measure the loaded pile so the framing and the shadow fit start right,
  // and pin the framing to it so nothing moves on the first frame.
  for (const c of chairs) {
    const reach = Math.hypot(c.body.position.x, c.body.position.z);
    pileTopY = Math.max(pileTopY, c.body.position.y + CHAIR_MID);
    pileRadius = Math.max(pileRadius, reach);
    castTopY = Math.max(castTopY, c.body.position.y + CHAIR_MID);
    castRadius = Math.max(castRadius, reach);
  }
  framedTop = pileTopY;
  framedWide = pileRadius;
  if (data.camera) {
    camera.position.fromArray(data.camera.p);
    controls.target.fromArray(data.camera.t);
    camera.fov = data.camera.fov || 50;
    camera.updateProjectionMatrix();
    camFocusY = controls.target.y;
    wantDist = camera.position.distanceTo(controls.target);
  }
  return true;
}

// Date + time stamp for download names, matching the other sub-apps
// (sleep-noise, u17sv): YYYYMMDD-HHMM, so repeated saves never collide.
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

document.getElementById('save-scene').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(sceneSnapshot())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chair-pile-scene-${chairs.length}-${fileStamp()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

const sceneFile = document.getElementById('scene-file');
document.getElementById('load-scene').addEventListener('click', () => sceneFile.click());
sceneFile.addEventListener('change', async () => {
  const file = sceneFile.files[0];
  sceneFile.value = ''; // the same file must be loadable twice in a row
  if (!file) return;
  try {
    loadSceneSnapshot(JSON.parse(await file.text()));
  } catch { /* not a scene file: leave the pile as it is */ }
});

// Open over an empty floor, every time: nothing falls, and demo mode holds,
// until the card is out of the way.
openMenu({ fromButton: false });

// --------------------------------------------------------------------- loop
const clock = new THREE.Clock();
let camFocusY = 1.2;
let framedTop = -1;                                    // pile height the framing was last fit to
let framedWide = -1;                                   // and the width, which grows on its own now
let wantDist = camera.position.distanceTo(controls.target);
const _dir = new THREE.Vector3();

// Whether the viewer has taken themselves in among the chairs — the one case
// where the framing must not pull back. Decided only when they stop touching
// the controls: read live, a camera lagging the growing fit is
// indistinguishable from one driven in close, and the framing would give up
// exactly when the heap grows fastest.
let viewerZoomed = false;
controls.addEventListener('end', () => {
  viewerZoomed = camera.position.distanceTo(controls.target) < wantDist * EXPLORE_FRACTION;
});

/**
 * Keep the heap in frame as it grows taller and wider. Only re-fits on real
 * growth, only ever pulls back — so orbiting is never fought — and stands
 * down once the viewer has deliberately zoomed in among the chairs.
 */
function frame(dt, t) {
  const spanTop = pileTopY + PILE_AIR;
  const spanWide = (pileRadius + STRAY_MARGIN) * 2;
  if (pileTopY > framedTop + 0.05 || pileRadius > framedWide + 0.05) {
    framedTop = pileTopY;
    framedWide = pileRadius;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    // On a wide screen the width is nearly free; on a tall one it decides.
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const needTall = (spanTop * 0.5) / Math.tan(vFov / 2) * FRAME_MARGIN;
    const needWide = (spanWide * 0.5) / Math.tan(hFov / 2) * FRAME_MARGIN;
    wantDist = Math.max(wantDist, needTall, needWide);
  }

  _dir.subVectors(camera.position, controls.target);
  const dist = _dir.length();

  // Thin the haze as the camera retreats, so the pile keeps the same slight
  // remove at any zoom. Held below FOG_HOLD: zoomed in, the orbit distance
  // goes to almost nothing and dividing by it would pack the pile into fog.
  scene.fog.density = FOG_HAZE / Math.max(dist, FOG_HOLD);

  // Walk the orbit center down into the pile as the viewer comes in, so
  // zooming carries them in among the chairs instead of into the empty air the
  // framed shot is centered on. Measured from the explore threshold, not
  // wantDist: the camera legitimately trails the fit while the pile grows, and
  // reading that lag as "zoomed in" would sag the view on every drop.
  const closeness = THREE.MathUtils.clamp(
    (wantDist * EXPLORE_FRACTION - dist) / (wantDist * 0.5), 0, 1);
  const framed = Math.max(1.1, spanTop * FOCUS_BIAS);
  const wantFocus = THREE.MathUtils.lerp(framed, pileTopY * 0.5, closeness);

  // Move the orbit center and the camera together: the viewer's angle survives.
  const delta = (wantFocus - camFocusY) * Math.min(1, dt * 1.2);
  camFocusY += delta;
  camera.position.y += delta;
  controls.target.y += delta;

  // In demo mode the breath owns the distance. It runs instead of the framing
  // below, which would pull every dive back out; wantDist still tracks the
  // pile, so the breath stays proportional to it.
  if (demoRunning()) {
    const breath = (Math.sin((t / DEMO_ZOOM_PERIOD) * Math.PI * 2) + 1) / 2;
    const want = wantDist * THREE.MathUtils.lerp(DEMO_ZOOM_NEAR, DEMO_ZOOM_FAR, breath);
    const next = dist + (want - dist) * Math.min(1, dt * 0.8);
    camera.position.copy(controls.target).addScaledVector(_dir.normalize(), next);
    return;
  }

  // Never pull them back out of a pile they went in to look at.
  if (viewerZoomed) return;
  if (dist < wantDist - 0.02) {
    const next = dist + (wantDist - dist) * Math.min(1, dt * 0.7);
    camera.position.copy(controls.target).addScaledVector(_dir.normalize(), next);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  world.step(1 / 60, dt, 4);

  // One pass over the live chairs: move their meshes, notice landings, measure
  // the pile. Frozen chairs can never change and cost nothing here. Only
  // landed chairs count toward the height — counting one in mid-fall made the
  // measurement, and the camera with it, heave on every drop. Landed means at
  // rest, not asleep: chairs constantly knock each other awake.
  let measuredTop = frozenTopY;
  let measuredWide = frozenRadius;
  let castTop = frozenCastTopY;
  let castWide = frozenCastRadius;
  const limit = strayLimit();
  for (let i = freezeIdx; i < chairs.length; i++) {
    const chair = chairs[i];
    const body = chair.body;
    chair.mesh.position.copy(body.position);
    chair.mesh.quaternion.copy(body.quaternion);
    chair.mesh.customDepthMaterial.userData.fade.value = shadowFade(chair);

    if (!chair.landed) {
      chair.fallTime += dt;
      if (chair.fallTime > MIN_FALL_TIME && atRest(body)) chair.landed = true;
      continue; // still on its way down: not part of the pile yet
    }
    const reach = Math.hypot(body.position.x, body.position.z);
    // The shadow must cover this chair wherever it lies, stray or not.
    castTop = Math.max(castTop, body.position.y + CHAIR_MID);
    castWide = Math.max(castWide, reach);
    // Strays that rolled clear count toward neither the height nor the width:
    // one chair skittering away must not haul the framing out after it.
    if (reach > limit) continue;
    measuredTop = Math.max(measuredTop, body.position.y + CHAIR_MID);
    measuredWide = Math.max(measuredWide, reach);
  }

  // Rise readily, sink reluctantly. If the chair holding the high point topples
  // off the heap the measurement steps down; sinking slowly keeps that from
  // yanking the view, while genuine growth is still followed.
  const rate = measuredTop > pileTopY ? 1.5 : 0.15;
  pileTopY += (measuredTop - pileTopY) * Math.min(1, dt * rate);
  // Width only ever grows: a heap does not pull itself back in, and frozenRadius
  // is a floor under this anyway.
  pileRadius = Math.max(pileRadius, measuredWide);
  // The shadow cover grows only too: a chair toppling off the high point must not
  // shrink the frustum and start cropping the shadow it still casts.
  castRadius = Math.max(castRadius, castWide);
  castTopY = Math.max(castTopY, castTop);

  freezeSettled(); // after the copies above, so a chair freezes at its final transform

  // Hands free: keep them coming, on the slider's clock.
  controls.autoRotate = demoRunning();
  if (demoRunning() && performance.now() - lastDropAt > demoDropMs) dropChair();

  frame(dt, t);

  aimKey();

  controls.update();
  if (composer) composer.render();
  else renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer?.setSize(window.innerWidth, window.innerHeight);
  if (gtao) sizeGtao();
});

animate();
