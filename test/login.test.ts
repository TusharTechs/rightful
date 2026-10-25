import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { mountLogin, signState, verifyState } from "../src/api/login.ts";

const KEY = new Uint8Array(32).fill(5);

test("login state must be signed, fresh and untampered", () => {
  const now = 1_800_000_000_000;
  const state = signState(KEY, "nonce123", now);
  assert.equal(verifyState(KEY, state, now + 1000), "nonce123");
  assert.equal(verifyState(KEY, state, now + 11 * 60_000), null, "expired");
  assert.equal(verifyState(KEY, state.replace("nonce123", "nonce999"), now), null, "nonce swapped");
  assert.equal(verifyState(new Uint8Array(32).fill(6), state, now), null, "wrong key");
  assert.equal(verifyState(KEY, "garbage", now), null);
});

test("the callback only trusts a state whose nonce matches the cookie", async () => {
  const app = new Hono();
  let exchanged = 0;
  mountLogin(app, {
    clientId: "client",
    redirectUri: "https://firsthand.example/auth/paypal/callback",
    stateKey: KEY,
    exchange: async () => {
      exchanged++;
      return { verified_account: "true", payer_id: "SECRET_PAYER" };
    },
  });

  const start = await app.request("/auth/paypal/login");
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.origin, "https://www.sandbox.paypal.com");
  const state = location.searchParams.get("state")!;
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;

  const forged = await app.request(`/auth/paypal/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(forged.status, 400, "no cookie, no trust");
  assert.equal(exchanged, 0);

  const ok = await app.request(`/auth/paypal/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } });
  const html = await ok.text();
  assert.equal(ok.status, 200);
  assert.match(html, /Verified human/);
  assert.doesNotMatch(html, /SECRET_PAYER/, "the payer ID is never shown");
});
