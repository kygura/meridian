// Real data for the solver (ADR 0015): turns pool city ids into Candidates.
//
// Every figure is named: fit from the owner's Personal Windows, else the Comfort Index
// (seasonality.ts); cost from the owner's own figure, else the place-data estimate
// (ADR 0013, labelled as an estimate with its source, granularity and year); internet
// from Ookla; healthcare from the WHO UHC index; risk from data/phenomena.json
// (advisories, conflicts, seasonal hazards) and, when it can be fetched in time, the
// place's news Issues and Watch Flags. A missing figure stays null and is reported.

import { getCityById } from "./cities.js";
import { placeDataInfo, placeFacts } from "./placeData.js";
import { advisoriesForCountry, anomaliesFor } from "./phenomena.js";
import { getPlaceNews } from "./placeNews.js";
import { peekCitySeasonality, resolveCitySeasonality, type MonthSeasonality } from "./seasonality.js";
import { coastKmFor } from "./coast.js";
import { haversineKm } from "../../src/lib/geo.js";
import { monthFit, placeFromCity, type PlaceProfile, type StayKind } from "../../src/lib/rotation.js";
import { regionForCountry } from "../../src/lib/worldRegion.js";
import type { Candidate, PlaceRisk, Sourced } from "../../src/lib/solver/types.js";
import type { City } from "../../src/types.js";

/** A seasonal hazard counts for places within this distance of its marker. */
export const HAZARD_REACH_KM = 1000;

export interface CandidateRequest {
  cityId: string;
  kind: StayKind;
  minNights?: number;
  maxNights?: number;
  budgetEur?: number;
  inPool: boolean;
  /** For a fixed stay: the owner's own rent or budget, already in EUR. */
  ownCostEur?: { value: number; source: string };
}

export interface DataOptions {
  /** Fetch news Issues and Watch Flags (network; may be slow or blocked). */
  news: boolean;
  /** Give up on a place's news, or an uncached Comfort Index, after this long. */
  timeoutMs: number;
}

export interface CandidatesResult {
  candidates: Candidate[];
  /** What could not be found, in plain words. */
  notes: string[];
  newsChecked: string[];
  newsMissing: string[];
}

export const DEFAULT_MIN_NIGHTS: Record<StayKind, number> = { base: 28, "pass-through": 2 };
export const DEFAULT_MAX_NIGHTS: Record<StayKind, number> = { base: 92, "pass-through": 5 };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

function sourceName(key: string): string {
  const s = placeDataInfo().sources[key]?.name ?? key;
  return s.split(/[:(]/)[0].trim();
}

const GRAIN: Record<string, string> = { city: "city figure", region: "regional figure", country: "country figure" };

async function comfortMonths(cityId: string, timeoutMs: number): Promise<MonthSeasonality[] | null> {
  const peek = peekCitySeasonality(cityId);
  if (peek.kind === "hit") return peek.months;
  if (peek.kind === "unknown") return null;
  const r = await withTimeout(resolveCitySeasonality(cityId), timeoutMs);
  return r && r.kind === "hit" ? r.months : null;
}

/** Advisories, conflicts and nearby seasonal hazards from data/phenomena.json. */
export function standingRisks(city: Pick<City, "country" | "lat" | "lng">): PlaceRisk[] {
  const out: PlaceRisk[] = [];
  for (const a of advisoriesForCountry(city.country)) {
    out.push({ kind: a.kind === "conflict" ? "conflict" : "advisory", severity: clampSev(a.severity), label: a.label, source: "Meridian curated list (data/phenomena.json)", url: a.sources?.[0]?.url });
  }
  for (const h of anomaliesFor().items) {
    if (h.kind !== "hazard") continue;
    if (haversineKm([city.lng, city.lat], [h.lng, h.lat]) > HAZARD_REACH_KM) continue;
    out.push({ kind: "hazard", severity: clampSev(h.severity), label: h.label, source: `Seasonal hazard within ${HAZARD_REACH_KM} km (data/phenomena.json)`, months: h.months });
  }
  return out;
}

const clampSev = (n: number) => Math.max(1, Math.min(3, Math.round(n || 1))) as 1 | 2 | 3;

/** News Issues (patterns, incidents, recurring) and Watch Flags for a place, marked current. */
export async function newsRisks(city: Pick<City, "name" | "country">, timeoutMs: number): Promise<PlaceRisk[] | null> {
  const news = await withTimeout(getPlaceNews(city.name, city.country), timeoutMs);
  if (!news || !news.available) return null;
  const out: PlaceRisk[] = [];
  for (const i of news.issues) {
    const sev = i.level === "systemic" ? 3 : i.level === "incident" ? 2 : 1;
    out.push({ kind: "issue", severity: sev as 1 | 2 | 3, label: i.label, source: i.headlines[0]?.source || "Google News", url: i.headlines[0]?.url, current: true });
  }
  for (const f of news.flags) {
    out.push({ kind: "flag", severity: f.severity, label: `${f.topic}: ${f.headline}`, source: "Google News", url: f.url, current: true });
  }
  return out;
}

export function costFact(city: City): Sourced | null {
  const f = placeFacts(city).cost.monthlyEur;
  if (!f) return null;
  return { value: f.value, source: `${sourceName(f.source)}, ${GRAIN[f.granularity] ?? f.granularity}, ${f.year} (estimate)`, estimate: true };
}

export async function buildCandidates(reqs: CandidateRequest[], profiles: PlaceProfile[], opts: DataOptions): Promise<CandidatesResult> {
  const notes: string[] = [];
  const newsChecked: string[] = [];
  const newsMissing: string[] = [];
  const profileOf = new Map(profiles.map((p) => [p.cityId, p]));
  const seen = new Set<string>();
  const unique = reqs.filter((r) => !seen.has(r.cityId) && seen.add(r.cityId));
  const built = await Promise.all(
    unique.map(async (r): Promise<Candidate | null> => {
      const city = getCityById(r.cityId);
      if (!city) {
        notes.push(`Unknown place ${r.cityId}: left out.`);
        return null;
      }
      const facts = placeFacts(city);
      const profile = profileOf.get(city.id);
      const comfort = await comfortMonths(city.id, opts.timeoutMs);
      const lookup = () => (comfort ? comfort.map((m) => ({ score: m.score })) : null);
      const months = Array.from({ length: 12 }, (_, i) => {
        const f = monthFit(city.id, `2000-${String(i + 1).padStart(2, "0")}`, profile, lookup);
        return { level: f.level, source: f.source, why: f.why };
      });
      if (!comfort && !profile?.windows.length) notes.push(`${city.name}: no Comfort Index yet and no windows of yours, so fit is unknown.`);
      let cost: Sourced | null = null;
      if (r.ownCostEur) cost = r.ownCostEur;
      else if (r.budgetEur !== undefined) cost = { value: r.budgetEur, source: "Your figure" };
      else cost = costFact(city);
      if (!cost) notes.push(`${city.name}: no cost figure.`);
      const net = facts.internet.fixed ?? facts.internet.mobile;
      const internet: Sourced | null = net ? { value: Math.round(net.downMbps), source: `Speedtest by Ookla, ${facts.internet.fixed ? "fixed" : "mobile"}, ${facts.internet.period ?? ""}`.trim() } : null;
      const uhc = facts.health.uhc;
      const health: Sourced | null = uhc ? { value: Math.round(uhc.value), source: `WHO UHC service coverage index, ${uhc.year}` } : null;
      const risks = standingRisks(city);
      if (opts.news) {
        const n = await newsRisks(city, opts.timeoutMs);
        if (n) {
          risks.push(...n);
          newsChecked.push(city.name);
        } else newsMissing.push(city.name);
      }
      const coast = coastKmFor(city.id);
      const kind = r.kind;
      return {
        place: placeFromCity(city),
        kind,
        minNights: r.minNights ?? DEFAULT_MIN_NIGHTS[kind],
        maxNights: Math.max(r.maxNights ?? DEFAULT_MAX_NIGHTS[kind], r.minNights ?? 1),
        months,
        costMonthlyEur: cost,
        internetMbps: internet,
        healthUhc: health,
        coastKm: coast,
        region: regionForCountry(city.country, city.lat, city.lng),
        risks,
        landmass: city.landmass,
        inPool: r.inPool,
      };
    })
  );
  if (opts.news && newsMissing.length) notes.push(`News could not be checked for ${newsMissing.join(", ")}; their risk uses the curated list only.`);
  return { candidates: built.filter((c): c is Candidate => c !== null), notes, newsChecked, newsMissing };
}
