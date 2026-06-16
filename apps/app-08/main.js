// Noise Blobs — soft metaball-like fields drifting on slow harmonic paths.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const blobs = Array.from({ length: 7 }, (_, i) => ({
  ax: 0.2 + Math.random() * 0.6,
  ay: 0.2 + Math.random() * 0.6,
  px: Math.random() * Math.PI * 2,
  py: Math.random() * Math.PI * 2,
  sp: 0.2 + Math.random() * 0.5,
  hue: (i * 47) % 360,
  r: 0,
}));

let t = 0;
function frame() {
  t += 0.006;
  ctx.fillStyle = '#0c0e16';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  const R = Math.min(W, H) * 0.32;
  for (const b of blobs) {
    const x = W / 2 + Math.sin(t * b.sp + b.px) * (W * b.ax * 0.5);
    const y = H / 2 + Math.sin(t * b.sp * 1.3 + b.py) * (H * b.ay * 0.5);
    const r = R * (0.7 + 0.3 * Math.sin(t + b.px));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${b.hue + t * 20}, 80%, 60%, 0.5)`);
    g.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  requestAnimationFrame(frame);
}
frame();
