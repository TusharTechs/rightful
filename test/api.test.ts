import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../src/api/app.ts";
import { timeOfRound } from "../src/ballot/drand.ts";
import { openPGlite } from "../src/db/db.ts";
import type { Deps } from "../src/ballots/service.ts";
import { FakePayPal } from "./fake-paypal.ts";

async function setup() {
  const paypal = new FakePayPal();
  const clock = { now: new Date("2026-11-01T18:00:00Z") };
  const deps: Deps = {
    db: await openPGlite(),
    paypal,
    humanSecret: new Uint8Array(32).fill(3),
    beacon: async (round) => ({ round, randomness: createHash("sha256").update(String(round)).digest("hex"), signature: "sig" }),
    now: () => clock.now,
    returnBase: "http://localhost:8787/paypal",
  };
  const app = createApp(deps, { adminToken: "admin-secret" });
  const asAdmin = { authorization: "Bearer admin-secret", "content-type": "application/json" };
  return { app, paypal, clock, asAdmin };
}

test("organizer actions need the admin token", async () => {
  const { app } = await setup();
  const response = await app.request("/api/ballots", { method: "POST", body: "{}", headers: { authorization: "Bearer nope" } });
  assert.equal(response.status, 401);
});

test("enter through the API, come back from PayPal, and read a verifiable proof", async () => {
  const { app, paypal, clock, asAdmin } = await setup();
  const created = await app.request("/api/ballots", {
    method: "POST",
    headers: asAdmin,
    body: JSON.stringify({ title: "Matinee", priceCents: 1500, inventory: 1, perHumanLimit: 1, closesInSeconds: 60 }),
  });
  assert.equal(created.status, 201);
  const ballot = (await created.json()) as { id: string };

  const entryIds: string[] = [];
  for (const payer of ["FAN_1", "FAN_2"]) {
    const started = await app.request(`/api/ballots/${ballot.id}/entries`, { method: "POST", body: JSON.stringify({ quantity: 1 }), headers: { "content-type": "application/json" } });
    const { entryId, approveUrl } = (await started.json()) as { entryId: string; approveUrl: string };
    assert.match(approveUrl, /^https:\/\//);
    paypal.approve(new URL(approveUrl).searchParams.get("token")!, { payerId: payer });
    const back = await app.request(`/paypal/return?entry=${entryId}`);
    assert.match(await back.text(), /hold is placed/);
    entryIds.push(entryId);
  }

  const tooMany = await app.request(`/api/ballots/${ballot.id}/entries`, { method: "POST", body: JSON.stringify({ quantity: 2 }), headers: { "content-type": "application/json" } });
  assert.equal(tooMany.status, 400);

  assert.equal((await app.request(`/api/ballots/${ballot.id}/seal?early=1`, { method: "POST", headers: asAdmin })).status, 200);
  const view = (await (await app.request(`/api/ballots/${ballot.id}`)).json()) as { drawRound: number; status: string };
  assert.equal(view.status, "sealed");
  assert.equal((await app.request(`/api/ballots/${ballot.id}/draw`, { method: "POST", headers: asAdmin })).status, 425, "too early before the round");

  clock.now = new Date(timeOfRound(view.drawRound).getTime() + 1);
  assert.equal((await app.request(`/api/ballots/${ballot.id}/draw`, { method: "POST", headers: asAdmin })).status, 200);
  const settled = (await (await app.request(`/api/ballots/${ballot.id}/settle`, { method: "POST", headers: asAdmin })).json()) as { captured: number; voided: number };
  assert.deepEqual([settled.captured, settled.voided], [1, 1]);

  const proof = (await (await app.request(`/api/ballots/${ballot.id}/proof`)).json()) as { entries: unknown[]; line: { selected: number }[] };
  assert.equal(proof.entries.length, 2);
  assert.equal(proof.line.filter((p) => p.selected > 0).length, 1);
  assert.doesNotMatch(JSON.stringify(proof), /FAN_1|FAN_2/, "no PayPal payer IDs in public output");

  const receipt = (await (await app.request(`/api/entries/${entryIds[0]}`)).json()) as { inclusionProof: unknown; status: string };
  assert.ok(receipt.inclusionProof);
  assert.ok(["captured", "voided"].includes(receipt.status));
});
