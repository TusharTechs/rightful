/**
 * Checks a draw in the browser, trusting nothing the Firsthand server says about the outcome:
 * 1. recompute the commitment from the published entry list;
 * 2. fetch the drand round straight from the League of Entropy relays and verify its signature;
 * 3. recompute the whole line from that randomness and compare it with what was published.
 * This is the same engine code the server ran (src/ballot), bundled into the page.
 */

import { commit, verifyInclusion, type InclusionProof } from "../../src/ballot/commit.ts";
import { verifyDraw } from "../../src/ballot/draw.ts";
import { QUICKNET, verifiedBeacon } from "../../src/ballot/drand.ts";
import type { PublicProof } from "./api.ts";

export type CheckStep = { label: string; ok: boolean; detail: string };

export async function verifyPublishedDraw(proof: PublicProof, onStep: (step: CheckStep) => void): Promise<boolean> {
  if (!proof.terms || !proof.entries || !proof.commitment) {
    onStep({ label: "Sealed entry list", ok: false, detail: "This ballot has not been sealed yet." });
    return false;
  }

  const recomputed = commit(proof.terms, proof.entries);
  const sealedOk = recomputed.root === proof.commitment.root && recomputed.digest === proof.commitment.digest;
  onStep({
    label: "Sealed entry list",
    ok: sealedOk,
    detail: sealedOk
      ? `${proof.entries.length} entries hash to the published commitment ${recomputed.digest.slice(0, 12)}…, which fixed round ${proof.terms.round} in advance.`
      : "The published entries do not match the published commitment.",
  });
  if (!sealedOk) return false;

  if (!proof.beacon || !proof.line) {
    onStep({ label: "drand round", ok: false, detail: `Round ${proof.terms.round} has not been drawn yet.` });
    return false;
  }

  let beacon;
  try {
    beacon = await verifiedBeacon(proof.terms.round);
  } catch (err) {
    onStep({ label: "drand round", ok: false, detail: `Could not fetch or verify the round: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
  const beaconOk = beacon.randomness === proof.beacon.randomness;
  onStep({
    label: "drand round",
    ok: beaconOk,
    detail: beaconOk
      ? `Fetched round ${beacon.round} directly from drand and verified its BLS signature against the quicknet key (chain ${QUICKNET.hash.slice(0, 8)}…).`
      : "drand's randomness for this round differs from what the ballot used.",
  });
  if (!beaconOk) return false;

  const selectedUnits = proof.line.reduce((sum, placement) => sum + placement.selected, 0);
  const mismatches = verifyDraw(proof.terms, proof.entries, beacon, {
    commitment: proof.commitment,
    round: beacon.round,
    randomness: beacon.randomness,
    line: proof.line,
    selectedUnits,
  });
  onStep({
    label: "The line",
    ok: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `Recomputed the order of all ${proof.line.length} entries and the ${selectedUnits} selected units. Identical to the published result.`
        : `Differs in: ${mismatches.map((m) => m.field).join(", ")}.`,
  });
  return mismatches.length === 0;
}

export function entryIsSealed(root: string, proof: InclusionProof): boolean {
  return verifyInclusion(root, proof);
}
