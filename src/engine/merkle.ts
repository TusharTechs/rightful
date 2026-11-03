/**
 * A Merkle tree over sorted leaf hashes, and inclusion proofs into it.
 *
 * Publishing the root commits to every leaf at once: nobody can add, drop or change a leaf without
 * the root changing, and anyone holding one leaf and its path can check it is under the root.
 * Leaves are hex SHA-256 digests; what they commit to is up to the caller (see `claims/ledger.ts`).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export type InclusionProof = { leaf: string; path: { sibling: string; side: "left" | "right" }[] };

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return bytesToHex(sha256(utf8ToBytes("rightful/empty/v1")));
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

/** The path that shows `leaf` is under the root of `leaves`. */
export function proveInclusion(leaves: string[], leaf: string): InclusionProof {
  let index = leaves.indexOf(leaf);
  if (index < 0) throw new Error("leaf is not in this tree");
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

/** The 0x01 prefix keeps an inner node from ever being mistaken for a leaf. */
function pair(left: string, right: string): string {
  return bytesToHex(sha256(concatBytes(Uint8Array.of(1), hexToBytes(left), hexToBytes(right))));
}
