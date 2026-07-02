import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// Displayed version = package.json semver + the current git short SHA, so the
// badge auto-changes every commit and tells you exactly which build is live.
// Bump the semver base with `npm version patch|minor|major` for real releases.
// (actions/checkout keeps .git, so this resolves in CI too; falls back if not.)
let gitSha = '';
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  gitSha = '';
}
const appVersion = gitSha ? `${pkg.version}+${gitSha}` : pkg.version;

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
  // dev (/) and prod (/creative-coding-portfolio/) both working.
  base: '/creative-coding-portfolio/',
  // This is a true multi-page site: the gallery links to real sub-app pages.
  // 'mpa' disables Vite's SPA index.html fallback so a directory request like
  // /apps/<slug>/ resolves to that folder's index.html (including the static
  // apps under /public/apps/) instead of silently serving the gallery.
  appType: 'mpa',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input },
  },
});
