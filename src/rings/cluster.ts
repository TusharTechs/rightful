/**
 * Deterministic ring detection: link claims that share enough evidence, then flag large groups.
 *
 * Each pair of claims collects the signals it shares. A pair is linked when the weights add up to
 * `edgeThreshold`, so no single weak signal (a campus network, a burst of filings after a news
 * story) links anyone, and a household that shares an address and a laptop stays a group of three.
 * Linked claims form components. A claim that falls short of a link can still join a component of
 * three or more through weak links (building, network) to at least two of its members: that is how a
 * building full of fresh mailboxes joins the few that gave themselves away. A component is a
 * suspected ring once it reaches `minRingSize`. Nothing here bans anyone: a ring is evidence for a
 * person to review.
 *
 * Pairs come from blocking keys rather than all n² comparisons: one bucket per device, canonical
 * mailbox and building, sliding time windows inside each /24, and MinHash bands for narratives. An
 * empty key (no fingerprint, unknown network, public webmail) never links anything.
 */

import { type ClaimSignals, canonicalAddress, canonicalEmail, ipPrefix, jaccard, minhash, privateDomain, shingles } from "./signals.ts";

export const SIGNAL_WEIGHTS = {
  /** The same mailbox behind two PayPal accounts. */
  mailbox: 4,
  device: 3,
  /** Narratives this close that are not just the program's sample text. */
  narrative: 2,
  building: 1,
  /** The same mail domain, when it is not public webmail. */
  domain: 1,
  /** The same /24 within `ipWindowMs`. */
  network: 1,
  /** Filed within `burstMs`. Only ever adds to another signal. */
  burst: 0.5,
} as const;

export type Signal = keyof typeof SIGNAL_WEIGHTS;

export interface DetectorOptions {
  edgeThreshold: number;
  minRingSize: number;
  /** Smallest linked component that weak links may grow. Two is too few: chance pairs happen. */
  minCore: number;
  burstMs: number;
  ipWindowMs: number;
  narrativeJaccard: number;
  /** The program's sample claim text; copying it is expected, not evidence. */
  sampleText: string;
  /** Buckets larger than this are a public key (a shared office device pool), not evidence. */
  maxBucket: number;
}

export const DEFAULT_DETECTOR: DetectorOptions = {
  edgeThreshold: 2.5,
  minRingSize: 5,
  minCore: 3,
  burstMs: 15 * 60_000,
  ipWindowMs: 2 * 3_600_000,
  narrativeJaccard: 0.6,
  sampleText: "",
  maxBucket: 400,
};

export interface Ring {
  id: string;
  claimIds: string[];
  /** Linked pairs inside the ring that shared each signal. */
  signals: Record<Signal, number>;
  links: number;
  verifiedShare: number;
  distinct: { devices: number; mailboxes: number; buildings: number; networks: number };
  firstFiledAt: number;
  lastFiledAt: number;
}

const BANDS = 10;
const ROWS = 3;

export function findRings(claims: readonly ClaimSignals[], options: Partial<DetectorOptions> = {}): Ring[] {
  const opts = { ...DEFAULT_DETECTOR, ...options };
  const n = claims.length;
  const features = claims.map((claim) => ({
    mailbox: canonicalEmail(claim.email),
    building: canonicalAddress(claim.address).building,
    network: ipPrefix(claim.ip),
    domain: privateDomain(claim.email),
    shingles: shingles(claim.narrative),
  }));
  const sample = shingles(opts.sampleText);
  const sampleLike = features.map((f) => sample.size > 0 && jaccard(f.shingles, sample) >= 0.5);

  const pairs = new Map<number, Set<Signal>>();
  const note = (a: number, b: number, signal: Signal) => {
    if (a === b) return;
    const key = a < b ? a * n + b : b * n + a;
    let set = pairs.get(key);
    if (!set) pairs.set(key, (set = new Set()));
    set.add(signal);
  };
  const bucketPairs = (keyOf: (i: number) => string, signal: Signal) => {
    for (const [key, members] of buckets(n, keyOf)) {
      if (key === "" || members.length > opts.maxBucket) continue;
      for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) note(members[x]!, members[y]!, signal);
    }
  };

  bucketPairs((i) => claims[i]!.device, "device");
  bucketPairs((i) => features[i]!.mailbox, "mailbox");
  bucketPairs((i) => features[i]!.building, "building");
  bucketPairs((i) => features[i]!.domain, "domain");

  for (const [key, members] of buckets(n, (i) => features[i]!.network)) {
    if (key === "") continue;
    members.sort((a, b) => claims[a]!.filedAt - claims[b]!.filedAt);
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        if (claims[members[y]!]!.filedAt - claims[members[x]!]!.filedAt > opts.ipWindowMs) break;
        note(members[x]!, members[y]!, "network");
      }
    }
  }

  const signatures = features.map((f) => minhash(f.shingles, BANDS * ROWS));
  const seen = new Set<number>();
  for (let band = 0; band < BANDS; band++) {
    const keyOf = (i: number) => {
      if (sampleLike[i] || features[i]!.shingles.size < 4) return "";
      return Array.from(signatures[i]!.subarray(band * ROWS, band * ROWS + ROWS)).join(".");
    };
    for (const [key, members] of buckets(n, keyOf)) {
      if (key === "" || members.length > opts.maxBucket) continue;
      for (let x = 0; x < members.length; x++) {
        for (let y = x + 1; y < members.length; y++) {
          const [a, b] = [members[x]!, members[y]!];
          const pair = a < b ? a * n + b : b * n + a;
          if (seen.has(pair)) continue;
          seen.add(pair);
          if (jaccard(features[a]!.shingles, features[b]!.shingles) >= opts.narrativeJaccard) note(a, b, "narrative");
        }
      }
    }
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const size = new Array<number>(n).fill(1);
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    parent[ra] = rb;
    size[rb]! += size[ra]!;
  };
  const linked: Array<[number, number, Set<Signal>]> = [];
  const weak: Array<[number, number, Set<Signal>]> = [];
  for (const [key, signals] of pairs) {
    const [a, b] = [Math.floor(key / n), key % n];
    if (Math.abs(claims[a]!.filedAt - claims[b]!.filedAt) <= opts.burstMs) signals.add("burst");
    let weight = 0;
    for (const signal of signals) weight += SIGNAL_WEIGHTS[signal];
    if (weight >= opts.edgeThreshold) {
      linked.push([a, b, signals]);
      union(a, b);
    } else if (signals.has("building") || signals.has("network")) {
      weak.push([a, b, signals]);
    }
  }

  // Grow components through weak links, until nothing else joins.
  for (let changed = true; changed; ) {
    changed = false;
    const touches = new Map<string, Set<number>>();
    for (const [a, b] of weak) {
      for (const [claim, member] of [[a, b], [b, a]] as const) {
        const root = find(member);
        if (root === find(claim) || size[root]! < opts.minCore) continue;
        const key = `${claim}:${root}`;
        const members = touches.get(key) ?? new Set();
        members.add(member);
        touches.set(key, members);
      }
    }
    for (const [key, members] of touches) {
      const [claim, root] = key.split(":").map(Number) as [number, number];
      if (members.size < 2 || find(claim) === find(root)) continue;
      union(claim, root);
      changed = true;
    }
  }
  for (const edge of weak) if (find(edge[0]) === find(edge[1]) && size[find(edge[0])]! >= opts.minCore) linked.push(edge);

  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  }
  const counts = new Map<number, { links: number; signals: Record<Signal, number> }>();
  for (const [a, , signals] of linked) {
    const root = find(a);
    let tally = counts.get(root);
    if (!tally) {
      tally = { links: 0, signals: Object.fromEntries(Object.keys(SIGNAL_WEIGHTS).map((s) => [s, 0])) as Record<Signal, number> };
      counts.set(root, tally);
    }
    tally.links++;
    for (const signal of signals) tally.signals[signal]++;
  }

  const rings: Ring[] = [];
  for (const [root, members] of components) {
    if (members.length < opts.minRingSize) continue;
    const { links, signals } = counts.get(root)!;
    const times = members.map((i) => claims[i]!.filedAt);
    rings.push({
      id: "",
      claimIds: members.map((i) => claims[i]!.id).sort(),
      signals,
      links,
      verifiedShare: members.filter((i) => claims[i]!.verified).length / members.length,
      distinct: {
        devices: new Set(members.map((i) => claims[i]!.device)).size,
        mailboxes: new Set(members.map((i) => features[i]!.mailbox)).size,
        buildings: new Set(members.map((i) => features[i]!.building)).size,
        networks: new Set(members.map((i) => features[i]!.network)).size,
      },
      firstFiledAt: Math.min(...times),
      lastFiledAt: Math.max(...times),
    });
  }
  rings.sort((a, b) => b.claimIds.length - a.claimIds.length || (a.claimIds[0]! < b.claimIds[0]! ? -1 : 1));
  rings.forEach((ring, i) => (ring.id = `ring_${String(i + 1).padStart(3, "0")}`));
  return rings;
}

function buckets(n: number, keyOf: (i: number) => string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = keyOf(i);
    const list = out.get(key);
    if (list) list.push(i);
    else out.set(key, [i]);
  }
  return out;
}
