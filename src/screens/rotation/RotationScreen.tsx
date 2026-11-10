import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Page,
  PageHeader,
  SectionHeader,
  Segmented,
  Select,
  Spinner,
  Stat,
  UnlockCard,
  cx,
  toast,
  useIsDesktop,
  useJournalToken,
} from "../../ui";
import { IconCalendar, IconExternal, IconPlus, IconTrips } from "../../ui/icons";
import { useMeridianStore } from "../../store";
import { fetchSeasonality } from "../../lib/seasonalityApi";
import { hubsFromCities, landmassFromCities, formatFlightTime } from "../../lib/tripPlan";
import { MODE_LABEL } from "../../lib/legs";
import {
  FIT_LABEL,
  bookingDeadlines,
  clampHorizon,
  currentStay,
  effectiveStatus,
  formatShortDate,
  horizonRange,
  orderStays,
  rentalLinks,
  rotationIssues,
  rotationLegs,
  rotationTotals,
  stayFit,
  todayIso,
  whatsNext,
  type PlaceProfile,
  type RotationPlace,
  type RotationStay,
} from "../../lib/rotation";
import { useRotation } from "./useRotation";
import { Timeline } from "./Timeline";
import { RotationMap } from "./RotationMap";
import { StaySheet } from "./StaySheet";
import { RotationVisaPanel, StayVisaBadge, useRotationVisa } from "./RotationVisa";
import { PlaceSheet } from "./PlaceSheet";
import { ConvertSheet } from "./ConvertSheet";
import { KIND_LABEL, STATUS_LABEL, WINDOW_LABEL, costText, daysText, stayDatesText } from "./format";
import { spanLabel } from "../../lib/season";
import { SolvePanel } from "./solve/SolvePanel";
import { ReplanProposals } from "./solve/ReplanProposals";
import "./rotation.css";

type SheetState =
  | { kind: "stay"; id: string }
  | { kind: "new"; template?: RotationStay }
  | { kind: "place"; place: RotationPlace }
  | { kind: "convert" }
  | null;

/**
 * Route #/rotation. Where the owner lives next: a rolling 12–18 month calendar of stays,
 * separate from Trips (ADR 0011).
 */
export default function RotationScreen() {
  const { token, unlocked } = useJournalToken();
  const { data, loading, error, load, putStay, putStays, deleteStay, putPlace, deletePlace, putSettings } = useRotation();
  const cities = useMeridianStore((s) => s.cities);
  const seasonality = useMeridianStore((s) => s.seasonality);
  const mergeSeasonality = useMeridianStore((s) => s.mergeSeasonality);
  const isDesktop = useIsDesktop();
  const [sheet, setSheet] = useState<SheetState>(null);
  const [mode, setMode] = useState<"calendar" | "solve">("calendar");
  const today = todayIso();

  useEffect(() => {
    if (!unlocked) return;
    void load();
    // A second browser's edits show up when this one comes back into focus.
    const onFocus = () => void useRotation.getState().load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [token, unlocked, load]);

  const stays = useMemo(() => orderStays(data?.stays ?? []), [data]);
  const profiles = useMemo(() => new Map((data?.places ?? []).map((p) => [p.cityId, p])), [data]);

  // Comfort Index for every place in the rotation (cached in the store).
  const cityIds = useMemo(() => [...new Set(stays.map((s) => s.place.cityId))], [stays]);
  useEffect(() => {
    const missing = cityIds.filter((id) => !(id in seasonality));
    if (!missing.length) return;
    fetchSeasonality(missing)
      .then((r) => mergeSeasonality(r.cities))
      .catch(() => {});
  }, [cityIds, seasonality, mergeSeasonality]);

  const hubs = useMemo(() => hubsFromCities(cities), [cities]);
  const landmassOf = useMemo(() => landmassFromCities(cities), [cities]);
  const legs = useMemo(() => rotationLegs(stays, hubs, landmassOf), [stays, hubs, landmassOf]);
  const fits = useMemo(
    () => new Map(stays.map((s) => [s.id, stayFit(s, profiles.get(s.place.cityId), (id) => seasonality[id])])),
    [stays, profiles, seasonality]
  );
  const state = useMemo(() => (data ? { settings: data.settings, stays, places: data.places } : null), [data, stays]);
  const deadlines = useMemo(() => (state ? bookingDeadlines(state, today) : []), [state, today]);
  const deadlineMap = useMemo(() => new Map(deadlines.map((d) => [d.stayId, d])), [deadlines]);
  const issues = useMemo(() => rotationIssues(stays), [stays]);
  const visa = useRotationVisa(stays, today);
  const next = useMemo(() => whatsNext(stays, today), [stays, today]);
  const totals = useMemo(() => (state ? rotationTotals(state, today, legs) : null), [state, today, legs]);
  const current = currentStay(stays, today);
  const horizon = clampHorizon(data?.settings.horizonMonths);
  const { from, to } = horizonRange(today, horizon);

  const addFromTrip = async (newStays: RotationStay[], home?: RotationPlace) => {
    const n = await putStays(newStays);
    if (home && data && !data.settings.home) await putSettings({ ...data.settings, home });
    if (n) toast(`Added ${n} ${n === 1 ? "stay" : "stays"}`, { tone: "success" });
    setSheet(null);
  };

  const header = (
    <PageHeader
      kicker="Residence · where you live next"
      title="Rotation"
      subtitle="Bases held for weeks or months, and the hubs between them. No trip home."
      actions={
        unlocked && data ? (
          <>
            {isDesktop && (
              <Button variant="ghost" icon={<IconTrips size={16} />} onClick={() => setSheet({ kind: "convert" })}>
                From your plans
              </Button>
            )}
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setSheet({ kind: "new" })}>
              Add stay
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (!unlocked) {
    return (
      <Page>
        {header}
        <UnlockCard title="Sign in to plan your rotation" />
      </Page>
    );
  }
  if (!data) {
    return (
      <Page>
        {header}
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : <Spinner label="Loading your rotation" />}
      </Page>
    );
  }

  const openStay = sheet?.kind === "stay" ? stays.find((s) => s.id === sheet.id) : undefined;
  const hasStart = !!data.settings.home || stays.some((s) => s.status !== "idea" && s.start && s.start <= today);

  return (
    <Page width="wide">
      {header}
      {!isDesktop && (
        <div className="rotation-phone-actions">
          <Button size="sm" variant="ghost" icon={<IconTrips size={16} />} onClick={() => setSheet({ kind: "convert" })}>
            From your plans
          </Button>
        </div>
      )}

      <Segmented
        className="rotation-mode"
        label="Calendar or solver"
        value={mode}
        onChange={setMode}
        options={[
          { value: "calendar", label: "Calendar" },
          { value: "solve", label: "Solve" },
        ]}
      />
      {mode === "calendar" && <ReplanProposals onChanged={() => void load()} />}

      {mode === "solve" ? (
        <SolvePanel
          stays={stays}
          places={data.places}
          today={today}
          hasStart={hasStart}
          onAccepted={() => {
            void load();
            setMode("calendar");
          }}
        />
      ) : stays.length === 0 ? (
        <EmptyState
          icon={<IconCalendar />}
          title="No stays yet"
          description="Add the base you're in now and the next one, or bring in a trip you've planned."
          action={
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setSheet({ kind: "new" })}>
              Add stay
            </Button>
          }
        />
      ) : (
        <>
          <section className="rotation-section" aria-labelledby="rot-next">
            <SectionHeader id="rot-next" title="What's next" meta={loading ? "Refreshing…" : formatShortDate(today)} />
            <div className="rotation-stats">
              <Stat
                label={current ? "Living in" : "Between stays"}
                value={current ? current.place.name : "—"}
                hint={current && next.daysLeft !== null ? `${daysText(next.daysLeft)} left, until ${formatShortDate(current.end!)}` : "No stay holds today"}
              />
              <Stat
                label="Next move"
                value={next.nextMoveDate ? formatShortDate(next.nextMoveDate) : "—"}
                hint={next.next ? `To ${next.next.place.name}${next.daysToMove !== null ? `, in ${daysText(next.daysToMove)}` : ""}` : next.nextMoveDate ? "Nothing planned after it" : "Nothing dated ahead"}
              />
              <Stat
                label="Next booking deadline"
                value={deadlines[0] ? formatShortDate(deadlines[0].bookBy) : "—"}
                hint={deadlines[0] ? `${deadlines[0].place.name}${deadlines[0].daysLeft < 0 ? `, ${daysText(-deadlines[0].daysLeft)} late` : `, in ${daysText(deadlines[0].daysLeft)}`}` : "Nothing to book"}
              />
            </div>
          </section>

          <section className="rotation-section" aria-labelledby="rot-cal">
            <SectionHeader
              id="rot-cal"
              title="Calendar"
              meta={`${formatShortDate(from)} – ${formatShortDate(to)}`}
              actions={
                <Select
                  size="sm"
                  aria-label="How far ahead"
                  value={String(horizon)}
                  onChange={(e) => void putSettings({ ...data.settings, horizonMonths: Number(e.target.value) })}
                  options={[12, 15, 18].map((n) => ({ value: String(n), label: `${n} months` }))}
                />
              }
            />
            <Timeline from={from} to={to} today={today} stays={stays} fits={fits} deadlines={deadlineMap} issues={issues} onOpen={(id) => setSheet({ kind: "stay", id })} />
            {issues.length > 0 && (
              <ul className="rotation-issues" aria-label="Gaps and overlaps">
                {issues.map((i, k) => (
                  <li key={k} className={cx("rotation-issue", `rotation-issue--${i.kind}`)}>
                    <Badge tone={i.kind === "overlap" || i.kind === "bad-dates" ? "danger" : "warning"}>
                      {i.kind === "gap" ? "Gap" : i.kind === "overlap" ? "Overlap" : i.kind === "bad-dates" ? "Dates" : "Length"}
                    </Badge>
                    <span>
                      {i.message}
                      {i.tentative && <span className="rotation-muted"> Months only, so the dates may still fit.</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {visa && (
            <section className="rotation-section" aria-labelledby="rot-visa-plan">
              <SectionHeader id="rot-visa-plan" title="Visas and days" meta={visa.passports.length ? "Checked for your passport" : "No passport set"} />
              <RotationVisaPanel stays={stays} visa={visa} />
            </section>
          )}

          {totals && (
            <section className="rotation-section" aria-labelledby="rot-totals">
              <SectionHeader id="rot-totals" title="Totals" meta={`Next ${totals.horizonMonths} months`} />
              <div className="rotation-stats">
                <Stat label="Months covered" value={`${totals.monthsCovered} of ${totals.horizonMonths}`} hint={totals.monthsDated < totals.monthsCovered ? `${totals.monthsDated} with fixed dates` : "All with fixed dates"} />
                <Stat
                  label="Cost per month"
                  value={totals.costPerMonth[0] ? costText(totals.costPerMonth[0]).split(" a month")[0] : "—"}
                  hint={totals.costPerMonth.length ? totals.costPerMonth.map(costText).join("; ") : "Add a budget or rent to a stay"}
                />
                <Stat label="Moves per year" value={String(totals.movesPerYear)} hint={`${totals.moves} ${totals.moves === 1 ? "move" : "moves"} in this view`} />
                <Stat
                  label="Travel between stays"
                  value={totals.moves ? `≈ $${totals.travelCostUsd.toLocaleString("en-US")}` : "—"}
                  hint={totals.moves ? `${formatFlightTime(totals.travelHours)} travelling; estimate, see legs` : "No moves in this view"}
                />
              </div>
            </section>
          )}

          <div className="rotation-split">
            <section className="rotation-section" aria-labelledby="rot-map">
              <SectionHeader id="rot-map" title="Route" meta={`${new Set(stays.map((s) => s.place.cityId)).size} places`} />
              <Card padding="none" className="rotation-map-card">
                <RotationMap stays={stays} legs={legs} hubs={hubs} currentId={current?.id ?? null} />
              </Card>
            </section>

            <section className="rotation-section" aria-labelledby="rot-legs">
              <SectionHeader id="rot-legs" title="Moves" meta={legs.length ? `${legs.length}` : "None yet"} />
              {legs.length === 0 ? (
                <p className="rotation-p rotation-muted">Moves appear between consecutive planned stays. Ideas are left out.</p>
              ) : (
                <ol className="rotation-legs">
                  {legs.map((l) => (
                    <li key={`${l.fromStayId}>${l.toStayId}`} className="rotation-leg">
                      <div className="rotation-leg-route">
                        {l.leg.from.name} → {l.leg.to.name}
                      </div>
                      <div className="rotation-leg-meta num">
                        {l.date ? formatShortDate(l.date) : "Date not set"} · {MODE_LABEL[l.leg.mode]} · {l.leg.km.toLocaleString("en-US")} km · {formatFlightTime(l.leg.hours)} · ≈ ${l.leg.cost.toLocaleString("en-US")}
                        {l.leg.via ? ` · via ${l.leg.via}` : ""}
                      </div>
                      <div className="rotation-fine">{l.leg.method}</div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section className="rotation-section" aria-labelledby="rot-deadlines">
            <SectionHeader id="rot-deadlines" title="Book by" meta={deadlines.length ? `${deadlines.length} to book` : "Nothing to book"} />
            {deadlines.length === 0 ? (
              <p className="rotation-p rotation-muted">Stays you've marked booked, or that have started, have no deadline.</p>
            ) : (
              <ul className="rotation-deadlines">
                {deadlines.map((d) => {
                  const s = stays.find((x) => x.id === d.stayId)!;
                  return (
                    <li key={d.stayId} className={cx("rotation-deadline", d.daysLeft < 0 && "rotation-deadline--late")}>
                      <div className="rotation-deadline-head">
                        <button type="button" className="rotation-linkish" onClick={() => setSheet({ kind: "stay", id: d.stayId })}>
                          {d.place.name}
                        </button>
                        <span className="num">
                          Book by {formatShortDate(d.bookBy)} · {d.daysLeft < 0 ? `${daysText(-d.daysLeft)} late` : d.daysLeft === 0 ? "today" : `in ${daysText(d.daysLeft)}`}
                        </span>
                      </div>
                      <div className="rotation-fine">
                        Move in {d.approx ? "around " : ""}
                        {formatShortDate(d.moveIn)} · {d.lead.min === d.lead.max ? d.lead.max : `${d.lead.min}–${d.lead.max}`} weeks ahead (
                        {d.basis === "default" ? "default" : d.basis === "place" ? "your lead time for this place" : "set on this stay"})
                      </div>
                      <div className="rotation-search">
                        {rentalLinks(s).map((l) => (
                          <a key={l.site} href={l.url} target="_blank" rel="noopener noreferrer" title={`Prefills ${l.prefills}`}>
                            {l.label} <IconExternal size={12} />
                          </a>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rotation-section" aria-labelledby="rot-stays">
            <SectionHeader id="rot-stays" title="Stays" meta={`${stays.length}`} />
            <ul className="rotation-stays">
              {stays.map((s) => {
                const fit = fits.get(s.id)!;
                const st = effectiveStatus(s, today);
                return (
                  <li key={s.id}>
                    <button type="button" className="rotation-stay" onClick={() => setSheet({ kind: "stay", id: s.id })}>
                      <span className={cx("rotation-swatch", `rotation-fit--${fit.level}`)} aria-hidden="true" />
                      <span className="rotation-stay-main">
                        <span className="rotation-stay-name">
                          {s.place.name}
                          {s.locked ? <span className="rotation-muted"> · locked</span> : null}
                        </span>
                        <span className="rotation-fine num">{stayDatesText(s)}</span>
                        <span className="rotation-fine">
                          {FIT_LABEL[fit.level]} · {fit.summary}
                        </span>
                      </span>
                      <span className="rotation-stay-badges">
                        <StayVisaBadge verdict={visa?.verdicts.get(s.id)} rule={visa?.rules.get(s.id)} />
                        <Badge>{KIND_LABEL[s.kind]}</Badge>
                        <Badge tone={st === "booked" || st === "current" ? "success" : st === "idea" ? "neutral" : "accent"}>{STATUS_LABEL[st]}</Badge>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="rotation-section" aria-labelledby="rot-places">
            <SectionHeader id="rot-places" title="Your windows" meta="Override the Comfort Index" />
            <ul className="rotation-places">
              {placesOf(stays, data.places).map(({ place, profile }) => (
                <li key={place.cityId}>
                  <button type="button" className="rotation-place" onClick={() => setSheet({ kind: "place", place })}>
                    <span className="rotation-stay-name">{place.name}</span>
                    <span className="rotation-fine">
                      {profile?.windows.length
                        ? profile.windows.map((w) => `${WINDOW_LABEL[w.kind]} ${spanLabel(w.months)}${w.reason ? ` (${w.reason})` : ""}`).join(" · ")
                        : "No windows: the Comfort Index decides"}
                      {profile?.leadTime ? ` · book ${profile.leadTime.min}–${profile.leadTime.max} weeks ahead` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {sheet?.kind === "stay" && openStay && (
        <StaySheet
          key={openStay.id + (openStay.updatedAt ?? "")}
          open
          stay={openStay}
          profile={profiles.get(openStay.place.cityId)}
          fit={fits.get(openStay.id)}
          visaVerdict={visa?.verdicts.get(openStay.id)}
          visaRule={visa?.rules.get(openStay.id)}
          onClose={() => setSheet(null)}
          onSave={putStay}
          onDelete={async (id) => {
            await deleteStay(id);
            setSheet(null);
            toast(`Deleted ${openStay.place.name}`);
          }}
          onEditPlace={(place) => setSheet({ kind: "place", place })}
        />
      )}
      {sheet?.kind === "new" && (
        <StaySheet key={sheet.template?.id ?? "new"} open stay={null} template={sheet.template} onClose={() => setSheet(null)} onSave={putStay} />
      )}
      {sheet?.kind === "place" && (
        <PlaceSheet
          key={sheet.place.cityId}
          open
          place={sheet.place}
          profile={profiles.get(sheet.place.cityId)}
          onClose={() => setSheet(null)}
          onSave={putPlace}
          onDelete={async (id) => {
            await deletePlace(id);
            setSheet(null);
          }}
        />
      )}
      {sheet?.kind === "convert" && (
        <ConvertSheet open onClose={() => setSheet(null)} onTrip={addFromTrip} onTemplate={(t) => setSheet({ kind: "new", template: t })} />
      )}
    </Page>
  );
}

/** Every place in the rotation, plus places with windows but no stay yet. */
function placesOf(stays: RotationStay[], places: PlaceProfile[]): { place: RotationPlace; profile?: PlaceProfile }[] {
  const out = new Map<string, { place: RotationPlace; profile?: PlaceProfile }>();
  const byId = new Map(places.map((p) => [p.cityId, p]));
  for (const s of stays) if (!out.has(s.place.cityId)) out.set(s.place.cityId, { place: s.place, profile: byId.get(s.place.cityId) });
  for (const p of places) {
    if (out.has(p.cityId)) continue;
    const stay = stays.find((s) => s.place.cityId === p.cityId);
    out.set(p.cityId, { place: stay?.place ?? { cityId: p.cityId, name: p.name, country: p.country, lat: 0, lng: 0 }, profile: p });
  }
  return [...out.values()];
}
