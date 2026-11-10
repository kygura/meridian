// The concrete side of a trip in the editor (ADR 0010): once the trip has a year, each
// stop takes dates, a stay, activities and notes, and the trip reads day by day.
// A trip with no year stays a season (ADR 0007) and shows none of this.

import { useMemo, useState } from "react";
import { useMeridianStore } from "../../../store";
import { stayLinks, MONTHLY_NIGHTS } from "../../../lib/bookLinks";
import {
  cleanActivity,
  cleanLink,
  cleanLodging,
  dayByDay,
  formatDay,
  isIsoDate,
  newActivityId,
  nightsText,
  stopNights,
  validateItinerary,
  type DayGroup,
  type ItineraryIssue,
} from "../../../lib/itinerary";
import type { TripRoute } from "../../../lib/legs";
import type { DatedSpan } from "../../../lib/season";
import { Badge, Button, Field, IconButton, Input, Select, Sheet, SectionHeader, Textarea, cx } from "../../../ui";
import { IconAlert, IconCalendar, IconCheck, IconEdit, IconExternal, IconPlus, IconTrash } from "../../../ui/icons";
import type { City, Trip, TripActivity, TripLodging, TripNode } from "../../../types";
import { MoneyInput, moneyDraft, moneyFromDraft, type MoneyDraftValue } from "./moneyInput";
import "./itinerary.css";

const patch = (tripId: string, index: number, p: Parameters<ReturnType<typeof useMeridianStore.getState>["patchStop"]>[2]) =>
  useMeridianStore.getState().patchStop(tripId, index, p);

function shortRange(a: string, d: string): string {
  const sameYear = a.slice(0, 4) === d.slice(0, 4);
  return `${formatDay(a, { weekday: false, year: !sameYear })} – ${formatDay(d, { weekday: false })}`;
}

/** Under each stop once the trip has a year: its dates, and what is planned there. */
export function StopPlan({
  trip,
  index,
  node,
  monthDates,
  cityIdx,
}: {
  trip: Trip;
  index: number;
  node: TripNode;
  /** The stop's months as dates in the chosen year, when it is placed. */
  monthDates: DatedSpan | null;
  cityIdx: Map<string, City>;
}) {
  const [open, setOpen] = useState(false);
  const nights = stopNights(node);
  const acts = node.activities?.length ?? 0;
  const dated = isIsoDate(node.arrive) || isIsoDate(node.depart);

  return (
    <div className="trips-itin-stop">
      <span className="trips-itin-dates" role="group" aria-label={`Dates in ${node.name}`}>
        <Input
          type="date"
          size="sm"
          aria-label={`Arrive in ${node.name}`}
          value={node.arrive ?? ""}
          max={node.depart || undefined}
          onChange={(e) => patch(trip.id, index, { arrive: e.target.value || undefined })}
        />
        <span aria-hidden="true">to</span>
        <Input
          type="date"
          size="sm"
          aria-label={`Leave ${node.name}`}
          value={node.depart ?? ""}
          min={node.arrive || undefined}
          onChange={(e) => patch(trip.id, index, { depart: e.target.value || undefined })}
        />
      </span>
      <span className="trips-itin-summary">
        {nights !== null ? <span className="tabular">{nightsText(nights)}</span> : null}
        {!dated && monthDates ? (
          <button
            type="button"
            className="trips-itin-fill"
            onClick={() => patch(trip.id, index, { arrive: monthDates.start, depart: monthDates.end })}
            title="Start from the months this stop is placed in, then adjust"
          >
            Use {shortRange(monthDates.start, monthDates.end)}
          </button>
        ) : null}
        {node.lodging ? (
          <span className="trips-itin-chip">
            {node.lodging.bookingRef ? <IconCheck size={12} /> : null}
            {node.lodging.name}
          </span>
        ) : null}
        {acts ? (
          <span className="trips-itin-chip">
            {acts} {acts === 1 ? "activity" : "activities"}
          </span>
        ) : null}
        {node.notes ? <span className="trips-itin-chip">Notes</span> : null}
      </span>
      <Button size="sm" variant="ghost" icon={<IconEdit size={14} />} onClick={() => setOpen(true)} aria-label={`Plan your time in ${node.name}: stay, activities and notes`}>
        Stay and plans
      </Button>
      {open ? <StopSheet trip={trip} index={index} node={node} cityIdx={cityIdx} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

// ── Stop sheet ───────────────────────────────────────────────────────

interface LodgingDraft {
  name: string;
  kind: string;
  address: string;
  checkIn: string;
  checkOut: string;
  cost: MoneyDraftValue;
  bookingRef: string;
  link: string;
}

const LODGING_KINDS = [
  { value: "", label: "Not set" },
  { value: "hotel", label: "Hotel" },
  { value: "apartment", label: "Apartment" },
  { value: "hostel", label: "Hostel" },
  { value: "friends", label: "With friends" },
  { value: "other", label: "Other" },
];

function lodgingDraft(l: TripLodging | undefined): LodgingDraft {
  return {
    name: l?.name ?? "",
    kind: l?.kind ?? "",
    address: l?.address ?? "",
    checkIn: l?.checkIn ?? "",
    checkOut: l?.checkOut ?? "",
    cost: moneyDraft(l?.cost),
    bookingRef: l?.bookingRef ?? "",
    link: l?.link ?? "",
  };
}

function StopSheet({ trip, index, node, cityIdx, onClose }: { trip: Trip; index: number; node: TripNode; cityIdx: Map<string, City>; onClose: () => void }) {
  const nights = stopNights(node);
  // The stay saves as you type; the draft keeps what can't be saved yet (no name, a half-typed price).
  const [stay, setStay] = useState<LodgingDraft>(() => lodgingDraft(node.lodging));
  const setLodging = (p: Partial<LodgingDraft>) => {
    const next = { ...stay, ...p };
    setStay(next);
    const cost = moneyFromDraft(next.cost);
    patch(trip.id, index, { lodging: cleanLodging({ ...next, cost: cost === "invalid" ? undefined : cost }) });
  };
  const linkBad = stay.link.trim() !== "" && !cleanLink(stay.link);

  const city = cityIdx.get(node.cityId);
  const checkIn = stay.checkIn || node.arrive;
  const checkOut = stay.checkOut || node.depart;
  const links = stayLinks({ place: { name: node.name, country: city?.country }, checkIn, checkOut, travellers: trip.travellers });
  const monthly = nights !== null && nights >= MONTHLY_NIGHTS;

  return (
    <Sheet
      open
      onClose={onClose}
      title={node.name}
      description={
        isIsoDate(node.arrive) && isIsoDate(node.depart)
          ? `${shortRange(node.arrive, node.depart)}${nights !== null ? ` · ${nightsText(nights)}` : ""}`
          : "No dates yet"
      }
      footer={
        <div className="trips-itin-foot">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <SectionHeader level={3} title="Dates" meta={nights !== null ? nightsText(nights) : undefined} />
      <div className="trips-itin-grid">
        <Field label="Arrive">
          <Input type="date" value={node.arrive ?? ""} max={node.depart || undefined} onChange={(e) => patch(trip.id, index, { arrive: e.target.value || undefined })} />
        </Field>
        <Field label="Leave">
          <Input type="date" value={node.depart ?? ""} min={node.arrive || undefined} onChange={(e) => patch(trip.id, index, { depart: e.target.value || undefined })} />
        </Field>
      </div>

      <SectionHeader level={3} title="Somewhere to stay" meta={monthly ? "28 nights or more: monthly rentals too" : undefined} />
      <ul className="trips-itin-links" aria-label={`Search for a place to stay in ${node.name}`}>
        {links.map((l) => (
          <li key={l.site}>
            <a className="trips-ed-link" href={l.url} target="_blank" rel="noreferrer noopener" title={`Fills in ${l.prefills}`}>
              {l.label}
              <IconExternal size={12} />
              <span className="sr-only"> (opens in a new tab; fills in {l.prefills})</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="trips-itin-help">
        {checkIn && checkOut ? "The search opens with this stop's dates. " : "Set the dates above and the search opens with them. "}
        You book and pay there. Write the stay down here so it counts in the trip.
      </p>
      <div className="trips-itin-grid">
        <Field label="Name of the place" className="trips-itin-wide">
          <Input value={stay.name} maxLength={200} placeholder="Hotel, apartment or host" onChange={(e) => setLodging({ name: e.target.value })} />
        </Field>
        <Field label="Type" optional>
          <Select value={stay.kind} options={LODGING_KINDS} onChange={(e) => setLodging({ kind: e.target.value })} />
        </Field>
        <Field label="Address" optional>
          <Input value={stay.address} maxLength={300} onChange={(e) => setLodging({ address: e.target.value })} />
        </Field>
        <Field label="Check-in" optional hint={!stay.checkIn && node.arrive ? "Empty means the day you arrive." : undefined}>
          <Input type="date" value={stay.checkIn} onChange={(e) => setLodging({ checkIn: e.target.value })} />
        </Field>
        <Field label="Check-out" optional hint={!stay.checkOut && node.depart ? "Empty means the day you leave." : undefined}>
          <Input type="date" value={stay.checkOut} min={stay.checkIn || undefined} onChange={(e) => setLodging({ checkOut: e.target.value })} />
        </Field>
        <MoneyInput label="Price for the stay" value={stay.cost} onChange={(cost) => setLodging({ cost })} hint="The total, in the currency you pay." />
        <Field label="Booking reference" optional hint="Never shown on a shared link or in the calendar feed.">
          <Input value={stay.bookingRef} maxLength={80} onChange={(e) => setLodging({ bookingRef: e.target.value })} />
        </Field>
        <Field label="Link" optional className="trips-itin-wide" error={linkBad ? "Paste a full web address, starting with https://" : undefined}>
          <Input type="url" inputMode="url" value={stay.link} placeholder="https://" onChange={(e) => setLodging({ link: e.target.value })} />
        </Field>
      </div>
      {!stay.name.trim() && (stay.address || stay.bookingRef || stay.cost.amount || stay.link) ? (
        <p className="ui-field-error" role="alert">
          Give the place a name to save the stay.
        </p>
      ) : null}
      {node.lodging ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<IconTrash size={14} />}
          onClick={() => {
            setStay(lodgingDraft(undefined));
            patch(trip.id, index, { lodging: undefined });
          }}
        >
          Remove the stay
        </Button>
      ) : null}

      <Activities trip={trip} index={index} node={node} />

      <SectionHeader level={3} title="Notes" />
      <Field label={`Notes for ${node.name}`} hideLabel hint="Only you see these. They aren't part of a shared link.">
        <Textarea
          rows={4}
          maxLength={4000}
          defaultValue={node.notes ?? ""}
          onChange={(e) => patch(trip.id, index, { notes: e.target.value.trim() ? e.target.value : undefined })}
        />
      </Field>
    </Sheet>
  );
}

interface ActivityDraft {
  id: string;
  title: string;
  date: string;
  time: string;
  cost: MoneyDraftValue;
  link: string;
  note: string;
}

function activityDraft(a?: TripActivity): ActivityDraft {
  return {
    id: a?.id ?? newActivityId(),
    title: a?.title ?? "",
    date: a?.date ?? "",
    time: a?.time ?? "",
    cost: moneyDraft(a?.cost),
    link: a?.link ?? "",
    note: a?.note ?? "",
  };
}

function Activities({ trip, index, node }: { trip: Trip; index: number; node: TripNode }) {
  const list = node.activities ?? [];
  const [draft, setDraft] = useState<ActivityDraft | null>(null);
  const [error, setError] = useState("");

  const save = () => {
    if (!draft) return;
    const cost = moneyFromDraft(draft.cost);
    if (!draft.title.trim()) return setError("Give the activity a name.");
    if (cost === "invalid") return setError("Enter the cost as a number, or leave it empty.");
    if (draft.link.trim() && !cleanLink(draft.link)) return setError("Paste a full web address, starting with https://");
    const clean = cleanActivity({ ...draft, cost });
    if (!clean) return;
    const next = list.some((a) => a.id === clean.id) ? list.map((a) => (a.id === clean.id ? clean : a)) : [...list, clean];
    next.sort((x, y) => `${x.date ?? "9999"}T${x.time ?? "99"}`.localeCompare(`${y.date ?? "9999"}T${y.time ?? "99"}`));
    patch(trip.id, index, { activities: next });
    setDraft(null);
    setError("");
  };
  const remove = (id: string) => {
    const next = list.filter((a) => a.id !== id);
    patch(trip.id, index, { activities: next.length ? next : undefined });
    if (draft?.id === id) setDraft(null);
  };
  const set = (p: Partial<ActivityDraft>) => {
    setError("");
    setDraft((d) => (d ? { ...d, ...p } : d));
  };

  return (
    <>
      <SectionHeader
        level={3}
        title="Activities"
        meta={list.length ? String(list.length) : undefined}
        actions={
          draft ? null : (
            <Button size="sm" variant="ghost" icon={<IconPlus size={14} />} onClick={() => setDraft(activityDraft())}>
              Add
            </Button>
          )
        }
      />
      {list.length === 0 && !draft ? <p className="trips-itin-help">Nothing planned here yet. Add tours, tickets, dinners, anything with a day or a time.</p> : null}
      {list.length ? (
        <ul className="trips-itin-acts">
          {list.map((a) =>
            draft?.id === a.id ? null : (
              <li key={a.id} className="trips-itin-act">
                <div className="trips-itin-act-text">
                  <span className="trips-itin-act-title">{a.title}</span>
                  <span className="trips-itin-act-meta">
                    {[a.date ? formatDay(a.date, { year: false }) : "No day yet", a.time, a.cost ? `${a.cost.amount} ${a.cost.currency}` : ""].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {a.link ? (
                  <a className="trips-ed-link" href={a.link} target="_blank" rel="noreferrer noopener">
                    Link
                    <IconExternal size={12} />
                    <span className="sr-only"> for {a.title} (opens in a new tab)</span>
                  </a>
                ) : null}
                <IconButton label={`Edit ${a.title}`} icon={<IconEdit size={16} />} size="sm" onClick={() => setDraft(activityDraft(a))} />
                <IconButton label={`Remove ${a.title}`} icon={<IconTrash size={16} />} size="sm" onClick={() => remove(a.id)} />
              </li>
            )
          )}
        </ul>
      ) : null}
      {draft ? (
        <div className="trips-itin-actform">
          <div className="trips-itin-grid">
            <Field label="What" className="trips-itin-wide">
              <Input autoFocus value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="Day" optional>
              <Input type="date" value={draft.date} min={node.arrive || undefined} max={node.depart || undefined} onChange={(e) => set({ date: e.target.value })} />
            </Field>
            <Field label="Time" optional hint="Local time there.">
              <Input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
            </Field>
            <MoneyInput label="Cost" value={draft.cost} onChange={(cost) => set({ cost })} />
            <Field label="Link" optional>
              <Input type="url" inputMode="url" value={draft.link} placeholder="https://" onChange={(e) => set({ link: e.target.value })} />
            </Field>
            <Field label="Note" optional className="trips-itin-wide">
              <Textarea rows={2} maxLength={1000} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
            </Field>
          </div>
          {error ? (
            <p className="ui-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="trips-itin-foot">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={save}>
              {list.some((a) => a.id === draft.id) ? "Save activity" : "Add activity"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ── Itinerary card: problems and the day-by-day view ─────────────────

function groupWhen(g: DayGroup): string {
  return g.days === 1 ? formatDay(g.from, { year: false }) : `${formatDay(g.from, { weekday: false, year: false })} – ${formatDay(g.to, { weekday: false, year: false })}`;
}

export function Issues({ issues }: { issues: ItineraryIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="trips-itin-issues" aria-label="Problems with the dates">
      {issues.map((i, k) => (
        <li key={k} className={cx("trips-itin-issue", i.level === "error" && "is-error")}>
          <IconAlert size={16} />
          <span>
            <span className="sr-only">{i.level === "error" ? "Conflict: " : "Check: "}</span>
            {i.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Day-by-day view of the trip, with any date conflicts above it. */
export function ItineraryCard({ trip, route, cityIdx }: { trip: Trip; route: TripRoute; cityIdx: Map<string, City> }) {
  const issues = useMemo(() => validateItinerary(trip, route, (id) => cityIdx.get(id)?.timezone), [trip, route, cityIdx]);
  const { groups, undated } = useMemo(() => dayByDay(trip, route), [trip, route]);

  if (!trip.year) {
    return (
      <p className="trips-itin-help">
        This trip is a season you can take any year. Pick a year under Season and each stop gets dates, a place to stay, activities and a day-by-day plan.
      </p>
    );
  }
  if (trip.nodes.length === 0) return <p className="trips-itin-help">Add a stop to start the itinerary.</p>;

  return (
    <div className="trips-itin">
      <Issues issues={issues} />
      {groups.length === 0 ? (
        <p className="trips-itin-help">
          <IconCalendar size={14} /> No dates yet. Set when you arrive at and leave each stop in the route above.
        </p>
      ) : (
        <ol className="trips-itin-days">
          {groups.map((g) => (
            <li key={g.from} className={cx("trips-itin-day", g.items.length === 0 && "is-quiet")}>
              <span className="trips-itin-day-when tabular">{groupWhen(g)}</span>
              <div className="trips-itin-day-body">
                <span className="trips-itin-day-place">
                  {g.places.length ? g.places.join(" and ") : "On the way"}
                  {g.days > 1 ? <span className="trips-itin-day-count"> · {g.days} days</span> : null}
                </span>
                {g.items.length ? (
                  <ul className="trips-itin-items">
                    {g.items.map((it, k) => (
                      <li key={k} className="trips-itin-item">
                        <span className="trips-itin-item-time tabular">{it.time ?? ""}</span>
                        <span className="trips-itin-item-text">
                          {it.title}
                          {it.kind === "leg" ? (
                            it.booked ? (
                              <Badge tone="success">Booked</Badge>
                            ) : (
                              <Badge tone="neutral">Not booked</Badge>
                            )
                          ) : null}
                          {it.detail ? <span className="trips-itin-item-detail">{it.detail}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      {undated.length && groups.length ? (
        <p className="trips-itin-help">
          No dates yet for {undated.map((i) => trip.nodes[i].name).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}
