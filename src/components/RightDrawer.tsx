import { useMeridianStore } from "../store";
import RegionCard from "./RegionCard";
import MetricPanels from "./MetricPanels";
import AgentBrief from "./AgentBrief";

export default function RightDrawer() {
  const { rightDrawerOpen, setRightDrawer, selectedCityId, selectCity } =
    useMeridianStore();

  const handleClose = () => {
    setRightDrawer(false);
    selectCity(null);
  };

  return (
    <div className={`drawer-right ${rightDrawerOpen ? "open" : ""}`}>
      {/* Close button */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "8px 12px 0",
        }}
      >
        <button
          onClick={handleClose}
          style={{
            background: "transparent",
            border: "1px solid var(--hairline2)",
            color: "var(--ink3)",
            width: 28,
            height: 28,
            cursor: "pointer",
            fontFamily: "var(--mono)",
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="Close []]"
        >
          ✕
        </button>
      </div>

      {selectedCityId ? (
        <>
          <RegionCard />
          <MetricPanels />
          <AgentBrief />
        </>
      ) : (
        <div
          style={{
            padding: "40px 18px",
            fontFamily: "var(--display)",
            fontStyle: "italic",
            fontSize: 14,
            color: "var(--ink3)",
          }}
        >
          Select a city on the globe to inspect.
        </div>
      )}
    </div>
  );
}
