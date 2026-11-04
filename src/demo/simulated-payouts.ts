/**
 * Payouts for demo programs. A demo pool is $2M across thousands of synthetic claimants, which no
 * sandbox account can fund and no synthetic claimant can receive, so its batches are simulated:
 * every item succeeds on the first read. Live programs always use PayPal Payouts; the money path
 * (share, ledger, batches, read-back, audit) is the same code either way.
 *
 * Stateless, so a restart loses nothing: an item's state is derived from the ledger itself.
 */

import type { Db } from "../db/db.ts";
import type { BatchReadback, PayoutsPort } from "../claims/payouts-port.ts";

const PREFIX = "SIM-";

export function simulatedPayouts(db: Db, batchSize: number): PayoutsPort {
  return {
    async send(request) {
      return { batchId: `${PREFIX}${request.senderBatchId}` };
    },
    async read(batchId): Promise<BatchReadback> {
      // Sender batch IDs are `<program>-<n>` (see distribute.ts); batch n carries the n-th slice.
      const match = /^SIM-(.+)-(\d+)$/.exec(batchId);
      if (!match) throw new Error(`not a simulated batch: ${batchId}`);
      const [, programId, n] = match;
      const rows = await db.query<{ id: string }>(
        `select id from claims where program_id = $1 and amount_cents is not null order by id offset $2 limit $3`,
        [programId, (Number(n) - 1) * batchSize, batchSize],
      );
      // No PayPal record exists for a simulated batch, so there is no message or note to read back.
      return { emailMessage: null, timeCreated: null, items: rows.map((row, i) => ({ claimId: row.id, payoutItemId: `${batchId}-${i + 1}`, status: "SUCCESS" })) };
    },
  };
}
