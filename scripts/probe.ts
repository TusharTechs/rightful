/**
 * Day-0 sandbox probes: find out what this PayPal sandbox app can actually do before any feature
 * depends on it.
 *
 *   npm run probe -- <name...>     names: token drand reporting webhooks payouts payout-id login jev
 *   npm run probe -- all
 *
 * The login probe prints a link. Open it, sign in as one of your
 * sandbox *Personal* accounts, approve, and the probe continues. Results go to probes/out/
 * (gitignored) with emails and account IDs masked; tokens and secrets are never written.
 */

import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PayPalClient, PayPalError } from "../src/paypal/client.ts";
import { createPayoutBatch, getPayoutBatch } from "../src/paypal/payouts.ts";
import { listWebhooks, searchTransactions } from "../src/paypal/reporting.ts";
import { getUserInfo, isVerified, loginUrl } from "../src/paypal/identity.ts";
import { auditSample, auditSizeFor, commitDistribution } from "../src/claims/ledger.ts";
import { QUICKNET, roundAtOrAfter, verifiedBeacon } from "../src/engine/drand.ts";
import { humanTag } from "../src/engine/human.ts";

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
          // Legacy card-vault scopes are always present; wallet vaulting needs the payment-tokens scope.
          vault: has("vault/payment-tokens"),
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
    const payouts = Array.from({ length: 10_000 }, (_, i) => ({
      claimId: `clm_${String(i).padStart(8, "0")}`,
      humanTag: humanTag(secret, "prg_probe", `PAYER${i}`),
      amountCents: 1000,
    }));
    const terms = {
      programId: "prg_probe",
      poolCents: 10_000_000,
      currency: "USD",
      shareCents: 1000,
      auditRound: beacon.round,
      auditSize: auditSizeFor(payouts.length),
      chainHash: QUICKNET.hash,
    };
    const ledgerStarted = performance.now();
    const commitment = commitDistribution(terms, payouts);
    const sample = auditSample(terms, payouts, beacon);
    const ledgerMs = Math.round(performance.now() - ledgerStarted);
    return {
      ok: true,
      summary: `round ${beacon.round} verified in ${fetchMs} ms; committed 10,000 payouts and drew a ${sample.length}-claim audit in ${ledgerMs} ms`,
      facts: { round: beacon.round, verifyAndFetchMs: fetchMs, ledgerMs, auditSize: sample.length, commitment: commitment.digest },
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
      emailSubject: "Rightful sandbox probe",
      items: [
        { itemId: "probe-email", recipientType: "EMAIL", receiver: email, amountCents: 100, note: "Rightful probe" },
        ...(venmo
          ? [{ itemId: "probe-venmo", recipientType: "PHONE" as const, receiver: venmo, wallet: "VENMO" as const, amountCents: 100, note: "Rightful probe" }]
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

  /**
   * Pays a sandbox buyer by their PayPal account ID (recipient_type PAYPAL_ID), the way a payout is
   * bound to the exact account that signed in. The ID comes from a past purchase in Transaction
   * Search, then the item is followed to a final state.
   */
  async "payout-id"() {
    const client = paypal();
    const end = new Date();
    const page = await searchTransactions(client, { start: new Date(end.getTime() - 30 * 24 * 3600 * 1000), end, pageSize: 100 });
    const payerId = page.transaction_details?.map((t) => t.payer_info?.account_id).find((id): id is string => Boolean(id));
    if (!payerId) return skip("no sandbox purchase with a payer ID in the last 30 days; run the hold probe first");

    const batch = await createPayoutBatch(client, {
      senderBatchId: `probe-id-${randomUUID()}`,
      emailSubject: "Rightful sandbox probe",
      items: [{ itemId: "probe-paypal-id", recipientType: "PAYPAL_ID", receiver: payerId, amountCents: 100, note: "Rightful probe" }],
    });
    const FINAL = new Set(["SUCCESS", "UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"]);
    let status = await getPayoutBatch(client, batch.batch_header.payout_batch_id);
    for (let i = 0; i < 24 && !FINAL.has(status.items?.[0]?.transaction_status ?? ""); i++) {
      await sleep(5000);
      status = await getPayoutBatch(client, batch.batch_header.payout_batch_id);
    }
    const item = status.items?.[0]?.transaction_status ?? "unknown";
    return {
      ok: item === "SUCCESS",
      summary: `PAYPAL_ID payout to ${mask(payerId)}: batch ${status.batch_header.batch_status}, item ${item}`,
      facts: { recipient: mask(payerId), batchStatus: status.batch_header.batch_status, itemStatus: item },
    };
  },

  async login() {
    const client = paypal();
    const redirectUri = process.env.PAYPAL_LIPP_REDIRECT_URI || `${BASE}/callback`;
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
    if (!process.env.TYPESAFE_API_KEY) return skip("set TYPESAFE_API_KEY to try System One screening");
    const { TypeSafeClient, choice, noul } = await import("@typesafe-ai/sdk");
    const client = new TypeSafeClient();
    const started = performance.now();
    const response = await client.systemOne({
      state: {
        claim: {
          paypalAccountStatus: "VERIFIED",
          accountsSharingThisDevice: 14,
          claimsFromThisIpInLastMinute: 37,
          secondsFromPageLoadToSubmit: 0.8,
          userAgent: "HeadlessChrome/131",
        },
      },
      questions: {
        human: noul("Is this claim most likely filed by one real person acting for themselves?"),
        route: choice("What should review do with this claim?", { approve: null, challenge: null, investigate: null }),
      },
    });
    const ms = Math.round(performance.now() - started);
    return { ok: true, summary: `Jev answered in ${ms} ms`, facts: { latencyMs: ms, answers: response.answers } };
  },
};

const ORDER = ["token", "drand", "reporting", "webhooks", "payouts", "payout-id", "login", "jev"];

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
