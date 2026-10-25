/**
 * An in-memory PayPal for tests and local UI work (`PAYPAL_MODE=fake`, never in production). It
 * behaves like the real one where it matters for money safety:
 * idempotency keys replay the first result, captured and voided authorizations refuse further
 * changes, and a call can be made to "succeed at PayPal but lose the response" to simulate a crash.
 */

import { PayPalError } from "../paypal/client.ts";
import type { AuthorizationStatus } from "../paypal/orders.ts";
import type { Approval, PayPalPort } from "../ballots/paypal-port.ts";

type FakeOrder = {
  id: string;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  amountCents: number;
  returnUrl?: string;
  cancelUrl?: string;
  payerId?: string;
  accountStatus?: "VERIFIED" | "UNVERIFIED";
  authorizationId?: string;
};
type FakeAuthorization = { id: string; orderId: string; status: AuthorizationStatus; amountCents: number; capturedCents: number };

export class FakePayPal implements PayPalPort {
  orders = new Map<string, FakeOrder>();
  authorizations = new Map<string, FakeAuthorization>();
  /** Every state-changing call PayPal actually applied (replays are not counted). */
  applied: { op: string; target: string; amountCents?: number }[] = [];
  /** Keys whose next call is applied at PayPal but then throws as if the response was lost. */
  loseResponseFor = new Set<string>();
  private replays = new Map<string, unknown>();
  private counter = 0;

  /** `approveBase` is where approval links point (the dev approval page); tests can ignore it. */
  constructor(private readonly approveBase = "https://sandbox.example/checkoutnow") {}

  /** What the buyer does in the PayPal popup. */
  approve(orderId: string, payer: { payerId: string; accountStatus?: "VERIFIED" | "UNVERIFIED" }) {
    const order = this.orders.get(orderId)!;
    order.status = "APPROVED";
    order.payerId = payer.payerId;
    order.accountStatus = payer.accountStatus ?? "VERIFIED";
  }

  async createHold(hold: { referenceId: string; amountCents: number; returnUrl?: string; cancelUrl?: string }, key: string) {
    return this.once(key, () => {
      const id = this.nextId("ORDER");
      this.orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", amountCents: hold.amountCents, returnUrl: hold.returnUrl, cancelUrl: hold.cancelUrl });
      this.applied.push({ op: "create", target: id, amountCents: hold.amountCents });
      return { orderId: id, approveUrl: `${this.approveBase}?token=${id}` };
    });
  }

  async getApproval(orderId: string): Promise<Approval> {
    const order = this.orders.get(orderId)!;
    return { status: order.status, accountStatus: order.accountStatus, payerId: order.payerId };
  }

  async authorize(orderId: string, key: string) {
    return this.once(key, () => {
      const order = this.orders.get(orderId)!;
      if (order.status !== "APPROVED") throw new PayPalError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
      const id = this.nextId("AUTH");
      this.authorizations.set(id, { id, orderId, status: "CREATED", amountCents: order.amountCents, capturedCents: 0 });
      order.status = "COMPLETED";
      order.authorizationId = id;
      this.applied.push({ op: "authorize", target: id, amountCents: order.amountCents });
      return { status: order.status, accountStatus: order.accountStatus, payerId: order.payerId, authorizationId: id, authorizationStatus: "CREATED" as const };
    });
  }

  async capture(authorizationId: string, amountCents: number, _currency: string, key: string) {
    return this.once(key, () => {
      const auth = this.authorizations.get(authorizationId)!;
      if (auth.status === "VOIDED") throw issue("AUTHORIZATION_VOIDED");
      if (auth.status === "CAPTURED") throw issue("AUTHORIZATION_ALREADY_CAPTURED");
      if (amountCents > auth.amountCents) throw issue("CAPTURE_AMOUNT_EXCEEDS_AUTHORIZATION");
      auth.status = "CAPTURED";
      auth.capturedCents = amountCents;
      const captureId = this.nextId("CAP");
      this.applied.push({ op: "capture", target: authorizationId, amountCents });
      return { captureId, status: "COMPLETED" };
    });
  }

  async void(authorizationId: string, key: string) {
    await this.once(key, () => {
      const auth = this.authorizations.get(authorizationId)!;
      if (auth.status === "CAPTURED") throw issue("AUTHORIZATION_ALREADY_CAPTURED");
      if (auth.status !== "VOIDED") {
        auth.status = "VOIDED";
        this.applied.push({ op: "void", target: authorizationId });
      }
      return undefined;
    });
  }

  async authorizationStatus(authorizationId: string) {
    return this.authorizations.get(authorizationId)!.status;
  }

  private async once<T>(key: string, apply: () => T): Promise<T> {
    if (this.replays.has(key)) return this.replays.get(key) as T;
    const result = apply();
    this.replays.set(key, result);
    if (this.loseResponseFor.delete(key)) throw new TypeError(`connection reset after PayPal applied ${key}`);
    return result;
  }

  private nextId(prefix: string) {
    return `${prefix}${String(++this.counter).padStart(6, "0")}`;
  }
}

function issue(code: string) {
  return new PayPalError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: code }] });
}
