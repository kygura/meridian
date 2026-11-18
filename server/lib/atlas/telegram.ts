// The Atlas Telegram bot's command parser and the request it hands the routine (ADR 0020).
// Pure: no I/O. server/routes/atlasTelegram.ts receives the webhook and does the sending.

export interface ParsedRange {
  min: number | null;
  max: number | null;
}

export interface ParsedCommand {
  name: string;
  raw_args: string | null;
  destination_focus: string[];
  activity_types: string[];
  stay_duration_days: ParsedRange | null;
  budget_range_eur: ParsedRange | null;
  origin: string | null;
  preferred_origins: string[];
  notes: string[];
}

const SEARCH_COMMANDS = new Set(["scout", "trip", "plan", "search"]);
const DISCOVERY_COMMANDS = new Set(["discover", "discovery", "findme"]);
const WATCH_COMMANDS = new Set(["watch", "track", "remind"]);
const HELP_COMMANDS = new Set(["help", "start"]);

type ArgKey = "destination" | "activity" | "days" | "budget" | "origin";

const ARG_KEY_ALIASES: Record<string, ArgKey> = {
  destination: "destination",
  to: "destination",
  dest: "destination",
  activity: "activity",
  activities: "activity",
  type: "activity",
  trip: "activity",
  vibe: "activity",
  days: "days",
  nights: "days",
  duration: "days",
  length: "days",
  budget: "budget",
  price: "budget",
  maxbudget: "budget",
  origin: "origin",
  from: "origin",
  depart: "origin",
};

export const COMMAND_HELP_TEXT = `Atlas commands

/scout: steer the next search with flexible arguments. Aliases: /trip, /plan, /search
/discover: run Discovery Mode now: rank fresh destinations by weather, season, conditions and price signal without a full trip plan. Aliases: /discovery, /findme
/watch: add a destination to your watchlist; Atlas notifies you here when a deal appears. Aliases: /track, /remind
/help: show this message

Arguments (any combination, any order):
destination:<place>: e.g. destination:Portugal or to:Bali
activity:<type>: e.g. activity:surf or activity:relax,cultural-travel
days:<n> or days:<min>-<max>: stay length, e.g. days:7-10
budget:<n>, budget:<min>-<max>, budget:<1500 or budget:800+: price range in EUR
origin:<IATA>: departure airport, e.g. origin:MAD

Examples
/scout destination:Portugal activity:surf days:7-10 budget:800-1500 origin:MAD
/discover activity:surf
/watch destination:Thailand budget:<1500

Plain messages without a leading "/" are also understood: describe what you want in your own words, including things like "add Thailand to my watchlist and notify me of deals".`;

function parseRange(raw: string): ParsedRange | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lte = trimmed.match(/^<=?\s*(\d+(?:\.\d+)?)$/);
  if (lte) return { min: null, max: Number(lte[1]) };

  const gte = trimmed.match(/^>=?\s*(\d+(?:\.\d+)?)$/);
  if (gte) return { min: Number(gte[1]), max: null };

  const plus = trimmed.match(/^(\d+(?:\.\d+)?)\+$/);
  if (plus) return { min: Number(plus[1]), max: null };

  const between = trimmed.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (between) {
    const min = Number(between[1]);
    const max = Number(between[2]);
    return min <= max ? { min, max } : { min: max, max: min };
  }

  const single = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (single) return { min: null, max: Number(single[1]) };

  return null;
}

function tokenize(argsText: string): string[] {
  if (!argsText.trim()) return [];
  return argsText.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").trim();
}

function emptyParsed(name: string, rawArgs: string | null): ParsedCommand {
  return {
    name,
    raw_args: rawArgs,
    destination_focus: [],
    activity_types: [],
    stay_duration_days: null,
    budget_range_eur: null,
    origin: null,
    preferred_origins: [],
    notes: [],
  };
}

/**
 * Parses a Telegram bot command (leading "/") into structured search steering arguments.
 * Returns null when the text is not a recognized command, so callers can fall back to
 * free-text handling.
 */
export function parseTelegramCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const firstSpace = trimmed.search(/\s/);
  const commandToken = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const name = commandToken.split("@")[0].toLowerCase();
  const argsText = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  if (HELP_COMMANDS.has(name)) return emptyParsed("help", argsText || null);

  if (!SEARCH_COMMANDS.has(name) && !DISCOVERY_COMMANDS.has(name) && !WATCH_COMMANDS.has(name)) return null;

  const result = emptyParsed(name, argsText || null);

  for (const token of tokenize(argsText)) {
    const match = token.match(/^([a-zA-Z_]+)[:=](.+)$/);
    if (!match) {
      const note = stripQuotes(token);
      if (note) result.notes.push(note);
      continue;
    }

    const [, rawKey, rawValue] = match;
    const key = ARG_KEY_ALIASES[rawKey.toLowerCase()];
    const value = stripQuotes(rawValue);
    if (!key || !value) {
      result.notes.push(stripQuotes(token));
      continue;
    }

    switch (key) {
      case "destination":
        result.destination_focus.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
        break;
      case "activity":
        result.activity_types.push(...value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
        break;
      case "days":
        result.stay_duration_days = parseRange(value);
        break;
      case "budget":
        result.budget_range_eur = parseRange(value);
        break;
      case "origin": {
        const codes = value.split(",").map((part) => part.trim()).filter(Boolean);
        for (const code of codes) {
          if (/^[a-zA-Z]{3}$/.test(code)) result.preferred_origins.push(code.toUpperCase());
          else result.notes.push(`origin: ${code}`);
        }
        if (result.preferred_origins.length === 1 && codes.length === 1) result.origin = result.preferred_origins[0];
        break;
      }
    }
  }

  return result;
}

// ── The routine request ──────────────────────────────────────────────

export interface TelegramMessage {
  chat?: { id?: number | string };
  from?: { id?: number; username?: string; language_code?: string };
  message_id?: number;
  text?: string;
  caption?: string;
  photo?: { file_id: string; width?: number; height?: number }[];
  location?: { latitude: number; longitude: number };
}

/** The routine's mode for a command: discovery for /discover and its aliases, a scan for the rest. */
export function modeForCommand(command: ParsedCommand | null): "scan" | "discover" {
  return command && DISCOVERY_COMMANDS.has(command.name) ? "discover" : "scan";
}

/** Longest stretch of a message the routine request keeps. The request text may hold 2,000 characters. */
export const MAX_MESSAGE_CHARS = 500;
const MAX_ROUTINE_TEXT = 2000;

/** The message cut to MAX_MESSAGE_CHARS. */
export const clipMessage = (s: string): string => (s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS - 3)}...` : s);

/** What the routine reads as `execution_context` (Atlas CLAUDE.md, "Determine Mode"). */
export function buildExecutionContext(message: TelegramMessage, command: ParsedCommand | null, text: string) {
  const photos = message.photo;
  const photoFileId = photos?.length ? photos[photos.length - 1].file_id : null;
  const chatId = message.chat?.id != null ? String(message.chat.id) : null;
  return {
    trigger_source: "telegram",
    origin_interface: "telegram",
    request_text: text || null,
    defaulted_params: [] as string[],
    context_summary: [] as string[],
    resolved_origin: command?.origin ?? null,
    user_context: {
      location_label: null,
      preferred_origins: command?.preferred_origins ?? [],
      max_budget_eur: command?.budget_range_eur?.max ?? null,
      destination_focus: command?.destination_focus ?? [],
      preference_tags: command?.notes ?? [],
      notes: command?.notes ?? [],
      activity_types: command?.activity_types ?? [],
      stay_duration_days: command?.stay_duration_days ?? null,
      budget_range_eur: command?.budget_range_eur ?? null,
    },
    command: command ? { name: command.name, raw_args: command.raw_args } : null,
    telegram: chatId
      ? {
          chat_id: chatId,
          message_id: message.message_id ?? null,
          user_id: message.from?.id ?? null,
          username: message.from?.username ?? null,
          language_code: message.from?.language_code ?? null,
          photo_file_id: photoFileId,
          location: message.location ? { latitude: message.location.latitude, longitude: message.location.longitude } : null,
        }
      : null,
  };
}

/**
 * The input for fireRoutine: the mode, and a text that carries the original message followed by
 * the execution context as a JSON block. `text` is the message, already cut with clipMessage, and
 * `command` was parsed from it. The whole text stays within the 2,000 characters a run request
 * allows: when it would not, repeated fields are dropped (the message is already in the text
 * above the block) so the JSON is never cut in the middle.
 */
export function buildRoutineRequest(message: TelegramMessage, command: ParsedCommand | null, text: string): { mode: "scan" | "discover"; text: string } {
  const ctx = buildExecutionContext(message, command, text);
  const render = () => `${text || "(no text)"}\n\nexecution_context:\n${JSON.stringify(ctx)}`;
  const reductions: (() => void)[] = [
    () => (ctx.request_text = null),
    () => (ctx.user_context.preference_tags = []),
    () => {
      ctx.user_context.notes = [];
      if (ctx.command) ctx.command.raw_args = null;
    },
  ];
  for (const reduce of reductions) {
    if (render().length <= MAX_ROUTINE_TEXT) break;
    reduce();
  }
  return { mode: modeForCommand(command), text: render() };
}
