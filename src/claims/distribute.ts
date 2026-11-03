/**
 * Paying approved claims: an equal share of the pool, by Payouts, to the account that signed in.
 *
 * - **Distribute** starts only once every suspected ring has a person's decision, so no ring is
 *   paid by default. It fixes the share and the batch plan in one transaction, then sends the
 *   batches. Batch IDs come from the program, so a retry after a crash resends the same batches
 *   and PayPal returns the originals instead of paying twice.
 * - **Sync** reads every item back from PayPal and moves claims to `paid` or `failed`. The cron job
 *   runs it; sandbox webhooks can lag by hours, so polling is the source of truth.
 *
 * The leftover cents from rounding down stay in the pool; nobody gets a larger share.
 */

import { openPayee, claimKeys } from "./pass.ts";
import { NOT_PAID, PAID, type PayoutsPort } from "./payouts-port.ts";
import { type ClaimsDeps, type ProgramRow, ClaimError, getProgram } from "./service.ts";

/** PayPal allows 15,000 items per batch; smaller batches fail and retry in smaller pieces. */
export const BATCH_SIZE = 5000;

export type DistributionReport = {
  programId: string;
  shareCents: number;
  claims: number;
  remainderCents: number;
  batches: ProgramRow["payout_batches"];
};

export async function distributeProgram(deps: ClaimsDeps, programId: string): Promise<DistributionReport> {
  const payouts = payoutsOf(deps);
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
    const [updated] = await tx.query<ProgramRow>(
      `update programs set status = 'distributing', share_cents = $2, payout_batches = $3::jsonb, updated_at = now() where id = $1 returning *`,
      [program.id, share, JSON.stringify(batches)],
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

export type SyncReport = { paid: number; failed: number; pending: number; done: boolean };

/** Reads every payout item back from PayPal and records where each claim's money ended up. */
export async function syncPayouts(deps: ClaimsDeps, programId: string): Promise<SyncReport> {
  const program = await getProgram(deps.db, programId);
  if (program.status === "distributing") {
    const payouts = payoutsOf(deps);
    for (const batch of program.payout_batches) {
      if (!batch.batchId) continue;
      const items = await payouts.items(batch.batchId);
      if (items.length === 0) continue;
      await deps.db.query(
        `update claims c set payout_item_id = u.item, payout_status = u.status, updated_at = now(),
                status = case when c.status <> 'approved' then c.status
                              when u.status = any($5) then 'paid'
                              when u.status = any($6) then 'failed'
                              else c.status end
         from unnest($2::text[], $3::text[], $4::text[]) as u(id, item, status)
         where c.id = u.id and c.program_id = $1`,
        [program.id, items.map((i) => i.claimId), items.map((i) => i.payoutItemId), items.map((i) => i.status), [...PAID], [...NOT_PAID]],
      );
    }
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
  return { paid: count("paid"), failed: count("failed"), pending, done };
}

/** Programs whose payouts are still moving; the cron job syncs these. */
export async function tickClaims(deps: ClaimsDeps): Promise<{ synced: string[]; errors: { program: string; error: string }[] }> {
  const report = { synced: [] as string[], errors: [] as { program: string; error: string }[] };
  const rows = await deps.db.query<{ id: string }>(`select id from programs where status = 'distributing' order by id`);
  for (const { id } of rows) {
    try {
      await syncPayouts(deps, id);
      report.synced.push(id);
    } catch (err) {
      report.errors.push({ program: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

function payoutsOf(deps: ClaimsDeps): PayoutsPort {
  if (!deps.payouts) throw new ClaimError("payouts are not configured on this server", "wrong_state");
  return deps.payouts;
}
