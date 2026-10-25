import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForPostgres } from "../src/db/db.ts";

const quiet = { sleep: async () => {}, log: () => {} };

test("waits for a database that is still starting", async () => {
  let calls = 0;
  await waitForPostgres(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  }, quiet);
  assert.equal(calls, 3);
});

test("does not retry errors that will not fix themselves", async () => {
  let calls = 0;
  await assert.rejects(
    waitForPostgres(async () => {
      calls++;
      throw Object.assign(new Error("password authentication failed"), { code: "28P01" });
    }, quiet),
    /password/,
  );
  assert.equal(calls, 1);
});

test("gives up after the last attempt", async () => {
  let calls = 0;
  await assert.rejects(
    waitForPostgres(async () => {
      calls++;
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }, { ...quiet, attempts: 4 }),
  );
  assert.equal(calls, 4);
});
