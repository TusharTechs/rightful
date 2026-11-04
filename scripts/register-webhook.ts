/**
 * Registers the API's Payouts webhook on the PayPal app (sandbox), once:
 *
 *   npm run webhook:register            # https://rightful-api.onrender.com/webhooks/paypal
 *   npm run webhook:register -- --list  # only show what is registered
 *
 * Reads PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from the environment or .env. The API finds the
 * webhook by its URL, so nothing else needs configuring. Safe to run again: an existing webhook for
 * the URL is left as it is.
 */

import { parseArgs } from "node:util";
import { PAYOUT_EVENTS } from "../src/claims/webhooks.ts";
import { PayPalClient } from "../src/paypal/client.ts";
import { listWebhooks } from "../src/paypal/reporting.ts";

const { values } = parseArgs({ options: { list: { type: "boolean", default: false }, api: { type: "string" } } });
const api = (values.api ?? process.env.RIGHTFUL_API ?? "https://rightful-api.onrender.com").replace(/\/$/, "");
const url = `${api}/webhooks/paypal`;
const client = PayPalClient.fromEnv();

const existing = await listWebhooks(client);
for (const hook of existing) console.log(`${hook.id}  ${hook.url}  (${hook.event_types.map((e) => e.name).join(", ")})`);
if (values.list) process.exit(0);

const ours = existing.find((hook) => hook.url === url);
if (ours) {
  console.log(`Already registered: ${ours.id} → ${url}`);
} else {
  const created = await client.request<{ id: string }>("POST", "/v1/notifications/webhooks", {
    body: { url, event_types: PAYOUT_EVENTS.map((name) => ({ name })) },
    // Derived from the URL, so a retry cannot register it twice.
    idempotencyKey: `rightful-webhook-${Buffer.from(url).toString("base64url").slice(0, 40)}`,
  });
  console.log(`Registered ${created.id} → ${url} for ${PAYOUT_EVENTS.length} Payouts events`);
}
