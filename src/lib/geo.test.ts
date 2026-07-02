import { describe, it, expect } from "vitest";
import {
  haversineKm,
  greatCirclePoints,
  flightPath,
  estimateFlightHours,
  formatHours,
  estimateLegCostUSD,
  MAX_NONSTOP_KM,
} from "./geo";

const AKL: [number, number] = [174.763, -36.8481];
const HNL: [number, number] = [-157.846, 21.3294];
const LHR: [number, number] = [-0.4543, 51.47];
const LAX: [number, number] = [-118.4085, 33.9416];
const SIN: [number, number] = [103.9915, 1.3644];
const DXB: [number, number] = [55.3644, 25.2532];

describe("haversineKm", () => {
  it("AKL→HNL ≈ 7060 km", () => {
    const d = haversineKm(AKL, HNL);
    expect(d).toBeGreaterThan(6900);
    expect(d).toBeLessThan(7300);
  });
});

describe("greatCirclePoints (antimeridian)", () => {
  it("never jumps more than 180° in longitude between consecutive points", () => {
    const pts = greatCirclePoints(AKL, HNL);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThan(180);
    }
  });
  it("starts at a and ends at b (mod 360)", () => {
    const pts = greatCirclePoints(AKL, HNL);
    expect(pts[0][0]).toBeCloseTo(AKL[0], 3);
    const endLngMod = ((pts[pts.length - 1][0] % 360) + 540) % 360 - 180;
    expect(endLngMod).toBeCloseTo(HNL[0], 3);
    expect(pts[pts.length - 1][1]).toBeCloseTo(HNL[1], 3);
  });
});

describe("flightPath", () => {
  const hubs = [
    { coord: LAX, label: "LAX" },
    { coord: SIN, label: "SIN" },
    { coord: DXB, label: "DXB" },
  ];
  it("short leg is a single segment with no via", () => {
    const p = flightPath(AKL, HNL, hubs);
    expect(p.segments).toHaveLength(1);
    expect(p.via).toBeUndefined();
  });
  it("near-antipodal AKL→LHR routes via a hub, both legs flyable", () => {
    const p = flightPath(AKL, LHR, hubs);
    expect(p.segments).toHaveLength(2);
    expect(p.via).toBeDefined();
    // both legs within nonstop range
    for (const seg of p.segments) {
      const d = haversineKm(seg[0], seg[seg.length - 1]);
      expect(d).toBeLessThanOrEqual(MAX_NONSTOP_KM);
    }
  });
  it("falls back to direct when no hub helps", () => {
    const p = flightPath(AKL, LHR, []);
    expect(p.segments).toHaveLength(1);
  });
});

describe("estimates", () => {
  it("cruise math: ~830 km/h + overhead", () => {
    expect(estimateFlightHours(8300)).toBeGreaterThan(10);
    expect(estimateFlightHours(8300)).toBeLessThan(12);
  });
  it("formatHours", () => {
    expect(formatHours(13.33)).toBe("13h 20m");
    expect(formatHours(0.5)).toBe("0h 30m");
  });
  it("leg cost grows with distance", () => {
    expect(estimateLegCostUSD(1000)).toBeGreaterThan(100);
    expect(estimateLegCostUSD(10000)).toBeGreaterThan(estimateLegCostUSD(1000));
  });
});
