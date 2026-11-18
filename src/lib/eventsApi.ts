// GET /api/overlays/events/tags: the tags the live events (ADR 0021) carry,
// for the "Happening while you're there" filter.

import { apiUrl } from "./api";

export interface EventTag {
  tag: string;
  count: number;
}

/** "cherry-blossom" as "Cherry blossom". */
export function eventTagLabel(tag: string): string {
  const words = tag.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function fetchEventTags(signal?: AbortSignal): Promise<EventTag[]> {
  const r = await fetch(apiUrl("/api/overlays/events/tags"), { signal });
  if (!r.ok) throw new Error(`events/tags ${r.status}`);
  const body = (await r.json()) as { tags?: EventTag[] };
  return Array.isArray(body.tags) ? body.tags.filter((t) => typeof t.tag === "string" && Number.isFinite(t.count)) : [];
}
