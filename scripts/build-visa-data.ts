// Builds data/visa-requirements.json: entry requirements per passport and destination, and
// each destination's passport-validity rule, for the visa and day-counting module (ADR 0012).
//
//   npm run build:visa        (downloads are cached in data/cache/visa; delete it to refetch)
//
// What is fetched:
//   requirements   Passport Index Data (github.com/imorte/passport-index-data, MIT), scraped by
//                  its maintainer from passportindex.org: for 199 passports and 199
//                  destinations, visa free (with days where known), visa on arrival, ETA, e-visa,
//                  visa required or no admission. Pinned to one commit, recorded in the file.
//   country names  The same dataset's full-name file, row for row, gives each ISO-2 code a name.
//   passport       UK Foreign, Commonwealth & Development Office travel advice (GOV.UK content
//   validity       API, Open Government Licence v3.0), "Passport validity requirements" of every
//                  destination. The sentence is kept word for word with its link and the page's
//                  last update; a rule ("6 months after you arrive") is read from it only when the
//                  wording is unambiguous, otherwise only the quote is kept. FCDO writes for
//                  British passports; passport-validity rules are the destination's and usually
//                  the same for every passport, which the app says.
//
// Nothing is filled in: a destination the sources do not cover is absent, and the app shows
// "no data". The hand-curated rules the dataset lacks (Schengen, rolling windows, digital-nomad
// visas, yellow fever, tax days) are in data/visa-curated.json, written by hand with a source and
// a checked date on every row.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// A generic client name: no project or owner details go to the data providers.
const UA = process.env.DATA_UA ?? "open-data-build-script/1.0";
const ROOT = process.cwd();
const CACHE = join(ROOT, "data/cache/visa");
mkdirSync(CACHE, { recursive: true });

/** Commit of imorte/passport-index-data to read (README: "Last updated: 17 February 2026"). */
const PI_REF = process.env.PASSPORT_INDEX_REF ?? "9c59780dd0dbaefcbdfa0134d21cd99d0d547509";
const PI_BASE = `https://raw.githubusercontent.com/imorte/passport-index-data/${PI_REF}`;
const PI_UPDATED = process.env.PASSPORT_INDEX_UPDATED ?? "2026-02-17";
const FCDO_INDEX = "https://www.gov.uk/api/content/foreign-travel-advice";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, kind: "json" | "text" = "json", tries = 5): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.ok) return kind === "json" ? res.json() : res.text();
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (i + 1));
        continue;
      }
      throw new Error(`${res.status} ${url}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`gave up on ${url}`);
}

async function cached<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const p = join(CACHE, name);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as T;
  const v = await fn();
  writeFileSync(p, JSON.stringify(v));
  return v;
}

// ── Passport Index ───────────────────────────────────────────────────

type PiCell = { status: string; days?: number };

/** One compact token per cell: vf90, vf, voa30, voa, eta90, eta, ev30, ev, vr, na. */
export function token(c: PiCell | undefined): string | null {
  if (!c) return null;
  const d = typeof c.days === "number" && c.days > 0 ? String(c.days) : "";
  switch (c.status) {
    case "visa free":
      return `vf${d}`;
    case "visa on arrival":
      return `voa${d}`;
    case "eta":
      return `eta${d}`;
    case "e-visa":
      return `ev${d}`;
    case "visa required":
      return "vr";
    case "no admission":
      return "na";
    default:
      return null;
  }
}

async function passportIndex() {
  const json = (await cached("passport-index.json", () => get(`${PI_BASE}/passport-index.json`))) as Record<string, Record<string, PiCell>>;
  const tidyIso = (await cached("tidy-iso2.json", () => get(`${PI_BASE}/passport-index-tidy-iso2.csv`, "text"))) as string;
  const tidyNames = (await cached("tidy-names.json", () => get(`${PI_BASE}/passport-index-tidy.csv`, "text"))) as string;
  // The two tidy files list the same rows in the same order: pair them to name each code.
  const a = tidyIso.trim().split("\n").slice(1);
  const b = tidyNames.trim().split("\n").slice(1);
  if (a.length !== b.length) throw new Error("tidy files differ in length; cannot pair names with codes");
  const names = new Map<string, string>();
  const split = (line: string) => line.match(/("[^"]*"|[^,]+)/g)!.map((s) => s.replace(/^"|"$/g, ""));
  for (let i = 0; i < a.length; i++) {
    const [p2, d2] = split(a[i]);
    const [pn, dn] = split(b[i]);
    names.set(p2, pn);
    names.set(d2, dn);
  }
  return { json, names };
}

// ── FCDO passport validity ───────────────────────────────────────────

const textOf = (html: string) =>
  html
    .replace(/<\/(p|h2|h3|li)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, six: 6 };

/**
 * A validity rule read from FCDO's wording, or null when the wording is not one of the plain
 * forms: so many months or days beyond arrival or beyond departure; 0 = valid for the whole
 * stay. Anything else (a visa's expiry, a visa application date) is left as a quote.
 */
export function readValidity(text: string): { amount: number; unit: "months" | "days"; from: "arrival" | "departure" } | null {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  const m = t.match(/(?:at least|more than) (\d+|one|two|three|four|six) (months?|days) (?:after|from|beyond)(?: the| your)? (?:date|day)(?: you| of)? (arrive|enter|entry|plan to leave|intend to leave|leave|depart)/);
  if (m) {
    const amount = /\d/.test(m[1]) ? Number(m[1]) : WORDS[m[1]];
    return { amount, unit: m[2].startsWith("month") ? "months" : "days", from: ["arrive", "enter", "entry"].includes(m[3]) ? "arrival" : "departure" };
  }
  if (/valid for the (?:whole|entire|full|proposed|planned) (?:duration |length |period )?of your (?:stay|visit)/.test(t) || /valid for the (?:duration|length) of your (?:planned |proposed )?(?:stay|visit)/.test(t)) {
    return { amount: 0, unit: "days", from: "departure" };
  }
  if (/'expiry date' after the day you plan to leave/.test(t)) return { amount: 0, unit: "days", from: "departure" };
  return null;
}

/** The "Passport validity requirements" paragraph(s) of an entry-requirements page. */
export function validitySection(body: string): string | null {
  const t = textOf(body);
  const i = t.search(/passport validity requirements/i);
  if (i < 0) return null;
  const rest = t.slice(i).split("\n").slice(1);
  const out: string[] = [];
  for (const line of rest) {
    if (/^(dual nationals|visa requirements|checking your passport|applying for|vaccine|vaccination|customs|travelling with children|if you|residence|visa|returning)/i.test(line) && out.length) break;
    if (/^check with your travel provider|^renew your passport|^you will be denied entry/i.test(line)) continue;
    out.push(line.trim());
    if (out.join(" ").length > 600) break;
  }
  const s = out.join(" ").trim();
  return s || null;
}

async function fcdo(): Promise<{ slug: string; name: string; updated: string; quote: string | null }[]> {
  const index = await cached("fcdo-index.json", () => get(FCDO_INDEX));
  const children = (index.links.children as { base_path: string; details?: { country?: { name: string; slug: string } } }[]).map((c) => ({ slug: c.details?.country?.slug ?? c.base_path.split("/").pop()!, name: c.details?.country?.name ?? "" }));
  const out: { slug: string; name: string; updated: string; quote: string | null }[] = [];
  let n = 0;
  for (const c of children) {
    const page = await cached(`fcdo-${c.slug}.json`, async () => {
      await sleep(150);
      return get(`${FCDO_INDEX}/${c.slug}`);
    });
    if (!page) continue;
    const part = (page.details?.parts ?? []).find((p: { slug: string }) => p.slug === "entry-requirements");
    out.push({ slug: c.slug, name: c.name || page.details?.country?.name || page.title, updated: String(page.public_updated_at ?? "").slice(0, 10), quote: part ? validitySection(part.body) : null });
    if (++n % 25 === 0) process.stdout.write(`\rFCDO ${n}/${children.length}`);
  }
  process.stdout.write("\n");
  return out;
}

// ── Names ────────────────────────────────────────────────────────────

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Spellings used by data/worldcities.csv and FCDO that differ from the dataset's names. Only
 * real alternative names of the same country: overseas territories (French Guiana, Réunion,
 * Aruba, Gibraltar…) have their own entry rules and are deliberately not mapped to the state
 * they belong to.
 */
const EXTRA_NAMES: Record<string, string[]> = {
  BA: ["Bosnia And Herzegovina"],
  MM: ["Burma", "Myanmar (Burma)"],
  CI: ["Côte D’Ivoire", "Côte d'Ivoire", "Cote d'Ivoire"],
  CG: ["Congo (Brazzaville)", "Republic of the Congo"],
  CD: ["Congo (Kinshasa)", "Democratic Republic of the Congo"],
  MK: ["Macedonia"],
  MO: ["Macau"],
  ST: ["Sao Tome And Principe", "São Tomé and Príncipe"],
  KR: ["Korea, South"],
  KP: ["Korea, North"],
  BS: ["Bahamas, The", "The Bahamas"],
  GM: ["Gambia, The", "The Gambia"],
  CV: ["Cabo Verde"],
  CZ: ["Czechia"],
  SZ: ["Eswatini"],
  TT: ["Trinidad And Tobago"],
  TL: ["East Timor"],
  TR: ["Türkiye", "Turkiye"],
  US: ["USA"],
  VA: ["Vatican City", "Holy See"],
  PS: ["The Occupied Palestinian Territories", "Palestinian Territories"],
  FM: ["Micronesia, Federated States of", "Federated States of Micronesia"],
  KN: ["St Kitts and Nevis"],
  LC: ["St Lucia"],
  VC: ["St Vincent and the Grenadines"],
};

async function main() {
  const { json, names } = await passportIndex();
  const codes = [...new Set([...Object.keys(json), ...Object.values(json).flatMap((r) => Object.keys(r))])].sort();
  const countries: Record<string, { name: string; aliases?: string[] }> = {};
  for (const c of codes) {
    const name = names.get(c);
    if (!name) {
      console.warn(`no name for ${c}; skipped`);
      continue;
    }
    countries[c] = { name, ...(EXTRA_NAMES[c] ? { aliases: EXTRA_NAMES[c] } : {}) };
  }
  const byName = new Map<string, string>();
  for (const [c, v] of Object.entries(countries)) for (const n of [v.name, ...(v.aliases ?? [])]) byName.set(fold(n), c);

  const destinations = Object.keys(countries);
  const matrix: Record<string, string> = {};
  for (const p of Object.keys(json).sort()) {
    if (!countries[p]) continue;
    matrix[p] = destinations.map((d) => (d === p ? "-" : token(json[p][d]) ?? "?")).join(" ");
  }

  const pages = await fcdo();
  const validity: Record<string, { quote: string; rule: ReturnType<typeof readValidity>; url: string; updated: string }> = {};
  const unmatched: string[] = [];
  let parsed = 0;
  for (const p of pages) {
    const code = byName.get(fold(p.name));
    if (!code) {
      unmatched.push(p.name);
      continue;
    }
    if (!p.quote) continue;
    const rule = readValidity(p.quote);
    if (rule) parsed++;
    validity[code] = { quote: p.quote, rule, url: `https://www.gov.uk/foreign-travel-advice/${p.slug}/entry-requirements`, updated: p.updated };
  }
  if (unmatched.length) console.warn(`FCDO pages with no dataset country (kept out): ${unmatched.join(", ")}`);

  const fetchedAt = new Date().toISOString().slice(0, 10);
  const out = {
    version: 1,
    builtAt: fetchedAt,
    sources: {
      requirements: {
        name: "Passport Index Data (imorte/passport-index-data), scraped from passportindex.org",
        url: "https://github.com/imorte/passport-index-data",
        commit: PI_REF,
        datasetUpdated: PI_UPDATED,
        fetchedAt,
        licence: "MIT",
        note: "Per passport and destination: visa free (days where known), visa on arrival, ETA, e-visa, visa required, no admission. The dataset does not say how days are counted (per entry or per window); data/visa-curated.json adds that where sourced.",
      },
      validity: {
        name: "UK FCDO foreign travel advice, entry requirements (GOV.UK content API)",
        url: FCDO_INDEX,
        fetchedAt,
        licence: "Open Government Licence v3.0",
        note: "Written for British passports. Passport-validity rules are set by the destination and usually apply to every passport.",
      },
    },
    tokens: "vfN visa free N days; vf visa free, days not given; voaN/voa visa on arrival; etaN/eta electronic travel authorisation; evN/ev e-visa; vr visa required; na no admission; - own country; ? not in the dataset",
    countries,
    destinations,
    matrix,
    validity,
  };
  writeFileSync(join(ROOT, "data/visa-requirements.json"), JSON.stringify(out));
  console.log(`passports ${Object.keys(matrix).length}, destinations ${destinations.length}, validity quotes ${Object.keys(validity).length} (rule read from ${parsed})`);
}

if (process.argv[1]?.endsWith("build-visa-data.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
