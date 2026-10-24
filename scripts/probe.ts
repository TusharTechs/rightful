/**
 * Day-0 sandbox probes: find out what this PayPal sandbox app can actually do before any feature
 * depends on it.
 *
 *   npm run probe -- <name...>     names: token drand reporting webhooks payouts hold vault login jev
 *   npm run probe -- all
 *
 * Probes that need a buyer (hold, vault, login) print a link. Open it, sign in as one of your
 * sandbox *Personal* accounts, approve, and the probe continues. Results go to probes/out/
 * (gitignored) with emails and account IDs masked; tokens and secrets are never written.
 */

import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PayPalClient, PayPalError } from "../src/paypal/client.ts";
import {
  approvalLink,
  authorizeOrder,
  captureAuthorization,
  createHoldOrder,
  createVaultedHoldOrder,
  firstAuthorization,
  getAuthorization,
  getOrder,
  refundCapture,
  voidAuthorization,
} from "../src/paypal/orders.ts";
import { createPayPalSetupToken, createPaymentToken, deletePaymentToken } from "../src/paypal/vault.ts";
import { createPayoutBatch, getPayoutBatch } from "../src/paypal/payouts.ts";
import { listWebhooks, searchTransactions } from "../src/paypal/reporting.ts";
import { getUserInfo, isVerified, loginUrl } from "../src/paypal/identity.ts";
import { roundAtOrAfter, verifiedBeacon } from "../src/ballot/drand.ts";
import { draw } from "../src/ballot/draw.ts";
import { humanTag } from "../src/ballot/human.ts";
import { QUICKNET } from "../src/ballot/drand.ts";

type Finding = {
  probe: string;
  ok: boolean;
  at: string;
  summary: string;
  facts: Record<string, unknown>;
  error?: { status?: number; issue?: string; debugId?: string; message: string };
};

const PORT = Number(process.env.PROBE_PORT ?? 5174);
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = new URL("../probes/out/", import.meta.url);
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

const probes: Record<string, () => Promise<Omit<Finding, "probe" | "at">>> = {
  async token() {
    const scopes = await paypal().scopes();
    const has = (fragment: string) => scopes.some((scope) => scope.includes(fragment));
    return {
      ok: true,
      summary: `app token issued with ${scopes.length} scopes`,
      facts: {
        scopes,
        looksEnabled: {
          payouts: has("payments/payouts"),
          vault: has("vault"),
          transactionSearch: has("reporting/search"),
          identity: has("openid") || has("identity"),
          disputes: has("disputes"),
        },
      },
    };
  },

  async drand() {
    const round = roundAtOrAfter(new Date(Date.now() - 6000));
    const started = performance.now();
    const beacon = await verifiedBeacon(round);
    const fetchMs = Math.round(performance.now() - started);

    const secret = randomBytes(32);
    const entries = Array.from({ length: 10_000 }, (_, i) => ({
      entryId: `entry_${String(i).padStart(5, "0")}`,
      humanTag: humanTag(secret, "probe_ballot", `PAYER${i}`),
      quantity: 1 + (i % 2),
    }));
    const drawStarted = performance.now();
    const result = draw(
      { ballotId: "probe_ballot", inventory: 500, perHumanLimit: 2, allowPartial: false, round: beacon.round, chainHash: QUICKNET.hash },
      entries,
      beacon,
    );
    const drawMs = Math.round(performance.now() - drawStarted);
    return {
      ok: true,
      summary: `round ${beacon.round} verified in ${fetchMs} ms; drew 10,000 entries in ${drawMs} ms`,
      facts: { round: beacon.round, verifyAndFetchMs: fetchMs, drawMs, selectedUnits: result.selectedUnits, commitment: result.commitment.digest },
    };
  },

  async reporting() {
    const end = new Date();
    const start = new Date(end.getTime() - 2 * 24 * 3600 * 1000);
    const page = await searchTransactions(paypal(), { start, end, pageSize: 20 });
    return {
      ok: true,
      summary: `Transaction Search is on (${page.total_items ?? 0} transactions in the last 2 days)`,
      facts: { totalItems: page.total_items ?? 0 },
    };
  },

  async webhooks() {
    const hooks = await listWebhooks(paypal());
    return {
      ok: true,
      summary: hooks.length ? `${hooks.length} webhook(s) registered` : "no webhooks registered yet (expected on Day 0)",
      facts: { count: hooks.length, eventTypes: hooks.flatMap((hook) => hook.event_types.map((event) => event.name)) },
    };
  },

  async payouts() {
    const email = process.env.PAYPAL_SANDBOX_PAYOUT_EMAIL;
    if (!email) return skip("set PAYPAL_SANDBOX_PAYOUT_EMAIL to a sandbox Personal account");
    const venmo = process.env.PAYPAL_SANDBOX_VENMO_PHONE;
    const batchId = `probe-${randomUUID()}`;
    const batch = await createPayoutBatch(paypal(), {
      senderBatchId: batchId,
      emailSubject: "Firsthand sandbox probe",
      items: [
        { itemId: "probe-email", recipientType: "EMAIL", receiver: email, amountCents: 100, note: "Firsthand probe" },
        ...(venmo
          ? [{ itemId: "probe-venmo", recipientType: "PHONE" as const, receiver: venmo, wallet: "VENMO" as const, amountCents: 100, note: "Firsthand probe" }]
          : []),
      ],
    });
    await sleep(5000);
    const status = await getPayoutBatch(paypal(), batch.batch_header.payout_batch_id);
    return {
      ok: true,
      summary: `payout batch ${status.batch_header.batch_status}`,
      facts: {
        batchStatus: status.batch_header.batch_status,
        items: (status.items ?? []).map((item) => ({ id: item.payout_item?.sender_item_id, status: item.transaction_status })),
        venmoTried: Boolean(venmo),
      },
    };
  },

  async hold() {
    const client = paypal();
    const entryId = `probe_${randomUUID().slice(0, 8)}`;
    const order = await createHoldOrder(
      client,
      {
        referenceId: entryId,
        amountCents: 200,
        description: "Firsthand probe: approve a $2.00 hold (sandbox)",
        returnUrl: `${BASE}/return?probe=hold`,
        cancelUrl: `${BASE}/cancel?probe=hold`,
      },
      `hold-${entryId}`,
    );
    const link = approvalLink(order);
    if (!link) throw new Error(`order ${order.id} has no approval link`);
    const outcome = await waitForBuyer("Approve the $2.00 hold as a sandbox Personal buyer", link, ["/return", "/cancel"]);
    if (outcome.path === "/cancel") return { ok: false, summary: "buyer cancelled the approval", facts: {} };

    const approved = await getOrder(client, order.id);
    const authorized = await authorizeOrder(client, order.id, `authorize-${entryId}`);
    const authorization = firstAuthorization(authorized);
    if (!authorization) throw new Error("authorize returned no authorization");

    // Exercise every settlement path on one approval: capture part, void the rest, refund the capture.
    const capture = await captureAuthorization(client, authorization.id, { amountCents: 100, finalCapture: false }, `capture-${entryId}`);
    await voidAuthorization(client, authorization.id, `void-${entryId}`);
    const afterVoid = await getAuthorization(client, authorization.id);
    const refund = await refundCapture(client, capture.id, `refund-${entryId}`);

    const source = approved.payment_source?.paypal ?? authorized.payment_source?.paypal;
    return {
      ok: true,
      summary: `hold authorized → $1 captured → rest voided (${afterVoid.status}) → refunded (${refund.status}); buyer ${source?.account_status ?? "status unknown"}`,
      facts: {
        accountStatus: source?.account_status ?? null,
        accountIdPresent: Boolean(source?.account_id ?? approved.payer?.payer_id),
        accountId: mask(source?.account_id ?? approved.payer?.payer_id),
        authorizationStatus: authorization.status,
        authorizationExpires: authorization.expiration_time ?? null,
        captureStatus: capture.status,
        statusAfterVoid: afterVoid.status,
        refundStatus: refund.status,
      },
    };
  },

  async vault() {
    const client = paypal();
    const probeId = randomUUID().slice(0, 8);
    let setup;
    try {
      setup = await createPayPalSetupToken(
        client,
        {
          description: "Firsthand probe: let an agent place ballot holds for you (sandbox)",
          returnUrl: `${BASE}/return?probe=vault`,
          cancelUrl: `${BASE}/cancel?probe=vault`,
        },
        `setup-${probeId}`,
      );
    } catch (err) {
      if (err instanceof PayPalError) {
        return { ok: false, summary: `wallet vaulting refused: ${err.issue} (fallback: approve every hold)`, facts: {}, error: errorFacts(err) };
      }
      throw err;
    }
    const link = approvalLink(setup);
    if (!link) throw new Error(`setup token ${setup.id} has no approval link`);
    const outcome = await waitForBuyer("Approve saving PayPal for future ballot holds", link, ["/return", "/cancel"]);
    if (outcome.path === "/cancel") return { ok: false, summary: "buyer cancelled vault approval", facts: {} };

    const token = await createPaymentToken(client, setup.id, `token-${probeId}`);
    const order = await createVaultedHoldOrder(
      client,
      { referenceId: `probe_${probeId}`, amountCents: 100, description: "Firsthand probe: buyer-not-present hold", vaultId: token.id },
      `vaulted-hold-${probeId}`,
    );
    const authorization = firstAuthorization(order);
    if (authorization) await voidAuthorization(client, authorization.id, `vaulted-void-${probeId}`);
    await deletePaymentToken(client, token.id).catch(() => undefined);
    return {
      ok: Boolean(authorization),
      summary: authorization
        ? `buyer-not-present hold works (order ${order.status}, auth ${authorization.status}, then voided)`
        : `vaulted order came back ${order.status} without an authorization`,
      facts: { orderStatus: order.status, authorizationStatus: authorization?.status ?? null },
    };
  },

  async login() {
    const client = paypal();
    const redirectUri = process.env.PAYPAL_LIPP_REDIRECT_URI ?? `${BASE}/callback`;
    const state = randomUUID();
    const link = loginUrl({ clientId: client.clientId, redirectUri, state });
    const outcome = await waitForBuyer("Log in with PayPal as a sandbox Personal buyer", link, [new URL(redirectUri).pathname]);
    const params = outcome.query;
    if (params.get("error")) {
      return { ok: false, summary: `Log in with PayPal returned ${params.get("error")}`, facts: { error: params.get("error"), description: params.get("error_description") } };
    }
    if (params.get("state") !== state) throw new Error("state mismatch on Log in with PayPal callback");
    const code = params.get("code");
    if (!code) throw new Error("no authorization code on callback");
    const userToken = await client.userTokenFromCode(code);
    const info = await getUserInfo(client, userToken);
    return {
      ok: true,
      summary: `Log in with PayPal works; verified_account=${String(info.verified_account)}`,
      facts: { verified: isVerified(info), payerIdPresent: Boolean(info.payer_id), attributesReturned: Object.keys(info).sort() },
    };
  },

  async jev() {
    if (!process.env.TYPESAFE_API_KEY) return skip("set TYPESAFE_API_KEY to try System-1 screening");
    const { TypeSafeClient, choice, noul } = await import("@typesafe-ai/sdk");
    const client = new TypeSafeClient();
    const started = performance.now();
    const response = await client.systemOne({
      state: {
        entry: {
          paypalAccountStatus: "VERIFIED",
          accountsSharingThisDevice: 14,
          entriesFromThisIpInLastMinute: 37,
          secondsFromPageLoadToSubmit: 0.8,
          userAgent: "HeadlessChrome/131",
        },
      },
      questions: {
        human: noul("Is this ballot entry most likely made by one real person acting for themselves?"),
        route: choice("What should the gate do with this entry?", { admit: null, challenge: null, investigate: null }),
      },
    });
    const ms = Math.round(performance.now() - started);
    return { ok: true, summary: `Jev answered in ${ms} ms`, facts: { latencyMs: ms, answers: response.answers } };
  },
};

const ORDER = ["token", "drand", "reporting", "webhooks", "payouts", "hold", "vault", "login", "jev"];

async function main() {
  const requested = process.argv.slice(2).filter((arg) => arg !== "--");
  const names = requested.length === 0 || requested.includes("all") ? ORDER : requested;
  const unknown = names.filter((name) => !(name in probes));
  if (unknown.length) {
    console.error(`unknown probe(s): ${unknown.join(", ")}. Known: ${ORDER.join(", ")}, all`);
    process.exit(2);
  }

  const findings: Finding[] = [];
  for (const name of names) {
    process.stdout.write(`\n▶ ${name}\n`);
    const at = new Date().toISOString();
    try {
      const finding = { probe: name, at, ...(await probes[name]!()) };
      findings.push(finding);
      console.log(`  ${finding.ok ? "✓" : "✗"} ${finding.summary}`);
    } catch (err) {
      const finding: Finding = {
        probe: name,
        at,
        ok: false,
        summary: err instanceof Error ? err.message : String(err),
        facts: {},
        error: errorFacts(err),
      };
      findings.push(finding);
      console.log(`  ✗ ${finding.summary}${finding.error?.debugId ? ` (debug_id ${finding.error.debugId})` : ""}`);
    }
  }
  server?.close();
  await record(findings);

  console.log("\nSummary");
  for (const finding of findings) console.log(`  ${finding.ok ? "✓" : "✗"} ${finding.probe.padEnd(10)} ${finding.summary}`);
  console.log(`\nSaved to probes/out/results.json`);
}

let client: PayPalClient | undefined;
function paypal(): PayPalClient {
  client ??= PayPalClient.fromEnv();
  return client;
}

function skip(reason: string): Omit<Finding, "probe" | "at"> {
  return { ok: false, summary: `skipped: ${reason}`, facts: { skipped: true } };
}

function errorFacts(err: unknown): Finding["error"] {
  if (err instanceof PayPalError) return { status: err.status, issue: err.issue, debugId: err.debugId, message: err.message };
  return { message: err instanceof Error ? err.message : String(err) };
}

/** Keeps the first 4 characters of an identifier so runs can be told apart without storing it. */
function mask(value: string | undefined): string | null {
  return value ? `${value.slice(0, 4)}…` : null;
}

async function record(findings: Finding[]) {
  await mkdir(OUT_DIR, { recursive: true });
  const file = new URL("results.json", OUT_DIR);
  const previous: Finding[] = await readFile(file, "utf8").then(JSON.parse, () => []);
  await writeFile(file, JSON.stringify([...previous, ...findings], null, 2) + "\n");
}

let server: Server | undefined;
const waiters = new Map<string, (hit: { path: string; query: URLSearchParams }) => void>();

/** Prints a link for the human, then waits until the browser lands on one of `paths`. */
function waitForBuyer(instruction: string, link: string, paths: string[]): Promise<{ path: string; query: URLSearchParams }> {
  server ??= createServer((req, res) => {
    const url = new URL(req.url ?? "/", BASE);
    const resolve = waiters.get(url.pathname);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      resolve
        ? "<p style='font:16px system-ui'>Done. You can close this tab and go back to the terminal.</p>"
        : "<p style='font:16px system-ui'>No probe is waiting here.</p>",
    );
    if (resolve) {
      for (const path of paths) waiters.delete(path);
      resolve({ path: url.pathname, query: url.searchParams });
    }
  }).listen(PORT);

  console.log(`  → ${instruction}:\n    ${link}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      for (const path of paths) waiters.delete(path);
      reject(new Error(`no browser callback within ${APPROVAL_TIMEOUT_MS / 60000} minutes`));
    }, APPROVAL_TIMEOUT_MS);
    for (const path of paths) {
      waiters.set(path, (hit) => {
        clearTimeout(timer);
        resolve(hit);
      });
    }
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
