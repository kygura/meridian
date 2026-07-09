import { COMFORT_LABELS } from "../../lib/seasonality";

/** The ramp swatches + best-window key + NOW key (DESIGN-heatmap.md §3.2). */
export default function HeatLegend() {
  return (
    <div className="heat-legend">
      <span className="hl-label">COMFORT</span>
      <span className="hl-cap">LOW ——→</span>
      <div className="hl-swatches">
        {COMFORT_LABELS.map((word, bin) => (
          <div key={word} className="hl-sw">
            <div className="block" style={{ background: `var(--heat-b${bin})` }} />
            <div className="word">{word}</div>
          </div>
        ))}
      </div>
      <span className="hl-cap">HIGH</span>

      <div className="hl-sep" />

      <div className="hl-key">
        <div
          className="block"
          style={{
            background: "var(--heat-b4)",
            boxShadow: "inset 0 0 0 1.5px var(--heat-best)",
          }}
        />
        <span>BEST WINDOW</span>
      </div>

      <div className="hl-key">
        <div className="hl-now-tri" />
        <span>NOW · CURRENT MONTH</span>
      </div>
    </div>
  );
}
