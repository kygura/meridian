import { useEffect, useRef, useState } from "react";
import { isExpiryUrgent, remainingMs } from "../../../lib/bookingApi";
import { cx } from "../../../ui";
import { IconClock } from "../../../ui/icons";
import { countdownText } from "./flightText";

/** Live countdown to an offer's expiry. Calls onExpire once at zero. */
export function useRemaining(expiresAt: string, onExpire?: () => void): number {
  const [ms, setMs] = useState(() => remainingMs(expiresAt));
  const cb = useRef(onExpire);
  cb.current = onExpire;
  useEffect(() => {
    let fired = false;
    setMs(remainingMs(expiresAt));
    const t = window.setInterval(() => {
      const left = remainingMs(expiresAt);
      setMs(left);
      if (left <= 0 && !fired) {
        fired = true;
        window.clearInterval(t);
        cb.current?.();
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [expiresAt]);
  return ms;
}

/** "Price held for 4:05". Turns amber under two minutes. Announces only at the threshold and at expiry. */
export function Countdown({ expiresAt, onExpire, compact }: { expiresAt: string; onExpire?: () => void; compact?: boolean }) {
  const ms = useRemaining(expiresAt, onExpire);
  const urgent = isExpiryUrgent(ms);
  const expired = ms <= 0;
  return (
    <span className={cx("plan-flights-countdown", urgent && "is-urgent", expired && "is-expired")}>
      <IconClock size={14} />
      <span className="num">{expired ? "Price expired" : compact ? countdownText(ms) : `Price held for ${countdownText(ms)}`}</span>
      <span className="sr-only" aria-live="polite">
        {expired ? "This price has expired" : urgent ? "Price expires in less than two minutes" : ""}
      </span>
    </span>
  );
}
