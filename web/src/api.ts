/** Typed calls to the Firsthand API. */

import type { InclusionProof } from "../../src/ballot/commit.ts";
import type { PublicProof } from "../../src/ballots/service.ts";
import type { PayoutLeaf } from "../../src/claims/ledger.ts";
import type { PublicLedger } from "../../src/claims/distribute.ts";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export type BallotStatus = "open" | "sealed" | "drawn" | "settled" | "cancelled";

export type Ballot = {
  id: string;
  title: string;
  status: BallotStatus;
  priceCents: number;
  currency: string;
  inventory: number;
  perHumanLimit: number;
  maxQuantity: number;
  closesAt: string;
  drawRound: number;
  drawRoundFixed: boolean;
  drawAt: string;
  serverTime: string;
  commitment: string | null;
  entries: Record<string, number>;
};

export type Entry = {
  id: string;
  ballotId: string;
  quantity: number;
  holdCents: number;
  status: "awaiting_approval" | "held" | "captured" | "voided" | "rejected" | "cancelled" | "failed";
  rejection: "unverified" | "duplicate" | "closed" | "declined" | null;
  outcome: "selected" | "not_selected" | null;
  selectedUnits: number | null;
  position: number | null;
  humanTag: string | null;
  inclusionProof: InclusionProof | null;
};

export type { PublicLedger, PublicProof };

export type Program = {
  id: string;
  title: string;
  status: "open" | "review" | "distributing" | "done";
  poolCents: number;
  currency: string;
  shareCents: number | null;
  commitment: string | null;
  auditRound: number | null;
  claims: Record<string, number>;
};

export type PayoutReceipt = { programId: string; root: string; payout: PayoutLeaf; proof: InclusionProof };

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
  ballots: () => call<Ballot[]>("/api/ballots"),
  ballot: (id: string) => call<Ballot>(`/api/ballots/${encodeURIComponent(id)}`),
  proof: (id: string) => call<PublicProof>(`/api/ballots/${encodeURIComponent(id)}/proof`),
  entry: (id: string) => call<Entry>(`/api/entries/${encodeURIComponent(id)}`),
  program: (id: string) => call<Program>(`/api/programs/${encodeURIComponent(id)}`),
  ledger: (id: string) => call<PublicLedger>(`/api/programs/${encodeURIComponent(id)}/ledger`),
  payoutReceipt: (claimId: string) => call<PayoutReceipt>(`/api/claims/${encodeURIComponent(claimId)}/proof`),
  enter: (ballotId: string, quantity: number) =>
    call<{ entryId: string; holdCents: number; approveUrl: string }>(`/api/ballots/${encodeURIComponent(ballotId)}/entries`, {
      method: "POST",
      body: JSON.stringify({ quantity, returnTo: window.location.origin }),
    }),
};
