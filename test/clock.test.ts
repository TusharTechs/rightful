import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { timeOfRound } from "../src/ballot/drand.ts";
import { tick } from "../src/ballots/clock.ts";
import { type Deps, completeEntry, createBallot, getBallot, startEntry } from "../src/ballots/service.ts";
import { openPGlite } from "../src/db/db.ts";
import { FakePayPal } from "../src/dev/fake-paypal.ts";

test("the clock seals at close, draws when the round lands, then settles", async () => {
  const paypal = new FakePayPal();
  const clock = { now: new Date("2026-11-02T18:00:00Z") };
  const deps: Deps = {
    db: await openPGlite(),
    paypal,
    humanSecret: new Uint8Array(32).fill(4),
    beacon: async (round) => ({ round, randomness: createHash("sha256").update(String(round)).digest("hex"), signature: "sig" }),
    now: () => clock.now,
    returnBase: "http://localhost:8787/paypal",
  };
  const ballot = await createBallot(deps, { title: "Clocked", priceCents: 1000, inventory: 1, perHumanLimit: 1, closesAt: new Date(clock.now.getTime() + 60_000) });
  for (const payer of ["C1", "C2"]) {
    const { entry } = await startEntry(deps, ballot.id, 1);
    paypal.approve(entry.order_id!, { payerId: payer });
    await completeEntry(deps, entry.id);
  }

  assert.deepEqual(await tick(deps), { sealed: [], drawn: [], settled: [], errors: [] }, "nothing is due before close");

  clock.now = new Date(clock.now.getTime() + 61_000);
  const first = await tick(deps);
  assert.deepEqual(first.sealed, [ballot.id]);
  assert.deepEqual(first.drawn, [], "the round is still in the future right after sealing");

  clock.now = new Date(timeOfRound((await getBallot(deps.db, ballot.id)).draw_round!).getTime() + 1);
  const second = await tick(deps);
  assert.deepEqual([second.drawn, second.settled], [[ballot.id], [ballot.id]]);
  assert.equal((await getBallot(deps.db, ballot.id)).status, "settled");
  assert.deepEqual(await tick(deps), { sealed: [], drawn: [], settled: [], errors: [] }, "settled ballots are left alone");
});
