/**
 * An in-memory Payouts for `PAYPAL_MODE=fake` and tests. Like PayPal, a repeated sender_batch_id
 * returns the original batch, and items settle a read or two after they are sent.
 */

import type { PayoutItemState, PayoutRequest, PayoutsPort } from "../claims/payouts-port.ts";

export class FakePayouts implements PayoutsPort {
  readonly batches = new Map<string, { request: PayoutRequest; reads: number }>();
  private readonly bySender = new Map<string, string>();
  /** Payer IDs whose items fail, to exercise the failure path. */
  readonly failing = new Set<string>();
  sends = 0;

  async send(request: PayoutRequest): Promise<{ batchId: string }> {
    const existing = this.bySender.get(request.senderBatchId);
    if (existing) return { batchId: existing };
    this.sends++;
    const batchId = `FAKEBATCH${this.batches.size + 1}`;
    this.batches.set(batchId, { request, reads: 0 });
    this.bySender.set(request.senderBatchId, batchId);
    return { batchId };
  }

  async items(batchId: string): Promise<PayoutItemState[]> {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`no fake batch ${batchId}`);
    const settled = batch.reads++ >= 1;
    return batch.request.items.map((item, i) => ({
      claimId: item.claimId,
      payoutItemId: `${batchId}-ITEM${i + 1}`,
      status: !settled ? "PENDING" : this.failing.has(item.payerId) ? "FAILED" : "SUCCESS",
    }));
  }
}
