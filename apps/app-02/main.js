// Particle Swarm — lightweight boids with cohesion, separation, and mouse pull.
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

const mouse = { x: W / 2, y: H / 2, on: false };
window.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.on = true; });
window.addEventListener('pointerleave', () => { mouse.on = false; });

const N = 240;
const b = Array.from({ length: N }, () => ({
  x: Math.random() * W, y: Math.random() * H,
  vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
}));

function step() {
  for (const p of b) {
    let cx = 0, cy = 0, ax = 0, ay = 0, sx = 0, sy = 0, n = 0;
    for (const q of b) {
      if (q === p) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 6400) {
        cx += q.x; cy += q.y; ax += q.vx; ay += q.vy; n++;
        if (d2 < 600) { sx -= dx; sy -= dy; }
      }
    }
    if (n) {
      p.vx += ((cx / n - p.x) * 0.0008) + (ax / n - p.vx) * 0.04 + sx * 0.004;
      p.vy += ((cy / n - p.y) * 0.0008) + (ay / n - p.vy) * 0.04 + sy * 0.004;
    }
    if (mouse.on) {
      const dx = mouse.x - p.x, dy = mouse.y - p.y, d = Math.hypot(dx, dy) + 1;
      p.vx += (dx / d) * 0.06; p.vy += (dy / d) * 0.06;
    }
    const sp = Math.hypot(p.vx, p.vy);
    const max = 2.6;
    if (sp > max) { p.vx = (p.vx / sp) * max; p.vy = (p.vy / sp) * max; }
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0) p.x += W; if (p.x > W) p.x -= W;
    if (p.y < 0) p.y += H; if (p.y > H) p.y -= H;
  }
}

function frame() {
  ctx.fillStyle = 'rgba(18, 20, 28, 0.18)';
  ctx.fillRect(0, 0, W, H);
  step();
  for (const p of b) {
    const a = Math.atan2(p.vy, p.vx);
    ctx.fillStyle = `hsl(${(a * 57 + 200) % 360}, 80%, 65%)`;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(a) * 6, p.y + Math.sin(a) * 6);
    ctx.lineTo(p.x + Math.cos(a + 2.4) * 4, p.y + Math.sin(a + 2.4) * 4);
    ctx.lineTo(p.x + Math.cos(a - 2.4) * 4, p.y + Math.sin(a - 2.4) * 4);
    ctx.closePath();
    ctx.fill();
  }
  requestAnimationFrame(frame);
}
frame();
