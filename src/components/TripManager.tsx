import { useState, useRef, useCallback } from "react";
import { useMeridianStore } from "../store";
import type { Trip, TripNode } from "../types";

const STATUS_OPTIONS: Trip["status"][] = ["draft", "scouting", "confirmed"];
const COLOR_OPTIONS: Trip["color"][] = ["a", "b", "c"];

export default function TripManager() {
  const {
    trips,
    activeTripId,
    setActiveTrip,
    createTrip,
    updateTripName,
    updateTripStatus,
    updateTripColor,
    removeNodeFromTrip,
    reorderTripNodes,
    duplicateTrip,
    removeTrip,
    cities,
    addCityToTrip,
    setCommandOpen,
    toggleLeftDrawer,
  } = useMeridianStore();

  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showCityPicker, setShowCityPicker] = useState<string | null>(null);
  const [citySearch, setCitySearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    tripId: string;
    fromIndex: number;
  } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const activeTrip = trips.find((t) => t.id === activeTripId);

  const handleCreateTrip = useCallback(() => {
    createTrip();
  }, [createTrip]);

  const handleStartEditName = useCallback(
    (trip: Trip) => {
      setEditingTripId(trip.id);
      setEditingName(trip.name);
      setTimeout(() => nameInputRef.current?.focus(), 50);
    },
    []
  );

  const handleSaveName = useCallback(
    (tripId: string) => {
      const trimmed = editingName.trim();
      if (trimmed) updateTripName(tripId, trimmed);
      setEditingTripId(null);
    },
    [editingName, updateTripName]
  );

  const handleAddCityToTrip = useCallback(
    (tripId: string, cityId: string) => {
      const city = cities.find((c) => c.id === cityId);
      if (!city) return;
      const node: TripNode = {
        cityId: city.id,
        name: city.name,
        iata: city.iata,
        lat: city.lat,
        lng: city.lng,
      };
      addCityToTrip(tripId, node);
      setShowCityPicker(null);
      setCitySearch("");
    },
    [cities, addCityToTrip]
  );

  const handleDragStart = useCallback(
    (tripId: string, fromIndex: number) => {
      setDragState({ tripId, fromIndex });
    },
    []
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, tripId: string, toIndex: number) => {
      e.preventDefault();
      if (!dragState || dragState.tripId !== tripId) return;
      if (dragState.fromIndex !== toIndex) {
        reorderTripNodes(tripId, dragState.fromIndex, toIndex);
        setDragState({ tripId, fromIndex: toIndex });
      }
    },
    [dragState, reorderTripNodes]
  );

  const handleDragEnd = useCallback(() => {
    setDragState(null);
  }, []);

  const filteredCities = cities
    .filter(
      (c) =>
        c.name.toLowerCase().includes(citySearch.toLowerCase()) ||
        (c.iata && c.iata.toLowerCase().includes(citySearch.toLowerCase()))
    )
    .slice(0, 12);

  return (
    <div className="trip-manager">
      {/* Header */}
      <div className="panel-head">
        <div className="h-title">TRIPS</div>
        <div className="h-meta">
          {trips.length} {trips.length === 1 ? "TRIP" : "TRIPS"}
        </div>
      </div>
      <div className="panel-sub">
        Plan routes across the globe. Arcs visualize flight paths.
      </div>

      {/* Create button */}
      <div style={{ padding: "0 18px 10px" }}>
        <button className="tm-create-btn" onClick={handleCreateTrip}>
          <span className="tm-plus">+</span> NEW TRIP
        </button>
      </div>

      {/* Trip list */}
      <div className="tm-trip-list">
        {trips.map((trip) => {
          const isActive = trip.id === activeTripId;
          const isEditing = trip.id === editingTripId;
          const isConfirmingDelete = trip.id === confirmDeleteId;

          return (
            <div
              key={trip.id}
              className={`tm-trip ${isActive ? "active" : ""}`}
              data-color={trip.color}
            >
              {/* Color bar */}
              <div className="tm-color-bar" />

              {/* Clickable header area */}
              <div
                className="tm-trip-header"
                onClick={() => setActiveTrip(trip.id)}
              >
                {/* Editable name */}
                {isEditing ? (
                  <input
                    ref={nameInputRef}
                    className="tm-name-input"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => handleSaveName(trip.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveName(trip.id);
                      if (e.key === "Escape") setEditingTripId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    className="tm-trip-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleStartEditName(trip);
                    }}
                    title="Double-click to rename"
                  >
                    {trip.name}
                  </div>
                )}

                {/* Status badge */}
                <div className={`tm-status-badge ${trip.status}`}>
                  {trip.status.toUpperCase()}
                </div>
              </div>

              {/* Route display */}
              {trip.nodes.length > 0 && (
                <div className="tm-route-display">
                  {trip.nodes.map((node, i) => (
                    <span key={`${node.cityId}-${i}`}>
                      {node.iata || "???"}
                      {i < trip.nodes.length - 1 && (
                        <span className="iata-arrow">→</span>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {/* Meta */}
              <div className="tm-trip-meta">
                <span>
                  <span className="tm-key">LEGS</span>{" "}
                  {trip.nodes.length > 1 ? trip.nodes.length - 1 : 0}
                </span>
                <span>
                  <span className="tm-key">STOPS</span> {trip.nodes.length}
                </span>
              </div>

              {/* Expanded detail for active trip */}
              {isActive && (
                <div className="tm-trip-detail">
                  <div className="hairline" style={{ margin: "8px 0" }} />

                  {/* Color & status selectors */}
                  <div className="tm-controls-row">
                    <div className="tm-color-picker">
                      <span className="tm-key">COLOR</span>
                      <div className="tm-color-swatches">
                        {COLOR_OPTIONS.map((c) => (
                          <button
                            key={c}
                            className={`tm-swatch ${c} ${
                              trip.color === c ? "selected" : ""
                            }`}
                            onClick={() => updateTripColor(trip.id, c)}
                            title={`Color ${c.toUpperCase()}`}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="tm-status-picker">
                      <span className="tm-key">STATUS</span>
                      <div className="tm-status-options">
                        {STATUS_OPTIONS.map((s) => (
                          <button
                            key={s}
                            className={`tm-status-opt ${s} ${
                              trip.status === s ? "selected" : ""
                            }`}
                            onClick={() => updateTripStatus(trip.id, s)}
                          >
                            {s.charAt(0).toUpperCase() + s.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Node list with reorder/remove */}
                  <div className="tm-node-list">
                    {trip.nodes.length === 0 && (
                      <div className="tm-empty-nodes">
                        Add cities to build a route. Arcs will appear on the
                        globe.
                      </div>
                    )}
                    {trip.nodes.map((node, i) => (
                      <div
                        key={`${node.cityId}-${i}`}
                        className="tm-node-row"
                        draggable
                        onDragStart={() => handleDragStart(trip.id, i)}
                        onDragOver={(e) => handleDragOver(e, trip.id, i)}
                        onDragEnd={handleDragEnd}
                      >
                        <span className="tm-node-drag" title="Drag to reorder">
                          ⠿
                        </span>
                        <span className="tm-node-index">{i + 1}</span>
                        <span className="tm-node-iata">
                          {node.iata || "???"}
                        </span>
                        <span className="tm-node-name">{node.name}</span>
                        <button
                          className="tm-node-remove"
                          onClick={() => removeNodeFromTrip(trip.id, node.cityId)}
                          title="Remove from trip"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Add city */}
                  <div className="tm-add-city">
                    {showCityPicker === trip.id ? (
                      <div className="tm-city-picker">
                        <input
                          className="tm-city-search"
                          placeholder="Search cities..."
                          value={citySearch}
                          onChange={(e) => setCitySearch(e.target.value)}
                          autoFocus
                        />
                        <div className="tm-city-results">
                          {filteredCities
                            .filter(
                              (c) =>
                                !trip.nodes.some((n) => n.cityId === c.id)
                            )
                            .map((city) => (
                              <div
                                key={city.id}
                                className="tm-city-option"
                                onClick={() =>
                                  handleAddCityToTrip(trip.id, city.id)
                                }
                              >
                                <span className="tm-co-iata">
                                  {city.iata || "—"}
                                </span>
                                <span className="tm-co-name">{city.name}</span>
                                <span className="tm-co-country">
                                  {city.country}
                                </span>
                              </div>
                            ))}
                          {filteredCities.filter(
                            (c) => !trip.nodes.some((n) => n.cityId === c.id)
                          ).length === 0 && (
                            <div className="tm-no-results">
                              No matching cities found
                            </div>
                          )}
                        </div>
                        <div className="tm-picker-footer">
                          <button
                            className="tm-cmd-btn"
                            onClick={() => {
                              setShowCityPicker(null);
                              setCitySearch("");
                              toggleLeftDrawer();
                              setCommandOpen(true);
                            }}
                          >
                            SEARCH VIA CONSOLE ⌘K
                          </button>
                          <button
                            className="tm-cancel-btn"
                            onClick={() => {
                              setShowCityPicker(null);
                              setCitySearch("");
                            }}
                          >
                            CANCEL
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="tm-add-btn"
                        onClick={() => setShowCityPicker(trip.id)}
                      >
                        + ADD CITY
                      </button>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="tm-actions">
                    <button
                      className="tm-action-btn"
                      onClick={() => handleStartEditName(trip)}
                      title="Rename trip"
                    >
                      RENAME
                    </button>
                    <button
                      className="tm-action-btn"
                      onClick={() => duplicateTrip(trip.id)}
                      title="Duplicate trip"
                    >
                      DUPLICATE
                    </button>
                    {isConfirmingDelete ? (
                      <>
                        <button
                          className="tm-action-btn tm-delete-confirm"
                          onClick={() => {
                            removeTrip(trip.id);
                            setConfirmDeleteId(null);
                          }}
                        >
                          CONFIRM
                        </button>
                        <button
                          className="tm-action-btn"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          CANCEL
                        </button>
                      </>
                    ) : (
                      <button
                        className="tm-action-btn tm-delete-btn"
                        onClick={() => setConfirmDeleteId(trip.id)}
                        title="Delete trip"
                      >
                        DELETE
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {trips.length === 0 && (
          <div className="tm-empty-state">
            No trips yet. Create a trip to start planning routes across the
            globe.
          </div>
        )}
      </div>
    </div>
  );
}
