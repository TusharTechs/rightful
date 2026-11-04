import assert from "node:assert/strict";
import { test } from "node:test";
import { distributeProgram, publicLedger, syncPayouts, tickClaims } from "../src/claims/distribute.ts";
import { ledgerAnchor } from "../src/claims/ledger.ts";
import { reconcileProgram } from "../src/claims/reconcile.ts";
import { type ClaimsDeps, ClaimError, createProgram, fileClaim, passAfterLogin, reviewProgram } from "../src/claims/service.ts";
import { openPGlite } from "../src/db/db.ts";
import { FakePayouts } from "../src/dev/fake-payouts.ts";
import { type HistoryTransaction, type PayPalReporting, signedCents } from "../src/paypal/sdk.ts";

const SECRET = new Uint8Array(32).fill(4);

/** A PayPal history that the test writes; Transaction Search's shape, without the network. */
class FakeReporting implements PayPalReporting {
  transactions: HistoryTransaction[] = [];
  refreshedAt: string | null = null;
  balanceCents: number | null = 1_000_000;
  async history() {
    return { refreshedAt: this.refreshedAt, transactions: this.transactions };
  }
  async available() {
    return this.balanceCents;
  }
}

async function paidProgram(reporting: FakeReporting) {
  const clock = { now: new Date("2026-11-04T12:00:00Z") };
  const deps: ClaimsDeps = { db: await openPGlite(), humanSecret: SECRET, now: () => clock.now, payouts: new FakePayouts(), reporting };
  const program = await createProgram(deps, { title: "Pitcher", poolCents: 300, closesAt: new Date("2026-11-04T13:00:00Z") });
  for (let i = 0; i < 3; i++) {
    await fileClaim(deps, program.id, { email: `p${i}@example.com`, address: `${i} Oak St`, narrative: `claim ${i}`, device: `d${i}` }, { via: "web", pass: passAfterLogin(deps, program.id, `PAYER_${i}`, true), ip: `10.${i}.0.1` });
  }
  clock.now = new Date("2026-11-04T14:00:00Z");
  await reviewProgram(deps, program.id);
  return { deps, clock, program };
}

async function payAndSettle(deps: ClaimsDeps, programId: string) {
  await distributeProgram(deps, programId);
  await syncPayouts(deps, programId);
  await syncPayouts(deps, programId);
  return deps.db.query<{ id: string; payout_transaction_id: string; amount_cents: number }>(`select id, payout_transaction_id, amount_cents from claims where program_id = $1 order by id`, [programId]);
}

test("Transaction Search amounts are signed: a payout is a debit", () => {
  assert.equal(signedCents("USD", "-1.00"), -100);
  assert.equal(signedCents("USD", "1.25"), 125);
  assert.equal(signedCents("JPY", "-500"), -500);
});

test("a live program is refused if the PayPal account cannot fund it", async () => {
  const reporting = new FakeReporting();
  reporting.balanceCents = 299;
  const { deps, program } = await paidProgram(reporting);
  await assert.rejects(distributeProgram(deps, program.id), (err) => err instanceof ClaimError && /holds 2.99 USD/.test(err.message));
  reporting.balanceCents = 300;
  assert.equal((await distributeProgram(deps, program.id)).claims, 3);
  await deps.db.close();
});

test("reconciliation waits for PayPal's history, then agrees only when every payout is there as the ledger says", async () => {
  const reporting = new FakeReporting();
  const { deps, clock, program } = await paidProgram(reporting);
  const claims = await payAndSettle(deps, program.id);
  assert.ok(claims.every((c) => c.payout_transaction_id), "Payouts read-back stored a transaction ID per claim");

  // History not refreshed past the batch yet: waiting, not a failure.
  reporting.refreshedAt = "2026-11-03T00:00:00Z";
  assert.equal((await reconcileProgram(deps, program.id))!.state, "pending");

  const anchor = ledgerAnchor((await publicLedger(deps, program.id)).commitment.digest);
  const record = (c: (typeof claims)[number], overrides: Partial<HistoryTransaction> = {}): HistoryTransaction => ({
    id: c.payout_transaction_id, eventCode: "T0001", amountCents: -c.amount_cents, currency: "USD", status: "S", note: `Your approved claim. ${anchor}`, ...overrides,
  });
  reporting.refreshedAt = "2026-11-05T00:00:00Z";
  reporting.transactions = claims.map((c) => record(c));
  const agrees = (await reconcileProgram(deps, program.id))!;
  assert.equal(agrees.state, "agrees");
  assert.deepEqual([agrees.found, agrees.amountsMatch, agrees.completed, agrees.notesNameLedger], [3, 3, 3, 3]);
  assert.equal((await publicLedger(deps, program.id)).reconciliation!.state, "agrees", "published with the ledger");

  reporting.transactions = [record(claims[0]!, { amountCents: -101 }), record(claims[1]!, { note: "Your approved claim. rightful/ledger/v1 someotherledger" }), record(claims[2]!)];
  const wrong = (await reconcileProgram(deps, program.id))!;
  assert.equal(wrong.state, "disagrees");
  assert.deepEqual(wrong.problems.map((p) => p.claimId).sort(), [claims[0]!.id, claims[1]!.id].sort());

  reporting.transactions = claims.slice(1).map((c) => record(c));
  assert.equal((await reconcileProgram(deps, program.id))!.state, "disagrees", "a payout missing from a refreshed history");

  // The clock reconciles pending programs; a demo-free run with nothing pending does nothing.
  reporting.refreshedAt = "2026-11-03T00:00:00Z";
  await reconcileProgram(deps, program.id);
  clock.now = new Date(clock.now.getTime() + 11 * 60_000);
  reporting.refreshedAt = "2026-11-05T00:00:00Z";
  reporting.transactions = claims.map((c) => record(c));
  await tickClaims(deps);
  assert.equal((await publicLedger(deps, program.id)).reconciliation!.state, "agrees");
  await deps.db.close();
});

test("programs paid before transaction IDs were stored are backfilled from Payouts read-back", async () => {
  const reporting = new FakeReporting();
  const { deps, program } = await paidProgram(reporting);
  await payAndSettle(deps, program.id);
  await deps.db.query(`update claims set payout_transaction_id = null where program_id = $1`, [program.id]);
  reporting.refreshedAt = "2026-11-05T00:00:00Z";
  const result = (await reconcileProgram(deps, program.id))!;
  assert.equal(result.problems.filter((p) => p.problem.includes("no transaction ID")).length, 0);
  const [row] = await deps.db.query<{ n: number }>(`select count(*)::int as n from claims where program_id = $1 and payout_transaction_id is not null`, [program.id]);
  assert.equal(row!.n, 3);
  await deps.db.close();
});
