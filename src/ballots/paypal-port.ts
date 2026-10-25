/**
 * The slice of PayPal the ballot service needs, as an interface, so the whole lifecycle can be
 * tested against a fake that behaves like PayPal (including idempotency) and run for real against
 * the sandbox with the same code.
 */

import type { PayPalClient } from "../paypal/client.ts";
import {
  approvalLink,
  authorizeOrder,
  captureAuthorization,
  createHoldOrder,
  firstAuthorization,
  getAuthorization,
  getOrder,
  voidAuthorization,
  type AuthorizationStatus,
  type HoldRequest,
  type Order,
} from "../paypal/orders.ts";

export type Approval = {
  status: Order["status"];
  accountStatus: "VERIFIED" | "UNVERIFIED" | undefined;
  /** Used only to derive the per-ballot human tag; never stored. */
  payerId: string | undefined;
};

export interface PayPalPort {
  createHold(hold: HoldRequest, idempotencyKey: string): Promise<{ orderId: string; approveUrl: string }>;
  getApproval(orderId: string): Promise<Approval>;
  authorize(orderId: string, idempotencyKey: string): Promise<Approval & { authorizationId: string; authorizationStatus: AuthorizationStatus }>;
  capture(authorizationId: string, amountCents: number, currency: string, idempotencyKey: string): Promise<{ captureId: string; status: string }>;
  void(authorizationId: string, idempotencyKey: string): Promise<void>;
  authorizationStatus(authorizationId: string): Promise<AuthorizationStatus>;
}

export function paypalPort(client: PayPalClient): PayPalPort {
  const approvalOf = (order: Order): Approval => ({
    status: order.status,
    accountStatus: order.payment_source?.paypal?.account_status,
    payerId: order.payment_source?.paypal?.account_id ?? order.payer?.payer_id,
  });

  return {
    async createHold(hold, idempotencyKey) {
      const order = await createHoldOrder(client, hold, idempotencyKey);
      const approveUrl = approvalLink(order);
      if (!approveUrl) throw new Error(`order ${order.id} came back without an approval link`);
      return { orderId: order.id, approveUrl };
    },
    async getApproval(orderId) {
      return approvalOf(await getOrder(client, orderId));
    },
    async authorize(orderId, idempotencyKey) {
      const order = await authorizeOrder(client, orderId, idempotencyKey);
      const authorization = firstAuthorization(order);
      if (!authorization) throw new Error(`order ${orderId} authorized without an authorization`);
      return { ...approvalOf(order), authorizationId: authorization.id, authorizationStatus: authorization.status };
    },
    async capture(authorizationId, amountCents, currency, idempotencyKey) {
      const capture = await captureAuthorization(client, authorizationId, { amountCents, currency, finalCapture: true }, idempotencyKey);
      return { captureId: capture.id, status: capture.status };
    },
    async void(authorizationId, idempotencyKey) {
      await voidAuthorization(client, authorizationId, idempotencyKey);
    },
    async authorizationStatus(authorizationId) {
      return (await getAuthorization(client, authorizationId)).status;
    },
  };
}
