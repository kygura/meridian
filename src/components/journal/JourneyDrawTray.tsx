import { useEffect } from "react";
import { useMeridianStore } from "../../store";

/** Log from globe (DESIGN-journal.md §6.3): the picked-city chain. Globe.tsx collects the clicks. */
export default function JourneyDrawTray() {
  const { cityIds } = useMeridianStore((s) => s.journalDraw);
  const cities = useMeridianStore((s) => s.cities);
  const setDraw = useMeridianStore((s) => s.setJournalDraw);
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);

  const cancel = () => setDraw({ active: false, cityIds: [] });
  const undo = () => setDraw({ active: true, cityIds: cityIds.slice(0, -1) });
  const next = () => {
    setDraw({ active: false, cityIds: [] });
    openQuickLog({ prefillStops: cityIds });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") cancel();
      else if (e.key === "Backspace") {
        e.preventDefault();
        if (cityIds.length) undo();
        else cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityIds]);

  const label = (id: string) => {
    const c = cities.find((x) => x.id === id);
    return c?.iata ?? c?.name ?? id;
  };

  return (
    <div className="jr-draw-tray" role="region" aria-label="Journey being logged">
      <ol className="jr-draw-chain" aria-live="polite">
        {cityIds.length === 0 && <li className="jr-draw-empty">Click a city to start</li>}
        {cityIds.map((id, i) => (
          <li key={i} className="jr-draw-chip">
            <span className="jr-draw-n">{i + 1}</span> {label(id)}
          </li>
        ))}
      </ol>
      <div className="jr-draw-actions">
        <button type="button" className="tm-action-btn" onClick={undo} disabled={!cityIds.length}>UNDO</button>
        <button type="button" className="tm-action-btn" onClick={cancel}>CANCEL</button>
        <button type="button" className="booking-primary-btn" onClick={next} disabled={!cityIds.length}>SET DATES →</button>
      </div>
    </div>
  );
}
