import { useEffect, useMemo, useState } from "react";
import { JournalApiError, JournalLockedError, JournalNetworkError, createWatch, refreshJourneys } from "../../../lib/journalApi";
import { DEFAULT_CONTROLS, buildQuery } from "../../../lib/replayQuery";
import type { WatchPrefill } from "../../../lib/watchPrefill";
import { useMeridianStore } from "../../../store";
import type { City, Journey, ReplayQuery, Watch, WatchPriceRule } from "../../../types";
import { Button, Chip, CitySearch, EmptyState, ErrorState, Field, Input, Select, Sheet, Skeleton, cx } from "../../../ui";
import { IconTrips } from "../../../ui/icons";
import { MONTH_NAMES, querySentence } from "./watchText";
import "./watches.css";

type Rule = "below_my_median" | "deal_low" | "max";

function saveError(e: unknown): string {
  if (e instanceof JournalLockedError) return "Your journal is locked. Unlock it in Settings and try again.";
  if (e instanceof JournalNetworkError) return "Couldn't reach the server. Try again.";
  if (e instanceof JournalApiError) {
    if (e.code === "too_many_watches") return "You have the most watches allowed. Delete one to add another.";
    if (e.status === 400) return "Those settings weren't accepted. Check them and try again.";
  }
  return "Couldn't save the watch. Try again.";
}

function journeyOption(j: Journey): string {
  const [y, m] = j.startDate.split("-").map(Number);
  return `${j.title} · ${MONTH_NAMES[m - 1]?.slice(0, 3) ?? ""} ${y}`;
}

export interface WatchSheetProps {
  open: boolean;
  onClose: () => void;
  onSaved: (w: Watch) => void;
  /**
   * Save a ready-made query (for example from Repeat a trip). Without it the sheet asks
   * which past trip to match.
   */
  preset?: { label: string; query: ReplayQuery };
  /** Hand-off from the city panel or a past trip: a city to limit to, and/or the trip to match. */
  prefill?: WatchPrefill | null;
}

/** Add a watch. Exported so other Plan tabs can reuse it with a preset query. */
export default function WatchSheet({ open, onClose, onSaved, preset, prefill }: WatchSheetProps) {
  return open ? <WatchSheetBody onClose={onClose} onSaved={onSaved} preset={preset} prefill={prefill} /> : null;
}

function WatchSheetBody({ onClose, onSaved, preset, prefill }: Omit<WatchSheetProps, "open">) {
  const journeys = useMeridianStore((s) => s.journeys);
  const cities = useMeridianStore((s) => s.cities);
  const cityIdx = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);
  const [journeysError, setJourneysError] = useState(false);

  const sortedJourneys = useMemo(
    () => (journeys ? [...journeys].filter((j) => j.stops.length > 0).sort((a, b) => b.startDate.localeCompare(a.startDate)) : null),
    [journeys]
  );

  const [journeyId, setJourneyId] = useState<string>(prefill?.journeyId ?? "");
  const [stop, setStop] = useState<string>(prefill?.stopIndex !== undefined ? String(prefill.stopIndex) : "all");
  const [onlyCity, setOnlyCity] = useState<City | null>(() => (prefill?.cityId ? cityIdx.get(prefill.cityId) ?? null : null));
  const [months, setMonths] = useState<number[]>([]);
  const [from, setFrom] = useState<City | null>(null);
  const [leadFrom, setLeadFrom] = useState("6");
  const [leadTo, setLeadTo] = useState("14");
  const [rule, setRule] = useState<Rule>("below_my_median");
  const [max, setMax] = useState("");
  const [label, setLabel] = useState(preset?.label.slice(0, 120) ?? "");
  const [labelTouched, setLabelTouched] = useState(!!preset);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadJourneys = () => {
    setJourneysError(false);
    refreshJourneys().catch((e) => {
      if (!(e instanceof JournalLockedError)) setJourneysError(true);
    });
  };

  useEffect(() => {
    if (!preset && journeys === null) loadJourneys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default to the most recent trip.
  useEffect(() => {
    if (!journeyId && sortedJourneys?.length) setJourneyId(sortedJourneys[0].id);
  }, [journeyId, sortedJourneys]);

  const journey = sortedJourneys?.find((j) => j.id === journeyId);
  const stopIndex = stop === "all" ? null : Number(stop);

  const query: ReplayQuery | null = useMemo(() => {
    if (preset) return preset.query;
    if (!journey) return null;
    const q = buildQuery({ ...DEFAULT_CONTROLS, months, fromCityId: from?.id ?? null }, { journeyId: journey.id, stopIndex });
    return onlyCity ? { ...q, constraints: { ...q.constraints, cityIds: [onlyCity.id] } } : q;
  }, [preset, journey, months, from, stopIndex, onlyCity]);

  // Suggest a name until the person types their own.
  useEffect(() => {
    if (labelTouched) return;
    if (onlyCity) {
      setLabel(`Fares to ${onlyCity.name}`.slice(0, 120));
      return;
    }
    if (!journey) return;
    const s = stopIndex !== null ? cityIdx.get(journey.stops[stopIndex]?.cityId ?? "")?.name : undefined;
    setLabel(`Places like ${s ?? journey.title}`.slice(0, 120));
  }, [labelTouched, journey, stopIndex, cityIdx, onlyCity]);

  const f = Number(leadFrom);
  const t = Number(leadTo);
  const leadOk = Number.isInteger(f) && Number.isInteger(t) && f >= 1 && t <= 52 && f < t;
  const maxOk = rule !== "max" || (Number(max) > 0 && Number.isFinite(Number(max)));
  const labelOk = label.trim().length > 0;
  const valid = !!query && leadOk && maxOk && labelOk;

  const save = async () => {
    setTried(true);
    if (!valid || !query || saving) return;
    setSaving(true);
    setError(null);
    const priceRule: WatchPriceRule = rule === "max" ? { maxEur: Number(max) } : rule;
    try {
      onSaved(await createWatch({ label: label.trim(), query, leadWeeks: [f, t], priceRule }));
    } catch (e) {
      setError(saveError(e));
      setSaving(false);
    }
  };

  const toggleMonth = (m: number) => setMonths((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]));

  const needsTrip = !preset;
  const noTrips = needsTrip && sortedJourneys !== null && sortedJourneys.length === 0;

  let body;
  if (needsTrip && sortedJourneys === null) {
    body = journeysError ? (
      <ErrorState message="Couldn't load your past trips." onRetry={loadJourneys} />
    ) : (
      <div className="plan-watches-form" aria-busy="true">
        <Skeleton height={40} />
        <Skeleton height={40} />
        <Skeleton height={80} />
      </div>
    );
  } else if (noTrips) {
    body = (
      <EmptyState
        icon={<IconTrips />}
        title="Log a trip first"
        description="A watch looks for fares to places like ones you've loved. Log a past trip to start."
        action={
          <Button
            onClick={() => {
              onClose();
              useMeridianStore.getState().openQuickLog();
            }}
          >
            Log a trip
          </Button>
        }
      />
    );
  } else {
    body = (
      <form
        className="plan-watches-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        noValidate
      >
        {needsTrip && sortedJourneys ? (
          <div className="plan-watches-row2">
            <Field label="Like this trip">
              <Select
                data-autofocus
                value={journeyId}
                onChange={(e) => {
                  setJourneyId(e.target.value);
                  setStop("all");
                }}
                options={sortedJourneys.map((j) => ({ value: j.id, label: journeyOption(j) }))}
              />
            </Field>
            <Field label="Match">
              <Select
                value={stop}
                onChange={(e) => setStop(e.target.value)}
                options={[
                  { value: "all", label: "The whole trip" },
                  ...(journey?.stops ?? []).map((s, i) => ({ value: String(i), label: cityIdx.get(s.cityId)?.name ?? `Stop ${i + 1}` })),
                ]}
              />
            </Field>
          </div>
        ) : null}

        {needsTrip ? (
          <fieldset className="plan-watches-fieldset">
            <legend className="ui-field-label">
              When<span className="ui-field-optional"> (optional)</span>
            </legend>
            <div className="plan-watches-months" role="group" aria-label="Months">
              {MONTH_NAMES.map((name, i) => (
                <Chip key={name} selected={months.includes(i + 1)} onClick={() => toggleMonth(i + 1)} aria-label={name}>
                  {name.slice(0, 3)}
                </Chip>
              ))}
            </div>
            <p className="ui-field-hint">Leave empty to look around the month you went.</p>
          </fieldset>
        ) : null}

        {needsTrip && onlyCity ? (
          <Field label="Destination" hint="Only fares to this city are checked.">
            <span className="plan-watches-picked">
              <span className="plan-watches-picked-name">{onlyCity.name}</span>
              {onlyCity.iata ? <span className="iata muted">{onlyCity.iata}</span> : null}
              <Button size="sm" variant="ghost" onClick={() => setOnlyCity(null)}>
                Any place
              </Button>
            </span>
          </Field>
        ) : null}

        {needsTrip ? (
          <Field label="Flying from" optional hint={from ? undefined : "Leave empty to use your home airport."}>
            {from ? (
              <span className="plan-watches-picked">
                <span className="plan-watches-picked-name">{from.name}</span>
                {from.iata ? <span className="iata muted">{from.iata}</span> : null}
                <Button size="sm" variant="ghost" onClick={() => setFrom(null)}>
                  Change
                </Button>
              </span>
            ) : (
              <CitySearch placeholder="City or airport" onPick={setFrom} />
            )}
          </Field>
        ) : null}

        <fieldset className="plan-watches-fieldset">
          <legend className="ui-field-label">Departing</legend>
          <div className="plan-watches-lead">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={52}
              aria-label="From this many weeks ahead"
              aria-invalid={!leadOk || undefined}
              value={leadFrom}
              onChange={(e) => setLeadFrom(e.target.value)}
            />
            <span className="muted">to</span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={52}
              aria-label="To this many weeks ahead"
              aria-invalid={!leadOk || undefined}
              value={leadTo}
              onChange={(e) => setLeadTo(e.target.value)}
            />
            <span className="muted">weeks from now</span>
          </div>
          {!leadOk ? (
            <p className="ui-field-error" role="alert">
              Use 1 to 52 weeks, with the first number smaller.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="plan-watches-fieldset">
          <legend className="ui-field-label">Alert me when the fare is</legend>
          <div className="plan-watches-rules">
            {(
              [
                ["below_my_median", "Below what I usually pay"],
                ["deal_low", "Marked as a low fare by the provider"],
                ["max", "Under a price I set"],
              ] as const
            ).map(([value, text]) => (
              <label key={value} className={cx("plan-watches-rule", rule === value && "is-checked")}>
                <input type="radio" name="plan-watches-rule" checked={rule === value} onChange={() => setRule(value)} />
                <span>{text}</span>
              </label>
            ))}
          </div>
          {rule === "max" ? (
            <Field label="Maximum price in euros" error={tried && !maxOk ? "Enter an amount above zero." : undefined} className="plan-watches-max">
              <Input type="number" inputMode="numeric" min={1} icon={<span className="plan-watches-eur">€</span>} value={max} onChange={(e) => setMax(e.target.value)} />
            </Field>
          ) : null}
        </fieldset>

        <Field label="Name" error={tried && !labelOk ? "Give the watch a name." : undefined}>
          <Input
            value={label}
            maxLength={120}
            onChange={(e) => {
              setLabel(e.target.value);
              setLabelTouched(true);
            }}
          />
        </Field>

        {query ? <p className="plan-watches-summary muted">{querySentence(query, cityIdx, journeys)}</p> : null}
        {error ? (
          <p className="ui-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Add watch"
      description="Meridian checks fares every day and tells you when one is worth booking."
      size="md"
      footer={
        noTrips || (needsTrip && sortedJourneys === null) ? undefined : (
          <div className="plan-watches-sheet-foot">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save watch
            </Button>
          </div>
        )
      }
    >
      {body}
    </Sheet>
  );
}
