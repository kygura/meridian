import { useRef, useState, type FormEvent } from "react";
import { LockedOutError, SignInUnavailableError, WrongPasswordError, waitText } from "../lib/session";
import { useJournalToken } from "./journalToken";
import { Button, IconButton } from "./Button";
import { Field, Input } from "./Field";
import { IconEye, IconEyeOff, IconLock } from "./icons";
import { cx } from "./cx";

export interface UnlockCardProps {
  /** Called after sign-in succeeds. Every useJournalToken() user re-renders anyway. */
  onUnlocked?: () => void;
  /** What is locked, for the heading: "Your journal is private" by default. */
  title?: string;
  /** Tighter layout for popovers, panels and chat. */
  compact?: boolean;
  className?: string;
}

/** Owner sign-in, shown inline wherever a gated feature is empty for lack of a session. */
export function UnlockCard({ onUnlocked, title = "Your journal is private", compact, className }: UnlockCardProps) {
  const { lockReason, sessionEnded, signIn } = useJournalToken();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  if (lockReason === "token_not_configured") {
    return (
      <div className={cx("ui-unlock", compact && "ui-unlock--compact", className)} role="region" aria-label="Sign-in unavailable">
        <div className="ui-unlock-icon">
          <IconLock />
        </div>
        <p className="ui-unlock-title">Sign-in is switched off on this server</p>
        <p className="ui-unlock-body">Set a password in the server settings, then reload.</p>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value || checking) return;
    setChecking(true);
    setError(null);
    try {
      await signIn(value);
      setValue("");
      onUnlocked?.();
    } catch (err) {
      if (err instanceof SignInUnavailableError) return; // the card switches to "switched off"
      if (err instanceof LockedOutError) setError(`Too many wrong passwords. Try again in ${waitText(err.retryAfterSeconds)}.`);
      else if (err instanceof WrongPasswordError) {
        const left = err.attemptsLeft;
        setError(
          left !== undefined && left <= 2
            ? `That password didn't work. ${left === 1 ? "1 try" : `${left} tries`} left before a pause.`
            : "That password didn't work. Check it and try again."
        );
        input.current?.focus();
        input.current?.select();
      } else setError("Couldn't reach the server. Try again.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <form className={cx("ui-unlock", compact && "ui-unlock--compact", className)} onSubmit={submit} aria-label="Sign in">
      {!compact ? (
        <div className="ui-unlock-icon">
          <IconLock />
        </div>
      ) : null}
      <p className="ui-unlock-title">{title}</p>
      <p className="ui-unlock-body">
        {sessionEnded ? "Your session ended. Sign in again." : "Sign in with your password. This browser keeps a session, not the password."}
      </p>
      <div className="ui-unlock-row">
        <Field label="Password" hideLabel error={error ?? undefined}>
          <Input
            ref={input}
            type={show ? "text" : "password"}
            name="password"
            autoComplete="current-password"
            spellCheck={false}
            placeholder="Password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <IconButton
          label={show ? "Hide password" : "Show password"}
          icon={show ? <IconEyeOff /> : <IconEye />}
          aria-pressed={show}
          variant="secondary"
          onClick={() => setShow((v) => !v)}
        />
      </div>
      <Button type="submit" variant="primary" loading={checking} disabled={!value} block={compact}>
        Sign in
      </Button>
    </form>
  );
}
