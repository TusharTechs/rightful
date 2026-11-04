/**
 * The Server SDK adapter (`src/paypal/sdk.ts`) against a faked transport, per the contract sheet in
 * `paypal-plan.md`: a real `PaypalClient`, a fake `fetch`, wire-shaped bodies, and the OAuth token
 * request answered first.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { distributeProgram } from "../src/claims/distribute.ts";
import { reconcileProgram } from "../src/claims/reconcile.ts";
import { type ClaimsDeps, ClaimError, createProgram, fileClaim, passAfterLogin, reviewProgram } from "../src/claims/service.ts";
import { openPGlite } from "../src/db/db.ts";
import { FakePayouts } from "../src/dev/fake-payouts.ts";
import { sdkReporting } from "../src/paypal/sdk.ts";

type Call = { url: URL; method: string };

function stubFetch(answer: (url: URL) => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ url, method: request.method });
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "test-token", token_type: "Bearer", expires_in: 32400 });
    return answer(url);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const record = (id: string, value: string, note: string) => ({
  transaction_info: { transaction_id: id, transaction_event_code: "T0001", transaction_amount: { currency_code: "USD", value }, transaction_status: "S", transaction_note: note },
});

const reporting = (fetch: typeof globalThis.fetch) => sdkReporting({ clientId: "id", clientSecret: "secret", fetch, maxRetries: 0 });

test("history pages through Transaction Search and signs debits; only the sheet's fields are sent", async () => {
  const stub = stubFetch((url) => {
    const page = Number(url.searchParams.get("page"));
    return json(200, {
      transaction_details: page === 1 ? [record("TXN1", "-1.00", "Your approved claim. rightful/ledger/v1 abc")] : [record("TXN2", "1.25", "")],
      last_refreshed_datetime: "2026-11-04T09:29:59Z",
      page,
      total_pages: 2,
    });
  });
  const out = await reporting(stub.fetch).history(new Date("2026-11-04T00:00:00.123Z"), new Date("2026-11-04T12:00:00Z"));
  assert.deepEqual(out, {
    refreshedAt: "2026-11-04T09:29:59Z",
    transactions: [
      { id: "TXN1", eventCode: "T0001", amountCents: -100, currency: "USD", status: "S", note: "Your approved claim. rightful/ledger/v1 abc" },
      { id: "TXN2", eventCode: "T0001", amountCents: 125, currency: "USD", status: "S", note: "" },
    ],
  });
  const searches = stub.calls.filter((c) => c.url.pathname === "/v1/reporting/transactions");
  assert.equal(searches.length, 2);
  assert.equal(stub.calls[0]!.url.pathname, "/v1/oauth2/token", "the token request comes first");
  assert.equal(searches[0]!.url.origin, "https://api-m.sandbox.paypal.com", "the sandbox host, never another");
  // 1b.3: no query parameter our code did not decide to send. The SDK adds its own documented default
  // for balance_affecting_records_only ("Y"), which is its choice, not ours.
  const params = new URLSearchParams(searches[0]!.url.searchParams);
  assert.equal(params.get("balance_affecting_records_only"), "Y");
  params.delete("balance_affecting_records_only");
  assert.deepEqual([...params.keys()].sort(), ["end_date", "fields", "page", "page_size", "start_date"]);
  assert.equal(searches[0]!.url.searchParams.get("start_date"), "2026-11-04T00:00:00Z");
  assert.equal(searches[0]!.url.searchParams.get("fields"), "transaction_info");
});

test("balances read the available amount in the program's currency", async () => {
  const stub = stubFetch(() =>
    json(200, { balances: [{ currency: "USD", primary: true, total_balance: { currency_code: "USD", value: "5011.87" }, available_balance: { currency_code: "USD", value: "5011.87" } }] }),
  );
  assert.equal(await reporting(stub.fetch).available("USD"), 501_187);
  const call = stub.calls.find((c) => c.url.pathname === "/v1/reporting/balances")!;
  assert.deepEqual([...call.url.searchParams.entries()], [["currency_code", "USD"]]);
});

test("the factory refuses a non-sandbox environment and missing credentials", () => {
  assert.throws(() => sdkReporting({ clientId: "id", clientSecret: "secret", environment: "live" }), /sandbox/);
  assert.throws(() => sdkReporting({ clientId: "", clientSecret: "secret" }), /PAYPAL_CLIENT_ID/);
});

async function reviewed(reportingFetch: typeof globalThis.fetch) {
  const clock = { now: new Date("2026-11-04T12:00:00Z") };
  const deps: ClaimsDeps = { db: await openPGlite(), humanSecret: new Uint8Array(32).fill(8), now: () => clock.now, payouts: new FakePayouts(), reporting: reporting(reportingFetch) };
  const program = await createProgram(deps, { title: "Pitcher", poolCents: 200, closesAt: new Date("2026-11-04T13:00:00Z") });
  for (let i = 0; i < 2; i++) {
    await fileClaim(deps, program.id, { email: `p${i}@example.com`, address: `${i} Elm St`, narrative: `n${i}`, device: `d${i}` }, { via: "web", pass: passAfterLogin(deps, program.id, `P${i}`, true), ip: `10.${i}.0.1` });
  }
  clock.now = new Date("2026-11-04T14:00:00Z");
  await reviewProgram(deps, program.id);
  return { deps, program };
}

test("1b.4: if PayPal cannot confirm the balance, nothing is paid", async () => {
  const { deps, program } = await reviewed(stubFetch(() => json(403, { name: "NOT_AUTHORIZED", message: "Authorization failed", debug_id: "d1" })).fetch);
  await assert.rejects(distributeProgram(deps, program.id), (err) => err instanceof ClaimError && /could not confirm the PayPal balance/.test(err.message));
  assert.equal((deps.payouts as FakePayouts).sends, 0);
  await deps.db.close();
});

test("1b.4: a failed history read leaves the program as it was", async () => {
  let failHistory = false;
  const stub = stubFetch((url) =>
    url.pathname === "/v1/reporting/balances"
      ? json(200, { balances: [{ currency: "USD", total_balance: { currency_code: "USD", value: "10.00" }, available_balance: { currency_code: "USD", value: "10.00" } }] })
      : failHistory
        ? json(500, { name: "INTERNAL_SERVER_ERROR", message: "x", debug_id: "d2" })
        : json(200, { transaction_details: [], total_pages: 1 }),
  );
  const { deps, program } = await reviewed(stub.fetch);
  await distributeProgram(deps, program.id);
  const payouts = deps.payouts as FakePayouts;
  await (await import("../src/claims/distribute.ts")).syncPayouts(deps, program.id);
  await (await import("../src/claims/distribute.ts")).syncPayouts(deps, program.id);
  assert.equal(payouts.sends, 1);
  failHistory = true;
  await assert.rejects(reconcileProgram(deps, program.id));
  const [row] = await deps.db.query<{ reconciliation: unknown }>(`select reconciliation from programs where id = $1`, [program.id]);
  assert.equal(row!.reconciliation, null);
  await deps.db.close();
});
