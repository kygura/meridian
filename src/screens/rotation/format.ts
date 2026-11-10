import { formatShortDate, staySpan, stayNights, type MonthlyCost, type RotationStay, type StayKind, type StayStatus, type WindowKind } from "../../lib/rotation";

export const STATUS_LABEL: Record<StayStatus, string> = {
  idea: "Idea",
  planned: "Planned",
  booked: "Booked",
  current: "Here now",
  done: "Done",
};

export const KIND_LABEL: Record<StayKind, string> = { base: "Base", "pass-through": "Pass-through" };

export const WINDOW_LABEL: Record<WindowKind, string> = { peak: "Peak", shoulder: "Shoulder", avoid: "Avoid" };

const MS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 2027" from "2027-03". */
export function monthYear(ym: string): string {
  return `${MS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

/** "1 Mar – 15 May 2027 · 75 nights", or "Mar–Apr 2027 (dates not fixed)". `short` drops the nights. */
export function stayDatesText(s: Pick<RotationStay, "start" | "end" | "window">, short = false): string {
  const span = staySpan(s);
  if (!span) return "No dates yet";
  if (span.approx) {
    const a = monthYear(s.window!.from);
    const b = monthYear(s.window!.to);
    const range = a === b ? a : a.slice(-4) === b.slice(-4) ? `${a.slice(0, 3)}–${b}` : `${a} – ${b}`;
    return short ? range : `${range} (dates not fixed)`;
  }
  const a = formatShortDate(s.start!);
  const b = formatShortDate(s.end!);
  const sameYear = a.slice(-4) === b.slice(-4);
  const range = `${sameYear ? a.slice(0, -5) : a} – ${b}`;
  if (short) return range;
  const n = stayNights(s)!;
  return `${range} · ${n} ${n === 1 ? "night" : "nights"}`;
}

export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

export function costText(c: MonthlyCost): string {
  const basis = c.basis === "rent" ? "rent" : c.basis === "budget" ? "budget" : "rent where known, else budget";
  return `${formatAmount(c.perMonth, c.currency)} a month over ${c.months} months (${basis})`;
}

export function daysText(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}
