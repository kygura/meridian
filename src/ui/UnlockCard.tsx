import { useRef, useState, type FormEvent } from "react";
import { JournalLockedError, verifyToken } from "../lib/journalApi";
import { useMeridianStore } from "../store";
import { useJournalToken } from "./journalToken";
import { Button, IconButton } from "./Button";
import { Field, Input } from "./Field";
import { IconEye, IconEyeOff, IconLock } from "./icons";
import { cx } from "./cx";
import { toast } from "./toast";

export interface UnlockCardProps {
  /** Called after the token is verified and saved. Every useJournalToken() user re-renders anyway. */
  onUnlocked?: () => void;
  /** What is locked, for the heading: "Your journal is private" by default. */
  title?: string;
  /** Tighter layout for popovers, panels and chat. */
  compact?: boolean;
  className?: string;
}

/** Journal token entry, shown inline wherever a gated feature is empty for lack of a token. */
export function UnlockCard({ onUnlocked, title = "Your journal is private", compact, className }: UnlockCardProps) {
  const { lockReason, setToken } = useJournalToken();
  const setJournalLocked = useMeridianStore((s) => s.setJournalLocked);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  if (lockReason === "token_not_configured") {
    return (
      <div className={cx("ui-unlock", compact && "ui-unlock--compact", className)} role="region" aria-label="Journal unavailable">
        <div className="ui-unlock-icon">
          <IconLock />
        </div>
        <p className="ui-unlock-title">The journal is switched off on this server</p>
        <p className="ui-unlock-body">Set an access token in the server settings, then reload.</p>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token || checking) return;
    setChecking(true);
    setError(null);
    try {
      await verifyToken(token);
      const persisted = setToken(token);
      if (!persisted) toast("Unlocked for this session only. This browser won't keep the token.", { tone: "warning" });
      setValue("");
      onUnlocked?.();
    } catch (err) {
      if (err instanceof JournalLockedError) {
        if (err.reason === "token_not_configured") setJournalLocked(true, "token_not_configured");
        else {
          setError("That token didn't work. Check it and try again.");
          input.current?.focus();
          input.current?.select();
        }
      } else setError("Couldn't reach the server. Try again.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <form className={cx("ui-unlock", compact && "ui-unlock--compact", className)} onSubmit={submit} aria-label="Unlock journal">
      {!compact ? (
        <div className="ui-unlock-icon">
          <IconLock />
        </div>
      ) : null}
      <p className="ui-unlock-title">{title}</p>
      <p className="ui-unlock-body">Paste your access token to unlock it. It stays in this browser.</p>
      <div className="ui-unlock-row">
        <Field label="Access token" hideLabel error={error ?? undefined}>
          <Input
            ref={input}
            type={show ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder="Access token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <IconButton
          label={show ? "Hide token" : "Show token"}
          icon={show ? <IconEyeOff /> : <IconEye />}
          aria-pressed={show}
          variant="secondary"
          onClick={() => setShow((v) => !v)}
        />
      </div>
      <Button type="submit" variant="primary" loading={checking} disabled={!value.trim()} block={compact}>
        Unlock
      </Button>
    </form>
  );
}
