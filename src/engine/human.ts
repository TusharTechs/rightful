/**
 * Pairwise pseudonyms for verified humans.
 *
 * A claimant's PayPal payer ID proves "one account, one claim", but organizers and the public should
 * not learn it, and two programs should not be able to link the same person. Each program therefore
 * sees only an HMAC of the payer ID under a server secret and the program ID: stable within a
 * program (so duplicates are caught), unlinkable across programs.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function humanTag(secret: Uint8Array, programId: string, payerId: string): string {
  if (secret.length < 32) throw new RangeError("the pseudonym secret must be at least 32 bytes");
  return bytesToHex(hmac(sha256, secret, utf8ToBytes(`rightful/human/v1\n${programId}\n${payerId}`)));
}
