// Pure helpers for the Solve flow and the re-plan Proposals (ADR 0015).

import { effectiveStatus, staySpan, type RotationStay } from "../rotation";
import type { PlanInput, PlannedStay, ProposedRotation } from "./types";
import { planOf } from "./engine";

export { planOf };

/** Stays an accepted plan would replace: unlocked, unbooked, not current, starting inside it. Mirrors acceptPlan. */
export function replacedByAccept(stays: RotationStay[], plan: PlanInput, today: string): RotationStay[] {
  const sorted = [...plan.stays].sort((a, b) => a.start.localeCompare(b.start));
  if (!sorted.length) return [];
  const start = sorted[0].start;
  const end = sorted[sorted.length - 1].end;
  const keep = new Set(sorted.filter((s) => s.role === "fixed").map((s) => s.id));
  return stays.filter((s) => {
    if (keep.has(s.id) || s.locked) return false;
    const st = effectiveStatus(s, today);
    if (st !== "idea" && st !== "planned") return false;
    const span = staySpan(s);
    return !!span && span.start >= start && span.start < end;
  });
}

/** A proposal's stays as rotation stays, for the route map (display only). */
export function proposalAsStays(p: ProposedRotation, places: Map<string, { name: string; country?: string; lat: number; lng: number }>): RotationStay[] {
  return p.stays.flatMap((s) => {
    const pl = places.get(s.cityId);
    if (!pl) return [];
    return [{ id: s.id, place: { cityId: s.cityId, name: s.name, country: s.country, lat: pl.lat, lng: pl.lng }, kind: s.kind, status: "planned" as const, start: s.start, end: s.end }];
  });
}

/** The plan with one stay's place swapped for an alternative (same dates). */
export function swapStay(p: ProposedRotation, stayId: string, cityId: string): PlanInput {
  const plan = planOf(p);
  return { stays: plan.stays.map((s) => (s.id === stayId ? { ...s, cityId, notes: [] } : s)) };
}

/** Night-weighted fit level of a stay, for colouring a bar. */
export function stayLevel(s: PlannedStay): PlannedStay["months"][number]["level"] {
  const rank = { avoid: 0, poor: 1, fair: 2, good: 3, great: 4 } as const;
  const known = s.months.filter((m) => m.level !== "unknown");
  if (!known.length) return "unknown";
  if (known.some((m) => m.level === "avoid" && m.nights >= 7)) return "avoid";
  const n = known.reduce((a, m) => a + m.nights, 0);
  const mean = known.reduce((a, m) => a + rank[m.level as keyof typeof rank] * m.nights, 0) / n;
  return (["avoid", "poor", "fair", "good", "great"] as const)[Math.round(mean)];
}

/** A short id for a solve run, from the clock (only names the stays it writes). */
export function runId(now = Date.now()): string {
  return now.toString(36);
}
