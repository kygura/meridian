import { useMeridianStore } from "../store";
import type { LayerKey } from "../types";

const LAYER_DEFS: { key: LayerKey; label: string; glyph: string }[] = [
  { key: "routes", label: "ROUTES", glyph: "line" },
  { key: "cities", label: "CITIES", glyph: "dot" },
  { key: "weather", label: "WEATHER", glyph: "ring" },
  { key: "stability", label: "STABILITY", glyph: "dot" },
  { key: "density", label: "DENSITY", glyph: "ring" },
  { key: "tourism", label: "TOURISM", glyph: "dot" },
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
    setActiveTrip,
    addTrip,
    setCommandOpen,
  } = useMeridianStore();

  const activeTrip = trips.find((t) => t.id === activeTripId);

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

        {/* Trip switcher buttons */}
        {trips.map((trip) => (
          <button
            key={trip.id}
            onClick={() => setActiveTrip(trip.id)}
            style={{
              padding: "4px 10px",
              border:
                trip.id === activeTripId
                  ? "1px solid var(--ink)"
                  : "1px solid var(--hairline2)",
              background:
                trip.id === activeTripId ? "var(--ink)" : "transparent",
              color: trip.id === activeTripId ? "var(--bg)" : "var(--ink2)",
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            {trip.name.slice(0, 8)}
          </button>
        ))}

        <button
          onClick={() => {
            const id = `trip-${Date.now()}`;
            addTrip({
              id,
              name: `TRIP ${trips.length + 1}`,
              color: (["a", "b", "c"] as const)[trips.length % 3],
              status: "draft",
              nodes: [],
            });
            setActiveTrip(id);
          }}
          style={{
            padding: "4px 10px",
            border: "1px dashed var(--hairline2)",
            background: "transparent",
            color: "var(--ink3)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: "0.12em",
            cursor: "pointer",
          }}
        >
          + NEW
        </button>

        <button
          onClick={() => setCommandOpen(true)}
          style={{
            padding: "4px 10px",
            border: "1px solid var(--ink)",
            background: "var(--ink)",
            color: "var(--bg)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: "0.12em",
            cursor: "pointer",
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          title="Open command console"
        >
          ADD CITY <span style={{ opacity: 0.6 }}>⌘K</span>
        </button>
      </div>
    </div>
  );
}
