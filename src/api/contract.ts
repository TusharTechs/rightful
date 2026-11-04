/**
 * The public API's contract, in one place: the MCP tools take their input schemas from here, and
 * `/openapi.json` (OpenAPI 3.1) is generated from the same schemas. `test/openapi.test.ts` checks
 * that every documented route exists and that real responses match their schemas.
 */

import { z } from "zod";

/** The named schemas: each becomes `#/components/schemas/<id>`. */
export const schemas = z.registry<{ id: string; description?: string }>();

export const ProgramId = z.string().min(1).max(64).describe("A program ID, e.g. prg_7Gj9VD1w1pfaBqZ_");
export const ClaimId = z.string().min(1).max(64).describe("A claim ID, e.g. clm_n1bJwZ5ALKjI0c_K. It is also the claimant's capability to follow the claim.");

/** What an agent sends to file a claim for a person (the same fields as MCP `file_claim`). */
export const FileClaimFields = {
  email: z.string().email().max(254).describe("The person's email address"),
  address: z.string().min(1).max(300).describe("The person's mailing address"),
  narrative: z.string().min(1).max(4000).describe("What happened, in the person's own words"),
  agentName: z.string().max(80).optional().describe("Your name as an assistant, shown to the program administrator"),
};
export const FileClaimInput = z.object(FileClaimFields).register(schemas, { id: "FileClaimInput" });

export const AppealInput = z
  .object({ message: z.string().min(10).max(1000).describe("What the reviewer should know, in the claimant's own words") })
  .register(schemas, { id: "AppealInput" });

const Status = z.enum(["unbound", "filed", "held", "approved", "denied", "paid", "failed"]);

export const ClaimStatus = z
  .object({
    id: ClaimId,
    programId: ProgramId,
    status: Status.describe("unbound: waiting for its person to sign in with PayPal and confirm; held: waiting for a person to review"),
    holdReason: z.enum(["unverified", "review"]).nullable(),
    filedVia: z.enum(["web", "agent"]),
    bound: z.boolean().describe("Tied to the PayPal account that signed in; only that account can be paid"),
    amountCents: z.number().int().nullable(),
    filedAt: z.string().describe("ISO 8601"),
    appealed: z.boolean().describe("The claimant asked a person to look again"),
  })
  .register(schemas, { id: "ClaimStatus", description: "A claim as its claimant (or their agent) may see it: no personal data, no PayPal identifiers." });

export const FiledClaim = ClaimStatus.extend({
  humanConfirmationRequired: z.literal(true),
  bindUrl: z.string().describe("Send this to the person: they sign in with PayPal and confirm the claim"),
  next: z.string(),
}).register(schemas, { id: "FiledClaim" });

export const ClaimWithProgram = ClaimStatus.extend({
  program: z.object({ id: ProgramId, title: z.string(), status: z.enum(["open", "review", "distributing", "done"]), closesAt: z.string(), kind: z.enum(["live", "demo"]) }),
}).register(schemas, { id: "ClaimWithProgram" });

export const Program = z
  .object({
    id: ProgramId,
    title: z.string(),
    kind: z.enum(["live", "demo"]),
    status: z.enum(["open", "review", "distributing", "done"]),
    poolCents: z.number().int(),
    currency: z.string(),
    requireVerified: z.boolean(),
    sampleText: z.string().describe("The eligibility statement claimants affirm"),
    closesAt: z.string(),
    shareCents: z.number().int().nullable(),
    commitment: z.string().nullable().describe("The ledger digest, once committed"),
    auditRound: z.number().int().nullable(),
    claims: z.record(z.string(), z.number().int()).describe("Claim counts by status"),
  })
  .register(schemas, { id: "Program" });

const Leaf = z.object({ claimId: ClaimId, humanTag: z.string().describe("Per-program pseudonym, not a PayPal ID"), amountCents: z.number().int() });

export const Receipt = z
  .object({
    programId: ProgramId,
    root: z.string(),
    payout: Leaf,
    proof: z.object({ leaf: z.string(), path: z.array(z.object({ sibling: z.string(), side: z.enum(["left", "right"]) })) }),
  })
  .register(schemas, { id: "Receipt", description: "A claimant's payout and its Merkle path to the published root." });

export const Ledger = z
  .object({
    terms: z.object({ programId: ProgramId, poolCents: z.number().int(), currency: z.string(), shareCents: z.number().int(), auditRound: z.number().int(), auditSize: z.number().int(), chainHash: z.string() }),
    commitment: z.object({ root: z.string(), payoutCount: z.number().int(), digest: z.string() }),
    payouts: z.array(Leaf),
    audit: z.object({ round: z.number().int(), randomness: z.string(), signature: z.string(), sample: z.array(ClaimId) }).nullable(),
    reconciliation: z.object({ state: z.enum(["pending", "agrees", "disagrees", "incomplete"]) }).loose().nullable().describe("PayPal's transaction history checked against the paid claims"),
    paypal: z.object({ anchor: z.string(), batches: z.array(z.object({ batchId: z.string() }).loose()) }).nullable().describe("What PayPal's own records of each batch carry; null for demo programs"),
    delivery: z
      .object({
        delivered: z.number().int(),
        waiting: z.array(z.object({ claimId: ClaimId, status: z.string() })),
        notDelivered: z.array(z.object({ claimId: ClaimId, status: z.string() })),
        notDeliveredCents: z.number().int(),
        remainderCents: z.number().int(),
        notifications: z.object({ count: z.number().int(), lastAt: z.string().nullable(), types: z.record(z.string(), z.number().int()) }).nullable(),
      })
      .describe("Where every committed payout ended up, as PayPal reported it"),
  })
  .register(schemas, { id: "Ledger", description: "Everything anyone needs to check a distribution. No payer IDs, no personal data." });

export const ApiError = z
  .object({ error: z.string().describe("not_found, closed, wrong_state, duplicate, invalid, unauthorized, rate_limited, paypal or internal"), message: z.string().optional() })
  .register(schemas, { id: "Error" });

type Op = {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: ("program" | "claim")[];
  body?: z.ZodType;
  ok: { status: number; schema: z.ZodType; description: string };
  errors?: number[];
  admin?: boolean;
};

/** Every documented route. The test requests each one, so a route renamed here or there fails CI. */
export const OPERATIONS: Record<string, Partial<Record<"get" | "post", Op>>> = {
  "/api/programs": {
    get: { operationId: "listPrograms", summary: "List live programs", tags: ["public"], ok: { status: 200, schema: z.array(Program), description: "Up to 20 live programs, newest first" } },
  },
  "/api/programs/{programId}": {
    get: { operationId: "getProgram", summary: "Get a program", tags: ["public"], params: ["program"], ok: { status: 200, schema: Program, description: "The program and its claim counts" }, errors: [404] },
  },
  "/api/programs/{programId}/claims": {
    post: { operationId: "fileClaim",
      summary: "File a claim for a person (agents)",
      description:
        "Files one unbound claim and returns a bindUrl for the person. Nothing is paid until they sign in with PayPal and confirm it, and payment goes only to that account. Limited to 30 unconfirmed claims per /24 network per program per hour (the same limit as MCP file_claim).",
      tags: ["agents"],
      params: ["program"],
      body: FileClaimInput,
      ok: { status: 201, schema: FiledClaim, description: "Filed, waiting for its person" },
      errors: [400, 404, 409, 429],
    },
  },
  "/api/claims/{claimId}": {
    get: { operationId: "getClaim", summary: "Where a claim stands", tags: ["public", "agents"], params: ["claim"], ok: { status: 200, schema: ClaimWithProgram, description: "The claim and its program" }, errors: [404] },
  },
  "/api/claims/{claimId}/appeal": {
    post: { operationId: "appealClaim",
      summary: "Ask a person to look again at a held claim",
      description: "Once per claim. It decides nothing by itself: the claim stays held until the administrator decides its group.",
      tags: ["public"],
      params: ["claim"],
      body: AppealInput,
      ok: { status: 200, schema: ClaimStatus, description: "Recorded" },
      errors: [400, 404, 409],
    },
  },
  "/api/claims/{claimId}/proof": {
    get: { operationId: "getReceipt", summary: "A paid claim's receipt", tags: ["public", "agents"], params: ["claim"], ok: { status: 200, schema: Receipt, description: "The payout and its Merkle path" }, errors: [404, 409] },
  },
  "/api/programs/{programId}/ledger": {
    get: { operationId: "getLedger", summary: "A program's public payout ledger", tags: ["public"], params: ["program"], ok: { status: 200, schema: Ledger, description: "Commitment, payouts, audit, PayPal's records and delivery" }, errors: [404, 409] },
  },
  "/api/programs/{programId}/review": {
    post: { operationId: "reviewProgram", summary: "Review a program: hold rings and unverified accounts, approve the rest", tags: ["organizer"], params: ["program"], admin: true, ok: { status: 200, schema: z.object({}).loose(), description: "Review report with ring investigation" }, errors: [401, 409] },
  },
  "/api/programs/{programId}/distribute": {
    post: { operationId: "distributeProgram",
      summary: "Commit the ledger, then pay by PayPal Payouts",
      description: "Refused while any suspected ring is undecided, or (live programs) if the PayPal balance cannot fund every share.",
      tags: ["organizer"],
      params: ["program"],
      admin: true,
      ok: { status: 200, schema: z.object({}).loose(), description: "Share, claims, remainder and batches" },
      errors: [401, 409, 502],
    },
  },
};

/** The OpenAPI 3.1 document for an API served at `server`. */
export function openApiDocument(server: string) {
  const options = { target: "draft-2020-12", io: "output", unrepresentable: "any" } as const;
  const named = z.toJSONSchema(schemas, { ...options, uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, Record<string, unknown>> };
  const schema = (s: z.ZodType): Record<string, unknown> => {
    const id = schemas.get(s)?.id;
    if (id) return { $ref: `#/components/schemas/${id}` };
    if (s instanceof z.ZodArray) return { type: "array", items: schema(s.element as z.ZodType) };
    return clean(z.toJSONSchema(s, options) as Record<string, unknown>);
  };
  const params = {
    program: { name: "programId", in: "path", required: true, schema: schema(ProgramId) },
    claim: { name: "claimId", in: "path", required: true, schema: schema(ClaimId) },
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, ops] of Object.entries(OPERATIONS)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(ops)) {
      paths[path]![method] = {
        operationId: op.operationId,
        summary: op.summary,
        ...(op.description ? { description: op.description } : {}),
        tags: op.tags,
        ...(op.params ? { parameters: op.params.map((p) => params[p]) } : {}),
        ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(op.body) } } } } : {}),
        security: op.admin ? [{ admin: [] }] : [],
        responses: {
          [op.ok.status]: { description: op.ok.description, content: { "application/json": { schema: schema(op.ok.schema) } } },
          ...Object.fromEntries((op.errors ?? []).map((code) => [code, { description: ERROR_TEXT[code] ?? "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }])),
        },
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Rightful API",
      version: "1.0.0",
      summary: "Settlement and refund claims that claim farms cannot drain. PayPal sandbox only.",
      description:
        "Agents can file and follow claims; only the person, signing in with PayPal, can confirm one, and payment goes only to that PayPal account. The same filing path is also an MCP server at /mcp. Organizer routes need the admin token (or a demo program's console token).",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: server }],
    tags: [
      { name: "public", description: "Anyone: programs, claim status, receipts and ledgers" },
      { name: "agents", description: "Assistants filing for a person; never confirm, decide or pay" },
      { name: "organizer", description: "Program administrators" },
    ],
    paths,
    components: {
      schemas: Object.fromEntries(Object.entries(named.schemas).map(([id, s]) => [id, clean(s)])),
      securitySchemes: { admin: { type: "http", scheme: "bearer", description: "ADMIN_TOKEN, or a demo program's console token" } },
    },
  };
}

const ERROR_TEXT: Record<number, string> = {
  400: "Invalid input",
  401: "Missing or wrong token",
  404: "No such program or claim",
  409: "Not possible in the current state (closed, duplicate, already done)",
  429: "Rate limited",
  502: "PayPal refused or failed",
};

/** OpenAPI embeds JSON Schema without `$schema`, `$id` or `id`. */
function clean(s: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, $id: _uri, id: _id, ...rest } = s;
  return rest;
}
