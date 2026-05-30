export interface City {
  id: string;
  name: string;
  lat: number;
  lng: number;
  country: string;
  population: number;
  iata?: string;
  region?: string;
  timezone?: string;
  currency?: string;
}

export type MetricCategory =
  | "weather"
  | "stability"
  | "density"
  | "tourism"
  | "quality"
  | "mobility"
  | "cost"
  | "connectivity"
  | "events";

export type Granularity =
  | "city"
  | "country"
  | "region"
  | "route"
  | "point"
  | "polygon";

export type Confidence = "high" | "medium" | "low";

export interface MetricValue {
  locationId: string;
  lat: number;
  lng: number;
  raw: number;
  unit: string;
  normalized: number; // 0-100
  label?: string;
}

export interface MetricSurface {
  id: string;
  label: string;
  category: MetricCategory;
  source: string;
  updatedAt: string;
  granularity: Granularity;
  confidence: Confidence;
  values: MetricValue[];
}

export interface MeridianScore {
  overall: number;
  economics: number;
  quality: number;
  climate: number;
  stability: number;
  nomadInfra: number;
}

export interface TripNode {
  cityId: string;
  name: string;
  iata?: string;
  lat: number;
  lng: number;
}

export interface Trip {
  id: string;
  name: string;
  color: "a" | "b" | "c";
  status: "draft" | "scouting" | "confirmed";
  nodes: TripNode[];
}

export interface ShortlistEntry {
  cityId: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  iata?: string;
  addedAt: string;
  score?: number;
}

export interface AgentBrief {
  cityId: string;
  generatedAt: string;
  seasonality: string;
  news: string;
  costEstimates: string;
  recommendations: string;
  score?: number;
}

export interface TickerItem {
  glyph: "alert" | "hazard" | "info" | "good";
  location: string;
  text: string;
  time: string;
}

export interface CityMetrics {
  safety?: number;
  cost?: number;
  happiness?: number;
  weather?: number;
  stability?: number;
  tourism?: number;
  internet?: number;
  density?: number;
  peace?: number;
  corruption?: number;
  english?: number;
}

export type LayerKey =
  | "trips"
  | "routes"
  | "cities"
  | "weather"
  | "stability"
  | "density"
  | "tourism"
  | "quality"
  | "cost"
  | "internet"
  | "conflict"
  | "disaster";

export type DrawerSide = "left" | "right" | null;
