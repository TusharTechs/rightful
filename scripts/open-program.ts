/**
 * Opens a claims program on a running API and prints the links to try it:
 *
 *   npm run open:program -- [--pool 2000000] [--hours 24] [--title "…"]
 *
 * Use a small pool (say --pool 2) to pay for real in the sandbox: its balance cannot cover $2M.
 *
 * Reads FIRSTHAND_API (default: the hosted API) and FIRSTHAND_ADMIN_TOKEN from the environment or
 * .env. Also files one claim the way an agent would, and prints the link its person would get.
 */

import { parseArgs } from "node:util";

const api = (process.env.FIRSTHAND_API ?? "https://firsthand-api.onrender.com").replace(/\/$/, "");
const token = process.env.FIRSTHAND_ADMIN_TOKEN;
if (!token) {
  console.error("Set FIRSTHAND_ADMIN_TOKEN (Render: firsthand-secrets → ADMIN_TOKEN) in .env first.");
  process.exit(1);
}
const { values } = parseArgs({
  options: {
    pool: { type: "string", default: "2000000" },
    hours: { type: "string", default: "24" },
    title: { type: "string", default: "Filter pitcher settlement (sandbox)" },
  },
});
const title = values.title;
const hours = Number(values.hours);
const poolCents = Math.round(Number(values.pool) * 100);

const post = async <T>(path: string, body: unknown, admin = false): Promise<T> => {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

const program = await post<{ id: string; poolCents: number }>(
  "/api/programs",
  {
    title,
    poolCents,
    closesInSeconds: Math.round(hours * 3600),
    sampleText: "I purchased the filter pitcher or replacement filters between 2019 and 2024 for personal use.",
  },
  true,
);
const agent = await post<{ id: string; bindUrl: string }>(`/api/programs/${program.id}/claims`, {
  email: "sandbox.claimant@example.com",
  address: "12 Example Street, Fairhaven, OR 97001",
  narrative: "Filed by an assistant on my behalf: I bought two filter pitchers in 2022.",
  device: "assistant",
});

console.log(`Program ${program.id} is open for ${hours} h, pool $${(program.poolCents / 100).toFixed(2)}.

File a claim yourself (sign in as a US sandbox personal account):
  ${api}/claim/start?program=${program.id}

Confirm the claim an agent filed (use a different sandbox account, in a private window):
  ${agent.bindUrl}

Admin view:
  curl -H "authorization: Bearer $FIRSTHAND_ADMIN_TOKEN" ${api}/api/programs/${program.id}/claims`);
