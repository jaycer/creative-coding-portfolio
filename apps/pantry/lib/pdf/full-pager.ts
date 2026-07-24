// Full-pager: every location, grouped by area → city, listed by day (a location
// open several days appears under each). A dense, human-scannable reference on
// standard Letter paper, two columns.

import { StandardFonts, rgb } from "pdf-lib";
import { buildModel, countEntries, formatSourceDate, LIVE_URL, type PantryRecord, type Lang } from "./model";
import { renderModel } from "./layout";
import { drawQr } from "./qr";
import { NOTICE, CREDIT, CREDIT_URL, SCAN_SHORT } from "./strings";

const LETTER_W = 612; // 8.5 in
const LETTER_H = 792; // 11 in

const STRINGS = {
  en: {
    title: "Greater Cleveland Food Resources",
    asOf: (d: string) => `Source as of ${d}. `,
    subtitle: (n: number, listings: number, asOf: string) =>
      `${n} locations · ${listings} listings by day · grouped by area and city. ${asOf}`,
    locale: "en-US",
  },
  es: {
    title: "Recursos de Alimentos del Gran Cleveland",
    asOf: (d: string) => `Fuente actualizada al ${d}. `,
    subtitle: (n: number, listings: number, asOf: string) =>
      `${n} lugares · ${listings} listados por día · agrupados por área y ciudad. ${asOf}`,
    locale: "es-ES",
  },
} as const;

export async function buildFullPagerPdf(
  records: PantryRecord[],
  meta?: { scrapedAt?: string | null },
  lang: Lang = "en"
): Promise<Uint8Array> {
  const s = STRINGS[lang];
  const model = buildModel(records, lang);
  const asOf = meta?.scrapedAt ? s.asOf(formatSourceDate(meta.scrapedAt, s.locale)) : "";
  const doc = await renderModel(model, {
    pageWidth: LETTER_W,
    pageHeight: LETTER_H,
    columns: 2,
    margin: 36,
    title: s.title,
    subtitle: s.subtitle(records.length, countEntries(model), asOf),
    notice: NOTICE[lang],
    credit: CREDIT[lang],
    creditUrl: CREDIT_URL,
    produce: true,
  });

  // A small QR to the live site in the top-right of page 1.
  const page1 = doc.getPage(0);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const qs = 62;
  const qx = LETTER_W - 36 - qs;
  const qy = LETTER_H - 36;
  drawQr(page1, LIVE_URL, qx, qy, qs);
  const cap = SCAN_SHORT[lang];
  const capW = helv.widthOfTextAtSize(cap, 6.5);
  page1.drawText(cap, {
    x: qx + (qs - capW) / 2,
    y: qy - qs - 8,
    size: 6.5,
    font: helv,
    color: rgb(0.42, 0.45, 0.5),
  });

  return doc.save();
}
