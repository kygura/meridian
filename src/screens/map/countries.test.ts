import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// The land layer must hold the islands people travel to. At 1:110m it didn't: the Canaries,
// Madeira, Malta and others were cities on open sea.

type Ring = [number, number][];
const fc = JSON.parse(readFileSync(join(process.cwd(), "public/geo/countries.json"), "utf8")) as {
  features: { properties: Record<string, string>; geometry: { coordinates: Ring[][] } }[];
};

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The country whose land is at (or within ~5 km of) a point, if any. */
function landAt(lat: number, lng: number): string | undefined {
  for (const [dx, dy] of [[0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]]) {
    for (const f of fc.features)
      for (const poly of f.geometry.coordinates)
        if (inRing(lng + dx, lat + dy, poly[0]) && !poly.slice(1).some((h) => inRing(lng + dx, lat + dy, h))) return f.properties.admin;
  }
  return undefined;
}

describe("country polygons", () => {
  it.each([
    ["Las Palmas", 28.1, -15.43, "Spain"],
    ["Santa Cruz de Tenerife", 28.47, -16.25, "Spain"],
    ["Arrecife", 28.96, -13.55, "Spain"],
    ["Palma", 39.57, 2.65, "Spain"],
    ["Funchal", 32.65, -16.88, "Portugal"],
    ["Ponta Delgada", 37.75, -25.67, "Portugal"],
    ["Valletta", 35.9, 14.51, "Malta"],
    ["Port Louis", -20.17, 57.5, "Mauritius"],
    ["Saint-Denis, Réunion", -20.88, 55.45, "France"],
    ["Manama", 26.24, 50.58, "Bahrain"],
    ["Malé", 4.17, 73.51, "Maldives"],
    ["Bridgetown", 13.1, -59.62, "Barbados"],
    ["Rhodes", 36.44, 28.22, "Greece"],
    ["Jeju", 33.51, 126.52, "South Korea"],
    ["Praia", 14.92, -23.52, "Cape Verde"],
    ["Lampedusa", 35.5, 12.6, "Italy"],
  ])("%s is on land", (_name, lat, lng, country) => {
    expect(landAt(lat, lng)).toBe(country);
  });

  it("keeps the properties the app joins on", () => {
    const spain = fc.features.find((f) => f.properties.admin === "Spain");
    expect(spain?.properties).toMatchObject({ name: "Spain", continent: "Europe", subregion: "Southern Europe" });
  });
});
