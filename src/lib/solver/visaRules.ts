// The solver's visa constraints from the visa module (ADR 0012, ADR 0015). Pure.
//
// With the owner's passports known, Schengen 90/180 follows them (off with free movement), and
// every other country in the pool gets the limit the data gives those passports, as a country
// rule with origin "visa". The owner's own rules stay: for their country they replace the data.
// Without passports the owner's settings are used as they were, and the proposals say so.

import { SCHENGEN, countryName, isoOf, type VisaData } from "../visa/data";
import { ARRIVE_OK, STATUS_LABEL, entryRule, limitLabel } from "../visa/rules";
import { sameCountry } from "./visa";
import type { Constraints, CountryRule, VisaCheckInfo } from "./types";

export const NO_PASSPORT_NOTE =
  "No passport set in Settings › Visas: Schengen 90/180 follows your Rules setting, and only the country limits you entered were checked.";

export interface VisaConstraints {
  constraints: Constraints;
  /** Countries (as named in the pool) the passports may not enter, with why. */
  excluded: Map<string, string>;
  notes: string[];
}

export function visaConstraints(data: VisaData | null, passports: string[], countries: string[], onDate: string, base: Constraints): VisaConstraints {
  const own = base.countryRules.filter((r) => r.origin !== "visa").map((r) => ({ ...r, origin: "owner" as const }));
  if (!data || !passports.length) return { constraints: { ...base, countryRules: own, visa: null }, excluded: new Map(), notes: [NO_PASSPORT_NOTE] };
  const free = passports.find((p) => SCHENGEN.freeMovement.includes(p));
  const names = [...new Set(countries.filter(Boolean))].sort();
  const rules: CountryRule[] = [...own];
  const excluded = new Map<string, string>();
  const info: VisaCheckInfo = { passports, checked: [], arriveOk: [], visaFirst: [] };
  const applied: string[] = [];
  const unknown: string[] = [];
  const overridden: string[] = [];
  const notes: string[] = [];
  for (const name of names) {
    const code = isoOf(data, name);
    if (!code) {
      unknown.push(name);
      continue;
    }
    const rule = entryRule(data, passports, code, onDate);
    if (ARRIVE_OK.has(rule.status)) info.arriveOk.push(name);
    if (rule.status === "unknown") unknown.push(name);
    if (rule.status === "no-admission") excluded.set(name, `${name}: the dataset says it does not admit ${countryName(data, rule.passport ?? "")} passport holders.`);
    if (rule.status === "visa-required" || rule.status === "e-visa") info.visaFirst.push({ country: name, note: `${STATUS_LABEL[rule.status]} for your ${rule.passport} passport (Passport Index data); the plan assumes you get it.` });
    if (rule.pool === SCHENGEN.id || !rule.limit) continue;
    if (own.some((r) => sameCountry(r.country, name))) {
      overridden.push(name);
      continue;
    }
    if (rule.limit.kind === "calendar-year") {
      notes.push(`${name}: ${limitLabel(rule.limit)} is not counted by the solver; check it on Plan › Days.`);
      continue;
    }
    const note = `${limitLabel(rule.limit)} for your ${rule.passport} passport: ${rule.sources[0]?.title ?? "visa data"}`;
    rules.push(rule.limit.kind === "per-entry" ? { country: name, maxDaysPerEntry: rule.limit.days, note, origin: "visa" } : { country: name, maxDaysIn: { days: rule.limit.days, windowDays: rule.limit.windowDays }, note, origin: "visa" });
    applied.push(`${name} (${limitLabel(rule.limit)})`);
  }
  const src = data.sources.requirements;
  const label = passports.map((p) => countryName(data, p)).join(" and ");
  info.checked.push(`Checked for your ${label} passport${passports.length > 1 ? "s" : ""}: entry rules from ${src?.name ?? "Passport Index Data"} (dataset of ${src?.datasetUpdated ?? src?.fetchedAt ?? "unknown date"}) and Meridian's curated rules, each with its own source and checked date.`);
  info.checked.push(free ? `Schengen 90/180 not applied: your ${countryName(data, free)} passport has free movement there.` : `Schengen 90/180 counted across the ${SCHENGEN.members.length} member countries, with your rotation and journal's past days.`);
  if (applied.length) info.checked.push(`Day limits applied as hard rules: ${applied.join(", ")}.`);
  if (overridden.length) info.checked.push(`Your own rules replace the data for ${overridden.join(", ")}.`);
  if (info.visaFirst.length) info.checked.push(`A visa or e-visa is needed before you go for ${info.visaFirst.map((v) => v.country).join(", ")}; stays there are allowed and say so.`);
  if (excluded.size) info.checked.push(`Left out, no entry for your passport: ${[...excluded.keys()].join(", ")}.`);
  if (unknown.length) info.checked.push(`No entry data for ${unknown.join(", ")}: no limit applied there.`);
  info.checked.push("Not checked: visas you already hold, the purpose of your stay (work, study), or rule changes after those dates. Not legal advice.");
  return { constraints: { ...base, schengen: !free, countryRules: rules, visa: info }, excluded, notes };
}
