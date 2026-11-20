import { useEffect, useState } from "react";
import { Button } from "../ui";
import { analyticsEnabled, onConsentChange, readConsent, setConsent, takeAskAgain, type ConsentChoice } from "../lib/analytics";

/**
 * Analytics consent, asked once and remembered for a year. Decline and Allow
 * carry the same weight (no filled button, same size, side by side), and
 * Settings > Privacy changes the answer later.
 */
export function ConsentBanner() {
  const [open, setOpen] = useState(() => analyticsEnabled() && readConsent() === null);

  useEffect(() => {
    if (!analyticsEnabled()) return;
    return onConsentChange(() => {
      if (takeAskAgain()) setOpen(true);
    });
  }, []);

  if (!open) return null;

  const choose = (choice: ConsentChoice) => {
    setConsent(choice);
    setOpen(false);
  };

  return (
    <div className="consent" role="region" aria-label="Analytics consent">
      <p className="consent-text">
        Count your visit with Google Analytics? It shows which screens get used. No ads, no profile, nothing sold.
      </p>
      <div className="consent-actions">
        <Button size="sm" onClick={() => choose("denied")}>
          Decline
        </Button>
        <Button size="sm" onClick={() => choose("granted")}>
          Allow
        </Button>
      </div>
    </div>
  );
}
