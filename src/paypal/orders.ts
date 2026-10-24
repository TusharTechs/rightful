/**
 * Ballot holds on PayPal: an entry is an Orders v2 order with `intent: AUTHORIZE`.
 *
 * The fan approves a hold, nothing is charged, and after the draw the hold is either captured
 * (selected) or voided (not selected). PayPal honours an authorization for 3 days and keeps it
 * valid for 29, so ballots that run longer than the honour period reauthorize first.
 */

import type { PayPalClient } from "./client.ts";
import { type Money, toMoney } from "./money.ts";

export type Link = { href: string; rel: string; method?: string };

export type AuthorizationStatus =
  | "CREATED"
  | "CAPTURED"
  | "DENIED"
  | "PARTIALLY_CAPTURED"
  | "VOIDED"
  | "PENDING"
  | "EXPIRED";

export type Authorization = {
  id: string;
  status: AuthorizationStatus;
  amount?: Money;
  expiration_time?: string;
  links?: Link[];
};

export type Capture = { id: string; status: string; amount?: Money; final_capture?: boolean };
export type Refund = { id: string; status: string; amount?: Money };

export type PayPalSource = {
  /** The buyer's PayPal account ID (payer ID). */
  account_id?: string;
  /** Whether the buyer has verified the financial details on their PayPal account. */
  account_status?: "VERIFIED" | "UNVERIFIED";
  email_address?: string;
  attributes?: { vault?: { id?: string; status?: string } };
};

export type Order = {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  intent?: "CAPTURE" | "AUTHORIZE";
  payment_source?: { paypal?: PayPalSource };
  payer?: { payer_id?: string };
  purchase_units?: {
    reference_id?: string;
    amount?: Money;
    payments?: { authorizations?: Authorization[]; captures?: Capture[] };
  }[];
  links?: Link[];
};

export type HoldRequest = {
  /** Our entry ID. PayPal echoes it back as the purchase unit's reference ID. */
  referenceId: string;
  amountCents: number;
  currency?: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
};

const REPRESENTATION = { Prefer: "return=representation" };

/** Creates the order a fan approves to enter a ballot. Nothing is charged by approving it. */
export function createHoldOrder(client: PayPalClient, hold: HoldRequest, idempotencyKey: string): Promise<Order> {
  return client.request<Order>("POST", "/v2/checkout/orders", {
    idempotencyKey,
    headers: REPRESENTATION,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: hold.referenceId,
          description: hold.description,
          amount: toMoney(hold.amountCents, hold.currency),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: hold.brandName ?? "Firsthand",
            shipping_preference: "NO_SHIPPING",
            // CONTINUE, not PAY_NOW: approving a ballot hold is not a payment.
            user_action: "CONTINUE",
            return_url: hold.returnUrl,
            cancel_url: hold.cancelUrl,
          },
        },
      },
    },
  });
}

/**
 * Creates a hold against a vaulted PayPal wallet, with no buyer present. This is how a fan's AI
 * agent can enter on their behalf after the fan has approved a scoped delegation once.
 */
export function createVaultedHoldOrder(
  client: PayPalClient,
  hold: Omit<HoldRequest, "returnUrl" | "cancelUrl"> & { vaultId: string },
  idempotencyKey: string,
): Promise<Order> {
  return client.request<Order>("POST", "/v2/checkout/orders", {
    idempotencyKey,
    headers: REPRESENTATION,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: hold.referenceId,
          description: hold.description,
          amount: toMoney(hold.amountCents, hold.currency),
        },
      ],
      payment_source: {
        paypal: {
          vault_id: hold.vaultId,
          stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "IMMEDIATE" },
        },
      },
    },
  });
}

export function getOrder(client: PayPalClient, orderId: string): Promise<Order> {
  return client.request<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

/** Turns an approved order into an authorization (the actual hold). */
export function authorizeOrder(client: PayPalClient, orderId: string, idempotencyKey: string): Promise<Order> {
  return client.request<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
    idempotencyKey,
    headers: REPRESENTATION,
    body: {},
  });
}

export function getAuthorization(client: PayPalClient, authorizationId: string): Promise<Authorization> {
  return client.request<Authorization>("GET", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
}

/** Captures a selected entry. Omit `amountCents` to capture the full hold. */
export function captureAuthorization(
  client: PayPalClient,
  authorizationId: string,
  options: { amountCents?: number; currency?: string; finalCapture: boolean },
  idempotencyKey: string,
): Promise<Capture> {
  return client.request<Capture>("POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
    idempotencyKey,
    headers: REPRESENTATION,
    body: {
      final_capture: options.finalCapture,
      ...(options.amountCents === undefined ? {} : { amount: toMoney(options.amountCents, options.currency) }),
    },
  });
}

/** Releases an entry that was not selected. The fan is never charged. */
export async function voidAuthorization(
  client: PayPalClient,
  authorizationId: string,
  idempotencyKey: string,
): Promise<Authorization | undefined> {
  return client.request<Authorization | undefined>(
    "POST",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    { idempotencyKey, headers: REPRESENTATION },
  );
}

/** Renews a hold past PayPal's 3-day honour period. Allowed once, within 29 days. */
export function reauthorize(client: PayPalClient, authorizationId: string, idempotencyKey: string): Promise<Authorization> {
  return client.request<Authorization>(
    "POST",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`,
    { idempotencyKey, headers: REPRESENTATION, body: {} },
  );
}

export function refundCapture(client: PayPalClient, captureId: string, idempotencyKey: string): Promise<Refund> {
  return client.request<Refund>("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    idempotencyKey,
    headers: REPRESENTATION,
    body: {},
  });
}

/** The link the buyer follows to approve an order or setup token. */
export function approvalLink(resource: { links?: Link[] }): string | undefined {
  return resource.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
}

export function firstAuthorization(order: Order): Authorization | undefined {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0];
}
