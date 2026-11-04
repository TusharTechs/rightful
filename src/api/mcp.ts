/**
 * The claimant MCP server at `/mcp`: how a person's AI assistant files a claim for them.
 *
 * An assistant can find open programs, file a claim, follow it, and fetch the payout receipt. It
 * cannot confirm a claim, decide one, or move money: there is no tool for any of that, and a test
 * pins the tool list. Every claim it files comes back `humanConfirmationRequired` with a link for
 * the person, who must sign in with PayPal and confirm; payment then goes only to that account.
 *
 * Stateless Streamable HTTP (a fresh server per request), JSON responses, the same filing path
 * and rate limit as `POST /api/programs/:id/claims`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { payoutProof, publicLedger } from "../claims/distribute.ts";
import { type ClaimRow, type ClaimsDeps, ClaimError, getClaim } from "../claims/service.ts";

/** The tools, and only these. Adding one that binds, decides or pays is a design change. */
export const MCP_TOOLS = ["list_programs", "get_program", "file_claim", "claim_status", "get_receipt"] as const;

type FormFields = { email: string; address: string; narrative: string; device: string };
type Filed = Record<string, unknown> & ({ error: "rate_limited"; message: string } | { bindUrl: string });

export type McpRoutes = {
  fileForAgent: (programId: string, form: FormFields, who: { ip: string; agentName?: string; base: string }) => Promise<Filed>;
  claimantView: (claim: ClaimRow) => Record<string, unknown>;
  programView: (programId: string) => Promise<Record<string, unknown>>;
  clientIp: (c: Context) => string;
  base: (c: Context) => string;
};

export function mountMcp(app: Hono, deps: ClaimsDeps, routes: McpRoutes) {
  app.all("/mcp", async (c) => {
    if (c.req.method === "GET" || c.req.method === "DELETE") {
      // Stateless: no server-to-client stream and no sessions to end.
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: POST JSON-RPC to /mcp" }, id: null }, 405);
    }
    const server = buildServer(deps, routes, { ip: routes.clientIp(c), base: routes.base(c) });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
}

function buildServer(deps: ClaimsDeps, routes: McpRoutes, who: { ip: string; base: string }): McpServer {
  const server = new McpServer(
    { name: "rightful-claims", version: "1.0.0" },
    {
      instructions:
        "File settlement and refund claims for the person you are helping. You can file and follow claims, but you can never confirm one or receive money: every claim waits until its person signs in with PayPal and confirms it, and any payment goes only to that PayPal account. Always give the person the bindUrl from file_claim. File one claim per person; never file for someone who has not asked you to.",
    },
  );
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });
  const refuse = (err: unknown) => {
    if (err instanceof ClaimError) return { isError: true, content: [{ type: "text" as const, text: `${err.code}: ${err.message}` }] };
    throw err;
  };

  server.registerTool(
    "list_programs",
    {
      title: "List open claims programs",
      description: "Settlement and refund programs that are open for claims now, with their pool, closing time and the eligibility statement claimants affirm.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await deps.db.query<{ id: string }>(
        `select id from programs where kind = 'live' and status = 'open' and closes_at > $1 order by closes_at limit 20`,
        [deps.now()],
      );
      return reply({ programs: await Promise.all(rows.map((row) => routes.programView(row.id))) });
    },
  );

  server.registerTool(
    "get_program",
    {
      title: "Get a claims program",
      description: "One program: status, pool, closing time, eligibility statement, and how many claims it has by status.",
      inputSchema: { programId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ programId }) => {
      try {
        return reply(await routes.programView(programId));
      } catch (err) {
        return refuse(err);
      }
    },
  );

  server.registerTool(
    "file_claim",
    {
      title: "File a claim for the person you are helping",
      description:
        "Files one claim. It starts unbound: send the returned bindUrl to the person, who signs in with PayPal and confirms it. Nothing is paid before that, and payment goes only to their PayPal account. Limited per network and program.",
      inputSchema: {
        programId: z.string().min(1).max(64),
        email: z.string().email().max(254).describe("The person's email address"),
        address: z.string().min(1).max(300).describe("The person's mailing address"),
        narrative: z.string().min(1).max(4000).describe("What happened, in the person's own words"),
        agentName: z.string().max(80).optional().describe("Your name as an assistant, shown to the program administrator"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    },
    async ({ programId, email, address, narrative, agentName }) => {
      try {
        const filed = await routes.fileForAgent(programId, { email, address, narrative, device: "" }, { ...who, agentName });
        if ("error" in filed) return { isError: true, content: [{ type: "text" as const, text: `${filed.error}: ${filed.message}` }] };
        return reply(filed);
      } catch (err) {
        return refuse(err);
      }
    },
  );

  server.registerTool(
    "claim_status",
    {
      title: "Check a claim",
      description: "Where a claim stands: unbound (waiting for its person), filed, held for review, approved, denied, paid or failed. No personal data.",
      inputSchema: { claimId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ claimId }) => {
      try {
        return reply(routes.claimantView(await getClaim(deps.db, claimId)));
      } catch (err) {
        return refuse(err);
      }
    },
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Get a payout receipt",
      description:
        "For a paid claim: its payout, the Merkle path to the program's published ledger root, and the digest PayPal carries on the payment's note. Anyone can check it at receiptUrl.",
      inputSchema: { claimId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ claimId }) => {
      try {
        const proof = await payoutProof(deps, claimId);
        const ledger = await publicLedger(deps, proof.programId);
        return reply({
          ...proof,
          paypalNote: ledger.paypal?.anchor ?? null,
          receiptUrl: `${(process.env.PUBLIC_WEB_URL ?? "https://rightful-web.onrender.com").replace(/\/$/, "")}/l/${proof.programId}?claim=${encodeURIComponent(claimId)}`,
        });
      } catch (err) {
        return refuse(err);
      }
    },
  );

  return server;
}
