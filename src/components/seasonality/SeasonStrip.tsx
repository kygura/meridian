import { useEffect, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import { fetchCitySeasonality } from "../../lib/seasonalityApi";
import {
  heatClass,
  comfortBin,
  bestWindow,
  isMonthInWindow,
  formatBestSpan,
  MONTH_INITIALS,
  MONTH_ABBR,
} from "../../lib/seasonality";
import HeatTooltip, { type HeatTooltipData } from "./HeatTooltip";
import "../../styles/seasonality.css";

/**
 * Real, data-backed seasonality mini-strip for the right drawer
 * (DESIGN-heatmap.md §6). Shares the store cache with SeasonalityPage
 * and the exact §2 heat encoding — a faithful thumbnail of the calendar row.
 */
export default function SeasonStrip({ cityId }: { cityId: string }) {
  const months = useMeridianStore((s) => s.seasonality[cityId]);
  const setSeasonality = useMeridianStore((s) => s.setSeasonality);
  const cities = useMeridianStore((s) => s.cities);
  const [unavailable, setUnavailable] = useState(false);
  const [tooltip, setTooltip] = useState<{
    anchor: DOMRect;
    data: HeatTooltipData;
  } | null>(null);

  useEffect(() => {
    setUnavailable(false);
    if (months !== undefined) return;
    let cancelled = false;
    fetchCitySeasonality(cityId)
      .then((m) => {
        if (!cancelled) setSeasonality(cityId, m);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId]);

  const nowMonth = new Date().getMonth();
  const cityName = cities.find((c) => c.id === cityId)?.name ?? "";
  const loading = months === undefined && !unavailable;
  const covered = Array.isArray(months);
  const window = covered ? bestWindow(months) : null;
  const peakScore =
    covered && window ? months[window.peakMonth]!.score : undefined;

  return (
    <div className="section season-strip">
      <h3>
        SEASONALITY <span className="meta">COMFORT INDEX</span>
      </h3>
      <div className="h-sub">
        Monthly comfort across the year. Deeper = better. Ridge marks now.
      </div>
      <div className="seasonality">
        {Array.from({ length: 12 }, (_, i) => {
          if (loading) {
            return <div key={i} className="month-cell skeleton" />;
          }
          if (!covered) {
            return (
              <div key={i} className="month-cell heat-na" title="NOT IN DATASET">
                <div className="mc-letter">{MONTH_INITIALS[i]}</div>
              </div>
            );
          }
          const m = months[i]!;
          const inWindow = isMonthInWindow(window, i);
          const classes = [
            "month-cell",
            heatClass(m.score),
            i === nowMonth ? "now" : "",
            inWindow ? "is-best" : "",
            inWindow && window?.startMonth === i ? "best-start" : "",
            inWindow && window?.endMonth === i ? "best-end" : "",
            inWindow && window?.peakMonth === i ? "best-peak" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={i}
              className={classes}
              onMouseEnter={(e) =>
                setTooltip({
                  anchor: e.currentTarget.getBoundingClientRect(),
                  data: {
                    title: `${cityName.toUpperCase()} · ${MONTH_ABBR[i]}`,
                    score: m.score,
                    tempC: m.tempC,
                    precipMm: m.precipMm,
                  },
                })
              }
              onMouseLeave={() => setTooltip(null)}
            >
              <div className="mc-letter">{MONTH_INITIALS[i]}</div>
            </div>
          );
        })}
      </div>

      <div className="strip-summary">
        {covered && window ? (
          <>
            <span className="ss-best">
              BEST
              <span
                className={`span peak-b${comfortBin(peakScore ?? 0)}`}
              >
                {formatBestSpan(window)}
              </span>
            </span>
            <button className="tm-action-btn" onClick={() => navigate("/seasons")}>
              FULL CALENDAR ↗
            </button>
          </>
        ) : loading ? (
          <span className="agent-brief-loading">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <span className="ss-nodata">NO SEASONALITY DATA</span>
        )}
      </div>

      {tooltip && <HeatTooltip anchor={tooltip.anchor} data={tooltip.data} />}
    </div>
  );
}
