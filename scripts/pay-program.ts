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
  const review = await call<{ rings: { id: string; claimIds: string[] }[]; held: Record<string, number>; approved: number; unbound: number }>(
    "POST",
    `/api/programs/${programId}/review?early=1`,
  );
  console.log(`Review: ${review.approved} approved, held ${JSON.stringify(review.held)}, ${review.unbound} never confirmed by a person`);
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
  const sync = await call<{ paid: number; failed: number; pending: number; done: boolean }>("POST", `/api/programs/${programId}/sync`);
  console.log(`Payouts: ${sync.paid} paid, ${sync.failed} failed, ${sync.pending} pending`);
  if (sync.done) break;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
