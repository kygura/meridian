// Wall-clock times in a named time zone, using Intl only (no time-zone library).

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DDTHH:MM" as typed into a datetime-local input. */
export function isLocalDateTime(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return false;
  const d = new Date(`${s}:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 16) === s;
}

export function isTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes the zone is ahead of UTC at this instant. */
export function zoneOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant a wall-clock time ("2027-03-01T10:30") happens in a zone. A time that falls
 * in a clock change is read with the offset in force just before it. Null on bad input.
 */
export function zonedToUtc(local: string, tz: string | undefined): Date | null {
  if (!isLocalDateTime(local) || !isTimeZone(tz)) return null;
  const naive = new Date(`${local}:00Z`).getTime();
  let utc = naive - zoneOffsetMinutes(new Date(naive), tz) * 60_000;
  // The offset at the guess can differ from the offset at the answer near a clock change.
  utc = naive - zoneOffsetMinutes(new Date(utc), tz) * 60_000;
  return new Date(utc);
}

/** "UTC+1", "UTC−3:30", "UTC" for a zone at an instant. */
export function offsetLabel(instant: Date, tz: string): string {
  const m = zoneOffsetMinutes(instant, tz);
  if (m === 0) return "UTC";
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${m > 0 ? "+" : "−"}${h}${mm ? `:${pad(mm)}` : ""}`;
}
