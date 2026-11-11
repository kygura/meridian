// Client for /api/solver (ADR 0015). Owner-only: every call goes through jfetch, which sends
// the session cookie and turns a 401 into JournalLockedError.

import { jfetch } from "./journalApi";
import type { RotationPlace, RotationStay } from "./rotation";
import type { FixedStay, PlanInput, ProposedRotation, SolveResult } from "./solver/types";
import type { Proposal, SolverSettings } from "./solver/settings";

export interface SolveResponse extends SolveResult {
  notes: string[];
  places: { cityId: string; name: string; country?: string; lat: number; lng: number; inPool: boolean }[];
  input: { start: string; months: number; from: RotationPlace; budgetMonthlyEur: number; fixed: FixedStay[] };
}

export interface SolveRequestBody {
  settings?: SolverSettings;
  start?: string;
  fromCityId?: string;
  pins?: { id: string; cityId: string; start: string; end: string; kind: "base" | "pass-through" }[];
  news?: boolean;
}

const post = <T>(path: string, body: unknown) => jfetch<T>(path, { method: "POST", body: JSON.stringify(body) });

export async function getSolverSettings(): Promise<SolverSettings> {
  return (await jfetch<{ settings: SolverSettings }>("/api/solver/settings")).settings;
}

export async function saveSolverSettings(s: SolverSettings): Promise<SolverSettings> {
  const { updatedAt: _u, ...rest } = s;
  return (await jfetch<{ settings: SolverSettings }>("/api/solver/settings", { method: "PUT", body: JSON.stringify(rest) })).settings;
}

export function solveRotation(body: SolveRequestBody): Promise<SolveResponse> {
  return post("/api/solver/solve", body);
}

export function evaluateRotation(body: SolveRequestBody & { plan: PlanInput }): Promise<{ rotation: ProposedRotation; notes: string[] }> {
  return post("/api/solver/evaluate", body);
}

export function acceptRotation(plan: PlanInput, runId: string): Promise<{ added: RotationStay[]; removed: { id: string; name: string }[] }> {
  return post("/api/solver/accept", { plan, runId });
}

export async function listProposals(): Promise<Proposal[]> {
  return (await jfetch<{ proposals: Proposal[] }>("/api/solver/proposals")).proposals;
}

export function decideProposal(id: string, action: "accept" | "dismiss" | "snooze", days?: number): Promise<{ proposal: Proposal }> {
  return post(`/api/solver/proposals/${encodeURIComponent(id)}/${action}`, days ? { days } : {});
}

export function runReplanNow(): Promise<{ shifts: number; proposals: number; notes: string[] }> {
  return post("/api/solver/replan", {});
}
