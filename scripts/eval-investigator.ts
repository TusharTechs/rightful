/**
 * Investigator eval: does it tell rings from innocent groups, on groups it has never seen?
 *
 *   npm run eval:investigator -- [--mode replay|record|live] [--claims 2000] [--seeds 101-105] [--json out.json]
 *
 * The detector runs at a sensitive setting (groups of three or more), which flags every real ring
 * and also dozens of innocent groups per program, mostly households sharing a laptop. Each group
 * gets a case file and the investigator's recommendation (deny, review, clear), scored against the
 * synthetic truth. `replay` (the default) answers from eval/investigator.jsonl and needs no API key;
 * `record` asks TypeSafe for any case not in that file and appends it; `live` asks for every case.
 *
 * The questions and the recommendation rule were tuned on seeds 1-5; the default report uses seeds
 * 101-105, recorded once after tuning. Both sets are in the fixtures, so either replays offline.
 */

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { findRings } from "../src/rings/cluster.ts";
import { type Investigator, type Memo, BENIGN, investigateRing } from "../src/rings/investigate.ts";
import { FIXTURES, RecordingInvestigator, ReplayInvestigator, loadFixtures, typeSafeInvestigator } from "../src/rings/investigators.ts";
import { type Score, score } from "../src/rings/score.ts";
import { generateProgram } from "../src/rings/synthetic.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "replay" },
    claims: { type: "string", default: "2000" },
    seeds: { type: "string", default: "101-105" },
    json: { type: "string" },
  },
});

const mode = values.mode;
if (mode !== "replay" && mode !== "record" && mode !== "live") throw new Error("--mode must be replay, record or live");
if (mode !== "replay" && !process.env.TYPESAFE_API_KEY) throw new Error(`--mode ${mode} needs TYPESAFE_API_KEY (in .env)`);
const fixtures = await loadFixtures();
const investigator: Investigator =
  mode === "replay" ? new ReplayInvestigator(fixtures) : mode === "record" ? new RecordingInvestigator(typeSafeInvestigator(), fixtures) : typeSafeInvestigator();

const claims = Number(values.claims);
const [lo, hi = lo] = values.seeds.split("-").map(Number) as [number, number?];
const seeds = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
const SENSITIVE = { minRingSize: 3 };

type Kind = "ring" | "genuine";
type Row = { seed: string; ringId: string; kind: Kind; truthKind: string; size: number; memo: Memo };
const rows: Row[] = [];
const scores: Array<{ seed: string; detector: Score; sensitive: Score; investigated: Score }> = [];

for (const seed of seeds) {
  const program = generateProgram({ seed, claims });
  const byId = new Map(program.claims.map((c) => [c.id, c]));
  const candidates = findRings(program.claims, { sampleText: program.sampleText, ...SENSITIVE });
  const kept = new Set<string>();
  for (const ring of candidates) {
    const memo = await investigateRing(investigator, ring, byId, program.sampleText);
    const truths = ring.claimIds.map((id) => program.truth.get(id)!);
    const ringClaims = truths.filter((t) => t.ring).length;
    const kind: Kind = ringClaims * 2 >= truths.length ? "ring" : "genuine";
    rows.push({ seed, ringId: ring.id, kind, truthKind: majority(truths.map((t) => t.kind)), size: ring.claimIds.length, memo });
    if (memo.recommendation !== "clear") for (const id of ring.claimIds) kept.add(id);
  }
  const atDefault = findRings(program.claims, { sampleText: program.sampleText });
  scores.push({
    seed,
    detector: score(program, new Set(atDefault.flatMap((r) => r.claimIds)), 1),
    sensitive: score(program, new Set(candidates.flatMap((r) => r.claimIds)), 1),
    investigated: score(program, kept, 1),
  });
  process.stderr.write(`seed ${seed}: ${candidates.length} groups investigated\n`);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const count = (kind: Kind, rec: Memo["recommendation"]) => rows.filter((r) => r.kind === kind && r.memo.recommendation === rec).length;
const total = (kind: Kind) => rows.filter((r) => r.kind === kind).length;
const mean = (pick: (s: (typeof scores)[number]) => number) => scores.reduce((sum, s) => sum + pick(s), 0) / scores.length;
const patternRight = (r: Row) => (!r.memo.verdict ? false : r.kind === "ring" ? r.memo.verdict.pattern === r.truthKind : BENIGN.has(r.memo.verdict.pattern));
const models = [...new Set(rows.map((r) => r.memo.verdict?.model ?? "rejected"))].join(", ");

const lines = [
  `## Investigator eval`,
  ``,
  `${claims.toLocaleString("en-US")} claims per program, seeds ${values.seeds}, ${rows.length} groups flagged at the sensitive setting (size ≥ 3). Answers: ${mode} (${models || "none"}).`,
  ``,
  `| Group is really | Groups | Deny | Review | Clear |`,
  `| --- | --- | --- | --- | --- |`,
  ...(["ring", "genuine"] as const).map((k) => `| ${k} | ${total(k)} | ${count(k, "deny")} | ${count(k, "review")} | ${count(k, "clear")} |`),
  ``,
  `- Deny is right ${pct(count("ring", "deny") / Math.max(1, count("ring", "deny") + count("genuine", "deny")))} of the time; rings it would clear: ${count("ring", "clear")} of ${total("ring")}.`,
  `- Innocent groups cleared: ${pct(count("genuine", "clear") / Math.max(1, total("genuine")))}; sent to a person: ${pct(count("genuine", "review") / Math.max(1, total("genuine")))}.`,
  `- Pattern named correctly: ${pct(rows.filter(patternRight).length / Math.max(1, rows.length))} (ring kind for rings, a benign pattern for innocent groups).`,
  ``,
  `| Claims held | Precision | Recall | Genuine held |`,
  `| --- | --- | --- | --- |`,
  ...([["detector (default)", "detector"], ["detector (sensitive)", "sensitive"], ["sensitive + investigator clears", "investigated"]] as const).map(
    ([label, key]) => `| ${label} | ${pct(mean((s) => s[key].precision))} | ${pct(mean((s) => s[key].recall))} | ${pct(mean((s) => s[key].falseHoldRate))} |`,
  ),
];
console.log(lines.join("\n"));
if (mode !== "live") console.log(`\nFixtures: ${FIXTURES} (${fixtures.size} answers)`);

if (values.json) {
  await writeFile(values.json, `${JSON.stringify({ claims, seeds, mode, rows, scores }, null, 2)}\n`);
  console.log(`Wrote ${values.json}`);
}

function majority(kinds: string[]): string {
  const tally = new Map<string, number>();
  for (const k of kinds) tally.set(k, (tally.get(k) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1])[0]![0];
}
