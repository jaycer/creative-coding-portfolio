// Recursive Tree — a fractal tree whose branches sway with a synthetic breeze.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H, dpr;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

let seed = 0.5;
window.addEventListener('pointerdown', () => { seed = 0.35 + Math.random() * 0.35; });

function branch(x, y, len, ang, depth, t) {
  if (depth === 0 || len < 4) return;
  const sway = Math.sin(t + depth * 0.5) * 0.06 * (1 - depth / 11);
  const a = ang + sway;
  const x2 = x + Math.cos(a) * len;
  const y2 = y + Math.sin(a) * len;
  ctx.lineWidth = depth * 0.7;
  ctx.strokeStyle = `hsl(${110 - depth * 6}, ${30 + depth * 4}%, ${30 + depth * 4}%)`;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const spread = 0.35 + seed * 0.7;
  branch(x2, y2, len * 0.76, a - spread, depth - 1, t);
  branch(x2, y2, len * 0.76, a + spread, depth - 1, t);
}

let t = 0;
function frame() {
  t += 0.01;
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(0, 0, W, H);
  branch(W / 2, H - 20, Math.min(H, W) * 0.16, -Math.PI / 2, 11, t);
  requestAnimationFrame(frame);
}
frame();
