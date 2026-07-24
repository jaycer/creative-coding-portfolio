import "./style.css";
import data from "./data.json";
import type { PantryRecord, Lang } from "./lib/pdf/model";
import { formatSourceDate } from "./lib/pdf/model";
import { residencyLabel, provenanceLabel } from "./lib/eligibility-format";

// A record carries everything PantryRecord needs plus id/notes for the UI, and
// the display-only bilingual extras from the eligibility overlay.
interface Loc extends PantryRecord {
  id: number;
  category: string;
  category_source: string | null;
  notes: string | null;
  eligibility_source: string | null;
  eligibility_note_es: string | null;
  supplemental: { en: string; es: string } | null;
}

const RECORDS = data.locations as unknown as Loc[];
const PANTRY_CITIES = data.cities as string[];

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
type Day = (typeof DAYS)[number];

const DAY_LABEL: Record<Lang, Record<Day, string>> = {
  en: {
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday",
    sunday: "Sunday",
  },
  es: {
    monday: "Lunes",
    tuesday: "Martes",
    wednesday: "Miércoles",
    thursday: "Jueves",
    friday: "Viernes",
    saturday: "Sábado",
    sunday: "Domingo",
  },
};
const DAY_SHORT: Record<Lang, Record<Day, string>> = {
  en: { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" },
  es: { monday: "Lun", tuesday: "Mar", wednesday: "Mié", thursday: "Jue", friday: "Vie", saturday: "Sáb", sunday: "Dom" },
};

// Category filter keys off the raw (English) data value; only the label is
// translated so filtering stays stable in both languages.
const CATEGORY_ORDER = ["Pantry", "Mobile Pantry", "Hot Meals"];
const CATEGORY_LABEL: Record<Lang, Record<string, string>> = {
  en: { Pantry: "Pantry", "Mobile Pantry": "Mobile Pantry", "Hot Meals": "Hot Meals" },
  es: { Pantry: "Despensa", "Mobile Pantry": "Despensa móvil", "Hot Meals": "Comidas calientes" },
};
const REGION_LABEL: Record<Lang, { west: string; east: string; other: string }> = {
  en: { west: "West Side", east: "East Side", other: "Other areas" },
  es: { west: "Lado Oeste", east: "Lado Este", other: "Otras áreas" },
};

// ---- theme (system → light → dark), persisted ------------------------------
type Theme = "system" | "light" | "dark";
const THEME_KEY = "pantry-theme";
const THEME_ORDER: Theme[] = ["system", "light", "dark"];
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const THEME_LABEL: Record<Lang, Record<Theme, string>> = {
  en: { system: "System", light: "Light", dark: "Dark" },
  es: { system: "Sistema", light: "Claro", dark: "Oscuro" },
};
const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}
let theme: Theme = loadTheme();

// Toggle the .dark class on <html>; the inline script in index.html does this
// before first paint, and we keep it in sync here. JS is the single source of
// truth so an explicit light/dark choice can override the OS preference.
function applyTheme() {
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && prefersDark())
  );
}

function cycleTheme() {
  theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme();
  syncThemeBtn();
}

function syncThemeBtn() {
  const btn = document.getElementById("theme-btn");
  if (!btn) return;
  btn.querySelector(".theme-ico")!.textContent = THEME_ICON[theme];
  btn.querySelector(".theme-label")!.textContent = THEME_LABEL[lang][theme];
}

// Follow the OS live while the choice is "system".
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "system") applyTheme();
});

// ---- i18n dictionary -------------------------------------------------------
const T = {
  en: {
    back: "Gallery",
    title: "Food Access Directory for Greater Cleveland",
    headerTitle: "Food Directory",
    intro: (n: number, source: string) =>
      `${n} free food sources — pantries, hot meals, and mobile pantries — cleansed from ${source} data.`,
    freshness: (asOf: string, compiled: string) =>
      `Source as of ${asOf} · compiled ${compiled}. Hours change — call ahead.`,
    banner:
      "Please call ahead before you go. This directory is compiled from public data that could be out-of-date.",
    search: "Search",
    searchPh: "name, city, address",
    category: "Category",
    all: "All",
    area: "Area",
    dayOpen: "Day open",
    any: "Any",
    city: "City",
    youLiveIn: "You live in",
    anywhere: "Anywhere",
    orZip: "…or your ZIP",
    zipPh: "e.g. 44113",
    pdfPill: "PDF",
    exportTitle: "Download PDF with all locations",
    fullTitle: "Full-pager",
    fullDesc: "Standard letter pages",
    bookletTitle: "Booklet",
    bookletDesc: "Pocket-sized pages",
    building: "Building…",
    pdfError: "Sorry — the PDF couldn't be generated.",
    thName: "Name",
    thArea: "Area",
    thCity: "City",
    thDays: "Days open",
    thPhone: "Phone",
    empty: "No locations match these filters. Try clearing one.",
    countOf: (a: number, b: number) => `${a} of ${b}`,
    closed: "Closed",
    eligibility: "Eligibility",
    otherServices: "Other services here",
    categoryInferred: "Category added by us — GCFB left this site uncategorized. Classified as a mobile pantry from its monthly, host-site distribution schedule.",
    themeAria: "Theme",
    localeTag: "en-US",
  },
  es: {
    back: "Galería",
    title: "Directorio de Acceso a Alimentos del Gran Cleveland",
    headerTitle: "Directorio de Alimentos",
    intro: (n: number, source: string) =>
      `${n} fuentes de alimentos gratis — despensas, comidas calientes y despensas móviles — depurados de datos de ${source}.`,
    freshness: (asOf: string, compiled: string) =>
      `Fuente actualizada al ${asOf} · compilado ${compiled}. Los horarios cambian — llame antes.`,
    banner:
      "Por favor llame antes de ir. Este directorio se compila de datos públicos que podrían estar desactualizados.",
    search: "Buscar",
    searchPh: "nombre, ciudad, dirección",
    category: "Categoría",
    all: "Todas",
    area: "Zona",
    dayOpen: "Día abierto",
    any: "Cualquiera",
    city: "Ciudad",
    youLiveIn: "Usted vive en",
    anywhere: "Cualquier lugar",
    orZip: "…o su código postal",
    zipPh: "ej. 44113",
    pdfPill: "PDF",
    exportTitle: "Descargar PDF con todos los lugares",
    fullTitle: "Página completa",
    fullDesc: "Páginas tamaño carta",
    bookletTitle: "Folleto",
    bookletDesc: "Páginas de bolsillo",
    building: "Generando…",
    pdfError: "Lo sentimos — no se pudo generar el PDF.",
    thName: "Nombre",
    thArea: "Zona",
    thCity: "Ciudad",
    thDays: "Días abiertos",
    thPhone: "Teléfono",
    empty: "Ningún lugar coincide con estos filtros. Intente quitar uno.",
    countOf: (a: number, b: number) => `${a} de ${b}`,
    closed: "Cerrado",
    eligibility: "Requisitos",
    otherServices: "Otros servicios aquí",
    categoryInferred: "Categoría agregada por nosotros — GCFB dejó este lugar sin categoría. Clasificado como despensa móvil según su horario mensual de distribución en el sitio anfitrión.",
    themeAria: "Tema",
    localeTag: "es-ES",
  },
} as const;

// ---- language state (persisted) --------------------------------------------
const LANG_KEY = "pantry-lang";
function loadLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "es" || v === "en") return v;
  } catch {
    /* ignore */
  }
  return "en";
}
let lang: Lang = loadLang();
const t = () => T[lang];

// Residence options: pantry cities plus any city that appears as a service
// restriction, so e.g. a Lakewood resident can pick "Lakewood" even if no
// pantry's own city is Lakewood.
const RESIDE_CITIES = [
  ...new Set([...PANTRY_CITIES, ...RECORDS.flatMap((r) => r.residency_cities ?? [])]),
].sort((a, b) => a.localeCompare(b));

const hoursOf = (loc: Loc, day: Day) => (loc[`${day}_hours`] as string | null) || null;
const openDays = (loc: Loc): Day[] => DAYS.filter((d) => hoursOf(loc, d));

// Many sites run on a monthly cadence baked into the raw hours string, e.g.
// "Third Friday 9:00 AM - 11:00 AM" or "Second and Fourth Saturday …". Pull that
// week-of-month qualifier out so the day column can read "3rd Fri" instead of a
// plain "Fri" that implies weekly. Returns "" for weekly schedules.
const EN_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ORD_WORD: Record<Lang, Record<string, string>> = {
  en: { first: "1st", second: "2nd", third: "3rd", thrid: "3rd", fourth: "4th", fifth: "5th", last: "Last", other: "Alt" },
  es: { first: "1.º", second: "2.º", third: "3.º", thrid: "3.º", fourth: "4.º", fifth: "5.º", last: "Últ.", other: "Alt" },
};
function ordinalPrefix(hours: string | null): string {
  if (!hours) return "";
  let pre = "";
  for (const dn of EN_DAY_NAMES) {
    const i = hours.indexOf(dn);
    if (i === 0) return ""; // weekday leads the string → weekly
    if (i > 0) { pre = hours.slice(0, i); break; }
  }
  // "thrid and fourth" is a source typo for "third"; keep it mapped.
  const parts = pre
    .toLowerCase()
    .split(/[,&]|\band\b/)
    .map((s) => ORD_WORD[lang][s.trim()])
    .filter(Boolean) as string[];
  if (parts.length <= 1) return parts[0] ?? "";
  return parts.slice(0, -1).join(", ") + " & " + parts[parts.length - 1];
}
const dayShortLabel = (loc: Loc, d: Day): string => {
  const ord = ordinalPrefix(hoursOf(loc, d));
  return ord ? `${ord} ${DAY_SHORT[lang][d]}` : DAY_SHORT[lang][d];
};
const regionKey = (loc: Loc): "west" | "east" | "other" =>
  loc.region === "west" || loc.region === "east" ? loc.region : "other";
const regionLabel = (loc: Loc) => (loc.region ? REGION_LABEL[lang][regionKey(loc)] : "—");

const state = { q: "", category: "", region: "", day: "", city: "", reside: "", resideZip: "" };

function matches(loc: Loc): boolean {
  if (state.category && loc.category !== state.category) return false;
  if (state.region && regionKey(loc) !== state.region) return false;
  if (state.day && !hoursOf(loc, state.day as Day)) return false;
  if (state.city && loc.city !== state.city) return false;
  // Residence: each dimension only constrains locations restricted on it, so a
  // ZIP-restricted pantry isn't hidden when you filter only by city, and vice versa.
  if (state.reside && loc.residency_cities && !loc.residency_cities.includes(state.reside)) return false;
  if (state.resideZip && loc.residency_zips && !loc.residency_zips.includes(state.resideZip)) return false;
  if (state.q) {
    const q = state.q.toLowerCase();
    if (![loc.title, loc.city, loc.address].some((f) => f.toLowerCase().includes(q))) return false;
  }
  return true;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function option(v: string, label: string, sel: string) {
  return `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(label)}</option>`;
}

const fmtDate = (s: string | null | undefined) => (s ? formatSourceDate(s, t().localeTag) : "—");
const META = data as unknown as { scrapedAt?: string | null; compiledAt?: string | null };

// PDF option icons (stroke-based, inherit currentColor): a single page with a
// folded corner for the full-pager, an open book for the fold-up booklet.
const ICON_FULL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-17a.5.5 0 0 1 .5-.5z"/><path d="M14 3v4h4"/><path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4"/></svg>`;
const ICON_BOOKLET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6C10.3 4.8 7.6 4.3 4.5 5v13.2c3.1-.7 5.8-.2 7.5 1 1.7-1.2 4.4-1.7 7.5-1V5C16.4 4.3 13.7 4.8 12 6z"/><path d="M12 6v13.2"/></svg>`;

// ---- shell -----------------------------------------------------------------
const app = document.getElementById("app")!;
let results!: HTMLElement;
let countEl!: HTMLElement;

function mount() {
  const tr = t();
  const freshness = tr.freshness(fmtDate(META.scrapedAt), fmtDate(META.compiledAt));
  app.innerHTML = `
  <header class="bar">
    <a class="back" href="../../" aria-label="${esc(tr.back)}"><span class="back-arrow" aria-hidden="true">←</span><span class="back-label">${esc(tr.back)}</span></a>
    <h1>${esc(tr.headerTitle)}</h1>
    <div class="bar-right">
      <button class="pdf-pill" id="open-pdf" type="button">
        <span class="pdf-pill-ico" aria-hidden="true">${ICON_FULL}</span><span>${esc(tr.pdfPill)}</span><span class="pdf-pill-ico" aria-hidden="true">${ICON_BOOKLET}</span>
      </button>
      <div class="lang" role="group" aria-label="Language">
        <button class="lang-btn${lang === "en" ? " on" : ""}" data-lang="en">EN</button>
        <button class="lang-btn${lang === "es" ? " on" : ""}" data-lang="es">ES</button>
      </div>
      <button class="theme-btn" id="theme-btn" type="button" aria-label="${esc(tr.themeAria)}">
        <span class="theme-ico" aria-hidden="true">${THEME_ICON[theme]}</span>
        <span class="theme-label">${esc(THEME_LABEL[lang][theme])}</span>
      </button>
    </div>
  </header>
  <div class="wrap">
    <div class="banner" role="note">
      <span class="banner-ico" aria-hidden="true">☎</span>
      <p>${esc(tr.banner)}</p>
    </div>
    <p class="intro">${esc(tr.intro(data.count, data.source))}<br/>${esc(freshness)}</p>
    <div class="controls">
      <div class="row">
        <div class="field"><label>${esc(tr.search)}</label><input id="f-q" type="search" placeholder="${esc(
          tr.searchPh
        )}" /></div>
        <div class="field"><label>${esc(tr.category)}</label><select id="f-category"><option value="">${esc(
          tr.all
        )}</option>${CATEGORY_ORDER.map((c) => option(c, CATEGORY_LABEL[lang][c] ?? c, state.category)).join(
          ""
        )}</select></div>
        <div class="field"><label>${esc(tr.area)}</label><select id="f-region"><option value="">${esc(
          tr.all
        )}</option>${(["west", "east", "other"] as const)
          .map((k) => option(k, REGION_LABEL[lang][k], state.region))
          .join("")}</select></div>
        <div class="field"><label>${esc(tr.dayOpen)}</label><select id="f-day"><option value="">${esc(
          tr.any
        )}</option>${DAYS.map((d) => option(d, DAY_LABEL[lang][d], state.day)).join("")}</select></div>
        <div class="field"><label>${esc(tr.city)}</label><select id="f-city"><option value="">${esc(
          tr.all
        )}</option>${PANTRY_CITIES.map((c) => option(c, c, state.city)).join("")}</select></div>
        <div class="field"><label>${esc(tr.youLiveIn)}</label><select id="f-reside"><option value="">${esc(
          tr.anywhere
        )}</option>${RESIDE_CITIES.map((c) => option(c, c, state.reside)).join("")}</select></div>
        <div class="field"><label>${esc(tr.orZip)}</label><input id="f-resideZip" type="text" inputmode="numeric" maxlength="5" placeholder="${esc(
          tr.zipPh
        )}" value="${esc(state.resideZip)}" style="min-width:100px" /></div>
      </div>
    </div>
    <div class="count-line" id="count"></div>
    <div id="results"></div>
  </div>
  <div class="scrim" id="scrim" hidden><div class="sheet" id="sheet" role="dialog" aria-modal="true"></div></div>
  <div class="scrim" id="pdf-scrim" hidden>
    <div class="sheet pdf-sheet" role="dialog" aria-modal="true" aria-label="${esc(tr.exportTitle)}">
      <div class="sheet-head">
        <h2>${esc(tr.exportTitle)}</h2>
        <button class="close" id="pdf-close" aria-label="Close">×</button>
      </div>
      <div class="pdf-options">
        <div class="pdf-row">
          <span class="pdf-option-ico" aria-hidden="true">${ICON_FULL}</span>
          <span class="pdf-option-text">
            <span class="pdf-option-title">${esc(tr.fullTitle)}</span>
            <span class="pdf-option-desc">${esc(tr.fullDesc)}</span>
          </span>
          <span class="pdf-langs">
            <button class="pdf-lang" data-kind="full" data-lang="en" type="button">English</button>
            <button class="pdf-lang" data-kind="full" data-lang="es" type="button">Español</button>
          </span>
        </div>
        <div class="pdf-row">
          <span class="pdf-option-ico" aria-hidden="true">${ICON_BOOKLET}</span>
          <span class="pdf-option-text">
            <span class="pdf-option-title">${esc(tr.bookletTitle)}</span>
            <span class="pdf-option-desc">${esc(tr.bookletDesc)}</span>
          </span>
          <span class="pdf-langs">
            <button class="pdf-lang" data-kind="booklet" data-lang="en" type="button">English</button>
            <button class="pdf-lang" data-kind="booklet" data-lang="es" type="button">Español</button>
          </span>
        </div>
      </div>
    </div>
  </div>
`;

  results = document.getElementById("results")!;
  countEl = document.getElementById("count")!;

  // language toggle
  app.querySelectorAll<HTMLButtonElement>(".lang-btn").forEach((b) =>
    b.addEventListener("click", () => setLang(b.dataset.lang as Lang))
  );

  // theme pill (cycles system → light → dark)
  document.getElementById("theme-btn")!.addEventListener("click", cycleTheme);

  // restore search box (state persists across re-mount)
  (document.getElementById("f-q") as HTMLInputElement).value = state.q;

  bindFilters();
  bindResults();
  bindExports();

  // The scrim/modal live inside the re-mounted markup, so (re)bind here.
  const scrim = document.getElementById("scrim")!;
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) closeDetail();
  });

  render();
}

function setLang(l: Lang) {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = l;
  mount();
}

function render() {
  const tr = t();
  const shown = RECORDS.filter(matches);
  countEl.textContent = tr.countOf(shown.length, RECORDS.length);

  if (!shown.length) {
    results.innerHTML = `<p class="empty">${esc(tr.empty)}</p>`;
    return;
  }

  let html = "";
  for (const cat of CATEGORY_ORDER) {
    const rows = shown.filter((r) => r.category === cat).sort((a, b) => a.title.localeCompare(b.title));
    if (!rows.length) continue;
    html += `<div class="cat">${esc(CATEGORY_LABEL[lang][cat] ?? cat)}<span class="n">${rows.length}</span></div>`;
    html += `<table class="table"><thead><tr><th>${esc(tr.thName)}</th><th>${esc(tr.thArea)}</th><th>${esc(
      tr.thCity
    )}</th><th>${esc(tr.thDays)}</th><th>${esc(tr.thPhone)}</th></tr></thead><tbody>`;
    for (const loc of rows) {
      const badge = residencyLabel(loc.residency_cities, loc.residency_zips, lang);
      const days = openDays(loc).map((d) => dayShortLabel(loc, d)).join(", ") || "—";
      html += `<tr data-id="${loc.id}">
        <td class="name-cell"><span class="name">${esc(loc.title)}</span>${
        badge ? `<span class="badge">${esc(badge)}</span>` : ""
      }<div class="sub">${esc(loc.address)}</div></td>
        <td data-h="${esc(tr.thArea)}" class="muted">${esc(regionLabel(loc))}</td>
        <td data-h="${esc(tr.thCity)}">${esc(loc.city)}</td>
        <td data-h="${esc(tr.thDays)}">${esc(days)}</td>
        <td data-h="${esc(tr.thPhone)}" class="muted">${loc.phone ? esc(loc.phone) : "—"}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  results.innerHTML = html;
}

// ---- detail modal ----------------------------------------------------------
function openDetail(loc: Loc) {
  const tr = t();
  const scrim = document.getElementById("scrim")!;
  const sheet = document.getElementById("sheet")!;
  scrim.hidden = false;
  const residency = residencyLabel(loc.residency_cities, loc.residency_zips, lang);
  const provenance = provenanceLabel(loc.eligibility_source, lang);
  const note = lang === "es" ? loc.eligibility_note_es || loc.eligibility_note : loc.eligibility_note;
  const supplemental = loc.supplemental ? (lang === "es" ? loc.supplemental.es : loc.supplemental.en) : null;
  const maps = `https://maps.google.com/?q=${encodeURIComponent(`${loc.address}, ${loc.city}, OH ${loc.zip}`)}`;
  const hours = DAYS.map((d) => {
    const h = hoursOf(loc, d);
    return `<li><span class="day">${DAY_LABEL[lang][d]}</span><span class="${h ? "" : "closed"}">${
      h ? esc(h) : esc(tr.closed)
    }</span></li>`;
  }).join("");
  sheet.innerHTML = `
    <div class="sheet-head">
      <h2>${esc(loc.title)}</h2>
      <button class="close" id="sheet-close" aria-label="Close">×</button>
    </div>
    <div class="chips">
      <span class="chip">${esc(CATEGORY_LABEL[lang][loc.category] ?? loc.category)}${
    loc.category_source === "overlay" ? ` <span class="chip-flag" title="${esc(tr.categoryInferred)}">*</span>` : ""
  }</span>
      ${loc.region ? `<span class="chip">${esc(regionLabel(loc))}</span>` : ""}
    </div>
    ${
      loc.category_source === "overlay"
        ? `<p class="inferred-note">${esc(tr.categoryInferred)}</p>`
        : ""
    }
    <div class="addr"><a href="${maps}" target="_blank" rel="noopener">${esc(loc.address)}, ${esc(
    loc.city
  )}, OH ${esc(loc.zip)} ↗</a>${loc.phone ? ` · <a href="tel:${esc(loc.phone)}">${esc(loc.phone)}</a>` : ""}</div>
    ${
      residency || note
        ? `<div class="callout"><h3>${esc(tr.eligibility)}</h3>${
            residency ? `<p><strong>${esc(residency)}</strong></p>` : ""
          }${note ? `<p>${esc(note)}</p>` : ""}${
            provenance ? `<p style="font-size:0.72rem;opacity:0.65;font-style:italic;margin-top:6px">${esc(provenance)}</p>` : ""
          }</div>`
        : ""
    }
    <ul class="hours">${hours}</ul>
    ${
      supplemental
        ? `<div class="supp"><h3>${esc(tr.otherServices)}</h3><p>${esc(supplemental)}</p></div>`
        : ""
    }
    ${loc.notes ? `<div class="notes">${esc(loc.notes)}</div>` : ""}
  `;
  document.getElementById("sheet-close")!.addEventListener("click", closeDetail);
}
function closeDetail() {
  const scrim = document.getElementById("scrim");
  if (scrim) scrim.hidden = true;
}

// ---- PDF export modal ------------------------------------------------------
function openPdfModal() {
  const s = document.getElementById("pdf-scrim");
  if (s) s.hidden = false;
}
function closePdfModal() {
  const s = document.getElementById("pdf-scrim");
  if (s) s.hidden = true;
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDetail();
    closePdfModal();
  }
});

function bindResults() {
  results.addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest("tr[data-id]");
    if (!tr) return;
    const loc = RECORDS.find((r) => r.id === Number(tr.getAttribute("data-id")));
    if (loc) openDetail(loc);
  });
}

// ---- filter wiring ---------------------------------------------------------
function bindFilters() {
  const bind = (id: string, key: keyof typeof state, ev = "change") =>
    document.getElementById(id)!.addEventListener(ev, (e) => {
      state[key] = (e.target as HTMLInputElement | HTMLSelectElement).value;
      render();
    });
  bind("f-q", "q", "input");
  bind("f-category", "category");
  bind("f-region", "region");
  bind("f-day", "day");
  bind("f-city", "city");
  bind("f-reside", "reside");
  bind("f-resideZip", "resideZip", "input");
}

// ---- PDF export ------------------------------------------------------------
// Date + time stamp for download names, matching the other sub-apps
// (chair-pile, sleep-noise): YYYYMMDD-HHMM, so repeated exports never collide.
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// All four versions (2 formats × 2 languages) are offered regardless of the
// app's current language, so a bilingual helper can hand out either one.
async function exportPdf(kind: "full" | "booklet", pdfLang: Lang, btn: HTMLButtonElement) {
  const tr = t();
  const orig = btn.textContent;
  const buttons = document.querySelectorAll<HTMLButtonElement>(".pdf-lang");
  buttons.forEach((b) => (b.disabled = true));
  btn.textContent = tr.building;
  try {
    const meta = { scrapedAt: META.scrapedAt };
    const bytes =
      kind === "full"
        ? await (await import("./lib/pdf/full-pager")).buildFullPagerPdf(RECORDS, meta, pdfLang)
        : await (await import("./lib/pdf/booklet")).buildBookletPdf(RECORDS, meta, pdfLang);
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = fileStamp();
    a.download =
      kind === "full"
        ? `cleveland-food-resources-${pdfLang}-${stamp}.pdf`
        : `cleveland-food-resources-booklet-${pdfLang}-${stamp}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closePdfModal();
  } catch (err) {
    console.error(err);
    alert(tr.pdfError);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    btn.textContent = orig;
  }
}

function bindExports() {
  document.getElementById("open-pdf")!.addEventListener("click", openPdfModal);
  document.getElementById("pdf-close")!.addEventListener("click", closePdfModal);
  const pdfScrim = document.getElementById("pdf-scrim")!;
  pdfScrim.addEventListener("click", (e) => {
    if (e.target === pdfScrim) closePdfModal();
  });
  app.querySelectorAll<HTMLButtonElement>(".pdf-lang").forEach((b) =>
    b.addEventListener("click", () =>
      exportPdf(b.dataset.kind as "full" | "booklet", b.dataset.lang as Lang, b)
    )
  );
}

// ---- favicon: swap the tab icon through fruit & veggie emoji every 5s ------
// (A sliding transition looked great in isolation, but browsers throttle
// favicon repaints too hard for it to animate smoothly — so we just cut.)
const FAVICON_EMOJI = ["🍎", "🥕", "🍅", "🥦", "🍇", "🍐", "🌽", "🫑", "🍊", "🥬", "🍆", "🍓"];
const emojiFaviconHref = (emoji: string) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="17" font-size="28" text-anchor="middle" dominant-baseline="central">${emoji}</text></svg>`
  );
function startFaviconRotation() {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  const el = link;
  let i = Math.floor(Math.random() * FAVICON_EMOJI.length); // fresh start each visit
  const tick = () => {
    el.href = emojiFaviconHref(FAVICON_EMOJI[i]);
    i = (i + 1) % FAVICON_EMOJI.length;
  };
  tick();
  setInterval(tick, 5000);
}

// ---- boot ------------------------------------------------------------------
document.documentElement.lang = lang;
applyTheme();
startFaviconRotation();
mount();
