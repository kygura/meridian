import { describe, it, expect, beforeAll } from "vitest";
import { loadCities, getCities, getCityById, searchCities } from "./cities";

beforeAll(() => loadCities());

describe("IATA assignment is country-aware", () => {
  it("Los Angeles, United States → LAX", () => {
    expect(getCityById("los-angeles-united-states")?.iata).toBe("LAX");
  });
  it("Los Angeles, Chile does NOT get LAX", () => {
    const cl = getCityById("los-angeles-chile");
    expect(cl).toBeDefined();
    expect(cl?.iata).not.toBe("LAX");
  });
  it("Las Palmas → LPA", () => {
    expect(getCityById("las-palmas-spain")?.iata).toBe("LPA");
  });
});

describe("airport-only cities are synthesized", () => {
  it("Penang is searchable and has PEN", () => {
    const hits = searchCities("penang");
    expect(hits.some((c) => c.iata === "PEN")).toBe(true);
  });
});

describe("hub / capital flags", () => {
  it("London is a large hub and a capital", () => {
    const london = getCities().find(
      (c) => c.name === "London" && c.country === "United Kingdom"
    );
    expect(london?.hub).toBe("large");
    expect(london?.capital).toBe(true);
  });
});

describe("country search returns that country's airports, ranked", () => {
  it("searching 'Spain' puts the capital first and airport cities on top", () => {
    const hits = searchCities("Spain");
    expect(hits.length).toBeGreaterThan(3);
    expect(hits[0].name).toBe("Madrid");
    // every result in the top 10 belongs to Spain and has an airport
    for (const c of hits.slice(0, 10)) {
      expect(c.country).toBe("Spain");
      expect(c.iata).toBeTruthy();
    }
  });
});

describe("native names", () => {
  it("attaches each city's own-language name from data/native-names.json", async () => {
    const { loadCities, getCityById } = await import("./cities.js");
    loadCities();
    expect(getCityById("tokyo-japan")?.nativeName).toBe("東京");
    expect(getCityById("moscow-russia")?.nativeName).toBe("Москва");
    expect(getCityById("cairo-egypt")?.nativeName).toBe("القاهرة");
    expect(getCityById("paris-france")?.nativeName).toBeUndefined(); // same as English
  });
});
