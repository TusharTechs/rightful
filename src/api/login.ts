/**
 * Log in with PayPal for claimants: proves "a verified PayPal account is here" before they file.
 *
 * CSRF protection is the usual OAuth double-submit: a random nonce goes into an HttpOnly cookie
 * and, HMAC-signed with a timestamp, into `state`. The callback accepts only a fresh, correctly
 * signed state whose nonce matches the cookie. The payer ID is never shown or stored here.
 *
 * A sign-in can carry an intent (`?program=…`, plus `&claim=…` to confirm a claim an agent filed),
 * signed into the state with the nonce. The callback hands it, with PayPal's answer, to `claimant`.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isVerified, loginUrl, type UserInfo } from "../paypal/identity.ts";
import { outcomePage } from "./pages.ts";

export type LoginConfig = {
  clientId: string;
  redirectUri: string;
  stateKey: Uint8Array;
  exchange: (code: string) => Promise<UserInfo>;
  /** The web app's origin, for the wordmark link on sign-in pages. */
  webBase?: string;
  /** Handles a sign-in that carried an intent, such as filing a claim. */
  claimant?: (c: Context, intent: LoginIntent, info: UserInfo) => Response | Promise<Response>;
};

export type LoginIntent = { program: string; claim?: string };

const COOKIE = "rf_login";
const STATE_TTL_MS = 10 * 60_000;

export function signState(key: Uint8Array, nonce: string, issuedAt: number, intent?: LoginIntent): string {
  const carried = intent ? Buffer.from(JSON.stringify(intent)).toString("base64url") : "";
  return `${nonce}.${issuedAt}.${carried}.${mac(key, nonce, issuedAt, carried)}`;
}

/** Returns the nonce if the state is genuine and fresh, otherwise null. */
export function verifyState(key: Uint8Array, state: string, now: number): string | null {
  return readState(key, state, now)?.nonce ?? null;
}

export function readState(key: Uint8Array, state: string, now: number): { nonce: string; intent: LoginIntent | null } | null {
  const [nonce, issued, carried, signature, ...rest] = state.split(".");
  if (!nonce || !issued || carried === undefined || !signature || rest.length) return null;
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || now - issuedAt > STATE_TTL_MS || issuedAt > now + 60_000) return null;
  const expected = Buffer.from(mac(key, nonce, issuedAt, carried));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { nonce, intent: carried ? (JSON.parse(Buffer.from(carried, "base64url").toString("utf8")) as LoginIntent) : null };
}

export function mountLogin(app: Hono, config: LoginConfig, now: () => number = Date.now) {
  const secure = config.redirectUri.startsWith("https://");

  app.get("/auth/paypal/login", (c) => {
    const nonce = randomBytes(16).toString("base64url");
    setCookie(c, COOKIE, nonce, { httpOnly: true, secure, sameSite: "Lax", path: "/auth/paypal", maxAge: STATE_TTL_MS / 1000 });
    const program = c.req.query("program");
    const claim = c.req.query("claim");
    const intent = program && /^prg_[\w-]{1,40}$/.test(program) ? { program, ...(claim && /^clm_[\w-]{1,40}$/.test(claim) ? { claim } : {}) } : undefined;
    const state = signState(config.stateKey, nonce, now(), intent);
    return c.redirect(loginUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state }));
  });

  app.get("/auth/paypal/callback", async (c) => {
    const cookieNonce = getCookie(c, COOKIE);
    deleteCookie(c, COOKIE, { path: "/auth/paypal" });
    const error = c.req.query("error");
    if (error) return c.html(loginPage(config.webBase, "PayPal did not sign you in", `PayPal returned: ${error}.`), 400);

    const state = readState(config.stateKey, c.req.query("state") ?? "", now());
    if (!state || state.nonce !== cookieNonce) return c.html(loginPage(config.webBase, "Sign-in expired", "Please start again."), 400);
    const code = c.req.query("code");
    if (!code) return c.html(loginPage(config.webBase, "Sign-in failed", "PayPal sent no authorization code."), 400);

    const info = await config.exchange(code);
    if (state.intent && config.claimant) return config.claimant(c, state.intent, info);
    return isVerified(info)
      ? c.html(loginPage(config.webBase, "Verified human ✓", "PayPal confirms this is a verified account."))
      : c.html(loginPage(config.webBase, "Not verified", "PayPal says this account is not verified yet."));
  });
}

function mac(key: Uint8Array, nonce: string, issuedAt: number, carried: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(`rightful/login-state/v1\n${nonce}\n${issuedAt}\n${carried}`)));
}

function loginPage(webBase: string | undefined, title: string, message: string) {
  return outcomePage({ title, message, ok: !/expired|failed|did not|not verified/i.test(title), webBase });
}
