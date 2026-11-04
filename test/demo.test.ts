import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/api/app.ts";
import { consoleView } from "../src/claims/console.ts";
import { distributeProgram, publicLedger, syncPayouts } from "../src/claims/distribute.ts";
import { verifyLedger } from "../src/claims/ledger.ts";
import { type ClaimsDeps, createProgram } from "../src/claims/service.ts";
import { openPGlite } from "../src/db/db.ts";
import { FakePayouts } from "../src/dev/fake-payouts.ts";
import { DEMO, DEMO_TTL_MS, MAX_DEMOS, createDemoProgram, demoToken, pruneDemos } from "../src/demo/seed.ts";
import { CachedInvestigator, DEMO_FIXTURES, loadFixtures } from "../src/rings/investigators.ts";

const SECRET = new Uint8Array(32).fill(5);

async function setup() {
  const clock = { now: new Date("2026-11-04T12:00:00Z") };
  const payouts = new FakePayouts();
  const deps: ClaimsDeps = {
    db: await openPGlite(),
    humanSecret: SECRET,
    now: () => clock.now,
    payouts,
    investigator: new CachedInvestigator(await loadFixtures(DEMO_FIXTURES)),
  };
  return { deps, clock, payouts };
}

test("a demo copy is reviewed, investigated from recorded answers, and scored against its truth", async () => {
  const { deps } = await setup();
  const { program } = await createDemoProgram(deps);
  const view = await consoleView(deps, program.id);
  assert.equal(view.program.kind, "demo");
  assert.equal(view.program.status, "review");
  const total = Object.values(view.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, DEMO.claims);
  assert.ok(view.rings.length > 50);
  assert.ok(view.rings.every((ring) => ring.memo), "every ring has a replayed memo");
  const denied = view.rings.filter((r) => r.memo!.recommendation === "deny");
  assert.ok(denied.length > 0 && denied.every((r) => r.truth!.genuineClaims === 0), "deny recommendations hold no genuine claimant");
  assert.ok(view.demo!.payEveryone.toRingsCents > view.demo!.rightful.toRingsCents * 5);
  await deps.db.close();
});

test("the console token opens only its own demo program", async () => {
  const { deps } = await setup();
  const { program, token } = await createDemoProgram(deps);
  const live = await createProgram(deps, { title: "Live", poolCents: 100, closesAt: new Date(deps.now().getTime() + 60_000) });
  const app = createApp(deps, { adminToken: "admin-token-for-tests" });
  const get = (path: string, auth?: string) => app.request(path, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });

  assert.equal((await get(`/api/programs/${program.id}/console`, token)).status, 200);
  assert.equal((await get(`/api/programs/${program.id}/console`)).status, 401);
  assert.equal((await get(`/api/programs/${program.id}/console`, "wrong")).status, 401);
  assert.equal((await get(`/api/programs/${live.id}/console`, token)).status, 401, "not another program");
  assert.equal((await get(`/api/programs/${live.id}/console`, demoToken(SECRET, live.id))).status, 401, "not a live program, even with its own HMAC");
  assert.equal((await get(`/api/programs/${live.id}/console`, "admin-token-for-tests")).status, 200);

  const listed = (await (await get("/api/programs")).json()) as Array<{ id: string }>;
  assert.deepEqual(listed.map((p) => p.id), [live.id], "demo copies are not listed");
  await deps.db.close();
});

test("deciding every ring, then paying, goes through the ledger and never through PayPal", async () => {
  const { deps, payouts } = await setup();
  const { program, token } = await createDemoProgram(deps);
  const app = createApp(deps, { adminToken: "admin-token-for-tests" });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  const before = await consoleView(deps, program.id);
  assert.equal((await post(`/api/programs/${program.id}/distribute`, {})).status, 409, "refuses while rings are held");

  const deny = before.rings.filter((r) => r.memo?.recommendation !== "clear").map((r) => r.id);
  const clear = before.rings.filter((r) => r.memo?.recommendation === "clear").map((r) => r.id);
  assert.equal((await post(`/api/programs/${program.id}/decisions`, { ringIds: deny, decision: "deny" })).status, 200);
  assert.equal((await post(`/api/programs/${program.id}/decisions`, { ringIds: clear, decision: "approve" })).status, 200);

  const after = await consoleView(deps, program.id);
  assert.equal(after.projection.undecidedRings, 0);
  assert.ok(after.demo!.rightful.shareCents > before.demo!.verifiedOnly.shareCents);

  const report = (await (await post(`/api/programs/${program.id}/distribute`, {})).json()) as { claims: number; shareCents: number };
  assert.equal(report.claims, after.projection.claims);
  assert.equal(payouts.sends, 0, "a demo program never reaches the real Payouts port");
  const sync = await syncPayouts(deps, program.id);
  assert.equal(sync.paid, report.claims);
  assert.ok(sync.done);

  const ledger = await publicLedger(deps, program.id);
  assert.deepEqual(verifyLedger(ledger.terms, ledger.payouts, { commitment: ledger.commitment }), []);
  await deps.db.close();
});

test("old and surplus demo copies are pruned, live programs never", async () => {
  const { deps, clock } = await setup();
  const live = await createProgram(deps, { title: "Live", poolCents: 100, closesAt: new Date(clock.now.getTime() + 60_000) });
  const { program } = await createDemoProgram(deps);
  clock.now = new Date(clock.now.getTime() + DEMO_TTL_MS + 1);
  // created_at is the database's clock; age the copy to match.
  await deps.db.query(`update programs set created_at = $2 where id = $1`, [program.id, new Date(clock.now.getTime() - DEMO_TTL_MS - 1)]);
  assert.equal(await pruneDemos(deps), 1);
  const left = await deps.db.query<{ id: string }>(`select id from programs`);
  assert.deepEqual(left.map((r) => r.id), [live.id]);
  const [claims] = await deps.db.query<{ n: number }>(`select count(*)::int as n from claims`);
  assert.equal(claims!.n, 0);
  assert.ok(MAX_DEMOS >= 10);
  await deps.db.close();
});
