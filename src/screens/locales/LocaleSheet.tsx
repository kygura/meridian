import { useState } from "react";
import { Badge, Button, SectionHeader, Sheet, cx, toast } from "../../ui";
import { IconExternal, IconMap, IconPlus } from "../../ui/icons";
import { useMeridianStore } from "../../store";
import { useUIStore } from "../../shell/uiStore";
import { navigate } from "../../lib/router";
import { FIT_LABEL, placeFromCity, todayIso } from "../../lib/rotation";
import { monthName, spanLabel } from "../../lib/season";
import { METRIC_BY_ID, type MetricIndex } from "../../lib/cityMetrics";
import { HAZARD_WATCH, LOCALES, anchorOf, researchRanks, researchScore, stayFromLocale, weeksText, windowText, type LocaleScores } from "../../lib/locales";
import { useRotation } from "../rotation/useRotation";
import { LOCALE_METRICS, type LocaleView } from "./useLocaleData";

const ROLE_TEXT = {
  base: "Base · live here for weeks or months",
  hub: "Hub · a few days between bases",
  destination: "Destination · one visit in its window",
} as const;

const SCORE_LABEL: Record<keyof LocaleScores, string> = {
  climate: "Climate",
  air: "Air",
  cost: "Cost",
  safety: "Safety",
  health: "Healthcare",
  internet: "Internet",
  food: "Food",
  nomad: "Setting up",
  longstay: "Long stay",
};

const RANKS = researchRanks(LOCALES);
const ROLE_COUNT = (r: string) => LOCALES.filter((l) => l.role === r).length;

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

/**
 * One locale. Meridian's reading first (each month with its comfort, hazard and crowds; the
 * staying windows; the metric surfaces), then entry, then the field check (ADR 0024): its summary,
 * scores and rank, cost, caveats and sources. Its month ratings ride along and do not score.
 */
export function LocaleSheet({ view, metrics, unlocked, onClose }: LocaleSheetProps) {
  const { locale, year, windows, cap, hazards, events } = view;
  const cities = useMeridianStore((s) => s.cities);
  const openCity = useUIStore((s) => s.openCity);
  const putStay = useRotation((s) => s.putStay);
  const rotationLoaded = useRotation((s) => !!s.data);
  const [adding, setAdding] = useState(false);
  const anchor = cities.find((c) => c.id === anchorOf(locale));
  const extra = locale.cityIds.slice(1).map((id) => cities.find((c) => c.id === id)?.name ?? id);
  const disagreements = year.filter((m) => m.researchDiffers).length;

  const addToRotation = async (i: number) => {
    if (!anchor) return;
    setAdding(true);
    const ok = await putStay(stayFromLocale(locale, placeFromCity(anchor), windows[i], todayIso()));
    setAdding(false);
    if (ok) toast(`${locale.name} added to your rotation as an idea`, { tone: "success", action: { label: "Open", onClick: () => navigate("/rotation") } });
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

        <SectionHeader level={3} title="When to stay" meta={`Stay range ${weeksText({ min: locale.stay.minWeeks, max: locale.stay.maxWeeks })}`} />
        {windows.length ? (
          <ul className="loc-windows">
            {windows.map((w, i) => (
              <li key={i} className="loc-window">
                <div>
                  <strong>{windowText(w)}</strong>
                  <span className="loc-muted">
                    {" "}
                    · good from {spanLabel(w.run)} ({w.runMonths} {w.runMonths === 1 ? "month" : "months"}
                    {w.great ? `, ${w.great} great` : ""}){w.relative
                      ? ` · rarely comfortable here, but its Beauty (top ${Math.max(1, 100 - (view.beautyPct ?? 0))}% of cities) justifies its most tolerable months`
                      : w.fallback
                        ? " · only fair months"
                        : ""}
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
          <p className="loc-muted">No run of good months in Meridian’s data.</p>
        )}

        <SectionHeader
          level={3}
          title="Months"
          meta={`${anchor ? anchor.name : "Anchor city"}: Comfort Index, hazards, crowds${disagreements ? ` · field check differs in ${disagreements}` : ""}`}
        />
        <div className="loc-months" role="list">
          {year.map((m) => (
            <div key={m.month} className="loc-mrow" role="listitem">
              <span className={cx("loc-mrow-chip", `rotation-fit--${m.level}`, `rotation-fit--${m.level}`)}>{monthName(m.month)}</span>
              <span>
                <strong>{FIT_LABEL[m.level]}</strong>
                {m.source === "personal" && <span className="loc-muted"> · {m.why}</span>}
                {m.hazard && <span className="loc-muted"> · {m.hazard.label}</span>}
                {m.tourism === "high" && <span className="loc-muted"> · tourist peak</span>}
                {m.tourism === "shoulder" && <span className="loc-muted"> · tourist shoulder</span>}
                {m.research && (
                  <span className={cx("loc-mrow-note", m.researchDiffers && "loc-mrow-note--disagree")}>
                    Field check: {m.research.text}
                    {m.researchDiffers ? ` (${FIT_LABEL[m.research.level].toLowerCase()})` : ""}
                  </span>
                )}
              </span>
              <span className="loc-mrow-comfort" title="Comfort Index">
                {m.comfort ?? "–"}
              </span>
            </div>
          ))}
        </div>
        {hazards.some((h) => h.score >= HAZARD_WATCH) && (
          <p className="loc-muted">
            Seasonal hazards that lower months here: {hazards.filter((h) => h.score >= HAZARD_WATCH).slice(0, 3).map((h) => `${h.label} (${h.months.map((x) => monthName(x)).join(", ")}, ${h.km} km)`).join("; ")}.
          </p>
        )}

        <SectionHeader level={3} title="Metrics" meta={anchor ? `Meridian figures for ${anchor.name}` : undefined} />
        <div className="loc-metrics">
          {view.beauty !== null && (
            <div className="loc-metric" title={METRIC_BY_ID.get("beauty")!.basis}>
              <span className="loc-metric-label">Beauty</span>
              <span className="loc-metric-value">
                {Math.round(view.beauty)}
                {view.beautyPct !== null && <span className="loc-muted"> · top {Math.max(1, 100 - view.beautyPct)}%</span>}
              </span>
              <span className="loc-meter">
                <span style={{ width: `${view.beauty}%` }} />
              </span>
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

        {events.length > 0 && (
          <>
            <SectionHeader level={3} title="Worth timing" meta="Meridian’s live events" />
            <ul className="loc-events">
              {events.slice(0, 8).map((e) => (
                <li key={e.id}>
                  <span className="loc-muted">{(e.months ?? [e.month]).map((x) => monthName(x)).join("–")}</span> {e.title}
                </li>
              ))}
            </ul>
          </>
        )}

        {(locale.entry || cap) && <SectionHeader level={3} title="Entry" />}
        {cap && (
          <p>
            <strong>{ENTRY_TEXT[cap.status] ?? cap.status}</strong> on your {cap.passport} passport
            {cap.days ? `, ${cap.days} days` : cap.status === "home" || cap.status === "free-movement" ? ", no day limit" : ""}.
            <span className="loc-muted"> The Days page counts rolling windows such as Schengen.</span>
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

        <div className="loc-notes">
          <SectionHeader
            level={3}
            title="Field check"
            meta={`#${RANKS.get(locale.id)} of ${ROLE_COUNT(locale.role)} ${locale.role === "hub" ? "hubs" : `${locale.role}s`} · ${researchScore(locale).toFixed(1)} / 10`}
          />
          <p>{locale.summary}</p>
          <div className="loc-scores" aria-label="Field check scores, 1 to 10">
            {(Object.keys(SCORE_LABEL) as (keyof LocaleScores)[]).map((k) => (
              <span key={k}>
                <span className="loc-muted">{SCORE_LABEL[k]}</span> {locale.scores[k].toFixed(1)}
              </span>
            ))}
          </div>
          {locale.cost && (
            <p className="loc-muted">
              All-in cost: {locale.cost.currency === "EUR" ? "€" : `${locale.cost.currency} `}
              {locale.cost.min.toLocaleString()}–{locale.cost.max.toLocaleString()} per {locale.cost.per}
              {locale.cost.note ? ` (${locale.cost.note})` : ""}.
            </p>
          )}
          <p className="loc-muted">Stay {weeksText({ min: locale.stay.minWeeks, max: locale.stay.maxWeeks })}: {locale.stay.why}</p>
          {locale.caveats && <p className="loc-muted">Caveats: {locale.caveats}</p>}
          {locale.sources.length > 0 && (
            <p className="loc-sources-list">
              {locale.sources.slice(0, 8).map((u, i) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="loc-link">
                  {hostOf(u) || `Source ${i + 1}`}
                </a>
              ))}
            </p>
          )}
        </div>

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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
