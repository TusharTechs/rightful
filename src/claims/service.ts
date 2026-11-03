/**
 * Rightful's claim lifecycle: file → bind → review → decide (payouts come next).
 *
 * - **File**: a person files after Log in with PayPal, carrying a claim pass; an agent files without
 *   one and gets a one-time bind code. Agents can file. Only verified humans get paid.
 * - **Bind**: the person the agent filed for signs in with PayPal and confirms the claim, which
 *   attaches their account. The bind code alone binds nothing, and neither does a sign-in alone.
 * - **One claim per account**: the per-program human tag is unique, so a second claim from the same
 *   PayPal account is refused, however it was filed.
 * - **Review**: after close, unverified accounts and suspected rings (`src/rings/cluster.ts`) are
 *   held; everything else is approved. The investigator (`src/rings/investigate.ts`) writes a memo
 *   for each ring, and a person confirms or clears it. Nothing here denies a claim on its own, and a
 *   later review leaves alone whatever a person already decided.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Db, isUniqueViolation } from "../db/db.ts";
import { humanTag } from "../engine/human.ts";
import { findRings, type Ring } from "../rings/cluster.ts";
import { type Investigator, type Memo, investigateRing } from "../rings/investigate.ts";
import type { ClaimSignals } from "../rings/signals.ts";
import type { PayoutsPort } from "./payouts-port.ts";
import { type ClaimPass, claimKeys, issuePass, readPass, sealPayee } from "./pass.ts";

export type ClaimsDeps = {
  db: Db;
  /** Server secret behind human tags, claim passes and sealed payees (≥ 32 bytes). */
  humanSecret: Uint8Array;
  now: () => Date;
  /** Needed only to distribute. */
  payouts?: PayoutsPort;
  /** Writes a memo for each suspected ring; without one, rings are reviewed on evidence alone. */
  investigator?: Investigator;
  /** Fetches and verifies a drand beacon; needed only to draw the audit sample. */
  beacon?: (round: number) => Promise<{ round: number; randomness: string; signature: string }>;
};

export type ProgramStatus = "open" | "review" | "distributing" | "done";
export type ClaimStatus = "unbound" | "filed" | "held" | "approved" | "denied" | "paid" | "failed";

export type ProgramRow = {
  id: string;
  title: string;
  status: ProgramStatus;
  pool_cents: number;
  currency: string;
  require_verified: boolean;
  sample_text: string;
  closes_at: Date;
  share_cents: number | null;
  payout_batches: Array<{ senderBatchId: string; batchId: string | null }>;
  commitment_root: string | null;
  commitment_digest: string | null;
  audit_round: number | null;
  audit_size: number | null;
  audit_randomness: string | null;
  audit_signature: string | null;
  audit_sample: string[] | null;
};

export type ClaimRow = {
  id: string;
  program_id: string;
  status: ClaimStatus;
  hold_reason: "unverified" | "ring" | null;
  ring_id: string | null;
  filed_via: "web" | "agent";
  human_tag: string | null;
  payee_sealed: string | null;
  verified: boolean | null;
  bind_code_hash: string | null;
  email: string;
  address: string;
  network: string;
  device: string;
  narrative: string;
  amount_cents: number | null;
  payout_item_id: string | null;
  payout_status: string | null;
  filed_at: Date;
  bound_at: Date | null;
};

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "closed" | "invalid" | "wrong_state" | "duplicate" | "unauthorized",
  ) {
    super(message);
    this.name = "ClaimError";
  }
}

export type NewProgram = {
  title: string;
  poolCents: number;
  currency?: string;
  requireVerified?: boolean;
  sampleText?: string;
  closesAt: Date;
};

export async function createProgram(deps: ClaimsDeps, input: NewProgram): Promise<ProgramRow> {
  const title = input.title.trim();
  if (!title || title.length > 120) throw new ClaimError("title must be 1-120 characters", "invalid");
  // Integer cents in a Postgres integer: up to about $21M.
  if (!Number.isInteger(input.poolCents) || input.poolCents <= 0 || input.poolCents > 2_147_483_647) {
    throw new ClaimError("poolCents must be a positive integer that fits in 32 bits", "invalid");
  }
  if (!(input.closesAt.getTime() > deps.now().getTime())) throw new ClaimError("closesAt must be in the future", "invalid");
  const [row] = await deps.db.query<ProgramRow>(
    `insert into programs (id, title, status, pool_cents, currency, require_verified, sample_text, closes_at)
     values ($1, $2, 'open', $3, $4, $5, $6, $7) returning *`,
    [newId("prg"), title, input.poolCents, input.currency ?? "USD", input.requireVerified ?? true, input.sampleText ?? "", input.closesAt],
  );
  return row!;
}

/** What the claimant (or their agent) tells us. The network comes from the request, not the form. */
export type ClaimForm = {
  email: string;
  address: string;
  narrative: string;
  device: string;
};

export type Filer = { via: "web"; pass: string; ip: string } | { via: "agent"; ip: string };

export async function fileClaim(
  deps: ClaimsDeps,
  programId: string,
  form: ClaimForm,
  filer: Filer,
): Promise<{ claim: ClaimRow; bindCode?: string }> {
  const program = await getProgram(deps.db, programId);
  assertOpen(deps, program);
  const fields = checkForm(form);
  const network = networkOf(filer.ip);

  if (filer.via === "agent") {
    const bindCode = randomBytes(18).toString("base64url");
    const [claim] = await deps.db.query<ClaimRow>(
      `insert into claims (id, program_id, status, filed_via, bind_code_hash, email, address, network, device, narrative)
       values ($1, $2, 'unbound', 'agent', $3, $4, $5, $6, $7, $8) returning *`,
      [newId("clm"), program.id, hashCode(bindCode), fields.email, fields.address, network, fields.device, fields.narrative],
    );
    return { claim: claim!, bindCode };
  }

  const pass = passFor(deps, program, filer.pass);
  const status = pass.verified || !program.require_verified ? "filed" : "held";
  try {
    const [claim] = await deps.db.query<ClaimRow>(
      `insert into claims (id, program_id, status, hold_reason, filed_via, human_tag, payee_sealed, verified,
                           email, address, network, device, narrative, bound_at)
       values ($1, $2, $3, $4, 'web', $5, $6, $7, $8, $9, $10, $11, $12, now()) returning *`,
      [newId("clm"), program.id, status, status === "held" ? "unverified" : null, pass.humanTag, pass.payee, pass.verified,
        fields.email, fields.address, network, fields.device, fields.narrative],
    );
    return { claim: claim! };
  } catch (err) {
    if (isUniqueViolation(err)) throw new ClaimError("this PayPal account already has a claim in this program", "duplicate");
    throw err;
  }
}

/** The person an agent filed for signs in with PayPal and confirms: their account is attached. */
export async function bindClaim(deps: ClaimsDeps, claimId: string, bindCode: string, passToken: string): Promise<ClaimRow> {
  const claim = await getClaim(deps.db, claimId);
  if (!claim.bind_code_hash || !sameHash(claim.bind_code_hash, hashCode(bindCode))) {
    throw new ClaimError("that bind code does not match this claim", "unauthorized");
  }
  if (claim.status !== "unbound") throw new ClaimError("this claim is already bound to a PayPal account", "wrong_state");
  const program = await getProgram(deps.db, claim.program_id);
  assertOpen(deps, program);
  const pass = passFor(deps, program, passToken);
  const status = pass.verified || !program.require_verified ? "filed" : "held";
  try {
    const [bound] = await deps.db.query<ClaimRow>(
      `update claims set status = $2, hold_reason = $3, human_tag = $4, payee_sealed = $5, verified = $6,
                         bind_code_hash = null, bound_at = now(), updated_at = now()
       where id = $1 and status = 'unbound' returning *`,
      [claim.id, status, status === "held" ? "unverified" : null, pass.humanTag, pass.payee, pass.verified],
    );
    if (!bound) throw new ClaimError("this claim is already bound to a PayPal account", "wrong_state");
    return bound;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ClaimError("this PayPal account already has a claim in this program", "duplicate");
    throw err;
  }
}

/** Builds the claim pass after Log in with PayPal. The payer ID goes in sealed, never in clear. */
export function passAfterLogin(deps: ClaimsDeps, programId: string, payerId: string, verified: boolean): string {
  const { passKey, payeeKey } = claimKeys(deps.humanSecret);
  return issuePass(passKey, {
    programId,
    humanTag: humanTag(deps.humanSecret, programId, payerId),
    verified,
    payee: sealPayee(payeeKey, payerId),
  }, deps.now().getTime());
}

export type ReviewReport = { rings: Ring[]; held: { ring: number; unverified: number }; approved: number; unbound: number };

/**
 * Closes the program to new claims and sorts what came in. Unbound claims stay unbound (and are
 * never paid). Re-running a review re-checks only claims that are still filed, held or approved.
 */
export async function reviewProgram(deps: ClaimsDeps, programId: string, options: { early?: boolean } = {}): Promise<ReviewReport> {
  return deps.db.transaction(async (tx) => {
    const program = await getProgram(tx, programId, true);
    if (program.status !== "open" && program.status !== "review") throw new ClaimError(`program is ${program.status}`, "wrong_state");
    if (program.status === "open" && !options.early && deps.now() < program.closes_at) {
      throw new ClaimError("the program has not closed yet", "wrong_state");
    }
    await tx.query(`update programs set status = 'review', updated_at = now() where id = $1`, [program.id]);

    // A claim a person cleared stays cleared: approved with the ring it was cleared from.
    const claims = await tx.query<ClaimRow>(
      `select * from claims where program_id = $1 and status in ('filed', 'held', 'approved')
         and not (status = 'approved' and ring_id is not null) order by id`,
      [program.id],
    );
    const rings = findRings(claims.map(signalsOf), { sampleText: program.sample_text }).map((ring) => ({ ...ring, id: ringIdFor(ring.claimIds) }));
    await tx.query(`delete from rings where program_id = $1 and decision is null`, [program.id]);
    for (const ring of rings) {
      const { claimIds, ...evidence } = ring;
      await tx.query(
        `insert into rings (program_id, id, claim_ids, evidence) values ($1, $2, $3::jsonb, $4::jsonb) on conflict (program_id, id) do nothing`,
        [program.id, ring.id, JSON.stringify(claimIds), JSON.stringify(evidence)],
      );
    }
    const ringOf = new Map(rings.flatMap((ring) => ring.claimIds.map((id) => [id, ring.id] as const)));

    let approved = 0;
    const held = { ring: 0, unverified: 0 };
    for (const claim of claims) {
      const ring = ringOf.get(claim.id) ?? null;
      const unverified = program.require_verified && !claim.verified;
      const [status, reason] = ring ? ["held", "ring"] : unverified ? ["held", "unverified"] : ["approved", null];
      if (status === "approved") approved++;
      else held[reason as "ring" | "unverified"]++;
      await tx.query(
        `update claims set status = $2, hold_reason = $3, ring_id = $4, updated_at = now() where id = $1`,
        [claim.id, status, reason, ring],
      );
    }
    const [unbound] = await tx.query<{ n: number }>(
      `select count(*)::int as n from claims where program_id = $1 and status = 'unbound'`,
      [program.id],
    );
    return { rings, held, approved, unbound: unbound!.n };
  });
}

export type RingRow = {
  program_id: string;
  id: string;
  claim_ids: string[];
  evidence: Omit<Ring, "claimIds">;
  memo: Memo | null;
  decision: "deny" | "approve" | null;
  decided_at: Date | null;
};

/**
 * Writes the investigator's memo for every undecided ring that has none yet. A failed call leaves
 * that ring without a memo (a person can still decide it) and is retried on the next run.
 */
export async function investigateProgram(deps: ClaimsDeps, programId: string): Promise<{ written: number; failed: number }> {
  const result = { written: 0, failed: 0 };
  if (!deps.investigator) return result;
  const program = await getProgram(deps.db, programId);
  const rings = await deps.db.query<RingRow>(`select * from rings where program_id = $1 and memo is null and decision is null order by id`, [program.id]);
  for (const row of rings) {
    const claims = await deps.db.query<ClaimRow>(`select * from claims where id = any($1)`, [row.claim_ids]);
    const ring: Ring = { ...row.evidence, id: row.id, claimIds: row.claim_ids };
    try {
      const memo = await investigateRing(deps.investigator, ring, new Map(claims.map((c) => [c.id, signalsOf(c)])), program.sample_text);
      await deps.db.query(`update rings set memo = $3::jsonb where program_id = $1 and id = $2`, [program.id, row.id, JSON.stringify(memo)]);
      result.written++;
    } catch (err) {
      console.error(`investigate ${row.id}:`, err instanceof Error ? err.message : err);
      result.failed++;
    }
  }
  return result;
}

/** A person's decision on held claims: confirm a ring (deny) or clear it (approve). */
export async function decideClaims(
  deps: ClaimsDeps,
  programId: string,
  selection: { ringId: string } | { claimIds: string[] },
  decision: "approve" | "deny",
): Promise<number> {
  const program = await getProgram(deps.db, programId);
  if (program.status !== "review") throw new ClaimError(`program is ${program.status}, not in review`, "wrong_state");
  const status = decision === "approve" ? "approved" : "denied";
  if ("ringId" in selection) {
    await deps.db.query(
      `update rings set decision = $3, decided_at = now() where program_id = $1 and id = $2 and decision is null`,
      [program.id, selection.ringId, decision],
    );
  }
  const rows =
    "ringId" in selection
      ? await deps.db.query<{ id: string }>(
          `update claims set status = $3, updated_at = now() where program_id = $1 and ring_id = $2 and status = 'held' returning id`,
          [program.id, selection.ringId, status],
        )
      : await deps.db.query<{ id: string }>(
          `update claims set status = $3, updated_at = now() where program_id = $1 and id = any($2) and status = 'held' returning id`,
          [program.id, selection.claimIds, status],
        );
  return rows.length;
}

export async function getProgram(db: Db, id: string, forUpdate = false): Promise<ProgramRow> {
  const [row] = await db.query<ProgramRow>(`select * from programs where id = $1${forUpdate ? " for update" : ""}`, [id]);
  if (!row) throw new ClaimError(`no program ${id}`, "not_found");
  return row;
}

export async function getClaim(db: Db, id: string): Promise<ClaimRow> {
  const [row] = await db.query<ClaimRow>(`select * from claims where id = $1`, [id]);
  if (!row) throw new ClaimError(`no claim ${id}`, "not_found");
  return row;
}

/** What the ring detector sees of a claim. */
export function signalsOf(claim: ClaimRow): ClaimSignals {
  return {
    id: claim.id,
    humanTag: claim.human_tag ?? claim.id,
    verified: Boolean(claim.verified),
    email: claim.email,
    address: claim.address,
    ip: claim.network,
    device: claim.device,
    filedAt: new Date(claim.filed_at).getTime(),
    narrative: claim.narrative,
  };
}

/** A ring's ID is fixed by its members, so the same ring keeps its ID across reviews. */
function ringIdFor(claimIds: string[]): string {
  return `ring_${createHash("sha256").update([...claimIds].sort().join("\n")).digest("hex").slice(0, 10)}`;
}

/** Only the network a claim came from is kept: the /24 for IPv4, the /48 for IPv6, else "". */
export function networkOf(ip: string): string {
  const address = ip.trim().replace(/^::ffff:/i, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return address.split(".").slice(0, 3).join(".");
  if (address.includes(":")) return address.toLowerCase().split(":").slice(0, 3).join(":");
  return "";
}

function assertOpen(deps: ClaimsDeps, program: ProgramRow) {
  if (program.status !== "open" || deps.now() >= program.closes_at) throw new ClaimError("this program is closed to new claims", "closed");
}

function passFor(deps: ClaimsDeps, program: ProgramRow, token: string): ClaimPass {
  const pass = readPass(claimKeys(deps.humanSecret).passKey, token, deps.now().getTime());
  if (!pass) throw new ClaimError("sign in with PayPal again: the claim pass is missing or expired", "unauthorized");
  if (pass.programId !== program.id) throw new ClaimError("this claim pass is for another program", "unauthorized");
  return pass;
}

function checkForm(form: ClaimForm): ClaimForm {
  const text = (value: unknown, name: string, max: number) => {
    const s = typeof value === "string" ? value.trim() : "";
    if (!s || s.length > max) throw new ClaimError(`${name} must be 1-${max} characters`, "invalid");
    return s;
  };
  const email = text(form.email, "email", 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ClaimError("email is not an email address", "invalid");
  return {
    email,
    address: text(form.address, "address", 300),
    narrative: text(form.narrative, "narrative", 4000),
    // No fingerprint is not a shared fingerprint: an empty key never links claims.
    device: typeof form.device === "string" ? form.device.trim().slice(0, 128) : "",
  };
}

function hashCode(code: string): string {
  return createHash("sha256").update(`rightful/bind/v1\n${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}
