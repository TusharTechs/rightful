import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChainClient, fetchBeacon } from "drand-client";
import { type BallotTerms, type PublicEntry, commit, leafHash, proveInclusion, sortedLeaves, verifyInclusion } from "../src/ballot/commit.ts";
import { draw, verifyDraw } from "../src/ballot/draw.ts";
import { QUICKNET, roundAtOrAfter, timeOfRound } from "../src/ballot/drand.ts";
import { humanTag } from "../src/ballot/human.ts";

const SECRET = new Uint8Array(32).fill(7);
const BALLOT = "ballot_test_0001";

/** A real quicknet beacon, so signature checks run offline. */
const BEACON = {
  round: 1000000,
  randomness: "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
  signature: "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
};

const terms = (overrides: Partial<BallotTerms> = {}): BallotTerms => ({
  ballotId: BALLOT,
  inventory: 10,
  perHumanLimit: 2,
  allowPartial: false,
  round: BEACON.round,
  chainHash: QUICKNET.hash,
  ...overrides,
});

function entries(count: number, quantity = 1): PublicEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    entryId: `entry_${String(i).padStart(4, "0")}`,
    humanTag: humanTag(SECRET, BALLOT, `PAYER${i}`),
    quantity,
  }));
}

test("the draw depends only on the commitment and the randomness", () => {
  const list = entries(50);
  const a = draw(terms(), list, BEACON);
  const b = draw(terms(), [...list].reverse(), BEACON);
  assert.deepEqual(b, a, "entry arrival order does not matter");
  const other = draw(terms(), list, { round: BEACON.round, randomness: "a".repeat(64) });
  assert.notDeepEqual(
    other.line.map((p) => p.entryId),
    a.line.map((p) => p.entryId),
    "different randomness, different line",
  );
  assert.throws(() => draw(terms(), list, { ...BEACON, round: BEACON.round + 1 }), /committed to round/);
});

test("inventory and the per-human limit are never exceeded", () => {
  const sameHuman = humanTag(SECRET, BALLOT, "PAYER_SCALPER");
  const list: PublicEntry[] = [
    ...entries(30, 2),
    ...Array.from({ length: 5 }, (_, i) => ({ entryId: `dupe_${i}_xxxx`, humanTag: sameHuman, quantity: 2 })),
  ];
  const result = draw(terms({ inventory: 25 }), list, BEACON);
  assert.ok(result.selectedUnits <= 25);
  const perHuman = new Map<string, number>();
  for (const placement of result.line) {
    const entry = list.find((e) => e.entryId === placement.entryId)!;
    perHuman.set(entry.humanTag, (perHuman.get(entry.humanTag) ?? 0) + placement.selected);
  }
  assert.ok([...perHuman.values()].every((units) => units <= 2));
  assert.ok((perHuman.get(sameHuman) ?? 0) <= 2, "five entries from one human still get at most the limit");
});

test("whole-entry mode skips an entry that would only partly fit; partial mode fills it", () => {
  const list = entries(4, 2);
  const whole = draw(terms({ inventory: 3 }), list, BEACON);
  assert.equal(whole.selectedUnits, 2);
  assert.ok(whole.line.every((p) => p.selected === 0 || p.selected === 2));
  const partial = draw(terms({ inventory: 3, allowPartial: true }), list, BEACON);
  assert.equal(partial.selectedUnits, 3);
});

test("anyone can recompute a published draw, and tampering shows up", () => {
  const list = entries(40);
  const published = draw(terms(), list, BEACON);
  assert.deepEqual(verifyDraw(terms(), list, BEACON, published), []);

  const swapped = structuredClone(published);
  [swapped.line[0], swapped.line[30]] = [swapped.line[30]!, swapped.line[0]!];
  assert.ok(verifyDraw(terms(), list, BEACON, swapped).some((m) => m.field === "line"));

  const withExtra = [...list, { entryId: "late_entry_0001", humanTag: humanTag(SECRET, BALLOT, "LATE"), quantity: 1 }];
  assert.ok(verifyDraw(terms(), withExtra, BEACON, published).some((m) => m.field === "commitment"));

  assert.notEqual(commit(terms({ round: BEACON.round + 1 }), list).digest, published.commitment.digest, "the round is part of the commitment");
});

test("every fan can prove their entry is under the published root", () => {
  for (const count of [1, 2, 3, 7, 64, 101]) {
    const list = entries(count);
    const leaves = sortedLeaves(BALLOT, list);
    const { root } = commit(terms(), list);
    for (const entry of [list[0]!, list[count - 1]!]) {
      const proof = proveInclusion(leaves, leafHash(BALLOT, entry));
      assert.ok(verifyInclusion(root, proof), `count ${count}`);
      const forged = { ...proof, leaf: leafHash(BALLOT, { ...entry, quantity: entry.quantity + 1 }) };
      assert.equal(verifyInclusion(root, forged), false);
    }
  }
});

test("duplicate entries and malformed input are refused", () => {
  const list = entries(3);
  assert.throws(() => commit(terms(), [...list, list[0]!]), /duplicate/);
  assert.throws(() => commit(terms(), [{ ...list[0]!, quantity: 0 }]), /quantity/);
  assert.throws(() => commit(terms({ inventory: 0 }), list), /inventory/);
  assert.throws(() => humanTag(new Uint8Array(8), BALLOT, "P"), RangeError);
});

test("pseudonyms are stable within a ballot and unlinkable across ballots", () => {
  assert.equal(humanTag(SECRET, BALLOT, "PAYER1"), humanTag(SECRET, BALLOT, "PAYER1"));
  assert.notEqual(humanTag(SECRET, BALLOT, "PAYER1"), humanTag(SECRET, "another_ballot", "PAYER1"));
});

test("drand beacons are checked against quicknet's public key", async () => {
  const fixtureClient = (beacon: typeof BEACON): ChainClient => ({
    options: { disableBeaconVerification: false, noCache: true, chainVerificationParams: { chainHash: QUICKNET.hash, publicKey: QUICKNET.public_key } },
    chain: () => ({ baseUrl: "fixture", info: async () => QUICKNET }),
    latest: async () => beacon,
    get: async () => beacon,
  });
  const ok = await fetchBeacon(fixtureClient(BEACON), BEACON.round);
  assert.equal(ok.randomness, BEACON.randomness);
  await assert.rejects(fetchBeacon(fixtureClient({ ...BEACON, randomness: "c".repeat(64) }), BEACON.round));
  await assert.rejects(fetchBeacon(fixtureClient({ ...BEACON, signature: BEACON.signature.replace(/^83/, "84") }), BEACON.round));
});

test("draw times map to rounds", () => {
  const at = new Date(Date.UTC(2026, 10, 12, 20, 0, 0));
  const round = roundAtOrAfter(at);
  assert.ok(timeOfRound(round).getTime() >= at.getTime());
  assert.ok(timeOfRound(round - 1).getTime() < at.getTime());
});
