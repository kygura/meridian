import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { JournalApiError, JournalNetworkError, createWatch } from "../../lib/journalApi";
import type { ReplayQuery, Watch, WatchPriceRule } from "../../types";
import "../../styles/journal.css";

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

type Rule = "below_my_median" | "deal_low" | "max";

function saveError(e: unknown): string {
  if (e instanceof JournalNetworkError) return "⚠ COULDN'T REACH THE SERVER — TRY AGAIN";
  if (e instanceof JournalApiError) {
    // A bare 404 (no error code) means the watches route is not mounted on this server.
    if (e.status === 404 && !e.code) return "⚠ WATCHES AREN'T AVAILABLE ON THIS SERVER YET";
    if (e.code === "too_many_watches") return `⚠ ${e.message.toUpperCase()}`;
    if (e.status === 400) return "⚠ THE SERVER REJECTED THESE SETTINGS — CHECK THEM AND TRY AGAIN";
  }
  return "⚠ COULDN'T SAVE THE WATCH — TRY AGAIN";
}

/** Save a replay query as a Watch (DESIGN-journal §9). Modal: focus trap, Esc closes, focus returns to the opener. */
export default function WatchSheet({
  label: initialLabel,
  query,
  summary,
  onClose,
  onSaved,
}: {
  label: string;
  query: ReplayQuery;
  /** Read-only restatement of the query. */
  summary: string;
  onClose: () => void;
  onSaved: (w: Watch) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(document.activeElement);
  const [label, setLabel] = useState(initialLabel.slice(0, 120));
  const [from, setFrom] = useState("6");
  const [to, setTo] = useState("14");
  const [rule, setRule] = useState<Rule>("below_my_median");
  const [max, setMax] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>("#jr-w-label")?.focus();
    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const f = Number(from);
  const t = Number(to);
  const leadOk = Number.isInteger(f) && Number.isInteger(t) && f >= 1 && t <= 52 && f < t;
  const maxOk = rule !== "max" || (Number(max) > 0 && Number.isFinite(Number(max)));
  const valid = label.trim().length > 0 && leadOk && maxOk;

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    const priceRule: WatchPriceRule = rule === "max" ? { maxEur: Number(max) } : rule;
    try {
      onSaved(await createWatch({ label: label.trim(), query, leadWeeks: [f, t], priceRule }));
    } catch (e) {
      setError(saveError(e));
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="cmd-overlay" role="presentation">
      <div ref={cardRef} className="jr-sheet jr-watch" role="dialog" aria-modal="true" aria-labelledby="jr-w-title" aria-describedby="jr-w-summary" onKeyDown={onKeyDown}>
        <div className="booking-head">
          <div className="booking-head-title-row">
            <span className="booking-head-title" id="jr-w-title">
              ◎ WATCH THIS WINDOW
            </span>
            <button type="button" className="tm-action-btn booking-close" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="booking-body jr-sheet-body">
          <section>
            <label className="jr-label" htmlFor="jr-w-label">
              LABEL
            </label>
            <input id="jr-w-label" className="jr-input jr-input-sans jr-input-wide" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          </section>

          <section>
            <div className="jr-label" id="jr-w-lead">
              LEAD TIME
            </div>
            <div className="jr-w-lead" role="group" aria-labelledby="jr-w-lead">
              <span className="jr-hint">FROM</span>
              <input className="jr-input jr-w90" type="number" min={1} max={52} aria-label="Weeks ahead, from" aria-invalid={!leadOk} aria-describedby={leadOk ? undefined : "jr-w-lead-err"} value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="jr-hint">TO</span>
              <input className="jr-input jr-w90" type="number" min={1} max={52} aria-label="Weeks ahead, to" aria-invalid={!leadOk} aria-describedby={leadOk ? undefined : "jr-w-lead-err"} value={to} onChange={(e) => setTo(e.target.value)} />
              <span className="jr-hint">WEEKS AHEAD</span>
            </div>
            {!leadOk && <div className="jr-err" id="jr-w-lead-err">⚠ 1–52 WEEKS, FROM BEFORE TO</div>}
          </section>

          <section>
            <fieldset className="jr-w-rules">
              <legend className="jr-label">PRICE RULE</legend>
              <label className="jr-w-rule">
                <input type="radio" name="jr-w-rule" checked={rule === "below_my_median"} onChange={() => setRule("below_my_median")} />
                BELOW WHAT I USUALLY PAY
              </label>
              <label className="jr-w-rule">
                <input type="radio" name="jr-w-rule" checked={rule === "deal_low"} onChange={() => setRule("deal_low")} />
                PROVIDER SAYS LOW
              </label>
              <label className="jr-w-rule">
                <input type="radio" name="jr-w-rule" checked={rule === "max"} onChange={() => setRule("max")} />
                UNDER €
                <input
                  className="jr-input jr-w90"
                  type="number"
                  min={1}
                  aria-label="Maximum price in euros"
                  aria-invalid={!maxOk}
                  disabled={rule !== "max"}
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                />
              </label>
            </fieldset>
          </section>

          <div className="jr-hint" id="jr-w-summary">
            {summary}
          </div>
        </div>

        {error && (
          <div className="jr-general-err" role="alert">
            {error}
          </div>
        )}

        <div className="booking-foot">
          <button type="button" className="tm-action-btn" onClick={onClose}>
            CANCEL
          </button>
          <button type="button" className="booking-primary-btn" disabled={!valid || saving} onClick={() => void save()}>
            {saving ? "SAVING…" : "SAVE WATCH"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
