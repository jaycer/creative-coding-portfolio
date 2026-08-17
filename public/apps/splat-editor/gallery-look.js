// The gallery's look, lifted whole.
//
// Everything here is a copy of how Object Tile Scroll renders an object — the
// room, the environment, the five lights, the finishes, and the bake that turns
// a loaded GLB into a geometry the piece can wear. It is a copy on purpose: the
// point of the preview is to answer "would this mesh look right in the piece",
// and an approximation of the rig answers a different question. Every number
// below appears in object-tile-scroll.js, and if one changes there this is
// wrong until it changes here too.
//
// Kept in its own file so the difference is a diff rather than a hunt.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const FINISHES = [
  { name: 'wood', colors: [0xc98a45, 0x9c6539, 0xb07a4a, 0x8b5c38], rough: 0.72, metal: 0.04 },
  { name: 'paint', colors: [0xd94f6a, 0x3f7fd6, 0x4fbf74, 0xe0b23c, 0xd6d0c4], rough: 0.5, metal: 0.05 },
  { name: 'chrome', colors: [0xd8dde6, 0xc4ccd6, 0xe7c98a], rough: 0.22, metal: 0.82 },
  { name: 'velvet', colors: [0x9c2a63, 0x35619f, 0x3e8c5c, 0x8f4229], rough: 0.9, metal: 0 },
  { name: 'gloss', colors: [0x5c6478, 0xf2f0ea, 0xc0342f], rough: 0.14, metal: 0.2 },
  { name: 'neon', colors: [0xff3d8b, 0x2fe8ff, 0xb4ff3d, 0xffb02f], rough: 0.4, metal: 0.1, glow: 0.5 },
];

/** The room: a vertical wash, darkest overhead. Not a radial pool, on purpose. */
export function roomBackdrop() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#05060a');
  grad.addColorStop(0.55, '#0a0c12');
  grad.addColorStop(1, '#13161e');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The room again, as something to reflect.
 *
 * Not optional. A metal has almost no diffuse, so without this the chrome finish
 * renders as a silhouette with one specular streak. The gallery's own closer-look
 * panel omits it — that is a bug there, and copying it here would show a chrome
 * pig that the field would never produce.
 */
export function roomEnvironment(renderer) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, '#0b0d13');     // ceiling
  grad.addColorStop(0.30, '#5d6779');  // the lamps, as a band rather than points
  grad.addColorStop(0.52, '#252b39');  // horizon
  grad.addColorStop(1, '#353c4c');     // floor, catching the key
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

/** The rig. Every source directional, so nothing is dimmer for being anywhere. */
export function addLights(scene) {
  const key = new THREE.DirectionalLight(0xfff3e4, 2.7);   // high front left
  key.position.set(0.5, 0.9, 0.85);
  const fill = new THREE.DirectionalLight(0xc2d8ff, 1.15); // cool, from the right
  fill.position.set(-0.85, 0.2, 0.5);
  const rim = new THREE.DirectionalLight(0xffffff, 1.0);   // behind, to draw edges
  rim.position.set(-0.15, 0.45, -1);
  const bounce = new THREE.DirectionalLight(0x9fb0cc, 0.55);
  bounce.position.set(0.15, -1, 0.4);
  const amb = new THREE.HemisphereLight(0x93a6c8, 0x1a1d26, 0.8);
  scene.add(key, fill, rim, bounce, amb);
}

/** The three renderer settings that decide what any of the above looks like. */
export function applyToneMapping(renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

/** Centre on the bounding box, scale to a unit bounding sphere. */
export function normalize(g) {
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  g.boundingBox.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingSphere();
  const s = 1 / g.boundingSphere.radius;
  g.scale(s, s, s);
  g.computeBoundingSphere();
  return g;
}

/**
 * One geometry with one group per material, and the colors those groups had.
 *
 * The faceting the gallery shows is a property of the GEOMETRY, not of a
 * flatShading flag — a converter that ships unindexed positions and no normals
 * gets face normals out of the conditional computeVertexNormals below, and an
 * indexed mesh gets smooth ones. So a mesh that looks soft in the preview would
 * look soft in the piece, which is exactly the thing worth being able to see.
 */
export function bakeModel(root) {
  const byMaterial = new Map();
  root.updateWorldMatrix(true, true);
  root.traverse((n) => {
    if (!n.isMesh || !n.geometry) return;
    const g = n.geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    g.applyMatrix4(n.matrixWorld);
    if (!g.attributes.normal) g.computeVertexNormals();
    const mat = Array.isArray(n.material) ? n.material[0] : n.material;
    const key = mat ? mat.uuid : 'none';
    if (!byMaterial.has(key)) {
      byMaterial.set(key, {
        color: mat && mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
        parts: [],
      });
    }
    byMaterial.get(key).parts.push(g);
  });
  if (!byMaterial.size) return null;

  const merged = [];
  const colors = [];
  for (const { color, parts } of byMaterial.values()) {
    const g = parts.length === 1 ? parts[0] : mergeGeometries(parts);
    if (!g) continue;
    merged.push({ g, color, n: g.attributes.position.count });
  }
  if (!merged.length) return null;
  merged.sort((a, b) => b.n - a.n);
  for (const m of merged) colors.push(m.color);
  const geometry = merged.length === 1
    ? merged[0].g
    : mergeGeometries(merged.map((m) => m.g), true);
  return geometry ? { geometry, colors } : null;
}

/**
 * The per-group hue/saturation/lightness offsets the gallery keeps.
 *
 * A model is used for its color RELATIONSHIPS only, never its own colors: the
 * biggest group becomes "the object's color" and takes the finish, and every
 * other group keeps its distance from it. A one-color mesh — which is what
 * splat2glb produces — gets a single zero offset and wears the finish flat.
 */
export function groupsOf(srcColors) {
  if (!srcColors || srcColors.length < 2) return [{ dh: 0, ds: 0, dl: 0 }];
  const groups = [];
  const bh = { h: 0, s: 0, l: 0 };
  srcColors[0].getHSL(bh);
  const h = { h: 0, s: 0, l: 0 };
  for (const c of srcColors) {
    c.getHSL(h);
    let dh = h.h - bh.h;
    if (dh > 0.5) dh -= 1;
    if (dh < -0.5) dh += 1;
    groups.push({ dh, ds: h.s - bh.s, dl: h.l - bh.l });
  }
  return groups;
}

const _base = new THREE.Color();
const _bhsl = { h: 0, s: 0, l: 0 };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Paint the materials from a finish and a base color. The gallery's applyLook. */
export function applyLook(mats, groups, finishIdx, baseHex) {
  const f = FINISHES[finishIdx];
  _base.set(baseHex);
  _base.getHSL(_bhsl);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const m = mats[i];
    if (g.dh === 0 && g.ds === 0 && g.dl === 0) m.color.copy(_base);
    else m.color.setHSL((_bhsl.h + g.dh + 1) % 1, clamp01(_bhsl.s + g.ds), clamp01(_bhsl.l + g.dl));
    m.roughness = f.rough;
    m.metalness = f.metal;
    if (f.glow) { m.emissive.copy(m.color); m.emissiveIntensity = f.glow; }
    else { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
  }
}

export function newMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 });
}

// How the field frames a thing, as against how its inspector does. Both are
// worth seeing and they answer different questions: the field says whether the
// silhouette still reads at the size it will actually be shown, and the closer
// look says whether the surface holds up when somebody stops to stare at it.
export const FIELD = { fov: 42, near: 0.5, far: 60, depth: 12.6, scale: 0.85 };
export const CLOSER = { fov: 38, near: 0.05, far: 40, dist: 3.6 };
