import { groups, photos } from './photos.js';

const main = document.getElementById('main');
const modal = document.getElementById('modal');
const stageImg = document.getElementById('stageImg');
const capTitle = document.getElementById('capTitle');
const capNote = document.getElementById('capNote');
const capIndex = document.getElementById('capIndex');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const closeBtn = document.getElementById('close');
const spinner = document.getElementById('spinner');

let current = -1;
let lastFocused = null;

// --- preloading -------------------------------------------------------------

// Full-size photos already fetched, so we never queue the same one twice and
// can tell instantly whether a spinner is even warranted.
const warmed = new Set();

function warm(photo) {
  if (!photo || warmed.has(photo.full)) return Promise.resolve();
  warmed.add(photo.full);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = resolve;
    img.src = photo.full;
  });
}

// After the grid's thumbnails have settled, quietly pull the full-size photos
// in the background one at a time. Sequential and idle-scheduled on purpose:
// firing 65 parallel requests would compete with the thumbnails the visitor is
// actually looking at. By the time anyone clicks, most opens are instant.
function prefetchInBackground() {
  // A visitor on a metered or slow connection did not ask for 65 photos.
  const conn = navigator.connection;
  if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return;

  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 15 }), 300));
  let i = 0;
  const pump = (deadline) => {
    // Pause while the viewer is reading a photo; its neighbors take priority.
    if (current >= 0) return idle(pump);
    if (i >= photos.length) return;
    if (deadline.timeRemaining() <= 0) return idle(pump);
    warm(photos[i++]).then(() => idle(pump));
  };
  idle(pump);
}

if (document.readyState === 'complete') prefetchInBackground();
else window.addEventListener('load', prefetchInBackground);

// --- grid ------------------------------------------------------------------

// One <section> per property. Photos keep their index into the flat `photos`
// list so the modal arrows can walk across group boundaries.
let flatIndex = 0;
for (const group of groups) {
  const section = document.createElement('section');

  const head = document.createElement('div');
  head.className = 'group-head';
  const h2 = document.createElement('h2');
  h2.textContent = group.title;
  head.append(h2);
  if (group.note) {
    const note = document.createElement('span');
    note.className = 'group-note';
    note.textContent = group.note;
    head.append(note);
  }
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${group.files.length} photo${group.files.length === 1 ? '' : 's'}`;
  head.append(count);
  section.append(head);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const _ of group.files) {
    const photo = photos[flatIndex];
    const index = flatIndex;
    flatIndex++;

    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.type = 'button';
    tile.setAttribute('aria-label', `Open ${photo.caption}`);

    const img = document.createElement('img');
    img.src = photo.thumb;
    img.alt = photo.caption;
    // Everything below the first screenful can wait for the scroll.
    img.loading = index < 12 ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('ready'));
    if (img.complete) img.classList.add('ready');

    tile.append(img);
    tile.addEventListener('click', () => open(index));
    grid.append(tile);
  }
  section.append(grid);
  main.append(section);
}

// --- modal -----------------------------------------------------------------

let spinnerTimer = null;

function stopSpinner() {
  clearTimeout(spinnerTimer);
  spinner.classList.remove('on');
}

function show(index) {
  const photo = photos[index];
  current = index;

  stageImg.classList.remove('ready');
  stageImg.src = photo.full;
  stageImg.alt = photo.caption;
  warmed.add(photo.full);
  capTitle.textContent = photo.caption;
  capNote.textContent = photo.note;
  capIndex.textContent = `${index + 1} / ${photos.length}`;

  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === photos.length - 1;

  // A cached photo decodes within a frame or two, so showing a spinner for it
  // reads as a flicker. Wait a beat and only spin if it's genuinely still out.
  stopSpinner();
  if (stageImg.complete && stageImg.naturalWidth > 0) {
    stageImg.classList.add('ready');
  } else {
    spinnerTimer = setTimeout(() => spinner.classList.add('on'), 150);
  }

  // Neighbors first — a held arrow key should never land on a blank stage.
  warm(photos[index - 1]);
  warm(photos[index + 1]);
}

stageImg.addEventListener('load', () => {
  stopSpinner();
  stageImg.classList.add('ready');
});
stageImg.addEventListener('error', stopSpinner);

function open(index) {
  lastFocused = document.activeElement;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  show(index);
  closeBtn.focus();
}

function close() {
  modal.classList.remove('open');
  document.body.style.overflow = '';
  stopSpinner();
  stageImg.removeAttribute('src');
  current = -1;
  if (lastFocused) lastFocused.focus();
  prefetchInBackground();
}

function step(delta) {
  const next = current + delta;
  if (next >= 0 && next < photos.length) show(next);
}

prevBtn.addEventListener('click', () => step(-1));
nextBtn.addEventListener('click', () => step(1));
closeBtn.addEventListener('click', close);

// Clicking the backdrop closes; clicking the photo or a control does not.
modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.classList.contains('stage') || e.target.classList.contains('cap')) close();
});

document.addEventListener('keydown', (e) => {
  if (current < 0) return;
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else return;
  e.preventDefault();
});

// Swipe between photos on touch devices.
let touchX = null;
modal.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
modal.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 45) step(dx < 0 ? 1 : -1);
  touchX = null;
}, { passive: true });
