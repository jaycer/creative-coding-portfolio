// Spirograph — hypotrochoid curves drawn by a circle rolling inside another.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  reseed();
}
window.addEventListener('resize', resize);

let params, theta, hue;
function reseed() {
  ctx.fillStyle = '#0d0e14';
  ctx.fillRect(0, 0, W, H);
  params = {
    R: Math.min(W, H) * (0.28 + Math.random() * 0.1),
    r: 30 + Math.random() * 90,
    d: 40 + Math.random() * 120,
  };
  theta = 0;
  hue = Math.random() * 360;
}
window.addEventListener('pointerdown', reseed);
resize();

function point(R, r, d, th) {
  const k = (R - r) / r;
  return {
    x: W / 2 + (R - r) * Math.cos(th) + d * Math.cos(k * th),
    y: H / 2 + (R - r) * Math.sin(th) - d * Math.sin(k * th),
  };
}

function frame() {
  const { R, r, d } = params;
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 6; i++) {
    const p0 = point(R, r, d, theta);
    theta += 0.05;
    const p1 = point(R, r, d, theta);
    ctx.strokeStyle = `hsla(${(hue + theta * 12) % 360}, 80%, 65%, 0.9)`;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  // Gently fade so the canvas slowly refreshes and never fully saturates.
  if (theta > Math.PI * 80) reseed();
  requestAnimationFrame(frame);
}
frame();
