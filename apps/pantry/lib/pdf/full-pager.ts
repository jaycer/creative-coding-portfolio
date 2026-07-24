// Full-pager: every location, grouped by area → city, listed by day (a location
// open several days appears under each). A dense, human-scannable reference on
// standard Letter paper, two columns.

import { buildModel, countEntries, type PantryRecord } from "./model";
import { renderModel } from "./layout";

const LETTER_W = 612; // 8.5 in
const LETTER_H = 792; // 11 in

export async function buildFullPagerPdf(
  records: PantryRecord[],
  meta?: { scrapedAt?: string | null }
): Promise<Uint8Array> {
  const model = buildModel(records);
  const asOf = meta?.scrapedAt
    ? `Source as of ${new Date(meta.scrapedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}. `
    : "";
  const doc = await renderModel(model, {
    pageWidth: LETTER_W,
    pageHeight: LETTER_H,
    columns: 2,
    margin: 36,
    title: "Greater Cleveland Food Resources",
    subtitle: `${records.length} locations · ${countEntries(model)} listings by day · grouped by area and city. ${asOf}Hours change — call ahead.`,
  });
  return doc.save();
}
