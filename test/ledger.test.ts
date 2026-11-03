import assert from "node:assert/strict";
import { test } from "node:test";
import { QUICKNET } from "../src/ballot/drand.ts";
import { humanTag } from "../src/ballot/human.ts";
import { type DistributionTerms, type PayoutLeaf, auditSample, auditSizeFor, commitDistribution, payoutIsInLedger, provePayout, verifyLedger } from "../src/claims/ledger.ts";

const SECRET = new Uint8Array(32).fill(2);
const PROGRAM = "prg_ledger_test";

function payouts(count: number, share = 1000): PayoutLeaf[] {
  return Array.from({ length: count }, (_, i) => ({ claimId: `clm_${String(i).padStart(8, "0")}`, humanTag: humanTag(SECRET, PROGRAM, `PAYER${i}`), amountCents: share }));
}

const terms = (count: number, overrides: Partial<DistributionTerms> = {}): DistributionTerms => ({
  programId: PROGRAM,
  poolCents: 1000 * count + 7,
  currency: "USD",
  shareCents: 1000,
  auditRound: 1_000_000,
  auditSize: auditSizeFor(count),
  chainHash: QUICKNET.hash,
  ...overrides,
});

const BEACON = { round: 1_000_000, randomness: "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3" };

test("the commitment fixes every payout, in any order", () => {
  const list = payouts(40);
  const a = commitDistribution(terms(40), list);
  assert.deepEqual(commitDistribution(terms(40), [...list].reverse()), a);
  assert.equal(a.payoutCount, 40);
  assert.notEqual(commitDistribution(terms(40, { auditRound: 1_000_001 }), list).digest, a.digest, "the audit round is committed");
  assert.notEqual(commitDistribution(terms(39), list.slice(1)).root, a.root, "dropping a payout changes the root");
});

test("a ledger cannot overpay, pay one human twice, or pay off-share", () => {
  const list = payouts(5);
  assert.throws(() => commitDistribution(terms(5, { poolCents: 4999 }), list), /more than the pool/);
  assert.throws(() => commitDistribution(terms(5), [...list.slice(0, 4), { ...list[4]!, amountCents: 1001 }]), /exactly the share/);
  assert.throws(() => commitDistribution(terms(5), [...list.slice(0, 4), { ...list[4]!, humanTag: list[0]!.humanTag }]), /two payouts to one human/);
  assert.throws(() => commitDistribution(terms(5, { auditSize: 3 }), list), /auditSize must be 5/);
});

test("each claimant can prove their payout is in the ledger", () => {
  const list = payouts(13);
  const { root } = commitDistribution(terms(13), list);
  for (const payout of list) assert.ok(payoutIsInLedger(root, PROGRAM, payout, provePayout(PROGRAM, list, payout)));
  const proof = provePayout(PROGRAM, list, list[3]!);
  assert.equal(payoutIsInLedger(root, PROGRAM, { ...list[3]!, amountCents: 2000 }, proof), false, "a different amount does not verify");
});

test("the audit sample is fixed by the beacon and the ledger, and nothing else", () => {
  const list = payouts(100);
  const sample = auditSample(terms(100), list, BEACON);
  assert.equal(sample.length, 25);
  assert.equal(new Set(sample).size, 25);
  assert.deepEqual(auditSample(terms(100), [...list].reverse(), BEACON), sample);
  assert.notDeepEqual(auditSample(terms(100), list, { ...BEACON, randomness: "c".repeat(64) }), sample);
  assert.throws(() => auditSample(terms(100), list, { ...BEACON, round: 999_999 }), /committed to round/);
  assert.equal(auditSample(terms(4), payouts(4), BEACON).length, 4, "small programs audit everything");
});

test("verifying a published ledger catches a swapped payout or a hand-picked sample", () => {
  const list = payouts(30);
  const t = terms(30);
  const commitment = commitDistribution(t, list);
  const sample = auditSample(t, list, BEACON);
  assert.deepEqual(verifyLedger(t, list, { commitment, sample }, BEACON), []);

  const swapped = [...list.slice(1), { ...list[0]!, humanTag: humanTag(SECRET, PROGRAM, "SOMEONE_ELSE") }];
  assert.deepEqual(verifyLedger(t, swapped, { commitment, sample }).map((m) => m.field), ["root", "digest"]);
  const picked = list.slice(0, 25).map((p) => p.claimId);
  assert.deepEqual(verifyLedger(t, list, { commitment, sample: picked }, BEACON).map((m) => m.field), ["sample"]);
});
