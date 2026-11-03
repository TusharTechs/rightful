/**
 * One clock tick: seal, draw and settle whatever ballots are due, and read back claim payouts that
 * are still moving. Render runs this every minute as the `firsthand-clock` cron job.
 */

import { buildRuntime } from "../src/api/main.ts";
import { tick } from "../src/ballots/clock.ts";
import { tickClaims } from "../src/claims/distribute.ts";

const { deps, payouts } = await buildRuntime();
try {
  const report = await tick(deps);
  const claims = await tickClaims({ ...deps, payouts });
  console.log(JSON.stringify({ at: new Date().toISOString(), ...report, claims }));
  if (report.errors.length || claims.errors.length) process.exitCode = 1;
} finally {
  await deps.db.close();
}
