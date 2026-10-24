import assert from "node:assert/strict";
import { test } from "node:test";
import { PayPalClient, PayPalError } from "../src/paypal/client.ts";
import { captureAuthorization, createHoldOrder } from "../src/paypal/orders.ts";

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

const HOLD = {
  referenceId: "entry_0001",
  amountCents: 15000,
  description: "Ballot hold",
  returnUrl: "http://localhost:5174/return",
  cancelUrl: "http://localhost:5174/cancel",
};

test("a hold order is an AUTHORIZE order with integer-cent pricing and an idempotency key", async () => {
  const { fake, calls } = scriptedFetch([{ status: 201, body: { id: "ORDER1", status: "PAYER_ACTION_REQUIRED" } }]);
  const order = await createHoldOrder(client(fake), HOLD, "hold-entry_0001");
  assert.equal(order.id, "ORDER1");
  const sent = JSON.parse(calls[0]!.body!);
  assert.equal(sent.intent, "AUTHORIZE");
  assert.deepEqual(sent.purchase_units[0].amount, { currency_code: "USD", value: "150.00" });
  assert.equal(sent.payment_source.paypal.experience_context.user_action, "CONTINUE");
  assert.equal(calls[0]!.headers["PayPal-Request-Id"], "hold-entry_0001");
});

test("a retried capture reuses the same PayPal-Request-Id, so it can never capture twice", async () => {
  const { fake, calls } = scriptedFetch([
    { status: 503, body: { name: "SERVICE_UNAVAILABLE" } },
    new TypeError("socket hang up"),
    { status: 201, body: { id: "CAP1", status: "COMPLETED" } },
  ]);
  const capture = await captureAuthorization(client(fake), "AUTH1", { finalCapture: true }, "capture-entry_0001");
  assert.equal(capture.id, "CAP1");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.headers["PayPal-Request-Id"] === "capture-entry_0001"));
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
