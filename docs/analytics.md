# Analytics (GA4 + Consent Mode v2)

Meridian sends usage to Google Analytics 4 when the build has `VITE_GA_ID`
(a `G-` measurement ID). Without it nothing loads, there is no banner, and the
Content-Security-Policy stays as ADR 0009 describes.

Code: `src/lib/analytics.ts` (consent, gtag), `src/lib/analyticsEvents.ts` (page
views, UI-state events), `src/shell/ConsentBanner.tsx`, Settings > Privacy, and
the `analytics` option in `server/lib/securityHeaders.ts`.

## Consent

- Defaults are **denied** for all four signals, set before gtag.js loads, with
  `wait_for_update: 500`. A saved answer is replayed as an `update` straight after.
- The banner asks once; the answer lasts a year (`localStorage["meridian.consent"]`).
  Decline and Allow have the same weight. Settings > Privacy changes it.
- Only `analytics_storage` follows the answer. `ad_storage`, `ad_user_data` and
  `ad_personalization` stay denied: the app runs no ads.
- Advanced consent mode: while denied, gtag sends cookieless pings (no `_ga`
  cookie, no client ID). GA4 can model those visits once the property qualifies
  (roughly 1,000 consented events a day for 7 days); below that they are missing
  from reports. Expect the numbers to undercount.
- Nothing runs inside a frame: the portfolio's preview of Meridian is not a visit.

## Page views

Routing is by hash (`#/plan/when`). GA4 drops the fragment from Page path, so
page views go out by hand with the route as a virtual path (`/plan/when`).
Record ids collapse: `/trips/plan/:trip`, `/trips/past/:journey`,
`/plan/repeat/:journey`.

In the web stream, Enhanced measurement > Page views > **"Page changes based on
browser history events" must be off**, or hash changes count twice.

## Events

| Event | When | Parameters |
| --- | --- | --- |
| `search` | a city picked from a search box | `search_term`, `city_id`, `city_name` |
| `city_view` | a city panel opens (map, search, trip, Ask) | `city_id`, `city_name`, `country` |
| `finder_filter` | climate conditions change on the map | `conditions`, `condition_count` |
| `shortlist_add` | a city saved to the shortlist | `city_id`, `city_name`, `country` |
| `shortlist_remove` | a city taken off it | `city_id` |
| `trip_create` | a new trip | `trip_count` |
| `trip_add_city` | a stop added to a trip | `city_id`, `city_name` |
| `flight_search_start` | the booking sheet opens | `destination_city_id`, `destination_iata`, `origin_iata`, `from_trip` |
| `flight_search` | offers come back | `origin_iata`, `destination_iata`, `passengers`, `round_trip`, `offer_count`, `offer_source` |
| `flight_booked` | a test booking is made | `test_mode`, `origin_iata`, `destination_iata`, `stops`, `from_trip` |
| `ask_open` | the Ask panel opens | |
| `ask_send` | a question sent to Ask (never its text) | `turn` |
| `login` | owner sign-in (GA4 recommended event) | `method` |

`flight_booked` is deliberately not a GA4 `purchase` with `value`: bookings are
test mode, and a purchase would show up as revenue.

## Set up in GA4 (after the first events arrive)

1. **Key events** (Admin > Events, star them): `shortlist_add`, `trip_create`,
   `flight_booked`, `ask_send`.
2. **Custom dimensions** (Admin > Custom definitions, event scope): `city_name`,
   `country`, `conditions`, `destination_iata`, `offer_source`. Without them the
   parameters are collected but not reportable.
3. **Data retention**: Admin > Data collection > Data retention > 14 months
   (the default of 2 months limits Explorations).
4. **Funnel** (Explore > Funnel exploration, open funnel):
   `search` → `city_view` → `shortlist_add` or `trip_add_city` →
   `flight_search` → `flight_booked`.
5. Internal traffic: define your IP under Data streams > Configure tag settings >
   Define internal traffic, then activate the filter, so your own use drops out.

## Check it works

- Tag Assistant (tagassistant.google.com) on the production URL: before the
  banner, hits show `gcs=G100` (denied); after Allow, `G101` (analytics granted).
- GA4 > Admin > DebugView with Tag Assistant connected shows each event and its
  parameters as you click through.
- DevTools > Network, filter `collect`: requests to `region1.google-analytics.com/g/collect`.
  A CSP error in the console means the deployment was built without `VITE_GA_ID`.
- `VITE_GA_ID` is read at build time: changing it needs a redeploy.
