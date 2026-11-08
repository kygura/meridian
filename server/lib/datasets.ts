import type { MetricSurface, MetricValue } from "../../src/types.js";
import { beautySurface, qualitySurface } from "./livability.js";
import { getCities } from "./cities.js";

const TOP_STABLE_COUNTRIES: Record<string, number> = {
  Iceland: 95,
  "New Zealand": 93,
  Denmark: 92,
  Portugal: 91,
  Austria: 90,
  Slovenia: 89,
  Japan: 88,
  Switzerland: 87,
  Ireland: 86,
  "Czech Republic": 85,
  Canada: 84,
  Singapore: 83,
  Finland: 82,
  Australia: 81,
  Norway: 80,
  Germany: 79,
  Netherlands: 78,
  Belgium: 77,
  Sweden: 76,
  Spain: 75,
};

function now(): string {
  return new Date().toISOString();
}

/**
 * Weather comfort by latitude approximation.
 */
export function getWeatherSurface(): MetricSurface {
  const cities = getCities();
  const values: MetricValue[] = cities.map((c) => {
    const absLat = Math.abs(c.lat);
    let comfort: number;
    if (absLat <= 25) comfort = 75 + Math.random() * 10;
    else if (absLat <= 40) comfort = 65 + Math.random() * 20;
    else if (absLat <= 55) comfort = 45 + Math.random() * 25;
    else comfort = 20 + Math.random() * 30;

    // Make deterministic: use lat as pseudo-seed
    const seed = Math.abs(Math.round(c.lat * 100 + c.lng * 10)) % 20;
    comfort = Math.round(comfort + seed * 0.1);
    comfort = Math.min(100, Math.max(0, comfort));

    return {
      locationId: c.id,
      lat: c.lat,
      lng: c.lng,
      raw: comfort,
      unit: "comfort-index",
      normalized: comfort,
      label: comfort >= 70 ? "Pleasant" : comfort >= 45 ? "Moderate" : "Harsh",
    };
  });

  return {
    id: "weather",
    label: "Weather Comfort",
    category: "weather",
    source: "latitude-approximation",
    updatedAt: now(),
    granularity: "city",
    confidence: "low",
    values,
  };
}

/**
 * Peace/stability by country.
 */
export function getStabilitySurface(): MetricSurface {
  const cities = getCities();
  const values: MetricValue[] = cities.map((c) => {
    const score = TOP_STABLE_COUNTRIES[c.country] ?? 50;
    return {
      locationId: c.id,
      lat: c.lat,
      lng: c.lng,
      raw: score,
      unit: "stability-index",
      normalized: score,
      label: score >= 80 ? "Very Stable" : score >= 60 ? "Stable" : "Moderate",
    };
  });

  return {
    id: "stability",
    label: "Political Stability",
    category: "stability",
    source: "gpi-approximation",
    updatedAt: now(),
    granularity: "country",
    confidence: "medium",
    values,
  };
}

/**
 * Population density from population field.
 */
export function getDensitySurface(): MetricSurface {
  const cities = getCities();
  const maxPop = Math.max(...cities.map((c) => c.population), 1);

  const values: MetricValue[] = cities.map((c) => {
    const normalized = Math.round((c.population / maxPop) * 100);
    return {
      locationId: c.id,
      lat: c.lat,
      lng: c.lng,
      raw: c.population,
      unit: "population",
      normalized,
      label:
        c.population >= 10_000_000
          ? "Megacity"
          : c.population >= 1_000_000
            ? "Major City"
            : "City",
    };
  });

  return {
    id: "density",
    label: "Population Density",
    category: "density",
    source: "worldcities-dataset",
    updatedAt: now(),
    granularity: "city",
    confidence: "high",
    values,
  };
}

/**
 * Synthesized internet speed / connectivity.
 */
export function getConnectivitySurface(): MetricSurface {
  const cities = getCities();
  const values: MetricValue[] = cities.map((c) => {
    let h = 7;
    for (let i = 0; i < c.country.length; i++) {
      h = (h * 37 + c.country.charCodeAt(i)) | 0;
    }
    const base = ((h >>> 0) % 70) + 25; // 25-95
    const score = Math.min(100, Math.max(0, base));
    return {
      locationId: c.id,
      lat: c.lat,
      lng: c.lng,
      raw: score,
      unit: "mbps-index",
      normalized: score,
      label:
        score >= 75
          ? "Excellent"
          : score >= 50
            ? "Good"
            : score >= 30
              ? "Fair"
              : "Poor",
    };
  });

  return {
    id: "connectivity",
    label: "Internet Connectivity",
    category: "connectivity",
    source: "synthesized",
    updatedAt: now(),
    granularity: "city",
    confidence: "low",
    values,
  };
}

/**
 * Synthesized tourism pressure / seasonal activity.
 */
export function getTourismSurface(): MetricSurface {
  const cities = getCities();
  const maxPop = Math.max(...cities.map((c) => c.population), 1);
  const values: MetricValue[] = cities.map((c) => {
    let h = 13;
    for (let i = 0; i < c.name.length; i++) {
      h = (h * 29 + c.name.charCodeAt(i)) | 0;
    }
    const noise = ((h >>> 0) % 40) - 20;
    const popPull = Math.round((c.population / maxPop) * 60);
    const score = Math.min(100, Math.max(0, 35 + popPull + noise));
    return {
      locationId: c.id,
      lat: c.lat,
      lng: c.lng,
      raw: score,
      unit: "tourism-index",
      normalized: score,
      label: score >= 70 ? "Crowded" : score >= 45 ? "Active" : "Quiet",
    };
  });

  return {
    id: "tourism",
    label: "Tourism Pressure",
    category: "tourism",
    source: "synthesized",
    updatedAt: now(),
    granularity: "city",
    confidence: "low",
    values,
  };
}

/**
 * Synthesized cost of living (higher normalized = more affordable).
 */
export function getCostSurface(): MetricSurface {
  const cities = getCities();
  const values: MetricValue[] = cities.map((c) => {
    let h = 5;
    for (let i = 0; i < c.country.length; i++) {
      h = (h * 41 + c.country.charCodeAt(i)) | 0;
    }
    const base = ((h >>> 0) % 65) + 20; // 20-85 affordability
    const score = Math.min(100, Math.max(0, base));
    return {
      locationId: c.id,
      lat: c.lat,
      lng: c.lng,
      raw: score,
      unit: "affordability-index",
      normalized: score,
      label: score >= 70 ? "Affordable" : score >= 45 ? "Moderate" : "Pricey",
    };
  });

  return {
    id: "cost",
    label: "Living Cost",
    category: "cost",
    source: "synthesized",
    updatedAt: now(),
    granularity: "country",
    confidence: "low",
    values,
  };
}

const ALL_SURFACES = [
  "weather",
  "stability",
  "density",
  "quality",
  "beauty",
  "connectivity",
  "tourism",
  "cost",
] as const;

const SURFACE_GETTERS: Record<string, () => MetricSurface> = {
  weather: getWeatherSurface,
  stability: getStabilitySurface,
  density: getDensitySurface,
  // Real data from data/livability.json (server/lib/livability.ts), not the old hash.
  quality: qualitySurface,
  beauty: beautySurface,
  connectivity: getConnectivitySurface,
  tourism: getTourismSurface,
  cost: getCostSurface,
};

export function getSurfaceById(id: string): MetricSurface | undefined {
  const getter = SURFACE_GETTERS[id];
  return getter ? getter() : undefined;
}

export function listSurfaces(): Array<{
  id: string;
  label: string;
  category: string;
}> {
  return ALL_SURFACES.map((id) => {
    const surface = SURFACE_GETTERS[id]!();
    return { id: surface.id, label: surface.label, category: surface.category };
  });
}

export function getCityMetrics(
  cityId: string
): Record<string, MetricValue> | undefined {
  const result: Record<string, MetricValue> = {};
  for (const id of ALL_SURFACES) {
    const surface = SURFACE_GETTERS[id]!();
    const val = surface.values.find((v) => v.locationId === cityId);
    if (val) result[id] = val;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
