import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

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
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input },
  },
});
