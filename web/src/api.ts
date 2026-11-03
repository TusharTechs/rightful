/** Typed calls to the Rightful API. */

import type { PublicLedger } from "../../src/claims/distribute.ts";
import type { PayoutLeaf } from "../../src/claims/ledger.ts";
import type { InclusionProof } from "../../src/engine/merkle.ts";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export type ProgramStatus = "open" | "review" | "distributing" | "done";

export type Program = {
  id: string;
  title: string;
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

export type { PublicLedger };

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
};

/** Where a claimant starts: Log in with PayPal on the API, then the claim form. */
export const claimUrl = (programId: string) => `${API_URL}/claim/start?program=${encodeURIComponent(programId)}`;
