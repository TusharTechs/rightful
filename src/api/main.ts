/**
 * Starts the API. On Render this is the `rightful-api` web service (`npm start`); locally,
 * `npm run dev:api`, which also runs the clock in-process so payouts and audits move on their own.
 */

import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { tickClaims } from "../claims/distribute.ts";
import { payoutsPort } from "../claims/payouts-port.ts";
import { paypalWebhookVerifier } from "../claims/webhooks.ts";
import type { ClaimsDeps } from "../claims/service.ts";
import { openFromEnv } from "../db/db.ts";
import { FakePayouts } from "../dev/fake-payouts.ts";
import { verifiedBeacon } from "../engine/drand.ts";
import { PayPalClient } from "../paypal/client.ts";
import { getUserInfo } from "../paypal/identity.ts";
import { sdkReporting } from "../paypal/sdk.ts";
import { CachedInvestigator, DEMO_FIXTURES, FIXTURES, loadFixtures, typeSafeInvestigator } from "../rings/investigators.ts";
import { createApp } from "./app.ts";

export type Server = { url: string; deps: ClaimsDeps; adminToken: string; close: () => Promise<void> };

export type Runtime = {
  deps: ClaimsDeps;
  /** The real sandbox client; absent in PAYPAL_MODE=fake. */
  paypal: PayPalClient | undefined;
  publicBase: string;
  webBase: string;
  production: boolean;
  adminToken: string;
};

/** Everything the API, the clock and scripts share, built from environment variables. */
export async function buildRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const port = Number(env.PORT ?? 8787);
  // Render sets RENDER_EXTERNAL_URL to the service's public https address.
  const publicBase = (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const production = env.NODE_ENV === "production";
  // The web app (claim status pages, ledgers). On Render it is the rightful-web static site.
  const webBase = (env.PUBLIC_WEB_URL || (production ? "https://rightful-web.onrender.com" : "http://localhost:5173")).replace(/\/$/, "");

  if (production && (!env.HUMAN_TAG_SECRET || !env.ADMIN_TOKEN)) {
    throw new Error("HUMAN_TAG_SECRET and ADMIN_TOKEN are required in production");
  }
  if (!env.HUMAN_TAG_SECRET || !env.ADMIN_TOKEN) {
    console.warn("HUMAN_TAG_SECRET or ADMIN_TOKEN not set: using throwaway values for this process only.");
  }
  const humanSecret = env.HUMAN_TAG_SECRET ? secretBytes(env.HUMAN_TAG_SECRET) : randomBytes(32);
  const adminToken = env.ADMIN_TOKEN ?? randomBytes(24).toString("base64url");

  const fake = env.PAYPAL_MODE === "fake";
  if (fake && production) throw new Error("PAYPAL_MODE=fake is for local development only");
  const paypal = fake ? undefined : PayPalClient.fromEnv(env);
  const deps: ClaimsDeps = {
    db: await openFromEnv(env),
    humanSecret,
    now: () => new Date(),
    payouts: paypal ? payoutsPort(paypal) : new FakePayouts(),
    // Transaction Search and Balances through PayPal's Server SDK, for reconciliation and funding checks.
    reporting: paypal ? sdkReporting({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", environment: env.PAYPAL_ENV }) : undefined,
    // Recorded answers first (the demo program's rings are all recorded), then TypeSafe live if a key
    // is set. Without either, a ring carries the detector's evidence alone and a person decides.
    investigator: new CachedInvestigator(
      new Map([...(await loadFixtures(FIXTURES)), ...(await loadFixtures(DEMO_FIXTURES))]),
      env.TYPESAFE_API_KEY ? typeSafeInvestigator() : undefined,
    ),
    beacon: verifiedBeacon,
  };
  return { deps, paypal, publicBase, webBase, production, adminToken };
}

export async function startServer(env: NodeJS.ProcessEnv = process.env, options: { clock?: boolean } = {}): Promise<Server> {
  const { deps, paypal, publicBase, webBase, adminToken } = await buildRuntime(env);

  // Log in with PayPal needs a public https return URL registered on the app (localhost is refused).
  const redirectUri = !paypal
    ? undefined
    : env.PAYPAL_LIPP_REDIRECT_URI || (publicBase.startsWith("https://") ? `${publicBase}/auth/paypal/callback` : undefined);
  const app = createApp(deps, {
    adminToken,
    publicBase,
    webBase,
    // PayPal notifies https URLs only; the webhook is found by its URL unless PAYPAL_WEBHOOK_ID is set.
    webhooks: paypal && publicBase.startsWith("https://")
      ? paypalWebhookVerifier(paypal, env.PAYPAL_WEBHOOK_ID ? { id: env.PAYPAL_WEBHOOK_ID } : { url: `${publicBase}/webhooks/paypal` })
      : undefined,
    login: redirectUri && paypal
      ? {
          clientId: paypal.clientId,
          redirectUri,
          stateKey: createHash("sha256").update("rightful/login-state-key/v1").update(deps.humanSecret).digest(),
          exchange: async (code) => getUserInfo(paypal, await paypal.userTokenFromCode(code)),
        }
      : undefined,
  });

  const port = Number(env.PORT ?? 8787);
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => resolve(s));
  });

  // Locally there is no cron job, so the API runs the clock itself.
  const clock = options.clock
    ? setInterval(() => {
        tickClaims(deps).then(
          (report) => report.errors.forEach((e) => console.error(`clock: ${e.program}: ${e.error}`)),
          (err) => console.error("clock:", err),
        );
      }, 3000)
    : undefined;

  return {
    url: publicBase,
    deps,
    adminToken,
    close: async () => {
      if (clock) clearInterval(clock);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deps.db.close();
    },
  };
}

/** Accepts a hex secret, or any string of at least 32 characters (e.g. Render's generated values). */
function secretBytes(value: string): Buffer {
  const bytes = /^[0-9a-f]{64,}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "utf8");
  if (bytes.length < 32) throw new Error("HUMAN_TAG_SECRET must be at least 32 bytes");
  return bytes;
}

// Compared as URLs so the check also holds on Windows (C:\… paths, file:///C:/… URLs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer(process.env, { clock: process.env.NODE_ENV !== "production" });
  console.log(`Rightful API listening on ${server.url}`);
}
