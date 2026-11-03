/**
 * The slice of PayPal Payouts that distribution needs, as an interface, so it can be tested against
 * a fake that behaves like PayPal (including idempotency) and run against the sandbox unchanged.
 *
 * Every item goes to `recipient_type: PAYPAL_ID`: the payer ID of the account that signed in for
 * the claim. There is no email or phone fallback, so money cannot reach anyone else.
 */

import type { PayPalClient } from "../paypal/client.ts";
import { createPayoutBatch, getPayoutBatch } from "../paypal/payouts.ts";

export type PayoutRequest = {
  /** PayPal's idempotency key for the batch; derived from the program, never the clock. */
  senderBatchId: string;
  currency: string;
  emailSubject: string;
  items: { claimId: string; payerId: string; amountCents: number }[];
};

export type PayoutItemState = { claimId: string; payoutItemId: string; status: string };

export interface PayoutsPort {
  send(request: PayoutRequest): Promise<{ batchId: string }>;
  items(batchId: string): Promise<PayoutItemState[]>;
}

const PAGE_SIZE = 1000;

export function payoutsPort(client: PayPalClient): PayoutsPort {
  return {
    async send(request) {
      const batch = await createPayoutBatch(client, {
        senderBatchId: request.senderBatchId,
        emailSubject: request.emailSubject,
        items: request.items.map((item) => ({
          itemId: item.claimId,
          recipientType: "PAYPAL_ID",
          receiver: item.payerId,
          amountCents: item.amountCents,
          currency: request.currency,
          note: "Your approved claim",
        })),
      });
      return { batchId: batch.batch_header.payout_batch_id };
    },
    async items(batchId) {
      const out: PayoutItemState[] = [];
      for (let page = 1; ; page++) {
        const batch = await getPayoutBatch(client, batchId, { page, pageSize: PAGE_SIZE });
        for (const item of batch.items ?? []) {
          const claimId = item.payout_item?.sender_item_id;
          if (claimId) out.push({ claimId, payoutItemId: item.payout_item_id, status: item.transaction_status ?? "PENDING" });
        }
        if ((batch.items ?? []).length < PAGE_SIZE) return out;
      }
    },
  };
}

/** Item states that end a payout. Anything else (PENDING, ONHOLD, UNCLAIMED, NEW) is still moving. */
export const PAID = new Set(["SUCCESS"]);
export const NOT_PAID = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"]);
