# Rightful

**Agents can file. Only verified humans get paid.**

Settlement and refund payouts that claim farms cannot drain. Built on PayPal.

> Status: in active development for the PayPal hackathon. Claims, payouts, the public ledger, the
> audit sample, the ring investigator and the administrator console work end to end; the hosted
> demo seeds a $2M program for each visitor.

## The problem

Class-action settlements and mass refunds pay a fixed pool split over valid claims. Bot farms file
thousands of fake claims with farmed accounts, so every real claimant's share shrinks, and
administrators either pay the fraud or freeze everyone while they investigate.

## How Rightful works

- **One claim per verified PayPal account.** Claimants sign in with PayPal. The program sees a
  per-program pseudonym, never the PayPal account ID (it is kept only encrypted, to pay), and a second
  claim from the same account is refused. The email and mailing address on the claim are kept for
  ring detection and shown to the administrator; the public ledger has neither.
- **Agents can file; only people get paid.** An assistant can file a claim over the API. It waits,
  unbound, until the person it is for signs in with PayPal and confirms it.
- **Rings are held, not paid.** Claims that share devices, inboxes, buildings, networks or a scripted
  story are grouped by a deterministic detector. An investigator (TypeSafe Jev, typed answers only)
  rates each group, the memo's facts are computed in code, and a person decides.
- **The ledger comes first.** Before any payout is sent, every payout (claim, pseudonym, amount) is
  hashed into a Merkle root that also names a drand round still in the future. Each claimant gets a
  receipt proving their payout is in it. Once anyone has kept the root or a receipt, adding or
  changing a payout breaks the match: the ledger is tamper-evident, not tamper-proof.
- **PayPal keeps a copy.** Every Payouts batch carries the ledger's digest in its message, and every
  payment carries it in its note, so each claimant's own PayPal payment names the ledger it was paid
  from. The verifier checks that PayPal's records, read back from PayPal, all name this ledger.
- **Paid to the account that signed in.** PayPal Payouts sends each share with
  `recipient_type: PAYPAL_ID` to the payer ID captured at sign-in, and nowhere else.
- **An audit nobody picks.** Once the committed drand round is out, its randomness picks the claims to
  audit. Anyone can recompute the ledger and the sample in their browser.

## Try it

**No sign-in:** on the web app, "Run a $2M program as the administrator" seeds your own copy of a
synthetic settlement: 5,000 claims, about a third filed by rings. You triage 105 held groups with the
investigator's memos, watch the share each real claimant gets move, commit the ledger and pay
(simulated Payouts: no sandbox account holds $2M), then verify the ledger and its drand audit in your
browser. Same program offline:

```bash
npm run demo                # seed the demo program in-process and print its rings and scoreboard
```

On the demo program (a held-out seed the investigator was never tuned on), the investigator
recommends denying 50 groups (1,255 ring claims, no real claimant) and clearing 25 (96 real
claimants, no ring claim), and leaves 30 mixed groups (155 ring claims, 77 real claimants) to a
person:

| How the $2M is paid | Each paid claim | To rings | Real claimants denied |
| --- | --- | --- | --- |
| Pay every claim | $400.00 | $600,000 | 0 |
| Pay every verified PayPal account | $460.08 | $551,176 | 351 (unverified accounts) |
| Rightful, mixed groups all cleared | $588.75 | $136,001 | 0 |
| Rightful, mixed groups all denied | $631.91 | $48,025 | 77 |

A person who opens the mixed groups lands between the last two rows. In every Rightful row, 334 real
claimants with unverified PayPal accounts are held (not denied) until they verify.

**These numbers come from our own synthetic generator** (`src/rings/synthetic.ts`), with known rings
of four kinds and genuine claimants built to look suspicious (households, dorms, people who paste the
sample text). They measure the system against that generator, not against real fraud.

```bash
npm install
npm test                    # ledger, claims, payouts, detector, investigator, PayPal client
npm run eval:rings          # detector vs a VERIFIED-only baseline on synthetic programs (offline)
```

With a PayPal sandbox app ([docs/day0-sandbox-setup.md](docs/day0-sandbox-setup.md)) and the API
deployed or running:

```bash
npm run open:program -- --pool 2   # opens a $2 program, files one claim as an agent, prints links
npm run pay:program -- <programId> # review → ledger → payouts → audit, followed to the end
```

No database to install: without `DATABASE_URL` the API runs Postgres in-process (PGlite).

## License

[MIT](LICENSE)
