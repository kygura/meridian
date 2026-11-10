import { useMemo } from "react";
import { Badge, Button, Chip, Spinner, UnlockCard } from "../../ui";
import { IconInbox, IconPin, IconSparkle } from "../../ui/icons";
import { hrefFor } from "../../lib/router";
import type { City, PlaceResult } from "../../types";
import {
  draftOutcome,
  findCityMentions,
  journalLocked,
  matchCard,
  pendingActivities,
  placeImages,
  proseBlocks,
  replayMatches,
  searchedPlaces,
  type CityNameIndex,
  type ToolCall,
} from "./askText";

export interface AskMessageModel {
  id: string;
  role: string;
  content: string;
  toolInvocations?: ToolCall[];
}

export interface AskMessageProps {
  message: AskMessageModel;
  names: CityNameIndex;
  unlocked: boolean;
  /** Still streaming into this message. */
  live: boolean;
  /** Last assistant message, not streaming: may offer trip ideas. */
  offerIdeas: boolean;
  ideasBusy: boolean;
  onCity: (cityId: string) => void;
  onIdeas: (city: { id: string; name: string }) => void;
  /** Links inside a message (inbox) close the phone sheet. */
  onNavigate: () => void;
}

/** One chat turn. Assistant turns add photos, place chips, match cards, a locked notice and draft links. */
export default function AskMessage({ message: m, names, unlocked, live, offerIdeas, ideasBusy, onCity, onIdeas, onNavigate }: AskMessageProps) {
  const calls = m.toolInvocations;
  const blocks = useMemo(() => proseBlocks(m.content), [m.content]);
  const matches = useMemo(() => replayMatches(calls), [calls]);
  const images = useMemo(() => placeImages(calls), [calls]);
  const chips = useMemo(() => {
    if (m.role !== "assistant") return [];
    const skip = new Set(matches.map((p) => p.cityId));
    const out: Array<{ id: string; name: string }> = [];
    const add = (c: { id: string; name: string }) => {
      if (skip.has(c.id) || out.some((x) => x.id === c.id)) return;
      out.push(c);
    };
    for (const p of searchedPlaces(calls)) add({ id: p.cityId, name: p.name });
    for (const c of findCityMentions(m.content, names, 8)) add({ id: c.id, name: (c as City).name });
    return out.slice(0, 6);
  }, [m.role, m.content, calls, names, matches]);

  if (m.role === "user") {
    return (
      <li className="ask-msg ask-msg--user">
        <p className="ask-bubble">{m.content}</p>
      </li>
    );
  }

  const activities = live ? pendingActivities(calls) : [];
  const locked = !unlocked && journalLocked(calls);
  const draft = draftOutcome(calls);
  const focus = chips[0] ?? (matches[0] ? { id: matches[0].cityId, name: matches[0].name } : undefined);

  return (
    <li className="ask-msg ask-msg--assistant">
      {blocks.length > 0 && (
        <div className="ask-prose">
          {blocks.map((b, i) =>
            b.type === "p" ? (
              <p key={i}>{b.text}</p>
            ) : (
              <ul key={i}>
                {b.items.map((t, j) => (
                  <li key={j}>{t}</li>
                ))}
              </ul>
            )
          )}
        </div>
      )}

      {activities.length > 0 && (
        <p className="ask-activity" role="status">
          <Spinner size={14} />
          <span>{activities.join(" · ")}</span>
        </p>
      )}

      {images.length > 0 && (
        <div className="ask-photos">
          {images.slice(0, 3).map((img) => (
            <a key={img.url} className="ask-photo" href={img.sourcePage} target="_blank" rel="noreferrer" title={img.attribution}>
              <img src={img.thumbUrl || img.url} alt={img.title} loading="lazy" />
            </a>
          ))}
        </div>
      )}

      {matches.length > 0 && (
        <ul className="ask-matches" aria-label="Similar places">
          {matches.map((p) => (
            <MatchRow key={`${p.cityId}:${p.replayMatch?.month}`} place={p} onPick={() => onCity(p.cityId)} />
          ))}
        </ul>
      )}

      {chips.length > 0 && (
        <div className="ask-chips" aria-label="Places mentioned">
          {chips.map((c) => (
            <Chip key={c.id} icon={<IconPin size={14} />} onClick={() => onCity(c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>
      )}

      {locked && <UnlockCard compact title="Sign in so Ask can read your past trips" />}

      {draft && draft.pending && (
        <a className="ask-link" href={hrefFor({ view: "inbox" })} onClick={onNavigate}>
          <IconInbox size={16} />
          {draft.drafted > 0 ? "Drafted to your inbox. Review it" : "Already waiting in your inbox. Review it"}
        </a>
      )}

      {offerIdeas && focus && (
        <div className="ask-ideas-offer">
          <Button size="sm" variant="ghost" icon={<IconSparkle size={16} />} loading={ideasBusy} onClick={() => onIdeas(focus)}>
            Trip ideas around {focus.name}
          </Button>
        </div>
      )}
    </li>
  );
}

function MatchRow({ place, onPick }: { place: PlaceResult; onPick: () => void }) {
  const c = matchCard(place);
  if (!c) return null;
  return (
    <li>
      <button type="button" className="ask-match" onClick={onPick} aria-label={`${place.name}, ${c.month}: ${c.match}% match. Open city.`}>
        <span className="ask-match-main">
          <span className="ask-match-name">
            {place.name}
            <span className="ask-match-country">, {place.country}</span>
          </span>
          <span className="ask-match-meta">
            {c.month}
            {c.closest ? ` · ${c.closest}` : ""}
          </span>
        </span>
        <span className="ask-match-side">
          {c.mock && <Badge tone="warning">Mock</Badge>}
          <span className="ask-match-score num">{c.match}%</span>
        </span>
      </button>
    </li>
  );
}
