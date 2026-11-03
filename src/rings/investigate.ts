/**
 * The ring investigator: a second opinion on each suspected ring, for the person who decides.
 *
 * The detector (`cluster.ts`) groups claims; the investigator asks a model three typed questions
 * about each group: is it a fraud operation, which pattern fits, how strong is the
 * evidence. It answers with probabilities, not prose, so it cannot invent a fact. Everything the
 * memo states is computed here from the claims, and the recommendation is a fixed rule over the
 * answers. A person still denies or clears the ring; the investigator never does.
 *
 * The model sees a case file with stand-in labels ("device D1", "inbox M2", "building B1"), not
 * emails, addresses, IPs or PayPal identifiers. Narratives are sent, truncated, because a shared
 * template is often the only thing that gives a ring away.
 */

import { createHash } from "node:crypto";
import type { Ring, Signal } from "./cluster.ts";
import { type ClaimSignals, canonicalAddress, canonicalEmail, ipPrefix, jaccard, privateDomain, shingles } from "./signals.ts";

export const PATTERNS = {
  "device-farm": "Many accounts driven from one or a few devices",
  "address-mill": "One building with a different unit on each claim, and look-alike mailboxes",
  "template-crew": "The same fill-in-the-blanks story from different people, filed in bursts",
  household: "Family members at one home who share a computer and an internet connection",
  "shared-network": "Unrelated people on one campus, office or public network",
  coincidence: "Unrelated people who happen to look alike",
} as const;

export type Pattern = keyof typeof PATTERNS;
export const BENIGN: ReadonlySet<Pattern> = new Set(["household", "shared-network", "coincidence"]);

export type CaseMember = {
  device: string;
  inbox: string;
  /** True when the address as typed differs from the inbox it delivers to (dots, +tags, case). */
  disguisedInbox: boolean;
  mailDomain: string;
  building: string;
  unit: string | null;
  network: string;
  minutesAfterFirst: number;
  verified: boolean;
  narrative: string;
};

export type CaseFile = {
  claims: number;
  shownMembers: number;
  spanMinutes: number;
  verifiedShare: number;
  distinct: { devices: number; inboxes: number; buildings: number; networks: number; privateDomains: number };
  /** Linked pairs inside the ring that shared each signal. */
  links: Record<Signal, number>;
  /** Mean narrative similarity between members (word-pair Jaccard, 0-1), ignoring the sample text. */
  narrativeSimilarity: number;
  programSampleText: string;
  members: CaseMember[];
};

export type Verdict = {
  /** Probability the group is a fraud operation rather than distinct real people. */
  coordinated: number;
  pattern: Pattern;
  patternConfidence: number;
  /** Expected strength of the evidence, 0 (none) to 4 (conclusive). */
  strength: number;
  model: string;
};

export interface Investigator {
  investigate(file: CaseFile): Promise<Verdict>;
}

export type Recommendation = "deny" | "review" | "clear";

export type Memo = {
  ringId: string;
  claims: number;
  recommendation: Recommendation;
  verdict: Verdict;
  /** Facts computed from the claims, never from the model. */
  evidence: string[];
};

const MAX_MEMBERS = 15;
const MAX_NARRATIVE = 300;

export function caseFileFor(ring: Ring, claims: ReadonlyMap<string, ClaimSignals>, sampleText = ""): CaseFile {
  const members = ring.claimIds.map((id) => claims.get(id)!).sort((a, b) => a.filedAt - b.filedAt || (a.id < b.id ? -1 : 1));
  const first = members[0]!.filedAt;
  const labels = { device: labeler("D"), inbox: labeler("M"), domain: labeler("X"), building: labeler("B"), network: labeler("N") };
  const sample = shingles(sampleText);
  const texts = members.map((m) => shingles(m.narrative)).filter((s) => !(sample.size && jaccard(s, sample) >= 0.5));
  const described = members.map((m): CaseMember => {
    const inbox = canonicalEmail(m.email);
    const domain = privateDomain(m.email);
    const address = canonicalAddress(m.address);
    return {
      device: m.device ? labels.device(m.device) : "unknown",
      inbox: labels.inbox(inbox),
      disguisedInbox: m.email.trim().toLowerCase() !== inbox,
      mailDomain: domain ? labels.domain(domain) : "public webmail",
      building: labels.building(address.building),
      unit: unitOf(address.full),
      network: m.ip ? labels.network(ipPrefix(m.ip)) : "unknown",
      minutesAfterFirst: Math.round((m.filedAt - first) / 60_000),
      verified: m.verified,
      narrative: m.narrative.length > MAX_NARRATIVE ? `${m.narrative.slice(0, MAX_NARRATIVE)}…` : m.narrative,
    };
  });
  return {
    claims: members.length,
    shownMembers: Math.min(members.length, MAX_MEMBERS),
    spanMinutes: Math.round((members[members.length - 1]!.filedAt - first) / 60_000),
    verifiedShare: round2(members.filter((m) => m.verified).length / members.length),
    distinct: {
      devices: new Set(described.map((m) => m.device)).size,
      inboxes: new Set(described.map((m) => m.inbox)).size,
      buildings: new Set(described.map((m) => m.building)).size,
      networks: new Set(described.map((m) => m.network)).size,
      privateDomains: new Set(described.filter((m) => m.mailDomain !== "public webmail").map((m) => m.mailDomain)).size,
    },
    links: ring.signals,
    narrativeSimilarity: round2(meanPairwise(texts.slice(0, MAX_MEMBERS))),
    programSampleText: sampleText,
    members: described.slice(0, MAX_MEMBERS),
  };
}

/** The memo's facts, in plain words, straight from the case file. */
export function evidenceOf(file: CaseFile): string[] {
  const out: string[] = [];
  const { claims, distinct } = file;
  if (distinct.devices < claims) out.push(`${claims} claims came from ${distinct.devices} device${distinct.devices === 1 ? "" : "s"}.`);
  const disguised = file.members.filter((m) => m.disguisedInbox).length;
  if (distinct.inboxes < claims) out.push(`${claims} email addresses deliver to ${distinct.inboxes} inbox${distinct.inboxes === 1 ? "" : "es"}${disguised ? ` (${disguised} shown are dressed up with dots or +tags)` : ""}.`);
  if (distinct.buildings < claims) {
    const units = new Set(file.members.map((m) => `${m.building}/${m.unit ?? ""}`)).size;
    out.push(`${claims} claims list ${distinct.buildings} building${distinct.buildings === 1 ? "" : "s"}${units > distinct.buildings ? ` with ${units} different units among those shown` : ""}.`);
  }
  if (distinct.privateDomains > 0 && distinct.privateDomains < claims) out.push(`They share ${distinct.privateDomains} private mail domain${distinct.privateDomains === 1 ? "" : "s"}.`);
  if (distinct.networks < claims) out.push(`They came from ${distinct.networks} network${distinct.networks === 1 ? "" : "s"}.`);
  if (file.narrativeSimilarity >= 0.3) out.push(`Their stories are ${Math.round(file.narrativeSimilarity * 100)}% the same, word pair for word pair.`);
  out.push(`All ${claims} were filed within ${duration(file.spanMinutes)}; ${Math.round(file.verifiedShare * 100)}% from verified PayPal accounts.`);
  return out;
}

/**
 * The rule from answers to a recommendation. Deny only when the model is confident the group is a
 * fraud operation and names a pattern that is not benign. Clear only when it names a benign pattern
 * with confidence and rates fraud unlikely, and never when accounts share an inbox: families do not
 * route several PayPal accounts to one mailbox. Everything else goes to a person.
 */
export function recommend(verdict: Verdict, file: CaseFile): Recommendation {
  const benign = BENIGN.has(verdict.pattern);
  if (verdict.coordinated >= 0.6 && verdict.strength >= 2.5 && !benign) return "deny";
  if (benign && verdict.patternConfidence >= 0.6 && verdict.coordinated < 0.5 && file.distinct.inboxes === file.claims) return "clear";
  return "review";
}

export async function investigateRing(investigator: Investigator, ring: Ring, claims: ReadonlyMap<string, ClaimSignals>, sampleText = ""): Promise<Memo> {
  const file = caseFileFor(ring, claims, sampleText);
  const verdict = await investigator.investigate(file);
  return { ringId: ring.id, claims: ring.claimIds.length, recommendation: recommend(verdict, file), verdict, evidence: evidenceOf(file) };
}

/** Bump when the questions change, so recorded answers are not replayed against new questions. */
export const QUESTIONS_VERSION = "rightful/investigator/v2";

/** A stable key for a case file: what replay fixtures are looked up by. */
export function caseKey(file: CaseFile): string {
  return createHash("sha256").update(QUESTIONS_VERSION).update("\n").update(JSON.stringify(file)).digest("hex").slice(0, 24);
}

/** The unit token from a canonical address ("12 oak st unit 4b fairhaven …" → "4b"), if any. */
function unitOf(full: string): string | null {
  const tokens = full.split(" ");
  const at = tokens.indexOf("unit");
  return at >= 0 ? (tokens[at + 1] ?? null) : null;
}

function labeler(prefix: string) {
  const seen = new Map<string, string>();
  return (value: string) => {
    let label = seen.get(value);
    if (!label) seen.set(value, (label = `${prefix}${seen.size + 1}`));
    return label;
  };
}

function meanPairwise(sets: Set<string>[]): number {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      total += jaccard(sets[i]!, sets[j]!);
      pairs++;
    }
  }
  return pairs ? total / pairs : 0;
}

function duration(minutes: number): string {
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
