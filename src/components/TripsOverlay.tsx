import { useEffect, useRef, useState, useCallback } from "react";
import { useMeridianStore } from "../store";
import { navigate } from "../lib/router";
import { TRIP_COLORS, resolveTripColor, randomTripColor } from "../lib/tripColors";
import type { Trip, TripNode } from "../types";

const STATUS_OPTIONS: Trip["status"][] = ["draft", "scouting", "confirmed"];

export default function TripsOverlay() {
  const {
    tripsOverlayOpen,
    setTripsOverlayOpen,
    trips,
    activeTripId,
    setActiveTrip,
    createTrip,
    updateTripName,
    updateTripStatus,
    updateTripColor,
    removeNodeAt,
    replaceNodeAt,
    reorderTripNodes,
    duplicateTrip,
    removeTrip,
    cities,
    addCityToTrip,
    setCommandOpen,
  } = useMeridianStore();

  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showCityPicker, setShowCityPicker] = useState<string | null>(null);
  const [citySearch, setCitySearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [replacingIndex, setReplacingIndex] = useState<{
    tripId: string;
    index: number;
  } | null>(null);
  const [dragState, setDragState] = useState<{
    tripId: string;
    fromIndex: number;
  } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setTripsOverlayOpen(false), [setTripsOverlayOpen]);

  useEffect(() => {
    if (tripsOverlayOpen) setTimeout(() => panelRef.current?.focus(), 20);
  }, [tripsOverlayOpen]);

  const savedTrips = trips.filter((t) => t.origin !== "agent");

  const handleCreateTrip = useCallback(() => {
    createTrip();
  }, [createTrip]);

  const handleStartEditName = useCallback((trip: Trip) => {
    setEditingTripId(trip.id);
    setEditingName(trip.name);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, []);

  const handleSaveName = useCallback(
    (tripId: string) => {
      const trimmed = editingName.trim();
      if (trimmed) updateTripName(tripId, trimmed);
      setEditingTripId(null);
    },
    [editingName, updateTripName]
  );

  const cityToNode = useCallback(
    (cityId: string): TripNode | null => {
      const city = cities.find((c) => c.id === cityId);
      if (!city) return null;
      return {
        cityId: city.id,
        name: city.name,
        iata: city.iata,
        lat: city.lat,
        lng: city.lng,
      };
    },
    [cities]
  );

  const handleAddCityToTrip = useCallback(
    (tripId: string, cityId: string) => {
      const node = cityToNode(cityId);
      if (!node) return;
      addCityToTrip(tripId, node);
      setShowCityPicker(null);
      setCitySearch("");
    },
    [cityToNode, addCityToTrip]
  );

  const handleDragStart = useCallback((tripId: string, fromIndex: number) => {
    setDragState({ tripId, fromIndex });
  }, []);

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

  const handleDragEnd = useCallback(() => setDragState(null), []);

  const filteredCities = cities
    .filter(
      (c) =>
        c.name.toLowerCase().includes(citySearch.toLowerCase()) ||
        (c.iata && c.iata.toLowerCase().includes(citySearch.toLowerCase())) ||
        (c.airportName &&
          c.airportName.toLowerCase().includes(citySearch.toLowerCase()))
    )
    .sort((a, b) => (b.iata ? 1 : 0) - (a.iata ? 1 : 0) || b.population - a.population)
    .slice(0, 12);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !showCityPicker && !editingTripId && !replacingIndex) {
      e.preventDefault();
      close();
    }
  };

  if (!tripsOverlayOpen) return null;

  return (
    <div className="cmd-overlay" onMouseDown={close}>
      <div
        className="cmd-panel trips-overlay-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="panel-head trips-overlay-head">
          <div className="h-title">TRIPS</div>
          <div className="h-meta">
            {savedTrips.length} {savedTrips.length === 1 ? "TRIP" : "TRIPS"}
          </div>
          <button
            className="tm-action-btn"
            onClick={() => {
              close();
              navigate("/trips");
            }}
            title="Open full trips page"
          >
            FULL PAGE ↗
          </button>
          <button className="candidates-close" onClick={close} title="Close (esc)">
            ✕
          </button>
        </div>
        <div className="panel-sub">Plan routes across the globe. Arcs visualize flight paths.</div>

        <div style={{ padding: "0 18px 10px" }}>
          <button className="tm-create-btn" onClick={handleCreateTrip}>
            <span className="tm-plus">+</span> NEW TRIP
          </button>
        </div>

        <div className="tm-trip-list trips-overlay-list">
          {savedTrips.map((trip) => {
            const isActive = trip.id === activeTripId;
            const isEditing = trip.id === editingTripId;
            const isConfirmingDelete = trip.id === confirmDeleteId;

            return (
              <div key={trip.id} className={`tm-trip ${isActive ? "active" : ""}`}>
                <div
                  className="tm-color-bar"
                  style={{ background: resolveTripColor(trip.color) }}
                />

                <div className="tm-trip-header" onClick={() => setActiveTrip(trip.id)}>
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

                  <div className={`tm-status-badge ${trip.status}`}>
                    {trip.status.toUpperCase()}
                  </div>
                </div>

                {trip.nodes.length > 0 && (
                  <div className="tm-route-display">
                    {trip.nodes.map((node, i) => (
                      <span key={`${node.cityId}-${i}`}>
                        {node.iata || "???"}
                        {i < trip.nodes.length - 1 && <span className="iata-arrow">→</span>}
                      </span>
                    ))}
                  </div>
                )}

                <div className="tm-trip-meta">
                  <span>
                    <span className="tm-key">LEGS</span>{" "}
                    {trip.nodes.length > 1 ? trip.nodes.length - 1 : 0}
                  </span>
                  <span>
                    <span className="tm-key">STOPS</span> {trip.nodes.length}
                  </span>
                  {trip.estimate && (
                    <span>
                      <span className="tm-key">EST</span> ${trip.estimate.priceEstimate}
                    </span>
                  )}
                </div>

                {isActive && (
                  <div className="tm-trip-detail">
                    <div className="hairline" style={{ margin: "8px 0" }} />

                    <div className="tm-controls-row">
                      <div className="tm-color-picker">
                        <span className="tm-key">COLOR</span>
                        <div className="tm-color-swatches">
                          {TRIP_COLORS.map((c) => (
                            <button
                              key={c}
                              className={`tm-swatch ${
                                resolveTripColor(trip.color) === c ? "selected" : ""
                              }`}
                              style={{ background: c }}
                              onClick={() => updateTripColor(trip.id, c)}
                              title={c}
                            />
                          ))}
                          <button
                            className="tm-swatch tm-swatch-random"
                            title="Random color"
                            onClick={() =>
                              updateTripColor(
                                trip.id,
                                randomTripColor(savedTrips.map((t) => t.color))
                              )
                            }
                          >
                            ⚄
                          </button>
                        </div>
                      </div>
                      <div className="tm-status-picker">
                        <span className="tm-key">STATUS</span>
                        <div className="tm-status-options">
                          {STATUS_OPTIONS.map((s) => (
                            <button
                              key={s}
                              className={`tm-status-opt ${s} ${trip.status === s ? "selected" : ""}`}
                              onClick={() => updateTripStatus(trip.id, s)}
                            >
                              {s.charAt(0).toUpperCase() + s.slice(1)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="tm-node-list">
                      {trip.nodes.length === 0 && (
                        <div className="tm-empty-nodes">
                          Add cities to build a route. Arcs will appear on the globe.
                        </div>
                      )}
                      {trip.nodes.map((node, i) => (
                        <div
                          key={`${node.cityId}-${i}`}
                          className="tm-node-row"
                          draggable={replacingIndex === null}
                          onDragStart={() => handleDragStart(trip.id, i)}
                          onDragOver={(e) => handleDragOver(e, trip.id, i)}
                          onDragEnd={handleDragEnd}
                        >
                          <span className="tm-node-drag" title="Drag to reorder">
                            ⠿
                          </span>
                          <span className="tm-node-index">{i + 1}</span>
                          <span className="tm-node-iata">{node.iata || "???"}</span>
                          {replacingIndex?.tripId === trip.id &&
                          replacingIndex.index === i ? (
                            <span className="tm-replace-wrap">
                              <input
                                className="tm-city-search"
                                placeholder={`Replace ${node.name}…`}
                                value={citySearch}
                                onChange={(e) => setCitySearch(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") {
                                    setReplacingIndex(null);
                                    setCitySearch("");
                                  }
                                }}
                              />
                              {citySearch.trim().length >= 2 && (
                                <span className="tm-replace-results">
                                  {filteredCities.map((city) => (
                                    <button
                                      key={city.id}
                                      className="tm-city-option"
                                      onClick={() => {
                                        replaceNodeAt(trip.id, i, {
                                          cityId: city.id,
                                          name: city.name,
                                          iata: city.iata,
                                          lat: city.lat,
                                          lng: city.lng,
                                        });
                                        setReplacingIndex(null);
                                        setCitySearch("");
                                      }}
                                    >
                                      <span className="tm-co-iata">{city.iata || "—"}</span>
                                      <span className="tm-co-name">{city.name}</span>
                                    </button>
                                  ))}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span
                              className="tm-node-name tm-node-name-clickable"
                              title="Click to replace this city"
                              onClick={() => {
                                setReplacingIndex({ tripId: trip.id, index: i });
                                setCitySearch("");
                              }}
                            >
                              {node.name}
                            </span>
                          )}
                          <button
                            className="tm-node-remove"
                            onClick={() => removeNodeAt(trip.id, i)}
                            title="Remove from trip"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>

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
                            {filteredCities.map((city) => (
                              <div
                                key={city.id}
                                className="tm-city-option"
                                onClick={() => handleAddCityToTrip(trip.id, city.id)}
                              >
                                <span className="tm-co-iata">{city.iata || "—"}</span>
                                <span className="tm-co-name">{city.name}</span>
                                <span className="tm-co-country">{city.country}</span>
                              </div>
                            ))}
                            {filteredCities.length === 0 && (
                              <div className="tm-no-results">No matching cities found</div>
                            )}
                          </div>
                          <div className="tm-picker-footer">
                            <button
                              className="tm-cmd-btn"
                              onClick={() => {
                                setShowCityPicker(null);
                                setCitySearch("");
                                close();
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
                        <>
                          <button
                            className="tm-add-btn"
                            onClick={() => setShowCityPicker(trip.id)}
                          >
                            + ADD CITY
                          </button>
                          {trip.nodes.length >= 2 &&
                            trip.nodes[trip.nodes.length - 1].cityId !==
                              trip.nodes[0].cityId && (
                              <button
                                className="tm-add-btn"
                                onClick={() => addCityToTrip(trip.id, trip.nodes[0])}
                              >
                                ↩ RETURN TO {trip.nodes[0].iata ?? trip.nodes[0].name}
                              </button>
                            )}
                        </>
                      )}
                    </div>

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
                      <button
                        className="tm-action-btn"
                        onClick={() => {
                          close();
                          navigate(`/trips/${trip.id}`);
                        }}
                        title="Open in full page"
                      >
                        FULL PAGE ↗
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

          {savedTrips.length === 0 && (
            <div className="tm-empty-state">
              No trips yet. Create a trip to start planning routes across the globe.
            </div>
          )}
        </div>

        <div className="candidates-footer">
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
