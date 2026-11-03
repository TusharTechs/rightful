import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { type ChainClient, fetchBeacon } from "drand-client";
import { QUICKNET, roundAtOrAfter, timeOfRound } from "../src/engine/drand.ts";
import { humanTag } from "../src/engine/human.ts";
import { merkleRoot, proveInclusion, verifyInclusion } from "../src/engine/merkle.ts";

const SECRET = new Uint8Array(32).fill(7);

/** A real quicknet beacon, so signature checks run offline. */
const BEACON = {
  round: 1000000,
  randomness: "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
  signature: "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
};

const leaf = (i: number) => createHash("sha256").update(`leaf ${i}`).digest("hex");

test("every leaf proves into the root, for any tree size", () => {
  for (const size of [1, 2, 3, 7, 8, 13, 100]) {
    const leaves = Array.from({ length: size }, (_, i) => leaf(i)).sort();
    const root = merkleRoot(leaves);
    for (const l of leaves) assert.ok(verifyInclusion(root, proveInclusion(leaves, l)), `size ${size}`);
    const proof = proveInclusion(leaves, leaves[0]!);
    assert.equal(verifyInclusion(root, { ...proof, leaf: leaf(999) }), false, "another leaf does not verify");
  }
  assert.notEqual(merkleRoot([leaf(1), leaf(2)]), merkleRoot([leaf(1), leaf(3)]));
  assert.throws(() => proveInclusion([leaf(1)], leaf(2)), /not in this tree/);
});

test("pseudonyms are stable within a program and unlinkable across programs", () => {
  assert.equal(humanTag(SECRET, "prg_a", "PAYER1"), humanTag(SECRET, "prg_a", "PAYER1"));
  assert.notEqual(humanTag(SECRET, "prg_a", "PAYER1"), humanTag(SECRET, "prg_b", "PAYER1"));
  assert.notEqual(humanTag(SECRET, "prg_a", "PAYER1"), humanTag(new Uint8Array(32).fill(8), "prg_a", "PAYER1"));
  assert.throws(() => humanTag(new Uint8Array(8), "prg_a", "P"), RangeError);
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

test("audit times map to rounds", () => {
  const at = new Date(Date.UTC(2026, 10, 12, 20, 0, 0));
  const round = roundAtOrAfter(at);
  assert.ok(timeOfRound(round).getTime() >= at.getTime());
  assert.ok(timeOfRound(round - 1).getTime() < at.getTime());
});
