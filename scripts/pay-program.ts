/**
 * Reviews, distributes and pays a claims program on a running API, then follows the payouts:
 *
 *   npm run pay:program -- <programId> [--deny ring_001,ring_002 | --approve ring_001]
 *
 * Closes the program early if it is still open. Suspected rings must be decided before anything is
 * paid: pass --deny or --approve with their IDs, or the script lists them and stops. Reads
 * FIRSTHAND_API and FIRSTHAND_ADMIN_TOKEN like `open:program`.
 */

import { parseArgs } from "node:util";

const api = (process.env.FIRSTHAND_API ?? "https://firsthand-api.onrender.com").replace(/\/$/, "");
const token = process.env.FIRSTHAND_ADMIN_TOKEN;
const { values, positionals } = parseArgs({ allowPositionals: true, options: { deny: { type: "string" }, approve: { type: "string" } } });
const programId = positionals[0];
if (!token || !programId) {
  console.error("Usage: npm run pay:program -- <programId>   (needs FIRSTHAND_ADMIN_TOKEN in .env)");
  process.exit(1);
}

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

const program = await call<{ status: string; title: string; poolCents: number }>("GET", `/api/programs/${programId}`);
console.log(`${program.title}: ${program.status}, pool $${(program.poolCents / 100).toFixed(2)}`);

if (program.status === "open" || program.status === "review") {
  const review = await call<{ rings: { id: string; claimIds: string[] }[]; held: Record<string, number>; approved: number; unbound: number; investigation: { written: number; failed: number } }>(
    "POST",
    `/api/programs/${programId}/review?early=1`,
  );
  console.log(`Review: ${review.approved} approved, held ${JSON.stringify(review.held)}, ${review.unbound} never confirmed by a person`);
  if (review.rings.length) {
    const rings = await call<{ id: string; claimIds: string[]; memo: { recommendation: string; evidence: string[]; verdict: { coordinated: number; pattern: string } } | null }[]>("GET", `/api/programs/${programId}/rings`);
    for (const ring of rings) {
      const memo = ring.memo ? `investigator: ${ring.memo.recommendation} (${ring.memo.verdict.pattern}, ${Math.round(ring.memo.verdict.coordinated * 100)}% coordinated)` : "no memo";
      console.log(`  ${ring.id}: ${ring.claimIds.length} claims; ${memo}${ring.memo ? `\n    - ${ring.memo.evidence.join("\n    - ")}` : ""}`);
    }
  }
  for (const [decision, list] of [["deny", values.deny], ["approve", values.approve]] as const) {
    for (const ringId of (list ?? "").split(",").filter(Boolean)) {
      const { changed } = await call<{ changed: number }>("POST", `/api/programs/${programId}/decisions`, { ringId, decision });
      console.log(`${decision} ${ringId}: ${changed} claims`);
    }
  }
  const undecided = review.rings.filter((ring) => ![values.deny, values.approve].join(",").split(",").includes(ring.id));
  if (undecided.length) {
    console.log(`Decide these rings first (--deny or --approve): ${undecided.map((r) => `${r.id} (${r.claimIds.length} claims)`).join(", ")}`);
    process.exit(2);
  }
}

if (program.status !== "distributing" && program.status !== "done") {
  const report = await call<{ shareCents: number; claims: number; batches: unknown[] }>("POST", `/api/programs/${programId}/distribute`);
  console.log(`Distributing $${(report.shareCents / 100).toFixed(2)} to each of ${report.claims} claims in ${report.batches.length} batch(es)`);
}

for (let attempt = 0; attempt < 40; attempt++) {
  const sync = await call<{ paid: number; failed: number; pending: number; done: boolean; audit: string[] | null }>("POST", `/api/programs/${programId}/sync`);
  console.log(`Payouts: ${sync.paid} paid, ${sync.failed} failed, ${sync.pending} pending; audit sample ${sync.audit ? sync.audit.join(", ") : "not drawn yet"}`);
  if (sync.done && sync.audit) break;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

const ledger = await call<{ commitment: { digest: string; payoutCount: number }; audit: { round: number } | null }>("GET", `/api/programs/${programId}/ledger`);
console.log(`Ledger ${ledger.commitment.digest.slice(0, 16)}… commits ${ledger.commitment.payoutCount} payouts; audit from drand round ${ledger.audit?.round ?? "(pending)"}.
Public ledger: ${api}/api/programs/${programId}/ledger`);
