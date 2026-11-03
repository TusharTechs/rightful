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
 *   held; everything else is approved. A person confirms or clears each ring. Nothing here denies a
 *   claim on its own.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/db.ts";
import { humanTag } from "../ballot/human.ts";
import { isUniqueViolation } from "../ballots/service.ts";
import { findRings, type Ring } from "../rings/cluster.ts";
import { type ClaimPass, claimKeys, issuePass, readPass, sealPayee } from "./pass.ts";

export type ClaimsDeps = {
  db: Db;
  /** Server secret behind human tags, claim passes and sealed payees (≥ 32 bytes). */
  humanSecret: Uint8Array;
  now: () => Date;
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

    const claims = await tx.query<ClaimRow>(
      `select * from claims where program_id = $1 and status in ('filed', 'held', 'approved') order by id`,
      [program.id],
    );
    const rings = findRings(
      claims.map((c) => ({
        id: c.id,
        humanTag: c.human_tag ?? c.id,
        verified: Boolean(c.verified),
        email: c.email,
        address: c.address,
        ip: c.network,
        device: c.device,
        filedAt: new Date(c.filed_at).getTime(),
        narrative: c.narrative,
      })),
      { sampleText: program.sample_text },
    );
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
