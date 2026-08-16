import { defineConfig } from 'vite';
// Brick Layer is the one sub-app written in React. It used to live in its own
// repo and be vendored in as a prebuilt bundle; it is source here now, so the
// plugin that compiles its JSX has to live here too.
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { apps } from './src/apps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// Displayed version comes from the latest git tag — i.e. the GitHub Release —
// so the badge tracks real releases with no manual bumping: exactly "0.3.0"
// on the tagged commit, "0.3.0-2-gabc123" once commits land after it. Needs
// tags in the checkout (deploy.yml fetches them); falls back to package.json
// semver + short SHA when they aren't available.
const sh = (cmd) => {
  try {
    return execSync(cmd, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};
// git answers from whatever repository encloses this directory, and that is not
// always this one. Unpack this tree inside another project — a tarball of a
// release, vendored into a site that serves these apps — and git walks up to
// THAT project's .git and reports its tag. Measured: a copy extracted inside a
// repo tagged v9.9.9 reports 9.9.9, and every save file stamped by the apps
// would name a release of this project that does not exist.
//
// So git is only believed when it is answering about this project, and
// APP_VERSION lets a consumer state the version outright instead.
const sameDir = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};
const ownRepo = sameDir(sh('git rev-parse --show-toplevel') || '.', __dirname);

let appVersion = process.env.APP_VERSION || '';
if (!appVersion && ownRepo) appVersion = sh('git describe --tags').replace(/^v/, '');
if (!appVersion) {
  if (!ownRepo) {
    console.warn(
      '[version] this tree is not its own git repo, so the tag cannot be read from it.\n' +
      '          Falling back to package.json. Clone the tag instead of unpacking a\n' +
      '          tarball, or pass APP_VERSION, or save files will be stamped wrong.'
    );
  }
  const gitSha = ownRepo ? sh('git rev-parse --short HEAD') : '';
  appVersion = gitSha ? `${pkg.version}+${gitSha}` : pkg.version;
}

/**
 * Publish the build version at /version.json, for the static apps.
 *
 * `__APP_VERSION__` reaches only what the bundler touches, and the pages under
 * /public ship verbatim — so a static app has no way to know which codebase it
 * is. It matters for the ones that write a file: Meme Generator stamps its save
 * files with this, so a save made before a breaking change can still be
 * recognized as one afterwards.
 *
 * Served in dev and emitted into dist, at the site root either way, so
 * `fetch('../../version.json')` from /apps/<slug>/ finds it in both.
 */
function versionJson() {
  const body = () => JSON.stringify({ version: appVersion, built: new Date().toISOString() });
  let base = '/';
  return {
    name: 'version-json',
    configResolved(config) { base = config.base; },
    configureServer(server) {
      // req.url still carries the base at this point — a path-mounted middleware
      // on '/version.json' answers the bare root and 404s the URL the apps
      // actually ask for. Both spellings are matched by hand instead.
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (path !== '/version.json' && path !== base + 'version.json') return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(body());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: body() });
    },
  };
}

// Where this build will be served from, absolute and without a trailing slash.
// Open Graph is the reason it has to exist: og:image and og:url cannot be
// relative, so the pages have to name a host. Naming it in one place instead of
// 71 means the same app can be served from somewhere else — a preview deploy,
// or a second site — and still hand out preview cards that point at itself.
const SITE_URL = (process.env.SITE_URL || 'https://jaycer.github.io/creative-coding-portfolio')
  .replace(/\/+$/, '');

/**
 * Substitute %SITE_URL% in every page.
 *
 * The pages under /public ship verbatim and never go through Vite's HTML
 * pipeline, so this happens in three places rather than one: transformIndexHtml
 * covers the bundled entries in dev and build, a dev middleware covers the
 * static ones, and a sweep of dist at the end covers whatever the copy of
 * /public dropped in. The sweep alone is enough for a build; the other two are
 * so that what you see in dev is what ships.
 *
 * The token, not the finished URL, is what lives in the source files — so an
 * app copied out of this repo arrives site-neutral rather than quietly
 * advertising jaycer.github.io from someone else's domain.
 */
function siteUrls() {
  const TOKEN = '%SITE_URL%';
  const fill = (html) => html.split(TOKEN).join(SITE_URL);

  const sweep = (dir) => {
    let n = 0;
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      if (statSync(path).isDirectory()) { n += sweep(path); continue; }
      if (!name.endsWith('.html')) continue;
      const html = readFileSync(path, 'utf-8');
      if (!html.includes(TOKEN)) continue;
      writeFileSync(path, fill(html));
      n++;
    }
    return n;
  };

  let outDir = 'dist';
  return {
    name: 'site-urls',
    configResolved(config) { outDir = config.build.outDir; },
    transformIndexHtml: { order: 'post', handler: fill },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.endsWith('.html') && !url.endsWith('/')) return next();
        // Only files that really are under /public reach this; anything Vite
        // owns is left alone so its own transforms and HMR still apply.
        const rel = url.replace(/^\/+/, '').replace(/^creative-coding-portfolio\//, '');
        let file = resolve(__dirname, 'public', rel);
        if (url.endsWith('/')) file = resolve(file, 'index.html');
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        const html = readFileSync(file, 'utf-8');
        if (!html.includes(TOKEN)) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(fill(html));
      });
    },
    closeBundle() {
      const dir = resolve(__dirname, outDir);
      if (existsSync(dir)) sweep(dir);
    },
  };
}

/**
 * Publish the app list at /apps.manifest.json.
 *
 * src/apps.js is the one place the gallery is edited, but it is JavaScript, and
 * a second gallery on another domain should not have to import this project's
 * source to know what exists. This is the same list as data, with the paths a
 * consumer needs and, for each app, whether it is a folder that can be copied
 * as-is or an entry that has to be built.
 *
 * Paths are relative to the site root on purpose — no leading slash, no host —
 * so they can be joined to whatever base is serving them.
 */
function appsManifest() {
  const body = () => JSON.stringify({
    version: appVersion,
    site: SITE_URL,
    apps: apps.map((app) => {
      // Decided by where the page itself lives, not by whether a folder of that
      // name exists under /public. Brick Layer has both: its source is a Vite
      // entry under apps/, while its favicon, home-screen icon and manifest
      // ship verbatim from public/apps/brick-layer/. A folder-shaped test calls
      // it static and sends a consumer off to copy three sidecars and no app.
      const isStatic = existsSync(resolve(__dirname, 'public/apps', app.slug, 'index.html'));
      return {
        slug: app.slug,
        title: app.title,
        blurb: app.blurb,
        // "static" ships verbatim and can be copied folder and all; "bundled"
        // is a Vite entry and has to go through a build.
        kind: isStatic ? 'static' : 'bundled',
        source: `${isStatic ? 'public/apps' : 'apps'}/${app.slug}/`,
        path: `apps/${app.slug}/${app.entry ?? ''}`,
        thumb: `thumbs/${app.slug}.svg`,
        og: `og/${app.slug}.jpg`,
      };
    }),
  }, null, 2);

  let base = '/';
  return {
    name: 'apps-manifest',
    configResolved(config) { base = config.base; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (path !== '/apps.manifest.json' && path !== base + 'apps.manifest.json') return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(body());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'apps.manifest.json', source: body() });
    },
  };
}

/**
 * Refuse to build a sub-app that would land on an iPhone home screen as a
 * letter tile.
 *
 * Safari's Add to Home Screen reads <link rel="apple-touch-icon"> and nothing
 * else — not rel="icon", and never an SVG. Every app shipped without one until
 * this was noticed by hand, months in, which is exactly the kind of omission a
 * checklist does not catch. So it is checked here instead: presence only, no
 * rasterizing, so it costs nothing and runs anywhere CI does.
 *
 * `npm run icons` is what fixes a failure — it builds the PNGs from the
 * favicons. That needs Chrome, so it stays a local step and never runs in CI.
 */
function touchIcons() {
  return {
    name: 'touch-icons',
    buildStart() {
      const problems = [];
      for (const dir of ['public/apps', 'apps']) {
        const base = resolve(__dirname, dir);
        if (!existsSync(base)) continue;
        for (const slug of readdirSync(base)) {
          const html = resolve(base, slug, 'index.html');
          if (!existsSync(html)) continue;

          const source = readFileSync(html, 'utf-8');
          const link = source.match(/<link[^>]+rel="apple-touch-icon"[^>]*>/i);
          if (!link) {
            problems.push(
              `${dir}/${slug}/index.html: add, next to <link rel="icon">\n` +
              `      <link rel="apple-touch-icon" href="./apple-touch-icon.png" />\n` +
              `      <meta name="apple-mobile-web-app-title" content="Short Name" />`
            );
            continue;
          }

          // Follow the href rather than assuming the PNG sits beside the page.
          // Brick Layer's source is bundled from apps/ while its icon ships
          // verbatim from public/, so a folder-shaped check would skip it in
          // both places and quietly pass an app with no icon at all.
          const href = (link[0].match(/href="([^"]+)"/) || [])[1] || '';
          const file = href.startsWith('/')
            ? resolve(__dirname, 'public', href.replace(/^\//, ''))
            : resolve(base, slug, href);
          if (!existsSync(file)) {
            problems.push(`${dir}/${slug}/index.html: href="${href}" resolves to nothing — run: npm run icons`);
          }
        }
      }
      if (problems.length) {
        this.error(
          `home-screen icon missing:\n  ${problems.join('\n  ')}\n\n` +
          `Without it, "Add to Home Screen" on iOS shows a letter tile.`
        );
      }
    },
  };
}

// Multi-page build: the main gallery plus every self-contained app folder.
const input = { main: resolve(__dirname, 'index.html') };
const appsDir = resolve(__dirname, 'apps');
if (existsSync(appsDir)) {
  for (const name of readdirSync(appsDir)) {
    const html = resolve(appsDir, name, 'index.html');
    if (existsSync(html)) input[name] = html;
  }
}

export default defineConfig({
  // Project page lives under /<repo>/ on github.io. Relative asset links keep
  // dev (/) and prod (/creative-coding-portfolio/) both working. Preview builds
  // live under a different repo/subpath, so BASE_PATH overrides it when set
  // (the preview workflow passes e.g. /creative-coding-portfolio-preview/<branch>/).
  base: process.env.BASE_PATH || '/creative-coding-portfolio/',
  plugins: [react(), versionJson(), appsManifest(), siteUrls(), touchIcons()],
  // This is a true multi-page site: the gallery links to real sub-app pages.
  // 'mpa' disables Vite's SPA index.html fallback so a directory request like
  // /apps/<slug>/ resolves to that folder's index.html (including the static
  // apps under /public/apps/) instead of silently serving the gallery.
  appType: 'mpa',
  // Dev only: never let the browser cache, so on-device testing always gets the
  // latest edit (no stale HTML/JS/CSS while iterating on the phone).
  server: {
    headers: { 'Cache-Control': 'no-store' },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    // For the bundled apps, which cannot use the %SITE_URL% token: pantry prints
    // this into the PDF it generates, QR code and all.
    __SITE_URL__: JSON.stringify(SITE_URL),
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input },
  },
});
