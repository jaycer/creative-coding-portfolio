import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

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
let appVersion = sh('git describe --tags').replace(/^v/, '');
if (!appVersion) {
  const gitSha = sh('git rev-parse --short HEAD');
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
          if (!existsSync(resolve(base, slug, 'favicon.svg'))) continue;
          if (!existsSync(resolve(base, slug, 'apple-touch-icon.png'))) {
            problems.push(`${dir}/${slug}: no apple-touch-icon.png — run: npm run icons`);
          }
          if (!/rel="apple-touch-icon"/.test(readFileSync(html, 'utf-8'))) {
            problems.push(
              `${dir}/${slug}/index.html: add, next to <link rel="icon">\n` +
              `      <link rel="apple-touch-icon" href="./apple-touch-icon.png" />\n` +
              `      <meta name="apple-mobile-web-app-title" content="Short Name" />`
            );
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
  plugins: [versionJson(), touchIcons()],
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
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input },
  },
});
