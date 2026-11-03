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
  bindClaim,
  createProgram,
  decideClaims,
  fileClaim,
  getClaim,
  getProgram,
  passAfterLogin,
  reviewProgram,
} from "../claims/service.ts";
import { distributeProgram, payoutProof, publicLedger, syncPayouts } from "../claims/distribute.ts";
import type { LoginIntent } from "./login.ts";

const BIND_COOKIE = "rf_bind";
const BIND_TTL_S = 30 * 60;

export type ClaimRoutesOptions = {
  admin: MiddlewareHandler;
  /** The API's public origin, for links handed to agents. Defaults to the request's origin. */
  publicBase?: string;
};

export function mountClaims(app: Hono, deps: ClaimsDeps, options: ClaimRoutesOptions) {
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

  app.post("/api/programs/:id/review", options.admin, async (c) => {
    const report = await reviewProgram(deps, id(c), { early: c.req.query("early") === "1" });
    return c.json(report);
  });

  app.post("/api/programs/:id/distribute", options.admin, async (c) => c.json(await distributeProgram(deps, id(c))));

  app.post("/api/programs/:id/sync", options.admin, async (c) => c.json(await syncPayouts(deps, id(c))));

  app.get("/api/programs/:id/claims", options.admin, async (c) => {
    await getProgram(deps.db, id(c));
    const rows = await deps.db.query<ClaimRow>(`select * from claims where program_id = $1 order by filed_at, id`, [id(c)]);
    return c.json(rows.map(adminView));
  });

  app.post("/api/programs/:id/decisions", options.admin, async (c) => {
    const body = await c.req.json<{ ringId?: string; claimIds?: string[]; decision?: string }>();
    if (body.decision !== "approve" && body.decision !== "deny") throw new ClaimError("decision must be approve or deny", "invalid");
    const selection = body.ringId ? { ringId: body.ringId } : { claimIds: (body.claimIds ?? []).map(String) };
    return c.json({ changed: await decideClaims(deps, id(c), selection, body.decision) });
  });

  // --- public and agents -----------------------------------------------------------------------

  app.get("/api/programs/:id", async (c) => c.json(await programView(deps, id(c))));

  app.post("/api/programs/:id/claims", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const form = formOf(body);
    if (typeof body.pass === "string") {
      const { claim } = await fileClaim(deps, id(c), form, { via: "web", pass: body.pass, ip: clientIp(c) });
      return c.json(claimantView(claim), 201);
    }
    const { claim, bindCode } = await fileClaim(deps, id(c), form, { via: "agent", ip: clientIp(c) });
    const bindUrl = `${base(c)}/claim/bind?claim=${encodeURIComponent(claim.id)}&code=${encodeURIComponent(bindCode!)}`;
    return c.json({ ...claimantView(claim), bindUrl, next: "Send bindUrl to the person this claim is for. It is paid only after they sign in with PayPal and confirm it." }, 201);
  });

  app.get("/api/claims/:id", async (c) => c.json(claimantView(await getClaim(deps.db, id(c)))));

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
        return c.html(page("Claim confirmed", `${outcome(claim)} It was filed for you and is now tied to your PayPal account.`, claim.id));
      }
      const { claim } = await fileClaim(deps, body.program ?? "", formOf(body), { via: "web", pass: body.pass ?? "", ip: clientIp(c) });
      return c.html(page("Claim filed", outcome(claim), claim.id), 201);
    } catch (err) {
      if (err instanceof ClaimError) return c.html(page("Claim not filed", err.message), err.code === "not_found" ? 404 : 400);
      throw err;
    }
  });
}

/** What Log in with PayPal does when the sign-in was for a claim. */
export function claimantAfterLogin(deps: ClaimsDeps) {
  return async (c: Context, intent: LoginIntent, info: UserInfo): Promise<Response> => {
    const payerId = typeof info.payer_id === "string" ? info.payer_id : "";
    if (!payerId) return c.html(page("Sign-in incomplete", "PayPal did not share your account ID, so a payout could not be tied to you. Please try again."), 502);
    try {
      const program = await getProgram(deps.db, intent.program);
      if (program.status !== "open" || deps.now() >= program.closes_at) return c.html(page(program.title, "This program is closed to new claims."), 409);
      const pass = passAfterLogin(deps, program.id, payerId, isVerified(info));
      const note = isVerified(info) ? "" : `<p><strong>PayPal says this account is not verified.</strong> You can still file; the claim will wait until you verify your PayPal account.</p>`;
      if (intent.claim) {
        const claim = await getClaim(deps.db, intent.claim);
        if (claim.program_id !== program.id || claim.status !== "unbound") return c.html(page(program.title, "This claim is already confirmed, or it belongs to another program."), 409);
        return c.html(shell(program.title, `<h1>Is this your claim?</h1>
<p>Someone (or an assistant) filed this claim for you. Check it before you confirm: once confirmed, it is your one claim in this program and any payment goes to the PayPal account you just signed in with.</p>${note}
<dl><dt>Email</dt><dd>${escape(claim.email)}</dd><dt>Address</dt><dd>${escape(claim.address)}</dd><dt>What happened</dt><dd>${escape(claim.narrative)}</dd></dl>
<form method="post" action="/claim/submit"><input type="hidden" name="pass" value="${escape(pass)}"><input type="hidden" name="claim" value="${escape(claim.id)}">
<button>Yes, this is my claim</button></form>`));
      }
      return c.html(shell(program.title, `<h1>${escape(program.title)}</h1>
<p>Signed in with PayPal. One claim per PayPal account; any payment goes to this account.</p>${note}
<form method="post" action="/claim/submit"><input type="hidden" name="pass" value="${escape(pass)}"><input type="hidden" name="program" value="${escape(program.id)}"><input type="hidden" name="device" id="device">
<label>Email<br><input name="email" type="email" required maxlength="254"></label>
<label>Mailing address<br><input name="address" required maxlength="300"></label>
<label>What happened<br><textarea name="narrative" required maxlength="4000" rows="6" placeholder="${escape(program.sample_text)}"></textarea></label>
<button>File my claim</button></form>
<script>${DEVICE_SCRIPT}</script>`));
    } catch (err) {
      if (err instanceof ClaimError) return c.html(page("Claim", err.message), 404);
      throw err;
    }
  };
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
function claimantView(claim: ClaimRow) {
  return {
    id: claim.id,
    programId: claim.program_id,
    status: claim.status,
    holdReason: claim.hold_reason === "unverified" ? "unverified" : claim.hold_reason ? "review" : null,
    filedVia: claim.filed_via,
    bound: claim.human_tag !== null,
    amountCents: claim.amount_cents,
    filedAt: claim.filed_at,
  };
}

/** The organizer's view: the evidence, the pseudonym, never the payer ID. */
function adminView(claim: ClaimRow) {
  const { payee_sealed: _payee, bind_code_hash: _code, ...rest } = claim;
  return rest;
}

function formOf(body: Record<string, unknown>) {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return { email: s(body.email), address: s(body.address), narrative: s(body.narrative), device: s(body.device) };
}

/** Render puts the client first in X-Forwarded-For. */
function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

function id(c: Context): string {
  return c.req.param("id") ?? "";
}

function outcome(claim: ClaimRow): string {
  if (claim.status === "held" && claim.hold_reason === "unverified") return "Your claim is filed, and waits until your PayPal account is verified.";
  return "Your claim is filed. Claims are reviewed after the program closes; approved claims are paid to your PayPal account.";
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}
label{display:block;margin:1rem 0}input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:.5rem}button{font:inherit;padding:.6rem 1.2rem;margin-top:1rem}
dt{font-weight:600;margin-top:.8rem}dd{margin:0;white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

function page(title: string, message: string, claimId?: string): string {
  return shell(title, `<h1 style="font-size:1.4rem">${escape(title)}</h1><p>${escape(message)}</p>${claimId ? `<p style="color:#555;font-size:.9rem">Claim <code>${escape(claimId)}</code></p>` : ""}`);
}
