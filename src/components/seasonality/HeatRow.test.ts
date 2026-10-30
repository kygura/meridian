import { describe, it, expect } from "vitest";
import { rowWindow, type RenderRow } from "./HeatRow";

const row = (over: Partial<RenderRow> = {}): RenderRow => ({
  key: "c",
  kind: "city",
  label: "C",
  badge: "TRIP",
  removable: false,
  months: Array.from({ length: 12 }, (_, i) => ({ score: i < 3 ? 80 : 20 })),
  ...over,
});

describe("rowWindow (optional replay props)", () => {
  it("is unchanged by default: a best window is found", () => {
    expect(rowWindow(row())).not.toBeNull();
  });
  it("bestWindow:false skips the window (replay)", () => {
    expect(rowWindow(row({ bestWindow: false }))).toBeNull();
  });
  it("tolerates null months (replay na cells)", () => {
    const months = row().months as { score: number }[];
    expect(rowWindow(row({ months: [null, ...months.slice(1)] }))).not.toBeNull();
  });
  it("still null for non-array months", () => {
    expect(rowWindow(row({ months: "loading" }))).toBeNull();
  });
});
