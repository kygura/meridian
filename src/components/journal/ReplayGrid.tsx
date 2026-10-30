import { useMemo } from "react";
import HeatmapGrid from "../seasonality/HeatmapGrid";
import type { RenderRow } from "../seasonality/HeatRow";
import { buildReplayRows, colToMonth, matchWord, monthToCol, points, replayMarks, type ReplayRowModel } from "../../lib/replayGrid";
import type { City, ReplayResponse } from "../../types";
import ReplayTooltip from "./ReplayTooltip";

const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Thin adapter: ReplayResponse -> RenderRow[] for the shared heatmap (DESIGN-journal §7.3, §7.4). */
export default function ReplayGrid({
  resp,
  cityById,
  templateMonth,
  targetMonth,
  selectedCityId,
  hoverCityId,
  onSelect,
  onGoto,
}: {
  resp: ReplayResponse;
  cityById: Map<string, City>;
  /** 1-based; the template's own month, before the bend. */
  templateMonth?: number;
  /** 1-based; the month the template is bent to (omit when not bent or any-month). */
  targetMonth?: number;
  selectedCityId: string | null;
  hoverCityId: string | null;
  /** `month` (1-based) is set for cell clicks, absent for the row gutter. */
  onSelect: (cityId: string, month?: number) => void;
  onGoto: (cityId: string) => void;
}) {
  const models = useMemo(() => buildReplayRows(resp), [resp]);
  const byCity = useMemo(() => new Map(models.map((m) => [m.cityId, m])), [models]);
  const tplCol = templateMonth ? monthToCol(templateMonth) : -1;
  const naTitle = resp.grid ? "NOT SCORABLE" : "NOT IN TOP 30";

  const rows: RenderRow[] = useMemo(
    () =>
      models.map((m: ReplayRowModel) => {
        const c = cityById.get(m.cityId);
        const name = c?.name ?? m.cityId;
        return {
          key: m.cityId,
          kind: "city",
          cityId: m.cityId,
          label: name,
          country: c?.country,
          iata: c?.iata,
          badge: m.best.visitedBefore ? "VISITED" : "NEW",
          removable: false,
          months: m.cells.map((cell) => (cell ? { score: cell.match } : null)),
          bestWindow: false,
          cellMeta: m.cells.map((cell, col) => ({
            template: col === tplCol,
            eventTitles: cell?.events.map((e) => e.title),
            naTitle,
            muted: !!cell && !cell.result,
          })),
          trail: { label: `#${m.rank}`, score: points(m.best.match) },
          cellLabel: (col, mm) =>
            !mm
              ? `${name}, ${MONTH_LONG[col]}: not ranked`
              : m.cells[col]?.result
                ? `${name}, ${MONTH_LONG[col]}: match ${mm.score}, ${matchWord(mm.score).toLowerCase()}`
                : `${name}, ${MONTH_LONG[col]}: climate score ${mm.score}, not ranked`,
          active: m.cityId === selectedCityId,
          highlight: m.cityId === hoverCityId,
        };
      }),
    [models, cityById, tplCol, naTitle, selectedCityId, hoverCityId]
  );

  const marks = useMemo(() => replayMarks(templateMonth, targetMonth), [templateMonth, targetMonth]);
  const fromIata = resp.fromCityId ? cityById.get(resp.fromCityId)?.iata : undefined;

  return (
    <HeatmapGrid
      regionRows={[]}
      cityRows={rows}
      regionsLabel=""
      autoFocusCityId={null}
      ariaLabel="Replay results calendar"
      gutterHeader="CITY"
      trailHeader="MATCH"
      markedCols={marks}
      onSelect={(row, col) => row.cityId && onSelect(row.cityId, col === undefined ? undefined : colToMonth(col))}
      onGoto={(row) => row.cityId && onGoto(row.cityId)}
      onRemove={() => {}}
      renderTooltip={(row, col, anchor) => {
        const model = row.cityId ? byCity.get(row.cityId) : undefined;
        return model ? <ReplayTooltip anchor={anchor} row={model} col={col} name={row.label} fromIata={fromIata} /> : null;
      }}
      describeCell={(row, col) => {
        const cell = byCity.get(row.cityId ?? "")?.cells[col];
        if (!cell) return `${row.label}, ${MONTH_LONG[col]}: not ranked`;
        const ev = cell.events.length ? `, event ${cell.events.map((e) => e.title).join(", ")}` : "";
        if (!cell.result) return `${row.label}, ${MONTH_LONG[col]}: climate score ${cell.match}, not ranked`;
        return `${row.label}, ${MONTH_LONG[col]}: match ${cell.match}, ${matchWord(cell.match).toLowerCase()}${ev}`;
      }}
    />
  );
}
