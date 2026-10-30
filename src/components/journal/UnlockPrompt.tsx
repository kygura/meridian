import { useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import { JournalLockedError, refreshBadges, setToken, verifyToken } from "../../lib/journalApi";
import "../../styles/journal.css";

/** Inline dispatch card shown instead of a journal sub-view while the API answers 401 (R1). */
export default function UnlockPrompt({ onUnlocked }: { onUnlocked: () => void }) {
  const reason = useMeridianStore((s) => s.journalLockReason);
  const setJournalLocked = useMeridianStore((s) => s.setJournalLocked);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  if (reason === "token_not_configured") {
    return (
      <div className="jr-unlock" role="region" aria-labelledby="jr-unlock-title">
        <div className="jr-eyebrow">JOURNAL · LOCKED</div>
        <h2 className="jr-unlock-title" id="jr-unlock-title">The journal isn't switched on here.</h2>
        <p className="jr-unlock-body">
          This server has no MERIDIAN_TOKEN set, so journal routes stay closed. Set it in the server environment and
          reload.
        </p>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token || checking) return;
    setChecking(true);
    setRejected(false);
    setFailed(false);
    try {
      await verifyToken(token);
      setToken(token);
      setJournalLocked(false);
      void refreshBadges();
      onUnlocked();
    } catch (err) {
      setChecking(false);
      if (err instanceof JournalLockedError) {
        if (err.reason === "token_not_configured") setJournalLocked(true, "token_not_configured");
        else {
          setRejected(true);
          input.current?.focus();
          input.current?.select();
        }
      } else setFailed(true);
    }
  };

  return (
    <form className="jr-unlock" onSubmit={submit} aria-labelledby="jr-unlock-title">
      <div className="jr-eyebrow">JOURNAL · LOCKED</div>
      <h2 className="jr-unlock-title" id="jr-unlock-title">Your journal is private.</h2>
      <p className="jr-unlock-body">Paste the access token set as MERIDIAN_TOKEN on the server. It stays in this browser.</p>
      <div className="jr-unlock-row">
        <input
          ref={input}
          className="jr-input jr-unlock-input"
          type={show ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-label="Access token"
          aria-invalid={rejected}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="tm-action-btn" aria-pressed={show} onClick={() => setShow((v) => !v)}>
          {show ? "HIDE" : "SHOW"}
        </button>
      </div>
      {rejected && <div className="jr-err" role="alert">⚠ TOKEN REJECTED</div>}
      {failed && <div className="jr-err" role="alert">⚠ COULDN'T REACH THE SERVER</div>}
      <button type="submit" className="booking-primary-btn" disabled={checking || !value.trim()}>
        {checking ? (
          <span className="jr-checking">
            CHECKING…
            <span className="agent-brief-loading"><span /><span /><span /></span>
          </span>
        ) : (
          "UNLOCK →"
        )}
      </button>
    </form>
  );
}
