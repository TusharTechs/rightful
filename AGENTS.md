# AGENTS.md

Guide for AI coding agents working on Rightful.

## What this is

Settlement and refund **claims** that claim farms cannot drain. One verified PayPal account gets one
claim per program. An agent may file for a person; the claim waits until that person signs in with
PayPal and confirms it. Suspected rings are held for a person to decide. Before any money moves, the
payout ledger is committed under a Merkle root that names a future drand round; payouts then go by
PayPal Payouts to the exact account that signed in, and the round's randomness picks the audit sample.

## Map

| Path | Role |
| --- | --- |
| `src/paypal/client.ts` | Sandbox-only REST client: token cache, `PayPal-Request-Id` on every money call, retries that reuse it |
| `src/paypal/payouts.ts`, `identity.ts`, `reporting.ts` | Payouts, Log in with PayPal, Transaction Search and webhooks (reconciliation) |
| `src/paypal/money.ts` | Integer minor units ↔ PayPal decimal strings |
| `src/engine/` | Shared primitives: Merkle trees and inclusion proofs (`merkle.ts`), pinned drand quicknet (`drand.ts`), per-program pseudonyms for payer IDs (`human.ts`) |
| `src/db/` | One `Db` interface over Postgres (`DATABASE_URL`) and PGlite (local, tests); `schema.ts` is the ledger |
| `src/claims/service.ts` | Programs, filing (web with a claim pass, or agent then bind), one claim per PayPal account, review that holds rings and unverified accounts, ring memos, decisions |
| `src/claims/pass.ts` | The signed claim pass and the sealed (AES-256-GCM) payer ID |
| `src/claims/ledger.ts` | The public payout ledger: commitment over (claim, human tag, amount) and terms, the drand-picked audit sample, verifiers. Pure, so the web app bundles it |
| `src/claims/distribute.ts`, `payouts-port.ts` | Equal-share distribution by Payouts to `PAYPAL_ID` only (after every ring is decided), item read-back, the clock's tick, public ledger and receipts |
| `src/rings/` | Ring detection: signal normalizers (`signals.ts`), the deterministic detector (`cluster.ts`), a synthetic program with known rings (`synthetic.ts`) and its scorer (`score.ts`) |
| `src/rings/investigate.ts`, `investigators.ts` | The ring investigator: a case file with stand-in labels (no personal data), three typed questions to TypeSafe Jev, a memo whose facts are computed in code, a fixed deny/review/clear rule. Live, record, or replay from `eval/investigator.jsonl` |
| `src/claims/console.ts` | The administrator console's read: rings with memos and decisions, the share if paid now, and (demo only) the scoreboard against the synthetic truth |
| `src/demo/` | The hosted demo: a per-visitor $2M program seeded from the synthetic generator (`seed.ts`, console tokens scoped to one demo program, pruning) and stateless simulated Payouts for demo programs only (`simulated-payouts.ts`) |
| `src/api/` | Hono app (`app.ts`) and server (`main.ts`); claim pages, agent JSON and admin actions (`claims.ts`); Log in with PayPal (`login.ts`); the claimant MCP server at `/mcp` (`mcp.ts`, tools pinned by `MCP_TOOLS`) |
| `src/dev/fake-payouts.ts` | In-memory Payouts for `PAYPAL_MODE=fake` and tests |
| `web/` | Web app (Vite + React): programs, the demo button, the administrator console at `/console/:program` (token in localStorage or a `#token=` link), the payout ledger at `/l/:program` (`?claim=` adds the claimant's receipt), and the in-browser verifier. Never import server code into it (type-only imports are fine) |
| `scripts/open-program.ts`, `pay-program.ts` | Drive a running API: open a program and print its links; review, distribute and follow payouts |
| `scripts/demo.ts` | `npm run demo`: seed the demo program offline and print its scoreboard; `-- --record` records new investigator answers to `eval/demo-investigator.jsonl` |
| `scripts/eval-rings.ts`, `eval-investigator.ts` | Offline evals: the detector against a VERIFIED-only baseline; the investigator's triage (replay by default) |
| `scripts/probe.ts` | Day-0 sandbox probes (`npm run probe -- all`) |
| `scripts/clock.ts`, `scripts/migrate.ts` | Render cron job (one tick) and pre-deploy migration |
| `test/` | `node:test` suites (`npm test`) |
| `docs/architecture.md` | Render service layout and the money path; update it when a service lands |

## Rules

- **Sandbox only.** `PayPalClient.fromEnv` refuses anything else. Do not add a live switch.
- **Money is integers.** Amounts are minor units (`number` of cents) until `toMoney` at the PayPal edge.
  Models never compute, round or choose amounts or payees.
- **Pay only the account that signed in.** Payouts use `recipient_type: PAYPAL_ID` with the sealed payer
  ID from the claim. Never add an email or phone fallback.
- **Every money-moving call gets an idempotency key** derived from our own IDs (program, claim), never
  from the clock or a random value generated at retry time.
- **Commit before paying.** The ledger is committed in the same transaction that fixes the share, before
  any batch is sent. Nothing may change a committed payout. Every batch carries `ledgerAnchor(digest)` in
  its `email_message` and every item's `note`; sync reads both back and records whether they match.
- **Agents never bind, decide or pay.** The MCP server and agent JSON can only file, read status and
  receipts. Do not add a tool or endpoint that confirms a claim or moves money for an agent.
- **AI never decides who is paid.** The investigator answers typed questions and the code turns them into
  a recommendation; denying or clearing a ring needs a person's decision.
- **Read back from PayPal.** Treat our own state as a cache; confirm payouts with GETs. Webhooks can lag
  by hours in the sandbox, so poll for anything a person is waiting on.
- **No secrets or personal data in the repo, logs or fixtures.** Keys live in `.env` (gitignored).
  Payer IDs never leave the server unsealed; organizers and the public see `humanTag` pseudonyms.
- **Words matter.** Never describe anything here as a game of chance, a prize draw or a sweepstake-style scheme in code, UI or docs (PayPal's
  Acceptable Use Policy).
- **Demo programs never reach PayPal.** `kind = 'demo'` programs pay through `simulatedPayouts` only, are
  unlisted, and their console token opens nothing else. Never let a demo token act on a live program.
- Before committing, run `npm run typecheck` and `npm test`.
