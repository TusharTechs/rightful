import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyInclusion } from "../src/ballot/commit.ts";
import { timeOfRound } from "../src/ballot/drand.ts";
import { verifyDraw } from "../src/ballot/draw.ts";
import { openPGlite } from "../src/db/db.ts";
import {
  type Deps,
  BallotError,
  completeEntry,
  createBallot,
  entryReceipt,
  getBallot,
  publicProof,
  runDraw,
  sealBallot,
  settleBallot,
  startEntry,
} from "../src/ballots/service.ts";
import { FakePayPal } from "./fake-paypal.ts";

const START = new Date("2026-11-01T18:00:00Z");
const PRICE = 2500;

/** A world with a fake PayPal, a real in-memory Postgres, a movable clock and a stand-in beacon. */
async function world() {
  const db = await openPGlite();
  const paypal = new FakePayPal();
  const clock = { now: new Date(START) };
  const deps: Deps = {
    db,
    paypal,
    humanSecret: new Uint8Array(32).fill(9),
    beacon: async (round) => ({
      round,
      randomness: createHash("sha256").update(`round-${round}`).digest("hex"),
      signature: "test-signature",
    }),
    now: () => clock.now,
    returnBase: "http://localhost:5174/paypal",
  };
  const later = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  /** One fan entering: start, approve in "PayPal", complete. */
  const enter = async (ballotId: string, payerId: string, quantity = 1, accountStatus: "VERIFIED" | "UNVERIFIED" = "VERIFIED") => {
    const { entry } = await startEntry(deps, ballotId, quantity);
    paypal.approve(entry.order_id!, { payerId, accountStatus });
    return completeEntry(deps, entry.id);
  };
  const toDrawTime = async (ballotId: string) => {
    const ballot = await getBallot(db, ballotId);
    clock.now = new Date(timeOfRound(ballot.draw_round!).getTime() + 1);
  };
  return { db, paypal, deps, clock, later, enter, toDrawTime };
}

async function openBallot(w: Awaited<ReturnType<typeof world>>, overrides: Partial<Parameters<typeof createBallot>[1]> = {}) {
  return createBallot(w.deps, {
    title: "Night one",
    priceCents: PRICE,
    inventory: 3,
    perHumanLimit: 2,
    maxQuantity: 2,
    closesAt: new Date(START.getTime() + 60_000),
    ...overrides,
  });
}

test("a full ballot: verified humans in, duplicates and unverified out, only selected fans charged", async () => {
  const w = await world();
  const ballot = await openBallot(w);

  const fans = await Promise.all([
    w.enter(ballot.id, "PAYER_A", 2),
    w.enter(ballot.id, "PAYER_B", 1),
    w.enter(ballot.id, "PAYER_C", 2),
    w.enter(ballot.id, "PAYER_D", 1),
    w.enter(ballot.id, "PAYER_E", 1),
  ]);
  assert.ok(fans.every((entry) => entry.status === "held"));

  const duplicate = await w.enter(ballot.id, "PAYER_A", 1);
  assert.equal(duplicate.status, "rejected");
  assert.equal(duplicate.rejection, "duplicate");
  const unverified = await w.enter(ballot.id, "PAYER_Z", 1, "UNVERIFIED");
  assert.equal(unverified.rejection, "unverified");
  for (const rejected of [duplicate, unverified]) {
    assert.equal(w.paypal.authorizations.get(rejected.authorization_id!)!.status, "VOIDED", "a rejected entry's hold is released at once");
  }

  await assert.rejects(sealBallot(w.deps, ballot.id), (err: unknown) => err instanceof BallotError && err.code === "too_early");
  w.later(61_000);
  await assert.rejects(startEntry(w.deps, ballot.id, 1), (err: unknown) => err instanceof BallotError && err.code === "closed");

  const sealed = await sealBallot(w.deps, ballot.id);
  assert.equal(sealed.entry_count, 5);
  assert.ok(timeOfRound(sealed.draw_round!) > w.clock.now, "the deciding round is still in the future when the list is sealed");
  await assert.rejects(runDraw(w.deps, ballot.id), (err: unknown) => err instanceof BallotError && err.code === "too_early");

  await w.toDrawTime(ballot.id);
  const drawn = await runDraw(w.deps, ballot.id);
  assert.equal(drawn.status, "drawn");

  const summary = await settleBallot(w.deps, ballot.id);
  assert.equal((await getBallot(w.db, ballot.id)).status, "settled");

  const entries = await w.db.query<{ id: string; status: string; outcome: string; selected_units: number; authorization_id: string }>(
    `select * from entries where ballot_id = $1 and human_tag is not null and status <> 'rejected'`,
    [ballot.id],
  );
  const selectedUnits = entries.reduce((sum, e) => sum + (e.selected_units ?? 0), 0);
  assert.ok(selectedUnits <= 3);
  for (const entry of entries) {
    const auth = w.paypal.authorizations.get(entry.authorization_id)!;
    if (entry.outcome === "selected") {
      assert.equal(entry.status, "captured");
      assert.equal(auth.capturedCents, PRICE * entry.selected_units);
    } else {
      assert.equal(entry.status, "voided");
      assert.equal(auth.status, "VOIDED");
      assert.equal(auth.capturedCents, 0, "not selected means never charged");
    }
  }
  assert.equal(summary.captured + summary.voided + summary.alreadyFinal, 5);

  // Anyone can recompute the draw from the public proof.
  const proof = await publicProof(w.deps, ballot.id);
  assert.ok(proof.entries!.every((e) => !("payerId" in e)), "the proof carries pseudonyms, not PayPal IDs");
  const beacon = proof.beacon!;
  const published = { commitment: proof.commitment!, round: beacon.round, randomness: beacon.randomness, line: proof.line!, selectedUnits };
  assert.deepEqual(verifyDraw(proof.terms!, proof.entries!, beacon, published), []);

  // And every fan can prove they were in the sealed list.
  for (const fan of fans) {
    const receipt = await entryReceipt(w.deps, fan.id);
    assert.ok(receipt.proof && verifyInclusion(proof.commitment!.root, receipt.proof));
  }
});

test("a crash mid-settlement is resumed without charging anyone twice", async () => {
  const w = await world();
  const ballot = await openBallot(w, { inventory: 2, maxQuantity: 1 });
  for (const payer of ["P1", "P2", "P3", "P4"]) await w.enter(ballot.id, payer);
  w.later(61_000);
  await sealBallot(w.deps, ballot.id);
  await w.toDrawTime(ballot.id);
  await runDraw(w.deps, ballot.id);

  const selected = await w.db.query<{ id: string }>(`select id from entries where ballot_id = $1 and outcome = 'selected'`, [ballot.id]);
  const notSelected = await w.db.query<{ id: string }>(`select id from entries where ballot_id = $1 and outcome = 'not_selected'`, [ballot.id]);
  // PayPal applies these, but our process never hears back.
  w.paypal.loseResponseFor.add(`capture-${selected[0]!.id}`);
  w.paypal.loseResponseFor.add(`void-${notSelected[0]!.id}`);

  await assert.rejects(settleBallot(w.deps, ballot.id, { concurrency: 1 }));
  assert.equal((await getBallot(w.db, ballot.id)).status, "drawn", "not settled while anything is unconfirmed");

  // The scheduler retries the task until it finishes, as a durable workflow would.
  let crashes = 1;
  for (let attempt = 0; (await getBallot(w.db, ballot.id)).status !== "settled" && attempt < 5; attempt++) {
    await settleBallot(w.deps, ballot.id, { concurrency: 1 }).catch(() => crashes++);
  }
  assert.equal(crashes, 2, "both lost responses surfaced as failures");
  assert.equal((await getBallot(w.db, ballot.id)).status, "settled");

  const captures = w.paypal.applied.filter((a) => a.op === "capture");
  const voids = w.paypal.applied.filter((a) => a.op === "void");
  assert.equal(captures.length, 2, "exactly one capture per selected entry");
  assert.equal(new Set(captures.map((c) => c.target)).size, 2);
  assert.equal(voids.length, 2, "exactly one void per other entry");
});

test("settling again changes nothing at PayPal", async () => {
  const w = await world();
  const ballot = await openBallot(w, { inventory: 1, maxQuantity: 1 });
  for (const payer of ["Q1", "Q2", "Q3"]) await w.enter(ballot.id, payer);
  w.later(61_000);
  await sealBallot(w.deps, ballot.id);
  await w.toDrawTime(ballot.id);
  await runDraw(w.deps, ballot.id);
  await settleBallot(w.deps, ballot.id);
  const before = w.paypal.applied.length;
  assert.deepEqual(await settleBallot(w.deps, ballot.id), { captured: 0, voided: 0, failed: 0, alreadyFinal: 0 });
  assert.equal(w.paypal.applied.length, before);
});

test("an approval that lands after close is declined without placing a hold", async () => {
  const w = await world();
  const ballot = await openBallot(w);
  const { entry } = await startEntry(w.deps, ballot.id, 1);
  w.paypal.approve(entry.order_id!, { payerId: "LATE" });
  w.later(61_000);
  const late = await completeEntry(w.deps, entry.id);
  assert.equal(late.rejection, "closed");
  assert.equal(w.paypal.applied.filter((a) => a.op === "authorize").length, 0);
});

test("completing an entry twice authorizes once", async () => {
  const w = await world();
  const ballot = await openBallot(w);
  const held = await w.enter(ballot.id, "TWICE");
  const again = await completeEntry(w.deps, held.id);
  assert.equal(again.status, "held");
  assert.equal(w.paypal.applied.filter((a) => a.op === "authorize").length, 1);
});

test("sealing late moves the deciding round forward so it is never already public", async () => {
  const w = await world();
  const ballot = await openBallot(w);
  await w.enter(ballot.id, "R1");
  w.later(10 * 60_000);
  const sealed = await sealBallot(w.deps, ballot.id);
  assert.ok(sealed.draw_round! > ballot.planned_round);
  assert.ok(timeOfRound(sealed.draw_round!) > w.clock.now);
});
