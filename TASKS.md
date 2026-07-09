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
- [frontier] A1 — Agent tool core server/lib/agent/* + rewritten /api/agent/chat (streamText+tools, mock parity) + legacy wrappers + tests (Sonnet)

### Phase C — UI (each blocked on its design brief + its server task)
- [frontier] B2 — Booking flow UI (Sonnet, dispatched)
- [frontier] S2 — Seasonality heatmap page + MetricPanels real strip (Sonnet, dispatched)
- [blocked: D3+A1] A2 — AgentPanel + Open Places surface + delete ChatPanel.tsx + store slice (Sonnet)
- Sequencing note: B2 ∥ S2 first (mostly disjoint files), A2 after or with careful anchors (shares App.tsx/store.ts).

### Phase D — verification gate
- [blocked] V1 — bun typecheck/test/build green
- [blocked] V2 — Review lenses: review-risk (mandatory), review-reliability, review-readability, review-resilience
- [blocked] V3 — feature-finalizer sweep
- [blocked] V4 — mp-standards-spec-review vs f9f3a25 + design-brief drift check
- [blocked] V5 — fix loops (max 3), final report
