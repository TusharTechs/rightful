/**
 * Payouts v1: how an approved claimant gets paid, to the PayPal account that signed in.
 *
 * `sender_batch_id` is PayPal's own idempotency key for payouts (duplicates are rejected for 30
 * days), so Rightful derives it from the program, never from the clock.
 */

import type { PayPalClient } from "./client.ts";
import { toMoney } from "./money.ts";

export type PayoutItem = {
  /** Our ID for the item: the claim. */
  itemId: string;
  recipientType: "EMAIL" | "PHONE" | "PAYPAL_ID";
  receiver: string;
  /** VENMO sends to a US phone number's Venmo account (USD only). */
  wallet?: "PAYPAL" | "VENMO";
  amountCents: number;
  currency?: string;
  note?: string;
};

export type PayoutBatch = {
  batch_header: {
    payout_batch_id: string;
    time_created?: string;
    batch_status: "PENDING" | "PROCESSING" | "SUCCESS" | "DENIED" | "CANCELED";
    sender_batch_header?: { sender_batch_id?: string; email_subject?: string; email_message?: string };
  };
  items?: { payout_item_id: string; transaction_status?: string; payout_item?: { sender_item_id?: string; note?: string } }[];
};

export function createPayoutBatch(
  client: PayPalClient,
  batch: { senderBatchId: string; emailSubject: string; emailMessage?: string; items: PayoutItem[] },
): Promise<PayoutBatch> {
  return client.request<PayoutBatch>("POST", "/v1/payments/payouts", {
    idempotencyKey: batch.senderBatchId,
    body: {
      sender_batch_header: {
        sender_batch_id: batch.senderBatchId,
        email_subject: batch.emailSubject,
        ...(batch.emailMessage ? { email_message: batch.emailMessage } : {}),
      },
      items: batch.items.map((item) => ({
        recipient_type: item.recipientType,
        receiver: item.receiver,
        sender_item_id: item.itemId,
        note: item.note,
        ...(item.wallet ? { recipient_wallet: item.wallet } : {}),
        amount: (({ currency_code, value }) => ({ currency: currency_code, value }))(
          toMoney(item.amountCents, item.currency),
        ),
      })),
    },
  });
}

export function getPayoutBatch(client: PayPalClient, payoutBatchId: string, page?: { page: number; pageSize: number }): Promise<PayoutBatch> {
  return client.request<PayoutBatch>("GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, {
    ...(page ? { query: { page: String(page.page), page_size: String(page.pageSize) } } : {}),
  });
}

/** One payout item as PayPal holds it, including the note it was sent with. */
export function getPayoutItem(client: PayPalClient, payoutItemId: string) {
  return client.request<{ payout_item_id: string; transaction_status?: string; payout_item?: { sender_item_id?: string; note?: string } }>(
    "GET",
    `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`,
  );
}
