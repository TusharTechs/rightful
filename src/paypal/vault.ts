/**
 * Vault v3 for PayPal wallets: the fan approves once, and later holds can be placed without them
 * present. Firsthand uses this only for scoped AI-agent delegations; ordinary entries approve each
 * hold. Some sandbox apps refuse wallet vaulting (`NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`), so the
 * probe checks it before anything depends on it.
 */

import type { PayPalClient } from "./client.ts";
import type { Link } from "./orders.ts";

export type SetupToken = { id: string; status: string; links?: Link[] };
export type PaymentToken = { id: string; customer?: { id?: string }; links?: Link[] };

export function createPayPalSetupToken(
  client: PayPalClient,
  options: { description: string; returnUrl: string; cancelUrl: string; brandName?: string },
  idempotencyKey: string,
): Promise<SetupToken> {
  return client.request<SetupToken>("POST", "/v3/vault/setup-tokens", {
    idempotencyKey,
    body: {
      payment_source: {
        paypal: {
          description: options.description,
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: options.brandName ?? "Firsthand",
            shipping_preference: "NO_SHIPPING",
            return_url: options.returnUrl,
            cancel_url: options.cancelUrl,
          },
        },
      },
    },
  });
}

/** Exchanges an approved setup token for a reusable payment token (the vault ID). */
export function createPaymentToken(client: PayPalClient, setupTokenId: string, idempotencyKey: string): Promise<PaymentToken> {
  return client.request<PaymentToken>("POST", "/v3/vault/payment-tokens", {
    idempotencyKey,
    body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
  });
}

export function deletePaymentToken(client: PayPalClient, paymentTokenId: string): Promise<void> {
  return client.request<void>("DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`);
}
