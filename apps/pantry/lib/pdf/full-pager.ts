// Full-pager: every location, grouped by area → city, listed by day (a location
// open several days appears under each). A dense, human-scannable reference on
// standard Letter paper, two columns.

import { buildModel, countEntries, type PantryRecord, type Lang } from "./model";
import { renderModel } from "./layout";

const LETTER_W = 612; // 8.5 in
const LETTER_H = 792; // 11 in

const STRINGS = {
  en: {
    title: "Greater Cleveland Food Resources",
    asOf: (d: string) => `Source as of ${d}. `,
    subtitle: (n: number, listings: number, asOf: string) =>
      `${n} locations · ${listings} listings by day · grouped by area and city. ${asOf}Hours change — call ahead.`,
    locale: "en-US",
  },
  es: {
    title: "Recursos de Alimentos del Gran Cleveland",
    asOf: (d: string) => `Fuente actualizada al ${d}. `,
    subtitle: (n: number, listings: number, asOf: string) =>
      `${n} lugares · ${listings} listados por día · agrupados por área y ciudad. ${asOf}Los horarios cambian — llame antes.`,
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
  const asOf = meta?.scrapedAt
    ? s.asOf(new Date(meta.scrapedAt).toLocaleDateString(s.locale, { year: "numeric", month: "short", day: "numeric" }))
    : "";
  const doc = await renderModel(model, {
    pageWidth: LETTER_W,
    pageHeight: LETTER_H,
    columns: 2,
    margin: 36,
    title: s.title,
    subtitle: s.subtitle(records.length, countEntries(model), asOf),
  });
  return doc.save();
}
