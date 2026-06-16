// Game of Life — Conway's automaton. Click and drag to paint living cells.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const CELL = 10;
let W, H, cols, rows, grid, next;

function makeGrid(fill) {
  const g = new Uint8Array(cols * rows);
  if (fill) for (let i = 0; i < g.length; i++) g[i] = Math.random() < 0.18 ? 1 : 0;
  return g;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cols = Math.ceil(W / CELL); rows = Math.ceil(H / CELL);
  grid = makeGrid(true); next = new Uint8Array(cols * rows);
}
window.addEventListener('resize', resize);
resize();

let painting = false;
function paint(e) {
  const c = Math.floor(e.clientX / CELL), r = Math.floor(e.clientY / CELL);
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && cc < cols && rr >= 0 && rr < rows) grid[rr * cols + cc] = 1;
    }
}
canvas.addEventListener('pointerdown', (e) => { painting = true; paint(e); });
canvas.addEventListener('pointermove', (e) => { if (painting) paint(e); });
window.addEventListener('pointerup', () => { painting = false; });

function step() {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = (r + dr + rows) % rows, cc = (c + dc + cols) % cols;
          n += grid[rr * cols + cc];
        }
      const alive = grid[r * cols + c];
      next[r * cols + c] = (alive && (n === 2 || n === 3)) || (!alive && n === 3) ? 1 : 0;
    }
  }
  [grid, next] = [next, grid];
}

let acc = 0, last = 0;
function frame(ts) {
  const dt = ts - last; last = ts; acc += dt;
  if (acc > 80) { step(); acc = 0; }
  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#7ee0a0';
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (grid[r * cols + c]) ctx.fillRect(c * CELL, r * CELL, CELL - 1, CELL - 1);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
