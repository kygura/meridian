// Matches a Notion place label to Meridian cities. Never guesses: an exact (accent- and
// case-insensitive) name, narrowed by country when there is one, and only when no
// similarly sized city shares the name. Everything else goes to the review list with
// suggestions, and the owner's answer is remembered as an alias.

import { getCities, searchCities } from "../cities.js";
import type { City } from "../../../src/types.js";
import { fold } from "./read.js";
import type { ReviewItem } from "./types.js";

const DOMINANCE = 3;

export type Match =
  | { ok: true; cities: City[]; via: "alias" | "name" }
  | { ok: false; ignored: true }
  | { ok: false; ignored?: false; reason: ReviewItem["reason"]; detail: string; suggestions: City[] };

const COMPOUND = /\s\/\s|\s&\s|\sand\s|\s[—–]\s|\(|\+/;

export const citySuggestion = (c: City) => ({ cityId: c.id, name: c.name, country: c.country });

function byName(name: string, country?: string): { hit?: City; ambiguous: boolean } {
  const f = fold(name);
  let pool = getCities().filter((c) => fold(c.name) === f);
  const cf = country ? fold(country) : "";
  if (cf) {
    const narrowed = pool.filter((c) => fold(c.country).includes(cf) || cf.includes(fold(c.country)));
    if (narrowed.length) pool = narrowed;
  }
  pool = [...pool].sort((a, b) => b.population - a.population);
  if (pool.length > 1 && pool[0].population < DOMINANCE * pool[1].population) return { ambiguous: true };
  return { hit: pool[0], ambiguous: false };
}

export function matchPlace(label: string, country: string | undefined, aliases: Record<string, string[]>): Match {
  const key = fold(label);
  const aliased = aliases[key];
  if (aliased) {
    if (!aliased.length) return { ok: false, ignored: true };
    const found = aliased.map((id) => getCities().find((c) => c.id === id)).filter((c): c is City => !!c);
    if (found.length) return { ok: true, cities: found, via: "alias" };
  }
  const suggest = (q: string) => searchCities(q).slice(0, 5);
  if (COMPOUND.test(label)) {
    // "Da Nang / Hoi An" names an area or several places; which one is the owner's call.
    const parts = label.split(/\s\/\s|\s&\s|\sand\s|\s[—–]\s|\(|\)|\+/).map((p) => p.trim()).filter(Boolean);
    const sugg = parts.flatMap((p) => suggest(p).slice(0, 2));
    return { ok: false, reason: "compound", detail: "This names more than one place or an area. Pick the city (or cities) it stands for.", suggestions: dedupe(sugg) };
  }
  const { hit, ambiguous } = byName(label, country);
  if (hit) return { ok: true, cities: [hit], via: "name" };
  if (ambiguous) return { ok: false, reason: "ambiguous", detail: "Several similar cities share this name. Pick one.", suggestions: suggest(label) };
  return { ok: false, reason: "no-match", detail: "No city with this name in Meridian's list.", suggestions: suggest(label) };
}

function dedupe(cs: City[]): City[] {
  const seen = new Set<string>();
  return cs.filter((c) => !seen.has(c.id) && seen.add(c.id)).slice(0, 6);
}
