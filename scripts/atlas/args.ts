// Small argument parser for the atlas CLI. No dependencies.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value. Everything else after `--name` consumes the next token. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "watch", "unwatch", "scouted", "dry-run", "help"]);

export function parseArgs(argv: readonly string[], booleans: ReadonlySet<string> = BOOLEAN_FLAGS): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (booleans.has(name)) {
        if (eq !== -1) {
          const raw = token.slice(eq + 1).toLowerCase();
          if (raw === "true" || raw === "1") flags[name] = true;
          else if (raw === "false" || raw === "0") delete flags[name];
          else throw new UsageError(`Flag --${name} takes no value (got "${token.slice(eq + 1)}").`);
        } else {
          flags[name] = true;
        }
        continue;
      }
      if (eq !== -1) {
        flags[name] = token.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new UsageError(`Flag --${name} needs a value.`);
      }
      flags[name] = next;
      i++;
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true) throw new UsageError(`Flag --${name} needs a value.`);
  return v;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new UsageError(`Flag --${name} expects a whole number (got "${v}").`);
  return Number(v);
}

export function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function flagList(args: ParsedArgs, name: string): string[] | undefined {
  const v = flagString(args, name);
  return v === undefined ? undefined : parseCsv(v);
}

export function parseMonths(value: string, flagName = "months"): number[] {
  const months = parseCsv(value).map((s) => {
    if (!/^\d{1,2}$/.test(s) || Number(s) < 1 || Number(s) > 12) {
      throw new UsageError(`Flag --${flagName} expects month numbers from 1 to 12 (got "${s}").`);
    }
    return Number(s);
  });
  return [...new Set(months)].sort((a, b) => a - b);
}

/**
 * Budget in EUR: "800-1500" (range), "<1500" or "1500" (up to), "800+" (at least).
 */
export function parseBudget(value: string): { min?: number; max?: number } {
  const v = value.trim().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, "");
  let m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(v);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (min > max) throw new UsageError(`Budget "${value}" has a minimum above its maximum.`);
    return { min, max };
  }
  m = /^<=?(\d+(?:\.\d+)?)$/.exec(v);
  if (m) return { max: Number(m[1]) };
  m = /^(\d+(?:\.\d+)?)\+$/.exec(v);
  if (m) return { min: Number(m[1]) };
  m = /^(\d+(?:\.\d+)?)$/.exec(v);
  if (m) return { max: Number(m[1]) };
  throw new UsageError(`Could not read budget "${value}". Use 800-1500, <1500, 1500 or 800+.`);
}
