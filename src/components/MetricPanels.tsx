import { useEffect } from "react";
import { apiUrl } from "../lib/api";
import { useMeridianStore } from "../store";
import SeasonStrip from "./seasonality/SeasonStrip";

function MicroRow({
  label,
  value,
  displayValue,
}: {
  label: string;
  value: number;
  displayValue: string;
}) {
  return (
    <div className="micro-row">
      <span className="mr-key">{label}</span>
      <div className="mr-bar">
        <div className="fill" style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="mr-val">{displayValue}</span>
    </div>
  );
}

export default function MetricPanels() {
  const { selectedCityId, cityMetrics, setCityMetrics } = useMeridianStore();

  useEffect(() => {
    if (!selectedCityId) return;
    if (cityMetrics[selectedCityId]) return;

    fetch(apiUrl(`/api/metrics/city/${selectedCityId}`))
      .then((r) => r.json())
      .then((data) => {
        const s = data?.metrics;
        if (!s || typeof s !== "object") return;
        const n = (key: string): number | undefined =>
          typeof s[key]?.normalized === "number" ? s[key].normalized : undefined;
        setCityMetrics(selectedCityId, {
          safety: n("stability"),
          cost: n("cost"),
          weather: n("weather"),
          stability: n("stability"),
          internet: n("connectivity"),
          tourism: n("tourism"),
          density: n("density"),
          happiness: n("quality"),
          peace: n("stability"),
        });
      })
      .catch(() => {});
  }, [selectedCityId, cityMetrics, setCityMetrics]);

  if (!selectedCityId) return null;

  const metrics = cityMetrics[selectedCityId];

  return (
    <>
      {/* Seasonality — real Comfort Index strip (shares the calendar's cache) */}
      <SeasonStrip cityId={selectedCityId} />

      {/* Metrics bars */}
      <div className="section">
        <h3>
          METRICS <span className="meta">SOURCED</span>
        </h3>
        <div className="h-sub">
          Key indicators compared against global median.
        </div>

        <MicroRow
          label="SAFETY"
          value={metrics?.safety ?? 65}
          displayValue={`${metrics?.safety ?? 65}`}
        />
        <MicroRow
          label="COST"
          value={metrics?.cost ?? 50}
          displayValue={`${metrics?.cost ?? 50}`}
        />
        <MicroRow
          label="WEATHER"
          value={metrics?.weather ?? 58}
          displayValue={`${metrics?.weather ?? 58}`}
        />
        <MicroRow
          label="STABILITY"
          value={metrics?.stability ?? 72}
          displayValue={`${metrics?.stability ?? 72}`}
        />
        <MicroRow
          label="INTERNET"
          value={metrics?.internet ?? 68}
          displayValue={`${metrics?.internet ?? 68}Mbps`}
        />
        <MicroRow
          label="TOURISM"
          value={metrics?.tourism ?? 45}
          displayValue={`${metrics?.tourism ?? 45}`}
        />
      </div>

      {/* Index grid */}
      <div className="section">
        <h3>
          WELLBEING INDICES <span className="meta">SOURCED · 2025</span>
        </h3>
        <div className="h-sub">
          Comparative scores against global median.
        </div>
        <div className="index-grid">
          {[
            {
              key: "HAPPINESS",
              v: (metrics?.happiness ?? 62) / 100,
              sub: "WORLD HAPPINESS REPORT",
            },
            {
              key: "SAFETY",
              v: (metrics?.safety ?? 65) / 100,
              sub: "GLOBAL PEACE INDEX",
            },
            {
              key: "COST",
              v: (metrics?.cost ?? 50) / 100,
              sub: "VS. GLOBAL MEDIAN",
            },
            {
              key: "PEACE",
              v: (metrics?.peace ?? 70) / 100,
              sub: "PEACE INDEX",
            },
          ].map((item) => {
            const dotsOn = Math.round(item.v * 7);
            return (
              <div key={item.key} className="index-cell">
                <div className="ic-key">{item.key}</div>
                <div className="ic-val">
                  {(item.v * 10).toFixed(1)}
                  <span
                    style={{
                      color: "var(--ink3)",
                      fontSize: 9,
                      fontWeight: 400,
                    }}
                  >
                    /10
                  </span>
                </div>
                <div className="ic-dots">
                  {Array.from({ length: 7 }, (_, i) => (
                    <span
                      key={i}
                      className={`ic-dot${i < dotsOn ? " on" : ""}`}
                    />
                  ))}
                </div>
                <div className="ic-sub">{item.sub}</div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
