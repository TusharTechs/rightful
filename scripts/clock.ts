/**
 * One clock tick: read back claim payouts that are still moving, and draw audit samples whose
 * drand round is out. Render runs this every minute as the `rightful-clock` cron job.
 */

import { buildRuntime } from "../src/api/main.ts";
import { tickClaims } from "../src/claims/distribute.ts";

const { deps } = await buildRuntime();
try {
  const report = await tickClaims(deps);
  console.log(JSON.stringify({ at: new Date().toISOString(), ...report }));
  if (report.errors.length) process.exitCode = 1;
} finally {
  await deps.db.close();
}
