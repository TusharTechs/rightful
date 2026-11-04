/**
 * Checks a claims program's payout ledger in the browser, trusting nothing the server says:
 * 1. recompute the commitment from the published payouts and terms (every payout is exactly the
 *    share, one per human, within the pool);
 * 2. fetch the committed drand round from the League of Entropy relays and verify its signature;
 * 3. recompute the audit sample from that randomness and compare it with what was published;
 * plus, for live programs, check that PayPal's records of the payout batches name this ledger.
 * The same ledger code the server ran (src/claims/ledger.ts), bundled into the page.
 */

import { QUICKNET, timeOfRound, verifiedBeacon } from "../../src/engine/drand.ts";
import { ledgerAnchor, verifyLedger } from "../../src/claims/ledger.ts";
import type { PublicLedger } from "./api.ts";

/** `skipped` steps do not apply to this ledger (e.g. PayPal records for a simulated demo). */
export type CheckStep = { label: string; ok: boolean; detail: string; skipped?: boolean };

export async function verifyPublishedLedger(ledger: PublicLedger, onStep: (step: CheckStep) => void): Promise<boolean> {
  const committed = verifyLedger(ledger.terms, ledger.payouts, { commitment: ledger.commitment });
  onStep({
    label: "Payout ledger",
    ok: committed.length === 0,
    detail:
      committed.length === 0
        ? `${ledger.payouts.length} payouts of exactly the share, one per person, hash to the commitment ${ledger.commitment.digest.slice(0, 12)}…. The commitment fixed drand round ${ledger.terms.auditRound} in advance.`
        : `The published payouts do not match the commitment (${committed.map((m) => m.field).join(", ")}).`,
  });
  if (committed.length) return false;

  if (!paypalStep(ledger, onStep)) return false;

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

/**
 * PayPal's own record of each batch must name this ledger: the batch message and every item's note
 * carry the anchor. The API reads that back from PayPal; each claimant can also see it in the note
 * on their own PayPal payment, which is a copy we do not control.
 */
function paypalStep(ledger: PublicLedger, onStep: (step: CheckStep) => void): boolean {
  const label = "PayPal's records";
  if (!ledger.paypal) {
    onStep({ label, ok: true, skipped: true, detail: "Not applicable: this demo's payouts are simulated, so PayPal holds no record of them. On live programs every PayPal payment carries this ledger's digest." });
    return true;
  }
  const expected = ledgerAnchor(ledger.commitment.digest);
  const read = ledger.paypal.batches.filter((b): b is Extract<typeof b, { items: number }> => !("pending" in b));
  const items = read.reduce((n, b) => n + b.items, 0);
  const anchored = read.reduce((n, b) => n + b.itemsAnchored, 0);
  const ok =
    ledger.paypal.anchor === expected &&
    read.length === ledger.paypal.batches.length &&
    read.every((b) => b.messageAnchored) &&
    items === ledger.payouts.length &&
    anchored === items;
  const when = read.map((b) => b.timeCreated).filter(Boolean).sort()[0];
  onStep({
    label,
    ok,
    detail: ok
      ? `PayPal's record of ${read.length === 1 ? "the payout batch" : `all ${read.length} payout batches`}${when ? `, created ${new Date(when).toLocaleString()}` : ""}, names this ledger (${expected.slice(0, 32)}…) in its message and in all ${items} payment notes. Each claimant sees the same digest on their own PayPal payment.`
      : read.length < ledger.paypal.batches.length
        ? "PayPal's records of these batches have not been read back yet."
        : `PayPal's records do not all name this ledger: ${anchored} of ${items} payment notes carry ${expected.slice(0, 32)}….`,
  });
  return ok;
}
