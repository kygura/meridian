import type maplibregl from "maplibre-gl";
import { buildJourneyArcs } from "../../lib/journeyArcs";
import { flightPath, type FlightHub, type LngLat } from "../../lib/geo";
import { resolveTripColor } from "../../lib/tripColors";
import type { Booking } from "../../lib/bookingApi";
import type { City, Journey, Trip } from "../../types";
import { cssColor, mixRgba, type MapColors, type RGBA } from "./useMapColors";

// Trip overlays on the globe (DESIGN-v3.md §6): past journey arcs coloured by year,
// planned trip routes (dashed until confirmed), booked flights and city dots.
// Drawn as native MapLibre GeoJSON layers, as the original globe did, so every line
// follows the sphere and anything past the horizon is hidden by the globe itself.
// Pure data -> GeoJSON + layer specs; MapScreen owns the map.

export interface ArcDatum {
  kind: "arc";
  path: LngLat[];
  journeyId: string;
  year: number;
  from: string;
  to: string;
  date: string;
}

export interface StopDatum {
  kind: "stop";
  coord: LngLat;
  journeyId: string;
  year: number;
  cityId?: string;
  name?: string;
}

export interface RouteDatum {
  kind: "route";
  path: LngLat[];
  tripId: string;
  name: string;
  color: string;
  confirmed: boolean;
  suggested: boolean;
}

export interface NodeDatum {
  kind: "node";
  coord: LngLat;
  tripId: string;
  name: string;
  tripName: string;
  color: string;
}

export interface BookingDatum {
  kind: "booking";
  path: LngLat[];
  bookingId: string;
  tripId?: string;
  from: string;
  to: string;
  date: string;
}

export interface CityDatum {
  kind: "city";
  id: string;
  name: string;
  country: string;
  coord: LngLat;
  population: number;
  rank: 0 | 1 | 2 | 3;
}

export type PickDatum = ArcDatum | StopDatum | RouteDatum | NodeDatum | BookingDatum | CityDatum;

export function hubsOf(cities: City[]): FlightHub[] {
  return cities
    .filter((c) => c.hub === "large" && c.iata)
    .map((c) => ({ coord: [c.lng, c.lat] as LngLat, label: c.iata! }));
}

/** 0 = always shown (capitals, big hubs, megacities) ... 3 = only when zoomed in. */
export function cityRank(c: City): 0 | 1 | 2 | 3 {
  if (c.capital || c.hub === "large" || c.population >= 5_000_000) return 0;
  if (c.iata || c.population >= 1_000_000) return 1;
  if (c.population >= 300_000) return 2;
  return 3;
}

/** Highest rank drawn at a zoom level. */
export function maxRankAt(zoom: number): number {
  if (zoom < 2.5) return 0;
  if (zoom < 4) return 1;
  if (zoom < 5.5) return 2;
  return 3;
}

export function buildCityData(cities: City[]): CityDatum[] {
  return cities
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng))
    .map((c) => ({
      kind: "city" as const,
      id: c.id,
      name: c.name,
      country: c.country,
      coord: [c.lng, c.lat] as LngLat,
      population: c.population,
      rank: cityRank(c),
    }))
    .sort((a, b) => b.rank - a.rank); // big cities drawn last, on top
}

export function buildPast(journeys: Journey[], cities: City[]) {
  const idx = new Map(cities.map((c) => [c.id, c]));
  const set = buildJourneyArcs(journeys, (id) => idx.get(id), hubsOf(cities));
  const arcs: ArcDatum[] = set.arcs.flatMap((a) =>
    a.paths.map((path) => ({
      kind: "arc" as const,
      path,
      journeyId: a.journeyId,
      year: a.year,
      from: a.fromName,
      to: a.toName,
      date: a.date,
    }))
  );
  // Stops keep their city id so the dot can open the city panel.
  const stopCity = new Map<string, City>();
  for (const j of journeys) for (const s of j.stops) {
    const c = idx.get(s.cityId);
    if (c) stopCity.set(`${j.id}|${c.lng},${c.lat}`, c);
  }
  const stops: StopDatum[] = set.stops.map((s) => {
    const c = stopCity.get(`${s.journeyId}|${s.coord[0]},${s.coord[1]}`);
    return { kind: "stop" as const, coord: s.coord, journeyId: s.journeyId, year: s.year, cityId: c?.id, name: c?.name };
  });
  const years = [...arcs.map((a) => a.year), ...stops.map((s) => s.year)].filter(Number.isFinite);
  const minYear = years.length ? Math.min(...years) : 0;
  const maxYear = years.length ? Math.max(...years) : 0;
  return { arcs, stops, minYear, maxYear };
}

export function buildPlanned(trips: Trip[], cities: City[]) {
  const hubs = hubsOf(cities);
  const routes: RouteDatum[] = [];
  const nodes: NodeDatum[] = [];
  for (const trip of trips) {
    const color = resolveTripColor(trip.color);
    const confirmed = trip.status === "confirmed" && trip.origin !== "agent";
    const suggested = trip.origin === "agent";
    for (let i = 0; i < trip.nodes.length - 1; i++) {
      const a = trip.nodes[i];
      const b = trip.nodes[i + 1];
      for (const path of flightPath([a.lng, a.lat], [b.lng, b.lat], hubs).segments)
        routes.push({ kind: "route", path, tripId: trip.id, name: trip.name, color, confirmed, suggested });
    }
    for (const n of trip.nodes)
      nodes.push({ kind: "node", coord: [n.lng, n.lat], tripId: trip.id, name: n.name, tripName: trip.name, color });
  }
  return { routes, nodes };
}

export function buildBookings(bookings: Booking[], cities: City[]): BookingDatum[] {
  const byIata = new Map<string, City>();
  for (const c of cities) if (c.iata && !byIata.has(c.iata)) byIata.set(c.iata, c);
  const hubs = hubsOf(cities);
  const out: BookingDatum[] = [];
  for (const b of bookings) {
    if (b.status !== "booked") continue;
    const a = byIata.get(b.leg.originIata);
    const z = byIata.get(b.leg.destinationIata);
    if (!a || !z) continue;
    for (const path of flightPath([a.lng, a.lat], [z.lng, z.lat], hubs).segments)
      out.push({ kind: "booking", path, bookingId: b.id, tripId: b.tripId, from: a.name, to: z.name, date: b.leg.departureDate });
  }
  return out;
}

export function yearColor(year: number, minYear: number, maxYear: number, colors: MapColors, alpha = 255): RGBA {
  const t = maxYear > minYear ? (year - minYear) / (maxYear - minYear) : 1;
  return mixRgba(colors.yearFrom, colors.yearTo, t, alpha);
}

// ── GeoJSON ──────────────────────────────────────────────────────────

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: "FeatureCollection", features: [] };

function line(path: LngLat[], props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: props };
}
function point(coord: LngLat, props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: props };
}

/** Everything the overlay sources hold, plus the arrays picked features index into. */
export interface OverlayData {
  sources: Record<OverlaySource, FC>;
  pick: {
    cities: CityDatum[];
    arcs: ArcDatum[];
    stops: StopDatum[];
    routes: RouteDatum[];
    nodes: NodeDatum[];
    bookings: BookingDatum[];
  };
}

export type OverlaySource = "ov-cities" | "ov-arcs" | "ov-stops" | "ov-routes" | "ov-nodes" | "ov-bookings" | "ov-selected";
export const OVERLAY_SOURCES: OverlaySource[] = ["ov-cities", "ov-arcs", "ov-stops", "ov-routes", "ov-nodes", "ov-bookings", "ov-selected"];

export interface OverlayInput {
  colors: MapColors;
  show: { past: boolean; planned: boolean; cities: boolean };
  past: ReturnType<typeof buildPast> | null;
  planned: ReturnType<typeof buildPlanned>;
  bookings: BookingDatum[];
  cities: CityDatum[];
  selectedCityId: string | null;
}

/** GeoJSON for every overlay source. Hidden layers get empty collections. */
export function buildOverlayData(input: OverlayInput): OverlayData {
  const { colors, show, past, planned, bookings, cities, selectedCityId } = input;
  const pick: OverlayData["pick"] = { cities: [], arcs: [], stops: [], routes: [], nodes: [], bookings: [] };
  const src: Record<OverlaySource, FC> = {
    "ov-cities": EMPTY,
    "ov-arcs": EMPTY,
    "ov-stops": EMPTY,
    "ov-routes": EMPTY,
    "ov-nodes": EMPTY,
    "ov-bookings": EMPTY,
    "ov-selected": EMPTY,
  };

  if (show.cities) {
    pick.cities = cities;
    src["ov-cities"] = {
      type: "FeatureCollection",
      features: cities.map((c, i) => point(c.coord, { i, hid: c.id, rank: c.rank, pop: c.population })),
    };
  }

  if (show.past && past) {
    const { arcs, stops, minYear, maxYear } = past;
    pick.arcs = arcs;
    pick.stops = stops;
    // Oldest first so this year's trips draw on top.
    const order = arcs.map((_, i) => i).sort((a, b) => arcs[a].year - arcs[b].year);
    src["ov-arcs"] = {
      type: "FeatureCollection",
      features: order.map((i) =>
        line(arcs[i].path, { i, hid: arcs[i].journeyId, color: cssColor(yearColor(arcs[i].year, minYear, maxYear, colors)) })
      ),
    };
    src["ov-stops"] = {
      type: "FeatureCollection",
      features: stops.map((s, i) => point(s.coord, { i, hid: s.journeyId, color: cssColor(yearColor(s.year, minYear, maxYear, colors)) })),
    };
  }

  if (show.planned) {
    pick.routes = planned.routes;
    pick.nodes = planned.nodes;
    pick.bookings = bookings;
    src["ov-routes"] = {
      type: "FeatureCollection",
      features: planned.routes.map((r, i) =>
        line(r.path, { i, hid: r.tripId, color: r.color, dashed: !r.confirmed, suggested: r.suggested })
      ),
    };
    src["ov-nodes"] = {
      type: "FeatureCollection",
      features: planned.nodes.map((n, i) => point(n.coord, { i, hid: n.tripId, color: n.color })),
    };
    src["ov-bookings"] = {
      type: "FeatureCollection",
      features: bookings.map((b, i) => line(b.path, { i, hid: b.bookingId })),
    };
  }

  if (selectedCityId) {
    const c = cities.find((x) => x.id === selectedCityId);
    if (c) src["ov-selected"] = { type: "FeatureCollection", features: [point(c.coord, {})] };
  }

  return { sources: src, pick };
}

// ── Layers ───────────────────────────────────────────────────────────

/** Pickable layer id -> which pick array its features index into. Topmost first. */
export const PICK_LAYERS: [string, keyof OverlayData["pick"]][] = [
  ["ov-nodes", "nodes"],
  ["ov-stops", "stops"],
  ["ov-bookings", "bookings"],
  ["ov-routes-solid", "routes"],
  ["ov-routes-dashed", "routes"],
  ["ov-arcs", "arcs"],
  ["ov-cities", "cities"],
];

const HOVER = "__none__";
const isHover = (hover: string | null): maplibregl.ExpressionSpecification => ["==", ["get", "hid"], hover ?? HOVER];
const z = (stops: [number, number | maplibregl.ExpressionSpecification][]): maplibregl.ExpressionSpecification =>
  ["interpolate", ["linear"], ["zoom"], ...stops.flat()] as maplibregl.ExpressionSpecification;

/**
 * Overlay layers, bottom to top: city dots, then lines (each over a paper casing so it
 * reads on ink dots and borders), then stop / node dots and the selected-city ring.
 * City labels sit between the dots and the lines (see basemap.ts `beforeId`).
 */
export function overlayLayers(colors: MapColors, hover: string | null, maxRank: number, selected: string | null): {
  below: maplibregl.LayerSpecification[];
  above: maplibregl.LayerSpecification[];
} {
  const paint = overlayPaint(colors, hover);
  const lineLayout: maplibregl.LineLayerSpecification["layout"] = { "line-cap": "round", "line-join": "round" };
  const below: maplibregl.LayerSpecification[] = [
    { id: "ov-cities", type: "circle", source: "ov-cities", filter: cityFilter(maxRank, selected), paint: paint["ov-cities"] },
  ];
  const above: maplibregl.LayerSpecification[] = [
    { id: "ov-arcs-casing", type: "line", source: "ov-arcs", layout: lineLayout, paint: paint["ov-arcs-casing"] },
    { id: "ov-arcs", type: "line", source: "ov-arcs", layout: lineLayout, paint: paint["ov-arcs"] },
    { id: "ov-bookings-casing", type: "line", source: "ov-bookings", layout: lineLayout, paint: paint["ov-bookings-casing"] },
    { id: "ov-bookings", type: "line", source: "ov-bookings", layout: lineLayout, paint: paint["ov-bookings"] },
    {
      id: "ov-routes-casing",
      type: "line",
      source: "ov-routes",
      layout: lineLayout,
      filter: ["!", ["get", "dashed"]],
      paint: paint["ov-routes-casing"],
    },
    {
      id: "ov-routes-solid",
      type: "line",
      source: "ov-routes",
      layout: lineLayout,
      filter: ["!", ["get", "dashed"]],
      paint: paint["ov-routes-solid"],
    },
    {
      id: "ov-routes-dashed",
      type: "line",
      source: "ov-routes",
      layout: { "line-cap": "butt", "line-join": "round" },
      filter: ["get", "dashed"],
      paint: { ...paint["ov-routes-dashed"], "line-dasharray": [2.2, 1.6] },
    },
    { id: "ov-stops", type: "circle", source: "ov-stops", paint: paint["ov-stops"] },
    { id: "ov-nodes", type: "circle", source: "ov-nodes", paint: paint["ov-nodes"] },
    { id: "ov-selected", type: "circle", source: "ov-selected", paint: paint["ov-selected"] },
  ] as maplibregl.LayerSpecification[];
  return { below, above };
}

export function cityFilter(maxRank: number, selected: string | null): maplibregl.FilterSpecification {
  return ["any", ["<=", ["get", "rank"], maxRank], ["==", ["get", "hid"], selected ?? HOVER]];
}

type Paint = Record<string, unknown>;

/** Paint for every overlay layer. Re-applied on theme and hover changes. */
export function overlayPaint(colors: MapColors, hover: string | null): Record<string, Paint> {
  const h = isHover(hover);
  // Population-sized ink dots: small and soft at world zoom so trip lines lead.
  const popR = (base: number, k: number, max: number): maplibregl.ExpressionSpecification => [
    "min",
    max,
    ["+", base, ["*", k, ["sqrt", ["/", ["get", "pop"], 10_000_000]]]],
  ];
  return {
    "ov-cities": {
      // Lie flat on the sphere so dots foreshorten toward the horizon.
      "circle-pitch-alignment": "map",
      "circle-color": colors.dot,
      "circle-radius": z([
        [1, ["case", h, 3.5, popR(0.9, 1.4, 2.2)]],
        [4, ["case", h, 5, popR(1.5, 3, 4.5)]],
        [8, ["case", h, 7, popR(2.4, 4, 6.5)]],
      ]),
      "circle-opacity": z([
        [1, ["case", h, 1, 0.42]],
        [4, ["case", h, 1, 0.7]],
        [7, ["case", h, 1, 0.85]],
      ]),
      "circle-stroke-color": colors.paper,
      "circle-stroke-width": z([[2, 0], [4, 0.8]]),
      "circle-stroke-opacity": 0.85,
    },
    "ov-arcs-casing": {
      "line-color": colors.paper,
      "line-opacity": 0.7,
      "line-width": z([[1, ["case", h, 6, 4.2]], [6, ["case", h, 7, 5.4]]]),
    },
    "ov-arcs": {
      "line-color": ["get", "color"],
      "line-width": z([[1, ["case", h, 3.6, 2.2]], [6, ["case", h, 4.4, 3]]]),
    },
    "ov-bookings-casing": {
      "line-color": colors.paper,
      "line-opacity": 0.7,
      "line-width": ["case", h, 7, 5.4],
    },
    "ov-bookings": {
      "line-color": colors.success,
      "line-width": ["case", h, 4.2, 2.8],
    },
    "ov-routes-casing": {
      "line-color": colors.paper,
      "line-opacity": 0.7,
      "line-width": ["case", h, 7, 5.4],
    },
    "ov-routes-solid": {
      "line-color": ["get", "color"],
      "line-opacity": ["case", ["get", "suggested"], 0.55, 1],
      "line-width": ["case", h, 4.2, 2.8],
    },
    "ov-routes-dashed": {
      "line-color": ["get", "color"],
      "line-opacity": ["case", ["get", "suggested"], 0.55, 1],
      "line-width": ["case", h, 4, 2.6],
    },
    "ov-stops": {
      "circle-color": ["get", "color"],
      "circle-radius": ["case", h, 5, 3.6],
      "circle-stroke-color": colors.paper,
      "circle-stroke-width": 1.5,
    },
    "ov-nodes": {
      "circle-color": ["get", "color"],
      "circle-radius": ["case", h, 6, 4.6],
      "circle-stroke-color": colors.paper,
      "circle-stroke-width": 2,
    },
    "ov-selected": {
      "circle-radius": 10,
      "circle-color": colors.accent,
      "circle-opacity": 0.18,
      "circle-stroke-color": colors.accent,
      "circle-stroke-width": 2,
    },
  };
}

/** Re-apply overlay paint (theme or hover changed). */
export function applyOverlayPaint(map: maplibregl.Map, colors: MapColors, hover: string | null): void {
  const paint = overlayPaint(colors, hover);
  for (const [id, props] of Object.entries(paint)) {
    if (!map.getLayer(id)) continue;
    for (const [k, v] of Object.entries(props)) map.setPaintProperty(id, k, v);
  }
}

/** Hover text for a picked object, or null. */
export function describe(d: PickDatum, fmtDate: (iso: string) => string): { title: string; sub?: string } | null {
  switch (d.kind) {
    case "city":
      return { title: d.name, sub: d.country };
    case "arc":
      return { title: `${d.from} to ${d.to}`, sub: `${fmtDate(d.date)} · Open trip` };
    case "stop":
      return d.name ? { title: d.name, sub: `Visited in ${d.year}` } : null;
    case "route":
      return { title: d.name, sub: d.suggested ? "Suggested trip" : d.confirmed ? "Planned trip · Confirmed" : "Planned trip" };
    case "node":
      return { title: d.name, sub: d.tripName };
    case "booking":
      return { title: `${d.from} to ${d.to}`, sub: `Booked flight · ${fmtDate(d.date)}` };
  }
}
