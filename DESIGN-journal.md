# DESIGN — Journal & Replay

Scope: spec-journal.md §7 (inbox UI), §8 (UI), §10 (alert delivery) and §14 R1 (unlock).
The type contract is `src/types.ts` → "Journal & Replay". This document covers the UI
only, and an implementer can follow it as written. Terms are those in CONTEXT.md: a **Journey** happened,
a **Trip** is a plan. They never share a surface label.

## 0. Visual language and tokens

The journal is a **logbook**, the replay page is an **almanac**, and the inbox is a **sorting
tray**. All three share the parchment/teletype system already set out in DESIGN-booking.md §0 and
DESIGN-heatmap.md §2. **No new color tokens.** Use only these existing names:

| Role | Token / class (existing) |
|---|---|
| Page, raised, sunk | `--bg`, `--paper`, `--bg2` |
| Text ladder | `--ink` (values) · `--ink2` (body) · `--ink3` (labels) · `--ink4` (disabled / absent) |
| Rules | `--hairline` (row seams) · `--hairline2` (card borders) |
| Brand / counts | `--accent` |
| Positive / alerts / "ok" | `--good` · wash `--bk-booked-wash` |
| Pending / medium confidence / mock | `--hazard` · wash `--bk-mock-wash` |
| Low confidence / destructive | `--warn` · wash `--bk-urgent-wash` |
| Events marker | `--info` |
| Match ramp (replay) | `--heat-b0…b5`, `--heat-b*-ink`, `--heat-na-ink` via `.heat-bN` / `.peak-bN` |
| Shadows | `--shadow` (cards on hover, overlays); overlays use `6px 6px 0 var(--ink)` like `.booking-panel` |
| Fonts | `--display` italic for titles, years, sentences · `--mono` UPPERCASE 0.08–0.22em for labels, numbers and buttons · `--sans` for user text (titles, notes) |

Reused idioms (do not restyle them): `.cmd-overlay` (modal backdrop), `.tm-action-btn`
(secondary), `booking-primary-btn` (primary), `.tm-delete-btn` + its two-step confirm (destructive),
`.tp-link` (inline link), `.sr-pill` (tags), `.bk-badge` + `.bk-badge-mock` (MOCK), `.micro-row`
(key/bar/value rows), `.tp-search` via `seasonality/CitySearchInput`, `.layer-toggle`,
`.cmd-empty-title` / `.cmd-empty-sub` (empty states), `mrd-shimmer` skeleton,
`.agent-brief-loading` dots, `.heat-tooltip` shell. New CSS goes in `src/styles/journal.css`, with every
class prefixed `jr-`. No border-radius beyond the badges' 2px. Hard offset shadows only, never blur.

## 1. Routing, shell, file map, task boundaries

### 1.1 Router
Extend `Route` in `src/lib/router.ts`:
```
| { view: "journal"; sub: "timeline" | "detail" | "inbox" | "replay";
    journeyId?: string; stopIndex?: number }
```
Parse in this order so `:id` does not swallow the keywords: `/journal/inbox` →
`/journal/replay(/:journeyId(/:stopIndex))?` → `/journal/:id` → `/journal`. The
replay suffix is how **Find similar** pre-fills the template. In `App.tsx`, add
`{route.view === "journal" && <JournalPage route={route} />}` beside SeasonalityPage.

### 1.2 Page shell `JournalPage`
`.jr-page` reuses the `.trips-page` overlay contract: `position:absolute; inset:0;
z-index:20; background:var(--bg)`. The globe stays mounted underneath. At the top sits a 36px **sub-nav
strip**, `.jr-subnav` (mono 10px 0.18em, bottom `--hairline2`), in the `.topnav-link` style at a smaller size:
`TIMELINE · REPLAY · INBOX [n] ·` then right-aligned `ALERTS ●` (it opens the alerts panel, §9) and
`+ LOG JOURNEY` (it opens the quick log, §6). Under the strip the sub-view scrolls (`overflow:auto`,
18px gutters, matching SEASONS).

If any journal request returns 401, `JournalPage` renders `UnlockPrompt` (§2) instead of the
sub-view. The sub-nav stays visible, dimmed, with its counts hidden.

### 1.3 Files (`src/components/journal/`) and the four tasks

| Task | Files | Notes |
|---|---|---|
| **(a) shell · timeline · detail · quick log · unlock** | `JournalPage.tsx`, `UnlockPrompt.tsx`, `Timeline.tsx`, `TimelineStats.tsx`, `TimelineFilters.tsx`, `JourneyRow.tsx`, `JourneyDetail.tsx`, `FingerprintPanel.tsx`, `QuickLogSheet.tsx`, `StopEditor.tsx`, `SegmentEditor.tsx`, `MoneyInput.tsx`, `RatingPips.tsx`, `ProvenanceChip.tsx`; `src/lib/journalApi.ts`, `src/lib/journal.ts`; store slice; router; TopBar nav item; `src/styles/journal.css` | Foundation. The other three tasks import from it. |
| **(b) replay** | `ReplayPage.tsx`, `ReplayControls.tsx`, `BendSlider.tsx`, `ReplayGrid.tsx`, `ReplayTooltip.tsx`, `ReplayResultList.tsx`, `WatchSheet.tsx`; the additive props on `seasonality/HeatmapGrid|HeatRow|HeatCell` (§7.4) | Needs (a). |
| **(c) globe** | `JourneysScrubber.tsx`, `LogFromGlobeTray.tsx`, `src/lib/journeyArcs.ts`; edits in `Globe.tsx` (layer, `LayersControl`, draw branch) and in the store (`drawTarget`) | Needs (a) for `journalApi` and `QuickLogSheet`. |
| **(d) inbox · uploads · alerts** | `InboxPage.tsx`, `UploadDock.tsx`, `ClusterCard.tsx`, `CandidateRow.tsx`, `MergePicker.tsx`, `ImportReportStrip.tsx`, `AlertsPanel.tsx`, `src/lib/photoExif.ts`; ticker merge; TopBar count wiring | Needs (a). Reuses `WatchSheet` from (b) only in order to edit a watch. |

**Shared contracts owned by (a)** (freeze these first):
- `journalApi.ts`: `jfetch(path, init)` reads `localStorage["meridian.token"]` inside try/catch,
  sets `Authorization: Bearer`, and on 401 throws `JournalLockedError { reason?: "token_not_configured" }`
  and sets `store.journalLocked = true`. Typed calls: `listJourneys`, `getJourney`, `saveJourney`
  (POST/PUT), `deleteJourney`, `getFingerprint`, `replay`, `getQueue`, `acceptCandidate`,
  `mergeCandidate`, `discardCandidate`, `acceptCluster`, `importCandidates`, upload helpers,
  `listWatches`, `createWatch`, `deleteWatch`, `listAlerts`, `markAlertSeen`.
- Store slice (not persisted): `journalLocked`, `journeys: Journey[] | null`, `importPending: number`,
  `alertsUnseen: number`, `alerts: Alert[]`, `watches: Watch[]`, `quickLog: { open; journeyId?;
  prefillStops? } `, `alertsPanelOpen`, `journalDraw: { active; cityIds: string[] }`,
  `journeyScrub: { mode: "chrono" | "season"; year?: number; month?: number }`.
- `journal.ts`, pure helpers: `journeyStats(journeys, cities)`, `spendEur(journey)`,
  `kmFlown(journey)` (flight segments only, `haversineKm`), `comfortSentence(stops)`,
  `ratingText`, `formatMoney(m)`, `formatRange(a, b)`.

## 2. Unlock prompt `UnlockPrompt` (R1)

Container: an inline dispatch card centered in the page body. It is not a modal, because the lock is the
page's state, not an interruption. `.jr-unlock`: `--paper`, `1px solid var(--ink)`,
`6px 6px 0 var(--ink)`, max-width 460px, padding 22px.

The card holds: eyebrow `JOURNAL · LOCKED` (mono 10px 0.22em `--ink3`) · title `Your journal is private.`
(display italic 26px) · body `Paste the access token set as MERIDIAN_TOKEN on the server. It stays in this
browser.` (`--sans` 13px `--ink2`) · a mono password input with `SHOW` · `UNLOCK →` (primary).
States:
- **missing / wrong token** (401 with no `reason`): the copy is as above. After a failed attempt, show
  `⚠ TOKEN REJECTED` in `--warn` under the input, keep the value, select it.
- **server has no token** (`reason: "token_not_configured"`): hide the input. The title is
  `The journal isn't switched on here.` and the body is `This server has no MERIDIAN_TOKEN set, so journal
  routes stay closed. Set it in the server environment and reload.` There is no button.
- **checking**: the button reads `CHECKING…` with the `.agent-brief-loading` dots and is disabled.
- **success**: write `meridian.token`, clear `journalLocked`, refetch whatever had failed. No toast.

The submit check is `GET /api/journal`. If localStorage throws (private mode), keep the token in memory
for the session and add `NOT SAVED · PRIVATE WINDOW` in `--ink4`. A small `FORGET TOKEN` `.tp-link`
lives in the alerts panel footer (§9) for signing out.

## 3. TopBar: nav item, inbox badge, alert indicator

Add `JOURNAL` as a fourth `.topnav-link` after SEASONS, marked active for any `view === "journal"`.
Inside the button, after the label, render these in order:
- **Inbox badge** `.jr-nav-count`, shown when `importPending > 0`: mono 9px 700, min-width 16px,
  padding 0 4px, margin-left 6px, `1px solid var(--accent)`, color `--accent`, background
  `--bk-mock-wash`. It shows `99+` past 99. Clicking the badge itself goes to `/journal/inbox`
  (stopPropagation); clicking the label goes to `/journal`.
- **Alert indicator** `.jr-nav-alert`, shown when `alertsUnseen > 0`: a 6px `--good` square (the
  `.nt-glyph.good` shape), placed top-right of the label.
- **Locked**: neither one renders. The button `title` is `JOURNAL · LOCKED`.

`aria-label` composes the parts, for example `Journal, 3 items to review, 1 new alert`. Counts are fetched on app
load only when a token exists (`getQueue` and `listAlerts`), then refreshed after every inbox mutation and
every 15 min, on the same interval as the ticker. No token means no request, so a fresh visitor never sees an error.

## 4. Timeline `#/journal`

Top to bottom: header band, stats strip, filter row, then year groups.

**Header** (SeasonHeader idiom): eyebrow `JOURNAL · WHERE YOU'VE BEEN`; title `Logbook`
(display italic 34px); sub `Every journey you've taken, with the conditions you actually met.`
On the right sit `+ LOG JOURNEY` (`booking-primary-btn`) and `LOG FROM GLOBE ↗` (`.tm-action-btn`, §6.3).

**Stats strip** `TimelineStats`: five cells in one row, separated by `--hairline` verticals,
padding 10px 0, with `--hairline2` above and below. Each cell has a big mono 22px 700 `--ink` value and a 9px 0.22em
`--ink3` label below it: `COUNTRIES` · `CITIES` · `NIGHTS AWAY` · `KM FLOWN` · `SPENT (EUR)`. The stats
cover the **filtered** set and only `status: "confirmed"` journeys. Spend is the sum of `Money.eur` across lodging,
segments and experiences, shown as `€12,480`. If some journeys have no money recorded, add the sub-label
`5 JOURNEYS UNPRICED` in `--ink4`, because an absent value is never shown as zero. Loading state: each value is a `--bg2`
shimmer bar 60×20.

**Filters** `TimelineFilters`: a mono 10px row. `YEAR` is a segmented control (`ALL · 2026 · 2025 …`, years
present only). `RATING` is `ANY · ●●●+ · ●●●●+ · ●●●●●`. `TAG` holds `.sr-pill` toggles for each used tag (an
active pill has an `--ink` border and `--ink` text). `DRAFTS` is a `.layer-toggle` and is off by default. Filters live
in local state and mirror into the URL only by staying in memory, which is fine.

**Year group**: a sticky (top:0, `--bg` backing) row with the year in display italic 34px `--ink`.
To its right, in mono 10px `--ink3`, goes `4 JOURNEYS · 38 NIGHTS · 9 CITIES`, followed by a 1px `--hairline2` rule.
Years are newest first, and so are the journeys inside each year.

**Journey row** `JourneyRow`: a 2-line button, full width, padding 10px 12px, `1px solid
var(--hairline)` bottom border. Hover: `--bg2` and a left 2px `--accent` inset (the `.hm-gutter.active` look).
```
MAY 12 – 20     Lisbon & Porto, slow week            ●●●●○   €1,240   ▲ KINDER
8 NIGHTS        LIS → OPO → LIS   ✈ ✈              [food] [coast]          DRAFT
```
The date column is mono 11px, 110px wide. The title is `--sans` 14px 500 `--ink`. The chain line is the IATA (or city
name) chain in mono 10px `--ink3`, with segment-mode glyphs (`✈` flight, `═` train, `▭` bus, `◇` car, `≈`
ferry) after it. `RatingPips` show `●` in `--accent` and `○` in `--ink4`. Spend is mono 11px, or `—` when absent. The
comfort hint comes from `comfortSentence` and reads `▲ KINDER` (`--good`) / `▼ ROUGHER` (`--hazard`) /
nothing. A `DRAFT` `.sr-pill` appears for drafts. The row navigates to `#/journal/:id`.

**Empty** (no journeys): a centered `.jr-empty` card, the same shape as the SEASONS empty card. Serif
`No journeys logged yet.`, sub `LOG ONE BY HAND, DRAW IT ON THE GLOBE, OR IMPORT YOUR BOOKINGS.`, then
three buttons: `+ LOG JOURNEY` (primary), `LOG FROM GLOBE ↗`, `IMPORT → INBOX`. When filters exclude
everything, show `.cmd-empty-title` `NOTHING MATCHES THESE FILTERS` and a `CLEAR FILTERS` `.tp-link`.
**Loading:** three skeleton year groups. **Error** (non-401): `⚠ COULDN'T LOAD THE JOURNAL` with
`↻ RETRY`, using the booking error idiom.

## 5. Journey detail `#/journal/:id`

Layout: `grid-template-columns: minmax(0,1fr) 320px; gap: 28px`. Below 900px it becomes one column and the
right column moves under the header.

**Header**: `← LOGBOOK` `.tp-link`, then the title in display italic 30px, then mono 11px `--ink2`:
`12 MAY – 20 MAY 2024 · 8 NIGHTS · 2 TRAVELLERS`, then `RatingPips` and the tags. Actions sit right-aligned in one row:
`EDIT` (`.tm-action-btn`, opens QuickLogSheet in edit mode) · `FIND SIMILAR ↗` (primary, goes to
`/journal/replay/:id`) · `↻ REPEAT` (`.tm-action-btn`: `createTrip` + `addCityToTrip` per stop, then
navigate to `/trips/:newId`) · `DELETE` (`.tm-delete-btn`, two-step `CONFIRM DELETE` / `KEEP`, then
back to `/journal`). On a draft, a `--hazard` strip reads `DRAFT · NOT YET CONFIRMED` with a `CONFIRM`
button (saves `status:"confirmed"`).

**Left column: itinerary.** This reuses the `.tp-itinerary` rhythm (stop node, leg, stop node):
- **Stop node**: index, IATA mono 13px 700, city name 14px, `ARR 12 MAY · DEP 15 MAY · 3 NIGHTS`, stop
  rating. Under it sits the **lodging line**: `STAY  Casa do Rio · APARTMENT · €420` plus a ProvenanceChip.
  A crowd override, when set, shows `CROWD · YOUR CALL 85`.
- **Segment leg** (between stops, `.tp-leg` style): mode glyph, `TP1023 · TAP`, departure
  date/time, `1,250 KM`, cost, ProvenanceChip. A non-flight leg uses a dashed line (`.tp-leg-line`
  already dashes). Segments that do not join consecutive stops (side trips) list after the chain under the label
  `OTHER SEGMENTS`.
- **Experiences**: grouped under the label `DONE` per stop. Each row has date, title, kind pill, cost, rating and chip.
- **Notes**: `--sans` 13px `--ink2`, pre-wrap, in a `--paper` block.

**ProvenanceChip** (`.bk-badge` geometry, mono 8px 700): the source text is `MANUAL` `BOOKING`
`GMAIL` `JSON-LD` `CALENDAR` `TIMELINE` `PHOTO` in `--ink3` with a `--hairline2` border. Confidence modifies it:
`high` adds nothing, `medium` adds the suffix `· MED` in `--hazard` on `--bk-mock-wash`, and `low` adds `· LOW` in `--warn` on
`--bk-urgent-wash`. `title` shows `sourceRef` and `importedAt`. Use it everywhere an item carries `provenance`.
A `MANUAL` + `high` chip is **hidden** on hand-logged journeys, so the logbook stays calm.

**Right column: FingerprintPanel** (`--paper`, `1px --hairline2`, padding 14px):
- Eyebrow `FINGERPRINT`, with `computedAt` as `--ink4` mono on the right.
- **Sentence** (display italic 17px `--ink`), from `comfortSentence`: a nights-weighted mean of the stops'
  `observed.comfort − observed.normalComfort`. A delta ≥ +8 reads `You got a kinder week than usual —
  comfort 82 against a normal 70.` A delta ≤ −8 reads `A rougher week than the season usually gives — 54 against 68.`
  Anything else reads `About what the season usually gives.` If no stop has `observed`, the line is in `--ink3`: `Weather for these
  dates hasn't been fetched yet.`
- **Dimension rows** (`.micro-row`: key, bar, value) plus a status chip at the far right:
  `MONTH` `COMFORT` `TEMP` `RAIN` `SPEND / DAY` `FLIGHT / 1000 KM` `CROWD (PROXY)`. Status
  `ok` shows the value and no chip. `pending` shows `PENDING` (`--hazard`, wash) with the value `…`, and the row's `title` is `Weather
  service quota hit — retries automatically`. `absent` shows the value `—` in `--ink4` and the chip `NO DATA` in `--ink4`.
  The crowd key always carries `(PROXY)`. Its `title` reads `Estimated from the city's comfort season
  and school holidays in its main source markets — not measured crowds.` With `crowdIsOverride`, the
  chip is `YOUR CALL` in `--ink2`.
- **Spend breakdown**: `.micro-row`s for `STAYS`, `TRANSPORT`, `EXPERIENCES` and `TOTAL` (EUR). An original
  currency other than EUR shows in `title` (`€412 · from 2,350 PLN at 14 May 2024`).
- Under the rows: `FIND SIMILAR ↗` repeated as a `.tp-link`. Per-stop fingerprints appear when you click a stop
  node (the panel header becomes `FINGERPRINT · PORTO`, with `× JOURNEY` to return).

**States.** Loading shows a header skeleton and three node skeletons. Not found shows `.cmd-empty-title`
`NO SUCH JOURNEY` and `← LOGBOOK`. A pending fingerprint polls `getFingerprint` once at 20s while the panel
is visible and stops after 3 tries.

## 6. Quick log (create and edit) and log from globe

### 6.1 Container
`QuickLogSheet` is a modal: `.cmd-overlay` plus a `.jr-sheet` card, sized exactly like `.booking-panel`
(`min(760px,94vw)`, `max-height 86vh`, pinned header and footer, scrolling body). The header is
`+ LOG JOURNEY` or `EDIT · <TITLE>`. The footer has `CANCEL` (`.tm-action-btn`) and `SAVE JOURNEY` /
`SAVE CHANGES` (primary). The discard guard copies booking §2: `DISCARD THIS LOG?` / `Details will be lost.` / `KEEP` / `DISCARD`.

### 6.2 Body sections (top to bottom, mono 9px 0.22em section labels)
1. `TITLE`: a `--sans` input. Placeholder `e.g. Lisbon & Porto, slow week`. If left empty, it auto-fills from the city chain.
2. `STOPS`: an ordered list of `StopEditor` rows. Each row has a `CitySearchInput` (from
   `seasonality/CitySearchInput`, placeholder `City or airport…`), `ARRIVE` and `DEPART` date inputs,
   `RatingPips` (an interactive radiogroup), and a collapsible `+ STAY` with lodging name, kind select and
   `MoneyInput`. The `+ CROWD` control is a 0–100 slider labeled `HOW BUSY WAS IT?` with the end-caps `EMPTY` / `PACKED`.
   Row tools are `↑ ↓ ✕`, using the `.tp-node-actions` style. A new stop's arrive date defaults to the previous stop's depart.
   `+ ADD STOP` uses the `.tm-add-btn` style.
3. `SEGMENTS`: generated automatically, one per adjacent stop pair. The `fromCityId`/`toCityId` fields are fixed by the
   pair. The editable fields are `MODE` (segmented `✈ ═ ▭ ◇ ≈ ·`), `DATE` (defaulting to the previous stop's depart), `CARRIER`,
   `NUMBER` and `MoneyInput`. Reordering stops regenerates the pairs but keeps the mode and cost of any pair that still exists.
   `+ OTHER SEGMENT` adds a free from/to segment.
4. `DONE` (experiences): collapsed by default. Each row has city (a select of the stops), date, title, kind, cost and rating.
5. `JOURNEY`: overall `RatingPips`, `TAGS` (type, then Enter makes an `.sr-pill`, and existing tags are
   suggested), `TRAVELLERS` stepper (1–9, maps to `companions`), and `NOTES` textarea.

**MoneyInput**: a number input (mono, right-aligned, `inputmode="decimal"`) joined to a 3-letter
currency select (EUR first, then the user's recently used currencies, then the ISO list). After save, the
read view shows `€` from the server. Before save, a currency other than EUR shows a hint in `--ink4`: `CONVERTED TO EUR AT
THAT DAY'S RATE ON SAVE`. If the server rejects an FX lookup (R5), the error goes inline under that field:
`⚠ NO EXCHANGE RATE FOR PLN ON 14 MAY 2024 — TRY AGAIN LATER OR ENTER IN EUR`.

**Validation** (inline, mono 9px `--warn`): at least one stop with a city; `DEPART` ≥ `ARRIVE`;
stops in order (`OVERLAPS PREVIOUS STOP`); an amount must be > 0 when present. Saving is blocked until these are valid.
Focus moves to the first error. Every new item gets `provenance: {source:"manual", confidence:"high"}`.
On success, close the sheet, refetch, and navigate to the journey's detail page.

### 6.3 Log from globe (task c)
`LOG FROM GLOBE ↗` (from the timeline or the empty state) calls `navigate("/")`, sets `journalDraw.active = true`,
and sets the store's `drawTarget = "journal"`. The globe owns this flow:
- The existing draw effect branches on `drawTarget`. In journal mode the click appends `cityId` to
  `journalDraw.cityIds` instead of the active trip, and it does not require an active trip. It uses the same
  `nearestAirportCity` (≤ 500 km). The preview line runs from the last picked city. The cursor is a crosshair.
- `.draw-banner` copy: `LOG MODE — click cities in the order you visited · ⌫ undo · esc to cancel`.
- `LogFromGlobeTray` is fixed at bottom-center above the `ga-bl` annotation, on `--paper` with `1px --ink` and
  `--shadow`. It shows the chain `LIS → OPO → MAD` as IATA chips with an index, then `UNDO` (`.tm-action-btn`) and
  `SET DATES →` (primary, disabled until there is at least 1 city). Picked cities draw as small `--ink3` dots joined by
  the journey arc style (§10).
- `SET DATES →` opens `QuickLogSheet` with `prefillStops` (cities only) and focuses the first `ARRIVE`.
  This is the "date sheet". Saving leaves the user on the globe with the journeys layer forced on.
- `Escape` or `Backspace` on an empty chain exits. The global Escape handler already calls `setDrawMode(false)`,
  and it must also clear `journalDraw`.

## 7. Replay `#/journal/replay`

### 7.1 Layout
A three-zone grid: `grid-template-columns: 280px minmax(0,1fr) 320px; gap: 0`, with each zone
separated by a `--hairline2` vertical. Below 1200px the right list moves under the grid. Below 760px the controls
collapse into a `CONTROLS ▾` disclosure above the grid.

**Header band** (full width): eyebrow `REPLAY · FIND ANOTHER WINDOW LIKE…`, title `Replay` (display
italic 34px). The **disclosure line** is mono 9px `--ink4`: `CLIMATE STAGE · 120 CITIES × 12 MONTHS ·
PRICES FOR TOP 20 FROM LIS`. The numbers come from `universeSize` and `fromCityId`. If
`universeSize < 60`, append ` · THIN COVERAGE — RESULTS LIMITED TO CACHED CITIES` in `--hazard`.

### 7.2 Left: `ReplayControls`
- `TEMPLATE`: a select of confirmed journeys (`Lisbon & Porto · MAY 2024`, best rated first). When the journey has
  more than one stop, add a stop select (`WHOLE JOURNEY` / `LISBON` / `PORTO`). Under them sits a **template card**: mono 10px
  `MAY · 21°C · 4 MM · €96/DAY · CROWD 62 (PROXY)`. Any dimension not `ok` shows `—` and a tiny
  `PENDING` or `NO DATA` chip. Above the sliders goes the note `NOT SCORED: SPEND — NO MONEY RECORDED` when relevant.
- `BEND` (`BendSlider` × 4): label left, signed value right (mono 11px 700), track below.
  `WARMER / COOLER` −10..+10 °C step 1 (readout `+3 °C`) · `SPEND` −50..+50 % step 5 (`−25 %`) ·
  `CROWDS` −50..+50 step 5 (`FEWER 20` / `MORE 20`) · `MONTH` −6..+6 step 1 (`+2 MO → JUL`).
  `MONTH` has an `ANY MONTH` `.layer-toggle` beside it. When the toggle is on, the slider is disabled (`--ink4`) and
  `monthShift: null`. The track is 2px `--hairline2` with a 1px `--ink3` center detent tick. The fill runs from center to
  the thumb in `--accent`. The thumb is a 10×14 `--ink` block. Double-click a slider to reset it to 0. A `RESET BEND` `.tp-link` resets all four.
- `WEIGHTS`: four `BendSlider`s, 0..1 step 0.05, for `CLIMATE` `SPEND` `CROWD` `FLIGHT`. Each readout is the normalized
  share (`45 %`). A weight whose dimension is absent on the template shows `NOT SCORED` instead.
- `LIMITS` (collapsed): `EXCLUDE PLACES I'VE BEEN` toggle, `MAX FLIGHT` hours select, `FROM` city
  search (defaulting to home, `FROM LIS · HOME`), `EVENTS` tag pills (from `MeridianEvent` tags, e.g. `ECLIPSE`).

**Re-rank.** Any change sends `POST /api/replay` after a **350ms debounce** and aborts the previous
request through `AbortController`. While a request is in flight, the current grid and list stay in place at `opacity .55` with
a `RE-RANKING…` note (`.agent-brief-loading` dots) in the header. The ranks never blank between requests.
Slider changes only re-request on `input` after the debounce, never on every pixel.

### 7.3 Center: `ReplayGrid`
Rows are the distinct cities in `results`, in order of their best match. Columns are 12 months. A cell is the match
(0–100) for that city×month when that pair is in `results`. Every other month for the city is
**unranked**: it uses the `.heat-na` hatch with `title` `NOT IN TOP 30`. The **match ramp** reuses `heatClass(match)`
and therefore `--heat-b0…b5`, so theme-wipe recoloring works for free. The legend (`HeatLegend` markup,
new labels) reads `MATCH · FAR LOOSE SOME FAIR CLOSE TWIN`, followed by the keys `TEMPLATE MONTH` and `EVENT`.
- **Template month** (the original month of the template, before the bend): every cell in that column gets
  `.jr-tpl` = `outline: 1.5px dashed var(--ink); outline-offset: -3px`, and the header initial is
  underlined `--ink`. When `monthShift ≠ 0`, the header of the target month carries a `▸` mark in `--accent`.
- **Event marker**: a 5×5 `--info` square, absolute at the top-left of the cell, added when `result.events` is non-empty. The cell's
  aria-label appends `, event: Total solar eclipse`.
- Trailing column header `MATCH`: shows the rank `#1` (mono 10px `--ink3`) and the best match (mono 13px 700 in
  `.peak-bN`).
- Gutter: IATA, name, country, and the badge `VISITED` (`.sr-pill`, `--ink3`) when `visitedBefore`, otherwise `NEW`.
  The `↗` button flies to the globe. There is no remove button.
- **Click** a cell to select that city×month: the right list scrolls to that result and outlines it, and the
  row gutter gets `.active`. **G**, double-click or `↗` → `selectCity(cityId)` + `navigate("/")`. Hovering a list row highlights the matching grid
  row's gutter (`.hm-row-hover`).

**ReplayTooltip** reuses the `.heat-tooltip` shell and classes:
```
PORTO · JUN                        VISITED
 84  MATCH · TWIN
──────────────────────────────
CLIMATE  23°C vs 24  ▮▮▮▮▮▯  41%   ← .micro-row: dim, value vs bent template, contribution bar + %
CROWD    48 vs 42 (PROXY) ▮▮▯  18%
SPEND    NOT SCORED
──────────────────────────────
FLIGHT   €184 from LIS  [MOCK]     ← .bk-badge-mock when price.source = "mock"
         baseline €210 · −12 %     ← --good if below baseline, --ink2 otherwise
◆ Festa de São João                ← events, --info
CLICK → SELECT · G → GLOBE
```
Dimensions not in `scoredOn` list as `NOT SCORED` in `--ink4`. When `price.source` is `serpapi` or `duffel`, show the source name
in `--ink4` mono 8px with no badge (the MOCK-only rule from agent-places §7.3). A mock price has a footnote:
`MOCK PRICE · NOT USED FOR SCORING`.

### 7.4 Required additions to the seasonality components
These are additive and optional, with defaults that keep SEASONS unchanged. **Months:** the grid is 0-based
(`col`) and replay is 1-based (R3). `ReplayGrid` converts with `col = month − 1` in one place only.
- `HeatmapGrid`: add `ariaLabel?` (default `"Seasonality heatmap calendar"`), `gutterHeader?`
  (`"CITY"`), `trailHeader?` (`"BEST"`), `markedCols?: { col: number; kind: "template" | "target" }[]`
  for header marks, `renderTooltip?: (row, col, anchor) => ReactNode | null`, and `describeCell?: (row, col) =>
  string` for the live region. Refactor the tooltip state to `{anchor, row, col}`. The default renderer builds the
  existing `HeatTooltipData`.
- `HeatRow` / `RenderRow`: widen `badge` with `"VISITED" | "NEW"`. Allow `months: (RowMonth | null)[]`, where null means that
  cell renders `state:"na"`. Add `bestWindow?: boolean` (default true; replay passes false, which skips `rowWindow`
  and the teal rings, since teal is not used on this page), `cellMeta?: ({ template?: boolean; eventTitles?: string[];
  naTitle?: string } | undefined)[]` (length 12), `trail?: { label: string; score: number }` to replace
  the BEST summary, and `cellLabel?: (col, m) => string` to replace the comfort-worded aria label.
- `HeatCell`: add `isTemplate?` (→ `.jr-tpl`), `eventCount?` (→ the marker span plus the aria suffix), and `naTitle?`
  (overrides `NOT IN DATASET`).
`ReplayGrid` is a thin adapter. It builds `RenderRow[]` from `ReplayResponse` and passes `regionRows=[]`,
`regionsLabel=""` and `onRemove={() => {}}`.

### 7.5 Right: `ReplayResultList`
Header `RANKED · 30` with `WATCH THIS QUERY` (`.tm-action-btn`, opens `WatchSheet`, §9). Each row:
```
01  OPO  Porto · JUN            84      ← rank mono --ink4, IATA 13px 700, name, match .peak-bN 18px
    ✈ €184 [MOCK] −12%  ◆ 1 EVENT  VISITED
    ▮▮▮▮▯ CLIMATE ▮▮ CROWD           ← top-2 contributions, mono 8px
    [↻ REPEAT]  [WATCH]
```
`REPEAT` creates a Trip `<city> · <MONTH>` with `fromCityId` and the matched city, then sends the user to `/trips/:id`. `WATCH` opens
`WatchSheet` pre-filled with the label `Like <template> → <city> <MON>` and with `constraints.months` narrowed
to `[result.month]` (see the gaps section). The selected row gets a left 2px `--accent` and `--bg2`.

### 7.6 States
- **Locked** → UnlockPrompt.
- **No confirmed journey**: the grid area shows `.jr-empty` `Nothing to replay yet.` / `LOG A JOURNEY
  FIRST — REPLAY USES IT AS THE TEMPLATE.` / `+ LOG JOURNEY`.
- **First load**: the grid skeleton is 8 rows of shimmer cells and the list is 6 shimmer rows.
- **No results** (constraints too tight): `.cmd-empty-title` `NOTHING CLEARS THESE LIMITS` / sub `Loosen month,
  flight time or event filters.`
- **Template fingerprint pending**: a `--hazard` strip `TEMPLATE WEATHER STILL LOADING — CLIMATE SCORED ON SEASON
  NORMALS ONLY` (the ranking still runs).
- **Error**: the stale results stay visible, with a header note `⚠ RE-RANK FAILED · ↻ RETRY`.

## 8. Inbox `#/journal/inbox` (task d)

**Header**: eyebrow `INBOX · REVIEW BEFORE IT JOINS THE LOGBOOK`, title `Inbox`, meta `37 ITEMS IN 6
SUGGESTED JOURNEYS`. The `UploadDock` sits under the header, followed by the latest `ImportReportStrip` and then the cluster cards.

**UploadDock**: three equal tiles (`--paper`, `1px dashed var(--hairline2)`, padding 14px, drop
target. On dragover the border turns solid `--ink` and the background `--bg2`):
- `EMAIL` (`.eml`, `.mbox`): sub `Booking confirmations with structured markup. Others are counted, not guessed.`
- `LOCATION HISTORY` (Timeline `.json`): sub `Nights away from home become stops. The file isn't kept.`
- `PHOTOS` (a folder picked through `<input webkitdirectory>`): sub `Only time, place and a fingerprint of each photo
  leave this device — never the images.` in `--ink2`, plus a `PRIVACY` `.tp-link` that expands the exact list
  `timestamp · lat · lng · hash`. `photoExif.ts` reads them with `exifr`, skips files without GPS, hashes, and
  POSTs `ImportCandidate[]` in batches of 500. Progress: `READING 412 / 1,280 · ON THIS DEVICE`, with a 2px
  `--accent` bar and a `CANCEL` button.
Each tile has a `CHOOSE FILE` `.tm-action-btn`, so the drop target is not the only way in. Uploading states: `UPLOADING…` → report.
A footer line (mono 9px `--ink4`): `GMAIL + CALENDAR IMPORT RUNS AS A SCHEDULED CLAUDE TASK · SEE
docs/ingest/gmail-import-task.md`.

**ImportReportStrip**: one mono row in the teletype style, top and bottom `--hairline2`:
`RECEIVED 214 · ADDED 37 · DUPLICATES 170 · UNSTRUCTURED 7`. `ADDED` is in `--good`. `DUPLICATES` and `UNSTRUCTURED` are in
`--ink3`. When `errors` is present it shows `· 2 ERRORS ▾` in `--warn`, which expands into a list. Dismiss with `✕`. Only the latest report shows.

**ClusterCard** (`--paper`, `1px --hairline2`, `--shadow` on hover only):
- Header: `12–20 MAY 2024` (mono 11px), the title (`--sans` 15px 500), the chain `LIS → OPO`, and `5 ITEMS`. When
  `lowConfidence`, add a `LOW CONFIDENCE` chip (`--warn` on `--bk-urgent-wash`) and a left 2px `--warn` bar.
- Body: `CandidateRow`s. Each has a kind label (`FLIGHT`/`STAY`/`DONE`/`STOP`, mono 9px `--ink3`, 44px), a summary
  (`TP1023 LIS → OPO · 14 MAY`, or the `cityHint` for unresolved cities), a ProvenanceChip, flags as `--warn` mono 8px text
  (`UNRESOLVED CITY "Oporto Cty"`), and the per-row actions `✓` accept · `⇢` merge · `✕` discard, as 24px icon
  buttons with `aria-label`s. A row in flight is dimmed with dots. A done row collapses with a 150ms fade.
- Footer: `ACCEPT AS JOURNEY` (primary, `acceptCluster`) · `MERGE INTO…` (opens MergePicker) · `DISCARD
  ALL` (`.tm-delete-btn`, two-step). If any row has `unresolved-city`, `ACCEPT AS JOURNEY` stays enabled and
  its title reads `Unresolved items are skipped — fix them after accepting`.
- **MergePicker**: a popover anchored to the button (`--paper`, `1px --ink`, `--shadow`, 300px). At the top,
  `SUGGESTED` lists `suggestedJourneyId` and the confirmed journeys within ±14 days. Below that is a search over all
  journeys by title or city. Picking one confirms with the inline `MERGE 5 ITEMS INTO "Lisbon & Porto"? · MERGE · KEEP`.
**States**: **empty queue** shows `.jr-empty` `Inbox zero.` / `IMPORTS LAND HERE FOR REVIEW. NOTHING JOINS YOUR
LOGBOOK WITHOUT YOU.` with the dock still visible. **Loading** shows 2 skeleton cards. **Locked** shows UnlockPrompt.
After each mutation, refetch the queue (clusters are recomputed server-side) and update `importPending`.

## 9. Watches and alerts (WatchSheet is task b, the rest is task d)

**WatchSheet**: `.cmd-overlay` plus a 440px `.jr-sheet`. Header `◎ WATCH THIS WINDOW`. Fields:
`LABEL` (pre-filled). `LEAD TIME` is two number inputs `FROM [6] TO [14] WEEKS AHEAD` (1–52, from ≤ to). `PRICE RULE`
is a radiogroup: `BELOW WHAT I USUALLY PAY` (`below_my_median`, default) · `PROVIDER SAYS LOW`
(`deal_low`) · `UNDER €[ ]` (`{maxEur}`, with a number input enabled only when selected). A read-only summary
(mono 9px `--ink3`) repeats the query: `TEMPLATE LISBON MAY · +3°C · −25 % SPEND · MONTHS JUN`. `SAVE WATCH`
is primary. Success closes the sheet and flashes `WATCHING` on the trigger for 2s.

**AlertsPanel** opens from the `ALERTS ●` sub-nav item and from a ticker click. It is a modal like BookingsPanel
(`min(680px,92vw)`). It has two sections:
- `ALERTS`: newest first. Unseen rows have a 6px `--good` square and `--ink` text. Seen rows are `--ink3`.
  The row reads `OPO · JUN   €184  vs €210 usual  −12 %   from "Like Lisbon May"   2 DAYS AGO`. A
  `.bk-badge-mock` appears when `source` is mock. The actions are `OPEN IN REPLAY` (navigates with the watch's query) · `↻ REPEAT` · `MARK SEEN`.
  Opening the panel does not auto-mark anything as seen.
- `WATCHES`: label, lead window `6–14 WK`, rule, `LAST RUN 3 H AGO` or `NEVER RUN`, an active `.layer-toggle`, and
  `DELETE` (two-step).
- Empty: `NO ALERTS YET` / `Watches check daily. You'll see a window here when it's bookable and cheap.`
- Footer: `FORGET TOKEN` `.tp-link` (§2).

**Ticker**: when the journal is unlocked, merge each unseen alert into the ticker list as a `TickerItem` on the client:
`{glyph:"good", location:"OPO · JUN", text:"Watch “Like Lisbon May”: €184, 12 % under what you usually pay", time}`.
Put them first in the set. Clicking one opens the AlertsPanel.

## 10. Globe journeys layer and time scrubber (task c)

**Layer**: add `{ key: "journeys", label: "JOURNEYS" }` to `GLOBE_LAYERS` after ROUTES. It is off by default.
When it is locked, clicking it navigates to `/journal`, which shows the unlock card, and the item reads `JOURNEYS · LOCKED` in `--ink4`.
Source `journey-arcs` is built by `journeyArcs.ts` from confirmed journeys' segments. Flights use
`flightPath` (with the same hub routing), and other modes use a plain great circle. A `journey-stops` source holds circles.
Insert the layer **below** `route-lines`, so planned trips always draw on top.

| Paint | Journey arcs | (Trip routes, for contrast) |
|---|---|---|
| color | `getCSSVar("--ink3")`, re-read on theme change the way routes are | trip color |
| width | 1.0 (highlighted year or month 1.4) | 1.4 / active 2.8 |
| opacity | 0.55 (highlighted 0.9, faded 0.18) | 0.9 |
| dash | flight solid. Non-flight `[3, 2]` | suggested `[2, 2]` in accent |
| stops | circle r 2.5, `--ink3`, stroke 1 `--bg`. No labels below zoom 3, then IATA in mono `--ink3` | |

Hovering an arc shows a MapLibre popup in the `.heat-tooltip` style: `LISBON → PORTO · 14 MAY 2024 · ✈ TP1023`.
Clicking it navigates to `/journal/:id`.

**Scrubber** `JourneysScrubber`: it renders **inside `.layers-pop`**, directly under the JOURNEYS
item, only while that layer is on. When it shows, the popover widens to 240px. Its parts:
- A mode segmented control `BY YEAR · BY SEASON` (mono 9px).
- **BY YEAR** (chronological): a range slider over the years present, with a value readout like `2019 → 2024`, plus a
  `▶` play button that steps forward one year every 900ms and stops at the end. Arcs up to the cursor year draw. The cursor year is
  highlighted and earlier years are faded. The `ALL` end of the slider shows everything at normal opacity.
- **BY SEASON** (all years folded): 12 month-initial buttons `J F M A M J J A S O N D`, one selectable,
  plus `ALL`. Only stops and segments whose date falls in that month draw, highlighted. The caption is display
  italic 13px `--ink3`: `Where you usually are in March.`
- Keyboard: the slider is a native range input. The month buttons form a radiogroup with arrow keys. Play has an `aria-pressed` state.
  Under `prefers-reduced-motion`, play steps without the opacity fade.
State goes in `journeyScrub` in the store, so it survives closing the popover.

## 11. Keyboard and accessibility basics

Overlays (QuickLogSheet, WatchSheet, AlertsPanel) are `role="dialog"` + `aria-modal` +
`aria-labelledby`. Each one traps focus, closes on `Escape` subject to the discard guard, and returns focus to whatever opened it.
The sub-nav is a `nav` with `aria-current="page"`, and counts sit inside the accessible names. `RatingPips` is a `radiogroup`
(arrow keys, `3 of 5`) when editing. `BendSlider` is a native range input with `aria-valuetext` (`3 degrees warmer`,
`any month`). The replay grid keeps the heatmap §4.3 roving tabindex. `describeCell` announces `Porto, June: match 84,
twin, event Festa de São João`, and a finished re-rank announces once through `aria-live="polite"` (`Re-ranked: Porto in June now first`).
Upload tiles are real buttons, so drag-and-drop is optional. Every chip or badge has a plain-words `aria-label` (`Imported from
Gmail, low confidence`, `Mock price, not used for scoring`, `Crowd level is an estimate`). Labels are `--ink3` or darker on
`--paper`. `--ink4` is used only for absent, disabled or footnote text.

## 12. Spec gaps this design assumes (planner to rule)

1. **Replay grid density.** `results` holds only the top-N city×month pairs, so most cells in a city's row
   are unranked. The design hatches them (§7.3). If the planner wants a full row, `ReplayResponse` needs
   per-city 12-month match scores for the result cities.
2. **No alerts read API.** §10 defines watch routes but has nothing for `GET /api/alerts` or marking an alert seen.
   The UI assumes `GET /api/alerts` and `POST /api/alerts/:id/seen` (token-gated).
3. **A watch can't target one city.** `Watch.query` is a whole replay query. A result-row WATCH narrows only
   `constraints.months`. Adding `constraints.cityIds?` would make it exact.
4. **Cluster-level merge.** Only per-candidate merge exists. MERGE INTO… on a card loops over its candidates
   unless `POST /api/import/cluster/:id/merge {journeyId}` is added. The merge body shape (`{journeyId}`) is not specified.
5. **Unresolved cities can't be fixed in review.** There is no endpoint to resolve `cityHint` → `cityId`. The design
   skips those items on accept.
6. **Upload route names** (.eml/.mbox and Timeline) are not named in the spec. The UI calls `journalApi` helpers that task P defines.
7. **No journey-level "normal" values.** The comfort sentence is derived from stops' `observed.normalComfort`, so
   "warmer than usual" can only be said in comfort terms (there is no normal temperature).
