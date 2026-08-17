// The build: a splat cloud in, a low-poly flat-shaded mesh out.
//
// This is the whole algorithm, and it lives here rather than in the tool that
// used to own it because there are now two callers with equal claim on it —
// tools/splat2glb.mjs at the command line, and the Splat Editor in the page. A
// second copy would drift, and the one thing that must never differ between
// them is what the pipeline does: the point of building in the editor is to see
// what the tool would produce, and an approximation of it answers a different
// question. Neither side gets to hold the original.
//
// Nothing in here touches the filesystem, the DOM, three.js or process.argv.
// It takes typed arrays and numbers and returns typed arrays and numbers, which
// is what lets both hosts import it unchanged. Reading files, writing GLBs and
// parsing flags stay with whichever host is doing them.
//
// The stages, in order:
//
//   cull          drop the haze and the specks the capture left in the air
//   density       a grid of how much splat weight sits in each cell
//   silhouetteHull  trace the outline from N directions, keep what is inside all
//   despeckle     majority vote, then the largest connected piece
//   surfaceNets   the boundary of that solid, as quads split into triangles
//   smooth        Taubin, which shrinks far less than plain Laplacian
//   decimate      quadric error collapses down to the triangle budget
//   colorize      cluster the scan's colors into flat groups
//   orient        stand it up the way --up asks
//
// Read the header of tools/splat2glb.mjs for what each knob is for and which
// ones carry the risk.

export function cull(pts, o = {}) {
  const GRID = o.grid ?? 64;
  const MIN_OPACITY = o.minOpacity ?? 0.3;
  const MIN_LUM = o.minLum ?? 0;
  const CROP = o.crop ?? null;
  const ISOLATION = o.isolation ?? 6;
  const ISO_RADIUS = o.isolationRadius ?? 0;
  // Reported back on the result: the caller wants to print what 'nearby' meant,
  // and it is measured from the scan rather than given.
  let isolationRadius = 0;
  const keep = new Uint8Array(pts.count);
  let n = 0;
  for (let i = 0; i < pts.count; i++) {
    if (pts.opacity[i] < MIN_OPACITY) continue;
    if (MIN_LUM > 0 && (pts.rgb[i * 3] + pts.rgb[i * 3 + 1] + pts.rgb[i * 3 + 2]) / 3 < MIN_LUM) continue;
    if (CROP && (
      pts.x[i] < CROP[0] || pts.y[i] < CROP[1] || pts.z[i] < CROP[2]
      || pts.x[i] > CROP[3] || pts.y[i] > CROP[4] || pts.z[i] > CROP[5]
    )) continue;
    keep[i] = 1; n++;
  }
  if (!n) throw new Error(`--min-opacity ${MIN_OPACITY}${MIN_LUM ? ' and --min-lum' : ''}${CROP ? ' and --crop' : ''} kept nothing`);

  // Bounds of what survived, which is also what sets the grid.
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.count; i++) {
    if (!keep[i]) continue;
    const v = [pts.x[i], pts.y[i], pts.z[i]];
    for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  }
  const cell = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / GRID;

  if (ISOLATION > 0) {
    // How far apart the scan actually sampled the surface, measured here rather
    // than inferred from the output grid.
    //
    // This radius used to be two output cells, which made the cull scale with
    // --grid: asking for finer output silently discarded more of the input, and
    // on this scan the difference between grid 64 and grid 128 was 17,585 splats
    // kept against 10,992. That is backwards. Whether a splat is a lone speck in
    // clear air is a fact about the CAPTURE — how densely it sampled, and how far
    // its neighbours are — and it cannot depend on how many triangles are wanted
    // at the other end of the pipeline.
    const step = Math.max(1, Math.floor(n / 4000));
    const gh = cell * 2;
    const rough = new Map();
    for (let i = 0; i < pts.count; i++) {
      if (!keep[i]) continue;
      const k = `${Math.floor(pts.x[i] / gh)},${Math.floor(pts.y[i] / gh)},${Math.floor(pts.z[i] / gh)}`;
      if (!rough.has(k)) rough.set(k, []);
      rough.get(k).push(i);
    }
    const near = [];
    for (let i = 0; i < pts.count; i += step) {
      if (!keep[i]) continue;
      const bx = Math.floor(pts.x[i] / gh); const by = Math.floor(pts.y[i] / gh); const bz = Math.floor(pts.z[i] / gh);
      let best = Infinity;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const bin = rough.get(`${bx + a},${by + b},${bz + c}`);
        if (!bin) continue;
        for (const j of bin) {
          if (j === i) continue;
          const dx = pts.x[j] - pts.x[i]; const dy = pts.y[j] - pts.y[i]; const dz = pts.z[j] - pts.z[i];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < best) best = d;
        }
      }
      if (best < Infinity) near.push(Math.sqrt(best));
    }
    near.sort((a, b) => a - b);
    const spacing = near.length ? near[Math.floor(near.length / 2)] : cell;
    // Three spacings: far enough that a point on a properly sampled surface has
    // its whole first ring of neighbours inside, close enough that a speck in
    // clear air has nothing.
    const radius = ISO_RADIUS > 0 ? ISO_RADIUS : spacing * 3;
    isolationRadius = radius;

    // Neighbor counting through a hash grid at the search radius, so "near"
    // is one bucket and its 26 neighbors and nothing has to be sorted.
    const h = radius;
    const key = (i) => `${Math.floor(pts.x[i] / h)},${Math.floor(pts.y[i] / h)},${Math.floor(pts.z[i] / h)}`;
    const bins = new Map();
    for (let i = 0; i < pts.count; i++) {
      if (!keep[i]) continue;
      const k = key(i);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(i);
    }
    const r2 = radius * radius;
    for (let i = 0; i < pts.count; i++) {
      if (!keep[i]) continue;
      const cx = Math.floor(pts.x[i] / h); const cy = Math.floor(pts.y[i] / h); const cz = Math.floor(pts.z[i] / h);
      let close = 0;
      for (let a = -1; a <= 1 && close < ISOLATION; a++) {
        for (let b = -1; b <= 1 && close < ISOLATION; b++) {
          for (let c = -1; c <= 1 && close < ISOLATION; c++) {
            const bin = bins.get(`${cx + a},${cy + b},${cz + c}`);
            if (!bin) continue;
            for (const j of bin) {
              if (j === i) continue;
              const dx = pts.x[j] - pts.x[i]; const dy = pts.y[j] - pts.y[i]; const dz = pts.z[j] - pts.z[i];
              if (dx * dx + dy * dy + dz * dz <= r2 && ++close >= ISOLATION) break;
            }
          }
        }
      }
      if (close < ISOLATION) { keep[i] = 0; n--; }
    }
  }
  if (!n) throw new Error(`--isolation ${ISOLATION} kept nothing`);

  // Re-measure: dropping the floaters is what makes these bounds tight, and
  // they are the ones the grid is built on.
  lo = [Infinity, Infinity, Infinity];
  hi = [-Infinity, -Infinity, -Infinity];
  const out = { n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), w: new Float64Array(n), r: new Float64Array(n), rgb: new Float64Array(n * 3) };
  let j = 0;
  for (let i = 0; i < pts.count; i++) {
    if (!keep[i]) continue;
    out.x[j] = pts.x[i]; out.y[j] = pts.y[i]; out.z[j] = pts.z[i];
    out.w[j] = pts.opacity[i];
    out.r[j] = pts.radius[i];
    out.rgb[j * 3] = pts.rgb[i * 3]; out.rgb[j * 3 + 1] = pts.rgb[i * 3 + 1]; out.rgb[j * 3 + 2] = pts.rgb[i * 3 + 2];
    for (const [k, v] of [[0, out.x[j]], [1, out.y[j]], [2, out.z[j]]]) {
      if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
    }
    j++;
  }
  out.lo = lo; out.hi = hi;
  out.isolationRadius = isolationRadius;
  return out;
}

/**
 * Median distance to a splat's nearest neighbor — how finely the scan actually
 * sampled the surface.
 *
 * This is the number that decides everything downstream and it is not the same
 * as the splat scale: a trainer will happily fit a 1mm ellipsoid to a patch it
 * only sampled every 3mm, because a splat is sized to look right from the
 * camera, not to tile the surface. Reconstruct at the scale it was drawn at and
 * you get a shell full of pinholes, the fill leaks straight through it, and what
 * comes back is a crumpled bag rather than a pig.
 */
export function spacingOf(p, hint) {
  const h = hint;
  const bins = new Map();
  const key = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  for (let i = 0; i < p.n; i++) {
    const k = key(p.x[i], p.y[i], p.z[i]);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(i);
  }
  const step = Math.max(1, Math.floor(p.n / 4000));
  const dists = [];
  for (let i = 0; i < p.n; i += step) {
    const bx = Math.floor(p.x[i] / h); const by = Math.floor(p.y[i] / h); const bz = Math.floor(p.z[i] / h);
    let best = Infinity;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const bin = bins.get(`${bx + a},${by + b},${bz + c}`);
          if (!bin) continue;
          for (const j of bin) {
            if (j === i) continue;
            const d2 = (p.x[j] - p.x[i]) ** 2 + (p.y[j] - p.y[i]) ** 2 + (p.z[j] - p.z[i]) ** 2;
            if (d2 < best) best = d2;
          }
        }
      }
    }
    if (best < Infinity) dists.push(Math.sqrt(best));
  }
  dists.sort((a, b) => a - b);
  return dists.length ? dists[Math.floor(dists.length / 2)] : hint;
}

// ----------------------------------------------------------------- the density
// Every splat is stamped into the grid as an isotropic Gaussian weighted by its
// opacity. Its width is the largest of three things: the splat's own scale, what
// it takes to reach the next splat along, and three quarters of a cell. The
// middle one is what makes the shell watertight, and it is the difference
// between this working and this producing a crumpled bag.
const REACH = 4;

export function density(p, dim, lo, cell, floor) {
  const [nx, ny, nz] = dim;
  const f = new Float32Array(nx * ny * nz);
  // Which cells actually hold a splat, as opposed to merely catching the tail of
  // one. This is what the surface level gets calibrated against below.
  const support = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < p.n; i++) {
    const sa = Math.floor((p.x[i] - lo[0]) / cell);
    const sb = Math.floor((p.y[i] - lo[1]) / cell);
    const sc = Math.floor((p.z[i] - lo[2]) / cell);
    if (sa >= 0 && sa < nx && sb >= 0 && sb < ny && sc >= 0 && sc < nz) support[(sc * ny + sb) * nx + sa] = 1;
  }
  for (let i = 0; i < p.n; i++) {
    const sigma = Math.max(p.r[i], floor, cell * 0.75);
    const reach = Math.min(REACH, Math.ceil((sigma * 2.2) / cell));
    const gx = (p.x[i] - lo[0]) / cell;
    const gy = (p.y[i] - lo[1]) / cell;
    const gz = (p.z[i] - lo[2]) / cell;
    const cx = Math.round(gx); const cy = Math.round(gy); const cz = Math.round(gz);
    const k = -0.5 / ((sigma / cell) ** 2);
    for (let a = cx - reach; a <= cx + reach; a++) {
      if (a < 0 || a >= nx) continue;
      const dx = a - gx;
      for (let b = cy - reach; b <= cy + reach; b++) {
        if (b < 0 || b >= ny) continue;
        const dy = b - gy;
        for (let c = cz - reach; c <= cz + reach; c++) {
          if (c < 0 || c >= nz) continue;
          const dz = c - gz;
          f[(c * ny + b) * nx + a] += p.w[i] * Math.exp(k * (dx * dx + dy * dy + dz * dz));
        }
      }
    }
  }
  return { f, support };
}

/** Grid neighbors, 6-connected, as flat indices. */
export function* neighbors6(idx, nx, ny, nz) {
  const a = idx % nx;
  const b = Math.floor(idx / nx) % ny;
  const c = Math.floor(idx / (nx * ny));
  if (a > 0) yield idx - 1;
  if (a < nx - 1) yield idx + 1;
  if (b > 0) yield idx - nx;
  if (b < ny - 1) yield idx + nx;
  if (c > 0) yield idx - nx * ny;
  if (c < nz - 1) yield idx + nx * ny;
}

/**
 * Majority vote over each cell's 26 neighbors, a few times.
 *
 * A threshold on a real scan does not give a clean body: it gives a body with
 * grit stuck to it and pinpricks taken out of it, and the isosurface of THAT is
 * a crumpled bag whatever the triangle budget. Nothing downstream can recover
 * from it — the decimator will happily spend its budget describing the grit.
 * This is the cheapest thing that removes a speck and fills a prick while
 * leaving anything the width of a leg completely alone.
 */
export function despeckle(solid, dim, rounds) {
  const [nx, ny, nz] = dim;
  let cur = solid;
  for (let pass = 0; pass < rounds; pass++) {
    const next = new Uint8Array(cur.length);
    for (let c = 0; c < nz; c++) {
      for (let b = 0; b < ny; b++) {
        for (let a = 0; a < nx; a++) {
          let on = 0;
          let seen = 0;
          for (let k = -1; k <= 1; k++) {
            const cz = c + k;
            if (cz < 0 || cz >= nz) continue;
            for (let j = -1; j <= 1; j++) {
              const cy = b + j;
              if (cy < 0 || cy >= ny) continue;
              for (let i = -1; i <= 1; i++) {
                const cx = a + i;
                if (cx < 0 || cx >= nx) continue;
                seen++;
                on += cur[(cz * ny + cy) * nx + cx];
              }
            }
          }
          next[(c * ny + b) * nx + a] = on * 2 > seen ? 1 : 0;
        }
      }
    }
    cur = next;
  }
  return cur;
}

// ------------------------------------------------------------------- the hull
// Trace the outline from every angle and keep what is inside all of them.
//
// This is Jayce's, and it is the one that works. Look at the cloud from some
// direction, draw round the outside of it, turn it, draw round it again, and
// keep only what falls inside every outline. A classical visual hull, arrived at
// by describing what a person actually does.
//
// The reason it succeeds where four cleverer things failed is one step: FILLING
// the outline. Everything else here asked a question that a gap could answer
// wrongly. Is this neighbourhood a plane — no, the points are a slab. Does this
// ray enter and leave — not if it slipped through a hole. Is this cell above the
// density — not where coverage is thin. Every one of them is defeated by the
// porosity of the shell.
//
// An outline is not. The holes in this scan are all INSIDE the silhouette, and
// filling it from the border inward makes them vanish: a pixel is inside if the
// outside cannot reach it, and the outside cannot reach a hole surrounded by
// pig. So the single most damaging property of the data stops mattering, and
// what is left is a question the projection answers cleanly at every angle —
// which is exactly where the statistics were all along.
//
// What it cannot do is concavities that never show up on any outline. That is
// the known price of a visual hull, and on this object it is the right trade:
// there is nothing on a rubber pig that is invisible from all directions except
// the gap between the legs, and that one IS visible from the side.
/**
 * The boundary of a filled region, as a closed ring of pixels.
 *
 * Only for looking at: the carve works on the raster. But "trace the outline"
 * is what this step is FOR, and being able to see the outline it actually drew
 * is the difference between believing that and checking it.
 */
export function outlineOf(sil, w, h) {
  const edge = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!sil[y * w + x]) continue;
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1
        || !sil[y * w + x - 1] || !sil[y * w + x + 1] || !sil[(y - 1) * w + x] || !sil[(y + 1) * w + x];
      if (border) edge.push([x, y]);
    }
  }
  return edge;
}

// --------------------------------------------------------------- the real ring
// Selecting the points on the edge, rather than the pixels near them.
//
// What came before this walked the boundary of a FILLED RASTER: the points were
// stamped into a pixel grid, the grid was dilated until the gaps between them
// sealed, and the outline was whichever pixels ended up on the rim. That outline
// is near the edge of the pig but it is not made of the pig — it sits on a pixel
// lattice, and it sits OUTSIDE the real edge by however much dilation that view
// needed, up to nine cells. The whole model then had to be shrunk back at the
// end by a single guessed amount to undo it, which is precisely the step that
// left the volume short: views that only needed two pixels got eroded by six.
//
// Selecting real points removes both problems at once, because a vertex that IS
// a measured point cannot be in the wrong place. The dilation goes back to being
// what it always should have been — scaffolding used to work out WHICH points
// are on the edge, thrown away before anything is built. Nothing is fattened, so
// nothing has to be shrunk, and the correction is per-view and per-location
// instead of one number applied everywhere.
/**
 * Walk the rim of a filled region as an ordered ring of pixels.
 *
 * Moore-neighbour tracing: step to the next filled pixel going round clockwise
 * from wherever you came in, and you are round the outside of the shape. Started
 * from the topmost-then-leftmost pixel, which is always on the rim and always
 * has empty space to its west, so the first sweep begins outside the shape.
 */
export function traceRing(mask, w, h, sx, sy) {
  const N = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  const ring = [[sx, sy]];
  let cx = sx; let cy = sy;
  let back = 0; // we arrived from the west
  let guard = 4 * w * h;
  for (;;) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const j = (back + k) % 8;
      const nx = cx + N[j][0];
      const ny = cy + N[j][1];
      if (!at(nx, ny)) continue;
      back = (j + 4) % 8; // the way back to where we just were
      cx = nx; cy = ny;
      moved = true;
      break;
    }
    if (!moved) break; // a single isolated pixel
    if (cx === sx && cy === sy) break;
    ring.push([cx, cy]);
    if (--guard <= 0) break;
  }
  return ring;
}

/** Even-odd scanline fill of a closed polygon given in pixel coordinates. */
export function fillPolygon(poly, w, h, out) {
  const xs = [];
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const y1 = poly[j][1]; const y2 = poly[i][1];
      if ((y1 > yc) === (y2 > yc)) continue;
      xs.push(poly[j][0] + ((yc - y1) / (y2 - y1)) * (poly[i][0] - poly[j][0]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) out[y * w + x] = 1;
    }
  }
}

/**
 * The silhouette as closed rings of real points, and the region they enclose.
 *
 * Each connected piece of the sealed fill is walked, every rim pixel is snapped
 * to the nearest point that was actually stamped there, consecutive repeats are
 * dropped, and what is left is a closed polygon whose every vertex is a splat.
 * Filling those polygons gives the silhouette that carves the volume — at the
 * true edge, with no dilation left in it.
 *
 * @returns {{ sil: Uint8Array, rings: number[][] }} rings hold point indices.
 */
export function pointRing(walk0, raw, stamp, w, h, reach) {
  const sil = walk0;
  const who = stamp.grid;
  const label = new Int32Array(w * h).fill(-1);
  const starts = [];
  for (let s = 0; s < w * h; s++) {
    if (!sil[s] || label[s] >= 0) continue;
    const id = starts.length;
    let size = 0;
    const q = [s];
    label[s] = id;
    while (q.length) {
      const i = q.pop();
      size++;
      const x = i % w; const y = (i - x) / w;
      if (x > 0 && sil[i - 1] && label[i - 1] < 0) { label[i - 1] = id; q.push(i - 1); }
      if (x < w - 1 && sil[i + 1] && label[i + 1] < 0) { label[i + 1] = id; q.push(i + 1); }
      if (y > 0 && sil[i - w] && label[i - w] < 0) { label[i - w] = id; q.push(i - w); }
      if (y < h - 1 && sil[i + w] && label[i + w] < 0) { label[i + w] = id; q.push(i + w); }
    }
    starts.push({ s, size });
  }

  // Which point a rim pixel belongs to. Nearest in the picture is necessary and
  // not sufficient: a pixel has the near surface and the far one behind it, and
  // where the near surface has a hole — which this scan is full of — the closest
  // stamp belongs to the BACK of the object. Follow that and the outline is
  // right in projection while lurching a hundred millimetres through the pig,
  // which is no use as a curve and worse as a line to look at.
  //
  // So: shortlist by distance in the picture, decide by continuity in space.
  // Everything within a pixel and a half of the closest candidate is equally
  // defensible as "the edge here", and among those the one nearest the point
  // just placed is the one on the same surface.
  // The nearest stamped point, and nothing cleverer.
  //
  // Two cleverer rules were tried and both cost more than they returned. Taking
  // the point nearest the viewer resolves the near-surface/far-surface ambiguity
  // in principle, but the ambiguity is not where the error is, and it measured
  // worse. Pulling each point toward the one before it, to keep the ring a
  // continuous curve, does smooth the ring — and distorts the polygon it is
  // made of, because these vertices are not decoration, they are the outline
  // that carves the model. At a weight of 2 it cut the volume by 30% and broke
  // the hull into seven pieces.
  //
  // What is left is a short reach and the nearest point in the picture. The
  // reach is short because the rim it walks has already had the dilation taken
  // off it, so the real edge is a pixel or two away and anything further is
  // something else.
  const nearest = (x, y) => {
    let bestI = -1; let bestD = Infinity;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const X = x + dx; const Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const i = who[Y * w + X];
        if (i < 0) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestI = i; }
      }
    }
    return bestI;
  };

  const out = new Uint8Array(w * h);
  const rings = [];
  for (const { s, size } of starts) {
    if (size < 4) continue;
    const sx = s % w; const sy = (s - sx) / w;
    const walk = traceRing(sil, w, h, sx, sy);
    const idx = [];
    for (const [x, y] of walk) {
      const i = nearest(x, y);
      if (i < 0) continue;
      if (idx.length && idx[idx.length - 1] === i) continue;
      idx.push(i);
    }
    while (idx.length > 1 && idx[0] === idx[idx.length - 1]) idx.pop();
    // Nothing real close enough to walk. The caller keeps its raster silhouette
    // for this view rather than losing the piece — better one fat outline than a
    // hole punched through the hull.
    if (idx.length < 3) return { sil: null, rings: [] };
    rings.push(idx);
  }
  for (const idx of rings) {
    fillPolygon(idx.map((i) => [stamp.px[i], stamp.py[i]]), w, h, out);
  }
  // A point can sit a hair outside its own polygon, since the polygon runs
  // through the middle of the ones on the rim. Union the stamps back in.
  for (let i = 0; i < w * h; i++) if (raw[i]) out[i] = 1;
  return { sil: out, rings };
}

/**
 * Directions spread evenly over a hemisphere, on a Fibonacci spiral.
 *
 * A hull is only ever as tight as its worst-covered direction, so what matters
 * is the largest gap between neighbouring views rather than how many there are.
 * This has no largest gap worth the name — every direction has the same amount
 * of sky around it.
 *
 * A hemisphere and not a sphere because a silhouette does not care which end of
 * its axis you stand at: looking from straight ahead and from straight behind
 * projects onto the same plane and fills the same cells. The opposite half would
 * be a second copy of the same measurements.
 */
export function spiralDirections(count, handed = 1) {
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let d = 0; d < count; d++) {
    const z = (d + 0.5) / count;
    const rr = Math.sqrt(Math.max(0, 1 - z * z));
    const th = d * GOLDEN * handed;
    out.push([rr * Math.cos(th), rr * Math.sin(th), z]);
  }
  return out;
}

/**
 * Every direction and its opposite.
 *
 * Looking from in front and from behind projects onto the same plane, so for the
 * FILL these are the same measurement — but not for the ring. A rim pixel is
 * snapped to the point nearest the viewer, and "nearest" swaps ends when the
 * viewer does, so the two polygons are built from different measured points and
 * come out slightly different. The pair is therefore two independent estimates
 * of one silhouette, which is a way to see the noise rather than a way to
 * reduce it: under intersection the smaller of the two always wins.
 */
export function withAntipodes(dirs) {
  const out = [];
  for (const d of dirs) { out.push(d); out.push([-d[0], -d[1], -d[2]]); }
  return out;
}

/**
 * The literal version: turn the model by a fixed step about x, then about y,
 * then about z, and trace it at every stop.
 *
 * Kept because it is the instruction this whole approach came from and because
 * it is the honest thing to compare against. Its weakness is geometric rather
 * than a matter of count: every direction it produces lies on one of three great
 * circles, so the four diagonal octants are never looked into at all, however
 * fine the step. Halving the step doubles the views along circles that were
 * already the well-covered part.
 *
 * Turning a full 360 degrees also visits each direction twice — the second half
 * of every circle is the first half seen from behind, and a silhouette is the
 * same either way — so two thirds of the views it returns are duplicates once
 * the three circles' four shared crossings are counted as well.
 */
export function axisSweep(stepDeg) {
  const out = [];
  const n = Math.max(1, Math.round(360 / stepDeg));
  for (let a = 0; a < n; a++) {
    const t = (a * 2 * Math.PI) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([0, c, s]);   // turning about x
    out.push([s, 0, c]);   // about y
    out.push([c, s, 0]);   // about z
  }
  return out;
}

/** How many of those point in a genuinely different direction. */
export function distinctDirections(dirs) {
  const seen = new Set();
  for (const d of dirs) {
    // Fold antipodes together, then round, so d and -d count once.
    const f = d[2] < 0 || (d[2] === 0 && (d[1] < 0 || (d[1] === 0 && d[0] < 0))) ? [-d[0], -d[1], -d[2]] : d;
    seen.add(f.map((q) => q.toFixed(4)).join(','));
  }
  return seen.size;
}

export async function silhouetteHull(p, dim, lo, cell, count, maxClose, traces, rings3, sweep, consensus, handed = 1, both = false, onView = null) {
  const [nx, ny, nz] = dim;
  const ringsByView = [];
  const metaByView = [];
  const live = [];
  for (let i = 0; i < nx * ny * nz; i++) live.push(i);
  const cx = new Float64Array(live.length);
  const cy = new Float64Array(live.length);
  const cz = new Float64Array(live.length);
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    cx[k] = lo[0] + (i % nx) * cell;
    cy[k] = lo[1] + (Math.floor(i / nx) % ny) * cell;
    cz[k] = lo[2] + Math.floor(i / (nx * ny)) * cell;
  }
  let alive = live;
  let ax = cx; let ay = cy; let az = cz;
  let miss = new Int32Array(live.length);

  const radii = [];
  let dirs = sweep > 0 ? axisSweep(sweep) : spiralDirections(count, handed);
  if (both) dirs = withAntipodes(dirs);
  const budget = Math.floor((1 - consensus) * dirs.length);
  for (let d = 0; d < dirs.length; d++) {
    // Hand the host a moment every so often. A browser needs it to draw a frame
    // — four hundred and eighty outlines is several seconds with the tab frozen
    // — and Node passes nothing and pays nothing. Every eighth, because awaiting
    // on every one costs more than the tracing does.
    if (onView && (d & 7) === 7) await onView(d / dirs.length);
    const dir = dirs[d];
    let u = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const dp = u[0] * dir[0] + u[1] * dir[1] + u[2] * dir[2];
    u = [u[0] - dir[0] * dp, u[1] - dir[1] * dp, u[2] - dir[2] * dp];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v = [
      dir[1] * u[2] - dir[2] * u[1],
      dir[2] * u[0] - dir[0] * u[2],
      dir[0] * u[1] - dir[1] * u[0],
    ];

    let au = Infinity; let bu = -Infinity; let av = Infinity; let bv = -Infinity;
    for (let i = 0; i < p.n; i++) {
      const su = p.x[i] * u[0] + p.y[i] * u[1] + p.z[i] * u[2];
      const sv = p.x[i] * v[0] + p.y[i] * v[1] + p.z[i] * v[2];
      if (su < au) au = su;
      if (su > bu) bu = su;
      if (sv < av) av = sv;
      if (sv > bv) bv = sv;
    }
    const pad = maxClose + 2;
    const w = Math.ceil((bu - au) / cell) + 2 * pad;
    const h = Math.ceil((bv - av) / cell) + 2 * pad;
    const raw = new Uint8Array(w * h);
    // Which point landed on each pixel, and where each point landed to the
    // fraction. The ring walks pixels but has to come back out as points.
    const stamp = {
      grid: new Int32Array(w * h).fill(-1),
      px: new Float32Array(p.n),
      py: new Float32Array(p.n),
    };
    // A pixel usually has several points behind it — the near surface and the
    // far one, at least. Keep the NEAREST to the viewer, so which point a pixel
    // stands for is a fact about the object rather than whichever one happened
    // to be written last.
    const front = new Float32Array(w * h).fill(-Infinity);
    let mu = 0; let mv = 0;
    for (let i = 0; i < p.n; i++) {
      const su = p.x[i] * u[0] + p.y[i] * u[1] + p.z[i] * u[2];
      const sv = p.x[i] * v[0] + p.y[i] * v[1] + p.z[i] * v[2];
      mu += su / p.n; mv += sv / p.n;
      const fx = (su - au) / cell + pad;
      const fy = (sv - av) / cell + pad;
      stamp.px[i] = fx; stamp.py[i] = fy;
      const sd = p.x[i] * dir[0] + p.y[i] * dir[1] + p.z[i] * dir[2];
      const px = Math.round(fx);
      const py = Math.round(fy);
      if (px >= 0 && py >= 0 && px < w && py < h) {
        raw[py * w + px] = 1;
        if (sd > front[py * w + px]) {
          front[py * w + px] = sd;
          stamp.grid[py * w + px] = i;
        }
      }
    }
    // The middle of the object in this view. If the fill does not contain THIS,
    // the outline had a gap and the border poured through it.
    const heartX = Math.round((mu - au) / cell) + pad;
    const heartY = Math.round((mv - av) / cell) + pad;
    const heart = heartY * w + heartX;

    // Close the outline before filling it. The points are a scatter, not a
    // stroke, so without this the border leaks in through the gaps between them
    // and the fill takes the whole object with it.
    const grow = (src, r, on) => {
      let cur = src;
      for (let s = 0; s < r; s++) {
        const next = cur.slice();
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if ((cur[y * w + x] === 1) !== on) continue;
            if (x > 0) next[y * w + x - 1] = on ? 1 : 0;
            if (x < w - 1) next[y * w + x + 1] = on ? 1 : 0;
            if (y > 0) next[(y - 1) * w + x] = on ? 1 : 0;
            if (y < h - 1) next[(y + 1) * w + x] = on ? 1 : 0;
          }
        }
        cur = next;
      }
      return cur;
    };
    // ADAPTIVE. One closing radius cannot serve every view: where the capture is
    // dense the outline closes at one pixel, and where it looked through the
    // thinly-covered wedge it needs six or seven. Tuned globally, the number is
    // either too small somewhere — and one gap is enough, the border pours in
    // and that view carves a slab out of the middle of the pig — or too large
    // everywhere, which just makes the model fat.
    //
    // So each view is closed by the SMALLEST radius that actually closes it,
    // found by asking rather than by assuming: fill, and check whether the
    // middle of the object survived. If it did not, the outline leaked; widen
    // and try again.
    // Widen until the filled area stops growing. A leaking fill returns barely
    // more than the points themselves; once the outline actually closes, the
    // whole interior comes in at once and the area jumps and then plateaus. The
    // smallest radius reaching that plateau is the one this view needs.
    //
    // (The first version of this asked whether the middle of the object survived
    // the fill. It always did — the middle of a pig lands ON a point, and a
    // masked pixel is never flooded, so the test passed at one pixel for all
    // sixty views and adapted nothing.)
    const fills = [];
    let sil = null;
    let used = maxClose;
    for (let r = 1; r <= maxClose; r++) {
      const mask = grow(raw, r, true);
      const outside = new Uint8Array(w * h);
      const stack = [0];
      outside[0] = 1;
      while (stack.length) {
        const at = stack.pop();
        const x = at % w; const y = (at - x) / w;
        if (x > 0 && !outside[at - 1] && !mask[at - 1]) { outside[at - 1] = 1; stack.push(at - 1); }
        if (x < w - 1 && !outside[at + 1] && !mask[at + 1]) { outside[at + 1] = 1; stack.push(at + 1); }
        if (y > 0 && !outside[at - w] && !mask[at - w]) { outside[at - w] = 1; stack.push(at - w); }
        if (y < h - 1 && !outside[at + w] && !mask[at + w]) { outside[at + w] = 1; stack.push(at + w); }
      }
      const got = new Uint8Array(w * h);
      for (let i = 0; i < got.length; i++) got[i] = outside[i] ? 0 : 1;
      // Judged with the fattening taken back off, or the comparison is rigged:
      // dilation grows the area at every radius whether the outline closed or
      // not, so the raw area rises forever and the largest radius always wins.
      // Eroded back, a leaking fill collapses to roughly the points it started
      // from and a sealed one holds the whole silhouette.
      const back = grow(got, r, false);
      let area = 0;
      for (let i = 0; i < back.length; i++) area += back[i];
      fills.push({ r, area, sil: got });
    }
    const most = Math.max(...fills.map((f) => f.area));
    const pick = fills.find((f) => f.area >= most * 0.97) || fills[fills.length - 1];
    sil = pick.sil;
    used = pick.r;
    void heart;
    radii.push(used);

    // The dilation has done its job — it told us which points are on the edge.
    // Now walk that edge as points and throw the pixels away.
    let rings = null;
    if (rings3) {
      // Walk the rim of the sealed fill with the dilation taken back OFF, not
      // the fat one. The eroded rim runs through the real edge points instead of
      // standing up to nine pixels clear of them, so the search for "which point
      // is this" only has to reach two — and a short reach is what keeps the
      // shortlist free of structure that merely happens to be nearby, which is
      // where the outline was picking up the far side of the object.
      const walked = pointRing(grow(sil, used, false), raw, stamp, w, h, 2);
      if (walked.sil) {
        sil = walked.sil;
        rings = walked.rings;
      }
    }
    ringsByView.push(rings || []);
    metaByView.push({
      direction: dir.map((q) => Number(q.toFixed(5))),
      closing: used,
      points: raw.reduce((a, b) => a + b, 0),
      filled: sil.reduce((a, b) => a + b, 0),
    });

    if (traces) {
      traces.push({
        direction: dir.map((q) => Number(q.toFixed(5))),
        // The frame this outline was drawn in, so anything reading the file can
        // put it back where it belongs in three dimensions:
        //   world = ((px - pad) * cell + au) * u  +  ((py - pad) * cell + av) * v
        //           + depth * direction
        u: u.map((q) => Number(q.toFixed(5))),
        v: v.map((q) => Number(q.toFixed(5))),
        au: Number(au.toFixed(6)), av: Number(av.toFixed(6)), pad,
        width: w, height: h, closing: used,
        points: raw.reduce((a, b) => a + b, 0),
        filled: sil.reduce((a, b) => a + b, 0),
        outline: outlineOf(sil, w, h),
        // The rings as they really are: closed loops of measured points, in
        // world coordinates, so anything reading this file draws the outline
        // itself rather than a re-projection of it.
        rings: rings ? rings.map((idx) => idx.map((i) => [
          Number(p.x[i].toFixed(5)), Number(p.y[i].toFixed(5)), Number(p.z[i].toFixed(5)),
        ])) : null,
      });
    }
    // The growth is NOT undone here. Eroding each of sixty silhouettes shaves
    // the model sixty times over, and the first thing to go is a thin join —
    // a leg parts from the body in one view, and after a few views it has parted
    // in three dimensions. Every outline is left fat by the closing radius and
    // the whole hull is eroded once at the end instead, which takes the same
    // amount off the outside and nothing off the joins.

    // A cell is allowed to fall outside `budget` of the views before it goes.
    //
    // At budget 0 this is the strict intersection, where one view deciding a
    // cell is outside settles it for good. That rule is what carves the gap
    // between the legs — from most angles the legs overlap and the gap is not
    // there, so only a handful of directions ever object to it, and a majority
    // would fill every concavity on the object.
    //
    // It is also what makes the model quietly thinner the harder you look.
    // Measured: tracing the SAME directions from both ends — no new information
    // about the shape whatsoever — takes 3.2% of the volume off, because the two
    // looks disagree slightly and the minimum keeps whichever read short. The
    // damage lands where coverage is thin, which on this scan is the pig's back:
    // its dent doubles in depth between 60 directions and 960.
    //
    // A small budget breaks that without giving up the concavities, but only
    // once there are enough directions for a real feature to be seen by many
    // more views than the budget forgives. At 60 views the leg gap has perhaps
    // four objectors and any budget at all would close it; at 480 it has dozens,
    // and forgiving the four worst leaves it untouched while a lone view that
    // misread a thin column no longer decides anything. So this is the setting
    // that makes going past a couple of hundred directions worth the time —
    // not tightness, which stopped improving at 240, but robustness.
    const keep = [];
    const kx = []; const ky = []; const kz = [];
    const km = [];
    for (let k = 0; k < alive.length; k++) {
      const px = Math.round((ax[k] * u[0] + ay[k] * u[1] + az[k] * u[2] - au) / cell) + pad;
      const py = Math.round((ax[k] * v[0] + ay[k] * v[1] + az[k] * v[2] - av) / cell) + pad;
      const out2 = px < 0 || py < 0 || px >= w || py >= h || !sil[py * w + px];
      const m = miss[k] + (out2 ? 1 : 0);
      if (m > budget) continue;
      keep.push(alive[k]); kx.push(ax[k]); ky.push(ay[k]); kz.push(az[k]); km.push(m);
    }
    alive = keep;
    ax = Float64Array.from(kx); ay = Float64Array.from(ky); az = Float64Array.from(kz);
    miss = Int32Array.from(km);
    if (!alive.length) break;
  }

  const out = new Uint8Array(nx * ny * nz);
  for (const i of alive) out[i] = 1;
  radii.sort((a, b) => a - b);
  const median = radii[Math.floor(radii.length / 2)];
  return {
    solid: out,
    kept: alive.length,
    views: dirs.length,
    distinct: distinctDirections(dirs),
    budget,
    radii,
    median,
    rings: ringsByView,
    meta: metaByView,
    // Nothing to undo when the outline is made of real points: the dilation was
    // scaffolding and never reached the model. The raster path still has to be
    // shrunk back, and still by one guessed number.
    erode: rings3 ? 0 : median,
  };
}

// ------------------------------------------------------------- the isosurface
// Naive surface nets. One vertex per cell that straddles the surface, placed at
// the average of the crossings on that cell's twelve edges, and one quad per
// grid edge that changes sign, joining the four cells around it. Closed and
// manifold by construction, and near-uniform, which is exactly what the
// decimator below wants — marching cubes would hand it slivers instead.
const CELL_CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

const CELL_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export function surfaceNets(field, dim, lo, cell, iso) {
  const [nx, ny, nz] = dim;
  const at = (a, b, c) => field[(c * ny + b) * nx + a];
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const verts = [];
  const cidx = (a, b, c) => (c * (ny - 1) + b) * (nx - 1) + a;

  for (let c = 0; c < nz - 1; c++) {
    for (let b = 0; b < ny - 1; b++) {
      for (let a = 0; a < nx - 1; a++) {
        const v = new Array(8);
        let mask = 0;
        for (let k = 0; k < 8; k++) {
          const o = CELL_CORNERS[k];
          v[k] = at(a + o[0], b + o[1], c + o[2]);
          if (v[k] > iso) mask |= 1 << k;
        }
        if (mask === 0 || mask === 255) continue;
        let px = 0; let py = 0; let pz = 0; let hits = 0;
        for (const [i0, i1] of CELL_EDGES) {
          const inside0 = (mask >> i0) & 1;
          const inside1 = (mask >> i1) & 1;
          if (inside0 === inside1) continue;
          const t = (iso - v[i0]) / (v[i1] - v[i0]);
          const o0 = CELL_CORNERS[i0]; const o1 = CELL_CORNERS[i1];
          px += o0[0] + (o1[0] - o0[0]) * t;
          py += o0[1] + (o1[1] - o0[1]) * t;
          pz += o0[2] + (o1[2] - o0[2]) * t;
          hits++;
        }
        cellVert[cidx(a, b, c)] = verts.length / 3;
        verts.push(
          lo[0] + (a + px / hits) * cell,
          lo[1] + (b + py / hits) * cell,
          lo[2] + (c + pz / hits) * cell,
        );
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells around it. The
  // winding follows the direction of the sign change so that every face ends up
  // pointing OUT of the solid — get this backwards and the model is inside out,
  // which does not look like an error in a wireframe and looks like a black
  // object in the app. There is a check for it at the end.
  const faces = [];
  const quad = (p, q, r, s, flip) => {
    if (p < 0 || q < 0 || r < 0 || s < 0) return;
    if (flip) faces.push(p, r, q, p, s, r);
    else faces.push(p, q, r, p, r, s);
  };
  for (let c = 0; c < nz - 1; c++) {
    for (let b = 0; b < ny - 1; b++) {
      for (let a = 0; a < nx - 1; a++) {
        const here = at(a, b, c) > iso;
        if (a > 0 && b > 0 && (at(a, b, c + 1) > iso) !== here) {
          quad(cellVert[cidx(a, b, c)], cellVert[cidx(a - 1, b, c)], cellVert[cidx(a - 1, b - 1, c)], cellVert[cidx(a, b - 1, c)], here);
        }
        if (a > 0 && c > 0 && (at(a, b + 1, c) > iso) !== here) {
          quad(cellVert[cidx(a, b, c)], cellVert[cidx(a, b, c - 1)], cellVert[cidx(a - 1, b, c - 1)], cellVert[cidx(a - 1, b, c)], here);
        }
        if (b > 0 && c > 0 && (at(a + 1, b, c) > iso) !== here) {
          quad(cellVert[cidx(a, b, c)], cellVert[cidx(a, b - 1, c)], cellVert[cidx(a, b - 1, c - 1)], cellVert[cidx(a, b, c - 1)], here);
        }
      }
    }
  }
  // The divergence theorem, used as an assertion. A closed surface wound
  // consistently outward encloses a positive volume; wound inward it encloses
  // exactly minus the same number. Anything near zero would mean the winding is
  // not consistent at all, which surface nets cannot produce and which nothing
  // downstream could survive.
  let vol = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3; const b = faces[i + 1] * 3; const c = faces[i + 2] * 3;
    vol += (
      verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1])
      - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c])
      + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c])
    ) / 6;
  }
  if (vol < 0) for (let i = 0; i < faces.length; i += 3) { const t = faces[i + 1]; faces[i + 1] = faces[i + 2]; faces[i + 2] = t; }

  return { verts: Float64Array.from(verts), faces: Int32Array.from(faces) };
}

/**
 * Taubin smoothing: a Laplacian pass that shrinks, then a slightly larger
 * negative one that pushes back out. Plain Laplacian smoothing on a closed
 * surface deflates it — run it long enough on a pig and you get an egg — and
 * the whole point of the alternating pass is that it does not.
 */
export function smooth(mesh, passes, lambda = 0.55, mu = -0.58) {
  const { verts, faces } = mesh;
  const n = verts.length / 3;
  const adj = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = [faces[i], faces[i + 1], faces[i + 2]];
    adj[a].add(b); adj[a].add(c);
    adj[b].add(a); adj[b].add(c);
    adj[c].add(a); adj[c].add(b);
  }
  let cur = verts;
  for (let pass = 0; pass < passes * 2; pass++) {
    const k = pass % 2 ? mu : lambda;
    const next = new Float64Array(cur.length);
    for (let i = 0; i < n; i++) {
      const near = adj[i];
      if (!near.size) { next[i * 3] = cur[i * 3]; next[i * 3 + 1] = cur[i * 3 + 1]; next[i * 3 + 2] = cur[i * 3 + 2]; continue; }
      let sx = 0; let sy = 0; let sz = 0;
      for (const j of near) { sx += cur[j * 3]; sy += cur[j * 3 + 1]; sz += cur[j * 3 + 2]; }
      const m = near.size;
      next[i * 3] = cur[i * 3] + k * (sx / m - cur[i * 3]);
      next[i * 3 + 1] = cur[i * 3 + 1] + k * (sy / m - cur[i * 3 + 1]);
      next[i * 3 + 2] = cur[i * 3 + 2] + k * (sz / m - cur[i * 3 + 2]);
    }
    cur = next;
  }
  return { verts: cur, faces };
}

// -------------------------------------------------------------- the decimation
// Garland–Heckbert quadric error metrics. Each vertex carries the sum of the
// squared-distance forms of its incident planes; collapsing an edge costs
// whatever that sum says the new point is away from all of them, and the
// cheapest collapse always goes next. On a barrel with four legs this spends
// almost nothing on the flank and keeps its faces where the curvature is, which
// is the entire argument for triangles over voxels at this budget.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1; const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function decimate(mesh, target) {
  const pos = Array.from({ length: mesh.verts.length / 3 }, (_, i) => [mesh.verts[i * 3], mesh.verts[i * 3 + 1], mesh.verts[i * 3 + 2]]);
  const faces = [];
  for (let i = 0; i < mesh.faces.length; i += 3) faces.push([mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]]);

  const nv = pos.length;
  const facesOf = Array.from({ length: nv }, () => new Set());
  const alive = new Uint8Array(faces.length).fill(1);
  faces.forEach((f, i) => { for (const v of f) facesOf[v].add(i); });
  const dead = new Uint8Array(nv);
  const version = new Int32Array(nv);

  const planeOf = (f) => {
    const [a, b, c] = f.map((i) => pos[i]);
    const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
    const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-18) return null;
    nx /= len; ny /= len; nz /= len;
    return [nx, ny, nz, -(nx * a[0] + ny * a[1] + nz * a[2])];
  };
  const addPlane = (q, p) => {
    const [a, b, c, d] = p;
    q[0] += a * a; q[1] += a * b; q[2] += a * c; q[3] += a * d;
    q[4] += b * b; q[5] += b * c; q[6] += b * d;
    q[7] += c * c; q[8] += c * d;
    q[9] += d * d;
  };
  const quadrics = Array.from({ length: nv }, () => new Float64Array(10));
  for (const f of faces) {
    const p = planeOf(f);
    if (!p) continue;
    for (const v of f) addPlane(quadrics[v], p);
  }
  const errorAt = (q, v) => {
    const [x, y, z] = v;
    return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
      + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
      + q[7] * z * z + 2 * q[8] * z
      + q[9];
  };

  /** Best position for a collapse: solve the quadric, or fall back if it is flat. */
  function bestPlace(q, a, b) {
    const m = [q[0], q[1], q[2], q[1], q[4], q[5], q[2], q[5], q[7]];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) > 1e-14) {
      const r = [-q[3], -q[6], -q[8]];
      const inv = [
        (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
        (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
        (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
      ];
      const v = [
        inv[0] * r[0] + inv[1] * r[1] + inv[2] * r[2],
        inv[3] * r[0] + inv[4] * r[1] + inv[5] * r[2],
        inv[6] * r[0] + inv[7] * r[1] + inv[8] * r[2],
      ];
      // A near-singular solve can throw the point across the model. Keep it only
      // if it landed near the edge it came from.
      const span = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 4 + 1e-9;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (Math.hypot(v[0] - mid[0], v[1] - mid[1], v[2] - mid[2]) < span) return v;
    }
    const options = [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]];
    let bestV = options[2];
    let bestE = Infinity;
    for (const o of options) {
      const e = errorAt(q, o);
      if (e < bestE) { bestE = e; bestV = o; }
    }
    return bestV;
  }

  const neighborsOf = (v) => {
    const out = new Set();
    for (const fi of facesOf[v]) for (const w of faces[fi]) if (w !== v) out.add(w);
    return out;
  };

  const heap = new Heap();
  const consider = (a, b) => {
    if (a === b || dead[a] || dead[b]) return;
    const q = new Float64Array(10);
    for (let k = 0; k < 10; k++) q[k] = quadrics[a][k] + quadrics[b][k];
    const at = bestPlace(q, pos[a], pos[b]);
    heap.push({ a, b, at, cost: Math.max(0, errorAt(q, at)), va: version[a], vb: version[b] });
  };
  const seen = new Set();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const a = f[k]; const b = f[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      consider(a, b);
    }
  }

  let liveFaces = faces.length;
  let collapses = 0;
  while (liveFaces > target && heap.size) {
    const e = heap.pop();
    if (dead[e.a] || dead[e.b] || version[e.a] !== e.va || version[e.b] !== e.vb) continue;

    // The link condition. On a closed manifold an edge is safe to collapse only
    // if its endpoints share exactly the two vertices opposite it; anything else
    // pinches the surface into something that is no longer a surface.
    const na = neighborsOf(e.a);
    const nb = neighborsOf(e.b);
    let shared = 0;
    for (const v of na) if (nb.has(v)) shared++;
    if (shared !== 2) continue;

    // And it must not turn a triangle inside out, which quadrics do not notice
    // and an eye notices immediately.
    const touched = new Set([...facesOf[e.a], ...facesOf[e.b]]);
    const doomed = [...facesOf[e.a]].filter((fi) => facesOf[e.b].has(fi));
    let flips = false;
    for (const fi of touched) {
      if (doomed.includes(fi)) continue;
      const before = planeOf(faces[fi]);
      if (!before) continue;
      const moved = faces[fi].map((v) => ((v === e.a || v === e.b) ? e.at : pos[v]));
      const ux = moved[1][0] - moved[0][0]; const uy = moved[1][1] - moved[0][1]; const uz = moved[1][2] - moved[0][2];
      const vx = moved[2][0] - moved[0][0]; const vy = moved[2][1] - moved[0][1]; const vz = moved[2][2] - moved[0][2];
      const nx2 = uy * vz - uz * vy; const ny2 = uz * vx - ux * vz; const nz2 = ux * vy - uy * vx;
      const len = Math.hypot(nx2, ny2, nz2);
      if (len < 1e-18) { flips = true; break; }
      if ((before[0] * nx2 + before[1] * ny2 + before[2] * nz2) / len < 0.1) { flips = true; break; }
    }
    if (flips) continue;

    // Do it: b folds into a, a moves to the chosen point.
    pos[e.a] = e.at;
    for (let k = 0; k < 10; k++) quadrics[e.a][k] += quadrics[e.b][k];
    for (const fi of [...facesOf[e.b]]) {
      const f = faces[fi];
      for (let k = 0; k < 3; k++) if (f[k] === e.b) f[k] = e.a;
      if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) {
        if (alive[fi]) { alive[fi] = 0; liveFaces--; }
        for (const v of new Set(f)) facesOf[v].delete(fi);
      } else {
        facesOf[e.a].add(fi);
      }
      facesOf[e.b].delete(fi);
    }
    dead[e.b] = 1;
    version[e.a]++;
    collapses++;
    for (const v of neighborsOf(e.a)) consider(e.a, v);
  }

  // Repack.
  const remap = new Int32Array(nv).fill(-1);
  const outVerts = [];
  const outFaces = [];
  faces.forEach((f, i) => {
    if (!alive[i]) return;
    const tri = f.map((v) => {
      if (remap[v] < 0) { remap[v] = outVerts.length / 3; outVerts.push(pos[v][0], pos[v][1], pos[v][2]); }
      return remap[v];
    });
    outFaces.push(tri[0], tri[1], tri[2]);
  });
  return { verts: Float64Array.from(outVerts), faces: Int32Array.from(outFaces), collapses };
}

/**
 * Sample the splat cloud's color at a point.
 *
 * Opacity- and distance-weighted, and the weighting matters more than it looks:
 * an unweighted average over a radius smears a dark eye across half a face, and
 * a nearest-splat lookup picks up whatever single blob happened to land there.
 *
 * The width ADAPTS to what is actually nearby. Where the scan is dense the
 * kernel stays at `radius` and resolves what the capture resolved; where it is
 * thin the kernel opens out to reach the nearest splats there are. Without that
 * the tight kernel finds nothing over the parts a capture missed and the surface
 * comes back in flat grey patches with ragged edges — which look far more like a
 * bug than the honest answer, which is that the color there is a guess made from
 * further away.
 */
export function makeColorSampler(p, radius) {
  const h = Math.max(radius * 3, 0.004);
  const bins = new Map();
  for (let i = 0; i < p.n; i++) {
    const kk = `${Math.floor(p.x[i] / h)},${Math.floor(p.y[i] / h)},${Math.floor(p.z[i] / h)}`;
    if (!bins.has(kk)) bins.set(kk, []);
    bins.get(kk).push(i);
  }
  const near = [];
  return (cx, cy, cz, out) => {
    const bx = Math.floor(cx / h); const by = Math.floor(cy / h); const bz = Math.floor(cz / h);
    near.length = 0;
    let closest = Infinity;
    for (let ring = 1; ring <= 3 && !near.length; ring++) {
      for (let a = -ring; a <= ring; a++) {
        for (let bb = -ring; bb <= ring; bb++) {
          for (let c = -ring; c <= ring; c++) {
            const bin = bins.get(`${bx + a},${by + bb},${bz + c}`);
            if (!bin) continue;
            for (const i of bin) {
              const d2 = (p.x[i] - cx) ** 2 + (p.y[i] - cy) ** 2 + (p.z[i] - cz) ** 2;
              near.push(i, d2);
              if (d2 < closest) closest = d2;
            }
          }
        }
      }
    }
    if (!near.length) { out[0] = 0.7; out[1] = 0.7; out[2] = 0.7; return out; }
    // Wide enough to reach the nearest splat there is, never tighter than asked.
    const sigma = Math.max(radius, Math.sqrt(closest) * 0.9);
    const sigma2 = 2 * sigma * sigma;
    let r = 0; let g = 0; let b = 0; let wsum = 0;
    for (let k = 0; k < near.length; k += 2) {
      const i = near[k];
      const w = p.w[i] * Math.exp(-near[k + 1] / sigma2);
      r += p.rgb[i * 3] * w; g += p.rgb[i * 3 + 1] * w; b += p.rgb[i * 3 + 2] * w;
      wsum += w;
    }
    if (wsum > 1e-9) { out[0] = r / wsum; out[1] = g / wsum; out[2] = b / wsum; }
    else { out[0] = 0.7; out[1] = 0.7; out[2] = 0.7; }
    return out;
  };
}

// ------------------------------------------------------------------ the color
// Object Tile Scroll never uses a model's materials. It reads the RELATIONSHIPS
// between their colors — biggest group is the body, everything else is stored as
// an HSL delta from it — and then decides for itself what the object is made of.
// So what this has to produce is not a faithful color, it is a small number of
// groups whose colors sit in the right relation to each other: a dark snout has
// to stay dark relative to the body under any finish the piece picks.
//
// Per-triangle color comes from the splats around its centroid. K-means over
// those, then a majority vote across each triangle's neighbors, because a
// speckled assignment costs nothing here in triangles (the app merges by
// material) but produces a model whose "groups" are noise rather than parts.
export function colorize(mesh, p, k, cell) {
  const nf = mesh.faces.length / 3;
  const h = cell * 3;
  const bins = new Map();
  const key = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  for (let i = 0; i < p.n; i++) {
    const kk = key(p.x[i], p.y[i], p.z[i]);
    if (!bins.has(kk)) bins.set(kk, []);
    bins.get(kk).push(i);
  }

  const faceColor = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    let cx = 0; let cy = 0; let cz = 0;
    for (let j = 0; j < 3; j++) {
      const v = mesh.faces[f * 3 + j];
      cx += mesh.verts[v * 3] / 3; cy += mesh.verts[v * 3 + 1] / 3; cz += mesh.verts[v * 3 + 2] / 3;
    }
    const bx = Math.floor(cx / h); const by = Math.floor(cy / h); const bz = Math.floor(cz / h);
    let r = 0; let g = 0; let b = 0; let wsum = 0;
    for (let a = -1; a <= 1; a++) {
      for (let bb = -1; bb <= 1; bb++) {
        for (let c = -1; c <= 1; c++) {
          const bin = bins.get(`${bx + a},${by + bb},${bz + c}`);
          if (!bin) continue;
          for (const i of bin) {
            const d2 = (p.x[i] - cx) ** 2 + (p.y[i] - cy) ** 2 + (p.z[i] - cz) ** 2;
            const w = p.w[i] * Math.exp(-d2 / (2 * (cell * 1.5) ** 2));
            r += p.rgb[i * 3] * w; g += p.rgb[i * 3 + 1] * w; b += p.rgb[i * 3 + 2] * w;
            wsum += w;
          }
        }
      }
    }
    if (wsum > 1e-9) { faceColor[f * 3] = r / wsum; faceColor[f * 3 + 1] = g / wsum; faceColor[f * 3 + 2] = b / wsum; }
    else { faceColor[f * 3] = 0.7; faceColor[f * 3 + 1] = 0.7; faceColor[f * 3 + 2] = 0.7; }
  }

  if (k === 1) {
    const mean = [0, 0, 0];
    for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) mean[c] += faceColor[f * 3 + c] / nf;
    return { group: new Int32Array(nf), colors: [mean] };
  }

  // K-means, seeded by spreading the starts as far apart as the data allows
  // (k-means++ without the randomness, so a rerun gives the same model).
  const centers = [];
  let seed = [0, 0, 0];
  for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) seed[c] += faceColor[f * 3 + c] / nf;
  centers.push(seed);
  while (centers.length < k) {
    let far = 0; let farD = -1;
    for (let f = 0; f < nf; f++) {
      let d = Infinity;
      for (const c of centers) {
        d = Math.min(d, (faceColor[f * 3] - c[0]) ** 2 + (faceColor[f * 3 + 1] - c[1]) ** 2 + (faceColor[f * 3 + 2] - c[2]) ** 2);
      }
      if (d > farD) { farD = d; far = f; }
    }
    centers.push([faceColor[far * 3], faceColor[far * 3 + 1], faceColor[far * 3 + 2]]);
  }
  const group = new Int32Array(nf);
  for (let iter = 0; iter < 40; iter++) {
    let moved = 0;
    for (let f = 0; f < nf; f++) {
      let best = 0; let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (faceColor[f * 3] - centers[c][0]) ** 2 + (faceColor[f * 3 + 1] - centers[c][1]) ** 2 + (faceColor[f * 3 + 2] - centers[c][2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (group[f] !== best) { group[f] = best; moved++; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let f = 0; f < nf; f++) {
      const s = sums[group[f]];
      s[0] += faceColor[f * 3]; s[1] += faceColor[f * 3 + 1]; s[2] += faceColor[f * 3 + 2]; s[3]++;
    }
    for (let c = 0; c < centers.length; c++) if (sums[c][3]) centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    if (!moved) break;
  }

  // Despeckle: a triangle outvoted by its edge-neighbors joins them. Three
  // rounds is enough to clear grain without eating a real patch.
  const edgeMap = new Map();
  for (let f = 0; f < nf; f++) {
    for (let j = 0; j < 3; j++) {
      const a = mesh.faces[f * 3 + j]; const b = mesh.faces[f * 3 + ((j + 1) % 3)];
      const kk = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeMap.has(kk)) edgeMap.set(kk, []);
      edgeMap.get(kk).push(f);
    }
  }
  const nbr = Array.from({ length: nf }, () => []);
  for (const fs of edgeMap.values()) {
    if (fs.length !== 2) continue;
    nbr[fs[0]].push(fs[1]);
    nbr[fs[1]].push(fs[0]);
  }
  for (let round = 0; round < 3; round++) {
    const next = group.slice();
    for (let f = 0; f < nf; f++) {
      const tally = new Map();
      for (const g of nbr[f]) tally.set(group[g], (tally.get(group[g]) || 0) + 1);
      let win = group[f]; let winN = (tally.get(group[f]) || 0) + 0.5;
      for (const [g, c] of tally) if (c > winN) { winN = c; win = g; }
      next[f] = win;
    }
    group.set(next);
  }

  // Recolor from the final grouping and drop any cluster that lost all its
  // triangles, so `colors` and the primitives stay in step.
  const used = [];
  const sums = centers.map(() => [0, 0, 0, 0]);
  for (let f = 0; f < nf; f++) {
    const s = sums[group[f]];
    s[0] += faceColor[f * 3]; s[1] += faceColor[f * 3 + 1]; s[2] += faceColor[f * 3 + 2]; s[3]++;
  }
  const remap = new Int32Array(centers.length).fill(-1);
  for (let c = 0; c < centers.length; c++) {
    if (!sums[c][3]) continue;
    remap[c] = used.length;
    used.push([sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]]);
  }
  for (let f = 0; f < nf; f++) group[f] = remap[group[f]];
  return { group, colors: used };
}

/**
 * Stand the model up.
 *
 * `normalize()` in the app centers every build and scales it to a unit sphere,
 * so absolute size genuinely does not matter and is not corrected here.
 * Orientation is the opposite: a scan arrives in whatever frame the phone was
 * holding and a pig on its side is a pig on its side forever.
 */
export function orient(verts, up, yawDeg) {
  const m = {
    '+y': (x, y, z) => [x, y, z],
    '-y': (x, y, z) => [x, -y, -z],
    '+z': (x, y, z) => [x, z, -y],
    '-z': (x, y, z) => [x, -z, y],
    '+x': (x, y, z) => [-y, x, z],
    '-x': (x, y, z) => [y, -x, z],
  }[up];
  if (!m) throw new Error(`--up must be one of ±x ±y ±z, got "${up}"`);
  const a = (yawDeg * Math.PI) / 180;
  const ca = Math.cos(a); const sa = Math.sin(a);
  for (let i = 0; i < verts.length; i += 3) {
    const [x, y, z] = m(verts[i], verts[i + 1], verts[i + 2]);
    verts[i] = x * ca + z * sa;
    verts[i + 1] = y;
    verts[i + 2] = -x * sa + z * ca;
  }
  return verts;
}

// ------------------------------------------------------------- the whole thing
/**
 * Cloud in, mesh out — the hull path, start to finish.
 *
 * The command-line tool has more routes through the pipeline than this (the ray
 * bracket, the IMLS fit, the extra carve), kept because they are how the hull
 * was shown to be the better one. This runs only the route that won, which is
 * also the only one worth offering somebody who is looking at their scan rather
 * than at a comparison.
 *
 * `onProgress(stage, frac)` is called between stages AND inside the hull, whose
 * hundreds of outlines are the only part long enough to need reporting. It is
 * awaited, so a browser caller can hand back a frame there and keep the page
 * alive; a Node caller can return undefined and pay nothing.
 */
export async function buildFromCloud(pts, opts = {}, onProgress = () => {}) {
  const grid = opts.grid ?? 96;
  const tris = opts.tris ?? 800;
  const hull = opts.hull ?? 480;
  const consensus = opts.consensus ?? 0.99;
  const outline = opts.outline ?? 10;
  const smoothPasses = opts.smooth ?? 12;
  const colors = opts.colors ?? 1;
  const despeckleRounds = opts.despeckle ?? 2;

  const tick = async (stage, frac) => { await onProgress(stage, frac); };

  await tick('culling the haze', 0.02);
  const p = cull(pts, {
    grid,
    minOpacity: opts.minOpacity ?? 0.3,
    minLum: opts.minLum ?? 0,
    crop: opts.crop ?? null,
    isolation: opts.isolation ?? 3,
    isolationRadius: opts.isolationRadius ?? 0,
  });
  if (!p.n) throw new Error('the cull left nothing — try a lower isolation');

  const span = [p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]];
  const cell = Math.max(...span) / grid;
  const dim = span.map((s) => Math.max(2, Math.round(s / cell) + 3));
  const lo = p.lo.map((v) => v - cell);
  const spacing = spacingOf(p, cell * 2);

  await tick('tracing outlines', 0.08);
  const h = await silhouetteHull(
    p, dim, lo, cell, hull, outline, null, true, 0, consensus, 1, false,
    (frac) => tick('tracing outlines', 0.08 + 0.64 * frac),
  );

  await tick('cleaning up', 0.72);
  let solid = despeckle(h.solid, dim, 1);
  solid = largestPiece(solid, dim);

  await tick('finding the surface', 0.78);
  // Blur the 0/1 solid before contouring. Surface nets interpolates along each
  // edge, so a hard 0/1 field gives it nothing to interpolate and the result is
  // stair-stepped; two box passes are enough to hand it a real gradient.
  let field = Float32Array.from(solid);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(field.length);
    for (let i = 0; i < field.length; i++) {
      let s = field[i]; let n = 1;
      for (const j of neighbors6(i, dim[0], dim[1], dim[2])) { s += field[j]; n++; }
      next[i] = s / n;
    }
    field = next;
  }
  let mesh = surfaceNets(field, dim, lo, cell, 0.5);
  if (!mesh.faces.length) throw new Error('the isosurface came back empty');
  const contoured = mesh.faces.length / 3;

  await tick('smoothing', 0.88);
  mesh = smooth(mesh, smoothPasses);

  await tick('decimating', 0.92);
  const dec = decimate(mesh, tris);
  mesh = dec;

  await tick('colouring', 0.98);
  const { group, colors: swatches } = colorize(mesh, p, colors, cell);
  if (opts.up) orient(mesh.verts, opts.up, opts.yaw ?? 0);

  await tick('done', 1);
  return {
    mesh,
    group,
    colors: swatches,
    stats: {
      read: pts.count,
      kept: p.n,
      spacing,
      cell,
      isolationRadius: p.isolationRadius,
      cells: h.kept,
      views: h.views,
      distinct: h.distinct,
      budget: h.budget,
      contoured,
      triangles: mesh.faces.length / 3,
      collapses: dec.collapses,
    },
  };
}

/** Only the largest connected piece. A survivor floater becomes its own island. */
function largestPiece(solid, dim) {
  const label = new Int32Array(solid.length).fill(-1);
  let best = -1; let bestSize = 0; let pieces = 0;
  for (let s0 = 0; s0 < solid.length; s0++) {
    if (!solid[s0] || label[s0] >= 0) continue;
    const id = pieces++;
    let size = 0;
    const q = [s0];
    label[s0] = id;
    while (q.length) {
      const i = q.pop();
      size++;
      for (const j of neighbors6(i, dim[0], dim[1], dim[2])) {
        if (solid[j] && label[j] < 0) { label[j] = id; q.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  const out = solid.slice();
  for (let i = 0; i < out.length; i++) if (label[i] !== best) out[i] = 0;
  return out;
}

