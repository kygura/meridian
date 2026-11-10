// Public, token-in-URL views of one trip (ADR 0010). Mounted at /api/shared, outside the
// journal gate on purpose: the people a trip is shared with, and calendar apps, cannot
// send the journal token. The token in the path is the credential; it opens one trip, in
// one form, until the owner turns the link off.
//
//   GET /api/shared/trip/:token           read-only itinerary page (HTML)
//   GET /api/shared/trip/:token/data      the same itinerary as JSON
//   GET /api/shared/calendar/:token.ics   ICS feed to subscribe to
//
// Neither form carries booking references, prices, links, notes or traveller details.

import { Hono } from "hono";
import type { Context } from "hono";
import { getCityById } from "../lib/cities.js";
import { getTrip } from "../lib/trips.js";
import { findLink } from "../lib/tripLinks.js";
import { renderShareGone, renderSharePage } from "../lib/sharePage.js";
import { buildSharedTrip } from "../../src/lib/tripShare.js";
import { tripRoute } from "../../src/lib/legs.js";
import { tripToIcs } from "../../src/lib/ics.js";

const shared = new Hono();

const landmassOf = (id: string) => getCityById(id)?.landmass;
const zoneOf = (id: string) => getCityById(id)?.timezone;

/** Never cached, never indexed, and the token never leaves in a Referer header. */
function privateHeaders(c: Context): void {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
}

async function sharedTrip(token: string) {
  const link = await findLink(token, "page");
  if (!link) return null;
  const trip = await getTrip(link.tripId);
  if (!trip) return null;
  return buildSharedTrip(trip, link.home, landmassOf);
}

shared.get("/trip/:token", async (c) => {
  privateHeaders(c);
  // The page has no scripts and loads nothing; say so, so nothing injected could run either.
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const trip = await sharedTrip(c.req.param("token"));
  if (!trip) return c.html(renderShareGone(), 404);
  return c.html(renderSharePage(trip));
});

shared.get("/trip/:token/data", async (c) => {
  privateHeaders(c);
  const trip = await sharedTrip(c.req.param("token"));
  if (!trip) return c.json({ error: "not_found" }, 404);
  return c.json({ trip });
});

shared.get("/calendar/:file", async (c) => {
  privateHeaders(c);
  const file = c.req.param("file");
  const token = file.endsWith(".ics") ? file.slice(0, -4) : file;
  const link = await findLink(token, "calendar");
  const trip = link ? await getTrip(link.tripId) : undefined;
  if (!link || !trip) return c.text("Calendar not found", 404);
  const route = tripRoute(trip, link.home, [], landmassOf);
  const ics = tripToIcs(trip, route, { zoneOf, includePrivate: false });
  return c.body(ics, 200, { "Content-Type": "text/calendar; charset=utf-8" });
});

export default shared;
