// Likeness: which places offer the same experience, and which of them is the source and which
// a lighter echo of it (ADR 0019). Pure: no React, no fetch, no file reads. The server builds a
// Profile per city from measured data (server/lib/likeness.ts) and calls rankLikeness().
//
// Two ideas carry the whole thing:
// - Likeness is about the *shape* of a place: which of its traits stand out against the average
//   city. Venice and Chioggia stand out the same way (heritage, photographed, notable), so they
//   are alike, however strong each one is.
// - Strength is about *how much*: the projection of a place onto the target's shape. The source
//   of an experience is the alike place that has the most of it; an echo is alike but weaker.

/** Traits that make an experience. All 0-100, measured (ADR 0008, coast distance, population). */
export type ExperienceAxis = "mountains" | "water" | "sea" | "heritage" | "photographed" | "notable" | "scale";
/** Traits that say which kind of place it is, not how strong: they filter, they never rank. */
export type KindAxis = "warmth" | "winter" | "latitude";

export const EXPERIENCE_AXES: ExperienceAxis[] = ["mountains", "water", "sea", "heritage", "photographed", "notable", "scale"];

export const AXIS_LABELS: Record<ExperienceAxis, { label: string; less: string }> = {
  mountains: { label: "Mountains", less: "lower mountains" },
  water: { label: "Water", less: "less water" },
  sea: { label: "Sea", less: "further from the sea" },
  heritage: { label: "Heritage", less: "less heritage" },
  photographed: { label: "Photographed", less: "less to see" },
  notable: { label: "Notable places", less: "fewer notable places" },
  scale: { label: "City size", less: "smaller" },
};

export interface Profile {
  cityId: string;
  /** Experience traits, 0-100. A missing trait is a gap, never zero. */
  exp: Partial<Record<ExperienceAxis, number>>;
  /** Annual mean °C, measured; absent where the city has no climate normals. */
  warmth?: number;
  /** Coldest month's mean °C, measured. */
  winter?: number;
  /** |latitude| in degrees. Always known. */
  latitude: number;
}

export interface AxisStat {
  mean: number;
  sd: number;
  /** 95th percentile: where a vibe sets "the real thing". */
  p95: number;
}
export type AxisStats = Record<ExperienceAxis, AxisStat>;

/** A range a kind trait should fall in; outside it, closeness falls off over `tol`. */
export interface KindRange {
  lo: number;
  hi: number;
  tol: number;
}

export interface KindTerms {
  warmth?: KindRange;
  winter?: KindRange;
  /** Used where a city has no measured climate, and on its own when set alone. */
  latitude?: KindRange;
}

/** What we are looking for: levels on some experience axes (raw 0-100) and the kind of place. */
export interface Target {
  levels: Partial<Record<ExperienceAxis, number>>;
  weights: Partial<Record<ExperienceAxis, number>>;
  kind: KindTerms;
  /** 0-1: how much a kind mismatch costs. 1 = a mismatch rules a place out. */
  kindWeight: number;
  /** Axes strength is measured on: the target's highlights. */
  strengthAxes: ExperienceAxis[];
}

// ── Vibes ──────────────────────────────────────────────────────────────

/** A vibe's level on an axis: "peak" is the 95th percentile, "mid" the average, "low" well under it, or a number. */
type Level = "peak" | "mid" | "low" | number;

export interface Vibe {
  id: string;
  label: string;
  detail: string;
  keywords: string[];
  axes: Partial<Record<ExperienceAxis, { level: Level; weight?: number }>>;
  kind?: KindTerms;
}

const TROPICS: KindTerms = { warmth: { lo: 24, hi: 40, tol: 4 }, latitude: { lo: 0, hi: 23.5, tol: 6 } };

export const VIBES: Vibe[] = [
  {
    id: "old-town",
    label: "Old towns",
    detail: "Heritage, much photographed, many notable places",
    keywords: ["heritage", "historic", "history", "medieval", "old", "unesco", "architecture", "culture"],
    // A middling size keeps megacities, which are photographed and written about for other reasons, from crowding out old towns.
    axes: { heritage: { level: "peak" }, photographed: { level: "peak", weight: 0.8 }, notable: { level: "peak", weight: 0.6 }, scale: { level: "mid", weight: 0.6 } },
  },
  {
    id: "mountains",
    label: "Mountains",
    detail: "High relief within 15 km",
    keywords: ["mountain", "alps", "hiking", "peaks", "valley", "alpine"],
    axes: { mountains: { level: "peak" } },
  },
  {
    id: "alpine-lakes",
    label: "Mountain lakes",
    detail: "Relief and a lake, away from the sea",
    keywords: ["lake", "lakes", "fjord", "alpine lake"],
    axes: { mountains: { level: "peak" }, water: { level: "peak" }, sea: { level: "low", weight: 0.6 } },
  },
  {
    id: "coast",
    label: "Coast",
    detail: "On the sea",
    keywords: ["sea", "coast", "seaside", "beach", "ocean", "harbour"],
    axes: { sea: { level: "peak" }, water: { level: "peak", weight: 0.6 } },
  },
  {
    id: "dramatic-coast",
    label: "Dramatic coast",
    detail: "Mountains straight into the sea",
    keywords: ["cliffs", "amalfi", "riviera", "dramatic", "fjords"],
    axes: { sea: { level: "peak" }, mountains: { level: "peak" }, water: { level: "peak", weight: 0.5 } },
  },
  {
    id: "tropical-coast",
    label: "Tropical coast",
    detail: "Sea in the tropics",
    keywords: ["tropical", "island", "palm", "caribbean", "beach"],
    axes: { sea: { level: "peak" }, water: { level: "peak", weight: 0.5 } },
    kind: TROPICS,
  },
  {
    id: "big-city",
    label: "Big city",
    detail: "Large, much photographed, full of notable places",
    keywords: ["metropolis", "city", "urban", "capital", "nightlife"],
    axes: { scale: { level: "peak" }, notable: { level: "peak", weight: 0.7 }, photographed: { level: "peak", weight: 0.5 } },
  },
  {
    id: "small-town",
    label: "Small town with character",
    detail: "Small, but with heritage and things to see",
    keywords: ["village", "town", "quiet", "small", "charming"],
    axes: { scale: { level: "low" }, heritage: { level: "peak", weight: 0.8 }, photographed: { level: "peak", weight: 0.6 } },
  },
  {
    id: "winter-sun",
    label: "Winter sun",
    detail: "Coast with a warm coldest month",
    keywords: ["winter sun", "warm winter", "escape winter", "sunny winter"],
    axes: { sea: { level: "peak" } },
    kind: { winter: { lo: 15, hi: 30, tol: 4 }, latitude: { lo: 0, hi: 30, tol: 6 } },
  },
  {
    id: "snow-mountains",
    label: "Snowy mountains",
    detail: "High relief and a freezing winter",
    keywords: ["ski", "skiing", "snow", "winter", "powder"],
    axes: { mountains: { level: "peak" } },
    kind: { winter: { lo: -30, hi: 0, tol: 4 }, latitude: { lo: 40, hi: 70, tol: 6 } },
  },
];

export const VIBE_BY_ID = new Map(VIBES.map((v) => [v.id, v]));

/** Vibes whose label, id or keywords contain the query. */
export function searchVibes(query: string): Vibe[] {
  const q = query.trim().toLowerCase();
  if (!q) return VIBES;
  return VIBES.filter((v) => v.id.includes(q) || v.label.toLowerCase().includes(q) || v.keywords.some((k) => k.includes(q) || q.includes(k)));
}

// ── Statistics ─────────────────────────────────────────────────────────

export function axisStats(profiles: Profile[]): AxisStats {
  const out = {} as AxisStats;
  for (const a of EXPERIENCE_AXES) {
    const xs = profiles.map((p) => p.exp[a]).filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
    const n = xs.length;
    const mean = n ? xs.reduce((s, x) => s + x, 0) / n : 0;
    const sd = n ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n) : 1;
    out[a] = { mean, sd: sd > 0 ? sd : 1, p95: n ? xs[Math.min(n - 1, Math.floor(n * 0.95))]! : 100 };
  }
  return out;
}

const z = (a: ExperienceAxis, x: number, stats: AxisStats) => (x - stats[a].mean) / stats[a].sd;

function levelValue(level: Level, stat: AxisStat): number {
  if (level === "peak") return stat.p95;
  if (level === "low") return Math.max(0, stat.mean - 1.25 * stat.sd);
  if (level === "mid") return stat.mean;
  return level;
}

/** How far above (or below) the average city an axis must sit to count as a highlight, in standard deviations. */
export const HIGHLIGHT_Z = 0.5;

// ── Targets ────────────────────────────────────────────────────────────

/** Merge vibes and seed places into one target. Vibes set levels; seeds set their own profile. */
export function buildTarget(vibes: Vibe[], seeds: Profile[], stats: AxisStats): Target | null {
  if (!vibes.length && !seeds.length) return null;
  const sums: Partial<Record<ExperienceAxis, { v: number; w: number }>> = {};
  const add = (a: ExperienceAxis, v: number, w: number) => {
    const s = (sums[a] ??= { v: 0, w: 0 });
    s.v += v * w;
    s.w += w;
  };
  for (const vibe of vibes)
    for (const [a, spec] of Object.entries(vibe.axes) as [ExperienceAxis, { level: Level; weight?: number }][])
      add(a, levelValue(spec.level, stats[a]), spec.weight ?? 1);
  // A seed speaks for every axis it has: its whole shape is the experience.
  for (const s of seeds) for (const a of EXPERIENCE_AXES) if (typeof s.exp[a] === "number") add(a, s.exp[a]!, 1);

  const levels: Target["levels"] = {};
  const weights: Target["weights"] = {};
  const entries = Object.entries(sums) as [ExperienceAxis, { v: number; w: number }][];
  const top = Math.max(...entries.map(([, s]) => s.w));
  for (const [a, s] of entries) {
    levels[a] = s.v / s.w;
    weights[a] = s.w / top;
  }

  const kind: KindTerms = {};
  for (const v of vibes) Object.assign(kind, v.kind ?? {});
  if (seeds.length && !vibes.some((v) => v.kind)) Object.assign(kind, seedKind(seeds));

  // Strength counts the target's highlights: axes it stands out on. Size is a highlight only when a
  // vibe asks for it; a bigger city is not "more Kyoto" than Kyoto.
  const vibeScale = vibes.some((v) => v.axes.scale);
  const strengthAxes = entries
    .map(([a]) => a)
    .filter((a) => (a !== "scale" || vibeScale) && Math.abs(z(a, levels[a]!, stats)) >= HIGHLIGHT_Z);
  if (!strengthAxes.length) strengthAxes.push(...entries.map(([a]) => a).filter((a) => a !== "scale" || vibeScale));
  return { levels, weights, kind, kindWeight: vibes.some((v) => v.kind) ? 1 : 0.5, strengthAxes };
}

function seedKind(seeds: Profile[]): KindTerms {
  const span = (xs: number[], pad: number, tol: number): KindRange => ({ lo: Math.min(...xs) - pad, hi: Math.max(...xs) + pad, tol });
  const warm = seeds.map((s) => s.warmth).filter((x): x is number => typeof x === "number");
  const winter = seeds.map((s) => s.winter).filter((x): x is number => typeof x === "number");
  const out: KindTerms = { latitude: span(seeds.map((s) => s.latitude), 8, 10) };
  if (warm.length === seeds.length) out.warmth = span(warm, 3, 5);
  if (winter.length === seeds.length) out.winter = span(winter, 4, 6);
  return out;
}

// ── Scoring ────────────────────────────────────────────────────────────

function closeness(x: number, r: KindRange): number {
  if (x >= r.lo && x <= r.hi) return 1;
  const off = x < r.lo ? r.lo - x : x - r.hi;
  return Math.max(0, 1 - off / r.tol);
}

/** 0-1: does the place fall in the kind ranges? Measured climate first, latitude where there is none. */
export function kindFit(p: Profile, kind: KindTerms): number {
  const parts: number[] = [];
  const climate = (["warmth", "winter"] as const).filter((k) => kind[k]);
  const measured = climate.filter((k) => typeof p[k] === "number");
  for (const k of measured) parts.push(closeness(p[k]!, kind[k]!));
  if (kind.latitude && (measured.length === 0 || climate.length === 0)) parts.push(closeness(p.latitude, kind.latitude));
  return parts.length ? Math.min(...parts) : 1;
}

export interface Score {
  /** 0-1: same shape as the target, times kind fit. */
  likeness: number;
  /** Projection onto the target, 1 = as strong as the target. */
  strength: number;
}

/** Share of the target's weight a profile must cover to be scored at all. */
const MIN_COVERAGE = 0.6;

export function scoreProfile(p: Profile, t: Target, stats: AxisStats): Score | null {
  let dot = 0;
  let tt = 0;
  let pp = 0;
  let sDot = 0;
  let sTT = 0;
  let wHave = 0;
  let wAll = 0;
  const highlight = new Set(t.strengthAxes);
  for (const [a, level] of Object.entries(t.levels) as [ExperienceAxis, number][]) {
    const w = t.weights[a] ?? 1;
    wAll += w;
    const x = p.exp[a];
    if (typeof x !== "number") continue;
    wHave += w;
    const tz = z(a, level, stats);
    const pz = z(a, x, stats);
    dot += w * tz * pz;
    tt += w * tz * tz;
    pp += w * pz * pz;
    if (highlight.has(a)) {
      sDot += w * tz * pz;
      sTT += w * tz * tz;
    }
  }
  if (!wAll || wHave / wAll < MIN_COVERAGE || tt === 0) return null;
  const cos = pp === 0 ? 0 : dot / Math.sqrt(tt * pp);
  const shape = Math.max(0, cos);
  const fit = kindFit(p, t.kind);
  return { likeness: shape * (1 - t.kindWeight + t.kindWeight * fit), strength: sTT ? sDot / sTT : dot / tt };
}

/** Cosine between two places on every experience axis they share: "which source is this an echo of". */
export function placeSimilarity(a: Profile, b: Profile, stats: AxisStats): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (const ax of EXPERIENCE_AXES) {
    const x = a.exp[ax];
    const y = b.exp[ax];
    if (typeof x !== "number" || typeof y !== "number") continue;
    const zx = z(ax, x, stats);
    const zy = z(ax, y, stats);
    dot += zx * zy;
    aa += zx * zx;
    bb += zy * zy;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

// ── Ranking ────────────────────────────────────────────────────────────

export type Role = "source" | "echo";

export interface RankOptions {
  /** 0-1, default 0.85. */
  minLikeness?: number;
  /** Below this strength a place is too faint to count as an echo. Default 0.35. */
  minStrength?: number;
  /** A place is a source when its strength is at least this share of the strongest alike place. Default 0.9. */
  sourceShare?: number;
  /** Only these cities may appear (a country, a region). */
  allow?: (cityId: string) => boolean;
}

export interface Ranked {
  cityId: string;
  likeness: number;
  strength: number;
  role: Role;
  seed: boolean;
  /** For an echo: the source it is most like. */
  echoOf?: string;
  /** For an echo: where it falls shortest of that source, biggest gap first. */
  lesser?: ExperienceAxis[];
}

export interface Ranking {
  target: Target;
  /** Strength of the strongest alike place: what "the source" means for this target. */
  peak: number;
  ranked: Ranked[];
}

/**
 * Score every profile against the target, keep the alike ones, mark the strongest as sources and
 * link each echo to the source it is most like. Sources first (strongest, then best known),
 * then echoes (closest to the real thing first: likeness times strength).
 */
export function rankLikeness(profiles: Profile[], target: Target, stats: AxisStats, seedIds: string[] = [], opts: RankOptions = {}): Ranking {
  const minLikeness = opts.minLikeness ?? 0.85;
  const minStrength = opts.minStrength ?? 0.35;
  const sourceShare = opts.sourceShare ?? 0.9;
  const seeds = new Set(seedIds);
  const byId = new Map(profiles.map((p) => [p.cityId, p]));

  const alike: { p: Profile; s: Score }[] = [];
  for (const p of profiles) {
    if (opts.allow && !opts.allow(p.cityId) && !seeds.has(p.cityId)) continue;
    const s = scoreProfile(p, target, stats);
    if (!s) continue;
    if (seeds.has(p.cityId) || (s.likeness >= minLikeness && s.strength >= minStrength)) alike.push({ p, s });
  }
  const peak = alike.reduce((m, x) => Math.max(m, x.s.strength), 0);
  const cut = peak * sourceShare;

  const sources = alike.filter((x) => x.s.strength >= cut);
  const ranked: Ranked[] = alike.map(({ p, s }) => {
    const role: Role = s.strength >= cut ? "source" : "echo";
    const r: Ranked = { cityId: p.cityId, likeness: s.likeness, strength: s.strength, role, seed: seeds.has(p.cityId) };
    if (role === "echo" && sources.length) {
      let best = sources[0]!;
      let bestSim = -Infinity;
      for (const src of sources) {
        const sim = placeSimilarity(p, src.p, stats);
        if (sim > bestSim) {
          bestSim = sim;
          best = src;
        }
      }
      r.echoOf = best.p.cityId;
      r.lesser = shortfalls(p, byId.get(best.p.cityId)!, target, stats);
    }
    return r;
  });
  // Measured axes stop at 100, so many sources tie on strength. Among near-equals the better known
  // place leads: it is the one the experience is named after.
  const renown = (id: string) => {
    const e = byId.get(id)!.exp;
    return (e.photographed ?? 0) + (e.notable ?? 0);
  };
  const band = (x: number) => Math.round(x * 50);
  ranked.sort((a, b) =>
    a.role !== b.role
      ? a.role === "source"
        ? -1
        : 1
      : a.role === "source"
        ? band(b.strength) - band(a.strength) || renown(b.cityId) - renown(a.cityId)
        : b.likeness * b.strength - a.likeness * a.strength,
  );
  return { target, peak, ranked };
}

/** Highlight axes on which the echo falls short of its source by at least half a standard deviation. */
function shortfalls(echo: Profile, source: Profile, t: Target, stats: AxisStats): ExperienceAxis[] {
  const gaps: [ExperienceAxis, number][] = [];
  for (const a of t.strengthAxes) {
    const level = t.levels[a]!;
    const x = echo.exp[a];
    const y = source.exp[a];
    if (typeof x !== "number" || typeof y !== "number") continue;
    // On a highlight the target wants low (a small town), "short" means the source is lower.
    const wantsHigh = level >= stats[a].mean;
    const gap = ((wantsHigh ? y - x : x - y) / stats[a].sd) * (t.weights[a] ?? 1);
    if (gap >= 0.5) gaps.push([a, gap]);
  }
  return gaps.sort((p, q) => q[1] - p[1]).map(([a]) => a);
}

// ── Grouping ───────────────────────────────────────────────────────────

export interface Group {
  key: string;
  members: Ranked[];
}

export interface GroupRanked {
  key: string;
  role: Role;
  /** The group's strongest alike place. */
  best: Ranked;
  /** Best likeness in the group. */
  likeness: number;
  strength: number;
  /** How many alike places it holds. */
  count: number;
  /** For an echo group: the group holding the source its best place echoes. */
  echoOf?: string;
}

/** Roll city rankings up to countries or regions. A group is a source when it holds a source. */
export function groupRanking(ranked: Ranked[], groupOf: (cityId: string) => string | null): GroupRanked[] {
  const groups = new Map<string, Ranked[]>();
  for (const r of ranked) {
    const g = groupOf(r.cityId);
    if (!g) continue;
    const list = groups.get(g) ?? [];
    list.push(r);
    groups.set(g, list);
  }
  const out: GroupRanked[] = [];
  for (const [key, members] of groups) {
    const best = members.reduce((a, b) => (b.strength * b.likeness > a.strength * a.likeness ? b : a));
    const role: Role = members.some((m) => m.role === "source") ? "source" : "echo";
    const lead = role === "source" ? members.filter((m) => m.role === "source").reduce((a, b) => (b.strength > a.strength ? b : a)) : best;
    const g: GroupRanked = {
      key,
      role,
      best: lead,
      likeness: Math.max(...members.map((m) => m.likeness)),
      strength: lead.strength,
      count: members.length,
    };
    if (role === "echo" && lead.echoOf) {
      const src = groupOf(lead.echoOf);
      if (src && src !== key) g.echoOf = src;
    }
    out.push(g);
  }
  out.sort((a, b) =>
    a.role !== b.role
      ? a.role === "source"
        ? -1
        : 1
      : a.role === "source"
        ? b.strength - a.strength || b.count - a.count
        : b.likeness * b.strength - a.likeness * a.strength || b.count - a.count,
  );
  return out;
}

// ── API shapes (GET /api/likeness) ─────────────────────────────────────

export type LikenessLevel = "city" | "region" | "country";

export interface PlaceRef {
  id: string;
  name: string;
}

export interface LikenessCityRow {
  cityId: string;
  name: string;
  country: string;
  region: string | null;
  role: "source" | "echo";
  seed: boolean;
  /** 0-100: same shape as what you asked for. */
  likeness: number;
  /** 0-100: how much of the strongest alike place's experience it carries. */
  strength: number;
  echoOf?: PlaceRef;
  /** Where an echo falls short of its source. */
  lesser?: ExperienceAxis[];
  /** What an echo offers over its source: "cheaper", "fewer visitors". */
  gains?: string[];
  traits: Partial<Record<ExperienceAxis, number>>;
}

export interface LikenessGroupRow {
  id: string;
  name: string;
  /** The country a region belongs to; absent on country rows. */
  country?: string;
  role: "source" | "echo";
  likeness: number;
  strength: number;
  /** Alike cities in it. */
  cities: number;
  /** Its source city, or its strongest echo. */
  lead: PlaceRef;
  echoOf?: PlaceRef;
}

export interface LikenessTargetInfo {
  vibes: Pick<Vibe, "id" | "label">[];
  like: PlaceRef[];
  /** Axes the target is described on. */
  axes: ExperienceAxis[];
  /** Axes strength is measured on (its highlights). */
  highlights: ExperienceAxis[];
}

/** Sources and echoes are listed apart, each up to the limit, so a crowd of sources never hides the echoes. */
export type LikenessResponse =
  | { level: "city"; target: LikenessTargetInfo; counts: { sources: number; echoes: number }; sources: LikenessCityRow[]; echoes: LikenessCityRow[] }
  | {
      level: "region" | "country";
      target: LikenessTargetInfo;
      counts: { sources: number; echoes: number };
      sources: LikenessGroupRow[];
      echoes: LikenessGroupRow[];
    };
