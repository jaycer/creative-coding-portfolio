// Lissajous — a grid of harmonic curves, each tracing x=sin(a·t), y=sin(b·t).
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

let phase = 0;
function frame() {
  phase += 0.01;
  ctx.fillStyle = '#0e0f16';
  ctx.fillRect(0, 0, W, H);

  const grid = 4;
  const pad = Math.min(W, H) * 0.06;
  const cellW = (W - pad * 2) / grid;
  const cellH = (H - pad * 2) / grid;
  const r = Math.min(cellW, cellH) * 0.36;

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const cx = pad + cellW * (gx + 0.5);
      const cy = pad + cellH * (gy + 0.5);
      const a = gx + 1, b = gy + 1;
      ctx.strokeStyle = `hsl(${(gx + gy) * 40 + phase * 30}, 75%, 65%)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 160; i++) {
        const t = (i / 160) * Math.PI * 2;
        const x = cx + Math.sin(a * t + phase) * r;
        const y = cy + Math.sin(b * t) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }
  requestAnimationFrame(frame);
}
frame();
