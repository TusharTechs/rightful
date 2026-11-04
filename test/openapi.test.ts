import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import { createApp } from "../src/api/app.ts";
import { ClaimStatus, ClaimWithProgram, FileClaimFields, FiledClaim, Ledger, OPERATIONS, Program, Receipt } from "../src/api/contract.ts";
import { distributeProgram, syncPayouts } from "../src/claims/distribute.ts";
import { type ClaimsDeps, createProgram, fileClaim, passAfterLogin, reviewProgram } from "../src/claims/service.ts";
import { openPGlite } from "../src/db/db.ts";
import { FakePayouts } from "../src/dev/fake-payouts.ts";

const ADMIN = "admin-token-for-tests";

async function setup() {
  const clock = { now: new Date("2026-11-04T12:00:00Z") };
  const deps: ClaimsDeps = { db: await openPGlite(), humanSecret: new Uint8Array(32).fill(8), now: () => clock.now, payouts: new FakePayouts() };
  const app = createApp(deps, { adminToken: ADMIN, publicBase: "https://api.example" });
  const paid = await createProgram(deps, { title: "Paid", poolCents: 200, closesAt: new Date("2026-11-04T13:00:00Z") });
  const { claim } = await fileClaim(deps, paid.id, { email: "a@example.com", address: "1 Oak St", narrative: "bought one", device: "d" }, { via: "web", pass: passAfterLogin(deps, paid.id, "PAYER_A", true), ip: "10.0.0.1" });
  clock.now = new Date("2026-11-04T14:00:00Z");
  await reviewProgram(deps, paid.id);
  await distributeProgram(deps, paid.id);
  await syncPayouts(deps, paid.id);
  await syncPayouts(deps, paid.id);
  const open = await createProgram(deps, { title: "Open", poolCents: 200, closesAt: new Date("2026-11-05T14:00:00Z") });
  return { deps, app, paid, open, claim };
}

test("/openapi.json is OpenAPI 3.1, and every documented route exists", async () => {
  const { deps, app, paid, claim } = await setup();
  const doc = (await (await app.request("/openapi.json")).json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, unknown>> };
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.servers[0]!.url, "https://api.example");
  assert.deepEqual(Object.keys(doc.paths).sort(), Object.keys(OPERATIONS).sort());
  assert.ok(!JSON.stringify(doc).includes("$defs"), "named schemas live under components");

  for (const [path, ops] of Object.entries(OPERATIONS)) {
    for (const method of Object.keys(ops)) {
      const url = path.replace("{programId}", paid.id).replace("{claimId}", claim.id);
      const res = await app.request(url, { method: method.toUpperCase(), headers: { "content-type": "application/json" }, body: method === "post" ? "{}" : undefined });
      // Hono's own 404 is plain text; our errors (even not_found) are JSON.
      assert.match(res.headers.get("content-type") ?? "", /json/, `${method.toUpperCase()} ${path} is routed (got ${res.status})`);
    }
  }
  await deps.db.close();
});

test("real responses match the documented schemas", async () => {
  const { deps, app, paid, open, claim } = await setup();
  const check = async (schema: z.ZodType, res: Response | Promise<Response>, status = 200) => {
    const r = await res;
    assert.equal(r.status, status);
    const parsed = schema.safeParse(await r.json());
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
  };
  await check(Program, app.request(`/api/programs/${paid.id}`));
  await check(ClaimWithProgram, app.request(`/api/claims/${claim.id}`));
  await check(Receipt, app.request(`/api/claims/${claim.id}/proof`));
  await check(Ledger, app.request(`/api/programs/${paid.id}/ledger`));
  await check(FiledClaim, app.request(`/api/programs/${open.id}/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "b@example.com", address: "2 Oak St", narrative: "bought two", agentName: "Helper" }),
  }), 201);
  assert.ok(ClaimStatus.safeParse((await (await app.request(`/api/claims/${claim.id}`)).json())).success);
  await deps.db.close();
});

test("MCP file_claim and the JSON API take the same fields", () => {
  assert.deepEqual(Object.keys(FileClaimFields).sort(), ["address", "agentName", "email", "narrative"]);
  const doc = OPERATIONS["/api/programs/{programId}/claims"]!.post!;
  assert.ok(doc.body, "documented with a request body");
});
