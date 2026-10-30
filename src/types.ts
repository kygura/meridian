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
  /** Hex color from TRIP_COLORS (legacy "a"/"b"/"c" resolved via resolveTripColor). */
  color: string;
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

// ── Agent tool core (server/lib/agent/tools.ts) ─────────────────────

export interface PlaceResult {
  cityId: string;
  name: string;
  country: string;
  iata?: string;
  lat: number;
  lng: number;
  population: number;
  score: number;
  summaryLine: string;
}

export interface PlaceImage {
  url: string;
  thumbUrl: string;
  title: string;
  /** Always present — Wikipedia or Wikimedia Commons credit text. */
  attribution: string;
  sourcePage: string;
}

export interface SeasonalityMonth {
  score: number;
  tempC: number;
  precipMm: number;
}

export interface SeasonalityResult {
  available: boolean;
  months?: SeasonalityMonth[];
}

export interface FlightEstimateResult {
  priceAmount: number;
  currency: string;
  airline?: string;
  departingAt?: string;
  arrivingAt?: string;
  source: "duffel" | "serpapi" | "mock";
  dealRating?: "low" | "typical" | "high";
}

export type LayerKey =
  | "trips"
  | "routes"
  | "cities"
  | "weather"
  | "cost"
  | "conflict"
  | "disaster"
  | "journeys";

export type DrawerSide = "left" | "right" | null;

// ── Journal & Replay (spec-journal.md) ──────────────────────────────
// A Journey is something that happened; a Trip is a client-side plan
// (ADR 0004). Months in every journal/replay API are 1-based (1 = Jan).

export type ProvenanceSource =
  | "manual"
  | "booking"
  | "gmail"
  | "jsonld"
  | "calendar"
  | "timeline"
  | "photo";

export interface Provenance {
  source: ProvenanceSource;
  /** Gmail message id, booking id, photo hash, etc. Required on imports (dedupe key). */
  sourceRef?: string;
  confidence: Confidence;
  importedAt?: string;
}

/** Original amount plus its EUR value at the ECB rate for `rateDate`. */
export interface Money {
  amount: number;
  currency: string;
  eur: number;
  rateDate: string;
}

export type Rating = 1 | 2 | 3 | 4 | 5;

export interface ObservedConditions {
  tempC: number;
  /** Mean over the stay, scaled to a monthly-equivalent total. */
  precipMm: number;
  comfort: number;
  /** The city's seasonality normal for that month ("was it a lucky week"). */
  normalComfort: number;
  /** The city's normal mean temperature for that month, when known. */
  normalTempC?: number;
}

export interface Lodging {
  name: string;
  kind?: "hotel" | "apartment" | "hostel" | "friends" | "other";
  cost?: Money;
  provenance: Provenance;
}

export interface Stop {
  cityId: string;
  arrive: string; // YYYY-MM-DD
  depart: string; // YYYY-MM-DD
  lodging?: Lodging;
  rating?: Rating;
  /** User override of the crowd proxy, 0-100 ("it was packed"). Wins over the proxy. */
  crowdOverride?: number;
  observed?: ObservedConditions;
  fingerprint?: Fingerprint;
}

export type SegmentMode = "flight" | "train" | "bus" | "car" | "ferry" | "other";

export interface Segment {
  mode: SegmentMode;
  fromCityId: string;
  toCityId: string;
  departAt: string; // ISO date or datetime
  arriveAt?: string;
  carrier?: string;
  number?: string; // "TP1023"
  cost?: Money;
  bookingRef?: string;
  bookingId?: string;
  provenance: Provenance;
}

export type ExperienceKind = "food" | "tour" | "nature" | "event" | "culture" | "nightlife" | "other";

export interface Experience {
  cityId: string;
  date: string;
  title: string;
  kind?: ExperienceKind;
  cost?: Money;
  rating?: Rating;
  lat?: number;
  lng?: number;
  provenance: Provenance;
}

export type FingerprintDim =
  | "month"
  | "comfort"
  | "tempC"
  | "precipMm"
  | "dailySpendEur"
  | "flightCostEurPer1000km"
  | "crowdProxy";

/** ok = computed from real data; pending = fetch failed/quota, will retry; absent = no input data. */
export type FingerprintDimStatus = "ok" | "pending" | "absent";

export interface Fingerprint {
  month: number; // 1-12, dominant month of the stay
  weekOfYear: number; // kept for the weekly extension (D5)
  comfort?: number;
  tempC?: number;
  precipMm?: number;
  dailySpendEur?: number;
  flightCostEurPer1000km?: number;
  /** 0-100, always a labeled proxy (or the user's override). */
  crowdProxy?: number;
  crowdIsOverride?: boolean;
  durationNights: number;
  rating?: Rating;
  tags: string[];
  status: Record<FingerprintDim, FingerprintDimStatus>;
  computedAt: string;
  /** Hash of the inputs; a change triggers recompute. */
  inputsHash: string;
}

export type JourneyStatus = "draft" | "confirmed";

export interface Journey {
  id: string;
  title: string;
  status: JourneyStatus;
  startDate: string;
  endDate: string;
  stops: Stop[];
  segments: Segment[];
  experiences: Experience[];
  rating?: Rating;
  tags: string[];
  notes?: string;
  companions?: number;
  fromTripId?: string;
  bookingIds: string[];
  fingerprint?: Fingerprint;
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
}

/** Body for create/update: server owns id, timestamps, fingerprint. */
export type JourneyInput = Omit<Journey, "id" | "createdAt" | "updatedAt" | "fingerprint"> & {
  status?: JourneyStatus;
};

export interface JournalSettings {
  homeCityId?: string;
}

// ── Replay ──────────────────────────────────────────────────────────

export interface ReplayBend {
  tempC?: number; // -10..+10
  spendPct?: number; // -50..+50
  crowd?: number; // -50..+50
  /** -6..+6; null = any month. */
  monthShift?: number | null;
}

export interface ReplayWeights {
  climate: number;
  spend: number;
  crowd: number;
  flight: number;
}

export interface ReplayQuery {
  template: { journeyId: string; stopIndex?: number } | { fingerprint: Partial<Fingerprint> };
  bend: ReplayBend;
  weights: ReplayWeights;
  constraints?: {
    months?: number[]; // 1-12
    regions?: string[];
    excludeVisited?: boolean;
    maxFlightHours?: number;
    fromCityId?: string; // defaults to home
    tags?: string[]; // event tags, e.g. ["eclipse"]
    /** Restrict to these cities (row-level watches). */
    cityIds?: string[];
  };
  limit?: number; // default 30
}

export interface ReplayDimScore {
  name: FingerprintDim;
  value: number;
  templateValue: number;
  /** Share of the final match this dimension contributed (0-1, sums to 1 over scoredOn). */
  contribution: number;
}

export interface ReplayResult {
  cityId: string;
  month: number; // 1-12
  match: number; // 0-100
  dims: ReplayDimScore[];
  scoredOn: FingerprintDim[];
  price?: FlightEstimateResult & { priceEur?: number; baselineEur?: number; distanceKm?: number };
  visitedBefore: boolean;
  events?: MeridianEvent[];
}

export interface ReplayResponse {
  results: ReplayResult[];
  /** Number of cities the climate stage could score (seasonality cache size). */
  universeSize: number;
  /** The bent template actually matched against. */
  template: Partial<Fingerprint>;
  fromCityId?: string;
  /** Stage-1 match (0-100) for all 12 months of every result city, index 0 = Jan; null = not scorable. */
  grid?: Array<{ cityId: string; months: Array<number | null> }>;
}

// ── Ingestion ───────────────────────────────────────────────────────

export type ImportKind = "segment" | "lodging" | "experience" | "stop";
export type ImportState = "pending" | "accepted" | "merged" | "discarded";

export interface ImportCandidate {
  id: string;
  kind: ImportKind;
  payload: Partial<Segment & Stop & Experience & Lodging> & { cityHint?: string; iataHint?: string; toCityHint?: string; toIataHint?: string };
  provenance: Provenance;
  suggestedJourneyId?: string;
  /** Suggested-journey cluster this candidate belongs to (recomputed on each queue change). */
  clusterId?: string;
  /** Review flags, e.g. "unresolved-city". */
  flags?: string[];
  state: ImportState;
  createdAt: string;
}

export interface ImportCluster {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  candidateIds: string[];
  cityIds: string[];
  lowConfidence: boolean;
}

export interface ImportQueue {
  candidates: ImportCandidate[];
  clusters: ImportCluster[];
}

export interface ImportReport {
  received: number;
  added: number;
  duplicates: number;
  /** Emails without schema.org markup (file uploads only). */
  unstructured?: number;
  errors?: string[];
}

// ── Watches & alerts ────────────────────────────────────────────────

export type WatchPriceRule = "below_my_median" | "deal_low" | { maxEur: number };

export interface Watch {
  id: string;
  label: string;
  query: ReplayQuery;
  leadWeeks: [number, number]; // default [6, 14]
  priceRule: WatchPriceRule;
  lastRunAt?: string;
  active: boolean;
}

export interface Alert {
  id: string;
  watchId: string;
  cityId: string;
  month: number;
  priceEur: number;
  baselineEur: number;
  source: string;
  createdAt: string;
  seen: boolean;
}

export interface MeridianEvent {
  id: string;
  title: string;
  kind: "eclipse" | "festival" | "sport" | "culture" | "other";
  cityIds: string[];
  month: number; // 1-12
  /** Specific occurrence date (YYYY-MM-DD); absent for recurring annual events. */
  date?: string;
  recurring: boolean;
  tags: string[];
}
