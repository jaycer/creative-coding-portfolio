// The vacuum sealer: a skin that starts outside everything and is pulled in
// until it lies on the points.
//
// The idea is Jayce's and it is worth stating in his words, because the whole
// design follows from it: a skin the size of the room, a vacuum inside it, and
// it pulls down until it reaches a dot and can go no further. Then the same
// happens inside each leg and inside the hollow of an ear, so the skin gets
// sucked in around those too, and what is left IS the model.
//
// Formally this is a shrink-wrap over an active surface, cousin to alpha
// wrapping. What it has over the volumetric bracket in tools/splat2glb.mjs is
// the thing a real vacuum former has: the sheet is a MEMBRANE. It resists being
// stretched. That single property is what makes the difference on a scan with a
// hole in it — the bracket collapses into an unobserved patch because nothing
// holds it out, whereas a membrane spans it, the way plastic bridges a gap in a
// mould instead of pouring through it. So the four things that happen every
// iteration are:
//
//   1. VACUUM   every vertex not yet touching anything steps inward along its
//               own normal (not toward the middle — along the normal is what
//               lets it reach into the gap between two legs).
//   2. TENSION  Taubin smoothing, which is the sheet's own springiness.
//   3. STIFFNESS no edge may stretch far past its rest length. This is the part
//               that bridges holes, and without it the vacuum wins everywhere.
//   4. CONTACT  anything within `skin` of a point is put exactly `skin` away and
//               frozen. It has reached a dot; it can go no further.
//
// Then the mesh is subdivided and the whole thing runs again, so the skin
// arrives coarse and taut and only gets the resolution to enter a small
// concavity once it is already sitting against the large ones. Going straight to
// a fine mesh lets it fall through the surface between the points.
//
// The step is capped rather than jumping the full distance to the nearest point,
// so that tension and stiffness have something to push back against. Uncapped,
// the sheet reaches the far wall of a hole in one iteration and no amount of
// smoothing recovers it.

/** A unit icosahedron, subdivided `n` times. Closed, and near-uniform. */
export function icosphere(n) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let pass = 0; pass < n; pass++) {
    const mid = new Map();
    const out = [];
    const midpoint = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let at = mid.get(key);
      if (at === undefined) {
        at = verts.length;
        verts.push([
          (verts[a][0] + verts[b][0]) / 2,
          (verts[a][1] + verts[b][1]) / 2,
          (verts[a][2] + verts[b][2]) / 2,
        ]);
        mid.set(key, at);
      }
      return at;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b); const bc = midpoint(b, c); const ca = midpoint(c, a);
      out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    faces = out;
  }
  // Onto the unit sphere. Subdividing an icosahedron leaves midpoints inside it.
  const pos = new Float64Array(verts.length * 3);
  verts.forEach((v, i) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    pos[i * 3] = v[0] / l; pos[i * 3 + 1] = v[1] / l; pos[i * 3 + 2] = v[2] / l;
  });
  return { pos, faces: faces.flat() };
}

/** Split every triangle into four, sharing edge midpoints. */
export function subdivide(mesh) {
  const pos = Array.from(mesh.pos);
  const faces = [];
  const mid = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let at = mid.get(key);
    if (at === undefined) {
      at = pos.length / 3;
      pos.push(
        (pos[a * 3] + pos[b * 3]) / 2,
        (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2,
        (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2,
      );
      mid.set(key, at);
    }
    return at;
  };
  for (let f = 0; f < mesh.faces.length; f += 3) {
    const a = mesh.faces[f]; const b = mesh.faces[f + 1]; const c = mesh.faces[f + 2];
    const ab = midpoint(a, b); const bc = midpoint(b, c); const ca = midpoint(c, a);
    faces.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { pos: Float64Array.from(pos), faces: Int32Array.from(faces) };
}

/** Neighbour lists and the unique edge list, both needed every iteration. */
function topology(mesh) {
  const n = mesh.pos.length / 3;
  const adj = Array.from({ length: n }, () => []);
  const seen = new Set();
  const edges = [];
  const link = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(a, b);
    adj[a].push(b);
    adj[b].push(a);
  };
  for (let f = 0; f < mesh.faces.length; f += 3) {
    const a = mesh.faces[f]; const b = mesh.faces[f + 1]; const c = mesh.faces[f + 2];
    link(a, b); link(b, c); link(c, a);
  }
  return { adj, edges: Int32Array.from(edges) };
}

/** Area-weighted vertex normals, pointing out of a consistently wound mesh. */
function normals(mesh) {
  const n = mesh.pos.length / 3;
  const out = new Float64Array(n * 3);
  const p = mesh.pos;
  for (let f = 0; f < mesh.faces.length; f += 3) {
    const a = mesh.faces[f] * 3; const b = mesh.faces[f + 1] * 3; const c = mesh.faces[f + 2] * 3;
    const ux = p[b] - p[a]; const uy = p[b + 1] - p[a + 1]; const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a]; const vy = p[c + 1] - p[a + 1]; const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const at of [a, b, c]) { out[at] += nx; out[at + 1] += ny; out[at + 2] += nz; }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) || 1;
    out[i * 3] /= l; out[i * 3 + 1] /= l; out[i * 3 + 2] /= l;
  }
  return out;
}

/**
 * Distance to the nearest point of the cloud, and which point it was.
 *
 * A hash grid searched in widening rings, so a query near the surface stops
 * after one ring and a query out in the open pays for the emptiness it is
 * crossing rather than for the whole cloud.
 */
function nearestFinder(pts, alive, cell) {
  const bins = new Map();
  const key = (a, b, c) => `${a},${b},${c}`;
  let n = 0;
  for (let i = 0; i < pts.length / 3; i++) {
    if (alive && !alive[i]) continue;
    n++;
    const k = key(
      Math.floor(pts[i * 3] / cell),
      Math.floor(pts[i * 3 + 1] / cell),
      Math.floor(pts[i * 3 + 2] / cell),
    );
    let bin = bins.get(k);
    if (!bin) { bin = []; bins.set(k, bin); }
    bin.push(i);
  }
  if (!n) throw new Error('nothing left to wrap');

  /**
   * How many points are within `r`. The contact test needs this, not just the
   * nearest distance, because a single stray point stops the skin dead and tents
   * the whole sheet off the object behind it — the same way one speck of dust on
   * a mould ruins a vacuum-formed part. It has to take a few dots to hold the
   * skin, and then an outlier the eraser missed is simply pushed past.
   */
  const countWithin = (x, y, z, r) => {
    const bx = Math.floor(x / cell); const by = Math.floor(y / cell); const bz = Math.floor(z / cell);
    const reach = Math.ceil(r / cell);
    let hits = 0;
    for (let a = -reach; a <= reach; a++) {
      for (let b = -reach; b <= reach; b++) {
        for (let c = -reach; c <= reach; c++) {
          const bin = bins.get(key(bx + a, by + b, bz + c));
          if (!bin) continue;
          for (const i of bin) {
            if ((pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2 + (pts[i * 3 + 2] - z) ** 2 <= r * r) hits++;
          }
        }
      }
    }
    return hits;
  };

  const find = (x, y, z, maxRing = 12) => {
    const bx = Math.floor(x / cell); const by = Math.floor(y / cell); const bz = Math.floor(z / cell);
    let best = Infinity;
    let at = -1;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let a = -ring; a <= ring; a++) {
        for (let b = -ring; b <= ring; b++) {
          for (let c = -ring; c <= ring; c++) {
            // Only the shell of the ring; the inside was searched already.
            if (ring > 0 && Math.abs(a) !== ring && Math.abs(b) !== ring && Math.abs(c) !== ring) continue;
            const bin = bins.get(key(bx + a, by + b, bz + c));
            if (!bin) continue;
            for (const i of bin) {
              const d2 = (pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2 + (pts[i * 3 + 2] - z) ** 2;
              if (d2 < best) { best = d2; at = i; }
            }
          }
        }
      }
      // Everything in the next ring is at least `ring * cell` away, so once the
      // best so far beats that there is nothing left worth looking at.
      if (best < (ring * cell) ** 2) break;
    }
    return { d: Math.sqrt(best), at };
  };
  find.countWithin = countWithin;
  return find;
}

/**
 * Pull a skin onto the cloud.
 *
 * `skin`     how far off the points the surface settles, in metres. The scan's
 *            own fuzz band is the floor: aim closer than the data is certain and
 *            the skin just picks up noise.
 * `tension`  0 to 1. The sheet's springiness, which is what decides whether it
 *            spans a hole or sags into it. Annealed away over each level, so this
 *            is the strength it STARTS with.
 * `levels`   how many times to refine. Each one quadruples the triangles.
 */
export async function wrap(pts, alive, opts = {}) {
  const skin = opts.skin ?? 0.003;
  const tension = Math.min(1, Math.max(0, opts.tension ?? 0.5));
  const levels = opts.levels ?? 3;
  const itersPer = opts.iters ?? 100;
  const onProgress = opts.onProgress || (() => {});
  // How many points it takes to hold the skin. One is not enough: see
  // countWithin. Three is enough to be a surface and not a speck.
  const SUPPORT = opts.support ?? 3;

  // The room: a sphere comfortably outside everything that is left.
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length / 3; i++) {
    if (alive && !alive[i]) continue;
    for (let k = 0; k < 3; k++) {
      const v = pts[i * 3 + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const center = lo.map((v, k) => (v + hi[k]) / 2);
  const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 * 1.15;

  let mesh = icosphere(2);
  for (let i = 0; i < mesh.pos.length; i += 3) {
    mesh.pos[i] = center[0] + mesh.pos[i] * radius;
    mesh.pos[i + 1] = center[1] + mesh.pos[i + 1] * radius;
    mesh.pos[i + 2] = center[2] + mesh.pos[i + 2] * radius;
  }
  mesh.faces = Int32Array.from(mesh.faces);

  const nearest = nearestFinder(pts, alive, Math.max(skin * 2, 0.002));
  const totalIters = levels * itersPer;
  let done = 0;

  for (let level = 0; level < levels; level++) {
    const { adj, edges } = topology(mesh);
    const nv = mesh.pos.length / 3;
    const frozen = new Uint8Array(nv);

    // Rest length is what the mesh arrived with; nothing may stretch far past it.
    let rest = 0;
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e] * 3; const b = edges[e + 1] * 3;
      rest += Math.hypot(mesh.pos[a] - mesh.pos[b], mesh.pos[a + 1] - mesh.pos[b + 1], mesh.pos[a + 2] - mesh.pos[b + 2]);
    }
    rest /= edges.length / 2;
    // Fixed, and NOT a function of tension. Letting the slider control both the
    // springiness and how far the sheet may stretch made it useless at either
    // end: slack sheets crumpled and self-intersected, taut ones never touched
    // the object. A membrane does not get stretchier when it gets less springy.
    // Loosened over the run, the way the plastic is hotter later. Held tight it
    // is the binding constraint and the sheet never reaches the object at all;
    // this is the number that decides whether the skin can enter a crevice.
    const maxEdgeAt = (t) => rest * (1.6 + 2.4 * t);
    // Small enough that tension and stiffness get a say. A full jump to the
    // nearest point would reach the far side of a hole in one move.
    const maxStep = Math.max(skin * 0.5, rest * 0.25);

    for (let iter = 0; iter < itersPer; iter++) {
      const nrm = normals(mesh);
      // Annealed: springy at the start so the sheet takes the gross shape
      // without creasing, slack by the end so it can settle into the detail.
      // Held at one value it either never conforms or conforms to noise.
      const springy = tension * (1 - 0.85 * (iter / (itersPer - 1)));

      // 1. the vacuum
      for (let v = 0; v < nv; v++) {
        if (frozen[v]) continue;
        const { d, at } = nearest(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]);
        if (d <= skin * 1.05 && nearest.countWithin(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2], skin * 1.6) >= SUPPORT) {
          frozen[v] = 1;
          continue;
        }

        // Which way "in" is, and this is the fix for the sheet folding over
        // itself. Marching along the normal is what lets the skin reach into the
        // gap between two legs, but once any part of it has creased, the normal
        // there points somewhere useless and the vacuum happily drives the fold
        // deeper. Aiming at the nearest point instead cannot do that: every
        // vertex converges on the data rather than on a direction.
        //
        // So it is a blend, weighted by how far there is still to go. Far out,
        // the normal leads and the sheet descends as a sheet. Close in,
        // projection takes over and it lands cleanly without creasing.
        const near = Math.min(1, Math.max(0, (d - skin) / (rest * 3)));
        let dx = -nrm[v * 3]; let dy = -nrm[v * 3 + 1]; let dz = -nrm[v * 3 + 2];
        if (at >= 0 && near < 1) {
          const tx = pts[at * 3] - mesh.pos[v * 3];
          const ty = pts[at * 3 + 1] - mesh.pos[v * 3 + 1];
          const tz = pts[at * 3 + 2] - mesh.pos[v * 3 + 2];
          const tl = Math.hypot(tx, ty, tz) || 1;
          dx = dx * near + (tx / tl) * (1 - near);
          dy = dy * near + (ty / tl) * (1 - near);
          dz = dz * near + (tz / tl) * (1 - near);
          const dl = Math.hypot(dx, dy, dz) || 1;
          dx /= dl; dy /= dl; dz /= dl;
        }
        // Moving less than (d - skin) cannot bring this vertex closer than
        // `skin` to anything, whichever way it goes. So the skin can never pass
        // through the surface, however coarse the step.
        const step = Math.min(d - skin, maxStep);
        mesh.pos[v * 3] += dx * step;
        mesh.pos[v * 3 + 1] += dy * step;
        mesh.pos[v * 3 + 2] += dz * step;
      }

      // 2. tension — Taubin, so the sheet springs without deflating.
      //
      // WHERE THIS STOPS. The sheet arrives as a taut closed skin and does not
      // fully conform: on the pig the points end up inside it. The cause is not
      // a parameter, it is the metaphor. Stiffness is what makes a membrane
      // bridge a hole the capture never saw, and it is the same stiffness that
      // refuses to descend into the gap between two legs. Real vacuum forming
      // has exactly this limitation, which is why moulds need draft angles and
      // cannot have undercuts — and a pig's legs are undercuts.
      //
      // Making stiffness local, on the reasoning that a crevice has data at the
      // bottom of it and a hole does not, was tried and is worse: freeing those
      // edges lets single vertices run away and drag spikes out of the sheet.
      // The next thing to try is dropping the membrane entirely for a plain
      // projection, and getting the hole-bridging from a separate pass that only
      // spans where there is no data within a large radius.
      for (const [k, w] of [[0.45 * springy, 1], [-0.47 * springy, 1]]) {
        const next = Float64Array.from(mesh.pos);
        for (let v = 0; v < nv; v++) {
          const near = adj[v];
          if (!near.length) continue;
          let sx = 0; let sy = 0; let sz = 0;
          for (const j of near) { sx += mesh.pos[j * 3]; sy += mesh.pos[j * 3 + 1]; sz += mesh.pos[j * 3 + 2]; }
          const m = near.length;
          // A vertex already resting on the data is moved less, so smoothing
          // relaxes the free parts of the sheet without dragging the parts that
          // have already found the object.
          const g = k * (frozen[v] ? 0.25 : 1) * w;
          next[v * 3] += g * (sx / m - mesh.pos[v * 3]);
          next[v * 3 + 1] += g * (sy / m - mesh.pos[v * 3 + 1]);
          next[v * 3 + 2] += g * (sz / m - mesh.pos[v * 3 + 2]);
        }
        mesh.pos = next;
      }

      // 3. stiffness — no edge stretches far past its rest length. This is what
      //    holds the sheet across a hole the capture never saw.
      const maxEdge = maxEdgeAt(iter / (itersPer - 1));
      for (let pass = 0; pass < 2; pass++) {
        for (let e = 0; e < edges.length; e += 2) {
          const a = edges[e] * 3; const b = edges[e + 1] * 3;
          let dx = mesh.pos[b] - mesh.pos[a];
          let dy = mesh.pos[b + 1] - mesh.pos[a + 1];
          let dz = mesh.pos[b + 2] - mesh.pos[a + 2];
          const len = Math.hypot(dx, dy, dz);
          if (len <= maxEdge || len < 1e-12) continue;
          const pull = (len - maxEdge) / len * 0.5;
          dx *= pull; dy *= pull; dz *= pull;
          mesh.pos[a] += dx; mesh.pos[a + 1] += dy; mesh.pos[a + 2] += dz;
          mesh.pos[b] -= dx; mesh.pos[b + 1] -= dy; mesh.pos[b + 2] -= dz;
        }
      }

      // 4. contact — nothing is allowed to end up inside the data
      for (let v = 0; v < nv; v++) {
        if (nearest(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]).d <= skin * 1.05
          && nearest.countWithin(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2], skin * 1.6) >= SUPPORT) {
          frozen[v] = 1;
        }
      }

      done++;
      if (iter % 4 === 0) {
        let stuck = 0;
        for (let v = 0; v < nv; v++) stuck += frozen[v];
        onProgress({
          frac: done / totalIters,
          level: level + 1,
          levels,
          triangles: mesh.faces.length / 3,
          touching: stuck / nv,
        });
        // Let the page draw. Without this the tab is frozen for the whole run
        // and there is nothing to watch, which on a tool like this is most of
        // the value: you can see whether the sheet is behaving.
        //
        // Raced against a timer because requestAnimationFrame does not fire at
        // all in a tab that is not being composited — switch away mid-vacuum and
        // awaiting it alone would stall the run until you switched back.
        await new Promise((r) => {
          let done = false;
          const fire = () => { if (!done) { done = true; r(); } };
          requestAnimationFrame(fire);
          setTimeout(fire, 60);
        });
      }
    }
    if (level < levels - 1) mesh = subdivide(mesh);
  }
  return mesh;
}
