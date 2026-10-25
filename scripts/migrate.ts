/**
 * Applies the schema and exits. Render runs this as the web service's pre-deploy command, so a
 * deploy with a bad migration never starts serving.
 */

import { openFromEnv } from "../src/db/db.ts";

const db = await openFromEnv();
await db.close();
console.log(process.env.DATABASE_URL ? "Schema applied to Postgres." : "Schema applied to PGlite (no DATABASE_URL set).");
