import { useState, useRef, useCallback } from "react";
import { apiUrl } from "../lib/api";
import { useMeridianStore } from "../store";
import type {
  CityResearch,
  TripOption,
  NearbyDestination,
  CostBreakdown,
  VisaInfo,
  ConnectivityInfo,
} from "../types";

export default function AgentBrief() {
  const { selectedCityId, cities, addCityToActiveTrip, selectCity } =
    useMeridianStore();
  const [research, setResearch] = useState<CityResearch | null>(null);
  const [tripOptions, setTripOptions] = useState<TripOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchResearch = useCallback(
    (fresh = false) => {
      if (!selectedCityId) return;

      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setExpandedSection(null);

      const url = apiUrl("/api/agent/research") + (fresh ? "?fresh=true" : "");

      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cityId: selectedCityId }),
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((data: CityResearch) => {
          setResearch(data);
          setLoading(false);
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            setLoading(false);
            setResearch(null);
          }
        });
    },
    [selectedCityId]
  );

  const fetchTripOptions = useCallback(() => {
    if (!selectedCityId) return;

    setTripsLoading(true);
    fetch(apiUrl("/api/agent/trip-options"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cityId: selectedCityId }),
    })
      .then((r) => r.json())
      .then((data) => {
        setTripOptions(data.options ?? []);
        setTripsLoading(false);
      })
      .catch(() => {
        setTripsLoading(false);
        setTripOptions([]);
      });
  }, [selectedCityId]);

  // Reset when city changes
  const prevCityRef = useRef(selectedCityId);
  if (prevCityRef.current !== selectedCityId) {
    prevCityRef.current = selectedCityId;
    setResearch(null);
    setTripOptions([]);
    setExpandedSection(null);
  }

  const handleRefresh = useCallback(() => {
    fetchResearch(true);
  }, [fetchResearch]);

  const handleCreateTrip = useCallback(
    (option: TripOption) => {
      for (const node of option.nodes) {
        addCityToActiveTrip(node);
      }
    },
    [addCityToActiveTrip]
  );

  const handleNavigateToCity = useCallback(
    (cityId: string) => {
      selectCity(cityId);
    },
    [selectCity]
  );

  if (!selectedCityId) return null;

  const city = cities.find((c) => c.id === selectedCityId);

  return (
    <div className="agent-brief-root">
      {/* Header with refresh */}
      <div className="section">
        <div className="research-header">
          <div>
            <h3>
              AGENT RESEARCH{" "}
              <span className="meta">
                {research ? research.generatedAt.split("T")[0] : "ON-DEMAND"}
              </span>
            </h3>
            <div className="h-sub">
              {research
                ? `Intelligence for ${city?.name ?? "selected city"}`
                : `Click to research ${city?.name ?? "selected city"}`}
            </div>
          </div>
          <div className="research-actions">
            {research && (
              <span className="research-timestamp">
                {formatTimeAgo(research.generatedAt)}
              </span>
            )}
            <button
              className="research-btn"
              onClick={handleRefresh}
              disabled={loading}
              title={research ? "Refresh research (bypasses cache)" : "Generate research"}
            >
              {loading ? (
                <span className="research-btn-spinner" />
              ) : (
                "⟳"
              )}
              {research ? "REFRESH" : "RESEARCH"}
            </button>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="section">
          <div className="agent-brief-loading">
            <span />
            <span />
            <span />
          </div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--ink3)",
              marginTop: 8,
            }}
          >
            Researching living conditions, costs, and connectivity...
          </div>
        </div>
      )}

      {/* Research content */}
      {research && !loading && (
        <>
          {/* Summary */}
          <div className="section">
            <p className="agent-summary">{research.summary}</p>
          </div>

          {/* Cost Breakdown */}
          <CollapsibleSection
            id="cost"
            title="COST BREAKDOWN"
            meta="MONTHLY"
            expanded={expandedSection === "cost"}
            onToggle={() =>
              setExpandedSection(expandedSection === "cost" ? null : "cost")
            }
          >
            <CostBreakdownView data={research.costBreakdown} />
          </CollapsibleSection>

          {/* Living Conditions */}
          <CollapsibleSection
            id="living"
            title="LIVING CONDITIONS"
            meta="INTEL"
            expanded={expandedSection === "living"}
            onToggle={() =>
              setExpandedSection(
                expandedSection === "living" ? null : "living"
              )
            }
          >
            <LivingConditionsView data={research.livingConditions} />
          </CollapsibleSection>

          {/* Connectivity */}
          <CollapsibleSection
            id="connectivity"
            title="CONNECTIVITY"
            meta="INFRA"
            expanded={expandedSection === "connectivity"}
            onToggle={() =>
              setExpandedSection(
                expandedSection === "connectivity" ? null : "connectivity"
              )
            }
          >
            <ConnectivityView data={research.connectivity} />
          </CollapsibleSection>

          {/* Visa */}
          <CollapsibleSection
            id="visa"
            title="VISA & ENTRY"
            meta="REQUIREMENTS"
            expanded={expandedSection === "visa"}
            onToggle={() =>
              setExpandedSection(
                expandedSection === "visa" ? null : "visa"
              )
            }
          >
            <VisaView data={research.visa} />
          </CollapsibleSection>

          {/* Safety */}
          <CollapsibleSection
            id="safety"
            title="SAFETY"
            meta="ADVISORY"
            expanded={expandedSection === "safety"}
            onToggle={() =>
              setExpandedSection(
                expandedSection === "safety" ? null : "safety"
              )
            }
          >
            <SafetyView notes={research.safetyNotes} />
          </CollapsibleSection>

          {/* Seasonal */}
          <div className="section">
            <h3>
              SEASONAL <span className="meta">TIMING</span>
            </h3>
            <p className="agent-seasonal">{research.seasonalAdvice}</p>
          </div>

          {/* Nearby Destinations */}
          {research.nearbyDestinations.length > 0 && (
            <div className="section">
              <h3>
                NEARBY <span className="meta">DESTINATIONS</span>
              </h3>
              <div className="h-sub">Top rated cities within range.</div>
              <div className="nearby-dest-list">
                {research.nearbyDestinations.map((dest) => (
                  <NearbyDestRow
                    key={dest.cityId}
                    dest={dest}
                    onNavigate={handleNavigateToCity}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Trip Options */}
          <div className="section">
            <h3>
              TRIP OPTIONS <span className="meta">ROUTES</span>
            </h3>
            <div className="h-sub">Create a trip from suggested routes.</div>

            {tripsLoading && (
              <div className="agent-brief-loading">
                <span />
                <span />
                <span />
              </div>
            )}

            {!tripsLoading && tripOptions.length > 0 && (
              <div className="trip-options-list">
                {tripOptions.map((option) => (
                  <TripOptionRow
                    key={option.id}
                    option={option}
                    onCreate={handleCreateTrip}
                  />
                ))}
              </div>
            )}

            {!tripsLoading && tripOptions.length === 0 && (
              <button
                className="research-btn"
                style={{ marginTop: 4 }}
                onClick={fetchTripOptions}
              >
                LOAD ROUTES
              </button>
            )}
          </div>
        </>
      )}

      {/* No research yet — prompt to generate */}
      {!loading && !research && selectedCityId && (
        <div className="section">
          <p className="agent-prompt-text">
            No research generated yet. Click RESEARCH to have the agent
            investigate current living conditions, prices, visa requirements,
            and connectivity for {city?.name ?? "this city"}.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Sub-components ───────────────────────────────────────────────────

function CollapsibleSection({
  id,
  title,
  meta,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  meta: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="section collapsible-section">
      <div className="collapsible-header" onClick={onToggle}>
        <h3>
          {title} <span className="meta">{meta}</span>
        </h3>
        <span className="collapsible-chevron">{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

function CostBreakdownView({ data }: { data: CostBreakdown }) {
  const rows = [
    { label: "RENT", value: data.rent },
    { label: "FOOD", value: data.food },
    { label: "TRANSPORT", value: data.transport },
    { label: "COWORKING", value: data.coworking },
    { label: "HEALTHCARE", value: data.healthcare },
  ];

  return (
    <div className="cost-breakdown">
      {rows.map((r) => (
        <div key={r.label} className="cost-row">
          <span className="cost-key">{r.label}</span>
          <span className="cost-val">{r.value}</span>
        </div>
      ))}
      <div className="cost-total">
        <span className="cost-key">TOTAL</span>
        <span className="cost-val cost-total-val">{data.totalBudget}</span>
      </div>
      <div className="cost-currency">Currency: {data.currency}</div>
    </div>
  );
}

function LivingConditionsView({
  data,
}: {
  data: { title: string; items: string[] };
}) {
  return (
    <div className="living-conditions">
      {data.items.map((item, i) => (
        <div key={i} className="lc-item">
          <span className="lc-bullet">›</span>
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

function ConnectivityView({ data }: { data: ConnectivityInfo }) {
  const rows = [
    { label: "BROADBAND", value: data.avgDownloadMbps },
    { label: "MOBILE", value: data.mobileCoverage },
    { label: "COWORKING", value: data.coworkingSpaces },
    { label: "CAFE WIFI", value: data.cafeWifi },
  ];

  return (
    <div className="connectivity-info">
      {rows.map((r) => (
        <div key={r.label} className="cost-row">
          <span className="cost-key">{r.label}</span>
          <span className="cost-val">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function VisaView({ data }: { data: VisaInfo }) {
  const rows = [
    { label: "TOURIST", value: data.touristVisa },
    { label: "ON ARRIVAL", value: data.visaOnArrival },
    { label: "E-VISA", value: data.eVisa },
    { label: "NOMAD VISA", value: data.digitalNomadVisa },
  ];

  return (
    <div className="visa-info">
      {rows.map((r) => (
        <div key={r.label} className="visa-row">
          <div className="visa-key">{r.label}</div>
          <div className="visa-val">{r.value}</div>
        </div>
      ))}
      <div className="visa-note">{data.commonPassportNotes}</div>
    </div>
  );
}

function SafetyView({ notes }: { notes: string[] }) {
  return (
    <div className="safety-info">
      {notes.map((note, i) => (
        <div key={i} className="lc-item">
          <span className="lc-bullet safety-bullet">◆</span>
          <span>{note}</span>
        </div>
      ))}
    </div>
  );
}

function NearbyDestRow({
  dest,
  onNavigate,
}: {
  dest: NearbyDestination;
  onNavigate: (cityId: string) => void;
}) {
  return (
    <div
      className="nearby-dest-row"
      onClick={() => onNavigate(dest.cityId)}
    >
      <div className="nd-iata">{dest.iata || "—"}</div>
      <div className="nd-info">
        <div className="nd-name">
          {dest.name}, {dest.country}
        </div>
        <div className="nd-reason">{dest.reason}</div>
      </div>
      <div className="nd-distance">{dest.distance}</div>
    </div>
  );
}

function TripOptionRow({
  option,
  onCreate,
}: {
  option: TripOption;
  onCreate: (option: TripOption) => void;
}) {
  const isMulti = option.type === "multi-hop";
  return (
    <div className={`trip-option-row ${isMulti ? "multi" : "single"}`}>
      <div className="to-header">
        <span className={`to-type-badge ${option.type}`}>
          {isMulti ? "MULTI" : "DIRECT"}
        </span>
        <span className="to-label">{option.label}</span>
      </div>
      <div className="to-highlight">{option.highlight}</div>
      <div className="to-nodes">
        {option.nodes.map((n, i) => (
          <span key={n.cityId} className="to-node">
            {i > 0 && <span className="to-arrow">→</span>}
            <span className="to-node-name">{n.iata || n.name}</span>
          </span>
        ))}
      </div>
      <button className="to-create-btn" onClick={() => onCreate(option)}>
        + CREATE TRIP
      </button>
    </div>
  );
}
