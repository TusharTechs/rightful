/**
 * PayPal webhooks for Payouts: a faster signal, never the source of truth.
 *
 * - Every event's signature is checked with PayPal (`verify-webhook-signature`) before anything is
 *   stored; an event that fails is refused and leaves no trace.
 * - Each event is recorded once, by PayPal's event ID, so PayPal's retries change nothing.
 * - A payout item event does not move money state by itself: it makes the API read that program's
 *   batches back from PayPal straight away (`syncPayouts`), as the clock would within a minute.
 *   Sandbox webhooks can lag by hours, so the clock keeps polling either way.
 */

import type { PayPalClient } from "../paypal/client.ts";
import { listWebhooks } from "../paypal/reporting.ts";
import { syncPayouts } from "./distribute.ts";
import type { ClaimsDeps } from "./service.ts";

/** The transmission headers PayPal signs each delivery with. */
const SIGNED_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

/** Checks a delivery's signature: true only if PayPal says it is genuine and meant for our webhook. */
export type WebhookVerifier = (headers: (name: string) => string | undefined, rawBody: string) => Promise<boolean>;

/**
 * PayPal's own check. The event goes back byte for byte, because re-serializing it can break the
 * signature. Given `{ id }`, that is the ID PayPal gave our webhook; given `{ url }` instead, it is looked up
 * among the app's webhooks on first use, so no extra secret has to be configured.
 */
export function paypalWebhookVerifier(client: PayPalClient, webhook: { id: string } | { url: string }): WebhookVerifier {
  let cached = "id" in webhook ? webhook.id : undefined;
  const webhookId = async (): Promise<string | null> => {
    if (cached) return cached;
    // Not found yet (not registered, or the lookup failed): look again on the next delivery.
    const found = (await listWebhooks(client)).find((w) => w.url === (webhook as { url: string }).url)?.id;
    if (found) cached = found;
    return found ?? null;
  };
  return async (header, rawBody) => {
    const values = SIGNED_HEADERS.map((name) => header(name));
    if (values.some((v) => !v)) return false;
    const webhookIdValue = await webhookId().catch(() => null);
    if (!webhookIdValue) return false;
    const [authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime] = values as string[];
    const head = JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookIdValue,
    });
    const body = await client.request<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      rawBody: `${head.slice(0, -1)},"webhook_event":${rawBody}}`,
    });
    return body.verification_status === "SUCCESS";
  };
}

/** The event types Rightful subscribes to. */
export const PAYOUT_EVENTS = [
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.DENIED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED",
] as const;

type PayPalEvent = {
  id?: unknown;
  event_type?: unknown;
  resource?: {
    payout_item_id?: unknown;
    transaction_status?: unknown;
    payout_item?: { sender_item_id?: unknown };
    batch_header?: { payout_batch_id?: unknown; sender_batch_header?: { sender_batch_id?: unknown } };
  };
};

export type WebhookOutcome =
  | { status: 400; error: "unverified" | "invalid" }
  | { status: 200; duplicate: true }
  | { status: 200; eventId: string; programId: string | null; outcome: string };

export async function receivePayPalWebhook(deps: ClaimsDeps, verify: WebhookVerifier, header: (name: string) => string | undefined, rawBody: string): Promise<WebhookOutcome> {
  let event: PayPalEvent;
  try {
    event = JSON.parse(rawBody) as PayPalEvent;
  } catch {
    return { status: 400, error: "invalid" };
  }
  if (typeof event.id !== "string" || typeof event.event_type !== "string") return { status: 400, error: "invalid" };
  if (!(await verify(header, rawBody))) return { status: 400, error: "unverified" };

  const resource = event.resource ?? {};
  const claimId = str(resource.payout_item?.sender_item_id);
  // Batch events name the batch by our sender_batch_id, `<program>-<n>`.
  const senderBatchId = str(resource.batch_header?.sender_batch_header?.sender_batch_id);
  const [owner] = claimId
    ? await deps.db.query<{ program_id: string }>(`select program_id from claims where id = $1`, [claimId])
    : senderBatchId
      ? await deps.db.query<{ program_id: string }>(`select id as program_id from programs where payout_batches @> $1::jsonb`, [JSON.stringify([{ senderBatchId }])])
      : [];
  const programId = owner?.program_id ?? null;

  const inserted = await deps.db.query<{ id: string }>(
    `insert into paypal_events (id, event_type, resource_id, program_id, claim_id, reported_status)
     values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing returning id`,
    [event.id, event.event_type, str(resource.payout_item_id) ?? str(resource.batch_header?.payout_batch_id), programId, programId ? claimId : null, str(resource.transaction_status)],
  );
  if (inserted.length === 0) return { status: 200, duplicate: true };

  let outcome = programId ? "read back from PayPal" : "not one of our payouts";
  if (programId && event.event_type.startsWith("PAYMENT.PAYOUTS")) {
    try {
      await syncPayouts(deps, programId);
    } catch (err) {
      // The clock reads the batch back within a minute anyway; PayPal need not retry.
      outcome = `read-back failed, the clock will retry: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  await deps.db.query(`update paypal_events set outcome = $2 where id = $1`, [event.id, outcome]);
  return { status: 200, eventId: event.id, programId, outcome };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
