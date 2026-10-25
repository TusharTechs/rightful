/**
 * Moves ballots along on time: seal when entries close, draw when the committed drand round is
 * published, settle after the draw.
 *
 * Two callers share it. The `firsthand-clock` cron job runs `tick` every minute as the backstop,
 * and the API calls `advance` when someone is watching a ballot, so a live draw appears within
 * seconds of the round instead of up to a minute later. Every step is idempotent, so the two can
 * overlap safely.
 */

import { timeOfRound } from "../ballot/drand.ts";
import { type BallotRow, type Deps, BallotError, getBallot, runDraw, sealBallot, settleBallot } from "./service.ts";

export type TickReport = { sealed: string[]; drawn: string[]; settled: string[]; errors: { ballot: string; error: string }[] };

/** Advances every ballot that is due. */
export async function tick(deps: Deps): Promise<TickReport> {
  const report: TickReport = { sealed: [], drawn: [], settled: [], errors: [] };
  const due = await deps.db.query<{ id: string }>(
    `select id from ballots
     where (status = 'open' and closes_at <= $1) or status in ('sealed', 'drawn')
     order by closes_at`,
    [deps.now()],
  );
  for (const { id } of due) {
    try {
      const steps = await advance(deps, id, { settle: true });
      for (const step of steps) report[step].push(id);
    } catch (err) {
      report.errors.push({ ballot: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/** Runs whichever steps are due for one ballot. Returns the steps it completed. */
export async function advance(deps: Deps, ballotId: string, options: { settle: boolean }): Promise<("sealed" | "drawn" | "settled")[]> {
  const steps: ("sealed" | "drawn" | "settled")[] = [];
  let ballot: BallotRow = await getBallot(deps.db, ballotId);
  const now = deps.now();

  if (ballot.status === "open" && now >= ballot.closes_at) {
    ballot = await sealBallot(deps, ballotId);
    steps.push("sealed");
  }
  if (ballot.status === "sealed" && ballot.draw_round !== null && now >= timeOfRound(ballot.draw_round)) {
    try {
      ballot = await runDraw(deps, ballotId);
      steps.push("drawn");
    } catch (err) {
      // The round can be a second late at the relays; the next tick picks it up.
      if (!(err instanceof BallotError && err.code === "too_early")) throw err;
    }
  }
  if (options.settle && ballot.status === "drawn") {
    await settleBallot(deps, ballotId);
    if ((await getBallot(deps.db, ballotId)).status === "settled") steps.push("settled");
  }
  return steps;
}
