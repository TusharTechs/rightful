/**
 * A real ballot, end to end, on the PayPal sandbox:
 *
 *   npm run demo:ballot -- [entries=3] [inventory=2]
 *
 * It starts the API, opens a ballot, and prints one approval link per entry. Approve each with a
 * different sandbox Personal account (a private window per link makes switching easy; reuse an
 * account once to watch the duplicate get released). Then it seals the list, waits for the drand
 * round, draws, settles, reads every hold back from PayPal, and re-verifies the draw from the
 * public proof. A summary without PayPal identifiers is written to probes/out/demo-ballot.json.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { startServer } from "../src/api/main.ts";
import { verifiedBeacon } from "../src/ballot/drand.ts";
import { verifyDraw } from "../src/ballot/draw.ts";
import type { PublicProof } from "../src/ballots/service.ts";

const entriesWanted = Number(process.argv[2] ?? 3);
const inventory = Number(process.argv[3] ?? 2);
const APPROVAL_WINDOW_MS = 10 * 60_000;

const env = { ...process.env, PORT: process.env.DEMO_PORT ?? "8787", DATABASE_URL: "", PGLITE_DIR: "" };
const server = await startServer(env);
const api = async <T>(path: string, init: RequestInit = {}, admin = false): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${server.url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${server.adminToken}` } : {}) },
  });
  return { status: response.status, body: (await response.json()) as T };
};

try {
  const { body: ballot } = await api<{ id: string; title: string }>(
    "/api/ballots",
    {
      method: "POST",
      body: JSON.stringify({
        title: `Firsthand demo: ${inventory} seats`,
        priceCents: 2500,
        inventory,
        perHumanLimit: 1,
        maxQuantity: 1,
        closesInSeconds: APPROVAL_WINDOW_MS / 1000 + 60,
      }),
    },
    true,
  );
  console.log(`\nBallot ${ballot.id}: "${ballot.title}", $25.00 each, one per verified human.\n`);

  const entryIds: string[] = [];
  for (let i = 1; i <= entriesWanted; i++) {
    const { body } = await api<{ entryId: string; approveUrl: string }>(`/api/ballots/${ballot.id}/entries`, {
      method: "POST",
      body: JSON.stringify({ quantity: 1 }),
    });
    entryIds.push(body.entryId);
    console.log(`Fan ${i}: approve a $25.00 hold (charged only if selected):\n  ${body.approveUrl}\n`);
  }

  console.log(`Waiting up to ${APPROVAL_WINDOW_MS / 60000} minutes for approvals…`);
  const deadline = Date.now() + APPROVAL_WINDOW_MS;
  const settledEntryStates = new Set(["held", "rejected", "cancelled"]);
  const seen = new Map<string, string>();
  while (Date.now() < deadline) {
    for (const id of entryIds) {
      const { body } = await api<{ status: string; rejection: string | null }>(`/api/entries/${id}`);
      const label = body.rejection ? `${body.status} (${body.rejection})` : body.status;
      if (seen.get(id) !== label) {
        seen.set(id, label);
        if (body.status !== "awaiting_approval") console.log(`  ${id}: ${label}`);
      }
    }
    if ([...seen.values()].every((label) => settledEntryStates.has(label.split(" ")[0]!))) break;
    await sleep(2000);
  }

  const sealed = await api<{ drawRound: number; drawAt: string; commitment: string }>(`/api/ballots/${ballot.id}/seal?early=1`, { method: "POST" }, true);
  console.log(`\nSealed. Commitment ${sealed.body.commitment.slice(0, 16)}… binds the list to drand round ${sealed.body.drawRound} (${sealed.body.drawAt}).`);
  const wait = new Date(sealed.body.drawAt).getTime() - Date.now() + 1500;
  if (wait > 0) {
    console.log(`Waiting ${Math.ceil(wait / 1000)} s for that round to be published…`);
    await sleep(wait);
  }

  let drawn = await api<{ status: string }>(`/api/ballots/${ballot.id}/draw`, { method: "POST" }, true);
  for (let attempt = 0; drawn.status === 425 && attempt < 10; attempt++) {
    await sleep(1500);
    drawn = await api<{ status: string }>(`/api/ballots/${ballot.id}/draw`, { method: "POST" }, true);
  }
  console.log(`Drawn (${drawn.body.status}).`);

  const settled = await api<Record<string, number>>(`/api/ballots/${ballot.id}/settle`, { method: "POST" }, true);
  console.log(`Settled: ${JSON.stringify(settled.body)}`);

  // Read every hold back from PayPal rather than trusting our own ledger.
  const rows = await server.deps.db.query<{ id: string; status: string; rejection: string | null; outcome: string | null; position: number | null; account_status: string | null; authorization_id: string | null }>(
    `select id, status, rejection, outcome, position, account_status, authorization_id from entries where ballot_id = $1 order by position nulls last, id`,
    [ballot.id],
  );
  const readBack = await Promise.all(
    rows.map(async (row) => ({
      entry: row.id,
      ledger: row.rejection ? `${row.status}/${row.rejection}` : row.status,
      outcome: row.outcome,
      position: row.position,
      accountStatus: row.account_status,
      paypal: row.authorization_id ? await server.deps.paypal.authorizationStatus(row.authorization_id) : "no hold",
    })),
  );
  console.log("\nEntry                       ledger              outcome        PayPal says");
  for (const r of readBack) {
    console.log(`  ${r.entry.padEnd(26)}${r.ledger.padEnd(20)}${String(r.outcome ?? "-").padEnd(15)}${r.paypal}`);
  }

  // Verify the draw the way a stranger would: public proof + an independently fetched beacon.
  const { body: proof } = await api<PublicProof>(`/api/ballots/${ballot.id}/proof`);
  const beacon = await verifiedBeacon(proof.beacon!.round);
  const mismatches = verifyDraw(proof.terms!, proof.entries!, beacon, {
    commitment: proof.commitment!,
    round: beacon.round,
    randomness: beacon.randomness,
    line: proof.line!,
    selectedUnits: proof.line!.reduce((sum, p) => sum + p.selected, 0),
  });
  console.log(`\nIndependent check of the draw: ${mismatches.length === 0 ? "matches (beacon signature verified, line recomputed)" : JSON.stringify(mismatches)}`);

  await mkdir(new URL("../probes/out/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("../probes/out/demo-ballot.json", import.meta.url),
    JSON.stringify({ at: new Date().toISOString(), ballot: ballot.id, round: beacon.round, commitment: proof.commitment, settled: settled.body, entries: readBack, drawVerified: mismatches.length === 0 }, null, 2) + "\n",
  );
  console.log("Saved probes/out/demo-ballot.json");
} finally {
  await server.close();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
