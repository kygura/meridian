import { useMemo, useState } from "react";
import { Page, PageHeader, SectionHeader, Segmented, Select, cx } from "../../ui";
import { FIT_LABEL, type FitLevel } from "../../lib/rotation";
import { monthName, spanMonths } from "../../lib/season";
import {
  LOCALE_DATA,
  anchorOf,
  bestForMonth,
  fitRank,
  meanOf,
  weeksText,
  type LocaleRole,
} from "../../lib/locales";
import { LOCALE_METRICS, useLocaleData, type LocaleView } from "./useLocaleData";
import { LocaleSheet } from "./LocaleSheet";
import "../rotation/rotation.css";
import "./locales.css";

type RoleFilter = "all" | LocaleRole;
type SortKey = "region" | "score" | "meridian" | "month";

export const ROLE_LABEL: Record<LocaleRole, string> = { base: "Base", hub: "Hub", destination: "Destination" };
const LEVELS: FitLevel[] = ["great", "good", "fair", "poor", "avoid", "unknown"];

/** The twelve months from this one: [{ month: 11, year: 2026 }, …]. */
function rollingMonths(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return Array.from({ length: 12 }, (_, i) => {
    const k = m - 1 + i;
    return { month: (k % 12) + 1, year: y + Math.floor(k / 12) };
  });
}

/**
 * Route #/locales. The researched home bases, hubs and destinations on a rolling
 * twelve-month calendar: each month's fit and the ideal staying window (ADR 0022).
 */
export default function LocalesScreen() {
  const { views, metrics, unlocked, comfortLoaded, signedInVisa } = useLocaleData();
  const [role, setRole] = useState<RoleFilter>("all");
  const [sort, setSort] = useState<SortKey>("region");
  const [focus, setFocus] = useState<number>(new Date().getMonth() + 1);
  const [open, setOpen] = useState<string | null>(null);
  const months = useMemo(() => rollingMonths(), []);

  const meridianScore = (v: LocaleView) => {
    const id = anchorOf(v.locale);
    return meanOf(LOCALE_METRICS.map((m) => metrics[m]?.get(id)));
  };

  const shown = useMemo(() => {
    const list = views.filter((v) => role === "all" || v.locale.role === role);
    const order = LOCALE_DATA.regions;
    const byName = (a: LocaleView, b: LocaleView) => a.locale.name.localeCompare(b.locale.name);
    switch (sort) {
      case "region":
        return [...list].sort((a, b) => order.indexOf(a.locale.region) - order.indexOf(b.locale.region) || (b.locale.scores?.overall ?? 0) - (a.locale.scores?.overall ?? 0) || byName(a, b));
      case "score":
        return [...list].sort((a, b) => (b.locale.scores?.overall ?? -1) - (a.locale.scores?.overall ?? -1) || byName(a, b));
      case "meridian":
        return [...list].sort((a, b) => (meridianScore(b) ?? -1) - (meridianScore(a) ?? -1) || byName(a, b));
      case "month":
        return [...list].sort((a, b) => fitRank(b.year[focus - 1].level) - fitRank(a.year[focus - 1].level) || (b.locale.scores?.overall ?? 0) - (a.locale.scores?.overall ?? 0) || byName(a, b));
    }
  }, [views, role, sort, focus, metrics]);

  const years = useMemo(() => new Map(views.map((v) => [v.locale.id, v.year])), [views]);
  const bases = useMemo(() => views.filter((v) => v.locale.role === "base").map((v) => v.locale), [views]);
  const openView = open ? views.find((v) => v.locale.id === open) : undefined;

  let lastRegion = "";

  return (
    <Page width="wide">
      <PageHeader
        kicker="Residence · where life rotates"
        title="Locales"
        subtitle="Researched bases, hubs and destinations, with the months to be there and how long to stay."
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
              { value: "score", label: "Your research score" },
              { value: "meridian", label: "Meridian metrics" },
              { value: "month", label: `Best in ${monthName(focus, "long")}` },
            ]}
          />
        </label>
      </div>

      <section aria-labelledby="loc-cal">
        <SectionHeader
          id="loc-cal"
          title="Calendar"
          meta={`${shown.length} locales · ${months[0].year === months[11].year ? months[0].year : `${monthName(months[0].month)} ${months[0].year} – ${monthName(months[11].month)} ${months[11].year}`}`}
        />
        <div className="loc-cal" role="table" aria-label="Locales by month">
          <div className="loc-row loc-row--head" role="row">
            <div className="loc-name" role="columnheader">
              Locale
            </div>
            {months.map(({ month, year }, i) => (
              <button
                key={i}
                type="button"
                role="columnheader"
                className={cx("loc-mhead", month === focus && "loc-mhead--focus", month === 1 && i > 0 && "loc-mhead--year")}
                onClick={() => {
                  setFocus(month);
                  setSort("month");
                }}
                title={`Sort by ${monthName(month, "long")} ${year}`}
              >
                <span className="loc-mhead-long">{monthName(month)}</span>
                <span className="loc-mhead-short">{monthName(month).slice(0, 1)}</span>
                {(i === 0 || month === 1) && <span className="loc-mhead-year">’{String(year).slice(2)}</span>}
              </button>
            ))}
            <div className="loc-stay" role="columnheader">
              Stay
            </div>
          </div>

          {shown.map((v) => {
            const { locale, year, windows } = v;
            const main = windows[0];
            const ideal = new Set(main ? spanMonths(main.stay) : []);
            const runs = new Set(windows.flatMap((w) => spanMonths(w.run)));
            const header = sort === "region" && locale.region !== lastRegion ? locale.region : null;
            lastRegion = locale.region;
            return (
              <div key={locale.id} className="loc-group" role="rowgroup">
                {header && (
                  <div className="loc-region" role="row">
                    <span role="cell">{header}</span>
                  </div>
                )}
                <div className="loc-row" role="row">
                  <button type="button" className="loc-name" role="rowheader" onClick={() => setOpen(locale.id)}>
                    <span className="loc-name-main">{locale.name}</span>
                    <span className="loc-name-sub">
                      <span className={cx("loc-role", `loc-role--${locale.role}`)}>{ROLE_LABEL[locale.role]}</span>
                      {locale.country}
                      {locale.scores && <span className="loc-score">{locale.scores.overall.toFixed(1)}</span>}
                    </span>
                  </button>
                  {months.map(({ month }, i) => {
                    const f = year[month - 1];
                    const ev = locale.events?.filter((e) => e.month === month) ?? [];
                    const isIdeal = ideal.has(month);
                    const inRun = runs.has(month);
                    const prevIdeal = i > 0 && ideal.has(months[i - 1].month);
                    const nextIdeal = i < 11 && ideal.has(months[i + 1].month);
                    return (
                      <button
                        key={i}
                        type="button"
                        role="cell"
                        className={cx("loc-cell", `rotation-fit--${f.level}`, `rotation-fit--${f.level}`, month === focus && "loc-cell--focus")}
                        title={`${monthName(month, "long")}: ${FIT_LABEL[f.level]}. ${f.why}${f.comfort !== undefined ? ` · Comfort ${f.comfort}` : ""}${f.disagrees ? " (comfort disagrees)" : ""}${ev.length ? ` · ${ev.map((e) => e.name).join(", ")}` : ""}${isIdeal ? " · ideal stay" : ""}`}
                        onClick={() => setOpen(locale.id)}
                      >
                        {f.source === "personal" && <span className="loc-mark loc-mark--personal" aria-hidden="true" />}
                        {f.disagrees && <span className="loc-mark loc-mark--disagree" aria-hidden="true" />}
                        {ev.length > 0 && <span className="loc-ev" aria-hidden="true" />}
                        {inRun && !isIdeal && <span className="loc-run" aria-hidden="true" />}
                        {isIdeal && <span className={cx("loc-bar", !prevIdeal && "loc-bar--start", !nextIdeal && "loc-bar--end")} aria-hidden="true" />}
                      </button>
                    );
                  })}
                  <div className="loc-stay" role="cell">
                    {main ? (
                      <>
                        <span className="loc-stay-weeks">{weeksText(main.weeks)}</span>
                        {main.capped && <span className="loc-stay-cap">visa cap</span>}
                      </>
                    ) : (
                      <span className="loc-muted">—</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="loc-legend" aria-label="Legend">
          {LEVELS.map((l) => (
            <span key={l} className="loc-legend-item">
              <span className={cx("rotation-swatch", `rotation-fit--${l}`, `rotation-fit--${l}`)} />
              {FIT_LABEL[l]}
            </span>
          ))}
          <span className="loc-legend-item">
            <span className="loc-legend-bar" />
            Ideal stay
          </span>
          <span className="loc-legend-item">
            <span className="loc-legend-run" />
            Other good months
          </span>
          <span className="loc-legend-item">
            <span className="loc-ev loc-ev--static" />
            Worth timing
          </span>
          <span className="loc-legend-item">
            <span className="loc-mark loc-mark--disagree loc-mark--static" />
            Comfort Index disagrees
          </span>
          {unlocked && (
            <span className="loc-legend-item">
              <span className="loc-mark loc-mark--personal loc-mark--static" />
              Your own window
            </span>
          )}
        </div>
        <p className="loc-note">
          Each month reads {unlocked ? "your own windows first, then " : ""}the research, then the Comfort Index where the research is silent.
          {!comfortLoaded && " Comfort is still loading."} Stay lengths are the research’s, cut to the good months
          {signedInVisa ? " and your passport’s day limit." : "; sign in to cut them to your passport’s day limit."}
        </p>
      </section>

      <section aria-labelledby="loc-where">
        <SectionHeader id="loc-where" title="Where to base yourself" meta="Top three bases each month" />
        <div className="loc-where">
          {months.map(({ month, year }, i) => {
            const picks = bestForMonth(bases, years, month).slice(0, 3);
            return (
              <div key={i} className={cx("loc-where-month", month === focus && "loc-where-month--focus")}>
                <div className="loc-where-head">
                  {monthName(month)} <span className="loc-muted">{year}</span>
                </div>
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
              </div>
            );
          })}
        </div>
      </section>

      <p className="loc-note loc-sources">
        Research checked {LOCALE_DATA.checked}. Sources: {LOCALE_DATA.sources.join(", ")}.{" "}
        {roleCount(views)}
      </p>

      {openView && <LocaleSheet view={openView} metrics={metrics} unlocked={unlocked} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function roleCount(views: LocaleView[]): string {
  const n = (r: LocaleRole) => views.filter((v) => v.locale.role === r).length;
  return `${n("base")} bases, ${n("hub")} hubs, ${n("destination")} destinations.`;
}
