// Pure, dependency-free, language-aware formatting for eligibility — safe to
// import in client components, the PDF builders, and the portfolio bundle
// (unlike lib/eligibility.ts, which reads the overlay file with `fs`).

export type Lang = "en" | "es";

/**
 * A short badge label for a residency restriction, or null if open to all.
 * Prefers city names; falls back to ZIP codes when only ZIPs are known.
 */
export function residencyLabel(
  cities: string[] | null | undefined,
  zips?: string[] | null | undefined,
  lang: Lang = "en"
): string | null {
  const es = lang === "es";
  if (cities && cities.length) {
    const list =
      cities.length <= 2
        ? cities.join(es ? " y " : " & ")
        : `${cities.slice(0, 2).join(", ")} +${cities.length - 2} ${es ? "más" : "more"}`;
    return es ? `Solo residentes de ${list}` : `${list} residents only`;
  }
  if (zips && zips.length) {
    const list = zips.length <= 3 ? zips.join(", ") : `${zips.slice(0, 3).join(", ")} +${zips.length - 3}`;
    return es ? `Solo ZIP ${list}` : `ZIP ${list} only`;
  }
  return null;
}

/** A short human label for where an eligibility record came from. */
export function provenanceLabel(source: string | null | undefined, lang: Lang = "en"): string | null {
  const es = lang === "es";
  if (source === "gcfb-parsed") return es ? "de las notas de GCFB" : "from GCFB notes";
  if (source === "overlay") return es ? "agregado de un folleto del lugar / verificado" : "added from a facility flyer / verified";
  return null;
}
