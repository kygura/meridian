// Entry requirements per stop (ADR 0012): what the owner's passports need at each stop, days
// allowed against days planned, passport validity and yellow fever. Logic in lib/tripRisk.

import { useMemo } from "react";
import { useMeridianStore } from "../../../store";
import { tripEntryChecks, type StopEntry } from "../../../lib/tripRisk";
import { useVisa } from "../../../lib/useVisa";
import { STATUS_LABEL, limitLabel } from "../../../lib/visa/rules";
import { expiryByPassport } from "../../../lib/visa/settings";
import { Badge, Skeleton } from "../../../ui";
import { LEVEL_LABEL, LEVEL_TONE, SourceLink, VerdictDetail, ViolationList, VisaDisclaimer } from "../../visa/VisaParts";
import type { Trip } from "../../../types";

export function useTripEntry(trip: Trip) {
  const visa = useVisa();
  const cities = useMeridianStore((s) => s.cities);
  const country = useMemo(() => new Map(cities.map((c) => [c.id, c.country])), [cities]);
  const result = useMemo(() => {
    if (visa.status !== "ready" || !visa.data) return null;
    return tripEntryChecks(trip, visa.data, visa.passports, (id) => country.get(id), { expiry: expiryByPassport(visa.settings) });
  }, [visa.status, visa.data, visa.passports.join(), visa.settings, trip, country]);
  return { visa, result };
}

/** A small badge for a stop row: the entry verdict, or the requirement when undated. */
export function StopEntryBadge({ entry }: { entry: StopEntry | undefined }) {
  if (!entry) return null;
  if (entry.verdict) return <Badge tone={LEVEL_TONE[entry.verdict.level]}>{LEVEL_LABEL[entry.verdict.level]}</Badge>;
  const r = entry.rule;
  if (r && r.status !== "home" && r.status !== "free-movement") return <Badge tone={r.status === "visa-required" || r.status === "no-admission" ? "danger" : "neutral"}>{STATUS_LABEL[r.status]}</Badge>;
  return null;
}

/** Trip editor card: one row per stop, the trip's violations, sources and the disclaimer. */
export function EntryCard({ trip }: { trip: Trip }) {
  const { visa, result } = useTripEntry(trip);
  if (!visa.unlocked) return <p className="trips-risk-note">Sign in to check entry rules for your passport.</p>;
  if (visa.status === "error") return <p className="trips-risk-note">{visa.error ?? "Couldn't load the entry data."}</p>;
  if (!result) return <Skeleton lines={3} />;
  if (!visa.passports.length) return <p className="trips-risk-note">Add your passport in Settings › Visas to check entry rules, days allowed and passport validity for each stop.</p>;
  if (!trip.nodes.length) return <p className="trips-risk-note">Add stops to check their entry rules.</p>;
  return (
    <div className="trips-entry">
      {result.check && result.check.violations.length > 0 && <ViolationList items={result.check.violations} />}
      <ul className="trips-entry-list">
        {result.stops.map((s) => (
          <li key={`${s.node.cityId}#${s.index}`} className="trips-entry-row">
            <span className="trips-entry-place">{s.node.name}</span>
            {s.verdict ? (
              <VerdictDetail v={s.verdict} compact />
            ) : s.rule ? (
              <div className="visa-detail visa-detail--compact">
                <div className="visa-detail-head">
                  <Badge>{STATUS_LABEL[s.rule.status]}</Badge>
                </div>
                <p className="visa-detail-msg">
                  {s.rule.limit ? `Allows ${limitLabel(s.rule.limit)}. ` : ""}Add dates to count the days.
                </p>
              </div>
            ) : (
              <p className="visa-detail-msg">No entry data for this place.</p>
            )}
            {(s.verdict?.rule ?? s.rule)?.sources[0] && <SourceLink {...(s.verdict?.rule ?? s.rule)!.sources[0]} />}
          </li>
        ))}
      </ul>
      <VisaDisclaimer />
    </div>
  );
}
