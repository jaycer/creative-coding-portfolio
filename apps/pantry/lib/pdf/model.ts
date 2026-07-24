// Framework-agnostic content model for the printable directory. Both PDF
// layouts (full-pager and booklet) render this same structure, and it has no
// dependency on the app, the DB, or pdf-lib — so it can be reused verbatim by
// the static portfolio build.

import { residencyLabel } from "../eligibility-format";

export const PDF_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type PdfDay = (typeof PDF_DAYS)[number];

const DAY_LABEL: Record<PdfDay, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

// The subset of a location the printable needs. `Location` (lib/db.ts) and the
// portfolio's JSON records are both structurally assignable to this.
export interface PantryRecord {
  title: string;
  address: string;
  city: string;
  zip: string;
  phone: string | null;
  region: "east" | "west" | null;
  residency_cities: string[] | null;
  eligibility_note: string | null;
  monday_hours: string | null;
  tuesday_hours: string | null;
  wednesday_hours: string | null;
  thursday_hours: string | null;
  friday_hours: string | null;
  saturday_hours: string | null;
  sunday_hours: string | null;
}

export interface Entry {
  title: string;
  address: string; // "123 Main St, Parma, OH 44134"
  phone: string | null;
  hours: string; // this day's hours text
  residency: string | null; // "Parma residents only"
  note: string | null; // extra eligibility note
}
export interface DayGroup {
  day: PdfDay;
  label: string;
  entries: Entry[];
}
export interface CityGroup {
  city: string;
  days: DayGroup[];
}
export interface RegionGroup {
  key: "west" | "east" | "other";
  label: string;
  cities: CityGroup[];
}

// Region order + labels. "Other" collects the many suburbs/exurbs with no
// east/west classification so nothing is dropped.
const REGION_SPECS: { key: RegionGroup["key"]; label: string; match: (r: PantryRecord["region"]) => boolean }[] = [
  { key: "west", label: "West Side", match: (r) => r === "west" },
  { key: "east", label: "East Side", match: (r) => r === "east" },
  { key: "other", label: "Other Areas", match: (r) => r !== "west" && r !== "east" },
];

function hoursFor(rec: PantryRecord, day: PdfDay): string | null {
  const v = rec[`${day}_hours` as keyof PantryRecord] as string | null;
  return v && v.trim() ? v.trim() : null;
}

/**
 * Build the ordered model: geography → city (A–Z) → day (Mon–Sun) → entries.
 * A location open on several days appears once per day — the intended
 * duplication that makes the printed page easy to scan ("what's open here on
 * Tuesday?").
 */
export function buildModel(records: PantryRecord[]): RegionGroup[] {
  const out: RegionGroup[] = [];
  for (const spec of REGION_SPECS) {
    const inRegion = records.filter((r) => spec.match(r.region));
    if (!inRegion.length) continue;

    const cityNames = [...new Set(inRegion.map((r) => r.city))].sort((a, b) =>
      a.localeCompare(b)
    );
    const cities: CityGroup[] = [];
    for (const city of cityNames) {
      const inCity = inRegion.filter((r) => r.city === city);
      const days: DayGroup[] = [];
      for (const day of PDF_DAYS) {
        const entries: Entry[] = inCity
          .map((rec) => {
            const hours = hoursFor(rec, day);
            if (!hours) return null;
            return {
              title: rec.title,
              address: `${rec.address}, ${rec.city}, OH ${rec.zip}`,
              phone: rec.phone,
              hours,
              residency: residencyLabel(rec.residency_cities),
              note: rec.eligibility_note,
            } as Entry;
          })
          .filter((e): e is Entry => e !== null)
          .sort((a, b) => a.title.localeCompare(b.title));
        if (entries.length) days.push({ day, label: DAY_LABEL[day], entries });
      }
      if (days.length) cities.push({ city, days });
    }
    if (cities.length) out.push({ key: spec.key, label: spec.label, cities });
  }
  return out;
}

/** Total entry count (with duplicates) — handy for a cover/subtitle. */
export function countEntries(model: RegionGroup[]): number {
  let n = 0;
  for (const r of model) for (const c of r.cities) for (const d of c.days) n += d.entries.length;
  return n;
}
