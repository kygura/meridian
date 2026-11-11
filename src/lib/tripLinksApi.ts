// Share and calendar links for a trip (ADR 0010). Managed through /api/trips/:id/links,
// behind the journal token; the links themselves open /api/shared, which is public.

import { apiUrl } from "./api";
import { jfetch } from "./journalApi";
import type { TripNode } from "../types";

export type LinkKind = "page" | "calendar";

export interface TripLinkInfo {
  token: string;
  createdAt: string;
}

export type TripLinks = Record<LinkKind, TripLinkInfo | null>;

export async function fetchTripLinks(tripId: string): Promise<TripLinks> {
  return jfetch<TripLinks>(`/api/trips/${encodeURIComponent(tripId)}/links`);
}

/** Make the link (replacing any earlier one of that kind, whose URL stops working). */
export async function createTripLink(tripId: string, kind: LinkKind, home: TripNode): Promise<TripLinkInfo> {
  const { cityId, name, iata, lat, lng } = home;
  const res = await jfetch<{ link: TripLinkInfo }>(`/api/trips/${encodeURIComponent(tripId)}/links`, {
    method: "POST",
    body: JSON.stringify({ kind, home: { cityId, name, iata, lat, lng } }),
  });
  return res.link;
}

export async function revokeTripLink(tripId: string, kind: LinkKind): Promise<void> {
  await jfetch(`/api/trips/${encodeURIComponent(tripId)}/links/${kind}`, { method: "DELETE" });
}

/** Absolute URL for a link's token, for copying. `origin` is the page's origin when the API is same-origin. */
export function linkUrl(kind: LinkKind, token: string, origin: string): string {
  const path = kind === "page" ? `/api/shared/trip/${token}` : `/api/shared/calendar/${token}.ics`;
  const url = apiUrl(path);
  return /^https?:\/\//.test(url) ? url : `${origin}${url}`;
}

/** The same feed as a webcal:// address, which calendar apps open as "subscribe". */
export function webcalUrl(httpUrl: string): string {
  return httpUrl.replace(/^https?:\/\//, "webcal://");
}
