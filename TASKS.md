# TASKS — Meridian build (booking pipeline, seasonality heatmap, agent rewrite)

**Destination:** Meridian books flights end-to-end in Duffel test mode, shows real
seasonality as a heatmap calendar, and runs a true tool-calling research agent with an
open-places surface — all verified by green typecheck/test/build and a working dev run.

Baseline commit before any implementation: `f9f3a25`.

## Decisions so far

- Bookings server-side self-contained; trips stay in localStorage (ADR 0001).
- Offers ephemeral, never persisted; book fresh offer in-session; offer_expired → 409 re-search.
- Seasonality precomputed offline (Open-Meteo daily archive aggregated to monthly, multi-year window), committed compact JSON (ADR 0002).
- USER DIRECTIVE (mid-build): seasonality fetched ON-DEMAND for cities we surface — cache miss triggers live Open-Meteo fetch + score + persist; committed dataset is a seed, bulk backfill optional (ADR 0002 amended).
- Pinned seasonality dataset schema: `{version, generatedAt, window, cities: {<cityId>: {months: [{score, tempC, precipMm}] x12}}}`.
- Shared agent tool core; legacy agent endpoints stay as thin wrappers; mock path uses same tools/stream shapes (ADR 0003).
- ChatPanel.tsx deleted with the new AgentPanel (UI task A2).
- Images: Wikipedia REST summary + Commons fallback, User-Agent header, disk cache. No Unsplash.
- Env reality: OPENAI_API_KEY present; DUFFEL_API_KEY + SERPAPI_KEY absent → booking runs mock locally (blocker-note for live-sandbox verification).
- BLOCKER (final report): OpenAI account 429 insufficient_quota (retested twice ~90min apart) — real-LLM chat path unverifiable until user fixes billing; route degrades gracefully to mock. Not a code issue.
- GATE FLAG: server/lib/seasonality.ts getCitySeasonality returns MonthSeasonality[] directly, not {months} as A1's spec assumed — A1 adapter accepts both; verify shape contract consistency in review.
- Each new UI surface gets its own CSS file under src/styles/ (avoid parallel-edit contention on index.css); tokens/vars still come from index.css.
- B1 contract: POST /api/bookings body requires searchSnapshot (client hands live offer back; offers never persisted). offer_expired → 409. Duffel real path code-complete but not runtime-verified (no key); 3 UNCONFIRMED gaps commented in duffel.ts (orders body fields, expired-error code string, cancellation endpoints). paths.ts DATA_DIR now lazy (test isolation).
- Phase C order: B2 ∥ S2 first (only App.tsx overlaps, distinct anchors), A2 last (consumes B2's booking-modal store API).

## Tasks

### Phase A — research & design (no code)
- [done] R1 — Codebase exploration map (Sonnet)
- [done] R2 — API research: Duffel orders/test mode, images, climate (Sonnet → docs/research-apis.md)
- [done] R3 — Architecture judgment pass (Opus): booking shape, seasonality, agent sequencing
- [done] SPEC — spec.md, CONTEXT.md, ADRs 0001–0003
- [done] D1 — DESIGN-heatmap.md (Opus)
- [done] D2 — DESIGN-booking.md (Opus)
- [done] D3 — DESIGN-agent-places.md (Opus)

### Phase B — server foundations (parallel, no UI)
Note: session-limit crash killed the first B1/S1/A1 dispatch before any file was written; re-dispatched fresh.
- [done] B1 — Booking server (Opus): booking.ts + duffel orders/cancel + routes/bookings.ts + tests; 7 files/66 tests green; mock curl cycle proven
- [done] S1 — Seasonality (Sonnet): lib+routes+script+tests green (85/85 repo-wide), curl proven; dataset seeded with 60 real cities (Open-Meteo hourly quota hit; script resumable)
- [done] S1b — On-demand seasonality (Sonnet): resolve/peek split, runtime cache (seed never written), in-flight dedupe, 15s timeout, quota→503 on :cityId, batch caps 4 misses/req and never 503s; 133/133 tests. Live success path unverified (Open-Meteo 429 at proof time — retry before gate).
- [done] A1 — Agent tool core + chat rewrite (Sonnet, survived 2 rate-limit deaths): 4-tool core (searchPlaces/getPlaceImages/getSeasonality/getFlightEstimate, none throw, zod schemas), /chat real path streamText+tools maxSteps 6, mock path via createDataStreamResponse/formatDataStreamPart verified vs ai@4.3.19, legacy endpoints shape-intact curl-confirmed; 134/134 tests; mock stream proof w/ real Wikipedia images + Madrid seasonality. New types in src/types.ts.

### Phase C — UI (each blocked on its design brief + its server task)
- [done] B2 — Booking flow UI (Sonnet, survived 3 rate-limit deaths): 11 components + booking.css + bookingApi (20 pure-logic tests); TripsPage BOOK affordance + badges + BOOKINGS link; store booking slice (not persisted); App mounts; offer-expired auto re-search recovery + anti-double-booking RETRY + a11y per brief §10; typecheck/tests(134)/build green, runtime smoke proven. 7 documented conservative calls — skim at design-drift check. Exported CitySearchInput from TripsPage (may resolve S2 duplication — check at readability lens).
- [done] S1c — Backfill re-run: dataset now 120 cities (window 2015-2024), quota 429'd again mid-run, clean partial exit; resumable anytime. On-demand covers misses. Live on-demand success re-proof still pending (quota-bound) — retry at gate.
- [done] S2 — Seasonality heatmap UI (Sonnet): #/seasons route + SEASONS nav, components/seasonality/*, styles/seasonality.css ramp both themes, MetricPanels fake sparkline replaced with real SeasonStrip, 4s single re-request for on-demand nulls; typecheck/tests(133)/build green. Commit held until B2 lands (shared store.ts/App.tsx). Note: CitySearchInput duplicated from TripsPage (flag for readability review).
- [frontier] A2 — AgentPanel + Open Places surface + delete ChatPanel.tsx + store slice (Sonnet, dispatched — gates D3+A1+B2 all open)
- Sequencing note: B2 ∥ S2 first (mostly disjoint files), A2 after or with careful anchors (shares App.tsx/store.ts).

### Phase D — verification gate
- [blocked] V1 — bun typecheck/test/build green
- [blocked] V2 — Review lenses: review-risk (mandatory), review-reliability, review-readability, review-resilience
- [blocked] V3 — feature-finalizer sweep
- [blocked] V4 — mp-standards-spec-review vs f9f3a25 + design-brief drift check
- [blocked] V5 — fix loops (max 3), final report
