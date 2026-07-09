# API Research: Flights, Place Images, Climate/Seasonality

Research for a Bun + Hono + TypeScript travel app backend, using plain `fetch` clients (no vendor SDKs). All facts below are sourced from official/primary documentation, with URLs cited per section. Anything not confirmed by a primary source is explicitly marked **UNCONFIRMED**.

Date of research: 2026-07-09.

---

## 1. Duffel API v2 — booking flow in TEST mode

### Test vs live keys / sandbox

- Test (sandbox) access tokens start with the prefix `duffel_test_`; live tokens use a different prefix. A test token only sees/creates resources in test mode, a live token only sees/creates resources in live mode.
  Source: [Test mode | Duffel Documentation](https://duffel.com/docs/api/overview/test-mode/duffel-airways)
- Test mode is described as risk-free: no money is spent and no real flights are booked.
  Source: same as above.
- **Duffel Airways** is Duffel's own proprietary sandbox airline for testing:
  - Airline name: `Duffel Airways`, IATA code `ZZ`.
  - Supports fare brands, seat maps, baggage/services purchase, order creation, cancellations, and flight changes.
  - Trade-off explicitly noted by Duffel: schedules and prices are **not realistic** (it's a synthetic airline for exercising the API surface, not for realistic pricing).
  Source: [Test mode | Duffel Documentation](https://duffel.com/docs/api/overview/test-mode/duffel-airways)
- Duffel also documents **test card numbers** for exercising payment-adjacent flows (relevant mainly to card payment testing, not `balance` payments):
  - `4000 0082 6000 0000` (GB) → success
  - `4000 0000 0000 3220` (US) → triggers 3-D Secure 2
  - `4000 0000 0000 9995` (US) → insufficient funds failure
  - Any 3-digit CVC and any future expiry date is accepted.
  Source: [Test mode | Duffel Documentation](https://duffel.com/docs/api/overview/test-mode/duffel-airways)

### Full booking flow

1. **Create an offer request** — `POST https://api.duffel.com/air/offer_requests`
   Required body fields:
   - `slices` — array of desired journey legs (one-way = 1 slice, return = 2 slices).
   - `passengers` — array of passenger descriptors (each with `type` or `age`; type may resolve differently per airline rules based on age).
   Optional fields include `cabin_class` (`first` | `business` | `premium_economy` | `economy`, default unset), `max_connections` (default 1), `include_split_ticket` (default false), `private_fares`, `airline_credit_ids`.
   The response contains an `offers` array.
   Source: [Offer Requests | Duffel Documentation](https://duffel.com/docs/api/offer-requests/create-offer-request)

2. **Re-fetch a single offer before booking** — Duffel explicitly recommends fetching the specific offer by ID ("Get a single offer") right before order creation to get current, guaranteed pricing rather than relying on the (possibly stale) offer_request list.
   Source: [Getting Started with Flights | Duffel Documentation](https://duffel.com/docs/guides/getting-started-with-flights)

3. **Create an order** — `POST https://api.duffel.com/air/orders`
   (Confirmed exact method/path via the Orders collection page, which shows `GET https://api.duffel.com/air/orders` for listing, and via the "Getting Started with Flights" guide, which documents the order-creation body against the `/air/orders` resource. The precise field-by-field request body for `POST /air/orders` could not be scraped verbatim from the create-order page itself — treat the field list below as **confirmed from the getting-started guide and payments/orders schema pages**, cross-checked, but re-verify field-by-field against the live OpenAPI spec before shipping.)

   Required/relevant body fields:
   - `selected_offers` — array containing the single offer ID being booked.
   - `type` — `"instant"` or `"hold"` (see hold-vs-instant section below).
   - `passengers` — array; each passenger entry keyed by the passenger `id` returned from the offer request, with:
     - `given_name`, `family_name` (required)
     - `born_on` (date, required)
     - `gender` (required)
     - `title` (required)
     - `email` (required — must be the passenger's own email per Duffel's docs)
     - `phone_number` (required)
     - `infant_passenger_id` (only when an adult is responsible for an infant passenger)
   - `payments` — array, **required for `type: "instant"`, omitted entirely for `type: "hold"`**. Each payment object:
     - `type` — one of `balance`, `arc_bsp_cash`, `card`, `airline_credit`
     - `amount` — string, must exactly match the offer/order total
     - `currency` — ISO 4217 code, must exactly match the offer/order currency
     - (card payments also take `three_d_secure_session_id`)
   Sources: [Getting Started with Flights](https://duffel.com/docs/guides/getting-started-with-flights), [Payments | Duffel Documentation](https://duffel.com/docs/api/payments/schema), [Orders | Duffel Documentation](https://duffel.com/docs/api/orders)

   **Test mode balance behavior**: Duffel's payments documentation states explicitly — *"In test mode, your balance is unlimited."* This means `payments[].type = "balance"` works without needing to fund a real account balance while testing.
   Source: [Payments | Duffel Documentation](https://duffel.com/docs/api/payments/schema)

### Offer expiry

- Every offer has an `expires_at` ISO 8601 timestamp; typical validity window is **15–30 minutes** from creation.
- After `expires_at`, the offer can no longer be used to create an order.
- If you attempt to book an expired offer, the API returns an `offer_expired` error. Duffel's guidance: **do not retry** with the same offer — perform a new search and use a fresh offer instead.
- Best practice recommended by Duffel: validate `expires_at` is still in the future client-side before calling create-order, to avoid the error proactively.
  Source: found via primary Duffel docs (response-handling / offers pages) surfaced in search snippets: [Response handling | Duffel Documentation](https://duffel.com/docs/api/overview/response-handling), [Offers | Duffel Documentation](https://duffel.com/docs/api/v2/offers). Exact wording was captured from Duffel's own documentation text as returned by search; recommend a direct re-read of these two pages before final implementation since they could not be fully fetched verbatim in this pass.

### Order response shape (essentials)

Confirmed fields on the Order resource:
- `id` — Duffel's own order ID, e.g. `ord_00009hthhsUZ8W4LxQgkjo`.
- `booking_reference` — the airline's PNR (commonly 6 alphanumeric chars, format varies by carrier).
- `booking_references` — array of all carrier PNRs associated with the order (primary + any additional).
- `type` — `"instant"` or `"hold"`.
- `live_mode` — boolean, true for live-mode orders, false for test-mode orders.
- `content` — `"self-managed"` or `"managed"`.
- `payment_status` — object with:
  - `awaiting_payment` (boolean)
  - `payment_required_by` (ISO 8601, relevant to hold orders)
  - `paid_at` (ISO 8601, nullable)
  - `price_guarantee_expires_at` (ISO 8601)
- Financial fields: `base_amount`/`base_currency`, `tax_amount`/`tax_currency`, `total_amount`/`total_currency`.
- `documents` — array of issued travel documents, each with `type` (e.g. `"electronic_ticket"`), `unique_identifier`, `passenger_ids`.
- Other top-level fields: `created_at`, `synced_at`, `cancelled_at`, `void_window_ends_at`, `available_actions` (e.g. `cancel`, `change`, `update`), `passengers`, `slices`, `services`, `owner`, `users`, `metadata`, `conditions`, `changes`, `airline_initiated_changes`, `cancellation`.
  Source: [Orders | Duffel Documentation](https://duffel.com/docs/api/orders)

### Hold orders vs instant (pay-later)

Pay-later **is** possible via hold orders:
- To book instantly and pay at the same time: `type: "instant"` + a `payments` array.
- To hold space and pay later: `type: "hold"`, **omit** the `payments` key entirely at order-creation time.
- Hold orders are only available on offers where `payment_requirements.requires_instant_payment` is `false`. Duffel notes all American Airlines and Duffel Airways (the test airline) offers are eligible for hold.
- To pay for a held order later: call the "Create a payment" endpoint with `order_id`, `amount` (must match the order's `total_amount`), and `currency` (must match `total_currency`).
- Held orders carry a `payment_required_by` deadline (surfaced in `payment_status.payment_required_by`). If payment isn't made in time, the airline releases the held space and `awaiting_payment` is set back to `false`.
  Source: [Holding Orders and Paying Later | Duffel Documentation](https://duffel.com/docs/guides/holding-orders-and-paying-later)

### Duffel-Version header

- The `Duffel-Version` request header is **mandatory on every request** so Duffel knows which API version to serve.
- Current values: `v2` is the latest, generally-available version (available indefinitely per Duffel's stated policy). `v1` was the prior version and had a stated end-of-life around January 23, 2025.
- Duffel's policy: a new version stays available for 6 months after a newer one ships before being retired; backwards-incompatible changes (removed fields, renamed params, restructured formats, changed status codes) trigger a new version, while backwards-compatible additions (new optional params/response fields) land in the current version without a bump.
- **Recommendation for this project: send `Duffel-Version: v2`.**
  Source: [Versioning | Duffel Documentation](https://duffel.com/docs/api/overview/versioning)

### Rate limits

- Confirmed default: **120 requests per 60 seconds** (i.e. ~2 req/s) for the live environment on search-type endpoints; Duffel states limits can vary by endpoint (each endpoint has its own separate limit) and that this period/value is "subject to change without notice."
- On exceeding a limit, Duffel returns a `rate_limit_error`; the response includes a `ratelimit-reset` header indicating when you can retry.
- Duffel explicitly invites contact for a higher quota if needed.
- **UNCONFIRMED**: exact numeric limits broken out separately for test mode vs. live mode, and for the `/air/orders` endpoint specifically — Duffel's help center rate-limit article (`help.duffel.com/hc/en-gb/articles/10229200096786`) returned HTTP 403 when fetched directly in this research pass and could only be captured via search-result snippets, not the full primary page. Re-check that page directly (it may require being logged in, or blocks bots) before relying on precise numbers for capacity planning.
  Sources: [What is the API rate limit? – Duffel](https://help.duffel.com/hc/en-gb/articles/10229200096786-What-is-the-API-rate-limit) (partial/via search only), [Response handling | Duffel Documentation](https://duffel.com/docs/api/overview/response-handling)

### Duffel Stays — access status

- Duffel Stays (hotel/accommodation booking) is **not self-service / not fully generally available**. Access is granted on a per-request basis, gated behind an explicit access request.
- Flow: sign up for a Duffel account → request access via `duffel.com/contact-us` (per the getting-started guide) → once approved, create a test access token from the dashboard.
- No public waitlist mechanism is documented; it's a manual review/approval process.
  Source: [Getting Started with Stays | Duffel Documentation](https://duffel.com/docs/guides/getting-started-with-stays)

---

## 2. Free place images, zero paid API keys

### Wikipedia REST API — page summary endpoint

- Endpoint pattern: `GET https://en.wikipedia.org/api/rest_v1/page/summary/{title}` (per-language-wiki; swap the subdomain, e.g. `es.wikipedia.org`, for other languages).
- Verified live response (fetched `https://en.wikipedia.org/api/rest_v1/page/summary/Paris` directly as the primary source) includes:
  ```json
  {
    "thumbnail": { "source": "https://upload.wikimedia.org/.../330px-....jpg", "width": 330, "height": 206 },
    "originalimage": { "source": "https://upload.wikimedia.org/.../3840px-....jpg", "width": 4592, "height": 2870 }
  }
  ```
  Both `thumbnail` and `originalimage` are objects with `source` (URL), `width`, `height`. `thumbnail` is a downsized rendition; `originalimage` points at the full-resolution file. Not every page summary has an image (both fields are absent if the page has no lead image).
  Source: live fetch of `https://en.wikipedia.org/api/rest_v1/page/summary/Paris`, and field descriptions from [API:REST API/Reference — MediaWiki](https://www.mediawiki.org/wiki/API:REST_API/Reference).
- **CORS**: the REST API is CORS-enabled for browser use (Wikimedia serves the necessary `Access-Control-Allow-Origin` headers on `rest.wikimedia.org` / `*.wikipedia.org/api/rest_v1/`); for a server-side Bun/Hono client this is moot since CORS only applies to browser fetches, but it means a same client could also be used from a frontend if ever needed.
- **Rate limits** (from the official Wikimedia rate-limits page):
  - Fully anonymous requests with no identifying info beyond IP: **10 requests/minute**.
  - Requests carrying a compliant `User-Agent` (browser-based unauthenticated, or bot with proper `User-Agent`): **200 requests/minute**.
  - Exceeding the limit returns HTTP 429, typically with a `Retry-After` header.
  Source: [Wikimedia APIs/Rate limits — MediaWiki](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
- **User-Agent policy** (mandatory, not optional): Wikimedia requires a descriptive `User-Agent` header in this format:
  `<client name>/<version> (<contact info: URL, email, or wiki username>) <library/framework>/<version>`
  Example given by Wikimedia: `CoolBot/0.0 (https://example.org/coolbot/; coolbot@example.org) generic-library/0.0`.
  Failing to send one risks a 403, being blocked without notice, or generic unhelpful error pages. Never reuse a browser User-Agent string for a bot/script.
  Source: [Policy:Wikimedia Foundation API Usage Guidelines / User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:API_usage_guidelines)

### Wikimedia Commons API — multiple images per place

- No API key required; it's the standard MediaWiki `action=query` API against `commons.wikimedia.org/w/api.php`.
- To get multiple images for a place, typical approach is the `query` action with `list=categorymembers` (to enumerate files in a category, e.g. `Category:Paris`) or `generator=allimages`, combined with `prop=imageinfo&iiprop=url|dimensions|extmetadata` to get URLs/sizes/license metadata per file.
- Example confirmed pattern:
  `https://commons.wikimedia.org/w/api.php?action=query&generator=allimages&prop=imageinfo&gailimit=40&gaisort=timestamp&iiprop=url|user|dimensions|extmetadata&iiurlwidth=300&format=json`
- Freely accessible over plain HTTP(S), standard MediaWiki API conventions apply (same User-Agent policy and rate limits as above, since Commons is a Wikimedia wiki).
  Source: [Commons:API/MediaWiki — Wikimedia Commons](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki) (confirmed via search-result excerpts of the official page; recommend a direct read-through of that page before implementation to lock down exact parameter names, since this pass captured it via search snippet rather than a full page fetch).

### Unsplash API (optional / paid-key path)

- **Key required**: yes — Unsplash requires application registration and an Access Key even for the free "Demo" tier; it is not a keyless API.
- **Free tier limits**: Demo/unapproved apps are capped at **50 requests/hour**. Once an app is reviewed and approved for production use, the limit rises to **1,000 requests/hour**.
- **Attribution requirement**: mandatory under Unsplash's API Guidelines — apps must credit both the photographer and Unsplash, with a link back to the photographer's Unsplash profile, whenever a photo is displayed. This is an API Terms of Service requirement, distinct from (and stricter than) the underlying Unsplash License, which does not itself mandate attribution.
  Source: [Unsplash API Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines), attribution/rate-limit facts as documented on Unsplash's own help center (captured via search-result excerpts of official pages — verify current numeric limits directly against `unsplash.com/documentation` before relying on them, as free-tier numbers are the kind of detail vendors change without notice).

### Recommendation — zero new keys

For a "works with zero new API keys" default: **use the Wikipedia REST API page-summary endpoint** (`thumbnail`/`originalimage`) as the primary image source per place, falling back to a **Wikimedia Commons category query** when a richer gallery (multiple images) is needed. Both require no registration or key — only a compliant `User-Agent` header. Reserve Unsplash as an optional, later-stage enhancement once a key is deliberately provisioned, given its key requirement and mandatory attribution UI work.

---

## 3. Seasonality / climate data per city, monthly resolution, free

### Open-Meteo — Historical Weather (Archive) API

- Endpoint: `GET https://archive-api.open-meteo.com/v1/archive`
- **No API key required for non-commercial use.** Open-Meteo's docs state a key is "only required to commercial use to access reserved API resources for customers."
- Core params: `latitude`, `longitude` (comma-separated for multiple locations in one call), `start_date`/`end_date` (ISO8601 `yyyy-mm-dd`), plus `daily` or `hourly` variable lists, `temperature_unit`, `precipitation_unit`, `timezone`, etc.
- Relevant daily variables: `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `rain_sum`, `snowfall_sum`, `wind_speed_10m_max`, `shortwave_radiation_sum`, and more.
- Historical coverage: ERA5 reanalysis back to **1940** (0.25° resolution), ERA5-Land back to **1950** (0.1° resolution); ECMWF IFS-based data from 2017 onward.
- **Monthly aggregation is not provided directly** — the API returns daily (or hourly) values only; monthly normals/means must be computed client-side by aggregating the daily series yourself. Open-Meteo's own docs flag a caveat: summing daily precipitation into monthly totals can carry small inconsistencies.
  Source: [Historical Weather API | Open-Meteo.com](https://open-meteo.com/en/docs/historical-weather-api)

### Open-Meteo — Climate API (`/v1/climate`)

- Endpoint: `GET https://climate-api.open-meteo.com/v1/climate`
- Also keyless for non-commercial use (same key policy as above).
- This is a **climate-*projection*** API (CMIP6-based downscaled climate models — `CMCC_CM2_VHR4`, `FGOALS_f3_H`, `HiRAM_SIT_HR`, `MRI_AGCM3_2_S`, `EC_Earth3P_HR`, `MPI_ESM1_2_XR`, `NICAM16_8S`), covering `start_date`/`end_date` from 1950 through 2050, not a "climate normals" endpoint. It also returns **daily data only** — no built-in monthly normals.
  Source: [Climate API | Open-Meteo.com](https://open-meteo.com/en/docs/climate-api)

**Conclusion**: For "monthly normals per city," Open-Meteo does not expose a ready-made monthly-normals endpoint. The practical approach is: pull daily data from the **Historical Weather (Archive) API** for a representative period (e.g. the last 10–30 years) per city coordinate, then aggregate to monthly means/sums yourself.

### Rate limits & bulk strategy for ~4,600 cities

Confirmed free/non-commercial limits (Open-Meteo's own pricing page, corroborated by the founder directly on Hacker News):
- **10,000 calls/day**
- **5,000 calls/hour**
- **600 calls/minute**
- A "call" is not strictly 1 HTTP request: **requests covering more than 10 weather variables OR spanning more than 2 weeks of daily data for a single location count as multiple calls** (fractional, e.g. 15 variables over 14 days = 1.5 calls; 4 weeks of data = 3.0 calls). Multi-location requests (comma-separated lat/lng) are billed per location within that same accounting.
- Non-commercial free tier carries **no uptime guarantee**, and the underlying data is CC BY 4.0 — attribution to Open-Meteo is required.
  Source: [Pricing | Open-Meteo.com](https://open-meteo.com/en/pricing), corroborated in [Hacker News comment from Open-Meteo's creator](https://news.ycombinator.com/item?id=46591888)

Given ~4,600 cities and a 10,000-calls/day non-commercial cap, a **one-time bulk backfill job** (not a live-request-per-user pattern) is the only viable strategy directly against Open-Meteo:
- Request daily data in batches using the multi-location comma-separated `latitude`/`longitude` params to reduce per-location overhead, spread across multiple days to stay under the daily cap, then aggregate to monthly normals and cache the result (e.g. in your own SQLite/JSON store) — do not call Open-Meteo live per user request.
- Because a multi-year window (10-30 years of daily data) per city will push several "calls" per city under Open-Meteo's variable/date-range multiplier rule, budget conservatively (assume each city could cost several call-units, not 1), and expect the backfill to take multiple days of batched, rate-limited runs rather than a single pass.

### Static/embeddable alternative: WorldClim

If the Open-Meteo backfill proves too slow/rate-limited for 4,600 cities, **WorldClim 2.1** is a credible, free, static alternative purpose-built for exactly this ("monthly climate normals, globally, precomputed"):
- Provides **monthly** climate normals (1970–2000 baseline average) for minimum/mean/maximum temperature, precipitation, solar radiation, wind speed, and water vapor pressure, plus 19 derived bioclimatic variables.
- Distributed as GeoTIFF raster files, one per month, at four selectable resolutions from 30 arc-seconds (~1 km²) down to 10 arc-minutes (~340 km²) — the coarser 10-minute resolution is more than sufficient for city-level lookups and keeps file sizes small.
- Precompute strategy: download the 12 monthly GeoTIFFs once (offline, not at request time) for the variables you need (mean temp, precipitation), then for each of the 4,600 city lat/lngs do a raster point-lookup (e.g. with a lightweight GeoTIFF reader) to extract the 12 monthly values per city, and persist the result as a flat JSON/SQLite table keyed by city. This entirely avoids runtime API calls and rate limits.
- Licensing/cost: the WorldClim page itself does not display explicit licensing terms — **UNCONFIRMED**, verify the license (WorldClim has historically been free for non-commercial and commercial use, but confirm current terms on the WorldClim site or in the WorldClim 2.1 paper before shipping) before depending on it.
  Source: [WorldClim 2.1 | worldclim.org](https://www.worldclim.org/data/worldclim21.html)

---

## Summary of recommendations for this project

1. **Duffel**: use `duffel_test_...` tokens against `https://api.duffel.com`, header `Duffel-Version: v2`; flow = `POST /air/offer_requests` → fetch single offer → `POST /air/orders` (with `payments: [{ type: "balance", amount, currency }]` for instant test bookings, or `type: "hold"` with no `payments` for pay-later); watch offer `expires_at` (~15–30 min) and handle `offer_expired` by re-searching, not retrying.
2. **Images**: default to Wikipedia REST `page/summary` (`thumbnail`/`originalimage`) with a compliant `User-Agent` header — zero keys, zero cost. Use Wikimedia Commons `action=query` for multi-image galleries. Treat Unsplash as an optional future enhancement requiring a provisioned key.
3. **Seasonality**: precompute monthly normals offline rather than calling any climate API live per request. Prefer a one-time Open-Meteo Historical Weather Archive backfill batched across days under the 10k-calls/day cap, aggregated client-side to monthly figures; fall back to WorldClim 2.1's static GeoTIFF monthly normals (license unconfirmed — verify) if the Open-Meteo backfill is too slow for 4,600 cities.
