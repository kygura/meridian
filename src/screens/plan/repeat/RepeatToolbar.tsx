import { useRef, useState, type ReactNode } from "react";
import { saveSettings } from "../../../lib/journalApi";
import {
  DEFAULT_CONTROLS,
  DEFAULT_WEIGHTS,
  WEIGHT_KEYS,
  scorableWeights,
  weightShares,
  type ReplayControls as Controls,
  type WeightKey,
} from "../../../lib/replayQuery";
import {
  MONTH_NAMES,
  budgetLabel,
  crowdLabel,
  monthName,
  monthsBetween,
  rangeLabel,
  rangeOfMonths,
  shiftLabel,
  shiftMonthBy,
  tempLabel,
} from "../../../lib/repeatCopy";
import { Button, Chip, CitySearch, Field, Popover, Segmented, Select, Sheet, cx, toast, SectionHeader } from "../../../ui";
import { IconChevronDown, IconFilter } from "../../../ui/icons";
import type { City, Fingerprint, ReplayResponse } from "../../../types";
import { BendSlider } from "./BendSlider";

const WEIGHT_WORDS: Record<WeightKey, string> = { climate: "Climate", spend: "Budget", crowd: "Crowds", flight: "Flight cost" };
// Region names the server understands for replay constraints.
const REGIONS: { value: string; label: string }[] = [
  { value: "europe", label: "Europe" },
  { value: "asia", label: "Asia" },
  { value: "africa", label: "Africa" },
  { value: "latin america", label: "Latin America" },
  { value: "equator", label: "Near the equator" },
];
// Distinct tags in data/events.json (the client has no events endpoint to ask).
const EVENT_TAGS: { value: string; label: string }[] = [
  { value: "festival", label: "Festivals" },
  { value: "carnival", label: "Carnival" },
  { value: "music", label: "Music" },
  { value: "arts", label: "Arts" },
  { value: "culture", label: "Culture" },
  { value: "sport", label: "Sport" },
  { value: "marathon", label: "Marathons" },
  { value: "nature", label: "Nature" },
  { value: "cherry-blossom", label: "Cherry blossom" },
  { value: "eclipse", label: "Eclipses" },
  { value: "oktoberfest", label: "Oktoberfest" },
  { value: "day-of-the-dead", label: "Day of the Dead" },
  { value: "holi", label: "Holi" },
  { value: "songkran", label: "Songkran" },
  { value: "lanterns", label: "Lanterns" },
  { value: "winter", label: "Winter" },
];
const FLIGHT_HOURS = [3, 6, 9, 12, 16];

const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** A toolbar button that opens a small popover with one control. */
function FilterPop({ label, value, set, children }: { label: string; value: string; set: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchor}
        className={cx("plan-repeat-filter", set && "is-set")}
        iconRight={<IconChevronDown size={16} />}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="plan-repeat-filter-k">{label}</span>
        <span className="plan-repeat-filter-v">{value}</span>
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} label={label} className="plan-repeat-pop">
        {children}
      </Popover>
    </>
  );
}

export interface RepeatToolbarProps {
  controls: Controls;
  onChange: (c: Controls) => void;
  /** 1-based month of the trip (or stop). */
  baseMonth: number | undefined;
  fingerprint: Fingerprint | undefined;
  templateClimate: ReplayResponse["templateClimate"];
  /** Origin the server used for prices (home unless changed). */
  fromCity: City | undefined;
}

/** Compact controls: temperature, when, budget, crowds, and the rest under "More filters". */
export function RepeatToolbar({ controls, onChange, baseMonth, fingerprint, templateClimate, fromCity }: RepeatToolbarProps) {
  const [more, setMore] = useState(false);
  const set = (p: Partial<Controls>) => onChange({ ...controls, ...p });
  const scorable = scorableWeights(fingerprint, templateClimate);
  const shares = weightShares(controls.weights, scorable);
  const range = rangeOfMonths(controls.months);

  const whenValue = controls.months.length
    ? range
      ? rangeLabel(range)
      : `${controls.months.length} months`
    : controls.anyMonth
      ? "Any month"
      : baseMonth
        ? monthName(shiftMonthBy(baseMonth, controls.monthShift))
        : shiftLabel(controls.monthShift, false, undefined);

  const moreCount =
    (controls.excludeVisited ? 1 : 0) +
    (controls.maxFlightHours !== null ? 1 : 0) +
    (controls.fromCityId ? 1 : 0) +
    controls.regions.length +
    controls.tags.length +
    (WEIGHT_KEYS.some((k) => controls.weights[k] !== DEFAULT_WEIGHTS[k]) ? 1 : 0);

  const changed =
    controls.tempC !== 0 ||
    controls.spendPct !== 0 ||
    controls.crowd !== 0 ||
    controls.monthShift !== 0 ||
    controls.anyMonth ||
    controls.months.length > 0 ||
    controls.resolution !== "month" ||
    moreCount > 0;

  const [homeSaving, setHomeSaving] = useState(false);
  const makeHome = async (cityId: string) => {
    setHomeSaving(true);
    try {
      await saveSettings({ homeCityId: cityId });
      set({ fromCityId: null });
      toast("Home city saved", { tone: "success" });
    } catch {
      toast("Couldn't save your home city", { tone: "danger" });
    } finally {
      setHomeSaving(false);
    }
  };

  const monthOptions = MONTH_NAMES.map((m, i) => ({ value: String(i + 1), label: m }));

  return (
    <div className="plan-repeat-toolbar" role="group" aria-label="Adjust the search">
      <FilterPop label="Temperature" value={controls.tempC === 0 ? "Same" : tempLabel(controls.tempC)} set={controls.tempC !== 0}>
        <BendSlider label="Temperature" value={controls.tempC} min={-10} max={10} step={1} readout={tempLabel(controls.tempC)} onChange={(v) => set({ tempC: v })} />
      </FilterPop>

      <FilterPop
        label="When"
        value={controls.resolution === "week" ? `${whenValue}, by week` : whenValue}
        set={controls.monthShift !== 0 || controls.anyMonth || controls.months.length > 0 || controls.resolution === "week"}
      >
        <div className="plan-repeat-popstack">
          <Segmented<"month" | "week">
            label="Match by"
            size="sm"
            value={controls.resolution}
            onChange={(resolution) => set({ resolution })}
            options={[
              { value: "month", label: "Month" },
              { value: "week", label: "Week" },
            ]}
          />
          {controls.resolution === "week" && (
            <p className="plan-repeat-hint">Places with week-by-week climate are matched to the week; the rest are matched by month.</p>
          )}
          <BendSlider
            label="Compared with your trip"
            value={controls.monthShift}
            min={-6}
            max={6}
            step={1}
            disabled={controls.anyMonth}
            readout={shiftLabel(controls.monthShift, controls.anyMonth, baseMonth)}
            onChange={(v) => set({ monthShift: v })}
          />
          <label className="plan-repeat-check">
            <input type="checkbox" checked={controls.anyMonth} onChange={(e) => set({ anyMonth: e.target.checked })} />
            Any month of the year
          </label>
          <div className="plan-repeat-range">
            <Field label="Only from">
              <Select
                value={range ? String(range.from) : ""}
                onChange={(e) => {
                  const from = Number(e.target.value);
                  if (!from) return set({ months: [] });
                  set({ months: monthsBetween(from, range?.to ?? from) });
                }}
                options={[{ value: "", label: "Any" }, ...monthOptions]}
              />
            </Field>
            <Field label="To">
              <Select
                value={range ? String(range.to) : ""}
                disabled={!range}
                onChange={(e) => range && set({ months: monthsBetween(range.from, Number(e.target.value)) })}
                options={range ? monthOptions : [{ value: "", label: "Any" }]}
              />
            </Field>
          </div>
        </div>
      </FilterPop>

      <FilterPop label="Budget" value={controls.spendPct === 0 ? "Same" : budgetLabel(controls.spendPct)} set={controls.spendPct !== 0}>
        <BendSlider
          label="Daily spend"
          value={controls.spendPct}
          min={-50}
          max={50}
          step={5}
          disabled={!scorable.spend}
          readout={budgetLabel(controls.spendPct)}
          hint={!scorable.spend ? "Add costs to this trip to compare budgets." : undefined}
          onChange={(v) => set({ spendPct: v })}
        />
      </FilterPop>

      <FilterPop label="Crowds" value={controls.crowd === 0 ? "Same" : crowdLabel(controls.crowd)} set={controls.crowd !== 0}>
        <BendSlider
          label="Crowds"
          value={controls.crowd}
          min={-50}
          max={50}
          step={5}
          disabled={!scorable.crowd}
          readout={crowdLabel(controls.crowd)}
          hint={!scorable.crowd ? "Crowds for this trip are still being worked out." : undefined}
          onChange={(v) => set({ crowd: v })}
        />
      </FilterPop>

      <Button className={cx("plan-repeat-filter", moreCount > 0 && "is-set")} icon={<IconFilter size={16} />} onClick={() => setMore(true)}>
        More filters{moreCount > 0 ? ` (${moreCount})` : ""}
      </Button>

      {changed && (
        <Button variant="ghost" onClick={() => onChange({ ...DEFAULT_CONTROLS })}>
          Reset
        </Button>
      )}

      <Sheet
        open={more}
        onClose={() => setMore(false)}
        title="More filters"
        size="md"
        footer={
          <div className="plan-repeat-sheet-foot">
            <Button
              variant="ghost"
              onClick={() =>
                set({
                  weights: DEFAULT_WEIGHTS,
                  excludeVisited: false,
                  maxFlightHours: null,
                  fromCityId: null,
                  regions: [],
                  tags: [],
                })
              }
            >
              Clear
            </Button>
            <Button variant="primary" onClick={() => setMore(false)}>
              Done
            </Button>
          </div>
        }
      >
        <div className="plan-repeat-form">
          <section className="plan-repeat-section">
            <SectionHeader level={3} title="What matters most" />
            {WEIGHT_KEYS.map((k) => (
              <BendSlider
                key={k}
                label={WEIGHT_WORDS[k]}
                value={controls.weights[k]}
                min={0}
                max={1}
                step={0.05}
                centered={false}
                disabled={shares[k] === null}
                readout={shares[k] === null ? "Not compared" : `${shares[k]}%`}
                onChange={(v) => set({ weights: { ...controls.weights, [k]: v } })}
              />
            ))}
          </section>

          <section className="plan-repeat-section">
            <SectionHeader level={3} title="Limits" />
            <label className="plan-repeat-check">
              <input type="checkbox" checked={controls.excludeVisited} onChange={(e) => set({ excludeVisited: e.target.checked })} />
              Only places I haven't been
            </label>
            <Field label="Longest flight">
              <Select
                value={controls.maxFlightHours === null ? "" : String(controls.maxFlightHours)}
                onChange={(e) => set({ maxFlightHours: e.target.value === "" ? null : Number(e.target.value) })}
                options={[{ value: "", label: "Any length" }, ...FLIGHT_HOURS.map((h) => ({ value: String(h), label: `Up to ${h} hours` }))]}
              />
            </Field>
            <Field
              label="Flying from"
              hint={
                fromCity
                  ? controls.fromCityId
                    ? `Prices from ${fromCity.name} for this search.`
                    : `Prices from ${fromCity.name}, your home city.`
                  : "No home city set, so there are no prices."
              }
            >
              <CitySearch placeholder="Change where you fly from" onPick={(c) => set({ fromCityId: c.id })} />
            </Field>
            {controls.fromCityId && (
              <div className="plan-repeat-inline-actions">
                <Button variant="ghost" size="sm" onClick={() => set({ fromCityId: null })}>
                  Use my home city
                </Button>
                <Button variant="ghost" size="sm" loading={homeSaving} onClick={() => void makeHome(controls.fromCityId!)}>
                  Make this my home city
                </Button>
              </div>
            )}
          </section>

          <section className="plan-repeat-section">
            <SectionHeader level={3} title="Regions" />
            <div className="plan-repeat-chips">
              {REGIONS.map((r) => (
                <Chip key={r.value} selected={controls.regions.includes(r.value)} onClick={() => set({ regions: toggle(controls.regions, r.value) })}>
                  {r.label}
                </Chip>
              ))}
            </div>
          </section>

          <section className="plan-repeat-section">
            <SectionHeader level={3} title="Happening while you're there" />
            <div className="plan-repeat-chips">
              {EVENT_TAGS.map((t) => (
                <Chip key={t.value} selected={controls.tags.includes(t.value)} onClick={() => set({ tags: toggle(controls.tags, t.value) })}>
                  {t.label}
                </Chip>
              ))}
            </div>
          </section>
        </div>
      </Sheet>
    </div>
  );
}
