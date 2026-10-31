import { useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useMeridianStore } from "../store";
import type { City } from "../types";
import { searchCities } from "./citySearch";
import { cx } from "./cx";
import { IconSearch } from "./icons";

export interface CitySearchProps {
  onPick: (city: City) => void;
  /** Placeholder, e.g. "Add a city". */
  placeholder?: string;
  /** Accessible name when not wrapped in a <Field> (Field supplies a visible label). */
  "aria-label"?: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  autoFocus?: boolean;
  /** City ids to leave out of results (already-added stops). */
  excludeIds?: string[];
  /** Search this list instead of every loaded city. */
  cities?: City[];
  /** Clear the input after a pick (default true). Set false to show the picked name. */
  clearOnPick?: boolean;
  /** Initial text. */
  defaultValue?: string;
  size?: "sm" | "md";
  limit?: number;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

/**
 * Combobox over the loaded cities (useMeridianStore.cities), airport cities first.
 * Arrow keys move, Enter picks, Esc closes the list (and only the list).
 */
export function CitySearch({
  onPick,
  placeholder = "Search cities or airports",
  id,
  autoFocus,
  excludeIds,
  cities: citiesProp,
  clearOnPick = true,
  defaultValue = "",
  size = "md",
  limit = 8,
  disabled,
  inputRef,
  className,
  ...aria
}: CitySearchProps) {
  const storeCities = useMeridianStore((s) => s.cities);
  const cities = citiesProp ?? storeCities;
  const [q, setQ] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const auto = useId();
  const listId = `${id ?? auto}-list`;
  const blurTimer = useRef<number | undefined>(undefined);

  const exclude = useMemo(() => (excludeIds?.length ? new Set(excludeIds) : undefined), [excludeIds]);
  const results = useMemo(() => searchCities(cities, q, limit, exclude), [cities, q, limit, exclude]);
  const showList = open && results.length > 0;
  const noMatch = open && q.trim().length >= 2 && results.length === 0;

  const pick = (c: City) => {
    onPick(c);
    setQ(clearOnPick ? "" : c.name);
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      if (showList && results[active]) {
        e.preventDefault();
        pick(results[active]);
      }
    } else if (e.key === "Escape") {
      if (showList || q) {
        // Keep Esc for the list; the sheet underneath stays open.
        e.preventDefault();
        e.stopPropagation();
        if (showList) setOpen(false);
        else setQ("");
      }
    }
  };

  return (
    <div className={cx("ui-combo", className)}>
      <span className="ui-input-wrap">
        <span className="ui-input-icon" aria-hidden="true">
          <IconSearch size={16} />
        </span>
        <input
          ref={inputRef}
          id={id}
          className={cx("ui-input", `ui-input--${size}`, "ui-input--with-icon")}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => {
            window.clearTimeout(blurTimer.current);
            setOpen(true);
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={onKeyDown}
          {...aria}
        />
      </span>
      <ul id={listId} role="listbox" className="ui-combo-list" hidden={!showList} aria-label="Cities">
        {results.map((c, i) => (
          <li
            key={c.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={cx("ui-combo-option", i === active && "ui-combo-option--active")}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(c)}
          >
            <span className="ui-combo-name">{c.name}</span>
            <span className="ui-combo-country">{c.country}</span>
            {c.iata ? <span className="ui-combo-iata iata">{c.iata}</span> : null}
          </li>
        ))}
      </ul>
      {noMatch ? (
        <div className="ui-combo-empty" role="status">
          {cities.length ? "No matching city" : "Loading cities…"}
        </div>
      ) : null}
    </div>
  );
}
