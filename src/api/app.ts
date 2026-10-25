/**
 * The public HTTP API (the `firsthand-api` web service).
 *
 * Fans create an entry, approve the hold on PayPal, and come back through `/paypal/return`.
 * Organizer actions (create, seal, draw, settle) need the admin token for now; on Render the
 * cron job and workflows call the same service functions directly.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { timeOfRound } from "../ballot/drand.ts";
import { PayPalError } from "../paypal/client.ts";
import { type LoginConfig, mountLogin } from "./login.ts";
import {
  type Deps,
  type EntryRow,
  BallotError,
  cancelEntry,
  completeEntry,
  createBallot,
  entryReceipt,
  getBallot,
  publicProof,
  runDraw,
  sealBallot,
  settleBallot,
  startEntry,
} from "../ballots/service.ts";

export function createApp(deps: Deps, options: { adminToken: string; login?: LoginConfig }) {
  const app = new Hono();
  if (options.login) mountLogin(app, options.login, () => deps.now().getTime());

  app.onError((err, c) => {
    if (err instanceof BallotError) {
      const status = { not_found: 404, closed: 409, wrong_state: 409, invalid: 400, too_early: 425 }[err.code];
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

  app.post("/api/ballots", admin, async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const closesAt =
      typeof body.closesAt === "string"
        ? new Date(body.closesAt)
        : new Date(deps.now().getTime() + Number(body.closesInSeconds ?? 600) * 1000);
    const ballot = await createBallot(deps, {
      title: String(body.title ?? ""),
      priceCents: Number(body.priceCents),
      currency: typeof body.currency === "string" ? body.currency : undefined,
      inventory: Number(body.inventory),
      perHumanLimit: body.perHumanLimit === undefined ? undefined : Number(body.perHumanLimit),
      maxQuantity: body.maxQuantity === undefined ? undefined : Number(body.maxQuantity),
      allowPartial: Boolean(body.allowPartial),
      requireVerified: body.requireVerified === undefined ? undefined : Boolean(body.requireVerified),
      closesAt,
    });
    return c.json(await ballotView(deps, ballot.id), 201);
  });

  app.get("/api/ballots/:id", async (c) => c.json(await ballotView(deps, param(c))));

  app.post("/api/ballots/:id/entries", async (c) => {
    const body = await c.req.json<{ quantity?: number }>().catch(() => ({}) as { quantity?: number });
    const { entry, approveUrl } = await startEntry(deps, param(c), Number(body.quantity ?? 1));
    return c.json({ entryId: entry.id, holdCents: entry.hold_cents, approveUrl }, 201);
  });

  app.get("/api/entries/:id", async (c) => {
    const { entry, proof } = await entryReceipt(deps, param(c));
    return c.json({ ...entryView(entry), inclusionProof: proof });
  });

  app.get("/api/ballots/:id/proof", async (c) => c.json(await publicProof(deps, param(c))));

  app.post("/api/ballots/:id/seal", admin, async (c) => {
    await sealBallot(deps, param(c), { early: c.req.query("early") === "1" });
    return c.json(await ballotView(deps, param(c)));
  });
  app.post("/api/ballots/:id/draw", admin, async (c) => {
    await runDraw(deps, param(c));
    return c.json(await ballotView(deps, param(c)));
  });
  app.post("/api/ballots/:id/settle", admin, async (c) => c.json(await settleBallot(deps, param(c))));

  // PayPal sends the fan back here after they approve (or cancel) the hold.
  app.get("/paypal/return", async (c) => {
    const entry = await completeEntry(deps, c.req.query("entry") ?? "");
    const message =
      entry.status === "held"
        ? "You're in. Your hold is placed; you are charged only if you are selected."
        : entry.rejection === "duplicate"
          ? "You already have an entry in this ballot. This one was released and you were not charged."
          : entry.rejection === "unverified"
            ? "This ballot needs a verified PayPal account. The hold was released and you were not charged."
            : entry.rejection === "closed"
              ? "Entries closed before your approval arrived. Nothing was held."
              : `Entry status: ${entry.status}`;
    return c.html(page("Firsthand", message, entry.id));
  });

  app.get("/paypal/cancel", async (c) => {
    const entry = await cancelEntry(deps, c.req.query("entry") ?? "");
    return c.html(page("Firsthand", "You cancelled. Nothing was held.", entry.id));
  });

  return app;
}

async function ballotView(deps: Deps, id: string) {
  const ballot = await getBallot(deps.db, id);
  const counts = await deps.db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from entries where ballot_id = $1 group by status`,
    [id],
  );
  const round = ballot.draw_round ?? ballot.planned_round;
  return {
    id: ballot.id,
    title: ballot.title,
    status: ballot.status,
    priceCents: ballot.price_cents,
    currency: ballot.currency,
    inventory: ballot.inventory,
    perHumanLimit: ballot.per_human_limit,
    maxQuantity: ballot.max_quantity,
    closesAt: ballot.closes_at,
    drawRound: round,
    drawRoundFixed: ballot.draw_round !== null,
    drawAt: timeOfRound(round),
    commitment: ballot.commitment_digest,
    entries: Object.fromEntries(counts.map((row) => [row.status, row.n])),
  };
}

function param(c: Context): string {
  return c.req.param("id") ?? "";
}

function entryView(entry: EntryRow) {
  return {
    id: entry.id,
    ballotId: entry.ballot_id,
    quantity: entry.quantity,
    holdCents: entry.hold_cents,
    status: entry.status,
    rejection: entry.rejection,
    outcome: entry.outcome,
    selectedUnits: entry.selected_units,
    position: entry.position,
    humanTag: entry.human_tag,
  };
}

function page(title: string, message: string, entryId: string) {
  const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.4rem">${escape(title)}</h1><p>${escape(message)}</p>
<p style="color:#555;font-size:.9rem">Entry <code>${escape(entryId)}</code></p></body></html>`;
}
