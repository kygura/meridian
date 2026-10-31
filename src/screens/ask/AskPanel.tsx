import "./ask.css";
import { useChat } from "ai/react";
import { useEffect, useLayoutEffect, useMemo, useRef, type FormEvent, type KeyboardEvent } from "react";
import { Chip, ErrorState, IconButton, Sheet, Textarea, toast, useJournalToken } from "../../ui";
import { IconAsk, IconClose, IconEdit, IconSend, IconSparkle } from "../../ui/icons";
import { apiUrl } from "../../lib/api";
import { bearerHeaders } from "../../lib/replayMatch";
import { navigate } from "../../lib/router";
import { useMeridianStore } from "../../store";
import { openCity, useUIStore } from "../../shell/uiStore";
import AskMessage, { type AskMessageModel } from "./AskMessage";
import TripIdeas from "./TripIdeas";
import { cityNameIndex } from "./askText";
import { useTripIdeas } from "./tripIdeas";

export interface AskPanelProps {
  /**
   * "docked": rendered by the shell inside the 400px right column (>= 900px). Fill it
   * (flex column, input pinned at the bottom) and render your own header with a close button.
   * "sheet": phones. Wrap your content in <Sheet open onClose={onClose} title="Ask">.
   */
  mode: "docked" | "sheet";
  /** uiStore.closeAsk. */
  onClose: () => void;
}

/** One id for the whole app: the thread survives closing the panel and switching between dock and sheet. */
const CHAT_ID = "meridian-ask";

const PROMPTS = [
  "Where is affordable in Asia right now?",
  "Safe cities near the equator",
  "Somewhere like my last trip but warmer",
  "Plan a three-stop autumn trip in Europe",
];

/** Global chat panel (DESIGN-v3 §6 Ask). Mounted by AppShell only while uiStore.ask.open. */
export default function AskPanel({ mode, onClose }: AskPanelProps) {
  const { token, unlocked } = useJournalToken();
  const cities = useMeridianStore((s) => s.cities);
  const names = useMemo(() => cityNameIndex(cities), [cities]);
  const prefill = useUIStore((s) => s.ask.prefill);
  const nonce = useUIStore((s) => s.ask.nonce);
  const ideas = useTripIdeas();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Journal tools only run when the request carries the token; headers are re-read on every request.
  const { messages, input, setInput, append, status, error, reload, stop, setMessages } = useChat({
    id: CHAT_ID,
    api: apiUrl("/api/agent/chat"),
    headers: bearerHeaders(unlocked ? token : null),
    experimental_throttle: 50,
  });
  const busy = status === "submitted" || status === "streaming";

  // Prefill from openAsk(prompt): put it in the input (not sent), focus, then clear it in the store.
  useEffect(() => {
    if (prefill === undefined) {
      if (mode === "docked") inputRef.current?.focus({ preventScroll: true });
      return;
    }
    setInput(prefill);
    useUIStore.getState().consumeAskPrefill();
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, nonce]);

  // Grow the input with its content, up to the CSS max height.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Keep the newest turn in view while it streams.
  const last = messages[messages.length - 1];
  const scroller = () => endRef.current?.closest<HTMLElement>(".ask-thread, .ui-sheet-body") ?? null;
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    // A new turn always scrolls; streaming text only while the reader is already near the bottom.
    stick.current = true;
  }, [messages.length]);
  useEffect(() => {
    const el = scroller();
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content, last?.toolInvocations?.length, status, ideas.status]);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    void append({ role: "user", content: q });
    setInput("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  };

  const showCity = (id: string) => {
    if (mode === "sheet") onClose();
    openCity(id);
  };

  const newChat = () => {
    stop();
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const waiting = status === "submitted" && last?.role === "user";

  const thread = (
    <div className="ask-thread-inner">
      {messages.length === 0 ? (
        <div className="ask-intro">
          <span className="ask-intro-icon" aria-hidden="true">
            <IconAsk size={24} />
          </span>
          <p className="ask-intro-title">Ask about places, seasons and prices</p>
          <p className="ask-intro-desc">
            {unlocked ? "Ask can also look through your past trips to find places like them." : "Unlock your journal in Settings and Ask can compare places with your past trips."}
          </p>
          <div className="ask-prompts" aria-label="Suggested questions">
            {PROMPTS.map((p) => (
              <Chip key={p} icon={<IconSparkle size={14} />} onClick={() => send(p)}>
                {p}
              </Chip>
            ))}
          </div>
        </div>
      ) : (
        <ol className="ask-thread-list" aria-label="Conversation">
          {messages.map((m) => (
            <AskMessage
              key={m.id}
              message={m as AskMessageModel}
              names={names}
              unlocked={unlocked}
              live={busy && m === last}
              offerIdeas={!busy && m === lastAssistant && m === last}
              ideasBusy={ideas.status === "loading"}
              onCity={showCity}
              onIdeas={(c) => void ideas.request(c.id, c.name)}
              onNavigate={() => mode === "sheet" && onClose()}
            />
          ))}
          {waiting && (
            <li className="ask-msg ask-msg--assistant" role="status" aria-label="Ask is thinking">
              <span className="ask-typing" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </li>
          )}
        </ol>
      )}
      {error && !busy && <ErrorState message="Ask couldn't answer that." onRetry={() => void reload()} />}
      <TripIdeas
        onKeep={(id, name) => {
          toast(`Kept “${name}”`, {
            tone: "success",
            action: {
              label: "Open",
              onClick: () => {
                if (mode === "sheet") onClose();
                navigate({ view: "trips", tab: "upcoming", tripId: id });
              },
            },
          });
        }}
      />
      <div ref={endRef} className="ask-end" />
    </div>
  );

  const composer = (
    <form className="ask-composer" onSubmit={onSubmit}>
      <Textarea
        ref={inputRef}
        rows={1}
        className="ask-input"
        aria-label="Message"
        placeholder="Ask about a place, a month or a past trip"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <IconButton variant="secondary" label="Stop" icon={<IconClose size={18} />} onClick={() => stop()} />
      ) : (
        <IconButton type="submit" variant="primary" label="Send" icon={<IconSend size={18} />} disabled={!input.trim()} />
      )}
    </form>
  );

  const newChatButton = messages.length > 0 ? <IconButton size="sm" label="New chat" icon={<IconEdit size={18} />} onClick={newChat} /> : null;

  if (mode === "sheet") {
    return (
      <Sheet open onClose={onClose} title="Ask" size="lg" headerExtra={newChatButton} footer={composer} className="ask-sheet">
        {thread}
      </Sheet>
    );
  }

  return (
    <div className="ask-docked">
      <header className="ask-docked-head">
        <h2>Ask</h2>
        <div className="ask-docked-tools">
          {newChatButton}
          <IconButton label="Close" icon={<IconClose />} onClick={onClose} />
        </div>
      </header>
      <div className="ask-thread">
        {thread}
      </div>
      <div className="ask-docked-foot">{composer}</div>
    </div>
  );
}
