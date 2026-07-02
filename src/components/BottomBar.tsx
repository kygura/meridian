import { useMeridianStore } from "../store";
import type { LayerKey } from "../types";

const LAYER_DEFS: { key: LayerKey; label: string; glyph: string }[] = [
  { key: "routes", label: "ROUTES", glyph: "line" },
  { key: "cities", label: "CITIES", glyph: "dot" },
  { key: "weather", label: "WEATHER", glyph: "ring" },
  { key: "cost", label: "COST", glyph: "diamond" },
  { key: "conflict", label: "CONFLICT", glyph: "dot" },
  { key: "disaster", label: "DISASTER", glyph: "diamond" },
];

export default function BottomBar() {
  const {
    layers,
    toggleLayer,
    trips,
    activeTripId,
    setCommandOpen,
    setTripsOverlayOpen,
    setCandidatesOverlayOpen,
  } = useMeridianStore();

  const activeTrip = trips.find((t) => t.id === activeTripId);
  const savedTripCount = trips.filter((t) => t.origin !== "agent").length;

  return (
    <div
      style={{
        gridArea: "bottom",
        borderTop: "1px solid var(--hairline2)",
        background: "var(--bg)",
        display: "flex",
        alignItems: "stretch",
        padding: "0 18px",
        zIndex: 10,
      }}
    >
      {/* Label */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 16px 0 0",
          borderRight: "1px solid var(--hairline)",
          height: "100%",
        }}
      >
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.18em",
            color: "var(--ink3)",
            fontFamily: "var(--mono)",
          }}
        >
          DATA LAYERS
        </span>
      </div>

      {/* Layer toggles */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 16px",
          borderRight: "1px solid var(--hairline)",
          height: "100%",
          overflow: "auto",
        }}
      >
        {LAYER_DEFS.map(({ key, label, glyph }) => (
          <div
            key={key}
            className={`layer-toggle ${layers[key] ? "on" : ""}`}
            onClick={() => toggleLayer(key)}
          >
            <span className={`lt-glyph ${glyph}`} />
            {label}
          </div>
        ))}
      </div>

      {/* Trip inspector */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 0 0 16px",
          height: "100%",
          marginLeft: "auto",
        }}
      >
        {activeTrip && (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.02em",
              color: "var(--ink)",
            }}
          >
            {activeTrip.nodes.map((n, i) => (
              <span key={i}>
                {n.iata || "???"}
                {i < activeTrip.nodes.length - 1 && (
                  <span
                    style={{
                      color: "var(--ink4)",
                      margin: "0 4px",
                      fontWeight: 400,
                    }}
                  >
                    →
                  </span>
                )}
              </span>
            ))}
          </span>
        )}

        <button
          className="bb-terminal-btn"
          onClick={() => setTripsOverlayOpen(true)}
          title="Open saved trips"
        >
          TRIPS <span style={{ opacity: 0.6 }}>{savedTripCount}</span>
        </button>

        <button
          className="bb-terminal-btn"
          onClick={() => setCandidatesOverlayOpen(true)}
          title="Browse trip candidates"
        >
          CANDIDATES <span style={{ opacity: 0.6 }}>✈</span>
        </button>

        <button
          className="bb-terminal-btn"
          onClick={() => setCommandOpen(true)}
          title="Open command console"
        >
          OPEN TERMINAL <span style={{ opacity: 0.6 }}>⌘K</span>
        </button>
      </div>
    </div>
  );
}
