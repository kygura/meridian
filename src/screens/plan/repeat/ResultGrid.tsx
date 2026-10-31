import { useMemo } from "react";
import { buildReplayRows, colToMonth, monthToCol, resultKey } from "../../../lib/replayGrid";
import {
  DIM_WORDS,
  MONTH_NAMES,
  climateText,
  crowdText,
  matchWord,
  priceDelta,
  priceText,
} from "../../../lib/repeatCopy";
import { Badge } from "../../../ui";
import type { City, ReplayResponse } from "../../../types";
import { HeatGrid, HeatLegend, PopRow, type HeatRow } from "../when/HeatGrid";

export interface ResultGridProps {
  resp: ReplayResponse;
  cityById: Map<string, City>;
  /** 1-based. */
  templateMonth?: number;
  /** 1-based, when the month is shifted. */
  targetMonth?: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

/** Secondary view: each result city across all twelve months (port of the old replay grid). */
export function ResultGrid({ resp, cityById, templateMonth, targetMonth, selectedKey, onSelect }: ResultGridProps) {
  const models = useMemo(() => buildReplayRows(resp), [resp]);
  const byCity = useMemo(() => new Map(models.map((m) => [m.cityId, m])), [models]);
  const tplCol = templateMonth ? monthToCol(templateMonth) : -1;

  const rows: HeatRow[] = models.map((m) => {
    const c = cityById.get(m.cityId);
    const name = c?.name ?? m.cityId;
    const bestKey = resultKey(m.best);
    const isSelected = !!selectedKey && selectedKey.startsWith(`${m.cityId}:`);
    return {
      key: m.cityId,
      label: name,
      sublabel: c?.country,
      onOpen: () => onSelect(bestKey),
      openLabel: `Show ${name}, its best month`,
      state: "ready",
      selected: isSelected,
      cells: m.cells.map((cell, col) =>
        cell
          ? {
              score: cell.match,
              muted: !cell.result,
              ring: col === tplCol,
              dot: selectedKey === `${m.cityId}:${colToMonth(col)}`,
              label: cell.result
                ? `${name}, ${MONTH_NAMES[col]}: match ${cell.match}, ${matchWord(cell.match).toLowerCase()}`
                : `${name}, ${MONTH_NAMES[col]}: climate score ${cell.match}, not ranked`,
            }
          : null
      ),
      trail: <span className="plan-repeat-trail tabular">{Math.round(m.best.match)}</span>,
    };
  });

  const marks = [
    ...(templateMonth ? [{ col: monthToCol(templateMonth), label: "Your trip's month" }] : []),
    ...(targetMonth && targetMonth !== templateMonth ? [{ col: monthToCol(targetMonth), label: "Shifted month" }] : []),
  ];

  const renderPopover = (row: HeatRow, col: number) => {
    const model = byCity.get(row.key);
    const cell = model?.cells[col];
    if (!cell) return null;
    const r = cell.result;
    return (
      <div>
        <div className="plan-heat-pop-title">
          {row.label}, {MONTH_NAMES[col]}
        </div>
        {r?.visitedBefore && <div className="plan-heat-pop-sub">You've been before</div>}
        <div className="plan-heat-pop-score">
          <span className="plan-heat-pop-num">{cell.match}</span>
          <span>{matchWord(cell.match)}</span>
        </div>
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
                    {(() => {
                      const d = priceDelta(r.price);
                      return d ? ` · ${Math.abs(d)}% ${d < 0 ? "below" : "above"} usual` : null;
                    })()}
                  </>
                }
              />
            )}
            {r.events?.map((e) => <PopRow key={e.id} k="On then" v={e.title} />)}
            <div className="plan-heat-pop-hint">
              {[...r.dims]
                .sort((a, b) => b.contribution - a.contribution)
                .slice(0, 3)
                .map((d) => `${DIM_WORDS[d.name]} ${Math.round(d.contribution * 100)}%`)
                .join(" · ")}
            </div>
          </>
        ) : (
          <div className="plan-heat-pop-hint">Climate only. Not ranked or priced for this month.</div>
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
          templateMonth ? (
            <span className="plan-repeat-legend-key">
              <span className="plan-repeat-legend-ring" /> Your trip's month
            </span>
          ) : undefined
        }
      />
      <HeatGrid
        groups={[{ key: "results", rows }]}
        label="Matches by month"
        firstHeader="Place"
        trailHeader="Best"
        markedCols={marks}
        renderPopover={renderPopover}
        onCellClick={(row, col) => {
          const cell = byCity.get(row.key)?.cells[col];
          if (cell?.result) onSelect(resultKey(cell.result));
        }}
      />
    </div>
  );
}
