import { describe, it, expect, afterEach, vi } from "vitest";
import { buildFlags, classifyHeadline, getPlaceNews, isSports, parseFeed, resetPlaceNewsCache, type PlaceNewsItem } from "./placeNews";

describe("classifyHeadline", () => {
  it("tags topics on whole words and stems", () => {
    expect(classifyHeadline("High-speed train crash in Spain kills 68").topics).toContain("transport");
    expect(classifyHeadline("High-speed train crash in Spain kills 68").severity).toBe(3);
    expect(classifyHeadline("Railway workers announce strike").topics).toEqual(expect.arrayContaining(["transport", "unrest"]));
    expect(classifyHeadline("Hiking the coastal trail this spring").topics).toEqual([]);
    expect(classifyHeadline("Warning issued for weekend").topics).not.toContain("conflict");
    expect(classifyHeadline("Israeli airstrike hits Gaza").topics).not.toContain("unrest");
  });

  it("grades disruption below harm", () => {
    expect(classifyHeadline("Flights cancelled as airport staff walk out").severity).toBe(2);
    expect(classifyHeadline("Minister opens new metro line").severity).toBe(1);
  });
});

const item = (title: string, pubDate = "2026-11-01T00:00:00Z"): PlaceNewsItem => ({
  title,
  source: "X",
  url: `https://x/${encodeURIComponent(title)}`,
  pubDate,
  scope: "country",
  ...classifyHeadline(title),
});

describe("buildFlags", () => {
  it("flags a deadly topic even once, and a recurring disruption", () => {
    const flags = buildFlags([
      item("Train collision kills 40 near Córdoba"),
      item("Metro strike disrupts commuters"),
      item("Power outage hits capital"),
      item("Second blackout this week leaves thousands without power", "2026-11-03T00:00:00Z"),
    ]);
    const byTopic = Object.fromEntries(flags.map((f) => [f.topic, f]));
    expect(byTopic.transport.severity).toBe(3);
    expect(byTopic.transport.headline).toBe("Train collision kills 40 near Córdoba");
    expect(byTopic.utilities).toBeUndefined(); // two headlines but neither reads as a disruption
    expect(flags[0].topic).toBe("transport");
  });

  it("ignores background coverage", () => {
    expect(buildFlags([item("Tourism minister visits Seville")])).toEqual([]);
  });
});

describe("relevance", () => {
  it("does not flag headlines that only matched the search somewhere else", () => {
    const off = { ...item("Portuguese woman injured in Poland shooting that leaves six dead"), mentions: false };
    expect(buildFlags([off])).toEqual([]);
  });

  it("drops sports coverage", () => {
    expect(isSports("How to Watch Valencia vs. Real Madrid Online?")).toBe(true);
    expect(isSports("A troublesome obstacle for Real Madrid in their first winter signing")).toBe(true);
    expect(isSports("Bengals could open the door to a trade", "A to Z Sports")).toBe(true);
    expect(isSports("Madrid metro strike halts lines", "El País")).toBe(false);
  });
});

describe("parseFeed", () => {
  it("splits the publisher off Google News titles", () => {
    const xml = `<rss><channel><item><title>Spain train crash: what we know so far - BBC News</title><link>https://n/1</link><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate><source url="https://bbc.co.uk">BBC News</source></item></channel></rss>`;
    const [it] = parseFeed(xml, "city");
    expect(it.title).toBe("Spain train crash: what we know so far");
    expect(it.source).toBe("BBC News");
    expect(it.pubDate).toBe("2026-10-28T10:00:00.000Z");
    expect(it.scope).toBe("city");
  });
});

describe("getPlaceNews", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPlaceNewsCache();
  });

  it("reports unavailable when every search fails, and does not cache it", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect((await getPlaceNews("Madrid", "Spain")).available).toBe(false);
    await getPlaceNews("Madrid", "Spain");
    expect(spy).toHaveBeenCalledTimes(6);
  });

  it("dedupes across the city and country searches and caches", async () => {
    const xml = `<rss><channel><item><title>Madrid metro strike halts lines - El País</title><link>https://n/1</link><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(xml));
    const r = await getPlaceNews("Madrid", "Spain");
    expect(r.available).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].scope).toBe("city");
    await getPlaceNews("Madrid", "Spain");
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
