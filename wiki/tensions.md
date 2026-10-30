# Tensions — the human's inbox

> Open questions you must rule on. More important than the session dashboard.
> A tension is resolved when you rule; the ruling is appended to log.md and the
> tension is struck. Resolving tensions is the loop that keeps you in the
> architecture seat.

<!-- tension:T1 open -->
**Tension:** `/api/bookings*` holds passenger PII with no auth, and the journal and replay routes now require `MERIDIAN_TOKEN`. Does the same gate cover bookings now, breaking any client that sends no header, or does it ship as a separate change? Which wins, and why?

**Options:** (a) gate bookings with the same token in this build; (b) separate change after the journal gate is live.
**Default taken in this build:** bookings stay ungated (R2, ADR 0004); separate change.
<!-- /tension -->

<!-- tension:T2 open -->
**Tension:** The in-app chat's OpenAI key is out of quota. Do we fix billing, switch the AI SDK provider, or accept mock chat while ingestion runs as a scheduled Claude task (D4)? Which wins, and why? Replay is unaffected either way.

**Options:** (a) fix billing; (b) switch the AI SDK provider; (c) keep mock-capable chat and ingest via scheduled task.
**Default taken in this build:** (c). In-app chat stays mock-capable; ingestion runs via scheduled task.
<!-- /tension -->

<!-- tension:T3 open -->
**Tension:** Replay is capped by the 120-city seasonality cache, so a city outside it is not a candidate unless surfaced on demand. Does P2 add a nightly, rate-limit-polite backfill of the cache, or stay on-demand only? Which wins, and why?

**Options:** (a) nightly backfill in P2; (b) on-demand only, as ADR 0002 amended.
**Default taken in this build:** (b) on-demand only. Nightly backfill not built.
<!-- /tension -->

<!-- tension:T4 open -->
**Tension:** Crowd is a labeled proxy built from comfort-peak and holiday data, because no free, reliable global crowd dataset exists. Is proxy v1 enough, or does a paid source (Google Trends via SerpAPI) become a P2 extension? Which wins, and why?

**Options:** (a) accept proxy v1; (b) add Google Trends via SerpAPI as a P2 extension.
**Default taken in this build:** (a) labeled proxy, shown as a proxy in the UI.
<!-- /tension -->

<!-- tension:T5 open -->
**Tension:** Replay cells are destination × month (D5), so a spring match cannot be tighter than a month. Do we store weekly normals (about 4x the dataset size) or keep monthly? Which wins, and why?

**Options:** (a) weekly normals now; (b) keep monthly and treat weekly as a later extension.
**Default taken in this build:** (b) monthly.
<!-- /tension -->

<!-- tension:T6 open -->
**Tension:** Watches only fire when something POSTs `/api/watches/run` daily with the token (§10: no in-process timer). Neither a Render Cron Job nor a Claude scheduled task exists yet. Which trigger do we provision? Which wins, and why?

**Options:** (a) Render Cron Job (paid starter plan, lives with the service); (b) scheduled Claude task that curls the endpoint (no Render cost).
**Default taken in this build:** neither provisioned; `render.yaml` documents the need. Watches run only when triggered by hand.
<!-- /tension -->
