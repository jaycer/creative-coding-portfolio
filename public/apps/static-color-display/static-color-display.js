// Static Color Display — one color, the whole screen.
//
// There is no scene, no loop and no canvas. The piece is a single element the
// size of the window with a background on it, and everything below exists to
// keep three things saying the same thing: the field, the swatch, and the hex.
//
// It opens on pure red. Not on a remembered color the first time and not on a
// random one: a piece called Static Color Display should be the same piece for
// everybody who has never touched it. After that the color is theirs and it is
// what they come back to.

const DEFAULT_COLOR = '#FF0000';
const KEY = 'static-color-display:color';

const field = document.getElementById('field');
const colorEl = document.getElementById('color');
const hexEl = document.getElementById('hex');
const themeEl = document.querySelector('meta[name="theme-color"]');

/**
 * A hex the whole app can agree on: uppercase, six digits, with the hash.
 * Returns null for anything that is not a color yet, which is most of what a
 * text field holds while somebody is typing into it.
 */
function readHex(text) {
  const s = String(text).trim().replace(/^#/, '');
  // Three digits is a real and common way to write one, and doubling each digit
  // is exactly what it means: f00 IS ff0000, not a shorthand for something near
  // it. Accepted on the way in, and normalized straight away so there is only
  // ever one spelling of a color in here.
  if (/^[0-9a-fA-F]{3}$/.test(s)) return '#' + s.split('').map((c) => c + c).join('').toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toUpperCase();
  return null;
}

/**
 * Put a color up. Every path into the app comes through here — the swatch, the
 * text field, what was remembered, the default — so there is one place that
 * decides what is on screen and one place that writes it down.
 */
function show(hex, { typing = false } = {}) {
  field.style.background = hex;
  // The page behind it too, or a phone that overscrolls shows a strip of the
  // last color under the field it is dragging away from.
  document.documentElement.style.background = hex;
  // And the browser's own chrome on a phone, which is the rest of the screen
  // this piece is trying to be.
  if (themeEl) themeEl.setAttribute('content', hex);
  colorEl.value = hex.toLowerCase();
  // The field somebody is typing into is not rewritten under them: normalizing
  // "f00" to "#FF0000" mid-keystroke moves the caret and eats the next digit.
  // It is tidied when they leave it instead.
  if (!typing) hexEl.value = hex;
  hexEl.setAttribute('aria-invalid', 'false');
  try { localStorage.setItem(KEY, hex); } catch { /* private window */ }
}

colorEl.addEventListener('input', () => show(readHex(colorEl.value) || DEFAULT_COLOR));

hexEl.addEventListener('input', () => {
  const hex = readHex(hexEl.value);
  if (hex) show(hex, { typing: true });
  // Half a hex is not a color and not an error either — it is somebody partway
  // through typing one. The field says so quietly and the screen holds the last
  // color that WAS one, rather than flashing at every keystroke.
  else hexEl.setAttribute('aria-invalid', 'true');
});
// Leaving the field is when it gets tidied: whatever is in there becomes the
// canonical spelling of the color on screen, or goes back to it if it never
// became a color at all.
hexEl.addEventListener('change', () => show(readHex(hexEl.value) || readHex(colorEl.value) || DEFAULT_COLOR));
hexEl.addEventListener('blur', () => show(readHex(hexEl.value) || readHex(colorEl.value) || DEFAULT_COLOR));

// ------------------------------------------------------------- settings sheet
const menuBtn = document.getElementById('menu-btn');
const closeBtn = document.getElementById('close-btn');
const doneBtn = document.getElementById('done-btn');
const scrim = document.getElementById('scrim');

function openMenu() {
  scrim.hidden = false;
  document.body.classList.add('menu-open');
  menuBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  scrim.hidden = true;
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', openMenu);
closeBtn.addEventListener('click', closeMenu);
doneBtn.addEventListener('click', closeMenu);
scrim.addEventListener('click', (e) => { if (e.target === scrim) closeMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ----------------------------------------------------------------------- start
let saved = null;
try { saved = readHex(localStorage.getItem(KEY) || ''); } catch { saved = null; }
show(saved || DEFAULT_COLOR);
