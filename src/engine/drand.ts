/**
 * Public randomness for the audit sample, from drand quicknet (League of Entropy).
 *
 * A program's payout ledger commits to a future round before any payout is sent. Nobody, including
 * the organizer, can know that round's randomness in advance, and anyone can check the beacon
 * against the chain's public key afterwards. Chain info is pinned here so a relay cannot swap in a different network.
 */

import {
  type ChainClient,
  type ChainInfo,
  type RandomnessBeacon,
  HttpCachingChain,
  HttpChainClient,
  fetchBeacon,
  roundAt,
  roundTime,
} from "drand-client";

export const QUICKNET: ChainInfo = {
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  period: 3,
  genesis_time: 1692803367,
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: "bls-unchained-g1-rfc9380",
  metadata: { beaconID: "quicknet" },
};

export const RELAYS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];

const VERIFYING = {
  disableBeaconVerification: false,
  noCache: false,
  chainVerificationParams: { chainHash: QUICKNET.hash, publicKey: QUICKNET.public_key },
};

export function quicknetClient(relay: string): ChainClient {
  return new HttpChainClient(new HttpCachingChain(`${relay}/${QUICKNET.hash}`, VERIFYING), VERIFYING);
}

/**
 * Fetches a beacon and verifies its BLS signature against the pinned key. Tries each relay in turn;
 * any one is enough because a forged beacon fails verification.
 */
export async function verifiedBeacon(round: number, clients: ChainClient[] = RELAYS.map(quicknetClient)): Promise<RandomnessBeacon> {
  let lastError: unknown;
  for (const client of clients) {
    try {
      const beacon = await fetchBeacon(client, round);
      if (beacon.round !== round) throw new Error(`asked for round ${round}, got ${beacon.round}`);
      return beacon;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** The first round published at or after `date`: an audit scheduled for `date` uses this round. */
export function roundAtOrAfter(date: Date): number {
  const round = roundAt(date.getTime(), QUICKNET);
  return roundTime(QUICKNET, round) < date.getTime() ? round + 1 : round;
}

export function timeOfRound(round: number): Date {
  return new Date(roundTime(QUICKNET, round));
}
