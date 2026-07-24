// The shared layout engine: flows a directory model into a multi-column,
// multi-page PDFDocument. Both the full-pager (Letter, 2 columns) and the
// booklet's logical pages (half-Letter, 1 column) call this with different page
// geometry, so the content rendering lives in exactly one place. pdf-lib only.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { RegionGroup } from "./model";

export interface LayoutOpts {
  pageWidth: number;
  pageHeight: number;
  columns: number;
  margin: number;
  title: string;
  subtitle?: string;
}

const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.62, 0.4, 0.02); // amber-ish, for eligibility
const RULE = rgb(0.8, 0.82, 0.85);

export async function renderModel(model: RegionGroup[], opts: LayoutOpts): Promise<PDFDocument> {
  const { pageWidth, pageHeight, columns, margin } = opts;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const gutter = 16;
  const usableW = pageWidth - margin * 2;
  const colW = (usableW - gutter * (columns - 1)) / columns;
  const footerH = 18;
  const bottomY = margin + footerH;

  let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
  let col = 0;
  let contentTop = pageHeight - margin;

  // Page-1 title block spans the full width; content starts beneath it.
  {
    let ty = pageHeight - margin;
    page.drawText(opts.title, { x: margin, y: ty - 18, size: 18, font: bold, color: INK });
    ty -= 24;
    if (opts.subtitle) {
      page.drawText(opts.subtitle, { x: margin, y: ty - 10, size: 9.5, font, color: MUTED });
      ty -= 16;
    }
    ty -= 8;
    contentTop = ty;
  }
  let y = contentTop;

  const colX = (c: number) => margin + c * (colW + gutter);

  function newPage() {
    page = doc.addPage([pageWidth, pageHeight]);
    col = 0;
    contentTop = pageHeight - margin;
    y = contentTop;
  }
  function nextColumn() {
    col += 1;
    if (col >= columns) newPage();
    else y = contentTop;
  }
  /** Ensure `h` points remain in the current column, else advance. */
  function reserve(h: number) {
    if (y - h < bottomY) nextColumn();
  }

  function wrap(text: string, f: PDFFont, size: number, maxW: number): string[] {
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      const trial = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(trial, size) <= maxW) {
        line = trial;
        continue;
      }
      if (line) out.push(line);
      if (f.widthOfTextAtSize(word, size) > maxW) {
        let chunk = "";
        for (const ch of word) {
          if (f.widthOfTextAtSize(chunk + ch, size) <= maxW) chunk += ch;
          else {
            if (chunk) out.push(chunk);
            chunk = ch;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  }

  /** Draw wrapped text at the cursor; may break across columns for long runs. */
  function text(str: string, f: PDFFont, size: number, color = INK, gap = 1.5) {
    for (const ln of wrap(str, f, size, colW)) {
      reserve(size + gap);
      page.drawText(ln, { x: colX(col), y: y - size, size, font: f, color });
      y -= size + gap;
    }
  }

  for (const region of model) {
    // Keep a region header with at least its first city + an entry.
    reserve(52);
    y -= 6;
    reserve(18);
    page.drawText(region.label.toUpperCase(), {
      x: colX(col),
      y: y - 12,
      size: 12,
      font: bold,
      color: INK,
    });
    y -= 15;
    page.drawLine({
      start: { x: colX(col), y: y },
      end: { x: colX(col) + colW, y: y },
      thickness: 0.7,
      color: RULE,
    });
    y -= 8;

    for (const cityGroup of region.cities) {
      reserve(34);
      y -= 2;
      page.drawText(cityGroup.city, { x: colX(col), y: y - 10.5, size: 10.5, font: bold, color: INK });
      y -= 15;

      for (const dayGroup of cityGroup.days) {
        reserve(26);
        page.drawText(dayGroup.label, { x: colX(col), y: y - 8.5, size: 8.5, font: bold, color: MUTED });
        y -= 12;

        for (const e of dayGroup.entries) {
          reserve(14);
          y -= 1;
          text(e.title, bold, 9, INK, 1.5);
          text(e.address, font, 7.5, MUTED, 1);
          const line = e.phone ? `${e.hours}  ·  ${e.phone}` : e.hours;
          text(line, font, 8, INK, 1);
          if (e.residency) text(e.residency, italic, 7.5, ACCENT, 1);
          if (e.note) text(e.note, italic, 7, ACCENT, 1);
          y -= 4;
        }
        y -= 2;
      }
      y -= 4;
    }
    y -= 6;
  }

  // Footers: page numbers, added once totals are known.
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${total}`;
    const w = font.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: (pageWidth - w) / 2, y: margin - 2, size: 8, font, color: MUTED });
  });

  return doc;
}
