// Booklet (codex): the same directory laid out on half-Letter logical pages,
// then imposed two-up in saddle-stitch order onto Letter-landscape sheets. Print
// double-sided (flip on short edge), stack, fold down the middle, and the pages
// read in order.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { buildModel, formatSourceDate, LIVE_URL, type PantryRecord, type Lang } from "./model";
import { renderModel } from "./layout";
import { drawQr } from "./qr";
import { drawProduceRow } from "./produce";
import { NOTICE, CREDIT, CREDIT_URL, SCAN } from "./strings";

const HALF_W = 396; // 5.5 in — a folded half-page
const HALF_H = 612; // 8.5 in
const SHEET_W = 792; // 11 in — landscape sheet holding two half-pages
const SHEET_H = 612; // 8.5 in

const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.62, 0.4, 0.02);
const RED = rgb(0.72, 0.16, 0.12);

const STRINGS = {
  en: {
    title: "Greater Cleveland Food Resources",
    asOf: (d: string) => ` · source as of ${d}`,
    subtitle: (n: number, asOf: string) => `${n} locations · grouped by area and city, listed by day${asOf}.`,
    backTitle: "Find the latest version",
    backBody: "Search, filter by where you live, see today's hours.",
    notes: "Notes",
    locale: "en-US",
  },
  es: {
    title: "Recursos de Alimentos del Gran Cleveland",
    asOf: (d: string) => ` · fuente actualizada al ${d}`,
    subtitle: (n: number, asOf: string) => `${n} lugares · agrupados por área y ciudad, listados por día${asOf}.`,
    backTitle: "Encuentre la versión más reciente",
    backBody: "Busque, filtre por dónde vive, vea los horarios de hoy.",
    notes: "Notas",
    locale: "es-ES",
  },
} as const;

// A "Notes" page for the leaves saddle-stitch padding would otherwise leave
// blank — useful for jotting down which pantry, what day, what to bring.
function drawNotesPage(page: PDFPage, bold: PDFFont, label: string) {
  const m = 30;
  page.drawText(label, { x: m, y: HALF_H - m - 13, size: 13, font: bold, color: MUTED });
  for (let y = HALF_H - m - 40; y > m + 16; y -= 27) {
    page.drawLine({ start: { x: m, y }, end: { x: HALF_W - m, y }, thickness: 0.5, color: rgb(0.85, 0.87, 0.9) });
  }
}

// The QR back cover, drawn on the booklet's outside-back leaf.
function drawBackCover(page: PDFPage, helv: PDFFont, bold: PDFFont, s: (typeof STRINGS)[Lang], lang: Lang) {
  const center = (text: string, y: number, size: number, font: PDFFont, color = INK) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (HALF_W - w) / 2, y, size, font, color });
  };
  drawProduceRow(page, HALF_W / 2, 572, 20);
  center(s.backTitle, 512, 16, bold);
  center(s.backBody, 492, 9.5, helv, MUTED);

  const qs = 200;
  drawQr(page, LIVE_URL, (HALF_W - qs) / 2, 462, qs); // top at 462 → occupies 262..462
  center(SCAN[lang], 244, 9, helv, MUTED);
  center(CREDIT_URL, 228, 9.5, helv, ACCENT);

  page.drawLine({ start: { x: 60, y: 176 }, end: { x: HALF_W - 60, y: 176 }, thickness: 0.6, color: rgb(0.8, 0.82, 0.85) });
  center(NOTICE[lang], 150, 9.5, bold, RED);
  center(CREDIT[lang], 66, 8, helv, MUTED);
}

export async function buildBookletPdf(
  records: PantryRecord[],
  meta?: { scrapedAt?: string | null },
  lang: Lang = "en"
): Promise<Uint8Array> {
  const s = STRINGS[lang];
  const model = buildModel(records, lang);
  const asOf = meta?.scrapedAt ? s.asOf(formatSourceDate(meta.scrapedAt, s.locale)) : "";

  // 1. Render the content as ordinary sequential half-Letter pages.
  const logical = await renderModel(model, {
    pageWidth: HALF_W,
    pageHeight: HALF_H,
    columns: 1,
    margin: 30,
    title: s.title,
    subtitle: s.subtitle(records.length, asOf),
    notice: NOTICE[lang],
    credit: CREDIT[lang],
    creditUrl: CREDIT_URL,
    produce: true,
    bodyScale: 0.9, // the single wide column runs long lines to the trim at full size
  });
  const logicalBytes = await logical.save();

  // 2. Reserve the last leaf for a QR back cover, then pad to a multiple of 4
  //    (a folded sheet is 4 pages). The pad leaves go BEFORE the back cover, so
  //    the QR always lands on page N — the outside-back cover after imposition.
  //    Rather than leave them blank, make them "Notes" pages.
  const padded = await PDFDocument.load(logicalBytes);
  const helv = await padded.embedFont(StandardFonts.Helvetica);
  const bold = await padded.embedFont(StandardFonts.HelveticaBold);
  const L = padded.getPageCount();
  const n = Math.ceil((L + 1) / 4) * 4;
  for (let i = 0; i < n - L - 1; i++) {
    drawNotesPage(padded.addPage([HALF_W, HALF_H]), bold, s.notes);
  }
  drawBackCover(padded.addPage([HALF_W, HALF_H]), helv, bold, s, lang); // page n = outside back cover
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
