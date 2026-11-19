import { describe, it, expect } from "vitest";
import { articleBlocks, estimateTokens, MAX_CHARS, MAX_SECTION_CHARS, promptText, selectBlocks } from "./highlightText";
import { articleUrl, splitSections } from "./placeText";

const voyage = `Kyoto is the old capital.

== Understand ==
Spring is busy.
=== Climate ===
Summers are hot and humid; the rainy season runs from June.

== See ==
Temples.

== Eat ==
Kaiseki.

== Do ==
The Gion Matsuri is held all July.

== Get in ==
By train.`;

describe("sections", () => {
  it("splits an extract on level-2 headings, keeps subsections inside, and calls the part before the first the lead", () => {
    const s = splitSections(voyage);
    expect(s.map((x) => x.heading)).toEqual(["", "Understand", "See", "Eat", "Do", "Get in"]);
    expect(s[1]!.text).toContain("=== Climate ===");
    expect(s[0]!.text).toBe("Kyoto is the old capital.");
  });

  it("links an article and a section by anchor", () => {
    expect(articleUrl("wikivoyage", "Kyoto (prefecture)", "Get in")).toBe("https://en.wikivoyage.org/wiki/Kyoto_(prefecture)#Get_in");
    expect(articleUrl("wikipedia", "Washington, D.C.")).toBe("https://en.wikipedia.org/wiki/Washington,_D.C.");
  });
});

describe("articleBlocks", () => {
  it("takes the Wikivoyage sections that carry seasons, leaves out the rest, and the lead first", () => {
    const b = articleBlocks("wikivoyage", "wikivoyage", "Kyoto", voyage);
    expect(b.map((x) => [x.heading || "lead", x.priority])).toEqual([["lead", 1], ["Understand", 1], ["See", 4], ["Do", 3], ["Get in", 5]]);
    expect(b.every((x) => x.source === "wikivoyage" && x.url.startsWith("https://en.wikivoyage.org/wiki/Kyoto"))).toBe(true);
  });

  it("takes the Wikipedia lead and its Climate, Festivals and Culture sections only", () => {
    const wp = "Lead text.\n\n== History ==\nOld.\n\n== Climate ==\nHot.\n\n== Culture ==\nFestivals.\n\n== Economy ==\nTrade.";
    expect(articleBlocks("wikipedia", "wikipedia", "Kyoto", wp).map((x) => x.heading || "lead")).toEqual(["lead", "Climate", "Culture"]);
  });

  it("takes a region's Wikivoyage Understand, Climate, Do, Events and See, labelled region", () => {
    const b = articleBlocks("region", "wikivoyage", "Provence", voyage);
    expect(b.map((x) => x.heading || "lead")).toEqual(["lead", "Understand", "See", "Do"]);
    expect(b.every((x) => x.source === "region")).toBe(true);
  });

  it("cuts one section to 6,000 characters", () => {
    const b = articleBlocks("wikivoyage", "wikivoyage", "X", `== Understand ==\n${"a ".repeat(10_000)}`);
    expect(b[0]!.text.length).toBe(MAX_SECTION_CHARS);
  });
});

describe("selectBlocks and promptText", () => {
  it("keeps season-bearing sections first and stops at the budget of about 12,000 tokens", () => {
    const big = (heading: string, priority: number) => ({ source: "wikivoyage" as const, article: "X", heading, url: "u", text: "w ".repeat(3000), priority });
    const blocks = [big("See", 4), big("Understand", 1), big("Do", 3), big("Get in", 5), big("Climate", 1), big("Events", 2), big("Culture", 6), big("Extra", 7), big("More", 8)];
    const sel = selectBlocks(blocks);
    expect(sel.map((b) => b.heading).slice(0, 3)).toEqual(["Understand", "Climate", "Events"]);
    expect(sel.reduce((a, b) => a + b.text.length, 0)).toBeLessThanOrEqual(MAX_CHARS);
    expect(sel.length).toBeLessThan(blocks.length);
    expect(estimateTokens(sel)).toBeLessThanOrEqual(12_100);
  });

  it("labels each block with its source, article and section", () => {
    const t = promptText(selectBlocks(articleBlocks("wikivoyage", "wikivoyage", "Kyoto", voyage)));
    expect(t).toContain("[wikivoyage: Kyoto / lead]");
    expect(t).toContain("[wikivoyage: Kyoto / Do]\nThe Gion Matsuri");
  });
});
