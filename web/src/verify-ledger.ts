/**
 * Checks a claims program's payout ledger in the browser, trusting nothing the server says:
 * 1. recompute the commitment from the published payouts and terms (every payout is exactly the
 *    share, one per human, within the pool);
 * 2. fetch the committed drand round from the League of Entropy relays and verify its signature;
 * 3. recompute the audit sample from that randomness and compare it with what was published.
 * The same ledger code the server ran (src/claims/ledger.ts), bundled into the page.
 */

import { QUICKNET, timeOfRound, verifiedBeacon } from "../../src/engine/drand.ts";
import { verifyLedger } from "../../src/claims/ledger.ts";
import type { PublicLedger } from "./api.ts";

export type CheckStep = { label: string; ok: boolean; detail: string };

export async function verifyPublishedLedger(ledger: PublicLedger, onStep: (step: CheckStep) => void): Promise<boolean> {
  const committed = verifyLedger(ledger.terms, ledger.payouts, { commitment: ledger.commitment });
  onStep({
    label: "Payout ledger",
    ok: committed.length === 0,
    detail:
      committed.length === 0
        ? `${ledger.payouts.length} payouts of exactly the share, one per person, hash to the commitment ${ledger.commitment.digest.slice(0, 12)}…, published before any money moved. It fixed drand round ${ledger.terms.auditRound} in advance.`
        : `The published payouts do not match the commitment (${committed.map((m) => m.field).join(", ")}).`,
  });
  if (committed.length) return false;

  if (!ledger.audit) {
    onStep({ label: "drand round", ok: false, detail: `Round ${ledger.terms.auditRound} (${timeOfRound(ledger.terms.auditRound).toLocaleTimeString()}) has not been used to draw the audit yet.` });
    return false;
  }
  let beacon;
  try {
    beacon = await verifiedBeacon(ledger.terms.auditRound);
  } catch (err) {
    onStep({ label: "drand round", ok: false, detail: `Could not fetch or verify the round: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
  const beaconOk = beacon.randomness === ledger.audit.randomness;
  onStep({
    label: "drand round",
    ok: beaconOk,
    detail: beaconOk
      ? `Fetched round ${beacon.round} directly from drand and verified its BLS signature against the quicknet key (chain ${QUICKNET.hash.slice(0, 8)}…).`
      : "drand's randomness for this round differs from what the program used.",
  });
  if (!beaconOk) return false;

  const sampled = verifyLedger(ledger.terms, ledger.payouts, { commitment: ledger.commitment, sample: ledger.audit.sample }, beacon);
  onStep({
    label: "Audit sample",
    ok: sampled.length === 0,
    detail:
      sampled.length === 0
        ? `Recomputed the ${ledger.audit.sample.length} audited claims from the randomness. Identical to the published sample: nobody picked them.`
        : "The published audit sample is not the one this randomness picks.",
  });
  return sampled.length === 0;
}
