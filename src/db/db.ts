/**
 * One small database interface over two engines:
 * - Postgres (`pg`) when `DATABASE_URL` is set, as on Render;
 * - PGlite (Postgres compiled to WebAssembly) otherwise, so the whole app runs locally and in tests
 *   with no database to install.
 * Both speak the same SQL, so there is one schema and one set of queries.
 */

import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { SCHEMA } from "./schema.ts";

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
};

function fromPGliteLike(target: Queryable, transaction: Db["transaction"], close: () => Promise<void>): Db {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => (await target.query<T>(sql, params)).rows,
    exec: async (sql) => {
      await target.exec(sql);
    },
    transaction,
    close,
  };
}

/** An in-process Postgres. Pass a directory to keep data between runs; omit it for memory only. */
export async function openPGlite(dataDir?: string): Promise<Db> {
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  const db: Db = fromPGliteLike(
    lite,
    (fn) =>
      lite.transaction((tx) =>
        fn(
          fromPGliteLike(
            tx,
            () => Promise.reject(new Error("nested transactions are not supported")),
            async () => {},
          ),
        ),
      ),
    () => lite.close(),
  );
  await migrate(db);
  return db;
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await waitForPostgres((sql) => pool.query(sql));
  const wrap = (client: pg.Pool | pg.PoolClient, transaction: Db["transaction"], close: () => Promise<void>): Db => ({
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params as unknown[])).rows as T[],
    exec: async (sql) => {
      await client.query(sql);
    },
    transaction,
    close,
  });
  const db = wrap(
    pool,
    async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(
          wrap(client, () => Promise.reject(new Error("nested transactions are not supported")), async () => {}),
        );
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    () => pool.end(),
  );
  await migrate(db);
  return db;
}

/** Postgres if `DATABASE_URL` is set, otherwise PGlite (persisted in `PGLITE_DIR` if set). */
export function openFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  return env.DATABASE_URL ? openPostgres(env.DATABASE_URL) : openPGlite(env.PGLITE_DIR || undefined);
}

async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}

/** Errors that mean "the database is not up yet", as on the first deploy of a new Blueprint. */
const STARTING_UP = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "57P03", "08001", "08006"]);

/**
 * Waits for Postgres to accept connections. A new Blueprint creates the database and the API at the
 * same time, and the API's pre-deploy migration can reach the database before it is listening.
 * Gives up after about four and a half minutes, or at once on any other error (bad password, etc.).
 */
export async function waitForPostgres(
  probe: (sql: string) => Promise<unknown>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void } = {},
): Promise<void> {
  const attempts = options.attempts ?? 30;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await probe("select 1");
      return;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (!STARTING_UP.has(code) || attempt >= attempts) throw err;
      (options.log ?? console.warn)(`Postgres not reachable yet (${code}); retry ${attempt}/${attempts - 1}`);
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 10_000));
    }
  }
}
