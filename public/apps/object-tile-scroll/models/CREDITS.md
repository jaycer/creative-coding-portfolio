# Models

Everything in this folder except `rubberPig.glbz` is
**[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)** —
public domain, no attribution required. Credited anyway, because they are good
and because both of these people give them away.

- **Kenney** (<https://kenney.nl>) — *Furniture Kit* and *Food Kit*. Ship as GLB;
  used as downloaded, unedited. Files keep their original camelCase names
  (`kitchenFridge.glb`).
- **Quaternius** (<https://quaternius.com>) — *Ultimate Home Interior*,
  *Ultimate Furniture* and *Ultimate Food*. Both ship as OBJ + MTL and are converted to GLB by
  `tools/obj2glb.mjs` so everything loads down the one path. Flat `Kd` colors, no
  textures. Files keep their original PascalCase names (`Bathroom_Sink.glb`,
  `OfficeChair.glb`).

  *Ultimate Furniture* is converted with `--flat`, which drops normals and the
  index buffer and lets the app compute face normals instead. It is the one pack
  that arrives partly smooth-shaded, and faceting it is not a concession to file
  size — it is what puts those models in the same world as the flat-shaded rest.
  It happens to be about a quarter smaller too.

- **`rubberPig.glbz`** is not from a pack. It is a rubber pig off a shelf here,
  scanned with a phone as a Gaussian splat and converted by
  `tools/splat2glb.mjs`. Original work, same license as the rest of this
  repository.

They are used here for their shape only. `object-tile-scroll.js` bakes each model
down to one geometry with one group per material, keeps the *relationships*
between those materials' colors, and throws the materials themselves away — this
piece decides what an object is made of, and an object that arrived with its own
finish could not take part in the color habit. Kenney's Food Kit models are UV-mapped
to a shared texture atlas that is deliberately not shipped, so only the food
whose silhouette carries it in one flat color is kept from that pack — a mug and
a banana read, a pizza does not. Quaternius's *Ultimate Food* has no such problem
(several flat-color groups per model), so the burger and donut come from there
instead, with their own layers and sprinkles; Kenney's plain versions were
dropped rather than kept alongside, because two donuts in a deck is a repeat.

## The files are `.glbz`, not `.glb`

They are gzipped, and the page inflates them itself with `DecompressionStream`
before parsing. GitHub Pages compresses text and JavaScript but not binary, so a
plain `.glb` would ship at full size — and glTF is mostly float arrays, which
gzip is very good at. These 63 models are **402KB compressed against 1,517KB
raw**, a 74% saving, for exactly the same 71 objects.

The extension is `.glbz` and deliberately not `.glb.gz`: a server that sees `.gz`
sets `Content-Encoding: gzip` (Vite's dev server does), the browser then inflates
it silently, and the app's own inflate chokes on plain bytes. Under a name
nothing recognizes, the page is the only thing that unpacks it. The loader sniffs
the gzip magic number anyway, so it survives either behavior.

## Adding more

Drop the `.glb` in, add a row to `MODELS` at the bottom of
`object-tile-scroll.js`, then compress. For an OBJ pack:

```
node tools/obj2glb.mjs --in <pack dir> --out public/apps/object-tile-scroll/models --only Chair_1,Table_RoundSmall
node tools/gzip-models.mjs --dir public/apps/object-tile-scroll/models
```

`gzip-models` is idempotent and takes whatever `.glb` it finds, so it works the
same for a converted OBJ pack and for a Kenney GLB copied straight in.

For a scan of a real object — a `.spz` or a `.ply` out of Scaniverse, Polycam or
any other Gaussian-splat capture:

```
node tools/splat2glb.mjs --in ~/Downloads/Thing.spz \
  --out public/apps/object-tile-scroll/models/thing.glb --up -z --tris 800
node tools/gzip-models.mjs --dir public/apps/object-tile-scroll/models
```

**Prefer the SPZ.** Scaniverse offers both and they are the same capture: exported
both ways, the same scan came back as the same 30,555 points in the same order,
positions identical to the bit once a Y/Z flip and a 0.13mm recentring are undone,
scale identical, opacity and color equal to within float32 rounding — and the SPZ
was 11.4x smaller. The PLY is that file decompressed, with its float32 precision
as decoration. Converting from either produces the same model; measured, the two
meshes differ by a 0.13mm translation and nothing else, and the app centres every
build anyway. The reader turns an SPZ into the PLY's own frame on the way in, so
`--up` means the same thing whichever one you hand it.

Read that tool's header before running it a second time. The one setting nothing
can infer is `--up` — a phone has no idea which way up a pig is. After that, the
job is getting rid of the low-confidence haze a splat trainer leaves in the air
around its subject, because haze bracketed as geometry is a model wearing a fur
coat. There are two ways to cut it and they fail differently. `--crop` is a box:
exact, but it will slice through the object where the haze overlaps it.
`--min-lum` drops dark splats: it cannot cut the shape, but it only works when
the subject is paler than the room, and it eats the subject's own shadowed parts
along with the haze. The pig took the crop — measured, the brightness cull came
back a third smaller because it had thinned his belly and undersides away.

The pig currently in the deck was built in the Splat Editor rather than here —
same pipeline, since the tool and the editor import it from one file — from a
cloud hand-cleaned twice. Erasing the second time, with the flat-colour view to
find the haze by density rather than by colour, took the surface from 2.2mm to
1.9mm off the points and the worst dent from 40.5mm to 13.1mm.

Anything built in the editor comes out in the SCAN's frame, because that is the
frame the cloud is in and rotating it mid-session would make every erase stroke
land somewhere unexpected. It has to be stood up before it can go in the deck:

```
node tools/orient-glb.mjs --in ~/Downloads/bertRebuilt.glb \
  --out public/apps/object-tile-scroll/models/rubberPig.glb --up +x
node tools/gzip-models.mjs --dir public/apps/object-tile-scroll/models
```

That also re-emits it in the deck's own format — positions only, unindexed, no
normals — which is both smaller and the thing every other model here is.

Check the axis by looking, not by reasoning about the bounding box. This scan
was converted with `--up -x` for most of its life on the strength of its box
coming out 20.0 x 12.2 x 11.2 cm, which is the right SHAPE for a standing pig
and says nothing whatever about which end is up — a pig on its back measures the
same. It was on its back the whole time. Six renders on a floor grid, one per
candidate axis, settles it in about a minute and cannot be argued with.

The best settings measured so far, for a scan of a real object:

```
--hull 480 --consensus 0.99 --isolation 3 --grid 96
```

`--isolation` matters more than it looks. It drops splats with fewer than N
neighbours nearby, and the default of 6 was quietly causing the dent in the pig's
back: the thinly-covered columns are exactly the ones whose splats have few
neighbours, so the cull deleted the little evidence there was and the silhouettes
then read short in those columns. Relaxing it to 3 took the back from 52 dented
columns to 8, and the surface's p90 departure from the points from 6.6mm to
2.2mm, at no cost to the fit anywhere else. The capture is thin there; the cull
was making it thinner.

The radius that counts as "nearby" is measured from the scan's own median splat
spacing (3x it) and no longer from the output grid. It used to be two grid cells,
which meant asking for a finer grid discarded more of the INPUT — 17,585 splats
kept at grid 64 against 10,992 at 128, for the same file. `--isolation-mm`
overrides it if a capture needs something else.

`--hull` traces the silhouette from N directions and keeps what is inside them
all. `--consensus` is what makes a large N worth paying for, and the reasoning is
worth knowing before changing either number.

A strict intersection is a MINIMUM over N estimates, so it keeps the shortest
answer any view has ever given — and every extra direction is another chance to
be given a short one. That is not convergence, it is drift, and it was measured
three ways. Tracing the same 240 directions from both ends, which adds no
information about the shape at all, takes 3.2% of the volume off. The synthetic
fixture with matched noise drifts at a third of the rate this scan does. And the
damage is not spread evenly: it lands where coverage is thin, so the dent in the
pig's back goes from 15mm deep at 60 directions to 27mm at 960, while the fit
elsewhere stops improving at 240.

Forgiving the four worst objections out of 480 stops it. The concavities survive
because a real one — the gap between the legs — is objected to by dozens of views
once there are that many, so four is nowhere near enough to fill it; that was
checked by counting separate blobs in cross-section, which is unchanged from
strict up to a budget of 4 and only starts merging at 9. The dent comes back to
12.5mm, shallower than the strict 60-direction build, and the result stops caring
how it was sampled: strict, the two spiral handednesses and the both-ends variant
disagree by up to 3.2%, and under `--consensus 0.99` they agree to 0.4%.

Below about 200 directions do NOT use it. A concavity seen by only four views
cannot survive a budget of four.

`--vertex-color` exists and works, and was tried here and dropped. It keeps the
color the capture measured, one per vertex, smooth-shaded — and smooth shading
is exactly what makes a scan's holes visible. Faceting hides them: every hollow
the capture missed reads as one more flat plane among hundreds. Smooth them out
and the same object is full of dents. Worth remembering as a property of the
representation rather than of the tool, and worth another try on a scan with no
gaps in it.

## What gets left out, and why

Two filters, both learned by rendering the candidates in a grid rather than by
guessing:

1. **One material plus a texture atlas.** Kenney's Food Kit is UV-mapped to a
   shared `colormap.png` that is deliberately not shipped, so each model becomes
   one flat color. Only food whose silhouette carries it survives — a mug and a
   banana read, a pizza becomes a disc and a watermelon a ball.
2. **Thin or flat things.** Every build is normalized to a unit *sphere*, so a
   flat object becomes a large thin sheet that disappears edge-on and reads as a
   stray line the rest of the time. This is what ruled out the cutlery, the
   plate, the carpet, the curtains and the shower rail — all perfectly good
   models, all wrong for this piece.

Quaternius's household packs are distributed as Google Drive folders with no
direct file URLs and a listing that loads by XHR, so unlike Kenney's they cannot
be fetched by script — they have to be downloaded by hand before conversion.
