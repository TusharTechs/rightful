/**
 * Paying approved claims: an equal share of the pool, by Payouts, to the account that signed in.
 *
 * - **Distribute** starts only once every suspected ring has a person's decision, so no ring is
 *   paid by default. It fixes the share, the batch plan and the public ledger (`ledger.ts`, with a
 *   drand round still in the future) in one transaction, then sends the batches. Batch IDs come from the program, so a retry after a crash resends the same batches
 *   and PayPal returns the originals instead of paying twice.
 * - **Sync** reads every item back from PayPal and moves claims to `paid` or `failed`. The cron job
 *   runs it; sandbox webhooks can lag by hours, so polling is the source of truth. Once the
 *   committed round is published, sync also draws the audit sample from it.
 *
 * The leftover cents from rounding down stay in the pool; nobody gets a larger share.
 */

import { type InclusionProof } from "../engine/merkle.ts";
import { QUICKNET, roundAtOrAfter, timeOfRound } from "../engine/drand.ts";
import { type DistributionTerms, type LedgerCommitment, type PayoutLeaf, auditSample, auditSizeFor, commitDistribution, ledgerAnchor, provePayout } from "./ledger.ts";
import { openPayee, claimKeys } from "./pass.ts";
import { NOT_PAID, PAID, type PayoutsPort } from "./payouts-port.ts";
import { type ClaimsDeps, type ProgramRow, ClaimError, getClaim, getProgram } from "./service.ts";
import type { Db } from "../db/db.ts";
import { simulatedPayouts } from "../demo/simulated-payouts.ts";
import { pruneDemos } from "../demo/seed.ts";
import { type Reconciliation, assertFunded, programsToReconcile, reconcileProgram } from "./reconcile.ts";

/** PayPal allows 15,000 items per batch; smaller batches fail and retry in smaller pieces. */
export const BATCH_SIZE = 5000;

/** The audit round is at least this far after the commitment, so nobody can know it in advance. */
export const AUDIT_DELAY_MS = 30_000;

export type DistributionReport = {
  programId: string;
  shareCents: number;
  claims: number;
  remainderCents: number;
  batches: ProgramRow["payout_batches"];
};

export async function distributeProgram(deps: ClaimsDeps, programId: string): Promise<DistributionReport> {
  const before = await getProgram(deps.db, programId);
  const payouts = payoutsOf(deps, before);
  if (before.kind === "live" && before.status === "review") {
    // Refuse to start a distribution the PayPal account cannot fund (Balances, via the Server SDK).
    const [approved] = await deps.db.query<{ n: number }>(`select count(*)::int as n from claims where program_id = $1 and status = 'approved'`, [before.id]);
    if (approved!.n > 0) await assertFunded(deps.reporting, before.currency, Math.floor(before.pool_cents / approved!.n) * approved!.n);
  }
  const program = await deps.db.transaction(async (tx) => {
    const program = await getProgram(tx, programId, true);
    if (program.status === "distributing") return program;
    if (program.status !== "review") throw new ClaimError(`program is ${program.status}; review it first`, "wrong_state");

    const [rings] = await tx.query<{ n: number }>(
      `select count(*)::int as n from claims where program_id = $1 and status = 'held' and hold_reason = 'ring'`,
      [program.id],
    );
    if (rings!.n > 0) throw new ClaimError(`${rings!.n} claims in suspected rings still need a decision`, "wrong_state");
    const [approved] = await tx.query<{ n: number }>(
      `select count(*)::int as n from claims where program_id = $1 and status = 'approved'`,
      [program.id],
    );
    const count = approved!.n;
    if (count === 0) throw new ClaimError("no approved claims to pay", "invalid");
    const share = Math.floor(program.pool_cents / count);
    if (share < 1) throw new ClaimError("the pool is smaller than one cent per claim", "invalid");

    const batches = Array.from({ length: Math.ceil(count / BATCH_SIZE) }, (_, i) => ({ senderBatchId: `${program.id}-${i + 1}`, batchId: null }));
    await tx.query(`update claims set amount_cents = $2, updated_at = now() where program_id = $1 and status = 'approved'`, [program.id, share]);
    const auditRound = roundAtOrAfter(new Date(deps.now().getTime() + AUDIT_DELAY_MS));
    const fixed = { ...program, share_cents: share, audit_round: auditRound, audit_size: auditSizeFor(count) };
    const commitment = commitDistribution(termsOf(fixed), await ledgerPayouts(tx, program.id));
    const [updated] = await tx.query<ProgramRow>(
      `update programs set status = 'distributing', share_cents = $2, payout_batches = $3::jsonb, commitment_root = $4,
                           commitment_digest = $5, audit_round = $6, audit_size = $7, updated_at = now()
       where id = $1 returning *`,
      [program.id, share, JSON.stringify(batches), commitment.root, commitment.digest, auditRound, fixed.audit_size],
    );
    return updated!;
  });

  // The plan is fixed: every claim with an amount, in ID order, cut into the planned batches.
  const claims = await deps.db.query<{ id: string; payee_sealed: string; amount_cents: number }>(
    `select id, payee_sealed, amount_cents from claims where program_id = $1 and amount_cents is not null order by id`,
    [program.id],
  );
  const { payeeKey } = claimKeys(deps.humanSecret);
  const batches = [...program.payout_batches];
  for (const [i, batch] of batches.entries()) {
    if (batch.batchId) continue;
    const slice = claims.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const { batchId } = await payouts.send({
      senderBatchId: batch.senderBatchId,
      currency: program.currency,
      emailSubject: `Your payment from ${program.title}`,
      anchor: ledgerAnchor(program.commitment_digest!),
      items: slice.map((claim) => ({ claimId: claim.id, payerId: openPayee(payeeKey, claim.payee_sealed), amountCents: claim.amount_cents })),
    });
    batches[i] = { ...batch, batchId };
    await deps.db.query(`update programs set payout_batches = $2::jsonb, updated_at = now() where id = $1`, [program.id, JSON.stringify(batches)]);
  }

  return {
    programId: program.id,
    shareCents: program.share_cents!,
    claims: claims.length,
    remainderCents: program.pool_cents - program.share_cents! * claims.length,
    batches,
  };
}

export type SyncReport = { paid: number; failed: number; pending: number; done: boolean; audit: string[] | null };

/** Reads every payout item back from PayPal and records where each claim's money ended up. */
export async function syncPayouts(deps: ClaimsDeps, programId: string): Promise<SyncReport> {
  const program = await getProgram(deps.db, programId);
  const audit = await drawAudit(deps, program);
  if (program.status === "distributing") {
    const payouts = payoutsOf(deps, program);
    const anchor = ledgerAnchor(program.commitment_digest!);
    const batches = [...program.payout_batches];
    for (const [i, batch] of batches.entries()) {
      if (!batch.batchId) continue;
      const readback = await payouts.read(batch.batchId);
      const items = readback.items;
      if (program.kind !== "demo") {
        batches[i] = {
          ...batch,
          paypal: {
            timeCreated: readback.timeCreated,
            messageAnchored: (readback.emailMessage ?? "").includes(anchor),
            items: items.length,
            itemsAnchored: items.filter((item) => (item.note ?? "").includes(anchor)).length,
          },
        };
      }
      if (items.length === 0) continue;
      await deps.db.query(
        `update claims c set payout_item_id = u.item, payout_status = u.status, updated_at = now(),
                payout_transaction_id = coalesce(nullif(u.txn, ''), c.payout_transaction_id),
                status = case when c.status <> 'approved' then c.status
                              when u.status = any($5) then 'paid'
                              when u.status = any($6) then 'failed'
                              else c.status end
         from unnest($2::text[], $3::text[], $4::text[], $7::text[]) as u(id, item, status, txn)
         where c.id = u.id and c.program_id = $1`,
        [program.id, items.map((i) => i.claimId), items.map((i) => i.payoutItemId), items.map((i) => i.status), [...PAID], [...NOT_PAID], items.map((i) => i.transactionId ?? "")],
      );
    }
    await deps.db.query(`update programs set payout_batches = $2::jsonb where id = $1`, [program.id, JSON.stringify(batches)]);
  }
  const counts = await deps.db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from claims where program_id = $1 and amount_cents is not null group by status`,
    [program.id],
  );
  const count = (status: string) => counts.find((row) => row.status === status)?.n ?? 0;
  const pending = count("approved");
  const allSent = program.payout_batches.length > 0 && program.payout_batches.every((b) => b.batchId);
  const done = program.status === "done" || (program.status === "distributing" && allSent && pending === 0);
  if (done && program.status !== "done") {
    await deps.db.query(`update programs set status = 'done', updated_at = now() where id = $1 and status = 'distributing'`, [program.id]);
  }
  return { paid: count("paid"), failed: count("failed"), pending, done, audit };
}

/** Draws the audit sample once the committed round is out. Returns the sample, or null if not yet. */
async function drawAudit(deps: ClaimsDeps, program: ProgramRow): Promise<string[] | null> {
  if (program.audit_sample) return program.audit_sample;
  if (!program.audit_round || !deps.beacon || deps.now() < timeOfRound(program.audit_round)) return null;
  const beacon = await deps.beacon(program.audit_round);
  const sample = auditSample(termsOf(program), await ledgerPayouts(deps.db, program.id), beacon);
  await deps.db.query(
    `update programs set audit_randomness = $2, audit_signature = $3, audit_sample = $4::jsonb, updated_at = now() where id = $1 and audit_sample is null`,
    [program.id, beacon.randomness, beacon.signature, JSON.stringify(sample)],
  );
  return sample;
}

export type PublicLedger = {
  terms: DistributionTerms;
  commitment: LedgerCommitment;
  payouts: PayoutLeaf[];
  audit: { round: number; randomness: string; signature: string; sample: string[] } | null;
  /** PayPal's transaction history checked against the paid claims (live programs; null until checked). */
  reconciliation: Reconciliation | null;
  /**
   * What PayPal's own records of each batch carry, as read back from PayPal by the API. Null for
   * demo programs, whose payouts are simulated and so have no PayPal record.
   */
  paypal: { anchor: string; batches: Array<{ batchId: string; timeCreated: string | null; messageAnchored: boolean; items: number; itemsAnchored: number } | { batchId: string; pending: true }> } | null;
};

/** Everything anyone needs to check the distribution. No payer IDs, no personal data. */
export async function publicLedger(deps: ClaimsDeps, programId: string): Promise<PublicLedger> {
  const program = await getProgram(deps.db, programId);
  if (!program.commitment_digest) throw new ClaimError("this program has not distributed yet", "wrong_state");
  const payouts = await ledgerPayouts(deps.db, program.id);
  return {
    terms: termsOf(program),
    commitment: { root: program.commitment_root!, payoutCount: payouts.length, digest: program.commitment_digest },
    payouts,
    audit: program.audit_sample
      ? { round: program.audit_round!, randomness: program.audit_randomness!, signature: program.audit_signature!, sample: program.audit_sample }
      : null,
    reconciliation: program.kind === "demo" ? null : program.reconciliation,
    paypal:
      program.kind === "demo"
        ? null
        : {
            anchor: ledgerAnchor(program.commitment_digest),
            batches: program.payout_batches
              .filter((b) => b.batchId)
              .map((b) => (b.paypal ? { batchId: b.batchId!, ...b.paypal } : { batchId: b.batchId!, pending: true as const })),
          },
  };
}

/** A claimant's receipt: their payout and the path from it to the published root. */
export async function payoutProof(deps: ClaimsDeps, claimId: string): Promise<{ programId: string; root: string; payout: PayoutLeaf; proof: InclusionProof }> {
  const claim = await getClaim(deps.db, claimId);
  const program = await getProgram(deps.db, claim.program_id);
  if (!program.commitment_root || claim.amount_cents === null || !claim.human_tag) {
    throw new ClaimError("this claim has no payout in a published ledger", "wrong_state");
  }
  const payouts = await ledgerPayouts(deps.db, program.id);
  const payout = payouts.find((p) => p.claimId === claim.id)!;
  return { programId: program.id, root: program.commitment_root, payout, proof: provePayout(program.id, payouts, payout) };
}

function termsOf(program: ProgramRow): DistributionTerms {
  return {
    programId: program.id,
    poolCents: program.pool_cents,
    currency: program.currency,
    shareCents: program.share_cents!,
    auditRound: program.audit_round!,
    auditSize: program.audit_size!,
    chainHash: QUICKNET.hash,
  };
}

/** Every claim given an amount at distribution, whatever happened to its payout since. */
async function ledgerPayouts(db: Db, programId: string): Promise<PayoutLeaf[]> {
  const rows = await db.query<{ id: string; human_tag: string; amount_cents: number }>(
    `select id, human_tag, amount_cents from claims where program_id = $1 and amount_cents is not null order by id`,
    [programId],
  );
  return rows.map((row) => ({ claimId: row.id, humanTag: row.human_tag, amountCents: row.amount_cents }));
}

/** Programs whose payouts are still moving, or whose audit is not drawn yet; the cron job syncs these. */
export async function tickClaims(deps: ClaimsDeps): Promise<{ synced: string[]; errors: { program: string; error: string }[] }> {
  const report = { synced: [] as string[], errors: [] as { program: string; error: string }[] };
  const rows = await deps.db.query<{ id: string }>(
    `select id from programs where status = 'distributing' or (audit_round is not null and audit_sample is null) order by id`,
  );
  for (const { id } of rows) {
    try {
      await syncPayouts(deps, id);
      report.synced.push(id);
    } catch (err) {
      report.errors.push({ program: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const id of await programsToReconcile(deps)) {
    try {
      await reconcileProgram(deps, id);
    } catch (err) {
      report.errors.push({ program: id, error: `reconcile: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  try {
    await pruneDemos(deps);
  } catch (err) {
    report.errors.push({ program: "demo", error: err instanceof Error ? err.message : String(err) });
  }
  return report;
}

/** Demo programs pay by simulation (see `simulated-payouts.ts`); live programs by PayPal. */
function payoutsOf(deps: ClaimsDeps, program: ProgramRow): PayoutsPort {
  if (program.kind === "demo") return simulatedPayouts(deps.db, BATCH_SIZE);
  if (!deps.payouts) throw new ClaimError("payouts are not configured on this server", "wrong_state");
  return deps.payouts;
}
