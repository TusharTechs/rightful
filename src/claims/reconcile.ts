/**
 * Reconciliation: does PayPal's own transaction history agree with what Rightful says it paid?
 *
 * Payouts read-back (distribute.ts) says each item reached SUCCESS. This is a second, independent
 * source: Transaction Search, PayPal's ledger of the account. Every paid claim must appear there
 * under the transaction ID Payouts gave it, as a completed debit of exactly the share, with a note
 * that names the program's ledger. Transaction Search refreshes every few hours, so a program
 * waits ("pending") until PayPal's history has caught up with its batches, and gives up after a day.
 *
 * Live programs only: demo payouts are simulated, so PayPal has no history of them.
 */

import type { PayPalReporting } from "../paypal/sdk.ts";
import { ledgerAnchor } from "./ledger.ts";
import { type ClaimsDeps, ClaimError, getProgram } from "./service.ts";

export type Reconciliation = {
  checkedAt: string;
  /** When PayPal last refreshed the history this was checked against. */
  historyRefreshedAt: string | null;
  state: "pending" | "agrees" | "disagrees" | "incomplete";
  payouts: number;
  found: number;
  amountsMatch: number;
  completed: number;
  notesNameLedger: number;
  /** Claim IDs PayPal's history disagrees on (missing, wrong amount or status, or a foreign note). */
  problems: Array<{ claimId: string; problem: string }>;
};

/** Give up waiting for PayPal's history this long after the batches were created. */
export const RECONCILE_WINDOW_MS = 24 * 3_600_000;

export async function reconcileProgram(deps: ClaimsDeps & { reporting?: PayPalReporting }, programId: string): Promise<Reconciliation | null> {
  const program = await getProgram(deps.db, programId);
  if (program.kind === "demo" || !program.commitment_digest || !deps.reporting) return null;
  // Programs paid before batches carried the ledger anchor have nothing in PayPal naming a ledger.
  if (!program.payout_batches.some((b) => b.paypal?.messageAnchored)) return null;
  const paidClaims = () =>
    deps.db.query<{ id: string; amount_cents: number; payout_transaction_id: string | null }>(
      `select id, amount_cents, payout_transaction_id from claims where program_id = $1 and status = 'paid' order by id`,
      [program.id],
    );
  let paid = await paidClaims();
  if (paid.length === 0) return null;
  // Programs paid before transaction IDs were stored: read them back from Payouts once.
  if (deps.payouts && paid.some((c) => !c.payout_transaction_id)) {
    for (const batch of program.payout_batches) {
      if (!batch.batchId) continue;
      const { items } = await deps.payouts.read(batch.batchId);
      const known = items.filter((i) => i.transactionId);
      await deps.db.query(
        `update claims c set payout_transaction_id = u.txn from unnest($2::text[], $3::text[]) as u(id, txn)
         where c.id = u.id and c.program_id = $1 and c.payout_transaction_id is null`,
        [program.id, known.map((i) => i.claimId), known.map((i) => i.transactionId!)],
      );
    }
    paid = await paidClaims();
  }

  const created = program.payout_batches.map((b) => b.paypal?.timeCreated).filter((t): t is string => Boolean(t)).map((t) => new Date(t).getTime());
  const since = created.length ? Math.min(...created) : new Date(program.closes_at).getTime();
  const now = deps.now();
  const { refreshedAt, transactions } = await deps.reporting.history(new Date(since - 3_600_000), now);
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const anchor = ledgerAnchor(program.commitment_digest);

  const result: Reconciliation = {
    checkedAt: now.toISOString(),
    historyRefreshedAt: refreshedAt,
    state: "pending",
    payouts: paid.length,
    found: 0,
    amountsMatch: 0,
    completed: 0,
    notesNameLedger: 0,
    problems: [],
  };
  for (const claim of paid) {
    const t = claim.payout_transaction_id ? byId.get(claim.payout_transaction_id) : undefined;
    if (!t) {
      result.problems.push({ claimId: claim.id, problem: claim.payout_transaction_id ? "not in PayPal's history yet" : "Payouts gave no transaction ID" });
      continue;
    }
    result.found++;
    const amountOk = t.amountCents === -claim.amount_cents && t.currency === program.currency;
    const completed = t.status === "S";
    const named = t.note.includes(anchor);
    if (amountOk) result.amountsMatch++;
    if (completed) result.completed++;
    if (named) result.notesNameLedger++;
    if (!amountOk) result.problems.push({ claimId: claim.id, problem: `PayPal shows ${t.amountCents} ${t.currency}, the ledger ${-claim.amount_cents} ${program.currency}` });
    else if (!completed) result.problems.push({ claimId: claim.id, problem: `PayPal shows status ${t.status}` });
    else if (!named) result.problems.push({ claimId: claim.id, problem: "the payment's note does not name this ledger" });
  }
  // Missing records are only a problem once PayPal's history has refreshed past every batch.
  const caughtUp = refreshedAt !== null && created.length > 0 && new Date(refreshedAt).getTime() >= Math.max(...created);
  const missing = result.payouts - result.found;
  const wrong = result.found - Math.min(result.amountsMatch, result.completed, result.notesNameLedger);
  result.state =
    wrong > 0 ? "disagrees" : missing === 0 ? "agrees" : caughtUp ? "disagrees" : now.getTime() - since > RECONCILE_WINDOW_MS ? "incomplete" : "pending";
  await deps.db.query(`update programs set reconciliation = $2::jsonb where id = $1`, [program.id, JSON.stringify(result)]);
  return result;
}

/** Programs paid live whose reconciliation is not settled; the clock checks them every 10 minutes. */
export async function programsToReconcile(deps: ClaimsDeps): Promise<string[]> {
  const rows = await deps.db.query<{ id: string }>(
    `select id from programs where kind = 'live' and status = 'done' and commitment_digest is not null
       and (reconciliation is null or (reconciliation->>'state' = 'pending' and (reconciliation->>'checkedAt')::timestamptz < $1))
     order by id`,
    [new Date(deps.now().getTime() - 10 * 60_000)],
  );
  const ids = rows.map((r) => r.id);
  const anchored = await deps.db.query<{ id: string }>(
    `select id from programs where id = any($1) and exists (
       select 1 from jsonb_array_elements(payout_batches) b where (b->'paypal'->>'messageAnchored')::boolean)`,
    [ids],
  );
  return anchored.map((r) => r.id);
}

/** Before a live program pays: the PayPal account must hold at least what is about to be sent. */
export async function assertFunded(reporting: PayPalReporting | undefined, currency: string, totalCents: number): Promise<void> {
  if (!reporting) return;
  let available: number | null;
  try {
    available = await reporting.available(currency);
  } catch (err) {
    // Fail closed: if PayPal cannot confirm the balance, nothing is sent (paypal-plan.md, 1b.4).
    throw new ClaimError(`could not confirm the PayPal balance: ${err instanceof Error ? err.message : String(err)}`, "wrong_state");
  }
  if (available !== null && available < totalCents) {
    throw new ClaimError(`the PayPal account holds ${available / 100} ${currency}, less than the ${totalCents / 100} ${currency} this program would pay`, "wrong_state");
  }
}
