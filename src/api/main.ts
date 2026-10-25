/**
 * Starts the API. On Render this is the `firsthand-api` web service (`npm start`); locally,
 * `npm run dev:api`.
 */

import { createHash, randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { verifiedBeacon } from "../ballot/drand.ts";
import { paypalPort } from "../ballots/paypal-port.ts";
import type { Deps } from "../ballots/service.ts";
import { openFromEnv } from "../db/db.ts";
import { PayPalClient } from "../paypal/client.ts";
import { getUserInfo } from "../paypal/identity.ts";
import { createApp } from "./app.ts";

export type Server = { url: string; deps: Deps; adminToken: string; close: () => Promise<void> };

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
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

  const paypal = PayPalClient.fromEnv(env);
  const db = await openFromEnv(env);
  const deps: Deps = {
    db,
    paypal: paypalPort(paypal),
    humanSecret,
    beacon: verifiedBeacon,
    now: () => new Date(),
    returnBase: `${publicBase}/paypal`,
  };

  // Log in with PayPal needs a public https return URL registered on the app (localhost is refused).
  const redirectUri = env.PAYPAL_LIPP_REDIRECT_URI || (publicBase.startsWith("https://") ? `${publicBase}/auth/paypal/callback` : undefined);
  const app = createApp(deps, {
    adminToken,
    login: redirectUri
      ? {
          clientId: paypal.clientId,
          redirectUri,
          stateKey: createHash("sha256").update("firsthand/login-state-key/v1").update(humanSecret).digest(),
          exchange: async (code) => getUserInfo(paypal, await paypal.userTokenFromCode(code)),
        }
      : undefined,
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => resolve(s));
  });
  return {
    url: publicBase,
    deps,
    adminToken,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
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
  const server = await startServer();
  console.log(`Firsthand API listening on ${server.url}`);
}
