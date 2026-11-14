// GET /api/likeness: places alike in experience, split into sources and lighter echoes (ADR 0019).
// Plus a one-shot hand-off from the city panel to Plan › Sources ("explore places like this").

import { apiUrl } from "./api";
import type { LikenessLevel, LikenessResponse } from "./likeness";

export interface LikenessParams {
  vibes: string[];
  like: string[];
  level: LikenessLevel;
  within?: string;
  limit?: number;
}

export function likenessQuery(p: LikenessParams): string {
  const q = new URLSearchParams();
  if (p.vibes.length) q.set("vibe", p.vibes.join(","));
  if (p.like.length) q.set("like", p.like.join(","));
  q.set("level", p.level);
  if (p.within) q.set("within", p.within);
  if (p.limit) q.set("limit", String(p.limit));
  return `/api/likeness?${q.toString()}`;
}

export async function fetchLikeness(p: LikenessParams, signal?: AbortSignal): Promise<LikenessResponse> {
  const r = await fetch(apiUrl(likenessQuery(p)), { signal });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail ?? `likeness ${r.status}`);
  }
  return r.json();
}

// ── Hand-off ───────────────────────────────────────────────────────────

let pendingSeed: string | null = null;

/** The city panel sets a seed, then navigates to #/plan/sources, which takes it on mount. */
export function setSourcesSeed(cityId: string | null): void {
  pendingSeed = cityId;
}

/** Read and clear. */
export function takeSourcesSeed(): string | null {
  const s = pendingSeed;
  pendingSeed = null;
  return s;
}
