import { describe, it, expect, beforeAll } from "vitest";
import { getCities, loadCities } from "../cities";
import { bindingsOf, cityIndexFor, tagOf } from "./common";
import {
  applyFestivityExclusions,
  buildEclipses,
  buildFestivities,
  buildNational,
  eclipsesQuery,
  EXCLUDED_FESTIVAL_CLASSES,
  excludedQids,
  festivitiesQuery,
  festivityExclusionQuery,
  isNationalFestivity,
  assignNationalCountries,
  lunarEclipsesQuery,
  nationalFestivitiesQuery,
  parseEclipses,
  parseFestivities,
  parseNational,
} from "./wikidata";
import { fixtureJson } from "../__fixtures__/liveEvents";

const fx = (name: string) => bindingsOf(fixtureJson(`events/${name}`));
const NOW = new Date("2026-11-18T12:00:00Z");

beforeAll(() => loadCities());

describe("festivities query", () => {
  it("asks for festivals by month and leaves out film, music, theatre, arts, books, comics, pride and conferences", () => {
    const q = festivitiesQuery();
    expect(q).toContain("wd:Q132241");
    for (const qid of ["Q220505", "Q868557", "Q1751626", "Q4801521", "Q23902005", "Q129598636", "Q114834437"]) expect(q).toContain(`wd:${qid}`);
    expect(q).toContain("wdt:P2922");
    expect(q).toContain("?sl >= 5");
    // Sport is excluded per item in the second query, not here, to keep the first one fast.
    expect(q).not.toContain("wd:Q16510064");
  });

  it("checks the candidates against the same classes plus sport", () => {
    const q = festivityExclusionQuery(["Q1", "Q2"]);
    expect(q).toContain("VALUES ?e { wd:Q1 wd:Q2 }");
    for (const qid of EXCLUDED_FESTIVAL_CLASSES) expect(q).toContain(`wd:${qid}`);
    expect(EXCLUDED_FESTIVAL_CLASSES).toEqual(expect.arrayContaining(["Q16510064", "Q40244"]));
  });
});

describe("festivities (recorded Wikidata response)", () => {
  const raws = parseFestivities(fx("wikidata-festivities.json"));

  it("merges the rows of one item into one entry with its months in calendar order", () => {
    expect(raws.filter((r) => r.title === "Oktoberfest")).toHaveLength(1);
    expect(raws.find((r) => r.title === "Oktoberfest")!.months).toEqual([9, 10]);
    expect(raws.find((r) => r.title === "Kwafie Festival")!.months).toEqual([1, 10, 11]);
  });

  it("skips a row whose month is not a month item (Metageitnia)", () => {
    expect(raws.some((r) => r.title === "Metageitnia")).toBe(false);
  });

  it("drops what the exclusion query names and what the title or type names film, music, pride or a race", () => {
    const excluded = excludedQids(fx("wikidata-festivity-exclusions.json"));
    expect([...excluded].sort()).toHaveLength(4);
    const kept = applyFestivityExclusions(raws, excluded).map((r) => r.title);
    for (const gone of ["Kiel Week", "Festival Interceltique de Lorient", "L.A. Outfest", "Edinburgh Marathon", "Küstendorf Film and Music Festival", "West Pride"]) expect(kept).not.toContain(gone);
    for (const stays of ["Oktoberfest", "Sapporo Snow Festival", "Gion Matsuri", "Calgary Stampede", "Aalst Carnival", "Historical Carnival of Ivrea", "Boryeong Mud Festival", "Feast of San Gennaro"]) expect(kept).toContain(stays);
  });

  it("places each festival on the nearest city, one event per item, with months for a multi-month festival", () => {
    const kept = applyFestivityExclusions(raws, excludedQids(fx("wikidata-festivity-exclusions.json")));
    const built = buildFestivities("festivities", kept, cityIndexFor(getCities()));
    const okt = built.events.find((e) => e.id === "wd-Q102400")!;
    expect(okt).toMatchObject({ title: "Oktoberfest", kind: "festival", cityIds: ["munich-germany"], month: 9, months: [9, 10], recurring: true, source: "wikidata", feed: "festivities" });
    expect(okt.sourceUrl).toBe("https://www.wikidata.org/wiki/Q102400");
    expect(okt.tags).toEqual(["festival", "folk-festival"]);
    const sapporo = built.events.find((e) => e.title === "Sapporo Snow Festival")!;
    expect(sapporo.months).toBeUndefined();
    expect(sapporo).toMatchObject({ month: 2, cityIds: ["sapporo-japan"] });
    expect(new Set(built.events.map((e) => e.id)).size).toBe(built.events.length);
    expect(built.events.every((e) => e.kind === "festival")).toBe(true);
  });

  it("counts festivals no city lies near as unmatched", () => {
    const kept = applyFestivityExclusions(raws, excludedQids(fx("wikidata-festivity-exclusions.json")));
    const built = buildFestivities("festivities", kept, cityIndexFor(getCities()));
    expect(built.unmatched).toBe(2);
    expect(built.events).toHaveLength(kept.length - 2);
  });

  it("drops ancient festivals: one with an end date is skipped at parse time", () => {
    const rows = fx("wikidata-festivities.json").map((b) => (b.eLabel!.value === "Oktoberfest" ? { ...b, ended: { type: "literal", value: "0100-01-01T00:00:00Z" } } : b));
    expect(parseFestivities(rows).some((r) => r.title === "Oktoberfest")).toBe(false);
    expect(parseFestivities(rows).some((r) => r.title === "Gion Matsuri")).toBe(true);
  });
});

describe("tag normalisation", () => {
  it("normalizes type labels to kebab tags", () => {
    expect(tagOf("Burgundian carnival")).toBe("burgundian-carnival");
    expect(tagOf("annual film festival")).toBe("film-festival");
    expect(tagOf("goryō-e")).toBe("goryo-e");
  });
});

describe("national festivities query", () => {
  it("wants a country, a recurrence (month or day in the year), at least 20 sitelinks and no single location", () => {
    const q = nationalFestivitiesQuery();
    expect(q).toContain("wdt:P17");
    expect(q).toContain("wdt:P837");
    expect(q).toContain("wdt:P2922");
    expect(q).toContain("?sl >= 20");
    expect(q).toContain("FILTER NOT EXISTS { ?e wdt:P625 ?pt }");
    expect(q).toContain("FILTER NOT EXISTS { ?country wdt:P576 ?countryEnd }");
    // Variant ties only: "part of" (P361) and "based on" (P144) would move Durga Puja off India.
    expect(q).toContain("wdt:P279|wdt:P460|wdt:P1889 ?rel");
    expect(q).not.toContain("P361");
  });
});

describe("national festivities (recorded Wikidata response)", () => {
  const raws = parseNational(fx("wikidata-national.json"));
  const kept = raws.filter(isNationalFestivity);
  const titles = kept.map((r) => r.title);

  it("keeps festivals and holidays travellers plan around", () => {
    for (const t of ["Diwali", "Songkran", "Chinese New Year", "Day of the Dead", "Navratri", "Qixi Festival", "Naadam", "Tết"]) expect(titles).toContain(t);
  });

  it("drops observances, races, prizes and independence days", () => {
    for (const t of ["Memorial Day", "Programmer's Day", "Singles' Day", "Tour de France", "Independence Day", "Independence Day of Pakistan"]) expect(titles).not.toContain(t);
  });

  it("drops religious holy days that are not also festivals (Marian feasts, saints' days)", () => {
    const annunciation = {
      qid: "Q4087807",
      title: "Feast of the Annunciation",
      countries: ["Serbia", "Russia", "Bulgaria", "Belarus", "Poland", "Ukraine", "North Macedonia"],
      types: ["religious holiday", "holiday", "Marian feast days", "Christian holy day"],
      sitelinks: 60,
      countryCount: 7,
      whens: ["March 25"],
    };
    expect(isNationalFestivity(annunciation)).toBe(false);
    expect(isNationalFestivity({ ...annunciation, title: "St John's Feast", types: ["feast day", "holiday"] })).toBe(false);
    // A religious holiday that Wikidata also classes as a festival stays.
    expect(isNationalFestivity({ ...annunciation, title: "Rama Navami", types: ["festival", "public holiday", "religious holiday"] })).toBe(true);
    expect(titles).not.toContain("Feast of the Annunciation");
  });

  it("gives a country its own version of a festival: Tanabata, not Qixi, in Japan", () => {
    const base = { sitelinks: 50, whens: ["July"] };
    const qixi = { ...base, qid: "Q13423122", title: "Qixi Festival", countries: ["People's Republic of China", "Japan"], countryCount: 2, types: ["festival"], rels: ["Q1193996x", "Q906486"] };
    const tanabata = { ...base, qid: "Q1193996", title: "Tanabata", countries: ["Japan"], countryCount: 1, types: ["Japanese festival"], rels: ["Q906486"] };
    const diwali = { ...base, qid: "Q10259", title: "Diwali", countries: ["India", "Nepal"], countryCount: 2, types: ["festival"], rels: [] };
    const tihar = { ...base, qid: "Q1066870", title: "Tihar", countries: ["Nepal"], countryCount: 1, types: ["festival"], rels: [] };
    const out = assignNationalCountries([qixi, tanabata, diwali, tihar]);
    expect(out.raws.find((r) => r.title === "Qixi Festival")!.countries).toEqual(["People's Republic of China"]);
    expect(out.raws.find((r) => r.title === "Tanabata")!.countries).toEqual(["Japan"]);
    // Not tied in Wikidata: both stay where Wikidata puts them.
    expect(out.raws.find((r) => r.title === "Diwali")!.countries).toEqual(["India", "Nepal"]);
    expect(out.moved).toBe(1);
    // Tied directly (one names the other) also counts.
    const direct = assignNationalCountries([{ ...qixi, rels: ["Q1193996"] }, { ...tanabata, rels: [] }]);
    expect(direct.raws.find((r) => r.title === "Qixi Festival")!.countries).toEqual(["People's Republic of China"]);
  });

  it("drops festivals celebrated in more than twelve countries (not location-specific)", () => {
    const nowruz = raws.find((r) => r.title === "Nowruz")!;
    expect(nowruz.countryCount).toBeGreaterThan(12);
    expect(raws.find((r) => r.title === "Diwali")!.countryCount).toBe(11);
    expect(titles).not.toContain("Nowruz");
    expect(isNationalFestivity({ ...raws.find((r) => r.title === "Songkran")!, countryCount: 13 })).toBe(false);
    expect(isNationalFestivity({ ...raws.find((r) => r.title === "Songkran")!, countryCount: 0 })).toBe(false);
  });

  it("places a fixed-date festival on the capital and the biggest airport cities of its country, as recurring months", () => {
    const built = buildNational("national-festivities", kept, cityIndexFor(getCities()), NOW);
    const songkran = built.events.find((e) => e.title === "Songkran")!;
    expect(songkran).toMatchObject({ month: 4, recurring: true, kind: "festival", tags: expect.arrayContaining(["festival", "country-wide"]) });
    expect(songkran.cityIds).toHaveLength(4);
    expect(songkran.cityIds[0]).toBe("bangkok-thailand");
    expect(songkran.date).toBeUndefined();
    const dead = built.events.find((e) => e.title === "Day of the Dead")!;
    expect(dead).toMatchObject({ month: 11, cityIds: expect.arrayContaining(["mexico-city-mexico"]) });
  });

  it("does not put neighbouring cities twice (New Delhi and Delhi)", () => {
    const built = buildNational("national-festivities", kept, cityIndexFor(getCities()), NOW);
    const navratri = built.events.find((e) => e.title === "Navratri")!;
    expect(navratri.cityIds.filter((id) => id === "new-delhi-india" || id === "delhi-india")).toHaveLength(1);
  });

  it("places a Hindu lunar festival in an approximate month and says so", () => {
    const built = buildNational("national-festivities", kept, cityIndexFor(getCities()), NOW);
    const holi = built.events.find((e) => e.title === "Holii")!;
    expect(holi).toMatchObject({ month: 3, recurring: true });
    expect(holi.note).toMatch(/approximate/);
    const navratri = built.events.find((e) => e.title === "Navratri")!;
    expect(navratri.month).toBe(10);
  });

  it("turns a Chinese-calendar festival into dated events inside the next 18 months", () => {
    const built = buildNational("national-festivities", kept, cityIndexFor(getCities()), NOW);
    const cny = built.events.filter((e) => e.title === "Chinese New Year");
    expect(cny.map((e) => e.date)).toEqual(["2027-02-07", "2028-01-26"]);
    expect(cny.every((e) => !e.recurring && e.month >= 1 && e.month <= 2)).toBe(true);
    expect(cny[0]!.id).toBe("wd-Q131772-2027-02-07");
    const duanwu = built.events.filter((e) => e.title === "Duanwu Festival");
    expect(duanwu.map((e) => e.date)).toEqual(["2027-06-09"]);
    expect(built.events.filter((e) => e.title === "Tết").map((e) => e.date)).toEqual(["2027-02-07", "2028-01-26"]);
  });

  it("counts festivals it cannot date (Easter-relative, Thai lunar) and festivals in no known country", () => {
    const built = buildNational("national-festivities", kept, cityIndexFor(getCities()), NOW);
    expect(built.undated).toBe(2);
    expect(built.unmatched).toBe(1); // Eid al-Fitr: "worldwide"
    expect(built.events.some((e) => e.title === "Mardi Gras" || e.title === "Loi Krathong")).toBe(false);
  });
});

describe("eclipses (recorded Wikidata response)", () => {
  const raws = parseEclipses(fx("wikidata-eclipses.json"));

  it("skips partial eclipses", () => {
    expect(raws).toHaveLength(4);
    expect(raws.some((r) => r.title.includes("2029"))).toBe(false);
  });

  it("places a solar eclipse on its greatest-eclipse points and on each listed country's hub city", () => {
    const built = buildEclipses("eclipses", raws, cityIndexFor(getCities()), false);
    const aug = built.events.find((e) => e.date === "2027-08-02")!;
    expect(aug).toMatchObject({ kind: "eclipse", tags: ["eclipse", "solar-eclipse", "total-solar-eclipse"], recurring: false });
    expect(aug.cityIds).toContain("luxor-egypt");
    expect(aug.cityIds).toContain("cairo-egypt");
    expect(built.events.find((e) => e.date === "2028-07-22")!.cityIds).toEqual(["canberra-australia"]);
  });

  it("keeps an eclipse with no city (annular, over the ocean) and counts it", () => {
    const built = buildEclipses("eclipses", raws, cityIndexFor(getCities()), false);
    expect(built.unplaced).toBe(2);
    expect(built.events.filter((e) => e.cityIds.length === 0).map((e) => e.date)).toEqual(["2027-02-06", "2028-01-26"]);
  });

  it("builds the solar query for 30 months and the lunar query for 36, total lunar eclipses only", () => {
    expect(eclipsesQuery(NOW)).toContain('"2029-05-18T00:00:00Z"');
    expect(lunarEclipsesQuery(NOW)).toContain("wd:Q19693318");
    expect(lunarEclipsesQuery(NOW)).toContain('"2029-11-18T00:00:00Z"');
  });

  it("makes a total lunar eclipse a sky event with no city when Wikidata lists no country", () => {
    const lunar = parseEclipses(fx("wikidata-lunar-eclipses.json"));
    expect(lunar).toHaveLength(1);
    const built = buildEclipses("eclipses", lunar, cityIndexFor(getCities()), true);
    expect(built.events[0]).toMatchObject({ title: "June 2029 lunar eclipse", kind: "sky", month: 6, date: "2029-06-26", cityIds: [], tags: ["eclipse", "lunar-eclipse", "total-lunar-eclipse"] });
    expect(built.unplaced).toBe(1);
  });

  it("places a lunar eclipse on the hub city of a listed country", () => {
    const rows = fx("wikidata-lunar-eclipses.json").map((b) => ({ ...b, countries: { type: "literal", value: "Chile|Japan" } }));
    const built = buildEclipses("eclipses", parseEclipses(rows), cityIndexFor(getCities()), true);
    expect(built.events[0]!.cityIds).toHaveLength(2);
    expect(built.unplaced).toBe(0);
  });
});
