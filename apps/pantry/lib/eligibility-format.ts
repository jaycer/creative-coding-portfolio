// Pure, dependency-free formatting for eligibility — safe to import in client
// components and in the portfolio bundle (unlike lib/eligibility.ts, which
// reads the overlay file with `fs` at seed time).

/** A short badge label for a residency restriction, or null if open to all. */
export function residencyLabel(cities: string[] | null | undefined): string | null {
  if (!cities || cities.length === 0) return null;
  if (cities.length === 1) return `${cities[0]} residents only`;
  if (cities.length === 2) return `${cities[0]} & ${cities[1]} residents only`;
  return `${cities.slice(0, 2).join(", ")} +${cities.length - 2} more — residents only`;
}
