import { useMemo, useState, type KeyboardEvent } from "react";
import { Page, PageHeader, SectionHeader, Segmented, Select, cx } from "../../ui";
import { FIT_LABEL, type FitLevel } from "../../lib/rotation";
import { monthName, spanHas } from "../../lib/season";
import {
  BEAUTY_UNLOCK,
  LOCALE_DATA,
  anchorOf,
  bestForMonth,
  fitRank,
  meanOf,
  researchScore,
  rangeSegments,
  spanSegments,
  weekRange,
  weeksText,
  windowText,
  type LocaleMonth,
  type LocaleRole,
  type Segment,
} from "../../lib/locales";
import { LOCALE_METRICS, useLocaleData, type LocaleView } from "./useLocaleData";
import { LocaleSheet } from "./LocaleSheet";
import "../rotation/rotation.css";
import "./locales.css";

type RoleFilter = "all" | LocaleRole;
type SortKey = "region" | "rank" | "meridian" | "beauty" | "cost" | "month";

export const ROLE_LABEL: Record<LocaleRole, string> = { base: "Base", hub: "Hub", destination: "Destination" };
const RAMP: FitLevel[] = ["avoid", "poor", "fair", "good", "great"];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
const segStyle = (g: Segment) => ({ left: pct(g.left), width: pct(g.width) });

/** The twelve months from this one: [{ month: 11, year: 2026 }, …]. */
function rollingMonths(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return Array.from({ length: 12 }, (_, i) => {
    const k = m - 1 + i;
    return { month: (k % 12) + 1, year: y + Math.floor(k / 12) };
  });
}

/** Today's place on a calendar that starts on the first of this month, 0–1. */
function todayX(now = new Date()): number {
  return (now.getDate() - 1) / MONTH_DAYS[now.getMonth()] / 12;
}

function monthTitle(month: number, f: LocaleMonth): string {
  const parts = [`${monthName(month, "long")}: ${FIT_LABEL[f.level]}`, f.why];
  if (f.tourism === "high") parts.push("tourist peak");
  if (f.research) parts.push(`field check: ${f.research.text}${f.researchDiffers ? " (differs)" : ""}`);
  return parts.join(" · ");
}

/**
 * Route #/locales. Bases, hubs and destinations on a rolling twelve-month timeline: each row
 * is the anchor city's fit through the year from Meridian's own data, with the ideal stay
 * bracketed, tourist peaks under it and hazards and events above (ADR 0022).
 */
export default function LocalesScreen() {
  const { views, metrics, unlocked, comfortLoaded, signedInVisa } = useLocaleData();
  const [role, setRole] = useState<RoleFilter>("all");
  const [sort, setSort] = useState<SortKey>("region");
  const [focus, setFocus] = useState<number>(new Date().getMonth() + 1);
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const months = useMemo(() => rollingMonths(), []);
  const start = months[0].month;
  const today = useMemo(() => todayX(), []);

  const score = (v: LocaleView) => meanOf(LOCALE_METRICS.map((m) => metrics[m]?.get(anchorOf(v.locale))));
  const afford = (v: LocaleView) => metrics.cost?.get(anchorOf(v.locale));

  const shown = useMemo(() => {
    const list = views.filter((v) => role === "all" || v.locale.role === role);
    const order = LOCALE_DATA.regions;
    const byName = (a: LocaleView, b: LocaleView) => a.locale.name.localeCompare(b.locale.name);
    const byScore = (a: LocaleView, b: LocaleView) => (score(b) ?? -1) - (score(a) ?? -1);
    switch (sort) {
      case "region":
        return [...list].sort((a, b) => order.indexOf(a.locale.region) - order.indexOf(b.locale.region) || byName(a, b));
      case "rank":
        return [...list].sort((a, b) => researchScore(b.locale) - researchScore(a.locale) || byName(a, b));
      case "meridian":
        return [...list].sort((a, b) => byScore(a, b) || byName(a, b));
      case "beauty":
        return [...list].sort((a, b) => (b.beauty ?? -1) - (a.beauty ?? -1) || byName(a, b));
      case "cost":
        return [...list].sort((a, b) => (afford(b) ?? -1) - (afford(a) ?? -1) || byName(a, b));
      case "month":
        return [...list].sort(
          (a, b) => monthRank(b, focus) - monthRank(a, focus) || (b.beauty ?? -1) - (a.beauty ?? -1) || byScore(a, b) || byName(a, b)
        );
    }
  }, [views, role, sort, focus, metrics]); // eslint-disable-line react-hooks/exhaustive-deps

  const years = useMemo(() => new Map(views.map((v) => [v.locale.id, v.year])), [views]);
  const beautyMap = useMemo(() => new Map(views.map((v) => [v.locale.id, v.beauty ?? 0])), [views]);
  const windowMap = useMemo(() => new Map(views.map((v) => [v.locale.id, v.windows])), [views]);
  const bases = useMemo(() => views.filter((v) => v.locale.role === "base").map((v) => v.locale), [views]);
  const openView = open ? views.find((v) => v.locale.id === open) : undefined;
  const focusIndex = months.findIndex((m) => m.month === focus);
  const hoverIndex = hover === null ? -1 : months.findIndex((m) => m.month === hover);
  const columnBand = (i: number) => ({ left: pct(i / 12), width: pct(1 / 12) });

  const pickMonth = (month: number) => {
    setFocus(month);
    setSort("month");
  };
  const onRowKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(id);
    }
  };

  let lastRegion = "";

  return (
    <Page width="wide">
      <PageHeader
        kicker="Residence · where life rotates"
        title="Locales"
        subtitle="Where to base yourself through the year, and for how long, from Meridian’s climate, air, hazard and crowd data."
      />

      <div className="loc-toolbar">
        <Segmented
          size="sm"
          label="Role"
          value={role}
          onChange={setRole}
          options={[
            { value: "all", label: "All" },
            { value: "base", label: "Bases" },
            { value: "hub", label: "Hubs" },
            { value: "destination", label: "Destinations" },
          ]}
        />
        <label className="loc-sort">
          <span>Sort</span>
          <Select
            size="sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            options={[
              { value: "region", label: "Region" },
              { value: "month", label: `Best in ${monthName(focus, "long")}` },
              { value: "rank", label: "Field check rank" },
              { value: "meridian", label: "Meridian score" },
              { value: "beauty", label: "Most beautiful" },
              { value: "cost", label: "Most affordable" },
            ]}
          />
        </label>
      </div>

      <section aria-labelledby="loc-cal" className="loc-section">
        <SectionHeader
          id="loc-cal"
          title="Calendar"
          meta={`${shown.length} locales · ${monthName(months[0].month)} ${months[0].year} – ${monthName(months[11].month)} ${months[11].year}`}
        />

        <div className="loc-cal" role="table" aria-label="Locales by month" onMouseLeave={() => setHover(null)}>
          <div className="loc-row loc-row--head" role="row">
            <div className="loc-name loc-name--head" role="columnheader">
              Locale
            </div>
            <div className="loc-axis" role="presentation">
              {months.map(({ month, year }, i) => (
                <button
                  key={i}
                  type="button"
                  role="columnheader"
                  aria-sort={sort === "month" && month === focus ? "descending" : undefined}
                  className={cx("loc-mhead", month === focus && "loc-mhead--focus", month === 1 && i > 0 && "loc-mhead--year")}
                  onClick={() => pickMonth(month)}
                  onMouseEnter={() => setHover(month)}
                  title={`Rank by ${monthName(month, "long")} ${year}`}
                >
                  <span className="loc-mhead-long">{monthName(month)}</span>
                  <span className="loc-mhead-short">{monthName(month).slice(0, 1)}</span>
                  {(i === 0 || month === 1) && <span className="loc-mhead-year">{year}</span>}
                </button>
              ))}
              <span className="loc-today-flag" style={{ left: pct(today) }}>
                Today
              </span>
            </div>
            <div className="loc-stay loc-stay--head" role="columnheader">
              Ideal stay
            </div>
          </div>

          {shown.map((v) => {
            const { locale, year, weeks, windows } = v;
            const main = windows[0];
            const header = sort === "region" && locale.region !== lastRegion ? locale.region : null;
            lastRegion = locale.region;
            const s = score(v);
            const hazardMonths = new Set(year.filter((f) => f.hazard).map((f) => f.month));
            const eventMonths = new Map<number, string[]>();
            for (const e of v.events) for (const m of e.months ?? [e.month]) eventMonths.set(m, [...(eventMonths.get(m) ?? []), e.title]);
            return (
              <div key={locale.id} className="loc-group" role="rowgroup">
                {header && (
                  <div className="loc-region" role="row">
                    <span role="cell">{header}</span>
                  </div>
                )}
                <div
                  className="loc-row loc-row--body"
                  role="row"
                  tabIndex={0}
                  aria-label={`${locale.name}, ${ROLE_LABEL[locale.role]}. ${main ? `Ideal stay ${windowText(main)}` : "No good stretch"}`}
                  onClick={() => setOpen(locale.id)}
                  onKeyDown={(e) => onRowKey(e, locale.id)}
                >
                  <div className="loc-name" role="rowheader">
                    <span className="loc-name-main">{locale.name}</span>
                    <span className="loc-name-sub">
                      <span className={cx("loc-role", `loc-role--${locale.role}`)}>{ROLE_LABEL[locale.role]}</span>
                      <span className="loc-name-country">{locale.country}</span>
                      {s !== null && (
                        <span className="loc-score" title="Meridian score: mean of quality of life, safety, healthcare, affordability and internet">
                          {s}
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="loc-track" role="cell">
                    {focusIndex >= 0 && <span className="loc-col loc-col--focus" style={columnBand(focusIndex)} aria-hidden="true" />}
                    {hoverIndex >= 0 && hoverIndex !== focusIndex && <span className="loc-col loc-col--hover" style={columnBand(hoverIndex)} aria-hidden="true" />}

                    <div className="loc-marks" aria-hidden="true">
                      {months.map(({ month }, i) =>
                        hazardMonths.has(month) || eventMonths.has(month) ? (
                          <span key={i} className="loc-mark-slot" style={columnBand(i)}>
                            {hazardMonths.has(month) && <span className="loc-hazard" title={year[month - 1].hazard?.label} />}
                            {eventMonths.has(month) && <span className="loc-event" title={eventMonths.get(month)!.join(", ")} />}
                          </span>
                        ) : null
                      )}
                    </div>

                    <div className="loc-strip">
                      {weeks &&
                        weeks.map((lvl, w) =>
                          rangeSegments([weekRange(w)], start).map((g, j) => (
                            <span key={`${w}-${j}`} className={cx("loc-seg", `rotation-fit--${lvl}`, `rotation-fit--${lvl}`)} style={segStyle(g)} />
                          ))
                        )}
                      {months.map(({ month }, i) => {
                        const f = year[month - 1];
                        return (
                          <span
                            key={i}
                            className={cx("loc-month", weeks ? "loc-month--overlay" : [`rotation-fit--${f.level}`, `rotation-fit--${f.level}`].join(" "))}
                            style={columnBand(i)}
                            title={monthTitle(month, f)}
                            onMouseEnter={() => setHover(month)}
                          />
                        );
                      })}
                      {main &&
                        spanSegments(main.stay, start).map((g, j) => <span key={j} className={cx("loc-ideal", main.relative && "loc-ideal--relative")} style={segStyle(g)} aria-hidden="true" />)}
                      <span className="loc-today" style={{ left: pct(today) }} aria-hidden="true" />
                    </div>

                    <div className="loc-crowd" aria-hidden="true">
                      {months.map(({ month }, i) => {
                        const t = year[month - 1].tourism;
                        return t && t !== "low" ? <span key={i} className={cx("loc-crowd-seg", `loc-crowd-seg--${t}`)} style={columnBand(i)} /> : null;
                      })}
                    </div>
                  </div>

                  <div className="loc-stay" role="cell">
                    {main ? (
                      <>
                        <span className="loc-stay-weeks">{weeksText(main.weeks)}</span>
                        <span className="loc-stay-when">
                          {monthName(main.stay.start)}
                          {main.stay.end !== main.stay.start ? `–${monthName(main.stay.end)}` : ""}
                          {main.capped && <span className="loc-stay-cap"> · visa</span>}
                          {main.relative && <span className="loc-stay-rel">worth it for its beauty</span>}
                        </span>
                      </>
                    ) : (
                      <span className="loc-muted">{comfortLoaded ? "No good stretch" : "…"}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="loc-legend" aria-label="Legend">
          <span className="loc-legend-item">
            <span className="loc-legend-ramp">
              {RAMP.map((l) => (
                <span key={l} className={cx("loc-legend-swatch", `rotation-fit--${l}`, `rotation-fit--${l}`)} title={FIT_LABEL[l]} />
              ))}
            </span>
            Avoid → great
          </span>
          <span className="loc-legend-item">
            <span className="loc-legend-ideal" />
            Ideal stay
          </span>
          <span className="loc-legend-item">
            <span className="loc-legend-ideal loc-ideal--relative" />
            Worth it for its beauty: most tolerable months
          </span>
          <span className="loc-legend-item">
            <span className="loc-legend-crowd" />
            Tourist peak
          </span>
          <span className="loc-legend-item">
            <span className="loc-hazard loc-hazard--static" />
            Seasonal hazard
          </span>
          <span className="loc-legend-item">
            <span className="loc-event loc-event--static" />
            Event
          </span>
        </div>
        <p className="loc-note">
          Fit is the anchor city’s Comfort Index (temperature, rain, air), weekly where Meridian has weekly normals, lowered in
          months a seasonal hazard reaches it. A place in Meridian’s top {100 - BEAUTY_UNLOCK}% for Beauty that is never
          comfortable gets a base window on its most tolerable months, drawn dashed{unlocked ? "; your rotation’s own windows come first" : ""}. Tourist peaks are
          measured visitor nights. Stay lengths are cut to the run of good months
          {signedInVisa ? " and your passport’s day limit" : "; sign in to cut them to your passport’s day limit"}. The field
          check’s month ratings and rank are in each locale, not in the fit.{!comfortLoaded && " Climate data is loading."}
        </p>
      </section>

      <section aria-labelledby="loc-where" className="loc-section">
        <SectionHeader id="loc-where" title="Where to base yourself" meta="Top three bases each month" />
        <div className="loc-where">
          {months.map(({ month, year }, i) => {
            const picks = bestForMonth(bases, years, month, { beauty: beautyMap, windows: windowMap }).slice(0, 3);
            const worth = views
              .filter((x) => x.locale.role === "base" && x.windows.some((w) => w.relative && spanHas(w.run, month)) && !picks.some((p) => p.locale.id === x.locale.id))
              .sort((a, b) => (b.beauty ?? 0) - (a.beauty ?? 0))[0];
            return (
              <div key={i} className={cx("loc-where-month", month === focus && "loc-where-month--focus")}>
                <button type="button" className="loc-where-head" onClick={() => pickMonth(month)}>
                  {monthName(month)} <span className="loc-muted">{year}</span>
                </button>
                <ol>
                  {picks.map((p) => (
                    <li key={p.locale.id}>
                      <button type="button" onClick={() => setOpen(p.locale.id)} title={p.fit.why}>
                        <span className={cx("rotation-swatch", `rotation-fit--${p.fit.level}`, `rotation-fit--${p.fit.level}`)} />
                        {p.locale.name}
                      </button>
                    </li>
                  ))}
                </ol>
                {worth && (
                  <div className="loc-where-worth">
                    <span className="loc-where-worth-label">Worth it for its beauty</span>
                    <button type="button" onClick={() => setOpen(worth.locale.id)} title="Rarely comfortable, but in Meridian’s top 15% for Beauty">
                      <span className="loc-swatch-dashed" />
                      {worth.locale.name}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <p className="loc-note loc-sources">
        {roleCount(views)} Field check {LOCALE_DATA.checked}: each place verified against current sources and ranked within its role. Fit, climate, air, hazards, crowds and metrics are Meridian’s own.
      </p>

      {openView && <LocaleSheet view={openView} metrics={metrics} unlocked={unlocked} onClose={() => setOpen(null)} />}
    </Page>
  );
}

/** Fit of a month for ranking: a month inside a "worth it" window counts as fair. */
function monthRank(v: LocaleView, month: number): number {
  const worth = v.windows.some((w) => w.relative && spanHas(w.run, month));
  return Math.max(fitRank(v.year[month - 1].level), worth ? fitRank("fair") : -1);
}

function roleCount(views: LocaleView[]): string {
  const n = (r: LocaleRole) => views.filter((v) => v.locale.role === r).length;
  return `${n("base")} bases, ${n("hub")} hubs, ${n("destination")} destinations.`;
}
