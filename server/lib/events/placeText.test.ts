import { describe, it, expect } from "vitest";
import type { City } from "../../../src/types";
import { fetchPlaceText, genusAlternatives, mentionOf, mentions, normalizeText, phraseForms, pickCityPage } from "./placeText";

const city = { id: "avignon-france", name: "Avignon", country: "France", lat: 43.95, lng: 4.81 } as unknown as City;
const text = normalizeText("Every spring the Sakura bloom. Cherry blossoms line the river, and tulips and Humpback whales are seen. Lavender fields of Provence; Jacaranda trees.");

describe("text matching", () => {
  it("normalizes accents, case and punctuation", () => {
    expect(normalizeText("Côte d'Azur, São Paulo!")).toBe(" cote d azur sao paulo ");
  });

  it("matches a phrase on word boundaries with a simple plural", () => {
    expect(mentions(text, "cherry blossom")).toBe(true);
    expect(mentions(text, "tulip")).toBe(true);
    expect(mentions(text, "humpback whale")).toBe(true);
    expect(mentions(text, "lav")).toBe(false);
    expect(mentions(text, "bloom")).toBe(true);
    expect(mentions(normalizeText("a cherry tree"), "cherries")).toBe(true);
    expect(phraseForms("Cherry")).toContain(" cherries ");
  });

  it("splits iNaturalist's genus names on commas only", () => {
    expect(genusAlternatives("plums, cherries, and allies")).toEqual(["plum", "cherry"]);
    expect(genusAlternatives("annual and perennial fleabanes")).toEqual(["annual and perennial fleabane"]);
    expect(genusAlternatives("tulips")).toEqual(["tulip"]);
    expect(genusAlternatives(null)).toEqual([]);
  });
});

describe("mentionOf", () => {
  it("counts the species' own common name or scientific name as a mention of the species", () => {
    expect(mentionOf(text, { n: "Megaptera novaeangliae", c: "Humpback Whale", genusCommon: [] })).toEqual({ w: 1 });
    expect(mentionOf(normalizeText("the Jacaranda mimosifolia avenue"), { n: "Jacaranda mimosifolia", c: "", genusCommon: [] })).toEqual({ w: 1 });
  });

  it("counts the genus name, or a common name of the genus, as a mention of the genus", () => {
    expect(mentionOf(text, { n: "Jacaranda mimosifolia", c: "blue jacaranda", genusCommon: [] })).toMatchObject({ w: 2, gc: "jacaranda" });
    const cherry = mentionOf(text, { n: "Prunus serrulata", c: "Japanese Cherry", genusCommon: ["plums, cherries, and allies"] });
    expect(cherry).toMatchObject({ w: 2, gc: "cherry", blossom: true });
    expect(mentionOf(normalizeText("a cherry tree"), { n: "Prunus serrulata", c: "Japanese Cherry", genusCommon: ["plums, cherries, and allies"] })).toMatchObject({ w: 2, gc: "cherry", blossom: false });
  });

  it("does not use a loose word of the species' common name", () => {
    expect(mentionOf(normalizeText("a blue sky and a plant"), { n: "Genus species", c: "Pea Blue", genusCommon: [] })).toEqual({ w: 0 });
    expect(mentionOf(normalizeText("nothing"), { n: "Genus species", c: "Red Flower", genusCommon: [] })).toEqual({ w: 0 });
  });
});

describe("pickCityPage", () => {
  const page = (title: string, lat: number, lon: number, over: object = {}) => ({ title, coordinates: [{ lat, lon }], ...over });
  it("takes the nearest article within 50 km that is not a disambiguation page", () => {
    const pages = [page("Avignon (disambiguation)", 43.95, 4.81, { pageprops: { disambiguation: "" } }), page("Avignon", 43.949, 4.805), page("Avignon, Far", 10, 10), { title: "Missing", missing: true }];
    expect(pickCityPage(pages, city)?.title).toBe("Avignon");
    expect(pickCityPage([page("Washington", 47, -120)], { lat: 38.9, lng: -77 })).toBeUndefined();
  });
});

describe("fetchPlaceText", () => {
  const wp = (extra: object) => ({ query: { pages: [extra] } });
  function fake(over: { fail?: (url: string) => boolean } = {}) {
    const urls: string[] = [];
    const get = async (url: string): Promise<unknown> => {
      urls.push(url);
      if (over.fail?.(url)) throw new Error("429");
      const u = new URL(url);
      const p = u.searchParams;
      if (u.host === "en.wikipedia.org" && p.get("prop") === "coordinates|pageprops") return wp({ title: "Avignon", coordinates: [{ lat: 43.95, lon: 4.81 }], pageprops: { wikibase_item: "Q6602" } });
      if (u.host === "www.wikidata.org" && p.get("action") === "wbgetclaims") {
        const next = p.get("entity") === "Q6602" ? "Q12527" : "Q15104";
        return { claims: { P131: [{ mainsnak: { datavalue: { value: { id: next } } } }] } };
      }
      if (u.host === "www.wikidata.org") {
        return { entities: { Q6602: { sitelinks: { enwikivoyage: { title: "Avignon" } } }, Q12527: { sitelinks: { enwiki: { title: "Vaucluse" } } }, Q15104: { sitelinks: { enwiki: { title: "Provence-Alpes-Cote d'Azur" }, enwikivoyage: { title: "Provence" } } } } };
      }
      if (u.host === "en.wikipedia.org") return { query: { pages: p.get("exintro") ? [{ title: "Vaucluse", extract: "Lavender grows here." }, { title: "Provence-Alpes-Cote d'Azur", extract: "Olives." }] : [{ title: "Avignon", extract: "A city on the Rhone with a papal palace." }] } };
      return { query: { pages: [{ title: "x", extract: p.get("exintro") ? "Provence is known for lavender and cicadas." : "Avignon voyage text about the festival." }] } };
    };
    return { get, urls };
  }

  it("reads the city and its regions, one request after another, and keeps only normalized text", async () => {
    const f = fake();
    const r = await fetchPlaceText(city, f.get);
    expect(r.requests).toBe(f.urls.length);
    expect(r.requests).toBeLessThanOrEqual(9);
    expect(r.titles).toEqual(["Wikipedia:Avignon", "Wikivoyage:x", "Wikipedia:Vaucluse", "Wikipedia:Provence-Alpes-Cote d'Azur", "Wikivoyage:x"]);
    expect(mentions(r.text, "lavender")).toBe(true);
    expect(mentions(r.text, "papal palace")).toBe(true);
    expect(r.text).toBe(r.text.toLowerCase());
    expect(f.urls.every((u) => ["en.wikipedia.org", "en.wikivoyage.org", "www.wikidata.org"].includes(new URL(u).host))).toBe(true);
  });

  it("does not read a country's article as a region of the city", async () => {
    const get = async (url: string): Promise<unknown> => {
      const u = new URL(url);
      if (u.host === "en.wikipedia.org" && u.searchParams.get("prop") === "coordinates|pageprops") return wp({ title: "Avignon", coordinates: [{ lat: 43.95, lon: 4.81 }], pageprops: { wikibase_item: "Q1" } });
      if (u.host === "www.wikidata.org" && u.searchParams.get("action") === "wbgetclaims") return { claims: { P131: [{ mainsnak: { datavalue: { value: { id: "Q2" } } } }] } };
      if (u.host === "www.wikidata.org") return { entities: { Q1: { sitelinks: {} }, Q2: { sitelinks: { enwiki: { title: "France" } } } } };
      return { query: { pages: [{ title: "Avignon", extract: "Town." }] } };
    };
    const r = await fetchPlaceText(city, get);
    expect(r.titles).toEqual(["Wikipedia:Avignon"]);
  });

  it("keeps the text it has when a later step fails, and returns none when the city's article is not found", async () => {
    const r = await fetchPlaceText(city, fake({ fail: (u) => u.includes("wikidata") }).get);
    expect(r.titles).toEqual(["Wikipedia:Avignon"]);
    expect(r.text).toContain(" papal palace ");
    const none = await fetchPlaceText(city, async () => {
      throw new Error("down");
    });
    expect(none.text).toBe("");
  });

  it("looks near the city when the name is ambiguous", async () => {
    const urls: string[] = [];
    const get = async (url: string): Promise<unknown> => {
      urls.push(url);
      const p = new URL(url).searchParams;
      if (p.get("prop") === "coordinates|pageprops") return { query: { pages: [{ title: "Avignon (disambiguation)", pageprops: { disambiguation: "" } }] } };
      if (p.get("list") === "geosearch") return { query: { geosearch: [{ title: "Palais des Papes", type: "landmark" }, { title: "Avignon", type: "city" }] } };
      if (p.get("prop") === "pageprops") return { query: { pages: [{ title: "Avignon", pageprops: { wikibase_item: "Q6602" } }] } };
      if (p.get("prop") === "extracts") return { query: { pages: [{ title: "Avignon", extract: "Fame." }] } };
      return { claims: {}, entities: {} };
    };
    const r = await fetchPlaceText(city, get);
    expect(r.titles).toContain("Wikipedia:Avignon");
  });
});
