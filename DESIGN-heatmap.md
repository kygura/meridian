# DESIGN — Seasonality Heatmap Calendar

Scope: spec.md §4.2 (Seasonality heatmap calendar) and §5 flow 2 ("Find the best
time"). This document specifies the UI surface only. It is the single source of
truth for an implementer. Follow it literally — every size, color, and copy string
below is deliberate. Terms follow CONTEXT.md exactly: **City**, **Region**,
**Comfort Index**, **Seasonality**, **Shortlist**.

The data contract (per spec §4.2): each covered City has 12 monthly entries
`{month: 1–12, score: 0–100, tempC: number, precipMm: number}`. Region aggregates
have the same shape. Endpoints already exist: `GET /api/seasonality/:cityId`,
`GET /api/seasonality?cityIds=a,b,c` (batch), `GET /api/seasonality/regions`.

---

## 0. Design intent

This is a **cartographic dispatch table**, not a dashboard chart. Think of a printed
climate atlas page or a shipping-almanac tide table: a dense monospace grid, hairline
rules, warm ink on parchment (or phosphor glow on navy at night), and one saturated
"heat" ramp doing the talking. The reward the user is hunting — the best months to
visit — must be the thing that visually pops. Everything else recedes.

Two hard rules inherited from the app:
- **Both themes must work.** Light = warm cream parchment; dark = cool terminal navy.
- **Color encoding lives in CSS custom properties**, not JS. JavaScript only computes
  a *bin index* (0–5) per cell. The cell paints itself via `var(--heat-N)`. This means
  the existing theme-wipe transition recolors the entire grid instantly, with zero
  refetch and zero re-render. This is non-negotiable — it is how the rest of the app
  stays theme-correct.

---

## 1. Where the surface lives — new hash route `#/seasons`

**Decision: a new hash route `#/seasons`, rendered as a full-bleed overlay over the
mounted globe, with a new TopBar nav item `SEASONS`. This mirrors the existing
GLOBE / TRIPS pattern exactly.**

Justification:
- TripsPage already establishes this pattern (App.tsx line 85):
  `{route.view === "trips" && <TripsPage tripId={route.tripId} />}` renders inside the
  `center` grid area, on top of the always-mounted `<Globe />`. Seasons is a peer
  page of the same weight (a whole working surface, not a transient panel), so it gets
  the same treatment — not a drawer, not a modal.
- Keeping the globe mounted underneath is deliberate: clicking a row's "fly to" action
  navigates back to `#/` and the map is still warm (no re-init cost), matching how
  TripsPage's `VIEW ON GLOBE ↗` works.
- A dedicated route (not an overlay-with-no-URL) means the calendar is linkable,
  survives refresh, and the nav item can show an `active` state identically to
  GLOBE/TRIPS.

Implementation touch-points:
- `src/lib/router.ts` — extend `Route` and `parseHash`:
  ```
  export type Route =
    | { view: "globe" }
    | { view: "trips"; tripId?: string }
    | { view: "seasons" };
  ```
  Add `if (path === "/seasons") return { view: "seasons" };` before the trips match.
- `src/App.tsx` — add `{route.view === "seasons" && <SeasonalityPage />}` next to the
  TripsPage line.
- `src/components/TopBar.tsx` — add a third `.topnav-link` after TRIPS:
  ```
  <button className={`topnav-link ${route.view === "seasons" ? "active" : ""}`}
          onClick={() => navigate("/seasons")}>SEASONS</button>
  ```
  Reuse the existing `.topbar-nav` / `.topnav-link` styles verbatim — no new nav CSS.

The page container reuses the `.trips-page` overlay conventions: absolute fill of the
center area, `background: var(--bg)`, `overflow: auto`, sits above the globe.

---

## 2. Color encoding — the Comfort Index ramp (both themes)

The Comfort Index is 0–100 where **higher = more comfortable = the answer the user
wants**. So the ramp is **sequential** (not diverging) and is tuned so that high
comfort is the most saturated / most eye-catching band. Six bins:

| Bin | Score range | Word label (mono) |
|-----|-------------|-------------------|
| 0 | 0–16   | HARSH |
| 1 | 17–33  | THIN  |
| 2 | 34–50  | MILD  |
| 3 | 51–66  | FAIR  |
| 4 | 67–83  | GOOD  |
| 5 | 84–100 | PRIME |

Binning function (the ONLY color logic in JS):
```
function comfortBin(score: number): 0|1|2|3|4|5 {
  if (score >= 84) return 5;
  if (score >= 67) return 4;
  if (score >= 51) return 3;
  if (score >= 34) return 2;
  if (score >= 17) return 1;
  return 0;
}
```
The cell then gets class `heat-b0 … heat-b5` (or `heat-na` for missing data). All
color, including the cell's own text color, comes from CSS.

### Why this ramp (colorblind + print rationale)

Both themes use a **single warm hue arc** that is *monotonic in lightness* — each bin
is meaningfully lighter or darker than its neighbor. Monotonic lightness is what makes
a sequential ramp safe for every type of color-vision deficiency: even if hue collapses
entirely (grayscale), the order 0→5 is still perfectly readable. A single warm family
(straw → amber → sienna in light; ember → gold in dark) is also the single most
*print-map-plausible* sequential scheme — it is the classic sepia/`YlOrBr` atlas ramp,
and it lives natively in Meridian's parchment palette. The brand accent (burnt-orange
`#c2680c` light / amber `#f59e0b` dark) falls inside the ramp at the GOOD band, so the
grid feels like it belongs to the app without the accent being reserved for it.

The "best window" highlight (see §2.3) is drawn in **teal** (`--good`), which is
hue-opposite and lightness-distinct from every warm bin — distinguishable for
protan/deutan/tritan viewers alike — so the "go now" marker never gets lost in the heat.

### 2.1 Light theme ramp (warm sepia on cream)

Add to `:root` in `src/index.css`:
```
--heat-b0: #efe6c7;  --heat-b0-ink: #7a6b45;   /* HARSH  — pale straw, near paper   */
--heat-b1: #e8ce86;  --heat-b1-ink: #5c4a1f;   /* THIN   — straw gold               */
--heat-b2: #ddab4e;  --heat-b2-ink: #43320f;   /* MILD   — amber                    */
--heat-b3: #ce7f22;  --heat-b3-ink: #fbf5e6;   /* FAIR   — burnt amber (paper ink)  */
--heat-b4: #c2680c;  --heat-b4-ink: #fbf5e6;   /* GOOD   — accent burnt-orange      */
--heat-b5: #8f4a0e;  --heat-b5-ink: #fbf5e6;   /* PRIME  — deep sienna, darkest     */
--heat-best: #0f766e;                          /* teal = best-window marker (--good)*/
--heat-na-ink: #b3a98f;                        /* --ink4 for NO DATA hatch/text     */
```
Bins 0–2 are light enough to carry dark `-ink` text; bins 3–5 carry paper-colored text.
The `-ink` var is the cell's own text color and must be applied by the `.heat-bN` class.

### 2.2 Dark theme ramp (phosphor amber on navy)

On the near-black terminal background, brightness reads as intensity, so the ramp runs
dim→bright (dim ember = low comfort recedes into the field; bright gold = PRIME glows).
Add to `html[data-theme="dark"]`:
```
--heat-b0: #3a2a16;  --heat-b0-ink: #9a8460;   /* HARSH  — dim ember                */
--heat-b1: #6e4a18;  --heat-b1-ink: #e6cfa4;   /* THIN                              */
--heat-b2: #a06a16;  --heat-b2-ink: #0b0f17;   /* MILD                              */
--heat-b3: #d08a18;  --heat-b3-ink: #0b0f17;   /* FAIR   — bg-colored ink           */
--heat-b4: #f59e0b;  --heat-b4-ink: #0b0f17;   /* GOOD   — accent amber             */
--heat-b5: #fbc55a;  --heat-b5-ink: #0b0f17;   /* PRIME  — bright gold, brightest   */
--heat-best: #2dd4bf;                          /* teal (--good dark) — the glow motif*/
--heat-na-ink: #4a5468;                        /* --ink4 dark                       */
```
Bins 0–1 (dim) carry light text; bins 2–5 (bright) carry bg-colored dark text.

Because these are the same variable *names* in both blocks, `.heat-bN` rules are written
once and are automatically correct in both themes. Example rule set:
```
.heat-b0 { background: var(--heat-b0); color: var(--heat-b0-ink); }
/* … through .heat-b5 … */
```

### 2.3 "Best window" highlight

The **best window** is the strongest contiguous run of comfortable months, drawn as a
bracketed group so the user reads "May through September" at a glance rather than
picking out isolated cells.

Algorithm (in `lib/seasonality.ts`, wrap-around aware because seasons cross the
December→January boundary):
1. Let `max = highest score in the 12 months`.
2. Mark every month with `score >= max - 8` as a candidate.
3. Find the longest *contiguous* run of candidate months, treating the 12-month array
   as circular (December is adjacent to January).
4. If nothing clears `max - 8` beyond the single peak, the best window is just that one
   month.

Visual treatment of best-window cells (modifier class `.is-best`, composes on top of
`.heat-bN`):
- A **teal inset ring**: `box-shadow: inset 0 0 0 1.5px var(--heat-best);`
- The first and last cell of the run get a heavier outer edge to read as a bracket:
  first cell `border-left: 2px solid var(--heat-best)`, last cell
  `border-right: 2px solid var(--heat-best)`. (For a wrap-around run, the bracket ends
  land on the true first/last months of the run, even across the Dec/Jan seam.)
- A tiny teal corner notch (4px triangle, top-right) on the single peak month.

Never fill best-window cells with teal — the fill always stays the heat color so the
comfort magnitude is still encoded. Teal is strictly an *outline/marker* role.

### 2.4 Missing-data cell

For a City not covered by the dataset, or an individual null month, render `.heat-na`:
diagonal hairline hatch (`repeating-linear-gradient(45deg, transparent 0 3px,
var(--hairline) 3px 4px)`) over `var(--bg2)`, with an em-dash `—` centered in
`--heat-na-ink`. No hover tooltip fires on a `.heat-na` cell (see §4).

---

## 3. Layout & composition

Overall page structure (top to bottom): **Header band → Legend strip → Heatmap grid →
(empty / loading states as needed)**. Page padding matches the app's panel rhythm:
`18px` horizontal gutters throughout.

### 3.1 Header band `SeasonHeader`

Reuses the parchment header idiom (compare `.panel-head` and `.section h3`).

- **Eyebrow** (mono, 10px, letter-spacing 0.22em, `--ink3`):
  `COMFORT INDEX · 12-MONTH CALENDAR`
- **Title** (Instrument Serif italic, ~34px, `--ink`): `Seasonality`
- **Sub** (Instrument Serif italic, 14px, `--ink3`, reuse `.h-sub`):
  `When each destination is at its most comfortable — derived from multi-year climate
  normals. An index, not a promise.`
- **Right-aligned control cluster** (flex row, gap 10px, wraps under on narrow):
  - `ADD DESTINATION` — a `CitySearchInput` (reuse the exact component from
    TripsPage.tsx, `.tp-search`) with placeholder `Add a city or airport…`.
  - `REGIONS` toggle — reuse `.layer-toggle` styling; label `REGIONS`, a `ring` glyph;
    `.on` when region rows are shown.
  - `SORT ▾` — a small mono select/segmented control, options
    `BEST WINDOW` (default) · `A–Z` · `PEAK SCORE`.
  - **Dataset note** (mono, 9px, `--ink4`, far right): `SOURCE ERA5 · 1991–2020 NORMALS`.
    While the batch fetch is in flight this line instead reads
    `LOADING CLIMATE NORMALS…` with the reused `.agent-brief-loading` three-dot pulse.

### 3.2 Legend strip `HeatLegend`

A single mono row under the header, above the grid (`padding: 8px 18px`,
`border-top/bottom: 1px solid var(--hairline)`):

- Label `COMFORT` (mono 9px 700, 0.22em, `--ink3`), then the 6 swatches in order,
  each a 14×14 block of `var(--heat-bN)` with its word label under it in 8px mono:
  `HARSH THIN MILD FAIR GOOD PRIME`, with `LOW ——→ HIGH` end-caps.
- A separator, then the **best-window key**: a 14×14 swatch showing a teal inset ring on
  a `--heat-b4` fill, labeled `BEST WINDOW`.
- The **NOW key**: the small triangle marker, labeled `NOW · CURRENT MONTH`.

### 3.3 The grid `HeatmapGrid`

CSS grid. Column template:
```
grid-template-columns: 200px repeat(12, minmax(40px, 1fr)) 116px;
gap: 2px;
```
- **Left gutter (200px)** — row labels.
- **12 month columns** — the heat cells. `minmax(40px, 1fr)` so they stretch on wide
  screens but never collapse below 40px; below that the grid gets a horizontal scroll
  wrapper (see §3.6).
- **Trailing 116px** — the per-row `BEST` summary.

`gap: 2px` and the parchment field showing through the gaps reproduces the existing
`.seasonality` strip's hairline-separated look at full scale.

**Sticky month-header row** (top of grid, `position: sticky; top: 0`, height 24px):
- Gutter cell is empty (or holds a faint `CITY` label, mono 9px `--ink4`).
- 12 cells, each the month initial `J F M A M J J A S O N D` (mono 10px 700, `--ink2`),
  centered. Reuse the existing single-letter month convention from MetricPanels.
- The **current month** column header carries the `.now` treatment lifted from the
  existing `.month-cell.now`: an accent top-triangle notch and an inset accent rule.
  A faint vertical accent hairline (`--accent`, 1px, 12% opacity) runs down the whole
  current-month column across all rows so "now" is legible anywhere in the table.
- Trailing header cell: `BEST` (mono 9px 700, 0.22em, `--ink3`), right-aligned.

**Body rows** — one `HeatRow` per destination (§3.4). Rows are 44px tall.

**Row ordering / grouping:**
- If `REGIONS` is on, **region rows are grouped first**, under a mini section rule
  (`REGIONS` eyebrow, mono 9px, `--ink3`, a 1px `--hairline2` under it), then a
  `DESTINATIONS` group for cities. If REGIONS is off, only city rows show.
- Within a group, `SORT` applies: `BEST WINDOW` orders by the start month of each row's
  best window (Jan→Dec), tie-broken by peak score desc — so the table reads like a
  calendar sweeping through the year. `A–Z` by city name. `PEAK SCORE` by max score desc.
- The **currently selected city** (`selectedCityId`) is always pinned as the first
  destination row regardless of sort, tagged `SELECTED`, so arriving from the globe or
  the drawer strip lands you on your city (see §7 flow F).

### 3.4 Row anatomy `HeatRow`

Left gutter (200px), laid out as a flex row, vertical-centered:
- **IATA** (mono 13px 700, `--ink`, min-width 34px) — the city's `iata ?? "—"`.
- **City name** (12px 500, `--ink`) with **country** under it (9px mono, 0.12em,
  `--ink3`) — same idiom as `.saved-row`.
- **Provenance badge** (reuse `.sr-pill`, mono 9px): one of
  `SHORTLIST` · `TRIP` · `REGION` · `SELECTED`. A row that is both shortlist and in a
  trip shows `SHORTLIST`. An uncovered row shows a `UNCOVERED` pill in `--ink3`.
- **Remove ✕** (right of gutter, appears on row hover/focus): for a `SHORTLIST` row it
  calls `removeFromShortlist(cityId)`; for a `TRIP`-only row the ✕ is hidden (rows that
  exist only because of a trip cannot be deleted from here — the badge tooltip reads
  `From a trip`); for a `REGION` row there is no ✕ (toggle REGIONS off instead).
- **Row hover** tints the gutter `var(--bg2)` (matches `.saved-row:hover`) and lifts the
  whole row's cells by 1px is NOT done — rows stay flat; only the gutter tints.

Then 12 `HeatCell`s, then the trailing **BEST summary** cell:
- Best window month span, mono 10px, e.g. `MAY–SEP` (or single `MAY`), `--ink`.
- Peak score under it, mono 13px 700 in the peak bin's color
  (`color: var(--heat-b5)` etc. via a `.peak-bN` text class) — a small colored number
  that echoes the heat. For uncovered rows this cell shows `—`.

### 3.5 Cell anatomy `HeatCell`

- 44px row height, fills its grid column. `.heat-bN` (or `.heat-na`) background + text.
- Content: the **score number** centered (mono 11px 700, color from the bin's `-ink`).
  Showing the number *inside* the color keeps the surface honest and readable even in
  grayscale/CVD — color and number are redundant encodings.
- `.is-best` modifier adds the teal ring/bracket (§2.3).
- Focus state (keyboard): `outline: 2px solid var(--accent); outline-offset: -2px;`
  (inset so it doesn't disturb the 2px grid gap) — consistent with the app's
  `button:focus-visible`.
- Hover: slight `filter: brightness(1.06)` (matches the global button hover), cursor
  pointer, and the tooltip fires (§4).

### 3.6 Responsive & overflow

- The grid lives inside a wrapper with `overflow-x: auto` so on narrow viewports the 12
  months scroll horizontally instead of collapsing. **The left gutter is
  `position: sticky; left: 0`** (with a `--bg` backing and a right hairline) so row
  labels stay pinned while months scroll. The page body itself never scrolls sideways.
- The month-header row is `position: sticky; top: 0` (backed by `--bg`) so it stays
  visible as many rows scroll vertically.
- Below ~640px the header control cluster wraps under the title (flex-wrap), and the
  dataset note drops to its own line.

### 3.7 Empty state (no Shortlist, no trip cities)

When the destination set is empty, do NOT show a barren grid. Show:
- A centered dispatch card (parchment, `border: 1px solid var(--hairline2)`,
  `box-shadow: var(--shadow)`, max-width 460px):
  - Serif italic (~26px): `No destinations charted yet.`
  - Mono sub (10px, 0.12em, `--ink3`):
    `SHORTLIST A CITY ON THE GLOBE, OR ADD ONE BELOW.`
  - An inline `ADD DESTINATION` search (same component as the header).
  - A `BROWSE GLOBE ↗` button (mono, reuse `.tm-action-btn`) → `navigate("/")`.
- **Underneath**, as a teaser, auto-render the **region aggregate rows** (from
  `/api/seasonality/regions`) under a `REGIONS · SAMPLE` group so the page demonstrates
  what it does even before the user has a shortlist. (The REGIONS toggle simply reflects
  `on` in this state.)

### 3.8 Loading state

The grid shell renders **immediately** — row labels come from data we already have
(`shortlist`, `trips`, `cities` in the store), so the gutter and month header paint at
once. Only the heat cells wait on the batch fetch. Per cell, show a **skeleton**: a
`var(--bg2)` block with a slow left-to-right shimmer (reuse the `mrd-shimmer` keyframe
already used by `.tm-create-btn::before`). The header dataset note shows
`LOADING CLIMATE NORMALS…` with the `.agent-brief-loading` dots. Because the batch
endpoint returns all rows together, cells fill in one pass; if a row's city is uncovered,
its cells resolve to `.heat-na` rather than staying skeleton forever (guard with the
in-flight flag so an uncovered row doesn't shimmer indefinitely).

---

## 4. Cell interaction

### 4.1 Hover tooltip `HeatTooltip`

A floating card (rendered in a portal, positioned above/beside the cell, flips to stay
in viewport). Parchment styling: `background: var(--paper)`,
`border: 1px solid var(--hairline2)`, `box-shadow: var(--shadow)` (the hard 3px offset,
no blur), `padding: 8px 10px`, min-width 150px. Content:

```
LISBON · MAY                     ← header: mono 10px 700 0.14em, --ink
────────────────────────────
   78   COMFORT · GOOD           ← score mono 22px 700 (bin color) + word mono 9px --ink3
────────────────────────────
TEMP     19 °C                   ← reuse the .micro-row key/val idiom, mono 11px
RAIN     54 mm
────────────────────────────
CLICK → SELECT   ·   G → GLOBE   ← hint, mono 8px 0.1em, --ink4
```

- The word (HARSH…PRIME) matches the cell's bin. The score number is tinted with the
  bin color for continuity.
- `TEMP` from `tempC` (round to integer, `°C`); `RAIN` from `precipMm` (round, `mm`).
- No tooltip on `.heat-na` cells — instead a plain title-attr `NOT IN DATASET`.

### 4.2 Click behavior

Two intentional levels, so the calendar isn't a trap that yanks you to the globe on
every click:
- **Single click on a cell (or on the row label):** `selectCity(cityId)`. This sets
  `selectedCityId`, opens the right drawer (existing behavior of `selectCity`), and marks
  the row `active` (accent left-edge on the gutter, `SELECTED` badge). The user **stays
  on the calendar** — they can keep scanning while the drawer/metric panels reflect the
  city. This is the primary, low-friction action.
- **Double-click a cell, press `G` on a focused cell, or click the row's `↗` affordance:**
  fly to the globe — `selectCity(cityId); navigate("/")`. The globe is still mounted, so
  it flies to the city (same path TripsPage's `VIEW ON GLOBE ↗` uses).

Rationale: comparing seasons is a scanning task; the default click must not eject you.
The "go to globe" intent is explicit and secondary.

### 4.3 Keyboard navigation

The grid is a **roving-tabindex 2D grid** (`role="grid"`, rows `role="row"`, cells
`role="gridcell"`). Exactly one cell is tabbable at a time; arrow keys move focus:
- `←/→` — previous/next month in the row (stops at edges; does not wrap focus).
- `↑/↓` — same month, previous/next row.
- `Home` / `End` — first / last month of the current row.
- `PageUp` / `PageDown` — first / last row, same month.
- `Enter` / `Space` — select the city (same as single click).
- `G` — fly to globe (same as double-click).
- The focused cell's tooltip content is also exposed to an `aria-live="polite"` region
  (`"Lisbon, May: comfort 78, good, 19 degrees, 54 millimetres"`) so it is screen-reader
  legible. The month header cells and row-label cells are also reachable and announce
  the city / month.

---

## 5. Row management

The row set is a **derived union**, computed in `SeasonalityPage`:

```
rows = dedupeByCityId([
  selectedCityId ? asRow(selectedCityId, "SELECTED") : none,   // pinned first
  ...shortlist.map(s => asRow(s.cityId, "SHORTLIST")),
  ...trips.flatMap(t => t.nodes).map(n => asRow(n.cityId, "TRIP")),
])
plus (if REGIONS on) regionRows tagged "REGION"
```
Dedupe precedence for the badge: SELECTED > SHORTLIST > TRIP.

- **Add a destination:** the header (and empty-state) `ADD DESTINATION` search picks a
  City → `addToShortlist(entry)`. It persists (server-side Shortlist per CONTEXT.md), so
  the calendar stays a faithful view of Shortlist + trips rather than accumulating a
  hidden ad-hoc list. The new row appears immediately in skeleton state, then fills
  (fetch its single `/api/seasonality/:cityId`, or re-issue the batch).
- **Remove a destination:** ✕ on a `SHORTLIST` row → `removeFromShortlist(cityId)`; the
  row fades out (150ms). `TRIP`-only rows have no ✕ (remove the city from the trip on the
  Trips page instead); `REGION`/`SELECTED` rows are managed by the toggle / by selecting
  a different city.
- **Region aggregate rows:** the `REGIONS` toggle fetches `/api/seasonality/regions` once
  (cache it) and renders those aggregates as a distinct group at the **top** of the grid.
  Region rows are visually heavier: the region name in Instrument Serif (not the mono
  IATA idiom — regions have no IATA), a `REGION` pill, and a 1px `--hairline2` group rule
  above them. Their cells use the exact same heat encoding and tooltip (with `REGION ·
  <name>` in the header, and no fly-to `G` action since a region isn't a point — pressing
  G is a no-op for region rows).

---

## 6. MetricPanels seasonality mini-strip redesign — `SeasonStrip`

Replace the `Math.random()` block in `MetricPanels.tsx` (lines ~60–112) with a real,
data-backed strip that shares the exact §2 encoding. Extract it as a reusable
`<SeasonStrip cityId={selectedCityId} />` component (used here, and reusable later by the
agent open-places surface named in spec §4.3).

Behavior:
- On mount / when `cityId` changes, read from a store cache; if absent, fetch
  `GET /api/seasonality/:cityId` and cache it (`store.seasonality[cityId]`). This is the
  same cache the full calendar uses, so navigating between them is free.
- Render the existing `.seasonality` 12-column grid, but each `.month-cell` is now a
  **solid heat swatch of fixed height (40px)** filled with `var(--heat-bN)` (via the same
  `.heat-bN` classes) instead of a random-height bar. The month initial sits centered in
  the cell's `-ink` color. This is a true mini-heatmap: same ramp, same bins, same
  best-window rings — a faithful thumbnail of the row the user will see in the calendar.
- The **current month** keeps the existing `.now` triangle notch (reuse as-is).
- **Best-window** cells get the teal inset ring (`.is-best`), identical to the grid.
- Hover a cell → a compact version of the §4.1 tooltip (score / word / temp / rain).
- Below the strip, replace the PEAK/SHOULDER/LOW legend with:
  - A one-line summary (mono 10px): `BEST  MAY–SEP` (bin-colored span), and
  - A link/button `FULL CALENDAR ↗` (mono 10px, reuse `.tm-action-btn` or `.tp-link`
    idiom) → `navigate("/seasons")`. Since `selectedCityId` is already this city, the
    calendar pins it as the first row (§3.3), auto-scrolls to it, and focuses its peak
    cell (§7 flow F).
- **Header copy update** for the section: keep `SEASONALITY`, change the meta chip from
  `12 MO` to `COMFORT INDEX`, and change `.h-sub` from the old tourism-volume line to:
  `Monthly comfort across the year. Deeper = better. Ridge marks now.`
- **Loading:** the 12 cells show the `mrd-shimmer` skeleton. **Uncovered city:** render
  `.heat-na` hatch cells and a muted line `NO SEASONALITY DATA` (mono 10px, `--ink3`) in
  place of the best summary; hide `FULL CALENDAR ↗`.

Note: this redesign removes the misleading old semantics — the old strip charted invented
"tourism volume"; the new one charts the real Comfort Index. Keep the visual weight
similar so the right drawer's rhythm is unchanged.

---

## 7. Component boundaries, names & state

### Components
- **`SeasonalityPage`** (`src/pages/SeasonalityPage.tsx`) — route container. Derives the
  row set (§5), orchestrates fetching (§8), holds page-local UI state, and renders header
  + legend + grid, or the empty/loading states.
- **`SeasonHeader`** — title, sub, and the control cluster (ADD DESTINATION search,
  REGIONS toggle, SORT control, dataset/loading note).
- **`HeatLegend`** — the ramp swatches + best-window key + NOW key.
- **`HeatmapGrid`** — the `role="grid"` element: sticky month-header row, the now-column
  overlay, the group rules, and the list of `HeatRow`s. Owns roving-tabindex keyboard
  logic and the focused-cell coordinate.
- **`HeatRow`** — one destination: gutter (label + badge + remove) + 12 `HeatCell`s +
  trailing BEST summary.
- **`HeatCell`** — one month: bin class, best modifier, focus/hover, emits
  select/goto/hover events upward.
- **`HeatTooltip`** — portal-rendered floating card (§4.1); shared shape with the strip's
  tooltip.
- **`SeasonStrip`** (`src/components/SeasonStrip.tsx`) — the reusable §6 mini-strip, used
  by MetricPanels (and later the agent places surface).
- **`lib/seasonality.ts`** — pure helpers, no React:
  `comfortBin(score)`, `COMFORT_LABELS` (`["HARSH","THIN","MILD","FAIR","GOOD","PRIME"]`),
  `bestWindow(months)` → `{startMonth, endMonth, peakMonth, isWrap}`,
  `MONTH_INITIALS`, `formatBestSpan(window)` → `"MAY–SEP"`, and the batch/single fetch
  wrappers (`fetchSeasonality(cityIds[])`, `fetchRegions()`) built on `apiUrl(...)`.

### State
- **From the Zustand store (existing):** `cities`, `shortlist`, `trips`, `selectedCityId`,
  `selectCity`, `addToShortlist`, `removeFromShortlist`, `theme` (read only where a JS
  branch is unavoidable — but color is CSS-driven, so `theme` is rarely needed here).
- **Add to the store (new slice, so both the page and `SeasonStrip` share one cache):**
  - `seasonality: Record<string, SeasonMonth[]>` where
    `SeasonMonth = { month: number; score: number; tempC: number; precipMm: number }`.
  - `setSeasonality(cityId, months)` and a bulk `mergeSeasonality(record)`.
  - `seasonalityRegions: RegionSeason[] | null` + `setSeasonalityRegions`.
  - UI pref `seasonsShowRegions: boolean` (default false; forced true in empty state).
  These are **not persisted** to localStorage (unlike trips) — climate data is served, and
  the cache is fine to rebuild per session. Add them to the store's `partialize` exclusion
  if the persist middleware would otherwise capture them.
- **Local to `SeasonalityPage`:** `sort: "best" | "az" | "peak"`, `addQuery` (if not held
  inside the reused search component), and the `hoveredCell` / `focusedCell`
  `{cityId, month}` coordinates (focused can live in `HeatmapGrid`).
- **Fetched:** batch `GET /api/seasonality?cityIds=…` on mount and whenever the row-city
  set changes (diff against cache; only request uncached ids); `GET /api/seasonality/regions`
  lazily on first REGIONS-on (or on empty-state mount); single `GET /api/seasonality/:cityId`
  from `SeasonStrip` when its city isn't cached.

---

## 8. State-transition flows

**A. First visit, has Shortlist/trips.** Nav `SEASONS` → `#/seasons` → page mounts →
rows derived from store (labels paint instantly, cells skeleton + `LOADING CLIMATE
NORMALS…`) → batch fetch resolves → cells fill, best windows computed, default `BEST
WINDOW` sort applied, selected city (if any) pinned first.

**B. First visit, empty (no Shortlist, no trip cities).** Page shows the §3.7 empty card
(serif "No destinations charted yet." + ADD search + BROWSE GLOBE ↗) **with region rows
auto-loaded** beneath as a live teaser (REGIONS reflected `on`). Adding a city or
shortlisting one on the globe transitions to state A.

**C. City not covered by the dataset.** Its row renders with `.heat-na` hatched cells, an
`UNCOVERED` pill, and a `—` BEST summary; no tooltip fires (title `NOT IN DATASET`). The
row is still present and labeled so the user isn't confused about why their city vanished.
Covered and uncovered rows coexist in the same table.

**D. Theme switch (DAY/NIGHT).** The existing theme-wipe flips `data-theme`; because every
cell paints via `var(--heat-bN)` / `var(--heat-best)`, the whole grid, the strip, the
legend, and the tooltips **recolor instantly with the wipe** — no refetch, no re-render,
selection/focus/scroll preserved. This is the reason color must never be inlined from JS.

**E. Add / remove a row.** Add (search pick) → `addToShortlist` → row appears in skeleton →
fetch fills it. Remove (✕ on a shortlist row) → `removeFromShortlist` → row fades out
(150ms) and the grid reflows. Trip-only rows persist until the trip changes.

**F. From the drawer strip → full calendar.** In `SeasonStrip`, `FULL CALENDAR ↗` →
`navigate("/seasons")`. Because `selectedCityId` is already this city, `SeasonalityPage`
pins it as the first (`SELECTED`) row, scrolls it into view, and moves keyboard focus to
its peak-month cell — the user lands exactly on the city they were inspecting.

---

## 9. Copy reference (verbatim, UPPERCASE mono unless noted)

| Slot | String |
|------|--------|
| Nav item | `SEASONS` |
| Header eyebrow | `COMFORT INDEX · 12-MONTH CALENDAR` |
| Title (serif italic) | `Seasonality` |
| Sub (serif italic) | `When each destination is at its most comfortable — derived from multi-year climate normals. An index, not a promise.` |
| Dataset note | `SOURCE ERA5 · 1991–2020 NORMALS` |
| Loading note | `LOADING CLIMATE NORMALS…` |
| Control: add | `ADD DESTINATION` (placeholder `Add a city or airport…`) |
| Control: regions | `REGIONS` |
| Control: sort | `SORT ▾` → `BEST WINDOW` · `A–Z` · `PEAK SCORE` |
| Legend | `COMFORT` · `LOW ——→ HIGH` · `HARSH THIN MILD FAIR GOOD PRIME` · `BEST WINDOW` · `NOW · CURRENT MONTH` |
| Group rules | `REGIONS` / `DESTINATIONS` (mono 9px eyebrow) |
| Row badges | `SELECTED` · `SHORTLIST` · `TRIP` · `REGION` · `UNCOVERED` |
| Trailing header | `BEST` |
| Tooltip header | `<CITY> · <MONTH>` (e.g. `LISBON · MAY`) |
| Tooltip labels | `COMFORT · <WORD>` · `TEMP` · `RAIN` |
| Tooltip hint | `CLICK → SELECT · G → GLOBE` |
| Uncovered cell | `—` (title `NOT IN DATASET`) |
| Empty title (serif) | `No destinations charted yet.` |
| Empty sub | `SHORTLIST A CITY ON THE GLOBE, OR ADD ONE BELOW.` |
| Empty button | `BROWSE GLOBE ↗` |
| Strip header meta | `COMFORT INDEX` |
| Strip sub | `Monthly comfort across the year. Deeper = better. Ridge marks now.` |
| Strip summary | `BEST  <SPAN>` (e.g. `BEST  MAY–SEP`) |
| Strip link | `FULL CALENDAR ↗` |
| Strip uncovered | `NO SEASONALITY DATA` |

## 10. Size & spacing reference

| Token | Value |
|-------|-------|
| Page gutters | 18px |
| Header title | Instrument Serif italic ~34px |
| Eyebrow / dataset note | mono 10px / 9px, letter-spacing 0.22em / 0.06em |
| Grid columns | `200px repeat(12, minmax(40px,1fr)) 116px`, gap 2px |
| Month header height | 24px, sticky top:0 |
| Row height | 44px |
| Cell score text | mono 11px 700 |
| Month initials | mono 10px 700 |
| Row IATA | mono 13px 700 |
| Row city name / country | 12px 500 / mono 9px 0.12em |
| Badges (`.sr-pill`) | mono 9px |
| Best-window ring | `inset 0 0 0 1.5px var(--heat-best)`; bracket edges 2px |
| Now marker | reuse `.month-cell.now` triangle + column hairline (`--accent` 12%) |
| Tooltip | `var(--paper)`, `1px var(--hairline2)`, `box-shadow: var(--shadow)`, pad 8px 10px |
| Focus ring | `2px solid var(--accent)`, inset offset -2px |
| Skeleton | `var(--bg2)` + `mrd-shimmer` keyframe |

Everything above uses only existing tokens (`--bg`, `--bg2`, `--paper`, `--ink`…`--ink4`,
`--accent`, `--good`, `--hairline`, `--hairline2`, `--shadow`) plus the new `--heat-*`
ramp defined in §2. Fonts: `--mono` (JetBrains Mono) for all UPPERCASE labels/stats/scores,
`--display` (Instrument Serif italic) for the page title / region names / empty-state
headline, `--sans` (DM Sans) for any running body text. No blur shadows — only the hard
3px offset `--shadow`.
