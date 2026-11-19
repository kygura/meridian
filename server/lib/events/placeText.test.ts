import { describe, it, expect } from "vitest";
import type { City } from "../../../src/types";
import { fetchExtract, pickCityPage, resolvePlace } from "./placeText";

const city = { id: "avignon-france", name: "Avignon", country: "France", lat: 43.95, lng: 4.81 } as unknown as City;
const wp = (extra: object) => ({ query: { pages: [extra] } });

describe("pickCityPage", () => {
  const page = (title: string, lat: number, lon: number, over: object = {}) => ({ title, coordinates: [{ lat, lon }], ...over });
  it("takes the nearest article within 50 km that is not a disambiguation page", () => {
    const pages = [page("Avignon (disambiguation)", 43.95, 4.81, { pageprops: { disambiguation: "" } }), page("Avignon", 43.949, 4.805), page("Avignon, Far", 10, 10), { title: "Missing", missing: true }];
    expect(pickCityPage(pages, city)?.title).toBe("Avignon");
    expect(pickCityPage([page("Washington", 47, -120)], { lat: 38.9, lng: -77 })).toBeUndefined();
  });
});

describe("resolvePlace", () => {
  function fake(over: { fail?: (url: string) => boolean } = {}) {
    const urls: string[] = [];
    const get = async (url: string): Promise<unknown> => {
      urls.push(url);
      if (over.fail?.(url)) throw new Error("429");
      const u = new URL(url);
      const p = u.searchParams;
      if (u.host === "en.wikipedia.org" && p.get("prop") === "coordinates|pageprops") return wp({ title: "Avignon", coordinates: [{ lat: 43.95, lon: 4.81 }], pageprops: { wikibase_item: "Q6602" } });
      if (p.get("action") === "wbgetclaims") return { claims: { P131: [{ mainsnak: { datavalue: { value: { id: p.get("entity") === "Q6602" ? "Q12527" : "Q15104" } } } }] } };
      return {
        entities: {
          Q6602: { sitelinks: { enwiki: { title: "Avignon" }, enwikivoyage: { title: "Avignon" } } },
          Q12527: { sitelinks: { enwiki: { title: "Vaucluse" } } },
          Q15104: { sitelinks: { enwiki: { title: "Provence-Alpes-Cote d'Azur" }, enwikivoyage: { title: "Provence" } } },
        },
      };
    };
    return { get, urls };
  }

  it("finds the city's articles, Wikidata item and the regions above it up the chain of located-in, in a handful of requests", async () => {
    const f = fake();
    const r = await resolvePlace(city, f.get);
    expect(r).toMatchObject({ cityWp: "Avignon", cityWv: "Avignon", qid: "Q6602" });
    expect(r.regions).toEqual([{ qid: "Q12527", wp: "Vaucluse" }, { qid: "Q15104", wp: "Provence-Alpes-Cote d'Azur", wv: "Provence" }]);
    expect(r.requests).toBe(f.urls.length);
    expect(r.requests).toBeLessThanOrEqual(6);
  });

  it("leaves out a former state: a located-in statement with an end time", async () => {
    const get = async (url: string): Promise<unknown> => {
      const u = new URL(url);
      if (u.host === "en.wikipedia.org") return wp({ title: "Avignon", coordinates: [{ lat: 43.95, lon: 4.81 }], pageprops: { wikibase_item: "Q1" } });
      if (u.searchParams.get("action") === "wbgetclaims")
        return u.searchParams.get("entity") === "Q1"
          ? { claims: { P131: [{ mainsnak: { datavalue: { value: { id: "Q9" } } }, qualifiers: { P582: [{}] } }, { mainsnak: { datavalue: { value: { id: "Q2" } } } }] } }
          : { claims: {} };
      return { entities: { Q1: { sitelinks: {} }, Q9: { sitelinks: { enwiki: { title: "Old Empire" } } }, Q2: { sitelinks: { enwiki: { title: "Vaucluse" } } } } };
    };
    expect((await resolvePlace(city, get)).regions).toEqual([{ qid: "Q2", wp: "Vaucluse" }]);
  });

  it("does not take a country's article for a region", async () => {
    const get = async (url: string): Promise<unknown> => {
      const u = new URL(url);
      if (u.host === "en.wikipedia.org") return wp({ title: "Avignon", coordinates: [{ lat: 43.95, lon: 4.81 }], pageprops: { wikibase_item: "Q1" } });
      if (u.searchParams.get("action") === "wbgetclaims") return { claims: { P131: [{ mainsnak: { datavalue: { value: { id: "Q2" } } } }] } };
      return { entities: { Q1: { sitelinks: {} }, Q2: { sitelinks: { enwiki: { title: "France" }, enwikivoyage: { title: "France" } } } } };
    };
    expect((await resolvePlace(city, get)).regions).toEqual([]);
  });

  it("keeps what it found when a later step fails, and finds nothing when the first fails", async () => {
    const r = await resolvePlace(city, fake({ fail: (u) => u.includes("wikidata") }).get);
    expect(r).toMatchObject({ cityWp: "Avignon", qid: "Q6602", regions: [] });
    const none = await resolvePlace(city, async () => {
      throw new Error("down");
    });
    expect(none).toMatchObject({ regions: [] });
    expect(none.cityWp).toBeUndefined();
  });

  it("looks near the city when the name is ambiguous", async () => {
    const get = async (url: string): Promise<unknown> => {
      const p = new URL(url).searchParams;
      if (p.get("prop") === "coordinates|pageprops") return { query: { pages: [{ title: "Avignon (disambiguation)", pageprops: { disambiguation: "" } }] } };
      if (p.get("list") === "geosearch") return { query: { geosearch: [{ title: "Palais des Papes", type: "landmark" }, { title: "Avignon", type: "city" }] } };
      if (p.get("prop") === "pageprops") return { query: { pages: [{ title: "Avignon", pageprops: { wikibase_item: "Q6602" } }] } };
      return { claims: {}, entities: {} };
    };
    expect((await resolvePlace(city, get)).cityWp).toBe("Avignon");
  });
});

describe("fetchExtract", () => {
  it("asks for the plain text of one article, with headings, and returns it", async () => {
    let seen = "";
    const text = await fetchExtract("wikivoyage", "Kyoto", async (url) => {
      seen = url;
      return wp({ title: "Kyoto", extract: "Lead.\n== Do ==\nGion." });
    });
    expect(text).toContain("== Do ==");
    const u = new URL(seen);
    expect(u.host).toBe("en.wikivoyage.org");
    expect(u.searchParams.get("explaintext")).toBe("1");
    expect(u.searchParams.get("titles")).toBe("Kyoto");
    expect(await fetchExtract("wikipedia", "X", async () => ({ query: { pages: [{ title: "X", missing: true }] } }))).toBe("");
  });
});
