// Test fixtures for the solver: a small pool of real places with hand-set readings. The
// readings are test inputs, not data shown to anyone.

import type { FitLevel, StayKind } from "../rotation";
import type { Candidate, Constraints, SolveInput } from "./types";

type Lv = FitLevel;

function months(levels: Lv[]): Candidate["months"] {
  return levels.map((level) => ({ level, source: "comfort" as const, why: `test ${level}` }));
}

const all = (l: Lv): Lv[] => Array.from({ length: 12 }, () => l);

export function cand(
  cityId: string,
  name: string,
  country: string,
  lat: number,
  lng: number,
  opts: Partial<Candidate> & { levels?: Lv[]; cost?: number | null; kind?: StayKind } = {}
): Candidate {
  const { levels, cost, kind, ...rest } = opts;
  return {
    place: { cityId, name, country, lat, lng, iata: cityId.slice(0, 3).toUpperCase() },
    kind: kind ?? "base",
    minNights: kind === "pass-through" ? 2 : 28,
    maxNights: kind === "pass-through" ? 5 : 92,
    months: months(levels ?? all("good")),
    costMonthlyEur: cost === null ? null : { value: cost ?? 1500, source: "test" },
    internetMbps: { value: 100, source: "test" },
    healthUhc: { value: 80, source: "test" },
    coastKm: null,
    risks: [],
    inPool: true,
    ...rest,
  };
}

// Jan..Dec
const winterSun: Lv[] = ["great", "great", "great", "good", "fair", "poor", "poor", "poor", "fair", "good", "great", "great"];
const summerNorth: Lv[] = ["poor", "poor", "fair", "good", "great", "great", "great", "great", "good", "fair", "poor", "poor"];
const shoulder: Lv[] = ["fair", "fair", "good", "great", "great", "good", "fair", "fair", "great", "great", "good", "fair"];

export const POOL: Candidate[] = [
  cand("lisbon", "Lisbon", "Portugal", 38.72, -9.14, { levels: shoulder, cost: 2200, coastKm: { value: 2, source: "test" }, region: "europe" }),
  cand("porto", "Porto", "Portugal", 41.15, -8.61, { levels: summerNorth, cost: 1800, coastKm: { value: 3, source: "test" }, region: "europe" }),
  cand("valencia", "Valencia", "Spain", 39.47, -0.38, { levels: shoulder, cost: 1900, coastKm: { value: 2, source: "test" }, region: "europe" }),
  cand("krakow", "Krakow", "Poland", 50.06, 19.94, { levels: summerNorth, cost: 1500, coastKm: { value: 400, source: "test" }, region: "europe" }),
  cand("tbilisi", "Tbilisi", "Georgia", 41.72, 44.79, { levels: shoulder, cost: 1300, coastKm: { value: 280, source: "test" }, region: "europe" }),
  cand("chiang-mai", "Chiang Mai", "Thailand", 18.79, 98.98, { levels: winterSun, cost: 1200, coastKm: { value: 400, source: "test" }, region: "asia" }),
  cand("da-nang", "Da Nang", "Vietnam", 16.05, 108.2, { levels: ["good", "great", "great", "great", "good", "fair", "fair", "fair", "poor", "poor", "fair", "good"], cost: 1100, coastKm: { value: 1, source: "test" }, region: "asia" }),
  cand("bali", "Denpasar", "Indonesia", -8.65, 115.22, { levels: ["fair", "fair", "fair", "good", "great", "great", "great", "great", "great", "good", "fair", "fair"], cost: 1600, coastKm: { value: 3, source: "test" }, region: "asia" }),
  cand("mexico-city", "Mexico City", "Mexico", 19.43, -99.13, { levels: shoulder, cost: 1700, coastKm: { value: 290, source: "test" }, region: "americas" }),
  cand("bangkok", "Bangkok", "Thailand", 13.75, 100.5, { kind: "pass-through", levels: winterSun, cost: 1500, region: "asia" }),
  cand("istanbul", "Istanbul", "Turkey", 41.01, 28.98, { kind: "pass-through", levels: shoulder, cost: 1600, region: "europe" }),
];

export const BASE_CONSTRAINTS: Constraints = {
  schengen: true,
  countryRules: [],
  allowBorderRuns: false,
  taxDays: 183,
  minInternetMbps: null,
  minHealthUhc: null,
  avoidIsHard: true,
};

export function baseInput(over: Partial<SolveInput> = {}): SolveInput {
  return {
    start: "2027-01-01",
    months: 12,
    from: { cityId: "las-palmas", name: "Las Palmas", country: "Spain", lat: 28.1, lng: -15.43, iata: "LPA" },
    budgetMonthlyEur: 1800,
    candidates: POOL,
    fixed: [],
    prior: [],
    constraints: BASE_CONSTRAINTS,
    preferences: [],
    weights: { fit: 1, cost: 0.8, friction: 0.6, visa: 0.6, risk: 0.6, preferences: 0.8 },
    results: 3,
    seed: 7,
    beamWidth: 48,
    ...over,
  };
}
