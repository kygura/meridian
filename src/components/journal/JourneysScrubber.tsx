import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import { journeyYears } from "../../lib/journeyArcs";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const INITIALS = "JFMAMJJASOND";

/** Time scrubber for the globe journeys layer (DESIGN-journal.md §10). Lives inside `.layers-pop`. State: store.journeyScrub. */
export default function JourneysScrubber() {
  const journeys = useMeridianStore((s) => s.journeys);
  const scrub = useMeridianStore((s) => s.journeyScrub);
  const setScrub = useMeridianStore((s) => s.setJourneyScrub);
  const years = useMemo(() => journeyYears(journeys ?? []), [journeys]);
  const [playing, setPlaying] = useState(false);
  const monthRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Play: one year per 900ms, stops at the last year.
  useEffect(() => {
    if (!playing) return;
    const i = years.indexOf(scrub.year ?? -1);
    if (i < 0 || i >= years.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setScrub({ year: years[i + 1] }), 900);
    return () => clearTimeout(t);
  }, [playing, scrub.year, years, setScrub]);

  const setMode = (mode: "chrono" | "season") => {
    setPlaying(false);
    setScrub({ mode });
  };
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (scrub.year === undefined || scrub.year >= years[years.length - 1]) setScrub({ year: years[0] });
    setPlaying(true);
  };

  const sliderValue = scrub.year === undefined ? years.length : Math.max(0, years.indexOf(scrub.year));
  const shownYear = scrub.year ?? years[years.length - 1];

  const onMonthKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + 13) % 13; // 0 = ALL, 1-12 = months
    setScrub({ month: next === 0 ? undefined : next });
    monthRefs.current[next]?.focus();
  };

  return (
    <div className="jr-scrub">
      <div className="jr-scrub-modes">
        <button type="button" aria-pressed={scrub.mode === "chrono"} onClick={() => setMode("chrono")}>BY YEAR</button>
        <button type="button" aria-pressed={scrub.mode === "season"} onClick={() => setMode("season")}>BY SEASON</button>
      </div>
      {scrub.mode === "chrono" ? (
        years.length ? (
          <div className="jr-scrub-row">
            <button type="button" className="jr-scrub-play" aria-pressed={playing} aria-label="Play through the years" onClick={togglePlay}>
              {playing ? "❚❚" : "▶"}
            </button>
            <input
              type="range"
              min={0}
              max={years.length}
              step={1}
              value={sliderValue}
              aria-label="Show journeys up to year"
              aria-valuetext={scrub.year === undefined ? "all years" : String(scrub.year)}
              onChange={(e) => {
                setPlaying(false);
                const v = Number(e.target.value);
                setScrub({ year: v >= years.length ? undefined : years[v] });
              }}
            />
            <span className="jr-scrub-readout">{years[0]} → {shownYear}</span>
          </div>
        ) : (
          <div className="jr-scrub-cap">No confirmed journeys yet.</div>
        )
      ) : (
        <>
          <div className="jr-scrub-months" role="radiogroup" aria-label="Month, all years">
            {[...INITIALS].map((ch, k) => {
              const m = k + 1;
              const on = scrub.month === m;
              return (
                <button
                  key={m}
                  ref={(el) => {
                    monthRefs.current[m] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={MONTH_NAMES[k]}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setScrub({ month: m })}
                  onKeyDown={(e) => onMonthKey(e, m)}
                >
                  {ch}
                </button>
              );
            })}
            <button
              ref={(el) => {
                monthRefs.current[0] = el;
              }}
              type="button"
              role="radio"
              aria-checked={scrub.month === undefined}
              tabIndex={scrub.month === undefined ? 0 : -1}
              onClick={() => setScrub({ month: undefined })}
              onKeyDown={(e) => onMonthKey(e, 0)}
            >
              ALL
            </button>
          </div>
          <div className="jr-scrub-cap">
            {scrub.month ? `Where you usually are in ${MONTH_NAMES[scrub.month - 1]}.` : "Every month, every year."}
          </div>
        </>
      )}
    </div>
  );
}
