# Jayce Renner — Creative Coding

A portfolio of generative art, simulations, and interactive sketches.

**Live site:** https://jaycer.github.io/creative-coding-portfolio/

## Stack

- [Vite](https://vitejs.dev/) multi-page build, vanilla JS — no framework, no runtime dependencies.
- Each portfolio entry is a **self-contained sub-app** under [`apps/`](./apps), with its own `index.html`, `main.js`, and `style.css`. Drop a scattered sketch into a new folder and it just works.
- Deployed to GitHub Pages via the workflow in [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) on every push to `main`.

## Develop

```bash
npm install
npm run dev      # local dev server with hot reload
npm run build    # production build into dist/
npm run preview  # preview the production build
```

## Add a new entry

Most sub-apps are **static**: a self-contained folder under `public/apps/<slug>/`
that ships verbatim, loading any libraries from a CDN. (`apps/<slug>/` is for the
few that need bundling; Vite auto-discovers every `apps/*/index.html` as a build
entry point.)

1. Create `public/apps/<slug>/index.html` — copy the head/meta block from an
   existing app. Top bar gets `<a class="back" href="../../">← Gallery</a>`.
2. Add a row to [`src/apps.js`](./src/apps.js): `{ slug, title, blurb, entry: 'index.html' }`.
   `entry` is required for static apps.
3. Add a thumbnail at `public/thumbs/<slug>.svg` (600×400). **Bake the title into
   it as a `<text>` element** — the gallery card shows only the blurb, so the SVG
   is the only place the name appears.
4. Add an OG image at `public/og/<slug>.jpg` (1200×630).
5. Add a `favicon.svg`, then run **`npm run icons`** — see below.

### Home-screen icons

`npm run icons` rasterizes every `favicon.svg` into the `apple-touch-icon.png`
beside it. The SVG stays the one definition of the mark; the PNG is derived, so
re-run it after editing a favicon (`npm run icons -- --check` fails if any is out
of date).

This is not optional and the build enforces it: Safari's Add to Home Screen reads
`<link rel="apple-touch-icon">` and nothing else — it ignores `rel="icon"`, and it
ignores SVG — so an app without one lands on the iPhone home screen as a plain
letter tile. Each page needs two lines beside its `<link rel="icon">`:

```html
<link rel="apple-touch-icon" href="./apple-touch-icon.png" />
<meta name="apple-mobile-web-app-title" content="Short Name" />
```

Keep the name short; iOS truncates the home-screen label around 12 characters.
`npm run build` fails with instructions if either piece is missing.

## Serving these apps from somewhere else

The sub-apps are a portable payload; the gallery is a skin over it. A second site
can serve the same apps under its own domain without forking anything.

**`SITE_URL`** — pages carry a `%SITE_URL%` token rather than a hardcoded host,
because Open Graph tags cannot be relative. It is filled in at build time:

```bash
SITE_URL=https://apps.example.org BASE_PATH=/ npm run build
```

The result contains no reference to any other domain, so preview cards point at
whatever site is actually serving them. Default is the live site above. The
token is what lives in the source files, so an app copied out of this repo
arrives site-neutral.

**`/apps.manifest.json`** — the app list as data, published at the site root,
so another gallery does not have to import `src/apps.js` to know what exists.
Paths are relative to the site root, no leading slash, ready to be joined to a
different base. Each entry carries a `kind`:

- `static` — the folder under `source` ships verbatim and can be copied as-is.
- `bundled` — a Vite entry that has to go through a build. Currently `pantry`
  and `brick-layer`.

`src/apps.js` stays the one place the list is edited; the manifest is generated
from it.

## License

Code is [MIT](./LICENSE) — use it, commercially included, as long as the
copyright notice comes along.

Four things are carved out, listed in [NOTICE](./NOTICE): the **photographs are
all rights reserved**, the Anton font is SIL OFL, the 3D models are CC0, and the
food location data belongs to the Greater Cleveland Food Bank.

The photographs are the one to know about — the code that displays them is free
to reuse, the pictures are not.

## Notes

- The **Hard refresh** button unregisters service workers, clears Cache Storage, and reloads with a cache-busting param — handy when a deploy looks stale.
- The version badge is sourced from `package.json` and injected at build time.
