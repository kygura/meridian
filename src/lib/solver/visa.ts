// Day counting for the solver (ADR 0015): Schengen 90/180, per-country rules the owner
// enters, and tax-year days. Pure. Days are whole UTC day numbers (days since 1970-01-01).
//
// Counting rule (the Schengen Borders Code, Regulation (EU) 2016/399, Art. 6): every
// calendar day the traveller is inside the area counts, the entry and exit days
// included. A stay from move-in day s to move-out day e therefore occupies days s..e
// inclusive; two consecutive Schengen stays share the moving day and it counts once.

import { SCHENGEN, addRange, dayIso, dayNum, daysWithin, nightsByYear, peakUse, usedOn, type Ranges } from "../visa";

// Day counting and the Schengen list come from the visa module (ADR 0012), so the solver and
// every other surface count the same way from the same curated file.
export { addRange, dayIso, dayNum, daysWithin, nightsByYear, peakUse, usedOn };
export type { Ranges };

export const SCHENGEN_RULE = { days: SCHENGEN.days, windowDays: SCHENGEN.windowDays } as const;

/** Schengen Area members in the city dataset's spelling, from data/visa-curated.json. */
export const SCHENGEN_COUNTRIES: ReadonlySet<string> = new Set(SCHENGEN.memberNames);

export const SCHENGEN_SOURCE = `Schengen Borders Code (EU) 2016/399, Art. 6: ${SCHENGEN.days} days in any ${SCHENGEN.windowDays}; members per the European Commission (checked ${SCHENGEN.checked})`;

/**
 * Other spellings of one country (the city dataset mixes them, and rules are typed by hand),
 * mapped to one key. Keys are lower-case without accents.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  burma: "myanmar",
  "czech republic": "czechia",
  turkiye: "turkey",
  "korea, south": "south korea",
  "republic of korea": "south korea",
  korea: "south korea",
  "korea, north": "north korea",
  macedonia: "north macedonia",
  swaziland: "eswatini",
  "cote d'ivoire": "ivory coast",
  "congo (kinshasa)": "democratic republic of the congo",
  "dr congo": "democratic republic of the congo",
  "congo (brazzaville)": "republic of the congo",
  usa: "united states",
  us: "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  "great britain": "united kingdom",
  "viet nam": "vietnam",
  "lao pdr": "laos",
  "east timor": "timor-leste",
  holland: "netherlands",
  "the netherlands": "netherlands",
};

/** One key per country, whatever the spelling, case or accents ("Burma" and "myanmar" match). */
export function countryKey(name: string | undefined): string {
  const k = (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return COUNTRY_ALIASES[k] ?? k;
}

/** Do two country names mean the same country? Empty names match nothing. */
export function sameCountry(a: string | undefined, b: string | undefined): boolean {
  const ka = countryKey(a);
  return ka !== "" && ka === countryKey(b);
}

const SCHENGEN_KEYS = new Set([...SCHENGEN_COUNTRIES].map(countryKey));

export function inSchengen(country: string | undefined): boolean {
  return !!country && SCHENGEN_KEYS.has(countryKey(country));
}

export const TAX_NOTE =
  "Tax days count nights in a country per calendar year against the common 183-day test. Your own countries' rules may differ; check them.";
