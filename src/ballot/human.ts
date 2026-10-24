/**
 * Pairwise pseudonyms for verified humans.
 *
 * A fan's PayPal payer ID proves "one account, one entry", but organizers should not learn it, and
 * two organizers should not be able to link the same fan across ballots. Each ballot therefore sees
 * only an HMAC of the payer ID under a server secret and the ballot ID: stable within a ballot (so
 * duplicates are caught), unlinkable across ballots.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function humanTag(secret: Uint8Array, ballotId: string, payerId: string): string {
  if (secret.length < 32) throw new RangeError("the pseudonym secret must be at least 32 bytes");
  return bytesToHex(hmac(sha256, secret, utf8ToBytes(`firsthand/human/v1\n${ballotId}\n${payerId}`)));
}
