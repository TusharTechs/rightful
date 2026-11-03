/**
 * Transaction Search and webhooks: how Firsthand checks PayPal's view of the money instead of
 * trusting its own. Transaction Search must be switched on for the app, covers at most 31 days per
 * query, and can lag new activity by up to 3 hours, so live state comes from the Orders and
 * Payments APIs and this is used for reconciliation.
 */

import type { PayPalClient } from "./client.ts";

export type TransactionSearchPage = {
  transaction_details?: {
    transaction_info?: { transaction_id?: string; transaction_event_code?: string; transaction_status?: string };
    /** The counterparty's PayPal account ID: the same ID Payouts accepts as `PAYPAL_ID`. */
    payer_info?: { account_id?: string; payer_status?: string };
  }[];
  total_items?: number;
  total_pages?: number;
};

export function searchTransactions(
  client: PayPalClient,
  range: { start: Date; end: Date; pageSize?: number; page?: number },
): Promise<TransactionSearchPage> {
  return client.request<TransactionSearchPage>("GET", "/v1/reporting/transactions", {
    query: {
      start_date: paypalTimestamp(range.start),
      end_date: paypalTimestamp(range.end),
      fields: "all",
      page_size: range.pageSize ?? 100,
      page: range.page ?? 1,
    },
  });
}

export type Webhook = { id: string; url: string; event_types: { name: string }[] };

export async function listWebhooks(client: PayPalClient): Promise<Webhook[]> {
  const body = await client.request<{ webhooks?: Webhook[] }>("GET", "/v1/notifications/webhooks");
  return body.webhooks ?? [];
}

/** PayPal wants `2026-10-25T00:00:00-0000`: seconds required, numeric offset without a colon. */
export function paypalTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}-0000`;
}
