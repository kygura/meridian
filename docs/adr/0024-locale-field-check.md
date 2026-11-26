# Locales carry an independent Field Check, ranked on fixed anchors

Builds on ADR 0022 (Locales) and replaces its data source. Month fit is unchanged: it still comes from Meridian's own data.

ADR 0022 shipped locales drafted from the owner's earlier agentic research and Travel Seasons, shown in the sheet as "Your notes". The owner did not want that research treated as a source to cite. They wanted each place verified and ranked on its own.

**Field Check.** Every locale was re-researched in November 2026 by independent research agents, seven of them with four places each. Each agent was given the earlier research as a set of hypotheses to check. They were told to keep only what current sources support and never to cite it. Each locale now carries:

- a summary
- twelve month ratings (`best`, `good`, `fair`, `avoid`) for living and working there, every month explained by a reason with its driving figure
- nine scores
- an all-in cost
- a stay length
- the long-stay entry route with an official source where one loaded
- events and the airport
- caveats where the data was thin or changing
- the list of sources the agent actually opened

Agents whose first pass leaned on recalled normals were sent back to open climate, air, rent and safety sources. The old scores, the asymmetry rank and the corrections field are gone. Travel Seasons are replaced by the Field Check's own dated **seasons**: 3 to 6 windows per place (peak, shoulder or avoid, with a tourist level), tiling the year with no gaps or overlaps, each with the figure that sets its dates. Boundaries sit on a sourced date where one exists, such as Seoul's average jangma onset (25 June), Bangkok's Thai Meteorological Department seasons, Nicoya's dry season from about 7 November, and the Weather Spark season edges for Buenos Aires and Queenstown. Elsewhere they sit on month edges. Tourist levels are mostly the agents' judgement from holiday calendars, which the caveats say. A window's kind agrees with the month ratings, except where a sourced date splits a month: late September in Taipei and Tokyo, and November in Nicoya. Seasons are shown in the sheet and do not score.

**Scores on fixed anchors.** Researchers working in parallel drift apart when they score by feel, so every score is measured against an anchor written into the brief:

| Score | What the anchor measures |
|---|---|
| climate | months rated best or good |
| air | annual PM2.5, minus one for a hazardous seasonal spike |
| cost | all-in EUR per month |
| safety | anchored from Tokyo to high risk |
| health | hospital access |
| internet | fixed broadband |
| food | everyday eating |
| nomad | ease of setting up |
| longstay | legal stay for an EU, US or UK passport |

Two of these follow mechanically from data in the file, so the build recomputes them rather than trust each agent's rounding:

- **climate** is the count of best or good months minus one, clamped to 1–10.
- **cost** is piecewise-linear on the midpoint of a monthly EUR range: 900 → 10, 1,300 → 8, 1,800 → 6, 2,500 → 4, 3,300 → 2, 4,000 → 1. A destination's per-trip cost keeps the agent's score.

**Rank.** The overall score is a weighted mean that stays on the 1–10 scale (`SCORE_WEIGHTS` in `src/lib/locales.ts`):

| climate | air | cost | safety | health | internet | food | nomad | longstay |
|---|---|---|---|---|---|---|---|---|
| 0.15 | 0.10 | 0.14 | 0.12 | 0.08 | 0.10 | 0.07 | 0.10 | 0.14 |

Locales are ranked within their role, because a hub or a one-off destination is not competing with a base. The page gains a "Field check rank" sort, and the sheet shows the rank, the overall score and each score.

**What still does not score.** The Field Check's month ratings ride along beside Meridian's fit, as the notes did, and a month that reads two or more levels apart is flagged. ADR 0022's reason holds: two readings of the same weather would leave the calendar arguing with itself. The rank orders places; it does not change when to be in them.

**Limits.** Several entry rules rest on secondary sources where official pages would not load: Montenegro, Albania, Greece, Costa Rica, Argentina, Penang's December 2026 DE Rantau change and Seoul's F-1-D. Several PM2.5 figures are country-level or modelled. Each locale's `caveats` says which. Entry rules change; Settings › Visas stays the source for day counting.

Rejected:

- **Letting the agents rank the places directly.** Each agent saw four places, so their rankings could not be compared across agents.
- **Scoring months from the Field Check.** See ADR 0022.
- **Keeping the earlier research alongside the Field Check as "notes".** The owner asked that it not be cited.
