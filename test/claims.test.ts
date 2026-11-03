import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/api/app.ts";
import type { Deps } from "../src/ballots/service.ts";
import { claimKeys, issuePass, openPayee, readPass, sealPayee } from "../src/claims/pass.ts";
import {
  type ClaimsDeps,
  ClaimError,
  bindClaim,
  createProgram,
  decideClaims,
  fileClaim,
  getClaim,
  passAfterLogin,
  reviewProgram,
} from "../src/claims/service.ts";
import { openPGlite } from "../src/db/db.ts";
import { FakePayPal } from "../src/dev/fake-paypal.ts";
import type { UserInfo } from "../src/paypal/identity.ts";

const SECRET = new Uint8Array(32).fill(9);
const T0 = new Date("2026-11-01T18:00:00Z");

async function setup() {
  const clock = { now: T0 };
  const deps: ClaimsDeps = { db: await openPGlite(), humanSecret: SECRET, now: () => clock.now };
  const program = await createProgram(deps, { title: "Filter pitcher settlement", poolCents: 100_000, closesAt: new Date(T0.getTime() + 3_600_000), sampleText: "I bought the pitcher." });
  return { deps, clock, program };
}

let n = 0;
const form = (overrides: Partial<{ email: string; address: string; narrative: string; device: string }> = {}) => {
  n++;
  return { email: `person${n}@example.com`, address: `${n} Elm Street, Marlow, IL 60001`, narrative: `Claim number ${n} in my own words, ${n * 7} filters.`, device: `device-${n}`, ...overrides };
};

const rejects = (code: ClaimError["code"]) => (err: unknown) => err instanceof ClaimError && err.code === code;

test("a claim pass hides the payer ID and cannot be altered or reused late", () => {
  const { passKey, payeeKey } = claimKeys(SECRET);
  const sealed = sealPayee(payeeKey, "PAYER123");
  assert.equal(openPayee(payeeKey, sealed), "PAYER123");
  assert.notEqual(sealPayee(payeeKey, "PAYER123"), sealed, "sealing is randomized");
  assert.throws(() => openPayee(claimKeys(new Uint8Array(32).fill(1)).payeeKey, sealed), "another key cannot open it");

  const token = issuePass(passKey, { programId: "prg_a", humanTag: "tag", verified: true, payee: sealed }, 1000);
  assert.doesNotMatch(Buffer.from(token.split(".")[0]!, "base64url").toString(), /PAYER123/);
  assert.equal(readPass(passKey, token, 2000)?.humanTag, "tag");
  assert.equal(readPass(passKey, token, 1000 + 31 * 60_000), null, "expired");
  const [body, sig] = token.split(".");
  const forged = Buffer.from(Buffer.from(body!, "base64url").toString().replace('"verified":true', '"verified":false')).toString("base64url");
  assert.equal(readPass(passKey, `${forged}.${sig}`, 2000), null, "tampered");
});

test("one claim per PayPal account, however it is filed", async () => {
  const { deps, program } = await setup();
  const pass = passAfterLogin(deps, program.id, "PAYER_A", true);
  const { claim } = await fileClaim(deps, program.id, form(), { via: "web", pass, ip: "203.0.113.9" });
  assert.equal(claim.status, "filed");
  assert.equal(claim.network, "203.0.113", "only the /24 is kept");
  assert.notEqual(claim.payee_sealed, null);
  assert.doesNotMatch(JSON.stringify(claim), /PAYER_A/, "the payer ID is never stored in clear");

  await assert.rejects(fileClaim(deps, program.id, form(), { via: "web", pass, ip: "198.51.100.1" }), rejects("duplicate"));

  const { claim: filedByAgent, bindCode } = await fileClaim(deps, program.id, form(), { via: "agent", ip: "198.51.100.2" });
  assert.equal(filedByAgent.status, "unbound");
  await assert.rejects(bindClaim(deps, filedByAgent.id, bindCode!, passAfterLogin(deps, program.id, "PAYER_A", true)), rejects("duplicate"));
  assert.equal((await getClaim(deps.db, filedByAgent.id)).status, "unbound", "the refused bind changed nothing");
});

test("agents can file, and only the person who confirms gets the claim", async () => {
  const { deps, program } = await setup();
  const { claim, bindCode } = await fileClaim(deps, program.id, form(), { via: "agent", ip: "198.51.100.7" });
  const pass = passAfterLogin(deps, program.id, "PAYER_B", true);
  await assert.rejects(bindClaim(deps, claim.id, "wrong-code", pass), rejects("unauthorized"));
  await assert.rejects(bindClaim(deps, claim.id, bindCode!, "not-a-pass"), rejects("unauthorized"));
  const other = await createProgram(deps, { title: "Another", poolCents: 100, closesAt: new Date(T0.getTime() + 60_000) });
  await assert.rejects(bindClaim(deps, claim.id, bindCode!, passAfterLogin(deps, other.id, "PAYER_B", true)), rejects("unauthorized"));

  const bound = await bindClaim(deps, claim.id, bindCode!, pass);
  assert.equal(bound.status, "filed");
  assert.equal(bound.bind_code_hash, null, "the code is spent");
  await assert.rejects(bindClaim(deps, claim.id, bindCode!, passAfterLogin(deps, program.id, "PAYER_C", true)), rejects("unauthorized"));
});

test("unverified accounts wait; closed programs refuse", async () => {
  const { deps, clock, program } = await setup();
  const { claim } = await fileClaim(deps, program.id, form(), { via: "web", pass: passAfterLogin(deps, program.id, "PAYER_U", false), ip: "" });
  assert.equal(claim.status, "held");
  assert.equal(claim.hold_reason, "unverified");
  assert.equal(claim.network, "");

  clock.now = new Date(T0.getTime() + 3_600_000);
  await assert.rejects(fileClaim(deps, program.id, form(), { via: "agent", ip: "" }), rejects("closed"));
});

test("review holds rings and unverified claims for a person, and approves the rest", async () => {
  const { deps, clock, program } = await setup();
  for (let i = 0; i < 12; i++) {
    await fileClaim(deps, program.id, form(), { via: "web", pass: passAfterLogin(deps, program.id, `GENUINE_${i}`, true), ip: `10.${i}.0.1` });
  }
  const farm: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { claim } = await fileClaim(deps, program.id, form({ device: "farm-laptop" }), { via: "web", pass: passAfterLogin(deps, program.id, `FARMED_${i}`, true), ip: `172.16.${i}.9` });
    farm.push(claim.id);
  }
  await fileClaim(deps, program.id, form(), { via: "web", pass: passAfterLogin(deps, program.id, "NOT_VERIFIED", false), ip: "10.99.0.1" });
  await fileClaim(deps, program.id, form(), { via: "agent", ip: "10.98.0.1" });

  await assert.rejects(reviewProgram(deps, program.id), rejects("wrong_state"), "not before close");
  clock.now = new Date(T0.getTime() + 3_600_000);
  const report = await reviewProgram(deps, program.id);
  assert.equal(report.rings.length, 1);
  assert.deepEqual(report.rings[0]!.claimIds, [...farm].sort());
  assert.deepEqual(report.held, { ring: 6, unverified: 1 });
  assert.equal(report.approved, 12);
  assert.equal(report.unbound, 1);

  assert.equal(await decideClaims(deps, program.id, { ringId: report.rings[0]!.id }, "deny"), 6);
  const statuses = await deps.db.query<{ status: string; n: number }>(`select status, count(*)::int as n from claims group by status order by status`);
  assert.deepEqual(Object.fromEntries(statuses.map((r) => [r.status, r.n])), { approved: 12, denied: 6, held: 1, unbound: 1 });
});

test("over HTTP: sign in, file; an agent files, its person signs in and confirms", async () => {
  const clock = { now: T0 };
  const deps: Deps = {
    db: await openPGlite(),
    paypal: new FakePayPal(),
    humanSecret: SECRET,
    beacon: async (round) => ({ round, randomness: "0".repeat(64), signature: "sig" }),
    now: () => clock.now,
    returnBase: "http://localhost:8787/paypal",
  };
  let nextUser: UserInfo = { payer_id: "PAYER_WEB", verified_account: "true" };
  const app = createApp(deps, {
    adminToken: "t",
    publicBase: "https://rightful.example",
    login: { clientId: "client", redirectUri: "https://rightful.example/auth/paypal/callback", stateKey: new Uint8Array(32).fill(4), exchange: async () => nextUser },
  });
  const admin = { authorization: "Bearer t", "content-type": "application/json" };
  const created = await app.request("/api/programs", { method: "POST", headers: admin, body: JSON.stringify({ title: "Pitcher settlement", poolCents: 200_000_000, closesInSeconds: 3600 }) });
  assert.equal(created.status, 201);
  const program = (await created.json()) as { id: string };

  /** Follows Log in with PayPal for a path that starts it, carrying cookies like a browser. */
  const signIn = async (start: string, jar: string[] = []) => {
    let res = await app.request(start, { headers: { cookie: jar.join("; ") } });
    while (res.status === 302 && !res.headers.get("location")!.startsWith("https://www.sandbox.paypal.com")) {
      jar.push(...res.headers.getSetCookie().map((c) => c.split(";")[0]!));
      res = await app.request(res.headers.get("location")!, { headers: { cookie: jar.join("; ") } });
    }
    jar.push(...res.headers.getSetCookie().map((c) => c.split(";")[0]!));
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    const page = await app.request(`/auth/paypal/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: jar.join("; ") } });
    return { page, html: await page.text(), jar };
  };
  const hidden = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))![1]!.replaceAll("&#61;", "=");

  const web = await signIn(`/claim/start?program=${program.id}`);
  assert.equal(web.page.status, 200);
  assert.match(web.html, /File my claim/);
  assert.doesNotMatch(web.html, /PAYER_WEB/);
  const filed = await app.request("/claim/submit", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.50, 10.0.0.1" },
    body: new URLSearchParams({ pass: hidden(web.html, "pass"), program: program.id, email: "ava@example.com", address: "1 Oak St, Marlow, IL", narrative: "Bought two pitchers.", device: "d1" }),
  });
  assert.equal(filed.status, 201);
  assert.match(await filed.text(), /Claim filed/);

  const agentRes = await app.request(`/api/programs/${program.id}/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "kai@example.com", address: "9 Pine Rd, Marlow, IL", narrative: "My assistant filed this for me.", device: "agent-1" }) });
  assert.equal(agentRes.status, 201);
  const agent = (await agentRes.json()) as { id: string; status: string; bound: boolean; bindUrl: string };
  assert.equal(agent.status, "unbound");
  assert.equal(agent.bound, false);
  const bindUrl = new URL(agent.bindUrl);
  assert.equal(bindUrl.origin, "https://rightful.example");

  nextUser = { payer_id: "PAYER_KAI", verified_account: true };
  const confirm = await signIn(`${bindUrl.pathname}${bindUrl.search}`);
  assert.match(confirm.html, /Is this your claim\?/);
  assert.match(confirm.html, /My assistant filed this for me/);
  const submit = (cookie: string) =>
    app.request("/claim/submit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ pass: hidden(confirm.html, "pass"), claim: agent.id }),
    });
  assert.equal((await submit("")).status, 400, "without the bind cookie the pass alone binds nothing");
  const bound = await submit(confirm.jar.join("; "));
  assert.match(await bound.text(), /Claim confirmed/);
  const view = (await (await app.request(`/api/claims/${agent.id}`)).json()) as { status: string; bound: boolean };
  assert.deepEqual([view.status, view.bound], ["filed", true]);

  const list = (await (await app.request(`/api/programs/${program.id}/claims`, { headers: admin })).json()) as Array<Record<string, unknown>>;
  assert.equal(list.length, 2);
  assert.ok(list.every((c) => !("payee_sealed" in c) && !("bind_code_hash" in c)));
  assert.deepEqual(list.map((c) => c.network).sort(), ["", "203.0.113"]);

  nextUser = { verified_account: true };
  const noId = await signIn(`/claim/start?program=${program.id}`);
  assert.equal(noId.page.status, 502, "no payer ID, no claim");
});
