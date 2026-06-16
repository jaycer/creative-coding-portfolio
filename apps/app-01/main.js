// Flow Field — particles drift along a smooth, time-varying vector field.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H, dpr;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#14151a';
  ctx.fillRect(0, 0, W, H);
}
window.addEventListener('resize', resize);
resize();

const mouse = { x: W / 2, y: H / 2 };
window.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });

const N = 1400;
const ps = Array.from({ length: N }, () => ({
  x: Math.random() * W,
  y: Math.random() * H,
  h: Math.random() * 60 + 180,
}));

function field(x, y, t) {
  return (
    Math.sin(x * 0.0026 + t) +
    Math.cos(y * 0.0026 - t * 0.7) +
    Math.sin((x + y) * 0.0017 + t * 0.4)
  );
}

let t = 0;
function frame() {
  t += 0.0024;
  ctx.fillStyle = 'rgba(20, 21, 26, 0.06)';
  ctx.fillRect(0, 0, W, H);

  for (const p of ps) {
    const a = field(p.x, p.y, t) * Math.PI;
    const dx = mouse.x - p.x, dy = mouse.y - p.y;
    const d = Math.hypot(dx, dy) + 0.001;
    const pull = Math.min(40 / d, 0.6);
    const nx = p.x + Math.cos(a) * 1.4 + (dx / d) * pull;
    const ny = p.y + Math.sin(a) * 1.4 + (dy / d) * pull;

    ctx.strokeStyle = `hsla(${p.h}, 70%, 65%, 0.5)`;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    p.x = nx; p.y = ny;
    if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
      p.x = Math.random() * W;
      p.y = Math.random() * H;
    }
  }
  requestAnimationFrame(frame);
}
frame();
