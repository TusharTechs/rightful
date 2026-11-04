import assert from "node:assert/strict";
import { test } from "node:test";
import { PayPalClient, PayPalError } from "../src/paypal/client.ts";
import { createPayoutBatch } from "../src/paypal/payouts.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that records calls and answers from a script. Token requests always succeed. */
function scriptedFetch(replies: Reply[]) {
  const calls: Call[] = [];
  let tokens = 0;
  const fake = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) {
      tokens++;
      return json(200, { access_token: `token-${tokens}`, expires_in: 32400, scope: "openid https://uri.paypal.com/services/payments/payouts" });
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body as string | undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected call to ${url}`);
    if (reply instanceof Error) throw reply;
    return json(reply.status, reply.body, reply.headers);
  }) as typeof fetch;
  return { fake, calls, tokenCount: () => tokens };
}

function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fake: typeof fetch) {
  return new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake, sleep: async () => {} });
}

const BATCH = {
  senderBatchId: "prg_test-1",
  emailSubject: "Your payment",
  items: [{ itemId: "clm_00000001", recipientType: "PAYPAL_ID" as const, receiver: "PAYERID123", amountCents: 4878, note: "Your approved claim" }],
};

test("a payout goes to a PayPal account ID in integer-cent pricing, keyed by the batch", async () => {
  const { fake, calls } = scriptedFetch([{ status: 201, body: { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } } }]);
  const batch = await createPayoutBatch(client(fake), BATCH);
  assert.equal(batch.batch_header.payout_batch_id, "BATCH1");
  const sent = JSON.parse(calls[0]!.body!);
  assert.equal(sent.sender_batch_header.sender_batch_id, "prg_test-1");
  assert.deepEqual(sent.items[0], { recipient_type: "PAYPAL_ID", receiver: "PAYERID123", sender_item_id: "clm_00000001", note: "Your approved claim", amount: { currency: "USD", value: "48.78" } });
  assert.equal(calls[0]!.headers["PayPal-Request-Id"], "prg_test-1");
});

test("a retried payout reuses the same PayPal-Request-Id, so it can never pay twice", async () => {
  const { fake, calls } = scriptedFetch([
    { status: 503, body: { name: "SERVICE_UNAVAILABLE" } },
    new TypeError("socket hang up"),
    { status: 201, body: { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } } },
  ]);
  const batch = await createPayoutBatch(client(fake), BATCH);
  assert.equal(batch.batch_header.payout_batch_id, "BATCH1");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.headers["PayPal-Request-Id"] === "prg_test-1"));
});

test("a POST without an idempotency key is not retried", async () => {
  const { fake, calls } = scriptedFetch([{ status: 500, body: { name: "INTERNAL_SERVER_ERROR", debug_id: "abc123" } }]);
  await assert.rejects(client(fake).request("POST", "/v1/anything", { body: {} }), (err: unknown) => {
    assert.ok(err instanceof PayPalError);
    assert.equal(err.status, 500);
    assert.equal(err.debugId, "abc123");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("the access token is cached, and refreshed once on a 401", async () => {
  const { fake, calls, tokenCount } = scriptedFetch([
    { status: 200, body: { ok: 1 } },
    { status: 200, body: { ok: 2 } },
    { status: 401, body: { name: "AUTHENTICATION_FAILURE" } },
    { status: 200, body: { ok: 3 } },
  ]);
  const paypal = client(fake);
  await paypal.request("GET", "/v1/a");
  await paypal.request("GET", "/v1/b");
  assert.equal(tokenCount(), 1);
  await paypal.request("GET", "/v1/c");
  assert.equal(tokenCount(), 2);
  assert.equal(calls[2]!.headers.Authorization, "Bearer token-1");
  assert.equal(calls[3]!.headers.Authorization, "Bearer token-2");
});

test("PayPal's most specific issue code is surfaced", async () => {
  const { fake } = scriptedFetch([
    {
      status: 403,
      body: {
        name: "NOT_AUTHORIZED",
        message: "Authorization failed due to insufficient permissions.",
        debug_id: "f00d",
        details: [{ issue: "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE", description: "The API caller is not enabled to vault." }],
      },
    },
  ]);
  await assert.rejects(client(fake).request("POST", "/v3/vault/setup-tokens", { body: {}, idempotencyKey: "k" }), (err: unknown) => {
    assert.ok(err instanceof PayPalError);
    assert.equal(err.issue, "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE");
    return true;
  });
});

test("only the sandbox is allowed", () => {
  assert.throws(() => PayPalClient.fromEnv({ PAYPAL_ENV: "live", PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }), /sandbox/);
  assert.throws(() => PayPalClient.fromEnv({ PAYPAL_ENV: "sandbox" }), /PAYPAL_CLIENT_ID/);
});

test("a request that hangs is aborted per attempt and retried when it is safe to", async (t) => {
  // AbortSignal.timeout does not keep the process alive (a server does); hold it open for the test.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  let calls = 0;
  const hangsOnce = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (String(input).endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", expires_in: 32400 });
    calls++;
    if (calls === 1) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    return json(200, { ok: true });
  }) as typeof fetch;
  const paypal = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: hangsOnce, sleep: async () => {}, timeoutMs: 20 });
  assert.deepEqual(await paypal.request("GET", "/v1/payments/payouts/B1"), { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  const neverAnswers = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (String(input).endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", expires_in: 32400 });
    calls++;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof fetch;
  const strict = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: neverAnswers, sleep: async () => {}, timeoutMs: 20 });
  await assert.rejects(strict.request("POST", "/v1/payments/payouts", { body: {} }));
  assert.equal(calls, 1, "a money call without an idempotency key is never retried");
});
