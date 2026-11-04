/**
 * Rightful's HTTP surface: claim pages after Log in with PayPal, JSON for the web app and agents,
 * and the organizer's review actions.
 *
 * - `/claim/start?program=…` signs a person in with PayPal and shows the claim form.
 * - `POST /api/programs/:id/claims` without a pass is an agent filing: the claim starts unbound and
 *   the response carries a `bindUrl` for the person it was filed for. That page sets the bind code
 *   as an HttpOnly cookie (so it never travels through PayPal's URLs), signs them in, shows the
 *   claim exactly as the agent filed it, and binds it only when they confirm.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isVerified, type UserInfo } from "../paypal/identity.ts";
import {
  type ClaimRow,
  type ClaimsDeps,
  ClaimError,
  appealClaim,
  bindClaim,
  createProgram,
  decideClaims,
  fileClaim,
  getClaim,
  type RingRow,
  getProgram,
  investigateProgram,
  networkOf,
  passAfterLogin,
  reviewProgram,
} from "../claims/service.ts";
import { distributeProgram, payoutProof, publicLedger, syncPayouts } from "../claims/distribute.ts";
import { consoleView, ringMembers } from "../claims/console.ts";
import { reconcileProgram } from "../claims/reconcile.ts";
import { createDemoProgram } from "../demo/seed.ts";
import type { LoginIntent } from "./login.ts";
import { mountMcp } from "./mcp.ts";
import { escape, outcomePage, shell } from "./pages.ts";
import { humanTag } from "../engine/human.ts";

const BIND_COOKIE = "rf_bind";
const BIND_TTL_S = 30 * 60;

export type ClaimRoutesOptions = {
  admin: MiddlewareHandler;
  /** The admin token, or the console token of the demo program in the path. */
  programAdmin: MiddlewareHandler;
  /** The API's public origin, for links handed to agents. Defaults to the request's origin. */
  publicBase?: string;
  /** The web app's origin, for claim status links. */
  webBase: string;
};

export function mountClaims(app: Hono, deps: ClaimsDeps, options: ClaimRoutesOptions) {
  const demoLimiter = rateLimiter({ perKey: 6, total: 60, windowMs: 3_600_000 });
  // Agent filings need no sign-in, so they are limited by network (/24) and overall. A claim filed
  // this way is never paid until a person binds it, but unlimited filings would flood review.
  const agentLimiter = rateLimiter({ perKey: 30, total: 600, windowMs: 3_600_000 });

  /** Agent filing, shared by the JSON API and the MCP server: one path, one limit. */
  const fileForAgent = async (programId: string, form: ReturnType<typeof formOf>, who: { ip: string; agentName?: string; base: string }) => {
    if (!agentLimiter.allow(`${programId}|${networkOf(who.ip)}`, deps.now().getTime())) {
      return { error: "rate_limited" as const, message: "Too many unconfirmed claims from this network for this program in the last hour. Have people confirm the ones already filed." };
    }
    const { claim, bindCode } = await fileClaim(deps, programId, form, { via: "agent", ip: who.ip, agentName: who.agentName });
    const bindUrl = `${who.base}/claim/bind?claim=${encodeURIComponent(claim.id)}&code=${encodeURIComponent(bindCode!)}`;
    return {
      ...claimantView(claim),
      humanConfirmationRequired: true as const,
      bindUrl,
      next: "Send bindUrl to the person this claim is for. Nothing is paid until they sign in with PayPal and confirm it, and payment goes only to that PayPal account.",
    };
  };
  let demoQueue: Promise<unknown> = Promise.resolve();
  const base = (c: Context) => options.publicBase ?? new URL(c.req.url).origin;
  const secure = (c: Context) => base(c).startsWith("https://");

  // --- organizer -------------------------------------------------------------------------------

  app.post("/api/programs", options.admin, async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const program = await createProgram(deps, {
      title: String(body.title ?? ""),
      poolCents: Number(body.poolCents),
      currency: typeof body.currency === "string" ? body.currency : undefined,
      requireVerified: body.requireVerified === undefined ? undefined : Boolean(body.requireVerified),
      sampleText: typeof body.sampleText === "string" ? body.sampleText : undefined,
      closesAt: typeof body.closesAt === "string" ? new Date(body.closesAt) : new Date(deps.now().getTime() + Number(body.closesInSeconds ?? 3600) * 1000),
    });
    return c.json(await programView(deps, program.id), 201);
  });

  app.post("/api/programs/:id/review", options.programAdmin, async (c) => {
    const report = await reviewProgram(deps, id(c), { early: c.req.query("early") === "1" });
    const investigation = await investigateProgram(deps, id(c));
    return c.json({ ...report, investigation });
  });

  app.post("/api/programs/:id/investigate", options.programAdmin, async (c) => c.json(await investigateProgram(deps, id(c))));

  app.get("/api/programs/:id/rings", options.programAdmin, async (c) => {
    await getProgram(deps.db, id(c));
    const rings = await deps.db.query<RingRow>(`select * from rings where program_id = $1 order by jsonb_array_length(claim_ids) desc, id`, [id(c)]);
    return c.json(rings.map((r) => ({ id: r.id, claimIds: r.claim_ids, evidence: r.evidence, memo: r.memo, decision: r.decision, decidedAt: r.decided_at })));
  });

  app.post("/api/programs/:id/distribute", options.programAdmin, async (c) => c.json(await distributeProgram(deps, id(c))));

  app.post("/api/programs/:id/sync", options.programAdmin, async (c) => c.json(await syncPayouts(deps, id(c))));

  // PayPal's transaction history (Transaction Search) against the paid claims; the clock also runs it.
  app.post("/api/programs/:id/reconcile", options.programAdmin, async (c) => c.json({ reconciliation: await reconcileProgram(deps, id(c)) }));

  app.get("/api/programs/:id/claims", options.programAdmin, async (c) => {
    await getProgram(deps.db, id(c));
    const rows = await deps.db.query<ClaimRow>(`select * from claims where program_id = $1 order by filed_at, id`, [id(c)]);
    return c.json(rows.map(adminView));
  });

  app.post("/api/programs/:id/decisions", options.programAdmin, async (c) => {
    const body = await c.req.json<{ ringId?: string; ringIds?: string[]; claimIds?: string[]; decision?: string }>();
    const decision = body.decision;
    if (decision !== "approve" && decision !== "deny") throw new ClaimError("decision must be approve or deny", "invalid");
    // Several rings at once is still a person's decision on each: the console lists them first.
    if (Array.isArray(body.ringIds)) {
      let changed = 0;
      for (const ringId of body.ringIds.slice(0, 500).map(String)) changed += await decideClaims(deps, id(c), { ringId }, decision);
      return c.json({ changed });
    }
    const selection = body.ringId ? { ringId: body.ringId } : { claimIds: (body.claimIds ?? []).map(String) };
    return c.json({ changed: await decideClaims(deps, id(c), selection, decision) });
  });

  app.get("/api/programs/:id/console", options.programAdmin, async (c) => c.json(await consoleView(deps, id(c))));

  app.get("/api/programs/:id/rings/:ring", options.programAdmin, async (c) => c.json(await ringMembers(deps, id(c), c.req.param("ring") ?? "")));

  // --- the hosted demo -------------------------------------------------------------------------

  app.post("/api/demo", async (c) => {
    if (!demoLimiter.allow(clientIp(c), deps.now().getTime())) {
      return c.json({ error: "rate_limited", message: "Too many demo programs from here in the last hour. Reuse the one you have, or try again later." }, 429);
    }
    // One at a time: each copy is 5,000 inserts and a review.
    const next = demoQueue.catch(() => undefined).then(() => createDemoProgram(deps));
    demoQueue = next;
    const demo = await next;
    return c.json({ programId: demo.program.id, token: demo.token, ...(await programView(deps, demo.program.id)) }, 201);
  });

  // --- public and agents -----------------------------------------------------------------------

  app.get("/api/programs", async (c) => {
    // Demo copies are per visitor; they are not listed.
    const rows = await deps.db.query<{ id: string }>(`select id from programs where kind = 'live' order by created_at desc limit 20`);
    return c.json(await Promise.all(rows.map((row) => programView(deps, row.id))));
  });

  app.get("/api/programs/:id", async (c) => c.json(await programView(deps, id(c))));

  app.post("/api/programs/:id/claims", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const form = formOf(body);
    if (typeof body.pass === "string") {
      const { claim } = await fileClaim(deps, id(c), form, { via: "web", pass: body.pass, ip: clientIp(c) });
      return c.json(claimantView(claim), 201);
    }
    const agentName = typeof body.agentName === "string" ? body.agentName : undefined;
    const filed = await fileForAgent(id(c), form, { ip: clientIp(c), agentName, base: base(c) });
    return "error" in filed ? c.json(filed, 429) : c.json(filed, 201);
  });

  mountMcp(app, deps, {
    fileForAgent,
    claimantView,
    programView: (programId) => programView(deps, programId),
    clientIp,
    base,
    webBase: options.webBase,
  });

  app.get("/api/claims/:id", async (c) => {
    const claim = await getClaim(deps.db, id(c));
    const program = await getProgram(deps.db, claim.program_id);
    return c.json({ ...claimantView(claim), program: { id: program.id, title: program.title, status: program.status, closesAt: program.closes_at, kind: program.kind } });
  });

  // A held claimant asks for a person to look again (the claim ID is the capability, as on the receipt).
  app.post("/api/claims/:id/appeal", async (c) => {
    const body = await c.req.json<{ message?: unknown }>().catch(() => ({}) as { message?: unknown });
    return c.json(claimantView(await appealClaim(deps, id(c), typeof body.message === "string" ? body.message : "")));
  });

  app.get("/api/programs/:id/ledger", async (c) => c.json(await publicLedger(deps, id(c))));

  app.get("/api/claims/:id/proof", async (c) => c.json(await payoutProof(deps, id(c))));

  app.post("/api/claims/:id/bind", async (c) => {
    const body = await c.req.json<{ code?: string; pass?: string }>();
    return c.json(claimantView(await bindClaim(deps, id(c), String(body.code ?? ""), String(body.pass ?? ""))));
  });

  // --- pages -----------------------------------------------------------------------------------

  app.get("/claim/start", (c) => c.redirect(`/auth/paypal/login?program=${encodeURIComponent(c.req.query("program") ?? "")}`));

  app.get("/claim/bind", async (c) => {
    const claim = await getClaim(deps.db, c.req.query("claim") ?? "");
    setCookie(c, BIND_COOKIE, `${claim.id}.${c.req.query("code") ?? ""}`, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/claim", maxAge: BIND_TTL_S });
    return c.redirect(`/auth/paypal/login?program=${encodeURIComponent(claim.program_id)}&claim=${encodeURIComponent(claim.id)}`);
  });

  app.post("/claim/submit", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    try {
      if (body.claim) {
        const [cookieClaim, code] = (getCookie(c, BIND_COOKIE) ?? "").split(".");
        deleteCookie(c, BIND_COOKIE, { path: "/claim" });
        if (cookieClaim !== body.claim) throw new ClaimError("open the link you were sent again to confirm this claim", "unauthorized");
        const claim = await bindClaim(deps, body.claim, code ?? "", body.pass ?? "");
        return c.html(outcomePage({ title: "Claim confirmed", ok: true, message: `It was filed for you and is now tied to your PayPal account. ${outcome(claim)}`, claimId: claim.id, statusUrl: statusUrl(options.webBase, claim.id), webBase: options.webBase }));
      }
      const { claim } = await fileClaim(deps, body.program ?? "", formOf(body), { via: "web", pass: body.pass ?? "", ip: clientIp(c) });
      return c.html(outcomePage({ title: "Claim filed", ok: true, message: outcome(claim), claimId: claim.id, statusUrl: statusUrl(options.webBase, claim.id), webBase: options.webBase }), 201);
    } catch (err) {
      if (err instanceof ClaimError) return c.html(outcomePage({ title: "Claim not filed", ok: false, message: sentence(err.message), webBase: options.webBase }), err.code === "not_found" ? 404 : 400);
      throw err;
    }
  });
}

/** What Log in with PayPal does when the sign-in was for a claim. */
export function claimantAfterLogin(deps: ClaimsDeps, webBase: string) {
  const fail = (c: Context, title: string, message: string, status: 400 | 404 | 409 | 502) => c.html(outcomePage({ title, ok: false, message, webBase }), status);
  return async (c: Context, intent: LoginIntent, info: UserInfo): Promise<Response> => {
    const payerId = typeof info.payer_id === "string" ? info.payer_id : "";
    if (!payerId) return fail(c, "Sign-in incomplete", "PayPal did not share your account ID, so a payout could not be tied to you. Please try again.", 502);
    try {
      const program = await getProgram(deps.db, intent.program);
      if (program.status !== "open" || deps.now() >= program.closes_at) return fail(c, program.title, "This program is closed to new claims.", 409);
      const verified = isVerified(info);
      // One claim per PayPal account: if this account already has one here, show it instead of a form.
      const [existing] = await deps.db.query<{ id: string }>(
        `select id from claims where program_id = $1 and human_tag = $2`,
        [program.id, humanTag(deps.humanSecret, program.id, payerId)],
      );
      if (existing) {
        return c.html(outcomePage({
          title: "You already have a claim here",
          ok: true,
          message: `This PayPal account already has its one claim in ${program.title}. Follow it below; a second claim from the same account is never accepted.`,
          claimId: existing.id,
          statusUrl: statusUrl(webBase, existing.id),
          webBase,
        }));
      }
      const pass = passAfterLogin(deps, program.id, payerId, verified);
      const account = verified
        ? `<p><span class="badge good">✓ Verified PayPal account</span></p>`
        : `<p><span class="badge warn">PayPal account not verified</span></p><p class="small">You can still file. Your claim will wait until you verify your PayPal account, and nothing else is needed from you.</p>`;
      const promise = `<p class="muted small">One claim per PayPal account. Any payment goes only to the account you just signed in with; nobody else, not even an assistant that helped you, can receive it.</p>`;
      if (intent.claim) {
        const claim = await getClaim(deps.db, intent.claim);
        if (claim.program_id !== program.id || claim.status !== "unbound") return fail(c, program.title, "This claim is already confirmed, or it belongs to another program.", 409);
        return c.html(shell(program.title, `<h1>Is this your claim?</h1>
<p>${claim.agent_name ? `An assistant (it calls itself “${escape(claim.agent_name)}”)` : "Someone, or an assistant,"} filed this claim for you in <strong>${escape(program.title)}</strong>. Check it before you confirm: once confirmed it is your one claim in this program.</p>
${account}
<section class="card" aria-label="The claim as filed"><dl><dt>Email</dt><dd>${escape(claim.email)}</dd><dt>Mailing address</dt><dd>${escape(claim.address)}</dd><dt>What happened</dt><dd>${escape(claim.narrative)}</dd></dl></section>
${promise}
<form method="post" action="/claim/submit"><input type="hidden" name="pass" value="${escape(pass)}"><input type="hidden" name="claim" value="${escape(claim.id)}">
<button>Yes, this is my claim</button></form>
<p class="muted small" style="margin-top:12px">Not yours, or something is wrong? Close this page: nothing is confirmed unless you press the button.</p>`, webBase));
      }
      return c.html(shell(program.title, `<h1>${escape(program.title)}</h1>
${account}
<p class="muted small">Pool ${escape(dollars(program.pool_cents, program.currency))}, shared equally by approved claims. Closes ${escape(new Date(program.closes_at).toUTCString().replace(" GMT", " UTC"))}.</p>
<form method="post" action="/claim/submit"><input type="hidden" name="pass" value="${escape(pass)}"><input type="hidden" name="program" value="${escape(program.id)}"><input type="hidden" name="device" id="device">
<label for="email">Email<span class="hint">Where the program can reach you about this claim.</span></label>
<input id="email" name="email" type="email" required maxlength="254" autocomplete="email">
<label for="address">Mailing address<span class="hint">As on your purchase, if you remember it.</span></label>
<input id="address" name="address" required maxlength="300" autocomplete="street-address">
<label for="narrative">What happened<span class="hint">In your own words.${program.sample_text ? ` For example: “${escape(program.sample_text)}”` : ""}</span></label>
<textarea id="narrative" name="narrative" required maxlength="4000" rows="6"></textarea>
${promise}
<button>File my claim</button></form>
<script>${DEVICE_SCRIPT}</script>`, webBase));
    } catch (err) {
      if (err instanceof ClaimError) return fail(c, "Claim", sentence(err.message), 404);
      throw err;
    }
  };
}

function statusUrl(webBase: string, claimId: string): string {
  return `${webBase}/claim/${encodeURIComponent(claimId)}`;
}

function sentence(message: string): string {
  const s = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function dollars(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** A coarse, stable device hash: enough to notice one browser filing many claims, nothing more. */
const DEVICE_SCRIPT = `(async()=>{try{let k=localStorage.getItem("rf_device");if(!k){k=crypto.randomUUID();localStorage.setItem("rf_device",k)}
const s=[k,navigator.userAgent,screen.width+"x"+screen.height,Intl.DateTimeFormat().resolvedOptions().timeZone].join("|");
const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
document.getElementById("device").value=[...new Uint8Array(h)].slice(0,16).map(b=>b.toString(16).padStart(2,"0")).join("")}catch{}})()`;

async function programView(deps: ClaimsDeps, programId: string) {
  const program = await getProgram(deps.db, programId);
  const counts = await deps.db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from claims where program_id = $1 group by status`,
    [program.id],
  );
  return {
    id: program.id,
    title: program.title,
    kind: program.kind,
    status: program.status,
    poolCents: program.pool_cents,
    currency: program.currency,
    requireVerified: program.require_verified,
    sampleText: program.sample_text,
    closesAt: program.closes_at,
    shareCents: program.share_cents,
    commitment: program.commitment_digest,
    auditRound: program.audit_round,
    claims: Object.fromEntries(counts.map((row) => [row.status, row.n])),
  };
}

/** What a claimant (or their agent) may see: no personal data, no PayPal identifiers. */
export function claimantView(claim: ClaimRow) {
  return {
    id: claim.id,
    programId: claim.program_id,
    status: claim.status,
    holdReason: claim.hold_reason === "unverified" ? "unverified" : claim.hold_reason ? "review" : null,
    filedVia: claim.filed_via,
    bound: claim.human_tag !== null,
    amountCents: claim.amount_cents,
    filedAt: claim.filed_at,
    appealed: claim.appealed_at !== null,
  };
}

/** The organizer's view: the evidence, the pseudonym, never the payer ID. */
function adminView(claim: ClaimRow) {
  const { payee_sealed: _payee, bind_code_hash: _code, ...rest } = claim;
  return rest;
}

export function formOf(body: Record<string, unknown>) {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return { email: s(body.email), address: s(body.address), narrative: s(body.narrative), device: s(body.device) };
}

/** A fixed-window limit per key and overall. In memory: the API is one instance. */
function rateLimiter(limits: { perKey: number; total: number; windowMs: number }) {
  let windowStart = 0;
  let total = 0;
  const byKey = new Map<string, number>();
  return {
    allow(key: string, now: number): boolean {
      if (now - windowStart >= limits.windowMs) {
        windowStart = now;
        total = 0;
        byKey.clear();
      }
      const used = byKey.get(key) ?? 0;
      if (used >= limits.perKey || total >= limits.total) return false;
      byKey.set(key, used + 1);
      total++;
      return true;
    },
  };
}

/** Render puts the client first in X-Forwarded-For. */
export function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

function id(c: Context): string {
  return c.req.param("id") ?? "";
}

function outcome(claim: ClaimRow): string {
  if (claim.status === "held" && claim.hold_reason === "unverified") return "Your claim is filed. It waits until your PayPal account is verified; nothing else is needed from you.";
  return "Your claim is filed. Claims are reviewed after the program closes, and approved claims are paid to the PayPal account you signed in with.";
}
