// Chair Pile — chairs fall out of the dark and pile up forever.
//
// Any tap or keypress sends another one down, out of a disc of sky above the
// frame that is never itself in shot. They land somewhere random within it, and
// it widens as the heap spreads, so the pile grows outward as well as up instead
// of stacking into a spire. The physics collider is built from the same boxes as
// the visible chair, so legs really do snag on slats and the pile interlocks the
// way the shapes suggest.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as CANNON from 'cannon-es';
import { initAudio, resumeAudio, clatter, setMuted, isMuted, setTimbre, getTimbre } from './audio.js';

// Chairs are drawn as one instance apiece once frozen, and the physics only ever
// solves the few dozen still moving, so what this bounds is the broadphase, which
// keeps sweeping every body forever. Measured on an M1 Max: flat 120fps out past
// 1,500, about 40 at 2,200, and the cost is all in cannon sorting bodies rather
// than in anything drawn. 2,000 is a round number just under where it tips.
const MAX_CHAIRS = 2000;

const DEMO_DROP_MS = 2000;     // demo's cadence, as it ships; the slider moves it
let demoDropMs = DEMO_DROP_MS;
const FREEZE_BEHIND = 25;      // chairs this far down the pile turn to static bedrock
// ...and this far down they turn to bedrock whether they have settled or not.
// Freezing runs in drop order off a single index, so the oldest unsettled chair
// holds up every chair behind it, however still those are. That is usually a
// wait of a frame or two. But a chair pinned deep in the heap can be left
// jittering in place by the solver — barely moving, yet never still enough to
// pass atRest and never slow enough to fall asleep — and it blocks the queue for
// good: the live set then grows without bound, every chair in it costs physics
// and a pair of draw calls a frame, and the whole pile grinds down. Measured, it
// stalled at 494 frozen with the head spinning at 0.03 m/s and never recovered,
// even with nothing left falling on it. So past this depth the queue stops
// asking. A chair with 60 chairs on top of it cannot be seen, and snapping it to
// the pose it is already sitting in is invisible next to seizing up.
const FREEZE_FORCE_BEHIND = 60;
// The drop zone: a disc overhead that chairs fall out of, somewhere unseen.
//
// It starts ten chairs across and widens with the heap, which is the difference
// between a pile and a tower. Dropping every chair down one column builds a
// spire that grows until it topples, because a chair can only ever land on the
// chair below it. Spreading them over the width the heap has already reached
// lets it grow the way a heap of anything grows: outward as much as upward, each
// chair finding a shoulder to settle on.
//
// SPREAD has to be high enough to engage at all. It only widens the disc once
// SPREAD of the reached width beats the ten chairs it starts at, so at 0.7 the
// heap had to already be 3.3m across before the disc grew by so much as a
// centimeter — and it never got there, because what makes a heap of chairs
// spread is chairs rolling down it, and chairs barely roll: they are all corners
// and they catch on each other. So the disc stayed exactly ten chairs wide for
// two thousand chairs and built the tower it was put there to prevent.
//
// At 0.9 it tracks the heap from almost the first chair, and the cap is what
// decides the shape rather than a fixed point nobody can predict. That is the
// honest way round: the width where a heap of this size stops looking like a
// heap is a thing to look at and choose, and the arithmetic between the disc,
// the roll, and the stray limit is not something to derive it from.
const SPAWN_SPAN_CHAIRS = 10;  // how many chairs across the disc starts
const SPAWN_SPREAD = 0.9;      // share of the reached width the disc grows to fill
// Where the heap stops widening and starts climbing. Two thousand chairs pack
// into roughly 170 cubic meters, so a disc of this radius leaves a heap about as
// tall as it is wide — a pile, at the angle a pile sits at. Much wider and the
// same chairs spread into a floor covering; much narrower and they tower.
const SPAWN_RADIUS_MAX = 4.5;
const STRAY_MARGIN = 1.4;      // past the disc by this much and a chair has rolled away

// Nowhere near the pile, and above whatever the camera can see: the sky height is
// worked out per drop from the frame itself, and this is only the floor under it,
// for when the camera is in so close that the top of the frame is lower than the
// heap.
const MIN_SKY_GAP = 3.2;       // least a chair may fall, over the top of the pile
const SKY_MARGIN = 1.3;        // clearance over the top of the frame, so it is never seen waiting

// A chair still high up casts almost no shadow, fading up to a full one as it
// comes down.
//
// Nothing about that is physical, and it is standing in for something that is. A
// real shadow softens as its caster gets further from what it falls on, until a
// chair up in the sky throws nothing you would notice. A shadow map has one
// hardness for everything, so ours stays needle sharp all the way up — and the
// key light is 35 degrees, which throws a chair's shadow about 1.4x its height
// sideways. A chair released above the frame therefore lays a hard, chair-shaped
// shadow across the floor several meters from where it will land, a second
// before it arrives: a shadow with nothing above it, which gives away both that
// a chair is coming and that it came from nowhere.
//
// Fading it is the cheap half of what real penumbra would do. It cannot spread
// the shadow, but it can take away the thing that reads as wrong, which is a
// hard edge with no object over it.
const SHADOW_FADE_FROM = 4.6;  // height over the heap where the shadow starts coming in
const SHADOW_FADE_TO = 1.1;    // and where it is full strength

// How wide a shadow edge is allowed to be, in meters — about a third of a leg.
// Held constant in the world as the frustum grows; see where aimKey sets the
// filter radius from it.
const SHADOW_BLUR = 0.015;

// Contact darkening. A shadow map knows more than whether a point is in shadow:
// it knows how far away the thing shadowing it is. Subtract the two depths and
// the difference is the gap between a chair and whatever its shadow has landed
// on, in meters, which is exactly the quantity that says "these two are
// touching". Darken hard where the gap is nothing and let it go by CONTACT_GAP.
//
// The reason it is needed: a shadow map occludes the key light and nothing
// else, so the sky fill reaches the floor at full strength right up against a
// foot. That leaves a flat, evenly gray shadow with no gradient, and a chair
// with an even gray shadow under it reads as hovering over one. This is the
// cheap half of ambient occlusion — it only knows about occluders in the
// light's direction, so it does little inside a dense heap, but out on the open
// floor it is the whole of what was missing.
//
// The floor gets it and the chairs do not, which is deliberate. On a flat plane
// the gap changes gradually and the term reads as a smooth pool of shade. On
// the chairs it changes fast — surfaces at every angle, and in a heap almost
// everything is within CONTACT_GAP of something — so great blotches of the pile
// darkened at once, and the coverage below, which can only count in ninths,
// stepped across them in visible bands. That was paying an artifact for the
// case this technique is worst at anyway.
// How fast a shadow softens as its caster lifts away, as blur-meters per meter
// of gap: at 0.15 an edge reaches the full SHADOW_BLUR once its caster is about
// 10cm off the surface, and is a single texel — hard — where they touch.
const PCSS_SOFTNESS = 0.15;

const CONTACT_GAP = 0.12;      // meters of separation before it fades out entirely
const CONTACT_STRENGTH = 0.65; // how much of the light it takes away at zero gap

const REST_SPEED = 0.4;        // m/s under which a chair counts as come to rest
const MIN_FALL_TIME = 0.4;     // s of falling before a chair can be called landed
const HIT_MIN_SPEED = 0.7;     // m/s of impact under which a contact makes no sound
const HIT_COOLDOWN_MS = 70;    // one chair can only speak this often
const HIT_LOUD_SPEED = 5;      // impact speed that counts as a full-strength bang
const BUMP_LEVEL = 0.32;       // how loudly a chair already at rest answers when knocked

// Framing. Only the heap has to be held now — chairs arrive from over the top of
// the frame and are meant to, so nothing hangs above it waiting to be cropped,
// and the old margin that existed to keep a floating chair in shot can go back to
// merely comfortable.
//
// It does have to hold the heap's width as well as its height, which it never
// used to: every chair landed in one column, so fitting the height fitted
// everything. Now the disc widens as the pile spreads, and a wide heap under a
// wide screen still runs out of frame sideways long before it runs out of it
// upward. Both fits are computed and the camera takes whichever wants it further
// back.
const FOCUS_BIAS = 0.45;       // <0.5 sits the view low, giving the pile the frame
const FRAME_MARGIN = 1.2;
const PILE_AIR = 1.6;          // headroom over the heap, so a chair is seen falling before it lands
const EXPLORE_FRACTION = 0.8;  // closer than this share of the fit = exploring, so stop framing

// Demo mode. The camera orbits on its own and breathes in and out on a slow
// sine, while chairs drop themselves. The zoom is expressed as a share of the
// framing distance rather than in meters, so it keeps its composition as the
// pile grows and the fit distance climbs with it.
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

// Every joint here was once a butt joint — the leg's top face at exactly 0.44
// against the seat's underside at exactly 0.44, and so on. Coplanar faces have
// equal depth, so which one a pixel gets is down to float rounding, and at the
// top of every leg a lit square fought the seat's dark underside and won often
// enough to read as light in the wrong place.
//
// What matters is not that two faces are coplanar but that they SHADE
// differently. The pairs that showed were always a face pointing up against one
// pointing down — opposite normals, so one was lit and one was not, and the
// fight was the difference between them. Two flush outer faces share a normal,
// a material and a depth, so whichever wins draws the same pixel and nothing is
// visible at all. Only opposed normals need keeping apart.
//
// So every part is flush with its neighbors on the outside, and is separated
// only along the axis it joins on: each pushes a JOIN inside the next, which
// puts the end faces — the ones that point the wrong way — inside solid
// geometry where they cannot be seen. No part is inset, and no seam is drawn.
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
  // Back stiles: floor to top rail in one piece, passing through the seat on
  // the way. The back leg and the post above it used to be two boxes meeting at
  // the seat, which is a joint a chair does not have — the rear leg and the
  // back upright are one length of timber. Made whole, there is nothing left to
  // fight there and one less part to carry.
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
  uPcssMaxBlur: { value: SHADOW_BLUR },
  uPcssTexel: { value: 0.002 }, // meters one shadow texel covers
};

// three's own shadow sampling, with getShadow renamed out of the way so ours can
// take the name. Lifting the chunk at runtime rather than transcribing it keeps
// everything else in it — the varyings, the point and spot paths, the packing —
// exactly as three wrote it, so only the one function is ours to get wrong.
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
 * Percentage-closer soft shadows.
 *
 * The filter this replaces was a fixed width: the same blur whether a chair was
 * resting on a surface or a meter above it. That is wrong in both directions at
 * once. At a contact it spread an edge that should have been hard and black over
 * 15mm, which is what left a pale gap where a back post meets a seat; and it had
 * only nine taps to spend on that width, so the penumbra could take about ten
 * values and stepped between them in bands.
 *
 * So: find what is casting first, and let how far away it is set the width. A
 * caster touching the surface gets a single texel — hard. One well above it gets
 * the full blur. Both loops walk a Vogel disk, which needs no lookup table, and
 * both are rotated per pixel, which is what turns the residual quantization into
 * a faint noise instead of rings.
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

  // 1. What is above this point, and how far up? Search the widest penumbra we
  // would ever draw, since a blocker further out than that cannot widen it more.
  //
  // The first tap must land on the fragment's own texel, and the disk is spaced
  // to put it there. Starting the ring off-centre instead — which is what
  // sqrt((i + 0.5)/n) does — leaves the one sample that matters most untaken:
  // right at a contact the shadow is only a few millimeters wide while this
  // search is the width of the WIDEST penumbra, so a ring of eight can step
  // clean over a narrow band, find nothing, and take the early-out below. A
  // point in shadow then comes back fully lit, and it does it along the inside
  // of every corner, where the band is at its narrowest.
  float sum = 0.0;
  float hits = 0.0;
  for ( int i = 0; i < 12; i ++ ) {
    float fi = float( i );
    float a = fi * 2.39996323 + rot;
    float rr = sqrt( fi / 11.0 ) * maxR; // fi = 0 lands dead centre
    vec2 uv = shadowCoord.xy + vec2( cos( a ), sin( a ) ) * rr * texel;
    float d = unpackRGBAToDepth( texture2D( shadowMap, uv ) );
    if ( d < shadowCoord.z ) { sum += d; hits += 1.0; }
  }
  // Safe to call it lit now: a shadow narrower than the centre texel is
  // narrower than this map can draw at all.
  if ( hits < 0.5 ) return 1.0;

  // 2. The gap, in meters, sets the width. Floor it at a texel so a contact is
  // as hard as this map can draw rather than blurring into a gap.
  float gap = ( shadowCoord.z - sum / hits ) * uShadowDepth;
  float blur = clamp( gap * uPcssSoftness, uPcssTexel, uPcssMaxBlur );
  float pen = max( blur / uPcssTexel, 0.75 );

  // 3. Ordinary PCF, at that width, with enough taps to read as a gradient.
  float lit = 0.0;
  for ( int i = 0; i < 16; i ++ ) {
    float fi = float( i );
    float a = fi * 2.39996323 + rot;
    float rr = sqrt( ( fi + 0.5 ) / 16.0 ) * pen;
    vec2 uv = shadowCoord.xy + vec2( cos( a ), sin( a ) ) * rr * texel;
    float d = unpackRGBAToDepth( texture2D( shadowMap, uv ) );
    lit += ( d < shadowCoord.z ) ? 0.0 : 1.0;
  }
  return lit / 16.0;
}
`;

/**
 * Darken a surface where whatever is shadowing it is close by.
 *
 * The shadow camera is orthographic, so depth across it is linear and a
 * difference of stored depths is a distance in meters once multiplied back up
 * by the camera's range. The lit case needs no special handling: a surface that
 * is the frontmost thing from the light reads its own depth back out of the map,
 * so the epsilon test finds no blocker in front of it and nothing is darkened.
 * Only genuinely shadowed points have something above them to measure.
 */
function tuneShadows(material, { contact = false } = {}) {
  material.onBeforeCompile = (shader) => {
    for (const name of Object.keys(contactUniforms)) shader.uniforms[name] = contactUniforms[name];
    // Everything shadowed gets the soft-shadow filter; only the floor takes the
    // contact term on top of it.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <shadowmap_pars_fragment>', PCSS_SHADOW_CHUNK);
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
            // Spread the taps as wide as the shadow filter itself. Narrower and
            // this term is sharper than the shadow it sits on, which shows up
            // on the chairs still falling: their shadow is a dither, thrown
            // away fragment by fragment, so depth lands in a scatter of texels
            // and a tight tap pattern turns that scatter into stripes.
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
              // Scale by how much of the neighborhood was actually blocked, not
              // merely whether any of it was. A half-dithered chair occludes
              // half these taps and should darken half as much, which is both
              // the truer answer and a continuous one — no threshold left for
              // the dither to flicker across.
              float cover = n / 9.0;
              gl_FragColor.rgb *= 1.0 - uContactStrength * near * cover;
            }
          }
        }
        #endif
        #include <tonemapping_fragment>`);
  };
  // Only ever appended to the key three builds anyway, but the two variants
  // must not collide: the floor's program has a term the chairs' does not.
  material.customProgramCacheKey = () => (contact ? 'chair-shadow-floor' : 'chair-shadow');
}

// Colliders are this much bigger than the chair you can see, all round.
//
// A contact in cannon settles with the two bodies slightly inside each other —
// measured, about 2mm here. Where two boxes overlap, their surfaces cross, and
// the crossing is a crisp polygon shaded quite differently from the face it cuts
// through: a hard little wedge of one chair showing inside another. Padding the
// collider spends that overlap on empty space instead. The physics still sinks
// 2mm into the padding, and the wood stops just short of touching, which at this
// size reads as contact and cannot produce an intersection to light.
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
// background instead of ending at a line. Denser fog blurs that horizon further:
// the floor fades out well before its true vanishing point, which spreads the
// transition over a wide band of screen rather than compressing it into an edge.
const VOID = 0x070b14;

// Fog is the one thing here measured from the camera rather than from the world,
// so a fixed density reads as a bubble of visibility that travels with the
// viewer — and the pile grows without bound while the framing pulls back to keep
// up, so ANY fixed density eventually swallows it whole. Instead, hold the haze
// on the pile constant and let the density fall as the camera retreats: at the
// framing distance the pile always sits at the same slight remove, while the
// floor's true horizon is always far enough beyond it to still dissolve.
// density = FOG_HAZE / dist puts fog(dist) = 1 - exp(-FOG_HAZE^2), about 15%.
const FOG_HAZE = 0.4;
const FOG_HOLD = 8; // stop thickening inside this: zoomed among the chairs, fog must not close in
const scene = new THREE.Scene();
scene.background = new THREE.Color(VOID);
scene.fog = new THREE.FogExp2(VOID, FOG_HAZE / FOG_HOLD);

// A near plane this close lets the camera push right through a chair without the
// surfaces clipping out early — see the zoom-through note on controls.minDistance.
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.03, 200);
camera.position.set(2.9, 2.1, 4.0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// PCF rather than PCFSoft, which is the sharper filter of the two and is the
// reason for the swap: its kernel is a fixed couple of texels wide and takes no
// radius, so an edge coarser than that steps and there is no dial to turn. Plain
// PCF spreads its nine taps over shadow.radius, which aimKey sets from the texel
// size — a shadow edge wants to be fuzzy here, not crisp, and a fuzzy edge is
// one an undersampled staircase disappears into.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

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

// A directional light is nothing but a direction — position only aims it and
// places its shadow camera. So this is the whole of the light's character, set
// once and never touched again: what makes a source read as fixed in the world
// is that orbiting past it changes which face is lit, and that only holds if the
// direction is constant. It has to ride up with the pile to keep the heap inside
// its shadow frustum, which aimKey does by moving the light and its target
// together, as one rigid pair.
// 35 degrees up, and about 90 degrees around from where the camera starts. Both
// halves matter: the low angle is what gives every chair a bright side and a
// dark one, but a low light sitting behind the viewer would only flatten the
// pile from the front and hide its own shadows behind it. Off to one side, the
// shadows rake across the floor where they can be seen.
const KEY_DIR = new THREE.Vector3(10, 8.5, -7).normalize(); // pile toward light
const KEY_STANDOFF = 22; // how far back it rides, on top of the pile's own height

// Brighter than the old overhead key at the same exposure. Light this low strikes
// the seats and the floor at a glance, and the cosine falloff costs those faces
// about a third of what a steeper light gave them; the vertical faces more than
// make it back, which is the whole point, but the flat ones need the make-up.
const key = new THREE.DirectionalLight(0xfff1dd, 3.0);
key.castShadow = true;
// A 4096 map is 64MB of depth texture, which is worth it on a desktop GPU and
// is not on a phone — where it is also the least affordable, since the same
// device is already paying for the physics. Touch devices keep the 2048.
const fineShadows = window.matchMedia('(pointer: fine)').matches;
key.shadow.mapSize.set(fineShadows ? 4096 : 2048, fineShadows ? 4096 : 2048);
// Bias is in texels, morally, so it is set from the texel size the fitted
// frustum actually achieves rather than picked as a bare number. normalBias
// used to be 0.02 — 20mm, against a leg 50mm thick. It offsets the receiving
// surface along its own normal before the lookup, so the floor was sampled 20mm
// up, and at 35 degrees that walks the shadow's edge about 29mm back toward its
// caster: well over half a leg's width, which is what unsticks a chair from its
// own shadow. Under a foot standing on the floor it reads as the whole chair
// hovering. Both are only affordable this small because the fit below buys the
// resolution to pay for them.
//
// 0.0005 is a quarter of a texel, which is lower than it could safely go while
// the filter was a fixed 15mm wide. PCSS changed what this number costs: a
// contact shadow is now hard, so the couple of millimeters this offset walks the
// edge back no longer disappears into a soft gradient — it draws a bright line
// along the inside of every corner where two members meet. Acne is what it
// exists to prevent, and with the contact hard and the depth range fitted, the
// constant bias above is carrying that on its own; zero showed none either.
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
 * Ride the light up with the pile without ever turning it. Both ends move by the
 * same vector, so the direction survives untouched however tall the heap gets —
 * moving them by different amounts is what quietly tips a side light into an
 * overhead one, and an overhead light lands the same on every face, so orbiting
 * it reveals nothing and the source seems to travel with the viewer.
 */
function aimKey() {
  // Fit the box to what actually casts, which is the whole of the resolution
  // budget. It used to be sized as 10 + 1.1 * height, on the reasoning that the
  // box must hold the receiving floor as well as the casters, since a floor
  // outside it comes back lit and the shadow ends in a straight line. The floor
  // needs no room of its own: an orthographic shadow camera looks along the
  // light, so a caster and the shadow it throws land on the SAME light-space xy
  // — that is what casting a shadow means here. Cover the casters and every
  // floor point they can darken is covered with them, rake and all. The
  // constant 10 was paying for a 20m box around a heap often 2m wide, and the
  // whole of that went into texels that never saw a chair.
  //
  // What casts: everything settled, out to the widest chair that has not rolled
  // clear, plus the drop disc the falling ones come down in, plus a chair's own
  // reach however it is lying. Height only has to run up to where a falling
  // chair's shadow has faded out entirely, since above that it casts nothing.
  const reach = Math.max(strayLimit(), pileRadius) + CHAIR_REACH;
  const top = pileTopY + SHADOW_FADE_FROM;

  // That region in light space. x is horizontal, so it takes the radius as it
  // is; y mixes the radius with the height, and is centered half way up rather
  // than on the floor. The box is square, so the wider of the two wins: keeping
  // one texel size in both axes keeps the PCF kernel round, and an oblong one
  // would smear the softening along whichever axis was coarser.
  const span = Math.max(reach, reach * LY_FLAT + LY_UP * top / 2);
  if (Math.abs(span - shadowSpan) > 0.25) { // resizing every frame rebuilds the matrix for nothing
    shadowSpan = span;
    const cam = key.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    // Depth is measured about the aim, and the same region bounds it, so near
    // can start just in front of the casters instead of at a token 0.5. The
    // tighter the pair, the more of the depth buffer's precision lands on the
    // chairs, which is the other half of what lets the bias above be so small.
    const deep = reach * LZ_FLAT + LZ_UP * top / 2 + 0.5;
    cam.near = Math.max(0.1, KEY_STANDOFF + pileTopY - deep);
    cam.far = KEY_STANDOFF + pileTopY + deep;
    cam.updateProjectionMatrix();

    // Hold the softness at a fixed width in the world rather than a fixed number
    // of texels. The radius is counted in texels, and a texel is worth more
    // meters the taller the heap gets, so a constant radius would quietly widen
    // the penumbra as the pile grew — the shadows going softer for no reason
    // anything in the scene could account for. Dividing by the texel size keeps
    // the blur the same handful of millimeters throughout. The ceiling matters:
    // nine taps spread wider than about this stop reading as one soft edge and
    // start reading as nine, and the shadow washes out to nothing besides.
    key.shadow.radius = THREE.MathUtils.clamp(SHADOW_BLUR / ((2 * span) / key.shadow.mapSize.width), 1, 7);
    // The contact term reads depths out of this same camera, so it needs the
    // range to turn them back into meters.
    contactUniforms.uShadowDepth.value = cam.far - cam.near;
    contactUniforms.uPcssTexel.value = (2 * span) / key.shadow.mapSize.width;
  }

  // Texel snapping. The shadow map's grid is fixed in light space, not world
  // space, so sliding the light by a fraction of a texel redistributes every
  // edge into different texels and the staircase of an undersampled edge
  // reshuffles — which reads as a ripple crawling along the shadow. And the
  // light never does stop sliding: pileTopY is an exponential approach, so it
  // keeps closing on the measurement by ever-smaller amounts long after the pile
  // looks still. Quantizing the aim to whole texels locks the grid to the world.
  // The light still follows the pile, but in texel-sized hops, so an edge lands
  // in the same texels frame after frame and the staircase holds still — which
  // is all PCFSoftShadowMap needs to blur it into a soft edge.
  // Half way up the casters, which is the center the span above was measured
  // about — aiming anywhere else would leave the box needing to be bigger than
  // it is to still hold them.
  const texel = (2 * shadowSpan) / key.shadow.mapSize.width;
  aimPoint.set(0, top / 2, 0);
  const x = Math.round(aimPoint.dot(LIGHT_X) / texel) * texel;
  const y = Math.round(aimPoint.dot(LIGHT_Y) / texel) * texel;
  const z = aimPoint.dot(LIGHT_Z); // depth along the light, no grid to fall off

  key.target.position.copy(LIGHT_X).multiplyScalar(x)
    .addScaledVector(LIGHT_Y, y)
    .addScaledVector(LIGHT_Z, z);
  key.target.updateMatrixWorld();
  key.position.copy(key.target.position).addScaledVector(KEY_DIR, KEY_STANDOFF + pileTopY);
}

// Swung round to sit opposite the key, and left low and weak. A key this low
// leaves a genuinely dark side, which is the point — but with nothing coming the
// other way it goes to flat black and takes the shape of the chair with it. Cool
// against the key's warmth, and far too dim to compete: it says how deep the
// shadow is, not where the light comes from. Casts nothing, as before.
const fill = new THREE.DirectionalLight(0x8fa6c4, 0.3);
fill.position.set(-9, 4.5, 6);
scene.add(fill);

// There used to be a spot 9m up here, throwing a soft pool of light on the patch
// of floor the pile grows on: decay=0 so it held as the heap rose, penumbra=1 so
// it had no rim, and deliberately casting no shadow on the grounds that the key
// already did and a second set would read as a mistake.
//
// Casting no shadow is what made it untenable. It was the brightest thing on the
// floor by some way, and it reached that floor straight through the chairs — so
// the ground under the densest part of the heap came out as bright as open floor
// three meters away, and a patch hemmed in on all sides could read lighter than
// one in the open, which is the exact opposite of what being surrounded by
// chairs should look like. It also lit the inside of the pile as evenly as the
// top of it, flattening the whole heap.
//
// None of that was visible while the shadows were soft and approximate. It only
// became the thing standing in the way once everything else had been taught to
// respect what is in front of it: one light that ignores geometry entirely
// undoes the grounding the rest of them establish. So it is gone, and the key,
// ambient and sky are each lifted a little to make up the exposure it was
// carrying — light that answers to the geometry, in place of light that did not.

/**
 * A tileable value-noise texture for the floor, drawn at runtime so the page
 * stays self-contained. Kept near white and low contrast: it multiplies the
 * floor color, so it reads as broad unevenness in the concrete rather than as a
 * pattern. Octaves are deliberately coarse — the smallest features still span
 * several chair-widths once it's stretched over the floor.
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
      // Spread around the mean, not across the raw range. Summing octaves
      // clusters n tightly about 0.5, so scaling [0,1] into a narrow band (the
      // obvious way to keep it subtle) leaves only a couple of percent of actual
      // variation and the mottling disappears entirely.
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
  // ~10 units per tile, matching the floor's own size: 60 tiles over 600 units.
  // Tiles any larger than this and the patch of floor around the pile is less
  // than one tile wide, so the mottling flattens into a plain gradient and reads
  // as no texture at all. Here the coarsest octave lands around 3 units —
  // several chairs across, large but legible.
  texture.repeat.set(60, 60);
  // Enough to keep the mottling from smearing at grazing angles near the
  // horizon; the full 16x costs real sampling time on a floor this big for no
  // visible gain on texture this soft.
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

const floorTexture = makeFloorTexture();
// Two triangles, so the size is free — and it has to outrun the fog. The haze
// thins as the camera pulls back, which reaches further out into the floor, and
// a plane that ends inside the visible range shows its edge as a hard line
// against the void. This one always ends well past where the fog has closed.
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
// Drawn a few millimeters over the plane the chairs actually land on, so every
// one of them stands a little into the ground rather than exactly on it.
//
// The problem it answers is that a foot resting exactly on a plane meets it
// along a hairline, and every small error in the shadow shows up on that line
// as a bright seam: the filter is 15mm wide and the bias still walks the edge a
// couple of millimeters, and none of that has anywhere to hide when the contact
// is infinitely thin. Sink the foot and the junction becomes an intersection
// instead of a join — the underside, and the seam with it, are simply below the
// floor. It does not make the shadow more correct; it puts the remaining error
// somewhere it cannot be seen.
//
// Cheaper than it looks: raising the floor moves nothing else. The physics
// plane stays at zero, so the simulation is untouched and no mesh parts company
// with its collider, and since the chairs do not move relative to each other,
// the pile is identical — it is only the ground that has come up to meet it.
floor.position.y = 0.010;
tuneShadows(floor.material, { contact: true });
floor.receiveShadow = true;
scene.add(floor);

// ------------------------------------------------------------------ physics
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.solver.iterations = 14;
world.solver.tolerance = 0.002;

const chairMat = new CANNON.Material('chair');
const floorMat = new CANNON.Material('floor');
// High friction, near-zero bounce: chairs should grab and settle, not skate away.
// Stiff contacts, and the reason is visual rather than physical. A contact in
// cannon is a spring: the softer it is, the further two bodies sink into each
// other before it pushes back. A few millimeters of that is invisible on its
// own, but where two boxes overlap their surfaces intersect, and the
// intersection is a crisp polygon lit differently from the face it cuts across
// — a hard-edged sliver of one chair showing through another. Stiffening the
// spring shortens the overlap and shrinks the sliver with it.
const CONTACT_SPRING = { contactEquationStiffness: 1e8, contactEquationRelaxation: 3 };
world.addContactMaterial(new CANNON.ContactMaterial(chairMat, chairMat, { friction: 0.6, restitution: 0.03, ...CONTACT_SPRING }));
world.addContactMaterial(new CANNON.ContactMaterial(chairMat, floorMat, { friction: 0.7, restitution: 0.02, ...CONTACT_SPRING }));

const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: floorMat });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

// -------------------------------------------------------------------- chairs
const chairGeometry = buildChairGeometry();
const materials = PALETTE.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.04 }));
materials.forEach((m) => tuneShadows(m));

const chairs = [];     // every dropped chair, in drop order
let freezeIdx = 0;     // chairs before this index are already frozen
let pileTopY = 0;
let pileRadius = 0;    // how wide the heap has reached, which is what widens the drop zone
let frozenTopY = 0;    // tallest frozen chair — fixed forever, so measured once
let frozenRadius = 0;  // and the widest, likewise
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
  // Bedrock has no rattle left in it — it cannot move, so there is nothing there
  // to hear. It also puts a ceiling on the racket: every chair ever dropped
  // stays in the world and stays able to answer, so without this the deeper the
  // pile got the louder every landing would be, forever.
  if (isFrozen(chair)) return;

  const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
  if (speed < HIT_MIN_SPEED) return; // a nudge, not a knock

  // A ten-box chair makes several contacts per landing, and a chair resting on
  // the pile keeps generating them forever. One knock per chair per cooldown
  // collapses both into the single sound the eye expects.
  const now = performance.now();
  if (now - chair.lastHitAt < HIT_COOLDOWN_MS) return;
  chair.lastHitAt = now;

  // Both chairs in a chair-on-chair hit are told about it, and both now answer.
  //
  // They didn't before, and which one was speaking was backwards: the tie-break
  // gave the pair to the lower id, and the lower id is always the older chair —
  // so what sounded on every landing was the chair already lying in the pile, at
  // full strength, while the chair that actually fell was silenced. A landing was
  // four or five settled chairs shouting at once, each at its own pitch, and no
  // voice for the impact itself. That chord is where the mush came from.
  //
  // So keep both voices and let the fall decide the level. The arriving chair is
  // still falling when it strikes, so it makes the knock; the chairs it lands on
  // have come to rest, so they answer under it — quietly, each in its own voice,
  // from its own place in the stereo field. Same count of voices, one of them now
  // in front.
  const level = chair.landed ? BUMP_LEVEL : 1;

  // Pan by where the chair sits across the current view rather than in world
  // space: the camera orbits, so world x has nothing to do with left and right.
  _pan.copy(chair.body.position);
  camera.worldToLocal(_pan);
  clatter(
    (speed / HIT_LOUD_SPEED) * level,
    chair.pitch,
    THREE.MathUtils.clamp(_pan.x / 3, -1, 1) * 0.7
  );
}

/**
 * The stand-in for the depth material three.js would otherwise use in the shadow
 * pass, with one addition: it can throw away a share of its own fragments, and
 * so cast a partial shadow.
 *
 * Dithered rather than blended because a shadow map has nowhere to put a
 * half-shadow — a fragment is either the nearest thing to the light or it is
 * not. So discard a share of them in a fine pattern instead, and let the filter
 * that already softens every shadow edge average what survives back into a gray.
 * Interleaved gradient noise for the pattern: it scatters evenly at pixel scale,
 * costs two instructions, and needs no array to index into, which the shader
 * language makes awkward anyway.
 *
 * Every chair gets one of these, so each can fade on its own, but the cache key
 * is fixed so they all still share the one compiled program — the uniform is the
 * only thing that differs.
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
  // Kept as an index, not just a material: when this chair freezes it stops
  // being a mesh with a material of its own and becomes one instance among many,
  // which carries its color as a value rather than as a reference.
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
 * How high a chair starts: out of sight, above the top of the frame.
 *
 * Worked out from the camera rather than from the pile, because "off screen" is
 * a fact about the frame and the frame keeps moving — it pulls back as the heap
 * grows and dives in when demo mode does. A fixed height over the pile would
 * hang chairs in plain sight at one zoom and bury them at another.
 *
 * The MIN_SKY_GAP floor is for exactly that second case: zoomed in among the
 * chairs the top of the frame can be lower than the top of the heap, and a chair
 * released there would appear inside the pile rather than over it.
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

  // Uniform over the disc, not over the radius: without the square root the
  // middle gets crowded, since a ring's area grows with how far out it is, and
  // the drop column this is meant to break up would quietly come back.
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
// Every frozen chair, drawn in one call.
//
// A chair of its own costs two draw calls a frame forever — once into the shadow
// map, once into the scene — and three.js spends real CPU on each one whether
// the chair moved or not. Measured, a settled heap of ~2,200 chairs was 4,355
// calls and about 50ms a frame, which is where "pile up forever" stopped being
// true: the GPU was idle and the time went entirely on submitting the work.
//
// But a frozen chair is welded in place with its velocity zeroed and is never
// read again, which is exactly the bargain an InstancedMesh asks for: one
// transform, written once, never touched. So the whole of bedrock collapses into
// a single call and stays there, however deep it gets, and the per-frame cost of
// the pile becomes the couple of dozen chairs still moving on top of it.
const BEDROCK_CHUNK = 256; // instances to allocate at a time; doubles from here

// One material for all of it. The palette lives in each instance's own color
// instead, which is why this one is white: three.js multiplies the two, so
// anything else here would tint the whole heap.
const bedrockMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68, metalness: 0.04 });
tuneShadows(bedrockMaterial);

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

  // Composed from the body rather than read off the mesh: the mesh's matrix is
  // only refreshed at render, so it can be a frame stale, and this is the last
  // chance to get the transform right — nothing will ever update it again.
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
  // Bedrock is solid and never fades, so the fader goes with the mesh. One per
  // chair adds up over two thousand of them, and nothing is going to ask this one
  // for a shadow again.
  chair.mesh.customDepthMaterial.dispose();
  chair.mesh = null; // it is an instance now, and nothing may reach for it again
}

/**
 * Settled chairs deep in the pile become static: cheap, and the base stops
 * creeping. Prefers to freeze a chair that is actually at rest, so one still
 * tumbling is not locked in place mid-motion — it just gets frozen on a later
 * frame once it comes to rest. Deliberately tests rest rather than the physics
 * engine's sleep state: chairs this deep are pinned but get knocked awake by
 * every landing above them, so waiting for sleep could stall the queue for good
 * and let the per-frame work grow without bound.
 *
 * Past FREEZE_FORCE_BEHIND it stops preferring and just takes them, which is
 * what actually holds that promise — testing rest instead of sleep narrows the
 * stall but does not close it, since a chair can jitter below the sleep
 * threshold and above the rest one indefinitely.
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
 * fromButton says a real click opened this, which decides two things: whether
 * the audio context may be created (it may only be built inside a genuine
 * gesture, and the greeting on load is not one), and where focus goes on the way
 * back out.
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
 * Close, and put focus somewhere the page still works from. A mouse click
 * leaves its control focused, and the keydown handler ignores keys aimed at a
 * button — so "press any key" would quietly stop dropping chairs. Blur for the
 * pointer, hand it back to the hamburger for the keyboard, where losing your
 * place is worse than losing a keystroke.
 *
 * Only ever back to the hamburger, though, if that is where they came from. The
 * greeting on load came from nowhere: parking focus on a button they never
 * pressed would leave the keyboard aimed at the menu, and every key they then
 * pressed to drop a chair would go to it instead and do nothing.
 */
function closeMenu({ toButton }) {
  menuOpen = false;
  scrim.hidden = true;
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
  // Every way out of here is a real gesture — a click on the scrim, Close, the
  // close cross or the hamburger, or Escape — so this is the earliest the
  // context may legally be built. It has to happen here now that demo ships on:
  // the greeting is the only thing holding the chairs back, so the first one
  // lands moments after this returns, and nothing else would have unlocked the
  // audio in time for it to be heard.
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

// Only the scrim itself: a click that lands on the overlay is not a dismissal.
scrim.addEventListener('click', (e) => {
  if (e.target === scrim) closeMenu({ toButton: false });
});

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
 * Demo waits for the overlay to be out of the way — it is switched on from
 * behind the very thing that would hide it, and the first chair down is the one
 * worth seeing. Both halves hold off: nothing falls, and the camera stays put.
 */
function demoRunning() {
  return demo && !menuOpen;
}

// Deliberately not remembered between visits, where the knock is. The knock is a
// taste; this is a thing to play with. Coming back to a sketch you left at 0.1
// and finding chairs already falling faster than they can land is a fright, not
// a preference being honored.
spawnEl.addEventListener('input', () => {
  const seconds = Number(spawnEl.value);
  demoDropMs = seconds * 1000;
  spawnValEl.textContent = `${seconds.toFixed(1)}s`;
});
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

// Open, every time, over an empty floor. The piece starts as a room with nothing
// in it and a card explaining what it is; nothing falls, and demo mode holds,
// until the card is out of the way. Whatever happens first should be watched
// rather than missed behind the thing telling you about it.
openMenu({ fromButton: false });

// --------------------------------------------------------------------- loop
const clock = new THREE.Clock();
let camFocusY = 1.2;
let framedTop = -1;                                    // pile height the framing was last fit to
let framedWide = -1;                                   // and the width, which grows on its own now
let wantDist = camera.position.distanceTo(controls.target);
const _dir = new THREE.Vector3();

// Whether the viewer has taken themselves in among the chairs, which is the one
// case where the framing must not pull back.
//
// Decided only when they stop touching it, never mid-flight. Reading it live off
// the distance looks equivalent and is not: the framing trails its own fit
// whenever the pile grows quickly, and a camera lagging behind the fit is
// indistinguishable, by distance alone, from a camera someone drove in close. So
// the shot would give up following exactly when the heap was growing fastest, and
// stay given up, because the fit only runs further ahead from there. It went in
// among the chairs and never came out.
let viewerZoomed = false;
controls.addEventListener('end', () => {
  viewerZoomed = camera.position.distanceTo(controls.target) < wantDist * EXPLORE_FRACTION;
});

/**
 * Keep the floor and the heap in frame as it grows, on both counts: it gets
 * taller, and it gets wider. Only re-fits when it actually gains one or the
 * other, and only ever pulls back — so orbiting is never fought.
 *
 * Stands down entirely once the camera is well inside the framing distance,
 * which means the viewer has deliberately zoomed in among the chairs. Otherwise
 * the next chair to land would grow the pile, widen the fit, and quietly drag
 * them back out of the pile they were exploring.
 */
function frame(dt, t) {
  const spanTop = pileTopY + PILE_AIR;
  const spanWide = (pileRadius + STRAY_MARGIN) * 2;
  if (pileTopY > framedTop + 0.05 || pileRadius > framedWide + 0.05) {
    framedTop = pileTopY;
    framedWide = pileRadius;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    // The horizontal field is the vertical one widened by the aspect, so on a
    // wide screen the width is nearly free and on a tall one it is what decides.
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const needTall = (spanTop * 0.5) / Math.tan(vFov / 2) * FRAME_MARGIN;
    const needWide = (spanWide * 0.5) / Math.tan(hFov / 2) * FRAME_MARGIN;
    wantDist = Math.max(wantDist, needTall, needWide);
  }

  _dir.subVectors(camera.position, controls.target);
  const dist = _dir.length();

  // Thin the haze as the camera retreats, so the pile keeps the same slight
  // remove at any zoom instead of dissolving into the void. Held below FOG_HOLD:
  // zoomed in among the chairs the orbit distance goes to almost nothing, and
  // dividing by it would pack the whole pile into solid fog.
  scene.fog.density = FOG_HAZE / Math.max(dist, FOG_HOLD);

  // The orbit center is both what the camera looks at and what it zooms toward.
  // Framed from outside it belongs up in the air over the heap, where the shot is
  // centered; but zooming toward that point just flies into that empty air.
  // So as the viewer comes in, walk it down into the body of the pile — the
  // closer they get, the more the pile itself is the subject, and zooming
  // carries them in among the chairs.
  // Measured from the explore threshold, not from wantDist itself: while the
  // pile is growing the camera legitimately trails its fit distance, and reading
  // that lag as "zoomed in" would sag the view downward on every drop.
  const closeness = THREE.MathUtils.clamp(
    (wantDist * EXPLORE_FRACTION - dist) / (wantDist * 0.5), 0, 1);
  const framed = Math.max(1.1, spanTop * FOCUS_BIAS);
  const wantFocus = THREE.MathUtils.lerp(framed, pileTopY * 0.5, closeness);

  // Move the orbit center and the camera together: the viewer's angle survives.
  const delta = (wantFocus - camFocusY) * Math.min(1, dt * 1.2);
  camFocusY += delta;
  camera.position.y += delta;
  controls.target.y += delta;

  // In demo mode the breath owns the distance. It has to run instead of the
  // framing below rather than alongside it: that code exists to pull the camera
  // back out to the fit, which is exactly what it would do to every zoom the
  // demo tried to make. wantDist still tracks the growing pile above, so the
  // breath stays proportional to it, and the focus walk has already read the
  // closer distance — so diving in also tips the view down into the heap.
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

  // One pass over the live chairs: move their meshes, notice the ones that have
  // landed, and measure the pile. Chairs before freezeIdx are frozen — their
  // transforms and heights can never change, so they cost nothing per frame no
  // matter how deep the pile gets.
  //
  // Only chairs that have landed count toward the height. A chair in mid-fall is
  // briefly the highest thing in the scene, and counting it made the measurement
  // dive from the spawn height down to the pile on every drop — which the camera
  // faithfully followed, heaving the whole view like a swell. Note that landing
  // is about being at rest, NOT about the physics engine putting the body to
  // sleep: at this drop cadence chairs constantly knock each other awake, so a
  // sleep-based test finds almost nothing settled and the pile reads as flat.
  let measuredTop = frozenTopY;
  let measuredWide = frozenRadius;
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
    // Strays that rolled clear are neither the top of the heap nor the width of
    // it: one chair skittering away must not haul the framing out after it, nor
    // widen the drop zone to somewhere no chair has actually settled.
    const reach = Math.hypot(body.position.x, body.position.z);
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

  freezeSettled(); // after the copies above, so a chair freezes at its final transform

  // Hands free: keep them coming, on the slider's clock.
  controls.autoRotate = demoRunning();
  if (demoRunning() && performance.now() - lastDropAt > demoDropMs) dropChair();

  frame(dt, t);

  aimKey();

  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
