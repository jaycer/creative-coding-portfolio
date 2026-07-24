// Vector QR code for the PDF, pointing at the live directory. Modules are drawn
// as crisp filled squares (no raster) so it scans cleanly off print.

import qrcodeGen from "qrcode-generator";
import { rgb, type PDFPage } from "pdf-lib";

// The library ships as a callable default export; type it minimally.
const qrcode = qrcodeGen as unknown as (
  typeNumber: number,
  ec: "L" | "M" | "Q" | "H"
) => { addData(s: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean };

/**
 * Draw a QR block (top-left at x,y) of the given `size`, encoding `text`.
 * Uses error-correction level Q (robust to smudges) and a 4-module quiet zone,
 * on a white plate so it scans regardless of any page tint behind it.
 */
export function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  const qr = qrcode(0, "Q");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const cell = size / (count + quiet * 2);

  page.drawRectangle({ x, y: y - size, width: size, height: size, color: rgb(1, 1, 1) });

  let d = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue;
      const mx = (quiet + c) * cell;
      const my = (quiet + r) * cell;
      d += `M${mx} ${my}h${cell}v${cell}h${-cell}Z`;
    }
  }
  // drawSvgPath: (x,y) is the SVG origin, y grows downward — so my∈[0,size] maps
  // to PDF y∈[yTop, yTop−size], aligning with the white plate above.
  page.drawSvgPath(d, { x, y, color: rgb(0, 0, 0) });
}
