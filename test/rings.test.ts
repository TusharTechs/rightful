import assert from "node:assert/strict";
import { test } from "node:test";
import { findRings } from "../src/rings/cluster.ts";
import { score } from "../src/rings/score.ts";
import { type ClaimSignals, canonicalAddress, canonicalEmail, privateDomain } from "../src/rings/signals.ts";
import { SAMPLE_TEXT, type SyntheticProgram, generateProgram, rng } from "../src/rings/synthetic.ts";

const T0 = Date.UTC(2026, 8, 1);
const HOUR = 3_600_000;

/** Unrelated claimants: nothing shared, filed days apart. */
function strangers(count: number, prefix = "s"): ClaimSignals[] {
  const r = rng(prefix);
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i}`,
    humanTag: r.hex(64),
    verified: true,
    email: `${prefix}${i}.${r.letters(6)}@gmail.com`,
    address: `${100 + i} ${r.letters(7)} Road, Fairhaven, OR 97001`,
    ip: `10.${i % 250}.${Math.floor(i / 250)}.${r.int(2, 254)}`,
    device: r.hex(16),
    filedAt: T0 + i * 7 * HOUR,
    narrative: `${r.letters(5)} ${r.letters(4)} ${r.letters(6)} ${r.letters(3)} ${r.letters(7)} ${r.letters(5)}`,
  }));
}

test("mailboxes that deliver to the same inbox collide", () => {
  assert.equal(canonicalEmail("Ava.Lind+claims@gmail.com"), "avalind@gmail.com");
  assert.equal(canonicalEmail("a.v.a.lind@googlemail.com"), "avalind@gmail.com");
  assert.equal(canonicalEmail("ava.lind+x@fox-net.example"), "ava.lind@fox-net.example");
  assert.equal(privateDomain("someone@gmail.com"), "");
  assert.equal(privateDomain("someone+x@Fox-Net.example"), "fox-net.example");
});

test("addresses collide by building whatever the unit or spelling", () => {
  const a = canonicalAddress("12 Oak Street Apt 3, Fairhaven, OR 97001");
  const b = canonicalAddress("12 oak st. #14, Fairhaven OR 97001");
  const c = canonicalAddress("12 Oak St Unit 3, Fairhaven, OR 97001");
  assert.equal(a.building, b.building);
  assert.notEqual(a.full, b.full);
  assert.equal(a.full, c.full);
});

test("a device farm is one ring; a household sharing a laptop and router is not", () => {
  const farm: ClaimSignals[] = strangers(8, "farm").map((claim, i) => ({ ...claim, device: i % 2 ? "dev_a" : "dev_b", filedAt: T0 + i * 60_000, narrative: "We used the pitcher every day and later learned the lead claim on the package was not true." }));
  const household: ClaimSignals[] = strangers(4, "home").map((claim, i) => ({ ...claim, address: "77 Birch Lane, Millbrook, OH 43001", ip: "10.9.9.9", device: "family_laptop", filedAt: T0 + i * 10 * 60_000 }));
  const rings = findRings([...strangers(40), ...farm, ...household]);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0]!.claimIds, farm.map((c) => c.id).sort());
  assert.ok(rings[0]!.signals.device > 0 && rings[0]!.signals.narrative > 0);
});

test("a dorm on one campus network is not a ring", () => {
  const dorm = strangers(20, "dorm").map((claim, i) => ({ ...claim, address: `400 Penhallow Hall Room ${100 + i}, Marlow, IL 60001`, ip: `10.200.1.${i + 2}`, filedAt: T0 + i * 20 * 60_000 }));
  assert.deepEqual(findRings(dorm), []);
});

test("copying the sample text is not evidence", () => {
  const pasters = strangers(12, "paste").map((claim, i) => ({ ...claim, narrative: SAMPLE_TEXT, filedAt: T0 + i * 60_000 }));
  assert.equal(findRings(pasters, { sampleText: SAMPLE_TEXT }).length, 0);
  assert.equal(findRings(pasters).length, 1, "without the sample text, the same claims look like a template crew");
});

test("synthetic programs are deterministic in the seed", () => {
  const a = generateProgram({ seed: "7", claims: 600 });
  const b = generateProgram({ seed: "7", claims: 600 });
  assert.deepEqual(a.claims, b.claims);
  assert.equal(a.claims.length, 600);
  const ringClaims = [...a.truth.values()].filter((t) => t.ring).length;
  assert.equal(ringClaims, 180);
  assert.equal(new Set(a.claims.map((c) => c.humanTag)).size, 600, "every claim comes from its own PayPal account");
  assert.notDeepEqual(generateProgram({ seed: "8", claims: 600 }).claims, a.claims);
});

test("scores count ring claims as positives and split the pool over paid claims", () => {
  const claims = strangers(4, "score");
  const program: SyntheticProgram = {
    sampleText: "",
    claims,
    rings: [{ id: "r1", kind: "device-farm", size: 2 }],
    truth: new Map([
      ["score_0", { ring: "r1", kind: "device-farm" }],
      ["score_1", { ring: "r1", kind: "device-farm" }],
      ["score_2", { ring: null, kind: "solo" }],
      ["score_3", { ring: null, kind: "household" }],
    ]),
  };
  const s = score(program, new Set(["score_0", "score_2"]), 3000);
  assert.equal(s.precision, 0.5);
  assert.equal(s.recall, 0.5);
  assert.equal(s.falseHoldRate, 0.5);
  assert.equal(s.perGenuineCents, 1500);
  assert.equal(s.ringPaidCents, 1500);
  assert.deepEqual(s.falseHoldByKind, { solo: 1, household: 0 });
});

test("the detector holds its measured floor on a held-out program", () => {
  const program = generateProgram({ seed: "101", claims: 3000 });
  const flagged = new Set(findRings(program.claims, { sampleText: program.sampleText }).flatMap((ring) => ring.claimIds));
  const s = score(program, flagged, 200_000_000);
  assert.ok(s.precision >= 0.97, `precision ${s.precision}`);
  assert.ok(s.recall >= 0.85, `recall ${s.recall}`);
  assert.ok(s.falseHoldRate <= 0.01, `false holds ${s.falseHoldRate}`);
});
