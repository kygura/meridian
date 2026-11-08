import { describe, expect, it } from "vitest";
import type { City } from "../../types";
import { labelFeatures, labelText } from "./basemap";

const city = (name: string, nativeName?: string, extra: Partial<City> = {}): City => ({
  id: name.toLowerCase(),
  name,
  lat: 1,
  lng: 2,
  country: "X",
  population: 6_000_000, // rank 0, always labelled
  ...(nativeName ? { nativeName } : {}),
  ...extra,
});

describe("city label features", () => {
  it("carries the native name, and the 'extra' only when it says more than accents", () => {
    const [moscow, bogota, paris] = labelFeatures([city("Moscow", "Москва"), city("Bogota", "Bogotá"), city("Paris")]).features.map(
      (f) => f.properties
    );
    expect(moscow).toMatchObject({ name: "Moscow", native: "Москва", nativeExtra: "Москва" });
    expect(bogota).toMatchObject({ native: "Bogotá" });
    expect(bogota).not.toHaveProperty("nativeExtra");
    expect(paris).not.toHaveProperty("native");
  });

  it("skips cities too small to label", () => {
    expect(labelFeatures([city("Hamlet", undefined, { population: 1000 })]).features).toHaveLength(0);
  });
});

describe("label text per naming choice", () => {
  it("English is the name; native falls back to it", () => {
    expect(labelText("english")).toEqual(["get", "name"]);
    expect(labelText("native")).toEqual(["coalesce", ["get", "native"], ["get", "name"]]);
  });

  it("both stacks the native name over a smaller English one, only when they differ", () => {
    const expr = labelText("both") as unknown[];
    expect(expr[0]).toBe("case");
    expect(expr[1]).toEqual(["has", "nativeExtra"]);
    expect(JSON.stringify(expr[2])).toContain('"font-scale":0.8');
    expect(expr[3]).toEqual(["coalesce", ["get", "native"], ["get", "name"]]);
  });
});
