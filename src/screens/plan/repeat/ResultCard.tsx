import { forwardRef } from "react";
import { openCity } from "../../../shell/uiStore";
import {
  climateText,
  crowdText,
  matchWord,
  monthName,
  resultWhen,
  priceDelta,
  priceText,
  scoreStep,
  whyText,
} from "../../../lib/repeatCopy";
import { Badge, Button, Card, cx } from "../../../ui";
import { IconBell, IconCheck, IconPin } from "../../../ui/icons";
import type { City, ReplayResult } from "../../../types";
import { AddToTrip } from "./AddToTrip";
import "../when/heatgrid.css";

export interface ResultCardProps {
  result: ReplayResult;
  rank: number;
  city: City | undefined;
  origin?: City;
  selected?: boolean;
  watched?: boolean;
  onSelect?: () => void;
  onWatch: () => void;
}

function Price({ price }: { price: NonNullable<ReplayResult["price"]> }) {
  const delta = priceDelta(price);
  return (
    <span className="plan-repeat-price">
      <span className="tabular">{priceText(price)}</span>
      {price.source === "mock" && (
        <Badge tone="warning" title="Sample price, not used for the match">
          Mock
        </Badge>
      )}
      {delta !== undefined && delta !== 0 && (
        <span className={cx("plan-repeat-delta", delta < 0 && "is-good")}>
          {Math.abs(delta)}% {delta < 0 ? "below" : "above"} usual
        </span>
      )}
    </span>
  );
}

/** One "place like your trip": match, climate, crowds, price, and the three actions. */
export const ResultCard = forwardRef<HTMLLIElement, ResultCardProps>(function ResultCard(
  { result: r, rank, city, origin, selected, watched, onSelect, onWatch },
  ref
) {
  const name = city?.name ?? r.cityId;
  const score = Math.round(r.match);
  const climate = climateText(r);
  const crowds = crowdText(r);
  const why = whyText(r);
  const events = r.events ?? [];

  return (
    <li ref={ref} className="plan-repeat-item">
      <Card padding="none" className={cx("plan-repeat-card", selected && "is-selected")}>
        <div className="plan-repeat-card-head">
          <span className="plan-repeat-rank tabular" aria-hidden="true">
            {rank}
          </span>
          <div className="plan-repeat-card-title">
            {onSelect ? (
              <button type="button" className="plan-repeat-name" onClick={onSelect} aria-pressed={selected}>
                {name}
              </button>
            ) : (
              <span className="plan-repeat-name is-static">{name}</span>
            )}
            <span className="plan-repeat-sub">
              {[city?.country, resultWhen(r)].filter(Boolean).join(" · ")}
              {" · "}
              {r.visitedBefore ? "Been before" : "New to you"}
            </span>
          </div>
          <div className="plan-repeat-score" aria-label={`Match ${score} out of 100, ${matchWord(score).toLowerCase()}`}>
            <span className={cx("plan-repeat-score-num tabular", `plan-heat-s${scoreStep(score)}`)}>{score}</span>
            <span className="plan-repeat-score-word">{matchWord(score)}</span>
          </div>
        </div>

        <dl className="plan-repeat-facts">
          <div>
            <dt>Climate</dt>
            <dd>{climate || "Not compared"}</dd>
          </div>
          <div>
            <dt>Crowds</dt>
            <dd>{crowds || "Not compared"}</dd>
          </div>
          <div>
            <dt>Flight</dt>
            <dd>{r.price ? <Price price={r.price} /> : origin ? "No price yet" : "Set a home city for prices"}</dd>
          </div>
        </dl>

        {(why || events.length > 0) && (
          <p className="plan-repeat-why">
            {why}
            {why && events.length > 0 ? " · " : ""}
            {events.length > 0 && <span>On then: {events.map((e) => e.title).join(", ")}</span>}
          </p>
        )}

        <div className="plan-repeat-actions">
          <Button variant="ghost" icon={<IconPin size={16} />} onClick={() => openCity(r.cityId)}>
            Open city
          </Button>
          {city && <AddToTrip city={city} month={r.month} origin={origin} />}
          <Button
            variant="ghost"
            icon={watched ? <IconCheck size={16} /> : <IconBell size={16} />}
            onClick={onWatch}
            aria-label={`Watch prices for ${name} in ${resultWhen(r)}`}
          >
            {watched ? "Watching" : "Watch"}
          </Button>
        </div>
      </Card>
    </li>
  );
});
