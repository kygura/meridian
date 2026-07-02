import { useMeridianStore } from "../store";

export default function LeftDrawer() {
  const {
    leftDrawerOpen,
    toggleLeftDrawer,
    shortlist,
    selectCity,
    setCommandOpen,
    trips,
    setTripsOverlayOpen,
    setCandidatesOverlayOpen,
  } = useMeridianStore();

  const savedTripCount = trips.filter((t) => t.origin !== "agent").length;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`drawer-backdrop ${leftDrawerOpen ? "open" : ""}`}
        onClick={toggleLeftDrawer}
      />

      {/* Drawer */}
      <div className={`drawer-left ${leftDrawerOpen ? "open" : ""}`}>
        {/* Shortlist section */}
        <div className="panel-head">
          <div className="h-title">SHORTLIST</div>
          <div className="h-meta">
            {shortlist.length} {shortlist.length === 1 ? "CITY" : "CITIES"}
          </div>
        </div>
        <div className="panel-sub">Cities flagged for opportunity research.</div>

        <div className="saved-list">
          {shortlist.map((entry) => (
            <div
              key={entry.cityId}
              className="saved-row"
              onClick={() => {
                selectCity(entry.cityId);
                toggleLeftDrawer();
              }}
            >
              <div>
                <div className="sr-iata">{entry.iata || "—"}</div>
              </div>
              <div>
                <div className="sr-city">{entry.name}</div>
                <div className="sr-country">{entry.country}</div>
              </div>
              <div>
                {entry.score != null ? (
                  <span className="sr-pill">{Math.round(entry.score)}</span>
                ) : null}
              </div>
            </div>
          ))}
          {shortlist.length === 0 && (
            <div
              style={{
                fontFamily: "var(--display)",
                fontStyle: "italic",
                fontSize: 14,
                color: "var(--ink3)",
                padding: "12px 0",
              }}
            >
              No cities saved yet. Click a city on the globe to inspect.
            </div>
          )}
        </div>

        <div className="hairline" />

        {/* Trip overlays launcher */}
        <div className="panel-head">
          <div className="h-title">TRIPS</div>
          <div className="h-meta">
            {savedTripCount} {savedTripCount === 1 ? "TRIP" : "TRIPS"}
          </div>
        </div>
        <div className="panel-sub">Manage saved trips or browse agent-suggested candidates.</div>
        <div style={{ padding: "8px 18px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="console-launch"
            onClick={() => {
              setTripsOverlayOpen(true);
              toggleLeftDrawer();
            }}
          >
            <span>Open trips</span>
            <span className="console-kbd">{savedTripCount}</span>
          </button>
          <button
            className="console-launch"
            onClick={() => {
              setCandidatesOverlayOpen(true);
              toggleLeftDrawer();
            }}
          >
            <span>Browse trip candidates</span>
            <span className="console-kbd">✈</span>
          </button>
        </div>

        <div className="hairline" />

        {/* AI Console launcher */}
        <div className="panel-head">
          <div className="h-title">CONSOLE</div>
          <div className="h-meta">⌘K</div>
        </div>
        <div className="panel-sub">
          Search cities, toggle layers, or ask the agent — all in one place.
        </div>
        <div style={{ padding: "8px 18px 18px" }}>
          <button
            className="console-launch"
            onClick={() => {
              setCommandOpen(true);
              toggleLeftDrawer();
            }}
          >
            <span>Open command console</span>
            <span className="console-kbd">⌘K</span>
          </button>
        </div>
      </div>
    </>
  );
}
