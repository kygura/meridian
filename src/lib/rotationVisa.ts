// Visa checks for a Rotation (ADR 0011, ADR 0012): every committed Rotation Stay checked with
// the owner's other presence (the journal's past stops and dated trips), so Schengen and other
// windows count what really happened before. Ideas are options, not plans: they get their
// entry requirement but are left out of the counts, as rotationIssues leaves them out.

import { staySpan, type RotationStay } from "./rotation";
import { checkStays, type CheckResult, type StayInput, type StayVerdict } from "./visa/engine";
import { entryRule, type EntryRule } from "./visa/rules";
import { isoOf, type VisaData } from "./visa/data";

export interface RotationVisa {
  /** Per Rotation Stay id. */
  verdicts: Map<string, StayVerdict>;
  /** Ideas and stays without a country: the entry requirement only. */
  rules: Map<string, EntryRule>;
  check: CheckResult | null;
}

export const ROTATION_PREFIX = "r:";

export function rotationVisa(stays: RotationStay[], others: StayInput[], data: VisaData, passports: string[], opts: { today?: string; expiry?: Record<string, string | undefined> } = {}): RotationVisa {
  const mine: StayInput[] = [];
  const rules = new Map<string, EntryRule>();
  for (const s of stays) {
    const span = staySpan(s);
    if (!span || !s.place.country) continue;
    if (s.status === "idea") {
      const code = isoOf(data, s.place.country);
      if (code && passports.length) rules.set(s.id, entryRule(data, passports, code, span.start));
      continue;
    }
    mine.push({ id: `${ROTATION_PREFIX}${s.id}`, country: s.place.country, start: span.start, end: span.end, label: s.place.name, tentative: span.approx });
  }
  const outside = others.filter((o) => !o.id.startsWith(ROTATION_PREFIX));
  if (!mine.length) return { verdicts: new Map(), rules, check: null };
  const check = checkStays(data, passports, [...outside, ...mine], { today: opts.today, expiry: opts.expiry });
  const verdicts = new Map<string, StayVerdict>();
  for (const v of check.verdicts) if (v.id.startsWith(ROTATION_PREFIX)) verdicts.set(v.id.slice(ROTATION_PREFIX.length), v);
  return { verdicts, rules, check };
}
