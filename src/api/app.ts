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
import { type ClaimsDeps, ClaimError, getProgram } from "../claims/service.ts";
import { isDemoToken } from "../demo/seed.ts";
import { PayPalError } from "../paypal/client.ts";
import { type WebhookVerifier, receivePayPalWebhook } from "../claims/webhooks.ts";
import { claimantAfterLogin, mountClaims } from "./claims.ts";
import { openApiDocument } from "./contract.ts";
import { type LoginConfig, mountLogin } from "./login.ts";

export type AppOptions = {
  adminToken: string;
  login?: LoginConfig;
  /** The API's public origin, for links handed to agents. */
  publicBase?: string;
  /** The web app's origin, for claim status links on the claimant pages. */
  webBase?: string;
  /** Checks PayPal webhook signatures; without one, `/webhooks/paypal` answers 404. */
  webhooks?: WebhookVerifier;
};

export function createApp(deps: ClaimsDeps, options: AppOptions) {
  const app = new Hono();
  const webBase = (options.webBase ?? "http://localhost:5173").replace(/\/$/, "");
  if (options.login) mountLogin(app, { claimant: claimantAfterLogin(deps, webBase), webBase, ...options.login }, () => deps.now().getTime());
  // The API uses no cookies outside /auth and /claim, so any origin may read public data and file.
  app.use("/api/*", cors({ origin: "*", allowHeaders: ["content-type", "authorization"], allowMethods: ["GET", "POST"] }));
  // The MCP endpoint is public and cookie-free too, so browser-based MCP clients may call it.
  app.use("/mcp", cors({ origin: "*", allowHeaders: ["content-type", "accept", "mcp-protocol-version", "mcp-session-id"], allowMethods: ["GET", "POST", "DELETE"] }));

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

  const bearer = (c: Context) => c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  const isAdmin = (token: string) => {
    const given = Buffer.from(token);
    const expected = Buffer.from(options.adminToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const admin = async (c: Context, next: () => Promise<void>) => {
    if (!isAdmin(bearer(c))) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  // Program actions also accept that program's console token, which exists only for demo programs.
  const programAdmin = async (c: Context, next: () => Promise<void>) => {
    const token = bearer(c);
    if (isAdmin(token)) return next();
    const programId = c.req.param("id") ?? "";
    if (token && isDemoToken(deps.humanSecret, programId, token)) {
      const program = await getProgram(deps.db, programId).catch(() => null);
      if (program?.kind === "demo") return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  };

  app.get("/health", (c) => c.json({ ok: true }));

  // The public contract (OpenAPI 3.1), generated from the schemas the MCP tools use too.
  app.use("/openapi.json", cors({ origin: "*", allowMethods: ["GET"] }));
  app.get("/openapi.json", (c) => c.json(openApiDocument(options.publicBase ?? new URL(c.req.url).origin)));

  // PayPal's Payouts notifications: signature checked with PayPal, recorded once, then a read-back.
  app.post("/webhooks/paypal", async (c) => {
    if (!options.webhooks) return c.json({ error: "not_configured" }, 404);
    const result = await receivePayPalWebhook(deps, options.webhooks, (name) => c.req.header(name), await c.req.text());
    return c.json(result, result.status);
  });

  mountClaims(app, deps, { admin, programAdmin, publicBase: options.publicBase, webBase });

  return app;
}
