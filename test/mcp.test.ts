import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/api/app.ts";
import { MCP_TOOLS } from "../src/api/mcp.ts";
import { type ClaimsDeps, bindClaim, createProgram, getClaim, passAfterLogin } from "../src/claims/service.ts";
import { openPGlite } from "../src/db/db.ts";

const SECRET = new Uint8Array(32).fill(3);

async function setup() {
  const deps: ClaimsDeps = { db: await openPGlite(), humanSecret: SECRET, now: () => new Date("2026-11-04T12:00:00Z") };
  const program = await createProgram(deps, { title: "Pitcher settlement", poolCents: 10_000, closesAt: new Date("2026-11-05T12:00:00Z") });
  const app = createApp(deps, { adminToken: "admin-token-for-tests", publicBase: "https://api.example" });
  let n = 0;
  const rpc = async (method: string, params: unknown = {}, ip = "203.0.113.9") => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": ip },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    });
    assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: any; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const call = (name: string, args: Record<string, unknown>, ip?: string) => rpc("tools/call", { name, arguments: args }, ip);
  return { deps, program, rpc, call };
}

const claim = (programId: string, i = 0) => ({
  programId,
  email: `person${i}@example.com`,
  address: `${i + 1} Elm Street, Marlow, IL 60001`,
  narrative: "I bought two pitchers in 2022 and the filters failed.",
  agentName: "Helpful Assistant",
});

test("an assistant can file and follow claims, and has no tool to confirm, decide or pay", async () => {
  const { deps, program, rpc, call } = await setup();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.serverInfo.name, "rightful-claims");
  assert.match(init.instructions, /never confirm one or receive money/);

  const { tools } = await rpc("tools/list");
  assert.deepEqual(tools.map((t: { name: string }) => t.name).sort(), [...MCP_TOOLS].sort());
  for (const t of tools) assert.doesNotMatch(t.name, /bind|confirm|approve|deny|decide|pay|distribute|payout/, `no tool like ${t.name}`);

  const listed = await call("list_programs", {});
  assert.deepEqual(listed.structuredContent.programs.map((p: { id: string }) => p.id), [program.id]);

  const filed = await call("file_claim", claim(program.id));
  assert.equal(filed.isError, undefined);
  const out = filed.structuredContent;
  assert.equal(out.status, "unbound");
  assert.equal(out.humanConfirmationRequired, true);
  assert.match(out.bindUrl, /^https:\/\/api\.example\/claim\/bind\?claim=clm_.+&code=/);
  assert.equal(out.bound, false);

  const stored = await getClaim(deps.db, out.id);
  assert.equal(stored.filed_via, "agent");
  assert.equal(stored.agent_name, "Helpful Assistant");
  assert.equal(stored.human_tag, null, "no PayPal account is attached until the person confirms");

  // Only the person, signing in with PayPal, binds it.
  const code = new URL(out.bindUrl).searchParams.get("code")!;
  await bindClaim(deps, out.id, code, passAfterLogin(deps, program.id, "PAYER_PERSON", true));
  const status = await call("claim_status", { claimId: out.id });
  assert.equal(status.structuredContent.status, "filed");
  assert.equal(status.structuredContent.bound, true);
  assert.doesNotMatch(JSON.stringify(status), /PAYER_PERSON|person0@example/, "no PayPal ID or personal data back to the agent");

  const receipt = await call("get_receipt", { claimId: out.id });
  assert.equal(receipt.isError, true, "no receipt before the program pays");
  await deps.db.close();
});

test("MCP filings share the JSON API's limit, and bad input is refused by the schema", async () => {
  const { deps, program, call } = await setup();
  for (let i = 0; i < 30; i++) assert.equal((await call("file_claim", claim(program.id, i), `198.51.100.${i + 1}`)).isError, undefined);
  const limited = await call("file_claim", claim(program.id, 99), "198.51.100.250");
  assert.equal(limited.isError, true);
  assert.match(limited.content[0].text, /rate_limited/);

  const bad = await call("file_claim", { ...claim(program.id), email: "not-an-email" }, "192.0.2.1");
  assert.equal(bad.isError, true);
  const missing = await call("claim_status", { claimId: "clm_nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not_found/);
  await deps.db.close();
});
