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
