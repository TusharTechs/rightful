import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/api/app.ts";
import { distributeProgram, publicLedger } from "../src/claims/distribute.ts";
import { type ClaimsDeps, createProgram, fileClaim, getClaim, passAfterLogin, reviewProgram } from "../src/claims/service.ts";
import { type WebhookVerifier, paypalWebhookVerifier } from "../src/claims/webhooks.ts";
import { openPGlite } from "../src/db/db.ts";
import { FakePayouts } from "../src/dev/fake-payouts.ts";
import { PayPalClient } from "../src/paypal/client.ts";

const SECRET = new Uint8Array(32).fill(6);

/** Stands in for PayPal's signature check: only deliveries signed "good" are genuine. */
const verifier: WebhookVerifier = async (header) => header("paypal-transmission-sig") === "good";

async function distributed() {
  const clock = { now: new Date("2026-11-04T12:00:00Z") };
  const payouts = new FakePayouts();
  payouts.failing.add("PAYER_2");
  const deps: ClaimsDeps = { db: await openPGlite(), humanSecret: SECRET, now: () => clock.now, payouts };
  const program = await createProgram(deps, { title: "Pitcher", poolCents: 300, closesAt: new Date("2026-11-04T13:00:00Z") });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { claim } = await fileClaim(deps, program.id, { email: `p${i}@example.com`, address: `${i} Oak St`, narrative: `claim ${i}`, device: `d${i}` }, { via: "web", pass: passAfterLogin(deps, program.id, `PAYER_${i}`, true), ip: `10.${i}.0.1` });
    ids.push(claim.id);
  }
  clock.now = new Date("2026-11-04T14:00:00Z");
  await reviewProgram(deps, program.id);
  await distributeProgram(deps, program.id);
  return { deps, program, ids };
}

function itemEvent(id: string, claimId: string, status: string) {
  return JSON.stringify({
    id,
    event_type: `PAYMENT.PAYOUTS-ITEM.${status === "SUCCESS" ? "SUCCEEDED" : status}`,
    resource: { payout_item_id: `ITEM-${claimId}`, transaction_status: status, payout_item: { sender_item_id: claimId } },
  });
}

test("PayPal webhooks: verified, recorded once, and only ever trigger a read-back", async () => {
  const { deps, program, ids } = await distributed();
  const app = createApp(deps, { adminToken: "admin-token-for-tests", webhooks: verifier });
  const deliver = (body: string, sig = "good") =>
    app.request("/webhooks/paypal", { method: "POST", headers: { "content-type": "application/json", "paypal-transmission-sig": sig }, body });
  const stored = async () => (await deps.db.query<{ n: number }>(`select count(*)::int as n from paypal_events`))[0]!.n;

  const forged = await deliver(itemEvent("WH-FORGED", ids[0]!, "SUCCESS"), "forged");
  assert.equal(forged.status, 400);
  assert.equal(await stored(), 0, "an unverified delivery leaves no trace");
  assert.equal((await deliver("not json")).status, 400);

  // The first read-back finds the items still pending.
  const first = await deliver(itemEvent("WH-1", ids[0]!, "PENDING"));
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { programId: string }).programId, program.id);
  assert.equal((await getClaim(deps.db, ids[0]!)).status, "approved");

  // This event says the payout failed; PayPal's read-back says it succeeded, and the read-back wins.
  await deliver(itemEvent("WH-2", ids[0]!, "FAILED"));
  assert.equal((await getClaim(deps.db, ids[0]!)).status, "paid", "the webhook's own status is never trusted");
  assert.equal((await getClaim(deps.db, ids[2]!)).status, "failed");

  const again = await deliver(itemEvent("WH-2", ids[0]!, "FAILED"));
  assert.deepEqual(await again.json(), { status: 200, duplicate: true }, "PayPal's retries change nothing");
  assert.equal(await stored(), 2);

  const stranger = (await (await deliver(itemEvent("WH-3", "clm_not_ours", "SUCCESS"))).json()) as { programId: string | null; outcome: string };
  assert.equal(stranger.programId, null);
  assert.equal(stranger.outcome, "not one of our payouts");

  const { delivery } = await publicLedger(deps, program.id);
  assert.equal(delivery.delivered, 2);
  assert.deepEqual(delivery.notDelivered, [{ claimId: ids[2], status: "FAILED" }]);
  assert.equal(delivery.notDeliveredCents, 100, "the undelivered payout is accounted for, not re-sent");
  assert.equal(delivery.remainderCents, 0);
  assert.deepEqual(delivery.waiting, []);
  assert.equal(delivery.notifications!.count, 2, "only this program's verified notifications");
  assert.equal(delivery.notifications!.types["PAYMENT.PAYOUTS-ITEM.FAILED"], 1);
  await deps.db.close();
});

test("without a verifier the webhook endpoint does not exist", async () => {
  const deps: ClaimsDeps = { db: await openPGlite(), humanSecret: SECRET, now: () => new Date() };
  const res = await createApp(deps, { adminToken: "admin-token-for-tests" }).request("/webhooks/paypal", { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
  await deps.db.close();
});

test("PayPal's signature check gets the event byte for byte, for the webhook found by its URL", async () => {
  const calls: { url: string; body: string | undefined }[] = [];
  const fake = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/v1/oauth2/token")) return reply({ access_token: "t", expires_in: 32400 });
    calls.push({ url, body: init?.body as string | undefined });
    if (url.endsWith("/v1/notifications/webhooks")) return reply({ webhooks: [{ id: "WH-OTHER", url: "https://elsewhere.example/hook", event_types: [] }, { id: "WH-OURS", url: "https://api.example/webhooks/paypal", event_types: [] }] });
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) return reply({ verification_status: JSON.parse(init!.body as string).transmission_sig === "good" ? "SUCCESS" : "FAILURE" });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const verify = paypalWebhookVerifier(new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake, sleep: async () => {} }), { url: "https://api.example/webhooks/paypal" });
  const headers = (sig: string) => (name: string) =>
    ({ "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "tx-1", "paypal-transmission-sig": sig, "paypal-transmission-time": "2026-11-04T12:00:00Z" })[name];
  // Spacing and key order as PayPal sent them; a re-serialized copy would differ.
  const raw = `{"id":"WH-9",  "event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{"amount":1.10}}`;

  assert.equal(await verify(headers("good"), raw), true);
  assert.equal(await verify(headers("bad"), raw), false);
  assert.equal(await verify((name) => (name === "paypal-transmission-sig" ? "good" : undefined), raw), false, "missing headers fail without asking PayPal");

  const checks = calls.filter((c) => c.url.endsWith("verify-webhook-signature"));
  assert.equal(checks.length, 2);
  assert.ok(checks[0]!.body!.endsWith(`"webhook_event":${raw}}`), "the event is passed through untouched");
  assert.equal(JSON.parse(checks[0]!.body!).webhook_id, "WH-OURS");
  assert.equal(calls.filter((c) => c.url.endsWith("/v1/notifications/webhooks")).length, 1, "the webhook ID is looked up once");
});
