/**
 * The draw: a pure function of the commitment, the entries and one drand beacon.
 *
 * Each entry's place in line is HMAC-SHA256(randomness, commitment digest ‖ leaf). Selection then
 * walks the line in order, respecting inventory and the per-human limit. No model and no person
 * touches this step, and anyone holding the public entry list can recompute it.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { type BallotTerms, type Commitment, type PublicEntry, commit, leafHash } from "./commit.ts";

export type Placement = { entryId: string; position: number; ticket: string; selected: number };

export type DrawResult = {
  commitment: Commitment;
  round: number;
  randomness: string;
  /** Every entry in line order. `selected` is how many units the entry got (0 = waitlist). */
  line: Placement[];
  selectedUnits: number;
};

export function draw(terms: BallotTerms, entries: PublicEntry[], beacon: { round: number; randomness: string }): DrawResult {
  if (beacon.round !== terms.round) throw new Error(`ballot is committed to round ${terms.round}, beacon is ${beacon.round}`);
  if (!/^[0-9a-f]{64}$/.test(beacon.randomness)) throw new Error("randomness must be 32 bytes of hex");

  const commitment = commit(terms, entries);
  const key = hexToBytes(beacon.randomness);
  const digest = hexToBytes(commitment.digest);

  const ranked = entries
    .map((entry) => {
      const leaf = leafHash(terms.ballotId, entry);
      const ticket = bytesToHex(hmac(sha256, key, concatBytes(digest, hexToBytes(leaf))));
      return { entry, leaf, ticket };
    })
    .sort((a, b) => (a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : a.leaf < b.leaf ? -1 : 1));

  let remaining = terms.inventory;
  const perHuman = new Map<string, number>();
  const line: Placement[] = ranked.map(({ entry, ticket }, position) => {
    const already = perHuman.get(entry.humanTag) ?? 0;
    const allowed = Math.min(entry.quantity, remaining, terms.perHumanLimit - already);
    const selected = allowed <= 0 || (!terms.allowPartial && allowed < entry.quantity) ? 0 : allowed;
    if (selected > 0) {
      remaining -= selected;
      perHuman.set(entry.humanTag, already + selected);
    }
    return { entryId: entry.entryId, position, ticket, selected };
  });

  return {
    commitment,
    round: beacon.round,
    randomness: beacon.randomness,
    line,
    selectedUnits: terms.inventory - remaining,
  };
}

export type DrawMismatch = { field: string; expected: string; published: string };

/**
 * Recomputes a published draw. An empty array means the publisher told the truth about the entry
 * list, the round and the result. (Check the beacon itself with `verifiedBeacon` first.)
 */
export function verifyDraw(
  terms: BallotTerms,
  entries: PublicEntry[],
  beacon: { round: number; randomness: string },
  published: DrawResult,
): DrawMismatch[] {
  const expected = draw(terms, entries, beacon);
  const mismatches: DrawMismatch[] = [];
  const check = (field: string, a: unknown, b: unknown) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    if (left !== right) mismatches.push({ field, expected: left, published: right });
  };
  check("commitment", expected.commitment, published.commitment);
  check("round", expected.round, published.round);
  check("randomness", expected.randomness, published.randomness);
  check("line", expected.line, published.line);
  check("selectedUnits", expected.selectedUnits, published.selectedUnits);
  return mismatches;
}
