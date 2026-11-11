import { useEffect, useMemo, useState } from "react";
import { Badge, Card, Disclosure, EmptyState, ErrorState, Field, Input, SectionHeader, Skeleton, Stat, UnlockCard, useJournalToken } from "../../../ui";
import { IconCalendar } from "../../../ui/icons";
import { getVisaDays, type OwnerStay } from "../../../lib/visaApi";
import { SCHENGEN, countryName, type VisaData } from "../../../lib/visa/data";
import { dayIso, dayNum } from "../../../lib/visa/days";
import { limitLabel } from "../../../lib/visa/rules";
import {
  checkStays,
  firstArrivals,
  limitUsage,
  limitsFor,
  maxStayFrom,
  schengenOn,
  schengenRanges,
  schengenSummary,
  schengenTimeline,
  taxDays,
  taxWarnings,
  toPresence,
  TAX_WARN_DAYS,
} from "../../../lib/visa/engine";
import type { VisaSettings } from "../../../lib/visa/settings";
import { SourceLink, ViolationList, VisaDisclaimer } from "../../visa/VisaParts";
import "./days.css";

type Loaded = { today: string; stays: OwnerStay[]; data: VisaData; settings: VisaSettings };

const SOURCE_LABEL: Record<OwnerStay["source"], string> = { journal: "Journal", trip: "Trip", rotation: "Rotation" };

/** #/plan/days: Schengen window, per-country counters and tax-residency days (ADR 0012). */
export default function DaysPage() {
  const { unlocked, token } = useJournalToken();
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; loaded?: Loaded; error?: string }>({ status: "loading" });

  const load = () => {
    setState({ status: "loading" });
    getVisaDays()
      .then((loaded) => setState({ status: "ready", loaded }))
      .catch((e: unknown) => setState({ status: "error", error: e instanceof Error ? e.message : "Couldn't load your days" }));
  };
  useEffect(() => {
    if (unlocked) load();
  }, [unlocked, token]);

  if (!unlocked) return <UnlockCard title="Sign in to count your days" />;
  if (state.status === "loading") return <Skeleton lines={6} />;
  if (state.status === "error" || !state.loaded) return <ErrorState message={state.error} onRetry={load} />;
  return <Days {...state.loaded} />;
}

function Days({ today, stays, data, settings }: Loaded) {
  const passports = settings.passports.map((p) => p.country);
  const presence = useMemo(() => toPresence(data, stays), [data, stays]);
  const t = dayNum(today);
  const sch = useMemo(() => schengenRanges(presence), [presence]);
  const summary = useMemo(() => schengenSummary(data, passports, stays, today), [data, passports.join(), stays, today]);
  const check = useMemo(() => checkStays(data, passports, stays, { today }), [data, passports.join(), stays, today]);
  const usage = useMemo(() => limitUsage(presence, limitsFor(data, passports, firstArrivals(presence.filter((p) => p.end >= t))), t).filter((u) => u.limit.key !== SCHENGEN.id && (u.peak > 0 || u.now > 0)), [presence, data, passports.join(), t]);
  const year = Number(today.slice(0, 4));
  const tax = useMemo(
    () =>
      taxDays(data, presence, { years: [year, year + 1], watch: settings.taxWatch, residency: settings.residency }).sort(
        (a, b) => Number(b.residency) - Number(a.residency) || a.period.localeCompare(b.period) || b.days - a.days || a.country.localeCompare(b.country)
      ),
    [data, presence, year, settings]
  );
  const warnings = taxWarnings(tax);
  const futureViolations = check.violations;

  if (!passports.length) {
    return (
      <EmptyState
        icon={<IconCalendar />}
        title="Add your passport to count your days"
        description="Settings › Visas holds the passports you travel on, your legal residency and the countries to watch for tax days. The counts below use your journal, dated trips and rotation."
      />
    );
  }

  return (
    <div className="plan-days">
      <VisaDisclaimer />
      <section aria-labelledby="days-schengen">
        <SectionHeader id="days-schengen" title="Schengen 90/180" meta={summary.applies ? `${summary.today.used} of 90 used today` : "Does not apply"} />
        {summary.applies ? <SchengenBlock today={today} sch={sch} summary={summary} /> : <p className="plan-days-note">{summary.reason} Days in the area are still shown below for reference.</p>}
        {!summary.applies && <SchengenChart sch={sch} from={t - SCHENGEN.windowDays + 1} to={Math.max(t + 365, ...presence.map((p) => p.end))} today={t} />}
        <p className="plan-days-note">
          {SCHENGEN.counting} <SourceLink title="European Commission and the Schengen Borders Code" url={SCHENGEN.sources[0].url} checked={SCHENGEN.checked} />
        </p>
      </section>

      <section aria-labelledby="days-limits">
        <SectionHeader id="days-limits" title="Country limits" meta={usage.length ? `${usage.length} counted` : "None ahead"} />
        {futureViolations.length > 0 && (
          <Card padding="sm" className="plan-days-alert">
            <ViolationList items={futureViolations} />
          </Card>
        )}
        {usage.length ? (
          <div className="plan-days-table" role="table" aria-label="Country limits">
            <div className="plan-days-row plan-days-row--head" role="row">
              <span role="columnheader">Country</span>
              <span role="columnheader">Rule</span>
              <span role="columnheader">Now</span>
              <span role="columnheader">Most ahead</span>
            </div>
            {usage.map((u) => (
              <div className="plan-days-row" role="row" key={u.limit.key + u.limit.limit.kind}>
                <span role="cell">{u.limit.label}</span>
                <span role="cell">
                  {limitLabel(u.limit.limit)}
                  <span className="visa-source">{u.limit.origin === "owner" ? u.limit.source : u.limit.origin === "dataset" ? "Dataset figure, counted per entry" : u.limit.source}</span>
                </span>
                <span role="cell" className="num">
                  <span className="plan-days-mlabel">Now</span>
                  {u.now}
                </span>
                <span role="cell" className="num">
                  <span className="plan-days-mlabel">Most ahead</span>
                  <Badge tone={u.over ? "danger" : u.peak >= u.limit.limit.days - 7 ? "warning" : "success"}>
                    {u.peak} of {u.limit.limit.days}
                  </Badge>
                  {u.peakOn && <span className="visa-source">on {u.peakOn}</span>}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="plan-days-note">No planned stay ahead falls under a day limit Meridian knows of.</p>
        )}
      </section>

      <section aria-labelledby="days-tax">
        <SectionHeader id="days-tax" title="Tax residency days" meta={settings.residency ? `Keeping ${countryName(data, settings.residency)}` : "No residency set"} />
        {warnings.length > 0 && (
          <Card padding="sm" className="plan-days-alert plan-days-alert--warn">
            <ul className="plan-days-warn">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Card>
        )}
        <div className="plan-days-tax">
          {tax.map((r) => (
            <Card key={r.country + r.period} padding="sm" className={r.residency ? "plan-days-taxcard plan-days-taxcard--home" : "plan-days-taxcard"}>
              <div className="plan-days-taxhead">
                <strong>{r.countryName}</strong>
                {r.residency && <Badge tone="accent">Your residency</Badge>}
                {!r.residency && r.status !== "ok" && <Badge tone={r.status === "over" ? "danger" : "warning"}>{r.status === "over" ? "Past the test" : `Within ${TAX_WARN_DAYS} days`}</Badge>}
              </div>
              <div className="plan-days-bar" aria-hidden="true">
                <span className={`plan-days-fill plan-days-fill--${r.residency ? "home" : r.status}`} style={{ width: `${Math.min(100, (r.days / r.threshold) * 100)}%` }} />
              </div>
              <p className="plan-days-taxline num">
                {r.days} of {r.threshold} days · {r.period}
                {r.period.startsWith("Any") ? ` (most: ${r.periodStart} to ${r.periodEnd})` : ""}
              </p>
              <Disclosure summary="The test">
                <p className="plan-days-note">{r.rule}</p>
                <SourceLink title={r.source.title} url={r.source.url} checked={r.source.checked} />
              </Disclosure>
            </Card>
          ))}
        </div>
        {!tax.length && <p className="plan-days-note">No days counted for this year or next.</p>}
        <p className="plan-days-note">Days present are counted, arrival and departure days included, from your journal, dated trips and rotation. Meridian does not give tax advice: your residency depends on more than days.</p>
      </section>

      <section aria-labelledby="days-sources">
        <SectionHeader id="days-sources" title="Where the days come from" meta={`${stays.length} ${stays.length === 1 ? "stay" : "stays"}`} />
        <Disclosure summary="Every stay counted">
          <ul className="plan-days-stays">
            {stays.map((s) => (
              <li key={s.id} className="num">
                <Badge>{SOURCE_LABEL[s.source]}</Badge> {s.label}, {s.country} · {s.start} to {s.end}
                {s.tentative ? " (month window, approximate)" : ""} <span className="visa-source">{s.context}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
        <p className="plan-days-note">
          Entry data: <SourceLink title={data.sources.requirements?.name ?? "dataset"} url={data.sources.requirements?.url} checked={data.sources.requirements?.fetchedAt} /> (dataset of {data.sources.requirements?.datasetUpdated ?? "unknown date"}), and the curated rules in Meridian, each with its own source and checked date.
        </p>
      </section>
    </div>
  );
}

function SchengenBlock({ today, sch, summary }: { today: string; sch: ReturnType<typeof schengenRanges>; summary: ReturnType<typeof schengenSummary> }) {
  const [pick, setPick] = useState(today);
  const t = dayNum(today);
  const p = dayNum(pick || today);
  const on = schengenOn(sch, p);
  const end = Math.max(t + 365, ...sch.map(([, b]) => b));
  return (
    <div className="plan-days-schengen">
      <div className="plan-days-stats">
        <Stat label="Used today" value={<span className="num">{summary.today.used}</span>} hint="in the last 180 days" />
        <Stat label="Left today" value={<span className="num">{summary.today.left}</span>} hint={summary.maxStayToday ? `a stay from today could last ${summary.maxStayToday} days` : "you're in the area"} />
        <Stat label="First overstay" value={<span className="num">{summary.firstOverstay ?? "None"}</span>} hint={summary.firstOverstay ? "with the stays planned now" : "with the stays planned now"} />
        <Stat label="Most in any 180" value={<span className="num">{summary.peak.used}</span>} hint={summary.peak.day ? `on ${summary.peak.day}` : "nothing planned"} />
      </div>
      <SchengenChart sch={sch} from={t - SCHENGEN.windowDays + 1} to={end} today={t} />
      <div className="plan-days-check">
        <Field label="Check a date">
          <Input type="date" size="sm" value={pick} onChange={(e) => setPick(e.target.value)} />
        </Field>
        <p className="plan-days-note num">
          On {dayIso(p)}: {on.used} of 90 days used in the 180 ending that day, {on.left} left.{" "}
          {sch.some(([a, b]) => a <= p && p <= b) ? "You'd be in the area that day." : `Entering that day, you could stay ${maxStayFrom(sch, p)} days.`}
          {summary.earliestEntry && summary.earliestEntry !== today ? ` Earliest day a new entry fits: ${summary.earliestEntry}.` : ""}
        </p>
      </div>
    </div>
  );
}

/** Days used in the rolling 180 for every day of the range, with the 90 line and today. */
function SchengenChart({ sch, from, to, today }: { sch: ReturnType<typeof schengenRanges>; from: number; to: number; today: number }) {
  const days = useMemo(() => schengenTimeline(sch, from, to), [sch, from, to]);
  const W = Math.max(1, days.length);
  const H = 100;
  const top = Math.max(110, ...days.map((d) => d.used + 10));
  const y = (n: number) => H - (n / top) * (H - 6) - 6;
  const path = days.map((d, i) => `${i === 0 ? "M" : "L"}${i},${y(d.used).toFixed(1)}`).join(" ");
  const months: { i: number; label: string; minor: boolean }[] = [];
  days.forEach((d, i) => {
    if (d.day.endsWith("-01")) months.push({ i, minor: !["01", "04", "07", "10"].includes(d.day.slice(5, 7)), label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) + (d.day.slice(5, 7) === "01" ? ` ${d.day.slice(2, 4)}` : "") });
  });
  const over = days.some((d) => d.used > 90);
  return (
    <figure className="plan-days-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Schengen days used in the rolling 180, ${dayIso(from)} to ${dayIso(to)}${over ? ", going over 90" : ""}`}>
        {days.map((d, i) => (d.present ? <rect key={i} x={i} y={H - 6} width={1} height={6} className="plan-days-present" /> : null))}
        <line x1={0} x2={W} y1={y(90)} y2={y(90)} className="plan-days-limit" vectorEffect="non-scaling-stroke" />
        <line x1={today - from} x2={today - from} y1={0} y2={H} className="plan-days-today" vectorEffect="non-scaling-stroke" />
        <path d={path} className="plan-days-line" vectorEffect="non-scaling-stroke" fill="none" />
        {days.map((d, i) => (d.used > 90 ? <rect key={`o${i}`} x={i} y={y(d.used)} width={1} height={y(90) - y(d.used)} className="plan-days-over" /> : null))}
      </svg>
      <div className="plan-days-axis" aria-hidden="true">
        {months.map((m) => (
          <span key={m.i} className={m.minor ? "plan-days-minor" : undefined} style={{ left: `${(m.i / W) * 100}%` }}>
            {m.label}
          </span>
        ))}
      </div>
      <figcaption className="plan-days-legend">
        <span className="plan-days-key plan-days-key--line" /> days used in the 180 ending each day
        <span className="plan-days-key plan-days-key--limit" /> 90
        <span className="plan-days-key plan-days-key--present" /> in the area
        <span className="plan-days-key plan-days-key--today" /> today
      </figcaption>
    </figure>
  );
}
