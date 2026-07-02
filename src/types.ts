export interface City {
  id: string;
  name: string;
  lat: number;
  lng: number;
  country: string;
  population: number;
  iata?: string;
  /** True national capital (from mledoze/countries). */
  capital?: boolean;
  /** Airport class serving this city, when matched. */
  hub?: "large" | "medium";
  /** Full airport name (searchable, e.g. "Penang International Airport"). */
  airportName?: string;
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

export interface TripEstimate {
  priceEstimate: number;
  currency: string;
  dateRange: { start: string; end: string };
  /** Where priceEstimate came from — "mock" is the deterministic placeholder. */
  source?: "mock" | "duffel" | "serpapi";
  /** How priceEstimate compares to real market prices, when a provider supplied it. */
  dealRating?: "low" | "typical" | "high";
}

export interface Trip {
  id: string;
  name: string;
  color: "a" | "b" | "c";
  status: "draft" | "scouting" | "confirmed";
  nodes: TripNode[];
  /** "agent" = generated candidate awaiting confirmation; "manual" = user-owned trip. */
  origin?: "agent" | "manual";
  estimate?: TripEstimate;
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

export interface ResearchSection {
  title: string;
  items: string[];
}

export interface CostBreakdown {
  rent: string;
  food: string;
  transport: string;
  coworking: string;
  healthcare: string;
  totalBudget: string;
  currency: string;
}

export interface VisaInfo {
  touristVisa: string;
  visaOnArrival: string;
  eVisa: string;
  digitalNomadVisa: string;
  commonPassportNotes: string;
}

export interface ConnectivityInfo {
  avgDownloadMbps: string;
  mobileCoverage: string;
  coworkingSpaces: string;
  cafeWifi: string;
}

export interface CityResearch {
  cityId: string;
  generatedAt: string;
  summary: string;
  livingConditions: ResearchSection;
  costBreakdown: CostBreakdown;
  visa: VisaInfo;
  connectivity: ConnectivityInfo;
  safetyNotes: string[];
  seasonalAdvice: string;
  nearbyDestinations: NearbyDestination[];
}

export interface NearbyDestination {
  cityId: string;
  name: string;
  country: string;
  iata?: string;
  lat: number;
  lng: number;
  distance: string;
  reason: string;
}

export interface TripOption {
  id: string;
  label: string;
  type: "single" | "multi-hop";
  nodes: TripNode[];
  totalDistance?: string;
  highlight: string;
  estimate: TripEstimate;
}

export interface TickerItem {
  glyph: "alert" | "hazard" | "info" | "good";
  location: string;
  text: string;
  time: string;
  source?: string;
  url?: string;
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
