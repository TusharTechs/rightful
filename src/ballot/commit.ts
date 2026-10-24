/**
 * The sealed entry list.
 *
 * When entries close, the ballot publishes a commitment: a Merkle root over every entry plus the
 * terms (inventory, per-human limit, drand round). The draw is a pure function of that commitment
 * and the round's randomness, so once the commitment is out nobody can add, drop or reorder an
 * entry without everyone noticing, and every fan can check their own entry is in it.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** What the public sees of an entry. `humanTag` is a per-ballot pseudonym, never a PayPal ID. */
export type PublicEntry = { entryId: string; humanTag: string; quantity: number };

export type BallotTerms = {
  ballotId: string;
  /** Units on offer, e.g. tickets. */
  inventory: number;
  /** Most units one verified human can be selected for. */
  perHumanLimit: number;
  /** If false, an entry asking for 2 when 1 is left waits rather than taking 1. */
  allowPartial: boolean;
  /** The drand quicknet round whose randomness decides the order. */
  round: number;
  chainHash: string;
};

export type Commitment = { root: string; entryCount: number; digest: string };

export type InclusionProof = { leaf: string; path: { sibling: string; side: "left" | "right" }[] };

export function leafHash(ballotId: string, entry: PublicEntry): string {
  assertEntry(entry);
  return hex(utf8ToBytes(`firsthand/entry/v1\n${ballotId}\n${entry.entryId}\n${entry.humanTag}\n${entry.quantity}`));
}

/** Leaves sorted, so the root does not depend on the order entries arrived in. */
export function sortedLeaves(ballotId: string, entries: PublicEntry[]): string[] {
  const leaves = entries.map((entry) => leafHash(ballotId, entry)).sort();
  for (let i = 1; i < leaves.length; i++) {
    if (leaves[i] === leaves[i - 1]) throw new Error("duplicate entry in ballot");
  }
  return leaves;
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return hex(utf8ToBytes("firsthand/empty/v1"));
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

export function commit(terms: BallotTerms, entries: PublicEntry[]): Commitment {
  assertTerms(terms);
  const leaves = sortedLeaves(terms.ballotId, entries);
  const root = merkleRoot(leaves);
  const digest = hex(
    utf8ToBytes(
      [
        "firsthand/commit/v1",
        terms.ballotId,
        root,
        leaves.length,
        terms.inventory,
        terms.perHumanLimit,
        terms.allowPartial ? "partial" : "whole",
        terms.round,
        terms.chainHash,
      ].join("\n"),
    ),
  );
  return { root, entryCount: leaves.length, digest };
}

/** The path a fan needs to show their entry is under the published root. */
export function proveInclusion(leaves: string[], leaf: string): InclusionProof {
  let index = leaves.indexOf(leaf);
  if (index < 0) throw new Error("leaf is not in this ballot");
  const path: InclusionProof["path"] = [];
  let level = leaves;
  while (level.length > 1) {
    const pairIndex = index ^ 1;
    if (pairIndex < level.length) {
      path.push({ sibling: level[pairIndex]!, side: pairIndex < index ? "left" : "right" });
    }
    level = nextLevel(level);
    index = Math.floor(index / 2);
  }
  return { leaf, path };
}

export function verifyInclusion(root: string, proof: InclusionProof): boolean {
  let node = proof.leaf;
  for (const step of proof.path) {
    node = step.side === "left" ? pair(step.sibling, node) : pair(node, step.sibling);
  }
  return node === root;
}

function nextLevel(level: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]!;
    const right = level[i + 1];
    // An odd node is carried up unchanged rather than paired with itself.
    next.push(right === undefined ? left : pair(left, right));
  }
  return next;
}

function pair(left: string, right: string): string {
  return bytesToHex(sha256(concatBytes(Uint8Array.of(1), hexToBytes(left), hexToBytes(right))));
}

function hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function assertEntry(entry: PublicEntry): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(entry.entryId)) throw new Error(`bad entry ID: ${entry.entryId}`);
  if (!/^[0-9a-f]{64}$/.test(entry.humanTag)) throw new Error("humanTag must be 32 bytes of hex");
  if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 1) throw new Error("quantity must be a positive integer");
}

function assertTerms(terms: BallotTerms): void {
  if (!Number.isSafeInteger(terms.inventory) || terms.inventory < 1) throw new Error("inventory must be a positive integer");
  if (!Number.isSafeInteger(terms.perHumanLimit) || terms.perHumanLimit < 1) throw new Error("perHumanLimit must be a positive integer");
  if (!Number.isSafeInteger(terms.round) || terms.round < 1) throw new Error("round must be a positive integer");
  if (!/^[0-9a-f]{64}$/.test(terms.chainHash)) throw new Error("chainHash must be 32 bytes of hex");
}
