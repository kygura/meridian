import { describe, it, expect, afterEach, vi } from "vitest";
import { getNewsBrief, parseBrief, pickSources, resetBriefCache, rulesBrief, setBriefGenerator, buildPrompt, SYSTEM_PROMPT } from "./newsBrief";
import type { PlaceNews } from "./placeNews";
import type { NewsIssue } from "./newsIssues";

const h = (title: string, source: string, pubDate: string) => ({ title, url: `https://n/${encodeURIComponent(title)}`, source, pubDate });

const railIssue: NewsIssue = {
  subject: "rail",
  label: "Rail safety",
  level: "systemic",
  incidents: 2,
  deaths: 113,
  linked: ["governance"],
  headlineCount: 40,
  firstSeen: "2026-01-18T00:00:00Z",
  lastSeen: "2026-11-05T00:00:00Z",
  headlines: [
    h("HORROR on the tracks: Spain crash kills 45", "Tabloid", "2026-01-20T00:00:00Z"),
    h("Spain train crash kills at least 68", "Reuters", "2026-10-28T00:00:00Z"),
    h("EU investigates fraud in Spain rail funds", "Politico", "2026-11-05T00:00:00Z"),
  ],
  summary: "2 deadly incidents (Jan 2026, Oct 2026), at least 113 dead in reports; corruption or accountability questions in the coverage.",
};

const place = (issues: NewsIssue[] = [railIssue]): PlaceNews => ({
  available: true,
  issues,
  flags: [],
  items: [
    { title: "Madrid hosts design week", source: "El País", url: "https://n/d", pubDate: "2026-11-06T00:00:00Z", scope: "city", topics: [], severity: 1, mentions: true },
    { title: "Crash in Poland kills 3", source: "X", url: "https://n/p", pubDate: "2026-11-06T00:00:00Z", scope: "country", topics: ["transport"], severity: 3, mentions: false },
  ],
});

afterEach(() => {
  setBriefGenerator();
  resetBriefCache();
});

describe("pickSources", () => {
  it("puts issue headlines first and skips items that don't name the place", () => {
    const s = pickSources(place());
    expect(s.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(s[0].source).toBe("Tabloid");
    expect(s.some((x) => x.title.includes("Poland"))).toBe(false);
  });
});

describe("prompt", () => {
  it("asks for neutral wording and cites the issue's sources by number", () => {
    expect(SYSTEM_PROMPT).toMatch(/No sensational/);
    const p = buildPrompt("Madrid", "Spain", [railIssue], pickSources(place()), new Date("2026-11-07T00:00:00Z"));
    expect(p).toContain("Rail safety (systemic)");
    expect(p).toContain("Sources: [1] [2] [3]");
    expect(p).toContain("[2] (Reuters, 2026-10-28) Spain train crash kills at least 68");
  });
});

describe("parseBrief", () => {
  it("strips inline citations, drops bad source numbers and empty points", () => {
    const r = parseBrief(
      '```json\n{"overview":"Two rail crashes [1, 2].","points":[{"title":"Rail safety","level":"systemic","text":"Two crashes killed over 100 people [1][2].","sources":[1,2,99]},{"title":"","text":"x","sources":[]}]}\n```',
      3
    )!;
    expect(r.overview).toBe("Two rail crashes.");
    expect(r.points).toEqual([{ title: "Rail safety", level: "systemic", text: "Two crashes killed over 100 people.", sources: [1, 2] }]);
    expect(parseBrief("not json", 3)).toBeNull();
  });
});

describe("rulesBrief", () => {
  it("uses the issue summaries, not the headlines", () => {
    const r = rulesBrief("Spain", [railIssue], pickSources(place()));
    expect(r.overview).toContain("pattern in rail safety");
    expect(r.points[0].text).not.toMatch(/HORROR/);
    expect(r.points[0].sources).toEqual([1, 2, 3]);
    expect(rulesBrief("Spain", [], []).overview).toMatch(/Nothing travel-relevant/);
  });
});

describe("getNewsBrief", () => {
  it("uses the model, lists only cited sources renumbered, and caches", async () => {
    const gen = vi.fn(async () => JSON.stringify({ overview: "Rail safety is under scrutiny.", points: [{ title: "Rail safety", level: "systemic", text: "Two crashes, an EU fraud probe.", sources: [2, 3] }] }));
    setBriefGenerator(gen);
    const b = await getNewsBrief("Madrid", "Spain", place());
    expect(b.by).toBe("model");
    expect(b.sources.map((s) => [s.n, s.source])).toEqual([[1, "Reuters"], [2, "Politico"]]);
    expect(b.points[0].sources).toEqual([1, 2]);
    await getNewsBrief("Madrid", "Spain", place());
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("falls back to rules when the model fails or returns junk", async () => {
    setBriefGenerator(async () => "sorry");
    expect((await getNewsBrief("Madrid", "Spain", place())).by).toBe("rules");
    resetBriefCache();
    setBriefGenerator(async () => {
      throw new Error("quota");
    });
    const b = await getNewsBrief("Madrid", "Spain", place());
    expect(b.by).toBe("rules");
    expect(b.points[0].title).toBe("Rail safety");
  });

  it("uses rules without a key", async () => {
    setBriefGenerator(null);
    expect((await getNewsBrief("Madrid", "Spain", place())).by).toBe("rules");
  });
});
