# Models

Everything in this folder is **[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)**
— public domain, no attribution required. Credited anyway, because they are good
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
gzip is very good at. These 62 models are **394KB compressed against 1,488KB
raw**, a 74% saving, for exactly the same 70 objects.

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
