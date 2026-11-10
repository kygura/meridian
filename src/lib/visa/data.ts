// The visa module's data (ADR 0012): the built requirements file, passed in by whoever has
// it (the server reads data/visa-requirements.json; the browser gets the rows for the owner's
// passports from /api/visa), and the hand-curated rules, which are small and imported here so
// the solver, the server and the browser read the same Schengen list and windows.

import curatedJson from "../../../data/visa-curated.json";

export interface SourceRef {
  title: string;
  url: string;
}

export interface Zone {
  id: string;
  name: string;
  members: string[];
  /** The same members in the city dataset's spelling, for code that holds names. */
  memberNames: string[];
  days: number;
  windowDays: number;
  counting: string;
  freeMovement: string[];
  freeMovementNote: string;
  outside: Record<string, string>;
  sources: SourceRef[];
  checked: string;
}

export interface Regime {
  id: string;
  destination: string;
  kind: "per-entry" | "rolling" | "calendar-year";
  days?: number;
  windowDays?: number;
  appliesTo: "visa-free" | "visa-on-arrival" | "visa-free-or-eta";
  onlyWhenDatasetDaysAtMost?: number;
  validFrom?: string;
  validUntil?: string;
  landEntriesPerYear?: number;
  extension?: { days: number; times: number; note: string };
  note: string;
  source: SourceRef;
  checked: string;
}

export interface NomadVisa {
  country: string;
  name: string;
  duration: string;
  income: string;
  incomeMonthly?: { amount: number; currency: string; year: number } | null;
  note?: string;
  url: string;
  source: string;
  checked: string;
}

export interface YellowFeverRow {
  c: string | null;
  name?: string;
  /** WHO: risk of transmission in the country (yes), in parts of it (part), or none (no). */
  risk: "yes" | "part" | "no";
  /** Certificate asked of travellers arriving from risk countries, or of all travellers. */
  from: "risk" | "all" | null;
  age?: string;
  note?: string;
}

export interface TaxPeriod {
  kind: "calendar-year" | "tax-year" | "rolling";
  startMonth?: number;
  startDay?: number;
  months?: number;
}

export interface TaxRule {
  country: string;
  threshold: number;
  /** True: "183 or more"; false: "more than 183". */
  atLeast: boolean;
  period: TaxPeriod;
  note: string;
  url: string;
  source: string;
  checked: string;
}

export interface Curated {
  version: number;
  about: string;
  zones: Zone[];
  regimes: Regime[];
  nomadVisas: NomadVisa[];
  yellowFever: { source: SourceRef; checked: string; note: string; rows: YellowFeverRow[] };
  taxRules: TaxRule[];
  taxDefault: { threshold: number; atLeast: boolean; period: TaxPeriod; note: string };
  borderRunNotes: { destination: string; note: string; source: SourceRef; checked: string }[];
}

export const CURATED = curatedJson as unknown as Curated;
export const SCHENGEN: Zone = CURATED.zones.find((z) => z.id === "schengen")!;

export interface ValidityRow {
  quote: string;
  rule: { amount: number; unit: "months" | "days"; from: "arrival" | "departure" } | null;
  url: string;
  updated: string;
}

/** data/visa-requirements.json, or the slice of it the browser was given. */
export interface VisaData {
  version: number;
  builtAt: string;
  sources: Record<string, { name: string; url: string; fetchedAt: string; licence: string; note?: string; commit?: string; datasetUpdated?: string }>;
  countries: Record<string, { name: string; aliases?: string[] }>;
  destinations: string[];
  /** Per passport, one token per destination, space-separated, in `destinations` order. */
  matrix: Record<string, string>;
  validity: Record<string, ValidityRow>;
}

/** The disclaimer every surface shows next to these checks. */
export const VISA_DISCLAIMER =
  "Entry rules change, sometimes with little notice. These checks read open datasets and official pages on the dates shown; they are not legal or tax advice. Check the linked official source before you travel.";

// ── Country names ────────────────────────────────────────────────────

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Spellings the solver's owner-typed rules and the city dataset use beyond the data file's. */
const NAME_ALIASES: Record<string, string> = {
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  usa: "US",
  us: "US",
  "united states of america": "US",
  czechia: "CZ",
  "czech republic": "CZ",
  turkiye: "TR",
  "viet nam": "VN",
  "lao pdr": "LA",
  holland: "NL",
  "the netherlands": "NL",
  "korea, south": "KR",
  "south korea": "KR",
  "republic of korea": "KR",
  korea: "KR",
  "korea, north": "KP",
  burma: "MM",
  macedonia: "MK",
  swaziland: "SZ",
  "east timor": "TL",
  "cabo verde": "CV",
  "cape verde": "CV",
  "cote d'ivoire": "CI",
  "ivory coast": "CI",
  "congo (kinshasa)": "CD",
  "dr congo": "CD",
  "congo (brazzaville)": "CG",
};

const indexCache = new WeakMap<object, Map<string, string>>();

function nameIndex(data: Pick<VisaData, "countries"> | null): Map<string, string> {
  const key = (data?.countries ?? NAME_ALIASES) as object;
  const hit = indexCache.get(key);
  if (hit) return hit;
  const m = new Map<string, string>(Object.entries(NAME_ALIASES));
  for (const [code, v] of Object.entries(data?.countries ?? {})) {
    m.set(code.toLowerCase(), code);
    for (const n of [v.name, ...(v.aliases ?? [])]) m.set(fold(n), code);
  }
  indexCache.set(key, m);
  return m;
}

/** ISO-2 code for a country name or code in any spelling the app uses, or null. */
export function isoOf(data: Pick<VisaData, "countries"> | null, nameOrCode: string | undefined | null): string | null {
  if (!nameOrCode) return null;
  const s = nameOrCode.trim();
  if (/^[A-Z]{2}$/.test(s) && (!data || data.countries[s])) return s;
  return nameIndex(data).get(fold(s)) ?? null;
}

/** Display name of a code: the data file's, else the code. */
export function countryName(data: Pick<VisaData, "countries"> | null, code: string): string {
  return data?.countries[code]?.name ?? code;
}

export function inSchengenIso(code: string | null | undefined): boolean {
  return !!code && SCHENGEN.members.includes(code);
}

// ── Cells ─────────────────────────────────────────────────────────────

export type EntryStatus = "home" | "free-movement" | "visa-free" | "visa-on-arrival" | "eta" | "e-visa" | "visa-required" | "no-admission" | "unknown";

export interface Cell {
  status: EntryStatus;
  /** Days the dataset gives, when it gives any. */
  days: number | null;
}

const decoded = new WeakMap<object, Map<string, string[]>>();

/** The dataset's cell for one passport and destination. */
export function cellOf(data: VisaData, passport: string, destination: string): Cell {
  if (passport === destination) return { status: "home", days: null };
  let byP = decoded.get(data.matrix);
  if (!byP) {
    byP = new Map();
    decoded.set(data.matrix, byP);
  }
  let row = byP.get(passport);
  if (!row) {
    const raw = data.matrix[passport];
    if (!raw) return { status: "unknown", days: null };
    row = raw.split(" ");
    byP.set(passport, row);
  }
  const i = data.destinations.indexOf(destination);
  if (i < 0) return { status: "unknown", days: null };
  return parseToken(row[i] ?? "?");
}

export function parseToken(t: string): Cell {
  if (t === "-") return { status: "home", days: null };
  if (t === "vr") return { status: "visa-required", days: null };
  if (t === "na") return { status: "no-admission", days: null };
  const m = t.match(/^(vf|voa|eta|ev)(\d*)$/);
  if (!m) return { status: "unknown", days: null };
  const status: EntryStatus = m[1] === "vf" ? "visa-free" : m[1] === "voa" ? "visa-on-arrival" : m[1] === "eta" ? "eta" : "e-visa";
  return { status, days: m[2] ? Number(m[2]) : null };
}

/** A copy of `data` holding only these passports' rows (what the browser is sent). */
export function sliceFor(data: VisaData, passports: string[]): VisaData {
  const matrix: Record<string, string> = {};
  for (const p of passports) if (data.matrix[p]) matrix[p] = data.matrix[p];
  return { ...data, matrix };
}
