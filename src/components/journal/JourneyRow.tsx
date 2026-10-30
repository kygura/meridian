import { navigate } from "../../lib/router";
import { chainLabel, comfortSentence, formatEur, formatRange, journeyNights, modeGlyphs, plural, spendEur, type CityIndex } from "../../lib/journal";
import type { Journey } from "../../types";
import RatingPips from "./RatingPips";

/** One journey on the timeline: a 2-line button that opens the detail page (§4). */
export default function JourneyRow({ journey: j, cities }: { journey: Journey; cities: CityIndex }) {
  const spend = spendEur(j);
  const hint = comfortSentence(j.stops).kind;
  return (
    <button type="button" className="jr-row-btn" onClick={() => navigate(`/journal/${encodeURIComponent(j.id)}`)}>
      <span className="jr-r-date">
        <span>{formatRange(j.startDate, j.endDate)}</span>
        <span className="jr-r-sub">{plural(journeyNights(j), "NIGHT")}</span>
      </span>
      <span className="jr-r-main">
        <span className="jr-r-title">{j.title}</span>
        <span className="jr-r-chain">
          {chainLabel(j, cities)}
          {j.segments.length > 0 && <span aria-hidden="true">{"  "}{modeGlyphs(j.segments)}</span>}
        </span>
        {j.tags.length > 0 && (
          <span className="jr-r-tags">
            {j.tags.map((t) => (
              <span key={t} className="jr-pill">{t}</span>
            ))}
          </span>
        )}
      </span>
      <span className="jr-r-side">
        <RatingPips value={j.rating} />
        <span className="jr-r-spend">{spend === null ? "—" : formatEur(spend)}</span>
        {hint === "kinder" && <span className="jr-r-hint good">▲ KINDER</span>}
        {hint === "rougher" && <span className="jr-r-hint hazard">▼ ROUGHER</span>}
        {j.status === "draft" && <span className="jr-pill">DRAFT</span>}
      </span>
    </button>
  );
}
