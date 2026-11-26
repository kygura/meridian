import { useState } from "react";
import { Badge, Button, SectionHeader, Sheet, cx, toast } from "../../ui";
import { IconExternal, IconMap, IconPlus } from "../../ui/icons";
import { useMeridianStore } from "../../store";
import { useUIStore } from "../../shell/uiStore";
import { navigate } from "../../lib/router";
import { FIT_LABEL, placeFromCity } from "../../lib/rotation";
import { monthName, spanLabel } from "../../lib/season";
import { METRIC_BY_ID, type MetricIndex } from "../../lib/cityMetrics";
import { RESEARCH_LABEL, anchorOf, stayFromLocale, weeksText, windowText, type LocaleScores } from "../../lib/locales";
import { todayIso } from "../../lib/rotation";
import { useRotation } from "../rotation/useRotation";
import { LOCALE_METRICS, type LocaleView } from "./useLocaleData";

const ROLE_TEXT = {
  base: "Base · live here for weeks or months",
  hub: "Hub · a few days between bases",
  destination: "Destination · one visit in its window",
} as const;

const SCORE_LABEL: Record<keyof LocaleScores, string> = {
  climate: "Climate",
  health: "Health",
  food: "Food",
  cost: "Cost",
  connect: "Connectivity",
  safe: "Safety",
  qol: "Quality of life",
  overall: "Overall",
};

const ENTRY_TEXT: Record<string, string> = {
  home: "Your own passport",
  "free-movement": "Free movement",
  "visa-free": "Visa free",
  "visa-on-arrival": "Visa on arrival",
  eta: "Travel authorisation (ETA)",
  "e-visa": "E-visa",
  "visa-required": "Visa before travel",
  "no-admission": "No entry",
  unknown: "No data",
};

export interface LocaleSheetProps {
  view: LocaleView;
  metrics: MetricIndex;
  unlocked: boolean;
  onClose: () => void;
}

/** One locale: its months and why, the staying windows, the owner's scores beside Meridian's, entry and timing. */
export function LocaleSheet({ view, metrics, unlocked, onClose }: LocaleSheetProps) {
  const { locale, year, windows, cap } = view;
  const cities = useMeridianStore((s) => s.cities);
  const openCity = useUIStore((s) => s.openCity);
  const putStay = useRotation((s) => s.putStay);
  const rotationLoaded = useRotation((s) => !!s.data);
  const [adding, setAdding] = useState(false);
  const anchor = cities.find((c) => c.id === anchorOf(locale));
  const extra = locale.cityIds.slice(1).map((id) => cities.find((c) => c.id === id)?.name ?? id);

  const addToRotation = async (i: number) => {
    if (!anchor) return;
    setAdding(true);
    const stay = stayFromLocale(locale, placeFromCity(anchor), windows[i], todayIso());
    const ok = await putStay(stay);
    setAdding(false);
    if (ok) {
      toast(`${locale.name} added to your rotation as an idea`, { tone: "success", action: { label: "Open", onClick: () => navigate("/rotation") } });
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      size="lg"
      title={locale.name}
      description={`${locale.country}${locale.area ? ` · ${locale.area}` : ""}`}
      headerExtra={<Badge tone={locale.role === "base" ? "success" : locale.role === "hub" ? "neutral" : "accent"}>{locale.role}</Badge>}
    >
      <div className="loc-sheet">
        <p className="loc-sheet-role">{ROLE_TEXT[locale.role]}</p>
        <p>{locale.summary}</p>

        <SectionHeader level={3} title="Months" meta={view.profile ? "Your windows override the research" : "Research first, Comfort Index where silent"} />
        <div className="loc-months" role="list">
          {year.map((m) => (
            <div key={m.month} className="loc-month" role="listitem">
              <span className={cx("loc-month-chip", `rotation-fit--${m.level}`, `rotation-fit--${m.level}`)}>{monthName(m.month)}</span>
              <span className="loc-month-why">
                <strong>{m.source === "research" ? RESEARCH_LABEL[locale.months[m.month - 1]] : FIT_LABEL[m.level]}</strong>
                {m.why && m.why !== RESEARCH_LABEL[locale.months[m.month - 1]] ? ` · ${m.why}` : ""}
                {m.source === "personal" && <em> (yours)</em>}
              </span>
              <span className={cx("loc-month-comfort", m.disagrees && "loc-month-comfort--disagree")} title="Comfort Index of the anchor city">
                {m.comfort !== undefined ? m.comfort : "–"}
              </span>
            </div>
          ))}
        </div>

        <SectionHeader level={3} title="When to stay" meta={`Research range ${weeksText({ min: locale.stay.minWeeks, max: locale.stay.maxWeeks })}`} />
        <p className="loc-muted">{locale.stay.why}</p>
        {windows.length ? (
          <ul className="loc-windows">
            {windows.map((w, i) => (
              <li key={i} className="loc-window">
                <div>
                  <strong>{windowText(w)}</strong>
                  <span className="loc-muted">
                    {" "}
                    · good from {spanLabel(w.run)} ({w.runMonths} {w.runMonths === 1 ? "month" : "months"}
                    {w.great ? `, ${w.great} best` : ""}){w.fallback ? " · only fair months" : ""}
                    {w.capped && cap?.days ? ` · cut to ${cap.days} days by entry rules` : ""}
                  </span>
                </div>
                {unlocked && rotationLoaded && anchor && (
                  <Button size="sm" variant={i === 0 ? "secondary" : "ghost"} icon={<IconPlus size={14} />} disabled={adding} onClick={() => void addToRotation(i)}>
                    Add to rotation
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="loc-muted">No run of good months; nothing to recommend.</p>
        )}

        <SectionHeader level={3} title="Metrics" meta={anchor ? `Meridian figures for ${anchor.name}` : undefined} />
        <div className="loc-metrics">
          {locale.cost && (
            <div className="loc-metric">
              <span className="loc-metric-label">Cost</span>
              <span className="loc-metric-value">
                {locale.cost.currency === "EUR" ? "€" : `${locale.cost.currency} `}
                {locale.cost.min.toLocaleString()}–{locale.cost.max.toLocaleString()}
              </span>
              <span className="loc-muted">per {locale.cost.per}{locale.cost.note ? ` · ${locale.cost.note}` : ""}</span>
            </div>
          )}
          {LOCALE_METRICS.map((id) => {
            const v = metrics[id]?.get(anchorOf(locale));
            const def = METRIC_BY_ID.get(id)!;
            return (
              <div key={id} className="loc-metric" title={def.basis}>
                <span className="loc-metric-label">{def.label}</span>
                <span className="loc-metric-value">{v === undefined ? "–" : Math.round(v)}</span>
                <span className="loc-meter">
                  <span style={{ width: `${v ?? 0}%` }} />
                </span>
              </div>
            );
          })}
        </div>
        {locale.scores && (
          <div className="loc-scores" aria-label="Your research scores, 1 to 10">
            {(Object.keys(SCORE_LABEL) as (keyof LocaleScores)[]).map((k) => (
              <span key={k} className={cx("loc-score-item", k === "overall" && "loc-score-item--overall")}>
                <span className="loc-muted">{SCORE_LABEL[k]}</span> {locale.scores![k].toFixed(1)}
              </span>
            ))}
          </div>
        )}
        {locale.asymmetry && <p className="loc-muted">#{locale.asymmetry} in your asymmetry ranking (price against quality).</p>}

        {(locale.entry || cap) && <SectionHeader level={3} title="Entry" />}
        {cap && (
          <p>
            <strong>{ENTRY_TEXT[cap.status] ?? cap.status}</strong> on your {cap.passport} passport
            {cap.days ? `, ${cap.days} days` : cap.status === "home" || cap.status === "free-movement" ? ", no day limit" : ""}.
            <span className="loc-muted"> Check the Days page for rolling windows such as Schengen.</span>
          </p>
        )}
        {locale.entry && (
          <p>
            {locale.entry.summary}{" "}
            <a href={locale.entry.source} target="_blank" rel="noreferrer" className="loc-link">
              Source <IconExternal size={12} />
            </a>{" "}
            <span className="loc-muted">checked {locale.entry.checked}</span>
          </p>
        )}

        {locale.corrections && (
          <>
            <SectionHeader level={3} title="Corrections to the notes" />
            <p className="loc-muted">{locale.corrections}</p>
          </>
        )}

        {locale.events?.length ? (
          <>
            <SectionHeader level={3} title="Worth timing" />
            <ul className="loc-events">
              {locale.events.map((e, i) => (
                <li key={i}>
                  <span className="loc-muted">{monthName(e.month)}</span> {e.name}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="loc-sheet-actions">
          {anchor && (
            <Button size="sm" variant="ghost" icon={<IconMap size={14} />} onClick={() => openCity(anchor.id)}>
              {anchor.name} on the map
            </Button>
          )}
          {extra.length > 0 && <span className="loc-muted">Also covers {extra.join(", ")}.</span>}
          {locale.leadWeeks && (
            <span className="loc-muted">
              Book {locale.leadWeeks.min}–{locale.leadWeeks.max} weeks ahead.
            </span>
          )}
          {locale.airport && <span className="loc-muted">Airport {locale.airport}.</span>}
        </div>
      </div>
    </Sheet>
  );
}
