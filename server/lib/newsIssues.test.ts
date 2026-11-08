import { describe, it, expect } from "vitest";
import { deathsIn, detectIssues } from "./newsIssues";
import { classifyHeadline, type PlaceNewsItem } from "./placeNews";

const item = (title: string, pubDate: string, mentions = true): PlaceNewsItem => ({
  title,
  source: "X",
  url: `https://x/${encodeURIComponent(title)}`,
  pubDate,
  scope: "country",
  mentions,
  ...classifyHeadline(title),
});

describe("deathsIn", () => {
  it("reads the toll in common phrasings", () => {
    expect(deathsIn("Spain train crash kills at least 68")).toBe(68);
    expect(deathsIn("Death toll rises to 45 after derailment")).toBe(45);
    expect(deathsIn("41 dead in high-speed collision")).toBe(41);
    expect(deathsIn("Train services resume")).toBe(0);
  });
});

describe("detectIssues", () => {
  it("calls two deadly incidents months apart systemic, with linked corruption and protests", () => {
    const issues = detectIssues([
      item("High-speed train collision in Spain kills at least 41", "2026-01-18T20:00:00Z"),
      item("Spain derailment death toll rises to 45", "2026-01-20T08:00:00Z"),
      item("Spain train crash kills at least 68 on Madrid-Seville line", "2026-10-28T12:00:00Z"),
      item("Protests erupt in Spain after train crash kills dozens", "2026-10-30T12:00:00Z"),
      item("EU investigates fraud in Spain rail funds", "2026-11-05T09:00:00Z"),
      // A running total across both crashes must not inflate the October toll.
      item("Spain transport minister quits after two deadly train disasters, over 115 deaths", "2026-11-04T09:00:00Z"),
    ]);
    const rail = issues.find((i) => i.subject === "rail")!;
    expect(rail.level).toBe("systemic");
    expect(rail.incidents).toBe(2);
    expect(rail.deaths).toBe(45 + 68);
    expect(rail.linked).toEqual(["governance", "unrest"]);
    expect(rail.summary).toContain("2 deadly incidents (Jan 2026, Oct 2026)");
    expect(issues[0].subject).toBe("rail");
  });

  it("keeps a single accident an incident, not a pattern", () => {
    const [bus] = detectIssues([item("Bus crash in Peru kills 12", "2026-06-01T00:00:00Z")]);
    expect(bus.level).toBe("incident");
  });

  it("calls repeated disruption recurring", () => {
    const issues = detectIssues([
      item("Blackout leaves Johannesburg in the dark as outages cancel trains", "2026-09-01T00:00:00Z"),
      item("South Africa power outages disrupt business", "2026-09-10T00:00:00Z"),
      item("Rolling blackouts halt factories in South Africa", "2026-10-01T00:00:00Z"),
    ]);
    expect(issues.find((i) => i.subject === "power")?.level).toBe("recurring");
  });

  it("ignores headlines that do not name the place and background coverage", () => {
    expect(detectIssues([item("Train crash in Poland kills 6", "2026-05-01T00:00:00Z", false)])).toEqual([]);
    expect(detectIssues([item("Spain opens new high-speed line", "2026-05-01T00:00:00Z")])).toEqual([]);
  });
});
