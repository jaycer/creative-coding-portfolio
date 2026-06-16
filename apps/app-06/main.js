// Starfield — a continuous warp-flight through procedurally streaming stars.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H, cx, cy;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx = W / 2; cy = H / 2;
}
window.addEventListener('resize', resize);
resize();

const target = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  target.x = (e.clientX - cx) / cx;
  target.y = (e.clientY - cy) / cy;
});

const N = 600;
const stars = Array.from({ length: N }, () => reset({}));
function reset(s) {
  s.x = (Math.random() - 0.5) * W;
  s.y = (Math.random() - 0.5) * H;
  s.z = Math.random() * W;
  s.pz = s.z;
  return s;
}

let ox = 0, oy = 0;
function frame() {
  ox += (target.x - ox) * 0.04;
  oy += (target.y - oy) * 0.04;
  ctx.fillStyle = 'rgba(8, 9, 14, 0.4)';
  ctx.fillRect(0, 0, W, H);
  for (const s of stars) {
    s.z -= 8;
    if (s.z < 1) { reset(s); continue; }
    const sx = cx + (s.x / s.z) * W + ox * 60;
    const sy = cy + (s.y / s.z) * W + oy * 60;
    const px = cx + (s.x / s.pz) * W + ox * 60;
    const py = cy + (s.y / s.pz) * W + oy * 60;
    s.pz = s.z;
    const r = (1 - s.z / W) * 2.2;
    ctx.strokeStyle = `rgba(255,255,255,${1 - s.z / W})`;
    ctx.lineWidth = r;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }
  requestAnimationFrame(frame);
}
frame();
