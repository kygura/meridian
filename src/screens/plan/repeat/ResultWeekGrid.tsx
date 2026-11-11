import { useMemo } from "react";
import { buildWeekRows, resultKey } from "../../../lib/replayGrid";
import { frameColumns } from "../../../lib/heatFrame";
import { DIM_WORDS, climateText, crowdText, matchWord, priceText, resultWhen, weekRangeLabel } from "../../../lib/repeatCopy";
import { Badge } from "../../../ui";
import type { City, ReplayResponse } from "../../../types";
import { HeatGrid, HeatLegend, PopRow, type HeatRow } from "../when/HeatGrid";

export interface ResultWeekGridProps {
  resp: ReplayResponse;
  cityById: Map<string, City>;
  /** 1-based week of the year the trip happened in. */
  templateWeek?: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const COLUMNS = frameColumns("weeks");

/**
 * Week-resolution view: each result city across 52 weeks. Cities with weekly climate show real
 * weekly scores; cities matched by month show their month's figure flat across its weeks.
 */
export function ResultWeekGrid({ resp, cityById, templateWeek, selectedKey, onSelect }: ResultWeekGridProps) {
  const models = useMemo(() => buildWeekRows(resp), [resp]);
  const byCity = useMemo(() => new Map(models.map((m) => [m.cityId, m])), [models]);

  const rows: HeatRow[] = models.map((m) => {
    const c = cityById.get(m.cityId);
    const name = c?.name ?? m.cityId;
    const hasWeekly = !!resp.weekGrid?.some((g) => g.cityId === m.cityId);
    return {
      key: m.cityId,
      label: name,
      sublabel: [c?.country, hasWeekly ? null : "by month"].filter(Boolean).join(" · "),
      onOpen: () => onSelect(resultKey(m.best)),
      openLabel: `Show ${name}, its best ${m.best.week !== undefined ? "week" : "month"}`,
      state: "ready",
      selected: !!selectedKey && selectedKey.startsWith(`${m.cityId}:`),
      cells: m.cells.map((cell, i) =>
        cell
          ? {
              score: cell.match,
              muted: !cell.result,
              ring: templateWeek === i + 1,
              dot: !!cell.result && selectedKey === resultKey(cell.result) && (cell.result.week === undefined || cell.result.week === i + 1),
              label: `${name}, ${COLUMNS[i]!.name}: match ${cell.match}, ${matchWord(cell.match).toLowerCase()}${cell.monthly ? ", monthly figure" : ""}`,
            }
          : null
      ),
      trail: <span className="plan-repeat-trail tabular">{Math.round(m.best.match)}</span>,
    };
  });

  const renderPopover = (row: HeatRow, col: number) => {
    const cell = byCity.get(row.key)?.cells[col];
    if (!cell) return null;
    const r = cell.result;
    return (
      <div>
        <div className="plan-heat-pop-title">
          {row.label}, {r ? resultWhen(r) : `week ${col + 1} · ${weekRangeLabel(col + 1)}`}
        </div>
        {r?.visitedBefore && <div className="plan-heat-pop-sub">You've been before</div>}
        <div className="plan-heat-pop-score">
          <span className="plan-heat-pop-num">{cell.match}</span>
          <span>{matchWord(cell.match)}</span>
        </div>
        {cell.monthly && <PopRow k="Resolution" v="Monthly figure (no weekly data for this place yet)" />}
        {r ? (
          <>
            {climateText(r) && <PopRow k="Climate" v={climateText(r)} />}
            {crowdText(r) && <PopRow k="Crowds" v={crowdText(r)} />}
            {r.price && (
              <PopRow
                k="Flight"
                v={
                  <>
                    {priceText(r.price)}
                    {r.price.source === "mock" && (
                      <>
                        {" "}
                        <Badge tone="warning">Mock</Badge>
                      </>
                    )}
                  </>
                }
              />
            )}
            <div className="plan-heat-pop-hint">
              {[...r.dims]
                .sort((a, b) => b.contribution - a.contribution)
                .slice(0, 3)
                .map((d) => `${DIM_WORDS[d.name]} ${Math.round(d.contribution * 100)}%`)
                .join(" · ")}
            </div>
          </>
        ) : (
          <div className="plan-heat-pop-hint">Climate only. Not ranked or priced for this week.</div>
        )}
      </div>
    );
  };

  return (
    <div className="plan-repeat-grid">
      <HeatLegend
        low="Less alike"
        high="More alike"
        extra={
          templateWeek ? (
            <span className="plan-repeat-legend-key">
              <span className="plan-repeat-legend-ring" /> Your trip's week
            </span>
          ) : undefined
        }
      />
      <HeatGrid
        groups={[{ key: "results", rows }]}
        label="Matches by week"
        firstHeader="Place"
        trailHeader="Best"
        columns={COLUMNS}
        markedCols={templateWeek ? [{ col: templateWeek - 1, label: "Your trip's week" }] : []}
        renderPopover={renderPopover}
        onCellClick={(row, col) => {
          const cell = byCity.get(row.key)?.cells[col];
          if (cell?.result) onSelect(resultKey(cell.result));
        }}
      />
    </div>
  );
}
