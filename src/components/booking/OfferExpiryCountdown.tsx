import { useEffect, useRef, useState } from "react";
import {
  remainingMs,
  formatCountdown,
  isExpiryUrgent,
  isExpired,
} from "../../lib/bookingApi";

/** Live mm:ss countdown from an offer's `expiresAt` (DESIGN-booking.md §7.2).
 *  ≤ 2:00 turns --warn and pulses; at 00:00 clamps to "EXPIRED" and fires
 *  `onExpire` once. Announces politely only when crossing the warn threshold
 *  and at expiry — never every tick. */
export default function OfferExpiryCountdown({
  expiresAt,
  onExpire,
  prefix = "EXPIRES IN",
}: {
  expiresAt: string;
  onExpire?: () => void;
  prefix?: string;
}) {
  const [ms, setMs] = useState(() => remainingMs(expiresAt));
  const firedRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    firedRef.current = false;
    setMs(remainingMs(expiresAt));
    const interval = setInterval(() => {
      const left = remainingMs(expiresAt);
      setMs(left);
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpireRef.current?.();
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const urgent = isExpiryUrgent(ms);
  const expired = isExpired(ms);
  const announce = expired
    ? "Offer expired"
    : urgent
      ? "Offer expires in less than two minutes"
      : "";

  return (
    <span
      className={`bk-countdown${urgent ? " urgent" : ""}${expired ? " expired" : ""}`}
    >
      {expired ? "EXPIRED" : `${prefix} ${formatCountdown(ms)}`}
      <span className="bk-visually-hidden" aria-live="polite">
        {announce}
      </span>
    </span>
  );
}
