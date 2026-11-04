/**
 * Ways to run the investigator:
 *
 * - `typeSafeInvestigator`: live, through TypeSafe's typed System-1 API (`TYPESAFE_API_KEY`).
 * - `RecordingInvestigator`: live, and appends every answer to a fixtures file.
 * - `ReplayInvestigator`: answers from that file only. The eval, CI and judges use this, so the
 *   numbers can be reproduced with no API key and no network.
 * - `CachedInvestigator`: what the API runs. Recorded answers first (so the hosted demo program is
 *   the same for every visitor, key or not), then live if a key is configured.
 */

import { appendFile, readFile } from "node:fs/promises";
import { type CaseFile, type Investigator, type Pattern, type Verdict, PATTERNS, caseKey } from "./investigate.ts";

export const FIXTURES = "eval/investigator.jsonl";
/** Recorded answers for the demo program's rings (`npm run demo:record`). */
export const DEMO_FIXTURES = "eval/demo-investigator.jsonl";

export function typeSafeInvestigator(options: { model?: string } = {}): Investigator {
  let client: Promise<{ ask: (file: CaseFile) => Promise<Verdict> }> | undefined;
  const connect = async () => {
    const { TypeSafeClient, choice, noul, score } = await import("@typesafe-ai/sdk");
    const sdk = new TypeSafeClient();
    const questions = {
      coordinated: noul(
        "These claims to one settlement program were grouped because they share signals. Each came from a different PayPal account. In the case file, D1, M1, B1, N1 and X1 are stand-in labels for a device, an email inbox, a building, an internet network and a private mail domain: claims with the same label share that thing. Is this group most likely a fraud operation filing through farmed or borrowed accounts? Answer no if it could be real, distinct people each filing their own claim, such as one family at one home sharing a computer and an internet connection, roommates, or people on one campus or office network.",
      ),
      pattern: choice("Which explanation fits what these claims share best?", PATTERNS),
      strength: score("How strong is the evidence that these claims were filed by one operation?", [
        "None: nothing links them beyond chance",
        "Weak: one shared signal that innocent people often share",
        "Moderate: several signals, each with an innocent explanation",
        "Strong: signals that rarely occur together by chance",
        "Conclusive: shared devices or inboxes plus scripted wording or timing",
      ] as const),
    };
    return {
      ask: async (file: CaseFile): Promise<Verdict> => {
        const response = await sdk.systemOne({ state: file, questions, ...(options.model ? { model: options.model } : {}) });
        const { coordinated, pattern, strength } = response.answers;
        return {
          coordinated: round3(coordinated.noul),
          pattern: pattern.choice as Pattern,
          patternConfidence: round3(pattern.confidence),
          strength: round3(strength.score),
          model: response.model,
        };
      },
    };
  };
  return {
    async investigate(file) {
      client ??= connect();
      return (await client).ask(file);
    },
  };
}

export async function loadFixtures(path = FIXTURES): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? "" : Promise.reject(err)));
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const { key, verdict } = JSON.parse(line) as { key: string; verdict: Verdict };
    out.set(key, verdict);
  }
  return out;
}

export class ReplayInvestigator implements Investigator {
  constructor(private readonly fixtures: ReadonlyMap<string, Verdict>) {}

  async investigate(file: CaseFile): Promise<Verdict> {
    const verdict = this.fixtures.get(caseKey(file));
    if (!verdict) throw new Error(`no recorded answer for case ${caseKey(file)}; record it first: npm run eval:investigator -- --mode record`);
    return verdict;
  }
}

export class CachedInvestigator implements Investigator {
  constructor(
    private readonly fixtures: ReadonlyMap<string, Verdict>,
    private readonly live?: Investigator,
  ) {}

  async investigate(file: CaseFile): Promise<Verdict> {
    const known = this.fixtures.get(caseKey(file));
    if (known) return known;
    if (!this.live) throw new Error(`no recorded answer for case ${caseKey(file)} and no TYPESAFE_API_KEY to ask live`);
    return this.live.investigate(file);
  }
}

/** Answers from fixtures when it has them, otherwise live, appending each new answer to the file. */
export class RecordingInvestigator implements Investigator {
  constructor(
    private readonly live: Investigator,
    private readonly fixtures: Map<string, Verdict>,
    private readonly path = FIXTURES,
  ) {}

  async investigate(file: CaseFile): Promise<Verdict> {
    const key = caseKey(file);
    const known = this.fixtures.get(key);
    if (known) return known;
    const verdict = await this.live.investigate(file);
    this.fixtures.set(key, verdict);
    await appendFile(this.path, `${JSON.stringify({ key, verdict })}\n`);
    return verdict;
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
