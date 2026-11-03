/**
 * The public payout ledger: who is paid what, committed before any money moves, plus an audit
 * sample nobody could choose.
 *
 * When a program distributes, it publishes a commitment: a Merkle root over every payout (claim ID,
 * per-program human tag, amount) together with the terms, including a drand round that has not been
 * published yet. Only then are payouts sent. Once that round is out, its randomness ranks the
 * payouts and the first `auditSize` form the audit sample. So the organizer cannot add a payout
 * after the fact, cannot pay anyone more than the share, and cannot steer which claims get audited.
 * Every claimant can check their own payout is in the ledger, and anyone can recompute the sample.
 *
 * Pure functions with no server imports: the web app bundles this file to verify in the browser.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type InclusionProof, merkleRoot, proveInclusion, verifyInclusion } from "../ballot/commit.ts";

/** What the public sees of a payout. `humanTag` is a per-program pseudonym, never a PayPal ID. */
export type PayoutLeaf = { claimId: string; humanTag: string; amountCents: number };

export type DistributionTerms = {
  programId: string;
  poolCents: number;
  currency: string;
  shareCents: number;
  /** The drand quicknet round whose randomness picks the audit sample. */
  auditRound: number;
  auditSize: number;
  chainHash: string;
};

export type LedgerCommitment = { root: string; payoutCount: number; digest: string };

/** How many payouts are audited: all of them up to 25, then 25. */
export const auditSizeFor = (payouts: number) => Math.min(payouts, 25);

export function payoutLeafHash(programId: string, payout: PayoutLeaf): string {
  assertPayout(payout);
  return digestOf(`rightful/payout/v1\n${programId}\n${payout.claimId}\n${payout.humanTag}\n${payout.amountCents}`);
}

/** Leaves sorted, so the root does not depend on the order claims were approved in. */
export function payoutLeaves(programId: string, payouts: PayoutLeaf[]): string[] {
  const tags = new Set<string>();
  for (const payout of payouts) {
    if (tags.has(payout.humanTag)) throw new Error("two payouts to one human");
    tags.add(payout.humanTag);
  }
  const leaves = payouts.map((payout) => payoutLeafHash(programId, payout)).sort();
  for (let i = 1; i < leaves.length; i++) if (leaves[i] === leaves[i - 1]) throw new Error("duplicate payout");
  return leaves;
}

export function commitDistribution(terms: DistributionTerms, payouts: PayoutLeaf[]): LedgerCommitment {
  assertTerms(terms, payouts);
  const leaves = payoutLeaves(terms.programId, payouts);
  const root = merkleRoot(leaves);
  const digest = digestOf(
    [
      "rightful/ledger/v1",
      terms.programId,
      root,
      leaves.length,
      terms.poolCents,
      terms.currency,
      terms.shareCents,
      terms.auditRound,
      terms.auditSize,
      terms.chainHash,
    ].join("\n"),
  );
  return { root, payoutCount: leaves.length, digest };
}

/** Ranks payouts by HMAC(randomness, digest ‖ leaf) and takes the first `auditSize` claim IDs. */
export function auditSample(terms: DistributionTerms, payouts: PayoutLeaf[], beacon: { round: number; randomness: string }): string[] {
  if (beacon.round !== terms.auditRound) throw new Error(`the ledger is committed to round ${terms.auditRound}, beacon is ${beacon.round}`);
  if (!/^[0-9a-f]{64}$/.test(beacon.randomness)) throw new Error("randomness must be 32 bytes of hex");
  const { digest } = commitDistribution(terms, payouts);
  const key = hexToBytes(beacon.randomness);
  return payouts
    .map((payout) => {
      const leaf = payoutLeafHash(terms.programId, payout);
      return { claimId: payout.claimId, leaf, rank: bytesToHex(hmac(sha256, key, concatBytes(hexToBytes(digest), hexToBytes(leaf)))) };
    })
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.leaf < b.leaf ? -1 : 1))
    .slice(0, terms.auditSize)
    .map((ranked) => ranked.claimId);
}

export function provePayout(programId: string, payouts: PayoutLeaf[], payout: PayoutLeaf): InclusionProof {
  return proveInclusion(payoutLeaves(programId, payouts), payoutLeafHash(programId, payout));
}

export function payoutIsInLedger(root: string, programId: string, payout: PayoutLeaf, proof: InclusionProof): boolean {
  return proof.leaf === payoutLeafHash(programId, payout) && verifyInclusion(root, proof);
}

export type LedgerMismatch = { field: string; expected: string; published: string };

/**
 * Recomputes a published ledger. An empty array means the commitment matches the payouts and terms,
 * and (when a verified beacon is given) the published sample is the one that randomness picks.
 */
export function verifyLedger(
  terms: DistributionTerms,
  payouts: PayoutLeaf[],
  published: { commitment: LedgerCommitment; sample?: string[] | null },
  beacon?: { round: number; randomness: string },
): LedgerMismatch[] {
  const mismatches: LedgerMismatch[] = [];
  const check = (field: string, expected: unknown, given: unknown) => {
    const [a, b] = [JSON.stringify(expected), JSON.stringify(given)];
    if (a !== b) mismatches.push({ field, expected: a, published: b });
  };
  let commitment: LedgerCommitment;
  try {
    commitment = commitDistribution(terms, payouts);
  } catch (err) {
    return [{ field: "payouts", expected: "a valid ledger", published: err instanceof Error ? err.message : String(err) }];
  }
  check("root", commitment.root, published.commitment.root);
  check("payoutCount", commitment.payoutCount, published.commitment.payoutCount);
  check("digest", commitment.digest, published.commitment.digest);
  if (beacon && published.sample) check("sample", auditSample(terms, payouts, beacon), published.sample);
  return mismatches;
}

function digestOf(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function assertPayout(payout: PayoutLeaf): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(payout.claimId)) throw new Error(`bad claim ID: ${payout.claimId}`);
  if (!/^[0-9a-f]{64}$/.test(payout.humanTag)) throw new Error("humanTag must be 32 bytes of hex");
  if (!Number.isSafeInteger(payout.amountCents) || payout.amountCents < 1) throw new Error("amountCents must be a positive integer");
}

function assertTerms(terms: DistributionTerms, payouts: PayoutLeaf[]): void {
  for (const [name, value] of [["poolCents", terms.poolCents], ["shareCents", terms.shareCents], ["auditRound", terms.auditRound]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (terms.auditSize !== auditSizeFor(payouts.length)) throw new Error(`auditSize must be ${auditSizeFor(payouts.length)}`);
  if (!/^[0-9a-f]{64}$/.test(terms.chainHash)) throw new Error("chainHash must be 32 bytes of hex");
  if (payouts.some((payout) => payout.amountCents !== terms.shareCents)) throw new Error("every payout must be exactly the share");
  if (terms.shareCents * payouts.length > terms.poolCents) throw new Error("the payouts add up to more than the pool");
}
