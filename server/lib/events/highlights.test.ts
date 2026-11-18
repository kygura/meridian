import { describe, it, expect } from "vitest";
import type { City } from "../../../src/types";
import {
  compactHighlight,
  expandHighlight,
  aggregateByGenus,
  credibleMention,
  genericGenusNames,
  highlightEvent,
  selectStored,
  seasonalPool,
  highlightScore,
  highlightTags,
  highlightTitle,
  isCommon,
  monthlyTable,
  parseSpeciesCounts,
  rankHighlights,
  seasonalCandidates,
  seasonWindow,
  tallyHighlights,
  type Highlight,
  type SpeciesPage,
  type SpeciesRow,
} from "./highlights";

const row = (over: Partial<SpeciesRow> & { taxonId: number; count: number }): SpeciesRow => ({ name: `Species ${over.taxonId}`, common: null, iconic: "Plantae", globalCount: 50_000, rank: "species", rankLevel: 10, ...over });
const page = (rows: SpeciesRow[], total = rows.length): SpeciesPage => ({ total, rows });
/** Twelve month pages in which the given taxon has `counts` observations. */
const pagesFor = (counts: number[], over: Partial<SpeciesRow> = {}): SpeciesPage[] => counts.map((c) => page(c > 0 ? [row({ taxonId: 1, count: c, ...over })] : []));
const city = { id: "x-land", name: "X", country: "Xland", lat: 10, lng: 20 } as unknown as City;
const hl = (over: Partial<Highlight> = {}): Highlight => ({ t: 1, n: "Genus species", c: "Red flower", i: "Plantae", k: "plant", m: [0, 0, 5, 20, 5, 0, 0, 0, 0, 0, 0, 0], total: 30, months: [3, 4, 5], share: 1, ...over });

describe("seasonWindow", () => {
  it("finds a window of at most three months holding 60% of the counts", () => {
    expect(seasonWindow([0, 0, 10, 20, 10, 0, 0, 0, 0, 0, 0, 0])).toEqual({ months: [3, 4, 5], share: 1 });
    const w = seasonWindow([5, 5, 5, 5, 5, 5, 40, 5, 5, 5, 5, 5]);
    expect(w).toBeUndefined();
  });

  it("wraps the year: November to January", () => {
    const w = seasonWindow([12, 2, 0, 0, 0, 0, 0, 0, 0, 1, 10, 25]);
    expect(w?.months).toEqual([11, 12, 1]);
    expect(w?.share).toBeCloseTo(47 / 50, 5);
  });

  it("trims an edge month that adds under 15% of the window", () => {
    expect(seasonWindow([0, 0, 2, 50, 48, 0, 0, 0, 0, 0, 0, 0])?.months).toEqual([4, 5]);
    expect(seasonWindow([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40])?.months).toEqual([12]);
  });

  it("does not trim below the share", () => {
    // The three months hold 62%; dropping March (8, under 15% of 62) would leave 54%.
    expect(seasonWindow([0, 0, 8, 30, 24, 0, 0, 0, 0, 0, 0, 38])?.months).toEqual([3, 4, 5]);
  });

  it("is undefined for a flat year, an empty one and a wrong length", () => {
    expect(seasonWindow(new Array(12).fill(10))).toBeUndefined();
    expect(seasonWindow(new Array(12).fill(0))).toBeUndefined();
    expect(seasonWindow([1, 2, 3])).toBeUndefined();
  });

  it("accepts a share of exactly 60%", () => {
    const w = seasonWindow([0, 0, 20, 20, 20, 10, 10, 10, 10, 0, 0, 0]);
    expect(w?.months).toEqual([3, 4, 5]);
    expect(w?.share).toBeCloseTo(0.6, 6);
  });
});

describe("parseSpeciesCounts", () => {
  it("reads rows and skips malformed ones", () => {
    const body = { total_results: 3, results: [{ count: 7, taxon: { id: 5, name: "A b", rank: "species", rank_level: 10, iconic_taxon_name: "Aves", preferred_common_name: "  Bee eater ", observations_count: 900 } }, { count: "x", taxon: {} }, { taxon: { id: 1, name: "n" } }] };
    expect(parseSpeciesCounts(body)).toEqual({ total: 3, rows: [{ taxonId: 5, name: "A b", common: "Bee eater", iconic: "Aves", globalCount: 900, rank: "species", rankLevel: 10, count: 7 }] });
  });
  it("is undefined for a body that is not a species_counts answer", () => {
    expect(parseSpeciesCounts(null)).toBeUndefined();
    expect(parseSpeciesCounts({ results: [] })).toBeUndefined();
    expect(parseSpeciesCounts({ total_results: 1, results: "x" })).toBeUndefined();
  });
});

describe("monthlyTable", () => {
  it("fills the months a full page did not list with half of its cut-off, and the gaps of a short page with zero", () => {
    const full = page([row({ taxonId: 1, count: 40 }), row({ taxonId: 2, count: 8 })]);
    const short = page([row({ taxonId: 1, count: 3 })]);
    const t = monthlyTable([full, short, ...new Array(10).fill(short)], 2);
    // January's page is full (perPage 2) with cut-off 8, so taxon 3 would be at most 8; taxon 2 is missing from the short pages.
    expect(t.get(2)!.m.slice(0, 3)).toEqual([8, 0, 0]);
    expect(t.get(1)!.m[0]).toBe(40);
    const withMissing = monthlyTable([full, ...new Array(11).fill(short)], 2);
    expect(withMissing.get(2)!.m[1]).toBe(0);
    const tailCut = monthlyTable([page([row({ taxonId: 1, count: 40 })]), page([row({ taxonId: 1, count: 9 }), row({ taxonId: 2, count: 6 })]), ...new Array(10).fill(page([]))], 2);
    expect(tailCut.get(1)!.m[1]).toBe(9);
    expect(tailCut.get(2)!.m[0]).toBe(0);
    expect(tailCut.get(1)!.m[0]).toBe(40);
  });
});

describe("seasonalCandidates", () => {
  it("keeps a species that bunches in a few months, and records its window", () => {
    const [h] = seasonalCandidates(pagesFor([0, 0, 0, 0, 0, 3, 40, 12, 0, 0, 0, 0]), "plant", 100);
    expect(h).toMatchObject({ t: 1, k: "plant", total: 55, months: [7, 8] });
    // June holds 5% of the window and is trimmed.
    expect(h!.share).toBeCloseTo(52 / 55, 3);
  });

  it("applies the minimum counts: 20 for flowering plants, 30 for animals", () => {
    const counts = [0, 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 0];
    expect(seasonalCandidates(pagesFor(counts), "plant", 100)).toHaveLength(1);
    expect(seasonalCandidates(pagesFor(counts, { iconic: "Aves" }), "animal", 100)).toHaveLength(0);
    expect(seasonalCandidates(pagesFor(counts.map((c) => c * 2), { iconic: "Aves" }), "animal", 100)).toHaveLength(1);
  });

  it("drops a species seen all year, an obscure taxon and a rank above species", () => {
    expect(seasonalCandidates(pagesFor(new Array(12).fill(10)), "plant", 100)).toHaveLength(0);
    expect(seasonalCandidates(pagesFor([0, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0], { globalCount: 400 }), "plant", 100)).toHaveLength(0);
    expect(seasonalCandidates(pagesFor([0, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0], { rankLevel: 20, rank: "genus" }), "plant", 100)).toHaveLength(0);
  });

  it("keeps thirty at most, the largest count x share first", () => {
    const pages: SpeciesPage[] = Array.from({ length: 12 }, (_, mi) => page(mi === 5 ? Array.from({ length: 50 }, (_, i) => row({ taxonId: 100 + i, count: 20 + i })) : []));
    const out = seasonalCandidates(pages, "plant", 100);
    expect(out).toHaveLength(30);
    expect(out[0]!.t).toBe(149);
  });
});

describe("uniqueness", () => {
  const a = hl({ t: 1, total: 100 });
  const b = hl({ t: 2, total: 100 });
  it("tallies the cities where each taxon is a highlight", () => {
    const t = tallyHighlights([[a, b], [a], []]);
    expect(t.cities).toBe(3);
    expect(t.byTaxon.get(1)).toBe(2);
    expect(t.byTaxon.get(2)).toBe(1);
  });

  it("scores local count x concentration x ln(1 + cities / cities with it), so a rarer species ranks above a common one", () => {
    const t = tallyHighlights([[a, b], [a], [a], [a]]);
    expect(highlightScore(b, t)).toBeCloseTo(100 * 1 * Math.log(1 + 4 / 1), 6);
    expect(highlightScore(a, t)).toBeCloseTo(100 * 1 * Math.log(1 + 4 / 4), 6);
    expect(rankHighlights([a, b], t).map((h) => h.t)).toEqual([2, 1]);
    // A lower count with a lower share loses to a higher one at equal frequency.
    expect(highlightScore(hl({ t: 9, total: 100, share: 0.7 }), t)).toBeLessThan(highlightScore(hl({ t: 9, total: 100, share: 1 }), t));
  });

  it("drops species that are highlights in more than 15% of the cities once 40 are checked, not before", () => {
    const common = hl({ t: 7 });
    const few = tallyHighlights(Array.from({ length: 39 }, () => [common]));
    expect(isCommon(common, few)).toBe(false);
    const cities: Highlight[][] = Array.from({ length: 40 }, (_, i) => (i < 7 ? [common] : []));
    // 7 of 40 is 17.5%.
    expect(isCommon(common, tallyHighlights(cities))).toBe(true);
    // 6 of 40 is exactly 15%: kept.
    const six: Highlight[][] = Array.from({ length: 40 }, (_, i) => (i < 6 ? [common] : []));
    expect(isCommon(common, tallyHighlights(six))).toBe(false);
    expect(rankHighlights([common, hl({ t: 8 })], tallyHighlights(cities)).map((h) => h.t)).toEqual([8]);
  });

  it("ranks plants and animals against their own kind, so the best plant is not crowded out by animal counts", () => {
    const animals = [10, 11, 12].map((t) => hl({ t, k: "animal", i: "Aves", c: `Bird ${t}`, total: 2000 - t * 10, share: 0.8 }));
    const plant = hl({ t: 20, total: 40, share: 0.95 });
    const list = [...animals, plant];
    const out = rankHighlights(list, tallyHighlights([list]));
    expect(out.map((h) => h.t)).toEqual([10, 20, 11]);
  });

  it("returns at most three highlights", () => {
    const list = [1, 2, 3, 4, 5].map((t) => hl({ t, total: 100 - t }));
    expect(rankHighlights(list, tallyHighlights([list]))).toHaveLength(3);
  });
});

describe("stored form", () => {
  it("keeps the counts and the names, and works the season out again on reading", () => {
    const h = hl({ t: 5, c: "Barn Swallow", i: "Aves", k: "animal", m: [0, 0, 0, 0, 3, 40, 50, 6, 0, 0, 0, 0], total: 99, months: [6, 7], share: 0.9 });
    const stored = compactHighlight(h);
    expect(stored).toEqual({ t: 5, c: "Barn Swallow", i: "Aves", m: [0, 0, 0, 0, 3, 40, 50, 6, 0, 0, 0, 0] });
    const back = expandHighlight(stored)!;
    expect(back).toMatchObject({ t: 5, k: "animal", total: 99, months: [6, 7] });
    expect(back.share).toBeCloseTo(90 / 99, 2);
  });

  it("keeps the scientific name only when there is no common name", () => {
    expect(compactHighlight(hl({ c: "", n: "Genus species" }))).toMatchObject({ n: "Genus species", c: "" });
    expect(compactHighlight(hl({ c: "Red flower", n: "Genus species" }))).not.toHaveProperty("n");
  });

  it("cannot expand counts that show no season", () => {
    expect(expandHighlight({ t: 1, c: "x", i: "Plantae", m: new Array(12).fill(5) })).toBeUndefined();
    expect(expandHighlight({ t: 1, c: "x", i: "Plantae", m: [1, 2] })).toBeUndefined();
  });
});

describe("titles, tags and events", () => {
  it("titles plants 'X in bloom' and animals 'X season', capitalised", () => {
    expect(highlightTitle(hl({ c: "jacaranda" }))).toBe("Jacaranda in bloom");
    expect(highlightTitle(hl({ k: "animal", i: "Mammalia", c: "Humpback Whale", share: 0.9 }))).toBe("Humpback Whale season");
  });

  it("falls back to the scientific name when there is no common name", () => {
    expect(highlightTitle(hl({ c: "", n: "Jacaranda mimosifolia" }))).toBe("Jacaranda mimosifolia in bloom");
  });

  it("calls a bird absent outside its window a migration, and a bird seen all year a season", () => {
    const bird = { k: "animal" as const, i: "Aves", c: "Barn Swallow" };
    expect(highlightTitle(hl({ ...bird, share: 0.97 }))).toBe("Barn Swallow migration");
    expect(highlightTitle(hl({ ...bird, share: 0.8 }))).toBe("Barn Swallow season");
    // Only birds migrate in the title: a whale absent outside its window is a season.
    expect(highlightTitle(hl({ k: "animal", i: "Mammalia", c: "Humpback Whale", share: 0.99 }))).toBe("Humpback Whale season");
  });

  it("tags from the iconic taxon and the common name", () => {
    expect(highlightTags(hl({ c: "Japanese Flowering Cherry" }))).toEqual(["bloom", "japanese-flowering-cherry"]);
    expect(highlightTags(hl({ k: "animal", i: "Aves", c: "Eurasian Hoopoe" }))).toEqual(["birds", "wildlife", "eurasian-hoopoe"]);
    expect(highlightTags(hl({ k: "animal", i: "Mollusca", c: "" , n: "Octopus vulgaris" }))).toEqual(["marine-life", "wildlife", "octopus-vulgaris"]);
    expect(highlightTags(hl({ k: "animal", i: "Insecta", c: "Monarch" }))).toEqual(["insects", "wildlife", "monarch"]);
  });

  it("builds an event with the peak months, the numbers and a matching observations search", () => {
    const e = highlightEvent(hl({ t: 77541, c: "jacaranda", months: [10, 11], total: 120, share: 0.93 }), city);
    expect(e).toMatchObject({ id: "inat-77541-x-land", title: "Jacaranda in bloom", kind: "nature", cityIds: ["x-land"], month: 10, months: [10, 11], recurring: true, source: "inaturalist", feed: "inaturalist" });
    expect(e.note).toBe("93% of 120 iNaturalist observations within 30 km fall in Oct to Nov.");
    const u = new URL(e.sourceUrl!);
    expect(u.origin + u.pathname).toBe("https://www.inaturalist.org/observations");
    expect(Object.fromEntries(u.searchParams)).toEqual({ taxon_id: "77541", lat: "10.0000", lng: "20.0000", radius: "30", month: "10,11", quality_grade: "any" });
  });

  it("searches an animal's verifiable observations only, and omits months for a one-month window", () => {
    const e = highlightEvent(hl({ k: "animal", i: "Mammalia", c: "Whale", months: [7] }), city);
    expect(e.months).toBeUndefined();
    expect(new URL(e.sourceUrl!).searchParams.get("verifiable")).toBe("true");
    expect(new URL(e.sourceUrl!).searchParams.has("quality_grade")).toBe(false);
    expect(e.note).toMatch(/fall in Jul\.$/);
  });
});

describe("the place's own text", () => {
  const cherry = (t: number, total: number, over: Partial<Highlight> = {}): Highlight =>
    hl({ t, c: `Cherry ${t}`, n: `Prunus s${t}`, total, w: 2, g: "Prunus", gc: "cherry", m: [0, 0, total / 2, total / 2, 0, 0, 0, 0, 0, 0, 0, 0], months: [3, 4], ...over });
  const weed = (t: number, total: number) => hl({ t, c: `Weed ${t}`, total, share: 0.9, m: [0, 0, total / 2, total / 2, 0, 0, 0, 0, 0, 0, 0, 0], months: [3, 4] });

  it("ranks a mentioned species above unmentioned ones, whatever their counts", () => {
    const list = [weed(1, 1000), weed(2, 900), weed(3, 800), hl({ t: 4, c: "Famous", total: 25, w: 1 })];
    const out = rankHighlights(list, tallyHighlights([list]));
    expect(out[0]!.t).toBe(4);
    expect(out).toHaveLength(3);
  });

  it("shows an unmentioned species only when strongly seasonal, unless the city has no text", () => {
    const flat = hl({ t: 5, total: 500, share: 0.65 });
    expect(rankHighlights([flat], tallyHighlights([[flat]]))).toEqual([]);
    expect(rankHighlights([flat], tallyHighlights([[flat]]), false).map((h) => h.t)).toEqual([5]);
    const sharp = hl({ t: 6, total: 500, share: 0.8 });
    expect(rankHighlights([sharp], tallyHighlights([[sharp]])).map((h) => h.t)).toEqual([6]);
  });

  it("keeps an unmentioned species out when more than 5% of 40 checked cities share it", () => {
    const sharp = hl({ t: 6, total: 500, share: 0.9 });
    const cities: Highlight[][] = Array.from({ length: 40 }, (_, i) => (i < 3 ? [sharp] : []));
    expect(rankHighlights([sharp], tallyHighlights(cities))).toEqual([]);
    expect(rankHighlights([{ ...sharp, w: 1 }], tallyHighlights(cities)).map((h) => h.t)).toEqual([6]);
  });

  it("makes one highlight of the species of a genus the text mentions through the genus", () => {
    const out = aggregateByGenus([cherry(1, 100), cherry(2, 60), cherry(3, 40), weed(9, 500)]);
    expect(out).toHaveLength(2);
    const agg = out.find((h) => h.agg)!;
    expect(agg).toMatchObject({ t: 1, total: 200, months: [3, 4], agg: { ids: [1, 2, 3], species: 3 } });
    expect(highlightTitle(agg)).toBe("Cherry in bloom");
    expect(highlightTitle({ ...agg, b: 1 })).toBe("Cherry blossom");
    expect(highlightTags(agg)).toEqual(["bloom", "cherry"]);
  });

  it("leaves a lone mentioned species with its own name, and species of one genus in other seasons apart", () => {
    const lone = aggregateByGenus([cherry(1, 100)]);
    expect(lone[0]!.agg).toBeUndefined();
    expect(highlightTitle(lone[0]!)).toBe("Cherry 1 in bloom");
    const apart = aggregateByGenus([cherry(1, 100), cherry(2, 60, { months: [9, 10], m: [0, 0, 0, 0, 0, 0, 0, 0, 30, 30, 0, 0] })]);
    expect(apart.filter((h) => h.agg)).toHaveLength(0);
    expect(apart).toHaveLength(2);
  });

  it("links an aggregate to the observations of all its species, and says how many", () => {
    const agg = aggregateByGenus([cherry(1, 100), cherry(2, 60)]).find((h) => h.agg)!;
    const e = highlightEvent(agg, city);
    expect(new URL(e.sourceUrl!).searchParams.get("taxon_id")).toBe("1,2");
    expect(e.note).toContain("of 2 species of one genus");
  });

  it("looks up a mentioned species with fewer observations than the usual minimum, and stores the mentioned first", () => {
    const pages = pagesFor([0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0], { parentIds: [7] });
    expect(seasonalCandidates(pages, "plant", 100)).toHaveLength(0);
    const pool = seasonalPool(pages, "plant", 100);
    expect(pool).toHaveLength(1);
    expect(pool[0]!.parentIds).toEqual([7]);
    expect(selectStored(pool, "plant")).toHaveLength(0);
    expect(selectStored([{ ...pool[0]!, w: 1 }], "plant")).toHaveLength(1);
  });

  it("stores the mention, the genus and the genus name", () => {
    const stored = compactHighlight(cherry(1, 60, { b: 1 }));
    expect(stored).toMatchObject({ w: 2, g: "Prunus", gc: "cherry", b: 1 });
    expect(compactHighlight(hl({ w: 1 }))).toMatchObject({ w: 1 });
    expect(compactHighlight(hl({ w: 1 }))).not.toHaveProperty("g");
    expect(compactHighlight(hl())).not.toHaveProperty("w");
  });
});

describe("credible mentions", () => {
  const alts = (c: string) => c.split(",").map((x) => x.trim());
  it("finds the words that end many genus names", () => {
    const names = ["blue flower", "red flower", "wild flower", "sun flower", "may flower", "bell flower", "cherry"];
    const generic = genericGenusNames(names, alts);
    expect(generic.has("flower")).toBe(true);
    expect(generic.has("cherry")).toBe(false);
  });

  it("does not believe a mention through a generic or very short name, or a short one-word species name", () => {
    const generic = new Set(["flower"]);
    expect(credibleMention(hl({ w: 2, gc: "cherry" }), generic)).toBe(true);
    expect(credibleMention(hl({ w: 2, gc: "flower" }), generic)).toBe(false);
    expect(credibleMention(hl({ w: 2, gc: "map" }), generic)).toBe(false);
    expect(credibleMention(hl({ w: 2, gc: "prickly pear" }), generic)).toBe(true);
    expect(credibleMention(hl({ w: 1, c: "Stars" }), generic)).toBe(false);
    expect(credibleMention(hl({ w: 1, c: "Humpback Whale" }), generic)).toBe(true);
    expect(credibleMention(hl({ w: 1, c: "waratah" }), generic)).toBe(true);
  });

  it("ranks a mention that is not believed as no mention", () => {
    const flowerish = hl({ t: 3, c: "Ox Knee", total: 30, share: 0.6, w: 2, g: "Genus", gc: "flower" });
    const weed = hl({ t: 4, c: "Weed", total: 900, share: 0.9 });
    const out = rankHighlights([flowerish, weed], tallyHighlights([[flowerish, weed]]), true, new Set(["flower"]));
    expect(out.map((h) => h.t)).toEqual([4]);
  });
});
