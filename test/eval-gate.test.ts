/**
 * The eval as a gate: CI fails if the detector or the investigator's recorded triage slips below
 * the numbers the README reports. Held-out seeds only (tuning used seeds 1-5). The investigator part
 * replays recorded answers, so it tests the code around the model (case files, the checks, the
 * rule), not the model itself or its drift.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { findRings } from "../src/rings/cluster.ts";
import { investigateRing } from "../src/rings/investigate.ts";
import { ReplayInvestigator, loadFixtures } from "../src/rings/investigators.ts";
import { score } from "../src/rings/score.ts";
import { generateProgram } from "../src/rings/synthetic.ts";

test("detector on held-out programs 101-110: the README's precision and recall, and no bad seed", () => {
  const scores = Array.from({ length: 10 }, (_, i) => {
    const program = generateProgram({ seed: String(101 + i), claims: 5000 });
    const held = new Set(findRings(program.claims, { sampleText: program.sampleText }).flatMap((r) => r.claimIds));
    return score(program, held, 200_000_000);
  });
  const mean = (pick: (s: (typeof scores)[number]) => number) => scores.reduce((sum, s) => sum + pick(s), 0) / scores.length;
  // README: 99.9% precision, 93.5% recall, 0.1% of genuine claimants held.
  assert.ok(mean((s) => s.precision) >= 0.995, `mean precision ${mean((s) => s.precision)}`);
  assert.ok(mean((s) => s.recall) >= 0.93, `mean recall ${mean((s) => s.recall)}`);
  assert.ok(mean((s) => s.falseHoldRate) <= 0.002, `mean genuine held ${mean((s) => s.falseHoldRate)}`);
  for (const [i, s] of scores.entries()) assert.ok(s.recall >= 0.88 && s.precision >= 0.98, `seed ${101 + i}: ${s.precision} / ${s.recall}`);
});

test("investigator triage on held-out programs (replayed): no ring cleared, deny is right ≥ 97%", async () => {
  const investigator = new ReplayInvestigator(await loadFixtures());
  let denied = 0, deniedRight = 0, ringsCleared = 0;
  for (const seed of ["101", "102", "103", "104", "105"]) {
    const program = generateProgram({ seed, claims: 2000 });
    const byId = new Map(program.claims.map((c) => [c.id, c]));
    for (const ring of findRings(program.claims, { sampleText: program.sampleText, minRingSize: 3 })) {
      const memo = await investigateRing(investigator, ring, byId, program.sampleText);
      const ringClaims = ring.claimIds.filter((id) => program.truth.get(id)!.ring).length;
      const isRing = ringClaims * 2 >= ring.claimIds.length;
      if (memo.recommendation === "deny") {
        denied += ring.claimIds.length;
        deniedRight += ringClaims;
      }
      if (memo.recommendation === "clear" && isRing) ringsCleared++;
    }
  }
  assert.equal(ringsCleared, 0);
  assert.ok(deniedRight / denied >= 0.97, `deny right ${deniedRight}/${denied}`);
});
