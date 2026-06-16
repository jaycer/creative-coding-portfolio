// Sine Ripples — expanding wave fronts from each drop, interfering as they grow.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H, t = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const drops = [];
function drop(x, y) { drops.push({ x, y, born: t, hue: (t * 40) % 360 }); }
canvas.addEventListener('pointerdown', (e) => drop(e.clientX, e.clientY));

function frame() {
  t += 0.016;
  ctx.fillStyle = 'rgba(10, 14, 22, 0.12)';
  ctx.fillRect(0, 0, W, H);

  // Occasional ambient drops so it's alive before interaction.
  if (Math.sin(t * 1.3) > 0.999 || drops.length === 0) {
    drop(Math.random() * W, Math.random() * H);
  }

  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    const age = t - d.born;
    const base = age * 220;
    const fade = Math.max(0, 1 - age / 4);
    if (fade <= 0) { drops.splice(i, 1); continue; }
    for (let k = 0; k < 5; k++) {
      const r = base - k * 26;
      if (r <= 0) continue;
      ctx.strokeStyle = `hsla(${d.hue}, 80%, 65%, ${fade * (1 - k / 5) * 0.7})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  requestAnimationFrame(frame);
}
frame();
