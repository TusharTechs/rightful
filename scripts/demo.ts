/**
 * The demo program, offline:
 *
 *   npm run demo              # seed a demo copy in PGlite and print its rings and scoreboard (replay)
 *   npm run demo -- --record  # ask TypeSafe for any ring not yet in eval/demo-investigator.jsonl
 *
 * The hosted API seeds the same program for each visitor (`POST /api/demo`) and replays these answers.
 */

import { parseArgs } from "node:util";
import { consoleView } from "../src/claims/console.ts";
import type { ClaimsDeps } from "../src/claims/service.ts";
import { openPGlite } from "../src/db/db.ts";
import { createDemoProgram } from "../src/demo/seed.ts";
import { CachedInvestigator, DEMO_FIXTURES, FIXTURES, RecordingInvestigator, loadFixtures, typeSafeInvestigator } from "../src/rings/investigators.ts";

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const { values } = parseArgs({ options: { record: { type: "boolean", default: false } } });
if (values.record && !process.env.TYPESAFE_API_KEY) throw new Error("--record needs TYPESAFE_API_KEY (in .env)");

const demoFixtures = await loadFixtures(DEMO_FIXTURES);
const known = new Map([...(await loadFixtures(FIXTURES)), ...demoFixtures]);
const deps: ClaimsDeps = {
  db: await openPGlite(),
  humanSecret: new Uint8Array(32).fill(7),
  now: () => new Date(),
  investigator: values.record ? new RecordingInvestigator(typeSafeInvestigator(), demoFixtures, DEMO_FIXTURES) : new CachedInvestigator(known),
};

const started = Date.now();
const { program } = await createDemoProgram(deps);
const view = await consoleView(deps, program.id);
console.log(`seeded ${program.id} in ${Date.now() - started} ms`);
console.log(JSON.stringify({ counts: view.counts, held: view.held, agentFiled: view.agentFiled, projection: view.projection }, null, 1));
const memos = view.rings.filter((r) => r.memo).length;
console.log(`${view.rings.length} rings, ${memos} with memos`);
const recs = new Map<string, { n: number; ring: number; genuine: number }>();
for (const ring of view.rings) {
  const key = ring.memo?.recommendation ?? "no memo";
  const e = recs.get(key) ?? { n: 0, ring: 0, genuine: 0 };
  e.n++;
  e.ring += ring.truth?.ringClaims ?? 0;
  e.genuine += ring.truth?.genuineClaims ?? 0;
  recs.set(key, e);
}
for (const [rec, e] of recs) console.log(`  ${rec}: ${e.n} rings, ${e.ring} ring claims, ${e.genuine} genuine claims`);
const d = view.demo!;
const show = (name: string, o: typeof d.payEveryone) =>
  console.log(`  ${name}: ${o.claims} paid, ${money(o.shareCents)} each, ${money(o.toRingsCents)} to rings, ${o.genuineUnpaid} genuine unpaid`);
console.log(`truth: ${d.totals.ringClaims} ring claims, ${d.totals.genuineClaims} genuine`);
show("pay everyone ", d.payEveryone);
show("verified only", d.verifiedOnly);
show("rightful now ", d.rightful);
await deps.db.close();
