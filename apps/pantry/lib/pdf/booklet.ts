// Booklet (codex): the same directory laid out on half-Letter logical pages,
// then imposed two-up in saddle-stitch order onto Letter-landscape sheets. Print
// double-sided (flip on short edge), stack, fold down the middle, and the pages
// read in order.

import { PDFDocument } from "pdf-lib";
import { buildModel, type PantryRecord } from "./model";
import { renderModel } from "./layout";

const HALF_W = 396; // 5.5 in — a folded half-page
const HALF_H = 612; // 8.5 in
const SHEET_W = 792; // 11 in — landscape sheet holding two half-pages
const SHEET_H = 612; // 8.5 in

export async function buildBookletPdf(records: PantryRecord[]): Promise<Uint8Array> {
  const model = buildModel(records);

  // 1. Render the content as ordinary sequential half-Letter pages.
  const logical = await renderModel(model, {
    pageWidth: HALF_W,
    pageHeight: HALF_H,
    columns: 1,
    margin: 30,
    title: "Greater Cleveland Food Resources",
    subtitle: `${records.length} locations · grouped by area and city, listed by day.`,
  });
  const logicalBytes = await logical.save();

  // 2. Pad to a multiple of 4 with blanks (a folded sheet is 4 pages).
  const padded = await PDFDocument.load(logicalBytes);
  const padCount = (4 - (padded.getPageCount() % 4)) % 4;
  for (let i = 0; i < padCount; i++) padded.addPage([HALF_W, HALF_H]);
  const n = padded.getPageCount();
  const paddedBytes = await padded.save();

  // 3. Saddle-stitch imposition. For pages 1..n the printed sides pair up as
  //    (n,1),(2,n-1),(n-2,3),(4,n-3)… — outer sheet first, front then back.
  const order: [number, number][] = [];
  let a = 0;
  let b = n - 1;
  while (a < b) {
    order.push([b, a]); // front side: outer-left, outer-right
    order.push([a + 1, b - 1]); // back side: inner-left, inner-right
    a += 2;
    b -= 2;
  }

  // 4. Place each pair side-by-side on a landscape sheet.
  const booklet = await PDFDocument.create();
  const embedded = await booklet.embedPdf(paddedBytes, order.flat());
  for (let i = 0; i < order.length; i++) {
    const sheet = booklet.addPage([SHEET_W, SHEET_H]);
    sheet.drawPage(embedded[i * 2], { x: 0, y: 0, width: HALF_W, height: HALF_H });
    sheet.drawPage(embedded[i * 2 + 1], { x: HALF_W, y: 0, width: HALF_W, height: HALF_H });
  }
  return booklet.save();
}
