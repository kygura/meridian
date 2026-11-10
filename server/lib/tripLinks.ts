// Links that let someone without the journal token see one trip (ADR 0010):
//   "page"      a read-only itinerary page to send to people
//   "calendar"  an ICS feed a calendar app can subscribe to
//
// One document, "tripLinks.json", in the shared store (file or Postgres). A link is an
// unguessable token (192 random bits) tied to one trip and one kind. There is at most
// one link of each kind per trip; making a new one replaces the old, and revoking
// deletes it, so an old URL stops working at once. The token is the only credential:
// calendar apps and the people a trip is shared with cannot send the journal token.

import { randomBytes } from "crypto";
import { z } from "zod";
import type { TripNode } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";

export const linkKindSchema = z.enum(["page", "calendar"]);
export type LinkKind = z.infer<typeof linkKindSchema>;

export interface TripLink {
  token: string;
  tripId: string;
  kind: LinkKind;
  createdAt: string;
  /**
   * The owner's default departure when the link was made. A trip without its own
   * departure starts from it, and the server has no other way to know it.
   */
  home?: TripNode;
}

interface LinksFile {
  version: 1;
  links: TripLink[];
}

const store = createJsonStore<LinksFile>("tripLinks.json", () => ({ version: 1, links: [] }));

/** Tokens are 32 base64url characters; anything else is rejected before the store is read. */
export const linkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function linksForTrip(tripId: string): Promise<Partial<Record<LinkKind, TripLink>>> {
  const file = await store.read();
  const out: Partial<Record<LinkKind, TripLink>> = {};
  for (const l of file.links) if (l.tripId === tripId) out[l.kind] = l;
  return out;
}

/** Make (or replace) the trip's link of this kind. The previous token stops working. */
export function createLink(tripId: string, kind: LinkKind, home?: TripNode, now = new Date()): Promise<TripLink> {
  const link: TripLink = { token: newToken(), tripId, kind, createdAt: now.toISOString(), ...(home ? { home } : {}) };
  return store.update((file) => {
    file.links = file.links.filter((l) => !(l.tripId === tripId && l.kind === kind));
    file.links.push(link);
    return link;
  });
}

/** Returns false when there was no such link. */
export function revokeLink(tripId: string, kind: LinkKind): Promise<boolean> {
  return store.update((file) => {
    const before = file.links.length;
    file.links = file.links.filter((l) => !(l.tripId === tripId && l.kind === kind));
    return file.links.length < before;
  });
}

/** Drop every link of a trip (when the trip is deleted). */
export function revokeAllLinks(tripId: string): Promise<void> {
  return store.update((file) => {
    file.links = file.links.filter((l) => l.tripId !== tripId);
  });
}

/** The link a token opens, if it exists and is of the expected kind. */
export async function findLink(token: string, kind: LinkKind): Promise<TripLink | undefined> {
  if (!linkTokenSchema.safeParse(token).success) return undefined;
  const file = await store.read();
  return file.links.find((l) => l.kind === kind && l.token === token);
}
