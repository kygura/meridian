import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button, IconButton, Input, Popover } from "../../ui";
import { IconArrowRight, IconSearch } from "../../ui/icons";
import { searchJourneys, suggestedJourneys } from "../../lib/inbox";
import type { CityIndex } from "../../lib/journal";
import type { Journey } from "../../types";
import { count, dateRange } from "./inboxText";

export interface MergeMenuProps {
  journeys: Journey[];
  cities: CityIndex;
  range: { startDate: string; endDate: string };
  suggestedId?: string;
  /** Items being merged, for the confirm sentence. */
  items: number;
  disabled?: boolean;
  /** Why it is disabled, as a tooltip. */
  disabledWhy?: string;
  onConfirm: (journeyId: string) => void;
  /** "button": a labelled secondary button (card footers); "icon": an icon button (rows). */
  trigger: "button" | "icon";
  /** Accessible context for the icon trigger: "Add Lisbon to an existing trip". */
  label: string;
}

/** "Add to an existing trip": nearby trips first, a search over all of them, then a one-line confirm. */
export default function MergeMenu({ journeys, cities, range, suggestedId, items, disabled, disabledWhy, onConfirm, trigger, label }: MergeMenuProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Journey | null>(null);
  const suggested = useMemo(() => suggestedJourneys(range, journeys, suggestedId), [range, journeys, suggestedId]);
  const found = useMemo(() => searchJourneys(q, journeys, cities).filter((j) => !suggested.some((s) => s.id === j.id)), [q, journeys, cities, suggested]);

  const close = () => {
    setOpen(false);
    setPicked(null);
    setQ("");
  };

  const row = (j: Journey): ReactNode => (
    <li key={j.id}>
      <button type="button" className="inbox-merge-row" onClick={() => setPicked(j)}>
        <span className="inbox-merge-title">{j.title}</span>
        <span className="inbox-merge-dates num">{dateRange(j.startDate, j.endDate)}</span>
      </button>
    </li>
  );

  const triggerProps = {
    ref: anchor,
    disabled,
    title: disabled ? disabledWhy : undefined,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    onClick: () => (open ? close() : setOpen(true)),
  };

  return (
    <>
      {trigger === "button" ? (
        <Button size="sm" icon={<IconArrowRight size={16} />} {...triggerProps}>
          Add to a trip
        </Button>
      ) : (
        <IconButton size="sm" label={label} icon={<IconArrowRight size={18} />} {...triggerProps} title={disabled ? disabledWhy : label} />
      )}
      <Popover open={open} onClose={close} anchorRef={anchor} placement="bottom-end" label="Add to an existing trip" className="inbox-merge">
        {picked ? (
          <div className="inbox-merge-confirm">
            <p>
              Add {count(items, "item")} to <strong>{picked.title}</strong>?
            </p>
            <div className="inbox-merge-confirm-actions">
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                Back
              </Button>
              <Button
                size="sm"
                variant="primary"
                data-autofocus
                onClick={() => {
                  const id = picked.id;
                  close();
                  onConfirm(id);
                }}
              >
                Add
              </Button>
            </div>
          </div>
        ) : (
          <>
            {suggested.length > 0 && (
              <>
                <p className="inbox-merge-head">Around the same dates</p>
                <ul className="inbox-merge-list">{suggested.slice(0, 5).map(row)}</ul>
              </>
            )}
            <div className="inbox-merge-search">
              <Input size="sm" icon={<IconSearch size={16} />} aria-label="Search your trips" placeholder="Search your trips" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus={suggested.length === 0 || undefined} />
            </div>
            {q.trim() ? (
              found.length > 0 ? (
                <ul className="inbox-merge-list">{found.map(row)}</ul>
              ) : (
                <p className="inbox-merge-empty">No trip matches “{q.trim()}”.</p>
              )
            ) : suggested.length === 0 ? (
              <p className="inbox-merge-empty">{journeys.length ? "No trip around these dates. Search by title or city." : "You haven't logged any trips yet."}</p>
            ) : null}
          </>
        )}
      </Popover>
    </>
  );
}
