/**
 * The public HTTP API (the `rightful-api` web service).
 *
 * Claimants sign in with PayPal and file, or confirm a claim an agent filed for them; agents file
 * over JSON; anyone can read a program and its payout ledger. Organizer actions (create, review,
 * decide, distribute) need the admin token; on Render the cron job calls the same functions.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { type ClaimsDeps, ClaimError } from "../claims/service.ts";
import { PayPalError } from "../paypal/client.ts";
import { claimantAfterLogin, mountClaims } from "./claims.ts";
import { type LoginConfig, mountLogin } from "./login.ts";

export type AppOptions = {
  adminToken: string;
  login?: LoginConfig;
  /** The API's public origin, for links handed to agents. */
  publicBase?: string;
};

export function createApp(deps: ClaimsDeps, options: AppOptions) {
  const app = new Hono();
  if (options.login) mountLogin(app, { claimant: claimantAfterLogin(deps), ...options.login }, () => deps.now().getTime());
  // The API uses no cookies outside /auth and /claim, so any origin may read public data and file.
  app.use("/api/*", cors({ origin: "*", allowHeaders: ["content-type", "authorization"], allowMethods: ["GET", "POST"] }));

  app.onError((err, c) => {
    if (err instanceof ClaimError) {
      const status = { not_found: 404, closed: 409, wrong_state: 409, duplicate: 409, invalid: 400, unauthorized: 401 }[err.code];
      return c.json({ error: err.code, message: err.message }, status as 400);
    }
    if (err instanceof PayPalError) {
      return c.json({ error: "paypal", issue: err.issue, debugId: err.debugId ?? null }, 502);
    }
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  const admin = async (c: Context, next: () => Promise<void>) => {
    const given = Buffer.from(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(options.adminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };

  app.get("/health", (c) => c.json({ ok: true }));

  mountClaims(app, deps, { admin, publicBase: options.publicBase });

  return app;
}
