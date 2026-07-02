export type LngLat = [number, number]; // [lng, lat] — GeoJSON order

const R_EARTH_KM = 6371;

export const MAX_NONSTOP_KM = 14800; // beyond this, no commercial nonstop exists

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Great-circle interpolation with longitude unwrapping: consecutive points
 * never differ by more than 180° in longitude, so LineStrings crossing the
 * antimeridian render without wrapping glitches.
 */
export function greatCirclePoints(a: LngLat, b: LngLat, steps = 64): LngLat[] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lon1, lat1] = [toRad(a[0]), toRad(a[1])];
  const [lon2, lat2] = [toRad(b[0]), toRad(b[1])];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
      )
    );
  if (d === 0 || !Number.isFinite(d)) return [a, b];

  const pts: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([
      toDeg(Math.atan2(y, x)),
      toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    ]);
  }
  // Unwrap longitudes relative to the previous point.
  for (let i = 1; i < pts.length; i++) {
    let lng = pts[i][0];
    const prev = pts[i - 1][0];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    pts[i][0] = lng;
  }
  return pts;
}

export interface FlightHub {
  coord: LngLat;
  label: string;
}

export interface FlightPath {
  segments: LngLat[][];
  distanceKm: number;
  /** Hub label when the leg is too long for a nonstop and is routed via a hub. */
  via?: string;
}

/**
 * Realistic path for one leg. Legs within nonstop range fly the great circle.
 * Longer (near-antipodal) legs are routed through the connecting hub that
 * minimizes total distance — e.g. AKL→LHR via LAX/SIN instead of over the pole.
 */
export function flightPath(a: LngLat, b: LngLat, hubs: FlightHub[] = []): FlightPath {
  const direct = haversineKm(a, b);
  if (direct <= MAX_NONSTOP_KM || hubs.length === 0) {
    return { segments: [greatCirclePoints(a, b)], distanceKm: direct };
  }
  let best: { hub: FlightHub; total: number } | null = null;
  for (const h of hubs) {
    const d1 = haversineKm(a, h.coord);
    const d2 = haversineKm(h.coord, b);
    if (d1 < 500 || d2 < 500) continue; // hub is basically an endpoint
    if (d1 > MAX_NONSTOP_KM || d2 > MAX_NONSTOP_KM) continue;
    const total = d1 + d2;
    if (!best || total < best.total) best = { hub: h, total };
  }
  if (!best) return { segments: [greatCirclePoints(a, b)], distanceKm: direct };
  return {
    segments: [
      greatCirclePoints(a, best.hub.coord),
      greatCirclePoints(best.hub.coord, b),
    ],
    distanceKm: best.total,
    via: best.hub.label,
  };
}

/** Rough block time: taxi/climb overhead + cruise at ~830 km/h. */
export function estimateFlightHours(km: number): number {
  return 0.6 + km / 830;
}

export function formatHours(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return `${whole}h ${String(mins).padStart(2, "0")}m`;
}

/** Rough one-way economy estimate. */
export function estimateLegCostUSD(km: number): number {
  return Math.round(45 + 0.11 * km);
}
