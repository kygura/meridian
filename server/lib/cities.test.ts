import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AIRPORT_HOME_KM,
  assignAirportHomes,
  cityForIata,
  loadCities,
  getCities,
  getCityById,
  pickAirport,
  searchCities,
} from "./cities";
import { haversineKm } from "../../src/lib/geo";

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

describe("airport assignment rule", () => {
  // Coordinates from data/airports.json and data/worldcities.csv.
  const cmb = { iata: "CMB", name: "Bandaranaike International Colombo Airport", city: "Colombo", country: "Sri Lanka", lat: 7.1808, lng: 79.8841, size: "large" as const, runwayM: 3350 };
  const rml = { iata: "RML", name: "Colombo Ratmalana International Airport", city: "Colombo", country: "Sri Lanka", lat: 6.8216, lng: 79.8859, size: "large" as const, runwayM: 1833 };
  const colombo = { id: "colombo-sri-lanka", name: "Colombo", lat: 6.932, lng: 79.8578, population: 217000 };
  const kandy = { id: "kandy-sri-lanka", name: "Kandy", lat: 7.28, lng: 80.67, population: 111701 };

  it("a city named on two airports flies from the one that takes wide-body jets, not the nearer one", () => {
    expect(pickAirport(colombo, [rml, cmb], 100)?.iata).toBe("CMB");
    // Without runway data the nearer one wins, as before.
    expect(pickAirport(colombo, [{ ...rml, runwayM: undefined }, { ...cmb, runwayM: undefined }], 100)?.iata).toBe("RML");
  });

  it("a city with no airport of its own still flies from the nearest suitable one", () => {
    expect(pickAirport(kandy, [rml, cmb], 100)?.iata).toBe("CMB");
  });

  it("an airport belongs to a city within AIRPORT_HOME_KM, never to a far city that flies from it", () => {
    const homes = assignAirportHomes([{ ...kandy, iata: "CMB" }, { ...colombo, iata: "RML" }], [cmb, rml]);
    // Colombo shares CMB's municipality name and is 27 km away, so it is CMB's home though it flies from RML.
    expect(homes.get("CMB")).toBe("colombo-sri-lanka");
    expect(homes.get("RML")).toBe("colombo-sri-lanka");
    // Kandy alone, 87 km away: no home.
    expect(assignAirportHomes([{ ...kandy, iata: "CMB" }], [cmb]).has("CMB")).toBe(false);
  });

  it("skips cities whose id is not unique", () => {
    const pwm = { iata: "PWM", name: "Portland International Jetport", city: "Portland", country: "United States", lat: 43.6462, lng: -70.3093, size: "large" as const };
    const maine = { id: "portland-united-states", name: "Portland", lat: 43.6773, lng: -70.2715, population: 206023, iata: "PWM" };
    const oregon = { id: "portland-united-states", name: "Portland", lat: 45.5372, lng: -122.65, population: 2052796, iata: "PDX" };
    expect(assignAirportHomes([oregon, maine], [pwm]).has("PWM")).toBe(false);
  });
});

describe("airport assignment in the shipped data", () => {
  const airports = JSON.parse(readFileSync(join(process.cwd(), "data/airports.json"), "utf-8")) as Array<{ iata: string; lat: number; lng: number }>;

  it("Colombo flies from CMB and CMB resolves to Colombo; Kandy still flies from CMB", () => {
    expect(getCityById("colombo-sri-lanka")?.iata).toBe("CMB");
    expect(cityForIata("CMB")?.id).toBe("colombo-sri-lanka");
    expect(cityForIata("cmb")?.id).toBe("colombo-sri-lanka");
    expect(getCityById("kandy-sri-lanka")?.iata).toBe("CMB");
  });

  it("every airport code resolves to a city within AIRPORT_HOME_KM of the airport", () => {
    const far = airports.flatMap((a) => {
      const c = cityForIata(a.iata);
      const km = c ? haversineKm([c.lng, c.lat], [a.lng, a.lat]) : Infinity;
      return km > AIRPORT_HOME_KM ? [`${a.iata} → ${c?.id ?? "none"} (${Math.round(km)} km)`] : [];
    });
    expect(far).toEqual([]);
  });

  it("an airport named after a city resolves to it even when the city flies from another (VKO → Moscow)", () => {
    expect(cityForIata("VKO")?.id).toBe("moscow-russia");
    expect(cityForIata("LGW")?.id).toBe("london-united-kingdom");
  });

  it("a same-named city elsewhere does not capture an airport (PWM is in Maine, not Oregon)", () => {
    const c = cityForIata("PWM")!;
    expect(c.id).toBe("portland-pwm-united-states");
    expect(getCityById(c.id)).toBe(c);
  });
});
