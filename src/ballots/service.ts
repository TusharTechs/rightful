/**
 * The ballot lifecycle: open → sealed → drawn → settled.
 *
 * - **Enter**: a fan approves a PayPal hold for `price × quantity`. We authorize it, read the
 *   account's verification status, and turn the payer ID into a per-ballot human tag. A second
 *   entry from the same human is voided on the spot.
 * - **Seal**: entries close and the list is committed, together with a drand round that has not
 *   been published yet.
 * - **Draw**: once that round is out, the line is computed from it (`draw.ts`). No model or person
 *   picks anyone.
 * - **Settle**: selected entries are captured for what they won, everything else is voided. Every
 *   PayPal call uses an idempotency key derived from the entry ID, so settling twice, or after a
 *   crash, never charges anyone twice.
 */

import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";
import { type BallotTerms, type PublicEntry, commit, leafHash, proveInclusion, sortedLeaves, type InclusionProof } from "../ballot/commit.ts";
import { draw, type DrawResult } from "../ballot/draw.ts";
import { QUICKNET, roundAtOrAfter, timeOfRound } from "../ballot/drand.ts";
import { humanTag } from "../ballot/human.ts";
import { PayPalError } from "../paypal/client.ts";
import type { PayPalPort } from "./paypal-port.ts";

export type Deps = {
  db: Db;
  paypal: PayPalPort;
  /** Server secret behind human tags (≥ 32 bytes). */
  humanSecret: Uint8Array;
  /** Fetches and verifies a drand beacon. */
  beacon: (round: number) => Promise<{ round: number; randomness: string; signature: string }>;
  now: () => Date;
  /** Where PayPal sends buyers back, e.g. `https://api.example/paypal`. */
  returnBase: string;
};

export type BallotStatus = "open" | "sealed" | "drawn" | "settled" | "cancelled";
export type EntryStatus = "awaiting_approval" | "held" | "captured" | "voided" | "rejected" | "cancelled" | "failed";

export type BallotRow = {
  id: string;
  title: string;
  status: BallotStatus;
  inventory: number;
  per_human_limit: number;
  max_quantity: number;
  allow_partial: boolean;
  require_verified: boolean;
  price_cents: number;
  currency: string;
  closes_at: Date;
  planned_round: number;
  draw_round: number | null;
  commitment_digest: string | null;
  commitment_root: string | null;
  entry_count: number | null;
  randomness: string | null;
  signature: string | null;
  draw_line: DrawResult["line"] | null;
};

export type EntryRow = {
  id: string;
  ballot_id: string;
  quantity: number;
  hold_cents: number;
  status: EntryStatus;
  rejection: "unverified" | "duplicate" | "closed" | "declined" | null;
  outcome: "selected" | "not_selected" | null;
  selected_units: number | null;
  position: number | null;
  order_id: string | null;
  authorization_id: string | null;
  capture_id: string | null;
  human_tag: string | null;
  account_status: string | null;
  last_error: string | null;
  return_to: string | null;
};

export class BallotError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "closed" | "invalid" | "wrong_state" | "too_early",
  ) {
    super(message);
    this.name = "BallotError";
  }
}

/** Gap between sealing and the round that decides the draw: the round must still be unknown. */
const SEAL_TO_ROUND_MS = 9_000;

export type NewBallot = {
  title: string;
  priceCents: number;
  currency?: string;
  inventory: number;
  perHumanLimit?: number;
  maxQuantity?: number;
  allowPartial?: boolean;
  requireVerified?: boolean;
  closesAt: Date;
};

export async function createBallot(deps: Deps, input: NewBallot): Promise<BallotRow> {
  if (!input.title.trim()) throw new BallotError("title is required", "invalid");
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents < 0) throw new BallotError("priceCents must be a whole number of cents", "invalid");
  if (!Number.isSafeInteger(input.inventory) || input.inventory < 1) throw new BallotError("inventory must be at least 1", "invalid");
  if (input.closesAt.getTime() <= deps.now().getTime()) throw new BallotError("closesAt must be in the future", "invalid");
  const perHumanLimit = input.perHumanLimit ?? 2;
  const maxQuantity = Math.min(input.maxQuantity ?? perHumanLimit, perHumanLimit);
  const id = newId("bal");
  const plannedRound = roundAtOrAfter(new Date(input.closesAt.getTime() + SEAL_TO_ROUND_MS));

  const [row] = await deps.db.query<BallotRow>(
    `insert into ballots (id, title, status, inventory, per_human_limit, max_quantity, allow_partial, require_verified,
                          price_cents, currency, closes_at, planned_round)
     values ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      id,
      input.title.trim(),
      input.inventory,
      perHumanLimit,
      maxQuantity,
      input.allowPartial ?? false,
      input.requireVerified ?? true,
      input.priceCents,
      (input.currency ?? "USD").toUpperCase(),
      input.closesAt,
      plannedRound,
    ],
  );
  await logEvent(deps.db, id, null, "ballot_created", { inventory: input.inventory, plannedRound });
  return row!;
}

/**
 * Step 1 of entering: create the hold and hand back the PayPal approval link. `returnTo` is the
 * origin of the app the fan came from; the caller must have checked it against an allowlist.
 */
export async function startEntry(
  deps: Deps,
  ballotId: string,
  quantity: number,
  returnTo?: string,
): Promise<{ entry: EntryRow; approveUrl: string }> {
  const ballot = await getBallot(deps.db, ballotId);
  assertOpen(deps, ballot);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > ballot.max_quantity) {
    throw new BallotError(`quantity must be between 1 and ${ballot.max_quantity}`, "invalid");
  }

  const id = newId("ent");
  const holdCents = ballot.price_cents * quantity;
  await deps.db.query(
    `insert into entries (id, ballot_id, quantity, hold_cents, status, return_to) values ($1, $2, $3, $4, 'awaiting_approval', $5)`,
    [id, ballot.id, quantity, holdCents, returnTo ?? null],
  );

  const { orderId, approveUrl } = await deps.paypal.createHold(
    {
      referenceId: id,
      amountCents: holdCents,
      currency: ballot.currency,
      description: `Ballot hold for ${ballot.title} (charged only if selected)`.slice(0, 127),
      returnUrl: `${deps.returnBase}/return?entry=${id}`,
      cancelUrl: `${deps.returnBase}/cancel?entry=${id}`,
    },
    `hold-${id}`,
  );
  const [entry] = await deps.db.query<EntryRow>(`update entries set order_id = $2, updated_at = now() where id = $1 returning *`, [id, orderId]);
  await logEvent(deps.db, ballot.id, id, "entry_started", { quantity });
  return { entry: entry!, approveUrl };
}

/**
 * Step 2 of entering, after the buyer approves: authorize the hold, then decide whether the entry
 * stands. Safe to call more than once.
 */
export async function completeEntry(deps: Deps, entryId: string): Promise<EntryRow> {
  const entry = await getEntry(deps.db, entryId);
  if (entry.status !== "awaiting_approval") return entry;
  const ballot = await getBallot(deps.db, entry.ballot_id);
  if (!entry.order_id) throw new BallotError("entry has no PayPal order", "wrong_state");

  const approval = await deps.paypal.getApproval(entry.order_id);
  // COMPLETED means an earlier call already authorized it and crashed before recording that;
  // authorizing again with the same idempotency key returns the same authorization.
  if (approval.status !== "APPROVED" && approval.status !== "COMPLETED") {
    throw new BallotError(`the PayPal hold is ${approval.status}, not approved yet`, "too_early");
  }

  // Entries that arrive after close are declined without placing a hold.
  if (ballot.status !== "open" || deps.now() >= ballot.closes_at) {
    return reject(deps, entry, "closed");
  }

  const held = await deps.paypal.authorize(entry.order_id, `authorize-${entry.id}`);
  const accountStatus = held.accountStatus ?? approval.accountStatus ?? null;
  const payerId = held.payerId ?? approval.payerId;
  await deps.db.query(
    `update entries set authorization_id = $2, account_status = $3, updated_at = now() where id = $1`,
    [entry.id, held.authorizationId, accountStatus],
  );

  if (ballot.require_verified && accountStatus !== "VERIFIED") {
    return releaseAndReject(deps, { ...entry, authorization_id: held.authorizationId }, "unverified");
  }
  if (!payerId) throw new BallotError("PayPal returned no payer ID for the approved hold", "invalid");

  const tag = humanTag(deps.humanSecret, ballot.id, payerId);
  try {
    const [updated] = await deps.db.query<EntryRow>(
      `update entries set status = 'held', human_tag = $2, updated_at = now() where id = $1 returning *`,
      [entry.id, tag],
    );
    await logEvent(deps.db, ballot.id, entry.id, "entry_held", { quantity: entry.quantity, accountStatus });
    return updated!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return releaseAndReject(deps, { ...entry, authorization_id: held.authorizationId, human_tag: tag }, "duplicate");
    }
    throw err;
  }
}

export async function cancelEntry(deps: Deps, entryId: string): Promise<EntryRow> {
  const entry = await getEntry(deps.db, entryId);
  if (entry.status !== "awaiting_approval") return entry;
  const [updated] = await deps.db.query<EntryRow>(
    `update entries set status = 'cancelled', updated_at = now() where id = $1 returning *`,
    [entry.id],
  );
  await logEvent(deps.db, entry.ballot_id, entry.id, "entry_cancelled", {});
  return updated!;
}

/**
 * Closes entries and commits the list. The deciding round is the planned one, or a later one if
 * sealing runs late, so that it is always unpublished at the moment of commitment. An organizer who
 * closes early gets a round a few seconds out instead of waiting for the planned one: nobody can
 * know a future round's randomness, so choosing when to seal gives no advantage.
 */
export async function sealBallot(deps: Deps, ballotId: string, options: { early?: boolean } = {}): Promise<BallotRow> {
  return deps.db.transaction(async (tx) => {
    const ballot = await getBallot(tx, ballotId, true);
    if (ballot.status !== "open") return ballot;
    const now = deps.now();
    if (!options.early && now < ballot.closes_at) throw new BallotError("entries are still open", "too_early");

    const soonest = roundAtOrAfter(new Date(now.getTime() + SEAL_TO_ROUND_MS));
    const round = now < ballot.closes_at ? soonest : Math.max(ballot.planned_round, soonest);
    const entries = await heldEntries(tx, ballot.id);
    const commitment = commit(termsOf(ballot, round), entries.map(publicEntry));

    await tx.query(`update entries set status = 'cancelled', updated_at = now() where ballot_id = $1 and status = 'awaiting_approval'`, [ballot.id]);
    const [sealed] = await tx.query<BallotRow>(
      `update ballots set status = 'sealed', closes_at = least(closes_at, $2), draw_round = $3, commitment_digest = $4,
              commitment_root = $5, entry_count = $6, updated_at = now()
       where id = $1 returning *`,
      [ballot.id, now, round, commitment.digest, commitment.root, commitment.entryCount],
    );
    await logEvent(tx, ballot.id, null, "ballot_sealed", { round, commitment: commitment.digest, entries: commitment.entryCount });
    return sealed!;
  });
}

/** Runs the draw once the committed round is published. */
export async function runDraw(deps: Deps, ballotId: string): Promise<BallotRow> {
  const ballot = await getBallot(deps.db, ballotId);
  if (ballot.status !== "sealed") {
    if (ballot.status === "drawn" || ballot.status === "settled") return ballot;
    throw new BallotError(`ballot is ${ballot.status}, not sealed`, "wrong_state");
  }
  const round = ballot.draw_round!;
  if (deps.now() < timeOfRound(round)) throw new BallotError(`round ${round} is not published until ${timeOfRound(round).toISOString()}`, "too_early");

  const beacon = await deps.beacon(round);
  const entries = await heldEntries(deps.db, ballot.id);
  const result = draw(termsOf(ballot, round), entries.map(publicEntry), beacon);
  if (result.commitment.digest !== ballot.commitment_digest) {
    throw new Error("held entries no longer match the sealed commitment; refusing to draw");
  }

  return deps.db.transaction(async (tx) => {
    for (const placement of result.line) {
      await tx.query(
        `update entries set outcome = $2, selected_units = $3, position = $4, updated_at = now() where id = $1`,
        [placement.entryId, placement.selected > 0 ? "selected" : "not_selected", placement.selected, placement.position],
      );
    }
    const [drawn] = await tx.query<BallotRow>(
      `update ballots set status = 'drawn', randomness = $2, signature = $3, draw_line = $4, updated_at = now()
       where id = $1 and status = 'sealed' returning *`,
      [ballot.id, beacon.randomness, beacon.signature, JSON.stringify(result.line)],
    );
    if (!drawn) return getBallot(tx, ballot.id);
    await logEvent(tx, ballot.id, null, "ballot_drawn", { round, selectedUnits: result.selectedUnits });
    return drawn;
  });
}

export type SettleSummary = { captured: number; voided: number; failed: number; alreadyFinal: number };

/**
 * Captures selected entries and voids the rest. Idempotent and resumable: run it again after a
 * crash and it finishes the job without repeating a charge.
 */
export async function settleBallot(deps: Deps, ballotId: string, options: { concurrency?: number } = {}): Promise<SettleSummary> {
  const ballot = await getBallot(deps.db, ballotId);
  if (ballot.status === "settled") return { captured: 0, voided: 0, failed: 0, alreadyFinal: 0 };
  if (ballot.status !== "drawn") throw new BallotError(`ballot is ${ballot.status}, not drawn`, "wrong_state");

  const entries = await deps.db.query<EntryRow>(`select * from entries where ballot_id = $1 and status = 'held' order by position`, [ballot.id]);
  const summary: SettleSummary = { captured: 0, voided: 0, failed: 0, alreadyFinal: 0 };

  await inBatches(entries, options.concurrency ?? 8, async (entry) => {
    const result = await settleEntry(deps, ballot, entry);
    summary[result]++;
  });

  const [{ remaining } = { remaining: 0 }] = await deps.db.query<{ remaining: number }>(
    `select count(*)::int as remaining from entries where ballot_id = $1 and status = 'held'`,
    [ballot.id],
  );
  if (remaining === 0) {
    await deps.db.query(`update ballots set status = 'settled', updated_at = now() where id = $1 and status = 'drawn'`, [ballot.id]);
    await logEvent(deps.db, ballot.id, null, "ballot_settled", summary);
  }
  return summary;
}

async function settleEntry(deps: Deps, ballot: BallotRow, entry: EntryRow): Promise<keyof SettleSummary> {
  const authorizationId = entry.authorization_id!;
  try {
    if (entry.outcome === "selected" && (entry.selected_units ?? 0) > 0) {
      const amount = ballot.price_cents * entry.selected_units!;
      const capture = await deps.paypal.capture(authorizationId, amount, ballot.currency, `capture-${entry.id}`);
      await deps.db.query(`update entries set status = 'captured', capture_id = $2, updated_at = now() where id = $1`, [entry.id, capture.captureId]);
      await logEvent(deps.db, ballot.id, entry.id, "entry_captured", { amountCents: amount });
      return "captured";
    }
    // Read back first: if a previous run voided it and crashed before recording that, just record it.
    const status = await deps.paypal.authorizationStatus(authorizationId);
    if (status !== "VOIDED") await deps.paypal.void(authorizationId, `void-${entry.id}`);
    await deps.db.query(`update entries set status = 'voided', updated_at = now() where id = $1`, [entry.id]);
    await logEvent(deps.db, ballot.id, entry.id, "entry_voided", {});
    return status === "VOIDED" ? "alreadyFinal" : "voided";
  } catch (err) {
    // Network failures stay `held` so the next run retries with the same key. A definite refusal
    // from PayPal (e.g. an expired authorization) is recorded and left for a person to look at.
    if (err instanceof PayPalError && err.status >= 400 && err.status < 500) {
      await deps.db.query(`update entries set status = 'failed', last_error = $2, updated_at = now() where id = $1`, [entry.id, err.message]);
      await logEvent(deps.db, ballot.id, entry.id, "entry_settlement_failed", { issue: err.issue, debugId: err.debugId });
      return "failed";
    }
    throw err;
  }
}

export type PublicProof = {
  ballotId: string;
  title: string;
  status: BallotStatus;
  terms: BallotTerms | null;
  commitment: { digest: string; root: string; entryCount: number } | null;
  entries: PublicEntry[] | null;
  beacon: { round: number; randomness: string; signature: string } | null;
  line: DrawResult["line"] | null;
};

/** Everything a stranger needs to recompute the draw. No PayPal identifiers. */
export async function publicProof(deps: Deps, ballotId: string): Promise<PublicProof> {
  const ballot = await getBallot(deps.db, ballotId);
  const sealed = ballot.draw_round !== null && ballot.commitment_digest !== null;
  const entries = sealed ? (await heldOrSettledEntries(deps.db, ballot.id)).map(publicEntry) : null;
  return {
    ballotId: ballot.id,
    title: ballot.title,
    status: ballot.status,
    terms: sealed ? termsOf(ballot, ballot.draw_round!) : null,
    commitment: sealed ? { digest: ballot.commitment_digest!, root: ballot.commitment_root!, entryCount: ballot.entry_count! } : null,
    entries,
    beacon: ballot.randomness ? { round: ballot.draw_round!, randomness: ballot.randomness, signature: ballot.signature! } : null,
    line: ballot.draw_line,
  };
}

/** A fan's view of their own entry, with a Merkle proof once the ballot is sealed. */
export async function entryReceipt(deps: Deps, entryId: string): Promise<{ entry: EntryRow; proof: InclusionProof | null }> {
  const entry = await getEntry(deps.db, entryId);
  const ballot = await getBallot(deps.db, entry.ballot_id);
  let proof: InclusionProof | null = null;
  if (ballot.commitment_root && entry.human_tag && ["held", "captured", "voided"].includes(entry.status)) {
    const leaves = sortedLeaves(ballot.id, (await heldOrSettledEntries(deps.db, ballot.id)).map(publicEntry));
    proof = proveInclusion(leaves, leafHash(ballot.id, publicEntry(entry)));
  }
  return { entry, proof };
}

export async function getBallot(db: Db, id: string, forUpdate = false): Promise<BallotRow> {
  const [row] = await db.query<BallotRow>(`select * from ballots where id = $1${forUpdate ? " for update" : ""}`, [id]);
  if (!row) throw new BallotError(`no ballot ${id}`, "not_found");
  return row;
}

export async function getEntry(db: Db, id: string): Promise<EntryRow> {
  const [row] = await db.query<EntryRow>(`select * from entries where id = $1`, [id]);
  if (!row) throw new BallotError(`no entry ${id}`, "not_found");
  return row;
}

function termsOf(ballot: BallotRow, round: number): BallotTerms {
  return {
    ballotId: ballot.id,
    inventory: ballot.inventory,
    perHumanLimit: ballot.per_human_limit,
    allowPartial: ballot.allow_partial,
    round,
    chainHash: QUICKNET.hash,
  };
}

function publicEntry(entry: EntryRow): PublicEntry {
  return { entryId: entry.id, humanTag: entry.human_tag!, quantity: entry.quantity };
}

function heldEntries(db: Db, ballotId: string): Promise<EntryRow[]> {
  return db.query<EntryRow>(`select * from entries where ballot_id = $1 and status = 'held' order by id`, [ballotId]);
}

/** Entries that were in the sealed list, whatever happened to them since. */
function heldOrSettledEntries(db: Db, ballotId: string): Promise<EntryRow[]> {
  return db.query<EntryRow>(
    `select * from entries where ballot_id = $1 and status in ('held', 'captured', 'voided', 'failed') and human_tag is not null order by id`,
    [ballotId],
  );
}

function assertOpen(deps: Deps, ballot: BallotRow) {
  if (ballot.status !== "open" || deps.now() >= ballot.closes_at) throw new BallotError("this ballot is closed", "closed");
}

async function reject(deps: Deps, entry: EntryRow, reason: NonNullable<EntryRow["rejection"]>): Promise<EntryRow> {
  const [updated] = await deps.db.query<EntryRow>(
    `update entries set status = 'rejected', rejection = $2, updated_at = now() where id = $1 returning *`,
    [entry.id, reason],
  );
  await logEvent(deps.db, entry.ballot_id, entry.id, "entry_rejected", { reason });
  return updated!;
}

/** Voids an authorized hold we will not keep, then records why. */
async function releaseAndReject(deps: Deps, entry: EntryRow, reason: NonNullable<EntryRow["rejection"]>): Promise<EntryRow> {
  if (entry.authorization_id) await deps.paypal.void(entry.authorization_id, `void-${entry.id}`);
  return reject(deps, entry, reason);
}

async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(workers);
}

export function logEvent(db: Db, ballotId: string, entryId: string | null, kind: string, data: Record<string, unknown>) {
  return db.query(`insert into events (ballot_id, entry_id, kind, data) values ($1, $2, $3, $4)`, [ballotId, entryId, kind, JSON.stringify(data)]);
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505";
}
