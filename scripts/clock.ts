/**
 * One clock tick: seal, draw and settle whatever is due. Render runs this every minute as the
 * `firsthand-clock` cron job.
 */

import { buildRuntime } from "../src/api/main.ts";
import { tick } from "../src/ballots/clock.ts";

const { deps } = await buildRuntime();
try {
  const report = await tick(deps);
  console.log(JSON.stringify({ at: new Date().toISOString(), ...report }));
  if (report.errors.length) process.exitCode = 1;
} finally {
  await deps.db.close();
}
