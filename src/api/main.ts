/**
 * Starts the API. On Render this is the `firsthand-api` web service; locally, `npm run dev:api`.
 */

import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { verifiedBeacon } from "../ballot/drand.ts";
import { paypalPort } from "../ballots/paypal-port.ts";
import type { Deps } from "../ballots/service.ts";
import { openFromEnv } from "../db/db.ts";
import { PayPalClient } from "../paypal/client.ts";
import { createApp } from "./app.ts";

export type Server = { url: string; deps: Deps; adminToken: string; close: () => Promise<void> };

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const port = Number(env.PORT ?? 8787);
  const publicBase = (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const production = env.NODE_ENV === "production";

  const humanSecret = env.HUMAN_TAG_SECRET ? Buffer.from(env.HUMAN_TAG_SECRET, "hex") : undefined;
  const adminToken = env.ADMIN_TOKEN;
  if (production && (!humanSecret || !adminToken)) throw new Error("HUMAN_TAG_SECRET and ADMIN_TOKEN are required in production");
  if (!humanSecret || !adminToken) {
    console.warn("HUMAN_TAG_SECRET or ADMIN_TOKEN not set: using throwaway values for this process only.");
  }

  const db = await openFromEnv(env);
  const deps: Deps = {
    db,
    paypal: paypalPort(PayPalClient.fromEnv(env)),
    humanSecret: humanSecret ?? randomBytes(32),
    beacon: verifiedBeacon,
    now: () => new Date(),
    returnBase: `${publicBase}/paypal`,
  };
  const token = adminToken ?? randomBytes(24).toString("base64url");
  const app = createApp(deps, { adminToken: token });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port }, () => resolve(s));
  });
  return {
    url: publicBase,
    deps,
    adminToken: token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer();
  console.log(`Firsthand API listening on ${server.url}`);
}
