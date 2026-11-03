/**
 * Scoring a hold decision against the synthetic truth.
 *
 * A claim is "held" when it is not paid automatically: it waits for a person (and, when it is
 * genuine, for an appeal that clears it). Precision and recall treat ring claims as the positives;
 * the false-hold rate is the share of genuine claimants held. With a pro-rata pool, every ring claim
 * that is paid comes straight out of genuine claimants' pockets, so the money columns follow.
 */

import type { GenuineKind, RingKind, SyntheticProgram } from "./synthetic.ts";

export interface Score {
  held: number;
  precision: number;
  recall: number;
  falseHoldRate: number;
  /** Cents of the pool paid to ring claims. */
  ringPaidCents: number;
  /** Cents paid to each genuine claim that is paid. */
  perGenuineCents: number;
  recallByKind: Partial<Record<RingKind, number>>;
  falseHoldByKind: Partial<Record<GenuineKind, number>>;
}

export function score(program: SyntheticProgram, held: ReadonlySet<string>, poolCents: number): Score {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const byKind = new Map<string, { held: number; total: number }>();
  for (const claim of program.claims) {
    const truth = program.truth.get(claim.id)!;
    const isHeld = held.has(claim.id);
    if (truth.ring) isHeld ? tp++ : fn++;
    else isHeld ? fp++ : tn++;
    const tally = byKind.get(truth.kind) ?? { held: 0, total: 0 };
    tally.total++;
    if (isHeld) tally.held++;
    byKind.set(truth.kind, tally);
  }
  const paid = fn + tn;
  const share = paid === 0 ? 0 : Math.floor(poolCents / paid);
  const rate = (kind: string) => {
    const tally = byKind.get(kind);
    return tally ? tally.held / tally.total : undefined;
  };
  const pick = <K extends string>(kinds: readonly K[]) =>
    Object.fromEntries(kinds.flatMap((k) => (rate(k) === undefined ? [] : [[k, rate(k)!]]))) as Partial<Record<K, number>>;
  return {
    held: tp + fp,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    falseHoldRate: fp + tn === 0 ? 0 : fp / (fp + tn),
    ringPaidCents: share * fn,
    perGenuineCents: share,
    recallByKind: pick(["device-farm", "address-mill", "template-crew", "quiet"] as const),
    falseHoldByKind: pick(["solo", "household", "campus", "sample-text"] as const),
  };
}
