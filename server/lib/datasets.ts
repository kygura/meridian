// Metric surfaces: one value per city for the map's colour-and-filter layers, the city panel
// and the World screen. Every surface is computed from a measured dataset (ADR 0008, ADR 0013):
// a city the dataset doesn't cover has no value on that surface, and the client shows the gap.

import type { City, MetricSurface, MetricValue } from "../../src/types.js";
import { beautySurface, qualitySurface } from "./livability.js";
import { getCities, getCityById } from "./cities.js";
import { placeDataInfo, placeFacts, type PlaceFacts } from "./placeData.js";
import { getAllCitySeasonality } from "./seasonality.js";

type Extra = Pick<MetricValue, "granularity" | "year" | "source" | "estimate" | "note">;

function value(c: City, raw: number, unit: string, normalized: number, label: string, extra: Extra): MetricValue {
  return { locationId: c.id, lat: c.lat, lng: c.lng, raw, unit, normalized, label, ...extra };
}

const eur = (n: number) => `€${n.toLocaleString("en-US")}`;

function costValue(c: City, f: PlaceFacts): MetricValue | undefined {
  const m = f.cost.monthlyEur;
  if (!m || f.scores.cost === null) return undefined;
  const s = f.scores.cost;
  return value(c, m.value, "EUR per month", s, s >= 70 ? "Affordable" : s >= 45 ? "Moderate" : "Pricey", {
    granularity: m.granularity,
    year: m.year,
    source: m.source,
    estimate: true,
    note: `About ${eur(m.value)} a month for one person`,
  });
}

function connectivityValue(c: City, f: PlaceFacts): MetricValue | undefined {
  const s = f.scores.connectivity;
  const net = f.internet.fixed ?? f.internet.mobile;
  if (s === null || !net) return undefined;
  return value(c, net.downMbps, "Mbps", s, s >= 75 ? "Excellent" : s >= 50 ? "Good" : s >= 30 ? "Fair" : "Poor", {
    granularity: "city",
    source: "internet",
    note: `${net.downMbps} Mbps down, ${net.upMbps} up${f.internet.fixed ? "" : " (mobile)"}`,
  });
}

function stabilityValue(c: City, f: PlaceFacts): MetricValue | undefined {
  const s = f.scores.stability;
  if (s === null) return undefined;
  const e = f.stability.estimate;
  return value(c, e?.value ?? f.stability.homicides!.value, e ? "stability estimate" : "homicides per 100,000", s, s >= 80 ? "Very Stable" : s >= 60 ? "Stable" : s >= 40 ? "Mixed" : "Unsettled", {
    granularity: "country",
    year: e?.year,
    source: e ? "stability" : "homicides",
  });
}

function tourismValue(c: City, f: PlaceFacts): MetricValue | undefined {
  const s = f.scores.tourism;
  const a = f.crowds.arrivalsPerResident;
  if (s === null || !a) return undefined;
  return value(c, a.value, "arrivals per resident", s, s >= 70 ? "Crowded" : s >= 45 ? "Active" : "Quiet", {
    granularity: "country",
    year: a.year,
    source: "arrivals",
    note: `${a.value} visitors from abroad per resident a year`,
  });
}

function healthValue(c: City, f: PlaceFacts): MetricValue | undefined {
  const s = f.scores.health;
  const u = f.health.uhc;
  if (s === null || !u) return undefined;
  return value(c, u.value, "UHC index", s, s >= 80 ? "Strong" : s >= 60 ? "Adequate" : "Limited", { granularity: "country", year: u.year, source: "uhc" });
}

function densityValue(c: City, maxPop: number): MetricValue | undefined {
  if (!(c.population > 0)) return undefined;
  return value(
    c,
    c.population,
    "population",
    Math.round((c.population / maxPop) * 100),
    c.population >= 10_000_000 ? "Megacity" : c.population >= 1_000_000 ? "Major City" : "City",
    { granularity: "city", source: "worldcities-dataset" }
  );
}

/** Year-round Comfort Index: the mean of the city's twelve monthly scores, where climate data covers it. */
function weatherValue(c: City, months: { score: number }[] | undefined): MetricValue | undefined {
  if (!months || months.length !== 12) return undefined;
  const comfort = Math.round(months.reduce((a, m) => a + m.score, 0) / 12);
  return value(c, comfort, "comfort-index", comfort, comfort >= 70 ? "Pleasant" : comfort >= 45 ? "Moderate" : "Harsh", {
    granularity: "city",
    source: "comfort-index",
  });
}

type FactSurfaceId = "stability" | "connectivity" | "tourism" | "cost" | "health";

const FACT_SURFACES: Record<
  FactSurfaceId,
  { label: string; pick: (c: City, f: PlaceFacts) => MetricValue | undefined; granularity: MetricSurface["granularity"]; sourceKeys: string[] }
> = {
  stability: { label: "Safety and Stability", pick: stabilityValue, granularity: "country", sourceKeys: ["stability"] },
  connectivity: { label: "Internet Speed", pick: connectivityValue, granularity: "city", sourceKeys: ["internet"] },
  tourism: { label: "Tourism Pressure", pick: tourismValue, granularity: "country", sourceKeys: ["arrivals"] },
  cost: { label: "Living Cost", pick: costValue, granularity: "country", sourceKeys: ["costCountry", "costAnchor"] },
  health: { label: "Healthcare", pick: healthValue, granularity: "country", sourceKeys: ["uhc"] },
};

const HOMICIDE_SOURCE = "World Bank VC.IHR.PSRC.P5 (UNODC), homicides per 100,000";

function sourceText(keys: string[]): string {
  const { sources } = placeDataInfo();
  const names = keys.map((k) => sources[k]?.name).filter(Boolean) as string[];
  return names.length ? names.join("; ") : "unavailable";
}

function factSurface(id: FactSurfaceId): MetricSurface {
  const def = FACT_SURFACES[id];
  const values: MetricValue[] = [];
  for (const c of getCities()) {
    const v = def.pick(c, placeFacts(c));
    if (v) values.push(v);
  }
  const info = placeDataInfo();
  return {
    id,
    label: def.label,
    category: id,
    source: id === "stability" ? `${sourceText(def.sourceKeys)}; ${HOMICIDE_SOURCE}` : sourceText(def.sourceKeys),
    updatedAt: info.builtAt ?? new Date(0).toISOString(),
    granularity: def.granularity,
    confidence: values.length ? (id === "cost" ? "medium" : "high") : "low",
    values,
  };
}

function weatherSurface(): MetricSurface {
  const all = getAllCitySeasonality();
  const values: MetricValue[] = [];
  for (const c of getCities()) {
    const v = weatherValue(c, all[c.id]);
    if (v) values.push(v);
  }
  return {
    id: "weather",
    label: "Year-round Comfort",
    category: "weather",
    source: "Comfort Index from Open-Meteo climate data, mean of the twelve months",
    updatedAt: new Date().toISOString(),
    granularity: "city",
    confidence: "medium",
    values,
  };
}

function densitySurface(): MetricSurface {
  const cities = getCities();
  const maxPop = Math.max(...cities.map((c) => c.population), 1);
  const values: MetricValue[] = [];
  for (const c of cities) {
    const v = densityValue(c, maxPop);
    if (v) values.push(v);
  }
  return {
    id: "density",
    label: "Population",
    category: "density",
    source: "worldcities-dataset",
    updatedAt: new Date(0).toISOString(),
    granularity: "city",
    confidence: "high",
    values,
  };
}

const ALL_SURFACES = ["weather", "stability", "density", "quality", "beauty", "connectivity", "tourism", "cost", "health"] as const;

const SURFACE_GETTERS: Record<string, () => MetricSurface> = {
  weather: weatherSurface,
  stability: () => factSurface("stability"),
  density: densitySurface,
  quality: qualitySurface,
  beauty: beautySurface,
  connectivity: () => factSurface("connectivity"),
  tourism: () => factSurface("tourism"),
  cost: () => factSurface("cost"),
  health: () => factSurface("health"),
};

// The datasets are read-only files, so a built surface is good for the life of the process.
// Weather is the exception: on-demand climate fetches add cities at runtime.
const surfaceCache = new Map<string, MetricSurface>();

/** Test seam. */
export function resetSurfaceCache(): void {
  surfaceCache.clear();
}

export function getSurfaceById(id: string): MetricSurface | undefined {
  const getter = SURFACE_GETTERS[id];
  if (!getter) return undefined;
  if (id === "weather") return getter();
  let s = surfaceCache.get(id);
  if (!s) {
    s = getter();
    surfaceCache.set(id, s);
  }
  return s;
}

const SURFACE_LABELS: Record<(typeof ALL_SURFACES)[number], string> = {
  weather: "Year-round Comfort",
  stability: "Safety and Stability",
  density: "Population",
  quality: "Quality of Life",
  beauty: "Beauty",
  connectivity: "Internet Speed",
  tourism: "Tourism Pressure",
  cost: "Living Cost",
  health: "Healthcare",
};

export function listSurfaces(): Array<{ id: string; label: string; category: string }> {
  return ALL_SURFACES.map((id) => ({ id, label: SURFACE_LABELS[id], category: id }));
}

/** One city's value on every surface that has one. Surfaces with no data for the city are absent. */
export function getCityMetrics(cityId: string): Record<string, MetricValue> | undefined {
  const city = getCityById(cityId);
  if (!city) return undefined;
  const facts = placeFacts(city);
  const result: Record<string, MetricValue> = {};
  const put = (id: string, v: MetricValue | undefined) => {
    if (v) result[id] = v;
  };
  put("weather", weatherValue(city, getAllCitySeasonality()[cityId]));
  for (const id of Object.keys(FACT_SURFACES) as FactSurfaceId[]) put(id, FACT_SURFACES[id].pick(city, facts));
  for (const id of ["quality", "beauty"] as const) put(id, getSurfaceById(id)?.values.find((v) => v.locationId === cityId));
  return Object.keys(result).length > 0 ? result : undefined;
}
