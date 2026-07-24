// Copy shared by both PDFs: the call-ahead notice, the byline, and the QR
// caption. Kept in one place so the two layouts never drift.

import { LIVE_URL_SHORT, type Lang } from "./model";

export const NOTICE: Record<Lang, string> = {
  en: "Hours and eligibility change — please call ahead before you go.",
  es: "Los horarios y requisitos cambian — por favor llame antes de ir.",
};

export const CREDIT: Record<Lang, string> = {
  en: "Information design & development · Jayce Renner",
  es: "Diseño y desarrollo de información · Jayce Renner",
};

export const CREDIT_URL = LIVE_URL_SHORT;

// Long caption for the booklet back cover, short one for the full-pager corner.
export const SCAN: Record<Lang, string> = {
  en: "Scan for the live, searchable directory",
  es: "Escanee para el directorio interactivo",
};
export const SCAN_SHORT: Record<Lang, string> = {
  en: "Live directory",
  es: "Directorio en vivo",
};
