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
  /** The city's name in its own language and script ("東京", "Москва"), when it differs. */
  nativeName?: string;
  /** Which piece of land the city is on (data/city-geo.json); equal ids are joined by land. */
  landmass?: number;
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
  | "events"
  | "beauty";

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

/**
 * Months of the year, inclusive, with no year attached: {start: 2, end: 7} is
 * February to July. start > end wraps the new year ({start: 11, end: 2} is
 * November to February). A trip is a season you can take any year; a year is
 * only chosen to get concrete (dates, flights, holidays).
 */
export interface MonthSpan {
  start: number; // 1-12
  end: number; // 1-12
}

export interface TripNode {
  cityId: string;
  name: string;
  iata?: string;
  lat: number;
  lng: number;
  /** When in the season this stop happens. Absent = not placed yet. */
  months?: MonthSpan;
  /** Itinerary (ADR 0010), used once the trip has a year. YYYY-MM-DD. */
  arrive?: string;
  depart?: string;
  lodging?: TripLodging;
  activities?: TripActivity[];
  notes?: string;
  /** How you get to this stop: transport mode and a booking recorded by hand. */
  travel?: LegPlan;
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
  /** The trip's season when no stop has months; otherwise derived from the stops. */
  season?: MonthSpan;
  /** The year this season is planned for, once it gets concrete. Absent = any year. */
  year?: number;
  /**
   * Where the trip leaves from: the traveller's home airport. Absent = the default
   * departure (store.homeDeparture, Las Palmas / LPA unless changed).
   */
  departure?: TripNode;
  /** Fly back to the departure after the last stop. Absent = true. */
  returnHome?: boolean;
  /** How many people travel, for search links. Absent = 1. */
  travellers?: number;
  /** The leg home from the last stop (the other legs live on the stop they arrive at). */
  homeLeg?: LegPlan;
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
  /** Set when the place came from a journal replay (find_similar_windows): the matched month + breakdown. */
  replayMatch?: { match: number; month: number; dims: ReplayDimScore[]; scoredOn: FingerprintDim[] };
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
  /** Where this stop came from; set on imported stops (accepted candidates). */
  provenance?: Provenance;
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
  /** Why the crowd proxy is degraded (holiday data missing/partial); absent when complete or overridden. */
  crowdFlags?: ("holidays_unavailable" | "holidays_partial")[];
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
  /** "dealRating": no user baseline, scored on the provider's deal rating (templateValue is a placeholder). */
  basis?: "dealRating";
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
  /**
   * Where the template's comfort/tempC/precipMm came from: "observed" = the stay's
   * real weather (or values given in a partial fingerprint), "normal" = the city's
   * seasonality normal because observed weather is pending/absent (never stored),
   * "none" = no climate dims.
   */
  templateClimate?: "observed" | "normal" | "none";
}

// ── Ingestion ───────────────────────────────────────────────────────

export type ImportKind = "segment" | "lodging" | "experience" | "stop";
export type ImportState = "pending" | "accepted" | "merged" | "discarded";

/** Money as imports carry it: the server fills eur/rateDate when the journey is built (R5). */
export type MoneyInput = Omit<Money, "eur" | "rateDate"> & Partial<Pick<Money, "eur" | "rateDate">>;

/** Candidate payloads are partial journey pieces; cost/lodging have no provenance or EUR yet. */
export type ImportPayload = Partial<Omit<Segment & Stop & Experience & Lodging, "cost" | "lodging" | "provenance" | "kind">> & {
  /** Experience kind or lodging kind, depending on the candidate's `kind`. */
  kind?: ExperienceKind | NonNullable<Lodging["kind"]>;
  cost?: MoneyInput;
  lodging?: { name: string; kind?: Lodging["kind"]; cost?: MoneyInput };
  cityHint?: string;
  iataHint?: string;
  toCityHint?: string;
  toIataHint?: string;
};

export interface ImportCandidate {
  id: string;
  kind: ImportKind;
  payload: ImportPayload;
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

/** An event placed on one of its cities, for the map (GET /api/overlays/events). */
export interface MapEventPoint {
  eventId: string;
  title: string;
  kind: MeridianEvent["kind"];
  date?: string;
  recurring: boolean;
  cityId: string;
  cityName: string;
  country: string;
  lat: number;
  lng: number;
}

/**
 * A conflict, an advisory (a standing problem such as unsafe rail) or a seasonal hazard
 * (data/phenomena.json, GET /api/overlays/anomalies).
 */
export interface MapAnomaly {
  id: string;
  kind: "conflict" | "advisory" | "hazard";
  /** Risk topic for advisories: transport, safety, unrest, governance, health, utilities. */
  topic?: string;
  /** Longer explanation, shown in the city panel. */
  detail?: string;
  /** YYYY-MM the advisory has applied since. */
  since?: string;
  sources?: { title: string; url: string }[];
  /** war, insurgency, unrest, storm, flood, fire, heat, air, dust... */
  type?: string;
  label: string;
  /** worldcities.csv spelling; set for conflicts so matching cities can be excluded. */
  country?: string;
  lat: number;
  lng: number;
  /** 1 (watch) .. 3 (avoid). */
  severity: number;
  /** Months (1-12) a hazard is in season; absent = standing. */
  months?: number[];
  /** Peak months within the season. */
  peak?: number[];
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

// ── Notices (ADR 0016) ───────────────────────────────────────────────

/** How one channel fared for one Notice. */
export interface NoticeDelivery {
  channel: string;
  ok: boolean;
  error?: string;
  at: string;
}

/** A message Meridian raised for the owner: logged first, then sent through every configured channel. */
export interface Notice {
  id: string;
  /** What raised it, e.g. "watch-alert", "test". */
  kind: string;
  title: string;
  body: string;
  /** App-relative link ("/#/plan/watches") or an absolute URL. */
  url?: string;
  dedupeKey: string;
  createdAt: string;
  seen: boolean;
  deliveries: NoticeDelivery[];
}

/** A delivery channel as Settings shows it. Never carries a secret. */
export interface NoticeChannelStatus {
  id: string;
  label: string;
  configured: boolean;
  detail?: string;
}

// ── Itinerary (ADR 0010) ────────────────────────────────────────────
// Concrete plans on a Trip once it has a year. Costs are kept as entered
// (MoneyInput: amount + currency); nothing here is converted or booked by Meridian.

export type LegMode = "flight" | "train" | "bus" | "ferry" | "drive";

/** Where you sleep at a trip stop. Mirrors the journal's Lodging, plus what a plan needs. */
export interface TripLodging {
  name: string;
  kind?: Lodging["kind"];
  address?: string;
  /** YYYY-MM-DD; default to the stop's arrival and departure. */
  checkIn?: string;
  checkOut?: string;
  /** Total for the stay. */
  cost?: MoneyInput;
  bookingRef?: string;
  link?: string;
}

/** Something planned at a trip stop. Becomes an Experience once it has happened. */
export interface TripActivity {
  id: string;
  title: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM, local to the stop
  cost?: MoneyInput;
  link?: string;
  note?: string;
}

/** A booking made somewhere else and written down on a leg. Times are local: YYYY-MM-DDTHH:MM. */
export interface LegRecord {
  carrier?: string;
  number?: string;
  reference?: string;
  cost?: MoneyInput;
  departAt?: string;
  arriveAt?: string;
}

/**
 * The plan for one leg, stored on the stop it arrives at (Trip.homeLeg for the way home).
 * `fromCityId` is the city it left from when it was written: reorder the route and the
 * plan no longer matches, so it is ignored.
 */
export interface LegPlan {
  fromCityId: string;
  /** Absent = the default for the distance and geography. */
  mode?: LegMode;
  booked?: LegRecord;
}
