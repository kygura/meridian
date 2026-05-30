import { useChat } from "ai/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../store";
import type { City, LayerKey } from "../types";

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

const LAYER_COMMANDS: { key: LayerKey; label: string }[] = [
  { key: "weather", label: "WEATHER" },
  { key: "stability", label: "STABILITY" },
  { key: "density", label: "DENSITY" },
  { key: "tourism", label: "TOURISM" },
  { key: "cost", label: "COST" },
  { key: "routes", label: "ROUTES" },
  { key: "cities", label: "CITIES" },
  { key: "conflict", label: "CONFLICT" },
  { key: "disaster", label: "DISASTER" },
];

export default function CommandPalette() {
  const {
    commandOpen,
    setCommandOpen,
    cities,
    selectCity,
    toggleLayer,
    layers,
    addCityToActiveTrip,
    addToShortlist,
    shortlist,
  } = useMeridianStore();

  const [query, setQuery] = useState("");
  const [cityResults, setCityResults] = useState<City[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const { messages, append, isLoading } = useChat({ api: "/api/agent/chat" });

  // City-name index for turning agent prose into clickable chips.
  const cityIndex = useMemo(() => {
    const m = new Map<string, City>();
    for (const c of cities) {
      const key = c.name.toLowerCase();
      if (key.length >= 4 && !m.has(key)) m.set(key, c);
    }
    return m;
  }, [cities]);

  // Focus input on open; reset state on close.
  useEffect(() => {
    if (commandOpen) {
      setTimeout(() => inputRef.current?.focus(), 20);
    } else {
      setQuery("");
      setCityResults([]);
      setSel(0);
    }
  }, [commandOpen]);

  // Debounced city search.
  useEffect(() => {
    if (!commandOpen) return;
    const q = query.trim();
    if (q.length < 2) {
      setCityResults([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`/api/cities/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d) => setCityResults((d?.cities ?? []).slice(0, 8)))
        .catch(() => setCityResults([]));
    }, 160);
    return () => clearTimeout(t);
  }, [query, commandOpen]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages]);

  const commands: Command[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Command[] = LAYER_COMMANDS.map((l) => ({
      id: `layer-${l.key}`,
      label: `${layers[l.key] ? "Hide" : "Show"} ${l.label} layer`,
      hint: layers[l.key] ? "ON" : "OFF",
      run: () => toggleLayer(l.key),
    }));
    if (!q) return all.slice(0, 4);
    return all.filter((c) => c.label.toLowerCase().includes(q));
  }, [query, layers, toggleLayer]);

  const ask = () => {
    const q = query.trim();
    if (!q || isLoading) return;
    append({ role: "user", content: q });
    setQuery("");
    setCityResults([]);
    setSel(0);
  };

  const inspect = (c: City | { id: string }) => {
    selectCity(c.id);
    setCommandOpen(false);
  };

  const addTrip = (c: City) => {
    addCityToActiveTrip({
      cityId: c.id,
      name: c.name,
      iata: c.iata,
      lat: c.lat,
      lng: c.lng,
    });
  };

  const save = (c: City) => {
    if (shortlist.some((s) => s.cityId === c.id)) return;
    addToShortlist({
      cityId: c.id,
      name: c.name,
      country: c.country,
      lat: c.lat,
      lng: c.lng,
      iata: c.iata,
      addedAt: new Date().toISOString(),
      score: undefined,
    });
    fetch("/api/shortlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cityId: c.id }),
    }).catch(() => {});
  };

  // Flat list of selectable rows for keyboard nav.
  const rows = useMemo(() => {
    const r: Array<{ kind: "ask" | "command" | "city"; idx: number }> = [];
    if (query.trim()) r.push({ kind: "ask", idx: 0 });
    commands.forEach((_, i) => r.push({ kind: "command", idx: i }));
    cityResults.forEach((_, i) => r.push({ kind: "city", idx: i }));
    return r;
  }, [query, commands, cityResults]);

  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "ask") ask();
    else if (row.kind === "command") commands[row.idx].run();
    else inspect(cityResults[row.idx]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setCommandOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(0, rows.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows.length) activate(Math.min(sel, rows.length - 1));
      else ask();
    }
  };

  useEffect(() => setSel(0), [query]);

  if (!commandOpen) return null;

  const showResults = query.trim().length > 0;
  let rowCursor = 0;

  return (
    <div className="cmd-overlay" onMouseDown={() => setCommandOpen(false)}>
      <div className="cmd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmd-input-row">
          <span className="cmd-prompt">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search cities, toggle layers, or ask Meridian…"
          />
          {isLoading && <span className="cmd-loading">·thinking·</span>}
        </div>

        <div className="cmd-body" ref={transcriptRef}>
          {showResults ? (
            <>
              {/* Ask row */}
              {(() => {
                const i = rowCursor++;
                return (
                  <div
                    className={`cmd-row ask ${sel === i ? "sel" : ""}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={ask}
                  >
                    <span className="cmd-row-main">Ask Meridian: “{query.trim()}”</span>
                    <span className="cmd-row-hint">↵</span>
                  </div>
                );
              })()}

              {commands.length > 0 && <div className="cmd-section">COMMANDS</div>}
              {commands.map((c) => {
                const i = rowCursor++;
                return (
                  <div
                    key={c.id}
                    className={`cmd-row ${sel === i ? "sel" : ""}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => c.run()}
                  >
                    <span className="cmd-row-main">{c.label}</span>
                    <span className="cmd-row-hint">{c.hint}</span>
                  </div>
                );
              })}

              {cityResults.length > 0 && <div className="cmd-section">CITIES</div>}
              {cityResults.map((c) => {
                const i = rowCursor++;
                return (
                  <div
                    key={c.id}
                    className={`cmd-row city ${sel === i ? "sel" : ""}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => inspect(c)}
                  >
                    <span className="cmd-iata">{c.iata || "—"}</span>
                    <span className="cmd-row-main">
                      {c.name}
                      <span className="cmd-country"> · {c.country}</span>
                    </span>
                    <span className="cmd-actions">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          addTrip(c);
                        }}
                        title="Add to active trip"
                      >
                        +TRIP
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          save(c);
                        }}
                        title="Save to shortlist"
                      >
                        ★
                      </button>
                    </span>
                  </div>
                );
              })}
            </>
          ) : messages.length > 0 ? (
            <div className="cmd-chat">
              {messages.map((m) => (
                <div key={m.id} className={`cmd-msg ${m.role}`}>
                  <div className="cmd-msg-text">{m.content}</div>
                  {m.role === "assistant" && (
                    <CityChips text={m.content} index={cityIndex} onPick={inspect} />
                  )}
                </div>
              ))}
              {isLoading && <div className="cmd-msg assistant cmd-msg-pending">…</div>}
            </div>
          ) : (
            <div className="cmd-empty">
              <div className="cmd-empty-title">MERIDIAN CONSOLE</div>
              <div className="cmd-empty-sub">
                Type a city to inspect it, a layer to toggle, or a question to ask
                the agent. ↑↓ to navigate · ↵ to run · esc to close.
              </div>
              <div className="cmd-chips">
                {["Where is cheapest in Asia now?", "Safe cities near the equator", "Plan a 3-stop autumn trip"].map(
                  (s) => (
                    <button
                      key={s}
                      className="cmd-suggest"
                      onClick={() => {
                        append({ role: "user", content: s });
                      }}
                    >
                      {s}
                    </button>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CityChips({
  text,
  index,
  onPick,
}: {
  text: string;
  index: Map<string, City>;
  onPick: (c: City) => void;
}) {
  const found = useMemo(() => {
    const lower = text.toLowerCase();
    const hits: City[] = [];
    const seen = new Set<string>();
    for (const [name, city] of index) {
      if (lower.includes(name) && !seen.has(city.id)) {
        seen.add(city.id);
        hits.push(city);
        if (hits.length >= 6) break;
      }
    }
    return hits;
  }, [text, index]);

  if (!found.length) return null;
  return (
    <div className="cmd-msg-chips">
      {found.map((c) => (
        <button key={c.id} className="cmd-citychip" onClick={() => onPick(c)}>
          {c.iata || c.name} <span>{c.name}</span>
        </button>
      ))}
    </div>
  );
}
