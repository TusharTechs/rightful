/**
 * The administrator's console: everything needed to decide a program's held rings, in one read.
 *
 * - **Rings**, largest first, each with the detector's evidence, the investigator's memo and
 *   recommendation, and the decision once a person makes one.
 * - **Money**: what each approved claim would get if the program paid now. Held claims are not
 *   counted, so the share a ring would take from real claimants is visible before anyone decides.
 * - **Ground truth**, for demo programs only: the synthetic generator knows which claims are rings,
 *   so the console can score the decisions against two baselines (pay every bound claim; pay every
 *   verified account) without showing the answer until the person asks.
 */

import type { Signal } from "../rings/cluster.ts";
import type { Memo } from "../rings/investigate.ts";
import { type ClaimsDeps, type ClaimRow, type ClaimStatus, type RingRow, ClaimError, getProgram } from "./service.ts";

export type ConsoleRing = {
  id: string;
  size: number;
  signals: Record<Signal, number>;
  verifiedShare: number;
  firstFiledAt: string;
  lastFiledAt: string;
  memo: Pick<Memo, "recommendation" | "verdict" | "evidence" | "rejected"> | null;
  decision: "deny" | "approve" | null;
  /** Demo programs only: how many members are really ring claims, and of which kind. */
  truth?: { ringClaims: number; genuineClaims: number; kind: string };
};

export type Outcome = {
  claims: number;
  shareCents: number;
  ringClaimsPaid: number;
  toRingsCents: number;
  /** Real claimants not paid, for any reason. */
  genuineUnpaid: number;
  /** Of those, the ones a person denied (for Rightful) or a rule refused (verified-only: unverified accounts). */
  genuineDenied: number;
};

export type ConsoleView = {
  program: {
    id: string;
    title: string;
    kind: "live" | "demo";
    status: string;
    poolCents: number;
    currency: string;
    closesAt: string;
    shareCents: number | null;
    commitment: string | null;
  };
  counts: Partial<Record<ClaimStatus, number>>;
  held: { ring: number; unverified: number };
  agentFiled: number;
  rings: ConsoleRing[];
  /** If the program paid now: approved claims only. */
  projection: { claims: number; shareCents: number; undecidedRings: number; heldInRings: number };
  demo?: {
    totals: { ringClaims: number; genuineClaims: number };
    payEveryone: Outcome;
    verifiedOnly: Outcome;
    rightful: Outcome;
  };
};

type Tally = { status: ClaimStatus; ring_id: string | null; verified: boolean | null; demo_truth: string | null; filed_via: string; n: number };

export async function consoleView(deps: ClaimsDeps, programId: string): Promise<ConsoleView> {
  const program = await getProgram(deps.db, programId);
  const isDemo = program.kind === "demo";
  // One grouped read of every claim, small even at 40k claims.
  const tallies = await deps.db.query<Tally>(
    `select status, ring_id, verified, ${isDemo ? "demo_truth" : "null::text as demo_truth"}, filed_via, count(*)::int as n
     from claims where program_id = $1 group by status, ring_id, verified, demo_truth, filed_via`,
    [program.id],
  );
  const rings = await deps.db.query<RingRow & { created_at: Date }>(
    `select * from rings where program_id = $1 order by jsonb_array_length(claim_ids) desc, id`,
    [program.id],
  );

  const counts: Partial<Record<ClaimStatus, number>> = {};
  const held = { ring: 0, unverified: 0 };
  let agentFiled = 0;
  const truthByRing = new Map<string, { ring: number; genuine: number; kinds: Map<string, number> }>();
  for (const t of tallies) {
    counts[t.status] = (counts[t.status] ?? 0) + t.n;
    if (t.filed_via === "agent") agentFiled += t.n;
    if (t.status === "held" && t.ring_id) held.ring += t.n;
    else if (t.status === "held") held.unverified += t.n;
    if (isDemo && t.ring_id && t.demo_truth) {
      const entry = truthByRing.get(t.ring_id) ?? { ring: 0, genuine: 0, kinds: new Map() };
      if (t.demo_truth.startsWith("ring:")) entry.ring += t.n;
      else entry.genuine += t.n;
      entry.kinds.set(t.demo_truth, (entry.kinds.get(t.demo_truth) ?? 0) + t.n);
      truthByRing.set(t.ring_id, entry);
    }
  }

  const approved = counts.approved ?? 0;
  const paidOrPaying = approved + (counts.paid ?? 0) + (counts.failed ?? 0);
  const view: ConsoleView = {
    program: {
      id: program.id,
      title: program.title,
      kind: program.kind,
      status: program.status,
      poolCents: program.pool_cents,
      currency: program.currency,
      closesAt: new Date(program.closes_at).toISOString(),
      shareCents: program.share_cents,
      commitment: program.commitment_digest,
    },
    counts,
    held,
    agentFiled,
    rings: rings.map((row) => {
      const truth = truthByRing.get(row.id);
      const top = truth ? [...truth.kinds.entries()].sort((a, b) => b[1] - a[1])[0]![0] : "";
      return {
        id: row.id,
        size: row.claim_ids.length,
        signals: row.evidence.signals,
        verifiedShare: row.evidence.verifiedShare,
        firstFiledAt: new Date(row.evidence.firstFiledAt).toISOString(),
        lastFiledAt: new Date(row.evidence.lastFiledAt).toISOString(),
        memo: row.memo ? { recommendation: row.memo.recommendation, verdict: row.memo.verdict, evidence: row.memo.evidence, rejected: row.memo.rejected } : null,
        decision: row.decision,
        ...(isDemo && truth ? { truth: { ringClaims: truth.ring, genuineClaims: truth.genuine, kind: top.split(":")[1] ?? top } } : {}),
      };
    }),
    projection: {
      claims: program.share_cents ? paidOrPaying : approved,
      shareCents: program.share_cents ?? (approved ? Math.floor(program.pool_cents / approved) : 0),
      undecidedRings: rings.filter((r) => !r.decision).length,
      heldInRings: held.ring,
    },
  };
  if (isDemo) view.demo = scoreboard(program.pool_cents, tallies);
  return view;
}

/** The three ways the demo program could pay, scored against the synthetic truth. */
function scoreboard(poolCents: number, tallies: Tally[]): NonNullable<ConsoleView["demo"]> {
  const isRing = (t: Tally) => Boolean(t.demo_truth?.startsWith("ring:"));
  const bound = tallies.filter((t) => t.status !== "unbound");
  const outcome = (paid: (t: Tally) => boolean, denied: (t: Tally) => boolean): Outcome => {
    let claims = 0, ringClaimsPaid = 0, genuineUnpaid = 0, genuineDenied = 0;
    for (const t of bound) {
      if (paid(t)) {
        claims += t.n;
        if (isRing(t)) ringClaimsPaid += t.n;
      } else if (!isRing(t)) {
        genuineUnpaid += t.n;
        if (denied(t)) genuineDenied += t.n;
      }
    }
    const shareCents = claims ? Math.floor(poolCents / claims) : 0;
    return { claims, shareCents, ringClaimsPaid, toRingsCents: shareCents * ringClaimsPaid, genuineUnpaid, genuineDenied };
  };
  const sum = (pick: (t: Tally) => boolean) => bound.filter(pick).reduce((n, t) => n + t.n, 0);
  return {
    totals: { ringClaims: sum(isRing), genuineClaims: sum((t) => !isRing(t)) },
    payEveryone: outcome(() => true, () => false),
    verifiedOnly: outcome((t) => Boolean(t.verified), (t) => !t.verified),
    // Undecided ring claims are not paid: distribution refuses to start until each ring is decided.
    // Unverified accounts are held, not denied: they are paid once the account is verified.
    rightful: outcome((t) => t.status === "approved" || t.status === "paid" || t.status === "failed", (t) => t.status === "denied"),
  };
}

/** One ring's members, for the person deciding it. The organizer sees evidence, never payer IDs. */
export async function ringMembers(deps: ClaimsDeps, programId: string, ringId: string) {
  const program = await getProgram(deps.db, programId);
  const [ring] = await deps.db.query<RingRow>(`select * from rings where program_id = $1 and id = $2`, [program.id, ringId]);
  if (!ring) throw new ClaimError(`no ring ${ringId}`, "not_found");
  const claims = await deps.db.query<ClaimRow>(`select * from claims where id = any($1) order by filed_at, id`, [ring.claim_ids]);
  return claims.map((claim) => ({
    id: claim.id,
    status: claim.status,
    filedVia: claim.filed_via,
    agentName: claim.agent_name,
    verified: claim.verified,
    humanTag: claim.human_tag,
    email: claim.email,
    address: claim.address,
    network: claim.network,
    device: claim.device,
    narrative: claim.narrative,
    filedAt: claim.filed_at,
    ...(program.kind === "demo" ? { truth: claim.demo_truth } : {}),
  }));
}
