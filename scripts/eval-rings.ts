/**
 * Ring detection eval on synthetic programs, offline and deterministic:
 *
 *   npm run eval:rings -- [--claims 5000] [--ring-share 0.3] [--seeds 101-110] [--pool 2000000] [--json out.json]
 *
 * Compares two policies over the same claims:
 *
 * - `verified-only`: pay every VERIFIED account once; hold the rest.
 * - `verified+rings`: the same gate, plus hold every claim in a suspected ring for review.
 *
 * Thresholds and the generator were tuned on seeds 1-5 (5,000 claims) and 201-202 (40,000). The
 * default report uses seeds 101-110, which tuning never saw. The numbers measure the detector against
 * this generator's archetypes, not against real fraud; `quiet` rings are built to evade it.
 */

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { findRings } from "../src/rings/cluster.ts";
import { type Score, score } from "../src/rings/score.ts";
import { generateProgram } from "../src/rings/synthetic.ts";

const { values } = parseArgs({
  options: {
    claims: { type: "string", default: "5000" },
    "ring-share": { type: "string", default: "0.3" },
    seeds: { type: "string", default: "101-110" },
    pool: { type: "string", default: "2000000" },
    json: { type: "string" },
  },
});

const claims = Number(values.claims);
const ringShare = Number(values["ring-share"]);
const poolCents = Math.round(Number(values.pool) * 100);
const [lo, hi = lo] = values.seeds.split("-").map(Number) as [number, number?];
const seeds = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));

type Policy = "verified-only" | "verified+rings" | "rings alone";
const runs: Array<{ seed: string; ms: number; rings: number; truthRings: number; scores: Record<Policy, Score> }> = [];

for (const seed of seeds) {
  const program = generateProgram({ seed, claims, ringShare });
  const started = performance.now();
  const rings = findRings(program.claims, { sampleText: program.sampleText });
  const ms = performance.now() - started;
  const flagged = new Set(rings.flatMap((ring) => ring.claimIds));
  const unverified = new Set(program.claims.filter((c) => !c.verified).map((c) => c.id));
  runs.push({
    seed,
    ms,
    rings: rings.length,
    truthRings: program.rings.length,
    scores: {
      "verified-only": score(program, unverified, poolCents),
      "verified+rings": score(program, new Set([...unverified, ...flagged]), poolCents),
      "rings alone": score(program, flagged, poolCents),
    },
  });
}

const mean = (pick: (run: (typeof runs)[number]) => number) => runs.reduce((sum, run) => sum + pick(run), 0) / runs.length;
const span = (pick: (run: (typeof runs)[number]) => number) => {
  const all = runs.map(pick);
  return [Math.min(...all), Math.max(...all)] as const;
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const withSpan = (pick: (run: (typeof runs)[number]) => number) => {
  const [min, max] = span(pick);
  return runs.length > 1 ? `${pct(mean(pick))} (${pct(min)}–${pct(max)})` : pct(mean(pick));
};

const policies: Policy[] = ["verified-only", "verified+rings", "rings alone"];
const lines = [
  `## Ring detection eval`,
  ``,
  `${claims.toLocaleString("en-US")} claims per program, ${pct(ringShare)} filed by rings, seeds ${values.seeds} (${runs.length} programs), pool ${usd(poolCents)}.`,
  `Means across programs, with the range in brackets.`,
  ``,
  `| Policy | Precision | Recall | Genuine held | Paid to rings | Per genuine claim |`,
  `| --- | --- | --- | --- | --- | --- |`,
  ...policies.map((p) =>
    `| ${p} | ${withSpan((r) => r.scores[p].precision)} | ${withSpan((r) => r.scores[p].recall)} | ${withSpan((r) => r.scores[p].falseHoldRate)} | ${usd(mean((r) => r.scores[p].ringPaidCents))} | ${usd(mean((r) => r.scores[p].perGenuineCents))} |`,
  ),
  ``,
  `**Recall by ring kind** (rings alone): ` +
    (["device-farm", "address-mill", "template-crew", "quiet"] as const)
      .map((k) => `${k} ${pct(mean((r) => r.scores["rings alone"].recallByKind[k] ?? 0))}`)
      .join(", "),
  ``,
  `**Genuine claimants held by kind** (rings alone): ` +
    (["solo", "household", "campus", "sample-text"] as const)
      .map((k) => `${k} ${pct(mean((r) => r.scores["rings alone"].falseHoldByKind[k] ?? 0))}`)
      .join(", "),
  ``,
  `Suspected rings per program: ${mean((r) => r.rings).toFixed(1)} (true rings: ${mean((r) => r.truthRings).toFixed(1)}). Detection took ${mean((r) => r.ms).toFixed(0)} ms per program.`,
];
console.log(lines.join("\n"));

if (values.json) {
  await writeFile(values.json, `${JSON.stringify({ claims, ringShare, seeds, poolCents, runs }, null, 2)}\n`);
  console.log(`\nWrote ${values.json}`);
}
