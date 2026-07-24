// Vector fruit & veggie icons for the PDF, mirroring the gallery thumbnail's
// green almost-icons. pdf-lib can't render color emoji, so these are drawn as
// SVG paths via drawSvgPath (which places the 72×72 icon box's top-left at the
// given x,y and grows downward, so it reads upright on the page).

import { rgb, type PDFPage, type Color } from "pdf-lib";

const DARK = rgb(0.059, 0.322, 0.196); // #0f5132
const LIGHT = rgb(0.31, 0.749, 0.522); // #4fbf85
const MID = rgb(0.184, 0.478, 0.322); // #2f7a52

// A circle as an SVG path (two arcs), so an icon is one flat list of fills.
const C = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

type Part = [d: string, color: Color];

const ICONS: Record<string, Part[]> = {
  tomato: [
    [C(36, 45, 22), DARK],
    [
      "M36 33 C32 27 27 25 23 25 C26 31 30 34 36 34 Z M36 33 C40 27 45 25 49 25 C46 31 42 34 36 34 Z M36 34 C34 28 36 22 36 21 C38 25 38 30 37 34 Z",
      LIGHT,
    ],
  ],
  carrot: [
    ["M25 35 L47 35 L38 63 C37 65.5 35 65.5 34 63 Z", DARK],
    [
      "M31 35 C27 25 20 22 16 22 C20 29 24 33 31 35 Z M36 35 C35 23 36 16 37 15 C41 20 40 28 40 35 Z M41 35 C45 25 52 22 56 22 C52 29 48 33 41 35 Z",
      LIGHT,
    ],
  ],
  broccoli: [
    ["M30 43 h12 l-2 17 c0 3 -8 3 -8 0 Z", MID],
    [C(25, 37, 10) + C(37, 30, 11) + C(48, 38, 10) + C(36, 43, 10), DARK],
  ],
  apple: [
    [
      "M36 31 C33 27 27 27 23 30 C17 35 17 47 22 56 C25 61 29 59 32 58 C34.5 57 37.5 57 40 58 C43 59 47 61 50 56 C55 47 55 35 49 30 C45 27 39 27 36 31 Z",
      DARK,
    ],
    ["M34.7 19 h2.6 v12 h-2.6 Z", MID],
    ["M37 27 C39 20 45 18 50 18 C49 25 44 28 37 28 Z", LIGHT],
  ],
  grapes: [
    [C(30, 35, 7) + C(44, 35, 7) + C(37, 45, 7) + C(24, 47, 7) + C(50, 47, 7) + C(31, 56, 7) + C(43, 56, 7), DARK],
    ["M37 28 C37 21 42 16 49 15 C48 23 44 27 37 28 Z", LIGHT],
  ],
};

export const PRODUCE_ROW = ["broccoli", "tomato", "carrot", "apple", "grapes"];

/** Draw one produce icon with its top-left at (x, y), sized `size`×`size`. */
export function drawProduce(page: PDFPage, name: string, x: number, y: number, size: number) {
  const scale = size / 72;
  for (const [d, color] of ICONS[name]) page.drawSvgPath(d, { x, y, scale, color });
}

/** Draw a centered row of produce icons; returns the row's height. */
export function drawProduceRow(page: PDFPage, centerX: number, topY: number, size: number, gap = size * 0.35) {
  const total = PRODUCE_ROW.length * size + (PRODUCE_ROW.length - 1) * gap;
  let x = centerX - total / 2;
  for (const name of PRODUCE_ROW) {
    drawProduce(page, name, x, topY, size);
    x += size + gap;
  }
  return size;
}
