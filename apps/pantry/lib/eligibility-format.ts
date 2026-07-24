// Pure, dependency-free formatting for eligibility — safe to import in client
// components and in the portfolio bundle (unlike lib/eligibility.ts, which
// reads the overlay file with `fs` at seed time).

/**
 * A short badge label for a residency restriction, or null if open to all.
 * Prefers city names ("Parma residents only"); falls back to ZIP codes
 * ("ZIP 44102, 44113 only") when only ZIPs are known.
 */
export function residencyLabel(
  cities: string[] | null | undefined,
  zips?: string[] | null | undefined
): string | null {
  if (cities && cities.length) {
    if (cities.length === 1) return `${cities[0]} residents only`;
    if (cities.length === 2) return `${cities[0]} & ${cities[1]} residents only`;
    return `${cities.slice(0, 2).join(", ")} +${cities.length - 2} more — residents only`;
  }
  if (zips && zips.length) {
    if (zips.length <= 3) return `ZIP ${zips.join(", ")} only`;
    return `ZIP ${zips.slice(0, 3).join(", ")} +${zips.length - 3} more`;
  }
  return null;
}

/** A short human label for where an eligibility record came from. */
export function provenanceLabel(source: string | null | undefined): string | null {
  if (source === "gcfb-parsed") return "from GCFB notes";
  if (source === "overlay") return "added from a facility flyer / verified";
  return null;
}
