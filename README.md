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

1. Create `apps/<slug>/` with an `index.html` (copy an existing app as a template).
2. Add a `public/thumbs/NN.svg` thumbnail.
3. Add a row to [`src/apps.js`](./src/apps.js).

The Vite config auto-discovers every `apps/*/index.html` as a build entry point.

## Notes

- The **Hard refresh** button unregisters service workers, clears Cache Storage, and reloads with a cache-busting param — handy when a deploy looks stale.
- The version badge is sourced from `package.json` and injected at build time.
