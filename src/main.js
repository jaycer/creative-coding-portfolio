import './style.css';
import { apps } from './apps.js';
import { hardRefresh } from './hard-refresh.js';

// Stamp the version (injected from package.json at build time by Vite).
document.getElementById('version').textContent = `v${__APP_VERSION__}`;

// Wire the hard-refresh button.
const refreshBtn = document.getElementById('hard-refresh');
refreshBtn.addEventListener('click', () => {
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  hardRefresh();
});

// Build the gallery grid.
const grid = document.getElementById('grid');
grid.innerHTML = apps
  .map(
    (app, i) => `
    <a class="tile" href="./apps/${app.slug}/${app.entry ?? ''}" aria-label="${app.title}">
      <span class="tile__media">
        <img src="thumbs/${String(i + 1).padStart(2, '0')}.svg" alt="" loading="lazy" width="600" height="400" />
      </span>
      <span class="tile__meta">
        <span class="tile__title">${app.title}</span>
        <span class="tile__blurb">${app.blurb}</span>
      </span>
    </a>`
  )
  .join('');
