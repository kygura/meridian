import { useMemo } from "react";
import { Badge, type BadgeTone } from "../../../ui";
import { useMeridianStore } from "../../../store";
import { resolveTripColor } from "../../../lib/tripColors";
import { hubsFromCities, STATUS_LABEL } from "../../../lib/tripPlan";
import type { Trip } from "../../../types";

const STATUS_TONE: Record<Trip["status"], BadgeTone> = {
  draft: "neutral",
  scouting: "accent",
  confirmed: "success",
};

/** Small trip colour dot. The colour is trip data, so it is set inline. */
export function TripDot({ color, size = "md" }: { color: string; size?: "sm" | "md" }) {
  return (
    <span
      className={`trips-up-dot trips-up-dot--${size}`}
      style={{ background: resolveTripColor(color) }}
      aria-hidden="true"
    />
  );
}

export function StatusBadge({ status }: { status: Trip["status"] }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** Mock price estimates always carry a badge (DESIGN-v3 §7). */
export function MockBadge({ trip }: { trip: Trip }) {
  if (trip.estimate?.source !== "mock") return null;
  return <Badge tone="warning">Mock</Badge>;
}

/** Large hubs from the loaded cities, for routing very long legs. */
export function useHubs() {
  const cities = useMeridianStore((s) => s.cities);
  return useMemo(() => hubsFromCities(cities), [cities]);
}
