/**
 * Starts the API. On Render this is the `firsthand-api` web service (`npm start`); locally,
 * `npm run dev:api`, which also runs the clock in-process so ballots move on their own.
 */

import { createHash, randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { verifiedBeacon } from "../ballot/drand.ts";
import { tick } from "../ballots/clock.ts";
import { paypalPort } from "../ballots/paypal-port.ts";
import type { Deps } from "../ballots/service.ts";
import { openFromEnv } from "../db/db.ts";
import { PayPalClient } from "../paypal/client.ts";
import { getUserInfo } from "../paypal/identity.ts";
import { FakePayPal } from "../dev/fake-paypal.ts";
import { createApp } from "./app.ts";

export type Server = { url: string; deps: Deps; adminToken: string; close: () => Promise<void> };

export type Runtime = {
  deps: Deps;
  /** The real sandbox client; absent in PAYPAL_MODE=fake. */
  paypal: PayPalClient | undefined;
  fakePayPal: FakePayPal | undefined;
  publicBase: string;
  production: boolean;
  adminToken: string;
};

/** Everything the API, the clock and scripts share, built from environment variables. */
export async function buildRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const port = Number(env.PORT ?? 8787);
  // Render sets RENDER_EXTERNAL_URL to the service's public https address.
  const publicBase = (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const production = env.NODE_ENV === "production";

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
  const fakePayPal = fake ? new FakePayPal(`${publicBase}/dev/fake-paypal`) : undefined;
  const deps: Deps = {
    db: await openFromEnv(env),
    paypal: fakePayPal ?? paypalPort(paypal!),
    humanSecret,
    beacon: verifiedBeacon,
    now: () => new Date(),
    returnBase: `${publicBase}/paypal`,
  };
  return { deps, paypal, fakePayPal, publicBase, production, adminToken };
}

export async function startServer(env: NodeJS.ProcessEnv = process.env, options: { clock?: boolean } = {}): Promise<Server> {
  const { deps, paypal, fakePayPal, publicBase, production, adminToken } = await buildRuntime(env);

  // Log in with PayPal needs a public https return URL registered on the app (localhost is refused).
  const redirectUri = !paypal
    ? undefined
    : env.PAYPAL_LIPP_REDIRECT_URI || (publicBase.startsWith("https://") ? `${publicBase}/auth/paypal/callback` : undefined);
  const webOrigins: (string | RegExp)[] = [
    ...(env.WEB_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    // Render static sites, including pull-request previews (firsthand-web-pr-12.onrender.com).
    /^https:\/\/firsthand-web(-[a-z0-9-]+)?\.onrender\.com$/,
    ...(production ? [] : [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/]),
  ];
  const app = createApp(deps, {
    adminToken,
    webOrigins,
    fakePayPal,
    login: redirectUri && paypal
      ? {
          clientId: paypal.clientId,
          redirectUri,
          stateKey: createHash("sha256").update("firsthand/login-state-key/v1").update(deps.humanSecret).digest(),
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
        tick(deps).then(
          (report) => report.errors.forEach((e) => console.error(`clock: ${e.ballot}: ${e.error}`)),
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer(process.env, { clock: process.env.NODE_ENV !== "production" });
  console.log(`Firsthand API listening on ${server.url}`);
}
