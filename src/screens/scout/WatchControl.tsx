import { useEffect, useState } from "react";
import { Button, Chip, Input } from "../../ui";
import { parseEuro, watchBudgetText } from "../../lib/atlasFormat";
import type { WishlistPatch, WishlistPlace } from "../../lib/atlasApi";

type WatchPatch = NonNullable<WishlistPatch["watch"]>;

/** Watch on or off, and the most Atlas should accept per fare. Saved with the PATCH the server defines. */
export function WatchControl({ place, onSave }: { place: WishlistPlace; onSave: (watch: WatchPatch) => Promise<boolean> }) {
  const watch = place.watch;
  const saved = watch?.targetBudgetEur?.max;
  const [draft, setDraft] = useState(saved != null ? String(saved) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setDraft(saved != null ? String(saved) : ""), [saved]);

  const send = async (active: boolean, max: number | undefined) => {
    setBusy(true);
    const min = watch?.targetBudgetEur?.min;
    const target = max != null || min != null ? { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) } : undefined;
    await onSave({ active, ...(target ? { targetBudgetEur: target } : {}) });
    setBusy(false);
  };

  const parsed = parseEuro(draft);
  const dirty = (parsed ?? null) !== (saved ?? null);

  const saveBudget = async () => {
    if (Number.isNaN(parsed)) return setError("Enter an amount in euros.");
    setError("");
    await send(watch?.active ?? true, parsed);
  };

  return (
    <div className="scout-watch">
      <div className="scout-watch-row">
        <span className="scout-label">Watch</span>
        <Chip selected={!!watch?.active} disabled={busy} onClick={() => void send(!watch?.active, watch?.targetBudgetEur?.max)}>
          {watch?.active ? "On" : "Off"}
        </Chip>
        {watch && !dirty && <span className="scout-muted">{watchBudgetText(watch.targetBudgetEur)}</span>}
      </div>
      {watch && (
        <div className="scout-watch-row">
          <label className="scout-label" htmlFor={`watch-${place.cityId}`}>
            Max EUR
          </label>
          <Input
            id={`watch-${place.cityId}`}
            size="sm"
            className="scout-watch-input"
            inputMode="numeric"
            placeholder="Any"
            value={draft}
            aria-invalid={!!error}
            aria-label={`Target budget in euros for ${place.name}`}
            onChange={(e) => {
              setDraft(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && dirty && void saveBudget()}
          />
          {dirty && (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void saveBudget()}>
              Save
            </Button>
          )}
          {error && <span className="scout-error">{error}</span>}
        </div>
      )}
    </div>
  );
}
