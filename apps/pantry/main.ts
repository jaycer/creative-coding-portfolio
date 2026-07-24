import "./style.css";
import data from "./data.json";
import type { PantryRecord } from "./lib/pdf/model";
import { residencyLabel } from "./lib/eligibility-format";

// A record carries everything PantryRecord needs plus id/notes for the UI.
interface Loc extends PantryRecord {
  id: number;
  notes: string | null;
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
const DAY_LABEL: Record<Day, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};
const DAY_SHORT: Record<Day, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

const CATEGORY_ORDER = ["Pantry", "Mobile Pantry", "Hot Meals"];
const REGION_OPTS: { v: string; label: string }[] = [
  { v: "west", label: "West Side" },
  { v: "east", label: "East Side" },
  { v: "other", label: "Other areas" },
];

// Residence options: pantry cities plus any city that appears as a service
// restriction, so e.g. a Lakewood resident can pick "Lakewood" even if no
// pantry's own city is Lakewood.
const RESIDE_CITIES = [
  ...new Set([...PANTRY_CITIES, ...RECORDS.flatMap((r) => r.residency_cities ?? [])]),
].sort((a, b) => a.localeCompare(b));

const hoursOf = (loc: Loc, day: Day) => (loc[`${day}_hours`] as string | null) || null;
const openDays = (loc: Loc): Day[] => DAYS.filter((d) => hoursOf(loc, d));
const regionKey = (loc: Loc) => (loc.region === "west" || loc.region === "east" ? loc.region : "other");
const regionLabel = (loc: Loc) =>
  loc.region === "west" ? "West Side" : loc.region === "east" ? "East Side" : "—";

const state = { q: "", category: "", region: "", day: "", city: "", reside: "" };

function matches(loc: Loc): boolean {
  if (state.category && loc.category !== state.category) return false;
  if (state.region && regionKey(loc) !== state.region) return false;
  if (state.day && !hoursOf(loc, state.day as Day)) return false;
  if (state.city && loc.city !== state.city) return false;
  if (state.reside && loc.residency_cities && !loc.residency_cities.includes(state.reside)) return false;
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

// ---- shell -----------------------------------------------------------------
const app = document.getElementById("app")!;
app.innerHTML = `
  <header class="bar">
    <a class="back" href="../../">← Gallery</a>
    <h1>Food Access Directory for Greater Cleveland</h1>
    <span class="count" id="count"></span>
  </header>
  <div class="wrap">
    <p class="intro">${esc(data.count + "")} free food sources — pantries, hot meals, and mobile pantries — cleansed from ${esc(
      data.source
    )} data. Hours change; call ahead.</p>
    <div class="controls">
      <div class="row">
        <div class="field"><label>Search</label><input id="f-q" type="search" placeholder="name, city, address" /></div>
        <div class="field"><label>Category</label><select id="f-category"><option value="">All</option>${CATEGORY_ORDER.map(
          (c) => option(c, c, "")
        ).join("")}</select></div>
        <div class="field"><label>Area</label><select id="f-region"><option value="">All</option>${REGION_OPTS.map(
          (r) => option(r.v, r.label, "")
        ).join("")}</select></div>
        <div class="field"><label>Day open</label><select id="f-day"><option value="">Any</option>${DAYS.map(
          (d) => option(d, DAY_LABEL[d], "")
        ).join("")}</select></div>
        <div class="field"><label>City</label><select id="f-city"><option value="">All</option>${PANTRY_CITIES.map(
          (c) => option(c, c, "")
        ).join("")}</select></div>
        <div class="field"><label>You live in</label><select id="f-reside"><option value="">Anywhere</option>${RESIDE_CITIES.map(
          (c) => option(c, c, "")
        ).join("")}</select></div>
      </div>
      <div class="row">
        <div class="exports">
          <button class="btn" id="pdf-full">↓ Full-pager PDF</button>
          <button class="btn secondary" id="pdf-booklet">↓ Booklet PDF</button>
          <span class="muted" style="font-size:0.78rem">all ${esc(RECORDS.length + "")} locations · print &amp; fold the booklet</span>
        </div>
      </div>
    </div>
    <div id="results"></div>
  </div>
  <div class="scrim" id="scrim" hidden><div class="sheet" id="sheet" role="dialog" aria-modal="true"></div></div>
`;

const results = document.getElementById("results")!;
const countEl = document.getElementById("count")!;

function render() {
  const shown = RECORDS.filter(matches);
  countEl.textContent = `${shown.length} of ${RECORDS.length}`;

  if (!shown.length) {
    results.innerHTML = `<p class="empty">No locations match these filters. Try clearing one.</p>`;
    return;
  }

  let html = "";
  for (const cat of CATEGORY_ORDER) {
    const rows = shown.filter((r) => r.category === cat).sort((a, b) => a.title.localeCompare(b.title));
    if (!rows.length) continue;
    html += `<div class="cat">${esc(cat)}<span class="n">${rows.length}</span></div>`;
    html += `<table class="table"><thead><tr><th>Name</th><th>Area</th><th>City</th><th>Days open</th><th>Phone</th></tr></thead><tbody>`;
    for (const loc of rows) {
      const badge = residencyLabel(loc.residency_cities);
      const days = openDays(loc).map((d) => DAY_SHORT[d]).join(", ") || "—";
      html += `<tr data-id="${loc.id}">
        <td class="name-cell"><span class="name">${esc(loc.title)}</span>${
        badge ? `<span class="badge">${esc(badge)}</span>` : ""
      }<div class="sub">${esc(loc.address)}</div></td>
        <td data-h="Area" class="muted">${esc(regionLabel(loc))}</td>
        <td data-h="City">${esc(loc.city)}</td>
        <td data-h="Days">${esc(days)}</td>
        <td data-h="Phone" class="muted">${loc.phone ? esc(loc.phone) : "—"}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  results.innerHTML = html;
}

// ---- detail modal ----------------------------------------------------------
const scrim = document.getElementById("scrim")!;
const sheet = document.getElementById("sheet")!;

function openDetail(loc: Loc) {
  const residency = residencyLabel(loc.residency_cities);
  const maps = `https://maps.google.com/?q=${encodeURIComponent(`${loc.address}, ${loc.city}, OH ${loc.zip}`)}`;
  const hours = DAYS.map((d) => {
    const h = hoursOf(loc, d);
    return `<li><span class="day">${DAY_LABEL[d]}</span><span class="${h ? "" : "closed"}">${
      h ? esc(h) : "Closed"
    }</span></li>`;
  }).join("");
  sheet.innerHTML = `
    <div class="sheet-head">
      <h2>${esc(loc.title)}</h2>
      <button class="close" id="sheet-close" aria-label="Close">×</button>
    </div>
    <div class="chips">
      <span class="chip">${esc(loc.category)}</span>
      ${loc.region ? `<span class="chip">${esc(regionLabel(loc))}</span>` : ""}
    </div>
    <div class="addr"><a href="${maps}" target="_blank" rel="noopener">${esc(loc.address)}, ${esc(
    loc.city
  )}, OH ${esc(loc.zip)} ↗</a>${loc.phone ? ` · <a href="tel:${esc(loc.phone)}">${esc(loc.phone)}</a>` : ""}</div>
    ${
      residency || loc.eligibility_note
        ? `<div class="callout"><h3>Eligibility</h3>${
            residency ? `<p><strong>${esc(residency)}</strong></p>` : ""
          }${loc.eligibility_note ? `<p>${esc(loc.eligibility_note)}</p>` : ""}</div>`
        : ""
    }
    <ul class="hours">${hours}</ul>
    ${loc.notes ? `<div class="notes">${esc(loc.notes)}</div>` : ""}
  `;
  scrim.hidden = false;
  document.getElementById("sheet-close")!.addEventListener("click", closeDetail);
}
function closeDetail() {
  scrim.hidden = true;
}
scrim.addEventListener("click", (e) => {
  if (e.target === scrim) closeDetail();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});
results.addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-id]");
  if (!tr) return;
  const loc = RECORDS.find((r) => r.id === Number(tr.getAttribute("data-id")));
  if (loc) openDetail(loc);
});

// ---- filter wiring ---------------------------------------------------------
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

// ---- PDF export ------------------------------------------------------------
async function exportPdf(kind: "full" | "booklet", btn: HTMLButtonElement) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Building…";
  try {
    const bytes =
      kind === "full"
        ? await (await import("./lib/pdf/full-pager")).buildFullPagerPdf(RECORDS)
        : await (await import("./lib/pdf/booklet")).buildBookletPdf(RECORDS);
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      kind === "full" ? "cleveland-food-resources.pdf" : "cleveland-food-resources-booklet.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert("Sorry — the PDF couldn't be generated.");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}
document
  .getElementById("pdf-full")!
  .addEventListener("click", (e) => exportPdf("full", e.currentTarget as HTMLButtonElement));
document
  .getElementById("pdf-booklet")!
  .addEventListener("click", (e) => exportPdf("booklet", e.currentTarget as HTMLButtonElement));

render();
