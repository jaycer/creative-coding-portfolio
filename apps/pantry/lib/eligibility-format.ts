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

// ---- schedule strings ------------------------------------------------------
const DAY_ES: Record<string, string> = {
  monday: "lunes", tuesday: "martes", wednesday: "miércoles", thursday: "jueves",
  friday: "viernes", saturday: "sábado", sunday: "domingo",
};
// Days are masculine in Spanish (el lunes, el sábado), so ordinals take the
// pre-noun masculine form. "Other <day>" means every other week → "cada dos".
const ORD_ES: Record<string, string> = {
  first: "primer", second: "segundo", third: "tercer", thrid: "tercer",
  fourth: "cuarto", fifth: "quinto", last: "último", other: "cada dos",
};

/**
 * Translate a GCFB schedule string ("Third Friday 9:00 AM - 11:00 AM") into
 * Spanish. Bounded vocabulary — ordinals, weekday names, AM/PM — with the times
 * and punctuation left intact. English (or any other lang) passes through.
 */
export function localizeHours(hours: string | null | undefined, lang: Lang = "en"): string {
  if (!hours) return "";
  if (lang !== "es") return hours;
  const s = hours
    .replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi, (m) => DAY_ES[m.toLowerCase()])
    .replace(/\b(First|Second|Third|Thrid|Fourth|Fifth|Last|Other)\b/gi, (m) => ORD_ES[m.toLowerCase()])
    .replace(/\band\b/gi, "y")
    .replace(/\bAM\b/g, "a. m.")
    .replace(/\bPM\b/g, "p. m.");
  return s.replace(/^(\s*)(\p{L})/u, (_, sp, c) => sp + c.toUpperCase());
}

// ---- eligibility notes -----------------------------------------------------
// Hand-curated Spanish for the 25 distinct GCFB eligibility notes (the pure-ZIP
// ones need no translation and fall through). Keyed by the exact English text.
export const NOTE_ES: Record<string, string> = {
  "Please Call Ahead": "Llame antes",
  "44105. Closed week of 6/8-12/26 44105": "44105. Cerrado la semana del 6/8-12/26. 44105",
  "3 Saturday in November and December Restricted 44103, 44106, 44108, 44110":
    "3.er sábado en noviembre y diciembre. Restringido: 44103, 44106, 44108, 44110",
  "44111, 44135 and 4412": "44111, 44135 y 4412",
  "Please Call Ahead Please Call Ahead closed 7/3/2026": "Llame antes. Cerrado el 7/3/2026",
  "44110, 44119 closed 5/25/26 Restricted Service Area- 44110, 44119 closed 4/1/26":
    "44110, 44119. Cerrado 5/25/26. Área de servicio restringida: 44110, 44119. Cerrado 4/1/26",
  "Please Call Ahead closed 5/25/26 Please Call Ahead": "Llame antes. Cerrado 5/25/26",
  "44103, 44104 closed 5/26/26": "44103, 44104. Cerrado 5/26/26",
  "All of Cuyahoga County": "Todo el condado de Cuyahoga",
  "44123, 44132, 44117, 44119, 44143 (limited area).": "44123, 44132, 44117, 44119, 44143 (área limitada).",
  "Lakewood residents only; served 1x a month": "Solo residentes de Lakewood; atendido 1 vez al mes",
  "All of Cuyahoga County closed 5/18; 5/25/26 All of Cuyahoga County closed 6/10/26":
    "Todo el condado de Cuyahoga. Cerrado 5/18; 5/25/26. Todo el condado de Cuyahoga. Cerrado 6/10/26",
  "44112, 44118 closed 5/25/26 44112, 44118": "44112, 44118. Cerrado 5/25/26. 44112, 44118",
  "44110, 44119, 44112 - CLOSED 7/6/26 44110, 44119, 44112 - CLOSED 7/3/26":
    "44110, 44119, 44112 - CERRADO 7/6/26. 44110, 44119, 44112 - CERRADO 7/3/26",
  "PARMA RESIDENTS ONLY": "SOLO RESIDENTES DE PARMA",
  "Restricted distribution at Harper's Point, 3875 West 25": "Distribución restringida en Harper's Point, 3875 West 25",
  "Please Call Ahead Zip codes: 44130; 44133; 44147": "Llame antes. Códigos postales: 44130; 44133; 44147",
  "Please Call Ahead- Geneva School District Only": "Llame antes. Solo distrito escolar de Geneva",
  "restricted to residents of Villa Mercede Apartments, 1331 West 70th St restricted to residents of Northridge Commons, 10462 Detroit Ave.":
    "Restringido a residentes de Villa Mercede Apartments, 1331 West 70th St. Restringido a residentes de Northridge Commons, 10462 Detroit Ave.",
  "Food pantry: must live in 44102, 44113, or 44109. Bring ID and proof of address. Household income must be under 200% of the federal poverty level. (From the facility's flyer, not in GCFB data.)":
    "Despensa de alimentos: debe vivir en 44102, 44113 o 44109. Traiga identificación y comprobante de domicilio. El ingreso del hogar debe ser inferior al 200% del nivel federal de pobreza. (Del folleto del lugar; no está en los datos de GCFB.)",
};

/** Spanish for an eligibility note: an explicit override wins, then the curated
 *  map, else the original text (pure-ZIP notes need no translation). */
export function localizeNote(
  note: string | null | undefined,
  lang: Lang = "en",
  overrideEs?: string | null
): string | null {
  if (!note) return null;
  if (lang !== "es") return note;
  return overrideEs || NOTE_ES[note] || note;
}
