/**
 * A stand-in for PayPal's approval page, mounted only when `PAYPAL_MODE=fake` (local development and
 * browser tests). It lets you click through the fan flow without sandbox logins. Never in production.
 */

import type { Hono } from "hono";
import type { FakePayPal } from "./fake-paypal.ts";

export function mountFakePayPal(app: Hono, paypal: FakePayPal) {
  app.get("/dev/fake-paypal", (c) => {
    const token = c.req.query("token") ?? "";
    const order = paypal.orders.get(token);
    if (!order) return c.text("No such order", 404);
    const amount = (order.amountCents / 100).toFixed(2);
    const fan = (payer: string, label: string, status = "VERIFIED") =>
      `<form method="post" action="/dev/fake-paypal"><input type="hidden" name="token" value="${token}"><input type="hidden" name="payer" value="${payer}"><input type="hidden" name="status" value="${status}"><button>${label}</button></form>`;
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stand-in PayPal</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}button{font:inherit;width:100%;padding:12px;margin:6px 0;border-radius:999px;border:0;background:#ffc439;font-weight:700;cursor:pointer}.ghost{background:#eee}</style></head>
<body><p style="color:#a00">Local stand-in for PayPal (PAYPAL_MODE=fake). No sandbox, no money.</p>
<h1 style="font-size:1.4rem">Approve a $${amount} hold</h1>
${fan("FAN_ALICE", "Approve as Alice (verified)")}
${fan("FAN_BOB", "Approve as Bob (verified)")}
${fan("FAN_CARA", "Approve as Cara (verified)")}
${fan("FAN_UNVERIFIED", "Approve as an unverified account", "UNVERIFIED")}
<form method="post" action="/dev/fake-paypal"><input type="hidden" name="token" value="${token}"><input type="hidden" name="cancel" value="1"><button class="ghost">Cancel and return</button></form>
</body></html>`);
  });

  app.post("/dev/fake-paypal", async (c) => {
    const form = await c.req.parseBody();
    const order = paypal.orders.get(String(form.token ?? ""));
    if (!order) return c.text("No such order", 404);
    if (form.cancel) return c.redirect(order.cancelUrl ?? "/", 303);
    paypal.approve(order.id, { payerId: String(form.payer), accountStatus: form.status === "UNVERIFIED" ? "UNVERIFIED" : "VERIFIED" });
    return c.redirect(order.returnUrl ?? "/", 303);
  });
}
