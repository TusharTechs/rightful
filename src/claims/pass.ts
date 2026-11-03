/**
 * The claim pass: what Log in with PayPal hands the claim form.
 *
 * After sign-in the server knows three things about the claimant: the program's pseudonym for the
 * account, whether PayPal calls it verified, and its payer ID, which is where the money must go.
 * The pass carries them to the next request without a session store: the payer ID sealed with
 * AES-256-GCM, the whole pass signed with HMAC and short-lived. The browser holds it but can neither
 * read the payer ID nor change any field.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export type ClaimPass = {
  programId: string;
  humanTag: string;
  verified: boolean;
  /** The payer ID, sealed (see `sealPayee`). */
  payee: string;
  expiresAt: number;
};

export const PASS_TTL_MS = 30 * 60_000;

/** Derives the keys behind passes and sealed payees from the server's human-tag secret. */
export function claimKeys(secret: Uint8Array): { passKey: Uint8Array; payeeKey: Uint8Array } {
  const derive = (label: string) => hmac(sha256, secret, utf8ToBytes(label));
  return { passKey: derive("rightful/pass-key/v1"), payeeKey: derive("rightful/payee-key/v1") };
}

export function sealPayee(key: Uint8Array, payerId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(payerId, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
}

export function openPayee(key: Uint8Array, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export function issuePass(key: Uint8Array, pass: Omit<ClaimPass, "expiresAt">, now: number): string {
  const body = Buffer.from(JSON.stringify({ ...pass, expiresAt: now + PASS_TTL_MS })).toString("base64url");
  return `${body}.${mac(key, body)}`;
}

/** Returns the pass if it is genuine and unexpired, otherwise null. */
export function readPass(key: Uint8Array, token: string, now: number): ClaimPass | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(mac(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const pass = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ClaimPass;
  return pass.expiresAt > now ? pass : null;
}

function mac(key: Uint8Array, body: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(`rightful/pass/v1\n${body}`)));
}
