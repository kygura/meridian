# DESIGN — Agent Panel & Open Places

> **Superseded for UI (v3).** `DESIGN-v3.md` and `src/shell/CONTRACT.md` replace every UI,
> layout, visual-language and component section of this document. The old components it names
> (`src/components/**`, `src/pages/**`) and their stylesheets have been deleted; the UI now lives in
> `src/screens/**`, `src/ui/**` and `src/shell/**`. Data contracts, API behaviour and server rules
> described here still apply.

Scope: spec.md §4.3 (Agentic loop rewrite, UI half) and §5 flow 3. Honors assumptions
A4 (shared tool core), A6 (Wikipedia images), A7 (`ChatPanel.tsx` deleted, CommandPalette
keeps working). This file is the single source of truth for the implementer of the agent
chat UI and the Open Places surface. It defines layout, component tree, state ownership,
wiring, copy, and per-theme styling precisely enough to build without further taste calls.

Terms are used exactly as `CONTEXT.md` defines them: **Agent**, **Tool**, **Open Place**,
**Mock Path**, **Shortlist**, **Trip**, **Leg**.

---

## 0. TL;DR of the decisions

1. **AgentPanel is a persistent LEFT dock** (a "field-radio dispatch console"), not a
   modal, not a route. Full height between the top bar and the viewport bottom, width
   380px, toggled by a store flag `agentOpen`. It overlays the left edge of the globe and
   leaves the globe interactive to its right.
2. **Open Places is a wide centered MODAL overlay** (same family as CommandPalette /
   TripsOverlay), summoned from a header button inside the AgentPanel and dismissable back
   to the chat. Not a route, not an in-dock tab — the place cards need horizontal room the
   380px dock cannot give.
3. **Two-axis symmetry**: ASK on the left (AgentPanel), INSPECT on the right (existing
   RightDrawer). "FLY TO" from an Open Place calls the existing `selectCity`, which flies
   the globe and opens the right drawer's city detail — chat stays put on the left.
4. **Chat state is local** (`useChat` inside AgentPanel). **The Open Places collection
   lives in Zustand**, is enriched progressively across tool steps and turns, and is NOT
   persisted (session-scoped, mirroring how agent-origin trips are excluded from
   `partialize`).
5. **CommandPalette is untouched.** Cmd+K stays the quick, transient, keyboard-first
   launcher (search a city / toggle a layer / fire one question). The AgentPanel is the
   sustained research workspace with visible tool traces and accumulating places. They
   share the same `/api/agent/chat` contract but never the same screen role.

---

## 1. Placement & justification

### 1.1 The existing spatial grammar

- **Globe** — center stage, always mounted (`App.tsx` keeps it mounted across routes).
- **LeftDrawer** — transient slide-over (320px, `z-index:30`, has a backdrop). Holds the
  Shortlist, Trips launchers, and a "CONSOLE" launcher. Opened with `[`.
- **RightDrawer** — transient slide-over (360px, `z-index:30`). Holds **city detail**:
  `RegionCard`, `MetricPanels`, `AgentBrief`. Opened implicitly by `selectCity`.
- **CommandPalette** — centered overlay (`cmd-overlay` `z-index:60`), Cmd+K. Quick asks,
  city search, layer toggles. Renders assistant replies as plain text + city chips only.
- **TripsOverlay / TripCandidates** — centered modal overlays.

### 1.2 Why a persistent left dock (and not the alternatives)

- **Not the LeftDrawer as a tab.** The LeftDrawer is a transient menu with a backdrop; it
  dims and blocks the globe. A tool-tracing chat that accumulates places is a *workspace*
  you keep open while the globe animates fly-to — the opposite of a dismiss-on-click menu.
  320px is also too narrow for a comfortable dispatch log plus place cards.
- **Not a route (`#/agent`).** A full page (like `TripsPage`) hides the globe. Flow 3
  ends in "FLY TO" and "add to trip"; those want the globe visible. Killing the globe to
  chat, then re-navigating to see the fly-to, is a worse flow.
- **Not another modal.** A modal steals the whole screen and fights CommandPalette for the
  "centered overlay" role. The chat is long-lived; modals are for focused, dismiss-soon
  tasks (which is exactly what Open Places is).
- **Left, specifically**, because the right is already the semantic home of *inspecting a
  result* (city detail). The finished mental model is: **left = ASK the agent, right =
  INSPECT what it found, middle = the world.** "FLY TO" reads left-to-right across the
  screen: pick a place in the left console → it lands on the globe → its dossier opens on
  the right.

### 1.3 Coexistence & z-order

| Surface            | z-index | Nature      |
|--------------------|---------|-------------|
| TopBar             | 10      | fixed       |
| Globe              | (base)  | fixed       |
| **AgentPanel dock**| **28**  | persistent  |
| LeftDrawer         | 30      | transient   |
| RightDrawer        | 30      | transient   |
| **OpenPlaces modal团**| **60**  | overlay     |
| CommandPalette     | 60      | overlay     |

The AgentPanel dock sits *below* the transient drawers (28 < 30). If the user opens the
LeftDrawer while the dock is open, the drawer slides over it with its backdrop — the menu
wins momentarily, then closes. This is intentional and needs no layout reflow. The dock
does not push the globe; it floats over the globe's left margin like a console clipped to
the map.

The Open Places modal opens at 60 (same tier as CommandPalette; only one overlay is ever
open at a time in practice). It dims the whole screen including the dock behind it.

### 1.4 How it is opened / closed

`agentOpen` (new Zustand boolean, default `false`, NOT persisted) drives the dock.

- **TopBar**: add a nav-adjacent toggle button labeled `DISPATCH` (mono, uppercase) with a
  small radio/broadcast glyph and, when there are unseen Open Places, a count pip. Clicking
  toggles `agentOpen`.
- **LeftDrawer CONSOLE section**: repoint the existing "Open command console" launcher
  copy so there are two clear buttons — keep `Open command console` (⌘K → CommandPalette)
  and add `Open dispatch console` (→ `setAgentOpen(true)` + close the drawer). Do not nest
  the chat inside the drawer.
- **Keyboard**: bind `\` (backslash) to `toggleAgent()` in the global `App.tsx` key
  handler, guarded the same way as the other single-key shortcuts (ignore when focus is in
  an input/textarea). `Esc` inside the dpock closes the dock only if the composer is empty
  and no request is streaming; otherwise `Esc` blurs the composer. `Cmd/Ctrl+K` must keep
  working regardless (it already returns early in the handler).
- The dock has its own close affordance: a `✕` in its header (mirrors RightDrawer's close
  button styling).

---

## 2. Component tree & file layout

New directory `src/components/agent/`. All components are function components, hand-written
CSS classes in `src/index.css` (no Tailwind, matching the codebase).

```
AgentPanel.tsx            // left dock shell; owns useChat; header; composer; empty/error states
  AgentDispatchLog.tsx    // the scrollable message column
    AgentMessage.tsx      // one user or assistant message
      ToolTrace.tsx       // renders one message's toolInvocations as a telex log
        ToolTraceLine.tsx // a single tool step line (state-aware)
      InlinePlaceCard.tsx // compact place surfaced inside an assistant message
  AgentComposer.tsx       // the input bar (telex key)
  MockBadge.tsx           // shared LIVE/MOCK chip (also used in OpenPlaces)
OpenPlacesModal.tsx       // wide centered overlay; grid of PlaceDetail
  PlaceDetail.tsx         // one Open Place: image, identity, score, seasonality, actions
    PlaceImage.tsx        // Wikipedia thumb OR monogram fallback + attribution caption
    SeasonalityStrip.tsx  // 12-cell mini comfort-index heatmap
```

`ChatPanel.tsx` is deleted (A7). `AgentBrief.tsx`, `CommandPalette.tsx`, `RightDrawer.tsx`,
`LeftDrawer.tsx` are unchanged except LeftDrawer's added launcher button and TopBar's added
toggle.

Mount `AgentPanel` and `OpenPlacesModal` in `App.tsx` as siblings of the existing overlays
(next to `<CommandPalette />` / `<TripsOverlay />`). Both render `null` when their store
flag is false (dock) / render an empty shell that CSS-transforms off-screen is also
acceptable for the dock if a slide transition is wanted — prefer the CSS-transform slide to
match `.drawer-left`/`.drawer-right` behavior.

---

## 3. State model

### 3.1 Local (inside AgentPanel) — `useChat`

```ts
const { messages, input, handleInputChange, handleSubmit, append,
        isLoading, error, reload, stop } = useChat({
  api: apiUrl("/api/agent/chat"),
});
```

`messages[i].toolInvocations` is the AI SDK v4 array of tool calls with `state` in
`"partial-call" | "call" | "result"`. This is what `ToolTrace` renders. Nothing about the
chat transcript goes into Zustand — it is ephemeral per dock session.

### 3.2 Store additions (Zustand, `src/store.ts`) — Open Places collection + flags

Add to `MeridianState`:

```ts
// Agent dock
agentOpen: boolean;
setAgentOpen: (open: boolean) => void;
toggleAgent: () => void;

// Open Places (session collection — surfaced by Tools, accumulates across turns)
openPlaces: OpenPlace[];
openPlacesModalOpen: boolean;
setOpenPlacesModalOpen: (open: boolean) => void;
upsertOpenPlaces: (places: OpenPlacePatch[]) => void; // dedupe + enrich by cityId
markOpenPlacesSeen: () => void;                        // clears the unseen badge
dismissOpenPlace: (cityId: string) => void;
clearOpenPlaces: () => void;
```

`OpenPlace` (new type in `src/types.ts`):

```ts
interface OpenPlace {
  cityId: string;
  name: string;
  country: string;
  iata: string | null;
  lat: number;
  lng: number;
  score?: number;                 // 0–100 from search_places
  images?: PlaceImage[];          // from get_place_images (may be empty)
  seasonality?: { month: number; score: number }[]; // 12 entries from get_seasonality
  flightEstimate?: { price: number; currency: string; source: "duffel-test" | "mock" };
  source: "live" | "mock";        // provenance of what surfaced it (Mock Path → "mock")
  surfacedAt: string;             // ISO
  seen: boolean;                  // false until the modal has been opened after it arrived
}
interface PlaceImage {
  thumbUrl: string;
  fullUrl?: string;
  attribution: string;            // e.g. "Author Name / Wikimedia Commons, CC BY-SA 4.0"
  source: "wikipedia";
}
type OpenPlacePatch = Partial<OpenPlace> & { cityId: string };
```

**Persistence:** do NOT add any of these keys to the `partialize` allow-list. The Open
Places collection and dock/modal flags are session-scoped, exactly like agent-origin trips
which are already filtered out of `partialize`. (Confirm `partialize` still returns only
`{ trips: …, activeTripId }`.)

**`upsertOpenPlaces` semantics:** for each patch, find by `cityId`. If absent, insert with
`seen: false`, `surfacedAt: now`. If present, shallow-merge the patch (later tool results
add `images`, `seasonality`, `flightEstimate` onto the place that `search_places` first
created). Never duplicate a `cityId`. Insertion order = discovery order (newest at the top
of the modal grid, or newest-last — pick newest-first so fresh finds are seen first).

### 3.3 How Tool results reach the store

AgentPanel runs an effect over `messages`. On every change it scans all assistant messages'
`toolInvocations` where `state === "result"` and folds them into `upsertOpenPlaces`:

| Tool                 | Extract from `result`                              | Patch fields                     |
|----------------------|----------------------------------------------------|----------------------------------|
| `search_places`      | array of scored cities                             | identity + `score` + `source`    |
| `get_place_images`   | `{ cityId, images[] }` (thumbUrl, attribution)     | `images`                         |
| `get_seasonality`    | `{ cityId, months[12] }`                           | `seasonality`                    |
| `get_flight_estimate`| `{ cityId, price, currency, source }`              | `flightEstimate`                 |

The effect is idempotent (upsert by `cityId`), so re-running it as the stream appends more
results is safe. Deduping is the store's job, not the effect's.

The Mock Path is detected here: if any tool `result` in the session carries
`source: "mock"` (the shared Tool core returns a `source` field per A4/A5), the session is
mock. Track a derived `sessionSource: "live" | "mock"` in AgentPanel local state (or read it
off the places) and pass it to `MockBadge` and to each surfaced place's `source`.

---

## 4. AgentPanel — the dispatch console (left dock)

### 4.1 Anatomy

```
┌──────────────────────────────────────────────┐  width 380, top:44, bottom:0
│ HEADER                                         │
│  ◉ DISPATCH            [LIVE|MOCK]  [◧ 3]  [✕] │  <- OpenPlaces btn w/ count, close
│  field radio · agent research                  │  <- serif italic subtitle
├──────────────────────────────────────────────┤
│ DISPATCH LOG (scroll)                          │
│                                                │
│  › warm cheap places in november…    (user)   │
│                                                │
│  ┌── TOOL TRACE ─────────────────────────┐    │
│  │ ▸ SEARCHING PLACES            ·····    │    │  <- ToolTrace, collapsed
│  │ ▸ CHECKING SEASONALITY        ✓        │    │
│  │ ▸ FETCHING IMAGES (3)         ✓        │    │
│  └────────────────────────────────────────┘    │
│  Here are three warm, low-cost… (assistant)   │  <- streaming prose
│  ┌─ LIS  Lisbon, PT      87 ▪ +OPEN ─┐        │  <- InlinePlaceCard(s)
│  └────────────────────────────────────┘        │
│                                                │
├──────────────────────────────────────────────┤
│ COMPOSER                                       │
│  ┌────────────────────────────┐ ┌─────────┐   │
│  │ Ask the agent…             │ │ TRANSMIT│   │
│  └────────────────────────────┘ └─────────┘   │
└──────────────────────────────────────────────┘
```

### 4.2 Header

- Class `.agent-dock-head`. Row 1: a filled radio glyph `◉` + `DISPATCH`
  (mono, 12px, `letter-spacing:.14em`, `--ink`), then pushed right:
  `MockBadge`, an `OPEN PLACES` button, and the close `✕`.
- The `OPEN PLACES` button (`.agent-openplaces-btn`): shows a small stacked-cards glyph
  `◧` and the total count; when there are **unseen** places it also shows an accent pip and
  the label reads `OPEN PLACES ·N NEW`. Clicking sets `openPlacesModalOpen = true` and calls
  `markOpenPlacesSeen()`.
- Row 2: subtitle in `--display` italic 13px `--ink3`: `field radio · agent research`.
- Bottom border `1px solid var(--hairline2)`.

### 4.3 Dispatch log (message list)

- Class `.agent-log`, `flex:1; overflow-y:auto; padding:14px 16px; display:flex;
  flex-direction:column; gap:14px;`. Auto-scroll to bottom on `messages` change (same
  pattern CommandPalette uses with a ref).
- **User message** (`.agent-msg.user`): a right-of-nothing, left-aligned line prefixed with
  a mono `›` in `--accent`, text in `--ink`, `--sans` 13px. (This is a console log, not a
  chat bubble — no rounded bubbles. User lines read like typed commands.)
- **Assistant message** (`.agent-msg.assistant`): the streaming prose in `--sans` 13px
  `--ink2`, line-height 1.55, on a faint panel (`background: var(--bg2)`, `border:1px solid
  var(--hairline)`, hard-edged, no radius, `padding:10px 12px`). Above the prose sits the
  message's `ToolTrace` (if it had tool calls). Below the prose sit any `InlinePlaceCard`s
  the message surfaced.
- Streaming caret: while `isLoading` and this is the last assistant message, append a
  blinking block caret `▍` in `--accent` at the end of the streamed text.

### 4.4 ToolTrace — the telex tool log (the important part)

Rendered once per assistant message that has `toolInvocations.length > 0`, above the prose.
Container `.tool-trace`: hairline-bordered block, `background: var(--paper)`, mono type,
`padding:8px 10px`. Header row (tiny): `TOOL TRACE` label in mono 9px `--ink4`
`letter-spacing:.18em`, and on the right a collapse chevron. **Collapsed by default**,
showing one `ToolTraceLine` per invocation. Expanding reveals each line's argument/result
summary indented beneath it.

Each `ToolTraceLine` maps a tool + state to a label and a status glyph:

| Tool `state`     | Glyph (left)               | Status (right)                    |
|------------------|----------------------------|-----------------------------------|
| `partial-call`   | `▸` amber, faint           | `····` animated dots (`--ink4`)   |
| `call`           | `▸` amber, pulsing         | `····` animated dots (`--accent`) |
| `result`         | `▸` `--good`               | `✓` `--good`                      |
| error*           | `▸` `--warn`               | `✕ FAILED` `--warn`               |

\*The AI SDK surfaces tool errors as a `result` with an error payload or the stream errors
out; treat a result whose payload has an `error` field as the error row.

Label copy per tool (mono, 11px, uppercase, `letter-spacing:.08em`, `--ink2`):

| Tool                 | While running          | On result                         |
|----------------------|------------------------|-----------------------------------|
| `search_places`      | `SEARCHING PLACES`     | `FOUND {n} PLACES`                |
| `get_place_images`   | `FETCHING IMAGES`      | `FETCHED IMAGES ({n})`           |
| `get_seasonality`    | `CHECKING SEASONALITY` | `SEASONALITY READY`              |
| `get_flight_estimate`| `PRICING FLIGHT`       | `EST. {price} {currency}`        |
| (unknown tool)       | `RUNNING {toolName}`   | `{toolName} DONE`                |

`{n}` is read from the args (`get_place_images` count) while running and from the result
length when done; before the count is known render `FETCHING IMAGES` with no number.

The line is a 3-column mono grid: `[glyph] [label ..............] [status]`. Lines never
wrap; long labels are impossible here because copy is fixed. The whole trace reads like a
telex printout ticking down its steps — this is the field-radio flavor. Up to ~6 steps
(`maxSteps ≈ 6`) fit comfortably.

**Expanded detail** (per line, optional, only when the trace is expanded): one indented
mono 10px `--ink3` line summarizing args→result, e.g.
`search_places  query:"warm cheap beach nov"  →  6 cities` or
`get_seasonality  city:LIS  →  best: FEB–APR`. Keep to a single line; do not dump JSON.

### 4.5 InlinePlaceCard — a place inside the chat

When an assistant message's `search_places` result surfaces cities, render a compact card
per city *below that message's prose* (max ~4 shown; if more, a `+{k} MORE IN OPEN PLACES`
chip that opens the modal). This is the bridge from prose to the Open Places collection.

Compact card `.place-card-inline` (single row, hairline border, hard offset shadow
`var(--shadow)` on hover only, no radius):

```
┌────────────────────────────────────────────────┐
│ [img]  LIS   Lisbon                    87   +OPEN│
│ 44px   iata  País · country            score  btn│
└────────────────────────────────────────────────┘
```

- Left: 44×44 `PlaceImage` (thumb or monogram fallback).
- IATA in mono 11px bold `--ink` (fixed 34px column; `—` if null).
- Name in `--sans` 13px `--ink`; country in `--ink3` after a `·`.
- Score: a pill `.score-pill` — mono 12px bold, colored by band (see §7.4).
- Action: a single `+ OPEN` button (`.place-open-btn`, mono 10px) → ensures the place is in
  the collection (it already is, via the upsert effect) and opens the modal focused on it
  (`setOpenPlacesModalOpen(true)` + optional `focusCityId`). Clicking the card body (not the
  button) does the same. The compact card deliberately does NOT carry the four heavy actions
  — those live in the modal's `PlaceDetail` where there is room.

### 4.6 Composer

- Class `.agent-composer`, top border `1px solid var(--hairline)`, `padding:10px 16px`.
- A `<form onSubmit={handleSubmit}>` with a text `<input>` (`--sans` 13px, `--paper`
  background, `1px solid var(--hairline2)`, no radius) placeholder
  `Ask the agent — try "warm cheap beaches in November"…`, and a submit button
  `.agent-transmit` labeled `TRANSMIT` (mono 10px 700, `--ink` bg / `--bg` text; in dark it
  reads on the amber-shadowed console — keep bg `--ink`).
- While `isLoading`: swap `TRANSMIT` for a `STOP` button wired to `useChat`'s `stop()`,
  styled with `--warn` border. The input stays enabled so the user can queue the next
  question but submit is disabled until the stream ends.

### 4.7 Idle / welcome, streaming, error states

- **Idle (no messages):** `.agent-empty` centered block. A telex banner in `--display`
  italic 18px `--ink2`: `MERIDIAN DISPATCH`; a mono 10px `--ink4` status line
  `FIELD RADIO ONLINE · AGENT STANDING BY`; a mono hint
  `Ask about any region, budget, or season. The agent will search places, pull images, and
  check seasonality.`; then three suggestion chips reusing CommandPalette's prompts
  (`Where is cheapest in Asia now?`, `Safe cities near the equator`,
  `Warm cheap beaches in November`) — clicking `append({ role:"user", content })`.
- **Streaming:** ToolTrace lines tick and the prose caret blinks (§4.3–4.4). The `OPEN
  PLACES` count in the header increments live as `search_places` results fold in.
- **Error** (`useChat`'s `error` set, or a tool error row): render a dispatch error block at
  the end of the log — `.agent-error`, `--warn` left rule, mono 11px:
  `TRANSMISSION FAILED — {message || "agent unreachable"}` and a `RETRY` button wired to
  `reload()`. Do not clear the transcript on error.

---

## 5. Open Places modal

### 5.1 Shell

Reuse the overlay pattern: `.cmd-overlay`-style backdrop (`position:fixed; inset:0;
z-index:60; background rgba(28,24,20,.32); backdrop-filter: blur(2px)`), click-outside to
close (`onMouseDown` on backdrop → `setOpenPlacesModalOpen(false)`; inner panel stops
propagation). Panel `.openplaces-panel`: `width:min(920px,94vw); max-height:82vh;
background var(--paper); border:1px solid var(--ink); box-shadow:6px 6px 0 var(--ink);
display:flex; flex-direction:column; overflow:hidden;` (the dark theme swaps the shadow to
the teal token automatically via `--shadow`/`--ink` — for the modal use `6px 6px 0
var(--ink)` to match CommandPalette exactly).

### 5.2 Header

`.openplaces-head` (`padding:14px 18px; border-bottom:1px solid var(--hairline2)`):

- Left: mono 9px `--ink4` eyebrow `AGENT` then `--display` italic 20px `--ink` title
  `Open Places`, plus a count `.op-count` mono 11px `--ink3`: `{n} SURFACED`.
- Right: `MockBadge` (if session mock), a `DISMISS ALL` text button
  (`.op-dismiss-all`, mono 10px `--ink3`, hover `--warn`) → `clearOpenPlaces()`, and a `✕`
  close (`.candidates-close` styling).

### 5.3 Body — the grid

`.openplaces-grid`: `overflow-y:auto; padding:16px 18px; display:grid;
grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:14px;`. One `PlaceDetail`
card per Open Place, discovery order (newest first).

### 5.4 Empty state

When `openPlaces.length === 0`: `.openplaces-empty` centered — a hand-drawn compass/pin
glyph (reuse the monogram-tile aesthetic, §6.3), `--display` italic 16px `--ink3`
`No places surfaced yet`, and mono 10px `--ink4`
`Ask the agent to research a region — the places it finds collect here.` with a single
`OPEN DISPATCH` button that closes the modal and `setAgentOpen(true)`.

### 5.5 PlaceDetail card

```
┌────────────────────────────────────────┐
│ ┌────────────────────────────────────┐ │
│ │            IMAGE 16:9              │ │  PlaceImage (thumb or monogram)
│ │  © Author / Wikimedia, CC BY-SA   │ │  attribution caption, bottom-left
│ └────────────────────────────────────┘ │
│ LIS   Lisbon                      [87] │  iata · name · score-pill
│ Portugal · 38.72, -9.14                │  country · coords (mono, --ink3)
│                                         │
│ SEASONALITY                             │  mono 9px --ink4 label
│ ▪▪▫▫▫░░░▫▫▪▪   best FEB–APR             │  SeasonalityStrip (12 cells) + best window
│                                         │
│ EST. FLIGHT  $420  MOCK                 │  only if flightEstimate present
│ ─────────────────────────────────────── │
│ [ FLY TO ] [ +SHORTLIST ] [ +TRIP ]     │  actions row 1
│ [ BOOK FLIGHT ]              [ ✕ ]      │  actions row 2 + dismiss
└────────────────────────────────────────┘
```

Card `.place-detail`: `background var(--bg2)`, `border:1px solid var(--hairline2)`, no
radius, `display:flex; flex-direction:column`. Hover lifts with `.mrd-hover-lift` (already
defined) — but only the card container, not while interacting with buttons.

- **Image** (`PlaceImage`, 16:9, full card width, `object-fit:cover`). Attribution caption
  overlaid bottom-left in a translucent ink strip, mono 8px, `--bg`/paper text — see §6.
- **Identity row** (`padding:10px 12px 4px`): IATA mono 12px bold `--ink` (34px column,
  `—` if null) · name `--sans` 15px `--ink` · `score-pill` pushed right.
- **Sub row**: country `--ink3` 12px, then `·`, then coordinates `lat.toFixed(2),
  lng.toFixed(2)` in mono 10px `--ink4`.
- **Seasonality block**: label `SEASONALITY` (mono 9px `--ink4`). If `seasonality` present,
  render `SeasonalityStrip` (§7.5) and a `best {MON}–{MON}` caption (contiguous highest-score
  window, mono 10px `--good`). If absent (tool not run for this place), render a 12-cell
  skeleton strip in `--hairline` and caption `— no data`.
- **Flight estimate line** (only if `flightEstimate`): mono 10px, `EST. FLIGHT` label
  `--ink4`, price+currency `--ink` bold, and a `MockBadge`-mini if `source:"mock"`. This is
  an **Estimate**, not an **Offer** — never say "book" here; that word belongs to the button.
- **Actions** — see §6 for exact wiring. Row 1: `FLY TO`, `+ SHORTLIST`, `+ TRIP`. Row 2:
  `BOOK FLIGHT` (accent-outlined, the handoff), and a right-aligned `✕` dismiss
  (`dismissOpenPlace(cityId)`). Buttons are mono 10px, hairline-bordered, hard-edged; the
  primary-ish `BOOK FLIGHT` uses an `--accent` border and `--accent` text.

Idempotent affordances: `+ SHORTLIST` becomes a disabled `✓ SHORTLISTED` when the cityId is
already in `shortlist`. `+ TRIP` briefly flashes `✓ ADDED` for ~1.2s after click, then
reverts (append-only, so it can be added again).

---

## 6. Cross-surface wiring (exact)

All handlers live in `PlaceDetail` (modal) and, where noted, `InlinePlaceCard`.

- **FLY TO** → `selectCity(cityId)`. This already sets `selectedCityId` and opens the
  RightDrawer (`selectCity` sets `rightDrawerOpen: id !== null`). Then
  `setOpenPlacesModalOpen(false)` so the globe fly-to and the right-drawer dossier are
  visible. Leave `agentOpen` as-is. Net effect: place lands on the globe, its detail opens
  on the right, the dispatch console stays on the left. (The globe's own effect on
  `selectedCityId` performs the camera fly — no new globe code needed.)
- **+ SHORTLIST** → mirror `CommandPalette.save()` exactly: guard against duplicates, then
  `addToShortlist({ cityId, name, country, lat, lng, iata, addedAt: new Date().toISOString(),
  score })` and fire-and-forget `POST /api/shortlist { cityId }`. Pass the Open Place's
  `score` through (CommandPalette passes `undefined`; here we have a real score).
- **+ TRIP** → `addCityToActiveTrip({ cityId, name, iata, lat, lng })` (same `TripNode`
  shape CommandPalette uses). If there is no active trip the store auto-creates one — no
  extra handling needed.
- **BOOK FLIGHT** → handoff only. The booking modal is owned by `DESIGN-booking.md`. This
  design defines the affordance and payload; it does not implement the flow. Wire the button
  to a booking entry point the booking feature will expose. Contract:

  ```ts
  // provided by the booking feature (store action or context) — DO NOT implement here
  openBookingFor({
    destinationIata: place.iata,   // may be null → booking flow must handle "no airport"
    cityId: place.cityId,
    origin: undefined,             // Open Places carry no origin/dates; booking collects them
  });
  ```

  If `place.iata` is null, render `BOOK FLIGHT` disabled with tooltip `NO AIRPORT`. Until the
  booking feature lands, the implementer may stub `openBookingFor` to `console.warn` — but
  the button, its enabled/disabled logic, and the payload are part of THIS design and must
  ship. Booking is the only place a real **Offer** exists; the estimate line above is only an
  **Estimate**.

- **DISMISS (single)** → `dismissOpenPlace(cityId)`. **DISMISS ALL** → `clearOpenPlaces()`.
- **Badge/count when the surface is closed:** the header `OPEN PLACES ·N NEW` button (dock)
  and the TopBar `DISPATCH` pip both read from `openPlaces.filter(p => !p.seen).length`.
  Opening the modal calls `markOpenPlacesSeen()`, which sets every place's `seen = true` and
  zeroes the "new" count (the total count remains).

---

## 7. Visual language, tokens, copy

All colors are the existing CSS variables (defined for both themes in `:root` and
`html[data-theme="dark"]`). Never hard-code hex in components; use the tokens so both themes
work automatically. The dark theme already remaps `--accent` to amber `#f59e0b`, `--good` to
teal `#2dd4bf`, and `--shadow` to a teal glow — the console's "amber accent / teal glow"
requirement falls out of using `--accent`, `--good`, and `--shadow`.

### 7.1 Type roles

- Labels, tool traces, IATA, scores, timestamps, badges, buttons → `--mono` (JetBrains
  Mono), UPPERCASE, `letter-spacing` .08–.18em.
- Display headers / eyebrow titles / empty-state banners → `--display` (Instrument Serif),
  usually italic.
- Body prose (assistant messages, hints) → `--sans` (DM Sans).

### 7.2 Surfaces & borders

- Hairline borders everywhere (`--hairline`, `--hairline2`); no border-radius anywhere
  (hard-edged cartographic).
- Hard offset shadows only on overlays and on hover-lift (`var(--shadow)` /
  `6px 6px 0 var(--ink)` for the modal panel). Cards get shadow on hover, not at rest.
- Panel fills: dock uses `--bg`; inset blocks (tool trace, assistant prose) use `--paper` /
  `--bg2`; the modal uses `--paper`.

### 7.3 MockBadge

`.mock-badge`: mono 8px 700, `letter-spacing:.14em`, `padding:2px 5px`, `--warn` text on a
`1px solid var(--warn)` outline, no fill. Copy `MOCK`. The live counterpart `.live-badge`
(mono 8px `--good` outline, copy `LIVE`) is optional — prefer showing a badge ONLY when
mock, to keep the console calm; when live, show nothing or a faint `LIVE` in `--ink4`.
Placement: dock header (session-level) and each `PlaceDetail`'s flight-estimate line
(per-estimate). Rationale: A5/A6 require mock/test provenance to be always visible.

### 7.4 Score pill bands

`.score-pill` mono 12px 700, `padding:1px 6px`, `1px solid` current border, colored by band:

| Score  | Text / border |
|--------|---------------|
| ≥ 80   | `--good`      |
| 60–79  | `--accent`    |
| 40–59  | `--ink2`      |
| < 40   | `--ink4`      |

(Mirror the `.sr-pill` treatment already used in the Shortlist rows.)

### 7.5 SeasonalityStrip (12-cell mini heatmap)

12 cells in a row, each `10×14px`, 1px gap, no radius. Cell background interpolates the
Comfort Index (0–100) across a warm ramp consistent with the heatmap designer's palette —
until that palette is finalized in `DESIGN-heatmap.md`, use: `<30 → --ink4` faded,
`30–55 → --hazard` at 45% alpha, `55–75 → --accent`, `75–100 → --good`. Under the strip,
month initials `J F M A M J J A S O N D` in mono 7px `--ink4` are optional (omit if cramped).
The "best window" caption names the contiguous run of top cells. A tooltip on cell hover
shows `{MON} · {score}` (temp/precip detail is the heatmap surface's job, not this mini
strip). This is a *reference to* seasonality, not the full calendar — keep it tiny.

### 7.6 PlaceImage & the no-image fallback (A6)

- **With image:** Wikipedia thumbnail via `get_place_images`. `object-fit:cover`. Wikimedia
  licensing REQUIRES attribution — render the `attribution` string as a caption. Inline
  44px thumb: attribution is not shown on the tile (too small) but the alt text carries it;
  in the modal's 16:9 image, overlay a bottom-left strip `.img-attrib` (mono 8px, text
  `--bg`/paper over `rgba(0,0,0,.45)`, `padding:2px 5px`) reading
  `© {attribution}`. Truncate with ellipsis; full string in `title`.
- **No image** (small cities often have none): a hand-drawn **monogram tile** in the app's
  canvas-glyph spirit. Background `--bg2`; centered the city's monogram (first 1–2 letters,
  or the IATA) in `--display` italic, large, `--ink3`; below it the coordinates in mono 9px
  `--ink4`; a hairline border with small corner ticks (4 short `--hairline2` strokes at the
  corners) to read as a map plate. No attribution caption (nothing to attribute). Same tile,
  scaled, serves the 44px inline thumb (monogram only, no coords at that size) and the empty
  state glyph.

### 7.7 Spacing rhythm

- Dock: header `14px 16px`; log `14px 16px` with `gap:14px` between messages; composer
  `10px 16px`. Inside a message: `gap:8px` between ToolTrace / prose / inline cards.
- Modal: header `14px 18px`; grid `16px 18px` `gap:14px`; card inner `10px 12px` with the
  image flush to the top edge (no inset).
- Tool trace lines: `padding:3px 0`, 3-column grid `24px 1fr auto`, `gap:8px`.

### 7.8 Copy sheet (authoritative strings)

| Location                    | String                                                        |
|-----------------------------|---------------------------------------------------------------|
| Dock header title           | `DISPATCH`                                                     |
| Dock subtitle               | `field radio · agent research` (serif italic)                 |
| Dock OpenPlaces button      | `OPEN PLACES` / with new: `OPEN PLACES ·{n} NEW`              |
| Composer placeholder        | `Ask the agent — try "warm cheap beaches in November"…`      |
| Composer submit             | `TRANSMIT` / streaming: `STOP`                                |
| Empty dock banner           | `MERIDIAN DISPATCH`                                            |
| Empty dock status           | `FIELD RADIO ONLINE · AGENT STANDING BY`                     |
| Empty dock hint             | `Ask about any region, budget, or season. The agent will search places, pull images, and check seasonality.` |
| Error line                  | `TRANSMISSION FAILED — {reason}` + `RETRY`                    |
| Tool trace header           | `TOOL TRACE`                                                   |
| Tool labels                 | see §4.4 table                                                 |
| Inline card action          | `+ OPEN` · overflow: `+{k} MORE IN OPEN PLACES`              |
| Modal eyebrow / title       | `AGENT` / `Open Places` (serif italic)                        |
| Modal count                 | `{n} SURFACED`                                                 |
| Modal dismiss-all           | `DISMISS ALL`                                                  |
| Modal empty title           | `No places surfaced yet`                                      |
| Modal empty hint            | `Ask the agent to research a region — the places it finds collect here.` |
| Modal empty CTA             | `OPEN DISPATCH`                                                |
| PlaceDetail seasonality     | `SEASONALITY` · caption `best {MON}–{MON}` / `— no data`      |
| PlaceDetail estimate        | `EST. FLIGHT {price} {currency}`                             |
| PlaceDetail actions         | `FLY TO` · `+ SHORTLIST` (done: `✓ SHORTLISTED`) · `+ TRIP` (flash: `✓ ADDED`) · `BOOK FLIGHT` (no airport: disabled, tooltip `NO AIRPORT`) |
| Mock provenance             | `MOCK` (badge)                                                 |

---

## 8. Behavior matrix (states)

| State                         | Dock render                                                            |
|-------------------------------|-----------------------------------------------------------------------|
| Idle, no messages             | `.agent-empty` welcome + suggestion chips                             |
| User just submitted           | user line appended; `isLoading` true; composer shows `STOP`          |
| Tool running                  | ToolTrace lines pulsing (`call`/`partial-call`); header count climbs |
| Streaming prose               | assistant prose grows with blinking `▍` caret                        |
| Turn complete                 | traces show `✓`; inline place cards rendered; composer back to `TRANSMIT` |
| Error                         | `.agent-error` block + `RETRY`; transcript preserved                 |
| Mock Path (no key)            | identical layout; `MOCK` badge in header + on estimate lines; places `source:"mock"` |
| Open Places arrive, modal shut| header/TopBar show `·{n} NEW` pip                                     |
| Modal open                    | `markOpenPlacesSeen()`; pip clears; grid of `PlaceDetail`            |
| Place enriched mid-session    | its `PlaceDetail`/inline card updates in place (upsert by cityId)    |
| Place dismissed               | removed from grid; count decrements                                  |
| Empty after dismiss-all       | `.openplaces-empty`                                                   |

---

## 9. Guardrails / non-goals

- Do NOT persist Open Places, `agentOpen`, or `openPlacesModalOpen` (session-scoped;
  keep `partialize` returning only trips + activeTripId).
- Do NOT re-implement fly-to, shortlist POST, or trip mutation — reuse `selectCity`,
  `addToShortlist` (+ `POST /api/shortlist`), `addCityToActiveTrip` as CommandPalette does.
- Do NOT put the four heavy actions on the inline chat card; they belong to `PlaceDetail`.
- Do NOT block on the booking modal — ship the `BOOK FLIGHT` affordance + payload; the flow
  is `DESIGN-booking.md`'s.
- Do NOT change CommandPalette's role or its `/api/agent/chat` usage.
- Do NOT introduce border-radius or drop shadows outside the hard-offset system.
- Do NOT add runtime dependencies; this is React + Zustand + hand-written CSS + AI SDK v4
  `useChat`, all already present.
```
