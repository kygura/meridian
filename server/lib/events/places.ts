// Where the rolling nature check finds its cities (ADR 0021): the owner's places first, then the
// cities people look at, in order of attention. Stores are imported when asked, so the event code
// does not pull the whole server in at load time.

import { createJsonStore } from "../jsonStore.js";
import { cityIdsByAttention } from "../placeData.js";
import type { PlaceDeps } from "./common.js";

/** The owner's places: the Atlas wishlist, the shortlist, rotation stays and places, and trip stops. */
export async function ownerCityIds(): Promise<string[]> {
  const out: string[] = [];
  const add = (ids: (string | undefined)[]) => {
    for (const id of ids) if (id && !out.includes(id)) out.push(id);
  };
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[events] could not read ${label} for the nature check:`, err instanceof Error ? err.message : String(err));
    }
  };
  await attempt("the wishlist", async () => add((await (await import("../atlas/service.js")).listWishlist()).map((p) => p.cityId)));
  await attempt("the shortlist", async () => add((await createJsonStore<{ cityId: string }[]>("shortlist.json", () => []).read()).map((e) => e.cityId)));
  await attempt("rotation", async () => {
    const rot = await (await import("../rotation.js")).readRotation();
    add(rot.stays.map((s) => s.place.cityId));
    add(rot.places.map((p) => p.cityId));
  });
  await attempt("trips", async () => {
    const { trips } = await (await import("../trips.js")).listTrips();
    add(trips.flatMap((t) => t.nodes.map((n) => n.cityId)));
  });
  return out;
}

/** Every city with measured attention (page views), the most looked at first. */
export function attentionCityIds(): string[] {
  return cityIdsByAttention();
}

export const defaultPlaceDeps: PlaceDeps = { ownerCityIds, attentionCityIds };
