import type { Trip } from "../types";
import { resolveTripColor } from "../lib/tripColors";

interface TripCardProps {
  trip: Trip;
  active: boolean;
  onClick: () => void;
}

export default function TripCard({ trip, active, onClick }: TripCardProps) {
  const statusLabel = trip.status.toUpperCase();

  return (
    <div
      className={`trip-card ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <div className="tg-bar" style={{ background: resolveTripColor(trip.color) }} />
      <div className="tg-row1">
        <div className="tg-name">{trip.name}</div>
        <div className={`tg-status ${trip.status}`}>{statusLabel}</div>
      </div>
      <div className="tg-route">
        {trip.nodes.map((node, i) => (
          <span key={i}>
            {node.iata || "???"}
            {i < trip.nodes.length - 1 && (
              <span className="iata-arrow">→</span>
            )}
          </span>
        ))}
      </div>
      <div className="tg-meta">
        <span>
          <span className="tg-key">LEGS </span>
          {trip.nodes.length > 1 ? trip.nodes.length - 1 : 0}
        </span>
        <span>
          <span className="tg-key">STATUS </span>
          {statusLabel}
        </span>
      </div>
    </div>
  );
}
