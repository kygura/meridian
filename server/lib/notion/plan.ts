// The importer's brain, as pure functions: Notion rows + what Meridian already holds in,
// a diff out. Nothing is written here; the preview shows this diff and apply performs it.

import { createHash } from "crypto";
import type { PlaceProfile } from "../../../src/lib/rotation.js";
import { citySuggestion, matchPlace } from "./match.js";
import { fold, type SeasonRow } from "./read.js";
import type { PoolEntry, ResearchEntry, ReviewItem, WindowDraft } from "./types.js";

export interface PlanInput {
  /** null = this import does not cover that database, so leave what is stored alone. */
  seasons: SeasonRow[] | null;
  research: ResearchEntry[] | null;
  existingPlaces: PlaceProfile[];
  existingPool: PoolEntry[];
  aliases: Record<string, string[]>;
  now: Date;
}

export interface WindowView {
  ref: string;
  kind: WindowDraft["kind"];
  months: WindowDraft["months"];
  reason?: string;
}

export interface PlaceChange {
  cityId: string;
  name: string;
  country: string;
  added: WindowView[];
  updated: { before: WindowView; after: WindowView }[];
  removed: WindowView[];
  unchanged: number;
  /** The full set of imported windows this place ends up with. */
  next: WindowDraft[];
}

export interface PoolChange {
  added: PoolEntry[];
  updated: { before: PoolEntry; after: PoolEntry }[];
  removed: PoolEntry[];
  unchanged: number;
  next: PoolEntry[];
}

export interface Plan {
  places: PlaceChange[];
  pool: PoolChange | null;
  review: ReviewItem[];
  /** Which databases this import covers. */
  covers: { seasons: boolean; research: boolean };
  summary: { windowsAdded: number; windowsUpdated: number; windowsRemoved: number; poolAdded: number; poolUpdated: number; poolRemoved: number; review: number };
  /** Hash of everything apply would do, so apply can refuse when Notion changed after the preview. */
  digest: string;
}

const view = (w: WindowDraft): WindowView => ({ ref: w.ref, kind: w.kind, months: w.months, ...(w.reason ? { reason: w.reason } : {}) });
const sameWindow = (a: WindowView, b: WindowView) => a.kind === b.kind && a.months.start === b.months.start && a.months.end === b.months.end && (a.reason ?? "") === (b.reason ?? "");

const poolBody = (p: PoolEntry) => JSON.stringify([p.cityId, p.label, p.country, p.type, p.stay, p.budgetMonthly, p.notes, p.scores, p.overall]);

export function buildPlan(input: PlanInput): Plan {
  const review = new Map<string, ReviewItem>();
  const flag = (item: Omit<ReviewItem, "count" | "key">) => {
    const key = `${item.db}:${fold(item.label)}:${item.reason}`;
    const cur = review.get(key);
    if (cur) cur.count++;
    else review.set(key, { ...item, key, count: 1 });
  };

  // ── Windows ──
  const drafts = new Map<string, { name: string; country: string; windows: WindowDraft[] }>();
  if (input.seasons) {
    for (const row of input.seasons) {
      if (!row.label) continue;
      const m = matchPlace(row.label, row.country, input.aliases);
      if (!m.ok) {
        if (!m.ignored) flag({ db: "seasons", label: row.label, reason: m.reason, detail: m.detail, suggestions: m.suggestions.map(citySuggestion) });
        continue;
      }
      if (row.problem || !row.kind || !row.months) {
        const bad = row.problem ?? "bad-dates";
        flag({
          db: "seasons",
          label: row.label,
          reason: bad,
          detail: bad === "bad-kind" ? "The season is not peak, shoulder or avoid, so no window was made." : "The row has no usable start and end dates, so no window was made.",
          suggestions: [],
        });
        continue;
      }
      for (const city of m.cities) {
        const d = drafts.get(city.id) ?? { name: city.name, country: city.country, windows: [] };
        d.windows.push({ ref: row.ref, cityId: city.id, kind: row.kind, months: row.months, reason: row.reason });
        drafts.set(city.id, d);
      }
    }
  }

  const places: PlaceChange[] = [];
  if (input.seasons) {
    const known = new Map(input.existingPlaces.map((p) => [p.cityId, p]));
    const ids = new Set([...drafts.keys(), ...input.existingPlaces.filter((p) => p.windows.some((w) => w.source?.kind === "notion")).map((p) => p.cityId)]);
    for (const cityId of ids) {
      const d = drafts.get(cityId);
      const profile = known.get(cityId);
      const before = (profile?.windows ?? []).filter((w) => w.source?.kind === "notion").map((w) => ({ ref: w.source?.ref ?? w.id, kind: w.kind, months: w.months, ...(w.reason ? { reason: w.reason } : {}) }) as WindowView);
      const after = (d?.windows ?? []).map(view);
      const change: PlaceChange = { cityId, name: d?.name ?? profile?.name ?? cityId, country: d?.country ?? profile?.country ?? "", added: [], updated: [], removed: [], unchanged: 0, next: d?.windows ?? [] };
      for (const a of after) {
        const b = before.find((x) => x.ref === a.ref);
        if (!b) change.added.push(a);
        else if (sameWindow(a, b)) change.unchanged++;
        else change.updated.push({ before: b, after: a });
      }
      change.removed = before.filter((b) => !after.some((a) => a.ref === b.ref));
      if (change.added.length || change.updated.length || change.removed.length) places.push(change);
    }
    places.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Pool ──
  let pool: PoolChange | null = null;
  if (input.research) {
    const next: PoolEntry[] = [];
    const stamp = input.now.toISOString();
    for (const e of input.research) {
      const m = matchPlace(e.label, e.country, input.aliases);
      if (!m.ok) {
        if (!m.ignored) flag({ db: "research", label: e.label, reason: m.reason, detail: m.detail, suggestions: m.suggestions.map(citySuggestion) });
        continue;
      }
      for (const c of m.cities) {
        next.push({ ...e, ref: m.cities.length > 1 ? `${e.ref}@${c.id}` : e.ref, cityId: c.id, cityName: c.name, cityCountry: c.country, importedAt: stamp });
      }
    }
    const old = new Map(input.existingPool.map((p) => [p.ref, p]));
    pool = { added: [], updated: [], removed: [], unchanged: 0, next };
    for (const n of next) {
      const o = old.get(n.ref);
      if (!o) pool.added.push(n);
      else if (poolBody(o) === poolBody(n)) {
        pool.unchanged++;
        n.importedAt = o.importedAt; // an unchanged entry keeps its first import time
      } else pool.updated.push({ before: o, after: n });
    }
    pool.removed = input.existingPool.filter((o) => !next.some((n) => n.ref === o.ref));
  }

  const items = [...review.values()].sort((a, b) => a.label.localeCompare(b.label));
  const summary = {
    windowsAdded: places.reduce((n, p) => n + p.added.length, 0),
    windowsUpdated: places.reduce((n, p) => n + p.updated.length, 0),
    windowsRemoved: places.reduce((n, p) => n + p.removed.length, 0),
    poolAdded: pool?.added.length ?? 0,
    poolUpdated: pool?.updated.length ?? 0,
    poolRemoved: pool?.removed.length ?? 0,
    review: items.length,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify({ p: places.map((p) => [p.cityId, p.next]), q: pool?.next.map((x) => [x.ref, poolBody(x)]), r: items.map((i) => i.key) }))
    .digest("hex")
    .slice(0, 24);
  return { places, pool, review: items, covers: { seasons: !!input.seasons, research: !!input.research }, summary, digest };
}
