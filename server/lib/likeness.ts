// Likeness profiles and queries (ADR 0019). Builds one Profile per city from measured data:
// natural setting and built character (data/livability.json, ADR 0008), distance to the sea
// (data/city-coast.json), population, and climate normals where the city has them. A city
// without a livability record has no profile; a missing trait stays missing.

import { getCities, getCityById } from "./cities.js";
import { livabilityFor } from "./livability.js";
import { coastKmFor } from "./coast.js";
import { peekCitySeasonality } from "./seasonality.js";
import { placeFacts, regionOf } from "./placeData.js";
import { logScale } from "./placeDataMath.js";
import {
  EXPERIENCE_AXES,
  VIBE_BY_ID,
  axisStats,
  buildTarget,
  groupRanking,
  rankLikeness,
  type AxisStats,
  type ExperienceAxis,
  type Profile,
  type LikenessCityRow,
  type LikenessGroupRow,
  type LikenessLevel,
  type LikenessResponse,
  type LikenessTargetInfo,
  type PlaceRef,
  type Ranked,
  type Vibe,
} from "../../src/lib/likeness.js";

export type { LikenessCityRow, LikenessGroupRow, LikenessLevel, LikenessResponse, LikenessTargetInfo, PlaceRef };
import { countryKey } from "../../src/lib/countryNames.js";
import type { City } from "../../src/types.js";

/** Population at which "scale" is 0 and 100 (log scale). */
export const SCALE_FLOOR = 20_000;
export const SCALE_CEIL = 20_000_000;
/** Within this many km of the coast a city is "on the sea"; the score falls to 0 at it. */
export const SEA_KM = 40;

export function seaScore(km: number): number {
  return Math.round(100 * Math.max(0, 1 - km / SEA_KM));
}

export function profileFor(city: City): Profile | null {
  const l = livabilityFor(city.id);
  if (!l) return null;
  const exp: Profile["exp"] = {};
  if (l.settingParts) {
    exp.mountains = l.settingParts.relief;
    exp.water = l.settingParts.water;
  }
  if (l.characterParts.heritage !== null) exp.heritage = l.characterParts.heritage;
  if (l.characterParts.photos !== null) exp.photographed = l.characterParts.photos;
  if (l.characterParts.notable !== null) exp.notable = l.characterParts.notable;
  const coast = coastKmFor(city.id);
  if (coast) exp.sea = seaScore(coast.value);
  if (city.population > 0) exp.scale = Math.round(logScale(city.population, SCALE_FLOOR, SCALE_CEIL));
  const p: Profile = { cityId: city.id, exp, latitude: Math.abs(city.lat) };
  const climate = peekCitySeasonality(city.id);
  if (climate.kind === "hit" && climate.months.length === 12) {
    const temps = climate.months.map((m) => m.tempC).filter(Number.isFinite);
    if (temps.length === 12) {
      p.warmth = Math.round((temps.reduce((s, t) => s + t, 0) / 12) * 10) / 10;
      p.winter = Math.min(...temps);
    }
  }
  return p;
}

let cache: { profiles: Profile[]; byId: Map<string, Profile>; stats: AxisStats } | null = null;

function load() {
  if (cache) return cache;
  const profiles: Profile[] = [];
  for (const c of getCities()) {
    const p = profileFor(c);
    if (p) profiles.push(p);
  }
  cache = { profiles, byId: new Map(profiles.map((p) => [p.cityId, p])), stats: axisStats(profiles) };
  return cache;
}

/** Test seam. */
export function resetLikeness(): void {
  cache = null;
}

export function likenessProfile(cityId: string): Profile | undefined {
  return load().byId.get(cityId);
}

// ── Queries ────────────────────────────────────────────────────────────

export interface LikenessQuery {
  vibes: string[];
  /** Seed city ids: "places like these". */
  like: string[];
  level: LikenessLevel;
  /** Only cities in this country (any spelling countryKey() folds). */
  within?: string;
  limit: number;
  /** 0-100, default 85. */
  minLikeness?: number;
}

export class LikenessError extends Error {
  constructor(
    readonly code: "no_target" | "unknown_vibe" | "unknown_city" | "no_profile",
    readonly detail: string,
  ) {
    super(detail);
  }
}

function gainsOver(echo: City, source: City): string[] {
  const a = placeFacts(echo).scores;
  const b = placeFacts(source).scores;
  const out: string[] = [];
  if (a.cost !== null && b.cost !== null && a.cost - b.cost >= 10) out.push("cheaper");
  if (a.tourism !== null && b.tourism !== null && b.tourism - a.tourism >= 10) out.push("fewer visitors");
  return out;
}

const ref = (c: City | undefined, id: string): PlaceRef => ({ id, name: c?.name ?? id });

export function runLikeness(q: LikenessQuery): LikenessResponse {
  const { profiles, byId, stats } = load();
  const vibes: Vibe[] = [];
  for (const id of q.vibes) {
    const v = VIBE_BY_ID.get(id);
    if (!v) throw new LikenessError("unknown_vibe", `Unknown vibe '${id}'`);
    vibes.push(v);
  }
  const seeds: Profile[] = [];
  for (const id of q.like) {
    if (!getCityById(id)) throw new LikenessError("unknown_city", `Unknown city '${id}'`);
    const p = byId.get(id);
    if (!p) throw new LikenessError("no_profile", `No setting or character data for '${id}'`);
    seeds.push(p);
  }
  const target = buildTarget(vibes, seeds, stats);
  if (!target) throw new LikenessError("no_target", "Give at least one vibe or one place to be like");

  // Sources are the strongest places in the pool you compare: the world, one country, or (for
  // regions) the cities that have a region, so "the source" is always one you can see in the list.
  const within = q.within ? countryKey(q.within) : null;
  const inCountry = (id: string) => !within || countryKey(getCityById(id)?.country ?? "") === within;
  const allow = within || q.level === "region" ? (id: string) => inCountry(id) && (q.level !== "region" || regionOf(id) !== null) : undefined;
  const ranking = rankLikeness(profiles, target, stats, q.like, {
    minLikeness: q.minLikeness === undefined ? undefined : q.minLikeness / 100,
    allow,
  });
  const peak = ranking.peak || 1;
  const pct = (x: number) => Math.round(100 * x);
  const head: LikenessTargetInfo = {
    vibes: vibes.map((v) => ({ id: v.id, label: v.label })),
    like: q.like.map((id) => ref(getCityById(id), id)),
    axes: EXPERIENCE_AXES.filter((a) => target.levels[a] !== undefined),
    highlights: target.strengthAxes,
  };
  const split = <T extends { role: "source" | "echo" }>(rows: T[]) => {
    const sources = rows.filter((r) => r.role === "source");
    const echoes = rows.filter((r) => r.role === "echo");
    return { counts: { sources: sources.length, echoes: echoes.length }, sources: sources.slice(0, q.limit), echoes: echoes.slice(0, q.limit) };
  };

  if (q.level === "city") {
    const sources = ranking.ranked.filter((r) => r.role === "source");
    const echoes = ranking.ranked.filter((r) => r.role === "echo");
    return {
      level: "city",
      target: head,
      counts: { sources: sources.length, echoes: echoes.length },
      sources: sources.slice(0, q.limit).map((r) => cityRow(r, peak, byId)),
      echoes: echoes.slice(0, q.limit).map((r) => cityRow(r, peak, byId)),
    };
  }

  const groupOf =
    q.level === "country"
      ? (id: string) => getCityById(id)?.country ?? null
      : (id: string) => regionOf(id)?.code ?? null;
  const groups = groupRanking(ranking.ranked, groupOf);
  const rows: LikenessGroupRow[] = groups.map((g) => {
    const lead = getCityById(g.best.cityId);
    const region = q.level === "region" ? regionOf(g.best.cityId) : null;
    const row: LikenessGroupRow = {
      id: g.key,
      name: region?.name ?? g.key,
      ...(region ? { country: lead?.country } : {}),
      role: g.role,
      likeness: pct(g.likeness),
      strength: Math.min(100, pct(g.strength / peak)),
      cities: g.count,
      lead: ref(lead, g.best.cityId),
    };
    if (g.echoOf && g.best.echoOf) row.echoOf = { id: g.echoOf, name: q.level === "country" ? g.echoOf : (regionOf(g.best.echoOf)?.name ?? g.echoOf) };
    return row;
  });
  return { level: q.level, target: head, ...split(rows) };
}

function cityRow(r: Ranked, peak: number, byId: Map<string, Profile>): LikenessCityRow {
  const city = getCityById(r.cityId)!;
  const row: LikenessCityRow = {
    cityId: r.cityId,
    name: city.name,
    country: city.country,
    region: regionOf(r.cityId)?.name ?? null,
    role: r.role,
    seed: r.seed,
    likeness: Math.round(100 * r.likeness),
    strength: Math.min(100, Math.round((100 * r.strength) / peak)),
    traits: byId.get(r.cityId)?.exp ?? {},
  };
  if (r.echoOf) {
    const src = getCityById(r.echoOf);
    row.echoOf = ref(src, r.echoOf);
    if (r.lesser?.length) row.lesser = r.lesser.slice(0, 2);
    if (src) {
      const gains = gainsOver(city, src);
      if (gains.length) row.gains = gains;
    }
  }
  return row;
}
