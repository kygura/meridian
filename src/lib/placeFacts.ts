// Measured facts about a city (GET /api/metrics/facts/:cityId, ADR 0013): cost of living, rent,
// internet, healthcare, stability and visitors, each with its source, year and how local it is.
// A fact with no data is null and is shown as a gap. Types are shared with the server
// (server/lib/placeData.ts); the helpers below are pure, the fetcher is at the bottom.

import { apiUrl } from "./api";
import type { MeridianScore } from "../types";

export type FactGranularity = "city" | "region" | "country";

export interface Fact {
  value: number;
  unit: string;
  /** Year the figure describes; 0 when the source gives none. */
  year: number;
  /** Key into `sources`. */
  source: string;
  granularity: FactGranularity;
  /** The place the figure describes when that isn't the city itself ("Bruxelles/Brussel", "Algarve"). */
  place?: string;
  /** True when the value is worked out from measured inputs rather than measured itself. */
  estimate?: boolean;
}

export interface SpeedFact {
  downMbps: number;
  upMbps: number;
  latencyMs: number;
  tests: number;
  /** Speed tests within this distance of the centre were counted. */
  radiusKm: number;
}

export interface VisitorMonths {
  /** Twelve values, 100 = the place's average month. */
  index: number[];
  /** "nights": measured nights in tourist accommodation. "pageViews": Wikipedia readers, a sign of interest only. */
  basis: "nights" | "pageViews";
  granularity: FactGranularity;
  place?: string;
  years: number[];
  source: string;
}

export interface PlaceScores {
  /** Affordability, 0-100 (higher is cheaper). */
  cost: number | null;
  connectivity: number | null;
  health: number | null;
  stability: number | null;
  /** Tourism pressure, 0-100 (higher is busier). */
  tourism: number | null;
}

export interface PlaceFacts {
  cityId: string;
  cost: {
    /** Estimated monthly spending for one person, housing included. */
    monthlyEur: Fact | null;
    /** Price level, Brussels (city) or Belgium (country) = 100. */
    index: Fact | null;
    /** Measured average rent for a 1-bedroom flat in this city. */
    rent1br: Fact | null;
    /** The same figure for the country's capital, when this city has none. A reference, never this city's rent. */
    rentReference: Fact | null;
  };
  internet: { fixed: SpeedFact | null; mobile: SpeedFact | null; source: string; period: string | null };
  health: { uhc: Fact | null; physicians: Fact | null; beds: Fact | null };
  stability: { estimate: Fact | null; homicides: Fact | null };
  crowds: {
    arrivalsPerResident: Fact | null;
    arrivals: Fact | null;
    nightsPerResident: Fact | null;
    months: VisitorMonths | null;
    /** Wikipedia interest by month, kept beside measured nights when both exist. */
    interestMonths: VisitorMonths | null;
  };
  scores: PlaceScores;
}

export interface SourceInfo {
  name: string;
  url: string;
  licence: string;
}

export interface PlaceFactsResponse extends PlaceFacts {
  score: MeridianScore;
  builtAt: string | null;
  anchor: { monthlyEur: number; yearlyEur: number; y: number; place: string } | null;
  sources: Record<string, SourceInfo>;
}

// ── Copy ─────────────────────────────────────────────────────────────

export const NO_DATA = "No data";

const eur = (n: number) => `€${n.toLocaleString("en-US")}`;

/** "City figure", "Regional figure", "Country figure". */
export function grainLabel(g: FactGranularity): string {
  return g === "city" ? "City figure" : g === "region" ? "Regional figure" : "Country figure";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The three busiest months, busiest first: "Aug, Jul, Sep". */
export function busiestMonths(index: number[], n = 3): string {
  return index
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((t) => MONTHS[t.i])
    .join(", ");
}

export interface FactRow {
  id: "cost" | "rent" | "internet" | "health" | "safety" | "crowds";
  label: string;
  /** The headline figure, or "No data". */
  value: string;
  /** Second line: the plain facts behind it. */
  detail?: string;
  /** 0-100 score, when one exists. */
  score?: number;
  /** "Estimate · country figure · 2025". Absent on a gap. */
  tag?: string;
  /** Keys of the sources this row draws on. */
  sources: string[];
  missing: boolean;
}

function tag(parts: (string | number | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}

/** The city panel's rows, in display order. Every row is always present; a gap says "No data". */
export function factRows(f: PlaceFacts, cityName: string): FactRow[] {
  const rows: FactRow[] = [];

  const cost = f.cost.monthlyEur;
  rows.push(
    cost
      ? {
          id: "cost",
          label: "Monthly cost",
          value: `About ${eur(cost.value)}`,
          detail:
            f.cost.index?.granularity === "city"
              ? `One person, housing included. Prices are ${f.cost.index.value}% of Brussels`
              : `One person, housing included. Prices are ${f.cost.index?.value}% of Belgium’s`,
          score: f.scores.cost ?? undefined,
          tag: tag(["Estimate", grainLabel(cost.granularity), cost.year || null]),
          sources: [cost.source, "costAnchor"],
          missing: false,
        }
      : { id: "cost", label: "Monthly cost", value: NO_DATA, sources: [], missing: true }
  );

  const rent = f.cost.rent1br;
  const ref = f.cost.rentReference;
  rows.push(
    rent
      ? {
          id: "rent",
          label: "Rent, 1-bedroom",
          value: `${eur(rent.value)} a month`,
          detail: "Average for a 1-bedroom flat",
          tag: tag([grainLabel("city"), rent.year || null]),
          sources: [rent.source],
          missing: false,
        }
      : {
          id: "rent",
          label: "Rent, 1-bedroom",
          value: NO_DATA,
          detail: ref ? `No figure for ${cityName}. In ${ref.place} it averages ${eur(ref.value)} a month (${ref.year})` : undefined,
          sources: ref ? [ref.source] : [],
          missing: true,
        }
  );

  const fixed = f.internet.fixed;
  const mobile = f.internet.mobile;
  const net = fixed ?? mobile;
  rows.push(
    net
      ? {
          id: "internet",
          label: "Internet",
          value: `${net.downMbps} Mbps${fixed ? "" : " mobile"}`,
          detail: [
            fixed ? `Fixed: ${fixed.downMbps} down, ${fixed.upMbps} up, ${fixed.latencyMs} ms` : "No fixed-line data",
            mobile ? `Mobile: ${mobile.downMbps} down, ${mobile.upMbps} up` : "No mobile data",
          ].join(". "),
          score: f.scores.connectivity ?? undefined,
          tag: tag([grainLabel("city"), f.internet.period, `${net.tests.toLocaleString("en-US")} tests within ${net.radiusKm} km`]),
          sources: [f.internet.source],
          missing: false,
        }
      : { id: "internet", label: "Internet", value: NO_DATA, sources: [], missing: true }
  );

  const uhc = f.health.uhc;
  const care = [
    f.health.physicians ? `${f.health.physicians.value} doctors` : null,
    f.health.beds ? `${f.health.beds.value} hospital beds` : null,
  ].filter(Boolean);
  rows.push(
    uhc || care.length
      ? {
          id: "health",
          label: "Healthcare",
          value: uhc ? `${uhc.value} of 100` : NO_DATA,
          detail: [uhc ? "WHO service coverage index" : null, care.length ? `${care.join(" and ")} per 1,000 people` : null].filter(Boolean).join(". "),
          score: f.scores.health ?? undefined,
          tag: tag([grainLabel("country"), uhc?.year || f.health.physicians?.year || null]),
          sources: [uhc && "uhc", f.health.physicians && "physicians", f.health.beds && "beds"].filter(Boolean) as string[],
          missing: !uhc,
        }
      : { id: "health", label: "Healthcare", value: NO_DATA, sources: [], missing: true }
  );

  const st = f.stability.estimate;
  const hom = f.stability.homicides;
  rows.push(
    f.scores.stability !== null
      ? {
          id: "safety",
          label: "Safety",
          value: `${f.scores.stability} of 100`,
          detail: [
            st ? `Political stability ${st.value > 0 ? "+" : ""}${st.value} (scale −2.5 to 2.5)` : "No political stability figure",
            hom ? `${hom.value} homicides per 100,000` : "no homicide figure",
          ].join(", "),
          score: f.scores.stability,
          tag: tag([grainLabel("country"), st?.year || null]),
          sources: [st && "stability", hom && "homicides"].filter(Boolean) as string[],
          missing: false,
        }
      : { id: "safety", label: "Safety", value: NO_DATA, sources: [], missing: true }
  );

  const arr = f.crowds.arrivalsPerResident;
  const nights = f.crowds.nightsPerResident;
  const months = f.crowds.months;
  rows.push(
    arr || nights || months
      ? {
          id: "crowds",
          label: "Crowds",
          value: arr ? `${arr.value} visitors per resident` : nights ? `${nights.value} nights per resident` : `Busiest ${busiestMonths(months!.index)}`,
          detail: [
            arr ? "Arrivals from abroad a year, whole country" : null,
            nights ? `${nights.value} tourist nights per resident in ${nights.place}` : null,
            months && (arr || nights) ? `Busiest ${busiestMonths(months.index)}${months.place ? ` in ${months.place}` : ""}` : null,
          ]
            .filter(Boolean)
            .join(". "),
          score: f.scores.tourism ?? undefined,
          tag: tag([grainLabel(arr ? "country" : (nights?.granularity ?? months!.granularity)), arr?.year || nights?.year || null]),
          sources: [arr && "arrivals", (nights || months) && "nights"].filter(Boolean) as string[],
          missing: false,
        }
      : { id: "crowds", label: "Crowds", value: NO_DATA, sources: [], missing: true }
  );

  return rows;
}

/** Which parts of the overall score have data: "4 of 6 measures". */
export function scoreCoverage(score: MeridianScore): string {
  return `${score.parts} of 6 measures`;
}

// ── Fetch ────────────────────────────────────────────────────────────

const cache = new Map<string, Promise<PlaceFactsResponse>>();

/** One city's facts, fetched once per session. */
export function fetchPlaceFacts(cityId: string): Promise<PlaceFactsResponse> {
  let p = cache.get(cityId);
  if (!p) {
    p = fetch(apiUrl(`/api/metrics/facts/${encodeURIComponent(cityId)}`))
      .then((r) => {
        if (!r.ok) throw new Error(`facts ${r.status}`);
        return r.json() as Promise<PlaceFactsResponse>;
      })
      .catch((e) => {
        cache.delete(cityId);
        throw e;
      });
    cache.set(cityId, p);
  }
  return p;
}
