import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findRings } from "../src/rings/cluster.ts";
import { type CaseFile, type Investigator, type Verdict, caseFileFor, caseKey, evidenceOf, investigateRing, recommend } from "../src/rings/investigate.ts";
import { RecordingInvestigator, ReplayInvestigator, loadFixtures } from "../src/rings/investigators.ts";
import type { ClaimSignals } from "../src/rings/signals.ts";
import { generateProgram } from "../src/rings/synthetic.ts";

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({ coordinated: 0.95, pattern: "device-farm", patternConfidence: 0.9, strength: 3.6, model: "test", ...overrides });

function sample() {
  const program = generateProgram({ seed: "11", claims: 800 });
  const byId = new Map(program.claims.map((c) => [c.id, c]));
  const rings = findRings(program.claims, { sampleText: program.sampleText, minRingSize: 3 });
  return { program, byId, rings };
}

test("case files carry evidence, never emails, addresses, IPs or account tags", () => {
  const { program, byId, rings } = sample();
  for (const ring of rings) {
    const file = caseFileFor(ring, byId, program.sampleText);
    const text = JSON.stringify(file);
    for (const id of ring.claimIds) {
      const claim = byId.get(id)!;
      for (const secret of [claim.email, claim.address, claim.ip, claim.device, claim.humanTag, claim.id]) {
        assert.ok(!text.includes(secret), `case file leaks ${secret}`);
      }
    }
    assert.equal(file.claims, ring.claimIds.length);
    assert.ok(file.members.length <= 15);
    assert.equal(caseKey(caseFileFor(ring, byId, program.sampleText)), caseKey(file), "the same ring gives the same case");
  }
});

test("the memo's facts come from the claims", () => {
  const base = { humanTag: "t", verified: true, address: "12 Oak Street Apt 1, Marlow, IL 60001", ip: "10.1.1.1", narrative: "Bought it once and used it daily." };
  const claims: ClaimSignals[] = [
    { ...base, id: "c_a", email: "ava.lind+1@gmail.com", device: "laptop", filedAt: 0 },
    { ...base, id: "c_b", email: "avalind+2@gmail.com", device: "laptop", filedAt: 60_000, address: "12 oak st #7, Marlow IL 60001" },
    { ...base, id: "c_c", email: "a.valind@gmail.com", device: "laptop", filedAt: 5 * 60_000, verified: false },
  ];
  const ring = findRings(claims, { minRingSize: 3 })[0]!;
  const file = caseFileFor(ring, new Map(claims.map((c) => [c.id, c])));
  assert.deepEqual(file.members.map((m) => m.unit), ["1", "7", "1"]);
  assert.deepEqual(evidenceOf(file), [
    "3 claims came from 1 device.",
    "3 email addresses deliver to 1 inbox (3 shown are dressed up with dots or +tags).",
    "3 claims list 1 building with 2 different units among those shown.",
    "They came from 1 network.",
    "Their stories are 100% the same, word pair for word pair.",
    "All 3 were filed within 5 minutes; 67% from verified PayPal accounts.",
  ]);
});

test("deny only on a confident fraud verdict; clear only a confident benign one with separate inboxes", () => {
  const { program, byId, rings } = sample();
  const file = caseFileFor(rings[0]!, byId, program.sampleText);
  const separate = { ...file, distinct: { ...file.distinct, inboxes: file.claims } };
  const shared = { ...file, distinct: { ...file.distinct, inboxes: file.claims - 1 } };
  assert.equal(recommend(verdict(), separate), "deny");
  assert.equal(recommend(verdict({ coordinated: 0.55 }), separate), "review");
  assert.equal(recommend(verdict({ strength: 2 }), separate), "review");
  assert.equal(recommend(verdict({ pattern: "household" }), separate), "review", "a benign pattern is never denied");
  const family = verdict({ coordinated: 0.3, pattern: "household", patternConfidence: 0.8 });
  assert.equal(recommend(family, separate), "clear");
  assert.equal(recommend(family, shared), "review", "accounts sharing an inbox are never cleared");
  assert.equal(recommend(verdict({ coordinated: 0.2, pattern: "address-mill" }), separate), "review", "low fraud alone does not clear a named ring pattern");
  assert.equal(recommend({ ...family, patternConfidence: 0.5 }, separate), "review");
});

test("answers are recorded once and replayed without the live service", async () => {
  const { program, byId, rings } = sample();
  const path = join(await mkdtemp(join(tmpdir(), "inv-")), "fixtures.jsonl");
  let calls = 0;
  const live: Investigator = {
    async investigate(file: CaseFile) {
      calls++;
      return verdict({ coordinated: file.distinct.devices < file.claims ? 0.9 : 0.1 });
    },
  };
  const recording = new RecordingInvestigator(live, await loadFixtures(path), path);
  const first = await Promise.all(rings.slice(0, 4).map((ring) => investigateRing(recording, ring, byId, program.sampleText)));
  await investigateRing(recording, rings[0]!, byId, program.sampleText);
  assert.equal(calls, 4, "a recorded case is not asked again");
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 4);

  const replay = new ReplayInvestigator(await loadFixtures(path));
  const again = await Promise.all(rings.slice(0, 4).map((ring) => investigateRing(replay, ring, byId, program.sampleText)));
  assert.deepEqual(again, first);
  await assert.rejects(investigateRing(replay, rings[5]!, byId, program.sampleText), /no recorded answer/);
});

test("the model's answers are checked like any input, and a bad answer becomes a review memo", async () => {
  const { program, byId, rings } = sample();
  const ring = rings[0]!;
  const answering = (answer: unknown): Investigator => ({ investigate: async () => answer as Verdict });
  const bad: Array<[string, unknown]> = [
    ["out of range", verdict({ coordinated: 1.7 })],
    ["negative", verdict({ strength: -1 })],
    ["NaN", verdict({ patternConfidence: Number.NaN })],
    ["string number", { ...verdict(), coordinated: "0.9" }],
    ["unknown pattern", { ...verdict(), pattern: "definitely-fine" }],
    ["inherited key as pattern", { ...verdict(), pattern: "toString" }],
    ["not an object", "recommend clear"],
    ["null", null],
  ];
  for (const [name, answer] of bad) {
    const memo = await investigateRing(answering(answer), ring, byId, program.sampleText);
    assert.equal(memo.recommendation, "review", name);
    assert.equal(memo.verdict, null, name);
    assert.ok(memo.rejected, name);
    assert.ok(memo.evidence.length > 0, `${name}: the facts computed in code are still there`);
  }
  const good = await investigateRing(answering(verdict()), ring, byId, program.sampleText);
  assert.equal(good.rejected, undefined);
  assert.ok(good.verdict);
});

test("an investigator that hangs is cut off, and the ring is left for the next run", async () => {
  const { program, byId, rings } = sample();
  const hanging: Investigator = { investigate: () => new Promise(() => {}) };
  await assert.rejects(investigateRing(hanging, rings[0]!, byId, program.sampleText, { timeoutMs: 20 }), /did not answer/);
});
