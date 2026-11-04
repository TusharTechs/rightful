/**
 * The hosted demo: a $2M settlement program with 5,000 synthetic claims, about a third of them filed
 * by rings, ready for a judge to review in the console with no login.
 *
 * Each visitor gets their own copy, seeded from the same synthetic program (`src/rings/synthetic.ts`)
 * and taken through the real pipeline: claims are stored the way intake stores them (payer IDs
 * sealed, only the /24 of the network kept), `reviewProgram` holds rings and unverified accounts, and
 * the investigator writes each ring's memo. Its answers are replayed from
 * `eval/demo-investigator.jsonl`, so every copy reads the same, with or without an API key.
 *
 * What is simulated: the claimants (none is a real person or PayPal account) and therefore the
 * payouts (`simulated-payouts.ts`). The ledger, the drand round and the audit sample are real.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { claimKeys, sealPayee } from "../claims/pass.ts";
import { type ClaimsDeps, type ProgramRow, ClaimError, getProgram, investigateProgram, networkOf, reviewProgram } from "../claims/service.ts";
import { generateProgram } from "../rings/synthetic.ts";

export const DEMO = {
  seed: "rightful-demo-1",
  claims: 5000,
  ringShare: 0.3,
  poolCents: 200_000_000,
  title: "Clearwell filter pitcher settlement (demo)",
  /** The sensitive setting: every ring, plus innocent households for the investigator to sort. */
  ringMinSize: 3,
} as const;

/** Demo copies older than this are deleted by the clock. */
export const DEMO_TTL_MS = 72 * 3_600_000;
/** At most this many copies at once; the oldest goes first. */
export const MAX_DEMOS = 40;

export type Demo = { program: ProgramRow; token: string };

export async function createDemoProgram(deps: ClaimsDeps): Promise<Demo> {
  const synthetic = generateProgram({ seed: DEMO.seed, claims: DEMO.claims, ringShare: DEMO.ringShare });
  const last = Math.max(...synthetic.claims.map((c) => c.filedAt));
  const suffix = randomBytes(9).toString("base64url");
  const programId = `prg_${suffix}`;

  await deps.db.transaction(async (tx) => {
    await tx.query(
      `insert into programs (id, title, status, pool_cents, currency, require_verified, sample_text, closes_at, kind, ring_min_size)
       values ($1, $2, 'open', $3, 'USD', true, $4, $5, 'demo', $6)`,
      [programId, DEMO.title, DEMO.poolCents, synthetic.sampleText, new Date(last + 60_000), DEMO.ringMinSize],
    );
    const { payeeKey } = claimKeys(deps.humanSecret);
    const rows = synthetic.claims.map((claim, i) => {
      const truth = synthetic.truth.get(claim.id)!;
      return {
        // Same order as the synthetic program, so every copy's rings and case files are identical.
        id: `clm_${suffix}_${claim.id.slice(4)}`,
        status: claim.verified ? "filed" : "held",
        reason: claim.verified ? null : "unverified",
        // About one claim in six was filed by an assistant and confirmed by the person afterwards.
        via: i % 6 === 5 ? "agent" : "web",
        tag: claim.humanTag,
        payee: sealPayee(payeeKey, `DEMOPAYER${String(i + 1).padStart(6, "0")}`),
        verified: claim.verified,
        email: claim.email,
        address: claim.address,
        network: networkOf(claim.ip),
        device: claim.device,
        narrative: claim.narrative,
        filedAt: new Date(claim.filedAt).toISOString(),
        truth: truth.ring ? `ring:${truth.kind}` : `genuine:${truth.kind}`,
      };
    });
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const col = <K extends keyof (typeof rows)[number]>(key: K) => chunk.map((row) => row[key]);
      await tx.query(
        `insert into claims (id, program_id, status, hold_reason, filed_via, human_tag, payee_sealed, verified,
                             email, address, network, device, narrative, filed_at, bound_at, demo_truth)
         select u.id, $1, u.status, u.reason, u.via, u.tag, u.payee, u.verified,
                u.email, u.address, u.network, u.device, u.narrative, u.filed_at, u.filed_at, u.truth
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[],
                     $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::timestamptz[], $15::text[])
              as u(id, status, reason, via, tag, payee, verified, email, address, network, device, narrative, filed_at, truth)`,
        [programId, col("id"), col("status"), col("reason"), col("via"), col("tag"), col("payee"), col("verified"),
          col("email"), col("address"), col("network"), col("device"), col("narrative"), col("filedAt"), col("truth")],
      );
    }
  });

  await reviewProgram(deps, programId, { early: true });
  await investigateProgram(deps, programId);
  await pruneDemos(deps);
  return { program: await getProgram(deps.db, programId), token: demoToken(deps.humanSecret, programId) };
}

/** The console token for one demo program: it can review, decide and pay that program only. */
export function demoToken(secret: Uint8Array, programId: string): string {
  return createHmac("sha256", secret).update(`rightful/demo-console/v1\n${programId}`).digest("base64url");
}

export function isDemoToken(secret: Uint8Array, programId: string, token: string): boolean {
  const expected = Buffer.from(demoToken(secret, programId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Deletes demo copies past their TTL, and the oldest beyond the cap. */
export async function pruneDemos(deps: ClaimsDeps): Promise<number> {
  const stale = await deps.db.query<{ id: string }>(
    `select id from programs where kind = 'demo' and (created_at < $1 or id not in (
       select id from programs where kind = 'demo' order by created_at desc limit $2))`,
    [new Date(deps.now().getTime() - DEMO_TTL_MS), MAX_DEMOS],
  );
  const ids = stale.map((row) => row.id);
  if (ids.length === 0) return 0;
  await deps.db.transaction(async (tx) => {
    await tx.query(`delete from rings where program_id = any($1)`, [ids]);
    await tx.query(`delete from claims where program_id = any($1)`, [ids]);
    await tx.query(`delete from programs where id = any($1) and kind = 'demo'`, [ids]);
  });
  return ids.length;
}

export function assertDemo(program: ProgramRow) {
  if (program.kind !== "demo") throw new ClaimError("this is not a demo program", "unauthorized");
}
