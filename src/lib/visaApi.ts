// Client for /api/visa (ADR 0012). Owner-only: every call goes through jfetch, which sends the
// session cookie and turns a 401 into JournalLockedError.

import { jfetch } from "./journalApi";
import type { VisaData } from "./visa/data";
import type { VisaSettings } from "./visa/settings";
import type { BorderRunOption, BufferOption, CheckResult, StayInput } from "./visa/engine";

export interface OwnerStay extends StayInput {
  source: "journal" | "trip" | "rotation";
  context: string;
  cityId?: string;
}

const post = <T>(path: string, body: unknown) => jfetch<T>(path, { method: "POST", body: JSON.stringify(body) });

export async function getVisaSettings(): Promise<VisaSettings> {
  return (await jfetch<{ settings: VisaSettings }>("/api/visa/settings")).settings;
}

export async function saveVisaSettings(s: VisaSettings): Promise<VisaSettings> {
  const { updatedAt: _u, ...rest } = s;
  return (await jfetch<{ settings: VisaSettings }>("/api/visa/settings", { method: "PUT", body: JSON.stringify(rest) })).settings;
}

export function getVisaData(): Promise<{ data: VisaData; settings: VisaSettings }> {
  return jfetch("/api/visa/data");
}

export function getVisaDays(): Promise<{ today: string; stays: OwnerStay[]; data: VisaData; settings: VisaSettings }> {
  return jfetch("/api/visa/days");
}

export function checkVisaStays(stays: StayInput[], today?: string): Promise<CheckResult> {
  return post("/api/visa/check", { stays, today });
}

export function getBuffers(body: { cityId: string; start: string; nights: number }): Promise<{ options: BufferOption[] }> {
  return post("/api/visa/buffers", body);
}

export function getBorderRuns(body: { cityId: string; date: string }): Promise<{ options: BorderRunOption[]; notes: string[] }> {
  return post("/api/visa/border-runs", body);
}
