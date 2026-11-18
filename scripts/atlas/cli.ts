// Terminal interface to the Meridian Atlas API. Run as `npm run atlas -- <command>`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientFromEnv,
  MeridianError,
  NOTICE_KINDS,
  type AtlasConfigPatch,
  type DiscoveryInput,
  type MeridianClient,
  type NoticeKind,
  type NotifyInput,
  type ScanInput,
  type SignalInput,
  type TripPlanInput,
  type WishlistEntryInput,
  type WishlistPatch
} from "./client";
import {
  UsageError,
  flagBool,
  flagInt,
  flagList,
  flagString,
  parseArgs,
  parseBudget,
  parseMonths,
  type ParsedArgs
} from "./args";
import { loadLegacyDir } from "./legacy";
import { parsePlaceRef } from "./place";
import {
  renderConfig,
  renderContext,
  renderDiscovery,
  renderFares,
  renderFire,
  renderIdeas,
  renderImport,
  renderNotify,
  renderResearch,
  renderRuns,
  renderScan,
  renderSeasonal,
  renderSignals,
  renderSignalsAdd,
  renderStatus,
  renderTrip,
  renderWishlist,
  renderWishlistPatch,
  renderWishlistUpsert
} from "./render";

export const USAGE = `atlas: terminal client for the Meridian Atlas API

Usage: npm run atlas -- <command> [options]

Commands
  status                              Health, resolved origin, wishlist size, last run
  context [--today YYYY-MM-DD]        What a run starts from: origin, windows, wishlist, trip ideas,
                                      places that need research, recent runs
  ideas                               Wishlist places ranked for window A and window B, with reasons
  research                            Places and months that have no fresh season research
  signals [--city <cityId>]           Stored season research (quiet, conditions, events)
  signals add <file|->                Store season research: { "signals": [...] } or a JSON array
  seasonal --months 1,2 [--vibe a,b] [--profile surf] [--limit 25]
                                      Cities ranked for those months
  config get [dot.path]               Print the config, or one value
  config set <dot.path> <json-value>  Change one value (sent as a PATCH)
  config patch <file|->               Deep-merge a JSON patch file or stdin
  wishlist [ls]                       List the wishlist
  wishlist add <place> [options]      Add or update a place
      --tags a,b  --avoid 7,8  --notes "text"  --scouted  --priority 1-5
      --watch  --budget 800-1500|<1500  --chat <id>
      (--budget and --chat describe a watch and imply --watch)
      --unwatch  turn the place's watch off, keeping the place
  wishlist set <cityId> [options]     Change fields of a place already on the wishlist
      --priority 1-5  --tags a,b  --avoid 7,8  --notes "text" (empty clears)
      --watch  --budget ...  --chat <id>  --unwatch (removes the watch)
  wishlist rm <cityId>                Remove a place
  watch <place> [--budget ...] [--chat id] [--tags a,b]
                                      Shorthand for wishlist add --watch
  scan <file|->                       Score a scan (ScanInput JSON)
  discover <file|->                   Score discovery candidates (DiscoveryInput JSON)
  trip <file|->                       Save a trip plan (TripPlanInput JSON)
  notify <file|->                     Raise a notice (NotifyInput JSON)
  notify --kind <kind> --title "..." (--body "..." | --body-file path) [--url u] [--dedupe-key k]
                                      Kinds: ${NOTICE_KINDS.join(", ")}
  run [--mode scan|discover|research] [--text "..."]
                                      Start the Atlas routine now through the server's trigger.
                                      Exits 1 when the trigger is not set up or refuses the request
  runs [--limit N]                    Recent run summaries
  fares <ROUTE>                       One route's baseline and fares, e.g. MAD-LIS
  import --dir <path> [--dry-run]     Migrate the old Atlas repository's data. <path> is the
                                      legacy folder of a checkout, for example /path/to/atlas/legacy
                                      (it holds config/ and data/)
  help                                Show this text

Places
  MAD              three uppercase letters: an airport code
  lisbon-portugal  lowercase words joined by hyphens: a Meridian city id
  "Lisbon"         anything else: a name to search

Global options
  --json         Print the raw JSON response instead of a summary
  --url <url>    Meridian base URL (default: MERIDIAN_URL)
  --token <t>    Bearer token (default: MERIDIAN_TOKEN)

Exit code is 0 on success and 1 on any error. Errors go to stderr.
`;

export interface CliDeps {
  out: (text: string) => void;
  err: (text: string) => void;
  readFile: (path: string) => string;
  readStdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  cwd: () => string;
  makeClient: (overrides: { url?: string; token?: string }) => MeridianClient;
}

export function defaultDeps(): CliDeps {
  const env = process.env;
  return {
    out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
    err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
    readFile: (p) => readFileSync(p, "utf8"),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    env,
    cwd: () => process.cwd(),
    makeClient: (overrides) => clientFromEnv(overrides, env)
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

async function readJsonInput(src: string | undefined, deps: CliDeps, what: string): Promise<unknown> {
  if (!src) throw new UsageError(`${what}: give a JSON file path, or - to read stdin.`);
  const text = src === "-" ? await deps.readStdin() : deps.readFile(src);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what}: ${src === "-" ? "stdin" : src} is not valid JSON (${(e as Error).message}).`);
  }
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`${what}: expected a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** Builds { a: { b: value } } from "a.b". */
export function nestedPatch(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split(".").filter((k) => k.length > 0);
  if (keys.length === 0) throw new UsageError("A dot path such as hardFilters.maxStops is required.");
  let patch: unknown = value;
  for (let i = keys.length - 1; i >= 0; i--) patch = { [keys[i] as string]: patch };
  return patch as Record<string, unknown>;
}

export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function getAtPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".").filter((k) => k.length > 0)) {
    if (cur === null || typeof cur !== "object") throw new UsageError(`Nothing at "${path}" (stopped at "${key}").`);
    const next = (cur as Record<string, unknown>)[key];
    if (next === undefined) throw new UsageError(`Nothing at "${path}" (no "${key}").`);
    cur = next;
  }
  return cur;
}

function printJson(deps: CliDeps, value: unknown): void {
  deps.out(JSON.stringify(value, null, 2));
}

function flagPriority(args: ParsedArgs): number | undefined {
  const priority = flagInt(args, "priority");
  if (priority !== undefined && (priority < 1 || priority > 5)) throw new UsageError("--priority expects a whole number from 1 to 5.");
  return priority;
}

/** Fields of PATCH /api/atlas/wishlist/:cityId from the flags. Null removes the watch or the notes. */
function buildWishlistPatch(args: ParsedArgs): WishlistPatch {
  const patch: WishlistPatch = {};
  const priority = flagPriority(args);
  if (priority !== undefined) patch.priority = priority;
  const tags = flagList(args, "tags");
  if (tags) patch.intentTags = tags;
  const avoid = flagString(args, "avoid");
  if (avoid !== undefined) patch.avoidMonths = parseMonths(avoid, "avoid");
  const notes = flagString(args, "notes");
  if (notes !== undefined) patch.notes = notes === "" ? null : notes;
  const budget = flagString(args, "budget");
  const chat = flagString(args, "chat");
  if (flagBool(args, "unwatch")) {
    patch.watch = null;
  } else if (flagBool(args, "watch") || budget !== undefined || chat !== undefined) {
    const watch: NonNullable<WishlistPatch["watch"]> = { active: true };
    if (budget !== undefined) watch.targetBudgetEur = parseBudget(budget);
    if (chat !== undefined) watch.chatId = chat;
    patch.watch = watch;
  }
  if (Object.keys(patch).length === 0) {
    throw new UsageError("wishlist set needs at least one of --priority, --tags, --avoid, --notes, --watch, --budget, --chat, --unwatch.");
  }
  return patch;
}

function buildWishlistEntry(args: ParsedArgs, placeArg: string | undefined, forceWatch: boolean): WishlistEntryInput {
  if (!placeArg) throw new UsageError("A place is required, for example MAD, lisbon-portugal or \"Lisbon\".");
  const entry: WishlistEntryInput = { place: parsePlaceRef(placeArg) };
  entry.source = flagBool(args, "scouted") ? "scouted" : "wished";
  const tags = flagList(args, "tags");
  if (tags) entry.intentTags = tags;
  const avoid = flagString(args, "avoid");
  if (avoid !== undefined) entry.avoidMonths = parseMonths(avoid, "avoid");
  const notes = flagString(args, "notes");
  if (notes !== undefined) entry.notes = notes;
  const priority = flagPriority(args);
  if (priority !== undefined) entry.priority = priority;
  const budget = flagString(args, "budget");
  const chat = flagString(args, "chat");
  if (flagBool(args, "unwatch")) {
    entry.watch = { active: false };
  } else if (forceWatch || flagBool(args, "watch") || budget !== undefined || chat !== undefined) {
    entry.watch = { active: true };
    if (budget !== undefined) entry.watch.targetBudgetEur = parseBudget(budget);
    if (chat !== undefined) entry.watch.chatId = chat;
  }
  return entry;
}

function noticeKind(value: string): NoticeKind {
  if ((NOTICE_KINDS as readonly string[]).includes(value)) return value as NoticeKind;
  throw new UsageError(`Unknown notice kind "${value}". Use one of: ${NOTICE_KINDS.join(", ")}.`);
}

// ── Commands ─────────────────────────────────────────────────────────

type Handler = (args: ParsedArgs, deps: CliDeps) => Promise<void>;

function withClient(args: ParsedArgs, deps: CliDeps): MeridianClient {
  return deps.makeClient({ url: flagString(args, "url"), token: flagString(args, "token") });
}

const handlers: Record<string, Handler> = {
  async status(args, deps) {
    const client = withClient(args, deps);
    const [health, ctx] = await Promise.all([client.health(), client.context()]);
    if (flagBool(args, "json")) return printJson(deps, { health, context: ctx });
    deps.out(renderStatus(health, ctx, client.baseUrl));
  },

  async context(args, deps) {
    const today = flagString(args, "today");
    if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new UsageError("--today expects YYYY-MM-DD.");
    const ctx = await withClient(args, deps).context(today);
    deps.out(flagBool(args, "json") ? JSON.stringify(ctx, null, 2) : renderContext(ctx));
  },

  async ideas(args, deps) {
    const ctx = await withClient(args, deps).context();
    deps.out(flagBool(args, "json") ? JSON.stringify({ windows: ctx.windows, ideas: ctx.ideas }, null, 2) : renderIdeas(ctx));
  },

  async research(args, deps) {
    const ctx = await withClient(args, deps).context();
    deps.out(flagBool(args, "json") ? JSON.stringify(ctx.researchNeeded, null, 2) : renderResearch(ctx.researchNeeded));
  },

  async signals(args, deps) {
    const [sub, ...rest] = args.positionals;
    const client = () => withClient(args, deps);
    if (sub === "add") {
      const raw = await readJsonInput(rest[0], deps, "signals add");
      const list = Array.isArray(raw) ? raw : requireObject(raw, "signals add").signals;
      if (!Array.isArray(list)) throw new UsageError('signals add: expected { "signals": [...] } or a JSON array.');
      const res = await client().addSignals(list as SignalInput[]);
      deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderSignalsAdd(res));
      return;
    }
    if (sub !== undefined) throw new UsageError("Usage: signals [--city <cityId>] | signals add <file|->");
    const res = await client().signals(flagString(args, "city"));
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderSignals(res.signals));
  },

  async run(args, deps) {
    const mode = flagString(args, "mode") ?? "scan";
    if (mode !== "scan" && mode !== "discover" && mode !== "research") {
      throw new UsageError(`--mode expects scan, discover or research (got "${mode}").`);
    }
    const text = flagString(args, "text");
    const res = await withClient(args, deps).fire({ mode, ...(text !== undefined ? { text } : {}) });
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderFire(res.run));
    if (res.run.status === "failed") throw new Error(res.run.detail ?? "The routine was not started.");
  },

  async seasonal(args, deps) {
    const months = flagString(args, "months");
    if (months === undefined) throw new UsageError("seasonal needs --months, for example --months 1,2.");
    const res = await withClient(args, deps).seasonal({
      months: parseMonths(months),
      vibe: flagList(args, "vibe"),
      profile: flagString(args, "profile"),
      limit: flagInt(args, "limit")
    });
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderSeasonal(res));
  },

  async config(args, deps) {
    const [sub, ...rest] = args.positionals;
    if (sub === "get") {
      const res = await withClient(args, deps).getConfig();
      if (rest[0]) return printJson(deps, getAtPath(res.config, rest[0]));
      deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderConfig(res));
      return;
    }
    if (sub === "set") {
      const [path, ...valueParts] = rest;
      if (!path || valueParts.length === 0) throw new UsageError("Usage: config set <dot.path> <json-value>");
      const value = parseConfigValue(valueParts.join(" "));
      const res = await withClient(args, deps).patchConfig(nestedPatch(path, value) as AtlasConfigPatch);
      if (flagBool(args, "json")) return printJson(deps, res);
      deps.out(`Set ${path} = ${JSON.stringify(getAtPath(res.config, path))}`);
      return;
    }
    if (sub === "patch") {
      const patch = requireObject(await readJsonInput(rest[0], deps, "config patch"), "config patch");
      const res = await withClient(args, deps).patchConfig(patch as AtlasConfigPatch);
      deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : `Config patched. Updated ${res.updatedAt ?? "n/a"}.`);
      return;
    }
    throw new UsageError("Usage: config get [dot.path] | config set <dot.path> <json-value> | config patch <file|->");
  },

  async wishlist(args, deps) {
    const [sub = "ls", ...rest] = args.positionals;
    const client = () => withClient(args, deps);
    if (sub === "ls" || sub === "list") {
      const res = await client().listWishlist();
      deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderWishlist(res.entries));
      return;
    }
    if (sub === "add") {
      const res = await client().upsertWishlist([buildWishlistEntry(args, rest[0], false)]);
      deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderWishlistUpsert(res));
      if (res.entries.length === 0 && res.unresolved.length > 0) throw new Error("The place could not be resolved.");
      return;
    }
    if (sub === "set") {
      const cityId = rest[0];
      if (!cityId) throw new UsageError("Usage: wishlist set <cityId> [options]");
      const res = await client().patchWishlist(cityId, buildWishlistPatch(args));
      deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderWishlistPatch(res.entry));
      return;
    }
    if (sub === "rm" || sub === "remove") {
      const cityId = rest[0];
      if (!cityId) throw new UsageError("Usage: wishlist rm <cityId>");
      const res = await client().removeWishlist(cityId);
      deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : res.removed ? `Removed ${cityId}.` : `${cityId} was not on the wishlist.`);
      return;
    }
    throw new UsageError("Usage: wishlist [ls] | wishlist add <place> [options] | wishlist set <cityId> [options] | wishlist rm <cityId>");
  },

  async watch(args, deps) {
    const res = await withClient(args, deps).upsertWishlist([buildWishlistEntry(args, args.positionals[0], true)]);
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderWishlistUpsert(res));
    if (res.entries.length === 0 && res.unresolved.length > 0) throw new Error("The place could not be resolved.");
  },

  async scan(args, deps) {
    const input = requireObject(await readJsonInput(args.positionals[0], deps, "scan"), "scan");
    const res = await withClient(args, deps).scan(input as unknown as ScanInput);
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderScan(res));
  },

  async discover(args, deps) {
    const input = requireObject(await readJsonInput(args.positionals[0], deps, "discover"), "discover");
    const res = await withClient(args, deps).discover(input as unknown as DiscoveryInput);
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderDiscovery(res));
  },

  async trip(args, deps) {
    const input = requireObject(await readJsonInput(args.positionals[0], deps, "trip"), "trip");
    const res = await withClient(args, deps).trip(input as unknown as TripPlanInput);
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderTrip(res));
  },

  async notify(args, deps) {
    let input: NotifyInput;
    const kind = flagString(args, "kind");
    if (kind !== undefined) {
      const title = flagString(args, "title");
      if (!title) throw new UsageError("notify --kind needs --title.");
      const bodyFile = flagString(args, "body-file");
      const bodyText = flagString(args, "body");
      if (bodyFile !== undefined && bodyText !== undefined) throw new UsageError("Use either --body or --body-file, not both.");
      const body = bodyFile !== undefined ? (bodyFile === "-" ? await deps.readStdin() : deps.readFile(bodyFile)) : bodyText ?? "";
      input = { kind: noticeKind(kind), title, body };
      const url = flagString(args, "url");
      const dedupeKey = flagString(args, "dedupe-key");
      if (url !== undefined) input.url = url;
      if (dedupeKey !== undefined) input.dedupeKey = dedupeKey;
    } else {
      input = requireObject(await readJsonInput(args.positionals[0], deps, "notify"), "notify") as unknown as NotifyInput;
    }
    const res = await withClient(args, deps).notify(input);
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderNotify(res));
  },

  async runs(args, deps) {
    const res = await withClient(args, deps).runs(flagInt(args, "limit"));
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderRuns(res));
  },

  async fares(args, deps) {
    const route = args.positionals[0];
    if (!route || !/^[A-Za-z]{3}-[A-Za-z]{3}$/.test(route)) throw new UsageError("Usage: fares <ROUTE>, for example fares MAD-LIS");
    const res = await withClient(args, deps).fares(route.toUpperCase());
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : renderFares(res));
  },

  async import(args, deps) {
    const given = flagString(args, "dir");
    if (!given) {
      throw new UsageError("import needs --dir <path>: the legacy folder of a checkout of the old Atlas repository (it holds config/ and data/).");
    }
    const dir = resolve(deps.cwd(), given);
    const { payload, summary } = loadLegacyDir(dir);
    const counts = [
      `Legacy directory: ${dir}`,
      `Config sections: ${summary.configSections.length ? summary.configSections.join(", ") : "none"}`,
      `Wishlist entries: ${summary.wishlist.entries} (${summary.wishlist.duplicates} duplicate IATA merged, ${summary.wishlist.skipped} skipped)`,
      `Fares: ${summary.fares.fares} from ${summary.fares.scanFiles} scan files (${summary.fares.skipped} results skipped)`
    ].join("\n");
    if (flagBool(args, "dry-run")) {
      if (flagBool(args, "json")) return printJson(deps, { dryRun: true, summary, payload });
      deps.out(`Dry run, nothing sent.\n${counts}`);
      return;
    }
    const res = await withClient(args, deps).importLegacy(payload);
    deps.out(flagBool(args, "json") ? JSON.stringify(res, null, 2) : `${counts}\n\n${renderImport(res)}`);
  }
};

export function hasCommand(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(handlers, name);
}

/** Runs the CLI and returns the exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const [command, ...positionals] = parsed.positionals;
    if (!command || command === "help" || parsed.flags.help === true) {
      deps.out(USAGE);
      return 0;
    }
    if (!hasCommand(command)) {
      throw new UsageError(`Unknown command "${command}". Run "npm run atlas -- help" for usage.`);
    }
    await (handlers[command] as Handler)({ positionals, flags: parsed.flags }, deps);
    return 0;
  } catch (e) {
    if (e instanceof MeridianError) {
      deps.err(`Error: ${e.message}`);
      if (e.body !== null && e.body !== undefined && e.body !== "") {
        deps.err(typeof e.body === "string" ? e.body : JSON.stringify(e.body, null, 2));
      }
    } else if (e instanceof Error) {
      deps.err(`Error: ${e.message}`);
    } else {
      deps.err(`Error: ${String(e)}`);
    }
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
