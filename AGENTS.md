# AGENTS.md

Guide for AI coding agents working on Firsthand.

## What this is

Fair, bot-proof **ballots** for scarce things (tickets, limited drops, popular classes). One verified
PayPal human gets one entry. Each entry is a PayPal authorization hold: selected fans are captured,
everyone else is voided and never charged. The order is drawn from a drand quicknet round fixed in
advance, so anyone can recompute it.

## Map

| Path | Role |
| --- | --- |
| `src/paypal/client.ts` | Sandbox-only REST client: token cache, `PayPal-Request-Id` on every money call, retries that reuse it |
| `src/paypal/orders.ts` | Ballot holds: AUTHORIZE orders, capture, void, reauthorize, refund |
| `src/paypal/vault.ts`, `payouts.ts`, `reporting.ts`, `identity.ts` | Agent delegations, resale proceeds, reconciliation, Log in with PayPal |
| `src/paypal/money.ts` | Integer minor units ↔ PayPal decimal strings |
| `src/ballot/commit.ts` | Entry leaves, Merkle root, commitment, inclusion proofs |
| `src/ballot/draw.ts` | The draw and its verifier (pure functions) |
| `src/ballot/drand.ts` | Pinned quicknet chain info, verified beacon fetch, round ↔ time |
| `src/ballot/human.ts` | Per-ballot pseudonyms for payer IDs |
| `src/db/` | One `Db` interface over Postgres (`DATABASE_URL`) and PGlite (local, tests); `schema.ts` is the ledger |
| `src/ballots/service.ts` | The lifecycle: create, enter (authorize + verify + one per human), seal, draw, settle, proofs |
| `src/ballots/paypal-port.ts` | The PayPal slice the service uses; `test/fake-paypal.ts` implements it with idempotent replays |
| `src/api/` | Hono app (`app.ts`) and server (`main.ts`): REST, PayPal return/cancel, Log in with PayPal (`login.ts`), admin actions |
| `src/ballots/clock.ts` | `tick` (cron job) and `advance` (when a ballot is being watched): seal, draw, settle on time |
| `src/dev/` | `PAYPAL_MODE=fake` only: the in-memory PayPal and its stand-in approval page. Refused in production |
| `web/` | Fan app (Vite + React): ballot page, enter with PayPal, live draw, receipts. Imports `src/ballot/*` to verify proofs and the draw in the browser; never import server code into it |
| `src/claims/` | Rightful claims: programs, filing (web with a claim pass, or agent then bind), one claim per PayPal account, review that holds rings and unverified accounts (`service.ts`); the signed pass and sealed payer ID (`pass.ts`) |
| `src/api/claims.ts` | Claim pages after Log in with PayPal, JSON for the web app and agents, organizer review actions |
| `src/rings/` | Claims ring detection: signal normalizers (`signals.ts`), the deterministic detector (`cluster.ts`), a synthetic program with known rings (`synthetic.ts`) and its scorer (`score.ts`) |
| `scripts/open-program.ts` | Opens a claims program on a running API and prints the claim and bind links (`npm run open:program`) |
| `scripts/eval-rings.ts` | Offline eval of the detector against a VERIFIED-only baseline (`npm run eval:rings`) |
| `scripts/probe.ts` | Day-0 sandbox probes (`npm run probe -- all`) |
| `scripts/demo-ballot.ts` | A real ballot on the sandbox, end to end (`npm run demo:ballot`) |
| `scripts/clock.ts`, `scripts/migrate.ts` | Render cron job (one tick) and pre-deploy migration |
| `test/` | `node:test` suites (`npm test`) |
| `docs/architecture.md` | Target Render service layout and the money flow; update it when a service lands |

## Rules

- **Words matter.** It is a *ballot* or *fair queue*. Never write "lottery", "raffle" or "sweepstakes" in
  code, UI or docs: PayPal's Acceptable Use Policy restricts those. No entry fee, ever.
- **Sandbox only.** `PayPalClient.fromEnv` refuses anything else. Do not add a live switch.
- **Money is integers.** Amounts are minor units (`number` of cents) until `toMoney` at the PayPal edge.
  Models never compute, round or choose amounts or payees.
- **Every money-moving call gets an idempotency key** derived from our own IDs (entry, listing), never
  from the clock or a random value generated at retry time.
- **AI never decides who is selected.** The draw is `draw()` over the commitment and a verified beacon.
  AI may screen, investigate and explain; bans need a human click.
- **Read back from PayPal.** Treat our own state as a cache; confirm holds, captures and voids with GETs.
  Webhooks can lag by hours in the sandbox, so poll for anything a user is waiting on.
- **No secrets or personal data in the repo, logs or fixtures.** Keys live in `.env` (gitignored).
  Payer IDs never leave the server; organizers and the public see `humanTag` pseudonyms.
- Before committing, run `npm run typecheck` and `npm test`.
