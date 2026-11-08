import type { PlaceNewsItem } from "./placeNews.js";

/**
 * A labour strike, not a missile strike, an earthquake that "strikes" or a goal: needs a
 * striking group, "on strike", or "strike over/by/action".
 */
export const LABOUR_STRIKE =
  /\b((workers?|unions?|staff|employees|drivers?|pilots?|crews?|controllers?|teachers?|doctors?|nurses?|dockers?|miners?|general|national|nationwide|transport|rail|airport|port|public[- ]sector|taxi|truckers?)\s+(go\s+on\s+|call\s+|announce\s+|plan\s+)?strikes?|on strike|strikes? (action|over|by|called|planned|threat)|walk-?outs?)\b/;


/** Discrete accidents, where adding up incident tolls means something (not epidemics or crime waves). */
const DISCRETE: ReadonlySet<IssueSubject> = new Set(["rail", "air", "road", "sea", "buildings"]);

// Systemic issues read off a country's headlines, with no hand-written list: group
// headlines by subject (rail, air, roads, power...), count separate deadly incidents over
// the year, and note when the same subject also draws corruption or accountability
// coverage, or protests. Spain's 2026 rail crashes are the model case: two deadly
// incidents nine months apart, then fraud probes into rail funds and protests.

export type IssueSubject =
  | "rail"
  | "air"
  | "road"
  | "sea"
  | "buildings"
  | "power"
  | "water"
  | "health"
  | "crime"
  | "unrest"
  | "politics";

export type IssueLevel = "systemic" | "incident" | "recurring";

export interface NewsIssue {
  subject: IssueSubject;
  label: string;
  level: IssueLevel;
  /** Separate deadly events (deadly headlines more than INCIDENT_GAP_DAYS apart). */
  incidents: number;
  /** Highest toll a headline reports per incident, summed; 0 when none is stated. */
  deaths: number;
  /** Corruption or accountability coverage of this subject; protests about it. */
  linked: ("governance" | "unrest")[];
  headlineCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Most telling headlines: one per incident, then a linked one. */
  headlines: { title: string; url: string; pubDate: string; source: string }[];
  /** Plain-language summary for the panel. */
  summary: string;
}

const SUBJECTS: { id: IssueSubject; label: string; words: RegExp }[] = [
  { id: "rail", label: "Rail safety", words: /\b(trains?|rail(way|ways|road)?s?|derailment|high-speed (line|rail|train)s?|metro|subway|trams?|locomotive)\b/ },
  { id: "air", label: "Air travel", words: /\b(plane|aircraft|airliner|airline\w*|airport\w*|flights?|air traffic|runway|helicopter)\b/ },
  { id: "road", label: "Road safety", words: /\b(bus(es)?|coach crash|road\w*|highway|motorway|traffic accident|car crash|pile-?up)\b/ },
  { id: "sea", label: "Ferries and shipping", words: /\b(ferry|ferries|boat|ship|vessel|capsiz\w*|sinking)\b/ },
  { id: "buildings", label: "Buildings and bridges", words: /\b(building collapse|collapsed|collapse|bridge|dam|stampede|nightclub fire|blaze)\b/ },
  { id: "power", label: "Power supply", words: /\b(blackouts?|power cuts?|power outages?|outages?|grid|load-?shedding)\b/ },
  { id: "water", label: "Water supply", words: /\b(water shortage|water rationing|drought|tap water|contaminated water)\b/ },
  { id: "health", label: "Disease outbreaks", words: /\b(outbreak|epidemic|cholera|dengue|measles|mpox|malaria|virus|infections?)\b/ },
  { id: "crime", label: "Violent crime", words: /\b(shooting|stabbing|murder\w*|homicide\w*|gang\w*|cartel\w*|kidnap\w*|terror\w*)\b/ },
  { id: "unrest", label: "Strikes and protests", words: /\b(walk-?outs?|on strike|general strike|protest\w*|riot\w*|unrest|curfew)\b/ },
  { id: "politics", label: "Corruption and politics", words: /\b(corruption|bribe\w*|fraud|embezzl\w*|graft|kickbacks?|scandal|indict\w*)\b/ },
];

const GOVERNANCE = /\b(corruption|bribe\w*|fraud|embezzl\w*|graft|kickbacks?|scandal|indict\w*|negligen\w*|cover-?up|investigat\w*|prosecutor\w*|probe|inquiry|resign\w*|warned|warnings?)\b/;
const UNREST = /\b(protest\w*|riot\w*|walk-?outs?|on strike|demonstrat\w*|outrage)\b/;

const INCIDENT_GAP_DAYS = 10;
const DAY = 86_400_000;

/** Largest death count a headline states ("kills 68", "41 dead", "toll rises to 45"). */
export function deathsIn(title: string): number {
  const t = title.toLowerCase().replace(/,(\d{3})/g, "$1");
  const re = [
    /(\d{1,5})\s+(?:people\s+|passengers\s+|others\s+)?(?:dead|killed|deaths|die|died|lives)/g,
    /kill(?:s|ed|ing)\s+(?:at least\s+|more than\s+|over\s+|nearly\s+)?(\d{1,5})/g,
    /(?:death toll|toll)\s+(?:rises\s+to|climbs\s+to|reaches|hits|of|at|now)?\s*(?:at least\s+)?(\d{1,5})/g,
  ];
  let max = 0;
  for (const r of re) for (const m of t.matchAll(r)) max = Math.max(max, Number(m[1]));
  return max;
}

/** A headline's toll for one incident; 0 when it reports a running total over several. */
function incidentToll(title: string): number {
  return /\b(crashes|disasters|accidents|derailments|collisions|tragedies)\b/i.test(title) ? 0 : deathsIn(title);
}

/** Group deadly headlines into incidents: a gap of INCIDENT_GAP_DAYS starts a new one. */
function incidentsOf(items: PlaceNewsItem[]): PlaceNewsItem[][] {
  const sorted = [...items].sort((a, b) => Date.parse(a.pubDate) - Date.parse(b.pubDate));
  const groups: PlaceNewsItem[][] = [];
  for (const it of sorted) {
    const last = groups[groups.length - 1];
    if (last && Date.parse(it.pubDate) - Date.parse(last[last.length - 1]!.pubDate) <= INCIDENT_GAP_DAYS * DAY) last.push(it);
    else groups.push([it]);
  }
  return groups;
}

const fmtMonth = (iso: string) => new Date(iso).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Issues worth flagging for a place:
 * - systemic: 2+ separate deadly incidents in the window, or 1 plus corruption/accountability coverage of the subject
 * - incident: 1 deadly incident
 * - recurring: 3+ disruption headlines (strikes, outages...) without deaths
 */
export function detectIssues(items: PlaceNewsItem[]): NewsIssue[] {
  const relevant = items.filter((i) => i.mentions !== false);
  const issues: NewsIssue[] = [];
  for (const subject of SUBJECTS) {
    const about = relevant.filter((i) => {
      const t = i.title.toLowerCase();
      return subject.words.test(t) || (subject.id === "unrest" && LABOUR_STRIKE.test(t));
    });
    if (!about.length) continue;
    const deadly = about.filter((i) => i.severity === 3);
    const disruptive = about.filter((i) => i.severity >= 2);
    const incidents = incidentsOf(deadly);
    const isMeta = subject.id === "politics" || subject.id === "unrest";
    const governance = isMeta ? [] : about.filter((i) => GOVERNANCE.test(i.title.toLowerCase()));
    const unrest = isMeta ? [] : about.filter((i) => UNREST.test(i.title.toLowerCase()) || LABOUR_STRIKE.test(i.title.toLowerCase()));
    const linked: NewsIssue["linked"] = [];
    if (governance.length) linked.push("governance");
    if (unrest.length) linked.push("unrest");

    let level: IssueLevel | null = null;
    // A one-off mention ("survivor of a deadly crash...") is not evidence of a pattern:
    // an incident counts toward "systemic" only with 2+ headlines or a stated toll.
    const corroborated = incidents.filter((g) => g.length >= 2 || g.some((i) => deathsIn(i.title) > 0)).length;
    if (isMeta) {
      // Scandals and protests are their own signal; deaths in these headlines belong to
      // another subject (a crash that set off protests).
      if (subject.id === "politics" ? about.length >= 3 : disruptive.length >= 3) level = "recurring";
    } else if (corroborated >= 2 || (corroborated === 1 && governance.length >= 2)) level = "systemic";
    else if (incidents.length >= 1) level = "incident";
    else if (disruptive.length >= 3) level = "recurring";
    if (!level) continue;

    const deaths = DISCRETE.has(subject.id)
      ? incidents.reduce((sum, g) => sum + Math.max(0, ...g.map((i) => incidentToll(i.title))), 0)
      : 0;
    const dates = about.map((i) => i.pubDate).sort();
    const pickBy = (g: PlaceNewsItem[]) => [...g].sort((a, b) => deathsIn(b.title) - deathsIn(a.title))[0]!;
    const picks = [
      ...(isMeta ? [] : incidents.map(pickBy)),
      ...(governance.length ? [governance[0]!] : []),
      ...(!incidents.length || isMeta ? (subject.id === "politics" ? about : disruptive).slice(0, 2) : []),
    ];
    const seen = new Set<string>();
    const headlines = picks
      .filter((i) => !seen.has(i.title) && !!seen.add(i.title))
      .slice(0, 4)
      .map(({ title, url, pubDate, source }) => ({ title, url, pubDate, source }));

    const parts: string[] = [];
    if (incidents.length && !isMeta)
      parts.push(
        `${incidents.length} deadly ${incidents.length === 1 ? "incident" : "incidents"} (${incidents.map((g) => fmtMonth(g[0]!.pubDate)).join(", ")})` +
          (deaths ? `, at least ${deaths} dead in reports` : "")
      );
    else if (subject.id === "politics") parts.push(`${about.length} headlines since ${fmtMonth(dates[0]!)}`);
    else parts.push(`${disruptive.length} disruption headlines since ${fmtMonth(dates[0]!)}`);
    if (governance.length) parts.push("corruption or accountability questions in the coverage");
    if (unrest.length) parts.push("protests or strikes over it");

    issues.push({
      subject: subject.id,
      label: subject.label,
      level,
      incidents: incidents.length,
      deaths,
      linked,
      headlineCount: about.length,
      firstSeen: dates[0]!,
      lastSeen: dates[dates.length - 1]!,
      headlines,
      summary: parts.join("; ") + ".",
    });
  }
  const rank: Record<IssueLevel, number> = { systemic: 0, incident: 1, recurring: 2 };
  return issues.sort((a, b) => rank[a.level] - rank[b.level] || b.deaths - a.deaths || b.headlineCount - a.headlineCount);
}
