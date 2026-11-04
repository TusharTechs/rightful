/** Typed calls to the Rightful API. */

import type { ConsoleRing, ConsoleView, Outcome } from "../../src/claims/console.ts";
import type { PublicLedger } from "../../src/claims/distribute.ts";
import type { PayoutLeaf } from "../../src/claims/ledger.ts";
import type { InclusionProof } from "../../src/engine/merkle.ts";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export type ProgramStatus = "open" | "review" | "distributing" | "done";

export type Program = {
  id: string;
  title: string;
  kind: "live" | "demo";
  status: ProgramStatus;
  poolCents: number;
  currency: string;
  closesAt: string;
  shareCents: number | null;
  commitment: string | null;
  auditRound: number | null;
  claims: Record<string, number>;
};

export type PayoutReceipt = { programId: string; root: string; payout: PayoutLeaf; proof: InclusionProof };

export type { ConsoleRing, ConsoleView, Outcome, PublicLedger };

export type RingMember = {
  id: string;
  status: string;
  filedVia: "web" | "agent";
  agentName?: string | null;
  appeal?: string | null;
  verified: boolean | null;
  humanTag: string | null;
  email: string;
  address: string;
  network: string;
  device: string;
  narrative: string;
  filedAt: string;
  truth?: string | null;
};

export type DemoProgram = Program & { programId: string; token: string };

/** A claim as the administrator sees it (`GET /api/programs/:id/claims`): never the payer ID. */
export type AdminClaim = {
  id: string;
  status: string;
  hold_reason: "unverified" | "ring" | null;
  ring_id: string | null;
  filed_via: "web" | "agent";
  agent_name: string | null;
  verified: boolean | null;
  human_tag: string | null;
  email: string;
  address: string;
  network: string;
  device: string;
  narrative: string;
  amount_cents: number | null;
  payout_status: string | null;
  appeal_message: string | null;
  filed_at: string;
  demo_truth: string | null;
};

export type ClaimStatus = {
  id: string;
  programId: string;
  status: "unbound" | "filed" | "held" | "approved" | "denied" | "paid" | "failed";
  holdReason: "unverified" | "review" | null;
  filedVia: "web" | "agent";
  bound: boolean;
  amountCents: number | null;
  filedAt: string;
  appealed: boolean;
  program: { id: string; title: string; status: ProgramStatus; closesAt: string; kind: "live" | "demo" };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "error", body.message ?? `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  programs: () => call<Program[]>("/api/programs"),
  program: (id: string) => call<Program>(`/api/programs/${encodeURIComponent(id)}`),
  ledger: (id: string) => call<PublicLedger>(`/api/programs/${encodeURIComponent(id)}/ledger`),
  payoutReceipt: (claimId: string) => call<PayoutReceipt>(`/api/claims/${encodeURIComponent(claimId)}/proof`),
  createDemo: () => call<DemoProgram>("/api/demo", { method: "POST", body: "{}" }),
  claim: (id: string) => call<ClaimStatus>(`/api/claims/${encodeURIComponent(id)}`),
  appeal: (id: string, message: string) => call<ClaimStatus>(`/api/claims/${encodeURIComponent(id)}/appeal`, { method: "POST", body: JSON.stringify({ message }) }),
};

/** Organizer calls: the admin token, or a demo program's console token. */
export function consoleApi(programId: string, token: string) {
  const base = `/api/programs/${encodeURIComponent(programId)}`;
  const auth = { authorization: `Bearer ${token}` };
  const post = <T>(path: string, body: unknown = {}) => call<T>(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  return {
    view: () => call<ConsoleView>(`${base}/console`, { headers: auth }),
    members: (ringId: string) => call<RingMember[]>(`${base}/rings/${encodeURIComponent(ringId)}`, { headers: auth }),
    claims: () => call<AdminClaim[]>(`${base}/claims`, { headers: auth }),
    decide: (ringIds: string[], decision: "deny" | "approve") => post<{ changed: number }>("/decisions", { ringIds, decision }),
    distribute: () => post<{ shareCents: number; claims: number }>("/distribute"),
    sync: () => post<{ paid: number; pending: number; done: boolean; audit: string[] | null }>("/sync"),
  };
}

/** Where the console keeps tokens: one per program, in this browser only. */
export const tokens = {
  get: (programId: string) => localStorage.getItem(`rf_console:${programId}`),
  set: (programId: string, token: string) => localStorage.setItem(`rf_console:${programId}`, token),
  lastDemo: (): { programId: string; at: number } | null => {
    try {
      const value = JSON.parse(localStorage.getItem("rf_demo") ?? "null") as { programId: string; at: number } | null;
      return value && Date.now() - value.at < 70 * 3_600_000 && tokens.get(value.programId) ? value : null;
    } catch {
      return null;
    }
  },
  rememberDemo: (programId: string) => localStorage.setItem("rf_demo", JSON.stringify({ programId, at: Date.now() })),
};

/** Where a claimant starts: Log in with PayPal on the API, then the claim form. */
export const claimUrl = (programId: string) => `${API_URL}/claim/start?program=${encodeURIComponent(programId)}`;
