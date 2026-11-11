// Visa verdicts on the Rotation screen (ADR 0012): a badge per Rotation Stay, the plan's
// violations, and where to go when a limit is reached (Schengen buffers, border runs).

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "../../ui";
import { hrefFor } from "../../lib/router";
import { getBorderRuns, getBuffers, getVisaDays, type OwnerStay } from "../../lib/visaApi";
import { useVisa } from "../../lib/useVisa";
import { rotationVisa, type RotationVisa } from "../../lib/rotationVisa";
import { STATUS_LABEL, limitLabel, type EntryRule } from "../../lib/visa/rules";
import { expiryByPassport } from "../../lib/visa/settings";
import { staySpan, type RotationStay } from "../../lib/rotation";
import type { BorderRunOption, BufferOption, StayVerdict, Violation } from "../../lib/visa/engine";
import { BORDER_RUN_METHOD } from "../../lib/visa/engine";
import { LEVEL_LABEL, LEVEL_TONE, SourceLink, VerdictDetail, ViolationList, VisaDisclaimer } from "../visa/VisaParts";

/** The other presence (journal, trips) the counts need, loaded once per visit. */
function useOtherPresence(unlocked: boolean): OwnerStay[] {
  const [others, setOthers] = useState<OwnerStay[]>([]);
  useEffect(() => {
    if (!unlocked) return;
    getVisaDays()
      .then((r) => setOthers(r.stays.filter((s) => s.source !== "rotation")))
      .catch(() => setOthers([]));
  }, [unlocked]);
  return others;
}

export function useRotationVisa(stays: RotationStay[], today: string): (RotationVisa & { ready: boolean; passports: string[] }) | null {
  const visa = useVisa();
  const others = useOtherPresence(visa.unlocked);
  return useMemo(() => {
    if (visa.status !== "ready" || !visa.data) return null;
    const r = rotationVisa(stays, others, visa.data, visa.passports, { today, expiry: expiryByPassport(visa.settings) });
    return { ...r, ready: true, passports: visa.passports };
  }, [visa.status, visa.data, visa.passports.join(), visa.settings, stays, others, today]);
}

export function StayVisaBadge({ verdict, rule }: { verdict?: StayVerdict; rule?: EntryRule }) {
  if (verdict) return <Badge tone={LEVEL_TONE[verdict.level]}>{LEVEL_LABEL[verdict.level]}</Badge>;
  if (rule && rule.status !== "home" && rule.status !== "free-movement") return <Badge tone={rule.status === "visa-required" || rule.status === "no-admission" ? "danger" : "neutral"}>{STATUS_LABEL[rule.status]}</Badge>;
  return null;
}

/** The stay sheet's section: the verdict in full, or the requirement for an idea. */
export function StayVisaSection({ verdict, rule }: { verdict?: StayVerdict; rule?: EntryRule }) {
  if (!verdict && !rule) return null;
  return (
    <section className="rotation-sheet-section" aria-labelledby="rot-visa">
      <h3 id="rot-visa" className="ui-section-title">
        Entry and days
      </h3>
      {verdict ? (
        <VerdictDetail v={verdict} />
      ) : (
        <div className="visa-detail">
          <div className="visa-detail-head">
            <Badge>{STATUS_LABEL[rule!.status]}</Badge>
          </div>
          <p className="visa-detail-msg">
            {rule!.limit ? `Allows ${limitLabel(rule!.limit)}. ` : ""}An idea is not counted with your other stays until you plan it.
          </p>
          {rule!.sources[0] && <SourceLink {...rule!.sources[0]} />}
        </div>
      )}
      <VisaDisclaimer />
    </section>
  );
}

/** Plan-level violations, with buffer and border-run suggestions for each. */
export function RotationVisaPanel({ stays, visa }: { stays: RotationStay[]; visa: (RotationVisa & { passports: string[] }) | null }) {
  if (!visa) return null;
  if (!visa.passports.length)
    return (
      <p className="rotation-fine">
        Add your passport in Settings › Visas to check every stay's entry rule and day limits. <a href={hrefFor({ view: "plan", tab: "days" })}>Days</a>
      </p>
    );
  // Only what involves a Rotation Stay; trips' own breaches are on the trip and on Plan › Days.
  const violations = (visa.check?.violations ?? []).filter((v) => v.stayIds.some((id) => id.startsWith("r:")));
  const counted = visa.verdicts.size;
  return (
    <div className="rotation-visa">
      {violations.length ? (
        <>
          <ViolationList items={violations} />
          {violations.map((v) => (
            <Suggestions key={`${v.key}-${v.firstOver}`} v={v} stays={stays} />
          ))}
        </>
      ) : (
        <p className="rotation-fine">
          {counted ? `No day limit is broken by your ${counted} planned ${counted === 1 ? "stay" : "stays"}, with your journal and dated trips counted.` : "No dated stays to count yet."}
        </p>
      )}
      <p className="rotation-fine">
        Schengen timeline, country counters and tax days are on <a href={hrefFor({ view: "plan", tab: "days" })}>Plan › Days</a>.
      </p>
      <VisaDisclaimer />
    </div>
  );
}

function Suggestions({ v, stays }: { v: Violation; stays: RotationStay[] }) {
  const [state, setState] = useState<{ busy: boolean; buffers?: BufferOption[]; runs?: { options: BorderRunOption[]; notes: string[] }; error?: string }>({ busy: false });
  const hit = stays.find((s) => v.stayIds.includes(`r:${s.id}`) && staySpan(s) && staySpan(s)!.start <= v.firstOver && v.firstOver <= staySpan(s)!.end) ?? stays.find((s) => v.stayIds.includes(`r:${s.id}`));
  if (!hit) return null;
  const span = staySpan(hit)!;
  const nights = Math.max(1, Math.round((Date.parse(span.end) - Date.parse(v.firstOver)) / 86_400_000));
  const run = async () => {
    setState({ busy: true });
    try {
      if (v.kind === "per-entry") setState({ busy: false, runs: await getBorderRuns({ cityId: hit.place.cityId, date: v.firstOver }) });
      else setState({ busy: false, buffers: (await getBuffers({ cityId: hit.place.cityId, start: v.firstOver, nights })).options });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : "Couldn't load suggestions" });
    }
  };
  const label = v.kind === "per-entry" ? `Border runs from ${hit.place.name}` : v.key === "schengen" ? `Places outside Schengen for ${nights} nights from ${v.firstOver}` : `Somewhere else from ${v.firstOver}`;
  return (
    <Card padding="sm" className="rotation-visa-suggest">
      <div className="rotation-visa-suggest-head">
        <span className="rotation-fine">{label}</span>
        {!state.buffers && !state.runs && (
          <Button size="sm" variant="ghost" loading={state.busy} onClick={() => void run()}>
            Show options
          </Button>
        )}
      </div>
      {state.error && <p className="rotation-fine">{state.error}</p>}
      {state.buffers && (
        <ol className="rotation-visa-options">
          {state.buffers.map((b) => (
            <li key={b.place.cityId}>
              <strong>{b.place.name}</strong>, {b.countryName}
              <span className="rotation-fine num">
                {" "}
                · {b.km.toLocaleString("en-US")} km (#{b.distanceRank} by distance) · {b.comfort !== null ? `comfort ${b.comfort} (#${b.comfortRank})` : "no comfort data"}
                {b.notes.length ? ` · ${b.notes.join(" ")}` : ""}
              </span>
            </li>
          ))}
          {!state.buffers.length && <li className="rotation-fine">No place your passport can enter for that long within 4,000 km.</li>}
        </ol>
      )}
      {state.runs && (
        <>
          <ol className="rotation-visa-options">
            {state.runs.options.map((o) => (
              <li key={o.place.cityId}>
                <strong>{o.place.name}</strong>, {o.countryName}
                <span className="rotation-fine num">
                  {" "}
                  · {o.estimate} · {STATUS_LABEL[o.rule.status]}
                  {o.notes.length ? ` · ${o.notes.join(" ")}` : ""}
                </span>
              </li>
            ))}
          </ol>
          {state.runs.notes.map((n) => (
            <p key={n} className="rotation-fine">
              {n}
            </p>
          ))}
          <p className="rotation-fine">{BORDER_RUN_METHOD}</p>
        </>
      )}
    </Card>
  );
}
